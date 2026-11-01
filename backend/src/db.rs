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

// pl8_link: the device's pl8list session, encrypted (see link.rs). NULL unless the
// user chose to stay connected on that device.
const SCHEMA_V3: &str = r#"
ALTER TABLE sessions ADD COLUMN pl8_link BLOB;
ALTER TABLE sessions ADD COLUMN pl8_synced_at REAL;
CREATE TABLE IF NOT EXISTS follows (
    user_id INTEGER NOT NULL,
    handle TEXT NOT NULL,
    source TEXT NOT NULL,
    ts REAL NOT NULL,
    PRIMARY KEY (user_id, handle)
);
"#;

// track_tags: see tags.rs. track_related: the artists on a track's "related" page;
// the artist graph is read from it. meta: small settings, like the tagger version.
const SCHEMA_V4: &str = r#"
CREATE TABLE IF NOT EXISTS track_tags (
    track_id INTEGER NOT NULL,
    tag TEXT NOT NULL,
    PRIMARY KEY (track_id, tag)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS track_tags_tag ON track_tags(tag, track_id);
CREATE TABLE IF NOT EXISTS track_related (
    track_id INTEGER NOT NULL,
    handle TEXT NOT NULL,
    PRIMARY KEY (track_id, handle)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS track_related_handle ON track_related(handle);
INSERT OR IGNORE INTO track_related (track_id, handle)
    SELECT related_of, handle FROM tracks WHERE related_of IS NOT NULL;
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value
);
"#;

pub fn now() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs_f64()
}

#[derive(Clone)]
pub struct Db(Arc<Mutex<Connection>>);

impl Db {
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        let mut conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        migrate(&conn)?;
        let tagged = retag_if_stale(&mut conn)?;
        if tagged > 0 {
            tracing::info!("tagged {tagged} tracks");
        }
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
    if version < 3 {
        conn.execute_batch(&format!("BEGIN; {SCHEMA_V3} PRAGMA user_version = 3; COMMIT;"))?;
    }
    if version < 4 {
        conn.execute_batch(&format!("BEGIN; {SCHEMA_V4} PRAGMA user_version = 4; COMMIT;"))?;
    }
    Ok(())
}

/// An empty in-memory database, for tests.
#[cfg(test)]
pub fn memory() -> Connection {
    let c = Connection::open_in_memory().unwrap();
    migrate(&c).unwrap();
    c
}

// Tags and the artist graph ---------------------------------------------------

fn tags_of(t: &Track) -> Vec<&'static str> {
    crate::tags::of(&t.title, t.description.as_deref(), &t.artist_name, &t.handle, t.bpm)
}

fn set_tags(conn: &Connection, track_id: i64, tags: &[&str]) -> rusqlite::Result<()> {
    conn.prepare_cached("DELETE FROM track_tags WHERE track_id=?")?.execute([track_id])?;
    let mut insert = conn.prepare_cached("INSERT INTO track_tags (track_id, tag) VALUES (?,?)")?;
    for tag in tags {
        insert.execute(params![track_id, tag])?;
    }
    Ok(())
}

/// Tag the whole catalogue again if the rules in tags.rs changed. Returns how many
/// tracks were tagged.
pub fn retag_if_stale(conn: &mut Connection) -> rusqlite::Result<usize> {
    let done: Option<i64> = conn.query_row("SELECT value FROM meta WHERE key='tagger'", [], |r| r.get(0)).optional()?;
    if done == Some(crate::tags::VERSION) {
        return Ok(0);
    }
    let tx = conn.transaction()?;
    let tracks: Vec<Track> = tx.prepare("SELECT * FROM tracks")?.query_map([], Track::from_row)?.collect::<Result<_, _>>()?;
    tx.execute("DELETE FROM track_tags", [])?;
    for t in &tracks {
        set_tags(&tx, t.id, &tags_of(t))?;
    }
    tx.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('tagger', ?)", [crate::tags::VERSION])?;
    tx.commit()?;
    Ok(tracks.len())
}

pub fn track_tags(conn: &Connection, track_id: i64) -> rusqlite::Result<Vec<String>> {
    conn.prepare_cached("SELECT tag FROM track_tags WHERE track_id=? ORDER BY tag")?.query_map([track_id], |r| r.get(0))?.collect()
}

