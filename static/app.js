"use strict";

const PL8 = "https://pl8list.com";
const PREFETCH_AHEAD = 4;   // fetch more when this close to the end
const SKIP_SECONDS = 8;     // leaving earlier than this counts as a skip
const COMPLETE_RATIO = 0.85;
const DOUBLE_TAP_MS = 300;
const FILTERS_KEY = "pl8inf.filters";
const HINT_KEY = "pl8inf.hintShown";

const feed = document.getElementById("feed");
const audio = document.getElementById("audio");
const tpl = document.getElementById("card-tpl");
const statsEl = document.getElementById("stats");
const filtersForm = document.getElementById("filters");
const filtersBtn = document.getElementById("filters-btn");
const likesPanel = document.getElementById("likes");
const likesBtn = document.getElementById("likes-btn");
const startEl = document.getElementById("start");
const helpEl = document.getElementById("help");
const toastEl = document.getElementById("toast");

const cards = [];          // {track, el, canvas, liked}
let active = -1;
let loading = false;
let started = false;
let hls = null;
let listened = 0;          // seconds actually heard on the active card
let lastTime = 0;
let reported = false;      // final event already sent for the active card
let dragging = false;      // waveform seek in progress
let filters = loadFilters();

const isTouch = !matchMedia("(hover: hover) and (pointer: fine)").matches;

// Server ----------------------------------------------------------------

function sendEvent(track, kind, seconds) {
  const body = JSON.stringify({ track_id: track.id, kind, seconds });
  if (!navigator.sendBeacon("/local/event", new Blob([body], { type: "application/json" }))) {
    fetch("/local/event", { method: "POST", body, headers: { "Content-Type": "application/json" }, keepalive: true });
  }
}

async function loadMore() {
  if (loading) return;
  loading = true;
  const status = document.createElement("div");
  status.className = "status";
  status.textContent = cards.length ? "loading…" : "crawling pl8list, first tracks in a few seconds…";
  feed.append(status);
  try {
    const params = new URLSearchParams({ n: "10", ...filters });
    const res = await fetch("/local/feed?" + params);
    if (res.status === 401) {
      status.remove();
      loading = false;
      showLogin();
      return;
    }
    const data = await res.json();
    showStats(data.stats);
    if (!data.tracks.length) {
      status.textContent = Object.keys(filters).length
        ? "nothing new matches your filters right now. loosen them, or check back in a bit."
        : "nothing new right now, crawler is still digging. scroll again in a bit.";
      setTimeout(() => { status.remove(); loading = false; }, 8000);
      return;
    }
    status.remove();
    data.tracks.forEach((t) => appendCard(buildCard(t)));
  } catch (err) {
    status.textContent = "failed to load: " + err;
    setTimeout(() => status.remove(), 5000);
  }
  loading = false;
}

let stats = null;

function showStats(s) {
  if (s) stats = s;
  if (stats) statsEl.textContent = `${stats.tracks} tracks · ${stats.artists_crawled}/${stats.artists} artists crawled · ${stats.liked} liked`;
}

// Uploads are often titled after their file name.
const cleanTitle = (t) => t.replace(/\.(wav|mp3|flac|aiff?|ogg|m4a)$/i, "");
const trackUrl = (t) => `${PL8}/${t.handle}/${t.slug}`;
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

let toastTimer = 0;
function toast(text, ms = 2200) {
  toastEl.textContent = text;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), ms);
}

// Cards -----------------------------------------------------------------

