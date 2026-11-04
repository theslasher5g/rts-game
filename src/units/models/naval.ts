/** Phase 4 – Schiffe und U-Boot. Wasserlinie bei y = 0, Bug bei −z. */
import {
  BLACK, DARK, GLASS, GUN, HULL, HULL_DARK, HULL_LIGHT, ModelBuilder, P_CAMO, P_FIXED, P_TEAM, STEEL, WHITE, type ModelDef,
} from './geomUtils';

const DECK = 0x8a8a84;
const HATCH = 0x3a3a38;

type Pt = [number, number];
const HULL_PLAN: Pt[] = [
  [0, -76], [3.5, -66], [7, -48], [8.6, -25], [9, 0], [9, 50], [8.4, 70], [7, 75],
  [-7, 75], [-8.4, 70], [-9, 50], [-9, 0], [-8.6, -25], [-7, -48], [-3.5, -66],
];
const scaleXZ = (pts: Pt[], sx: number, sz: number): Pt[] => pts.map(([x, z]) => [x * sx, z * sz]);

function vls(b: ModelBuilder, z: number, nx: number, nz: number): void {
  const w = nx * 1.15 + 0.6, l = nz * 1.15 + 0.6;
  b.box(w, 0.35, l, 0, 3.2, z, HULL_DARK, { camo: 1.5, ao: 0.1 });
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) b.plate(0.9, 0.9, (i - (nx - 1) / 2) * 1.15, 3.4, z + (j - (nz - 1) / 2) * 1.15, HATCH);
  }
}

function ciws(b: ModelBuilder, x: number, y: number, z: number): void {
  b.cyl(0.5, 0.8, x, y + 0.4, z, 'y', 0x7a7a74, { paint: P_FIXED }, 7);
  b.lathe([[0, 0], [1.0, 0], [0.95, 0.9], [0.55, 1.5], [0, 1.65]], 'y', x, y + 0.8, z, 0xe0e0dc, { paint: P_FIXED, seg: 8, ao: 0.2 });
  b.barrel(0.12, 1.8, x, y + 1.6, z - 0.7, 0.1, 0x3a3a34, 5);
}

function gunTurret(b: ModelBuilder, y: number, z: number, big: boolean): void {
  const r = big ? 3.2 : 2.4;
  b.lathe([[0, 0], [r, 0], [r * 0.9, 0.9], [r * 0.7, 2.0], [0, 2.1]], 'y', 0, y, z, HULL_LIGHT, { seg: 8, squash: [1, 1, 1.15], ao: 0.25 });
  b.box(r * 0.6, 1.2, 0.8, 0, y + 1.1, z - r * 1.0, HULL_DARK, { camo: 1 });
  const bl = big ? 7.2 : 5.2;
  b.push(0, y + 1.2, z - r * 1.2, [0.07, 0, 0]);
  b.cyl(0.26, bl * 0.35, 0, 0, -bl * 0.17, 'z', 0x7a7a72, { paint: P_FIXED }, 6);
  b.cyl(0.2, bl * 0.8, 0, 0, -bl * 0.55, 'z', GUN, { paint: P_FIXED }, 6, 0.16);
  b.cyl(0.24, 0.5, 0, 0, -bl, 'z', 0x6a6a62, { paint: P_FIXED }, 6);
  b.pop();
}

function funnel(b: ModelBuilder, z: number, y0: number, h: number, w: number, l: number): void {
  b.slab([[-w / 2, -l / 2], [w / 2, -l / 2], [w / 2 * 0.9, l / 2], [-w / 2 * 0.9, l / 2]], y0, y0 + h, 0, 0, z, HULL, { top: [0.75, 0.8], topShift: l * 0.12, camo: 1.2 });
  b.box(w * 0.62, 0.12, l * 0.66, 0, y0 + h + 0.05, z + l * 0.12, 0x2a2a26, { paint: P_FIXED });
  b.slab([[-w / 2 * 0.8, -l / 2 * 0.8], [w / 2 * 0.8, -l / 2 * 0.8], [w / 2 * 0.74, l / 2 * 0.8], [-w / 2 * 0.74, l / 2 * 0.8]], y0 + h - 1.1, y0 + h - 0.1, 0, 0, z + l * 0.04, 0xffffff, { paint: P_TEAM, top: [0.88, 0.9], ao: 0 });
}

