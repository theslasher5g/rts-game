/**
 * Phase 4/5 – Kettenfahrzeuge: Kampfpanzer (3 Stile), leichter Panzer, Schützenpanzer, Panzerhaubitze, Flakpanzer.
 *
 * Jedes Modell wird zweimal gebaut (Hoch-/Niedrigdetail, `b.lo`) und je dreimal mit verschiedenen Tarnmustern
 * (siehe buildVehicleGeoms). Animierte Gruppen (Turm, Rohr, Räder, Kette, Radar) werden per `b.vpart(K_*)` markiert und
 * im Vertex-Shader des Fahrzeugmaterials (UnitRenderer) bewegt.
 */
import type * as THREE from 'three';
import {
  BLACK, buildVehicleGeoms, DARK, GLASS, GLASS_LIGHT, GUN, HULL, HULL_DARK, HULL_LIGHT, K_GUN, K_RADAR, K_STATIC, K_TRACK, K_TURRET, K_WHEEL,
  ModelBuilder, P_CAMO, P_FIXED, P_TEAM, RUBBER, STEEL, type AnimSpec, type ModelDef, type V3,
} from './geomUtils';

export type TankStyle = 'abrams' | 'west' | 'ru';

const HUB = 0x5a5a52;
const HUB_L = 0x8a8a7c;
const TRACK_C = 0x403f36;
const OLIVE = 0x4f5a3c;
const SAND = 0x7a6e4a;
const CANVAS = 0x6b6a4a;
const NET = 0x56603f;
const JERRY = 0x5c6038;
const LAMP = 0xe8e0a0;
const TAIL = 0x9a2020;
const ERA_C = 0x6e7064;

// ------------------------------------------------------------------------------------------------ Animationsprofile

export const ANIM_MBT: AnimSpec = { turretRate: 0.85, elevRate: 0.5, elevMode: 'direct', elevRest: 0.02, elevMax: 0.12, recoil: 0.5, radarRate: 0, bob: 0.03 };
export const ANIM_LIGHT: AnimSpec = { turretRate: 1.0, elevRate: 0.6, elevMode: 'direct', elevRest: 0.02, elevMax: 0.12, recoil: 0.4, radarRate: 0, bob: 0.03 };
export const ANIM_IFV: AnimSpec = { turretRate: 1.2, elevRate: 0.8, elevMode: 'direct', elevRest: 0.02, elevMax: 0.5, recoil: 0.08, radarRate: 0, bob: 0.035 };
export const ANIM_SPG: AnimSpec = { turretRate: 0.5, elevRate: 0.45, elevMode: 'indirect', elevRest: 0.03, elevMax: 1.15, recoil: 0.8, radarRate: 0, bob: 0.03 };
export const ANIM_SPAA: AnimSpec = { turretRate: 1.6, elevRate: 1.2, elevMode: 'aa', elevRest: 0.12, elevMax: 1.2, recoil: 0.15, radarRate: 4.5, bob: 0.03 };

/** ModelDef eines animierten Fahrzeugs (mit Low-Detail-Variante `lod`) */
export function vdef(geom: THREE.BufferGeometry, lo: THREE.BufferGeometry, vanim: AnimSpec, size: number): ModelDef {
  return { geom, size, boost: 1, livery: 'ground', tilt: true, vanim, lod: { geom: lo, size, boost: 1, livery: 'ground', tilt: true, vanim } };
}

// ------------------------------------------------------------------------------------------------ Bauteile (auch von vehicles.ts genutzt)

/** Luke mit Ring, Deckel, Griff und Sehschlitzen */
export function hatch(b: ModelBuilder, x: number, y: number, z: number, r: number, rotY = 0, open = false): void {
  b.lathe([[r, 0], [r * 0.92, 0.2], [0, 0.22]], 'y', x, y, z, HULL, { seg: 7, ao: 0.15 });
  if (b.lo) return;
  b.lathe([[r * 1.02, 0.08], [r * 1.01, 0.16]], 'y', x, y, z, GLASS, { seg: 7, paint: P_FIXED, ao: 0, both: true });
  b.box(r * 1.2, 0.04, 0.05, x, y + 0.27, z, DARK, { paint: P_FIXED, rot: [0, rotY, 0] }); // Griff
  b.box(0.05, 0.08, 0.05, x - r * 0.55, y + 0.24, z, DARK, { paint: P_FIXED });
  b.box(0.05, 0.08, 0.05, x + r * 0.55, y + 0.24, z, DARK, { paint: P_FIXED });
  if (open) b.box(r * 1.5, 0.06, r * 1.5, x, y + 0.5, z + r * 0.9, HULL_DARK, { rot: [0.9, 0, 0] });
}

/** Panoramasichtgerät / Optikkopf (Kasten mit Glasfenstern) */
export function sight(b: ModelBuilder, x: number, y: number, z: number, w = 0.34, h = 0.28, l = 0.4): void {
  b.box(w, h, l, x, y, z, HULL_DARK, { camo: 1 });
  if (b.lo) return;
  b.box(w * 0.7, h * 0.45, 0.05, x, y + h * 0.1, z - l / 2 - 0.01, GLASS_LIGHT, { paint: P_FIXED, ao: 0 });
  b.box(w * 0.2, 0.1, 0.12, x + w * 0.3, y + h / 2 + 0.04, z, DARK, { paint: P_FIXED });
}

/** Antenne mit Sockel (Isolator) */
export function antenna(b: ModelBuilder, x: number, y: number, z: number, h: number, lean = 0): void {
  if (!b.lo) {
    b.cyl(0.07, 0.16, x, y + 0.08, z, 'y', DARK, { paint: P_FIXED }, 5, 0.05);
    b.cyl(0.05, 0.22, x, y + 0.27, z, 'y', 0x3a3a34, { paint: P_FIXED }, 5, 0.04);
  }
  b.cyl(0.026, h, x, y + 0.35 + h / 2, z, 'y', DARK, { paint: P_FIXED, rot: [0, 0, lean] }, 4, 0.012);
}

/** Kanister (Jerrycan) */
export function jerry(b: ModelBuilder, x: number, y: number, z: number, rotY = 0, color = JERRY): void {
  b.box(0.36, 0.5, 0.17, x, y, z, color, { paint: P_FIXED, rot: [0, rotY, 0], ao: 0.2 });
  b.box(0.12, 0.08, 0.1, x, y + 0.29, z, DARK, { paint: P_FIXED, rot: [0, rotY, 0] });
}

/** Gepäcksack / Plane (weiche Form) */
export function bag(b: ModelBuilder, x: number, y: number, z: number, w: number, h: number, l: number, color = CANVAS, rotY = 0): void {
  b.box(w, h, l, x, y, z, color, { paint: P_FIXED, top: [0.82, 0.86], rot: [0, rotY, 0], ao: 0.25 });
  if (!b.lo) b.box(w * 1.02, 0.04, l * 0.1, x, y + h * 0.05, z, DARK, { paint: P_FIXED, rot: [0, rotY, 0] }); // Gurt
}

/** Reihe kleiner Panzerungsbolzen */
export function bolts(b: ModelBuilder, x: number, y: number, z: number, n: number, step: number, axis: 'x' | 'z', s = 0.06): void {
  if (b.lo) return;
  for (let i = 0; i < n; i++) {
    const o = (i - (n - 1) / 2) * step;
    b.box(s, s, s, axis === 'x' ? x + o : x, y, axis === 'z' ? z + o : z, STEEL, { paint: P_FIXED, ao: 0 });
  }
}

/** Nebelmittelwurfanlage: n Rohre in einer Reihe, nach außen geneigt */
export function smokeLaunchers(b: ModelBuilder, x: number, y: number, z: number, n: number, tilt: number): void {
  b.box(0.1, 0.12, n * 0.13 + 0.06, x, y - 0.06, z, DARK, { paint: P_FIXED });
  if (b.lo) return;
  for (let i = 0; i < n; i++) b.cyl(0.05, 0.28, x, y + 0.08, z + (i - (n - 1) / 2) * 0.13, 'y', DARK, { paint: P_FIXED, rot: [0, 0, tilt] }, 5);
}

export function lampPair(b: ModelBuilder, y: number, z: number, x: number, color = LAMP, dir: 1 | -1 = -1): void {
  b.mirror(() => {
    b.box(0.22, 0.16, 0.12, x, y, z, DARK, { paint: P_FIXED, ao: 0 });
    b.plateFront(0.16, 0.1, x, y, z + 0.07 * dir, dir, color);
  });
}

function toolbox(b: ModelBuilder, x: number, y: number, z: number, w = 0.55, l = 0.3): void {
  b.box(w, 0.28, l, x, y, z, HULL_DARK, { camo: 1 });
  if (!b.lo) b.box(0.08, 0.06, 0.04, x, y + 0.1, z - l / 2 - 0.02, STEEL, { paint: P_FIXED });
}

