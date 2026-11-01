import "./style.css";
import "@fontsource-variable/unbounded";

import * as api from "./api";
import type { Filters, Mode, Pl8Status, Stats, Track, User } from "./api";
import { Card, type CardActions, cleanTitle, fmtTime } from "./cards";
import { accentForName } from "./color";
import * as heard from "./history";
import { Pager } from "./pager";
import { Player } from "./player";
import { Sheet } from "./sheet";
import { Station } from "./station";
import { type VisualsSetting, Visualizer } from "./visual";

const PREFETCH_AHEAD = 4; // fetch more when this close to the end
const SKIP_SECONDS = 8; // leaving earlier than this counts as a skip
const COMPLETE_RATIO = 0.85;
const DOUBLE_TAP_MS = 300;
const LONG_PRESS_MS = 550; // holding the drop this long rewinds the tune
const PRELOAD_AFTER_MS = 2500; // start buffering the next track once this one has played a bit
const KEEP_BUILT = 3; // cards further than this from the current one drop their elements
const HISTORY_AFTER = 1; // s heard before a track goes into the history
const SLEEP_FADE = 10; // s the sleep timer fades out over
const BPM_RANGE = [60, 200]; // the BPM slider's ends, which mean "no limit"
const FILTERS_KEY = "pl8inf.filters";
const MODE_KEY = "pl8inf.mode";
const HINT_KEY = "pl8inf.hintShown";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const feedEl = $("feed");
const feedStatus = $("feed-status");
const statsEl = $("stats");
const filtersForm = $<HTMLFormElement>("filters");
const filtersBtn = $("filters-btn");
const accountBtn = $("account-btn");
const startEl = $("start");
const toastEl = $("toast");
const loginEl = $("login");
const upNext = $<HTMLButtonElement>("up-next");
const radioEnd = $("radio-end");

const isTouch = !matchMedia("(hover: hover) and (pointer: fine)").matches;

const player = new Player();
const visual = new Visualizer(player, isTouch);

const sheets = {
  filters: new Sheet(filtersForm, filtersBtn),
  likes: new Sheet($("likes"), $("likes-btn")),
  history: new Sheet($("history"), $("history-btn")),
  account: new Sheet($("account"), accountBtn),
  help: new Sheet($("help")),
};

// Installable as an app; see public/sw.js. The dev server has no /sw.js.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((err) => console.warn("no service worker:", err));
}
paintGrain();

const cards: Card[] = [];
let active = -1;
let loading = false;
let feedGen = 0; // bumped when the feed changes, so answers for the old one are dropped
let started = false;
let listened = 0; // seconds actually heard on the active card
let lastTime = 0;
let reported = false; // final event already sent for the active card
let advanced = false; // already mixed into the next track
let remembered = false; // the active card is in the history
let preloadTimer = 0;
let filters: Filters = loadFilters();
let mode: Mode = loadMode();
let stats: Stats | null = null;
let jumpOnLoad = false; // a radio just started: go to its first track as soon as it is here
let radioDry = false; // the artist radio found nothing more; say so on its last card
/// Playing the likes in order (or shuffled) instead of the feed. Null for the feed.
let queue: { tracks: Track[]; next: number } | null = null;

const current = () => cards[active] as Card | undefined;

// Feed ------------------------------------------------------------------

const pager = new Pager(feedEl, {
  count: () => cards.length,
  element: (i) => cards[i].element(),
  onChange: (i) => activate(i),
  onNeedMore: () => loadMore(),
});

function setStatus(text: string): void {
  feedStatus.textContent = text;
  feedStatus.hidden = !text;
}

async function loadMore(): Promise<void> {
  if (loading) return;
  if (queue) {
    fromQueue();
    return;
  }
  loading = true;
  if (!cards.length) setStatus("crawling pl8list, first tracks in a few seconds…");
  const gen = feedGen;
  try {
    const data = await api.feed(filters, mode);
    if (gen !== feedGen) return;
    showStats(data.stats);
    if (!data.tracks.length) {
      jumpOnLoad = false;
      if (mode.mode === "artist") {
        radioDry = true;
        updateRadioEnd();
      } else setStatus(mode.mode !== "classic" || Object.keys(filters).length
        ? "nothing new matches this feed and your filters right now. loosen them, or check back in a bit."
        : "the plate's empty for now, the crawler is still digging. try again in a bit.");
      setTimeout(() => { if (gen === feedGen) loading = false; }, 8000);
      return;
    }
    setStatus("");
    radioDry = false;
    updateRadioEnd();
    const station = mode.mode === "artist" ? mode.name : undefined;
    addCards(data.tracks.map((t) => new Card(t, actions, { station })));
  } catch (err) {
    if (gen !== feedGen) return;
    if (err instanceof api.HttpError && err.status === 401) {
      loading = false;
      showLogin();
      return;
    }
    setStatus(`failed to load: ${(err as Error).message}`);
    setTimeout(() => setStatus(""), 5000);
  }
  loading = false;
}

function addCards(more: Card[]): void {
  cards.push(...more);
  pager.refresh();
  if (active < 0) activate(0);
  else if (jumpOnLoad) go(active + 1);
  jumpOnLoad = false;
  showUpNext();
}

function showStats(s?: Stats): void {
  if (s) stats = s;
  if (stats) statsEl.textContent = `${stats.tracks} tracks · ${stats.artists_crawled}/${stats.artists} artists crawled · ${stats.liked} liked`;
}

