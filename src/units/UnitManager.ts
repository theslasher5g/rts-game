/**
 * Phase 2 – Einheitenverwaltung: Spawnen, Befehle, Formationen, Bewegung entlang Routen, räumliche Abfragen.
 *
 * Koordinaten: Welt-km (x Ost, z Süd). Heading: rad, 0 = Norden (−Z), im Uhrzeigersinn.
 *   Richtungsvektor: dx = sin(h), dz = −cos(h).  Rechts: (cos h, sin h).
 */
import { bus } from '../core/EventBus';
import type { CityMeta, Settings } from '../core/types';
import { getProfile } from '../game/countryData';
import type { MobilityProfile, Route } from '../nav/types';
import { OFFROAD_CLASS } from '../nav/types';
import type { GeoData } from '../world/GeoData';
import type { Formation, MoveOptions, Order, Unit, UnitCategory } from './types';
import { getUnitType, maxSpeedOf } from './unitTypes';

/** Strukturell identisch zu nav/Pathfinder (main.ts übergibt den echten Pathfinder). */
export interface RouteProvider {
  findRoute(fx: number, fz: number, tx: number, tz: number, mob: MobilityProfile): Route | null;
  passable(x: number, z: number, mob: MobilityProfile): boolean;
  nearestPassable(x: number, z: number, mob: MobilityProfile, maxKm?: number): [number, number] | null;
}

// --- Tuning
/** Max. Routenberechnungen pro Frame bzw. Zeitbudget (ms) */
const ROUTES_PER_FRAME = 6;
const ROUTE_BUDGET_MS = 12;
/** Bremsverzögerung vor dem Ziel (km/h²): v = sqrt(2·a·rest) */
const DECEL = 36000;
/** Ankunftstoleranz km */
const ARRIVE_EPS = 0.002;
/** Spatial-Hash */
const CELL_KM = 8;
const BUCKETS = 4096;
/** Flughöhen (reale km über Grund; Darstellung × min(Überhöhung, 3)) */
const ALTITUDE: Record<string, number> = { heli_attack: 0.1, heli_transport: 0.15, jet: 1.2, bomber: 1.6, drone_fixed: 0.8, drone_quad: 0.04 };
/** Steig-/Sinkrate km/h */
const CLIMB_RATE: Partial<Record<UnitCategory, number>> = { helicopter: 25, jet: 60, drone: 20 };
/** Kreisradius (km) für Flächenflugzeuge beim Warten */
const LOITER_RADIUS: Partial<Record<UnitCategory, number>> = { jet: 5, drone: 1.5 };

interface Motion {
  seg: number;
  segT: number;
  routeLen: number;
  /** Ziel-Blickrichtung nach Ankunft (NaN = keine) */
  faceGoal: number;
  /** Flug: Höhe über Grund (km real) */
  alt: number;
  loiter: boolean;
  loiterCx: number;
  loiterCz: number;
  loiterA: number;
  cellX: number;
  cellZ: number;
}

const TWO_PI = Math.PI * 2;
function wrapAngle(a: number): number {
  a = (a + Math.PI) % TWO_PI;
  if (a < 0) a += TWO_PI;
  return a - Math.PI;
}
function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
/** deterministischer Jitter -0.5..0.5 */
function jitter(i: number, salt: number): number {
  let t = Math.imul(i + 0x9e3779b9 + salt * 0x85ebca6b, 0x27d4eb2d) >>> 0;
  t = Math.imul(t ^ (t >>> 15), 0x2c1b3c6d) >>> 0;
  return ((t ^ (t >>> 13)) >>> 0) / 4294967296 - 0.5;
}

/** Formationsslots in lokalen Koordinaten [seitlich (rechts +), vorwärts (+)] in km */
function formationOffsets(n: number, f: Formation, sp: number, widthKm?: number): Float64Array {
  const out = new Float64Array(n * 2);
  if (n <= 0) return out;
  if (f === 'column') {
    for (let i = 0; i < n; i++) {
      out[i * 2] = 0;
      out[i * 2 + 1] = -i * sp * 1.3;
    }
    return out;
  }
  if (f === 'wedge') {
    for (let i = 0; i < n; i++) {
      const k = Math.ceil(i / 2);
      const side = i === 0 ? 0 : i % 2 === 1 ? -1 : 1;
      out[i * 2] = side * k * sp;
      out[i * 2 + 1] = -k * sp * 0.8;
    }
    return out;
  }
  const s = f === 'spread' ? sp * 2.2 : sp;
  let perRow = widthKm && widthKm > 0 ? Math.max(1, Math.floor(widthKm / s) + 1) : Math.min(n, 10);
  perRow = Math.min(perRow, n);
  const rowSp = f === 'spread' ? s * 0.9 : sp * 1.2;
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / perRow);
    const inRow = Math.min(perRow, n - row * perRow);
    const col = i - row * perRow;
    let lat = (col - (inRow - 1) / 2) * s;
    let fwd = -row * rowSp;
    if (f === 'spread') {
      lat += (row % 2) * s * 0.5 + jitter(i, 1) * s * 0.6;
      fwd += jitter(i, 2) * rowSp * 0.6;
    }
    out[i * 2] = lat;
    out[i * 2 + 1] = fwd;
  }
  return out;
}

function defaultFormation(cat: UnitCategory): Formation {
  switch (cat) {
    case 'tank':
    case 'ifv':
      return 'wedge';
    case 'support':
    case 'artillery':
    case 'naval':
      return 'column';
    case 'infantry':
    case 'aa':
      return 'line';
    default:
      return 'spread';
  }
}

/** Für nicht spielbare Staaten: grobe Streitkräfte aus Bevölkerung */
interface ForceStats {
  manpower: number;
  tanks: number;
  ifv: number;
  artillery: number;
  aircraft: number;
  helicopters: number;
  ships: number;
  drones: number;
}

export class UnitManager {
  readonly units: Unit[] = [];

  /** Phase 4: Bremsfaktor durch Flüchtlingsströme auf Straßen (1 = frei, bis 0.3); von main.ts gesetzt */
  roadSpeedFactor: ((x: number, z: number) => number) | null = null;