/** Tarnnetz-Wickel / Plane auf Heck (weiche Wulst) */
function netRoll(b: ModelBuilder, x: number, y: number, z: number, len: number): void {
  b.cyl(0.2, len, x, y, z, 'x', NET, { paint: P_FIXED, ao: 0.2 }, 6);
  if (!b.lo) for (const o of [-0.35, 0.35]) b.box(0.05, 0.42, 0.05, x + o * len * 0.5, y, z, DARK, { paint: P_FIXED });
}

/** Rad mit Reifen, Nabe und Radmuttern; animiert (K_WHEEL). xw = Mitte, Nabe zeigt nach +x. */
export function roadWheel(b: ModelBuilder, xw: number, y: number, z: number, R: number, w: number, seg: number, tire = RUBBER, lugs = 5): void {
  b.vpart(K_WHEEL, y, z, R);
  const hub = b.lo ? 0 : 1;
  b.lathe(
    hub ? [[R, -w / 2], [R, w / 2], [R * 0.64, w / 2], [R * 0.36, w / 2 + 0.035], [0, w / 2 + 0.06]] : [[R, -w / 2], [R, w / 2], [0, w / 2 + 0.05]],
    'x', xw, y, z, tire, { paint: P_FIXED, seg, edgeColors: hub ? [tire, 0x34342e, HUB, HUB_L] : [tire, HUB], ao: 0.1 },
  );
  if (hub) {
    const xf = xw + w / 2 + 0.032;
    for (let k = 0; k < lugs; k++) {
      const a = (k / lugs) * Math.PI * 2;
      b.plateSide(0.07, 0.07, xf, y + Math.sin(a) * R * 0.5, z + Math.cos(a) * R * 0.5, 1, 0xb8b8a8);
    }
  }
  b.vpart(K_STATIC);
}

// ------------------------------------------------------------------------------------------------ Laufwerk

interface GearOpts {
  x: number;
  zFront: number;
  zRear: number;
  nWheels: number;
  rWheel: number;
  wheelW: number;
  beltW: number;
  beltTop: number;
  rollers: number;
  skirt?: { z0: number; z1: number; y0: number; y1: number };
  rSprocket?: number;
  /** Gummischürze (T-90): durchgehende dunkle Platte statt gestaffelter Panzerplatten */
  rubber?: boolean;
}

/** Laufwerk einer Seite (x > 0 gebaut, per mirror gespiegelt) */
export function gear(b: ModelBuilder, g: GearOpts): void {
  const L = b.lo;
  const rS = g.rSprocket ?? 0.46;
  const yW = g.rWheel + 0.05;
  const zF = g.zFront, zR = g.zRear;
  const xw = g.x + g.beltW / 2 - 0.08;
  b.vpart(K_TRACK, (0.02 + g.beltTop) / 2);
  b.extrudeX(
    [[zF + 0.1, 0.02], [zR - 0.15, 0.02], [zR + 0.1, 0.55], [zR - 0.1, g.beltTop - 0.05], [zR - 0.5, g.beltTop], [zF + 0.5, g.beltTop], [zF - 0.05, 0.55]],
    g.beltW, g.x, 0, 0, TRACK_C, { paint: P_FIXED, ao: 0.35 },
  );
  b.vpart(K_STATIC);
  if (!L) {
    // Laufrollen (animiert)
    const span = (zR - 0.9) - (zF + 0.9);
    for (let i = 0; i < g.nWheels; i++) {
      roadWheel(b, xw, yW, zF + 0.95 + (span * i) / Math.max(1, g.nWheels - 1), g.rWheel, g.wheelW, 7);
    }
    // Leitrad vorn, Treibrad hinten
    roadWheel(b, xw, 0.5, zF + 0.3, 0.42, g.wheelW, 8, RUBBER, 6);
    roadWheel(b, xw, 0.58, zR - 0.15, rS, g.wheelW, 9, 0x3a3a34, 7);
    // Stützrollen
    for (let i = 0; i < g.rollers; i++) {
      const z = zF + 1.3 + ((zR - zF - 2.6) * i) / Math.max(1, g.rollers - 1);
      b.vpart(K_WHEEL, g.beltTop - 0.12, z, 0.14);
      b.lathe([[0.14, -0.08], [0.14, 0.08], [0, 0.09]], 'x', g.x + g.beltW / 2 - 0.05, g.beltTop - 0.12, z, RUBBER, { paint: P_FIXED, seg: 5 });
      b.vpart(K_STATIC);
    }
    // Achsarme / Federung sichtbar zwischen Rädern und Wanne
    b.box(0.08, 0.1, zR - zF - 1.4, g.x - g.beltW / 2 - 0.02, g.rWheel + 0.35, (zF + zR) / 2, DARK, { paint: P_FIXED });
  }
  if (g.skirt) {
    const s = g.skirt;
    const xs = g.x + g.beltW / 2 + 0.12;
    const Ls = s.z1 - s.z0;
    const n = L ? 1 : Math.max(2, Math.round(Ls / 1.1));
    for (let i = 0; i < n; i++) {
      const pl = Ls / n;
      const zc = s.z0 + pl * (i + 0.5);
      if (g.rubber) b.box(0.07, s.y1 - s.y0, pl - 0.03, xs, (s.y0 + s.y1) / 2, zc, 0x2c2c28, { paint: P_FIXED, ao: 0.3 });
      else b.box(0.1, s.y1 - s.y0 - (i % 2 ? 0.06 : 0), pl - 0.04, xs + (i % 2 ? 0.01 : 0), (s.y0 + s.y1) / 2, zc, HULL, { camo: 0.8, ao: 0.28 });
      if (!L) {
        // Befestigungsschrauben + Aufhängeleiste
        b.box(0.05, 0.06, 0.06, xs + 0.06, s.y1 - 0.12, zc - pl * 0.3, STEEL, { paint: P_FIXED, ao: 0 });
        b.box(0.05, 0.06, 0.06, xs + 0.06, s.y1 - 0.12, zc + pl * 0.3, STEEL, { paint: P_FIXED, ao: 0 });
      }
    }
    if (!L) {
      b.box(0.08, 0.07, Ls, xs, s.y1 + 0.02, (s.z0 + s.z1) / 2, DARK, { paint: P_FIXED });
      // Kotflügel-Klappen vorn/hinten, Staukästen
      b.box(0.8, 0.06, 0.7, xs - 0.1, s.y1 - 0.15, s.z0 - 0.15, HULL_DARK, { rot: [0.35, 0, 0], camo: 1 });
      b.box(0.8, 0.5, 0.05, xs - 0.1, 0.9, zR + 0.25, 0x2c2c28, { paint: P_FIXED }); // Schmutzfänger hinten
    }
    b.box(0.55, 0.07, Ls + 0.3, g.x + 0.05, s.y1 + 0.03, (s.z0 + s.z1) / 2, HULL_DARK, { camo: 1 });
  }
}

function gearBoth(b: ModelBuilder, g: GearOpts): void {
  b.mirror(() => gear(b, g));
}

// ------------------------------------------------------------------------------------------------ Kanone

/** Kanone: Drehpunkt = lokaler Ursprung, entlang −z. Gesamter Rohrverband (K_GUN) – Aufrufer setzt b.vpart(K_GUN, …). */
function mainGun(b: ModelBuilder, style: TankStyle, len: number, r: number): void {
  const R = r;
  const L = b.lo;
  b.cyl(R * 1.15, len * 0.45, 0, 0, -len * 0.225, 'z', GUN, { paint: P_FIXED }, L ? 5 : 7, R * 1.05);
  b.cyl(R, len * 0.55, 0, 0, -len * 0.45 - len * 0.275, 'z', GUN, { paint: P_FIXED }, L ? 5 : 7, R * 0.92);
  if (style === 'west') {
    b.cyl(R * 1.3, len * 0.42, 0, 0, -len * 0.55, 'z', 0x7a7a72, { paint: P_FIXED }, L ? 5 : 7, R * 1.3); // Wärmeschutzmantel
    if (!L) {
      for (const f of [0.38, 0.55, 0.72]) b.cyl(R * 1.42, 0.07, 0, 0, -len * f, 'z', 0x5a5a52, { paint: P_FIXED }, 7); // Manschetten
      b.box(0.12, 0.1, 0.16, 0, R * 1.5, -len * 0.92, DARK, { paint: P_FIXED }); // Rohrbiegesensor / Referenzspiegel
    }
  } else {
    b.cyl(R * 1.55, 0.75, 0, 0, -len * 0.55, 'z', 0x7a7a72, { paint: P_FIXED }, L ? 5 : 7, R * 1.55); // Rauchabsauger
    if (!L) {
      b.cyl(R * 1.3, 0.55, 0, 0, -len * 0.3, 'z', 0x6a6a62, { paint: P_FIXED }, 6);
      if (style === 'ru') b.cyl(R * 1.1, 0.18, 0, 0, -len * 0.84, 'z', 0x5a5a52, { paint: P_FIXED }, 6);
    }
  }
  if (style === 'ru') b.cyl(R * 1.25, 0.28, 0, 0, -len + 0.14, 'z', 0x6a6a62, { paint: P_FIXED }, L ? 5 : 7, R * 1.25);
  else b.cyl(R * 1.2, 0.2, 0, 0, -len + 0.1, 'z', 0x6a6a62, { paint: P_FIXED }, L ? 5 : 7, R * 1.2);
  b.cyl(R * 0.5, 0.05, 0, 0, -len - 0.01, 'z', BLACK, { paint: P_FIXED }, 4, R * 0.5);
  if (!L) {
    // Koax-MG seitlich der Blende
    b.cyl(0.03, 0.8, -0.28, -0.05, -0.55, 'z', DARK, { paint: P_FIXED }, 4);
  }
}

