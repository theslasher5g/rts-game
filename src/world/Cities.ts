import * as THREE from 'three';
import type { GeoData } from './GeoData';
import type { Settings } from '../core/types';
import { bus } from '../core/EventBus';
import type { BuildingInfo } from '../combat/types';
import { SUN_COLOR, SUN_DIR } from './Terrain';

/** Ab dieser Kamerahöhe (km) werden Gebäude ausgeblendet und nur Marker gezeigt */
const HIDE_DISTANCE = 2500;
/** Ab dieser Kamerahöhe werden auch die Marker ausgeblendet */
const MARKER_MAX_DISTANCE = 9000;
/** Kachel-Abstand (km) bis zu dem die detaillierten Gebäudemodelle gezeichnet werden */
const LOD0_DIST = 48;
/** Kachel-Abstand (km) bis zu dem die einfachen Quader gezeichnet werden */
const LOD1_DIST = 1800;
/** Kachelgröße (km) für Culling/LOD */
const TILE_KM = 6;

/** Daten-Stride je Gebäude (x, z, w, h, d, rot, base, color) */
export const STRIDE = 8;
/** Raum-Hash-Zellgröße (km) */
const HASH_CELL = 1;
/** Ab dieser Integrität gilt ein Gebäude als beschädigt (dunkler/schief) */
export const BUILDING_DAMAGED_BELOW = 0.35;
/** Trümmerhöhe relativ zur Originalhöhe und absolutes Minimum (km) */
const RUBBLE_FRAC = 0.12;
const RUBBLE_MIN_H = 0.008;
const RUBBLE_COLOR = 0x3f3b36;
/** Gebäude-Einsenkung in den Boden (km) */
const SINK = 0.03;

/** Gebäudetypen (Index = Prototyp) */
export const BT = {
  OLD: 0, // Altbau, Satteldach, Schornsteine, Gauben
  HIP: 1, // Walmdach (Mittelmeer / Villen)
  MID: 2, // Wohn-/Bürobau, Flachdach
  PLATTE: 3, // Plattenbau-Riegel
  HALL: 4, // Industriehalle mit Sheddach
  SILO: 5,
  STACK: 6, // Schornstein
  TOWER: 7, // Hochhaus mit gestuftem Abschluss
  CHURCH: 8, // Kirche mit Spitzturm
  WARE: 9, // Lagerhalle
  VILLA: 10, // Einfamilienhaus
  BARN: 11, // Scheune
} as const;
export const BT_COUNT = 12;
/** Höhenanteil der einfachen LOD1-Quader je Typ */
const FAR_TOP = [0.8, 0.8, 0.93, 0.95, 0.65, 0.8, 1, 0.96, 0.5, 0.85, 0.75, 0.7];

/** Deterministischer RNG (mulberry32) */
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

/** Ausdehnung (km) der Bebauung einer Stadt – auch für Vegetations-/Dorf-Ausschluss */
export function cityRadiusKm(pop: number, capital: boolean): number {
  const popM = Math.max(0.02, pop / 1e6);
  return Math.min(9, 0.9 + Math.sqrt(popM) * 1.5 + (capital ? 0.3 : 0));
}

function cornerH(hs: Float32Array, W: number, H: number, i: number, j: number): number {
  const i0 = i < 1 ? 0 : i > W ? W - 1 : i - 1;
  const i1 = i < 0 ? 0 : i > W - 1 ? W - 1 : i;
  const j0 = j < 1 ? 0 : j > H ? H - 1 : j - 1;
  const j1 = j < 0 ? 0 : j > H - 1 ? H - 1 : j;
  return 0.25 * (hs[j0 * W + i0] + hs[j0 * W + i1] + hs[j1 * W + i0] + hs[j1 * W + i1]);
}

/**
 * Höhe (km) der GPU-Geländeoberfläche (Gitterpunkte = Mittel der 4 Rasterzellen darum, dazwischen bilinear) –
 * für Dekale/Gebäude, die exakt auf dem gerenderten Gelände sitzen sollen (geo.heightAt weicht an Hängen ab).
 */
export function terrainHeightKm(geo: GeoData, x: number, z: number): number {
  const gx = x / geo.cellKm, gz = z / geo.cellKm;
  const i = Math.floor(gx), j = Math.floor(gz);
  const fx = gx - i, fz = gz - j;
  const hs = geo.heightsKm, W = geo.width, H = geo.height;
  const a = cornerH(hs, W, H, i, j), b = cornerH(hs, W, H, i + 1, j);
  const c = cornerH(hs, W, H, i, j + 1), d = cornerH(hs, W, H, i + 1, j + 1);
  return (a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz;
}

// ====================================================================== Prototypen-Geometrie

type V3 = [number, number, number];

/** Kleiner Geometrie-Baukasten. Attribute: position, normal, uv, aSurf(Fassade,Achse,Teil), aSize(Breiten-/Höhenanteil) */
class GB {
  p: number[] = [];
  n: number[] = [];
  uv: number[] = [];
  s: number[] = [];
  z: number[] = [];
  i: number[] = [];

  private emit(P: V3[], UV: number[][], nrm: V3, flip: boolean, f: number, axis: number, part: number, sw: number, sh: number): void {
    const base = this.p.length / 3;
    for (let k = 0; k < P.length; k++) {
      this.p.push(P[k][0], P[k][1], P[k][2]);
      this.n.push(nrm[0], nrm[1], nrm[2]);
      this.uv.push(UV[k][0], UV[k][1]);
      this.s.push(f, axis, part);
      this.z.push(sw, sh);
    }
    if (P.length === 4) {
      if (!flip) this.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
      else this.i.push(base, base + 2, base + 1, base, base + 3, base + 2);
    } else if (!flip) this.i.push(base, base + 1, base + 2);
    else this.i.push(base, base + 2, base + 1);
  }

  private static normal(a: V3, b: V3, c: V3, hint: V3): { n: V3; flip: boolean } {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const flip = nx * hint[0] + ny * hint[1] + nz * hint[2] < 0;
    return { n: flip ? [-nx, -ny, -nz] : [nx, ny, nz], flip };
  }

  /** a->b = u-Richtung (horizontal), a->d = v-Richtung */
  quad(a: V3, b: V3, c: V3, d: V3, hint: V3, f: number, axis: number, part: number, sw = 1, sh = 1): void {
    const { n, flip } = GB.normal(a, b, d, hint);
    this.emit([a, b, c, d], [[0, 0], [1, 0], [1, 1], [0, 1]], n, flip, f, axis, part, sw, sh);
  }

  tri(a: V3, b: V3, c: V3, hint: V3, f: number, axis: number, part: number, sw = 1, sh = 1): void {
    const { n, flip } = GB.normal(a, b, c, hint);
    this.emit([a, b, c], [[0, 0], [1, 0], [0.5, 1]], n, flip, f, axis, part, sw, sh);
  }

  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, o: { f?: number; endF?: number; part?: number; top?: number; topPart?: number } = {}): void {
    const f = o.f ?? -1, ef = o.endF ?? f, part = o.part ?? 0;
    const sx = x1 - x0, sz = z1 - z0, sy = y1 - y0;
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], f, 0, part, sx, sy);
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], f, 0, part, sx, sy);
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], ef, 1, part, sz, sy);
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], ef, 1, part, sz, sy);
    if (o.top !== 0) this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], -1, 0, o.topPart ?? 1);
  }

  /** Satteldach, First entlang x */
  gable(x0: number, x1: number, ye: number, yr: number, z0: number, z1: number, endPart = 0, zr = (z0 + z1) / 2): void {
    this.quad([x0, ye, z1], [x1, ye, z1], [x1, yr, zr], [x0, yr, zr], [0, 1, 1], -1, 0, 1);
    this.quad([x1, ye, z0], [x0, ye, z0], [x0, yr, zr], [x1, yr, zr], [0, 1, -1], -1, 0, 1);
    this.tri([x1, ye, z1], [x1, ye, z0], [x1, yr, zr], [1, 0, 0], -1, 0, endPart);
    this.tri([x0, ye, z0], [x0, ye, z1], [x0, yr, zr], [-1, 0, 0], -1, 0, endPart);
  }

  /** Walmdach */
  hip(x0: number, x1: number, ye: number, yr: number, z0: number, z1: number, rl: number): void {
    const zm = (z0 + z1) / 2, xm = (x0 + x1) / 2;
    this.quad([x0, ye, z1], [x1, ye, z1], [xm + rl, yr, zm], [xm - rl, yr, zm], [0, 1, 1], -1, 0, 1);
    this.quad([x1, ye, z0], [x0, ye, z0], [xm - rl, yr, zm], [xm + rl, yr, zm], [0, 1, -1], -1, 0, 1);
    this.tri([x1, ye, z1], [x1, ye, z0], [xm + rl, yr, zm], [1, 1, 0], -1, 0, 1);
    this.tri([x0, ye, z0], [x0, ye, z1], [xm - rl, yr, zm], [-1, 1, 0], -1, 0, 1);
  }

  /** Pyramide (Spitzturm) */
  pyramid(cx: number, cz: number, hx: number, hz: number, y0: number, y1: number, part: number): void {
    const A: V3 = [cx, y1, cz];
    const c00: V3 = [cx - hx, y0, cz - hz], c10: V3 = [cx + hx, y0, cz - hz], c11: V3 = [cx + hx, y0, cz + hz], c01: V3 = [cx - hx, y0, cz + hz];
    this.tri(c01, c11, A, [0, 0.3, 1], -1, 0, part);
    this.tri(c10, c00, A, [0, 0.3, -1], -1, 0, part);
    this.tri(c11, c10, A, [1, 0.3, 0], -1, 0, part);
    this.tri(c00, c01, A, [-1, 0.3, 0], -1, 0, part);
  }

  /** Zylinder/Kegelstumpf mit n Seiten, Mittelpunkt (cx,cz) */
  tube(cx: number, cz: number, y0: number, y1: number, r0: number, r1: number, n: number, part: number, cap: number): void {
    for (let k = 0; k < n; k++) {
      const a0 = (k / n) * Math.PI * 2, a1 = ((k + 1) / n) * Math.PI * 2;
      const am = (a0 + a1) / 2;
      const hint: V3 = [Math.cos(am), 0.05, Math.sin(am)];
      this.quad(
        [cx + Math.cos(a1) * r0, y0, cz + Math.sin(a1) * r0], [cx + Math.cos(a0) * r0, y0, cz + Math.sin(a0) * r0],
        [cx + Math.cos(a0) * r1, y1, cz + Math.sin(a0) * r1], [cx + Math.cos(a1) * r1, y1, cz + Math.sin(a1) * r1],
        hint, -1, 0, part, 1, 1,
      );
      if (cap >= 0) this.tri([cx + Math.cos(a0) * r1, y1, cz + Math.sin(a0) * r1], [cx + Math.cos(a1) * r1, y1, cz + Math.sin(a1) * r1], [cx, y1, cz], [0, 1, 0], -1, 0, cap);
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aSurf', new THREE.Float32BufferAttribute(this.s, 3));
    g.setAttribute('aSize', new THREE.Float32BufferAttribute(this.z, 2));
    g.setIndex(this.i);
    return g;
  }
}

