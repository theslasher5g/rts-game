/**
 * Phase 3 – Visuelle Effekte (PS2-/Defilade-Stil: klobige Low-Res-Partikel, schmutzige Farben, aber knackig).
 *
 * Bausteine (alle ohne Allokation pro Frame):
 *  - Partikelsystem: ein InstancedBufferGeometry-Quad-Mesh (kamera-zugewandt, Ringpuffer, CPU-simuliert, ~24k)
 *  - Decals: Krater/Brandflecken (persistent, 2000) + Druckwellen/Wellenringe (transient) – am Hang ausgerichtet
 *  - Tracer-/Projektil-Bänder (instanzierte Screen-Space-Linien)
 *  - Trümmerbrocken (InstancedMesh, Ballistik + einmaliger Aufprall)
 *  - Wracks (InstancedMesh je Kategorie, verbrannt, qualmen/brennen ~60 s)
 *  - Rauch-Wolkenregister (SmokeQuery) für die Sichtlinienprüfung
 *
 * Größen werden in "Metern" simuliert und beim Rendern mit dem strategischen Sichtmaßstab
 * (wie UnitRenderer: clamp(4 · Kameraabstand, 3, 600)) in Welt-km umgerechnet, damit Effekte beim Herauszoomen lesbar bleiben.
 */
import * as THREE from 'three';
import { bus } from '../core/EventBus';
import type { Settings } from '../core/types';
import type { ExplosionSize, ImpactSurface, SmokeQuery, WeaponKind } from '../combat/types';
import type { Unit } from '../units/types';
import type { GeoData } from '../world/GeoData';
import { DECAL_FRAG, DECAL_VERT, PARTICLE_FRAG, PARTICLE_VERT, RIBBON_FRAG, RIBBON_VERT } from './shaders';

// ---------------------------------------------------------------- Tuning
const VIS_K = 4;
const VIS_MIN = 3;
const VIS_MAX = 600;
/** Standard-Skalierungsexponent der Effekte: Größe(m) · 0.001 · visScale^EFFECT_SC (etwas schwächer als die Einheiten, damit Explosionen nicht den Bildschirm füllen) */
const EFFECT_SC = 0.85;
const PARTICLE_CAP = 24000;
const SPAWN_BUDGET = 7000; // Partikel pro Frame (Notbremse)
const DECAL_CAP = 2000;
const RING_CAP = 192;
const RIBBON_CAP = 768;
const PROJ_CAP = 320;
const DEBRIS_CAP = 1800;
const EMITTER_CAP = 200;
const CLOUD_CAP = 128;
const DELAY_CAP = 192;
const FAR_SKIP = 1500; // km Kameraabstand: nur noch Säulen/Marker
const DAMAGED_PER_FRAME = 48;

const RAMP_FIRE = 0, RAMP_SMOKE = 1, RAMP_SPARK = 2, RAMP_FLASH = 3, RAMP_DIRT = 4, RAMP_EMBER = 5;
const SHAPE_BLOB = 0, SHAPE_CHIP = 1, SHAPE_GLOW = 2;

const FIRE_STOPS = new Float32Array([
  1.0, 0.97, 0.78,
  1.0, 0.75, 0.25,
  0.95, 0.4, 0.08,
  0.45, 0.12, 0.05,
  0.15, 0.12, 0.11,
]);
const FIRE_T = [0, 0.18, 0.45, 0.75, 1.0];

const SIZE_IDX: Record<ExplosionSize, number> = { tiny: 0, small: 1, medium: 2, large: 3, huge: 4 };
//                          tiny   small  medium large  huge
const X_R = [2.5, 5, 9, 16, 30]; // Feuerball-Radius (m)
const X_FIRE = [8, 18, 38, 75, 140];
const X_SMOKE = [6, 14, 28, 50, 95];
const X_DEBRIS = [3, 6, 12, 20, 34];
const X_SPARK = [6, 12, 20, 30, 46];
const X_RING = [5, 11, 22, 40, 80];
const X_CRATER = [1.8, 3.5, 6, 10, 19];
const X_COLUMN = [6, 20, 45, 90, 180]; // s
const X_SHAKE = [0.04, 0.1, 0.22, 0.45, 0.9];
const X_CLOUD_R = [0, 0.008, 0.02, 0.035, 0.06]; // km
const X_CLOUD_D = [0, 0.35, 0.5, 0.6, 0.7];

const rnd = Math.random;
function rr(a: number, b: number): number { return a + (b - a) * rnd(); }
function clamp(v: number, a: number, b: number): number { return v < a ? a : v > b ? b : v; }
function smooth(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

// ================================================================ Partikelsystem
class Particles {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private readonly geom: THREE.InstancedBufferGeometry;
  private readonly aPos = new Float32Array(PARTICLE_CAP * 4);
  private readonly aOrg = new Float32Array(PARTICLE_CAP * 3);
  private readonly aCol = new Float32Array(PARTICLE_CAP * 4);
  private readonly aMisc = new Float32Array(PARTICLE_CAP * 4);
  private readonly attrs: THREE.InstancedBufferAttribute[] = [];
  // Simulation
  private readonly vel = new Float32Array(PARTICLE_CAP * 3);
  private readonly pos = new Float32Array(PARTICLE_CAP * 3);
  private readonly age = new Float32Array(PARTICLE_CAP);
  private readonly life = new Float32Array(PARTICLE_CAP);
  private readonly grow = new Float32Array(PARTICLE_CAP);
  private readonly drag = new Float32Array(PARTICLE_CAP);
  private readonly grav = new Float32Array(PARTICLE_CAP);
  private readonly s0 = new Float32Array(PARTICLE_CAP);
  private readonly a0 = new Float32Array(PARTICLE_CAP);
  private readonly base = new Float32Array(PARTICLE_CAP * 3);
  private readonly spin = new Float32Array(PARTICLE_CAP);
  private readonly seed = new Float32Array(PARTICLE_CAP);
  private readonly rot = new Float32Array(PARTICLE_CAP);
  private readonly ramp = new Uint8Array(PARTICLE_CAP);
  private readonly shapeF = new Float32Array(PARTICLE_CAP);
  private readonly scF = new Float32Array(PARTICLE_CAP);
  private head = 0;
  private hi = 0;
  budget = SPAWN_BUDGET;
  alive = 0;

  constructor() {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const mk = (name: string, arr: Float32Array, n: number) => {
      const a = new THREE.InstancedBufferAttribute(arr, n);
      a.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute(name, a);
      this.attrs.push(a);
    };
    mk('aPos', this.aPos, 4);
    mk('aOrg', this.aOrg, 3);
    mk('aCol', this.aCol, 4);
    mk('aMisc', this.aMisc, 4);
    g.instanceCount = 0;
    this.geom = g;
    this.material = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      uniforms: { uVis: { value: VIS_MIN }, uPx: { value: 0.002 } },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      fog: false,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.name = 'FxParticles';
  }

  add(
    ox: number, oy: number, oz: number, lx: number, ly: number, lz: number,
    vx: number, vy: number, vz: number,
    size: number, grow: number, life: number, ramp: number,
    r: number, g: number, b: number, a: number,
    grav: number, drag: number, shape: number, sc: number, spin: number,
  ): void {
    if (this.budget <= 0) return;
    this.budget--;
    const i = this.head;
    this.head = (this.head + 1) % PARTICLE_CAP;
    if (i >= this.hi) this.hi = i + 1;
    const o3 = i * 3;
    this.aOrg[o3] = ox; this.aOrg[o3 + 1] = oy; this.aOrg[o3 + 2] = oz;
    this.pos[o3] = lx; this.pos[o3 + 1] = ly; this.pos[o3 + 2] = lz;
    this.vel[o3] = vx; this.vel[o3 + 1] = vy; this.vel[o3 + 2] = vz;
    this.base[o3] = r; this.base[o3 + 1] = g; this.base[o3 + 2] = b;
    this.s0[i] = size; this.grow[i] = grow; this.life[i] = Math.max(0.05, life); this.age[i] = 0;
    this.ramp[i] = ramp; this.a0[i] = a; this.grav[i] = grav; this.drag[i] = drag;
    this.spin[i] = spin; this.rot[i] = rnd() * 6.2832; this.seed[i] = rnd() * 97;
    this.shapeF[i] = shape; this.scF[i] = sc >= 1 ? EFFECT_SC : sc;
    // sofort sichtbare Werte (falls vor dem ersten step gerendert wird)
    const o4 = i * 4;
    this.aPos[o4] = lx; this.aPos[o4 + 1] = ly; this.aPos[o4 + 2] = lz; this.aPos[o4 + 3] = 0;
    this.aCol[o4 + 3] = 0;
    this.aMisc[o4 + 2] = shape * 1000 + this.seed[i];
    this.aMisc[o4 + 3] = this.scF[i];
  }

  step(dt: number): void {
    const hi = this.hi;
    const aPos = this.aPos, aCol = this.aCol, aMisc = this.aMisc;
    const pos = this.pos, vel = this.vel, base = this.base;
    let alive = 0;
    for (let i = 0; i < hi; i++) {
      const life = this.life[i];
      const o4 = i * 4;
      if (life <= 0) continue;
      const age = this.age[i] + dt;
      if (age >= life) {
        this.life[i] = 0;
        aPos[o4 + 3] = 0;
        aCol[o4 + 3] = 0;
        continue;
      }
      alive++;
      this.age[i] = age;
      const o3 = i * 3;
      const t = age / life;
      const f = 1 / (1 + this.drag[i] * dt);
      let vx = vel[o3] * f, vy = vel[o3 + 1] * f, vz = vel[o3 + 2] * f;
      const gr = this.grav[i];
      vy -= gr * dt;
      let py = pos[o3 + 1] + vy * dt;
      if (gr > 0 && py < 0) {
        py = 0;
        vy = -vy * 0.28;
        vx *= 0.55; vz *= 0.55;
        if (Math.abs(vy) < 0.8) vy = 0;
      }
      vel[o3] = vx; vel[o3 + 1] = vy; vel[o3 + 2] = vz;
      pos[o3] += vx * dt; pos[o3 + 1] = py; pos[o3 + 2] += vz * dt;

      let size = this.s0[i] + this.grow[i] * age;
      let r: number, g: number, b: number, a: number, add: number;
      const a0 = this.a0[i];
      switch (this.ramp[i]) {
        case RAMP_FIRE: {
          let k = 0;
          while (k < 3 && t > FIRE_T[k + 1]) k++;
          const u = (t - FIRE_T[k]) / (FIRE_T[k + 1] - FIRE_T[k]);
          const s0 = k * 3, s1 = s0 + 3;
          r = FIRE_STOPS[s0] + (FIRE_STOPS[s1] - FIRE_STOPS[s0]) * u;
          g = FIRE_STOPS[s0 + 1] + (FIRE_STOPS[s1 + 1] - FIRE_STOPS[s0 + 1]) * u;
          b = FIRE_STOPS[s0 + 2] + (FIRE_STOPS[s1 + 2] - FIRE_STOPS[s0 + 2]) * u;
          a = a0 * Math.min(1, t / 0.06) * (1 - smooth(0.55, 1, t));
          add = 1 - smooth(0.35, 0.85, t) * 0.95;
          break;
        }
        case RAMP_SMOKE: {
          const k = 1 - 0.18 * t;
          r = base[o3] * k; g = base[o3 + 1] * k; b = base[o3 + 2] * k;
          a = a0 * Math.min(1, t / 0.08) * (1 - smooth(0.4, 1, t));
          add = 0;
          break;
        }
        case RAMP_SPARK: {
          r = 1; g = 0.95 - 0.5 * t; b = 0.6 - 0.5 * t;
          a = 1 - t;
          add = 1;
          size *= 1 - 0.5 * t;
          break;
        }
        case RAMP_FLASH: {
          r = base[o3]; g = base[o3 + 1]; b = base[o3 + 2];
          a = a0 * (1 - t) * (1 - t);
          add = 1;
          break;
        }
        case RAMP_EMBER: {
          r = base[o3]; g = base[o3 + 1]; b = base[o3 + 2];
          a = a0 * (0.65 + 0.35 * Math.sin(age * 17 + this.seed[i])) * (1 - t);
          add = 1;
          break;
        }
        default: { // RAMP_DIRT
          r = base[o3]; g = base[o3 + 1]; b = base[o3 + 2];
          a = a0 * Math.min(1, t / 0.05) * (1 - smooth(0.65, 1, t));
          add = 0;
        }
      }
      aPos[o4] = pos[o3]; aPos[o4 + 1] = py; aPos[o4 + 2] = pos[o3 + 2]; aPos[o4 + 3] = size;
      aCol[o4] = r; aCol[o4 + 1] = g; aCol[o4 + 2] = b; aCol[o4 + 3] = a;
      aMisc[o4] = add;
      aMisc[o4 + 1] = this.rot[i] + this.spin[i] * age;
      aMisc[o4 + 2] = this.shapeF[i] * 1000 + this.seed[i];
      aMisc[o4 + 3] = this.scF[i];
    }
    this.alive = alive;
    // Hochwassermarke zurücknehmen, wenn das Ende leer ist
    let h = hi;
    while (h > 0 && this.life[h - 1] <= 0) h--;
    if (h < this.hi && this.head < h) this.hi = h; // nur wenn der Kopf nicht dahinter liegt
    this.geom.instanceCount = this.hi;
    this.mesh.visible = this.hi > 0;
    if (this.hi > 0) {
      for (const a of this.attrs) {
        a.clearUpdateRanges();
        a.addUpdateRange(0, this.hi * a.itemSize);
        a.needsUpdate = true;
      }
    }
    this.budget = SPAWN_BUDGET;
  }
}

// ================================================================ Decals
class DecalLayer {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private readonly geom: THREE.InstancedBufferGeometry;
  private readonly aC: Float32Array;
  private readonly aG: Float32Array;
  private readonly aA: Float32Array;
  private readonly attrs: THREE.InstancedBufferAttribute[] = [];
  private head = 0;
  private count = 0;
  private readonly cap: number;

  constructor(cap: number, order: number, sharedUniforms: Record<string, THREE.IUniform>) {
    this.cap = cap;
    this.aC = new Float32Array(cap * 3);
    this.aG = new Float32Array(cap * 4);
    this.aA = new Float32Array(cap * 4);
    const base = new THREE.PlaneGeometry(2, 2, 4, 4);
    base.rotateX(-Math.PI / 2);
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', base.getAttribute('position'));
    g.setIndex(base.getIndex());
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
      vertexShader: DECAL_VERT,
      fragmentShader: DECAL_FRAG,
      uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ...sharedUniforms },
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = order;
    this.mesh.visible = false;
  }

  add(x: number, y: number, z: number, gx: number, gz: number, radiusM: number, type: number, alpha: number, born: number, life: number): void {
    const i = this.head;
    this.head = (this.head + 1) % this.cap;
    if (i >= this.count) this.count = i + 1;
    this.aC[i * 3] = x; this.aC[i * 3 + 1] = y; this.aC[i * 3 + 2] = z;
    this.aG[i * 4] = gx; this.aG[i * 4 + 1] = gz; this.aG[i * 4 + 2] = radiusM; this.aG[i * 4 + 3] = type;
    this.aA[i * 4] = alpha; this.aA[i * 4 + 1] = born; this.aA[i * 4 + 2] = life; this.aA[i * 4 + 3] = rnd() * 50;
    this.geom.instanceCount = this.count;
    this.mesh.visible = true;
    for (const a of this.attrs) a.needsUpdate = true;
  }

  /** Abgelaufene transiente Einträge ausblenden (Radius 0) – nur für Ringlayer */
  expire(now: number): void {
    let any = false;
    for (let i = 0; i < this.count; i++) {
      const life = this.aA[i * 4 + 2];
      if (this.aG[i * 4 + 2] > 0 && now - this.aA[i * 4 + 1] > life) {
        this.aG[i * 4 + 2] = 0;
        any = true;
      }
    }
    if (any) for (const a of this.attrs) a.needsUpdate = true;
  }
}

