// Per-frame visuals of the playing card: waveform progress, the liquid artwork drop
// (blob/), the chrome title, waveform and logo (chrome.ts), and `--energy` (0..1)
// for the stylesheet's glow and pulse, which is all there is where the drop is off
// or WebGL2 is missing.
//
// What drives them comes from features.ts: from the analyser where audio runs through
// Web Audio, otherwise from the track's waveform at the current position.

import { artistImg } from "./api";
import { LiquidBlob, SPILL } from "./blob/blob";
import { lookFor } from "./blob/style";
import type { Card } from "./cards";
import { Chrome, type Light, type Plate, rgb, textMask } from "./chrome";
import { accentFor, accentForName } from "./color";
import { type Features, FeatureTracker } from "./features";
import type { Player } from "./player";

export type VisualsSetting = "liquid" | "simple";
const VISUALS_KEY = "pl8inf.visuals";
const SLOP = 10; // px before a press on the drop turns it
const REACH = 1.2; // how far past the art's radius the drop can be grabbed
const IDLE_FPS = 15; // a paused drop keeps breathing, slowly and at a low frame rate
// Chrome is drawn only when something on it changes: the light moving, a kick, a
// bar of the waveform played, the sweep over a new title.
const CHROME_FPS = 30; // at most, 20 on phones
const TOUCH_CHROME_FPS = 20;
const PAD = 16; // CSS px the chrome reaches past the text, for its side wall and shadow
const BEVEL = 0.05; // of the font size
const DEPTH = 0.05; // of the font size: how far the side wall reaches down …
const WALL_MIN = 20; // … on text from this many CSS px; smaller text would clog up
const SHADOW = 0.09; // of the font size: how far the shadow falls
const SWEEP = 0.9; // s for the highlight to sweep across a new title
const AIM = 4; // 1/s: how fast the light follows the pointer
const KICK_STEP = 0.02; // a change in the kick envelope worth a frame
const CHROME_BAR = 5; // CSS px per chrome waveform bar, gap included: wide enough to read as metal
const LOGO_PAD = 10;
const LOGO_TINT: [number, number, number] = [1, 0.3, 0.43];
const REST_TILT: [number, number] = [0, -0.3];

/// The card in chrome: its title and waveform plates, and what they show.
interface Dressed {
  card: Card;
  titleEl: HTMLElement;
  waveCanvas: HTMLCanvasElement;
  title: Plate;
  wave: Plate;
  layoutKey: string;
  titleKey: string;
  waveKey: string;
  /// The waveform's width in CSS px and its number of bars.
  waveW: number;
  bars: number;
  /// Bars played and loaded, as drawn.
  played: number;
  loaded: number;
  tint: [number, number, number];
  sweepFrom: number;
  progress: number;
  buffered: number;
  observer: ResizeObserver;
}

export class Visualizer {
  private raf = 0;
  private last = 0;
  private card: Card | null = null;
  private features = new FeatureTracker();
  /// Undefined until first needed; null where WebGL2 failed.
  private blob: LiquidBlob | null | undefined;
  private reduced = matchMedia("(prefers-reduced-motion: reduce)");
  private setting: VisualsSetting = localStorage.getItem(VISUALS_KEY) === "simple" ? "simple" : "liquid";
  private debug: ((f: Features) => void) | null = null;
  private dropDebug: ((text: string) => void) | null = null;
  /// A press on the drop; `on` once it moved enough to turn it.
  private grab: { id: number; x: number; y: number; on: boolean } | null = null;
  private spun = false;
  /// A mouse rests on the drop.
  private hover = false;
  private idleTimer = 0;
  /// Undefined until first needed; null where WebGL2 failed.
  private chrome: Chrome | null | undefined;
  private dressed: Dressed | null = null;
  private logo: { el: HTMLElement; canvas: HTMLCanvasElement; plate: Plate; key: string } | null = null;
  /// Where the light comes from, and where the pointer wants it.
  private tilt: [number, number] = [...REST_TILT];
  private aim: [number, number] = [...REST_TILT];
  private chromeAt = 0;
  private chromeDirty = true;
  private kickDrawn = 0;

