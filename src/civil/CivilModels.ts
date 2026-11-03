import * as THREE from 'three';
import type { InfraKind } from './types';

/**
 * Low-Poly-Modelle für Zivilisten, Fahrzeuge und Infrastruktur (PS2-Stil: Flat Shading, Vertexfarben).
 * Alle Maße in METERN (Instanzmatrix skaliert mit 0.001 * Sichtmaßstab nach km). Fahrzeuge schauen nach +Z,
 * Ursprung = Bodenmitte. Lackteile sind WEISS (0xffffff) und werden per instanceColor getönt; Glas/Reifen/Licht
 * sind feste Farben (werden von der Tönung nur leicht verändert).
 */

export const PAINT = 0xffffff;
const GLASS = 0x26303a;
const TIRE = 0x1c1c1e;
const RIM = 0x8d9095;
const DARK = 0x2e2f33;
const LIGHT_Y = 0xf0e6b0;
const LIGHT_R = 0xc03a30;
const CONCRETE = 0xa7a49c;
const CONCRETE_D = 0x7f7c75;

type V3 = [number, number, number];

export class MeshBuilder {
  readonly pos: number[] = [];
  readonly col: number[] = [];
  private readonly c = new THREE.Color();

  private color(hex: number): [number, number, number] {
    this.c.setHex(hex);
    return [this.c.r, this.c.g, this.c.b];
  }

  tri(a: V3, b: V3, c: V3, hex: number): void {
    const k = this.color(hex);
    this.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    this.col.push(...k, ...k, ...k);
  }

  quad(a: V3, b: V3, c: V3, d: V3, hex: number): void {
    this.tri(a, b, c, hex);
    this.tri(a, c, d, hex);
  }

  /** Quader, (cx, y=Unterkante, cz) = Mitte der Grundfläche; optional um Y gedreht. */
  box(cx: number, y: number, cz: number, w: number, h: number, d: number, hex: number, rotY = 0): this {
    const hw = w / 2, hd = d / 2;
    const s = Math.sin(rotY), co = Math.cos(rotY);
    const P = (lx: number, ly: number, lz: number): V3 => [cx + lx * co + lz * s, y + ly, cz - lx * s + lz * co];
    const a = P(-hw, 0, -hd), b = P(hw, 0, -hd), c = P(hw, 0, hd), dd = P(-hw, 0, hd);
    const e = P(-hw, h, -hd), f = P(hw, h, -hd), g = P(hw, h, hd), hh = P(-hw, h, hd);
    this.quad(e, hh, g, f, hex); // oben
    this.quad(dd, c, b, a, hex); // unten
    this.quad(hh, dd, a, e, hex); // -x
    this.quad(f, b, c, g, hex); // +x
    this.quad(g, c, dd, hh, hex); // +z
    this.quad(e, a, b, f, hex); // -z
    return this;
  }

  /** Kegelstumpf-Quader (Grundfläche w0×d0, Deckfläche w1×d1, Deckflächenmitte um (ox,oz) verschoben). */
  frustumBox(cx: number, y: number, cz: number, w0: number, d0: number, w1: number, d1: number, h: number, hex: number, ox = 0, oz = 0): this {
    const a: V3 = [cx - w0 / 2, y, cz - d0 / 2], b: V3 = [cx + w0 / 2, y, cz - d0 / 2], c: V3 = [cx + w0 / 2, y, cz + d0 / 2], d: V3 = [cx - w0 / 2, y, cz + d0 / 2];
    const tx = cx + ox, tz = cz + oz, ty = y + h;
    const e: V3 = [tx - w1 / 2, ty, tz - d1 / 2], f: V3 = [tx + w1 / 2, ty, tz - d1 / 2], g: V3 = [tx + w1 / 2, ty, tz + d1 / 2], hh: V3 = [tx - w1 / 2, ty, tz + d1 / 2];
    this.quad(e, hh, g, f, hex);
    this.quad(hh, d, a, e, hex);
    this.quad(f, b, c, g, hex);
    this.quad(g, c, d, hh, hex);
    this.quad(e, a, b, f, hex);
    return this;
  }

