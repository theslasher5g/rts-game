import * as THREE from 'three';
import type { GeoData } from './GeoData';
import type { Settings } from '../core/types';
import { bus } from '../core/EventBus';
import type { BuildingInfo } from '../combat/types';

/** Ab dieser Kamerahöhe (km) werden Gebäude ausgeblendet und nur Marker gezeigt */
const HIDE_DISTANCE = 2500;
/** Ab dieser Kamerahöhe werden auch die Marker ausgeblendet */
const MARKER_MAX_DISTANCE = 9000;

const CONCRETE = [0x8a8780, 0x7d7a73, 0x96928a, 0x6f6d68, 0x9c958a, 0x84807a, 0x7a7466, 0xa39d92];
const ROOFS_RED = [0x7e5a4a, 0x8a6250, 0x6e5246];
const TOWER = [0x6c7680, 0x5f6a72, 0x7d868c];

/** Daten-Stride je Gebäude (x, z, w, h, d, rot, base, color) */
const STRIDE = 8;
/** Raum-Hash-Zellgröße (km) */
const HASH_CELL = 1;
/** Ab dieser Integrität gilt ein Gebäude als beschädigt (dunkler/schief) */
export const BUILDING_DAMAGED_BELOW = 0.35;
/** Trümmerhöhe relativ zur Originalhöhe und absolutes Minimum (km) */
const RUBBLE_FRAC = 0.12;
const RUBBLE_MIN_H = 0.008;
const RUBBLE_COLOR = 0x3f3b36;

