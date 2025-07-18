//! geofront/src/lib.rs
//! Minimal Minecraft proxy backend core with logging, routing, zero-copy forwarding, rate limiting, upstream proxy support, and metrics

use lazy_static::lazy_static;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    ffi::{CStr, CString},
    num::NonZeroU32,
    os::raw::{c_char, c_uint, c_ushort},
    ptr,
    sync::{
        Arc, Once,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    runtime::Runtime,
    sync::Mutex,
    sync::oneshot,
    task::JoinHandle,
};
use tracing::{error, info};
use tracing_subscriber::prelude::*;
use tracing_subscriber::{
    filter::EnvFilter,
    fmt,
    reload::{Handle as ReloadHandle, Layer as ReloadLayer},
};

// Protocol utilities
pub(crate) mod protocol;
use protocol::write_disconnect;
use url::Url;

// Zero-copy utility (Linux)

// Rate limiting (governor)
use governor::{
    Quota, RateLimiter,
    clock::DefaultClock,
    state::{InMemoryState, direct::NotKeyed},
};
use nonzero_ext::*;

// SOCKS5 proxy support
use tokio_socks::tcp::Socks5Stream;

// Error codes
pub type ProxyError = i32;
pub const PROXY_OK: ProxyError = 0;
pub const PROXY_ERR_INTERNAL: ProxyError = -1;
pub const PROXY_ERR_BAD_PARAM: ProxyError = -2;
pub const PROXY_ERR_NOT_FOUND: ProxyError = -3;

// Handles
pub type ProxyListener = u64;
pub type ProxyConnection = u64;

// Define a new trait that combines the required traits for our dynamic stream.
trait AsyncStreamTrait: AsyncRead + AsyncWrite + Unpin + Send {}

// Implement this trait for any type that satisfies the bounds. This is a "blanket implementation".
impl<T: AsyncRead + AsyncWrite + Unpin + Send> AsyncStreamTrait for T {}

// Use the new trait to define our dynamic stream type.
type AsyncStream = dyn AsyncStreamTrait;

// Struct for JS to return routing decision as a JSON string
#[derive(Serialize, Deserialize, Debug, Default)]
struct RouteDecision {
    #[serde(rename = "remoteHost")]
    remote_host: Option<String>,
    #[serde(rename = "remotePort")]
    remote_port: Option<u16>,
    proxy: Option<String>,
    #[serde(rename = "proxyProtocol")]
    proxy_protocol: Option<u8>,
    disconnect: Option<String>,
    #[serde(rename = "rewriteHost")]
    rewrite_host: Option<String>,
}

// Router callback signature. It now takes a buffer to write the result to.
pub type ProxyRouterFn = extern "C" fn(
    ProxyConnection,
    *const c_char, // peer_ip
    c_ushort,      // port
    c_uint,        // protocol
    *const c_char, // host
    *const c_char, // user
);

// Global metrics counters
static TOTAL_CONN: AtomicU64 = AtomicU64::new(0);
static ACTIVE_CONN: AtomicU64 = AtomicU64::new(0);
static TOTAL_BYTES_SENT: AtomicU64 = AtomicU64::new(0);
static TOTAL_BYTES_RECV: AtomicU64 = AtomicU64::new(0);

// Per-connection metrics
#[derive(Serialize)]
pub struct ConnMetrics {
    pub bytes_sent: AtomicU64,
    pub bytes_recv: AtomicU64,
}

// Snapshot structs for JSON serialization
#[derive(Serialize)]
struct MetricsSnapshot {
    total_conn: u64,
    active_conn: u64,
    total_bytes_sent: u64,
    total_bytes_recv: u64,
    connections: HashMap<ProxyConnection, ConnMetricsSnapshot>,
}

#[derive(Serialize)]
struct ConnMetricsSnapshot {
    bytes_sent: u64,
    bytes_recv: u64,
}

