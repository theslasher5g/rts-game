/**
 * Phase 5 – Darstellung von Ölfeldern, Raffinerien, HQs und Produktionsbasen.
 *
 * Detailmodelle (Low-Poly, flach schattiert, Vertexfarben) in Metern, strategischer Sichtmaßstab wie StructureManager/
 * UnitRenderer (Querschnitt wächst mit dem Kameraabstand, begrenzt), ab ~100 km Kameraabstand Marker (Symbole in
 * Teamfarbe, ein Points-Objekt je Symbol). Der Maßstab wird per onBeforeRender eines unsichtbaren Sentinel-Meshes
 * mit der echten Kamera berechnet – kein Verdrahten nötig. Animationen (Pumpenkopf, Fackeln) über animate(realDt).
 * PointsMaterial/Lambert nutzen die eingebauten Shader (logarithmischer Tiefenpuffer ist damit abgedeckt).
 */
import * as THREE from 'three';
import type { BaseKind } from './types';
import type { GeoData } from '../world/GeoData';
import { nationColor } from './prices';

export type SiteKind = 'rig' | BaseKind;

export interface SiteState {
  kind: SiteKind;
  x: number;
  z: number;
  owner: string;
  /** 0..1 Baufortschritt (1 = fertig) */
  progress: number;
  /** 0..1 Füllstand der Lager-Anzeige */
  fill: number;
  /** arbeitet (Pumpe nickt, Fackel brennt klein) */
  active: boolean;
  /** brennt (Beschädigung) */
  burning: boolean;
  /** 0..1 Zustand (Marker dunkelt ab) */
  health: number;
}

// ------------------------------------------------------------------ Geometrie-Baukasten

class GB {
  readonly pos: number[] = [];
  readonly col: number[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly t = new THREE.Matrix4();
  private readonly r = new THREE.Matrix4();
  private readonly e = new THREE.Euler();
  private readonly c = new THREE.Color();

  private push(g: THREE.BufferGeometry, color: number, x: number, y: number, z: number, rx: number, ry: number, rz: number, cy: number): void {
    const n = g.index ? g.toNonIndexed() : g;
    this.e.set(rx, ry, rz, 'YXZ');
    this.r.makeRotationFromEuler(this.e);
    this.t.makeTranslation(0, cy, 0);
    this.m.makeTranslation(x, y, z).multiply(this.r).multiply(this.t);
    n.applyMatrix4(this.m);
    const p = n.attributes.position.array as ArrayLike<number>;
    this.c.setHex(color);
    for (let i = 0; i < p.length; i += 3) {
      this.pos.push(p[i], p[i + 1], p[i + 2]);
      const k = 0.92 + 0.16 * (((i / 3) * 2654435761) % 7) / 7; // leichte Körnung
      this.col.push(Math.min(1, this.c.r * k * 1.45), Math.min(1, this.c.g * k * 1.45), Math.min(1, this.c.b * k * 1.45));
    }
    if (n !== g) n.dispose();
    g.dispose();
  }

  /** Quader, y = Unterkante */
  box(w: number, h: number, d: number, x: number, y: number, z: number, color: number, ry = 0, rz = 0, rx = 0): this {
    this.push(new THREE.BoxGeometry(w, h, d), color, x, y, z, rx, ry, rz, h / 2);
    return this;
  }
  /** Zylinder/Kegel (senkrecht), y = Unterkante; rz/rx kippen um die Mitte */
  cyl(rBot: number, h: number, x: number, y: number, z: number, color: number, seg = 8, rTop = rBot, rz = 0, rx = 0): this {
    this.push(new THREE.CylinderGeometry(rTop, rBot, h, seg, 1), color, x, y, z, rx, 0, rz, h / 2);
    return this;
  }
  /** Dreiecksprisma (Zelt/Satteldach) entlang z: Breite w, Höhe h, Länge len */
  tent(w: number, h: number, len: number, x: number, y: number, z: number, color: number, ry = 0): this {
    const g = new THREE.BufferGeometry();
    const a = w / 2, l = len / 2;
    const v = [
      -a, 0, -l, a, 0, -l, 0, h, -l,
      -a, 0, l, 0, h, l, a, 0, l,
      -a, 0, -l, 0, h, -l, 0, h, l, -a, 0, -l, 0, h, l, -a, 0, l,
      a, 0, -l, a, 0, l, 0, h, l, a, 0, -l, 0, h, l, 0, h, -l,
    ];
    g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    this.push(g, color, x, y, z, 0, ry, 0, 0);
    return this;
  }
  /** Umzäunung (Wandstücke + Pfosten) */
  fence(w: number, d: number, color = 0x55554a, h = 2.4): this {
    this.box(w, h, 0.3, 0, 0, -d / 2, color).box(w, h, 0.3, 0, 0, d / 2, color);
    this.box(0.3, h, d, -w / 2, 0, 0, color).box(0.3, h, d, w / 2, 0, 0, color);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) this.box(0.9, h + 0.8, 0.9, (sx * w) / 2, 0, (sz * d) / 2, 0x3a3a32);
    return this;
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    return g;
  }
}

interface Model {
  body: THREE.BufferGeometry;
  team: THREE.BufferGeometry;
  /** Pumpenkopf (Pivot-Position in m) */
  beam?: { geom: THREE.BufferGeometry; pivot: [number, number, number] };
  /** Fackelspitze */
  flame?: [number, number, number];
  /** Füllstandsbalken: Position (Unterkante), Breite/Tiefe, max. Höhe */
  gauge?: { x: number; y: number; z: number; w: number; h: number };
  /** Gerüst (Baustelle) */
  scaffold: THREE.BufferGeometry;
  /** Footprint-Radius in m */
  radiusM: number;
}

