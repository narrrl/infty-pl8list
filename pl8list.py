"""Thin client for pl8list.com.

pl8list is a Remix app, so every page loader can be read as JSON by adding
`?_data=<route id>` to the page URL. Resource routes under /api/ return JSON
directly. All clients share one throttle so we stay polite.

Public data (artist pages, related tracks, previews, free tracks) works without
an account, so the crawler runs as a guest. A user's own session is only needed
for login and for reading their personal feed.
"""

import base64
import json
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://pl8list.com"
USER_AGENT = "pl8list-wrapper/0.2 (infinite-scroll client, https://pl8.narl.io)"

_throttle_lock = threading.Lock()
_throttle_last = 0.0


def _throttle(min_interval):
    global _throttle_last
    with _throttle_lock:
        wait = _throttle_last + min_interval - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        _throttle_last = time.monotonic()


class Client:
    def __init__(self, session_cookie=None, min_interval=0.7):
        self.session_cookie = session_cookie
        self.min_interval = min_interval

    def request(self, path, params=None, headers=None):
        """Raw request. Returns the open response; caller must close it."""
        url = BASE + path
        if params:
            url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
        h = {"User-Agent": USER_AGENT, **(headers or {})}
        if self.session_cookie:
            h["Cookie"] = "_session=" + self.session_cookie
        return urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=30)

    def get_json(self, path, params=None, route=None):
        params = dict(params or {})
        if route:
            params["_data"] = route
        for attempt in range(4):
            _throttle(self.min_interval)
            try:
                with self.request(path, params) as r:
                    body = r.read()
                    return json.loads(body) if body else None
            except urllib.error.HTTPError as e:
                if e.code in (429, 502, 503, 504) and attempt < 3:
                    time.sleep(2 ** attempt * 3)
                    continue
                if e.code in (403, 404):
                    return None
                raise
        return None

    # Loaders -------------------------------------------------------------

    def root(self):
        return self.get_json("/", route="root")

    def home(self):
        return self.get_json("/", route="routes/_index")

    # Paginated loaders ignore `page` unless `pagination=true` is also set,
    # which is what the site's own useInfiniteLoading hook sends.

    def feed(self, page=1):
        return self.get_json("/api/feed", {"page": page, "pagination": "true"})

    def artist(self, handle, page=1):
        return self.get_json("/" + urllib.parse.quote(handle), {"page": page, "pagination": "true"},
                             route="routes/$handle")

    def related(self, handle, slug):
        path = "/%s/%s/related" % (urllib.parse.quote(handle), urllib.parse.quote(slug))
        return self.get_json(path, route="routes/$handle_.$slug.related")

    def best_selling_artists(self):
        return self.get_json("/best-selling-artists", route="routes/best-selling-artists")

    def activity_ticker(self):
        return self.get_json("/api/activity-ticker")

    def search_users(self, q, page=1):
        return self.get_json("/search/users", {"q": q, "page": page, "pagination": "true"},
                             route="routes/search.users")

    def logout(self):
        """End this session at pl8list. Errors are ignored: we drop the session either way."""
        try:
            self.request("/logout", {"_data": "routes/logout"}).close()
        except OSError:
            pass


class LoginError(Exception):
    pass


