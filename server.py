"""Infinite-scroll front end for pl8list, with sign-in through pl8list accounts.

    python3 server.py            # then open http://127.0.0.1:8790

Users sign in with their pl8list email: pl8list mails them a code, they type it
here, and this server checks it with pl8list. Afterwards they get a session
cookie for this app only. Their pl8list session is used once to read their
personal feed and is never written to disk.

Configuration comes from the environment (or .env):

    HOST          bind address (default 127.0.0.1)
    PORT          port (default 8790)
    PL8_DB        SQLite path (default ./pl8list.db)
    TRUST_PROXY   1 when behind a reverse proxy: trust X-Forwarded-For/-Proto
"""

import argparse
import collections
import http.cookies
import json
import logging
import os
import re
import secrets
import threading
import time
import urllib.error
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import ranker
from crawler import Crawler
from db import DB, SESSION_DAYS
from pl8list import Client, LoginError, LoginFlow

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
EVENT_KINDS = {"play", "like", "unlike", "skip", "complete"}
# Only HLS playlists and segments are proxied, nothing else on pl8list.
PROXY_RE = re.compile(r"^/api/[^/]+/[^/]+/hls/(playlist\.m3u8|segment/\d+)$")
EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]+\.[^@\s]+$")
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
    ".png": "image/png", ".svg": "image/svg+xml",
}
SESSION_COOKIE = "pl8inf"
LOGIN_COOKIE = "pl8inf_login"
LOGIN_TTL = 900
MAX_BODY = 4096
CSP = "; ".join([
    "default-src 'self'",
    "script-src 'self' https://cdn.jsdelivr.net",
    "style-src 'self'",
    "img-src 'self' data: https://pl8list.com https://files.pl8list.com",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
])

log = logging.getLogger("server")


def load_env(path):
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip("'\""))


class RateLimiter:
    """At most `limit` hits per key within `window` seconds."""

    def __init__(self, limit, window):
        self.limit, self.window = limit, window
        self.hits = collections.defaultdict(collections.deque)
        self.lock = threading.Lock()

    def allow(self, key):
        now = time.time()
        with self.lock:
            q = self.hits[key]
            while q and q[0] < now - self.window:
                q.popleft()
            if len(q) >= self.limit:
                return False
            q.append(now)
            return True


class PendingLogins:
    """Logins waiting for their emailed code, keyed by a random id in a short-lived cookie."""

    def __init__(self):
        self.flows = {}
        self.lock = threading.Lock()

    def add(self, flow):
        flow_id = secrets.token_urlsafe(24)
        with self.lock:
            now = time.time()
            for k in [k for k, f in self.flows.items() if f.created < now - LOGIN_TTL]:
                del self.flows[k]
            flow.created, flow.attempts = now, 0
            self.flows[flow_id] = flow
        return flow_id

    def get(self, flow_id):
        with self.lock:
            flow = self.flows.get(flow_id or "")
            if flow and flow.created < time.time() - LOGIN_TTL:
                del self.flows[flow_id]
                return None
            return flow

    def drop(self, flow_id):
        with self.lock:
            self.flows.pop(flow_id, None)


