// What the music is doing right now, in a form visuals can move to.
//
// Loudness alone is useless for bass music: in a dubstep or riddim drop the sub is
// loud and steady, so a loudness meter sits at its maximum and nothing moves. The
// movement is in the changes, so besides slow band levels this tracks onsets (kick,
// snare), the wobble of the mids, and drops (the low end jumping well above where
// it has been).
//
// All constants that shape the feel are here, in one place, for tuning by ear.

export interface Features {
  /// Band levels, 0..1, against the recent range of each band. For slow breathing.
  sub: number;
  low: number;
  mid: number;
  high: number;
  /// Onset envelopes: 1 on a hit, then decaying.
  kick: number;
  snare: number;
  /// Seconds since the last kick; large when there was none.
  kickAge: number;
  /// How much the mids move (wobble bass, growls), 0..1.
  wobble: number;
  /// 0..1, high while the low end sits well above its recent average.
  drop: number;
}

const BANDS = { sub: [30, 90], low: [90, 250], mid: [250, 2000], high: [2000, 10000] } as const;
type Band = keyof typeof BANDS;

const SILENCE_DB = -110;
const CEIL_FALL = 4; // dB/s; a band's ceiling follows its peaks down this slowly
const FLOOR_RISE = 3; // dB/s; and its floor follows the quiet parts up
const MIN_RANGE = 14; // dB; below this a band counts as flat, not as full scale

const ONSET_WINDOW = 0.75; // s of flux history the threshold adapts to
const ONSET_SIGMA = 1.5; // a hit is this many deviations above the mean flux
const ONSET_MIN_FLUX = 1.2; // dB of mean rise per bin; quieter changes are noise
const ONSET_REFRACTORY = 0.11; // s
const KICK_DECAY = 0.16; // s
const SNARE_DECAY = 0.12; // s

const WOBBLE_SMOOTH = 0.12; // s
const DROP_SHORT = 1; // s of low-end loudness …
const DROP_LONG = 12; // … against this much
const DROP_RISE_DB = 2.5; // dB above the long average where a drop starts
const DROP_FULL_DB = 5; // dB above the start for a full drop
const DROP_ATTACK = 0.25; // s
const DROP_RELEASE = 2; // s

const ease = (dt: number, tau: number) => 1 - Math.exp(-dt / tau);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/// Maps a band's dB level into its recent range.
class Range {
  private floor = -60;
  private ceil = -30;

  update(db: number, dt: number): number {
    this.ceil = db > this.ceil ? db : this.ceil - CEIL_FALL * dt;
    this.floor = db < this.floor ? db : this.floor + FLOOR_RISE * dt;
    const span = Math.max(MIN_RANGE, this.ceil - this.floor);
    return clamp01((db - (this.ceil - span)) / span);
  }
}

/// Spectral flux against its own running mean and spread.
class Onset {
  private mean = 0;
  private variance = 1;
  private last = -1;
  env = 0;
  age = 99;

  constructor(private decay: number) {}

  update(flux: number, now: number, dt: number): void {
    const threshold = this.mean + ONSET_SIGMA * Math.sqrt(this.variance);
    const hit = flux > threshold && flux > ONSET_MIN_FLUX && now - this.last > ONSET_REFRACTORY;
    const a = ease(dt, ONSET_WINDOW);
    const d = flux - this.mean;
    this.mean += a * d;
    this.variance += a * (d * d - this.variance);
    this.age += dt;
    if (hit) {
      this.last = now;
      this.env = 1;
      this.age = 0;
    } else {
      this.env *= Math.exp(-dt / this.decay);
    }
  }
}

export class FeatureTracker {
  readonly f: Features = { sub: 0, low: 0, mid: 0, high: 0, kick: 0, snare: 0, kickAge: 99, wobble: 0, drop: 0 };
  private bins: Float32Array<ArrayBuffer> | null = null;
  private prev: Float32Array<ArrayBuffer> | null = null;
  private ranges = { sub: new Range(), low: new Range(), mid: new Range(), high: new Range() };
  private kick = new Onset(KICK_DECAY);
  private snare = new Onset(SNARE_DECAY);
  private lastMid = 0;
  private wobblePeak = 1;
  private short = SILENCE_DB;
  private long = SILENCE_DB;