let toastTimer = 0;
/// A short note at the bottom; `action` adds a button to it, like "undo".
function toast(text: string, ms = 2200, action?: { label: string; run: () => void }): void {
  toastEl.replaceChildren(text);
  if (action) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = action.label;
    b.addEventListener("click", () => {
      toastEl.classList.remove("show");
      action.run();
    }, { once: true });
    toastEl.append(b);
  }
  toastEl.classList.toggle("has-action", !!action);
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove("show"), action ? Math.max(ms, 5000) : ms);
}

function finishActive(): void {
  const card = current();
  if (!card || reported) return;
  reported = true;
  // Flicking past a card before any audio played says nothing about the track.
  if (listened < 1) return;
  const dur = player.audio.duration || card.track.duration || 0;
  if (dur && listened / dur >= COMPLETE_RATIO) api.sendEvent(card.track, "complete", listened);
  else if (listened < SKIP_SECONDS) api.sendEvent(card.track, "skip", listened);
  else api.sendEvent(card.track, "play", listened);
}

function activate(idx: number): void {
  if (idx === active || !cards[idx]) return;
  finishActive();
  current()?.el?.classList.remove("paused", "buffering", "current");
  active = idx;
  listened = 0;
  lastTime = 0;
  reported = false;
  advanced = false;
  remembered = false;
  const card = cards[idx];
  if (pager.index !== idx) pager.go(idx, { instant: true });
  card.element().classList.add("current");
  visual.attach(card);
  if (started) play(card.track);
  else showStart(card);
  clearTimeout(preloadTimer);
  preloadTimer = window.setTimeout(() => {
    const next = cards[active + 1];
    if (next && started) player.preload(next.track);
  }, PRELOAD_AFTER_MS);
  if (idx >= cards.length - PREFETCH_AHEAD) loadMore();
  updateRadioEnd();
  showUpNext();
  cards.forEach((c, i) => { if (c.el && Math.abs(i - idx) > KEEP_BUILT) c.release(); });
}

function go(idx: number): void {
  if (!pager.go(idx, { instant: document.hidden }) && idx >= cards.length) loadMore();
}

function play(track: Track): void {
  player.play(track);
  updateMediaSession(track);
}

function playbackFailed(): void {
  toast("couldn't play this one, skipping");
  go(active + 1);
}

/// Put `track` right after the current card and go there.
function playNow(track: Track, liked = false): void {
  Sheet.closeAll();
  if (!started) start();
  cards.splice(active + 1, 0, new Card(track, actions, { liked }));
  pager.refresh();
  go(active + 1);
}

// Up next -----------------------------------------------------------------

function showUpNext(): void {
  const next = cards[active + 1];
  upNext.hidden = !next || !started;
  if (!next) return;
  const t = next.track;
  upNext.querySelector(".up-next-title")!.textContent = `${cleanTitle(t.title)} · ${t.artist_name}`;
  const av = upNext.querySelector<HTMLElement>(".up-next-avatar")!;
  const img = api.artistImg(t);
  av.style.backgroundImage = img ? `url("${img}")` : "";
  av.style.backgroundColor = img ? "" : accentForName(t.artist_name || "?");
  av.textContent = img ? "" : (t.artist_name || "?")[0].toUpperCase();
}
upNext.addEventListener("click", () => go(active + 1));

// Card actions ------------------------------------------------------------

const actions: CardActions = {
  like: (c) => setLike(c, !c.liked),
  dislike: (c) => dislike(c),
  share: (c) => share(c),
  next: (c) => go(cards.indexOf(c) + 1),
  follow: (c) => setFollow(c, !c.track.followed),
  radio: (c) => station.open(c.track.handle, c.track.artist_name, api.artistImg(c.track)),
  canSeek: (c) => c === current() && !!player.audio.duration,
  duration: (c) => (c === current() && player.audio.duration) || c.track.duration || 0,
  seek: (_, s) => player.seek(s),
};

function setLike(card: Card, liked: boolean): void {
  if (card.liked === liked) return;
  card.liked = liked;
  card.showLike(true);
  if (stats) { stats.liked += liked ? 1 : -1; showStats(); }
  api.sendEvent(card.track, liked ? "like" : "unlike");
}

function dislike(card: Card): void {
  api.sendEvent(card.track, "dislike");
  if (card === current()) reported = true; // a dislike says more than a skip
  const wasLiked = card.liked;
  if (wasLiked) setLike(card, false);
  go(cards.indexOf(card) + 1);
  toast("skipped, less of this", 5000, {
    label: "undo",
    run: () => {
      api.sendEvent(card.track, "undislike");
      if (wasLiked) setLike(card, true);
      go(cards.indexOf(card));
    },
  });
}

async function setFollow(card: Card, follow: boolean): Promise<void> {
  const { handle, artist_name } = card.track;
  // Every card by this artist changes together.
  const update = (on: boolean) => cards.filter((c) => c.track.handle === handle).forEach((c) => {
    c.track.followed = on;
    c.showFollow();
  });
  update(follow);
  try {
    await api.postJSON("/local/follow", { handle, follow });
    toast(follow ? `following ${artist_name}` : `unfollowed ${artist_name}`);
  } catch (err) {
    update(!follow);
    toast((err as Error).message, 4000);
  }
}

/// Shares a link that opens this app on the track, with pl8list's own link in the text.
async function share(card: Card): Promise<void> {
  const { track } = card;
  const url = api.appTrackUrl(track);
  const title = cleanTitle(track.title);
  if (navigator.share && isTouch) {
    try {
      await navigator.share({ title, text: `${title} by ${track.artist_name} · ${api.trackUrl(track)}`, url });
    } catch { /* dismissed */ }
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    toast("link copied");
  } catch {
    toast(url, 4000);
  }
}

