/**
 * Phase 3 – Bauwerke, Gebäudebesetzung, Pioniertätigkeit und Brückensprengung.
 *
 * Aufträge werden über die order*-Methoden erteilt (Steuerungsebene ruft sie auf). Der Manager lässt die Einheiten
 * über units.issueMove laufen, markiert deren orders[0] zur Anzeige (kind 'build' | 'demolish' | 'repair' | 'garrison')
 * und führt den Auftrag in update() aus (Baufortschritt, Sprengung, Besetzung, Minen).
 *
 * Rendering: ein InstancedMesh aus Boxen für alle Bauwerke (strategischer Sichtmaßstab wie UnitRenderer: Querschnitts-
 * maße wachsen mit dem Kameraabstand, Längen bleiben wahr), in der Fernsicht kleine Punktsymbole.
 * Der Maßstab wird per onBeforeRender mit der echten Kamera berechnet – kein extra Verdrahten nötig.
 */
import * as THREE from 'three';
import { bus } from '../core/EventBus';
import type { Settings } from '../core/types';
import type { CoverKind, CoverPoint, Posture, StructureInfo, StructureKind, WarQuery } from '../combat/types';
import type { NavGraph } from '../nav/NavGraph';
import { nextCoverId } from '../tactics/CoverSystem';
import type { Unit } from '../units/types';
import type { UnitManager } from '../units/UnitManager';
import type { Cities } from '../world/Cities';
import type { GeoData } from '../world/GeoData';
import { distToPolyline, headingToDir, isBuildable, pointAlong, polylineLength, sampleLine } from './BuildTool';

// ------------------------------------------------------------------ Definitionen

export interface StructureDef {
  kind: StructureKind;
  /** Deutscher Name */
  name: string;
  /** true = Polylinie (Wand/Graben/Linie), false = Einzelpunkt */
  line: boolean;
  /** Arbeitsaufwand in Mann-Stunden: base + perKm × Länge. Fortschritt/h = Arbeiter / Mann-Stunden */
  manHours: number;
  manHoursPerKm: number;
  /** Trefferpunkte: base + perKm × Länge (Minenfeld: Anzahl Minen) */
  hp: number;
  hpPerKm: number;
  /** Kosten in Mio $ (nicht automatisch abgebucht): base + perKm × Länge */
  cost: number;
  costPerKm: number;
  /** Deckung (0 protection = keine CoverPoints) */
  cover: CoverKind | null;
  protection: number;
  posture: Posture;
  vaultable: boolean;
  /** Plätze (Soldaten) je Deckungspunkt */
  coverCap: number;
  /** Abstand der Deckungspunkte entlang von Linien (km) */
  coverSpacing: number;
}

export const STRUCTURE_DEFS: Record<StructureKind, StructureDef> = {
  sandbags: { kind: 'sandbags', name: 'Sandsackwall', line: true, manHours: 3, manHoursPerKm: 260, hp: 40, hpPerKm: 700, cost: 0.01, costPerKm: 0.3, cover: 'sandbag', protection: 0.6, posture: 'crouch', vaultable: true, coverCap: 2, coverSpacing: 0.012 },
  tank_trap: { kind: 'tank_trap', name: 'Panzersperre (Igel)', line: true, manHours: 5, manHoursPerKm: 420, hp: 300, hpPerKm: 3000, cost: 0.02, costPerKm: 0.8, cover: null, protection: 0, posture: 'stand', vaultable: false, coverCap: 0, coverSpacing: 0 },
  barbed_wire: { kind: 'barbed_wire', name: 'Stacheldraht', line: true, manHours: 2, manHoursPerKm: 150, hp: 50, hpPerKm: 400, cost: 0.005, costPerKm: 0.15, cover: null, protection: 0, posture: 'stand', vaultable: false, coverCap: 0, coverSpacing: 0 },
  trench: { kind: 'trench', name: 'Schützengraben', line: true, manHours: 8, manHoursPerKm: 1300, hp: 150, hpPerKm: 1800, cost: 0.02, costPerKm: 0.5, cover: 'trench', protection: 0.8, posture: 'crouch', vaultable: false, coverCap: 2, coverSpacing: 0.014 },
  bunker: { kind: 'bunker', name: 'Bunker', line: false, manHours: 150, manHoursPerKm: 0, hp: 1600, hpPerKm: 0, cost: 0.4, costPerKm: 0, cover: 'bunker', protection: 0.92, posture: 'crouch', vaultable: false, coverCap: 3, coverSpacing: 0 },
  mg_nest: { kind: 'mg_nest', name: 'MG-Nest', line: false, manHours: 24, manHoursPerKm: 0, hp: 320, hpPerKm: 0, cost: 0.05, costPerKm: 0, cover: 'sandbag', protection: 0.7, posture: 'crouch', vaultable: false, coverCap: 1, coverSpacing: 0 },
  mortar_pit: { kind: 'mortar_pit', name: 'Mörserstellung', line: false, manHours: 20, manHoursPerKm: 0, hp: 260, hpPerKm: 0, cost: 0.04, costPerKm: 0, cover: 'sandbag', protection: 0.7, posture: 'crouch', vaultable: false, coverCap: 1, coverSpacing: 0 },
  at_position: { kind: 'at_position', name: 'Panzerabwehrstellung', line: false, manHours: 22, manHoursPerKm: 0, hp: 280, hpPerKm: 0, cost: 0.05, costPerKm: 0, cover: 'sandbag', protection: 0.72, posture: 'crouch', vaultable: false, coverCap: 1, coverSpacing: 0 },
  foxhole: { kind: 'foxhole', name: 'Schützenloch', line: false, manHours: 5, manHoursPerKm: 0, hp: 90, hpPerKm: 0, cost: 0.005, costPerKm: 0, cover: 'trench', protection: 0.75, posture: 'prone', vaultable: false, coverCap: 2, coverSpacing: 0 },
  minefield: { kind: 'minefield', name: 'Minenfeld', line: true, manHours: 6, manHoursPerKm: 500, hp: 10, hpPerKm: 160, cost: 0.03, costPerKm: 1.2, cover: null, protection: 0, posture: 'stand', vaultable: false, coverCap: 0, coverSpacing: 0 },
  roadblock: { kind: 'roadblock', name: 'Straßensperre', line: true, manHours: 10, manHoursPerKm: 0, hp: 600, hpPerKm: 0, cost: 0.03, costPerKm: 0, cover: null, protection: 0, posture: 'stand', vaultable: false, coverCap: 0, coverSpacing: 0 },
};

/** Minenfeld-Halbbreite (km) */
const MINE_HALF_WIDTH = 0.022;
/** Straßensperre: halbe Breite quer zur Straße (km) */
const ROADBLOCK_HALF = 0.014;
/** Max. Abstand (km) der Straße zum Klickpunkt für Straßensperren */
const ROADBLOCK_SNAP = 0.4;
/** Pioniere "arbeiten", wenn sie so nah an der Arbeitsfront sind (km) */
const WORK_RANGE = 0.09;
const BRIDGE_WORK_RANGE = 0.16;
/** Rückzugsdistanz nach Sprengladungs-Platzierung (km) und Zündverzögerung (Spielstunden) */
const RETREAT_KM = 0.2;
const FUSE_HOURS = 0.02;
/** Garnison: Schutzwert/Sichtbonus (von CombatSystem zu lesen, siehe garrisonCover) */
export const GARRISON_PROTECTION = 0.7;
export const GARRISON_SIGHT_MULT = 1.25;

/** Arbeitsaufwand (Mann-Stunden) für ein Bauwerk */
export function structureManHours(kind: StructureKind, points: number[]): number {
  const d = STRUCTURE_DEFS[kind];
  return d.manHours + d.manHoursPerKm * (d.line ? polylineLength(points) : 0);
}
/** Geschätzte Bauzeit in Spielstunden bei n Arbeitern */
export function structureBuildHours(kind: StructureKind, points: number[], workers: number): number {
  return structureManHours(kind, points) / Math.max(1, workers);
}
export function structureCost(kind: StructureKind, points: number[]): number {
  const d = STRUCTURE_DEFS[kind];
  return d.cost + d.costPerKm * (d.line ? polylineLength(points) : 0);
}

/** Sprengradius um die Mitte der Brücke (km) */
function blastRadius(lengthKm: number): number {
  return Math.max(0.2, Math.min(lengthKm / 2, 0.35));
}

/** Trefferpunkte einer Brücke je Klasse (für damageBridge) */
const BRIDGE_HP: Record<string, number> = { motorway: 160, primary: 140, secondary: 120, road: 100, track: 70, rail: 140, ferry: 100 };

// ------------------------------------------------------------------ Teile (Rendering)

const STRIDE = 13;
const F_SL = 1; // Länge skaliert mit Sichtmaßstab
const F_SW = 2; // Breite skaliert
const F_SH = 4; // Höhe skaliert
const F_RISE = 8; // Höhe wächst mit Baufortschritt
const F_STD = F_SW | F_SH;
const F_ALL = F_SL | F_SW | F_SH;

