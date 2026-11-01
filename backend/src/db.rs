//! SQLite store: the shared track catalogue, plus per-user accounts and listening events.
//!
//! The schema is the one the Python version created, so both can open the same file.
//! Changes are additive and tracked with `PRAGMA user_version`.

use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use base64::Engine;
use rand::Rng;
use rusqlite::{Connection, OptionalExtension, Row, params, params_from_iter};
use serde::Serialize;
use sha2::{Digest, Sha256};

/// Sessions end after this long without use.
pub const SESSION_IDLE_DAYS: f64 = 30.0;
/// "served" events only steer which tracks are new to a user; older ones are dropped.
pub const SERVED_RETENTION_DAYS: f64 = 180.0;

const SCHEMA_V1: &str = r#"
CREATE TABLE IF NOT EXISTS artists (
    handle TEXT PRIMARY KEY,
    name TEXT,
    img TEXT,
    verified INTEGER DEFAULT 0,
    source TEXT,
    pages_fetched INTEGER DEFAULT 0,
    total_pages INTEGER,
    last_crawled REAL
);
CREATE TABLE IF NOT EXISTS tracks (
    id INTEGER PRIMARY KEY,
    handle TEXT NOT NULL,
    artist_name TEXT,
    artist_img TEXT,
    artist_verified INTEGER DEFAULT 0,
    slug TEXT NOT NULL,
    title TEXT,
    description TEXT,
    bpm REAL,
    key TEXT,
    duration REAL,
    preview_duration REAL,
    price INTEGER DEFAULT 0,
    created_at TEXT,
    upload_id TEXT,
    preview_upload_id TEXT,
    waveform TEXT,
    preview_waveform TEXT,
    full_access INTEGER DEFAULT 0,
    saves INTEGER DEFAULT 0,
    downloads INTEGER DEFAULT 0,
    purchases INTEGER DEFAULT 0,
    comments INTEGER DEFAULT 0,
    related_of INTEGER,
    related_fetched INTEGER DEFAULT 0,
    updated_at REAL
);
CREATE INDEX IF NOT EXISTS tracks_handle ON tracks(handle);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    seconds REAL,
    ts REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    handle TEXT NOT NULL,
    name TEXT,
    img TEXT,
    created_at REAL NOT NULL,
    last_seen REAL
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at REAL NOT NULL,
    expires_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS search_terms (
    term TEXT PRIMARY KEY,
    pages_fetched INTEGER DEFAULT 0,
    total_pages INTEGER
);
"#;

const SCHEMA_V2: &str = r#"
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS events_kind_ts ON events(kind, ts);
"#;

pub fn now() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs_f64()
}

#[derive(Clone)]
pub struct Db(Arc<Mutex<Connection>>);

impl Db {
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        migrate(&conn)?;
        Ok(Db(Arc::new(Mutex::new(conn))))
    }

    /// Run `f` on the connection off the async runtime.
    pub async fn call<T, F>(&self, f: F) -> anyhow::Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> rusqlite::Result<T> + Send + 'static,
    {
        let db = self.0.clone();
        let out = tokio::task::spawn_blocking(move || {
            let mut conn = db.lock().unwrap_or_else(|e| e.into_inner());
            f(&mut conn)
        })
        .await??;
        Ok(out)
    }
}

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if version < 1 {
        conn.execute_batch(SCHEMA_V1)?;
        // Databases from the single-user version have events without an owner.
        let has_user: bool = conn
            .prepare("SELECT 1 FROM pragma_table_info('events') WHERE name='user_id'")?
            .exists([])?;
        if !has_user {
            conn.execute("DELETE FROM events", [])?;
            conn.execute("ALTER TABLE events ADD COLUMN user_id INTEGER", [])?;
        }
        conn.execute("CREATE INDEX IF NOT EXISTS events_user ON events(user_id, kind, track_id)", [])?;
        conn.pragma_update(None, "user_version", 1)?;
    }
    if version < 2 {
        conn.execute_batch(SCHEMA_V2)?;
        conn.pragma_update(None, "user_version", 2)?;
    }
    Ok(())
}

// Tracks ------------------------------------------------------------------

