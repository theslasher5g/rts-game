/**
 * Schiffe und U-Boot (Wasserlinie bei y = 0, Bug bei −z), hochdetailliert: Rumpfplatten, Aufbauten mit Brückenfenstern,
 * Mast mit drehenden Radargeräten, VLS-Zellen, drehbare Geschütze/CIWS, Schornsteine, Boote mit Davits, Hubschrauberdeck.
 *
 * Animationsgruppen (Anim-Material): 40 Rundsuchradar (dreht) · 41 Hauptgeschütz (dreht zum Ziel, iAnim.z) ·
 * 42 Nahbereichsgeschütz (CIWS, folgt dem Ziel) · 43 U-Boot-Schraube (dreht mit Fahrt) · 44 zweites Radar (gegenläufig) ·
 * 45 Positionslicht (leuchtet).
 */
import {
  BLACK, DARK, GLASS, GLASS_LIGHT, GUN, HULL, HULL_DARK, HULL_LIGHT, ModelBuilder, P_CAMO, P_FIXED, P_TEAM, STEEL, WHITE, type ModelDef,
} from './geomUtils';

const DECK = 0xb4b4ac;
const HATCH = 0x3a3a38;
const WINDOW = 0x20303a;
const ANTIFOUL = 0x6a2a24;
const fx = { paint: P_FIXED } as const;

type Pt = [number, number];
const HULL_PLAN: Pt[] = [
  [0, -76], [3.5, -66], [7, -48], [8.6, -25], [9, 0], [9, 50], [8.4, 70], [7, 75],
  [-7, 75], [-8.4, 70], [-9, 50], [-9, 0], [-8.6, -25], [-7, -48], [-3.5, -66],
];
const scaleXZ = (pts: Pt[], sx: number, sz: number): Pt[] => pts.map(([x, z]) => [x * sx, z * sz]);

function vls(b: ModelBuilder, z: number, nx: number, nz: number): void {
  const w = nx * 1.15 + 0.6, l = nz * 1.15 + 0.6;
  b.box(w, 0.35, l, 0, 3.2, z, HULL_DARK, { camo: 6, ao: 0.1 });
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const x = (i - (nx - 1) / 2) * 1.15, zz = z + (j - (nz - 1) / 2) * 1.15;
      b.plate(0.9, 0.9, x, 3.4, zz, (i + j) % 2 ? HATCH : 0x2e2e2c);
      b.plate(0.18, 0.18, x, 3.41, zz, 0x6a6a64); // Griff
    }
  }
}

function ciws(b: ModelBuilder, x: number, y: number, z: number): void {
  b.cyl(0.5, 0.8, x, y + 0.4, z, 'y', 0x7a7a74, fx, 7);
  b.part(42, [x, y + 0.8, z], () => {
    b.lathe([[0, 0], [1.0, 0], [0.95, 0.9], [0.55, 1.5], [0, 1.65]], 'y', x, y + 0.8, z, 0xe0e0dc, { paint: P_FIXED, seg: 8, ao: 0.2 });
    b.box(0.5, 0.5, 0.5, x + 0.8, y + 1.1, z + 0.1, 0xd0d0cc, fx); // Magazin
    b.barrel(0.12, 1.8, x, y + 1.6, z - 0.7, 0.1, 0x3a3a34, 5);
    b.cyl(0.2, 0.5, x - 0.4, y + 1.7, z - 0.3, 'y', 0xb8b8b0, fx, 5); // Radom
    b.box(0.2, 0.15, 0.2, x + 0.4, y + 1.7, z - 0.4, GLASS_LIGHT, fx);
  });
}

