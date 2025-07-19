//! geofront/src/logging.rs
//! Logging initialization and runtime updates.

use crate::state::RELOAD_HANDLE;
use std::sync::Once;
use tracing_subscriber::prelude::*;
use tracing_subscriber::{filter::EnvFilter, fmt, reload::Layer as ReloadLayer};

static LOG_INIT: Once = Once::new();

// Initialize logging once
pub fn init_logging(default: &str) {
    LOG_INIT.call_once(|| {
        let filter = EnvFilter::new(default);
        let (reload_layer, handle) = ReloadLayer::new(filter);
        let subscriber = tracing_subscriber::registry()
            .with(reload_layer)
            .with(fmt::layer());
        tracing::subscriber::set_global_default(subscriber).unwrap();
        *RELOAD_HANDLE.lock().unwrap() = Some(handle);
    });
}
