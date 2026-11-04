/**
 * Phase 4/5 – Radfahrzeuge: Spähwagen 4x4, Radschützenpanzer 8x8, Raketenartillerie, Flugabwehrrakete, LKW, Hilfskonvoi,
 * Lazarett, Krankenwagen. Hoch-/Niedrigdetail + 3 Tarnvarianten über buildVehicleGeoms; Räder/Turm/Rohr/Radar animiert (b.vpart).
 */
import {
  BLUE_UN, buildVehicleGeoms, DARK, GLASS, GLASS_LIGHT, GUN, HULL, HULL_DARK, HULL_LIGHT, K_GUN, K_SPIN, K_STATIC, K_TURRET, K_WHEEL,
  ModelBuilder, P_CAMO, P_FIXED, P_TEAM, RED, RUBBER, STEEL, WHITE, type AnimSpec, type ModelDef,
} from './geomUtils';
import { vdef, antenna, bag, bolts, hatch, jerry, lampPair, mgPintle, sight, smokeLaunchers } from './tanks';

const HUB = 0x5a5a52;
const HUB_L = 0x8a8a7c;
const TIRE = 0x1f1f1b;
const TIRE_S = 0x2c2c27;
const TAIL = 0x9a2020;
const SAND = 0x7a6e4a;
const CANVAS = 0x6b6a4a;
const OLIVE = 0x4f5a3c;

const ANIM_WHEELED: AnimSpec = { turretRate: 1.6, elevRate: 1.0, elevMode: 'direct', elevRest: 0.02, elevMax: 0.45, recoil: 0.06, radarRate: 0, bob: 0.05 };
const ANIM_RECON: AnimSpec = { turretRate: 1.8, elevRate: 1.0, elevMode: 'direct', elevRest: 0.02, elevMax: 0.4, recoil: 0.04, radarRate: 0, bob: 0.05 };
const ANIM_MLRS: AnimSpec = { turretRate: 0.6, elevRate: 0.5, elevMode: 'launcher', elevRest: 0.0, elevMax: 1.05, recoil: 0, radarRate: 0, bob: 0.05 };
const ANIM_SAM: AnimSpec = { turretRate: 0.5, elevRate: 0.45, elevMode: 'sam', elevRest: 0.04, elevMax: 1.2, recoil: 0, radarRate: 1.6, bob: 0.05 };
const ANIM_TRUCK: AnimSpec = { turretRate: 0, elevRate: 0, elevMode: 'none', elevRest: 0, elevMax: 0, recoil: 0, radarRate: 0, bob: 0.06 };

/** Reifen mit Profilschultern, Nabe und Radmuttern; animiert (K_WHEEL). xw = Radmitte, Nabe nach +x */
function tyre(b: ModelBuilder, xw: number, R: number, z: number, w: number, seg: number): void {
  b.vpart(K_WHEEL, R, z, R);
  if (b.lo) {
    b.lathe([[R, -w / 2], [R, w / 2], [0, w / 2 + 0.05]], 'x', xw, R, z, TIRE, { paint: P_FIXED, seg: 6, edgeColors: [TIRE, HUB], ao: 0.1 });
    b.vpart(K_STATIC);
    return;
  }
  b.lathe(
    [[R * 0.9, -w / 2], [R, -w / 2 + 0.07], [R, w / 2 - 0.07], [R * 0.9, w / 2], [R * 0.52, w / 2], [0, w / 2 + 0.06]],
    'x', xw, R, z, TIRE, { paint: P_FIXED, seg, edgeColors: [TIRE_S, TIRE, TIRE_S, TIRE_S, HUB], ao: 0.1 },
  );
  const xf = xw + w / 2 + 0.02;
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    b.plateSide(0.07, 0.07, xf, R + Math.sin(a) * R * 0.33, z + Math.cos(a) * R * 0.33, 1, HUB_L);
  }
  b.plateSide(0.16, 0.16, xf + 0.02, R, z, 1, 0x3a3a34);
  b.vpart(K_STATIC);
}

function wheels(b: ModelBuilder, zs: number[], halfTrack: number, R: number, w: number, seg = 8): void {
  b.mirror(() => {
    for (const z of zs) tyre(b, halfTrack, R, z, w, seg);
  });
  // Achsen + Differentialgehäuse
  for (const z of zs) {
    b.cyl(0.09, halfTrack * 2 - w, 0, R, z, 'x', DARK, { paint: P_FIXED }, 5);
    if (!b.lo) b.lathe([[0.0, -0.3], [0.28, -0.1], [0.28, 0.1], [0, 0.3]], 'y', 0, R, z, 0x34342e, { paint: P_FIXED, seg: 6, rot: [0, 0, Math.PI / 2] });
  }
}

function mudguards(b: ModelBuilder, zs: number[], halfTrack: number, R: number, w: number, color = HULL_DARK): void {
  b.mirror(() => {
    for (const z of zs) {
      b.box(w + 0.12, 0.07, R * 2.1, halfTrack + 0.04, R * 2 + 0.12, z, color, { camo: 1 });
      if (!b.lo) b.box(w + 0.14, 0.4, 0.04, halfTrack + 0.04, R * 1.5, z + R * 1.05, 0x2c2c28, { paint: P_FIXED }); // Schmutzfänger
    }
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
    if (b.lo) return;
    b.box(0.2, 0.04, 0.04, x - 0.1, y + 0.12, z, DARK, { paint: P_FIXED });
    b.box(0.04, 0.04, 0.3, x - 0.2, y - 0.1, z + 0.1, DARK, { paint: P_FIXED, rot: [0, 0.5, 0] });
  });
}

function exhaust(b: ModelBuilder, x: number, y: number, z: number, h = 0.6): void {
  b.cyl(0.07, h, x, y, z, 'y', DARK, { paint: P_FIXED }, 5);
  if (!b.lo) {
    b.cyl(0.11, h * 0.5, x, y - h * 0.1, z, 'y', 0x4a4a42, { paint: P_FIXED }, 5); // Hitzeschild
    b.cyl(0.09, 0.05, x, y + h / 2 + 0.02, z, 'y', BLACK_C, { paint: P_FIXED }, 5);
  }
}
const BLACK_C = 0x101010;

function door(b: ModelBuilder, x: number, y: number, z: number, l: number, h: number, side: 1 | -1 = 1): void {
  b.plateSide(l, h, x, y, z, side, 0x20262a);
  if (b.lo) return;
  b.plateSide(0.16, 0.05, x + 0.02 * side, y - h * 0.1, z + l * 0.35, side, STEEL);
}

// -------------------------------------------------------------------------- Spähwagen 4x4

