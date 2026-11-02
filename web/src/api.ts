// Calls to our own server. The browser never talks to pl8list directly.

export interface Track {
  id: number;
  handle: string;
  slug: string;
  title: string;
  description: string | null;
  artist_name: string;
  artist_img: string | null;
  artist_verified: boolean;
  bpm: number | null;
  key: string | null;
  duration: number | null;
  price: number;
  created_at: string | null;
  saves: number;
  downloads: number;
  purchases: number;
  comments: number;
  preview: boolean;
  upload_id: string | null;
  waveform: number[] | null;
  followed?: boolean;
  /// From titles, descriptions and BPM, see backend/src/tags.rs.
  tags?: string[];
  /// In an artist radio: why this track is in it.
  why?: Why;
}

/// `seed`: by the radio's artist; `related`: by an artist next to them;
/// `via`: one step further, through the artist `handle`.
export type Why = { kind: "seed" } | { kind: "related" } | { kind: "via"; handle: string; name: string };

export interface Artist {
  handle: string;
  name: string;
  img: string | null;
  verified: boolean;
  tracks: number;
}

/// An artist and their neighbours in the artist graph, for the radio sheet.
export interface ArtistInfo {
  artist: Artist;
  neighbours: { handle: string; name: string; img: string | null; weight: number }[];
  tags: string[];
  followed: boolean;
  /// Still crawling for neighbours; ask again in a moment.
  exploring: boolean;
}

export interface Stats {
  tracks: number;
  artists: number;
  artists_crawled: number;
  served: number;
  liked: number;
}

export interface User {
  handle: string;
  name: string | null;
  /// Listening without a pl8list account.
  guest?: boolean;
}

export interface Pl8Status {
  connected: boolean;
  synced_at: number | null;
}

export interface Me {
  user: User;
  pl8list: Pl8Status;
}

export type Filters = Partial<Record<"free" | "bpm_min" | "bpm_max", string>>;

/// Which part of the catalogue the feed draws from. `artist` is an artist radio:
/// that artist and the ones pl8list relates to them.
export type Mode =
  | { mode: "classic" | "riddim" | "fresh" | "deep" }
  | { mode: "artist"; artist: string; name: string; img?: string | null };

export type EventKind = "play" | "like" | "unlike" | "skip" | "complete" | "dislike" | "undislike";

export class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function parse<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(body.error || `request failed (${res.status})`, res.status);
  return body as T;
}

export async function getJSON<T>(url: string): Promise<T> {
  return parse<T>(await fetch(url));
}

export async function postJSON<T = { ok: boolean }>(url: string, data?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data ?? {}),
  });
  return parse<T>(res);
}

/// Fire and forget; survives the page closing.
export function sendEvent(track: Track, kind: EventKind, seconds?: number): void {
  const body = JSON.stringify({ track_id: track.id, kind, seconds });
  if (!navigator.sendBeacon("/local/event", new Blob([body], { type: "application/json" }))) {
    fetch("/local/event", { method: "POST", body, headers: { "Content-Type": "application/json" }, keepalive: true });
  }
}

export function feed(filters: Filters, mode: Mode) {
  const p = new URLSearchParams({ n: "10", ...filters });
  if (mode.mode !== "classic") p.set("mode", mode.mode);
  if (mode.mode === "artist") p.set("artist", mode.artist);
  return getJSON<{ tracks: Track[]; stats: Stats }>("/local/feed?" + p);
}

export const artist = (handle: string) => getJSON<ArtistInfo>("/local/artist?" + new URLSearchParams({ handle }));

export const track = (handle: string, slug: string) =>
  getJSON<{ track: Track }>("/local/track?" + new URLSearchParams({ handle, slug }));

export const likes = () => getJSON<{ tracks: Track[] }>("/local/likes");

export const me = () => getJSON<Me>("/local/me");

export const PL8 = "https://pl8list.com";
export const trackUrl = (t: Track) => `${PL8}/${t.handle}/${t.slug}`;
/// A link that opens this app on the track.
export const appTrackUrl = (t: Track) => `${location.origin}/?t=${encodeURIComponent(t.handle)}/${encodeURIComponent(t.slug)}`;
export const artistUrl = (t: Track) => `${PL8}/${t.handle}`;
// Images come through our server, so pl8list never sees the visitor's address.
export const imgUrl = (id: string | null) => (id ? `/img/${encodeURIComponent(id)}` : null);
export const artistImg = (t: Track) => imgUrl(t.artist_img);

export function streamUrl(t: Track): string {
  const p = new URLSearchParams();
  if (t.preview) p.set("preview", "true");
  if (t.upload_id) p.set("v", t.upload_id);
  return `/api/${encodeURIComponent(t.handle)}/${encodeURIComponent(t.slug)}/hls/playlist.m3u8?${p}`;
}