// Teile: 0 Wand (Instanzfarbe), 1 Dach (Dachfarbe), 2 dunkel (Metall/Antenne), 3 Ziegel, 4 Beton
function protoOld(): GB {
  const g = new GB();
  const e = 0.62, r = 0.92;
  g.box(-0.5, 0, -0.5, 0.5, e, 0.5, { f: 0, endF: -1, top: 0 });
  g.gable(-0.5, 0.5, e, r, -0.5, 0.5);
  g.box(-0.34, r - 0.08, -0.06, -0.26, 1.0, 0.06, { part: 3, topPart: 2 });
  g.box(0.24, r - 0.08, -0.06, 0.32, 0.99, 0.06, { part: 3, topPart: 2 });
  // Gaube
  g.box(0.0, e - 0.02, 0.18, 0.15, e + 0.15, 0.3, { f: 0, endF: -1, top: 1, topPart: 1 });
  g.box(-0.3, e - 0.02, -0.3, -0.16, e + 0.14, -0.18, { f: -1, endF: -1, top: 1, topPart: 1 });
  return g;
}
function protoHip(): GB {
  const g = new GB();
  const e = 0.6, r = 0.92;
  g.box(-0.5, 0, -0.5, 0.5, e, 0.5, { f: 6, endF: 6, top: 0 });
  g.hip(-0.5, 0.5, e, r, -0.5, 0.5, 0.2);
  g.box(0.16, r - 0.1, -0.05, 0.25, 1.0, 0.05, { part: 3, topPart: 2 });
  return g;
}
function protoMid(): GB {
  const g = new GB();
  g.box(-0.5, 0, -0.5, 0.5, 0.93, 0.5, { f: 2, endF: -1, topPart: 1 });
  g.box(-0.1, 0.93, -0.28, 0.28, 1.0, 0.12, { part: 4, topPart: 4 });
  g.box(-0.42, 0.93, 0.2, -0.3, 0.97, 0.36, { part: 4, topPart: 4 });
  return g;
}
function protoPlatte(): GB {
  const g = new GB();
  g.box(-0.5, 0, -0.5, 0.5, 0.95, 0.5, { f: 1, endF: -1, topPart: 1 });
  g.box(-0.3, 0.95, -0.2, -0.18, 1.0, 0.2, { part: 4, topPart: 4 });
  g.box(0.2, 0.95, -0.2, 0.32, 1.0, 0.2, { part: 4, topPart: 4 });
  return g;
}
function protoHall(): GB {
  const g = new GB();
  const e = 0.6;
  g.box(-0.5, 0, -0.5, 0.5, e, 0.5, { f: 4, endF: 4, top: 0 });
  const n = 4;
  for (let k = 0; k < n; k++) {
    const x0 = -0.5 + k * (1 / n), x1 = x0 + 1 / n;
    // Schräge (Dach) steigt nach +x, senkrechte Fensterfläche (Nordlicht) fällt ab
    g.quad([x0, e, 0.5], [x1, 0.92, 0.5], [x1, 0.92, -0.5], [x0, e, -0.5], [0, 1, 0], -1, 0, 1);
    g.quad([x1, e, 0.5], [x1, e, -0.5], [x1, 0.92, -0.5], [x1, 0.92, 0.5], [1, 0, 0], 4, 1, 0, 1, 0.3);
    g.tri([x0, e, 0.5], [x1, e, 0.5], [x1, 0.92, 0.5], [0, 0, 1], -1, 0, 0);
    g.tri([x1, e, -0.5], [x0, e, -0.5], [x1, 0.92, -0.5], [0, 0, -1], -1, 0, 0);
  }
  g.box(-0.4, 0.58, -0.1, -0.2, 0.7, 0.1, { part: 4, topPart: 4 });
  return g;
}
function protoSilo(): GB {
  const g = new GB();
  g.tube(0, 0, 0, 0.78, 0.5, 0.5, 8, 4, -1);
  g.tube(0, 0, 0.78, 0.92, 0.5, 0.3, 8, 4, -1);
  g.tube(0, 0, 0.92, 1.0, 0.3, 0.05, 8, 2, 2);
  return g;
}
function protoStack(): GB {
  const g = new GB();
  g.tube(0, 0, 0, 0.3, 0.5, 0.42, 8, 0, -1);
  g.tube(0, 0, 0.3, 0.55, 0.42, 0.36, 8, 3, -1);
  g.tube(0, 0, 0.55, 0.8, 0.36, 0.31, 8, 0, -1);
  g.tube(0, 0, 0.8, 1.0, 0.31, 0.27, 8, 3, 2);
  return g;
}
function protoTower(): GB {
  const g = new GB();
  g.box(-0.5, 0, -0.5, 0.5, 0.66, 0.5, { f: 3, endF: 3, topPart: 4 });
  g.box(-0.38, 0.66, -0.38, 0.38, 0.86, 0.38, { f: 7, endF: 7, topPart: 4 });
  g.box(-0.26, 0.86, -0.26, 0.26, 0.96, 0.26, { f: 7, endF: 7, topPart: 4 });
  g.box(-0.04, 0.96, -0.04, 0.04, 1.0, 0.04, { part: 2, topPart: 2 });
  g.box(-0.18, 0.96, 0.05, -0.08, 0.985, 0.17, { part: 4, topPart: 4 });
  return g;
}
function protoChurch(): GB {
  const g = new GB();
  g.box(-0.5, 0, -0.3, 0.15, 0.26, 0.3, { f: 5, endF: -1, top: 0 });
  g.gable(-0.5, 0.15, 0.26, 0.4, -0.3, 0.3);
  g.box(0.15, 0, -0.17, 0.5, 0.5, 0.17, { f: 5, endF: 5, topPart: 2 });
  g.pyramid(0.325, 0, 0.17, 0.17, 0.5, 1.0, 1);
  return g;
}
function protoWare(): GB {
  const g = new GB();
  g.box(-0.5, 0, -0.5, 0.5, 0.8, 0.5, { f: 4, endF: -1, top: 0 });
  g.gable(-0.5, 0.5, 0.8, 0.96, -0.5, 0.5);
  g.box(0.3, 0.8, -0.1, 0.42, 1.0, 0.1, { part: 4, topPart: 4 });
  return g;
}
function protoVilla(): GB {
  const g = new GB();
  const e = 0.52, r = 0.92;
  g.box(-0.5, 0, -0.5, 0.5, e, 0.5, { f: 6, endF: 6, top: 0 });
  g.gable(-0.5, 0.5, e, r, -0.5, 0.5, 0);
  g.box(0.22, r - 0.08, -0.05, 0.3, 1.0, 0.05, { part: 3, topPart: 2 });
  g.box(-0.24, 0, 0.5, 0.1, 0.3, 0.72, { f: 6, endF: -1, topPart: 1 });
  return g;
}
function protoBarn(): GB {
  const g = new GB();
  g.box(-0.5, 0, -0.5, 0.5, 0.42, 0.5, { f: -1, endF: -1, top: 0 });
  g.gable(-0.5, 0.5, 0.42, 1.0, -0.5, 0.5, 0);
  return g;
}
function protoFar(top: number): GB {
  const g = new GB();
  g.box(-0.5, 0, -0.5, 0.5, top, 0.5, { f: -1, endF: -1, topPart: 1 });
  return g;
}

interface Proto {
  g0: THREE.BufferGeometry;
  g1: THREE.BufferGeometry;
}
let PROTOS: Proto[] | null = null;
let FAR_GEO: THREE.BufferGeometry | null = null;
function getProtos(): Proto[] {
  if (!PROTOS) {
    const mk = [protoOld, protoHip, protoMid, protoPlatte, protoHall, protoSilo, protoStack, protoTower, protoChurch, protoWare, protoVilla, protoBarn];
    PROTOS = mk.map((f, i) => ({ g0: f().build(), g1: protoFar(FAR_TOP[i]).build() }));
  }
  return PROTOS;
}
function getFarGeo(): THREE.BufferGeometry {
  if (!FAR_GEO) FAR_GEO = protoFar(1).build();
  return FAR_GEO;
}

// ====================================================================== Fensteratlas + Material

const ATLAS_T = 16;
const ATLAS_F = 8;