export function buildRecon4x4(): ModelDef {
  const { geom, lo } = buildVehicleGeoms((b) => {
    const L = b.lo;
    const zs = [-1.55, 1.55];
    wheels(b, zs, 1.0, 0.5, 0.36, 8);
    mudguards(b, zs, 1.0, 0.5, 0.36);
    b.extrudeX([[-2.5, 0.65], [2.5, 0.65], [2.55, 1.55], [2.1, 1.9], [-0.4, 1.95], [-1.5, 1.6], [-2.45, 1.2]], 2.1, 0, 0, 0, HULL, { camo: 0.8, taper: [1, 0.86] });
    b.box(2.2, 0.18, 0.3, 0, 0.8, -2.55, HULL_DARK, { camo: 1 });
    if (!L) {
      b.box(1.5, 0.45, 0.06, 0, 1.58, -1.15, GLASS, { paint: P_FIXED, rot: [0.65, 0, 0] });
      b.box(1.6, 0.06, 0.1, 0, 1.4, -1.35, DARK, { paint: P_FIXED }); // Scheibenrahmen
      b.mirror(() => {
        b.box(0.05, 0.3, 0.6, 1.0, 1.55, -0.1, GLASS, { paint: P_FIXED });
        door(b, 1.06, 1.35, -0.5, 0.95, 0.6);
        b.box(0.12, 0.34, 0.1, 0.95, 0.85, -2.75, STEEL, { paint: P_FIXED });
        jerry(b, 1.18, 1.0, 1.9, 0, OLIVE);
        b.box(0.5, 0.35, 0.8, 1.12, 1.2, 1.1, HULL_DARK, { camo: 1 }); // Staukasten
        smokeLaunchers(b, 0.7, 1.95, -1.3, 3, -0.2);
        b.box(0.14, 0.1, 0.05, 0.9, 1.4, 2.55, TAIL, { paint: P_FIXED, ao: 0 });
      });
      lampPair(b, 1.2, -2.5, 0.65);
      bolts(b, 0, 1.0, -2.58, 6, 0.3, 'x');
      // Winde / Abschleppseil, Reserverad
      b.cyl(0.08, 1.4, 0, 0.9, -2.72, 'x', DARK, { paint: P_FIXED }, 5);
      b.lathe([[0.42, -0.14], [0.42, 0.14], [0.2, 0.17], [0, 0.17]], 'z', 0, 1.35, 2.62, TIRE, { paint: P_FIXED, seg: 8, edgeColors: [TIRE, TIRE, HUB] });
      bag(b, 0.5, 2.0, 1.9, 0.7, 0.3, 0.6, CANVAS);
      b.cyl(0.04, 0.9, 0.5, 2.5, 1.2, 'y', 0x5a5a52, { paint: P_FIXED }, 4);
    } else {
      b.box(1.5, 0.45, 0.06, 0, 1.58, -1.15, GLASS, { paint: P_FIXED, rot: [0.65, 0, 0] });
    }
    // Sensorkopf auf Teleskopmast
    b.cyl(0.07, 1.0, 0.5, 2.45, 0.55, 'y', DARK, { paint: P_FIXED }, 5);
    b.box(0.38, 0.34, 0.4, 0.5, 3.05, 0.55, HULL_DARK, { camo: 1 });
    b.box(0.2, 0.2, 0.04, 0.5, 3.05, 0.34, GLASS_LIGHT, { paint: P_FIXED });
    // Fernbedienter MG-Turm (animiert)
    b.vpart(K_TURRET, 0, 0.6, 0.6);
    b.box(0.7, 0.35, 0.8, -0.35, 2.15, 0.6, HULL, { camo: 1, top: [0.8, 0.8] });
    if (!L) {
      sight(b, -0.55, 2.4, 0.5, 0.2, 0.14, 0.2);
      b.box(0.5, 0.04, 0.5, -0.35, 2.34, 0.8, 0xffffff, { paint: P_TEAM, ao: 0 });
    }
    b.vpart(K_GUN, 2.2, 0.35, 0.6);
    b.barrel(0.04, 1.1, -0.35, 2.2, 0.35, 0.0, GUN, L ? 4 : 6);
    if (!L) b.box(0.14, 0.16, 0.25, -0.35, 2.2, 0.45, DARK, { paint: P_FIXED });
    b.vpart(K_STATIC);
    antenna(b, -0.9, 1.9, 1.9, 2.4, 0.04);
    antenna(b, 0.9, 1.95, 2.0, 2.0, -0.05);
    mirrors(b, 1.7, -0.7, 1.15);
    exhaust(b, 1.0, 1.85, 2.1);
    if (!L) {
      b.box(1.2, 0.05, 0.9, 0, 1.97, 1.55, 0xffffff, { paint: P_TEAM, ao: 0 });
      b.box(2.0, 0.1, 0.3, 0, 1.4, 2.6, 0xffffff, { paint: P_TEAM, ao: 0 });
    }
  }, { groundAO: 0.35, groundH: 0.9 });
  return vdef(geom, lo, ANIM_RECON, 5.2);
}

// -------------------------------------------------------------------------- Radschützenpanzer 8x8