function buildCard(track, { liked = false } = {}) {
  const el = tpl.content.firstElementChild.cloneNode(true);
  const img = track.artist_img ? `url("${PL8}/img/${track.artist_img}")` : "";
  el.querySelector(".bg").style.backgroundImage = img;
  if (img) el.querySelector(".art").style.backgroundImage = img;
  else el.querySelector(".initial").textContent = (track.artist_name || "?")[0].toUpperCase();

  el.querySelector(".title").textContent = cleanTitle(track.title);
  const artist = el.querySelector(".artist");
  artist.textContent = track.artist_name + (track.artist_verified ? " ✓" : "");
  artist.href = `${PL8}/${track.handle}`;
  el.querySelector(".open").href = trackUrl(track);
  el.querySelector(".desc").textContent = track.description || "";
  el.querySelector(".dur").textContent = track.duration ? fmtTime(track.duration) : "";

  const chips = el.querySelector(".chips");
  const chip = (text, cls) => {
    const s = document.createElement("span");
    s.textContent = text;
    if (cls) s.className = cls;
    chips.append(s);
  };
  if (track.bpm) chip(`${Math.round(track.bpm)} bpm`);
  if (track.key) chip(track.key);
  chip(track.price ? `$${track.price}` : "free", track.price ? "" : "free");
  if (track.preview) chip("preview", "preview");

  el.querySelector(".counts").textContent =
    `${track.saves} saves · ${track.downloads} downloads · ${track.comments} comments` +
    (track.purchases ? ` · ${track.purchases} sold` : "");

  const card = { track, el, canvas: el.querySelector(".wave"), liked };
  el.querySelector(".like").classList.toggle("on", liked);

  el.querySelector(".like").addEventListener("click", () => setLike(card, !card.liked));
  el.querySelector(".dislike").addEventListener("click", () => dislike(card));
  el.querySelector(".share").addEventListener("click", () => share(card));
  el.querySelector(".next").addEventListener("click", () => go(cards.indexOf(card) + 1));
  bindWaveform(card);
  return card;
}

function appendCard(card) {
  cards.push(card);
  feed.append(card.el);
  observer.observe(card.el);
  drawWave(card, 0);
}

function insertNext(card) {
  const ref = cards[active];
  cards.splice(active + 1, 0, card);
  if (ref) ref.el.after(card.el);
  else feed.prepend(card.el);
  observer.observe(card.el);
  drawWave(card, 0);
}

function drawWave(card, progress) {
  const { canvas, track } = card;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w) return;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const data = track.waveform || [];
  const bars = Math.max(1, Math.floor(w / 3));
  const max = Math.max(1, ...data);
  for (let i = 0; i < bars; i++) {
    const v = data.length ? data[Math.floor((i / bars) * data.length)] / max : 0.15;
    const bh = Math.max(2, v * h);
    ctx.fillStyle = i / bars < progress ? "#ff4d6d" : "rgba(255,255,255,0.35)";
    ctx.fillRect(i * 3, (h - bh) / 2, 2, bh);
  }
}

// Drag (or click) the waveform to seek; hovering with a mouse shows the time.
function bindWaveform(card) {
  const { canvas } = card;
  const wrap = canvas.parentElement;
  const tip = wrap.querySelector(".wave-tip");
  const duration = () => (card === cards[active] && audio.duration) || card.track.duration || 0;
  const fraction = (e) => {
    const r = canvas.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };
  const showTip = (f) => {
    tip.textContent = fmtTime(f * duration());
    tip.style.left = `${f * 100}%`;
  };

  canvas.addEventListener("pointerdown", (e) => {
    if (card !== cards[active] || !audio.duration) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    dragging = true;
    wrap.classList.add("hover");
    showTip(fraction(e));
    drawWave(card, fraction(e));
  });
  canvas.addEventListener("pointermove", (e) => {
    if (dragging) drawWave(card, fraction(e));
    if (dragging || e.pointerType === "mouse") {
      wrap.classList.add("hover");
      showTip(fraction(e));
    }
  });
  const finish = (e) => {
    if (!dragging) return;
    dragging = false;
    if (e.type === "pointerup") audio.currentTime = fraction(e) * audio.duration;
    if (e.pointerType !== "mouse") wrap.classList.remove("hover");
  };
  canvas.addEventListener("pointerup", finish);
  canvas.addEventListener("pointercancel", finish);
  canvas.addEventListener("pointerleave", () => { if (!dragging) wrap.classList.remove("hover"); });
}

