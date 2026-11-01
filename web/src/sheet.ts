// Sheets: likes, history, settings, account and help. A drawer on the right on
// wide screens, a sheet from the bottom on phones, which a downward swipe on its
// handle closes. One is open at a time, over a scrim that closes it when tapped,
// so a tap meant to close a sheet never reaches the feed. Focus moves into the
// sheet, stays there while it is open, and goes back to what opened it.

const FOCUSABLE = "button:not([disabled]), a[href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex='-1'])";
const CLOSE_DRAG = 0.25; // share of the sheet's height a swipe must cover to close it
const CLOSE_FLING = 0.5; // px/ms; or this fast

const scrim = document.createElement("div");
scrim.className = "scrim";
scrim.hidden = true;
document.body.append(scrim);

let current: Sheet | null = null;

scrim.addEventListener("click", () => current?.close());
document.addEventListener("keydown", (e) => {
  if (!current) return;
  if (e.key === "Escape") {
    e.preventDefault();
    current.close();
  } else if (e.key === "Tab") {
    current.trap(e);
  }
});

export class Sheet {
  /// Called after the sheet opened, e.g. to load what it shows.
  onOpen: (() => void) | null = null;
  onClose: (() => void) | null = null;
  private opener: HTMLElement | null = null;

  /// `button`, if given, opens and closes the sheet and shows whether it is open.
  constructor(
    readonly el: HTMLElement,
    private button?: HTMLElement,
  ) {
    el.classList.add("sheet");
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.tabIndex = -1;
    el.hidden = true;
    const handle = document.createElement("div");
    handle.className = "sheet-handle";
    handle.setAttribute("aria-hidden", "true");
    el.prepend(handle);
    this.dragToClose(handle);
    button?.setAttribute("aria-expanded", "false");
    button?.addEventListener("click", () => this.toggle());
  }

  /// The sheet that is open, if any.
  static get current(): Sheet | null {
    return current;
  }

  static closeAll(): void {
    current?.close();
  }

  get isOpen(): boolean {
    return current === this;
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  open(): void {
    if (this.isOpen) return;
    const opener = current?.opener ?? (document.activeElement as HTMLElement | null);
    current?.close(false);
    current = this;
    this.opener = opener;
    scrim.hidden = false;
    this.el.hidden = false;
    this.el.style.transform = "";
    this.button?.setAttribute("aria-expanded", "true");
    const first = this.el.querySelector<HTMLElement>("[autofocus]") ?? this.el;
    first.focus({ preventScroll: true });
    this.onOpen?.();
  }

  /// `restore`: give focus back to what opened the sheet.
  close(restore = true): void {
    if (!this.isOpen) return;
    current = null;
    scrim.hidden = true;
    this.el.hidden = true;
    this.button?.setAttribute("aria-expanded", "false");
    if (restore) this.opener?.focus({ preventScroll: true });
    this.onClose?.();
  }

  /// Keep Tab inside the sheet.
  trap(e: KeyboardEvent): void {
    const items = [...this.el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
    if (!items.length) return;
    const [first, last] = [items[0], items[items.length - 1]];
    const at = document.activeElement;
    if (e.shiftKey && (at === first || at === this.el)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && at === last) {
      e.preventDefault();
      first.focus();
    }
  }

  /// On phones the handle drags the sheet down; far or fast enough closes it.
  private dragToClose(handle: HTMLElement): void {
    let start: { id: number; y: number; t: number } | null = null;
    let dy = 0;
    handle.addEventListener("pointerdown", (e) => {
      start = { id: e.pointerId, y: e.clientY, t: performance.now() };
      dy = 0;
      handle.setPointerCapture(e.pointerId);
      this.el.classList.add("dragging");
    });
    handle.addEventListener("pointermove", (e) => {
      if (start?.id !== e.pointerId) return;
      dy = Math.max(0, e.clientY - start.y);
      this.el.style.transform = `translateY(${dy}px)`;
    });
    const end = (e: PointerEvent) => {
      if (start?.id !== e.pointerId) return;
      dy = Math.max(0, e.clientY - start.y);
      const speed = dy / Math.max(1, performance.now() - start.t);
      start = null;
      this.el.classList.remove("dragging");
      this.el.style.transform = "";
      if (e.type === "pointerup" && (dy > this.el.offsetHeight * CLOSE_DRAG || speed > CLOSE_FLING)) this.close();
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }
}