function gunTurret(b: ModelBuilder, y: number, z: number, big: boolean): void {
  const r = big ? 3.2 : 2.4;
  b.cyl(r * 1.05, 0.4, 0, y + 0.1, z, 'y', 0x6a6a64, fx, 10); // Drehkranz
  b.part(41, [0, y, z], () => {
    b.lathe([[0, 0], [r, 0], [r * 0.9, 0.9], [r * 0.7, 2.0], [0, 2.1]], 'y', 0, y, z, HULL_LIGHT, { seg: 8, squash: [1, 1, 1.15], ao: 0.25 });
    b.box(r * 0.6, 1.2, 0.8, 0, y + 1.1, z - r * 1.0, HULL_DARK, { camo: 1 });
    const bl = big ? 7.2 : 5.2;
    b.push(0, y + 1.2, z - r * 1.2, [0.07, 0, 0]);
    b.cyl(0.26, bl * 0.35, 0, 0, -bl * 0.17, 'z', 0x7a7a72, fx, 7);
    b.cyl(0.2, bl * 0.8, 0, 0, -bl * 0.55, 'z', GUN, fx, 7, 0.16);
    b.cyl(0.24, 0.5, 0, 0, -bl, 'z', 0x6a6a62, fx, 7);
    b.pop();
    b.box(0.6, 0.12, 0.8, 0, y + 2.15, z + 0.4, 0x4a4a44, fx); // Luke
    b.box(r * 1.1, 0.3, 0.2, 0, y + 1.7, z - r * 0.55, GLASS_LIGHT, fx); // Visier
    b.mirror(() => b.box(0.35, 0.5, 0.9, r * 0.65, y + 1.3, z + r * 0.3, HULL_DARK, { camo: 1 })); // Seitenverkleidung
  });
}

function funnel(b: ModelBuilder, z: number, y0: number, h: number, w: number, l: number): void {
  b.slab([[-w / 2, -l / 2], [w / 2, -l / 2], [w / 2 * 0.9, l / 2], [-w / 2 * 0.9, l / 2]], y0, y0 + h, 0, 0, z, HULL, { top: [0.75, 0.8], topShift: l * 0.12, camo: 6 });
  b.box(w * 0.62, 0.12, l * 0.66, 0, y0 + h + 0.05, z + l * 0.12, 0x2a2a26, fx);
  for (let i = 0; i < 4; i++) b.box(w * 0.5, 0.08, 0.12, 0, y0 + h + 0.12, z - l * 0.1 + i * l * 0.12, 0x4a4a44, fx); // Gitter
  b.slab([[-w / 2 * 0.8, -l / 2 * 0.8], [w / 2 * 0.8, -l / 2 * 0.8], [w / 2 * 0.74, l / 2 * 0.8], [-w / 2 * 0.74, l / 2 * 0.8]], y0 + h - 1.1, y0 + h - 0.1, 0, 0, z + l * 0.04, 0xffffff, { paint: P_TEAM, top: [0.88, 0.9], ao: 0 });
  b.mirror(() => {
    for (let i = 0; i < 3; i++) b.box(0.05, 1.0, 0.5, w * 0.4 + 0.1, y0 + h * 0.45, z - l * 0.2 + i * 0.9, 0x3a3a38, { ...fx, ao: 0 }); // Lamellen
  });
}

function railing(b: ModelBuilder, x: number, y: number, z0: number, z1: number, posts: number): void {
  b.box(0.06, 0.06, z1 - z0, x, y + 1.0, (z0 + z1) / 2, 0xb8b8b0, fx);
  b.box(0.05, 0.05, z1 - z0, x, y + 0.5, (z0 + z1) / 2, 0xb8b8b0, fx);
  for (let i = 0; i <= posts; i++) b.box(0.07, 1.0, 0.07, x, y + 0.5, z0 + ((z1 - z0) * i) / posts, 0xb8b8b0, fx);
}

/** Gittermast: vier schräge Streben + Quertraversen */
function mast(b: ModelBuilder, x: number, z: number, y0: number, h: number, w: number): void {
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.cyl(0.1, h, x + sx * w * 0.5, y0 + h / 2, z + sz * w * 0.5, 'y', 0x6a6a62, { ...fx, rot: [-sz * 0.05, 0, sx * 0.05] }, 4, 0.05);
  for (let i = 1; i < 4; i++) {
    b.box(w, 0.1, 0.1, x, y0 + (h * i) / 4, z - w * 0.5, 0x6a6a62, fx);
    b.box(w, 0.1, 0.1, x, y0 + (h * i) / 4, z + w * 0.5, 0x6a6a62, fx);
    b.box(0.1, 0.1, w, x - w * 0.5, y0 + (h * i) / 4 + 0.5, z, 0x6a6a62, fx);
  }
}