  constructor(
    private player: Player,
    private touch: boolean,
  ) {
    document.addEventListener("visibilitychange", () => (document.hidden ? this.stop() : this.start()));
    this.reduced.addEventListener("change", () => this.attach(this.card, true));
    // Capturing, so a turn can keep its moves from the pager.
    const on = { capture: true, passive: true };
    document.fonts?.addEventListener("loadingdone", () => this.redress());
    document.addEventListener("pointerdown", (e) => this.down(e), on);
    document.addEventListener("pointermove", (e) => this.move(e), on);
    for (const ev of ["pointerup", "pointercancel"]) document.addEventListener(ev, (e) => this.up(e as PointerEvent), on);
    document.addEventListener("pointerleave", (e) => this.pointer(e, false), { passive: true });
    // A turn is not a tap: no play/pause after it.
    document.addEventListener("click", (e) => {
      if (this.spun) e.stopPropagation();
      this.spun = false;
    }, true);
    const debug = new URLSearchParams(location.search).get("debug");
    if (debug === "audio") import("./debug").then((m) => { this.debug = m.audioDebug(); });
    if (debug === "drop") import("./debug").then((m) => { this.dropDebug = m.dropDebug(); this.start(); });
  }

  get visuals(): VisualsSetting {
    return this.setting;
  }

  set visuals(v: VisualsSetting) {
    this.setting = v;
    localStorage.setItem(VISUALS_KEY, v);
    this.attach(this.card, true);
  }

  /// Whether the liquid drop runs: wanted, motion allowed, and WebGL2 works.
  private liquid(): LiquidBlob | null {
    if (this.setting !== "liquid" || this.reduced.matches || this.blob === null) return null;
    if (this.blob === undefined) {
      this.blob = LiquidBlob.create(this.touch);
      if (this.blob) {
        // Plain art while the GPU is gone; the drop comes back with it.
        this.blob.onLost = () => this.card?.el?.classList.remove("liquid");
        this.blob.onRestored = () => this.attach(this.card, true);
      }
    }
    return this.blob?.lost ? null : this.blob;
  }

  /// Spin the drop backwards, hard: the rewind.
  wheelUp(): void {
    this.blob?.spin.fling([0, -26, 0]);
    this.start();
  }

  /// A play/pause from a tap was taken back by the second tap of a double-tap.
  cancelFlash(): void {
    this.blob?.settleIcon();
  }

  /// Chrome is part of the liquid look, and needs WebGL2 too.
  private chromeOn(): Chrome | null {
    if (this.setting !== "liquid" || this.chrome === null) return null;
    if (this.chrome === undefined) {
      this.chrome = Chrome.create();
      if (this.chrome) this.chrome.onRestored = () => {
        this.chromeDirty = true;
        this.start();
      };
    }
    if (this.chrome && !this.logo) this.dressLogo(this.chrome);
    return this.chrome;
  }