  /** Satteldach über Grundfläche w×d, First entlang Z (alongZ) oder X. */
  gable(cx: number, y: number, cz: number, w: number, d: number, h: number, hex: number, hexGable = hex, alongZ = true): this {
    const hw = w / 2, hd = d / 2;
    if (alongZ) {
      const a: V3 = [cx - hw, y, cz - hd], b: V3 = [cx + hw, y, cz - hd], c: V3 = [cx + hw, y, cz + hd], dd: V3 = [cx - hw, y, cz + hd];
      const r0: V3 = [cx, y + h, cz - hd], r1: V3 = [cx, y + h, cz + hd];
      this.quad(a, dd, r1, r0, hex);
      this.quad(b, r0, r1, c, hex);
      this.tri(a, r0, b, hexGable);
      this.tri(dd, c, r1, hexGable);
    } else {
      const a: V3 = [cx - hw, y, cz - hd], b: V3 = [cx + hw, y, cz - hd], c: V3 = [cx + hw, y, cz + hd], dd: V3 = [cx - hw, y, cz + hd];
      const r0: V3 = [cx - hw, y + h, cz], r1: V3 = [cx + hw, y + h, cz];
      this.quad(a, r0, r1, b, hex);
      this.quad(dd, c, r1, r0, hex);
      this.tri(a, dd, r0, hexGable);
      this.tri(b, r1, c, hexGable);
    }
    return this;
  }

  /** Pyramide (Spitze mittig) */
  pyramid(cx: number, y: number, cz: number, w: number, d: number, h: number, hex: number): this {
    const a: V3 = [cx - w / 2, y, cz - d / 2], b: V3 = [cx + w / 2, y, cz - d / 2], c: V3 = [cx + w / 2, y, cz + d / 2], dd: V3 = [cx - w / 2, y, cz + d / 2];
    const t: V3 = [cx, y + h, cz];
    this.tri(a, dd, t, hex);
    this.tri(b, a, t, hex);
    this.tri(c, b, t, hex);
    this.tri(dd, c, t, hex);
    return this;
  }

  /** Zylinder/Kegelstumpf entlang einer Achse; (cx,cy,cz) = Mitte der Grundfläche (Achse 'y'), bzw. Mittelpunkt bei 'x'/'z'. */
  cyl(cx: number, cy: number, cz: number, rBot: number, rTop: number, h: number, hex: number, segs = 8, axis: 'x' | 'y' | 'z' = 'y', capTop = true): this {
    const map = (lx: number, ly: number, lz: number): V3 => {
      if (axis === 'y') return [cx + lx, cy + ly, cz + lz];
      if (axis === 'x') return [cx + ly - h / 2, cy + lx, cz + lz];
      return [cx + lx, cy + lz, cz + ly - h / 2];
    };
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI * 2, a1 = ((i + 1) / segs) * Math.PI * 2;
      const b0 = map(Math.cos(a0) * rBot, 0, Math.sin(a0) * rBot), b1 = map(Math.cos(a1) * rBot, 0, Math.sin(a1) * rBot);
      const t0 = map(Math.cos(a0) * rTop, h, Math.sin(a0) * rTop), t1 = map(Math.cos(a1) * rTop, h, Math.sin(a1) * rTop);
      this.quad(b0, t0, t1, b1, hex);
      if (capTop && rTop > 0) this.tri(map(0, h, 0), t1, t0, hex);
      if (axis !== 'y' && rBot > 0) this.tri(map(0, 0, 0), b0, b1, hex);
    }
    return this;
  }

  /** Oktaeder-Blob (Dampfwolken, Büsche) */
  blob(cx: number, cy: number, cz: number, r: number, hex: number): this {
    const t: V3 = [cx, cy + r, cz], b: V3 = [cx, cy - r * 0.7, cz];
    const p: V3[] = [[cx + r, cy, cz], [cx, cy, cz + r], [cx - r, cy, cz], [cx, cy, cz - r]];
    for (let i = 0; i < 4; i++) {
      this.tri(p[i], p[(i + 1) % 4], t, hex);
      this.tri(p[(i + 1) % 4], p[i], b, hex);
    }
    return this;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

// ------------------------------------------------------------------ Fahrzeuge

function wheel(m: MeshBuilder, x: number, z: number, r: number, w: number): void {
  m.cyl(x, r, z, r, r, w, TIRE, 8, 'x');
  m.cyl(x + Math.sign(x) * w * 0.52, r, z, r * 0.55, r * 0.55, w * 0.1, RIM, 6, 'x');
}

function carBody(m: MeshBuilder, L: number, W: number, hBody: number, cabinH: number, cabinFront: number, cabinBack: number): void {
  const hl = L / 2;
  m.box(0, 0.3, 0, W, hBody, L, PAINT); // Karosserie
  m.box(0, 0.22, hl - 0.1, W * 0.95, 0.16, 0.34, DARK); // Stoßfänger vorn
  m.box(0, 0.22, -hl + 0.1, W * 0.95, 0.16, 0.34, DARK);
  m.box(0, 0.3 + hBody, hl * 0.45, W * 0.92, 0.04, L * 0.28, PAINT); // Motorhaube
  // Kabine: Glas + Lackdach + Säulen
  const cz = (cabinBack - cabinFront) / 2;
  const cLen = cabinFront + cabinBack;
  m.frustumBox(0, 0.3 + hBody, cz, W * 0.9, cLen, W * 0.78, cLen * 0.72, cabinH, GLASS, 0, -cLen * 0.08);
  m.box(0, 0.3 + hBody + cabinH, cz - cLen * 0.08, W * 0.78, 0.06, cLen * 0.72, PAINT);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) m.box(sx * W * 0.42, 0.3 + hBody, cz + sz * cLen * 0.33, 0.07, cabinH, 0.09, PAINT);
  // Leuchten, Spiegel
  m.box(-W * 0.34, 0.62, hl + 0.01, 0.34, 0.12, 0.05, LIGHT_Y);
  m.box(W * 0.34, 0.62, hl + 0.01, 0.34, 0.12, 0.05, LIGHT_Y);
  m.box(-W * 0.34, 0.66, -hl - 0.01, 0.3, 0.1, 0.05, LIGHT_R);
  m.box(W * 0.34, 0.66, -hl - 0.01, 0.3, 0.1, 0.05, LIGHT_R);
  m.box(-W * 0.52, 0.3 + hBody + 0.12, cz + cLen * 0.3, 0.12, 0.08, 0.14, PAINT);
  m.box(W * 0.52, 0.3 + hBody + 0.12, cz + cLen * 0.3, 0.12, 0.08, 0.14, PAINT);
}

