import type { GeoData } from '../world/GeoData';
import type { NavGraph } from './NavGraph';
import { OFFROAD_CLASS, ROAD_CLASSES, type MobilityProfile, type Route } from './types';

/**
 * Wegfindung für Boden-, See- und Lufteinheiten.
 *
 * - air:    gerade Linie.
 * - naval:  Raster-A* nur auf Meereszellen (countryId 0). Hierarchisch: grobes 8-km-Raster
 *           (Block passierbar, wenn er irgendeine Meereszelle enthält – Obermenge, daher exakter
 *           Unerreichbarkeitstest) liefert einen Korridor, darin feines 2-km-A* + String-Pulling.
 * - ground: hybride Route. Start und Ziel werden per Gelände-Dijkstra (begrenzter Radius) an das
 *           Straßennetz angebunden (Knoten oder beliebige Punkte auf Kanten), A* auf dem Graphen
 *           mit Zeitkosten (Länge / Klassengeschwindigkeit). Für geländegängige Einheiten auf kurzen
 *           Distanzen zusätzlich reines Gelände-A*; die schnellere Variante gewinnt.
 *           Gelände: Land ohne See/Fluss; Fluss- und Seezellen sind nur über Brücken/Straßen querbar.
 *
 * Alle Suchstrukturen (Heaps, Kosten-/Stempel-Arrays) werden wiederverwendet.
 */

const SQRT2 = Math.SQRT2;
const DI = [1, -1, 0, 0, 1, 1, -1, -1];
const DJ = [0, 0, 1, -1, 1, -1, 1, -1];
/** Steigung (km/km) * SLOPE_K * slopePenalty = relative Verlangsamung */
const SLOPE_K = 12;
const CONNECT_KM = 40;
const CONNECT_KM_ROADBOUND = 6;
const OFFROAD_DIRECT_KM = 120;
const OFFROAD_FALLBACK_KM = 400;
const CONNECT_MAX_EDGES = 14;
const COARSE = 4; // Zellen je Grobblock (8 km)
/**
 * Meerengen, die im 2-km-Raster (Natural Earth 1:50m) zugewachsen sind – nur für Schiffe
 * eingebrannt (lon,lat-Polylinien): Bosporus, Dardanellen.
 */
const SEA_CHANNELS: number[][] = [
  [29.14, 41.3, 29.07, 41.15, 29.02, 41.03, 28.98, 40.94],
  [26.1, 39.95, 26.38, 40.15, 26.65, 40.38, 26.85, 40.52],
];

// ------------------------------------------------------------------ Hilfsstrukturen

class MinHeap {
  keys = new Float64Array(1024);
  vals = new Int32Array(1024);
  size = 0;
  clear(): void { this.size = 0; }
  push(key: number, val: number): void {
    if (this.size === this.keys.length) {
      const k = new Float64Array(this.size * 2); k.set(this.keys); this.keys = k;
      const v = new Int32Array(this.size * 2); v.set(this.vals); this.vals = v;
    }
    let i = this.size++;
    const keys = this.keys, vals = this.vals;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      keys[i] = keys[p]; vals[i] = vals[p]; i = p;
    }
    keys[i] = key; vals[i] = val;
  }
  topKey(): number { return this.keys[0]; }
  pop(): number {
    const keys = this.keys, vals = this.vals;
    const top = vals[0];
    const n = --this.size;
    if (n > 0) {
      const key = keys[n], val = vals[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= key) break;
        keys[i] = keys[c]; vals[i] = vals[c]; i = c;
      }
      keys[i] = key; vals[i] = val;
    }
    return top;
  }
}

/** Rasterfenster mit generationsgestempelten Kosten (offen = gen, geschlossen = gen+1). */
class GridSpace {
  readonly g: Float32Array;
  readonly st: Uint16Array;
  readonly dir: Uint8Array;
  gen = 0;
  i0 = 0; j0 = 0; w = 0; h = 0;
  constructor(readonly cap: number) {
    this.g = new Float32Array(cap);
    this.st = new Uint16Array(cap);
    this.dir = new Uint8Array(cap);
  }
  /** Fenster setzen (wird auf Kapazität beschnitten, Zentrum bleibt) */
  begin(i0: number, j0: number, w: number, h: number): void {
    this.gen += 2;
    if (this.gen >= 65534) { this.st.fill(0); this.gen = 2; }
    this.i0 = i0; this.j0 = j0; this.w = w; this.h = h;
  }
}

interface Sample {
  e: number;
  /** km entlang der Kante (ab Knoten a) */
  s: number;
  x: number;
  z: number;
  /** beste Anbindungszeit (h) */
  cost: number;
  /** globale Rasterzelle, aus der der Punkt erreicht wurde (-1 = direkt von Start/Ziel) */
  from: number;
}

interface Connector {
  space: GridSpace;
  /** Start-/Zielpunkt */
  x: number;
  z: number;
  reached: Sample[];
  speed: number;
}

/** Zwischenpuffer der Routenmontage */
class RouteBuilder {
  pts: number[] = [];
  spd: number[] = [];
  cls: number[] = [];
  reset(x: number, z: number): void {
    this.pts.length = 0; this.spd.length = 0; this.cls.length = 0;
    this.pts.push(x, z);
  }
  add(x: number, z: number, speed: number, cls: number): void {
    const n = this.pts.length;
    const lx = this.pts[n - 2], lz = this.pts[n - 1];
    if (Math.abs(lx - x) < 1e-4 && Math.abs(lz - z) < 1e-4) return;
    this.pts.push(x, z);
    this.spd.push(speed);
    this.cls.push(cls);
  }
  build(): Route {
    const points = new Float32Array(this.pts);
    const segSpeed = new Float32Array(this.spd);
    const segClass = new Uint8Array(this.cls);
    let len = 0, eta = 0;
    for (let k = 0; k < segSpeed.length; k++) {
      const l = Math.hypot(points[k * 2 + 2] - points[k * 2], points[k * 2 + 3] - points[k * 2 + 1]);
      len += l;
      eta += l / Math.max(0.1, segSpeed[k]);
    }
    return { points, segSpeed, segClass, lengthKm: len, etaHours: eta };
  }
}

