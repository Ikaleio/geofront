//! geofront/src/connection.rs
//! Core connection handling logic.

use crate::{
    protocol::{self, write_disconnect},
    state::{
        ACTIVE_CONN, CONN_MANAGER, CONN_METRICS, FFI_MOTD_LOCK, FFI_ROUTER_LOCK, MOTD_CALLBACK,
        OPTIONS, PENDING_MOTDS, PENDING_ROUTES, RATE_LIMITERS, ROUTER_CALLBACK, TOTAL_BYTES_RECV,
        TOTAL_BYTES_SENT,
    },
    types::{
        AsyncStream, HandshakeData, MotdDecision, ProxyConnection, ProxyProtocolIn, RouteDecision,
    },
};
use ppp::PartialResult;
use std::{ffi::CString, net::SocketAddr, num::NonZeroU32, sync::atomic::Ordering};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::TcpStream,
    sync::oneshot,
};
use tokio_socks::tcp::Socks5Stream;
use tracing::{error, info, warn};
use url::Url;

/// Main connection workflow
pub async fn handle_conn(conn_id: ProxyConnection, mut inbound: TcpStream) {
    let options = (*OPTIONS.read().unwrap()).clone();
    let mut peer_addr_override: Option<SocketAddr> = None;

    // Handle Proxy Protocol
    if options.proxy_protocol_in != ProxyProtocolIn::None {
        let mut buf = [0; 536]; // Max size for PROXY protocol v1/v2 header
        let n = match inbound.peek(&mut buf).await {
            Ok(n) => n,
            Err(e) => {
                error!(conn = conn_id, "Failed to peek for PROXY protocol: {}", e);
                cleanup_conn(conn_id);
                return;
            }
        };

        let header_result = ppp::HeaderResult::parse(&buf[..n]);

        if header_result.is_incomplete() {
            // Incomplete header. In normal mode, we proceed. In strict mode, we disconnect.
            if options.proxy_protocol_in == ProxyProtocolIn::Strict {
                warn!(
                    conn = conn_id,
                    "Incomplete PROXY protocol header in strict mode, disconnecting."
                );
                cleanup_conn(conn_id);
                return;
            }
        } else if header_result.is_complete() {
            // Try to extract header information based on the result variant
            match header_result {
                ppp::HeaderResult::V1(Ok(header)) => {
                    // For v1 headers, we need to calculate the header length from the input
                    let header_str = header.header.as_ref();
                    let header_len = header_str.len();

                    // Actually consume the header from the stream
                    let mut discard_buf = vec![0; header_len];
                    if inbound.read_exact(&mut discard_buf).await.is_err() {
                        error!(
                            conn = conn_id,
                            "Failed to read PROXY protocol header after peek"
                        );
                        cleanup_conn(conn_id);
                        return;
                    }

                    // Extract source address from v1 header
                    if let ppp::v1::Addresses::Tcp4(tcp4) = &header.addresses {
                        let source_addr = std::net::SocketAddr::V4(std::net::SocketAddrV4::new(
                            tcp4.source_address,
                            tcp4.source_port,
                        ));
                        peer_addr_override = Some(source_addr);
                        info!(conn = conn_id, real_ip = %source_addr.ip(), "Received PROXY protocol v1 header");
                    } else if let ppp::v1::Addresses::Tcp6(tcp6) = &header.addresses {
                        let source_addr = std::net::SocketAddr::V6(std::net::SocketAddrV6::new(
                            tcp6.source_address,
                            tcp6.source_port,
                            0,
                            0,
                        ));
                        peer_addr_override = Some(source_addr);
                        info!(conn = conn_id, real_ip = %source_addr.ip(), "Received PROXY protocol v1 header");
                    }
                }
                ppp::HeaderResult::V2(Ok(header)) => {
                    let header_len = header.len();

                    // Actually consume the header from the stream
                    let mut discard_buf = vec![0; header_len];
                    if inbound.read_exact(&mut discard_buf).await.is_err() {
                        error!(
                            conn = conn_id,
                            "Failed to read PROXY protocol header after peek"
                        );
                        cleanup_conn(conn_id);
                        return;
                    }

                    // Extract source address from v2 header
                    match &header.addresses {
                        ppp::v2::Addresses::IPv4(ipv4) => {
                            let source_addr = std::net::SocketAddr::V4(
                                std::net::SocketAddrV4::new(ipv4.source_address, ipv4.source_port),
                            );
                            peer_addr_override = Some(source_addr);
                            info!(conn = conn_id, real_ip = %source_addr.ip(), "Received PROXY protocol v2 header");
                        }
                        ppp::v2::Addresses::IPv6(ipv6) => {
                            let source_addr =
                                std::net::SocketAddr::V6(std::net::SocketAddrV6::new(
                                    ipv6.source_address,
                                    ipv6.source_port,
                                    0,
                                    0,
                                ));
                            peer_addr_override = Some(source_addr);
                            info!(conn = conn_id, real_ip = %source_addr.ip(), "Received PROXY protocol v2 header");
                        }
                        _ => {
                            // Unix or other address types - no IP to extract
                            info!(conn = conn_id, "Received PROXY protocol v2 header (non-IP)");
                        }
                    }
                }
                _ => {
                    // Parse error. In normal mode, we proceed. In strict mode, we disconnect.
                    if options.proxy_protocol_in == ProxyProtocolIn::Strict {
                        warn!(
                            conn = conn_id,
                            "Missing or invalid PROXY protocol header in strict mode, disconnecting."
                        );
                        cleanup_conn(conn_id);
                        return;
                    }
                }
            }
        } else {
            // Error case. In normal mode, we proceed. In strict mode, we disconnect.
            if options.proxy_protocol_in == ProxyProtocolIn::Strict {
                warn!(
                    conn = conn_id,
                    "Missing or invalid PROXY protocol header in strict mode, disconnecting."
                );
                cleanup_conn(conn_id);
                return;
            }
        }
    }

    // Parse handshake & determine next action based on state
    let hs = match protocol::parse_handshake(&mut inbound).await {
        Ok(h) => h,
        Err(e) => {
            error!(conn = conn_id, "Handshake failed: {}", e);
            cleanup_conn(conn_id);
            return;
        }
    };

    // Check if this is a status request (MOTD) or login request
    if hs.next_state == 1 {
        // Status request - handle MOTD
        handle_status_request(conn_id, &mut inbound, &hs, peer_addr_override).await;
        cleanup_conn(conn_id);
        return;
    } else if hs.next_state != 2 {
        // Unknown state
        error!(conn = conn_id, "Unknown next_state: {}", hs.next_state);
        cleanup_conn(conn_id);
        return;
    }

    // Continue with login flow (state 2)
    let username = match protocol::parse_login_start(&mut inbound).await {
        Ok(u) => u,
        Err(e) => {
            error!(conn = conn_id, "Login failed: {}", e);
            cleanup_conn(conn_id);
            return;
        }
    };

    // Route
    let peer_ip = peer_addr_override
        .map(|addr| addr.ip().to_string())
        .unwrap_or_else(|| {
            inbound
                .peer_addr()
                .map_or_else(|_| "0.0.0.0".to_string(), |addr| addr.ip().to_string())
        });

    // Asynchronously get the routing decision.
    let route_decision = match get_route_info(conn_id, &hs, &username, &peer_ip).await {
        Ok(decision) => decision,
        Err(_) => {
            // Error already logged, just clean up.
            let _ = write_disconnect(&mut inbound, "Internal routing error.").await;
            cleanup_conn(conn_id);
            return;
        }
    };

    // Custom reject
    if let Some(disconnect_msg) = route_decision.disconnect {
        let _ = write_disconnect(&mut inbound, &disconnect_msg).await;
        cleanup_conn(conn_id);
        return;
    }

    // Rewrite host if specified
    let mut hs_for_rewrite = hs.clone(); // Clone for potential modification
    if let Some(new_host) = route_decision.rewrite_host {
        info!(conn = conn_id, old_host = %hs.host, new_host = %new_host, "Rewriting host");
        hs_for_rewrite.host = new_host;
    }

    // Re-serialize the packets to be forwarded, using the potentially modified handshake.
    let handshake_packet = create_handshake_packet(&hs_for_rewrite);
    let login_packet = create_login_start_packet(&username);

    // Establish outbound connection
    let backend = format!(
        "{}:{}",
        route_decision.remote_host.as_deref().unwrap_or(""),
        route_decision.remote_port.unwrap_or(0)
    );
    let proxy_url = route_decision.proxy.as_deref().unwrap_or("");

    let mut outbound: Box<AsyncStream> = match if !proxy_url.is_empty() {
        let url = Url::parse(proxy_url).expect("Invalid proxy URL");
        match url.scheme() {
            "socks5" => {
                let host = url.host_str().unwrap_or_default();
                let port = url.port().unwrap_or(1080);
                let proxy_backend = format!("{}:{}", host, port);
                let username = url.username();
                let password = url.password().unwrap_or_default();

                if !username.is_empty() {
                    Socks5Stream::connect_with_password(
                        &*proxy_backend,
                        &*backend,
                        username,
                        password,
                    )
                    .await
                    .map(|s| Box::new(s) as Box<AsyncStream>)
                    .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))
                } else {
                    Socks5Stream::connect(&*proxy_backend, &*backend)
                        .await
                        .map(|s| Box::new(s) as Box<AsyncStream>)
                        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))
                }
            }
            _ => TcpStream::connect(&backend)
                .await
                .map(|s| Box::new(s) as Box<AsyncStream>),
        }
    } else {
        TcpStream::connect(&backend)
            .await
            .map(|s| Box::new(s) as Box<AsyncStream>)
    } {
        Ok(stream) => {
            info!(conn=conn_id, %backend, %proxy_url, "Proxying connection");
            stream
        }
        Err(e) => {
            error!(conn=conn_id, %backend, "Failed to connect to backend: {}", e);
            let _ = write_disconnect(&mut inbound, "Could not connect to the destination server.")
                .await;
            cleanup_conn(conn_id);
            return;
        }
    };

    // If PROXY protocol is enabled, send the header first.
    if let Some(version) = route_decision.proxy_protocol {
        let source_addr = peer_addr_override.unwrap_or_else(|| inbound.peer_addr().unwrap());
        let destination_addr = inbound.local_addr().unwrap();

        let proxy_header = match version {
            1 => {
                let addrs = ppp::v1::Addresses::from((source_addr, destination_addr));
                format!("{}\r\n", addrs).into_bytes()
            }
            2 => ppp::v2::Builder::with_addresses(
                ppp::v2::Version::Two | ppp::v2::Command::Proxy,
                ppp::v2::Protocol::Stream,
                (source_addr, destination_addr),
            )
            .build()
            .unwrap_or_default(),
            _ => vec![], // Unsupported version
        };

        if !proxy_header.is_empty() {
            if let Err(e) = outbound.write_all(&proxy_header).await {
                error!(
                    conn = conn_id,
                    "Failed to write PROXY protocol header: {}", e
                );
                cleanup_conn(conn_id);
                return;
            }
        }
    }

    // Forward the initial packets that were consumed during parsing.
    if let Err(e) = outbound.write_all(&handshake_packet).await {
        error!(
            conn = conn_id,
            "Failed to write handshake to backend: {}", e
        );
        cleanup_conn(conn_id);
        return;
    }
    if let Err(e) = outbound.write_all(&login_packet).await {
        error!(conn = conn_id, "Failed to write login to backend: {}", e);
        cleanup_conn(conn_id);
        return;
    }

    // Data proxying
    if let Err(e) = copy_bidirectional_with_metrics(conn_id, &mut inbound, &mut *outbound).await {
        error!(conn = conn_id, "Connection proxy failed: {}", e);
    }

    cleanup_conn(conn_id);
    info!(conn = conn_id, "Connection closed");
}