// Playback --------------------------------------------------------------

function streamUrl(t) {
  const p = new URLSearchParams();
  if (t.preview) p.set("preview", "true");
  if (t.upload_id) p.set("v", t.upload_id);
  return `/api/${encodeURIComponent(t.handle)}/${encodeURIComponent(t.slug)}/hls/playlist.m3u8?${p}`;
}

function playbackFailed() {
  toast("couldn't play this one, skipping");
  go(active + 1);
}

function play(track) {
  const url = streamUrl(track);
  if (window.Hls && Hls.isSupported()) {
    if (hls) hls.destroy();
    hls = new Hls();
    hls.on(Hls.Events.ERROR, (_, d) => {
      if (d.fatal) {
        console.warn("hls fatal", d);
        playbackFailed();
      }
    });
    hls.loadSource(url);
    hls.attachMedia(audio);
  } else {
    audio.src = url; // Safari plays HLS natively
  }
  audio.play().catch(() => {});
  updateMediaSession(track);
}

function togglePlay() {
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
}

function finishActive() {
  if (active < 0 || reported) return;
  reported = true;
  // Flicking past a card before any audio played says nothing about the track.
  if (listened < 1) return;
  const { track } = cards[active];
  const dur = audio.duration || track.duration || 0;
  if (dur && listened / dur >= COMPLETE_RATIO) sendEvent(track, "complete", listened);
  else if (listened < SKIP_SECONDS) sendEvent(track, "skip", listened);
  else sendEvent(track, "play", listened);
}

function activate(idx) {
  if (idx === active || !cards[idx]) return;
  finishActive();
  if (cards[active]) cards[active].el.classList.remove("paused", "buffering");
  active = idx;
  listened = 0;
  lastTime = 0;
  reported = false;
  if (started) play(cards[idx].track);
  if (idx >= cards.length - PREFETCH_AHEAD) loadMore();
}

// Activate directly as well as scrolling: with the screen locked the
// IntersectionObserver may not fire, but lock-screen "next" must still work.
function go(idx) {
  if (idx < 0) return;
  if (!cards[idx]) {
    loadMore();
    return;
  }
  activate(idx);
  cards[idx].el.scrollIntoView({ behavior: document.hidden ? "instant" : "smooth" });
}

function setLike(card, liked) {
  if (card.liked === liked) return;
  card.liked = liked;
  const btn = card.el.querySelector(".like");
  btn.classList.toggle("on", liked);
  if (liked) {
    btn.classList.remove("pop");
    void btn.offsetWidth; // restart the animation
    btn.classList.add("pop");
  }
  if (stats) { stats.liked += liked ? 1 : -1; showStats(); }
  sendEvent(card.track, liked ? "like" : "unlike");
}

function dislike(card) {
  sendEvent(card.track, "dislike");
  if (card === cards[active]) reported = true; // a dislike says more than a skip
  if (card.liked) setLike(card, false);
  toast("got it, less like this");
  go(cards.indexOf(card) + 1);
}

async function share(card) {
  const { track } = card;
  const url = trackUrl(track);
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

audio.addEventListener("timeupdate", () => {
  const t = audio.currentTime;
  const d = t - lastTime;
  if (d > 0 && d < 1.5) listened += d; // ignore seeks
  lastTime = t;
  const card = cards[active];
  if (card && audio.duration) {
    if (!dragging) drawWave(card, t / audio.duration);
    card.el.querySelector(".cur").textContent = fmtTime(t);
  }
  updatePosition();
});

audio.addEventListener("ended", () => {
  if (active >= 0 && !reported) {
    sendEvent(cards[active].track, "complete", listened);
    reported = true;
  }
  go(active + 1);
});

audio.addEventListener("play", () => {
  cards[active]?.el.classList.remove("paused");
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
});
audio.addEventListener("pause", () => {
  if (!audio.ended) cards[active]?.el.classList.add("paused");
  cards[active]?.el.classList.remove("buffering");
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
});
audio.addEventListener("waiting", () => cards[active]?.el.classList.add("buffering"));
audio.addEventListener("playing", () => cards[active]?.el.classList.remove("buffering"));
audio.addEventListener("error", () => { if (!hls && started && audio.src) playbackFailed(); });

const observer = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting) activate(cards.findIndex((c) => c.el === e.target));
  }
}, { root: feed, threshold: 0.6 });

