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
}
