/**
 * Gemeinsame Typen & Konventionen (Phase 1).
 *
 * WELT-KOORDINATEN (Three.js):
 *   1 Welteinheit = 1 km.
 *   X = Osten, Z = Süden, Y = Höhe.
 *   Ursprung (0,0,0) = Nordwest-Ecke der Karte auf Meeresniveau.
 *   Karte reicht von x ∈ [0, widthKm], z ∈ [0, heightKm].
 *   UV für Kartentexturen: u = x / widthKm, v = z / heightKm  (Zeile 0 der Rasterdaten = Norden = v 0).
 *   Höhe in Welt-Y = höheKm * settings.heightExaggeration  (Meer: Wasserfläche bei y = 0).
 */

export interface CountryMeta {
  /** 1..249, entspricht Rot-Kanal in countries.png */
  id: number;
  /** Natural-Earth ADM0_A3, z. B. "DEU" */
  a3: string;
  /** Deutscher Name */
  name: string;
  nameEn: string;
  /** Natural-Earth MAPCOLOR9 (1..9): Nachbarn haben unterschiedliche Werte */
  mapColor: number;
  population: number;
  gdpMd: number;
  /** Label-Position in Welt-km [x, z] */
  label: [number, number];
  labelRank: number;
  /** Anzahl Rasterzellen (≈ Fläche / cellKm²) */
  cells: number;
}

export interface CityMeta {
  name: string;
  /** ADM0_A3 */
  country: string;
  pop: number;
  capital: boolean;
  /** Welt-km [x, z] */
  pos: [number, number];
}

export interface GeoMeta {
  version: number;
  generated: string;
  sources: string[];
  projection: { type: 'laea'; lat0: number; lon0: number; radiusKm: number; xMinKm: number; yMaxKm: number };
  grid: { width: number; height: number; cellKm: number; chunkCells: number; heightOffset: number };
  countries: CountryMeta[];
  cities: CityMeta[];
}

/** Wasser-Flags (Grün-Kanal in countries.png) */
export const WATER_LAKE = 1;
export const WATER_RIVER = 2;

/** Grafik-/Spieleinstellungen, die zur Laufzeit geändert werden können. */
export interface Settings {
  /** Vertikale Überhöhung des Geländes (1 = realistisch) */
  heightExaggeration: number;
  /** Interne Renderauflösung = Bildschirm / pixelScale (1..4) */
  pixelScale: number;
  /** Bayer-Dithering + Farbquantisierung */
  dithering: boolean;
  /** Bits pro Farbkanal bei Quantisierung (4..8), PS2-Framebuffer ≈ 5 */
  colorBits: number;
  /** Politische Einfärbung der Länder (0 = reines Gelände, 1 = stark) */
  politicalOverlay: number;
  /** Kamerarotation mit Q/E und mittlerer Maustaste erlauben */
  allowRotation: boolean;
  /** Bildschirmrand-Scrollen */
  edgeScroll: boolean;
  showLabels: boolean;
  showCities: boolean;
  /** Phase 2: Straßen-/Schienennetz anzeigen */
  showRoads: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  heightExaggeration: 6,
  pixelScale: 2,
  dithering: true,
  colorBits: 5,
  politicalOverlay: 0.45,
  allowRotation: true,
  edgeScroll: true,
  showLabels: true,
  showCities: true,
  showRoads: true,
};

/** Ergebnis eines Kartenpicks (Maus -> Welt) */
export interface MapPick {
  /** Weltposition auf dem Gelände (bzw. Wasserfläche) */
  x: number;
  y: number;
  z: number;
  /** Länder-ID (0 = Meer / kein Land) */
  countryId: number;
}

/** Ereignisse auf dem globalen EventBus */
export interface GameEvents {
  'country:hover': { id: number };
  'country:select': { id: number };
  'settings:changed': { settings: Settings };
  'camera:focus': { x: number; z: number; distance?: number };
  'game:start': { countryA3: string };
  // Phase 2
  /** Auswahl hat sich geändert (Unit-IDs) */
  'units:selection': { ids: number[] };
  'unit:spawned': { id: number };
  'unit:removed': { id: number };
  /** NavGraph-Kante geöffnet/gesperrt (Phase 3: Brücke gesprengt/repariert) */
  'nav:edge': { edgeId: number; open: boolean };
  // Phase 3 – Kampf (alle Positionen: Welt-km x,z + Welt-Y y)
  /** Waffe wurde abgefeuert. flightSec = Flugzeit bis zum Einschlag (0 = Hitscan/Tracer sofort) */
  'combat:fire': { unitId: number; weapon: import('../combat/types').WeaponKind; fx: number; fy: number; fz: number; tx: number; ty: number; tz: number; flightSec: number; indirect: boolean };
  'combat:impact': { weapon: import('../combat/types').WeaponKind; x: number; y: number; z: number; surface: import('../combat/types').ImpactSurface; radiusKm: number };
  'combat:explosion': { x: number; y: number; z: number; size: import('../combat/types').ExplosionSize; fire: boolean };
  'unit:damaged': { id: number; amount: number; hp: number; attackerId: number; suppression: number };
  'unit:killed': { id: number; typeId: string; category: string; owner: string; x: number; y: number; z: number; heading: number; killerId: number; cause: string };
  /** Wrack entsteht (Fahrzeug zerstört) */
  'wreck:spawn': { x: number; y: number; z: number; heading: number; category: string; typeId: string; owner: string };
  'smoke:spawn': { x: number; z: number; radiusKm: number; durationSec: number; density: number };
  // Bauwerke, Gebäude, Brücken
  'structure:added': { id: number; kind: import('../combat/types').StructureKind; owner: string };
  'structure:removed': { id: number };
  'cover:add': { point: import('../combat/types').CoverPoint };
  'cover:remove': { id: number };
  'building:damaged': { id: number; integrity: number };
  'building:destroyed': { id: number; x: number; y: number; z: number };
  'building:garrison': { buildingId: number; unitIds: number[]; enter: boolean };
  'bridge:destroyed': { edgeId: number; geom: number[] };
  'bridge:repaired': { edgeId: number };
  // Krieg
  'war:declared': { a: string; b: string };
  'toast': { msg: string; kind?: 'info' | 'warn' | 'error' };
  // Phase 4 – Zivilisten, Ansehen, Besatzung
  /** Ein Befehl (Feuerbefehl/Angriff/Bombenlauf) zielt auf einen Punkt: Schutz-/Ansehenssystem klassifiziert (gezielter Angriff) */
  'combat:order-target': { attacker: string; x: number; z: number; radiusKm: number; weapon: import('../combat/types').WeaponKind };
  'civil:casualties': { cityId: number; country: string; killed: number; wounded: number; cause: import('../civil/types').CasualtyCause; attacker: string };
  'civil:evacuate': { cityId: number; start: boolean };
  'civil:infra': { id: number; kind: import('../civil/types').InfraKind; cityId: number; integrity: number; destroyed: boolean; attacker: string };
  'civil:aid': { cityId: number; amount: number; by: string };
  'warcrime': { attacker: string; victim: string; kind: import('../civil/types').WarCrimeKind; cityId: number; severity: number };
  'reputation:changed': { a3: string; value: number; delta: number; reason: string };
  'satisfaction:delta': { a3: string; delta: number; reason: string };
  'city:captured': { cityId: number; by: string; from: string };
  'city:unrest': { cityId: number; level: number };
  'city:uprising': { cityId: number; against: string };
}
