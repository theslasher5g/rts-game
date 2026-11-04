import * as THREE from 'three';
import type { GeoData } from './GeoData';
import type { Settings } from '../core/types';
import type { NavGraph } from '../nav/NavGraph';
import type { BuildingInfo } from '../combat/types';
import { BT, BuildingLayer, STRIDE, WALL_MED, WALL_NORDIC, WALL_WEST, ROOF_MED, ROOF_NORDIC, ROOF_WEST, BUILDING_DAMAGED_BELOW, cityRadiusKm, pick, terrainHeightKm, type Cities } from './Cities';
import { STYLE_SHIFT, getBuildingMaterial } from './BuildingModels';
import { BuildingFires, DECAL, DecalSet, PROP, PropLayer, setDecalParams, setPropParams, type PropInst } from './StreetProps';
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
const MED = new Set(['ESP', 'PRT', 'ITA', 'GRC', 'TUR', 'MLT', 'MAR']);
const NORDIC = new Set(['NOR', 'SWE', 'FIN', 'DNK', 'ISL']);

const CROPS = [0xc8b46a, 0x7a9a48, 0x8a6a46, 0xb4b27c, 0x5f8a3a, 0xd2c27e, 0x6f9040];

interface Field { x: number; z: number; w: number; d: number; rot: number; color: number; heights: Float32Array }

type DecalDef = [number, number, number, number, number, number, number];