/// Cleanup resources for a connection
fn cleanup_conn(conn_id: ProxyConnection) {
    CONN_MANAGER.lock().unwrap().remove(&conn_id);
    RATE_LIMITERS.lock().unwrap().remove(&conn_id);
    CONN_METRICS.lock().unwrap().remove(&conn_id);
    ACTIVE_CONN.fetch_sub(1, Ordering::SeqCst);
}

/// A custom `copy_bidirectional` that updates metrics.
async fn copy_bidirectional_with_metrics<'a, A, B>(
    conn_id: ProxyConnection,
    a: &'a mut A,
    b: &'a mut B,
) -> Result<(u64, u64), std::io::Error>
where
    A: AsyncRead + AsyncWrite + Unpin + ?Sized,
    B: AsyncRead + AsyncWrite + Unpin + ?Sized,
{
    let conn_metrics = CONN_METRICS
        .lock()
        .unwrap()
        .get(&conn_id)
        .cloned()
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "Metrics not found for connection",
            )
        })?;

    let (send_limiter, recv_limiter) = RATE_LIMITERS
        .lock()
        .unwrap()
        .get(&conn_id)
        .cloned()
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "Rate limiters not found for connection",
            )
        })?;

    let mut a_to_b_copied = 0;
    let mut b_to_a_copied = 0;
    let mut a_buf = [0u8; 4096];
    let mut b_buf = [0u8; 4096];
    let mut a_closed = false;
    let mut b_closed = false;

    loop {
        tokio::select! {
            biased;

            result = a.read(&mut a_buf), if !a_closed => {
                let n = result?;
                if n == 0 {
                    a_closed = true;
                    if !b_closed {
                        b.shutdown().await?;
                    }
                } else {
                    let mut remaining = n;
                    let mut offset = 0;
                    while remaining > 0 {
                        let chunk_size = std::cmp::min(remaining, 1024);
                        if let Some(num) = NonZeroU32::new(chunk_size as u32) {
                            send_limiter.until_n_ready(num).await.unwrap();
                        }
                        b.write_all(&a_buf[offset..offset + chunk_size]).await?;
                        a_to_b_copied += chunk_size as u64;
                        conn_metrics.bytes_sent.fetch_add(chunk_size as u64, Ordering::SeqCst);
                        TOTAL_BYTES_SENT.fetch_add(chunk_size as u64, Ordering::SeqCst);
                        offset += chunk_size;
                        remaining -= chunk_size;
                    }
                }
            },
            result = b.read(&mut b_buf), if !b_closed => {
                let n = result?;
                if n == 0 {
                    b_closed = true;
                    if !a_closed {
                        a.shutdown().await?;
                    }
                } else {
                    let mut remaining = n;
                    let mut offset = 0;
                    while remaining > 0 {
                        let chunk_size = std::cmp::min(remaining, 1024);
                        if let Some(num) = NonZeroU32::new(chunk_size as u32) {
                            recv_limiter.until_n_ready(num).await.unwrap();
                        }
                        a.write_all(&b_buf[offset..offset + chunk_size]).await?;
                        b_to_a_copied += chunk_size as u64;
                        conn_metrics.bytes_recv.fetch_add(chunk_size as u64, Ordering::SeqCst);
                        TOTAL_BYTES_RECV.fetch_add(chunk_size as u64, Ordering::SeqCst);
                        offset += chunk_size;
                        remaining -= chunk_size;
                    }
                }
            },
            else => {
                break;
            }
        }
    }

    Ok((a_to_b_copied, b_to_a_copied))
}

