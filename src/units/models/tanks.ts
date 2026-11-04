/** Phase 4 – Kettenfahrzeuge: Kampfpanzer (3 Stile), leichter Panzer, Schützenpanzer, Panzerhaubitze, Flakpanzer. */
import {
  BLACK, DARK, GLASS, GLASS_LIGHT, GUN, HULL, HULL_DARK, HULL_LIGHT, ModelBuilder, P_CAMO, P_FIXED, P_TEAM, RUBBER, STEEL, TRACK, V3,
  type ModelDef,
} from './geomUtils';

export type TankStyle = 'abrams' | 'west' | 'ru';

const HUB = 0x5a5a52;

/** Laufwerk einer Seite (x > 0 gebaut, per mirror gespiegelt) */
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
  /** Kettenband: Außen-x des Bandes */
  rSprocket?: number;
}

function gear(b: ModelBuilder, g: GearOpts): void {
  const rS = g.rSprocket ?? 0.46;
  const yW = g.rWheel + 0.05;
  const zF = g.zFront, zR = g.zRear;
  // Kettenband (Seitenprofil), Außenseite etwas heller (Kettenglieder)
  b.extrudeX(
    [[zF + 0.1, 0.02], [zR - 0.15, 0.02], [zR + 0.1, 0.55], [zR - 0.1, g.beltTop - 0.05], [zR - 0.5, g.beltTop], [zF + 0.5, g.beltTop], [zF - 0.05, 0.55]],
    g.beltW, g.x, 0, 0, TRACK, { paint: P_FIXED, ao: 0.35 },
  );
  // Laufrollen
  const span = (zR - 0.9) - (zF + 0.9);
  for (let i = 0; i < g.nWheels; i++) {
    const z = zF + 0.95 + (span * i) / Math.max(1, g.nWheels - 1);
    const R = g.rWheel;
    b.lathe([[R, -g.wheelW / 2], [R, g.wheelW / 2], [0, g.wheelW / 2 + 0.07]], 'x', g.x + g.beltW / 2 - 0.08, yW, z, RUBBER, { paint: P_FIXED, seg: 6, edgeColors: [RUBBER, HUB], ao: 0.1 });
  }
  // Leitrad vorn, Treibrad hinten (größer, mit Zähnen angedeutet)
  b.lathe([[0.42, -g.wheelW / 2], [0.42, g.wheelW / 2], [0, g.wheelW / 2 + 0.08]], 'x', g.x + g.beltW / 2 - 0.08, 0.5, zF + 0.3, RUBBER, { paint: P_FIXED, seg: 7, edgeColors: [RUBBER, HUB], ao: 0.1 });
  b.lathe([[rS, -g.wheelW / 2], [rS, g.wheelW / 2], [0, g.wheelW / 2 + 0.1]], 'x', g.x + g.beltW / 2 - 0.08, 0.58, zR - 0.15, 0x3a3a34, { paint: P_FIXED, seg: 8, edgeColors: [0x3a3a34, HUB], ao: 0.1 });
  // Stützrollen
  for (let i = 0; i < g.rollers; i++) {
    const z = zF + 1.3 + ((zR - zF - 2.6) * i) / Math.max(1, g.rollers - 1);
    b.lathe([[0.14, -0.08], [0.14, 0.08], [0, 0.08]], 'x', g.x + g.beltW / 2 - 0.05, g.beltTop - 0.12, z, RUBBER, { paint: P_FIXED, seg: 5 });
  }
  if (g.skirt) {
    const s = g.skirt;
    const xs = g.x + g.beltW / 2 + 0.12;
    const L = s.z1 - s.z0;
    const n = Math.max(2, Math.round(L / 1.9));
    // Schürzenplatten (leicht versetzt = sichtbare Fugen)
    for (let i = 0; i < n; i++) {
      const pl = L / n;
      b.box(0.1, s.y1 - s.y0, pl - 0.05, xs, (s.y0 + s.y1) / 2, s.z0 + pl * (i + 0.5), HULL, { camo: 0.8, ao: 0.28 });
    }
    // Kotflügel
    b.box(0.55, 0.07, L + 0.3, g.x + 0.05, s.y1 + 0.03, (s.z0 + s.z1) / 2, HULL_DARK, { camo: 1 });
    b.box(0.8, 0.06, 0.7, xs - 0.1, s.y1 - 0.15, s.z0 - 0.15, HULL_DARK, { rot: [0.35, 0, 0] });
  }
}

/** Kommandanten-/Ladeschützenluke mit MG */
function cupola(b: ModelBuilder, x: number, y: number, z: number, r: number, mg: boolean, big = false): void {
  b.lathe([[r, 0], [r * 0.92, 0.24], [0, 0.27]], 'y', x, y, z, HULL, { seg: big ? 8 : 6, ao: 0.15 });
  b.lathe([[r * 1.02, 0.1], [r * 1.0, 0.2]], 'y', x, y, z, GLASS, { seg: big ? 8 : 6, paint: P_FIXED, ao: 0, both: true });
  if (mg) {
    b.box(0.12, 0.14, 0.4, x + 0.02, y + 0.36, z - 0.05, DARK, { paint: P_FIXED });
    b.barrel(0.035, 0.75, x + 0.02, y + 0.38, z - 0.1, 0.05, DARK, 4);
  }
}

