/**
 * Echte 3D-Krater (PS2-/Defilade-Stil): eine instanzierte Radialschale (Bowl + Auswurfrand + Auswurfschürze).
 *
 * "In den Boden geschnitten"-Eindruck: Das Gelände ist undurchsichtig und kann nicht verformt werden, deshalb liegt
 * der Kraterboden knapp ÜBER der Geländefläche (Lift ∝ Kameraabstand) und der Rand ragt ~28 % des Radius auf.
 * Flache Normalen (Ableitungen), Lambert mit der Sonne aus Terrain.ts, Innen-AO, dunkle verkohlte Mitte und
 * helle Randlichter ergeben die Hohlform; die Schürze verläuft per Dither-Rasterung in den Boden.
 * Alle Profile/Farben entstehen im Vertex-Shader aus Instanzdaten (kein Per-Frame-Aufwand außer uTime).
 */
import * as THREE from 'three';
import { Q } from '../core/quality';

export const CRATER_CAP = 3000;
const SEGS = 18;
const RINGS = [0.28, 0.52, 0.76, 0.93, 1.08, 1.35, 1.7, 2.1];

export const CRATER_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
#include <fog_pars_vertex>
attribute float aRing;
attribute vec3 aC;   // Welt (Bodenhöhe)
attribute vec4 aG;   // Hang gx, gz, Radius m, Tiefe
attribute vec4 aA;   // Geburt, Hitze, Oberfläche (0 Erde, 1 Asphalt), Seed
uniform float uVis;
uniform float uTime;
uniform float uLift;
uniform vec3 uSun;
varying vec3 vCol;
varying float vGlow;
varying float vAO;
varying float vAlpha;
varying vec3 vV;
varying vec3 vSunV;
float h21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  float K = 0.001 * pow(uVis, 0.85);
  float R = aG.z * K * 1.2; // Krater leicht überhöht (fester Maßstab, siehe SCALE.effects)
  float r0 = position.x;
  float th = position.y;
  float seg = position.z;
  float seed = aA.w;
  float age = max(0.0, uTime - aA.x);
  float ageF = smoothstep(40.0, 900.0, age);
  float road = aA.z;
  float hv = h21(vec2(seg, aRing) + seed);
  float ray = h21(vec2(seg, 7.0) + seed * 1.7);
  float r = r0;
  if (r0 > 0.0) {
    r *= 1.0 + (hv - 0.5) * (aRing < 4.5 ? 0.14 : 0.24);
    float apron = smoothstep(1.0, 2.1, r0);
    r *= 1.0 + apron * (ray - 0.4) * 0.6;
    th += (h21(vec2(seg, aRing) + seed + 3.0) - 0.5) * 0.2;
  }
  float depth = aG.w * (1.0 - 0.35 * ageF);
  float rimH = 0.36 * depth;
  const float RC = 0.93;
  float hn;
  if (r0 < RC) {
    hn = rimH * smoothstep(0.2, RC, r0);
  } else {
    float t = clamp((r0 - RC) / (2.1 - RC), 0.0, 1.0);
    hn = rimH * (1.0 - t) * (1.0 - t);
  }
  float band = exp(-pow((r0 - RC) / 0.22, 2.0));
  hn *= 1.0 + band * (hv - 0.5) * (road > 0.5 ? 1.4 : 0.8);
  float clod = step(0.78, h21(vec2(aRing * 3.1, seg) + seed + 9.0)) * step(1.2, r0);
  hn += clod * 0.07 * depth * (1.0 - smoothstep(1.7, 2.1, r0));

  vec2 off = vec2(cos(th), sin(th)) * r * R;
  vec3 wp = aC + vec3(off.x, 0.0, off.y);
  float slope = clamp(aG.x * off.x + aG.y * off.y, -R * 1.2, R * 1.2);
  wp.y += slope + uLift + hn * R;

  // Farbe
  vec3 charC = vec3(0.045, 0.04, 0.035);
  vec3 freshC = vec3(0.25, 0.185, 0.12);
  vec3 rimC = vec3(0.47, 0.39, 0.29);
  vec3 dryC = vec3(0.38, 0.33, 0.24);
  vec3 oldC = vec3(0.26, 0.31, 0.15);
  if (road > 0.5) {
    charC = vec3(0.05, 0.05, 0.052);
    freshC = vec3(0.2, 0.2, 0.21);
    rimC = vec3(0.4, 0.4, 0.39);
    dryC = vec3(0.3, 0.3, 0.3);
    oldC = vec3(0.3, 0.31, 0.3);
  }
  charC = mix(charC, freshC * 0.55, ageF * 0.6);
  vec3 col = mix(charC, freshC, smoothstep(0.3, 0.92, r0 + (hv - 0.5) * 0.25));
  col = mix(col, rimC, smoothstep(0.72, 1.02, r0));
  col = mix(col, dryC, smoothstep(1.1, 1.8, r0));
  float rays = ray > 0.5 ? 0.6 : 1.3;
  col *= mix(1.0, rays, smoothstep(0.95, 1.5, r0));
  col *= 0.85 + 0.3 * hv;
  col = mix(col, oldC * (0.7 + 0.5 * hv), ageF * (road > 0.5 ? 0.15 : 0.4) * smoothstep(0.5, 1.5, r0));
  col = mix(col, charC * 1.5, clod * 0.7);

  // Glut
  float heat = aA.y * (1.0 - smoothstep(0.0, 32.0, age));
  float flick = 0.65 + 0.35 * sin(uTime * 9.0 + seg * 2.3 + seed);
  vGlow = heat * flick * (1.0 - smoothstep(0.15, 1.15, r0)) * (0.3 + 0.7 * smoothstep(0.1, 0.8, hv + 0.4 - r0 * 0.3));
  vGlow += heat * flick * 0.5 * band * step(0.45, hv);

  vCol = col;
  vAO = mix(0.4, 1.0, smoothstep(0.0, 0.95, r0));
  vAlpha = 1.0 - smoothstep(1.55, 2.1, r0);
  vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
  vV = mvPosition.xyz;
  vSunV = normalize(mat3(viewMatrix) * uSun);
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