export class Pathfinder {
  private readonly geo: GeoData;
  private readonly graph: NavGraph;
  private readonly W: number;
  private readonly H: number;
  private readonly cell: number;
  private readonly heap = new MinHeap();
  private readonly heap2 = new MinHeap();
  private readonly connA = new GridSpace(128 * 128);
  private readonly connB = new GridSpace(128 * 128);
  private full: GridSpace | null = null;
  private coarse: GridSpace | null = null;
  private coarseSea: Uint8Array | null = null;
  private corridor: Uint16Array | null = null;
  private corridorGen = 0;
  // Graph-Suche
  private readonly gN: Float64Array;
  private readonly stN: Uint32Array;
  private readonly parE: Int32Array;
  private readonly seedN: Int32Array;
  private readonly goalC: Float64Array;
  private readonly goalSt: Uint32Array;
  private readonly goalS: Int32Array;
  private genN = 0;
  private readonly speedCls = new Float32Array(ROAD_CLASSES.length);
  private readonly rb = new RouteBuilder();
  // Anbindungs-Dijkstra: Kandidatenpunkte je Rasterzelle
  private readonly entries = new Map<number, Sample[]>();
  private readonly edgeTmp: number[] = [];
  private readonly connEdges = new Set<number>();
  private connReached: Sample[] = [];
  private connFirstG = Infinity;
  /** Statistik der letzten Suche (Debug) */
  lastStats = { kind: '', expanded: 0, graphExpanded: 0, ms: 0 };

  constructor(geo: GeoData, graph: NavGraph) {
    this.geo = geo;
    this.graph = graph;
    this.W = geo.width;
    this.H = geo.height;
    this.cell = geo.cellKm;
    const n = graph.nodes.length;
    this.gN = new Float64Array(n);
    this.stN = new Uint32Array(n);
    this.parE = new Int32Array(n);
    this.seedN = new Int32Array(n);
    this.goalC = new Float64Array(n);
    this.goalSt = new Uint32Array(n);
    this.goalS = new Int32Array(n);
  }

  // ================================================================== öffentliche API

  findRoute(fromX: number, fromZ: number, toX: number, toZ: number, mob: MobilityProfile): Route | null {
    const t0 = now();
    let r: Route | null;
    if (mob.domain === 'air') {
      this.rb.reset(fromX, fromZ);
      this.rb.add(toX, toZ, Math.max(1, mob.offroadSpeed), OFFROAD_CLASS);
      if (this.rb.cls.length === 0) this.rb.add(toX + 1e-3, toZ, Math.max(1, mob.offroadSpeed), OFFROAD_CLASS);
      r = this.rb.build();
      this.lastStats.kind = 'air';
    } else if (mob.domain === 'naval') {
      r = this.naval(fromX, fromZ, toX, toZ, mob);
    } else {
      r = this.ground(fromX, fromZ, toX, toZ, mob);
    }
    this.lastStats.ms = now() - t0;
    return r;
  }

  passable(x: number, z: number, mob: MobilityProfile): boolean {
    if (mob.domain === 'air') return true;
    if (!this.geo.inside(x, z)) return false;
    const k = this.cellIdx(x, z);
    if (mob.domain === 'naval') return this.seaMask()[k] === 1;
    if (this.landCell(k)) return true;
    this.setSpeeds(mob);
    return this.graph.nearestEdgePoint(x, z, 0.3, (e) => e.open && this.speedCls[this.graph.edgeCls[e.id]] > 0) !== null;
  }

  nearestPassable(x: number, z: number, mob: MobilityProfile, maxKm = 30): [number, number] | null {
    if (mob.domain === 'air') return [x, z];
    if (this.passable(x, z, mob)) return [x, z];
    const c = this.cell, W = this.W, H = this.H;
    const ci = Math.floor(x / c), cj = Math.floor(z / c);
    const rMax = Math.ceil(maxKm / c);
    const naval = mob.domain === 'naval';
    const sea = naval ? this.seaMask() : null;
    let best: [number, number] | null = null;
    let bd = maxKm;
    for (let r = 0; r <= rMax; r++) {
      if ((r - 1) * c > bd) break;
      for (let j = cj - r; j <= cj + r; j++) {
        if (j < 0 || j >= H) continue;
        const step = j === cj - r || j === cj + r ? 1 : 2 * r;
        for (let i = ci - r; i <= ci + r; i += Math.max(1, step)) {
          if (i < 0 || i >= W) continue;
          const k = j * W + i;
          const ok = naval ? sea![k] === 1 : this.landCell(k);
          if (!ok) continue;
          // nächster Punkt in der Zelle (leicht nach innen versetzt)
          const px = clamp(x, i * c + 0.05, (i + 1) * c - 0.05), pz = clamp(z, j * c + 0.05, (j + 1) * c - 0.05);
          const d = Math.hypot(px - x, pz - z);
          if (d < bd) { bd = d; best = [px, pz]; }
        }
      }
    }
    if (!naval) {
      this.setSpeeds(mob);
      const ep = this.graph.nearestEdgePoint(x, z, Math.min(bd, maxKm), (e) => e.open && this.speedCls[this.graph.edgeCls[e.id]] > 0);
      if (ep && ep.distKm < bd) best = [ep.x, ep.z];
    }
    return best;
  }

  // ================================================================== Hilfen

