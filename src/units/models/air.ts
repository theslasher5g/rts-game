/** Phase 4 – Luftfahrzeuge: Hubschrauber (Kampf/Transport), Jagdflugzeug, Jagdbomber, Drohnen. */
import {
  BLACK, DARK, GLASS, GLASS_LIGHT, GUN, HULL, HULL_DARK, HULL_LIGHT, ModelBuilder, P_CAMO, P_FIXED, P_TEAM, RED, STEEL, WHITE, type ModelDef,
} from './geomUtils';

const MISSILE = 0xd8d8d0;
const TIRE = 0x1f1f1b;

/** Einheitsrotor (Radius 1): vier Blätter mit hellen Spitzen + Nabe */
export function buildRotorGeom() {
  const b = new ModelBuilder();
  for (let i = 0; i < 4; i++) {
    b.push(0, 0, 0, [0, (i * Math.PI) / 2, 0]);
    b.box(0.86, 0.035, 0.1, 0.55, 0, 0, 0x1c1c1a, { paint: P_FIXED, ao: 0, top: [1, 0.8] });
    b.box(0.16, 0.036, 0.1, 0.96, 0, 0, 0xd8b830, { paint: P_FIXED, ao: 0 });
    b.pop();
  }
  b.cyl(0.1, 0.12, 0, 0, 0, 'y', 0x2a2a26, { paint: P_FIXED }, 6);
  return b.build({ groundAO: 0 });
}

function rocketPod(b: ModelBuilder, x: number, y: number, z: number): void {
  b.cyl(0.19, 1.7, x, y, z, 'z', HULL_LIGHT, { seg: 6, camo: false }, 6);
  b.lathe([[0, 0], [0.17, 0], [0.17, 0.03], [0, 0.03]], 'z', x, y, z - 0.86, BLACK, { paint: P_FIXED, seg: 6, ao: 0 });
  b.cyl(0.05, 0.9, x, y - 0.25, z, 'y', STEEL, { paint: P_FIXED }, 4);
}
function missile(b: ModelBuilder, x: number, y: number, z: number, len: number, r: number, color = MISSILE): void {
  b.cyl(r, len, x, y, z, 'z', color, { paint: P_FIXED, ao: 0.1 }, 5, r * 0.45);
  b.box(r * 5, 0.025, r * 1.4, x, y, z + len * 0.4, 0x6a6a64, { paint: P_FIXED, ao: 0 });
  b.box(0.025, r * 5, r * 1.4, x, y, z + len * 0.4, 0x6a6a64, { paint: P_FIXED, ao: 0 });
  b.cyl(r * 1.02, len * 0.1, x, y, z - len * 0.1, 'z', 0xc8b040, { paint: P_FIXED }, 5);
}

// -------------------------------------------------------------------------- Kampfhubschrauber