/// One row of `tracks`, as normalised from pl8list or read back.
#[derive(Clone, Debug, Default)]
pub struct Track {
    pub id: i64,
    pub handle: String,
    pub artist_name: String,
    pub artist_img: Option<String>,
    pub artist_verified: bool,
    pub slug: String,
    pub title: String,
    pub description: Option<String>,
    pub bpm: Option<f64>,
    pub key: Option<String>,
    pub duration: Option<f64>,
    pub preview_duration: Option<f64>,
    pub price: f64,
    pub created_at: Option<String>,
    pub upload_id: Option<String>,
    pub preview_upload_id: Option<String>,
    pub waveform: Option<String>,
    pub preview_waveform: Option<String>,
    pub full_access: bool,
    pub saves: i64,
    pub downloads: i64,
    pub purchases: i64,
    pub comments: i64,
    pub related_of: Option<i64>,
}

const TRACK_COLS: [&str; 23] = [
    "id", "handle", "artist_name", "artist_img", "artist_verified", "slug", "title", "description",
    "bpm", "key", "duration", "preview_duration", "price", "created_at", "upload_id",
    "preview_upload_id", "waveform", "preview_waveform", "full_access", "saves", "downloads",
    "purchases", "comments",
];

impl Track {
    pub fn from_row(r: &Row) -> rusqlite::Result<Self> {
        Ok(Track {
            id: r.get("id")?,
            handle: r.get("handle")?,
            artist_name: r.get::<_, Option<String>>("artist_name")?.unwrap_or_default(),
            artist_img: r.get("artist_img")?,
            artist_verified: r.get::<_, Option<i64>>("artist_verified")?.unwrap_or(0) != 0,
            slug: r.get("slug")?,
            title: r.get::<_, Option<String>>("title")?.unwrap_or_default(),
            description: r.get("description")?,
            bpm: r.get("bpm")?,
            key: r.get("key")?,
            duration: r.get("duration")?,
            preview_duration: r.get("preview_duration")?,
            price: r.get::<_, Option<f64>>("price")?.unwrap_or(0.0),
            created_at: r.get("created_at")?,
            upload_id: r.get("upload_id")?,
            preview_upload_id: r.get("preview_upload_id")?,
            waveform: r.get("waveform")?,
            preview_waveform: r.get("preview_waveform")?,
            full_access: r.get::<_, Option<i64>>("full_access")?.unwrap_or(0) != 0,
            saves: r.get::<_, Option<i64>>("saves")?.unwrap_or(0),
            downloads: r.get::<_, Option<i64>>("downloads")?.unwrap_or(0),
            purchases: r.get::<_, Option<i64>>("purchases")?.unwrap_or(0),
            comments: r.get::<_, Option<i64>>("comments")?.unwrap_or(0),
            related_of: r.get("related_of")?,
        })
    }

    fn values(&self) -> Vec<rusqlite::types::Value> {
        use rusqlite::types::Value;
        let opt = |s: &Option<String>| s.clone().map(Value::Text).unwrap_or(Value::Null);
        let optf = |f: Option<f64>| f.map(Value::Real).unwrap_or(Value::Null);
        // Whole prices stay integers, as the Python version stored them.
        let price = if self.price.fract() == 0.0 { Value::Integer(self.price as i64) } else { Value::Real(self.price) };
        vec![
            Value::Integer(self.id),
            Value::Text(self.handle.clone()),
            Value::Text(self.artist_name.clone()),
            opt(&self.artist_img),
            Value::Integer(self.artist_verified as i64),
            Value::Text(self.slug.clone()),
            Value::Text(self.title.clone()),
            opt(&self.description),
            optf(self.bpm),
            opt(&self.key),
            optf(self.duration),
            optf(self.preview_duration),
            price,
            opt(&self.created_at),
            opt(&self.upload_id),
            opt(&self.preview_upload_id),
            opt(&self.waveform),
            opt(&self.preview_waveform),
            Value::Integer(self.full_access as i64),
            Value::Integer(self.saves),
            Value::Integer(self.downloads),
            Value::Integer(self.purchases),
            Value::Integer(self.comments),
        ]
    }
}

