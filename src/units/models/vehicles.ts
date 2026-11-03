/** Phase 4 – Radfahrzeuge: Spähwagen 4x4, Radschützenpanzer 8x8, Raketenartillerie, Flugabwehrrakete, LKW, Hilfskonvoi, Lazarett, Krankenwagen. */
import {
  BLACK, BLUE_UN, DARK, GLASS, GLASS_LIGHT, GUN, HULL, HULL_DARK, HULL_LIGHT, ModelBuilder, P_CAMO, P_FIXED, P_TEAM, RED, RUBBER, STEEL, WHITE,
  type ModelDef,
} from './geomUtils';

const HUB = 0x5a5a52;
const TIRE = 0x1f1f1b;

/** Rad (x > 0 Außenseite, per mirror-Kontext) mit Profilreifen und Nabe */
function wheel(b: ModelBuilder, x: number, z: number, R: number, w: number, seg = 7): void {
  b.lathe([[R, -w / 2], [R, w / 2], [R * 0.62, w / 2], [R * 0.3, w / 2 + 0.04], [0, w / 2 + 0.05]], 'x', x, R, z, TIRE, { paint: P_FIXED, seg, edgeColors: [TIRE, 0x2c2c27, HUB, 0x6a6a60], ao: 0.1 });
}
function wheels(b: ModelBuilder, zs: number[], halfTrack: number, R: number, w: number, seg = 7): void {
  b.mirror(() => {
    for (const z of zs) wheel(b, halfTrack, z, R, w, seg);
  });
  // Achsen
  for (const z of zs) b.cyl(0.09, halfTrack * 2 - w, 0, R, z, 'x', DARK, { paint: P_FIXED }, 5);
}
function mudguards(b: ModelBuilder, zs: number[], halfTrack: number, R: number, w: number, color = HULL_DARK): void {
  b.mirror(() => {
    for (const z of zs) b.box(w + 0.12, 0.07, R * 2.1, halfTrack + 0.04, R * 2 + 0.12, z, color, { camo: 1 });
  });
}

export function redCross(b: ModelBuilder, x: number, y: number, z: number, size: number, side: 1 | -1, withPlate = true): void {
  if (withPlate) b.plateSide(size * 1.25, size * 1.25, x, y, z, side, WHITE);
  const e = 0.03 * side;
  b.plateSide(size * 0.86, size * 0.3, x + e, y, z, side, RED);
  b.plateSide(size * 0.3, size * 0.86, x + e, y, z, side, RED);
}
export function redCrossTop(b: ModelBuilder, x: number, y: number, z: number, size: number, plate = true): void {
  if (plate) b.plate(size * 1.25, size * 1.25, x, y, z, WHITE);
  b.plate(size * 0.86, size * 0.3, x, y + 0.02, z, RED);
  b.plate(size * 0.3, size * 0.86, x, y + 0.02, z, RED);
}

function mirrors(b: ModelBuilder, y: number, z: number, x: number): void {
  b.mirror(() => {
    b.box(0.06, 0.28, 0.2, x, y, z, DARK, { paint: P_FIXED });
    b.box(0.2, 0.04, 0.04, x - 0.1, y + 0.12, z, DARK, { paint: P_FIXED });
  });
}

function headlights(b: ModelBuilder, y: number, z: number, x: number, w = 0.26): void {
  b.mirror(() => b.plateFront(w, 0.16, x, y, z, -1, 0xe8e0a0));
}

function exhaust(b: ModelBuilder, x: number, y: number, z: number): void {
  b.cyl(0.07, 0.6, x, y, z, 'y', DARK, { paint: P_FIXED }, 5);
}

// -------------------------------------------------------------------------- Spähwagen 4x4