function buildCar(): THREE.BufferGeometry {
  const m = new MeshBuilder();
  carBody(m, 4.4, 1.8, 0.5, 0.52, 1.0, 1.4);
  for (const sx of [-1, 1]) { wheel(m, sx * 0.82, 1.38, 0.32, 0.22); wheel(m, sx * 0.82, -1.32, 0.32, 0.22); }
  m.box(0, 1.34, -1.6, 0.04, 0.3, 0.04, DARK); // Antenne
  return m.build();
}

function buildHatch(): THREE.BufferGeometry {
  const m = new MeshBuilder();
  carBody(m, 3.9, 1.74, 0.5, 0.62, 0.9, 1.6);
  for (const sx of [-1, 1]) { wheel(m, sx * 0.8, 1.2, 0.3, 0.2); wheel(m, sx * 0.8, -1.15, 0.3, 0.2); }
  m.box(0, 1.5, -1.0, 0.8, 0.05, 0.08, DARK); // Dachspoiler
  return m.build();
}

function buildSuv(): THREE.BufferGeometry {
  const m = new MeshBuilder();
  carBody(m, 4.8, 1.95, 0.75, 0.62, 1.1, 1.9);
  for (const sx of [-1, 1]) { wheel(m, sx * 0.9, 1.5, 0.38, 0.26); wheel(m, sx * 0.9, -1.45, 0.38, 0.26); }
  m.box(-0.7, 1.7, -0.2, 0.05, 0.05, 2.4, DARK); // Dachreling
  m.box(0.7, 1.7, -0.2, 0.05, 0.05, 2.4, DARK);
  return m.build();
}

function buildCarLoaded(): THREE.BufferGeometry {
  const m = new MeshBuilder();
  carBody(m, 4.4, 1.8, 0.5, 0.52, 1.0, 1.4);
  for (const sx of [-1, 1]) { wheel(m, sx * 0.82, 1.38, 0.32, 0.22); wheel(m, sx * 0.82, -1.32, 0.32, 0.22); }
  // Gepäck auf dem Dach
  m.box(0, 1.38, -0.2, 1.5, 0.35, 1.9, 0x6b5238);
  m.box(-0.35, 1.73, -0.55, 0.7, 0.28, 0.8, 0x3d5570);
  m.box(0.4, 1.73, 0.1, 0.6, 0.3, 0.9, 0x8a3a30);
  m.box(0, 1.73, -1.05, 0.5, 0.22, 0.5, 0x7a7a52);
  m.box(0, 1.96, 0, 0.9, 0.04, 2.0, 0x2c2c2c); // Gurt/Plane
  return m.build();
}