/** Rundsuchradar-Antenne (dreht mit Part-ID) */
function radar(b: ModelBuilder, id: 40 | 44, x: number, y: number, z: number, w: number): void {
  b.cyl(0.3, 0.6, x, y + 0.3, z, 'y', 0x8a8a84, fx, 6);
  b.part(id, [x, y + 0.6, z], () => {
    b.box(w, w * 0.12, 0.25, x, y + 0.85, z, 0xdadad6, { ...fx, ao: 0.1 });
    b.box(w * 0.9, w * 0.05, 0.15, x, y + 0.85 + w * 0.08, z - 0.1, 0x9a9aa0, fx);
    b.box(0.3, 0.3, 0.5, x, y + 0.75, z + 0.15, 0x4a4a44, fx);
    b.box(0.15, w * 0.14, 0.15, x + w * 0.5, y + 0.85, z, 0xff4040, fx); // Endmarke
  });
}

function boat(b: ModelBuilder, x: number, y: number, z: number): void {
  b.slab([[-0.8, -3.2], [0.8, -3.2], [1.3, 1.2], [1.1, 3.0], [-1.1, 3.0], [-1.3, 1.2]], 0, 0.8, x, y, z, 0xd8d8d0, { paint: P_FIXED, top: [0.95, 0.95] });
  b.mirror(() => b.cyl(0.32, 6.2, x + 1.15, y + 0.8, z, 'z', 0x2a2a28, fx, 6, 0.24)); // Schlauchwulst
  b.box(0.9, 0.8, 0.9, x, y + 1.1, z + 0.6, 0x4a4a44, fx); // Konsole
  b.box(0.16, 0.8, 0.16, x, y + 1.8, z + 0.7, STEEL, fx);
  b.box(0.3, 0.3, 0.6, x, y + 0.2, z + 3.1, 0x1a1a18, fx); // Außenborder
}

