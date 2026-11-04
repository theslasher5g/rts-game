/**
 * Luftfahrzeuge: Kampf-/Transporthubschrauber, Jagdflugzeug, Jagdbomber, Drohnen (hochdetailliert, Draufsicht-tauglich).
 *
 * Animationsgruppen (aPart/aPivot, Anim-Material im UnitRenderer; iAnim.y = Schub, iAnim.z = Fahrwerk bzw. Drehwinkel):
 *   10 Hauptfahrwerk (klappt einwärts) · 11 Bugfahrwerk (klappt nach hinten) · 12 Fahrwerksklappe
 *   13 Nachbrenner-Flamme/Glühring (leuchtet bei hohem Schub) · 14 Blink-/Strobe-Licht · 15 Propeller (dreht)
 *   16 Drehturm (Bugkanone/Sensorkopf, schwenkt zum Ziel) · 18 Positionslicht (dauerhaft leuchtend)
 * Alle Flugzeuge bekommen Panel-Linien als Farbbänder, Tarnflächen (P_CAMO) und Hoheitszeichen (Teamfarbe).
 */
import {
  BLACK, DARK, GLASS, GLASS_LIGHT, HULL, HULL_DARK, HULL_LIGHT, ModelBuilder, P_CAMO, P_FIXED, P_TEAM, RED, STEEL, WHITE, type ModelDef,
} from './geomUtils';

const MISSILE = 0xd8d8d0;
const TIRE = 0x1f1f1b;
const PANEL = 0xd2d2d2;
const fx = { paint: P_FIXED } as const;

/** Einheitsrotor (Radius 1): vier verjüngte Blätter mit Wurzelmanschette, Spitzenfarbe und Trimmklappe + Nabe */
export function buildRotorGeom() {
  const b = new ModelBuilder();
  for (let i = 0; i < 4; i++) {
    b.push(0, 0, 0, [0, (i * Math.PI) / 2, 0]);
    b.box(0.16, 0.05, 0.12, 0.2, 0, 0, 0x2a2a26, { paint: P_FIXED, ao: 0 }); // Wurzelmanschette
    b.box(0.5, 0.03, 0.105, 0.5, 0, 0, 0x1c1c1a, { paint: P_FIXED, ao: 0, top: [1, 0.9] });
    b.box(0.3, 0.03, 0.085, 0.82, 0, 0.0, 0x1c1c1a, { paint: P_FIXED, ao: 0, top: [1, 0.8] });
    b.box(0.2, 0.031, 0.06, 0.96, 0, 0.0, 0xd8b830, { paint: P_FIXED, ao: 0 }); // gelbe Spitze
    b.box(0.3, 0.012, 0.03, 0.62, 0.0, 0.065, 0x4a4a44, { paint: P_FIXED, ao: 0 }); // Trimmklappe
    b.pop();
  }
  b.cyl(0.1, 0.12, 0, 0, 0, 'y', 0x2a2a26, { paint: P_FIXED }, 7);
  b.cyl(0.14, 0.03, 0, 0.0, 0, 'y', 0x4a4a44, { paint: P_FIXED }, 7);
  return b.build({ groundAO: 0 });
}

// ---------------------------------------------------------------------------------------- gemeinsame Teile

function rocketPod(b: ModelBuilder, x: number, y: number, z: number): void {
  b.cyl(0.19, 1.7, x, y, z, 'z', HULL_LIGHT, { seg: 7, camo: false }, 7);
  b.lathe([[0, 0], [0.17, 0], [0.17, 0.03], [0, 0.03]], 'z', x, y, z - 0.86, BLACK, { paint: P_FIXED, seg: 7, ao: 0 });
  for (let i = 0; i < 6; i++) b.box(0.04, 0.04, 0.02, x + Math.cos(i * 1.047) * 0.1, y + Math.sin(i * 1.047) * 0.1, z - 0.88, 0xb09a50, fx); // Raketenspitzen
  b.box(0.2, 0.04, 0.5, x, y + 0.2, z - 0.4, STEEL, fx); // Halteband
  b.box(0.2, 0.04, 0.5, x, y + 0.2, z + 0.4, STEEL, fx);
  b.cyl(0.05, 0.4, x, y + 0.34, z, 'y', STEEL, fx, 4);
}
function missile(b: ModelBuilder, x: number, y: number, z: number, len: number, r: number, color = MISSILE): void {
  b.cyl(r, len, x, y, z, 'z', color, { paint: P_FIXED, ao: 0.1 }, 5, r * 0.45);
  b.cyl(r * 1.02, len * 0.1, x, y, z - len * 0.12, 'z', 0xc8b040, fx, 5); // Kennband
  b.box(r * 5, 0.025, r * 1.4, x, y, z + len * 0.4, 0x6a6a64, { paint: P_FIXED, ao: 0 });
  b.box(0.025, r * 5, r * 1.4, x, y, z + len * 0.4, 0x6a6a64, { paint: P_FIXED, ao: 0 });
  b.box(r * 3, 0.02, r * 1.0, x, y, z - len * 0.22, 0x5a5a54, { paint: P_FIXED, ao: 0 });
}
function roundel(b: ModelBuilder, x: number, y: number, z: number, r: number): void {
  b.lathe([[r, 0], [0, 0]], 'y', x, y, z, 0xffffff, { paint: P_TEAM, seg: 8, ao: 0 });
  b.lathe([[r * 0.66, 0], [0, 0]], 'y', x, y + 0.012, z, WHITE, { paint: P_FIXED, seg: 8, ao: 0 });
  b.lathe([[r * 0.32, 0], [0, 0]], 'y', x, y + 0.024, z, 0xffffff, { paint: P_TEAM, seg: 8, ao: 0 });
}
function light(b: ModelBuilder, id: 14 | 18, x: number, y: number, z: number, color: number, s = 0.14): void {
  b.part(id, [x, y, z], () => b.box(s, s, s, x, y, z, color, { paint: P_FIXED, ao: 0 }));
}
/** Streifen an Trailing/Leading Edge: Quad (x0..x1) mit Tiefe d, entlang einer Kante von (xa,za) nach (xb,zb) */
function edgeStrip(b: ModelBuilder, xa: number, za: number, xb: number, zb: number, x0: number, x1: number, d: number, y: number, color: number, camo?: boolean): void {
  const zAt = (x: number) => za + ((x - xa) / (xb - xa)) * (zb - za);
  const o = { camo: camo ? 0.9 : false, ao: 0 } as const;
  b.slab([[x0, zAt(x0) - d], [x1, zAt(x1) - d], [x1, zAt(x1)], [x0, zAt(x0)]], y - 0.012, y, 0, 0, 0, color, o);
}

// ============================================================================================ Kampfhubschrauber

