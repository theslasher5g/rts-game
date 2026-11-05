/**
 * Phase 3 – gemeinsame Verträge für Kampf, Taktik, Effekte und Bauwerke.
 * Module sprechen über den EventBus (core/types.ts GameEvents) und über die Interfaces hier.
 * Koordinaten: Welt-km [x, z]; y = Welt-Y (Gelände * Überhöhung), siehe core/types.ts.
 */

export type WeaponKind =
  | 'rifle' | 'mg' | 'hmg' | 'sniper' | 'autocannon' | 'tank_gun' | 'atgm' | 'rpg'
  | 'mortar' | 'howitzer' | 'rocket_arty' | 'sam' | 'flak' | 'heli_gun' | 'heli_rocket' | 'heli_atgm'
  | 'air_gun' | 'air_missile' | 'bomb' | 'naval_gun' | 'torpedo' | 'antiship_missile' | 'fpv' | 'grenade' | 'demo_charge';

export type ImpactSurface = 'ground' | 'water' | 'building' | 'armor' | 'flesh' | 'structure';
export type ExplosionSize = 'tiny' | 'small' | 'medium' | 'large' | 'huge';

export type CoverKind = 'wall' | 'crate' | 'wreck' | 'sandbag' | 'trench' | 'rubble' | 'building' | 'terrain' | 'bunker' | 'tree';
export type Posture = 'stand' | 'crouch' | 'prone';

/**
 * Deckungspunkt. Schützt Infanterie, die dahinter (auf der Seite -dir) steht, vor Feuer aus Richtung +dir.
 * dirX/dirZ: normierte Richtung, aus der die Deckung schützt ("Vorderseite").
 */
export interface CoverPoint {
  id: number;
  x: number;
  z: number;
  dirX: number;
  dirZ: number;
  kind: CoverKind;
  /** Schutzwert gegen Beschuss von vorn, 0..1 */
  protection: number;
  /** Empfohlene Haltung hinter der Deckung */
  posture: Posture;
  /** Wie viele Soldaten (Modelle) die Deckung aufnehmen kann */
  capacity: number;
  /** true = niedrig genug zum Überspringen (Vault) */
  vaultable: boolean;
  /** Besitzer-ID der Struktur (StructureManager) oder 0 */
  structureId: number;
  /** Zerstört/entfernt bei Wegfall */
  alive: boolean;
}

export interface CoverQuery {
  /** Beste freie Deckung in rMax km um (x,z) gegen Bedrohung aus Richtung (threatX,threatZ). null wenn keine. */
  find(x: number, z: number, threatX: number, threatZ: number, rMaxKm: number, minProtection?: number): CoverPoint | null;
  get(id: number): CoverPoint | undefined;
}

/** Rauch-/Staubfeld: blockiert Sicht. Dichte 0..1 */
export interface SmokeQuery {
  densityAt(x: number, z: number): number;
}

/** Zivilschutz-Schnittstelle (Phase 4): Ziele in geschützten Zivilgebieten sperren. Phase 3: nie gesperrt. */
export interface TargetProtection {
  isProtected(x: number, z: number, attackerA3: string): boolean;
}

/** Gebäude (aus Cities-Instanzen) für Besetzung/Beschuss. */
export interface BuildingInfo {
  id: number;
  x: number;
  z: number;
  /** Grundfläche in km (Breite, Tiefe), Höhe über Boden in km (ohne Überhöhung), Rotation rad */
  w: number;
  d: number;
  h: number;
  rot: number;
  /** ADM0_A3 des Landes */
  country: string;
  /** 0..1 */
  integrity: number;
  garrisonCapacity: number;
  garrisoned: number;
  /** Land-Besitzer des Gebäudes (für Phase 4: zivil = true) */
  civilian: boolean;
}

export type StructureKind =
  | 'sandbags' | 'tank_trap' | 'barbed_wire' | 'trench' | 'bunker' | 'mg_nest' | 'mortar_pit' | 'at_position'
  | 'minefield' | 'roadblock' | 'foxhole';

export interface StructureInfo {
  id: number;
  kind: StructureKind;
  owner: string;
  /** Polylinie [x0,z0,x1,z1,...] (Wand/Graben/Linie) oder einzelner Punkt */
  points: number[];
  /** 0..1 Baufortschritt */
  progress: number;
  hp: number;
  hpMax: number;
}

/** Kriegsbeteiligung. Implementierung: src/game/War.ts */
export interface WarQuery {
  isHostile(a: string, b: string): boolean;
  /** Grenzschutz: solange true, wird nicht gekämpft (auch keine Flächenfeuerbefehle) */
  ceasefire?: boolean;
}
