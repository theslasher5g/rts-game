/** Phase 4 – Infanterie: Soldat mit Helm, Weste, Rucksack, Waffe; Varianten je Truppentyp. */
import { BLACK, DARK, HULL, HULL_DARK, HULL_LIGHT, ModelBuilder, P_CAMO, P_FIXED, P_TEAM, RED, WHITE, type ModelDef } from './geomUtils';

export type SoldierKind = 'inf' | 'mg' | 'at' | 'sniper' | 'medic' | 'eng' | 'mortar';

const SKIN = 0xc89878;
const BOOT = 0x1c1a16;
const WOOD = 0x6a4a2a;
const METAL = 0x77776f;

/** Waffenteile (Gewehr, quer vor der Brust gehalten) */
function rifle(b: ModelBuilder, long = false, scope = false): void {
  const L = long ? 1.0 : 0;
  b.box(0.05, 0.1, 0.22, 0.1, 1.27, 0.06, DARK, { paint: P_FIXED, ao: 0.1 }); // Schaft
  b.box(0.06, 0.1, 0.34, 0.1, 1.26, -0.2, DARK, { paint: P_FIXED, ao: 0.1 }); // Gehäuse
  b.box(0.045, 0.14, 0.07, 0.1, 1.15, -0.2, 0x3a3a34, { paint: P_FIXED, rot: [0.2, 0, 0], ao: 0.1 }); // Magazin
  b.box(0.05, 0.06, 0.26 + L * 0.2, 0.1, 1.27, -0.5 - L * 0.1, 0x55554e, { paint: P_FIXED, ao: 0.1 }); // Handschutz
  b.cyl(0.014, 0.3 + L * 0.3, 0.1, 1.28, -0.78 - L * 0.28, 'z', BLACK, { paint: P_FIXED }, 4); // Lauf
  b.box(0.04, 0.05, 0.12, 0.1, 1.34, -0.2, BLACK, { paint: P_FIXED }); // Visier / Optik
  if (scope) b.cyl(0.035, 0.4, 0.1, 1.36, -0.25, 'z', BLACK, { paint: P_FIXED }, 5);
}

/** Beine, Stiefel, Hüfte */
function legs(b: ModelBuilder): void {
  b.mirror(() => {
    b.box(0.14, 0.1, 0.3, 0.11, 0.05, -0.03, BOOT, { paint: P_FIXED, front: 0.9 });
    b.box(0.15, 0.46, 0.17, 0.11, 0.33, 0, HULL, { top: [1.1, 1.05], ao: 0.3 });
    b.box(0.185, 0.4, 0.2, 0.115, 0.72, 0.0, HULL, { top: [1.05, 1], ao: 0.1 });
    b.box(0.17, 0.12, 0.05, 0.11, 0.55, -0.1, HULL_DARK, { ao: 0 }); // Knieschoner
  });
}

function head(b: ModelBuilder, helmetColor = HULL_DARK, white = false): void {
  b.box(0.08, 0.07, 0.08, 0, 1.5, 0, SKIN, { paint: P_FIXED, ao: 0.4 });
  b.box(0.17, 0.2, 0.19, 0, 1.62, -0.01, SKIN, { paint: P_FIXED, top: [0.9, 0.9], ao: 0.1 });
  b.box(0.15, 0.04, 0.04, 0, 1.58, -0.11, 0x2a2a26, { paint: P_FIXED, ao: 0 }); // Brille / Schal
  b.lathe([[0, 0], [0.155, 0], [0.165, 0.045], [0.13, 0.12], [0, 0.155]], 'y', 0, 1.67, 0, white ? 0xe8e8e8 : helmetColor, { seg: 7, squash: [1, 1, 1.1], paint: white ? P_FIXED : P_CAMO, ao: 0.1 });
  b.box(0.06, 0.05, 0.05, 0, 1.75, -0.15, 0x2a2a26, { paint: P_FIXED }); // NVG-Halterung
}

