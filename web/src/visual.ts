// Per-frame visuals of the playing card: waveform progress, and a bass level that
// the stylesheet turns into a pulse of the artwork and a glow (`--energy`, 0..1).
// The level comes from the analyser where audio runs through Web Audio, otherwise
// from the track's waveform at the current position.

import type { Card } from "./cards";
import type { Player } from "./player";

export class Visualizer {
  private raf = 0;
  private bins: Uint8Array<ArrayBuffer> | null = null;
  private level = 0;
  private peak = 0.3;
  private card: Card | null = null;
  private reduced = matchMedia("(prefers-reduced-motion: reduce)");

  constructor(private player: Player) {
    document.addEventListener("visibilitychange", () => (document.hidden ? this.stop() : this.start()));
  }

  /// Follow `card` from now on.
  attach(card: Card | null): void {
    if (this.card && this.card !== card) this.card.el?.style.setProperty("--energy", "0");
    this.card = card;
    this.start();
  }

  start(): void {
    if (!this.raf && !document.hidden) this.raf = requestAnimationFrame(this.frame);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private frame = () => {
    this.raf = 0;
    const card = this.card;
    const a = this.player.audio;
    if (!card) return;
    const progress = a.duration ? a.currentTime / a.duration : 0;
    card.drawWave(progress);
    if (!this.reduced.matches) {
      const raw = a.paused ? 0 : this.bass(card, progress);
      // Fast attack, slow release, against a slowly falling peak: kicks stand out
      // the same whether a track is mastered loud or quiet.
      this.level += (raw - this.level) * (raw > this.level ? 0.55 : 0.12);
      this.peak = Math.max(this.peak * 0.997, this.level, 0.2);
      const energy = Math.max(0, (this.level / this.peak - 0.35) / 0.65);
      card.el?.style.setProperty("--energy", energy.toFixed(3));
    }
    // Keep running while playing; one last frame after a pause lets the glow fade.
    if (!a.paused || this.level > 0.01) this.raf = requestAnimationFrame(this.frame);
  };

  private bass(card: Card, progress: number): number {
    const an = this.player.analyser;
    if (!an || !this.player.mixing) return card.loudnessAt(progress) * 0.8;
    if (this.bins?.length !== an.frequencyBinCount) this.bins = new Uint8Array(an.frequencyBinCount);
    an.getByteFrequencyData(this.bins);
    // Bins up to ~150 Hz: kick and sub.
    const hz = an.context.sampleRate / an.fftSize;
    const top = Math.max(2, Math.round(150 / hz));
    let sum = 0;
    for (let i = 1; i <= top; i++) sum += this.bins[i];
    return sum / top / 255;
  }
}