/// Remember which artists showed up on a track's related page.
pub fn add_related(conn: &mut Connection, track_id: i64, handles: &[String]) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    {
        let mut insert = tx.prepare_cached("INSERT OR IGNORE INTO track_related (track_id, handle) VALUES (?,?)")?;
        for h in handles {
            insert.execute(params![track_id, h])?;
        }
    }
    tx.commit()
}

/// Artist graph edges: (artist, related artist, how many of the first one's tracks
/// listed the second). Self links are left out.
pub fn artist_links(conn: &Connection) -> rusqlite::Result<Vec<(String, String, i64)>> {
    conn.prepare_cached(
        "SELECT t.handle, r.handle, COUNT(*) FROM track_related r JOIN tracks t ON t.id = r.track_id \
         WHERE t.handle <> r.handle GROUP BY t.handle, r.handle",
    )?
    .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
    .collect()
}

/// Artists linked to `handle` in either direction, with the summed link counts.
pub fn artist_neighbours(conn: &Connection, handle: &str) -> rusqlite::Result<Vec<(String, i64)>> {
    conn.prepare_cached(
        "SELECT h, SUM(n) FROM ( \
           SELECT r.handle AS h, COUNT(*) AS n FROM track_related r JOIN tracks t ON t.id = r.track_id \
             WHERE t.handle = ?1 AND r.handle <> ?1 GROUP BY r.handle \
           UNION ALL \
           SELECT t.handle, COUNT(*) FROM track_related r JOIN tracks t ON t.id = r.track_id \
             WHERE r.handle = ?1 AND t.handle <> ?1 GROUP BY t.handle \
         ) GROUP BY h",
    )?
    .query_map([handle], |r| Ok((r.get(0)?, r.get(1)?)))?
    .collect()
}

/// An artist as seen on their tracks.
#[derive(Debug, Serialize)]
pub struct Artist {
    pub handle: String,
    pub name: String,
    pub img: Option<String>,
    pub verified: bool,
    pub tracks: i64,
}

pub fn artist(conn: &Connection, handle: &str) -> rusqlite::Result<Option<Artist>> {
    conn.prepare_cached(
        "SELECT handle, artist_name, artist_img, artist_verified, COUNT(*) FROM tracks WHERE handle=? GROUP BY handle",
    )?
    .query_row([handle], |r| {
        Ok(Artist { handle: r.get(0)?, name: r.get(1)?, img: r.get(2)?, verified: r.get(3)?, tracks: r.get(4)? })
    })
    .optional()
}

/// An artist's most common style tags; tempo tags left out.
pub fn artist_tags(conn: &Connection, handle: &str, n: usize) -> rusqlite::Result<Vec<String>> {
    conn.prepare_cached(
        "SELECT g.tag FROM track_tags g JOIN tracks t ON t.id = g.track_id \
         WHERE t.handle=? AND g.tag NOT GLOB '[0-9]*' GROUP BY g.tag ORDER BY COUNT(*) DESC, g.tag LIMIT ?",
    )?
    .query_map(params![handle, n as i64], |r| r.get(0))?
    .collect()
}