  private cellIdx(x: number, z: number): number {
    const i = clamp(Math.floor(x / this.cell), 0, this.W - 1), j = clamp(Math.floor(z / this.cell), 0, this.H - 1);
    return j * this.W + i;
  }
  private landCell(k: number): boolean {
    return this.geo.countryIds[k] !== 0 && this.geo.waterFlags[k] === 0;
  }
  private setSpeeds(mob: MobilityProfile): number {
    let vmax = 0;
    for (let c = 0; c < ROAD_CLASSES.length; c++) {
      const v = mob.roadSpeed[ROAD_CLASSES[c]] ?? 0;
      this.speedCls[c] = v > 0 ? v : 0;
      if (v > vmax) vmax = v;
    }
    return vmax;
  }
  private getFull(): GridSpace {
    if (!this.full) this.full = new GridSpace(this.W * this.H);
    return this.full;
  }

  // ================================================================== Boden

  private ground(fx: number, fz: number, tx: number, tz: number, mob: MobilityProfile): Route | null {
    const geo = this.geo;
    fx = clamp(fx, 0.001, geo.widthKm - 0.001); fz = clamp(fz, 0.001, geo.heightKm - 0.001);
    const snapped = this.nearestPassable(clamp(tx, 0.001, geo.widthKm - 0.001), clamp(tz, 0.001, geo.heightKm - 0.001), mob, 40);
    if (!snapped) return null;
    [tx, tz] = snapped;
    const vmaxRoad = this.setSpeeds(mob);
    const off = Math.max(0.5, mob.offroadSpeed);
    const connSpeed = mob.offroadAllowed ? off : off * 0.5;
    const connKm = mob.offroadAllowed ? CONNECT_KM : CONNECT_KM_ROADBOUND;
    const slopePen = mob.offroadAllowed ? mob.slopePenalty : 0;
    const dist = Math.hypot(tx - fx, tz - fz);
    this.lastStats.expanded = 0;
    this.lastStats.graphExpanded = 0;

    // --- Kandidat 1: reines Gelände
    let bestT = Infinity;
    let offRoute: Route | null = null;
    const directKm = mob.offroadAllowed ? OFFROAD_DIRECT_KM : CONNECT_KM_ROADBOUND;
    if (dist <= directKm && this.landCell(this.cellIdx(tx, tz))) {
      offRoute = this.offroadRoute(fx, fz, tx, tz, connSpeed, slopePen, 1.0);
      if (offRoute) bestT = offRoute.etaHours;
    }

    // --- Kandidat 2: hybrid über Straßennetz
    let hybrid: Route | null = null;
    if (vmaxRoad > 0 && dist > 0.5) {
      const A: Connector = { space: this.connA, x: fx, z: fz, reached: [], speed: connSpeed };
      const B: Connector = { space: this.connB, x: tx, z: tz, reached: [], speed: connSpeed };
      this.connect(A, connKm, slopePen);
      if (A.reached.length) this.connect(B, connKm, slopePen);
      if (A.reached.length && B.reached.length) hybrid = this.graphRoute(A, B, Math.max(vmaxRoad, connSpeed), bestT, slopePen);
    }
    if (hybrid && hybrid.etaHours < bestT) {
      this.lastStats.kind = 'hybrid';
      return hybrid;
    }
    if (offRoute) {
      this.lastStats.kind = 'offroad';
      return offRoute;
    }
    // --- Rückfall: langes Gelände-A* (gewichtet)
    if (mob.offroadAllowed && dist <= OFFROAD_FALLBACK_KM && this.landCell(this.cellIdx(tx, tz))) {
      const r = this.offroadRoute(fx, fz, tx, tz, connSpeed, slopePen, 1.4);
      if (r) { this.lastStats.kind = 'offroad-long'; return r; }
    }
    if (dist <= 0.5 && this.landCell(this.cellIdx(tx, tz)) === this.landCell(this.cellIdx(fx, fz))) {
      this.rb.reset(fx, fz);
      this.rb.add(tx, tz, connSpeed, OFFROAD_CLASS);
      if (this.rb.cls.length === 0) return null;
      this.lastStats.kind = 'tiny';
      return this.rb.build();
    }
    this.lastStats.kind = 'none';
    return null;
  }

  /**
   * Gelände-Suche (A* mit Ziel, oder Dijkstra mit Anbindungspunkten wenn this.entries gefüllt und
   * goalK < 0). Gibt lokalen Index der Zielzelle zurück oder -1.
   */
  private groundSearch(S: GridSpace, sx: number, sz: number, goalK: number, speed: number, slopePen: number, maxT: number, hW: number, conn: Connector | null): number {
    const W = this.W, ids = this.geo.countryIds, wf = this.geo.waterFlags, hk = this.geo.heightsKm, c = this.cell;
    const heap = this.heap;
    heap.clear();
    const si = clamp(Math.floor(sx / c), 0, W - 1), sj = clamp(Math.floor(sz / c), 0, this.H - 1);
    const gi = goalK >= 0 ? goalK % W : 0, gj = goalK >= 0 ? (goalK / W) | 0 : 0;
    const hScale = goalK >= 0 ? (hW * c) / speed : 0;
    const octile = (i: number, j: number) => {
      const dx = Math.abs(i - gi), dz = Math.abs(j - gj);
      return (dx > dz ? dx + (SQRT2 - 1) * dz : dz + (SQRT2 - 1) * dx) * hScale;
    };
    const i0 = S.i0, j0 = S.j0, w = S.w, h = S.h;
    const g = S.g, st = S.st, dir = S.dir;
    const gen = S.gen, closed = gen + 1;
    const sl = (sj - j0) * w + (si - i0);
    g[sl] = 0; st[sl] = gen; dir[sl] = 255;
    heap.push(goalK >= 0 ? octile(si, sj) : 0, sl);
    const sk = sj * W + si;
    let expanded = 0;
    const entries = conn ? this.entries : null;
    const spdPen = slopePen * SLOPE_K;
    while (heap.size) {
      const l = heap.pop();
      if (st[l] === closed) continue;
      st[l] = closed;
      const gl = g[l];
      if (gl > maxT) break;
      expanded++;
      const li = l % w, lj = (l / w) | 0;
      const i = li + i0, j = lj + j0, k = j * W + i;
      if (k === goalK) { this.lastStats.expanded += expanded; return l; }
      if (entries) {
        const arr = entries.get(k);
        if (arr) for (const smp of arr) this.reach(conn!, smp, gl, k === sk ? -1 : k, k === sk);
        if (this.connStop(gl, conn!)) break;
      }
      const hc = hk[k];
      for (let d = 0; d < 8; d++) {
        const ni = li + DI[d], nj = lj + DJ[d];
        if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
        const nk = k + DJ[d] * W + DI[d];
        if (ids[nk] === 0 || wf[nk] !== 0) {
          if (entries) {
            const arr = entries.get(nk);
            if (arr) for (const smp of arr) this.reach(conn!, smp, gl, k === sk ? -1 : k, k === sk);
          }
          continue;
        }
        if (d >= 4) {
          const ak = k + DI[d], bk = k + DJ[d] * W;
          if (ids[ak] === 0 || wf[ak] !== 0 || ids[bk] === 0 || wf[bk] !== 0) continue;
        }
        const nl = l + DJ[d] * w + DI[d];
        if (st[nl] === closed) continue;
        const dk = d < 4 ? c : c * SQRT2;
        const slope = Math.abs(hk[nk] - hc) / dk;
        const ng = gl + (dk * (1 + spdPen * slope)) / speed;
        if (st[nl] !== gen || ng < g[nl]) {
          st[nl] = gen; g[nl] = ng; dir[nl] = d;
          heap.push(goalK >= 0 ? ng + octile(ni + i0, nj + j0) : ng, nl);
        }
      }
    }
    this.lastStats.expanded += expanded;
    return -1;
  }