  private readonly geo: GeoData;
  private readonly routes: RouteProvider;
  private exag: number;
  private nextId = 1;
  private readonly byId = new Map<number, Unit>();
  private readonly motion = new Map<number, Motion>();
  /** Warteschlange für Routenberechnung (Unit-IDs) */
  private readonly routeQueue: number[] = [];
  private routeQueueHead = 0;

  // Spatial Hash (verkettete Listen über Indizes in this.units)
  private readonly head = new Int32Array(BUCKETS);
  private next = new Int32Array(256);
  private hashDirty = true;

  constructor(geo: GeoData, routes: RouteProvider, settings: Settings) {
    this.geo = geo;
    this.routes = routes;
    this.exag = settings.heightExaggeration;
    bus.on('nav:edge', ({ open }) => {
      if (open) return;
      // Kante gesperrt: alle fahrenden Boden-/Marineeinheiten neu routen (lazy über die Queue)
      for (const u of this.units) {
        if (u.route && u.type.mobility.domain !== 'air') {
          u.route = null;
          u.routeKm = 0;
          this.requestRoute(u);
        }
      }
    });
  }

  get(id: number): Unit | undefined {
    return this.byId.get(id);
  }

  // ------------------------------------------------------------------ Spawnen / Entfernen

  spawn(typeId: string, owner: string, x: number, z: number, heading = 0, name?: string): Unit | null {
    const type = getUnitType(typeId);
    if (!type) {
      console.warn(`UnitManager.spawn: unbekannter Typ ${typeId}`);
      return null;
    }
    const mob = type.mobility;
    if (mob.domain === 'air') {
      if (!this.geo.inside(x, z)) return null;
    } else if (!this.routes.passable(x, z, mob)) {
      const p = this.routes.nearestPassable(x, z, mob, 5);
      if (!p) return null;
      x = p[0];
      z = p[1];
    }
    const id = this.nextId++;
    const u: Unit = {
      id,
      type,
      owner,
      x,
      z,
      y: 0,
      heading: wrapAngle(heading),
      speedKmh: 0,
      hp: type.hp,
      ammo: type.ammo,
      fuel: type.fuelKm,
      experience: 0.3,
      morale: 0.8,
      orders: [],
      route: null,
      routeKm: 0,
      groupSpeedCap: Infinity,
      formation: defaultFormation(type.category),
      selected: false,
      name: name ?? `${type.short} ${id}`,
      stance: 'free',
      airborne: false,
      onRoad: false,
      routePending: false,
    };
    const m: Motion = { seg: 0, segT: 0, routeLen: 0, faceGoal: NaN, alt: 0, loiter: false, loiterCx: x, loiterCz: z, loiterA: 0, cellX: 0, cellZ: 0 };
    this.units.push(u);
    this.byId.set(id, u);
    this.motion.set(id, m);
    this.updateY(u, m);
    this.hashDirty = true;
    bus.emit('unit:spawned', { id });
    return u;
  }

  /** Phase 3: während update() angefordertes Entfernen wird bis nach der Schleife verschoben (iterationssicher). */
  private updating = false;
  private readonly pendingRemoval: number[] = [];

  remove(id: number): void {
    const u = this.byId.get(id);
    if (!u) return;
    if (this.updating) {
      if (!this.pendingRemoval.includes(id)) this.pendingRemoval.push(id);
      return;
    }
    const i = this.units.indexOf(u);
    if (i >= 0) this.units.splice(i, 1);
    this.byId.delete(id);
    this.motion.delete(id);
    this.hashDirty = true;
    bus.emit('unit:removed', { id });
  }

  // ------------------------------------------------------------------ Befehle

  issueMove(ids: number[], x: number, z: number, opts: MoveOptions = {}): void {
    const plan = this.planFormation(ids, x, z, opts);
    const kind = opts.kind ?? 'move';
    for (const p of plan) {
      const u = p.unit;
      if (opts.formation) u.formation = opts.formation;
      const last = opts.queue && u.orders.length ? u.orders[u.orders.length - 1] : null;
      const order: Order = { kind, x: p.x, z: p.z, facing: p.facing };
      if (kind === 'patrol') {
        order.originX = last ? last.x : u.x;
        order.originZ = last ? last.z : u.z;
      }
      u.stance = 'free';
      if (opts.queue && u.orders.length) {
        u.orders.push(order);
        if (p.cap < u.groupSpeedCap) u.groupSpeedCap = p.cap;
      } else {
        u.orders.length = 0;
        u.orders.push(order);
        u.route = null;
        u.routeKm = 0;
        u.groupSpeedCap = p.cap;
        const m = this.motion.get(u.id)!;
        m.faceGoal = NaN;
      }
    }
  }

  issueStop(ids: number[]): void {
    for (const id of ids) {
      const u = this.byId.get(id);
      if (!u) continue;
      this.stopUnit(u);
      u.stance = 'free';
    }
  }

  issueHold(ids: number[]): void {
    for (const id of ids) {
      const u = this.byId.get(id);
      if (!u) continue;
      this.stopUnit(u);
      u.stance = 'hold';
    }
  }

  setFormation(ids: number[], f: Formation): void {
    for (const id of ids) {
      const u = this.byId.get(id);
      if (u) u.formation = f;
    }
  }

  previewFormation(ids: number[], x: number, z: number, opts: MoveOptions = {}): Array<[number, number]> {
    return this.planFormation(ids, x, z, opts).map((p) => [p.x, p.z] as [number, number]);
  }

  private stopUnit(u: Unit): void {
    u.orders.length = 0;
    u.route = null;
    u.routeKm = 0;
    u.groupSpeedCap = Infinity;
    if (u.type.mobility.domain !== 'air') u.speedKmh = 0;
    const m = this.motion.get(u.id);
    if (m) {
      m.faceGoal = NaN;
      if (u.airborne) this.startLoiter(u, m);
    }
  }

