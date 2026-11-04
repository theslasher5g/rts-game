import * as THREE from 'three';
import { SUN_COLOR, SUN_DIR } from './Terrain';
import type { GeoData } from './GeoData';

/**
 * Prototyp-Geometrien (intakt / schwer beschädigt / Trümmer / Fern-Quader), Fensteratlas und Gebäude-Shader für Cities + Villages.
 *
 * Geometrie-Baukasten GB: Attribute position, normal, uv, aSurf(Fassade, Achse, Teil), aSize, aVC(Vertexfarbe), aAnc(Anker + Achsflags),
 * aDet(Gate-Salz, Gate-Schwelle, Höhenlimit, Basisversatz). "Absolute" Vertices (Details wie Türen, Schornsteine, Antennen) werden in Metern
 * relativ zu einem Ankerpunkt im Einheitswürfel des Gebäudes angegeben und im Vertex-Shader unabhängig von der Instanzskalierung auf
 * echte Größe gebracht. Per-Instanz-Variation: Gate (Detail erscheint nur bei bestimmten Instanz-Zufallswerten).
 *
 * Teile (aSurf.z): 0 Wand, 1 Dach, 2 dunkel, 3 Ziegel, 4 Beton, 5 absolute Vertexfarbe, 6 Schaufenster, 7 Akzentfarbe (Instanz-Palette),
 * 8 Fensterglas (absolut), 9 Signallicht (rot, blinkt)
 */

export type V3 = [number, number, number];

export const BT = {
  OLD: 0, // Altbau, Satteldach, Schornsteine, Gauben
  HIP: 1, // Walmdach (Mittelmeer / Villen)
  MID: 2, // Wohn-/Bürobau, Flachdach
  PLATTE: 3, // Plattenbau-Riegel
  HALL: 4, // Industriehalle mit Sheddach
  SILO: 5,
  STACK: 6, // Schornstein
  TOWER: 7, // Hochhaus mit gestuftem Abschluss
  CHURCH: 8, // Kirche mit Spitzturm
  WARE: 9, // Lagerhalle
  VILLA: 10, // Einfamilienhaus
  BARN: 11, // Scheune
  STABLE: 12, // Stall (Dorf)
  CHAPEL: 13, // Kapelle (Dorf)
} as const;
export const BT_COUNT = 14;
/** Höhenanteil der einfachen LOD1-Quader je Typ */
export const FAR_TOP = [0.8, 0.8, 0.93, 0.95, 0.65, 0.8, 1, 0.96, 0.5, 0.85, 0.75, 0.7, 0.55, 0.6];
/** Anzahl Trümmer-Varianten */
export const RUBBLE_VARIANTS = 3;
/** Gebäude-Einsenkung in den Boden (km, Welteinheiten); Modell-y = 0 liegt auf Geländehöhe, Details darunter bilden den Sockel */
export const SINK = 0.03;
/** Stil-Bits (in roof >>> 24): 0 Putz, 1 Fachwerk, 2 Ziegel, 3 Weißkalk */
export const STYLE_SHIFT = 24;

// ====================================================================== Gelände / Zufall (hier, damit StreetProps ohne Zyklus importieren kann)

/** Deterministischer RNG (mulberry32) */
export function rngFrom(name: string): () => number {
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

function cornerH(hs: Float32Array, W: number, H: number, i: number, j: number): number {
  const i0 = i < 1 ? 0 : i > W ? W - 1 : i - 1;
  const i1 = i < 0 ? 0 : i > W - 1 ? W - 1 : i;
  const j0 = j < 1 ? 0 : j > H ? H - 1 : j - 1;
  const j1 = j < 0 ? 0 : j > H - 1 ? H - 1 : j;
  return 0.25 * (hs[j0 * W + i0] + hs[j0 * W + i1] + hs[j1 * W + i0] + hs[j1 * W + i1]);
}

/**
 * Höhe (km) der GPU-Geländeoberfläche (Gitterpunkte = Mittel der 4 Rasterzellen darum, dazwischen bilinear) –
 * für Dekale/Gebäude, die exakt auf dem gerenderten Gelände sitzen sollen (geo.heightAt weicht an Hängen ab).
 */
export function terrainHeightKm(geo: GeoData, x: number, z: number): number {
  const gx = x / geo.cellKm, gz = z / geo.cellKm;
  const i = Math.floor(gx), j = Math.floor(gz);
  const fx = gx - i, fz = gz - j;
  const hs = geo.heightsKm, W = geo.width, H = geo.height;
  const a = cornerH(hs, W, H, i, j), b = cornerH(hs, W, H, i + 1, j);
  const c = cornerH(hs, W, H, i, j + 1), d = cornerH(hs, W, H, i + 1, j + 1);
  return (a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz;
}

// ====================================================================== Geometrie-Baukasten

const _lc = new THREE.Color();
export function lin(hex: number): V3 {
  _lc.setHex(hex);
  return [_lc.r, _lc.g, _lc.b];
}
const mulc = (c: V3, k: number): V3 => [c[0] * k, c[1] * k, c[2] * k];
const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Achsflags für absolute Modi */
const AX = 1, AY = 2, AZ = 4, AALL = 7;

interface BoxOpt { f?: number; endF?: number; part?: number; top?: number; topPart?: number; bottom?: boolean; sides?: number }

export class GB {
  p: number[] = [];
  n: number[] = [];
  uv: number[] = [];
  s: number[] = [];
  z: number[] = [];
  vc: number[] = [];
  anc: number[] = [];
  det: number[] = [];
  i: number[] = [];
  col: V3 = [1, 1, 1];
  /** true: keine y-Umrechnung (Fern-Quader) */
  far = false;
  private A: V3 = [0, 0, 0];
  private flags = 0;
  private gSalt = 0;
  private gThr = 0;
  private gLim = 9;
  private gBase = 0;

  /** Absoluter Modus: Koordinaten der Achsen in `flags` sind Meter relativ zum Anker (ax,ay,az in Einheitskoordinaten). */
  at(ax: number, ay: number, az: number, flags = AALL): this {
    this.A = [ax, ay, az];
    this.flags = flags;
    return this;
  }
  rel(): this {
    this.flags = 0;
    return this;
  }
  /** Gate: Detail nur für Instanzen mit Zufallswert < thr (thr > 0) bzw. >= -thr (thr < 0). lim/base: Höhenlimit (Einheiten) + Basisversatz (m) */
  gate(salt: number, thr: number, lim = 9, base = 0): this {
    this.gSalt = salt;
    this.gThr = thr;
    this.gLim = lim;
    this.gBase = base;
    return this;
  }
  ungate(): this {
    this.gSalt = 0;
    this.gThr = 0;
    this.gLim = 9;
    this.gBase = 0;
    return this;
  }
  c(hex: number): this {
    this.col = lin(hex);
    return this;
  }
  c3(c: V3): this {
    this.col = c;
    return this;
  }
  white(): this {
    this.col = [1, 1, 1];
    return this;
  }

  private emit(P: V3[], UV: number[][], nrm: V3, flip: boolean, f: number, axis: number, part: number, sw: number, sh: number): void {
    const base = this.p.length / 3;
    const fl = this.flags;
    for (let k = 0; k < P.length; k++) {
      this.p.push((fl & AX ? 0.001 : 1) * P[k][0], (fl & AY ? 0.001 : 1) * P[k][1], (fl & AZ ? 0.001 : 1) * P[k][2]);
      this.n.push(nrm[0], nrm[1], nrm[2]);
      this.uv.push(UV[k][0], UV[k][1]);
      this.s.push(f, axis, part);
      this.z.push(sw, sh);
      this.vc.push(this.col[0], this.col[1], this.col[2]);
      this.anc.push(this.A[0], this.A[1], this.A[2], this.far ? 8 : fl);
      this.det.push(this.gSalt, this.gThr, this.gLim, this.gBase);
    }
    if (P.length === 4) {
      if (!flip) this.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
      else this.i.push(base, base + 2, base + 1, base, base + 3, base + 2);
    } else if (!flip) this.i.push(base, base + 1, base + 2);
    else this.i.push(base, base + 2, base + 1);
  }

  private static normal(a: V3, b: V3, c: V3, hint: V3): { n: V3; flip: boolean } {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const flip = nx * hint[0] + ny * hint[1] + nz * hint[2] < 0;
    return { n: flip ? [-nx, -ny, -nz] : [nx, ny, nz], flip };
  }

  /** a->b = u-Richtung (horizontal), a->d = v-Richtung */
  quad(a: V3, b: V3, c: V3, d: V3, hint: V3, f: number, axis: number, part: number, sw = 1, sh = 1, uvs?: number[][]): void {
    const { n, flip } = GB.normal(a, b, d, hint);
    this.emit([a, b, c, d], uvs ?? [[0, 0], [1, 0], [1, 1], [0, 1]], n, flip, f, axis, part, sw, sh);
  }

  tri(a: V3, b: V3, c: V3, hint: V3, f: number, axis: number, part: number, sw = 1, sh = 1): void {
    const { n, flip } = GB.normal(a, b, c, hint);
    this.emit([a, b, c], [[0, 0], [1, 0], [0.5, 1]], n, flip, f, axis, part, sw, sh);
  }

  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, o: BoxOpt = {}): void {
    const f = o.f ?? -1, ef = o.endF ?? f, part = o.part ?? 0;
    const sx = x1 - x0, sz = z1 - z0, sy = y1 - y0;
    const sd = o.sides ?? 15;
    if (sd & 1) this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], f, 0, part, sx, sy);
    if (sd & 2) this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], f, 0, part, sx, sy);
    if (sd & 4) this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], ef, 1, part, sz, sy);
    if (sd & 8) this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], ef, 1, part, sz, sy);
    if (o.top !== 0) this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], -1, 0, o.topPart ?? 1);
    if (o.bottom) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], -1, 0, part);
  }

  /** Quader mit Y-Rotation und Kippung um X/Z (Trümmer) */
  tbox(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, rotY: number, tx: number, tz: number, part: number): void {
    const cs = Math.cos(rotY), sn = Math.sin(rotY), ct = Math.cos(tx), st = Math.sin(tx), cu = Math.cos(tz), su = Math.sin(tz);
    const T = (x: number, y: number, z: number): V3 => {
      let y1 = y * ct - z * st, z1 = y * st + z * ct;
      let x1 = x;
      const x2 = x1 * cu - y1 * su, y2 = x1 * su + y1 * cu;
      x1 = x2; y1 = y2;
      return [cx + x1 * cs + z1 * sn, cy + y1, cz - x1 * sn + z1 * cs];
    };
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const c = [T(-hx, -hy, -hz), T(hx, -hy, -hz), T(hx, hy, -hz), T(-hx, hy, -hz), T(-hx, -hy, hz), T(hx, -hy, hz), T(hx, hy, hz), T(-hx, hy, hz)];
    const mid: V3 = T(0, 0, 0);
    const face = (a: number, b: number, cc: number, d: number) => {
      const ctr: V3 = [(c[a][0] + c[cc][0]) / 2, (c[a][1] + c[cc][1]) / 2, (c[a][2] + c[cc][2]) / 2];
      this.quad(c[a], c[b], c[cc], c[d], [ctr[0] - mid[0], ctr[1] - mid[1], ctr[2] - mid[2]], -1, 0, part);
    };
    face(4, 5, 6, 7); face(1, 0, 3, 2); face(5, 1, 2, 6); face(0, 4, 7, 3); face(3, 7, 6, 2); face(0, 1, 5, 4);
  }

  /** Vierkantbalken von a nach b, Querschnitt t (in Modus-Einheiten) */
  prism(a: V3, b: V3, t: number, part: number, capEnds = true): void {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const L = Math.hypot(dx, dy, dz) || 1;
    const d: V3 = [dx / L, dy / L, dz / L];
    const upv: V3 = Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    let ux = d[1] * upv[2] - d[2] * upv[1], uy = d[2] * upv[0] - d[0] * upv[2], uz = d[0] * upv[1] - d[1] * upv[0];
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux = (ux / ul) * t; uy = (uy / ul) * t; uz = (uz / ul) * t;
    const vx = (d[1] * uz - d[2] * uy) / t * t, vy = (d[2] * ux - d[0] * uz) / t * t, vz = (d[0] * uy - d[1] * ux) / t * t;
    const P = (o: V3, su: number, sv: number): V3 => [o[0] + ux * su + vx * sv, o[1] + uy * su + vy * sv, o[2] + uz * su + vz * sv];
    const corners: Array<[number, number]> = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (let k = 0; k < 4; k++) {
      const c0 = corners[k], c1 = corners[(k + 1) % 4];
      const hint: V3 = [ux * (c0[0] + c1[0]) + vx * (c0[1] + c1[1]), uy * (c0[0] + c1[0]) + vy * (c0[1] + c1[1]), uz * (c0[0] + c1[0]) + vz * (c0[1] + c1[1])];
      this.quad(P(a, c0[0], c0[1]), P(a, c1[0], c1[1]), P(b, c1[0], c1[1]), P(b, c0[0], c0[1]), hint, -1, 0, part);
    }
    if (capEnds) {
      this.quad(P(b, -1, -1), P(b, 1, -1), P(b, 1, 1), P(b, -1, 1), d, -1, 0, part);
    }
  }

  /** Dachfläche in n Streifen (Ziegelreihen: abwechselnde Tönung). a->b Traufkante, a->d Neigung */
  slab(a: V3, b: V3, c: V3, d: V3, hint: V3, n: number, part = 1, alt = 0.84): void {
    const base = this.col;
    for (let k = 0; k < n; k++) {
      const t0 = k / n, t1 = (k + 1) / n;
      this.col = k % 2 ? mulc(base, alt) : base;
      this.quad(lerp3(a, d, t0), lerp3(b, c, t0), lerp3(b, c, t1), lerp3(a, d, t1), hint, -1, 0, part);
    }
    this.col = base;
  }

  /** Satteldach, First entlang x. ov = Überstand (Einheiten), strips = Ziegelreihen */
  gable(x0: number, x1: number, ye: number, yr: number, z0: number, z1: number, endPart = 0, strips = 6, ov = 0.03, ovx = 0.02, zr = (z0 + z1) / 2): void {
    const sl = (yr - ye) / Math.max(1e-6, (z1 - z0) / 2);
    const yo = ye - sl * ov;
    const xa = x0 - ovx, xb = x1 + ovx;
    this.slab([xa, yo, z1 + ov], [xb, yo, z1 + ov], [xb, yr, zr], [xa, yr, zr], [0, 1, 1], strips);
    this.slab([xb, yo, z0 - ov], [xa, yo, z0 - ov], [xa, yr, zr], [xb, yr, zr], [0, 1, -1], strips);
    this.tri([x1, ye, z1], [x1, ye, z0], [x1, yr, zr], [1, 0, 0], -1, 0, endPart);
    this.tri([x0, ye, z0], [x0, ye, z1], [x0, yr, zr], [-1, 0, 0], -1, 0, endPart);
  }

  /** Walmdach */
  hip(x0: number, x1: number, ye: number, yr: number, z0: number, z1: number, rl: number, strips = 5, ov = 0.03): void {
    const zm = (z0 + z1) / 2, xm = (x0 + x1) / 2;
    const sl = (yr - ye) / ((z1 - z0) / 2);
    const yo = ye - sl * ov;
    const xa = x0 - ov, xb = x1 + ov, za = z0 - ov, zb = z1 + ov;
    this.slab([xa, yo, zb], [xb, yo, zb], [xm + rl, yr, zm], [xm - rl, yr, zm], [0, 1, 1], strips);
    this.slab([xb, yo, za], [xa, yo, za], [xm - rl, yr, zm], [xm + rl, yr, zm], [0, 1, -1], strips);
    this.slab([xb, yo, zb], [xb, yo, za], [xm + rl, yr, zm], [xm + rl, yr, zm], [1, 1, 0], strips);
    this.slab([xa, yo, za], [xa, yo, zb], [xm - rl, yr, zm], [xm - rl, yr, zm], [-1, 1, 0], strips);
  }

  /** Pyramide (Spitzturm) */
  pyramid(cx: number, cz: number, hx: number, hz: number, y0: number, y1: number, part: number, strips = 0): void {
    const A: V3 = [cx, y1, cz];
    const c00: V3 = [cx - hx, y0, cz - hz], c10: V3 = [cx + hx, y0, cz - hz], c11: V3 = [cx + hx, y0, cz + hz], c01: V3 = [cx - hx, y0, cz + hz];
    if (strips > 0 && part === 1) {
      this.slab(c01, c11, A, A, [0, 0.3, 1], strips);
      this.slab(c10, c00, A, A, [0, 0.3, -1], strips);
      this.slab(c11, c10, A, A, [1, 0.3, 0], strips);
      this.slab(c00, c01, A, A, [-1, 0.3, 0], strips);
      return;
    }
    this.tri(c01, c11, A, [0, 0.3, 1], -1, 0, part);
    this.tri(c10, c00, A, [0, 0.3, -1], -1, 0, part);
    this.tri(c11, c10, A, [1, 0.3, 0], -1, 0, part);
    this.tri(c00, c01, A, [-1, 0.3, 0], -1, 0, part);
  }

  /** Zylinder/Kegelstumpf mit n Seiten, Mittelpunkt (cx,cz) */
  tube(cx: number, cz: number, y0: number, y1: number, r0: number, r1: number, n: number, part: number, cap: number): void {
    for (let k = 0; k < n; k++) {
      const a0 = (k / n) * Math.PI * 2, a1 = ((k + 1) / n) * Math.PI * 2;
      const am = (a0 + a1) / 2;
      const hint: V3 = [Math.cos(am), 0.05, Math.sin(am)];
      this.quad(
        [cx + Math.cos(a1) * r0, y0, cz + Math.sin(a1) * r0], [cx + Math.cos(a0) * r0, y0, cz + Math.sin(a0) * r0],
        [cx + Math.cos(a0) * r1, y1, cz + Math.sin(a0) * r1], [cx + Math.cos(a1) * r1, y1, cz + Math.sin(a1) * r1],
        hint, -1, 0, part, 1, 1,
      );
      if (cap >= 0) this.tri([cx + Math.cos(a0) * r1, y1, cz + Math.sin(a0) * r1], [cx + Math.cos(a1) * r1, y1, cz + Math.sin(a1) * r1], [cx, y1, cz], [0, 1, 0], -1, 0, cap);
    }
  }

  /** Scheibe (n-Eck) in der Ebene z = const, zeigt in +z (Schüssel/Uhr) */
  discZ(cx: number, cy: number, z: number, r: number, n: number, part: number, dir = 1): void {
    for (let k = 0; k < n; k++) {
      const a0 = (k / n) * Math.PI * 2, a1 = ((k + 1) / n) * Math.PI * 2;
      this.tri([cx, cy, z], [cx + Math.cos(a0) * r, cy + Math.sin(a0) * r, z], [cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, z], [0, 0, dir], -1, 0, part);
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aSurf', new THREE.Float32BufferAttribute(this.s, 3));
    g.setAttribute('aSize', new THREE.Float32BufferAttribute(this.z, 2));
    g.setAttribute('aVC', new THREE.Float32BufferAttribute(this.vc, 3));
    g.setAttribute('aAnc', new THREE.Float32BufferAttribute(this.anc, 4));
    g.setAttribute('aDet', new THREE.Float32BufferAttribute(this.det, 4));
    g.setIndex(this.i);
    return g;
  }
}