// Lock screen, notification and headphone controls ------------------------

function updateMediaSession(track) {
  if (!("mediaSession" in navigator)) return;
  const artwork = [{ src: "/static/icons/icon-512.png", sizes: "512x512", type: "image/png" }];
  if (track.artist_img) artwork.unshift({ src: `${PL8}/img/${track.artist_img}`, sizes: "512x512" });
  navigator.mediaSession.metadata = new MediaMetadata({
    title: cleanTitle(track.title),
    artist: track.artist_name,
    album: "pl8list ∞",
    artwork,
  });
}

let lastPositionUpdate = 0;
function updatePosition() {
  if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
  const now = performance.now();
  if (now - lastPositionUpdate < 1000 || !Number.isFinite(audio.duration)) return;
  lastPositionUpdate = now;
  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      position: Math.min(audio.currentTime, audio.duration),
      playbackRate: audio.playbackRate || 1,
    });
  } catch { /* duration not known yet */ }
}

if ("mediaSession" in navigator) {
  const handlers = {
    play: () => audio.play().catch(() => {}),
    pause: () => audio.pause(),
    nexttrack: () => go(active + 1),
    previoustrack: () => (audio.currentTime > 5 ? (audio.currentTime = 0) : go(active - 1)),
    seekto: (d) => { audio.currentTime = d.seekTime; },
    seekforward: (d) => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + (d.seekOffset || 10)); },
    seekbackward: (d) => { audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset || 10)); },
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* unsupported action */ }
  }
}

// Tap to play/pause, double-tap to like ------------------------------------

let lastTap = { at: 0, card: null, toggled: false };
let swallowClick = false;  // the tap that only closed a panel

function flash(card, playing) {
  const f = document.createElement("div");
  f.className = "flash";
  f.innerHTML = `<svg><use href="#i-${playing ? "play" : "pause"}"/></svg>`;
  card.el.append(f);
  f.addEventListener("animationend", () => f.remove());
}

function burst(card, e) {
  const r = card.el.getBoundingClientRect();
  const b = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  b.classList.add("burst");
  b.innerHTML = '<use href="#i-heart"/>';
  b.style.left = `${e.clientX - r.left}px`;
  b.style.top = `${e.clientY - r.top}px`;
  b.style.setProperty("--tilt", `${Math.round(Math.random() * 30 - 15)}deg`);
  card.el.append(b);
  b.addEventListener("animationend", () => b.remove());
}

feed.addEventListener("click", (e) => {
  if (swallowClick) { swallowClick = false; return; }
  if (e.target.closest("button, a, input, .wave-wrap")) return;
  const el = e.target.closest(".card");
  const card = el && cards.find((c) => c.el === el);
  if (!card || !started) return;
  const now = performance.now();

  if (lastTap.card === card && now - lastTap.at < DOUBLE_TAP_MS) {
    // Second tap: undo the play/pause from the first one and like instead.
    if (lastTap.toggled) {
      togglePlay();
      el.querySelectorAll(".flash").forEach((f) => f.remove());
    }
    burst(card, e);
    setLike(card, true);
    lastTap = { at: 0, card: null, toggled: false };
    return;
  }

  const toggled = card === cards[active];
  if (toggled) {
    togglePlay();
    flash(card, !audio.paused);
  }
  lastTap = { at: now, card, toggled };
});