function smokeRack(b: ModelBuilder, x: number, y: number, z: number): void {
  b.box(0.34, 0.3, 0.24, x, y, z, HULL_DARK, { rot: [0, 0, 0], ao: 0.1 });
  b.box(0.3, 0.26, 0.04, x, y, z - 0.13, BLACK, { paint: P_FIXED, ao: 0 });
}

/** Kanone: Pivot lokal, entlang −z */
function mainGun(b: ModelBuilder, style: TankStyle, len: number, r: number): void {
  const R = r;
  // Rohr, Kegelstumpf
  b.cyl(R * 1.15, len * 0.45, 0, 0, -len * 0.225, 'z', GUN, { paint: P_FIXED }, 6, R * 1.05);
  b.cyl(R, len * 0.55, 0, 0, -len * 0.45 - len * 0.275, 'z', GUN, { paint: P_FIXED }, 6, R * 0.92);
  // Rohrwärmehülle/Rauchabsauger
  if (style === 'west') b.cyl(R * 1.3, len * 0.42, 0, 0, -len * 0.55, 'z', 0x7a7a72, { paint: P_FIXED }, 6, R * 1.3);
  else b.cyl(R * 1.5, 0.75, 0, 0, -len * 0.55, 'z', 0x7a7a72, { paint: P_FIXED }, 6, R * 1.5);
  // Mündungsfeuerdämpfer / Mündungsbremse
  if (style === 'ru') {
    b.cyl(R * 1.25, 0.28, 0, 0, -len + 0.14, 'z', 0x6a6a62, { paint: P_FIXED }, 6, R * 1.25);
  } else b.cyl(R * 1.2, 0.2, 0, 0, -len + 0.1, 'z', 0x6a6a62, { paint: P_FIXED }, 6, R * 1.2);
  b.cyl(R * 0.5, 0.05, 0, 0, -len - 0.01, 'z', BLACK, { paint: P_FIXED }, 4, R * 0.5);
}

