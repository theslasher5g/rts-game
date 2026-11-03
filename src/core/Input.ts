/**
 * Zentrale Eingabeverwaltung: Tastatur (window), Maus/Pointer (nur Canvas).
 *
 * - isDown(code): KeyboardEvent.code ('KeyW', 'ArrowUp', 'ShiftLeft', …)
 * - mouse: Position relativ zum Canvas (CSS-Pixel) + NDC, gedrückte Buttons (Bitmaske wie PointerEvent.buttons)
 * - consumeWheel(): normiertes Mausrad seit letztem Aufruf (+ = herauszoomen, 1 ≈ eine Raste)
 * - consumeDrag(button): akkumulierte Zieh-Pixel für Button-Index (0 links, 1 Mitte, 2 rechts)
 * - onClick / onMove: Listener, geben Abmelde-Funktion zurück
 * - onDragStart / onDrag / onDragEnd: Zieh-Vorgänge je Button (ab CLICK_SLOP_PX Auslenkung);
 *   ein Zieh-Vorgang erzeugt keinen Klick. Phase 2: Rahmenauswahl (links), Formationsziehen (rechts).
 */

export interface InputClickEvent {
  ndcX: number;
  ndcY: number;
  button: number;
  x: number;
  y: number;
  shift: boolean;
  ctrl: boolean;
  double: boolean;
}

export interface InputDragEvent {
  button: number;
  /** Startposition (Pointer-Down) in CSS-Pixeln relativ zum Canvas */
  x0: number;
  y0: number;
  /** Aktuelle Position */
  x: number;
  y: number;
  ndcX: number;
  ndcY: number;
  shift: boolean;
  ctrl: boolean;
  /** Nur bei onDragEnd: Vorgang abgebrochen (pointercancel / Fokusverlust) */
  cancelled: boolean;
}

export interface InputMoveEvent {
  ndcX: number;
  ndcY: number;
}

/** Bewegung (px) ab der ein Pointer-Vorgang als Ziehen statt Klick gilt */
const CLICK_SLOP_PX = 5;
const DOUBLE_CLICK_MS = 350;
const DOUBLE_CLICK_PX = 8;
/** Bitmaske (PointerEvent.buttons) für Button-Index (PointerEvent.button) */
const BUTTON_MASK = [1, 4, 2, 8, 16];

export class Input {
  readonly mouse = { x: 0, y: 0, ndcX: 0, ndcY: 0, inside: false, buttons: 0 };

  private readonly canvas: HTMLCanvasElement;
  private readonly keys = new Set<string>();
  private wheel = 0;
  private readonly dragX = [0, 0, 0, 0, 0];
  private readonly dragY = [0, 0, 0, 0, 0];
  private readonly clickFns = new Set<(e: InputClickEvent) => void>();
  private readonly moveFns = new Set<(e: InputMoveEvent) => void>();
  private readonly dragStartFns = new Set<(e: InputDragEvent) => void>();
  private readonly dragFns = new Set<(e: InputDragEvent) => void>();
  private readonly dragEndFns = new Set<(e: InputDragEvent) => void>();
  /** Button befindet sich in einem Zieh-Vorgang (Schwelle überschritten) */
  private readonly dragging = [false, false, false, false, false];
  private readonly dragEvt: InputDragEvent = { button: 0, x0: 0, y0: 0, x: 0, y: 0, ndcX: 0, ndcY: 0, shift: false, ctrl: false, cancelled: false };

  /** Laufende Pointer-Vorgänge je Button: Startposition + maximale Auslenkung */
  private readonly downActive = [false, false, false, false, false];
  private readonly downX = [0, 0, 0, 0, 0];
  private readonly downY = [0, 0, 0, 0, 0];
  private readonly downMaxDist = [0, 0, 0, 0, 0];
  private lastX = 0;
  private lastY = 0;
  private hasLast = false;

  private lastClickTime = -1e9;
  private lastClickButton = -1;
  private lastClickX = 0;
  private lastClickY = 0;