// ================================================================ Bänder (Tracer / Projektilspuren)
class RibbonLayer {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private readonly geom: THREE.InstancedBufferGeometry;
  private readonly aA = new Float32Array(RIBBON_CAP * 3);
  private readonly aB = new Float32Array(RIBBON_CAP * 3);
  private readonly aCol = new Float32Array(RIBBON_CAP * 4);
  private readonly attrs: THREE.InstancedBufferAttribute[] = [];
  count = 0;
  // Logik je Tracer
  readonly t0 = new Float32Array(RIBBON_CAP);
  readonly dur = new Float32Array(RIBBON_CAP);
  readonly lenFrac = new Float32Array(RIBBON_CAP);
  readonly from = new Float32Array(RIBBON_CAP * 3);
  readonly to = new Float32Array(RIBBON_CAP * 3);
  readonly col = new Float32Array(RIBBON_CAP * 4);
  readonly live = new Uint8Array(RIBBON_CAP);
  private head = 0;

  constructor() {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const mk = (name: string, arr: Float32Array, n: number) => {
      const a = new THREE.InstancedBufferAttribute(arr, n);
      a.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute(name, a);
      this.attrs.push(a);
    };
    mk('aA', this.aA, 3);
    mk('aB', this.aB, 3);
    mk('aCol', this.aCol, 4);
    g.instanceCount = 0;
    this.geom = g;
    this.material = new THREE.ShaderMaterial({
      vertexShader: RIBBON_VERT,
      fragmentShader: RIBBON_FRAG,
      uniforms: { uRes: { value: new THREE.Vector2(960, 540) } },
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      fog: false,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
  }

  add(fx: number, fy: number, fz: number, tx: number, ty: number, tz: number, t0: number, dur: number, lenFrac: number, r: number, g: number, b: number, widthPx: number): void {
    const i = this.head;
    this.head = (this.head + 1) % RIBBON_CAP;
    if (i >= this.count) this.count = i + 1;
    this.live[i] = 1;
    this.t0[i] = t0; this.dur[i] = dur; this.lenFrac[i] = lenFrac;
    this.from[i * 3] = fx; this.from[i * 3 + 1] = fy; this.from[i * 3 + 2] = fz;
    this.to[i * 3] = tx; this.to[i * 3 + 1] = ty; this.to[i * 3 + 2] = tz;
    this.col[i * 4] = r; this.col[i * 4 + 1] = g; this.col[i * 4 + 2] = b; this.col[i * 4 + 3] = widthPx;
  }

  update(now: number): void {
    const n = this.count;
    for (let i = 0; i < n; i++) {
      if (!this.live[i]) { this.aCol[i * 4 + 3] = 0; this.aCol[i * 4] = 0; this.aCol[i * 4 + 1] = 0; this.aCol[i * 4 + 2] = 0; this.aA[i * 3] = this.aB[i * 3] = 0; continue; }
      const p = (now - this.t0[i]) / this.dur[i];
      const lf = this.lenFrac[i];
      if (p - lf >= 1) {
        this.live[i] = 0;
        this.aCol[i * 4 + 3] = 0; this.aCol[i * 4] = 0; this.aCol[i * 4 + 1] = 0; this.aCol[i * 4 + 2] = 0;
        continue;
      }
      const ph = clamp(p, 0, 1), pt = clamp(p - lf, 0, 1);
      const o = i * 3;
      for (let k = 0; k < 3; k++) {
        const f = this.from[o + k], d = this.to[o + k] - f;
        this.aA[o + k] = f + d * pt;
        this.aB[o + k] = f + d * ph;
      }
      const fade = p < 0 ? 0 : 1 - smooth(0.8, 1 + lf, p) * 0.7;
      this.aCol[i * 4] = this.col[i * 4] * fade;
      this.aCol[i * 4 + 1] = this.col[i * 4 + 1] * fade;
      this.aCol[i * 4 + 2] = this.col[i * 4 + 2] * fade;
      this.aCol[i * 4 + 3] = p < 0 ? 0 : this.col[i * 4 + 3];
    }
    this.geom.instanceCount = n;
    this.mesh.visible = n > 0;
    for (const a of this.attrs) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * a.itemSize);
      a.needsUpdate = true;
    }
  }
}

// ================================================================ Geometrie-Builder für Wracks
class GeoBuilder {
  private pos: number[] = [];
  private nor: number[] = [];
  private col: number[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly v = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly n = new THREE.Vector3();

  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, c: number, rx = 0, ry = 0, rz = 0): this {
    this.e.set(rx, ry, rz, 'YXZ');
    this.q.setFromEuler(this.e);
    this.m.compose(this.v.set(cx, cy, cz), this.q, this.s.set(1, 1, 1));
    const r = ((c >> 16) & 255) / 255, g = ((c >> 8) & 255) / 255, b = (c & 255) / 255;
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    // 6 Flächen: Normale + 4 Ecken (CCW)
    const faces: Array<[number[], number[][]]> = [
      [[1, 0, 0], [[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]]],
      [[-1, 0, 0], [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]]],
      [[0, 1, 0], [[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]]],
      [[0, -1, 0], [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]]],
      [[0, 0, 1], [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]]],
      [[0, 0, -1], [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]]],
    ];
    for (const [nn, corners] of faces) {
      this.n.set(nn[0], nn[1], nn[2]).transformDirection(this.m);
      // leichte Helligkeitsvariation pro Fläche (verbrannte Flecken)
      const k = 0.85 + rnd() * 0.3;
      for (const ci of [0, 1, 2, 0, 2, 3]) {
        const p = corners[ci];
        this.v.set(p[0], p[1], p[2]).applyMatrix4(this.m);
        this.pos.push(this.v.x, this.v.y, this.v.z);
        this.nor.push(this.n.x, this.n.y, this.n.z);
        this.col.push(r * k, g * k, b * k);
      }
    }
    return this;
  }

  /** gesamte bisherige Geometrie drehen/verschieben */
  transform(rx: number, ry: number, rz: number, ty = 0, sx = 1): this {
    this.e.set(rx, ry, rz, 'YXZ');
    this.q.setFromEuler(this.e);
    this.m.compose(this.v.set(0, ty, 0), this.q, this.s.set(sx, sx, sx));
    for (let i = 0; i < this.pos.length; i += 3) {
      this.v.set(this.pos[i], this.pos[i + 1], this.pos[i + 2]).applyMatrix4(this.m);
      this.pos[i] = this.v.x; this.pos[i + 1] = this.v.y; this.pos[i + 2] = this.v.z;
      this.n.set(this.nor[i], this.nor[i + 1], this.nor[i + 2]).transformDirection(this.m);
      this.nor[i] = this.n.x; this.nor[i + 1] = this.n.y; this.nor[i + 2] = this.n.z;
    }
    return this;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    return g;
  }
}

const CH = 0x1c1a18, CH2 = 0x141312, RUST = 0x3a2416, SOOT = 0x0e0d0c, GREY = 0x2a2724;

type WreckKind = 'tank' | 'ifv' | 'recon' | 'artillery' | 'aa' | 'support' | 'heli' | 'jet' | 'drone' | 'naval';
const WRECK_CAP: Record<WreckKind, number> = { tank: 100, ifv: 80, recon: 40, artillery: 40, aa: 30, support: 40, heli: 30, jet: 30, drone: 20, naval: 20 };