  /// One frame from the analyser.
  fromAnalyser(an: AnalyserNode, now: number, dt: number): Features {
    const n = an.frequencyBinCount;
    if (this.bins?.length !== n) {
      this.bins = new Float32Array(n);
      this.prev = new Float32Array(n).fill(SILENCE_DB);
    }
    const bins = this.bins, prev = this.prev!;
    an.getFloatFrequencyData(bins);
    const hz = an.context.sampleRate / an.fftSize;
    const bin = (f: number) => Math.min(n - 1, Math.max(1, Math.round(f / hz)));

    const db: Record<Band, number> = { sub: 0, low: 0, mid: 0, high: 0 };
    const flux: Record<Band, number> = { sub: 0, low: 0, mid: 0, high: 0 };
    for (const band of Object.keys(BANDS) as Band[]) {
      const [lo, hi] = BANDS[band];
      const a = bin(lo), b = Math.max(a, bin(hi));
      let power = 0, rise = 0;
      for (let i = a; i <= b; i++) {
        const v = Math.max(SILENCE_DB, bins[i]);
        power += 10 ** (v / 10);
        rise += Math.max(0, v - prev[i]);
        prev[i] = v;
      }
      const count = b - a + 1;
      db[band] = Math.max(SILENCE_DB, 10 * Math.log10(power / count));
      flux[band] = rise / count;
    }

    const f = this.f;
    for (const band of Object.keys(BANDS) as Band[]) f[band] = this.ranges[band].update(db[band], dt);
    this.kick.update((flux.sub + flux.low) / 2, now, dt);
    this.snare.update((flux.mid + flux.high) / 2, now, dt);
    f.kick = this.kick.env;
    f.kickAge = this.kick.age;
    f.snare = this.snare.env;
    this.track(f.mid, Math.max(db.sub, db.low), dt);
    return f;
  }

  /// One frame where there is no analyser: only the loudness from the waveform.
  fromLoudness(level: number, dt: number): Features {
    const f = this.f;
    f.sub = f.low = f.mid = f.high = level;
    f.kick = f.snare = 0;
    f.kickAge = 99;
    this.track(level, level > 0 ? 20 * Math.log10(level) : SILENCE_DB, dt);
    return f;
  }

  /// Nothing playing: let everything settle.
  idle(dt: number): Features {
    const f = this.f;
    const k = Math.exp(-dt / 0.35);
    f.sub *= k; f.low *= k; f.mid *= k; f.high *= k;
    f.kick *= k; f.snare *= k; f.wobble *= k; f.drop *= k;
    f.kickAge += dt;
    return f;
  }

  /// Wobble from how fast the mids move, drop from the low end against its past.
  private track(mid: number, lowDb: number, dt: number): void {
    const f = this.f;
    const speed = Math.abs(mid - this.lastMid) / Math.max(dt, 1 / 240);
    this.lastMid = mid;
    this.wobblePeak = Math.max(1, speed, this.wobblePeak * Math.exp(-dt / 4));
    f.wobble += (clamp01(speed / this.wobblePeak) - f.wobble) * ease(dt, WOBBLE_SMOOTH);

    // Start from the first sound heard, or every track would open with a drop.
    if (this.long <= SILENCE_DB) this.short = this.long = lowDb;
    this.short += (lowDb - this.short) * ease(dt, DROP_SHORT);
    this.long += (lowDb - this.long) * ease(dt, DROP_LONG);
    const target = clamp01((this.short - this.long - DROP_RISE_DB) / DROP_FULL_DB);
    f.drop += (target - f.drop) * ease(dt, target > f.drop ? DROP_ATTACK : DROP_RELEASE);
  }
}