// ------------------------------------------------------------------------------------------------ Kampfpanzer

function tankHull(b: ModelBuilder, style: TankStyle): void {
  const L = b.lo;
  if (style === 'west') {
    gearBoth(b, { x: 1.5, zFront: -3.55, zRear: 3.7, nWheels: 7, rWheel: 0.4, wheelW: 0.34, beltW: 0.6, beltTop: 1.0, rollers: 3, skirt: { z0: -2.5, z1: 3.3, y0: 0.7, y1: 1.5 } });
    b.extrudeX([[-3.5, 0.55], [3.9, 0.55], [3.9, 1.35], [3.3, 1.55], [-2.3, 1.6], [-3.85, 1.0]], 2.9, 0, 0, 0, HULL, { camo: 0.9, taper: [1, 0.94] });
    b.box(2.7, 0.2, 0.3, 0, 0.85, -3.75, HULL_DARK, { camo: 1 });
    if (L) return;
    // oberes Glacis: Fahrerluke, Aufsatz, Abschleppseile / Haken, Frontlampen, Spurplatten
    hatch(b, -0.75, 1.62, -2.35, 0.3, 0, false);
    sight(b, -0.75, 1.82, -2.7, 0.3, 0.14, 0.22);
    b.box(0.8, 0.1, 0.7, 0.2, 1.63, -2.4, HULL_DARK, { camo: 1 });
    for (const s of [-1, 1]) b.cyl(0.035, 3.6, s * 0.9, 1.67, -1.9, 'z', DARK, { paint: P_FIXED, rot: [-0.13, 0, 0] }, 4);
    for (const s of [-1, 1]) {
      b.box(0.18, 0.18, 0.2, s * 1.2, 0.8, -3.9, STEEL, { paint: P_FIXED });
      b.box(0.1, 0.1, 0.26, s * 0.95, 1.35, -3.5, STEEL, { paint: P_FIXED });
    }
    lampPair(b, 1.5, -3.62, 1.3);
    b.box(1.2, 0.3, 0.06, 0, 1.05, -3.9, HULL_DARK, { rot: [0.3, 0, 0], camo: 1 }); // Bugwellenabweiser
    bolts(b, 0, 0.98, -3.88, 8, 0.32, 'x');
    // Ersatzketten-Reihe am Bug
    for (let i = 0; i < 7; i++) b.box(0.28, 0.06, 0.16, -0.9 + i * 0.3, 1.27, -3.4, TRACK_C, { paint: P_FIXED, rot: [-0.6, 0, 0] });
    // Motorraum: Gitter + Abluft + Auspuffblenden
    b.box(2.0, 0.05, 2.2, 0, 1.62, 2.55, 0x4a4a44, { paint: P_FIXED });
    for (let i = 0; i < 7; i++) b.box(1.9, 0.07, 0.07, 0, 1.67, 1.5 + i * 0.33, 0x6a6a62, { paint: P_FIXED });
    b.box(2.3, 0.7, 0.2, 0, 1.0, 3.95, HULL_DARK, { camo: 1 });
    for (const s of [-1, 1]) {
      b.box(0.45, 0.35, 0.12, s * 0.8, 1.15, 4.08, 0x2c2c28, { paint: P_FIXED }); // Auspuffe
      b.box(0.1, 0.1, 0.3, s * 1.1, 0.6, 4.1, STEEL, { paint: P_FIXED }); // Abschleppöse hinten
      b.box(0.14, 0.1, 0.05, s * 1.0, 1.4, 4.0, TAIL, { paint: P_FIXED, ao: 0 });
    }
    b.box(0.9, 0.5, 0.7, -0.9, 1.9, 3.1, HULL_DARK, { camo: 0.8 });
    b.box(0.9, 0.45, 0.7, 0.9, 1.85, 3.1, HULL_LIGHT, { camo: 0.8 });
    toolbox(b, -1.6, 1.58, -1.0);
    toolbox(b, 1.65, 1.58, 0.6, 0.5, 0.7);
    b.cyl(0.14, 0.9, 1.7, 1.75, -0.6, 'z', 0x8a2a20, { paint: P_FIXED }, 5); // Feuerlöscher
    bag(b, -0.2, 1.85, 3.1, 0.7, 0.3, 0.45, SAND);
  } else if (style === 'abrams') {
    gearBoth(b, { x: 1.62, zFront: -3.7, zRear: 3.85, nWheels: 7, rWheel: 0.4, wheelW: 0.34, beltW: 0.62, beltTop: 1.0, rollers: 4, skirt: { z0: -2.8, z1: 3.5, y0: 0.7, y1: 1.5 } });
    b.extrudeX([[-3.55, 0.55], [3.95, 0.55], [3.95, 1.3], [3.4, 1.5], [-2.0, 1.52], [-3.85, 0.95]], 3.0, 0, 0, 0, HULL, { camo: 0.9, taper: [1, 0.95] });
    b.box(2.9, 0.18, 0.4, 0, 0.9, -3.8, HULL_DARK, { camo: 1 });
    if (L) return;
    hatch(b, 0, 1.52, -2.55, 0.3);
    sight(b, 0, 1.75, -2.9, 0.34, 0.14, 0.22);
    b.box(0.9, 0.12, 0.6, 0, 1.58, -2.4, HULL_DARK, { camo: 1 });
    for (const s of [-1, 1]) b.cyl(0.035, 3.0, s * 1.0, 1.52, -2.6, 'z', DARK, { paint: P_FIXED, rot: [-0.1, 0, 0] }, 4);
    lampPair(b, 1.4, -3.78, 1.25);
    lampPair(b, 1.2, -3.82, 0.45, 0xd0c080);
    for (const s of [-1, 1]) {
      b.box(0.2, 0.2, 0.24, s * 1.3, 0.75, -3.95, STEEL, { paint: P_FIXED });
      b.box(0.3, 0.16, 0.06, s * 1.0, 1.55, -3.55, HULL_DARK, { camo: 1 });
    }
    bolts(b, 0, 1.0, -3.97, 9, 0.3, 'x');
    // Turbinen-Abluftgitter groß + seitliche Lufteinlässe
    b.box(2.4, 0.05, 2.5, 0, 1.55, 2.6, 0x4a4a44, { paint: P_FIXED });
    for (let i = 0; i < 8; i++) b.box(2.3, 0.07, 0.08, 0, 1.6, 1.45 + i * 0.32, 0x6a6a62, { paint: P_FIXED });
    b.box(2.6, 0.5, 0.2, 0, 0.95, 4.0, HULL_DARK, { camo: 1 });
    b.box(1.2, 0.3, 0.1, 0, 1.3, 4.03, 0x2c2c28, { paint: P_FIXED });
    for (const s of [-1, 1]) {
      b.box(0.16, 0.12, 0.05, s * 1.2, 1.2, 4.08, TAIL, { paint: P_FIXED, ao: 0 });
      b.box(0.14, 0.14, 0.22, s * 1.3, 0.55, 4.1, STEEL, { paint: P_FIXED });
    }
    toolbox(b, -1.7, 1.58, -1.3, 0.5, 0.9);
    toolbox(b, 1.7, 1.58, -0.8, 0.5, 0.7);
    jerry(b, 1.75, 1.82, 1.1, 0.2);
    jerry(b, 1.75, 1.82, 1.4, -0.1);
    jerry(b, -1.75, 1.82, 1.2, 0.1, SAND);
    b.cyl(0.14, 0.9, -1.75, 1.75, 0.4, 'z', 0x8a2a20, { paint: P_FIXED }, 5);
  } else {
    // ru (T-90): kürzer, flacher; Gummischürzen vorn
    gearBoth(b, { x: 1.45, zFront: -3.2, zRear: 3.45, nWheels: 6, rWheel: 0.42, wheelW: 0.3, beltW: 0.58, beltTop: 1.0, rollers: 3, skirt: { z0: -3.0, z1: -0.6, y0: 0.75, y1: 1.4 }, rubber: true });
    b.extrudeX([[-3.1, 0.55], [3.55, 0.55], [3.55, 1.2], [3.0, 1.38], [-1.9, 1.42], [-3.4, 0.85]], 2.7, 0, 0, 0, HULL, { camo: 0.9, taper: [1, 0.92] });
    for (const s of [-1, 1]) b.box(0.5, 0.06, 6.0, s * 1.5, 1.4, 0.2, HULL_DARK, { camo: 1 });
    // Dachwanne: Wellenabweiser vorn
    b.box(2.2, 0.28, 0.12, 0, 1.55, -2.3, HULL_DARK, { rot: [-0.5, 0, 0] });
    if (L) {
      for (let i = 0; i < 4; i++) b.box(0.5, 0.1, 0.42, -0.75 + i * 0.5, 1.5, -2.7, ERA_C, { paint: P_FIXED, rot: [-0.33, 0, 0] });
      return;
    }
    // ERA-Blöcke am oberen Glacis (2 Reihen) und Bug
    for (let i = 0; i < 6; i++) {
      b.box(0.4, 0.1, 0.42, -1.0 + i * 0.4, 1.5, -2.7, ERA_C, { paint: P_FIXED, rot: [-0.33, 0, 0] });
      b.box(0.34, 0.08, 0.3, -1.0 + i * 0.4, 1.28, -3.1, ERA_C, { paint: P_FIXED, rot: [-0.5, 0, 0] });
      b.box(0.06, 0.06, 0.06, -1.0 + i * 0.4, 1.58, -2.6, STEEL, { paint: P_FIXED });
    }
    hatch(b, -0.7, 1.46, -1.9, 0.3);
    sight(b, -0.7, 1.7, -2.15, 0.28, 0.12, 0.18);
    lampPair(b, 1.3, -3.4, 1.15, 0xe0d8a0);
    for (const s of [-1, 1]) b.box(0.18, 0.18, 0.22, s * 1.0, 0.75, -3.55, STEEL, { paint: P_FIXED });
    // Ersatz-Treibstofffässer + Baumstamm + Schutzblech-Staukästen
    for (const s of [-1, 1]) {
      b.cyl(0.24, 1.4, s * 0.9, 1.7, 2.9, 'z', 0x5a5a50, { paint: P_FIXED }, 7);
      for (const dz of [-0.45, 0.45]) b.box(0.06, 0.5, 0.06, s * 0.9, 1.7, 2.9 + dz, DARK, { paint: P_FIXED });
    }
    b.cyl(0.14, 2.5, 0, 1.98, 3.05, 'x', 0x3a3a30, { paint: P_FIXED }, 6);
    for (const x of [-0.8, 0.8]) b.box(0.06, 0.34, 0.06, x, 1.82, 3.05, DARK, { paint: P_FIXED });
    b.box(2.0, 0.05, 1.7, 0, 1.45, 2.4, 0x4a4a44, { paint: P_FIXED });
    for (let i = 0; i < 5; i++) b.box(1.9, 0.06, 0.07, 0, 1.49, 1.65 + i * 0.34, 0x6a6a62, { paint: P_FIXED });
    b.box(2.4, 0.6, 0.2, 0, 0.95, 3.55, HULL_DARK, { camo: 1 });
    for (const s of [-1, 1]) {
      b.box(0.2, 0.14, 0.05, s * 1.0, 1.15, 3.66, TAIL, { paint: P_FIXED, ao: 0 });
      b.box(0.55, 0.3, 0.9, s * 1.55, 1.58, -0.4, HULL_DARK, { camo: 1 }); // Fendersauer-Kästen
    }
    // Ersatzkette Bug
    for (let i = 0; i < 6; i++) b.box(0.3, 0.06, 0.16, -0.75 + i * 0.3, 1.02, -3.3, TRACK_C, { paint: P_FIXED, rot: [-0.7, 0, 0] });
    bag(b, 1.4, 1.62, 1.8, 0.6, 0.3, 0.8, OLIVE);
  }
}