/// Asynchronously requests route information via FFI and waits for the decision.
async fn get_route_info(
    conn_id: ProxyConnection,
    hs: &HandshakeData,
    username: &str,
    peer_ip: &str,
) -> Result<RouteDecision, ()> {
    // Acquire the lock to ensure only one FFI routing operation happens at a time.
    let _guard = FFI_ROUTER_LOCK.lock().await;

    let (tx, rx) = oneshot::channel();

    // Store the sender so the FFI callback can use it
    PENDING_ROUTES.lock().unwrap().insert(conn_id, tx);

    // This part is now synchronous: it just calls the FFI function and returns.
    // The actual result will arrive on the `rx` channel.
    request_route_info(conn_id, hs, username, peer_ip);

    // Asynchronously wait for the decision to be submitted.
    // Add a timeout to prevent waiting forever.
    match tokio::time::timeout(std::time::Duration::from_secs(10), rx).await {
        Ok(Ok(decision)) => Ok(decision),
        Ok(Err(_)) => {
            error!(
                conn = conn_id,
                "Route decision channel closed unexpectedly."
            );
            Err(())
        }
        Err(_) => {
            error!(conn = conn_id, "Timed out waiting for route decision.");
            // Clean up the pending route entry
            PENDING_ROUTES.lock().unwrap().remove(&conn_id);
            Err(())
        }
    }
}

