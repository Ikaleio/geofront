//! geofront/src/lib.rs
//! Minimal Minecraft proxy backend core with logging, routing, zero-copy forwarding, rate limiting, upstream proxy support, and metrics

// Module declarations
pub mod cache;
pub mod connection;
pub mod ffi;
pub mod logging;
pub mod protocol;
pub mod splice;
pub mod state;
pub mod types;