function tankHull(b: ModelBuilder, style: TankStyle): void {
  if (style === 'west') {
    gearBoth(b, { x: 1.5, zFront: -3.55, zRear: 3.7, nWheels: 7, rWheel: 0.4, wheelW: 0.34, beltW: 0.6, beltTop: 1.0, rollers: 3, skirt: { z0: -2.5, z1: 3.3, y0: 0.7, y1: 1.5 } });
    b.extrudeX([[-3.5, 0.55], [3.9, 0.55], [3.9, 1.35], [3.3, 1.55], [-2.3, 1.6], [-3.85, 1.0]], 2.9, 0, 0, 0, HULL, { camo: 0.9, taper: [1, 0.94] });
    // oberes Glacis: Aufsatz / Fahrerklappe
    b.box(0.8, 0.1, 0.7, 0, 1.63, -2.3, HULL_DARK, { camo: 1 });
    // Bugpanzerung unten + Abschleppseile / Haken
    b.box(2.7, 0.2, 0.3, 0, 0.85, -3.75, HULL_DARK, { camo: 1 });
    for (const s of [-1, 1]) b.cyl(0.035, 3.6, s * 0.9, 1.67, -1.9, 'z', DARK, { paint: P_FIXED, rot: [-0.13, 0, 0] }, 4);
    for (const s of [-1, 1]) b.box(0.18, 0.18, 0.2, s * 1.2, 0.8, -3.9, STEEL, { paint: P_FIXED });
    // Motorraum: Gitter + Abluft
    b.box(2.0, 0.05, 2.2, 0, 1.62, 2.55, 0x4a4a44, { paint: P_FIXED });
    for (let i = 0; i < 6; i++) b.box(1.9, 0.07, 0.07, 0, 1.67, 1.6 + i * 0.37, 0x6a6a62, { paint: P_FIXED });
    b.box(2.3, 0.7, 0.2, 0, 1.0, 3.95, HULL_DARK, { camo: 1 });
    // Heckkasten / Rauchkerzen
    b.box(0.9, 0.5, 0.7, -0.9, 1.9, 3.1, HULL_DARK, { camo: 0.8 });
    b.box(0.9, 0.45, 0.7, 0.9, 1.85, 3.1, HULL_LIGHT, { camo: 0.8 });
  } else if (style === 'abrams') {
    gearBoth(b, { x: 1.62, zFront: -3.7, zRear: 3.85, nWheels: 7, rWheel: 0.4, wheelW: 0.34, beltW: 0.62, beltTop: 1.0, rollers: 4, skirt: { z0: -2.8, z1: 3.5, y0: 0.7, y1: 1.5 } });
    b.extrudeX([[-3.55, 0.55], [3.95, 0.55], [3.95, 1.3], [3.4, 1.5], [-2.0, 1.52], [-3.85, 0.95]], 3.0, 0, 0, 0, HULL, { camo: 0.9, taper: [1, 0.95] });
    b.box(2.9, 0.18, 0.4, 0, 0.9, -3.8, HULL_DARK, { camo: 1 });
    b.box(0.9, 0.12, 0.6, 0, 1.58, -2.4, HULL_DARK, { camo: 1 });
    for (const s of [-1, 1]) b.cyl(0.035, 3.0, s * 1.0, 1.52, -2.6, 'z', DARK, { paint: P_FIXED, rot: [-0.1, 0, 0] }, 4);
    // Turbinen-Abluftgitter groß
    b.box(2.4, 0.05, 2.5, 0, 1.55, 2.6, 0x4a4a44, { paint: P_FIXED });
    for (let i = 0; i < 7; i++) b.box(2.3, 0.07, 0.08, 0, 1.6, 1.5 + i * 0.36, 0x6a6a62, { paint: P_FIXED });
    b.box(2.6, 0.5, 0.2, 0, 0.95, 4.0, HULL_DARK, { camo: 1 });
  } else {
    // ru (T-90): kürzer, flacher; Stützrollen sichtbar, Gummischürzen vorn
    gearBoth(b, { x: 1.45, zFront: -3.2, zRear: 3.45, nWheels: 6, rWheel: 0.42, wheelW: 0.3, beltW: 0.58, beltTop: 1.0, rollers: 3, skirt: { z0: -3.0, z1: -0.6, y0: 0.75, y1: 1.4 } });
    b.extrudeX([[-3.1, 0.55], [3.55, 0.55], [3.55, 1.2], [3.0, 1.38], [-1.9, 1.42], [-3.4, 0.85]], 2.7, 0, 0, 0, HULL, { camo: 0.9, taper: [1, 0.92] });
    // Kettenabdeckungen (Schutzbleche) seitlich
    for (const s of [-1, 1]) b.box(0.5, 0.06, 6.0, s * 1.5, 1.4, 0.2, HULL_DARK, { camo: 1 });
    // Dachwanne: Dämpfer / Wasserfurt-Klappe vorn
    b.box(2.2, 0.28, 0.12, 0, 1.55, -2.3, HULL_DARK, { rot: [-0.5, 0, 0] });
    // ERA-Blöcke am oberen Glacis
    for (let i = 0; i < 6; i++) b.box(0.4, 0.1, 0.42, -1.0 + i * 0.4, 1.5 - 0.0, -2.7 + i * 0.0, 0x7a7a70, { camo: false, rot: [-0.33, 0, 0] });
    // Ersatz-Treibstofffässer + Baumstamm hinten
    for (const s of [-1, 1]) b.cyl(0.24, 1.4, s * 0.9, 1.7, 2.9, 'z', 0x5a5a50, { paint: P_FIXED }, 6);
    b.cyl(0.14, 2.5, 0, 1.95, 3.05, 'x', DARK, { paint: P_FIXED }, 5);
    b.box(2.0, 0.05, 1.7, 0, 1.45, 2.4, 0x4a4a44, { paint: P_FIXED });
    for (let i = 0; i < 4; i++) b.box(1.9, 0.06, 0.07, 0, 1.49, 1.7 + i * 0.4, 0x6a6a62, { paint: P_FIXED });
    b.box(2.4, 0.6, 0.2, 0, 0.95, 3.55, HULL_DARK, { camo: 1 });
  }
}

function gearBoth(b: ModelBuilder, g: GearOpts): void {
  b.mirror(() => gear(b, g));
}