function wreckGeometry(kind: WreckKind): THREE.BufferGeometry {
  const b = new GeoBuilder();
  switch (kind) {
    case 'tank':
      b.box(-1.75, 0.5, 0, 0.8, 1.0, 7.8, SOOT).box(1.75, 0.5, 0.2, 0.8, 0.9, 7.4, SOOT, 0, 0.03, 0)
        .box(0, 1.1, 0.4, 3.2, 0.9, 6.4, CH).box(0, 1.7, -2.4, 3.0, 0.5, 2.0, CH2, 0.3, 0, 0)
        .box(0.35, 1.95, 0.6, 2.5, 0.8, 2.7, RUST, 0, 0.55, 0.16)
        .box(1.7, 2.1, -1.6, 0.28, 0.28, 4.4, SOOT, -0.18, 0.55, 0)
        .box(-0.4, 2.45, 0.9, 0.9, 0.3, 0.9, GREY, 0.2, 0.4, 0.3);
      break;
    case 'ifv':
      b.box(-1.5, 0.45, 0, 0.7, 0.9, 6.6, SOOT).box(1.5, 0.45, 0, 0.7, 0.9, 6.6, SOOT)
        .box(0, 1.15, 0.2, 2.9, 1.0, 6.0, CH).box(0, 1.9, -0.3, 2.0, 0.6, 2.6, RUST, 0, 0.35, 0.12)
        .box(0.6, 2.05, -1.8, 0.2, 0.2, 2.8, SOOT, -0.15, 0.35, 0).box(-0.3, 1.95, 2.0, 1.6, 0.35, 1.6, GREY, 0.3, 0.2, 0.2);
      break;
    case 'recon':
      b.box(0, 0.85, 0, 2.2, 0.9, 4.6, CH).box(0, 1.55, 0.7, 1.9, 0.7, 2.0, RUST, 0, 0.1, 0.1)
        .box(-1.1, 0.4, -1.5, 0.5, 0.8, 0.8, SOOT).box(1.1, 0.4, -1.5, 0.5, 0.8, 0.8, SOOT)
        .box(-1.1, 0.4, 1.5, 0.5, 0.8, 0.8, SOOT).box(1.1, 0.4, 1.5, 0.5, 0.8, 0.8, SOOT);
      b.transform(0, 0, 0.05);
      break;
    case 'artillery':
      b.box(0, 0.9, 0.5, 3.0, 1.1, 8.0, CH).box(0, 1.9, 1.0, 2.8, 1.0, 3.6, RUST, 0, 0.2, 0.1)
        .box(0.3, 2.9, -3.2, 0.4, 0.4, 7.4, SOOT, 0.5, 0.2, 0).box(-1.6, 0.4, 0.5, 0.7, 0.8, 7.4, SOOT).box(1.6, 0.4, 0.5, 0.7, 0.8, 7.4, SOOT);
      break;
    case 'aa':
      b.box(0, 0.9, 0.3, 3.0, 1.0, 7.0, CH).box(0, 2.0, 0.2, 2.6, 1.2, 2.8, RUST, 0, 0.5, 0.15)
        .box(-0.5, 3.0, -1.6, 0.22, 0.22, 3.4, SOOT, 0.55, 0.5, 0).box(0.7, 2.9, -1.8, 0.22, 0.22, 3.4, SOOT, 0.35, 0.5, 0)
        .box(-1.6, 0.4, 0.3, 0.7, 0.8, 7.0, SOOT).box(1.6, 0.4, 0.3, 0.7, 0.8, 7.0, SOOT);
      break;
    case 'support':
      b.box(0, 0.8, 1.5, 2.6, 0.5, 6.4, SOOT).box(0, 1.6, -2.3, 2.4, 1.6, 2.0, CH, 0, 0, 0.06)
        .box(0, 1.9, 2.0, 2.6, 1.5, 4.6, RUST, 0.05, 0, 0.2).box(-1.2, 0.5, -2.3, 0.5, 1.0, 1.0, SOOT).box(1.2, 0.5, 2.3, 0.5, 1.0, 1.0, SOOT);
      break;
    case 'heli':
      b.box(0, 1.2, 0, 2.2, 2.0, 7.0, CH, 0.05, 0, 0).box(0, 1.7, 6.0, 0.7, 0.8, 6.0, GREY, 0, 0.18, 0)
        .box(0, 2.6, 0, 0.4, 1.2, 0.4, SOOT).box(3.2, 0.4, 0.6, 8.0, 0.12, 0.5, SOOT, 0, 0.9, 0.08)
        .box(-2.2, 0.3, -1.5, 5.0, 0.12, 0.5, SOOT, 0, -0.5, -0.1).box(0, 0.35, -1.4, 1.4, 0.7, 1.8, RUST);
      b.transform(0.04, 0, 0.28);
      break;
    case 'jet':
      b.box(0, 0.9, 0, 1.7, 1.3, 14.0, CH, 0.05, 0, 0).box(-4.0, 0.45, 2.5, 7.5, 0.2, 3.8, GREY, 0, 0.35, 0.1)
        .box(3.0, 0.4, 3.4, 3.6, 0.2, 2.6, RUST, 0, -0.5, -0.05).box(0, 2.6, 6.0, 0.25, 2.6, 2.4, SOOT, 0, 0, 0.35)
        .box(0, 0.5, -7.0, 1.2, 1.0, 3.0, SOOT, 0.3, 0, 0);
      b.transform(0.05, 0, 0.12);
      break;
    case 'drone':
      b.box(0, 0.5, 0, 0.7, 0.6, 3.6, CH).box(-1.6, 0.35, 0.2, 3.2, 0.1, 0.9, GREY, 0, 0.3, 0.1).box(1.4, 0.3, 0.3, 1.6, 0.1, 0.8, RUST, 0, -0.4, 0);
      break;
    case 'naval':
      b.box(0, 3.0, 0, 9.0, 6.0, 44.0, CH2).box(0, 3.0, -24.0, 5.5, 5.0, 8.0, CH2, 0, 0.45, 0)
        .box(0, 8.5, 6.0, 6.5, 5.0, 14.0, RUST).box(0, 12.0, 8.0, 3.0, 3.0, 5.0, GREY).box(0, 7.0, -10.0, 3.0, 2.0, 5.0, GREY);
      b.transform(0.05, 0.05, 0.42, -1.2);
      break;
  }
  return b.build();
}

// ================================================================ Waffen-Tabelle
interface WeaponFx {
  muzzle: number;      // Mündungsfeuer (m)
  puff: number;        // Rauchwölkchen an der Mündung (m), 0 = keins
  tracer: number;      // Tracer-Breite px (0 = keiner)
  proj: 0 | 1 | 2 | 3 | 4 | 5; // 0 keins, 1 schneller Schuss, 2 Rakete/Lenkwaffe mit Spur, 3 ballistisch, 4 Bombe, 5 Torpedo
  trail: number;       // Rauchspur-Größe (m)
  dust: number;        // Startstaub (m), 0 = keiner
}
const W: Record<WeaponKind, WeaponFx> = {
  rifle: { muzzle: 0.7, puff: 0, tracer: 1, proj: 0, trail: 0, dust: 0 },
  mg: { muzzle: 0.9, puff: 0, tracer: 1.5, proj: 0, trail: 0, dust: 0 },
  hmg: { muzzle: 1.3, puff: 0.8, tracer: 2, proj: 0, trail: 0, dust: 0 },
  sniper: { muzzle: 1.0, puff: 0.8, tracer: 1, proj: 0, trail: 0, dust: 0 },
  autocannon: { muzzle: 1.6, puff: 1.2, tracer: 2.5, proj: 0, trail: 0, dust: 0 },
  tank_gun: { muzzle: 3.6, puff: 3.5, tracer: 3, proj: 1, trail: 0, dust: 2.5 },
  atgm: { muzzle: 1.6, puff: 1.8, tracer: 0, proj: 2, trail: 1.1, dust: 0 },
  rpg: { muzzle: 1.4, puff: 2.5, tracer: 0, proj: 2, trail: 0.9, dust: 0 },
  mortar: { muzzle: 1.8, puff: 2.5, tracer: 0, proj: 3, trail: 0, dust: 2 },
  howitzer: { muzzle: 5, puff: 5, tracer: 0, proj: 3, trail: 0, dust: 6 },
  rocket_arty: { muzzle: 4.5, puff: 6, tracer: 0, proj: 3, trail: 1.8, dust: 7 },
  sam: { muzzle: 2.0, puff: 4, tracer: 0, proj: 2, trail: 1.5, dust: 3 },
  flak: { muzzle: 1.8, puff: 1.2, tracer: 2.5, proj: 0, trail: 0, dust: 0 },
  heli_gun: { muzzle: 1.0, puff: 0, tracer: 2, proj: 0, trail: 0, dust: 0 },
  heli_rocket: { muzzle: 1.2, puff: 1.5, tracer: 0, proj: 2, trail: 1.0, dust: 0 },
  heli_atgm: { muzzle: 1.2, puff: 1.5, tracer: 0, proj: 2, trail: 1.1, dust: 0 },
  air_gun: { muzzle: 1.2, puff: 0, tracer: 2.5, proj: 0, trail: 0, dust: 0 },
  air_missile: { muzzle: 1.4, puff: 2, tracer: 0, proj: 2, trail: 1.4, dust: 0 },
  bomb: { muzzle: 0, puff: 0, tracer: 0, proj: 4, trail: 0.6, dust: 0 },
  naval_gun: { muzzle: 5, puff: 5, tracer: 3, proj: 1, trail: 0, dust: 0 },
  torpedo: { muzzle: 0, puff: 0, tracer: 0, proj: 5, trail: 0, dust: 0 },
  antiship_missile: { muzzle: 2.5, puff: 4, tracer: 0, proj: 2, trail: 1.6, dust: 0 },
  fpv: { muzzle: 0, puff: 0, tracer: 0, proj: 2, trail: 0.4, dust: 0 },
  grenade: { muzzle: 0, puff: 0, tracer: 0, proj: 3, trail: 0, dust: 0 },
  demo_charge: { muzzle: 0, puff: 0, tracer: 0, proj: 0, trail: 0, dust: 0 },
};

function wreckKindOf(cat: string): WreckKind {
  switch (cat) {
    case 'tank': return 'tank';
    case 'ifv': return 'ifv';
    case 'recon': return 'recon';
    case 'artillery': return 'artillery';
    case 'aa': return 'aa';
    case 'helicopter': return 'heli';
    case 'jet': return 'jet';
    case 'drone': return 'drone';
    case 'naval': return 'naval';
    default: return 'support';
  }
}

// ================================================================ Kamerawackeln
export class CameraShake {
  private trauma = 0;
  private t = 0;
  private fx = 0;
  private fz = 0;
  private dist = 100;
  private viewOk = false;
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();

  /** Von Effects.update gesetzt (Bodenpunkt, auf den die Kamera blickt, und Abstand) */
  setView(fx: number, fz: number, dist: number): void {
    this.fx = fx; this.fz = fz; this.dist = dist; this.viewOk = true;
  }

  private measure(camera: THREE.PerspectiveCamera): void {
    camera.updateMatrixWorld();
    camera.getWorldDirection(this.dir);
    const cy = camera.position.y;
    const dist = this.dir.y < -0.05 ? Math.max(0.5, cy / -this.dir.y) : Math.max(0.5, cy);
    this.fx = camera.position.x + this.dir.x * dist;
    this.fz = camera.position.z + this.dir.z * dist;
    this.dist = dist;
    this.viewOk = true;
  }

  /** magnitude 0..1 (1 = riesige Explosion direkt im Bild). Fällt mit Abstand zum Blickpunkt und beim Herauszoomen ab. */
  add(x: number, z: number, magnitude: number, camera?: THREE.PerspectiveCamera): void {
    if (camera) this.measure(camera);
    if (!this.viewOk) return;
    const ext = Math.max(0.4, this.dist * 0.75);
    const d = Math.hypot(x - this.fx, z - this.fz) / ext;
    const att = 1 / (1 + d * d * 1.5);
    const zoomAtt = 1 - smooth(60, 900, this.dist) * 0.9;
    this.trauma = Math.min(1, this.trauma + magnitude * att * zoomAtt);
  }

  /** Nach RTSCamera.update und vor dem Rendern aufrufen. */
  apply(camera: THREE.PerspectiveCamera, dt: number): void {
    this.measure(camera);
    if (this.trauma <= 0.002) { this.trauma = 0; return; }
    dt = Math.min(dt, 0.1);
    this.t += dt;
    const s = this.trauma * this.trauma;
    const amp = s * this.dist * 0.022;
    const t = this.t;
    const ox = (Math.sin(t * 41.3) + 0.6 * Math.sin(t * 77.1 + 1.3)) * 0.6;
    const oy = (Math.sin(t * 37.7 + 2.1) + 0.6 * Math.sin(t * 91.7)) * 0.6;
    this.right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    this.up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    camera.position.addScaledVector(this.right, ox * amp).addScaledVector(this.up, oy * amp);
    camera.updateMatrixWorld();
    this.trauma = Math.max(0, this.trauma - dt * 1.5);
  }
}

// ================================================================ Effects
interface Emitter {
  on: boolean;
  kind: number; // 0 Flammen, 1 Säule, 2 dünner Rauch, 3 Staub, 4 Wrack
  x: number; y: number; z: number;
  age: number; dur: number;
  rate: number; rad: number; size: number;
  acc: number;
  flameDur: number;
}

const DELAY_EXPLODE = 0;
const DELAY_DUST = 1;

export class Effects {
  readonly object = new THREE.Group();
  readonly shake = new CameraShake();
  readonly smoke: SmokeQuery;

  private readonly geo: GeoData;
  private exag: number;
  private clock = 0;
  private camDist = 100;
  private visScale = VIS_MIN;
  private lift = 0.002;
  private readonly camPos = new THREE.Vector3();
  private readonly camDir = new THREE.Vector3();
  private readonly projView = new THREE.Matrix4();
  private readonly frustum = new THREE.Frustum();
  private readonly sphere = new THREE.Sphere();
  private haveView = false;
  private focusX = 0;
  private focusZ = 0;