  /// Put `card`'s title and waveform in chrome: the layer moves into the card.
  private dress(card: Card | null): void {
    const old = this.dressed;
    if (old && (old.card !== card || !old.card.el)) this.strip(old);
    const chrome = this.chromeOn();
    if (!chrome) {
      this.undress();
      return;
    }
    const titleEl = card?.el?.querySelector<HTMLElement>(".title");
    const waveCanvas = card?.waveCanvas;
    if (!card || !titleEl || !waveCanvas || this.dressed) return;
    titleEl.parentElement!.append(chrome.canvas);
    chrome.clear();
    // The waveform's own canvas stays, for seeking, but empty.
    waveCanvas.getContext("2d")?.clearRect(0, 0, waveCanvas.width, waveCanvas.height);
    const color = getComputedStyle(card.el!).getPropertyValue("--card-accent").trim() || "#ff4d6d";
    const d: Dressed = {
      card,
      titleEl,
      waveCanvas,
      title: chrome.plate("text"),
      wave: chrome.plate("wave"),
      layoutKey: "",
      titleKey: "",
      waveKey: "",
      waveW: 0,
      bars: 0,
      played: -1,
      loaded: -1,
      tint: rgb(color),
      sweepFrom: performance.now(),
      progress: 0,
      buffered: 0,
      // Text loading around the title moves it; the layer follows.
      observer: new ResizeObserver(() => {
        d.layoutKey = "";
        this.chromeDirty = true;
        this.start();
      }),
    };
    for (const el of [titleEl.parentElement!, titleEl, waveCanvas]) d.observer.observe(el);
    this.dressed = d;
    card.onWave = (progress, buffered) => {
      d.progress = progress;
      d.buffered = buffered;
      const played = Math.floor(progress * d.bars), loaded = Math.floor(buffered * d.bars);
      if (played === d.played && loaded === d.loaded) return;
      d.played = played;
      d.loaded = loaded;
      this.chromeDirty = true;
      this.start();
    };
    // The studio's floor shows the art, in the colour taken from it.
    chrome.setArt(null, color);
    const img = artistImg(card.track);
    if (img) {
      const pic = new Image();
      pic.src = img;
      Promise.all([pic.decode(), accentFor(img)]).then(([, c]) => {
        if (this.dressed !== d) return;
        chrome.setArt(pic, c ?? color);
        if (c) d.tint = rgb(c);
        this.chromeDirty = true;
        this.start();
      }, () => {});
    }
    this.chromeDirty = true;
  }

  /// Take the chrome off `d`'s card: plain text and the drawn waveform again.
  private strip(d: Dressed): void {
    d.card.onWave = null;
    d.observer.disconnect();
    d.titleEl.classList.remove("chromed");
    this.chrome?.drop(d.title);
    this.chrome?.drop(d.wave);
    this.chrome?.canvas.remove();
    d.card.drawWave(d.progress, true, d.buffered);
    this.dressed = null;
  }

  /// Back to plain text and the drawn waveform everywhere.
  private undress(): void {
    if (this.dressed) this.strip(this.dressed);
    for (const el of document.querySelectorAll(".chromed")) el.classList.remove("chromed");
    if (this.logo) {
      this.logo.canvas.remove();
      this.chrome?.drop(this.logo.plate);
    }
    this.logo = null;
  }

  /// Fonts arrived: shapes are drawn again on the next frame.
  private redress(): void {
    if (this.dressed) this.dressed.layoutKey = this.dressed.titleKey = this.dressed.waveKey = "";
    if (this.logo) this.logo.key = "";
    this.chromeDirty = true;
    this.start();
  }

  private dressLogo(chrome: Chrome): void {
    const el = document.querySelector<HTMLElement>(".logo b");
    if (!el) return;
    el.style.setProperty("--pad", `${LOGO_PAD}px`);
    this.logo = { el, canvas: plateCanvas(el), plate: chrome.plate("text"), key: "" };
  }