export function buildApc8x8(): ModelDef {
  const { geom, lo } = buildVehicleGeoms((b) => {
    const L = b.lo;
    const zs = [-2.7, -1.25, 1.25, 2.7];
    wheels(b, zs, 1.3, 0.62, 0.42, 9);
    mudguards(b, zs, 1.3, 0.62, 0.42);
    b.extrudeX([[-3.7, 0.75], [3.8, 0.75], [3.85, 1.9], [3.5, 2.4], [-0.6, 2.5], [-2.2, 2.2], [-3.75, 1.5]], 2.75, 0, 0, 0, HULL, { camo: 0.9, taper: [1, 0.88] });
    b.box(1.9, 0.5, 0.06, 0, 1.95, -2.8, GLASS, { paint: P_FIXED, rot: [0.7, 0, 0] });
    b.mirror(() => {
      b.box(0.14, 0.9, 1.7, 1.38, 1.65, 0.15, HULL_LIGHT, { camo: 0.8 });
      b.box(0.14, 0.7, 1.5, 1.38, 1.65, -2.5, HULL_LIGHT, { camo: 0.8 });
    });
    b.box(2.2, 1.2, 0.08, 0, 1.55, 3.88, HULL_DARK, { camo: 0.8 });
    if (!L) {
      b.mirror(() => {
        door(b, 1.46, 1.6, 0.15, 0.9, 0.9);
        b.box(0.08, 0.34, 0.5, 1.4, 1.85, -2.45, GLASS, { paint: P_FIXED });
        b.box(0.5, 0.4, 1.3, 1.45, 1.1, 0.9, HULL_DARK, { camo: 1 });
        for (let i = 0; i < 5; i++) b.box(0.05, 0.6, 0.05, 1.43, 1.65, -0.5 + i * 0.28, STEEL, { paint: P_FIXED }); // Gitterstreben
        smokeLaunchers(b, 1.2, 2.45, -1.9, 4, -0.3);
        b.box(0.14, 0.1, 0.05, 1.0, 1.2, 3.92, TAIL, { paint: P_FIXED, ao: 0 });
        b.box(0.14, 0.14, 0.24, 1.0, 0.85, -3.9, STEEL, { paint: P_FIXED });
        jerry(b, 1.45, 1.5, 3.0, 0.1);
      });
      headlightsX(b, 1.3, -3.78, 0.9);
      bolts(b, 0, 1.2, -3.8, 8, 0.32, 'x');
      b.box(2.0, 0.06, 0.6, 0, 2.28, -3.4, HULL_DARK, { rot: [-0.6, 0, 0], camo: 1 });
      // Dachluken + Notausstieg + Antennen
      hatch(b, -0.55, 2.5, 2.2, 0.34, 0, true);
      hatch(b, 0.6, 2.5, 2.2, 0.34, 0, false);
      hatch(b, -0.8, 2.47, -1.6, 0.3);
      sight(b, -0.8, 2.75, -1.9, 0.26, 0.12, 0.18);
      b.box(1.1, 0.08, 1.2, 0, 2.5, 3.3, HULL_DARK, { camo: 1 }); // Motordeck
      for (let i = 0; i < 5; i++) b.box(1.0, 0.05, 0.07, 0, 2.56, 2.9 + i * 0.2, 0x6a6a62, { paint: P_FIXED });
      // Heckklappe/Rampe
      b.box(0.06, 1.1, 0.04, 0, 1.55, 3.93, DARK, { paint: P_FIXED });
      b.box(0.2, 0.08, 0.04, 0.5, 1.75, 3.94, STEEL, { paint: P_FIXED });
      // Gitterschutz (Slat) am Heck
      for (let i = 0; i < 9; i++) b.box(0.05, 1.0, 0.05, -1.0 + i * 0.25, 1.65, 4.12, STEEL, { paint: P_FIXED });
      b.box(2.2, 0.06, 0.06, 0, 2.15, 4.12, DARK, { paint: P_FIXED });
      b.box(2.2, 0.06, 0.06, 0, 1.15, 4.12, DARK, { paint: P_FIXED });
      bag(b, 0, 2.62, 1.1, 0.9, 0.3, 0.6, CANVAS);
    }
    exhaust(b, 1.1, 2.0, 3.6);
    // RWS-Turm mit 30 mm + ATGM (animiert)
    b.lathe([[0, 0], [0.8, 0], [0.82, 0.12], [0, 0.12]], 'y', 0, 2.5, 0.2, HULL_DARK, { seg: L ? 8 : 10, ao: 0.1 });
    b.vpart(K_TURRET, 0, 0.2, 0.2);
    b.extrudeX([[-0.9, 2.62], [-0.6, 3.1], [0.7, 3.12], [0.95, 2.62]], 1.4, 0, 0, 0.2, HULL, { camo: 0.7, taper: [1, 0.8] });
    b.mirror(() => {
      b.box(0.22, 0.2, 0.7, 0.95, 2.85, -0.2, DARK, { paint: P_FIXED });
      if (!L) {
        b.box(0.14, 0.2, 0.14, 0.95, 3.0, 0.8, DARK, { paint: P_FIXED });
        b.box(0.16, 0.16, 0.1, 0.95, 2.85, -0.58, 0x6a6a62, { paint: P_FIXED });
      }
    });
    if (!L) {
      b.box(0.3, 0.24, 0.3, 0, 3.2, -0.3, GLASS_LIGHT, { paint: P_FIXED });
      b.box(0.5, 0.05, 0.6, 0, 3.14, 0.4, 0xffffff, { paint: P_TEAM, ao: 0 });
      antenna(b, 0.55, 3.05, 0.55, 2.2, 0.04);
      mgPintle(b, -0.4, 3.1, 0.35);
    }
    b.vpart(K_GUN, 2.95, -1.2, 0.2);
    b.box(0.45, 0.4, 0.5, 0, 2.95, -1.0, HULL_DARK, { camo: 1 });
    b.barrel(0.05, 2.5, 0.05, 2.95, -1.2, 0.0, GUN, L ? 4 : 6);
    b.cyl(0.07, 0.4, 0.05, 2.95, -3.2, 'z', 0x6a6a62, { paint: P_FIXED }, L ? 4 : 6);
    b.vpart(K_STATIC);
    mirrors(b, 2.1, -3.0, 1.45);
    antenna(b, 1.0, 2.55, 2.8, 2.6, 0.04);
    if (!L) {
      b.box(1.5, 0.05, 1.3, 0, 2.52, 1.2, 0xffffff, { paint: P_TEAM, ao: 0 });
      b.box(2.2, 0.12, 0.3, 0, 2.2, 3.9, 0xffffff, { paint: P_TEAM, ao: 0 });
    }
  }, { groundAO: 0.35, groundH: 1.0 });
  return vdef(geom, lo, ANIM_WHEELED, 8);
}