function shipModel(frigate: boolean): ModelDef {
  const b = new ModelBuilder();
  const sx = frigate ? 15 / 18 : 1, sz = frigate ? 120 / 150 : 1;
  b.push(0, 0, 0, [0, 0, 0], [sx, 1, sz]);
  // ---- Rumpf: unten schmaler, Deck mit Aufkantung; Unterwasserschiff (Antifouling) + Plattenstöße
  const bottom = scaleXZ(HULL_PLAN, 0.68, 0.97);
  b.slab(bottom, -2.9, 3.0, 0, 0, 0, HULL, { top: [1 / 0.68, 1 / 0.97], camo: 6, ao: 0.1 });
  b.slab(scaleXZ(bottom, 1.004, 1.002), -2.9, -0.6, 0, 0, 0, ANTIFOUL, { paint: P_FIXED, top: [1.19, 1.014], ao: 0.1 });
  b.slab(scaleXZ(HULL_PLAN, 0.94, 0.98), 3.0, 3.08, 0, 0, 0, DECK, { paint: P_CAMO, ao: 0 });
  b.mirror(() => {
    // Plattenstöße und Wasserlinienband
    for (let i = 0; i < 12; i++) b.plateSide(0.18, 3.0, 8.9, 1.6, -64 + i * 11.5, 1, 0x7a7a76, P_FIXED);
    b.plateSide(150, 0.35, 8.62, -0.35, 0, 1, 0x3a3a38, P_FIXED);
    b.plateSide(5, 1.4, 8.96, 1.9, -22, 1, WHITE, P_FIXED); // Bordnummer
    b.plateSide(5, 1.4, 8.96, 1.9, 40, 1, WHITE, P_FIXED);
    b.plateSide(26, 0.8, 8.7 * 1.0, 1.7, -42, 1, 0xffffff, P_TEAM);
    b.plateSide(10, 0.8, 8.97, 1.7, 30, 1, 0xffffff, P_TEAM);
    b.box(0.7, 0.9, 1.2, 1.9, 2.5, -73, STEEL, fx); // Ankernische
    b.cyl(0.3, 0.6, 1.9, 3.3, -71, 'x', 0x3a3a34, fx, 5); // Anker
    b.box(1.6, 0.3, 4, 8.2, 2.5, 55, 0x3a3a38, fx); // Gangway-Schatten
  });
  // Vorschiff erhöht
  const fc: Pt[] = [[0, -74], [3.2, -65], [6.4, -48], [7.6, -32], [-7.6, -32], [-6.4, -48], [-3.2, -65]];
  b.slab(fc, 3.0, 4.5, 0, 0, 0, HULL, { camo: 6, top: [0.96, 0.99] });
  b.slab(scaleXZ(fc, 0.92, 0.98), 4.5, 4.58, 0, 0, 0, DECK, { paint: P_CAMO, ao: 0 });
  // Deckmarkierungen, Poller, Winde
  b.plate(0.4, 30, 0, 4.62, -50, 0xd8c040);
  b.plate(8, 0.4, 0, 4.62, -34, 0xd8c040);
  b.box(2.2, 0.8, 1.6, 0, 5.0, -68, 0x6a6a64, fx);
  b.cyl(0.4, 0.9, 0, 5.4, -68, 'x', 0x3a3a34, fx, 6); // Ankerwinde
  b.mirror(() => {
    for (let i = 0; i < 3; i++) b.cyl(0.22, 0.5, 5.8 - i * 0.5, 4.85, -45 + i * 8, 'y', 0x2a2a28, fx, 5); // Poller
    railing(b, 6.9, 4.58, -60, -32, 6);
    railing(b, 8.5, 3.08, -26, 40, 12);
    railing(b, 6.8, 3.08, 56, 74, 4);
  });
  // ---- Hauptgeschütz auf der Back, Senkrechtstartzellen, CIWS
  gunTurret(b, 4.58, -56, !frigate);
  if (!frigate) vls(b, -38, 4, 6);
  ciws(b, 0, 7.0, -27);

  // ---- Vorderer Aufbau + Brücke
  b.slab([[-4.8, -24], [4.8, -24], [5.7, -10], [5.7, 8], [-5.7, 8], [-5.7, -10]], 3.0, 9.2, 0, 0, 0, HULL_LIGHT, { top: [0.86, 0.92], camo: 6 });
  b.slab([[-4.0, -20], [4.0, -20], [4.6, -10], [-4.6, -10]], 9.2, 12.4, 0, 0, 0, HULL, { top: [0.88, 0.8], camo: 6 });
  b.box(7.6, 1.2, 0.12, 0, 10.9, -20.2, GLASS, { paint: P_FIXED, rot: [-0.15, 0, 0] });
  for (let i = 0; i < 6; i++) b.box(0.1, 1.3, 0.14, -3.2 + i * 1.28, 10.9, -20.15, DARK, fx); // Fensterpfosten
  b.box(8.4, 0.3, 0.3, 0, 12.0, -20.1, HULL_DARK, { camo: 1 }); // Fensterdach
  b.box(9.2, 0.35, 5.5, 0, 12.5, -14.3, HULL_DARK, { camo: 1, top: [0.9, 0.9] }); // Brückendach
  b.mirror(() => {
    b.plateSide(8, 1.0, 4.45, 10.9, -15, 1, WINDOW);
    for (let i = 0; i < 6; i++) b.box(0.1, 1.1, 0.12, 4.5, 10.9, -18.5 + i * 1.3, DARK, fx);
    b.plateSide(4, 0.9, 5.2, 6.5, -4, 1, WINDOW);
    b.plateSide(3, 0.9, 5.2, 6.5, 3, 1, WINDOW);
    for (let i = 0; i < 4; i++) b.plateSide(1.4, 0.7, 5.62 - i * 0.0, 8.2, -9 + i * 3, 1, WINDOW);
    b.box(3.4, 3.0, 0.2, 2.5, 7.2, -23.9, 0x34404a, { paint: P_FIXED, rot: [0.05, 0, 0] }); // Radarflächen
    for (let i = 0; i < 3; i++) b.box(3.0, 0.06, 0.04, 2.5, 6.2 + i * 1.0, -24.05, 0x4a5a64, { ...fx, ao: 0 });
    b.box(2.0, 0.2, 5, 5.3, 10.4, -14.6, HULL_DARK, { camo: 1 }); // Brückenflügel
    b.box(0.06, 0.8, 5, 6.3, 10.9, -14.6, DARK, fx); // Reling
    b.cyl(0.25, 0.5, 5.6, 11.0, -12, 'y', 0xdadad6, fx, 5); // Suchscheinwerfer
    b.cyl(0.3, 0.9, 4.2, 4.7, 20.5, 'x', 0xd8d8d0, fx, 6); // Rettungsinseln
  });
  // ---- Mast mit Sensoren, drehendem Rundsucher
  b.box(1.2, 8.0, 1.2, 0, 16.4, -5.5, HULL_LIGHT, { camo: 6, top: [0.45, 0.45] });
  mast(b, 0, -5.5, 12.4, 12, 1.6);
  b.cyl(0.18, 7, 0, 25.5, -5.5, 'y', 0x6a6a62, fx, 5, 0.06);
  b.box(4.4, 0.18, 0.18, 0, 20.5, -5.5, 0x6a6a62, fx);
  b.box(2.8, 1.8, 0.3, 0, 14.0, -5.5, 0x34404a, fx);
  b.mirror(() => b.box(0.3, 0.4, 0.3, 2.2, 20.6, -5.5, 0xdadad6, fx));
  radar(b, 40, 0, 24.0, -5.5, 4.8);
  b.lathe([[0, 0], [1.3, 0], [1.2, 0.5], [0, 0.8]], 'y', 0, 12.4, -6.5, 0xdadad6, { paint: P_FIXED, seg: 8 }); // Kuppel
  b.box(3.6, 0.35, 0.5, 0, 12.6, -6.5, 0x7a7a74, fx);
  b.part(45, [0, 28.8, -5.5], () => b.box(0.3, 0.3, 0.3, 0, 29.0, -5.5, 0xffffff, { ...fx, ao: 0 })); // Topplicht
  b.mirror((side) => b.part(45, [side * 5.8, 10.0, -14], () => b.box(0.3, 0.3, 0.3, 5.8, 10.0, -14, side > 0 ? 0x30ff30 : 0xff3030, { ...fx, ao: 0 })));
  // ---- Schornsteine
  funnel(b, 12, 8.8, 5.5, 6.4, 7);
  if (!frigate) funnel(b, 24, 8.4, 4.8, 5.6, 6);
  mast(b, 0, 31, 8.0, 7, 1.2);
  radar(b, 44, 0, 14.6, 31, 3.0);
  // ---- Hangar + Hubschrauberdeck
  b.slab([[-5.4, 38], [5.4, 38], [5.4, 54], [-5.4, 54]], 3.0, 8.0, 0, 0, 0, HULL_LIGHT, { top: [0.96, 0.98], camo: 6 });
  b.plateFront(8, 4.6, 0, 5.6, 54.2, 1, 0x2a2a26);
  b.plateFront(0.12, 4.6, 0, 5.6, 54.22, 1, 0x4a4a44);
  b.plateFront(8, 0.2, 0, 7.8, 54.22, 1, 0x6a6a64);
  b.cyl(2.8, 0.12, 0, 3.12, 64.5, 'y', 0x6a6a64, fx, 10);
  b.cyl(3.3, 0.1, 0, 3.12, 64.5, 'y', 0x7a7a74, fx, 10, 3.2);
  b.plate(0.6, 4.0, -0.9, 3.24, 64.5, WHITE);
  b.plate(0.6, 4.0, 0.9, 3.24, 64.5, WHITE);
  b.plate(2.0, 0.6, 0, 3.24, 64.5, WHITE);
  b.plate(0.35, 5.6, 0, 3.23, 62, 0xd8c040);
  b.mirror(() => {
    for (let i = 0; i < 3; i++) b.part(45, [3.0, 3.4, 60 + i * 4], () => b.box(0.18, 0.18, 0.18, 3.0, 3.3, 60 + i * 4, 0xff3030, { ...fx, ao: 0 })); // Deckfeuer
  });
  ciws(b, 0, 8.0, 38);
  // ---- Waffen: Seezielflugkörper, Torpedorohre, Boote, Davits
  b.mirror(() => {
    for (let i = 0; i < 2; i++) {
      b.box(0.7, 0.7, 4.2, 4.6, 4.4, 20.5 + (i ? 5.2 : 0), HULL_DARK, { camo: 1, rot: [0.35, 0, 0] });
      b.plate(0.5, 0.5, 4.6, 5.0, 18.4 + (i ? 5.2 : 0), BLACK);
    }
    b.box(1.6, 1.0, 1.5, 5.0, 3.7, 0.6, HULL_DARK, { camo: 1 });
    for (let i = 0; i < 3; i++) b.cyl(0.2, 2.2, 5.0 + (i - 1) * 0.0, 4.4 + i * 0.0, 0.6 + (i - 1) * 0.0, 'z', 0x4a4a44, fx, 5, 0.2); // Torpedorohre
    boat(b, 6.7, 3.7, 36);
    b.box(0.2, 3.2, 0.2, 5.2, 5.2, 33, 0x6a6a62, { ...fx, rot: [0, 0, -0.3] }); // Davits
    b.box(0.2, 3.2, 0.2, 5.2, 5.2, 39, 0x6a6a62, { ...fx, rot: [0, 0, -0.3] });
    b.cyl(0.12, 2.0, 5.7, 4.3, 17.0, 'y', DARK, fx, 4);
    b.box(1.4, 0.7, 1.4, 4.8, 3.6, 49, 0x6a6a64, fx); // Versorgungskisten
    b.box(1.4, 0.7, 1.4, 4.8, 3.6, 47, 0x5a6a52, fx);
  });
  if (!frigate) vls(b, 31, 4, 3);
  // Antennen, Flaggenstock am Heck
  b.cyl(0.06, 5, 3.0, 12.5, 4.0, 'y', 0x6a6a62, fx, 4, 0.02);
  b.cyl(0.06, 4, -3.0, 11.5, 1.0, 'y', 0x6a6a62, fx, 4, 0.02);
  b.cyl(0.08, 4.5, 0, 5.3, 73, 'y', 0xd8d8d0, fx, 4);
  b.plateSide(2.4, 1.4, 0.05, 7.0, 74.0, 1, 0xffffff, P_TEAM);
  b.plateSide(2.4, 1.4, -0.05, 7.0, 74.0, -1, 0xffffff, P_TEAM);
  b.box(2.2, 0.1, 5.0, 0, 3.15, 70.5, 0x4a4a44, fx); // Heckklappe
  b.pop();
  void BLACK; void DARK; void P_CAMO;
  return { geom: b.build({ groundAO: 0 }), size: frigate ? 120 : 150, boost: frigate ? 0.4 : 0.35, livery: 'naval', tilt: false, anim: 'naval' };
}