const COL = {
  sand: [0xb59f6b, 0xa8935f, 0xbfa874, 0xae9a66],
  earth: 0x6b5a3c,
  ditch: 0x2c2217,
  wood: 0xa57f45,
  concrete: 0x8e8c85,
  dark: 0x1a1a1a,
  steel: 0x565b60,
  wire: 0x3f3f3f,
  mine: 0x7a3b2b,
  mineBand: 0x8b7a52,
  stake: 0xd9622a,
};

/**
 * Geländehöhe (km) der *gerenderten* Oberfläche für aufgesetzte Teile. Das Gelände-Mesh hat seine Eckpunkte an den
 * Zellecken (Mittel der 4 Zellmitten-Höhen, 2-km-Dreiecke) und weicht daher von geo.heightAt (bilinear zwischen
 * Zellmitten) ab. Wir interpolieren die Eckwerte bilinear und addieren einen Anteil der Verwindung als Reserve.
 */
function surfaceKm(geo: GeoData, x: number, z: number): number {
  const w = geo.width, hgt = geo.height, a = geo.heightsKm;
  const gx = x / geo.cellKm, gz = z / geo.cellKm;
  const i0 = Math.floor(gx), j0 = Math.floor(gz);
  const fx = gx - i0, fz = gz - j0;
  const cell = (i: number, j: number) => a[Math.max(0, Math.min(hgt - 1, j)) * w + Math.max(0, Math.min(w - 1, i))];
  const corner = (i: number, j: number) => (cell(i - 1, j - 1) + cell(i, j - 1) + cell(i - 1, j) + cell(i, j)) * 0.25;
  const c00 = corner(i0, j0), c10 = corner(i0 + 1, j0), c01 = corner(i0, j0 + 1), c11 = corner(i0 + 1, j0 + 1);
  const h = (c00 * (1 - fx) + c10 * fx) * (1 - fz) + (c01 * (1 - fx) + c11 * fx) * fz;
  const twist = Math.abs(c00 - c10 - c01 + c11);
  return Math.max(0, h + twist * 0.3);
}

class PieceBuf {
  readonly data: number[] = [];
  constructor(private readonly geo: GeoData) {}
  add(x: number, z: number, ry: number, rx: number, rz: number, L: number, W: number, H: number, y0: number, color: number, flags: number, u: number): void {
    this.data.push(x, z, ry, rx, rz, L, W, H, y0, color, flags, u, surfaceKm(this.geo, x, z));
  }
  get count(): number {
    return this.data.length / STRIDE;
  }
}

const yawOf = (dx: number, dz: number) => Math.atan2(-dz, dx);