/// Fires off the FFI call to JS to request a routing decision.
/// This function is synchronous and does not wait for a response.
fn request_route_info(conn_id: ProxyConnection, hs: &HandshakeData, username: &str, peer_ip: &str) {
    let cb = match *ROUTER_CALLBACK.lock().unwrap() {
        Some(cb) => cb,
        None => {
            error!("Router callback is not registered, disconnecting.");
            // If no callback, we can immediately send a disconnect decision.
            if let Some(sender) = PENDING_ROUTES.lock().unwrap().remove(&conn_id) {
                let _ = sender.send(RouteDecision {
                    disconnect: Some("No router configured".to_string()),
                    ..Default::default()
                });
            }
            return;
        }
    };

    // These CStrings are now owned by this function and will be freed
    // by JS using `proxy_free_string`.
    let peer_ip_ptr = CString::new(peer_ip).unwrap().into_raw();
    let host_ptr = CString::new(hs.host.clone()).unwrap().into_raw();
    let username_ptr = CString::new(username).unwrap().into_raw();

    cb(
        conn_id,
        peer_ip_ptr,
        hs.port,
        hs.protocol_version as u32,
        host_ptr,
        username_ptr,
    );
}

/// --- Packet Serialization Helpers ---

fn write_varint(mut value: i32) -> Vec<u8> {
    let mut buf = Vec::new();
    loop {
        let mut temp = (value & 0x7f) as u8;
        value >>= 7;
        if value != 0 {
            temp |= 0x80;
        }
        buf.push(temp);
        if value == 0 {
            break;
        }
    }
    buf
}

