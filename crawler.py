"""Background discovery crawler.

There is no "all tracks" endpoint, so the pool grows by snowballing:
home page sections, the activity ticker, best-selling artists and user search
give us artists; artist pages give us their tracks; "related" pages of tracks
users liked or finished pull in neighbours. Everything goes through one priority
queue so feedback is crawled first.

The catalogue is shared by all users and crawled as a guest. The crawler runs
at full pace only while someone has used the app recently.
"""

import heapq
import itertools
import logging
import threading
import time

from pl8list import Client, normalize_item, normalize_related

log = logging.getLogger("crawler")

# Search needs at least 3 characters. Genre-ish words find lots of artist handles.
SEARCH_TERMS = [
    "dub", "bass", "dnb", "jungle", "garage", "grime", "riddim", "dubstep", "trap", "techno",
    "house", "beats", "music", "sound", "prod", "audio", "records", "drill", "breaks", "wave",
    "deep", "dark", "the", "official", "dj", "mc", "lofi", "halftime", "neuro", "tek",
]

# Lower number = sooner.
P_FEEDBACK = 0
P_SEED = 10
P_ARTIST_FIRST = 20
P_ARTIST_MORE = 40
P_RELATED = 30
P_SEARCH = 60

ACTIVE_WINDOW = 1800   # a user seen this recently counts as active
IDLE_DELAY = 20        # extra seconds between requests when nobody is active
MIN_POOL = 500         # crawl at full pace until the catalogue has this many tracks
REFRESH_AFTER = 86400  # re-check an artist's newest page for uploads this often


