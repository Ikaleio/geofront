//! geofront/src/state.rs
//! Global state management.

use crate::types::{
    ConnMetrics, ConnectionManager, DisconnectionEvent, GeofrontOptions, ListenerState,
    MotdDecision, MotdRequest, ProxyConnection, RouteDecision, RouteRequest,
};
use crate::cache::RouterMotdCache;
use governor::{
    RateLimiter,
    clock::DefaultClock,
    state::{InMemoryState, direct::NotKeyed},
};
use lazy_static::lazy_static;
use std::{
    collections::HashMap,
    sync::{Arc, RwLock, atomic::AtomicU64},
};
use tokio::sync::{Mutex, oneshot};
use tracing_subscriber::{filter::EnvFilter, reload::Handle as ReloadHandle};

// Global metrics counters
pub static TOTAL_CONN: AtomicU64 = AtomicU64::new(0);
pub static ACTIVE_CONN: AtomicU64 = AtomicU64::new(0);
pub static TOTAL_BYTES_SENT: AtomicU64 = AtomicU64::new(0);
pub static TOTAL_BYTES_RECV: AtomicU64 = AtomicU64::new(0);

lazy_static! {
    pub static ref OPTIONS: RwLock<GeofrontOptions> = RwLock::new(GeofrontOptions::default());
    pub static ref CONN_METRICS: std::sync::Mutex<HashMap<ProxyConnection, Arc<ConnMetrics>>> =
        std::sync::Mutex::new(HashMap::new());
    // Map to hold the senders for pending routing decisions
    pub static ref PENDING_ROUTES: std::sync::Mutex<HashMap<ProxyConnection, oneshot::Sender<RouteDecision>>> =
        std::sync::Mutex::new(HashMap::new());
    // Map to hold the senders for pending MOTD decisions
    pub static ref PENDING_MOTDS: std::sync::Mutex<HashMap<ProxyConnection, oneshot::Sender<MotdDecision>>> =
        std::sync::Mutex::new(HashMap::new());

    // Thread-safe queues for polling-based approach (alternative to callbacks)
    pub static ref ROUTE_REQUEST_QUEUE: std::sync::Mutex<Vec<RouteRequest>> =
        std::sync::Mutex::new(Vec::new());
    pub static ref MOTD_REQUEST_QUEUE: std::sync::Mutex<Vec<MotdRequest>> =
        std::sync::Mutex::new(Vec::new());
    pub static ref DISCONNECTION_EVENT_QUEUE: std::sync::Mutex<Vec<DisconnectionEvent>> =
        std::sync::Mutex::new(Vec::new());

    pub static ref LISTENER_STATE: Arc<std::sync::Mutex<ListenerState>> =
        Arc::new(std::sync::Mutex::new(ListenerState::new()));
    pub static ref CONN_MANAGER: Arc<std::sync::Mutex<ConnectionManager>> =
        Arc::new(std::sync::Mutex::new(ConnectionManager::new()));
    pub static ref RATE_LIMITERS: std::sync::Mutex<
        HashMap<
            ProxyConnection,
            (
                Arc<RateLimiter<NotKeyed, InMemoryState, DefaultClock>>,
                Arc<RateLimiter<NotKeyed, InMemoryState, DefaultClock>>,
            ),
        >,
    > = std::sync::Mutex::new(HashMap::new());
    pub static ref LISTENER_COUNTER: AtomicU64 = AtomicU64::new(1);
    pub static ref CONN_COUNTER: AtomicU64 = AtomicU64::new(1);
    pub static ref RELOAD_HANDLE: std::sync::Mutex<Option<ReloadHandle<EnvFilter, tracing_subscriber::Registry>>> =
        std::sync::Mutex::new(None);
    // This lock serializes all FFI calls to the router to prevent concurrency issues.
    pub static ref FFI_ROUTER_LOCK: Mutex<()> = Mutex::new(());
    // This lock serializes all FFI calls to the MOTD callback to prevent concurrency issues.
    pub static ref FFI_MOTD_LOCK: Mutex<()> = Mutex::new(());
    // This lock serializes all FFI calls to the disconnection callback to prevent concurrency issues.
    pub static ref FFI_DISCONNECTION_LOCK: Mutex<()> = Mutex::new(());
    
    // Router/MOTD cache instance
    pub static ref ROUTER_MOTD_CACHE: RouterMotdCache = RouterMotdCache::new();
}