export function buildRecon4x4(): ModelDef {
  const b = new ModelBuilder();
  const zs = [-1.55, 1.55];
  wheels(b, zs, 1.0, 0.5, 0.36);
  mudguards(b, zs, 1.0, 0.5, 0.36);
  // Wanne: keilförmig, Bug schräg
  b.extrudeX([[-2.5, 0.65], [2.5, 0.65], [2.55, 1.55], [2.1, 1.9], [-0.4, 1.95], [-1.5, 1.6], [-2.45, 1.2]], 2.1, 0, 0, 0, HULL, { camo: 0.8, taper: [1, 0.86] });
  b.box(1.5, 0.45, 0.06, 0, 1.58, -1.15, GLASS, { paint: P_FIXED, rot: [0.65, 0, 0] }); // Frontscheibe
  b.mirror(() => b.box(0.05, 0.3, 0.6, 1.0, 1.55, -0.1, GLASS, { paint: P_FIXED }));
  b.box(2.2, 0.18, 0.3, 0, 0.8, -2.55, HULL_DARK, { camo: 1 }); // Bugschutz
  headlights(b, 1.2, -2.5, 0.65, 0.3);
  // Heck: Reserverad
  b.lathe([[0.42, -0.14], [0.42, 0.14], [0.2, 0.17], [0, 0.17]], 'z', 0, 1.35, 2.62, TIRE, { paint: P_FIXED, seg: 7, edgeColors: [TIRE, TIRE, HUB] });
  // Sensorkopf auf Teleskopmast
  b.cyl(0.07, 1.0, 0.5, 2.45, 0.55, 'y', DARK, { paint: P_FIXED }, 5);
  b.box(0.38, 0.34, 0.4, 0.5, 3.05, 0.55, HULL_DARK, { camo: 1 });
  b.box(0.2, 0.2, 0.04, 0.5, 3.05, 0.34, GLASS_LIGHT, { paint: P_FIXED });
  // Fernbedienter MG-Turm
  b.box(0.7, 0.35, 0.8, -0.35, 2.15, 0.6, HULL, { camo: 1, top: [0.8, 0.8] });
  b.barrel(0.04, 1.1, -0.35, 2.2, 0.35, 0.03, GUN, 5);
  // Antennen, Schnorchel
  b.cyl(0.02, 2.2, -0.9, 3.0, 1.9, 'y', DARK, { paint: P_FIXED }, 4, 0.01);
  b.cyl(0.02, 1.6, 0.9, 2.8, 2.0, 'y', DARK, { paint: P_FIXED }, 4, 0.01);
  mirrors(b, 1.7, -0.7, 1.15);
  exhaust(b, 1.0, 1.85, 2.1);
  b.box(1.2, 0.05, 0.9, 0, 1.97, 1.55, 0xffffff, { paint: P_TEAM, ao: 0 });
  b.box(2.0, 0.1, 0.3, 0, 1.4, 2.6, 0xffffff, { paint: P_TEAM, ao: 0 });
  return { geom: b.build({ groundAO: 0.35, groundH: 0.9 }), size: 5.2, boost: 1, livery: 'ground', tilt: true };
}

// -------------------------------------------------------------------------- Radschützenpanzer 8x8

