/**
 * Infanterie – Soldat mit Anatomie (Kopf/Helm/Gesicht, Hals, Torso mit Plattenträger + Taschen, Arme mit Ellbogenschonern
 * und Handschuhen, Gürtel, Rucksack, Hose mit Beintaschen, Stiefel) und Waffenvarianten je Truppentyp (~1100-1500 Dreiecke).
 *
 * Animationsgruppen (aPart/aPivot, Vertex-Shader im UnitRenderer):
 *   0 Becken (statisch) · 1 Oberschenkel · 2 Unterschenkel+Stiefel · 3 Oberkörper/Kopf/Rucksack ·
 *   4 Arme+Waffe (hebt sich im Anschlag) · 5 baumelnde Ausrüstung (Feldflasche, Granaten) ·
 *   6/7 optionale Ausrüstung (je Instanz per Hash sichtbar/unsichtbar: NVG, Halstuch, Zusatztasche …)
 * Farbkanäle: P_CAMO = Tarnung (Fragment-Muster je Nation), P_GEAR = Weste/Taschen (Nationenton), P_SKIN = Hautton (Hash),
 * P_TEAM = Teamfarbe (Rucksackpaneel), P_FIXED = feste Farbe.
 */
import { BLACK, DARK, GLASS, HULL, HULL_DARK, HULL_LIGHT, ModelBuilder, P_CAMO, P_FIXED, P_GEAR, P_SKIN, P_TEAM, RED, WHITE, type ModelDef } from './geomUtils';

export type SoldierKind = 'inf' | 'mg' | 'at' | 'sniper' | 'medic' | 'eng' | 'mortar';

const BOOT = 0x1c1a16;
const WOOD = 0x6a4a2a;
const METAL = 0x77776f;
const GUNM = 0x3a3a34;
const SK = 0xffffff;
const GEAR = 0xe8e8e8;
const GEAR_D = 0xb0b0b0;

const fx = { paint: P_FIXED } as const;
const gear = { paint: P_GEAR, ao: 0.1 } as const;

/** Hose, Stiefel (Parts 1 und 2) */
function legs(b: ModelBuilder): void {
  b.mirror(() => {
    b.part(1, [0.105, 0.93, 0], () => {
      b.box(0.17, 0.42, 0.19, 0.105, 0.72, 0, HULL, { top: [1.12, 1.06], ao: 0.12 }); // Oberschenkel
      b.box(0.045, 0.17, 0.13, 0.2, 0.7, 0.0, HULL_DARK, { ao: 0 }); // Beintasche
      b.box(0.048, 0.04, 0.135, 0.2, 0.8, 0.0, HULL_LIGHT, { ao: 0 }); // Taschenklappe
    });
    b.part(2, [0.105, 0.5, 0], () => {
      b.box(0.145, 0.34, 0.165, 0.105, 0.32, 0, HULL, { top: [1.12, 1.08], ao: 0.15 }); // Unterschenkel
      b.box(0.15, 0.1, 0.06, 0.105, 0.52, -0.105, GEAR, { paint: P_GEAR, ao: 0 }); // Knieschoner
      b.box(0.155, 0.17, 0.19, 0.105, 0.17, 0, BOOT, { ...fx, top: [0.95, 0.95], ao: 0.1 }); // Stiefelschaft
      b.box(0.14, 0.07, 0.13, 0.105, 0.05, -0.15, BOOT, { ...fx, ao: 0.1 }); // Kappe
      b.box(0.15, 0.03, 0.31, 0.105, 0.015, -0.04, 0x0e0e0c, { ...fx, ao: 0 }); // Sohle
    });
  });
}

