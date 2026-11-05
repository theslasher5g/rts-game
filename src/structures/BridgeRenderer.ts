/**
 * Phase 3 – Brücken: detaillierte Low-Poly-Brücken für alle NavEdges mit bridge === true (ohne Fähren), lazy je 40-km-Kachel
 * als ein Mesh gebaut (nur nahe der Kamera, Kameraabstand < 60 km; ≤ 3 Kacheln/Frame, LRU).
 *
 * Bauformen nach Spannweite / Klasse:
 *   Straße  < 0,45 km  Balkenbrücke (Pfeiler rechteckig mit Kappe)
 *           0,45–0,62  Bogenbrücke (oberliegender Bogen + Hänger) oder Fachwerk (je Kante per Hash)
 *           ≥ 0,62     Schrägseilbrücke (H-Pylon + Seilfächer)
 *   Schiene           Fachwerkträger (Gurte, Pfosten, Diagonalen, Querverbände), Schotterbett mit Schienen
 * Fahrbahn: Platte mit Kappen/Bordsteinen, Gehwegen, Geländer + Pfosten, Dehnfugen, Laternen (kleine Straßen),
 * Mittel-/Randmarkierung; Widerlager an den Enden, Pfeiler (rund/eckig) je nach Bauform.
 * Zerstört (edge.open === false, Bus 'nav:edge' / 'bridge:destroyed'): Lücke im mittleren Drittel, abgeknickte
 * Fahrbahnstücke, verbogene Geländer, freiliegende Bewehrung, Pfeilerstümpfe, Trümmer; repariert (open) -> wieder intakt.
 *
 * Skalierung: Alle Vertices hängen an einem Straßen-Stützpunkt (Mittelpunkt + Tangente + Fahrbahnhöhe); Quer-/Höhen-/
 * Längsversatz werden im Vertex-Shader mit dem strategischen Straßenmaßstab S(d) multipliziert (wie das Fahrbahnband).
 * Pfeilerfüße (Modus 1) sitzen auf der GPU-Geländehöhe (gleiche Textur wie Terrain). Überhöhungswechsel = Uniform.
 */
import * as THREE from 'three';
import { bus } from '../core/EventBus';
import type { Settings } from '../core/types';
import type { NavEdge } from '../nav/types';
import type { NavGraph } from '../nav/NavGraph';
import type { GeoData } from '../world/GeoData';
import { terrainHeightKm } from '../world/Cities';
import { SCALE_GLSL, getRoadNet, getRoadUniforms, ihash, type RoadNet, type Stations } from '../nav/RoadGeometry';
import { Q } from '../core/quality';

const CHUNK_KM = 40;
// Sichtweite der Brückenmodelle: Q.bridgeDist (hoch = 60 km)
const REBUILDS_PER_FRAME = 3;
const MAX_BUILT = 40;
const G = 0.001;

// Farben (sRGB-Hex, werden von THREE nach linear gewandelt)
const C_ASPH = 0x3c3c40, C_WHITE = 0xe2e0d6, C_YELLOW = 0xd2ad2e;
const C_CONC = 0x9d9a91, C_CONC_D = 0x77746d, C_CONC_L = 0xb5b2a8;
const C_STEEL = 0x6c727a, C_STEEL_L = 0x8c939b, C_TRUSS = 0x4f5a66, C_TRUSS_L = 0x687684;
const C_RUST = 0x7b4a2e, C_PYLON = 0xb7b3a8, C_CABLE = 0xdcd8cb, C_BALLAST = 0x6d6960, C_SLEEPER = 0x30291f;
const C_LAMP = 0x6d7478, C_GLOW = 0xfff0b8, C_JOINT = 0x1d1d1f, C_BROKEN = 0x4a4540;
const C_RUBBLE = [0x57534d, 0x423e39, 0x6c665d, 0x5b4c42, 0x7d7a72];

const SHADER_PARS = /* glsl */ `
${SCALE_GLSL}
attribute vec3 aFrame;   // Tangente x,z ; Modus (0 = an Fahrbahnhöhe, 1 = am Gelände)
attribute vec3 aLoc;     // Quer-, Höhen-, Längsversatz (km, vor Maßstab)
`;

