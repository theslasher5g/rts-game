import * as THREE from 'three';
import type { GeoData } from './GeoData';
import type { Settings } from '../core/types';
import { bus } from '../core/EventBus';
import type { BuildingInfo } from '../combat/types';
import {
  BT, BT_COUNT, FAR_TOP, SINK, RUBBLE_VARIANTS, GEO_ATTRS, STYLE_SHIFT, getModels, getFarGeo, getBuildingMaterial, rngFrom, terrainHeightKm,
  type BuildingMaterial,
} from './BuildingModels';
import { SCALE } from '../core/scale';
import { BuildingFires, DecalSet, DECAL, StreetLife, setDecalParams, setPropParams, type StreetGrid } from './StreetProps';
import { Q } from '../core/quality';

export { BT, BT_COUNT, getBuildingMaterial, rngFrom, terrainHeightKm };
export type { BuildingMaterial };

/** Ab dieser Kamerahöhe (km) werden Gebäude ausgeblendet und nur Marker gezeigt */
const HIDE_DISTANCE = 2500;
/** Ab dieser Kamerahöhe werden auch die Marker ausgeblendet */
const MARKER_MAX_DISTANCE = 9000;
/** Kachel-Abstand (km) bis zu dem die detaillierten Gebäudemodelle gezeichnet werden */
// (Standard 'hoch' 36 km – Laufzeitwert: Q.cityDetailKm)
/** Kachel-Abstand (km) bis zu dem die einfachen Quader gezeichnet werden */
// (Standard 'hoch' 1800 km – Laufzeitwert: Q.cityFarKm)
/** Kachelgröße (km) für Culling/LOD */
const TILE_KM = 6;

/** Daten-Stride je Gebäude (x, z, w, h, d, rot, base, color) */
export const STRIDE = 8;
/** Raum-Hash-Zellgröße (km) */
const HASH_CELL = 1;
/** Ab dieser Integrität gilt ein Gebäude als schwer beschädigt (Ruine) */
export const BUILDING_DAMAGED_BELOW = 0.35;
/** Ab dieser Integrität leicht beschädigt (Ruß, zerbrochene Fenster, fehlende Ziegel) */
export const BUILDING_LIGHT_BELOW = 0.75;
/** Trümmerhöhe relativ zur Originalhöhe und absolutes Minimum (km) */
const RUBBLE_FRAC = 0.12;
const RUBBLE_MIN_H = 0.008;
const RUBBLE_COLOR = 0x3f3b36;

/** Ausdehnung (km) der Bebauung einer Stadt – auch für Vegetations-/Dorf-Ausschluss */
export function cityRadiusKm(pop: number, capital: boolean): number {
  const popM = Math.max(0.02, pop / 1e6);
  return Math.min(9, 0.9 + Math.sqrt(popM) * 1.5 + (capital ? 0.3 : 0));
}

// ====================================================================== Gebäude-Layer (Kacheln, LOD, Instanzen)

interface LTile {
  x0: number; x1: number; z0: number; z1: number;
  meshes: Array<THREE.InstancedMesh | null>;
  /** schwer beschädigte Varianten je Typ (lazy) */
  heavy: Array<THREE.InstancedMesh | null>;
  /** Trümmer je Variante (lazy) */
  rub: Array<THREE.InstancedMesh | null>;
  ids: number[][];
  far: THREE.InstancedMesh | null;
  farIds: number[];
  lod: number;
  sphere: THREE.Sphere | null;
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
const _fc = new THREE.Color();
const _fr = new THREE.Color();
const _qq = new THREE.Quaternion();
const HIDE16 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];

interface VarData { free: number[]; next: number }

