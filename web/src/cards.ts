// One card per track. Elements are built when a card first comes near the screen
// and dropped again once it is far behind, so a long session stays light.

import { type Track, artistImg, artistUrl, trackUrl } from "./api";
import { accentFor } from "./color";

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
}

// Uploads are often titled after their file name.
export const cleanTitle = (t: string) => t.replace(/\.(wav|mp3|flac|aiff?|ogg|m4a)$/i, "");
export const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

const tpl = document.getElementById("card-tpl") as HTMLTemplateElement;

export class Card {
  el: HTMLElement | null = null;
  liked: boolean;
  private canvas: HTMLCanvasElement | null = null;
  private drawn = "";
  private dragging = false;
  private accent: string | null = null;

  /// `station`: the artist radio this card was picked for, if any.
  constructor(
    readonly track: Track,
    private actions: CardActions,
    { liked = false, station = undefined as string | undefined } = {},
  ) {
    this.liked = liked;
    this.station = station;
  }

  private station: string | undefined;

  element(): HTMLElement {
    return this.el ?? this.build();
  }

  /// Forget the element; it is built again if the card comes back.
  release(): void {
    this.el?.remove();
    this.el = this.canvas = null;
    this.drawn = "";
  }

  private build(): HTMLElement {
    const t = this.track;
    const el = tpl.content.firstElementChild!.cloneNode(true) as HTMLElement;
    const $ = <T extends HTMLElement>(sel: string) => el.querySelector(sel) as T;
    const img = artistImg(t);
    if (img) {
      $(".bg").style.backgroundImage = `url("${img}")`;
      $(".art").style.backgroundImage = `url("${img}")`;
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
    if (t.bpm) chip(`${Math.round(t.bpm)} bpm`);
    if (t.key) chip(t.key);
    chip(t.price ? `$${t.price}` : "free", t.price ? "" : "free");
    if (t.preview) chip("preview", "preview");
    // Tempo tags repeat the BPM chip.
    for (const tag of (t.tags ?? []).filter((g) => !/^\d+$/.test(g)).slice(0, 4)) chip(tag, "tag");

    $(".counts").textContent =
      `${t.saves} saves · ${t.downloads} downloads · ${t.comments} comments` +
      (t.purchases ? ` · ${t.purchases} sold` : "");

    $(".like").addEventListener("click", () => this.actions.like(this));
    $(".dislike").addEventListener("click", () => this.actions.dislike(this));
    $(".share").addEventListener("click", () => this.actions.share(this));
    $(".next").addEventListener("click", () => this.actions.next(this));
    $(".follow").addEventListener("click", () => this.actions.follow(this));
    $(".radio").addEventListener("click", () => this.actions.radio(this));

    this.el = el;
    this.canvas = $<HTMLCanvasElement>(".wave");
    this.bindWaveform();
    this.showLike();
    this.showFollow();
    requestAnimationFrame(() => this.drawWave(this.lastProgress, true));
    return el;
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
    btn.classList.toggle("on", !!this.track.followed);
    btn.textContent = this.track.followed ? "following" : "follow";
  }

  setTime(seconds: number): void {
    const cur = this.el?.querySelector(".cur");
    if (cur) cur.textContent = fmtTime(seconds);
  }

  private lastProgress = 0;

  /// Draw the waveform with `progress` (0..1) played. Cheap to call every frame:
  /// it only redraws when a bar changes colour or the size changed.
  drawWave(progress: number, force = false): void {
    if (this.dragging && !force) return;
    this.lastProgress = progress;
    const canvas = this.canvas;
    if (!canvas) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w) return;
    const bars = Math.max(1, Math.floor(w / 3));
    const played = Math.round(progress * bars);
    const key = `${w}x${h}:${played}`;
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
    for (let i = 0; i < bars; i++) {
      const v = data.length ? data[Math.floor((i / bars) * data.length)] / max : 0.15;
      const bh = Math.max(2, v * h);
      ctx.fillStyle = i < played ? accent : "rgba(255,255,255,0.35)";
      ctx.fillRect(i * 3, (h - bh) / 2, 2, bh);
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
    canvas.addEventListener("pointerdown", (e) => {
      if (!this.actions.canSeek(this)) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      this.dragging = true;
      wrap.classList.add("hover");
      showTip(fraction(e));
      this.drawWave(fraction(e), true);
    });
    canvas.addEventListener("pointermove", (e) => {
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
