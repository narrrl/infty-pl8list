// One card per track. Elements are built when a card first comes near the screen
// and dropped again once it is far behind, so a long session stays light.

import { type Track, artistImg, artistUrl, comments, trackUrl } from "./api";
import { accentFor, accentForName, backdrop } from "./color";
import { WaveComments } from "./comments";

export interface CardActions {
  like(card: Card): void;
  dislike(card: Card): void;
  share(card: Card): void;
  next(card: Card): void;
  follow(card: Card): void;
  radio(card: Card): void;
  /// Seeking only works on the playing card.
  canSeek(card: Card): boolean;
  duration(card: Card): number;
  seek(card: Card, seconds: number): void;
  /// Jump to the next drop of the playing card.
  toDrop(card: Card): void;
}

// Uploads are often titled after their file name.
export const cleanTitle = (t: string) => t.replace(/\.(wav|mp3|flac|aiff?|ogg|m4a)$/i, "");
export const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
/// 1234 → "1.2k", as counts under the action buttons.
export const compact = (n: number) =>
  n < 1000 ? String(n) : n < 10000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : `${Math.round(n / 1000)}k`;
const NEW_DAYS = 7; // uploads younger than this get a "new" chip
const BAR = 3; // px per waveform bar, gap included
const MIRROR = 0.28; // share of the waveform's height its reflection takes
// Drops from the waveform: the level over a short window jumping well above the
// window before it, and loud. Tuned on riddim and dubstep, where the drop is the
// loudest, densest part and the build before it thins out.
const DROP_WINDOW = 0.035; // of the track, on each side of a drop
const DROP_RISE = 0.22; // the window after is this much louder (0..1 of the peak) …
const DROP_LOUD = 0.55; // … and at least this loud
const DROP_SKIP = 0.06; // no drop in the first bit: that is the track starting
const DROP_APART = 0.12; // of the track between two drops
const MAX_DROPS = 3;

/// Where the drops are, 0..1 of the track, from its waveform.
export function findDrops(data: number[] | null | undefined): number[] {
  if (!data || data.length < 40) return [];
  const max = Math.max(1, ...data);
  const v = data.map((x) => x / max);
  const n = v.length;
  const w = Math.max(2, Math.round(n * DROP_WINDOW));
  const sum = [0];
  for (const x of v) sum.push(sum[sum.length - 1] + x);
  const mean = (a: number, b: number) => (sum[b] - sum[a]) / (b - a);
  const cands: { at: number; rise: number }[] = [];
  for (let i = Math.max(w, Math.round(n * DROP_SKIP)); i <= n - w; i++) {
    const after = mean(i, i + w), before = mean(i - w, i);
    if (after - before >= DROP_RISE && after >= DROP_LOUD) cands.push({ at: i, rise: after - before });
  }
  cands.sort((a, b) => b.rise - a.rise);
  const out: number[] = [];
  for (const c of cands) {
    if (out.length >= MAX_DROPS) break;
    if (out.every((o) => Math.abs(o - c.at) >= n * DROP_APART)) out.push(c.at);
  }
  return out.sort((a, b) => a - b).map((i) => i / n);
}

const tpl = document.getElementById("card-tpl") as HTMLTemplateElement;

export class Card {
  el: HTMLElement | null = null;
  liked: boolean;
  private canvas: HTMLCanvasElement | null = null;
  private drawn = "";
  private dragging = false;
  private accent: string | null = null;
  /// The blurred background, once made.
  private backdrop: string | null = null;

  /// `station`: the artist radio this card was picked for, if any.
  constructor(
    readonly track: Track,
    private actions: CardActions,
    { liked = false, station = undefined as string | undefined } = {},
  ) {
    this.liked = liked;
    this.station = station;
    this.drops = findDrops(track.waveform);
  }

  private station: string | undefined;
  /// Drops in the waveform, 0..1 of the track.
  readonly drops: number[];
  /// Its timed comments, once asked for.
  private comments: WaveComments | null = null;
  private commentsAsked = false;