  /** Rasterpfad (globale Zellen) vom Start bis lokaler Zelle l, Startzelle zuerst */
  private cellPath(S: GridSpace, l: number, out: number[]): number[] {
    out.length = 0;
    const W = this.W;
    for (let guard = 0; guard < 1e6; guard++) {
      const li = l % S.w, lj = (l / S.w) | 0;
      out.push((lj + S.j0) * W + li + S.i0);
      const d = S.dir[l];
      if (d === 255) break;
      l -= DJ[d] * S.w + DI[d];
    }
    out.reverse();
    return out;
  }

  private readonly tmpCells: number[] = [];
  private readonly tmpPts: number[] = [];
  private readonly tmpT: number[] = [];

  /**
   * Verdichtet einen Rasterpfad (exakter Start, Zellmitten, exaktes Ende) per Sichtlinie und
   * hängt ihn an den RouteBuilder an (mit Segmentgeschwindigkeit aus den Zeitstempeln).
   * pts/times: Punkte inkl. Start und Ende; reverse = Reihenfolge umkehren.
   */
  private emitSmoothed(pts: number[], times: number[], reverse: boolean, cls: number, naval: boolean): void {
    const n = pts.length / 2;
    if (reverse) {
      const p2: number[] = [], t2: number[] = [];
      const T = times[n - 1];
      for (let k = n - 1; k >= 0; k--) { p2.push(pts[k * 2], pts[k * 2 + 1]); t2.push(T - times[k]); }
      pts = p2; times = t2;
    }
    let a = 0;
    while (a < n - 1) {
      let b = a + 1;
      // weitestes sichtbares b (Endpunkte dürfen in unpassierbaren Zellen liegen)
      const limit = Math.min(n - 1, a + 400);
      for (let c = a + 2; c <= limit; c++) {
        if (this.lineOfSight(pts[a * 2], pts[a * 2 + 1], pts[c * 2], pts[c * 2 + 1], naval, a === 0, c === n - 1)) b = c;
        else if (c - b > 6) break;
      }
      const len = Math.hypot(pts[b * 2] - pts[a * 2], pts[b * 2 + 1] - pts[a * 2 + 1]);
      const dt = times[b] - times[a];
      const spd = dt > 1e-9 ? len / dt : 1;
      this.rb.add(pts[b * 2], pts[b * 2 + 1], Math.max(0.5, spd), cls);
      a = b;
    }
  }

  /** Supercover-Sichtlinie über passierbare Zellen (Land bzw. Meer). */
  private lineOfSight(x0: number, z0: number, x1: number, z1: number, naval: boolean, skipFirst: boolean, skipLast: boolean): boolean {
    const c = this.cell, W = this.W, ids = this.geo.countryIds, wf = this.geo.waterFlags;
    const sea = naval ? this.seaMask() : null;
    const ok = (i: number, j: number) => {
      if (i < 0 || j < 0 || i >= W || j >= this.H) return false;
      const k = j * W + i;
      return naval ? sea![k] === 1 : ids[k] !== 0 && wf[k] === 0;
    };
    let i = Math.floor(x0 / c), j = Math.floor(z0 / c);
    const ie = Math.floor(x1 / c), je = Math.floor(z1 / c);
    const dx = x1 - x0, dz = z1 - z0;
    const si = dx > 0 ? 1 : -1, sj = dz > 0 ? 1 : -1;
    const tdx = dx !== 0 ? Math.abs(c / dx) : Infinity, tdz = dz !== 0 ? Math.abs(c / dz) : Infinity;
    let tx = dx !== 0 ? ((dx > 0 ? (i + 1) * c - x0 : x0 - i * c) / Math.abs(dx)) : Infinity;
    let tz = dz !== 0 ? ((dz > 0 ? (j + 1) * c - z0 : z0 - j * c) / Math.abs(dz)) : Infinity;
    if (!skipFirst && !ok(i, j)) return false;
    for (let guard = 0; guard < 8000; guard++) {
      if (i === ie && j === je) return true;
      if (Math.min(tx, tz) > 1) return true;
      const last = (ni: number, nj: number) => ni === ie && nj === je && skipLast;
      if (Math.abs(tx - tz) < 1e-9) {
        // exakt durch Ecke: beide Nachbarn prüfen (konservativ)
        if (!ok(i + si, j) && !last(i + si, j)) return false;
        if (!ok(i, j + sj) && !last(i, j + sj)) return false;
        i += si; j += sj; tx += tdx; tz += tdz;
      } else if (tx < tz) { i += si; tx += tdx; }
      else { j += sj; tz += tdz; }
      if (!ok(i, j) && !last(i, j)) return false;
    }
    return true;
  }