export function buildHeliAttack(): ModelDef {
  const b = new ModelBuilder();
  // Rumpf (Seitenprofil) – Bug flach, Triebwerksbereich hoch
  b.extrudeX([[-3.5, 1.15], [-3.0, 0.8], [1.6, 0.8], [2.6, 1.3], [2.7, 2.2], [0.2, 2.6], [-1.6, 2.4], [-3.15, 1.9]], 1.25, 0, 0, 0, HULL, { camo: 0.8, taper: [0.8, 0.9] });
  // Tandem-Kanzel: Richtschütze vorn tief, Pilot hinten erhöht
  b.extrudeX([[-3.2, 1.75], [-2.7, 2.35], [-1.8, 2.45], [-1.7, 1.8]], 0.85, 0, 0, 0, GLASS, { paint: P_FIXED, taper: [1, 0.6], ao: 0 });
  b.extrudeX([[-1.5, 2.2], [-1.0, 2.95], [0.1, 3.0], [0.8, 2.4]], 0.85, 0, 0, 0, GLASS, { paint: P_FIXED, taper: [1, 0.6], ao: 0 });
  b.box(0.95, 0.07, 0.1, 0, 2.38, -1.65, HULL_DARK, { camo: 1 }); // Kanzelspant
  b.mirror(() => b.box(0.34, 0.5, 2.0, 0.7, 2.0, -0.4, HULL_LIGHT, { camo: 0.8, rot: [0, 0, -0.1] })); // Panzerwannen
  // Triebwerksgondeln mit Auslass
  b.mirror(() => {
    b.cyl(0.4, 2.6, 0.82, 2.35, 1.5, 'z', HULL_LIGHT, { seg: 7 }, 7, 0.42);
    b.cyl(0.26, 0.6, 0.82, 2.35, 2.95, 'z', DARK, { paint: P_FIXED }, 6);
    b.box(0.5, 0.3, 0.9, 0.65, 2.9, 0.25, HULL_DARK, { camo: 1 });
  });
  // Heckausleger, Stabilisator, Seitenleitwerk, Heckrotornabe
  b.cyl(0.27, 5.6, 0, 2.15, 5.5, 'z', HULL, { seg: 6, camo: false }, 6, 0.5);
  b.extrudeX([[6.3, 2.2], [7.5, 3.9], [8.3, 3.9], [8.1, 2.2]], 0.12, 0, 0, 0, 0xffffff, { paint: P_TEAM, ao: 0.1 });
  b.box(2.8, 0.1, 0.8, 0, 2.2, 7.5, HULL_LIGHT, { camo: 1, top: [0.7, 0.8] });
  b.cyl(0.12, 0.45, 0.2, 3.0, 8.15, 'x', DARK, { paint: P_FIXED }, 5);
  b.box(0.1, 0.1, 0.6, 0.0, 2.2, 8.4, DARK, { paint: P_FIXED });
  // Stummelflügel mit Raketenbehältern und Panzerabwehrlenkwaffen
  b.mirror(() => {
    b.slab([[0.5, -0.9], [2.55, -0.3], [2.55, 0.35], [0.5, 0.85]], 0, 0.13, 0, 1.5, 0.0, HULL, { camo: 0.8 });
    rocketPod(b, 1.5, 1.15, -0.3);
    for (let i = 0; i < 2; i++) {
      b.box(0.1, 0.18, 1.2, 2.05 + i * 0.01, 1.25 - i * 0.0, 0.0, STEEL, { paint: P_FIXED });
      missile(b, 2.1, 1.28 - i * 0.2, -0.15, 1.8, 0.07);
    }
    b.cyl(0.03, 1.8, 2.5, 1.9, 0.1, 'y', DARK, { paint: P_FIXED }, 4); // Wingtip-Antenne
  });
  // Bugkanone (30 mm) + Sensorkopf
  b.lathe([[0, 0], [0.26, 0], [0.2, 0.2], [0, 0.22]], 'y', 0, 0.65, -2.6, 0x55554e, { paint: P_FIXED, seg: 7 });
  b.barrel(0.05, 1.5, 0, 0.55, -2.6, -0.15, 0x3a3a34, 5);
  b.box(0.55, 0.5, 0.7, 0, 1.45, -3.95, 0x2a2a26, { paint: P_FIXED, top: [0.85, 0.8] }); // TADS
  b.box(0.35, 0.3, 0.04, 0, 1.5, -4.3, GLASS_LIGHT, { paint: P_FIXED });
  b.box(0.28, 0.24, 0.3, 0, 2.5, -3.3, 0x2a2a26, { paint: P_FIXED }); // PNVS
  // Rotormast und Nabe
  b.cyl(0.17, 0.6, 0, 3.0, -0.8, 'y', DARK, { paint: P_FIXED }, 6);
  b.cyl(0.14, 0.7, 0, 3.0, -0.8, 'y', 0x3a3a34, { paint: P_FIXED }, 6);
  b.box(0.2, 0.2, 0.3, 0, 3.2, -0.8, 0x4a4a44, { paint: P_FIXED });
  // Fahrwerk: zwei Bugräder + Heckrad
  b.mirror(() => {
    b.box(0.1, 0.55, 0.12, 0.72, 0.55, -2.0, DARK, { paint: P_FIXED });
    b.cyl(0.17, 0.12, 0.76, 0.22, -2.0, 'x', TIRE, { paint: P_FIXED }, 6);
  });
  b.box(0.1, 0.9, 0.12, 0, 1.55, 4.2, DARK, { paint: P_FIXED, rot: [0.25, 0, 0] });
  b.cyl(0.14, 0.1, 0, 0.32, 4.4, 'x', TIRE, { paint: P_FIXED }, 6);
  b.mirror(() => b.box(0.9, 0.04, 0.5, 0.0, 0.0, 0.0, DARK, { paint: P_FIXED }));
  b.box(0.45, 0.05, 0.9, 0, 2.62, 0.5, 0xffffff, { paint: P_TEAM, ao: 0 });
  return {
    geom: b.build({ groundAO: 0.2, groundH: 0.8 }),
    size: 15,
    boost: 1,
    rotors: [[0, 3.55, -0.8, 6.5], [0.3, 3.0, 8.15, 1.15, 'x']],
    livery: 'heli',
    tilt: false,
  };
}

