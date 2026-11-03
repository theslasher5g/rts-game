/**
 * Phase 3 – Deckungssystem (implementiert CoverQuery).
 *
 * Quellen für Deckungspunkte:
 *  - 'cover:add' / 'cover:remove' (Bauwerke, Gebäude von Agent D; IDs kommen vom Absender, werden unverändert übernommen)
 *  - 'wreck:spawn'      -> 'wreck'-Deckung (zwei gegenüberliegende Seiten)
 *  - 'building:destroyed' -> 'rubble'-Deckung
 *  - Natürliche Deckung: Geländekanten (Hang/Kamm), Mulden, Flussufer, kleine Bodenwellen – lazy je 1-km-Kachel
 *    erzeugt, sobald Infanterie dort Deckung sucht (find()/generateTileCover()).
 *
 * Konvention: CoverPoint.dir zeigt zur Bedrohung (Vorderseite); Soldaten stehen bei (x,z) − dir·BEHIND_KM.
 */
import { bus } from '../core/EventBus';
import type { Settings } from '../core/types';
import type { CoverPoint, CoverQuery } from '../combat/types';
import type { GeoData } from '../world/GeoData';

// ---------------------------------------------------------------- gemeinsamer ID-Zähler
let _coverId = 1;
/** Globaler Zähler für Deckungs-IDs (≥ 1). Alle Module, die CoverPoints erzeugen, nutzen diese Funktion. */
export function nextCoverId(): number {
  return _coverId++;
}

// ---------------------------------------------------------------- Tuning
/** Hash-Zellgröße (km) */
const CELL = 0.5;
/** Kachelgröße für natürliche Deckung (km) */
const TILE = 1;
/** Max. gleichzeitig gehaltene Terrain-Kacheln (LRU) */
const MAX_TILES = 500;
/** Max. Wrack-Punkte (FIFO) */
const MAX_WRECKS = 300;
/** Abstand der Soldaten hinter der Deckungslinie (km) */
export const BEHIND_KM = 0.004;
/** Mindest-Hangneigung (km/km) für Geländekante */
const SLOPE_MIN = 0.012;
const MAX_TERRAIN_PER_TILE = 10;
const HUMMOCKS_PER_TILE = 2;

export class CoverSystem implements CoverQuery {
  /** Alle lebenden Deckungspunkte */
  readonly points = new Map<number, CoverPoint>();
  private grid = new Map<number, number[]>();
  /** Besetzung: Deckungs-ID -> (Einheit -> Anzahl Soldaten) */
  private occ = new Map<number, Map<number, number>>();
  /** Terrain-Kacheln: Schlüssel -> {ids, letzte Nutzung} */
  private tiles = new Map<number, { ids: number[]; used: number }>();
  private wreckIds: number[] = [];
  private time = 0;
  private naturalEnabled = true;
  private offs: Array<() => void> = [];

  constructor(private geo: GeoData, private settings: Settings) {
    this.offs.push(
      bus.on('cover:add', ({ point }) => this.insert(point)),
      bus.on('cover:remove', ({ id }) => this.remove(id)),
      bus.on('wreck:spawn', (e) => this.onWreck(e.x, e.z, e.heading)),
      bus.on('building:destroyed', (e) => {
        // Trümmer: Rundumdeckung (zwei Seiten)
        for (const s of [1, -1]) this.add({ x: e.x, z: e.z, dirX: s, dirZ: 0, kind: 'rubble', protection: 0.4, posture: 'prone', capacity: 4, vaultable: true, structureId: 0 });
      }),
    );
  }

  get currentSettings(): Settings {
    return this.settings;
  }

  applySettings(s: Settings): void {
    this.settings = s;
  }

  /** Natürliche Deckung ein-/ausschalten (Tests) */
  setNaturalEnabled(v: boolean): void {
    this.naturalEnabled = v;
  }

  dispose(): void {
    for (const o of this.offs) o();
    this.offs.length = 0;
  }

  // ------------------------------------------------------------ CoverQuery

  get(id: number): CoverPoint | undefined {
    const p = this.points.get(id);
    return p && p.alive ? p : undefined;
  }

  find(x: number, z: number, threatX: number, threatZ: number, rMaxKm: number, minProtection = 0): CoverPoint | null {
    if (this.naturalEnabled) this.ensureTiles(x, z, rMaxKm);
    let best: CoverPoint | null = null;
    let bestScore = -Infinity;
    const tl = Math.hypot(threatX - x, threatZ - z);
    const r2 = rMaxKm * rMaxKm;
    this.forCells(x, z, rMaxKm, (p) => {
      if (!p.alive || p.protection < minProtection) return;
      const dx = p.x - x, dz = p.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) return;
      if (this.load(p.id) >= p.capacity) return;
      // Bedrohung aus Sicht der Deckung: muss auf der Schutzseite (+dir) liegen
      const tx = threatX - p.x, tz = threatZ - p.z;
      const tn = Math.hypot(tx, tz);
      const cosA = tn > 1e-6 && tl > 1e-6 ? (p.dirX * tx + p.dirZ * tz) / tn : 1;
      if (cosA < 0.35) return;
      const score = p.protection * (0.4 + 0.6 * cosA) - 0.6 * (Math.sqrt(d2) / Math.max(rMaxKm, 1e-6)) + (p.structureId ? 0.05 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    });
    return best;
  }