  /// Size and place the layer over the title and the waveform, and draw their
  /// shapes again where their size or text changed.
  private reshape(chrome: Chrome, d: Dressed): boolean {
    const el = d.titleEl, c = d.waveCanvas, wrap = c.parentElement!;
    if (!el.clientWidth || !c.clientWidth) return false;
    // Layout offsets, not client rects: the card scales as it leaves.
    const top = el.offsetTop - PAD;
    const waveTop = wrap.offsetTop + c.offsetTop;
    const width = el.parentElement!.clientWidth + 2 * PAD;
    const height = waveTop + c.clientHeight + PAD - top;
    const key = `${width}x${height}@${top}`;
    if (key !== d.layoutKey) {
      d.layoutKey = key;
      const s = chrome.canvas.style;
      s.left = `${-PAD}px`;
      s.top = `${top}px`;
      s.width = `${width}px`;
      s.height = `${height}px`;
      chrome.layout(width, height);
    }
    const tkey = `${el.clientWidth}x${el.clientHeight}:${el.textContent}`;
    if (tkey !== d.titleKey) {
      d.titleKey = tkey;
      const size = parseFloat(getComputedStyle(el).fontSize);
      const wall = size < WALL_MIN ? 0 : size * DEPTH;
      chrome.shape(d.title, el.clientWidth + 2 * PAD, el.clientHeight + 2 * PAD, size * BEVEL, wall, size * SHADOW, (ctx) => textMask(el, PAD, ctx)).then((ok) => {
        if (!ok) return;
        // The sweep runs over the title once it is metal.
        if (!el.classList.contains("chromed")) d.sweepFrom = performance.now();
        el.classList.add("chromed");
        this.redraw();
      });
    }
    const wkey = `${c.clientWidth}x${c.clientHeight}`;
    if (wkey !== d.waveKey) {
      d.waveKey = wkey;
      const [w, h] = [c.clientWidth, c.clientHeight];
      chrome.shape(d.wave, w, h, CHROME_BAR * 0.25, 0, 0, (ctx) => {
        const { base, tops } = d.card.waveMask(ctx, w, h, CHROME_BAR);
        d.waveW = w;
        d.bars = tops.length;
        d.played = Math.floor(d.progress * d.bars);
        d.loaded = Math.floor(d.buffered * d.bars);
        d.wave.floor = base / h;
        // One horizon runs through all the bars, as through one sheet of metal.
        return [{ left: 0, top: Math.min(...tops), width: tops.length * CHROME_BAR, height: base - Math.min(...tops) }];
      }).then((ok) => ok && this.redraw());
    }
    // The title's plate starts PAD up and left of it, as the layer does.
    chrome.place(d.title, el.offsetLeft, 0);
    chrome.place(d.wave, wrap.offsetLeft + c.offsetLeft + PAD, waveTop - top);
    return true;
  }

  /// A shape arrived from the baker: draw again.
  private redraw(): void {
    this.chromeDirty = true;
    this.start();
  }

  /// Light the logo once, whenever its size changed.
  private shineLogo(chrome: Chrome): void {
    const logo = this.logo;
    if (!logo) return;
    const el = logo.el;
    const key = `${el.clientWidth}x${el.clientHeight}`;
    if (key === logo.key || !el.clientWidth) return;
    logo.key = key;
    chrome.shape(logo.plate, el.clientWidth + 2 * LOGO_PAD, el.clientHeight + 2 * LOGO_PAD, 1, 0, 1.5, (ctx) => textMask(el, LOGO_PAD, ctx)).then((ok) => {
      if (!ok || this.logo !== logo) return;
      chrome.still(logo.plate, logo.canvas, { tint: LOGO_TINT, tilt: REST_TILT, kick: 0, sweep: -1 });
      el.classList.add("chromed");
    });
  }

  /// Light the chrome where something on it changed. Returns whether it wants
  /// more frames.
  private shine(now: number, dt: number, kick: number): boolean {
    const chrome = this.chrome;
    if (!chrome || chrome.lost) return false;
    const d = this.dressed;
    // Where the drop had to step down to its lowest quality, the GPU is slow:
    // chrome then holds still and is drawn only when what it shows changes.
    const frozen = !!this.blob?.struggling;
    const calm = frozen || this.reduced.matches;
    const k = 1 - Math.exp(-dt * AIM);
    this.tilt[0] += (this.aim[0] - this.tilt[0]) * k;
    this.tilt[1] += (this.aim[1] - this.tilt[1]) * k;
    const moving = !frozen && Math.abs(this.aim[0] - this.tilt[0]) + Math.abs(this.aim[1] - this.tilt[1]) > 0.003;
    if (calm) kick = 0;
    const kicking = Math.abs(kick - this.kickDrawn) > KICK_STEP;
    const t = d && !calm ? (now - d.sweepFrom) / 1000 / SWEEP : 2;
    const sweeping = t <= 1;
    const want = this.chromeDirty || moving || kicking || sweeping;
    if (!want || now - this.chromeAt < 1000 / (this.touch ? TOUCH_CHROME_FPS : CHROME_FPS)) return want;
    this.chromeAt = now;
    this.chromeDirty = false;
    this.kickDrawn = kick;
    this.shineLogo(chrome);
    if (!d || !this.reshape(chrome, d)) return want;
    const light: Light = { tint: d.tint, tilt: this.tilt, kick, sweep: sweeping ? -0.3 + 1.6 * t : -1 };
    chrome.clear();
    chrome.render(d.title, light);
    // The playhead sits in the gap after the last bar played.
    const gap = (CHROME_BAR * 0.3) / 2;
    const at = (bars: number) => (bars > 0 ? (bars * CHROME_BAR - gap) / d.waveW : 0);
    chrome.render(d.wave, { ...light, sweep: -1 }, { progress: at(d.played), buffered: at(d.loaded) });
    return want;
  }