function turret(b: ModelBuilder, style: TankStyle, heavy: boolean): void {
  if (style === 'west') {
    // Leopard-2-artig: kantig, flache Dachpartie, Keilpanzerung
    b.lathe([[0, 0], [1.35, 0], [1.4, 0.18], [0, 0.18]], 'y', 0, 1.55, -0.2, HULL_DARK, { seg: 10, ao: 0.1 });
    b.extrudeX([[-2.0, 1.7], [-1.55, 2.45], [1.0, 2.5], [1.7, 2.35], [1.9, 2.0], [1.9, 1.7]], 2.5, 0, 0, 0, HULL, { camo: 0.8, taper: [1, 0.84] });
    b.mirror(() => {
      b.extrudeX([[-2.35, 1.8], [-1.6, 2.35], [-0.6, 2.35], [-0.6, 1.8]], 0.55, 1.45, 0, 0, HULL_LIGHT, { camo: 0.8, taper: [1, 0.7] });
      b.extrudeX([[-0.2, 1.8], [1.6, 1.8], [1.6, 2.25], [-0.2, 2.3]], 0.28, 1.4, 0, 0.2, HULL, { camo: 0.8 });
    });
    // Rohrblende
    b.box(1.1, 0.75, 0.5, 0, 2.15, -2.2, HULL_DARK, { camo: 1, top: [0.9, 0.9] });
    b.push(0, 2.15, -2.45, [heavy ? 0.04 : 0.03, 0, 0]);
    mainGun(b, 'west', 6.0, 0.075);
    b.pop();
    // Heck: Turmkorb
    b.box(2.6, 0.9, 0.9, 0, 2.05, 2.3, HULL, { camo: 0.8, top: [0.92, 1] });
    // Optiken, Kommandant (rechts), Lader (links)
    b.box(0.34, 0.28, 0.45, 0.6, 2.65, -0.95, GLASS_LIGHT, { paint: P_FIXED });
    b.box(0.5, 0.3, 0.5, 0.6, 2.58, -0.95, HULL_DARK, { camo: 1 });
    cupola(b, 0.7, 2.5, 0.5, 0.36, true, true);
    b.box(0.3, 0.22, 0.3, 0.7, 2.9, -0.05, BLACK, { paint: P_FIXED, ao: 0 }); // Kdt-Sehrohr
    cupola(b, -0.65, 2.45, 0.7, 0.34, true);
    smokeRack(b, -1.62, 2.05, -1.35);
    smokeRack(b, 1.62, 2.05, -1.35);
    smokeRack(b, -1.62, 2.05, -1.0);
    smokeRack(b, 1.62, 2.05, -1.0);
    // Antennen
    b.cyl(0.03, 3.0, 1.05, 3.9, 2.0, 'y', DARK, { paint: P_FIXED }, 4, 0.015);
    b.cyl(0.05, 0.3, 1.05, 2.5, 2.0, 'y', DARK, { paint: P_FIXED }, 5);
    b.cyl(0.025, 2.0, -1.05, 3.4, 2.05, 'y', DARK, { paint: P_FIXED }, 4, 0.012);
    // Team-Erkennungstafel Turmdach
    b.box(1.5, 0.05, 0.6, -0.1, 2.52, 1.4, 0xffffff, { paint: P_TEAM, ao: 0 });
    b.box(2.55, 0.18, 0.35, 0, 1.78, 3.45, 0xffffff, { paint: P_TEAM, ao: 0 });
  } else if (style === 'abrams') {
    // Abrams-artig: breit, lange flache Seitenwände, Heckkorb
    b.lathe([[0, 0], [1.4, 0], [1.45, 0.18], [0, 0.18]], 'y', 0, 1.5, 0, HULL_DARK, { seg: 10, ao: 0.1 });
    b.extrudeX([[-2.55, 1.65], [-2.0, 2.3], [0.8, 2.38], [1.6, 2.3], [1.8, 1.9], [1.8, 1.65]], 2.65, 0, 0, 0, HULL, { camo: 0.8, taper: [1, 0.88] });
    b.mirror(() => {
      b.extrudeX([[-2.7, 1.7], [-1.9, 2.15], [-0.3, 2.2], [-0.3, 1.7]], 0.55, 1.28, 0, 0, HULL_LIGHT, { camo: 0.8, taper: [1, 0.78] });
    });
    // Heckkorb (Bustle)
    b.box(2.9, 0.95, 1.8, 0, 2.05, 2.55, HULL, { camo: 0.8, top: [0.93, 1] });
    b.box(2.3, 0.3, 0.8, 0, 2.62, 2.3, HULL_DARK, { camo: 1 });
    b.box(1.0, 0.7, 0.5, 0, 2.1, -2.75, HULL_DARK, { camo: 1, top: [0.9, 0.8] });
    b.push(0, 2.1, -3.0, [0.03, 0, 0]);
    mainGun(b, 'abrams', 5.4, 0.07);
    b.pop();
    // Kommandanten-Waffenstation (CROWS) & Lader-MG
    cupola(b, 0.65, 2.36, 0.25, 0.35, false, true);
    b.box(0.5, 0.38, 0.5, 0.65, 2.78, 0.2, HULL_DARK, { camo: 1 });
    b.barrel(0.04, 1.0, 0.6, 2.8, 0.0, 0.0, DARK, 4);
    cupola(b, -0.7, 2.3, 0.75, 0.34, true);
    b.box(0.3, 0.3, 0.4, 0.55, 2.52, -0.85, GLASS_LIGHT, { paint: P_FIXED });
    smokeRack(b, -1.4, 2.25, -1.6);
    smokeRack(b, 1.4, 2.25, -1.6);
    smokeRack(b, -1.4, 2.25, -1.25);
    smokeRack(b, 1.4, 2.25, -1.25);
    b.cyl(0.03, 3.2, 1.2, 4.0, 2.0, 'y', DARK, { paint: P_FIXED }, 4, 0.015);
    b.box(1.5, 0.05, 0.7, -0.3, 2.43, 1.2, 0xffffff, { paint: P_TEAM, ao: 0 });
    b.box(2.95, 0.2, 0.35, 0, 1.78, 3.5, 0xffffff, { paint: P_TEAM, ao: 0 });
  } else {
    // T-90-artig: niedrig, rund, vorn spitz-ovale Kuppel
    b.lathe([[0, 0], [1.3, 0], [1.34, 0.16], [0, 0.16]], 'y', 0, 1.42, -0.1, HULL_DARK, { seg: 10, ao: 0.1 });
    b.lathe([[0, 0], [1, 0], [1, 0.12], [0.93, 0.42], [0.72, 0.72], [0.42, 0.9], [0, 0.96]], 'y', 0, 1.55, -0.1, HULL, { seg: 10, squash: [1.3, 1, 1.75], ao: 0.25, camo: false });
    // gewölbte Dachfläche in Tarnzellen (Boxen als Panzerung)
    b.mirror(() => {
      b.box(0.9, 0.5, 1.2, 0.8, 2.05, -1.05, HULL, { camo: 0.5, rot: [0, 0.32, 0.0] }); // Backen
    });
    b.box(1.2, 0.5, 0.5, 0, 1.95, -2.0, HULL_DARK, { camo: 1 }); // Blende
    b.push(0, 2.0, -2.25, [0.03, 0, 0]);
    mainGun(b, 'ru', 5.2, 0.07);
    b.pop();
    // Shtora-Scheinwerfer
    b.box(0.5, 0.38, 0.3, -0.55, 2.2, -1.95, 0x802020, { paint: P_FIXED, ao: 0.1 });
    b.box(0.5, 0.38, 0.3, 0.55, 2.2, -1.95, 0x802020, { paint: P_FIXED, ao: 0.1 });
    // ERA-Blöcke Turmfront/Seiten
    for (let i = 0; i < 4; i++) {
      b.box(0.34, 0.34, 0.14, -0.9 + i * 0.6, 2.35, -1.55, 0x7a7a70, { camo: false, rot: [-0.35, 0, 0], ao: 0.1 });
      b.mirror(() => b.box(0.14, 0.34, 0.34, 1.45, 2.05, -0.5 + i * 0.4, 0x7a7a70, { camo: false, ao: 0.1 }));
    }
    cupola(b, -0.55, 2.38, 0.25, 0.34, true, true);
    cupola(b, 0.65, 2.25, 0.5, 0.3, false);
    b.box(0.34, 0.2, 0.4, 0.5, 2.55, -0.55, GLASS_LIGHT, { paint: P_FIXED });
    // Rauchwerfer
    for (let i = 0; i < 4; i++) {
      b.box(0.12, 0.2, 0.12, -1.2 + i * 0.0 - 0.0, 2.18, -0.9 + i * 0.22, DARK, { paint: P_FIXED, rot: [0, 0, 0.4] });
      b.box(0.12, 0.2, 0.12, 1.2, 2.18, -0.9 + i * 0.22, DARK, { paint: P_FIXED, rot: [0, 0, -0.4] });
    }
    b.cyl(0.03, 3.4, 0.95, 4.0, 1.4, 'y', DARK, { paint: P_FIXED }, 4, 0.015);
    b.box(1.2, 0.05, 0.6, -0.2, 2.5, 0.8, 0xffffff, { paint: P_TEAM, ao: 0 });
    b.box(2.45, 0.16, 0.3, 0, 1.78, 3.3, 0xffffff, { paint: P_TEAM, ao: 0 });
  }
  if (heavy) {
    // Zusatzpanzerung: Keilplatten auf der Turmfront
    b.mirror(() => b.box(0.5, 0.45, 0.9, 1.05, 2.2, -1.6, HULL_DARK, { camo: 0.7, top: [0.7, 0.8] }));
  }
}