class Handler(BaseHTTPRequestHandler):
    server_version = "pl8inf"
    sys_version = ""
    db: DB
    client: Client
    crawler: Crawler
    trust_proxy = False
    logins = PendingLogins()
    login_ip_limit = RateLimiter(5, 900)
    login_email_limit = RateLimiter(3, 900)

    def log_message(self, fmt, *args):
        log.debug(fmt, *args)

    def end_headers(self):
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("X-Frame-Options", "DENY")
        super().end_headers()

    # Request helpers ------------------------------------------------------

    def client_ip(self):
        if self.trust_proxy and self.headers.get("X-Forwarded-For"):
            return self.headers["X-Forwarded-For"].split(",")[0].strip()
        return self.client_address[0]

    def is_https(self):
        return self.trust_proxy and self.headers.get("X-Forwarded-Proto") == "https"

    def cookie(self, name):
        jar = http.cookies.SimpleCookie()
        try:
            jar.load(self.headers.get("Cookie") or "")
        except http.cookies.CookieError:
            return None
        return jar[name].value if name in jar else None

    def set_cookie(self, name, value, max_age):
        parts = ["%s=%s" % (name, value), "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=%d" % max_age]
        if self.is_https():
            parts.append("Secure")
        self.send_header("Set-Cookie", "; ".join(parts))

    def current_user(self):
        token = self.cookie(SESSION_COOKIE)
        return self.db.session_user(token) if token else None

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise ValueError("body too large")
        data = json.loads(self.rfile.read(length) or b"{}")
        if not isinstance(data, dict):
            raise ValueError("expected an object")
        return data

    def same_origin(self):
        """Reject cross-site POSTs. Browsers always send Origin on POST."""
        origin = self.headers.get("Origin")
        return not origin or urllib.parse.urlsplit(origin).netloc == self.headers.get("Host")

    def send_json(self, obj, status=200, cookies=()):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for c in cookies:
            self.set_cookie(*c)
        self.end_headers()
        self.wfile.write(body)

    def send_static(self, name):
        path = (STATIC / name).resolve()
        if STATIC not in path.parents or not path.is_file():
            return self.send_error(404)
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", CONTENT_TYPES.get(path.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    # Routing --------------------------------------------------------------

    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        if url.path == "/":
            return self.send_static("index.html")
        if url.path.startswith("/static/"):
            return self.send_static(url.path[len("/static/"):])
        if url.path == "/healthz":
            return self.send_json({"ok": True})
        user = self.current_user()
        if url.path == "/local/me":
            if not user:
                return self.send_json({"error": "not signed in"}, 401)
            return self.send_json({"user": {k: user[k] for k in ("handle", "name", "img")}})
        if not user:
            return self.send_error(401)
        if url.path == "/local/feed":
            return self.feed(user, urllib.parse.parse_qs(url.query))
        if url.path == "/local/likes":
            return self.likes(user)
        if PROXY_RE.match(url.path):
            return self.proxy(url)
        self.send_error(404)

    def do_POST(self):
        if not self.same_origin():
            return self.send_error(403)
        try:
            data = self.read_json()
        except ValueError:
            return self.send_error(400)
        routes = {
            "/auth/start": self.auth_start,
            "/auth/resend": self.auth_resend,
            "/auth/verify": self.auth_verify,
            "/auth/logout": self.auth_logout,
            "/local/event": self.event,
        }
        handler = routes.get(self.path)
        if not handler:
            return self.send_error(404)
        handler(data)

    # Auth -----------------------------------------------------------------

    def auth_start(self, data):
        email = str(data.get("email") or "").strip().lower()
        if len(email) > 254 or not EMAIL_RE.match(email):
            return self.send_json({"error": "enter a valid email"}, 400)
        if not self.login_ip_limit.allow(self.client_ip()) or not self.login_email_limit.allow(email):
            return self.send_json({"error": "too many attempts, wait a few minutes"}, 429)
        flow = LoginFlow(email)
        try:
            flow.start()
        except LoginError as e:
            return self.send_json({"error": str(e)}, 400)
        flow_id = self.logins.add(flow)
        self.send_json({"ok": True, "email": email}, cookies=[(LOGIN_COOKIE, flow_id, LOGIN_TTL)])

    def auth_resend(self, data):
        flow = self.logins.get(self.cookie(LOGIN_COOKIE))
        if not flow:
            return self.send_json({"error": "login expired, start again"}, 400)
        if not self.login_ip_limit.allow(self.client_ip()):
            return self.send_json({"error": "too many attempts, wait a few minutes"}, 429)
        try:
            flow.resend()
        except LoginError as e:
            return self.send_json({"error": str(e)}, 400)
        self.send_json({"ok": True})

    def auth_verify(self, data):
        flow_id = self.cookie(LOGIN_COOKIE)
        flow = self.logins.get(flow_id)
        if not flow:
            return self.send_json({"error": "login expired, start again"}, 400)
        code = str(data.get("code") or "").strip()
        if not re.fullmatch(r"\d{6}", code):
            return self.send_json({"error": "the code has 6 digits"}, 400)
        flow.attempts += 1
        if flow.attempts > 5:
            self.logins.drop(flow_id)
            return self.send_json({"error": "too many wrong codes, start again"}, 429)
        try:
            pl8_user = flow.verify(code)
        except LoginError as e:
            return self.send_json({"error": str(e)}, 400)
        self.logins.drop(flow_id)
        self.db.upsert_user(pl8_user)
        self.crawler.on_login(pl8_user["id"], flow.session)
        token = self.db.create_session(pl8_user["id"])
        log.info("signed in: %s", pl8_user["handle"])
        self.send_json({"user": {"handle": pl8_user["handle"], "name": pl8_user.get("name")}},
                       cookies=[(SESSION_COOKIE, token, SESSION_DAYS * 86400), (LOGIN_COOKIE, "", 0)])

    def auth_logout(self, data):
        token = self.cookie(SESSION_COOKIE)
        if token:
            self.db.delete_session(token)
        self.send_json({"ok": True}, cookies=[(SESSION_COOKIE, "", 0)])

    # App ------------------------------------------------------------------

    def event(self, data):
        user = self.current_user()
        if not user:
            return self.send_error(401)
        try:
            track_id, kind = int(data["track_id"]), data["kind"]
            seconds = float(data["seconds"]) if data.get("seconds") is not None else None
        except (ValueError, KeyError, TypeError):
            return self.send_error(400)
        if kind not in EVENT_KINDS:
            return self.send_error(400)
        self.db.add_event(user["id"], track_id, kind, seconds)
        if kind in ("like", "complete"):
            self.crawler.on_positive(track_id)
        self.send_json({"ok": True})

    def feed(self, user, q):
        def num(name):
            try:
                return float(q[name][0]) if q.get(name, [""])[0] else None
            except ValueError:
                return None

        n = max(1, min(int(num("n") or 10), 30))
        kwargs = dict(free_only=q.get("free", [""])[0] == "1", bpm_min=num("bpm_min"), bpm_max=num("bpm_max"))
        # On a cold start the crawler needs a few seconds before there is anything to serve.
        deadline = time.time() + 20
        tracks = ranker.pick(self.db, user["id"], n, **kwargs)
        while not tracks and time.time() < deadline:
            time.sleep(1.5)
            tracks = ranker.pick(self.db, user["id"], n, **kwargs)
        for t in tracks:
            self.db.add_event(user["id"], t["id"], "served")
        stats = self.db.stats(user["id"])
        stats["liked"] = len(ranker.taste(self.db, user["id"])["liked_ids"])
        self.send_json({"tracks": tracks, "stats": stats})

    def likes(self, user):
        liked = ranker.taste(self.db, user["id"])["liked_ids"]
        rows = self.db.query("SELECT * FROM tracks WHERE id IN (%s)" % ",".join("?" * len(liked)), list(liked)) \
            if liked else []
        self.send_json({"tracks": [ranker.serialize(r) for r in rows]})

    def proxy(self, url):
        # Previews and free tracks stream fine as a guest. Segments redirect to
        # signed storage URLs; urllib follows that server-side.
        try:
            upstream = self.client.request(url.path, urllib.parse.parse_qsl(url.query))
        except urllib.error.HTTPError as e:
            return self.send_error(e.code)
        except OSError:
            return self.send_error(502)
        with upstream:
            self.send_response(200)
            self.send_header("Content-Type", upstream.headers.get("Content-Type", "application/octet-stream"))
            if upstream.headers.get("Content-Length"):
                self.send_header("Content-Length", upstream.headers["Content-Length"])
            self.send_header("Cache-Control", "private, max-age=600")
            self.end_headers()
            try:
                while chunk := upstream.read(64 * 1024):
                    self.wfile.write(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass


def main():
    load_env(ROOT / ".env")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8790")))
    ap.add_argument("--db", default=os.environ.get("PL8_DB", str(ROOT / "pl8list.db")))
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(name)s %(message)s", datefmt="%H:%M:%S")

    db = DB(args.db)
    client = Client()
    crawler = Crawler(client, db)
    crawler.start()

    Handler.db, Handler.client, Handler.crawler = db, client, crawler
    Handler.trust_proxy = os.environ.get("TRUST_PROXY") == "1"
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    log.info("listening on http://%s:%d", args.host, args.port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