interface Village {
  props: PropInst[];
  decals: DecalDef[];
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
  props: PropLayer | null;
  decals: DecalSet | null;
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
  private readonly fires = new BuildingFires(24);
  private readonly scorch: DecalSet;
  private readonly scorchSlot = new Map<number, number>();
  private lastT = 0;

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
    this.scorch = new DecalSet(geo, 256);
    this.group.add(this.scorch.mesh, this.fires.object);
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
    const timberP = a3 === 'VAL' ? 0.55 : a3 === 'KRN' ? 0.4 : style === 0 ? 0.25 : 0;
    const ca = Math.cos(theta), sa = Math.sin(theta);
    const L = Math.ceil(n / 2) * 0.062;
    const data: number[] = [], typ: number[] = [], roof: number[] = [];
    const fields: Field[] = [];
    const props: PropInst[] = [];
    const decals: DecalDef[] = [];
    let k = 0;
    const W = (a: number, b: number): [number, number] => [x + a * ca + b * sa, z - a * sa + b * ca];
    const rotA = theta, rotB = theta - Math.PI / 2;
    const prop = (p: number, a: number, b: number, rot: number, sc = 1, tint = 0.5, len = 1): void => {
      const [wx, wz] = W(a, b);
      if (this.waterAt(wx, wz)) return;
      props.push({ p, x: wx, z: wz, rot, s: sc, tint, len });
    };
    const decal = (kind: number, a: number, b: number, w: number, d: number, rot: number, seed: number): void => {
      const [wx, wz] = W(a, b);
      if (this.waterAt(wx, wz)) return;
      decals.push([kind, wx, wz, w, d, rot, seed]);
    };
    const put = (a: number, b: number, w: number, h: number, d: number, rotLocal: number, type: number, wall: number, rf: number, timber = 0): boolean => {
      if (typ.length >= 63) return false;
      const wx = x + a * ca + b * sa, wz = z - a * sa + b * ca;
      if (this.waterAt(wx, wz)) return false;
      const hw = Math.max(w, d) * 0.6;
      const base = Math.min(terrainHeightKm(g, wx - hw, wz - hw), terrainHeightKm(g, wx + hw, wz - hw), terrainHeightKm(g, wx - hw, wz + hw), terrainHeightKm(g, wx + hw, wz + hw), terrainHeightKm(g, wx, wz));
      data.push(wx, wz, w, h, d, theta + rotLocal + (rnd(40 + k) - 0.5) * 0.08, Math.max(0.0005, base), wall);
      typ.push(type);
      roof.push(((rf | ((type === BT.OLD || type === BT.VILLA ? timber : 0) << STYLE_SHIFT)) >>> 0));
      return true;
    };
    const wallBase = pick(walls, rnd(1)), roofBase = pick(roofs, rnd(2));
    // Häuser beidseits der Hauptstraße, mit Hofzaun, Garten, Baum, Schuppen
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
        const timber = rnd(96 + k) < timberP ? 1 : 0;
        const ok = put(a, b, w, h, d, side === 0 ? 0 : Math.PI, style === 2 ? BT.HIP : rnd(100 + k) < 0.75 ? BT.OLD : BT.VILLA, wc, rc, timber);
        if (!ok) continue;
        // Hof: Zaun (Straßenseite teils offen), Garten, Baum
        const sg = side === 0 ? -1 : 1; // Richtung weg von der Straße
        const pw = L / per * 0.5 - 0.002;
        const bFront = b - sg * (d / 2 + 0.004), bBack = b + sg * (d / 2 + 0.038 + rnd(110 + k) * 0.02);
        const fence = rnd(120 + k) < 0.55 ? PROP.FENCE : rnd(121 + k) < 0.5 ? PROP.HEDGE : PROP.WALL;
        if (rnd(122 + k) < 0.85) {
          const bm = (bFront + bBack) / 2, bl = Math.abs(bBack - bFront);
          prop(fence, a - pw, bm, rotB, 1, 0.5, bl * 1000);
          prop(fence, a + pw, bm, rotB, 1, 0.5, bl * 1000);
          prop(fence, a, bBack, rotA, 1, 0.5, pw * 2000);
          if (rnd(123 + k) < 0.55) prop(fence, a - pw * 0.5 - 0.004, bFront, rotA, 1, 0.5, pw * 1000 - 8);
        }
        if (rnd(124 + k) < 0.75) prop(rnd(125 + k) < 0.5 ? PROP.TREE_A : PROP.TREE_D, a + (rnd(126 + k) - 0.5) * pw, b + sg * (d / 2 + 0.018), rnd(127 + k) * 6.28, 0.6 + rnd(128 + k) * 0.5, rnd(129 + k));
        if (rnd(130 + k) < 0.4) prop(PROP.BUSH, a + pw * 0.6, bFront - sg * 0.002, 0, 0.9, 0.5);
        if (rnd(131 + k) < 0.4) prop(PROP.SHED, a - pw * 0.5, bBack - sg * 0.008, rotA, 0.8 + rnd(132 + k) * 0.3, rnd(133 + k));
        if (rnd(134 + k) < 0.55) decal(DECAL.GARDEN, a + 0.004, b + sg * (d / 2 + 0.02), pw * 1.5, 0.024, rotA, rnd(135 + k));
        if (rnd(136 + k) < 0.12) prop(PROP.WELL, a + pw * 0.4, b - sg * (d / 2 - 0.004), 0, 1, 0.5);
        if (rnd(137 + k) < 0.18) prop(rnd(138 + k) < 0.5 ? PROP.CAR0 : PROP.VAN, a - pw * 0.3, b - sg * (d / 2 + 0.008), rotA, 1, rnd(139 + k));
        if (rnd(140 + k) < 0.09) prop(PROP.HAY, a - pw * 0.7, bBack - sg * 0.004, 0, 0.9, 0.5);
      }
    }
    // Kirche (größere Dörfer) mit Friedhof, Kapelle (mittlere) und Wirtschaftsgebäude
    const churchA = (rnd(3) - 0.5) * L * 0.4;
    if (n >= 22) {
      put(churchA, 0.09, 0.075, 0.07, 0.036, Math.PI, BT.CHURCH, pick(WALL_WEST, rnd(4)), 0x5a5d62);
      // Friedhof hinter der Kirche
      const cb = 0.155, cw = 0.07, cd = 0.05;
      decal(DECAL.CEMETERY, churchA + 0.02, cb, cw, cd, rotA, rnd(5));
      for (let gy = 0; gy < 4; gy++)
        for (let gx = 0; gx < 7; gx++) {
          if (rnd(300 + gy * 7 + gx) < 0.18) continue;
          prop(rnd(310 + gy * 7 + gx) < 0.3 ? PROP.CROSS : PROP.GRAVE, churchA + 0.02 - cw * 0.35 + gx * 0.0085, cb - cd * 0.32 + gy * 0.0125, rotB + Math.PI / 2, 1, 0.5);
        }
      prop(PROP.WALL, churchA + 0.02, cb - cd / 2, rotA, 1, 0.5, cw * 1000);
      prop(PROP.WALL, churchA + 0.02, cb + cd / 2, rotA, 1, 0.5, cw * 1000);
      prop(PROP.WALL, churchA + 0.02 - cw / 2, cb, rotB, 1, 0.5, cd * 1000);
      prop(PROP.WALL, churchA + 0.02 + cw / 2, cb, rotB, 1, 0.5, cd * 1000);
      for (let t = 0; t < 4; t++) prop(PROP.TREE_C, churchA - 0.04 + t * 0.05, 0.065 + (t % 2) * 0.01, rnd(320 + t) * 6.28, 0.9, rnd(330 + t));
    } else if (n >= 11 && rnd(6) < 0.6) {
      put((rnd(7) - 0.5) * L * 0.5, -0.10, 0.035, 0.022, 0.02, 0, BT.CHAPEL, pick(WALL_WEST, rnd(8)), 0x5a5d62);
      prop(PROP.TREE_D, (rnd(7) - 0.5) * L * 0.5 + 0.03, -0.10, 0, 1, 0.4);
    }
    const barns = Math.floor(n / 9) + (n > 8 ? 1 : 0);
    for (let q = 0; q < barns; q++) {
      const a = (rnd(110 + q) - 0.5) * L;
      const side = q % 2 === 0 ? 1 : -1;
      const bb = side * (0.095 + rnd(120 + q) * 0.015);
      put(a, bb, 0.05 + rnd(130 + q) * 0.015, 0.013, 0.03, side > 0 ? Math.PI : 0, BT.BARN, pick([0x8a5a3c, 0x9a6a44, 0x7a5a40, 0xa89070], rnd(140 + q)), pick([0x6a4a3a, 0x7a3a2e, 0x5a5a5e], rnd(145 + q)));
      // Hoffläche, Heu, Ballen, Traktor
      decal(DECAL.YARD, a, bb - side * 0.03, 0.09, 0.05, rotA, rnd(350 + q));
      for (let h = 0; h < 1 + Math.floor(rnd(360 + q) * 3); h++) prop(PROP.HAY, a + 0.04 + h * 0.012, bb + side * 0.03 + (h % 2) * 0.006, 0, 0.9 + rnd(370 + h) * 0.3, 0.5);
      for (let h = 0; h < 3; h++) prop(PROP.BALE, a - 0.045 + h * 0.008, bb + side * 0.034, rotA, 0.9, 0.5);
      if (rnd(380 + q) < 0.55) {
        prop(PROP.TRACTOR, a - 0.02, bb - side * 0.032, rotA + (rnd(381 + q) < 0.5 ? 0 : Math.PI), 1, 0.5);
        if (rnd(382 + q) < 0.6) prop(PROP.TRAILER, a - 0.007, bb - side * 0.032, rotA, 1, 0.5);
      }
      if (n > 14 && rnd(390 + q) < 0.45) put(a + 0.07, bb, 0.04, 0.04 + rnd(391 + q) * 0.02, 0.04, 0, BT.SILO, 0xb9b5aa, 0x888880);
      if (n >= 14 && rnd(395 + q) < 0.5) put(a - 0.06, bb + side * 0.01, 0.06, 0.008, 0.025, side > 0 ? Math.PI : 0, BT.STABLE, pick([0x8a5a3c, 0xa89070, 0x9a8a78], rnd(396 + q)), pick([0x6a4a3a, 0x5a5a5e], rnd(397 + q)));
    }
    // Dorfteich
    if (rnd(400) < 0.4) {
      const pa = (rnd(401) - 0.5) * L * 0.6, pb = (rnd(402) < 0.5 ? -1 : 1) * (0.2 + rnd(403) * 0.05);
      decal(DECAL.POND, pa, pb, 0.08 + rnd(404) * 0.03, 0.06, rotA, rnd(405));
      for (let t = 0; t < 4; t++) prop(PROP.TREE_D, pa + (rnd(406 + t) - 0.5) * 0.1, pb + (rnd(410 + t) - 0.5) * 0.08, rnd(414 + t) * 6.28, 0.9, rnd(418 + t));
    }
    // Obstgarten / Weinberg
    const orch = rnd(420) < 0.25 && n > 8;
    if (orch) {
      const oa = (rnd(421) - 0.5) * L * 0.4, ob = (rnd(422) < 0.5 ? -1 : 1) * 0.34;
      for (let i = 0; i < 6; i++) for (let j = 0; j < 5; j++) prop(PROP.TREE_A, oa + i * 0.011, ob + j * 0.011, rnd(423 + i + j * 6) * 6.28, 0.9, rnd(460 + i + j * 6));
    }
    if ((style === 2 || a3 === 'VAL') && !orch && n > 6 && rnd(430) < (style === 2 ? 0.55 : 0.3) && hk > 0.005) {
      const va = (rnd(431) - 0.5) * L * 0.3, vb = (rnd(432) < 0.5 ? -1 : 1) * 0.3;
      decal(DECAL.VINEYARD, va, vb + 0.02, 0.12, 0.062, rotA, rnd(433));
      for (let rw = 0; rw < 9; rw++) prop(PROP.VINE, va, vb + 0.0035 + rw * 0.0066, rotA, 1, 0.5, 120);
    }
    // Felder
    const nf = 2 + Math.floor(n / 9) + Math.floor(rnd(150) * 3);
    for (let q = 0; q < nf; q++) {
      const side = q % 2 === 0 ? 1 : -1;
      const w = 0.12 + rnd(160 + q) * 0.18, d = 0.09 + rnd(170 + q) * 0.13;
      const a = (rnd(180 + q) - 0.5) * (L + 0.3);
      const b = side * (0.16 + d / 2 + rnd(190 + q) * 0.12 + (orch ? 0.1 : 0));
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
      data: new Float32Array(data), typ: Uint8Array.from(typ), roof: Uint32Array.from(roof), integ: new Float32Array(cnt).fill(1), fields, props, decals,
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
    this.hazards(v, i);
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

  /** Brand/Brandfleck eines Hauses (Integrität < 0.35 brennt 60..120 s, Trümmer hinterlassen einen Brandfleck) */
  private hazards(v: Village, i: number): void {
    const o = i * STRIDE, d = v.data;
    const id = ID_OFFSET + v.id * 64 + i;
    const g = v.integ[i];
    if (g < BUILDING_DAMAGED_BELOW) {
      const dur = 60 + 60 * Math.abs((Math.sin(id * 78.233) * 43758.5453) % 1);
      this.fires.ignite(id, d[o], d[o + 1], d[o + 6], d[o + 3] * (g <= 0 ? 0.3 : 0.75), Math.max(d[o + 2], d[o + 4]) * 0.5, dur);
    } else this.fires.extinguish(id);
    if (g <= 0 && !this.scorchSlot.has(id)) {
      const sz = Math.max(0.04, Math.max(d[o + 2], d[o + 4]) * 1.9);
      this.scorchSlot.set(id, this.scorch.add(DECAL.SCORCH, d[o], d[o + 1], sz, sz * 0.9, d[o + 5], (id % 97) / 97));
    }
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
    const chunk: Chunk = { group, layer: null, props: null, decals: null, fieldsMesh: null, offsets: new Map(), integ: new Float32Array(0), cx: (ci + 0.5) * CHUNK_KM, cz: (cj + 0.5) * CHUNK_KM };
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
      const plist: PropInst[] = [];
      const dlist: DecalDef[] = [];
      for (const v of vills) {
        for (const q of v.props) plist.push(q);
        for (const q of v.decals) dlist.push(q);
      }
      if (plist.length) {
        chunk.props = new PropLayer(this.geo, plist, CHUNK_KM);
        group.add(chunk.props.group);
      }
      if (dlist.length) {
        const ds = new DecalSet(this.geo, dlist.length);
        for (const q of dlist) ds.add(q[0], q[1], q[2], q[3], q[4], q[5], q[6]);
        chunk.decals = ds;
        group.add(ds.mesh);
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
    ch.props?.dispose();
    ch.decals?.dispose();
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
    setPropParams(this.exag, D);
    setDecalParams(this.exag, D);
    const nowS = performance.now() / 1000;
    const dtS = this.lastT > 0 ? Math.min(0.1, nowS - this.lastT) : 0;
    this.lastT = nowS;
    this.fires.setExag(this.exag);
    this.fires.update(dtS, camera, nowS % 4096);
    getBuildingMaterial().uniforms.uTime.value = nowS % 4096;
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
    for (const ch of this.chunks.values()) {
      ch.layer?.update(camera.position, true, 24, 120);
      ch.props?.update(camera.position, 10);
    }
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
