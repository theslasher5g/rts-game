/**
 * Gemeinsame Bausteine für RoadRenderer (Fahrbahn-Bänder), RoadProps (Straßenmöblierung) und BridgeRenderer:
 *
 * - RoadNet: Kachelindex (6 km) der Kanten, verdichtete Stützpunkte je Kante (Cache), Stadtnähe.
 * - GLSL-Bausteine: Geländehöhe auf der GPU (exakt wie Terrain: gleiche R16F-Textur, gleiche Dreieckszerlegung),
 *   „Straßenmaßstab“ S(d) = clamp(k·d, 1, Smax) – alles Quer-/Höhenmaß wächst mit dem Kameraabstand (strategische
 *   Sichtskala wie bei den Einheiten), damit 8–25 m breite Straßen lesbar bleiben.
 * - Band-Builder (Ribbons): Vertex-Attribute für die Fahrbahn-Shader; Kreuzungen, Rampen, Rastplätze, Bahnübergänge.
 *
 * Alle Koordinaten in km (1 Einheit = 1 km), Höhen werden auf der GPU mit heightExaggeration multipliziert.
 */
import * as THREE from 'three';
import type { GeoData } from '../world/GeoData';
import type { NavGraph } from './NavGraph';
import { getHeightTexture } from '../world/Terrain';
import { cityRadiusKm } from '../world/Cities';

export const TILE_KM = 6;
export const STEP_KM = 0.0625;
/** Straßenmaßstab: Faktor je km Kameraabstand und Obergrenze */
export const SCALE_K = 1.1;
export const SCALE_MAX = 14;

// ----------------------------------------------------------------------- Hash