function makeMaterial(shared: Record<string, THREE.IUniform>): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, shared);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + SHADER_PARS)
      .replace(
        '#include <project_vertex>',
        /* glsl */ `
        vec3 bc = vec3(position.x, position.y * uExag, position.z);
        float bd = max(1.0, distance(cameraPosition, bc));
        float bS = roadScale(bd);
        vec2 btan = aFrame.xy;
        vec2 bperp = vec2(-btan.y, btan.x);
        vec2 bxz = position.xz + bperp * aLoc.x * bS + btan * aLoc.z * bS;
        float by = aFrame.z < 0.5 ? position.y * uExag + aLoc.y * bS : groundKm(bxz) * uExag + aLoc.y * bS;
        vec4 mvPosition = viewMatrix * vec4(bxz.x, by, bxz.y, 1.0);
        gl_Position = projectionMatrix * mvPosition;
      `,
      );
  };
  m.customProgramCacheKey = () => 'bridge-v1';
  return m;
}

// ======================================================================= Geometrie-Baukasten

interface Face { la: number; ua: number; lb: number; ub: number; hex: number }

class BB {
  p: number[] = [];
  fr: number[] = [];
  lo: number[] = [];
  c: number[] = [];
  i: number[] = [];
  private st!: Stations;
  private deck!: Float32Array;
  private L = 0;
  private readonly tmp = new Float64Array(4);
  private readonly cols = new Map<number, [number, number, number]>();
  private readonly col = new THREE.Color();

  constructor(private readonly net: RoadNet) {}

  /** Kante vorbereiten: Fahrbahnhöhe (km, real) je 20 m Stützstelle */
  begin(geo: GeoData, eid: number, clear: number): void {
    const st = (this.st = this.net.stations(eid));
    this.L = st.total;
    const n = Math.max(2, Math.ceil(st.total / 0.02) + 1);
    this.deck = new Float32Array(n);
    const t = this.tmp;
    this.net.pointAt(st, 0, t);
    const yA = Math.max(0, terrainHeightKm(geo, t[0], t[1])) + 0.008;
    this.net.pointAt(st, st.total, t);
    const yB = Math.max(0, terrainHeightKm(geo, t[0], t[1])) + 0.008;
    for (let k = 0; k < n; k++) {
      const u = k / (n - 1);
      this.net.pointAt(st, u * st.total, t);
      const gy = Math.max(0, terrainHeightKm(geo, t[0], t[1])) + 0.004;
      this.deck[k] = Math.max(yA + (yB - yA) * u + clear * Math.sin(Math.PI * u), gy);
    }
  }

  deckY(s: number): number {
    const f = Math.max(0, Math.min(this.deck.length - 1, (s / this.L) * (this.deck.length - 1)));
    const i = Math.min(this.deck.length - 2, Math.floor(f));
    return this.deck[i] + (this.deck[i + 1] - this.deck[i]) * (f - i);
  }

  private rgb(hex: number): [number, number, number] {
    let c = this.cols.get(hex);
    if (!c) {
      this.col.setHex(hex);
      c = [this.col.r, this.col.g, this.col.b];
      this.cols.set(hex, c);
    }
    return c;
  }

  /** Vertex am Stützpunkt s: lat/up/along in Metern */
  v(s: number, lat: number, up: number, along: number, mode: number, hex: number): number {
    s = Math.max(0, Math.min(this.L, s));
    this.net.pointAt(this.st, s, this.tmp);
    const t = this.tmp;
    const n = this.p.length / 3;
    this.p.push(t[0], this.deckY(s), t[1]);
    this.fr.push(t[2], t[3], mode);
    this.lo.push(lat * G, up * G, along * G);
    const c = this.rgb(hex);
    this.c.push(c[0], c[1], c[2]);
    return n;
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.i.push(a, b, c, a, c, d);
  }