export function buildHeliAttack(): ModelDef {
  const b = new ModelBuilder();
  // ---- Rumpf (Seitenprofil) + Nasen-/Wangenverkleidungen
  b.extrudeX([[-3.5, 1.15], [-3.0, 0.8], [1.6, 0.8], [2.6, 1.3], [2.7, 2.2], [0.2, 2.6], [-1.6, 2.4], [-3.15, 1.9]], 1.25, 0, 0, 0, HULL, { camo: 0.8, taper: [0.8, 0.9] });
  b.mirror(() => {
    b.box(0.34, 0.5, 2.0, 0.7, 2.0, -0.4, HULL_LIGHT, { camo: 0.8, rot: [0, 0, -0.1] }); // Panzerwannen
    b.box(0.3, 0.45, 1.5, 0.52, 1.35, -2.5, HULL, { camo: 0.8, top: [0.7, 0.8], rot: [0, 0.12, 0] }); // Avionikwangen
    b.box(0.04, 0.2, 0.6, 0.72, 1.4, -2.2, PANEL, fx); // Wartungsklappen
    b.box(0.04, 0.2, 0.6, 0.72, 1.4, -1.4, 0xbcbcbc, fx);
    b.box(0.5, 0.1, 0.9, 0.62, 2.65, 1.2, HULL_DARK, { camo: 1 });
  });
  b.box(0.5, 0.22, 1.2, 0, 2.62, 0.1, HULL_LIGHT, { camo: 0.8, top: [0.8, 0.8] }); // Getriebeverkleidung
  b.box(0.45, 0.05, 0.9, 0, 2.76, 0.5, 0xffffff, { paint: P_TEAM, ao: 0 });
  // ---- Tandem-Kanzel: Scheiben, Rahmen, Besatzung
  b.extrudeX([[-3.2, 1.75], [-2.7, 2.35], [-1.8, 2.45], [-1.7, 1.8]], 0.85, 0, 0, 0, GLASS, { paint: P_FIXED, taper: [1, 0.6], ao: 0 });
  b.extrudeX([[-1.5, 2.2], [-1.0, 2.95], [0.1, 3.0], [0.8, 2.4]], 0.85, 0, 0, 0, GLASS, { paint: P_FIXED, taper: [1, 0.6], ao: 0 });
  b.box(0.95, 0.07, 0.1, 0, 2.38, -1.65, HULL_DARK, { camo: 1 });
  b.box(0.88, 0.07, 0.1, 0, 2.97, -0.4, HULL_DARK, { camo: 1 });
  b.mirror(() => {
    b.box(0.06, 0.08, 1.2, 0.4, 2.2, -2.45, DARK, { ...fx, rot: [-0.45, 0, 0.0] }); // Seitenrahmen
    b.box(0.06, 0.08, 1.6, 0.4, 2.6, -0.5, DARK, { ...fx, rot: [-0.55, 0, 0] });
    b.box(0.06, 0.5, 0.06, 0.42, 2.45, -1.0, DARK, fx);
  });
  b.cyl(0.11, 0.24, 0, 2.15, -2.45, 'y', 0xe6e6e0, fx, 5); // Helm Richtschütze
  b.box(0.32, 0.3, 0.2, 0, 1.85, -2.35, 0x3a4a3a, fx);
  b.cyl(0.11, 0.24, 0, 2.6, -0.65, 'y', 0xe6e6e0, fx, 5); // Helm Pilot
  b.box(0.32, 0.3, 0.2, 0, 2.3, -0.55, 0x3a4a3a, fx);
  b.cyl(0.012, 0.8, 0, 3.15, -3.25, 'y', DARK, fx, 4); // Drahtschneider
  // ---- Triebwerksgondeln mit Lufteinlass und IR-Unterdrücker
  b.mirror(() => {
    b.cyl(0.4, 2.6, 0.82, 2.35, 1.5, 'z', HULL_LIGHT, { seg: 8 }, 8, 0.42);
    b.box(0.5, 0.5, 0.06, 0.82, 2.35, 0.17, BLACK, fx); // Einlassgitter
    for (let i = 0; i < 3; i++) b.box(0.46, 0.03, 0.08, 0.82, 2.2 + i * 0.17, 0.15, STEEL, fx);
    b.box(0.36, 0.34, 0.7, 0.82, 2.32, 3.1, DARK, { ...fx, rot: [0.0, 0, 0] });
    b.box(0.5, 0.06, 0.55, 0.82, 2.62, 3.2, 0x3a3a34, fx);
    for (let i = 0; i < 3; i++) b.box(0.4, 0.03, 0.09, 0.82, 2.2 + i * 0.07, 3.46, BLACK, fx); // Auslassschlitze
    b.box(0.5, 0.3, 0.9, 0.65, 2.9, 0.25, HULL_DARK, { camo: 1 });
  });
  // ---- Heckausleger, Stabilisator, Seitenleitwerk, Heckrotor
  b.cyl(0.3, 2.1, 0, 2.15, 3.2, 'z', HULL, { seg: 6, camo: false, edgeColors: [HULL, PANEL, HULL] }, 6, 0.4);
  b.cyl(0.4, 2.0, 0, 2.15, 5.2, 'z', HULL, { seg: 6, camo: false, edgeColors: [HULL, PANEL, HULL] }, 6, 0.3);
  b.cyl(0.3, 1.9, 0, 2.15, 7.1, 'z', HULL_LIGHT, { seg: 6, camo: false, edgeColors: [HULL, PANEL, HULL] }, 6, 0.22);
  b.extrudeX([[6.3, 2.2], [7.5, 3.9], [8.3, 3.9], [8.1, 2.2]], 0.12, 0, 0, 0, 0xffffff, { paint: P_TEAM, ao: 0.1 });
  b.extrudeX([[7.8, 3.5], [8.3, 3.9], [8.35, 2.8], [8.1, 2.3]], 0.14, 0, 0, 0, HULL_DARK, { camo: 1 }); // Seitenruder
  b.box(2.8, 0.1, 0.8, 0, 2.2, 7.5, HULL_LIGHT, { camo: 1, top: [0.7, 0.8] });
  b.box(2.8, 0.1, 0.25, 0, 2.2, 7.95, HULL_DARK, { camo: 1, top: [0.7, 0.9] }); // Höhenruder
  b.box(0.14, 0.5, 0.5, 0.1, 3.0, 8.1, DARK, fx); // Heckrotorgetriebe
  b.box(0.1, 0.1, 0.6, 0.0, 2.2, 8.4, DARK, fx);
  b.box(0.1, 0.26, 0.2, 0, 2.0, 8.7, 0x2a2a26, { ...fx, rot: [0.3, 0, 0] }); // Heckschutz
  light(b, 14, 0, 4.0, 7.95, 0xff4040);
  light(b, 18, 0.07, 3.8, 8.35, 0xffffff, 0.1);
  b.cyl(0.012, 1.1, 0.0, 2.9, 7.0, 'y', DARK, fx, 4); // Antenne
  b.mirror(() => b.plateSide(1.2, 0.5, 0.215, 2.15, 4.0, 1, 0xffffff, P_TEAM));
  // ---- Stummelflügel mit Klappen, Raketenbehältern und Panzerabwehrlenkwaffen
  b.mirror(() => {
    b.slab([[0.5, -0.9], [2.55, -0.3], [2.55, 0.35], [0.5, 0.85]], 0, 0.13, 0, 1.5, 0.0, HULL, { camo: 0.8 });
    edgeStrip(b, 0.5, 0.85, 2.55, 0.35, 0.7, 2.4, 0.4, 1.645, HULL_DARK, true);
    b.box(0.5, 0.06, 0.4, 2.55, 1.58, 0.0, 0xffffff, { paint: P_TEAM, ao: 0 }); // Flügelspitzenmarkierung
    rocketPod(b, 1.5, 1.15, -0.3);
    for (let i = 0; i < 2; i++) {
      b.box(0.1, 0.18, 1.2, 2.05, 1.25, 0.0, STEEL, fx);
      b.box(0.22, 0.05, 1.3, 2.05, 1.14 - i * 0.2, 0.0, 0x4a4a44, fx); // Schiene
      missile(b, 2.1, 1.28 - i * 0.2, -0.15, 1.8, 0.07);
    }
    b.box(0.2, 0.2, 0.7, 2.58, 1.58, 0.1, 0x5a6a52, fx); // ESM-Behälter
    b.cyl(0.03, 1.2, 2.5, 1.9, 0.1, 'y', DARK, fx, 4);
    light(b, 18, 2.6, 1.6, 0.4, 0xff2020, 0.13);
  });
  // ---- Bugdrehturm: 30-mm-Kanone und Sensorkopf (schwenken zum Ziel)
  b.part(16, [0, 0.75, -2.6], () => {
    b.lathe([[0, 0], [0.26, 0], [0.2, 0.2], [0, 0.22]], 'y', 0, 0.65, -2.6, 0x55554e, { paint: P_FIXED, seg: 7 });
    b.box(0.36, 0.3, 0.7, 0, 0.5, -2.8, 0x3a3a34, { ...fx, top: [0.8, 0.9] }); // Kanonengehäuse
    b.box(0.22, 0.26, 0.5, 0.24, 0.55, -2.65, 0x4a4a44, fx); // Munitionszuführung
    b.barrel(0.05, 1.5, 0, 0.55, -3.05, -0.15, 0x3a3a34, 5);
    b.cyl(0.07, 0.2, 0, 0.45, -4.2, 'z', BLACK, fx, 5); // Mündung
  });
  b.part(16, [0, 1.45, -3.95], () => {
    b.box(0.55, 0.5, 0.7, 0, 1.45, -3.95, 0x2a2a26, { ...fx, top: [0.85, 0.8] }); // TADS
    b.box(0.35, 0.3, 0.04, 0, 1.5, -4.3, GLASS_LIGHT, fx);
    b.cyl(0.09, 0.05, 0.15, 1.35, -4.31, 'z', GLASS, fx, 5);
    b.cyl(0.09, 0.05, -0.15, 1.58, -4.31, 'z', GLASS, fx, 5);
  });
  b.box(0.28, 0.24, 0.3, 0, 2.5, -3.3, 0x2a2a26, fx); // PNVS
  b.cyl(0.07, 0.04, 0, 2.52, -3.46, 'z', GLASS_LIGHT, fx, 5);
  // ---- Rotormast: Welle, Taumelscheibe, Anlenkstangen, Nabe, Wurzeln
  b.cyl(0.17, 0.6, 0, 2.95, -0.8, 'y', DARK, fx, 6);
  b.cyl(0.14, 0.5, 0, 3.15, -0.8, 'y', 0x3a3a34, fx, 6);
  b.cyl(0.32, 0.06, 0, 3.0, -0.8, 'y', 0x6a6a64, fx, 8); // Taumelscheibe
  for (let i = 0; i < 4; i++) b.cyl(0.012, 0.34, Math.cos(i * 1.571) * 0.26, 3.2, -0.8 + Math.sin(i * 1.571) * 0.26, 'y', STEEL, fx, 4);
  b.box(0.2, 0.2, 0.3, 0, 3.2, -0.8, 0x4a4a44, fx);
  b.cyl(0.24, 0.18, 0, 3.42, -0.8, 'y', 0x3a3a34, fx, 7); // Nabe
  for (let i = 0; i < 4; i++) b.box(0.4, 0.06, 0.12, Math.cos(i * 1.571) * 0.3, 3.45, -0.8 + Math.sin(i * 1.571) * 0.3, 0x2a2a26, { ...fx, rot: [0, -i * 1.571, 0] });
  // ---- Fahrwerk: Hauptfahrwerk mit Federbein, Heckrad
  b.mirror(() => {
    b.box(0.1, 0.6, 0.12, 0.72, 0.6, -2.0, DARK, fx);
    b.box(0.06, 0.5, 0.08, 0.76, 0.58, -1.85, STEEL, { ...fx, rot: [0.4, 0, 0] });
    b.cyl(0.17, 0.12, 0.78, 0.22, -2.0, 'x', TIRE, fx, 7);
    b.cyl(0.07, 0.1, 0.78, 0.22, -2.0, 'x', STEEL, fx, 5);
    b.box(0.06, 0.06, 0.6, 0.76, 0.72, -1.7, STEEL, fx);
  });
  b.box(0.1, 0.9, 0.12, 0, 1.55, 4.2, DARK, { ...fx, rot: [0.25, 0, 0] });
  b.cyl(0.14, 0.1, 0, 0.32, 4.4, 'x', TIRE, fx, 7);
  b.mirror(() => b.box(0.9, 0.04, 0.5, 0.0, 0.0, 0.0, DARK, fx));
  b.box(0.45, 0.05, 0.9, 0, 2.62, 0.5, 0xffffff, { paint: P_TEAM, ao: 0 });
  b.mirror(() => {
    b.plateSide(0.9, 0.9, 0.64, 1.5, 0.8, 1, 0xffffff, P_TEAM);
    b.plateSide(0.5, 0.5, 0.645, 1.5, 0.8, 1, WHITE);
  });
  return {
    geom: b.build({ groundAO: 0.2, groundH: 0.8 }),
    size: 15,
    boost: 1,
    rotors: [[0, 3.55, -0.8, 6.5], [0.3, 3.0, 8.15, 1.15, 'x']],
    livery: 'heli',
    tilt: false,
    anim: 'air',
  };
}