function turret(b: ModelBuilder, style: TankStyle, heavy: boolean): void {
  const L = b.lo;
  if (style === 'west') {
    // Leopard-2-artig: kantig, flache Dachpartie, Keilpanzerung
    b.lathe([[0, 0], [1.35, 0], [1.4, 0.18], [0, 0.18]], 'y', 0, 1.55, -0.2, HULL_DARK, { seg: L ? 8 : 12, ao: 0.1 });
    const tz = -0.2;
    b.vpart(K_TURRET, 0, tz, tz);
    b.extrudeX([[-2.0, 1.7], [-1.55, 2.45], [1.0, 2.5], [1.7, 2.35], [1.9, 2.0], [1.9, 1.7]], 2.5, 0, 0, 0, HULL, { camo: 0.8, taper: [1, 0.84] });
    b.mirror(() => {
      b.extrudeX([[-2.35, 1.8], [-1.6, 2.35], [-0.6, 2.35], [-0.6, 1.8]], 0.55, 1.45, 0, 0, HULL_LIGHT, { camo: 0.8, taper: [1, 0.7] });
      b.extrudeX([[-0.2, 1.8], [1.6, 1.8], [1.6, 2.25], [-0.2, 2.3]], 0.28, 1.4, 0, 0.2, HULL, { camo: 0.8 });
    });
    b.box(2.6, 0.9, 0.9, 0, 2.05, 2.3, HULL, { camo: 0.8, top: [0.92, 1] }); // Heck
    if (!L) {
      // Blende / Bolzenreihen / Haken
      bolts(b, 0, 2.55, -1.2, 9, 0.28, 'x');
      b.mirror(() => {
        bolts(b, 1.2, 2.42, -1.5, 5, 0.3, 'z');
        b.box(0.5, 0.36, 0.9, 1.1, 2.2, -1.75, HULL_LIGHT, { camo: 0.6, rot: [0, 0.35, 0] }); // Keilplatten Front
        antenna(b, 1.05, 2.28, 2.0, 3.0, 0.03);
        smokeLaunchers(b, 1.45, 2.3, -1.2, 4, -0.3);
        smokeLaunchers(b, 1.45, 2.3, -0.5, 4, -0.3);
        b.box(0.08, 0.08, 0.2, 1.3, 2.55, 0.3, STEEL, { paint: P_FIXED }); // Transportöse
        b.box(0.5, 0.6, 0.5, 1.1, 2.85, 2.3, HULL_DARK, { camo: 1 });
      });
      // Optiken: Kommandant (rechts, Panorama), Richtschütze (links vorn), Lader
      sight(b, 0.6, 2.62, -0.95, 0.46, 0.26, 0.55);
      sight(b, -0.55, 2.58, -1.25, 0.3, 0.2, 0.3);
      hatch(b, 0.75, 2.5, 0.35, 0.36, 0, true);
      periscopeRing(b, 0.75, 2.78, 0.35, 0.4);
      b.box(0.3, 0.22, 0.3, 0.7, 2.95, -0.05, BLACK, { paint: P_FIXED, ao: 0 });
      hatch(b, -0.65, 2.45, 0.8, 0.34, 0.3, false);
      mgPintle(b, -0.65, 2.7, 0.65);
      netRoll(b, 0, 2.7, 2.65, 1.8);
      bag(b, -0.4, 2.65, 2.0, 0.6, 0.3, 0.5, SAND);
      b.box(1.5, 0.05, 0.6, -0.1, 2.52, 1.4, 0xffffff, { paint: P_TEAM, ao: 0 });
      b.box(2.55, 0.18, 0.35, 0, 1.78, 3.45, 0xffffff, { paint: P_TEAM, ao: 0 });
    } else {
      b.box(0.5, 0.2, 0.5, 0.7, 2.6, 0.4, HULL_DARK, { camo: 1 });
    }
    // Rohrblende + Rohr (K_GUN)
    b.vpart(K_GUN, 2.15, -2.45, tz);
    b.box(1.1, 0.75, 0.5, 0, 2.15, -2.2, HULL_DARK, { camo: 1, top: [0.9, 0.9] });
    if (!L) {
      b.box(1.3, 0.55, 0.1, 0, 2.15, -2.5, DARK, { paint: P_FIXED, ao: 0.2 }); // Faltenbalg
      b.box(0.34, 0.2, 0.2, 0.7, 2.28, -2.5, GLASS_LIGHT, { paint: P_FIXED }); // Wärmebildfenster
    }
    b.push(0, 2.15, -2.45, [heavy ? 0.04 : 0.03, 0, 0]);
    mainGun(b, 'west', 6.0, 0.075);
    b.pop();
    b.vpart(K_STATIC);
  } else if (style === 'abrams') {
    b.lathe([[0, 0], [1.4, 0], [1.45, 0.18], [0, 0.18]], 'y', 0, 1.5, 0, HULL_DARK, { seg: L ? 8 : 12, ao: 0.1 });
    const tz = 0;
    b.vpart(K_TURRET, 0, tz, tz);
    b.extrudeX([[-2.55, 1.65], [-2.0, 2.3], [0.8, 2.38], [1.6, 2.3], [1.8, 1.9], [1.8, 1.65]], 2.65, 0, 0, 0, HULL, { camo: 0.8, taper: [1, 0.88] });
    b.mirror(() => {
      b.extrudeX([[-2.7, 1.7], [-1.9, 2.15], [-0.3, 2.2], [-0.3, 1.7]], 0.55, 1.28, 0, 0, HULL_LIGHT, { camo: 0.8, taper: [1, 0.78] });
    });
    b.box(2.9, 0.95, 1.8, 0, 2.05, 2.55, HULL, { camo: 0.8, top: [0.93, 1] }); // Heckkorb
    b.box(2.3, 0.3, 0.8, 0, 2.62, 2.3, HULL_DARK, { camo: 1 });
    if (!L) {
      // Heckkorb-Gitter/Stauraum: Planen und Kisten
      b.box(3.0, 0.08, 1.9, 0, 2.55, 2.6, 0x3a3a34, { paint: P_FIXED });
      bag(b, -0.8, 2.78, 2.7, 0.9, 0.4, 0.9, CANVAS, 0.1);
      bag(b, 0.5, 2.75, 2.8, 0.8, 0.35, 0.8, OLIVE, -0.15);
      b.box(0.5, 0.4, 0.6, 1.1, 2.8, 2.45, SAND, { paint: P_FIXED });
      netRoll(b, 0, 2.95, 3.0, 2.0);
      for (let i = 0; i < 6; i++) b.box(0.05, 0.9, 0.05, -1.35 + i * 0.54, 2.05, 3.5, DARK, { paint: P_FIXED }); // Korbstreben
      bolts(b, 0, 2.28, -2.2, 8, 0.3, 'x');
      b.mirror(() => {
        smokeLaunchers(b, 1.4, 2.25, -1.6, 3, -0.3);
        smokeLaunchers(b, 1.4, 2.25, -1.2, 3, -0.3);
        antenna(b, 1.25, 2.2, 1.7, 3.2, 0.03);
        b.box(0.1, 0.1, 0.2, 1.7, 2.1, 0.4, STEEL, { paint: P_FIXED });
      });
    }
    b.box(1.0, 0.7, 0.5, 0, 2.1, -2.75, HULL_DARK, { camo: 1, top: [0.9, 0.8] });
    // Kommandanten-Waffenstation (CROWS) & Lader-MG
    b.box(0.5, 0.38, 0.5, 0.65, 2.78, 0.2, HULL_DARK, { camo: 1 });
    hatch(b, 0.65, 2.36, 0.25, 0.35, 0, false);
    if (!L) {
      periscopeRing(b, 0.65, 2.52, 0.25, 0.38);
      b.barrel(0.04, 1.0, 0.6, 2.8, 0.0, 0.0, DARK, 4);
      b.box(0.2, 0.18, 0.16, 0.65, 2.95, -0.1, GLASS_LIGHT, { paint: P_FIXED });
      hatch(b, -0.7, 2.3, 0.75, 0.34, 0.3, true);
      mgPintle(b, -0.7, 2.55, 0.6);
      sight(b, 0.55, 2.5, -0.85, 0.3, 0.3, 0.4);
      b.box(1.5, 0.05, 0.7, -0.3, 2.43, 1.2, 0xffffff, { paint: P_TEAM, ao: 0 });
      b.box(2.95, 0.2, 0.35, 0, 1.78, 3.5, 0xffffff, { paint: P_TEAM, ao: 0 });
    }
    b.vpart(K_GUN, 2.1, -3.0, tz);
    b.box(1.8, 0.8, 0.45, 0, 2.1, -2.75, HULL_DARK, { camo: 1, top: [0.9, 0.8] });
    if (!L) b.box(1.4, 0.6, 0.1, 0, 2.1, -3.0, DARK, { paint: P_FIXED, ao: 0.2 });
    b.push(0, 2.1, -3.0, [0.03, 0, 0]);
    mainGun(b, 'abrams', 5.4, 0.07);
    b.pop();
    b.vpart(K_STATIC);
  } else {
    // T-90-artig: niedrig, rund, spitz-ovale Kuppel
    b.lathe([[0, 0], [1.3, 0], [1.34, 0.16], [0, 0.16]], 'y', 0, 1.42, -0.1, HULL_DARK, { seg: L ? 8 : 12, ao: 0.1 });
    const tz = -0.1;
    b.vpart(K_TURRET, 0, tz, tz);
    b.lathe([[0, 0], [1, 0], [1, 0.12], [0.93, 0.42], [0.72, 0.72], [0.42, 0.9], [0, 0.96]], 'y', 0, 1.55, -0.1, HULL, { seg: L ? 8 : 12, squash: [1.3, 1, 1.75], ao: 0.25, camo: false });
    b.mirror(() => {
      b.box(0.9, 0.5, 1.2, 0.8, 2.05, -1.05, HULL, { camo: 0.5, rot: [0, 0.32, 0.0] }); // Backen
    });
    b.box(1.2, 0.5, 0.5, 0, 1.95, -2.0, HULL_DARK, { camo: 1 }); // Blende
    if (!L) {
      // Shtora-Scheinwerfer
      b.box(0.5, 0.38, 0.3, -0.55, 2.2, -1.95, 0x802020, { paint: P_FIXED, ao: 0.1 });
      b.box(0.5, 0.38, 0.3, 0.55, 2.2, -1.95, 0x802020, { paint: P_FIXED, ao: 0.1 });
      for (const sx of [-0.55, 0.55]) b.plateFront(0.3, 0.22, sx, 2.2, -2.11, -1, 0xa04030);
      // ERA-Blöcke Turmfront/Seiten/Dach
      for (let i = 0; i < 5; i++) {
        b.box(0.34, 0.34, 0.14, -1.05 + i * 0.52, 2.38, -1.55, ERA_C, { paint: P_FIXED, rot: [-0.35, 0, 0], ao: 0.1 });
        b.mirror(() => {
          b.box(0.14, 0.34, 0.34, 1.45, 2.05, -0.8 + i * 0.4, ERA_C, { paint: P_FIXED, ao: 0.1 });
          b.box(0.14, 0.28, 0.3, 1.52, 1.78, -0.7 + i * 0.4, ERA_C, { paint: P_FIXED, ao: 0.1 });
        });
      }
      hatch(b, -0.55, 2.38, 0.25, 0.34);
      b.box(0.14, 0.4, 0.14, -0.55, 2.78, 0.25, DARK, { paint: P_FIXED }); // Fla-MG-Sockel
      b.barrel(0.05, 1.0, -0.55, 2.98, 0.0, 0.1, DARK, 4);
      hatch(b, 0.65, 2.25, 0.5, 0.3);
      sight(b, 0.5, 2.55, -0.55, 0.34, 0.2, 0.4);
      sight(b, -0.5, 2.5, -0.9, 0.26, 0.16, 0.26);
      // Rauchwerfer
      b.mirror(() => {
        for (let i = 0; i < 4; i++) b.box(0.12, 0.2, 0.12, 1.2, 2.18, -0.9 + i * 0.22, DARK, { paint: P_FIXED, rot: [0, 0, -0.4] });
        antenna(b, 0.95, 1.9, 1.4, 3.0, 0.03);
      });
      b.box(0.3, 0.26, 0.5, 0, 2.52, 0.1, SAND, { paint: P_FIXED, ao: 0.2 }); // Stauung
      bag(b, -0.2, 2.2, 1.45, 0.9, 0.4, 0.6, OLIVE);
      b.box(1.2, 0.05, 0.6, -0.2, 2.5, 0.8, 0xffffff, { paint: P_TEAM, ao: 0 });
      b.box(2.45, 0.16, 0.3, 0, 1.78, 3.3, 0xffffff, { paint: P_TEAM, ao: 0 });
    } else {
      b.box(0.5, 0.2, 0.5, 0.5, 2.35, 0.2, HULL_DARK, { camo: 1 });
    }
    b.vpart(K_GUN, 2.0, -2.25, tz);
    b.box(1.0, 0.45, 0.3, 0, 2.0, -2.1, HULL_DARK, { camo: 1 });
    b.push(0, 2.0, -2.25, [0.03, 0, 0]);
    mainGun(b, 'ru', 5.2, 0.07);
    b.pop();
    b.vpart(K_STATIC);
  }
  if (heavy) {
    // Zusatzpanzerung: Keilplatten auf der Turmfront (mit dem Turm drehend)
    b.vpart(K_TURRET, 0, style === 'abrams' ? 0 : style === 'west' ? -0.2 : -0.1, style === 'abrams' ? 0 : style === 'west' ? -0.2 : -0.1);
    b.mirror(() => b.box(0.5, 0.45, 0.9, 1.05, 2.2, -1.6, HULL_DARK, { camo: 0.7, top: [0.7, 0.8] }));
    b.vpart(K_STATIC);
  }
}

