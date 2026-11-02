// Timed comments on the waveform: a dot under the moment each one was left at,
// and a bubble that grows out of the dot when the music gets there, then drifts
// up and fades. A mouse over the waveform peeks at the comment under it.

import { type Comment, imgUrl } from "./api";
import { accentForName } from "./color";

const LIFE = 4600; // ms a bubble shows; the length of its CSS animation
const GAP = 900; // ms at least between two bubbles; dots in between only ping
const MAX_SHOWN = 2; // bubbles on screen at once, the older pushed up
const STACK = 6; // px between stacked bubbles
const PEEK_PX = 8; // how close the mouse has to be to a dot to peek
const GAP_ABOVE = 8; // px between the waveform and a bubble (.wc-bubble's bottom)
const DOTS_ROW = 0.28; // share of the waveform's height the dots' row takes (.wave-comments)
const SEEK = 1.5; // s; a longer step between two ticks is a seek, which fires nothing

export class WaveComments {
  private wrap: HTMLElement | null = null;
  private layer: HTMLElement | null = null;
  private dots: HTMLElement[] = [];
  private shown: HTMLElement[] = [];
  private peeked: { el: HTMLElement; id: number } | null = null;
  private last = -1;
  private lastBubble = 0;

  constructor(readonly list: Comment[], private duration: () => number) {}

  /// Put the dots under the waveform in `wrap`; they sprout from left to right.
  mount(wrap: HTMLElement): void {
    this.unmount();
    const d = this.duration();
    if (!d || !this.list.length) return;
    this.wrap = wrap;
    const layer = document.createElement("div");
    layer.className = "wave-comments";
    layer.setAttribute("aria-hidden", "true");
    this.dots = this.list.map((c) => {
      const dot = document.createElement("i");
      dot.className = "wc-dot";
      const x = Math.min(1, c.at / d);
      dot.style.left = `${x * 100}%`;
      dot.style.setProperty("--x", x.toFixed(3));
      if (c.at <= this.last) dot.classList.add("past");
      layer.append(dot);
      return dot;
    });
    wrap.append(layer);
    this.layer = layer;
  }

  unmount(): void {
    this.layer?.remove();
    for (const b of this.shown) b.remove();
    this.peeked?.el.remove();
    this.layer = this.wrap = this.peeked = null;
    this.dots = [];
    this.shown = [];
  }

  /// Playback is at `t` seconds. Comments passed since the last tick fire, unless
  /// the step was a seek; dots behind the playhead stay lit.
  tick(t: number): void {
    const from = this.last;
    this.last = t;
    const played = t > from && t - from < SEEK;
    let fire: Comment | null = null;
    for (let i = 0; i < this.list.length; i++) {
      const c = this.list[i], dot = this.dots[i];
      dot?.classList.toggle("past", c.at <= t);
      if (played && c.at > from && c.at <= t) {
        if (dot) ping(dot);
        fire = c;
      }
    }
    const now = performance.now();
    if (fire && this.layer && now - this.lastBubble >= GAP) {
      this.lastBubble = now;
      this.bubble(fire);
    }
  }

  /// The mouse is at `f` (0..1) of the waveform, `width` px wide; null when it left.
  peek(f: number | null, width: number): void {
    const d = this.duration();
    let near: Comment | null = null;
    if (f !== null && d && this.layer) {
      let best = PEEK_PX;
      for (const c of this.list) {
        const px = Math.abs(c.at / d - f) * width;
        if (px <= best) [best, near] = [px, c];
      }
    }
    if (near?.id === this.peeked?.id) return;
    this.peeked?.el.remove();
    this.peeked = null;
    if (near) this.peeked = { el: this.place(near, "peek"), id: near.id };
  }

  private bubble(c: Comment): void {
    const el = this.place(c, "");
    const h = el.offsetHeight + STACK;
    // The ones already up make room, the oldest leaves early.
    for (const b of this.shown) b.style.setProperty("--lift", `${(parseFloat(b.style.getPropertyValue("--lift")) || 0) + h}px`);
    this.shown.push(el);
    while (this.shown.length > MAX_SHOWN) leave(this.shown.shift()!);
    setTimeout(() => {
      el.remove();
      this.shown = this.shown.filter((b) => b !== el);
    }, LIFE);
  }

  /// A bubble for `c` over its dot, kept inside the waveform's width, its tail
  /// pointing at the dot.
  private place(c: Comment, kind: string): HTMLElement {
    const wrap = this.wrap!;
    const el = document.createElement("div");
    el.className = `wc-bubble ${kind}`.trim();
    const inner = document.createElement("div");
    inner.className = "wc-in";
    const avatar = document.createElement("span");
    avatar.className = "wc-avatar";
    const img = imgUrl(c.img);
    if (img) avatar.style.backgroundImage = `url("${img}")`;
    else {
      avatar.textContent = (c.name || "?")[0].toUpperCase();
      avatar.style.background = accentForName(c.name || "?");
    }
    const text = document.createElement("span");
    text.className = "wc-text";
    const name = document.createElement("b");
    name.textContent = c.name + (c.verified ? " ✓" : "");
    const body = document.createElement("span");
    body.textContent = c.body;
    text.append(name, body);
    inner.append(avatar, text);
    el.append(inner);
    wrap.append(el);
    const w = wrap.clientWidth;
    const x = Math.min(1, c.at / (this.duration() || 1)) * w;
    const left = Math.max(0, Math.min(w - el.offsetWidth, x - el.offsetWidth / 2));
    el.style.left = `${left}px`;
    el.style.setProperty("--tail", `${Math.round(x - left)}px`);
    // From the bubble down to the middle of the dots' row (see .wave-comments).
    el.style.setProperty("--reach", `${Math.round(GAP_ABOVE + wrap.clientHeight * (1 - DOTS_ROW / 2))}px`);
    return el;
  }
}

/// Restart the dot's ping.
function ping(dot: HTMLElement): void {
  dot.classList.remove("hit");
  void dot.offsetWidth;
  dot.classList.add("hit");
}

function leave(el: HTMLElement): void {
  el.classList.add("out");
  setTimeout(() => el.remove(), 300);
}