lazy_static! {
    static ref CONN_METRICS: std::sync::Mutex<HashMap<ProxyConnection, Arc<ConnMetrics>>> =
        std::sync::Mutex::new(HashMap::new());
    // Map to hold the senders for pending routing decisions
    static ref PENDING_ROUTES: std::sync::Mutex<HashMap<ProxyConnection, oneshot::Sender<RouteDecision>>> =
        std::sync::Mutex::new(HashMap::new());
    static ref LISTENER_STATE: Arc<std::sync::Mutex<ListenerState>> =
        Arc::new(std::sync::Mutex::new(ListenerState::new()));
    static ref CONN_MANAGER: Arc<std::sync::Mutex<ConnectionManager>> =
        Arc::new(std::sync::Mutex::new(ConnectionManager::new()));
    static ref RATE_LIMITERS: std::sync::Mutex<
        HashMap<
            ProxyConnection,
            (
                Arc<RateLimiter<NotKeyed, InMemoryState, DefaultClock>>,
                Arc<RateLimiter<NotKeyed, InMemoryState, DefaultClock>>,
            ),
        >,
    > = std::sync::Mutex::new(HashMap::new());
    static ref LISTENER_COUNTER: AtomicU64 = AtomicU64::new(1);
    static ref CONN_COUNTER: AtomicU64 = AtomicU64::new(1);
    static ref RELOAD_HANDLE: std::sync::Mutex<Option<ReloadHandle<EnvFilter, tracing_subscriber::Registry>>> =
        std::sync::Mutex::new(None);
    static ref ROUTER_CALLBACK: std::sync::Mutex<Option<ProxyRouterFn>> =
        std::sync::Mutex::new(None);
    // This lock serializes all FFI calls to the router to prevent concurrency issues.
    static ref FFI_ROUTER_LOCK: Mutex<()> = Mutex::new(());
}
static LOG_INIT: Once = Once::new();

// Initialize logging once
fn init_logging(default: &str) {
    let filter = EnvFilter::new(default);
    let (reload_layer, handle) = ReloadLayer::new(filter);
    let subscriber = tracing_subscriber::registry()
        .with(reload_layer)
        .with(fmt::layer());
    tracing::subscriber::set_global_default(subscriber).unwrap();
    *RELOAD_HANDLE.lock().unwrap() = Some(handle);
}

/// Initialize global logging level
#[unsafe(no_mangle)]
pub unsafe extern "C" fn proxy_init_logging(level: *const c_char) -> ProxyError {
    if level.is_null() {
        return PROXY_ERR_BAD_PARAM;
    }
    let lvl = unsafe { CStr::from_ptr(level) }
        .to_str()
        .map_err(|_| PROXY_ERR_BAD_PARAM)
        .unwrap();
    LOG_INIT.call_once(|| init_logging(lvl));
    PROXY_OK
}

/// Set log level at runtime
#[unsafe(no_mangle)]
pub unsafe extern "C" fn proxy_set_log_level(level: *const c_char) -> ProxyError {
    if level.is_null() {
        return PROXY_ERR_BAD_PARAM;
    }
    let lvl = unsafe { CStr::from_ptr(level) }
        .to_str()
        .map_err(|_| PROXY_ERR_BAD_PARAM)
        .unwrap();
    if let Some(handle) = RELOAD_HANDLE.lock().unwrap().as_ref() {
        handle
            .reload(EnvFilter::new(lvl))
            .map_err(|_| PROXY_ERR_INTERNAL)
            .unwrap();
        PROXY_OK
    } else {
        PROXY_ERR_INTERNAL
    }
}

/// Register router callback (must set before start)
#[unsafe(no_mangle)]
pub extern "C" fn proxy_register_router(cb: ProxyRouterFn) -> ProxyError {
    LOG_INIT.call_once(|| init_logging("info"));
    let mut router_cb_guard = ROUTER_CALLBACK.lock().unwrap();
    *router_cb_guard = Some(cb);
    info!("Router callback registered");
    PROXY_OK
}

/// Start TCP listener

