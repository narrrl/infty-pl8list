// Per-frame visuals of the playing card: waveform progress, the liquid artwork drop
// (blob/), and `--energy` (0..1) for the stylesheet's glow and pulse, which is all
// there is where the drop is off or WebGL2 is missing.
//
// What drives them comes from features.ts: from the analyser where audio runs through
// Web Audio, otherwise from the track's waveform at the current position.

import { artistImg } from "./api";
import { LiquidBlob, SPILL } from "./blob/blob";
import { lookFor } from "./blob/style";
import type { Card } from "./cards";
import { accentFor, accentForName } from "./color";
import { type Features, FeatureTracker } from "./features";
import type { Player } from "./player";

export type VisualsSetting = "liquid" | "simple";
const VISUALS_KEY = "pl8inf.visuals";
const SLOP = 10; // px before a press on the drop turns it
const REACH = 1.2; // how far past the art's radius the drop can be grabbed
const IDLE_FPS = 15; // a paused drop keeps breathing, slowly and at a low frame rate

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
  /// A press on the drop; `on` once it moved enough to turn it.
  private grab: { id: number; x: number; y: number; on: boolean } | null = null;
  private spun = false;
  /// A mouse rests on the drop.
  private hover = false;
  private idleTimer = 0;

  constructor(
    private player: Player,
    private touch: boolean,
  ) {
    document.addEventListener("visibilitychange", () => (document.hidden ? this.stop() : this.start()));
    this.reduced.addEventListener("change", () => this.attach(this.card, true));
    // Capturing, so a turn can keep its moves from the pager.
    const on = { capture: true, passive: true };
    document.addEventListener("pointerdown", (e) => this.down(e), on);
    document.addEventListener("pointermove", (e) => this.move(e), on);
    for (const ev of ["pointerup", "pointercancel"]) document.addEventListener(ev, (e) => this.up(e as PointerEvent), on);
    document.addEventListener("pointerleave", (e) => this.pointer(e, false), { passive: true });
    // A turn is not a tap: no play/pause after it.
    document.addEventListener("click", (e) => {
      if (this.spun) e.stopPropagation();
      this.spun = false;
    }, true);
    if (new URLSearchParams(location.search).get("debug") === "audio") {
      import("./debug").then((m) => { this.debug = m.audioDebug(); });
    }
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

  /// Follow `card` from now on.
  attach(card: Card | null, again = false): void {
    if (this.card === card && !again) return;
    if (this.card && this.card !== card) {
      this.card.el?.style.setProperty("--energy", "0");
      this.card.el?.classList.remove("liquid", "turning");
      this.grab = null;
    }
    this.card = card;
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
    let busy = playing;
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

/// How far the audio is loaded from where it plays now, in seconds.
function bufferedTo(a: HTMLMediaElement): number {
  const b = a.buffered;
  for (let i = 0; i < b.length; i++) {
    if (b.start(i) <= a.currentTime + 0.5 && b.end(i) >= a.currentTime) return b.end(i);
  }
  return a.currentTime;
}
