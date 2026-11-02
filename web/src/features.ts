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
  /// Set for the one frame a hit lands: how prominent it is against recent hits,
  /// 0..1 (the loudest hits of the last seconds are 1). 0 on every other frame.
  kickHit: number;
  snareHit: number;
  /// How much the mids move (wobble bass, growls), 0..1.
  wobble: number;
  /// The bass line's own envelope, 0..1 against the last moment: follows every
  /// "womb" of a riddim wobble up and down.
  bass: number;
  /// How open the wobble's filter is, 0..1: low for a dark "oo", high for a bright
  /// "wah" (spectral centroid of the bass and mids against its recent range).
  growl: number;
  /// 0..1, high while the low end sits well above its recent average.
  drop: number;
  /// 0..1, high while the low end has dropped out after sounding: the stop before a
  /// drop, the gaps a riddim leaves.
  gap: number;
  /// How often the bass line goes "womb", Hz; 0 until there were a few.
  wobbleRate: number;
  /// Where the music is in its bar, from the track's tempo locked onto the kicks:
  /// `beat` 0..1 within the beat, `beatNo` 0..3, `bar` 0..1 within the bar.
  beat: number;
  beatNo: number;
  bar: number;
  /// Seconds per beat.
  period: number;
  /// How sure the bar is: the strength of recent kicks on the downbeat. Above
  /// about 2 the downbeat has been hit several times in the last seconds.
  lock: number;
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
const PROMINENCE_MEMORY = 6; // s; a hit is weighed against the strongest ones this recent

const WOBBLE_SMOOTH = 0.12; // s
const BASS_BAND = [40, 400]; // Hz; body of a wobble bass
const BASS_FOLLOW = 14; // dB/s; its range forgets this fast, so each wub spans it
const BASS_MIN_RANGE = 6; // dB
const BASS_ATTACK = 0.015; // s
const BASS_RELEASE = 0.06; // s
const GROWL_BAND = [100, 3000]; // Hz
const GROWL_FOLLOW = 0.6; // octaves/s
const GROWL_MIN_RANGE = 1.2; // octaves
const GROWL_SMOOTH = 0.05; // s
const DROP_SHORT = 1; // s of low-end loudness …
const DROP_LONG = 12; // … against this much
const DROP_HEARD_DB = -70; // the low end counts as sounding above this
const DROP_RISE_DB = 2.5; // dB above the long average where a drop starts
const DROP_FULL_DB = 5; // dB above the start for a full drop
const DROP_ATTACK = 0.25; // s
const DROP_RELEASE = 2; // s
const GAP_DB = 12; // dB under the long average where the low end counts as gone …
const GAP_FULL_DB = 12; // … and this much more for a full gap
const GAP_ATTACK = 0.06; // s
const GAP_RELEASE = 0.12; // s
const GAP_HEARD = 2; // s of sound before a gap can be one
const WOMB_UP = 0.62; // the bass envelope crossing up through this is one "womb" …
const WOMB_DOWN = 0.38; // … once it fell below this since the last
const WOMB_MIN = 0.06; // s; closer wombs are one
const WOMB_MAX = 1.5; // s; further apart, the wobble stopped
const WOMB_SMOOTH = 0.25; // weight of each new interval
const BEATS_PER_BAR = 4;
const BEAT_PULL = 0.25; // how far a kick pulls the beat towards itself
const BEAT_MIN_HIT = 0.3; // kicks weaker than this leave the beat alone
const DOWNBEAT_MEMORY = 8; // s; the downbeat is the slot with the strongest kicks this recent
// Without an analyser the waveform stands in. Its steps are coarse, so a rise from
// one step to the next is the only "onset" there is.
const LOUD_FLOOR = 0.02; // loudness treated as silence, so a rise from nothing is finite

const ease = (dt: number, tau: number) => 1 - Math.exp(-dt / tau);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/// Maps a value (a band's dB level) into its recent range.
class Range {
  constructor(
    private floor = -60,
    private ceil = -30,
    private ceilFall = CEIL_FALL,
    private floorRise = FLOOR_RISE,
    private minRange = MIN_RANGE,
  ) {}

  update(x: number, dt: number): number {
    this.ceil = x > this.ceil ? x : this.ceil - this.ceilFall * dt;
    this.floor = x < this.floor ? x : this.floor + this.floorRise * dt;
    const span = Math.max(this.minRange, this.ceil - this.floor);
    return clamp01((x - (this.ceil - span)) / span);
  }
}

/// Spectral flux against its own running mean and spread.
class Onset {
  private mean = 0;
  private variance = 1;
  private last = -1;
  private peak = ONSET_MIN_FLUX;
  env = 0;
  age = 99;
  hit = 0;

  constructor(private decay: number) {}