function buildBus(): THREE.BufferGeometry {
  const m = new MeshBuilder();
  const L = 12, W = 2.5;
  m.box(0, 0.45, 0, W, 0.85, L, PAINT);
  m.box(0, 1.3, 0, W * 0.98, 1.2, L * 0.99, GLASS); // Fensterband
  for (let i = 0; i < 7; i++) m.box(0, 1.3, -L / 2 + 0.9 + i * 1.7, W * 1.0, 1.2, 0.12, PAINT); // Fensterpfosten
  m.box(0, 2.5, 0, W, 0.14, L, PAINT);
  m.box(0, 2.64, -1.5, 1.4, 0.3, 2.2, 0xcfd2d6); // Klimaanlage
  m.box(0, 2.64, 2.5, 1.1, 0.22, 1.4, 0xcfd2d6);
  m.box(0, 1.9, L / 2 + 0.01, W * 0.9, 0.35, 0.05, LIGHT_Y); // Zielanzeige
  m.box(-0.85, 0.7, L / 2 + 0.02, 0.35, 0.16, 0.05, LIGHT_Y);
  m.box(0.85, 0.7, L / 2 + 0.02, 0.35, 0.16, 0.05, LIGHT_Y);
  m.box(-0.85, 0.7, -L / 2 - 0.02, 0.3, 0.14, 0.05, LIGHT_R);
  m.box(0.85, 0.7, -L / 2 - 0.02, 0.3, 0.14, 0.05, LIGHT_R);
  m.box(0, 0.28, 0, W * 0.96, 0.2, L * 0.97, DARK);
  for (const sx of [-1, 1]) { wheel(m, sx * 1.1, 3.8, 0.5, 0.3); wheel(m, sx * 1.1, -3.0, 0.5, 0.3); wheel(m, sx * 1.1, -4.3, 0.5, 0.3); }
  m.box(-0.6, 0.9, L / 2 - 1.1, 0.8, 1.7, 0.08, GLASS, 0); // Tür
  return m.build();
}

function buildTruck(): THREE.BufferGeometry {
  const m = new MeshBuilder();
  const L = 8.5, W = 2.5;
  m.box(0, 0.5, 0, W * 0.9, 0.5, L, DARK); // Fahrgestell
  m.box(0, 0.9, 2.9, W, 1.5, 2.0, PAINT); // Fahrerhaus
  m.frustumBox(0, 2.4, 2.95, W, 1.9, W * 0.92, 1.4, 0.5, GLASS, 0, -0.2);
  m.box(0, 2.9, 2.75, W * 0.92, 0.08, 1.4, PAINT);
  m.box(0, 0.9, -0.9, W, 2.5, 5.9, 0xdcdcdc); // Koffer
  m.box(0, 3.4, -0.9, W * 1.02, 0.08, 6.0, 0xb8bcc2);
  m.box(0, 2.1, -3.86, W * 0.9, 1.9, 0.06, 0x9a9da3); // Hecktür
  m.box(-0.8, 1.0, 3.95, 0.4, 0.2, 0.05, LIGHT_Y);
  m.box(0.8, 1.0, 3.95, 0.4, 0.2, 0.05, LIGHT_Y);
  m.box(-0.8, 0.9, -4.22, 0.3, 0.2, 0.05, LIGHT_R);
  m.box(0.8, 0.9, -4.22, 0.3, 0.2, 0.05, LIGHT_R);
  for (const sx of [-1, 1]) { wheel(m, sx * 1.1, 2.9, 0.5, 0.3); wheel(m, sx * 1.1, -2.2, 0.5, 0.3); wheel(m, sx * 1.1, -3.3, 0.5, 0.3); }
  m.cyl(-1.2, 3.0, 3.6, 0.05, 0.05, 0.8, DARK, 4); // Auspuff
  return m.build();
}

function buildTrain(): THREE.BufferGeometry {
  const m = new MeshBuilder();
  const W = 3.0;
  // Lok (Spitze +Z)
  m.box(0, 0.9, 12, W, 3.0, 16, PAINT);
  m.frustumBox(0, 3.9, 12, W, 16, W * 0.85, 14, 0.4, 0xb8bcc2);
  m.box(0, 2.0, 20.01, W * 0.8, 1.2, 0.05, GLASS);
  m.box(0, 3.0, 4.01, W * 0.9, 0.9, 0.05, GLASS);
  m.box(0, 4.3, 12, 2.0, 0.3, 4, DARK);
  m.box(-0.9, 1.0, 20.02, 0.3, 0.2, 0.05, LIGHT_Y);
  m.box(0.9, 1.0, 20.02, 0.3, 0.2, 0.05, LIGHT_Y);
  m.box(0, 0.5, 12, W * 0.9, 0.5, 16, DARK);
  // Wagen
  for (let i = 0; i < 3; i++) {
    const z = -6 - i * 21;
    m.box(0, 0.9, z, W, 3.0, 20, PAINT);
    m.box(0, 2.0, z, W * 1.01, 1.0, 19, GLASS);
    for (let k = 0; k < 7; k++) m.box(0, 2.0, z - 9 + k * 3, W * 1.02, 1.0, 0.25, PAINT);
    m.box(0, 3.9, z, W * 0.9, 0.2, 20, 0xb8bcc2);
    m.box(0, 0.5, z, W * 0.9, 0.5, 20, DARK);
    m.box(0, 1.35, z, W * 1.02, 0.18, 20, 0xb23a30); // Zierstreifen
  }
  for (const zz of [18, 6, -2, -10, -23, -31, -44, -52]) {
    for (const sx of [-1, 1]) m.cyl(sx * 0.7, 0.5, zz, 0.5, 0.5, 0.15, TIRE, 6, 'x');
  }
  return m.build();
}