/// The rewind: spin the drop back, slow the tune down, and run it again.
function wheelUp(): void {
  if (!current()) return;
  visual.wheelUp();
  player.wheelUp();
  toast("wheel up!");
}

// Player events -----------------------------------------------------------

player.on("timeupdate", () => {
  const a = player.audio;
  const t = a.currentTime;
  const d = t - lastTime;
  if (d > 0 && d < 1.5) listened += d; // ignore seeks
  lastTime = t;
  const card = current();
  card?.setTime(t);
  updatePosition();
  if (card && !remembered && listened >= HISTORY_AFTER) {
    remembered = true;
    heard.add(card.track);
  }
  // Where tracks can be mixed, start the next one so they overlap by the crossfade.
  const lead = Math.max(1, player.crossfade);
  if (player.mixing && !advanced && !document.hidden && a.duration && a.duration - t < lead && cards[active + 1] && !sleepAtEnd) {
    advanced = true;
    if (!reported) { api.sendEvent(cards[active].track, "complete", listened); reported = true; }
    go(active + 1);
  }
});

player.on("ended", () => {
  const card = current();
  if (card && !reported) {
    api.sendEvent(card.track, "complete", listened);
    reported = true;
  }
  if (sleepAtEnd) {
    sleepAtEnd = false;
    showSleep();
    toast("good night");
    return;
  }
  go(active + 1);
});

player.on("play", () => {
  current()?.el?.classList.remove("paused");
  visual.start();
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
});
player.on("pause", () => {
  if (!player.audio.ended) current()?.el?.classList.add("paused");
  current()?.el?.classList.remove("buffering");
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
});
player.on("waiting", () => current()?.el?.classList.add("buffering"));
player.on("playing", () => current()?.el?.classList.remove("buffering"));
player.on("failed", () => { if (started) playbackFailed(); });

// Lock screen, notification and headphone controls ------------------------

function updateMediaSession(track: Track): void {
  if (!("mediaSession" in navigator)) return;
  const artwork: MediaImage[] = [{ src: "/static/icons/icon-512.png", sizes: "512x512", type: "image/png" }];
  const img = api.artistImg(track);
  if (img) artwork.unshift({ src: img, sizes: "512x512" });
  navigator.mediaSession.metadata = new MediaMetadata({
    title: cleanTitle(track.title),
    artist: track.artist_name,
    album: "pl8list rewind",
    artwork,
  });
}

let lastPositionUpdate = 0;
function updatePosition(): void {
  if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
  const a = player.audio;
  const now = performance.now();
  if (now - lastPositionUpdate < 1000 || !Number.isFinite(a.duration)) return;
  lastPositionUpdate = now;
  try {
    navigator.mediaSession.setPositionState({
      duration: a.duration,
      position: Math.min(a.currentTime, a.duration),
      playbackRate: a.playbackRate || 1,
    });
  } catch { /* duration not known yet */ }
}

if ("mediaSession" in navigator) {
  const a = () => player.audio;
  const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
    ["play", () => player.resume()],
    ["pause", () => player.pause()],
    ["nexttrack", () => go(active + 1)],
    ["previoustrack", () => (a().currentTime > 5 ? player.seek(0) : go(active - 1))],
    ["seekto", (d) => player.seek(d.seekTime ?? 0)],
    ["seekforward", (d) => player.seek(a().currentTime + (d.seekOffset || 10))],
    ["seekbackward", (d) => player.seek(a().currentTime - (d.seekOffset || 10))],
  ];
  for (const [action, fn] of handlers) {
    try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* unsupported action */ }
  }
}

// Tap to play/pause, double-tap to like, hold to rewind ---------------------

let lastTap: { at: number; card: Card | null; toggled: boolean } = { at: 0, card: null, toggled: false };
let press: { timer: number; x: number; y: number } | null = null;
let pressFired = false;

feedEl.addEventListener("pointerdown", (e) => {
  if (!started || !(e.target as Element).closest(".card.current .art")) return;
  pressFired = false;
  press = {
    x: e.clientX,
    y: e.clientY,
    timer: window.setTimeout(() => {
      press = null;
      pressFired = true;
      wheelUp();
    }, LONG_PRESS_MS),
  };
});
const cancelPress = (e: PointerEvent) => {
  if (press && (e.type !== "pointermove" || Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10)) {
    clearTimeout(press.timer);
    press = null;
  }
};
for (const ev of ["pointermove", "pointerup", "pointercancel"]) feedEl.addEventListener(ev, (e) => cancelPress(e as PointerEvent));
// A long press opens the context menu on some phones.
feedEl.addEventListener("contextmenu", (e) => { if ((e.target as Element).closest(".art")) e.preventDefault(); });

feedEl.addEventListener("click", (e) => {
  if (pager.suppressClick) return;
  if (pressFired) { pressFired = false; return; }
  const target = e.target as Element;
  if (target.closest("button, a, input, .wave-wrap")) return;
  const el = target.closest(".card");
  const card = el && cards.find((c) => c.el === el);
  if (!card || !started) return;
  const now = performance.now();

  if (lastTap.card === card && now - lastTap.at < DOUBLE_TAP_MS) {
    // Second tap: undo the play/pause from the first one and like instead.
    if (lastTap.toggled) {
      player.toggle();
      card.clearFlash();
      visual.cancelFlash();
    }
    card.burst(e.clientX, e.clientY);
    setLike(card, true);
    lastTap = { at: 0, card: null, toggled: false };
    return;
  }

  const toggled = card === current();
  if (toggled) {
    player.toggle();
    card.flash(!player.audio.paused);
  }
  lastTap = { at: now, card, toggled };
});

