/**
 * Phase 5 – Preistabelle (alles in Fässern Öl; Öl ist die einzige Währung), Basisdefinitionen und Kataloge.
 * Abgestimmt auf OIL_START_BARRELS = 600 und Feldleistung 20–60 Fässer/h: ein Ölfeld finanziert (bei offener Straße)
 * etwa alle 1,5–3 Spielstunden einen Kampfpanzer.
 */
import type { BaseKind } from './types';
import { SCENARIO_NATIONS } from '../game/scenario';
import { PER_VEHICLE_SCALE } from '../units/unitTypes';

/** Preis je Einheitentyp in Fässern */
export const PRICE: Record<string, number> = {
  inf_squad: 8, mg_team: 6, at_team: 10, sniper_team: 6, medic_team: 6, engineer_squad: 8, mortar_team: 10,
  recon_wheeled: 20,
  ifv: 55, apc_wheeled: 45, light_tank: 50, mbt_medium: 70, mbt_heavy: 95,
  sp_artillery: 70, mlrs: 75,
  spaa: 50, sam: 90,
  supply_truck: 12, tanker_truck: 25, aid_convoy: 10, field_hospital: 20, ambulance: 8,
  attack_heli: 140, transport_heli: 80, fighter: 200, bomber: 220,
  recon_drone: 15, fpv_swarm: 12,
  destroyer: 400, frigate: 260, submarine: 220,
};

/**
 * Einzelfahrzeuge: Die Preise oben galten für einen ganzen Zug (n Fahrzeuge); je Fahrzeug = Preis / n (min. 2 Fässer).
 * Ausnahme Tankwagen: Ladung 120 Fässer gilt jetzt je Wagen, daher nicht auf 1/3 gesenkt (12 statt 25).
 */
for (const [id, n] of Object.entries(PER_VEHICLE_SCALE)) if (PRICE[id] !== undefined) PRICE[id] = Math.max(2, Math.round(PRICE[id] / n));
PRICE.tanker_truck = 12;

export function priceOf(typeId: string): number {
  return PRICE[typeId] ?? 20;
}

/** Produktionsdauer in Spielstunden */
export function hoursOf(typeId: string): number {
  return Math.max(0.5, Math.round((0.4 + 0.045 * priceOf(typeId)) * 10) / 10);
}

/** Nachversorgung: voller Munitionssatz kostet 7 % des Einheitenpreises, voller Tank 4 % (Fässer) */
export const AMMO_PRICE_FRAC = 0.07;
export const FUEL_PRICE_FRAC = 0.04;

export interface BaseDef {
  kind: BaseKind;
  name: string;
  hpMax: number;
  /** Nachschub-/Ausgangsradius (km) */
  radiusKm: number;
  /** Footprint-Radius (km) für Schaden durch Einschläge */
  sizeKm: number;
  /** Baukosten / Wiederaufbau in Fässern */
  cost: number;
  /** Arbeitsaufwand in Mann-Stunden */
  manHours: number;
  /** max. Anzahl je Besitzer (Wiederaufbau zählt) */
  maxCount: number;
  /** Mindestabstand zu Feindeinheiten (km) beim Bauen */
  enemyClearKm: number;
}