export function buildMbt(style: TankStyle, heavy: boolean): ModelDef {
  const b = new ModelBuilder();
  const k = heavy ? 1.08 : 1;
  b.push(0, 0, 0, [0, 0, 0], [k, k, k]);
  tankHull(b, style);
  turret(b, style, heavy);
  b.pop();
  return { geom: b.build({ groundAO: 0.32, groundH: 0.9 }), size: heavy ? 10.2 : 9.5, boost: 1, livery: 'ground', tilt: true };
}

// ------------------------------------------------------------------------- leichter Kampfpanzer

export function buildLightTank(): ModelDef {
  const b = new ModelBuilder();
  b.mirror(() => gear(b, { x: 1.3, zFront: -3.0, zRear: 3.2, nWheels: 6, rWheel: 0.34, wheelW: 0.28, beltW: 0.5, beltTop: 0.85, rollers: 2, rSprocket: 0.4, skirt: { z0: -2.3, z1: 2.8, y0: 0.6, y1: 1.3 } }));
  b.extrudeX([[-2.9, 0.45], [3.2, 0.45], [3.2, 1.15], [2.7, 1.3], [-1.8, 1.32], [-3.2, 0.85]], 2.4, 0, 0, 0, HULL, { camo: 0.9, taper: [1, 0.92] });
  b.box(0.7, 0.1, 0.5, 0, 1.37, -2.1, HULL_DARK, { camo: 1 });
  b.box(1.9, 0.05, 1.6, 0, 1.33, 2.4, 0x4a4a44, { paint: P_FIXED });
  for (let i = 0; i < 4; i++) b.box(1.8, 0.06, 0.07, 0, 1.38, 1.8 + i * 0.35, 0x6a6a62, { paint: P_FIXED });
  // Turm (flach, Kanone 105/120)
  b.lathe([[0, 0], [1.1, 0], [1.14, 0.14], [0, 0.14]], 'y', 0, 1.3, 0.3, HULL_DARK, { seg: 9, ao: 0.1 });
  b.extrudeX([[-1.8, 1.42], [-1.3, 1.98], [0.9, 2.0], [1.5, 1.85], [1.55, 1.42]], 2.1, 0, 0, 0.2, HULL, { camo: 0.8, taper: [1, 0.8] });
  b.box(0.9, 0.55, 0.4, 0, 1.72, -1.9, HULL_DARK, { camo: 1 });
  b.push(0, 1.72, -2.1, [0.03, 0, 0]);
  b.cyl(0.095, 1.2, 0, 0, -0.6, 'z', 0x7a7a72, { paint: P_FIXED }, 6);
  b.cyl(0.08, 3.5, 0, 0, -1.2 - 1.75, 'z', GUN, { paint: P_FIXED }, 6, 0.07);
  b.cyl(0.11, 0.3, 0, 0, -4.5, 'z', 0x6a6a62, { paint: P_FIXED }, 6);
  b.pop();
  cupola(b, 0.55, 2.0, 0.5, 0.3, true);
  cupola(b, -0.55, 1.95, 0.7, 0.28, true);
  b.box(0.3, 0.25, 0.35, 0.5, 2.2, -0.7, GLASS_LIGHT, { paint: P_FIXED });
  for (const s of [-1, 1]) smokeRack(b, s * 1.3, 1.75, -1.3);
  b.cyl(0.03, 2.4, 0.85, 3.2, 1.5, 'y', DARK, { paint: P_FIXED }, 4, 0.015);
  b.box(1.3, 0.05, 0.6, 0, 2.02, 0.9, 0xffffff, { paint: P_TEAM, ao: 0 });
  b.box(2.3, 0.14, 0.3, 0, 1.25, 3.2, 0xffffff, { paint: P_TEAM, ao: 0 });
  return { geom: b.build({ groundAO: 0.32, groundH: 0.9 }), size: 7, boost: 1, livery: 'ground', tilt: true };
}

