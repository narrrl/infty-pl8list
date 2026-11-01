// What this browser played lately, newest first, for the history sheet. Kept on
// the device only; the server has its own record of plays for the feed.

import type { Track } from "./api";

const KEY = "pl8inf.history";
const MAX = 100;

export interface Heard {
  track: Track;
  /// ms since the epoch.
  at: number;
}

export function load(): Heard[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(list) ? list.filter((h) => h?.track?.id && typeof h.at === "number") : [];
  } catch {
    return [];
  }
}

/// Note a track as heard; a track heard again moves to the top.
export function add(track: Track): void {
  // Why it was in a radio says nothing once it is replayed from here.
  const list = [{ track: { ...track, why: undefined }, at: Date.now() }, ...load().filter((h) => h.track.id !== track.id)].slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch { /* storage full: history is a nicety */ }
}

export function clear(): void {
  localStorage.removeItem(KEY);
}