function headlightsX(b: ModelBuilder, y: number, z: number, x: number): void {
  lampPair(b, y, z, x);
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
  const L = b.lo;
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
  const wy = t.R + 0.62 + cabH * 0.78;
  b.box(cabW * 0.82, cabH * 0.36, 0.06, 0, wy, t.cabZ - 0.58, GLASS, { paint: P_FIXED, rot: [0.28, 0, 0] });
  b.mirror(() => {
    b.plateSide(0.9, cabH * 0.3, cabW / 2 * 0.97 - 0.02, wy, t.cabZ - 0.05, 1, 0x20303a);
    b.box(0.06, 0.28, 0.2, cabW / 2 + 0.1, wy - 0.1, t.cabZ - 0.7, DARK, { paint: P_FIXED });
  });
  b.box(cabW * 0.7, 0.4, 0.06, 0, t.R + 0.95, t.cabZ - 1.07, 0x25251f, { paint: P_FIXED });
  lampPair(b, t.R + 0.95, t.cabZ - 1.1, cabW * 0.38);
  b.box(cabW, 0.2, 0.18, 0, t.R + 0.45, t.cabZ - 1.1, 0x3a3a34, { paint: P_FIXED }); // Stoßstange
  mudguards(b, t.zs, t.halfTrack, t.R, t.w, 0x3a3a34);
  // Tank, Auspuff
  b.mirror((s) => {
    if (s === 1) b.cyl(0.28, 0.9, t.halfTrack - 0.2, t.R + 0.5, t.cabZ + 1.6, 'z', 0x5a5a52, { paint: P_FIXED }, 6);
  });
  exhaust(b, -cabW / 2 - 0.05, t.R + cabH + 0.8, t.cabZ + 0.6);
  if (L) return;
  // Kühlergrill-Lamellen, Scheibenwischer, Spiegel, Trittbretter, Dachlichter, Türen
  for (let i = 0; i < 5; i++) b.box(cabW * 0.62, 0.025, 0.04, 0, t.R + 0.82 + i * 0.075, t.cabZ - 1.1, 0x3a3a34, { paint: P_FIXED });
  b.box(0.3, 0.1, 0.14, 0, t.R + 0.72, t.cabZ - 1.12, 0x8a8a7c, { paint: P_FIXED }); // Emblem/Zugöse
  b.mirror(() => {
    door(b, cabW / 2 * 0.99, t.R + 0.62 + cabH * 0.5, t.cabZ + 0.1, 1.0, cabH * 0.75);
    b.box(0.3, 0.05, 0.9, cabW / 2 + 0.08, t.R + 0.7, t.cabZ + 0.1, 0x2c2c28, { paint: P_FIXED }); // Trittbrett
    b.box(0.04, 0.5, 0.04, cabW / 2 + 0.05, wy + 0.25, t.cabZ - 0.62, DARK, { paint: P_FIXED, rot: [0, 0, 0.1] }); // Spiegelarm
    b.box(0.12, 0.3, 0.2, cabW / 2 + 0.22, wy + 0.2, t.cabZ - 0.62, DARK, { paint: P_FIXED });
    b.box(0.2, 0.04, 0.5, cabW * 0.3, wy - 0.12, t.cabZ - 0.6, DARK, { paint: P_FIXED, rot: [0, 0, -0.25] }); // Wischer
    b.box(0.16, 0.1, 0.05, cabW * 0.32, t.R + 0.62, t.cabZ - 1.12, 0xd8d0a0, { paint: P_FIXED }); // Nebelleuchte
    b.box(0.22, 0.28, 0.5, t.halfTrack + 0.1, t.R + 0.42, t.cabZ + 1.1, 0x34342e, { paint: P_FIXED }); // Batteriekasten
  });
  b.box(cabW * 0.9, 0.1, 0.45, 0, t.R + 0.62 + cabH + 0.17, t.cabZ - 0.45, HULL_DARK, { camo: 1 }); // Sonnenblende / Dachspoiler
  antenna(b, cabW / 2 - 0.2, t.R + 0.62 + cabH + 0.1, t.cabZ + 0.5, 1.8, 0.05);
  b.box(0.7, 0.14, 0.3, 0, t.R + 0.62 + cabH + 0.18, t.cabZ + 0.35, 0x34342e, { paint: P_FIXED });
  // Ansaugschnorchel hinter der Kabine
  b.cyl(0.09, 1.6, cabW / 2 + 0.05, t.R + 1.65, t.cabZ + 0.85, 'y', DARK, { paint: P_FIXED }, 5);
  b.box(0.12, 0.1, 0.12, cabW / 2 + 0.05, t.R + 2.5, t.cabZ + 0.85, DARK, { paint: P_FIXED, rot: [0, 0, 0.6] });
  // Druckluftbehälter/Kardan unter dem Rahmen
  b.cyl(0.14, 1.2, -t.halfTrack * 0.6, t.R + 0.2, t.frameZ + t.frameL * 0.2, 'z', 0x34342e, { paint: P_FIXED }, 5);
  b.cyl(0.05, t.frameL * 0.6, 0, t.R + 0.2, t.frameZ, 'z', DARK, { paint: P_FIXED }, 4);
}

const TRUCK_STD = { zs: [-2.4, 1.2, 2.6], halfTrack: 1.0, R: 0.5, w: 0.38, cabZ: -2.7, frameL: 7.6, frameZ: 0.1, cabH: 1.7 };

// -------------------------------------------------------------------------- Raketenartillerie (MLRS)

export function buildMlrs(): ModelDef {
  const { geom, lo } = buildVehicleGeoms((b) => {
    const L = b.lo;
    truckChassis(b, { zs: [-2.6, 0.7, 2.4], halfTrack: 1.05, R: 0.55, w: 0.4, cabZ: -3.0, frameL: 8.2, frameZ: 0.2, cabH: 1.7 });
    if (!L) b.box(1.4, 0.05, 0.9, 0, 2.95, -2.9, 0xffffff, { paint: P_TEAM, ao: 0 });
    b.box(2.35, 0.2, 5.6, 0, 1.35, 1.2, 0x3a3a34, { paint: P_FIXED }); // Drehkranzplattform
    // Stützen hinten
    b.mirror(() => {
      b.box(0.16, 0.14, 1.0, 1.35, 0.9, 3.9, STEEL, { paint: P_FIXED, rot: [0, 0, 0.5] });
      b.box(0.5, 0.06, 0.5, 1.75, 0.45, 3.9, STEEL, { paint: P_FIXED });
      if (!L) {
        b.cyl(0.07, 0.8, 1.55, 0.9, 3.9, 'y', 0x7a7a72, { paint: P_FIXED }, 5);
        jerry(b, 1.2, 1.1, 0.0, 0.1);
        b.box(0.5, 0.4, 0.9, 1.2, 0.95, -0.6, HULL_DARK, { camo: 1 });
      }
    });
    if (!L) {
      for (let i = 0; i < 4; i++) b.box(2.2, 0.04, 0.05, 0, 1.47, -1.2 + i * 1.4, STEEL, { paint: P_FIXED }); // Riffelblech
      b.cyl(0.08, 1.4, 0, 1.2, 4.4, 'x', DARK, { paint: P_FIXED }, 5);
    }
    // Drehkranz (animiert: mit Turm drehen) + Startbehälter (K_GUN)
    b.vpart(K_TURRET, 0, 2.6, 2.6);
    b.cyl(0.55, 0.3, 0, 1.6, 2.6, 'y', DARK, { paint: P_FIXED }, L ? 6 : 8);
    if (!L) {
      b.box(1.6, 0.35, 0.8, 0, 1.7, 3.0, HULL_DARK, { camo: 1 }); // Ladekran-Sockel
      b.mirror(() => b.box(0.3, 0.7, 0.4, 1.15, 1.95, 2.9, 0x34342e, { paint: P_FIXED }));
    }
    b.vpart(K_GUN, 1.8, 2.4, 2.6);
    b.push(0, 1.8, 2.4, [0, 0, 0]);
    b.box(2.25, 0.32, 5.0, 0, 0.2, -2.3, HULL, { camo: 0.8 });
    b.box(2.3, 1.55, 4.6, 0, 1.15, -2.3, HULL, { camo: 0.8, top: [0.96, 1] });
    b.box(2.38, 1.6, 0.1, 0, 1.15, 0.05, HULL_DARK, { camo: 0.8 }); // Rückwand
    if (!L) {
      // Seitenholme, Kabelkanäle, Rohrmündungen
      b.mirror(() => {
        b.box(0.08, 1.5, 4.6, 1.18, 1.15, -2.3, HULL_DARK, { camo: 1 });
        for (let i = 0; i < 4; i++) b.box(0.1, 1.2, 0.08, 1.2, 1.15, -0.6 - i * 1.1, STEEL, { paint: P_FIXED });
      });
      b.box(2.1, 0.08, 4.4, 0, 1.97, -2.3, HULL_DARK, { camo: 1 });
      b.box(1.9, 0.06, 1.2, 0, 2.02, -2.0, 0xffffff, { paint: P_TEAM, ao: 0 });
    }
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) {
        const x = (c - 1.5) * 0.55, y = 0.65 + r * 0.45;
        b.lathe([[0, 0], [0.19, 0], [0.19, 0.06], [0.13, 0.06], [0, 0.04]], 'z', x, y, -4.65, DARK, { paint: P_FIXED, seg: L ? 5 : 7, edgeColors: [0x3a3a34, 0x1a1a18, 0x0e0e0c, 0x0e0e0c], ao: 0 });
      }
    }
    b.pop();
    b.vpart(K_STATIC);
  }, { groundAO: 0.35, groundH: 1.0 });
  return vdef(geom, lo, ANIM_MLRS, 9);
}

