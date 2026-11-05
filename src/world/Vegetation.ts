import * as THREE from 'three';
import type { GeoData } from './GeoData';
import type { Settings } from '../core/types';
import type { NavGraph } from '../nav/NavGraph';
import { SUN_COLOR, SUN_DIR, forestMask, dryMask } from './Terrain';
import { cityRadiusKm } from './Cities';
import { SCALE } from '../core/scale';
import { Q, onQualityChanged } from '../core/quality';

/**
 * Prozedurale Wälder, Bäume, Büsche, Hecken – in Kacheln um die Kamera gestreamt.
 *
 * - Dichte = Terrain.forestMask (identisch zum Waldton im Gelände-Shader) × feines Rauschen (Lichtungen, kleine Wäldchen),
 *   Baumgrenze (sinkt nach Norden), Hangneigung, Wasser, Stadt-/Dorf-/Straßenabstand.
 * - Kacheln: Klasse k (0..4) je nach Kamerahöhe; Kachelgröße 4·2^k km, Raster 88×88 Kandidaten -> konstante Kosten je Kachel.
 *   Pro Frame werden höchstens 3 Kacheln (≤ ~6 ms) gebaut; Gesamtzahl der Instanzen ist gedeckelt.
 * - Eigene Instanzattribute (aPos = x, Höhe km, z, Maßstab; aVar = Rotation, Tönung) und Shader mit Windbewegung,
 *   Jahreszeiten-Tönung, Vertex-Licht, Nebel und logarithmischem Tiefenpuffer.
 */

export type Season = 'spring' | 'summer' | 'autumn' | 'winter';

const GRID_N = 72;
const BASE_SPACING = 0.055;
const BASE_TILE = BASE_SPACING * GRID_N; // 3.96 km
/** Bäume: Basishöhen (SP_HEIGHT) liegen bereits ~1.3× über real -> etwas unter SCALE.props */
const TREE_SCALE = SCALE.props * 0.8;
/** Ausblenden (km Kamerahöhe): darüber wären Bäume Subpixel (kein Hochskalieren) */
// MAX_DIST / INSTANCE_CAP / BUILD_BUDGET_MS kommen aus Q (core/quality.ts): treeDist / treeBudget / treeBuildMs
const MAX_BUILDS_PER_FRAME = 3;
const CLASS_LIMITS = [9, 18, 36, 72];

// ------------------------------------------------------------------ Zufall / Rauschen