function buildAtlas(): { tex: THREE.DataTexture; avg: THREE.Vector4[] } {
  const W = ATLAS_T;
  const d = new Uint8Array(W * ATLAS_T * ATLAS_F * 4);
  const rect = (f: number, x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number, a: number) => {
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const o = ((f * ATLAS_T + y) * W + x) * 4;
        d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = a;
      }
  };
  const wall = (f: number, v: number) => rect(f, 0, 0, W, ATLAS_T, v, v, v, 0);
  // 0 Altbau: Fensterrahmen, Sims, Sprossen
  wall(0, 228);
  rect(0, 4, 3, 12, 14, 255, 255, 255, 0);
  rect(0, 3, 2, 13, 3, 200, 200, 200, 0);
  rect(0, 5, 5, 11, 13, 14, 18, 26, 255);
  rect(0, 7, 5, 9, 13, 235, 235, 235, 0);
  rect(0, 5, 9, 11, 10, 235, 235, 235, 0);
  // 1 Plattenbau: Fugen, Brüstungsband, breite Fenster
  wall(1, 214);
  rect(1, 0, 0, W, 1, 168, 168, 168, 0);
  rect(1, 0, 0, 1, ATLAS_T, 168, 168, 168, 0);
  rect(1, 1, 2, 15, 5, 160, 160, 160, 0);
  rect(1, 3, 6, 13, 13, 16, 21, 28, 255);
  rect(1, 8, 6, 9, 13, 220, 220, 220, 0);
  // 2 Wohnbau mit Balkonen
  wall(2, 232);
  rect(2, 1, 3, 15, 5, 150, 150, 150, 0);
  rect(2, 4, 6, 12, 14, 18, 22, 30, 255);
  rect(2, 8, 6, 9, 14, 230, 230, 230, 0);
  // 3 Glasfassade (Büro)
  wall(3, 90);
  rect(3, 0, 3, W, ATLAS_T, 52, 84, 100, 255);
  rect(3, 0, 3, 1, ATLAS_T, 70, 70, 70, 0);
  rect(3, 8, 3, 9, ATLAS_T, 70, 70, 70, 0);
  // 4 Industrie: Wellblech + Fensterband
  wall(4, 224);
  for (let x = 0; x < W; x += 2) rect(4, x, 0, x + 1, ATLAS_T, 196, 196, 196, 0);
  rect(4, 0, 0, W, 2, 140, 140, 140, 0);
  rect(4, 1, 9, 15, 13, 20, 28, 32, 255);
  // 5 Kirche: hohe Spitzbogenfenster
  wall(5, 236);
  rect(5, 5, 3, 11, 15, 255, 255, 255, 0);
  rect(5, 6, 4, 10, 13, 26, 32, 52, 255);
  rect(5, 7, 13, 9, 15, 26, 32, 52, 255);
  // 6 Villa: Fenster mit Läden
  wall(6, 242);
  rect(6, 2, 5, 5, 12, 120, 130, 110, 0);
  rect(6, 11, 5, 14, 12, 120, 130, 110, 0);
  rect(6, 5, 5, 11, 12, 18, 24, 32, 255);
  rect(6, 8, 5, 9, 12, 240, 240, 240, 0);
  // 7 Turm: durchgehendes Glas
  wall(7, 80);
  rect(7, 0, 1, W, ATLAS_T, 70, 108, 126, 255);
  rect(7, 0, 1, 1, ATLAS_T, 60, 60, 60, 0);
  rect(7, 8, 1, 9, ATLAS_T, 60, 60, 60, 0);
  const avg: THREE.Vector4[] = [];
  for (let f = 0; f < ATLAS_F; f++) {
    let wm = 0, gr = 0, gg = 0, gb = 0;
    for (let y = 0; y < ATLAS_T; y++)
      for (let x = 0; x < W; x++) {
        const o = ((f * ATLAS_T + y) * W + x) * 4;
        if (d[o + 3] > 127) { gr += d[o]; gg += d[o + 1]; gb += d[o + 2]; } else wm += d[o];
      }
    const N = W * ATLAS_T * 255;
    avg.push(new THREE.Vector4(wm / N, gr / N, gg / N, gb / N));
  }
  const tex = new THREE.DataTexture(d, W, ATLAS_T * ATLAS_F, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return { tex, avg };
}

const B_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
#include <fog_pars_vertex>
attribute vec3 aSurf;
attribute vec2 aSize;
attribute vec4 aRoof;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uVis;
uniform float uWinScale;
uniform float uHS;
uniform float uNight;
uniform vec2 uPitch[8];
varying vec3 vLight;
varying vec2 vCell;
varying vec3 vSurf;
varying vec3 vWall;
varying vec3 vRoof;
varying float vFlag;
varying float vSeed;
varying float vAO;
void main() {
  mat3 R = mat3(instanceMatrix);
  vec3 sc = vec3(length(R[0]), length(R[1]), length(R[2]));
  mat3 Rn = mat3(R[0] / sc.x, R[1] / sc.y, R[2] / sc.z);
  vec3 n = normalize(Rn * (normal / sc));
  vec3 lp = position * uVis;
  vec4 wp = instanceMatrix * vec4(lp, 1.0);
  vec3 amb = mix(vec3(0.24, 0.21, 0.17), vec3(0.50, 0.56, 0.66), n.y * 0.5 + 0.5) * 0.62;
  float ndl = max(dot(n, uSunDir), 0.0);
  vLight = (amb + uSunColor * ndl * 0.95) * 1.12 * (1.0 - 0.55 * uNight);
  float fi = max(aSurf.x, 0.0);
  vec2 pf = uPitch[int(fi + 0.5)];
  float faceW = (aSurf.y < 0.5 ? sc.x : sc.z) * aSize.x;
  float faceH = sc.y * aSize.y;
  vCell = uv * vec2(max(1.0, floor(faceW / (pf.x * uWinScale) + 0.5)), max(1.0, floor(faceH / (pf.y * uHS * uWinScale) + 0.5)));
  vSurf = aSurf;
  vWall = instanceColor;
  vRoof = aRoof.rgb;
  vFlag = aRoof.w;
  vSeed = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453);
  vAO = mix(0.7, 1.0, smoothstep(0.0, 0.14, position.y));
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

