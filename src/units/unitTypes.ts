/**
 * Phase 2 – Einheitentypen (moderne Streitkräfte, WW3-Szenario).
 * Geschwindigkeiten km/h, Entfernungen km, Kosten Mio $. Werte grob realitätsnah, spielerisch gerundet.
 */
import type { MobilityProfile, RoadClass } from '../nav/types';
import type { UnitCategory, UnitTypeDef } from './types';

type RoadSpeeds = Partial<Record<RoadClass, number>>;

/** Bahnverlegung / Fähre: Bodeneinheiten können verladen werden (vereinfachte Durchschnittsgeschwindigkeit). */
const RAIL = 80;
const FERRY = 30;

function roads(motorway: number, primary: number, secondary: number, road: number, track: number): RoadSpeeds {
  return { motorway, primary, secondary, road, track, rail: RAIL, ferry: FERRY };
}

const MOB = {
  /** Infanterie zu Fuß */
  foot: (): MobilityProfile => ({ domain: 'ground', roadSpeed: roads(5, 5, 5, 5, 5), offroadSpeed: 4, offroadAllowed: true, slopePenalty: 0.25 }),
  /** Kettenfahrzeug (Kampfpanzer, Schützenpanzer, Panzerhaubitze) */
  tracked: (road = 65, off = 40): MobilityProfile => ({
    domain: 'ground',
    roadSpeed: roads(road, road * 0.95, road * 0.9, road * 0.8, road * 0.7),
    offroadSpeed: off,
    offroadAllowed: true,
    slopePenalty: 0.25,
  }),
  /** Radfahrzeug (Spähwagen, Radschützenpanzer) */
  wheeled: (road = 95, off = 30): MobilityProfile => ({
    domain: 'ground',
    roadSpeed: roads(road, road * 0.9, road * 0.8, road * 0.7, road * 0.45),
    offroadSpeed: off,
    offroadAllowed: true,
    slopePenalty: 0.6,
  }),
  /** Schwerer LKW (Versorgung, Raketenwerfer, Flugabwehr-Startgerät) – im Gelände sehr eingeschränkt */
  truck: (road = 85, off = 15): MobilityProfile => ({
    domain: 'ground',
    roadSpeed: roads(road, road * 0.9, road * 0.8, road * 0.7, road * 0.4),
    offroadSpeed: off,
    offroadAllowed: true,
    slopePenalty: 0.8,
  }),
  air: (speed: number): MobilityProfile => ({ domain: 'air', roadSpeed: {}, offroadSpeed: speed, offroadAllowed: true, slopePenalty: 0 }),
  naval: (speed: number): MobilityProfile => ({ domain: 'naval', roadSpeed: {}, offroadSpeed: speed, offroadAllowed: true, slopePenalty: 0 }),
};

interface Def extends Omit<UnitTypeDef, 'id'> {}

function def(
  name: string,
  short: string,
  category: UnitCategory,
  model: string,
  memberCount: number,
  mobility: MobilityProfile,
  spacingKm: number,
  s: { armor: number; hp: number; damage: number; rangeKm: number; sightKm: number; ammo: number; fuelKm: number; cost: number },
): Def {
  return { name, short, category, model, memberCount, mobility, spacingKm, ...s };
}

const INF = Infinity;