  /** Reines Gelände-A* von (fx,fz) nach (tx,tz). */
  private offroadRoute(fx: number, fz: number, tx: number, tz: number, speed: number, slopePen: number, hW: number): Route | null {
    const S = this.getFull();
    const c = this.cell;
    const si = Math.floor(fx / c), sj = Math.floor(fz / c), gi = Math.floor(tx / c), gj = Math.floor(tz / c);
    const margin = Math.max(15, Math.ceil(Math.hypot(gi - si, gj - sj) * 0.35));
    const i0 = Math.max(0, Math.min(si, gi) - margin), j0 = Math.max(0, Math.min(sj, gj) - margin);
    const i1 = Math.min(this.W - 1, Math.max(si, gi) + margin), j1 = Math.min(this.H - 1, Math.max(sj, gj) + margin);
    S.begin(i0, j0, i1 - i0 + 1, j1 - j0 + 1);
    const goalK = gj * this.W + gi;
    const l = this.groundSearch(S, fx, fz, goalK, speed, slopePen, 1e9, hW, null);
    if (l < 0) return null;
    const cells = this.cellPath(S, l, this.tmpCells);
    const pts = this.tmpPts, ts = this.tmpT;
    pts.length = 0; ts.length = 0;
    pts.push(fx, fz); ts.push(0);
    for (let k = 1; k < cells.length - 1; k++) {
      const ck = cells[k];
      pts.push(((ck % this.W) + 0.5) * c, (((ck / this.W) | 0) + 0.5) * c);
      ts.push(S.g[(((ck / this.W) | 0) - S.j0) * S.w + (ck % this.W) - S.i0]);
    }
    pts.push(tx, tz); ts.push(S.g[l]);
    this.rb.reset(fx, fz);
    this.emitSmoothed(pts, ts, false, OFFROAD_CLASS, false);
    if (this.rb.cls.length === 0) this.rb.add(tx + 1e-3, tz, speed, OFFROAD_CLASS);
    return this.rb.build();
  }

  // ------------------------------------------------------------------ Anbindung ans Netz

  private connect(C: Connector, radiusKm: number, slopePen: number): void {
    const c = this.cell, g = this.graph;
    const ci = Math.floor(C.x / c), cj = Math.floor(C.z / c);
    const r = Math.min(62, Math.ceil(radiusKm / c) + 1);
    const i0 = Math.max(0, ci - r), j0 = Math.max(0, cj - r);
    const i1 = Math.min(this.W - 1, ci + r), j1 = Math.min(this.H - 1, cj + r);
    // Kandidatenpunkte: Stützpunkte nutzbarer Kanten alle ≤ 1 km, einer je (Kante, Zelle)
    this.entries.clear();
    const edges = g.edgesInRect(i0 * c, j0 * c, (i1 + 1) * c, (j1 + 1) * c, this.edgeTmp);
    const W = this.W;
    for (const e of edges) {
      const E = g.edges[e];
      if (!E.open || this.speedCls[g.edgeCls[e]] <= 0) continue;
      const geom = E.geom;
      let s = 0, lastK = -1;
      for (let k = 0; k + 1 < geom.length; k += 2) {
        const ax = geom[k], az = geom[k + 1];
        const segL = k + 3 < geom.length ? Math.hypot(geom[k + 2] - ax, geom[k + 3] - az) : 0;
        const steps = Math.max(1, Math.ceil(segL / 1));
        for (let q = 0; q < (k + 3 < geom.length ? steps : 1); q++) {
          const f = k + 3 < geom.length ? q / steps : 0;
          const x = ax + (k + 3 < geom.length ? (geom[k + 2] - ax) * f : 0);
          const z = az + (k + 3 < geom.length ? (geom[k + 3] - az) * f : 0);
          const i = Math.floor(x / c), j = Math.floor(z / c);
          if (i >= i0 && i <= i1 && j >= j0 && j <= j1) {
            const kk = j * W + i;
            if (kk !== lastK) {
              let arr = this.entries.get(kk);
              if (!arr) this.entries.set(kk, (arr = []));
              let dup = false;
              for (const o of arr) if (o.e === e) { dup = true; break; }
              if (!dup) arr.push({ e, s: s + segL * f, x, z, cost: Infinity, from: -2 });
              lastK = kk;
            }
          }
        }
        s += segL;
      }
    }
    this.connReached = [];
    this.connEdges.clear();
    this.connFirstG = Infinity;
    const S = C.space;
    S.begin(i0, j0, i1 - i0 + 1, j1 - j0 + 1);
    this.groundSearch(S, C.x, C.z, -1, C.speed, slopePen, radiusKm / C.speed * 1.6, 1, C);
    C.reached = this.connReached;
  }

  /** Kandidatenpunkt aus Zelle fromK (oder direkt vom Start) mit Zeit g erreicht */
  private reach(C: Connector, smp: Sample, g: number, fromK: number, direct: boolean): void {
    const c = this.cell;
    let d: number;
    if (direct) d = Math.hypot(smp.x - C.x, smp.z - C.z);
    else d = Math.hypot(smp.x - ((fromK % this.W) + 0.5) * c, smp.z - (((fromK / this.W) | 0) + 0.5) * c);
    const cost = g + d / C.speed;
    if (cost < smp.cost) {
      if (smp.from === -2) this.connReached.push(smp);
      smp.cost = cost;
      smp.from = direct ? -1 : fromK;
      if (!this.connEdges.has(smp.e)) {
        this.connEdges.add(smp.e);
        if (this.connFirstG === Infinity) this.connFirstG = g;
      }
    }
  }

