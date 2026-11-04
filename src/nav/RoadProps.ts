/**
 * Straßenmöblierung (Props) – instanziert, kachelweise gestreamt, deterministisch aus Kanten-ID/Bogenlänge.
 *
 * Alle Props sind Low-Poly-Teile mit Vertex-Farben (flach schattiert, Lambert + Fog + log. Tiefenpuffer über
 * onBeforeCompile). Position/Maßstab werden im Vertex-Shader gesetzt:
 *   Fußpunkt = Straßenmittelpunkt + Querversatz·S  (S = strategischer Maßstab, wächst mit dem Kameraabstand),
 *   Höhe = Gelände am Fußpunkt (GPU-Höhentextur, exakt wie Terrain; Überhöhung per Uniform → „re-drapen“ gratis),
 *   Größe = Modell·S, ab maxD ausgeblendet (S → 0).
 * Instanz-Attribute (8 Floats): aI0 = (x, z, yaw, Skala), aI1 = (offX, offZ, Tint, Geländehöhe km).
 *
 * Kabel (Telefonleitung, Fahrleitung): LineSegments mit eigenem Shader (gleiche Skalierung, durchhängend).
 */
import * as THREE from 'three';
import type { GeoData } from '../world/GeoData';
import { terrainHeightKm } from '../world/Cities';
import {
  HALF_WIDTH_M, SCALE_GLSL, TILE_KM, getRoadUniforms, ihash, stationAtOrAfter, stationAtOrBefore,
  type Crossing, type RestStop, type RoadNet,
} from './RoadGeometry';

// ======================================================================= Geometrie-Baukasten (Meter)

class GB {
  p: number[] = [];
  c: number[] = [];
  i: number[] = [];
  private readonly col = new THREE.Color();

  private v(x: number, y: number, z: number, r: number, g: number, b: number): number {
    const n = this.p.length / 3;
    this.p.push(x * 0.001, y * 0.001, z * 0.001);
    this.c.push(r, g, b);
    return n;
  }

  private rgb(hex: number): [number, number, number] {
    this.col.setHex(hex);
    return [this.col.r, this.col.g, this.col.b];
  }

  /** Quader (Mittelpunkt, Ausmaße), optional gedreht (rz in der XY-Ebene, dann ry) und mit Oberseitenfarbe */
  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, hex: number, ry = 0, rz = 0, hexTop?: number): this {
    const cb = this.rgb(hex), ct = hexTop === undefined ? cb : this.rgb(hexTop);
    const crz = Math.cos(rz), srz = Math.sin(rz), cry = Math.cos(ry), sry = Math.sin(ry);
    const ids: number[] = [];
    for (let k = 0; k < 8; k++) {
      let x = (k & 1 ? 0.5 : -0.5) * sx, y = (k & 2 ? 0.5 : -0.5) * sy;
      let z = (k & 4 ? 0.5 : -0.5) * sz;
      const x1 = x * crz - y * srz, y1 = x * srz + y * crz;
      x = x1; y = y1;
      const x2 = x * cry + z * sry, z2 = -x * sry + z * cry;
      const c = k & 2 ? ct : cb;
      ids.push(this.v(cx + x2, cy + y, cz + z2, c[0], c[1], c[2]));
    }
    const q = (a: number, b: number, c: number, d: number) => this.i.push(ids[a], ids[b], ids[c], ids[a], ids[c], ids[d]);
    q(0, 1, 3, 2); q(4, 5, 7, 6); q(0, 1, 5, 4); q(2, 3, 7, 6); q(0, 2, 6, 4); q(1, 3, 7, 5);
    return this;
  }

  /** Kegelstumpf/Zylinder (Fuß bei cy) */
  cyl(cx: number, cy: number, cz: number, rb: number, rt: number, h: number, segs: number, hexB: number, hexT = hexB): this {
    const cb = this.rgb(hexB), ct = this.rgb(hexT);
    const lo: number[] = [], hi: number[] = [];
    for (let k = 0; k < segs; k++) {
      const a = (k / segs) * Math.PI * 2 + 0.4;
      lo.push(this.v(cx + Math.cos(a) * rb, cy, cz + Math.sin(a) * rb, cb[0], cb[1], cb[2]));
      hi.push(this.v(cx + Math.cos(a) * rt, cy + h, cz + Math.sin(a) * rt, ct[0], ct[1], ct[2]));
    }
    const top = this.v(cx, cy + h, cz, ct[0], ct[1], ct[2]);
    for (let k = 0; k < segs; k++) {
      const k2 = (k + 1) % segs;
      this.i.push(lo[k], lo[k2], hi[k2], lo[k], hi[k2], hi[k], hi[k], hi[k2], top);
    }
    return this;
  }

  /** Konvexes Polygon (XY) mit Dicke in z, gedreht um z (rz) und y (ry); Front +z, Rückseite -z */
  plate(cx: number, cy: number, cz: number, pts: number[], thick: number, hexFront: number, hexBack = 0x8a8f93, ry = 0, rz = 0): this {
    const cf = this.rgb(hexFront), cbk = this.rgb(hexBack);
    const n = pts.length / 2;
    const crz = Math.cos(rz), srz = Math.sin(rz), cry = Math.cos(ry), sry = Math.sin(ry);
    const tr = (x: number, y: number, z: number): [number, number, number] => {
      const x1 = x * crz - y * srz, y1 = x * srz + y * crz;
      return [cx + x1 * cry + z * sry, cy + y1, cz - x1 * sry + z * cry];
    };
    const front: number[] = [], back: number[] = [];
    let mx = 0, my = 0;
    for (let k = 0; k < n; k++) { mx += pts[k * 2]; my += pts[k * 2 + 1]; }
    mx /= n; my /= n;
    const fc = tr(mx, my, thick / 2), bc = tr(mx, my, -thick / 2);
    const fcI = this.v(fc[0], fc[1], fc[2], cf[0], cf[1], cf[2]);
    const bcI = this.v(bc[0], bc[1], bc[2], cbk[0], cbk[1], cbk[2]);
    for (let k = 0; k < n; k++) {
      const f = tr(pts[k * 2], pts[k * 2 + 1], thick / 2), b = tr(pts[k * 2], pts[k * 2 + 1], -thick / 2);
      front.push(this.v(f[0], f[1], f[2], cf[0], cf[1], cf[2]));
      back.push(this.v(b[0], b[1], b[2], cbk[0], cbk[1], cbk[2]));
    }
    for (let k = 0; k < n; k++) {
      const k2 = (k + 1) % n;
      this.i.push(fcI, front[k], front[k2], bcI, back[k2], back[k]);
      this.i.push(front[k], back[k], back[k2], front[k], back[k2], front[k2]);
    }
    return this;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.p), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.c), 3));
    g.setIndex(this.i);
    return g;
  }
}