export const GEO_ATTRS = ['position', 'normal', 'uv', 'aSurf', 'aSize', 'aVC', 'aAnc', 'aDet'];

// ====================================================================== gemeinsame Detail-Bausteine

const COL = {
  metal: lin(0x6c7076), darkMetal: lin(0x2e3034), rust: lin(0x7a4a36), glass: lin(0x1e2a38), concrete: lin(0x9a978f), tar: lin(0x35363a),
  white: lin(0xe6e4dc), red: lin(0xb02a22), wood: lin(0x5a4030), solar: lin(0x1c2c4c), pipe: lin(0x8a8f94), sign: lin(0xe8e2d0), black: lin(0x1b1b1e),
  brick: lin(0x8a4a3a), plaster: lin(0xbdb4a0), char: lin(0x1c1a18), tile: lin(0x9a5a44), dust: lin(0x77716a), soot: lin(0x14120f), gravel: lin(0x6e6a62),
};

/** Dachhöhe (Einheiten) eines Satteldachs bei z (Traufe e bei |z| = 0.5, First r bei 0) */
const roofY = (e: number, r: number, z: number): number => e + (r - e) * (0.5 - Math.min(0.5, Math.abs(z))) / 0.5;

/** Sockel + Gesims um den Quader (nur Außenflächen): Ausladung/Höhe absolut, Länge relativ */
function bands(g: GB, e: number, o: { plinth?: boolean; cornice?: boolean; corniceCol?: V3; plinthCol?: V3 } = {}): void {
  const ledge = (kind: number) => {
    const out = kind === 0 ? 0.14 : 0.22;
    const y0 = kind === 0 ? 0 : -0.45, y1 = kind === 0 ? 0.95 : 0.12;
    g.c3(kind === 0 ? o.plinthCol ?? mulc(COL.concrete, 0.8) : o.corniceCol ?? mulc(COL.plaster, 0.9));
    const yA = kind === 0 ? 0 : e;
    for (const sg of [1, -1]) {
      g.at(0, yA, sg * 0.5, AY | AZ);
      g.quad([-0.5, y0, sg * out], [0.5, y0, sg * out], [0.5, y1, sg * out], [-0.5, y1, sg * out], [0, 0, sg], -1, 0, 5);
      g.quad([-0.5, y1, sg * out], [0.5, y1, sg * out], [0.5, y1, 0], [-0.5, y1, 0], [0, 1, 0], -1, 0, 5);
    }
    for (const sg of [1, -1]) {
      g.at(sg * 0.5, yA, 0, AX | AY);
      g.quad([sg * out, y0, 0.5], [sg * out, y0, -0.5], [sg * out, y1, -0.5], [sg * out, y1, 0.5], [sg, 0, 0], -1, 0, 5);
      g.quad([sg * out, y1, 0.5], [0, y1, 0.5], [0, y1, -0.5], [sg * out, y1, -0.5], [0, 1, 0], -1, 0, 5);
    }
    g.rel();
  };
  if (o.plinth) ledge(0);
  if (o.cornice) ledge(1);
  g.white();
}

/** Regenrinne + Fallrohre (Satteldach / Walmdach) */
function gutters(g: GB, e: number, ov = 0.03, pipes = true): void {
  const yo = e - ((0.92 - e) / 0.5) * ov;
  g.c3(COL.metal);
  for (const sg of [1, -1]) {
    g.at(0, yo, sg * (0.5 + ov), AY | AZ);
    g.box(-0.5, -0.28, sg > 0 ? -0.02 : -0.2, 0.5, 0.0, sg > 0 ? 0.2 : 0.02, { part: 5, topPart: 5 });
  }
  if (pipes) {
    g.c3(COL.pipe);
    for (const [px, pz] of [[-0.47, 0.5], [0.47, 0.5], [-0.47, -0.5], [0.47, -0.5]]) {
      g.at(px, 0, pz, AX | AZ);
      const sg = pz > 0 ? 1 : -1;
      g.box(-0.07, 0.0, sg > 0 ? 0.0 : -0.14, 0.07, yo, sg > 0 ? 0.14 : 0.0, { part: 5, topPart: 5 });
    }
  }
  g.rel().white();
}

/** Schornstein mit Kappe, am Satteldach bei (x,z) */
function chimney(g: GB, x: number, z: number, e: number, r: number, thr: number, salt: number, bricks = true): void {
  const yb = roofY(e, r, z) - 0.04, yt = r + 0.055;
  g.gate(salt, thr);
  g.c3(bricks ? COL.brick : COL.concrete);
  g.at(x, 0, z, AX | AZ);
  g.box(-0.5, yb, -0.5, 0.5, yt, 0.5, { part: 5, topPart: 5 });
  g.at(x, yt, z, AALL);
  g.c3(COL.concrete);
  g.box(-0.65, 0, -0.65, 0.65, 0.25, 0.65, { part: 5, topPart: 5 });
  g.c3(COL.black);
  g.box(-0.3, 0.25, -0.3, -0.05, 0.75, -0.05, { part: 5, topPart: 5 });
  g.box(0.05, 0.25, 0.05, 0.3, 0.6, 0.3, { part: 5, topPart: 5 });
  g.ungate().rel().white();
}

/** Dachgaube auf Satteldach-Vorderseite bei (x,z) */
function dormer(g: GB, x: number, z: number, e: number, r: number, thr: number, salt: number): void {
  const y = roofY(e, r, z);
  g.gate(salt, thr);
  g.at(x, y, z, AALL);
  g.c3(COL.plaster);
  g.box(-1.0, -1.4, -0.4, 1.0, 1.35, 1.0, { part: 5, topPart: 5, sides: 15 });
  g.c3(COL.glass);
  g.quad([-0.7, -0.1, 1.012], [0.7, -0.1, 1.012], [0.7, 1.05, 1.012], [-0.7, 1.05, 1.012], [0, 0, 1], -1, 0, 8);
  g.c3(COL.white);
  g.quad([-0.7, 0.35, 1.02], [0.7, 0.35, 1.02], [0.7, 0.42, 1.02], [-0.7, 0.42, 1.02], [0, 0, 1], -1, 0, 5);
  g.quad([-0.04, -0.1, 1.022], [0.04, -0.1, 1.022], [0.04, 1.05, 1.022], [-0.04, 1.05, 1.022], [0, 0, 1], -1, 0, 5);
  // Satteldächlein
  g.c3(COL.tile);
  g.gate(salt, thr);
  g.slab([-1.2, 1.3, 1.25], [1.2, 1.3, 1.25], [1.2, 2.35, 0.3], [-1.2, 2.35, 0.3], [0, 1, 1], 3);
  g.slab([1.2, 1.3, -0.5], [-1.2, 1.3, -0.5], [-1.2, 2.35, 0.3], [1.2, 2.35, 0.3], [0, 1, -1], 3);
  g.c3(COL.plaster);
  g.tri([1.0, 1.3, 1.0], [1.0, 1.3, -0.4], [1.0, 2.3, 0.3], [1, 0, 0], -1, 0, 5);
  g.tri([-1.0, 1.3, -0.4], [-1.0, 1.3, 1.0], [-1.0, 2.3, 0.3], [-1, 0, 0], -1, 0, 5);
  g.ungate().rel().white();
}

/** Oberlicht/Solarpaneele auf der Vorderseite eines Satteldachs (rel. Modus) */
function skylights(g: GB, e: number, r: number, thr: number, salt: number, solar: boolean): void {
  const z0 = 0.12, z1 = 0.36;
  const y0 = roofY(e, r, z0) + 0.004, y1 = roofY(e, r, z1) + 0.004;
  g.gate(salt, thr);
  if (solar) {
    g.c3(COL.solar);
    for (const [xa, xb] of [[-0.42, -0.2], [-0.17, 0.05], [0.08, 0.3]]) g.quad([xa, y1, z1], [xb, y1, z1], [xb, y0, z0], [xa, y0, z0], [0, 1, 1], -1, 0, 5);
    g.c3(COL.pipe);
    for (const xa of [-0.42, -0.17, 0.08]) g.quad([xa - 0.004, y1, z1], [xa, y1, z1], [xa, y0, z0], [xa - 0.004, y0, z0], [0, 1, 1], -1, 0, 5);
  } else {
    g.c3(COL.glass);
    g.quad([0.1, y1, z1], [0.22, y1, z1], [0.22, y0, z0], [0.1, y0, z0], [0, 1, 1], -1, 0, 8);
    g.c3(COL.white);
    g.quad([0.1, y1 + 0.002, z1], [0.22, y1 + 0.002, z1], [0.22, y1 + 0.002, z1 - 0.01], [0.1, y1 + 0.002, z1 - 0.01], [0, 1, 1], -1, 0, 5);
  }
  g.ungate().white();
}

/** TV-Antenne auf dem First */
function tvAntenna(g: GB, x: number, y: number, z: number, thr: number, salt: number): void {
  g.gate(salt, thr);
  g.c3(COL.metal);
  g.at(x, y, z, AALL);
  g.prism([0, 0, 0], [0, 3.2, 0], 0.045, 5);
  for (let k = 0; k < 4; k++) g.prism([-0.6 + (k % 2) * 0.1, 1.5 + k * 0.5, 0], [0.6 - (k % 2) * 0.1, 1.5 + k * 0.5, 0], 0.03, 5);
  g.prism([0, 0.3, 0], [0.4, 1.1, 0], 0.03, 5);
  g.ungate().rel().white();
}

/** Satellitenschüssel an einer Wand (Ebene z) */
function dish(g: GB, x: number, yRel: number, z: number, thr: number, salt: number, sg = 1): void {
  g.gate(salt, thr);
  g.at(x, yRel, z, AX | AZ);
  g.c3(COL.white);
  g.rel();
  g.at(x, yRel, z, AALL);
  g.discZ(0, 0, 0.7 * sg, 0.55, 8, 5, sg);
  g.c3(COL.metal);
  g.prism([0, 0, 0], [0, 0, 0.7 * sg], 0.04, 5);
  g.prism([0, 0, 0.7 * sg], [0, -0.45, 0.7 * sg], 0.025, 5);
  g.ungate().rel().white();
}

/** Klimageräte, Aufbauten auf Flachdach: Anker bei (x, y, z) Einheiten */
function roofUnits(g: GB, y: number, salt: number, list: Array<[number, number, number, number]>): void {
  // [x, z, kind(0 AC,1 Aufzug,2 Tank,3 Solar), thr]
  for (const [x, z, kind, thr] of list) {
    g.gate(salt + kind, thr);
    g.at(x, y, z, AALL);
    if (kind === 0) {
      g.c3(COL.metal);
      g.box(-0.7, 0, -0.5, 0.7, 0.9, 0.5, { part: 5, topPart: 5 });
      g.c3(COL.darkMetal);
      g.discZ(0, 0.45, 0.502, 0.3, 6, 5);
      g.box(-0.5, 0.9, -0.3, 0.5, 1.05, 0.3, { part: 5, topPart: 5 });
    } else if (kind === 1) {
      g.c3(COL.concrete);
      g.box(-2.0, 0, -2.0, 2.0, 2.8, 2.0, { part: 5, topPart: 5 });
      g.c3(COL.darkMetal);
      g.box(-0.6, 0, 2.0, 0.6, 2.0, 2.04, { part: 5, topPart: 5 });
    } else if (kind === 2) {
      g.c3(COL.rust);
      g.tube(0, 0, 1.0, 3.6, 1.3, 1.3, 8, 5, -1);
      g.tube(0, 0, 3.6, 4.3, 1.3, 0.2, 8, 5, -1);
      g.c3(COL.darkMetal);
      for (const [lx, lz] of [[-0.9, -0.9], [0.9, -0.9], [0.9, 0.9], [-0.9, 0.9]]) g.prism([lx, 0, lz], [lx * 0.9, 1.1, lz * 0.9], 0.07, 5);
    } else {
      g.c3(COL.solar);
      for (let k = 0; k < 3; k++) {
        const x0 = -2.4 + k * 1.6;
        g.quad([x0, 0.3, 0.9], [x0 + 1.4, 0.3, 0.9], [x0 + 1.4, 1.3, -0.6], [x0, 1.3, -0.6], [0, 1, 0.6], -1, 0, 5);
      }
      g.c3(COL.pipe);
      g.prism([-2.4, 0, 0.6], [-2.4, 1.0, -0.4], 0.04, 5);
      g.prism([2.2, 0, 0.6], [2.2, 1.0, -0.4], 0.04, 5);
    }
    g.ungate().rel().white();
  }
}