// -------------------------------------------------------------------------- Flugabwehrraketen-Startgerät

export function buildSam(): ModelDef {
  const { geom, lo } = buildVehicleGeoms((b) => {
    const L = b.lo;
    truckChassis(b, { zs: [-3.7, -2.2, 1.9, 3.4], halfTrack: 1.1, R: 0.6, w: 0.42, cabZ: -4.3, frameL: 10.4, frameZ: 0.0, cabH: 1.8 });
    if (!L) b.box(1.4, 0.05, 0.9, 0, 3.05, -4.2, 0xffffff, { paint: P_TEAM, ao: 0 });
    b.box(2.4, 0.2, 5.0, 0, 1.45, 1.8, 0x3a3a34, { paint: P_FIXED });
    b.mirror(() => {
      b.box(0.14, 0.14, 1.1, 1.4, 0.95, 4.2, STEEL, { paint: P_FIXED, rot: [0, 0, 0.55] });
      b.box(0.5, 0.06, 0.5, 1.85, 0.5, 4.2, STEEL, { paint: P_FIXED });
      b.box(0.14, 0.14, 1.1, 1.4, 0.95, -0.5, STEEL, { paint: P_FIXED, rot: [0, 0, 0.55] });
      if (!L) {
        b.box(0.5, 0.06, 0.5, 1.85, 0.5, -0.5, STEEL, { paint: P_FIXED });
        b.box(0.6, 0.6, 1.3, 1.2, 1.0, 1.0, HULL_DARK, { camo: 1 });
        jerry(b, 1.25, 1.75, 3.3, 0.1);
      }
    });
    // Drehkranz + Hubgerüst (animiert)
    b.vpart(K_TURRET, 0, 2.9, 2.9);
    b.cyl(0.8, 0.5, 0, 1.75, 2.4, 'y', DARK, { paint: P_FIXED }, L ? 6 : 10);
    if (!L) b.box(1.6, 0.3, 0.8, 0, 1.95, 3.6, HULL_DARK, { camo: 1 });
    b.vpart(K_GUN, 2.2, 2.9, 2.9);
    b.push(0, 2.2, 2.9, [0, 0, 0]);
    b.box(2.0, 0.22, 5.8, 0, 0, -2.5, HULL_DARK, { camo: 0.8 });
    for (const sx of [-0.55, 0.55]) {
      for (const sy of [0.45, 1.15]) {
        b.box(0.62, 0.62, 5.7, sx, sy, -2.55, HULL, { camo: 0.8 });
        b.box(0.5, 0.5, 0.06, sx, sy, -5.42, WHITE, { paint: P_FIXED });
        if (!L) {
          b.box(0.5, 0.5, 0.06, sx, sy, 0.3, 0x2a2a26, { paint: P_FIXED });
          b.box(0.64, 0.12, 0.6, sx, sy + 0.31, -4.9, 0xf0e0a0, { paint: P_FIXED });
          for (let k = 0; k < 3; k++) b.box(0.66, 0.66, 0.05, sx, sy, -1.2 - k * 1.6, HULL_DARK, { camo: 1 }); // Spannringe
          b.box(0.1, 0.1, 0.1, sx, sy + 0.34, -0.4, STEEL, { paint: P_FIXED });
        }
      }
    }
    if (!L) b.box(1.3, 0.05, 1.6, 0, 1.78, -3.0, 0xffffff, { paint: P_TEAM, ao: 0 });
    b.pop();
    b.vpart(K_STATIC);
    // Radarmast: drehender Flächenradar (K_RADAR)
    b.cyl(0.1, 2.2, -0.9, 2.9, -2.2, 'y', DARK, { paint: P_FIXED }, 5);
    b.vpart(K_SPIN, 4.0, -2.2);
    b.box(1.5, 1.2, 0.14, -0.9, 4.5, -2.2, 0xcfd2d0, { paint: P_FIXED });
    b.box(1.4, 1.1, 0.05, -0.9, 4.5, -2.29, 0x445058, { paint: P_FIXED });
    if (!L) {
      b.box(1.5, 0.08, 0.3, -0.9, 5.15, -2.2, DARK, { paint: P_FIXED });
      b.box(0.3, 0.5, 0.3, -0.9, 4.5, -2.0, DARK, { paint: P_FIXED });
      for (let i = 0; i < 4; i++) b.box(1.3, 0.04, 0.04, -0.9, 4.1 + i * 0.28, -2.32, 0x2a3a42, { paint: P_FIXED });
    }
    b.vpart(K_STATIC);
    antenna(b, 0.9, 3.2, -1.2, 2.0, 0.03);
  }, { groundAO: 0.35, groundH: 1.0 });
  return vdef(geom, lo, ANIM_SAM, 11);
}

// -------------------------------------------------------------------------- LKW (Versorgung)