const PAD = 0x6e6d62, STEEL = 0x8c8e90, DARKSTEEL = 0x4a4c4e, RUST = 0x8a4a2a, TANK = 0xbab6a8, OLIVE = 0x5a6a46, ROOF = 0x6a5a4a;
const BLUEGREY = 0x3a5a7a, SAND = 0xb8aa86;

function scaffold(r: number, h = 16): THREE.BufferGeometry {
  const b = new GB();
  const a = r * 0.75;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box(0.7, h, 0.7, sx * a, 0, sz * a, 0xc8a060);
  for (const y of [h * 0.4, h * 0.8]) {
    b.box(a * 2, 0.4, 0.4, 0, y, -a, 0xc8a060).box(a * 2, 0.4, 0.4, 0, y, a, 0xc8a060);
    b.box(0.4, 0.4, a * 2, -a, y, 0, 0xc8a060).box(0.4, 0.4, a * 2, a, y, 0, 0xc8a060);
  }
  b.box(a * 2, 0.35, 0.35, 0, 0.5, 0, 0xd8b070, 0.78).box(a * 2, 0.35, 0.35, 0, 0.5, 0, 0xd8b070, -0.78);
  return b.build();
}

function flagpole(b: GB, t: GB, x: number, z: number, h: number, fw = 6, fh = 3.2): void {
  b.cyl(0.25, h, x, 0, z, 0xdddddd, 5, 0.15);
  t.box(0.15, fh, fw, x, h - fh - 0.4, z + fw / 2 + 0.2, 0xffffff);
}

function buildRig(): Model {
  const b = new GB(), t = new GB();
  b.box(26, 25.6, 20, 0, -25, 0, PAD);
  b.box(3.4, 2.8, 3.2, -10, 0.5, 6, 0x8a8478).tent(3.8, 1.2, 3.6, -10, 3.3, 6, ROOF, Math.PI / 2);
  // Samson-Pfosten (A-Bock)
  for (const s of [-1, 1]) b.box(0.7, 11, 0.7, 0, 0.5, s * 1.5, BLUEGREY, 0, 0, -s * 0.14);
  b.box(1.4, 0.8, 4, 0, 10.8, 0, BLUEGREY);
  // Getriebe/Motor + Kurbel
  b.box(3.6, 2.2, 2.8, -9, 0.5, 0, BLUEGREY).cyl(1.4, 0.5, -9, 1.4, 1.7, DARKSTEEL, 8, 1.4, 0, Math.PI / 2);
  // Bohrlochkopf (Weihnachtsbaum) + Flowline
  b.cyl(0.6, 3.6, 7.5, 0.5, 0, RUST, 8, 0.45).cyl(1, 0.5, 7.5, 1.4, 0, DARKSTEEL, 8).cyl(0.9, 0.35, 7.5, 2.6, 0, DARKSTEEL, 8);
  b.box(14, 0.4, 0.4, 5, 0.9, 5, 0x6a4a2a).box(0.4, 0.4, 5, 12, 0.9, 2.5, 0x6a4a2a);
  b.cyl(0.12, 9.5, 7.2, 1.2, 0, 0xc0c0c0, 5);
  // Tanks
  b.cyl(4, 7, 4, 0.5, -8, TANK, 10, 3.9).cyl(3.9, 0.7, 4, 7.5, -8, DARKSTEEL, 10, 1.5);
  b.cyl(4, 7, 12.5, 0.5, -8, TANK, 10, 3.9).cyl(3.9, 0.7, 12.5, 7.5, -8, DARKSTEEL, 10, 1.5);
  t.cyl(4.05, 0.7, 4, 6.4, -8, 0xffffff, 10).cyl(4.05, 0.7, 12.5, 6.4, -8, 0xffffff, 10);
  // Fackelstock
  b.cyl(0.45, 17, -11.5, 0.5, -8, 0x55554f, 6, 0.3).box(1.6, 0.5, 1.6, -11.5, 0.5, -8, DARKSTEEL);
  flagpole(b, t, 11, 7, 9, 3.6, 2);
  const beamB = new GB();
  beamB.box(14, 0.9, 0.7, 0, -0.45, 0, BLUEGREY).box(1.1, 2.8, 0.7, 7.3, -3.0, 0, BLUEGREY, 0, 0.35).box(2.6, 1.9, 1.2, -6.3, -2.2, 0, DARKSTEEL);
  beamB.box(0.2, 8.6, 0.2, 7.7, -9.5, 0, 0xc0c0c0);
  return {
    body: b.build(), team: t.build(), beam: { geom: beamB.build(), pivot: [0, 11.4, 0] }, flame: [-11.5, 17.2, -8],
    gauge: { x: 4, y: 0.5, z: -13.2, w: 1.1, h: 7 }, scaffold: scaffold(14, 9), radiusM: 16,
  };
}

