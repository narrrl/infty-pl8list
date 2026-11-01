// Audio playback with two decks, so the next track can be preloaded and tracks
// crossfade into each other.
//
// Where the browser allows it, both <audio> elements run through a Web Audio graph:
// a gain per deck (for the crossfade) into one analyser (for the visuals), then a
// master gain for the volume, so the visuals look the same at any volume. iOS is
// left out: its element volume is read-only and Web Audio stops when the screen
// locks, which would break lock-screen playback. There tracks switch with a cut.

import type HlsType from "hls.js/light";
import { type Track, streamUrl } from "./api";

const CROSSFADE = 0.9; // seconds
const PRELOAD_BUFFER = 6; // seconds buffered of the track after the current one
const PLAY_BUFFER = 30;
const VOLUME_KEY = "pl8inf.volume";

type Hls = HlsType;
type HlsClass = typeof HlsType;

let hlsClass: Promise<HlsClass | null> | null = null;
/// Set once the module has loaded, so later loads can attach synchronously and
/// play() still runs inside the user's tap (iOS insists on that).
let hlsLoaded: HlsClass | null | undefined;

/// hls.js where it works (MSE), otherwise null and the browser plays HLS itself (Safari).
function loadHls(): Promise<HlsClass | null> {
  hlsClass ??= import("hls.js/light")
    .then((m) => (m.default.isSupported() ? m.default : null))
    .catch(() => null)
    .then((h) => (hlsLoaded = h));
  return hlsClass;
}

interface Deck {
  el: HTMLAudioElement;
  hls: Hls | null;
  gain: GainNode | null;
  track: Track | null;
  /// Should be playing as soon as its source is attached.
  wantPlay: boolean;
  /// Bumped on every load/unload, so late callbacks of an old load do nothing.
  gen: number;
}

export type PlayerEvent = "timeupdate" | "ended" | "play" | "pause" | "waiting" | "playing" | "failed";

const FORWARDED: PlayerEvent[] = ["timeupdate", "ended", "play", "pause", "waiting", "playing"];

/// Equal-power fade of `param` from its current value to `to`. A fade can start
/// while the previous one still runs (fast flicking), so it starts where that one is.
function fade(param: AudioParam, to: number, at: number): void {
  const from = param.value;
  param.cancelScheduledValues(0);
  const up = to > from;
  const curve = Float32Array.from({ length: 32 }, (_, i) => {
    const x = (i / 31) * (Math.PI / 2);
    return up ? from + (to - from) * Math.sin(x) : to + (from - to) * Math.cos(x);
  });
  try {
    param.setValueCurveAtTime(curve, at, CROSSFADE);
  } catch {
    param.value = to;
  }
}

export class Player {
  private decks: [Deck, Deck];
  private cur = 0;
  private ctx: AudioContext | null = null;
  private unlocking: Promise<void> | null = null;
  private fadeEnd = 0;
  private master: GainNode | null = null;
  private vol = Number(localStorage.getItem(VOLUME_KEY) ?? 1);
  private listeners = new Map<PlayerEvent, Set<() => void>>();
  analyser: AnalyserNode | null = null;
  /// False on iOS, see the top of this file.
  readonly canMix: boolean;

  constructor() {
    const probe = document.createElement("audio");
    probe.volume = 0.5;
    this.canMix = probe.volume === 0.5 && "AudioContext" in window;
    const deck = (): Deck => {
      const el = document.createElement("audio");
      el.preload = "auto";
      document.body.append(el);
      return { el, hls: null, gain: null, track: null, wantPlay: false, gen: 0 };
    };
    this.decks = [deck(), deck()];
    if (!(this.vol >= 0 && this.vol <= 1)) this.vol = 1;
    this.volume = this.vol;
    for (const d of this.decks) {
      for (const ev of FORWARDED) {
        d.el.addEventListener(ev, () => {
          if (d === this.decks[this.cur]) this.emit(ev);
        });
      }
      // hls.js reports its own errors; this is for native HLS.
      d.el.addEventListener("error", () => {
        if (d === this.decks[this.cur] && !d.hls && d.track) this.emit("failed");
      });
    }
    loadHls(); // start fetching the module early
  }

  on(ev: PlayerEvent, fn: () => void): void {
    if (!this.listeners.has(ev)) this.listeners.set(ev, new Set());
    this.listeners.get(ev)!.add(fn);
  }

  private emit(ev: PlayerEvent): void {
    this.listeners.get(ev)?.forEach((fn) => fn());
  }

  /// The element of the current deck, for time, duration and pause state.
  get audio(): HTMLAudioElement {
    return this.decks[this.cur].el;
  }

  get track(): Track | null {
    return this.decks[this.cur].track;
  }

  /// True while two tracks are mixed and crossfades work.
  get mixing(): boolean {
    return this.ctx?.state === "running";
  }

  /// Call from a user gesture. Sets up the Web Audio graph where the browser can mix.
  unlock(): Promise<void> {
    if (this.ctx) {
      if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
      return Promise.resolve();
    }
    if (!this.canMix) return Promise.resolve();
    this.unlocking ??= this.setUpGraph();
    return this.unlocking;
  }

