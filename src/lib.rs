//! geofront/src/lib.rs
//! Minimal Minecraft proxy backend core with logging, routing, zero-copy forwarding, rate limiting, upstream proxy support, and metrics

// Module declarations
pub mod connection;
pub mod ffi;
pub mod logging;
pub mod protocol;
pub mod state;
pub mod types;