function shipModel(frigate: boolean): ModelDef {
  const b = new ModelBuilder();
  const sx = frigate ? 15 / 18 : 1, sz = frigate ? 120 / 150 : 1;
  b.push(0, 0, 0, [0, 0, 0], [sx, 1, sz]);
  // Rumpf: unten schmaler, Deck mit Aufkantung; Back erhöht
  const bottom = scaleXZ(HULL_PLAN, 0.68, 0.97);
  b.slab(bottom, -2.9, 3.0, 0, 0, 0, HULL, { top: [1 / 0.68, 1 / 0.97], camo: 1.4, ao: 0.1 });
  b.slab(scaleXZ(HULL_PLAN, 0.94, 0.98), 3.0, 3.08, 0, 0, 0, DECK, { paint: P_CAMO, ao: 0 });
  // Vorschiff erhöht
  const fc: Pt[] = [[0, -74], [3.2, -65], [6.4, -48], [7.6, -32], [-7.6, -32], [-6.4, -48], [-3.2, -65]];
  b.slab(fc, 3.0, 4.5, 0, 0, 0, HULL, { camo: 1.2, top: [0.96, 0.99] });
  b.slab(scaleXZ(fc, 0.92, 0.98), 4.5, 4.58, 0, 0, 0, DECK, { paint: P_CAMO, ao: 0 });
  // Bordwand-Teamstreifen
  b.mirror(() => b.plateSide(26, 0.8, 8.7 * 1.0, 1.7, -42, 1, 0xffffff, P_TEAM));
  b.mirror(() => b.plateSide(10, 0.8, 8.97, 1.7, 30, 1, 0xffffff, P_TEAM));
  // Anker-/Ankerklüsen, Bugwulst-Hinweis
  b.mirror(() => b.box(0.7, 0.9, 1.2, 1.9, 2.5, -73, STEEL, { paint: P_FIXED }));

  // Hauptgeschütz auf der Back
  gunTurret(b, 4.58, -56, !frigate);
  if (!frigate) vls(b, -38, 4, 6);
  // CIWS auf Back-Aufbau
  ciws(b, 0, 7.0, -27);

  // Vorderer Aufbau + Brücke (Tarnfläche, Flächen geneigt)
  b.slab([[-4.8, -24], [4.8, -24], [5.7, -10], [5.7, 8], [-5.7, 8], [-5.7, -10]], 3.0, 9.2, 0, 0, 0, HULL_LIGHT, { top: [0.86, 0.92], camo: 1.6 });
  b.slab([[-4.0, -20], [4.0, -20], [4.6, -10], [-4.6, -10]], 9.2, 12.4, 0, 0, 0, HULL, { top: [0.88, 0.8], camo: 1.4 });
  b.box(7.6, 1.2, 0.12, 0, 10.9, -20.2, GLASS, { paint: P_FIXED, rot: [-0.15, 0, 0] });
  b.mirror(() => {
    b.plateSide(8, 1.0, 4.45, 10.9, -15, 1, 0x20303a);
    b.plateSide(4, 0.9, 5.2, 6.5, -4, 1, 0x20303a);
    b.box(3.4, 3.0, 0.2, 2.5, 7.2, -23.9, 0x34404a, { paint: P_FIXED, rot: [0.05, 0, 0] }); // Radarflächen
  });
  // Brückenflügel
  b.mirror(() => b.box(2.0, 0.2, 5, 5.3, 10.4, -14.6, HULL_DARK, { camo: 1 }));
  // Mast mit Radar-Sensoren
  b.box(1.2, 8.0, 1.2, 0, 16.4, -5.5, HULL_LIGHT, { camo: 1.5, top: [0.45, 0.45] });
  b.cyl(0.18, 7, 0, 23.5, -5.5, 'y', 0x6a6a62, { paint: P_FIXED }, 5, 0.06);
  b.box(4.4, 0.18, 0.18, 0, 20.5, -5.5, 0x6a6a62, { paint: P_FIXED });
  b.box(2.8, 1.8, 0.3, 0, 14.0, -5.5, 0x34404a, { paint: P_FIXED });
  b.lathe([[0, 0], [1.3, 0], [1.2, 0.5], [0, 0.8]], 'y', 0, 12.4, -6.5, 0xdadad6, { paint: P_FIXED, seg: 8 }); // Rundumsucher
  b.box(3.6, 0.35, 0.5, 0, 12.6, -6.5, 0x7a7a74, { paint: P_FIXED });
  // Schornsteine
  funnel(b, 12, 8.8, 5.5, 6.4, 7);
  if (!frigate) funnel(b, 24, 8.4, 4.8, 5.6, 6);
  // Hangar + Hubschrauberdeck
  b.slab([[-5.4, 38], [5.4, 38], [5.4, 54], [-5.4, 54]], 3.0, 8.0, 0, 0, 0, HULL_LIGHT, { top: [0.96, 0.98], camo: 1.5 });
  b.plateFront(8, 4.6, 0, 5.6, 54.2, 1, 0x2a2a26);
  b.cyl(2.8, 0.12, 0, 3.12, 64.5, 'y', 0x6a6a64, { paint: P_FIXED }, 10);
  b.plate(0.6, 4.0, -0.9, 3.24, 64.5, WHITE);
  b.plate(0.6, 4.0, 0.9, 3.24, 64.5, WHITE);
  b.plate(2.0, 0.6, 0, 3.24, 64.5, WHITE);
  ciws(b, 0, 8.0, 38);
  // Waffen: Seezielflugkörper, Torpedorohre, Boote, Davits
  b.mirror(() => {
    for (let i = 0; i < 2; i++) b.box(0.7, 0.7, 4.2, 4.6, 4.4, 20.5 + i * 0.0 + (i ? 5.2 : 0), HULL_DARK, { camo: 1, rot: [0.35, 0, 0] });
    b.box(1.6, 1.0, 1.5, 5.0, 3.7, 0.6, HULL_DARK, { camo: 1 });
    b.box(2.4, 1.2, 6.5, 6.7, 3.7, 12.8 + 12, HULL_LIGHT, { camo: 1, top: [0.7, 1] }); // Beiboot
    b.cyl(0.12, 2.0, 5.7, 4.3, 17.0, 'y', DARK, { paint: P_FIXED }, 4);
  });
  if (!frigate) vls(b, 31, 4, 3);
  // Antennen
  b.cyl(0.06, 5, 3.0, 12.5, 4.0, 'y', 0x6a6a62, { paint: P_FIXED }, 4, 0.02);
  b.cyl(0.06, 4, -3.0, 11.5, 1.0, 'y', 0x6a6a62, { paint: P_FIXED }, 4, 0.02);
  b.pop();
  void BLACK; void DARK;
  return { geom: b.build({ groundAO: 0 }), size: frigate ? 120 : 150, boost: frigate ? 0.4 : 0.35, livery: 'naval', tilt: false };
}