/** Periskopkranz (kleine Glasblöcke) um eine Luke */
function periscopeRing(b: ModelBuilder, x: number, y: number, z: number, r: number): void {
  if (b.lo) return;
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    b.box(0.1, 0.07, 0.07, x + Math.cos(a) * r, y, z + Math.sin(a) * r, GLASS_LIGHT, { paint: P_FIXED, rot: [0, -a, 0], ao: 0 });
  }
}

export function mgPintle(b: ModelBuilder, x: number, y: number, z: number): void {
  if (b.lo) return;
  b.box(0.1, 0.2, 0.1, x, y, z, DARK, { paint: P_FIXED });
  b.box(0.11, 0.13, 0.4, x, y + 0.14, z - 0.05, DARK, { paint: P_FIXED });
  b.barrel(0.03, 0.7, x, y + 0.14, z - 0.2, 0.04, DARK, 4);
}

export function buildMbt(style: TankStyle, heavy: boolean): ModelDef {
  const k = heavy ? 1.08 : 1;
  const { geom, lo } = buildVehicleGeoms((b) => {
    b.push(0, 0, 0, [0, 0, 0], [k, k, k]);
    tankHull(b, style);
    turret(b, style, heavy);
    b.pop();
  }, { groundAO: 0.32, groundH: 0.9 });
  return vdef(geom, lo, ANIM_MBT, heavy ? 10.2 : 9.5);
}

