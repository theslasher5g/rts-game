import * as THREE from 'three';
import type { GeoData } from './GeoData';
import { SUN_COLOR, SUN_DIR } from './Terrain';
import { getBuildingMaterial, lin, rngFrom, terrainHeightKm, type V3 } from './BuildingModels';

/**
 * Straßenleben, Dorfdetails, Bodendekale und Brände:
 *  - PropLayer: instanzierte Kleinmodelle (Laternen, Bäume, Autos, Bänke, Zäune, Heuballen, Traktoren ...) in Kacheln, nach Kameraabstand gecullt.
 *  - StreetLife: erzeugt aus dem Straßenraster einer Stadt (CityGrid) Laternen, Straßenbäume, geparkte Autos, Zäune/Gärten, Park-/Spielplatz-Dekale.
 *  - DecalSet: geländefolgende Bodendekale (Teiche, Sportplätze, Spielplätze, Gartenbeete, Brandflecken mit Ziegelstreu).
 *  - BuildingFires: billboardartige Flammen-/Rauchquads für brennende Gebäude (eigenständig, ohne Effects.ts).
 */

// ====================================================================== Prop-Modelle

export const PROP = {
  LAMP: 0, TREE_D: 1, TREE_C: 2, TREE_A: 3, BUSH: 4, CAR0: 5, CAR1: 6, VAN: 7, BENCH: 8, SHELTER: 9, BIN: 10, FENCE: 11, WALL: 12, HEDGE: 13,
  SHED: 14, HAY: 15, BALE: 16, TRACTOR: 17, TRAILER: 18, WELL: 19, GRAVE: 20, VINE: 21, CROSS: 22, PLAY: 23, TRUCK: 24, COUNT: 25,
} as const;

// Kind (aCol.a): 0 fest, 1 Karosserie (Palette), 2 Leuchtkörper, 3 Laub, 4 Holz/Dach fest, 5 Fensterglas
class PB {
  p: number[] = [];
  n: number[] = [];
  c: number[] = [];

  tri(a: V3, b: V3, d: V3, col: V3, kind: number, ctr?: V3): void {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    let B = b, D = d;
    if (ctr) {
      const m: V3 = [(a[0] + b[0] + d[0]) / 3 - ctr[0], (a[1] + b[1] + d[1]) / 3 - ctr[1], (a[2] + b[2] + d[2]) / 3 - ctr[2]];
      if (m[0] * nx + m[1] * ny + m[2] * nz < 0) { nx = -nx; ny = -ny; nz = -nz; B = d; D = b; }
    }
    for (const v of [a, B, D]) {
      this.p.push(v[0], v[1], v[2]);
      this.n.push(nx, ny, nz);
      this.c.push(col[0], col[1], col[2], kind);
    }
  }
  quad(a: V3, b: V3, d: V3, e: V3, col: V3, kind: number, ctr?: V3): void {
    this.tri(a, b, d, col, kind, ctr);
    this.tri(a, d, e, col, kind, ctr);
  }
  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, col: V3, kind = 0, bottom = false): void {
    const x0 = cx - sx / 2, x1 = cx + sx / 2, y0 = cy - sy / 2, y1 = cy + sy / 2, z0 = cz - sz / 2, z1 = cz + sz / 2;
    const ctr: V3 = [cx, cy, cz];
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], col, kind, ctr);
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], col, kind, ctr);
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], col, kind, ctr);
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], col, kind, ctr);
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], col, kind, ctr);
    if (bottom) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], col, kind, ctr);
  }
  /** Senkrechter Kegelstumpf */
  cyl(cx: number, cz: number, y0: number, y1: number, r0: number, r1: number, n: number, col: V3, kind = 0, cap = true): void {
    const ctr: V3 = [cx, (y0 + y1) / 2, cz];
    for (let k = 0; k < n; k++) {
      const a0 = (k / n) * 6.2832, a1 = ((k + 1) / n) * 6.2832;
      this.quad([cx + Math.cos(a0) * r0, y0, cz + Math.sin(a0) * r0], [cx + Math.cos(a1) * r0, y0, cz + Math.sin(a1) * r0], [cx + Math.cos(a1) * r1, y1, cz + Math.sin(a1) * r1], [cx + Math.cos(a0) * r1, y1, cz + Math.sin(a0) * r1], col, kind, ctr);
      if (cap && r1 > 0.001) this.tri([cx + Math.cos(a0) * r1, y1, cz + Math.sin(a0) * r1], [cx + Math.cos(a1) * r1, y1, cz + Math.sin(a1) * r1], [cx, y1, cz], col, kind, ctr);
    }
  }
  /** Waagerechter Zylinder entlang z (Räder, Ballen) */
  cylZ(cx: number, cy: number, z0: number, z1: number, r: number, n: number, col: V3, kind = 0): void {
    const ctr: V3 = [cx, cy, (z0 + z1) / 2];
    for (let k = 0; k < n; k++) {
      const a0 = (k / n) * 6.2832, a1 = ((k + 1) / n) * 6.2832;
      this.quad([cx + Math.cos(a0) * r, cy + Math.sin(a0) * r, z0], [cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, z0], [cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, z1], [cx + Math.cos(a0) * r, cy + Math.sin(a0) * r, z1], col, kind, ctr);
      this.tri([cx, cy, z1], [cx + Math.cos(a0) * r, cy + Math.sin(a0) * r, z1], [cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, z1], col, kind, ctr);
      this.tri([cx, cy, z0], [cx + Math.cos(a0) * r, cy + Math.sin(a0) * r, z0], [cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, z0], col, kind, ctr);
    }
  }
  /** Laubkrone: Doppelkegel mit n Ecken */
  blob(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, n: number, col: V3, kind = 3, jitter = 0.12, seed = 1): void {
    const rnd = rngFrom('blob' + seed);
    const ctr: V3 = [cx, cy, cz];
    const ring: V3[] = [];
    for (let k = 0; k < n; k++) {
      const a = (k / n) * 6.2832;
      const j = 1 + (rnd() - 0.5) * jitter * 2;
      ring.push([cx + Math.cos(a) * rx * j, cy + (rnd() - 0.5) * ry * 0.2, cz + Math.sin(a) * rz * j]);
    }
    const top: V3 = [cx, cy + ry, cz], bot: V3 = [cx, cy - ry * 0.7, cz];
    for (let k = 0; k < n; k++) {
      const a = ring[k], b = ring[(k + 1) % n];
      const shade = 0.85 + 0.25 * (k % 2);
      const c2: V3 = [col[0] * shade, col[1] * shade, col[2] * shade];
      this.tri(a, b, top, c2, kind, ctr);
      this.tri(b, a, bot, [c2[0] * 0.7, c2[1] * 0.7, c2[2] * 0.7], kind, ctr);
    }
  }
  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('aCol', new THREE.Float32BufferAttribute(this.c, 4));
    return g;
  }
}

const C = {
  pole: lin(0x4a4e54), glassDark: lin(0x1c2630), wheel: lin(0x161618), trunk: lin(0x4a3524), green: lin(0x3e6a30), green2: lin(0x4c7a34), conifer: lin(0x26462c),
  wood: lin(0x7a5a3a), woodLight: lin(0xa88a5c), concrete: lin(0x9a978f), metal: lin(0x7a8086), white: lin(0xe4e2d8), hay: lin(0xc8b060), roofRed: lin(0x8a4a38),
  red: lin(0xb02a22), tractorGreen: lin(0x2f6a34), stone: lin(0x8a867c), bin: lin(0x3a5a44), lampHead: lin(0xffe8b0), hedge: lin(0x2f5a2a), shedWall: lin(0x8a6a4a),
  grave: lin(0x8a8a86), vine: lin(0x5a7a34), play: lin(0xc84a2a), play2: lin(0x2a6ac8),
};