/// Submits the routing decision from JS back to Rust.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn proxy_submit_routing_decision(
    conn_id: ProxyConnection,
    decision_json: *const c_char,
) -> ProxyError {
    if decision_json.is_null() {
        return PROXY_ERR_BAD_PARAM;
    }
    let json_str = unsafe { CStr::from_ptr(decision_json) }.to_string_lossy();

    let decision: RouteDecision = match serde_json::from_str(&json_str) {
        Ok(d) => d,
        Err(e) => {
            error!(
                conn = conn_id,
                "Failed to parse submitted route decision JSON: {}", e
            );
            RouteDecision {
                disconnect: Some("Invalid JSON from router".to_string()),
                ..Default::default()
            }
        }
    };

    if let Some(sender) = PENDING_ROUTES.lock().unwrap().remove(&conn_id) {
        if sender.send(decision).is_err() {
            error!(
                conn = conn_id,
                "Failed to send routing decision: receiver dropped."
            );
            return PROXY_ERR_INTERNAL;
        }
    } else {
        error!(
            conn = conn_id,
            "No pending route decision found for this connection."
        );
        return PROXY_ERR_NOT_FOUND;
    }

    PROXY_OK
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn proxy_start_listener(
    bind_addr: *const c_char,
    bind_port: c_ushort,
    out_listener: *mut ProxyListener,
) -> ProxyError {
    LOG_INIT.call_once(|| init_logging("info"));
    if bind_addr.is_null() || out_listener.is_null() {
        return PROXY_ERR_BAD_PARAM;
    }
    let addr = unsafe { CStr::from_ptr(bind_addr) }
        .to_str()
        .map_err(|_| PROXY_ERR_BAD_PARAM)
        .unwrap();
    let id = LISTENER_COUNTER.fetch_add(1, Ordering::SeqCst);
    let listen_str = format!("{}:{}", addr, bind_port);
    info!(listener = id, %listen_str, "Starting listener");
    let handle = LISTENER_STATE
        .lock()
        .unwrap()
        .runtime
        .handle()
        .clone()
        .spawn(async move {
            let listener = match TcpListener::bind(&listen_str).await {
                Ok(l) => l,
                Err(e) => {
                    error!("Failed to bind listener {}: {}", id, e);
                    return;
                }
            };
            info!("Bound {}", listen_str);
            loop {
                match listener.accept().await {
                    Ok((inb, _)) => {
                        let conn_id = CONN_COUNTER.fetch_add(1, Ordering::SeqCst);
                        TOTAL_CONN.fetch_add(1, Ordering::SeqCst);
                        ACTIVE_CONN.fetch_add(1, Ordering::SeqCst);
                        let cm = Arc::new(ConnMetrics {
                            bytes_sent: AtomicU64::new(0),
                            bytes_recv: AtomicU64::new(0),
                        });
                        CONN_METRICS.lock().unwrap().insert(conn_id, cm);
                        let unlimited =
                            Arc::new(RateLimiter::direct(Quota::per_second(nonzero!(1u32))));
                        RATE_LIMITERS
                            .lock()
                            .unwrap()
                            .insert(conn_id, (unlimited.clone(), unlimited));
                        let h = tokio::spawn(handle_conn(conn_id, inb));
                        CONN_MANAGER.lock().unwrap().insert(conn_id, h);
                    }
                    Err(e) => {
                        error!("Accept error: {}", e);
                        break;
                    }
                }
            }
        });
    unsafe { ptr::write(out_listener, id) };
    LISTENER_STATE.lock().unwrap().listeners.insert(id, handle);
    PROXY_OK
}

/// Stop a listener
#[unsafe(no_mangle)]
pub extern "C" fn proxy_stop_listener(listener: ProxyListener) -> ProxyError {
    let mut st = LISTENER_STATE.lock().unwrap();
    if let Some(h) = st.listeners.remove(&listener) {
        h.abort();
        PROXY_OK
    } else {
        PROXY_ERR_NOT_FOUND
    }
}

/// Disconnect a connection
#[unsafe(no_mangle)]
pub extern "C" fn proxy_disconnect(conn_id: ProxyConnection) -> ProxyError {
    if let Some(h) = CONN_MANAGER.lock().unwrap().remove(&conn_id) {
        h.abort();
        RATE_LIMITERS.lock().unwrap().remove(&conn_id);
        CONN_METRICS.lock().unwrap().remove(&conn_id);
        ACTIVE_CONN.fetch_sub(1, Ordering::SeqCst);
        PROXY_OK
    } else {
        PROXY_ERR_NOT_FOUND
    }
}

/// Set burst-capable rate limits
#[unsafe(no_mangle)]
pub extern "C" fn proxy_set_rate_limit(
    conn_id: ProxyConnection,
    max_send_bps: u64,
    max_recv_bps: u64,
) -> ProxyError {
    let mut rl = RATE_LIMITERS.lock().unwrap();
    if let Some((send_l, recv_l)) = rl.get_mut(&conn_id) {
        let s = NonZeroU32::new(max_send_bps as u32).unwrap_or(nonzero!(1u32));
        let r = NonZeroU32::new(max_recv_bps as u32).unwrap_or(nonzero!(1u32));
        *send_l = Arc::new(RateLimiter::direct(Quota::per_second(s).allow_burst(s)));
        *recv_l = Arc::new(RateLimiter::direct(Quota::per_second(r).allow_burst(r)));
        info!(
            conn = conn_id,
            send = max_send_bps,
            recv = max_recv_bps,
            "Updated rate limits"
        );
        PROXY_OK
    } else {
        PROXY_ERR_NOT_FOUND
    }
}

/// Shutdown all listeners and connections
#[unsafe(no_mangle)]
pub extern "C" fn proxy_shutdown() -> ProxyError {
    for h in LISTENER_STATE
        .lock()
        .unwrap()
        .listeners
        .drain()
        .map(|(_, h)| h)
    {
        h.abort();
    }
    for (_, h) in CONN_MANAGER.lock().unwrap().connections.drain() {
        h.abort();
    }
    CONN_METRICS.lock().unwrap().clear();
    PROXY_OK
}

/// Disconnect all active connections and returns the number of connections kicked.
#[unsafe(no_mangle)]
pub extern "C" fn proxy_kick_all() -> c_uint {
    let mut conn_manager = CONN_MANAGER.lock().unwrap();
    let mut rate_limiters = RATE_LIMITERS.lock().unwrap();
    let mut conn_metrics = CONN_METRICS.lock().unwrap();

    let kicked_count = conn_manager.connections.len();

    for (conn_id, handle) in conn_manager.connections.drain() {
        handle.abort();
        rate_limiters.remove(&conn_id);
        conn_metrics.remove(&conn_id);
        ACTIVE_CONN.fetch_sub(1, Ordering::SeqCst);
    }

    kicked_count as c_uint
}

/// Takes a snapshot of all metrics and returns it as a JSON string.
/// The caller is responsible for freeing the returned string using `proxy_free_string`.
#[unsafe(no_mangle)]
pub extern "C" fn proxy_get_metrics() -> *const c_char {
    let conn_metrics_guard = CONN_METRICS.lock().unwrap();
    let connections = conn_metrics_guard
        .iter()
        .map(|(id, metrics)| {
            (
                *id,
                ConnMetricsSnapshot {
                    bytes_sent: metrics.bytes_sent.load(Ordering::SeqCst),
                    bytes_recv: metrics.bytes_recv.load(Ordering::SeqCst),
                },
            )
        })
        .collect();

    let snapshot = MetricsSnapshot {
        total_conn: TOTAL_CONN.load(Ordering::SeqCst),
        active_conn: ACTIVE_CONN.load(Ordering::SeqCst),
        total_bytes_sent: TOTAL_BYTES_SENT.load(Ordering::SeqCst),
        total_bytes_recv: TOTAL_BYTES_RECV.load(Ordering::SeqCst),
        connections,
    };

    match serde_json::to_string(&snapshot) {
        Ok(json_str) => match CString::new(json_str) {
            Ok(c_str) => c_str.into_raw(),
            Err(_) => ptr::null(),
        },
        Err(_) => ptr::null(),
    }
}

/// Takes a snapshot of a single connection's metrics and returns it as a JSON string.
/// The caller is responsible for freeing the returned string using `proxy_free_string`.
#[unsafe(no_mangle)]
pub extern "C" fn proxy_get_connection_metrics(conn_id: ProxyConnection) -> *const c_char {
    let conn_metrics_guard = CONN_METRICS.lock().unwrap();
    if let Some(metrics) = conn_metrics_guard.get(&conn_id) {
        let snapshot = ConnMetricsSnapshot {
            bytes_sent: metrics.bytes_sent.load(Ordering::SeqCst),
            bytes_recv: metrics.bytes_recv.load(Ordering::SeqCst),
        };
        match serde_json::to_string(&snapshot) {
            Ok(json_str) => match CString::new(json_str) {
                Ok(c_str) => c_str.into_raw(),
                Err(_) => ptr::null(),
            },
            Err(_) => ptr::null(),
        }
    } else {
        ptr::null()
    }
}

/// Frees a string that was allocated by Rust and passed to another language.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn proxy_free_string(s: *mut c_char) {
    if !s.is_null() {
        unsafe {
            let _ = CString::from_raw(s);
        }
    }
}