  private readonly particles = new Particles();
  private readonly craters: DecalLayer;
  private readonly rings: DecalLayer;
  private readonly ribbons = new RibbonLayer();
  private readonly decalUniforms: Record<string, THREE.IUniform> = {
    uVis: { value: VIS_MIN },
    uTime: { value: 0 },
    uLift: { value: 0.002 },
  };

  // Projektile
  private readonly pActive = new Uint8Array(PROJ_CAP);
  private readonly pKind = new Uint8Array(PROJ_CAP);
  private readonly pW = new Uint8Array(PROJ_CAP);
  private readonly pT0 = new Float32Array(PROJ_CAP);
  private readonly pDur = new Float32Array(PROJ_CAP);
  private readonly pFrom = new Float32Array(PROJ_CAP * 3);
  private readonly pTo = new Float32Array(PROJ_CAP * 3);
  private readonly pApex = new Float32Array(PROJ_CAP);
  private readonly pPrev = new Float32Array(PROJ_CAP * 3);
  private readonly pTrail = new Float32Array(PROJ_CAP);
  private readonly pAcc = new Float32Array(PROJ_CAP);
  private pHead = 0;
  private readonly weaponList: WeaponKind[] = Object.keys(W) as WeaponKind[];

  // Emitter
  private readonly em: Emitter[] = [];
  private emHead = 0;

  // Rauchwolken (LOS)
  private readonly cx = new Float32Array(CLOUD_CAP);
  private readonly cz = new Float32Array(CLOUD_CAP);
  private readonly cr = new Float32Array(CLOUD_CAP);
  private readonly cd = new Float32Array(CLOUD_CAP);
  private readonly c0 = new Float32Array(CLOUD_CAP);
  private readonly c1 = new Float32Array(CLOUD_CAP);
  private cHead = 0;
  private cCount = 0;

  // Verzögerte Ereignisse
  private readonly dT = new Float32Array(DELAY_CAP);
  private readonly dKind = new Uint8Array(DELAY_CAP);
  private readonly dA = new Float32Array(DELAY_CAP * 4);
  private dCount = 0;

  // Trümmer
  private readonly debris: THREE.InstancedMesh;
  private readonly dbOrg = new Float32Array(DEBRIS_CAP * 3);
  private readonly dbPos = new Float32Array(DEBRIS_CAP * 3);
  private readonly dbVel = new Float32Array(DEBRIS_CAP * 3);
  private readonly dbRot = new Float32Array(DEBRIS_CAP * 3);
  private readonly dbSpin = new Float32Array(DEBRIS_CAP * 3);
  private readonly dbSize = new Float32Array(DEBRIS_CAP * 3);
  private readonly dbAge = new Float32Array(DEBRIS_CAP);
  private readonly dbLife = new Float32Array(DEBRIS_CAP);
  private readonly dbFloor = new Float32Array(DEBRIS_CAP);
  private readonly dbBounce = new Uint8Array(DEBRIS_CAP);
  private dbHead = 0;
  private dbHi = 0;

  // Wracks
  private readonly wreckMeshes = new Map<WreckKind, THREE.InstancedMesh>();
  private readonly wreckHead = new Map<WreckKind, number>();
  private readonly wreckCount = new Map<WreckKind, number>();
  private readonly wreckData = new Map<WreckKind, Float32Array>(); // x,y,z,heading,tiltX,tiltZ per Instanz (6)
  private lastWreckScale = -1;

  // Beschädigte Einheiten
  private dmgCursor = 0;

  // Brücken (für Reparatur)
  private readonly bridgeMid = new Map<number, [number, number]>();

  // temporär
  private readonly _m = new THREE.Matrix4();
  private readonly _q = new THREE.Quaternion();
  private readonly _e = new THREE.Euler();
  private readonly _p = new THREE.Vector3();
  private readonly _s = new THREE.Vector3();
  private readonly _c = new THREE.Color();