  private connStop(g: number, C: Connector): boolean {
    if (this.connEdges.size >= CONNECT_MAX_EDGES) return true;
    // nach dem ersten Treffer noch ~12 km Gelände weitersuchen
    return this.connFirstG !== Infinity && g > this.connFirstG + 12 / C.speed;
  }

  // ------------------------------------------------------------------ Graph-A*

  private graphRoute(A: Connector, B: Connector, vmax: number, bound: number, slopePen: number): Route | null {
    const g = this.graph, nodes = g.nodes, edges = g.edges, spd = this.speedCls, ecls = g.edgeCls;
    this.genN++;
    if (this.genN >= 0xfffffff0) { this.stN.fill(0); this.goalSt.fill(0); this.genN = 1; }
    const gen = this.genN * 2, closed = gen + 1; // stN: gen offen, gen+1 geschlossen
    void slopePen;
    // Ziel-Anbindungen
    for (let q = 0; q < B.reached.length; q++) {
      const smp = B.reached[q];
      const E = edges[smp.e], v = spd[ecls[smp.e]];
      const ca = smp.cost + smp.s / v, cb = smp.cost + (E.lengthKm - smp.s) / v;
      for (const [n, cst] of [[E.a, ca], [E.b, cb]] as const) {
        if (this.goalSt[n] !== gen || cst < this.goalC[n]) { this.goalSt[n] = gen; this.goalC[n] = cst; this.goalS[n] = q; }
      }
    }
    const heap = this.heap2;
    heap.clear();
    const tx = B.x, tz = B.z;
    const hf = (n: number) => Math.hypot(nodes[n].x - tx, nodes[n].z - tz) / vmax;
    for (let q = 0; q < A.reached.length; q++) {
      const smp = A.reached[q];
      const E = edges[smp.e], v = spd[ecls[smp.e]];
      const ca = smp.cost + smp.s / v, cb = smp.cost + (E.lengthKm - smp.s) / v;
      for (const [n, cst] of [[E.a, ca], [E.b, cb]] as const) {
        if (this.stN[n] !== gen || cst < this.gN[n]) {
          this.stN[n] = gen; this.gN[n] = cst; this.parE[n] = -1; this.seedN[n] = q;
          heap.push(cst + hf(n), n);
        }
      }
    }
    // gleiche Kante bei Start und Ziel
    let best = bound, bestNode = -1, sameA = -1, sameB = -1;
    for (let qa = 0; qa < A.reached.length; qa++) {
      const sa = A.reached[qa];
      for (let qb = 0; qb < B.reached.length; qb++) {
        const sb = B.reached[qb];
        if (sa.e !== sb.e) continue;
        const cst = sa.cost + Math.abs(sa.s - sb.s) / spd[ecls[sa.e]] + sb.cost;
        if (cst < best) { best = cst; sameA = qa; sameB = qb; }
      }
    }
    let expanded = 0;
    while (heap.size) {
      if (heap.topKey() >= best) break;
      const u = heap.pop();
      if (this.stN[u] === closed) continue;
      this.stN[u] = closed;
      expanded++;
      const gu = this.gN[u];
      if (this.goalSt[u] === gen) {
        const cst = gu + this.goalC[u];
        if (cst < best) { best = cst; bestNode = u; sameA = -1; }
      }
      const ne = nodes[u].edges;
      for (let q = 0; q < ne.length; q++) {
        const e = ne[q];
        const E = edges[e];
        const v = spd[ecls[e]];
        if (v <= 0 || !E.open) continue;
        const w = E.a === u ? E.b : E.a;
        if (this.stN[w] === closed) continue;
        const ng = gu + E.lengthKm / v;
        if (this.stN[w] !== gen || ng < this.gN[w]) {
          this.stN[w] = gen; this.gN[w] = ng; this.parE[w] = e;
          heap.push(ng + hf(w), w);
        }
      }
    }
    this.lastStats.graphExpanded = expanded;
    if (bestNode < 0 && sameA < 0) return null;

    // --- Montage
    const rb = this.rb;
    rb.reset(A.x, A.z);
    if (sameA >= 0 && bestNode < 0) {
      const sa = A.reached[sameA], sb = B.reached[sameB];
      this.emitConnector(A, sa, false, slopePen);
      this.appendEdge(sa.e, sa.s, sb.s);
      this.emitConnector(B, sb, true, slopePen);
      return rb.build();
    }
    // Knotenkette rückwärts
    const chain: number[] = [];
    let n = bestNode;
    for (let guard = 0; guard < 1e6 && this.parE[n] >= 0; guard++) {
      const e = this.parE[n];
      chain.push(e);
      n = edges[e].a === n ? edges[e].b : edges[e].a;
    }
    chain.reverse();
    const seed = A.reached[this.seedN[n]];
    this.emitConnector(A, seed, false, slopePen);
    const E0 = edges[seed.e];
    this.appendEdge(seed.e, seed.s, n === E0.a ? 0 : E0.lengthKm);
    let cur = n;
    for (const e of chain) {
      const E = edges[e];
      if (E.a === cur) { this.appendEdge(e, 0, E.lengthKm); cur = E.b; }
      else { this.appendEdge(e, E.lengthKm, 0); cur = E.a; }
    }
    const gs = B.reached[this.goalS[cur]];
    const Eg = edges[gs.e];
    this.appendEdge(gs.e, cur === Eg.a ? 0 : Eg.lengthKm, gs.s);
    this.emitConnector(B, gs, true, slopePen);
    return rb.build();
  }