// ------------------------------------------------------------------------------------------------ leichter Kampfpanzer

export function buildLightTank(): ModelDef {
  const { geom, lo } = buildVehicleGeoms((b) => {
    const L = b.lo;
    b.mirror(() => gear(b, { x: 1.3, zFront: -3.0, zRear: 3.2, nWheels: 6, rWheel: 0.34, wheelW: 0.28, beltW: 0.5, beltTop: 0.85, rollers: 2, rSprocket: 0.4, skirt: { z0: -2.3, z1: 2.8, y0: 0.6, y1: 1.3 } }));
    b.extrudeX([[-2.9, 0.45], [3.2, 0.45], [3.2, 1.15], [2.7, 1.3], [-1.8, 1.32], [-3.2, 0.85]], 2.4, 0, 0, 0, HULL, { camo: 0.9, taper: [1, 0.92] });
    b.box(1.9, 0.05, 1.6, 0, 1.33, 2.4, 0x4a4a44, { paint: P_FIXED });
    if (!L) {
      hatch(b, -0.5, 1.34, -2.1, 0.27);
      sight(b, -0.5, 1.58, -2.4, 0.26, 0.12, 0.18);
      for (let i = 0; i < 5; i++) b.box(1.8, 0.06, 0.07, 0, 1.38, 1.7 + i * 0.3, 0x6a6a62, { paint: P_FIXED });
      lampPair(b, 1.2, -3.15, 1.0);
      b.mirror(() => {
        b.box(0.16, 0.16, 0.2, 0.9, 0.65, -3.3, STEEL, { paint: P_FIXED });
        b.box(0.14, 0.1, 0.05, 0.9, 1.1, 3.25, TAIL, { paint: P_FIXED, ao: 0 });
        toolbox(b, 1.45, 1.4, -0.6, 0.4, 0.7);
      });
      bolts(b, 0, 0.9, -3.17, 7, 0.3, 'x');
      jerry(b, -1.45, 1.6, 1.4, 0.1);
      jerry(b, -1.45, 1.6, 1.7, -0.1, SAND);
      bag(b, 0.4, 1.55, 2.2, 0.8, 0.35, 0.5, CANVAS);
    }
    // Turm (flach, Kanone 105/120)
    b.lathe([[0, 0], [1.1, 0], [1.14, 0.14], [0, 0.14]], 'y', 0, 1.3, 0.3, HULL_DARK, { seg: L ? 8 : 10, ao: 0.1 });
    b.vpart(K_TURRET, 0, 0.3, 0.3);
    b.extrudeX([[-1.8, 1.42], [-1.3, 1.98], [0.9, 2.0], [1.5, 1.85], [1.55, 1.42]], 2.1, 0, 0, 0.2, HULL, { camo: 0.8, taper: [1, 0.8] });
    hatch(b, 0.55, 2.0, 0.5, 0.3);
    hatch(b, -0.55, 1.95, 0.7, 0.28);
    if (!L) {
      periscopeRing(b, 0.55, 2.2, 0.5, 0.33);
      sight(b, 0.5, 2.15, -0.7, 0.3, 0.25, 0.35);
      mgPintle(b, -0.55, 2.2, 0.6);
      bolts(b, 0, 1.98, -1.6, 7, 0.28, 'x');
      b.mirror(() => {
        smokeLaunchers(b, 1.3, 1.78, -1.0, 3, -0.3);
        antenna(b, 0.85, 1.9, 1.5, 2.4, 0.03);
        b.box(0.4, 0.5, 0.5, 1.0, 2.0, 1.5, HULL_DARK, { camo: 1 });
      });
      netRoll(b, 0, 2.2, 1.95, 1.4);
      b.box(1.3, 0.05, 0.6, 0, 2.02, 0.9, 0xffffff, { paint: P_TEAM, ao: 0 });
      b.box(2.3, 0.14, 0.3, 0, 1.25, 3.2, 0xffffff, { paint: P_TEAM, ao: 0 });
    }
    b.vpart(K_GUN, 1.72, -2.1, 0.3);
    b.box(0.9, 0.55, 0.4, 0, 1.72, -1.9, HULL_DARK, { camo: 1 });
    b.push(0, 1.72, -2.1, [0.03, 0, 0]);
    b.cyl(0.095, 1.2, 0, 0, -0.6, 'z', 0x7a7a72, { paint: P_FIXED }, L ? 5 : 7);
    b.cyl(0.08, 3.5, 0, 0, -1.2 - 1.75, 'z', GUN, { paint: P_FIXED }, L ? 5 : 7, 0.07);
    if (!L) b.cyl(0.12, 0.7, 0, 0, -2.9, 'z', 0x7a7a72, { paint: P_FIXED }, 6);
    b.cyl(0.11, 0.3, 0, 0, -4.5, 'z', 0x6a6a62, { paint: P_FIXED }, L ? 5 : 7);
    b.pop();
    b.vpart(K_STATIC);
  }, { groundAO: 0.32, groundH: 0.9 });
  return vdef(geom, lo, ANIM_LIGHT, 7);
}

// ------------------------------------------------------------------------------------------------ Schützenpanzer