function ngon(r: number, n: number, rot = 0, sy = 1): number[] {
  const o: number[] = [];
  for (let k = 0; k < n; k++) o.push(Math.cos(rot + (k / n) * Math.PI * 2) * r, Math.sin(rot + (k / n) * Math.PI * 2) * r * sy);
  return o;
}

// ======================================================================= Prop-Katalog

export type PropKind =
  | 'lamp' | 'lampDouble' | 'guardrail' | 'pole' | 'signSpeed' | 'signWarn' | 'signDir' | 'gantry' | 'kmPost' | 'reflector'
  | 'busStop' | 'billboard' | 'truck' | 'van' | 'car' | 'crossBarrier' | 'crossX' | 'mast' | 'shrine' | 'culvert' | 'jersey' | 'signal';

const KINDS: PropKind[] = [
  'lamp', 'lampDouble', 'guardrail', 'pole', 'signSpeed', 'signWarn', 'signDir', 'gantry', 'kmPost', 'reflector',
  'busStop', 'billboard', 'truck', 'van', 'car', 'crossBarrier', 'crossX', 'mast', 'shrine', 'culvert', 'jersey', 'signal',
];

/** Sichtweite je Art (km Kameraabstand) */
const MAX_D: Record<PropKind, number> = {
  lamp: 10, lampDouble: 10, guardrail: 7, pole: 9, signSpeed: 6, signWarn: 6, signDir: 8, gantry: 14, kmPost: 4, reflector: 4.5,
  busStop: 8, billboard: 14, truck: 8, van: 8, car: 8, crossBarrier: 8, crossX: 8, mast: 10, shrine: 6, culvert: 5, jersey: 6, signal: 7,
};

/** Zusatz-Vergrößerung kleiner Teile (bleiben sonst unter einem Pixel) */
const BOOST: Record<PropKind, number> = {
  lamp: 1.25, lampDouble: 1.25, guardrail: 1.4, pole: 1.25, signSpeed: 1.8, signWarn: 1.8, signDir: 1.5, gantry: 1.0, kmPost: 2.2, reflector: 2.4,
  busStop: 1.4, billboard: 1.0, truck: 1.2, van: 1.2, car: 1.2, crossBarrier: 1.4, crossX: 1.6, mast: 1.2, shrine: 1.8, culvert: 1.2, jersey: 1.3, signal: 1.6,
};

function signGlyphs(g: GB, cx: number, cy: number, z: number, w: number, h: number, seed: number, hex = 0xf2f2ee): void {
  // „Schrift“: 2 Zeilen weißer Blöcke unterschiedlicher Länge
  for (let row = 0; row < 2; row++) {
    let x = cx - w * 0.42;
    const y = cy + (row === 0 ? h * 0.18 : -h * 0.2);
    let k = 0;
    while (x < cx + w * 0.38) {
      const len = 0.18 + ihash(seed, row * 11 + k, 5) * 0.38;
      if (x + len > cx + w * 0.42) break;
      g.box(x + len / 2, y, z, len, h * 0.16, 0.02, hex);
      x += len + 0.12;
      k++;
    }
  }
}

