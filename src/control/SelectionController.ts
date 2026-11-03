import type { StructureKind } from '../combat/types';
import { COMBAT_MODES, CombatControls, type CombatMode } from './CombatControls';
import * as THREE from 'three';
import { bus } from '../core/EventBus';
import type { Input, InputDragEvent } from '../core/Input';
import type { Settings } from '../core/types';
import type { RTSCamera } from '../camera/RTSCamera';
import type { Picker } from '../world/Picker';
import type { GeoData } from '../world/GeoData';
import type { UnitManager } from '../units/UnitManager';
import type { UnitRenderer } from '../units/UnitRenderer';
import type { Formation, MoveOptions, Order, OrderKind, Unit } from '../units/types';
import { FORMATION_NAMES } from '../units/types';

/**
 * Phase 2 – Auswahl & Befehle (Broken-Arrow-/Klassik-RTS-Steuerung).
 *
 * Maus
 *   Linksklick            eigene Einheit auswählen (Shift: hinzufügen/umschalten, Doppelklick: alle dieses Typs im Bild)
 *   Links-Ziehen          Rahmenauswahl (Shift: hinzufügen)
 *   Rechtsklick           Bewegen (Shift: Wegpunkt anhängen, Strg: Angriffsbewegung)
 *   Rechts-Ziehen         Formationsbreite + Blickrichtung (nur mit Auswahl; sonst schwenkt die Kamera)
 * Tastatur (KeyboardEvent.code, Beschriftung QWERTZ)
 *   G Angriffsbewegung · V Rückwärts · B Patrouille (jeweils danach Linksklick), T Stopp, Y (KeyZ) Halten,
 *   F Formation wechseln, Strg+1..9 Gruppe setzen, Shift+1..9 zur Gruppe hinzufügen, 1..9 Gruppe wählen
 *   (zweimal schnell: Kamera), Strg+A alle eigenen Einheiten im Bild, Esc Modus abbrechen / Auswahl aufheben.
 */

export type TargetMode = 'none' | 'move' | 'attackMove' | 'reverse' | 'patrol' | 'spawn' | 'fireAt' | 'garrison' | 'demolish' | 'repair' | 'build';

export interface SelectionClickEvent {
  ndcX: number;
  ndcY: number;
  x: number;
  y: number;
  button: number;
  shift: boolean;
  ctrl: boolean;
  double: boolean;
}

export interface SelectionControllerOptions {
  canvas: HTMLCanvasElement;
  uiRoot: HTMLElement;
  input: Input;
  rts: RTSCamera;
  picker: Picker;
  units: UnitManager;
  unitRenderer: UnitRenderer;
  geo: GeoData;
  settings: Settings;
}

export const FORMATION_ORDER: Formation[] = ['line', 'column', 'wedge', 'spread'];

export const ORDER_NAMES: Record<OrderKind, string> = {
  attack: 'Angreifen',
  fireAt: 'Feuerbefehl',
  garrison: 'Gebäude besetzen',
  build: 'Bauen',
  demolish: 'Sprengen',
  repair: 'Reparieren',
  move: 'Bewegen',
  attackMove: 'Angriffsbewegung',
  reverse: 'Rückwärts',
  hold: 'Halten',
  defend: 'Verteidigen',
  retreat: 'Rückzug',
  patrol: 'Patrouille',
  stop: 'Stopp',
};

/** Linienfarben je Befehlsart (RGB 0..1) */
const ORDER_COLORS: Record<OrderKind, [number, number, number]> = {
  attack: [1, 0.25, 0.2],
  fireAt: [1, 0.55, 0.15],
  garrison: [0.5, 0.7, 1],
  build: [0.9, 0.8, 0.3],
  demolish: [1, 0.4, 0.1],
  repair: [0.4, 0.9, 0.9],
  move: [0.47, 0.86, 0.36],
  attackMove: [0.95, 0.33, 0.24],
  reverse: [0.95, 0.85, 0.27],
  patrol: [0.38, 0.62, 0.95],
  retreat: [0.95, 0.6, 0.25],
  hold: [0.75, 0.7, 0.5],
  defend: [0.75, 0.7, 0.5],
  stop: [0.75, 0.7, 0.5],
};
const GHOST_COLOR: [number, number, number] = [1.0, 0.78, 0.35];
const GHOST_DIM: [number, number, number] = [0.85, 0.62, 0.25];

const MIN_PICK_PX = 10;
const GROUP_DOUBLE_TAP_MS = 300;
/** Mindest-Zieh-Länge (px) für Formationsziehen; darunter: nur Blickrichtung ab Startpunkt */
const MIN_FORMATION_DRAG_PX = 14;
/** Obergrenze Stützpunkte je gezeichneter Route */
const MAX_ROUTE_SAMPLES = 1500;

interface FormationDrag {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** Bildschirmlänge des Zuges (px) */
  px: number;
  valid: boolean;
  ghosts: Array<[number, number]>;
  ghostsDirty: boolean;
  facing: number;
  cx: number;
  cz: number;
  widthKm: number;
}

export class SelectionController {
  /** Für main.ts: zur Szene hinzufügen */
  readonly object: THREE.Object3D;

  /** ADM0_A3 des Spielers – nur dessen Einheiten sind wähl- und befehligbar */
  playerA3: string | null = null;

  /** Aktuelle Formation für neue Befehle (Panel / F) */
  formation: Formation = 'line';

  /** Wird bei jeder Änderung von Auswahl/Gruppen/Modus/Formation erhöht (für UI-Polling) */
  version = 0;