export function buildTruck(): ModelDef {
  const { geom, lo } = buildVehicleGeoms((b) => {
    const L = b.lo;
    truckChassis(b, TRUCK_STD);
    if (!L) b.box(1.5, 0.05, 1.0, 0, 2.85, -2.6, 0xffffff, { paint: P_TEAM, ao: 0 });
    b.box(2.5, 0.14, 4.9, 0, 1.45, 1.5, HULL_DARK, { camo: 1 });
    b.mirror(() => {
      b.box(0.06, 0.5, 4.9, 1.24, 1.75, 1.5, HULL, { camo: 0.7 });
      b.box(0.2, 0.5, 0.14, 1.23, 1.35, 1.5, DARK, { paint: P_FIXED });
      if (!L) {
        for (let i = 0; i < 4; i++) b.box(0.06, 0.52, 0.06, 1.28, 1.75, -0.7 + i * 1.6, STEEL, { paint: P_FIXED }); // Bordwandstützen
        b.box(0.45, 0.4, 1.0, 1.1, 1.0, 1.6, HULL_DARK, { camo: 1 }); // Werkzeugkasten
        jerry(b, 1.3, 1.3, 0.1, 0, SAND);
        jerry(b, 1.3, 1.3, 0.35, 0, OLIVE);
      }
    });
    b.box(2.5, 0.5, 0.06, 0, 1.75, -0.95, HULL, { camo: 0.7 });
    // Plane über Spriegel
    b.extrudeX([[-2.0, 2.0], [-1.6, 3.0], [-0.8, 3.45], [0.8, 3.45], [1.6, 3.0], [2.0, 2.0]], 2.45, 0, -0.5, -0.5, 0xe8e0c8, { paint: P_CAMO, camo: 0.8, taper: [1, 0.78] });
    if (!L) {
      b.box(2.3, 0.05, 0.4, 0, 3.97, -0.5, 0xffffff, { paint: P_TEAM, ao: 0 });
      for (let i = 0; i < 5; i++) b.box(2.5, 0.06, 0.08, 0, 2.6 + (i % 2) * 0.1, -2.2 + i * 0.8, DARK, { paint: P_FIXED, rot: [0, 0, 0], top: [0.9, 1] }); // Spriegel-Bügel
      for (let i = 0; i < 4; i++) b.box(0.07, 0.9, 0.04, -1.2 + (i % 2) * 2.4, 2.3, -1.9 + i * 0.5, CANVAS, { paint: P_FIXED, rot: [0, 0, i % 2 ? 0.2 : -0.2] }); // Spannseile
      // Ladung hinten: Kisten, Fässer
      b.box(0.9, 0.7, 0.9, -0.55, 1.95, 3.3, 0x8a7a55, { paint: P_FIXED });
      b.box(0.8, 0.5, 0.8, 0.6, 1.85, 3.5, 0x6a6a50, { paint: P_FIXED });
      b.box(0.6, 0.45, 0.7, 0.5, 2.3, 3.4, 0x7a6a45, { paint: P_FIXED });
      b.cyl(0.3, 0.8, -0.5, 2.0, 2.2, 'y', 0x4a5a3a, { paint: P_FIXED }, 7);
      b.cyl(0.3, 0.8, 0.45, 1.98, 2.3, 'y', 0x4a5a3a, { paint: P_FIXED }, 7);
      b.box(2.4, 0.5, 0.08, 0, 1.75, 4.0, HULL, { camo: 0.7, rot: [-0.9, 0, 0] }); // Heckklappe offen
      b.box(2.45, 0.08, 0.1, 0, 1.4, 4.05, 0x3a3a34, { paint: P_FIXED });
      for (const s of [-1, 1]) {
        b.box(0.14, 0.12, 0.05, s * 1.1, 1.15, 4.1, TAIL, { paint: P_FIXED, ao: 0 });
        b.box(0.5, 0.4, 0.05, s * 0.9, 0.75, 4.15, 0x2c2c28, { paint: P_FIXED }); // Heckschmutzfänger
      }
      b.lathe([[0.45, -0.16], [0.45, 0.16], [0.2, 0.2], [0, 0.2]], 'z', 0, 1.1, 4.2, TIRE, { paint: P_FIXED, seg: 8, edgeColors: [TIRE, TIRE, HUB] });
      b.box(0.8, 0.06, 0.12, 0, 1.0, 4.35, 0xe8e8e0, { paint: P_FIXED }); // Kennzeichen
    }
  }, { groundAO: 0.35, groundH: 1.0 });
  return vdef(geom, lo, ANIM_TRUCK, 8);
}

// -------------------------------------------------------------------------- Tankwagen (Phase 5: Öltransport)

export function buildFuelTruck(): ModelDef {
  const { geom, lo } = buildVehicleGeoms((b) => {
    const L = b.lo;
    truckChassis(b, TRUCK_STD);
    if (!L) b.box(1.5, 0.05, 1.0, 0, 2.85, -2.6, 0xffffff, { paint: P_TEAM, ao: 0 });
    b.cyl(1.0, 5.4, 0, 2.35, 1.5, 'z', 0xb8bcbe, { paint: P_FIXED, ao: 0.2 }, L ? 8 : 12);
    if (!L) {
      for (const z of [-0.5, 1.5, 3.5]) b.cyl(1.04, 0.14, 0, 2.35, z, 'z', 0x6a6e70, { paint: P_FIXED }, 12);
      for (const z of [0.6, 2.4]) {
        b.cyl(0.38, 0.28, 0, 3.42, z, 'y', 0x5a5e60, { paint: P_FIXED }, 8);
        b.cyl(0.3, 0.06, 0, 3.6, z, 'y', 0x34383a, { paint: P_FIXED }, 8);
        b.box(0.7, 0.05, 0.05, 0, 3.64, z, DARK, { paint: P_FIXED });
      }
      b.box(0.5, 0.05, 4.8, 0, 3.38, 1.5, 0xffffff, { paint: P_TEAM, ao: 0 });
      b.box(2.1, 0.5, 0.1, 0, 1.55, 4.3, 0xd8b030, { paint: P_FIXED });
      for (let i = 0; i < 5; i++) b.box(0.28, 0.5, 0.11, -0.84 + i * 0.42, 1.55, 4.32, 0x202020, { paint: P_FIXED, rot: [0, 0, 0.5] }); // Warnstreifen
      b.cyl(0.18, 0.9, 0.55, 1.2, 4.25, 'x', 0x2a2a26, { paint: P_FIXED }, 8); // Schlauchrolle
      b.cyl(0.08, 0.2, 0.55, 1.2, 4.25, 'x', 0x7a7a72, { paint: P_FIXED }, 6);
      // Leiter, Armaturenkasten, Erdungskabel, Seitenlampen
      b.mirror((s) => {
        if (s === 1) {
          b.box(0.05, 2.0, 0.05, 1.05, 2.5, 3.9, STEEL, { paint: P_FIXED, rot: [0.0, 0, 0.1] });
          b.box(0.05, 2.0, 0.05, 1.05, 2.5, 3.5, STEEL, { paint: P_FIXED, rot: [0.0, 0, 0.1] });
          for (let i = 0; i < 6; i++) b.box(0.05, 0.05, 0.45, 1.08, 1.6 + i * 0.35, 3.7, STEEL, { paint: P_FIXED });
        }
        b.box(0.14, 0.1, 0.05, 0.9, 1.55, 4.38, TAIL, { paint: P_FIXED, ao: 0 });
        b.box(0.45, 0.5, 0.7, 1.0, 1.1, 2.6, HULL_DARK, { camo: 1 });
      });
      b.box(1.2, 0.6, 0.6, 0, 1.15, 4.2, 0x5a5e60, { paint: P_FIXED }); // Armaturen
      b.cyl(0.05, 1.2, 0, 1.4, 4.55, 'x', STEEL, { paint: P_FIXED }, 5);
      b.lathe([[0.45, -0.16], [0.45, 0.16], [0.2, 0.2], [0, 0.2]], 'z', 0, 1.1, 4.5, TIRE, { paint: P_FIXED, seg: 8, edgeColors: [TIRE, TIRE, HUB] });
    }
  }, { groundAO: 0.35, groundH: 1.0 });
  return vdef(geom, lo, ANIM_TRUCK, 8);
}