function buildRefinery(): Model {
  const b = new GB(), t = new GB();
  b.box(230, 25.6, 180, 0, -25, 0, PAD);
  // Kolonnen (Destillationstürme)
  const hs = [58, 46, 38];
  hs.forEach((h, i) => {
    const x = -78 + i * 17;
    b.cyl(5.2, h, x, 0.6, -45, 0xaaa89c, 10, 4.6);
    for (let k = 1; k < 4; k++) b.cyl(5.5, 0.9, x, 0.6 + (h * k) / 4.2, -45, 0x6a6a62, 10);
    b.cyl(4.6, 3, x, 0.6 + h, -45, 0x888880, 10, 0.8);
    b.box(1.4, h * 0.9, 1.4, x + 6, 0.6, -45, DARKSTEEL);
  });
  // Wärmetauscher, Kessel
  b.cyl(3, 16, -40, 3.5, -22, 0x9a9a92, 8, 3, 0, Math.PI / 2 * 0).cyl(3, 16, -40, 3.5, -22, 0x9a9a92, 8, 3, Math.PI / 2);
  b.cyl(3.4, 22, -40, 3.5, -10, 0x9a9a92, 8, 3.4, Math.PI / 2).cyl(3, 18, -40, 3.5, 2, 0xa0a098, 8, 3, Math.PI / 2);
  // Tanklager 3 x 2
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 2; j++) {
      const x = 30 + i * 36, z = -48 + j * 40;
      b.cyl(15, 13, x, 0.6, z, TANK, 14, 14.8);
      b.cyl(15.1, 0.8, x, 13.6, z, 0x6a6a62, 14, 15.1);
      t.cyl(15.2, 0.7, x, 12.8, z, 0xffffff, 14);
      b.cyl(1.5, 3, x + 9, 13.6, z + 5, DARKSTEEL, 6);
    }
  }
  // Rohrbrücke
  b.box(150, 0.8, 1.4, -10, 8.5, 18, 0x7a4a2a).box(150, 0.8, 1.4, -10, 9.8, 18, 0x5a6a7a);
  for (let x = -80; x <= 60; x += 20) b.box(0.8, 8.5, 0.8, x, 0.6, 18, DARKSTEEL);
  // Fackel
  b.cyl(0.9, 80, 100, 0.6, -70, 0x55554f, 6, 0.45).box(5, 0.8, 5, 100, 0.6, -70, DARKSTEEL);
  b.cyl(0.15, 78, 100.8, 0.6, -70, 0x777770, 4, 0.1, 0.0);
  // Kontrollgebäude + Schornstein
  b.box(28, 9, 15, -85, 0.6, 52, 0xb0a58c).box(30, 1, 17, -85, 9.6, 52, ROOF).cyl(2.2, 34, -65, 0.6, 58, 0x9a8a7a, 8, 1.7);
  // Verladegerüst für Tankwagen
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box(0.9, 8, 0.9, 30 + sx * 6, 0.6, 62 + sz * 8, DARKSTEEL);
  b.box(14, 0.9, 1, 30, 8.6, 54, STEEL).box(14, 0.9, 1, 30, 8.6, 70, STEEL).box(1, 0.9, 17, 24, 8.6, 62, STEEL).box(1, 0.9, 17, 36, 8.6, 62, STEEL);
  b.box(0.5, 6, 0.5, 27, 2.6, 62, 0x333330).box(0.5, 6, 0.5, 33, 2.6, 62, 0x333330);
  // Pumpenhaus, Lager
  b.box(18, 6, 12, 85, 0.6, 62, 0x9a9a90).box(14, 7, 10, -20, 0.6, 62, 0x8a8a80);
  b.fence(230, 180, 0x55554a, 3);
  flagpole(b, t, -100, 72, 30, 8, 4.5);
  return {
    body: b.build(), team: t.build(), flame: [100, 80.5, -70],
    gauge: { x: 112, y: 0.6, z: 70, w: 3.2, h: 24 }, scaffold: scaffold(90, 22), radiusM: 115,
  };
}

function buildHq(): Model {
  const b = new GB(), t = new GB();
  b.box(150, 25.6, 120, 0, -25, 0, 0x7c7b6c);
  b.box(46, 14, 24, 0, 0.6, -14, 0xbdb59a).box(49, 1.6, 27, 0, 14.6, -14, ROOF);
  for (let i = -2; i <= 2; i++) b.cyl(0.9, 9, i * 6, 0.6, 0.5, 0xe0dccb, 8);
  b.box(36, 1, 6, 0, 9.6, 0.5, 0xd0ccb8);
  for (const s of [-1, 1]) b.box(26, 9, 16, s * 40, 0.6, -10, 0xaea68c).box(28, 1.2, 18, s * 40, 9.6, -10, ROOF);
  // Funkmast + Schüssel
  b.cyl(0.9, 52, 62, 0.6, -38, 0x77776f, 6, 0.4).cyl(4, 0.6, 62, 38, -38, 0xdcdcd0, 12, 4, Math.PI / 2.4);
  b.box(8, 3, 8, 62, 0.6, -38, 0x8a8a80);
  // Mannschaftszelte, Garage, Fahrzeuge
  for (let i = 0; i < 3; i++) b.tent(8, 4.5, 14, -55 + i * 12, 0.6, 30, 0x6a7550, 0);
  b.box(32, 6.5, 14, 30, 0.6, 40, 0x8a8a7c).box(34, 0.8, 16, 30, 7.1, 40, ROOF);
  for (let i = 0; i < 3; i++) b.box(4.2, 2.6, 8.5, 20 + i * 10, 0.6, 52, OLIVE).box(3.4, 1.2, 3, 20 + i * 10, 3.2, 49.5, 0x3a4a3a);
  // Hubschrauberlandeplatz
  b.cyl(12, 0.5, -45, 0.6, 38, 0x555550, 18).box(1.6, 0.1, 9, -45 - 3, 1.12, 38, 0xe8e8e0).box(1.6, 0.1, 9, -45 + 3, 1.12, 38, 0xe8e8e0).box(6, 0.1, 1.4, -45, 1.12, 38, 0xe8e8e0);
  // Sandsack-Ringe an den Ecken
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.cyl(3.5, 1.6, sx * 68, 0.6, sz * 54, SAND, 8, 3.2);
  b.fence(150, 120, 0x55554a, 2.6);
  flagpole(b, t, 0, 24, 36, 11, 6.4);
  b.cyl(0.3, 3.6, 0, 0.6, 24, 0x666660, 6);
  return { body: b.build(), team: t.build(), gauge: { x: 66, y: 0.6, z: 20, w: 2, h: 14 }, scaffold: scaffold(60, 16), radiusM: 80 };
}