  private async setUpGraph(): Promise<void> {
    let ctx: AudioContext;
    try {
      ctx = new AudioContext();
      await ctx.resume();
    } catch {
      return;
    }
    // Routing an element through the graph can't be undone, and a suspended graph
    // is silent, so only route once it actually runs.
    if (ctx.state !== "running") {
      ctx.close();
      this.unlocking = null;
      return;
    }
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.2; // features.ts smooths per feature; this only takes the edge off the FFT
    const master = ctx.createGain();
    analyser.connect(master).connect(ctx.destination);
    for (const d of this.decks) {
      d.el.volume = 1; // the master gain takes over
      const gain = ctx.createGain();
      gain.gain.value = d === this.decks[this.cur] ? 1 : 0;
      ctx.createMediaElementSource(d.el).connect(gain).connect(analyser);
      d.gain = gain;
    }
    this.ctx = ctx;
    this.analyser = analyser;
    this.master = master;
    this.volume = this.vol;
  }

  /// Play a track, crossfading from the current one when possible.
  async play(track: Track): Promise<void> {
    const from = this.decks[this.cur];
    if (from.track?.id === track.id) {
      from.wantPlay = true;
      from.el.play().catch(() => {});
      return;
    }
    const toIdx = 1 - this.cur;
    const to = this.decks[toIdx];
    if (to.track?.id === track.id && performance.now() >= this.fadeEnd) {
      if (to.hls) to.hls.config.maxBufferLength = PLAY_BUFFER;
    } else {
      this.load(to, track, PLAY_BUFFER);
    }
    const crossfade = this.mixing && !document.hidden && !from.el.paused && from.track !== null;
    this.cur = toIdx;
    to.wantPlay = true;
    if (this.ctx?.state === "suspended") this.ctx.resume().catch(() => {});
    if (crossfade && to.gain && from.gain) {
      const t = this.ctx!.currentTime;
      fade(to.gain.gain, 1, t);
      fade(from.gain.gain, 0, t);
      this.fadeEnd = performance.now() + CROSSFADE * 1000;
      const gen = from.gen;
      setTimeout(() => {
        if (from.gen === gen && from !== this.decks[this.cur]) this.unload(from);
      }, CROSSFADE * 1000 + 50);
    } else {
      if (to.gain) {
        to.gain.gain.cancelScheduledValues(0);
        to.gain.gain.value = 1;
      }
      this.unload(from);
    }
    if (to.hls || to.el.hasAttribute("src")) to.el.play().catch(() => {});
  }

  /// Buffer the start of the track that is likely to come next.
  preload(track: Track): void {
    const wait = this.fadeEnd - performance.now();
    if (wait > 0) {
      setTimeout(() => this.preload(track), wait + 100);
      return;
    }
    const idle = this.decks[1 - this.cur];
    if (idle.track?.id !== track.id) this.load(idle, track, PRELOAD_BUFFER);
  }

  private load(d: Deck, track: Track, buffer: number): void {
    this.unload(d);
    const gen = d.gen;
    d.track = track;
    const url = streamUrl(track);
    const attach = (Hls: HlsClass | null) => {
      if (d.gen !== gen) return;
      if (Hls) {
        const hls = new Hls({ maxBufferLength: buffer, maxMaxBufferLength: 60 });
        hls.on(Hls.Events.ERROR, (_, data) => {
          if (!data.fatal || d.gen !== gen) return;
          console.warn("hls fatal", data.details);
          if (d === this.decks[this.cur]) this.emit("failed");
          else this.unload(d);
        });
        hls.loadSource(url);
        hls.attachMedia(d.el);
        d.hls = hls;
      } else {
        d.el.src = url;
      }
      if (d.wantPlay) d.el.play().catch(() => {});
    };
    if (hlsLoaded !== undefined) attach(hlsLoaded);
    else loadHls().then(attach);
  }

  private unload(d: Deck): void {
    d.gen++;
    d.wantPlay = false;
    d.hls?.destroy();
    d.hls = null;
    d.track = null;
    d.el.pause();
    if (d.el.hasAttribute("src")) {
      d.el.removeAttribute("src");
      d.el.load();
    }
    if (d.gain) {
      d.gain.gain.cancelScheduledValues(0);
      d.gain.gain.value = 0;
    }
  }

  toggle(): void {
    if (this.audio.paused) this.resume();
    else this.pause();
  }

  resume(): void {
    if (this.ctx?.state === "suspended") this.ctx.resume().catch(() => {});
    this.decks[this.cur].wantPlay = true;
    this.audio.play().catch(() => {});
  }

  pause(): void {
    this.decks[this.cur].wantPlay = false;
    this.audio.pause();
  }

  seek(seconds: number): void {
    const a = this.audio;
    a.currentTime = Math.max(0, Math.min(a.duration || 0, seconds));
  }

  get muted(): boolean {
    return this.decks[0].el.muted;
  }

  set muted(m: boolean) {
    for (const d of this.decks) d.el.muted = m;
  }

  /// 0 to 1, as the slider shows it. Squared on the way out, so it sounds even.
  /// Without a graph the element volumes carry it; on iOS they are read-only.
  get volume(): number {
    return this.vol;
  }

  set volume(v: number) {
    this.vol = Math.max(0, Math.min(1, v));
    localStorage.setItem(VOLUME_KEY, String(this.vol));
    const out = this.vol * this.vol;
    if (this.master) this.master.gain.value = out;
    else for (const d of this.decks) d.el.volume = out;
  }
}