// ------------------------------------------------------------------------- Schützenpanzer

export function buildIfv(style: TankStyle): ModelDef {
  const b = new ModelBuilder();
  const ru = style === 'ru';
  b.mirror(() => gear(b, { x: 1.4, zFront: -3.3, zRear: 3.5, nWheels: 6, rWheel: 0.36, wheelW: 0.3, beltW: 0.55, beltTop: 0.95, rollers: 3, rSprocket: 0.42, skirt: ru ? { z0: -2.4, z1: 1.2, y0: 0.7, y1: 1.4 } : { z0: -2.6, z1: 3.1, y0: 0.65, y1: 1.45 } }));
  // Wanne, hinten hoch (Mannschaftsraum), Bugkeil
  b.extrudeX([[-3.2, 0.5], [3.5, 0.5], [3.5, 1.9], [3.1, 2.1], [-0.8, 2.15], [-2.3, 1.55], [-3.4, 1.05]], 2.7, 0, 0, 0, HULL, { camo: 0.9, taper: [1, 0.9] });
  // Fahrerluke, Dachluken hinten
  b.box(0.7, 0.14, 0.7, -0.75, 1.62, -2.1, HULL_DARK, { rot: [-0.3, 0, 0], camo: 1 });
  b.box(0.5, 0.1, 0.5, -0.75, 1.75, -2.1, GLASS, { paint: P_FIXED, rot: [-0.3, 0, 0] });
  for (let i = 0; i < 2; i++) b.box(0.8, 0.1, 0.8, 0, 2.22, 1.5 + i * 1.1, HULL_DARK, { camo: 1 });
  // Heckrampe angedeutet (dunkle Linie) + Auspuffgitter
  b.box(2.2, 1.2, 0.06, 0, 1.3, 3.54, HULL_DARK, { camo: 0.8 });
  b.box(1.8, 0.08, 0.08, 0, 2.1, 3.5, DARK, { paint: P_FIXED });
  // Turm mit Maschinenkanone + Panzerabwehrlenkwaffe
  if (ru) {
    b.lathe([[0, 0], [1, 0], [1.02, 0.16], [0.86, 0.56], [0.5, 0.74], [0, 0.78]], 'y', 0, 2.1, -0.9, HULL, { seg: 8, squash: [1.2, 1, 1.4], ao: 0.25 });
    b.box(0.5, 0.5, 0.6, 0, 2.5, -1.9, HULL_DARK, { camo: 1 });
    b.barrel(0.07, 3.2, 0, 2.55, -2.2, 0.02, GUN, 6);
    b.barrel(0.04, 3.0, 0.4, 2.45, -2.1, 0.02, DARK, 4);
    b.mirror(() => b.box(0.15, 0.13, 0.9, 1.1, 2.72, -0.6, DARK, { paint: P_FIXED })); // ATGM-Schienen
  } else {
    b.lathe([[0, 0], [1.15, 0], [1.15, 0.12]], 'y', 0, 2.1, -0.4, HULL_DARK, { seg: 8, ao: 0.1 }); // Ring
    b.extrudeX([[-1.2, 2.2], [-0.8, 2.78], [0.8, 2.82], [1.2, 2.5], [1.2, 2.2]], 1.9, 0, 0, -0.2, HULL, { camo: 0.7, taper: [1, 0.78] });
    b.box(0.5, 0.45, 0.5, 0, 2.55, -1.6, HULL_DARK, { camo: 1 });
    b.barrel(0.065, 3.0, 0.1, 2.6, -1.85, 0.02, GUN, 6);
    b.cyl(0.09, 0.6, 0.1, 2.6, -2.4, 'z', 0x6a6a62, { paint: P_FIXED }, 6);
    // ATGM-Starter
    b.mirror(() => {
      b.box(0.22, 0.2, 0.9, 1.15, 2.7, -0.2, DARK, { paint: P_FIXED });
      b.box(0.17, 0.17, 0.12, 1.15, 2.7, -0.7, 0x6a6a62, { paint: P_FIXED });
    });
    b.box(0.34, 0.28, 0.4, -0.5, 3.0, -0.2, GLASS_LIGHT, { paint: P_FIXED });
    b.box(0.34, 0.22, 0.4, 0.4, 2.95, 0.5, HULL_DARK, { camo: 1 });
  }
  b.cyl(0.03, 2.8, 1.0, 3.5, 1.6, 'y', DARK, { paint: P_FIXED }, 4, 0.015);
  for (const s of [-1, 1]) smokeRack(b, s * 1.35, 2.45, -0.9);
  b.box(1.5, 0.05, 1.2, 0, 2.2, 2.35, 0xffffff, { paint: P_TEAM, ao: 0 });
  b.box(2.5, 0.12, 0.3, 0, 1.7, 3.55, 0xffffff, { paint: P_TEAM, ao: 0 });
  return { geom: b.build({ groundAO: 0.32, groundH: 0.9 }), size: 7.2, boost: 1, livery: 'ground', tilt: true };
}

