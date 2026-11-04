/**
 * Routenbewusste Planung: gecachte Straßenentfernungen (Pathfinder), Konvoi-Routen und Brücken auf Routen.
 * Pro Takt begrenzte Anzahl echter Routenberechnungen; darüber hinaus Schätzung (Luftlinie * 1.35).
 */
import type { NavGraph } from '../nav/NavGraph';
import type { MobilityProfile, Route } from '../nav/types';
import { ROAD_CLASSES } from '../nav/types';
import type { Pathfinder } from '../nav/Pathfinder';
import { getUnitType } from '../units/unitTypes';

interface Entry { route: Route | null; km: number; t: number; ver: number }

export interface Profiles {
  heavy: MobilityProfile;
  foot: MobilityProfile;
  truck: MobilityProfile;
}

export class Planner {
  readonly prof: Profiles;
  /** Verbleibendes Routenbudget des aktuellen Takts */
  budget = 4;
  private readonly cache = new Map<number, Entry>();
  private readonly rect: number[] = [];
  private readonly seen = new Set<number>();
  private time = 0;

  constructor(private readonly pf: Pathfinder, private readonly graph: NavGraph) {
    this.prof = {
      heavy: getUnitType('mbt_medium')!.mobility,
      foot: getUnitType('inf_squad')!.mobility,
      truck: getUnitType('tanker_truck')!.mobility,
    };
  }

  tick(now: number, budget: number): void {
    this.time = now;
    this.budget = budget;
    if (this.cache.size > 600) this.cache.clear();
  }

  private key(fx: number, fz: number, tx: number, tz: number, p: MobilityProfile): number {
    const c = (v: number) => Math.round(v / 1.5) & 0x1ff;
    const pk = p === this.prof.foot ? 1 : p === this.prof.truck ? 2 : 0;
    return (((c(fx) * 512 + c(fz)) * 512 + c(tx)) * 512 + c(tz)) * 4 + pk;
  }

  /** Route (gecacht, TTL 4 h, ungültig bei Änderung am Straßennetz); null = unerreichbar ODER Budget leer (siehe km) */
  route(fx: number, fz: number, tx: number, tz: number, p: MobilityProfile = this.prof.heavy): Route | null {
    const k = this.key(fx, fz, tx, tz, p);
    const e = this.cache.get(k);
    if (e && e.ver === this.graph.version && this.time - e.t < 4) return e.route;
    if (this.budget <= 0) return null;
    this.budget--;
    const r = this.pf.findRoute(fx, fz, tx, tz, p);
    this.cache.set(k, { route: r, km: r ? r.lengthKm : Infinity, t: this.time, ver: this.graph.version });
    return r;
  }

  /** Straßenentfernung in km: Infinity = unerreichbar, sonst Route oder Schätzung */
  roadKm(fx: number, fz: number, tx: number, tz: number, p: MobilityProfile = this.prof.heavy): number {
    const k = this.key(fx, fz, tx, tz, p);
    const e = this.cache.get(k);
    if (e && e.ver === this.graph.version && this.time - e.t < 4) return e.km;
    if (this.budget > 0) { this.route(fx, fz, tx, tz, p); return this.cache.get(k)!.km; }
    return Math.hypot(tx - fx, tz - fz) * 1.35;
  }

  /** Fahrzeit (h) – wie roadKm, aber über die ETA der Route (Schätzung 40 km/h) */
  etaHours(fx: number, fz: number, tx: number, tz: number, p: MobilityProfile = this.prof.heavy): number {
    const k = this.key(fx, fz, tx, tz, p);
    const r = this.route(fx, fz, tx, tz, p);
    if (r) return r.etaHours;
    const e = this.cache.get(k);
    if (e && e.km === Infinity) return Infinity;
    return (Math.hypot(tx - fx, tz - fz) * 1.35) / (p === this.prof.foot ? 5 : 40);
  }

  /** Brücken (Kanten-IDs), über die eine Route führt (Straßenklasse muss zur Kante passen) */
  bridgesOnRoute(r: Route, out: number[] = []): number[] {
    out.length = 0;
    this.seen.clear();
    const pts = r.points;
    let acc = 0;
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const sx = pts[i], sz = pts[i + 1], ex = pts[i + 2], ez = pts[i + 3];
      const seg = Math.hypot(ex - sx, ez - sz);
      const cls = r.segClass[i / 2];
      if (cls === 255) { acc = 0; continue; }
      acc += seg;
      if (acc < 0.15 && i > 0) continue;
      acc = 0;
      const rect = this.graph.edgesInRect(Math.min(sx, ex) - 0.06, Math.min(sz, ez) - 0.06, Math.max(sx, ex) + 0.06, Math.max(sz, ez) + 0.06, this.rect);
      for (const id of rect) {
        if (this.seen.has(id)) continue;
        const e = this.graph.edges[id];
        if (!e.bridge || e.cls === 'ferry') continue;
        if (ROAD_CLASSES.indexOf(e.cls) !== cls) continue;
        this.seen.add(id);
        out.push(id);
      }
    }
    return out;
  }

  /** Kürzester Abstand (km) eines Punktes zur Route */
  distToRoute(r: Route, x: number, z: number): number {
    const p = r.points;
    let best = Infinity;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const ax = p[i], az = p[i + 1], bx = p[i + 2], bz = p[i + 3];
      const dx = bx - ax, dz = bz - az;
      const l2 = dx * dx + dz * dz;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
      const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
      if (d < best) best = d;
    }
    return best;
  }
}
