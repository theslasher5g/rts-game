import * as THREE from 'three';
import type { GeoData } from './GeoData';
import type { Settings } from '../core/types';
import type { NavGraph } from '../nav/NavGraph';
import type { BuildingInfo } from '../combat/types';
import { BT, BuildingLayer, STRIDE, WALL_MED, WALL_NORDIC, WALL_WEST, ROOF_MED, ROOF_NORDIC, ROOF_WEST, cityRadiusKm, pick, terrainHeightKm, type Cities } from './Cities';
import { forestMask } from './Terrain';

/**
 * Prozedurale Dörfer und Kleinstädte (deterministisch aus einem 5-km-Zellraster), in 20-km-Chunks um die Kamera gestreamt.
 *
 * - Je Zelle höchstens ein Dorf; Wahrscheinlichkeit nach Land/Region (West-/Mitteleuropa dicht, Russland/Skandinavien dünn),
 *   nur an Land im Flachland, nicht in Stadtbebauung, bevorzugt an Straßen (Dorf wird an die nächste Straße gelegt, Hauptstraße
 *   folgt deren Richtung). 5..60 Häuser beidseits einer Hauptstraße, Kirche ab ~22 Häusern, Scheunen, Höfe mit Feldern
 *   (Bodendekale, auf das Gelände gelegt).
 * - Gebäude werden mit demselben BuildingLayer/Material wie Cities gerendert (Detail-LOD bis ~22 km, danach Quader, ab ~110 km aus).
 *
 * Haus-IDs: 1_000_000 + cellIndex * 64 + hausIndex (kollidiert nie mit Cities-IDs). findHouseAt / damageHouse arbeiten auf
 * erzeugten Dörfern (Zellen werden bei Bedarf erzeugt); Integration in StructureManager/CombatSystem ist Sache des Leads.
 */

const CELL_KM = 5;
const CHUNK_CELLS = 4;
const CHUNK_KM = CELL_KM * CHUNK_CELLS;
const ID_OFFSET = 1_000_000;
const MAX_VISIBLE_D = 110;
const MAX_BUILDS_PER_FRAME = 1;