function buildPed(pack: boolean): THREE.BufferGeometry {
  const m = new MeshBuilder();
  m.box(-0.1, 0, 0, 0.14, 0.85, 0.16, 0x33384a);
  m.box(0.1, 0, 0, 0.14, 0.85, 0.16, 0x33384a);
  m.box(0, 0.82, 0, 0.42, 0.62, 0.24, PAINT);
  m.box(-0.28, 0.85, 0, 0.1, 0.52, 0.12, PAINT);
  m.box(0.28, 0.85, 0, 0.1, 0.52, 0.12, PAINT);
  m.box(0, 1.46, 0.01, 0.2, 0.24, 0.2, 0xd2a888);
  m.box(0, 1.66, 0.0, 0.22, 0.06, 0.22, 0x3a2e26);
  if (pack) {
    m.box(0, 0.9, -0.22, 0.34, 0.5, 0.22, 0x5a4a34);
    m.box(0.3, 0.1, 0.1, 0.34, 0.26, 0.2, 0x7a3b30);
  }
  return m.build();
}

// ------------------------------------------------------------------ Infrastruktur

const WHITE = 0xe9e9e4;
const RED = 0xc62b2b;
const WINDOW = 0x2b3844;
const ROOF_RED = 0x8a4d3c;
const ROOF_GREY = 0x6e7076;
const BRICK = 0xb0775c;
const SAND = 0xd9ccae;
const ASPHALT = 0x4a4a4d;
const GRASS = 0x5e7a45;

/** Fensterband entlang einer Fassade */
function windows(m: MeshBuilder, cx: number, y: number, cz: number, w: number, rows: number, rowH: number, d: number, step: number): void {
  for (let r = 0; r < rows; r++) {
    const yy = y + r * rowH;
    m.box(cx, yy, cz + d / 2 + 0.06, w * 0.92, rowH * 0.45, 0.12, WINDOW);
    m.box(cx, yy, cz - d / 2 - 0.06, w * 0.92, rowH * 0.45, 0.12, WINDOW);
    void step;
  }
}

function buildHospital(): THREE.BufferGeometry {
  const m = new MeshBuilder();
  m.box(0, -0.5, 0, 92, 0.6, 66, ASPHALT);
  m.box(0, 0, -4, 70, 18, 38, WHITE);
  m.box(-30, 0, 18, 24, 12, 22, WHITE);
  m.box(32, 0, 16, 20, 10, 20, WHITE);
  windows(m, 0, 3.2, -4, 70, 3, 5.2, 38, 4);
  for (let r = 0; r < 3; r++) { m.box(35.06, 3.2 + r * 5.2, -4, 0.12, 2.4, 30, WINDOW); m.box(-35.06, 3.2 + r * 5.2, -4, 0.12, 2.4, 30, WINDOW); }
  m.box(0, 18, -4, 72, 0.8, 40, 0xcfd0cc); // Dachkante
  m.box(0, 18.8, -4, 4.0, 0.3, 16, RED); // rotes Kreuz auf dem Dach
  m.box(0, 18.8, -4, 16, 0.3, 4.0, RED);
  m.box(0, 3.2, 28, 12, 0.6, 10, 0xcfd0cc); // Vordach Notaufnahme
  m.box(-5, 0, 28, 0.6, 3.2, 0.6, 0xcfd0cc);
  m.box(5, 0, 28, 0.6, 3.2, 0.6, 0xcfd0cc);
  m.box(-30, 12, 18, 26, 0.5, 24, 0xcfd0cc);
  m.cyl(32, 10, 16, 6, 6, 0.3, 0x3f8f5a, 12); // Hubschrauberlandeplatz
  m.box(32, 10.35, 16, 1.2, 0.1, 5, WHITE);
  m.box(32, 10.35, 16, 5, 0.1, 1.2, WHITE);
  m.box(-38, 0, 30, 5, 2.4, 9, 0xf0f0f0); // Krankenwagen
  m.box(-38, 1.6, 30, 5.1, 0.5, 9.1, RED);
  return m.build();
}