/** Ladenzone an der Vorderseite (z = 0.5): Schaufenster, Schild, Markise, Pfeiler. x0..x1 relativ */
function shopfront(g: GB, x0: number, x1: number, thr: number, salt: number): void {
  g.gate(salt, thr);
  const zf = 0.5;
  // Schaufenster (Teil 6), Rahmen
  g.at(0, 0, zf, AY | AZ);
  g.c3(COL.glass);
  g.quad([x0, 0.45, 0.14], [x1, 0.45, 0.14], [x1, 2.75, 0.14], [x0, 2.75, 0.14], [0, 0, 1], -1, 0, 6);
  g.c3(COL.darkMetal);
  g.box(x0 - 0.004, 0.0, 0.0, x1 + 0.004, 0.45, 0.2, { part: 5, topPart: 5 });
  g.box(x0 - 0.004, 2.75, 0.0, x1 + 0.004, 2.9, 0.2, { part: 5, topPart: 5 });
  const nm = 4;
  for (let k = 0; k <= nm; k++) {
    const xm = x0 + ((x1 - x0) * k) / nm;
    g.box(xm - 0.004, 0.45, 0.0, xm + 0.004, 2.75, 0.22, { part: 5, topPart: 5 });
  }
  // Schildband (Akzentfarbe) mit Schriftzug-Platte
  g.c3(COL.white);
  g.rel();
  g.at(0, 0, zf, AY | AZ);
  g.c3([1, 1, 1]);
  g.box(x0 - 0.004, 2.95, 0.0, x1 + 0.004, 3.75, 0.3, { part: 7, topPart: 7 });
  g.c3(COL.sign);
  g.quad([x0 + (x1 - x0) * 0.12, 3.05, 0.31], [x1 - (x1 - x0) * 0.12, 3.05, 0.31], [x1 - (x1 - x0) * 0.12, 3.6, 0.31], [x0 + (x1 - x0) * 0.12, 3.6, 0.31], [0, 0, 1], -1, 0, 5);
  g.c3(COL.black);
  g.quad([x0 + (x1 - x0) * 0.22, 3.2, 0.312], [x1 - (x1 - x0) * 0.22, 3.2, 0.312], [x1 - (x1 - x0) * 0.22, 3.45, 0.312], [x0 + (x1 - x0) * 0.22, 3.45, 0.312], [0, 0, 1], -1, 0, 5);
  // Markise (schräg, gestreift)
  g.c3(COL.white);
  const ns = 8;
  g.gate(salt, thr * 0.6);
  for (let k = 0; k < ns; k++) {
    const xa = x0 + ((x1 - x0) * k) / ns, xb = x0 + ((x1 - x0) * (k + 1)) / ns;
    g.c3(k % 2 ? COL.white : [1, 1, 1]);
    g.quad([xa, 2.95, 0.3], [xb, 2.95, 0.3], [xb, 2.55, 1.6], [xa, 2.55, 1.6], [0, 1, 1], -1, 0, k % 2 ? 5 : 7);
    g.quad([xa, 2.55, 1.6], [xb, 2.55, 1.6], [xb, 2.35, 1.6], [xa, 2.35, 1.6], [0, 0, 1], -1, 0, k % 2 ? 5 : 7);
  }
  g.ungate().rel().white();
}

/** Eingang: Tür, Rahmen, Stufen, Vordach (thr: Vordach) an Position x (Einheiten) der Vorderseite z=+0.5 */
function entrance(g: GB, x: number, salt: number, canopy: number): void {
  g.at(x, 0, 0.5, AALL);
  g.c3(COL.concrete);
  g.box(-1.4, 0, 0, 1.4, 0.2, 1.1, { part: 5, topPart: 5 });
  g.box(-1.15, 0.2, 0, 1.15, 0.4, 0.7, { part: 5, topPart: 5 });
  g.c3(COL.darkMetal);
  g.box(-0.62, 0.4, -0.02, 0.62, 2.25, 0.12, { part: 5, topPart: 5 });
  g.c3(COL.white);
  g.rel();
  g.at(x, 0, 0.5, AALL);
  g.c3([1, 1, 1]);
  g.quad([-0.5, 0.4, 0.125], [0.5, 0.4, 0.125], [0.5, 2.15, 0.125], [-0.5, 2.15, 0.125], [0, 0, 1], -1, 0, 7);
  g.c3(COL.glass);
  g.quad([-0.3, 1.2, 0.13], [0.3, 1.2, 0.13], [0.3, 2.0, 0.13], [-0.3, 2.0, 0.13], [0, 0, 1], -1, 0, 8);
  g.c3(COL.metal);
  g.box(0.32, 1.0, 0.13, 0.4, 1.15, 0.22, { part: 5, topPart: 5 });
  if (canopy > 0) {
    g.gate(salt, canopy);
    g.c3(COL.concrete);
    g.box(-1.5, 2.55, 0, 1.5, 2.72, 1.7, { part: 5, topPart: 5 });
    g.c3(COL.darkMetal);
    g.prism([-1.35, 0, 1.55], [-1.35, 2.55, 1.55], 0.06, 5);
    g.prism([1.35, 0, 1.55], [1.35, 2.55, 1.55], 0.06, 5);
    g.ungate();
  }
  g.rel().white();
}

/** Balkone: Platte + Brüstung, storeys = Liste der Geschosse (Anker y = 0 in Einheiten, Offset m) */
function balconies(g: GB, x: number, storeys: number[], e: number, salt: number, thr: number, wide = 2.6): void {
  for (const s of storeys) {
    g.gate(salt, thr, e - 0.02, s * 3.4);
    g.at(x, 0, 0.5, AALL);
    const y = s * 3.4;
    g.c3(COL.concrete);
    g.box(-wide / 2, y, 0, wide / 2, y + 0.16, 1.3, { part: 5, topPart: 5 });
    g.c3(COL.darkMetal);
    g.quad([-wide / 2, y + 0.16, 1.3], [wide / 2, y + 0.16, 1.3], [wide / 2, y + 1.1, 1.3], [-wide / 2, y + 1.1, 1.3], [0, 0, 1], -1, 0, 5);
    g.quad([-wide / 2, y + 0.16, 0], [-wide / 2, y + 0.16, 1.3], [-wide / 2, y + 1.1, 1.3], [-wide / 2, y + 1.1, 0], [-1, 0, 0], -1, 0, 5);
    g.quad([wide / 2, y + 0.16, 1.3], [wide / 2, y + 0.16, 0], [wide / 2, y + 1.1, 0], [wide / 2, y + 1.1, 1.3], [1, 0, 0], -1, 0, 5);
    g.c3(COL.metal);
    g.prism([-wide / 2, y + 1.1, 1.3], [wide / 2, y + 1.1, 1.3], 0.03, 5, false);
    g.ungate().rel();
  }
  g.white();
}

/** Flachdach-Brüstung (Attika) rundum bei y (Einheiten) */
function parapet(g: GB, y: number, h = 0.9, thick = 0.35, col: V3 = COL.concrete): void {
  g.c3(col);
  g.at(0, y, 0.5, AY | AZ);
  g.box(-0.5, 0, -thick, 0.5, h, 0, { part: 5, topPart: 5 });
  g.at(0, y, -0.5, AY | AZ);
  g.box(-0.5, 0, 0, 0.5, h, thick, { part: 5, topPart: 5 });
  g.at(0.5, y, 0, AX | AY);
  g.box(-thick, 0, -0.5, 0, h, 0.5, { part: 5, topPart: 5 });
  g.at(-0.5, y, 0, AX | AY);
  g.box(0, 0, -0.5, thick, h, 0.5, { part: 5, topPart: 5 });
  g.rel().white();
}

// ====================================================================== Prototypen (intakt)
// Teile: 0 Wand (Instanzfarbe), 1 Dach, 2 dunkel, 3 Ziegel, 4 Beton, 5 abs. Farbe, 6 Schaufenster, 7 Akzent, 8 Glas, 9 Signallicht

function protoOld(): GB {
  const g = new GB();
  const e = 0.62, r = 0.92;
  g.box(-0.5, -0.4, -0.5, 0.5, e, 0.5, { f: 0, endF: -1, top: 0 });
  bands(g, e, { plinth: true, cornice: true });
  g.gable(-0.5, 0.5, e, r, -0.5, 0.5, 0);
  gutters(g, e);
  // First
  g.c3(mulc(COL.tile, 0.8));
  g.at(0, r, 0, AY | AZ);
  g.box(-0.52, -0.08, -0.25, 0.52, 0.32, 0.25, { part: 5, topPart: 5, sides: 15 });
  g.rel().white();
  chimney(g, -0.3, -0.05, e, r, 1.0, 1, true);
  chimney(g, 0.28, 0.04, e, r, 0.7, 2, true);
  chimney(g, 0.02, -0.08, e, r, 0.35, 3, false);
  dormer(g, 0.0, 0.26, e, r, 0.7, 4);
  dormer(g, -0.28, 0.26, e, r, 0.45, 5);
  dormer(g, 0.3, -0.26, e, r, 0.5, 6);
  skylights(g, e, r, 0.4, 7, false);
  tvAntenna(g, 0.38, r + 0.012, 0.0, 0.5, 8);
  dish(g, -0.3, 0.45, 0.5, 0.35, 9, 1);
  // Erdgeschoss: Eingang + Laden / Balkone
  entrance(g, 0.34, 10, 0.6);
  shopfront(g, -0.46, 0.2, 0.5, 11);
  balconies(g, -0.12, [2, 3], e, 12, 0.5, 2.4);
  // Klimagerät an der Seitenwand
  g.gate(13, 0.3).at(0.5, 0.35, 0.1, AALL).c3(COL.metal).box(0, 0, -0.5, 0.45, 0.8, 0.5, { part: 5, topPart: 5 });
  g.ungate().rel().white();
  return g;
}

function protoHip(): GB {
  const g = new GB();
  const e = 0.6, r = 0.92;
  g.box(-0.5, -0.4, -0.5, 0.5, e, 0.5, { f: 8, endF: 8, top: 0 });
  bands(g, e, { plinth: true, cornice: true, corniceCol: lin(0xe8dfc8) });
  g.hip(-0.5, 0.5, e, r, -0.5, 0.5, 0.2);
  gutters(g, e, 0.03, true);
  g.c3(mulc(COL.tile, 0.75));
  g.at(0, r, 0, AY | AZ);
  g.box(-0.2, -0.07, -0.2, 0.2, 0.3, 0.2, { part: 5, topPart: 5 });
  g.rel().white();
  g.c3(COL.brick).at(0.16, 0, 0.02, AX | AZ).box(-0.5, r - 0.1, -0.5, 0.5, r + 0.06, 0.5, { part: 5, topPart: 5 });
  g.at(0.16, r + 0.06, 0.02, AALL).c3(COL.concrete).box(-0.65, 0, -0.65, 0.65, 0.22, 0.65, { part: 5, topPart: 5 });
  g.rel().white();
  // Terrakotta-Streifen am Dachfuß, Solar auf Vorderseite
  skylights(g, e, r, 0.3, 21, true);
  tvAntenna(g, -0.1, r, 0, 0.45, 22);
  dish(g, 0.3, 0.45, 0.5, 0.4, 23, 1);
  entrance(g, 0.3, 24, 0.55);
  balconies(g, -0.18, [1, 2], e, 25, 0.55, 2.6);
  // Markise über dem Erdgeschossfenster
  g.gate(26, 0.5).c3(COL.white);
  g.at(-0.25, 0, 0.5, AALL);
  for (let k = 0; k < 6; k++) {
    g.c3(k % 2 ? COL.white : [1, 1, 1]);
    g.quad([-1.5 + k * 0.5, 3.0, 0.1], [-1.0 + k * 0.5, 3.0, 0.1], [-1.0 + k * 0.5, 2.5, 1.5], [-1.5 + k * 0.5, 2.5, 1.5], [0, 1, 1], -1, 0, k % 2 ? 5 : 7);
  }
  g.ungate().rel().white();
  return g;
}

function protoMid(): GB {
  const g = new GB();
  const top = 0.93;
  g.box(-0.5, -0.4, -0.5, 0.5, top, 0.5, { f: 2, endF: -1, topPart: 4 });
  bands(g, top, { plinth: true, cornice: true, corniceCol: lin(0xb8b4aa) });
  parapet(g, top, 0.9, 0.3, COL.concrete);
  g.c3(COL.tar).box(-0.49, top + 0.001, -0.49, 0.49, top + 0.001, 0.49, { top: 1, topPart: 5, sides: 0 });
  g.white();
  roofUnits(g, top + 0.002, 40, [[-0.3, 0.1, 1, 1.0], [0.2, -0.25, 0, 0.8], [-0.1, -0.3, 0, 0.6], [0.3, 0.25, 2, 0.5], [-0.38, -0.2, 3, 0.4], [0.05, 0.3, 0, 0.45]]);
  tvAntenna(g, 0.4, top + 0.002, 0.3, 0.5, 41);
  dish(g, -0.2, 0.5, 0.5, 0.45, 42, 1);
  dish(g, 0.3, 0.38, 0.5, 0.3, 43, 1);
  entrance(g, 0.0, 44, 1.0);
  shopfront(g, -0.46, -0.12, 0.55, 45);
  shopfront(g, 0.12, 0.46, 0.4, 46);
  balconies(g, -0.3, [1, 2, 3, 4], top, 47, 0.6, 2.4);
  balconies(g, 0.32, [1, 2, 3, 4], top, 48, 0.4, 2.4);
  // Fallrohre
  g.c3(COL.pipe);
  for (const [px, pz] of [[-0.49, 0.5], [0.49, 0.5], [-0.49, -0.5], [0.49, -0.5]]) {
    g.at(px, 0, pz, AX | AZ);
    const sg = pz > 0 ? 1 : -1;
    g.box(-0.07, 0, sg > 0 ? 0 : -0.14, 0.07, top, sg > 0 ? 0.14 : 0, { part: 5, topPart: 5 });
  }
  g.rel().white();
  return g;
}