function torso(b: ModelBuilder): void {
  b.box(0.2, 0.14, 0.24, 0, 0.96, 0, HULL_DARK, { ao: 0.2 }); // Hüftgurt
  b.box(0.42, 0.52, 0.25, 0, 1.28, 0, HULL, { top: [1.12, 1], ao: 0.1 }); // Oberkörper
  b.box(0.45, 0.34, 0.285, 0, 1.3, -0.005, HULL_DARK, { ao: 0.1 }); // Plattenträger
  b.box(0.3, 0.26, 0.05, 0, 1.32, -0.16, 0x4a4a42, { paint: P_FIXED, ao: 0.1 }); // Schutzplatte
  b.box(0.3, 0.1, 0.07, 0, 1.1, -0.17, 0x3a3a34, { paint: P_FIXED, ao: 0 }); // Magazintaschen
  b.mirror(() => {
    b.box(0.1, 0.12, 0.1, 0.19, 0.98, 0.03, HULL_DARK, { ao: 0 }); // Gürteltasche
    b.box(0.08, 0.3, 0.1, 0.25, 1.37, -0.02, HULL, { rot: [-0.55, 0, -0.06], ao: 0.1 }); // Oberarm
  });
  // rechter Unterarm / Hand am Griff, linker Unterarm am Handschutz
  b.box(0.08, 0.08, 0.27, 0.17, 1.2, -0.2, HULL, { rot: [0, 0.1, 0] });
  b.box(0.08, 0.08, 0.3, 0.07, 1.24, -0.42, HULL, { rot: [0, -0.1, 0] });
  b.box(0.06, 0.06, 0.06, 0.1, 1.24, -0.58, SKIN, { paint: P_FIXED });
  b.box(0.06, 0.06, 0.06, 0.17, 1.2, -0.08, SKIN, { paint: P_FIXED });
}