function ihash(a: number, b: number, c: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const HI = new Set(['DEU', 'FRA', 'GBR', 'BEL', 'NLD', 'LUX', 'CHE', 'AUT', 'CZE', 'SVK', 'POL', 'HUN', 'ROU', 'IRL', 'DNK', 'SVN', 'HRV', 'LIE', 'BGR', 'SRB', 'ITA']);
const MID = new Set(['UKR', 'BLR', 'LTU', 'LVA', 'EST', 'MDA', 'ESP', 'PRT', 'GRC', 'ALB', 'MKD', 'BIH', 'MNE', 'KOS', 'TUR']);
const LOW = new Set(['RUS', 'FIN', 'SWE', 'NOR', 'ISL', 'KAZ', 'GEO', 'ARM', 'AZE']);
const MED = new Set(['ESP', 'PRT', 'ITA', 'GRC', 'TUR', 'MLT']);
const NORDIC = new Set(['NOR', 'SWE', 'FIN', 'DNK', 'ISL']);

const CROPS = [0xc8b46a, 0x7a9a48, 0x8a6a46, 0xb4b27c, 0x5f8a3a, 0xd2c27e, 0x6f9040];

interface Field { x: number; z: number; w: number; d: number; rot: number; color: number; heights: Float32Array }

interface Village {
  id: number; // cellIndex
  x: number; z: number;
  radius: number;
  country: string;
  pop: number;
  n: number;
  data: Float32Array;
  typ: Uint8Array;
  roof: Uint32Array;
  integ: Float32Array;
  fields: Field[];
}

interface Chunk {
  group: THREE.Group;
  layer: BuildingLayer | null;
  fieldsMesh: THREE.Mesh | null;
  /** je Dorf: Offset im Layer */
  offsets: Map<number, number>;
  integ: Float32Array;
  cx: number; cz: number;
}

const F_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
#include <fog_pars_vertex>
attribute vec3 aCol;
uniform float uExag;
uniform float uLift;
varying vec3 vColor;
void main() {
  vColor = aCol;
  vec3 p = vec3(position.x, position.y * uExag + uLift, position.z);
  vec4 mvPosition = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;
const F_FRAG = /* glsl */ `
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

export class Villages {
  readonly object: THREE.Object3D;
  /** Bisher erzeugte Dörfer (wächst beim Streamen / bei findHouseAt) */
  villages: Array<{ id: number; x: number; z: number; pop: number; country: string }> = [];

  private readonly geo: GeoData;
  private readonly graph?: NavGraph;
  private readonly cityCircles: Array<{ x: number; z: number; r: number }>;
  private readonly group = new THREE.Group();
  private readonly cache = new Map<number, Village | null>();
  private readonly chunks = new Map<string, Chunk>();
  private readonly fieldMat: THREE.ShaderMaterial;
  private readonly cellsX: number;
  private readonly cellsZ: number;
  private exag = 6;
  private show = true;
  private readonly frustum = new THREE.Frustum();
  private readonly pv = new THREE.Matrix4();
  private readonly dir = new THREE.Vector3();
  private readonly sph = new THREE.Sphere();
  private readonly infos = new Map<number, BuildingInfo>();

  constructor(geo: GeoData, settings: Settings, cities?: Cities, graph?: NavGraph) {
    this.geo = geo;
    this.graph = graph;
    this.cellsX = Math.ceil(geo.widthKm / CELL_KM);
    this.cellsZ = Math.ceil(geo.heightKm / CELL_KM);
    const fp = cities ? cities.cityFootprints() : geo.meta.cities.map((c) => ({ x: c.pos[0], z: c.pos[1], r: cityRadiusKm(c.pop, c.capital) * 1.2 }));
    this.cityCircles = fp.map((c) => ({ x: c.x, z: c.z, r: c.r + 0.5 }));
    this.fieldMat = new THREE.ShaderMaterial({
      vertexShader: F_VERT,
      fragmentShader: F_FRAG,
      uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), uExag: { value: settings.heightExaggeration }, uLift: { value: 0.02 } },
      fog: true,
    });
    this.group.name = 'Villages';
    this.object = this.group;
    this.exag = settings.heightExaggeration;
    this.applySettings(settings);
  }

  // ------------------------------------------------------------------ Generierung

  private waterAt(x: number, z: number): boolean {
    const g = this.geo;
    const i = Math.floor(x / g.cellKm), j = Math.floor(z / g.cellKm);
    if (i < 0 || j < 0 || i >= g.width || j >= g.height) return true;
    return g.waterFlags[j * g.width + i] !== 0 || g.countryIds[j * g.width + i] === 0;
  }

  private probFor(a3: string, lat: number): number {
    if (HI.has(a3)) return 0.92;
    if (MID.has(a3)) return 0.55;
    if (LOW.has(a3)) return lat < 0.25 ? 0.2 : 0.3;
    return 0.22;
  }

  private village(ci: number, cj: number): Village | null {
    if (ci < 0 || cj < 0 || ci >= this.cellsX || cj >= this.cellsZ) return null;
    const id = cj * this.cellsX + ci;
    const cached = this.cache.get(id);
    if (cached !== undefined) return cached;
    const v = this.generate(ci, cj, id);
    this.cache.set(id, v);
    if (v) this.villages.push({ id: v.id, x: v.x, z: v.z, pop: v.pop, country: v.country });
    return v;
  }

  private generate(ci: number, cj: number, id: number): Village | null {
    const g = this.geo;
    let x = (ci + 0.12 + 0.76 * ihash(ci, cj, 1)) * CELL_KM;
    let z = (cj + 0.12 + 0.76 * ihash(ci, cj, 2)) * CELL_KM;
    const cid = g.countryAt(x, z);
    if (cid === 0 || this.waterAt(x, z)) return null;
    const a3 = g.countriesById.get(cid)?.a3 ?? '';
    const lat = z / g.heightKm;
    if (ihash(ci, cj, 3) > this.probFor(a3, lat)) return null;
    // Straße suchen, Dorf dorthin
    let theta = ihash(ci, cj, 4) * Math.PI;
    if (this.graph) {
      const np = this.graph.nearestEdgePoint(x, z, 1.8, (e) => e.cls !== 'ferry' && e.cls !== 'rail' && e.cls !== 'motorway');
      if (np) {
        x = np.x; z = np.z;
        const p0 = this.graph.pointOnEdge(np.edge, Math.max(0, np.t - 0.01)), p1 = this.graph.pointOnEdge(np.edge, Math.min(1, np.t + 0.01));
        const dx = p1[0] - p0[0], dz = p1[1] - p0[1];
        if (Math.hypot(dx, dz) > 1e-4) theta = Math.atan2(-dz, dx);
      } else if (ihash(ci, cj, 5) > 0.35) return null;
    }
    if (this.waterAt(x, z)) return null;
    const hk = g.heightAt(x, z);
    if (hk < 0.004 || hk > 1.5) return null;
    const grad = Math.hypot(g.heightAt(x + 0.6, z) - g.heightAt(x - 0.6, z), g.heightAt(x, z + 0.6) - g.heightAt(x, z - 0.6)) / 1.2;
    if (grad > 0.1) return null;
    for (const c of this.cityCircles) if ((x - c.x) * (x - c.x) + (z - c.z) * (z - c.z) < c.r * c.r) return null;
    if (forestMask(g, x, z) > 0.9 && ihash(ci, cj, 6) < 0.7) return null;

    const rnd = (s: number) => ihash(ci, cj, 100 + s);
    const n = 6 + Math.floor(54 * Math.pow(rnd(0), 1.9));
    const style = MED.has(a3) ? 2 : NORDIC.has(a3) || lat < 0.12 ? 3 : 0;
    const walls = style === 2 ? WALL_MED : style === 3 ? WALL_NORDIC : WALL_WEST;
    const roofs = style === 2 ? ROOF_MED : style === 3 ? ROOF_NORDIC : ROOF_WEST;
    const ca = Math.cos(theta), sa = Math.sin(theta);
    const L = Math.ceil(n / 2) * 0.062;
    const data: number[] = [], typ: number[] = [], roof: number[] = [];
    const fields: Field[] = [];
    let k = 0;
    const put = (a: number, b: number, w: number, h: number, d: number, rotLocal: number, type: number, wall: number, rf: number): void => {
      if (typ.length >= 63) return;
      const wx = x + a * ca + b * sa, wz = z - a * sa + b * ca;
      if (this.waterAt(wx, wz)) return;
      const hw = Math.max(w, d) * 0.6;
      const base = Math.min(terrainHeightKm(g, wx - hw, wz - hw), terrainHeightKm(g, wx + hw, wz - hw), terrainHeightKm(g, wx - hw, wz + hw), terrainHeightKm(g, wx + hw, wz + hw), terrainHeightKm(g, wx, wz));
      data.push(wx, wz, w, h, d, theta + rotLocal + (rnd(40 + k) - 0.5) * 0.08, Math.max(0.0005, base), wall);
      typ.push(type);
      roof.push(rf);
    };
    const wallBase = pick(walls, rnd(1)), roofBase = pick(roofs, rnd(2));
    // Häuser beidseits der Hauptstraße
    const per = Math.ceil(n / 2);
    for (let side = 0; side < 2; side++) {
      for (let q = 0; q < per; q++) {
        if (side === 0 ? false : q >= n - per) break;
        k++;
        const a = (q + 0.5) * (L / per) - L / 2 + (rnd(10 + k) - 0.5) * 0.008;
        const b = (side === 0 ? -1 : 1) * (0.044 + rnd(20 + k) * 0.014);
        const r = rnd(30 + k);
        const w = 0.04 + r * 0.02, d = 0.032 + rnd(50 + k) * 0.01, h = 0.012 + rnd(60 + k) * 0.006;
        const wc = rnd(70 + k) < 0.55 ? wallBase : pick(walls, rnd(80 + k));
        const rc = rnd(90 + k) < 0.7 ? roofBase : pick(roofs, rnd(95 + k));
        put(a, b, w, h, d, side === 0 ? 0 : Math.PI, style === 2 ? BT.HIP : rnd(100 + k) < 0.75 ? BT.OLD : BT.VILLA, wc, rc);
      }
    }
    // Kirche (größere Dörfer) und Scheunen
    if (n >= 22) put((rnd(3) - 0.5) * L * 0.4, 0.09, 0.075, 0.07, 0.036, Math.PI, BT.CHURCH, pick(WALL_WEST, rnd(4)), 0x5a5d62);
    const barns = Math.floor(n / 9) + (n > 8 ? 1 : 0);
    for (let q = 0; q < barns; q++) {
      const a = (rnd(110 + q) - 0.5) * L;
      const side = q % 2 === 0 ? 1 : -1;
      put(a, side * (0.095 + rnd(120 + q) * 0.015), 0.05 + rnd(130 + q) * 0.015, 0.013, 0.03, side > 0 ? Math.PI : 0, BT.BARN, pick([0x8a5a3c, 0x9a6a44, 0x7a5a40, 0xa89070], rnd(140 + q)), pick([0x6a4a3a, 0x7a3a2e, 0x5a5a5e], rnd(145 + q)));
    }
    // Felder
    const nf = 2 + Math.floor(n / 9) + Math.floor(rnd(150) * 3);
    for (let q = 0; q < nf; q++) {
      const side = q % 2 === 0 ? 1 : -1;
      const w = 0.12 + rnd(160 + q) * 0.18, d = 0.09 + rnd(170 + q) * 0.13;
      const a = (rnd(180 + q) - 0.5) * (L + 0.3);
      const b = side * (0.16 + d / 2 + rnd(190 + q) * 0.12);
      const wx = x + a * ca + b * sa, wz = z - a * sa + b * ca;
      if (this.waterAt(wx, wz) || this.waterAt(wx + w * 0.4 * ca, wz - w * 0.4 * sa)) continue;
      const heights = new Float32Array(5 * 5);
      for (let j = 0; j < 5; j++)
        for (let i = 0; i < 5; i++) {
          const la = (i / 4 - 0.5) * w, lb = (j / 4 - 0.5) * d;
          heights[j * 5 + i] = Math.max(0, terrainHeightKm(g, wx + la * ca + lb * sa, wz - la * sa + lb * ca));
        }
      fields.push({ x: wx, z: wz, w, d, rot: theta, color: CROPS[Math.floor(rnd(200 + q) * CROPS.length)], heights });
    }
    if (typ.length === 0) return null;
    const cnt = typ.length;
    const vill: Village = {
      id, x, z, radius: Math.max(L / 2 + 0.1, 0.15) + 0.06, country: a3, pop: cnt * 4, n: cnt,
      data: new Float32Array(data), typ: Uint8Array.from(typ), roof: Uint32Array.from(roof), integ: new Float32Array(cnt).fill(1), fields,
    };
    return vill;
  }

  /** Dorf-Freiflächen (x,z,r) im Rechteck – erzeugt Zellen bei Bedarf. Für Vegetation.setClearingProvider. */
  clearingsInRect(x0: number, z0: number, x1: number, z1: number): Array<{ x: number; z: number; r: number }> {
    const out: Array<{ x: number; z: number; r: number }> = [];
    const c0 = Math.floor((x0 - 1) / CELL_KM), c1 = Math.floor((x1 + 1) / CELL_KM);
    const d0 = Math.floor((z0 - 1) / CELL_KM), d1 = Math.floor((z1 + 1) / CELL_KM);
    for (let cj = d0; cj <= d1; cj++)
      for (let ci = c0; ci <= c1; ci++) {
        const v = this.village(ci, cj);
        if (v) out.push({ x: v.x, z: v.z, r: v.radius + 0.12 });
      }
    return out;
  }

  // ------------------------------------------------------------------ Register (Häuser)

  private info(v: Village, i: number): BuildingInfo {
    const id = ID_OFFSET + v.id * 64 + i;
    let b = this.infos.get(id);
    if (!b) {
      const o = i * STRIDE, d = v.data;
      b = {
        id, x: d[o], z: d[o + 1], w: d[o + 2], d: d[o + 4], h: d[o + 3], rot: d[o + 5], country: v.country,
        integrity: v.integ[i], garrisonCapacity: Math.max(4, Math.min(12, Math.round(3 + d[o + 2] * d[o + 4] * 45 + d[o + 3] * 55))), garrisoned: 0, civilian: true,
      };
      this.infos.set(id, b);
    }
    b.integrity = v.integ[i];
    return b;
  }

  /** Haus-ID gehört zu den Dörfern (>= 1_000_000)? */
  static isHouseId(id: number): boolean {
    return id >= ID_OFFSET;
  }

  /** Nächstes nicht eingestürztes Haus, dessen Grundriss höchstens maxKm entfernt ist (IDs >= 1_000_000). */
  findHouseAt(x: number, z: number, maxKm: number): BuildingInfo | null {
    const m = maxKm + 0.1;
    const c0 = Math.floor((x - m - 1) / CELL_KM), c1 = Math.floor((x + m + 1) / CELL_KM);
    const d0 = Math.floor((z - m - 1) / CELL_KM), d1 = Math.floor((z + m + 1) / CELL_KM);
    let best: BuildingInfo | null = null, bd = maxKm;
    for (let cj = d0; cj <= d1; cj++)
      for (let ci = c0; ci <= c1; ci++) {
        const v = this.village(ci, cj);
        if (!v) continue;
        for (let i = 0; i < v.n; i++) {
          if (v.integ[i] <= 0) continue;
          const o = i * STRIDE, d = v.data;
          const dx = x - d[o], dz = z - d[o + 1];
          const c = Math.cos(d[o + 5]), s = Math.sin(d[o + 5]);
          const lx = Math.abs(c * dx - s * dz) - d[o + 2] * 0.5, lz = Math.abs(s * dx + c * dz) - d[o + 4] * 0.5;
          const dist = Math.hypot(Math.max(lx, 0), Math.max(lz, 0));
          if (dist <= bd) { bd = dist; best = this.info(v, i); }
        }
      }
    return best;
  }

  /** Haus per ID (oder null) */
  getHouse(id: number): BuildingInfo | null {
    if (id < ID_OFFSET) return null;
    const rel = id - ID_OFFSET;
    const cell = Math.floor(rel / 64), i = rel % 64;
    const v = this.village(cell % this.cellsX, Math.floor(cell / this.cellsX));
    return v && i < v.n ? this.info(v, i) : null;
  }

  /** Schaden als Integritätsverlust (0..1); bei 0 Trümmer (wie Cities). Gibt true zurück, wenn das Haus existiert. */
  damageHouse(id: number, amount: number, _x = 0, _z = 0): boolean {
    if (id < ID_OFFSET || amount <= 0) return false;
    const rel = id - ID_OFFSET;
    const cell = Math.floor(rel / 64), i = rel % 64;
    const v = this.village(cell % this.cellsX, Math.floor(cell / this.cellsX));
    if (!v || i >= v.n) return false;
    v.integ[i] = Math.max(0, v.integ[i] - amount);
    const info = this.info(v, i);
    info.integrity = v.integ[i];
    // geladenen Chunk aktualisieren
    const ck = this.chunkKey(Math.floor(v.x / CHUNK_KM), Math.floor(v.z / CHUNK_KM));
    const ch = this.chunks.get(ck);
    if (ch?.layer) {
      const off = ch.offsets.get(v.id);
      if (off !== undefined) {
        ch.integ[off + i] = v.integ[i];
        ch.layer.place(off + i);
        ch.layer.flush();
      }
    }
    return true;
  }

  // ------------------------------------------------------------------ Streaming

  private chunkKey(i: number, j: number): string {
    return `${i}:${j}`;
  }

  private buildChunk(ci: number, cj: number): void {
    const key = this.chunkKey(ci, cj);
    const group = new THREE.Group();
    const vills: Village[] = [];
    for (let j = 0; j < CHUNK_CELLS; j++)
      for (let i = 0; i < CHUNK_CELLS; i++) {
        const v = this.village(ci * CHUNK_CELLS + i, cj * CHUNK_CELLS + j);
        if (v) vills.push(v);
      }
    const chunk: Chunk = { group, layer: null, fieldsMesh: null, offsets: new Map(), integ: new Float32Array(0), cx: (ci + 0.5) * CHUNK_KM, cz: (cj + 0.5) * CHUNK_KM };
    if (vills.length) {
      let total = 0;
      for (const v of vills) total += v.n;
      const data = new Float32Array(total * STRIDE), typ = new Uint8Array(total), roof = new Uint32Array(total), integ = new Float32Array(total);
      let off = 0;
      for (const v of vills) {
        data.set(v.data, off * STRIDE);
        typ.set(v.typ, off);
        roof.set(v.roof, off);
        integ.set(v.integ, off);
        chunk.offsets.set(v.id, off);
        off += v.n;
      }
      chunk.integ = integ;
      const layer = new BuildingLayer(data, typ, roof, integ, CHUNK_KM + 1);
      layer.setExag(this.exag);
      chunk.layer = layer;
      group.add(layer.group);
      // Felder als ein Mesh
      const pos: number[] = [], col: number[] = [], idx: number[] = [];
      const c = new THREE.Color();
      for (const v of vills)
        for (const f of v.fields) {
          const ca = Math.cos(f.rot), sa = Math.sin(f.rot);
          const base = pos.length / 3;
          c.setHex(f.color);
          for (let j = 0; j < 5; j++)
            for (let i = 0; i < 5; i++) {
              const la = (i / 4 - 0.5) * f.w, lb = (j / 4 - 0.5) * f.d;
              pos.push(f.x + la * ca + lb * sa, f.heights[j * 5 + i], f.z - la * sa + lb * ca);
              const shade = j % 2 === 0 ? 1.08 : 0.9;
              const edge = i === 0 || i === 4 || j === 0 || j === 4 ? 0.7 : 1;
              col.push(c.r * shade * edge, c.g * shade * edge, c.b * shade * edge);
            }
          for (let j = 0; j < 4; j++)
            for (let i = 0; i < 4; i++) {
              const a = base + j * 5 + i, b = a + 1, cc = a + 5, d = cc + 1;
              idx.push(a, cc, b, b, cc, d);
            }
        }
      if (pos.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute('aCol', new THREE.Float32BufferAttribute(col, 3));
        g.setIndex(idx);
        g.computeBoundingSphere();
        g.boundingSphere!.radius += 10;
        const m = new THREE.Mesh(g, this.fieldMat);
        m.name = 'VillageFields';
        m.renderOrder = 1;
        chunk.fieldsMesh = m;
        group.add(m);
      }
    }
    this.group.add(group);
    this.chunks.set(key, chunk);
  }

  private removeChunk(key: string): void {
    const ch = this.chunks.get(key);
    if (!ch) return;
    this.group.remove(ch.group);
    ch.fieldsMesh?.geometry.dispose();
    if (ch.layer) {
      ch.layer.group.traverse((o) => {
        const m = o as THREE.InstancedMesh;
        if (m.isInstancedMesh) {
          m.geometry.dispose();
          m.dispose();
        }
      });
    }
    this.chunks.delete(key);
  }

  update(camera: THREE.PerspectiveCamera): void {
    if (!this.show) return;
    const D = camera.position.y;
    if (D > MAX_VISIBLE_D) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    this.fieldMat.uniforms.uLift.value = THREE.MathUtils.clamp(0.015 + D * 0.0035, 0.015, 0.6);
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
    const R = THREE.MathUtils.clamp(D * 1.5 + 14, 14, 95);
    const i0 = Math.floor((tx - R) / CHUNK_KM), i1 = Math.floor((tx + R) / CHUNK_KM);
    const j0 = Math.floor((tz - R) / CHUNK_KM), j1 = Math.floor((tz + R) / CHUNK_KM);
    const want: Array<{ i: number; j: number; d: number }> = [];
    const keep = new Set<string>();
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const cx = (i + 0.5) * CHUNK_KM, cz = (j + 0.5) * CHUNK_KM;
        const d = Math.hypot(cx - tx, cz - tz);
        if (d > R) continue;
        if (cx < -CHUNK_KM || cz < -CHUNK_KM || cx > this.geo.widthKm + CHUNK_KM || cz > this.geo.heightKm + CHUNK_KM) continue;
        this.sph.center.set(cx, 0, cz);
        this.sph.radius = CHUNK_KM * 0.8 + 8;
        if (!this.frustum.intersectsSphere(this.sph)) continue;
        keep.add(this.chunkKey(i, j));
        want.push({ i, j, d });
      }
    for (const [key, ch] of this.chunks) {
      if (keep.has(key)) continue;
      if (Math.hypot(ch.cx - tx, ch.cz - tz) > R * 1.4 + CHUNK_KM) this.removeChunk(key);
    }
    want.sort((a, b) => a.d - b.d);
    let built = 0;
    for (const w of want) {
      if (this.chunks.has(this.chunkKey(w.i, w.j))) continue;
      this.buildChunk(w.i, w.j);
      if (++built >= MAX_BUILDS_PER_FRAME) break;
    }
    for (const ch of this.chunks.values()) ch.layer?.update(camera.position, true, 24, 120);
  }

  applySettings(s: Settings): void {
    this.show = s.showCities;
    this.group.visible = s.showCities;
    this.fieldMat.uniforms.uExag.value = s.heightExaggeration;
    if (s.heightExaggeration !== this.exag) {
      this.exag = s.heightExaggeration;
      for (const ch of this.chunks.values()) ch.layer?.setExag(this.exag);
    }
  }
}
