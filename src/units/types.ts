/**
 * Phase 2 – Einheiten-Verträge.
 * Eine Unit = ein Verband auf der Karte (Infanterie-Trupp, Panzerzug, Batterie, Staffel, Schiff),
 * dargestellt als Gruppe mehrerer Modelle (memberCount).
 */
import type { MobilityProfile, Route } from '../nav/types';

export type UnitCategory = 'infantry' | 'recon' | 'ifv' | 'tank' | 'artillery' | 'aa' | 'support' | 'helicopter' | 'jet' | 'drone' | 'naval';

export type Formation = 'line' | 'column' | 'wedge' | 'spread';
export const FORMATION_NAMES: Record<Formation, string> = { line: 'Linie', column: 'Kolonne', wedge: 'Keil', spread: 'Verteilt' };

export interface UnitTypeDef {
  id: string;            // z. B. 'mbt_heavy'
  name: string;          // Deutsch, z. B. 'Kampfpanzer (schwer)'
  short: string;         // Kurzlabel, z. B. 'KPz'
  category: UnitCategory;
  /** Anzahl Modelle/Soldaten im Verband */
  memberCount: number;
  mobility: MobilityProfile;
  /** Platzbedarf eines Verbands in km (Formationsabstand) */
  spacingKm: number;
  armor: number;          // 0..100
  hp: number;             // Lebenspunkte des Verbands
  damage: number;         // pro Schuss/Salve (Phase 3)
  rangeKm: number;
  sightKm: number;
  ammo: number;           // Salven
  fuelKm: number;         // Reichweite mit vollem Tank (Infanterie: Infinity)
  cost: number;           // Mio $
  /** Schlüssel des Low-Poly-Modells im UnitRenderer */
  model: string;
}

export type OrderKind = 'move' | 'attackMove' | 'reverse' | 'hold' | 'defend' | 'retreat' | 'patrol' | 'stop' | 'attack' | 'fireAt' | 'garrison' | 'build' | 'demolish' | 'repair';

export interface Order {
  kind: OrderKind;
  x: number;
  z: number;
  /** Ziel-Blickrichtung in rad (0 = Norden/−Z, im Uhrzeigersinn), undefined = Fahrtrichtung */
  facing?: number;
  /** patrol: Ausgangspunkt der Schleife (vom UnitManager gesetzt) */
  originX?: number;
  originZ?: number;
  /** attack: Ziel-Unit; garrison: Gebäude-ID; demolish/repair: NavEdge-ID; build: Structure-ID */
  targetId?: number;
  /** build: StructureKind; Polylinie in Welt-km [x0,z0,...] */
  buildKind?: import('../combat/types').StructureKind;
  points?: number[];
}

export interface Unit {
  id: number;
  type: UnitTypeDef;
  /** ADM0_A3 des Besitzers */
  owner: string;
  x: number;
  z: number;
  /** Bodenhöhe in Welt-Y (wird vom UnitManager gepflegt) */
  y: number;
  /** rad, 0 = Norden (−Z), im Uhrzeigersinn */
  heading: number;
  /** aktuelle Geschwindigkeit km/h */
  speedKmh: number;
  hp: number;
  ammo: number;
  fuel: number;           // km Restreichweite
  experience: number;     // 0..1
  morale: number;         // 0..1
  /** Warteschlange; orders[0] = aktiver Befehl */
  orders: Order[];
  /** aktive Route zu orders[0] (null = steht / wird berechnet) */
  route: Route | null;
  /** zurückgelegte km auf route */
  routeKm: number;
  /** Gruppen-Höchstgeschwindigkeit km/h (Verband = langsamste Einheit); Infinity = keine Begrenzung */
  groupSpeedCap: number;
  formation: Formation;
  selected: boolean;
  /** Verbandsname, z. B. '1. Panzerzug / 2. Kp' */
  name: string;
  // --- Ergänzungen (Phase 2, vom UnitManager gepflegt; optional für Kompatibilität)
  /** 'hold' = Stellung halten (nach issueHold), sonst 'free' */
  stance?: UnitStance;
  /** Luftfahrzeug ist in der Luft (false = gelandet/geparkt) */
  airborne?: boolean;
  /** Bewegt sich gerade auf einer Straße/Schiene (aktuelles Routensegment) */
  onRoad?: boolean;
  /** Route zu orders[0] wird gerade berechnet (in der Warteschlange) */
  routePending?: boolean;
  // --- Phase 3 (Kampf, vom CombatSystem/TacticsSystem gepflegt; optional)
  /** 0..1 Unterdrückung (Suppression): bremst Feuerrate/Bewegung, zwingt Infanterie in Deckung */
  suppression?: number;
  /** Aktuelle Haltung der Infanterie (Renderer: Modelle stehen/kauern/liegen) */
  posture?: import('../combat/types').Posture;
  /** Belegter Deckungspunkt (CoverPoint.id) */
  coverId?: number;
  /** Position/Richtung der Deckung, damit der Renderer die Mitglieder dahinter anordnet (Welt-km; dir = Schutzrichtung) */
  coverX?: number;
  coverZ?: number;
  coverDirX?: number;
  coverDirZ?: number;
  /** Gebäude-ID (BuildingInfo.id), wenn die Einheit darin besetzt ist (dann nicht gerendert) */
  garrisonId?: number;
  /** Aktuelles Kampfziel: Einheiten-ID oder 0; Positionsziel (Artillerie-Feuerbefehl) */
  targetId?: number;
  fireX?: number;
  fireZ?: number;
  /** Sekunden bis zum nächsten möglichen Schuss je Waffe (CombatSystem) */
  cooldown?: number;
  kills?: number;
  /** Verwundete Soldaten (Infanterie); Sanitäter bergen sie */
  wounded?: number;
  /** Strukturbau-Auftrag (Pioniere): StructureInfo.id */
  buildingStructureId?: number;
  /** Feuer-/Gefechtsstatus für Anzeige (CombatSystem: hat gültiges Ziel in Reichweite / hat vor <2 s gefeuert). Hält attackMove/attack-Befehle an. */
  engaged?: boolean;
  /**
   * Phase 3 (CombatSystem): Anzahl noch kampffähiger Modelle/Soldaten (1..type.memberCount), proportional zu hp/type.hp.
   * UnitRenderer darf damit überzählige Modelle ausblenden; undefined = alle.
   */
  membersAlive?: number;
  // --- Phase 3 Taktik (InfantryAI)
  /**
   * true = Einheit ist festgenagelt/in Überwachungsphase: der UnitManager darf sie NICHT vorrücken lassen
   * (Geschwindigkeit -> 0, Befehle/Route bleiben erhalten). Gesetzt von InfantryAI, gelesen vom UnitManager/CombatSystem
   * (CombatSystem: Feuer nur als Gegenfeuer mit Malus).
   */
  pinned?: boolean;
  /** Verbleibende Sprungzeit (s) eines Vault-Sprungs, 0.6 -> 0 (InfantryAI setzt, UnitRenderer zeichnet Hüpfer) */
  vaultT?: number;
}

export type UnitStance = 'free' | 'hold';

export interface MoveOptions {
  formation?: Formation;
  /** Blickrichtung am Ziel (rad) */
  facing?: number;
  /** Shift: an Warteschlange anhängen statt ersetzen */
  queue?: boolean;
  kind?: Extract<OrderKind, 'move' | 'attackMove' | 'reverse' | 'retreat' | 'patrol'>;
  /** Formations-Breite in km (aus Rechtsklick-Ziehen), sonst automatisch */
  widthKm?: number;
}