function protoPlatte(): GB {
  const g = new GB();
  const top = 0.95;
  g.box(-0.5, -0.4, -0.5, 0.5, top, 0.5, { f: 1, endF: -1, topPart: 4 });
  bands(g, top, { plinth: true, corniceCol: lin(0xa8a69e) });
  parapet(g, top, 0.7, 0.25, lin(0x9e9c94));
  // Treppenhaus-Türme (Vorderseite) + Laubengang
  for (const [x, th] of [[-0.3, 0.55], [0.0, 0.35], [0.3, 0.7]] as Array<[number, number]>) {
    void th;
    g.at(x, 0, 0.5, AX | AZ);
    g.c3(lin(0xb2b0a6));
    g.box(-1.7, 0, 0, 1.7, top + 0.012, 1.9, { part: 5, topPart: 5, sides: 15 });
    g.rel().at(x, 0, 0.5, AALL);
    g.c3(COL.glass);
    g.quad([-1.2, 0.5, 1.92], [1.2, 0.5, 1.92], [1.2, 2.6, 1.92], [-1.2, 2.6, 1.92], [0, 0, 1], -1, 0, 6);
    g.c3(COL.darkMetal);
    g.box(-0.5, 0.0, 1.9, 0.5, 2.3, 2.0, { part: 5, topPart: 5, sides: 1 });
    // Treppenhaus-Fensterband
    g.c3(COL.glass);
    g.quad([-0.5, 4.4, 1.92], [0.5, 4.4, 1.92], [0.5, 12.0, 1.92], [-0.5, 12.0, 1.92], [0, 0, 1], -1, 0, 8);
    g.rel().white();
  }
  g.c3(COL.concrete);
  roofUnits(g, top + 0.002, 62, [[-0.35, 0.1, 1, 1.0], [0.15, -0.1, 1, 1.0], [0.4, 0.2, 0, 0.7], [-0.1, 0.3, 0, 0.6], [0.0, -0.3, 2, 0.4]]);
  tvAntenna(g, 0.1, top + 0.002, 0.2, 0.5, 63);
  tvAntenna(g, -0.2, top + 0.002, -0.2, 0.3, 64);
  for (let k = 0; k < 5; k++) dish(g, -0.4 + k * 0.2, 0.2 + (k % 3) * 0.12, 0.5, 0.5, 65 + k, 1);
  // Stufen vor den Treppenhäusern
  g.c3(COL.concrete);
  for (const x of [-0.3, 0.0, 0.3]) {
    g.at(x, 0, 0.5, AX | AZ | AY);
    g.box(-1.3, 0, 1.9, 1.3, 0.3, 3.0, { part: 5, topPart: 5 });
    g.box(-1.0, 0.3, 1.9, 1.0, 0.6, 2.4, { part: 5, topPart: 5 });
    g.rel();
  }
  g.white();
  // Garagen-/Müllhaus am Gebäudefuß
  g.c3(COL.metal).at(0.42, 0, 0.5, AALL).gate(73, 0.6);
  g.box(-1.5, -0.3, 0.5, 1.5, 2.2, 3.0, { part: 5, topPart: 5 });
  g.ungate().rel().white();
  return g;
}

function protoHall(): GB {
  const g = new GB();
  const e = 0.6;
  g.box(-0.5, -0.4, -0.5, 0.5, e, 0.5, { f: 4, endF: 4, top: 0 });
  g.c3(COL.concrete);
  bands(g, e, { plinth: true });
  const n = 4;
  for (let k = 0; k < n; k++) {
    const x0 = -0.5 + k * (1 / n), x1 = x0 + 1 / n;
    g.quad([x0, e, 0.5], [x1, 0.92, 0.5], [x1, 0.92, -0.5], [x0, e, -0.5], [0, 1, 0], -1, 0, 1, 1, 1, [[0, 0], [1, 0], [1, 1], [0, 1]]);
    g.quad([x1, e, 0.5], [x1, e, -0.5], [x1, 0.92, -0.5], [x1, 0.92, 0.5], [1, 0, 0], 4, 1, 0, 1, 0.3);
    g.tri([x0, e, 0.5], [x1, e, 0.5], [x1, 0.92, 0.5], [0, 0, 1], -1, 0, 0);
    g.tri([x1, e, -0.5], [x0, e, -0.5], [x1, 0.92, -0.5], [0, 0, -1], -1, 0, 0);
    // Rinnen / Lüfter auf der Schräge
    g.c3(COL.metal).at(0, 0, 0, AY).box(x0 + 0.02, e + 0.0, -0.45, x0 + 0.04, e + 0.01, 0.45, { part: 5, sides: 0, top: 0 });
    g.rel().white();
  }
  // Rampe + Verladetore an der Vorderseite
  g.c3(COL.concrete);
  g.at(0, 0, 0.5, AY | AZ);
  g.box(-0.46, 0, 0, 0.46, 1.1, 5.5, { part: 5, topPart: 5 });
  g.rel();
  for (let k = 0; k < 4; k++) {
    const x = -0.33 + k * 0.22;
    g.at(x, 0, 0.5, AALL);
    g.c3(COL.darkMetal);
    g.box(-1.6, 1.1, -0.04, 1.6, 4.4, 0.25, { part: 5, topPart: 5 });
    g.c3(lin(k % 2 ? 0x8a9aa8 : 0x9aa68a));
    g.quad([-1.35, 1.15, 0.27], [1.35, 1.15, 0.27], [1.35, 4.2, 0.27], [-1.35, 4.2, 0.27], [0, 0, 1], -1, 0, 5);
    g.c3(COL.black);
    for (let q = 0; q < 5; q++) g.quad([-1.35, 1.6 + q * 0.6, 0.275], [1.35, 1.6 + q * 0.6, 0.275], [1.35, 1.7 + q * 0.6, 0.275], [-1.35, 1.7 + q * 0.6, 0.275], [0, 0, 1], -1, 0, 5);
    // Gummipuffer
    g.c3(COL.black);
    g.box(-1.5, 1.2, 0.0, -1.1, 2.0, 0.4, { part: 5, topPart: 5 });
    g.box(1.1, 1.2, 0.0, 1.5, 2.0, 0.4, { part: 5, topPart: 5 });
    // Vordach
    g.c3(COL.metal);
    g.box(-1.9, 4.7, 0, 1.9, 4.85, 3.2, { part: 5, topPart: 5 });
    g.rel();
  }
  // Personaleingang + Büroanbau (Ecke, Flachdach)
  entrance(g, 0.43, 80, 0.8);
  g.c3(lin(0xc9c6bc));
  g.at(-0.5, 0, 0.5, AALL);
  g.box(-3.0, -0.3, -9, 9.0, 4.6, 5.0, { part: 5, topPart: 5 });
  g.rel().white();
  // Rohre an der Seitenwand, Dachlüfter, Schornstein
  g.c3(COL.pipe);
  for (let k = 0; k < 3; k++) {
    g.at(0.5, 0, 0, AX | AY);
    g.prism([0.3 + k * 0.5, 4.5 + k * 0.5, -0.45], [0.3 + k * 0.5, 4.5 + k * 0.5, 0.45], 0.2, 5);
  }
  g.rel().white();
  roofUnits(g, 0.89, 81, [[-0.27, 0.2, 0, 0.8], [-0.02, -0.2, 0, 0.7], [0.23, 0.1, 2, 0.4]]);
  g.c3(COL.metal);
  for (let k = 0; k < 3; k++) {
    g.at(-0.4 + k * 0.4, 0.62 + k * 0.1, 0.1, AALL);
    g.box(-0.5, 0, -0.5, 0.5, 0.5, 0.5, { part: 5, topPart: 5 });
    g.tube(0, 0, 0.5, 0.9, 0.55, 0.55, 6, 5, 5);
  }
  g.rel().white();
  g.c3(COL.brick).at(0.38, 0.6, -0.1, AX | AZ).box(-0.5, 0.58, -0.5, 0.5, 0.97, 0.5, { part: 5, topPart: 5 });
  g.rel().white();
  return g;
}

function protoSilo(): GB {
  const g = new GB();
  g.tube(0, 0, -0.4, 0.78, 0.5, 0.5, 10, 4, -1);
  g.tube(0, 0, 0.78, 0.92, 0.5, 0.3, 10, 4, -1);
  g.tube(0, 0, 0.92, 1.0, 0.3, 0.05, 10, 2, 2);
  // Ringbänder
  g.c3(COL.metal);
  for (let k = 1; k <= 4; k++) g.tube(0, 0, k * 0.16 - 0.008, k * 0.16 + 0.008, 0.512, 0.512, 10, 5, -1);
  g.c3(COL.concrete);
  g.tube(0, 0, 0, 0.04, 0.56, 0.56, 10, 5, 5);
  g.white();
  // Leiter (Seitenholme + Sprossen)
  g.c3(COL.metal);
  g.at(0.5, 0, 0, AX | AZ);
  g.prism([0.1, 0, -0.35], [0.1, 0.9, -0.35], 0.035, 5);
  g.prism([0.1, 0, 0.35], [0.1, 0.9, 0.35], 0.035, 5);
  g.rel();
  for (let k = 0; k < 10; k++) {
    g.at(0.5, 0.05 + k * 0.085, 0, AALL);
    g.prism([0.1, 0, -0.35], [0.1, 0, 0.35], 0.02, 5, false);
  }
  g.rel().white();
  // Rohr zum Nachbarsilo + Laufsteg oben, Luke
  g.c3(COL.pipe);
  g.at(0, 0.95, 0, AY);
  g.prism([0.3, 0.0, 0.0], [0.7, 0.0, 0.2], 0.2, 5);
  g.rel().c3(COL.rust);
  g.at(0, 0.99, 0, AY);
  g.box(-0.12, 0, -0.12, 0.12, 0.8, 0.12, { part: 5, topPart: 5 });
  g.rel().white();
  g.c3(COL.metal).at(0.48, 0.15, 0.25, AY | AX | AZ);
  g.box(-0.6, 0, -0.3, 0.1, 1.2, 0.3, { part: 5, topPart: 5 });
  g.rel().white();
  return g;
}

function protoStack(): GB {
  const g = new GB();
  const bands4 = [0, 0.14, 0.28, 0.42, 0.56, 0.7, 0.84];
  // rot-weiß geringelt in der oberen Hälfte
  const radius = (y: number) => 0.5 - 0.23 * y;
  g.c3(COL.concrete).tube(0, 0, -0.4, 0.14, radius(0), radius(0.14), 10, 5, -1);
  for (let k = 1; k < bands4.length; k++) {
    g.c3(k % 2 ? COL.red : COL.white);
    const y0 = bands4[k], y1 = k + 1 < bands4.length ? bands4[k + 1] : 1.0;
    g.tube(0, 0, y0, y1, radius(y0), radius(y1), 10, 5, k + 1 < bands4.length ? -1 : 5);
  }
  g.c3(COL.darkMetal);
  g.tube(0, 0, 0.995, 1.01, 0.28, 0.28, 10, 5, 5);
  g.white();
  g.c3(COL.metal);
  g.at(0.5, 0, 0, AX | AZ);
  g.prism([0.08, 0, -0.1], [0.08, 0.7, -0.1], 0.03, 5);
  g.prism([0.08, 0, 0.1], [0.08, 0.7, 0.1], 0.03, 5);
  g.rel().c3(COL.concrete);
  g.at(0, 0, 0, AY);
  g.box(-0.62, 0, -0.62, 0.62, 2.0, 0.62, { part: 5, topPart: 5 });
  g.rel().white();
  // Signallichter
  g.at(0, 0.97, 0, AALL);
  g.box(-0.4, 0, -0.4, 0.4, 0.8, 0.4, { part: 9, topPart: 9 });
  g.rel();
  return g;
}

function protoTower(): GB {
  const g = new GB();
  g.box(-0.5, -0.4, -0.5, 0.5, 0.66, 0.5, { f: 3, endF: 3, topPart: 4 });
  g.box(-0.38, 0.66, -0.38, 0.38, 0.86, 0.38, { f: 7, endF: 7, topPart: 4 });
  g.box(-0.26, 0.86, -0.26, 0.26, 0.96, 0.26, { f: 7, endF: 7, topPart: 4 });
  // Sockel / Lobby, Vordach
  g.c3(lin(0x6a6e76));
  g.at(0, 0, 0, AY);
  g.box(-0.515, 0, -0.515, 0.515, 5.2, 0.515, { part: 5, topPart: 5 });
  g.rel();
  g.c3(COL.glass).at(0, 0, 0.515, AY | AZ);
  g.quad([-0.45, 0.4, 0.05], [0.45, 0.4, 0.05], [0.45, 4.6, 0.05], [-0.45, 4.6, 0.05], [0, 0, 1], -1, 0, 6);
  g.c3(COL.concrete);
  g.box(-0.3, 5.0, 0, 0.3, 5.25, 6.0, { part: 5, topPart: 5 });
  g.rel().white();
  // Gesimsbänder an Rücksprüngen
  bandsAt(g, 0.66, 0.38, lin(0x7a7e86));
  bandsAt(g, 0.86, 0.26, lin(0x7a7e86));
  bandsAt(g, 0.96, 0.26, lin(0x7a7e86));
  // senkrechte Rippen (Fassadenraster)
  g.c3(lin(0x5a5e66));
  for (let k = 0; k < 6; k++) {
    const x = -0.5 + (k + 0.5) / 6;
    g.at(x, 0, 0.5, AX | AZ);
    g.box(-0.18, 0.06, 0.0, 0.18, 0.64, 0.35, { part: 5, topPart: 5, sides: 1 | 4 | 8 });
    g.rel();
  }
  g.white();
  // Dachkrone: Technikgeschoss, Fensterputzanlage, Antennen, Warnlichter
  g.c3(COL.metal).at(0, 0.96, 0, AY);
  g.box(-0.18, 0, -0.18, 0.18, 4.0, 0.18, { part: 5, topPart: 5 });
  g.rel().white();
  roofUnits(g, 0.96, 90, [[-0.12, 0.1, 0, 1.0], [0.1, -0.12, 0, 0.9], [0.12, 0.14, 2, 0.6], [-0.15, -0.14, 0, 0.7]]);
  g.at(0, 0.96, 0, AALL);
  g.c3(COL.metal);
  g.prism([0.12, 4.0, -0.12], [0.12, 22.0, -0.12], 0.08, 5);
  g.prism([-0.1, 4.0, 0.1], [-0.1, 13.0, 0.1], 0.06, 5);
  g.prism([-6, 17, -0.12], [6, 17, -0.12], 0.04, 5, false);
  g.c3(COL.red);
  g.box(-0.2, 22.0, -0.2, 0.2, 22.6, 0.2, { part: 9, topPart: 9 });
  g.box(-0.3, 13.0, -0.0, 0.1, 13.5, 0.4, { part: 9, topPart: 9 });
  g.rel().white();
  // Eckkanten-Lichter auf Rücksprung
  g.c3(COL.red).at(0, 0.86, 0, AALL);
  for (const [cx, cz] of [[-0.26, -0.26], [0.26, 0.26]]) {
    g.at(cx, 0.86, cz, AALL);
    g.box(-0.2, 0, -0.2, 0.2, 0.5, 0.2, { part: 9, topPart: 9 });
  }
  g.rel().white();
  return g;
}

function bandsAt(g: GB, y: number, half: number, col: V3): void {
  g.c3(col);
  for (const sg of [1, -1]) {
    g.at(0, y, sg * half, AY | AZ);
    g.box(-half, -0.5, sg > 0 ? 0 : -0.35, half, 0.5, sg > 0 ? 0.35 : 0, { part: 5, topPart: 5, sides: sg > 0 ? 1 : 2 });
    g.at(sg * half, y, 0, AX | AY);
    g.box(sg > 0 ? 0 : -0.35, -0.5, -half, sg > 0 ? 0.35 : 0, 0.5, half, { part: 5, topPart: 5, sides: sg > 0 ? 4 : 8 });
  }
  g.rel().white();
}

