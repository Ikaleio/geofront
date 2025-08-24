//! geofront/src/types.rs
//! Core data structures, type aliases, and constants.

use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::atomic::AtomicU64};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::task::JoinHandle;

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProxyProtocolIn {
    Optional,
    Strict,
    None,
}

impl Default for ProxyProtocolIn {
    fn default() -> Self {
        ProxyProtocolIn::None
    }
}

#[derive(Serialize, Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GeofrontOptions {
    #[serde(default)]
    pub proxy_protocol_in: ProxyProtocolIn,
}

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
use std::any::Any;

// Platform-specific raw IO handle imports / aliases
#[cfg(unix)]
use std::os::unix::io::{AsRawFd, RawFd};
#[cfg(windows)]
use std::os::windows::io::{AsRawSocket, RawSocket};

#[cfg(unix)]
pub type RawIoHandle = RawFd;
#[cfg(windows)]
pub type RawIoHandle = RawSocket;

// A unified async stream trait with an optional method to extract the underlying raw handle.
// On Windows this returns the socket, on Unix the file descriptor. Name kept for backward
// compatibility even though it may return a socket on Windows.
pub trait AsyncStreamTrait: AsyncRead + AsyncWrite + Unpin + Send + Any {
    fn as_raw_fd_opt(&self) -> Option<RawIoHandle>;
    fn as_any(&self) -> &dyn Any;
    fn as_any_mut(&mut self) -> &mut dyn Any;
}

// Implement this trait for any type that satisfies the bounds. This is a "blanket implementation".
impl<T: AsyncRead + AsyncWrite + Unpin + Send + 'static> AsyncStreamTrait for T {
    fn as_raw_fd_opt(&self) -> Option<RawIoHandle> {
        use std::any::TypeId;
        if TypeId::of::<T>() == TypeId::of::<tokio::net::TcpStream>() {
            // Safe cast because we checked the concrete type id.
            let tcp_stream = unsafe { &*(self as *const T as *const tokio::net::TcpStream) };
            #[cfg(unix)]
            {
                return Some(tokio::net::TcpStream::as_raw_fd(tcp_stream));
            }
            #[cfg(windows)]
            {
                return Some(tokio::net::TcpStream::as_raw_socket(tcp_stream));
            }
        }
        None
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}

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
    pub cache: Option<CacheConfig>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct CacheConfig {
    pub granularity: CacheGranularity,
    pub ttl: u64, // TTL in milliseconds
    pub reject: Option<bool>,
    #[serde(rename = "rejectReason")]
    pub reject_reason: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub enum CacheGranularity {
    /// IP 级粒度。JSON: "ip"。
    Ip,
    /// IP + Host 级粒度。JSON: "ipHost"。
    IpHost,
}

// Struct for route requests (used in polling API)
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RouteRequest {
    pub conn_id: ProxyConnection,
    pub peer_ip: String,
    pub port: u16,
    // Minecraft 协议版本：应使用有符号 i32 以保持与握手解析一致
    pub protocol: i32,
    pub host: String,
    pub username: String,
}

// Struct for MOTD requests (used in polling API)
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MotdRequest {
    pub conn_id: ProxyConnection,
    pub peer_ip: String,
    pub port: u16,
    // Minecraft 协议版本：与 RouteRequest 一致使用 i32
    pub protocol: i32,
    pub host: String,
}

// Struct for disconnection events (used in polling API)
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DisconnectionEvent {
    pub conn_id: ProxyConnection,
}

// Struct for batch polling events
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PollEvents {
    pub route_requests: Vec<RouteRequest>,
    pub motd_requests: Vec<MotdRequest>,
    pub disconnection_events: Vec<DisconnectionEvent>,
}

// Per-connection metrics
#[derive(Serialize)]
pub struct ConnMetrics {
    pub bytes_sent: AtomicU64,
    pub bytes_recv: AtomicU64,
}

impl Default for ConnMetrics {
    fn default() -> Self {
        Self {
            bytes_sent: AtomicU64::new(0),
            bytes_recv: AtomicU64::new(0),
        }
    }
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

#[derive(Clone)]
pub struct HandshakeData {
    pub protocol_version: i32,
    pub host: String,
    pub port: u16,
    #[allow(dead_code)]
    pub next_state: i32,
}

// MOTD decision structure
#[derive(Serialize, Deserialize, Debug, Default)]
pub struct MotdDecision {
    pub version: Option<MotdVersion>,
    pub players: Option<MotdPlayers>,
    pub description: Option<serde_json::Value>, // Can be string or component object
    pub favicon: Option<String>,
    pub disconnect: Option<String>, // If present, disconnect with this message instead
    pub cache: Option<CacheConfig>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct MotdVersion {
    pub name: String,
    pub protocol: i32,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct MotdPlayers {
    pub max: i32,
    #[serde(default)]
    pub online: Option<i32>,
    #[serde(default)]
    pub sample: Vec<MotdPlayerSample>,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(untagged)]
pub enum MotdPlayerSample {
    Full { name: String, id: String },
    Name(String),
}