  /** Hängt Kantengeometrie von sFrom bis sTo (km ab a, beliebige Richtung) an. */
  private appendEdge(e: number, sFrom: number, sTo: number): void {
    const E = this.graph.edges[e], g = E.geom;
    const v = this.speedCls[this.graph.edgeCls[e]];
    const cls = this.graph.edgeCls[e];
    const n = g.length / 2;
    const pt = this.graph.pointOnEdge(e, E.lengthKm > 0 ? sFrom / E.lengthKm : 0, [0, 0]);
    this.rb.add(pt[0], pt[1], v, cls);
    if (sTo >= sFrom) {
      let s = 0;
      for (let k = 1; k < n - 1; k++) {
        s += Math.hypot(g[k * 2] - g[k * 2 - 2], g[k * 2 + 1] - g[k * 2 - 1]);
        if (s > sFrom && s < sTo) this.rb.add(g[k * 2], g[k * 2 + 1], v, cls);
      }
    } else {
      // rückwärts: Stützpunktpositionen vorberechnen
      const cum = this.tmpT;
      cum.length = 0;
      let s = 0;
      cum.push(0);
      for (let k = 1; k < n; k++) { s += Math.hypot(g[k * 2] - g[k * 2 - 2], g[k * 2 + 1] - g[k * 2 - 1]); cum.push(s); }
      for (let k = n - 2; k >= 1; k--) if (cum[k] < sFrom && cum[k] > sTo) this.rb.add(g[k * 2], g[k * 2 + 1], v, cls);
    }
    this.graph.pointOnEdge(e, E.lengthKm > 0 ? sTo / E.lengthKm : 0, pt);
    this.rb.add(pt[0], pt[1], v, cls);
  }

  /** Anbindungsweg Start->Punkt (reverse=false) bzw. Punkt->Ziel (reverse=true) */
  private emitConnector(C: Connector, smp: Sample, reverse: boolean, slopePen: number): void {
    void slopePen;
    const pts: number[] = [], ts: number[] = [];
    const S = C.space, c = this.cell, W = this.W;
    pts.push(C.x, C.z); ts.push(0);
    if (smp.from >= 0) {
      const fi = smp.from % W, fj = (smp.from / W) | 0;
      const l = (fj - S.j0) * S.w + (fi - S.i0);
      const cells = this.cellPath(S, l, []);
      for (let k = 1; k < cells.length; k++) {
        const ck = cells[k], ci = ck % W, cj = (ck / W) | 0;
        pts.push((ci + 0.5) * c, (cj + 0.5) * c);
        ts.push(S.g[(cj - S.j0) * S.w + (ci - S.i0)]);
      }
    }
    pts.push(smp.x, smp.z); ts.push(smp.cost);
    if (pts.length === 4 && Math.hypot(pts[2] - pts[0], pts[3] - pts[1]) < 1e-4) return;
    this.emitSmoothed(pts, ts, reverse, OFFROAD_CLASS, false);
  }

  // ================================================================== See

  private buildCoarse(): void {
    const CW = Math.ceil(this.W / COARSE), CH = Math.ceil(this.H / COARSE);
    const m = new Uint8Array(CW * CH);
    const sea = this.seaMask(), W = this.W;
    for (let j = 0; j < this.H; j++)
      for (let i = 0; i < W; i++) if (sea[j * W + i] === 1) m[((j / COARSE) | 0) * CW + ((i / COARSE) | 0)] = 1;
    this.coarseSea = m;
    this.coarse = new GridSpace(CW * CH);
    this.corridor = new Uint16Array(CW * CH);
  }

  private naval(fx: number, fz: number, tx: number, tz: number, mob: MobilityProfile): Route | null {
    const geo = this.geo, c = this.cell, W = this.W;
    const speed = Math.max(1, mob.offroadSpeed);
    fx = clamp(fx, 0.001, geo.widthKm - 0.001); fz = clamp(fz, 0.001, geo.heightKm - 0.001);
    const s0 = this.nearestPassable(fx, fz, mob, 80);
    const g0 = this.nearestPassable(clamp(tx, 0.001, geo.widthKm - 0.001), clamp(tz, 0.001, geo.heightKm - 0.001), mob, 80);
    if (!s0 || !g0) { this.lastStats.kind = 'none'; return null; }
    [tx, tz] = g0;
    if (!this.coarse) this.buildCoarse();
    const CW = Math.ceil(this.W / COARSE), CH = Math.ceil(this.H / COARSE);
    const si = Math.floor(s0[0] / c), sj = Math.floor(s0[1] / c), gi = Math.floor(tx / c), gj = Math.floor(tz / c);
    this.lastStats.expanded = 0;

    // --- grobe Suche
    const CS = this.coarse!;
    CS.begin(0, 0, CW, CH);
    const cs = ((sj / COARSE) | 0) * CW + ((si / COARSE) | 0), cg = ((gj / COARSE) | 0) * CW + ((gi / COARSE) | 0);
    const cl = this.seaSearch(CS, cs, cg, CW, CH, this.coarseSea!, null, 0, 1.5);
    if (cl < 0) { this.lastStats.kind = 'none'; return null; }
    const cpath: number[] = [];
    for (let l = cl, guard = 0; guard < 1e6; guard++) {
      cpath.push(l);
      const d = CS.dir[l];
      if (d === 255) break;
      l -= DJ[d] * CW + DI[d];
    }

    // --- feine Suche im Korridor (bei Misserfolg breiter, zuletzt ohne Korridor)
    const F = this.getFull();
    const sea = this.seaMask();
    let fl = -1;
    for (const rad of [2, 5, -1]) {
      let cgen = 0;
      if (rad >= 0) {
        cgen = ++this.corridorGen;
        if (cgen >= 65535) { this.corridor!.fill(0); this.corridorGen = cgen = 1; }
        const cor = this.corridor!;
        for (const b of cpath) {
          const bi = b % CW, bj = (b / CW) | 0;
          for (let dj = -rad; dj <= rad; dj++)
            for (let di = -rad; di <= rad; di++) {
              const x = bi + di, y = bj + dj;
              if (x >= 0 && y >= 0 && x < CW && y < CH) cor[y * CW + x] = cgen;
            }
        }
      }
      F.begin(0, 0, W, this.H);
      fl = this.seaSearch(F, sj * W + si, gj * W + gi, W, this.H, sea, rad >= 0 ? this.corridor : null, cgen, rad >= 0 ? 1.1 : 1.6);
      if (fl >= 0) { this.lastStats.kind = `naval r${rad}`; break; }
    }
    if (fl < 0) { this.lastStats.kind = 'none'; return null; }
    const cells: number[] = [];
    for (let l = fl, guard = 0; guard < 1e7; guard++) {
      cells.push(l);
      const d = F.dir[l];
      if (d === 255) break;
      l -= DJ[d] * W + DI[d];
    }
    cells.reverse();
    const pts: number[] = [], ts: number[] = [];
    pts.push(s0[0], s0[1]); ts.push(0);
    for (let k = 1; k < cells.length - 1; k++) {
      const ck = cells[k];
      pts.push(((ck % W) + 0.5) * c, (((ck / W) | 0) + 0.5) * c);
      ts.push((F.g[ck] * c) / speed);
    }
    pts.push(tx, tz); ts.push((F.g[fl] * c) / speed + 1e-6);
    const rb = this.rb;
    rb.reset(fx, fz);
    rb.add(s0[0], s0[1], speed, OFFROAD_CLASS);
    this.emitSmoothed(pts, ts, false, OFFROAD_CLASS, true);
    // konstante Geschwindigkeit auf See
    for (let k = 0; k < rb.spd.length; k++) rb.spd[k] = speed;
    if (rb.cls.length === 0) rb.add(tx + 1e-3, tz, speed, OFFROAD_CLASS);
    return rb.build();
  }

