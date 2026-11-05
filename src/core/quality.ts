/**
 * Grafikqualität (Presets). `Q` ist ein einziges, in-place aktualisiertes Objekt: Render-Module lesen `Q.*` je Frame
 * (oder abonnieren `onQualityChanged`, wenn Caches neu gebaut werden müssen). 'hoch' entspricht dem bisherigen Verhalten.
 */
export type QualityLevel = 'niedrig' | 'mittel' | 'hoch';

export interface QualityValues {
  /** Interne Renderauflösung = Bildschirm / pixelScale (Standard des Presets; der Nutzer kann ihn überschreiben) */
  pixelScale: number;
  /** Bayer-Dithering + Quantisierung im Post-Pass erlaubt */
  dither: boolean;
  // --- Vegetation
  /** max. Baum-Instanzen insgesamt */
  treeBudget: number;
  /** Kamerahöhe (km), ab der keine Bäume mehr gebaut/gezeichnet werden */
  treeDist: number;
  /** Zeitbudget (ms) für den Aufbau von Baumkacheln je Frame */
  treeBuildMs: number;
  // --- Städte / Dörfer
  /** Anteil der Straßenmöblierung (Laternen, Bäume, Autos …) 0..1 */
  streetPropDensity: number;
  /** Kameraabstand (km), bis zu dem Straßenmöblierung gezeichnet wird */
  streetPropDist: number;
  /** Kachelabstand (km) für detaillierte Gebäudemodelle */
  cityDetailKm: number;
  /** Kachelabstand (km) für einfache Fern-Quader */
  cityFarKm: number;
  /** Kamerahöhe (km) bis zu der Dörfer gezeichnet werden */
  villageDist: number;
  // --- Straßen / Brücken
  /** max. Straßen-Prop-Instanzen */
  roadPropBudget: number;
  /** Kamerahöhe (km), bis zu der Straßen-Props gebaut werden */
  roadPropDist: number;
  /** Kamerahöhe (km), bis zu der Straßenbänder (Detail) gebaut werden */
  roadRibbonDist: number;
  /** max. gleichzeitig gebaute Straßenkacheln */
  roadMaxTiles: number;
  /** Kameraabstand (km) für Brückenmodelle */
  bridgeDist: number;
  /** Kameraabstand (km) für Standort-Modelle (Ölfelder, Basen) */
  siteModelKm: number;
  // --- Einheiten
  /** Kameraabstand (km), ab dem Soldaten die einfache Variante nutzen */
  soldierLodKm: number;
  /** dito Fahrzeuge */
  vehLodKm: number;
  /** Kameraabstand (km), ab dem Fahrzeug-Animationen (Ketten, Räder) enden */
  vehAnimKm: number;
  // --- Effekte
  /** Partikel-Spawns je Frame (Notbremse) */
  particleBudget: number;
  /** max. Krater */
  craterCap: number;
  /** max. Bodendekale (Einschlagsspuren) */
  decalCap: number;
  /** Faktor auf die Wrack-Kapazität je Fahrzeugklasse 0..1 */
  wreckFrac: number;
  /** max. Trümmerteile (Debris) */
  debrisCap: number;
  // --- Zivilsystem / Nebel
  /** Radius (km), bis zu dem Zivilverkehr/Passanten animiert werden */
  civilAmbient: number;
  /** Kameraabstand (km), bis zu dem Zivilgebäude-Modelle gezeichnet werden */
  civilInfraKm: number;
  /** Mindestabstand (ms) zwischen Nebel-Berechnungen */
  fogUpdateMs: number;
  /** Zeitbudget (ms) je Nebel-Update */
  fogBudgetMs: number;
}

export type QualityState = QualityValues & { level: QualityLevel };

const HOCH: QualityValues = {
  pixelScale: 2, dither: true,
  treeBudget: 250000, treeDist: 24, treeBuildMs: 6,
  streetPropDensity: 1, streetPropDist: 9, cityDetailKm: 36, cityFarKm: 1800, villageDist: 110,
  roadPropBudget: 60000, roadPropDist: 15, roadRibbonDist: 38, roadMaxTiles: 150, bridgeDist: 60, siteModelKm: 75,
  soldierLodKm: 3.5, vehLodKm: 6, vehAnimKm: 5,
  particleBudget: 7000, craterCap: 3000, decalCap: 3200, wreckFrac: 1, debrisCap: 1800,
  civilAmbient: 14, civilInfraKm: 40, fogUpdateMs: 300, fogBudgetMs: 3,
};