// -------------------------------------------------------------------------- Transporthubschrauber (Tandem)

export function buildHeliTransport(): ModelDef {
  const b = new ModelBuilder();
  b.extrudeX([[-7.3, 1.7], [-6.9, 0.95], [5.0, 0.9], [7.4, 2.2], [7.4, 3.2], [5.5, 3.5], [-5.6, 3.55], [-7.0, 3.2]], 2.5, 0, 0, 0, HULL, { camo: 0.9, taper: [0.92, 0.82] });
  // Bugfenster
  b.box(2.0, 0.7, 0.08, 0, 2.95, -7.2, GLASS, { paint: P_FIXED, rot: [0.2, 0, 0] });
  b.mirror(() => {
    b.plateSide(1.2, 0.5, 1.23, 3.0, -6.4, 1, 0x20303a);
    for (let i = 0; i < 6; i++) b.plateSide(0.6, 0.45, 1.25 - 0.06, 2.75, -3.8 + i * 1.5, 1, 0x20303a);
    b.plateSide(1.8, 1.7, 1.26 - 0.05, 2.1, 2.4, 1, 0x3a3a34); // Ladetür
  });
  // Heckrampe
  b.box(1.9, 0.12, 2.2, 0, 1.7, 8.0, HULL_DARK, { camo: 1, rot: [-0.35, 0, 0] });
  b.box(2.3, 1.5, 0.12, 0, 2.5, 7.45, 0x2a2a26, { paint: P_FIXED });
  // Rotorpylone: vorn niedrig, hinten hoch mit Triebwerksgondeln
  b.box(1.1, 0.8, 1.6, 0, 3.9, -5.6, HULL, { camo: 0.8, top: [0.7, 0.8] });
  b.extrudeX([[3.3, 3.4], [4.8, 5.1], [6.5, 5.1], [7.2, 3.4]], 1.3, 0, 0, 0, HULL, { camo: 0.8, taper: [1, 0.55] });
  b.mirror(() => {
    b.cyl(0.55, 2.8, 1.0, 4.3, 5.8, 'z', HULL_LIGHT, { seg: 7 }, 7, 0.6);
    b.cyl(0.35, 0.5, 1.0, 4.3, 7.3, 'z', DARK, { paint: P_FIXED }, 6);
    // Sponsons mit Tanks und Fahrwerk
    b.box(0.9, 1.1, 5.4, 1.45, 1.35, 0.4, HULL_DARK, { camo: 0.8, top: [0.8, 0.9] });
    b.cyl(0.14, 0.7, 1.45, 0.8, -4.6, 'y', DARK, { paint: P_FIXED }, 5);
    b.cyl(0.35, 0.3, 1.5, 0.35, -4.6, 'x', TIRE, { paint: P_FIXED }, 7);
    b.cyl(0.4, 0.3, 1.5, 0.4, 4.4, 'x', TIRE, { paint: P_FIXED }, 7);
  });
  b.cyl(0.14, 0.5, 0, 4.4, -5.6, 'y', DARK, { paint: P_FIXED }, 6);
  b.cyl(0.14, 0.5, 0, 5.2, 5.6, 'y', DARK, { paint: P_FIXED }, 6);
  b.box(2.52, 0.4, 2.0, 0, 2.2, 3.0, 0xffffff, { paint: P_TEAM, ao: 0 });
  b.cyl(0.03, 1.0, 0, 3.8, 0.5, 'y', DARK, { paint: P_FIXED }, 4);
  b.box(0.1, 1.2, 0.12, 0, 0.3, -5.4, DARK, { paint: P_FIXED, rot: [0, 0, 0] });
  return {
    geom: b.build({ groundAO: 0.2, groundH: 1.0 }),
    size: 20,
    boost: 1,
    rotors: [[0, 4.6, -5.6, 9], [0, 5.5, 5.6, 9]],
    livery: 'heli',
    tilt: false,
  };
}

