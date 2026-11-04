// Ferrofluid spikes: the drop is a magnetic liquid, and the bass is the field. A
// fixed lattice of points on the drop each grows a spike, the way ferrofluid does
// over a magnet; this file steps how tall each one stands, and the vertex shader
// (shaders.ts) pushes the surface out into them.
//
// - The bass line's envelope is the field: every "womb" raises the whole lattice,
//   and on a riddim the drop goes from smooth to hedgehog and back on each one.
// - Each kick charges the spikes round one spot on the rim. Where follows the beat,
//   so a riddim, which puts the same kick on the same beat bar after bar, raises the
//   same crown every bar (`Look.crown` positions, `Look.scatter` off them).
// - A snare jolts them, the charged ones most.
// - In a gap (the stop before a drop) they melt flat; the drop then charges all of
//   them at once.
//
// Each height is a spring, stiff on the way up so a spike snaps out and overshoots,
// softer on the way down so it melts back.

import type { Features } from "../features";
import type { Look } from "./style";

/// Spikes on the lattice; the shader has an array of this size.
export const SPIKES = 60;
const KICK_MIN = 0.2; // weaker kicks charge nothing
const PATCH = 0.55; // radius of the patch a kick charges, as a chord of the unit sphere
const DROP_BURST = 0.55; // the drop rising through this charges every spike
const RISE = [170, 13]; // stiffness, damping on the way up
const FALL = [55, 12]; // and on the way down
const MAX = 0.45; // radii

export class Ferro {
  /// Per spike: direction in the drop's own space, then height. Goes to `uSpikes`.
  readonly data = new Float32Array(SPIKES * 4);
  private height = new Float32Array(SPIKES);
  private speed = new Float32Array(SPIKES);
  private charge = new Float32Array(SPIKES);
  private seed = new Float32Array(SPIKES);
  private clock = 0;
  private dropArmed = true;
  /// Where on the crown the next kick lands, for tracks with scatter.
  private turn = Math.random();
  /// The tallest spike, so the shader can skip them all when there are none.
  tallest = 0;

  constructor() {
    // A Fibonacci lattice: near enough even spacing, close to the hexagons that real
    // ferrofluid settles into.
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < SPIKES; i++) {
      const y = 1 - ((i + 0.5) / SPIKES) * 2;
      const r = Math.sqrt(1 - y * y);
      this.data.set([Math.cos(golden * i) * r, y, Math.sin(golden * i) * r, 0], i * 4);
      this.seed[i] = (i * 0.618034) % 1;
    }
  }

  /// A new track: nothing carried over.
  reset(): void {
    this.height.fill(0);
    this.speed.fill(0);
    this.charge.fill(0);
    this.dropArmed = true;
    this.tallest = 0;
    for (let i = 0; i < SPIKES; i++) this.data[i * 4 + 3] = 0;
  }

  /// Step the spikes by `dt`. `strength` 0 lets them melt back. True while any moves.
  frame(f: Features, dt: number, look: Look, playing: boolean, strength: number, toObject: (x: number, y: number, z: number) => [number, number, number]): boolean {
    const on = playing && strength > 0;
    const reach = look.reach * Math.min(1, strength);
    const n = SPIKES;
    this.clock += dt;
    if (on && f.kickHit >= KICK_MIN && f.gap < 0.5) this.kick(f, look, reach, toObject);
    if (f.drop < 0.2) this.dropArmed = true;
    if (on && f.drop > DROP_BURST && this.dropArmed) {
      this.dropArmed = false;
      for (let i = 0; i < n; i++) {
        this.charge[i] = 1;
        this.speed[i] += 2.5 * reach;
      }
    }

    if (on && f.snareHit >= look.jolt) {
      for (let i = 0; i < n; i++) this.speed[i] += f.snareHit * reach * (0.5 + 3 * this.charge[i]);
    }

    // A kick's charge holds for `Look.hold` beats.
    const fade = Math.exp(-dt / Math.max(0.05, look.hold * f.period * 0.5));
    const field = (0.08 + 0.6 * f.bass + 0.2 * f.wobble * f.growl + 0.35 * f.drop) * (1 - 0.9 * f.gap);
    // Stepped tracks keep the lattice in step; the rest let it breathe unevenly.
    const even = Math.min(1, look.step * 2);
    let tallest = 0;
    let moving = false;
    for (let i = 0; i < n; i++) {
      this.charge[i] *= fade;
      const breathe = 0.55 + 0.45 * Math.sin(this.seed[i] * 6.2832 + this.clock * 0.9);
      const goal = on ? reach * (field * (even + (1 - even) * breathe) + 0.9 * this.charge[i]) : 0;
      let h = this.height[i], v = this.speed[i];
      const [k, d] = goal > h ? RISE : FALL;
      // Small fixed steps keep the springs stable on slow frames.
      for (let left = Math.min(dt, 0.1); left > 0; left -= 1 / 240) {
        const s = Math.min(left, 1 / 240);
        v += (-k * (h - goal) - d * v) * s;
        h += v * s;
      }
      h = Math.min(MAX, Math.max(-0.03, h));
      this.height[i] = h;
      this.speed[i] = v;
      const shown = Math.max(0, h);
      this.data[i * 4 + 3] = shown;
      tallest = Math.max(tallest, shown);
      if (Math.abs(h - goal) > 0.002 || Math.abs(v) > 0.01) moving = true;
    }
    this.tallest = tallest;
    return moving || tallest > 0.002;
  }

  /// Charge the spikes round the rim where the beat says, as seen from the front, so
  /// they stand out against the page.
  private kick(f: Features, look: Look, reach: number, toObject: (x: number, y: number, z: number) => [number, number, number]): void {
    const crown = Math.max(1, Math.round(look.crown));
    let slot: number;
    if (look.scatter === 0) slot = Math.round(f.bar * crown) % crown;
    else {
      this.turn = (this.turn + 1 + (Math.random() - 0.5) * look.scatter) % crown;
      slot = this.turn;
    }
    // Upright crowns read best: the first slot sits at the top.
    const angle = Math.PI / 2 - (slot / crown) * Math.PI * 2;
    const z = 0.15 + Math.random() * 0.2;
    const r = Math.sqrt(1 - z * z);
    const [cx, cy, cz] = toObject(Math.cos(angle) * r, Math.sin(angle) * r, z);
    for (let i = 0; i < SPIKES; i++) {
      const d = this.data;
      const chord2 = (d[i * 4] - cx) ** 2 + (d[i * 4 + 1] - cy) ** 2 + (d[i * 4 + 2] - cz) ** 2;
      const w = f.kickHit * Math.exp(-chord2 / (PATCH * PATCH));
      if (w < 0.02) continue;
      this.charge[i] = Math.max(this.charge[i], w);
      // Snapped out, so it overshoots its charge once.
      this.speed[i] += 9 * w * reach;
    }
  }
}
