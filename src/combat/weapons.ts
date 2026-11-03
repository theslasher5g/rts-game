/**
 * Phase 3 – Waffentabelle. Alle Werte gelten für den VERBAND als Ganzes (eine "Salve" = Feuer des Verbands,
 * Schaden relativ zu type.hp der Einheit; z. B. Panzerzug: 4 Panzer, hp 400, ein Schuss ≈ 1 Panzer).
 * Reichweiten km, Geschwindigkeit km/h, rofPerMin = Schuss/Salven je Minute bei voller Stärke.
 */
import type { WeaponKind } from './types';

export type TargetClass = 'ground' | 'air' | 'naval' | 'building' | 'structure';

export interface WeaponDef {
  id: string;
  /** Deutscher Anzeigename */
  name: string;
  kind: WeaponKind;
  /** HP-Schaden gegen weiche Ziele (Treffer) */
  damage: number;
  /** Durchschlag 0..100 gegen unit.type.armor (Seite ×0.65, Heck ×0.4, Topattack ×0.45) */
  armorPen: number;
  rangeKm: number;
  minRangeKm: number;
  rofPerMin: number;
  /** Basisgenauigkeit 0..1 (sinkt mit Entfernung, Bewegung, Deckung, Unterdrückung) */
  accuracy: number;
  /** Splitter-/Explosionsradius km (0 = nur Direkttreffer) */
  splashKm: number;
  /** Unterdrückung 0..1 je Treffer (Nahtreffer: halber Wert) */
  suppression: number;
  /** 0 = Hitscan (Leuchtspur), sonst Fluggeschwindigkeit km/h */
  projectileSpeedKmh: number;
  indirect: boolean;
  targets: TargetClass[];
  /** Munition aus dem gemeinsamen Pool unit.ammo je Schuss */
  ammoPerShot: number;
  needsLOS: boolean;
  // --- Erweiterungen
  /** Genauigkeitsfaktor, wenn der Schütze fährt (0 = kann nicht in Bewegung feuern) */
  moveFire: number;
  /** Lenkwaffe: kaum Entfernungsabfall, trifft bewegte Ziele, Einschlag am dann aktuellen Zielort */
  guided?: boolean;
  /** Angriff von oben (Panzerung ×0.45) */
  topAttack?: boolean;
  /** Schadensfaktor gegen ungepanzerte Ziele (Panzerabwehrwaffen) */
  vsSoft?: number;
  /** Streuung indirekten Feuers: Radius = 0.006 + scatter × Entfernung(km) */
  scatter?: number;
  /** Faktor Gebäudeschaden (Splash) – Basis damage */
  buildingMul?: number;
  /** false = nur auf Befehl (Angriff/Feuerbefehl), nie automatisch */
  autoFire?: boolean;
  /** Kamikaze: Schütze wird je Schuss um 1/memberCount verbraucht (FPV) */
  kamikaze?: boolean;
  /** Bewegt Hitscan-Schuss ohne Impact-Event (Streufeuer) */
  burst?: boolean;
}

function w(d: Partial<WeaponDef> & Pick<WeaponDef, 'id' | 'name' | 'kind' | 'damage' | 'rangeKm' | 'rofPerMin' | 'targets'>): WeaponDef {
  return {
    armorPen: 5,
    minRangeKm: 0,
    accuracy: 0.5,
    splashKm: 0,
    suppression: 0.03,
    projectileSpeedKmh: 0,
    indirect: false,
    ammoPerShot: 0.05,
    needsLOS: true,
    moveFire: 0.3,
    ...d,
  };
}

const GR: TargetClass[] = ['ground'];
const GRB: TargetClass[] = ['ground', 'building', 'structure'];
const GRN: TargetClass[] = ['ground', 'naval'];
const ALL_SURF: TargetClass[] = ['ground', 'naval', 'building', 'structure'];