export function buildApc8x8(): ModelDef {
  const b = new ModelBuilder();
  const zs = [-2.7, -1.25, 1.25, 2.7];
  wheels(b, zs, 1.3, 0.62, 0.42, 8);
  mudguards(b, zs, 1.3, 0.62, 0.42);
  b.extrudeX([[-3.7, 0.75], [3.8, 0.75], [3.85, 1.9], [3.5, 2.4], [-0.6, 2.5], [-2.2, 2.2], [-3.75, 1.5]], 2.75, 0, 0, 0, HULL, { camo: 0.9, taper: [1, 0.88] });
  // Seitenpanzerplatten (Add-on) und Radkastenverblendungen
  b.mirror(() => {
    b.box(0.14, 0.9, 1.7, 1.38, 1.65, 0.15, HULL_LIGHT, { camo: 0.8 });
    b.box(0.14, 0.7, 1.5, 1.38, 1.65, -2.5, HULL_LIGHT, { camo: 0.8 });
    b.plateSide(0.9, 0.5, 1.46, 1.6, 0.15, 1, 0x20262a); // Tür
    b.box(0.08, 0.34, 0.5, 1.4, 1.85, -2.45, GLASS, { paint: P_FIXED, rot: [0, 0, 0] });
  });
  b.box(1.9, 0.5, 0.06, 0, 1.95, -2.8, GLASS, { paint: P_FIXED, rot: [0.7, 0, 0] });
  headlights(b, 1.3, -3.78, 0.9, 0.3);
  // Dachluken
  for (let i = 0; i < 2; i++) b.box(0.75, 0.1, 0.75, i === 0 ? -0.55 : 0.6, 2.58, 2.2, HULL_DARK, { camo: 1 });
  b.box(0.6, 0.1, 0.6, -0.8, 2.55, -1.6, HULL_DARK, { camo: 1 });
  // Heckrampe, Auspuff
  b.box(2.2, 1.2, 0.08, 0, 1.55, 3.88, HULL_DARK, { camo: 0.8 });
  exhaust(b, 1.1, 2.0, 3.6);
  // RWS Turm mit 30 mm + ATGM
  b.lathe([[0, 0], [0.8, 0], [0.82, 0.12], [0, 0.12]], 'y', 0, 2.5, 0.2, HULL_DARK, { seg: 8, ao: 0.1 });
  b.extrudeX([[-0.9, 2.62], [-0.6, 3.1], [0.7, 3.12], [0.95, 2.62]], 1.4, 0, 0, 0.2, HULL, { camo: 0.7, taper: [1, 0.8] });
  b.box(0.45, 0.4, 0.5, 0, 2.95, -1.0, HULL_DARK, { camo: 1 });
  b.barrel(0.05, 2.5, 0.05, 2.95, -1.2, 0.02, GUN, 6);
  b.cyl(0.07, 0.4, 0.05, 2.95, -3.2, 'z', 0x6a6a62, { paint: P_FIXED }, 6);
  b.mirror(() => b.box(0.22, 0.2, 0.7, 0.95, 2.85, -0.2, DARK, { paint: P_FIXED }));
  b.box(0.3, 0.24, 0.3, 0, 3.2, -0.3, GLASS_LIGHT, { paint: P_FIXED });
  b.mirror(() => b.box(0.14, 0.2, 0.14, 0.95, 3.0, 0.8, DARK, { paint: P_FIXED }));
  mirrors(b, 2.1, -3.0, 1.45);
  b.cyl(0.02, 2.8, 1.0, 3.9, 2.8, 'y', DARK, { paint: P_FIXED }, 4, 0.01);
  b.box(1.5, 0.05, 1.3, 0, 2.52, 1.2, 0xffffff, { paint: P_TEAM, ao: 0 });
  b.box(2.2, 0.12, 0.3, 0, 2.2, 3.9, 0xffffff, { paint: P_TEAM, ao: 0 });
  return { geom: b.build({ groundAO: 0.35, groundH: 1.0 }), size: 8, boost: 1, livery: 'ground', tilt: true };
}

// -------------------------------------------------------------------------- LKW-Fahrgestell (Kabine + Rahmen)

interface TruckOpts {
  zs: number[];
  halfTrack: number;
  R: number;
  w: number;
  cabZ: number;
  frameL: number;
  frameZ: number;
  cabW?: number;
  cabH?: number;
  cabPaint?: number;
  cabColor?: number;
}

