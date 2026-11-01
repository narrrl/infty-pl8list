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
import { accentFor } from "./color";
import { type Features, FeatureTracker } from "./features";
import type { Player } from "./player";

export type VisualsSetting = "liquid" | "simple";
const VISUALS_KEY = "pl8inf.visuals";

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

  constructor(
    private player: Player,
    private touch: boolean,
  ) {
    document.addEventListener("visibilitychange", () => (document.hidden ? this.stop() : this.start()));
    this.reduced.addEventListener("change", () => this.attach(this.card, true));
    for (const ev of ["pointermove", "pointerdown"]) document.addEventListener(ev, (e) => this.pointer(e as PointerEvent, true), { passive: true });
    for (const ev of ["pointerup", "pointercancel", "pointerleave"]) document.addEventListener(ev, (e) => this.pointer(e as PointerEvent, false), { passive: true });
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
        this.blob.onLost = () => {
          this.blob?.canvas.remove();
          this.blob = null;
          this.card?.el?.classList.remove("liquid");
        };
      }
    }
    return this.blob;
  }

  /// Follow `card` from now on.
  attach(card: Card | null, again = false): void {
    if (this.card === card && !again) return;
    if (this.card && this.card !== card) {
      this.card.el?.style.setProperty("--energy", "0");
      this.card.el?.classList.remove("liquid");
    }
    this.card = card;
    const blob = this.liquid();
    const slot = card?.el?.querySelector<HTMLElement>(".art");
    if (!card || !slot || !blob) {
      this.blob?.canvas.remove();
      card?.el?.classList.remove("liquid");
    } else {
      const img = artistImg(card.track);
      blob.setAccent(null);
      if (img) accentFor(img).then((c) => { if (this.card === card) blob.setAccent(c); });
      blob.mount(slot, lookFor(card.track), img, (card.track.artist_name || "?")[0].toUpperCase()).then((ok) => {
        if (ok && this.card === card) {
          card.el?.classList.add("liquid");
          this.start();
        }
      });
    }
    this.start();
  }

  start(): void {
    if (!this.raf && !document.hidden) {
      this.last = 0;
      this.raf = requestAnimationFrame(this.frame);
    }
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /// Pointer over the drop pushes a dent into it.
  private pointer(e: PointerEvent, on: boolean): void {
    const blob = this.blob;
    if (!blob?.canvas.isConnected) return;
    const r = blob.canvas.getBoundingClientRect();
    const radius = r.width / SPILL / 2;
    blob.setPointer((e.clientX - r.left - r.width / 2) / radius, -(e.clientY - r.top - r.height / 2) / radius, on);
    if (on) this.start();
  }

  private frame = (now: number) => {
    this.raf = 0;
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 1 / 60;
    this.last = now;
    const card = this.card;
    if (!card) return;
    const a = this.player.audio;
    const progress = a.duration ? a.currentTime / a.duration : 0;
    card.drawWave(progress);
    const playing = !a.paused;
    const an = this.player.analyser;
    const mixed = !!an && this.player.mixing;
    const f = !playing
      ? this.features.idle(dt)
      : mixed
        ? this.features.fromAnalyser(an, now / 1000, dt)
        : this.features.fromLoudness(card.loudnessAt(progress), dt);
    this.debug?.(f);
    let busy = playing;
    if (!this.reduced.matches) {
      // The kick drives the pulse; without an analyser there are no kicks, only loudness.
      const energy = Math.min(1, mixed ? 0.65 * f.kick + 0.35 * f.low : 0.7 * f.low);
      card.el?.style.setProperty("--energy", energy.toFixed(3));
      busy ||= energy > 0.01;
      if (this.blob && card.el?.classList.contains("liquid")) busy = this.blob.frame(f, dt, playing) || busy;
    }
    if (busy) this.raf = requestAnimationFrame(this.frame);
  };
}
