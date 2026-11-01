// Full-screen vertical pager. One card fills the screen; drag, fling, wheel and keys
// move between cards. Only the current card and its two neighbours are in the DOM,
// placed with transforms and settled by a spring, so long sessions stay light and
// the motion follows the finger exactly.

export interface PagerSource {
  /// How many cards exist right now.
  count(): number;
  /// The element for card `i`; the owner builds and caches it.
  element(i: number): HTMLElement;
  /// Card `i` became the current one. Called as soon as a move is decided, before
  /// the animation ends, so audio can start right away.
  onChange(i: number): void;
  /// The user is at (or pulling past) the last card.
  onNeedMore(): void;
}

const STIFFNESS = 380; // 1/s², spring towards the resting position
const DAMPING = 34; // 1/s, a little under critical (39): settles with a hint of bounce
const FLING = 0.45; // px/ms; a flick faster than this turns the page
const DISTANCE = 0.22; // or dragging further than this share of the height
const SLOP = 8; // px before a touch counts as a drag
const WHEEL_STEP = 40; // px of wheel delta per page
const WHEEL_IDLE = 180; // ms of quiet that ends one wheel gesture (trackpad inertia)

interface Drag {
  id: number;
  x0: number;
  y0: number;
  base: number;
  active: boolean;
  samples: [number, number][];
}

export class Pager {
  index = 0;
  /// True right after a drag, so the click that follows it is not a tap.
  suppressClick = false;
  private offset = 0; // px; positive while pulled down (towards the previous card)
  private velocity = 0; // px/s
  private height = 1;
  private mounted = new Map<number, HTMLElement>();
  private raf = 0;
  private last = 0;
  private drag: Drag | null = null;
  private wheelAcc = 0;
  private wheelLocked = false;
  private wheelTimer = 0;
  private reduced = matchMedia("(prefers-reduced-motion: reduce)");

  constructor(
    private root: HTMLElement,
    private src: PagerSource,
  ) {
    this.height = root.clientHeight || innerHeight;
    root.addEventListener("pointerdown", (e) => this.down(e));
    root.addEventListener("pointermove", (e) => this.move(e));
    root.addEventListener("pointerup", (e) => this.up(e));
    root.addEventListener("pointercancel", (e) => this.up(e, true));
    root.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    new ResizeObserver(() => {
      this.height = root.clientHeight || innerHeight;
      this.render();
    }).observe(root);
  }

  /// Move to card `i`. Returns false when there is no such card (yet).
  go(i: number, { instant = false } = {}): boolean {
    if (i < 0) return false;
    if (i >= this.src.count()) {
      this.src.onNeedMore();
      return false;
    }
    if (i === this.index) return true;
    this.offset += (i - this.index) * this.height;
    this.index = i;
    this.refresh();
    this.src.onChange(i);
    if (instant || this.reduced.matches || document.hidden) this.settleNow();
    else this.animate();
    if (i >= this.src.count() - 1) this.src.onNeedMore();
    return true;
  }

  /// Re-read the cards around the current one (after inserting or removing cards).
  refresh(): void {
    const want = new Map<number, HTMLElement>();
    for (let i = this.index - 1; i <= this.index + 1; i++) {
      if (i >= 0 && i < this.src.count()) want.set(i, this.src.element(i));
    }
    for (const [i, el] of this.mounted) {
      if (want.get(i) !== el && ![...want.values()].includes(el)) el.remove();
    }
    for (const el of want.values()) {
      if (el.parentElement !== this.root) this.root.append(el);
    }
    this.mounted = want;
    this.render();
  }

  private render(): void {
    const h = this.height;
    for (const [i, el] of this.mounted) {
      const p = i - this.index + this.offset / h;
      el.style.transform = `translate3d(0, ${(p * h).toFixed(2)}px, 0)`;
      // 0 when resting in place, 1 one full page away; cards use it for depth effects.
      el.style.setProperty("--away", Math.min(1, Math.abs(p)).toFixed(3));
      // Only the current card's buttons are reachable with the keyboard.
      el.inert = i !== this.index;
    }
  }

  private settleNow(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.offset = 0;
    this.velocity = 0;
    this.render();
  }