function truckChassis(b: ModelBuilder, t: TruckOpts): void {
  const cabW = t.cabW ?? 2.5;
  const cabH = t.cabH ?? 1.7;
  const camoCab = t.cabPaint === P_FIXED ? undefined : 0.8;
  wheels(b, t.zs, t.halfTrack, t.R, t.w);
  // Leiterrahmen
  b.box(1.3, 0.3, t.frameL, 0, t.R + 0.3, t.frameZ, 0x2a2a26, { paint: P_FIXED });
  b.box(2.3, 0.18, t.frameL, 0, t.R + 0.55, t.frameZ, 0x3a3a34, { paint: P_FIXED });
  // Kabine (Frontlenker mit Haube)
  const cc = t.cabColor ?? HULL_LIGHT;
  const cp = t.cabPaint ?? P_CAMO;
  b.extrudeX([[-1.0, 0], [1.0, 0], [1.0, cabH], [-0.4, cabH + 0.15], [-0.8, cabH * 0.6], [-1.05, cabH * 0.4]], cabW, 0, t.R + 0.62, t.cabZ, cc, { paint: cp, camo: camoCab, taper: [1, 0.94] });
  // Frontscheibe, Seitenfenster, Kühlergrill, Scheinwerfer
  const wy = t.R + 0.62 + cabH * 0.78;
  b.box(cabW * 0.82, cabH * 0.36, 0.06, 0, wy, t.cabZ - 0.58, GLASS, { paint: P_FIXED, rot: [0.28, 0, 0] });
  b.mirror(() => {
    b.plateSide(0.9, cabH * 0.3, cabW / 2 * 0.97 - 0.02, wy, t.cabZ - 0.05, 1, 0x20303a);
    b.box(0.06, 0.28, 0.2, cabW / 2 + 0.1, wy - 0.1, t.cabZ - 0.7, DARK, { paint: P_FIXED });
  });
  b.box(cabW * 0.7, 0.4, 0.06, 0, t.R + 0.95, t.cabZ - 1.07, 0x25251f, { paint: P_FIXED });
  headlights(b, t.R + 0.95, t.cabZ - 1.1, cabW * 0.38, 0.3);
  b.box(cabW, 0.2, 0.18, 0, t.R + 0.45, t.cabZ - 1.1, 0x3a3a34, { paint: P_FIXED }); // Stoßstange
  mudguards(b, t.zs, t.halfTrack, t.R, t.w, 0x3a3a34);
  // Tank, Auspuff, Reserverad
  b.mirror((s) => {
    if (s === 1) b.cyl(0.28, 0.9, t.halfTrack - 0.2, t.R + 0.5, t.cabZ + 1.6, 'z', 0x5a5a52, { paint: P_FIXED }, 6);
  });
  exhaust(b, -cabW / 2 - 0.05, t.R + cabH + 0.8, t.cabZ + 0.6);
}

// -------------------------------------------------------------------------- Raketenartillerie (MLRS)

export function buildMlrs(): ModelDef {
  const b = new ModelBuilder();
  truckChassis(b, { zs: [-2.6, 0.7, 2.4], halfTrack: 1.05, R: 0.55, w: 0.4, cabZ: -3.0, frameL: 8.2, frameZ: 0.2, cabH: 1.7 });
  b.box(1.4, 0.05, 0.9, 0, 2.95, -2.9, 0xffffff, { paint: P_TEAM, ao: 0 });
  b.box(2.35, 0.2, 5.6, 0, 1.35, 1.2, 0x3a3a34, { paint: P_FIXED }); // Drehkranzplattform
  // Stützen hinten
  b.mirror(() => {
    b.box(0.16, 0.14, 1.0, 1.35, 0.9, 3.9, STEEL, { paint: P_FIXED, rot: [0, 0, 0.5] });
    b.box(0.5, 0.06, 0.5, 1.75, 0.45, 3.9, STEEL, { paint: P_FIXED });
  });
  // Startbehälter: 2 × 6 Rohre, erhöht
  b.cyl(0.55, 0.3, 0, 1.6, 2.6, 'y', DARK, { paint: P_FIXED }, 7);
  b.push(0, 1.8, 2.4, [0.6, 0, 0]);
  b.box(2.25, 0.32, 5.0, 0, 0.2, -2.3, HULL, { camo: 0.8 });
  b.box(2.3, 1.55, 4.6, 0, 1.15, -2.3, HULL, { camo: 0.8, top: [0.96, 1] });
  b.box(2.38, 1.6, 0.1, 0, 1.15, 0.05, HULL_DARK, { camo: 0.8 }); // Rückwand
  // Rohrmündungen (Front, 4 × 3 = 12)
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      const x = (c - 1.5) * 0.55, y = 0.65 + r * 0.45;
      b.lathe([[0, 0], [0.19, 0], [0.19, 0.06], [0.13, 0.06], [0, 0.04]], 'z', x, y, -4.65, DARK, { paint: P_FIXED, seg: 6, edgeColors: [0x3a3a34, 0x1a1a18, 0x0e0e0c, 0x0e0e0c], ao: 0 });
    }
  }
  b.box(1.9, 0.06, 1.2, 0, 2.0, -2.0, 0xffffff, { paint: P_TEAM, ao: 0 });
  b.pop();
  return { geom: b.build({ groundAO: 0.35, groundH: 1.0 }), size: 9, boost: 1, livery: 'ground', tilt: true };
}