/** Gürtel, Hüfte, Holster, Taschen (Part 0 / 5) */
function pelvis(b: ModelBuilder): void {
  b.box(0.34, 0.16, 0.22, 0, 0.92, 0, HULL, { top: [1.08, 1], ao: 0.15 });
  b.box(0.37, 0.05, 0.25, 0, 1.0, 0, GEAR, gear); // Koppel
  b.box(0.07, 0.05, 0.02, 0, 1.0, -0.13, METAL, fx); // Schnalle
  b.box(0.06, 0.2, 0.11, 0.2, 0.87, -0.02, 0x2c2c28, { ...fx, rot: [0, 0, -0.05] }); // Holster
  b.box(0.05, 0.05, 0.1, 0.2, 0.96, -0.02, GUNM, fx);
  b.mirror(() => b.box(0.075, 0.1, 0.05, 0.11, 1.01, -0.14, GEAR_D, gear)); // Magazintaschen
  b.box(0.11, 0.1, 0.08, 0.17, 0.99, 0.15, GEAR_D, gear); // Mehrzwecktasche
  b.box(0.15, 0.08, 0.06, -0.08, 0.99, 0.15, GEAR_D, gear); // Packtasche
  b.part(5, [-0.21, 0.98, 0.05], () => {
    b.cyl(0.055, 0.17, -0.21, 0.88, 0.08, 'y', 0x4a5236, { ...fx, ao: 0.1 }, 6); // Feldflasche
    b.box(0.09, 0.1, 0.1, -0.21, 0.83, 0.08, GEAR_D, { paint: P_GEAR, ao: 0.1 }); // Hülle
    b.box(0.03, 0.03, 0.03, -0.21, 0.97, 0.08, METAL, fx);
  });
}

/** Weste, Rumpf, Taschen, Hals (Part 3) */
function torso(b: ModelBuilder): void {
  b.box(0.35, 0.22, 0.22, 0, 1.07, 0, HULL, { top: [1.05, 1], ao: 0.12 }); // Bauch
  b.box(0.43, 0.3, 0.25, 0, 1.3, 0, HULL, { top: [1.1, 1], ao: 0.1 }); // Brust
  b.box(0.5, 0.1, 0.23, 0, 1.46, 0, HULL, { ao: 0.05 }); // Schultern
  b.box(0.34, 0.32, 0.07, 0, 1.28, -0.155, GEAR, gear); // Frontplatte
  b.box(0.34, 0.32, 0.06, 0, 1.28, 0.145, GEAR, gear); // Rückenplatte
  b.box(0.4, 0.12, 0.29, 0, 1.12, 0, GEAR_D, gear); // Kummerbund
  b.mirror(() => {
    b.box(0.07, 0.03, 0.29, 0.13, 1.485, 0, GEAR, gear); // Schulterriemen
    b.box(0.055, 0.05, 0.09, 0.27, 1.5, 0, HULL_DARK, { ao: 0 }); // Epaulette
    b.plateSide(0.07, 0.07, 0.305, 1.43, 0.0, 1, 0xffffff, P_TEAM); // Nationalabzeichen
  });
  for (let i = -1; i <= 1; i++) b.box(0.075, 0.13, 0.05, i * 0.095, 1.17, -0.205, GEAR_D, { paint: P_GEAR, ao: 0.1 }); // Magazintaschen
  b.box(0.3, 0.02, 0.02, 0, 1.24, -0.2, 0x2c2c26, fx); // Riemen
  // Funkgerät links, IFAK rechts, Granaten
  b.box(0.075, 0.15, 0.05, -0.15, 1.36, -0.205, 0x26262a, fx);
  b.cyl(0.008, 0.3, -0.16, 1.58, -0.2, 'y', BLACK, fx, 4);
  b.box(0.09, 0.09, 0.05, 0.16, 1.1, -0.215, 0x7a3030, fx);
  b.cyl(0.026, 0.075, 0.12, 1.4, -0.2, 'y', 0x4a5a3a, fx, 4);
  b.cyl(0.026, 0.075, 0.18, 1.4, -0.2, 'y', 0x4a5a3a, fx, 4);
  // Hals + Kragen
  b.box(0.085, 0.07, 0.085, 0, 1.53, 0, SK, { paint: P_SKIN, ao: 0.4 });
  b.box(0.15, 0.05, 0.14, 0, 1.505, 0.0, HULL_DARK, { ao: 0 });
}