function protoChurch(): GB {
  const g = new GB();
  const e = 0.26;
  g.box(-0.5, -0.4, -0.3, 0.15, e, 0.3, { f: 5, endF: -1, top: 0 });
  g.gable(-0.5, 0.15, e, 0.4, -0.3, 0.3, 0, 6, 0.04, 0.0);
  g.c3(lin(0x7a7a72));
  g.at(0, 0, 0, AY);
  g.rel();
  // Strebepfeiler
  g.c3(lin(0xb2a998));
  for (let k = 0; k < 4; k++) {
    for (const sg of [1, -1]) {
      g.at(-0.42 + k * 0.17, 0, sg * 0.3, AX | AZ);
      g.box(-0.45, 0, sg > 0 ? 0 : -0.9, 0.45, e * 0.9, sg > 0 ? 0.9 : 0, { part: 5, topPart: 5 });
      g.rel();
    }
  }
  g.white();
  // Apsis
  g.c3(lin(0xb8ae9c));
  g.tube(-0.5, 0, 0, e, 0.28, 0.28, 6, 5, -1);
  g.c3(COL.tile);
  g.tube(-0.5, 0, e, 0.4, 0.3, 0.02, 6, 5, 5);
  g.white();
  // Turm
  g.box(0.15, -0.4, -0.17, 0.5, 0.5, 0.17, { f: 5, endF: 5, topPart: 2 });
  g.c3(lin(0xb4ab9a));
  g.box(0.15, 0.46, -0.19, 0.5, 0.5, 0.19, { part: 5, topPart: 5 });
  g.white();
  g.pyramid(0.325, 0, 0.17, 0.17, 0.5, 0.96, 1, 5);
  // Schalllamellen + Uhren
  g.c3(COL.darkMetal);
  for (const sg of [1, -1]) {
    g.at(0.325, 0.42, sg * 0.17, AX | AZ);
    g.box(-0.55, -0.5, sg > 0 ? 0 : -0.06, 0.55, 2.3, sg > 0 ? 0.06 : 0, { part: 5, topPart: 5, sides: sg > 0 ? 1 : 2 });
    g.rel();
  }
  g.c3(COL.sign);
  g.at(0.325, 0.3, 0.17, AALL);
  g.discZ(0, 0, 0.09, 0.9, 10, 5, 1);
  g.rel().c3(COL.black).at(0.325, 0.3, 0.17, AALL);
  g.prism([0, 0, 0.1], [0, 0.6, 0.1], 0.04, 5, false);
  g.prism([0, 0, 0.1], [0.4, 0, 0.1], 0.04, 5, false);
  g.rel().white();
  // Portal + Stufen
  g.c3(COL.concrete).at(0.5, 0, 0, AALL);
  g.box(0.0, -0.2, -1.8, 1.0, 0.5, 1.8, { part: 5, topPart: 5 });
  g.c3(COL.wood);
  g.at(0.5, 0, 0, AALL);
  g.quad([0.015, 0.5, -0.8], [0.015, 0.5, 0.8], [0.015, 3.6, 0.8], [0.015, 3.6, -0.8], [1, 0, 0], -1, 1, 5);
  g.rel().white();
  // Kreuz auf der Turmspitze
  g.c3(COL.metal).at(0.325, 0.96, 0, AALL);
  g.prism([0, 0, 0], [0, 2.4, 0], 0.07, 5);
  g.prism([-0.6, 1.8, 0], [0.6, 1.8, 0], 0.05, 5, false);
  g.rel().white();
  // Eckfialen
  g.c3(lin(0xb4ab9a));
  for (const [cx, cz] of [[0.16, -0.17], [0.16, 0.17], [0.5, -0.17], [0.5, 0.17]]) {
    g.at(cx, 0.5, cz, AALL);
    g.box(-0.3, 0, -0.3, 0.3, 1.2, 0.3, { part: 5, topPart: 5 });
    g.rel();
  }
  g.white();
  return g;
}

function protoWare(): GB {
  const g = new GB();
  g.box(-0.5, -0.4, -0.5, 0.5, 0.8, 0.5, { f: 4, endF: -1, top: 0 });
  bands(g, 0.8, { plinth: true });
  g.gable(-0.5, 0.5, 0.8, 0.96, -0.5, 0.5, 0, 5, 0.02, 0.01);
  gutters(g, 0.8, 0.02, true);
  // Ladetore
  for (let k = 0; k < 3; k++) {
    const x = -0.3 + k * 0.3;
    g.at(x, 0, 0.5, AALL);
    g.c3(COL.darkMetal);
    g.box(-1.9, 0, -0.04, 1.9, 4.6, 0.25, { part: 5, topPart: 5 });
    g.c3(lin(k === 1 ? 0xa86a40 : 0x6a7a8a));
    g.quad([-1.7, 0.1, 0.27], [1.7, 0.1, 0.27], [1.7, 4.4, 0.27], [-1.7, 4.4, 0.27], [0, 0, 1], -1, 0, 5);
    g.c3(COL.black);
    for (let q = 0; q < 6; q++) g.quad([-1.7, 0.5 + q * 0.65, 0.275], [1.7, 0.5 + q * 0.65, 0.275], [1.7, 0.6 + q * 0.65, 0.275], [-1.7, 0.6 + q * 0.65, 0.275], [0, 0, 1], -1, 0, 5);
    g.rel();
  }
  g.white();
  // Dachfirstlüfter, Lichtkuppeln
  g.c3(COL.metal).at(0, 0.96, 0, AALL);
  g.box(-9, 0, -0.5, 9, 0.6, 0.5, { part: 5, topPart: 5 });
  g.rel().white();
  roofUnits(g, 0.88, 100, [[-0.3, 0.25, 0, 0.7], [0.1, -0.3, 0, 0.6], [0.3, 0.2, 3, 0.4]]);
  g.c3(COL.brick).at(0.36, 0.8, -0.1, AX | AZ).box(-0.5, 0.78, -0.5, 0.5, 1.02, 0.5, { part: 5, topPart: 5 });
  g.rel().white();
  entrance(g, 0.45, 101, 0.5);
  return g;
}

function protoVilla(): GB {
  const g = new GB();
  const e = 0.52, r = 0.92;
  g.box(-0.5, -0.4, -0.5, 0.5, e, 0.5, { f: 6, endF: -1, top: 0 });
  bands(g, e, { plinth: true, cornice: false });
  g.gable(-0.5, 0.5, e, r, -0.5, 0.5, 0, 6, 0.04, 0.03);
  gutters(g, e, 0.04, true);
  g.c3(mulc(COL.tile, 0.8)).at(0, r, 0, AY | AZ).box(-0.52, -0.07, -0.18, 0.52, 0.3, 0.18, { part: 5, topPart: 5, sides: 0, top: 0 });
  g.rel().white();
  chimney(g, 0.26, -0.04, e, r, 1.0, 120, true);
  chimney(g, -0.3, 0.04, e, r, 0.4, 121, true);
  dormer(g, -0.05, 0.26, e, r, 0.55, 122);
  skylights(g, e, r, 0.3, 123, true);
  tvAntenna(g, 0.4, r + 0.012, 0.0, 0.55, 124);
  dish(g, 0.35, 0.3, 0.5, 0.3, 125, 1);
  // Veranda / Vorbau mit Giebeldach
  g.c3(lin(0xd8d0b8));
  g.at(-0.17, 0, 0.5, AALL);
  g.box(-2.0, -0.3, 0, 2.0, 3.0, 2.6, { part: 5, topPart: 5, top: 0 });
  g.rel();
  g.at(-0.17, 3.0, 0.5, AALL);
  g.c3(COL.tile);
  g.slab([-2.3, 0, 2.9], [2.3, 0, 2.9], [2.3, 1.5, 0.8], [-2.3, 1.5, 0.8], [0, 1, 1], 3);
  g.slab([2.3, 0, -0.2], [-2.3, 0, -0.2], [-2.3, 1.5, 0.8], [2.3, 1.5, 0.8], [0, 1, -1], 3);
  g.c3(lin(0xd8d0b8));
  g.tri([2.0, 0, 2.6], [2.0, 0, 0], [2.0, 1.3, 1.3], [1, 0, 0], -1, 0, 5);
  g.tri([-2.0, 0, 0], [-2.0, 0, 2.6], [-2.0, 1.3, 1.3], [-1, 0, 0], -1, 0, 5);
  g.rel().white();
  g.at(-0.17, 0, 0.5, AALL);
  g.c3(COL.wood);
  g.box(-0.55, 0, 2.6, 0.55, 2.2, 2.66, { part: 7, topPart: 7, sides: 1 });
  g.c3(COL.white);
  g.box(-0.85, 0, 2.3, -0.75, 3.0, 2.4, { part: 5, topPart: 5 });
  g.box(0.75, 0, 2.3, 0.85, 3.0, 2.4, { part: 5, topPart: 5 });
  g.c3(COL.concrete);
  g.box(-1.2, 0, 2.6, 1.2, 0.3, 3.5, { part: 5, topPart: 5 });
  g.rel().white();
  // Klimagerät Seitenwand / Gartenhaus-Tür hinten
  g.gate(126, 0.3).at(0.5, 0.35, -0.1, AALL).c3(COL.metal).box(0, 0, -0.5, 0.45, 0.8, 0.5, { part: 5, topPart: 5 });
  g.ungate().rel().white();
  return g;
}

function protoBarn(): GB {
  const g = new GB();
  const e = 0.42;
  g.box(-0.5, -0.4, -0.5, 0.5, e, 0.5, { f: 10, endF: 10, top: 0 });
  g.gable(-0.5, 0.5, e, 1.0, -0.5, 0.5, 0, 7, 0.03, 0.03);
  g.c3(lin(0x5a4a3a));
  g.at(0, 0, 0.5, AALL);
  // Scheunentor mit Andreaskreuz
  g.box(-2.3, 0, 0.0, 2.3, 4.6, 0.25, { part: 5, topPart: 5, sides: 1 });
  g.c3(lin(0x8a5a3a));
  g.quad([-2.1, 0.1, 0.27], [2.1, 0.1, 0.27], [2.1, 4.4, 0.27], [-2.1, 4.4, 0.27], [0, 0, 1], -1, 0, 5);
  g.c3(lin(0x3c2c20));
  g.prism([-2.1, 0.1, 0.3], [2.1, 4.4, 0.3], 0.07, 5, false);
  g.prism([-2.1, 4.4, 0.3], [2.1, 0.1, 0.3], 0.07, 5, false);
  g.prism([0, 0.1, 0.3], [0, 4.4, 0.3], 0.06, 5, false);
  g.rel().white();
  // Heuboden-Luke im Giebel
  g.c3(lin(0x3c2c20));
  g.at(0, 0.7, 0.5, AALL);
  g.box(-0.8, 0, 0, 0.8, 1.3, 0.2, { part: 5, topPart: 5, sides: 1 });
  g.c3(lin(0x7a5a3a));
  g.quad([-0.65, 0.1, 0.22], [0.65, 0.1, 0.22], [0.65, 1.2, 0.22], [-0.65, 1.2, 0.22], [0, 0, 1], -1, 0, 5);
  g.rel().white();
  // Dachreiter / Lüfter
  g.c3(lin(0x6a5a4a)).at(0, 1.0, 0, AALL);
  g.box(-0.9, -0.1, -0.5, 0.9, 1.0, 0.5, { part: 5, topPart: 5 });
  g.c3(lin(0x4a4a4e));
  g.slab([-1.1, 1.0, 0.7], [1.1, 1.0, 0.7], [1.1, 1.8, 0], [-1.1, 1.8, 0], [0, 1, 1], 1);
  g.slab([1.1, 1.0, -0.7], [-1.1, 1.0, -0.7], [-1.1, 1.8, 0], [1.1, 1.8, 0], [0, 1, -1], 1);
  g.rel().white();
  // Seitenschuppen / Heulager
  g.c3(lin(0x7a6a58));
  g.at(0.5, 0, -0.1, AALL).gate(130, 0.5);
  g.box(0, -0.3, -2.4, 3.2, 2.8, 2.4, { part: 5, topPart: 5 });
  g.c3(lin(0x5a5a5e));
  g.quad([0, 2.8, 2.6], [3.4, 2.1, 2.6], [3.4, 2.1, -2.6], [0, 2.8, -2.6], [0, 1, 0], -1, 0, 5);
  g.ungate().rel().white();
  return g;
}

function protoStable(): GB {
  const g = new GB();
  const e = 0.5;
  g.box(-0.5, -0.4, -0.5, 0.5, e, 0.5, { f: 11, endF: -1, top: 0 });
  g.gable(-0.5, 0.5, e, 0.92, -0.5, 0.5, 0, 5, 0.06, 0.03);
  bands(g, e, { plinth: true });
  gutters(g, e, 0.06, true);
  g.c3(lin(0x4a3c30)).at(0, 0.92, 0, AALL).box(-0.6, -0.05, -0.15, 0.6, 0.3, 0.15, { part: 5, topPart: 5, sides: 0, top: 0 });
  g.rel().white();
  // Halbtüren
  for (let k = 0; k < 4; k++) {
    g.at(-0.37 + k * 0.25, 0, 0.5, AALL);
    g.c3(lin(0x7a5236));
    g.box(-0.6, 0, 0, 0.6, 2.3, 0.1, { part: 5, topPart: 5, sides: 1 });
    g.c3(lin(0x2a2018));
    g.quad([-0.45, 1.3, 0.12], [0.45, 1.3, 0.12], [0.45, 2.1, 0.12], [-0.45, 2.1, 0.12], [0, 0, 1], -1, 0, 5);
    g.rel();
  }
  g.white();
  return g;
}

function protoChapel(): GB {
  const g = new GB();
  const e = 0.38;
  g.box(-0.5, -0.4, -0.32, 0.18, e, 0.32, { f: 5, endF: -1, top: 0 });
  g.gable(-0.5, 0.18, e, 0.62, -0.32, 0.32, 0, 5, 0.04, 0.0);
  bands(g, e, { plinth: true });
  g.box(0.18, -0.4, -0.2, 0.5, 0.65, 0.2, { f: 5, endF: 5, topPart: 2 });
  g.pyramid(0.34, 0, 0.2, 0.2, 0.65, 1.0, 1, 4);
  g.c3(COL.metal).at(0.34, 1.0, 0, AALL);
  g.prism([0, 0, 0], [0, 1.8, 0], 0.06, 5);
  g.prism([-0.5, 1.3, 0], [0.5, 1.3, 0], 0.045, 5, false);
  g.rel().white();
  g.c3(COL.wood).at(0.5, 0, 0, AALL);
  g.quad([0.012, 0.0, -0.8], [0.012, 0.0, 0.8], [0.012, 2.7, 0.8], [0.012, 2.7, -0.8], [1, 0, 0], -1, 1, 5);
  g.c3(COL.concrete);
  g.box(0.0, 0, -1.4, 0.9, 0.35, 1.4, { part: 5, topPart: 5 });
  g.rel().white();
  g.c3(COL.darkMetal).at(0.34, 0.5, 0.2, AALL);
  g.box(-0.6, 0, 0, 0.6, 1.8, 0.08, { part: 5, topPart: 5, sides: 1 });
  g.rel().white();
  return g;
}

function protoFar(top: number): GB {
  const g = new GB();
  g.far = true;
  g.box(-0.5, 0, -0.5, 0.5, top, 0.5, { f: -1, endF: -1, topPart: 1 });
  return g;
}

// ====================================================================== Beschädigte Varianten

interface HeavyOpt {
  e: number;
  r: number;
  f: number;
  endF: number;
  roof: 'gable' | 'flat';
  topPart?: number;
  /** Höhen-Skalierung des Mauerrests relativ zur Traufe */
  ragged?: number;
  seed: number;
  /** Bruch-Mitte (x) */
  breachX?: number;
  half?: number;
}