fn write_string(s: &str) -> Vec<u8> {
    let str_bytes = s.as_bytes();
    let mut len_buf = write_varint(str_bytes.len() as i32);
    len_buf.extend_from_slice(str_bytes);
    len_buf
}

fn create_handshake_packet(hs: &HandshakeData) -> Vec<u8> {
    let mut data = Vec::new();
    data.extend(write_varint(0x00)); // packet id
    data.extend(write_varint(hs.protocol_version));
    data.extend(write_string(&hs.host));
    data.extend(&hs.port.to_be_bytes());
    data.extend(write_varint(hs.next_state));

    let mut packet = write_varint(data.len() as i32);
    packet.extend(data);
    packet
}

fn create_login_start_packet(username: &str) -> Vec<u8> {
    let mut data = Vec::new();
    data.extend(write_varint(0x00)); // packet id
    data.extend(write_string(username));

    let mut packet = write_varint(data.len() as i32);
    packet.extend(data);
    packet
}

/// Handle status request (MOTD)
async fn handle_status_request(
    conn_id: ProxyConnection,
    inbound: &mut TcpStream,
    hs: &HandshakeData,
    peer_addr_override: Option<SocketAddr>,
) {
    // First, read the status request packet (should be packet ID 0x00 with no data)
    match protocol::read_varint(inbound).await {
        Ok(_packet_len) => {
            match protocol::read_varint(inbound).await {
                Ok(packet_id) if packet_id == 0 => {
                    // Valid status request, proceed with MOTD handling
                }
                Ok(id) => {
                    error!(conn = conn_id, "Invalid status request packet ID: {}", id);
                    return;
                }
                Err(e) => {
                    error!(
                        conn = conn_id,
                        "Failed to read status request packet ID: {}", e
                    );
                    return;
                }
            }
        }
        Err(e) => {
            error!(
                conn = conn_id,
                "Failed to read status request packet length: {}", e
            );
            return;
        }
    }

    let peer_ip = peer_addr_override
        .map(|addr| addr.ip().to_string())
        .unwrap_or_else(|| {
            inbound
                .peer_addr()
                .map_or_else(|_| "0.0.0.0".to_string(), |addr| addr.ip().to_string())
        });

    // Get MOTD decision from callback
    let motd_decision = match get_motd_info(conn_id, hs, &peer_ip).await {
        Ok(decision) => decision,
        Err(_) => {
            // Error already logged, send default MOTD or disconnect
            error!(conn = conn_id, "Failed to get MOTD decision, using default");
            MotdDecision {
                version: Some(crate::types::MotdVersion {
                    name: "Geofront".to_string(),
                    protocol: hs.protocol_version,
                }),
                players: Some(crate::types::MotdPlayers {
                    max: 20,
                    online: 0,
                    sample: vec![],
                }),
                description: Some(serde_json::json!({
                    "text": "Geofront Proxy - Connection Error"
                })),
                favicon: None,
                disconnect: None,
            }
        }
    };

    // Check if we should disconnect
    if let Some(disconnect_msg) = motd_decision.disconnect {
        let _ = write_disconnect(inbound, &disconnect_msg).await;
        return;
    }

    // Build and send status response
    if let Err(e) = send_status_response(inbound, &motd_decision, hs.protocol_version).await {
        error!(conn = conn_id, "Failed to send status response: {}", e);
        return;
    }

    // Handle ping request (if client sends one)
    if let Ok(_packet_len) = protocol::read_varint(inbound).await {
        if let Ok(packet_id) = protocol::read_varint(inbound).await {
            if packet_id == 1 {
                // Ping packet - read the payload and echo it back
                if let Ok(payload) = inbound.read_u64().await {
                    let response = create_ping_response(payload);
                    let _ = inbound.write_all(&response).await;
                }
            }
        }
    }
}