// ============================================================================================ Transporthubschrauber (Tandem)

export function buildHeliTransport(): ModelDef {
  const b = new ModelBuilder();
  b.extrudeX([[-7.3, 1.7], [-6.9, 0.95], [5.0, 0.9], [7.4, 2.2], [7.4, 3.2], [5.5, 3.5], [-5.6, 3.55], [-7.0, 3.2]], 2.5, 0, 0, 0, HULL, { camo: 0.9, taper: [0.92, 0.82] });
  // Kehlen / Panelbänder
  for (let i = 0; i < 5; i++) b.box(2.3, 0.05, 0.12, 0, 3.58, -4.5 + i * 2.2, PANEL, { paint: P_FIXED, ao: 0 });
  // Cockpit: Bugfenster, Rahmen, Besatzung
  b.box(2.0, 0.7, 0.08, 0, 2.95, -7.2, GLASS, { paint: P_FIXED, rot: [0.2, 0, 0] });
  b.mirror(() => {
    b.box(0.07, 0.8, 0.07, 1.0, 2.95, -7.05, DARK, fx);
    b.box(0.07, 0.6, 1.2, 1.2, 3.0, -6.4, GLASS, { ...fx, rot: [0, 0, 0] });
    b.box(0.08, 0.08, 1.3, 1.22, 3.35, -6.3, DARK, fx);
    b.box(0.08, 0.08, 1.3, 1.22, 2.7, -6.3, DARK, fx);
    for (let i = 0; i < 6; i++) {
      b.plateSide(0.6, 0.45, 1.25 - 0.06, 2.75, -3.8 + i * 1.5, 1, 0x20303a);
      b.box(0.04, 0.54, 0.05, 1.255, 2.75, -3.45 + i * 1.5, 0xc4c4c4, { ...fx, ao: 0 });
    }
    b.plateSide(1.8, 1.7, 1.26 - 0.05, 2.1, 2.4, 1, 0x3a3a34); // Ladetür
    b.box(0.05, 1.7, 0.05, 1.27, 2.1, 1.5, STEEL, fx);
    b.box(0.05, 1.7, 0.05, 1.27, 2.1, 3.3, STEEL, fx);
    b.plateSide(0.7, 0.7, 1.27, 2.95, 3.6, 1, 0xffffff, P_TEAM); // Hoheitszeichen
    b.plateSide(0.35, 0.35, 1.275, 2.95, 3.6, 1, WHITE);
  });
  b.cyl(0.14, 0.24, -0.4, 3.1, -6.6, 'y', 0xe6e6e0, fx, 5); // Pilotenhelme
  b.cyl(0.14, 0.24, 0.4, 3.1, -6.6, 'y', 0xe6e6e0, fx, 5);
  b.box(0.4, 0.4, 0.3, -0.4, 2.7, -6.4, 0x3a4a3a, fx);
  b.box(0.4, 0.4, 0.3, 0.4, 2.7, -6.4, 0x3a4a3a, fx);
  b.box(0.5, 0.35, 0.45, 0, 1.55, -7.3, 0x2a2a26, fx); // Nasensensor
  b.cyl(0.14, 0.08, 0, 1.55, -7.55, 'z', GLASS_LIGHT, fx, 6);
  // Heckrampe + Schleppwerk
  b.box(1.9, 0.12, 2.2, 0, 1.7, 8.0, HULL_DARK, { camo: 1, rot: [-0.35, 0, 0] });
  b.box(2.3, 1.5, 0.12, 0, 2.5, 7.45, 0x2a2a26, fx);
  b.mirror(() => b.box(0.05, 0.05, 2.0, 0.9, 1.9, 7.9, STEEL, { ...fx, rot: [-0.35, 0, 0] }));
  b.box(0.5, 0.1, 0.4, 0, 1.6, 6.1, STEEL, fx);
  // Rotorpylone: vorn niedrig, hinten hoch mit Triebwerken
  b.box(1.1, 0.8, 1.6, 0, 3.9, -5.6, HULL, { camo: 0.8, top: [0.7, 0.8] });
  b.cyl(0.38, 0.7, 0, 4.4, -5.6, 'y', 0x3a3a34, fx, 7);
  b.extrudeX([[3.3, 3.4], [4.8, 5.1], [6.5, 5.1], [7.2, 3.4]], 1.3, 0, 0, 0, HULL, { camo: 0.8, taper: [1, 0.55] });
  b.cyl(0.38, 0.7, 0, 5.2, 5.6, 'y', 0x3a3a34, fx, 7);
  b.mirror(() => {
    b.cyl(0.55, 2.8, 1.0, 4.3, 5.8, 'z', HULL_LIGHT, { seg: 8 }, 8, 0.6);
    b.box(0.6, 0.6, 0.06, 1.0, 4.3, 4.35, BLACK, fx);
    for (let i = 0; i < 4; i++) b.box(0.55, 0.03, 0.08, 1.0, 4.1 + i * 0.14, 4.33, STEEL, fx);
    b.cyl(0.35, 0.5, 1.0, 4.3, 7.3, 'z', DARK, fx, 6);
    // Sponsons mit Tanks und Fahrwerk
    b.box(0.9, 1.1, 5.4, 1.45, 1.35, 0.4, HULL_DARK, { camo: 0.8, top: [0.8, 0.9] });
    b.box(0.06, 0.4, 2.0, 1.92, 1.5, 0.4, PANEL, fx);
    b.box(0.14, 0.7, 0.14, 1.45, 0.8, -4.6, DARK, fx);
    b.box(0.08, 0.6, 0.1, 1.55, 0.85, -4.2, STEEL, { ...fx, rot: [0.5, 0, 0] });
    b.cyl(0.35, 0.3, 1.5, 0.35, -4.6, 'x', TIRE, fx, 8);
    b.cyl(0.14, 0.32, 1.5, 0.35, -4.6, 'x', STEEL, fx, 5);
    b.cyl(0.4, 0.3, 1.5, 0.4, 4.4, 'x', TIRE, fx, 8);
    b.cyl(0.16, 0.32, 1.5, 0.4, 4.4, 'x', STEEL, fx, 5);
    b.box(0.14, 0.7, 0.14, 1.45, 0.85, 4.4, DARK, fx);
    light(b, 18, 1.6, 4.0, -5.8, 0xff2020);
  });
  b.cyl(0.14, 0.5, 0, 4.4, -5.6, 'y', DARK, fx, 6);
  b.cyl(0.14, 0.5, 0, 5.2, 5.6, 'y', DARK, fx, 6);
  for (let k = 0; k < 2; k++) {
    const z = k ? 5.6 : -5.6, y = k ? 5.5 : 4.6;
    b.cyl(0.3, 0.2, 0, y - 0.05, z, 'y', 0x3a3a34, fx, 7);
    for (let i = 0; i < 3; i++) b.box(0.4, 0.07, 0.14, Math.cos(i * 2.094) * 0.3, y + 0.07, z + Math.sin(i * 2.094) * 0.3, 0x2a2a26, { ...fx, rot: [0, -i * 2.094, 0] });
  }
  b.box(2.52, 0.4, 2.0, 0, 2.2, 3.0, 0xffffff, { paint: P_TEAM, ao: 0 });
  b.cyl(0.03, 1.0, 0, 3.8, 0.5, 'y', DARK, fx, 4);
  b.cyl(0.03, 0.8, 0, 3.75, -2.5, 'y', DARK, fx, 4);
  b.box(0.1, 1.2, 0.12, 0, 0.3, -5.4, DARK, fx);
  b.box(0.6, 0.12, 0.4, 0, 1.0, 0.0, STEEL, fx); // Lastenhaken-Luke
  b.box(0.2, 0.15, 0.5, 0, 1.0, 0.0, DARK, fx);
  light(b, 14, 0, 3.7, 6.0, 0xff4040);
  light(b, 14, 0, 0.95, 0, 0xff4040);
  return {
    geom: b.build({ groundAO: 0.2, groundH: 1.0 }),
    size: 20,
    boost: 1,
    rotors: [[0, 4.6, -5.6, 9], [0, 5.5, 5.6, 9]],
    livery: 'heli',
    tilt: false,
    anim: 'air',
  };
}

