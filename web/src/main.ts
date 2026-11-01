import "./style.css";

import * as api from "./api";
import type { Filters, Mode, Pl8Status, Stats, Track, User } from "./api";
import { Card, type CardActions, cleanTitle } from "./cards";
import { Pager } from "./pager";
import { Player } from "./player";
import { Station } from "./station";
import { type VisualsSetting, Visualizer } from "./visual";

const PREFETCH_AHEAD = 4; // fetch more when this close to the end
const SKIP_SECONDS = 8; // leaving earlier than this counts as a skip
const COMPLETE_RATIO = 0.85;
const DOUBLE_TAP_MS = 300;
const PRELOAD_AFTER_MS = 2500; // start buffering the next track once this one has played a bit
const KEEP_BUILT = 3; // cards further than this from the current one drop their elements
const FILTERS_KEY = "pl8inf.filters";
const MODE_KEY = "pl8inf.mode";
const HINT_KEY = "pl8inf.hintShown";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const feedEl = $("feed");
const feedStatus = $("feed-status");
const statsEl = $("stats");
const filtersForm = $<HTMLFormElement>("filters");
const filtersBtn = $("filters-btn");
const likesPanel = $("likes");
const likesBtn = $("likes-btn");
const accountPanel = $("account");
const accountBtn = $("account-btn");
const startEl = $("start");
const helpEl = $("help");
const toastEl = $("toast");
const loginEl = $("login");

const isTouch = !matchMedia("(hover: hover) and (pointer: fine)").matches;
const radioEnd = $("radio-end");

const player = new Player();
const visual = new Visualizer(player, isTouch);

// Installable as an app; see public/sw.js. The dev server has no /sw.js.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((err) => console.warn("no service worker:", err));
}
const cards: Card[] = [];
let active = -1;
let loading = false;
let feedGen = 0; // bumped when the feed changes, so answers for the old one are dropped
let started = false;
let listened = 0; // seconds actually heard on the active card
let lastTime = 0;
let reported = false; // final event already sent for the active card
let advanced = false; // already mixed into the next track
let preloadTimer = 0;
let filters: Filters = loadFilters();
let mode: Mode = loadMode();
let stats: Stats | null = null;
let jumpOnLoad = false; // a radio just started: go to its first track as soon as it is here
let radioDry = false; // the artist radio found nothing more; say so on its last card

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
    cards.push(...data.tracks.map((t) => new Card(t, actions, { station })));
    pager.refresh();
    if (active < 0) activate(0);
    else if (jumpOnLoad) go(active + 1);
    jumpOnLoad = false;
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

function showStats(s?: Stats): void {
  if (s) stats = s;
  if (stats) statsEl.textContent = `${stats.tracks} tracks · ${stats.artists_crawled}/${stats.artists} artists crawled · ${stats.liked} liked`;
}

let toastTimer = 0;
function toast(text: string, ms = 2200): void {
  toastEl.textContent = text;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove("show"), ms);
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
  const card = cards[idx];
  if (pager.index !== idx) pager.go(idx, { instant: true });
  card.element().classList.add("current");
  visual.attach(card);
  if (started) play(card.track);
  clearTimeout(preloadTimer);
  preloadTimer = window.setTimeout(() => {
    const next = cards[active + 1];
    if (next && started) player.preload(next.track);
  }, PRELOAD_AFTER_MS);
  if (idx >= cards.length - PREFETCH_AHEAD) loadMore();
  updateRadioEnd();
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
  if (card.liked) setLike(card, false);
  toast("got it, less like this");
  go(cards.indexOf(card) + 1);
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

