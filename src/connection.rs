//! geofront/src/connection.rs
//! Core connection handling logic.

use crate::{
    protocol::{self, write_disconnect},
    state::{
        ACTIVE_CONN, CONN_MANAGER, CONN_METRICS, FFI_ROUTER_LOCK, PENDING_ROUTES, RATE_LIMITERS,
        ROUTER_CALLBACK, TOTAL_BYTES_RECV, TOTAL_BYTES_SENT,
    },
    types::{AsyncStream, HandshakeData, ProxyConnection, RouteDecision},
};
use std::{ffi::CString, num::NonZeroU32, sync::atomic::Ordering};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::TcpStream,
    sync::oneshot,
};
use tokio_socks::tcp::Socks5Stream;
use tracing::{error, info};
use url::Url;

/// Main connection workflow
pub async fn handle_conn(conn_id: ProxyConnection, mut inbound: TcpStream) {
    // Parse handshake & login
    let mut hs = match protocol::parse_handshake(&mut inbound).await {
        Ok(h) => h,
        Err(e) => {
            error!(conn = conn_id, "Handshake failed: {}", e);
            cleanup_conn(conn_id);
            return;
        }
    };
    let username = match protocol::parse_login_start(&mut inbound).await {
        Ok(u) => u,
        Err(e) => {
            error!(conn = conn_id, "Login failed: {}", e);
            cleanup_conn(conn_id);
            return;
        }
    };

    // Route
    let peer_ip = inbound
        .peer_addr()
        .map_or_else(|_| "0.0.0.0".to_string(), |addr| addr.ip().to_string());

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
    if let Some(new_host) = route_decision.rewrite_host {
        info!(conn = conn_id, old_host = %hs.host, new_host = %new_host, "Rewriting host");
        hs.host = new_host;
    }

    // Re-serialize the packets to be forwarded, using the potentially modified handshake.
    let handshake_packet = create_handshake_packet(&hs);
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
        let inbound_addr = inbound.peer_addr().unwrap();
        let outbound_addr = inbound.local_addr().unwrap(); // Assuming this is the proxy's address
        let proxy_header = match version {
            1 => {
                // PROXY TCP4 192.168.0.1 192.168.0.11 56324 12345\r\n
                format!(
                    "PROXY TCP4 {} {} {} {}\r\n",
                    inbound_addr.ip(),
                    outbound_addr.ip(),
                    inbound_addr.port(),
                    outbound_addr.port()
                )
                .into_bytes()
            }
            2 => {
                // Construct PROXY protocol v2 header
                let mut header = vec![
                    0x0D, 0x0A, 0x0D, 0x0A, 0x00, 0x0D, 0x0A, 0x51, 0x55, 0x49, 0x54, 0x0A,
                ]; // Magic
                header.push(0x21); // v2, PROXY
                match (inbound_addr, outbound_addr) {
                    (std::net::SocketAddr::V4(_), std::net::SocketAddr::V4(_)) => {
                        header.push(0x11); // AF_INET, STREAM
                        header.extend_from_slice(&12u16.to_be_bytes()); // len
                        header.extend_from_slice(&match inbound_addr.ip() {
                            std::net::IpAddr::V4(ip) => ip.octets(),
                            _ => unreachable!(),
                        });
                        header.extend_from_slice(&match outbound_addr.ip() {
                            std::net::IpAddr::V4(ip) => ip.octets(),
                            _ => unreachable!(),
                        });
                        header.extend_from_slice(&inbound_addr.port().to_be_bytes());
                        header.extend_from_slice(&outbound_addr.port().to_be_bytes());
                    }
                    (std::net::SocketAddr::V6(_), std::net::SocketAddr::V6(_)) => {
                        header.push(0x21); // AF_INET6, STREAM
                        header.extend_from_slice(&36u16.to_be_bytes()); // len
                        header.extend_from_slice(&match inbound_addr.ip() {
                            std::net::IpAddr::V6(ip) => ip.octets(),
                            _ => unreachable!(),
                        });
                        header.extend_from_slice(&match outbound_addr.ip() {
                            std::net::IpAddr::V6(ip) => ip.octets(),
                            _ => unreachable!(),
                        });
                        header.extend_from_slice(&inbound_addr.port().to_be_bytes());
                        header.extend_from_slice(&outbound_addr.port().to_be_bytes());
                    }
                    _ => {
                        // Mixed or other address families not supported in this simple case
                        header.push(0x00); // UNSPEC
                        header.extend_from_slice(&0u16.to_be_bytes());
                    }
                }
                header
            }
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
                    if let Some(num) = NonZeroU32::new(n as u32) {
                        send_limiter.until_n_ready(num).await.unwrap();
                    }
                    b.write_all(&a_buf[..n]).await?;
                    a_to_b_copied += n as u64;
                    conn_metrics.bytes_sent.fetch_add(n as u64, Ordering::SeqCst);
                    TOTAL_BYTES_SENT.fetch_add(n as u64, Ordering::SeqCst);
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
                    if let Some(num) = NonZeroU32::new(n as u32) {
                        recv_limiter.until_n_ready(num).await.unwrap();
                    }
                    a.write_all(&b_buf[..n]).await?;
                    b_to_a_copied += n as u64;
                    conn_metrics.bytes_recv.fetch_add(n as u64, Ordering::SeqCst);
                    TOTAL_BYTES_RECV.fetch_add(n as u64, Ordering::SeqCst);
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

    info!(
        conn = conn_id,
        "Requesting route decision from JavaScript..."
    );
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