export function buildIfv(style: TankStyle): ModelDef {
  const ru = style === 'ru';
  const { geom, lo } = buildVehicleGeoms((b) => {
    const L = b.lo;
    b.mirror(() => gear(b, { x: 1.4, zFront: -3.3, zRear: 3.5, nWheels: 6, rWheel: 0.36, wheelW: 0.3, beltW: 0.55, beltTop: 0.95, rollers: 3, rSprocket: 0.42, skirt: ru ? { z0: -2.4, z1: 1.2, y0: 0.7, y1: 1.4 } : { z0: -2.6, z1: 3.1, y0: 0.65, y1: 1.45 } }));
    // Wanne, hinten hoch (Mannschaftsraum), Bugkeil
    b.extrudeX([[-3.2, 0.5], [3.5, 0.5], [3.5, 1.9], [3.1, 2.1], [-0.8, 2.15], [-2.3, 1.55], [-3.4, 1.05]], 2.7, 0, 0, 0, HULL, { camo: 0.9, taper: [1, 0.9] });
    if (!L) {
      hatch(b, -0.75, 1.55, -2.1, 0.3, 0, false);
      sight(b, -0.75, 1.8, -2.4, 0.3, 0.14, 0.2);
      for (let i = 0; i < 2; i++) {
        hatch(b, i === 0 ? -0.55 : 0.55, 2.15, 1.5 + i * 1.2, 0.34, 0, true);
        b.box(0.8, 0.06, 0.8, i === 0 ? -0.55 : 0.55, 2.12, 1.5 + i * 1.2, HULL_DARK, { camo: 1 });
      }
      // Heckrampe/-tür mit Fugen + Auspuffgitter + Lampen
      b.box(2.2, 1.2, 0.06, 0, 1.3, 3.54, HULL_DARK, { camo: 0.8 });
      b.box(0.06, 1.1, 0.04, 0, 1.3, 3.58, DARK, { paint: P_FIXED });
      b.box(1.8, 0.08, 0.08, 0, 2.1, 3.5, DARK, { paint: P_FIXED });
      for (const s of [-1, 1]) {
        b.box(0.14, 0.1, 0.05, s * 1.1, 1.0, 3.58, TAIL, { paint: P_FIXED, ao: 0 });
        b.box(0.16, 0.14, 0.2, s * 1.0, 0.7, -3.5, STEEL, { paint: P_FIXED });
        toolbox(b, s * 1.5, 1.5, 0.0, 0.4, 0.8);
      }
      lampPair(b, 1.2, -3.4, 1.0);
      bolts(b, 0, 1.1, -3.42, 7, 0.3, 'x');
      b.box(2.2, 0.06, 0.4, 0, 1.52, -2.9, HULL_DARK, { rot: [-0.4, 0, 0], camo: 1 });
      jerry(b, 1.35, 2.2, 3.0, 0.1);
      jerry(b, -1.35, 2.2, 2.9, -0.1, SAND);
      bag(b, 0, 2.28, 2.9, 0.9, 0.3, 0.5, CANVAS);
    } else {
      b.box(2.2, 1.2, 0.06, 0, 1.3, 3.54, HULL_DARK, { camo: 0.8 });
    }
    // Turm mit Maschinenkanone + Panzerabwehrlenkwaffe
    if (ru) {
      b.lathe([[0, 0], [1, 0], [1.02, 0.16], [0.86, 0.56], [0.5, 0.74], [0, 0.78]], 'y', 0, 2.1, -0.9, HULL, { seg: L ? 8 : 10, squash: [1.2, 1, 1.4], ao: 0.25 });
      b.vpart(K_TURRET, 0, -0.9, -0.9);
      b.box(0.5, 0.5, 0.6, 0, 2.5, -1.9, HULL_DARK, { camo: 1 });
      if (!L) {
        b.mirror(() => {
          b.box(0.15, 0.13, 0.9, 1.1, 2.72, -0.6, DARK, { paint: P_FIXED }); // ATGM-Schienen
          b.box(0.1, 0.1, 0.12, 1.1, 2.72, -1.1, 0x6a6a62, { paint: P_FIXED });
          smokeLaunchers(b, 1.15, 2.45, -0.4, 3, -0.3);
        });
        hatch(b, -0.45, 2.78, -0.7, 0.28);
        sight(b, 0.4, 2.85, -0.9, 0.3, 0.2, 0.3);
        antenna(b, 0.6, 2.8, 0.1, 2.6, 0.03);
        b.box(0.4, 0.04, 0.8, 0, 2.89, -0.7, 0xffffff, { paint: P_TEAM, ao: 0 });
      }
      b.vpart(K_GUN, 2.55, -2.2, -0.9);
      b.barrel(0.07, 3.2, 0, 2.55, -2.2, 0.02, GUN, L ? 5 : 7);
      b.barrel(0.04, 3.0, 0.4, 2.45, -2.1, 0.02, DARK, 4);
      b.barrel(0.06, 1.0, -0.4, 2.45, -2.0, 0.02, DARK, 5);
      b.vpart(K_STATIC);
    } else {
      b.lathe([[0, 0], [1.15, 0], [1.15, 0.12]], 'y', 0, 2.1, -0.4, HULL_DARK, { seg: L ? 8 : 10, ao: 0.1 });
      b.vpart(K_TURRET, 0, -0.4, -0.4);
      b.extrudeX([[-1.2, 2.2], [-0.8, 2.78], [0.8, 2.82], [1.2, 2.5], [1.2, 2.2]], 1.9, 0, 0, -0.2, HULL, { camo: 0.7, taper: [1, 0.78] });
      b.box(0.5, 0.45, 0.5, 0, 2.55, -1.6, HULL_DARK, { camo: 1 });
      if (!L) {
        b.mirror(() => {
          b.box(0.22, 0.2, 0.9, 1.15, 2.7, -0.2, DARK, { paint: P_FIXED });
          b.box(0.17, 0.17, 0.12, 1.15, 2.7, -0.7, 0x6a6a62, { paint: P_FIXED });
          smokeLaunchers(b, 1.0, 2.5, 0.7, 3, -0.3);
        });
        b.box(0.34, 0.28, 0.4, -0.5, 3.0, -0.2, GLASS_LIGHT, { paint: P_FIXED });
        b.box(0.34, 0.22, 0.4, 0.4, 2.95, 0.5, HULL_DARK, { camo: 1 });
        sight(b, 0.4, 3.08, 0.5, 0.26, 0.16, 0.28);
        antenna(b, -0.5, 2.7, 0.75, 2.4, 0.03);
        b.box(0.6, 0.04, 0.5, 0.1, 2.83, 0.0, 0xffffff, { paint: P_TEAM, ao: 0 });
        bolts(b, 0, 2.7, -1.85, 5, 0.3, 'x');
      }
      b.vpart(K_GUN, 2.6, -1.85, -0.4);
      b.barrel(0.065, 3.0, 0.1, 2.6, -1.85, 0.02, GUN, L ? 5 : 7);
      b.cyl(0.09, 0.6, 0.1, 2.6, -2.4, 'z', 0x6a6a62, { paint: P_FIXED }, L ? 5 : 6);
      b.vpart(K_STATIC);
    }
    if (!L) {
      b.box(1.5, 0.05, 1.2, 0, 2.2, 2.35, 0xffffff, { paint: P_TEAM, ao: 0 });
      b.box(2.5, 0.12, 0.3, 0, 1.7, 3.55, 0xffffff, { paint: P_TEAM, ao: 0 });
    }
  }, { groundAO: 0.32, groundH: 0.9 });
  return vdef(geom, lo, ANIM_IFV, 7.2);
}

// ------------------------------------------------------------------------------------------------ Panzerhaubitze

export function buildSpg(): ModelDef {
  const { geom, lo } = buildVehicleGeoms((b) => {
    const L = b.lo;
    b.mirror(() => gear(b, { x: 1.5, zFront: -3.6, zRear: 3.8, nWheels: 7, rWheel: 0.4, wheelW: 0.33, beltW: 0.6, beltTop: 1.0, rollers: 3, skirt: { z0: -2.9, z1: 3.4, y0: 0.7, y1: 1.5 } }));
    b.extrudeX([[-3.5, 0.55], [3.9, 0.55], [3.9, 1.5], [3.4, 1.62], [-2.4, 1.65], [-3.8, 1.05]], 3.0, 0, 0, 0, HULL, { camo: 0.9, taper: [1, 0.95] });
    // Sporn hinten (hochgeklappt)
    b.box(2.6, 0.22, 0.12, 0, 2.5, 4.05, HULL_DARK, { rot: [0.75, 0, 0], camo: 1 });
    b.mirror(() => b.box(0.12, 0.9, 0.2, 1.1, 2.0, 4.0, STEEL, { paint: P_FIXED, rot: [0.3, 0, 0] }));
    if (!L) {
      hatch(b, -0.8, 1.66, -2.5, 0.3);
      sight(b, -0.8, 1.9, -2.8, 0.3, 0.14, 0.2);
      // Rohrstütze vorn (Marschverriegelung)
      b.box(0.5, 0.35, 0.4, 0, 1.95, -3.7, STEEL, { paint: P_FIXED });
      b.box(0.34, 0.14, 0.3, 0, 2.2, -3.7, DARK, { paint: P_FIXED });
      lampPair(b, 1.4, -3.9, 1.3);
      b.mirror(() => {
        toolbox(b, 1.62, 1.68, -1.2, 0.5, 0.9);
        b.box(0.18, 0.18, 0.2, 1.3, 0.7, -3.95, STEEL, { paint: P_FIXED });
        b.box(0.16, 0.12, 0.05, 1.2, 1.4, 4.0, TAIL, { paint: P_FIXED, ao: 0 });
      });
      jerry(b, 1.75, 1.95, 2.6, 0.1);
      jerry(b, 1.75, 1.95, 2.9, -0.1);
      bolts(b, 0, 1.0, -3.85, 9, 0.3, 'x');
      b.box(2.2, 0.06, 1.2, 0, 1.7, 3.5, 0x4a4a44, { paint: P_FIXED });
    }
    // großer Turm, hoher Schwerpunkt
    b.lathe([[0, 0], [1.6, 0], [1.64, 0.15], [0, 0.15]], 'y', 0, 1.65, 1.0, HULL_DARK, { seg: L ? 8 : 12, ao: 0.1 });
    b.vpart(K_TURRET, 0, 1.0, 1.0);
    b.extrudeX([[-2.7, 1.8], [-2.0, 2.9], [0.8, 3.15], [2.5, 3.0], [2.7, 2.2], [2.7, 1.8]], 3.0, 0, 0, 0.9, HULL, { camo: 0.8, taper: [1, 0.86] });
    b.mirror(() => b.extrudeX([[-2.2, 2.2], [-1.0, 2.9], [0.4, 2.9], [0.4, 2.2]], 0.35, 1.55, 0, 0.5, HULL_LIGHT, { camo: 0.8, taper: [1, 0.7] }));
    b.box(1.5, 1.2, 0.08, 0, 2.2, 3.65, HULL_DARK, { camo: 1 }); // Heckluke Munition
    if (!L) {
      hatch(b, 1.0, 3.0, 0.2, 0.34, 0, true);
      periscopeRing(b, 1.0, 3.2, 0.2, 0.38);
      mgPintle(b, 1.0, 3.3, 0.0);
      hatch(b, -1.0, 2.95, 0.9, 0.3);
      sight(b, 0.9, 3.25, -0.9, 0.4, 0.3, 0.5);
      b.mirror(() => {
        smokeLaunchers(b, 1.6, 2.75, -1.0, 4, -0.3);
        smokeLaunchers(b, 1.6, 2.75, -0.2, 4, -0.3);
        antenna(b, 1.3, 2.4, 2.2, 3.2, 0.03);
        b.box(0.5, 0.6, 1.0, 1.6, 2.5, 2.4, HULL_DARK, { camo: 1 }); // Staukästen
      });
      b.box(1.4, 0.9, 0.06, 0, 2.55, 3.72, 0x2c2c28, { paint: P_FIXED }); // Munitionsschacht
      for (let i = 0; i < 4; i++) b.box(1.3, 0.05, 0.05, 0, 2.2 + i * 0.22, 3.75, STEEL, { paint: P_FIXED });
      netRoll(b, 0, 3.3, 2.0, 2.0);
      bag(b, -1.0, 3.2, 2.4, 0.8, 0.3, 0.6, SAND);
      b.box(1.6, 0.05, 0.9, 0, 3.17, 1.6, 0xffffff, { paint: P_TEAM, ao: 0 });
      b.box(3.0, 0.16, 0.3, 0, 1.7, 3.95, 0xffffff, { paint: P_TEAM, ao: 0 });
    }
    // Rohr 155 mm L52 mit Mündungsbremse + Rauchabsauger, Wiege
    b.vpart(K_GUN, 2.6, -1.9, 1.0);
    b.box(1.3, 0.9, 0.6, 0, 2.6, -1.6, HULL_DARK, { camo: 1 });
    if (!L) {
      b.box(1.0, 0.6, 0.1, 0, 2.6, -1.95, DARK, { paint: P_FIXED, ao: 0.2 });
      b.cyl(0.1, 2.2, 0.55, 2.5, -2.2, 'z', 0x7a7a72, { paint: P_FIXED }, 6); // Rückholzylinder
      b.cyl(0.1, 2.2, -0.55, 2.5, -2.2, 'z', 0x7a7a72, { paint: P_FIXED }, 6);
    }
    b.push(0, 2.6, -1.9, [0.0, 0, 0]);
    b.cyl(0.14, 2.0, 0, 0, -1.0, 'z', 0x7a7a72, { paint: P_FIXED }, L ? 5 : 8);
    b.cyl(0.115, 6.0, 0, 0, -5.0, 'z', GUN, { paint: P_FIXED }, L ? 5 : 8, 0.105);
    b.cyl(0.18, 0.7, 0, 0, -4.2, 'z', 0x7a7a72, { paint: P_FIXED }, L ? 5 : 8);
    if (!L) for (const z of [-1.6, -2.1, -2.6]) b.cyl(0.16, 0.08, 0, 0, z, 'z', 0x5a5a52, { paint: P_FIXED }, 7);
    b.cyl(0.19, 0.4, 0, 0, -8.15, 'z', 0x6a6a62, { paint: P_FIXED }, L ? 5 : 8);
    b.box(0.42, 0.1, 0.3, 0, 0, -8.1, DARK, { paint: P_FIXED });
    if (!L) {
      b.box(0.3, 0.06, 0.3, 0, 0.18, -8.15, STEEL, { paint: P_FIXED });
      b.box(0.3, 0.06, 0.3, 0, -0.18, -8.15, STEEL, { paint: P_FIXED });
    }
    b.pop();
    b.vpart(K_STATIC);
    // gestaffelte Mastantenne (Rückseite, rotiert mit Turm)
  }, { groundAO: 0.32, groundH: 0.9 });
  return vdef(geom, lo, ANIM_SPG, 11);
}