// -------------------------------------------------------------------------- Flugabwehrraketen-Startgerät

export function buildSam(): ModelDef {
  const b = new ModelBuilder();
  truckChassis(b, { zs: [-3.7, -2.2, 1.9, 3.4], halfTrack: 1.1, R: 0.6, w: 0.42, cabZ: -4.3, frameL: 10.4, frameZ: 0.0, cabH: 1.8 });
  b.box(1.4, 0.05, 0.9, 0, 3.05, -4.2, 0xffffff, { paint: P_TEAM, ao: 0 });
  b.box(2.4, 0.2, 5.0, 0, 1.45, 1.8, 0x3a3a34, { paint: P_FIXED });
  // Stützfüße
  b.mirror(() => {
    b.box(0.14, 0.14, 1.1, 1.4, 0.95, 4.2, STEEL, { paint: P_FIXED, rot: [0, 0, 0.55] });
    b.box(0.5, 0.06, 0.5, 1.85, 0.5, 4.2, STEEL, { paint: P_FIXED });
    b.box(0.14, 0.14, 1.1, 1.4, 0.95, -0.5, STEEL, { paint: P_FIXED, rot: [0, 0, 0.55] });
  });
  // Drehkranz + Hubgerüst
  b.cyl(0.8, 0.5, 0, 1.75, 2.4, 'y', DARK, { paint: P_FIXED }, 8);
  b.push(0, 2.2, 2.9, [0.8, 0, 0]);
  b.box(2.0, 0.22, 5.8, 0, 0, -2.5, HULL_DARK, { camo: 0.8 });
  // 4 Behälter (2×2), rechteckig mit Stirnkappen
  for (const sx of [-0.55, 0.55]) {
    for (const sy of [0.45, 1.15]) {
      b.box(0.62, 0.62, 5.7, sx, sy, -2.55, HULL, { camo: 0.8 });
      b.box(0.5, 0.5, 0.06, sx, sy, -5.42, WHITE, { paint: P_FIXED });
      b.box(0.5, 0.5, 0.06, sx, sy, 0.3, 0x2a2a26, { paint: P_FIXED });
      b.box(0.64, 0.12, 0.6, sx, sy + 0.31, -4.9, 0xf0e0a0, { paint: P_FIXED }); // Markierungsband
    }
  }
  b.pop();
  // Radarmast (links hinter Kabine): Flächenradar
  b.cyl(0.1, 2.2, -0.9, 2.9, -2.2, 'y', DARK, { paint: P_FIXED }, 5);
  b.box(1.5, 1.2, 0.14, -0.9, 4.5, -2.2, 0xcfd2d0, { paint: P_FIXED });
  b.box(1.4, 1.1, 0.05, -0.9, 4.5, -2.29, 0x445058, { paint: P_FIXED });
  b.cyl(0.03, 2.0, 0.9, 3.2, -1.2, 'y', DARK, { paint: P_FIXED }, 4, 0.015);
  return { geom: b.build({ groundAO: 0.35, groundH: 1.0 }), size: 11, boost: 1, livery: 'ground', tilt: true };
}

