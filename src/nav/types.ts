/**
 * Phase 2 – Navigations-Verträge (Straßen-/Schienen-/Fährnetz + Gelände-Wegfindung).
 * Koordinaten: Welt-km [x, z] (siehe src/core/types.ts).
 */

export type RoadClass = 'motorway' | 'primary' | 'secondary' | 'road' | 'track' | 'rail' | 'ferry';

export interface NavNode {
  id: number;
  x: number;
  z: number;
  /** Indizes in NavGraph.edges */
  edges: number[];
}

export interface NavEdge {
  id: number;
  a: number;
  b: number;
  cls: RoadClass;
  lengthKm: number;
  /** Edge kreuzt einen Fluss/See (Brücke) – Phase 3: sprengbar */
  bridge: boolean;
  /** false = gesperrt/zerstört; Wegfindung ignoriert die Kante (Echtzeit-Update) */
  open: boolean;
  /** Polylinie inkl. Endpunkte als [x0,z0,x1,z1,...] in Welt-km (Richtung a -> b) */
  geom: Float32Array;
  /** Land (ADM0_A3) laut Datensatz, '' wenn unbekannt */
  country: string;
}

/** Wie sich eine Einheit bewegt. Geschwindigkeiten in km/h. */
export interface MobilityProfile {
  domain: 'ground' | 'air' | 'naval';
  /** Geschwindigkeit je Straßenklasse; fehlende/0 = Klasse nicht nutzbar */
  roadSpeed: Partial<Record<RoadClass, number>>;
  /** Geländegeschwindigkeit (flach, trocken) */
  offroadSpeed: number;
  /** Darf überhaupt abseits von Straßen fahren (schwere Radfahrzeuge: kaum) */
  offroadAllowed: boolean;
  /** 0..1 – wie stark Hangneigung bremst (Kettenfahrzeuge niedrig, Räder hoch) */
  slopePenalty: number;
}

/** Ergebnis einer Wegfindung: abfahrbare Polylinie mit Geschwindigkeit je Segment. */
export interface Route {
  /** [x0,z0,x1,z1,...] Welt-km, beginnt an der Startposition, endet am Ziel */
  points: Float32Array;
  /** km/h je Segment (Länge = points.length/2 - 1) */
  segSpeed: Float32Array;
  /** Straßenklasse je Segment, 255 = Gelände/offroad, sonst Index in ROAD_CLASSES */
  segClass: Uint8Array;
  lengthKm: number;
  /** geschätzte Fahrzeit in Spielstunden */
  etaHours: number;
}

export const ROAD_CLASSES: RoadClass[] = ['motorway', 'primary', 'secondary', 'road', 'track', 'rail', 'ferry'];
export const OFFROAD_CLASS = 255;