// --- Infanteriewaffen
const RIFLE = w({ id: 'rifle', name: 'Sturmgewehre', kind: 'rifle', damage: 3, armorPen: 3, rangeKm: 0.5, rofPerMin: 60, accuracy: 0.42, suppression: 0.045, ammoPerShot: 0.05, moveFire: 0.3, targets: GR });
const GRENADE = w({ id: 'grenade', name: 'Handgranaten/Granatwerfer', kind: 'grenade', damage: 14, armorPen: 12, rangeKm: 0.09, rofPerMin: 6, accuracy: 0.55, splashKm: 0.008, suppression: 0.1, projectileSpeedKmh: 90, ammoPerShot: 0.4, moveFire: 0, targets: GRB, buildingMul: 0.3 });
const MG = w({ id: 'mg', name: 'Maschinengewehr', kind: 'mg', damage: 4, armorPen: 4, rangeKm: 1.0, rofPerMin: 120, accuracy: 0.35, suppression: 0.075, ammoPerShot: 0.05, moveFire: 0.15, targets: GR });
const RPG = w({ id: 'rpg', name: 'Panzerfaust', kind: 'rpg', damage: 52, armorPen: 82, rangeKm: 0.45, rofPerMin: 5, accuracy: 0.6, splashKm: 0.006, suppression: 0.12, projectileSpeedKmh: 1100, ammoPerShot: 1, moveFire: 0.1, vsSoft: 0.7, buildingMul: 0.8, targets: GRB });
const ATGM_INF = w({ id: 'atgm_inf', name: 'Panzerabwehrlenkrakete', kind: 'atgm', damage: 78, armorPen: 98, rangeKm: 2.5, minRangeKm: 0.15, rofPerMin: 3, accuracy: 0.85, splashKm: 0.008, suppression: 0.15, projectileSpeedKmh: 700, ammoPerShot: 1, moveFire: 0, guided: true, topAttack: true, vsSoft: 0.4, buildingMul: 0.6, targets: GRB });
const SNIPER = w({ id: 'sniper', name: 'Scharfschützengewehr', kind: 'sniper', damage: 26, armorPen: 12, rangeKm: 1.5, rofPerMin: 7, accuracy: 0.88, suppression: 0.1, ammoPerShot: 0.5, moveFire: 0, targets: GR });
const MORTAR = w({ id: 'mortar', name: 'Mörser 81 mm', kind: 'mortar', damage: 34, armorPen: 25, rangeKm: 7, minRangeKm: 0.35, rofPerMin: 10, accuracy: 0.5, splashKm: 0.035, suppression: 0.16, projectileSpeedKmh: 700, indirect: true, scatter: 0.006, ammoPerShot: 1, moveFire: 0, needsLOS: false, buildingMul: 0.6, targets: ALL_SURF });
const DEMO = w({ id: 'demo', name: 'Sprengladung', kind: 'demo_charge', damage: 150, armorPen: 70, rangeKm: 0.03, rofPerMin: 4, accuracy: 0.95, splashKm: 0.03, suppression: 0.3, ammoPerShot: 1, moveFire: 0, buildingMul: 4, autoFire: false, targets: ALL_SURF });