function buildProto(id: number): THREE.BufferGeometry {
  const b = new PB();
  switch (id) {
    case PROP.LAMP:
      b.box(0, 3.6, 0, 0.14, 7.2, 0.14, C.pole);
      b.box(0, 0.25, 0, 0.3, 0.5, 0.3, C.pole);
      b.box(0.65, 7.1, 0, 1.5, 0.1, 0.1, C.pole);
      b.box(1.25, 6.98, 0, 0.7, 0.14, 0.32, C.lampHead, 2);
      break;
    case PROP.TREE_D:
      b.cyl(0, 0, 0, 2.8, 0.28, 0.2, 5, C.trunk, 0, false);
      b.blob(0, 4.2, 0, 2.6, 2.4, 2.6, 8, C.green, 3, 0.18, 1);
      b.blob(0.7, 6.0, 0.3, 1.8, 1.7, 1.8, 7, C.green2, 3, 0.15, 2);
      break;
    case PROP.TREE_C:
      b.cyl(0, 0, 0, 1.6, 0.26, 0.2, 5, C.trunk, 0, false);
      b.cyl(0, 0, 1.4, 5.2, 2.0, 0.9, 7, C.conifer, 3, true);
      b.cyl(0, 0, 4.0, 8.2, 1.5, 0.5, 7, C.conifer, 3, true);
      b.cyl(0, 0, 6.8, 10.5, 0.95, 0.0, 7, C.conifer, 3, false);
      break;
    case PROP.TREE_A:
      b.cyl(0, 0, 0, 1.6, 0.18, 0.14, 5, C.trunk, 0, false);
      b.blob(0, 2.7, 0, 1.7, 1.5, 1.7, 7, C.green2, 3, 0.2, 3);
      break;
    case PROP.BUSH:
      b.blob(0, 0.6, 0, 1.0, 0.7, 1.0, 6, C.hedge, 3, 0.2, 4);
      break;
    case PROP.CAR0: // Limousine
      b.box(0, 0.62, 0, 4.4, 0.62, 1.78, [1, 1, 1], 1);
      b.box(-0.2, 1.17, 0, 2.2, 0.55, 1.58, [1, 1, 1], 1);
      b.box(-0.2, 1.2, 0, 2.18, 0.4, 1.6, C.glassDark, 5);
      b.box(-0.2, 1.46, 0, 1.9, 0.06, 1.5, [1, 1, 1], 1);
      for (const [x, z] of [[1.4, 0.82], [-1.4, 0.82], [1.4, -0.82], [-1.4, -0.82]]) b.box(x, 0.32, z, 0.66, 0.64, 0.24, C.wheel);
      break;
    case PROP.CAR1: // Kleinwagen (Fließheck)
      b.box(0, 0.62, 0, 3.7, 0.62, 1.68, [1, 1, 1], 1);
      b.box(-0.15, 1.2, 0, 2.5, 0.58, 1.5, [1, 1, 1], 1);
      b.box(-0.15, 1.2, 0, 2.52, 0.42, 1.52, C.glassDark, 5);
      b.box(-0.15, 1.5, 0, 2.2, 0.06, 1.42, [1, 1, 1], 1);
      for (const [x, z] of [[1.2, 0.76], [-1.2, 0.76], [1.2, -0.76], [-1.2, -0.76]]) b.box(x, 0.3, z, 0.6, 0.6, 0.22, C.wheel);
      break;
    case PROP.VAN: // Transporter
      b.box(0, 1.0, 0, 5.0, 1.5, 1.95, [1, 1, 1], 1);
      b.box(1.7, 1.35, 0, 1.3, 0.7, 1.9, C.glassDark, 5);
      b.box(-0.3, 1.9, 0, 3.6, 0.08, 1.85, [0.9, 0.9, 0.9], 1);
      for (const [x, z] of [[1.5, 0.88], [-1.5, 0.88], [1.5, -0.88], [-1.5, -0.88]]) b.box(x, 0.36, z, 0.72, 0.72, 0.26, C.wheel);
      break;
    case PROP.TRUCK:
      b.box(1.8, 1.7, 0, 2.0, 2.4, 2.4, C.white, 0);
      b.box(2.6, 2.1, 0, 0.1, 1.0, 2.2, C.glassDark, 5);
      b.box(-2.0, 2.0, 0, 6.2, 3.0, 2.5, [1, 1, 1], 1);
      b.box(0, 0.55, 0, 10.0, 0.3, 2.2, C.pole);
      for (const [x, z] of [[2.3, 1.05], [-1.5, 1.05], [-3.2, 1.05], [2.3, -1.05], [-1.5, -1.05], [-3.2, -1.05]]) b.box(x, 0.5, z, 1.0, 1.0, 0.34, C.wheel);
      break;
    case PROP.BENCH:
      b.box(0, 0.45, 0, 1.7, 0.08, 0.45, C.wood);
      b.box(0, 0.85, -0.2, 1.7, 0.4, 0.07, C.wood);
      b.box(-0.7, 0.22, 0, 0.1, 0.44, 0.4, C.pole);
      b.box(0.7, 0.22, 0, 0.1, 0.44, 0.4, C.pole);
      break;
    case PROP.SHELTER:
      b.box(0, 2.5, 0, 3.4, 0.14, 1.6, C.metal);
      b.box(-1.6, 1.2, 0, 0.1, 2.4, 1.4, C.pole);
      b.box(1.6, 1.2, 0, 0.1, 2.4, 1.4, C.pole);
      b.box(0, 1.3, -0.7, 3.2, 2.0, 0.06, C.glassDark, 5);
      b.box(0, 0.45, -0.4, 2.4, 0.08, 0.45, C.wood);
      b.box(2.1, 1.6, 0.4, 0.1, 3.2, 0.1, C.pole);
      b.box(2.1, 2.9, 0.4, 0.1, 0.8, 0.6, C.red);
      break;
    case PROP.BIN:
      b.cyl(0, 0, 0, 0.95, 0.38, 0.42, 6, C.bin, 0, true);
      b.cyl(0, 0, 0.95, 1.05, 0.46, 0.46, 6, C.pole, 0, true);
      break;
    case PROP.FENCE:
      b.box(0, 0.55, 0, 1.0, 1.0, 0.05, C.woodLight);
      b.box(0, 0.25, 0.04, 1.0, 0.08, 0.04, C.wood);
      b.box(0, 0.85, 0.04, 1.0, 0.08, 0.04, C.wood);
      break;
    case PROP.WALL:
      b.box(0, 0.7, 0, 1.0, 1.4, 0.3, C.concrete);
      b.box(0, 1.45, 0, 1.0, 0.1, 0.4, C.stone);
      break;
    case PROP.HEDGE:
      b.box(0, 0.6, 0, 1.0, 1.2, 0.8, C.hedge, 3);
      break;
    case PROP.SHED:
      b.box(0, 1.1, 0, 3.0, 2.2, 2.2, C.shedWall, 4);
      b.quad([-1.7, 2.1, 1.3], [1.7, 2.1, 1.3], [1.7, 2.75, 0], [-1.7, 2.75, 0], C.roofRed, 4);
      b.quad([1.7, 2.1, -1.3], [-1.7, 2.1, -1.3], [-1.7, 2.75, 0], [1.7, 2.75, 0], C.roofRed, 4);
      b.tri([1.5, 2.2, 1.1], [1.5, 2.2, -1.1], [1.5, 2.7, 0], C.shedWall, 4);
      b.tri([-1.5, 2.2, -1.1], [-1.5, 2.2, 1.1], [-1.5, 2.7, 0], C.shedWall, 4);
      b.box(0, 0.9, 1.12, 0.9, 1.6, 0.06, C.wood);
      break;
    case PROP.HAY:
      b.cyl(0, 0, 0, 2.2, 2.2, 1.7, 9, C.hay, 4, false);
      b.cyl(0, 0, 2.2, 3.6, 1.7, 0.0, 9, C.hay, 4, false);
      break;
    case PROP.BALE:
      b.cylZ(0, 0.75, -0.6, 0.6, 0.75, 8, C.hay, 4);
      break;
    case PROP.TRACTOR:
      b.box(1.0, 1.2, 0, 2.2, 1.2, 1.2, C.tractorGreen, 0);
      b.box(-0.5, 1.9, 0, 1.4, 1.5, 1.4, C.tractorGreen, 0);
      b.box(-0.5, 2.0, 0, 1.38, 0.9, 1.42, C.glassDark, 5);
      b.box(-0.5, 2.7, 0, 1.6, 0.1, 1.6, C.pole);
      b.cylZ(-1.1, 0.95, 0.8, 1.2, 0.95, 8, C.wheel);
      b.cylZ(-1.1, 0.95, -1.2, -0.8, 0.95, 8, C.wheel);
      b.cylZ(1.4, 0.55, 0.7, 1.0, 0.55, 8, C.wheel);
      b.cylZ(1.4, 0.55, -1.0, -0.7, 0.55, 8, C.wheel);
      b.box(1.9, 2.0, 0.3, 0.1, 1.0, 0.1, C.pole);
      break;
    case PROP.TRAILER:
      b.box(0, 1.2, 0, 4.2, 0.2, 2.0, C.pole);
      b.box(0, 1.9, 1.0, 4.2, 1.2, 0.1, C.wood);
      b.box(0, 1.9, -1.0, 4.2, 1.2, 0.1, C.wood);
      b.box(2.1, 1.9, 0, 0.1, 1.2, 2.0, C.wood);
      b.box(-2.1, 1.9, 0, 0.1, 1.2, 2.0, C.wood);
      b.box(0, 1.4, 0, 4.0, 0.7, 1.8, C.hay, 4);
      b.cylZ(0, 0.65, 0.9, 1.2, 0.65, 8, C.wheel);
      b.cylZ(0, 0.65, -1.2, -0.9, 0.65, 8, C.wheel);
      break;
    case PROP.WELL:
      b.cyl(0, 0, 0, 1.0, 1.1, 1.1, 8, C.stone, 0, true);
      b.cyl(0, 0, 0.9, 1.0, 0.7, 0.7, 8, C.glassDark, 0, true);
      b.box(-1.0, 1.7, 0, 0.14, 1.5, 0.14, C.wood);
      b.box(1.0, 1.7, 0, 0.14, 1.5, 0.14, C.wood);
      b.quad([-1.4, 2.4, 0.9], [1.4, 2.4, 0.9], [1.4, 3.0, 0], [-1.4, 3.0, 0], C.roofRed, 4);
      b.quad([1.4, 2.4, -0.9], [-1.4, 2.4, -0.9], [-1.4, 3.0, 0], [1.4, 3.0, 0], C.roofRed, 4);
      break;
    case PROP.GRAVE:
      b.box(0, 0.5, 0, 0.6, 1.0, 0.18, C.grave);
      b.box(0, 0.06, 0.5, 0.7, 0.12, 1.3, C.stone);
      break;
    case PROP.CROSS:
      b.box(0, 0.7, 0, 0.12, 1.4, 0.12, C.wood);
      b.box(0, 1.05, 0, 0.7, 0.12, 0.12, C.wood);
      b.box(0, 0.06, 0.5, 0.7, 0.12, 1.2, C.stone);
      break;
    case PROP.VINE:
      b.box(0, 0.9, 0, 1.0, 1.1, 0.7, C.vine, 3);
      b.box(-0.5, 0.8, 0, 0.1, 1.6, 0.1, C.wood);
      b.box(0.5, 0.8, 0, 0.1, 1.6, 0.1, C.wood);
      break;
    case PROP.PLAY:
      b.box(-0.8, 1.0, 0, 0.12, 2.0, 0.12, C.play2);
      b.box(0.8, 1.0, 0, 0.12, 2.0, 0.12, C.play2);
      b.box(0, 2.0, 0, 1.8, 0.1, 0.12, C.play2);
      b.quad([1.0, 1.6, -0.3], [1.0, 1.6, 0.3], [2.4, 0.1, 0.3], [2.4, 0.1, -0.3], C.play, 0);
      b.box(-2.2, 0.5, 0, 0.9, 0.12, 0.5, C.play);
      break;
    default:
      b.box(0, 0.5, 0, 1, 1, 1, C.concrete);
  }
  return b.geometry();
}