/// Insert or refresh tracks and their artists. Returns how many were new.
pub fn upsert_tracks(conn: &mut Connection, rows: &[Track], related_of: Option<i64>) -> rusqlite::Result<usize> {
    let tx = conn.transaction()?;
    let mut new = 0;
    let now = now();
    {
        let sets = TRACK_COLS[1..].iter().map(|c| format!("{c}=?")).collect::<Vec<_>>().join(",");
        let mut update = tx.prepare_cached(&format!("UPDATE tracks SET {sets}, updated_at=? WHERE id=?"))?;
        let mut insert = tx.prepare_cached(&format!(
            "INSERT INTO tracks ({}, related_of, updated_at) VALUES ({})",
            TRACK_COLS.join(","),
            vec!["?"; TRACK_COLS.len() + 2].join(",")
        ))?;
        let mut artist = tx.prepare_cached(
            "INSERT INTO artists (handle, name, img, verified, source) VALUES (?,?,?,?,'track') \
             ON CONFLICT(handle) DO UPDATE SET name=excluded.name, img=excluded.img, verified=excluded.verified",
        )?;
        for r in rows {
            let mut vals = r.values();
            let id = vals[0].clone();
            let changed = {
                let mut v = vals[1..].to_vec();
                v.push(rusqlite::types::Value::Real(now));
                v.push(id);
                update.execute(params_from_iter(v))?
            };
            if changed == 0 {
                new += 1;
                vals.push(related_of.map(rusqlite::types::Value::Integer).unwrap_or(rusqlite::types::Value::Null));
                vals.push(rusqlite::types::Value::Real(now));
                insert.execute(params_from_iter(vals))?;
            }
            artist.execute(params![r.handle, r.artist_name, r.artist_img, r.artist_verified as i64])?;
        }
    }
    tx.commit()?;
    Ok(new)
}

pub fn upsert_artist(
    conn: &Connection,
    handle: &str,
    name: Option<&str>,
    img: Option<&str>,
    verified: bool,
    source: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO artists (handle, name, img, verified, source) VALUES (?,?,?,?,?) \
         ON CONFLICT(handle) DO UPDATE SET name=COALESCE(excluded.name, name), \
         img=COALESCE(excluded.img, img), verified=MAX(verified, excluded.verified)",
        params![handle, name, img, verified as i64, source],
    )?;
    Ok(())
}

pub fn add_event(conn: &Connection, user_id: i64, track_id: i64, kind: &str, seconds: Option<f64>) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO events (user_id, track_id, kind, seconds, ts) VALUES (?,?,?,?,?)",
        params![user_id, track_id, kind, seconds, now()],
    )?;
    Ok(())
}

pub fn track_count(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row("SELECT COUNT(*) FROM tracks", [], |r| r.get(0))
}

#[derive(Serialize)]
pub struct Stats {
    pub tracks: i64,
    pub artists: i64,
    pub artists_crawled: i64,
    pub served: i64,
    pub liked: usize,
}

pub fn stats(conn: &Connection, user_id: i64) -> rusqlite::Result<Stats> {
    conn.query_row(
        "SELECT (SELECT COUNT(*) FROM tracks), (SELECT COUNT(*) FROM artists), \
                (SELECT COUNT(*) FROM artists WHERE pages_fetched > 0), \
                (SELECT COUNT(DISTINCT track_id) FROM events WHERE user_id=? AND kind='served')",
        [user_id],
        |r| Ok(Stats { tracks: r.get(0)?, artists: r.get(1)?, artists_crawled: r.get(2)?, served: r.get(3)?, liked: 0 }),
    )
}

// Accounts ----------------------------------------------------------------

#[derive(Clone, Debug, Serialize)]
pub struct User {
    pub id: i64,
    pub handle: String,
    pub name: Option<String>,
    pub img: Option<String>,
    pub created_at: f64,
    pub last_seen: Option<f64>,
}

impl User {
    fn from_row(r: &Row) -> rusqlite::Result<Self> {
        Ok(User {
            id: r.get("id")?,
            handle: r.get("handle")?,
            name: r.get("name")?,
            img: r.get("img")?,
            created_at: r.get("created_at")?,
            last_seen: r.get("last_seen")?,
        })
    }
}