export function ihash(a: number, b: number, c: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ----------------------------------------------------------------------- Oberflächentypen (Shader-Konstanten)

export const T_MOTORWAY = 0;
export const T_PRIMARY = 1;
export const T_SECONDARY = 2;
export const T_ROAD = 3;
export const T_TRACK = 4;
export const T_RAIL = 5;
export const T_PATCH = 6;
export const T_RAMP = 7;
export const T_LAYBY = 8;
export const T_CROSSING = 9;
export const T_STEEL = 10;
export const T_BALLAST = 11;

/** Halbbreite der Fahrbahnbänder in Metern (inkl. Seitenstreifen und Böschungskante) */
export const HALF_WIDTH_M: Record<string, number> = {
  motorway: 13.7,
  primary: 5.5,
  secondary: 4.2,
  road: 4.2,
  track: 4.0,
  rail: 4.4,
  ferry: 0,
};

export const TYPE_OF_CLASS: Record<string, number> = {
  motorway: T_MOTORWAY,
  primary: T_PRIMARY,
  secondary: T_SECONDARY,
  road: T_ROAD,
  track: T_TRACK,
  rail: T_RAIL,
  ferry: T_ROAD,
};

// ----------------------------------------------------------------------- Gemeinsame Uniforms / GLSL

const uniformCache = new WeakMap<GeoData, Record<string, THREE.IUniform>>();

/** Geteilte Uniform-Objekte (Höhentextur, Überhöhung, Maßstab) für alle Straßen-/Brücken-Materialien einer Karte */
export function getRoadUniforms(geo: GeoData): Record<string, THREE.IUniform> {
  let u = uniformCache.get(geo);
  if (!u) {
    u = {
      uHeight: { value: getHeightTexture(geo) },
      uGrid: { value: new THREE.Vector2(geo.width, geo.height) },
      uCell: { value: geo.cellKm },
      uExag: { value: 6 },
      uKS: { value: SCALE_K },
      uSMax: { value: SCALE_MAX },
    };
    uniformCache.set(geo, u);
  }
  return u;
}

/** GLSL: Geländehöhe (km) wie Terrain (Eckpunkt = Mittel der 4 Zellen, Dreiecke a-c-b / b-c-d) + Maßstabsfunktion */
export const SCALE_GLSL = /* glsl */ `
uniform sampler2D uHeight;
uniform vec2 uGrid;
uniform float uCell;
uniform float uExag;
uniform float uKS;
uniform float uSMax;
float hCorner(vec2 c) { return texture2D(uHeight, c / uGrid).r; }
float groundKm(vec2 xz) {
  vec2 g = xz / uCell;
  vec2 i = floor(g);
  vec2 f = g - i;
  float a = hCorner(i);
  float b = hCorner(i + vec2(1.0, 0.0));
  float c = hCorner(i + vec2(0.0, 1.0));
  float d = hCorner(i + vec2(1.0, 1.0));
  float h = (f.x + f.y <= 1.0) ? a + (b - a) * f.x + (c - a) * f.y : d + (c - d) * (1.0 - f.x) + (b - d) * (1.0 - f.y);
  return max(h, 0.0);
}
float roadScale(float d) { return clamp(d * uKS, 1.0, uSMax); }
`;

/** CPU-Gegenstück zu groundKm (nur Höhe, nicht überhöht) – identisch zu terrainHeightKm */
export { terrainHeightKm } from '../world/Cities';

// ----------------------------------------------------------------------- Netz-Index

export interface Stations {
  n: number;
  /** [x,z,...] verdichtet (≤ STEP_KM) */
  xz: Float32Array;
  /** Kumulierte Länge je Stützpunkt (km) */
  cum: Float32Array;
  /** Tangente je Stützpunkt */
  tx: Float32Array;
  tz: Float32Array;
  total: number;
}

export interface Crossing {
  x: number;
  z: number;
  rtx: number;
  rtz: number;
  ttx: number;
  ttz: number;
  roadHwM: number;
  roadEdge: number;
  railEdge: number;
}

export interface RestStop {
  edge: number;
  s: number;
  x: number;
  z: number;
  tx: number;
  tz: number;
  side: number;
  hwM: number;
}

export interface CityRef { x: number; z: number; r: number }

export class RoadNet {
  readonly geo: GeoData;
  readonly graph: NavGraph;
  readonly cities: CityRef[] = [];
  private readonly index = new Map<number, number[]>();
  private readonly nodeIndex = new Map<number, number[]>();
  private readonly cache = new Map<number, Stations>();

  constructor(geo: GeoData, graph: NavGraph) {
    this.geo = geo;
    this.graph = graph;
    for (const c of geo.meta.cities) this.cities.push({ x: c.pos[0], z: c.pos[1], r: cityRadiusKm(c.pop, c.capital) });
    // Kachelindex
    const tmp = new Map<number, [number, number]>();
    for (const e of graph.edges) {
      if (e.cls === 'ferry') continue;
      const g = e.geom;
      tmp.clear();
      let s = 0;
      for (let k = 0; k + 3 < g.length; k += 2) {
        const sl = Math.hypot(g[k + 2] - g[k], g[k + 3] - g[k + 1]);
        const x0 = Math.min(g[k], g[k + 2]), x1 = Math.max(g[k], g[k + 2]);
        const z0 = Math.min(g[k + 1], g[k + 3]), z1 = Math.max(g[k + 1], g[k + 3]);
        const i0 = Math.floor(x0 / TILE_KM), i1 = Math.floor(x1 / TILE_KM), j0 = Math.floor(z0 / TILE_KM), j1 = Math.floor(z1 / TILE_KM);
        for (let j = j0; j <= j1; j++)
          for (let i = i0; i <= i1; i++) {
            const key = this.key(i, j);
            const r = tmp.get(key);
            if (r) { r[0] = Math.min(r[0], s); r[1] = Math.max(r[1], s + sl); } else tmp.set(key, [s, s + sl]);
          }
        s += sl;
      }
      for (const [key, r] of tmp) {
        let a = this.index.get(key);
        if (!a) this.index.set(key, (a = []));
        a.push(e.id, Math.max(0, r[0] - STEP_KM), Math.min(s, r[1] + STEP_KM));
      }
    }
    for (const n of graph.nodes) {
      if (n.edges.length < 2) continue;
      const key = this.key(Math.floor(n.x / TILE_KM), Math.floor(n.z / TILE_KM));
      let a = this.nodeIndex.get(key);
      if (!a) this.nodeIndex.set(key, (a = []));
      a.push(n.id);
    }
  }

  key(tx: number, tz: number): number {
    return (tx + 64) * 1024 + (tz + 64);
  }

  /** [edge, s0, s1, ...] der Kanten, die in die Kachel hineinreichen */
  tileEdges(tx: number, tz: number): number[] | undefined {
    return this.index.get(this.key(tx, tz));
  }

  tileNodes(tx: number, tz: number): number[] | undefined {
    return this.nodeIndex.get(this.key(tx, tz));
  }

  stations(eid: number): Stations {
    let st = this.cache.get(eid);
    if (st) return st;
    const g = this.graph.edges[eid].geom;
    const out: number[] = [g[0], g[1]];
    const cell = this.geo.cellKm;
    const ts: number[] = [];
    for (let k = 2; k < g.length; k += 2) {
      const px = g[k - 2], pz = g[k - 1];
      const dx = g[k] - px, dz = g[k + 1] - pz;
      const len = Math.hypot(dx, dz);
      const cnt = Math.max(1, Math.ceil(len / STEP_KM));
      ts.length = 0;
      for (let q = 1; q < cnt; q++) ts.push(q / cnt);
      // Knicklinien des Geländegitters (Zellkanten + Diagonale): Stützpunkte genau dort -> Band liegt je Dreieck eben
      if (Math.abs(dx) > 1e-9) {
        const a = Math.floor(Math.min(px, px + dx) / cell) + 1, b = Math.floor(Math.max(px, px + dx) / cell);
        for (let m = a; m <= b; m++) { const t = (m * cell - px) / dx; if (t > 0 && t < 1) ts.push(t); }
      }
      if (Math.abs(dz) > 1e-9) {
        const a = Math.floor(Math.min(pz, pz + dz) / cell) + 1, b = Math.floor(Math.max(pz, pz + dz) / cell);
        for (let m = a; m <= b; m++) { const t = (m * cell - pz) / dz; if (t > 0 && t < 1) ts.push(t); }
      }
      if (Math.abs(dx + dz) > 1e-9) {
        const sum0 = px + pz, sum1 = sum0 + dx + dz;
        const a = Math.floor(Math.min(sum0, sum1) / cell) + 1, b = Math.floor(Math.max(sum0, sum1) / cell);
        for (let m = a; m <= b; m++) { const t = (m * cell - sum0) / (dx + dz); if (t > 0 && t < 1) ts.push(t); }
      }
      ts.sort((u, v) => u - v);
      let last = 0;
      const minT = 0.002 / Math.max(len, 1e-6);
      for (const t of ts) {
        if (t - last < minT || 1 - t < minT) continue;
        out.push(px + dx * t, pz + dz * t);
        last = t;
      }
      out.push(g[k], g[k + 1]);
    }
    const n = out.length / 2;
    const xz = new Float32Array(out);
    const cum = new Float32Array(n), tx = new Float32Array(n), tz = new Float32Array(n);
    for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(xz[i * 2] - xz[i * 2 - 2], xz[i * 2 + 1] - xz[i * 2 - 1]);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      let dx = xz[b * 2] - xz[a * 2], dz = xz[b * 2 + 1] - xz[a * 2 + 1];
      const l = Math.hypot(dx, dz) || 1;
      dx /= l; dz /= l;
      tx[i] = dx; tz[i] = dz;
    }
    st = { n, xz, cum, tx, tz, total: cum[n - 1] };
    this.cache.set(eid, st);
    return st;
  }

  /** Punkt + Tangente bei Bogenlänge s (km); out = [x,z,tx,tz] */
  pointAt(st: Stations, s: number, out: Float64Array | number[]): void {
    if (s <= 0) s = 0;
    if (s >= st.total) s = st.total;
    let lo = 0, hi = st.n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (st.cum[m] <= s) lo = m; else hi = m;
    }
    const l = st.cum[hi] - st.cum[lo] || 1e-9;
    const f = Math.max(0, Math.min(1, (s - st.cum[lo]) / l));
    out[0] = st.xz[lo * 2] + (st.xz[hi * 2] - st.xz[lo * 2]) * f;
    out[1] = st.xz[lo * 2 + 1] + (st.xz[hi * 2 + 1] - st.xz[lo * 2 + 1]) * f;
    let tx = st.tx[lo] + (st.tx[hi] - st.tx[lo]) * f, tz = st.tz[lo] + (st.tz[hi] - st.tz[lo]) * f;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl; tz /= tl;
    out[2] = tx; out[3] = tz;
  }

  /** Abstand zur nächsten Stadt in Stadtradien (0 = Zentrum, 1 = Stadtrand, groß = ländlich) */
  townDist(x: number, z: number): number {
    let best = 99;
    for (const c of this.cities) {
      const d = Math.hypot(x - c.x, z - c.z) / c.r;
      if (d < best) best = d;
    }
    return best;
  }

  /** Bahnübergänge (Schiene kreuzt Straße ohne Brücke) innerhalb der Kachel */
  crossings(tx: number, tz: number): Crossing[] {
    const list = this.index.get(this.key(tx, tz));
    const out: Crossing[] = [];
    if (!list) return out;
    const x0 = tx * TILE_KM, x1 = x0 + TILE_KM, z0 = tz * TILE_KM, z1 = z0 + TILE_KM;
    const rails: number[] = [], roads: number[] = [];
    for (let i = 0; i < list.length; i += 3) {
      const e = this.graph.edges[list[i]];
      if (e.cls === 'ferry' || e.bridge) continue;
      if (e.cls === 'rail') rails.push(e.id); else roads.push(e.id);
    }
    for (const re of rails) {
      const rg = this.graph.edges[re].geom;
      for (let a = 0; a + 3 < rg.length; a += 2) {
        for (const oe of roads) {
          const og = this.graph.edges[oe].geom;
          for (let b = 0; b + 3 < og.length; b += 2) {
            const rx = rg[a + 2] - rg[a], rz = rg[a + 3] - rg[a + 1];
            const sx = og[b + 2] - og[b], sz = og[b + 3] - og[b + 1];
            const den = rx * sz - rz * sx;
            if (Math.abs(den) < 1e-9) continue;
            const qx = og[b] - rg[a], qz = og[b + 1] - rg[a + 1];
            const t = (qx * sz - qz * sx) / den;
            const u = (qx * rz - qz * rx) / den;
            if (t < 0.03 || t > 0.97 || u < 0.03 || u > 0.97) continue;
            const x = rg[a] + rx * t, z = rg[a + 1] + rz * t;
            if (x < x0 || x >= x1 || z < z0 || z >= z1) continue;
            const rl = Math.hypot(rx, rz) || 1, sl = Math.hypot(sx, sz) || 1;
            out.push({ x, z, rtx: sx / sl, rtz: sz / sl, ttx: rx / rl, ttz: rz / rl, roadHwM: HALF_WIDTH_M[this.graph.edges[oe].cls], roadEdge: oe, railEdge: re });
          }
        }
      }
    }
    return out;
  }

  /** Rastplätze (Park-/Rastbuchten) an Autobahnen/Fernstraßen innerhalb der Kachel */
  restStops(tx: number, tz: number): RestStop[] {
    const list = this.index.get(this.key(tx, tz));
    const out: RestStop[] = [];
    if (!list) return out;
    const x0 = tx * TILE_KM, x1 = x0 + TILE_KM, z0 = tz * TILE_KM, z1 = z0 + TILE_KM;
    const tmp = [0, 0, 0, 0];
    for (let i = 0; i < list.length; i += 3) {
      const e = this.graph.edges[list[i]];
      if ((e.cls !== 'motorway' && e.cls !== 'primary') || e.bridge || e.lengthKm < 0.7) continue;
      if (ihash(e.id, 7, 1) > (e.cls === 'motorway' ? 0.16 : 0.08)) continue;
      const st = this.stations(e.id);
      const s = st.total * (0.42 + ihash(e.id, 7, 2) * 0.16);
      this.pointAt(st, s, tmp);
      if (tmp[0] < x0 || tmp[0] >= x1 || tmp[1] < z0 || tmp[1] >= z1) continue;
      out.push({ edge: e.id, s, x: tmp[0], z: tmp[1], tx: tmp[2], tz: tmp[3], side: ihash(e.id, 7, 3) < 0.5 ? -1 : 1, hwM: HALF_WIDTH_M[e.cls] });
    }
    return out;
  }
}