// -------------------------------------------------------------------------- LKW (Versorgung)

export function buildTruck(): ModelDef {
  const b = new ModelBuilder();
  truckChassis(b, { zs: [-2.4, 1.2, 2.6], halfTrack: 1.0, R: 0.5, w: 0.38, cabZ: -2.7, frameL: 7.6, frameZ: 0.1, cabH: 1.7 });
  b.box(1.5, 0.05, 1.0, 0, 2.85, -2.6, 0xffffff, { paint: P_TEAM, ao: 0 });
  // Ladefläche mit Bordwänden
  b.box(2.5, 0.14, 4.9, 0, 1.45, 1.5, HULL_DARK, { camo: 1 });
  b.mirror(() => {
    b.box(0.06, 0.5, 4.9, 1.24, 1.75, 1.5, HULL, { camo: 0.7 });
    b.box(0.2, 0.5, 0.14, 1.23, 1.35, 1.5, DARK, { paint: P_FIXED });
  });
  b.box(2.5, 0.5, 0.06, 0, 1.75, -0.95, HULL, { camo: 0.7 });
  // Plane über vorderem Teil (Spriegel + Bogenprofil), hinten Ladung offen
  b.extrudeX([[-2.0, 2.0], [-1.6, 3.0], [-0.8, 3.45], [0.8, 3.45], [1.6, 3.0], [2.0, 2.0]], 2.45, 0, -0.5, -0.5, 0xe8e0c8, { paint: P_CAMO, camo: 0.8, taper: [1, 0.78] });
  b.box(2.3, 0.05, 0.4, 0, 3.97, -0.5, 0xffffff, { paint: P_TEAM, ao: 0 });
  // Ladung hinten: Kisten, Fässer
  b.box(0.9, 0.7, 0.9, -0.55, 1.95, 3.3, 0x8a7a55, { paint: P_FIXED });
  b.box(0.8, 0.5, 0.8, 0.6, 1.85, 3.5, 0x6a6a50, { paint: P_FIXED });
  b.box(0.6, 0.45, 0.7, 0.5, 2.3, 3.4, 0x7a6a45, { paint: P_FIXED });
  b.cyl(0.3, 0.8, -0.5, 2.0, 2.2, 'y', 0x4a5a3a, { paint: P_FIXED }, 6);
  b.cyl(0.3, 0.8, 0.45, 1.98, 2.3, 'y', 0x4a5a3a, { paint: P_FIXED }, 6);
  // Reserverad unter der Ladefläche
  b.lathe([[0.45, -0.16], [0.45, 0.16], [0.2, 0.2], [0, 0.2]], 'z', 0, 1.1, 4.2, TIRE, { paint: P_FIXED, seg: 7, edgeColors: [TIRE, TIRE, HUB] });
  return { geom: b.build({ groundAO: 0.35, groundH: 1.0 }), size: 8, boost: 1, livery: 'ground', tilt: true };
}

// -------------------------------------------------------------------------- Hilfskonvoi-LKW (weiß/blau, rotes Kreuz)

function aidMarkings(b: ModelBuilder, bodyW: number, z0: number, z1: number, y: number): void {
  b.mirror(() => {
    b.plateSide(z1 - z0 - 0.4, 0.28, bodyW / 2 + 0.02, y + 0.55, (z0 + z1) / 2, 1, BLUE_UN);
    redCross(b, bodyW / 2 + 0.03, y - 0.15, (z0 + z1) / 2 + 0.2, 1.1, 1);
  });
}