// Any gesture may set up the audio graph; browsers only allow it from one.
for (const ev of ["pointerdown", "keydown"]) document.addEventListener(ev, () => { if (started) player.unlock(); }, true);

// Volume ------------------------------------------------------------------

const volumeEl = $("volume");
const muteBtn = $("mute-btn");
const volumeSlider = $<HTMLInputElement>("volume-slider");

function showVolume(): void {
  const silent = player.muted || player.volume === 0;
  muteBtn.querySelector("use")!.setAttribute("href", silent ? "#i-mute" : "#i-vol");
  muteBtn.setAttribute("aria-pressed", String(player.muted));
  volumeSlider.value = String(player.muted ? 0 : player.volume);
}

function setMuted(m: boolean): void {
  player.muted = m;
  // Unmuting at zero would stay silent.
  if (!m && player.volume === 0) player.volume = 0.5;
  showVolume();
}

function setVolume(v: number): void {
  player.volume = v;
  player.muted = false;
  showVolume();
}

// iOS ignores the volume, see player.ts.
volumeEl.hidden = !player.canMix;
showVolume();
muteBtn.addEventListener("click", () => setMuted(!player.muted));
volumeSlider.addEventListener("input", () => setVolume(Number(volumeSlider.value)));
// Hand the keys back to the feed, or space and the arrows would move the slider.
volumeSlider.addEventListener("change", () => volumeSlider.blur());
volumeSlider.addEventListener("wheel", (e) => {
  e.preventDefault();
  setVolume(player.volume - Math.sign(e.deltaY) * 0.05);
}, { passive: false });

// Start -------------------------------------------------------------------

$("help-close").addEventListener("click", () => sheets.help.close());
for (const id of ["help-open", "help-open-settings"]) $(id).addEventListener("click", () => sheets.help.open());

/// The overlay before the first tap names what will play.
function showStart(card: Card): void {
  const t = card.track;
  startEl.querySelector(".start-track")!.textContent = `${cleanTitle(t.title)} · ${t.artist_name}`;
}

function start(): void {
  if (started) return;
  started = true;
  startEl.hidden = true;
  player.unlock();
  const card = current();
  if (card) activateAgain(card);
  showUpNext();
  if (!localStorage.getItem(HINT_KEY)) {
    localStorage.setItem(HINT_KEY, "1");
    toast(isTouch ? "tap to pause · double-tap to like · hold the drop to rewind"
                  : "click to pause · double-click to like · ? for shortcuts", 5000);
  }
}
startEl.addEventListener("click", start);

/// Start playing the current card after `start()`; activate() did not, as nothing played yet.
function activateAgain(card: Card): void {
  play(card.track);
  clearTimeout(preloadTimer);
  preloadTimer = window.setTimeout(() => {
    const next = cards[active + 1];
    if (next) player.preload(next.track);
  }, PRELOAD_AFTER_MS);
}

// Likes -----------------------------------------------------------------

const likesList = $("likes-list");
const likesSearch = $<HTMLInputElement>("likes-search");
const likesShuffle = $<HTMLInputElement>("likes-shuffle");
let likedTracks: Track[] = [];

/// A row in the likes or history sheet: artwork with a play button, title, artist.
function trackRow(t: Track, sub: string, extra?: HTMLElement): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "track-row";
  const play = document.createElement("button");
  play.type = "button";
  play.className = "row-play";
  play.title = "play now";
  play.setAttribute("aria-label", `play ${cleanTitle(t.title)}`);
  const img = api.artistImg(t);
  if (img) play.style.backgroundImage = `url("${img}")`;
  else play.style.backgroundColor = accentForName(t.artist_name || "?");
  play.innerHTML = '<svg><use href="#i-play"/></svg>';
  play.addEventListener("click", () => playNow(t, likedTracks.some((l) => l.id === t.id)));
  const meta = document.createElement("div");
  meta.className = "meta";
  const a = document.createElement("a");
  a.href = api.trackUrl(t);
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = cleanTitle(t.title);
  const by = document.createElement("span");
  by.textContent = sub;
  meta.append(a, by);
  li.append(play, meta);
  if (extra) li.append(extra);
  return li;
}

const matches = (t: Track, q: string) => !q || `${t.title} ${t.artist_name} ${(t.tags ?? []).join(" ")}`.toLowerCase().includes(q);

function setCardsLiked(id: number, liked: boolean): void {
  for (const c of cards) {
    if (c.track.id !== id) continue;
    c.liked = liked;
    c.showLike();
  }
}

function showLikes(): void {
  const q = likesSearch.value.trim().toLowerCase();
  const shown = likedTracks.filter((t) => matches(t, q));
  likesList.replaceChildren(...shown.map((t) => {
    const unlike = document.createElement("button");
    unlike.type = "button";
    unlike.className = "icon-btn row-unlike";
    unlike.title = "unlike";
    unlike.setAttribute("aria-label", `unlike ${cleanTitle(t.title)}`);
    unlike.innerHTML = '<svg><use href="#i-heart"/></svg>';
    unlike.addEventListener("click", () => {
      api.sendEvent(t, "unlike");
      if (stats) { stats.liked--; showStats(); }
      setCardsLiked(t.id, false);
      const at = likedTracks.indexOf(t);
      likedTracks.splice(at, 1);
      showLikes();
      toast("unliked", 4000, {
        label: "undo",
        run: () => {
          api.sendEvent(t, "like");
          if (stats) { stats.liked++; showStats(); }
          setCardsLiked(t.id, true);
          likedTracks.splice(at, 0, t);
          showLikes();
        },
      });
    });
    const sub = t.artist_name + (t.followed ? " · following" : "") + (t.bpm ? ` · ${Math.round(t.bpm)} bpm` : "");
    return trackRow(t, sub, unlike);
  }));
  if (!likedTracks.length) likesList.textContent = "nothing liked yet. double-tap a track you like.";
  else if (!shown.length) likesList.textContent = "no likes match that.";
  $<HTMLButtonElement>("likes-play").disabled = !shown.length;
}