const P_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
#include <fog_pars_vertex>
attribute vec4 aCol;
attribute vec4 aPos;
attribute vec3 aVar;
uniform float uExag;
uniform float uHS;
uniform float uStrat;
uniform float uLift;
uniform float uNight;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
varying vec3 vCol;
varying vec3 vLight;
varying float vEm;
vec3 palette(float t) {
  float k = floor(t * 10.0);
  if (k < 1.0) return vec3(0.75, 0.75, 0.74);
  if (k < 2.0) return vec3(0.45, 0.46, 0.5);
  if (k < 3.0) return vec3(0.05, 0.05, 0.06);
  if (k < 4.0) return vec3(0.52, 0.06, 0.05);
  if (k < 5.0) return vec3(0.08, 0.16, 0.42);
  if (k < 6.0) return vec3(0.07, 0.24, 0.12);
  if (k < 7.0) return vec3(0.62, 0.56, 0.4);
  if (k < 8.0) return vec3(0.2, 0.2, 0.22);
  if (k < 9.0) return vec3(0.7, 0.55, 0.08);
  return vec3(0.6, 0.28, 0.08);
}
void main() {
  float c = cos(aVar.x), s = sin(aVar.x);
  vec3 lp = position * vec3(aVar.z > 0.0 ? aVar.z : 1.0, 1.0, 1.0) * aPos.w * uStrat;
  lp.y *= uHS;
  vec3 r = vec3(lp.x * c + lp.z * s, lp.y, -lp.x * s + lp.z * c);
  vec3 nn = normalize(vec3(normal.x * c + normal.z * s, normal.y, -normal.x * s + normal.z * c));
  vec3 wp = vec3(aPos.x, aPos.y * uExag + uLift, aPos.z) + r * 0.001;
  float kind = aCol.a;
  vec3 col = aCol.rgb;
  if (kind > 0.5 && kind < 1.5) col = palette(aVar.y) * (0.6 + 0.4 * aCol.r);
  else if (kind > 2.5 && kind < 3.5) col = col * (0.75 + 0.5 * aVar.y) + vec3(0.12, 0.08, -0.02) * aVar.y;
  vCol = col;
  vEm = kind > 1.5 && kind < 2.5 ? 1.0 : 0.0;
  vec3 amb = mix(vec3(0.24, 0.21, 0.17), vec3(0.50, 0.56, 0.66), nn.y * 0.5 + 0.5) * 0.62;
  float ndl = max(dot(nn, uSunDir), 0.0);
  vLight = (amb + uSunColor * ndl * 0.95) * 1.12 * (1.0 - 0.55 * uNight);
  vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;
const P_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
#include <fog_pars_fragment>
uniform float uNight;
varying vec3 vCol;
varying vec3 vLight;
varying float vEm;
void main() {
  #include <logdepthbuf_fragment>
  vec3 col = vCol * vLight + vCol * vEm * (0.25 + 1.6 * uNight);
  gl_FragColor = vec4(col, 1.0);
  #include <fog_fragment>
}
`;

let PROP_MAT: THREE.ShaderMaterial | null = null;
let PROP_GEOS: THREE.BufferGeometry[] | null = null;
function propMat(): THREE.ShaderMaterial {
  if (!PROP_MAT) {
    const bm = getBuildingMaterial();
    PROP_MAT = new THREE.ShaderMaterial({
      vertexShader: P_VERT,
      fragmentShader: P_FRAG,
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        uExag: { value: 6 },
        uHS: { value: 2.25 },
        uStrat: { value: 1 },
        uLift: { value: 0.012 },
        uNight: bm.uniforms.uNight,
        uSunDir: { value: SUN_DIR.clone() },
        uSunColor: { value: SUN_COLOR.clone() },
      },
      fog: true,
    });
    PROP_MAT.name = 'PropMaterial';
  }
  return PROP_MAT;
}
function propGeo(id: number): THREE.BufferGeometry {
  if (!PROP_GEOS) PROP_GEOS = new Array(PROP.COUNT).fill(null);
  return (PROP_GEOS[id] ??= buildProto(id));
}

/** Globale Prop-Parameter (Überhöhung, Kamerahöhe) – von Cities/Villages je Frame gesetzt */
export function setPropParams(exag: number, camY: number): void {
  const u = propMat().uniforms;
  u.uExag.value = exag;
  u.uHS.value = 1 + (exag - 1) * 0.25;
  u.uStrat.value = THREE.MathUtils.clamp(1 + (camY - 6) / 10, 1, 3);
  u.uLift.value = THREE.MathUtils.clamp(0.008 + camY * 0.0016, 0.008, 3);
}

export interface PropInst {
  p: number;
  x: number;
  z: number;
  rot: number;
  s?: number;
  tint?: number;
  len?: number;
}

interface PTile {
  x0: number; x1: number; z0: number; z1: number;
  meshes: THREE.Mesh[];
  vis: boolean;
}

/** Instanzierte Kleinmodelle, in Kacheln gruppiert; sichtbar nur innerhalb maxDist (km, inkl. Kamerahöhe). */
export class PropLayer {
  readonly group = new THREE.Group();
  readonly count: number;
  private readonly tiles: PTile[] = [];

  constructor(geo: GeoData, list: PropInst[], tileKm = 3) {
    this.count = list.length;
    const mat = propMat();
    const map = new Map<number, { t: PTile; by: Map<number, PropInst[]> }>();
    for (const it of list) {
      const tx = Math.floor(it.x / tileKm), tz = Math.floor(it.z / tileKm);
      const key = tx * 100003 + tz;
      let e = map.get(key);
      if (!e) {
        e = { t: { x0: tx * tileKm, x1: (tx + 1) * tileKm, z0: tz * tileKm, z1: (tz + 1) * tileKm, meshes: [], vis: false }, by: new Map() };
        map.set(key, e);
        this.tiles.push(e.t);
      }
      let arr = e.by.get(it.p);
      if (!arr) e.by.set(it.p, (arr = []));
      arr.push(it);
    }
    for (const { t, by } of map.values()) {
      let yMax = 0;
      for (const [p, arr] of by) {
        const base = propGeo(p);
        const g = new THREE.InstancedBufferGeometry();
        g.setAttribute('position', base.getAttribute('position'));
        g.setAttribute('normal', base.getAttribute('normal'));
        g.setAttribute('aCol', base.getAttribute('aCol'));
        const n = arr.length;
        const aPos = new Float32Array(n * 4), aVar = new Float32Array(n * 3);
        for (let k = 0; k < n; k++) {
          const it = arr[k];
          const h = Math.max(0, terrainHeightKm(geo, it.x, it.z));
          yMax = Math.max(yMax, h);
          aPos.set([it.x, h, it.z, it.s ?? 1], k * 4);
          aVar.set([it.rot, it.tint ?? 0.5, it.len ?? 1], k * 3);
        }
        g.setAttribute('aPos', new THREE.InstancedBufferAttribute(aPos, 4));
        g.setAttribute('aVar', new THREE.InstancedBufferAttribute(aVar, 3));
        g.instanceCount = n;
        const m = new THREE.Mesh(g, mat);
        m.frustumCulled = false;
        m.visible = false;
        m.name = `Prop${p}`;
        t.meshes.push(m);
        this.group.add(m);
      }
    }
    this.group.name = 'Props';
    this.group.visible = true;
  }

  update(cam: THREE.Vector3, maxDist: number): void {
    for (const t of this.tiles) {
      const dx = Math.max(t.x0 - cam.x, 0, cam.x - t.x1), dz = Math.max(t.z0 - cam.z, 0, cam.z - t.z1);
      const v = Math.hypot(dx, dz, cam.y) < maxDist;
      if (v === t.vis) continue;
      t.vis = v;
      for (const m of t.meshes) m.visible = v;
    }
  }

  dispose(): void {
    for (const t of this.tiles) for (const m of t.meshes) m.geometry.dispose();
  }
}

// ====================================================================== Bodendekale

export const DECAL = { SCORCH: 0, POND: 1, SPORT: 2, PLAY: 3, GARDEN: 4, YARD: 5, CEMETERY: 6, VINEYARD: 7, LAWN: 8 } as const;

const D_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
#include <fog_pars_vertex>
attribute vec4 aD;
uniform float uExag;
uniform float uLift;
varying vec4 vD;
varying vec2 vUv;
void main() {
  vD = vec4(aD.z, aD.w, 0.0, 0.0);
  vUv = aD.xy;
  vec3 p = vec3(position.x, position.y * uExag + uLift, position.z);
  vec4 mvPosition = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;
const D_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
#include <fog_pars_fragment>
uniform float uNight;
varying vec4 vD;
varying vec2 vUv;
float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1, 0)), f.x), mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), f.x), f.y);
}
vec3 srgb(vec3 c) { return pow(c, vec3(2.2)); }
float box(vec2 p, vec2 c, vec2 h) { vec2 d = abs(p - c) - h; return max(d.x, d.y); }
void main() {
  #include <logdepthbuf_fragment>
  float kind = vD.x, seed = vD.y;
  vec2 uv = vUv;
  vec2 q = uv - 0.5;
  float r = length(q) * 2.0;
  vec3 col = vec3(0.0);
  float a = 0.0;
  float n1 = vnoise(uv * 7.0 + seed * 31.0), n2 = vnoise(uv * 19.0 + seed * 17.0);
  if (kind < 0.5) {
    // Brandfleck: dunkler Rußfleck, Schuttstreu, Ziegelbröckchen
    float edge = 0.88 + 0.28 * n1 - 0.12;
    float core = (1.0 - smoothstep(edge - 0.35, edge, r));
    a = core * 0.85;
    col = srgb(vec3(0.05, 0.045, 0.04)) * (0.7 + 0.6 * n2);
    float dust = (1.0 - smoothstep(0.7, 1.0, r)) * (1.0 - core);
    col = mix(col, srgb(vec3(0.34, 0.31, 0.27)), dust * 0.6);
    a = max(a, dust * 0.35);
    vec2 cell = floor(uv * 26.0);
    float br = hash21(cell + seed * 9.0);
    vec2 lf = fract(uv * 26.0);
    if (br > 0.9 && r < 0.95 && lf.x > 0.25 && lf.x < 0.75 && lf.y > 0.3 && lf.y < 0.7) {
      col = srgb(mix(vec3(0.5, 0.22, 0.16), vec3(0.62, 0.58, 0.5), step(0.5, hash21(cell + 4.0))));
      a = 0.95;
    }
  } else if (kind < 1.5) {
    float edge = 0.78 + 0.2 * n1;
    float w = (1.0 - smoothstep(edge - 0.06, edge, r));
    float bank = (1.0 - smoothstep(edge, edge + 0.14, r));
    col = mix(srgb(vec3(0.33, 0.4, 0.22)), srgb(vec3(0.1, 0.22, 0.26)), w);
    col += w * 0.06 * vec3(sin(uv.x * 40.0 + n2 * 6.0));
    a = bank * 0.95;
  } else if (kind < 2.5) {
    vec2 p = uv;
    float inField = step(box(p, vec2(0.5), vec2(0.47, 0.47)), 0.0);
    float stripe = step(0.5, fract(p.x * 8.0));
    col = srgb(mix(vec3(0.22, 0.42, 0.18), vec3(0.27, 0.48, 0.21), stripe));
    float line = 0.0;
    float oB = abs(box(p, vec2(0.5), vec2(0.38, 0.4)));
    line = max(line, step(oB, 0.012));
    line = max(line, step(abs(p.x - 0.5), 0.008) * step(box(p, vec2(0.5), vec2(0.4, 0.4)), 0.0));
    line = max(line, step(abs(length(p - 0.5) - 0.09), 0.01));
    line = max(line, step(abs(box(p, vec2(0.5, 0.2), vec2(0.13, 0.08))), 0.01));
    line = max(line, step(abs(box(p, vec2(0.5, 0.8), vec2(0.13, 0.08))), 0.01));
    col = mix(col, srgb(vec3(0.92)), line);
    a = inField * 0.97;
  } else if (kind < 3.5) {
    float rr = box(uv, vec2(0.5), vec2(0.42));
    col = srgb(vec3(0.7, 0.62, 0.44)) * (0.85 + 0.2 * n2);
    float sp = step(0.9, hash21(floor(uv * 8.0) + seed * 5.0)) * step(0.25, length(q));
    col = mix(col, srgb(mix(vec3(0.75, 0.2, 0.12), vec3(0.15, 0.35, 0.75), step(0.5, hash21(floor(uv * 8.0))))), sp);
    a = step(rr, 0.0) * 0.95;
    float rim = step(abs(rr + 0.02), 0.02);
    col = mix(col, srgb(vec3(0.3, 0.22, 0.12)), rim);
  } else if (kind < 4.5) {
    float bx = box(uv, vec2(0.5), vec2(0.45));
    float bed = step(0.55, fract(uv.y * 6.0 + 0.1));
    col = mix(srgb(vec3(0.3, 0.2, 0.1)), srgb(vec3(0.25, 0.46, 0.15)), bed * (0.6 + 0.4 * n2));
    a = step(bx, 0.0) * 0.96;
  } else if (kind < 5.5) {
    float edge = 0.85 + 0.25 * n1;
    float c = (1.0 - smoothstep(edge - 0.3, edge, r));
    col = mix(srgb(vec3(0.42, 0.36, 0.26)), srgb(vec3(0.5, 0.46, 0.38)), n2) ;
    col = mix(col, srgb(vec3(0.3, 0.26, 0.18)), step(0.78, n2) * 0.5);
    a = c * 0.9;
  } else if (kind < 6.5) {
    float bx = box(uv, vec2(0.5), vec2(0.46));
    col = srgb(vec3(0.28, 0.44, 0.22)) * (0.9 + 0.2 * n2);
    float path = max(step(abs(uv.x - 0.5), 0.04), step(abs(uv.y - 0.5), 0.04));
    col = mix(col, srgb(vec3(0.62, 0.58, 0.5)), path);
    vec2 lf = fract(uv * vec2(9.0, 7.0));
    float gr = step(0.3, lf.x) * step(lf.x, 0.6) * step(0.25, lf.y) * step(lf.y, 0.7) * (1.0 - path) * step(0.2, abs(uv.x - 0.5)) * step(0.2, abs(uv.y - 0.5));
    col = mix(col, srgb(vec3(0.45, 0.43, 0.4)), gr);
    a = step(bx, 0.0) * 0.97;
  } else if (kind < 7.5) {
    float bx = box(uv, vec2(0.5), vec2(0.5));
    float row = step(0.5, fract(uv.x * 14.0));
    col = mix(srgb(vec3(0.3, 0.22, 0.13)), srgb(vec3(0.34, 0.45, 0.2)), row * 0.5);
    a = step(bx, 0.0) * 0.9;
  } else {
    float bx = box(uv, vec2(0.5), vec2(0.48));
    col = srgb(vec3(0.3, 0.47, 0.22)) * (0.9 + 0.22 * n2);
    float p1 = step(abs(uv.x - uv.y), 0.025), p2 = step(abs(uv.x + uv.y - 1.0), 0.025);
    col = mix(col, srgb(vec3(0.66, 0.62, 0.52)), max(p1, p2));
    a = step(bx, 0.0) * 0.97;
  }
  if (a < 0.03) discard;
  col *= 1.0 - 0.55 * uNight;
  gl_FragColor = vec4(col, a);
  #include <fog_fragment>
}
`;

let DECAL_MAT: THREE.ShaderMaterial | null = null;
function decalMat(): THREE.ShaderMaterial {
  if (!DECAL_MAT) {
    DECAL_MAT = new THREE.ShaderMaterial({
      vertexShader: D_VERT,
      fragmentShader: D_FRAG,
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        uExag: { value: 6 },
        uLift: { value: 0.02 },
        uNight: getBuildingMaterial().uniforms.uNight,
      },
      fog: true,
      transparent: true,
      depthWrite: false,
    });
    DECAL_MAT.name = 'DecalMaterial';
  }
  return DECAL_MAT;
}
export function setDecalParams(exag: number, camY: number): void {
  const u = decalMat().uniforms;
  u.uExag.value = exag;
  u.uLift.value = THREE.MathUtils.clamp(0.016 + camY * 0.0042, 0.016, 9);
}

