/**
 * Phase 4 – Verträge für Zivilisten, Schutzstatus, Ansehen und Besatzung.
 * Städte sind die Einträge von geo.meta.cities (Index = cityId, stabil).
 * Koordinaten: Welt-km [x, z] (siehe src/core/types.ts).
 */

export type InfraKind = 'hospital' | 'school' | 'power_plant' | 'water_works' | 'port' | 'airport' | 'rail_station' | 'town_hall' | 'church';

/** Zivile Infrastruktur mit Schutzstatus (Krankenhäuser, Schulen, Kraftwerke, Wasserwerke, Häfen) */
export interface InfraInfo {
  id: number;
  kind: InfraKind;
  cityId: number;
  x: number;
  z: number;
  /** Grundfläche in km */
  w: number;
  d: number;
  /** 0..1 */
  integrity: number;
  /** true = Schutzstatus (Krankenhaus, Schule, Wasserwerk, Kraftwerk, Hilfsgüter-Hafen) */
  protectedStatus: boolean;
}

export type CityControl = 'normal' | 'evacuating' | 'evacuated' | 'occupied' | 'unrest' | 'ruined';

export interface CivilCity {
  id: number;
  name: string;
  /** ADM0_A3 des Landes, zu dem die Stadt gehört */
  country: string;
  /** ADM0_A3 des aktuellen Kontrolleurs (Besatzung ändert das) */
  controller: string;
  capital: boolean;
  x: number;
  z: number;
  /** Stadtradius in km (Bebauung) */
  radiusKm: number;
  populationStart: number;
  /** lebende Einwohner in der Stadt */
  population: number;
  /** Flüchtlinge unterwegs (aus dieser Stadt) */
  refugees: number;
  killed: number;
  /** 0..1 Anteil, der evakuiert wurde / wird */
  evacuated: number;
  evacuating: boolean;
  /** 0..100 Zufriedenheit der Einwohner (Versorgung, Beschuss, Besatzung) */
  satisfaction: number;
  /** 0..1 Aufstandsrisiko (nur besetzt/unruhig) */
  unrest: number;
  control: CityControl;
  /** 0..1 Anteil der Zerstörung der Bausubstanz */
  damage: number;
}

export type CasualtyCause = 'collateral' | 'deliberate' | 'bombardment' | 'infrastructure' | 'starvation' | 'shield';

export type WarCrimeKind = 'civilian_attack' | 'protected_infra' | 'indiscriminate_bombardment' | 'human_shield_use' | 'hospital_attack' | 'evacuation_attack';

/** Abfrage für die Zielprüfung (implementiert von ProtectionSystem, genutzt von CombatSystem & UI) */
export type TargetClass =
  | 'free'          // kein Zivilgebiet
  | 'own_civil'     // eigene/verbündete Zivilgebiete: gesperrt
  | 'enemy_civil'   // feindliches Zivilgebiet: erlaubt, aber Warnung (Kriegsverbrechen bei gezieltem Angriff)
  | 'protected';    // geschützte Infrastruktur (Krankenhaus etc.): Angriff = Kriegsverbrechen

export interface TargetClassification {
  cls: TargetClass;
  cityId: number;
  infraId: number;
  /** Anzeigetext (Deutsch) für Warnung/Sperre */
  reason: string;
  /** Betroffene Einwohner (grobe Schätzung im Wirkungsradius) */
  populationAtRisk: number;
}

export interface ProtectionQuery {
  classify(x: number, z: number, attackerA3: string, radiusKm?: number): TargetClassification;
}

/** Ansehens-/Zufriedenheits-Ereignis */
export interface ReputationEvent {
  a3: string;
  /** Änderung des internationalen Ansehens (−100..+100 Skala) */
  delta: number;
  reason: string;
}