  constructor(geo: GeoData, settings: Settings) {
    this.geo = geo;
    this.exag = settings.heightExaggeration;
    this.object.name = 'Effects';

    const self = this;
    this.smoke = {
      densityAt(x: number, z: number): number {
        return self.smokeDensity(x, z);
      },
    };

    this.craters = new DecalLayer(DECAL_CAP, 2, this.decalUniforms);
    this.rings = new DecalLayer(RING_CAP, 3, this.decalUniforms);
    this.craters.mesh.name = 'FxCraters';
    this.rings.mesh.name = 'FxRings';

    // Trümmer-InstancedMesh
    const dm = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
    this.debris = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), dm, DEBRIS_CAP);
    this.debris.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.debris.count = 0;
    this.debris.frustumCulled = false;
    this.debris.setColorAt(0, this._c.set(0x333333));
    this.debris.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    this.debris.renderOrder = 4;
    this.debris.name = 'FxDebris';

    // Wracks
    const wm = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    for (const kind of Object.keys(WRECK_CAP) as WreckKind[]) {
      const cap = WRECK_CAP[kind];
      const mesh = new THREE.InstancedMesh(wreckGeometry(kind), wm, cap);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.setColorAt(0, this._c.set(0xffffff));
      mesh.name = `FxWreck_${kind}`;
      this.wreckMeshes.set(kind, mesh);
      this.wreckHead.set(kind, 0);
      this.wreckCount.set(kind, 0);
      this.wreckData.set(kind, new Float32Array(cap * 6));
      this.object.add(mesh);
    }

    for (let i = 0; i < EMITTER_CAP; i++) this.em.push({ on: false, kind: 0, x: 0, y: 0, z: 0, age: 0, dur: 0, rate: 0, rad: 1, size: 1, acc: 0, flameDur: 0 });

    this.object.add(this.craters.mesh, this.rings.mesh, this.debris, this.particles.mesh, this.ribbons.mesh);

    this.subscribe();
  }

  applySettings(s: Settings): void {
    this.exag = s.heightExaggeration;
  }

  /** Anzahl lebender Partikel (Debug/Performance) */
  get particleCount(): number {
    return this.particles.alive;
  }

  // ------------------------------------------------------------ Hilfen
  private ground(x: number, z: number): number {
    return Math.max(0, this.geo.heightAt(x, z)) * this.exag;
  }

  private isWater(x: number, z: number): boolean {
    return this.geo.heightAt(x, z) < 0.0005;
  }

  /** Detailfaktor nach Kameraabstand */
  private detail(): number {
    const d = this.camDist;
    return d < 60 ? 1 : d < 200 ? 0.75 : d < 500 ? 0.5 : d < 1000 ? 0.3 : 0.15;
  }

  private inView(x: number, y: number, z: number, radiusKm: number): boolean {
    if (!this.haveView) return true;
    this.sphere.center.set(x, y, z);
    this.sphere.radius = radiusKm + this.camDist * 0.05;
    return this.frustum.intersectsSphere(this.sphere);
  }

  private count(n: number, min = 1): number {
    return Math.max(min, Math.round(n * this.detail()));
  }

  // ------------------------------------------------------------ Partikel-Kurzformen
  private fireP(ox: number, oy: number, oz: number, lx: number, ly: number, lz: number, vx: number, vy: number, vz: number, size: number, grow: number, life: number, a = 0.8, sc = 1): void {
    this.particles.add(ox, oy, oz, lx, ly, lz, vx, vy, vz, size, grow, life, RAMP_FIRE, 1, 1, 1, a, -1.5, 0.6, SHAPE_BLOB, sc, rr(-1.5, 1.5));
  }
  private smokeP(ox: number, oy: number, oz: number, lx: number, ly: number, lz: number, vx: number, vy: number, vz: number, size: number, grow: number, life: number, shade: number, a = 0.8, sc = 1, warm = 0): void {
    const k = shade;
    this.particles.add(ox, oy, oz, lx, ly, lz, vx, vy, vz, size, grow, life, RAMP_SMOKE, k * (1 + warm), k * (1 + warm * 0.2), k * (1 - warm * 0.3), a, -0.15, 0.5, SHAPE_BLOB, sc, rr(-0.6, 0.6));
  }
  private dirtP(ox: number, oy: number, oz: number, lx: number, ly: number, lz: number, vx: number, vy: number, vz: number, size: number, life: number, r: number, g: number, b: number, a: number, grav: number, drag = 0.25, shape = SHAPE_BLOB, sc = 1): void {
    this.particles.add(ox, oy, oz, lx, ly, lz, vx, vy, vz, size, size * 0.25, life, RAMP_DIRT, r, g, b, a, grav, drag, shape, sc, rr(-2, 2));
  }
  private sparkP(ox: number, oy: number, oz: number, lx: number, ly: number, lz: number, vx: number, vy: number, vz: number, size: number, life: number, grav = 14): void {
    this.particles.add(ox, oy, oz, lx, ly, lz, vx, vy, vz, size, 0, life, RAMP_SPARK, 1, 1, 1, 1, grav, 0.2, SHAPE_CHIP, 1, rr(-8, 8));
  }
  private flashP(ox: number, oy: number, oz: number, lx: number, ly: number, lz: number, size: number, life: number, r: number, g: number, b: number, a: number, sc = 1): void {
    this.particles.add(ox, oy, oz, lx, ly, lz, 0, 0, 0, size, size * 0.6, life, RAMP_FLASH, r, g, b, a, 0, 0, SHAPE_GLOW, sc, 0);
  }

  // ------------------------------------------------------------ Rauchregister
  private addCloud(x: number, z: number, rKm: number, dens: number, dur: number): void {
    const i = this.cHead;
    this.cHead = (this.cHead + 1) % CLOUD_CAP;
    if (i >= this.cCount) this.cCount = i + 1;
    this.cx[i] = x; this.cz[i] = z; this.cr[i] = rKm; this.cd[i] = dens; this.c0[i] = this.clock; this.c1[i] = this.clock + dur;
  }

  private smokeDensity(x: number, z: number): number {
    const now = this.clock;
    let tot = 0;
    for (let i = 0; i < this.cCount; i++) {
      if (now >= this.c1[i]) continue;
      const dx = x - this.cx[i], dz = z - this.cz[i];
      const r = this.cr[i];
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      const span = this.c1[i] - this.c0[i];
      const fin = Math.min(1, (now - this.c0[i]) / 2);
      const fout = Math.min(1, (this.c1[i] - now) / Math.max(1, span * 0.25));
      const d = this.cd[i] * fin * fout * (1 - 0.6 * Math.sqrt(d2) / r);
      tot = 1 - (1 - tot) * (1 - d);
    }
    return tot;
  }

  // ------------------------------------------------------------ Emitter
  private addEmitter(kind: number, x: number, y: number, z: number, dur: number, rate: number, rad: number, size: number, flameDur = 0): void {
    // freien Slot suchen, sonst ältesten überschreiben
    let idx = -1;
    for (let k = 0; k < EMITTER_CAP; k++) {
      const j = (this.emHead + k) % EMITTER_CAP;
      if (!this.em[j].on) { idx = j; break; }
    }
    if (idx < 0) idx = this.emHead;
    this.emHead = (idx + 1) % EMITTER_CAP;
    const e = this.em[idx];
    e.on = true; e.kind = kind; e.x = x; e.y = y; e.z = z; e.age = 0; e.dur = dur; e.rate = rate; e.rad = rad; e.size = size; e.acc = 0; e.flameDur = flameDur;
  }

  private updateEmitters(dt: number): void {
    const far = this.camDist > FAR_SKIP;
    const det = this.detail();
    for (let i = 0; i < EMITTER_CAP; i++) {
      const e = this.em[i];
      if (!e.on) continue;
      e.age += dt;
      if (e.age >= e.dur) { e.on = false; continue; }
      if (!this.inView(e.x, e.y, e.z, 0.05)) continue;
      const k = 1 - e.age / e.dur;
      let n: number;
      switch (e.kind) {
        case 0: { // Flammen + Rauch
          e.acc += e.rate * dt * det * (0.4 + 0.6 * k);
          n = Math.floor(e.acc); e.acc -= n;
          for (let j = 0; j < n; j++) {
            const a = rnd() * 6.283, d = Math.sqrt(rnd()) * e.rad;
            const lx = Math.cos(a) * d, lz = Math.sin(a) * d;
            if (rnd() < 0.6) this.fireP(e.x, e.y, e.z, lx, 0.3, lz, rr(-0.5, 0.5), rr(2.5, 5.5), rr(-0.5, 0.5), e.size * rr(0.5, 1), e.size * 0.2, rr(0.5, 1.0), 0.65);
            else this.smokeP(e.x, e.y, e.z, lx, e.size * 0.6, lz, rr(-0.5, 0.5), rr(2, 4), rr(-0.5, 0.5), e.size * rr(0.6, 1.0), e.size * 0.3, rr(2.5, 4.5), 0.13, 0.7);
          }
          break;
        }
        case 1: { // dunkle Rauchsäule
          e.acc += e.rate * dt * det;
          n = Math.floor(e.acc); e.acc -= n;
          for (let j = 0; j < n; j++) {
            const a = rnd() * 6.283, d = Math.sqrt(rnd()) * e.rad * 0.5;
            const sh = rr(0.1, 0.19) * (0.6 + 0.4 * k);
            this.smokeP(e.x, e.y, e.z, Math.cos(a) * d, rr(0, 2), Math.sin(a) * d, rr(-0.4, 0.4), e.size * rr(0.35, 0.6), rr(-0.4, 0.4), e.size * rr(0.5, 0.8), e.size * 0.18, rr(7, 12) * (0.5 + 0.5 * k), sh, 0.75 * (0.45 + 0.55 * k));
          }
          break;
        }
        case 2: { // dünner grauer Rauch
          e.acc += e.rate * dt * det;
          n = Math.floor(e.acc); e.acc -= n;
          for (let j = 0; j < n; j++) this.smokeP(e.x, e.y, e.z, rr(-1, 1) * e.rad, 0.5, rr(-1, 1) * e.rad, rr(-0.3, 0.3), rr(1.5, 3) , rr(-0.3, 0.3), e.size * rr(0.6, 1), e.size * 0.2, rr(3, 6), 0.3, 0.45);
          break;
        }
        case 3: { // Staub
          e.acc += e.rate * dt * det;
          n = Math.floor(e.acc); e.acc -= n;
          for (let j = 0; j < n; j++) this.smokeP(e.x, e.y, e.z, rr(-1, 1) * e.rad, 0.5, rr(-1, 1) * e.rad, rr(-1, 1), rr(0.3, 1.2), rr(-1, 1), e.size * rr(0.6, 1), e.size * 0.35, rr(3, 5), 0.52, 0.45, 0.12);
          break;
        }
        case 6: { // Rauchgranate: dicker weißer Rauch (schwächer skaliert)
          e.acc += e.rate * dt * det;
          n = Math.floor(e.acc); e.acc -= n;
          for (let j = 0; j < n; j++) {
            const a = rnd() * 6.283, d = Math.sqrt(rnd()) * e.rad;
            this.smokeP(e.x, e.y, e.z, Math.cos(a) * d, rr(0.5, 4), Math.sin(a) * d, rr(-1, 1), rr(0.5, 2), rr(-1, 1), e.size * rr(0.6, 1.0), e.size * 0.05, rr(7, 12), rr(0.62, 0.8), 0.8 * Math.min(1, k * 3), 0.32);
          }
          break;
        }
        default: { // Wrack: Flammen -> schwerer Rauch -> dünner Rauch/Glut
          const fl = e.age < e.flameDur;
          const heavy = e.age < e.dur * 0.4;
          e.acc += (fl ? e.rate : heavy ? e.rate * 0.6 : e.rate * 0.25) * dt * det;
          n = Math.floor(e.acc); e.acc -= n;
          for (let j = 0; j < n; j++) {
            const lx = rr(-1, 1) * e.rad, lz = rr(-1, 1) * e.rad;
            if (fl && rnd() < 0.45) this.fireP(e.x, e.y, e.z, lx, 1.2, lz, rr(-0.4, 0.4), rr(2.5, 5), rr(-0.4, 0.4), e.size * rr(0.35, 0.6), e.size * 0.15, rr(0.45, 0.9), 0.6);
            else if (heavy) this.smokeP(e.x, e.y, e.z, lx, 2, lz, rr(-0.3, 0.3), rr(2.5, 4.5), rr(-0.3, 0.3), e.size * rr(0.5, 0.8), e.size * 0.22, rr(4, 7), rr(0.1, 0.17), 0.7);
            else if (rnd() < 0.2) this.particles.add(e.x, e.y, e.z, lx, 1.4, lz, 0, 0.4, 0, e.size * 0.12, 0, rr(0.8, 1.6), RAMP_EMBER, 1, 0.5, 0.15, 0.9, 0, 0, SHAPE_CHIP, 1, 0);
            else this.smokeP(e.x, e.y, e.z, lx, 1.5, lz, rr(-0.3, 0.3), rr(1.2, 2.5), rr(-0.3, 0.3), e.size * rr(0.35, 0.6), e.size * 0.15, rr(4, 7), 0.28, 0.4);
          }
        }
      }
      if (far) e.acc = 0;
    }
  }

  // ------------------------------------------------------------ Trümmer
  private addDebris(ox: number, oy: number, oz: number, lx: number, ly: number, lz: number, vx: number, vy: number, vz: number, sx: number, sy: number, sz: number, life: number, floorM: number, color: number): void {
    const i = this.dbHead;
    this.dbHead = (this.dbHead + 1) % DEBRIS_CAP;
    if (i >= this.dbHi) this.dbHi = i + 1;
    const o = i * 3;
    this.dbOrg[o] = ox; this.dbOrg[o + 1] = oy; this.dbOrg[o + 2] = oz;
    this.dbPos[o] = lx; this.dbPos[o + 1] = ly; this.dbPos[o + 2] = lz;
    this.dbVel[o] = vx; this.dbVel[o + 1] = vy; this.dbVel[o + 2] = vz;
    this.dbRot[o] = rnd() * 6; this.dbRot[o + 1] = rnd() * 6; this.dbRot[o + 2] = rnd() * 6;
    this.dbSpin[o] = rr(-9, 9); this.dbSpin[o + 1] = rr(-9, 9); this.dbSpin[o + 2] = rr(-9, 9);
    this.dbSize[o] = sx; this.dbSize[o + 1] = sy; this.dbSize[o + 2] = sz;
    this.dbAge[i] = 0; this.dbLife[i] = life; this.dbFloor[i] = floorM; this.dbBounce[i] = 0;
    this._c.setHex(color);
    const ic = this.debris.instanceColor!;
    const k = rr(0.75, 1.15);
    ic.setXYZ(i, this._c.r * k, this._c.g * k, this._c.b * k);
    ic.needsUpdate = true;
  }

  private updateDebris(dt: number): void {
    const hi = this.dbHi;
    const K = 0.001 * Math.pow(this.visScale, EFFECT_SC);
    let n = 0;
    for (let i = 0; i < hi; i++) {
      const life = this.dbLife[i];
      if (life <= 0) { this.writeZero(i); continue; }
      const age = this.dbAge[i] + dt;
      if (age >= life) { this.dbLife[i] = 0; this.writeZero(i); continue; }
      this.dbAge[i] = age;
      const o = i * 3;
      let vy = this.dbVel[o + 1] - 13 * dt;
      let py = this.dbPos[o + 1] + vy * dt;
      const fl = this.dbFloor[i];
      if (py < fl) {
        py = fl;
        if (this.dbBounce[i] === 0 && vy < -2) {
          this.dbBounce[i] = 1;
          vy = -vy * 0.32;
          this.dbVel[o] *= 0.5; this.dbVel[o + 2] *= 0.5;
          for (let k = 0; k < 3; k++) this.dbSpin[o + k] *= 0.5;
        } else {
          vy = 0;
          this.dbVel[o] *= 0.8; this.dbVel[o + 2] *= 0.8;
          for (let k = 0; k < 3; k++) this.dbSpin[o + k] *= 0.5;
        }
      }
      this.dbVel[o + 1] = vy;
      this.dbPos[o] += this.dbVel[o] * dt; this.dbPos[o + 1] = py; this.dbPos[o + 2] += this.dbVel[o + 2] * dt;
      for (let k = 0; k < 3; k++) this.dbRot[o + k] += this.dbSpin[o + k] * dt;
      const t = age / life;
      const shrink = 1 - smooth(0.8, 1, t);
      this._p.set(this.dbOrg[o] + this.dbPos[o] * K, this.dbOrg[o + 1] + py * K, this.dbOrg[o + 2] + this.dbPos[o + 2] * K);
      this._e.set(this.dbRot[o], this.dbRot[o + 1], this.dbRot[o + 2]);
      this._q.setFromEuler(this._e);
      const sk = K * shrink;
      this._s.set(this.dbSize[o] * sk, this.dbSize[o + 1] * sk, this.dbSize[o + 2] * sk);
      this._m.compose(this._p, this._q, this._s);
      this.debris.setMatrixAt(i, this._m);
      n++;
    }
    let h = hi;
    while (h > 0 && this.dbLife[h - 1] <= 0) h--;
    if (h < this.dbHi && this.dbHead < h) this.dbHi = h;
    this.debris.count = this.dbHi;
    this.debris.visible = this.dbHi > 0 && n >= 0;
    if (this.dbHi > 0) this.debris.instanceMatrix.needsUpdate = true;
  }

  private writeZero(i: number): void {
    this._s.set(0, 0, 0);
    this._p.set(0, -1000, 0);
    this._q.identity();
    this._m.compose(this._p, this._q, this._s);
    this.debris.setMatrixAt(i, this._m);
  }

  // ------------------------------------------------------------ Verzögerte Ereignisse
  private schedule(delay: number, kind: number, a: number, b: number, c: number, d: number): void {
    if (this.dCount >= DELAY_CAP) return;
    const i = this.dCount++;
    this.dT[i] = this.clock + delay;
    this.dKind[i] = kind;
    this.dA[i * 4] = a; this.dA[i * 4 + 1] = b; this.dA[i * 4 + 2] = c; this.dA[i * 4 + 3] = d;
  }

  private runDelayed(): void {
    for (let i = 0; i < this.dCount; ) {
      if (this.clock >= this.dT[i]) {
        const a = this.dA[i * 4], b = this.dA[i * 4 + 1], c = this.dA[i * 4 + 2], d = this.dA[i * 4 + 3];
        const kind = this.dKind[i];
        // Eintrag entfernen (Swap mit letztem)
        const last = --this.dCount;
        this.dT[i] = this.dT[last]; this.dKind[i] = this.dKind[last];
        for (let k = 0; k < 4; k++) this.dA[i * 4 + k] = this.dA[last * 4 + k];
        if (kind === DELAY_EXPLODE) this.explode(a, this.ground(a, c) + b, c, d | 0, false, false);
        else if (kind === DELAY_DUST) this.dustCloud(a, b, c, d);
      } else i++;
    }
  }

  // ------------------------------------------------------------ Ereignisse
  private subscribe(): void {
    bus.on('combat:fire', (e) => this.onFire(e));
    bus.on('combat:impact', (e) => this.onImpact(e.weapon, e.x, e.y, e.z, e.surface, e.radiusKm));
    bus.on('combat:explosion', (e) => this.explode(e.x, e.y, e.z, SIZE_IDX[e.size] ?? 1, e.fire, true));
    bus.on('wreck:spawn', (e) => this.spawnWreck(e.x, e.y, e.z, e.heading, e.category));
    bus.on('smoke:spawn', (e) => this.smokeScreen(e.x, e.z, e.radiusKm, e.durationSec, e.density));
    bus.on('building:destroyed', (e) => this.buildingCollapse(e.x, e.y, e.z));
    bus.on('bridge:destroyed', (e) => this.bridgeCollapse(e.edgeId, e.geom));
    bus.on('bridge:repaired', (e) => this.bridgeRepaired(e.edgeId));
  }

  // ---- combat:fire
  private onFire(e: { weapon: WeaponKind; fx: number; fy: number; fz: number; tx: number; ty: number; tz: number; flightSec: number; indirect: boolean }): void {
    const w = W[e.weapon];
    if (!w) return;
    const det = this.detail();
    const dx = e.tx - e.fx, dy = e.ty - e.fy, dz = e.tz - e.fz;
    const dist = Math.hypot(dx, dy, dz);
    const flight = e.flightSec;
    const show = this.camDist < FAR_SKIP;

    // Mündungsfeuer + Rauch (nur im Bild)
    if (show && w.muzzle > 0 && this.inView(e.fx, e.fy, e.fz, 0.05) && (det >= 0.5 || rnd() < det * 2)) {
      const m = w.muzzle;
      const inv = dist > 1e-6 ? 1 / dist : 0;
      const ux = dx * inv, uz = dz * inv;
      const oy = e.fy;
      // Flash leicht nach vorn in Schussrichtung versetzt (m)
      const fwd = m * 0.8;
      this.flashP(e.fx, oy, e.fz, ux * fwd, 1.2, uz * fwd, m * 1.8, 0.07 + m * 0.01, 1, 0.85, 0.45, 0.95);
      this.fireP(e.fx, oy, e.fz, ux * fwd, 1.2, uz * fwd, ux * m * 4, 0.5, uz * m * 4, m * 0.7, m * 1.5, 0.12 + m * 0.02, 0.9);
      if (w.puff > 0) {
        const n = Math.max(1, Math.round((w.puff > 3 ? 4 : 2) * det));
        for (let i = 0; i < n; i++) this.smokeP(e.fx, oy, e.fz, ux * fwd, 1.2, uz * fwd, ux * w.puff * rr(1, 3) + rr(-0.5, 0.5), rr(0.3, 1.2), uz * w.puff * rr(1, 3) + rr(-0.5, 0.5), w.puff * rr(0.4, 0.7), w.puff * 0.5, rr(1.5, 3.2), 0.5, 0.6);
      }
      if (w.dust > 0) this.launchDust(e.fx, oy, e.fz, w.dust, ux, uz);
      if (m >= 3) this.sparkBurst(e.fx, oy, e.fz, ux * fwd, 1.2, uz * fwd, 3 + (m >= 5 ? 3 : 0), 8);
    }

    // Tracer (Kleinwaffen + Kanonen)
    if (w.tracer > 0 && dist > 1e-5) {
      const travel = flight > 0.01 ? Math.min(flight, 1.2) : clamp(dist / 2.2, 0.05, 0.4);
      const lenFrac = clamp((0.012 * this.visScale) / dist, 0.05, 0.45);
      const tr = e.weapon === 'tank_gun' || e.weapon === 'naval_gun' ? 1 : 1;
      this.ribbons.add(e.fx, e.fy + 0.0008 * this.visScale, e.fz, e.tx, e.ty, e.tz, this.clock, travel, lenFrac, tr, 0.78, 0.3, w.tracer);
    }

    // Projektile mit Eigenleben (Rakete, ballistisch, Bombe, Torpedo)
    if (w.proj !== 0 && flight > 0.12 && dist > 1e-5) {
      let kind: number = w.proj;
      if (kind === 3 && !e.indirect && e.weapon !== 'grenade') kind = 2;
      this.spawnProjectile(e, kind, flight, dist, e.weapon);
    } else if (w.proj === 1 && dist > 1e-5) {
      // schneller Schuss: dicker Tracer
      const travel = clamp(dist / 3.5, 0.05, 0.3);
      this.ribbons.add(e.fx, e.fy + 0.0008 * this.visScale, e.fz, e.tx, e.ty, e.tz, this.clock, travel, clamp((0.02 * this.visScale) / dist, 0.06, 0.5), 1, 0.85, 0.45, 3.5);
    }
  }

  private spawnProjectile(e: { fx: number; fy: number; fz: number; tx: number; ty: number; tz: number }, kind: number, flight: number, dist: number, weapon: WeaponKind): void {
    const i = this.pHead;
    this.pHead = (this.pHead + 1) % PROJ_CAP;
    this.pActive[i] = 1;
    this.pKind[i] = kind;
    this.pW[i] = this.weaponList.indexOf(weapon);
    this.pT0[i] = this.clock;
    this.pDur[i] = flight;
    const o = i * 3;
    this.pFrom[o] = e.fx; this.pFrom[o + 1] = e.fy; this.pFrom[o + 2] = e.fz;
    this.pTo[o] = e.tx; this.pTo[o + 1] = e.ty; this.pTo[o + 2] = e.tz;
    this.pPrev[o] = e.fx; this.pPrev[o + 1] = e.fy; this.pPrev[o + 2] = e.fz;
    // Scheitelhöhe (km): Mörser/Haubitze hoch, Raketenartillerie flacher; Lenkwaffen leichter Bogen
    let apex = 0;
    if (kind === 3) apex = weapon === 'mortar' ? dist * 0.42 : weapon === 'rocket_arty' ? dist * 0.28 : weapon === 'grenade' ? 0.01 : dist * 0.34;
    else if (kind === 2) apex = weapon === 'antiship_missile' ? 0 : dist * 0.03;
    this.pApex[i] = apex;
    this.pTrail[i] = W[weapon].trail;
    this.pAcc[i] = 0;
  }

  private updateProjectiles(dt: number): void {
    const show = this.camDist < FAR_SKIP;
    for (let i = 0; i < PROJ_CAP; i++) {
      if (!this.pActive[i]) continue;
      const t = (this.clock - this.pT0[i]) / this.pDur[i];
      if (t >= 1) { this.pActive[i] = 0; continue; }
      const o = i * 3;
      const kind = this.pKind[i];
      const fx = this.pFrom[o], fy = this.pFrom[o + 1], fz = this.pFrom[o + 2];
      const tx = this.pTo[o], ty = this.pTo[o + 1], tz = this.pTo[o + 2];
      let x = fx + (tx - fx) * t, y = fy + (ty - fy) * t, z = fz + (tz - fz) * t;
      if (kind === 3 || kind === 2) y += 4 * this.pApex[i] * t * (1 - t);
      else if (kind === 4) y = fy + (ty - fy) * t * t;
      else if (kind === 5) y = Math.min(0.0003, y);
      const px = this.pPrev[o], py = this.pPrev[o + 1], pz = this.pPrev[o + 2];
      this.pPrev[o] = x; this.pPrev[o + 1] = y; this.pPrev[o + 2] = z;
      if (!show) continue;
      if (!this.inView(x, y, z, 0.1)) continue;
      const trail = this.pTrail[i];
      const det = this.detail();
      if (kind === 2) {
        this.flashP(x, y, z, 0, 0, 0, 1.6, 0.06, 1, 0.8, 0.4, 0.95);
      } else if (kind === 3) {
        this.particles.add(x, y, z, 0, 0, 0, 0, 0, 0, 0.9, 0, 0.09, RAMP_FLASH, 0.9, 0.85, 0.7, 0.9, 0, 0, SHAPE_CHIP, 1, 0);
      } else if (kind === 4) {
        this.particles.add(x, y, z, 0, 0, 0, 0, 0, 0, 1.1, 0, 0.09, RAMP_DIRT, 0.12, 0.12, 0.11, 1, 0, 0, SHAPE_CHIP, 1, 0);
      }
      // Rauchspur (interpoliert, damit sie bei hoher Geschwindigkeit nicht reißt)
      if (trail > 0 && kind !== 5) {
        const rate = 55 * det;
        this.pAcc[i] += rate * dt;
        const n = Math.min(8, Math.floor(this.pAcc[i]));
        this.pAcc[i] -= n;
        for (let k = 0; k < n; k++) {
          const f = (k + 1) / n;
          const qx = px + (x - px) * f, qy = py + (y - py) * f, qz = pz + (z - pz) * f;
          this.smokeP(qx, qy, qz, 0, 0, 0, rr(-0.4, 0.4), rr(0.2, 0.8), rr(-0.4, 0.4), trail * rr(0.7, 1.1), trail * 0.9, rr(2.2, 3.6), 0.78, 0.7);
        }
      } else if (kind === 5) {
        // Torpedo-Kielwasser: Schaumbahn
        this.pAcc[i] += 30 * det * dt;
        const n = Math.min(6, Math.floor(this.pAcc[i]));
        this.pAcc[i] -= n;
        for (let k = 0; k < n; k++) {
          const f = (k + 1) / n;
          this.dirtP(px + (x - px) * f, 0.0002, pz + (z - pz) * f, 0, 0.3, 0, rr(-0.5, 0.5), 0.1, rr(-0.5, 0.5), 1.3, 2.4, 0.85, 0.92, 0.95, 0.55, 0, 0.5);
        }
      }
    }
  }

  private launchDust(x: number, y: number, z: number, size: number, ux: number, uz: number): void {
    const n = this.count(8 + size * 1.5, 3);
    const water = this.isWater(x, z);
    for (let i = 0; i < n; i++) {
      const a = rnd() * 6.283, sp = size * rr(1, 2.4);
      this.smokeP(x, y, z, Math.cos(a) * size * 0.3 - ux * size * 0.5, 0.5, Math.sin(a) * size * 0.3 - uz * size * 0.5, Math.cos(a) * sp, rr(0.2, 1.2), Math.sin(a) * sp, size * rr(0.25, 0.45), size * 0.5, rr(1.2, 2.4), water ? 0.8 : 0.5, 0.5, 0.5, water ? 0 : 0.15);
    }
  }

  private sparkBurst(ox: number, oy: number, oz: number, lx: number, ly: number, lz: number, n: number, sp: number): void {
    n = this.count(n, 1);
    for (let i = 0; i < n; i++) this.sparkP(ox, oy, oz, lx, ly, lz, rr(-1, 1) * sp, rr(0.5, 1) * sp, rr(-1, 1) * sp, 0.3, rr(0.3, 0.7));
  }

  // ---- combat:impact
  private onImpact(weapon: WeaponKind, x: number, y: number, z: number, surface: ImpactSurface, radiusKm: number): void {
    if (this.camDist > FAR_SKIP * 0.6) return;
    if (!this.inView(x, y, z, 0.05)) return;
    const rm = clamp(radiusKm * 1000, 1.2, 40);
    const det = this.detail();
    const small = rm < 3;
    if (small && rnd() > Math.min(1, det * 1.5)) return;
    const oy = Math.max(0, y);
    switch (surface) {
      case 'ground': {
        const nd = this.count(small ? 2 : 4 + rm * 1.3, 1);
        for (let i = 0; i < nd; i++) {
          const a = rnd() * 6.283, hs = rm * rr(0.2, 0.9);
          this.dirtP(x, oy, z, 0, 0.3, 0, Math.cos(a) * hs, rr(4, 11) * Math.sqrt(rm / 3 + 0.3), Math.sin(a) * hs, Math.max(0.35, rm * 0.13), rr(1, 2.2), 0.3, 0.23, 0.15, 0.95, 13, 0.1, rnd() < 0.5 ? SHAPE_CHIP : SHAPE_BLOB);
        }
        const nu = this.count(small ? 1 : 2 + rm * 0.5, 1);
        for (let i = 0; i < nu; i++) this.smokeP(x, oy, z, rr(-1, 1) * rm * 0.3, 0.3, rr(-1, 1) * rm * 0.3, rr(-1, 1), rr(0.5, 2), rr(-1, 1), rm * rr(0.35, 0.6) + 0.5, rm * 0.4, rr(1.4, 2.8), 0.5, 0.5, 1, 0.12);
        if (rm >= 3) this.flashP(x, oy, z, 0, 1, 0, rm * 0.8, 0.08, 1, 0.8, 0.4, 0.6);
        break;
      }
      case 'water': {
        const n = this.count(6 + rm * 1.2, 3);
        for (let i = 0; i < n; i++) {
          const a = rnd() * 6.283, hs = rm * rr(0.05, 0.35);
          this.dirtP(x, 0.0002, z, 0, 0.2, 0, Math.cos(a) * hs, rr(5, 14) * Math.sqrt(rm / 3 + 0.4), Math.sin(a) * hs, Math.max(0.5, rm * 0.2), rr(1.2, 2.2), 0.82, 0.9, 0.94, 0.8, 11, 0.15);
        }
        this.rings.add(x, 0.0002, z, 0, 0, Math.max(3, rm * 3), 3, 1, this.clock, 2.6);
        break;
      }
      case 'building': {
        const n = this.count(5 + rm, 2);
        for (let i = 0; i < n; i++) this.smokeP(x, oy, z, rr(-1, 1), rr(0, 1.5), rr(-1, 1), rr(-2, 2), rr(0.5, 3), rr(-2, 2), Math.max(0.8, rm * rr(0.3, 0.5)), rm * 0.4, rr(1.5, 3.2), 0.56, 0.6, 1, 0.1);
        const nc = this.count(4 + rm * 0.6, 2);
        for (let i = 0; i < nc; i++) this.dirtP(x, oy, z, 0, 0.5, 0, rr(-4, 4), rr(3, 9), rr(-4, 4), 0.3, rr(0.8, 1.5), 0.45, 0.28, 0.2, 1, 14, 0.1, SHAPE_CHIP);
        break;
      }
      case 'armor': {
        this.sparkBurst(x, oy, z, 0, 1, 0, 6 + Math.round(rm), 9);
        this.flashP(x, oy, z, 0, 1, 0, Math.max(0.8, rm * 0.5), 0.07, 1, 0.9, 0.55, 0.9);
        if (rm >= 2) this.smokeP(x, oy, z, 0, 1, 0, 0, 1.5, 0, rm * 0.4, rm * 0.5, 1.6, 0.18, 0.5);
        break;
      }
      case 'flesh': {
        this.smokeP(x, oy, z, 0, 0.6, 0, rr(-0.5, 0.5), rr(0.3, 0.8), rr(-0.5, 0.5), 0.6, 0.6, 0.9, 0.5, 0.3, 1, 0.1);
        break;
      }
      default: { // structure: Splitter
        const n = this.count(5 + rm * 0.5, 2);
        for (let i = 0; i < n; i++) this.dirtP(x, oy, z, 0, 0.6, 0, rr(-5, 5), rr(3, 8), rr(-5, 5), 0.32, rr(0.7, 1.3), 0.55, 0.42, 0.28, 1, 14, 0.1, SHAPE_CHIP);
        this.smokeP(x, oy, z, 0, 0.6, 0, 0, 0.8, 0, rm * 0.4 + 0.5, rm * 0.4, 1.4, 0.55, 0.5, 1, 0.1);
      }
    }
    void weapon;
  }

  // ---- combat:explosion
  private explode(x: number, y: number, z: number, sz: number, fire: boolean, withShake: boolean): void {
    const gy = this.ground(x, z);
    const water = this.isWater(x, z);
    const oy = Math.max(y, 0);
    const airburst = y > gy + 0.04 * Math.max(1, this.camDist * 0.02);
    const R = X_R[sz];
    if (withShake) this.shake.add(x, z, X_SHAKE[sz]);

    // Rauchsäule + LOS-Wolke + Brandfleck gelten auch bei weit entferntem Blick
    const columnDur = X_COLUMN[sz];
    if (X_CLOUD_R[sz] > 0) this.addCloud(x, z, X_CLOUD_R[sz], X_CLOUD_D[sz], columnDur);
    if (sz >= 2 || fire) this.addEmitter(1, x, oy, z, columnDur, sz === 4 ? 14 : sz === 3 ? 10 : sz === 2 ? 6 : 3, R * 0.5, R * (sz >= 3 ? 0.55 : 0.5));
    if (fire) {
      const dur = rr(20, 60);
      this.addEmitter(0, x, oy, z, dur, 14 + sz * 5, R * 0.8, Math.max(2, R * 0.45));
      this.addCloud(x, z, 0.012 + sz * 0.004, 0.4, dur);
    }

    // Bodenspuren
    if (!airburst && !water) {
      if (sz >= 1) {
        this.craters.add(x, gy, z, this.slopeX(x, z), this.slopeZ(x, z), X_CRATER[sz], 0, 1, this.clock, 1e9);
        this.craters.add(x, gy, z, this.slopeX(x, z), this.slopeZ(x, z), X_CRATER[sz] * 2.3, 1, 1, this.clock, 1e9);
      } else {
        this.craters.add(x, gy, z, this.slopeX(x, z), this.slopeZ(x, z), X_CRATER[sz] * 1.6, 1, 0.9, this.clock, 1e9);
      }
    }
    if (!water) this.rings.add(x, gy, z, this.slopeX(x, z), this.slopeZ(x, z), X_RING[sz], 2, 1, this.clock, 0.8 + R * 0.03);
    else this.rings.add(x, 0.0002, z, 0, 0, X_RING[sz] * 1.2, 3, 1, this.clock, 2.4);

    if (this.camDist > FAR_SKIP && sz < 3) return;
    if (this.camDist > FAR_SKIP) {
      this.flashP(x, oy, z, 0, R * 0.5, 0, R * 3, 0.5, 1, 0.8, 0.4, 0.9);
      return;
    }
    if (!this.inView(x, oy, z, 0.15)) return;

    const sc = 1;
    // Blitz
    this.flashP(x, oy, z, 0, R * 0.6, 0, R * 2.8, 0.14, 1, 0.9, 0.55, 0.95);
    this.flashP(x, oy, z, 0, 0.3, 0, R * 4.5, 0.28, 1, 0.7, 0.3, 0.28);

    // Feuerball
    const nF = this.count(X_FIRE[sz], 5);
    for (let i = 0; i < nF; i++) {
      const a = rnd() * 6.283, el = rnd() * 1.3;
      const rad = R * 0.5 * Math.sqrt(rnd());
      const ce = Math.cos(el), se = Math.sin(el);
      const sp = R * rr(0.5, 1.7);
      this.fireP(x, oy, z, Math.cos(a) * ce * rad, se * rad * 0.9 + 0.5, Math.sin(a) * ce * rad,
        Math.cos(a) * ce * sp * 0.6, (se * sp + R * 0.9) * (airburst ? 0.5 : 1), Math.sin(a) * ce * sp * 0.6,
        R * rr(0.35, 0.65), R * rr(0.3, 0.7), rr(0.55, 1.1) * (0.8 + R * 0.03), 0.8, sc);
    }

    // Rauch (dunkel, braun-grau)
    const nS = this.count(X_SMOKE[sz], 4);
    for (let i = 0; i < nS; i++) {
      const a = rnd() * 6.283, rad = R * 0.6 * Math.sqrt(rnd());
      const sh = rr(0.12, 0.26);
      this.smokeP(x, oy, z, Math.cos(a) * rad, rr(0.5, R * 0.8), Math.sin(a) * rad,
        Math.cos(a) * R * rr(0.1, 0.6), R * rr(0.3, 0.9), Math.sin(a) * R * rr(0.1, 0.6),
        R * rr(0.4, 0.75), R * 0.14, rr(3.5, 7) * (0.6 + R * 0.04), sh, 0.8, sc, 0.2);
    }

    if (!airburst) {
      // Staubring (flach, expandierend)
      const nR = this.count(X_FIRE[sz] * 0.45, 4);
      for (let i = 0; i < nR; i++) {
        const a = (i / nR) * 6.283 + rr(-0.2, 0.2), sp = R * rr(1.8, 3.2);
        this.smokeP(x, oy, z, Math.cos(a) * R * 0.3, 0.4, Math.sin(a) * R * 0.3, Math.cos(a) * sp, rr(0.2, 1.5), Math.sin(a) * sp, R * rr(0.3, 0.5), R * 0.4, rr(1.4, 2.6), water ? 0.8 : 0.5, 0.5, sc, water ? 0 : 0.14);
      }
      // Erdfontäne / Wassersäule
      const nD = this.count(X_FIRE[sz] * 0.5, 3);
      for (let i = 0; i < nD; i++) {
        const a = rnd() * 6.283, hs = R * rr(0.2, 1.1);
        if (water) this.dirtP(x, oy, z, 0, 0.3, 0, Math.cos(a) * hs * 0.5, R * rr(1.5, 3.4), Math.sin(a) * hs * 0.5, R * 0.18, rr(1.4, 2.6), 0.82, 0.9, 0.94, 0.85, 12, 0.1);
        else this.dirtP(x, oy, z, 0, 0.3, 0, Math.cos(a) * hs, R * rr(1.2, 3.2), Math.sin(a) * hs, R * 0.12, rr(1.4, 2.6), 0.3, 0.23, 0.15, 0.95, 13, 0.1, rnd() < 0.5 ? SHAPE_CHIP : SHAPE_BLOB);
      }
    }

    // Funken
    const nSp = this.count(X_SPARK[sz], 2);
    for (let i = 0; i < nSp; i++) {
      const sp = R * rr(1.5, 4);
      this.sparkP(x, oy, z, 0, R * 0.3, 0, rr(-1, 1) * sp, rr(0.3, 1) * sp * 1.2, rr(-1, 1) * sp, 0.35, rr(0.6, 1.5));
    }

    // Trümmerbrocken
    const nDeb = this.count(X_DEBRIS[sz], 2);
    for (let i = 0; i < nDeb; i++) {
      const a = rnd() * 6.283, hs = R * rr(0.4, 1.9);
      const s = R * rr(0.04, 0.1);
      this.addDebris(x, oy, z, 0, R * 0.3, 0, Math.cos(a) * hs, R * rr(1.4, 3.2), Math.sin(a) * hs, s * rr(0.7, 1.6), s * rr(0.5, 1.2), s * rr(0.7, 1.6), rr(3, 5), 0, [0x2a2622, 0x3a2e24, 0x18171a, 0x4a3a2a][i & 3]);
    }
  }

  private slopeX(x: number, z: number): number {
    const d = this.geo.cellKm * 0.5;
    return (this.ground(x + d, z) - this.ground(x - d, z)) / (2 * d);
  }
  private slopeZ(x: number, z: number): number {
    const d = this.geo.cellKm * 0.5;
    return (this.ground(x, z + d) - this.ground(x, z - d)) / (2 * d);
  }

  // ---- Rauchgranate / Nebel
  private smokeScreen(x: number, z: number, radiusKm: number, dur: number, density: number): void {
    this.addCloud(x, z, radiusKm, clamp(density, 0, 1), dur);
    const gy = this.ground(x, z);
    if (this.camDist > FAR_SKIP || !this.inView(x, gy, z, radiusKm + 0.05)) return;
    // sichtbare Wolke: weiß-grau, quillt auf (schwächer skaliert, damit sie zum LOS-Radius passt)
    const rm = radiusKm * 1000;
    const sc = 0.32;
    const n = this.count(40, 12);
    for (let i = 0; i < n; i++) {
      const a = rnd() * 6.283, d = Math.sqrt(rnd()) * rm * 0.35;
      this.smokeP(x, gy, z, Math.cos(a) * d, rr(0.5, 5), Math.sin(a) * d, Math.cos(a) * rm * rr(0.05, 0.3), rr(1, 3), Math.sin(a) * rm * rr(0.05, 0.3), rm * rr(0.22, 0.4), rm * 0.05, rr(8, 16), rr(0.62, 0.8), 0.85, sc);
    }
    this.flashP(x, gy, z, 0, 1, 0, rm * 0.5, 0.2, 0.9, 0.9, 0.85, 0.35, sc);
    // anhaltende Quelle (dick, weiß)
    this.addEmitter(6, x, gy, z, Math.min(dur, 90), 5, rm * 0.4, rm * 0.3);
  }

  // ---- Wracks
  private spawnWreck(x: number, _y: number, z: number, heading: number, category: string): void {
    const kind = wreckKindOf(category);
    const mesh = this.wreckMeshes.get(kind)!;
    const cap = WRECK_CAP[kind];
    const head = this.wreckHead.get(kind)!;
    let cnt = this.wreckCount.get(kind)!;
    this.wreckHead.set(kind, (head + 1) % cap);
    if (head >= cnt) { cnt = head + 1; this.wreckCount.set(kind, cnt); }
    const data = this.wreckData.get(kind)!;
    const gy = kind === 'naval' ? 0 : this.ground(x, z);
    const o = head * 6;
    data[o] = x; data[o + 1] = gy; data[o + 2] = z; data[o + 3] = heading;
    data[o + 4] = rr(-0.06, 0.06); data[o + 5] = rr(-0.06, 0.06);
    const t = rr(0.7, 1);
    mesh.setColorAt(head, this._c.setRGB(t, t * 0.97, t * 0.94));
    mesh.instanceColor!.needsUpdate = true;
    mesh.count = cnt;
    this.lastWreckScale = -1; // Matrizen neu schreiben
    // Qualm/Feuer
    const sizeM = kind === 'naval' ? 12 : kind === 'jet' || kind === 'heli' ? 3 : kind === 'drone' ? 1 : 2.5;
    this.addEmitter(4, x, gy, z, 240, kind === 'naval' ? 8 : 6, kind === 'naval' ? 8 : 1.8, sizeM * 1.3, 25);
    this.addCloud(x, z, 0.012, 0.35, 60);
    // Explosions-Nachbeben: kleiner Funkenregen + Trümmer
    if (this.camDist < 300 && this.inView(x, gy, z, 0.1)) {
      const nd = this.count(5, 2);
      for (let i = 0; i < nd; i++) {
        const a = rnd() * 6.283, hs = rr(2, 7);
        this.addDebris(x, gy, z, 0, 1.5, 0, Math.cos(a) * hs, rr(6, 12), Math.sin(a) * hs, rr(0.3, 0.9), rr(0.2, 0.5), rr(0.3, 0.9), rr(3, 4.5), 0, 0x1a1816);
      }
    }
  }

  private updateWrecks(): void {
    if (Math.abs(this.visScale - this.lastWreckScale) < this.lastWreckScale * 0.004 && this.lastWreckScale > 0) return;
    this.lastWreckScale = this.visScale;
    const ws = this.visScale * 0.001;
    const lift = this.camDist * 0.0012;
    for (const [kind, mesh] of this.wreckMeshes) {
      const n = this.wreckCount.get(kind)!;
      if (n === 0) continue;
      const data = this.wreckData.get(kind)!;
      const mul = kind === 'drone' ? 1 : 1;
      for (let i = 0; i < n; i++) {
        const o = i * 6;
        this._e.set(data[o + 4], -data[o + 3], data[o + 5], 'YXZ');
        this._q.setFromEuler(this._e);
        this._p.set(data[o], data[o + 1] + lift, data[o + 2]);
        this._s.setScalar(ws * mul);
        this._m.compose(this._p, this._q, this._s);
        mesh.setMatrixAt(i, this._m);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  // ---- Gebäude
  private buildingCollapse(x: number, y: number, z: number): void {
    const gy = this.ground(x, z);
    this.shake.add(x, z, 0.3);
    this.craters.add(x, gy, z, this.slopeX(x, z), this.slopeZ(x, z), 13, 4, 1, this.clock, 1e9);
    this.craters.add(x, gy, z, this.slopeX(x, z), this.slopeZ(x, z), 22, 1, 0.5, this.clock, 1e9);
    this.rings.add(x, gy, z, this.slopeX(x, z), this.slopeZ(x, z), 26, 2, 1, this.clock, 1.4);
    this.addCloud(x, z, 0.02, 0.55, 40);
    this.addEmitter(3, x, gy, z, 25, 10, 6, 7);
    if (this.camDist > FAR_SKIP * 0.5 || !this.inView(x, gy, z, 0.15)) return;
    void y;
    const R = 10;
    const n = this.count(46, 10);
    for (let i = 0; i < n; i++) {
      const a = rnd() * 6.283, d = Math.sqrt(rnd()) * R;
      const sp = R * rr(0.2, 1.4);
      this.smokeP(x, gy, z, Math.cos(a) * d, rr(0, R * 1.2), Math.sin(a) * d, Math.cos(a) * sp, rr(2, R * 0.9), Math.sin(a) * sp, R * rr(0.35, 0.65), R * 0.25, rr(4, 8), rr(0.45, 0.6), 0.75, 1, 0.12);
    }
    const nr = this.count(24, 6);
    for (let i = 0; i < nr; i++) {
      const a = (i / nr) * 6.283, sp = R * rr(1.4, 2.6);
      this.smokeP(x, gy, z, Math.cos(a) * R * 0.4, 0.4, Math.sin(a) * R * 0.4, Math.cos(a) * sp, 0.5, Math.sin(a) * sp, R * 0.4, R * 0.3, rr(1.6, 2.8), 0.55, 0.55, 1, 0.12);
    }
    const nd = this.count(18, 4);
    for (let i = 0; i < nd; i++) {
      const a = rnd() * 6.283, hs = R * rr(0.3, 1.2), s = rr(0.5, 1.6);
      this.addDebris(x, gy, z, rr(-1, 1) * R * 0.4, rr(2, R), rr(-1, 1) * R * 0.4, Math.cos(a) * hs, rr(3, 12), Math.sin(a) * hs, s * 1.4, s, s * 1.2, rr(3, 6), 0, [0x4a3a30, 0x5a4a3c, 0x302a26, 0x6a6258][i & 3]);
    }
    this.flashP(x, gy, z, 0, 2, 0, R * 1.5, 0.15, 0.9, 0.75, 0.5, 0.5);
  }

  // ---- Brücken
  private bridgeCollapse(edgeId: number, geom: number[]): void {
    const np = Math.floor(geom.length / 2);
    if (np < 1) return;
    // Länge der Polylinie
    let len = 0;
    for (let i = 1; i < np; i++) len += Math.hypot(geom[i * 2] - geom[i * 2 - 2], geom[i * 2 + 1] - geom[i * 2 - 1]);
    const mx = np > 1 ? this.pointAlong(geom, np, len * 0.5, 0) : geom[0];
    const mz = np > 1 ? this.pointAlong(geom, np, len * 0.5, 1) : geom[1];
    this.bridgeMid.set(edgeId, [mx, mz]);
    this.shake.add(mx, mz, 0.5);
    const nBurst = clamp(Math.round(len * 1000 / 14), 3, 14);
    const nSlab = clamp(Math.round(len * 1000 / 7), 6, 60);
    const dur = 1.5;
    this.addCloud(mx, mz, Math.max(0.03, len * 0.45), 0.6, 60);
    this.addEmitter(3, mx, this.ground(mx, mz), mz, 30, 14, 8, 9);
    this.addEmitter(1, mx, this.ground(mx, mz), mz, 70, 4, 6, 12);
    const near = this.camDist < FAR_SKIP && this.inView(mx, this.ground(mx, mz), mz, len);
    for (let i = 0; i < nBurst; i++) {
      const f = np > 1 ? (nBurst === 1 ? 0.5 : i / (nBurst - 1)) : 0;
      const bx = np > 1 ? this.pointAlong(geom, np, len * f, 0) : geom[0];
      const bz = np > 1 ? this.pointAlong(geom, np, len * f, 1) : geom[1];
      const order = (i % 2 === 0 ? i : nBurst - i) / nBurst; // von außen nach innen versetzt
      this.schedule(order * dur + rr(0, 0.15), DELAY_EXPLODE, bx, 1.5, bz, i === Math.floor(nBurst / 2) ? 2 : 1);
      this.schedule(order * dur + rr(0.2, 0.4), DELAY_DUST, bx, this.ground(bx, bz), bz, 7);
    }
    if (!near) return;
    // Fallende Platten und Träger
    for (let i = 0; i < nSlab; i++) {
      const f = rnd();
      const bx = this.pointAlong(geom, np, len * f, 0), bz = this.pointAlong(geom, np, len * f, 1);
      const gy = this.ground(bx, bz);
      const wat = this.isWater(bx, bz);
      const beam = i % 3 === 0;
      const delay = f * dur;
      void delay;
      this.addDebris(bx, gy, bz, rr(-1.5, 1.5), rr(3.5, 5.5), rr(-1.5, 1.5), rr(-2, 2), rr(-1, 2), rr(-2, 2),
        beam ? rr(7, 11) : rr(4, 7), beam ? 0.5 : 0.7, beam ? 0.6 : rr(2.5, 4), rr(5, 8), wat ? -3 : 0, [0x5a574f, 0x45423c, 0x6a665e, 0x3a3834][i & 3]);
    }
  }

  private pointAlong(geom: number[], np: number, d: number, axis: number): number {
    let acc = 0;
    for (let i = 1; i < np; i++) {
      const ax = geom[i * 2 - 2], az = geom[i * 2 - 1], bx = geom[i * 2], bz = geom[i * 2 + 1];
      const l = Math.hypot(bx - ax, bz - az);
      if (acc + l >= d || i === np - 1) {
        const t = l > 1e-9 ? clamp((d - acc) / l, 0, 1) : 0;
        return axis === 0 ? ax + (bx - ax) * t : az + (bz - az) * t;
      }
      acc += l;
    }
    return geom[axis];
  }

  private dustCloud(x: number, gy: number, z: number, R: number): void {
    if (this.camDist > FAR_SKIP || !this.inView(x, gy, z, 0.1)) return;
    const n = this.count(14, 4);
    for (let i = 0; i < n; i++) {
      const a = rnd() * 6.283, sp = R * rr(0.3, 1.2);
      this.smokeP(x, gy, z, 0, rr(0.5, 4), 0, Math.cos(a) * sp, rr(1, 4), Math.sin(a) * sp, R * rr(0.45, 0.8), R * 0.4, rr(3, 6), 0.5, 0.65, 1, 0.14);
    }
  }

  private bridgeRepaired(edgeId: number): void {
    const p = this.bridgeMid.get(edgeId);
    if (!p || this.camDist > FAR_SKIP * 0.5) return;
    const [x, z] = p;
    const gy = this.ground(x, z);
    if (!this.inView(x, gy, z, 0.3)) return;
    this.dustCloud(x, gy, z, 4);
    const n = this.count(18, 5);
    for (let i = 0; i < n; i++) this.sparkP(x, gy, z, rr(-8, 8), 3, rr(-8, 8), rr(-3, 3), rr(3, 8), rr(-3, 3), 0.3, rr(0.4, 0.9));
    this.bridgeMid.delete(edgeId);
  }

  // ------------------------------------------------------------ Update
  update(dtRealSec: number, camera: THREE.PerspectiveCamera, timeSec: number, units?: ReadonlyArray<Unit>): void {
    void timeSec;
    const dt = clamp(dtRealSec, 0, 0.1);
    this.clock += dt;

    camera.updateMatrixWorld();
    this.camPos.setFromMatrixPosition(camera.matrixWorld);
    camera.getWorldDirection(this.camDir);
    const gyc = Math.max(0, this.geo.heightAt(this.camPos.x, this.camPos.z)) * this.exag;
    const dist = this.camDir.y < -0.05 ? Math.max(0.5, (this.camPos.y - gyc * 0.5) / -this.camDir.y) : Math.max(0.5, this.camPos.y);
    this.camDist = dist;
    this.focusX = this.camPos.x + this.camDir.x * dist;
    this.focusZ = this.camPos.z + this.camDir.z * dist;
    this.shake.setView(this.focusX, this.focusZ, dist);
    this.visScale = clamp(VIS_K * dist, VIS_MIN, VIS_MAX);
    this.lift = dist * 0.003 + 0.002;
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    this.haveView = true;

    const screenH = Math.max(200, (typeof window !== 'undefined' ? window.innerHeight : 800) / 2);
    const pxWorld = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / screenH;
    const pm = this.particles.material.uniforms;
    pm.uVis.value = this.visScale;
    pm.uPx.value = pxWorld;
    this.decalUniforms.uVis.value = this.visScale;
    this.decalUniforms.uTime.value = this.clock;
    this.decalUniforms.uLift.value = this.lift;
    const rm = this.ribbons.material.uniforms.uRes.value as THREE.Vector2;
    rm.set(typeof window !== 'undefined' ? window.innerWidth / 2 : 960, screenH);

    this.runDelayed();
    this.updateProjectiles(dt);
    this.updateEmitters(dt);
    if (units && this.camDist < 700) this.sampleDamaged(units, dt);

    this.particles.step(dt);
    this.updateDebris(dt);
    this.ribbons.update(this.clock);
    this.rings.expire(this.clock);
    this.updateWrecks();
  }

  /** Einheiten mit wenig HP qualmen/brennen lassen – pro Frame nur ein Ausschnitt der Liste. */
  private sampleDamaged(units: ReadonlyArray<Unit>, dt: number): void {
    const n = units.length;
    if (n === 0) return;
    const batch = Math.min(n, DAMAGED_PER_FRAME);
    const fps = dt > 0 ? 1 / dt : 60;
    const visitDt = n / (batch * fps); // mittlere Zeit zwischen zwei Besuchen einer Einheit
    for (let k = 0; k < batch; k++) {
      this.dmgCursor = (this.dmgCursor + 1) % n;
      const u = units[this.dmgCursor];
      if (!u || u.hp <= 0) continue;
      const maxHp = u.type.hp;
      const frac = u.hp / maxHp;
      if (frac >= 0.4) continue;
      const cat = u.type.category;
      if (cat === 'infantry') continue;
      if (!this.inView(u.x, u.y, u.z, 0.05)) continue;
      const air = cat === 'helicopter' || cat === 'jet' || cat === 'drone';
      const ground = Math.max(0, this.geo.heightAt(u.x, u.z)) * this.exag;
      let uy = ground;
      if (air && u.airborne !== false) {
        const alt = Math.max(0, u.y - ground);
        uy = ground + Math.min(alt, 0.15 * this.camDist + 0.03);
      }
      const rateSmoke = 6 * visitDt;
      if (rnd() < Math.min(1, rateSmoke)) {
        const s = 1.6 + (air ? 0.4 : 0);
        this.smokeP(u.x, uy, u.z, 0, 1.8, 0, rr(-0.4, 0.4), rr(2, 4), rr(-0.4, 0.4), s * rr(0.7, 1.1), s * 0.5, rr(2.5, 4.5), frac < 0.15 ? 0.1 : 0.3, 0.7, 1);
      }
      if (frac < 0.15 && rnd() < Math.min(1, 5 * visitDt)) {
        this.fireP(u.x, uy, u.z, rr(-0.8, 0.8), 2, rr(-0.8, 0.8), 0, rr(2, 4), 0, 1.4 * rr(0.6, 1), 0.8, rr(0.4, 0.8), 0.7, 1);
      }
    }
  }
}
