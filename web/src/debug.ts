// `?debug=audio`: live bars of what features.ts hears, for tuning its constants by
// ear. Loaded only when asked for.

import type { Features } from "./features";

const KEYS: (keyof Features)[] = ["sub", "low", "mid", "high", "kick", "snare", "wobble", "drop"];

export function audioDebug(): (f: Features) => void {
  const canvas = document.createElement("canvas");
  canvas.className = "audio-debug";
  const w = (canvas.width = 240), h = (canvas.height = 110);
  document.body.append(canvas);
  const ctx = canvas.getContext("2d")!;
  ctx.font = "10px system-ui, sans-serif";
  const bar = w / KEYS.length;
  return (f) => {
    ctx.clearRect(0, 0, w, h);
    KEYS.forEach((k, i) => {
      const v = Math.min(1, Math.max(0, f[k]));
      ctx.fillStyle = k === "kick" || k === "snare" ? "#ff4d6d" : k === "drop" ? "#ffb02e" : "#7fd4ff";
      ctx.fillRect(i * bar + 3, h - 14 - v * (h - 20), bar - 6, v * (h - 20));
      ctx.fillStyle = "#fff9";
      ctx.fillText(k, i * bar + 3, h - 3);
    });
  };
}