const DG = 4; // Gitter je Dekal (DG x DG Zellen)
const DV = (DG + 1) * (DG + 1);

/** Geländefolgende Dekale in einem Mesh mit festen Slots. */
export class DecalSet {
  readonly mesh: THREE.Mesh;
  private readonly pos: Float32Array;
  private readonly aD: Float32Array;
  private next = 0;
  private readonly slots: number;

  constructor(private readonly geo: GeoData, slots: number) {
    this.slots = slots;
    this.pos = new Float32Array(slots * DV * 3);
    this.aD = new Float32Array(slots * DV * 4);
    const idx: number[] = [];
    for (let s = 0; s < slots; s++) {
      const b = s * DV;
      for (let j = 0; j < DG; j++)
        for (let i = 0; i < DG; i++) {
          const a = b + j * (DG + 1) + i, bb = a + 1, c = a + DG + 1, d = c + 1;
          idx.push(a, c, bb, bb, c, d);
        }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('aD', new THREE.BufferAttribute(this.aD, 4));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e5);
    this.mesh = new THREE.Mesh(g, decalMat());
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.name = 'Decals';
  }

  get used(): number {
    return Math.min(this.next, this.slots);
  }

  /** Dekal setzen (Ringpuffer). Rückgabe: Slot. w/d in km, rot um Y. */
  add(kind: number, x: number, z: number, w: number, d: number, rot: number, seed = 0): number {
    const slot = this.next % this.slots;
    this.next++;
    const c = Math.cos(rot), s = Math.sin(rot);
    for (let j = 0; j <= DG; j++)
      for (let i = 0; i <= DG; i++) {
        const k = slot * DV + j * (DG + 1) + i;
        const la = (i / DG - 0.5) * w, lb = (j / DG - 0.5) * d;
        const px = x + la * c + lb * s, pz = z - la * s + lb * c;
        this.pos[k * 3] = px;
        this.pos[k * 3 + 1] = Math.max(0, terrainHeightKm(this.geo, px, pz));
        this.pos[k * 3 + 2] = pz;
        this.aD.set([i / DG, j / DG, kind, seed], k * 4);
      }
    (this.mesh.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.mesh.geometry.getAttribute('aD') as THREE.BufferAttribute).needsUpdate = true;
    return slot;
  }

