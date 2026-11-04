/**
 * Phase 4 – Geometrie-Werkzeuge für die prozeduralen Einheitenmodelle.
 *
 * Alles wird in einem Rutsch als nicht indizierte Dreiecksliste mit Vertexfarben aufgebaut (flach schattiert).
 * Pro Vertex ein "Paint"-Kanal: 0 = feste Farbe (Ketten, Glas), 1 = Tarnfarbe (Instanzfarbe × Vertexfarbe),
 * 2 = Teamfarbe. Oberflächendetail steckt in den Vertexfarben:
 *  - Tarnflecken: Flächen mit `camo` werden in Zellen zerlegt, jede Zelle bekommt aus 3D-Rauschen einen Farbton
 *    (Grundton / dunkel / braun) – dadurch zusammenhängende Tarnmuster über Teile hinweg.
 *  - Fake-Ambient-Occlusion: Unterseiten und untere Kanten jedes Teils werden abgedunkelt, zusätzlich eine
 *    Bodenabdunklung pro Modell (`build({ groundAO })`).
 *  - Körnung: winziger Helligkeitsjitter pro Dreieck.
 *
 * Konvention: Ursprung am Boden (Schiffe: Wasserlinie), −Z = vorn, +Y = oben, x = rechts, Einheit Meter.
 */
import * as THREE from 'three';

export type V3 = [number, number, number];

export const P_FIXED = 0;
export const P_CAMO = 1;
export const P_TEAM = 2;
/** Hautton (Soldaten-Material: Variation je Instanz) */
export const P_SKIN = 3;
/** Ausrüstungsfarbe (Weste/Taschen, je Nation getönt) */
export const P_GEAR = 4;

export interface ModelDef {
  geom: THREE.BufferGeometry;
  /** Länge/Ausdehnung in m (für Abstand & Culling) */
  size: number;
  /** zusätzliche Vergrößerung für Lesbarkeit */
  boost: number;
  /** Rotoren: [x, y, z, Radius, Achse] in m; Achse 'x' = senkrechte Heckrotor-Scheibe (Standard 'y' = Hauptrotor) */
  rotors?: Array<[number, number, number, number, ('y' | 'x')?]>;
  /** Tarnfarbe: Boden / Luft / See */
  livery: 'ground' | 'air' | 'naval' | 'heli';
  /** Neigung am Hang */
  tilt: boolean;
  /** animiertes Modell (aPart/aPivot-Attribute, Anim-Material mit Vertex-Shader-Animation) */
  anim?: 'soldier' | 'air' | 'naval';
  /** Low-Detail-Variante (gleiche Part-IDs), wird ab größerem Kameraabstand genutzt */
  lod?: ModelDef;
  /** Fahrzeug-Animation (Turm, Rohr, Rückstoß, Räder, Ketten, Radar) – nur Bodenfahrzeuge (aVPart-Attribut) */
  vanim?: AnimSpec;
}

/** Animationsparameter eines Fahrzeugmodells (Einheiten: m, rad, s) */
export interface AnimSpec {
  /** Turm-Drehgeschwindigkeit rad/s (0 = kein Turm) */
  turretRate: number;
  /** Rohr-Hubgeschwindigkeit rad/s */
  elevRate: number;
  /** Rohrerhöhung: direct = Panzer/IFV, indirect = Haubitze (nach Entfernung), launcher = Raketen (hoch beim Feuern), sam = steil bei Gefecht, aa = Flak */
  elevMode: 'none' | 'direct' | 'indirect' | 'launcher' | 'sam' | 'aa';
  /** Ruhe-/Marschstellung und maximale Erhöhung (rad) */
  elevRest: number;
  elevMax: number;
  /** Rohrrücklauf (m) */
  recoil: number;
  /** Radar-Drehgeschwindigkeit rad/s (0 = keiner) */
  radarRate: number;
  /** Federungsamplitude (m) */
  bob: number;
}

/** Teil-Arten für die Fahrzeug-GPU-Animation (aVPart.x) */
export const K_STATIC = 0;
export const K_TURRET = 1;
export const K_GUN = 2;
export const K_WHEEL = 3;
export const K_RADAR = 4;
export const K_TRACK = 5;
/** reine Drehung um die Hochachse am Drehpunkt (z), ohne Turmdrehung (Radar auf Mast) */
export const K_SPIN = 6;