const netCache = new WeakMap<NavGraph, RoadNet>();
/** Ein RoadNet je NavGraph (geteilt von RoadRenderer und BridgeRenderer) */
export function getRoadNet(geo: GeoData, graph: NavGraph): RoadNet {
  let n = netCache.get(graph);
  if (!n) netCache.set(graph, (n = new RoadNet(geo, graph)));
  return n;
}

// ----------------------------------------------------------------------- Band-Builder

/**
 * Sammelt Fahrbahnband-Vertices. Attribute je Vertex:
 *   position (x, 0, z) – Mittelpunkt;
 *   aSide (perpX, perpZ, Seite −1/0/+1, Querversatz km)
 *   aInfo (Längsposition km, Halbbreite km, Typ, gesperrt)
 * Endposition = Mittelpunkt + perp·(Seite·Halbbreite + Querversatz)·S (S auf der GPU).
 */
export class RibbonBuilder {
  pos: number[] = [];
  side: number[] = [];
  info: number[] = [];
  idx: number[] = [];
  /** Vertex-Bereich je Kante (für gesperrt-Umschaltung): edge -> [start, count][] */
  ranges = new Map<number, Array<[number, number]>>();

  get vcount(): number {
    return this.pos.length / 3;
  }

  vertex(x: number, z: number, px: number, pz: number, sd: number, latOff: number, along: number, hwKm: number, type: number, closed: number): number {
    const v = this.pos.length / 3;
    this.pos.push(x, 0, z);
    this.side.push(px, pz, sd, latOff);
    this.info.push(along, hwKm, type, closed);
    return v;
  }