/**
 * Gebäude-Instanzen, nach Kacheln gruppiert: je Kachel und Typ ein InstancedMesh (Detail) plus ein einfaches
 * Quader-Mesh (Fern-LOD). Schadensstufen: intakt / leicht beschädigt (Shader: Ruß, Fenster, Ziegel) -> schwer beschädigt
 * (eigenes Ruinenmodell) -> Trümmerhaufen (eigenes Modell). Die Ruinen-/Trümmermeshes werden bei Bedarf je Kachel angelegt.
 * Daten-Layout wie Cities (STRIDE) + Typ + Dachfarbe (Bits 24..27 = Stil: 1 Fachwerk).
 */
export class BuildingLayer {
  readonly group = new THREE.Group();
  readonly count: number;
  private readonly tiles: LTile[] = [];
  private readonly tileOf: Int32Array;
  private readonly slotNear: Int32Array;
  private readonly slotFar: Int32Array;
  private readonly slotVar: Int32Array;
  private readonly state: Uint8Array;
  private readonly mat: BuildingMaterial;
  private exag = 6;
  private readonly dirtyMeshes = new Set<THREE.InstancedMesh>();
  private readonly models = getModels();

  constructor(
    readonly data: Float32Array,
    readonly typ: Uint8Array,
    readonly roof: Uint32Array,
    private readonly integrity: Float32Array,
    tileKm = TILE_KM,
  ) {
    this.count = typ.length;
    this.mat = getBuildingMaterial();
    const farGeo = getFarGeo();
    this.tileOf = new Int32Array(this.count);
    this.slotNear = new Int32Array(this.count);
    this.slotFar = new Int32Array(this.count);
    this.slotVar = new Int32Array(this.count).fill(-1);
    this.state = new Uint8Array(this.count).fill(255);
    const map = new Map<number, number>();
    for (let i = 0; i < this.count; i++) {
      const tx = Math.floor(data[i * STRIDE] / tileKm), tz = Math.floor(data[i * STRIDE + 1] / tileKm);
      const key = tx * 100003 + tz;
      let ti = map.get(key);
      if (ti === undefined) {
        ti = this.tiles.length;
        map.set(key, ti);
        this.tiles.push({
          x0: tx * tileKm, x1: (tx + 1) * tileKm, z0: tz * tileKm, z1: (tz + 1) * tileKm,
          meshes: new Array(BT_COUNT).fill(null), heavy: new Array(BT_COUNT).fill(null), rub: new Array(RUBBLE_VARIANTS).fill(null),
          ids: Array.from({ length: BT_COUNT }, () => []), far: null, farIds: [], lod: -2, sphere: null,
        });
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
        const mesh = this.makeMesh(this.models.g0[k], n, `Bld${k}`);
        mesh.count = n;
        t.meshes[k] = mesh;
        this.group.add(mesh);
      }
      const far = this.makeMesh(farGeo, t.farIds.length, 'BldFar');
      far.count = t.farIds.length;
      t.far = far;
      this.group.add(far);
    }
  }