function heavyShell(g: GB, o: HeavyOpt): void {
  const rnd = rngFrom('heavy' + o.seed);
  const e = o.e;
  const nc = 8;
  const sootCol = lin(0x3a342e);
  const breachX = o.breachX ?? Math.floor(rnd() * 3 + 2);
  const wall = (side: 0 | 1 | 2 | 3) => {
    // 0 = +z (Front), 1 = -z, 2 = +x, 3 = -x
    const tops: number[] = [];
    for (let k = 0; k <= nc; k++) tops.push(e * (0.68 + 0.32 * rnd()) * (o.ragged ?? 1));
    // Eckstehende Pfeiler höher
    tops[0] = e * (0.85 + 0.15 * rnd());
    tops[nc] = e * (0.7 + 0.3 * rnd());
    for (let k = 0; k < nc; k++) {
      const u0 = k / nc, u1 = (k + 1) / nc;
      const ta = tops[k], tb = tops[k + 1];
      const inBreach = side === 0 ? k >= breachX && k < breachX + 3 : side === 2 && k >= 3 && k < 5;
      const P = (u: number, y: number): V3 => {
        const a = -0.5 + u;
        return side === 0 ? [a, y, 0.5] : side === 1 ? [a, y, -0.5] : side === 2 ? [0.5, y, 0.5 - u] : [-0.5, y, -0.5 + u];
      };
      const hint: V3 = side === 0 ? [0, 0, 1] : side === 1 ? [0, 0, -1] : side === 2 ? [1, 0, 0] : [-1, 0, 0];
      const inv: V3 = [-hint[0], -hint[1], -hint[2]];
      const fct = side < 2 ? o.f : o.endF;
      const axis = side < 2 ? 0 : 1;
      const addSeg = (ya0: number, yb0: number, ya1: number, yb1: number) => {
        // Segment mit linker Höhe [ya0,yb0] und rechter Höhe [ya1,yb1]
        if (yb0 - ya0 < 0.004 && yb1 - ya1 < 0.004) return;
        const uvs = [[u0, ya0 / e], [u1, ya1 / e], [u1, yb1 / e], [u0, yb0 / e]];
        g.white();
        g.quad(P(u0, ya0), P(u1, ya1), P(u1, yb1), P(u0, yb0), hint, fct, axis, 0, side < 2 ? 1 : 1, e, uvs);
        g.c3(sootCol);
        g.quad(P(u0, ya0), P(u1, ya1), P(u1, yb1), P(u0, yb0), inv, -1, 0, 5);
        // Mauerkrone (dünne Oberkante)
        g.c3(mulc(COL.plaster, 0.55));
      };
      if (!inBreach) addSeg(-0.4, ta, -0.4, tb);
      else {
        const hy0 = e * (0.1 + 0.08 * rnd()), hy1 = e * (0.55 + 0.1 * rnd());
        addSeg(-0.4, hy0, -0.4, hy0 * (0.6 + 0.8 * rnd()));
        if (ta > hy1 + 0.02 && tb > hy1 + 0.02) addSeg(hy1, ta, hy1 * 1.05, tb);
      }
    }
  };
  wall(0); wall(1); wall(2); wall(3);
  g.white();
  // Geschossdecke (eingestürzt, schief) und Schutt im Inneren
  g.c3(mulc(COL.concrete, 0.7));
  g.quad([-0.45, e * 0.28, 0.42], [0.45, e * 0.2, 0.42], [0.45, e * 0.34, -0.1], [-0.45, e * 0.4, -0.1], [0, 1, 0], -1, 0, 5);
  g.c3(COL.char);
  g.quad([-0.4, e * 0.12, -0.15], [0.4, e * 0.1, -0.15], [0.4, e * 0.1, -0.44], [-0.4, e * 0.12, -0.44], [0, 1, 0], -1, 0, 5);
  for (let k = 0; k < 5; k++) {
    const c = [COL.brick, COL.plaster, COL.concrete, COL.tile, COL.dust][k % 5];
    g.c3(c);
    g.tbox((rnd() - 0.5) * 0.7, e * 0.14, (rnd() - 0.5) * 0.7, 0.1 + rnd() * 0.12, 0.05 + rnd() * 0.08, 0.08 + rnd() * 0.1, rnd() * 3, (rnd() - 0.5) * 0.6, (rnd() - 0.5) * 0.6, 5);
  }
  g.white();
  // Bewehrung / Balken, die aus den Mauerkronen ragen
  g.c3(COL.char);
  for (let k = 0; k < 6; k++) {
    const x = -0.45 + rnd() * 0.9, z = rnd() < 0.5 ? 0.5 : -0.5;
    const y0 = e * (0.5 + 0.4 * rnd());
    g.prism([x, y0, z * 0.96], [x + (rnd() - 0.5) * 0.3, y0 + 0.07 + rnd() * 0.1, z * (0.6 + rnd() * 0.3)], 0.01, 5);
  }
  g.white();
  if (o.roof === 'gable') {
    const r = o.r;
    // Rückseite des Daches bleibt zur Hälfte, Vorderseite weitgehend eingestürzt; Sparren ragen heraus
    const xa = -0.5, xm = 0.12;
    g.c3(COL.tile);
    g.slab([xa, e, -0.5 - 0.03], [xm, e, -0.5 - 0.03], [xm - 0.12, r, 0], [xa, r, 0], [0, 1, -1], 5);
    g.slab([xm, e, -0.5 - 0.03], [0.5, e, -0.5 - 0.03], [0.5, e + (r - e) * 0.35, -0.5 + 0.17], [xm - 0.02, e + (r - e) * 0.35, -0.5 + 0.17], [0, 1, -1], 2);
    g.c3(mulc(COL.tile, 0.85));
    g.slab([xa, e - 0.002, 0.53], [-0.3, e - 0.002, 0.53], [-0.3, e + (r - e) * 0.5, 0.26], [xa, e + (r - e) * 0.55, 0.25], [0, 1, 1], 3);
    g.white();
    g.c3(COL.char);
    for (let k = 0; k < 9; k++) {
      const x = -0.46 + k * 0.115;
      const t = 0.25 + 0.65 * rnd();
      g.prism([x, e, 0.52], [x, e + (r - e) * t, 0.5 - 0.5 * t], 0.01, 5);
      g.prism([x, e, -0.52], [x, e + (r - e) * 0.45 * rnd() + 0.02, -0.52 + 0.5 * 0.45 * rnd()], 0.01, 5);
    }
    g.prism([-0.5, r, 0.0], [0.15, r * 0.82, 0.04], 0.012, 5);
    g.white();
    // Giebelreste
    g.c3(sootCol);
    g.tri([-0.5, e, -0.5], [-0.5, e, 0.5], [-0.5, r * 0.96, 0], [-1, 0, 0], -1, 0, 5);
    g.white();
    g.tri([-0.5, e, 0.5], [-0.5, e, -0.5], [-0.5, r * 0.96, 0], [-1, 0, 0], -1, 0, 0);
  } else {
    // Flachdach: Plattenreste, schief; Bewehrungsstäbe
    g.c3(mulc(COL.concrete, 0.8));
    g.quad([-0.5, e * 0.78, 0.5], [-0.05, e * 0.7, 0.5], [-0.05, e * 0.92, -0.2], [-0.5, e * 0.95, -0.2], [0, 1, 0], -1, 0, 5);
    g.c3(mulc(COL.concrete, 0.65));
    g.quad([0.1, e * 0.5, -0.05], [0.5, e * 0.62, -0.05], [0.5, e * 0.88, -0.5], [0.1, e * 0.8, -0.5], [0, 1, 0], -1, 0, 5);
    g.c3(COL.rust);
    for (let k = 0; k < 8; k++) {
      const x = -0.45 + rnd() * 0.9, z = (rnd() - 0.5) * 0.9;
      g.prism([x, e * 0.8, z], [x + (rnd() - 0.5) * 0.1, e * 0.8 + 0.06 + rnd() * 0.07, z + (rnd() - 0.5) * 0.1], 0.006, 5);
    }
    g.white();
  }
}

function heavyOld(): GB {
  const g = new GB();
  heavyShell(g, { e: 0.62, r: 0.92, f: 0, endF: -1, roof: 'gable', seed: 1 });
  // Schornstein-Stumpf
  g.c3(COL.brick).at(-0.3, 0, -0.05, AX | AZ).box(-0.5, 0.5, -0.5, 0.5, 0.95, 0.5, { part: 5, topPart: 5 });
  g.rel().white();
  return g;
}
function heavyHip(): GB {
  const g = new GB();
  heavyShell(g, { e: 0.6, r: 0.92, f: 8, endF: 8, roof: 'gable', seed: 2 });
  return g;
}
function heavyMid(): GB {
  const g = new GB();
  heavyShell(g, { e: 0.93, r: 1, f: 2, endF: -1, roof: 'flat', seed: 3, ragged: 0.9 });
  return g;
}
function heavyPlatte(): GB {
  const g = new GB();
  heavyShell(g, { e: 0.95, r: 1, f: 1, endF: -1, roof: 'flat', seed: 4, ragged: 0.92, breachX: 3 });
  return g;
}
function heavyHall(): GB {
  const g = new GB();
  heavyShell(g, { e: 0.6, r: 0.92, f: 4, endF: 4, roof: 'flat', seed: 5, ragged: 0.8 });
  // Sheddach-Rippen, teilweise erhalten
  g.c3(COL.metal);
  for (let k = 0; k < 2; k++) {
    const x0 = -0.5 + k * 0.25, x1 = x0 + 0.25;
    g.quad([x0, 0.6, 0.5], [x1, 0.92, 0.5], [x1, 0.92, -0.5], [x0, 0.6, -0.5], [0, 1, 0], -1, 0, 5);
  }
  g.c3(COL.char);
  for (let k = 0; k < 5; k++) g.prism([0.0 + k * 0.1, 0.55, -0.45], [0.05 + k * 0.1, 0.8, 0.0], 0.008, 5);
  g.white();
  return g;
}
function heavySilo(): GB {
  const g = new GB();
  const n = 10;
  const rnd = rngFrom('hsilo');
  // Zylinder mit unregelmäßiger Bruchkante
  for (let k = 0; k < n; k++) {
    const a0 = (k / n) * Math.PI * 2, a1 = ((k + 1) / n) * Math.PI * 2, am = (a0 + a1) / 2;
    const t0 = 0.45 + 0.4 * rnd(), t1 = 0.45 + 0.4 * rnd();
    g.white();
    g.quad([Math.cos(a1) * 0.5, 0, Math.sin(a1) * 0.5], [Math.cos(a0) * 0.5, 0, Math.sin(a0) * 0.5], [Math.cos(a0) * 0.5, t0, Math.sin(a0) * 0.5], [Math.cos(a1) * 0.5, t1, Math.sin(a1) * 0.5], [Math.cos(am), 0, Math.sin(am)], -1, 0, 4);
    g.c3(COL.soot);
    g.quad([Math.cos(a1) * 0.49, 0, Math.sin(a1) * 0.49], [Math.cos(a0) * 0.49, 0, Math.sin(a0) * 0.49], [Math.cos(a0) * 0.49, t0, Math.sin(a0) * 0.49], [Math.cos(a1) * 0.49, t1, Math.sin(a1) * 0.49], [-Math.cos(am), 0, -Math.sin(am)], -1, 0, 5);
  }
  g.c3(COL.rust);
  for (let k = 0; k < 6; k++) {
    const a = rnd() * 6.28;
    g.prism([Math.cos(a) * 0.45, 0.5, Math.sin(a) * 0.45], [Math.cos(a) * 0.3, 0.6 + rnd() * 0.3, Math.sin(a) * 0.3], 0.012, 5);
  }
  g.tbox(0.2, 0.08, 0.1, 0.3, 0.1, 0.2, 0.6, 0.2, 0.3, 5);
  g.white();
  return g;
}
function heavyStack(): GB {
  const g = new GB();
  const rnd = rngFrom('hstack');
  const n = 10;
  for (let k = 0; k < n; k++) {
    const a0 = (k / n) * Math.PI * 2, a1 = ((k + 1) / n) * Math.PI * 2, am = (a0 + a1) / 2;
    const t0 = 0.5 + 0.18 * rnd(), t1 = 0.5 + 0.18 * rnd();
    g.c3(k % 2 ? COL.brick : mulc(COL.brick, 0.8));
    g.quad([Math.cos(a1) * 0.5, 0, Math.sin(a1) * 0.5], [Math.cos(a0) * 0.5, 0, Math.sin(a0) * 0.5], [Math.cos(a0) * 0.38, t0, Math.sin(a0) * 0.38], [Math.cos(a1) * 0.38, t1, Math.sin(a1) * 0.38], [Math.cos(am), 0.1, Math.sin(am)], -1, 0, 5);
  }
  g.c3(COL.char);
  g.tbox(0.3, 0.06, 0.2, 0.4, 0.12, 0.2, 0.7, 0.2, 0.3, 5);
  g.tbox(-0.3, 0.05, -0.15, 0.3, 0.1, 0.2, 2.1, 0.3, 0.1, 5);
  g.white();
  return g;
}
function heavyTower(): GB {
  const g = new GB();
  heavyShell(g, { e: 0.66, r: 1, f: 3, endF: 3, roof: 'flat', seed: 7, ragged: 0.85 });
  g.box(-0.38, 0.0, -0.38, -0.1, 0.78, -0.1, { f: 7, endF: 7, topPart: 4, sides: 0, top: 0 });
  g.c3(COL.rust);
  g.at(-0.2, 0.7, -0.2, AALL);
  g.prism([0, 0, 0], [0.4, 3.0, -0.3], 0.06, 5);
  g.prism([0.5, 0, 0.2], [1.2, 5.0, 0.5], 0.06, 5);
  g.rel().white();
  return g;
}
function heavyChurch(): GB {
  const g = new GB();
  heavyShell(g, { e: 0.26, r: 0.4, f: 5, endF: -1, roof: 'gable', seed: 8 });
  // Turm-Stumpf mit gebrochenem Helm
  g.box(0.15, 0, -0.17, 0.5, 0.42, 0.17, { f: 5, endF: 5, topPart: 2 });
  g.c3(COL.char);
  g.at(0.33, 0.42, 0, AALL);
  g.prism([0, 0, 0], [0.8, 4.0, 0.5], 0.08, 5);
  g.prism([-0.6, 0, 0.4], [-1.4, 3.0, 1.0], 0.07, 5);
  g.rel().white();
  g.c3(COL.tile).pyramid(0.45, 0.1, 0.05, 0.06, 0.42, 0.62, 5);
  g.white();
  return g;
}
function heavyWare(): GB {
  const g = new GB();
  heavyShell(g, { e: 0.8, r: 0.96, f: 4, endF: -1, roof: 'gable', seed: 9, ragged: 0.9 });
  return g;
}
function heavyVilla(): GB {
  const g = new GB();
  heavyShell(g, { e: 0.52, r: 0.92, f: 6, endF: -1, roof: 'gable', seed: 10 });
  g.c3(COL.brick).at(0.26, 0, -0.04, AX | AZ).box(-0.5, 0.4, -0.5, 0.5, 0.78, 0.5, { part: 5, topPart: 5 });
  g.rel().white();
  return g;
}
function heavyBarn(): GB {
  const g = new GB();
  heavyShell(g, { e: 0.42, r: 1.0, f: 10, endF: 10, roof: 'gable', seed: 11, breachX: 3 });
  g.c3(lin(0x5a4a3a));
  g.at(0, 0, 0.5, AALL);
  g.prism([-2.3, 0, 0.1], [-2.0, 4.6, 0.2], 0.1, 5);
  g.rel().white();
  return g;
}
function heavyStable(): GB {
  const g = new GB();
  heavyShell(g, { e: 0.5, r: 0.92, f: 11, endF: -1, roof: 'gable', seed: 12 });
  return g;
}
function heavyChapel(): GB {
  const g = new GB();
  heavyShell(g, { e: 0.38, r: 0.62, f: 5, endF: -1, roof: 'gable', seed: 13 });
  g.box(0.18, 0, -0.2, 0.5, 0.5, 0.2, { f: 5, endF: 5, topPart: 2, top: 0 });
  return g;
}