  /** Senkrechter Quader am Stützpunkt s (Längs- dA, Quer- dL) von up0 bis up1; Modus je Ende */
  post(s: number, lat: number, up0: number, up1: number, dA: number, dL: number, hex: number, m0 = 0, m1 = 0, hexTop?: number): void {
    const id: number[] = [];
    for (let k = 0; k < 8; k++) {
      const top = (k & 4) !== 0;
      id.push(this.v(s, lat + (k & 1 ? 0.5 : -0.5) * dL, top ? up1 : up0, (k & 2 ? 0.5 : -0.5) * dA, top ? m1 : m0, top && hexTop !== undefined ? hexTop : hex));
    }
    const q = (a: number, b: number, c: number, d: number) => this.quad(id[a], id[b], id[c], id[d]);
    q(0, 1, 3, 2); q(4, 5, 7, 6); q(0, 1, 5, 4); q(2, 3, 7, 6); q(0, 2, 6, 4); q(1, 3, 7, 5);
  }

  /** Achteckiger Pfeiler (Radius r) von oben (Modus 0, up0) bis Gelände (Modus 1) */
  round(s: number, lat: number, upTop: number, r: number, hex: number, topMode = 0, upBottom = -1, botMode = 1): void {
    const n = 8;
    const top: number[] = [], bot: number[] = [];
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + 0.39;
      const rr = r * (k % 2 ? 0.95 : 1);
      top.push(this.v(s, lat + Math.cos(a) * rr * 0.8, upTop, Math.sin(a) * rr, topMode, hex));
      bot.push(this.v(s, lat + Math.cos(a) * rr, upBottom, Math.sin(a) * rr * 1.25, botMode, hex));
    }
    for (let k = 0; k < n; k++) this.quad(top[k], top[(k + 1) % n], bot[(k + 1) % n], bot[k]);
  }

  /** Strebe zwischen zwei Punkten (Quer-/Höhenquerschnitt wl × wu) */
  strut(s0: number, l0: number, u0: number, s1: number, l1: number, u1: number, wl: number, wu: number, hex: number, mode = 0, a0 = 0, a1 = 0): void {
    const id: number[] = [];
    for (let e = 0; e < 2; e++) {
      const s = e ? s1 : s0, l = e ? l1 : l0, u = e ? u1 : u0, al = e ? a1 : a0;
      for (let k = 0; k < 4; k++) id.push(this.v(s, l + (k & 1 ? 0.5 : -0.5) * wl, u + (k & 2 ? 0.5 : -0.5) * wu, al, mode, hex));
    }
    for (let k = 0; k < 4; k++) {
      const k2 = [1, 3, 0, 2][k];
      this.quad(id[k], id[k2], id[4 + k2], id[4 + k]);
    }
  }

  /** Extrusion eines Querschnitts (Flächenliste) entlang s0..s1 */
  extrude(s0: number, s1: number, faces: Face[], step = 0.03, mode = 0): void {
    if (s1 - s0 < 1e-6) return;
    const n = Math.max(1, Math.ceil((s1 - s0) / step));
    for (const f of faces) {
      let pa = -1, pb = -1;
      for (let k = 0; k <= n; k++) {
        const s = s0 + ((s1 - s0) * k) / n;
        const a = this.v(s, f.la, f.ua, 0, mode, f.hex), b = this.v(s, f.lb, f.ub, 0, mode, f.hex);
        if (k > 0) this.quad(pa, pb, b, a);
        pa = a; pb = b;
      }
    }
  }

  /** Abgeknicktes Stück an einer Scharnierstelle sh (dir ±1 = Richtung ins Stück), Länge lh m, Winkel (rad) nach unten */
  hinged(sh: number, dir: number, lh: number, angle: number, roll: number, faces: Face[]): void {
    const n = 4;
    const ca = Math.cos(angle), sa = Math.sin(angle);
    for (const f of faces) {
      let pa = -1, pb = -1;
      for (let k = 0; k <= n; k++) {
        const u = (lh * k) / n;
        const al = dir * u * ca, dn = -u * sa;
        const a = this.v(sh, f.la + roll * u, f.ua + dn, al, 0, f.hex), b = this.v(sh, f.lb + roll * u, f.ub + dn, al, 0, f.hex);
        if (k > 0) this.quad(pa, pb, b, a);
        pa = a; pb = b;
      }
    }
  }

  toGeometry(): THREE.BufferGeometry | null {
    if (this.i.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.p), 3));
    g.setAttribute('aFrame', new THREE.BufferAttribute(new Float32Array(this.fr), 3));
    g.setAttribute('aLoc', new THREE.BufferAttribute(new Float32Array(this.lo), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.c), 3));
    g.setIndex(new THREE.BufferAttribute(this.p.length / 3 > 65535 ? new Uint32Array(this.i) : new Uint16Array(this.i), 1));
    return g;
  }
}