// ------------------------------------------------------------------------------------------------ Flakpanzer

export function buildSpaa(): ModelDef {
  const { geom, lo } = buildVehicleGeoms((b) => {
    const L = b.lo;
    b.mirror(() => gear(b, { x: 1.4, zFront: -3.3, zRear: 3.6, nWheels: 6, rWheel: 0.4, wheelW: 0.3, beltW: 0.58, beltTop: 0.98, rollers: 3, skirt: { z0: -2.6, z1: 3.1, y0: 0.7, y1: 1.4 } }));
    b.extrudeX([[-3.2, 0.5], [3.6, 0.5], [3.6, 1.4], [3.1, 1.55], [-2.3, 1.58], [-3.45, 1.0]], 2.8, 0, 0, 0, HULL, { camo: 0.9, taper: [1, 0.93] });
    b.box(2.0, 0.05, 1.6, 0, 1.6, 2.7, 0x4a4a44, { paint: P_FIXED });
    if (!L) {
      hatch(b, -0.75, 1.58, -2.3, 0.3);
      sight(b, -0.75, 1.82, -2.6, 0.3, 0.14, 0.2);
      for (let i = 0; i < 5; i++) b.box(1.9, 0.06, 0.07, 0, 1.64, 2.0 + i * 0.3, 0x6a6a62, { paint: P_FIXED });
      lampPair(b, 1.2, -3.4, 1.1);
      b.mirror(() => {
        b.box(0.18, 0.18, 0.2, 1.0, 0.7, -3.5, STEEL, { paint: P_FIXED });
        b.box(0.14, 0.1, 0.05, 1.1, 1.2, 3.65, TAIL, { paint: P_FIXED, ao: 0 });
        toolbox(b, 1.55, 1.6, -1.0, 0.45, 0.8);
      });
      jerry(b, 1.55, 1.85, 1.2, 0.1);
      jerry(b, -1.55, 1.85, 1.3, -0.1, SAND);
      bolts(b, 0, 1.0, -3.4, 7, 0.3, 'x');
      b.box(2.7, 0.14, 0.3, 0, 1.5, 3.62, 0xffffff, { paint: P_TEAM, ao: 0 });
    }
    // Turm, breit, zwei Maschinenkanonen seitlich
    b.lathe([[0, 0], [1.3, 0], [1.34, 0.14], [0, 0.14]], 'y', 0, 1.55, 0.3, HULL_DARK, { seg: L ? 8 : 12, ao: 0.1 });
    b.vpart(K_TURRET, 0, 0.3, 0.3);
    b.extrudeX([[-1.6, 1.7], [-1.2, 2.35], [1.3, 2.5], [1.6, 2.1], [1.6, 1.7]], 2.9, 0, 0, 0.1, HULL, { camo: 0.8, taper: [1, 0.75] });
    b.mirror(() => {
      b.box(0.45, 0.55, 1.5, 1.4, 2.1, -0.6, HULL_DARK, { camo: 0.8, top: [0.8, 1] });
      if (!L) {
        b.cyl(0.4, 0.3, 1.0, 2.45, 0.7, 'x', 0x6a6a62, { paint: P_FIXED }, 8); // Munitionstrommel
        b.cyl(0.38, 0.06, 1.18, 2.45, 0.7, 'x', 0x3a3a34, { paint: P_FIXED }, 8);
        smokeLaunchers(b, 1.65, 2.3, 0.8, 4, -0.3);
        b.box(0.6, 0.3, 0.5, 0.9, 2.62, 1.2, HULL_DARK, { camo: 1 });
      }
    });
    if (!L) {
      hatch(b, 0, 2.5, 0.9, 0.3);
      // Folgeradar (vorn, auf der Turmfront, folgt dem Turm)
      b.cyl(0.25, 0.45, 0, 2.7, -1.3, 'y', DARK, { paint: P_FIXED }, 6);
      b.box(0.55, 0.55, 0.3, 0, 3.1, -1.3, 0xd0d0c8, { paint: P_FIXED, rot: [-0.25, 0, 0] });
      b.box(0.45, 0.45, 0.05, 0, 3.1, -1.46, 0x445058, { paint: P_FIXED, rot: [-0.25, 0, 0] });
      antenna(b, 1.0, 2.5, 1.6, 2.2, 0.03);
      b.box(1.0, 0.05, 0.8, 0, 2.55, 1.9, 0xffffff, { paint: P_TEAM, ao: 0 });
    }
    b.vpart(K_STATIC);
    // Suchradar (hinten auf Mast): rotierende Rechteckantenne mit Turm
    b.vpart(K_TURRET, 0, 0.3, 0.3);
    b.cyl(0.12, 0.7, 0, 2.85, 0.9, 'y', DARK, { paint: P_FIXED }, 5);
    b.box(0.4, 0.3, 0.4, 0, 3.3, 0.9, DARK, { paint: P_FIXED });
    b.vpart(K_STATIC);
    b.vpart(K_RADAR, 3.45, 0.9, 0.3);
    b.box(2.2, 0.8, 0.12, 0, 3.8, 0.9, 0xd8d8d0, { paint: P_FIXED });
    if (!L) {
      b.box(2.0, 0.6, 0.04, 0, 3.8, 0.97, 0x445058, { paint: P_FIXED });
      for (let i = 0; i < 4; i++) b.box(0.04, 0.78, 0.2, -0.8 + i * 0.53, 3.8, 0.84, 0x9a9a92, { paint: P_FIXED });
    }
    b.box(0.2, 0.2, 0.5, 0, 3.8, 0.7, DARK, { paint: P_FIXED });
    b.vpart(K_STATIC);
    // Zwillingskanonen (Rohrverband, folgt Turm + Elevation)
    b.vpart(K_GUN, 2.15, -1.3, 0.3);
    b.mirror(() => {
      b.push(1.45, 2.15, -1.3, [0, 0, 0]);
      b.cyl(0.14, 1.2, 0, 0, -0.5, 'z', 0x7a7a72, { paint: P_FIXED }, L ? 5 : 7);
      b.cyl(0.075, 3.2, 0, 0, -2.4, 'z', GUN, { paint: P_FIXED }, L ? 5 : 7, 0.07);
      b.cyl(0.11, 0.4, 0, 0, -3.8, 'z', 0x6a6a62, { paint: P_FIXED }, L ? 5 : 7);
      if (!L) {
        b.cyl(0.12, 0.5, 0, 0, -2.0, 'z', 0x7a7a72, { paint: P_FIXED }, 6);
        b.box(0.3, 0.28, 0.5, 0, 0.0, 0.1, HULL_DARK, { camo: 1 });
      }
      b.pop();
    });
    b.vpart(K_STATIC);
  }, { groundAO: 0.32, groundH: 0.9 });
  return vdef(geom, lo, ANIM_SPAA, 7.5);
}

export type { V3 };
export { P_CAMO };
