//! geofront/src/ffi.rs
//! FFI interface functions.

use crate::{
    connection::handle_conn,
    logging,
    state::{
        ACTIVE_CONN, CONN_COUNTER, CONN_MANAGER, CONN_METRICS,
        DISCONNECTION_EVENT_QUEUE, LISTENER_COUNTER, LISTENER_STATE,
        MOTD_REQUEST_QUEUE, OPTIONS, PENDING_MOTDS, PENDING_ROUTES,
        RATE_LIMITERS, RELOAD_HANDLE, ROUTE_REQUEST_QUEUE,
        TOTAL_BYTES_RECV, TOTAL_BYTES_SENT, TOTAL_CONN,
    },
    types::{
        ConnMetrics, ConnMetricsSnapshot, GeofrontOptions, MetricsSnapshot,
        MotdDecision, PROXY_ERR_BAD_PARAM, PROXY_ERR_INTERNAL, PROXY_ERR_NOT_FOUND,
        PROXY_OK, ProxyConnection, ProxyError, ProxyListener,
        RouteDecision,
    },
};
use governor::{Quota, RateLimiter};
use nonzero_ext::nonzero;
use std::{
    ffi::{CStr, CString},
    num::NonZeroU32,
    os::raw::{c_char, c_uint, c_ushort},
    ptr,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio::net::TcpListener;
use tracing::{error, info};
use tracing_subscriber::filter::EnvFilter;

/// Set global options from a JSON string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn proxy_set_options(options_json: *const c_char) -> ProxyError {
    if options_json.is_null() {
        return PROXY_ERR_BAD_PARAM;
    }
    let json_str = unsafe { CStr::from_ptr(options_json) }.to_string_lossy();
    let options: GeofrontOptions = match serde_json::from_str(&json_str) {
        Ok(opts) => opts,
        Err(e) => {
            error!("Failed to parse options JSON: {}", e);
            return PROXY_ERR_BAD_PARAM;
        }
    };

    let mut opts_guard = OPTIONS.write().unwrap();
    *opts_guard = options;

    info!("Updated global options");
    PROXY_OK
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
    logging::init_logging(lvl);
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



/// Submits the MOTD decision from JS back to Rust.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn proxy_submit_motd_decision(
    conn_id: ProxyConnection,
    decision_json: *const c_char,
) -> ProxyError {
    if decision_json.is_null() {
        return PROXY_ERR_BAD_PARAM;
    }
    let json_str = unsafe { CStr::from_ptr(decision_json) }.to_string_lossy();

    let decision: MotdDecision = match serde_json::from_str(&json_str) {
        Ok(d) => d,
        Err(e) => {
            error!(
                conn = conn_id,
                "Failed to parse submitted MOTD decision JSON: {}", e
            );
            MotdDecision {
                disconnect: Some("Invalid JSON from MOTD callback".to_string()),
                ..Default::default()
            }
        }
    };

    if let Some(sender) = PENDING_MOTDS.lock().unwrap().remove(&conn_id) {
        if sender.send(decision).is_err() {
            error!(
                conn = conn_id,
                "Failed to send MOTD decision: receiver dropped."
            );
            return PROXY_ERR_INTERNAL;
        }
    } else {
        error!(
            conn = conn_id,
            "No pending MOTD decision found for this connection."
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
    logging::init_logging("info");
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
                            Arc::new(RateLimiter::direct(Quota::per_second(nonzero!(u32::MAX))));
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
pub unsafe extern "C" fn proxy_stop_listener(listener: ProxyListener) -> ProxyError {
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
pub unsafe extern "C" fn proxy_disconnect(conn_id: ProxyConnection) -> ProxyError {
    if let Some(h) = CONN_MANAGER.lock().unwrap().remove(&conn_id) {
        h.abort();

        // Call disconnection callback if registered
        // The new polling mechanism handles disconnection events.
        // No need to manually call a callback here.

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
pub unsafe extern "C" fn proxy_set_rate_limit(
    conn_id: ProxyConnection,
    send_avg_bytes_per_sec: u64,
    send_burst_bytes_per_sec: u64,
    recv_avg_bytes_per_sec: u64,
    recv_burst_bytes_per_sec: u64,
) -> ProxyError {
    let mut rl = RATE_LIMITERS.lock().unwrap();
    if let Some((send_l, recv_l)) = rl.get_mut(&conn_id) {
        let send_avg = NonZeroU32::new(send_avg_bytes_per_sec as u32).unwrap_or(nonzero!(u32::MAX));
        let send_burst = NonZeroU32::new(send_burst_bytes_per_sec as u32).unwrap_or(send_avg);
        let recv_avg = NonZeroU32::new(recv_avg_bytes_per_sec as u32).unwrap_or(nonzero!(u32::MAX));
        let recv_burst = NonZeroU32::new(recv_burst_bytes_per_sec as u32).unwrap_or(recv_avg);

        *send_l = Arc::new(RateLimiter::direct(
            Quota::per_second(send_avg).allow_burst(send_burst),
        ));
        *recv_l = Arc::new(RateLimiter::direct(
            Quota::per_second(recv_avg).allow_burst(recv_burst),
        ));

        info!(
            conn = conn_id,
            send_avg = send_avg_bytes_per_sec,
            send_burst = send_burst_bytes_per_sec,
            recv_avg = recv_avg_bytes_per_sec,
            recv_burst = recv_burst_bytes_per_sec,
            "Updated rate limits"
        );
        PROXY_OK
    } else {
        PROXY_ERR_NOT_FOUND
    }
}

/// Shutdown all listeners and connections
#[unsafe(no_mangle)]
pub unsafe extern "C" fn proxy_shutdown() -> ProxyError {
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

    // Call disconnection callback for each connection
    // The new polling mechanism handles disconnection events.
    // No need to manually call callbacks here.

    CONN_METRICS.lock().unwrap().clear();
    PROXY_OK
}

/// Disconnect all active connections and returns the number of connections kicked.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn proxy_kick_all() -> c_uint {
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

    // Call disconnection callback for each kicked connection
    // The new polling mechanism handles disconnection events.
    // No need to manually call callbacks here.

    kicked_count as c_uint
}

/// Takes a snapshot of all metrics and returns it as a JSON string.
/// The caller is responsible for freeing the returned string using `proxy_free_string`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn proxy_get_metrics() -> *const c_char {
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
pub unsafe extern "C" fn proxy_get_connection_metrics(conn_id: ProxyConnection) -> *const c_char {
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

/// Alternative thread-safe approach: Poll for pending route requests
/// Returns NULL if no pending requests, otherwise returns JSON with request info
/// The caller is responsible for freeing the returned string using `proxy_free_string`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn proxy_poll_route_request() -> *const c_char {
    let mut queue = ROUTE_REQUEST_QUEUE.lock().unwrap();
    if queue.is_empty() {
        return ptr::null();
    }
    
    let request = queue.remove(0);
    match serde_json::to_string(&request) {
        Ok(json_str) => match CString::new(json_str) {
            Ok(c_str) => c_str.into_raw(),
            Err(_) => ptr::null(),
        },
        Err(_) => ptr::null(),
    }
}

/// Alternative thread-safe approach: Poll for pending MOTD requests
/// Returns NULL if no pending requests, otherwise returns JSON with request info
/// The caller is responsible for freeing the returned string using `proxy_free_string`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn proxy_poll_motd_request() -> *const c_char {
    let mut queue = MOTD_REQUEST_QUEUE.lock().unwrap();
    if queue.is_empty() {
        return ptr::null();
    }
    
    let request = queue.remove(0);
    match serde_json::to_string(&request) {
        Ok(json_str) => match CString::new(json_str) {
            Ok(c_str) => c_str.into_raw(),
            Err(_) => ptr::null(),
        },
        Err(_) => ptr::null(),
    }
}

/// Alternative thread-safe approach: Poll for disconnection events
/// Returns NULL if no pending events, otherwise returns JSON with disconnection info
/// The caller is responsible for freeing the returned string using `proxy_free_string`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn proxy_poll_disconnection_event() -> *const c_char {
    let mut queue = DISCONNECTION_EVENT_QUEUE.lock().unwrap();
    if queue.is_empty() {
        return ptr::null();
    }
    
    let event = queue.remove(0);
    match serde_json::to_string(&event) {
        Ok(json_str) => match CString::new(json_str) {
            Ok(c_str) => c_str.into_raw(),
            Err(_) => ptr::null(),
        },
        Err(_) => ptr::null(),
    }
}