// ============================================================================================ Kampfflugzeug

/** Rumpf als Drehkörper aus Stationen [z, Radius]; Panelbänder als abwechselnde Farben */
function fuselage(b: ModelBuilder, st: Array<[number, number]>, squash: number, seg = 8): void {
  const prof = st.map(([z, r]) => [r, -z] as [number, number]);
  const ec: number[] = [];
  for (let i = 0; i < st.length - 1; i++) ec.push(i % 2 ? PANEL : HULL);
  b.lathe(prof, 'z', 0, 0, 0, HULL, { seg, squash: [1, 1, squash], camo: false, ao: 0.2, edgeColors: ec });
}

function nozzle(b: ModelBuilder, x: number, y: number, z: number, r: number): void {
  b.cyl(r, 1.0, x, y, z, 'z', 0x4a4a44, { paint: P_FIXED, edgeColors: [0x4a4a44, 0x3a3a34, 0x2a2a26] }, 8, r * 0.82);
  for (let i = 0; i < 8; i++) b.box(0.04, 0.02, 0.5, x + Math.cos(i * 0.785) * r * 0.9, y + Math.sin(i * 0.785) * r * 0.9, z + 0.62, 0x6a6a64, { ...fx, rot: [0, 0, i * 0.785 + 1.57] }); // Düsenlamellen
  b.lathe([[0, 0], [r * 0.8, 0]], 'z', x, y, z + 0.5, 0x1a1a18, { paint: P_FIXED, seg: 8, ao: 0 });
  // Nachbrenner: Glühring + Flamme (leuchten bei hohem Schub)
  b.part(13, [x, y, z + 0.52], () => {
    b.lathe([[0, 0], [r * 0.5, 0.0], [r * 0.78, 0]], 'z', x, y, z + 0.5, 0xff9a40, { paint: P_FIXED, seg: 8, ao: 0, edgeColors: [0xffb060, 0xffe0a0] });
    const L = r * 8;
    b.lathe([[0, -(z + 0.52 + L)], [r * 0.5, -(z + 0.52 + L * 0.5)], [r * 0.75, -(z + 0.52)]], 'z', x, y, 0, 0xff8030, { paint: P_FIXED, seg: 8, ao: 0, edgeColors: [0xffd070, 0xff7020] });
    b.lathe([[0, -(z + 0.52 + L * 0.6)], [r * 0.4, -(z + 0.52)]], 'z', x, y, 0, 0xfff0c0, { paint: P_FIXED, seg: 6, ao: 0 });
  });
}