/// How many tracks each artist has with `tag`.
pub fn tag_counts(conn: &Connection, tag: &str) -> rusqlite::Result<Vec<(String, i64)>> {
    conn.prepare_cached(
        "SELECT t.handle, COUNT(*) FROM track_tags g JOIN tracks t ON t.id = g.track_id WHERE g.tag=? GROUP BY t.handle",
    )?
    .query_map([tag], |r| Ok((r.get(0)?, r.get(1)?)))?
    .collect()
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
            set_tags(&tx, r.id, &tags_of(r))?;
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

pub fn track_path(conn: &Connection, track_id: i64) -> rusqlite::Result<Option<(String, String)>> {
    conn.query_row("SELECT handle, slug FROM tracks WHERE id=?", [track_id], |r| Ok((r.get(0)?, r.get(1)?))).optional()
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
    pub link: Option<Vec<u8>>,
    pub synced_at: Option<f64>,
}

pub fn session_user(conn: &Connection, token: &str) -> rusqlite::Result<Option<SessionHit>> {
    let now = now();
    let hit = conn
        .query_row(
            "SELECT u.*, s.created_at AS s_created, s.expires_at AS s_expires, s.pl8_link, s.pl8_synced_at \
             FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash=? AND s.expires_at > ?",
            params![hash_token(token), now],
            |r| {
                Ok(SessionHit {
                    user: User::from_row(r)?,
                    created_at: r.get("s_created")?,
                    expires_at: r.get("s_expires")?,
                    link: r.get("pl8_link")?,
                    synced_at: r.get("pl8_synced_at")?,
                })
            },
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

/// Store (or replace) the encrypted pl8list session of one device.
pub fn set_link(conn: &Connection, token_hash: &str, blob: &[u8], synced_at: Option<f64>) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE sessions SET pl8_link=?, pl8_synced_at=COALESCE(?, pl8_synced_at) WHERE token_hash=?",
        params![blob, synced_at, token_hash],
    )?;
    Ok(())
}

pub fn clear_link(conn: &Connection, token_hash: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE sessions SET pl8_link=NULL, pl8_synced_at=NULL WHERE token_hash=?", [token_hash])?;
    Ok(())
}

pub fn mark_synced(conn: &Connection, token_hash: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE sessions SET pl8_synced_at=? WHERE token_hash=? AND pl8_link IS NOT NULL", params![now(), token_hash])?;
    Ok(())
}

pub fn delete_session(conn: &Connection, token: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM sessions WHERE token_hash=?", [hash_token(token)])?;
    Ok(())
}

pub fn delete_user_sessions(conn: &Connection, user_id: i64) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM sessions WHERE user_id=?", [user_id])?;
    Ok(())
}

// Library sync ---------------------------------------------------------------

/// Tracks saved on pl8list count as likes, unless the user already liked or unliked
/// them here. Returns how many were added.
pub fn import_likes(conn: &mut Connection, user_id: i64, track_ids: &[i64]) -> rusqlite::Result<usize> {
    let tx = conn.transaction()?;
    let mut added = 0;
    {
        let mut insert = tx.prepare_cached(
            "INSERT INTO events (user_id, track_id, kind, seconds, ts) SELECT ?1, ?2, 'like', NULL, ?3 \
             WHERE NOT EXISTS (SELECT 1 FROM events WHERE user_id=?1 AND track_id=?2 AND kind IN ('like', 'unlike'))",
        )?;
        let now = now();
        for id in track_ids {
            added += insert.execute(params![user_id, id, now])?;
        }
    }
    tx.commit()?;
    Ok(added)
}

pub fn add_follows(conn: &mut Connection, user_id: i64, handles: &[String], source: &str) -> rusqlite::Result<usize> {
    let tx = conn.transaction()?;
    let mut added = 0;
    {
        let mut insert = tx.prepare_cached("INSERT OR IGNORE INTO follows (user_id, handle, source, ts) VALUES (?,?,?,?)")?;
        let now = now();
        for h in handles {
            added += insert.execute(params![user_id, h, source, now])?;
        }
    }
    tx.commit()?;
    Ok(added)
}

pub fn unfollow(conn: &Connection, user_id: i64, handle: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM follows WHERE user_id=? AND handle=?", params![user_id, handle])?;
    Ok(())
}

pub fn follows(conn: &Connection, user_id: i64) -> rusqlite::Result<std::collections::HashSet<String>> {
    conn.prepare_cached("SELECT handle FROM follows WHERE user_id=?")?.query_map([user_id], |r| r.get(0))?.collect()
}

pub fn active_since(conn: &Connection, ts: f64) -> rusqlite::Result<i64> {
    conn.query_row("SELECT COUNT(*) FROM users WHERE last_seen > ?", [ts], |r| r.get(0))
}