function buildBarracks(): Model {
  const b = new GB(), t = new GB();
  b.box(92, 25.6, 72, 0, -25, 0, 0x7d7a68);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) {
    b.tent(8.5, 5, 15, -24 + i * 14, 0.5, -16 + j * 22, j ? 0x6a7550 : 0x76805a, 0);
    t.box(0.2, 0.5, 15, -24 + i * 14, 5.2, -16 + j * 22, 0xffffff);
  }
  b.box(18, 5, 10, 28, 0.5, -10, 0xaea68c).tent(11, 3.2, 20, 28, 5.5, -10, ROOF, Math.PI / 2);
  b.box(10, 4, 8, 28, 0.5, 14, 0x8a8a7c).tent(8, 2.4, 11, 28, 4.5, 14, ROOF, Math.PI / 2);
  // Wachturm
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box(0.5, 9, 0.5, -38 + sx * 1.6, 0.5, 24 + sz * 1.6, 0x6a5a40);
  b.box(5.2, 2.6, 5.2, -38, 9.5, 24, 0x7a6a50).tent(6.6, 2, 6.6, -38, 12.1, 24, ROOF, 0);
  // Exerzier-Rechtecke / Hindernisbahn
  b.box(26, 0.1, 6, -8, 0.5, 26, 0x5a4a38).box(1, 1.2, 6, -16, 0.5, 26, 0x6a5a40).box(1, 1.2, 6, -8, 0.5, 26, 0x6a5a40).box(1, 1.2, 6, 0, 0.5, 26, 0x6a5a40);
  b.fence(92, 72, 0x55554a, 2.2);
  flagpole(b, t, 36, 28, 16, 5, 2.8);
  return { body: b.build(), team: t.build(), flame: [28, 8.8, -10], scaffold: scaffold(40, 10), radiusM: 50 };
}

function buildFactory(): Model {
  const b = new GB(), t = new GB();
  b.box(120, 25.6, 96, 0, -25, 0, PAD);
  // Hallen mit Sheddach
  b.box(56, 13, 30, -24, 0.5, -26, 0x8f9298).box(48, 13, 28, -28, 0.5, 14, 0x8a8c90);
  for (let i = 0; i < 4; i++) b.tent(14, 5, 30, -44 + i * 14, 13.5, -26, 0x6a707a, 0);
  for (let i = 0; i < 3; i++) b.tent(16, 4.5, 28, -44 + i * 16, 13.5, 14, 0x6a707a, 0);
  for (let i = 0; i < 4; i++) b.box(6, 7, 0.6, -44 + i * 13, 0.5, -10.7, 0x3a3e44);
  // Schornstein + Dampfkessel
  b.cyl(2.6, 52, 42, 0.5, -34, 0x9a8a7a, 10, 1.8).cyl(2.9, 1.4, 42, 48, -34, 0x7a3a2a, 10, 2.9).cyl(5, 12, 36, 0.5, -10, 0xa0a098, 10, 5);
  // Portalkran
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box(1.2, 20, 1.2, 36 + sx * 12, 0.5, 26 + sz * 9, 0xd8a020);
  b.box(28, 1.8, 2, 36, 20.5, 17, 0xd8a020).box(28, 1.8, 2, 36, 20.5, 35, 0xd8a020).box(2, 1.5, 20, 24, 20.5, 26, 0xd8a020).box(2, 1.5, 20, 48, 20.5, 26, 0xd8a020);
  b.box(3, 2.2, 3, 36, 18.2, 26, 0x444440).box(0.2, 8, 0.2, 36, 10.2, 26, 0x222220);
  // Container, Kisten, Fahrzeuge im Hof
  const cc = [0x8a3a2a, 0x2a5a7a, 0x6a7a3a, 0xb08a30];
  for (let i = 0; i < 4; i++) b.box(6, 2.6, 2.5, 8 + i * 6.4, 0.5, -30, cc[i]).box(6, 2.6, 2.5, 8 + i * 6.4, 3.1, -30, cc[(i + 2) % 4]);
  b.box(5, 3, 4, 14, 0.5, 6, 0x8a7a55).box(4, 2.4, 4, 21, 0.5, 6, 0x6a6a50);
  b.box(4.2, 2.6, 8.5, 36, 0.5, 26, OLIVE);
  b.fence(120, 96, 0x55554a, 2.4);
  flagpole(b, t, 52, -42, 18, 5, 2.8);
  t.box(30, 0.5, 0.3, -24, 11.6, -41.1, 0xffffff);
  return { body: b.build(), team: t.build(), flame: [42, 52, -34], scaffold: scaffold(52, 16), radiusM: 70 };
}