/** Trümmerhaufen: Schuttkegel, Wandbruchstücke, Balken, Ziegelstreu. Footprint-füllend (±0.5), Höhe 0..1 */
function rubbleProto(v: number): GB {
  const g = new GB();
  const rnd = rngFrom('rubble' + v);
  const palette = [COL.brick, COL.plaster, COL.concrete, COL.tile, COL.dust, mulc(COL.brick, 0.7), mulc(COL.plaster, 0.75)];
  // Schuttmulde (gezackte Kuppel, 3 Ringe)
  const seg = 14;
  const rings = [{ r: 0.5, y: 0.0 }, { r: 0.4, y: 0.34 }, { r: 0.24, y: 0.62 }, { r: 0.08, y: 0.78 }];
  const jit: number[][] = rings.map(() => Array.from({ length: seg }, () => 0.75 + 0.45 * rnd()));
  const cxo = (rnd() - 0.5) * 0.1, czo = (rnd() - 0.5) * 0.1;
  for (let ri = 0; ri < rings.length - 1; ri++) {
    for (let k = 0; k < seg; k++) {
      const a0 = (k / seg) * 6.2832, a1 = ((k + 1) / seg) * 6.2832;
      const R0 = rings[ri].r, R1 = rings[ri + 1].r;
      const j00 = jit[ri][k], j01 = jit[ri][(k + 1) % seg], j10 = jit[ri + 1][k], j11 = jit[ri + 1][(k + 1) % seg];
      const y0a = rings[ri].y * (0.8 + 0.4 * rnd()), y0b = rings[ri].y * (0.8 + 0.4 * rnd());
      const am = (a0 + a1) / 2;
      g.c3(mulc(palette[(k + ri + v) % palette.length], 0.55 + 0.35 * rnd()));
      g.quad(
        [cxo + Math.cos(a0) * R0 * j00, y0a, czo + Math.sin(a0) * R0 * j00], [cxo + Math.cos(a1) * R0 * j01, y0b, czo + Math.sin(a1) * R0 * j01],
        [cxo + Math.cos(a1) * R1 * j11, rings[ri + 1].y, czo + Math.sin(a1) * R1 * j11], [cxo + Math.cos(a0) * R1 * j10, rings[ri + 1].y, czo + Math.sin(a0) * R1 * j10],
        [Math.cos(am), 0.9, Math.sin(am)], -1, 0, 5,
      );
    }
  }
  // Deckel
  g.c3(COL.dust);
  for (let k = 0; k < seg; k++) {
    const a0 = (k / seg) * 6.2832, a1 = ((k + 1) / seg) * 6.2832;
    g.tri([cxo + Math.cos(a0) * 0.08 * jit[3][k], 0.78, czo + Math.sin(a0) * 0.08 * jit[3][k]], [cxo + Math.cos(a1) * 0.08 * jit[3][(k + 1) % seg], 0.78, czo + Math.sin(a1) * 0.08 * jit[3][(k + 1) % seg]], [cxo, 0.86, czo], [0, 1, 0], -1, 0, 5);
  }
  // Wandbruchstücke (stehende Mauerreste, schiefe Platten)
  const nch = 16;
  for (let k = 0; k < nch; k++) {
    const a = rnd() * 6.2832, rr = 0.18 + rnd() * 0.3;
    const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
    const big = rnd() < 0.3;
    g.c3(mulc(palette[Math.floor(rnd() * palette.length)], 0.6 + 0.35 * rnd()));
    const hgt = (big ? 0.3 : 0.1) + rnd() * (big ? 0.3 : 0.14);
    g.tbox(x, hgt * 0.45 + (0.5 - rr) * 0.3, z, (big ? 0.2 : 0.1) + rnd() * 0.12, hgt, 0.04 + rnd() * 0.1, rnd() * 3.14, (rnd() - 0.5) * 0.9, (rnd() - 0.5) * 0.9, 5);
  }
  // Mauerecken (teilweise stehend)
  for (const [sx, sz] of [[1, 1], [-1, -1], [1, -1], [-1, 1]]) {
    if (rnd() < 0.35) continue;
    const h0 = 0.25 + rnd() * 0.4;
    g.c3(mulc(COL.plaster, 0.7));
    g.tbox(sx * 0.4, h0 / 2, sz * 0.42, 0.14, h0, 0.04, rnd() * 0.3, 0.05, 0.05, 5);
    g.tbox(sx * 0.46, h0 * 0.4, sz * 0.36, 0.04, h0 * 0.8, 0.14, 0, 0.05, 0.1, 5);
  }
  // Balken
  g.c3(COL.char);
  for (let k = 0; k < 9; k++) {
    const a = rnd() * 6.2832, rr = rnd() * 0.3;
    const x = Math.cos(a) * rr, z = Math.sin(a) * rr, y = 0.25 + rnd() * 0.5;
    g.at(x, y, z, AALL);
    const dx = (rnd() - 0.5) * 6, dz = (rnd() - 0.5) * 6;
    g.prism([0, 0, 0], [dx, 1.0 + rnd() * 2.5, dz], 0.13, 5);
    g.rel();
  }
  g.white();
  // Ziegelstreu (kleine Bröckchen rund um den Haufen)
  for (let k = 0; k < 22; k++) {
    const a = rnd() * 6.2832, rr = 0.3 + rnd() * 0.22;
    g.c3(mulc(palette[k % 3], 0.6 + 0.4 * rnd()));
    g.tbox(Math.cos(a) * rr, 0.02, Math.sin(a) * rr, 0.035, 0.03, 0.025, rnd() * 3, 0, 0, 5);
  }
  g.white();
  return g;
}

// ====================================================================== Fensteratlas + Material

const ATLAS_T = 16;
const ATLAS_F = 12;

function buildAtlas(): { tex: THREE.DataTexture; avg: THREE.Vector4[] } {
  const W = ATLAS_T;
  const d = new Uint8Array(W * ATLAS_T * ATLAS_F * 4);
  const rect = (f: number, x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number, a: number) => {
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const o = ((f * ATLAS_T + y) * W + x) * 4;
        d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = a;
      }
  };
  const wall = (f: number, v: number) => rect(f, 0, 0, W, ATLAS_T, v, v, v, 0);
  const glass = (f: number, x0: number, y0: number, x1: number, y1: number, r = 14, g = 18, b = 26) => rect(f, x0, y0, x1, y1, r, g, b, 255);
  const accent = (f: number, x0: number, y0: number, x1: number, y1: number, v = 220) => rect(f, x0, y0, x1, y1, v, v, v, 128);
  // 0 Altbau: Fensterrahmen, Sims, Sprossen, Putzbänder
  wall(0, 232);
  rect(0, 0, 15, W, 16, 214, 214, 214, 0);
  rect(0, 3, 2, 13, 3, 190, 190, 190, 0);
  rect(0, 4, 3, 12, 14, 255, 255, 255, 0);
  rect(0, 3, 14, 13, 15, 176, 176, 176, 0);
  glass(0, 5, 5, 11, 13);
  rect(0, 7, 5, 9, 13, 240, 240, 240, 0);
  rect(0, 5, 9, 11, 10, 240, 240, 240, 0);
  // Schlussstein / Sturz-Dekor
  rect(0, 7, 1, 9, 3, 170, 168, 160, 0);
  // 1 Plattenbau: Fugen, Brüstungsband, Loggien
  wall(1, 214);
  rect(1, 0, 0, W, 1, 160, 160, 160, 0);
  rect(1, 0, 0, 1, ATLAS_T, 160, 160, 160, 0);
  rect(1, 8, 0, 9, 1, 140, 140, 140, 0);
  rect(1, 1, 2, 15, 5, 166, 166, 166, 0);
  rect(1, 2, 5, 14, 6, 120, 120, 120, 0);
  glass(1, 3, 6, 13, 13);
  rect(1, 8, 6, 9, 13, 224, 224, 224, 0);
  rect(1, 1, 13, 15, 15, 150, 150, 150, 0);
  // Loggia-Brüstung (bunte Paneele)
  accent(1, 2, 13, 14, 15, 230);
  // 2 Wohnbau mit Balkonen
  wall(2, 234);
  rect(2, 0, 14, W, 15, 130, 130, 130, 0);
  rect(2, 0, 15, W, 16, 100, 100, 100, 0);
  rect(2, 3, 5, 13, 6, 190, 190, 190, 0);
  glass(2, 4, 6, 12, 14, 18, 22, 30);
  rect(2, 8, 6, 9, 14, 232, 232, 232, 0);
  rect(2, 3, 14, 13, 15, 255, 255, 255, 0);
  // 3 Glasfassade (Büro)
  wall(3, 90);
  rect(3, 0, 0, W, 3, 70, 74, 80, 0);
  glass(3, 0, 3, W, ATLAS_T, 52, 84, 100);
  rect(3, 0, 3, 1, ATLAS_T, 70, 70, 70, 0);
  rect(3, 8, 3, 9, ATLAS_T, 70, 70, 70, 0);
  // 4 Industrie: Wellblech + Fensterband
  wall(4, 224);
  for (let x = 0; x < W; x += 2) rect(4, x, 0, x + 1, ATLAS_T, 196, 196, 196, 0);
  rect(4, 0, 0, W, 2, 140, 140, 140, 0);
  rect(4, 0, 8, W, 14, 120, 124, 126, 0);
  glass(4, 1, 9, 15, 13, 20, 28, 32);
  rect(4, 5, 9, 6, 13, 120, 124, 126, 0);
  rect(4, 10, 9, 11, 13, 120, 124, 126, 0);
  // 5 Kirche: hohe Spitzbogenfenster mit Maßwerk
  wall(5, 236);
  rect(5, 5, 3, 11, 15, 255, 255, 255, 0);
  glass(5, 6, 4, 10, 13, 26, 32, 56);
  glass(5, 7, 13, 9, 15, 26, 32, 56);
  rect(5, 8, 4, 9, 14, 240, 240, 240, 0);
  rect(5, 6, 8, 10, 9, 240, 240, 240, 0);
  rect(5, 7, 2, 9, 4, 255, 255, 255, 0);
  accent(5, 6, 4, 7, 5, 120);
  // 6 Villa: Fenster mit Läden (Akzentfarbe), Fensterbank, Blumenkasten
  wall(6, 244);
  accent(6, 2, 4, 5, 13, 224);
  accent(6, 11, 4, 14, 13, 224);
  rect(6, 2, 4, 5, 5, 255, 255, 255, 0);
  glass(6, 5, 5, 11, 12);
  rect(6, 8, 5, 9, 12, 242, 242, 242, 0);
  rect(6, 4, 12, 12, 14, 180, 180, 176, 0);
  rect(6, 5, 11, 11, 12, 70, 96, 54, 0);
  // 7 Turm: durchgehendes Glas
  wall(7, 80);
  rect(7, 0, 0, W, 1, 56, 58, 62, 0);
  glass(7, 0, 1, W, ATLAS_T, 70, 108, 126);
  rect(7, 0, 1, 1, ATLAS_T, 60, 60, 60, 0);
  rect(7, 8, 1, 9, ATLAS_T, 60, 60, 60, 0);
  // 8 Mittelmeer: hohe schmale Fenster, Lamellenläden (Akzent), Fensterbank
  wall(8, 244);
  rect(8, 3, 2, 13, 3, 255, 255, 255, 0);
  accent(8, 2, 3, 5, 14, 226);
  accent(8, 11, 3, 14, 14, 226);
  rect(8, 2, 5, 5, 6, 150, 150, 150, 128);
  rect(8, 2, 8, 5, 9, 150, 150, 150, 128);
  rect(8, 2, 11, 5, 12, 150, 150, 150, 128);
  rect(8, 11, 5, 14, 6, 150, 150, 150, 128);
  rect(8, 11, 8, 14, 9, 150, 150, 150, 128);
  rect(8, 11, 11, 14, 12, 150, 150, 150, 128);
  glass(8, 5, 3, 11, 14);
  rect(8, 5, 8, 11, 9, 250, 250, 250, 0);
  rect(8, 2, 14, 14, 15, 255, 255, 255, 0);
  rect(8, 1, 15, 15, 16, 190, 186, 176, 0);
  // 9 Bauernhaus: kleine Fenster, Läden, Blumenkasten, Holzrahmen
  wall(9, 238);
  rect(9, 4, 4, 12, 13, 90, 70, 58, 0);
  glass(9, 5, 5, 11, 12);
  rect(9, 8, 5, 9, 12, 100, 80, 66, 0);
  accent(9, 1, 4, 4, 13, 214);
  accent(9, 12, 4, 15, 13, 214);
  rect(9, 4, 13, 12, 15, 100, 90, 70, 0);
  rect(9, 5, 13, 11, 14, 60, 110, 50, 0);
  // 10 Bretterwand (Scheune)
  wall(10, 215);
  for (let x = 0; x < W; x += 2) rect(10, x, 0, x + 1, ATLAS_T, 180, 176, 170, 0);
  for (let x = 0; x < W; x += 4) rect(10, x, 0, x + 1, 5, 150, 146, 140, 0);
  // 11 Stall: Boxentüren (dunkle Öffnungen)
  wall(11, 226);
  rect(11, 0, 0, W, 1, 168, 168, 168, 0);
  rect(11, 3, 4, 13, 15, 120, 100, 80, 0);
  rect(11, 4, 5, 12, 15, 26, 22, 20, 255);
  rect(11, 3, 9, 13, 10, 120, 100, 80, 0);
  const avg: THREE.Vector4[] = [];
  for (let f = 0; f < ATLAS_F; f++) {
    let wm = 0, gr = 0, gg = 0, gb = 0;
    for (let y = 0; y < ATLAS_T; y++)
      for (let x = 0; x < W; x++) {
        const o = ((f * ATLAS_T + y) * W + x) * 4;
        if (d[o + 3] > 200) { gr += d[o]; gg += d[o + 1]; gb += d[o + 2]; } else wm += d[o];
      }
    const N = W * ATLAS_T * 255;
    avg.push(new THREE.Vector4(wm / N, gr / N, gg / N, gb / N));
  }
  const tex = new THREE.DataTexture(d, W, ATLAS_T * ATLAS_F, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return { tex, avg };
}

