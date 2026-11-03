/**
 * Phase 3 – Brücken: Low-Poly-Fahrbahnplatten mit Geländern und Pfeilern für alle NavEdges mit bridge === true,
 * lazy je 40-km-Kachel als InstancedMesh gebaut (nur nahe der Kamera, Kamerahöhe < 400 km).
 * Zerstörte Brücken (edge.open === false, Bus 'nav:edge' / 'bridge:destroyed'): Lücke in der Mitte, abgeknickte
 * Fahrbahnstücke, verbogene Geländer, Trümmer im Wasser.
 *
 * Maßstab: Breite/Dicke wachsen mit dem Kameraabstand (in Stufen ×2, Neuaufbau max. 3 Kacheln/Frame), damit die
 * Brücke breiter als das RoadRenderer-Band wirkt (dessen Mindestbreite 0,18 km ist) und über dessen Abstandsaufschlag
 * (0,0035 × Kameraabstand) liegt – kein Z-Fighting.
 */
import * as THREE from 'three';
import { bus } from '../core/EventBus';
import type { Settings } from '../core/types';
import type { NavGraph } from '../nav/NavGraph';
import type { GeoData } from '../world/GeoData';

const CHUNK_KM = 40;
const MAX_DIST = 400;
const BASE_DIST = 15;
const REBUILDS_PER_FRAME = 3;
const MAX_BUILT = 70;

const C_DECK = 0x9d998f;
const C_DECK_RAIL = 0xa8a395;
const C_RAIL = 0x6c6a64;
const C_PIER = 0x7d7a73;
const C_BROKEN = 0x4a4540;
const C_RUBBLE = [0x55514b, 0x403c37, 0x6a645b, 0x5a4a40];
const C_RUST = 0x6b4a36;