function buildGeometry(kind: PropKind): THREE.BufferGeometry {
  const g = new GB();
  switch (kind) {
    case 'lamp':
      g.box(0, 0.45, 0, 0.5, 0.9, 0.5, 0x7b7f82, 0, 0, 0x8c9094);
      g.cyl(0, 0.9, 0, 0.14, 0.09, 7.3, 6, 0x5d6368, 0x8a9196);
      g.box(0, 8.15, 0.9, 0.12, 0.12, 1.9, 0x6d7478);
      g.box(0, 8.02, 1.75, 0.5, 0.2, 1.0, 0xcfcdb4, 0, 0, 0x9a9a8a);
      g.box(0, 7.9, 1.75, 0.38, 0.04, 0.8, 0xfff0b8);
      break;
    case 'lampDouble':
      g.box(0, 0.45, 0, 0.55, 0.9, 0.55, 0x7b7f82, 0, 0, 0x8c9094);
      g.cyl(0, 0.9, 0, 0.16, 0.1, 7.6, 6, 0x5d6368, 0x8a9196);
      for (const s of [-1, 1]) {
        g.box(0, 8.4, s * 0.9, 0.12, 0.12, 1.9, 0x6d7478);
        g.box(0, 8.27, s * 1.75, 0.5, 0.2, 1.0, 0xcfcdb4, 0, 0, 0x9a9a8a);
        g.box(0, 8.15, s * 1.75, 0.38, 0.04, 0.8, 0xfff0b8);
      }
      break;
    case 'guardrail':
      g.box(0, 0.62, 0, 4, 0.3, 0.07, 0xa9aeb0, 0, 0, 0xc5c9ca);
      g.box(0, 0.82, 0.01, 4, 0.06, 0.1, 0xcfd3d4);
      for (const x of [-1.9, 0, 1.9]) g.box(x, 0.37, -0.1, 0.12, 0.75, 0.12, 0x4d5254);
      break;
    case 'pole':
      g.cyl(0, 0, 0, 0.17, 0.1, 8.6, 5, 0x4a3a28, 0x7a6246);
      g.box(0, 7.9, 0, 0.12, 0.13, 2.1, 0x65503a);
      g.box(0, 7.5, -0.5, 0.06, 0.06, 0.8, 0x5a4632, 0, 0.9);
      g.box(0, 7.5, 0.5, 0.06, 0.06, 0.8, 0x5a4632, 0, -0.9);
      for (const z of [-0.9, 0.9]) g.box(0, 8.12, z, 0.1, 0.2, 0.1, 0xa5bec2);
      g.box(0, 8.8, 0, 0.1, 0.2, 0.1, 0xa5bec2);
      break;
    case 'signSpeed':
      g.cyl(0, 0, 0, 0.05, 0.045, 2.55, 5, 0x6b7074, 0x9aa0a4);
      g.plate(0, 2.55, 0.04, ngon(0.42, 10), 0.05, 0xc22b25, 0x8f9498);
      g.plate(0, 2.55, 0.07, ngon(0.31, 10), 0.03, 0xf3f2ec, 0xf3f2ec);
      g.box(-0.1, 2.55, 0.095, 0.09, 0.3, 0.02, 0x1e1e1e);
      g.box(0.1, 2.55, 0.095, 0.09, 0.3, 0.02, 0x1e1e1e);
      g.box(0, 2.67, 0.095, 0.2, 0.06, 0.02, 0x1e1e1e);
      g.box(0, 2.43, 0.095, 0.2, 0.06, 0.02, 0x1e1e1e);
      break;
    case 'signWarn': {
      g.cyl(0, 0, 0, 0.05, 0.045, 2.3, 5, 0x6b7074, 0x9aa0a4);
      const tri = [-0.55, -0.4, 0.55, -0.4, 0, 0.55];
      g.plate(0, 2.55, 0.04, tri, 0.05, 0xc42b25, 0x8f9498);
      g.plate(0, 2.52, 0.07, tri.map((v) => v * 0.64), 0.03, 0xf3f2ec, 0xf3f2ec);
      g.box(0, 2.54, 0.095, 0.08, 0.3, 0.02, 0x1e1e1e);
      g.box(0, 2.34, 0.095, 0.08, 0.07, 0.02, 0x1e1e1e);
      break;
    }
    case 'signDir':
      g.cyl(-1.0, 0, 0, 0.05, 0.05, 2.6, 5, 0x6b7074, 0x9aa0a4);
      g.cyl(1.0, 0, 0, 0.05, 0.05, 2.6, 5, 0x6b7074, 0x9aa0a4);
      g.box(0, 2.45, 0.05, 2.8, 0.95, 0.08, 0x2257a8);
      g.box(0, 2.45, 0.1, 2.66, 0.82, 0.02, 0x2d6ac0);
      signGlyphs(g, 0, 2.45, 0.115, 2.6, 0.8, 3);
      break;
    case 'gantry':
      for (const z of [-13.8, 13.8]) {
        g.box(0, 3.6, z, 0.6, 7.2, 0.6, 0x878d92, 0, 0, 0x9ba1a6);
        g.box(0, 0.25, z, 1.1, 0.5, 1.1, 0x70757a);
      }
      g.box(0, 7.0, 0, 0.7, 0.95, 28.2, 0x838990, 0, 0, 0x9aa0a6);
      g.box(0, 6.3, 0, 0.12, 0.12, 28, 0x6d7378);
      for (let k = -6; k <= 6; k++) g.box(0, 6.6, k * 2.1, 0.08, 0.7, 0.08, 0x777d82, 0, 0.0);
      for (const z of [-6.4, 6.4]) {
        for (const sx of [-1, 1]) {
          g.box(sx * 0.1, 5.4, z, 0.1, 1.9, 4.6, 0x1f4f9f);
          g.box(sx * 0.16, 5.4, z, 0.04, 1.65, 4.3, 0x2c66c0);
          // Glyphen (in der x-z-Ebene des Schildes) – als Blöcke in z-Richtung
          for (let row = 0; row < 2; row++) {
            let zz = z - 1.8;
            let k = 0;
            while (zz < z + 1.6) {
              const len = 0.3 + ihash(5, row * 7 + k + (z > 0 ? 40 : 0), 2) * 0.9;
              if (zz + len > z + 1.9) break;
              g.box(sx * 0.19, 5.4 + (row === 0 ? 0.4 : -0.35), zz + len / 2, 0.02, 0.28, len, 0xf2f2ee);
              zz += len + 0.22;
              k++;
            }
          }
          g.box(sx * 0.19, 5.4, z + 2.0, 0.02, 1.0, 0.1, 0xf2f2ee);
        }
        g.box(0, 6.2, z + 1.9, 0.08, 0.5, 0.08, 0x666b70);
        g.box(0, 6.2, z - 1.9, 0.08, 0.5, 0.08, 0x666b70);
      }
      break;
    case 'kmPost':
      g.box(0, 0.5, 0, 0.17, 1.0, 0.13, 0xe6e6de, 0, 0, 0xf0f0e8);
      g.box(0, 0.93, 0, 0.18, 0.16, 0.14, 0xbf3326);
      break;
    case 'reflector':
      g.box(0, 0.46, 0, 0.1, 0.92, 0.07, 0xeeeeea);
      g.box(0, 0.64, 0, 0.11, 0.14, 0.075, 0x1c1c1c);
      g.box(0, 0.86, 0, 0.1, 0.07, 0.075, 0xe28a24);
      break;
    case 'busStop':
      g.box(0, 1.15, -0.85, 3.2, 2.3, 0.08, 0x7f98a2, 0, 0, 0x93abb4);
      for (const x of [-1.6, 1.6]) g.box(x, 1.15, -0.1, 0.07, 2.3, 1.7, 0x5c6e76);
      g.box(0, 2.4, -0.05, 3.5, 0.14, 2.0, 0x4f5860, 0, 0, 0x6a747c);
      g.box(0, 0.5, -0.55, 2.4, 0.09, 0.45, 0x8a6a46);
      g.box(0, 0.25, -0.55, 2.2, 0.5, 0.06, 0x4a4f54);
      g.box(0, 1.5, -0.78, 1.2, 0.8, 0.03, 0xd5d09a);
      g.cyl(2.5, 0, 0.7, 0.05, 0.05, 2.7, 5, 0x6b7074, 0x9aa0a4);
      g.plate(2.5, 2.9, 0.7, ngon(0.32, 8), 0.05, 0xe2b422, 0x8f9498);
      g.box(2.5, 2.9, 0.74, 0.07, 0.3, 0.02, 0x1e1e1e);
      g.box(2.5, 2.9, 0.74, 0.22, 0.07, 0.02, 0x1e1e1e);
      break;
    case 'billboard':
      for (const x of [-2.8, 2.8]) g.box(x, 3.0, -0.2, 0.4, 6.0, 0.4, 0x5a5f63, 0, 0, 0x72777b);
      g.box(0, 7.4, 0, 8.4, 4.2, 0.35, 0x3b3e41);
      g.box(0, 7.4, 0.2, 7.8, 3.6, 0.05, 0xffffff);
      g.box(-1.6, 8.5, 0.25, 3.6, 0.6, 0.03, 0x2a2a2a);
      g.box(1.6, 8.5, 0.25, 1.4, 0.6, 0.03, 0x2a2a2a);
      g.box(0, 7.3, 0.25, 6.4, 0.9, 0.03, 0x555555);
      g.box(-2.0, 6.2, 0.25, 3.4, 0.5, 0.03, 0x2a2a2a);
      g.box(0, 5.15, 0.15, 8.4, 0.3, 0.8, 0x45494c);
      break;
    case 'truck':
      g.box(-2.6, 0.65, 0, 10.4, 0.35, 2.0, 0x2b2c2e);
      g.box(-2.6, 2.3, 0, 10.2, 2.8, 2.5, 0xe0e0da, 0, 0, 0xf2f2ec);
      g.box(-2.6, 1.05, 0, 10.0, 0.18, 2.55, 0x6d6e70);
      g.box(4.5, 1.95, 0, 2.5, 2.4, 2.4, 0xffffff, 0, 0, 0xf4f4f4);
      g.box(5.78, 2.6, 0, 0.1, 0.95, 2.2, 0x28333b);
      g.box(5.8, 1.1, 0, 0.3, 0.45, 2.45, 0x2b2c2e);
      for (const [x, z] of [[4.6, 1.15], [4.6, -1.15], [-5.2, 1.15], [-5.2, -1.15], [-3.9, 1.15], [-3.9, -1.15]]) g.box(x, 0.5, z, 1.0, 1.0, 0.4, 0x1c1c1e);
      break;
    case 'van':
      g.box(0, 1.15, 0, 5.2, 1.6, 2.0, 0xffffff, 0, 0, 0xf0f0f0);
      g.box(2.2, 1.35, 0, 0.1, 0.7, 1.8, 0x28333b);
      g.box(0, 0.45, 0, 5.0, 0.3, 1.9, 0x2b2c2e);
      for (const [x, z] of [[1.7, 0.95], [1.7, -0.95], [-1.7, 0.95], [-1.7, -0.95]]) g.box(x, 0.4, z, 0.8, 0.8, 0.3, 0x1c1c1e);
      break;
    case 'car':
      g.box(0, 0.7, 0, 4.2, 0.65, 1.78, 0xffffff, 0, 0, 0xf2f2f2);
      g.box(-0.2, 1.25, 0, 2.3, 0.55, 1.55, 0x3a4c58, 0, 0, 0x536775);
      for (const [x, z] of [[1.3, 0.85], [1.3, -0.85], [-1.3, 0.85], [-1.3, -0.85]]) g.box(x, 0.33, z, 0.66, 0.66, 0.26, 0x1c1c1e);
      break;
    case 'crossBarrier':
      g.box(0, 0.6, -0.5, 0.5, 1.2, 0.5, 0x6e7276, 0, 0, 0x8a8e92);
      g.box(0, 1.35, -0.5, 0.3, 0.2, 0.3, 0xc22b25);
      for (let k = 0; k < 7; k++) g.box(0, 1.1, 0.2 + k * 0.62, 0.1, 0.12, 0.6, k % 2 ? 0xf3f2ec : 0xc22b25);
      g.box(0, 1.28, 3.9, 0.12, 0.14, 0.12, 0xd02a20);
      break;
    case 'crossX':
      g.cyl(0, 0, 0, 0.06, 0.05, 3.0, 5, 0x6b7074, 0x9aa0a4);
      for (const s of [-1, 1]) {
        g.plate(0, 3.2, 0.05, [-0.95, -0.15, 0.95, -0.15, 0.95, 0.15, -0.95, 0.15], 0.06, 0xc22b25, 0x8f9498, 0, s * 0.62);
        g.plate(0, 3.2, 0.09, [-0.85, -0.08, 0.85, -0.08, 0.85, 0.08, -0.85, 0.08], 0.03, 0xf3f2ec, 0xf3f2ec, 0, s * 0.62);
      }
      break;
    case 'mast':
      g.box(0, 3.2, 0, 0.32, 6.4, 0.32, 0x6c7276, 0, 0, 0x84898d);
      g.box(0, 0.2, 0, 0.7, 0.4, 0.7, 0x777b7e);
      g.box(0, 5.75, 1.6, 0.1, 0.1, 3.3, 0x666c70);
      g.box(0, 5.2, 1.4, 0.07, 0.07, 3.1, 0x666c70, 0, 0.5);
      g.box(0, 5.9, 3.3, 0.08, 0.3, 0.08, 0xa8c0c4);
      break;
    case 'shrine':
      g.box(0, 0.35, 0, 0.95, 0.7, 0.95, 0x8a8880, 0, 0, 0xa09e94);
      g.box(0, 1.7, 0, 0.17, 2.0, 0.17, 0x5a4630);
      g.box(0, 2.15, 0, 1.0, 0.17, 0.15, 0x5a4630);
      g.box(0, 2.82, 0, 0.45, 0.08, 0.3, 0x403628);
      break;
    case 'culvert':
      g.box(0, 0.7, 0, 3.4, 1.4, 0.5, 0xa5a39b, 0, 0, 0xb9b7ae);
      g.box(0, 0.45, 0.26, 1.4, 0.9, 0.06, 0x1a1a1a);
      g.box(-1.85, 0.5, 0.35, 0.5, 1.0, 0.8, 0x95938b, 0.25);
      g.box(1.85, 0.5, 0.35, 0.5, 1.0, 0.8, 0x95938b, -0.25);
      break;
    case 'jersey':
      g.box(0, 0.18, 0, 4, 0.36, 0.66, 0xaeaca3);
      g.box(0, 0.6, 0, 4, 0.5, 0.36, 0xc2c0b7, 0, 0, 0xd0cec5);
      break;
    case 'signal':
      g.cyl(0, 0, 0, 0.08, 0.06, 4.2, 5, 0x555a5e, 0x777c80);
      g.box(0, 4.0, 0.12, 0.35, 0.9, 0.16, 0x25282a);
      g.box(0, 4.25, 0.21, 0.18, 0.18, 0.03, 0xd8332a);
      g.box(0, 3.8, 0.21, 0.18, 0.18, 0.03, 0x3fa656);
      break;
  }
  return g.build();
}

