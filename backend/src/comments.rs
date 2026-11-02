//! Timed comments of a track, for the waveform. pl8list pins every comment to a
//! moment of the track (`timestampSeconds`) and serves them newest first, 20 to a
//! page. We fetch a few pages on demand and keep them in memory for a while, so a
//! track that comes round again costs pl8list nothing.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use serde::Serialize;
use serde_json::Value;
use tokio::time::Instant;

use crate::pl8::Pl8;

/// Pages fetched per track: the newest 60 comments.
const PAGES: i64 = 3;
const TTL: Duration = Duration::from_secs(15 * 60);
/// Tracks kept; the oldest entry goes when a new one comes in.
const KEEP: usize = 512;
/// Longest comment body shown, in characters.
const MAX_BODY: usize = 200;

#[derive(Clone, Serialize, Debug, PartialEq)]
pub struct Comment {
    pub id: i64,
    /// Seconds into the track.
    pub at: f64,
    pub body: String,
    pub handle: String,
    pub name: String,
    pub img: Option<String>,
    pub verified: bool,
}

/// When a track's comments were fetched, and the comments.
type Entry = (Instant, Arc<Vec<Comment>>);

#[derive(Default)]
pub struct Comments {
    map: Mutex<HashMap<i64, Entry>>,
}

impl Comments {
    pub fn cached(&self, track_id: i64) -> Option<Arc<Vec<Comment>>> {
        let map = self.map.lock().unwrap();
        map.get(&track_id).filter(|(at, _)| at.elapsed() < TTL).map(|(_, c)| c.clone())
    }

    /// Fetch the comments from pl8list and keep them. A failed page ends the
    /// fetch with what came before it; a failed first page is an error.
    pub async fn fetch(&self, pl8: &Pl8, track_id: i64, handle: &str, slug: &str) -> anyhow::Result<Arc<Vec<Comment>>> {
        let mut out = vec![];
        for page in 1..=PAGES {
            let res = pl8.comments(handle, slug, page).await;
            let data = match res {
                Ok(Some(d)) => d,
                Ok(None) => break,
                Err(e) if page == 1 => return Err(e),
                Err(_) => break,
            };
            out.extend(parse(&data));
            let total = data.get("totalPages").and_then(Value::as_i64).unwrap_or(1);
            if page >= total {
                break;
            }
        }
        out.sort_by(|a, b| a.at.total_cmp(&b.at));
        let out = Arc::new(out);
        let mut map = self.map.lock().unwrap();
        if map.len() >= KEEP && !map.contains_key(&track_id) {
            map.retain(|_, (at, _)| at.elapsed() < TTL);
            if map.len() >= KEEP
                && let Some(oldest) = map.iter().min_by_key(|(_, (at, _))| *at).map(|(k, _)| *k)
            {
                map.remove(&oldest);
            }
        }
        map.insert(track_id, (Instant::now(), out.clone()));
        Ok(out)
    }
}

/// Comments from one page of `/api/{handle}/{slug}/comments`. Deleted, hidden,
/// untimed and empty ones are left out.
pub fn parse(data: &Value) -> Vec<Comment> {
    let Some(list) = data.get("comments").and_then(Value::as_array) else { return vec![] };
    list.iter()
        .filter_map(|c| {
            let flag = |k: &str| c.get(k).and_then(Value::as_bool).unwrap_or(false);
            if flag("isDeleted") || flag("isHiddenByOwner") {
                return None;
            }
            let at = c.get("timestampSeconds")?.as_f64().filter(|t| t.is_finite() && *t >= 0.0)?;
            let body = clean(c.get("body")?.as_str()?);
            if body.is_empty() {
                return None;
            }
            let user = c.get("user")?;
            let handle = user.get("handle")?.as_str()?.to_string();
            let name = user.get("name").and_then(Value::as_str).filter(|n| !n.trim().is_empty()).unwrap_or(&handle).trim().to_string();
            Some(Comment {
                id: c.get("id")?.as_i64()?,
                at,
                body,
                name,
                img: user.get("img").and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from),
                verified: user.get("isVerified").and_then(Value::as_bool).unwrap_or(false),
                handle,
            })
        })
        .collect()
}

/// One line, at most `MAX_BODY` characters.
fn clean(body: &str) -> String {
    let one_line = body.split_whitespace().collect::<Vec<_>>().join(" ");
    match one_line.char_indices().nth(MAX_BODY) {
        Some((cut, _)) => format!("{}…", one_line[..cut].trim_end()),
        None => one_line,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_keeps_timed_visible_comments() {
        let d = json!({"comments": [
            {"id": 1, "body": "  gass\n\nat 145  ", "timestampSeconds": 37.5, "isDeleted": false,
             "user": {"handle": "a", "name": "", "img": "x-1", "isVerified": true}},
            {"id": 2, "body": "gone", "timestampSeconds": 3.0, "isDeleted": true, "user": {"handle": "b"}},
            {"id": 3, "body": "hidden", "timestampSeconds": 3.0, "isHiddenByOwner": true, "user": {"handle": "b"}},
            {"id": 4, "body": "untimed", "timestampSeconds": null, "user": {"handle": "b"}},
            {"id": 5, "body": "   ", "timestampSeconds": 1.0, "user": {"handle": "b"}},
        ]});
        let c = parse(&d);
        assert_eq!(c.len(), 1);
        assert_eq!((c[0].id, c[0].at, c[0].body.as_str()), (1, 37.5, "gass at 145"));
        assert_eq!((c[0].name.as_str(), c[0].img.as_deref(), c[0].verified), ("a", Some("x-1"), true));
    }

    #[test]
    fn long_bodies_are_cut() {
        let long = "ä".repeat(MAX_BODY + 10);
        let cut = clean(&long);
        assert_eq!(cut.chars().count(), MAX_BODY + 1);
        assert!(cut.ends_with('…'));
    }
}