// --- Fahrzeugwaffen
const COAX = w({ id: 'coax', name: 'Koax-MG', kind: 'mg', damage: 4, armorPen: 4, rangeKm: 1.2, rofPerMin: 120, accuracy: 0.4, suppression: 0.06, ammoPerShot: 0.03, moveFire: 0.4, targets: GR });
const HMG = w({ id: 'hmg', name: 'Schweres MG 12,7 mm', kind: 'hmg', damage: 6, armorPen: 14, rangeKm: 1.5, rofPerMin: 100, accuracy: 0.42, suppression: 0.08, ammoPerShot: 0.05, moveFire: 0.5, targets: GR });
const AC20 = w({ id: 'ac20', name: 'Maschinenkanone 20 mm', kind: 'autocannon', damage: 9, armorPen: 30, rangeKm: 2.0, rofPerMin: 150, accuracy: 0.45, splashKm: 0.004, suppression: 0.07, projectileSpeedKmh: 4000, ammoPerShot: 0.1, moveFire: 0.5, buildingMul: 0.2, targets: GRB });
const AC30 = w({ id: 'ac30', name: 'Maschinenkanone 30 mm', kind: 'autocannon', damage: 11, armorPen: 42, rangeKm: 2.5, rofPerMin: 150, accuracy: 0.5, splashKm: 0.005, suppression: 0.08, projectileSpeedKmh: 4000, ammoPerShot: 0.1, moveFire: 0.5, buildingMul: 0.25, targets: GRB });
const ATGM_VEH = w({ id: 'atgm_veh', name: 'Panzerabwehrlenkrakete', kind: 'atgm', damage: 75, armorPen: 95, rangeKm: 3.0, minRangeKm: 0.2, rofPerMin: 4, accuracy: 0.85, splashKm: 0.008, suppression: 0.15, projectileSpeedKmh: 700, ammoPerShot: 1, moveFire: 0.5, guided: true, topAttack: true, vsSoft: 0.4, buildingMul: 0.6, targets: GRB });
const gun = (id: string, name: string, dmg: number, pen: number, range: number, rof: number): WeaponDef =>
  w({ id, name, kind: 'tank_gun', damage: dmg, armorPen: pen, rangeKm: range, rofPerMin: rof, accuracy: 0.72, splashKm: 0.02, suppression: 0.14, projectileSpeedKmh: 5400, ammoPerShot: 1, moveFire: 0.45, buildingMul: 0.8, targets: GRB });
const GUN_105 = gun('gun105', 'Kanone 105 mm', 46, 72, 3.0, 12);
const GUN_120 = gun('gun120', 'Glattrohrkanone 120 mm', 62, 88, 3.5, 12);
const GUN_130 = gun('gun130', 'Glattrohrkanone 130 mm', 72, 105, 4.0, 11);

// --- Artillerie
const HOWITZER = w({ id: 'howitzer', name: 'Panzerhaubitze 155 mm', kind: 'howitzer', damage: 90, armorPen: 45, rangeKm: 40, minRangeKm: 2.5, rofPerMin: 9, accuracy: 0.5, splashKm: 0.055, suppression: 0.22, projectileSpeedKmh: 1800, indirect: true, scatter: 0.0022, ammoPerShot: 1, moveFire: 0, needsLOS: false, buildingMul: 1.6, targets: ALL_SURF });
const ROCKET = w({ id: 'rocket_arty', name: 'Raketenwerfer (Salve)', kind: 'rocket_arty', damage: 150, armorPen: 40, rangeKm: 70, minRangeKm: 8, rofPerMin: 2, accuracy: 0.5, splashKm: 0.11, suppression: 0.4, projectileSpeedKmh: 2500, indirect: true, scatter: 0.0045, ammoPerShot: 1, moveFire: 0, needsLOS: false, buildingMul: 1.2, autoFire: false, targets: ALL_SURF });

// --- Flugabwehr
const FLAK = w({ id: 'flak', name: 'Flugabwehrkanone 35 mm', kind: 'flak', damage: 12, armorPen: 25, rangeKm: 5, rofPerMin: 200, accuracy: 0.34, splashKm: 0.012, suppression: 0.06, projectileSpeedKmh: 3600, ammoPerShot: 0.15, moveFire: 0.3, buildingMul: 0.2, targets: ['air', 'ground'] });
const SAM = w({ id: 'sam', name: 'Flugabwehrrakete', kind: 'sam', damage: 80, armorPen: 60, rangeKm: 40, minRangeKm: 1.5, rofPerMin: 6, accuracy: 0.62, splashKm: 0.03, suppression: 0.2, projectileSpeedKmh: 4000, ammoPerShot: 1, moveFire: 0, guided: true, needsLOS: false, targets: ['air'] });
const SAM_SHIP = w({ id: 'sam_ship', name: 'Seezielflugabwehrrakete', kind: 'sam', damage: 70, armorPen: 55, rangeKm: 22, minRangeKm: 1.5, rofPerMin: 6, accuracy: 0.6, splashKm: 0.03, suppression: 0.2, projectileSpeedKmh: 3600, ammoPerShot: 2, moveFire: 0.8, guided: true, needsLOS: false, targets: ['air'] });