function buildAirfield(): Model {
  const b = new GB(), t = new GB();
  b.box(320, 25.6, 20, 0, -25, 0, 0x34342f);
  for (let i = -14; i <= 14; i++) b.box(7, 0.1, 0.9, i * 10.5, 0.3, 0, 0xe4e4dc);
  for (const sx of [-1, 1]) b.box(0.9, 0.1, 18, sx * 156, 0.3, 0, 0xe4e4dc);
  b.box(260, 0.3, 8, 0, 0, 24, 0x3c3c37).box(90, 0.3, 40, -45, 0, 46, 0x464640);
  // Hangar mit Tonnendach
  b.box(44, 5, 24, -70, 0.3, 66, 0x7a7e82).cyl(11, 44, -70, 5.3, 66, 0x9a9ea2, 8, 11, Math.PI / 2);
  b.box(0.6, 8, 14, -92.3, 0.3, 66, 0x2e3236);
  // Tower
  b.cyl(3, 17, -10, 0.3, 50, 0xc8c4b4, 8, 2.6).cyl(5.4, 3.2, -10, 17.3, 50, 0x4a6a80, 8, 6.6).box(14, 0.7, 14, -10, 20.5, 50, 0x6a6a60, 0.78).cyl(0.2, 6, -10, 21.2, 50, 0xcc3030, 4);
  // Windsack
  b.cyl(0.25, 9, 120, 0.3, 26, 0xdddddd, 4, 0.15).cyl(1.6, 5, 124, 8.4, 26, 0xe86a1a, 8, 0.7, Math.PI / 2);
  // Flugzeuge auf dem Vorfeld
  for (let i = 0; i < 2; i++) {
    const x = -62 + i * 30;
    b.cyl(1.4, 15, x, 1.8, 40, 0x9aa0a8, 8, 0.5, Math.PI / 2).box(2.5, 0.35, 15, x + 1, 1.8, 40, 0x7a8088, 0.5).box(0.4, 3.4, 2.4, x + 7, 1.8, 40, 0x7a8088).box(3, 0.3, 5, x + 7, 2.2, 40, 0x7a8088);
    t.box(0.2, 0.3, 2, x - 2, 3.1, 40, 0xffffff);
  }
  // Treibstofftank, Feuerwehr
  b.cyl(3.2, 11, 30, 0.3, 66, 0xb0ada0, 10).box(3, 3, 8, 50, 0.3, 66, 0xaa2a20);
  flagpole(b, t, -35, 66, 14, 5, 2.8);
  return { body: b.build(), team: t.build(), scaffold: scaffold(90, 12), radiusM: 170 };
}

function buildShipyard(): Model {
  const b = new GB(), t = new GB();
  b.box(168, 25.6, 108, 0, -25, 0, PAD);
  b.box(170, 3.4, 14, 0, 0, -44, 0x77776e); // Kai
  b.box(80, 1.6, 26, 10, 0.5, -16, 0x6a6a60); // Helling
  // Rumpf im Bau (Rippen + Beplankung)
  b.box(62, 7, 13, 10, 2.1, -16, 0x5a626a).box(14, 7, 10, 47, 2.1, -16, 0x5a626a, 0, 0.0).tent(11, 7, 14, 47, 2.1, -16, 0x4a525a, Math.PI / 2);
  b.box(20, 6, 8, 18, 9.1, -16, 0x8a8e92).box(8, 5, 6, 14, 15, -16, 0x9a9ea2).cyl(0.4, 8, 20, 15, -16, 0x777770, 5, 0.2);
  for (let i = 0; i < 8; i++) b.box(0.4, 10, 0.4, -18 + i * 9, 0.5, -26, 0xc8a060).box(0.4, 10, 0.4, -18 + i * 9, 0.5, -6, 0xc8a060);
  // Portalkräne
  for (const cx of [-40, 60]) {
    for (const sz of [-1, 1]) b.box(1.4, 30, 1.4, cx, 0.5, -16 + sz * 16, 0xd8a020);
    b.box(1.8, 1.8, 36, cx, 30.5, -16, 0xd8a020).box(14, 1.4, 1.4, cx, 33, -16, 0xd8a020).box(3, 2, 3, cx, 28.4, -16, 0x444440);
  }
  b.box(44, 12, 26, -50, 0.5, 26, 0x8a8c90).tent(46, 5, 28, -50, 12.5, 26, 0x6a707a, Math.PI / 2);
  b.box(30, 8, 20, 22, 0.5, 30, 0x9a9a8c).box(10, 2.6, 2.5, 52, 0.5, 30, 0x8a3a2a).box(10, 2.6, 2.5, 52, 3.1, 30, 0x2a5a7a);
  b.fence(168, 108, 0x55554a, 2.2);
  flagpole(b, t, -78, 40, 18, 5, 2.8);
  t.box(0.3, 1.8, 62, 10, 9, -16, 0xffffff);
  return { body: b.build(), team: t.build(), scaffold: scaffold(70, 16), radiusM: 90 };
}

