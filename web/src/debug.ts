// `?debug=audio`: live bars of what features.ts hears, for tuning its constants by
// ear. `?debug=drop`: why the liquid drop does or does not show, readable on a
// phone without remote dev tools. Loaded only when asked for.

import type { Features } from "./features";

const KEYS: (keyof Features)[] = ["sub", "low", "mid", "high", "bass", "growl", "kick", "snare", "wobble", "drop"];

/// Onsets counted since the overlay opened; also on `window.audioDebug` for scripts.
const counts = { kicks: 0, snares: 0, frames: 0 };

export function audioDebug(): (f: Features) => void {
  (window as unknown as { audioDebug: typeof counts }).audioDebug = counts;
  let lastAge = 99, lastSnare = 0;
  const canvas = document.createElement("canvas");
  canvas.className = "audio-debug";
  const w = (canvas.width = 300), h = (canvas.height = 124);
  document.body.append(canvas);
  const ctx = canvas.getContext("2d")!;
  ctx.font = "10px system-ui, sans-serif";
  const bar = w / KEYS.length;
  return (f) => {
    counts.frames++;
    if (f.kickAge < lastAge) counts.kicks++;
    if (f.snare > lastSnare + 0.5) counts.snares++;
    lastAge = f.kickAge;
    lastSnare = f.snare;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#fff9";
    ctx.fillText(`kicks ${counts.kicks} · snares ${counts.snares}`, 4, 11);
    KEYS.forEach((k, i) => {
      const v = Math.min(1, Math.max(0, f[k]));
      ctx.fillStyle = k === "kick" || k === "snare" ? "#ff4d6d" : k === "drop" ? "#ffb02e" : "#7fd4ff";
      ctx.fillRect(i * bar + 3, h - 14 - v * (h - 30), bar - 6, v * (h - 30));
      ctx.fillStyle = "#fff9";
      ctx.fillText(k, i * bar + 3, h - 3);
    });
  };
}

/// A box of text, rewritten at most a few times a second.
export function dropDebug(): (text: string) => void {
  const el = document.createElement("pre");
  el.className = "audio-debug drop-debug";
  document.body.append(el);
  let at = 0;
  return (text) => {
    const now = performance.now();
    if (now - at < 250) return;
    at = now;
    el.textContent = text;
  };
}