  /// Fetch the timed comments, once. Previews have none: their moments are those
  /// of the full track.
  loadComments(): void {
    if (this.commentsAsked || this.track.preview || !this.track.comments) return;
    this.commentsAsked = true;
    comments(this.track.id).then(({ comments: list }) => {
      if (!list.length) return;
      this.comments = new WaveComments(list, () => this.actions.duration(this));
      const wrap = this.canvas?.parentElement;
      if (wrap) this.comments.mount(wrap);
    }, () => { this.commentsAsked = false; });
  }

  /// Playback of this card is at `seconds`.
  commentsAt(seconds: number): void {
    this.comments?.tick(seconds);
  }

  element(): HTMLElement {
    return this.el ?? this.build();
  }

  /// Forget the element; it is built again if the card comes back.
  release(): void {
    this.el?.remove();
    this.comments?.unmount();
    this.el = this.canvas = null;
    this.drawn = "";
  }

  private build(): HTMLElement {
    const t = this.track;
    const el = tpl.content.firstElementChild!.cloneNode(true) as HTMLElement;
    const $ = <T extends HTMLElement>(sel: string) => el.querySelector(sel) as T;
    const img = artistImg(t);
    if (img) {
      const bg = $(".bg");
      if (this.backdrop) this.showBackdrop(bg);
      else {
        // The plain image under a CSS blur until the blurred one is ready.
        bg.style.backgroundImage = `url("${img}")`;
        backdrop(img).then((b) => {
          this.backdrop = b;
          const bg = this.el?.querySelector<HTMLElement>(".bg");
          if (b && bg) this.showBackdrop(bg);
        }, () => {});
      }
      $(".art").style.backgroundImage = `url("${img}")`;
      $(".artist-avatar").style.backgroundImage = `url("${img}")`;
      if (this.accent) el.style.setProperty("--card-accent", this.accent);
      else accentFor(img).then((c) => {
        this.accent = c;
        if (c && this.el) {
          this.el.style.setProperty("--card-accent", c);
          this.drawWave(this.lastProgress, true);
        }
      });
    } else {
      $(".initial").textContent = (t.artist_name || "?")[0].toUpperCase();
      $(".artist-avatar").textContent = (t.artist_name || "?")[0].toUpperCase();
      el.style.setProperty("--card-accent", accentForName(t.artist_name || "?"));
    }

    $(".why").textContent = this.whyText();
    $(".title").textContent = cleanTitle(t.title);
    const artist = $<HTMLAnchorElement>(".artist");
    artist.textContent = t.artist_name + (t.artist_verified ? " ✓" : "");
    artist.href = artistUrl(t);
    $<HTMLAnchorElement>(".open").href = trackUrl(t);
    $(".desc").textContent = t.description || "";
    $(".dur").textContent = t.duration ? fmtTime(t.duration) : "";

    const chips = $(".chips");
    const chip = (text: string, cls = "") => {
      const s = document.createElement("span");
      s.textContent = text;
      if (cls) s.className = cls;
      chips.append(s);
    };
    if (t.created_at && Date.now() - Date.parse(t.created_at) < NEW_DAYS * 86400e3) chip("new", "new");
    if (t.bpm) chip(`${Math.round(t.bpm)} bpm`);
    if (t.key) chip(t.key);
    chip(t.price ? `$${t.price}` : "free", t.price ? "" : "free");
    if (t.preview) chip("preview", "preview");
    // Tempo tags repeat the BPM chip.
    for (const tag of (t.tags ?? []).filter((g) => !/^\d+$/.test(g)).slice(0, 4)) chip(tag, "tag");

    $(".counts").textContent = [t.downloads && `${compact(t.downloads)} downloads`, t.purchases && `${compact(t.purchases)} sold`]
      .filter(Boolean)
      .join(" · ");
    $(".saves").textContent = compact(t.saves);
    $(".comments").textContent = compact(t.comments);

    $(".like").addEventListener("click", () => this.actions.like(this));
    $(".dislike").addEventListener("click", () => this.actions.dislike(this));
    $(".share").addEventListener("click", () => this.actions.share(this));
    $(".next").addEventListener("click", () => this.actions.next(this));
    $(".follow").addEventListener("click", () => this.actions.follow(this));
    $(".radio").addEventListener("click", () => this.actions.radio(this));
    const toDrop = $(".to-drop");
    toDrop.hidden = !this.drops.length;
    toDrop.addEventListener("click", () => this.actions.toDrop(this));

    this.el = el;
    this.canvas = $<HTMLCanvasElement>(".wave");
    this.bindWaveform();
    this.comments?.mount(this.canvas.parentElement!);
    this.showLike();
    this.showFollow();
    requestAnimationFrame(() => this.drawWave(this.lastProgress, true));
    return el;
  }