pub fn upsert_user(conn: &Connection, id: i64, handle: &str, name: Option<&str>, img: Option<&str>) -> rusqlite::Result<()> {
    let now = now();
    conn.execute(
        "INSERT INTO users (id, handle, name, img, created_at, last_seen) VALUES (?,?,?,?,?,?) \
         ON CONFLICT(id) DO UPDATE SET handle=excluded.handle, name=excluded.name, img=excluded.img, \
         last_seen=excluded.last_seen",
        params![id, handle, name, img, now, now],
    )?;
    Ok(())
}

pub fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

/// 32 random bytes, URL-safe base64, like Python's `secrets.token_urlsafe(32)`.
pub fn new_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Returns the raw token for the cookie; only its hash is stored.
pub fn create_session(conn: &Connection, user_id: i64) -> rusqlite::Result<String> {
    let token = new_token();
    let now = now();
    conn.execute(
        "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)",
        params![hash_token(&token), user_id, now, now + SESSION_IDLE_DAYS * 86400.0],
    )?;
    Ok(token)
}

pub struct SessionHit {
    pub user: User,
    pub created_at: f64,
    pub expires_at: f64,
}

pub fn session_user(conn: &Connection, token: &str) -> rusqlite::Result<Option<SessionHit>> {
    let now = now();
    let hit = conn
        .query_row(
            "SELECT u.*, s.created_at AS s_created, s.expires_at AS s_expires \
             FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash=? AND s.expires_at > ?",
            params![hash_token(token), now],
            |r| Ok(SessionHit { user: User::from_row(r)?, created_at: r.get("s_created")?, expires_at: r.get("s_expires")? }),
        )
        .optional()?;
    if let Some(h) = &hit {
        if h.user.last_seen.unwrap_or(0.0) < now - 60.0 {
            conn.execute("UPDATE users SET last_seen=? WHERE id=?", params![now, h.user.id])?;
        }
        // Sliding expiry, written at most once a day.
        if h.expires_at < now + (SESSION_IDLE_DAYS - 1.0) * 86400.0 {
            conn.execute(
                "UPDATE sessions SET expires_at=? WHERE token_hash=? AND expires_at > ?",
                params![now + SESSION_IDLE_DAYS * 86400.0, hash_token(token), now + 120.0],
            )?;
        }
    }
    Ok(hit)
}

/// Replace a session with a new token. The old one keeps working for a minute so
/// requests already in flight do not fail.
pub fn rotate_session(conn: &Connection, old_token: &str, user_id: i64) -> rusqlite::Result<String> {
    let token = create_session(conn, user_id)?;
    conn.execute(
        "UPDATE sessions SET expires_at=MIN(expires_at, ?) WHERE token_hash=?",
        params![now() + 60.0, hash_token(old_token)],
    )?;
    Ok(token)
}

pub fn delete_session(conn: &Connection, token: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM sessions WHERE token_hash=?", [hash_token(token)])?;
    Ok(())
}

pub fn delete_user_sessions(conn: &Connection, user_id: i64) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM sessions WHERE user_id=?", [user_id])?;
    Ok(())
}

pub fn active_since(conn: &Connection, ts: f64) -> rusqlite::Result<i64> {
    conn.query_row("SELECT COUNT(*) FROM users WHERE last_seen > ?", [ts], |r| r.get(0))
}

/// Everything stored about one user (Art. 15 / 20 GDPR).
pub fn export_user(conn: &Connection, user_id: i64) -> rusqlite::Result<serde_json::Value> {
    let user = conn.query_row("SELECT * FROM users WHERE id=?", [user_id], User::from_row)?;
    let sessions: Vec<serde_json::Value> = conn
        .prepare("SELECT created_at, expires_at FROM sessions WHERE user_id=? ORDER BY created_at")?
        .query_map([user_id], |r| {
            Ok(serde_json::json!({ "created_at": r.get::<_, f64>(0)?, "expires_at": r.get::<_, f64>(1)? }))
        })?
        .collect::<Result<_, _>>()?;
    let events: Vec<serde_json::Value> = conn
        .prepare(
            "SELECT e.ts, e.kind, e.seconds, e.track_id, t.handle, t.slug, t.title FROM events e \
             LEFT JOIN tracks t ON t.id = e.track_id WHERE e.user_id=? ORDER BY e.ts",
        )?
        .query_map([user_id], |r| {
            Ok(serde_json::json!({
                "ts": r.get::<_, f64>(0)?,
                "kind": r.get::<_, String>(1)?,
                "seconds": r.get::<_, Option<f64>>(2)?,
                "track_id": r.get::<_, i64>(3)?,
                "track": r.get::<_, Option<String>>(4)?.zip(r.get::<_, Option<String>>(5)?)
                    .map(|(h, s)| format!("https://pl8list.com/{h}/{s}")),
                "title": r.get::<_, Option<String>>(6)?,
            }))
        })?
        .collect::<Result<_, _>>()?;
    Ok(serde_json::json!({
        "exported_at": now(),
        "user": user,
        "sessions": sessions,
        "events": events,
        "note": "Times are Unix timestamps in seconds. Session tokens are stored only as hashes and are not included.",
    }))
}