/** Kopf: Schädel, Kiefer, Nase, Ohren, Brille, Helm mit Riemen, Headset (Part 3, 6) */
function head(b: ModelBuilder, white = false): void {
  b.box(0.155, 0.2, 0.185, 0, 1.64, 0, SK, { paint: P_SKIN, ao: 0.1, top: [0.92, 0.92] });
  b.box(0.12, 0.07, 0.15, 0, 1.553, -0.015, SK, { paint: P_SKIN, ao: 0.2, top: [1.15, 1] }); // Kiefer
  b.box(0.035, 0.045, 0.035, 0, 1.62, -0.105, SK, { paint: P_SKIN, ao: 0 }); // Nase
  b.box(0.07, 0.014, 0.012, 0, 1.575, -0.1, 0x5a2a22, fx); // Mund
  b.mirror(() => {
    b.box(0.018, 0.05, 0.04, 0.086, 1.635, 0.015, SK, { paint: P_SKIN, ao: 0 }); // Ohr
    b.box(0.04, 0.025, 0.012, 0.04, 1.655, -0.1, 0x1a1a18, fx); // Augenbrauen/Augenpartie
    b.box(0.045, 0.065, 0.075, 0.1, 1.63, 0.025, 0x26262a, fx); // Headset
  });
  b.box(0.17, 0.045, 0.045, 0, 1.655, -0.105, GLASS, { ...fx, ao: 0 }); // Schutzbrille
  // Helm (Schale mit Tarnüberzug)
  b.lathe([[0, 0], [0.155, 0], [0.168, 0.045], [0.135, 0.12], [0, 0.158]], 'y', 0, 1.675, 0, white ? 0xe8e8e8 : HULL_DARK, { seg: 8, squash: [1, 1, 1.1], paint: white ? P_FIXED : P_CAMO, ao: 0.1 });
  b.box(0.17, 0.03, 0.045, 0, 1.718, -0.17, DARK, fx); // Helmkrempe vorn
  b.box(0.13, 0.05, 0.04, 0, 1.7, 0.168, white ? 0xd0d0d0 : HULL, { paint: white ? P_FIXED : P_CAMO, ao: 0.05 }); // Nackenschutz
  b.box(0.065, 0.05, 0.05, 0, 1.775, -0.14, DARK, fx); // NVG-Halterung
  b.part(6, [0, 1.8, -0.15], () => {
    b.box(0.1, 0.055, 0.07, 0, 1.805, -0.19, 0x1a1a18, fx); // NVG hochgeklappt
    b.mirror(() => b.cyl(0.02, 0.06, 0.03, 1.815, -0.225, 'z', GLASS, fx, 5));
  });
  b.part(7, [0, 1.52, -0.05], () => {
    b.box(0.24, 0.07, 0.22, 0, 1.51, -0.01, HULL_LIGHT, { ao: 0.05 }); // Halstuch
    b.box(0.2, 0.05, 0.05, 0, 1.46, -0.12, HULL_LIGHT, { ao: 0.05 });
  });
}

/** Arme in Ruhehaltung am Gewehr: Oberarm, Ellbogenschoner, Unterarm, Handschuh mit Fingern (Part 4) */
function arms(b: ModelBuilder): void {
  b.mirror(() => {
    b.box(0.095, 0.3, 0.105, 0.25, 1.37, -0.02, HULL, { rot: [-0.55, 0, -0.06], ao: 0.1 }); // Oberarm
    b.box(0.1, 0.07, 0.11, 0.255, 1.25, -0.1, GEAR, { paint: P_GEAR, rot: [-0.55, 0, 0], ao: 0 }); // Ellbogenschoner
  });
  // rechter Unterarm zum Griff, linker Unterarm zum Handschutz
  b.box(0.085, 0.085, 0.27, 0.17, 1.2, -0.2, HULL, { rot: [0, 0.1, 0] });
  b.box(0.09, 0.09, 0.05, 0.17, 1.2, -0.33, HULL_DARK, { rot: [0, 0.1, 0], ao: 0 }); // Ärmelaufschlag
  b.box(0.08, 0.085, 0.3, 0.07, 1.24, -0.42, HULL, { rot: [0, -0.1, 0] });
  b.box(0.085, 0.09, 0.05, 0.07, 1.24, -0.57, HULL_DARK, { rot: [0, -0.1, 0], ao: 0 });
  // Handschuhe
  b.box(0.07, 0.07, 0.08, 0.17, 1.19, -0.08, 0x26262a, fx);
  b.box(0.04, 0.03, 0.05, 0.17, 1.16, -0.1, 0x26262a, fx);
  b.box(0.075, 0.07, 0.08, 0.075, 1.245, -0.64, 0x26262a, fx);
  for (let i = 0; i < 3; i++) b.box(0.015, 0.02, 0.05, 0.05 + i * 0.022, 1.225, -0.68, 0x1c1c1e, fx);
  b.box(0.02, 0.025, 0.05, 0.11, 1.265, -0.62, 0x1c1c1e, fx); // Daumen
}