/** Erkennungsfarben */
export const DARK = 0x2c2c28;
export const BLACK = 0x161614;
export const GLASS = 0x1e2a30;
export const GLASS_LIGHT = 0x3a5560;
export const GUN = 0x8c8c84;
export const STEEL = 0x66665f;
export const RUBBER = 0x24241f;
export const TRACK = 0x2a2a25;
export const WHITE = 0xf4f4f0;
export const RED = 0xc02020;
export const BLUE_UN = 0x4a8ad0;
/** Basisfarben für Tarnflächen (werden mit der Landesfarbe multipliziert) */
export const HULL = 0xe4e4e4;
export const HULL_LIGHT = 0xf4f4f4;
export const HULL_DARK = 0xb4b4b4;

export interface PartOpts {
  paint?: number;
  /** Euler (x,y,z), Reihenfolge YXZ, um den Teil-Mittelpunkt */
  rot?: V3;
  /** Skalierung der Oberseite (x, z) – Schrägen */
  top?: [number, number];
  /** Skalierung der Vorderseite (z < 0) in x – Pfeil-/Deltaformen */
  front?: number;
  /** Verschiebung der Oberseite in z */
  topShift?: number;
  /** Tarnmuster auf großen Flächen (Zellgröße in m, true = 0.9) */
  camo?: boolean | number;
  /** Stärke der Kantenabdunklung unten (0..1, Standard 0.22) */
  ao?: number;
  /** Farben je Profilkante (Drehkörper) */
  edgeColors?: number[];
  /** Skalierung [x,y,z] im Teil-Koordinatensystem vor der Drehung (Drehkörper) */
  squash?: V3;
  /** Segmente (Drehkörper) */
  seg?: number;
  /** Ränder-Skalierung X unten/oben (Extrusion entlang x) */
  taper?: [number, number];
  /** Sichtbare Flächen nur von außen (Standard); true = Rückseiten ebenfalls zeichnen */
  both?: boolean;
}

// ---------------------------------------------------------------- Rauschen