sheets.likes.onOpen = async () => {
  likesList.textContent = "loading…";
  try {
    ({ tracks: likedTracks } = await api.likes());
  } catch (err) {
    likesList.textContent = `couldn't load your likes: ${(err as Error).message}`;
    return;
  }
  showLikes();
};
likesSearch.addEventListener("input", showLikes);

/// Play the likes shown, in order or shuffled, instead of the feed.
$("likes-play").addEventListener("click", () => {
  const list = likedTracks.filter((t) => matches(t, likesSearch.value.trim().toLowerCase()));
  if (!list.length) return;
  if (likesShuffle.checked) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
  }
  Sheet.closeAll();
  if (!started) start();
  queue = { tracks: list, next: 0 };
  showMode();
  for (const c of cards.splice(active + 1)) c.release();
  feedGen++;
  loading = false;
  jumpOnLoad = true;
  fromQueue();
  toast(`playing ${list.length} like${list.length === 1 ? "" : "s"}${likesShuffle.checked ? ", shuffled" : ""}`);
});

/// The next few tracks of the likes queue as cards.
function fromQueue(): void {
  if (!queue) return;
  const more = queue.tracks.slice(queue.next, queue.next + 5);
  queue.next += more.length;
  if (!more.length) {
    setStatus("that was all of them. tap the chip up top for your feed.");
    return;
  }
  addCards(more.map((t) => new Card(t, actions, { liked: true })));
}

// History ---------------------------------------------------------------

const historyList = $("history-list");

/// `ts` in seconds since the epoch.
function ago(ts: number): string {
  const m = Math.round((Date.now() / 1000 - ts) / 60);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
}

sheets.history.onOpen = () => {
  const list = heard.load();
  historyList.replaceChildren(...list.map((h) => trackRow(h.track, `${h.track.artist_name} · ${ago(h.at / 1000)}`)));
  if (!list.length) historyList.textContent = "nothing played on this device yet.";
};
$("history-clear").addEventListener("click", () => {
  heard.clear();
  historyList.textContent = "cleared.";
});

// Filters and settings --------------------------------------------------

const bpmMin = filtersForm.elements.namedItem("bpm_min") as HTMLInputElement;
const bpmMax = filtersForm.elements.namedItem("bpm_max") as HTMLInputElement;
const bpmOut = $("bpm-out");