const DEFS: Record<string, Def> = {
  // --- Infanterie
  inf_squad: def('Schützentrupp', 'SchTrp', 'infantry', 'soldier', 8, MOB.foot(), 0.08,
    { armor: 0, hp: 80, damage: 6, rangeKm: 0.5, sightKm: 2, ammo: 40, fuelKm: INF, cost: 1 }),
  mg_team: def('MG-Trupp', 'MG', 'infantry', 'soldier', 3, MOB.foot(), 0.06,
    { armor: 0, hp: 35, damage: 9, rangeKm: 1.0, sightKm: 2, ammo: 30, fuelKm: INF, cost: 0.6 }),
  at_team: def('Panzerabwehrtrupp', 'PzAbw', 'infantry', 'soldier', 3, MOB.foot(), 0.06,
    { armor: 0, hp: 35, damage: 45, rangeKm: 2.5, sightKm: 2.5, ammo: 8, fuelKm: INF, cost: 1.5 }),
  sniper_team: def('Scharfschützentrupp', 'ScharfS', 'infantry', 'soldier', 2, MOB.foot(), 0.05,
    { armor: 0, hp: 20, damage: 12, rangeKm: 1.5, sightKm: 4, ammo: 30, fuelKm: INF, cost: 0.5 }),
  medic_team: def('Sanitätstrupp', 'San', 'infantry', 'soldier', 4, MOB.foot(), 0.06,
    { armor: 0, hp: 30, damage: 1, rangeKm: 0.3, sightKm: 1.5, ammo: 10, fuelKm: INF, cost: 0.5 }),
  engineer_squad: def('Pioniertrupp', 'Pi', 'infantry', 'soldier', 6, MOB.foot(), 0.07,
    { armor: 0, hp: 60, damage: 8, rangeKm: 0.4, sightKm: 1.5, ammo: 20, fuelKm: INF, cost: 1 }),
  mortar_team: def('Mörsertrupp', 'Mrs', 'artillery', 'soldier', 4, MOB.foot(), 0.07,
    { armor: 0, hp: 35, damage: 25, rangeKm: 7, sightKm: 1.5, ammo: 30, fuelKm: INF, cost: 0.8 }),

  // --- Aufklärung
  recon_wheeled: def('Spähwagen', 'Spähw', 'recon', 'recon_4x4', 2, MOB.wheeled(100, 32), 0.12,
    { armor: 15, hp: 60, damage: 8, rangeKm: 1.5, sightKm: 8, ammo: 30, fuelKm: 900, cost: 6 }),

  // --- Mechanisierte Kräfte
  ifv: def('Schützenpanzer', 'SPz', 'ifv', 'ifv', 4, MOB.tracked(68, 42), 0.15,
    { armor: 45, hp: 280, damage: 18, rangeKm: 2.5, sightKm: 3.5, ammo: 40, fuelKm: 600, cost: 80 }),
  apc_wheeled: def('Radschützenpanzer', 'RadSPz', 'ifv', 'recon_8x8', 4, MOB.wheeled(100, 35), 0.15,
    { armor: 35, hp: 240, damage: 14, rangeKm: 2, sightKm: 3, ammo: 40, fuelKm: 800, cost: 60 }),
  light_tank: def('Leichter Kampfpanzer', 'lKPz', 'tank', 'light_tank', 4, MOB.tracked(70, 45), 0.15,
    { armor: 50, hp: 300, damage: 40, rangeKm: 3, sightKm: 4, ammo: 40, fuelKm: 550, cost: 70 }),
  mbt_medium: def('Kampfpanzer', 'KPz', 'tank', 'mbt', 4, MOB.tracked(65, 40), 0.15,
    { armor: 75, hp: 400, damage: 60, rangeKm: 3.5, sightKm: 4, ammo: 40, fuelKm: 450, cost: 90 }),
  mbt_heavy: def('Kampfpanzer (schwer)', 'KPz s', 'tank', 'mbt_heavy', 4, MOB.tracked(62, 38), 0.16,
    { armor: 90, hp: 460, damage: 70, rangeKm: 4, sightKm: 4, ammo: 40, fuelKm: 400, cost: 130 }),

  // --- Artillerie
  sp_artillery: def('Panzerhaubitze', 'PzH', 'artillery', 'spg', 3, MOB.tracked(60, 36), 0.25,
    { armor: 30, hp: 260, damage: 90, rangeKm: 40, sightKm: 3, ammo: 30, fuelKm: 420, cost: 80 }),
  mlrs: def('Raketenartillerie', 'RakArt', 'artillery', 'mlrs', 3, MOB.truck(85, 20), 0.3,
    { armor: 10, hp: 160, damage: 160, rangeKm: 70, sightKm: 2, ammo: 6, fuelKm: 500, cost: 60 }),

  // --- Flugabwehr
  spaa: def('Flakpanzer', 'Flak', 'aa', 'spaa', 3, MOB.tracked(65, 40), 0.2,
    { armor: 35, hp: 220, damage: 30, rangeKm: 8, sightKm: 15, ammo: 40, fuelKm: 500, cost: 60 }),
  sam: def('Flugabwehrraketensystem', 'FlaRak', 'aa', 'sam', 3, MOB.truck(80, 15), 0.35,
    { armor: 5, hp: 140, damage: 120, rangeKm: 40, sightKm: 80, ammo: 8, fuelKm: 500, cost: 250 }),

  // --- Unterstützung
  supply_truck: def('Versorgungs-LKW', 'Vers', 'support', 'truck', 4, MOB.truck(85, 18), 0.15,
    { armor: 5, hp: 100, damage: 0, rangeKm: 0, sightKm: 1.5, ammo: 0, fuelKm: 1000, cost: 3 }),

  // --- Phase 5: Tankwagen-Konvoi (Öltransport, unbewaffnet, Ladung 120 Fässer; Fracht wird von OilEconomy verwaltet)
  tanker_truck: def('Tankwagen-Konvoi', 'Tank', 'support', 'fuel_truck', 3, MOB.truck(70, 15), 0.15,
    { armor: 5, hp: 140, damage: 0, rangeKm: 0, sightKm: 1.5, ammo: 0, fuelKm: 1200, cost: 25 }),

  // --- Humanitär / Sanität (unbewaffnet)
  aid_convoy: def('Hilfskonvoi', 'Hilfe', 'support', 'aid_truck', 4, MOB.truck(80, 12), 0.15,
    { armor: 3, hp: 120, damage: 0, rangeKm: 0, sightKm: 1.5, ammo: 10, fuelKm: 1000, cost: 2 }),
  field_hospital: def('Feldlazarett', 'Lazarett', 'support', 'field_hospital', 1, MOB.truck(70, 10), 0.2,
    { armor: 5, hp: 200, damage: 0, rangeKm: 0, sightKm: 1.5, ammo: 0, fuelKm: 800, cost: 6 }),
  ambulance: def('Krankenwagen', 'KTW', 'support', 'ambulance', 2, MOB.wheeled(100, 25), 0.1,
    { armor: 3, hp: 70, damage: 0, rangeKm: 0, sightKm: 1.5, ammo: 0, fuelKm: 700, cost: 1 }),

  // --- Hubschrauber
  attack_heli: def('Kampfhubschrauber', 'KpfHS', 'helicopter', 'heli_attack', 2, MOB.air(270), 0.3,
    { armor: 20, hp: 160, damage: 70, rangeKm: 8, sightKm: 10, ammo: 16, fuelKm: 550, cost: 120 }),
  transport_heli: def('Transporthubschrauber', 'TrspHS', 'helicopter', 'heli_transport', 2, MOB.air(250), 0.35,
    { armor: 10, hp: 180, damage: 0, rangeKm: 0, sightKm: 6, ammo: 0, fuelKm: 700, cost: 60 }),

  // --- Flugzeuge
  fighter: def('Kampfflugzeug', 'Jäger', 'jet', 'jet', 2, MOB.air(900), 1.0,
    { armor: 10, hp: 120, damage: 90, rangeKm: 60, sightKm: 80, ammo: 8, fuelKm: 2500, cost: 220 }),
  bomber: def('Jagdbomber', 'JaBo', 'jet', 'bomber', 2, MOB.air(800), 1.2,
    { armor: 10, hp: 160, damage: 200, rangeKm: 5, sightKm: 40, ammo: 4, fuelKm: 3000, cost: 260 }),

  // --- Drohnen
  recon_drone: def('Aufklärungsdrohne', 'AufklD', 'drone', 'drone_fixed', 1, MOB.air(150), 0.3,
    { armor: 0, hp: 20, damage: 0, rangeKm: 0, sightKm: 20, ammo: 0, fuelKm: 1500, cost: 4 }),
  fpv_swarm: def('FPV-Drohnenschwarm', 'FPV', 'drone', 'drone_quad', 6, MOB.air(110), 0.15,
    { armor: 0, hp: 30, damage: 50, rangeKm: 0.3, sightKm: 3, ammo: 6, fuelKm: 25, cost: 0.3 }),

  // --- Marine
  destroyer: def('Zerstörer', 'Zerst', 'naval', 'destroyer', 1, MOB.naval(58), 1.0,
    { armor: 40, hp: 1200, damage: 120, rangeKm: 30, sightKm: 40, ammo: 60, fuelKm: 8000, cost: 1500 }),
  frigate: def('Fregatte', 'Freg', 'naval', 'frigate', 1, MOB.naval(55), 0.8,
    { armor: 30, hp: 900, damage: 90, rangeKm: 25, sightKm: 35, ammo: 50, fuelKm: 7000, cost: 800 }),
  submarine: def('U-Boot', 'U-Boot', 'naval', 'submarine', 1, MOB.naval(37), 0.8,
    { armor: 30, hp: 700, damage: 250, rangeKm: 20, sightKm: 15, ammo: 12, fuelKm: 9000, cost: 600 }),
};

export const UNIT_TYPES: Record<string, UnitTypeDef> = Object.fromEntries(
  Object.entries(DEFS).map(([id, d]) => [id, { id, ...d } as UnitTypeDef]),
);

export function getUnitType(id: string): UnitTypeDef | undefined {
  return UNIT_TYPES[id];
}

/** Höchstgeschwindigkeit eines Profils (Straße oder Gelände) in km/h */
export function maxSpeedOf(mob: MobilityProfile): number {
  let v = mob.offroadAllowed ? mob.offroadSpeed : 0;
  for (const k in mob.roadSpeed) {
    if (k === 'rail' || k === 'ferry') continue; // Verladung zählt nicht als Eigengeschwindigkeit
    const s = mob.roadSpeed[k as RoadClass] ?? 0;
    if (s > v) v = s;
  }
  return v;
}