  private showBackdrop(bg: HTMLElement): void {
    bg.style.backgroundImage = `url("${this.backdrop}")`;
    bg.classList.add("baked");
  }

  /// Where a radio track comes from, e.g. "Lower radio · via Motus".
  private whyText(): string {
    const { station } = this;
    const why = this.track.why;
    if (!station) return "";
    if (!why) return `${station} radio`;
    if (why.kind === "seed") return `${station} radio`;
    if (why.kind === "related") return `${station} radio · related artist`;
    return `${station} radio · via ${why.name}`;
  }

  showLike(pop = false): void {
    const btn = this.el?.querySelector(".like");
    if (!btn) return;
    btn.classList.toggle("on", this.liked);
    if (pop && this.liked) {
      btn.classList.remove("pop");
      void (btn as HTMLElement).offsetWidth; // restart the animation
      btn.classList.add("pop");
    }
  }

  showFollow(): void {
    const btn = this.el?.querySelector(".follow");
    if (!btn) return;
    const on = !!this.track.followed;
    btn.classList.toggle("on", on);
    btn.querySelector("span")!.textContent = on ? "following" : "follow";
    btn.querySelector("use")!.setAttribute("href", on ? "#i-check" : "#i-plus");
  }

  setTime(seconds: number): void {
    const cur = this.el?.querySelector(".cur");
    if (cur) cur.textContent = fmtTime(seconds);
  }

  private lastProgress = 0;
  private lastBuffered = 0;