  /** Alle lebenden Punkte im Radius (out wird geleert) – z. B. für Vault-Erkennung */
  near(x: number, z: number, rKm: number, out: CoverPoint[]): CoverPoint[] {
    out.length = 0;
    const r2 = rKm * rKm;
    this.forCells(x, z, rKm, (p) => {
      if (!p.alive) return;
      const dx = p.x - x, dz = p.z - z;
      if (dx * dx + dz * dz <= r2) out.push(p);
    });
    return out;
  }

  // ------------------------------------------------------------ Verwaltung

  /** Neuen Punkt anlegen (ID aus gemeinsamem Zähler) */
  add(point: Omit<CoverPoint, 'id' | 'alive'>): CoverPoint {
    const p: CoverPoint = { ...point, id: nextCoverId(), alive: true };
    this.insert(p);
    return p;
  }

  /** Fremd erzeugten Punkt (ID vom Absender) unverändert aufnehmen */
  private insert(p: CoverPoint): void {
    if (p.id >= _coverId) _coverId = p.id + 1;
    if (this.points.has(p.id)) this.removeFromGrid(this.points.get(p.id)!);
    p.alive = true;
    this.points.set(p.id, p);
    const k = this.key(p.x, p.z);
    let a = this.grid.get(k);
    if (!a) this.grid.set(k, (a = []));
    a.push(p.id);
  }

  remove(id: number): void {
    const p = this.points.get(id);
    if (!p) return;
    p.alive = false;
    this.removeFromGrid(p);
    this.points.delete(id);
    this.occ.delete(id);
  }

  occupy(id: number, unitId: number, members = 1): void {
    let m = this.occ.get(id);
    if (!m) this.occ.set(id, (m = new Map()));
    m.set(unitId, members);
  }

  release(id: number, unitId: number): void {
    const m = this.occ.get(id);
    if (!m) return;
    m.delete(unitId);
    if (!m.size) this.occ.delete(id);
  }

  /** Belegte Plätze (Soldaten) */
  load(id: number): number {
    const m = this.occ.get(id);
    if (!m) return 0;
    let s = 0;
    for (const v of m.values()) s += v;
    return s;
  }

  update(dt: number): void {
    this.time += dt;
    if (this.tiles.size > MAX_TILES) this.evictTiles();
  }

  // ------------------------------------------------------------ Ereignisse

  private onWreck(x: number, z: number, heading: number): void {
    // Wrack liegt quer zur Fahrtrichtung: zwei Schutzseiten senkrecht zur Längsachse
    const nx = Math.cos(heading), nz = Math.sin(heading);
    for (const s of [1, -1]) {
      const p = this.add({ x, z, dirX: nx * s, dirZ: nz * s, kind: 'wreck', protection: 0.5, posture: 'crouch', capacity: 3, vaultable: false, structureId: 0 });
      this.wreckIds.push(p.id);
    }
    while (this.wreckIds.length > MAX_WRECKS) this.remove(this.wreckIds.shift()!);
  }

  // ------------------------------------------------------------ Gelände