// -------------------------------------------------------------------------- Kampfflugzeug

export function buildJet(): ModelDef {
  const b = new ModelBuilder();
  // Rumpf (Spitze vorn bei −z)
  b.lathe([[0, -6.5], [0.55, -6.5], [0.7, -4.5], [0.8, -1.5], [0.78, 2.0], [0.6, 4.5], [0.35, 6.2], [0, 7.0]], 'z', 0, 0, 0, HULL, { seg: 8, squash: [1, 1, 0.82], camo: false, ao: 0.2 });
  // Rumpfrücken-Verkleidung (Tarnfläche)
  b.box(0.9, 0.22, 7.5, 0, 0.55, 1.5, HULL, { camo: 0.8, top: [0.8, 0.9] });
  // Radarnase
  b.cyl(0.05, 0.6, 0, 0, -7.2, 'z', 0x3a3a34, { paint: P_FIXED }, 5);
  // Kanzel
  b.extrudeX([[-4.3, 0.5], [-3.2, 1.15], [-1.9, 1.15], [-0.7, 0.55]], 0.72, 0, 0, 0, GLASS, { paint: P_FIXED, taper: [1, 0.5], ao: 0 });
  b.box(0.76, 0.06, 0.1, 0, 0.6, -3.1, DARK, { paint: P_FIXED });
  // Lufteinläufe seitlich/unten
  b.mirror(() => {
    b.box(0.6, 0.55, 2.8, 0.85, -0.25, -2.4, HULL, { camo: 0.8, top: [0.9, 1] });
    b.box(0.5, 0.45, 0.06, 0.85, -0.25, -3.83, 0x1a1a18, { paint: P_FIXED, ao: 0 });
  });
  // Deltaflügel mit Spitzenstationen, Canards, Höhenleitwerk
  b.mirror(() => {
    b.slab([[0.5, -1.2], [5.3, 2.6], [5.3, 3.9], [0.5, 4.8]], -0.12, 0.08, 0, 0, 0, HULL_LIGHT, { camo: 0.9 });
    b.slab([[0.55, -4.9], [2.1, -3.7], [2.1, -3.1], [0.55, -3.3]], 0.0, 0.07, 0, 0.1, 0, HULL_DARK, { camo: 0.9 });
    b.slab([[0.55, 4.8], [2.7, 6.3], [2.7, 6.9], [0.55, 6.9]], -0.1, 0.07, 0, 0, 0, HULL_DARK, { camo: 0.9 });
    missile(b, 5.35, -0.02, 2.4, 2.8, 0.09);
    // Pylone + Lasten
    b.box(0.1, 0.3, 1.2, 2.6, -0.3, 1.6, STEEL, { paint: P_FIXED });
    b.cyl(0.19, 2.4, 2.6, -0.62, 1.4, 'z', 0xb8b8b0, { paint: P_FIXED }, 6, 0.1);
    b.box(0.1, 0.28, 1.0, 4.0, -0.25, 2.4, STEEL, { paint: P_FIXED });
    missile(b, 4.0, -0.52, 2.2, 3.2, 0.09, 0xe0e0d8);
    // Seitenleitwerke (nach außen geneigt)
    b.extrudeX([[3.6, 0.5], [5.2, 3.0], [6.2, 3.0], [6.3, 0.5]], 0.1, 0.6, 0.0, 0.0, 0xffffff, { paint: P_TEAM, rot: [0, 0, -0.18], ao: 0.1 });
    // Triebwerksdüse
    b.cyl(0.36, 0.9, 0.32, 0.0, 6.85, 'z', 0x4a4a44, { paint: P_FIXED, edgeColors: [0x4a4a44, 0x2a2a26, 0x1a1a18] }, 7, 0.3);
  });
  // Bewaffnung unter dem Rumpf (halb eingelassen)
  b.mirror(() => missile(b, 0.5, -0.62, 0.2, 3.6, 0.09));
  void P_CAMO; void GUN; void RED; void WHITE;
  return { geom: b.build({ groundAO: 0 }), size: 16, boost: 1.2, livery: 'air', tilt: false };
}

// -------------------------------------------------------------------------- Jagdbomber (Schwenkflügel)