export function buildAidTruck(): ModelDef {
  const b = new ModelBuilder();
  truckChassis(b, { zs: [-2.4, 1.2, 2.6], halfTrack: 1.0, R: 0.5, w: 0.38, cabZ: -2.7, frameL: 7.6, frameZ: 0.1, cabH: 1.7, cabPaint: P_FIXED, cabColor: WHITE });
  // blaue Streifen an der Kabine, weißer Koffer, blaues Dach-/Heckband
  b.mirror(() => b.plateSide(1.2, 0.2, 1.27, 2.0, -2.6, 1, BLUE_UN));
  b.box(2.55, 2.2, 5.0, 0, 2.65, 1.45, 0xf4f4f0, { paint: P_FIXED, top: [0.97, 1], ao: 0.25 });
  b.box(2.58, 0.3, 5.02, 0, 3.6, 1.45, BLUE_UN, { paint: P_FIXED, top: [0.97, 1] });
  aidMarkings(b, 2.55, -1.0, 3.9, 2.65);
  b.plateFront(2.0, 1.7, 0, 2.5, 3.96, 1, 0xe8e8e4); // Hecktür
  redCrossTop(b, 0, 3.77, 1.6, 1.6);
  b.box(1.0, 0.04, 0.4, 0, 2.2, -3.0, BLUE_UN, { paint: P_FIXED }); // Kabinendach
  b.box(1.3, 0.05, 0.8, 0, 3.8, 3.4, 0xffffff, { paint: P_TEAM, ao: 0 });
  b.cyl(0.03, 1.2, -0.9, 3.0, -2.2, 'y', DARK, { paint: P_FIXED }, 4, 0.015);
  b.cyl(0.02, 1.0, 0.0, 3.5, -2.6, 'y', 0x6090d0, { paint: P_FIXED }, 4, 0.02); // UN-Flagge/Stab
  b.box(0.4, 0.26, 0.04, 0.2, 4.05, -2.6, BLUE_UN, { paint: P_FIXED });
  return { geom: b.build({ groundAO: 0.35, groundH: 1.0 }), size: 8, boost: 1, livery: 'ground', tilt: true };
}

// -------------------------------------------------------------------------- Feldlazarett (Truck + Zeltmodul)

export function buildFieldHospital(): ModelDef {
  const b = new ModelBuilder();
  // Zugmaschine vorn (kleiner LKW), Zelt dahinter
  b.push(0, 0, -5.8, [0, 0, 0], [0.85, 0.85, 0.85]);
  truckChassis(b, { zs: [-0.2, 1.4], halfTrack: 1.0, R: 0.5, w: 0.38, cabZ: -1.4, frameL: 5.0, frameZ: 0.7, cabH: 1.7, cabPaint: P_FIXED, cabColor: WHITE });
  b.box(2.55, 1.8, 2.3, 0, 2.5, 1.6, 0xf4f4f0, { paint: P_FIXED, ao: 0.25 });
  b.mirror(() => redCross(b, 1.29, 2.55, 1.6, 0.9, 1));
  b.pop();
  // Großzelt: Bogenprofil mit Firsthöhe, weiß/oliv, Seitenwände, Eingang
  const zt0 = -3.2, zt1 = 6.4;
  const prof: Array<[number, number]> = [[zt0, 0.1], [zt0, 2.1], [zt0 + 0.5, 3.0], [zt1 - 0.5, 3.0], [zt1, 2.1], [zt1, 0.1]];
  b.slab([[-2.6, zt0], [2.6, zt0], [2.6, zt1], [-2.6, zt1]], 0.1, 2.1, 0, 0, 0, 0xf2f2ee, { paint: P_FIXED, ao: 0.3 });
  b.extrudeX([[zt0 + 0.0, 2.05], [zt0 + 0.8, 3.15], [zt1 - 0.8, 3.15], [zt1, 2.05]], 5.3, 0, 0, 0, 0xe8e8e2, { paint: P_FIXED, taper: [1, 0.55], ao: 0.15 });
  void prof;
  // Firstband in Team-/Blaufarbe
  b.box(0.35, 0.08, zt1 - zt0 - 1.0, 0, 3.17, (zt0 + zt1) / 2, 0xffffff, { paint: P_TEAM, ao: 0 });
  // Rotes Kreuz auf dem Dach (sichtbar von oben) – zwei Dachflächen
  b.mirror(() => redCrossTop(b, 1.15, 2.75, 1.8, 1.7));
  // Seitliche Kreuze, Eingangsflügel, Zeltleinen
  b.mirror(() => {
    redCross(b, 2.64, 1.3, 1.5, 1.3, 1);
    b.plateSide(1.0, 1.5, 2.65, 1.0, -1.0, 1, 0x7a7a6a);
  });
  b.plateFront(1.6, 1.7, 0, 1.0, zt0 - 0.02, -1, 0x6a6a5a);
  b.mirror(() => {
    for (const z of [zt0 + 0.5, (zt0 + zt1) / 2, zt1 - 0.5]) b.cyl(0.04, 1.4, 3.2, 0.7, z, 'y', DARK, { paint: P_FIXED, rot: [0, 0, 0.5] }, 4);
  });
  // Generator, Klimagerät, Lichtmast
  b.box(1.0, 0.8, 1.6, -3.3, 0.5, 4.8, 0x5a6a4a, { paint: P_FIXED });
  b.box(0.9, 0.7, 0.9, 3.3, 0.5, 4.5, 0x8a8a84, { paint: P_FIXED });
  b.cyl(0.05, 4.2, -3.3, 2.3, 3.2, 'y', DARK, { paint: P_FIXED }, 4, 0.03);
  b.box(0.5, 0.2, 0.3, -3.3, 4.4, 3.2, 0xe8e0a0, { paint: P_FIXED });
  return { geom: b.build({ groundAO: 0.4, groundH: 1.0 }), size: 14, boost: 1, livery: 'ground', tilt: true };
}