  /// Draw the waveform with `progress` (0..1) played and up to `buffered` (0..1)
  /// loaded: rounded bars standing on a line, the played ones in the card's colour
  /// with a soft glow, and a faint reflection under them. Cheap to call every frame:
  /// it only redraws when a bar changes colour or the size changed.
  drawWave(progress: number, force = false, buffered = this.lastBuffered): void {
    if (this.dragging && !force) return;
    this.lastProgress = progress;
    this.lastBuffered = buffered;
    const canvas = this.canvas;
    if (!canvas) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w) return;
    const bars = Math.max(1, Math.floor(w / BAR));
    const played = Math.round(progress * bars);
    const loaded = Math.round(buffered * bars);
    const key = `${w}x${h}:${played}:${loaded}`;
    if (!force && key === this.drawn) return;
    this.drawn = key;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== w * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const data = this.track.waveform || [];
    const max = Math.max(1, ...data);
    const accent = getComputedStyle(canvas).getPropertyValue("--card-accent").trim() || "#ff4d6d";
    const base = Math.round(h * (1 - MIRROR)) - 1;
    const below = h - base - 2;
    const level = (i: number) => (data.length ? data[Math.floor((i / bars) * data.length)] / max : 0.15);
    const grad = ctx.createLinearGradient(0, base, 0, 0);
    grad.addColorStop(0, accent);
    grad.addColorStop(0.65, accent);
    grad.addColorStop(1, "#fff");
    for (let i = 0; i < bars; i++) {
      const v = level(i);
      const x = i * BAR;
      const top = Math.max(2, v * (base - 2));
      const color = i < played ? accent : i < loaded ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.22)";
      // The bar, standing on the line; played ones glow.
      ctx.globalAlpha = 1;
      ctx.fillStyle = i < played ? grad : color;
      ctx.shadowBlur = i < played ? 6 : 0;
      ctx.shadowColor = accent;
      ctx.beginPath();
      ctx.roundRect(x, base - top, BAR - 1, top, 1);
      ctx.fill();
      // Its reflection, faint, under the line.
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(x, base + 2, BAR - 1, Math.max(1, v * below), 1);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    // A small mark over each drop.
    for (const d of this.drops) {
      const x = Math.round(d * bars) * BAR + (BAR - 1) / 2;
      ctx.fillStyle = d < progress ? accent : "rgba(255,255,255,0.75)";
      ctx.beginPath();
      ctx.moveTo(x - 3.5, 0);
      ctx.lineTo(x + 3.5, 0);
      ctx.lineTo(x, 5);
      ctx.closePath();
      ctx.fill();
    }
  }

  /// Loudness at `progress` from the waveform, 0..1. Stands in for the analyser
  /// where there is no Web Audio graph.
  loudnessAt(progress: number): number {
    const data = this.track.waveform;
    if (!data?.length) return 0;
    this.peak ??= Math.max(1, ...data);
    return data[Math.min(data.length - 1, Math.floor(progress * data.length))] / this.peak;
  }

  private peak: number | undefined;

  // Drag (or click) the waveform to seek; hovering with a mouse shows the time.
  private bindWaveform(): void {
    const canvas = this.canvas!;
    const wrap = canvas.parentElement!;
    const tip = wrap.querySelector(".wave-tip") as HTMLElement;
    const fraction = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    };
    const showTip = (f: number) => {
      tip.textContent = fmtTime(f * this.actions.duration(this));
      tip.style.left = `${f * 100}%`;
    };
    const peek = (e: PointerEvent | null) =>
      this.comments?.peek(e && !this.dragging && e.pointerType === "mouse" ? fraction(e) : null, canvas.clientWidth);
    canvas.addEventListener("pointerdown", (e) => {
      peek(null);
      if (!this.actions.canSeek(this)) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      this.dragging = true;
      wrap.classList.add("hover");
      showTip(fraction(e));
      this.drawWave(fraction(e), true);
    });
    canvas.addEventListener("pointermove", (e) => {
      peek(e);
      if (this.dragging) this.drawWave(fraction(e), true);
      if (this.dragging || e.pointerType === "mouse") {
        wrap.classList.add("hover");
        showTip(fraction(e));
      }
    });
    const finish = (e: PointerEvent) => {
      if (!this.dragging) return;
      this.dragging = false;
      if (e.type === "pointerup") this.actions.seek(this, fraction(e) * this.actions.duration(this));
      if (e.pointerType !== "mouse") wrap.classList.remove("hover");
    };
    canvas.addEventListener("pointerup", finish);
    canvas.addEventListener("pointercancel", finish);
    canvas.addEventListener("pointerleave", () => {
      peek(null);
      if (!this.dragging) wrap.classList.remove("hover");
    });
  }

  /// Play/pause icon that pops up and fades.
  flash(playing: boolean): void {
    if (!this.el) return;
    const f = document.createElement("div");
    f.className = "flash";
    f.innerHTML = `<svg><use href="#i-${playing ? "play" : "pause"}"/></svg>`;
    this.el.append(f);
    f.addEventListener("animationend", () => f.remove());
  }

  clearFlash(): void {
    this.el?.querySelectorAll(".flash").forEach((f) => f.remove());
  }

  /// Heart burst where a double-tap landed.
  burst(x: number, y: number): void {
    if (!this.el) return;
    const r = this.el.getBoundingClientRect();
    const b = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    b.classList.add("burst");
    b.innerHTML = '<use href="#i-heart"/>';
    b.style.left = `${x - r.left}px`;
    b.style.top = `${y - r.top}px`;
    b.style.setProperty("--tilt", `${Math.round(Math.random() * 30 - 15)}deg`);
    this.el.append(b);
    b.addEventListener("animationend", () => b.remove());
  }
}
