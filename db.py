"""SQLite store: the shared track catalogue, plus per-user accounts and listening events."""

import hashlib
import secrets
import sqlite3
import threading
import time

SESSION_DAYS = 90

SCHEMA = """
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
-- Users are pl8list accounts, keyed by their pl8list user id. No pl8list session is stored.
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    handle TEXT NOT NULL,
    name TEXT,
    img TEXT,
    created_at REAL NOT NULL,
    last_seen REAL
);
-- Our own login sessions. Only a hash of the cookie token is kept.
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
"""

TRACK_COLS = [
    "id", "handle", "artist_name", "artist_img", "artist_verified", "slug", "title", "description",
    "bpm", "key", "duration", "preview_duration", "price", "created_at", "upload_id",
    "preview_upload_id", "waveform", "preview_waveform", "full_access", "saves", "downloads",
    "purchases", "comments",
]


class DB:
    def __init__(self, path):
        self.conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.executescript(SCHEMA)
        # Databases from the single-user version have events without an owner.
        if "user_id" not in [r["name"] for r in self.conn.execute("PRAGMA table_info(events)")]:
            self.conn.execute("DELETE FROM events")
            self.conn.execute("ALTER TABLE events ADD COLUMN user_id INTEGER")
        self.conn.execute("CREATE INDEX IF NOT EXISTS events_user ON events(user_id, kind, track_id)")
        self.lock = threading.Lock()

    def query(self, sql, args=()):
        with self.lock:
            return self.conn.execute(sql, args).fetchall()

    def execute(self, sql, args=()):
        with self.lock:
            return self.conn.execute(sql, args)

    def upsert_tracks(self, rows, related_of=None):
        """Insert or refresh tracks. Returns how many were new."""
        new = 0
        now = time.time()
        with self.lock:
            for r in rows:
                if not r:
                    continue
                exists = self.conn.execute("SELECT 1 FROM tracks WHERE id=?", (r["id"],)).fetchone()
                vals = [r[c] for c in TRACK_COLS]
                if exists:
                    sets = ",".join("%s=?" % c for c in TRACK_COLS[1:])
                    self.conn.execute("UPDATE tracks SET %s, updated_at=? WHERE id=?" % sets,
                                      vals[1:] + [now, r["id"]])
                else:
                    new += 1
                    self.conn.execute(
                        "INSERT INTO tracks (%s, related_of, updated_at) VALUES (%s)"
                        % (",".join(TRACK_COLS), ",".join("?" * (len(TRACK_COLS) + 2))),
                        vals + [related_of, now])
                self.conn.execute(
                    "INSERT INTO artists (handle, name, img, verified, source) VALUES (?,?,?,?,?) "
                    "ON CONFLICT(handle) DO UPDATE SET name=excluded.name, img=excluded.img, "
                    "verified=excluded.verified",
                    (r["handle"], r["artist_name"], r["artist_img"], r["artist_verified"], "track"))
        return new

    def upsert_artist(self, handle, name=None, img=None, verified=0, source=None):
        self.execute(
            "INSERT INTO artists (handle, name, img, verified, source) VALUES (?,?,?,?,?) "
            "ON CONFLICT(handle) DO UPDATE SET name=COALESCE(excluded.name, name), "
            "img=COALESCE(excluded.img, img), verified=MAX(verified, excluded.verified)",
            (handle, name, img, int(bool(verified)), source))

    def add_event(self, user_id, track_id, kind, seconds=None):
        self.execute("INSERT INTO events (user_id, track_id, kind, seconds, ts) VALUES (?,?,?,?,?)",
                     (user_id, track_id, kind, seconds, time.time()))

    def stats(self, user_id):
        row = self.query("""
            SELECT (SELECT COUNT(*) FROM tracks) AS tracks,
                   (SELECT COUNT(*) FROM artists) AS artists,
                   (SELECT COUNT(*) FROM artists WHERE pages_fetched > 0) AS artists_crawled,
                   (SELECT COUNT(DISTINCT track_id) FROM events WHERE user_id=? AND kind='served') AS served
        """, (user_id,))[0]
        return dict(row)

    # Accounts --------------------------------------------------------------

    def upsert_user(self, user):
        now = time.time()
        self.execute(
            "INSERT INTO users (id, handle, name, img, created_at, last_seen) VALUES (?,?,?,?,?,?) "
            "ON CONFLICT(id) DO UPDATE SET handle=excluded.handle, name=excluded.name, img=excluded.img, "
            "last_seen=excluded.last_seen",
            (user["id"], user["handle"], user.get("name"), user.get("img"), now, now))

    def create_session(self, user_id):
        """Returns the raw token for the cookie; only its hash is stored."""
        token = secrets.token_urlsafe(32)
        now = time.time()
        self.execute("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)",
                     (_hash(token), user_id, now, now + SESSION_DAYS * 86400))
        return token

    def session_user(self, token):
        rows = self.query("""
            SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
            WHERE s.token_hash=? AND s.expires_at > ?
        """, (_hash(token), time.time()))
        if not rows:
            return None
        user = dict(rows[0])
        if (user["last_seen"] or 0) < time.time() - 60:
            self.execute("UPDATE users SET last_seen=? WHERE id=?", (time.time(), user["id"]))
        return user

    def delete_session(self, token):
        self.execute("DELETE FROM sessions WHERE token_hash=?", (_hash(token),))

    def active_since(self, ts):
        return self.query("SELECT COUNT(*) AS n FROM users WHERE last_seen > ?", (ts,))[0]["n"]


def _hash(token):
    return hashlib.sha256(token.encode()).hexdigest()
