//! Sliding-window rate limits, kept in memory only.

use std::{
    collections::{HashMap, VecDeque},
    sync::Mutex,
    time::{Duration, Instant},
};

/// At most `limit` hits per key within `window`.
pub struct RateLimiter {
    limit: usize,
    window: Duration,
    hits: Mutex<HashMap<String, VecDeque<Instant>>>,
}

impl RateLimiter {
    pub fn new(limit: usize, window_secs: u64) -> Self {
        RateLimiter { limit, window: Duration::from_secs(window_secs), hits: Mutex::new(HashMap::new()) }
    }

    pub fn allow(&self, key: &str) -> bool {
        let now = Instant::now();
        let mut hits = self.hits.lock().unwrap_or_else(|e| e.into_inner());
        if hits.len() > 10_000 {
            hits.retain(|_, q| q.back().is_some_and(|t| now.duration_since(*t) < self.window));
        }
        let q = hits.entry(key.to_string()).or_default();
        while q.front().is_some_and(|t| now.duration_since(*t) >= self.window) {
            q.pop_front();
        }
        if q.len() >= self.limit {
            return false;
        }
        q.push_back(now);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_per_key() {
        let l = RateLimiter::new(2, 60);
        assert!(l.allow("a"));
        assert!(l.allow("a"));
        assert!(!l.allow("a"));
        assert!(l.allow("b"));
    }
}
