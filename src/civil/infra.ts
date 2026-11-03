import type { GeoData } from '../world/GeoData';
import type { CityMeta } from '../core/types';
import { WATER_LAKE, WATER_RIVER } from '../core/types';
import type { InfraInfo, InfraKind } from './types';

/** Stadtradius (km) – MUSS der Bebauungslogik in src/world/Cities.ts entsprechen (generateCity). */
export function cityRadiusKm(pop: number, capital: boolean): number {
  const popM = Math.max(0.02, pop / 1e6);
  return Math.min(15, 1.5 + Math.sqrt(popM) * 3.2 + (capital ? 0.6 : 0));
}

/** Deterministischer RNG (mulberry32, Seed aus String) */
export function rngFrom(name: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Grundflächen der Modelle in km (Breite × Tiefe, 20–150 m) – passend zu CivilModels */
export const INFRA_SIZE: Record<InfraKind, { w: number; d: number }> = {
  hospital: { w: 0.092, d: 0.066 },
  school: { w: 0.118, d: 0.052 },
  power_plant: { w: 0.15, d: 0.12 },
  water_works: { w: 0.072, d: 0.062 },
  port: { w: 0.15, d: 0.1 },
  airport: { w: 0.15, d: 0.044 },
  rail_station: { w: 0.15, d: 0.044 },
  town_hall: { w: 0.072, d: 0.05 },
  church: { w: 0.034, d: 0.056 },
};

export const PROTECTED_KINDS: ReadonlySet<InfraKind> = new Set<InfraKind>(['hospital', 'school', 'water_works', 'power_plant', 'port']);

/** Minimale Schnittstelle zur Gebäudeverwaltung (Cities) */
export interface BuildingQuery {
  findBuildingAt(x: number, z: number, maxKm: number): unknown | null;
}

export interface GeneratedInfra {
  infra: InfraInfo[];
  /** Gierwinkel (rad) je Infra-Eintrag (Modell-+Z zeigt (sin yaw, cos yaw)) */
  yaw: number[];
}

/** Zähl-Regeln (Tabelle für Bericht/Tests) */
export function infraCounts(pop: number, seaNear: boolean): Record<InfraKind, number> {
  const popM = pop / 1e6;
  return {
    hospital: Math.max(1, Math.min(12, Math.round(pop / 500_000))),
    school: Math.max(2, Math.min(14, Math.round(pop / 350_000) + 1)),
    power_plant: pop >= 700_000 ? Math.min(3, Math.floor(pop / 3_000_000) + 1) : 0,
    water_works: pop >= 3_000_000 ? 2 : 1,
    port: seaNear ? 1 : 0,
    airport: 0,
    rail_station: pop >= 3_000_000 ? 2 : 1,
    town_hall: 1,
    church: Math.max(1, Math.min(6, 1 + Math.round(popM * 1.2))),
  };
}

function cellAt(geo: GeoData, x: number, z: number): number {
  const i = Math.floor(x / geo.cellKm), j = Math.floor(z / geo.cellKm);
  if (i < 0 || j < 0 || i >= geo.width || j >= geo.height) return -1;
  return j * geo.width + i;
}

/** Wasserzelle (Fluss/See) an Position, oder außerhalb der Karte */
export function isWaterCell(geo: GeoData, x: number, z: number): boolean {
  const k = cellAt(geo, x, z);
  return k < 0 || geo.waterFlags[k] !== 0;
}

/** Irgendeine Fluss-/Seezelle im Umkreis von n Zellen (nur Fluss/See, nicht Meer) */
function waterWithin(geo: GeoData, x: number, z: number, n: number): boolean {
  const i0 = Math.floor(x / geo.cellKm), j0 = Math.floor(z / geo.cellKm);
  for (let j = j0 - n; j <= j0 + n; j++)
    for (let i = i0 - n; i <= i0 + n; i++) {
      if (i < 0 || j < 0 || i >= geo.width || j >= geo.height) continue;
      if (geo.waterFlags[j * geo.width + i] & (WATER_LAKE | WATER_RIVER)) return true;
    }
  return false;
}

function landOk(geo: GeoData, x: number, z: number, hw: number): boolean {
  const pts: Array<[number, number]> = [[0, 0], [hw, hw], [-hw, hw], [hw, -hw], [-hw, -hw]];
  for (const [dx, dz] of pts) {
    const px = x + dx, pz = z + dz;
    if (geo.countryAt(px, pz) === 0 || isWaterCell(geo, px, pz) || geo.heightAt(px, pz) <= 0.002) return false;
  }
  return true;
}

/** Entfernung (km) bis zum Meer in der besten Richtung (maxKm), samt Richtung; null wenn keine See in Reichweite. */
export function seaProbe(geo: GeoData, cx: number, cz: number, maxKm = 15): { dist: number; dx: number; dz: number } | null {
  let best: { dist: number; dx: number; dz: number } | null = null;
  for (let a = 0; a < 24; a++) {
    const ang = (a / 24) * Math.PI * 2;
    const dx = Math.sin(ang), dz = Math.cos(ang);
    for (let r = 0.5; r <= maxKm; r += 0.5) {
      const px = cx + dx * r, pz = cz + dz * r;
      if (!geo.inside(px, pz)) break;
      if (geo.countryAt(px, pz) === 0) {
        if (!best || r < best.dist) best = { dist: r, dx, dz };
        break;
      }
    }
  }
  return best;
}

/**
 * Deterministische Platzierung der Infrastruktur aller Städte (Seed = Stadtname).
 * buildings: Gebäuderegister (Cities) – nichts wird auf Gebäude gesetzt; findet sich kein freier Platz im Stadtgebiet,
 * wird knapp außerhalb des Stadtradius gesucht.
 */
export function generateInfra(geo: GeoData, metaCities: CityMeta[], buildings: BuildingQuery): GeneratedInfra {
  const infra: InfraInfo[] = [];
  const yaw: number[] = [];

  metaCities.forEach((c, cityId) => {
    const rnd = rngFrom(c.name + ':infra');
    const R = cityRadiusKm(c.pop, c.capital);
    const cx = c.pos[0], cz = c.pos[1];
    const mine: InfraInfo[] = [];
    const sea = seaProbe(geo, cx, cz, 15);
    const counts = infraCounts(c.pop, sea !== null);

    const free = (x: number, z: number, size: { w: number; d: number }, checkBuildings: boolean): boolean => {
      const hw = Math.max(size.w, size.d) * 0.5;
      if (!landOk(geo, x, z, hw)) return false;
      if (checkBuildings && buildings.findBuildingAt(x, z, hw + 0.03)) return false;
      for (const o of mine) {
        const m = (Math.max(o.w, o.d) + Math.max(size.w, size.d)) * 0.5 + 0.02;
        if (Math.abs(o.x - x) < m && Math.abs(o.z - z) < m) return false;
      }
      return true;
    };

    const add = (kind: InfraKind, x: number, z: number, yw: number): void => {
      const s = INFRA_SIZE[kind];
      const it: InfraInfo = { id: infra.length, kind, cityId, x, z, w: s.w, d: s.d, integrity: 1, protectedStatus: PROTECTED_KINDS.has(kind) };
      infra.push(it);
      mine.push(it);
      yaw.push(yw);
    };

    /** Zufallssuche im Ring [r0,r1]·R; zuletzt knapp außerhalb des Radius */
    const place = (kind: InfraKind, r0: number, r1: number, score?: (x: number, z: number) => number): void => {
      const size = INFRA_SIZE[kind];
      let best: { x: number; z: number; s: number } | null = null;
      const tries = score ? 70 : 50;
      for (let t = 0; t < tries; t++) {
        const r = R * (r0 + (r1 - r0) * rnd());
        const a = rnd() * Math.PI * 2;
        const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
        if (!free(x, z, size, true)) continue;
        const sc = score ? score(x, z) : 0;
        if (!best || sc > best.s) best = { x, z, s: sc };
        if (!score) break;
      }
      if (!best) {
        // außerhalb des Stadtgebiets
        for (let t = 0; t < 120 && !best; t++) {
          const r = R * (1.05 + 0.5 * rnd() + t * 0.01);
          const a = rnd() * Math.PI * 2;
          const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
          if (free(x, z, size, false)) best = { x, z, s: 0 };
        }
      }
      if (!best) return; // Meer/Berge ringsum – Infra entfällt (selten)
      add(kind, best.x, best.z, rnd() * Math.PI * 2);
    };

    // Rathaus im Zentrum
    place('town_hall', 0.0, 0.12);
    for (let i = 0; i < counts.rail_station; i++) place('rail_station', 0.12 + i * 0.25, 0.4 + i * 0.3);
    for (let i = 0; i < counts.hospital; i++) place('hospital', 0.12, 0.85);
    for (let i = 0; i < counts.school; i++) place('school', 0.2, 0.95);
    for (let i = 0; i < counts.church; i++) place('church', 0.08, 0.75);
    for (let i = 0; i < counts.water_works; i++)
      place('water_works', 0.7, 1.15, (x, z) => (waterWithin(geo, x, z, 2) ? 2 : 0) + (1 - Math.hypot(x - cx, z - cz) / (R * 1.3)));
    for (let i = 0; i < counts.power_plant; i++) place('power_plant', 0.95, 1.4);

    if (sea) {
      // Hafen an der Küste in Richtung Meer
      const size = INFRA_SIZE.port;
      const yw = Math.atan2(sea.dx, sea.dz);
      let done = false;
      for (let t = 0; t < 40 && !done; t++) {
        const back = 0.5 + t * 0.15;
        const jit = ((t % 5) - 2) * 0.12 * (1 + t / 10);
        const px = cx + sea.dx * (sea.dist - back) - sea.dz * jit;
        const pz = cz + sea.dz * (sea.dist - back) + sea.dx * jit;
        if (free(px, pz, size, Math.hypot(px - cx, pz - cz) < R * 1.02)) {
          add('port', px, pz, yw);
          done = true;
        }
      }
    }
  });
  return { infra, yaw };
}