  /** Natürliche Deckung der 1-km-Kachel (tx,tz) erzeugen (gecacht) */
  generateTileCover(tx: number, tz: number): void {
    const key = tz * 8192 + tx;
    const have = this.tiles.get(key);
    if (have) {
      have.used = this.time;
      return;
    }
    const ids: number[] = [];
    this.tiles.set(key, { ids, used: this.time });
    const g = this.geo;
    const x0 = tx * TILE, z0 = tz * TILE;
    if (!g.inside(x0, z0) || !g.inside(x0 + TILE, z0 + TILE)) return;
    const land = (x: number, z: number) => g.heightAt(x, z) > 0.0005 && !this.isWater(x, z);
    if (!land(x0 + 0.5, z0 + 0.5)) return;

    const N = 8, step = TILE / N;
    const eps = 0.06;
    type Cand = { x: number; z: number; dx: number; dz: number; prot: number; w: number; two: boolean };
    const cands: Cand[] = [];
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = x0 + (i + 0.5) * step, z = z0 + (j + 0.5) * step;
        if (!land(x, z)) continue;
        const gx = (g.heightAt(x + eps, z) - g.heightAt(x - eps, z)) / (2 * eps);
        const gz = (g.heightAt(x, z + eps) - g.heightAt(x, z - eps)) / (2 * eps);
        const slope = Math.hypot(gx, gz);
        // Mulde: Mittelwert der Nachbarn über der Mitte
        const lap = (g.heightAt(x + 0.1, z) + g.heightAt(x - 0.1, z) + g.heightAt(x, z + 0.1) + g.heightAt(x, z - 0.1)) / 4 - g.heightAt(x, z);
        if (lap > 0.00015 && slope > 1e-5) {
          cands.push({ x, z, dx: gx / slope, dz: gz / slope, prot: 0.45, w: 2 + lap * 1000, two: true });
        } else if (slope > SLOPE_MIN) {
          cands.push({ x, z, dx: gx / slope, dz: gz / slope, prot: Math.min(0.5, 0.3 + slope * 4), w: slope, two: false });
        }
        // Flussufer: Wasser in der Nähe -> Böschung zum Wasser hin
        for (const [ax, az] of BANK_DIRS) {
          if (this.isRiver(x + ax * 0.2, z + az * 0.2)) {
            cands.push({ x, z, dx: ax, dz: az, prot: 0.4, w: 1.5, two: false });
            break;
          }
        }
      }
    }
    cands.sort((a, b) => b.w - a.w);
    const chosen: Cand[] = [];
    for (const c of cands) {
      if (chosen.length >= MAX_TERRAIN_PER_TILE) break;
      if (chosen.some((o) => (o.x - c.x) ** 2 + (o.z - c.z) ** 2 < 0.12 * 0.12)) continue;
      chosen.push(c);
    }
    // Kleine Bodenwellen (Mikrorelief), damit auch flaches Land etwas Deckung bietet
    for (let k = 0; k < HUMMOCKS_PER_TILE; k++) {
      const x = x0 + hash(tx, tz, k * 3 + 1) * TILE, z = z0 + hash(tx, tz, k * 3 + 2) * TILE;
      if (!land(x, z)) continue;
      const a = hash(tx, tz, k * 3 + 3) * Math.PI * 2;
      chosen.push({ x, z, dx: Math.cos(a), dz: Math.sin(a), prot: 0.3, w: 0, two: false });
    }
    for (const c of chosen) {
      const dirs: Array<[number, number]> = c.two ? [[c.dx, c.dz], [-c.dx, -c.dz]] : [[c.dx, c.dz]];
      for (const [dx, dz] of dirs) {
        const p = this.add({ x: c.x, z: c.z, dirX: dx, dirZ: dz, kind: 'terrain', protection: c.prot, posture: 'prone', capacity: 4, vaultable: false, structureId: 0 });
        ids.push(p.id);
      }
    }
  }

  private ensureTiles(x: number, z: number, r: number): void {
    const ax = Math.floor((x - r) / TILE), bx = Math.floor((x + r) / TILE);
    const az = Math.floor((z - r) / TILE), bz = Math.floor((z + r) / TILE);
    for (let tz = az; tz <= bz; tz++) for (let tx = ax; tx <= bx; tx++) this.generateTileCover(tx, tz);
  }

  private evictTiles(): void {
    const arr = [...this.tiles.entries()].sort((a, b) => a[1].used - b[1].used);
    const drop = arr.length - Math.floor(MAX_TILES * 0.8);
    for (let i = 0; i < drop; i++) {
      const [k, t] = arr[i];
      // Besetzte Kacheln behalten
      if (t.ids.some((id) => this.occ.has(id))) {
        t.used = this.time;
        continue;
      }
      for (const id of t.ids) this.remove(id);
      this.tiles.delete(k);
    }
  }

  private isWater(x: number, z: number): boolean {
    const g = this.geo;
    const i = Math.floor(x / g.cellKm), j = Math.floor(z / g.cellKm);
    if (i < 0 || j < 0 || i >= g.width || j >= g.height) return true;
    return g.waterFlags[j * g.width + i] !== 0;
  }

  private isRiver(x: number, z: number): boolean {
    return this.isWater(x, z);
  }

  // ------------------------------------------------------------ Grid

  private key(x: number, z: number): number {
    return Math.floor(z / CELL) * 65536 + Math.floor(x / CELL);
  }

  private removeFromGrid(p: CoverPoint): void {
    const k = this.key(p.x, p.z);
    const a = this.grid.get(k);
    if (!a) return;
    const i = a.indexOf(p.id);
    if (i >= 0) a.splice(i, 1);
    if (!a.length) this.grid.delete(k);
  }

  private forCells(x: number, z: number, r: number, fn: (p: CoverPoint) => void): void {
    const cx0 = Math.floor((x - r) / CELL), cx1 = Math.floor((x + r) / CELL);
    const cz0 = Math.floor((z - r) / CELL), cz1 = Math.floor((z + r) / CELL);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const a = this.grid.get(cz * 65536 + cx);
        if (!a) continue;
        for (let i = 0; i < a.length; i++) {
          const p = this.points.get(a[i]);
          if (p) fn(p);
        }
      }
    }
  }
}

const BANK_DIRS: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** Deterministischer Hash -> [0,1) */
function hash(a: number, b: number, c: number): number {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