function buildSchool(): THREE.BufferGeometry {
  const m = new MeshBuilder();
  m.box(0, -0.5, 0, 118, 0.6, 52, GRASS);
  m.box(-6, -0.2, 14, 70, 0.4, 22, 0x8a8a84); // Schulhof
  m.box(0, 0, -10, 100, 9, 14, BRICK);
  m.gable(0, 9, -10, 102, 16, 3.5, ROOF_RED, BRICK, false);
  windows(m, 0, 2.0, -10, 100, 2, 4.0, 14, 5);
  m.box(-40, 0, 6, 16, 9, 12, BRICK);
  m.gable(-40, 9, 6, 17, 13, 3, ROOF_RED, BRICK, true);
  m.box(0, 0, -2.6, 8, 4, 2, 0xcbbf9f); // Eingang
  m.box(-30, 0, 20, 0.15, 5.5, 0.15, 0xdddddd); // Basketballkörbe
  m.box(8, 0, 20, 0.15, 4.0, 0.15, 0xdddddd);
  m.box(8, 3.6, 20, 1.2, 0.1, 1.0, 0xdddddd);
  m.box(-34, 0, 20, 0.15, 4.0, 0.15, 0xdddddd);
  m.box(-34, 3.6, 20, 1.2, 0.1, 1.0, 0xdddddd);
  m.box(50, 0, 12, 0.18, 16, 0.18, 0xd8d8d8); // Fahnenmast
  m.box(51, 14, 12, 2.0, 1.2, 0.05, 0x3a68b5);
  return m.build();
}

function buildPowerPlant(): THREE.BufferGeometry {
  const m = new MeshBuilder();
  m.box(0, -0.5, 0, 150, 0.6, 120, 0x77776f);
  m.box(-30, 0, 30, 80, 22, 26, 0x8d9096);
  m.box(-30, 22, 30, 82, 1, 28, 0x6a6d73);
  windows(m, -30, 6, 30, 80, 2, 8, 26, 4);
  m.box(20, 0, 28, 28, 40, 24, 0x7e8288);
  m.box(20, 40, 28, 29, 1, 25, 0x5e6166);
  // Schornsteine (rot/weiß geringelt)
  for (const sx of [-48, 52]) {
    for (let i = 0; i < 5; i++) m.cyl(sx, i * 20, -32, 5 - i * 0.35, 5 - (i + 1) * 0.35, 20, i % 2 ? 0xc43b30 : 0xeeeeee, 8, 'y', i === 4);
  }
  // Kühltürme
  for (const sx of [-30, 28]) {
    m.cyl(sx, 0, -28, 19, 14, 40, 0xb6b4ae, 12, 'y', false);
    m.cyl(sx, 40, -28, 14, 16, 30, 0xb6b4ae, 12, 'y', false);
    m.blob(sx, 78, -28, 9, 0xe8eaec);
    m.blob(sx + 5, 90, -26, 7, 0xe2e4e6);
    m.blob(sx + 10, 99, -22, 5, 0xdcdee0);
  }
  // Umspannwerk mit Masten
  m.box(55, 0, 25, 30, 0.6, 30, 0x8a8a80);
  for (let i = 0; i < 4; i++) {
    m.box(46 + i * 6, 0, 18, 0.5, 14, 0.5, 0x5a5d62);
    m.box(46 + i * 6, 13, 18, 4.5, 0.4, 0.4, 0x5a5d62);
    m.box(46 + i * 6, 0, 32, 0.5, 14, 0.5, 0x5a5d62);
    m.box(46 + i * 6, 13, 32, 4.5, 0.4, 0.4, 0x5a5d62);
    m.box(46 + i * 6, 12.8, 25, 0.1, 0.1, 14, 0x222222);
  }
  m.box(-60, 0, -10, 14, 9, 30, 0x9a8d78); // Kohlehalde-Lager
  m.blob(-62, 5, -10, 8, 0x2a2a2c);
  return m.build();
}