function buildDepot(fuel: boolean): Model {
  const b = new GB(), t = new GB();
  b.box(72, 25.6, 60, 0, -25, 0, 0x78766a);
  if (!fuel) {
    const cc = [0x8a7a55, 0x6a6a50, 0x4a5a3a, 0x7a6a45];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) b.box(7, 3.2, 5, -22 + i * 9, 0.4, -14 + j * 7, cc[(i + j) % 4]).box(6, 2.6, 4.4, -22 + i * 9, 3.6, -14 + j * 7, cc[(i + j + 1) % 4]);
    b.cyl(5, 7.5, 18, 0.4, -14, TANK, 10, 4.9).cyl(5, 7.5, 18, 0.4, 0, TANK, 10, 4.9);
    t.cyl(5.05, 0.7, 18, 6.4, -14, 0xffffff, 10).cyl(5.05, 0.7, 18, 6.4, 0, 0xffffff, 10);
    b.box(16, 5, 10, -20, 0.4, 16, 0x8a8a7c).tent(11, 3, 17, -20, 5.4, 16, ROOF, Math.PI / 2);
    for (let i = 0; i < 2; i++) b.box(3.8, 2.4, 7.5, 12 + i * 8, 0.4, 18, OLIVE);
  } else {
    b.box(54, 0.8, 40, 0, 0.4, -6, 0x8a897c).box(52, 1, 38, 0, 0.8, -6, 0x66665c); // Auffangwanne
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
      b.cyl(3.6, 17, -12 + i * 24, 5, -16 + j * 18, TANK, 10, 3.6, Math.PI / 2);
      t.box(0.3, 0.6, 0.9, -12 + i * 24, 8.8, -16 + j * 18, 0xffffff).cyl(3.7, 1.4, -12 + i * 24, 5, -16 + j * 18, 0xffffff, 10, 3.7, Math.PI / 2);
    }
    b.box(9, 5, 7, -24, 0.4, 18, 0x9a9a90).box(1, 6, 1, 14, 0.4, 20, DARKSTEEL).box(1, 6, 1, 24, 0.4, 20, DARKSTEEL).box(11, 0.8, 1.2, 19, 6.4, 20, STEEL);
  }
  b.fence(72, 60, 0x55554a, 2.2);
  flagpole(b, t, 30, 22, 12, 4, 2.2);
  return {
    body: b.build(), team: t.build(), flame: fuel ? [-12, 9.6, -16] : [18, 8.1, -14],
    gauge: { x: 33, y: 0.4, z: -26, w: 1.8, h: 10 }, scaffold: scaffold(34, 10), radiusM: 45,
  };
}

let MODELS: Partial<Record<SiteKind, Model>> | null = null;
function modelOf(kind: SiteKind): Model {
  if (!MODELS) MODELS = {};
  let m = MODELS[kind];
  if (!m) {
    switch (kind) {
      case 'rig': m = buildRig(); break;
      case 'refinery': m = buildRefinery(); break;
      case 'hq': m = buildHq(); break;
      case 'barracks': m = buildBarracks(); break;
      case 'factory': m = buildFactory(); break;
      case 'airfield': m = buildAirfield(); break;
      case 'shipyard': m = buildShipyard(); break;
      case 'depot': m = buildDepot(false); break;
      default: m = buildDepot(true); break;
    }
    MODELS[kind] = m;
  }
  return m;
}

// ------------------------------------------------------------------ Marker-Symbole

const ICON_KINDS: SiteKind[] = ['rig', 'refinery', 'hq', 'barracks', 'factory', 'airfield', 'shipyard', 'depot', 'fuel_depot'];