export const CRATER_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
#include <fog_pars_fragment>
varying vec3 vCol;
varying float vGlow;
varying float vAO;
varying float vAlpha;
varying vec3 vV;
varying vec3 vSunV;
void main() {
  #include <logdepthbuf_fragment>
  float dn = fract(52.9829189 * fract(dot(floor(gl_FragCoord.xy), vec2(0.06711056, 0.00583715))));
  if (vAlpha < 0.98 && vAlpha <= dn) discard;
  vec3 n = normalize(cross(dFdx(vV), dFdy(vV)));
  if (dot(n, vV) > 0.0) n = -n;
  float ndl = max(dot(n, vSunV), 0.0);
  float light = (0.34 + 1.05 * ndl) * vAO;
  vec3 col = vCol * light + vec3(1.0, 0.5, 0.14) * vGlow;
  col = col * col;
  gl_FragColor = vec4(col, 1.0);
  #include <fog_fragment>
}
`;

function buildGeometry(): THREE.InstancedBufferGeometry {
  const nV = 1 + RINGS.length * SEGS;
  const pos = new Float32Array(nV * 3);
  const ring = new Float32Array(nV);
  // Mittelpunkt
  pos[0] = 0; pos[1] = 0; pos[2] = 0; ring[0] = 0;
  for (let r = 0; r < RINGS.length; r++) {
    for (let s = 0; s < SEGS; s++) {
      const v = 1 + r * SEGS + s;
      pos[v * 3] = RINGS[r];
      pos[v * 3 + 1] = (s / SEGS) * Math.PI * 2;
      pos[v * 3 + 2] = s;
      ring[v] = r + 1;
    }
  }
  const idx: number[] = [];
  for (let s = 0; s < SEGS; s++) idx.push(0, 1 + ((s + 1) % SEGS), 1 + s);
  for (let r = 0; r < RINGS.length - 1; r++) {
    for (let s = 0; s < SEGS; s++) {
      const s1 = (s + 1) % SEGS;
      const a = 1 + r * SEGS + s, b = 1 + r * SEGS + s1, c = 1 + (r + 1) * SEGS + s, d = 1 + (r + 1) * SEGS + s1;
      // Diagonale wechselt -> weniger regelmäßiges Facettenbild
      if ((s + r) & 1) idx.push(a, b, c, b, d, c);
      else idx.push(a, b, d, a, d, c);
    }
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aRing', new THREE.BufferAttribute(ring, 1));
  g.setIndex(idx);
  return g;
}

export class CraterLayer {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  readonly aC = new Float32Array(CRATER_CAP * 3);
  readonly aG = new Float32Array(CRATER_CAP * 4);
  readonly aA = new Float32Array(CRATER_CAP * 4);
  count = 0;
  private head = 0;
  private dirty = false;
  private readonly geom: THREE.InstancedBufferGeometry;
  private readonly attrs: THREE.InstancedBufferAttribute[] = [];

  constructor(shared: Record<string, THREE.IUniform>, sun: THREE.Vector3) {
    const g = buildGeometry();
    const mk = (name: string, arr: Float32Array, n: number) => {
      const a = new THREE.InstancedBufferAttribute(arr, n);
      a.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute(name, a);
      this.attrs.push(a);
    };
    mk('aC', this.aC, 3);
    mk('aG', this.aG, 4);
    mk('aA', this.aA, 4);
    g.instanceCount = 0;
    this.geom = g;
    this.material = new THREE.ShaderMaterial({
      vertexShader: CRATER_VERT,
      fragmentShader: CRATER_FRAG,
      uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ...shared, uSun: { value: sun.clone() } },
      fog: true,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2.5;
    this.mesh.visible = false;
    this.mesh.name = 'FxCraterBowls';
  }

  /**
   * Neuen Krater anlegen. Bei Häufung (viele Krater nahe beieinander) werden neue kleiner und ab N=10 ersetzen sie
   * den ältesten Nachbarn (Artilleriesperrfeuer wühlt den Boden um, ohne die Kappe zu sprengen).
   */
  add(x: number, y: number, z: number, gx: number, gz: number, radiusM: number, depth: number, hot: number, surf: number, born: number): void {
    let n = 0, oldest = -1, oldT = 1e30;
    const NR2 = 0.014 * 0.014;
    for (let i = 0; i < this.count; i++) {
      const dx = this.aC[i * 3] - x, dz = this.aC[i * 3 + 2] - z;
      if (dx * dx + dz * dz < NR2) {
        n++;
        const b = this.aA[i * 4];
        if (b < oldT) { oldT = b; oldest = i; }
      }
    }
    if (n >= 4) radiusM *= Math.max(0.55, 1 - 0.07 * (n - 3));
    let i: number;
    if (n >= 10 && oldest >= 0) i = oldest;
    else { i = this.head; this.head = (this.head + 1) % Math.min(CRATER_CAP, Q.craterCap); }
    if (i >= this.count) this.count = i + 1;
    this.aC[i * 3] = x; this.aC[i * 3 + 1] = y; this.aC[i * 3 + 2] = z;
    this.aG[i * 4] = gx; this.aG[i * 4 + 1] = gz; this.aG[i * 4 + 2] = radiusM; this.aG[i * 4 + 3] = depth;
    this.aA[i * 4] = born; this.aA[i * 4 + 1] = hot; this.aA[i * 4 + 2] = surf; this.aA[i * 4 + 3] = Math.random() * 50;
    this.dirty = true;
  }

  /** pro Frame: Hochladen nur wenn neue Krater dazukamen; show = Kamera nah genug */
  update(show: boolean): void {
    if (this.dirty) {
      this.geom.instanceCount = this.count;
      for (const a of this.attrs) a.needsUpdate = true;
      this.dirty = false;
    }
    this.mesh.visible = show && this.count > 0;
  }
}