// -------------------------------------------------------------------------- Krankenwagen

export function buildAmbulance(): ModelDef {
  const b = new ModelBuilder();
  const zs = [-1.6, 1.7];
  wheels(b, zs, 1.0, 0.48, 0.34);
  mudguards(b, zs, 1.0, 0.48, 0.34, 0x5a5a52);
  b.box(2.2, 0.2, 5.4, 0, 0.6, 0.1, 0x3a3a34, { paint: P_FIXED });
  // Kabine + Koffer, weiß/oliv
  b.extrudeX([[-2.8, 0.7], [-0.5, 0.7], [-0.5, 2.0], [-1.6, 2.0], [-2.3, 1.45], [-2.8, 1.3]], 2.15, 0, 0, 0, WHITE, { paint: P_FIXED, taper: [1, 0.95], ao: 0.25 });
  b.box(2.2, 2.0, 3.3, 0, 1.7, 1.15, WHITE, { paint: P_FIXED, ao: 0.25 });
  b.box(2.22, 0.2, 3.31, 0, 2.2, 1.15, RED, { paint: P_FIXED });
  b.box(1.9, 0.5, 0.06, 0, 1.75, -2.28, GLASS, { paint: P_FIXED, rot: [0.5, 0, 0] });
  b.mirror(() => {
    b.plateSide(0.9, 0.5, 1.09, 1.8, -1.2, 1, 0x20303a);
    redCross(b, 1.115, 1.5, 1.4, 1.0, 1);
    b.plateSide(3.2, 0.14, 1.12, 1.35, 1.15, 1, BLUE_UN);
  });
  redCrossTop(b, 0, 2.72, 1.2, 1.3);
  // Blaulicht
  b.box(1.0, 0.1, 0.22, 0, 2.15, -1.0, 0x3060ff, { paint: P_FIXED });
  headlights(b, 1.0, -2.8, 0.7, 0.3);
  b.box(1.3, 0.05, 0.7, 0, 2.72, 2.3, 0xffffff, { paint: P_TEAM, ao: 0 });
  return { geom: b.build({ groundAO: 0.35, groundH: 0.9 }), size: 6, boost: 1, livery: 'ground', tilt: true };
}

export { BLACK, RUBBER };