// --- Luft
const HELI_GUN = w({ id: 'heli_gun', name: 'Bordkanone 30 mm', kind: 'heli_gun', damage: 9, armorPen: 32, rangeKm: 2.5, rofPerMin: 120, accuracy: 0.5, splashKm: 0.004, suppression: 0.08, projectileSpeedKmh: 4000, ammoPerShot: 0.1, moveFire: 0.8, buildingMul: 0.2, targets: GRB });
const HELI_ROCKET = w({ id: 'heli_rocket', name: 'Raketenbehälter 70 mm', kind: 'heli_rocket', damage: 26, armorPen: 28, rangeKm: 5.5, minRangeKm: 0.3, rofPerMin: 12, accuracy: 0.45, splashKm: 0.03, suppression: 0.14, projectileSpeedKmh: 2500, ammoPerShot: 0.5, moveFire: 0.7, buildingMul: 0.7, targets: GRB });
const HELI_ATGM = w({ id: 'heli_atgm', name: 'Luft-Boden-Lenkrakete', kind: 'heli_atgm', damage: 80, armorPen: 100, rangeKm: 8, minRangeKm: 0.5, rofPerMin: 5, accuracy: 0.85, splashKm: 0.01, suppression: 0.15, projectileSpeedKmh: 1300, ammoPerShot: 1, moveFire: 0.8, guided: true, topAttack: true, vsSoft: 0.4, buildingMul: 0.7, targets: GRB });
const AIR_MISSILE = w({ id: 'air_missile', name: 'Luft-Luft-Rakete', kind: 'air_missile', damage: 85, armorPen: 60, rangeKm: 60, minRangeKm: 1.0, rofPerMin: 6, accuracy: 0.68, splashKm: 0.03, suppression: 0.2, projectileSpeedKmh: 4000, ammoPerShot: 1, moveFire: 1, guided: true, needsLOS: false, targets: ['air'] });
const AIR_GUN = w({ id: 'air_gun', name: 'Bordmaschinenkanone 27 mm', kind: 'air_gun', damage: 11, armorPen: 28, rangeKm: 2.0, rofPerMin: 200, accuracy: 0.38, splashKm: 0.004, suppression: 0.07, projectileSpeedKmh: 4000, ammoPerShot: 0.1, moveFire: 1, buildingMul: 0.2, targets: ['air', 'ground', 'building'] });
const BOMB = w({ id: 'bomb', name: 'Freifallbombe', kind: 'bomb', damage: 130, armorPen: 70, rangeKm: 5, rofPerMin: 40, accuracy: 0.55, splashKm: 0.085, suppression: 0.45, projectileSpeedKmh: 0, indirect: true, scatter: 0, ammoPerShot: 1, moveFire: 1, needsLOS: false, topAttack: true, buildingMul: 3, autoFire: false, targets: ['ground', 'naval', 'building', 'structure'] });
const FPV = w({ id: 'fpv', name: 'FPV-Kamikazedrohne', kind: 'fpv', damage: 50, armorPen: 35, rangeKm: 0.05, rofPerMin: 60, accuracy: 0.65, splashKm: 0.012, suppression: 0.3, ammoPerShot: 1, moveFire: 1, needsLOS: false, topAttack: true, kamikaze: true, buildingMul: 0.5, targets: ['ground', 'naval', 'building'] });

