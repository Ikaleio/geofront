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
pub trait AsyncStreamTrait: AsyncRead + AsyncWrite + Unpin + Send + Any {}

// Implement this trait for any type that satisfies the bounds. This is a "blanket implementation".
impl<T: AsyncRead + AsyncWrite + Unpin + Send + 'static> AsyncStreamTrait for T {}

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

// Struct for route requests (used in polling API)
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RouteRequest {
    pub conn_id: ProxyConnection,
    pub peer_ip: String,
    pub port: u16,
    pub protocol: u32,
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
    pub protocol: u32,
    pub host: String,
}

// Struct for disconnection events (used in polling API)
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DisconnectionEvent {
    pub conn_id: ProxyConnection,
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
}

#[derive(Serialize, Deserialize, Debug)]
pub struct MotdVersion {
    pub name: String,
    pub protocol: i32,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct MotdPlayers {
    pub max: i32,
    pub online: i32,
    pub sample: Vec<MotdPlayerSample>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct MotdPlayerSample {
    pub name: String,
    pub id: String,
}