function iconTexture(kind: SiteKind): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const S = 64;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  if (!g) return null;
  g.clearRect(0, 0, S, S);
  g.fillStyle = '#ffffff';
  g.beginPath(); g.arc(S / 2, S / 2, 29, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#1a1a14'; g.lineWidth = 4; g.beginPath(); g.arc(S / 2, S / 2, 29, 0, Math.PI * 2); g.stroke();
  g.fillStyle = '#1a1a14'; g.strokeStyle = '#1a1a14'; g.lineWidth = 4; g.lineCap = 'round'; g.lineJoin = 'round';
  const poly = (pts: number[], close = true) => { g.beginPath(); g.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]); if (close) g.closePath(); };
  switch (kind) {
    case 'rig': // Pumpenbock
      poly([20, 46, 32, 22, 44, 46], false); g.stroke(); poly([14, 24, 46, 20], false); g.stroke(); poly([46, 20, 46, 36], false); g.stroke(); break;
    case 'refinery': // Türme
      g.fillRect(17, 24, 8, 24); g.fillRect(28, 14, 8, 34); g.fillRect(39, 28, 8, 20); break;
    case 'hq': // Stern
      for (let i = 0; i < 5; i++) { const a = -Math.PI / 2 + (i * 4 * Math.PI) / 5; const x = 32 + Math.cos(a) * 20, y = 33 + Math.sin(a) * 20; if (i === 0) { g.beginPath(); g.moveTo(x, y); } else g.lineTo(x, y); } g.closePath(); g.fill(); break;
    case 'barracks': poly([14, 46, 32, 18, 50, 46]); g.fill(); break;
    case 'factory': g.fillRect(14, 30, 32, 17); g.fillRect(38, 14, 7, 20); poly([14, 30, 22, 22, 22, 30], true); g.fill(); poly([22, 30, 30, 22, 30, 30], true); g.fill(); break;
    case 'airfield': poly([32, 14, 37, 30, 50, 38, 50, 42, 37, 38, 36, 48, 41, 52, 41, 54, 23, 54, 23, 52, 28, 48, 27, 38, 14, 42, 14, 38, 27, 30]); g.fill(); break;
    case 'shipyard': poly([14, 36, 50, 36, 44, 48, 20, 48]); g.fill(); g.fillRect(30, 18, 4, 18); poly([34, 18, 46, 28, 34, 28]); g.fill(); break;
    case 'depot': g.fillRect(16, 26, 32, 22); g.clearRect(16, 36, 32, 2); g.clearRect(30, 26, 2, 22); poly([14, 26, 32, 14, 50, 26]); g.fill(); break;
    default: // Tanklager: Tropfen
      g.beginPath(); g.moveTo(32, 14); g.bezierCurveTo(48, 32, 46, 48, 32, 48); g.bezierCurveTo(18, 48, 16, 32, 32, 14); g.fill(); break;
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ------------------------------------------------------------------ Layer

interface SiteObj {
  key: string;
  st: SiteState;
  group: THREE.Group;
  body: THREE.Mesh;
  team: THREE.Mesh;
  beam?: THREE.Mesh;
  flame?: THREE.Mesh;
  gauge?: THREE.Mesh;
  scaffold: THREE.Mesh;
  model: Model;
  phase: number;
  gy: number;
}

const MODEL_MAX_DIST = 75;
const MARKER_MIN_DIST = 45;
const SCALE_K = 1.5;
const SCALE_MIN = 2;
const SCALE_MAX = 40;
/** Große Anlagen wachsen weniger stark mit dem Kameraabstand */
const KIND_SCALE: Partial<Record<SiteKind, number>> = { hq: 0.7, factory: 0.7, refinery: 0.55, airfield: 0.5, shipyard: 0.6 };
const _cam = new THREE.Vector3();
const _dir = new THREE.Vector3();

export class SiteLayer {
  readonly object = new THREE.Group();
  private readonly sites = new Map<string, SiteObj>();
  private readonly geo: GeoData;
  private exag: number;
  private readonly bodyMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  private readonly teamMats = new Map<number, THREE.MeshLambertMaterial>();
  private readonly flameMat = new THREE.MeshBasicMaterial({ color: 0xff9a2a, fog: false });
  private readonly gaugeMat = new THREE.MeshBasicMaterial({ color: 0xe3a534, fog: false });
  private readonly markers = new Map<SiteKind, THREE.Points>();
  private markersDirty = true;
  private clock = 0;
  private lastScale = 0;
  camDistKm = 500;

  constructor(geo: GeoData, exag: number, name: string) {
    this.geo = geo;
    this.exag = exag;
    this.object.name = name;
    // Sentinel: wird immer gezeichnet und berechnet den Maßstab mit der echten Kamera
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
    const sm = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
    sm.frustumCulled = false;
    sm.renderOrder = -1e6;
    sm.onBeforeRender = (_r, _s, camera) => this.updateView(camera as THREE.PerspectiveCamera);
    this.object.add(sm);
    for (const k of ICON_KINDS) {
      const map = iconTexture(k);
      const mat = new THREE.PointsMaterial({ size: 30, sizeAttenuation: false, vertexColors: true, map, transparent: true, alphaTest: 0.35, depthTest: false, depthWrite: false, fog: false });
      const p = new THREE.Points(new THREE.BufferGeometry(), mat);
      p.frustumCulled = false;
      p.renderOrder = 7;
      p.visible = false;
      p.name = `SiteMarkers:${k}`;
      this.markers.set(k, p);
      this.object.add(p);
    }
  }

  setExag(e: number): void {
    if (e === this.exag) return;
    this.exag = e;
    for (const s of this.sites.values()) s.gy = this.padY(s.st.x, s.st.z, s.st.kind);
    this.markersDirty = true;
    this.lastScale = 0;
  }

  get count(): number {
    return this.sites.size;
  }

  private groundY(x: number, z: number): number {
    return Math.max(0, this.geo.heightAt(x, z)) * this.exag;
  }

  /** Höchster Geländepunkt im Footprint (Bodenplatte steht auf Hängen nicht im Gelände) */
  private padY(x: number, z: number, kind: SiteKind): number {
    const r = modelOf(kind).radiusM * 0.003;
    let y = this.groundY(x, z);
    for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r]]) y = Math.max(y, this.groundY(x + dx, z + dz));
    return y;
  }

  private teamMat(owner: string): THREE.MeshLambertMaterial {
    const c = nationColor(owner);
    let m = this.teamMats.get(c);
    if (!m) {
      m = new THREE.MeshLambertMaterial({ color: c, flatShading: true, side: THREE.DoubleSide });
      this.teamMats.set(c, m);
    }
    return m;
  }

  upsert(key: string, st: SiteState): void {
    let s = this.sites.get(key);
    if (!s) {
      const model = modelOf(st.kind);
      const group = new THREE.Group();
      const body = new THREE.Mesh(model.body, this.bodyMat);
      const team = new THREE.Mesh(model.team, this.teamMat(st.owner));
      const scaff = new THREE.Mesh(model.scaffold, this.bodyMat);
      group.add(body, team, scaff);
      let beam: THREE.Mesh | undefined, flame: THREE.Mesh | undefined, gauge: THREE.Mesh | undefined;
      if (model.beam) {
        beam = new THREE.Mesh(model.beam.geom, this.bodyMat);
        beam.position.set(...model.beam.pivot);
        group.add(beam);
      }
      if (model.flame) {
        flame = new THREE.Mesh(flameGeo(), this.flameMat);
        flame.position.set(...model.flame);
        group.add(flame);
      }
      if (model.gauge) {
        gauge = new THREE.Mesh(boxGeo(), this.gaugeMat);
        gauge.position.set(model.gauge.x, model.gauge.y, model.gauge.z);
        group.add(gauge);
      }
      for (const o of group.children) o.frustumCulled = false;
      this.object.add(group);
      s = { key, st: { ...st }, group, body, team, beam, flame, gauge, scaffold: scaff, model, phase: Math.random() * 6.28, gy: this.padY(st.x, st.z, st.kind) };
      this.sites.set(key, s);
      this.markersDirty = true;
      this.lastScale = 0;
    } else {
      const old = s.st;
      if (old.owner !== st.owner) s.team.material = this.teamMat(st.owner);
      if (old.x !== st.x || old.z !== st.z) s.gy = this.padY(st.x, st.z, st.kind);
      if (old.owner !== st.owner || old.progress !== st.progress || old.x !== st.x || old.z !== st.z || Math.abs(old.health - st.health) > 0.05) this.markersDirty = true;
      Object.assign(old, st);
      this.lastScale = 0;
    }
    // Zustandsabhängige Teile
    const m = s.model;
    const done = st.progress >= 1;
    s.scaffold.visible = !done;
    s.body.scale.set(1, done ? 1 : Math.max(0.12, st.progress), 1);
    s.team.scale.copy(s.body.scale);
    if (s.gauge && m.gauge) {
      const f = Math.max(0.02, Math.min(1, st.fill));
      s.gauge.scale.set(m.gauge.w, m.gauge.h * f, m.gauge.w);
      s.gauge.visible = done;
    }
  }

  remove(key: string): void {
    const s = this.sites.get(key);
    if (!s) return;
    this.object.remove(s.group);
    this.sites.delete(key);
    this.markersDirty = true;
  }

  /** Animation (Pumpenkopf, Fackeln) */
  animate(realDt: number): void {
    this.clock += realDt;
    const t = this.clock;
    for (const s of this.sites.values()) {
      if (!s.group.visible) continue;
      if (s.beam) s.beam.rotation.z = s.st.active ? Math.sin(t * 1.6 + s.phase) * 0.2 : 0;
      if (s.flame) {
        const on = s.st.burning || (s.st.active && (s.st.kind === 'rig' || s.st.kind === 'refinery'));
        s.flame.visible = on && s.st.progress >= 1;
        if (on) {
          const k = (s.st.burning ? 1.6 : 0.8) * (0.7 + 0.3 * Math.sin(t * 17 + s.phase) + 0.15 * Math.sin(t * 29 + s.phase * 3));
          s.flame.scale.set(k, k * (1.2 + 0.4 * Math.sin(t * 11 + s.phase)), k);
        }
      }
    }
  }

  /** Optional von außen (sonst automatisch per onBeforeRender des Sentinels) */
  updateView(camera: THREE.PerspectiveCamera): void {
    camera.updateMatrixWorld();
    _cam.setFromMatrixPosition(camera.matrixWorld);
    camera.getWorldDirection(_dir);
    const gy = Math.max(0, this.geo.heightAt(_cam.x, _cam.z)) * this.exag;
    const dist = _dir.y < -0.05 ? Math.max(0.3, (_cam.y - gy * 0.5) / -_dir.y) : Math.max(0.3, _cam.y);
    this.camDistKm = dist;
    const showModels = dist <= MODEL_MAX_DIST;
    const showMarkers = dist >= MARKER_MIN_DIST;
    const sc = Math.min(SCALE_MAX, Math.max(SCALE_MIN, SCALE_K * dist));
    const changed = Math.abs(sc / (this.lastScale || 1) - 1) > 0.03 || this.lastScale === 0;
    if (showMarkers && this.markersDirty) this.rebuildMarkers();
    for (const p of this.markers.values()) p.visible = showMarkers && p.geometry.drawRange.count > 0;
    let flipped = false;
    for (const s of this.sites.values()) {
      if (s.group.visible !== showModels) { s.group.visible = showModels; flipped = true; }
    }
    if (showModels && (changed || flipped)) {
      for (const s of this.sites.values()) {
        const ks = sc * (KIND_SCALE[s.st.kind] ?? 1);
        s.group.position.set(s.st.x, s.gy + 0.0004 * ks, s.st.z);
        s.group.scale.setScalar(ks * 0.001);
        s.group.updateMatrix();
        s.group.matrixWorld.copy(s.group.matrix);
        for (const c of s.group.children) c.updateMatrixWorld(true);
      }
    }
    if (changed) this.lastScale = sc;
  }

  private rebuildMarkers(): void {
    this.markersDirty = false;
    const byKind = new Map<SiteKind, SiteObj[]>();
    for (const s of this.sites.values()) {
      const a = byKind.get(s.st.kind === 'rig' ? 'rig' : s.st.kind);
      if (a) a.push(s); else byKind.set(s.st.kind, [s]);
    }
    const c = new THREE.Color(), dim = new THREE.Color(0x303030);
    for (const [kind, pts] of this.markers) {
      const list = byKind.get(kind) ?? [];
      const pos = new Float32Array(Math.max(1, list.length) * 3), col = new Float32Array(Math.max(1, list.length) * 3);
      list.forEach((s, i) => {
        pos[i * 3] = s.st.x; pos[i * 3 + 1] = s.gy + 1.0; pos[i * 3 + 2] = s.st.z;
        c.setHex(nationColor(s.st.owner));
        if (s.st.progress < 1) c.lerp(dim, 0.5);
        else if (s.st.health < 0.4) c.lerp(dim, 0.35);
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.setDrawRange(0, list.length);
      pts.geometry.dispose();
      pts.geometry = g;
    }
  }
}

let _flameGeo: THREE.BufferGeometry | null = null;
function flameGeo(): THREE.BufferGeometry {
  if (!_flameGeo) {
    _flameGeo = new THREE.ConeGeometry(0.9, 3.4, 6);
    _flameGeo.translate(0, 1.7, 0);
  }
  return _flameGeo;
}
let _boxGeo: THREE.BufferGeometry | null = null;
function boxGeo(): THREE.BufferGeometry {
  if (!_boxGeo) {
    _boxGeo = new THREE.BoxGeometry(1, 1, 1);
    _boxGeo.translate(0, 0.5, 0);
  }
  return _boxGeo;
}