function landingGear(b: ModelBuilder, y: number, noseZ: number, mainZ: number, mainX: number, big: boolean): void {
  const wr = big ? 0.32 : 0.24;
  // Bugfahrwerk (Part 11)
  b.part(11, [0, y, noseZ], () => {
    b.box(0.1, 1.1, 0.12, 0, y - 0.55, noseZ, STEEL, fx);
    b.box(0.07, 0.07, 0.5, 0, y - 0.4, noseZ + 0.2, STEEL, { ...fx, rot: [0.5, 0, 0] });
    b.mirror(() => {
      b.cyl(wr * 0.8, 0.13, 0.13, y - 1.0, noseZ, 'x', TIRE, fx, 7);
      b.cyl(wr * 0.35, 0.15, 0.13, y - 1.0, noseZ, 'x', STEEL, fx, 5);
    });
    b.box(0.3, 0.05, 0.05, 0, y - 1.0, noseZ, STEEL, fx);
    b.box(0.08, 0.1, 0.16, 0, y - 0.15, noseZ - 0.15, 0xfff2c0, fx); // Landescheinwerfer
  });
  // Hauptfahrwerk (Part 10) + Klappen (Part 12)
  b.mirror(() => {
    b.part(10, [mainX, y, mainZ], () => {
      b.box(0.14, 1.0, 0.16, mainX, y - 0.5, mainZ, STEEL, fx);
      b.box(0.08, 0.08, 0.6, mainX, y - 0.35, mainZ + 0.3, STEEL, { ...fx, rot: [-0.5, 0, 0] });
      b.cyl(wr, 0.22, mainX, y - 0.95, mainZ, 'x', TIRE, fx, 8);
      b.cyl(wr * 0.5, 0.26, mainX, y - 0.95, mainZ, 'x', STEEL, fx, 5);
      b.cyl(wr * 0.7, 0.05, mainX - 0.12, y - 0.95, mainZ, 'x', 0x555550, fx, 6);
    });
    b.part(12, [mainX - 0.45, y + 0.1, mainZ], () => b.box(0.05, 0.9, 1.5, mainX + 0.03, y - 0.38, mainZ, HULL_DARK, { camo: 1 }));
  });
}