/// Remove a user and everything linked to them (Art. 17 GDPR).
pub fn delete_user(conn: &mut Connection, user_id: i64) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM events WHERE user_id=?", [user_id])?;
    tx.execute("DELETE FROM sessions WHERE user_id=?", [user_id])?;
    tx.execute("DELETE FROM users WHERE id=?", [user_id])?;
    tx.commit()
}

/// Drop expired sessions and old "served" events. Returns (sessions, events) removed.
pub fn purge(conn: &Connection) -> rusqlite::Result<(usize, usize)> {
    let now = now();
    let s = conn.execute("DELETE FROM sessions WHERE expires_at <= ?", [now])?;
    let e = conn.execute(
        "DELETE FROM events WHERE kind='served' AND ts < ?",
        [now - SERVED_RETENTION_DAYS * 86400.0],
    )?;
    Ok((s, e))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        migrate(&c).unwrap();
        c
    }

    #[test]
    fn sessions_store_only_hashes_and_rotate() {
        let c = mem();
        upsert_user(&c, 7, "someone", None, None).unwrap();
        let token = create_session(&c, 7).unwrap();
        let stored: String = c.query_row("SELECT token_hash FROM sessions", [], |r| r.get(0)).unwrap();
        assert_ne!(stored, token);
        assert_eq!(stored, hash_token(&token));
        assert_eq!(session_user(&c, &token).unwrap().unwrap().user.id, 7);

        let new = rotate_session(&c, &token, 7).unwrap();
        assert!(session_user(&c, &new).unwrap().is_some());
        let old_expiry: f64 = c
            .query_row("SELECT expires_at FROM sessions WHERE token_hash=?", [hash_token(&token)], |r| r.get(0))
            .unwrap();
        assert!(old_expiry <= now() + 61.0);
    }

    #[test]
    fn delete_user_removes_everything() {
        let mut c = mem();
        upsert_user(&c, 1, "a", None, None).unwrap();
        upsert_user(&c, 2, "b", None, None).unwrap();
        create_session(&c, 1).unwrap();
        create_session(&c, 2).unwrap();
        add_event(&c, 1, 10, "like", None).unwrap();
        add_event(&c, 2, 10, "like", None).unwrap();
        delete_user(&mut c, 1).unwrap();
        let count = |sql: &str| c.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap();
        assert_eq!(count("SELECT COUNT(*) FROM users WHERE id=1"), 0);
        assert_eq!(count("SELECT COUNT(*) FROM sessions WHERE user_id=1"), 0);
        assert_eq!(count("SELECT COUNT(*) FROM events WHERE user_id=1"), 0);
        assert_eq!(count("SELECT COUNT(*) FROM events WHERE user_id=2"), 1);
    }

    #[test]
    fn upsert_counts_new_tracks() {
        let mut c = mem();
        let t = Track { id: 1, handle: "h".into(), artist_name: "H".into(), slug: "s".into(), title: "T".into(), price: 4.5, ..Default::default() };
        assert_eq!(upsert_tracks(&mut c, std::slice::from_ref(&t), None).unwrap(), 1);
        assert_eq!(upsert_tracks(&mut c, &[t], None).unwrap(), 0);
        let price: f64 = c.query_row("SELECT price FROM tracks", [], |r| r.get(0)).unwrap();
        assert_eq!(price, 4.5);
    }
}