export const buildDestroyer = (): ModelDef => shipModel(false);
export const buildFrigate = (): ModelDef => shipModel(true);

// -------------------------------------------------------------------------- U-Boot

export function buildSubmarine(): ModelDef {
  const b = new ModelBuilder();
  // Druckkörper (Heck bei +z): Tropfenform, leicht gedrungen
  b.lathe(
    [[0, -36], [0.9, -35.5], [2.4, -31], [3.8, -22], [4.5, -12], [4.55, 10], [4.2, 24], [3.2, 31], [1.8, 35], [0, 36]],
    'z', 0, 0, 0, HULL, { seg: 10, camo: false, ao: 0.15 },
  );
  // Deckaufbau (flach), Sail mit Tauchrudern und Masten
  b.box(2.2, 0.5, 40, 0, 4.4, 3, HULL_DARK, { camo: 1.5, top: [0.9, 1] });
  b.extrudeX([[-6.2, 4.2], [-5.2, 9.2], [-1.0, 9.6], [3.2, 9.0], [4.2, 4.2]], 2.6, 0, 0, -10, HULL_LIGHT, { camo: 1.2, taper: [1, 0.75] });
  b.box(2.64, 1.0, 5.0, 0, 7.8, -10.5, 0xffffff, { paint: P_TEAM, ao: 0 });
  b.mirror(() => b.box(2.3, 0.18, 1.4, 2.2, 7.4, -13.4, HULL_DARK, { camo: 1, rot: [0, 0.0, 0] }));
  b.cyl(0.14, 3.2, 0.5, 11.3, -9.0, 'y', 0x4a4a44, { paint: P_FIXED }, 5);
  b.cyl(0.1, 2.4, -0.6, 10.9, -10.5, 'y', 0x4a4a44, { paint: P_FIXED }, 5);
  b.box(0.5, 0.35, 0.6, 0.5, 13.0, -9.0, 0x2a2a26, { paint: P_FIXED });
  // Heck: Kreuzruder, Propeller
  b.mirror(() => {
    b.slab([[0.0, 0.0], [3.4, 1.2], [3.4, 2.5], [0.0, 3.0]], -0.15, 0.15, 0.0, 0.0, 29.5, HULL_DARK, { camo: 1 });
  });
  b.extrudeX([[28.5, 0.5], [31.5, 5.8], [34.2, 5.8], [34.6, 0.5]], 0.3, 0, 0, 0, HULL_DARK, { camo: 1, taper: [1, 0.8] });
  b.extrudeX([[28.5, -0.5], [31.5, -5.8], [34.2, -5.8], [34.6, -0.5]], 0.3, 0, 0, 0, HULL_DARK, { camo: 1, taper: [1, 0.8] });
  b.lathe([[0, 0], [0.9, 0], [0.9, 0.3], [0, 0.4]], 'z', 0, 0, 36.2, 0x4a4a44, { paint: P_FIXED, seg: 5 });
  b.box(0.35, 4.4, 0.3, 0, 0, 36.4, 0x3a3a34, { paint: P_FIXED });
  b.box(4.4, 0.35, 0.3, 0, 0, 36.4, 0x3a3a34, { paint: P_FIXED, rot: [0, 0, 0.2] });
  b.box(0.6, 1.0, 5.0, 0, 5.2, 20, HULL_DARK, { camo: 1, rot: [0.0, 0, 0] });
  void STEEL; void GUN; void GLASS; void HULL_LIGHT;
  return { geom: b.build({ groundAO: 0 }), size: 86, boost: 0.45, livery: 'naval', tilt: false };
}