const WIDTH_M: Record<string, number> = { motorway: 26, primary: 12, secondary: 10, road: 8.4, track: 6, rail: 6.6 };

type Variant = 'beam' | 'arch' | 'truss' | 'cable';

function variantOf(e: NavEdge): Variant {
  if (e.cls === 'rail') return 'truss';
  const Lk = e.lengthKm;
  if (Lk < 0.45) return 'beam';
  if (Lk < 0.62) return ihash(e.id, 61, 0) < 0.55 ? 'arch' : 'truss';
  return 'cable';
}

/** Baut eine Brücke in bb. broken: Lücke im mittleren Drittel + Trümmer */
function buildBridge(bb: BB, geo: GeoData, e: NavEdge, broken: boolean): void {
  const eid = e.id;
  const rail = e.cls === 'rail';
  const mw = e.cls === 'motorway';
  const variant = variantOf(e);
  const Lk = e.lengthKm;
  if (Lk <= 0) return;
  const W = WIDTH_M[e.cls] ?? 8;
  const half = W / 2;
  const clear = Math.min(0.02, 0.006 + 0.014 * Lk);
  bb.begin(geo, eid, clear);
  const L = Lk; // Bogenlänge ≈ lengthKm (Stützpunkte summieren sich identisch)
  const Lm = L * 1000;
  const T = rail ? 1.4 : variant === 'beam' ? 1.2 : variant === 'cable' ? 1.1 : 1.0;
  const rnd = (k: number) => ihash(eid, 71, k);
  const g0 = L * (0.28 + rnd(1) * 0.1), g1 = L * (0.62 + rnd(2) * 0.1);
  const ranges: Array<[number, number]> = broken ? [[0, g0], [g1, L]] : [[0, L]];
  const inGap = (s: number) => broken && s > g0 && s < g1;
  const sw = mw ? 0.5 : rail ? 0 : e.cls === 'primary' ? 1.6 : e.cls === 'track' ? 0.4 : 1.3;
  const a = half - sw - (mw ? 0.5 : 0.3); // Fahrbahnrand

  // ---------------------------------------------------------------- Fahrbahnplatte je intaktem Abschnitt
  for (const [s0, s1] of ranges) {
    const faces: Face[] = [
      { la: -half, ua: -T, lb: half, ub: -T, hex: C_CONC_D },
      { la: -half, ua: -T, lb: -half, ub: 0.0, hex: C_CONC },
      { la: half, ua: -T, lb: half, ub: 0.0, hex: C_CONC },
    ];
    if (rail) {
      faces.push({ la: -half, ua: 0.0, lb: half, ub: 0.0, hex: C_CONC_D });
      faces.push({ la: -2.4, ua: 0.0, lb: -2.4, ub: 0.4, hex: C_BALLAST }, { la: 2.4, ua: 0.0, lb: 2.4, ub: 0.4, hex: C_BALLAST });
      faces.push({ la: -2.4, ua: 0.4, lb: 2.4, ub: 0.4, hex: C_BALLAST });
    } else {
      faces.push({ la: -a, ua: 0.0, lb: a, ub: 0.0, hex: C_ASPH });
      if (sw > 0.6 || mw) {
        for (const sd of [-1, 1]) {
          const lA = sd * a, lB = sd * half;
          faces.push({ la: lA, ua: 0.0, lb: lA, ub: 0.22, hex: C_CONC_L });
          faces.push({ la: lA, ua: 0.22, lb: lB, ub: 0.22, hex: C_CONC });
        }
      }
    }
    bb.extrude(s0, s1, faces);

    // Markierungen
    if (!rail) {
      const edgeL = a - 0.45;
      for (const sd of [-1, 1]) bb.extrude(s0, s1, [{ la: sd * edgeL - 0.12, ua: 0.03, lb: sd * edgeL + 0.12, ub: 0.03, hex: C_WHITE }], 0.06);
      if (e.cls !== 'track' && e.cls !== 'road') {
        const dash = e.cls === 'secondary' ? C_YELLOW : C_WHITE;
        const period = mw ? 0.012 : 0.009;
        for (let s = s0 + period * 0.5; s + 0.004 < s1; s += period) {
          if (mw) {
            for (const lat of [-a * 0.5, a * 0.5]) bb.extrude(s, s + 0.004, [{ la: lat - 0.1, ua: 0.03, lb: lat + 0.1, ub: 0.03, hex: C_WHITE }], 0.05);
          } else {
            bb.extrude(s, s + 0.004, [{ la: -0.1, ua: 0.03, lb: 0.1, ub: 0.03, hex: dash }], 0.05);
          }
        }
      }
    } else {
      // Schienen + Schwellen
      for (const lat of [-0.72, 0.72]) bb.extrude(s0, s1, [{ la: lat - 0.09, ua: 0.52, lb: lat + 0.09, ub: 0.52, hex: C_STEEL_L }, { la: lat - 0.09, ua: 0.4, lb: lat - 0.09, ub: 0.52, hex: C_STEEL }, { la: lat + 0.09, ua: 0.4, lb: lat + 0.09, ub: 0.52, hex: C_STEEL }], 0.05);
      for (let s = s0 + 0.001; s + 0.0008 < s1; s += 0.0018) bb.extrude(s, s + 0.0008, [{ la: -1.3, ua: 0.43, lb: 1.3, ub: 0.43, hex: C_SLEEPER }], 0.05);
    }

    // Geländer / Brüstung
    for (const sd of [-1, 1]) {
      const lat = sd * (half - 0.12);
      if (mw) {
        bb.extrude(s0, s1, [
          { la: sd * half, ua: 0, lb: sd * half, ub: 1.0, hex: C_CONC_L },
          { la: sd * half, ua: 1.0, lb: sd * (half - 0.55), ub: 1.0, hex: C_CONC_L },
          { la: sd * (half - 0.55), ua: 1.0, lb: sd * (half - 0.55), ub: 0.22, hex: C_CONC },
        ], 0.04);
      } else {
        bb.extrude(s0, s1, [{ la: lat, ua: 1.15, lb: lat, ub: 0.9, hex: C_STEEL_L }, { la: lat - 0.07, ua: 1.15, lb: lat + 0.07, ub: 1.15, hex: C_STEEL_L }, { la: lat, ua: 0.62, lb: lat, ub: 0.48, hex: C_STEEL }], 0.04);
        const step = 3 / 1000;
        for (let s = s0 + step * 0.5; s < s1; s += step) bb.post(s, lat, rail ? 0.4 : sw > 0.6 ? 0.22 : 0, 1.1, 0.16, 0.16, C_STEEL);
      }
    }

    // Dehnfugen
    for (let s = s0 + 0.0005; s < s1; s += 0.06) bb.extrude(s, s + 0.0006, [{ la: -half, ua: rail ? 0.1 : 0.04, lb: half, ub: rail ? 0.1 : 0.04, hex: C_JOINT }], 0.05);

    // Laternen (kleine Straßen, einfache Balken-/Hängebrücken)
    if (!mw && !rail && (variant === 'beam')) {
      for (let s = s0 + 0.012, k = 0; s < s1 - 0.005; s += 0.03, k++) {
        const sd = k % 2 ? 1 : -1, lat = sd * (half - 0.3);
        bb.post(s, lat, 0.22, 6.2, 0.2, 0.2, C_LAMP);
        bb.strut(s, lat, 6.2, s, lat - sd * 1.4, 6.3, 0.15, 0.15, C_LAMP);
        bb.post(s, lat - sd * 1.5, 6.1, 6.35, 0.8, 0.45, C_GLOW);
      }
    }
  }

  // ---------------------------------------------------------------- Tragwerk
  const sec = (s0: number, s1: number, fn: (a: number, b: number) => void) => {
    for (const [r0, r1] of ranges) {
      const lo = Math.max(r0, s0), hi = Math.min(r1, s1);
      if (hi - lo > 0.0008) fn(lo, hi);
    }
  };
  if (variant === 'truss') {
    const Ht = rail ? 7 : 5.5;
    const pl = (rail ? 9 : 8) / 1000;
    const lat = half - 0.4;
    sec(0.01, L - 0.01, (lo, hi) => {
      const n = Math.max(1, Math.round((hi - lo) / pl));
      const d = (hi - lo) / n;
      for (const sd of [-1, 1]) {
        const l = sd * lat;
        bb.strut(lo, l, Ht, hi, l, Ht, 0.5, 0.6, C_TRUSS_L);   // Obergurt
        bb.strut(lo, l, 0.2, hi, l, 0.2, 0.5, 0.5, C_TRUSS);   // Untergurt
        for (let k = 0; k <= n; k++) {
          const s = lo + k * d;
          bb.strut(s, l, 0.2, s, l, Ht, 0.4, 0.4, C_TRUSS);     // Pfosten
          if (k < n) bb.strut(s, l, k % 2 ? Ht : 0.2, s + d, l, k % 2 ? 0.2 : Ht, 0.3, 0.3, C_TRUSS_L);
        }
      }
      for (let k = 0; k <= n; k += 2) bb.strut(lo + k * d, -lat, Ht, lo + k * d, lat, Ht, 0.3, 0.35, C_TRUSS); // Querverband
    });
  } else if (variant === 'arch') {
    const Ha = Math.min(34, Math.max(14, Lm * 0.1));
    const lat = half - 0.3;
    const sA = 0.03 * L, sB = L - sA;
    const N = 22;
    for (const sd of [-1, 1]) {
      const l = sd * lat;
      let ps = -1, pu = 0;
      for (let k = 0; k <= N; k++) {
        const u = k / N;
        const s = sA + (sB - sA) * u;
        const up = Ha * (1 - Math.pow(2 * u - 1, 2)) + 0.5;
        if (k > 0 && !(inGap(s) || inGap(ps))) bb.strut(ps, l, pu, s, l, up, 1.0, 1.1, C_TRUSS_L);
        // Hänger
        if (k > 0 && k < N && !inGap(s)) bb.strut(s, l, 0.2, s, l, up, 0.22, 0.22, C_CABLE);
        ps = s; pu = up;
      }
    }
    sec(0.02, L - 0.02, (lo, hi) => {
      for (let s = lo + 0.03; s < hi; s += 0.045) bb.strut(s, -lat, 0.3, s, lat, 0.3, 0.3, 0.3, C_CONC_D);
    });
  } else if (variant === 'cable') {
    const sP = L * 0.5;
    const Hp = Math.min(70, Math.max(34, Lm * 0.09));
    const legL = half + 0.9;
    for (const sd of [-1, 1]) bb.post(sP, sd * legL, -T, Hp, 2.2, 1.8, C_PYLON, 0, 0, C_CONC_L);
    bb.strut(sP, -legL, Hp * 0.62, sP, legL, Hp * 0.62, 1.4, 1.6, C_PYLON);
    bb.strut(sP, -legL, Hp, sP, legL, Hp, 1.5, 1.4, C_PYLON);
    // Seilfächer
    for (let k = 1; k <= 8; k++) {
      const off = 0.016 * k + 0.006;
      const up = Hp - 1.2 * (9 - k) * 0.55;
      for (const dir of [-1, 1]) {
        const s = sP + dir * off;
        if (s < 0.01 || s > L - 0.01 || inGap(s)) continue;
        for (const sd of [-1, 1]) {
          bb.strut(sP, sd * legL, up, s, sd * (half - 0.4), 0.9, 0.18, 0.18, C_CABLE);
        }
      }
    }
  }

  // ---------------------------------------------------------------- Pfeiler / Widerlager
  const abut = (s: number, dir: number) => {
    bb.post(s + dir * 0.0015, 0, -T, 0, 5, W + 1.2, C_CONC_D, 0, 1, C_CONC);
    bb.post(s + dir * 0.0015, 0, -0.8, 0.0, 4.2, W + 0.2, C_CONC, 1, 1);
    // Flügelmauern
    for (const sd of [-1, 1]) bb.post(s + dir * 0.004, sd * (half + 0.4), -T, 0, 7, 0.8, C_CONC_D, 0, 1);
  };
  abut(0.0008, 1);
  abut(L - 0.0008, -1);
  const spanM = variant === 'beam' ? 90 : variant === 'arch' ? Lm / 3 : variant === 'truss' ? 110 : 85;
  const nPier = Math.max(0, Math.round(Lm / spanM) - 1);
  for (let k = 1; k <= nPier; k++) {
    const s = (k / (nPier + 1)) * L;
    const stump = inGap(s);
    if (variant === 'beam' || variant === 'cable' || rail) {
      // eckiger Pfeiler mit Kappe: zwei Stützen
      for (const sd of [-1, 1]) {
        if (stump) bb.post(s, sd * half * 0.55, 3 + rnd(10 + k) * 4, -1, 2.2, 1.8, C_CONC_D, 1, 1);
        else bb.post(s, sd * half * 0.55, -T, -1, 2.2, 1.8, C_CONC_D, 0, 1);
      }
      if (!stump) bb.post(s, 0, -T - 0.9, -T, 3.0, W + 0.4, C_CONC, 0, 0);
    } else if (stump) bb.round(s, 0, 3 + rnd(10 + k) * 4, 2.0, C_CONC_D, 1, -1, 1);
    else bb.round(s, 0, -T, 2.2, C_CONC_D);
  }
  if (variant === 'cable') {
    const sP = L * 0.5;
    for (const sd of [-1, 1]) bb.post(sP, sd * (half + 0.9), -T - 0.1, -1, 3.2, 2.6, C_CONC, 0, 1);
  }

  if (!broken) return;

  // ---------------------------------------------------------------- Zerstörungsdetails
  const R = (k: number) => rnd(100 + k);
  for (const [sh, dir] of [[g0, 1], [g1, -1]] as Array<[number, number]>) {
    const lh = Math.min(26, 10 + R(Math.floor(sh * 1000) & 31) * 16);
    const ang = 0.5 + R(sh > g0 ? 3 : 4) * 0.55;
    const roll = (R(sh > g0 ? 5 : 6) - 0.5) * 0.12;
    const faces: Face[] = [
      { la: -half, ua: -T, lb: half, ub: -T, hex: C_BROKEN },
      { la: -half, ua: -T, lb: -half, ub: 0, hex: C_BROKEN },
      { la: half, ua: -T, lb: half, ub: 0, hex: C_BROKEN },
      { la: -half, ua: 0, lb: half, ub: 0, hex: rail ? C_BALLAST : C_ASPH },
    ];
    // Hängendes Fahrbahnstück: von der Bruchkante (nach innen verschoben) in die Lücke
    bb.hinged(sh, dir, lh, ang, roll, faces);
    // Verbogene Geländer: vom Rand der Bruchkante verdreht ins Leere
    for (const sd of [-1, 1]) {
      const l = sd * (half - 0.12);
      bb.hinged(sh, dir, lh * (0.6 + R(7 + sd) * 0.5), ang + 0.5 + R(9) * 0.5, sd * 0.1 + (R(11) - 0.5) * 0.25, [{ la: l, ua: 1.15, lb: l, ub: 0.9, hex: C_RUST }, { la: l - 0.07, ua: 1.15, lb: l + 0.07, ub: 1.15, hex: C_RUST }]);
    }
    // Freiliegende Bewehrung
    for (let k = 0; k < 9; k++) {
      const lat = (R(20 + k) - 0.5) * (W - 1), up = -T * (0.15 + R(30 + k) * 0.7);
      const len = 1.6 + R(40 + k) * 2.6;
      bb.strut(sh, lat, up, sh, lat + (R(50 + k) - 0.5) * 0.6, up - R(60 + k) * 0.9, 0.09, 0.09, C_RUST, 0, 0, dir * len);
    }
  }
  // Trümmer in der Lücke / am Boden
  const cnt = 16 + Math.floor(R(1) * 8);
  for (let k = 0; k < cnt; k++) {
    const s = g0 + (g1 - g0) * R(70 + k);
    const lat = (R(90 + k) - 0.5) * W * 1.6;
    const sz = 1.2 + R(110 + k) * 3.4;
    bb.post(s, lat, -0.5, sz * (0.5 + R(130 + k) * 0.5), sz * (0.8 + R(150 + k) * 0.8), sz, C_RUBBLE[k % C_RUBBLE.length], 1, 1);
  }
}

