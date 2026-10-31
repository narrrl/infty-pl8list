# pl8list ∞

An endless, TikTok-style scroll through [pl8list](https://pl8list.com), with its own
recommendation algorithm that learns from what you like, finish and skip. Sign in with
your pl8list account; each user gets their own feed and taste profile.

Not affiliated with pl8list.

![Feed on desktop](docs/feed-desktop.png)

<p align="center">
  <img src="docs/feed-mobile.png" width="260" alt="Feed on mobile">
  <img src="docs/login.png" width="520" alt="Sign-in screen">
</p>

| Likes | Filters |
| ----- | ------- |
| ![Likes panel](docs/likes.png) | ![Filters](docs/filters.png) |

## Run

```sh
docker compose up -d --build       # http://127.0.0.1:8790
```

or without Docker (Python 3.11+, no dependencies):

```sh
python3 server.py
```

`compose.override.yaml` puts it behind Traefik at `pl8.narl.io` on the external `narl`
network, the same way as the other narl.io services. Docker Compose picks it up
automatically. Delete it, or change the host name, to run somewhere else.

Data (catalogue, users, listening history) lives in the `data` volume as one SQLite file.

| variable      | default            | meaning                                           |
| ------------- | ------------------ | ------------------------------------------------- |
| `HOST`        | `127.0.0.1`        | bind address (`0.0.0.0` in the image)             |
| `PORT`        | `8790`             | port                                              |
| `PL8_DB`      | `./pl8list.db`     | SQLite path (`/data/pl8list.db` in the image)     |
| `TRUST_PROXY` | `0`                | `1` behind a reverse proxy: use `X-Forwarded-For` for rate limits and `X-Forwarded-Proto` for `Secure` cookies |

## Accounts

There are no passwords here. Users sign in with the email of their pl8list account:

1. The user enters their email. The server starts pl8list's own login, and pl8list mails
   them a 6-digit code.
2. The user types the code. The server passes it to pl8list. If pl8list accepts it, the
   server reads the user's pl8list id and handle, creates a local account, and sets its
   own session cookie (`pl8inf`, HttpOnly, 90 days).

The pl8list session from step 2 is used once, in memory, to read the user's personal pl8list
feed (artists in their library). It is never written to disk. Only a SHA-256 hash of the
local session token is stored. Logins are rate-limited to 5 per IP and 3 per email per
15 minutes, with at most 5 code attempts per login.

## Controls

| phone            | desktop              | action                         |
| ---------------- | -------------------- | ------------------------------ |
| tap              | click · space        | play / pause                   |
| double-tap       | double-click · l     | like                           |
| swipe up / down  | ↓ j · ↑ k            | next / previous                |
| drag waveform    | drag waveform · ← →  | seek                           |
| ✕ button         | x                    | not for me (skip, show less)   |
| share button     | s                    | share / copy link              |
|                  | m                    | mute                           |
|                  | ? · Esc              | help · close panels            |

Lock-screen, notification and headphone buttons control playback too (Media Session API).
"likes" lists your likes newest first; ▶ plays one right away. Filters (free only, BPM range)
are remembered per browser. The site can be installed to the home screen as an app.

## How it works

pl8list has no public API, but it is a Remix app: every page loader returns JSON when you add
`?_data=<route id>`, and `/api/*` routes return JSON directly. Paginated loaders also need
`pagination=true`. All of this works without an account for public data:

| endpoint                                                             | gives                               |
| -------------------------------------------------------------------- | ----------------------------------- |
| `/?_data=routes/_index`                                              | best sellers, recommended, ticker   |
| `/api/feed?page=N&pagination=true`                                   | a user's feed (needs their session) |
| `/api/activity-ticker`                                               | artists with recent downloads/sales |
| `/best-selling-artists?_data=routes/best-selling-artists`            | top artists                         |
| `/search/users?q=…&page=N&pagination=true&_data=routes/search.users` | artist search (≥ 3 chars)           |
| `/<handle>?page=N&pagination=true&_data=routes/$handle`              | an artist's tracks, 10 per page     |
| `/<handle>/<slug>/related?_data=routes/$handle_.$slug.related`       | 3 related tracks                    |
| `/api/<handle>/<slug>/hls/playlist.m3u8?v=<uploadId>[&preview=true]` | HLS audio                           |
| `/login`, `/verify?email=…&mode=login`                               | email + 6-digit code login          |

**Crawler** (`crawler.py`). There is no "all tracks" listing, so one shared catalogue grows by
snowballing: home sections, the ticker, best-selling artists and artist search give artists;
artist pages give tracks; related pages pull in neighbours. Artists are re-checked daily for
new uploads. Requests are throttled to about 1.4 per second while someone has used the app in
the last 30 minutes, or while the catalogue has fewer than 500 tracks. Otherwise it slows to
one request every 20 seconds. When a user likes or finishes a track, its related tracks and
its artist's catalogue are crawled first.

**Ranking** (`ranker.py`). Each track the user has not seen yet gets a score from popularity,
freshness, artist affinity (from their likes, completions, skips and "not for me"), closeness to the BPM and
key of tracks they liked, whether it is related to something they liked, and some random
exploration. Artists are then spread out so you don't get five tracks from one person in a
row. Tune `WEIGHTS` at the top of the file.

**Audio.** The browser only talks to this server. HLS playlists and segments are proxied from
pl8list as a guest, so users hear previews of paid tracks and full free tracks, the same as a
logged-out visitor on pl8list.