const B_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
#include <fog_pars_fragment>
uniform sampler2D uAtlas;
uniform vec4 uAvg[8];
uniform float uNight;
varying vec3 vLight;
varying vec2 vCell;
varying vec3 vSurf;
varying vec3 vWall;
varying vec3 vRoof;
varying float vFlag;
varying float vSeed;
varying float vAO;
float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  #include <logdepthbuf_fragment>
  float part = vSurf.z;
  vec3 base = vWall;
  if (part > 0.5 && part < 1.5) base = vRoof;
  else if (part > 1.5 && part < 2.5) base = vec3(0.045, 0.045, 0.05);
  else if (part > 2.5 && part < 3.5) base = vec3(0.30, 0.13, 0.09);
  else if (part > 3.5) base = vWall * 0.82 + 0.03;
  base *= 0.93 + 0.14 * vSeed;
  vec3 col = base;
  vec3 emis = vec3(0.0);
  if (vFlag > 0.5) {
    col = base * (0.85 + 0.3 * hash21(floor(gl_FragCoord.xy * 0.5)));
  } else if (vSurf.x > -0.5 && part < 0.5) {
    int fi = int(vSurf.x + 0.5);
    vec2 fw = fwidth(vCell);
    float aa = max(fw.x, fw.y);
    vec4 t = texture2D(uAtlas, vec2(fract(vCell.x), (float(fi) + fract(vCell.y)) / 8.0));
    vec3 tex = t.a > 0.5 ? t.rgb : base * t.rgb;
    vec4 av = uAvg[fi];
    vec3 avg = base * av.x + av.yzw;
    col = mix(tex, avg, smoothstep(0.3, 0.75, aa));
    if (t.a > 0.5 && uNight > 0.01) {
      vec2 cid = floor(vCell) + vSeed * 91.0;
      float lit = step(0.58, hash21(cid)) * (1.0 - smoothstep(0.3, 0.75, aa));
      emis = vec3(1.0, 0.78, 0.42) * lit * uNight * 1.3;
    }
  }
  col *= vAO;
  gl_FragColor = vec4(col * vLight + emis, 1.0);
  #include <fog_fragment>
}
`;

export interface BuildingMaterial extends THREE.ShaderMaterial {
  uniforms: Record<string, THREE.IUniform>;
}

let SHARED_MAT: BuildingMaterial | null = null;
/** Gemeinsames Gebäudematerial (Fensteratlas, Vertex-Licht, Nebel, logarithmischer Tiefenpuffer). */
export function getBuildingMaterial(): BuildingMaterial {
  if (SHARED_MAT) return SHARED_MAT;
  const { tex, avg } = buildAtlas();
  const pitch = [
    [0.0105, 0.0034], [0.0115, 0.0034], [0.0105, 0.003], [0.009, 0.0038], [0.014, 0.009], [0.012, 0.01], [0.0115, 0.0033], [0.008, 0.0038],
  ].map((p) => new THREE.Vector2(p[0], p[1]));
  SHARED_MAT = new THREE.ShaderMaterial({
    vertexShader: B_VERT,
    fragmentShader: B_FRAG,
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uAtlas: { value: tex },
      uAvg: { value: avg },
      uPitch: { value: pitch },
      uSunDir: { value: SUN_DIR.clone() },
      uSunColor: { value: SUN_COLOR.clone() },
      uVis: { value: 1 },
      uWinScale: { value: 1 },
      uHS: { value: 2.25 },
      uNight: { value: 0 },
    },
    fog: true,
  }) as BuildingMaterial;
  SHARED_MAT.name = 'BuildingMaterial';
  return SHARED_MAT;
}

// ====================================================================== Gebäude-Layer (Kacheln, LOD, Instanzen)

interface LTile {
  x0: number; x1: number; z0: number; z1: number;
  meshes: Array<THREE.InstancedMesh | null>;
  ids: number[][];
  far: THREE.InstancedMesh | null;
  farIds: number[];
  lod: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _ax = new THREE.Vector3();
const _col = new THREE.Color();
const _rc = new THREE.Color();

/**
 * Gebäude-Instanzen, nach Kacheln gruppiert: je Kachel und Typ ein InstancedMesh (Detail) plus ein einfaches
 * Quader-Mesh (Fern-LOD). Daten-Layout wie Cities (STRIDE) + Typ + Dachfarbe.
 */
export class BuildingLayer {
  readonly group = new THREE.Group();
  readonly count: number;
  private readonly tiles: LTile[] = [];
  private readonly tileOf: Int32Array;
  private readonly slotNear: Int32Array;
  private readonly slotFar: Int32Array;
  private readonly mat: BuildingMaterial;
  private exag = 6;
  private readonly dirtyMeshes = new Set<THREE.InstancedMesh>();

  constructor(
    readonly data: Float32Array,
    readonly typ: Uint8Array,
    readonly roof: Uint32Array,
    private readonly integrity: Float32Array,
    tileKm = TILE_KM,
  ) {
    this.count = typ.length;
    this.mat = getBuildingMaterial();
    const protos = getProtos();
    const farGeo = getFarGeo();
    this.tileOf = new Int32Array(this.count);
    this.slotNear = new Int32Array(this.count);
    this.slotFar = new Int32Array(this.count);
    const map = new Map<number, number>();
    for (let i = 0; i < this.count; i++) {
      const tx = Math.floor(data[i * STRIDE] / tileKm), tz = Math.floor(data[i * STRIDE + 1] / tileKm);
      const key = tx * 100003 + tz;
      let ti = map.get(key);
      if (ti === undefined) {
        ti = this.tiles.length;
        map.set(key, ti);
        this.tiles.push({ x0: tx * tileKm, x1: (tx + 1) * tileKm, z0: tz * tileKm, z1: (tz + 1) * tileKm, meshes: new Array(BT_COUNT).fill(null), ids: Array.from({ length: BT_COUNT }, () => []), far: null, farIds: [], lod: -2 });
      }
      this.tileOf[i] = ti;
      const t = this.tiles[ti];
      this.slotNear[i] = t.ids[typ[i]].length;
      t.ids[typ[i]].push(i);
      this.slotFar[i] = t.farIds.length;
      t.farIds.push(i);
    }
    for (const t of this.tiles) {
      for (let k = 0; k < BT_COUNT; k++) {
        const n = t.ids[k].length;
        if (!n) continue;
        const roofAttr = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
        const g0 = new THREE.BufferGeometry();
        for (const name of ['position', 'normal', 'uv', 'aSurf', 'aSize']) g0.setAttribute(name, protos[k].g0.getAttribute(name));
        g0.setIndex(protos[k].g0.getIndex());
        g0.setAttribute('aRoof', roofAttr);
        const mesh = new THREE.InstancedMesh(g0, this.mat, n);
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
        mesh.matrixAutoUpdate = false;
        mesh.visible = false;
        mesh.name = `Bld${k}`;
        t.meshes[k] = mesh;
        this.group.add(mesh);
      }
      const n = t.farIds.length;
      const roofAttr = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
      const g = new THREE.BufferGeometry();
      for (const name of ['position', 'normal', 'uv', 'aSurf', 'aSize']) g.setAttribute(name, farGeo.getAttribute(name));
      g.setIndex(farGeo.getIndex());
      g.setAttribute('aRoof', roofAttr);
      const far = new THREE.InstancedMesh(g, this.mat, n);
      far.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
      far.matrixAutoUpdate = false;
      far.visible = false;
      far.name = 'BldFar';
      t.far = far;
      this.group.add(far);
    }
  }

  /** Instanz i aus Daten/Zustand neu berechnen (Matrix, Farben, Flags). */
  place(i: number): void {
    const e = this.exag;
    const o = i * STRIDE, d = this.data;
    const integ = this.integrity[i];
    const hScale = 1 + (e - 1) * 0.25;
    let sx = d[o + 2], sy = d[o + 3] * hScale + SINK, sz = d[o + 4];
    _q.setFromAxisAngle(_up, d[o + 5]);
    _col.setHex(d[o + 7]);
    _rc.setHex(this.roof[i]);
    let flag = 0;
    if (integ <= 0) {
      sy = RUBBLE_MIN_H + d[o + 3] * RUBBLE_FRAC * 0.5 + SINK;
      sx *= 1.12; sz *= 1.12;
      _col.setHex(RUBBLE_COLOR);
      _rc.setHex(RUBBLE_COLOR);
      flag = 1;
      _q2.setFromAxisAngle(_ax.set(Math.cos(i * 2.1), 0, Math.sin(i * 2.1)), 0.09);
      _q.multiply(_q2);
    } else if (integ < BUILDING_DAMAGED_BELOW) {
      const k = 1 - integ / BUILDING_DAMAGED_BELOW;
      sy = d[o + 3] * (1 - 0.3 * k) * hScale + SINK;
      const dk = 0.62 - 0.22 * k;
      _col.multiplyScalar(dk);
      _rc.multiplyScalar(dk);
      _q2.setFromAxisAngle(_ax.set(Math.cos(i * 1.7), 0, Math.sin(i * 1.7)), 0.05 + 0.12 * k);
      _q.multiply(_q2);
    }
    _p.set(d[o], d[o + 6] * e - SINK, d[o + 1]);
    _s.set(sx, sy, sz);
    _m.compose(_p, _q, _s);
    const t = this.tiles[this.tileOf[i]];
    const mesh = t.meshes[this.typ[i]]!;
    const s = this.slotNear[i];
    _m.toArray(mesh.instanceMatrix.array as Float32Array, s * 16);
    (mesh.instanceColor!.array as Float32Array).set([_col.r, _col.g, _col.b], s * 3);
    ((mesh.geometry.getAttribute('aRoof') as THREE.InstancedBufferAttribute).array as Float32Array).set([_rc.r, _rc.g, _rc.b, flag], s * 4);
    this.dirtyMeshes.add(mesh);
    // Fern-LOD
    const far = t.far!;
    const fs = this.slotFar[i];
    _s.y = sy * (flag ? 1 : FAR_TOP[this.typ[i]]);
    _m.compose(_p, _q, _s);
    _m.toArray(far.instanceMatrix.array as Float32Array, fs * 16);
    (far.instanceColor!.array as Float32Array).set([_col.r, _col.g, _col.b], fs * 3);
    ((far.geometry.getAttribute('aRoof') as THREE.InstancedBufferAttribute).array as Float32Array).set([_rc.r, _rc.g, _rc.b, flag], fs * 4);
    this.dirtyMeshes.add(far);
  }

  flush(): void {
    if (!this.dirtyMeshes.size) return;
    for (const m of this.dirtyMeshes) {
      m.instanceMatrix.needsUpdate = true;
      m.instanceColor!.needsUpdate = true;
      (m.geometry.getAttribute('aRoof') as THREE.InstancedBufferAttribute).needsUpdate = true;
    }
    this.dirtyMeshes.clear();
  }

  setExag(e: number): void {
    this.exag = e;
    for (let i = 0; i < this.count; i++) this.place(i);
    this.flush();
    // Hüllkugeln je Kachel neu bestimmen (Höhenüberhöhung geändert)
    const hScale = 1 + (e - 1) * 0.25;
    const d = this.data;
    for (const t of this.tiles) {
      const meshes: THREE.InstancedMesh[] = [];
      for (const m of t.meshes) if (m) meshes.push(m);
      if (t.far) meshes.push(t.far);
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y0 = Infinity, y1 = -Infinity, hw = 0;
      for (const i of t.farIds) {
        const o = i * STRIDE;
        x0 = Math.min(x0, d[o]); x1 = Math.max(x1, d[o]); z0 = Math.min(z0, d[o + 1]); z1 = Math.max(z1, d[o + 1]);
        y0 = Math.min(y0, d[o + 6] * e); y1 = Math.max(y1, d[o + 6] * e + d[o + 3] * hScale + 0.05);
        hw = Math.max(hw, Math.hypot(d[o + 2], d[o + 4]));
      }
      const c = new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
      const r = Math.hypot((x1 - x0) / 2 + hw, (y1 - y0) / 2 + 0.1, (z1 - z0) / 2 + hw) * 1.1;
      for (const m of meshes) m.boundingSphere = new THREE.Sphere(c.clone(), r);
    }
  }

  /** LOD je Kachel nach Kameraabstand; visScale = strategische Gebäudeskalierung. */
  update(cam: THREE.Vector3, enabled: boolean, lod0 = LOD0_DIST, lod1 = LOD1_DIST): void {
    this.flush();
    for (const t of this.tiles) {
      let lod = -1;
      if (enabled) {
        const dx = Math.max(t.x0 - cam.x, 0, cam.x - t.x1), dz = Math.max(t.z0 - cam.z, 0, cam.z - t.z1);
        const dd = Math.hypot(dx, dz, cam.y);
        lod = dd < lod0 ? 0 : dd < lod1 ? 1 : -1;
      }
      if (lod === t.lod) continue;
      t.lod = lod;
      for (const m of t.meshes) if (m) m.visible = lod === 0;
      if (t.far) t.far.visible = lod === 1;
    }
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }
}

// ====================================================================== Stadtboden (Straßenraster, Parks)

const F_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
#include <fog_pars_vertex>
attribute vec2 aUv;
uniform float uLift;
varying vec2 vUv;
void main() {
  vUv = aUv;
  vec3 p = position;
  p.y += uLift;
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;
const F_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
#include <fog_pars_fragment>
uniform sampler2D uKinds;
uniform float uN;
uniform float uNight;
varying vec2 vUv;
vec3 srgb(vec3 c) { return pow(c, vec3(2.2)); }
float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  #include <logdepthbuf_fragment>
  vec2 cell = vUv * uN;
  vec2 ic = floor(cell);
  vec2 f = fract(cell);
  float k = texture2D(uKinds, (ic + 0.5) / uN).r * 255.0;
  if (k < 0.5) discard;
  vec2 fw = fwidth(cell);
  float aa = max(fw.x, fw.y);
  vec2 e = min(f, 1.0 - f);
  float de = min(e.x, e.y);
  float blk = smoothstep(0.07, 0.07 + max(0.018, aa), de);
  float walk = smoothstep(0.1, 0.1 + max(0.018, aa), de);
  vec3 asphalt = srgb(vec3(0.24, 0.24, 0.25));
  vec3 side = srgb(vec3(0.5, 0.48, 0.44));
  vec3 inner = srgb(vec3(0.46, 0.43, 0.38));
  if (k > 1.5 && k < 2.5) inner = srgb(vec3(0.27, 0.42, 0.2));
  else if (k > 2.5 && k < 3.5) inner = srgb(vec3(0.5, 0.49, 0.45));
  else if (k > 3.5 && k < 4.5) inner = srgb(vec3(0.34, 0.46, 0.24));
  else if (k > 4.5 && k < 5.5) inner = srgb(vec3(0.38, 0.47, 0.27));
  else if (k > 5.5) inner = srgb(vec3(0.62, 0.59, 0.52));
  float g = hash21(floor(vUv * uN * 7.0));
  inner *= 0.86 + 0.28 * g;
  vec3 col = mix(asphalt, side, 1.0 - blk);
  col = mix(col, inner, walk);
  col = mix(col, mix(asphalt, inner, 0.8), smoothstep(0.3, 0.7, aa));
  col *= 1.0 - 0.55 * uNight;
  gl_FragColor = vec4(col, 1.0);
  #include <fog_fragment>
}
`;

