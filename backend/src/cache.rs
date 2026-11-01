//! Disk cache for immutable upstream content: audio segments and artist images.
//!
//! Files are named after a hash of their key, with an extension that records the
//! content type. The index lives in memory and is rebuilt from the directory at
//! startup. When the cache grows past its limit the least recently used files go.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Mutex,
    time::SystemTime,
};

use bytes::Bytes;
use sha2::{Digest, Sha256};

/// Content types we pass on, with the file extension they are stored under.
pub const SEGMENT_TYPES: &[(&str, &str)] = &[
    ("video/mp2t", "ts"),
    ("audio/aac", "aac"),
    ("audio/mpeg", "mp3"),
    ("audio/mp4", "m4a"),
    ("video/mp4", "mp4"),
];
pub const IMAGE_TYPES: &[(&str, &str)] = &[
    ("image/jpeg", "jpg"),
    ("image/png", "png"),
    ("image/webp", "webp"),
    ("image/gif", "gif"),
    ("image/avif", "avif"),
];

fn type_for_ext(ext: &str) -> Option<&'static str> {
    SEGMENT_TYPES.iter().chain(IMAGE_TYPES).find(|(_, e)| *e == ext).map(|(t, _)| *t)
}

/// The allowlisted type matching an upstream `Content-Type`, ignoring parameters.
pub fn allowed_type(upstream: Option<&str>, allow: &[(&'static str, &'static str)]) -> Option<(&'static str, &'static str)> {
    let t = upstream?.split(';').next()?.trim().to_ascii_lowercase();
    allow.iter().find(|(a, _)| *a == t).copied()
}

struct Entry {
    ext: &'static str,
    size: u64,
    used: u64,
}

struct Index {
    entries: HashMap<String, Entry>,
    total: u64,
    clock: u64,
}

pub struct Cache {
    dir: Option<PathBuf>,
    max: u64,
    index: Mutex<Index>,
}

fn hash(key: &str) -> String {
    hex::encode(Sha256::digest(key.as_bytes()))
}

impl Cache {
    /// Opens (and creates) the directory. A cache that cannot be used is disabled, not fatal.
    pub fn open(dir: PathBuf, max: u64) -> Self {
        let mut index = Index { entries: HashMap::new(), total: 0, clock: 0 };
        let dir = match std::fs::create_dir_all(&dir).and_then(|_| std::fs::read_dir(&dir)) {
            Ok(read) => {
                let mut found: Vec<(SystemTime, String, Entry)> = read
                    .flatten()
                    .filter_map(|f| {
                        let name = f.file_name().into_string().ok()?;
                        let (h, ext) = name.split_once('.')?;
                        let ext = SEGMENT_TYPES.iter().chain(IMAGE_TYPES).find(|(_, e)| *e == ext)?.1;
                        let meta = f.metadata().ok()?;
                        Some((meta.modified().ok()?, h.to_string(), Entry { ext, size: meta.len(), used: 0 }))
                    })
                    .collect();
                found.sort_by_key(|(t, _, _)| *t);
                for (_, h, mut e) in found {
                    index.clock += 1;
                    e.used = index.clock;
                    index.total += e.size;
                    index.entries.insert(h, e);
                }
                tracing::info!("cache: {} files, {} MB in {}", index.entries.len(), index.total >> 20, dir.display());
                Some(dir)
            }
            Err(e) => {
                tracing::warn!("cache disabled, {}: {e}", dir.display());
                None
            }
        };
        Cache { dir, max, index: Mutex::new(index) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Index> {
        self.index.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub async fn get(&self, key: &str) -> Option<(Bytes, &'static str)> {
        let dir = self.dir.as_ref()?;
        let h = hash(key);
        let ext = {
            let mut idx = self.lock();
            idx.clock += 1;
            let clock = idx.clock;
            let e = idx.entries.get_mut(&h)?;
            e.used = clock;
            e.ext
        };
        match tokio::fs::read(dir.join(format!("{h}.{ext}"))).await {
            Ok(b) => Some((Bytes::from(b), type_for_ext(ext)?)),
            Err(_) => {
                let mut idx = self.lock();
                if let Some(e) = idx.entries.remove(&h) {
                    idx.total -= e.size;
                }
                None
            }
        }
    }

    pub async fn put(&self, key: &str, ext: &'static str, body: &Bytes) {
        let Some(dir) = &self.dir else { return };
        let h = hash(key);
        let tmp = dir.join(format!(".{h}.tmp"));
        let path = dir.join(format!("{h}.{ext}"));
        if let Err(e) = async {
            tokio::fs::write(&tmp, body).await?;
            tokio::fs::rename(&tmp, &path).await
        }
        .await
        {
            tracing::warn!("cache write failed: {e}");
            let _ = tokio::fs::remove_file(&tmp).await;
            return;
        }
        let evict = {
            let mut idx = self.lock();
            idx.clock += 1;
            let entry = Entry { ext, size: body.len() as u64, used: idx.clock };
            idx.total += entry.size;
            if let Some(old) = idx.entries.insert(h, entry) {
                idx.total -= old.size;
            }
            let mut evict = vec![];
            if idx.total > self.max {
                let mut by_age: Vec<(u64, String)> = idx.entries.iter().map(|(k, e)| (e.used, k.clone())).collect();
                by_age.sort();
                let target = self.max / 10 * 9;
                for (_, k) in by_age {
                    if idx.total <= target {
                        break;
                    }
                    if let Some(e) = idx.entries.remove(&k) {
                        idx.total -= e.size;
                        evict.push(format!("{k}.{}", e.ext));
                    }
                }
            }
            evict
        };
        for name in evict {
            let _ = tokio::fs::remove_file(dir.join(name)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn evicts_least_recently_used() {
        let dir = std::env::temp_dir().join(format!("pl8inf-cache-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let c = Cache::open(dir.clone(), 25);
        let body = Bytes::from_static(&[0u8; 10]);
        c.put("a", "ts", &body).await;
        c.put("b", "ts", &body).await;
        assert!(c.get("a").await.is_some()); // a is now newer than b
        c.put("c", "ts", &body).await; // 30 > 25: evict down to 22, b goes first
        assert!(c.get("b").await.is_none());
        assert!(c.get("a").await.is_some() || c.get("c").await.is_some());
        assert_eq!(c.get("c").await.unwrap().1, "video/mp2t");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn content_type_allowlist() {
        assert_eq!(allowed_type(Some("video/MP2T; charset=x"), SEGMENT_TYPES), Some(("video/mp2t", "ts")));
        assert_eq!(allowed_type(Some("text/html"), SEGMENT_TYPES), None);
        assert_eq!(allowed_type(Some("image/svg+xml"), IMAGE_TYPES), None);
    }
}
