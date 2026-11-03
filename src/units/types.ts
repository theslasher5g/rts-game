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

export type OrderKind = 'move' | 'attackMove' | 'reverse' | 'hold' | 'defend' | 'retreat' | 'patrol' | 'stop';

export interface Order {
  kind: OrderKind;
  x: number;
  z: number;
  /** Ziel-Blickrichtung in rad (0 = Norden/−Z, im Uhrzeigersinn), undefined = Fahrtrichtung */
  facing?: number;
  /** patrol: Ausgangspunkt der Schleife (vom UnitManager gesetzt) */
  originX?: number;
  originZ?: number;
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