export function buildJet(): ModelDef {
  const b = new ModelBuilder();
  b.push(0, 1.65, 0); // Räder berühren den Boden
  // ---- Rumpf mit Panelbändern, Rücken, Radarnase, Sonde
  fuselage(b, [[7.9, 0.3], [7.1, 0.6], [6.0, 0.72], [4.0, 0.82], [1.5, 0.86], [-1.0, 0.84], [-3.0, 0.7], [-4.8, 0.5], [-6.1, 0.3]], 0.82);
  b.lathe([[0.3, 6.1], [0.22, 6.8], [0.1, 7.3], [0, 7.6]].map(([r, y]) => [r, y] as [number, number]), 'z', 0, 0, 0, 0x6a7068, { paint: P_FIXED, seg: 8, squash: [1, 1, 0.9] });
  b.cyl(0.03, 0.8, 0, 0.0, -7.9, 'z', 0x3a3a34, fx, 4); // Pitotrohr
  b.box(0.9, 0.22, 7.5, 0, 0.55, 1.5, HULL, { camo: 0.8, top: [0.8, 0.9] });
  b.box(0.5, 0.18, 2.0, 0, 0.72, 3.6, HULL_DARK, { camo: 1, top: [0.7, 0.9] }); // Rückenwulst
  b.box(0.7, 0.08, 1.2, 0, 0.64, 4.6, 0xffffff, { paint: P_TEAM, ao: 0 });
  for (let i = 0; i < 5; i++) b.box(0.6, 0.02, 0.03, 0, 0.67, -0.5 + i * 1.4, 0x9a9a9a, { ...fx, ao: 0 }); // Panelfugen
  b.mirror(() => {
    b.box(0.03, 0.25, 0.8, 0.77, 0.1, 3.0, PANEL, fx); // Serviceklappen
    b.box(0.03, 0.25, 0.8, 0.77, 0.1, 1.4, 0xbcbcbc, fx);
  });
  // ---- Kanzel mit Rahmen, Pilot, Headup-Display
  b.extrudeX([[-4.3, 0.5], [-3.2, 1.15], [-1.9, 1.15], [-0.7, 0.55]], 0.72, 0, 0, 0, GLASS, { paint: P_FIXED, taper: [1, 0.5], ao: 0 });
  for (const z of [-3.7, -2.7, -1.8]) b.box(0.68, 0.05, 0.07, 0, 0.95 + (z === -2.7 ? 0.2 : 0), z, DARK, fx);
  b.box(0.05, 0.05, 3.0, 0, 1.2, -2.6, DARK, fx);
  b.mirror(() => b.box(0.05, 0.1, 3.6, 0.37, 0.56, -2.5, HULL_DARK, { camo: 1 }));
  b.box(0.76, 0.06, 0.1, 0, 0.6, -3.1, DARK, fx);
  b.cyl(0.11, 0.22, 0, 0.92, -2.85, 'y', 0xe6e6e0, fx, 5); // Pilot
  b.box(0.34, 0.3, 0.2, 0, 0.74, -2.6, 0x3a4a3a, fx);
  b.box(0.4, 0.55, 0.1, 0, 0.8, -2.25, 0x2a2a26, fx);
  b.box(0.3, 0.18, 0.03, 0, 0.92, -3.45, GLASS_LIGHT, { ...fx, rot: [0.4, 0, 0] }); // HUD
  // ---- Lufteinläufe mit Splitterplatte
  b.mirror(() => {
    b.box(0.6, 0.55, 2.8, 0.85, -0.25, -2.4, HULL, { camo: 0.8, top: [0.9, 1] });
    b.box(0.5, 0.45, 0.06, 0.85, -0.25, -3.83, 0x1a1a18, { paint: P_FIXED, ao: 0 });
    b.box(0.05, 0.6, 0.25, 0.58, -0.25, -3.9, 0x6a6a64, fx); // Splitter
    b.box(0.68, 0.05, 0.12, 0.85, 0.05, -3.84, PANEL, fx); // Lippe
    b.box(0.68, 0.05, 0.12, 0.85, -0.55, -3.84, 0x8a8a86, fx);
    b.box(0.5, 0.04, 0.5, 0.85, 0.03, -1.4, 0x3a3a34, fx); // Hilfseinlass
  });
  // ---- Flügel mit Vorflügeln, Klappen, Querrudern; Canards; Höhenleitwerk
  b.mirror((side) => {
    b.slab([[0.5, -1.2], [5.3, 2.6], [5.3, 3.9], [0.5, 4.8]], -0.12, 0.08, 0, 0, 0, HULL_LIGHT, { camo: 0.8 });
    edgeStrip(b, 0.5, -1.2, 5.3, 2.6, 0.55, 5.2, 0.45, 0.1, HULL_DARK, true); // Vorflügel
    edgeStrip(b, 0.5, 4.8, 5.3, 3.9, 0.8, 2.9, 0.75, 0.1, HULL_DARK, true); // Landeklappe
    edgeStrip(b, 0.5, 4.8, 5.3, 3.9, 3.0, 5.25, 0.6, 0.1, 0xbcbcbc, true); // Querruder
    for (const x of [1.8, 3.0]) b.box(0.04, 0.02, 1.2, x, 0.09, 2.2 + (x - 1.8) * 0.4, 0x6a6a64, { ...fx, ao: 0 });
    roundel(b, 3.0, 0.11, 2.2, 0.62);
    b.slab([[0.55, -4.9], [2.1, -3.7], [2.1, -3.1], [0.55, -3.3]], 0.0, 0.07, 0, 0.1, 0, HULL_DARK, { camo: 0.9 });
    edgeStrip(b, 0.55, -3.3, 2.1, -3.1, 0.7, 2.0, 0.35, 0.17, 0xbcbcbc);
    b.slab([[0.55, 4.8], [2.7, 6.3], [2.7, 6.9], [0.55, 6.9]], -0.1, 0.07, 0, 0, 0, HULL_DARK, { camo: 0.9 });
    edgeStrip(b, 0.55, 6.9, 2.7, 6.9, 0.8, 2.6, 0.5, 0.07, 0xbcbcbc);
    // Flügelspitze: Rail + Lenkwaffe + Positionslicht (rot links, grün rechts)
    b.box(0.1, 0.1, 1.2, 5.4, -0.02, 2.5, STEEL, fx);
    missile(b, 5.35, -0.02, 2.4, 2.8, 0.09);
    light(b, 18, 5.4, 0.04, 3.8, side > 0 ? 0x30ff30 : 0xff3030, 0.14);
    // Pylone + Lasten: Zusatztank / Lenkwaffe / Pod
    b.box(0.1, 0.3, 1.2, 2.6, -0.3, 1.6, STEEL, fx);
    b.cyl(0.19, 2.4, 2.6, -0.62, 1.4, 'z', 0xb8b8b0, fx, 7, 0.1);
    b.box(0.3, 0.02, 0.5, 2.6, -0.62, 1.1, 0x6a6a64, fx);
    b.box(0.1, 0.28, 1.0, 4.0, -0.25, 2.4, STEEL, fx);
    missile(b, 4.0, -0.52, 2.2, 3.2, 0.09, 0xe0e0d8);
    b.box(0.1, 0.25, 0.9, 1.5, -0.25, 2.8, STEEL, fx);
    b.cyl(0.14, 1.4, 1.5, -0.5, 2.7, 'z', 0x5a6a52, fx, 6, 0.1); // Pod
    // Seitenleitwerke (nach außen geneigt) mit Seitenruder
    b.extrudeX([[3.6, 0.5], [5.2, 3.0], [6.2, 3.0], [6.3, 0.5]], 0.1, 0.6, 0.0, 0.0, 0xffffff, { paint: P_TEAM, rot: [0, 0, -0.18], ao: 0.1 });
    b.extrudeX([[5.5, 0.6], [6.0, 3.0], [6.25, 2.9], [6.3, 0.55]], 0.14, 0.62, 0.0, 0.0, HULL_DARK, { camo: 1, rot: [0, 0, -0.18], ao: 0.1 });
    b.box(0.08, 0.2, 0.6, 1.05, 3.1, 5.5, 0x3a3a34, { ...fx, rot: [0, 0, -0.18] }); // Fin-Antenne
    nozzle(b, 0.32, 0.0, 6.85, 0.36);
  });
  b.mirror(() => missile(b, 0.5, -0.62, 0.2, 3.6, 0.09));
  b.mirror(() => b.box(0.1, 0.08, 1.4, 0.4, -0.64, 0.5, STEEL, fx));
  light(b, 14, 0, 0.82, 3.8, 0xff4040); // Antikollisionslicht
  light(b, 14, 0, -0.72, -1.0, 0xff4040);
  light(b, 18, 0, 3.4, 6.1, 0xffffff, 0.1);
  landingGear(b, -0.55, -4.6, 1.6, 1.05, false);
  void P_CAMO; void RED; void WHITE;
  b.pop();
  return { geom: b.build({ groundAO: 0 }), size: 16, boost: 1.2, livery: 'air', tilt: false, anim: 'air' };
}

// ============================================================================================ Jagdbomber (Schwenkflügel)