  private makeMesh(base: THREE.BufferGeometry, n: number, name: string): THREE.InstancedMesh {
    const g = new THREE.BufferGeometry();
    for (const a of GEO_ATTRS) g.setAttribute(a, base.getAttribute(a));
    g.setIndex(base.getIndex());
    g.setAttribute('aRoof', new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4));
    const mesh = new THREE.InstancedMesh(g, this.mat, n);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    mesh.matrixAutoUpdate = false;
    mesh.visible = false;
    mesh.name = name;
    return mesh;
  }

  private varMesh(t: LTile, kind: 1 | 2, idx: number): THREE.InstancedMesh {
    const arr = kind === 1 ? t.heavy : t.rub;
    let m = arr[idx];
    if (!m) {
      const n = kind === 1 ? t.ids[idx].length : t.farIds.length;
      m = this.makeMesh(kind === 1 ? this.models.gh[idx] : this.models.gr[idx], n, kind === 1 ? `BldRuin${idx}` : `BldRubble${idx}`);
      m.count = 0;
      m.userData = { free: [], next: 0 } as VarData;
      m.visible = t.lod === 0;
      if (t.sphere) m.boundingSphere = t.sphere.clone();
      arr[idx] = m;
      this.group.add(m);
    }
    return m;
  }

  private hide(m: THREE.InstancedMesh, slot: number): void {
    (m.instanceMatrix.array as Float32Array).set(HIDE16, slot * 16);
    this.dirtyMeshes.add(m);
  }

  private allocVar(m: THREE.InstancedMesh): number {
    const u = m.userData as VarData;
    const s = u.free.length ? (u.free.pop() as number) : u.next++;
    m.count = Math.max(m.count, u.next);
    return s;
  }

  private releaseVar(m: THREE.InstancedMesh | null, slot: number): void {
    if (!m || slot < 0) return;
    (m.userData as VarData).free.push(slot);
    this.hide(m, slot);
  }

  private put(m: THREE.InstancedMesh, s: number, col: THREE.Color, rc: THREE.Color, flag: number): void {
    _m.toArray(m.instanceMatrix.array as Float32Array, s * 16);
    (m.instanceColor!.array as Float32Array).set([col.r, col.g, col.b], s * 3);
    ((m.geometry.getAttribute('aRoof') as THREE.InstancedBufferAttribute).array as Float32Array).set([rc.r, rc.g, rc.b, flag], s * 4);
    this.dirtyMeshes.add(m);
  }

  /** Schadensstufe (0 intakt/leicht, 1 Ruine, 2 Trümmer) von Instanz i */
  damageState(i: number): number {
    const g = this.integrity[i];
    return g <= 0 ? 2 : g < BUILDING_DAMAGED_BELOW ? 1 : 0;
  }

  /** Instanz i aus Daten/Zustand neu berechnen (Matrix, Farben, Flags). */
  place(i: number): void {
    const e = this.exag;
    const o = i * STRIDE, d = this.data;
    const integ = this.integrity[i];
    const hScale = 1 + (e - 1) * 0.25;
    const rv = this.roof[i];
    const style = (rv >>> STYLE_SHIFT) & 15;
    const s = this.damageState(i);
    const typ = this.typ[i];
    let sx = d[o + 2], sy = d[o + 3] * hScale + SINK, sz = d[o + 4];
    _q.setFromAxisAngle(_up, d[o + 5]);
    _col.setHex(d[o + 7]);
    _rc.setHex(rv & 0xffffff);
    _fc.copy(_col);
    _fr.copy(_rc);
    let flagFar = 0, syFar = sy;
    let flag = style * 10;
    const qq = _qq.copy(_q);
    if (s === 2) {
      sy = RUBBLE_MIN_H + d[o + 3] * RUBBLE_FRAC * 0.5 + SINK;
      sx *= 1.12; sz *= 1.12;
      _col.setHex(RUBBLE_COLOR);
      _rc.setHex(RUBBLE_COLOR);
      _fc.copy(_col); _fr.copy(_rc);
      flag = 1;
      flagFar = 1;
      syFar = sy;
      _q2.setFromAxisAngle(_ax.set(Math.cos(i * 2.1), 0, Math.sin(i * 2.1)), 0.05);
      _q.multiply(_q2);
      qq.copy(_q);
    } else if (s === 1) {
      const k = 1 - integ / BUILDING_DAMAGED_BELOW;
      sy = d[o + 3] * (1 - 0.3 * k) * hScale + SINK;
      syFar = sy;
      const dk = 0.62 - 0.22 * k;
      _fc.multiplyScalar(dk);
      _fr.multiplyScalar(dk);
      _q2.setFromAxisAngle(_ax.set(Math.cos(i * 1.7), 0, Math.sin(i * 1.7)), 0.02 + 0.05 * k);
      _q.multiply(_q2);
      qq.copy(_q);
      flag = 3 + style * 10;
    } else if (integ < BUILDING_LIGHT_BELOW) {
      flag = 2 + style * 10;
      const dk = 0.9 - 0.12 * (1 - integ / BUILDING_LIGHT_BELOW);
      _fc.multiplyScalar(dk);
      _fr.multiplyScalar(dk);
    }
    _p.set(d[o], d[o + 6] * e - SINK, d[o + 1]);
    const t = this.tiles[this.tileOf[i]];
    // Zustandswechsel: alten Slot freigeben
    const prev = this.state[i];
    if (prev !== s) {
      if (prev === 0) this.hide(t.meshes[typ]!, this.slotNear[i]);
      else if (prev === 1) this.releaseVar(t.heavy[typ], this.slotVar[i]);
      else if (prev === 2) this.releaseVar(t.rub[i % RUBBLE_VARIANTS], this.slotVar[i]);
      this.slotVar[i] = -1;
      if (s === 1) this.slotVar[i] = this.allocVar(this.varMesh(t, 1, typ));
      else if (s === 2) this.slotVar[i] = this.allocVar(this.varMesh(t, 2, i % RUBBLE_VARIANTS));
      this.state[i] = s;
    }
    _s.set(sx, sy, sz);
    _m.compose(_p, _q, _s);
    if (s === 0) this.put(t.meshes[typ]!, this.slotNear[i], _col, _rc, flag);
    else if (s === 1) this.put(t.heavy[typ]!, this.slotVar[i], _col, _rc, flag);
    else this.put(t.rub[i % RUBBLE_VARIANTS]!, this.slotVar[i], _col, _rc, flag);
    // Fern-LOD (einfacher Quader)
    const far = t.far!;
    const fs = this.slotFar[i];
    _s.set(sx, syFar * (flagFar ? 1 : FAR_TOP[typ]), sz);
    _m.compose(_p, qq, _s);
    this.put(far, fs, _fc, _fr, flagFar);
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
      for (const m of t.heavy) if (m) meshes.push(m);
      for (const m of t.rub) if (m) meshes.push(m);
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
      t.sphere = new THREE.Sphere(c.clone(), r);
      for (const m of meshes) m.boundingSphere = new THREE.Sphere(c.clone(), r);
    }
  }

  /** LOD je Kachel nach Kameraabstand (nur Detailgrad, nie die Größe). */
  update(cam: THREE.Vector3, enabled: boolean, lod0 = Q.cityDetailKm, lod1 = Q.cityFarKm): void {
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
      for (const m of t.heavy) if (m) m.visible = lod === 0;
      for (const m of t.rub) if (m) m.visible = lod === 0;
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
  float g = hash21(floor(vUv * uN * 7.0));
  float g2 = hash21(floor(vUv * uN * 41.0));
  vec3 asphalt = srgb(vec3(0.23, 0.23, 0.24)) * (0.92 + 0.14 * g2);
  vec3 side = srgb(vec3(0.64, 0.62, 0.58)) * (0.92 + 0.14 * g);
  vec3 inner = srgb(vec3(0.46, 0.43, 0.38));
  if (k > 1.5 && k < 2.5) inner = srgb(vec3(0.27, 0.42, 0.2));
  else if (k > 2.5 && k < 3.5) inner = srgb(vec3(0.5, 0.49, 0.45));
  else if (k > 3.5 && k < 4.5) inner = srgb(vec3(0.34, 0.46, 0.24));
  else if (k > 4.5 && k < 5.5) inner = srgb(vec3(0.38, 0.47, 0.27));
  else if (k > 5.5) inner = srgb(vec3(0.62, 0.59, 0.52));
  inner *= 0.86 + 0.28 * g;
  vec3 col = mix(asphalt, side, 1.0 - blk);
  // Bordstein (dunkle Kante) zwischen Fahrbahn und Gehweg
  float kerb = smoothstep(0.062, 0.07, de) * (1.0 - smoothstep(0.07, 0.077, de));
  col = mix(col, srgb(vec3(0.34, 0.33, 0.32)), kerb * (1.0 - smoothstep(0.02, 0.05, aa)));
  col = mix(col, inner, walk);
  // Markierungen: Mittellinie, Zebrastreifen nahe der Kreuzung
  bool alongX = e.y < e.x;
  float s = alongX ? f.x : f.y;
  float cd = alongX ? e.y : e.x;
  float fadeM = 1.0 - smoothstep(0.012, 0.03, aa);
  float dash = step(cd, 0.006) * step(0.5, fract(s * 4.0)) * step(0.14, s) * step(s, 0.86);
  float zebraZone = (step(abs(s - 0.1), 0.02) + step(abs(s - 0.9), 0.02)) * step(cd, 0.065) * step(0.004, cd);
  float zebra = zebraZone * step(0.5, fract(cd * 90.0));
  float stop = (step(abs(s - 0.14), 0.004) + step(abs(s - 0.86), 0.004)) * step(cd, 0.065) * step(0.012, cd);
  col = mix(col, srgb(vec3(0.82, 0.78, 0.55)), dash * fadeM * (1.0 - blk) * 0.0 + dash * fadeM * 0.9);
  col = mix(col, srgb(vec3(0.85)), max(zebra, stop) * fadeM * 0.9);
  col = mix(col, mix(asphalt, inner, 0.8), smoothstep(0.3, 0.7, aa));
  col *= 1.0 - 0.55 * uNight;
  gl_FragColor = vec4(col, 1.0);
  #include <fog_fragment>
}
`;

interface CityGrid extends StreetGrid {
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
export const WALL_MED = [0xe0cfa8, 0xd8b98a, 0xcfa77a, 0xe6dcc0, 0xc79a6c, 0xd9c7a3, 0xe9e2d0, 0xf0ebdc, 0xf4f0e4, 0xeee4cc, 0xe8d2a8, 0xf2e8d0];
export const WALL_NORDIC = [0xa14a3a, 0xd9b25a, 0xe8e4d8, 0x7d95a3, 0xb8573f, 0xc9c0a0];
export const WALL_PLATTE = [0xd0ccbf, 0xc4c2b6, 0xb8b7ae, 0xd8d0b8, 0xc4d2c0, 0xdccbb4, 0xbac4c8];
export const WALL_MODERN = [0xc0ccd4, 0xb0bec8, 0xa4b6c0, 0xcdd6d8, 0xb4bec6];
export const WALL_IND = [0xb0b2ae, 0x9aa4b0, 0xbfb29a, 0x93a39a, 0xc4c0b4];
export const ROOF_WEST = [0xb8644a, 0xa65a42, 0xc06c50, 0x8a6048, 0x7a5a48, 0x6e727c, 0x5c6068, 0x7c7f86];
export const ROOF_MED = [0xc8683f, 0xbc5e3a, 0xd47a50, 0xc9754f, 0xb85a38, 0xd88a5e];
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
  private readonly street: StreetLife;
  private readonly fires = new BuildingFires(60);
  private readonly scorch: DecalSet;
  private readonly scorchSlot = new Map<number, number>();
  private lastT = 0;

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

    // Straßenleben (Laternen, Bäume, Autos, Zäune, Dekale)
    this.street = new StreetLife(geo, grids);
    this.scorch = new DecalSet(geo, 768);

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
    group.add(this.floorGroup, this.layer.group, this.street.object, this.scorch.mesh, this.fires.object, this.markers);
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
    let style = 0; // 0 West (VAL: alpin/mitteleuropäisch), 1 Ost (KRN: Plattenbau), 2 Mittelmeer (MAR), 3 Nordisch
    if (country === 'VAL') style = 0;
    else if (country === 'KRN') style = 1;
    else if (country === 'MAR') style = 2;
    else if (country === 'PAN') style = 1; // Pannonien: Plattenbau-/Ost-Stil mit warmen Dächern
    else if (EAST.has(country) || (country === 'DEU' && lon > 11.2 && lat > 50.4)) style = 1;
    else if (MED.has(country) || lat < 43.2) style = 2;
    else if (NORDIC.has(country) || lat > 58) style = 3;
    let styleBits = 0;
    const timberP = country === 'VAL' ? 0.32 : style === 0 ? 0.12 : 0;
    const wallOld = style === 2 ? WALL_MED : style === 3 ? WALL_NORDIC : WALL_WEST;
    const roofOld = style === 2 || country === 'PAN' ? ROOF_MED : style === 3 ? ROOF_NORDIC : ROOF_WEST;
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
      const sb = type === BT.OLD || type === BT.VILLA ? styleBits : 0;
      this.add(cx + a * ca + b * sa, cz - a * sa + b * ca, w, h, d, theta + rotLocal + rj, type, wall, ((roof | (sb << STYLE_SHIFT)) >>> 0));
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
      styleBits = timberP > 0 && rnd() < timberP ? 1 : 0;
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
    return { name, cx, cz, theta, M, S, kinds, style };
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
    this.street.setExag(e);
    this.fires.setExag(e);
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
    this.street.object.visible = near;
    this.scorch.mesh.visible = near;
    this.markers.visible = !near && h < MARKER_MAX_DISTANCE;
    const nowS = performance.now() / 1000;
    const dt = this.lastT > 0 ? Math.min(0.1, nowS - this.lastT) : 0;
    this.lastT = nowS;
    this.mat.uniforms.uTime.value = nowS % 4096;
    if (near) {
      this.street.update(camera);
      setDecalParams(this.exag, h);
      setPropParams(this.exag, h);
      this.fires.update(dt, camera, nowS % 4096);
      this.layer.update(camera.position, true);
      // fester Gebäudemaßstab (SCALE.buildings) und konstante Fensterdichte – kein Wachsen mit der Kamerahöhe
      this.mat.uniforms.uVis.value = SCALE.buildings;
      this.mat.uniforms.uWinScale.value = 1;
      this.lift.value = THREE.MathUtils.clamp(0.012 + h * 0.0035, 0.012, 8);
    } else {
      this.fires.object.visible = false;
    }
  }

  /** Brandstatistik / Streetlife-Statistik (Tests) */
  stats(): { burning: number; street: { lamps: number; trees: number; cars: number; other: number; decals: number; total: number } } {
    return { burning: this.fires.count, street: this.street.stats };
  }

  /** Brand und Brandfleck zu Gebäude id aktualisieren (nach Integritätsänderung) */
  private updateHazards(id: number, burnFresh: boolean): void {
    const g = this.integrity[id];
    const o = id * STRIDE, d = this.data;
    if (g < BUILDING_DAMAGED_BELOW) {
      const r = Math.max(d[o + 2], d[o + 4]) * 0.5;
      if (burnFresh || this.fires.isBurning(id)) {
        const dur = 60 + 60 * Math.abs(Math.sin(id * 78.233) * 43758.5453 % 1);
        if (burnFresh) this.fires.ignite(id, d[o], d[o + 1], d[o + 6], d[o + 3] * (g <= 0 ? 0.3 : 0.7), r, dur);
      }
    } else this.fires.extinguish(id);
    if (g <= 0) {
      if (!this.scorchSlot.has(id)) {
        const sz = Math.max(0.045, Math.max(d[o + 2], d[o + 4]) * 1.9);
        this.scorchSlot.set(id, this.scorch.add(DECAL.SCORCH, d[o], d[o + 1], sz, sz * 0.9, d[o + 5], (id % 97) / 97));
      }
    } else {
      const sl = this.scorchSlot.get(id);
      if (sl !== undefined) { this.scorch.remove(sl); this.scorchSlot.delete(id); }
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
    this.updateHazards(id, after < BUILDING_DAMAGED_BELOW);
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
    this.updateHazards(id, this.integrity[id] < BUILDING_DAMAGED_BELOW);
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