  private _enabled = true;
  private readonly sel = new Set<number>();
  private readonly groups: number[][] = [[], [], [], [], [], [], [], [], [], []];
  private lastGroupKey = -1;
  private lastGroupTime = -1e9;

  /** Phase 3: Kampf-/Bau-/Gebäudebefehle (Services werden von main.ts gesetzt) */
  readonly cc: CombatControls = new CombatControls(this);

  /** Testmodus: Besitzer gespawnter Einheiten (null = eigene Nation) */
  testOwner: string | null = null;

  private _mode: TargetMode = 'none';
  private spawnType: string | null = null;

  private readonly canvas: HTMLCanvasElement;
  private readonly uiRoot: HTMLElement;
  private readonly input: Input;
  private readonly rts: RTSCamera;
  private readonly picker: Picker;
  private readonly units: UnitManager;
  private readonly unitRenderer: UnitRenderer;
  private readonly geo: GeoData;

  // DOM
  private readonly box: HTMLDivElement;
  private readonly toastWrap: HTMLDivElement;
  private readonly modeHint: HTMLDivElement;

  // Rahmenauswahl
  private boxActive = false;
  private boxX0 = 0;
  private boxY0 = 0;
  private boxX1 = 0;
  private boxY1 = 0;

  // Rechts-Ziehen
  private fdrag: FormationDrag | null = null;

  // „Kein Weg gefunden“-Überwachung: Unit-ID -> Sekunden seit Befehl
  private readonly pendingRoute = new Map<number, { order: Order; x0: number; z0: number }>();

  // Linien-Puffer (wachsend, wiederverwendet)
  private readonly lineGeom = new THREE.BufferGeometry();
  private readonly lines: THREE.LineSegments;
  private pos = new Float32Array(3 * 2048);
  private col = new Float32Array(3 * 2048);
  private nVerts = 0;
  private lift = 0.01;
  private markerSize = 1;

  // Temporäre Objekte
  private readonly tmpV = new THREE.Vector3();
  private readonly cleanup: Array<() => void> = [];