  private seaMaskCache: Uint8Array | null = null;
  /** Meeresmaske (1 = befahrbar) inkl. eingebrannter Meerengen, die das 2-km-Raster verschluckt */
  private seaMask(): Uint8Array {
    if (!this.seaMaskCache) {
      const ids = this.geo.countryIds, W = this.W, c = this.cell;
      const m = new Uint8Array(ids.length);
      for (let k = 0; k < ids.length; k++) m[k] = ids[k] === 0 ? 1 : 0;
      for (const line of SEA_CHANNELS) {
        for (let p = 0; p + 3 < line.length; p += 2) {
          const [x0, z0] = this.geo.lonLatToWorld(line[p], line[p + 1]);
          const [x1, z1] = this.geo.lonLatToWorld(line[p + 2], line[p + 3]);
          const steps = Math.ceil((Math.hypot(x1 - x0, z1 - z0) / c) * 4) + 1;
          let pi = -1, pj = -1;
          for (let q = 0; q <= steps; q++) {
            const i = Math.floor((x0 + ((x1 - x0) * q) / steps) / c), j = Math.floor((z0 + ((z1 - z0) * q) / steps) / c);
            if (i < 0 || j < 0 || i >= W || j >= this.H) continue;
            if (pi >= 0 && i !== pi && j !== pj) m[pj * W + i] = 1; // 4-zusammenhängend
            m[j * W + i] = 1;
            pi = i; pj = j;
          }
        }
      }
      this.seaMaskCache = m;
    }
    return this.seaMaskCache;
  }

  /**
   * A* auf einem Raster mit 0/1-Maske (Kosten = Distanz in Zellen). Diagonalen nur, wenn
   * mindestens ein orthogonaler Nachbar frei ist. Optionaler Korridor auf Grobblock-Ebene.
   */
  private seaSearch(S: GridSpace, start: number, goal: number, w: number, h: number, mask: Uint8Array, corridor: Uint16Array | null, cgen: number, hW: number): number {
    const heap = this.heap;
    heap.clear();
    const g = S.g, st = S.st, dir = S.dir, gen = S.gen, closed = gen + 1;
    const gi = goal % w, gj = (goal / w) | 0;
    const CW = Math.ceil(this.W / COARSE);
    const hf = (i: number, j: number) => {
      const dx = Math.abs(i - gi), dz = Math.abs(j - gj);
      return (dx > dz ? dx + (SQRT2 - 1) * dz : dz + (SQRT2 - 1) * dx) * hW;
    };
    g[start] = 0; st[start] = gen; dir[start] = 255;
    heap.push(hf(start % w, (start / w) | 0), start);
    let expanded = 0;
    const free = (k: number, i: number, j: number) =>
      mask[k] === 1 && (!corridor || corridor[((j / COARSE) | 0) * CW + ((i / COARSE) | 0)] === cgen);
    while (heap.size) {
      const l = heap.pop();
      if (st[l] === closed) continue;
      st[l] = closed;
      expanded++;
      if (l === goal) { this.lastStats.expanded += expanded; return l; }
      const i = l % w, j = (l / w) | 0, gl = g[l];
      for (let d = 0; d < 8; d++) {
        const ni = i + DI[d], nj = j + DJ[d];
        if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
        const nl = l + DJ[d] * w + DI[d];
        if (st[nl] === closed) continue;
        if (nl !== goal && !free(nl, ni, nj)) continue;
        if (d >= 4 && !free(l + DI[d], i + DI[d], j) && !free(l + DJ[d] * w, i, j + DJ[d])) continue;
        const ng = gl + (d < 4 ? 1 : SQRT2);
        if (st[nl] !== gen || ng < g[nl]) {
          st[nl] = gen; g[nl] = ng; dir[nl] = d;
          heap.push(ng + hf(ni, nj), nl);
        }
      }
    }
    this.lastStats.expanded += expanded;
    return -1;
  }
}

function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}
function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