  /**
   * Formationsplanung: Einheiten nach Domäne getrennt; je Domäne Slots um das Ziel,
   * Zuordnung nach seitlicher (bzw. Längs-)Lage, Slots auf befahrbares Gelände geschnappt.
   */
  private planFormation(ids: number[], x: number, z: number, opts: MoveOptions): Array<{ unit: Unit; x: number; z: number; facing?: number; cap: number }> {
    const result: Array<{ unit: Unit; x: number; z: number; facing?: number; cap: number }> = [];
    const all: Unit[] = [];
    for (const id of ids) {
      const u = this.byId.get(id);
      if (u) all.push(u);
    }
    if (!all.length) return result;
    for (const domain of ['ground', 'naval', 'air'] as const) {
      const group = all.filter((u) => u.type.mobility.domain === domain);
      if (!group.length) continue;
      // Bezugspunkt: aktuelle Position bzw. letztes Ziel in der Warteschlange
      let cx = 0, cz = 0, sp = 0, cap = Infinity, hx = 0, hz = 0;
      const ref: Array<[number, number]> = group.map((u) => {
        const last = opts.queue && u.orders.length ? u.orders[u.orders.length - 1] : null;
        return last ? [last.x, last.z] : [u.x, u.z];
      });
      group.forEach((u, i) => {
        cx += ref[i][0];
        cz += ref[i][1];
        sp = Math.max(sp, u.type.spacingKm);
        cap = Math.min(cap, maxSpeedOf(u.type.mobility));
        hx += Math.sin(u.heading);
        hz -= Math.cos(u.heading);
      });
      cx /= group.length;
      cz /= group.length;
      if (group.length === 1) cap = Infinity;
      let facing = opts.facing;
      if (facing === undefined) {
        const dx = x - cx, dz = z - cz;
        facing = dx * dx + dz * dz > 1e-6 ? Math.atan2(dx, -dz) : Math.atan2(hx, -hz);
      }
      const formation = opts.formation ?? group[0].formation;
      const offs = formationOffsets(group.length, formation, sp, opts.widthKm);
      const rx = Math.cos(facing), rz = Math.sin(facing);
      const fx = Math.sin(facing), fz = -Math.cos(facing);
      // Zuordnung: Slots und Einheiten nach Projektion sortieren
      const useFwd = formation === 'column';
      const slotIdx = Array.from({ length: group.length }, (_, i) => i);
      const unitIdx = slotIdx.slice();
      const slotKey = (i: number) => (useFwd ? -offs[i * 2 + 1] : offs[i * 2]);
      const unitKey = (i: number) => {
        const dx = ref[i][0] - cx, dz = ref[i][1] - cz;
        return useFwd ? -(dx * fx + dz * fz) : dx * rx + dz * rz;
      };
      slotIdx.sort((a, b) => slotKey(a) - slotKey(b));
      unitIdx.sort((a, b) => unitKey(a) - unitKey(b));
      for (let k = 0; k < group.length; k++) {
        const u = group[unitIdx[k]];
        const s = slotIdx[k];
        let px = x + rx * offs[s * 2] + fx * offs[s * 2 + 1];
        let pz = z + rz * offs[s * 2] + fz * offs[s * 2 + 1];
        if (domain !== 'air') {
          const mob = u.type.mobility;
          if (!this.routes.passable(px, pz, mob)) {
            const p = this.routes.nearestPassable(px, pz, mob, 3) ?? (this.routes.passable(x, z, mob) ? [x, z] : this.routes.nearestPassable(x, z, mob, 10));
            if (p) {
              px = p[0];
              pz = p[1];
            }
          }
        } else {
          px = clamp(px, 0, this.geo.widthKm);
          pz = clamp(pz, 0, this.geo.heightKm);
        }
        result.push({ unit: u, x: px, z: pz, facing, cap });
      }
    }
    return result;
  }

  // ------------------------------------------------------------------ Räumliche Abfragen

