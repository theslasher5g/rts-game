import './abilities.css';
import * as THREE from 'three';
import { bus } from '../core/EventBus';
import type { AbilityCheck, AbilityDef } from '../abilities/AbilitySystem';

/**
 * Phase 7 – Leiste der Kommandeursfähigkeiten (links über der Minikarte).
 * Je Fähigkeit eine Schaltfläche: Symbol, Taste (F1..F6), Kosten in Fässern, Abklingzeit-Überlagerung, gesperrt bei
 * zu wenig Öl. Klick/Taste -> Zielmodus (Fadenkreuz + Radius-Vorschau auf dem Gelände, rot bei verbotenem Ziel,
 * gelb bei heiklem); Linksklick auf die Karte setzt ab (`onMapClick`), Rechtsklick/Esc bricht ab.
 *
 * Host: `abilities` ist das AbilitySystem. Gast: ein Proxy mit use() -> RPC 'abilities.use'; cooldownLeft/checkTarget sind
 * optional (dann zählt die Leiste die Abklingzeit selbst über 'ability:used' und `getGameHours`).
 */

export interface AbilityPort {
  readonly defs: AbilityDef[];
  use(a3: string, id: string, x: number, z: number): { ok: boolean; reason?: string; warn?: string } | void;
  cooldownLeft?(a3: string, id: string): number;
  checkTarget?(a3: string, id: string, x: number, z: number): AbilityCheck;
}

export interface AbilityBarOptions {
  abilities: AbilityPort;
  getPlayer: () => string | null;
  /** Fässer des Spielers */
  getBarrels: () => number;
  getCamera: () => THREE.PerspectiveCamera;
  /** Canvas der 3D-Ansicht (Maus für Vorschau, Fadenkreuz) */
  canvas: HTMLElement;
  /** Bildschirmpunkt -> Geländepunkt (Picker) */
  pick: (clientX: number, clientY: number) => { x: number; z: number } | null;
  /** Geländehöhe in Welt-Y (mit Überhöhung) für die Kreisprojektion, Standard 0 */
  groundY?: (x: number, z: number) => number;
  /** Spielzeit in Stunden (nur für den Abklingzeit-Ersatz bei Gast-Proxys ohne cooldownLeft) */
  getGameHours?: () => number;
  /** SelectionController.keyHooks: dort einhängen (F1..F6, Esc), sonst eigener Capture-Listener */
  keys?: { keyHooks: Array<(e: KeyboardEvent) => boolean> };
}

export class AbilityBar {
  private readonly o: AbilityBarOptions;
  private readonly root: HTMLElement;
  private readonly bar: HTMLDivElement;
  private readonly btns: Array<{ el: HTMLButtonElement; ov: HTMLElement; cdt: HTMLElement; cost: HTMLElement; def: AbilityDef }> = [];
  private readonly hint: HTMLDivElement;
  private readonly tip: HTMLDivElement;
  private readonly svg: SVGSVGElement;
  private readonly poly: SVGPolygonElement;
  private readonly timer: number;
  private readonly usedAt = new Map<string, number>();
  private readonly v = new THREE.Vector3();
  private target: AbilityDef | null = null;
  private raf = 0;
  private mx = -1;
  private my = -1;
  private mouseIn = false;
  private lastChk = 0;
  private chk: AbilityCheck | null = null;
  private chkAt = '';
  private swallowRight = false;
  private oldCursor = '';
  private shown = false;
  private readonly offs: Array<() => void> = [];

