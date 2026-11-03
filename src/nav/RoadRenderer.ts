import * as THREE from 'three';
import { bus } from '../core/EventBus';
import type { Settings } from '../core/types';
import type { GeoData } from '../world/GeoData';
import type { NavGraph } from './NavGraph';
import { ROAD_CLASSES } from './types';

/**
 * Straßen-/Schienen-/Fährnetz als aufs Gelände gelegte Bänder (ein Mesh je Klasse + Brücken).
 *
 * - Eigener ShaderMaterial (mit logdepthbuf-/fog-Chunks): Bandbreite wächst mit dem Kamera-
 *   abstand (konstante Pixelbreite, mit Mindestbreite in km), Höhe = Gelände (CPU-gesampelt, in km,
 *   Überhöhung per Uniform) + Abstandsaufschlag gegen Verschlucken durch das LOD-Gelände.
 * - Sichtbarkeit je Klasse nach Kamerahöhe; Meshes werden erst beim ersten Sichtbarwerden gebaut.
 * - Gesperrte Kanten (setEdgeState / Bus 'nav:edge'): rot gestrichelt (Attribut aClosed).
 */

const DENSIFY_KM = 2.5;

interface ClassStyle {
  color: number;
  /** Breite in internen Pixeln */
  px: number;
  minKm: number;
  /** Sichtbar bis Kamerahöhe (km) */
  maxY: number;
  lift: number;
  dash?: number;
}

