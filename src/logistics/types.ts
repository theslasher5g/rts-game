/**
 * Phase 5 – Öl-Wirtschaft, Nachschub und Produktion (Vorbild: Ölfelder erobern, Straßen halten, Gegner abschneiden).
 *
 * Kernidee: Öl ist die einzige Währung. Ölfelder fördern Fässer, Tankwagen-Konvois bringen sie über das echte
 * Straßennetz zur Raffinerie der Nation; angelieferte Fässer sind das Guthaben, mit dem produziert und nachgeschoben wird.
 * Eine gesprengte Brücke oder Straßensperre unterbricht den Strom, Konvois lassen sich überfallen.
 * Koordinaten: Welt-km [x, z] (siehe src/core/types.ts).
 */

export interface OilFieldInfo {
  id: number;
  name: string;
  x: number;
  z: number;
  /** Förderleistung in Fässern pro Spielstunde, wenn betrieben */
  output: number;
  /** ADM0_A3 des ursprünglichen Landes */
  country: string;
  /** aktueller Besitzer (a3), '' = niemand */
  owner: string;
  /** 0..1 Zustand der Anlage (Beschuss/Sabotage senkt Förderung) */
  integrity: number;
  /** eingelagerte, noch nicht abtransportierte Fässer */
  stored: number;
  /** Lagerkapazität; ist sie voll, stockt die Förderung */
  capacity: number;
  /** Zuordnung: Raffinerie/Basis, zu der geliefert wird (BaseInfo.id) oder -1 */
  destBaseId: number;
  /** Phase 5 (Wirtschaft): Feld ist vom Raffineriestandort aus nicht per Straße erreichbar (UI: 'Abgeschnitten') */
  cutOff?: boolean;
  /** Eroberungsfortschritt 0..1 (feindliche Bodentruppen im Umkreis) und Eroberer-a3 */
  captureProgress?: number;
  capturer?: string;
  /** brennt (Integrität < 0.4) */
  burning?: boolean;
}

export type BaseKind = 'hq' | 'refinery' | 'barracks' | 'factory' | 'airfield' | 'shipyard' | 'depot' | 'fuel_depot';

export interface BaseInfo {
  id: number;
  kind: BaseKind;
  owner: string;
  x: number;
  z: number;
  /** 0..1 Fertigstellung beim Bau */
  progress: number;
  hp: number;
  hpMax: number;
  /** Radius (km), in dem Einheiten nachversorgt werden (Depots) bzw. der Ausgang liegt */
  radiusKm: number;
  /** Phase 5: Anzeigename, z. B. 'Kaserne 2' */
  name?: string;
  /** Lagerbestand (Fässer) von Raffinerie/HQ-Depot, nur Anzeige */
  stock?: number;
}

export interface ProductionOrderInfo {
  id: number;
  baseId: number;
  typeId: string;
  /** Spielstunden bis zur Fertigstellung (Rest) */
  remainingHours: number;
  totalHours: number;
  /** Sammelpunkt (optional) */
  rallyX?: number;
  rallyZ?: number;
  /** Phase 5: Preis in Fässern (Rückerstattung bei Abbruch) und Besitzer */
  price?: number;
  owner?: string;
}

/** Konvoi: Tankwagen oder Nachschub-LKW auf Route zwischen zwei Punkten */
export interface ConvoyInfo {
  id: number;
  kind: 'oil' | 'supply';
  owner: string;
  fromBaseId: number;
  toBaseId: number;
  /** Fässer an Bord */
  cargo: number;
  /** zugehörige Unit-ID (Tankwagen-Verband) */
  unitId: number;
  /** Phase 5: Zustand des Konvois und Zielfeld (kind 'oil') */
  state?: 'idle' | 'toField' | 'loading' | 'toBase' | 'waiting' | 'recall';
  fieldId?: number;
}

export interface OilPool {
  /** Guthaben in Fässern */
  barrels: number;
  /** Einnahmen der letzten Spielstunde (Fässer/h, geglättet) */
  incomePerHour: number;
  /** Ausgaben der letzten Spielstunde (Produktion, Nachschub) */
  spendPerHour: number;
  /** unterwegs befindliche Fässer */
  inTransit: number;
  /** Phase 5: Summen seit Spielbeginn (Statistik) */
  delivered?: number;
  lostConvoys?: number;
  lostBarrels?: number;
}