/** Sturmgewehr mit Optik, Vordergriff, Magazin, Gurt (Part 4) */
function rifle(b: ModelBuilder, o: { long?: boolean; scope?: boolean; gl?: boolean } = {}): void {
  const X = 0.1, Y = 1.265;
  b.box(0.055, 0.1, 0.22, X, Y + 0.005, 0.06, DARK, fx); // Schaft
  b.box(0.06, 0.12, 0.035, X, Y, 0.18, BLACK, fx); // Schaftkappe
  b.box(0.06, 0.035, 0.12, X, Y + 0.075, 0.1, DARK, fx); // Wangenauflage
  b.box(0.062, 0.1, 0.34, X, Y, -0.2, DARK, fx); // Gehäuse
  b.box(0.066, 0.025, 0.12, X, Y + 0.04, -0.2, METAL, fx); // Auswurfschacht
  b.box(0.04, 0.11, 0.05, X, Y - 0.095, -0.07, DARK, { ...fx, rot: [-0.3, 0, 0] }); // Pistolengriff
  b.box(0.02, 0.02, 0.08, X, Y - 0.05, -0.13, DARK, fx); // Abzugsbügel
  b.box(0.05, 0.12, 0.07, X, Y - 0.115, -0.22, GUNM, { ...fx, rot: [0.15, 0, 0] }); // Magazin
  b.box(0.05, 0.07, 0.07, X, Y - 0.2, -0.235, GUNM, { ...fx, rot: [0.3, 0, 0] });
  const L = o.long ? 0.2 : 0;
  b.box(0.062, 0.07, 0.3 + L, X, Y, -0.52 - L * 0.5, 0x55554e, { ...fx, ao: 0.1 }); // Handschutz
  b.box(0.032, 0.016, 0.3 + L, X, Y + 0.045, -0.52 - L * 0.5, METAL, fx); // Schiene
  b.box(0.034, 0.09, 0.034, X, Y - 0.075, -0.5, DARK, fx); // Vordergriff
  b.cyl(0.015, 0.3 + L, X, Y + 0.01, -0.84 - L * 0.5, 'z', BLACK, fx, 4); // Lauf
  b.cyl(0.024, 0.07, X, Y + 0.01, -1.0 - L * 0.5, 'z', DARK, fx, 5); // Mündungsfeuerdämpfer
  b.box(0.012, 0.045, 0.012, X, Y + 0.055, -0.95 - L * 0.5, BLACK, fx); // Korn
  if (o.scope) {
    b.cyl(0.032, 0.34, X, Y + 0.105, -0.22, 'z', BLACK, fx, 6);
    b.cyl(0.042, 0.07, X, Y + 0.105, -0.4, 'z', BLACK, fx, 6);
    b.box(0.03, 0.05, 0.04, X, Y + 0.065, -0.3, METAL, fx);
  } else {
    b.cyl(0.027, 0.16, X, Y + 0.095, -0.22, 'z', BLACK, fx, 6); // Rotpunkt-/Kampfvisier
    b.box(0.045, 0.04, 0.08, X, Y + 0.062, -0.22, METAL, fx);
  }
  if (o.gl) b.cyl(0.032, 0.22, X, Y - 0.05, -0.64, 'z', DARK, fx, 5); // Granatwerfer unter dem Lauf
}

/** Rucksack (Part 3): Team-Paneel + Taschen, Klappspaten, Schlafmatte */
function pack(b: ModelBuilder, big = false, color = P_TEAM): void {
  const d = big ? 0.26 : 0.2;
  b.box(0.38, 0.4, d, 0, 1.27, 0.2 + d / 2 - 0.1, 0xffffff, { paint: color, ao: 0.2 });
  b.box(0.36, 0.09, d + 0.02, 0, 1.51, 0.22, GEAR, gear); // Deckel
  b.mirror(() => {
    b.box(0.08, 0.2, 0.14, 0.22, 1.2, 0.24, GEAR_D, gear); // Seitentaschen
    b.box(0.04, 0.3, 0.03, 0.1, 1.32, 0.12, GEAR, gear); // Tragegurte
  });
  b.box(0.3, 0.025, 0.03, 0, 1.28, 0.34 + (big ? 0.06 : 0), GEAR, gear); // Kompressionsriemen
  b.cyl(0.065, 0.34, 0, 1.585, 0.22, 'x', 0x3a4a30, { ...fx, ao: 0.1 }, 6); // Schlafmatte
  b.part(5, [-0.1, 1.45, 0.34], () => {
    b.cyl(0.011, 0.34, -0.12, 1.28, 0.36 + (big ? 0.06 : 0), 'y', WOOD, fx, 4); // Klappspaten
    b.box(0.1, 0.13, 0.014, -0.12, 1.08, 0.36 + (big ? 0.06 : 0), METAL, fx);
  });
}

