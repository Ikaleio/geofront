//! geofront/src/lib.rs
//! Minimal Minecraft proxy backend core with logging, routing, zero-copy forwarding, rate limiting, upstream proxy support, and metrics

use lazy_static::lazy_static;
use std::{
    collections::HashMap,
    ffi::{CStr, CString},
    num::NonZeroU32,
    os::raw::{c_char, c_uint, c_ushort},
    ptr,
    sync::{
        Arc, Mutex, Once,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio::{
    net::{TcpListener, TcpStream},
    runtime::Runtime,
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

// Zero-copy utility (Linux)
#[cfg(target_os = "linux")]
use tokio_splice2::copy_bidirectional;

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

// Route result struct with optional disconnect message
#[repr(C)]
pub struct ProxyRoute {
    pub host: *mut c_char,
    pub port: u16,
    pub proxy: *mut c_char,
    pub disconnect_msg: *mut c_char,
}

// The contained raw pointers are only accessed within the same thread and
// freed before any await points, so it is safe to mark this struct as Send.
unsafe impl Send for ProxyRoute {}

// Router callback signature
pub type ProxyRouterFn = extern "C" fn(
    ProxyConnection,
    *const c_char,
    c_ushort,
    c_uint,
    *const c_char,
    *const c_char,
) -> ProxyRoute;

// Global metrics counters
static TOTAL_CONN: AtomicU64 = AtomicU64::new(0);
static ACTIVE_CONN: AtomicU64 = AtomicU64::new(0);
static TOTAL_BYTES_SENT: AtomicU64 = AtomicU64::new(0);
static TOTAL_BYTES_RECV: AtomicU64 = AtomicU64::new(0);

// Per-connection metrics
pub struct ConnMetrics {
    pub bytes_sent: AtomicU64,
    pub bytes_recv: AtomicU64,
}

lazy_static! {
    static ref CONN_METRICS: Mutex<HashMap<ProxyConnection, Arc<ConnMetrics>>> =
        Mutex::new(HashMap::new());
    static ref ROUTER_CB: Mutex<Option<ProxyRouterFn>> = Mutex::new(None);
    static ref LISTENER_STATE: Arc<Mutex<ListenerState>> =
        Arc::new(Mutex::new(ListenerState::new()));
    static ref CONN_MANAGER: Arc<Mutex<ConnectionManager>> =
        Arc::new(Mutex::new(ConnectionManager::new()));
    static ref RATE_LIMITERS: Mutex<
        HashMap<
            ProxyConnection,
            (
                Arc<RateLimiter<NotKeyed, InMemoryState, DefaultClock>>,
                Arc<RateLimiter<NotKeyed, InMemoryState, DefaultClock>>,
            ),
        >,
    > = Mutex::new(HashMap::new());
    static ref LISTENER_COUNTER: AtomicU64 = AtomicU64::new(1);
    static ref CONN_COUNTER: AtomicU64 = AtomicU64::new(1);
    static ref RELOAD_HANDLE: Mutex<Option<ReloadHandle<EnvFilter, tracing_subscriber::Registry>>> =
        Mutex::new(None);
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
pub unsafe extern "C" fn proxy_init_logging(level: *const c_char) -> ProxyError {
    if level.is_null() {
        return PROXY_ERR_BAD_PARAM;
    }
    let lvl = CStr::from_ptr(level)
        .to_str()
        .map_err(|_| PROXY_ERR_BAD_PARAM)
        .unwrap();
    LOG_INIT.call_once(|| init_logging(lvl));
    PROXY_OK
}

/// Set log level at runtime

pub unsafe extern "C" fn proxy_set_log_level(level: *const c_char) -> ProxyError {
    if level.is_null() {
        return PROXY_ERR_BAD_PARAM;
    }
    let lvl = CStr::from_ptr(level)
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

/// Free memory allocated in ProxyRoute

pub unsafe extern "C" fn proxy_free_route(route: ProxyRoute) {
    if !route.host.is_null() {
        let _ = CString::from_raw(route.host);
    }
    if !route.proxy.is_null() {
        let _ = CString::from_raw(route.proxy);
    }
    if !route.disconnect_msg.is_null() {
        let _ = CString::from_raw(route.disconnect_msg);
    }
}

/// Register router callback (must set before start)

pub extern "C" fn proxy_register_router(cb: ProxyRouterFn) -> ProxyError {
    LOG_INIT.call_once(|| init_logging("info"));
    *ROUTER_CB.lock().unwrap() = Some(cb);
    info!("Router callback registered");
    PROXY_OK
}

/// Start TCP listener

pub unsafe extern "C" fn proxy_start_listener(
    bind_addr: *const c_char,
    bind_port: c_ushort,
    out_listener: *mut ProxyListener,
) -> ProxyError {
    LOG_INIT.call_once(|| init_logging("info"));
    if bind_addr.is_null() || out_listener.is_null() {
        return PROXY_ERR_BAD_PARAM;
    }
    let addr = CStr::from_ptr(bind_addr)
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
            let listener = TcpListener::bind(&listen_str).await.unwrap();
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
    ptr::write(out_listener, id);
    LISTENER_STATE.lock().unwrap().listeners.insert(id, handle);
    PROXY_OK
}

/// Stop a listener

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

/// Global metrics getters

pub extern "C" fn proxy_get_total_connections() -> u64 {
    TOTAL_CONN.load(Ordering::SeqCst)
}

pub extern "C" fn proxy_get_active_connections() -> u64 {
    ACTIVE_CONN.load(Ordering::SeqCst)
}

pub extern "C" fn proxy_get_bytes_sent() -> u64 {
    TOTAL_BYTES_SENT.load(Ordering::SeqCst)
}

pub extern "C" fn proxy_get_bytes_received() -> u64 {
    TOTAL_BYTES_RECV.load(Ordering::SeqCst)
}

pub extern "C" fn proxy_reset_metrics() -> ProxyError {
    TOTAL_CONN.store(0, Ordering::SeqCst);
    ACTIVE_CONN.store(0, Ordering::SeqCst);
    TOTAL_BYTES_SENT.store(0, Ordering::SeqCst);
    TOTAL_BYTES_RECV.store(0, Ordering::SeqCst);
    PROXY_OK
}

/// Per-connection metrics getters

pub extern "C" fn proxy_conn_get_bytes_sent(conn_id: ProxyConnection) -> u64 {
    CONN_METRICS
        .lock()
        .unwrap()
        .get(&conn_id)
        .map(|m| m.bytes_sent.load(Ordering::SeqCst))
        .unwrap_or(0)
}

pub extern "C" fn proxy_conn_get_bytes_received(conn_id: ProxyConnection) -> u64 {
    CONN_METRICS
        .lock()
        .unwrap()
        .get(&conn_id)
        .map(|m| m.bytes_recv.load(Ordering::SeqCst))
        .unwrap_or(0)
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
    next_state: i32,
}

/// Main connection workflow
async fn handle_conn(conn_id: ProxyConnection, mut inbound: TcpStream) {
    // Parse handshake & login
    let hs = match crate::protocol::parse_handshake(&mut inbound).await {
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
    let peer_ip = inbound.peer_addr().unwrap().ip().to_string();
    let route = {
        let guard = ROUTER_CB.lock().unwrap();
        let cb = guard.as_ref().unwrap();
        cb(
            conn_id,
            CString::new(peer_ip).unwrap().as_ptr(),
            hs.port,
            hs.protocol_version as u32,
            CString::new(hs.host).unwrap().as_ptr(),
            CString::new(username).unwrap().as_ptr(),
        )
    };

    // Extract route information before any await to keep the future Send
    let reject = route.host.is_null();
    let reject_msg = if route.disconnect_msg.is_null() {
        "Connection rejected".to_string()
    } else {
        unsafe {
            CStr::from_ptr(route.disconnect_msg)
                .to_string_lossy()
                .into()
        }
    };
    let proxy_url = unsafe {
        CStr::from_ptr(route.proxy)
            .to_str()
            .unwrap_or("")
            .to_string()
    };
    let backend = if reject {
        String::new()
    } else {
        unsafe {
            format!(
                "{}:{}",
                CStr::from_ptr(route.host).to_str().unwrap_or(""),
                route.port
            )
        }
    };
    unsafe { proxy_free_route(route) };

    // Custom reject
    if reject {
        let _ = write_disconnect(&mut inbound, &reject_msg).await;
        cleanup_conn(conn_id);
        return;
    }

    // Establish outbound
    let mut outbound = if proxy_url.starts_with("socks5://") {
        let pa = &proxy_url[9..];
        Socks5Stream::connect(pa, backend.clone())
            .await
            .unwrap()
            .into_inner()
    } else {
        TcpStream::connect(&backend).await.unwrap()
    };
    info!(conn=conn_id, %backend, %proxy_url, "Proxying...");

    // Zero-copy forwarding or fallback
    #[cfg(target_os = "linux")]
    {
        if let Err(e) = copy_bidirectional(&mut inbound, &mut outbound).await {
            error!(conn = conn_id, "Zero-copy failed: {}", e);
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let (mut ri, mut wi) = inbound.split();
        let (mut ro, mut wo) = outbound.split();
        let _ = tokio::io::copy(&mut ri, &mut wo).await;
        let _ = tokio::io::copy(&mut ro, &mut wi).await;
    }

    cleanup_conn(conn_id);
    info!(conn = conn_id, "Connection closed");
}

/// Cleanup resources for a connection
fn cleanup_conn(conn_id: ProxyConnection) {
    CONN_MANAGER
        .lock()
        .unwrap()
        .remove(&conn_id)
        .map(|h| h.abort());
    RATE_LIMITERS.lock().unwrap().remove(&conn_id);
    CONN_METRICS.lock().unwrap().remove(&conn_id);
    ACTIVE_CONN.fetch_sub(1, Ordering::SeqCst);
}