  private animate(): void {
    if (this.raf) return;
    this.last = performance.now();
    const step = (now: number) => {
      // Small fixed steps keep the spring stable on slow frames.
      let dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      while (dt > 0) {
        const h = Math.min(dt, 1 / 240);
        this.velocity += (-STIFFNESS * this.offset - DAMPING * this.velocity) * h;
        this.offset += this.velocity * h;
        dt -= h;
      }
      if (Math.abs(this.offset) < 0.5 && Math.abs(this.velocity) < 20) {
        this.raf = 0;
        this.settleNow();
        return;
      }
      this.render();
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  // Pointer ---------------------------------------------------------------

  private down(e: PointerEvent): void {
    if (this.drag || (e.pointerType === "mouse" && e.button !== 0)) return;
    if ((e.target as Element).closest("button, a, input, textarea, select, .wave-wrap")) return;
    this.drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, base: this.offset, active: false, samples: [] };
  }

  private move(e: PointerEvent): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    // The button came up where we did not see it (outside the window, or while
    // the drop was being turned).
    if (e.pointerType === "mouse" && !(e.buttons & 1)) {
      this.up(e, true);
      return;
    }
    const dx = e.clientX - d.x0;
    const dy = e.clientY - d.y0;
    if (!d.active) {
      if (Math.abs(dy) < SLOP || Math.abs(dy) < Math.abs(dx)) return;
      d.active = true;
      this.root.setPointerCapture(e.pointerId);
      // Catch a card that is still settling where it is.
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      d.base = this.offset;
      d.y0 = e.clientY;
    }
    let off = d.base + (e.clientY - d.y0);
    const atStart = this.index === 0 && off > 0;
    const atEnd = this.index >= this.src.count() - 1 && off < 0;
    if (atStart || atEnd) off = Math.sign(off) * this.rubber(Math.abs(off));
    if (atEnd) this.src.onNeedMore();
    this.offset = off;
    const now = performance.now();
    d.samples.push([now, e.clientY]);
    while (d.samples.length > 2 && now - d.samples[0][0] > 100) d.samples.shift();
    this.render();
  }

  /// Resistance past the first and last card.
  private rubber(x: number): number {
    const h = this.height;
    return (1 - 1 / ((x * 0.55) / h + 1)) * h;
  }

  private up(e: PointerEvent, cancelled = false): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    this.drag = null;
    if (!d.active) return;
    this.suppressClick = true;
    setTimeout(() => (this.suppressClick = false), 350);
    let v = 0; // px/ms
    if (!cancelled && d.samples.length > 1) {
      const [t0, y0] = d.samples[0];
      const [t1, y1] = d.samples[d.samples.length - 1];
      if (t1 > t0) v = (y1 - y0) / (t1 - t0);
    }
    const h = this.height;
    let target = this.index;
    if ((this.offset < -h * DISTANCE || v < -FLING) && this.index + 1 < this.src.count()) target++;
    else if ((this.offset > h * DISTANCE || v > FLING) && this.index > 0) target--;
    this.velocity = v * 1000;
    if (target !== this.index) {
      this.offset += (target - this.index) * h;
      this.index = target;
      this.refresh();
      this.src.onChange(target);
      if (target >= this.src.count() - 1) this.src.onNeedMore();
    }
    if (this.reduced.matches) this.settleNow();
    else this.animate();
  }

  // Wheel and trackpad -------------------------------------------------------

  private wheel(e: WheelEvent): void {
    if (e.ctrlKey) return; // pinch zoom
    e.preventDefault();
    clearTimeout(this.wheelTimer);
    this.wheelTimer = window.setTimeout(() => {
      this.wheelLocked = false;
      this.wheelAcc = 0;
    }, WHEEL_IDLE);
    if (this.wheelLocked) return;
    this.wheelAcc += e.deltaY * (e.deltaMode === 1 ? 30 : e.deltaMode === 2 ? this.height : 1);
    if (Math.abs(this.wheelAcc) >= WHEEL_STEP) {
      // One page per gesture: the rest of a trackpad swipe's inertia is ignored.
      this.wheelLocked = true;
      this.go(this.index + Math.sign(this.wheelAcc));
      this.wheelAcc = 0;
    }
  }
}