  /** Dekal ausblenden (degeneriert) */
  remove(slot: number): void {
    for (let k = 0; k < DV; k++) {
      const o = (slot * DV + k) * 3;
      this.pos[o] = this.pos[o + 1] = this.pos[o + 2] = 0;
    }
    (this.mesh.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
  }
}

// ====================================================================== Brände

const FX_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
#include <fog_pars_vertex>
attribute vec4 aP;
attribute vec4 aQ;
uniform float uTime;
uniform float uScale;
varying vec2 vUv;
varying vec4 vQ;
varying float vAge;
void main() {
  vUv = uv;
  float kind = aQ.y;
  float ph = aQ.x;
  float size = aP.w * uScale;
  vec3 c = aP.xyz;
  float age = 0.0;
  if (kind < 0.5) {
    float fl = 0.8 + 0.25 * sin(uTime * 11.0 + ph * 6.28) + 0.15 * sin(uTime * 17.0 + ph * 3.0);
    size *= fl * (0.4 + 0.6 * aQ.z);
    c.y += size * 0.45;
  } else {
    age = fract(uTime * 0.09 + ph);
    c.y += aP.w * uScale * (0.6 + age * 3.2);
    c.x += sin(uTime * 0.7 + ph * 9.0) * age * aP.w * uScale * 0.8;
    size *= 0.7 + age * 2.4;
  }
  vAge = age;
  vQ = aQ;
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 wp = c + (right * (uv.x - 0.5) + up * (uv.y - (kind < 0.5 ? 0.5 : 0.5))) * size * (kind < 0.5 ? 1.0 : 1.6);
  vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;
const FX_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
#include <fog_pars_fragment>
uniform float uTime;
varying vec2 vUv;
varying vec4 vQ;
varying float vAge;
float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  #include <logdepthbuf_fragment>
  vec2 uv = floor(vUv * 10.0) / 10.0 + 0.05;
  float kind = vQ.y;
  if (kind < 0.5) {
    float t = floor(uTime * 9.0);
    float n = hash21(floor(uv * 8.0) + vec2(t, vQ.x * 50.0));
    float w = pow(max(0.0, 1.0 - uv.y), 0.75) * 0.5;
    float d = abs(uv.x - 0.5);
    float f = (1.0 - smoothstep(w * 0.4, w, d + (n - 0.5) * 0.12)) * (1.0 - smoothstep(0.75, 1.0, uv.y + n * 0.2));
    float core = (1.0 - smoothstep(0.2, 0.7, uv.y + d * 1.2 + n * 0.2));
    vec3 col = mix(vec3(1.0, 0.25, 0.04), vec3(1.0, 0.85, 0.35), core);
    float a = f * vQ.z;
    if (a < 0.05) discard;
    gl_FragColor = vec4(col * a * 1.3, 1.0);
  } else {
    vec2 p = uv - 0.5;
    float r = length(p) * 2.0;
    float n = hash21(floor(uv * 7.0) + floor(vQ.x * 60.0));
    float a = (1.0 - smoothstep(0.6 + n * 0.25, 1.0, r)) * (1.0 - vAge) * 0.85 * vQ.z;
    if (a < 0.04) discard;
    float dither = step(hash21(floor(gl_FragCoord.xy)), a * 1.4);
    if (dither < 0.5) discard;
    vec3 col = mix(vec3(0.07, 0.065, 0.06), vec3(0.34, 0.33, 0.32), vAge);
    gl_FragColor = vec4(col, 1.0);
  }
  #include <fog_fragment>
}
`;

interface Fire {
  key: number;
  x: number; z: number; baseKm: number; hKm: number; r: number;
  age: number; dur: number;
  seed: number;
}

/** Flammen und Rauch (Billboards) auf brennenden Gebäuden. */
export class BuildingFires {
  readonly object = new THREE.Group();
  private readonly fires: Fire[] = [];
  private readonly flame: THREE.Mesh;
  private readonly smoke: THREE.Mesh;
  private readonly fMat: THREE.ShaderMaterial;
  private readonly sMat: THREE.ShaderMaterial;
  private readonly aPf: Float32Array;
  private readonly aQf: Float32Array;
  private readonly aPs: Float32Array;
  private readonly aQs: Float32Array;
  private exag = 6;
  private readonly NF = 3;
  private readonly NS = 3;
  private cam = new THREE.Vector3();

  constructor(private readonly cap = 60) {
    const mk = (additive: boolean): THREE.ShaderMaterial =>
      new THREE.ShaderMaterial({
        vertexShader: FX_VERT,
        fragmentShader: FX_FRAG,
        uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), uTime: { value: 0 }, uScale: { value: 1 } },
        fog: true,
        transparent: true,
        depthWrite: false,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
        side: THREE.DoubleSide,
      });
    this.fMat = mk(true);
    this.sMat = mk(false);
    const quad = new THREE.PlaneGeometry(1, 1);
    const mkMesh = (n: number, mat: THREE.ShaderMaterial, name: string): { mesh: THREE.Mesh; aP: Float32Array; aQ: Float32Array } => {
      const g = new THREE.InstancedBufferGeometry();
      g.setAttribute('position', quad.getAttribute('position'));
      g.setAttribute('uv', quad.getAttribute('uv'));
      g.setIndex(quad.getIndex());
      const aP = new Float32Array(n * 4), aQ = new Float32Array(n * 4);
      const pa = new THREE.InstancedBufferAttribute(aP, 4), qa = new THREE.InstancedBufferAttribute(aQ, 4);
      pa.setUsage(THREE.DynamicDrawUsage); qa.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('aP', pa);
      g.setAttribute('aQ', qa);
      g.instanceCount = 0;
      const mesh = new THREE.Mesh(g, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 6;
      mesh.name = name;
      return { mesh, aP, aQ };
    };
    const f = mkMesh(cap * this.NF, this.fMat, 'Flames');
    const s = mkMesh(cap * this.NS, this.sMat, 'FireSmoke');
    this.flame = f.mesh; this.smoke = s.mesh;
    this.aPf = f.aP; this.aQf = f.aQ; this.aPs = s.aP; this.aQs = s.aQ;
    this.object.add(this.smoke, this.flame);
    this.object.name = 'BuildingFires';
    this.object.visible = false;
  }

  get count(): number {
    return this.fires.length;
  }

  setExag(e: number): void {
    this.exag = e;
  }

  isBurning(key: number): boolean {
    return this.fires.some((f) => f.key === key);
  }

  /** Brand starten/verlängern. baseKm = Sockelhöhe (unüberhöht), hKm = Gebäudehöhe, r = Footprint-Radius (km), dur = Sekunden */
  ignite(key: number, x: number, z: number, baseKm: number, hKm: number, r: number, dur: number): void {
    let f = this.fires.find((q) => q.key === key);
    if (!f) {
      if (this.fires.length >= this.cap) this.fires.shift();
      f = { key, x, z, baseKm, hKm, r, age: 0, dur, seed: Math.abs(Math.sin(key * 12.9898) * 43758.5453) % 1 };
      this.fires.push(f);
    } else {
      f.hKm = hKm;
      f.dur = Math.max(f.dur, f.age + dur * 0.5);
    }
  }

  extinguish(key: number): void {
    const i = this.fires.findIndex((f) => f.key === key);
    if (i >= 0) this.fires.splice(i, 1);
  }

  update(dt: number, camera: THREE.PerspectiveCamera, time: number): void {
    this.cam.copy(camera.position);
    const n = this.fires.length;
    if (!n) {
      this.object.visible = false;
      return;
    }
    const hs = 1 + (this.exag - 1) * 0.25;
    for (let i = n - 1; i >= 0; i--) {
      this.fires[i].age += dt;
      if (this.fires[i].age >= this.fires[i].dur) this.fires.splice(i, 1);
    }
    let nf = 0, ns = 0;
    for (const f of this.fires) {
      const fade = Math.min(1, (f.dur - f.age) / 15, 0.4 + f.age / 6);
      const inten = Math.max(0, fade);
      const yTop = f.baseKm * this.exag + f.hKm * hs;
      const spread = Math.min(f.r, 0.05) * 0.6;
      for (let k = 0; k < this.NF; k++) {
        const s = f.seed * 7 + k * 1.7;
        const o = nf * 4;
        this.aPf[o] = f.x + Math.sin(s * 3.3) * spread;
        this.aPf[o + 1] = yTop - f.hKm * hs * 0.08;
        this.aPf[o + 2] = f.z + Math.cos(s * 2.1) * spread;
        this.aPf[o + 3] = Math.min(0.016, 0.006 + f.r * 0.22) * (0.8 + 0.4 * ((s * 5.1) % 1));
        this.aQf[o] = (s * 0.37) % 1;
        this.aQf[o + 1] = 0;
        this.aQf[o + 2] = inten;
        nf++;
      }
      for (let k = 0; k < this.NS; k++) {
        const s = f.seed * 5 + k * 2.3;
        const o = ns * 4;
        this.aPs[o] = f.x + Math.sin(s * 2.7) * spread * 0.6;
        this.aPs[o + 1] = yTop;
        this.aPs[o + 2] = f.z + Math.cos(s * 1.9) * spread * 0.6;
        this.aPs[o + 3] = Math.min(0.02, 0.008 + f.r * 0.25);
        this.aQs[o] = (s * 0.31 + k * 0.33) % 1;
        this.aQs[o + 1] = 1;
        this.aQs[o + 2] = inten;
        ns++;
      }
    }
    (this.flame.geometry as THREE.InstancedBufferGeometry).instanceCount = nf;
    (this.smoke.geometry as THREE.InstancedBufferGeometry).instanceCount = ns;
    for (const m of [this.flame, this.smoke]) {
      (m.geometry.getAttribute('aP') as THREE.BufferAttribute).needsUpdate = true;
      (m.geometry.getAttribute('aQ') as THREE.BufferAttribute).needsUpdate = true;
    }
    const sc = THREE.MathUtils.clamp(1 + this.cam.y * 0.4, 1, 9);
    for (const m of [this.fMat, this.sMat]) {
      m.uniforms.uTime.value = time;
      m.uniforms.uScale.value = sc;
    }
    this.object.visible = this.cam.y < 600;
  }
}

// ====================================================================== Straßenleben der Städte

export interface StreetGrid {
  name: string;
  cx: number; cz: number; theta: number; M: number; S: number;
  kinds: Uint8Array;
  /** 0 West, 1 Ost (Platte), 2 Mittelmeer, 3 Nordisch */
  style: number;
}

export interface StreetStats { lamps: number; trees: number; cars: number; other: number; decals: number; total: number }

/** Maximale Instanzen für alle Städte zusammen */
const STREET_BUDGET = 78000;

/**
 * Straßenleben aus dem Stadtraster: Laternen (Gehweg), Straßenbäume, geparkte Autos (Bordstein), Bänke/Haltestellen/Mülleimer,
 * Innenhof-/Parkbäume, Zäune/Mauern/Hecken/Schuppen in Vorstädten, Gartenbeete, Spielplätze und Sportfelder als Bodendekale.
 */
export class StreetLife {
  readonly object = new THREE.Group();
  readonly layer: PropLayer;
  readonly decals: DecalSet;
  readonly stats: StreetStats = { lamps: 0, trees: 0, cars: 0, other: 0, decals: 0, total: 0 };
  private exag = 6;

  constructor(geo: GeoData, grids: StreetGrid[]) {
    const list: PropInst[] = [];
    const decals: Array<[number, number, number, number, number, number, number]> = [];
    const st = this.stats;
    const room = () => list.length < STREET_BUDGET;
    const push = (kind: 'lamps' | 'trees' | 'cars' | 'other', it: PropInst): void => {
      if (!room()) return;
      list.push(it);
      st[kind]++;
    };
    // Straßen-Kantenbreiten (km vom Zellrand): Gehweg-Mitte, Randstein-Parkstreifen
    const SW = 0.0835, PARK = 0.088;
    for (const grid of grids) {
      const rnd = rngFrom(grid.name + ':street');
      const { cx, cz, theta, M, S, kinds } = grid;
      const N = M * 2;
      const ca = Math.cos(theta), sa = Math.sin(theta);
      const W = (u: number, v: number): [number, number] => [cx + u * ca + v * sa, cz - u * sa + v * ca];
      const rotU = theta, rotV = theta - Math.PI / 2;
      const kAt = (i: number, j: number): number => (i < 0 || j < 0 || i >= N || j >= N ? 0 : kinds[j * N + i]);
      for (let j = 0; j < N; j++)
        for (let i = 0; i < N; i++) {
          const k = kinds[j * N + i];
          if (!k) continue;
          const u0 = (i + 0.5 - M) * S, v0 = (j + 0.5 - M) * S;
          const park = k === 2;
          const sub = k === 5;
          const ind = k === 3;
          const platte = k === 4;
          const centre = k === 1 || k === 6;
          // --- Kanten: Laternen, Bäume, Autos
          for (let e = 0; e < 4; e++) {
            const alongU = e < 2; // Kante läuft entlang u (Rand bei v = ±S/2)
            const sg = e % 2 === 0 ? 1 : -1;
            const nb = alongU ? kAt(i, j + sg) : kAt(i + sg, j);
            void nb;
            for (let q = 0; q < 3; q++) {
              const t = ((q + 0.5) / 3 - 0.5) * S * 0.96;
              const lampP = sub ? 0.5 : park ? 0.55 : 0.85;
              if (rnd() < lampP) {
                const off = sg * SW;
                const [x, z] = alongU ? W(u0 + t, v0 + off) : W(u0 + off, v0 + t);
                // Arm zeigt zur Straße: lokale +x-Achse der Laterne zeigt zur Fahrbahn
                const lampRot = alongU ? theta - sg * Math.PI / 2 : theta + (sg > 0 ? 0 : Math.PI);
                push('lamps', { p: PROP.LAMP, x, z, rot: lampRot, s: 1 });
              }
              // Straßenbaum zwischen den Laternen
              const treeP = sub ? 0.7 : park ? 0.9 : platte ? 0.55 : ind ? 0.05 : centre ? 0.22 : 0.4;
              if (rnd() < treeP) {
                const t2 = t + (S * 0.96) / 6;
                if (Math.abs(t2) < S * 0.48) {
                  const off = sg * (SW - 0.002);
                  const [x, z] = alongU ? W(u0 + t2, v0 + off) : W(u0 + off, v0 + t2);
                  push('trees', { p: rnd() < (grid.style === 3 ? 0.55 : 0.2) ? PROP.TREE_C : PROP.TREE_D, x, z, rot: rnd() * 6.28, s: 0.8 + rnd() * 0.5, tint: rnd() });
                }
              }
            }
            // Geparkte Autos am Randstein
            if (!park) {
              const nc = ind ? 1 : platte ? 3 : sub ? 1 : 2;
              for (let q = 0; q < nc; q++) {
                if (rnd() > (platte ? 0.7 : centre ? 0.65 : 0.45)) continue;
                const t = (rnd() - 0.5) * S * 0.8;
                const off = sg * (PARK + (rnd() - 0.5) * 0.001);
                const [x, z] = alongU ? W(u0 + t, v0 + off) : W(u0 + off, v0 + t);
                const r = rnd();
                const pr = ind ? (r < 0.4 ? PROP.TRUCK : r < 0.7 ? PROP.VAN : PROP.CAR0) : r < 0.45 ? PROP.CAR0 : r < 0.8 ? PROP.CAR1 : PROP.VAN;
                push('cars', { p: pr, x, z, rot: (alongU ? rotU : rotV) + (rnd() < 0.5 ? 0 : Math.PI), s: 1, tint: rnd() });
              }
            }
            // Bank / Bushaltestelle / Mülleimer
            if (!ind && !sub && !park && rnd() < 0.07) {
              const t = (rnd() - 0.5) * S * 0.7;
              const off = sg * (SW + 0.0035);
              const [x, z] = alongU ? W(u0 + t, v0 + off) : W(u0 + off, v0 + t);
              const rr = rnd();
              const face = (alongU ? rotU : rotV) + (sg > 0 ? 0 : Math.PI);
              push('other', { p: rr < 0.35 ? PROP.SHELTER : rr < 0.7 ? PROP.BENCH : PROP.BIN, x, z, rot: face, s: 1 });
            }
            // Zaun/Mauer entlang Industrie-Kanten
            if (ind && rnd() < 0.6) {
              const off = sg * (SW + 0.004);
              const [x, z] = alongU ? W(u0, v0 + off) : W(u0 + off, v0);
              push('other', { p: PROP.FENCE, x, z, rot: alongU ? rotU : rotV, s: 1, len: S * 0.92 * 1000 });
            }
          }
          // --- Zellinneres
          if (park) {
            const nt = 10 + Math.floor(rnd() * 12);
            for (let q = 0; q < nt; q++) {
              const a = (rnd() - 0.5) * S * 0.82, b = (rnd() - 0.5) * S * 0.82;
              const [x, z] = W(u0 + a, v0 + b);
              push('trees', { p: rnd() < 0.25 ? PROP.TREE_C : rnd() < 0.15 ? PROP.TREE_A : PROP.TREE_D, x, z, rot: rnd() * 6.28, s: 0.8 + rnd() * 0.7, tint: rnd() });
            }
            const r = rnd();
            const [px, pz] = W(u0, v0);
            if (r < 0.32) decals.push([DECAL.SPORT, px, pz, 0.12, 0.09, rotU + (rnd() < 0.5 ? 0 : Math.PI / 2), rnd()]);
            else if (r < 0.55) {
              decals.push([DECAL.PLAY, px, pz, 0.055, 0.055, rotU, rnd()]);
              push('other', { p: PROP.PLAY, x: px, z: pz, rot: rotU, s: 1 });
              push('other', { p: PROP.BENCH, x: px + 0.02 * ca, z: pz - 0.02 * sa, rot: rotU, s: 1 });
            } else if (r < 0.7) decals.push([DECAL.POND, px, pz, 0.07, 0.06, rotU, rnd()]);
            else decals.push([DECAL.LAWN, px, pz, 0.15, 0.15, rotU, rnd()]);
            for (let q = 0; q < 3; q++) {
              const [x, z] = W(u0 + (rnd() - 0.5) * S * 0.6, v0 + (rnd() - 0.5) * S * 0.6);
              push('other', { p: rnd() < 0.6 ? PROP.BENCH : PROP.BIN, x, z, rot: rnd() * 6.28, s: 1 });
            }
          } else if (centre || (!sub && !ind && !platte)) {
            // Innenhof: Bäume
            const nt = k === 6 ? 2 : 2 + Math.floor(rnd() * 3);
            for (let q = 0; q < nt; q++) {
              const [x, z] = W(u0 + (rnd() - 0.5) * 0.05, v0 + (rnd() - 0.5) * 0.05);
              push('trees', { p: rnd() < 0.2 ? PROP.TREE_C : PROP.TREE_D, x, z, rot: rnd() * 6.28, s: 0.7 + rnd() * 0.5, tint: rnd() });
            }
            if (rnd() < 0.3) { const [x, z] = W(u0, v0); decals.push([DECAL.GARDEN, x, z, 0.04, 0.03, rotU, rnd()]); }
          } else if (platte) {
            const nt = 4 + Math.floor(rnd() * 5);
            for (let q = 0; q < nt; q++) {
              const [x, z] = W(u0 + (rnd() - 0.5) * S * 0.8, v0 + (rnd() - 0.5) * S * 0.8);
              push('trees', { p: rnd() < 0.3 ? PROP.TREE_C : PROP.TREE_D, x, z, rot: rnd() * 6.28, s: 0.8 + rnd() * 0.6, tint: rnd() });
            }
            const [px, pz] = W(u0 + (rnd() - 0.5) * 0.04, v0 + (rnd() - 0.5) * 0.04);
            const r = rnd();
            if (r < 0.4) {
              decals.push([DECAL.PLAY, px, pz, 0.05, 0.05, rotU, rnd()]);
              push('other', { p: PROP.PLAY, x: px, z: pz, rot: rotU, s: 1 });
            } else if (r < 0.55) decals.push([DECAL.SPORT, px, pz, 0.07, 0.05, rotU, rnd()]);
            for (let q = 0; q < 3; q++) {
              const [x, z] = W(u0 + (rnd() - 0.5) * S * 0.7, v0 + (rnd() - 0.5) * S * 0.7);
              push('other', { p: rnd() < 0.5 ? PROP.BIN : PROP.BENCH, x, z, rot: rnd() * 6.28, s: 1 });
            }
          } else if (sub) {
            // Villen-Parzellen: Zäune, Hecken, Bäume, Schuppen, Beete
            for (const a of [-0.056, 0, 0.056])
              for (const b of [-0.045, 0.045]) {
                if (rnd() < 0.12) continue;
                const hw = 0.0265, hd = 0.043;
                const fenceP = rnd() < 0.5 ? PROP.FENCE : rnd() < 0.5 ? PROP.HEDGE : PROP.WALL;
                const sides: Array<[number, number, number, number]> = [[0, -hd, hw * 2, rotU], [0, hd, hw * 2, rotU], [-hw, 0, hd * 2, rotV], [hw, 0, hd * 2, rotV]];
                for (const [da, db, len, rr] of sides) {
                  const [x, z] = W(u0 + a + da, v0 + b + db);
                  push('other', { p: fenceP, x, z, rot: rr, s: 1, len: len * 1000 });
                }
                if (rnd() < 0.8) {
                  const [x, z] = W(u0 + a + (rnd() - 0.5) * 0.03, v0 + b + (b > 0 ? -1 : 1) * (0.022 + rnd() * 0.012));
                  push('trees', { p: rnd() < 0.5 ? PROP.TREE_A : PROP.TREE_D, x, z, rot: rnd() * 6.28, s: 0.6 + rnd() * 0.4, tint: rnd() });
                }
                if (rnd() < 0.45) {
                  const [x, z] = W(u0 + a + hw * 0.55, v0 + b + (b > 0 ? 1 : -1) * 0.034);
                  push('other', { p: PROP.SHED, x, z, rot: rotU, s: 0.8 + rnd() * 0.3, tint: rnd() });
                }
                if (rnd() < 0.5) {
                  const [x, z] = W(u0 + a - 0.008, v0 + b + (b > 0 ? -1 : 1) * 0.03);
                  decals.push([DECAL.GARDEN, x, z, 0.022, 0.016, rotU, rnd()]);
                }
                if (rnd() < 0.5) {
                  const [x, z] = W(u0 + a + (rnd() - 0.5) * 0.04, v0 + b + (b > 0 ? -1 : 1) * 0.015);
                  push('cars', { p: rnd() < 0.5 ? PROP.CAR0 : PROP.CAR1, x, z, rot: rotV + (b > 0 ? Math.PI : 0), s: 1, tint: rnd() });
                }
              }
          }
        }
    }
    st.total = list.length;
    this.layer = new PropLayer(geo, list, 3);
    this.decals = new DecalSet(geo, Math.max(1, decals.length));
    for (const d of decals) this.decals.add(d[0], d[1], d[2], d[3], d[4], d[5], d[6]);
    st.decals = decals.length;
    this.object.add(this.layer.group, this.decals.mesh);
    this.object.name = 'StreetLife';
  }

  setExag(e: number): void {
    this.exag = e;
  }

  update(camera: THREE.PerspectiveCamera, maxDist = 9): void {
    const p = camera.position;
    setPropParams(this.exag, p.y);
    setDecalParams(this.exag, p.y);
    this.layer.update(p, maxDist);
    this.decals.mesh.visible = p.y < maxDist * 1.2;
  }
}