// ======================================================================= Materialien

/** Tint-Palette (sRGB) – Index in aI1.z */
const TINTS = [
  [1, 1, 1], [0.86, 0.26, 0.2], [0.3, 0.5, 0.9], [0.3, 0.68, 0.38], [0.96, 0.82, 0.28], [0.95, 0.52, 0.22], [0.5, 0.52, 0.55], [0.7, 0.35, 0.7],
];

const PROP_PARS = /* glsl */ `
${SCALE_GLSL}
attribute vec4 aI0;
attribute vec4 aI1;
uniform float uMaxD;
const vec3 TINTS[8] = vec3[8](${TINTS.map((c) => `vec3(${c.map((v) => Math.pow(v, 2.2).toFixed(4)).join(',')})`).join(',')});
`;

function makePropMaterial(maxD: number, shared: Record<string, THREE.IUniform>): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, shared);
    sh.uniforms.uMaxD = { value: maxD };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + PROP_PARS)
      .replace(
        '#include <color_vertex>',
        '#include <color_vertex>\n  vColor.rgb *= TINTS[int(aI1.z + 0.5)];',
      )
      .replace(
        '#include <project_vertex>',
        /* glsl */ `
        float pyaw = aI0.z;
        float pcy = cos(pyaw), psy = sin(pyaw);
        vec3 pip = vec3(aI0.x, aI1.w * uExag, aI0.y);
        float pd = max(1.0, distance(cameraPosition, pip));
        float pS = roadScale(pd) * aI0.w * step(pd, uMaxD);
        vec2 pbase = aI0.xy + aI1.xy * roadScale(pd);
        float pg = groundKm(pbase) * uExag;
        vec3 ploc = transformed * pS;
        vec3 pw = vec3(pbase.x + ploc.x * pcy + ploc.z * psy, pg + ploc.y, pbase.y - ploc.x * psy + ploc.z * pcy);
        vec4 mvPosition = viewMatrix * vec4(pw, 1.0);
        gl_Position = projectionMatrix * mvPosition;
      `,
      );
  };
  m.customProgramCacheKey = () => 'roadprops-v1';
  return m;
}