/** Pieces für ein Bauwerk. (fx,fz) = Richtung zum Feind. */
function generatePieces(geo: GeoData, kind: StructureKind, pts: number[], fx: number, fz: number, seed: number): PieceBuf {
  const b = new PieceBuf(geo);
  const rnd = (() => { let a = (seed * 2654435761) >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();
  const sand = () => COL.sand[Math.floor(rnd() * COL.sand.length)];
  const cx = pts[0], cz = pts[1];
  const fyaw = yawOf(fx, fz);
  // Quer zur Blickrichtung
  const px = -fz, pz = fx;
  const pyaw = yawOf(px, pz);

  const ring = (r: number, n: number, gapAngle: number, W: number, H: number, color: () => number): void => {
    // Winkel 0 = Richtung (fx,fz); Lücke hinten (um π) mit Breite gapAngle
    for (let k = 0; k < n; k++) {
      const rel = -Math.PI + ((k + 0.5) / n) * Math.PI * 2; // relativ zu hinten (±π = vorne)
      if (Math.abs(rel) < gapAngle * 0.5) continue; // Lücke hinten (rel≈0)
      // Position: hinten = -f; rel=0 hinten, rel=±π vorne
      const dirx = -fx * Math.cos(rel) + px * Math.sin(rel), dirz = -fz * Math.cos(rel) + pz * Math.sin(rel);
      const x = cx + dirx * r, z = cz + dirz * r;
      const tx = -dirz, tz = dirx;
      const chord = (2 * Math.PI * r) / n * 1.12;
      b.add(x, z, yawOf(tx, tz), 0, 0, chord, W, H, H / 2, color(), F_ALL | F_RISE, 0);
    }
  };

  switch (kind) {
    case 'sandbags': {
      const s = sampleLine(pts, 0.008);
      const n = s.length / 2 - 1;
      for (let k = 0; k < n; k++) {
        const ax = s[k * 2], az = s[k * 2 + 1], bx = s[k * 2 + 2], bz = s[k * 2 + 3];
        const len = Math.hypot(bx - ax, bz - az) || 0.008;
        const yaw = yawOf(bx - ax, bz - az), u = n > 1 ? k / (n - 1) : 0;
        b.add((ax + bx) / 2, (az + bz) / 2, yaw, 0, 0, len * 1.05, 0.0010, 0.0007, 0.00035, sand(), F_STD, u);
        b.add((ax + bx) / 2, (az + bz) / 2, yaw, 0, 0, len * 0.88, 0.0007, 0.0006, 0.0010, sand(), F_STD, u);
      }
      break;
    }
    case 'tank_trap':
    case 'roadblock': {
      const s = sampleLine(pts, kind === 'roadblock' ? 0.008 : 0.010);
      const n = s.length / 2;
      for (let k = 0; k < n; k++) {
        const x = s[k * 2], z = s[k * 2 + 1], u = n > 1 ? k / (n - 1) : 0;
        const th = rnd() * 3;
        for (let q = 0; q < 3; q++) b.add(x, z, th + q * 2.094, 0, 0.9, 0.0018, 0.0003, 0.0003, 0.0006, COL.steel, F_ALL, u);
        b.add(x, z, th, 0, Math.PI / 2, 0.0014, 0.0003, 0.0003, 0.0007, COL.steel, F_ALL, u);
      }
      if (kind === 'roadblock') {
        // Sandsack-Blöcke an den Enden
        for (const e of [0, n - 1]) b.add(s[e * 2], s[e * 2 + 1], yawOf(px, pz), 0, 0, 0.004, 0.0016, 0.0012, 0.0006, sand(), F_ALL, e === 0 ? 0 : 1);
      }
      break;
    }
    case 'barbed_wire': {
      const s = sampleLine(pts, 0.008);
      const n = s.length / 2;
      for (let k = 0; k < n; k++) {
        const x = s[k * 2], z = s[k * 2 + 1], u = n > 1 ? k / (n - 1) : 0;
        b.add(x, z, 0, 0, 0, 0.00018, 0.00018, 0.0014, 0.0007, COL.wood, F_STD, u);
        if (k + 1 < n) {
          const bx = s[k * 2 + 2], bz = s[k * 2 + 3], len = Math.hypot(bx - x, bz - z) || 0.008, yaw = yawOf(bx - x, bz - z);
          const mx = (x + bx) / 2, mz = (z + bz) / 2;
          b.add(mx, mz, yaw, 0, 0.55, len * 0.62, 0.00025, 0.00025, 0.0006, COL.wire, F_STD, u);
          b.add(mx, mz, yaw, 0, -0.55, len * 0.62, 0.00025, 0.00025, 0.0006, COL.wire, F_STD, u);
          b.add(mx, mz, yaw, 0, 0, len, 0.0003, 0.0003, 0.0012, COL.wire, F_STD, u);
        }
      }
      break;
    }
    case 'trench': {
      const s = sampleLine(pts, 0.012);
      const m = s.length / 2;
      // Zickzack-Versatz, Normale nach Feindseite orientiert
      const P: number[] = [];
      const N: number[] = [];
      for (let k = 0; k < m; k++) {
        const a = Math.max(0, k - 1), c = Math.min(m - 1, k + 1);
        let tx = s[c * 2] - s[a * 2], tz = s[c * 2 + 1] - s[a * 2 + 1];
        const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
        let nx = -tz, nz = tx;
        if (nx * fx + nz * fz < 0) { nx = -nx; nz = -nz; }
        const off = (k % 2 ? 1 : -1) * 0.0022;
        P.push(s[k * 2] + nx * off, s[k * 2 + 1] + nz * off);
        N.push(nx, nz);
      }
      for (let k = 0; k + 1 < m; k++) {
        const ax = P[k * 2], az = P[k * 2 + 1], bx = P[k * 2 + 2], bz = P[k * 2 + 3];
        const len = Math.hypot(bx - ax, bz - az) || 0.012, yaw = yawOf(bx - ax, bz - az);
        const mx = (ax + bx) / 2, mz = (az + bz) / 2, u = m > 2 ? k / (m - 2) : 0;
        const nx = (N[k * 2] + N[k * 2 + 2]) / 2, nz = (N[k * 2 + 1] + N[k * 2 + 3]) / 2;
        b.add(mx, mz, yaw, 0, 0, len * 1.12, 0.0030, 0.0002, 0.0001, COL.ditch, F_STD, u);
        b.add(mx + nx * 0.0027, mz + nz * 0.0027, yaw, 0, 0, len * 1.1, 0.0014, 0.0013, 0.00065, COL.earth, F_STD, u);
        b.add(mx - nx * 0.0025, mz - nz * 0.0025, yaw, 0, 0, len * 1.1, 0.0010, 0.0008, 0.0004, COL.earth, F_STD, u);
        if (k % 2 === 0) b.add(mx + nx * 0.0027, mz + nz * 0.0027, yaw, 0, 0, len * 0.5, 0.0009, 0.0006, 0.0016, sand(), F_STD, u);
      }
      break;
    }
    case 'foxhole': {
      b.add(cx, cz, fyaw, 0, 0, 0.0017, 0.0017, 0.0002, 0.0001, COL.ditch, F_ALL | F_RISE, 0);
      b.add(cx + fx * 0.0014, cz + fz * 0.0014, pyaw, 0, 0, 0.0022, 0.0009, 0.0007, 0.00035, COL.earth, F_ALL | F_RISE, 0);
      b.add(cx + px * 0.0013, cz + pz * 0.0013, fyaw, 0, 0, 0.0016, 0.0006, 0.0005, 0.00025, COL.earth, F_ALL | F_RISE, 0);
      b.add(cx - px * 0.0013, cz - pz * 0.0013, fyaw, 0, 0, 0.0016, 0.0006, 0.0005, 0.00025, COL.earth, F_ALL | F_RISE, 0);
      break;
    }
    case 'mg_nest': {
      b.add(cx, cz, fyaw, 0, 0, 0.0045, 0.0045, 0.0002, 0.0001, COL.ditch, F_ALL | F_RISE, 0);
      ring(0.0032, 9, 1.7, 0.0010, 0.0011, sand);
      b.add(cx + fx * 0.0014, cz + fz * 0.0014, fyaw, 0, 0.1, 0.0028, 0.0002, 0.0002, 0.0012, COL.dark, F_ALL, 0);
      break;
    }
    case 'mortar_pit': {
      b.add(cx, cz, fyaw, 0, 0, 0.0065, 0.0065, 0.0002, 0.0001, COL.ditch, F_ALL | F_RISE, 0);
      ring(0.0042, 11, 0, 0.0010, 0.0010, sand);
      b.add(cx, cz, fyaw, 0, 1.15, 0.0026, 0.0003, 0.0003, 0.0010, COL.steel, F_ALL, 0);
      break;
    }
    case 'at_position': {
      b.add(cx, cz, fyaw, 0, 0, 0.0070, 0.0070, 0.0002, 0.0001, COL.ditch, F_ALL | F_RISE, 0);
      ring(0.0048, 10, 1.9, 0.0011, 0.0012, sand);
      b.add(cx + fx * 0.0007, cz + fz * 0.0007, fyaw, 0, 0.12, 0.0036, 0.0003, 0.0003, 0.0011, COL.steel, F_ALL, 0);
      break;
    }
    case 'bunker': {
      const rise = F_ALL | F_RISE;
      b.add(cx, cz, pyaw, 0, 0, 0.0078, 0.0054, 0.0029, 0.00145, COL.concrete, rise, 0);
      b.add(cx, cz, pyaw, 0, 0, 0.0090, 0.0064, 0.0005, 0.00315, 0x7a7872, rise, 0);
      b.add(cx + fx * 0.0027, cz + fz * 0.0027, pyaw, 0, 0, 0.0032, 0.0007, 0.0007, 0.0019, COL.dark, rise, 0);
      b.add(cx - fx * 0.0036, cz - fz * 0.0036, pyaw, 0, 0, 0.0070, 0.0020, 0.0014, 0.0007, COL.earth, rise, 0);
      break;
    }
    case 'minefield': {
      const len = polylineLength(pts);
      const s = sampleLine(pts, 0.02);
      const n = s.length / 2 - 1;
      for (let k = 0; k < n; k++) {
        const ax = s[k * 2], az = s[k * 2 + 1], bx = s[k * 2 + 2], bz = s[k * 2 + 3];
        const l = Math.hypot(bx - ax, bz - az) || 0.02, yaw = yawOf(bx - ax, bz - az), u = n > 1 ? k / (n - 1) : 0;
        const dx = (bx - ax) / l, dz = (bz - az) / l;
        // Bodenmarkierung: flaches Band (wahre Breite)
        b.add((ax + bx) / 2, (az + bz) / 2, yaw, 0, 0, l * 1.02, MINE_HALF_WIDTH * 2, 0.00025, 0.0001, COL.mineBand, F_SH, u);
        const cnt = Math.max(2, Math.round(l * 140));
        for (let q = 0; q < cnt; q++) {
          const t = rnd() * l, o = (rnd() * 2 - 1) * (MINE_HALF_WIDTH - 0.003);
          b.add(ax + dx * t - dz * o, az + dz * t + dx * o, rnd() * 3, 0, 0, 0.0010, 0.0010, 0.0004, 0.0003, COL.mine, F_ALL, u);
        }
      }
      // Warnpfosten an den Enden
      for (const e of [0, 1]) {
        const x = e === 0 ? pts[0] : pts[pts.length - 2], z = e === 0 ? pts[1] : pts[pts.length - 1];
        b.add(x, z, 0, 0, 0, 0.0003, 0.0003, 0.0030, 0.0015, COL.stake, F_ALL, e);
      }
      void len;
      break;
    }
  }
  return b;
}

// ------------------------------------------------------------------ Laufzeitdaten

interface Rec {
  info: StructureInfo;
  def: StructureDef;
  /** Wirksame Polylinie (Roadblock: quer zur Straße) */
  pts: number[];
  length: number;
  pieces: Float32Array;
  nPieces: number;
  fx: number;
  fz: number;
  cover: number[];
  edgeId: number;
  cx: number;
  cz: number;
  /** Minenfeld: Rest-Minen = hp */
  completed: boolean;
}

interface BuildJob {
  sid: number;
  engineers: Set<number>;
  lastTx: number;
  lastTz: number;
}

type BridgePhase = 'walk' | 'work' | 'retreat' | 'fuse';
interface BridgeJob {
  mode: 'demolish' | 'repair';
  edge: number;
  engineers: Set<number>;
  phase: BridgePhase;
  t: number;
  siteX: number;
  siteZ: number;
  retreatX: number;
  retreatZ: number;
  retreatDist: number;
}

interface GarrisonPending {
  buildingId: number;
}

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _cam = new THREE.Vector3();
const _dir = new THREE.Vector3();

const SCALE_K = 6;
const SCALE_MIN = 2;
const SCALE_MAX = 150;
/** Ab diesem Kameraabstand (km) statt 3D-Teilen Symbole */
const SYMBOL_DIST = 60;
const SYMBOL_MAX_DIST = 4000;
const MAX_INSTANCES = 120000;

export class StructureManager {
  readonly object = new THREE.Group();
  structures = new Map<number, StructureInfo>();

  private readonly geo: GeoData;
  private readonly units: UnitManager;
  private readonly graph: NavGraph;
  private readonly cities: Cities;
  private war: WarQuery | null = null;
  private exag: number;
  private nextId = 1;
  private clock = 0;

  private readonly recs = new Map<number, Rec>();
  private readonly buildJobs = new Map<number, BuildJob>();
  private readonly bridgeJobs = new Map<string, BridgeJob>();
  private readonly bridgeHp = new Map<number, number>();
  private readonly bridgeRepair = new Map<number, number>();
  private readonly bridgeDown = new Set<number>();
  private readonly roadBlocks = new Map<number, Set<number>>();
  /** Unit -> Gebäude (wartend) */
  private readonly pending = new Map<number, GarrisonPending>();
  /** Gebäude -> besetzende Einheiten */
  private readonly garrisons = new Map<number, Set<number>>();
  private readonly garrisonUnits = new Set<number>();
  private mineClock = 0;
  private readonly mineCooldown = new Map<string, number>();
  private readonly tmpUnits: Unit[] = [];

  // Rendering
  private mesh: THREE.InstancedMesh;
  private capacity = 4096;
  private readonly boxGeo = new THREE.BoxGeometry(1, 1, 1);
  private readonly mat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
  private readonly symbols: THREE.Points;
  private symbolsDirty = true;
  private viewDirty = true;
  private viewTimer = 0;
  private lastScale = 0;
  private lastExag = 0;
  private visScale = SCALE_MIN;
  private camDist = 50;

  constructor(geo: GeoData, units: UnitManager, graph: NavGraph, cities: Cities, settings: Settings) {
    this.geo = geo;
    this.units = units;
    this.graph = graph;
    this.cities = cities;
    this.exag = settings.heightExaggeration;
    this.object.name = 'Structures';

    this.mesh = this.makeMesh(this.capacity);
    this.object.add(this.mesh);

    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    sg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(3), 3));
    this.symbols = new THREE.Points(sg, new THREE.PointsMaterial({ size: 5, sizeAttenuation: false, vertexColors: true, fog: false, depthWrite: false }));
    this.symbols.frustumCulled = false;
    this.symbols.renderOrder = 6;
    this.symbols.visible = false;
    this.object.add(this.symbols);

    bus.on('building:destroyed', ({ id }) => this.onBuildingDestroyed(id));
    bus.on('unit:removed', ({ id }) => this.dropUnit(id));
    bus.on('unit:killed', ({ id }) => this.dropUnit(id));
  }

  /** Kriegsstatus für Minenfelder (ohne: jede fremde Einheit ist Feind). */
  setWar(war: WarQuery): void {
    this.war = war;
  }

  applySettings(s: Settings): void {
    this.exag = s.heightExaggeration;
    this.viewDirty = true;
    this.symbolsDirty = true;
  }

  // ================================================================== Aufträge: Bauen

  /**
   * Pioniere bauen ein Bauwerk. points = Polylinie in Welt-km (Punktbauwerke: erster Punkt).
   * facing (optional) = Heading (rad, 0 = Norden) Richtung Feind; sonst: weg vom Schwerpunkt der Pioniere.
   * Rückgabe: Struktur-ID oder -1 (ungültig: kein Pionier, Wasser, bei Straßensperre keine Straße in der Nähe).
   */
  orderBuild(engineerIds: number[], kind: StructureKind, points: number[], owner: string, facing?: number): number {
    const def = STRUCTURE_DEFS[kind];
    if (!def) return -1;
    const engs = this.engineersOf(engineerIds);
    if (!engs.length) { this.toast('Kein Pionier-Trupp ausgewählt', 'warn'); return -1; }
    if (points.length < 2) return -1;
    let pts = def.line ? points.slice() : points.slice(0, 2);
    if (def.line && pts.length < 4) pts = [pts[0], pts[1], pts[0] + 0.03, pts[1]];
    if (!isBuildable(this.geo, pts[0], pts[1])) { this.toast('Hier kann nicht gebaut werden (Wasser/außerhalb)', 'warn'); return -1; }

    // Blickrichtung
    let cxe = 0, cze = 0;
    for (const u of engs) { cxe += u.x; cze += u.z; }
    cxe /= engs.length; cze /= engs.length;
    const mid = pointAlong(pts, polylineLength(pts) / 2);
    let fx: number, fz: number;
    if (facing !== undefined) [fx, fz] = headingToDir(facing);
    else {
      const dx = mid.x - cxe, dz = mid.z - cze, l = Math.hypot(dx, dz);
      if (l > 0.01) { fx = dx / l; fz = dz / l; } else { fx = 0; fz = -1; }
    }

    let edgeId = -1;
    if (kind === 'roadblock') {
      const hit = this.graph.nearestEdgePoint(pts[0], pts[1], ROADBLOCK_SNAP, (e) => e.cls !== 'rail' && e.cls !== 'ferry' && e.cls !== 'track');
      if (!hit) { this.toast('Straßensperre: keine Straße in der Nähe', 'warn'); return -1; }
      edgeId = hit.edge;
      // Tangente an der Trefferstelle
      const t0 = Math.max(0, hit.t - 0.002), t1 = Math.min(1, hit.t + 0.002);
      const a = this.graph.pointOnEdge(edgeId, t0), b = this.graph.pointOnEdge(edgeId, t1);
      let tx = b[0] - a[0], tz = b[1] - a[1];
      const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
      pts = [hit.x - -tz * ROADBLOCK_HALF, hit.z - tx * ROADBLOCK_HALF, hit.x + -tz * ROADBLOCK_HALF, hit.z + tx * ROADBLOCK_HALF];
      fx = tx; fz = tz;
    }

    const id = this.nextId++;
    const length = def.line ? polylineLength(pts) : 0;
    const hpMax = def.kind === 'minefield' ? Math.max(8, Math.round(def.hp + def.hpPerKm * length)) : Math.round(def.hp + def.hpPerKm * length);
    const info: StructureInfo = { id, kind, owner, points: pts, progress: 0, hp: 1, hpMax };
    const pb = generatePieces(this.geo, kind, pts, fx, fz, id);
    const mid2 = pointAlong(pts, length / 2);
    const rec: Rec = { info, def, pts, length, pieces: Float32Array.from(pb.data), nPieces: pb.count, fx, fz, cover: [], edgeId, cx: def.line ? mid2.x : pts[0], cz: def.line ? mid2.z : pts[1], completed: false };
    this.recs.set(id, rec);
    this.structures.set(id, info);
    this.viewDirty = true;
    this.symbolsDirty = true;
    this.assignBuild(engs, rec);
    return id;
  }

  /** Weitere/andere Pioniere an einem unfertigen Bauwerk arbeiten lassen. */
  continueBuild(engineerIds: number[], structureId: number): void {
    const rec = this.recs.get(structureId);
    if (!rec || rec.completed) return;
    const engs = this.engineersOf(engineerIds);
    if (engs.length) this.assignBuild(engs, rec);
  }

  /** Bauwerk abbauen/entfernen (Skript, Pioniere, Rückbau). Kein Explosionseffekt. */
  removeStructure(id: number): void {
    this.destroy(id, false);
  }

  private assignBuild(engs: Unit[], rec: Rec): void {
    const sid = rec.info.id;
    let job = this.buildJobs.get(sid);
    if (!job) this.buildJobs.set(sid, (job = { sid, engineers: new Set(), lastTx: NaN, lastTz: NaN }));
    for (const u of engs) {
      const old = u.buildingStructureId;
      if (old !== undefined && old !== sid) this.buildJobs.get(old)?.engineers.delete(u.id);
      this.releaseEngineerFromBridge(u.id);
      u.buildingStructureId = sid;
      job.engineers.add(u.id);
    }
    const f = this.workFront(rec);
    this.sendEngineers(Array.from(job.engineers), f.x, f.z, 'build', sid, rec);
    job.lastTx = f.x; job.lastTz = f.z;
  }

  private workFront(rec: Rec): { x: number; z: number } {
    if (!rec.def.line) return { x: rec.info.points[0] + rec.fx * -0.012, z: rec.info.points[1] + rec.fz * -0.012 };
    const p = pointAlong(rec.pts, rec.info.progress * rec.length);
    // Arbeitsplatz hinter der Linie (eigene Seite)
    return { x: p.x - rec.fx * 0.006, z: p.z - rec.fz * 0.006 };
  }

  private sendEngineers(ids: number[], x: number, z: number, kind: 'build' | 'demolish' | 'repair' | 'garrison', targetId: number, rec?: Rec): void {
    if (!ids.length) return;
    this.units.issueMove(ids, x, z, { formation: 'spread' });
    for (const id of ids) {
      const u = this.units.get(id);
      const o = u?.orders[0];
      if (!o) continue;
      o.kind = kind;
      o.targetId = targetId;
      if (rec) { o.buildKind = rec.info.kind; o.points = rec.info.points; }
    }
  }

  private engineersOf(ids: number[]): Unit[] {
    const out: Unit[] = [];
    for (const id of ids) {
      const u = this.units.get(id);
      if (u && u.hp > 0 && u.type.id === 'engineer_squad' && u.garrisonId === undefined) out.push(u);
    }
    return out;
  }

  private workersOf(u: Unit): number {
    return Math.max(1, Math.round((u.type.memberCount * u.hp) / Math.max(1, u.type.hp)));
  }

  // ================================================================== Aufträge: Brücken

  /** Pioniere sprengen eine Brücke: hinlaufen, Ladungen anbringen, ~0,2 km zurückziehen, zünden. */
  orderDemolish(engineerIds: number[], edgeId: number): void {
    const e = this.graph.edges[edgeId];
    if (!e || !e.bridge || e.cls === 'ferry') { this.toast('Kein sprengbares Brückenziel', 'warn'); return; }
    if (!e.open || this.bridgeDown.has(edgeId)) { this.toast('Brücke ist bereits zerstört', 'info'); return; }
    this.startBridgeJob('demolish', engineerIds, edgeId);
  }

  /** Pioniere reparieren eine zerstörte Brücke (dauert deutlich länger; Pioniere müssen vor Ort bleiben). */
  orderRepair(engineerIds: number[], edgeId: number): void {
    const e = this.graph.edges[edgeId];
    if (!e || !e.bridge) { this.toast('Kein reparierbares Brückenziel', 'warn'); return; }
    if (e.open) { this.toast('Brücke ist intakt', 'info'); return; }
    this.startBridgeJob('repair', engineerIds, edgeId);
  }

  private startBridgeJob(mode: 'demolish' | 'repair', ids: number[], edgeId: number): void {
    const engs = this.engineersOf(ids);
    if (!engs.length) { this.toast('Kein Pionier-Trupp ausgewählt', 'warn'); return; }
    const key = `${mode}:${edgeId}`;
    let job = this.bridgeJobs.get(key);
    const site = this.graph.pointOnEdge(edgeId, 0.5);
    if (!job) {
      this.bridgeJobs.set(key, (job = { mode, edge: edgeId, engineers: new Set(), phase: 'walk', t: 0, siteX: site[0], siteZ: site[1], retreatX: site[0], retreatZ: site[1], retreatDist: RETREAT_KM }));
    }
    for (const u of engs) {
      this.releaseEngineerFromBridge(u.id, key);
      if (u.buildingStructureId !== undefined) { this.buildJobs.get(u.buildingStructureId)?.engineers.delete(u.id); u.buildingStructureId = undefined; }
      job.engineers.add(u.id);
    }
    if (job.phase === 'walk') this.sendEngineers(Array.from(job.engineers), job.siteX, job.siteZ, mode, edgeId);
  }

  private releaseEngineerFromBridge(uid: number, exceptKey?: string): void {
    for (const [k, j] of this.bridgeJobs) if (k !== exceptKey && j.engineers.delete(uid) && !j.engineers.size && j.phase !== 'retreat' && j.phase !== 'fuse') this.bridgeJobs.delete(k);
  }

  /** Sofortiges Sprengen (KI/Skripte). */
  demolish(edgeId: number): void {
    const e = this.graph.edges[edgeId];
    if (!e || !e.bridge || !e.open) return;
    this.detonate(edgeId);
  }

  /** Bomben-/Granatschaden an einer Brücke; summiert sich bis zum Einsturz. */
  damageBridge(edgeId: number, amount: number): void {
    const e = this.graph.edges[edgeId];
    if (!e || !e.bridge || !e.open || amount <= 0) return;
    const hp = (this.bridgeHp.get(edgeId) ?? BRIDGE_HP[e.cls] ?? 100) - amount;
    this.bridgeHp.set(edgeId, hp);
    if (hp <= 0) this.detonate(edgeId);
  }

  /** Brücken-Restintegrität 0..1 (1 = intakt) */
  bridgeIntegrity(edgeId: number): number {
    const e = this.graph.edges[edgeId];
    if (!e) return 0;
    if (!e.open) return 0;
    return Math.max(0, Math.min(1, (this.bridgeHp.get(edgeId) ?? BRIDGE_HP[e.cls] ?? 100) / (BRIDGE_HP[e.cls] ?? 100)));
  }

  /** Reparaturfortschritt 0..1 einer zerstörten Brücke */
  bridgeRepairProgress(edgeId: number): number {
    return this.bridgeRepair.get(edgeId) ?? 0;
  }

  bridgeEdgeNear(x: number, z: number, maxKm: number): number {
    const h = this.graph.nearestEdgePoint(x, z, maxKm, (e) => e.bridge && e.cls !== 'ferry');
    return h ? h.edge : -1;
  }

  private detonate(edgeId: number): void {
    const e = this.graph.edges[edgeId];
    this.bridgeDown.add(edgeId);
    this.bridgeRepair.set(edgeId, 0);
    this.bridgeHp.set(edgeId, 0);
    this.refreshEdge(edgeId);
    const geom = Array.from(e.geom);
    bus.emit('bridge:destroyed', { edgeId, geom });
    // Explosionen entlang der Spannweite
    const n = Math.min(6, Math.max(1, Math.ceil(e.lengthKm / 0.25)));
    for (let k = 0; k < n; k++) {
      const p = this.graph.pointOnEdge(edgeId, n === 1 ? 0.5 : (k + 0.5) / n);
      bus.emit('combat:explosion', { x: p[0], y: this.groundY(p[0], p[1]), z: p[1], size: 'huge', fire: k % 2 === 0 });
    }
    // Einheiten auf der Brücke nahe der Sprengstelle (Radius: halbe Spannweite, 0,2..0,35 km)
    const mid = this.graph.pointOnEdge(edgeId, 0.5);
    const blastR = blastRadius(e.lengthKm);
    const gl = Array.from(e.geom);
    this.units.queryRadius(mid[0], mid[1], blastR + 0.1, this.tmpUnits);
    for (const u of this.tmpUnits.slice()) {
      if (u.type.mobility.domain === 'air' || u.garrisonId !== undefined) continue;
      if (distToPolyline(u.x, u.z, gl) > 0.08) continue;
      const dm = Math.hypot(u.x - mid[0], u.z - mid[1]);
      if (dm < blastR * 0.6) this.hurt(u, 0.85 * u.type.hp, 'bridge_demolition', 1);
      else if (dm < blastR) this.hurt(u, 0.25 * u.type.hp, 'bridge_demolition', 0.8);
    }
    this.toast('Brücke gesprengt', 'warn');
    // Laufende Aufträge
    this.bridgeJobs.delete(`demolish:${edgeId}`);
  }

  private completeRepair(edgeId: number): void {
    this.bridgeDown.delete(edgeId);
    this.bridgeRepair.delete(edgeId);
    this.bridgeHp.delete(edgeId);
    this.refreshEdge(edgeId);
    bus.emit('bridge:repaired', { edgeId });
    this.toast('Brücke repariert', 'info');
  }

  /** Kante öffnen/schließen anhand eigener Sperrgründe (Straßensperren, zerstörte Brücke). */
  private refreshEdge(edgeId: number): void {
    const blocked = this.bridgeDown.has(edgeId) || (this.roadBlocks.get(edgeId)?.size ?? 0) > 0;
    this.graph.setEdgeOpen(edgeId, !blocked);
  }

  // ================================================================== Aufträge: Besetzen

  /** Soldaten besetzen ein Gebäude (laufen hin, dann unit.garrisonId = id; Kapazität begrenzt). */
  orderGarrison(unitIds: number[], buildingId: number): void {
    if (!this.cities.hasBuilding(buildingId) || this.cities.isCollapsed(buildingId)) { this.toast('Gebäude nicht besetzbar', 'warn'); return; }
    const b = this.cities.getBuilding(buildingId);
    let used = this.garrisonCount(buildingId) + this.pendingMembers(buildingId);
    const accepted: Unit[] = [];
    let full = false;
    for (const id of unitIds) {
      const u = this.units.get(id);
      if (!u || u.hp <= 0 || u.type.model !== 'soldier' || u.type.mobility.domain !== 'ground') continue;
      if (u.garrisonId === buildingId || this.pending.get(id)?.buildingId === buildingId) continue;
      const m = u.type.memberCount;
      if (used + m > b.garrisonCapacity) { full = true; continue; }
      used += m;
      accepted.push(u);
    }
    if (full) this.toast(`Gebäude voll (${b.garrisonCapacity} Plätze)`, 'warn');
    for (const u of accepted) {
      if (u.garrisonId !== undefined) this.ungarrison([u.id]);
      if (u.buildingStructureId !== undefined) { this.buildJobs.get(u.buildingStructureId)?.engineers.delete(u.id); u.buildingStructureId = undefined; }
      this.pending.set(u.id, { buildingId });
      this.units.issueMove([u.id], b.x, b.z, { formation: 'spread' });
      const o = u.orders[0];
      if (o) { o.kind = 'garrison'; o.targetId = buildingId; }
    }
  }

  /** Soldaten verlassen ihr Gebäude (Ausgang an der Rückseite). */
  ungarrison(unitIds: number[]): void {
    const per = new Map<number, number[]>();
    for (const id of unitIds) {
      this.pending.delete(id);
      const u = this.units.get(id);
      if (!u || u.garrisonId === undefined) continue;
      const bid = u.garrisonId;
      let a = per.get(bid);
      if (!a) per.set(bid, (a = []));
      a.push(id);
    }
    for (const [bid, ids] of per) this.exitBuilding(bid, ids);
  }

  /** Besatzung in Soldaten */
  garrisonCount(buildingId: number): number {
    const s = this.garrisons.get(buildingId);
    if (!s) return 0;
    let n = 0;
    for (const id of s) { const u = this.units.get(id); if (u) n += u.type.memberCount; }
    return n;
  }

  /** Einheiten-IDs in einem Gebäude */
  garrisonedUnits(buildingId: number): number[] {
    return Array.from(this.garrisons.get(buildingId) ?? []);
  }

  /**
   * Deckungs-/Sichtwerte für Einheiten mit unit.garrisonId (vom CombatSystem zu lesen):
   * protection = 0,7 × Integrität-Faktor (beschädigt schützt weniger), sightMult = 1,25 (Fensterblick),
   * null wenn Gebäude unbekannt/eingestürzt.
   */
  garrisonCover(buildingId: number): { protection: number; sightMult: number } | null {
    if (!this.cities.hasBuilding(buildingId) || this.cities.isCollapsed(buildingId)) return null;
    const g = this.cities.getBuilding(buildingId).integrity;
    return { protection: GARRISON_PROTECTION * (0.55 + 0.45 * Math.min(1, g / 0.35 > 1 ? 1 : g / 0.35)), sightMult: GARRISON_SIGHT_MULT };
  }

  private pendingMembers(buildingId: number): number {
    let n = 0;
    for (const [uid, p] of this.pending) if (p.buildingId === buildingId) n += this.units.get(uid)?.type.memberCount ?? 0;
    return n;
  }

  private enter(u: Unit, buildingId: number): void {
    const b = this.cities.getBuilding(buildingId);
    this.pending.delete(u.id);
    u.garrisonId = buildingId;
    u.x = b.x; u.z = b.z;
    u.orders.length = 0;
    u.route = null; u.routeKm = 0; u.speedKmh = 0; u.onRoad = false;
    u.coverId = undefined;
    let s = this.garrisons.get(buildingId);
    if (!s) this.garrisons.set(buildingId, (s = new Set()));
    s.add(u.id);
    this.garrisonUnits.add(u.id);
    this.cities.setGarrison(buildingId, this.garrisonCount(buildingId));
    bus.emit('building:garrison', { buildingId, unitIds: [u.id], enter: true });
  }

  private exitBuilding(buildingId: number, ids: number[]): void {
    const b = this.cities.getBuilding(buildingId);
    const c = Math.cos(b.rot), s = Math.sin(b.rot);
    const left: number[] = [];
    ids.forEach((id, i) => {
      const u = this.units.get(id);
      const set = this.garrisons.get(buildingId);
      set?.delete(id);
      this.garrisonUnits.delete(id);
      if (!u) return;
      const lx = (i - (ids.length - 1) / 2) * 0.03, lz = b.d / 2 + 0.035;
      u.x = b.x + c * lx + s * lz;
      u.z = b.z - s * lx + c * lz;
      u.garrisonId = undefined;
      u.route = null; u.routeKm = 0;
      left.push(id);
    });
    this.cities.setGarrison(buildingId, this.garrisonCount(buildingId));
    if (left.length) bus.emit('building:garrison', { buildingId, unitIds: left, enter: false });
  }

  private dropUnit(id: number): void {
    this.pending.delete(id);
    this.garrisonUnits.delete(id);
    for (const [bid, s] of this.garrisons) {
      if (s.delete(id)) this.cities.setGarrison(bid, this.garrisonCount(bid));
    }
    this.releaseEngineerFromBridge(id);
  }

  private onBuildingDestroyed(buildingId: number): void {
    const s = this.garrisons.get(buildingId);
    if (s && s.size) {
      const ids = Array.from(s);
      this.exitBuilding(buildingId, ids);
      for (const id of ids) {
        const u = this.units.get(id);
        if (u) this.hurt(u, 0.4 * u.type.hp, 'building_collapse', 0.8);
      }
    }
    this.garrisons.delete(buildingId);
    for (const [uid, p] of this.pending) if (p.buildingId === buildingId) { this.pending.delete(uid); this.units.issueStop([uid]); }
  }

  // ================================================================== Schaden

  /** Schaden an einem Bauwerk (Trefferpunkte). Bei 0 zerstört. */
  damageStructure(id: number, amount: number): void {
    const rec = this.recs.get(id);
    if (!rec || amount <= 0) return;
    rec.info.hp -= amount;
    if (rec.def.kind === 'minefield') this.viewDirty = true;
    if (rec.info.hp <= 0) this.destroy(id, true);
  }

  /** Bauwerke, deren Linie/Punkt innerhalb r km von (x,z) liegt (auch unfertige: progress < 1). out wird geleert. */
  structuresInRadius(x: number, z: number, r: number, out: StructureInfo[]): StructureInfo[] {
    out.length = 0;
    for (const rec of this.recs.values()) {
      const pre = r + rec.length / 2 + 0.05;
      if (Math.abs(rec.cx - x) > pre || Math.abs(rec.cz - z) > pre) continue;
      if (distToPolyline(x, z, rec.info.points) <= r) out.push(rec.info);
    }
    return out;
  }

  private destroy(id: number, explode: boolean): void {
    const rec = this.recs.get(id);
    if (!rec) return;
    this.recs.delete(id);
    this.structures.delete(id);
    const job = this.buildJobs.get(id);
    if (job) {
      for (const uid of job.engineers) { const u = this.units.get(uid); if (u && u.buildingStructureId === id) u.buildingStructureId = undefined; }
      this.buildJobs.delete(id);
    }
    for (const cid of rec.cover) bus.emit('cover:remove', { id: cid });
    rec.cover.length = 0;
    if (rec.edgeId >= 0) {
      const set = this.roadBlocks.get(rec.edgeId);
      if (set) { set.delete(id); if (!set.size) this.roadBlocks.delete(rec.edgeId); }
      this.refreshEdge(rec.edgeId);
    }
    if (explode && rec.completed) {
      bus.emit('combat:explosion', { x: rec.cx, y: this.groundY(rec.cx, rec.cz), z: rec.cz, size: rec.info.kind === 'bunker' ? 'medium' : 'small', fire: false });
    }
    bus.emit('structure:removed', { id });
    this.viewDirty = true;
    this.symbolsDirty = true;
  }

  private hurt(u: Unit, amount: number, cause: string, suppression: number): void {
    u.hp -= amount;
    u.suppression = Math.max(u.suppression ?? 0, suppression);
    bus.emit('unit:damaged', { id: u.id, amount, hp: u.hp, attackerId: 0, suppression: u.suppression });
    if (u.hp <= 0) {
      bus.emit('unit:killed', { id: u.id, typeId: u.type.id, category: u.type.category, owner: u.owner, x: u.x, y: u.y, z: u.z, heading: u.heading, killerId: 0, cause });
      if (u.type.category !== 'infantry') bus.emit('wreck:spawn', { x: u.x, y: u.y, z: u.z, heading: u.heading, category: u.type.category, typeId: u.type.id, owner: u.owner });
      this.units.remove(u.id);
    }
  }

  // ================================================================== Update

  update(dtGameHours: number, realDt: number): void {
    this.clock += realDt;
    this.updateBuildJobs(dtGameHours);
    this.updateBridgeJobs(dtGameHours);
    this.updateGarrison();
    this.mineClock += realDt;
    if (this.mineClock >= 0.2) { this.mineClock = 0; this.updateMines(); }
    this.viewTimer += realDt;
  }

  private updateBuildJobs(dt: number): void {
    for (const job of Array.from(this.buildJobs.values())) {
      const rec = this.recs.get(job.sid);
      if (!rec) { this.buildJobs.delete(job.sid); continue; }
      const front = this.workFront(rec);
      let workers = 0;
      const alive: Unit[] = [];
      for (const id of job.engineers) {
        const u = this.units.get(id);
        if (!u || u.hp <= 0 || u.buildingStructureId !== job.sid) { job.engineers.delete(id); continue; }
        // Anderen Auftrag erhalten (nicht 'build')? Dann aus dem Job entlassen.
        const o = u.orders[0];
        if (o && o.kind !== 'build') { job.engineers.delete(id); u.buildingStructureId = undefined; continue; }
        alive.push(u);
        if (Math.hypot(u.x - front.x, u.z - front.z) <= WORK_RANGE + rec.def.coverSpacing) workers += this.workersOf(u);
      }
      if (!alive.length) { this.buildJobs.delete(job.sid); continue; }
      if (workers > 0 && dt > 0) {
        const mh = Math.max(0.5, rec.def.manHours + rec.def.manHoursPerKm * (rec.def.line ? rec.length : 0));
        const before = rec.info.progress;
        rec.info.progress = Math.min(1, before + (dt * workers) / mh);
        rec.info.hp = Math.max(1, Math.round(rec.info.hpMax * rec.info.progress));
        if (this.viewTimer > 0.25 || rec.info.progress >= 1) { this.viewDirty = true; this.viewTimer = 0; }
        if (rec.info.progress >= 1) { this.complete(rec); continue; }
      }
      // Arbeitsfront rückt vor: Pioniere nachziehen
      if (rec.def.line && Math.hypot(front.x - job.lastTx, front.z - job.lastTz) > 0.03) {
        this.sendEngineers(alive.map((u) => u.id), front.x, front.z, 'build', job.sid, rec);
        job.lastTx = front.x; job.lastTz = front.z;
      } else {
        // Wartende ohne Befehl und fern der Front erneut hinschicken
        const lost = alive.filter((u) => !u.orders.length && Math.hypot(u.x - front.x, u.z - front.z) > WORK_RANGE + 0.02);
        if (lost.length) this.sendEngineers(lost.map((u) => u.id), front.x, front.z, 'build', job.sid, rec);
      }
    }
  }

  private complete(rec: Rec): void {
    const id = rec.info.id;
    rec.completed = true;
    rec.info.progress = 1;
    rec.info.hp = rec.info.hpMax;
    const job = this.buildJobs.get(id);
    if (job) {
      for (const uid of job.engineers) { const u = this.units.get(uid); if (u && u.buildingStructureId === id) u.buildingStructureId = undefined; }
      this.buildJobs.delete(id);
    }
    this.emitCover(rec);
    if (rec.edgeId >= 0) {
      let set = this.roadBlocks.get(rec.edgeId);
      if (!set) this.roadBlocks.set(rec.edgeId, (set = new Set()));
      set.add(id);
      this.refreshEdge(rec.edgeId);
    }
    bus.emit('structure:added', { id, kind: rec.info.kind, owner: rec.info.owner });
    this.toast(`${rec.def.name} fertiggestellt`, 'info');
    this.viewDirty = true;
    this.symbolsDirty = true;
  }

  private emitCover(rec: Rec): void {
    const d = rec.def;
    if (!d.cover || d.protection <= 0) return;
    const mk = (x: number, z: number, dx: number, dz: number, cap: number): void => {
      const l = Math.hypot(dx, dz) || 1;
      const point: CoverPoint = { id: nextCoverId(), x, z, dirX: dx / l, dirZ: dz / l, kind: d.cover!, protection: d.protection, posture: d.posture, capacity: cap, vaultable: d.vaultable, structureId: rec.info.id, alive: true };
      rec.cover.push(point.id);
      bus.emit('cover:add', { point });
    };
    const k = rec.info.kind;
    if (d.line) {
      const spacing = Math.max(d.coverSpacing, rec.length / 40);
      const s = sampleLine(rec.pts, spacing);
      // Normale zur Feindseite
      for (let i = 0; i < s.length / 2; i++) {
        const a = Math.max(0, i - 1), c = Math.min(s.length / 2 - 1, i + 1);
        let tx = s[c * 2] - s[a * 2], tz = s[c * 2 + 1] - s[a * 2 + 1];
        const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
        let nx = -tz, nz = tx;
        if (nx * rec.fx + nz * rec.fz < 0) { nx = -nx; nz = -nz; }
        mk(s[i * 2], s[i * 2 + 1], nx, nz, d.coverCap);
      }
      return;
    }
    const cx = rec.info.points[0], cz = rec.info.points[1];
    const fx = rec.fx, fz = rec.fz, px = -fz, pz = fx;
    const arc = (angles: number[], r: number): void => {
      for (const a of angles) {
        const dx = fx * Math.cos(a) + px * Math.sin(a), dz = fz * Math.cos(a) + pz * Math.sin(a);
        mk(cx + dx * r, cz + dz * r, dx, dz, d.coverCap);
      }
    };
    if (k === 'foxhole') mk(cx + fx * 0.0012, cz + fz * 0.0012, fx, fz, d.coverCap);
    else if (k === 'mg_nest') arc([-0.9, 0, 0.9], 0.0032);
    else if (k === 'at_position') arc([-1.0, 0, 1.0], 0.0045);
    else if (k === 'mortar_pit') arc([0, Math.PI / 2, Math.PI, -Math.PI / 2], 0.004);
    else if (k === 'bunker') arc([-0.5, 0.5], 0.003);
  }

  private updateBridgeJobs(dt: number): void {
    for (const [key, job] of Array.from(this.bridgeJobs)) {
      const e = this.graph.edges[job.edge];
      const live: Unit[] = [];
      for (const id of job.engineers) {
        const u = this.units.get(id);
        if (!u || u.hp <= 0) { job.engineers.delete(id); continue; }
        // anderen Befehl erhalten -> entlassen (nur vor dem Rückzug)
        const o = u.orders[0];
        if (job.phase === 'walk' && o && o.kind !== job.mode) { job.engineers.delete(id); continue; }
        live.push(u);
      }
      if (!e) { this.bridgeJobs.delete(key); continue; }
      if (!live.length && job.phase !== 'fuse' && job.phase !== 'retreat') {
        this.bridgeJobs.delete(key);
        this.toast(job.mode === 'demolish' ? 'Sprengkommando ausgefallen' : 'Reparaturtrupp ausgefallen', 'warn');
        continue;
      }
      const near = live.filter((u) => Math.hypot(u.x - job.siteX, u.z - job.siteZ) <= BRIDGE_WORK_RANGE);
      if (job.mode === 'repair' && e.open) { this.bridgeJobs.delete(key); continue; }
      if (job.mode === 'demolish' && !e.open) { this.bridgeJobs.delete(key); continue; }

      if (job.phase === 'walk') {
        if (near.length) { job.phase = 'work'; job.t = 0; for (const u of near) { if (u.orders.length && Math.hypot(u.x - job.siteX, u.z - job.siteZ) < 0.1) u.orders.length = 0; } }
        else {
          const idle = live.filter((u) => !u.orders.length);
          if (idle.length) this.sendEngineers(idle.map((u) => u.id), job.siteX, job.siteZ, job.mode, job.edge);
        }
        continue;
      }
      if (job.phase === 'work') {
        let workers = 0;
        for (const u of near) workers += this.workersOf(u);
        if (job.mode === 'demolish') {
          if (workers > 0 && dt > 0) job.t += (dt * Math.max(0.5, workers / 6));
          const need = 0.15 + Math.min(0.35, e.lengthKm * 0.5);
          if (job.t >= need) this.beginRetreat(job, live);
        } else {
          if (workers > 0 && dt > 0) {
            const mh = 20 + 70 * e.lengthKm;
            const p = Math.min(1, (this.bridgeRepair.get(job.edge) ?? 0) + (dt * workers) / mh);
            this.bridgeRepair.set(job.edge, p);
            if (p >= 1) {
              this.bridgeJobs.delete(key);
              this.completeRepair(job.edge);
              for (const u of live) u.orders.length = 0;
            }
          }
        }
        continue;
      }
      if (job.phase === 'retreat') {
        job.t += dt;
        const away = live.length === 0 || live.every((u) => Math.hypot(u.x - job.siteX, u.z - job.siteZ) >= job.retreatDist * 0.85);
        if (away || job.t > 0.3) { job.phase = 'fuse'; job.t = 0; }
        continue;
      }
      if (job.phase === 'fuse') {
        job.t += dt;
        if (job.t >= FUSE_HOURS) { this.bridgeJobs.delete(key); this.detonate(job.edge); }
      }
    }
  }

  private beginRetreat(job: BridgeJob, live: Unit[]): void {
    const e = this.graph.edges[job.edge];
    // Rückzug entlang der Kante auf die Seite, auf der die Pioniere stehen, außerhalb des Sprengradius
    const a = this.graph.pointOnEdge(job.edge, 0.49), b = this.graph.pointOnEdge(job.edge, 0.51);
    let tx = b[0] - a[0], tz = b[1] - a[1];
    const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
    let side = 0;
    for (const u of live) side += (u.x - job.siteX) * tx + (u.z - job.siteZ) * tz;
    const sign = side >= 0 ? 1 : -1;
    const dist = Math.max(RETREAT_KM, Math.min(e.lengthKm / 2 + RETREAT_KM, blastRadius(e.lengthKm) * 1.25));
    job.retreatDist = dist;
    if (dist <= e.lengthKm / 2) {
      const p = this.graph.pointOnEdge(job.edge, 0.5 + (sign * dist) / e.lengthKm);
      job.retreatX = p[0]; job.retreatZ = p[1];
    } else {
      const end = this.graph.pointOnEdge(job.edge, sign > 0 ? 1 : 0);
      const ea = this.graph.pointOnEdge(job.edge, sign > 0 ? 0.98 : 0.02);
      let ex = end[0] - ea[0], ez = end[1] - ea[1];
      const el = Math.hypot(ex, ez) || 1; ex /= el; ez /= el;
      const rest = dist - e.lengthKm / 2;
      job.retreatX = end[0] + ex * rest; job.retreatZ = end[1] + ez * rest;
    }
    job.phase = 'retreat';
    job.t = 0;
    this.units.issueMove(live.map((u) => u.id), job.retreatX, job.retreatZ, { formation: 'spread' });
    this.toast('Ladungen angebracht – Pioniere ziehen sich zurück', 'info');
  }

  private updateGarrison(): void {
    // Wartende
    for (const [uid, p] of Array.from(this.pending)) {
      const u = this.units.get(uid);
      if (!u || u.hp <= 0) { this.pending.delete(uid); continue; }
      if (this.cities.isCollapsed(p.buildingId)) { this.pending.delete(uid); continue; }
      const b = this.cities.getBuilding(p.buildingId);
      const c = Math.cos(b.rot), s = Math.sin(b.rot);
      const dx = u.x - b.x, dz = u.z - b.z;
      const lx = Math.abs(c * dx - s * dz) - b.w / 2, lz = Math.abs(s * dx + c * dz) - b.d / 2;
      const dist = Math.hypot(Math.max(lx, 0), Math.max(lz, 0));
      if (dist <= 0.02) { this.enter(u, p.buildingId); continue; }
      const o = u.orders[0];
      if (!o && dist > 0.12) this.pending.delete(uid); // Befehl verloren / nicht erreichbar
      else if (o && o.kind !== 'garrison') this.pending.delete(uid); // neuer Befehl
    }
    // Besetzte mit neuem Befehl -> Gebäude verlassen
    for (const uid of Array.from(this.garrisonUnits)) {
      const u = this.units.get(uid);
      if (!u || u.garrisonId === undefined) { this.garrisonUnits.delete(uid); continue; }
      if (u.orders.length && !this.pending.has(uid)) this.exitBuilding(u.garrisonId, [uid]);
      else if (u.garrisonId !== undefined) { // Position am Gebäude halten
        const b = this.cities.getBuilding(u.garrisonId);
        u.x = b.x; u.z = b.z;
      }
    }
  }

  private updateMines(): void {
    for (const rec of this.recs.values()) {
      if (rec.info.kind !== 'minefield' || !rec.completed || rec.info.hp <= 0) continue;
      this.units.queryRadius(rec.cx, rec.cz, rec.length / 2 + MINE_HALF_WIDTH + 0.05, this.tmpUnits);
      for (const u of this.tmpUnits.slice()) {
        if (u.hp <= 0 || u.garrisonId !== undefined || u.type.mobility.domain !== 'ground' || u.speedKmh < 0.5) continue;
        if (this.war ? !this.war.isHostile(rec.info.owner, u.owner) : u.owner === rec.info.owner) continue;
        if (distToPolyline(u.x, u.z, rec.pts) > MINE_HALF_WIDTH) continue;
        const key = `${rec.info.id}:${u.id}`;
        if ((this.mineCooldown.get(key) ?? -9) > this.clock - 3) continue;
        this.mineCooldown.set(key, this.clock);
        bus.emit('combat:explosion', { x: u.x, y: u.y, z: u.z, size: 'small', fire: false });
        const frac = u.type.category === 'infantry' ? 0.3 : 0.22;
        rec.info.hp -= 1;
        this.hurt(u, frac * u.type.hp, 'mine', 0.7);
        if (rec.info.hp <= 0) { this.destroy(rec.info.id, false); break; }
      }
    }
    if (this.mineCooldown.size > 400) for (const [k, t] of this.mineCooldown) if (t < this.clock - 10) this.mineCooldown.delete(k);
  }

  // ================================================================== Rendering

  private groundY(x: number, z: number): number {
    return Math.max(0, this.geo.heightAt(x, z)) * this.exag;
  }

  private toast(msg: string, kind: 'info' | 'warn' | 'error' = 'info'): void {
    bus.emit('toast', { msg, kind });
  }

  private makeMesh(cap: number): THREE.InstancedMesh {
    const m = new THREE.InstancedMesh(this.boxGeo, this.mat, cap);
    m.name = 'StructurePieces';
    m.count = 0;
    m.frustumCulled = false;
    m.setColorAt(0, _c.setHex(0xffffff)); // instanceColor vor dem ersten Draw anlegen (Shader-Variante)
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.onBeforeRender = (_r, _s, camera) => this.refreshView(camera as THREE.PerspectiveCamera);
    return m;
  }

  /** Optional von außen aufrufbar (sonst automatisch per onBeforeRender). */
  updateView(camera: THREE.PerspectiveCamera): void {
    this.refreshView(camera);
  }

  private refreshView(camera: THREE.PerspectiveCamera): void {
    camera.updateMatrixWorld();
    _cam.setFromMatrixPosition(camera.matrixWorld);
    camera.getWorldDirection(_dir);
    const gy = Math.max(0, this.geo.heightAt(_cam.x, _cam.z)) * this.exag;
    const dist = _dir.y < -0.05 ? Math.max(0.5, (_cam.y - gy * 0.5) / -_dir.y) : Math.max(0.5, _cam.y);
    this.camDist = dist;
    const showSymbols = dist > SYMBOL_DIST && dist < SYMBOL_MAX_DIST;
    const show3d = dist <= SYMBOL_DIST * 1.0;
    this.symbols.visible = showSymbols && this.recs.size > 0;
    // Hinweis: mesh bleibt immer sichtbar (sonst würde onBeforeRender nie mehr aufgerufen); ausgeblendet = count 0
    if (showSymbols && this.symbolsDirty) this.rebuildSymbols();
    if (!show3d || this.recs.size === 0) {
      if (this.mesh.count !== 0) { this.mesh.count = 0; this.viewDirty = true; }
      return;
    }
    const s = Math.min(SCALE_MAX, Math.max(SCALE_MIN, SCALE_K * dist));
    if (this.viewDirty || this.exag !== this.lastExag || Math.abs(s / this.lastScale - 1) > 0.05) {
      this.visScale = s;
      this.lastScale = s;
      this.lastExag = this.exag;
      this.viewDirty = false;
      this.rebuildInstances();
    }
  }

  private rebuildInstances(): void {
    let total = 0;
    for (const r of this.recs.values()) total += r.nPieces + 1;
    if (total > this.capacity) {
      let cap = this.capacity;
      while (cap < total && cap < MAX_INSTANCES) cap *= 2;
      this.object.remove(this.mesh);
      this.mesh.dispose();
      this.capacity = cap;
      this.mesh = this.makeMesh(cap);
      this.object.add(this.mesh);
    }
    const s = this.visScale, e = this.exag;
    const gap = 0.0012 * s + 0.0003;
    let n = 0;
    const cap = this.capacity;
    for (const r of this.recs.values()) {
      const prog = r.info.progress, rise = Math.max(0.18, prog);
      const d = r.pieces;
      for (let i = 0; i < r.nPieces && n < cap; i++) {
        const o = i * STRIDE;
        const u = d[o + 11], fl = d[o + 10];
        if (prog < 1 && (fl & F_RISE) === 0 && u > prog) continue;
        let L = d[o + 5], W = d[o + 6], H = d[o + 7], y0 = d[o + 8];
        if (fl & F_SL) L *= s;
        if (fl & F_SW) W *= s;
        if (fl & F_SH) H *= s;
        y0 *= s;
        if (fl & F_RISE) { H *= rise; y0 *= rise; }
        _e.set(d[o + 3], d[o + 2], d[o + 4], 'YXZ');
        _q.setFromEuler(_e);
        _p.set(d[o], d[o + 12] * e + gap + y0, d[o + 1]);
        _s.set(L, H, W);
        _m4.compose(_p, _q, _s);
        this.mesh.setMatrixAt(n, _m4);
        _c.setHex(d[o + 9]);
        if (prog < 1) _c.lerp(_c2.setHex(0xd8c9a0), 0.25);
        this.mesh.setColorAt(n, _c);
        n++;
      }
      // Arbeitsmarker (Absperrpfosten) an der Front unfertiger Bauwerke
      if (prog < 1 && n < cap) {
        const f = this.workFront(r);
        _p.set(f.x, this.groundY(f.x, f.z) + gap + 0.0025 * s, f.z);
        _q.identity();
        _s.set(0.0004 * s, 0.005 * s, 0.0004 * s);
        _m4.compose(_p, _q, _s);
        this.mesh.setMatrixAt(n, _m4);
        _c.setHex(COL.stake);
        this.mesh.setColorAt(n, _c);
        n++;
      }
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  private rebuildSymbols(): void {
    this.symbolsDirty = false;
    const n = this.recs.size;
    const pos = new Float32Array(Math.max(1, n) * 3), col = new Float32Array(Math.max(1, n) * 3);
    let i = 0;
    for (const r of this.recs.values()) {
      pos[i * 3] = r.cx; pos[i * 3 + 1] = this.groundY(r.cx, r.cz) + 1.2; pos[i * 3 + 2] = r.cz;
      const c = SYMBOL_COLOR[r.info.kind] ?? 0xffffff;
      _c.setHex(c);
      col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b;
      i++;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setDrawRange(0, n);
    this.symbols.geometry.dispose();
    this.symbols.geometry = g;
  }

  /** Aktueller Sichtmaßstab (Debug) */
  get visualScale(): number {
    return this.visScale;
  }
  get cameraDistanceKm(): number {
    return this.camDist;
  }
}

const _c2 = new THREE.Color();

const SYMBOL_COLOR: Record<StructureKind, number> = {
  sandbags: 0xd9c27a, tank_trap: 0x9aa2a8, barbed_wire: 0xb0b0b0, trench: 0x8a6a3a, bunker: 0xdddddd, mg_nest: 0xe0a64a,
  mortar_pit: 0xe0a64a, at_position: 0xe0704a, foxhole: 0xa88a5a, minefield: 0xe03a2a, roadblock: 0xffffff,
};