/// Send status response packet with MOTD data
async fn send_status_response(
    stream: &mut TcpStream,
    motd_decision: &MotdDecision,
    protocol_version: i32,
) -> std::io::Result<()> {
    // Build JSON response
    let mut response_json = serde_json::json!({
        "version": {
            "name": motd_decision.version.as_ref()
                .map(|v| v.name.clone())
                .unwrap_or_else(|| "Geofront".to_string()),
            "protocol": motd_decision.version.as_ref()
                .map(|v| v.protocol)
                .unwrap_or(protocol_version)
        },
        "players": {
            "max": motd_decision.players.as_ref()
                .map(|p| p.max)
                .unwrap_or(20),
            "online": motd_decision.players.as_ref()
                .map(|p| p.online)
                .unwrap_or(0),
            "sample": motd_decision.players.as_ref()
                .map(|p| &p.sample)
                .unwrap_or(&vec![])
        },
        "description": motd_decision.description.clone()
            .unwrap_or_else(|| serde_json::json!({
                "text": "Geofront Proxy"
            }))
    });

    // Add favicon if present
    if let Some(ref favicon) = motd_decision.favicon {
        response_json["favicon"] = serde_json::json!(favicon);
    }

    // Serialize to JSON string
    let json_str = serde_json::to_string(&response_json).unwrap_or_else(|_| {
        r#"{"version":{"name":"Geofront","protocol":47},"players":{"max":20,"online":0,"sample":[]},"description":{"text":"Geofront Proxy - JSON Error"}}"#.to_string()
    });

    // Build status response packet
    let mut payload = Vec::new();
    payload.extend(write_varint(0x00)); // Status Response packet ID
    payload.extend(write_string(&json_str));

    let mut packet = write_varint(payload.len() as i32);
    packet.extend(payload);

    stream.write_all(&packet).await
}