const STYLES: Record<string, ClassStyle> = {
  motorway: { color: 0xe6b84a, px: 2.0, minKm: 0.16, maxY: 1e9, lift: 0.0 },
  primary: { color: 0xd8d2b4, px: 1.6, minKm: 0.12, maxY: 2600, lift: 0.0 },
  secondary: { color: 0xc4bfa6, px: 1.3, minKm: 0.09, maxY: 1100, lift: 0.0 },
  road: { color: 0xa9a58f, px: 1.1, minKm: 0.07, maxY: 420, lift: 0.0 },
  track: { color: 0x8a7f66, px: 1.0, minKm: 0.05, maxY: 180, lift: 0.0, dash: 0.6 },
  rail: { color: 0x2c2a2a, px: 1.3, minKm: 0.08, maxY: 1400, lift: 0.002, dash: 0.5 },
  ferry: { color: 0x9fd0e8, px: 1.4, minKm: 0.12, maxY: 3000, lift: 0.0, dash: 5 },
  bridge: { color: 0xf0e2b0, px: 2.2, minKm: 0.18, maxY: 1100, lift: 0.004 },
};

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
#include <fog_pars_vertex>
attribute vec3 aSide;   // perp.x, perp.z, side
attribute vec2 aInfo;   // km entlang, gesperrt
uniform float uExag;
uniform float uPx;
uniform float uMinKm;
uniform float uLift;
uniform float uDistLift;
varying float vDist;
varying float vClosed;
varying float vSide;
void main() {
  vec3 p = position;                       // x, Höhe(km), z
  vec4 mv0 = viewMatrix * vec4(p.x, p.y * uExag, p.z, 1.0);
  float d = max(1.0, length(mv0.xyz));
  float w = max(uMinKm, uPx * d * 0.00133);
  vec3 wp = vec3(p.x + aSide.x * aSide.z * w * 0.5, p.y * uExag + uLift + d * uDistLift, p.z + aSide.y * aSide.z * w * 0.5);
  vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  vDist = aInfo.x;
  vClosed = aInfo.y;
  vSide = aSide.z;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
#include <fog_pars_fragment>
uniform vec3 uColor;
uniform float uDash;     // Periode in km (0 = durchgezogen)
uniform float uDashMode; // 0 Lücken, 1 Schwellen (hell/dunkel)
uniform float uNear;     // 1 = nah (Muster sichtbar), 0 = fern (Muster ausgeblendet)
varying float vDist;
varying float vClosed;
varying float vSide;
void main() {
  #include <logdepthbuf_fragment>
  vec3 col = uColor;
  if (vClosed > 0.5) {
    if (fract(vDist / 0.8) > 0.55) discard;
    col = vec3(0.85, 0.08, 0.05);
  } else if (uDash > 0.0) {
    float f = fract(vDist / uDash);
    if (uDashMode < 0.5) {
      if (f > 0.6 && uNear > 0.0) discard;
    } else {
      col *= mix(1.0, f < 0.35 ? 1.9 : 0.8, uNear);
    }
  }
  gl_FragColor = vec4(col, 1.0);
  #include <fog_fragment>
}
`;

interface Part {
  cls: string;
  mat: THREE.ShaderMaterial;
  mesh: THREE.Mesh | null;
  /** Kanten dieser Klasse */
  edges: number[];
  closedAttr: THREE.BufferAttribute | null;
  /** edgeId -> [Startvertex, Anzahl] */
  ranges: Map<number, [number, number]>;
  maxY: number;
}

export class RoadRenderer {
  readonly object = new THREE.Group();
  private readonly geo: GeoData;
  private readonly graph: NavGraph;
  private readonly parts: Part[] = [];
  private readonly partOfEdge: Int8Array;
  private readonly closed = new Set<number>();
  private exag: number;
  private show: boolean;

  constructor(geo: GeoData, graph: NavGraph, settings: Settings) {
    this.geo = geo;
    this.graph = graph;
    this.exag = settings.heightExaggeration;
    this.show = settings.showRoads;
    this.object.name = 'Roads';
    this.object.visible = this.show;

    const order = ['motorway', 'primary', 'secondary', 'road', 'track', 'rail', 'ferry', 'bridge'];
    for (const cls of order) {
      const st = STYLES[cls];
      const mat = new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        fog: true,
        uniforms: THREE.UniformsUtils.merge([
          THREE.UniformsLib.fog,
          {
            uColor: { value: new THREE.Color(st.color) },
            uExag: { value: this.exag },
            uPx: { value: st.px },
            uMinKm: { value: st.minKm },
            uLift: { value: st.lift },
            uDistLift: { value: cls === 'ferry' ? 0 : 0.0035 },
            uDash: { value: st.dash ?? 0 },
            uDashMode: { value: cls === 'rail' ? 1 : 0 },
            uNear: { value: 1 },
          },
        ]),
        side: THREE.DoubleSide,
      });
      this.parts.push({ cls, mat, mesh: null, edges: [], closedAttr: null, ranges: new Map(), maxY: st.maxY });
    }
    this.partOfEdge = new Int8Array(graph.edges.length);
    const idx = (c: string) => order.indexOf(c);
    for (const e of graph.edges) {
      const p = idx(e.cls);
      this.partOfEdge[e.id] = p;
      this.parts[p].edges.push(e.id);
      // Brücken zusätzlich als hervorgehobenes, leicht erhöhtes Band (nur Straßen)
      if (e.bridge && e.cls !== 'ferry' && e.cls !== 'rail') this.parts[idx('bridge')].edges.push(e.id);
    }
    // Brücken überlagern die Klasse: Kante auch im normalen Mesh lassen (ununterbrochenes Band),
    // das Brückenmesh liegt leicht darüber. Bewahrt Kantenzuordnung für setEdgeState.
    bus.on('nav:edge', ({ edgeId, open }) => this.setEdgeState(edgeId, open));
    void ROAD_CLASSES;
  }

  applySettings(s: Settings): void {
    this.exag = s.heightExaggeration;
    this.show = s.showRoads;
    this.object.visible = this.show;
    for (const p of this.parts) p.mat.uniforms.uExag.value = this.exag;
  }

  setEdgeState(edgeId: number, open: boolean): void {
    if (open) this.closed.delete(edgeId);
    else this.closed.add(edgeId);
    const e = this.graph.edges[edgeId];
    if (!e) return;
    const targets = [this.parts[this.partOfEdge[edgeId]], this.parts[this.parts.length - 1]];
    for (const p of targets) {
      if (!p || !p.closedAttr) continue;
      const r = p.ranges.get(edgeId);
      if (!r) continue;
      const arr = p.closedAttr.array as Float32Array;
      for (let v = r[0]; v < r[0] + r[1]; v++) arr[v * 2 + 1] = open ? 0 : 1;
      p.closedAttr.needsUpdate = true;
    }
  }

  update(camera: THREE.PerspectiveCamera): void {
    if (!this.show) return;
    const y = camera.position.y;
    for (const p of this.parts) {
      const vis = y <= p.maxY;
      if (vis && !p.mesh) this.build(p);
      if (p.mesh) p.mesh.visible = vis;
      p.mat.uniforms.uNear.value = y < 120 ? 1 : y < 260 ? 1 - (y - 120) / 140 : 0;
    }
  }

  // ------------------------------------------------------------------ Geometrie

  private build(p: Part): void {
    const geo = this.geo, g = this.graph;
    const naval = p.cls === 'ferry';
    // Anzahl Vertices vorab schätzen
    let pointCount = 0;
    const dens: Float32Array[] = [];
    for (const eid of p.edges) {
      const e = g.edges[eid];
      const src = e.geom;
      const out: number[] = [src[0], src[1]];
      for (let k = 2; k < src.length; k += 2) {
        const px = out[out.length - 2], pz = out[out.length - 1];
        const d = Math.hypot(src[k] - px, src[k + 1] - pz);
        const parts = Math.max(1, Math.ceil(d / DENSIFY_KM));
        for (let q = 1; q < parts; q++) out.push(px + ((src[k] - px) * q) / parts, pz + ((src[k + 1] - pz) * q) / parts);
        out.push(src[k], src[k + 1]);
      }
      const f = new Float32Array(out);
      dens.push(f);
      pointCount += f.length / 2;
    }
    const V = pointCount * 2;
    const pos = new Float32Array(V * 3), side = new Float32Array(V * 3), info = new Float32Array(V * 2);
    const index = new Uint32Array(Math.max(0, (pointCount - p.edges.length)) * 6);
    let v = 0, ii = 0;
    for (let n = 0; n < p.edges.length; n++) {
      const eid = p.edges[n], pts = dens[n], m = pts.length / 2;
      const v0 = v;
      let km = 0;
      for (let k = 0; k < m; k++) {
        const x = pts[k * 2], z = pts[k * 2 + 1];
        if (k > 0) km += Math.hypot(x - pts[k * 2 - 2], z - pts[k * 2 - 1]);
        // Tangente aus Nachbarn
        const ax = pts[Math.max(0, k - 1) * 2], az = pts[Math.max(0, k - 1) * 2 + 1];
        const bx = pts[Math.min(m - 1, k + 1) * 2], bz = pts[Math.min(m - 1, k + 1) * 2 + 1];
        let dx = bx - ax, dz = bz - az;
        const L = Math.hypot(dx, dz) || 1;
        dx /= L; dz /= L;
        const h = naval ? 0 : Math.max(0, geo.heightAt(x, z));
        const cl = this.closed.has(eid) ? 1 : 0;
        for (let s = 0; s < 2; s++) {
          pos[v * 3] = x; pos[v * 3 + 1] = h; pos[v * 3 + 2] = z;
          side[v * 3] = -dz; side[v * 3 + 1] = dx; side[v * 3 + 2] = s === 0 ? -1 : 1;
          info[v * 2] = km; info[v * 2 + 1] = cl;
          v++;
        }
        if (k > 0) {
          const a = v - 4, b = v - 3, c = v - 2, d = v - 1;
          index[ii++] = a; index[ii++] = b; index[ii++] = c;
          index[ii++] = b; index[ii++] = d; index[ii++] = c;
        }
      }
      p.ranges.set(eid, [v0, v - v0]);
    }
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    bg.setAttribute('aSide', new THREE.BufferAttribute(side, 3));
    const infoAttr = new THREE.BufferAttribute(info, 2);
    infoAttr.setUsage(THREE.DynamicDrawUsage);
    bg.setAttribute('aInfo', infoAttr);
    bg.setIndex(new THREE.BufferAttribute(index.subarray(0, ii), 1));
    bg.boundingSphere = new THREE.Sphere(new THREE.Vector3(geo.widthKm / 2, 0, geo.heightKm / 2), 1e5);
    bg.boundingBox = new THREE.Box3(new THREE.Vector3(-1e5, -1e5, -1e5), new THREE.Vector3(1e5, 1e5, 1e5));
    p.closedAttr = infoAttr;
    const mesh = new THREE.Mesh(bg, p.mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = p.cls === 'bridge' ? 3 : p.cls === 'ferry' ? 1 : 2;
    mesh.name = `Roads-${p.cls}`;
    p.mesh = mesh;
    this.object.add(mesh);
  }
}