// -------------------------------------------------------------------------- Hilfskonvoi-LKW

function aidMarkings(b: ModelBuilder, bodyW: number, z0: number, z1: number, y: number): void {
  b.mirror(() => {
    b.plateSide(z1 - z0 - 0.4, 0.28, bodyW / 2 + 0.02, y + 0.55, (z0 + z1) / 2, 1, BLUE_UN);
    redCross(b, bodyW / 2 + 0.03, y - 0.15, (z0 + z1) / 2 + 0.2, 1.1, 1);
  });
}

export function buildAidTruck(): ModelDef {
  const { geom, lo } = buildVehicleGeoms((b) => {
    const L = b.lo;
    truckChassis(b, { ...TRUCK_STD, cabPaint: P_FIXED, cabColor: WHITE });
    b.mirror(() => b.plateSide(1.2, 0.2, 1.27, 2.0, -2.6, 1, BLUE_UN));
    b.box(2.55, 2.2, 5.0, 0, 2.65, 1.45, 0xf4f4f0, { paint: P_FIXED, top: [0.97, 1], ao: 0.25 });
    b.box(2.58, 0.3, 5.02, 0, 3.6, 1.45, BLUE_UN, { paint: P_FIXED, top: [0.97, 1] });
    aidMarkings(b, 2.55, -1.0, 3.9, 2.65);
    b.plateFront(2.0, 1.7, 0, 2.5, 3.96, 1, 0xe8e8e4);
    redCrossTop(b, 0, 3.77, 1.6, 1.6);
    if (!L) {
      b.box(1.0, 0.04, 0.4, 0, 2.2, -3.0, BLUE_UN, { paint: P_FIXED });
      b.box(1.3, 0.05, 0.8, 0, 3.8, 3.4, 0xffffff, { paint: P_TEAM, ao: 0 });
      b.cyl(0.02, 1.0, 0.0, 3.5, -2.6, 'y', 0x6090d0, { paint: P_FIXED }, 4, 0.02);
      b.box(0.4, 0.26, 0.04, 0.2, 4.05, -2.6, BLUE_UN, { paint: P_FIXED });
      // Hecktüren mit Griffen, Rollläden, Dachlüfter, Rundumleuchte
      b.box(0.04, 1.7, 0.05, 0, 2.5, 4.0, DARK, { paint: P_FIXED });
      b.mirror(() => {
        b.box(0.05, 0.3, 0.06, 0.1, 2.5, 4.02, STEEL, { paint: P_FIXED });
        b.box(0.14, 0.12, 0.05, 1.1, 1.55, 3.98, TAIL, { paint: P_FIXED, ao: 0 });
        b.box(0.1, 0.3, 0.6, 1.3, 2.4, 0.2, DARK, { paint: P_FIXED });
        b.box(0.4, 0.4, 0.7, 1.0, 1.1, 2.6, HULL_DARK, { camo: 1 });
      });
      b.cyl(0.25, 0.2, -0.6, 3.75, 0.5, 'y', 0xc8c8c0, { paint: P_FIXED }, 6);
      b.cyl(0.08, 0.14, 0.6, 3.72, 0.5, 'y', 0x3060ff, { paint: P_FIXED }, 6);
      b.cyl(0.04, 1.8, 0, 3.0, -2.6, 'y', DARK, { paint: P_FIXED }, 4, 0.02);
      b.lathe([[0.45, -0.16], [0.45, 0.16], [0.2, 0.2], [0, 0.2]], 'z', 0, 1.1, 4.5, TIRE, { paint: P_FIXED, seg: 8, edgeColors: [TIRE, TIRE, HUB] });
    }
  }, { groundAO: 0.35, groundH: 1.0 });
  return vdef(geom, lo, ANIM_TRUCK, 8);
}

// -------------------------------------------------------------------------- Feldlazarett (Truck + Zeltmodul)