// ======================================================================= Renderer

interface Chunk {
  key: number;
  edges: number[];
  mesh: THREE.Mesh | null;
  dirty: boolean;
  lastUsed: number;
}

const _cam = new THREE.Vector3();
const _dir = new THREE.Vector3();

export class BridgeRenderer {
  readonly object = new THREE.Group();
  private readonly geo: GeoData;
  private readonly graph: NavGraph;
  private readonly net: RoadNet;
  private readonly shared: Record<string, THREE.IUniform>;
  private readonly mat: THREE.MeshLambertMaterial;
  private exag: number;
  private show = true;
  private readonly chunks = new Map<number, Chunk>();
  private readonly chunkOfEdge = new Map<number, number>();
  private frame = 0;
  private readonly candidates: Chunk[] = [];

  constructor(geo: GeoData, graph: NavGraph, settings: Settings) {
    this.geo = geo;
    this.graph = graph;
    this.net = getRoadNet(geo, graph);
    this.exag = settings.heightExaggeration;
    this.shared = getRoadUniforms(geo);
    this.shared.uExag.value = this.exag;
    this.mat = makeMaterial(this.shared);
    this.object.name = 'Bridges';
    for (const e of graph.edges) {
      if (!e.bridge || e.cls === 'ferry') continue;
      const g = e.geom;
      const key = this.keyOf(g[(g.length / 2) & ~1] ?? g[0], g[((g.length / 2) & ~1) + 1] ?? g[1]);
      let c = this.chunks.get(key);
      if (!c) this.chunks.set(key, (c = { key, edges: [], mesh: null, dirty: true, lastUsed: 0 }));
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
    this.shared.uExag.value = this.exag;
    this.object.visible = s.showRoads;
    this.show = s.showRoads;
  }

  update(camera: THREE.PerspectiveCamera): void {
    if (!this.show) return;
    this.frame++;
    camera.updateMatrixWorld();
    _cam.setFromMatrixPosition(camera.matrixWorld);
    camera.getWorldDirection(_dir);
    let tx = _cam.x, tz = _cam.z, ty = 0;
    if (_dir.y < -0.05) {
      for (let k = 0; k < 3; k++) {
        const t = (_cam.y - ty) / -_dir.y;
        tx = _cam.x + _dir.x * t;
        tz = _cam.z + _dir.z * t;
        ty = Math.max(0, terrainHeightKm(this.geo, tx, tz)) * this.exag;
      }
    } else ty = Math.max(0, terrainHeightKm(this.geo, tx, tz)) * this.exag;
    const dist = Math.max(1, Math.hypot(_cam.x - tx, _cam.y - ty, _cam.z - tz));
    const vis = dist < Q.bridgeDist;
    this.object.visible = vis;
    if (!vis) return;
    const R = Math.min(120, Math.max(14, dist * 1.5));
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
        if (!c.mesh || c.dirty) this.candidates.push(c);
      }
    if (this.candidates.length > 0) {
      this.candidates.sort((a, c) => this.chunkDist(a, tx, tz) - this.chunkDist(c, tx, tz));
      let built = 0;
      for (const c of this.candidates) {
        if (built >= REBUILDS_PER_FRAME) break;
        this.build(c);
        built++;
      }
    }
    let count = 0;
    for (const c of this.chunks.values()) {
      if (c.mesh) { c.mesh.visible = visible.has(c.key); count++; }
    }
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
      c.mesh.geometry.dispose();
      c.mesh = null;
    }
  }

  private build(c: Chunk): void {
    const bb = new BB(this.net);
    for (const eid of c.edges) {
      const e = this.graph.edges[eid];
      buildBridge(bb, this.geo, e, !e.open);
    }
    this.release(c);
    const g = bb.toGeometry();
    c.dirty = false;
    if (!g) return;
    const mesh = new THREE.Mesh(g, this.mat);
    mesh.name = `Bridges-${c.key}`;
    mesh.frustumCulled = false;
    mesh.renderOrder = 4;
    this.object.add(mesh);
    c.mesh = mesh;
  }
}