/// Create ping response packet
fn create_ping_response(payload: u64) -> Vec<u8> {
    let mut data = Vec::new();
    data.extend(write_varint(0x01)); // Pong packet ID
    data.extend(&payload.to_be_bytes());

    let mut packet = write_varint(data.len() as i32);
    packet.extend(data);
    packet
}

/// Asynchronously requests MOTD information via FFI and waits for the decision.
async fn get_motd_info(
    conn_id: ProxyConnection,
    hs: &HandshakeData,
    peer_ip: &str,
) -> Result<MotdDecision, ()> {
    // Acquire the lock to ensure only one FFI MOTD operation happens at a time.
    let _guard = FFI_MOTD_LOCK.lock().await;

    let (tx, rx) = oneshot::channel();

    // Store the sender so the FFI callback can use it
    PENDING_MOTDS.lock().unwrap().insert(conn_id, tx);

    // This part is now synchronous: it just calls the FFI function and returns.
    // The actual result will arrive on the `rx` channel.
    request_motd_info(conn_id, hs, peer_ip);

    // Asynchronously wait for the decision to be submitted.
    // Add a timeout to prevent waiting forever.
    match tokio::time::timeout(std::time::Duration::from_secs(10), rx).await {
        Ok(Ok(decision)) => Ok(decision),
        Ok(Err(_)) => {
            error!(conn = conn_id, "MOTD decision channel closed unexpectedly.");
            Err(())
        }
        Err(_) => {
            error!(conn = conn_id, "Timed out waiting for MOTD decision.");
            // Clean up the pending MOTD entry
            PENDING_MOTDS.lock().unwrap().remove(&conn_id);
            Err(())
        }
    }
}

/// Fires off the FFI call to JS to request an MOTD decision.
/// This function is synchronous and does not wait for a response.
fn request_motd_info(conn_id: ProxyConnection, hs: &HandshakeData, peer_ip: &str) {
    let cb = match *MOTD_CALLBACK.lock().unwrap() {
        Some(cb) => cb,
        None => {
            error!("MOTD callback is not registered, using default MOTD.");
            // If no callback, we can immediately send a default MOTD decision.
            if let Some(sender) = PENDING_MOTDS.lock().unwrap().remove(&conn_id) {
                let _ = sender.send(MotdDecision {
                    version: Some(crate::types::MotdVersion {
                        name: "Geofront".to_string(),
                        protocol: hs.protocol_version,
                    }),
                    players: Some(crate::types::MotdPlayers {
                        max: 20,
                        online: 0,
                        sample: vec![],
                    }),
                    description: Some(serde_json::json!({
                        "text": "Geofront Proxy - No MOTD callback configured"
                    })),
                    favicon: None,
                    disconnect: None,
                });
            }
            return;
        }
    };

    // These CStrings are now owned by this function and will be freed
    // by JS using `proxy_free_string`.
    let peer_ip_ptr = CString::new(peer_ip).unwrap().into_raw();
    let host_ptr = CString::new(hs.host.clone()).unwrap().into_raw();
    let username_ptr = CString::new("").unwrap().into_raw(); // Empty username for status requests

    cb(
        conn_id,
        peer_ip_ptr,
        hs.port,
        hs.protocol_version as u32,
        host_ptr,
        username_ptr,
    );
}