  constructor(opts: SelectionControllerOptions) {
    this.canvas = opts.canvas;
    this.uiRoot = opts.uiRoot;
    this.input = opts.input;
    this.rts = opts.rts;
    this.picker = opts.picker;
    this.units = opts.units;
    this.unitRenderer = opts.unitRenderer;
    this.geo = opts.geo;

    // ---------- three.js
    this.lineGeom.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.lineGeom.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.lineGeom.setDrawRange(0, 0);
    const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.92, depthWrite: false, fog: false });
    this.lines = new THREE.LineSegments(this.lineGeom, mat);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 10;
    const g = new THREE.Group();
    g.name = 'SelectionController';
    g.add(this.lines);
    this.object = g;

    // ---------- DOM
    this.box = document.createElement('div');
    this.box.className = 'ctl-box hidden';
    this.toastWrap = document.createElement('div');
    this.toastWrap.className = 'ctl-toasts';
    this.modeHint = document.createElement('div');
    this.modeHint.className = 'ctl-mode hidden';
    this.uiRoot.append(this.box, this.toastWrap, this.modeHint);

    // ---------- Eingaben
    const inp = this.input;
    this.cleanup.push(
      inp.onDragStart((e) => this.onDragStart(e)),
      inp.onDrag((e) => this.onDragMove(e)),
      inp.onDragEnd((e) => this.onDragEnd(e)),
      inp.onClick((e) => {
        if (e.button === 2) this.onRightClick(e);
      }),
    );
    // Capture-Phase: läuft vor den Fenster-Listenern von Hud/Input, damit verbrauchte Tasten
    // (Ziffern bei Gruppen, Esc bei Auswahl) nicht zusätzlich Spielgeschwindigkeit/Pausemenü auslösen.
    const onKey = (e: KeyboardEvent) => this.onKey(e);
    window.addEventListener('keydown', onKey, true);
    this.cleanup.push(() => window.removeEventListener('keydown', onKey, true));
    void opts.settings;
  }

  // ================================================================== öffentliche API

  get enabled(): boolean {
    return this._enabled;
  }
  set enabled(v: boolean) {
    if (v === this._enabled) return;
    this._enabled = v;
    if (!v) {
      this.cancelMode();
      this.endBox();
      this.fdrag = null;
      this.rts.rightDragPan = true;
      this.nVerts = 0;
      this.lineGeom.setDrawRange(0, 0);
    }
  }

  get selected(): ReadonlySet<number> {
    return this.sel;
  }

  get hasSelection(): boolean {
    return this.sel.size > 0;
  }

  /** Aktiver Zielmodus (Klick auf Karte erwartet) */
  get mode(): TargetMode {
    return this._mode;
  }

  get spawnTypeId(): string | null {
    return this.spawnType;
  }

  /** Ausgewählte (existierende, eigene) Einheiten – frisches Array */
  selectedUnits(): Unit[] {
    const out: Unit[] = [];
    this.sel.forEach((id) => {
      const u = this.units.get(id);
      if (u) out.push(u);
    });
    return out;
  }

  /** main.ts leitet Linksklicks auf das Canvas weiter. true = verbraucht (keine Länderauswahl). */
  handleClick(e: SelectionClickEvent): boolean {
    if (!this._enabled || e.button !== 0) return false;

    if (this._mode !== 'none') {
      this.applyModeClick(e);
      return true;
    }

    const hit = this.pickUnitAt(e.x, e.y);
    if (hit) {
      if (e.double) {
        const same = this.ownUnitsOnScreen().filter((u) => u.type.id === hit.type.id).map((u) => u.id);
        this.select(same, e.shift);
      } else if (e.shift) {
        if (this.sel.has(hit.id)) this.deselect([hit.id]);
        else this.select([hit.id], true);
      } else {
        this.select([hit.id]);
      }
      return true;
    }
    // Leerer Boden: Auswahl aufheben (ohne Shift), Klick geht an die Länderauswahl weiter
    if (!e.shift && this.sel.size) this.clear();
    return false;
  }

  select(ids: number[], additive = false): void {
    let changed = false;
    if (!additive && this.sel.size) {
      const keep = new Set(ids);
      for (const id of [...this.sel]) {
        if (keep.has(id)) continue;
        this.sel.delete(id);
        this.setUnitSelected(id, false);
        changed = true;
      }
    }
    for (const id of ids) {
      if (this.sel.has(id)) continue;
      const u = this.units.get(id);
      if (!u || !this.isOwn(u)) continue;
      this.sel.add(id);
      u.selected = true;
      changed = true;
    }
    if (changed) this.selectionChanged();
  }

  deselect(ids: number[]): void {
    let changed = false;
    for (const id of ids) {
      if (this.sel.delete(id)) {
        this.setUnitSelected(id, false);
        changed = true;
      }
    }
    if (changed) this.selectionChanged();
  }

  clear(): void {
    if (!this.sel.size) return;
    this.sel.forEach((id) => this.setUnitSelected(id, false));
    this.sel.clear();
    this.selectionChanged();
  }

  /** Formation für Auswahl setzen (und als Vorgabe für neue Befehle) */
  setFormation(f: Formation): void {
    this.formation = f;
    const ids = this.commandIds();
    if (ids.length) this.units.setFormation(ids, f);
    if (this.fdrag) this.fdrag.ghostsDirty = true;
    this.version++;
  }

  cycleFormation(dir = 1): void {
    const i = FORMATION_ORDER.indexOf(this.formation);
    const f = FORMATION_ORDER[(i + dir + FORMATION_ORDER.length) % FORMATION_ORDER.length];
    this.setFormation(f);
    this.toast(`Formation: ${FORMATION_NAMES[f]}`, 'info');
  }

  /** Zielmodus starten: nächster Linksklick auf die Karte setzt den Befehl */
  beginMode(m: Exclude<TargetMode, 'spawn' | 'none'>): void {
    if (!this.commandIds().length) {
      this.toast('Keine Einheiten ausgewählt', 'warn');
      return;
    }
    this._mode = m;
    this.spawnType = null;
    this.updateModeUi();
  }

  /** Pioniere: Bauwerk platzieren (Panel-Palette) */
  beginBuild(kind: StructureKind): void {
    this.cc.buildKind = kind;
    this.cc.resetBuild();
    this.beginMode('build');
  }

  /** Testmodus: nächster Linksklick platziert eine Einheit dieses Typs für den Spieler */
  beginSpawn(typeId: string): void {
    if (!this.playerA3) return;
    this._mode = 'spawn';
    this.spawnType = typeId;
    this.updateModeUi();
  }

  cancelMode(): void {
    this.cc.resetBuild();
    if (this._mode === 'none') return;
    this._mode = 'none';
    this.spawnType = null;
    this.updateModeUi();
  }

  stop(): void {
    const ids = this.commandIds();
    if (!ids.length) return;
    this.units.issueStop(ids);
    for (const id of ids) this.pendingRoute.delete(id);
  }

  hold(): void {
    const ids = this.commandIds();
    if (!ids.length) return;
    this.units.issueHold(ids);
    for (const id of ids) this.pendingRoute.delete(id);
  }

  /** Bewegungsbefehl an Auswahl (Panel/Minikarte nutzbar) */
  issueMoveTo(x: number, z: number, opts: MoveOptions = {}): void {
    const ids = this.commandIds();
    if (!ids.length) return;
    const o: MoveOptions = { formation: this.formation, ...opts };
    this.units.issueMove(ids, x, z, o);
    for (const id of ids) {
      const u = this.units.get(id);
      const o = u && u.orders.length ? u.orders[u.orders.length - 1] : undefined;
      if (u && o) this.pendingRoute.set(id, { order: o, x0: u.x, z0: u.z });
    }
  }

  // ---------- Kontrollgruppen (1..9)

  getGroup(n: number): readonly number[] {
    return this.groups[n] ?? [];
  }

  assignGroup(n: number, add = false): void {
    if (n < 1 || n > 9) return;
    const ids = this.commandIds();
    if (!add) {
      this.groups[n] = ids.slice();
      this.toast(ids.length ? `Gruppe ${n} gesetzt (${ids.length})` : `Gruppe ${n} geleert`, 'info');
    } else {
      const g = this.groups[n];
      for (const id of ids) if (!g.includes(id)) g.push(id);
      this.toast(`Gruppe ${n}: ${g.length} Einheiten`, 'info');
    }
    this.version++;
  }

  recallGroup(n: number): void {
    const g = this.groups[n];
    if (!g || !g.length) return;
    const now = performance.now();
    const doubleTap = this.lastGroupKey === n && now - this.lastGroupTime < GROUP_DOUBLE_TAP_MS;
    this.lastGroupKey = doubleTap ? -1 : n;
    this.lastGroupTime = doubleTap ? -1e9 : now;
    this.select(g.slice());
    if (doubleTap) this.focusSelection();
  }

  /** Kamera auf Schwerpunkt der Auswahl */
  focusSelection(): void {
    let sx = 0, sz = 0, n = 0;
    this.sel.forEach((id) => {
      const u = this.units.get(id);
      if (!u) return;
      sx += u.x;
      sz += u.z;
      n++;
    });
    if (n) this.rts.focus(sx / n, sz / n);
  }

  selectAllOnScreen(): void {
    this.select(this.ownUnitsOnScreen().map((u) => u.id));
  }

  /** Kurze Meldung über dem Befehlspanel */
  toast(msg: string, kind: 'info' | 'warn' | 'bad' = 'info', ms = 2200): void {
    const wrap = this.toastWrap;
    // Gleiche Meldung nicht stapeln
    for (const c of Array.from(wrap.children)) if (c.textContent === msg) c.remove();
    const t = document.createElement('div');
    t.className = `ctl-toast ${kind}`;
    t.textContent = msg;
    wrap.appendChild(t);
    while (wrap.children.length > 4) wrap.firstElementChild?.remove();
    window.setTimeout(() => {
      t.classList.add('out');
      window.setTimeout(() => t.remove(), 350);
    }, ms);
  }

  update(dt: number): void {
    void dt; // Zeitbasis derzeit nicht benötigt (Signatur für main.ts stabil)
    // Entfernte / fremd gewordene Einheiten aus Auswahl & Gruppen räumen
    let changed = false;
    for (const id of this.sel) {
      const u = this.units.get(id);
      if (!u || !this.isOwn(u)) {
        this.sel.delete(id);
        if (u) u.selected = false;
        changed = true;
      }
    }
    if (changed) this.selectionChanged();
    for (let n = 1; n <= 9; n++) {
      const g = this.groups[n];
      if (!g.length) continue;
      const before = g.length;
      for (let i = g.length - 1; i >= 0; i--) if (!this.units.get(g[i])) g.splice(i, 1);
      if (g.length !== before) this.version++;
    }

    this.rts.rightDragPan = !(this._enabled && (this.fdrag !== null || this.commandCount() > 0));

    if (!this._enabled) return;

    this.checkRoutes();

    // Formations-Vorschau aktualisieren
    const fd = this.fdrag;
    if (fd && fd.valid && fd.ghostsDirty) {
      fd.ghostsDirty = false;
      const ids = this.commandIds();
      fd.ghosts = ids.length ? this.units.previewFormation(ids, fd.cx, fd.cz, this.dragMoveOptions(fd)) : [];
    }

    this.rebuildLines();
  }

  dispose(): void {
    this.cleanup.forEach((f) => f());
    this.cleanup.length = 0;
    this.box.remove();
    this.toastWrap.remove();
    this.modeHint.remove();
    this.lineGeom.dispose();
    (this.lines.material as THREE.Material).dispose();
  }

  // ================================================================== intern: Auswahl

  private isOwn(u: Unit): boolean {
    return this.playerA3 !== null && u.owner === this.playerA3;
  }

  private setUnitSelected(id: number, v: boolean): void {
    const u = this.units.get(id);
    if (u) u.selected = v;
  }

  private selectionChanged(): void {
    // Formation der Auswahl übernehmen
    for (const id of this.sel) {
      const u = this.units.get(id);
      if (u) {
        this.formation = u.formation;
        break;
      }
    }
    if (!this.sel.size && this._mode !== 'spawn') this.cancelMode();
    this.version++;
    bus.emit('units:selection', { ids: [...this.sel] });
  }

  /** IDs ausgewählter eigener Einheiten (für Befehle) */
  commandIds(): number[] {
    const out: number[] = [];
    this.sel.forEach((id) => {
      const u = this.units.get(id);
      if (u && this.isOwn(u)) out.push(id);
    });
    return out;
  }

  private commandCount(): number {
    let n = 0;
    this.sel.forEach((id) => {
      const u = this.units.get(id);
      if (u && this.isOwn(u)) n++;
    });
    return n;
  }

  /** Projiziert Weltpunkt in Canvas-Pixel; out[2] = Tiefe (Kameraabstand entlang Blickachse), <= 0 = hinter der Kamera */
  private project(x: number, y: number, z: number, out: [number, number, number]): boolean {
    const cam = this.rts.camera;
    const v = this.tmpV.set(x, y, z).applyMatrix4(cam.matrixWorldInverse);
    const depth = -v.z;
    out[2] = depth;
    if (depth <= cam.near) return false;
    v.applyMatrix4(cam.projectionMatrix);
    const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
    out[0] = (v.x * 0.5 + 0.5) * w;
    out[1] = (-v.y * 0.5 + 0.5) * h;
    return true;
  }

  private readonly projOut: [number, number, number] = [0, 0, 0];

  /** Pixel pro km in Tiefe depth */
  private pxPerKm(depth: number): number {
    const h = this.canvas.clientHeight || 1;
    const fov = (this.rts.camera.fov * Math.PI) / 180;
    return h / (2 * Math.tan(fov / 2) * Math.max(1e-4, depth));
  }

  private pickUnitAt(px: number, py: number): Unit | null {
    return this.pickUnitWhere(px, py, (u) => this.isOwn(u));
  }

  /** Feindliche (laut War) Einheit unter dem Mauszeiger */
  private pickEnemyAt(px: number, py: number): Unit | null {
    return this.pickUnitWhere(px, py, (u) => !u.garrisonId && this.cc.isHostileOwner(u.owner));
  }

  private pickUnitWhere(px: number, py: number, accept: (u: Unit) => boolean): Unit | null {
    if (!this.playerA3) return null;
    let best: Unit | null = null;
    let bestD = Infinity;
    const p = this.projOut;
    for (const u of this.units.units) {
      if (!accept(u)) continue;
      if (!this.project(u.x, u.y, u.z, p)) continue;
      const r = Math.max(MIN_PICK_PX, this.unitRenderer.visualRadiusKm(u) * this.pxPerKm(p[2]));
      const d = Math.hypot(p[0] - px, p[1] - py);
      if (d <= r && d < bestD) {
        bestD = d;
        best = u;
      }
    }
    return best;
  }

  private ownUnitsOnScreen(): Unit[] {
    const out: Unit[] = [];
    if (!this.playerA3) return out;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const p = this.projOut;
    for (const u of this.units.units) {
      if (!this.isOwn(u)) continue;
      if (!this.project(u.x, u.y, u.z, p)) continue;
      if (p[0] >= 0 && p[1] >= 0 && p[0] <= w && p[1] <= h) out.push(u);
    }
    return out;
  }

  private unitsInScreenRect(x0: number, y0: number, x1: number, y1: number): number[] {
    const out: number[] = [];
    if (!this.playerA3) return out;
    const p = this.projOut;
    for (const u of this.units.units) {
      if (!this.isOwn(u)) continue;
      if (!this.project(u.x, u.y, u.z, p)) continue;
      // Rahmen schließt Einheiten ein, deren Symbol den Rahmen berührt
      const r = Math.min(8, Math.max(2, this.unitRenderer.visualRadiusKm(u) * this.pxPerKm(p[2]) * 0.5));
      if (p[0] + r >= x0 && p[0] - r <= x1 && p[1] + r >= y0 && p[1] - r <= y1) out.push(u.id);
    }
    return out;
  }

  // ================================================================== intern: Eingaben

  getUnit(id: number): Unit | undefined {
    return this.units.get(id);
  }

  /** Suchradius (km) für Klicks auf Gebäude/Brücken, abhängig vom Zoom */
  pickRadiusKm(): number {
    return Math.min(30, Math.max(0.6, this.rts.distance * 0.03));
  }

  private pickGround(px: number, py: number) {
    const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
    return this.picker.pick((px / w) * 2 - 1, -(py / h) * 2 + 1, this.rts.camera);
  }

  private onDragStart(e: InputDragEvent): void {
    if (!this._enabled) return;
    if (e.button === 0) {
      if (this._mode !== 'none') return;
      this.boxActive = true;
      this.boxX0 = e.x0;
      this.boxY0 = e.y0;
      this.boxX1 = e.x;
      this.boxY1 = e.y;
      this.box.classList.remove('hidden');
      this.layoutBox();
    } else if (e.button === 2) {
      if (this._mode !== 'none') this.cancelMode();
      if (!this.commandCount()) return;
      const a = this.pickGround(e.x0, e.y0);
      if (!a) return;
      this.fdrag = {
        x0: a.x, z0: a.z, x1: a.x, z1: a.z, px: 0, valid: false,
        ghosts: [], ghostsDirty: true, facing: 0, cx: a.x, cz: a.z, widthKm: 0,
      };
      this.onDragMove(e);
    }
  }

  private onDragMove(e: InputDragEvent): void {
    if (e.button === 0 && this.boxActive) {
      this.boxX1 = e.x;
      this.boxY1 = e.y;
      this.layoutBox();
    } else if (e.button === 2 && this.fdrag) {
      const fd = this.fdrag;
      const b = this.pickGround(e.x, e.y);
      if (!b) return;
      fd.x1 = b.x;
      fd.z1 = b.z;
      fd.px = Math.hypot(e.x - e.x0, e.y - e.y0);
      const dx = fd.x1 - fd.x0, dz = fd.z1 - fd.z0;
      const len = Math.hypot(dx, dz);
      if (len < 1e-6) {
        fd.valid = false;
        return;
      }
      if (fd.px >= MIN_FORMATION_DRAG_PX) {
        // Linie = Front: Mitte ist das Ziel, Blick senkrecht (links→rechts gezogen = nach „vorn“/Norden)
        fd.cx = (fd.x0 + fd.x1) * 0.5;
        fd.cz = (fd.z0 + fd.z1) * 0.5;
        fd.facing = Math.atan2(dz, dx);
        fd.widthKm = len;
      } else {
        // Kurzer Zug: Ziel = Startpunkt, Blick in Zugrichtung
        fd.cx = fd.x0;
        fd.cz = fd.z0;
        fd.facing = Math.atan2(dx, -dz);
        fd.widthKm = 0;
      }
      fd.valid = true;
      fd.ghostsDirty = true;
    }
  }

  private onDragEnd(e: InputDragEvent): void {
    if (e.button === 0 && this.boxActive) {
      this.endBox();
      if (e.cancelled || !this._enabled) return;
      const x0 = Math.min(this.boxX0, this.boxX1), x1 = Math.max(this.boxX0, this.boxX1);
      const y0 = Math.min(this.boxY0, this.boxY1), y1 = Math.max(this.boxY0, this.boxY1);
      const ids = this.unitsInScreenRect(x0, y0, x1, y1);
      if (e.shift) this.select(ids, true);
      else this.select(ids);
    } else if (e.button === 2 && this.fdrag) {
      const fd = this.fdrag;
      this.fdrag = null;
      if (e.cancelled || !this._enabled || !fd.valid) return;
      this.issueMoveTo(fd.cx, fd.cz, this.dragMoveOptions(fd, e.shift, e.ctrl));
    }
  }

  private dragMoveOptions(fd: FormationDrag, queue = false, attack = false): MoveOptions {
    const o: MoveOptions = { formation: this.formation, facing: fd.facing, queue, kind: attack ? 'attackMove' : 'move' };
    if (fd.widthKm > 0) o.widthKm = fd.widthKm;
    return o;
  }

  private endBox(): void {
    this.boxActive = false;
    this.box.classList.add('hidden');
  }

  private layoutBox(): void {
    const r = this.canvas.getBoundingClientRect();
    const u = this.uiRoot.getBoundingClientRect();
    const ox = r.left - u.left, oy = r.top - u.top;
    const x0 = Math.min(this.boxX0, this.boxX1), y0 = Math.min(this.boxY0, this.boxY1);
    const s = this.box.style;
    s.left = `${ox + x0}px`;
    s.top = `${oy + y0}px`;
    s.width = `${Math.abs(this.boxX1 - this.boxX0)}px`;
    s.height = `${Math.abs(this.boxY1 - this.boxY0)}px`;
  }

  private onRightClick(e: { x: number; y: number; shift: boolean; ctrl: boolean }): void {
    if (!this._enabled) return;
    if (this._mode !== 'none') {
      this.cancelMode();
      return;
    }
    if (!this.commandCount()) return;
    const enemy = this.pickEnemyAt(e.x, e.y);
    if (enemy) {
      this.cc.attack(this.commandIds(), enemy);
      this.toast(`Angriff auf ${enemy.name || enemy.type.name}`, 'info', 1200);
      return;
    }
    const own = this.pickUnitAt(e.x, e.y);
    if (own && !this.sel.has(own.id)) {
      this.toast('Eskorte – folgt in einer späteren Phase', 'info');
      return;
    }
    const hit = this.pickGround(e.x, e.y);
    if (!hit) return;
    this.issueMoveTo(hit.x, hit.z, { queue: e.shift, kind: e.ctrl ? 'attackMove' : 'move' });
  }

  private applyModeClick(e: SelectionClickEvent): void {
    const hit = this.pickGround(e.x, e.y);
    if (!hit) return;
    const m = this._mode;
    if (m === 'spawn') {
      if (this.spawnType && this.playerA3) {
        const u = this.units.spawn(this.spawnType, this.testOwner ?? this.playerA3, hit.x, hit.z, this.viewHeading());
        if (!u) this.toast('Platzierung hier nicht möglich', 'warn');
      }
      if (!e.shift) this.cancelMode();
      return;
    }
    if (COMBAT_MODES.includes(m)) {
      const done = this.cc.handleModeClick(m as CombatMode, hit.x, hit.z, e.shift);
      if (done) {
        this.cc.resetBuild();
        this.cancelMode();
      } else this.updateModeUi();
      return;
    }
    const kind: MoveOptions['kind'] = m === 'attackMove' ? 'attackMove' : m === 'reverse' ? 'reverse' : m === 'patrol' ? 'patrol' : 'move';
    this.issueMoveTo(hit.x, hit.z, { queue: e.shift, kind });
    if (!e.shift) this.cancelMode();
  }

  /** Blickrichtung „vom Betrachter weg“ als Heading für gespawnte Einheiten */
  private viewHeading(): number {
    const cam = this.rts.camera;
    const dx = this.rts.target.x - cam.position.x, dz = this.rts.target.z - cam.position.z;
    return Math.atan2(dx, -dz);
  }

  private updateModeUi(): void {
    const m = this._mode;
    this.version++;
    this.canvas.classList.toggle('ctl-targeting', m !== 'none');
    this.canvas.dataset.ctlMode = m;
    if (m === 'none') {
      this.modeHint.classList.add('hidden');
      return;
    }
    if (COMBAT_MODES.includes(m)) {
      this.modeHint.textContent = `${this.cc.hint(m as CombatMode)} · Rechtsklick/Esc: Abbruch`;
      this.modeHint.className = `ctl-mode mode-${m}`;
      this.modeHint.classList.remove('hidden');
      return;
    }
    const label =
      m === 'spawn'
        ? `Testmodus: Einheit platzieren – Linksklick (Shift: mehrere)`
        : `${ORDER_NAMES[m === 'move' ? 'move' : m]}: Ziel mit Linksklick wählen (Shift: Wegpunkt)`;
    this.modeHint.textContent = `${label} · Rechtsklick/Esc: Abbruch`;
    this.modeHint.className = `ctl-mode mode-${m}`;
  }

  private onKey(e: KeyboardEvent): void {
    if (!this._enabled || !this.playerA3) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    // Modale Fenster (Pausemenü, Einstellungen) offen: nichts tun
    if (this.uiRoot.querySelector('.modal-backdrop:not(.hidden)')) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const code = e.code;
    const consume = () => {
      e.preventDefault();
      e.stopPropagation();
    };

    if (code === 'Escape') {
      if (this._mode !== 'none') {
        this.cancelMode();
        consume();
      } else if (this.boxActive || this.fdrag) {
        this.endBox();
        this.fdrag = null;
        consume();
      } else if (this.sel.size) {
        this.clear();
        consume();
      }
      return;
    }

    if (code.startsWith('Digit') && code.length === 6) {
      const n = code.charCodeAt(5) - 48;
      if (n < 1 || n > 9 || e.altKey) return;
      const anyGroup = this.groups.some((g) => g.length > 0);
      if (!this.sel.size && !anyGroup) return; // Ziffern frei für HUD (Spielgeschwindigkeit)
      consume();
      if (e.repeat) return;
      if (ctrl) this.assignGroup(n, false);
      else if (e.shiftKey) this.assignGroup(n, true);
      else this.recallGroup(n);
      return;
    }

    if (ctrl && code === 'KeyA') {
      consume();
      this.selectAllOnScreen();
      return;
    }

    if (ctrl || e.altKey || e.repeat) return;
    if (!this.sel.size) return;
    switch (code) {
      case 'KeyG':
        consume();
        this.beginMode('attackMove');
        break;
      case 'KeyV':
        consume();
        this.beginMode('reverse');
        break;
      case 'KeyB':
        consume();
        this.beginMode('patrol');
        break;
      case 'KeyT':
        consume();
        this.stop();
        break;
      case 'KeyZ': // QWERTZ: Taste „Y“
        consume();
        this.hold();
        break;
      case 'KeyF':
        consume();
        this.cycleFormation(e.shiftKey ? -1 : 1);
        break;
      case 'KeyK':
        consume();
        this.beginMode('fireAt');
        break;
      case 'KeyN':
        consume();
        this.beginMode('garrison');
        break;
      case 'KeyX':
        consume();
        this.cc.ungarrison();
        break;
      case 'KeyJ':
        consume();
        this.beginMode('demolish');
        break;
      case 'KeyL':
        consume();
        this.beginMode('repair');
        break;
      default:
        break;
    }
  }

  // ================================================================== intern: Wegfindungs-Warnung

  /**
   * „Kein Weg gefunden“: Der UnitManager verwirft unerreichbare Befehle sofort (bzw. berechnet Routen nur bei
   * laufender Zeit). Daher wird je Einheit der zuletzt erteilte Befehl verfolgt: verschwindet er aus der
   * Warteschlange, ohne dass je eine Route bestand und ohne dass sich die Einheit bewegt hat, und liegt das
   * Ziel nicht direkt bei der Einheit, gilt er als unerreichbar.
   */
  private checkRoutes(): void {
    if (!this.pendingRoute.size) return;
    let failed = 0;
    for (const [id, p] of this.pendingRoute) {
      const u = this.units.get(id);
      if (!u) {
        this.pendingRoute.delete(id);
        continue;
      }
      const idx = u.orders.indexOf(p.order);
      if (idx === 0 && u.route) {
        this.pendingRoute.delete(id);
        continue;
      }
      if (idx >= 0) continue;
      this.pendingRoute.delete(id);
      // Ohne Route kaum vorangekommen und Ziel weiterhin weit weg -> unerreichbar
      const far = Math.hypot(u.x - p.order.x, u.z - p.order.z);
      const far0 = Math.hypot(p.x0 - p.order.x, p.z0 - p.order.z);
      if (far > Math.max(0.5, u.type.spacingKm * 2) && far > far0 * 0.5) failed++;
    }
    if (failed) this.toast(failed > 1 ? `Kein Weg gefunden (${failed} Einheiten)` : 'Kein Weg gefunden', 'warn', 2600);
  }

  // ================================================================== intern: Befehlslinien

  private ensureCapacity(verts: number): void {
    if (verts * 3 <= this.pos.length) return;
    let cap = this.pos.length / 3;
    while (cap < verts) cap *= 2;
    const np = new Float32Array(cap * 3), nc = new Float32Array(cap * 3);
    np.set(this.pos.subarray(0, this.nVerts * 3));
    nc.set(this.col.subarray(0, this.nVerts * 3));
    this.pos = np;
    this.col = nc;
    this.lineGeom.dispose();
    this.lineGeom.setAttribute('position', new THREE.BufferAttribute(np, 3).setUsage(THREE.DynamicDrawUsage));
    this.lineGeom.setAttribute('color', new THREE.BufferAttribute(nc, 3).setUsage(THREE.DynamicDrawUsage));
  }

  private gy(x: number, z: number): number {
    return this.picker.groundY(x, z) + this.lift;
  }

  private seg(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: [number, number, number], k = 1): void {
    this.ensureCapacity(this.nVerts + 2);
    const p = this.pos, q = this.col;
    let i = this.nVerts * 3;
    p[i] = x0; p[i + 1] = y0; p[i + 2] = z0;
    q[i] = c[0] * k; q[i + 1] = c[1] * k; q[i + 2] = c[2] * k;
    i += 3;
    p[i] = x1; p[i + 1] = y1; p[i + 2] = z1;
    q[i] = c[0] * k; q[i + 1] = c[1] * k; q[i + 2] = c[2] * k;
    this.nVerts += 2;
  }

  /** Gelände-drapierte Linie (unterteilt), optional gestrichelt */
  private drape(x0: number, z0: number, x1: number, z1: number, c: [number, number, number], dashed: boolean, step: number): void {
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len < 1e-6) return;
    let n = Math.ceil(len / step);
    if (n > MAX_ROUTE_SAMPLES) n = MAX_ROUTE_SAMPLES;
    if (dashed && n < 6) n = 6;
    let px = x0, pz = z0, py = this.gy(x0, z0);
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t, y = this.gy(x, z);
      if (!dashed || (i & 1) === 1) this.seg(px, py, pz, x, y, z, c);
      px = x; pz = z; py = y;
    }
  }

  /** Flache Raute am Boden */
  private diamond(x: number, z: number, s: number, c: [number, number, number], k = 1): void {
    const ny = this.gy(x, z - s), ey = this.gy(x + s, z), sy = this.gy(x, z + s), wy = this.gy(x - s, z);
    this.seg(x, ny, z - s, x + s, ey, z, c, k);
    this.seg(x + s, ey, z, x, sy, z + s, c, k);
    this.seg(x, sy, z + s, x - s, wy, z, c, k);
    this.seg(x - s, wy, z, x, ny, z - s, c, k);
  }

  /** Pfeil in Richtung heading (0 = Norden, im Uhrzeigersinn) */
  private arrow(x: number, z: number, heading: number, len: number, c: [number, number, number]): void {
    const dx = Math.sin(heading), dz = -Math.cos(heading);
    const ex = x + dx * len, ez = z + dz * len;
    const y0 = this.gy(x, z), y1 = this.gy(ex, ez);
    this.seg(x, y0, z, ex, y1, ez, c);
    const h = len * 0.35;
    for (const s of [-1, 1]) {
      const a = heading + Math.PI + s * 0.5;
      const hx = ex + Math.sin(a) * h, hz = ez - Math.cos(a) * h;
      this.seg(ex, y1, ez, hx, this.gy(hx, hz), hz, c);
    }
  }

  private rebuildLines(): void {
    this.nVerts = 0;
    const dist = this.rts.distance;
    this.lift = dist * 0.008 + 0.004;
    this.markerSize = dist * 0.012;
    const step = Math.max(this.geo.cellKm, dist * 0.012);
    const ms = this.markerSize;

    for (const id of this.sel) {
      const u = this.units.get(id);
      if (!u || !u.orders.length) continue;
      const o0 = u.orders[0];
      const c0 = ORDER_COLORS[o0.kind] ?? ORDER_COLORS.move;
      let lx = u.x, lz = u.z;
      const r = u.route;
      if (r && r.points.length >= 4) {
        // Restroute ab aktueller Position
        const pts = r.points;
        const nPts = pts.length >> 1;
        let acc = 0;
        let i = 1;
        for (; i < nPts; i++) {
          const sl = Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]);
          if (acc + sl > u.routeKm) break;
          acc += sl;
        }
        for (; i < nPts; i++) {
          const x = pts[i * 2], z = pts[i * 2 + 1];
          this.drape(lx, lz, x, z, c0, false, step);
          lx = x;
          lz = z;
        }
      } else if (o0.kind !== 'hold' && o0.kind !== 'stop' && o0.kind !== 'defend') {
        // Route wird berechnet: gestrichelte Luftlinie
        this.drape(lx, lz, o0.x, o0.z, c0, true, step);
        lx = o0.x;
        lz = o0.z;
      }
      if (o0.kind !== 'hold' && o0.kind !== 'stop') {
        this.diamond(o0.x, o0.z, ms, c0);
        if (o0.facing !== undefined) this.arrow(o0.x, o0.z, o0.facing, ms * 2.2, c0);
      }
      lx = o0.x;
      lz = o0.z;
      // Warteschlange
      for (let k = 1; k < u.orders.length; k++) {
        const o = u.orders[k];
        const c = ORDER_COLORS[o.kind] ?? ORDER_COLORS.move;
        if (o.kind === 'hold' || o.kind === 'stop' || o.kind === 'defend') continue;
        this.drape(lx, lz, o.x, o.z, c, true, step);
        this.diamond(o.x, o.z, ms * 0.8, c, 0.9);
        if (o.facing !== undefined) this.arrow(o.x, o.z, o.facing, ms * 2, c);
        lx = o.x;
        lz = o.z;
      }
      // Patrouille: Schleife zum Ausgangspunkt andeuten
      for (const o of u.orders) {
        if (o.kind !== 'patrol' || o.originX === undefined || o.originZ === undefined) continue;
        this.drape(o.x, o.z, o.originX, o.originZ, ORDER_COLORS.patrol, true, step);
        this.diamond(o.originX, o.originZ, ms * 0.6, ORDER_COLORS.patrol, 0.8);
      }
    }

    // Rechts-Ziehen: Vorschau
    const fd = this.fdrag;
    if (fd && fd.valid) {
      if (fd.widthKm > 0) {
        this.drape(fd.x0, fd.z0, fd.x1, fd.z1, GHOST_COLOR, false, step);
        this.arrow(fd.cx, fd.cz, fd.facing, Math.max(ms * 3, fd.widthKm * 0.25), GHOST_COLOR);
      } else {
        this.arrow(fd.cx, fd.cz, fd.facing, ms * 4, GHOST_COLOR);
      }
      for (const g of fd.ghosts) {
        this.diamond(g[0], g[1], ms * 0.55, GHOST_DIM);
        this.arrow(g[0], g[1], fd.facing, ms * 1.1, GHOST_DIM);
      }
    }

    const pa = this.lineGeom.getAttribute('position') as THREE.BufferAttribute;
    const ca = this.lineGeom.getAttribute('color') as THREE.BufferAttribute;
    if (this.nVerts) {
      pa.clearUpdateRanges();
      ca.clearUpdateRanges();
      pa.addUpdateRange(0, this.nVerts * 3);
      ca.addUpdateRange(0, this.nVerts * 3);
      pa.needsUpdate = true;
      ca.needsUpdate = true;
    }
    this.lineGeom.setDrawRange(0, this.nVerts);
  }
}