  update(flux: number, now: number, dt: number): void {
    const threshold = this.mean + ONSET_SIGMA * Math.sqrt(this.variance);
    const hit = flux > threshold && flux > ONSET_MIN_FLUX && now - this.last > ONSET_REFRACTORY;
    const a = ease(dt, ONSET_WINDOW);
    const d = flux - this.mean;
    this.mean += a * d;
    this.variance += a * (d * d - this.variance);
    this.age += dt;
    this.peak = Math.max(ONSET_MIN_FLUX, this.peak * Math.exp(-dt / PROMINENCE_MEMORY));
    this.hit = 0;
    if (hit) {
      this.peak = Math.max(this.peak, flux);
      this.hit = clamp01(flux / this.peak);
      this.last = now;
      this.env = 1;
      this.age = 0;
    } else {
      this.env *= Math.exp(-dt / this.decay);
    }
  }
}

export class FeatureTracker {
  readonly f: Features = {
    sub: 0, low: 0, mid: 0, high: 0, kick: 0, snare: 0, kickAge: 99, kickHit: 0, snareHit: 0, wobble: 0, bass: 0, growl: 0,
    drop: 0, gap: 0, wobbleRate: 0, beat: 0, beatNo: 0, bar: 0, period: 60 / 140, lock: 0,
  };
  /// Seconds per beat, from the track's BPM.
  private period = 60 / 140;
  /// Beats since the track started, kept in step with the kicks.
  private phase = 0;
  /// Kick strength per beat of the bar, fading; the strongest slot is the downbeat.
  private slots = [0, 0, 0, 0];
  private wombAt = -1;
  private wombArmed = true;
  private bins: Float32Array<ArrayBuffer> | null = null;
  private prev: Float32Array<ArrayBuffer> | null = null;
  private ranges = { sub: new Range(), low: new Range(), mid: new Range(), high: new Range() };
  private kick = new Onset(KICK_DECAY);
  /// Kicks from the waveform's steps, where there is no analyser.
  private loudKick = new Onset(KICK_DECAY * 1.5);
  private lastLevel = 0;
  private snare = new Onset(SNARE_DECAY);
  private bassRange = new Range(-60, -30, BASS_FOLLOW, BASS_FOLLOW, BASS_MIN_RANGE);
  private growlRange = new Range(7, 9, GROWL_FOLLOW, GROWL_FOLLOW, GROWL_MIN_RANGE);
  private lastMid = 0;
  private wobblePeak = 1;
  private short = SILENCE_DB;
  private long = SILENCE_DB;
  /// Seconds of sound heard so far: the long average covers no more than that, so
  /// music that starts in the middle of a drop is the baseline, not a drop.
  private heard = 0;

  /// A new track: its tempo, and nothing carried over about where its bar is.
  /// Half-time notation (70 for a 140 tune) counts double.
  setTempo(bpm: number | null): void {
    let b = bpm && bpm >= 50 && bpm <= 220 ? bpm : 140;
    if (b < 100) b *= 2;
    this.period = this.f.period = 60 / b;
    this.phase = 0;
    this.slots = [0, 0, 0, 0];
    this.wombAt = -1;
    this.f.wobbleRate = 0;
    this.f.lock = 0;
  }

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