export function buildBomber(): ModelDef {
  const b = new ModelBuilder();
  b.lathe([[0, -8.6], [0.8, -8.6], [1.0, -5.5], [1.05, -2.0], [1.0, 3.0], [0.75, 6.0], [0.35, 8.2], [0, 8.8]], 'z', 0, 0, 0, HULL, { seg: 8, squash: [1.05, 1, 0.85], camo: false, ao: 0.2 });
  b.box(1.4, 0.3, 11, 0, 0.78, 1.5, HULL, { camo: 0.8, top: [0.85, 0.92] });
  b.cyl(0.07, 1.1, 0, 0, -9.1, 'z', 0x3a3a34, { paint: P_FIXED }, 5); // Sonde
  // Kanzel (Nebeneinander-Sitze)
  b.extrudeX([[-6.5, 0.6], [-5.5, 1.35], [-3.5, 1.35], [-2.2, 0.7]], 1.1, 0, 0, 0, GLASS, { paint: P_FIXED, taper: [1, 0.55], ao: 0 });
  b.box(1.15, 0.07, 0.12, 0, 0.7, -4.6, DARK, { paint: P_FIXED });
  b.mirror(() => {
    // Lufteinläufe an der Flügelwurzel
    b.box(0.75, 0.9, 3.4, 1.2, -0.1, -1.8, HULL, { camo: 0.8, top: [0.85, 1] });
    b.box(0.65, 0.78, 0.06, 1.2, -0.1, -3.53, 0x1a1a18, { paint: P_FIXED, ao: 0 });
    // Schwenkflügel (mittel gepfeilt)
    b.slab([[0.8, -1.6], [7.4, 2.4], [7.4, 4.0], [0.8, 4.4]], -0.12, 0.1, 0, 0, 0, HULL_LIGHT, { camo: 0.9 });
    // Handschuh
    b.slab([[0.8, -3.6], [2.2, -1.6], [2.2, 4.3], [0.8, 4.4]], -0.1, 0.12, 0, 0, 0, HULL_LIGHT, { camo: 0.9 });
    // Außenlasten: Tanks und Lenkwaffen
    b.box(0.12, 0.4, 1.4, 3.6, -0.3, 1.6, STEEL, { paint: P_FIXED });
    b.cyl(0.35, 3.6, 3.6, -0.78, 1.4, 'z', 0xb8b8b0, { paint: P_FIXED }, 7, 0.2);
    b.box(0.12, 0.35, 1.2, 5.6, -0.25, 2.6, STEEL, { paint: P_FIXED });
    missile(b, 5.6, -0.55, 2.4, 3.4, 0.14, 0x9a9a92);
    // Höhenleitwerk
    b.slab([[0.7, 5.7], [4.2, 7.4], [4.2, 8.1], [0.7, 8.4]], -0.15, 0.1, 0, 0.1, 0, HULL_DARK, { camo: 0.9 });
    // Triebwerksdüsen (zwei)
    b.cyl(0.56, 1.0, 0.5, -0.1, 8.5, 'z', 0x4a4a44, { paint: P_FIXED, edgeColors: [0x4a4a44, 0x2a2a26, 0x1a1a18] }, 8, 0.46);
  });
  // Seitenleitwerk (hoch) und Bauchlasten
  b.extrudeX([[4.4, 0.8], [6.6, 4.8], [8.2, 4.8], [8.6, 0.8]], 0.16, 0, 0, 0, 0xffffff, { paint: P_TEAM, ao: 0.1 });
  b.box(0.3, 0.3, 1.4, 0, 0.5, 8.0, HULL_DARK, { camo: 1 });
  for (let i = 0; i < 2; i++) {
    for (const x of [-0.45, 0.45]) {
      b.box(0.08, 0.2, 0.9, x, -0.85, -0.8 + i * 3.4, STEEL, { paint: P_FIXED });
      b.cyl(0.2, 2.4, x, -1.1, -0.9 + i * 3.4, 'z', 0x7a7a52, { paint: P_FIXED }, 6, 0.12); // Freifallbomben
    }
  }
  return { geom: b.build({ groundAO: 0 }), size: 22, boost: 1.2, livery: 'air', tilt: false };
}

// -------------------------------------------------------------------------- Drohnen