export function buildFieldHospital(): ModelDef {
  const { geom, lo } = buildVehicleGeoms((b) => {
    const L = b.lo;
    b.push(0, 0, -5.8, [0, 0, 0], [0.85, 0.85, 0.85]);
    truckChassis(b, { zs: [-0.2, 1.4], halfTrack: 1.0, R: 0.5, w: 0.38, cabZ: -1.4, frameL: 5.0, frameZ: 0.7, cabH: 1.7, cabPaint: P_FIXED, cabColor: WHITE });
    b.box(2.55, 1.8, 2.3, 0, 2.5, 1.6, 0xf4f4f0, { paint: P_FIXED, ao: 0.25 });
    b.mirror(() => redCross(b, 1.29, 2.55, 1.6, 0.9, 1));
    b.pop();
    const zt0 = -3.2, zt1 = 6.4;
    b.slab([[-2.6, zt0], [2.6, zt0], [2.6, zt1], [-2.6, zt1]], 0.1, 2.1, 0, 0, 0, 0xf2f2ee, { paint: P_FIXED, ao: 0.3 });
    b.extrudeX([[zt0 + 0.0, 2.05], [zt0 + 0.8, 3.15], [zt1 - 0.8, 3.15], [zt1, 2.05]], 5.3, 0, 0, 0, 0xe8e8e2, { paint: P_FIXED, taper: [1, 0.55], ao: 0.15 });
    b.box(0.35, 0.08, zt1 - zt0 - 1.0, 0, 3.17, (zt0 + zt1) / 2, 0xffffff, { paint: P_TEAM, ao: 0 });
    b.mirror(() => redCrossTop(b, 1.15, 2.75, 1.8, 1.7));
    b.mirror(() => {
      redCross(b, 2.64, 1.3, 1.5, 1.3, 1);
      b.plateSide(1.0, 1.5, 2.65, 1.0, -1.0, 1, 0x7a7a6a);
    });
    b.plateFront(1.6, 1.7, 0, 1.0, zt0 - 0.02, -1, 0x6a6a5a);
    if (!L) {
      b.mirror(() => {
        for (const z of [zt0 + 0.5, (zt0 + zt1) / 2, zt1 - 0.5]) b.cyl(0.04, 1.4, 3.2, 0.7, z, 'y', DARK, { paint: P_FIXED, rot: [0, 0, 0.5] }, 4);
        // Zeltnähte, Fenster, Vordach
        for (let i = 0; i < 6; i++) b.box(0.05, 0.05, 0.04, 2.62, 1.5, zt0 + 1.0 + i * 1.6, DARK, { paint: P_FIXED });
        b.plateSide(1.0, 0.5, 2.62, 1.6, 4.0, 1, 0x8ab0c0);
        b.plateSide(1.0, 0.5, 2.62, 1.6, -0.5, 1, 0x8ab0c0);
        b.cyl(0.02, 3.0, 2.2, 1.0, zt0 + 0.1, 'y', DARK, { paint: P_FIXED }, 4);
        // Zeltpfosten
        b.box(0.08, 2.2, 0.08, 2.65, 1.1, zt0 + 0.05, DARK, { paint: P_FIXED });
        b.box(0.08, 2.2, 0.08, 2.65, 1.1, zt1 - 0.05, DARK, { paint: P_FIXED });
      });
      b.box(2.0, 0.08, 1.2, 0, 2.3, zt0 - 0.6, 0xe8e8e2, { paint: P_FIXED, rot: [0.25, 0, 0] }); // Vordach
      for (const x of [-1, 1]) b.box(0.06, 2.1, 0.06, x, 1.05, zt0 - 1.1, DARK, { paint: P_FIXED });
      // Generator, Klimagerät, Lichtmast, Sanitätskisten, Tragen
      b.box(1.0, 0.8, 1.6, -3.3, 0.5, 4.8, 0x5a6a4a, { paint: P_FIXED });
      b.box(0.8, 0.12, 1.4, -3.3, 0.96, 4.8, 0x4a5a3a, { paint: P_FIXED });
      b.box(0.9, 0.7, 0.9, 3.3, 0.5, 4.5, 0x8a8a84, { paint: P_FIXED });
      for (let i = 0; i < 4; i++) b.box(0.7, 0.04, 0.05, 3.3, 0.7 + i * 0.12, 4.05, 0x5a5a54, { paint: P_FIXED });
      b.cyl(0.05, 4.2, -3.3, 2.3, 3.2, 'y', DARK, { paint: P_FIXED }, 4, 0.03);
      b.box(0.5, 0.2, 0.3, -3.3, 4.4, 3.2, 0xe8e0a0, { paint: P_FIXED });
      b.box(0.5, 0.4, 0.6, 3.3, 0.25, 2.5, 0x6a7a5a, { paint: P_FIXED });
      b.box(0.5, 0.3, 0.5, 3.4, 0.2, 1.7, WHITE, { paint: P_FIXED });
      b.box(0.1, 0.1, 2.0, -3.2, 0.3, 1.0, 0x6a7a5a, { paint: P_FIXED });
    } else {
      b.box(1.0, 0.8, 1.6, -3.3, 0.5, 4.8, 0x5a6a4a, { paint: P_FIXED });
    }
  }, { groundAO: 0.4, groundH: 1.0 });
  return vdef(geom, lo, ANIM_TRUCK, 14);
}

// -------------------------------------------------------------------------- Krankenwagen

export function buildAmbulance(): ModelDef {
  const { geom, lo } = buildVehicleGeoms((b) => {
    const L = b.lo;
    const zs = [-1.6, 1.7];
    wheels(b, zs, 1.0, 0.48, 0.34);
    mudguards(b, zs, 1.0, 0.48, 0.34, 0x5a5a52);
    b.box(2.2, 0.2, 5.4, 0, 0.6, 0.1, 0x3a3a34, { paint: P_FIXED });
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
    b.box(1.0, 0.1, 0.22, 0, 2.15, -1.0, 0x3060ff, { paint: P_FIXED });
    lampPair(b, 1.0, -2.8, 0.7);
    if (!L) {
      b.box(1.3, 0.05, 0.7, 0, 2.72, 2.3, 0xffffff, { paint: P_TEAM, ao: 0 });
      mirrors(b, 1.9, -1.8, 1.2);
      b.box(1.8, 0.2, 0.2, 0, 0.55, -2.9, 0x3a3a34, { paint: P_FIXED }); // Stoßstange
      b.box(0.04, 1.6, 0.05, 0, 1.7, 2.82, DARK, { paint: P_FIXED });
      b.mirror(() => {
        b.plateSide(0.16, 0.05, 1.12, 1.5, -0.8, 1, STEEL);
        b.box(0.14, 0.12, 0.05, 0.9, 1.0, 2.82, TAIL, { paint: P_FIXED, ao: 0 });
        b.box(0.2, 0.1, 0.18, 0.5, 2.3, -1.0, 0x3060ff, { paint: P_FIXED });
        b.box(0.05, 0.3, 0.05, 1.12, 1.9, 2.8, STEEL, { paint: P_FIXED });
      });
      exhaust(b, -1.05, 0.85, 2.8, 0.4);
      antenna(b, 0.8, 2.2, 0.6, 1.6, 0.04);
      b.lathe([[0.38, -0.12], [0.38, 0.12], [0.16, 0.15], [0, 0.15]], 'z', 0, 0.9, 3.0, TIRE, { paint: P_FIXED, seg: 8, edgeColors: [TIRE, TIRE, HUB] });
    }
  }, { groundAO: 0.35, groundH: 0.9 });
  return vdef(geom, lo, ANIM_TRUCK, 6);
}

export { RUBBER, bolts, hatch, sight, smokeLaunchers };