function buildWaterWorks(): THREE.BufferGeometry {
  const m = new MeshBuilder();
  m.box(0, -0.5, 0, 72, 0.6, 62, 0x6f7a62);
  for (const [x, z, r] of [[-18, -12, 10], [4, -14, 10], [24, -10, 8]] as const) {
    m.cyl(x, 0, z, r, r, 9, 0xaeb4b8, 14);
    m.cyl(x, 9, z, r, r * 0.4, 2.5, 0x8e969c, 14);
    m.box(x + r * 0.9, 0, z, 0.4, 9, 0.4, 0x666b70); // Leiter
  }
  m.box(-6, 0, 16, 26, 7, 14, SAND);
  m.gable(-6, 7, 16, 27, 15, 3.5, ROOF_GREY, SAND, false);
  m.box(-6, 2, 8.95, 20, 2.2, 0.15, WINDOW);
  m.box(24, -0.1, 14, 22, 0.5, 18, 0x2f5e7c); // Klärbecken
  m.box(24, 0.4, 14, 23, 0.4, 0.8, 0x9a9a94);
  m.box(-30, 0, 14, 14, 0.5, 2, 0x3a6e8e); // Rohrleitung
  m.cyl(-18, 9, -12, 1.2, 1.2, 14, 0x7c8186, 6); // Wasserturmmast klein
  return m.build();
}

function buildPort(): THREE.BufferGeometry {
  const m = new MeshBuilder();
  m.box(0, -0.5, 0, 150, 0.7, 100, 0x8c8c86);
  m.box(0, -0.3, 46, 150, 1.2, 6, 0x6b6a64); // Kaimauer (+Z = Wasserseite)
  // Containerstapel
  const COL = [0xb3402f, 0x2f5f9a, 0xd0a23a, 0x3c7a4c, 0x8a8f93, 0xc9612b];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 6; c++) {
    const h = 1 + ((r * 5 + c * 3) % 3);
    for (let k = 0; k < h; k++) m.box(-52 + c * 12, k * 2.6, -26 + r * 8, 11, 2.5, 6, COL[(r * 3 + c + k) % COL.length]);
  }
  m.box(-30, 0, -44, 70, 10, 14, 0xa8a49a); // Lagerhalle
  m.gable(-30, 10, -44, 72, 15, 3, ROOF_GREY, 0xa8a49a, false);
  // Portalkräne
  for (const cx of [-24, 34]) {
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) m.box(cx + sx * 9, 0, 34 + sz * 5, 1.2, 28, 1.2, 0xd5442f);
    m.box(cx, 28, 34, 20, 1.6, 12, 0xd5442f);
    m.box(cx, 28.8, 46, 3, 2, 26, 0xd5442f); // Ausleger
    m.box(cx, 30.8, 20, 3, 6, 3, 0x555a5e);
    m.box(cx, 16, 44, 0.3, 12, 0.3, 0x2a2a2a);
  }
  m.box(54, 0, 8, 8, 6, 12, 0xcfc8b0); // Verwaltungsgebäude
  return m.build();
}

function buildRailStation(): THREE.BufferGeometry {
  const m = new MeshBuilder();
  m.box(0, -0.5, 0, 150, 0.6, 44, 0x84837c);
  m.box(0, 0, -12, 110, 10, 14, SAND);
  m.gable(0, 10, -12, 112, 16, 5.5, 0x5f7667, 0x5f7667, false);
  windows(m, 0, 2.5, -12, 110, 2, 3.8, 14, 6);
  m.box(0, 0, 0, 14, 16, 12, SAND); // Mittelbau mit Uhr
  m.pyramid(0, 16, 0, 15, 13, 7, 0x4e5f55);
  m.box(0, 11, 6.1, 3.0, 3.0, 0.15, 0xf0f0e8);
  // Bahnsteig + Dach
  m.box(0, 0, 14, 120, 0.9, 8, 0xb6b4ac);
  m.box(0, 5.2, 14, 120, 0.4, 9, 0x6e7a74);
  for (let i = -5; i <= 5; i++) m.box(i * 10.5, 0.9, 17.5, 0.4, 4.3, 0.4, 0x4a4d52);
  for (const z of [10, 22]) m.box(0, -0.2, z, 148, 0.2, 0.6, 0x3a3836); // Gleise
  m.box(-46, 0.9, 14, 18, 2.8, 2.8, 0xb23a30); // abgestellter Zug
  return m.build();
}

function buildTownHall(): THREE.BufferGeometry {
  const m = new MeshBuilder();
  m.box(0, -0.5, 0, 72, 0.6, 50, 0x9c9a90);
  m.box(0, 0, 0, 56, 14, 26, 0xd6cfbb);
  m.box(0, 14, 0, 58, 1.2, 28, 0xb8b1a0);
  m.gable(0, 15.2, 4, 40, 16, 4, 0x6d7d6f, 0xd6cfbb, false); // Giebel über Mittelrisalit
  windows(m, 0, 3.2, 0, 56, 3, 3.8, 26, 4);
  for (let i = 0; i < 7; i++) m.cyl(-18 + i * 6, 0, 16, 0.9, 0.9, 12, 0xf0ead8, 8); // Säulen
  m.box(0, 12, 16, 40, 1.2, 4, 0xe6dfcb);
  m.box(0, 0, -6, 12, 40, 12, 0xcdc6b2); // Turm
  m.box(0, 40, -6, 13, 1.4, 13, 0xb8b1a0);
  m.pyramid(0, 41.4, -6, 11, 11, 14, 0x4e6a58);
  m.box(0, 32, 0.1, 5, 5, 0.3, 0xf2f0e6); // Uhr
  m.box(0, 55.4, -6, 0.3, 4, 0.3, 0xd0c070);
  m.box(26, 0, 22, 0.2, 14, 0.2, 0xdddddd);
  m.box(27.2, 12, 22, 2.4, 1.4, 0.05, 0xb43a32);
  return m.build();
}