async function share(card: Card): Promise<void> {
  const { track } = card;
  const url = api.trackUrl(track);
  if (navigator.share && isTouch) {
    try {
      await navigator.share({ title: cleanTitle(track.title), text: `${cleanTitle(track.title)} by ${track.artist_name}`, url });
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

// Player events -----------------------------------------------------------

player.on("timeupdate", () => {
  const a = player.audio;
  const t = a.currentTime;
  const d = t - lastTime;
  if (d > 0 && d < 1.5) listened += d; // ignore seeks
  lastTime = t;
  current()?.setTime(t);
  updatePosition();
  // Where tracks can be mixed, start the next one just before this one ends.
  if (player.mixing && !advanced && !document.hidden && a.duration && a.duration - t < 1 && cards[active + 1]) {
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

// Tap to play/pause, double-tap to like ------------------------------------

let lastTap: { at: number; card: Card | null; toggled: boolean } = { at: 0, card: null, toggled: false };
let swallowClick = false; // the tap that only closed a panel

feedEl.addEventListener("click", (e) => {
  if (swallowClick || pager.suppressClick) { swallowClick = false; return; }
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

// Panels and overlays -----------------------------------------------------

const panels: [HTMLElement, HTMLElement][] = [[filtersForm, filtersBtn], [likesPanel, likesBtn], [accountPanel, accountBtn]];

function closePanels(): void {
  for (const [panel, btn] of panels) {
    panel.hidden = true;
    btn.setAttribute("aria-expanded", "false");
  }
}

function togglePanel(panel: HTMLElement): boolean {
  const open = panel.hidden !== false;
  closePanels();
  if (open) {
    panel.hidden = false;
    panels.find(([p]) => p === panel)![1].setAttribute("aria-expanded", "true");
  }
  return open;
}

document.addEventListener("pointerdown", (e) => {
  const open = panels.find(([p]) => !p.hidden);
  const target = e.target as Element;
  if (!open || open[0].contains(target) || target.closest("#bar")) return;
  closePanels();
  swallowClick = true;
  setTimeout(() => { swallowClick = false; }, 500);
}, true);

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

const showHelp = () => { helpEl.hidden = false; };
const hideHelp = () => { helpEl.hidden = true; };
$("help-btn").addEventListener("click", showHelp);
$("help-close").addEventListener("click", hideHelp);
helpEl.addEventListener("click", (e) => { if (e.target === helpEl) hideHelp(); });

function start(): void {
  if (started) return;
  started = true;
  startEl.hidden = true;
  player.unlock();
  const card = current();
  if (card) activateAgain(card);
  if (!localStorage.getItem(HINT_KEY)) {
    localStorage.setItem(HINT_KEY, "1");
    toast(isTouch ? "tap to pause · double-tap to like · swipe up for next"
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

likesBtn.addEventListener("click", async () => {
  if (!togglePanel(likesPanel)) return;
  const list = $("likes-list");
  const { tracks } = await api.likes();
  list.replaceChildren(...tracks.map((t) => {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "play-now";
    btn.title = "play now";
    btn.innerHTML = '<svg><use href="#i-play"/></svg>';
    btn.addEventListener("click", () => {
      closePanels();
      if (!started) start();
      cards.splice(active + 1, 0, new Card(t, actions, { liked: true }));
      pager.refresh();
      go(active + 1);
    });
    const meta = document.createElement("div");
    meta.className = "meta";
    const a = document.createElement("a");
    a.href = api.trackUrl(t);
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = cleanTitle(t.title);
    const by = document.createElement("span");
    by.textContent = t.artist_name + (t.followed ? " · following" : "");
    meta.append(a, by);
    li.append(btn, meta);
    return li;
  }));
  if (!tracks.length) list.textContent = "nothing liked yet. double-tap a track you like.";
});

// Filters ---------------------------------------------------------------

function loadFilters(): Filters {
  try {
    return JSON.parse(localStorage.getItem(FILTERS_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function showFilters(): void {
  const f = filtersForm.elements as unknown as Record<string, HTMLInputElement>;
  f.free.checked = filters.free === "1";
  f.bpm_min.value = filters.bpm_min || "";
  f.bpm_max.value = filters.bpm_max || "";
  filtersBtn.classList.toggle("active", Object.keys(filters).length > 0);
}

function applyFilters(): void {
  const f = new FormData(filtersForm);
  filters = {};
  if (f.get("free")) filters.free = "1";
  if (f.get("bpm_min")) filters.bpm_min = String(f.get("bpm_min"));
  if (f.get("bpm_max")) filters.bpm_max = String(f.get("bpm_max"));
  localStorage.setItem(FILTERS_KEY, JSON.stringify(filters));
  showFilters();
  closePanels();
  refill();
}

/// Drop cards after the current one so a new filter or mode applies right away.
function refill(): void {
  for (const c of cards.splice(active + 1)) c.release();
  pager.refresh();
  feedGen++;
  loading = false;
  loadMore();
}

// Feed modes --------------------------------------------------------------

const modeChip = $("mode-chip");
const MODE_NAMES = { classic: "for you", riddim: "riddim", fresh: "fresh", deep: "deep cuts" };

function loadMode(): Mode {
  try {
    const m = JSON.parse(localStorage.getItem(MODE_KEY) || "null");
    if (m?.mode === "artist" ? typeof m.artist === "string" && typeof m.name === "string" : m?.mode in MODE_NAMES) return m;
  } catch { /* fall through */ }
  return { mode: "classic" };
}

const modeName = (m: Mode) => (m.mode === "artist" ? `${m.name} radio` : MODE_NAMES[m.mode]);

const MODE_ICONS = { riddim: "◆", fresh: "✦", deep: "◎" };

function showMode(): void {
  modeChip.hidden = mode.mode === "classic";
  modeChip.querySelector(".chip-label")!.textContent = modeName(mode);
  const avatar = modeChip.querySelector<HTMLElement>(".chip-avatar")!;
  const img = mode.mode === "artist" ? mode.img : null;
  avatar.style.backgroundImage = img ? `url("${img}")` : "";
  avatar.textContent = img ? "" : mode.mode === "artist" ? mode.name[0]?.toUpperCase() ?? "" : mode.mode === "classic" ? "" : MODE_ICONS[mode.mode];
  for (const input of filtersForm.querySelectorAll<HTMLInputElement>("input[name=mode]")) input.checked = input.value === mode.mode;
}

function setMode(m: Mode): void {
  radioDry = false;
  updateRadioEnd();
  if (JSON.stringify(m) === JSON.stringify(mode)) return;
  mode = m;
  localStorage.setItem(MODE_KEY, JSON.stringify(mode));
  showMode();
  closePanels();
  toast(m.mode === "classic" ? "back to your feed" : `now playing: ${modeName(m)}`);
  refill();
}

modeChip.addEventListener("click", () => setMode({ mode: "classic" }));

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
filtersForm.addEventListener("change", (e) => {
  const input = e.target as HTMLInputElement;
  if (input.name === "mode") setMode({ mode: input.value as "classic" | "riddim" | "fresh" | "deep" });
  if (input.name === "visuals") setVisuals(input.value as VisualsSetting);
});

function setVisuals(v: VisualsSetting): void {
  visual.visuals = v;
  for (const input of filtersForm.querySelectorAll<HTMLInputElement>("input[name=visuals]")) input.checked = input.value === v;
}
setVisuals(visual.visuals);
showMode();

filtersBtn.addEventListener("click", () => togglePanel(filtersForm));
filtersForm.addEventListener("submit", (e) => { e.preventDefault(); applyFilters(); });
$("filters-clear").addEventListener("click", () => {
  filtersForm.reset();
  // reset() also clears the mode and visuals radios, which "clear" leaves alone.
  showMode();
  setVisuals(visual.visuals);
  applyFilters();
});
showFilters();

// Keyboard --------------------------------------------------------------

document.addEventListener("keydown", (e) => {
  if ((e.target as Element).tagName === "INPUT" || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (k === "Escape") {
    closePanels();
    hideHelp();
    station.close();
    return;
  }
  if (station.isOpen) return;
  if (!loginEl.hidden) return;
  if (!started) {
    if (k !== "Tab" && k !== "Shift") { e.preventDefault(); start(); }
    return;
  }
  const card = current();
  const a = player.audio;
  if (k === "ArrowDown" || k === "j") { e.preventDefault(); go(active + 1); }
  else if (k === "ArrowUp" || k === "k") { e.preventDefault(); go(active - 1); }
  else if (k === " ") { e.preventDefault(); player.toggle(); card?.flash(!a.paused); }
  else if (k === "ArrowRight") player.seek(a.currentTime + 10);
  else if (k === "ArrowLeft") player.seek(a.currentTime - 10);
  else if (k === "l" && card) setLike(card, !card.liked);
  else if (k === "f" && card) setFollow(card, !card.track.followed);
  else if (k === "r" && card) actions.radio(card);
  else if (k === "x" && card) dislike(card);
  else if (k === "s" && card) share(card);
  else if (k === "v") { setVisuals(visual.visuals === "liquid" ? "simple" : "liquid"); toast(`${visual.visuals} visuals`); }
  else if (k === "m") { setMuted(!player.muted); toast(player.muted ? "muted" : "sound on"); }
  else if (k === "+" || k === "=") { setVolume(player.volume + 0.1); toast(`volume ${Math.round(player.volume * 100)}%`); }
  else if (k === "-") { setVolume(player.volume - 0.1); toast(`volume ${Math.round(player.volume * 100)}%`); }
  else if (k === "?") { helpEl.hidden ? showHelp() : hideHelp(); }
});

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
  closePanels();
  $("bar").hidden = true;
  startEl.hidden = true;
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

function ago(ts: number): string {
  const m = Math.round((Date.now() / 1000 - ts) / 60);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
}

function showSync(s: Pl8Status | undefined): void {
  const connected = !!s?.connected;
  syncStatus.classList.toggle("on", connected);
  syncStatus.textContent = connected
    ? `connected on this device${s?.synced_at ? `, last sync ${ago(s.synced_at)}` : ""}. ` +
      "Likes and follows are saved to your pl8list library."
    : "not connected. Resync signs you in with pl8list once to read your feed and library.";
  disconnectBtn.hidden = !connected;
}

accountBtn.addEventListener("click", async () => {
  if (!togglePanel(accountPanel)) return;
  deleteForm.hidden = true;
  try { showSync((await api.me()).pl8list); } catch { /* keep what is shown */ }
});

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

$("logout-btn").addEventListener("click", async () => {
  await api.postJSON("/auth/logout");
  location.reload();
});

$("logout-all-btn").addEventListener("click", async () => {
  await api.postJSON("/account/logout-all");
  location.reload();
});

$("delete-open").addEventListener("click", () => {
  deleteForm.hidden = false;
  deleteConfirm.value = "";
  deleteConfirm.focus();
});

deleteForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api.postJSON("/account/delete", { confirm: deleteConfirm.value.trim() });
    localStorage.removeItem(FILTERS_KEY);
    localStorage.removeItem(MODE_KEY);
    localStorage.removeItem(HINT_KEY);
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
  accountBtn.textContent = `@${user.handle}`;
  $("account-handle").textContent = `@${user.handle}`;
  $("delete-handle").textContent = user.handle;
  // Typing the login code counts as a user gesture, so playback may start right away.
  if (navigator.userActivation?.hasBeenActive) start();
  else if (!started) startEl.hidden = false;
  if (!cards.length) loadMore();
}

api.me().then(
  (me) => signedIn(me.user, me.pl8list),
  () => showLogin(),
);