export function buildBomber(): ModelDef {
  const b = new ModelBuilder();
  b.push(0, 2.0, 0);
  fuselage(b, [[8.8, 0.35], [8.2, 0.7], [6.0, 0.95], [3.0, 1.0], [-2.0, 1.05], [-4.0, 0.95], [-5.5, 0.8], [-7.0, 0.45]].map(([z, r]) => [z, r] as [number, number]), 0.85, 9);
  b.lathe([[0.45, 7.0], [0.25, 8.0], [0, 8.9]], 'z', 0, 0, 0, 0x6a7068, { paint: P_FIXED, seg: 8, squash: [1, 1, 0.9] });
  b.box(1.4, 0.3, 11, 0, 0.78, 1.5, HULL, { camo: 0.8, top: [0.85, 0.92] });
  b.box(0.7, 0.2, 4.0, 0, 0.98, 3.8, HULL_DARK, { camo: 1, top: [0.7, 0.9] });
  b.cyl(0.07, 1.1, 0, 0, -9.3, 'z', 0x3a3a34, fx, 5); // Sonde
  for (let i = 0; i < 6; i++) b.box(1.1, 0.02, 0.04, 0, 0.94, -3 + i * 1.6, 0x9a9a9a, { ...fx, ao: 0 });
  // Kanzel (nebeneinander)
  b.extrudeX([[-6.5, 0.6], [-5.5, 1.35], [-3.5, 1.35], [-2.2, 0.7]], 1.1, 0, 0, 0, GLASS, { paint: P_FIXED, taper: [1, 0.55], ao: 0 });
  b.box(1.15, 0.07, 0.12, 0, 0.7, -4.6, DARK, fx);
  for (const z of [-5.8, -4.6, -3.6]) b.box(1.0, 0.05, 0.07, 0, 1.2, z, DARK, fx);
  b.box(0.05, 0.05, 3.3, 0, 1.38, -4.6, DARK, fx);
  b.mirror(() => {
    b.cyl(0.11, 0.22, 0.28, 1.08, -4.9, 'y', 0xe6e6e0, fx, 5);
    b.box(0.3, 0.3, 0.2, 0.28, 0.9, -4.7, 0x3a4a3a, fx);
    b.box(0.4, 0.55, 0.1, 0.28, 0.9, -4.35, 0x2a2a26, fx);
  });
  b.mirror((side) => {
    // Lufteinläufe an der Flügelwurzel mit Splitter
    b.box(0.75, 0.9, 3.4, 1.2, -0.1, -1.8, HULL, { camo: 0.8, top: [0.85, 1] });
    b.box(0.65, 0.78, 0.06, 1.2, -0.1, -3.53, 0x1a1a18, fx);
    b.box(0.05, 0.9, 0.3, 0.84, -0.1, -3.6, 0x6a6a64, fx);
    b.box(0.82, 0.05, 0.14, 1.2, 0.35, -3.54, PANEL, fx);
    // Schwenkflügel mit Vorflügeln, Klappen, Querrudern, Spoilern
    b.slab([[0.8, -1.6], [7.4, 2.4], [7.4, 4.0], [0.8, 4.4]], -0.12, 0.1, 0, 0, 0, HULL_LIGHT, { camo: 0.8 });
    b.slab([[0.8, -3.6], [2.2, -1.6], [2.2, 4.3], [0.8, 4.4]], -0.1, 0.12, 0, 0, 0, HULL_LIGHT, { camo: 0.9 });
    edgeStrip(b, 0.8, -1.6, 7.4, 2.4, 2.3, 7.3, 0.55, 0.112, HULL_DARK, true);
    edgeStrip(b, 0.8, 4.4, 7.4, 4.0, 2.3, 4.8, 0.8, 0.112, HULL_DARK, true);
    edgeStrip(b, 0.8, 4.4, 7.4, 4.0, 4.9, 7.3, 0.7, 0.112, 0xbcbcbc, true);
    for (const x of [3.0, 5.0]) b.box(0.9, 0.02, 0.5, x, 0.115, 2.7 + (x - 3) * 0.2, 0x6a6a64, { ...fx, ao: 0 });
    roundel(b, 4.4, 0.13, 2.4, 0.8);
    // Außenlasten: Tanks und Lenkwaffen
    b.box(0.12, 0.4, 1.4, 3.6, -0.3, 1.6, STEEL, fx);
    b.cyl(0.35, 3.6, 3.6, -0.78, 1.4, 'z', 0xb8b8b0, fx, 8, 0.2);
    b.box(0.12, 0.35, 1.2, 5.6, -0.25, 2.6, STEEL, fx);
    missile(b, 5.6, -0.55, 2.4, 3.4, 0.14, 0x9a9a92);
    b.box(0.12, 0.35, 1.0, 6.9, -0.2, 3.0, STEEL, fx);
    missile(b, 6.9, -0.42, 2.8, 2.6, 0.1, 0xe0e0d8);
    light(b, 18, 7.4, 0.04, 3.5, side > 0 ? 0x30ff30 : 0xff3030, 0.16);
    // Höhenleitwerk
    b.slab([[0.7, 5.7], [4.2, 7.4], [4.2, 8.1], [0.7, 8.4]], -0.15, 0.1, 0, 0.1, 0, HULL_DARK, { camo: 0.9 });
    edgeStrip(b, 0.7, 8.4, 4.2, 8.1, 0.9, 4.1, 0.55, 0.205, 0xbcbcbc);
    // Triebwerksgondeln, Düsen
    b.cyl(0.62, 3.2, 0.52, -0.1, 6.9, 'z', HULL, { seg: 8, camo: false }, 8, 0.6);
    nozzle(b, 0.52, -0.1, 8.5, 0.56);
  });
  // Seitenleitwerk (hoch) mit Ruder
  b.extrudeX([[4.4, 0.8], [6.6, 4.8], [8.2, 4.8], [8.6, 0.8]], 0.16, 0, 0, 0, 0xffffff, { paint: P_TEAM, ao: 0.1 });
  b.extrudeX([[7.2, 0.9], [8.1, 4.7], [8.5, 4.7], [8.7, 0.85]], 0.2, 0, 0, 0, HULL_DARK, { camo: 1, ao: 0.1 });
  b.box(0.3, 0.3, 1.4, 0, 0.5, 8.0, HULL_DARK, { camo: 1 });
  b.plateSide(1.4, 1.4, 0.09, 3.0, 6.9, 1, WHITE);
  b.plateSide(0.8, 0.8, 0.095, 3.0, 6.9, 1, 0xffffff, P_TEAM);
  // Bombenschacht mit geöffneten Klappen und sichtbaren Bomben
  b.box(1.0, 0.1, 4.6, 0, -0.92, -0.6, 0x2a2a26, fx);
  b.mirror(() => b.box(0.05, 0.4, 4.6, 0.55, -1.1, -0.6, HULL_DARK, { camo: 1, rot: [0, 0, 0.5] }));
  for (let i = 0; i < 2; i++) {
    for (const x of [-0.3, 0.3]) {
      b.box(0.08, 0.2, 0.9, x, -0.85, -1.9 + i * 2.6, STEEL, fx);
      b.cyl(0.2, 2.2, x, -1.15, -1.9 + i * 2.6, 'z', 0x7a7a52, fx, 7, 0.12); // Bomben
      b.cyl(0.21, 0.15, x, -1.15, -2.0 + i * 2.6, 'z', 0xc8b040, fx, 6);
    }
  }
  light(b, 14, 0, 1.04, 6.6, 0xff4040);
  light(b, 14, 0, -1.0, 3.5, 0xff4040);
  light(b, 18, 0, 5.0, 8.7, 0xffffff, 0.12);
  landingGear(b, -0.9, -5.0, 1.5, 1.25, true);
  b.pop();
  return { geom: b.build({ groundAO: 0 }), size: 22, boost: 1.2, livery: 'air', tilt: false, anim: 'air' };
}

// ============================================================================================ Drohnen