function buildChurch(): THREE.BufferGeometry {
  const m = new MeshBuilder();
  m.box(0, -0.5, 0, 34, 0.5, 56, 0x82866f);
  m.box(0, 0, -2, 14, 12, 32, 0xcfc8b4);
  m.gable(0, 12, -2, 15, 33, 7, 0x74504a, 0xcfc8b4, true);
  m.cyl(0, 0, -20, 5, 5, 9, 0xcfc8b4, 8); // Apsis
  m.cyl(0, 9, -20, 5.4, 0.2, 4, 0x74504a, 8);
  for (let i = 0; i < 4; i++) for (const sx of [-1, 1]) m.box(sx * 7.1, 3, -12 + i * 7, 0.15, 5, 2, WINDOW);
  m.box(0, 0, 18, 8, 28, 8, 0xc8c1ad); // Turm
  m.box(0, 22, 18, 8.4, 1, 8.4, 0xb4ad99);
  m.box(0, 22, 18.0, 5, 4, 8.6, WINDOW); // Schallöffnung
  m.pyramid(0, 29, 18, 8.4, 8.4, 16, 0x4a6a60);
  m.box(0, 44, 18, 0.2, 3, 0.2, 0xd0c070);
  m.box(0, 45.6, 18, 1.4, 0.2, 0.2, 0xd0c070);
  m.box(0, 3, 22.05, 3, 5, 0.3, 0x5a3f30); // Portal
  return m.build();
}

export const INFRA_KINDS: InfraKind[] = ['hospital', 'school', 'power_plant', 'water_works', 'port', 'rail_station', 'town_hall', 'church', 'airport'];

/** Höchster Punkt (m) je Modell – für Markerhöhe */
export const INFRA_HEIGHT_M: Record<InfraKind, number> = {
  hospital: 20, school: 14, power_plant: 110, water_works: 14, port: 36, airport: 20, rail_station: 24, town_hall: 56, church: 48,
};

export type VehicleModel = 'car' | 'hatch' | 'suv' | 'bus' | 'truck' | 'carLoaded' | 'train' | 'ped' | 'pedPack';

export interface CivilGeometries {
  vehicles: Record<VehicleModel, THREE.BufferGeometry>;
  infra: Record<InfraKind, THREE.BufferGeometry>;
}

export function buildCivilGeometries(): CivilGeometries {
  const vehicles: Record<VehicleModel, THREE.BufferGeometry> = {
    car: buildCar(), hatch: buildHatch(), suv: buildSuv(), bus: buildBus(), truck: buildTruck(), carLoaded: buildCarLoaded(),
    train: buildTrain(), ped: buildPed(false), pedPack: buildPed(true),
  };
  const hospital = buildHospital();
  const infra: Record<InfraKind, THREE.BufferGeometry> = {
    hospital, school: buildSchool(), power_plant: buildPowerPlant(), water_works: buildWaterWorks(), port: buildPort(),
    rail_station: buildRailStation(), town_hall: buildTownHall(), church: buildChurch(),
    airport: buildRailStation(),
  };
  return { vehicles, infra };
}

/** Muted Lackfarben für Zivilfahrzeuge (sRGB-Hex) */
export const CAR_COLORS = [0xb9bcc0, 0x8a8f96, 0x2e3a4a, 0x6a2f2c, 0xc8c3b0, 0x3c5a48, 0x1f2023, 0x9a8a5a, 0x4d6a8a, 0xd8d8d4, 0x7a4a2e, 0x5a5f66];
export const BUS_COLORS = [0xc8d8e8, 0xe0c050, 0xcfd3d6, 0x6ab0a0];
export const TRUCK_COLORS = [0xdadada, 0xcfd4d8, 0xe0e0d8, 0xb8c4cc];
export const CLOTH_COLORS = [0x7a4a3a, 0x3d5a78, 0x5f6f4a, 0x8a8a8f, 0x6e3a52, 0xb8a064, 0x2f3a44, 0x9a5a3a];