/** Kennzeichnung für optionale Zusatzausrüstung (Part 7) */
function extraPouch(b: ModelBuilder): void {
  b.part(7, [0.2, 1.2, 0.2], () => b.box(0.1, 0.16, 0.12, 0.26, 1.15, 0.1, GEAR_D, gear));
}

// ----------------------------------------------------------------------------------------- Varianten

function standardBody(b: ModelBuilder, white = false): void {
  legs(b);
  pelvis(b);
  b.part(3, [0, 0.95, 0], () => {
    torso(b);
    head(b, white);
    extraPouch(b);
  });
}

export function buildSoldier(kind: SoldierKind): ModelDef {
  const b = new ModelBuilder();
  standardBody(b, kind === 'medic');
  b.part(4, [0, 1.42, 0], () => arms(b));

  switch (kind) {
    case 'inf':
      b.part(4, [0, 1.42, 0], () => rifle(b, { gl: true }));
      b.part(3, [0, 0.95, 0], () => pack(b));
      break;
    case 'mg':
      b.part(4, [0, 1.42, 0], () => {
        const X = 0.1, Y = 1.26;
        b.box(0.075, 0.14, 0.5, X, Y, -0.16, GUNM, fx); // Gehäuse
        b.box(0.06, 0.1, 0.24, X, Y, 0.1, DARK, fx); // Schaft
        b.box(0.06, 0.12, 0.035, X, Y, 0.23, BLACK, fx);
        b.box(0.04, 0.1, 0.05, X, Y - 0.1, -0.05, DARK, { ...fx, rot: [-0.3, 0, 0] });
        b.cyl(0.04, 0.38, X, Y + 0.01, -0.6, 'z', 0x55554e, { ...fx, ao: 0.1 }, 6); // Laufmantel
        b.cyl(0.018, 0.3, X, Y + 0.01, -0.9, 'z', BLACK, fx, 5);
        b.cyl(0.028, 0.06, X, Y + 0.01, -1.07, 'z', DARK, fx, 5);
        b.box(0.02, 0.07, 0.2, X, Y + 0.1, -0.3, METAL, fx); // Tragegriff
        b.cyl(0.028, 0.18, X, Y + 0.115, -0.2, 'z', BLACK, fx, 5); // Optik
        // Gurtkasten + Gurt
        b.box(0.12, 0.15, 0.2, X - 0.02, Y - 0.15, -0.2, 0x5a6a4a, { ...fx, ao: 0.1 });
        for (let i = 0; i < 5; i++) b.box(0.035, 0.03, 0.03, X + 0.02 + i * 0.002, Y - 0.04 - i * 0.025, -0.28 - i * 0.002, 0xb09a50, { ...fx, rot: [0, 0, 0.2] });
        // Zweibein (aufgeklappt)
        b.mirror(() => b.box(0.015, 0.3, 0.015, X + 0.06, Y - 0.12, -0.84, METAL, { ...fx, rot: [0.4, 0, 0.25] }));
        b.box(0.04, 0.04, 0.05, X, Y - 0.03, -0.82, METAL, fx);
      });
      b.part(3, [0, 0.95, 0], () => {
        pack(b, true);
        // gekreuzte Munitionsgurte
        b.box(0.05, 0.4, 0.015, 0.02, 1.25, -0.222, 0xb09a50, { ...fx, rot: [0, 0, 0.6] });
        b.box(0.05, 0.4, 0.015, -0.02, 1.25, -0.224, 0xb09a50, { ...fx, rot: [0, 0, -0.6] });
      });
      b.part(5, [0.15, 1.1, 0.3], () => b.box(0.17, 0.2, 0.14, 0.16, 0.98, 0.31, 0x5a6a4a, { ...fx, ao: 0.1 })); // Reserve-Munikiste
      break;
    case 'at':
      b.part(4, [0, 1.42, 0], () => {
        // Schulterfeuer-Panzerabwehrwaffe mit Visier
        b.push(0.14, 1.5, -0.05, [0.02, 0, 0]);
        b.cyl(0.062, 1.1, 0, 0, -0.1, 'z', 0x55604a, { ...fx, ao: 0.1 }, 8);
        b.cyl(0.095, 0.22, 0, 0, 0.55, 'z', GUNM, fx, 8, 0.07);
        b.cyl(0.082, 0.12, 0, 0, -0.68, 'z', GUNM, fx, 8, 0.095);
        b.cyl(0.03, 0.08, 0, 0, -0.78, 'z', 0xb09a50, fx, 5);
        b.box(0.07, 0.1, 0.18, 0, 0.1, -0.12, BLACK, fx); // Abzugseinheit
        b.box(0.04, 0.08, 0.05, 0, 0.17, -0.13, DARK, { ...fx, rot: [-0.3, 0, 0] });
        b.cyl(0.036, 0.22, 0.0, 0.1, -0.1, 'z', BLACK, fx, 6); // Visier
        b.box(0.045, 0.05, 0.1, 0.0, 0.07, -0.1, METAL, fx);
        b.box(0.14, 0.03, 0.2, 0.0, -0.06, 0.2, 0x2c2c26, fx); // Schulterpolster
        b.mirror(() => b.box(0.018, 0.018, 0.12, 0.062, 0.0, 0.6, METAL, fx));
        b.pop();
      });
      b.part(3, [0, 0.95, 0], () => {
        pack(b, true);
        b.cyl(0.075, 0.5, 0.0, 1.32, 0.44, 'y', 0x55604a, { ...fx, ao: 0.1 }, 7, 0.07); // Reserverakete im Rucksack
        b.cyl(0.05, 0.1, 0.0, 1.6, 0.44, 'y', GUNM, fx, 6);
      });
      b.box(0.1, 0.07, 0.17, 0.2, 0.88, -0.17, GUNM, fx); // Pistole
      break;
    case 'sniper': {
      b.part(4, [0, 1.42, 0], () => {
        rifle(b, { long: true, scope: true });
        b.mirror(() => b.box(0.015, 0.3, 0.015, 0.14, 1.12, -0.95, METAL, { ...fx, rot: [0.5, 0, 0.2] })); // Zweibein
        b.box(0.07, 0.04, 0.16, 0.1, 1.335, 0.05, GUNM, fx); // Backenstütze
        b.cyl(0.038, 0.22, 0.1, 1.265, -1.35, 'z', DARK, fx, 6); // Schalldämpfer
        b.cyl(0.012, 0.04, 0.115, 1.38, -0.28, 'x', METAL, fx, 4); // Absehenturm
        b.box(0.03, 0.05, 0.05, 0.1, 1.2, 0.13, DARK, fx); // Ablage
      });
      b.part(3, [0, 0.95, 0], () => {
        pack(b);
        // Ghillie-Umhang: struppige Streifen
        b.extrudeX([[0.16, 1.72], [0.31, 1.58], [0.44, 0.78], [0.2, 0.62], [0.1, 1.25]], 0.52, 0, 0, 0, 0xd0d8c0, { taper: [1, 0.85], ao: 0.2 });
        for (let i = 0; i < 6; i++) {
          const a = i * 2.1;
          b.box(0.12, 0.22 + (i % 3) * 0.07, 0.08, Math.sin(a) * 0.26, 1.55 - (i % 5) * 0.14, 0.17 + Math.cos(a) * 0.08, i % 2 ? HULL_LIGHT : HULL_DARK, { rot: [0.2 * (i % 3), a, 0.3 * Math.sin(a)], ao: 0.1 });
        }
        b.lathe([[0, 0], [0.25, 0], [0.27, 0.03], [0.12, 0.1], [0, 0.13]], 'y', 0, 1.74, 0.0, HULL_DARK, { seg: 8, ao: 0.1 }); // Buschhut
        for (let i = 0; i < 3; i++) b.box(0.03, 0.14, 0.03, Math.sin(i * 1.1) * 0.22, 1.74, Math.cos(i * 1.1) * 0.22, HULL_LIGHT, { rot: [0.2, i, 0.5], ao: 0 });
      });
      break;
    }
    case 'medic':
      b.part(4, [0, 1.42, 0], () => rifle(b));
      b.part(3, [0, 0.95, 0], () => {
        // Sanitätsrucksack mit rotem Kreuz
        b.box(0.42, 0.44, 0.24, 0, 1.27, 0.23, 0xe6e6e0, { ...fx, ao: 0.25 });
        b.box(0.22, 0.18, 0.16, 0, 1.55, 0.21, 0xe6e6e0, fx);
        b.mirror(() => b.box(0.09, 0.2, 0.12, 0.24, 1.2, 0.23, 0xd6d6d0, fx));
        b.plateFront(0.3, 0.3, 0, 1.3, 0.355, 1, WHITE);
        b.plateFront(0.24, 0.07, 0, 1.3, 0.358, 1, RED);
        b.plateFront(0.07, 0.24, 0, 1.3, 0.358, 1, RED);
        b.mirror(() => {
          b.plateSide(0.1, 0.03, 0.172, 1.74, 0.0, 1, RED);
          b.plateSide(0.03, 0.1, 0.173, 1.74, 0.0, 1, RED);
          b.plateSide(0.1, 0.03, 0.3, 1.38, -0.02, 1, RED);
          b.plateSide(0.03, 0.1, 0.301, 1.38, -0.02, 1, RED);
        });
        b.plateFront(0.12, 0.04, 0, 1.78, -0.172, -1, RED);
        b.plateFront(0.04, 0.12, 0, 1.78, -0.173, -1, RED);
        b.cyl(0.05, 0.3, 0.0, 1.45, 0.4, 'x', 0x6a8a5a, fx, 6); // Infusionsrolle
      });
      b.part(5, [-0.2, 0.98, 0.0], () => {
        b.box(0.1, 0.22, 0.3, -0.3, 0.9, -0.05, 0xe6e6e0, { ...fx, ao: 0.1 }); // Sanitätstasche
        b.plateSide(0.12, 0.12, -0.352, 0.9, -0.05, -1, RED);
      });
      b.box(0.04, 0.09, 0.04, -0.2, 1.4, -0.215, RED, fx); // Tourniquet
      break;
    case 'eng':
      b.part(4, [0, 1.42, 0], () => rifle(b));
      b.part(3, [0, 0.95, 0], () => {
        pack(b, true);
        b.box(0.3, 0.18, 0.2, 0, 1.63, 0.26, HULL, { ao: 0.2 });
        // Spitzhacke schräg am Rucksack
        b.cyl(0.018, 1.0, -0.22, 1.2, 0.42, 'y', WOOD, { ...fx, rot: [0, 0, -0.12] }, 5);
        b.box(0.4, 0.045, 0.06, -0.24, 1.72, 0.42, METAL, { ...fx, rot: [0, 0, -0.12] });
        b.box(0.03, 0.06, 0.06, -0.44, 1.72, 0.42, METAL, fx);
        // Schweißerhelm hochgeklappt
        b.box(0.19, 0.12, 0.05, 0, 1.78, -0.12, 0x2a2a2a, { ...fx, rot: [-0.4, 0, 0] });
      });
      b.part(5, [0.0, 1.0, 0.1], () => {
        b.cyl(0.09, 0.14, -0.27, 0.92, 0.0, 'x', 0xc86a20, fx, 7); // Kabelrolle
        b.box(0.16, 0.12, 0.12, 0.27, 0.92, 0.1, 0x8a7a50, fx); // Sprengladung
        b.box(0.14, 0.04, 0.02, 0.27, 0.96, 0.17, RED, fx);
        b.box(0.05, 0.14, 0.04, -0.12, 0.8, -0.23, 0x6a4a2a, { ...fx, rot: [0.1, 0, 0] }); // Zange
      });
      break;
    case 'mortar':
      b.part(4, [0, 1.42, 0], () => {
        rifle(b);
        // Mörserrohr geschultert
        b.push(-0.06, 1.55, 0.05, [0.5, 0, 0.08]);
        b.cyl(0.062, 1.1, 0, 0, 0, 'z', 0x4a4a42, { ...fx, ao: 0.1 }, 8);
        b.cyl(0.08, 0.1, 0, 0, 0.52, 'z', GUNM, fx, 8);
        b.cyl(0.07, 0.04, 0, 0, -0.55, 'z', METAL, fx, 8);
        b.pop();
      });
      b.part(3, [0, 0.95, 0], () => {
        pack(b, true);
        b.box(0.34, 0.06, 0.34, 0, 1.3, 0.42, 0x55554e, { ...fx, rot: [Math.PI / 2 - 0.15, 0, 0] }); // Grundplatte
        b.mirror(() => b.box(0.02, 0.5, 0.02, 0.12, 1.5, 0.36, METAL, { ...fx, rot: [0.2, 0, 0.3] })); // Zweibein
        for (let i = 0; i < 3; i++) b.cyl(0.04, 0.4, -0.27 + i * 0.002, 1.15 + i * 0.1, 0.1, 'y', 0x5a6a4a, fx, 5); // Granatbehälter
      });
      b.part(5, [0.2, 1.0, 0.1], () => b.box(0.14, 0.3, 0.14, -0.27, 0.95, 0.1, 0x5a6a4a, { ...fx, ao: 0.1 }));
      break;
  }
  return {
    geom: b.build({ groundAO: 0.35, groundH: 0.35 }),
    size: 0.7,
    boost: 2.2,
    livery: 'ground',
    tilt: false,
    anim: 'soldier',
    lod: buildSoldierLod(kind),
  };
}