export function buildDroneFixed(): ModelDef {
  const b = new ModelBuilder();
  b.push(0, 0.65, 0);
  // Schlanker Rumpf mit Panelbändern, Nase mit SATCOM-Höcker, Sensorkugel (schwenkt zum Ziel)
  b.lathe([[0, -3.6], [0.1, -3.4], [0.2, -2.8], [0.36, -1.2], [0.36, 1.2], [0.22, 2.6], [0.1, 3.2], [0, 3.2]].map(([r, y]) => [r, y] as [number, number]), 'z', 0, 0, 0, HULL, { seg: 7, camo: false, ao: 0.2, edgeColors: [HULL, PANEL, HULL, PANEL, HULL, PANEL, HULL] });
  b.lathe([[0, 0], [0.42, 0], [0.4, 0.4], [0.2, 0.6], [0, 0.65]], 'y', 0, 0.2, -1.8, HULL, { seg: 7, squash: [1, 0.8, 1.8], ao: 0.1 });
  b.cyl(0.16, 0.04, 0, 0.78, -1.8, 'z', 0xe0e0e0, fx, 6); // SATCOM-Schüssel
  b.box(0.06, 0.2, 0.03, 0, 0.6, 0.3, DARK, fx); // Antennen
  b.box(0.02, 0.2, 0.6, 0, 0.4, 1.8, DARK, { ...fx, rot: [0.2, 0, 0] });
  b.part(16, [0, -0.35, -2.4], () => {
    b.lathe([[0, 0], [0.2, 0], [0.26, 0.15], [0.2, 0.3], [0, 0.34]], 'y', 0, -0.52, -2.4, 0x2a2a26, { paint: P_FIXED, seg: 7 }); // EO-Kugel
    b.cyl(0.07, 0.1, 0, -0.4, -2.64, 'z', GLASS_LIGHT, fx, 5);
    b.cyl(0.04, 0.1, 0.1, -0.34, -2.62, 'z', 0xa02020, fx, 4); // Laser
  });
  b.box(0.3, 0.1, 0.5, 0, -0.22, 1.0, 0x2a2a26, fx); // Ventralradom
  // Flügel: lang, schmal, mit Klappen, Spitzen in Teamfarbe
  b.mirror((side) => {
    b.slab([[0.3, -0.7], [7.1, -0.35], [7.1, 0.25], [0.3, 0.6]], 0.0, 0.1, 0, 0.18, 0, HULL_LIGHT, { camo: 0.9 });
    edgeStrip(b, 0.3, 0.6, 7.1, 0.25, 0.5, 3.0, 0.3, 0.29, HULL_DARK);
    edgeStrip(b, 0.3, 0.6, 7.1, 0.25, 3.2, 6.8, 0.28, 0.29, 0xbcbcbc);
    b.box(0.9, 0.12, 0.62, 6.65, 0.28, -0.05, 0xffffff, { paint: P_TEAM, ao: 0 });
    roundel(b, 4.4, 0.3, -0.05, 0.32);
    b.box(0.08, 0.16, 0.8, 3.0, -0.0, 0.0, STEEL, fx);
    missile(b, 3.0, -0.2, 0.1, 1.5, 0.06);
    b.box(0.08, 0.16, 0.7, 4.6, 0.0, 0.0, STEEL, fx);
    b.cyl(0.07, 1.0, 4.6, -0.14, 0.05, 'z', 0x7a7a52, fx, 5, 0.04);
    light(b, 18, 7.1, 0.3, 0.1, side > 0 ? 0x30ff30 : 0xff3030, 0.12);
    // V-Leitwerk
    b.slab([[0.0, 0.0], [1.4, 0.5], [1.4, 1.0], [0.0, 1.0]], 0, 0.07, 0.35, 0.35, 2.8, HULL, { rot: [0, 0, 0.7], camo: 0.6 });
    b.box(0.5, 0.04, 0.35, 1.1, 1.1, 3.6, 0xffffff, { paint: P_TEAM, ao: 0 });
  });
  // Druckpropeller (Part 15 dreht)
  b.cyl(0.13, 0.35, 0, 0.0, 3.35, 'z', 0x2a2a26, fx, 5);
  b.part(15, [0, 0, 3.6], () => {
    for (let i = 0; i < 3; i++) b.box(0.07, 0.8, 0.03, Math.sin(i * 2.094) * 0.4, Math.cos(i * 2.094) * 0.4, 3.6, 0x1c1c1a, { ...fx, rot: [0, 0, -i * 2.094] });
    b.cyl(0.1, 0.12, 0, 0, 3.6, 'z', 0x4a4a44, fx, 5);
  });
  // Fahrwerk
  b.box(0.1, 0.55, 0.1, 0, -0.35, 0.8, DARK, fx);
  b.cyl(0.1, 0.1, 0, -0.62, 0.8, 'x', TIRE, fx, 6);
  b.mirror(() => {
    b.box(0.08, 0.5, 0.08, 0.2, -0.3, -1.6, DARK, fx);
    b.cyl(0.09, 0.08, 0.2, -0.58, -1.6, 'x', TIRE, fx, 6);
  });
  light(b, 14, 0, 0.55, 2.0, 0xff4040, 0.1);
  b.pop();
  return { geom: b.build({ groundAO: 0 }), size: 12, boost: 1.6, livery: 'air', tilt: false, anim: 'air' };
}

export function buildDroneQuad(): ModelDef {
  const b = new ModelBuilder();
  b.box(0.14, 0.06, 0.22, 0, 0.1, 0, HULL, { camo: false, ao: 0.1 });
  b.box(0.09, 0.04, 0.12, 0, 0.15, 0.03, 0x2a2a26, fx); // Akku
  b.box(0.1, 0.02, 0.2, 0, 0.17, 0.0, 0x3a5a8a, fx); // Platine/Akkustreifen
  b.box(0.05, 0.05, 0.05, 0, 0.1, -0.13, 0x1a1a18, fx); // Kamera
  b.cyl(0.02, 0.02, 0, 0.1, -0.16, 'z', GLASS_LIGHT, fx, 5);
  b.box(0.52, 0.02, 0.03, 0, 0.1, 0, 0x1c1c1a, { paint: P_FIXED, rot: [0, Math.PI / 4, 0] });
  b.box(0.52, 0.02, 0.03, 0, 0.1, 0, 0x1c1c1a, { paint: P_FIXED, rot: [0, -Math.PI / 4, 0] });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    b.cyl(0.03, 0.05, sx * 0.18, 0.12, sz * 0.18, 'y', 0x3a3a34, fx, 5);
    b.box(0.04, 0.05, 0.04, sx * 0.18, 0.07, sz * 0.18, 0x2a2a26, fx); // Fahrwerksfuß
  }
  b.cyl(0.05, 0.22, 0, 0.0, -0.01, 'z', 0x7a4a2a, { paint: P_FIXED, edgeColors: [0x7a4a2a, 0x7a4a2a] }, 6, 0.035);
  b.box(0.1, 0.04, 0.05, 0, 0.14, 0.1, 0xffffff, { paint: P_TEAM, ao: 0 });
  b.box(0.008, 0.1, 0.008, 0.05, 0.2, 0.1, 0x161614, fx); // Antennen
  b.box(0.008, 0.1, 0.008, -0.05, 0.2, 0.1, 0x161614, fx);
  light(b, 14, 0, 0.17, 0.12, 0xff4040, 0.03);
  return {
    geom: b.build({ groundAO: 0 }),
    size: 0.5,
    boost: 7,
    rotors: [[0.18, 0.15, 0.18, 0.1], [-0.18, 0.15, 0.18, 0.1], [0.18, 0.15, -0.18, 0.1], [-0.18, 0.15, -0.18, 0.1]],
    livery: 'air',
    tilt: false,
    anim: 'air',
  };
}
