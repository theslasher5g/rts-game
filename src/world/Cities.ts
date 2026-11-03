import * as THREE from 'three';
import type { GeoData } from './GeoData';
import type { Settings } from '../core/types';

/** Ab dieser Kamerahöhe (km) werden Gebäude ausgeblendet und nur Marker gezeigt */
const HIDE_DISTANCE = 2500;
/** Ab dieser Kamerahöhe werden auch die Marker ausgeblendet */
const MARKER_MAX_DISTANCE = 9000;

const CONCRETE = [0x8a8780, 0x7d7a73, 0x96928a, 0x6f6d68, 0x9c958a, 0x84807a, 0x7a7466, 0xa39d92];
const ROOFS_RED = [0x7e5a4a, 0x8a6250, 0x6e5246];
const TOWER = [0x6c7680, 0x5f6a72, 0x7d868c];

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

/**
 * Low-Poly-Gebäudecluster für alle Städte (ein InstancedMesh aus Boxen) + Punktmarker für die Fernansicht.
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
  private exag = -1;
  private show = true;

  constructor(geo: GeoData, settings: Settings) {
    this.geo = geo;
    const list: number[] = [];
    for (const city of geo.meta.cities) this.generateCity(city.name, city.pos[0], city.pos[1], city.pop, city.capital, list);
    const STRIDE = 8;
    this.count = list.length / STRIDE;
    this.data = new Float32Array(list);

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

  private placeAll(): void {
    const STRIDE = 8;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const e = this.exag;
    for (let i = 0; i < this.count; i++) {
      const o = i * STRIDE;
      const d = this.data;
      // Gebäude leicht versenkt; Höhe moderat mit Überhöhung skaliert (lesbare Silhouetten)
      const hScale = 1 + (e - 1) * 0.25;
      p.set(d[o], d[o + 6] * e - 0.08, d[o + 1]);
      s.set(d[o + 2], d[o + 3] * hScale + 0.08, d[o + 4]);
      q.setFromAxisAngle(up, d[o + 5]);
      m.compose(p, q, s);
      this.buildings.setMatrixAt(i, m);
    }
    this.buildings.instanceMatrix.needsUpdate = true;
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
}
