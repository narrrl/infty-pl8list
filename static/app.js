"use strict";

const PL8 = "https://pl8list.com";
const PREFETCH_AHEAD = 4;   // fetch more when this close to the end
const SKIP_SECONDS = 8;     // leaving earlier than this counts as a skip
const COMPLETE_RATIO = 0.85;

const feed = document.getElementById("feed");
const audio = document.getElementById("audio");
const tpl = document.getElementById("card-tpl");
const statsEl = document.getElementById("stats");
const filtersForm = document.getElementById("filters");

const cards = [];          // {track, el, canvas, liked}
let active = -1;
let loading = false;
let started = false;
let hls = null;
let listened = 0;          // seconds actually heard on the active card
let lastTime = 0;
let reported = false;      // final event already sent for the active card
let filters = {};

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
      status.textContent = "nothing new right now, crawler is still digging. scroll again in a bit.";
      setTimeout(() => { status.remove(); loading = false; }, 8000);
      return;
    }
    status.remove();
    data.tracks.forEach(addCard);
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

// Cards -----------------------------------------------------------------

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

function addCard(track) {
  const el = tpl.content.firstElementChild.cloneNode(true);
  const img = track.artist_img ? `url("${PL8}/img/${track.artist_img}")` : "";
  el.querySelector(".bg").style.backgroundImage = img;
  const art = el.querySelector(".art");
  if (img) art.style.backgroundImage = img;
  else art.textContent = (track.artist_name || "?")[0].toUpperCase();

  el.querySelector(".title").textContent = cleanTitle(track.title);
  const artist = el.querySelector(".artist");
  artist.textContent = track.artist_name + (track.artist_verified ? " ✓" : "");
  artist.href = `${PL8}/${track.handle}`;
  el.querySelector(".open").href = `${PL8}/${track.handle}/${track.slug}`;
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

  const card = { track, el, canvas: el.querySelector(".wave"), liked: false };
  const idx = cards.push(card) - 1;

  el.querySelector(".like").addEventListener("click", () => toggleLike(idx));
  el.querySelector(".next").addEventListener("click", () => go(idx + 1));
  card.canvas.addEventListener("click", (e) => {
    if (idx !== active || !audio.duration) return;
    const r = card.canvas.getBoundingClientRect();
    audio.currentTime = ((e.clientX - r.left) / r.width) * audio.duration;
  });

  feed.append(el);
  observer.observe(el);
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

// Playback --------------------------------------------------------------

function streamUrl(t) {
  const p = new URLSearchParams();
  if (t.preview) p.set("preview", "true");
  if (t.upload_id) p.set("v", t.upload_id);
  return `/api/${encodeURIComponent(t.handle)}/${encodeURIComponent(t.slug)}/hls/playlist.m3u8?${p}`;
}

function play(track) {
  const url = streamUrl(track);
  if (window.Hls && Hls.isSupported()) {
    if (hls) hls.destroy();
    hls = new Hls();
    hls.on(Hls.Events.ERROR, (_, d) => {
      if (d.fatal) {
        console.warn("hls fatal", d);
        go(active + 1);
      }
    });
    hls.loadSource(url);
    hls.attachMedia(audio);
  } else {
    audio.src = url; // Safari plays HLS natively
  }
  audio.play().catch(() => {});
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
  active = idx;
  listened = 0;
  lastTime = 0;
  reported = false;
  if (started) play(cards[idx].track);
  if (idx >= cards.length - PREFETCH_AHEAD) loadMore();
}

function go(idx) {
  if (cards[idx]) cards[idx].el.scrollIntoView({ behavior: "smooth" });
  else loadMore();
}

function toggleLike(idx) {
  const card = cards[idx];
  card.liked = !card.liked;
  card.el.querySelector(".like").classList.toggle("on", card.liked);
  if (stats) { stats.liked += card.liked ? 1 : -1; showStats(); }
  sendEvent(card.track, card.liked ? "like" : "unlike");
}

audio.addEventListener("timeupdate", () => {
  const t = audio.currentTime;
  const d = t - lastTime;
  if (d > 0 && d < 1.5) listened += d; // ignore seeks
  lastTime = t;
  const card = cards[active];
  if (card && audio.duration) {
    drawWave(card, t / audio.duration);
    card.el.querySelector(".cur").textContent = fmtTime(t);
  }
});

audio.addEventListener("ended", () => {
  if (active >= 0 && !reported) {
    sendEvent(cards[active].track, "complete", listened);
    reported = true;
  }
  go(active + 1);
});

const observer = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting) activate(cards.findIndex((c) => c.el === e.target));
  }
}, { root: feed, threshold: 0.6 });

// UI --------------------------------------------------------------------

document.querySelector("#start button").addEventListener("click", () => {
  started = true;
  document.getElementById("start").hidden = true;
  if (cards[active]) play(cards[active].track);
});

document.getElementById("filters-btn").addEventListener("click", () => { filtersForm.hidden = !filtersForm.hidden; });

document.getElementById("likes-btn").addEventListener("click", async () => {
  const panel = document.getElementById("likes");
  panel.hidden = !panel.hidden;
  if (panel.hidden) return;
  const list = document.getElementById("likes-list");
  const { tracks } = await (await fetch("/local/likes")).json();
  list.replaceChildren(...tracks.map((t) => {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = `${PL8}/${t.handle}/${t.slug}`;
    a.target = "_blank";
    a.textContent = cleanTitle(t.title);
    const by = document.createElement("span");
    by.textContent = ` · ${t.artist_name}`;
    li.append(a, by);
    return li;
  }));
  if (!tracks.length) list.textContent = "nothing liked yet";
});

filtersForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const f = new FormData(filtersForm);
  filters = {};
  if (f.get("free")) filters.free = "1";
  if (f.get("bpm_min")) filters.bpm_min = f.get("bpm_min");
  if (f.get("bpm_max")) filters.bpm_max = f.get("bpm_max");
  filtersForm.hidden = true;
  // Drop cards below the current one so the new filter applies right away.
  for (const c of cards.splice(active + 1)) { observer.unobserve(c.el); c.el.remove(); }
  loadMore();
});

document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (k === "ArrowDown" || k === "j") { e.preventDefault(); go(active + 1); }
  else if (k === "ArrowUp" || k === "k") { e.preventDefault(); go(active - 1); }
  else if (k === " ") { e.preventDefault(); audio.paused ? audio.play() : audio.pause(); }
  else if (k === "ArrowRight") audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 10);
  else if (k === "ArrowLeft") audio.currentTime = Math.max(0, audio.currentTime - 10);
  else if (k === "l" && active >= 0) toggleLike(active);
});

window.addEventListener("resize", () => cards.forEach((c) => drawWave(c, 0)));
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
  if (!cards.length) loadMore();
}

(async () => {
  const res = await fetch("/local/me");
  if (res.ok) signedIn((await res.json()).user);
  else showLogin();
})();