interface CityGrid {
  cx: number; cz: number; theta: number; M: number; S: number;
  kinds: Uint8Array;
}

class CityFloor {
  readonly mesh: THREE.Mesh;
  private readonly hKm: Float32Array;
  private readonly pos: Float32Array;
  constructor(geo: GeoData, grid: CityGrid, lift: THREE.IUniform, night: THREE.IUniform) {
    const N = grid.M * 2;
    const size = N * grid.S;
    const seg = Math.max(8, Math.min(48, Math.ceil(size / 0.9)));
    const nv = (seg + 1) * (seg + 1);
    this.pos = new Float32Array(nv * 3);
    this.hKm = new Float32Array(nv);
    const uv = new Float32Array(nv * 2);
    const idx: number[] = [];
    const ca = Math.cos(grid.theta), sa = Math.sin(grid.theta);
    let k = 0;
    for (let j = 0; j <= seg; j++)
      for (let i = 0; i <= seg; i++, k++) {
        const a = (i / seg - 0.5) * size, b = (j / seg - 0.5) * size;
        this.pos[k * 3] = grid.cx + a * ca + b * sa;
        this.pos[k * 3 + 2] = grid.cz - a * sa + b * ca;
        this.hKm[k] = Math.max(0, terrainHeightKm(geo, this.pos[k * 3], this.pos[k * 3 + 2]));
        uv[k * 2] = i / seg;
        uv[k * 2 + 1] = j / seg;
      }
    for (let j = 0; j < seg; j++)
      for (let i = 0; i < seg; i++) {
        const a = j * (seg + 1) + i, b = a + 1, c = a + seg + 1, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('aUv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    const tex = new THREE.DataTexture(grid.kinds, N, N, THREE.RedFormat, THREE.UnsignedByteType);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.unpackAlignment = 1;
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    const mat = new THREE.ShaderMaterial({
      vertexShader: F_VERT,
      fragmentShader: F_FRAG,
      uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), uKinds: { value: tex }, uN: { value: N }, uLift: lift, uNight: night },
      fog: true,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = true;
    this.mesh.name = 'CityFloor';
    this.mesh.renderOrder = 1;
  }

  setExag(e: number): void {
    for (let k = 0; k < this.hKm.length; k++) this.pos[k * 3 + 1] = this.hKm[k] * e;
    const g = this.mesh.geometry;
    (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    g.computeBoundingSphere();
    g.computeBoundingBox();
    g.boundingSphere!.radius += 20;
  }
}

// ====================================================================== Stadtgenerator

const EAST = new Set(['RUS', 'UKR', 'BLR', 'POL', 'ROU', 'BGR', 'HUN', 'CZE', 'SVK', 'MDA', 'SRB', 'LVA', 'LTU', 'EST', 'KOS', 'MKD', 'BIH', 'MNE', 'ALB', 'ARM', 'AZE', 'GEO', 'KAZ']);
const MED = new Set(['ESP', 'PRT', 'ITA', 'GRC', 'MLT', 'TUR', 'CYN', 'SMR', 'MAR', 'DZA', 'TUN', 'EGY', 'ISR', 'LBN', 'SYR', 'JOR', 'IRQ', 'IRN', 'PSX', 'AND']);
const NORDIC = new Set(['NOR', 'SWE', 'FIN', 'DNK', 'ISL']);

export const WALL_WEST = [0xd6cdb4, 0xcbbf9f, 0xb9b09a, 0xc9a98a, 0xc4b79a, 0xa89f8c, 0xbfa891, 0xd2c6a4, 0x9a6a55, 0x8c5e4a, 0xb08468];
export const WALL_MED = [0xe0cfa8, 0xd8b98a, 0xcfa77a, 0xe6dcc0, 0xc79a6c, 0xd9c7a3, 0xe9e2d0];
export const WALL_NORDIC = [0xa14a3a, 0xd9b25a, 0xe8e4d8, 0x7d95a3, 0xb8573f, 0xc9c0a0];
export const WALL_PLATTE = [0xd0ccbf, 0xc4c2b6, 0xb8b7ae, 0xd8d0b8, 0xc4d2c0, 0xdccbb4, 0xbac4c8];
export const WALL_MODERN = [0xc0ccd4, 0xb0bec8, 0xa4b6c0, 0xcdd6d8, 0xb4bec6];
export const WALL_IND = [0xb0b2ae, 0x9aa4b0, 0xbfb29a, 0x93a39a, 0xc4c0b4];
export const ROOF_WEST = [0xb8644a, 0xa65a42, 0xc06c50, 0x8a6048, 0x7a5a48, 0x6e727c, 0x5c6068, 0x7c7f86];
export const ROOF_MED = [0xc8683f, 0xbc5e3a, 0xd47a50, 0xc9754f];
export const ROOF_NORDIC = [0x5a5758, 0x6a524a, 0x8a4a3c, 0x62666e];
export const ROOF_FLAT = [0x8a8884, 0x7a7a7c, 0x9a978f, 0x808286];
export const ROOF_IND = [0x80868a, 0x8c6c58, 0x959a9e, 0x6e757a];

export function pick(a: number[], r: number): number {
  return a[Math.min(a.length - 1, Math.floor(r * a.length))];
}

interface GenLists {
  data: number[];
  typ: number[];
  roof: number[];
}

export class Cities {
  readonly object: THREE.Object3D;
  private readonly geo: GeoData;
  private readonly layer: BuildingLayer;
  private readonly markers: THREE.Points;
  /** Pro Gebäude: x, z, Breite, Höhe, Tiefe, Rotation, Sockelhöhe(km, ohne Überhöhung), Wandfarbe */
  private readonly data: Float32Array;
  private readonly typ: Uint8Array;
  private readonly count: number;
  private readonly cityPos: Float32Array;
  /** Stadt-Index (geo.meta.cities) je Gebäude -> Land */
  private readonly ownerCity: Uint16Array;
  /** 0..1 je Gebäude */
  private readonly integrity: Float32Array;
  /** Besatzung (Soldaten) je Gebäude */
  private readonly garrison: Uint16Array;
  private readonly capacity: Uint8Array;
  private readonly infos: BuildingInfo[];
  private readonly hash = new Map<number, number[]>();
  private maxHalfDiag = 0.5;
  private readonly dirty = new Set<number>();
  private readonly stamp: Uint32Array;
  private stampGen = 0;
  private exag = -1;
  private show = true;
  private readonly floors: CityFloor[] = [];
  private readonly floorGroup = new THREE.Group();
  private readonly lift: THREE.IUniform = { value: 0.02 };
  private readonly night: THREE.IUniform;
  private readonly mat: BuildingMaterial;
  private readonly lists: GenLists = { data: [], typ: [], roof: [] };
  private churches = 0;

  constructor(geo: GeoData, settings: Settings) {
    this.geo = geo;
    const ownerList: number[] = [];
    const grids: CityGrid[] = [];
    geo.meta.cities.forEach((city, ci) => {
      const before = this.lists.typ.length;
      const g = this.generateCity(city.name, city.pos[0], city.pos[1], city.pop, city.capital, city.country);
      for (let k = before; k < this.lists.typ.length; k++) ownerList.push(ci);
      if (g) grids.push(g);
    });
    this.data = new Float32Array(this.lists.data);
    this.typ = Uint8Array.from(this.lists.typ);
    this.count = this.typ.length;
    const roof = Uint32Array.from(this.lists.roof);
    this.lists.data = []; this.lists.typ = []; this.lists.roof = [];
    this.ownerCity = Uint16Array.from(ownerList);
    this.integrity = new Float32Array(this.count).fill(1);
    this.garrison = new Uint16Array(this.count);
    this.capacity = new Uint8Array(this.count);
    this.stamp = new Uint32Array(this.count);
    this.infos = new Array(this.count);
    this.buildRegistry();

    this.layer = new BuildingLayer(this.data, this.typ, roof, this.integrity);
    this.mat = getBuildingMaterial();
    this.night = this.mat.uniforms.uNight;

    // Stadtböden
    for (const g of grids) {
      const f = new CityFloor(geo, g, this.lift, this.night);
      this.floors.push(f);
      this.floorGroup.add(f.mesh);
    }

    // Marker
    const cities = geo.meta.cities;
    const c = new THREE.Color();
    this.cityPos = new Float32Array(cities.length * 3);
    const colors = new Float32Array(cities.length * 3);
    cities.forEach((city, i) => {
      this.cityPos[i * 3] = city.pos[0];
      this.cityPos[i * 3 + 2] = city.pos[1];
      c.setHex(city.capital ? 0xd8c27a : 0xb8b4a8);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    });
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(this.cityPos, 3));
    pg.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.markers = new THREE.Points(
      pg,
      new THREE.PointsMaterial({ size: 3, sizeAttenuation: false, vertexColors: true, fog: false, depthWrite: false }),
    );
    this.markers.name = 'CityMarkers';
    this.markers.renderOrder = 5;
    this.markers.frustumCulled = false;

    const group = new THREE.Group();
    group.name = 'Cities';
    this.floorGroup.name = 'CityFloors';
    group.add(this.floorGroup, this.layer.group, this.markers);
    this.object = group;
    this.applySettings(settings);
  }

  // ------------------------------------------------------------------ Generierung

  private isWater(x: number, z: number): boolean {
    const g = this.geo;
    const i = Math.floor(x / g.cellKm), j = Math.floor(z / g.cellKm);
    if (i < 0 || j < 0 || i >= g.width || j >= g.height) return true;
    return g.waterFlags[j * g.width + i] !== 0;
  }

  private landOk(x: number, z: number): boolean {
    return this.geo.countryAt(x, z) !== 0 && this.geo.heightAt(x, z) > 0.001 && !this.isWater(x, z);
  }

  private add(x: number, z: number, w: number, h: number, d: number, rot: number, type: number, wall: number, roof: number): boolean {
    if (!this.landOk(x, z)) return false;
    const hw = Math.max(w, d) * 0.6;
    const g = this.geo;
    const base = Math.min(terrainHeightKm(g, x - hw, z - hw), terrainHeightKm(g, x + hw, z - hw), terrainHeightKm(g, x - hw, z + hw), terrainHeightKm(g, x + hw, z + hw), terrainHeightKm(g, x, z));
    this.lists.data.push(x, z, w, h, d, rot, Math.max(0.0005, base), wall);
    this.lists.typ.push(type);
    this.lists.roof.push(roof);
    return true;
  }

  private generateCity(name: string, cx: number, cz: number, pop: number, capital: boolean, country: string): CityGrid | null {
    const rnd = rngFrom(name);
    const popM = Math.max(0.02, pop / 1e6);
    const R = cityRadiusKm(pop, capital);
    const [lon, lat] = this.geo.worldToLonLat(cx, cz);
    let style = 0; // 0 West, 1 Ost (Platte), 2 Mittelmeer, 3 Nordisch
    if (EAST.has(country) || (country === 'DEU' && lon > 11.2 && lat > 50.4)) style = 1;
    else if (MED.has(country) || lat < 43.2) style = 2;
    else if (NORDIC.has(country) || lat > 58) style = 3;
    const wallOld = style === 2 ? WALL_MED : style === 3 ? WALL_NORDIC : WALL_WEST;
    const roofOld = style === 2 ? ROOF_MED : style === 3 ? ROOF_NORDIC : ROOF_WEST;
    const theta = rnd() * Math.PI;
    const S = 0.2;
    const M = Math.ceil((R * 1.2) / S);
    const N = M * 2;
    const kinds = new Uint8Array(N * N);
    const cap = Math.min(3600, Math.round(90 + Math.sqrt(popM) * 850 + (capital ? 150 : 0)));
    const sectV: number[] = [];
    for (let k = 0; k < 8; k++) sectV.push(rnd());
    const nInd = popM > 0.4 ? 2 : 1;
    const indA: number[] = [];
    for (let k = 0; k < nInd; k++) indA.push(rnd() * Math.PI * 2);
    const hi = popM > 0.5;
    const towerTarget = hi ? Math.min(26, Math.round(popM * 2.6) + 3) : 0;
    const maxChurch = Math.min(7, 1 + Math.floor(popM * 2));
    let churches = 0, towers = 0;
    let ou = 0, ov = 0;
    const ca = Math.cos(theta), sa = Math.sin(theta);
    // a-Achse = lokale x-Achse der Gebäude (rot = theta), b-Achse = lokale z-Achse
    const emit = (a: number, b: number, w: number, h: number, d: number, rotLocal: number, type: number, wall: number, roof: number, jitter = 0): void => {
      const rj = jitter ? (rnd() - 0.5) * jitter : 0;
      a += ou; b += ov;
      this.add(cx + a * ca + b * sa, cz - a * sa + b * ca, w, h, d, theta + rotLocal + rj, type, wall, roof);
    };

    interface Cell { i: number; j: number; f: number }
    const cells: Cell[] = [];
    for (let j = -M; j < M; j++)
      for (let i = -M; i < M; i++) {
        const u = (i + 0.5) * S, v = (j + 0.5) * S;
        const ang = Math.atan2(v, u) / (Math.PI * 2) + 0.5; // 0..1
        const sp = ang * 8, k0 = Math.floor(sp) % 8, k1 = (k0 + 1) % 8, t = sp - Math.floor(sp);
        const outline = sectV[k0] * (1 - t) + sectV[k1] * t;
        const Rf = R * (0.78 + 0.4 * outline);
        const f = Math.hypot(u, v) / Rf;
        if (f <= 1) cells.push({ i, j, f });
      }
    cells.sort((p, q) => p.f - q.f);
    let n = 0;
    for (const cell of cells) {
      if (n >= cap) break;
      const { i, j, f } = cell;
      const pFill = Math.max(0.3, Math.min(1, 1.12 - 0.72 * Math.pow(f, 2.2)));
      if (rnd() > pFill) continue;
      const u0 = (i + 0.5) * S + (rnd() - 0.5) * 0.02, v0 = (j + 0.5) * S + (rnd() - 0.5) * 0.02;
      ou = u0; ov = v0;
      const wx = cx + u0 * ca + v0 * sa, wz = cz - u0 * sa + v0 * ca;
      if (!this.landOk(wx, wz)) continue;
      const ang = Math.atan2(v0, u0) + Math.PI;
      let inInd = false;
      if (f > 0.42 && f < 0.97) for (const ia of indA) {
        let da = Math.abs(ang - ia);
        if (da > Math.PI) da = Math.PI * 2 - da;
        if (da < 0.5) inInd = true;
      }
      const before = this.lists.typ.length;
      let kind = 1;
      const Bh = 0.085;
      if (inInd) {
        kind = 3;
        const variant = rnd();
        const wall = pick(WALL_IND, rnd()), roof = pick(ROOF_IND, rnd());
        if (variant < 0.4) {
          for (const sb of [-0.05, 0.05]) emit(u0 * 0 + (rnd() - 0.5) * 0.02 + 0, sb, 0.15, 0.011 + rnd() * 0.004, 0.055, 0, BT.HALL, wall, roof);
        } else if (variant < 0.7) {
          emit(-0.055, 0.04, 0.04, 0.03 + rnd() * 0.02, 0.04, 0, BT.SILO, 0xb9b5aa, 0x888880);
          emit(0.0, 0.05, 0.04, 0.03 + rnd() * 0.02, 0.04, 0, BT.SILO, 0xb9b5aa, 0x888880);
          emit(0.055, 0.04, 0.04, 0.03 + rnd() * 0.02, 0.04, 0, BT.SILO, 0xb9b5aa, 0x888880);
          emit(0.0, -0.05, 0.12, 0.011, 0.05, 0, BT.WARE, wall, roof);
          if (rnd() < 0.5) emit(-0.06, -0.01, 0.018, 0.06 + rnd() * 0.04, 0.018, 0, BT.STACK, rnd() < 0.5 ? 0xb8b0a4 : 0xb0a090, 0);
        } else {
          for (const sb of [-0.05, 0.05]) emit((rnd() - 0.5) * 0.03, sb, 0.11 + rnd() * 0.04, 0.009 + rnd() * 0.004, 0.05, 0, BT.WARE, wall, roof);
          if (rnd() < 0.35) emit(0.07, 0, 0.02, 0.05 + rnd() * 0.04, 0.02, 0, BT.STACK, 0xb0a090, 0);
        }
      } else if (rnd() < 0.05 && f > 0.14 && f < 0.85) {
        kind = 2; // Park
      } else if (hi && f < 0.2) {
        const r = rnd();
        if (r < 0.55 && towers < towerTarget) {
          kind = rnd() < 0.2 ? 6 : 1;
          towers++;
          const sc = Math.min(1.6, Math.sqrt(popM) / 1.5);
          const hgt = 0.09 + rnd() * 0.12 * sc + (f < 0.08 ? 0.05 * sc : 0);
          const ww = 0.065 + rnd() * 0.035;
          emit((rnd() - 0.5) * 0.04, (rnd() - 0.5) * 0.04, ww, hgt, ww * (0.8 + rnd() * 0.4), 0, BT.TOWER, pick(WALL_MODERN, rnd()), pick(ROOF_FLAT, rnd()), 0);
          for (const [a, b] of [[-0.06, -0.065], [0.06, -0.065], [0, 0.07]]) if (rnd() < 0.8) emit(a, b, 0.06, 0.035 + rnd() * 0.03, 0.04, b < 0 ? 0 : Math.PI, BT.MID, pick(WALL_MODERN, rnd()), pick(ROOF_FLAT, rnd()), 0);
        } else {
          kind = 1;
          this.oldBlock(emit, rnd, Bh, 0.03 + rnd() * 0.02, style === 2 ? BT.HIP : BT.OLD, wallOld, roofOld, true);
        }
      } else if (style === 1 ? f < 0.16 : f < (style === 3 ? 0.26 : 0.36)) {
        kind = 1;
        if (churches < maxChurch && f > 0.06 && rnd() < 0.09) {
          churches++;
          emit(0, 0, 0.075, 0.075, 0.04, rnd() < 0.5 ? 0 : Math.PI, BT.CHURCH, pick(WALL_WEST, rnd()), pick([0x4a4d54, 0x3e424a, 0x5a6a5a], rnd()), 0);
        }
        this.oldBlock(emit, rnd, Bh, 0.017 + rnd() * 0.012 + (f < 0.12 ? 0.006 : 0), style === 2 ? BT.HIP : BT.OLD, wallOld, roofOld, true);
      } else if (style === 1 && f < 0.72) {
        if (rnd() < 0.78) {
          kind = 4;
          this.platteBlock(emit, rnd);
        } else {
          kind = 1;
          this.midBlock(emit, rnd, WALL_PLATTE);
        }
      } else if (style !== 1 && f < 0.64) {
        if (rnd() < 0.5) {
          kind = 1;
          this.midBlock(emit, rnd, style === 2 ? WALL_MED : WALL_PLATTE);
        } else {
          kind = 1;
          this.oldBlock(emit, rnd, Bh, 0.016 + rnd() * 0.01, style === 2 ? BT.HIP : BT.OLD, wallOld, roofOld, false);
        }
      } else {
        kind = 5;
        if (style === 1 && rnd() < 0.25) {
          kind = 4;
          this.platteBlock(emit, rnd);
        } else {
          for (const a of [-0.056, 0, 0.056])
            for (const b of [-0.045, 0.045]) {
              if (rnd() < 0.14) continue;
              const useGable = style !== 2 && rnd() < 0.55;
              const w = 0.026 + rnd() * 0.012, d = 0.022 + rnd() * 0.01;
              emit(a + (rnd() - 0.5) * 0.016, b + (rnd() - 0.5) * 0.016, w, 0.009 + rnd() * 0.005, d, b < 0 ? 0 : Math.PI, useGable ? BT.VILLA : BT.HIP, pick(style === 3 ? WALL_NORDIC : style === 2 ? WALL_MED : WALL_WEST, rnd()), pick(roofOld, rnd()), 0.16);
            }
        }
      }
      const placed = this.lists.typ.length - before;
      n += placed;
      if (placed > 0 || kind === 2) kinds[(j + M) * N + (i + M)] = kind;
    }
    this.churches += churches;
    if (n === 0) return null;
    return { cx, cz, theta, M, S, kinds };
  }

  private oldBlock(emit: (a: number, b: number, w: number, h: number, d: number, rotLocal: number, type: number, wall: number, roof: number, jitter?: number) => void, rnd: () => number, Bh: number, hBase: number, type: number, walls: number[], roofs: number[], tall: boolean): void {
    const dpt = 0.036 + rnd() * 0.008;
    const wallC = pick(walls, rnd());
    const roofC = pick(roofs, rnd());
    const row = (n: number, len: number, offset: number, fixed: number, rotLocal: number, alongA: boolean) => {
      const wts: number[] = [];
      let sum = 0;
      for (let k = 0; k < n; k++) { const w = 0.7 + rnd() * 0.6; wts.push(w); sum += w; }
      let pos = -len / 2 + offset;
      for (let k = 0; k < n; k++) {
        const w = (wts[k] / sum) * len;
        const c = pos + w / 2;
        pos += w;
        if (rnd() < 0.05) continue;
        const h = hBase * (0.8 + rnd() * 0.6) + (tall && rnd() < 0.12 ? 0.012 : 0);
        const wc = rnd() < 0.6 ? wallC : pick(walls, rnd());
        const rc = rnd() < 0.7 ? roofC : pick(roofs, rnd());
        if (alongA) emit(c, fixed, w, h, dpt, rotLocal, type, wc, rc, 0.03);
        else emit(fixed, c, w, h, dpt, rotLocal, type, wc, rc, 0.03);
      }
    };
    row(3, 2 * Bh, 0, Bh - dpt / 2, 0, true);
    row(3, 2 * Bh, 0, -(Bh - dpt / 2), Math.PI, true);
    row(2, 2 * (Bh - dpt), 0, Bh - dpt / 2, Math.PI / 2, false);
    row(2, 2 * (Bh - dpt), 0, -(Bh - dpt / 2), -Math.PI / 2, false);
  }

  private midBlock(emit: (a: number, b: number, w: number, h: number, d: number, rotLocal: number, type: number, wall: number, roof: number, jitter?: number) => void, rnd: () => number, walls: number[]): void {
    for (const b of [-0.045, 0.045])
      for (const a of [-0.045, 0.045]) {
        if (rnd() < 0.22) continue;
        emit(a, b, 0.07 + rnd() * 0.012, 0.022 + rnd() * 0.03, 0.036, b < 0 ? 0 : Math.PI, BT.MID, pick(walls, rnd()), pick(ROOF_FLAT, rnd()), 0.02);
      }
  }

  private platteBlock(emit: (a: number, b: number, w: number, h: number, d: number, rotLocal: number, type: number, wall: number, roof: number, jitter?: number) => void, rnd: () => number): void {
    const sw = rnd() < 0.5;
    const wallC = pick(WALL_PLATTE, rnd());
    const roofC = pick(ROOF_FLAT, rnd());
    const short = rnd() < 0.25;
    for (const b of [-0.058, 0, 0.058]) {
      if (rnd() < 0.1) continue;
      const a = (rnd() - 0.5) * 0.03;
      const w = 0.14 + rnd() * 0.03;
      const h = short ? 0.016 + rnd() * 0.006 : 0.028 + rnd() * 0.012;
      if (sw) emit(b, a, 0.026, h, w, Math.PI / 2 + Math.PI / 2, BT.PLATTE, wallC, roofC, 0);
      else emit(a, b, w, h, 0.026, 0, BT.PLATTE, wallC, roofC, 0);
    }
  }

  // ------------------------------------------------------------------ Rendering

  private placeAll(): void {
    this.layer.setExag(this.exag);
    const e = this.exag;
    for (const f of this.floors) f.setExag(e);
    const cities = this.geo.meta.cities;
    for (let i = 0; i < cities.length; i++) {
      this.cityPos[i * 3 + 1] = Math.max(0, this.geo.heightAt(cities[i].pos[0], cities[i].pos[1])) * e + 1.5;
    }
    const attr = this.markers.geometry.getAttribute('position') as THREE.BufferAttribute;
    attr.needsUpdate = true;
    this.markers.geometry.computeBoundingSphere();
    this.dirty.clear();
  }

  update(camera: THREE.PerspectiveCamera): void {
    this.flushDirty();
    if (!this.show) return;
    const h = camera.position.y;
    const near = h < HIDE_DISTANCE;
    this.layer.setVisible(near);
    this.floorGroup.visible = near;
    this.markers.visible = !near && h < MARKER_MAX_DISTANCE;
    if (near) {
      this.layer.update(camera.position, true);
      // strategische Gebäudeskalierung (Silhouetten bleiben aus der Ferne lesbar) + größere Fenster
      this.mat.uniforms.uVis.value = THREE.MathUtils.clamp(1 + (h - 40) / 220, 1, 2.2);
      this.mat.uniforms.uWinScale.value = THREE.MathUtils.clamp(h / 7, 1, 3.2);
      this.lift.value = THREE.MathUtils.clamp(0.012 + h * 0.0035, 0.012, 8);
    }
  }

  applySettings(s: Settings): void {
    this.show = s.showCities;
    this.object.visible = s.showCities;
    if (s.heightExaggeration !== this.exag) {
      this.exag = s.heightExaggeration;
      this.mat.uniforms.uHS.value = 1 + (this.exag - 1) * 0.25;
      this.placeAll();
    }
  }

  /** Tag/Nacht: 0 = Tag, 1 = Nacht (beleuchtete Fenster, dunklere Gebäude). Wirkt auf alle Gebäude + Stadtböden + Dörfer. */
  setNightFactor(n: number): void {
    this.night.value = Math.max(0, Math.min(1, n));
  }

  /** Gebäudetyp (BT.*) */
  buildingType(id: number): number {
    return this.typ[id];
  }

  /** Mittelpunkte und Radien (km) der Stadtbebauung – für Ausschlusszonen. */
  cityFootprints(): Array<{ x: number; z: number; r: number }> {
    return this.geo.meta.cities.map((c) => ({ x: c.pos[0], z: c.pos[1], r: cityRadiusKm(c.pop, c.capital) * 1.2 }));
  }

  // ------------------------------------------------------------------ Phase 3: Register

  /** Anzahl Gebäude (IDs 0..count-1) */
  get buildingCount(): number {
    return this.count;
  }

  private buildRegistry(): void {
    const d = this.data;
    let maxD = 0;
    for (let i = 0; i < this.count; i++) {
      const o = i * STRIDE;
      const w = d[o + 2], dd = d[o + 4], h = d[o + 3];
      maxD = Math.max(maxD, Math.hypot(w, dd) * 0.5 * 1.12);
      const key = this.cellKey(Math.floor(d[o] / HASH_CELL), Math.floor(d[o + 1] / HASH_CELL));
      let arr = this.hash.get(key);
      if (!arr) this.hash.set(key, (arr = []));
      arr.push(i);
      // Kapazität: Grundfläche + Höhe (Türme mehr), 4..30 Soldaten
      this.capacity[i] = Math.max(4, Math.min(30, Math.round(3 + w * dd * 45 + h * 55)));
    }
    this.maxHalfDiag = Math.max(0.1, maxD);
  }

  private cellKey(cx: number, cz: number): number {
    return cx * 16384 + cz;
  }

  private info(i: number): BuildingInfo {
    let b = this.infos[i];
    if (!b) {
      const o = i * STRIDE, d = this.data;
      b = this.infos[i] = {
        id: i,
        x: d[o], z: d[o + 1], w: d[o + 2], d: d[o + 4], h: d[o + 3], rot: d[o + 5],
        country: this.geo.meta.cities[this.ownerCity[i]]?.country ?? '',
        integrity: this.integrity[i],
        garrisonCapacity: this.capacity[i],
        garrisoned: this.garrison[i],
        civilian: true,
      };
    }
    return b;
  }

  /** Live-Objekt (Felder integrity/garrisoned werden fortlaufend aktualisiert). */
  getBuilding(id: number): BuildingInfo {
    return this.info(id);
  }

  hasBuilding(id: number): boolean {
    return id >= 0 && id < this.count;
  }

  /** true = vollständig eingestürzt (Trümmerhaufen) */
  isCollapsed(id: number): boolean {
    return this.integrity[id] <= 0;
  }

  /** Aktuelle effektive Höhe (km, ohne Überhöhung): Trümmer niedrig, beschädigte etwas niedriger */
  effectiveHeight(id: number): number {
    const h = this.data[id * STRIDE + 3];
    const g = this.integrity[id];
    if (g <= 0) return RUBBLE_MIN_H + h * RUBBLE_FRAC * 0.5;
    if (g < BUILDING_DAMAGED_BELOW) return h * (1 - 0.3 * (1 - g / BUILDING_DAMAGED_BELOW));
    return h;
  }

  /** Bodenhöhe (km, ohne Überhöhung) am Sockel */
  baseKm(id: number): number {
    return this.data[id * STRIDE + 6];
  }

  /** Welt-Y der Dachkante (mit Überhöhung, wie gerendert) */
  topY(id: number): number {
    const e = this.exag > 0 ? this.exag : 1;
    return this.data[id * STRIDE + 6] * e + this.effectiveHeight(id) * (1 + (e - 1) * 0.25);
  }

  /** Abstand (km) von (x,z) zum Grundriss; 0 = innerhalb. */
  private footprintDist(i: number, x: number, z: number): number {
    const o = i * STRIDE, d = this.data;
    const dx = x - d[o], dz = z - d[o + 1];
    const c = Math.cos(d[o + 5]), s = Math.sin(d[o + 5]);
    const lx = Math.abs(c * dx - s * dz) - d[o + 2] * 0.5;
    const lz = Math.abs(s * dx + c * dz) - d[o + 4] * 0.5;
    return Math.hypot(Math.max(lx, 0), Math.max(lz, 0));
  }

  /** Nächstes (nicht eingestürztes) Gebäude, dessen Grundriss höchstens maxKm entfernt ist. */
  findBuildingAt(x: number, z: number, maxKm: number): BuildingInfo | null {
    const m = maxKm + this.maxHalfDiag;
    const c0x = Math.floor((x - m) / HASH_CELL), c1x = Math.floor((x + m) / HASH_CELL);
    const c0z = Math.floor((z - m) / HASH_CELL), c1z = Math.floor((z + m) / HASH_CELL);
    let best = -1, bd = maxKm;
    for (let cz = c0z; cz <= c1z; cz++)
      for (let cx = c0x; cx <= c1x; cx++) {
        const arr = this.hash.get(this.cellKey(cx, cz));
        if (!arr) continue;
        for (const i of arr) {
          if (this.integrity[i] <= 0) continue;
          const dist = this.footprintDist(i, x, z);
          if (dist <= bd) { bd = dist; best = i; }
        }
      }
    return best >= 0 ? this.info(best) : null;
  }

  /** Gebäude, deren Mittelpunkt höchstens r km entfernt ist (inkl. Trümmer). out wird geleert. */
  buildingsInRadius(x: number, z: number, r: number, out: BuildingInfo[]): BuildingInfo[] {
    out.length = 0;
    const c0x = Math.floor((x - r) / HASH_CELL), c1x = Math.floor((x + r) / HASH_CELL);
    const c0z = Math.floor((z - r) / HASH_CELL), c1z = Math.floor((z + r) / HASH_CELL);
    const r2 = r * r;
    const d = this.data;
    for (let cz = c0z; cz <= c1z; cz++)
      for (let cx = c0x; cx <= c1x; cx++) {
        const arr = this.hash.get(this.cellKey(cx, cz));
        if (!arr) continue;
        for (const i of arr) {
          const dx = d[i * STRIDE] - x, dz = d[i * STRIDE + 1] - z;
          if (dx * dx + dz * dz <= r2) out.push(this.info(i));
        }
      }
    return out;
  }

  /**
   * Sichtlinie/Schusslinie: true, wenn ein Gebäude die 2D-Strecke (x0,z0)->(x1,z1) schneidet und die Strahlhöhe
   * dort unter der Gebäudehöhe liegt. h0/h1 = Strahlhöhe über Grund (km) am Anfang/Ende (linear interpoliert).
   * Gebäude, die einen der Endpunkte enthalten (Besatzung/Ziel im Haus), blockieren nicht.
   */
  raycastBlocked(x0: number, z0: number, x1: number, z1: number, h0: number, h1: number): boolean {
    const dx = x1 - x0, dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(len / 0.4));
    const gen = ++this.stampGen;
    if (gen >= 0xfffffff0) { this.stamp.fill(0); this.stampGen = 1; }
    const d = this.data;
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const sx = x0 + dx * t, sz = z0 + dz * t;
      const cx = Math.floor(sx / HASH_CELL), cz = Math.floor(sz / HASH_CELL);
      for (let j = cz - 1; j <= cz + 1; j++)
        for (let i = cx - 1; i <= cx + 1; i++) {
          const arr = this.hash.get(this.cellKey(i, j));
          if (!arr) continue;
          for (const b of arr) {
            if (this.stamp[b] === this.stampGen) continue;
            this.stamp[b] = this.stampGen;
            const o = b * STRIDE;
            const bx = d[o], bz = d[o + 1];
            // grober Abstand Segment <-> Mittelpunkt
            const rx = bx - x0, rz = bz - z0;
            const tt = len > 0 ? Math.max(0, Math.min(1, (rx * dx + rz * dz) / (len * len))) : 0;
            const ex = x0 + dx * tt - bx, ez = z0 + dz * tt - bz;
            const rad = Math.hypot(d[o + 2], d[o + 4]) * 0.5 * 1.01;
            if (ex * ex + ez * ez > rad * rad) continue;
            // in lokale Koordinaten (Rotation um Y)
            const c = Math.cos(d[o + 5]), s = Math.sin(d[o + 5]);
            const hw = d[o + 2] * 0.5 * (this.integrity[b] <= 0 ? 1.12 : 1), hd = d[o + 4] * 0.5 * (this.integrity[b] <= 0 ? 1.12 : 1);
            const ax = c * (x0 - bx) - s * (z0 - bz), az = s * (x0 - bx) + c * (z0 - bz);
            const bxl = c * (x1 - bx) - s * (z1 - bz), bzl = s * (x1 - bx) + c * (z1 - bz);
            // Endpunkt im Gebäude -> ignorieren
            if ((Math.abs(ax) <= hw && Math.abs(az) <= hd) || (Math.abs(bxl) <= hw && Math.abs(bzl) <= hd)) continue;
            // Slab-Clipping
            let t0 = 0, t1 = 1;
            const ddx = bxl - ax, ddz = bzl - az;
            let ok = true;
            for (let axis = 0; axis < 2 && ok; axis++) {
              const p0 = axis === 0 ? ax : az, dd = axis === 0 ? ddx : ddz, half = axis === 0 ? hw : hd;
              if (Math.abs(dd) < 1e-9) { if (Math.abs(p0) > half) ok = false; continue; }
              let ta = (-half - p0) / dd, tb = (half - p0) / dd;
              if (ta > tb) { const q = ta; ta = tb; tb = q; }
              if (ta > t0) t0 = ta;
              if (tb < t1) t1 = tb;
              if (t0 > t1) ok = false;
            }
            if (!ok) continue;
            const bh = this.effectiveHeight(b);
            const rayLow = Math.min(h0 + (h1 - h0) * t0, h0 + (h1 - h0) * t1);
            if (rayLow < bh) return true;
          }
        }
    }
    return false;
  }