// Panels and overlays -----------------------------------------------------

const panels = [[filtersForm, filtersBtn], [likesPanel, likesBtn]];

function closePanels() {
  for (const [panel, btn] of panels) {
    panel.hidden = true;
    btn.setAttribute("aria-expanded", "false");
  }
}

function togglePanel(panel) {
  const open = panel.hidden;
  closePanels();
  if (open) {
    panel.hidden = false;
    panels.find(([p]) => p === panel)[1].setAttribute("aria-expanded", "true");
  }
  return open;
}

document.addEventListener("pointerdown", (e) => {
  const open = panels.find(([p]) => !p.hidden);
  if (!open || open[0].contains(e.target) || e.target.closest("#bar")) return;
  closePanels();
  swallowClick = true;
  setTimeout(() => { swallowClick = false; }, 500);
}, true);

function showHelp() { helpEl.hidden = false; }
function hideHelp() { helpEl.hidden = true; }
document.getElementById("help-btn").addEventListener("click", showHelp);
document.getElementById("help-close").addEventListener("click", hideHelp);
helpEl.addEventListener("click", (e) => { if (e.target === helpEl) hideHelp(); });

function start() {
  if (started) return;
  started = true;
  startEl.hidden = true;
  if (cards[active]) play(cards[active].track);
  if (!localStorage.getItem(HINT_KEY)) {
    localStorage.setItem(HINT_KEY, "1");
    toast(isTouch ? "tap to pause · double-tap to like · swipe up for next"
                  : "click to pause · double-click to like · ? for shortcuts", 5000);
  }
}
startEl.addEventListener("click", start);

// Likes -----------------------------------------------------------------

likesBtn.addEventListener("click", async () => {
  if (!togglePanel(likesPanel)) return;
  const list = document.getElementById("likes-list");
  const { tracks } = await (await fetch("/local/likes")).json();
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
      insertNext(buildCard(t, { liked: true }));
      go(active + 1);
    });
    const meta = document.createElement("div");
    meta.className = "meta";
    const a = document.createElement("a");
    a.href = trackUrl(t);
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = cleanTitle(t.title);
    const by = document.createElement("span");
    by.textContent = t.artist_name;
    meta.append(a, by);
    li.append(btn, meta);
    return li;
  }));
  if (!tracks.length) list.textContent = "nothing liked yet. double-tap a track you like.";
});

// Filters ---------------------------------------------------------------

function loadFilters() {
  try {
    return JSON.parse(localStorage.getItem(FILTERS_KEY)) || {};
  } catch {
    return {};
  }
}

function showFilters() {
  filtersForm.free.checked = filters.free === "1";
  filtersForm.bpm_min.value = filters.bpm_min || "";
  filtersForm.bpm_max.value = filters.bpm_max || "";
  filtersBtn.classList.toggle("active", Object.keys(filters).length > 0);
}

function applyFilters() {
  const f = new FormData(filtersForm);
  filters = {};
  if (f.get("free")) filters.free = "1";
  if (f.get("bpm_min")) filters.bpm_min = f.get("bpm_min");
  if (f.get("bpm_max")) filters.bpm_max = f.get("bpm_max");
  localStorage.setItem(FILTERS_KEY, JSON.stringify(filters));
  showFilters();
  closePanels();
  // Drop cards below the current one so the new filter applies right away.
  for (const c of cards.splice(active + 1)) { observer.unobserve(c.el); c.el.remove(); }
  loadMore();
}

filtersBtn.addEventListener("click", () => togglePanel(filtersForm));
filtersForm.addEventListener("submit", (e) => { e.preventDefault(); applyFilters(); });
document.getElementById("filters-clear").addEventListener("click", () => { filtersForm.reset(); applyFilters(); });
showFilters();