// ------------------------------------------------------------------------- Panzerhaubitze

export function buildSpg(): ModelDef {
  const b = new ModelBuilder();
  b.mirror(() => gear(b, { x: 1.5, zFront: -3.6, zRear: 3.8, nWheels: 7, rWheel: 0.4, wheelW: 0.33, beltW: 0.6, beltTop: 1.0, rollers: 3, skirt: { z0: -2.9, z1: 3.4, y0: 0.7, y1: 1.5 } }));
  b.extrudeX([[-3.5, 0.55], [3.9, 0.55], [3.9, 1.5], [3.4, 1.62], [-2.4, 1.65], [-3.8, 1.05]], 3.0, 0, 0, 0, HULL, { camo: 0.9, taper: [1, 0.95] });
  b.box(0.8, 0.1, 0.8, -0.8, 1.7, -2.5, HULL_DARK, { camo: 1 });
  b.box(0.5, 0.12, 0.5, -0.8, 1.8, -2.5, GLASS, { paint: P_FIXED });
  // Sporn hinten (hochgeklappt)
  b.box(2.6, 0.22, 0.12, 0, 2.5, 4.05, HULL_DARK, { rot: [0.75, 0, 0], camo: 1 });
  b.mirror(() => b.box(0.12, 0.9, 0.2, 1.1, 2.0, 4.0, STEEL, { paint: P_FIXED, rot: [0.3, 0, 0] }));
  // großer Turm, Turmkorb hinten, hoher Turmschwerpunkt
  b.lathe([[0, 0], [1.6, 0], [1.64, 0.15], [0, 0.15]], 'y', 0, 1.65, 1.0, HULL_DARK, { seg: 10, ao: 0.1 });
  b.extrudeX([[-2.7, 1.8], [-2.0, 2.9], [0.8, 3.15], [2.5, 3.0], [2.7, 2.2], [2.7, 1.8]], 3.0, 0, 0, 0.9, HULL, { camo: 0.8, taper: [1, 0.86] });
  b.mirror(() => b.extrudeX([[-2.2, 2.2], [-1.0, 2.9], [0.4, 2.9], [0.4, 2.2]], 0.35, 1.55, 0, 0.5, HULL_LIGHT, { camo: 0.8, taper: [1, 0.7] }));
  b.box(1.3, 0.9, 0.6, 0, 2.6, -1.6, HULL_DARK, { camo: 1 });
  // Rohr 155 mm L52 mit Mündungsbremse + Rauchabsauger, erhöht
  b.push(0, 2.6, -1.9, [0.34, 0, 0]);
  b.cyl(0.14, 2.0, 0, 0, -1.0, 'z', 0x7a7a72, { paint: P_FIXED }, 7);
  b.cyl(0.115, 6.0, 0, 0, -5.0, 'z', GUN, { paint: P_FIXED }, 7, 0.105);
  b.cyl(0.18, 0.7, 0, 0, -4.2, 'z', 0x7a7a72, { paint: P_FIXED }, 7);
  b.cyl(0.19, 0.4, 0, 0, -8.15, 'z', 0x6a6a62, { paint: P_FIXED }, 7);
  b.box(0.42, 0.1, 0.3, 0, 0, -8.1, DARK, { paint: P_FIXED });
  b.pop();
  cupola(b, 1.0, 3.0, 0.2, 0.34, true);
  cupola(b, -1.0, 2.95, 0.9, 0.3, true);
  b.box(0.4, 0.3, 0.5, 0.9, 3.25, -0.9, GLASS_LIGHT, { paint: P_FIXED });
  for (const s of [-1, 1]) smokeRack(b, s * 1.55, 2.75, -1.0);
  // Heckluke Munition
  b.box(1.5, 1.2, 0.08, 0, 2.2, 3.65, HULL_DARK, { camo: 1 });
  b.cyl(0.03, 3.2, 1.3, 4.7, 2.2, 'y', DARK, { paint: P_FIXED }, 4, 0.015);
  b.box(1.6, 0.05, 0.9, 0, 3.17, 1.6, 0xffffff, { paint: P_TEAM, ao: 0 });
  b.box(3.0, 0.16, 0.3, 0, 1.7, 3.95, 0xffffff, { paint: P_TEAM, ao: 0 });
  return { geom: b.build({ groundAO: 0.32, groundH: 0.9 }), size: 11, boost: 1, livery: 'ground', tilt: true };
}