  /// Follow `card` from now on.
  attach(card: Card | null, again = false): void {
    if (this.card === card && !again) return;
    if (this.card && this.card !== card) {
      this.card.el?.style.setProperty("--energy", "0");
      this.card.el?.classList.remove("liquid", "turning");
      this.grab = null;
    }
    this.card = card;
    this.dress(card);
    const blob = this.liquid();
    const slot = card?.el?.querySelector<HTMLElement>(".art");
    if (!card || !slot || !blob) {
      this.blob?.canvas.remove();
      card?.el?.classList.remove("liquid");
    } else {
      const img = artistImg(card.track);
      const name = card.track.artist_name || "?";
      const own = accentForName(name);
      blob.setAccent(img ? null : own);
      if (img) accentFor(img).then((c) => { if (this.card === card) blob.setAccent(c); });
      blob.mount(slot, lookFor(card.track), img, name[0].toUpperCase(), own).then((ok) => {
        if (ok && this.card === card) {
          card.el?.classList.add("liquid");
          this.start();
        }
      });
    }
    this.start();
  }

  start(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = 0;
    if (!this.raf && !document.hidden) {
      this.last = 0;
      this.raf = requestAnimationFrame(this.frame);
    }
  }

  stop(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = 0;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /// The drop on screen: its centre and the art's radius, in px. Null while it
  /// does not show.
  private where(): { x: number; y: number; radius: number } | null {
    const blob = this.blob;
    if (!blob?.canvas.isConnected || !this.card?.el?.classList.contains("liquid")) return null;
    const r = blob.canvas.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, radius: r.width / SPILL / 2 };
  }

  /// Pointer over the drop pushes a dent into it; a mouse resting on it shows that
  /// a click pauses.
  private pointer(e: PointerEvent, on: boolean): void {
    const at = this.where();
    if (!at) {
      this.hover = false;
      return;
    }
    const x = (e.clientX - at.x) / at.radius, y = -(e.clientY - at.y) / at.radius;
    this.blob!.setPointer(x, y, on);
    const hover = on && e.pointerType === "mouse" && !this.grab?.on && Math.hypot(x, y) < 1
      && !(e.target as Element).closest?.("button, a, input, .wave-wrap, #bar, .panel");
    if (hover !== this.hover) {
      this.hover = hover;
      this.card?.el?.classList.toggle("drop-hover", hover);
    }
    if (on) this.start();
  }

  // Dragging the drop turns it. On touch only a clearly sideways drag does, as up
  // and down turn the page; a mouse can turn it any way (the wheel turns pages).

  private down(e: PointerEvent): void {
    this.pointer(e, true);
    const at = this.where();
    if (this.grab || !at || (e.pointerType === "mouse" && e.button !== 0)) return;
    if ((e.target as Element).closest("button, a, input, .wave-wrap")) return;
    if (Math.hypot(e.clientX - at.x, e.clientY - at.y) > at.radius * REACH) return;
    this.grab = { id: e.pointerId, x: e.clientX, y: e.clientY, on: false };
  }