// --- Marine
const NAVAL_GUN_127 = w({ id: 'naval_127', name: 'Schiffsgeschütz 127 mm', kind: 'naval_gun', damage: 60, armorPen: 45, rangeKm: 22, minRangeKm: 0.5, rofPerMin: 20, accuracy: 0.5, splashKm: 0.035, suppression: 0.18, projectileSpeedKmh: 3000, scatter: 0.0015, ammoPerShot: 0.5, moveFire: 0.8, needsLOS: false, buildingMul: 1.2, targets: ['ground', 'naval', 'building', 'structure'] });
const NAVAL_GUN_76 = w({ id: 'naval_76', name: 'Schiffsgeschütz 76 mm', kind: 'naval_gun', damage: 38, armorPen: 35, rangeKm: 16, minRangeKm: 0.5, rofPerMin: 30, accuracy: 0.5, splashKm: 0.025, suppression: 0.14, projectileSpeedKmh: 3000, scatter: 0.0015, ammoPerShot: 0.4, moveFire: 0.8, needsLOS: false, buildingMul: 0.9, targets: ['ground', 'naval', 'building', 'structure'] });
const ASM = (range: number, dmg: number) => w({ id: 'asm', name: 'Seezielflugkörper', kind: 'antiship_missile', damage: dmg, armorPen: 95, rangeKm: range, minRangeKm: 2, rofPerMin: 4, accuracy: 0.8, splashKm: 0.04, suppression: 0.4, projectileSpeedKmh: 1100, ammoPerShot: 4, moveFire: 1, guided: true, needsLOS: false, buildingMul: 2, targets: ['naval', 'ground', 'building'] });
const TORPEDO = w({ id: 'torpedo', name: 'Torpedo', kind: 'torpedo', damage: 350, armorPen: 100, rangeKm: 14, minRangeKm: 0.8, rofPerMin: 3, accuracy: 0.72, splashKm: 0.05, suppression: 0.5, projectileSpeedKmh: 180, ammoPerShot: 1, moveFire: 1, guided: true, needsLOS: false, targets: ['naval'] });

export const WEAPONS_BY_UNIT: Record<string, WeaponDef[]> = {
  inf_squad: [RIFLE, GRENADE],
  mg_team: [MG],
  at_team: [ATGM_INF, RPG, { ...RIFLE, id: 'rifle_light', damage: 1.5, rofPerMin: 40 }],
  sniper_team: [SNIPER],
  medic_team: [],
  engineer_squad: [{ ...RIFLE, id: 'rifle_pi', damage: 2.5, rangeKm: 0.4, accuracy: 0.38 }, DEMO],
  mortar_team: [MORTAR],
  recon_wheeled: [{ ...HMG, id: 'hmg_recon', damage: 5, rangeKm: 1.5 }],
  ifv: [AC30, ATGM_VEH, COAX],
  apc_wheeled: [AC20, { ...HMG, id: 'hmg_apc' }],
  light_tank: [GUN_105, COAX],
  mbt_medium: [GUN_120, COAX],
  mbt_heavy: [GUN_130, COAX],
  sp_artillery: [HOWITZER, { ...HMG, id: 'hmg_spg', damage: 4, rangeKm: 1.0, accuracy: 0.3 }],
  mlrs: [ROCKET],
  spaa: [FLAK],
  sam: [SAM],
  supply_truck: [],
  attack_heli: [HELI_ATGM, HELI_ROCKET, HELI_GUN],
  transport_heli: [],
  fighter: [AIR_MISSILE, AIR_GUN],
  bomber: [BOMB],
  recon_drone: [],
  fpv_swarm: [FPV],
  destroyer: [NAVAL_GUN_127, ASM(30, 320), SAM_SHIP],
  frigate: [NAVAL_GUN_76, ASM(25, 260), SAM_SHIP],
  submarine: [TORPEDO],
};

/** Größte Reichweite aller Waffen eines Typs (km) */
export function maxRangeOf(typeId: string): number {
  let r = 0;
  for (const wd of WEAPONS_BY_UNIT[typeId] ?? []) if (wd.rangeKm > r) r = wd.rangeKm;
  return r;
}