/** Deterministischer RNG (mulberry32) */
function rngFrom(name: string): () => number {
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

const _axis = new THREE.Vector3();

/**
 * Low-Poly-Gebäudecluster für alle Städte (ein InstancedMesh aus Boxen) + Punktmarker für die Fernansicht.
 *
 * Phase 3: Jedes Gebäude hat eine stabile ID (Index in der deterministisch erzeugten Liste), ein Register
 * (getBuilding/findBuildingAt/buildingsInRadius), Sichtlinientest (raycastBlocked), Schaden/Trümmer
 * (damageBuilding) und Besatzungszähler (setGarrison).
 */
export class Cities {
  readonly object: THREE.Object3D;
  private readonly geo: GeoData;
  private readonly buildings: THREE.InstancedMesh;
  private readonly markers: THREE.Points;
  /** Pro Gebäude: x, z, Breite, Höhe, Tiefe, Rotation, Sockelhöhe(km, ohne Überhöhung) */
  private readonly data: Float32Array;
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

  constructor(geo: GeoData, settings: Settings) {
    this.geo = geo;
    const list: number[] = [];
    const ownerList: number[] = [];
    geo.meta.cities.forEach((city, ci) => {
      const before = list.length;
      this.generateCity(city.name, city.pos[0], city.pos[1], city.pop, city.capital, list);
      for (let k = before; k < list.length; k += STRIDE) ownerList.push(ci);
    });
    this.count = list.length / STRIDE;
    this.data = new Float32Array(list);
    this.ownerCity = Uint16Array.from(ownerList);
    this.integrity = new Float32Array(this.count).fill(1);
    this.garrison = new Uint16Array(this.count);
    this.capacity = new Uint8Array(this.count);
    this.stamp = new Uint32Array(this.count);
    this.infos = new Array(this.count);
    this.buildRegistry();

    const box = new THREE.BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0);
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
    this.buildings = new THREE.InstancedMesh(box, mat, Math.max(1, this.count));
    this.buildings.name = 'CityBuildings';
    this.buildings.count = this.count;
    const c = new THREE.Color();
    for (let i = 0; i < this.count; i++) {
      c.setHex(this.data[i * STRIDE + 7]);
      this.buildings.setColorAt(i, c);
    }
    if (this.buildings.instanceColor) this.buildings.instanceColor.needsUpdate = true;

    // Marker
    const cities = geo.meta.cities;
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
    group.add(this.buildings, this.markers);
    this.object = group;
    this.applySettings(settings);
  }

  private generateCity(name: string, cx: number, cz: number, pop: number, capital: boolean, out: number[]): void {
    const rnd = rngFrom(name);
    const popM = Math.max(0.02, pop / 1e6);
    const radius = Math.min(15, 1.5 + Math.sqrt(popM) * 3.2 + (capital ? 0.6 : 0));
    let n = Math.round(16 + Math.sqrt(popM) * 110 + (capital ? 20 : 0));
    n = Math.min(n, 480);
    const towers = popM > 1.5 ? Math.round(Math.min(18, popM * 1.6)) : capital ? 2 : 0;
    const geo = this.geo;
    for (let b = 0; b < n; b++) {
      let x = 0, z = 0, ok = false;
      const isTower = b < towers;
      for (let tries = 0; tries < 6 && !ok; tries++) {
        // Dichte nimmt nach außen ab; Hochhäuser im Kern
        const r = radius * (isTower ? 0.28 : 1) * Math.pow(rnd(), 1.7);
        const a = rnd() * Math.PI * 2;
        x = cx + Math.cos(a) * r;
        z = cz + Math.sin(a) * r;
        ok = geo.countryAt(x, z) !== 0 && geo.heightAt(x, z) > 0.001 && !this.isWater(x, z);
      }
      if (!ok) continue;
      const distF = Math.hypot(x - cx, z - cz) / radius; // 0 Kern .. 1 Rand
      let w: number, d: number, h: number, color: number;
      if (isTower) {
        w = 0.14 + rnd() * 0.1;
        d = w * (0.8 + rnd() * 0.4);
        h = 0.35 + rnd() * 0.45 * Math.min(2, Math.sqrt(popM) / 2);
        color = TOWER[Math.floor(rnd() * TOWER.length)];
      } else {
        w = 0.18 + rnd() * 0.42 * (1 - distF * 0.4);
        d = 0.18 + rnd() * 0.42 * (1 - distF * 0.4);
        h = (0.04 + rnd() * 0.12) * (1.6 - distF) + (rnd() < 0.08 ? 0.12 : 0);
        color = distF > 0.55 && rnd() < 0.5 ? ROOFS_RED[Math.floor(rnd() * ROOFS_RED.length)] : CONCRETE[Math.floor(rnd() * CONCRETE.length)];
      }
      // Sockel: tiefster Punkt der Grundfläche, damit nichts schwebt
      const hw = Math.max(w, d) * 0.6;
      const base = Math.min(geo.heightAt(x - hw, z - hw), geo.heightAt(x + hw, z - hw), geo.heightAt(x - hw, z + hw), geo.heightAt(x + hw, z + hw), geo.heightAt(x, z));
      out.push(x, z, w, h, d, rnd() * Math.PI * 0.5, base, color);
    }
  }

  private isWater(x: number, z: number): boolean {
    const g = this.geo;
    const i = Math.floor(x / g.cellKm), j = Math.floor(z / g.cellKm);
    if (i < 0 || j < 0 || i >= g.width || j >= g.height) return true;
    return g.waterFlags[j * g.width + i] !== 0;
  }

  private static readonly _m = new THREE.Matrix4();
  private static readonly _q = new THREE.Quaternion();
  private static readonly _q2 = new THREE.Quaternion();
  private static readonly _p = new THREE.Vector3();
  private static readonly _s = new THREE.Vector3();
  private static readonly _up = new THREE.Vector3(0, 1, 0);
  private static readonly _col = new THREE.Color();

  /** Matrix + Farbe einer Instanz nach Zustand (intakt / beschädigt / Trümmer) setzen */
  private placeOne(i: number): void {
    const { _m: m, _q: q, _q2: q2, _p: p, _s: s, _up: up, _col: c } = Cities;
    const e = this.exag;
    const o = i * STRIDE;
    const d = this.data;
    const integ = this.integrity[i];
    // Gebäude leicht versenkt; Höhe moderat mit Überhöhung skaliert (lesbare Silhouetten)
    const hScale = 1 + (e - 1) * 0.25;
    let sx = d[o + 2], sy = d[o + 3] * hScale + 0.08, sz = d[o + 4];
    q.setFromAxisAngle(up, d[o + 5]);
    c.setHex(d[o + 7]);
    if (integ <= 0) {
      sy = RUBBLE_MIN_H + d[o + 3] * RUBBLE_FRAC * 0.5 + 0.08;
      sx *= 1.12; sz *= 1.12;
      c.setHex(RUBBLE_COLOR);
      // leicht unregelmäßig
      q2.setFromAxisAngle(_axis.set(Math.cos(i * 2.1), 0, Math.sin(i * 2.1)), 0.09);
      q.multiply(q2);
    } else if (integ < BUILDING_DAMAGED_BELOW) {
      const k = 1 - integ / BUILDING_DAMAGED_BELOW; // 0..1
      sy = (d[o + 3] * (1 - 0.3 * k)) * hScale + 0.08;
      c.multiplyScalar(0.62 - 0.22 * k);
      q2.setFromAxisAngle(_axis.set(Math.cos(i * 1.7), 0, Math.sin(i * 1.7)), 0.05 + 0.12 * k);
      q.multiply(q2);
    }
    p.set(d[o], d[o + 6] * e - 0.08, d[o + 1]);
    s.set(sx, sy, sz);
    m.compose(p, q, s);
    this.buildings.setMatrixAt(i, m);
    this.buildings.setColorAt(i, c);
  }

  private placeAll(): void {
    const e = this.exag;
    for (let i = 0; i < this.count; i++) this.placeOne(i);
    this.buildings.instanceMatrix.needsUpdate = true;
    if (this.buildings.instanceColor) this.buildings.instanceColor.needsUpdate = true;
    this.dirty.clear();
    this.buildings.computeBoundingSphere();
    this.buildings.computeBoundingBox();
    const cities = this.geo.meta.cities;
    for (let i = 0; i < cities.length; i++) {
      this.cityPos[i * 3 + 1] = Math.max(0, this.geo.heightAt(cities[i].pos[0], cities[i].pos[1])) * e + 1.5;
    }
    const attr = this.markers.geometry.getAttribute('position') as THREE.BufferAttribute;
    attr.needsUpdate = true;
    this.markers.geometry.computeBoundingSphere();
  }

  update(camera: THREE.PerspectiveCamera): void {
    this.flushDirty();
    if (!this.show) return;
    const h = camera.position.y;
    const near = h < HIDE_DISTANCE;
    this.buildings.visible = near;
    this.markers.visible = !near && h < MARKER_MAX_DISTANCE;
  }

  applySettings(s: Settings): void {
    this.show = s.showCities;
    this.object.visible = s.showCities;
    if (s.heightExaggeration !== this.exag) {
      this.exag = s.heightExaggeration;
      this.placeAll();
    }
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
    for (const i of this.dirty) this.placeOne(i);
    this.dirty.clear();
    this.buildings.instanceMatrix.needsUpdate = true;
    if (this.buildings.instanceColor) this.buildings.instanceColor.needsUpdate = true;
  }
}