/// Everything stored about one user (Art. 15 / 20 GDPR).
pub fn export_user(conn: &Connection, user_id: i64) -> rusqlite::Result<serde_json::Value> {
    let user = conn.query_row("SELECT * FROM users WHERE id=?", [user_id], User::from_row)?;
    let sessions: Vec<serde_json::Value> = conn
        .prepare(
            "SELECT created_at, expires_at, pl8_link IS NOT NULL, pl8_synced_at FROM sessions \
             WHERE user_id=? ORDER BY created_at",
        )?
        .query_map([user_id], |r| {
            Ok(serde_json::json!({
                "created_at": r.get::<_, f64>(0)?,
                "expires_at": r.get::<_, f64>(1)?,
                "pl8list_connected": r.get::<_, bool>(2)?,
                "pl8list_synced_at": r.get::<_, Option<f64>>(3)?,
            }))
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
    let follows: Vec<serde_json::Value> = conn
        .prepare("SELECT handle, source, ts FROM follows WHERE user_id=? ORDER BY ts")?
        .query_map([user_id], |r| {
            Ok(serde_json::json!({ "artist": r.get::<_, String>(0)?, "source": r.get::<_, String>(1)?, "ts": r.get::<_, f64>(2)? }))
        })?
        .collect::<Result<_, _>>()?;
    Ok(serde_json::json!({
        "exported_at": now(),
        "user": user,
        "sessions": sessions,
        "follows": follows,
        "events": events,
        "note": "Times are Unix timestamps in seconds. Session tokens are stored only as hashes and are not included. \
                 A connected session's pl8list login is stored encrypted with a key only your browser holds, so it \
                 cannot be included either.",
    }))
}

/// Remove a user and everything linked to them (Art. 17 GDPR).
pub fn delete_user(conn: &mut Connection, user_id: i64) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM events WHERE user_id=?", [user_id])?;
    tx.execute("DELETE FROM follows WHERE user_id=?", [user_id])?;
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

    use super::memory as mem;

    #[test]
    fn upsert_tags_tracks_and_retag_follows_the_tagger_version() {
        let mut c = mem();
        let t = Track { id: 1, handle: "h".into(), artist_name: "H".into(), slug: "s".into(), title: "Big VIP".into(), bpm: Some(140.0), ..Default::default() };
        upsert_tracks(&mut c, &[t], None).unwrap();
        assert_eq!(track_tags(&c, 1).unwrap(), ["140", "vip"]);
        c.execute("DELETE FROM track_tags", []).unwrap();
        assert_eq!(retag_if_stale(&mut c).unwrap(), 1);
        assert_eq!(retag_if_stale(&mut c).unwrap(), 0);
        assert_eq!(track_tags(&c, 1).unwrap(), ["140", "vip"]);
    }

    #[test]
    fn artist_graph_reads_related_pages_both_ways() {
        let mut c = mem();
        let track = |id, h: &str| Track { id, handle: h.into(), artist_name: h.into(), slug: format!("s{id}"), title: "T".into(), ..Default::default() };
        upsert_tracks(&mut c, &[track(1, "a"), track(2, "a"), track(3, "b")], None).unwrap();
        add_related(&mut c, 1, &["b".into(), "c".into(), "a".into()]).unwrap();
        add_related(&mut c, 2, &["b".into()]).unwrap();
        add_related(&mut c, 3, &["d".into()]).unwrap();
        let mut n = artist_neighbours(&c, "a").unwrap();
        n.sort();
        assert_eq!(n, [("b".to_string(), 2), ("c".to_string(), 1)]);
        let mut n = artist_neighbours(&c, "b").unwrap();
        n.sort();
        assert_eq!(n, [("a".to_string(), 2), ("d".to_string(), 1)]);
        assert_eq!(artist_links(&c).unwrap().len(), 3);
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
    fn imported_likes_do_not_override_choices_made_here() {
        let mut c = mem();
        upsert_user(&c, 1, "a", None, None).unwrap();
        add_event(&c, 1, 10, "unlike", None).unwrap();
        assert_eq!(import_likes(&mut c, 1, &[10, 11]).unwrap(), 1);
        assert_eq!(import_likes(&mut c, 1, &[10, 11]).unwrap(), 0);
        assert_eq!(add_follows(&mut c, 1, &["x".into(), "y".into()], "pl8list").unwrap(), 2);
        assert_eq!(add_follows(&mut c, 1, &["x".into()], "local").unwrap(), 0);
        unfollow(&c, 1, "x").unwrap();
        assert_eq!(follows(&c, 1).unwrap().into_iter().collect::<Vec<_>>(), vec!["y".to_string()]);
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