// Keyboard --------------------------------------------------------------

document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (k === "Escape") {
    closePanels();
    hideHelp();
    return;
  }
  if (!loginEl.hidden) return;
  if (!started) {
    if (k !== "Tab" && k !== "Shift") { e.preventDefault(); start(); }
    return;
  }
  const card = cards[active];
  if (k === "ArrowDown" || k === "j") { e.preventDefault(); go(active + 1); }
  else if (k === "ArrowUp" || k === "k") { e.preventDefault(); go(active - 1); }
  else if (k === " ") { e.preventDefault(); togglePlay(); if (card) flash(card, !audio.paused); }
  else if (k === "ArrowRight") audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 10);
  else if (k === "ArrowLeft") audio.currentTime = Math.max(0, audio.currentTime - 10);
  else if (k === "l" && card) setLike(card, !card.liked);
  else if (k === "x" && card) dislike(card);
  else if (k === "s" && card) share(card);
  else if (k === "m") { audio.muted = !audio.muted; toast(audio.muted ? "muted" : "sound on"); }
  else if (k === "?") { helpEl.hidden ? showHelp() : hideHelp(); }
});

window.addEventListener("resize", () => cards.forEach((c, i) =>
  drawWave(c, i === active && audio.duration ? audio.currentTime / audio.duration : 0)));
window.addEventListener("pagehide", finishActive);

// Sign-in -----------------------------------------------------------------

const loginEl = document.getElementById("login");
const emailForm = document.getElementById("email-form");
const codeForm = document.getElementById("code-form");
const loginError = document.getElementById("login-error");

async function postJSON(url, data) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data || {}),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `request failed (${res.status})`);
  return body;
}

function showLogin() {
  document.getElementById("bar").hidden = true;
  startEl.hidden = true;
  loginEl.hidden = false;
  emailForm.hidden = false;
  codeForm.hidden = true;
  document.getElementById("email").focus();
}

async function withForm(form, fn) {
  const buttons = form.querySelectorAll("button");
  buttons.forEach((b) => { b.disabled = true; });
  loginError.textContent = "";
  try {
    await fn();
  } catch (err) {
    loginError.textContent = err.message;
  }
  buttons.forEach((b) => { b.disabled = false; });
}

emailForm.addEventListener("submit", (e) => {
  e.preventDefault();
  withForm(emailForm, async () => {
    const { email } = await postJSON("/auth/start", { email: emailForm.email.value });
    document.getElementById("sent-to").textContent = email;
    emailForm.hidden = true;
    codeForm.hidden = false;
    codeForm.code.value = "";
    codeForm.code.focus();
  });
});

codeForm.addEventListener("submit", (e) => {
  e.preventDefault();
  withForm(codeForm, async () => {
    const { user } = await postJSON("/auth/verify", { code: codeForm.code.value });
    signedIn(user);
  });
});

codeForm.code.addEventListener("input", () => {
  if (/^\d{6}$/.test(codeForm.code.value)) codeForm.requestSubmit();
});

document.getElementById("resend").addEventListener("click", () => {
  withForm(codeForm, async () => {
    await postJSON("/auth/resend");
    loginError.textContent = "new code sent";
  });
});

document.getElementById("restart").addEventListener("click", showLogin);

document.getElementById("logout-btn").addEventListener("click", async () => {
  await postJSON("/auth/logout");
  location.reload();
});

function signedIn(user) {
  loginEl.hidden = true;
  document.getElementById("bar").hidden = false;
  document.getElementById("logout-btn").textContent = `sign out @${user.handle}`;
  // Typing the login code counts as a user gesture, so playback may start right away.
  if (navigator.userActivation?.hasBeenActive) start();
  else if (!started) startEl.hidden = false;
  if (!cards.length) loadMore();
}

(async () => {
  const res = await fetch("/local/me");
  if (res.ok) signedIn((await res.json()).user);
  else showLogin();
})();