/** Low-Detail-Variante (~25 %): gleiche Part-IDs/Pivots, grobe Blöcke */
function buildSoldierLod(kind: SoldierKind): ModelDef {
  const b = new ModelBuilder();
  b.mirror(() => {
    b.part(1, [0.105, 0.93, 0], () => b.box(0.17, 0.42, 0.19, 0.105, 0.72, 0, HULL, { top: [1.1, 1.05], ao: 0.12 }));
    b.part(2, [0.105, 0.5, 0], () => {
      b.box(0.15, 0.36, 0.17, 0.105, 0.3, 0, HULL, { ao: 0.12 });
      b.box(0.15, 0.12, 0.28, 0.105, 0.06, -0.05, BOOT, { ...fx, ao: 0.1 });
    });
  });
  b.box(0.36, 0.2, 0.23, 0, 0.98, 0, GEAR, gear);
  b.box(0.07, 0.2, 0.11, 0.2, 0.87, -0.02, 0x2c2c28, fx);
  b.part(3, [0, 0.95, 0], () => {
    b.box(0.44, 0.5, 0.26, 0, 1.28, 0, HULL, { top: [1.08, 1], ao: 0.1 });
    b.box(0.34, 0.3, 0.08, 0, 1.28, -0.16, GEAR, gear);
    b.box(0.4, 0.12, 0.3, 0, 1.12, 0, GEAR_D, gear);
    b.box(0.3, 0.12, 0.06, 0, 1.15, -0.2, GEAR_D, gear);
    b.box(0.5, 0.1, 0.23, 0, 1.46, 0, HULL, { ao: 0.05 });
    b.box(0.15, 0.2, 0.17, 0, 1.64, 0, SK, { paint: P_SKIN, ao: 0.1 });
    b.box(0.17, 0.045, 0.05, 0, 1.655, -0.105, GLASS, { ...fx, ao: 0 });
    b.lathe([[0, 0], [0.16, 0], [0.13, 0.12], [0, 0.155]], 'y', 0, 1.675, 0, HULL_DARK, { seg: 6, ao: 0.1 });
    b.box(0.38, 0.4, 0.2, 0, 1.27, 0.22, 0xffffff, { paint: P_TEAM, ao: 0.2 });
    if (kind === 'sniper') b.box(0.5, 0.8, 0.14, 0, 1.2, 0.3, 0xd0d8c0, { camo: 0.6, ao: 0.2 });
  });
  b.part(4, [0, 1.42, 0], () => {
    b.mirror(() => b.box(0.095, 0.3, 0.105, 0.25, 1.37, -0.02, HULL, { rot: [-0.55, 0, -0.06], ao: 0.1 }));
    b.box(0.09, 0.09, 0.6, 0.12, 1.22, -0.35, HULL, { rot: [0, 0.05, 0], ao: 0.1 });
    b.box(0.07, 0.07, 0.08, 0.1, 1.22, -0.68, 0x26262a, fx);
    const long = kind === 'sniper' || kind === 'mg';
    b.box(0.07, 0.12, long ? 1.2 : 0.95, 0.1, 1.27, long ? -0.4 : -0.3, DARK, fx);
    if (kind === 'at' || kind === 'mortar') b.cyl(0.07, 1.1, 0.14, 1.52, -0.1, 'z', 0x55604a, fx, 5);
  });
  return { geom: b.build({ groundAO: 0.35, groundH: 0.35 }), size: 0.7, boost: 2.2, livery: 'ground', tilt: false, anim: 'soldier' };
}