  constructor(root: HTMLElement, opts: AbilityBarOptions) {
    this.o = opts;
    this.root = root;
    this.bar = document.createElement('div');
    this.bar.className = 'panel ab-bar hidden';
    for (const def of opts.abilities.defs) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'ab-btn';
      const key = document.createElement('span');
      key.className = 'ab-key';
      key.textContent = def.key;
      const ic = document.createElement('span');
      ic.className = 'ab-ic';
      ic.textContent = def.icon;
      const cost = document.createElement('span');
      cost.className = 'ab-cost';
      cost.textContent = `${def.cost}`;
      const ov = document.createElement('div');
      ov.className = 'ab-cdov';
      const cdt = document.createElement('div');
      cdt.className = 'ab-cdt';
      el.append(key, ic, cost, ov, cdt);
      el.title = `${def.name} [${def.key}] – ${def.cost} Fässer, Abklingzeit ${def.cooldownH} h\n${def.desc}`;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        this.trigger(def.id);
      });
      // Klicks auf die Leiste nicht an Karte/Auswahl durchreichen
      el.addEventListener('pointerdown', (e) => e.stopPropagation());
      this.bar.appendChild(el);
      this.btns.push({ el, ov, cdt, cost, def });
    }
    root.appendChild(this.bar);

    this.hint = document.createElement('div');
    this.hint.className = 'ab-hint hidden';
    root.appendChild(this.hint);
    this.tip = document.createElement('div');
    this.tip.className = 'ab-tip hidden';
    root.appendChild(this.tip);
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('class', 'ab-svg hidden');
    this.poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    this.svg.appendChild(this.poly);
    root.appendChild(this.svg);

    // Maus über der 3D-Ansicht
    const mv = (e: PointerEvent) => {
      this.mx = e.clientX;
      this.my = e.clientY;
      this.mouseIn = true;
    };
    const lv = () => (this.mouseIn = false);
    opts.canvas.addEventListener('pointermove', mv);
    opts.canvas.addEventListener('pointerleave', lv);
    this.offs.push(() => opts.canvas.removeEventListener('pointermove', mv), () => opts.canvas.removeEventListener('pointerleave', lv));

    // Rechtsklick bricht ab und löst keinen Bewegungsbefehl aus (Capture, vor Input/SelectionController)
    const rdown = (e: Event) => {
      if (!this.target || (e as MouseEvent).button !== 2) return;
      this.swallowRight = true;
      this.cancel();
      e.preventDefault();
      e.stopPropagation();
    };
    const rother = (e: Event) => {
      if (!this.swallowRight) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.type === 'pointerup' || e.type === 'mouseup') window.setTimeout(() => (this.swallowRight = false), 0);
    };
    for (const t of ['pointerdown', 'mousedown']) window.addEventListener(t, rdown, true);
    for (const t of ['pointerup', 'mouseup', 'contextmenu', 'auxclick', 'click']) window.addEventListener(t, rother, true);
    this.offs.push(() => {
      for (const t of ['pointerdown', 'mousedown']) window.removeEventListener(t, rdown, true);
      for (const t of ['pointerup', 'mouseup', 'contextmenu', 'auxclick', 'click']) window.removeEventListener(t, rother, true);
    });

    // Tasten
    if (opts.keys) {
      opts.keys.keyHooks.push((e) => this.handleKey(e));
    } else {
      const kd = (e: KeyboardEvent) => {
        if (this.handleKey(e)) {
          e.preventDefault();
          e.stopPropagation();
        }
      };
      window.addEventListener('keydown', kd, true);
      this.offs.push(() => window.removeEventListener('keydown', kd, true));
    }

    this.offs.push(
      bus.on('ability:used', (e) => {
        if (e.a3 === this.o.getPlayer()) this.usedAt.set(e.id, this.o.getGameHours?.() ?? 0);
      }),
    );
    this.timer = window.setInterval(() => this.refresh(), 200);
  }

  dispose(): void {
    this.cancel();
    for (const o of this.offs) o();
    window.clearInterval(this.timer);
    this.bar.remove();
    this.hint.remove();
    this.tip.remove();
    this.svg.remove();
  }

  show(): void {
    this.shown = true;
    this.bar.classList.remove('hidden');
    this.refresh();
  }

  hide(): void {
    this.shown = false;
    this.cancel();
    this.bar.classList.add('hidden');
  }

  // ------------------------------------------------------------------ Zielmodus

  isTargeting(): boolean {
    return this.target !== null;
  }

  /** Id der Fähigkeit im Zielmodus (oder null) */
  get targetId(): string | null {
    return this.target?.id ?? null;
  }

  cancel(): void {
    if (!this.target) return;
    this.target = null;
    this.chk = null;
    this.hint.classList.add('hidden');
    this.tip.classList.add('hidden');
    this.svg.classList.add('hidden');
    this.o.canvas.style.cursor = this.oldCursor;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.refresh();
  }

  /** Zielmodus für eine Fähigkeit starten (Klick/Taste); prüft Abklingzeit und Fässer. */
  trigger(id: string): boolean {
    const b = this.btns.find((q) => q.def.id === id);
    if (!b) return false;
    const a3 = this.o.getPlayer();
    if (!a3) return false;
    if (this.target?.id === id) {
      this.cancel();
      return true;
    }
    const left = this.left(a3, id);
    if (left > 1e-9) {
      this.deny(b.el, `${b.def.name}: noch ${fmtH(left)} Abklingzeit`);
      return false;
    }
    if (this.o.getBarrels() + 1e-9 < b.def.cost) {
      this.deny(b.el, `${b.def.name}: zu wenig Öl (${b.def.cost} Fässer nötig)`);
      return false;
    }
    this.begin(b.def);
    return true;
  }

  /** Für die Klickverdrahtung in main.ts (wie prodPanel.onMapClick): true = Klick verbraucht */
  onMapClick(x: number, z: number): boolean {
    const d = this.target;
    if (!d) return false;
    const a3 = this.o.getPlayer();
    if (!a3) {
      this.cancel();
      return true;
    }
    const chk = this.o.abilities.checkTarget?.(a3, d.id, x, z);
    if (chk && !chk.ok) {
      this.warnToast(chk.reason ?? 'Ungültiges Ziel');
      return true;
    }
    const res = this.o.abilities.use(a3, d.id, x, z);
    if (res && res.ok === false) {
      this.warnToast(res.reason ?? 'Fähigkeit nicht verfügbar');
      return true;
    }
    if (res && res.warn) bus.emit('toast', { msg: res.warn, kind: 'warn' });
    else if (chk && chk.warn) bus.emit('toast', { msg: chk.warn, kind: 'warn' });
    // Gast-Proxy: Antwort kommt später; Abklingzeit lokal vormerken
    if (!res || !this.o.abilities.cooldownLeft) this.usedAt.set(d.id, this.o.getGameHours?.() ?? 0);
    this.cancel();
    return true;
  }

  /** Taste behandeln; true = verbraucht. F1..F6 starten die Fähigkeit, Esc bricht den Zielmodus ab. */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.shown) return false;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return false;
    if (e.code === 'Escape') {
      if (this.target) {
        this.cancel();
        return true;
      }
      return false;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const b = this.btns.find((q) => q.def.key === e.code);
    if (!b) return false;
    if (!e.repeat) this.trigger(b.def.id);
    return true;
  }

  // ------------------------------------------------------------------ intern

  private left(a3: string, id: string): number {
    const port = this.o.abilities;
    if (port.cooldownLeft) return port.cooldownLeft(a3, id);
    const t0 = this.usedAt.get(id);
    const d = port.defs.find((q) => q.id === id);
    if (t0 === undefined || !d || !this.o.getGameHours) return 0;
    return Math.max(0, t0 + d.cooldownH - this.o.getGameHours());
  }

  private deny(el: HTMLElement, msg: string): void {
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    bus.emit('toast', { msg, kind: 'warn' });
  }

  private warnToast(msg: string): void {
    bus.emit('toast', { msg, kind: 'warn' });
  }

  private begin(def: AbilityDef): void {
    if (!this.target) this.oldCursor = this.o.canvas.style.cursor;
    this.target = def;
    this.chk = null;
    this.chkAt = '';
    this.o.canvas.style.cursor = 'crosshair';
    this.hint.textContent = `${def.icon} ${def.name}: Ziel mit Linksklick wählen · Rechtsklick/Esc: abbrechen`;
    this.hint.className = 'ab-hint';
    this.svg.setAttribute('class', 'ab-svg');
    this.refresh();
    if (!this.raf) this.raf = requestAnimationFrame(this.loop);
  }

  private readonly loop = (): void => {
    this.raf = 0;
    const d = this.target;
    if (!d) return;
    this.raf = requestAnimationFrame(this.loop);
    if (!this.mouseIn) {
      this.svg.classList.add('hidden');
      this.tip.classList.add('hidden');
      return;
    }
    const hit = this.o.pick(this.mx, this.my);
    if (!hit) {
      this.svg.classList.add('hidden');
      this.tip.classList.add('hidden');
      return;
    }
    // Zielprüfung (gedrosselt)
    const a3 = this.o.getPlayer();
    const now = performance.now();
    const key = `${Math.round(hit.x * 50)}|${Math.round(hit.z * 50)}`;
    if (a3 && this.o.abilities.checkTarget && key !== this.chkAt && now - this.lastChk > 80) {
      this.lastChk = now;
      this.chkAt = key;
      this.chk = this.o.abilities.checkTarget(a3, d.id, hit.x, hit.z);
    }
    const bad = !!this.chk && !this.chk.ok;
    const warn = !!this.chk && this.chk.ok && !!this.chk.warn;
    this.svg.setAttribute('class', `ab-svg${bad ? ' bad' : warn ? ' warn' : ''}`);
    this.drawRing(hit.x, hit.z, d.radiusKm);
    const msg = bad ? this.chk!.reason : warn ? this.chk!.warn : '';
    if (msg) {
      const r = this.root.getBoundingClientRect();
      this.tip.textContent = msg ?? '';
      this.tip.className = `ab-tip${bad ? ' bad' : ''}`;
      this.tip.style.left = `${this.mx - r.left}px`;
      this.tip.style.top = `${this.my - r.top}px`;
    } else this.tip.classList.add('hidden');
    this.hint.className = `ab-hint${bad ? ' bad' : warn ? ' warn' : ''}`;
  };

  private drawRing(x: number, z: number, rKm: number): void {
    const cam = this.o.getCamera();
    const rect = this.root.getBoundingClientRect();
    const W = rect.width, H = rect.height;
    const N = 40;
    let pts = '';
    let n = 0;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const px = x + Math.cos(a) * rKm, pz = z + Math.sin(a) * rKm;
      this.v.set(px, this.o.groundY?.(px, pz) ?? 0, pz).project(cam);
      if (this.v.z > 1) continue;
      pts += `${((this.v.x * 0.5 + 0.5) * W).toFixed(1)},${((-this.v.y * 0.5 + 0.5) * H).toFixed(1)} `;
      n++;
    }
    if (n < 3) {
      this.svg.classList.add('hidden');
      return;
    }
    this.poly.setAttribute('points', pts);
    this.svg.classList.remove('hidden');
  }

  /** Tasten-/Abklinganzeige, Fässer, Position über der Minikarte */
  private refresh(): void {
    if (!this.shown) return;
    const a3 = this.o.getPlayer();
    const barrels = this.o.getBarrels();
    for (const b of this.btns) {
      const left = a3 ? this.left(a3, b.def.id) : 0;
      const cd = left > 1e-9;
      const poor = !cd && barrels + 1e-9 < b.def.cost;
      b.el.classList.toggle('cd', cd);
      b.el.classList.toggle('poor', poor);
      b.el.classList.toggle('active', this.target === b.def);
      b.ov.style.height = cd ? `${Math.min(100, (left / b.def.cooldownH) * 100).toFixed(0)}%` : '0';
      b.cdt.textContent = cd ? fmtShort(left) : '';
    }
    // über die Minikarte setzen (deren Höhe ist fix, aber nicht hart codieren)
    let h = 0;
    this.root.querySelectorAll<HTMLElement>('.minimap').forEach((m) => {
      if (m.offsetParent !== null) h = Math.max(h, m.offsetHeight);
    });
    this.bar.style.bottom = `${12 + (h ? h + 8 : 0)}px`;
  }
}

function fmtH(h: number): string {
  const m = Math.ceil(h * 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

/** Kurzform für die Kachel: "1:20" (h:min) bzw. "45m" */
function fmtShort(h: number): string {
  const m = Math.ceil(h * 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}` : `${m}m`;
}