  private move(e: PointerEvent): void {
    if (e.pointerType === "mouse" && this.chrome) {
      this.aim = [(e.clientX / innerWidth) * 2 - 1, (e.clientY / innerHeight) * 2 - 1];
      this.start();
    }
    this.pointer(e, true);
    const g = this.grab;
    const at = this.where();
    if (!g || e.pointerId !== g.id) return;
    if (!at) {
      this.grab = null;
      return;
    }
    // The button came up outside the window.
    if (e.pointerType === "mouse" && !(e.buttons & 1)) {
      this.up(e);
      return;
    }
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    if (!g.on) {
      if (Math.hypot(dx, dy) < SLOP) return;
      if (e.pointerType !== "mouse" && Math.abs(dx) < 2 * Math.abs(dy)) {
        this.grab = null;
        return;
      }
      g.on = true;
      this.blob!.spin.hold(true);
      this.card?.el?.classList.add("turning");
    }
    e.stopPropagation();
    this.blob!.spin.turn(dx / at.radius, -dy / at.radius, performance.now());
    g.x = e.clientX;
    g.y = e.clientY;
    this.start();
  }

  private up(e: PointerEvent): void {
    this.pointer(e, false);
    const g = this.grab;
    if (!g || e.pointerId !== g.id) return;
    this.grab = null;
    if (!g.on) return;
    this.blob?.spin.hold(false);
    this.card?.el?.classList.remove("turning");
    this.spun = e.type === "pointerup";
    // The click, if any, comes right after.
    setTimeout(() => (this.spun = false), 350);
    this.start();
  }

  private frame = (now: number) => {
    this.raf = 0;
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 1 / 60;
    this.last = now;
    const card = this.card;
    if (!card) return;
    const a = this.player.audio;
    const progress = a.duration ? a.currentTime / a.duration : 0;
    card.drawWave(progress, false, a.duration ? bufferedTo(a) / a.duration : 0);
    const playing = !a.paused;
    const an = this.player.analyser;
    const mixed = !!an && this.player.mixing;
    const f = !playing
      ? this.features.idle(dt)
      : mixed
        ? this.features.fromAnalyser(an, now / 1000, dt)
        : this.features.fromLoudness(card.loudnessAt(progress), now / 1000, dt);
    this.debug?.(f);
    this.dropDebug?.([
      `setting ${this.setting} · reduced motion ${this.reduced.matches} · touch ${this.touch} · mixing ${mixed}`,
      `blob ${this.blob === undefined ? "not asked" : this.blob === null ? `failed: ${LiquidBlob.failure}` : "made"} · card liquid ${!!card.el?.classList.contains("liquid")}`,
      this.blob?.describe() ?? "",
    ].join("\n"));
    let busy = this.shine(now, dt, f.kick) || playing;
    const liquid = !!this.blob && !!card.el?.classList.contains("liquid");
    if (!this.reduced.matches) {
      // The kick drives the pulse; without an analyser the kicks come from the waveform.
      const energy = Math.min(1, mixed ? 0.65 * f.kick + 0.35 * f.low : 0.5 * f.low + 0.4 * f.kick);
      card.el?.style.setProperty("--energy", energy.toFixed(3));
      busy ||= energy > 0.01;
      if (liquid) {
        const buffering = !!card.el?.classList.contains("buffering");
        busy = this.blob!.frame(f, dt, { playing, progress, buffering, hover: this.hover }) || busy;
      }
    }
    if (busy) this.raf = requestAnimationFrame(this.frame);
    // Paused, it breathes on at a low frame rate; not on phones, for the battery.
    else if (liquid && !this.touch && !this.reduced.matches) {
      // Not through start(): the frame should see the real time since the last one.
      this.idleTimer = window.setTimeout(() => {
        this.idleTimer = 0;
        if (!this.raf && !document.hidden) this.raf = requestAnimationFrame(this.frame);
      }, 1000 / IDLE_FPS);
    }
  };
}

/// A canvas laid over `el` for its chrome.
function plateCanvas(el: HTMLElement): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.className = "chrome-plate";
  c.setAttribute("aria-hidden", "true");
  el.append(c);
  return c;
}

/// How far the audio is loaded from where it plays now, in seconds.
function bufferedTo(a: HTMLMediaElement): number {
  const b = a.buffered;
  for (let i = 0; i < b.length; i++) {
    if (b.start(i) <= a.currentTime + 0.5 && b.end(i) >= a.currentTime) return b.end(i);
  }
  return a.currentTime;
}