export const BASE_DEFS: Record<BaseKind, BaseDef> = {
  hq: { kind: 'hq', name: 'Hauptquartier', hpMax: 5000, radiusKm: 1.2, sizeKm: 0.12, cost: 300, manHours: 220, maxCount: 1, enemyClearKm: 0 },
  refinery: { kind: 'refinery', name: 'Raffinerie', hpMax: 3000, radiusKm: 1.2, sizeKm: 0.18, cost: 200, manHours: 150, maxCount: 1, enemyClearKm: 0 },
  barracks: { kind: 'barracks', name: 'Kaserne', hpMax: 900, radiusKm: 0.4, sizeKm: 0.09, cost: 60, manHours: 40, maxCount: 4, enemyClearKm: 4 },
  factory: { kind: 'factory', name: 'Fahrzeugwerk', hpMax: 1500, radiusKm: 0.4, sizeKm: 0.12, cost: 160, manHours: 120, maxCount: 3, enemyClearKm: 4 },
  airfield: { kind: 'airfield', name: 'Flugplatz', hpMax: 1800, radiusKm: 0.6, sizeKm: 0.18, cost: 220, manHours: 160, maxCount: 2, enemyClearKm: 6 },
  shipyard: { kind: 'shipyard', name: 'Werft', hpMax: 1800, radiusKm: 0.5, sizeKm: 0.13, cost: 260, manHours: 180, maxCount: 2, enemyClearKm: 6 },
  depot: { kind: 'depot', name: 'Nachschubdepot', hpMax: 800, radiusKm: 1.5, sizeKm: 0.08, cost: 40, manHours: 25, maxCount: 6, enemyClearKm: 3 },
  fuel_depot: { kind: 'fuel_depot', name: 'Tanklager', hpMax: 800, radiusKm: 1.5, sizeKm: 0.08, cost: 50, manHours: 30, maxCount: 3, enemyClearKm: 3 },
};

/** Baubare Basistypen (Reihenfolge im UI) */
export const BUILDABLE: BaseKind[] = ['barracks', 'factory', 'airfield', 'shipyard', 'depot', 'fuel_depot'];

/** Was jede Basis produzieren kann */
export const CATALOG: Record<BaseKind, string[]> = {
  hq: ['engineer_squad', 'medic_team', 'recon_drone', 'ambulance'],
  refinery: ['tanker_truck'],
  barracks: ['inf_squad', 'mg_team', 'at_team', 'sniper_team', 'mortar_team', 'medic_team', 'engineer_squad'],
  factory: ['recon_wheeled', 'apc_wheeled', 'ifv', 'light_tank', 'mbt_medium', 'mbt_heavy', 'sp_artillery', 'mlrs', 'spaa', 'sam', 'supply_truck', 'tanker_truck', 'ambulance', 'field_hospital'],
  airfield: ['attack_heli', 'transport_heli', 'fighter', 'bomber', 'recon_drone', 'fpv_swarm'],
  shipyard: ['destroyer', 'frigate', 'submarine'],
  depot: ['supply_truck', 'aid_convoy', 'ambulance'],
  fuel_depot: ['tanker_truck', 'supply_truck'],
};

/** Basen, an denen Einheiten nachversorgt werden (Kategorie-Einschränkung siehe SupplySystem) */
export const SUPPLY_KINDS: ReadonlySet<BaseKind> = new Set<BaseKind>(['depot', 'fuel_depot', 'hq', 'refinery', 'airfield', 'shipyard']);

/** Teamfarbe (Hex-Zahl) einer Nation, Grau für niemand/unbekannt */
export function nationColor(a3: string): number {
  for (const n of SCENARIO_NATIONS) if (n.a3 === a3) return parseInt(n.color.slice(1), 16);
  if (!a3) return 0x8a8a80;
  let h = 2166136261;
  for (let i = 0; i < a3.length; i++) h = Math.imul(h ^ a3.charCodeAt(i), 16777619);
  const r = 90 + ((h >>> 0) % 130), g = 90 + (((h >>> 8) >>> 0) % 130), b = 90 + (((h >>> 16) >>> 0) % 130);
  return (r << 16) | (g << 8) | b;
}

/** Strukturelles Interface der Wegfindung (Pathfinder erfüllt es) */
export interface RouteLike {
  findRoute(fx: number, fz: number, tx: number, tz: number, mob: import('../nav/types').MobilityProfile): import('../nav/types').Route | null;
  passable?(x: number, z: number, mob: import('../nav/types').MobilityProfile): boolean;
  nearestPassable?(x: number, z: number, mob: import('../nav/types').MobilityProfile, maxKm?: number): [number, number] | null;
}