    // The wobble: loudness of the bass body, and where its energy sits.
    let bassPower = 0;
    for (let i = bin(BASS_BAND[0]); i <= bin(BASS_BAND[1]); i++) bassPower += 10 ** (Math.max(SILENCE_DB, bins[i]) / 10);
    const bassDb = Math.max(SILENCE_DB, 10 * Math.log10(bassPower / (bin(BASS_BAND[1]) - bin(BASS_BAND[0]) + 1)));
    const bass = this.bassRange.update(bassDb, dt);
    f.bass += (bass - f.bass) * ease(dt, bass > f.bass ? BASS_ATTACK : BASS_RELEASE);
    let weight = 0, sum = 0;
    for (let i = bin(GROWL_BAND[0]); i <= bin(GROWL_BAND[1]); i++) {
      const p = 10 ** (Math.max(SILENCE_DB, bins[i]) / 10);
      weight += p;
      sum += p * Math.log2(i * hz);
    }
    if (weight > 0) f.growl += (this.growlRange.update(sum / weight, dt) - f.growl) * ease(dt, GROWL_SMOOTH);
    this.kick.update((flux.sub + flux.low) / 2, now, dt);
    this.snare.update((flux.mid + flux.high) / 2, now, dt);
    f.kick = this.kick.env;
    f.kickAge = this.kick.age;
    f.kickHit = this.kick.hit;
    f.snare = this.snare.env;
    f.snareHit = this.snare.hit;
    this.track(f.mid, Math.max(db.sub, db.low), dt);
    this.rhythm(now, dt);
    return f;
  }

  /// One frame where there is no analyser: only the loudness from the waveform.
  /// Jumps in it count as kicks, so the drop still lands on the drops.
  fromLoudness(level: number, now: number, dt: number): Features {
    const f = this.f;
    f.sub = f.low = f.mid = f.high = f.bass = level;
    f.growl = 0.3;
    const rise = 20 * Math.log10(Math.max(LOUD_FLOOR, level) / Math.max(LOUD_FLOOR, this.lastLevel));
    this.lastLevel = level;
    this.loudKick.update(Math.max(0, rise), now, dt);
    f.kick = this.loudKick.env;
    f.kickAge = this.loudKick.age;
    f.kickHit = this.loudKick.hit;
    f.snare = f.snareHit = 0;
    this.track(level, level > 0 ? 20 * Math.log10(level) : SILENCE_DB, dt);
    this.rhythm(now, dt);
    return f;
  }

  /// Nothing playing: let everything settle.
  idle(dt: number): Features {
    const f = this.f;
    const k = Math.exp(-dt / 0.35);
    f.sub *= k; f.low *= k; f.mid *= k; f.high *= k;
    f.kick *= k; f.snare *= k; f.wobble *= k; f.drop *= k; f.bass *= k; f.growl *= k; f.gap *= k;
    f.kickAge += dt;
    f.kickHit = f.snareHit = 0;
    return f;
  }

  /// Wobble from how fast the mids move, drop from the low end against its past.
  private track(mid: number, lowDb: number, dt: number): void {
    const f = this.f;
    const speed = Math.abs(mid - this.lastMid) / Math.max(dt, 1 / 240);
    this.lastMid = mid;
    this.wobblePeak = Math.max(1, speed, this.wobblePeak * Math.exp(-dt / 4));
    f.wobble += (clamp01(speed / this.wobblePeak) - f.wobble) * ease(dt, WOBBLE_SMOOTH);

    if (this.heard === 0) {
      if (lowDb < DROP_HEARD_DB) return;
      this.short = this.long = lowDb;
    }
    this.heard += dt;
    this.short += (lowDb - this.short) * ease(dt, DROP_SHORT);
    this.long += (lowDb - this.long) * ease(dt, Math.min(DROP_LONG, DROP_SHORT + this.heard));
    const target = clamp01((this.short - this.long - DROP_RISE_DB) / DROP_FULL_DB);
    f.drop += (target - f.drop) * ease(dt, target > f.drop ? DROP_ATTACK : DROP_RELEASE);
    // The gap is against this frame's level: a stop of half a bar is over before
    // a smoothed level would notice it.
    const gap = this.heard < GAP_HEARD ? 0 : clamp01((this.long - lowDb - GAP_DB) / GAP_FULL_DB);
    f.gap += (gap - f.gap) * ease(dt, gap > f.gap ? GAP_ATTACK : GAP_RELEASE);
  }

  /// The beat and the bar, and the rate of the wobble.
  private rhythm(now: number, dt: number): void {
    const f = this.f;
    this.phase += dt / this.period;
    const fade = Math.exp(-dt / DOWNBEAT_MEMORY);
    for (let i = 0; i < BEATS_PER_BAR; i++) this.slots[i] *= fade;
    if (f.kickHit >= BEAT_MIN_HIT) {
      // A kick lands on the nearest beat: pull the clock towards it.
      const nearest = Math.round(this.phase);
      this.phase -= (this.phase - nearest) * BEAT_PULL * f.kickHit;
      const slot = ((nearest % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR;
      this.slots[slot] += f.kickHit;
    }
    f.lock = Math.max(...this.slots);
    const down = this.slots.indexOf(f.lock);
    const inBar = (((this.phase - down) % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR;
    f.beatNo = Math.floor(inBar);
    f.beat = inBar - f.beatNo;
    f.bar = inBar / BEATS_PER_BAR;

    // Each "womb" of the bass is its envelope rising through WOMB_UP.
    if (f.bass < WOMB_DOWN) this.wombArmed = true;
    if (this.wombArmed && f.bass > WOMB_UP) {
      this.wombArmed = false;
      const since = this.wombAt < 0 ? Infinity : now - this.wombAt;
      if (since >= WOMB_MIN) {
        if (since <= WOMB_MAX) {
          const rate = 1 / since;
          f.wobbleRate = f.wobbleRate ? f.wobbleRate + (rate - f.wobbleRate) * WOMB_SMOOTH : rate;
        }
        this.wombAt = now;
      }
    }
    if (this.wombAt >= 0 && now - this.wombAt > WOMB_MAX * 2) f.wobbleRate *= Math.exp(-dt / 0.5);
  }
}