// ------------------------------------------------------------------------- Flakpanzer

export function buildSpaa(): ModelDef {
  const b = new ModelBuilder();
  b.mirror(() => gear(b, { x: 1.4, zFront: -3.3, zRear: 3.6, nWheels: 6, rWheel: 0.4, wheelW: 0.3, beltW: 0.58, beltTop: 0.98, rollers: 3, skirt: { z0: -2.6, z1: 3.1, y0: 0.7, y1: 1.4 } }));
  b.extrudeX([[-3.2, 0.5], [3.6, 0.5], [3.6, 1.4], [3.1, 1.55], [-2.3, 1.58], [-3.45, 1.0]], 2.8, 0, 0, 0, HULL, { camo: 0.9, taper: [1, 0.93] });
  b.box(0.7, 0.1, 0.7, -0.75, 1.62, -2.3, HULL_DARK, { camo: 1 });
  b.box(2.0, 0.05, 1.6, 0, 1.6, 2.7, 0x4a4a44, { paint: P_FIXED });
  // Turm, breit, zwei Maschinenkanonen seitlich
  b.lathe([[0, 0], [1.3, 0], [1.34, 0.14], [0, 0.14]], 'y', 0, 1.55, 0.3, HULL_DARK, { seg: 10, ao: 0.1 });
  b.extrudeX([[-1.6, 1.7], [-1.2, 2.35], [1.3, 2.5], [1.6, 2.1], [1.6, 1.7]], 2.9, 0, 0, 0.1, HULL, { camo: 0.8, taper: [1, 0.75] });
  b.mirror(() => {
    b.box(0.45, 0.55, 1.5, 1.4, 2.1, -0.6, HULL_DARK, { camo: 0.8, top: [0.8, 1] }); // Waffenkästen
    b.push(1.45, 2.15, -1.3, [0.28, 0, 0]);
    b.cyl(0.14, 1.2, 0, 0, -0.5, 'z', 0x7a7a72, { paint: P_FIXED }, 6);
    b.cyl(0.075, 3.2, 0, 0, -2.4, 'z', GUN, { paint: P_FIXED }, 6, 0.07);
    b.cyl(0.11, 0.4, 0, 0, -3.8, 'z', 0x6a6a62, { paint: P_FIXED }, 6);
    b.pop();
    // Munitionstrommel
    b.cyl(0.4, 0.3, 1.0, 2.45, 0.7, 'x', 0x6a6a62, { paint: P_FIXED }, 7);
  });
  // Suchradar (hinten, Schüssel auf Mast) und Folgeradar (vorn, kleiner)
  b.cyl(0.12, 0.5, 0, 2.7, 0.9, 'y', DARK, { paint: P_FIXED }, 5);
  b.push(0, 3.4, 0.9, [0.1, 0, 0]);
  b.lathe([[0, 0], [1.2, 0.04], [1.2, 0.14], [0, 0.16]], 'z', 0, 0, 0, 0xd8d8d0, { seg: 10, squash: [1, 1, 0.55] });
  b.box(0.14, 0.14, 0.4, 0, 0, 0.5, DARK, { paint: P_FIXED });
  b.pop();
  b.push(0, 2.55, -1.3, [-0.2, 0, 0]);
  b.lathe([[0, 0], [0.5, 0.05], [0.5, 0.12], [0, 0.13]], 'z', 0, 0, 0, 0xd0d0c8, { seg: 8 });
  b.pop();
  b.box(0.3, 0.3, 0.3, 0, 2.55, -1.2, DARK, { paint: P_FIXED });
  b.cyl(0.03, 2.2, 1.0, 3.6, 1.3, 'y', DARK, { paint: P_FIXED }, 4, 0.015);
  b.box(1.0, 0.05, 0.8, 0, 2.55, 1.9, 0xffffff, { paint: P_TEAM, ao: 0 });
  b.box(2.7, 0.14, 0.3, 0, 1.5, 3.62, 0xffffff, { paint: P_TEAM, ao: 0 });
  return { geom: b.build({ groundAO: 0.32, groundH: 0.9 }), size: 7.5, boost: 1, livery: 'ground', tilt: true };
}

export type { V3 };
export { P_CAMO };