  // ------------------------------------------------------------------ Phase 3: Zustand

  /**
   * Schaden als Integritätsverlust (0..1 pro Aufruf; 0.35 = mittelschwerer Treffer). Unter 0.35 beschädigt
   * (dunkler/schief), bei 0 eingestürzt (Trümmerhaufen). Emittiert 'building:damaged' (und 'building:destroyed').
   * x,z = Einschlagpunkt (aktuell nur informativ).
   */
  damageBuilding(id: number, amount: number, _x = 0, _z = 0): void {
    if (!this.hasBuilding(id) || amount <= 0) return;
    const before = this.integrity[id];
    if (before <= 0) return;
    const after = Math.max(0, before - amount);
    this.integrity[id] = after;
    const info = this.info(id);
    info.integrity = after;
    info.h = this.data[id * STRIDE + 3];
    this.dirty.add(id);
    bus.emit('building:damaged', { id, integrity: after });
    if (after <= 0) {
      this.garrison[id] = 0;
      info.garrisoned = 0;
      const o = id * STRIDE;
      const e = this.exag > 0 ? this.exag : 1;
      bus.emit('building:destroyed', { id, x: this.data[o], y: this.data[o + 6] * e + this.data[o + 3] * 0.5, z: this.data[o + 1] });
    }
  }

  /** Gebäude instand setzen (Test/Skripte): integrity 0..1 */
  setIntegrity(id: number, v: number): void {
    if (!this.hasBuilding(id)) return;
    this.integrity[id] = Math.max(0, Math.min(1, v));
    this.info(id).integrity = this.integrity[id];
    this.dirty.add(id);
  }

  /** Besatzung (Anzahl Soldaten) setzen, auf Kapazität begrenzt. */
  setGarrison(id: number, n: number): void {
    if (!this.hasBuilding(id)) return;
    const v = Math.max(0, Math.min(this.capacity[id], Math.round(n)));
    this.garrison[id] = v;
    this.info(id).garrisoned = v;
  }

  private flushDirty(): void {
    if (!this.dirty.size) return;
    for (const i of this.dirty) this.layer.place(i);
    this.dirty.clear();
    this.layer.flush();
  }
}