class LoginFlow:
    """pl8list's passwordless login: POST email, pl8list mails a 6-digit code, POST code.

    The site keeps the pending login in its `_session` cookie, so one flow object
    holds that cookie between the two steps. After `verify` succeeds,
    `self.session` is the user's logged-in pl8list session.
    """

    def __init__(self, email):
        self.email = email
        self.session = None

    def _call(self, method, path, route, fields=None):
        url = BASE + path + ("&" if "?" in path else "?") + urllib.parse.urlencode({"_data": route})
        headers = {"User-Agent": USER_AGENT}
        if self.session:
            headers["Cookie"] = "_session=" + self.session
        data = None
        if fields is not None:
            data = urllib.parse.urlencode(fields).encode()
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            resp = urllib.request.urlopen(req, timeout=30)
        except urllib.error.HTTPError as e:
            resp = e
        except OSError as e:
            raise LoginError("pl8list unreachable: %s" % e) from e
        with resp:
            for c in resp.headers.get_all("Set-Cookie") or []:
                m = re.match(r"_session=([^;]+)", c)
                if m:
                    self.session = m.group(1)
            body = resp.read()
            status = resp.status if hasattr(resp, "status") else resp.code
            try:
                payload = json.loads(body) if body else None
            except ValueError:
                payload = None
            return status, resp.headers, payload

    def _guest_id(self):
        """The guest id pl8list stores in its cookie; the login forms echo it back."""
        try:
            raw = urllib.parse.unquote(self.session).split(".")[0]
            return json.loads(base64.b64decode(raw + "=" * (-len(raw) % 4))).get("pl8list_guest_id", "")
        except (ValueError, AttributeError, TypeError):
            return ""

    def _verify_path(self):
        return "/verify?" + urllib.parse.urlencode({"email": self.email, "mode": "login"})

    def start(self):
        """Ask pl8list to mail a login code."""
        self._call("GET", "/login", "routes/login")
        status, headers, payload = self._call("POST", "/login", "routes/login",
                                              {"email": self.email, "pl8list_guest_id": self._guest_id()})
        if "/verify" not in (headers.get("X-Remix-Redirect") or ""):
            raise LoginError((payload or {}).get("error") or "pl8list refused the login (HTTP %d)" % status)

    def resend(self):
        _, _, payload = self._call("POST", self._verify_path(), "routes/verify",
                                   {"action": "resend", "pl8list_guest_id": self._guest_id()})
        if payload and payload.get("resendError"):
            raise LoginError(payload["resendError"])

    def verify(self, code):
        """Submit the code. Returns pl8list's currentUser for the new session."""
        _, _, payload = self._call("POST", self._verify_path(), "routes/verify",
                                   {"action": "verify", "code": code, "pl8list_guest_id": self._guest_id()})
        if payload and payload.get("error"):
            raise LoginError(payload["error"])
        user = (Client(self.session).root() or {}).get("currentUser")
        if not user:
            raise LoginError("login failed, try again")
        if not user.get("handle"):
            Client(self.session).logout()
            self.session = None
            raise LoginError("finish setting up your account on pl8list.com first (choose a handle)")
        return user


def normalize_item(item):
    """Flatten a loader track item ({track, hasFullAccess, saveCount, ...}) into a DB row."""
    return normalize_track(item["track"], {
        "full_access": item.get("hasFullAccess"),
        "saves": item.get("saveCount"),
        "downloads": item.get("downloadCount"),
        "purchases": item.get("purchaseCount"),
        "comments": item.get("commentCount"),
    })


def normalize_related(data):
    """The related loader returns bare tracks plus per-id maps for access and counts."""
    counts = data.get("counts") or {}
    access = data.get("access") or {}
    rows = []
    for t in data.get("tracks") or []:
        k = str(t["id"])
        rows.append(normalize_track(t, {
            "full_access": access.get(k),
            "saves": (counts.get("saveCount") or {}).get(k),
            "downloads": (counts.get("downloadCount") or {}).get(k),
            "purchases": (counts.get("purchaseCount") or {}).get(k),
            "comments": (counts.get("commentCount") or {}).get(k),
        }))
    return [r for r in rows if r]


def normalize_track(t, extra):
    user = t.get("user") or {}
    if not user.get("handle") or t.get("isDeleted") or not t.get("isPublic", True):
        return None
    return {
        "id": t["id"],
        "handle": user["handle"],
        "artist_name": user.get("name") or user["handle"],
        "artist_img": user.get("img"),
        "artist_verified": int(bool(user.get("isVerified"))),
        "slug": t["slug"],
        "title": t.get("title") or t.get("filename") or t["slug"],
        "description": t.get("description"),
        "bpm": t.get("bpm"),
        "key": t.get("key"),
        "duration": t.get("duration"),
        "preview_duration": t.get("previewDuration"),
        "price": t.get("price") or 0,
        "created_at": t.get("createdAt"),
        "upload_id": t.get("uploadId"),
        "preview_upload_id": t.get("previewUploadId"),
        "waveform": json.dumps(t.get("waveform")) if t.get("waveform") else None,
        "preview_waveform": json.dumps(t.get("previewWaveform")) if t.get("previewWaveform") else None,
        "full_access": int(bool(extra.get("full_access"))),
        "saves": extra.get("saves") or 0,
        "downloads": extra.get("downloads") or 0,
        "purchases": extra.get("purchases") or 0,
        "comments": extra.get("comments") or 0,
    }