export const buildDestroyer = (): ModelDef => shipModel(false);
export const buildFrigate = (): ModelDef => shipModel(true);

// -------------------------------------------------------------------------- U-Boot

export function buildSubmarine(): ModelDef {
  const b = new ModelBuilder();
  // Druckkörper (Heck bei +z): Tropfenform mit Farbbändern (Rumpfsektionen)
  b.lathe(
    [[0, -36], [0.9, -35.5], [2.4, -31], [3.8, -22], [4.5, -12], [4.55, 10], [4.2, 24], [3.2, 31], [1.8, 35], [0, 36]],
    'z', 0, 0, 0, HULL, { seg: 12, camo: false, ao: 0.15, edgeColors: [HULL, 0xd0d0d0, HULL, 0xd0d0d0, HULL, 0xd0d0d0, HULL, 0xd0d0d0, HULL] },
  );
  // Deckaufbau (Gussdeck) mit Luken, Klampen, Limberlöchern
  b.box(2.2, 0.5, 40, 0, 4.4, 3, HULL_DARK, { camo: 6, top: [0.9, 1] });
  for (let i = 0; i < 8; i++) b.box(0.9, 0.04, 0.9, (i % 2 ? 0.5 : -0.5) * 0, 4.68, -22 + i * 5.2, 0x3a3a38, fx);
  for (let i = 0; i < 16; i++) {
    b.box(0.18, 0.18, 0.5, 1.12, 4.3, -20 + i * 2.8, 0x1c1c1a, fx);
    b.box(0.18, 0.18, 0.5, -1.12, 4.3, -20 + i * 2.8, 0x1c1c1a, fx);
  }
  for (let i = 0; i < 4; i++) b.box(0.3, 0.3, 0.3, (i % 2 ? 0.8 : -0.8), 4.8, -24 + i * 12, 0x6a6a64, fx); // Klampen
  b.cyl(0.55, 0.14, 0, 4.7, 18, 'y', 0x3a3a38, fx, 8); // Torpedoladeluke
  b.cyl(0.55, 0.14, 0, 4.7, -28, 'y', 0x3a3a38, fx, 8);
  // Turm (Sail) mit Fenstern, Tauchrudern, Masten
  b.extrudeX([[-6.2, 4.2], [-5.2, 9.2], [-1.0, 9.6], [3.2, 9.0], [4.2, 4.2]], 2.6, 0, 0, -10, HULL_LIGHT, { camo: 6, taper: [1, 0.75] });
  b.box(2.64, 1.0, 5.0, 0, 7.8, -10.5, 0xffffff, { paint: P_TEAM, ao: 0 });
  b.mirror(() => {
    b.box(2.3, 0.18, 1.4, 2.2, 7.4, -13.4, HULL_DARK, { camo: 1 });
    for (let i = 0; i < 3; i++) b.plateSide(0.9, 0.5, 1.25, 9.0, -12.5 + i * 1.4, 1, WINDOW);
    b.box(0.1, 0.5, 0.4, 3.5, 7.5, -13.4, 0x3a3a38, fx);
  });
  b.box(2.2, 0.2, 3.0, 0, 9.75, -9.4, HULL_DARK, { camo: 1 }); // Turmdeck
  b.cyl(0.14, 3.2, 0.5, 11.3, -9.0, 'y', 0x4a4a44, fx, 5);
  b.cyl(0.1, 2.4, -0.6, 10.9, -10.5, 'y', 0x4a4a44, fx, 5);
  b.cyl(0.07, 2.0, 0.0, 11.0, -11.6, 'y', 0x3a3a34, fx, 4);
  b.box(0.5, 0.35, 0.6, 0.5, 13.0, -9.0, 0x2a2a26, fx);
  b.cyl(0.18, 0.3, -0.6, 12.2, -10.5, 'y', 0xdadad6, fx, 5);
  // Heck: Kreuzruder, Schraube (dreht), Hecklaufleine
  b.mirror(() => {
    b.slab([[0.0, 0.0], [3.4, 1.2], [3.4, 2.5], [0.0, 3.0]], -0.15, 0.15, 0.0, 0.0, 29.5, HULL_DARK, { camo: 1 });
  });
  b.extrudeX([[28.5, 0.5], [31.5, 5.8], [34.2, 5.8], [34.6, 0.5]], 0.3, 0, 0, 0, HULL_DARK, { camo: 1, taper: [1, 0.8] });
  b.extrudeX([[28.5, -0.5], [31.5, -5.8], [34.2, -5.8], [34.6, -0.5]], 0.3, 0, 0, 0, HULL_DARK, { camo: 1, taper: [1, 0.8] });
  b.cyl(0.8, 0.9, 0, 0, 36.2, 'z', 0x4a4a44, fx, 6, 0.4);
  b.part(43, [0, 0, 36.6], () => {
    for (let i = 0; i < 6; i++) b.box(0.25, 2.4, 0.12, Math.sin(i * 1.047) * 1.1, Math.cos(i * 1.047) * 1.1, 36.6, 0x8a7a40, { ...fx, rot: [0, 0, -i * 1.047] });
    b.cyl(0.5, 0.4, 0, 0, 36.6, 'z', 0x6a6a64, fx, 6);
  });
  b.box(0.6, 1.0, 5.0, 0, 5.2, 20, HULL_DARK, { camo: 1 });
  // Bugruder (eingefahren) + Sonarkuppel + Schleppantennenbehälter
  b.mirror(() => b.box(1.6, 0.12, 0.8, 3.6, 1.6, -26, HULL_DARK, { camo: 1 }));
  b.box(0.5, 0.5, 2.4, 0, 3.4, 33, 0x4a4a44, fx);
  b.plateSide(10, 1.2, 4.56, 0.8, -4, 1, 0xffffff, P_TEAM);
  b.plateSide(10, 1.2, -4.56, 0.8, -4, -1, 0xffffff, P_TEAM);
  b.part(45, [0, 13.4, -9.0], () => b.box(0.2, 0.2, 0.2, 0, 13.3, -9.0, 0xffffff, { ...fx, ao: 0 }));
  void STEEL; void GUN; void GLASS; void BLACK; void DARK; void HULL_LIGHT;
  return { geom: b.build({ groundAO: 0 }), size: 86, boost: 0.45, livery: 'naval', tilt: false, anim: 'naval' };
}