  /** Band entlang der Stützpunkte i0..i1 (einschließlich) */
  strip(st: Stations, i0: number, i1: number, hwM: number, type: number, closed: number, latOffKm = 0, edge = -1, hwEndScale?: (i: number) => number): void {
    if (i1 <= i0) return;
    const start = this.vcount;
    for (let i = i0; i <= i1; i++) {
      const x = st.xz[i * 2], z = st.xz[i * 2 + 1];
      const px = -st.tz[i], pz = st.tx[i];
      const hw = (hwM * 0.001) * (hwEndScale ? hwEndScale(i) : 1);
      const a = this.vertex(x, z, px, pz, -1, latOffKm, st.cum[i], hw, type, closed);
      this.vertex(x, z, px, pz, 0, latOffKm, st.cum[i], hw, type, closed);
      this.vertex(x, z, px, pz, 1, latOffKm, st.cum[i], hw, type, closed);
      if (i > i0) this.idx.push(a - 3, a - 2, a, a - 2, a + 1, a, a - 2, a - 1, a + 1, a - 1, a + 2, a + 1);
    }
    if (edge >= 0) {
      let arr = this.ranges.get(edge);
      if (!arr) this.ranges.set(edge, (arr = []));
      arr.push([start, this.vcount - start]);
    }
  }