export function buildDroneFixed(): ModelDef {
  const b = new ModelBuilder();
  // Schlanker Rumpf, Nase mit Antennenhöcker, Sensorkugel
  b.lathe([[0, -3.2], [0.22, -3.2], [0.36, -1.6], [0.36, 1.2], [0.2, 2.8], [0.1, 3.4], [0, 3.6]], 'z', 0, 0, 0, HULL, { seg: 6, camo: false, ao: 0.2 });
  b.lathe([[0, 0], [0.42, 0], [0.4, 0.4], [0.2, 0.6], [0, 0.65]], 'y', 0, 0.2, -1.8, HULL, { seg: 6, squash: [1, 0.8, 1.8], ao: 0.1 }); // Höcker
  b.lathe([[0, 0], [0.2, 0], [0.26, 0.15], [0.2, 0.3], [0, 0.34]], 'y', 0, -0.5, -2.2, 0x2a2a26, { paint: P_FIXED, seg: 6 }); // EO-Kugel
  b.box(0.1, 0.08, 0.04, 0, -0.45, -2.5, GLASS_LIGHT, { paint: P_FIXED });
  // Flügel lang, schmal, leicht nach vorn schräg; Spitzen in Teamfarbe
  b.mirror(() => {
    b.slab([[0.3, -0.7], [7.1, -0.35], [7.1, 0.25], [0.3, 0.6]], 0.0, 0.1, 0, 0.18, 0, HULL_LIGHT, { camo: 0.9 });
    b.box(0.9, 0.12, 0.62, 6.65, 0.28, -0.05, 0xffffff, { paint: P_TEAM, ao: 0 });
    b.box(0.08, 0.16, 0.8, 3.0, -0.0, 0.0, STEEL, { paint: P_FIXED });
    missile(b, 3.0, -0.2, 0.1, 1.5, 0.06);
  });
  // V-Leitwerk
  b.mirror(() => b.slab([[0.0, 0.0], [1.4, 0.5], [1.4, 1.0], [0.0, 1.0]], 0, 0.07, 0.35, 0.35, 2.8, HULL, { rot: [0, 0, 0.7], camo: 0.6 }));
  // Druckpropeller
  b.cyl(0.13, 0.35, 0, 0.0, 3.55, 'z', 0x2a2a26, { paint: P_FIXED }, 5);
  b.box(1.6, 0.04, 0.08, 0, 0.0, 3.8, 0x1c1c1a, { paint: P_FIXED, rot: [0, 0, 0.7] });
  b.box(0.1, 0.4, 0.1, 0, -0.35, 0.8, DARK, { paint: P_FIXED }); // Fahrwerk
  return { geom: b.build({ groundAO: 0 }), size: 12, boost: 1.6, livery: 'air', tilt: false };
}

export function buildDroneQuad(): ModelDef {
  const b = new ModelBuilder();
  b.box(0.14, 0.06, 0.22, 0, 0.1, 0, HULL, { camo: false, ao: 0.1 });
  b.box(0.09, 0.04, 0.12, 0, 0.15, 0.03, 0x2a2a26, { paint: P_FIXED }); // Akku
  b.box(0.05, 0.05, 0.05, 0, 0.1, -0.13, 0x1a1a18, { paint: P_FIXED }); // Kamera
  b.box(0.52, 0.02, 0.03, 0, 0.1, 0, 0x1c1c1a, { paint: P_FIXED, rot: [0, Math.PI / 4, 0] });
  b.box(0.52, 0.02, 0.03, 0, 0.1, 0, 0x1c1c1a, { paint: P_FIXED, rot: [0, -Math.PI / 4, 0] });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.cyl(0.03, 0.05, sx * 0.18, 0.12, sz * 0.18, 'y', 0x3a3a34, { paint: P_FIXED }, 4);
  // sichtbare Nutzlast (Hohlladung) unter dem Rumpf
  b.cyl(0.05, 0.22, 0, 0.0, -0.01, 'z', 0x7a4a2a, { paint: P_FIXED, edgeColors: [0x7a4a2a, 0x7a4a2a] }, 6, 0.035);
  b.box(0.1, 0.04, 0.05, 0, 0.14, 0.1, 0xffffff, { paint: P_TEAM, ao: 0 });
  return {
    geom: b.build({ groundAO: 0 }),
    size: 0.5,
    boost: 7,
    rotors: [[0.18, 0.15, 0.18, 0.1], [-0.18, 0.15, 0.18, 0.1], [0.18, 0.15, -0.18, 0.1], [-0.18, 0.15, -0.18, 0.1]],
    livery: 'air',
    tilt: false,
  };
}
