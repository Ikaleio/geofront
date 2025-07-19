//! geofront/src/types.rs
//! Core data structures, type aliases, and constants.

use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::atomic::AtomicU64};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::task::JoinHandle;

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
pub trait AsyncStreamTrait: AsyncRead + AsyncWrite + Unpin + Send {}

// Implement this trait for any type that satisfies the bounds. This is a "blanket implementation".
impl<T: AsyncRead + AsyncWrite + Unpin + Send> AsyncStreamTrait for T {}

// Use the new trait to define our dynamic stream type.
pub type AsyncStream = dyn AsyncStreamTrait;

// Struct for JS to return routing decision as a JSON string
#[derive(Serialize, Deserialize, Debug, Default)]
pub struct RouteDecision {
    #[serde(rename = "remoteHost")]
    pub remote_host: Option<String>,
    #[serde(rename = "remotePort")]
    pub remote_port: Option<u16>,
    pub proxy: Option<String>,
    #[serde(rename = "proxyProtocol")]
    pub proxy_protocol: Option<u8>,
    pub disconnect: Option<String>,
    #[serde(rename = "rewriteHost")]
    pub rewrite_host: Option<String>,
}

// Router callback signature.
pub type ProxyRouterFn = extern "C" fn(
    ProxyConnection,
    *const std::os::raw::c_char, // peer_ip
    std::os::raw::c_ushort,      // port
    std::os::raw::c_uint,        // protocol
    *const std::os::raw::c_char, // host
    *const std::os::raw::c_char, // user
);

// Per-connection metrics
#[derive(Serialize)]
pub struct ConnMetrics {
    pub bytes_sent: AtomicU64,
    pub bytes_recv: AtomicU64,
}

// Snapshot structs for JSON serialization
#[derive(Serialize)]
pub struct MetricsSnapshot {
    pub total_conn: u64,
    pub active_conn: u64,
    pub total_bytes_sent: u64,
    pub total_bytes_recv: u64,
    pub connections: HashMap<ProxyConnection, ConnMetricsSnapshot>,
}

#[derive(Serialize)]
pub struct ConnMetricsSnapshot {
    pub bytes_sent: u64,
    pub bytes_recv: u64,
}

pub struct ListenerState {
    pub runtime: tokio::runtime::Runtime,
    pub listeners: HashMap<ProxyListener, JoinHandle<()>>,
}

impl ListenerState {
    pub fn new() -> Self {
        ListenerState {
            runtime: tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .unwrap(),
            listeners: HashMap::new(),
        }
    }
}

pub struct ConnectionManager {
    pub connections: HashMap<ProxyConnection, JoinHandle<()>>,
}

impl ConnectionManager {
    pub fn new() -> Self {
        ConnectionManager {
            connections: HashMap::new(),
        }
    }

    pub fn insert(&mut self, id: ProxyConnection, h: JoinHandle<()>) {
        self.connections.insert(id, h);
    }

    pub fn remove(&mut self, id: &ProxyConnection) -> Option<JoinHandle<()>> {
        self.connections.remove(id)
    }
}

pub struct HandshakeData {
    pub protocol_version: i32,
    pub host: String,
    pub port: u16,
    #[allow(dead_code)]
    pub next_state: i32,
}
