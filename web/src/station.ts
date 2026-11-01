// The radio sheet: who an artist radio is built around and who is next to them.
// Opening it changes nothing yet; "start radio" does. Tapping a neighbour shows
// their sheet, so the artist graph can be walked before picking a station.
//
// A new artist may have no neighbours yet. The server then starts crawling them
// and says `exploring`; the sheet asks again every few seconds and fades new ones in.

import * as api from "./api";
import type { ArtistInfo, Mode } from "./api";

const POLL_MS = 2000;
const POLL_FOR_MS = 20000;

interface Shown {
  handle: string;
  name: string;
  img: string | null;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export class Station {
  private root = $("station");
  private nameEl = $("station-name");
  private subEl = $("station-sub");
  private tagsEl = $("station-tags");
  private avatar = this.root.querySelector<HTMLElement>(".station-avatar")!;
  private list = $("station-neighbours");
  private exploringEl = $("station-exploring");
  private startBtn = $<HTMLButtonElement>("station-start");
  private backBtn = $<HTMLButtonElement>("station-back");
  private shown: Shown | null = null;
  /// Artists walked through to get here, for the back button.
  private trail: Shown[] = [];
  private gen = 0;
  private timer = 0;
  private known = new Set<string>();

  constructor(private start: (m: Mode) => void) {
    $("station-close").addEventListener("click", () => this.close());
    this.root.addEventListener("click", (e) => { if (e.target === this.root) this.close(); });
    this.backBtn.addEventListener("click", () => {
      const prev = this.trail.pop();
      if (prev) this.show(prev);
    });
    this.startBtn.addEventListener("click", () => {
      const s = this.shown;
      if (!s) return;
      this.close();
      this.start({ mode: "artist", artist: s.handle, name: s.name, img: s.img });
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(handle: string, name: string, img: string | null): void {
    this.trail = [];
    this.root.hidden = false;
    this.show({ handle, name, img });
    this.startBtn.focus();
  }

  close(): void {
    this.root.hidden = true;
    this.gen++;
    clearTimeout(this.timer);
  }

  private show(s: Shown): void {
    this.shown = s;
    this.known.clear();
    this.list.replaceChildren();
    this.tagsEl.replaceChildren();
    this.nameEl.textContent = s.name;
    this.subEl.textContent = "";
    this.setAvatar(this.avatar, s.img, s.name);
    this.startBtn.lastChild!.textContent = ` start ${s.name} radio`;
    const prev = this.trail[this.trail.length - 1];
    this.backBtn.hidden = !prev;
    if (prev) this.backBtn.textContent = `← ${prev.name}`;
    this.exploringEl.hidden = true;
    const gen = ++this.gen;
    clearTimeout(this.timer);
    this.load(s.handle, gen, performance.now() + POLL_FOR_MS);
  }

  private async load(handle: string, gen: number, until: number): Promise<void> {
    let info: ArtistInfo;
    try {
      info = await api.artist(handle);
    } catch (err) {
      if (gen === this.gen) this.subEl.textContent = (err as Error).message;
      return;
    }
    if (gen !== this.gen) return;
    this.render(info);
    const again = info.exploring && performance.now() < until;
    this.exploringEl.hidden = !again;
    if (again) this.timer = window.setTimeout(() => this.load(handle, gen, until), POLL_MS);
    else if (!info.neighbours.length) this.list.textContent = "nobody linked to them yet. the radio plays their own tracks and fills up as more are found.";
  }

  private render(info: ArtistInfo): void {
    const { artist, neighbours, tags } = info;
    const s = this.shown!;
    if (!s.img && artist.img) {
      s.img = api.imgUrl(artist.img);
      this.setAvatar(this.avatar, s.img, s.name);
    }
    const count = neighbours.length;
    this.subEl.textContent =
      `${artist.tracks} track${artist.tracks === 1 ? "" : "s"} here` +
      (count ? ` · plus ${count}${count >= 12 ? "+" : ""} related artist${count === 1 ? "" : "s"}` : "");
    this.tagsEl.replaceChildren(...tags.map((t) => {
      const span = document.createElement("span");
      span.textContent = t;
      return span;
    }));
    if (count && this.list.firstChild?.nodeType === Node.TEXT_NODE) this.list.replaceChildren();
    for (const n of neighbours) {
      if (this.known.has(n.handle)) continue;
      this.known.add(n.handle);
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.title = `${n.name}'s radio`;
      const av = document.createElement("span");
      av.className = "station-avatar small";
      const img = api.imgUrl(n.img);
      this.setAvatar(av, img, n.name);
      const label = document.createElement("span");
      label.textContent = n.name;
      btn.append(av, label);
      btn.addEventListener("click", () => {
        this.trail.push(this.shown!);
        this.show({ handle: n.handle, name: n.name, img });
      });
      li.append(btn);
      this.list.append(li);
    }
  }

  private setAvatar(el: HTMLElement, img: string | null, name: string): void {
    el.style.backgroundImage = img ? `url("${img}")` : "";
    let initial = el.querySelector(".initial");
    if (!initial) {
      initial = document.createElement("span");
      initial.className = "initial";
      el.append(initial);
    }
    initial.textContent = img ? "" : (name || "?")[0].toUpperCase();
  }
}