class Crawler:
    def __init__(self, client, db):
        self.client = client
        self.db = db
        self.queue = []
        self.queued = set()
        self.seq = itertools.count()
        self.cv = threading.Condition()
        self.last_seed = 0.0
        # Logged-in pl8list sessions, kept in memory only while that user's feed is crawled.
        self.feed_sessions = {}

    def push(self, priority, kind, arg):
        key = (kind, arg)
        with self.cv:
            if key in self.queued:
                return
            self.queued.add(key)
            heapq.heappush(self.queue, (priority, next(self.seq), kind, arg))
            self.cv.notify()

    def pop(self):
        with self.cv:
            while not self.queue:
                self.cv.wait(timeout=30)
                if not self.queue:
                    self._refill()
            priority, _, kind, arg = heapq.heappop(self.queue)
            self.queued.discard((kind, arg))
            return priority, kind, arg

    # Feedback hooks, called from the web server ----------------------------

    def on_positive(self, track_id):
        """Liked or listened through: crawl its related tracks and its artist's catalogue."""
        row = self.db.query("SELECT handle, slug FROM tracks WHERE id=?", (track_id,))
        if not row:
            return
        handle, slug = row[0]["handle"], row[0]["slug"]
        self.push(P_FEEDBACK, "related", (track_id, handle, slug))
        self.push(P_FEEDBACK, "artist", handle)

    def on_login(self, user_id, session):
        """Crawl the user's personal feed (artists in their pl8list library) with their session."""
        self.feed_sessions[user_id] = session
        self.push(P_FEEDBACK, "feed", (user_id, 1))

    # Main loop -------------------------------------------------------------

    def start(self):
        threading.Thread(target=self.run, daemon=True, name="crawler").start()

    def run(self):
        self._seed()
        while True:
            _, kind, arg = self.pop()
            try:
                getattr(self, "do_" + kind)(arg)
            except Exception:
                log.exception("crawl %s %r failed", kind, arg)
            if kind != "feed" and not self._busy():
                time.sleep(IDLE_DELAY)
            if time.time() - self.last_seed > 600:
                self._seed()

    def _busy(self):
        """Crawl at full pace while someone is listening or the catalogue is still small."""
        if self.db.active_since(time.time() - ACTIVE_WINDOW):
            return True
        return self.db.query("SELECT COUNT(*) AS n FROM tracks")[0]["n"] < MIN_POOL

    def _seed(self):
        self.last_seed = time.time()
        self.push(P_SEED, "home", None)
        self.push(P_SEED, "ticker", None)
        self.push(P_SEED, "best_artists", None)
        for term in SEARCH_TERMS:
            self.push(P_SEARCH, "search", term)

    def _refill(self):
        """Queue ran dry: queue more artist pages, related lookups and stale artists."""
        for r in self.db.query("""
            SELECT handle FROM artists
            WHERE total_pages IS NULL OR pages_fetched < total_pages
            ORDER BY verified DESC, pages_fetched ASC LIMIT 20
        """):
            self.push(P_ARTIST_MORE, "artist", r["handle"])
        for r in self.db.query("""
            SELECT id, handle, slug FROM tracks WHERE related_fetched=0
            ORDER BY saves + downloads DESC LIMIT 10
        """):
            self.push(P_RELATED, "related", (r["id"], r["handle"], r["slug"]))
        for r in self.db.query("""
            SELECT handle FROM artists
            WHERE pages_fetched > 0 AND last_crawled < ?
            ORDER BY last_crawled LIMIT 20
        """, (time.time() - REFRESH_AFTER,)):
            self.push(P_ARTIST_MORE, "artist_refresh", r["handle"])

    # Jobs ------------------------------------------------------------------

    def _add_artist(self, handle, source, name=None, img=None, verified=0, priority=P_ARTIST_FIRST):
        known = self.db.query("SELECT pages_fetched FROM artists WHERE handle=?", (handle,))
        self.db.upsert_artist(handle, name, img, verified, source)
        if not known or known[0]["pages_fetched"] == 0:
            self.push(priority, "artist", handle)

    def do_home(self, _):
        d = self.client.home() or {}
        for section in ("bestSellers", "recommended"):
            self.db.upsert_tracks([normalize_item(i) for i in (d.get(section) or {}).get("items", [])])
        for e in d.get("tickerEvents") or []:
            self._add_artist(e["artistHandle"], "ticker", e.get("artistName"))

    def do_ticker(self, _):
        for e in (self.client.activity_ticker() or {}).get("events", []):
            self._add_artist(e["artistHandle"], "ticker", e.get("artistName"))

    def do_best_artists(self, _):
        d = self.client.best_selling_artists() or {}
        for a in d.get("artists") or []:
            self._add_artist(a["artist_handle"], "best_sellers", a.get("artist_name"),
                             a.get("artist_img"), a.get("artist_isVerified"), priority=P_SEED)
        self.db.upsert_tracks([normalize_item(i) for i in (d.get("recommended") or {}).get("items", [])])

    def do_feed(self, arg):
        user_id, page = arg
        session = self.feed_sessions.get(user_id)
        if not session:
            return
        d = Client(session).feed(page) or {}
        self.db.upsert_tracks([normalize_item(i) for i in d.get("tracks") or []])
        for i in d.get("tracks") or []:
            self.push(P_ARTIST_FIRST, "artist", i["track"]["user"]["handle"])
        if page < (d.get("totalPages") or 0):
            self.push(P_FEEDBACK, "feed", (user_id, page + 1))
        else:
            self.feed_sessions.pop(user_id, None)

    def do_artist_refresh(self, handle):
        """Newest uploads are on page 1, so re-reading it catches new tracks."""
        d = self.client.artist(handle, 1)
        if d:
            new = self.db.upsert_tracks([normalize_item(i) for i in d.get("tracks") or []])
            if new:
                log.info("artist %s: %d new uploads", handle, new)
        self.db.execute("UPDATE artists SET last_crawled=? WHERE handle=?", (time.time(), handle))

    def do_artist(self, handle):
        row = self.db.query("SELECT pages_fetched, total_pages FROM artists WHERE handle=?", (handle,))
        fetched = row[0]["pages_fetched"] if row else 0
        total = row[0]["total_pages"] if row else None
        if total is not None and fetched >= total:
            return
        page = fetched + 1
        d = self.client.artist(handle, page)
        if not d:
            self.db.execute("UPDATE artists SET total_pages=0, last_crawled=? WHERE handle=?",
                            (time.time(), handle))
            return
        new = self.db.upsert_tracks([normalize_item(i) for i in d.get("tracks") or []])
        total = d.get("totalPages") or 0
        self.db.execute("UPDATE artists SET pages_fetched=?, total_pages=?, last_crawled=? WHERE handle=?",
                        (page, total, time.time(), handle))
        log.info("artist %s page %d/%d: %d new tracks", handle, page, total, new)
        if page < total:
            self.push(P_ARTIST_MORE + page, "artist", handle)

    def do_related(self, arg):
        track_id, handle, slug = arg
        d = self.client.related(handle, slug)
        self.db.execute("UPDATE tracks SET related_fetched=1 WHERE id=?", (track_id,))
        if not d:
            return
        rows = normalize_related(d)
        self.db.upsert_tracks(rows, related_of=track_id)
        for r in rows:
            self._add_artist(r["handle"], "related", r["artist_name"], r["artist_img"], r["artist_verified"],
                             priority=P_RELATED)

    def do_search(self, term):
        row = self.db.query("SELECT pages_fetched, total_pages FROM search_terms WHERE term=?", (term,))
        fetched = row[0]["pages_fetched"] if row else 0
        total = row[0]["total_pages"] if row else None
        if total is not None and fetched >= total:
            return
        page = fetched + 1
        d = self.client.search_users(term, page) or {}
        for item in d.get("items") or []:
            a = item.get("artist") or {}
            if a.get("handle"):
                self._add_artist(a["handle"], "search", a.get("name"), a.get("img"), a.get("isVerified"),
                                 priority=P_ARTIST_FIRST if a.get("isVerified") else P_SEARCH + 5)
        total = d.get("totalPages") or 0
        self.db.execute(
            "INSERT INTO search_terms (term, pages_fetched, total_pages) VALUES (?,?,?) "
            "ON CONFLICT(term) DO UPDATE SET pages_fetched=excluded.pages_fetched, total_pages=excluded.total_pages",
            (term, page, total))
        if page < total:
            self.push(P_SEARCH + page, "search", term)
