//! geofront/src/cache.rs
//! Router/MOTD cache implementation for high-performance caching in Rust layer

use crate::types::{CacheConfig, CacheGranularity};
use dashmap::DashMap;
use serde_json::Value;
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
pub struct CacheEntry {
    pub data: Value,
    pub is_rejection: bool,
    pub reject_reason: Option<String>,
    pub expires_at: Instant,
}

pub struct RouterMotdCache {
    // 使用 DashMap 支持并发访问
    cache: DashMap<String, CacheEntry>,
}

impl RouterMotdCache {
    pub fn new() -> Self {
        Self {
            cache: DashMap::new(),
        }
    }

    // 生成缓存键
    fn generate_key(&self, ip: &str, host: Option<&str>, granularity: &CacheGranularity) -> String {
        match granularity {
            CacheGranularity::Ip => format!("ip:{}", ip),
            CacheGranularity::IpHost => format!("ip:{}:host:{}", ip, host.unwrap_or("default")),
        }
    }

    // 获取缓存
    pub fn get(
        &self,
        ip: &str,
        host: Option<&str>,
        granularity: &CacheGranularity,
    ) -> Option<CacheEntry> {
        let key = self.generate_key(ip, host, granularity);

        if let Some(entry_ref) = self.cache.get(&key) {
            if entry_ref.expires_at > Instant::now() {
                return Some(entry_ref.clone());
            } else {
                // 过期，需要删除。注意：必须先释放 entry_ref（释放分片读锁）再进行 remove，
                // 否则 DashMap 可能出现同分片写锁获取阻塞，导致后续逻辑卡死（表现为后续 MOTD 请求无响应）。
                let expired = entry_ref.expires_at <= Instant::now();
                if expired {
                    drop(entry_ref); // 显式释放引用
                    self.cache.remove(&key);
                }
            }
        }
        None
    }

    // 设置缓存
    pub fn set(&self, ip: &str, host: Option<&str>, data: Value, cache_config: &CacheConfig) {
        let key = self.generate_key(ip, host, &cache_config.granularity);
        let expires_at = Instant::now() + Duration::from_millis(cache_config.ttl);

        let entry = CacheEntry {
            data,
            is_rejection: cache_config.reject.unwrap_or(false),
            reject_reason: cache_config.reject_reason.clone(),
            expires_at,
        };

        self.cache.insert(key, entry);
    }

    // 清理过期缓存
    pub fn cleanup_expired(&self) {
        let now = Instant::now();
        self.cache.retain(|_, entry| entry.expires_at > now);
    }

    // 清除指定缓存
    pub fn clear(&self, ip: &str, host: Option<&str>, granularity: &CacheGranularity) {
        let key = self.generate_key(ip, host, granularity);
        self.cache.remove(&key);
    }

    // 获取缓存统计信息
    pub fn get_stats(&self) -> CacheStats {
        CacheStats {
            total_entries: self.cache.len(),
            expired_entries: self
                .cache
                .iter()
                .filter(|entry| entry.expires_at <= Instant::now())
                .count(),
        }
    }
}

#[derive(Debug)]
pub struct CacheStats {
    pub total_entries: usize,
    pub expired_entries: usize,
}

impl Default for RouterMotdCache {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_cache_basic_operations() {
        let cache = RouterMotdCache::new();
        let config = CacheConfig {
            granularity: CacheGranularity::Ip,
            ttl: 1000,
            reject: None,
            reject_reason: None,
        };

        // 测试设置和获取
        let data = json!({"test": "data"});
        cache.set("127.0.0.1", None, data.clone(), &config);

        let result = cache.get("127.0.0.1", None, &CacheGranularity::Ip);
        assert!(result.is_some());
        assert_eq!(result.unwrap().data, data);
    }

    #[test]
    fn test_cache_granularity() {
        let cache = RouterMotdCache::new();
        let ip_config = CacheConfig {
            granularity: CacheGranularity::Ip,
            ttl: 1000,
            reject: None,
            reject_reason: None,
        };
        let ip_host_config = CacheConfig {
            granularity: CacheGranularity::IpHost,
            ttl: 1000,
            reject: None,
            reject_reason: None,
        };

        let data1 = json!({"type": "ip_only"});
        let data2 = json!({"type": "ip_host"});

        // 设置不同粒度的缓存
        cache.set("127.0.0.1", None, data1.clone(), &ip_config);
        cache.set(
            "127.0.0.1",
            Some("example.com"),
            data2.clone(),
            &ip_host_config,
        );

        // 验证不同粒度缓存独立
        let ip_result = cache.get("127.0.0.1", None, &CacheGranularity::Ip);
        let ip_host_result = cache.get("127.0.0.1", Some("example.com"), &CacheGranularity::IpHost);

        assert_eq!(ip_result.unwrap().data, data1);
        assert_eq!(ip_host_result.unwrap().data, data2);
    }

    #[test]
    fn test_cache_rejection() {
        let cache = RouterMotdCache::new();
        let reject_config = CacheConfig {
            granularity: CacheGranularity::Ip,
            ttl: 1000,
            reject: Some(true),
            reject_reason: Some("Blocked".to_string()),
        };

        let data = json!(null);
        cache.set("192.168.1.1", None, data, &reject_config);

        let result = cache.get("192.168.1.1", None, &CacheGranularity::Ip);
        assert!(result.is_some());
        let entry = result.unwrap();
        assert!(entry.is_rejection);
        assert_eq!(entry.reject_reason, Some("Blocked".to_string()));
    }

    #[test]
    fn test_cache_expiration() {
        let cache = RouterMotdCache::new();
        let short_cfg = CacheConfig {
            granularity: CacheGranularity::Ip,
            ttl: 10, // 10ms
            reject: None,
            reject_reason: None,
        };

        let data = json!({"k":"v"});
        cache.set("10.0.0.1", None, data, &short_cfg);
        // 立即命中
        assert!(cache.get("10.0.0.1", None, &CacheGranularity::Ip).is_some());
        // 等待过期
        std::thread::sleep(std::time::Duration::from_millis(20));
        // 过期访问应返回 None
        assert!(cache.get("10.0.0.1", None, &CacheGranularity::Ip).is_none());
    }
}
