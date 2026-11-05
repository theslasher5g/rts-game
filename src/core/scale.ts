/**
 * Zentrale Darstellungsmaßstäbe (Single Source of Truth).
 *
 * Grundsatz: Kein Objekt wächst oder schrumpft mit dem Kameraabstand. Jede Objektklasse hat einen FESTEN Faktor
 * gegenüber der realen Größe (Welteinheit = 1 km, Modelle sind in Metern gebaut). Zoomen ändert nur, wie viel
 * Karte man sieht – wie in einem klassischen RTS. Erlaubt bleiben: LOD-Wechsel (Detailgrad, nicht Größe),
 * Ausblenden unterhalb der Pixelgrenze, NATO-Zeichen/Marker/Ringe/Balken mit konstanter Bildschirmgröße.
 */
export const SCALE = {
  /** Fahrzeuge, Luft- und Seefahrzeuge (× je Modell-`boost`, z. B. Schiffe 0.4): Panzer ~7 m -> ~50 m */
  units: 6,
  /** Infanterie (Soldat 1.8 m -> ~14 m); ersetzt den Modell-`boost` der Soldatenmodelle */
  infantry: 7,
  /** Gebäude/Städte/Dörfer: reale Größe */
  buildings: 1,
  /** Straßenmöblierung, Bäume, Bahn-/Straßenprops, Zäune */
  props: 1.4,
  /** Straßenmöblierung (Laternen, Schilder, Masten, Leitplanken): zwischen Props und Straßenbreite, damit sie neben dem Band nicht winzig wirken */
  roadProps: 2.2,
  /** Explosionen, Rauch, Mündungsfeuer, Krater: fester Multiplikator (Partikel-Exponent 0.85 im Shader) */
  effects: 6,
  /** Gräben, Sandsäcke, Bunker, Minenfelder … */
  structures: 3,
  /** Ölplattformen, Raffinerien, HQ, Kasernen: Landmarken, größer als real */
  bases: 2.5,
  /** Zivile Infrastruktur-Modelle (Masten, Tanks, Zivilfahrzeuge/Fußgänger an Straßen) */
  infra: 3,
  /** Fahrbahnbänder (Breite, Querversatz der Möblierung, Brückendeck) */
  roadWidth: 3.5,
} as const;

/** Modellmaßstab einer Einheit: Soldaten -> SCALE.infantry, alle anderen -> SCALE.units × boost */
export function unitModelScale(boost: number, soldier: boolean): number {
  return soldier ? SCALE.infantry : SCALE.units * boost;
}

/** Referenzlänge (m) eines Kampfpanzers für die Counter-Schwelle */
export const COUNTER_REF_M = 7;
/** Unter dieser Länge (Pixel) wird aus dem 3D-Modell ein NATO-Zeichen */
export const COUNTER_MIN_PX = 7;
/** Vertikales Sichtfeld der RTS-Kamera (Grad) – RTSCamera.FOV_DEG */
export const CAMERA_FOV_DEG = 32;

/**
 * Kameraabstand (km), ab dem ein Referenzpanzer (COUNTER_REF_M · SCALE.units) kleiner als COUNTER_MIN_PX Pixel wird.
 * px je km Bodenabstand = screenH / (2·d·tan(fov/2)).
 */
export function counterDistanceKm(screenH: number, fovDeg: number = CAMERA_FOV_DEG): number {
  const lenKm = (COUNTER_REF_M * SCALE.units) / 1000;
  return (lenKm * screenH) / (COUNTER_MIN_PX * 2 * Math.tan((fovDeg * Math.PI) / 360));
}