  /** Einheiten im Radius (out wird geleert und befüllt) */
  queryRadius(x: number, z: number, r: number, out: Unit[]): Unit[] {
    out.length = 0;
    if (this.hashDirty) this.rebuildHash();
    const c0x = Math.floor((x - r) / CELL_KM), c1x = Math.floor((x + r) / CELL_KM);
    const c0z = Math.floor((z - r) / CELL_KM), c1z = Math.floor((z + r) / CELL_KM);
    const r2 = r * r;
    if ((c1x - c0x + 1) * (c1z - c0z + 1) > this.units.length) {
      for (const u of this.units) {
        const dx = u.x - x, dz = u.z - z;
        if (dx * dx + dz * dz <= r2) out.push(u);
      }
      return out;
    }
    for (let cz = c0z; cz <= c1z; cz++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        for (let i = this.head[this.bucket(cx, cz)]; i >= 0; i = this.next[i]) {
          const u = this.units[i];
          const m = this.motion.get(u.id)!;
          if (m.cellX !== cx || m.cellZ !== cz) continue;
          const dx = u.x - x, dz = u.z - z;
          if (dx * dx + dz * dz <= r2) out.push(u);
        }
      }
    }
    return out;
  }

  /** Einheiten im achsparallelen Rechteck (out wird geleert und befüllt) */
  queryRect(x0: number, z0: number, x1: number, z1: number, out: Unit[]): Unit[] {
    out.length = 0;
    if (x0 > x1) [x0, x1] = [x1, x0];
    if (z0 > z1) [z0, z1] = [z1, z0];
    if (this.hashDirty) this.rebuildHash();
    const c0x = Math.floor(x0 / CELL_KM), c1x = Math.floor(x1 / CELL_KM);
    const c0z = Math.floor(z0 / CELL_KM), c1z = Math.floor(z1 / CELL_KM);
    if ((c1x - c0x + 1) * (c1z - c0z + 1) > this.units.length) {
      for (const u of this.units) if (u.x >= x0 && u.x <= x1 && u.z >= z0 && u.z <= z1) out.push(u);
      return out;
    }
    for (let cz = c0z; cz <= c1z; cz++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        for (let i = this.head[this.bucket(cx, cz)]; i >= 0; i = this.next[i]) {
          const u = this.units[i];
          const m = this.motion.get(u.id)!;
          if (m.cellX !== cx || m.cellZ !== cz) continue;
          if (u.x >= x0 && u.x <= x1 && u.z >= z0 && u.z <= z1) out.push(u);
        }
      }
    }
    return out;
  }

  private bucket(cx: number, cz: number): number {
    return ((Math.imul(cx, 73856093) ^ Math.imul(cz, 19349663)) >>> 0) & (BUCKETS - 1);
  }

  private rebuildHash(): void {
    const n = this.units.length;
    if (this.next.length < n) this.next = new Int32Array(Math.max(n, this.next.length * 2));
    this.head.fill(-1);
    for (let i = 0; i < n; i++) {
      const u = this.units[i];
      const m = this.motion.get(u.id)!;
      m.cellX = Math.floor(u.x / CELL_KM);
      m.cellZ = Math.floor(u.z / CELL_KM);
      const b = this.bucket(m.cellX, m.cellZ);
      this.next[i] = this.head[b];
      this.head[b] = i;
    }
    this.hashDirty = false;
  }

  // ------------------------------------------------------------------ Simulation

  applySettings(s: Settings): void {
    this.exag = s.heightExaggeration;
    for (const u of this.units) this.updateY(u, this.motion.get(u.id)!);
  }

  update(dtHours: number): void {
    this.processRouteQueue();
    const dt = dtHours > 0 ? dtHours : 0;
    this.updating = true;
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      const m = this.motion.get(u.id)!;
      if (dt > 0) this.step(u, m, dt);
      this.updateY(u, m);
    }
    this.updating = false;
    if (this.pendingRemoval.length) {
      const ids = this.pendingRemoval.splice(0);
      for (const id of ids) this.remove(id);
    }
    this.rebuildHash();
  }

  /** Anzahl wartender Routenanfragen (Debug/UI) */
  get pendingRoutes(): number {
    return this.routeQueue.length - this.routeQueueHead;
  }

  private requestRoute(u: Unit): void {
    if (u.routePending) return;
    u.routePending = true;
    this.routeQueue.push(u.id);
  }

  private processRouteQueue(): void {
    const t0 = performance.now();
    let done = 0;
    while (this.routeQueueHead < this.routeQueue.length && done < ROUTES_PER_FRAME) {
      const id = this.routeQueue[this.routeQueueHead++];
      const u = this.byId.get(id);
      if (!u) continue;
      u.routePending = false;
      if (u.route || !u.orders.length) continue;
      this.computeRoute(u);
      done++;
      if (performance.now() - t0 > ROUTE_BUDGET_MS) break;
    }
    if (this.routeQueueHead >= this.routeQueue.length) {
      this.routeQueue.length = 0;
      this.routeQueueHead = 0;
    } else if (this.routeQueueHead > 512) {
      this.routeQueue.splice(0, this.routeQueueHead);
      this.routeQueueHead = 0;
    }
  }

  private computeRoute(u: Unit): void {
    const o = u.orders[0];
    const mob = u.type.mobility;
    let r: Route | null = null;
    if (mob.domain === 'air') r = straightRoute(u.x, u.z, o.x, o.z, mob.offroadSpeed);
    else {
      r = this.routes.findRoute(u.x, u.z, o.x, o.z, mob);
      if (!r) {
        const p = this.routes.nearestPassable(o.x, o.z, mob, 10);
        if (p && (Math.abs(p[0] - o.x) > 1e-4 || Math.abs(p[1] - o.z) > 1e-4)) r = this.routes.findRoute(u.x, u.z, p[0], p[1], mob);
      }
      if (!r && this.lineClear(u.x, u.z, o.x, o.z, mob)) r = straightRoute(u.x, u.z, o.x, o.z, mob.offroadAllowed ? mob.offroadSpeed : 5);
    }
    if (!r || r.points.length < 4) {
      if (!r) console.debug(`UnitManager: keine Route für ${u.name} nach (${o.x.toFixed(1)}, ${o.z.toFixed(1)})`);
      // unerreichbar (oder schon da): Befehl verwerfen bzw. als angekommen behandeln
      this.arrive(u, this.motion.get(u.id)!, r !== null);
      return;
    }
    const m = this.motion.get(u.id)!;
    u.route = r;
    u.routeKm = 0;
    m.seg = 0;
    m.segT = 0;
    let len = 0;
    const p = r.points;
    for (let i = 2; i < p.length; i += 2) len += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
    m.routeLen = len;
    m.loiter = false;
  }

  /** Gerade Linie in 2-km-Schritten durchgehend passierbar? */
  private lineClear(x0: number, z0: number, x1: number, z1: number, mob: MobilityProfile): boolean {
    const d = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(1, Math.ceil(d / 2));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      if (!this.routes.passable(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, mob)) return false;
    }
    return true;
  }

  private step(u: Unit, m: Motion, dt: number): void {
    const mob = u.type.mobility;
    const cat = u.type.category;
    const isAir = mob.domain === 'air';
    // Nicht-Bewegungsbefehle sofort abarbeiten
    while (u.orders.length && (u.orders[0].kind === 'stop' || u.orders[0].kind === 'hold' || u.orders[0].kind === 'defend')) {
      const o = u.orders.shift()!;
      if (o.kind !== 'stop') u.stance = 'hold';
    }

    // Flug: Höhe
    if (isAir) {
      const target = u.airborne ? ALTITUDE[u.type.model] ?? 0.3 : 0;
      const rate = (CLIMB_RATE[cat] ?? 20) * dt;
      m.alt = m.alt < target ? Math.min(target, m.alt + rate) : Math.max(target, m.alt - rate);
    }

    // Phase 3 (CombatSystem): 'fireAt' = Feuermission am Standort; attackMove/attack halten an, solange u.engaged
    // (Flächenflugzeuge und Drohnen bleiben in Bewegung, Hubschrauber schweben).
    if (u.orders.length) {
      const k0 = u.orders[0].kind;
      const mustHold = (!isAir || cat === 'helicopter') && (k0 === 'fireAt' || (u.engaged === true && (k0 === 'attackMove' || k0 === 'attack')));
      if (mustHold) {
        u.speedKmh = Math.max(0, u.speedKmh - DECEL * dt);
        return;
      }
    }

    // Phase 3 (InfantryAI): festgenagelte Infanterie (Suppression, Granatdeckung, Überwachungsphase) steht still;
    // Befehle und Route bleiben erhalten.
    if (u.pinned === true) {
      u.speedKmh = Math.max(0, u.speedKmh - DECEL * dt);
      return;
    }

    if (!u.orders.length) {
      this.idle(u, m, dt);
      return;
    }
    if (isAir && !u.airborne) u.airborne = true;
    if (!u.route) {
      if (isAir) this.computeRoute(u);
      else this.requestRoute(u);
      if (!u.route) {
        u.speedKmh = Math.max(0, u.speedKmh - DECEL * dt);
        return;
      }
    }
    const r = u.route!;
    const pts = r.points;
    const nSeg = (pts.length >> 1) - 1;
    let seg = Math.min(m.seg, nSeg - 1);

    // Sollgeschwindigkeit
    const rem = Math.max(0, m.routeLen - u.routeKm);
    let vt = r.segSpeed[seg] > 0 ? r.segSpeed[seg] : mob.offroadSpeed;
    if (u.groupSpeedCap < vt) vt = u.groupSpeedCap;
    if (u.onRoad && this.roadSpeedFactor) vt *= this.roadSpeedFactor(u.x, u.z);
    if (u.fuel <= 0) vt = 0;
    if (isAir && u.type.category !== 'helicopter') {
      // Flugzeuge: beim Steigen langsamer, keine Bremsung vor dem Ziel (gehen in Warteschleife)
      const tgt = ALTITUDE[u.type.model] ?? 0.3;
      vt *= 0.35 + 0.65 * clamp(m.alt / tgt, 0, 1);
    } else {
      const vBrake = Math.sqrt(2 * DECEL * rem) + 1;
      if (vBrake < vt) vt = vBrake;
    }

    // Heading
    const ax = pts[seg * 2], az = pts[seg * 2 + 1];
    const bx = pts[seg * 2 + 2], bz = pts[seg * 2 + 3];
    const segLen = Math.hypot(bx - ax, bz - az);
    if (segLen > 1e-6) {
      const desired = Math.atan2(bx - ax, -(bz - az));
      const err = wrapAngle(desired - u.heading);
      const turn = this.turnRate(u) * dt;
      u.heading = wrapAngle(u.heading + clamp(err, -turn, turn));
      const aerr = Math.abs(wrapAngle(desired - u.heading));
      if (!isAir && mob.domain === 'ground') {
        if (cat === 'tank' || cat === 'ifv' || u.type.model === 'spg' || u.type.model === 'spaa') {
          if (aerr > 0.7) vt *= 0.15; // auf der Stelle drehen
        } else if (cat !== 'infantry' && cat !== 'artillery') {
          if (aerr > 1.0) vt *= 0.4;
        } else if (aerr > 1.4) vt *= 0.5;
      }
    }

    // Beschleunigen
    const accel = isAir ? 4000 : mob.domain === 'naval' ? 400 : 12000;
    u.speedKmh = u.speedKmh < vt ? Math.min(vt, u.speedKmh + accel * dt) : Math.max(vt, u.speedKmh - DECEL * dt);
    let adv = u.speedKmh * dt;
    if (adv > rem) adv = rem;

    // Entlang der Polylinie
    let t = m.segT + adv;
    let sl = segLen;
    while (t >= sl && seg < nSeg - 1) {
      t -= sl;
      seg++;
      sl = Math.hypot(pts[seg * 2 + 2] - pts[seg * 2], pts[seg * 2 + 3] - pts[seg * 2 + 1]);
    }
    if (t > sl) t = sl;
    m.seg = seg;
    m.segT = t;
    const f = sl > 1e-9 ? t / sl : 1;
    u.x = pts[seg * 2] + (pts[seg * 2 + 2] - pts[seg * 2]) * f;
    u.z = pts[seg * 2 + 1] + (pts[seg * 2 + 3] - pts[seg * 2 + 1]) * f;
    u.routeKm += adv;
    if (Number.isFinite(u.fuel)) u.fuel = Math.max(0, u.fuel - adv);
    u.onRoad = r.segClass[seg] !== OFFROAD_CLASS && mob.domain === 'ground';
    if (m.routeLen - u.routeKm <= ARRIVE_EPS) this.arrive(u, m, true);
  }

  /** Drehrate rad/Spielstunde */
  private turnRate(u: Unit): number {
    const cat = u.type.category;
    const v = Math.max(u.speedKmh, 1);
    switch (cat) {
      case 'infantry':
        return 20000;
      case 'tank':
      case 'ifv':
        return 4000; // ~65°/s, dreht auf der Stelle
      case 'helicopter':
      case 'drone':
        return 5000;
      case 'jet':
        return v / 3; // Kurvenradius ~3 km
      case 'naval':
        return Math.max(v, 8) / 0.6;
      default:
        // Radfahrzeuge: Kurvenradius ~15 m, mit Mindestrate beim Rangieren
        return Math.max(1500, v / 0.015);
    }
  }

  private arrive(u: Unit, m: Motion, reached: boolean): void {
    const o = u.orders.shift();
    const r = u.route;
    if (r && reached) {
      u.x = r.points[r.points.length - 2];
      u.z = r.points[r.points.length - 1];
    }
    u.route = null;
    u.routeKm = 0;
    m.seg = 0;
    m.segT = 0;
    u.onRoad = false;
    if (u.type.mobility.domain !== 'air' || u.type.category === 'helicopter') {
      if (!u.orders.length) u.speedKmh = 0;
    }
    if (o && reached) {
      if (o.facing !== undefined) m.faceGoal = o.facing;
      if (o.kind === 'patrol' && o.originX !== undefined && o.originZ !== undefined) {
        u.orders.push({ kind: 'patrol', x: o.originX, z: o.originZ, facing: undefined, originX: o.x, originZ: o.z });
      }
    }
    if (!u.orders.length) {
      u.groupSpeedCap = Infinity;
      if (u.airborne) this.startLoiter(u, m);
    }
  }

  private startLoiter(u: Unit, m: Motion): void {
    const R = LOITER_RADIUS[u.type.category];
    m.loiter = true;
    if (R && u.type.model !== 'drone_quad') {
      // Kreismittelpunkt rechts voraus, sodass die Bahn tangential anschließt
      m.loiterCx = u.x + Math.cos(u.heading) * R;
      m.loiterCz = u.z + Math.sin(u.heading) * R;
      m.loiterA = u.heading - Math.PI / 2;
    } else {
      m.loiterCx = u.x;
      m.loiterCz = u.z;
    }
  }

  private idle(u: Unit, m: Motion, dt: number): void {
    const mob = u.type.mobility;
    if (mob.domain === 'air' && u.airborne) {
      const R = LOITER_RADIUS[u.type.category];
      if (R && u.type.model !== 'drone_quad') {
        if (!m.loiter) this.startLoiter(u, m);
        const v = mob.offroadSpeed * 0.6;
        u.speedKmh = v;
        m.loiterA += (v / R) * dt;
        if (m.loiterA > Math.PI * 4) m.loiterA -= TWO_PI;
        u.x = m.loiterCx + R * Math.sin(m.loiterA);
        u.z = m.loiterCz - R * Math.cos(m.loiterA);
        u.heading = wrapAngle(m.loiterA + Math.PI / 2);
        return;
      }
      // Hubschrauber / Quadrokopter: schweben, langsam ausrichten
      u.speedKmh = Math.max(0, u.speedKmh - 2000 * dt);
    } else {
      u.speedKmh = 0;
    }
    if (!Number.isNaN(m.faceGoal)) {
      const err = wrapAngle(m.faceGoal - u.heading);
      const turn = this.turnRate(u) * dt;
      if (Math.abs(err) <= turn) {
        u.heading = wrapAngle(m.faceGoal);
        m.faceGoal = NaN;
      } else u.heading = wrapAngle(u.heading + Math.sign(err) * turn);
    }
  }

  private updateY(u: Unit, m: Motion): void {
    const d = u.type.mobility.domain;
    if (d === 'naval') {
      u.y = 0;
      return;
    }
    const g = Math.max(this.geo.heightAt(u.x, u.z), 0) * this.exag;
    u.y = d === 'air' ? g + m.alt * Math.min(this.exag, 3) : g;
  }

  // ------------------------------------------------------------------ Startstreitkräfte

  spawnStartingForces(a3: string, isPlayer: boolean): void {
    const country = this.geo.countriesByA3.get(a3);
    if (!country) {
      console.warn(`spawnStartingForces: ${a3} unbekannt`);
      return;
    }
    const prof = getProfile(a3);
    const popM = country.population / 1e6;
    const st: ForceStats = prof ?? {
      manpower: Math.max(5, popM * 2.5),
      tanks: popM * 6,
      ifv: popM * 15,
      artillery: popM * 5,
      aircraft: popM * 3,
      helicopters: popM * 3,
      ships: popM * 0.8,
      drones: popM * 10,
    };
    const cities = this.geo.meta.cities
      .filter((c) => c.country === a3)
      .sort((a, b) => (b.capital ? 1 : 0) - (a.capital ? 1 : 0) || b.pop - a.pop);
    const fallbackCity: CityMeta = { name: country.name, country: a3, pop: country.population, capital: true, pos: country.label };
    if (!cities.length) cities.push(fallbackCity);
    let bases = cities.slice(0, isPlayer ? 4 : 2);
    // Kleines Szenario (Phase 5): Aufstellung an der Frontstellung (spawn) und am Hauptquartier statt in Großstädten
    const scen = this.geo.meta.scenario?.nations.find((nn) => nn.a3 === a3);
    const theatre = !!scen;
    if (scen) {
      bases = [
        { name: 'Frontstellung', country: a3, pop: 0, capital: false, pos: scen.spawn },
        { name: 'Hauptquartier', country: a3, pop: 0, capital: true, pos: scen.hq },
      ];
    }

    // --- Zusammensetzung
    const n = (v: number, div: number, min: number, max: number) => clamp(Math.round(v / div), min, max);
    const P = isPlayer || theatre;
    const list: string[] = [];
    const add = (id: string, count: number) => {
      for (let i = 0; i < count; i++) list.push(id);
    };
    // Theater-Szenario: alle Nationen stellen eine vollwertige, nach Profil skalierte Streitmacht (gleiche Augenhöhe)
    const tanks = theatre ? n(st.tanks, 6, 2, 12) : P ? n(st.tanks, 100, 2, 10) : n(st.tanks, 300, 1, 4);
    const ifvs = theatre ? n(st.ifv, 9, 2, 10) : P ? n(st.ifv, 200, 2, 10) : n(st.ifv, 600, 1, 4);
    const inf = theatre ? n(st.manpower, 2, 4, 14) : P ? n(st.manpower, 12, 4, 16) : n(st.manpower, 40, 2, 6);
    const art = theatre ? n(st.artillery, 5, 2, 6) : P ? n(st.artillery, 80, 1, 6) : n(st.artillery, 300, 1, 2);
    const heavy = Math.ceil(tanks * 0.5);
    add('mbt_heavy', heavy);
    add('mbt_medium', tanks - heavy);
    if (P && st.tanks >= 800) add('light_tank', 2);
    const tracked = Math.ceil(ifvs * 0.7);
    add('ifv', tracked);
    add('apc_wheeled', ifvs - tracked);
    add('recon_wheeled', P ? n(st.tanks + st.ifv, 600, 1, 3) : 1);
    add('inf_squad', inf);
    add('mg_team', P ? Math.max(1, Math.round(inf / 4)) : inf >= 4 ? 1 : 0);
    add('at_team', P ? Math.max(1, Math.round(inf / 3)) : 1);
    if (P) {
      add('sniper_team', 1);
      add('medic_team', 1);
      add('engineer_squad', inf >= 10 ? 2 : 1);
    }
    const sp = Math.ceil(art * 0.5), ml = Math.floor(art * 0.3);
    add('sp_artillery', sp);
    add('mlrs', ml);
    add('mortar_team', art - sp - ml + (P ? 1 : 0));
    add('spaa', P ? 2 : 1);
    add('sam', P ? (st.aircraft >= 150 ? 2 : 1) : st.aircraft >= 200 ? 1 : 0);
    add('supply_truck', P ? 3 : 1);
    const helis = P ? n(st.helicopters, 100, 1, 3) : st.helicopters >= 150 ? 1 : 0;
    const atk = Math.ceil(helis * 0.67);
    add('attack_heli', atk);
    add('transport_heli', helis - atk);
    const jets = P ? n(st.aircraft, 80, 1, 4) : st.aircraft >= 100 ? 1 : 0;
    add('fighter', jets);
    if (P && st.aircraft >= 200) add('bomber', 1);
    add('recon_drone', P ? n(st.drones, 1000, 1, 2) : st.drones >= 500 ? 1 : 0);
    add('fpv_swarm', P ? n(st.drones, 2000, 0, 3) : st.drones >= 3000 ? 1 : 0);
    const ships = st.ships > 0 ? (P ? n(st.ships, 40, 1, 4) : n(st.ships, 100, 0, 2)) : 0;
    const shipList: string[] = [];
    if (ships > 0) {
      let left = ships;
      if (st.ships >= 60 && left > 1) {
        shipList.push('destroyer');
        left--;
      }
      if (st.ships >= 50 && left > 1) {
        shipList.push('submarine');
        left--;
      }
      for (let i = 0; i < left; i++) shipList.push('frigate');
    }
    // Obergrenze: zuerst Infanterie kürzen
    const cap = (P ? 80 : 25) - shipList.length;
    while (list.length > cap) {
      const k = list.lastIndexOf('inf_squad');
      list.splice(k >= 0 ? k : list.length - 1, 1);
    }

    // --- Namen
    const h = hashStr(a3);
    const bn = 100 + (h % 280);
    const counters = new Map<string, number>();
    const nameOf = (typeId: string, baseIdx: number): string => {
      const k = (counters.get(typeId) ?? 0) + 1;
      counters.set(typeId, k);
      const b = bn + baseIdx * 10;
      switch (typeId) {
        case 'mbt_heavy':
        case 'mbt_medium':
        case 'light_tank':
          return `${k}. Kp / PzBtl ${b}`;
        case 'ifv':
        case 'apc_wheeled':
          return `${k}. Kp / PzGrenBtl ${b + 2}`;
        case 'recon_wheeled':
          return `${k}. Kp / AufklBtl ${b + 4}`;
        case 'inf_squad':
          return `${Math.floor((k - 1) / 3) + 1}. Zug / ${((k - 1) % 3) + 1}. Grp / JgBtl ${b + 1}`;
        case 'mg_team':
          return `MG-Trupp ${k} / JgBtl ${b + 1}`;
        case 'at_team':
          return `PzAbwTrp ${k} / JgBtl ${b + 1}`;
        case 'sniper_team':
          return `ScharfSTrp ${k} / JgBtl ${b + 1}`;
        case 'medic_team':
          return `SanTrp ${k} / SanRgt ${(h % 3) + 1}`;
        case 'engineer_squad':
          return `${k}. Kp / PiBtl ${b + 3}`;
        case 'mortar_team':
          return `MrsZug ${k} / JgBtl ${b + 1}`;
        case 'sp_artillery':
          return `${k}. Bttr / ArtBtl ${b + 5}`;
        case 'mlrs':
          return `${k}. Bttr / RakArtBtl ${b + 7}`;
        case 'spaa':
          return `${k}. Bttr / FlaBtl ${b + 8}`;
        case 'sam':
          return `${k}. Staffel / FlaRakGrp ${(h % 5) + 1}`;
        case 'supply_truck':
          return `${k}. Kp / VersBtl ${b + 6}`;
        case 'attack_heli':
          return `${k}. Staffel / KpfHubschrRgt ${(h % 4) + 26}`;
        case 'transport_heli':
          return `${k}. Staffel / TrspHubschrRgt ${(h % 4) + 10}`;
        case 'fighter':
          return `${k}. Staffel / TaktLwG ${(h % 7) + 71}`;
        case 'bomber':
          return `${k}. Staffel / JaBoG ${(h % 5) + 31}`;
        case 'recon_drone':
          return `AufklDrohnenStff ${k}`;
        case 'fpv_swarm':
          return `FPV-Schwarm ${k} / DrohnenKp ${b + 9}`;
        case 'destroyer':
          return `Zerstörer D${180 + k + (h % 10)}`;
        case 'frigate':
          return `Fregatte F${210 + k + (h % 30)}`;
        case 'submarine':
          return `U-Boot S${180 + k + (h % 10)}`;
        default:
          return `${k}. ${typeId}`;
      }
    };

    // --- Verteilung auf Standorte: Hauptstadt doppelt gewichtet
    const pattern: number[] = [0, 0];
    for (let b = 1; b < bases.length; b++) pattern.push(b);
    const perBase: string[][] = bases.map(() => []);
    const airfield: string[] = [];
    let gi = 0;
    // Nach Typ gruppieren, damit Verbände zusammenstehen
    const byType = new Map<string, number>();
    for (const t of list) byType.set(t, (byType.get(t) ?? 0) + 1);
    for (const [t, cnt] of byType) {
      const cat = getUnitType(t)!.category;
      if (cat === 'jet') {
        for (let i = 0; i < cnt; i++) airfield.push(t);
        continue;
      }
      if (cat === 'helicopter' || (cat === 'aa' && t === 'sam') || (cat === 'support' && bases.length === 1)) {
        for (let i = 0; i < cnt; i++) perBase[0].push(t);
        continue;
      }
      // Blöcke von bis zu 3 gleichen Einheiten je Standort
      for (let i = 0; i < cnt; i += 3) {
        const b = pattern[gi++ % pattern.length];
        for (let j = i; j < Math.min(cnt, i + 3); j++) perBase[b].push(t);
      }
    }

    const cid = country.id;
    const [lx, lz] = country.label;
    bases.forEach((city, bi) => {
      const types = perBase[bi];
      if (!types.length) return;
      // Blöcke nach Typ um die Stadt herum anordnen
      const blocks: string[][] = [];
      for (const t of types) {
        const lastB = blocks[blocks.length - 1];
        if (lastB && lastB[0] === t) lastB.push(t);
        else blocks.push([t]);
      }
      const ringR = 4 + Math.sqrt(Math.max(0.05, city.pop / 1e6)) * 2.5;
      const outward = Math.atan2(city.pos[0] - lx, -(city.pos[1] - lz));
      blocks.forEach((blk, k) => {
        const type = getUnitType(blk[0])!;
        const mob = type.mobility;
        const ang0 = outward + (k / blocks.length) * TWO_PI + (hashStr(city.name) % 100) / 100;
        let placed = false;
        for (let attempt = 0; attempt < 10 && !placed; attempt++) {
          const ang = ang0 + attempt * 0.65;
          const rr = ringR * (1 + (attempt >> 2) * 0.5);
          const bx = city.pos[0] + Math.sin(ang) * rr;
          const bz = city.pos[1] - Math.cos(ang) * rr;
          const facing = Math.atan2(bx - city.pos[0], -(bz - city.pos[1]));
          const offs = formationOffsets(blk.length, type.category === 'infantry' ? 'line' : 'wedge', type.spacingKm * 1.5);
          const pos: Array<[number, number]> = [];
          const rx = Math.cos(facing), rz = Math.sin(facing), fx = Math.sin(facing), fz = -Math.cos(facing);
          for (let i = 0; i < blk.length; i++) {
            const p = this.landSpot(bx + rx * offs[i * 2] + fx * offs[i * 2 + 1], bz + rz * offs[i * 2] + fz * offs[i * 2 + 1], mob, cid);
            if (!p) break;
            pos.push(p);
          }
          if (pos.length < blk.length) continue;
          blk.forEach((t, i) => this.spawn(t, a3, pos[i][0], pos[i][1], facing, nameOf(t, bi)));
          placed = true;
        }
      });
    });

    // --- Flugplatz nahe der Hauptstadt
    if (airfield.length) {
      const cap = bases[0];
      const dx = lx - cap.pos[0], dz = lz - cap.pos[1];
      const d = Math.hypot(dx, dz) || 1;
      const ground = getUnitType('supply_truck')!.mobility;
      let spot: [number, number] | null = null;
      for (let attempt = 0; attempt < 12 && !spot; attempt++) {
        const ang = Math.atan2(dx / d, -dz / d) + attempt * 0.55;
        const rr = 18 + (attempt >> 2) * 8;
        spot = this.landSpot(cap.pos[0] + Math.sin(ang) * rr, cap.pos[1] - Math.cos(ang) * rr, ground, cid);
      }
      if (!spot) spot = [cap.pos[0], cap.pos[1]];
      const heading = Math.PI / 2; // Startbahn Ost-West
      airfield.forEach((t, i) => this.spawn(t, a3, spot![0] + (i % 4) * 0.12 - 0.18, spot![1] + Math.floor(i / 4) * 0.15, heading, nameOf(t, 0)));
    }

    // --- Schiffe im Meer vor der größten Küstenstadt
    if (shipList.length) {
      const naval = getUnitType('frigate')!.mobility;
      const byPop = cities.slice().sort((a, b) => b.pop - a.pop);
      let port: [number, number] | null = null;
      for (const c of byPop) {
        port = this.findSea(c.pos[0], c.pos[1], naval);
        if (port) break;
      }
      if (port) {
        const [px, pz] = port;
        // Ausrichtung: von der Küste weg
        const c0 = byPop[0];
        const facing = Math.atan2(px - c0.pos[0], -(pz - c0.pos[1]));
        shipList.forEach((t, i) => {
          const off = (i - (shipList.length - 1) / 2) * 1.2;
          const x = px + Math.cos(facing) * off, z = pz + Math.sin(facing) * off;
          const p = this.routes.passable(x, z, naval) ? [x, z] : this.routes.nearestPassable(x, z, naval, 8);
          if (p) this.spawn(t, a3, p[0], p[1], facing, nameOf(t, 0));
        });
      }
    }
  }

  /** Befahrbarer Punkt nahe (x,z) innerhalb des Landes (Länder-ID) */
  private landSpot(x: number, z: number, mob: MobilityProfile, cid: number): [number, number] | null {
    let p: [number, number] | null = this.routes.passable(x, z, mob) ? [x, z] : this.routes.nearestPassable(x, z, mob, 5);
    if (p && this.geo.countryAt(p[0], p[1]) !== cid) p = null;
    return p;
  }

  /** Nächster befahrbarer Seepunkt (offenes Meer) im Umkreis von 40 km, etwas vor der Küste */
  private findSea(cx: number, cz: number, naval: MobilityProfile): [number, number] | null {
    for (let r = 4; r <= 40; r += 4) {
      for (let a = 0; a < 16; a++) {
        const ang = (a / 16) * TWO_PI;
        const x = cx + Math.sin(ang) * r, z = cz - Math.cos(ang) * r;
        if (this.geo.countryAt(x, z) !== 0 || this.geo.heightAt(x, z) >= 0) continue;
        if (!this.routes.passable(x, z, naval)) continue;
        // 3 km weiter hinaus, falls dort noch Wasser
        const x2 = cx + Math.sin(ang) * (r + 3), z2 = cz - Math.cos(ang) * (r + 3);
        if (this.routes.passable(x2, z2, naval)) return [x2, z2];
        return [x, z];
      }
    }
    return null;
  }
}

/** Gerade Route (Luft / Fallback) */
function straightRoute(x0: number, z0: number, x1: number, z1: number, speed: number): Route {
  const len = Math.hypot(x1 - x0, z1 - z0);
  return {
    points: new Float32Array([x0, z0, x1, z1]),
    segSpeed: new Float32Array([speed]),
    segClass: new Uint8Array([OFFROAD_CLASS]),
    lengthKm: len,
    etaHours: speed > 0 ? len / speed : Infinity,
  };
}