  /** Scheibe (Kreuzungsfläche) */
  disc(x: number, z: number, rM: number, type: number, segs = 10): void {
    const r = rM * 0.001;
    const c = this.vertex(x, z, 1, 0, 0, 0, 0, r, type, 0);
    const first = this.vcount;
    for (let k = 0; k < segs; k++) {
      const a = (k / segs) * Math.PI * 2;
      this.vertex(x, z, Math.cos(a), Math.sin(a), 1, 0, 0, r, type, 0);
    }
    for (let k = 0; k < segs; k++) this.idx.push(c, first + k, first + ((k + 1) % segs));
  }

  /** Kurzes gerades Band um (x,z) in Richtung (tx,tz) (Länge lenM, Halbbreite hwM) */
  bar(x: number, z: number, tx: number, tz: number, lenM: number, hwM: number, type: number, latOffKm = 0, along0 = 0): void {
    const hl = lenM * 0.0005;
    const px = -tz, pz = tx;
    const a = this.vertex(x - tx * hl, z - tz * hl, px, pz, -1, latOffKm, along0, hwM * 0.001, type, 0);
    this.vertex(x - tx * hl, z - tz * hl, px, pz, 1, latOffKm, along0, hwM * 0.001, type, 0);
    this.vertex(x + tx * hl, z + tz * hl, px, pz, -1, latOffKm, along0 + hl * 2, hwM * 0.001, type, 0);
    this.vertex(x + tx * hl, z + tz * hl, px, pz, 1, latOffKm, along0 + hl * 2, hwM * 0.001, type, 0);
    this.idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }

  /** Band entlang einer Folge von Punkten (Bézier/Rampe), Tangenten aus Nachbarn */
  poly(pts: number[], hwM: number, type: number, hwScale?: (f: number) => number): void {
    const n = pts.length / 2;
    if (n < 2) return;
    let along = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      let dx = pts[b * 2] - pts[a * 2], dz = pts[b * 2 + 1] - pts[a * 2 + 1];
      const l = Math.hypot(dx, dz) || 1;
      dx /= l; dz /= l;
      if (i > 0) along += Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]);
      const hw = hwM * 0.001 * (hwScale ? hwScale(i / (n - 1)) : 1);
      const v = this.vertex(pts[i * 2], pts[i * 2 + 1], -dz, dx, -1, 0, along, hw, type, 0);
      this.vertex(pts[i * 2], pts[i * 2 + 1], -dz, dx, 1, 0, along, hw, type, 0);
      if (i > 0) this.idx.push(v - 2, v - 1, v, v - 1, v + 1, v);
    }
  }

  toGeometry(): THREE.BufferGeometry | null {
    if (this.idx.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('aSide', new THREE.BufferAttribute(new Float32Array(this.side), 4));
    const info = new THREE.BufferAttribute(new Float32Array(this.info), 4);
    info.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aInfo', info);
    g.setIndex(new THREE.BufferAttribute(this.vcount > 65535 ? new Uint32Array(this.idx) : new Uint16Array(this.idx), 1));
    return g;
  }
}

/** Index des ersten Stützpunkts mit cum >= s */
export function stationAtOrAfter(st: Stations, s: number): number {
  let lo = 0, hi = st.n - 1;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (st.cum[m] < s) lo = m + 1; else hi = m;
  }
  return lo;
}

/** Index des letzten Stützpunkts mit cum <= s */
export function stationAtOrBefore(st: Stations, s: number): number {
  let lo = 0, hi = st.n - 1;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (st.cum[m] <= s) lo = m; else hi = m - 1;
  }
  return lo;
}