function ihash(a: number, b: number, c: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function vnoise(x: number, z: number, s: number): number {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = ihash(ix, iz, s), b = ihash(ix + 1, iz, s), c = ihash(ix, iz + 1, s), d = ihash(ix + 1, iz + 1, s);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

function sstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// ------------------------------------------------------------------ Baummodelle

const KIND_TRUNK = 0, KIND_CONIFER = 1, KIND_DECID = 2, KIND_BUSH = 3;

class VB {
  p: number[] = [];
  n: number[] = [];
  c: number[] = [];
  k: number[] = [];
  private static readonly col = new THREE.Color();

  tri(a: number[], b: number[], c: number[], ctr: number[], ca: THREE.Color, cb: THREE.Color, cc: THREE.Color, kind: number): void {
    let ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    let vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const mx = (a[0] + b[0] + c[0]) / 3 - ctr[0], my = (a[1] + b[1] + c[1]) / 3 - ctr[1], mz = (a[2] + b[2] + c[2]) / 3 - ctr[2];
    let P = [a, b, c], C = [ca, cb, cc];
    if (nx * mx + ny * my + nz * mz < 0) {
      nx = -nx; ny = -ny; nz = -nz;
      P = [a, c, b]; C = [ca, cc, cb];
    }
    ux = vx = uy = vy = uz = vz = 0;
    for (let i = 0; i < 3; i++) {
      this.p.push(P[i][0], P[i][1], P[i][2]);
      this.n.push(nx, ny, nz);
      this.c.push(C[i].r, C[i].g, C[i].b);
      this.k.push(kind);
    }
  }

  static color(hex: number, mul = 1): THREE.Color {
    return VB.col.clone().setHex(hex).multiplyScalar(mul);
  }

  /** Kegel/Kegelstumpf mit n Seiten */
  cone(cx: number, cz: number, y0: number, y1: number, r0: number, r1: number, n: number, c0: number, c1: number, kind: number, rot = 0): void {
    const cb = VB.color(c0), ct = VB.color(c1);
    const ctr = [cx, (y0 + y1) / 2, cz];
    for (let i = 0; i < n; i++) {
      const a0 = rot + (i / n) * Math.PI * 2, a1 = rot + ((i + 1) / n) * Math.PI * 2;
      const b0 = [cx + Math.cos(a0) * r0, y0, cz + Math.sin(a0) * r0], b1 = [cx + Math.cos(a1) * r0, y0, cz + Math.sin(a1) * r0];
      if (r1 < 1e-4) {
        this.tri(b0, b1, [cx, y1, cz], ctr, cb, cb, ct, kind);
      } else {
        const t0 = [cx + Math.cos(a0) * r1, y1, cz + Math.sin(a0) * r1], t1 = [cx + Math.cos(a1) * r1, y1, cz + Math.sin(a1) * r1];
        this.tri(b0, b1, t1, ctr, cb, cb, ct, kind);
        this.tri(b0, t1, t0, ctr, cb, ct, ct, kind);
      }
    }
  }

  /** Verformter Icosaeder-Klumpen */
  blob(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, detail: number, jitter: number, seed: number, cLow: number, cHigh: number, kind: number): void {
    const g = new THREE.IcosahedronGeometry(1, detail);
    const pos = g.getAttribute('position');
    const v: number[][] = [];
    const lo = VB.color(cLow), hi = VB.color(cHigh);
    const cols: THREE.Color[] = [];
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const j = 1 + (ihash(Math.round(x * 100), Math.round(y * 100) + Math.round(z * 100) * 31, seed) - 0.5) * jitter;
      v.push([cx + x * rx * j, cy + y * ry * j, cz + z * rz * j]);
      cols.push(lo.clone().lerp(hi, (y + 1) / 2));
    }
    const ctr = [cx, cy, cz];
    for (let i = 0; i < pos.count; i += 3) this.tri(v[i], v[i + 1], v[i + 2], ctr, cols[i], cols[i + 1], cols[i + 2], kind);
    g.dispose();
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('aCol', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('aKind', new THREE.Float32BufferAttribute(this.k, 1));
    return g;
  }
}

enum Sp { Spruce, Pine, Birch, Oak, Poplar, Bush }
const SP_COUNT = 6;
/** Basishöhe je Art (km) */
const SP_HEIGHT = [0.028, 0.022, 0.018, 0.02, 0.026, 0.0045];

function buildSpecies(): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  // Fichte: Stamm + 4 gestapelte Kegel
  let b = new VB();
  b.cone(0, 0, 0, 0.12, 0.035, 0.03, 4, 0x4a3626, 0x4a3626, KIND_TRUNK);
  b.cone(0, 0, 0.08, 0.5, 0.27, 0, 6, 0x203c24, 0x2f5230, KIND_CONIFER, 0.3);
  b.cone(0, 0, 0.34, 0.76, 0.21, 0, 6, 0x24432a, 0x34583a, KIND_CONIFER, 0.1);
  b.cone(0, 0, 0.6, 1.0, 0.14, 0, 6, 0x294a2e, 0x3a6240, KIND_CONIFER, 0.5);
  out.push(b.build());
  // Kiefer: langer Stamm, zwei flache Kronen
  b = new VB();
  b.cone(0, 0, 0, 0.7, 0.035, 0.025, 5, 0x6a4a34, 0x5a3e2c, KIND_TRUNK);
  b.blob(0.02, 0.68, 0, 0.26, 0.15, 0.24, 0, 0.5, 11, 0x2c4a28, 0x436a34, KIND_CONIFER);
  b.blob(-0.05, 0.88, 0.03, 0.2, 0.12, 0.18, 0, 0.5, 12, 0x30502c, 0x47713a, KIND_CONIFER);
  out.push(b.build());
  // Birke: heller Stamm, kleine hellgrüne Krone
  b = new VB();
  b.cone(0, 0, 0, 0.62, 0.03, 0.022, 5, 0xd8d4c8, 0xc9c4b6, KIND_TRUNK);
  b.blob(0, 0.72, 0, 0.26, 0.3, 0.26, 0, 0.45, 21, 0x6a8c3e, 0x93b55a, KIND_DECID);
  out.push(b.build());
  // Eiche/Buche: dicker Stamm, große gedrungene Krone
  b = new VB();
  b.cone(0, 0, 0, 0.45, 0.07, 0.045, 6, 0x4e3a2a, 0x4e3a2a, KIND_TRUNK);
  b.blob(0, 0.68, 0, 0.5, 0.36, 0.48, 0, 0.5, 31, 0x3c5c26, 0x628a34, KIND_DECID);
  out.push(b.build());
  // Pappel: schmale hohe Krone
  b = new VB();
  b.cone(0, 0, 0, 0.3, 0.03, 0.025, 5, 0x5a4a38, 0x5a4a38, KIND_TRUNK);
  b.blob(0, 0.64, 0, 0.17, 0.4, 0.17, 0, 0.4, 41, 0x486e30, 0x6f9840, KIND_DECID);
  out.push(b.build());
  // Busch
  b = new VB();
  b.blob(0, 0.45, 0, 0.55, 0.45, 0.55, 0, 0.55, 51, 0x3f5e2a, 0x628a36, KIND_BUSH);
  out.push(b.build());
  return out;
}

// ------------------------------------------------------------------ Shader

const T_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
#include <fog_pars_vertex>
attribute vec3 aCol;
attribute float aKind;
attribute vec4 aPos;
attribute vec2 aVar;
uniform float uTime;
uniform float uVis;
uniform float uExag;
uniform float uSeason;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
varying vec3 vColor;
void main() {
  float c = cos(aVar.x), s = sin(aVar.x);
  float sc = aPos.w * uVis;
  vec3 lp = position * sc;
  vec3 rp = vec3(c * lp.x + s * lp.z, lp.y, -s * lp.x + c * lp.z);
  vec3 n = vec3(c * normal.x + s * normal.z, normal.y, -s * normal.x + c * normal.z);
  float sway = sin(uTime * 1.7 + aPos.x * 7.3 + aPos.z * 5.1) * 0.05 * position.y * position.y * sc;
  float sway2 = sin(uTime * 1.3 + aPos.x * 5.1 - aPos.z * 6.7) * 0.035 * position.y * position.y * sc;
  vec3 wp = vec3(aPos.x, aPos.y * uExag, aPos.z) + rp + vec3(sway, 0.0, sway2);
  vec3 col = aCol;
  float v = 0.82 + 0.36 * aVar.y;
  if (aKind > 1.5) {
    // Laubwerk: Jahreszeiten
    if (uSeason < 0.5) col *= vec3(1.18, 1.22, 0.75);
    else if (uSeason > 1.5 && uSeason < 2.5) col = mix(vec3(0.62, 0.2, 0.04), vec3(0.45, 0.28, 0.05), aVar.y) * (0.8 + 0.5 * position.y);
    else if (uSeason > 2.5) col = vec3(0.2, 0.16, 0.12) * (0.8 + 0.4 * aVar.y);
    v = 0.8 + 0.4 * aVar.y;
  } else if (aKind > 0.5 && uSeason > 2.5) {
    col = mix(col, vec3(0.62, 0.68, 0.72), 0.4 * position.y);
  }
  col *= v;
  vec3 amb = mix(vec3(0.24, 0.21, 0.17), vec3(0.50, 0.56, 0.66), n.y * 0.5 + 0.5) * 0.62;
  float ndl = max(dot(n, uSunDir), 0.0);
  vColor = col * (amb + uSunColor * ndl * 0.95) * (0.62 + 0.45 * smoothstep(0.0, 0.5, position.y));
  vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;
const T_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
#include <fog_pars_fragment>
varying vec3 vColor;
void main() {
  #include <logdepthbuf_fragment>
  gl_FragColor = vec4(vColor, 1.0);
  #include <fog_fragment>
}
`;

// ------------------------------------------------------------------ Vegetation

interface VTile {
  key: string;
  k: number;
  meshes: THREE.Mesh[];
  count: number;
  cx: number;
  cz: number;
}

interface Segment { ax: number; az: number; bx: number; bz: number; w: number }
interface Circle { x: number; z: number; r: number }

const ROAD_VERGE: Record<string, number> = { motorway: 0.05, primary: 0.04, secondary: 0.034, road: 0.03, track: 0.02, rail: 0.034, ferry: 0 };

export class Vegetation {
  readonly object: THREE.Object3D;
  private readonly geo: GeoData;
  private readonly graph?: NavGraph;
  private readonly group = new THREE.Group();
  private readonly mat: THREE.ShaderMaterial;
  private readonly protos: THREE.BufferGeometry[];
  private readonly tiles = new Map<string, VTile>();
  private readonly cityCircles: Circle[];
  private clearings: Circle[] = [];
  private clearingProvider: ((x0: number, z0: number, x1: number, z1: number) => Circle[]) | null = null;
  private k = 0;
  private total = 0;
  private readonly frustum = new THREE.Frustum();
  private readonly pv = new THREE.Matrix4();
  private readonly dir = new THREE.Vector3();
  private readonly sph = new THREE.Sphere();
  private readonly seg: number[] = [];

  constructor(geo: GeoData, settings: Settings, graph?: NavGraph) {
    this.geo = geo;
    this.graph = graph;
    this.protos = buildSpecies();
    this.cityCircles = geo.meta.cities.map((c) => ({ x: c.pos[0], z: c.pos[1], r: cityRadiusKm(c.pop, c.capital) * 1.2 + 0.25 }));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: T_VERT,
      fragmentShader: T_FRAG,
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        uTime: { value: 0 },
        uVis: { value: 1 },
        uExag: { value: settings.heightExaggeration },
        uSeason: { value: 1 },
        uSunDir: { value: SUN_DIR.clone() },
        uSunColor: { value: SUN_COLOR.clone() },
      },
      fog: true,
    });
    this.group.name = 'Vegetation';
    this.object = this.group;
    // Qualitätswechsel: Kacheln verwerfen, damit Budget/Sichtweite neu greifen (werden nach und nach neu gebaut)
    onQualityChanged(() => this.disposeAll());
  }

  /** Jahreszeit (Laubfarbe): spring | summer | autumn | winter */
  setSeason(s: Season): void {
    this.mat.uniforms.uSeason.value = s === 'spring' ? 0 : s === 'summer' ? 1 : s === 'autumn' ? 2 : 3;
  }

  /** Zusätzliche Freiflächen (z. B. Dörfer): Kreise in Welt-km. Bereits gebaute Kacheln werden verworfen. */
  setClearings(list: Array<{ x: number; z: number; r: number }>): void {
    this.clearings = list.map((c) => ({ x: c.x, z: c.z, r: c.r }));
    this.disposeAll();
  }

  /** Dynamische Freiflächen (z. B. Villages.clearingsInRect): Callback liefert Kreise im Rechteck. */
  setClearingProvider(fn: ((x0: number, z0: number, x1: number, z1: number) => Array<{ x: number; z: number; r: number }>) | null): void {
    this.clearingProvider = fn;
    this.disposeAll();
  }

  applySettings(s: Settings): void {
    this.mat.uniforms.uExag.value = s.heightExaggeration;
  }

  /** Waldanteil/Baumdichte 0..1 an einer Position (Gelände + Baumgrenze + Hang + Wasser, ohne Stadt-/Straßen-Freiräume). */
  forestDensityAt(x: number, z: number): number {
    const d = this.density(x, z, true);
    for (const c of this.cityCircles) if ((x - c.x) * (x - c.x) + (z - c.z) * (z - c.z) < c.r * c.r) return 0;
    return d;
  }

  private waterCov(x: number, z: number): number {
    const g = this.geo;
    const gx = x / g.cellKm - 0.5, gz = z / g.cellKm - 0.5;
    const i = Math.floor(gx), j = Math.floor(gz);
    const fx = gx - i, fz = gz - j;
    const f = (a: number, b: number) => {
      if (a < 0 || b < 0 || a >= g.width || b >= g.height) return 1;
      return g.waterFlags[b * g.width + a] !== 0 || g.countryIds[b * g.width + a] === 0 ? 1 : 0;
    };
    return (f(i, j) * (1 - fx) + f(i + 1, j) * fx) * (1 - fz) + (f(i, j + 1) * (1 - fx) + f(i + 1, j + 1) * fx) * fz;
  }

  /** Dichte 0..1 (ohne Straßen/Städte). full=false überspringt Hangprüfung (wird für Kandidaten später nachgeholt). */
  private density(x: number, z: number, full: boolean): number {
    const g = this.geo;
    if (x < 0 || z < 0 || x >= g.widthKm || z >= g.heightKm) return 0;
    const hk = g.heightAt(x, z);
    if (hk <= 0.003) return 0;
    if (this.waterCov(x, z) > 0.3) return 0;
    const lat = z / g.heightKm;
    const f = forestMask(g, x, z);
    const dry = dryMask(g, x, z);
    // feine Struktur: Lichtungen im Wald, kleine Wäldchen in offener Landschaft
    const fine = vnoise(x * 0.9, z * 0.9, 7) * 0.65 + vnoise(x * 2.6, z * 2.6, 8) * 0.35;
    let d = f * (0.55 + 0.9 * fine) * (0.92 + 0.2 * f);
    const wood = sstep(0.64, 0.8, vnoise(x / 3.2 + 40, z / 3.2 + 40, 9)) * (1 - dry) * 0.85 * (1 - sstep(0.9, 1.4, hk));
    d = Math.max(d, wood);
    // Mittelmeer/Trockengebiete: lichtes Gehölz
    const scrub = dry * sstep(0.45, 0.75, vnoise(x / 1.8, z / 1.8, 10)) * 0.22 * (1 - sstep(0.1, 0.3, dry) * 0.0);
    d = Math.max(d, scrub * (1 - sstep(0.7, 1.0, dry) * 0.6));
    // Baumgrenze (nach Norden niedriger)
    const tl = 0.45 + (2.1 - 0.45) * sstep(0.05, 0.75, lat);
    d *= 1 - sstep(tl - 0.3, tl, hk);
    if (full && d > 0.02) {
      const gx = (g.heightAt(x + 0.8, z) - g.heightAt(x - 0.8, z)) / 1.6, gz = (g.heightAt(x, z + 0.8) - g.heightAt(x, z - 0.8)) / 1.6;
      d *= 1 - sstep(0.3, 0.65, Math.hypot(gx, gz));
    }
    return Math.max(0, Math.min(1, d));
  }

  // ------------------------------------------------------------------ Streaming

  update(camera: THREE.PerspectiveCamera, timeSec: number): void {
    const D = camera.position.y;
    this.mat.uniforms.uTime.value = timeSec;
    if (D > Q.treeDist) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    this.mat.uniforms.uVis.value = TREE_SCALE; // fester Maßstab (Basishöhen sind schon etwas über real)

    // Klasse mit Hysterese
    let kNew = 0;
    while (kNew < CLASS_LIMITS.length && D > CLASS_LIMITS[kNew]) kNew++;
    if (kNew !== this.k) {
      const lim = kNew > this.k ? CLASS_LIMITS[this.k] * 1.1 : CLASS_LIMITS[this.k - 1] * 0.9;
      if ((kNew > this.k && D > lim) || (kNew < this.k && D < lim)) {
        this.k = kNew;
        this.disposeAll();
      }
    }
    const k = this.k;
    const T = BASE_TILE * Math.pow(2, k);

    camera.updateMatrixWorld();
    this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv);
    camera.getWorldDirection(this.dir);
    let tx = camera.position.x, tz = camera.position.z;
    if (this.dir.y < -0.05) {
      const t = Math.min(D / -this.dir.y, D * 3);
      tx += this.dir.x * t;
      tz += this.dir.z * t;
    }
    const r = 1.3 * D + T;
    const i0 = Math.floor((tx - r) / T), i1 = Math.floor((tx + r) / T);
    const j0 = Math.floor((tz - r) / T), j1 = Math.floor((tz + r) / T);
    const want: Array<{ i: number; j: number; d: number }> = [];
    const rad = T * 0.75 + 0.2;
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const cx = (i + 0.5) * T, cz = (j + 0.5) * T;
        const d = Math.hypot(cx - tx, cz - tz);
        if (d > r) continue;
        if (cx < -T || cz < -T || cx > this.geo.widthKm + T || cz > this.geo.heightKm + T) continue;
        this.sph.center.set(cx, 0, cz);
        this.sph.radius = rad + 3 + this.maxHeightNear(cx, cz);
        if (!this.frustum.intersectsSphere(this.sph)) continue;
        want.push({ i, j, d });
      }
    // Entfernen: nicht mehr benötigt
    const keep = new Set<string>();
    for (const w of want) keep.add(`${k}:${w.i}:${w.j}`);
    for (const [key, t] of this.tiles) {
      if (!keep.has(key)) {
        const far = Math.hypot(t.cx - tx, t.cz - tz) > r * 1.5 + T;
        this.sph.center.set(t.cx, 0, t.cz);
        this.sph.radius = rad + 3;
        const inFrustum = this.frustum.intersectsSphere(this.sph);
        if (far || !inFrustum) this.removeTile(key);
      }
    }
    // Bauen: nächste zuerst, Zeitbudget
    want.sort((a, b) => a.d - b.d);
    const t0 = performance.now();
    let built = 0;
    for (const w of want) {
      const key = `${k}:${w.i}:${w.j}`;
      if (this.tiles.has(key)) continue;
      if (this.total > Q.treeBudget) break;
      this.buildTile(k, w.i, w.j, T);
      built++;
      if (built >= MAX_BUILDS_PER_FRAME || performance.now() - t0 > Q.treeBuildMs) break;
    }
  }

  private maxHeightNear(cx: number, cz: number): number {
    return Math.max(0, this.geo.heightAt(cx, cz)) * 6 * 1.2;
  }

  private removeTile(key: string): void {
    const t = this.tiles.get(key);
    if (!t) return;
    for (const m of t.meshes) {
      this.group.remove(m);
      m.geometry.dispose();
    }
    this.total -= t.count;
    this.tiles.delete(key);
  }

  private disposeAll(): void {
    for (const key of Array.from(this.tiles.keys())) this.removeTile(key);
  }

  /** Straßen-Segmente (Verge) für Kachel sammeln */
  private roadSegments(x0: number, z0: number, x1: number, z1: number): Segment[] {
    const out: Segment[] = [];
    if (!this.graph) return out;
    const ids = this.graph.edgesInRect(x0 - 0.1, z0 - 0.1, x1 + 0.1, z1 + 0.1, this.seg);
    for (const id of ids) {
      const e = this.graph.edges[id];
      const w = ROAD_VERGE[e.cls] ?? 0.03;
      if (w <= 0) continue;
      const gm = e.geom;
      for (let s = 0; s + 3 < gm.length; s += 2) {
        const ax = gm[s], az = gm[s + 1], bx = gm[s + 2], bz = gm[s + 3];
        if (Math.max(ax, bx) < x0 - 0.1 || Math.min(ax, bx) > x1 + 0.1 || Math.max(az, bz) < z0 - 0.1 || Math.min(az, bz) > z1 + 0.1) continue;
        out.push({ ax, az, bx, bz, w });
      }
    }
    return out;
  }

  private buildTile(k: number, ti: number, tj: number, T: number): void {
    const g = this.geo;
    const x0 = ti * T, z0 = tj * T;
    const sp = T / GRID_N;
    const key = `${k}:${ti}:${tj}`;
    const circles: Circle[] = [];
    for (const c of this.cityCircles) if (c.x + c.r > x0 && c.x - c.r < x0 + T && c.z + c.r > z0 && c.z - c.r < z0 + T) circles.push(c);
    for (const c of this.clearings) if (c.x + c.r > x0 && c.x - c.r < x0 + T && c.z + c.r > z0 && c.z - c.r < z0 + T) circles.push(c);
    if (this.clearingProvider) for (const c of this.clearingProvider(x0, z0, x0 + T, z0 + T)) circles.push(c);
    const segs = k <= 1 ? this.roadSegments(x0, z0, x0 + T, z0 + T) : [];
    const buf: number[][] = Array.from({ length: SP_COUNT }, () => []);
    const sizeMul = 1; // gleiche Baumgröße in jeder Klasse (kein Wachsen mit dem Abstand)
    const lat0 = (z0 + T / 2) / g.heightKm;

    const blocked = (x: number, z: number): boolean => {
      for (let c = 0; c < circles.length; c++) {
        const q = circles[c];
        if ((x - q.x) * (x - q.x) + (z - q.z) * (z - q.z) < q.r * q.r) return true;
      }
      for (let s = 0; s < segs.length; s++) {
        const q = segs[s];
        const dx = q.bx - q.ax, dz = q.bz - q.az;
        const L2 = dx * dx + dz * dz;
        let t = L2 > 0 ? ((x - q.ax) * dx + (z - q.az) * dz) / L2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = q.ax + dx * t - x, pz = q.az + dz * t - z;
        if (px * px + pz * pz < q.w * q.w) return true;
      }
      return false;
    };

    const emit = (sp_: Sp, x: number, z: number, hk: number, r: number, scaleMul = 1): void => {
      const a = buf[sp_];
      a.push(x, hk, z, SP_HEIGHT[sp_] * (0.75 + 0.55 * r) * scaleMul * sizeMul, r * 6.2832, ihash(Math.round(x * 1000), Math.round(z * 1000), 5));
    };

    const pickSpecies = (x: number, z: number, hk: number, r: number, dens: number): Sp => {
      const lat = z / g.heightKm;
      const con = vnoise(x / 14 + 3, z / 14 + 3, 12);
      const mount = sstep(0.8, 1.3, hk);
      let pSpruce: number, pPine: number, pBirch: number, pOak: number;
      if (lat < 0.2) { pSpruce = 0.52; pPine = 0.3; pBirch = 0.16; pOak = 0.02; }
      else if (lat > 0.62) { pSpruce = 0.04; pPine = 0.5; pBirch = 0.04; pOak = 0.42; }
      else if (con > 0.55) { pSpruce = 0.52; pPine = 0.18; pBirch = 0.1; pOak = 0.2; }
      else { pSpruce = 0.12; pPine = 0.1; pBirch = 0.18; pOak = 0.55; }
      pSpruce = pSpruce + (0.9 - pSpruce) * mount;
      pPine *= 1 - mount;
      pBirch *= 1 - mount * 0.7;
      pOak *= 1 - mount;
      const tot = pSpruce + pPine + pBirch + pOak + 0.04;
      let v = r * tot;
      if ((v -= pSpruce) < 0) return Sp.Spruce;
      if ((v -= pPine) < 0) return Sp.Pine;
      if ((v -= pBirch) < 0) return Sp.Birch;
      if ((v -= pOak) < 0) return Sp.Oak;
      return dens < 0.4 ? Sp.Bush : Sp.Poplar;
    };

    // --- Wald-/Baumraster
    for (let j = 0; j < GRID_N; j++) {
      for (let i = 0; i < GRID_N; i++) {
        const gi = ti * GRID_N + i, gj = tj * GRID_N + j;
        const r0 = ihash(gi, gj, 100 + k);
        const x = (gi + ihash(gi, gj, 1)) * sp, z = (gj + ihash(gi, gj, 2)) * sp;
        // billige Vorprüfung auf grobem Raster (Wasser/Land)
        const hk = g.heightAt(x, z);
        if (hk <= 0.003) continue;
        const d = this.density(x, z, false);
        if (d < 0.04 || r0 > d * 1.6 * Q.treeDensity) continue;
        // Hang
        const gx = (g.heightAt(x + 0.8, z) - g.heightAt(x - 0.8, z)) / 1.6, gz = (g.heightAt(x, z + 0.8) - g.heightAt(x, z - 0.8)) / 1.6;
        if (Math.hypot(gx, gz) > 0.5 && ihash(gi, gj, 3) < sstep(0.3, 0.65, Math.hypot(gx, gz))) continue;
        if (blocked(x, z)) continue;
        const r = ihash(gi, gj, 4);
        const spc = pickSpecies(x, z, hk, ihash(gi, gj, 6), d);
        emit(spc, x, z, hk, r);
        // Unterwuchs
        if (k <= 1 && d < 0.55 && ihash(gi, gj, 7) < 0.3) emit(Sp.Bush, x + (ihash(gi, gj, 8) - 0.5) * sp, z + (ihash(gi, gj, 9) - 0.5) * sp, hk, r);
      }
    }

    // --- Hecken entlang der Feldparzellen (gleiches gedrehtes 0.42-km-Raster wie im Gelände-Shader)
    if (k <= 1 && lat0 < 0.8) {
      const P = 0.42, c = 0.9553, s = 0.2955;
      const corners = [[x0, z0], [x0 + T, z0], [x0, z0 + T], [x0 + T, z0 + T]];
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (const [x, z] of corners) {
        const u = x * c + z * s, v = -x * s + z * c;
        u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
      }
      const step = k === 0 ? 0.024 : 0.05;
      for (let axis = 0; axis < 2; axis++) {
        const a0 = axis === 0 ? u0 : v0, a1 = axis === 0 ? u1 : v1, b0 = axis === 0 ? v0 : u0, b1 = axis === 0 ? v1 : u1;
        for (let m = Math.ceil(a0 / P); m <= Math.floor(a1 / P); m++) {
          // Hecke existiert auf Teilstücken (je Parzellenkante hashbasiert)
          for (let b = b0; b <= b1; b += step) {
            const seg = Math.floor(b / P);
            if (ihash(m, seg, 200 + axis) > 0.34) continue;
            const au = m * P, bv = b + (ihash(m, Math.round(b * 1000), 13) - 0.5) * step * 0.6;
            const u = axis === 0 ? au : bv, v = axis === 0 ? bv : au;
            const x = u * c - v * s, z = u * s + v * c;
            if (x < x0 || x >= x0 + T || z < z0 || z >= z0 + T) continue;
            if (ihash(m, Math.round(b * 1000), 14) < 0.2) continue;
            const hk = g.heightAt(x, z);
            if (hk <= 0.005 || hk > 0.7) continue;
            const f = forestMask(g, x, z);
            if (f > 0.35 || dryMask(g, x, z) > 0.4 || this.waterCov(x, z) > 0.3) continue;
            if (blocked(x, z)) continue;
            const r = ihash(m, Math.round(b * 1000), 15);
            const sel = ihash(m, Math.round(b * 1000), 16);
            emit(sel < 0.6 ? Sp.Bush : sel < 0.85 ? Sp.Oak : sel < 0.95 ? Sp.Poplar : Sp.Birch, x, z, hk, r, sel < 0.6 ? 1.2 : 0.85);
          }
        }
      }
    }

    // --- Meshes erzeugen
    let count = 0;
    const meshes: THREE.Mesh[] = [];
    const cxT = x0 + T / 2, czT = z0 + T / 2;
    for (let s = 0; s < SP_COUNT; s++) {
      const a = buf[s];
      const n = a.length / 6;
      if (!n) continue;
      const geom = new THREE.InstancedBufferGeometry();
      const proto = this.protos[s];
      for (const name of ['position', 'normal', 'aCol', 'aKind']) geom.setAttribute(name, proto.getAttribute(name));
      const pos = new Float32Array(n * 4), vr = new Float32Array(n * 2);
      for (let q = 0; q < n; q++) {
        pos[q * 4] = a[q * 6]; pos[q * 4 + 1] = a[q * 6 + 1]; pos[q * 4 + 2] = a[q * 6 + 2]; pos[q * 4 + 3] = a[q * 6 + 3];
        vr[q * 2] = a[q * 6 + 4]; vr[q * 2 + 1] = a[q * 6 + 5];
      }
      geom.setAttribute('aPos', new THREE.InstancedBufferAttribute(pos, 4));
      geom.setAttribute('aVar', new THREE.InstancedBufferAttribute(vr, 2));
      geom.instanceCount = n;
      geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(cxT, 3, czT), T * 0.75 + 20);
      geom.boundingBox = new THREE.Box3(new THREE.Vector3(x0, -5, z0), new THREE.Vector3(x0 + T, 30, z0 + T));
      const mesh = new THREE.Mesh(geom, this.mat);
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = true;
      mesh.name = `Trees${s}`;
      this.group.add(mesh);
      meshes.push(mesh);
      count += n;
    }
    this.total += count;
    this.tiles.set(key, { key, k, meshes, count, cx: cxT, cz: czT });
  }

  /** Debug: Anzahl Instanzen / Kacheln */
  get stats(): { instances: number; tiles: number; cls: number } {
    return { instances: this.total, tiles: this.tiles.size, cls: this.k };
  }
}