const B_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
#include <fog_pars_vertex>
attribute vec3 aSurf;
attribute vec2 aSize;
attribute vec3 aVC;
attribute vec4 aAnc;
attribute vec4 aDet;
attribute vec4 aRoof;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uVis;
uniform float uWinScale;
uniform float uHS;
uniform float uSink;
uniform float uNight;
uniform vec2 uPitch[12];
varying vec3 vLight;
varying vec2 vCell;
varying vec3 vSurf;
varying vec3 vWall;
varying vec3 vRoof;
varying vec3 vVC;
varying float vFlag;
varying float vSeed;
varying float vAO;
varying vec3 vM;
varying vec2 vUM;
varying float vNy;
void main() {
  mat3 R = mat3(instanceMatrix);
  vec3 sc = vec3(length(R[0]), length(R[1]), length(R[2]));
  mat3 Rn = mat3(R[0] / sc.x, R[1] / sc.y, R[2] / sc.z);
  vec3 n = normalize(Rn * (normal / sc));
  float seed = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453);
  float hv = max(1e-5, sc.y - uSink);
  vec3 loc = position;
  float ym = position.y;
  float fl = aAnc.w;
  bool hide = false;
  if (fl > 0.5 && fl < 7.5) {
    float ax = mod(fl, 2.0) > 0.5 ? 1.0 : 0.0;
    float ay = mod(floor(fl / 2.0), 2.0) > 0.5 ? 1.0 : 0.0;
    float az = fl > 3.5 ? 1.0 : 0.0;
    loc.x = ax > 0.5 ? aAnc.x + position.x / sc.x : position.x;
    loc.z = az > 0.5 ? aAnc.z + position.z / sc.z : position.z;
    ym = ay > 0.5 ? aAnc.y + position.y * uHS / hv : position.y;
    float yy = aAnc.y + aDet.w * 0.001 * uHS / hv;
    if (yy > aDet.z) hide = true;
  }
  loc.y = fl > 7.5 ? ym : (uSink + ym * hv) / sc.y;
  if (aDet.y != 0.0) {
    float rr = fract(seed * (13.37 + aDet.x * 7.1) + aDet.x * 0.6180339);
    bool show = aDet.y > 0.0 ? rr < aDet.y : rr >= -aDet.y;
    if (!show) hide = true;
  }
  vec3 lp = loc * uVis;
  vec4 wp = instanceMatrix * vec4(lp, 1.0);
  vec3 amb = mix(vec3(0.24, 0.21, 0.17), vec3(0.50, 0.56, 0.66), n.y * 0.5 + 0.5) * 0.62;
  float ndl = max(dot(n, uSunDir), 0.0);
  vLight = (amb + uSunColor * ndl * 0.95) * 1.12 * (1.0 - 0.55 * uNight);
  float fi = max(aSurf.x, 0.0);
  vec2 pf = uPitch[int(fi + 0.5)];
  float faceW = (aSurf.y < 0.5 ? sc.x : sc.z) * aSize.x;
  float faceH = (fl > 7.5 ? sc.y : hv) * aSize.y;
  vCell = uv * vec2(max(1.0, floor(faceW / (pf.x * uWinScale) + 0.5)), max(1.0, floor(faceH / (pf.y * uHS * uWinScale) + 0.5)));
  vSurf = aSurf;
  vWall = instanceColor;
  vRoof = aRoof.rgb;
  vFlag = aRoof.w;
  vVC = aVC;
  vSeed = seed;
  vNy = n.y;
  vAO = mix(0.7, 1.0, smoothstep(0.0, 0.14, ym));
  float ymM = ym * hv * 1000.0 / uHS;
  vM = vec3(loc.x * sc.x * 1000.0, ymM, loc.z * sc.z * 1000.0);
  vUM = vec2(aSurf.y < 0.5 ? loc.x * sc.x * 1000.0 : loc.z * sc.z * 1000.0, ymM);
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  if (hide) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

const B_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
#include <fog_pars_fragment>
uniform sampler2D uAtlas;
uniform vec4 uAvg[12];
uniform float uNight;
uniform float uTime;
varying vec3 vLight;
varying vec2 vCell;
varying vec3 vSurf;
varying vec3 vWall;
varying vec3 vRoof;
varying vec3 vVC;
varying float vFlag;
varying float vSeed;
varying float vAO;
varying vec3 vM;
varying vec2 vUM;
varying float vNy;
float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 accentCol(float h) {
  float k = floor(h * 8.0);
  if (k < 1.0) return vec3(0.10, 0.24, 0.15);
  if (k < 2.0) return vec3(0.26, 0.14, 0.08);
  if (k < 3.0) return vec3(0.14, 0.22, 0.42);
  if (k < 4.0) return vec3(0.46, 0.10, 0.09);
  if (k < 5.0) return vec3(0.72, 0.66, 0.50);
  if (k < 6.0) return vec3(0.28, 0.36, 0.32);
  if (k < 7.0) return vec3(0.20, 0.20, 0.22);
  return vec3(0.52, 0.34, 0.10);
}
void main() {
  #include <logdepthbuf_fragment>
  float part = vSurf.z;
  float style = floor(vFlag / 10.0 + 0.001);
  float st = vFlag - style * 10.0;
  vec3 acc = accentCol(fract(vSeed * 7.31));
  vec3 base;
  if (part < 0.5) base = vWall * vVC;
  else if (part < 1.5) base = vRoof * vVC;
  else if (part < 2.5) base = vec3(0.045, 0.045, 0.05) * vVC;
  else if (part < 3.5) base = vec3(0.30, 0.13, 0.09) * vVC;
  else if (part < 4.5) base = (vWall * 0.82 + 0.03) * vVC;
  else if (part < 5.5) base = vVC;
  else if (part < 6.5) base = vVC;
  else if (part < 7.5) base = acc * vVC;
  else base = vVC;
  base *= 0.93 + 0.14 * vSeed;
  vec3 col = base;
  vec3 emis = vec3(0.0);
  float broken = st > 1.5 && st < 2.5 ? 1.0 : 0.0;
  float heavy = st > 2.5 ? 1.0 : 0.0;
  if (st > 0.5 && st < 1.5 && part < 4.5) {
    col = base * (0.85 + 0.3 * hash21(floor(gl_FragCoord.xy * 0.5)));
  } else if (vSurf.x > -0.5 && part < 0.5) {
    int fi = int(vSurf.x + 0.5);
    vec2 fw = fwidth(vCell);
    float aa = max(fw.x, fw.y);
    float farK = smoothstep(0.3, 0.75, aa);
    vec4 t = texture2D(uAtlas, vec2(fract(vCell.x), (float(fi) + fract(vCell.y)) / 12.0));
    vec2 cid = floor(vCell) + vSeed * 91.0;
    float h = hash21(cid);
    vec3 tex;
    float isGlass = 0.0;
    if (t.a > 0.75) {
      isGlass = 1.0;
      tex = t.rgb;
      vec2 f = fract(vCell);
      // Reflexion / Himmelsschimmer
      tex += vec3(0.10, 0.14, 0.18) * (1.0 - f.y) * 0.8;
      if (h < 0.10) {
        // Vorhang
        vec3 cur = mix(vec3(0.74, 0.62, 0.46), vec3(0.52, 0.62, 0.74), hash21(cid + 3.0));
        if (f.y > 0.42 || abs(f.x - 0.5) > 0.3) tex = cur * 0.8;
      } else if (h < 0.19) {
        // Jalousie
        float sl = step(0.5, fract(f.y * 6.0));
        tex = mix(vec3(0.5, 0.5, 0.47), vec3(0.2, 0.2, 0.2), sl) * 0.8;
      } else if (h < 0.24) {
        tex = tex * 0.5;
      }
      if (broken > 0.5 && hash21(cid + 7.0) < 0.5) {
        float jag = step(0.55, hash21(floor(vCell * 3.0) + cid));
        tex = mix(vec3(0.01), vec3(0.18, 0.2, 0.22), jag * 0.6);
      }
      if (heavy > 0.5) tex = vec3(0.01) + 0.05 * hash21(floor(vCell * 3.0) + cid);
    } else if (t.a > 0.25) {
      // Läden / Akzentflächen
      float openSh = step(0.74, hash21(cid + 5.0));
      tex = acc * (0.4 + 0.6 * t.r) * (1.0 - 0.25 * openSh);
    } else {
      tex = base * t.rgb;
      // Fachwerk
      if (style > 0.5 && style < 1.5) {
        vec2 q = vec2(vUM.x / 2.6, vUM.y / 3.4);
        float tf = 1.0 - smoothstep(0.12, 0.3, fwidth(vUM.x) / 2.6);
        float bx = step(fract(q.x), 0.1), by = step(fract(q.y), 0.07);
        float br = step(abs(fract(q.x) - fract(q.y)), 0.07) * step(0.2, fract(q.y));
        tex = mix(tex, vec3(0.10, 0.065, 0.04), max(max(bx, by), br) * 0.85 * tf);
      }
      // Rußspuren über Fenstern
      if (broken > 0.5 && hash21(cid + 11.0) < 0.55) tex *= 1.0 - 0.6 * smoothstep(0.25, 1.0, fract(vCell.y));
      // Verwitterung: Regenstreifen
      tex *= 0.9 + 0.1 * hash21(vec2(floor(vCell.x * 4.0), floor(cid.y * 0.5))) * (1.0 - fract(vCell.y) * 0.4);
    }
    vec4 av = uAvg[fi];
    vec3 avg = base * av.x + av.yzw;
    col = mix(tex, avg, farK);
    if (isGlass > 0.5 && uNight > 0.01 && heavy < 0.5) {
      float lit = step(0.58, hash21(cid + 1.7)) * (1.0 - farK) * (broken > 0.5 ? step(0.5, hash21(cid + 7.0)) : 1.0);
      vec3 lc = mix(vec3(1.0, 0.78, 0.42), vec3(0.8, 0.9, 1.0), step(0.85, hash21(cid + 2.2)));
      emis = lc * lit * uNight * 1.3;
    }
    if (heavy > 0.5) col *= 0.62;
    else if (broken > 0.5) col *= 0.92;
  } else if (part < 0.5 && st < 0.5 && style > 0.5 && style < 1.5) {
    // Fachwerk auf fensterlosen Wandflächen
    vec2 q = vec2(vUM.x / 2.6, vUM.y / 3.4);
    float tf = 1.0 - smoothstep(0.12, 0.3, fwidth(vUM.x) / 2.6);
    float bx = step(fract(q.x), 0.1), by = step(fract(q.y), 0.07);
    col = mix(col, vec3(0.10, 0.065, 0.04), max(bx, by) * 0.85 * tf);
  }
  // Dach: Ziegelkörnung, fehlende Ziegel bei Schäden
  if (part > 0.5 && part < 1.5) {
    float g = hash21(floor(vM.xz * 0.9 + vM.y * 0.9) + floor(vSeed * 40.0));
    col *= 0.9 + 0.2 * g;
    if (broken > 0.5 && hash21(floor((vM.xz + vM.y) / 2.4) + vSeed * 50.0) < 0.22) col = vec3(0.13, 0.085, 0.06) * (0.7 + g * 0.6);
    if (vNy < 0.2 && part < 1.5) col *= 0.9;
  }
  // Teile mit absoluter Farbe: Glas und Schaufenster
  if (part > 5.5 && part < 6.5) {
    vec3 gl = vVC + vec3(0.06, 0.09, 0.12) * (0.5 + 0.5 * sin(vUM.x * 0.4 + vUM.y * 0.8));
    float h = hash21(floor(vUM * 0.3) + vSeed * 30.0);
    col = gl;
    if (uNight > 0.01) emis = vec3(1.0, 0.82, 0.5) * step(0.35, fract(vSeed * 5.3)) * uNight * (0.7 + 0.3 * h);
  } else if (part > 7.5 && part < 8.5) {
    col = vVC + vec3(0.08, 0.1, 0.14) * (1.0 - fract(vM.y * 0.5));
    if (uNight > 0.01) emis = vec3(1.0, 0.78, 0.42) * step(0.55, fract(vSeed * 3.1 + vM.x * 0.01)) * uNight * 0.9;
  } else if (part > 8.5) {
    float bl = 0.5 + 0.5 * sin(uTime * 3.0 + vSeed * 20.0);
    col = vec3(0.5, 0.05, 0.04);
    emis = vec3(1.0, 0.12, 0.06) * (0.35 + 0.65 * step(0.5, bl)) * (0.4 + 0.8 * uNight);
  }
  // Schaden: Ruß, glimmende Trümmer
  if (st > 0.5 && st < 1.5 && part > 4.5) {
    float hh = hash21(floor(vM.xz * 2.2 + vM.y * 4.0));
    col *= 0.62;
    float ember = step(0.965, hh) * step(0.55, hash21(floor(vM.xz * 2.2 + vM.y * 4.0) + floor(uTime * 2.0)));
    emis += vec3(1.0, 0.36, 0.06) * ember * (0.5 + 0.8 * uNight);
  }
  col *= vAO;
  gl_FragColor = vec4(col * vLight + emis, 1.0);
  #include <fog_fragment>
}
`;

export interface BuildingMaterial extends THREE.ShaderMaterial {
  uniforms: Record<string, THREE.IUniform>;
}

let SHARED_MAT: BuildingMaterial | null = null;
/** Gemeinsames Gebäudematerial (Fensteratlas, Vertex-Licht, Nebel, logarithmischer Tiefenpuffer). */
export function getBuildingMaterial(): BuildingMaterial {
  if (SHARED_MAT) return SHARED_MAT;
  const { tex, avg } = buildAtlas();
  const pitch = [
    [0.0105, 0.0034], [0.009, 0.0038], [0.0105, 0.003], [0.009, 0.0038], [0.014, 0.009], [0.012, 0.01], [0.0115, 0.0033], [0.008, 0.0038],
    [0.0095, 0.0034], [0.0085, 0.0032], [0.006, 0.006], [0.0115, 0.0036],
  ].map((p) => new THREE.Vector2(p[0], p[1]));
  SHARED_MAT = new THREE.ShaderMaterial({
    vertexShader: B_VERT,
    fragmentShader: B_FRAG,
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uAtlas: { value: tex },
      uAvg: { value: avg },
      uPitch: { value: pitch },
      uSunDir: { value: SUN_DIR.clone() },
      uSunColor: { value: SUN_COLOR.clone() },
      uVis: { value: 1 },
      uWinScale: { value: 1 },
      uHS: { value: 2.25 },
      uSink: { value: SINK },
      uNight: { value: 0 },
      uTime: { value: 0 },
    },
    fog: true,
  }) as BuildingMaterial;
  SHARED_MAT.name = 'BuildingMaterial';
  return SHARED_MAT;
}

export interface ModelSet {
  /** intakt, [BT_COUNT] */
  g0: THREE.BufferGeometry[];
  /** schwer beschädigt, [BT_COUNT] */
  gh: THREE.BufferGeometry[];
  /** Trümmer, [RUBBLE_VARIANTS] */
  gr: THREE.BufferGeometry[];
  /** Fern-Quader je Typ */
  gf: THREE.BufferGeometry[];
}
let MODELS: ModelSet | null = null;
export function getModels(): ModelSet {
  if (!MODELS) {
    const mk = [protoOld, protoHip, protoMid, protoPlatte, protoHall, protoSilo, protoStack, protoTower, protoChurch, protoWare, protoVilla, protoBarn, protoStable, protoChapel];
    const mh = [heavyOld, heavyHip, heavyMid, heavyPlatte, heavyHall, heavySilo, heavyStack, heavyTower, heavyChurch, heavyWare, heavyVilla, heavyBarn, heavyStable, heavyChapel];
    MODELS = {
      g0: mk.map((f) => f().build()),
      gh: mh.map((f) => f().build()),
      gr: Array.from({ length: RUBBLE_VARIANTS }, (_, v) => rubbleProto(v).build()),
      gf: FAR_TOP.map((t) => protoFar(t).build()),
    };
  }
  return MODELS;
}
let FAR_GEO: THREE.BufferGeometry | null = null;
export function getFarGeo(): THREE.BufferGeometry {
  if (!FAR_GEO) FAR_GEO = protoFar(1).build();
  return FAR_GEO;
}

/** Dreiecksanzahl je Modell (Statistik / Tests) */
export function modelTriangleCounts(): { intact: number[]; heavy: number[]; rubble: number[] } {
  const m = getModels();
  const t = (g: THREE.BufferGeometry) => (g.getIndex()?.count ?? 0) / 3;
  return { intact: m.g0.map(t), heavy: m.gh.map(t), rubble: m.gr.map(t) };
}