interface Chunk {
  key: number;
  edges: number[];
  mesh: THREE.InstancedMesh | null;
  bucket: number;
  exag: number;
  dirty: boolean;
  lastUsed: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _cam = new THREE.Vector3();
const _dir = new THREE.Vector3();

function rngFrom(seed: number): () => number {
  let a = (seed * 2654435761 + 12345) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class BridgeRenderer {
  readonly object = new THREE.Group();
  private readonly geo: GeoData;
  private readonly graph: NavGraph;
  private exag: number;
  private readonly chunks = new Map<number, Chunk>();
  private readonly chunkOfEdge = new Map<number, number>();
  private readonly box = new THREE.BoxGeometry(1, 1, 1);
  private readonly mat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
  private frame = 0;
  private show = true;
  private readonly candidates: Chunk[] = [];

  constructor(geo: GeoData, graph: NavGraph, settings: Settings) {
    this.geo = geo;
    this.graph = graph;
    this.exag = settings.heightExaggeration;
    this.object.name = 'Bridges';
    // Kacheln der Brücken-Kanten
    for (const e of graph.edges) {
      if (!e.bridge || e.cls === 'ferry') continue;
      const g = e.geom;
      const key = this.keyOf(g[g.length / 2 & ~1] ?? g[0], g[(g.length / 2 & ~1) + 1] ?? g[1]);
      let c = this.chunks.get(key);
      if (!c) this.chunks.set(key, (c = { key, edges: [], mesh: null, bucket: -1, exag: 0, dirty: true, lastUsed: 0 }));
      c.edges.push(e.id);
      this.chunkOfEdge.set(e.id, key);
    }
    const mark = (edgeId: number) => {
      const k = this.chunkOfEdge.get(edgeId);
      if (k === undefined) return;
      const c = this.chunks.get(k);
      if (c) c.dirty = true;
    };
    bus.on('nav:edge', ({ edgeId }) => mark(edgeId));
    bus.on('bridge:destroyed', ({ edgeId }) => mark(edgeId));
    bus.on('bridge:repaired', ({ edgeId }) => mark(edgeId));
  }

  /** Anzahl Brücken im Netz (Debug) */
  get bridgeCount(): number {
    return this.chunkOfEdge.size;
  }

  private keyOf(x: number, z: number): number {
    return Math.floor(x / CHUNK_KM) * 1024 + Math.floor(z / CHUNK_KM);
  }

  applySettings(s: Settings): void {
    this.exag = s.heightExaggeration;
  }

  update(camera: THREE.PerspectiveCamera): void {
    this.frame++;
    camera.updateMatrixWorld();
    _cam.setFromMatrixPosition(camera.matrixWorld);
    camera.getWorldDirection(_dir);
    const gy = Math.max(0, this.geo.heightAt(_cam.x, _cam.z)) * this.exag;
    const dist = _dir.y < -0.05 ? Math.max(0.5, (_cam.y - gy * 0.5) / -_dir.y) : Math.max(0.5, _cam.y);
    this.show = dist < MAX_DIST;
    this.object.visible = this.show;
    if (!this.show) return;
    // Ziel am Boden
    let tx = _cam.x, tz = _cam.z;
    if (_dir.y < -0.05) {
      const t = (_cam.y - gy * 0.5) / -_dir.y;
      tx = _cam.x + _dir.x * t;
      tz = _cam.z + _dir.z * t;
    }
    const b = Math.max(0, Math.round(Math.log2(Math.max(BASE_DIST, dist) / BASE_DIST)));
    const R = Math.min(300, Math.max(30, dist * 1.4));
    const k0x = Math.floor((tx - R) / CHUNK_KM), k1x = Math.floor((tx + R) / CHUNK_KM);
    const k0z = Math.floor((tz - R) / CHUNK_KM), k1z = Math.floor((tz + R) / CHUNK_KM);
    this.candidates.length = 0;
    const visible = new Set<number>();
    for (let kx = k0x; kx <= k1x; kx++)
      for (let kz = k0z; kz <= k1z; kz++) {
        const c = this.chunks.get(kx * 1024 + kz);
        if (!c) continue;
        visible.add(c.key);
        c.lastUsed = this.frame;
        if (!c.mesh || c.dirty || c.bucket !== b || c.exag !== this.exag) this.candidates.push(c);
      }
    // nächste zuerst (Zentrum der Kachel zum Ziel)
    this.candidates.sort((a, c) => this.chunkDist(a, tx, tz) - this.chunkDist(c, tx, tz));
    let built = 0;
    for (const c of this.candidates) {
      if (built >= REBUILDS_PER_FRAME) break;
      this.build(c, b);
      built++;
    }
    for (const c of this.chunks.values()) if (c.mesh) c.mesh.visible = visible.has(c.key);
    // LRU-Freigabe
    let count = 0;
    for (const c of this.chunks.values()) if (c.mesh) count++;
    if (count > MAX_BUILT) {
      const old = Array.from(this.chunks.values()).filter((c) => c.mesh && !visible.has(c.key)).sort((a, c) => a.lastUsed - c.lastUsed);
      for (const c of old) {
        if (count <= MAX_BUILT) break;
        this.release(c);
        count--;
      }
    }
  }

  private chunkDist(c: Chunk, x: number, z: number): number {
    const cx = (Math.floor(c.key / 1024) + 0.5) * CHUNK_KM, cz = ((c.key % 1024) + 0.5) * CHUNK_KM;
    return Math.hypot(cx - x, cz - z);
  }

  private release(c: Chunk): void {
    if (c.mesh) {
      this.object.remove(c.mesh);
      c.mesh.dispose();
      c.mesh = null;
      c.bucket = -1;
    }
  }

  private groundY(x: number, z: number): number {
    return Math.max(0, this.geo.heightAt(x, z)) * this.exag;
  }

  // ------------------------------------------------------------------ Aufbau

  private build(c: Chunk, bucket: number): void {
    const d = BASE_DIST * Math.pow(2, bucket);
    const W0 = Math.max(0.2, 0.0034 * d);
    const e = this.exag;
    // Instanzen sammeln: [x,y,z, yaw,pitch, L,H,W, color]
    const data: number[] = [];
    const add = (x: number, y: number, z: number, yaw: number, pitch: number, L: number, H: number, W: number, color: number, roll = 0) => {
      data.push(x, y, z, yaw, pitch, L, H, W, color, roll);
    };
    for (const eid of c.edges) {
      const ed = this.graph.edges[eid];
      const broken = !ed.open;
      const g = ed.geom;
      const Lk = ed.lengthKm;
      if (Lk <= 0) continue;
      const W = ed.cls === 'rail' ? W0 * 0.6 : ed.cls === 'motorway' ? W0 * 1.05 : ed.cls === 'track' ? W0 * 0.65 : W0;
      const thick = Math.max(0.03, W * 0.14);
      const railH = Math.max(0.025, W * 0.12);
      const railW = Math.max(0.02, W * 0.06);
      const lift = Math.max(W * 0.35, 0.0046 * d) + thick * 0.5;
      // Polylinie mit Kumulativlängen
      const n = g.length / 2;
      const cum = new Float32Array(n);
      for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(g[i * 2] - g[i * 2 - 2], g[i * 2 + 1] - g[i * 2 - 1]);
      const total = cum[n - 1] || Lk;
      const yA = this.groundY(g[0], g[1]), yB = this.groundY(g[g.length - 2], g[g.length - 1]);
      const at = (s: number, out: { x: number; z: number; dx: number; dz: number }) => {
        s = Math.max(0, Math.min(total, s));
        let i = 1;
        while (i < n - 1 && cum[i] < s) i++;
        const l = cum[i] - cum[i - 1] || 1e-6;
        const f = (s - cum[i - 1]) / l;
        out.x = g[i * 2 - 2] + (g[i * 2] - g[i * 2 - 2]) * f;
        out.z = g[i * 2 - 1] + (g[i * 2 + 1] - g[i * 2 - 1]) * f;
        out.dx = (g[i * 2] - g[i * 2 - 2]) / l;
        out.dz = (g[i * 2 + 1] - g[i * 2 - 1]) / l;
      };
      const deckY = (s: number, x: number, z: number) => Math.max(yA + (yB - yA) * (s / total), this.groundY(x, z) + lift * 0.6) + lift;
      const tmpA = { x: 0, z: 0, dx: 0, dz: 0 }, tmpB = { x: 0, z: 0, dx: 0, dz: 0 };
      const stepMax = Math.max(0.12, W * 1.6);
      const span = (s0: number, s1: number, tilt: number) => {
        // Segmente zwischen s0..s1
        const len = s1 - s0;
        if (len <= 1e-5) return;
        const k = Math.max(1, Math.ceil(len / stepMax));
        for (let q = 0; q < k; q++) {
          const a = s0 + (len * q) / k, b = s0 + (len * (q + 1)) / k;
          at(a, tmpA); at(b, tmpB);
          const ya = deckY(a, tmpA.x, tmpA.z), yb = deckY(b, tmpB.x, tmpB.z);
          const dx = tmpB.x - tmpA.x, dz = tmpB.z - tmpA.z;
          const hl = Math.hypot(dx, dz) || 1e-6;
          const yaw = Math.atan2(-dz, dx), pitch = Math.atan2(yb - ya, hl);
          const mx = (tmpA.x + tmpB.x) / 2, mz = (tmpA.z + tmpB.z) / 2, my = (ya + yb) / 2;
          const sl = Math.hypot(hl, yb - ya) * 1.03;
          const nx = -dz / hl, nz = dx / hl; // Normale (x,z)
          add(mx, my, mz, yaw, pitch + tilt, sl, thick, W, q % 2 ? C_DECK : C_DECK_RAIL);
          if (!broken || true) {
            for (const sd of [-1, 1]) add(mx + nx * sd * (W / 2 - railW / 2), my + thick / 2 + railH / 2, mz + nz * sd * (W / 2 - railW / 2), yaw, pitch + tilt, sl, railH, railW, C_RAIL);
          }
        }
      };
      const piers = (s0: number, s1: number) => {
        if (Lk < 0.45) return;
        const gapS = Math.max(0.35, W * 2.6);
        const cnt = Math.floor((s1 - s0) / gapS);
        for (let q = 1; q <= cnt; q++) {
          const s = s0 + q * gapS;
          if (s > s1 - gapS * 0.4) break;
          at(s, tmpA);
          const top = deckY(s, tmpA.x, tmpA.z) - thick / 2;
          const base = this.groundY(tmpA.x, tmpA.z) - 0.02;
          const h = top - base;
          if (h < W * 0.25) continue;
          add(tmpA.x, base + h / 2, tmpA.z, Math.atan2(-tmpA.dz, tmpA.dx), 0, W * 0.2, h, W * 0.55, C_PIER);
        }
      };
      // Widerlager (Rampen) an beiden Enden: kurze Keile bis zum Boden
      const abut = (s: number) => {
        at(s, tmpA);
        const top = deckY(s, tmpA.x, tmpA.z) - thick / 2;
        const base = this.groundY(tmpA.x, tmpA.z) - 0.02;
        const h = top - base;
        if (h > W * 0.15) add(tmpA.x, base + h / 2, tmpA.z, Math.atan2(-tmpA.dz, tmpA.dx), 0, W * 0.45, h, W * 0.9, C_PIER);
      };
      if (!broken) {
        span(0, total, 0);
        piers(0, total);
        abut(Math.min(total * 0.02, W * 0.3)); abut(total - Math.min(total * 0.02, W * 0.3));
      } else {
        const rnd = rngFrom(eid + 1);
        const gap0 = total * 0.3, gap1 = total * 0.7;
        span(0, gap0, 0);
        span(gap1, total, 0);
        piers(0, gap0); piers(gap1, total);
        abut(Math.min(total * 0.02, W * 0.3)); abut(total - Math.min(total * 0.02, W * 0.3));
        // hängende Fragmente an den Bruchkanten
        for (const [s, dirSign] of [[gap0, 1], [gap1, -1]] as Array<[number, number]>) {
          at(s, tmpA);
          const y = deckY(s, tmpA.x, tmpA.z);
          const fl = Math.min(total * 0.15, W * 2.4) * (0.7 + rnd() * 0.6);
          const hl = fl / 2;
          const yaw = Math.atan2(-tmpA.dz, tmpA.dx);
          const ang = -(0.55 + rnd() * 0.45) * dirSign * -1; // nach unten abgeknickt
          // Platte, am Rand aufgehängt: Mittelpunkt in Richtung der Lücke, nach unten verschoben
          const mx = tmpA.x + tmpA.dx * dirSign * hl * Math.cos(ang), mz = tmpA.z + tmpA.dz * dirSign * hl * Math.cos(ang);
          const my = y - Math.abs(Math.sin(ang)) * hl;
          add(mx, my, mz, yaw, dirSign > 0 ? -Math.abs(ang) : Math.abs(ang), fl, thick, W * 0.96, C_BROKEN, (rnd() - 0.5) * 0.25);
          add(mx, my + thick, mz, yaw, dirSign > 0 ? -Math.abs(ang) : Math.abs(ang), fl * 0.9, railH, railW, C_RUST, (rnd() - 0.5) * 0.4);
          // Bewehrung/verbogene Geländer
          for (let r = 0; r < 2; r++) {
            const ox = (rnd() - 0.5) * W * 0.7;
            const nx = -tmpA.dz, nz = tmpA.dx;
            add(tmpA.x + nx * ox + tmpA.dx * dirSign * fl * 0.5, y - fl * 0.5 * (0.3 + rnd() * 0.5), tmpA.z + nz * ox + tmpA.dz * dirSign * fl * 0.5, yaw + (rnd() - 0.5) * 0.8, -dirSign * (0.8 + rnd() * 0.6), fl * 0.8, railW, railW, C_RUST, (rnd() - 0.5) * 0.8);
          }
        }
        // Trümmer im Wasser / am Grund der Lücke
        const cnt = 12 + Math.floor(rnd() * 6);
        for (let q = 0; q < cnt; q++) {
          const s = gap0 + (gap1 - gap0) * rnd();
          at(s, tmpA);
          const o = (rnd() - 0.5) * W * 1.6;
          const x = tmpA.x - tmpA.dz * o, z = tmpA.z + tmpA.dx * o;
          const sz = W * (0.35 + rnd() * 0.5);
          const by = this.groundY(x, z);
          add(x, by + sz * 0.25, z, rnd() * 6.28, (rnd() - 0.5) * 0.6, sz * (0.8 + rnd()), sz * (0.4 + rnd() * 0.5), sz * (0.6 + rnd() * 0.6), C_RUBBLE[Math.floor(rnd() * C_RUBBLE.length)], (rnd() - 0.5) * 0.9);
        }
      }
    }
    // Mesh bauen
    this.release(c);
    const count = data.length / 10;
    const mesh = new THREE.InstancedMesh(this.box, this.mat, Math.max(1, count));
    mesh.name = `Bridges-${c.key}`;
    mesh.frustumCulled = false;
    mesh.count = count;
    for (let i = 0; i < count; i++) {
      const o = i * 10;
      _e.set(0, data[o + 3], data[o + 4], 'YXZ');
      // roll um lokale X-Achse nach Yaw/Pitch: einfach als Rx (YXZ) anwenden
      _e.x = data[o + 9];
      _q.setFromEuler(_e);
      _p.set(data[o], data[o + 1], data[o + 2]);
      _s.set(data[o + 5], data[o + 6], data[o + 7]);
      _m.compose(_p, _q, _s);
      mesh.setMatrixAt(i, _m);
      _c.setHex(data[o + 8]);
      mesh.setColorAt(i, _c);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.renderOrder = 4;
    this.object.add(mesh);
    c.mesh = mesh;
    c.bucket = bucket;
    c.exag = e;
    c.dirty = false;
  }
}