  private readonly moveEvt: InputMoveEvent = { ndcX: 0, ndcY: 0 };
  private readonly cleanup: Array<() => void> = [];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    const listen = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement,
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type, fn, opts);
      this.cleanup.push(() => target.removeEventListener(type, fn, opts));
    };
    const listenWin = <K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      window.addEventListener(type, fn, opts);
      this.cleanup.push(() => window.removeEventListener(type, fn, opts));
    };

    // ---------- Tastatur ----------
    listenWin('keydown', (e) => {
      if (isEditableTarget(e.target)) return;
      this.keys.add(e.code);
    });
    listenWin('keyup', (e) => {
      this.keys.delete(e.code);
    });
    listenWin('blur', () => this.releaseAll());
    const onVis = () => {
      if (document.hidden) this.releaseAll();
    };
    document.addEventListener('visibilitychange', onVis);
    this.cleanup.push(() => document.removeEventListener('visibilitychange', onVis));

    // ---------- Pointer (nur Canvas) ----------
    listen(canvas, 'contextmenu', (e) => e.preventDefault());
    // "inside" wird erst durch echte Bewegung/Klicks gesetzt: ein synthetisches pointerenter
    // an (0,0) beim Laden würde sonst sofort Randscrollen auslösen.
    listen(canvas, 'pointerenter', (e) => this.updatePos(e));
    listen(canvas, 'pointerleave', () => {
      this.mouse.inside = false;
      this.hasLast = false;
    });
    listen(canvas, 'pointerdown', (e) => {
      this.updatePos(e);
      this.mouse.inside = true;
      this.mouse.buttons = e.buttons;
      const b = e.button;
      if (b >= 0 && b < 5) {
        this.downActive[b] = true;
        this.downX[b] = this.mouse.x;
        this.downY[b] = this.mouse.y;
        this.downMaxDist[b] = 0;
        if (this.dragging[b]) this.endDrag(b, e, true);
      }
      this.lastX = this.mouse.x;
      this.lastY = this.mouse.y;
      this.hasLast = true;
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (b === 1) e.preventDefault(); // Autoscroll bei mittlerer Taste verhindern
    });
    listen(canvas, 'pointermove', (e) => {
      this.updatePos(e);
      this.mouse.inside = true;
      this.mouse.buttons = e.buttons;
      const x = this.mouse.x, y = this.mouse.y;
      if (this.hasLast) {
        const dx = x - this.lastX, dy = y - this.lastY;
        for (let b = 0; b < 5; b++) {
          if (e.buttons & BUTTON_MASK[b]) {
            this.dragX[b] += dx;
            this.dragY[b] += dy;
          }
          if (this.downActive[b]) {
            const d = Math.hypot(x - this.downX[b], y - this.downY[b]);
            if (d > this.downMaxDist[b]) this.downMaxDist[b] = d;
            if (!this.dragging[b] && this.downMaxDist[b] >= CLICK_SLOP_PX) {
              this.dragging[b] = true;
              this.emitDrag(this.dragStartFns, b, e, false);
            } else if (this.dragging[b] && (dx !== 0 || dy !== 0)) {
              this.emitDrag(this.dragFns, b, e, false);
            }
          }
        }
      }
      this.lastX = x;
      this.lastY = y;
      this.hasLast = true;
      if (this.moveFns.size) {
        this.moveEvt.ndcX = this.mouse.ndcX;
        this.moveEvt.ndcY = this.mouse.ndcY;
        this.moveFns.forEach((fn) => fn(this.moveEvt));
      }
    });
    listen(canvas, 'pointerup', (e) => {
      this.updatePos(e);
      this.mouse.buttons = e.buttons;
      const b = e.button;
      if (b < 0 || b >= 5 || !this.downActive[b]) return;
      this.downActive[b] = false;
      if (this.dragging[b]) {
        this.endDrag(b, e, false);
        return;
      }
      const d = Math.max(this.downMaxDist[b], Math.hypot(this.mouse.x - this.downX[b], this.mouse.y - this.downY[b]));
      if (d >= CLICK_SLOP_PX) return;
      const now = performance.now();
      const double =
        this.lastClickButton === b &&
        now - this.lastClickTime < DOUBLE_CLICK_MS &&
        Math.hypot(this.mouse.x - this.lastClickX, this.mouse.y - this.lastClickY) < DOUBLE_CLICK_PX;
      if (double) {
        this.lastClickTime = -1e9; // Dreifachklick erzeugt keinen zweiten Doppelklick
        this.lastClickButton = -1;
      } else {
        this.lastClickTime = now;
        this.lastClickButton = b;
        this.lastClickX = this.mouse.x;
        this.lastClickY = this.mouse.y;
      }
      const evt: InputClickEvent = {
        ndcX: this.mouse.ndcX,
        ndcY: this.mouse.ndcY,
        button: b,
        x: this.mouse.x,
        y: this.mouse.y,
        shift: e.shiftKey,
        ctrl: e.ctrlKey || e.metaKey,
        double,
      };
      this.clickFns.forEach((fn) => fn(evt));
    });
    listen(canvas, 'pointercancel', (e) => {
      this.mouse.buttons = e.buttons;
      for (let b = 0; b < 5; b++) {
        this.downActive[b] = false;
        if (this.dragging[b]) this.endDrag(b, e, true);
      }
    });
    listen(
      canvas,
      'wheel',
      (e) => {
        e.preventDefault();
        let dy = e.deltaY;
        if (e.deltaMode === 1) dy *= 33; // Zeilen -> px
        else if (e.deltaMode === 2) dy *= 400; // Seiten -> px
        // 100 px ≈ eine Raste; Einzelereignis begrenzen (Trackpad-Ausreißer)
        const n = dy / 100;
        this.wheel += n > 3 ? 3 : n < -3 ? -3 : n;
      },
      { passive: false },
    );
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  consumeWheel(): number {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }

  private readonly dragOut = { dx: 0, dy: 0 };

  /** Achtung: liefert ein wiederverwendetes Objekt (keine Allokation pro Frame). */
  consumeDrag(button: number): { dx: number; dy: number } {
    const out = this.dragOut;
    if (button < 0 || button >= 5) {
      out.dx = 0;
      out.dy = 0;
      return out;
    }
    out.dx = this.dragX[button];
    out.dy = this.dragY[button];
    this.dragX[button] = 0;
    this.dragY[button] = 0;
    return out;
  }

  onClick(fn: (e: InputClickEvent) => void): () => void {
    this.clickFns.add(fn);
    return () => this.clickFns.delete(fn);
  }

  onMove(fn: (e: InputMoveEvent) => void): () => void {
    this.moveFns.add(fn);
    return () => this.moveFns.delete(fn);
  }

  /** Zieh-Beginn (Schwelle überschritten). Das Ereignisobjekt wird wiederverwendet. */
  onDragStart(fn: (e: InputDragEvent) => void): () => void {
    this.dragStartFns.add(fn);
    return () => this.dragStartFns.delete(fn);
  }

  /** Zieh-Bewegung (nach onDragStart). Das Ereignisobjekt wird wiederverwendet. */
  onDrag(fn: (e: InputDragEvent) => void): () => void {
    this.dragFns.add(fn);
    return () => this.dragFns.delete(fn);
  }

  /** Zieh-Ende (Loslassen oder Abbruch, siehe `cancelled`). Das Ereignisobjekt wird wiederverwendet. */
  onDragEnd(fn: (e: InputDragEvent) => void): () => void {
    this.dragEndFns.add(fn);
    return () => this.dragEndFns.delete(fn);
  }

  /** Läuft für diesen Button gerade ein Zieh-Vorgang? */
  isDragging(button: number): boolean {
    return this.dragging[button] === true;
  }

  dispose(): void {
    this.cleanup.forEach((f) => f());
    this.cleanup.length = 0;
    this.clickFns.clear();
    this.moveFns.clear();
    this.dragStartFns.clear();
    this.dragFns.clear();
    this.dragEndFns.clear();
    this.keys.clear();
  }

  private releaseAll(): void {
    this.keys.clear();
    this.mouse.buttons = 0;
    for (let b = 0; b < 5; b++) {
      this.downActive[b] = false;
      this.dragX[b] = 0;
      this.dragY[b] = 0;
      if (this.dragging[b]) this.endDrag(b, null, true);
    }
  }

  private emitDrag(fns: Set<(e: InputDragEvent) => void>, b: number, e: PointerEvent | null, cancelled: boolean): void {
    if (!fns.size) return;
    const ev = this.dragEvt;
    ev.button = b;
    ev.x0 = this.downX[b];
    ev.y0 = this.downY[b];
    ev.x = this.mouse.x;
    ev.y = this.mouse.y;
    ev.ndcX = this.mouse.ndcX;
    ev.ndcY = this.mouse.ndcY;
    if (e) {
      ev.shift = e.shiftKey;
      ev.ctrl = e.ctrlKey || e.metaKey;
    }
    ev.cancelled = cancelled;
    fns.forEach((fn) => fn(ev));
  }

  private endDrag(b: number, e: PointerEvent | null, cancelled: boolean): void {
    this.dragging[b] = false;
    this.emitDrag(this.dragEndFns, b, e, cancelled);
  }

  private updatePos(e: PointerEvent): void {
    const r = this.canvas.getBoundingClientRect();
    const w = r.width || 1, h = r.height || 1;
    const x = e.clientX - r.left, y = e.clientY - r.top;
    this.mouse.x = x;
    this.mouse.y = y;
    this.mouse.ndcX = (x / w) * 2 - 1;
    this.mouse.ndcY = -(y / h) * 2 + 1;
  }
}

function isEditableTarget(t: EventTarget | null): boolean {
  if (!t || !(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}
