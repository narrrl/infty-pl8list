"""Pick the next batch of tracks for the scroll feed.

Each unserved playable track gets a score:

    popularity   log-scaled saves/downloads/purchases/comments, normalised to 0..1
    freshness    exp(-age / 21 days)
    artist       learned from your events on that artist's tracks (likes, full listens, skips)
    tempo / key  closeness to the BPM and key of tracks you liked or finished
    related      track came from the "related" page of something you liked
    exploration  Gumbel noise, so the feed never freezes into one niche

The batch is then picked greedily with a penalty for repeating an artist.
"""

import datetime
import json
import math
import random
from collections import defaultdict

WEIGHTS = {
    "popularity": 1.2,
    "freshness": 0.8,
    "artist": 1.5,
    "tempo": 1.0,
    "key": 0.3,
    "related": 1.0,
    "unknown_artist": 0.2,
    "exploration": 0.6,
}
# Per-event contributions to artist affinity.
EVENT_SIGNAL = {"like": 3.0, "unlike": -3.0, "complete": 1.5, "skip": -1.0}
REPEAT_ARTIST_PENALTY = 1.5
RECENT_ARTIST_WINDOW = 6


def _age_days(iso):
    if not iso:
        return 365.0
    try:
        t = datetime.datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return 365.0
    return max(0.0, (datetime.datetime.now(datetime.timezone.utc) - t).total_seconds() / 86400)


def _tempo_match(bpm, liked_bpms):
    """Gaussian closeness to any liked tempo, also counting half/double time as a match."""
    if not bpm or not liked_bpms:
        return 0.0
    best = 0.0
    for b in liked_bpms:
        d = min(abs(bpm - b), abs(bpm * 2 - b), abs(bpm / 2 - b))
        best = max(best, math.exp(-((d / 6.0) ** 2)))
    return best


def taste(db, user_id):
    """Summarise a user's listening history into artist affinity, liked tempos/keys and liked track ids."""
    rows = db.query("""
        SELECT e.track_id, e.kind, e.seconds, t.handle, t.bpm, t.key
        FROM events e JOIN tracks t ON t.id = e.track_id
        WHERE e.user_id = ? AND e.kind IN ('like', 'unlike', 'complete', 'skip')
        ORDER BY e.ts
    """, (user_id,))
    artist = defaultdict(float)
    liked = {}
    completed = {}
    for r in rows:
        artist[r["handle"]] += EVENT_SIGNAL[r["kind"]]
        if r["kind"] == "like":
            liked[r["track_id"]] = r
        elif r["kind"] == "unlike":
            liked.pop(r["track_id"], None)
        elif r["kind"] == "complete":
            completed[r["track_id"]] = r
    positive = {**completed, **liked}
    return {
        "artist": {h: math.tanh(v / 4.0) for h, v in artist.items()},
        "bpms": [r["bpm"] for r in positive.values() if r["bpm"]][-50:],
        "keys": {r["key"] for r in positive.values() if r["key"]},
        "positive_ids": set(positive),
        "liked_ids": set(liked),
    }


def pick(db, user_id, n=10, free_only=False, bpm_min=None, bpm_max=None):
    where = ["(t.full_access=1 OR t.preview_upload_id IS NOT NULL)",
             "NOT EXISTS (SELECT 1 FROM events e WHERE e.user_id=? AND e.kind='served' AND e.track_id=t.id)"]
    args = [user_id]
    if free_only:
        where.append("t.price = 0")
    if bpm_min is not None:
        where.append("t.bpm >= ?")
        args.append(bpm_min)
    if bpm_max is not None:
        where.append("t.bpm <= ?")
        args.append(bpm_max)
    cands = db.query("SELECT * FROM tracks t WHERE " + " AND ".join(where), args)
    if not cands:
        return []

    t = taste(db, user_id)
    recent = [r["handle"] for r in db.query("""
        SELECT t.handle FROM events e JOIN tracks t ON t.id=e.track_id
        WHERE e.user_id=? AND e.kind='served' ORDER BY e.ts DESC LIMIT ?
    """, (user_id, RECENT_ARTIST_WINDOW))]

    def pop_raw(r):
        return (math.log1p(r["saves"]) + 0.7 * math.log1p(r["downloads"])
                + 1.0 * math.log1p(r["purchases"]) + 0.5 * math.log1p(r["comments"]))

    max_pop = max(pop_raw(r) for r in cands) or 1.0
    w = WEIGHTS
    scored = []
    for r in cands:
        aff = t["artist"].get(r["handle"])
        s = (w["popularity"] * pop_raw(r) / max_pop
             + w["freshness"] * math.exp(-_age_days(r["created_at"]) / 21.0)
             + w["artist"] * (aff or 0.0)
             + w["tempo"] * _tempo_match(r["bpm"], t["bpms"])
             + w["key"] * (1.0 if r["key"] in t["keys"] else 0.0)
             + w["related"] * (1.0 if r["related_of"] in t["positive_ids"] else 0.0)
             + w["unknown_artist"] * (1.0 if aff is None else 0.0)
             + w["exploration"] * -math.log(-math.log(random.random() or 1e-12)))
        scored.append([s, r])

    out = []
    seen_artists = list(recent)
    scored.sort(key=lambda x: -x[0])
    pool = scored[: max(n * 8, 60)]
    while pool and len(out) < n:
        best_i = max(range(len(pool)),
                     key=lambda i: pool[i][0] - REPEAT_ARTIST_PENALTY * seen_artists.count(pool[i][1]["handle"]))
        s, r = pool.pop(best_i)
        out.append(serialize(r, s))
        seen_artists.append(r["handle"])
    return out


def serialize(r, score=None):
    preview = not r["full_access"]
    wave = r["preview_waveform"] if preview and r["preview_waveform"] else r["waveform"]
    return {
        "id": r["id"],
        "handle": r["handle"],
        "slug": r["slug"],
        "title": r["title"],
        "description": r["description"],
        "artist_name": r["artist_name"],
        "artist_img": r["artist_img"],
        "artist_verified": bool(r["artist_verified"]),
        "bpm": r["bpm"],
        "key": r["key"],
        "duration": r["preview_duration"] if preview and r["preview_duration"] else r["duration"],
        "price": r["price"],
        "created_at": r["created_at"],
        "saves": r["saves"],
        "downloads": r["downloads"],
        "purchases": r["purchases"],
        "comments": r["comments"],
        "preview": preview,
        "upload_id": r["preview_upload_id"] if preview else r["upload_id"],
        "waveform": json.loads(wave) if wave else None,
        "score": round(score, 3) if score is not None else None,
    }