function loadFilters(): Filters {
  try {
    return JSON.parse(localStorage.getItem(FILTERS_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function showBpm(): void {
  // The two thumbs never cross.
  if (Number(bpmMin.value) > Number(bpmMax.value)) [bpmMin.value, bpmMax.value] = [bpmMax.value, bpmMin.value];
  const [lo, hi] = [Number(bpmMin.value), Number(bpmMax.value)];
  const anyLo = lo <= BPM_RANGE[0], anyHi = hi >= BPM_RANGE[1];
  bpmOut.textContent = anyLo && anyHi ? "any" : anyLo ? `up to ${hi}` : anyHi ? `${lo} and up` : lo === hi ? `${lo}` : `${lo}–${hi}`;
  const span = BPM_RANGE[1] - BPM_RANGE[0];
  filtersForm.style.setProperty("--lo", `${((lo - BPM_RANGE[0]) / span) * 100}%`);
  filtersForm.style.setProperty("--hi", `${((hi - BPM_RANGE[0]) / span) * 100}%`);
  for (const b of filtersForm.querySelectorAll<HTMLButtonElement>("[data-bpm]")) {
    b.setAttribute("aria-pressed", String(b.dataset.bpm === `${lo}-${hi}`));
  }
}

function showFilters(): void {
  (filtersForm.elements.namedItem("free") as HTMLInputElement).checked = filters.free === "1";
  bpmMin.value = filters.bpm_min || String(BPM_RANGE[0]);
  bpmMax.value = filters.bpm_max || String(BPM_RANGE[1]);
  showBpm();
  filtersBtn.classList.toggle("active", Object.keys(filters).length > 0);
}

function applyFilters(): void {
  filters = {};
  if ((filtersForm.elements.namedItem("free") as HTMLInputElement).checked) filters.free = "1";
  if (Number(bpmMin.value) > BPM_RANGE[0]) filters.bpm_min = bpmMin.value;
  if (Number(bpmMax.value) < BPM_RANGE[1]) filters.bpm_max = bpmMax.value;
  localStorage.setItem(FILTERS_KEY, JSON.stringify(filters));
  showFilters();
  Sheet.closeAll();
  refill();
}

/// Drop cards after the current one so a new filter or mode applies right away.
function refill(): void {
  queue = null;
  for (const c of cards.splice(active + 1)) c.release();
  pager.refresh();
  feedGen++;
  loading = false;
  loadMore();
}

for (const input of [bpmMin, bpmMax]) input.addEventListener("input", showBpm);
for (const b of filtersForm.querySelectorAll<HTMLButtonElement>("[data-bpm]")) {
  b.addEventListener("click", () => {
    [bpmMin.value, bpmMax.value] = b.dataset.bpm!.split("-");
    showBpm();
  });
}

function showSetting(name: string, value: string): void {
  for (const input of filtersForm.querySelectorAll<HTMLInputElement>(`input[name=${name}]`)) input.checked = input.value === value;
}

function setVisuals(v: VisualsSetting): void {
  visual.visuals = v;
  showSetting("visuals", v);
}

filtersForm.addEventListener("change", (e) => {
  const input = e.target as HTMLInputElement;
  if (input.name === "visuals") setVisuals(input.value as VisualsSetting);
  else if (input.name === "crossfade") player.crossfade = Number(input.value);
  else if (input.name === "bass") player.bassBoost = input.checked;
  else if (input.name === "sleep") setSleep(input.value);
});
filtersForm.addEventListener("submit", (e) => { e.preventDefault(); applyFilters(); });
$("filters-clear").addEventListener("click", () => {
  (filtersForm.elements.namedItem("free") as HTMLInputElement).checked = false;
  [bpmMin.value, bpmMax.value] = BPM_RANGE.map(String);
  applyFilters();
});

function showSettings(): void {
  showSetting("visuals", visual.visuals);
  // A saved crossfade that is not one of the choices shows as the nearest one.
  const fades = [...filtersForm.querySelectorAll<HTMLInputElement>("input[name=crossfade]")].map((i) => Number(i.value));
  const fade = fades.reduce((a, b) => (Math.abs(b - player.crossfade) < Math.abs(a - player.crossfade) ? b : a));
  showSetting("crossfade", String(fade));
  const bass = filtersForm.elements.namedItem("bass") as HTMLInputElement;
  bass.checked = player.bassBoost;
  bass.closest("label")!.hidden = !player.canMix;
  showSleep();
}
sheets.filters.onOpen = showSettings;

// Sleep timer -----------------------------------------------------------

let sleepTimer = 0;
let sleepUntil = 0;
let sleepAtEnd = false;
let sleepFade = 0;

function setSleep(value: string): void {
  clearTimeout(sleepTimer);
  cancelAnimationFrame(sleepFade);
  player.dimmed = 1;
  sleepUntil = 0;
  sleepAtEnd = value === "end";
  if (value !== "off" && value !== "end") {
    const ms = Number(value) * 60_000;
    sleepUntil = Date.now() + ms;
    sleepTimer = window.setTimeout(sleepNow, Math.max(0, ms - SLEEP_FADE * 1000));
  }
  showSleep();
  if (value !== "off") toast(value === "end" ? "stopping after this track" : `stopping in ${value} min`);
}

/// Fade out over SLEEP_FADE seconds, then pause.
function sleepNow(): void {
  const stop = () => {
    player.pause();
    player.dimmed = 1;
    sleepUntil = 0;
    showSleep();
  };
  // Hidden tabs get no animation frames: there it stops at once.
  if (document.hidden) {
    stop();
    return;
  }
  const t0 = performance.now();
  const step = () => {
    const k = (performance.now() - t0) / 1000 / SLEEP_FADE;
    player.dimmed = 1 - k;
    if (k < 1) sleepFade = requestAnimationFrame(step);
    else stop();
  };
  sleepFade = requestAnimationFrame(step);
}

function showSleep(): void {
  if (!sleepUntil) showSetting("sleep", sleepAtEnd ? "end" : "off");
  $("sleep-left").textContent = sleepUntil
    ? `${fmtTime(Math.max(0, sleepUntil - Date.now()) / 1000)} left`
    : sleepAtEnd ? "after this track" : "";
}

// Feed modes --------------------------------------------------------------

const modeChip = $("mode-chip");
const modeTabs = $("mode-tabs");
const MODE_NAMES = { classic: "for you", riddim: "riddim", fresh: "fresh", deep: "deep cuts" };

function loadMode(): Mode {
  try {
    const m = JSON.parse(localStorage.getItem(MODE_KEY) || "null");
    if (m?.mode === "artist" ? typeof m.artist === "string" && typeof m.name === "string" : m?.mode in MODE_NAMES) return m;
  } catch { /* fall through */ }
  return { mode: "classic" };
}

const modeName = (m: Mode) => (m.mode === "artist" ? `${m.name} radio` : MODE_NAMES[m.mode]);

function showMode(): void {
  // A radio or the likes queue shows as a chip that leads back; the tabs make way.
  const chip = mode.mode === "artist" || queue !== null;
  modeChip.hidden = !chip;
  modeTabs.hidden = chip;
  for (const b of modeTabs.querySelectorAll<HTMLButtonElement>("button")) {
    b.setAttribute("aria-pressed", String(b.dataset.mode === mode.mode));
  }
  const avatar = modeChip.querySelector<HTMLElement>(".chip-avatar")!;
  const label = modeChip.querySelector(".chip-label")!;
  if (queue) {
    label.textContent = "your likes";
    avatar.style.backgroundImage = "";
    avatar.innerHTML = '<svg><use href="#i-heart"/></svg>';
    return;
  }
  label.textContent = modeName(mode);
  const img = mode.mode === "artist" ? mode.img : null;
  avatar.style.backgroundImage = img ? `url("${img}")` : "";
  avatar.textContent = img || mode.mode !== "artist" ? "" : mode.name[0]?.toUpperCase() ?? "";
}

function setMode(m: Mode): void {
  radioDry = false;
  updateRadioEnd();
  if (JSON.stringify(m) === JSON.stringify(mode) && !queue) return;
  mode = m;
  queue = null;
  localStorage.setItem(MODE_KEY, JSON.stringify(mode));
  showMode();
  Sheet.closeAll();
  toast(m.mode === "classic" ? "back to your feed" : `now playing: ${modeName(m)}`);
  refill();
}

modeChip.addEventListener("click", () => setMode({ mode: "classic" }));
for (const b of modeTabs.querySelectorAll<HTMLButtonElement>("button")) {
  b.addEventListener("click", () => setMode({ mode: b.dataset.mode as "classic" | "riddim" | "fresh" | "deep" }));
}

const station = new Station((m) => {
  if (!started) start();
  jumpOnLoad = true;
  setMode(m);
});

/// On the last card of a radio that has played everything known around its artist.
function updateRadioEnd(): void {
  const m = mode;
  radioEnd.hidden = !(radioDry && m.mode === "artist" && active >= cards.length - 1);
  if (radioEnd.hidden || m.mode !== "artist") return;
  const text = radioEnd.querySelector("p")!;
  const next = $("radio-end-next");
  text.textContent = `that's all around ${m.name} for now. the crawler keeps looking.`;
  // Hand over to the artist playing now, if the radio wandered away from its seed.
  const card = current();
  const other = card && card.track.handle !== m.artist ? card.track : null;
  next.hidden = !other;
  if (other) {
    next.textContent = `${other.artist_name} radio`;
    next.onclick = () => station.open(other.handle, other.artist_name, api.artistImg(other));
  }
}
$("radio-end-feed").addEventListener("click", () => setMode({ mode: "classic" }));

setVisuals(visual.visuals);
showMode();
showFilters();

// Keyboard --------------------------------------------------------------

document.addEventListener("keydown", (e) => {
  if ((e.target as Element).tagName === "INPUT" || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (k === "Escape") {
    setZen(false);
    station.close();
    return;
  }
  if (k === "?") { sheets.help.toggle(); return; }
  if (station.isOpen || Sheet.current || !loginEl.hidden) return;
  if (!started) {
    if (k !== "Tab" && k !== "Shift") { e.preventDefault(); start(); }
    return;
  }
  const card = current();
  const a = player.audio;
  if (k === "ArrowDown" || k === "j" || k === "n") { e.preventDefault(); go(active + 1); }
  else if (k === "ArrowUp" || k === "k") { e.preventDefault(); go(active - 1); }
  else if (k === " ") { e.preventDefault(); player.toggle(); card?.flash(!a.paused); }
  else if (k === "ArrowRight") player.seek(a.currentTime + 10);
  else if (k === "ArrowLeft") player.seek(a.currentTime - 10);
  else if (k === ".") player.seek(a.currentTime + 5);
  else if (k === ",") player.seek(a.currentTime - 5);
  else if (/^[0-9]$/.test(k) && a.duration) player.seek((Number(k) / 10) * a.duration);
  else if (k === "l" && card) setLike(card, !card.liked);
  else if (k === "f" && card) setFollow(card, !card.track.followed);
  else if (k === "r" && card) actions.radio(card);
  else if (k === "x" && card) dislike(card);
  else if (k === "s" && card) share(card);
  else if (k === "w") wheelUp();
  else if (k === "h") sheets.history.open();
  else if (k === "c") sheets.filters.open();
  else if (k === "v") { setVisuals(visual.visuals === "liquid" ? "simple" : "liquid"); toast(`${visual.visuals} visuals`); }
  else if (k === "m") { setMuted(!player.muted); toast(player.muted ? "muted" : "sound on"); }
  else if (k === "+" || k === "=") { setVolume(player.volume + 0.1); toast(`volume ${Math.round(player.volume * 100)}%`); }
  else if (k === "-") { setVolume(player.volume - 0.1); toast(`volume ${Math.round(player.volume * 100)}%`); }
  else if (k === "z") setZen(!document.body.classList.contains("zen"));
});

/// Zen: nothing but the drop and the music.
function setZen(on: boolean): void {
  if (document.body.classList.contains("zen") === on) return;
  document.body.classList.toggle("zen", on);
  if (on) {
    Sheet.closeAll();
    toast("zen · z or esc to leave");
  }
}

addEventListener("resize", () => current()?.drawWave(player.audio.duration ? player.audio.currentTime / player.audio.duration : 0, true));
addEventListener("pagehide", finishActive);

// Sign-in -----------------------------------------------------------------

const emailForm = $<HTMLFormElement>("email-form");
const codeForm = $<HTMLFormElement>("code-form");
const codeInput = $<HTMLInputElement>("code");
const connectInput = $<HTMLInputElement>("connect");
const loginError = $("login-error");
const loginCancel = $("login-cancel");
let signedInUser: User | null = null;

// `resync`: already signed in, signing in again only to sync with pl8list.
function showLogin({ resync = false } = {}): void {
  Sheet.closeAll();
  $("bar").hidden = true;
  startEl.hidden = true;
  upNext.hidden = true;
  loginEl.hidden = false;
  emailForm.hidden = false;
  codeForm.hidden = true;
  loginCancel.hidden = !resync;
  loginError.textContent = resync ? "sign in with pl8list again to sync your library" : "";
  $("email").focus();
}

loginCancel.addEventListener("click", () => { if (signedInUser) signedIn(signedInUser); });

async function withForm(form: HTMLFormElement, fn: () => Promise<void>): Promise<void> {
  const buttons = form.querySelectorAll("button");
  buttons.forEach((b) => { b.disabled = true; });
  loginError.textContent = "";
  try {
    await fn();
  } catch (err) {
    loginError.textContent = (err as Error).message;
  }
  buttons.forEach((b) => { b.disabled = false; });
}

emailForm.addEventListener("submit", (e) => {
  e.preventDefault();
  withForm(emailForm, async () => {
    const { email } = await api.postJSON<{ email: string }>("/auth/start", { email: $<HTMLInputElement>("email").value });
    $("sent-to").textContent = email;
    emailForm.hidden = true;
    codeForm.hidden = false;
    codeInput.value = "";
    codeInput.focus();
  });
});

codeForm.addEventListener("submit", (e) => {
  e.preventDefault();
  withForm(codeForm, async () => {
    const { user, connected } = await api.postJSON<{ user: User; connected: boolean }>("/auth/verify", {
      code: codeInput.value,
      connect: connectInput.checked,
    });
    signedIn(user, { connected, synced_at: Date.now() / 1000 });
    toast(connected ? "connected, syncing your pl8list library…" : "syncing your pl8list library…");
  });
});

codeInput.addEventListener("input", () => {
  if (/^\d{6}$/.test(codeInput.value)) codeForm.requestSubmit();
});

$("resend").addEventListener("click", () => {
  withForm(codeForm, async () => {
    await api.postJSON("/auth/resend");
    loginError.textContent = "new code sent";
  });
});

$("restart").addEventListener("click", () => showLogin());

// Account -----------------------------------------------------------------

const deleteForm = $<HTMLFormElement>("delete-form");
const deleteConfirm = $<HTMLInputElement>("delete-confirm");
const syncStatus = $("sync-status");
const disconnectBtn = $("disconnect-btn");

function showSync(s: Pl8Status | undefined): void {
  const connected = !!s?.connected;
  syncStatus.classList.toggle("on", connected);
  syncStatus.textContent = connected
    ? `connected on this device${s?.synced_at ? `, last sync ${ago(s.synced_at)}` : ""}. ` +
      "Likes and follows are saved to your pl8list library."
    : "not connected. Resync signs you in with pl8list once to read your feed and library.";
  disconnectBtn.hidden = !connected;
}

sheets.account.onOpen = async () => {
  deleteForm.hidden = true;
  try { showSync((await api.me()).pl8list); } catch { /* keep what is shown */ }
};

$("sync-btn").addEventListener("click", async () => {
  try {
    await api.postJSON("/account/pl8list/sync");
    toast("syncing with pl8list…");
    showSync({ connected: true, synced_at: Date.now() / 1000 });
  } catch (err) {
    if (err instanceof api.HttpError && err.status === 409) showLogin({ resync: true });
    else toast((err as Error).message, 4000);
  }
});

disconnectBtn.addEventListener("click", async () => {
  try {
    await api.postJSON("/account/pl8list/disconnect");
    showSync({ connected: false, synced_at: null });
    toast("disconnected from pl8list");
  } catch (err) {
    toast((err as Error).message, 4000);
  }
});

for (const [id, url] of [["logout-btn", "/auth/logout"], ["logout-all-btn", "/account/logout-all"]]) {
  $(id).addEventListener("click", async () => {
    try {
      await api.postJSON(url);
      location.reload();
    } catch (err) {
      toast((err as Error).message, 4000);
    }
  });
}

$("delete-open").addEventListener("click", () => {
  deleteForm.hidden = false;
  deleteConfirm.value = "";
  deleteConfirm.focus();
});

deleteForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api.postJSON("/account/delete", { confirm: deleteConfirm.value.trim() });
    for (const key of [FILTERS_KEY, MODE_KEY, HINT_KEY]) localStorage.removeItem(key);
    heard.clear();
    location.reload();
  } catch (err) {
    toast((err as Error).message, 4000);
  }
});

function signedIn(user: User, pl8list?: Pl8Status): void {
  signedInUser = user;
  if (pl8list) showSync(pl8list);
  loginEl.hidden = true;
  $("bar").hidden = false;
  accountBtn.textContent = (user.name || user.handle)[0]?.toUpperCase() ?? "?";
  accountBtn.style.backgroundColor = accentForName(user.handle);
  accountBtn.title = `@${user.handle}`;
  $("account-handle").textContent = `@${user.handle}`;
  $("delete-handle").textContent = user.handle;
  // Typing the login code counts as a user gesture, so playback may start right away.
  if (navigator.userActivation?.hasBeenActive) start();
  else if (!started) startEl.hidden = false;
  if (!cards.length) openLinkOrFeed();
}

/// The tile of film grain the stylesheet lays under the page's content: faint
/// specks, each a little lighter or darker than what is under it.
function paintGrain(): void {
  const size = 128;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  if (!ctx) return;
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() < 0.5 ? 0 : 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = Math.random() * 30;
  }
  ctx.putImageData(img, 0, 0);
  document.documentElement.style.setProperty("--grain", `url(${c.toDataURL()})`);
}

/// `/?t=handle/slug` opens on that track; the feed carries on after it.
async function openLinkOrFeed(): Promise<void> {
  const link = new URLSearchParams(location.search).get("t")?.split("/");
  if (link?.length === 2) {
    history.replaceState(null, "", location.pathname);
    try {
      const { track } = await api.track(link[0], link[1]);
      addCards([new Card(track, actions)]);
    } catch (err) {
      toast(`couldn't open that link: ${(err as Error).message}`, 4000);
    }
  }
  loadMore();
}

api.me().then(
  (me) => signedIn(me.user, me.pl8list),
  () => showLogin(),
);