export function buildSoldier(kind: SoldierKind): ModelDef {
  const b = new ModelBuilder();
  legs(b);
  torso(b);
  head(b, HULL_DARK, kind === 'medic');
  const packTeam = kind !== 'medic';

  switch (kind) {
    case 'inf':
      rifle(b);
      b.box(0.36, 0.4, 0.2, 0, 1.28, 0.22, 0xffffff, { paint: P_TEAM, ao: 0.2 });
      b.cyl(0.07, 0.34, 0, 1.53, 0.22, 'x', HULL, { seg: 5, ao: 0.1 });
      break;
    case 'mg':
      // MG mit Zweibein und Gurtkasten
      b.box(0.07, 0.14, 0.5, 0.1, 1.25, -0.18, 0x3a3a34, { paint: P_FIXED, ao: 0.1 });
      b.cyl(0.02, 0.5, 0.1, 1.27, -0.68, 'z', BLACK, { paint: P_FIXED }, 4);
      b.box(0.04, 0.14, 0.05, 0.1, 1.28, -0.95, BLACK, { paint: P_FIXED });
      b.mirror(() => b.box(0.02, 0.3, 0.02, 0.15, 1.12, -0.75, METAL, { paint: P_FIXED, rot: [0.5, 0, 0.3] }));
      b.box(0.14, 0.17, 0.2, 0.0, 1.1, -0.25, HULL_DARK, { ao: 0.1 });
      b.box(0.07, 0.04, 0.3, 0.07, 1.16, -0.3, 0xb09a50, { paint: P_FIXED });
      b.box(0.38, 0.42, 0.22, 0, 1.28, 0.22, 0xffffff, { paint: P_TEAM, ao: 0.2 });
      b.box(0.18, 0.2, 0.14, 0.15, 1.0, 0.3, 0x5a6a4a, { paint: P_FIXED }); // Munitionskasten
      break;
    case 'at':
      // Panzerfaust / Einmalwaffe auf der Schulter
      b.push(0.17, 1.52, -0.05, [0.02, 0, 0]);
      b.cyl(0.058, 1.1, 0, 0, -0.1, 'z', 0x55604a, { paint: P_FIXED }, 6);
      b.cyl(0.09, 0.2, 0, 0, 0.55, 'z', 0x3a3a34, { paint: P_FIXED }, 6, 0.06);
      b.cyl(0.075, 0.12, 0, 0, -0.68, 'z', 0x3a3a34, { paint: P_FIXED }, 6);
      b.box(0.05, 0.09, 0.14, 0, 0.1, -0.2, BLACK, { paint: P_FIXED });
      b.pop();
      b.box(0.1, 0.07, 0.3, 0.1, 1.1, -0.1, DARK, { paint: P_FIXED }); // Pistole/PDW tief
      b.box(0.36, 0.4, 0.26, 0, 1.28, 0.22, 0xffffff, { paint: P_TEAM, ao: 0.2 });
      b.cyl(0.07, 0.34, 0.12, 1.1, 0.4, 'z', 0x55604a, { paint: P_FIXED }, 5); // Reserverohr
      break;
    case 'sniper':
      rifle(b, true, true);
      b.mirror(() => b.box(0.02, 0.26, 0.02, 0.14, 1.1, -0.85, METAL, { paint: P_FIXED, rot: [0.5, 0, 0.2] }));
      // Ghillie-Umhang: Schichten aus struppigen Tarnstücken über Kopf, Schultern, Rücken
      b.extrudeX([[0.15, 1.7], [0.3, 1.55], [0.42, 0.7], [0.2, 0.55], [0.1, 1.2]], 0.5, 0, 0, 0, 0xd0d8c0, { camo: 0.35, taper: [1, 0.85], ao: 0.2 });
      for (let i = 0; i < 9; i++) {
        const a = i * 2.1;
        b.box(0.14, 0.2 + (i % 3) * 0.06, 0.1, Math.sin(a) * 0.24, 1.55 - (i % 4) * 0.18, 0.18 + Math.cos(a) * 0.06, i % 2 ? HULL_LIGHT : HULL_DARK, { rot: [0.2 * (i % 3), a, 0.3 * Math.sin(a)], ao: 0.1 });
      }
      b.lathe([[0, 0], [0.24, 0], [0.26, 0.03], [0.12, 0.1], [0, 0.12]], 'y', 0, 1.7, 0.0, HULL_DARK, { seg: 7, ao: 0.1 }); // Buschhut
      b.box(0.34, 0.1, 0.2, 0, 1.0, 0.32, 0xffffff, { paint: P_TEAM, ao: 0.2 });
      break;
    case 'medic':
      rifle(b);
      // Sanitätsrucksack mit rotem Kreuz
      b.box(0.4, 0.44, 0.24, 0, 1.27, 0.23, 0xe6e6e0, { paint: P_FIXED, ao: 0.25 });
      b.plateFront(0.3, 0.3, 0, 1.3, 0.355, 1, WHITE);
      b.plateFront(0.24, 0.07, 0, 1.3, 0.358, 1, RED);
      b.plateFront(0.07, 0.24, 0, 1.3, 0.358, 1, RED);
      b.box(0.22, 0.18, 0.16, -0.0, 1.55, 0.2, 0xe6e6e0, { paint: P_FIXED });
      // Kreuze am Helm und Oberarm
      b.mirror(() => {
        b.plateSide(0.1, 0.03, 0.172, 1.71, 0.0, 1, RED);
        b.plateSide(0.03, 0.1, 0.173, 1.71, 0.0, 1, RED);
        b.plateSide(0.1, 0.03, 0.3, 1.38, -0.02, 1, RED);
        b.plateSide(0.03, 0.1, 0.301, 1.38, -0.02, 1, RED);
      });
      b.box(0.28, 0.2, 0.12, -0.28, 0.88, -0.1, 0xe6e6e0, { paint: P_FIXED }); // Sanitätstasche seitlich
      b.plateSide(0.1, 0.1, -0.35, 0.88, -0.1, -1, RED);
      break;
    case 'eng':
      rifle(b);
      b.box(0.44, 0.5, 0.3, 0, 1.25, 0.25, 0xffffff, { paint: P_TEAM, ao: 0.2 });
      b.box(0.3, 0.2, 0.2, 0, 1.6, 0.25, HULL, { ao: 0.2 });
      // Spitzhacke schräg am Rucksack
      b.cyl(0.018, 1.0, -0.2, 1.2, 0.36, 'y', WOOD, { paint: P_FIXED, rot: [0, 0, -0.15] }, 4);
      b.box(0.36, 0.04, 0.05, -0.25, 1.7, 0.36, METAL, { paint: P_FIXED });
      // Sprengladung/Kabelrolle am Gürtel
      b.cyl(0.09, 0.14, -0.26, 0.9, 0.05, 'x', 0xc86a20, { paint: P_FIXED }, 6);
      b.box(0.16, 0.12, 0.12, 0.26, 0.9, 0.08, 0x8a7a50, { paint: P_FIXED });
      break;
    case 'mortar':
      rifle(b);
      // Mörserrohr geschultert, Bodenplatte auf dem Rücken, Munitionstaschen
      b.push(-0.08, 1.52, 0.1, [0.5, 0, 0.08]);
      b.cyl(0.06, 1.1, 0, 0, 0, 'z', 0x4a4a42, { paint: P_FIXED }, 6);
      b.cyl(0.075, 0.1, 0, 0, 0.52, 'z', 0x3a3a34, { paint: P_FIXED }, 6);
      b.pop();
      b.box(0.34, 0.06, 0.34, 0, 1.28, 0.28, 0x55554e, { paint: P_FIXED, rot: [Math.PI / 2 - 0.15, 0, 0] });
      b.box(0.4, 0.4, 0.14, 0, 1.28, 0.38, 0xffffff, { paint: P_TEAM, ao: 0.2 });
      b.box(0.14, 0.3, 0.14, -0.27, 0.95, 0.1, 0x5a6a4a, { paint: P_FIXED });
      break;
  }
  void packTeam;
  void P_CAMO;
  return { geom: b.build({ groundAO: 0.35, groundH: 0.35 }), size: 0.7, boost: 2.2, livery: 'ground', tilt: false };
}
