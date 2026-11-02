// The character of the drop for one track, from its tempo, tags and key. Each
// field is a shader uniform; tune here.

import type { Track } from "../api";

export interface Look {
  /// Flow speed of the noise.
  flow: number;
  /// Overall size of the movement.
  gain: number;
  /// Spikes on snares and bright wobbles.
  spike: number;
  /// 0 smooth, 1 stepped (stiff, quantised) lobes.
  step: number;
  /// How much the bass line's envelope swells the whole drop.
  throb: number;
  /// How high prominent hits make the drop jump.
  bounce: number;
  /// Spring stiffness of the jump: higher snaps back faster, lower floats.
  stiff: number;
  twist: number;
  /// Fine ripples from the wobble.
  ripple: number;
  /// Ring that runs over the surface on each kick.
  shock: number;
  /// Rim hue drift.
  iri: number;
  metal: number;
  heat: number;
  /// Rim hue offset from the key, radians.
  hue: number;
  /// Solar flares (flares.ts): 0 off, 1 full. "auto" in the settings shows them
  /// where this is above 0.
  flares: number;
  /// Loop positions round the drop: one per beat for a riddim (4), so each bar
  /// draws the same crown again.
  crown: number;
  /// How far off those positions a loop may land, 0..1 of the gap between them.
  scatter: number;
  /// Loop height over the surface, in radii.
  arch: number;
  /// Beats a loop lives.
  life: number;
  /// Snares weaker than this pinch no loop.
  erupt: number;
}

const BASE: Look = {
  flow: 1, gain: 1, spike: 0.5, step: 0, throb: 1, bounce: 1, stiff: 90, twist: 0.15, ripple: 1, shock: 1, iri: 0.1, metal: 0.3, heat: 0, hue: 0,
  flares: 0, crown: 6, scatter: 0.4, arch: 0.32, life: 4, erupt: 0.45,
};

const TAGS: Record<string, (l: Look) => void> = {
  // Riddim: the loops snap to the beat and the crown repeats every bar.
  riddim: (l) => Object.assign(l, {
    step: 0.5, spike: 0.6, throb: 1.4, bounce: 1.3, stiff: 120, metal: 0.9, shock: 1.4, ripple: 1.2,
    flares: 1, crown: 4, scatter: 0, arch: 0.36, life: 4, erupt: 0.4,
  }),
  tearout: (l) => Object.assign(l, { spike: 1.3, bounce: 1.4, gain: l.gain * 1.15, heat: 0.7, flares: 1, crown: 6, scatter: 0.5, erupt: 0.25 }),
  deathstep: (l) => Object.assign(l, { spike: 1.4, bounce: 1.4, gain: l.gain * 1.15, heat: 0.9, metal: 0.7, flares: 1, crown: 6, scatter: 0.6, erupt: 0.2 }),
  melodic: (l) => Object.assign(l, {
    iri: 0.8, spike: 0.15, throb: 0.7, bounce: 0.6, stiff: 55, gain: l.gain * 0.9, flow: l.flow * 0.8, metal: 0.1,
    flares: 0, crown: 5, scatter: 0.3, arch: 0.45, life: 8, erupt: 0.8,
  }),
  colourbass: (l) => Object.assign(l, { iri: 1, spike: 0.25, bounce: 0.8, stiff: 70, metal: 0.15 }),
  dnb: (l) => Object.assign(l, { ripple: 1.6 }),
  "170": (l) => Object.assign(l, { ripple: 1.5 }),
  halftime: (l) => Object.assign(l, { flow: l.flow * 0.7, gain: l.gain * 1.15, stiff: 70, crown: 2, arch: 0.45 }),
  wonk: (l) => Object.assign(l, { twist: 0.9 }),
};

export function lookFor(t: Track): Look {
  // About one noise cycle per bar.
  const l: Look = { ...BASE, flow: ((t.bpm || 140) / 240) * 0.9 };
  const tags = t.tags ?? [];
  // Untagged dubstep tempo counts too: most riddim carries no riddim tag.
  if (tags.includes("140")) l.flares = 1;
  for (const tag of tags) TAGS[tag]?.(l);
  l.hue = keyHue(t.key);
  return l;
}

const PITCH: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/// Keys a fifth apart get neighbouring hues: up to ±26° around the accent colour.
function keyHue(key: string | null): number {
  const m = key?.trim().match(/^([a-g])\s*([#♯b♭]?)\s*(.*)$/i);
  if (!m) return 0;
  let pc = PITCH[m[1].toLowerCase()] + (/[#♯]/.test(m[2]) ? 1 : /[b♭]/.test(m[2]) ? -1 : 0);
  // A minor key sits with its relative major.
  if (/^(m(?!aj)|min)/i.test(m[3])) pc += 3;
  const fifths = (((pc * 7) % 12) + 12) % 12;
  return (fifths / 12 - 0.5) * 0.9;
}