struct ListenerState {
    runtime: Runtime,
    listeners: HashMap<ProxyListener, JoinHandle<()>>,
}
impl ListenerState {
    fn new() -> Self {
        ListenerState {
            runtime: tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .unwrap(),
            listeners: HashMap::new(),
        }
    }
}
struct ConnectionManager {
    connections: HashMap<ProxyConnection, JoinHandle<()>>,
}
impl ConnectionManager {
    fn new() -> Self {
        ConnectionManager {
            connections: HashMap::new(),
        }
    }
    fn insert(&mut self, id: ProxyConnection, h: JoinHandle<()>) {
        self.connections.insert(id, h);
    }
    fn remove(&mut self, id: &ProxyConnection) -> Option<JoinHandle<()>> {
        self.connections.remove(id)
    }
}

struct HandshakeData {
    protocol_version: i32,
    host: String,
    port: u16,
    #[allow(dead_code)]
    next_state: i32,
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

/// Main connection workflow
async fn handle_conn(conn_id: ProxyConnection, mut inbound: TcpStream) {
    // Parse handshake & login
    let mut hs = match crate::protocol::parse_handshake(&mut inbound).await {
        Ok(h) => h,
        Err(e) => {
            error!(conn = conn_id, "Handshake failed: {}", e);
            cleanup_conn(conn_id);
            return;
        }
    };
    let username = match crate::protocol::parse_login_start(&mut inbound).await {
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
    let conn_metrics = match CONN_METRICS.lock().unwrap().get(&conn_id) {
        Some(m) => m.clone(),
        None => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "Metrics not found for connection",
            ));
        }
    };

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