const MITTEL: QualityValues = {
  pixelScale: 2, dither: true,
  treeBudget: 150000, treeDist: 16, treeBuildMs: 5,
  streetPropDensity: 0.6, streetPropDist: 6, cityDetailKm: 24, cityFarKm: 1200, villageDist: 70,
  roadPropBudget: 36000, roadPropDist: 10, roadRibbonDist: 26, roadMaxTiles: 100, bridgeDist: 40, siteModelKm: 55,
  soldierLodKm: 2.4, vehLodKm: 4, vehAnimKm: 3.5,
  particleBudget: 4200, craterCap: 1800, decalCap: 1900, wreckFrac: 0.6, debrisCap: 1100,
  civilAmbient: 9, civilInfraKm: 28, fogUpdateMs: 450, fogBudgetMs: 2.5,
};

const NIEDRIG: QualityValues = {
  pixelScale: 3, dither: false,
  treeBudget: 75000, treeDist: 9, treeBuildMs: 4,
  streetPropDensity: 0.3, streetPropDist: 3.5, cityDetailKm: 12, cityFarKm: 700, villageDist: 40,
  roadPropBudget: 18000, roadPropDist: 6, roadRibbonDist: 16, roadMaxTiles: 60, bridgeDist: 22, siteModelKm: 35,
  soldierLodKm: 1.4, vehLodKm: 2.4, vehAnimKm: 2,
  particleBudget: 2100, craterCap: 900, decalCap: 960, wreckFrac: 0.3, debrisCap: 540,
  civilAmbient: 5, civilInfraKm: 16, fogUpdateMs: 700, fogBudgetMs: 2,
};

export const QUALITY_PRESETS: Record<QualityLevel, QualityValues> = { niedrig: NIEDRIG, mittel: MITTEL, hoch: HOCH };
export const QUALITY_LEVELS: QualityLevel[] = ['niedrig', 'mittel', 'hoch'];

const KEY = 'ww3.quality';

export function isQualityLevel(v: unknown): v is QualityLevel {
  return v === 'niedrig' || v === 'mittel' || v === 'hoch';
}

/** Software-Renderer / schwache Geräte erkennen -> 'niedrig' */
function detectWeak(): boolean {
  try {
    if (typeof navigator !== 'undefined' && (navigator.hardwareConcurrency ?? 8) <= 4) return true;
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext | null;
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      if (/swiftshader|llvmpipe|software/i.test(name)) return true;
    }
  } catch {
    /* ignorieren */
  }
  return false;
}

export function loadQualityLevel(): { level: QualityLevel; stored: boolean } {
  try {
    const v = localStorage.getItem(KEY);
    if (isQualityLevel(v)) return { level: v, stored: true };
  } catch {
    /* ignorieren */
  }
  return { level: detectWeak() ? 'niedrig' : 'mittel', stored: false };
}

const init = loadQualityLevel();

/** Aktuelle Werte – wird in-place aktualisiert */
export const Q: QualityState = { level: init.level, ...QUALITY_PRESETS[init.level] };

const listeners = new Set<(q: QualityState) => void>();

/** Abonniert Qualitätswechsel; liefert die Abmelde-Funktion. */
export function onQualityChanged(fn: (q: QualityState) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Preset anwenden (in-place), speichern und Abonnenten informieren. */
export function setQuality(level: QualityLevel, persist = true): void {
  if (!isQualityLevel(level)) return;
  Object.assign(Q, QUALITY_PRESETS[level], { level });
  if (persist) {
    try {
      localStorage.setItem(KEY, level);
    } catch {
      /* ignorieren */
    }
  }
  for (const fn of Array.from(listeners)) {
    try {
      fn(Q);
    } catch (e) {
      console.error(e);
    }
  }
}