const WIRE_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
#include <fog_pars_vertex>
${SCALE_GLSL}
attribute vec4 aAB;   // A.xz, B.xz
attribute vec4 aP;    // t, offX, offZ, Höhe km
attribute float aSag; // Durchhang km
uniform float uMaxD;
void main() {
  vec2 A = aAB.xy, B = aAB.zw;
  float gA0 = groundKm(A) * uExag;
  float d = max(1.0, distance(cameraPosition, vec3(A.x, gA0, A.y)));
  float S = roadScale(d);
  vec2 pa = A + aP.yz * S, pb = B + aP.yz * S;
  float ya = groundKm(pa) * uExag, yb = groundKm(pb) * uExag;
  float t = aP.x;
  vec2 xz = mix(pa, pb, t);
  float y = mix(ya, yb, t) + (aP.w - aSag * 4.0 * t * (1.0 - t)) * S * 1.25;
  vec4 mvPosition = viewMatrix * vec4(xz.x, y, xz.y, 1.0);
  if (d > uMaxD) mvPosition = vec4(0.0, 0.0, 1.0, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;
const WIRE_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
#include <fog_pars_fragment>
uniform vec3 uColor;
void main() {
  #include <logdepthbuf_fragment>
  gl_FragColor = vec4(uColor, 1.0);
  #include <fog_fragment>
}
`;

// ======================================================================= RoadProps

export interface PropTile {
  group: THREE.Group;
  instances: number;
}

const FLOATS = 8;
const TILE_INSTANCE_CAP = 9000;

function isElectrified(net: RoadNet, x: number, z: number): boolean {
  if (net.townDist(x, z) < 5) return true;
  return ihash(Math.floor(x / 14), Math.floor(z / 14), 91) < 0.3;
}

export class RoadProps {
  private readonly geo: GeoData;
  private readonly net: RoadNet;
  private readonly geoms = new Map<PropKind, THREE.BufferGeometry>();
  private readonly mats = new Map<PropKind, THREE.MeshLambertMaterial>();
  private readonly wireMats: THREE.ShaderMaterial[] = [];
  private readonly uniforms: Record<string, THREE.IUniform>;
  private readonly nodeBridge: Uint8Array;
  /** Gesamtzahl lebender Instanzen */
  total = 0;

  constructor(geo: GeoData, net: RoadNet, fogUniforms: Record<string, THREE.IUniform>) {
    this.geo = geo;
    this.net = net;
    this.uniforms = getRoadUniforms(geo);
    this.nodeBridge = new Uint8Array(net.graph.nodes.length);
    for (const e of net.graph.edges) if (e.bridge) { this.nodeBridge[e.a] = 1; this.nodeBridge[e.b] = 1; }
    void fogUniforms;
  }

  private geom(kind: PropKind): THREE.BufferGeometry {
    let g = this.geoms.get(kind);
    if (!g) this.geoms.set(kind, (g = buildGeometry(kind)));
    return g;
  }

  private mat(kind: PropKind): THREE.MeshLambertMaterial {
    let m = this.mats.get(kind);
    if (!m) this.mats.set(kind, (m = makePropMaterial(MAX_D[kind], this.uniforms)));
    return m;
  }

  private wireMat(color: number, maxD: number): THREE.ShaderMaterial {
    const m = new THREE.ShaderMaterial({
      vertexShader: WIRE_VERT,
      fragmentShader: WIRE_FRAG,
      fog: true,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uColor: { value: new THREE.Color(color) }, uMaxD: { value: maxD } }]),
    });
    Object.assign(m.uniforms, this.uniforms);
    this.wireMats.push(m);
    return m;
  }

  private wm: { pole: THREE.ShaderMaterial; cat: THREE.ShaderMaterial } | null = null;

  /** Baut alle Props der Kachel (tx,tz) */
  buildTile(tx: number, tz: number, crossings: Crossing[], stops: RestStop[]): PropTile | null {
    const net = this.net, graph = net.graph, geo = this.geo;
    const x0 = tx * TILE_KM, x1 = x0 + TILE_KM, z0 = tz * TILE_KM, z1 = z0 + TILE_KM;
    const data = new Map<PropKind, number[]>();
    let count = 0;
    const wirePole: number[] = [], wireCat: number[] = []; // je Segmentende 9 Floats: aAB(4) aP(4) aSag(1)
    const inTile = (x: number, z: number) => x >= x0 && x < x1 && z >= z0 && z < z1;

    const add = (kind: PropKind, x: number, z: number, yaw: number, offX: number, offZ: number, tint = 0, scale = 1) => {
      if (count >= TILE_INSTANCE_CAP) return;
      let a = data.get(kind);
      if (!a) data.set(kind, (a = []));
      a.push(x, z, yaw, scale * BOOST[kind], offX, offZ, tint, Math.max(0, terrainHeightKm(geo, x, z)));
      count++;
    };
    /** Prop seitlich der Straße: side=+1 rechts (Normale n), Querabstand latM; blickt zur Straße */
    const addSide = (kind: PropKind, x: number, z: number, tx_: number, tz_: number, side: number, latM: number, alongM = 0, tint = 0, scale = 1, yawAdd = 0) => {
      const nx = -tz_, nz = tx_;
      const yaw = Math.atan2(-tz_, tx_) + (side > 0 ? Math.PI : 0) + yawAdd;
      add(kind, x + tx_ * alongM * 0.001, z + tz_ * alongM * 0.001, yaw, nx * side * latM * 0.001, nz * side * latM * 0.001, tint, scale);
    };
    const tmp = new Float64Array(4);
    const tmp2 = new Float64Array(4);

    const wireSpan = (arr: number[], ax: number, az: number, bx: number, bz: number, offx: number, offz: number, hgtM: number, sagM: number, segs: number) => {
      for (let k = 0; k < segs; k++) {
        const t0 = k / segs, t1 = (k + 1) / segs;
        arr.push(ax, az, bx, bz, t0, offx, offz, hgtM * 0.001, sagM * 0.001);
        arr.push(ax, az, bx, bz, t1, offx, offz, hgtM * 0.001, sagM * 0.001);
      }
    };

    const edges = net.tileEdges(tx, tz);
    if (edges) {
      for (let li = 0; li < edges.length; li += 3) {
        const e = graph.edges[edges[li]];
        if (e.bridge || e.cls === 'ferry') continue;
        const sLo = edges[li + 1], sHi = edges[li + 2];
        const st = net.stations(e.id);
        const L = st.total;
        const hwM = HALF_WIDTH_M[e.cls];
        const id = e.id;
        const nearBridgeA = this.nodeBridge[e.a] === 1, nearBridgeB = this.nodeBridge[e.b] === 1;

        /** Läuft s = start + k·spacing über [sLo,sHi]; fn(s, x, z, tx, tz, k) */
        const walk = (spacing: number, phase: number, fn: (s: number, x: number, z: number, ax: number, az: number, k: number) => void, margin = 0) => {
          const sp = spacing * 0.001;
          const ph = phase - Math.floor(phase);
          let k = Math.max(0, Math.ceil(sLo / sp - ph));
          for (; ; k++) {
            const s = (ph + k) * sp;
            if (s > sHi || s > L - margin) break;
            if (s < margin) continue;
            net.pointAt(st, s, tmp);
            if (!inTile(tmp[0], tmp[1])) continue;
            fn(s, tmp[0], tmp[1], tmp[2], tmp[3], k);
          }
        };

        const cls = e.cls;
        if (cls === 'motorway') {
          // Mittelstreifen-Leitwand, Lampen im Mittelstreifen, Reflektoren, Leitplanken
          walk(4, 0, (_s, x, z, ax, az) => add('jersey', x, z, Math.atan2(-az, ax), 0, 0));
          walk(40, 0, (_s, x, z, ax, az) => {
            const q = net.townDist(x, z);
            if (q < 1.2 || (q < 2.4 && ((x * 1000) | 0) % 2 === 0)) add('lampDouble', x, z, Math.atan2(-az, ax), 0, 0);
          });
          for (const side of [-1, 1]) {
            walk(50, ihash(id, 3, 1) * 3, (_s, x, z, ax, az) => addSide('reflector', x, z, ax, az, side, 12.6));
          }
          // Schilderbrücken
          const nG = Math.floor(L / 1.6);
          for (let k = 0; k < nG; k++) {
            if (ihash(id, 17, k) > 0.7) continue;
            const s = (k + 0.5) * (L / nG);
            if (s < sLo || s > sHi) continue;
            net.pointAt(st, s, tmp);
            if (inTile(tmp[0], tmp[1])) add('gantry', tmp[0], tmp[1], Math.atan2(-tmp[3], tmp[2]), 0, 0);
          }
          // Leitplanken-Außenseiten an Brückenzufahrten
        } else if (cls === 'primary') {
          walk(40, 0, (_s, x, z, ax, az, k) => {
            const q = net.townDist(x, z);
            if (q < 1.3) addSide('lamp', x, z, ax, az, k % 2 ? 1 : -1, hwM - 1.0);
          });
          for (const side of [-1, 1]) walk(50, ihash(id, 3, 2) * 3, (_s, x, z, ax, az) => addSide('reflector', x, z, ax, az, side, 4.4));
        } else if (cls === 'secondary' || cls === 'road') {
          const rr = cls === 'secondary' ? 3.4 : 2.8;
          walk(60, 0, (_s, x, z, ax, az, k) => {
            if (net.townDist(x, z) < 1.0) addSide('lamp', x, z, ax, az, k % 2 ? 1 : -1, rr);
          });
          for (const side of [-1, 1]) walk(cls === 'secondary' ? 60 : 80, ihash(id, 3, 3) * 3, (_s, x, z, ax, az) => addSide('reflector', x, z, ax, az, side, rr + 0.5));
        } else if (cls === 'track') {
          walk(120, ihash(id, 3, 4) * 3, (_s, x, z, ax, az, k) => addSide('reflector', x, z, ax, az, k % 2 ? 1 : -1, 2.6));
        }

        // Telefonmasten (nur kleinere Straßen), eine Seite je Kante, Leitungen durchhängend
        if ((cls === 'secondary' || cls === 'road' || cls === 'track') && !e.bridge) {
          const mid = [st.xz[(st.n >> 1) * 2], st.xz[(st.n >> 1) * 2 + 1]];
          const near = net.townDist(mid[0], mid[1]) < 3.2;
          const gate = cls === 'track' ? 0.12 : near ? 0.8 : 0.4;
          if (ihash(id, 21, 0) < gate) {
            const side = ihash(id, 21, 1) < 0.5 ? -1 : 1;
            const lat = hwM + 1.6;
            const SP = 45;
            const kMax = Math.floor((L * 1000) / SP);
            let prev: { x: number; z: number; ox: number; oz: number } | null = null;
            for (let k = 0; k <= kMax; k++) {
              const s = k * SP * 0.001 + 0.01;
              if (s > L - 0.01) break;
              net.pointAt(st, s, tmp);
              const nx = -tmp[3], nz = tmp[2];
              const ox = nx * side * lat * 0.001, oz = nz * side * lat * 0.001;
              const here = inTile(tmp[0], tmp[1]);
              if (here) addSide('pole', tmp[0], tmp[1], tmp[2], tmp[3], side, lat, 0, 0, 1, Math.PI * 0.5 * 0);
              if (prev && (here || inTile(prev.x, prev.z))) {
                for (const w of [-0.95, 0.95]) {
                  wireSpan(wirePole, prev.x, prev.z, tmp[0], tmp[1], prev.ox + nx * w * 0.001, prev.oz + nz * w * 0.001, 8.1, 0.8, 5);
                }
              }
              prev = { x: tmp[0], z: tmp[1], ox, oz };
            }
          }
        }

        // Kilometerstein je Kante
        if (cls !== 'track') {
          const s = L * 0.5;
          if (s >= sLo && s <= sHi) {
            net.pointAt(st, s, tmp);
            if (inTile(tmp[0], tmp[1])) addSide('kmPost', tmp[0], tmp[1], tmp[2], tmp[3], 1, hwM - 0.4, 0, 0);
          }
        }

        // Leitplanken: Brückenzufahrten + steile Hänge (nur Motorway/Primary/Secondary)
        if (cls === 'motorway' || cls === 'primary' || cls === 'secondary') {
          const rail = cls === 'motorway' ? hwM - 1.8 : cls === 'primary' ? hwM - 0.9 : hwM - 0.7;
          const reach = 0.13;
          walk(4, 0.5, (s, x, z, ax, az) => {
            const nb = (nearBridgeA && s < reach) || (nearBridgeB && s > L - reach);
            for (const side of [-1, 1]) {
              let want = nb;
              if (!want) {
                // Quergefälle: Höhenunterschied Straße ↔ 7 m seitlich
                const nx = -az, nz = ax;
                const h0 = terrainHeightKm(geo, x, z);
                const h1 = terrainHeightKm(geo, x + nx * side * 0.007, z + nz * side * 0.007);
                want = h0 - h1 > 0.0011;
              }
              if (want) addSide('guardrail', x, z, ax, az, side, rail);
            }
          });
        }

        // Verkehrszeichen an Verzweigungen (Geschwindigkeit, Richtungsschild)
        if (cls === 'motorway' || cls === 'primary' || cls === 'secondary') {
          for (const end of [0, 1]) {
            const node = graph.nodes[end === 0 ? e.a : e.b];
            if (node.edges.length < 3) continue;
            const s = end === 0 ? 0.07 : L - 0.07;
            const s2 = end === 0 ? 0.14 : L - 0.14;
            if (s < sLo || s > sHi) { /* ggf. andere Kachel */ }
            net.pointAt(st, s, tmp);
            if (inTile(tmp[0], tmp[1])) addSide('signSpeed', tmp[0], tmp[1], tmp[2], tmp[3], end === 0 ? -1 : 1, hwM + 0.6, 0, 0);
            net.pointAt(st, s2, tmp2);
            if (inTile(tmp2[0], tmp2[1])) addSide('signDir', tmp2[0], tmp2[1], tmp2[2], tmp2[3], end === 0 ? -1 : 1, hwM + 1.8, 0, cls === 'motorway' ? 0 : 3, 1);
          }
          // Warnzeichen vor Kurven (Knick in der Originalgeometrie)
          const g = e.geom;
          for (let k = 2; k + 3 < g.length; k += 2) {
            const ax = g[k] - g[k - 2], az = g[k + 1] - g[k - 1], bx = g[k + 2] - g[k], bz = g[k + 3] - g[k + 1];
            const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
            if (la < 1e-6 || lb < 1e-6) continue;
            const turn = Math.abs(Math.atan2(ax * bz - az * bx, ax * bx + az * bz));
            if (turn < 0.28) continue;
            const px = g[k], pz = g[k + 1];
            if (!inTile(px, pz)) continue;
            addSide('signWarn', px - (ax / la) * 0.09, pz - (az / la) * 0.09, ax / la, az / la, 1, hwM + 1.0, 0, 0);
            addSide('signWarn', px + (bx / lb) * 0.09, pz + (bz / lb) * 0.09, -bx / lb, -bz / lb, 1, hwM + 1.0, 0, 0);
          }
        }

        // Bushaltestellen am Ortsrand
        if (cls === 'primary' || cls === 'secondary' || cls === 'road') {
          walk(500, 0.5, (s, x, z, ax, az, k) => {
            const q = net.townDist(x, z);
            if (q > 0.8 && q < 2.3 && ihash(id, 33, k) < 0.5) addSide('busStop', x, z, ax, az, ihash(id, 34, k) < 0.5 ? -1 : 1, hwM + 3.2, 0, 0);
            void s;
          }, 0.06);
        }

        // Kapellen/Kreuze an Landstraßen
        if ((cls === 'road' || cls === 'secondary' || cls === 'track') && ihash(id, 41, 0) < 0.14) {
          const s = L * (0.2 + 0.6 * ihash(id, 41, 1));
          if (s >= sLo && s <= sHi) {
            net.pointAt(st, s, tmp);
            if (inTile(tmp[0], tmp[1])) addSide('shrine', tmp[0], tmp[1], tmp[2], tmp[3], ihash(id, 41, 2) < 0.5 ? -1 : 1, hwM + 2.2, 0, 0);
          }
        }

        // Durchlass: lokales Geländeminimum quer zur Straße (Bach)
        if ((cls === 'primary' || cls === 'secondary' || cls === 'road') && L > 0.3) {
          let bestS = -1, bestDip = 0.0025;
          for (let s = 0.09; s < L - 0.09; s += 0.02) {
            net.pointAt(st, s, tmp);
            const h = terrainHeightKm(geo, tmp[0], tmp[1]);
            net.pointAt(st, s - 0.07, tmp2);
            const hA = terrainHeightKm(geo, tmp2[0], tmp2[1]);
            net.pointAt(st, s + 0.07, tmp2);
            const hB = terrainHeightKm(geo, tmp2[0], tmp2[1]);
            const dip = Math.min(hA, hB) - h;
            if (dip > bestDip) { bestDip = dip; bestS = s; }
          }
          if (bestS >= 0) {
            net.pointAt(st, bestS, tmp);
            if (inTile(tmp[0], tmp[1])) {
              addSide('culvert', tmp[0], tmp[1], tmp[2], tmp[3], 1, hwM + 0.9, 0, 0, 1, Math.PI * 0.5);
              addSide('culvert', tmp[0], tmp[1], tmp[2], tmp[3], -1, hwM + 0.9, 0, 0, 1, Math.PI * 0.5);
            }
          }
        }

        // Fahrleitung (Masten + Draht) an elektrifizierten Strecken, Signale
        if (cls === 'rail') {
          const mx = st.xz[(st.n >> 1) * 2], mz = st.xz[(st.n >> 1) * 2 + 1];
          if (isElectrified(net, mx, mz)) {
            const SP = 50;
            let prev: { x: number; z: number } | null = null;
            const kMax = Math.floor((L * 1000) / SP);
            for (let k = 0; k <= kMax; k++) {
              const s = k * SP * 0.001 + 0.005;
              if (s > L - 0.005) break;
              net.pointAt(st, s, tmp);
              const here = inTile(tmp[0], tmp[1]);
              const side = k % 2 ? 1 : -1;
              if (here) addSide('mast', tmp[0], tmp[1], tmp[2], tmp[3], side, 3.4);
              if (prev && (here || inTile(prev.x, prev.z))) wireSpan(wireCat, prev.x, prev.z, tmp[0], tmp[1], 0, 0, 5.5, 0.18, 3);
              prev = { x: tmp[0], z: tmp[1] };
            }
          }
          walk(700, 0.3, (_s, x, z, ax, az, k) => addSide('signal', x, z, ax, az, 1, 3.6, 0, 0, 1, k % 2 ? 0 : 0), 0.05);
        }
      }
    }

    // Reklametafeln an Autobahn-Anschlüssen nahe Städten
    const nodes = net.tileNodes(tx, tz);
    if (nodes) {
      for (const nid of nodes) {
        const n = graph.nodes[nid];
        if (n.edges.length < 3 || !inTile(n.x, n.z)) continue;
        const me = n.edges.find((q) => graph.edges[q].cls === 'motorway');
        if (me === undefined) continue;
        if (net.townDist(n.x, n.z) > 3.5 || ihash(nid, 51, 0) > 0.8) continue;
        const e = graph.edges[me];
        const st = net.stations(e.id);
        const s = e.a === nid ? 0.16 : st.total - 0.16;
        net.pointAt(st, s, tmp);
        const side = ihash(nid, 51, 1) < 0.5 ? -1 : 1;
        if (inTile(tmp[0], tmp[1])) addSide('billboard', tmp[0], tmp[1], tmp[2], tmp[3], side, 38, 0, 1 + Math.floor(ihash(nid, 51, 2) * 6));
      }
    }

    // Bahnübergänge: Schranken + Andreaskreuze
    for (const c of crossings) {
      const rtx = c.rtx, rtz = c.rtz;
      for (const along of [-1, 1]) {
        for (const side of [-1, 1]) {
          const px = c.x + c.ttx * along * 0.0065, pz = c.z + c.ttz * along * 0.0065;
          // Schranke steht neben der Fahrbahn, Arm quert die Straße (Längsachse = Straßenquerrichtung)
          const nx = -rtz, nz = rtx;
          const ox = nx * side * (c.roadHwM * 0.62) * 0.001, oz = nz * side * (c.roadHwM * 0.62) * 0.001;
          const yaw = Math.atan2(-rtz, rtx) + (side > 0 ? Math.PI : 0);
          void ox; void oz;
          add('crossBarrier', px, pz, yaw, nx * side * (c.roadHwM * 0.7) * 0.001, nz * side * (c.roadHwM * 0.7) * 0.001);
        }
        const px = c.x + c.ttx * along * 0.0085, pz = c.z + c.ttz * along * 0.0085;
        const nx = -rtz, nz = rtx;
        add('crossX', px, pz, Math.atan2(-rtz, rtx) + (along > 0 ? Math.PI : 0), nx * (c.roadHwM * 1.15) * 0.001, nz * (c.roadHwM * 1.15) * 0.001);
      }
    }

    // Rastplätze: geparkte Fahrzeuge
    for (const r of stops) {
      const lat = r.hwM * 0.95 + 5.0;
      const kinds: PropKind[] = ['truck', 'truck', 'van', 'truck', 'car'];
      const n = 3 + Math.floor(ihash(r.edge, 8, 1) * 2);
      for (let k = 0; k < n; k++) {
        const alongM = -34 + k * 24 + (ihash(r.edge, 8, 10 + k) - 0.5) * 4;
        const kind = kinds[(k + Math.floor(ihash(r.edge, 8, 2) * 5)) % kinds.length];
        const dirFlip = ihash(r.edge, 9, k) < 0.5 ? 0 : Math.PI;
        addSide(kind, r.x, r.z, r.tx, r.tz, r.side, lat + (kind === 'truck' ? 0.4 : 0), alongM, 1 + Math.floor(ihash(r.edge, 10, k) * 7), 1, 0);
        // Fahrtrichtung variieren: zuletzt hinzugefügte Instanz drehen
        const arr = data.get(kind);
        if (arr && dirFlip) arr[arr.length - FLOATS + 2] += Math.PI;
      }
      addSide('signDir', r.x, r.z, r.tx, r.tz, r.side, r.hwM + 2.2, -50, 0, 1);
    }

    // ------------------------------------------------------------------ Meshes zusammensetzen
    if (count === 0 && wirePole.length === 0 && wireCat.length === 0) return null;
    const group = new THREE.Group();
    group.name = `RoadProps-${tx}-${tz}`;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    for (const [kind, arr] of data) {
      const base = this.geom(kind);
      const n = arr.length / FLOATS;
      const ig = new THREE.InstancedBufferGeometry();
      ig.setIndex(base.index);
      ig.setAttribute('position', base.attributes.position);
      ig.setAttribute('color', base.attributes.color);
      const buf = new Float32Array(arr);
      const ib = new THREE.InstancedInterleavedBuffer(buf, FLOATS, 1);
      ig.setAttribute('aI0', new THREE.InterleavedBufferAttribute(ib, 4, 0));
      ig.setAttribute('aI1', new THREE.InterleavedBufferAttribute(ib, 4, 4));
      ig.instanceCount = n;
      ig.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, 0, cz), 1e5);
      const mesh = new THREE.Mesh(ig, this.mat(kind));
      mesh.frustumCulled = false;
      mesh.name = `prop-${kind}`;
      mesh.renderOrder = 4;
      group.add(mesh);
    }
    if (!this.wm) this.wm = { pole: this.wireMat(0x1c1c1e, 9), cat: this.wireMat(0x2b2d30, 10) };
    for (const [arr, mat] of [[wirePole, this.wm.pole], [wireCat, this.wm.cat]] as Array<[number[], THREE.ShaderMaterial]>) {
      if (arr.length === 0) continue;
      const n = arr.length / 9;
      const ab = new Float32Array(n * 4), pp = new Float32Array(n * 4), sg = new Float32Array(n);
      for (let k = 0; k < n; k++) {
        ab.set(arr.slice(k * 9, k * 9 + 4), k * 4);
        pp.set(arr.slice(k * 9 + 4, k * 9 + 8), k * 4);
        sg[k] = arr[k * 9 + 8];
      }
      const lg = new THREE.BufferGeometry();
      lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      lg.setAttribute('aAB', new THREE.BufferAttribute(ab, 4));
      lg.setAttribute('aP', new THREE.BufferAttribute(pp, 4));
      lg.setAttribute('aSag', new THREE.BufferAttribute(sg, 1));
      lg.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, 0, cz), 1e5);
      const ls = new THREE.LineSegments(lg, mat);
      ls.frustumCulled = false;
      ls.renderOrder = 4;
      group.add(ls);
    }
    this.total += count;
    return { group, instances: count };
  }

  disposeTile(t: PropTile): void {
    t.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry && (m as THREE.Mesh).isMesh) {
        const g = m.geometry as THREE.InstancedBufferGeometry;
        // geteilte Basis-Attribute nicht freigeben: abkoppeln, nur Instanz-Attribute verlieren
        g.deleteAttribute('position');
        g.deleteAttribute('color');
        g.setIndex(null);
        g.dispose();
      } else if ((o as THREE.LineSegments).isLineSegments) {
        (o as THREE.LineSegments).geometry.dispose();
      }
    });
    t.group.removeFromParent();
    this.total -= t.instances;
  }

  setExag(): void { /* Überhöhung kommt über geteilte Uniform */ }

  /** Hilfsfunktionen für Tests */
  kinds(): PropKind[] { return KINDS; }
}

export { stationAtOrAfter, stationAtOrBefore };