function hash3(x: number, y: number, z: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(z | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}
function vnoise(x: number, y: number, z: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => hash3(xi + dx, yi + dy, zi + dz);
  return l(
    l(l(c(0, 0, 0), c(1, 0, 0), sx), l(c(0, 1, 0), c(1, 1, 0), sx), sy),
    l(l(c(0, 0, 1), c(1, 0, 1), sx), l(c(0, 1, 1), c(1, 1, 1), sx), sy),
    sz,
  );
}
/** Tarnmuster-Variante 0..2 (nur beim Bauen; verschiebt Rauschen und Schwellen) */
let camoVariant = 0;
export function setCamoVariant(v: number): void {
  camoVariant = v;
}
/** Tarn-Tonwert 0..1 an einem Modellpunkt */
export function camoNoise(x: number, y: number, z: number): number {
  if (camoVariant) {
    x += camoVariant * 5.7;
    z += camoVariant * 3.3 + y * 0.2;
  }
  return vnoise(x * 0.55 + 11, y * 1.3, z * 0.55) * 0.65 + vnoise(x * 1.3, y * 2.4 + 5, z * 1.3) * 0.35;
}

const _c = new THREE.Color();
function rgb(hex: number): V3 {
  _c.setHex(hex);
  return [_c.r, _c.g, _c.b];
}

/** Tarntöne (Multiplikator): Grundton / dunkles Grün / Braun */
const TONE_BASE: V3 = [1, 1, 1];
const TONE_DARK: V3 = [0.62, 0.68, 0.56];
const TONE_BROWN: V3 = [1.05, 0.86, 0.66];
const TONE_LIGHT: V3 = [1.12, 1.12, 1.04];

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------- Builder

const _v = new THREE.Vector3();
const _mA = new THREE.Matrix4();
const _mB = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _one = new THREE.Vector3(1, 1, 1);

function sub(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function newell(P: V3[], face: number[]): V3 {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < face.length; i++) {
    const a = P[face[i]], b = P[face[(i + 1) % face.length]];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [nx, ny, nz];
}

export class ModelBuilder {
  readonly pos: number[] = [];
  readonly col: number[] = [];
  readonly pnt: number[] = [];
  /** Animations-Teil-ID und Drehpunkt (Modellraum) je Vertex – Vertex-Shader-Animation */
  readonly prt: number[] = [];
  readonly pvt: number[] = [];
  private curPart = 0;
  /** Fahrzeug-Animation: je Vertex (Art, Pivot y, Pivot z, Zusatz) */
  readonly vprt: number[] = [];
  private curV: [number, number, number, number] = [0, 0, 0, 0];
  usesV = false;
  /** Low-Detail-Bau: Modellfunktionen lassen Feinteile weg */
  lo = false;
  private curPivot: V3 = [0, 0, 0];
  private stack: THREE.Matrix4[] = [new THREE.Matrix4()];

  get tris(): number {
    return this.pos.length / 9;
  }

  // ---------------------------------------------------------- Transformstack

  /** Verschiebung/Drehung/Skalierung für alle folgenden Teile (bis pop). Negative Skalierung = Spiegelung. */
  push(x = 0, y = 0, z = 0, rot: V3 = [0, 0, 0], scale: V3 = [1, 1, 1]): this {
    _e.set(rot[0], rot[1], rot[2], 'YXZ');
    _q.setFromEuler(_e);
    _mA.compose(_v.set(x, y, z), _q, new THREE.Vector3(scale[0], scale[1], scale[2]));
    this.stack.push(this.stack[this.stack.length - 1].clone().multiply(_mA));
    return this;
  }
  pop(): this {
    if (this.stack.length > 1) this.stack.pop();
    return this;
  }
  /** Spiegelt (x → −x) den Inhalt von fn zusätzlich zum Original */
  mirror(fn: (side: 1 | -1) => void): this {
    fn(1);
    this.push(0, 0, 0, [0, 0, 0], [-1, 1, 1]);
    fn(-1);
    this.pop();
    return this;
  }

  private partMatrix(x: number, y: number, z: number, rot?: V3): THREE.Matrix4 {
    _e.set(rot?.[0] ?? 0, rot?.[1] ?? 0, rot?.[2] ?? 0, 'YXZ');
    _q.setFromEuler(_e);
    _mB.compose(_v.set(x, y, z), _q, _one);
    return this.stack[this.stack.length - 1].clone().multiply(_mB);
  }

  // ---------------------------------------------------------- Ausgabe

  private emit(a: V3, b: V3, c: V3, color: V3, paint: number, aoA: number, aoB: number, aoC: number, grain: number): void {
    const n = cross(sub(b, a), sub(c, a));
    if (n[0] * n[0] + n[1] * n[1] + n[2] * n[2] < 1e-12) return;
    this.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    const g = 1 + grain * (hash3(Math.round((a[0] + b[0] + c[0]) * 40), Math.round((a[1] + b[1] + c[1]) * 40), Math.round((a[2] + b[2] + c[2]) * 40)) - 0.5);
    const aos = [aoA, aoB, aoC];
    for (let i = 0; i < 3; i++) {
      this.col.push(color[0] * g * aos[i], color[1] * g * aos[i], color[2] * g * aos[i]);
      this.pnt.push(paint);
      this.prt.push(this.curPart);
      this.pvt.push(this.curPivot[0], this.curPivot[1], this.curPivot[2]);
      this.vprt.push(this.curV[0], this.curV[1], this.curV[2], this.curV[3]);
    }
  }

  /**
   * Fahrzeug-Animation: folgende Teile gehören zur Gruppe `kind` (K_*), bis vpart(K_STATIC).
   * (y, z) = Drehpunkt im aktuellen Koordinatensystem; w: Turm/Rohr/Radar = Turmachse (z), Rad = Radius,
   * Kette = Mittelhöhe des Laufbands (nur y). Im Low-Detail-Bau bleiben Räder/Ketten statisch.
   */
  vpart(kind: number, y = 0, z = 0, w = 0): this {
    if (kind === K_STATIC || (this.lo && (kind === K_WHEEL || kind === K_TRACK))) {
      this.curV = [0, 0, 0, 0];
      return this;
    }
    const m = this.stack[this.stack.length - 1];
    _v.set(0, y, z).applyMatrix4(m);
    const py = _v.y, pz = _v.z;
    let tz: number;
    if (kind === K_WHEEL) {
      _v.setFromMatrixScale(m);
      tz = w * _v.y;
    } else tz = _v.set(0, 0, w).applyMatrix4(m).z;
    this.curV = [kind, py, pz, tz];
    this.usesV = true;
    return this;
  }

  /**
   * Alle Teile in fn gehören zur Animationsgruppe `id` mit Drehpunkt `pivot` (lokal, wird mit dem aktuellen
   * Transformstack ins Modell übertragen -> vor mirror() aufrufen bzw. innerhalb, dann wird der Pivot gespiegelt).
   */
  part(id: number, pivot: V3, fn: () => void): this {
    const m = this.stack[this.stack.length - 1];
    _v.set(pivot[0], pivot[1], pivot[2]).applyMatrix4(m);
    const prevId = this.curPart, prevPv = this.curPivot;
    this.curPart = id;
    this.curPivot = [_v.x, _v.y, _v.z];
    fn();
    this.curPart = prevId;
    this.curPivot = prevPv;
    return this;
  }

  /** Flächen (CCW nach außen) ausgeben, optional Tarnzellen */
  private emitFaces(P: V3[], faces: number[][], color: number, edgeColors: number[] | undefined, o: PartOpts, minY: number, maxY: number): void {
    const paint = o.paint ?? P_CAMO;
    const base = rgb(color);
    const aoK = o.ao ?? 0.22;
    const hgt = Math.max(0.05, maxY - minY);
    const aoAt = (y: number, ny: number): number => {
      let f = 1 - aoK * (1 - smooth(0, Math.min(0.5, hgt * 0.6), y - minY));
      if (ny < -0.5) f *= 0.62;
      return f;
    };
    const grain = paint === P_FIXED ? 0.05 : 0.06;
    const camoCell = o.camo ? (typeof o.camo === 'number' ? o.camo : 0.9) : 0;
    faces.forEach((face, fi) => {
      const n = newell(P, face);
      const nl = Math.hypot(n[0], n[1], n[2]) || 1;
      const ny = n[1] / nl;
      const ec = edgeColors && edgeColors[fi] !== undefined ? rgb(edgeColors[fi]) : base;
      if (camoCell > 0 && face.length === 4 && ny > -0.5 && paint === P_CAMO) {
        const [q0, q1, q2, q3] = face.map((i) => P[i]);
        const e1 = sub(q1, q0), e2 = sub(q3, q0);
        const l1 = Math.hypot(...e1), l2 = Math.hypot(...e2);
        const nu = Math.min(6, Math.max(1, Math.round(l1 / camoCell))), nv = Math.min(4, Math.max(1, Math.round(l2 / camoCell)));
        if (nu * nv > 1 && l1 * l2 > 0.7) {
          const pt = (u: number, v: number): V3 => [
            q0[0] + e1[0] * u + e2[0] * v + (q0[0] - q1[0] + q2[0] - q3[0]) * u * v,
            q0[1] + e1[1] * u + e2[1] * v + (q0[1] - q1[1] + q2[1] - q3[1]) * u * v,
            q0[2] + e1[2] * u + e2[2] * v + (q0[2] - q1[2] + q2[2] - q3[2]) * u * v,
          ];
          for (let i = 0; i < nu; i++) {
            for (let j = 0; j < nv; j++) {
              const a = pt(i / nu, j / nv), b = pt((i + 1) / nu, j / nv), c = pt((i + 1) / nu, (j + 1) / nv), d = pt(i / nu, (j + 1) / nv);
              const cx = (a[0] + c[0]) / 2, cy = (a[1] + c[1]) / 2, cz = (a[2] + c[2]) / 2;
              const t = camoNoise(cx, cy, cz);
              const lo = camoVariant === 1 ? 0.3 : camoVariant === 2 ? 0.44 : 0.36;
              const hi = camoVariant === 1 ? 0.56 : camoVariant === 2 ? 0.7 : 0.66;
              const tone = t < lo ? TONE_DARK : t > hi ? (camoVariant === 2 ? TONE_LIGHT : TONE_BROWN) : t > hi - 0.08 ? (camoVariant === 1 ? TONE_BROWN : TONE_LIGHT) : TONE_BASE;
              const cc: V3 = [base[0] * tone[0], base[1] * tone[1], base[2] * tone[2]];
              const ao = (y: number) => aoAt(y, ny);
              this.emit(a, b, c, cc, paint, ao(a[1]), ao(b[1]), ao(c[1]), grain);
              this.emit(a, c, d, cc, paint, ao(a[1]), ao(c[1]), ao(d[1]), grain);
            }
          }
          return;
        }
      }
      for (let k = 1; k < face.length - 1; k++) {
        const a = P[face[0]], b = P[face[k]], c = P[face[k + 1]];
        this.emit(a, b, c, ec, paint, aoAt(a[1], ny), aoAt(b[1], ny), aoAt(c[1], ny), grain);
        if (o.both) this.emit(a, c, b, ec, paint, aoAt(a[1], ny), aoAt(c[1], ny), aoAt(b[1], ny), grain);
      }
    });
  }

  /** Konvexer Körper: Eckpunkte lokal, Flächen als Index-Schleifen; Orientierung automatisch nach außen */
  private solid(local: V3[], faces: number[][], x: number, y: number, z: number, color: number, o: PartOpts): this {
    const m = this.partMatrix(x, y, z, o.rot);
    const P: V3[] = local.map((v) => {
      _v.set(v[0], v[1], v[2]).applyMatrix4(m);
      return [_v.x, _v.y, _v.z];
    });
    const cen: V3 = [0, 0, 0];
    let minY = Infinity, maxY = -Infinity;
    for (const p of P) {
      cen[0] += p[0] / P.length;
      cen[1] += p[1] / P.length;
      cen[2] += p[2] / P.length;
      minY = Math.min(minY, p[1]);
      maxY = Math.max(maxY, p[1]);
    }
    const oriented = faces.map((f) => {
      const n = newell(P, f);
      const fc: V3 = [0, 0, 0];
      for (const i of f) {
        fc[0] += P[i][0] / f.length;
        fc[1] += P[i][1] / f.length;
        fc[2] += P[i][2] / f.length;
      }
      return dot(n, sub(fc, cen)) < 0 ? [...f].reverse() : f;
    });
    this.emitFaces(P, oriented, color, undefined, o, minY, maxY);
    return this;
  }

  // ---------------------------------------------------------- Primitive

  /** Quader (Breite x, Höhe y, Länge z), Mittelpunkt */
  box(w: number, h: number, l: number, x: number, y: number, z: number, color = HULL, o: PartOpts = {}): this {
    const hw = w / 2, hh = h / 2, hl = l / 2;
    const ts = o.top ?? [1, 1];
    const ts0 = o.topShift ?? 0;
    const v: V3[] = [];
    for (let i = 0; i < 8; i++) {
      const sx = i & 1 ? 1 : -1, sy = i & 2 ? 1 : -1, sz = i & 4 ? 1 : -1;
      let vx = sx * hw, vz = sz * hl;
      if (sy > 0) {
        vx *= ts[0];
        vz = vz * ts[1] + ts0;
      }
      if (o.front !== undefined && sz < 0) vx *= o.front;
      v.push([vx, sy * hh, vz]);
    }
    // Index = sx | sy<<1 | sz<<2
    const faces = [
      [0, 1, 3, 2], // -z
      [4, 5, 7, 6], // +z
      [0, 2, 6, 4], // -x
      [1, 3, 7, 5], // +x
      [0, 1, 5, 4], // -y
      [2, 3, 7, 6], // +y
    ];
    return this.solid(v, faces, x, y, z, color, o);
  }

  /**
   * Profil (z,y) entlang x extrudiert (konvexes Profil). Gut für Wannen mit Bugschräge, Keile, Rümpfe.
   * o.taper = x-Skalierung unten/oben.
   */
  extrudeX(profile: Array<[number, number]>, width: number, x: number, y: number, z: number, color = HULL, o: PartOpts = {}): this {
    const hw = width / 2;
    let minY = Infinity, maxY = -Infinity;
    for (const p of profile) {
      minY = Math.min(minY, p[1]);
      maxY = Math.max(maxY, p[1]);
    }
    const tp = o.taper ?? [1, 1];
    const n = profile.length;
    const v: V3[] = [];
    for (const sx of [-1, 1]) {
      for (const p of profile) {
        const t = maxY > minY ? (p[1] - minY) / (maxY - minY) : 0;
        v.push([sx * hw * (tp[0] + (tp[1] - tp[0]) * t), p[1], p[0]]);
      }
    }
    const faces: number[][] = [profile.map((_, i) => i), profile.map((_, i) => n + i)];
    for (let i = 0; i < n; i++) faces.push([i, (i + 1) % n, n + ((i + 1) % n), n + i]);
    return this.solid(v, faces, x, y, z, color, o);
  }

  /** Umriss (x,z) konvex, zwischen y0 und y1 extrudiert; o.top skaliert die Oberkante (x,z), o.topShift verschiebt in z */
  slab(outline: Array<[number, number]>, y0: number, y1: number, x: number, y: number, z: number, color = HULL, o: PartOpts = {}): this {
    const n = outline.length;
    const ts = o.top ?? [1, 1];
    const v: V3[] = [];
    for (const p of outline) v.push([p[0], y0, p[1]]);
    for (const p of outline) v.push([p[0] * ts[0], y1, p[1] * ts[1] + (o.topShift ?? 0)]);
    const faces: number[][] = [outline.map((_, i) => i), outline.map((_, i) => n + i)];
    for (let i = 0; i < n; i++) faces.push([i, (i + 1) % n, n + ((i + 1) % n), n + i]);
    return this.solid(v, faces, x, y, z, color, o);
  }

  /** Keil / Rampe: Dreiecksprisma, Länge l (z), Höhe h; steigt nach hinten (+z) wenn rising */
  wedge(w: number, h: number, l: number, x: number, y: number, z: number, color = HULL, o: PartOpts = {}, rising = true): this {
    const hl = l / 2, hh = h / 2;
    return this.extrudeX(rising ? [[-hl, -hh], [hl, -hh], [hl, hh]] : [[-hl, -hh], [hl, -hh], [-hl, hh]], w, x, y, z, color, o);
  }

  /**
   * Drehkörper: Profil [(r, y)] von der Achse unten nach oben (außen entlang), y = Achsenrichtung.
   * axis y: Profil-y → +y; z: Profil-y → −z (Spitze vorn); x: Profil-y → +x.
   * Offene Profile (Start nicht bei r = 0) ergeben offene Röhren.
   */
  lathe(profile: Array<[number, number]>, axis: 'x' | 'y' | 'z', x: number, y: number, z: number, color = HULL, o: PartOpts = {}): this {
    const seg = o.seg ?? 8;
    const sq = o.squash ?? [1, 1, 1];
    let axisRot: V3 = [0, 0, 0];
    if (axis === 'z') axisRot = [-Math.PI / 2, 0, 0];
    else if (axis === 'x') axisRot = [0, 0, -Math.PI / 2];
    // Teilmatrix: stack * T * R(o.rot) * axisRot
    const base = this.partMatrix(x, y, z, o.rot);
    _e.set(axisRot[0], axisRot[1], axisRot[2], 'YXZ');
    _q.setFromEuler(_e);
    const m = base.multiply(_mA.compose(_v.set(0, 0, 0), _q, _one));
    const rings = profile.length;
    const P: V3[] = [];
    const local: V3[] = [];
    let minY = Infinity, maxY = -Infinity;
    for (let k = 0; k < rings; k++) {
      for (let j = 0; j < seg; j++) {
        const a = ((j + 0.5) / seg) * Math.PI * 2;
        const lv: V3 = [Math.cos(a) * profile[k][0] * sq[0], profile[k][1] * sq[1], Math.sin(a) * profile[k][0] * sq[2]];
        local.push(lv);
        _v.set(lv[0], lv[1], lv[2]).applyMatrix4(m);
        P.push([_v.x, _v.y, _v.z]);
        minY = Math.min(minY, _v.y);
        maxY = Math.max(maxY, _v.y);
      }
    }
    const faces: number[][] = [];
    const ec: number[] = [];
    // erwartete Normale im Achsensystem prüfen -> Windungsrichtung
    const det = m.determinant();
    for (let k = 0; k < rings - 1; k++) {
      const [r0, y0] = profile[k];
      const [r1, y1] = profile[k + 1];
      const n2r = (y1 - y0) * sq[1] * 1, n2y = -(r1 - r0);
      for (let j = 0; j < seg; j++) {
        const j2 = (j + 1) % seg;
        const f = [k * seg + j, k * seg + j2, (k + 1) * seg + j2, (k + 1) * seg + j];
        // lokale Normale (vor Achsendrehung/Stack) per Newell auf lokalen Punkten
        const nl = newell(local, f);
        const am = (j + 1) / seg * Math.PI * 2 - Math.PI / seg; // Mittenwinkel der Fläche
        const exp: V3 = [n2r * Math.cos(am), n2y, n2r * Math.sin(am)];
        const flip = dot(nl, exp) < 0;
        // lokal korrekt orientiert; bei gespiegelter Gesamtmatrix kehrt sich die Windung im Weltraum um
        const worldFlip = flip !== det < 0;
        faces.push(worldFlip ? [...f].reverse() : f);
        ec.push(o.edgeColors?.[k] ?? color);
      }
    }
    this.emitFaces(P, faces, color, o.edgeColors ? ec : undefined, o, minY, maxY);
    return this;
  }

  /** Zylinder/Kegelstumpf entlang Achse; rTop an der Oberseite (y bzw. −z vorn) */
  cyl(r: number, len: number, x: number, y: number, z: number, axis: 'x' | 'y' | 'z', color = HULL, o: PartOpts = {}, seg = 6, rTop?: number): this {
    const h = len / 2;
    const rt = rTop ?? r;
    return this.lathe(rt > 0.0001 ? [[0, -h], [r, -h], [rt, h], [0, h]] : [[0, -h], [r, -h], [0, h]], axis, x, y, z, color, { ...o, seg: o.seg ?? seg });
  }

  /** Rohr: von Drehpunkt (x,y,z) nach vorn (−Z), Erhöhung elev rad */
  barrel(r: number, len: number, x: number, y: number, z: number, elev = 0, color = GUN, seg = 6): this {
    const cz = z - (Math.cos(elev) * len) / 2, cy = y + (Math.sin(elev) * len) / 2;
    return this.cyl(r, len, x, cy, cz, 'z', color, { rot: [elev, 0, 0], paint: P_FIXED }, seg, r * 0.9);
  }

  /** Einzelnes Dreieck (Position absolut, beidseitig sichtbar) */
  tri(a: V3, b: V3, c: V3, color: number, paint = P_CAMO): this {
    const m = this.stack[this.stack.length - 1];
    const P = [a, b, c].map((p) => {
      _v.set(p[0], p[1], p[2]).applyMatrix4(m);
      return [_v.x, _v.y, _v.z] as V3;
    });
    this.emitFaces(P, [[0, 1, 2], [2, 1, 0]], color, undefined, { paint, ao: 0 }, 0, 1);
    return this;
  }

  /** Flache, nach oben zeigende Platte (Luken, Markierungen, rotes Kreuz …), Mitte (x,y,z), Größe w (x) × l (z) */
  plate(w: number, l: number, x: number, y: number, z: number, color: number, paint = P_FIXED, rotY = 0): this {
    const m = this.stack[this.stack.length - 1];
    const c = Math.cos(rotY), s = Math.sin(rotY);
    const P = ([[-w / 2, -l / 2], [w / 2, -l / 2], [w / 2, l / 2], [-w / 2, l / 2]] as Array<[number, number]>).map(([px, pz]) => {
      _v.set(x + px * c + pz * s, y, z - px * s + pz * c).applyMatrix4(m);
      return [_v.x, _v.y, _v.z] as V3;
    });
    const up = newell(P, [0, 1, 2, 3])[1] >= 0;
    this.emitFaces(P, [up ? [0, 3, 2, 1] : [0, 1, 2, 3]], color, undefined, { paint, ao: 0 }, 0, 1);
    return this;
  }

  /** Senkrechte Platte in der Ebene (z,y), nach ±x zeigend (side = +1 rechts, −1 links), Mitte (x,y,z) */
  plateSide(l: number, h: number, x: number, y: number, z: number, side: 1 | -1, color: number, paint = P_FIXED): this {
    const m = this.stack[this.stack.length - 1];
    const P = ([[-l / 2, -h / 2], [l / 2, -h / 2], [l / 2, h / 2], [-l / 2, h / 2]] as Array<[number, number]>).map(([pz, py]) => {
      _v.set(x, y + py, z + pz).applyMatrix4(m);
      return [_v.x, _v.y, _v.z] as V3;
    });
    // nach außen (±x im lokalen Raum) orientieren: Normale der Weltfläche mit Weltrichtung von lokalem ±x vergleichen
    const outW = _v.set(side, 0, 0).transformDirection(m);
    const n = newell(P, [0, 1, 2, 3]);
    const flip = n[0] * outW.x + n[1] * outW.y + n[2] * outW.z < 0;
    this.emitFaces(P, [flip ? [3, 2, 1, 0] : [0, 1, 2, 3]], color, undefined, { paint, ao: 0 }, 0, 1);
    return this;
  }

  /** Senkrechte Platte in der Ebene (x,y), nach ±z zeigend (dir = −1 vorn, +1 hinten) */
  plateFront(w: number, h: number, x: number, y: number, z: number, dir: 1 | -1, color: number, paint = P_FIXED): this {
    const m = this.stack[this.stack.length - 1];
    const P = ([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]] as Array<[number, number]>).map(([px, py]) => {
      _v.set(x + px, y + py, z).applyMatrix4(m);
      return [_v.x, _v.y, _v.z] as V3;
    });
    const outW = _v.set(0, 0, dir).transformDirection(m);
    const n = newell(P, [0, 1, 2, 3]);
    const flip = n[0] * outW.x + n[1] * outW.y + n[2] * outW.z < 0;
    this.emitFaces(P, [flip ? [3, 2, 1, 0] : [0, 1, 2, 3]], color, undefined, { paint, ao: 0 }, 0, 1);
    return this;
  }

  // ---------------------------------------------------------- Zusammenbau

  /** Fertige Geometrie (flach schattiert). groundAO dunkelt Vertices nahe der Wasser-/Bodenlinie ab. */
  build(opts: { groundAO?: number; groundH?: number } = {}): THREE.BufferGeometry {
    return mergeParts([this], opts);
  }
}

/** Mehrere Builder zu einer Geometrie zusammenführen (Vertexfarben, Paint-Kanal); optional Boden-AO */
export function mergeParts(parts: ModelBuilder[], opts: { groundAO?: number; groundH?: number } = {}): THREE.BufferGeometry {
  let total = 0;
  for (const p of parts) total += p.pos.length;
  const pos = new Float32Array(total);
  const col = new Float32Array(total);
  const pnt = new Float32Array(total / 3);
  const prt = new Float32Array(total / 3);
  const pvt = new Float32Array(total);
  let o = 0, po = 0, anyPart = false;
  for (const p of parts) {
    pos.set(p.pos, o);
    col.set(p.col, o);
    pnt.set(p.pnt, po);
    prt.set(p.prt, po);
    pvt.set(p.pvt, o);
    for (const id of p.prt) if (id !== 0) anyPart = true;
    o += p.pos.length;
    po += p.pnt.length;
  }
  const gao = opts.groundAO ?? 0.3;
  const gh = opts.groundH ?? 1.0;
  if (gao > 0) {
    for (let i = 0; i < pos.length / 3; i++) {
      const y = pos[i * 3 + 1];
      const f = 1 - gao * (1 - smooth(0, gh, y));
      col[i * 3] *= f;
      col[i * 3 + 1] *= f;
      col[i * 3 + 2] *= f;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aPaint', new THREE.BufferAttribute(pnt, 1));
  if (parts.some((p) => p.usesV)) {
    const vp = new Float32Array((total / 3) * 4);
    let k = 0;
    for (const p of parts) {
      vp.set(p.vprt, k);
      k += p.vprt.length;
    }
    g.setAttribute('aVPart', new THREE.BufferAttribute(vp, 4));
  }
  if (anyPart) {
    g.setAttribute('aPart', new THREE.BufferAttribute(prt, 1));
    g.setAttribute('aPivot', new THREE.BufferAttribute(pvt, 3));
  }
  g.computeVertexNormals(); // nicht indiziert -> Flächennormalen (flach)
  g.computeBoundingSphere();
  return g;
}

export function triCount(g: THREE.BufferGeometry): number {
  return g.getAttribute('position').count / 3;
}


/**
 * Fahrzeugmodell in Hoch-/Niedrigdetail bauen, je 3 Tarnvarianten (Vertexfarben in `color`, `aCol1`, `aCol2`).
 * make(b, lo) muss deterministisch sein (gleiche Geometrie, nur andere Tarnzellenfarben).
 */
export function buildVehicleGeoms(
  make: (b: ModelBuilder, lo: boolean) => void,
  opts: { groundAO?: number; groundH?: number } = {},
): { geom: THREE.BufferGeometry; lo: THREE.BufferGeometry } {
  const out: THREE.BufferGeometry[] = [];
  for (const lo of [false, true]) {
    let base: THREE.BufferGeometry | null = null;
    for (let v = 0; v < 3; v++) {
      setCamoVariant(v);
      const b = new ModelBuilder();
      b.lo = lo;
      make(b, lo);
      const g = mergeParts([b], opts);
      if (!base) base = g;
      else {
        const c = g.getAttribute('color') as THREE.BufferAttribute;
        const bc = base.getAttribute('color') as THREE.BufferAttribute;
        base.setAttribute(v === 1 ? 'aCol1' : 'aCol2', c.count === bc.count ? c : bc);
        g.dispose();
      }
    }
    setCamoVariant(0);
    base!.deleteAttribute('normal');
    out.push(base!);
  }
  return { geom: out[0], lo: out[1] };
}
