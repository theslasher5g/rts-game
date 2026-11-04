/**
 * Szenario-Definition (ab Phase 5): kleine Karte auf echtem Gelände mit erfundenen Ländern und Städten.
 * Fokus: Positionierung und Gefecht, kein Länder-Management. Wirtschaft = Nachschub + Produktion.
 *
 * Diese Datei ist der gemeinsame Vertrag: Kartenpipeline (scripts/build-region.mjs), Länderdaten, UI und Logistik
 * verwenden dieselben Codes. Die Spiel-Länder-Codes (a3) sind erfunden und kollidieren nicht mit echten ISO-Codes.
 */

export interface ScenarioNation {
  /** erfundener 3-Buchstaben-Code (steht in meta.json countries[].a3) */
  a3: string;
  name: string;
  /** Kurzname für Einheitsnamen und Meldungen */
  short: string;
  /** Teamfarbe (Hex) */
  color: string;
  /** Anteil der Kartenfläche (grobe Vorgabe für die Grenzziehung) */
  areaShare: number;
  /** Himmelsrichtung des Kernlandes auf der Karte (Vorgabe für die Pipeline) */
  homeland: 'west' | 'east' | 'north' | 'south' | 'center';
  /** Hauptstadtname (erfunden) */
  capital: string;
  /** Spielbar */
  playable: boolean;
}

export const SCENARIO_ID = 'adria-nord';
export const SCENARIO_NAME = 'Operation Nordadria';

/**
 * Kartenausschnitt: reales Gelände zwischen Alpen, Adria und Pannonischer Ebene (Slowenien/Kroatien/Ungarn-Region),
 * ca. 300 × 200 km. Die Pipeline darf Mittelpunkt und Ausdehnung leicht anpassen, muss sie aber in meta.json.scenario eintragen.
 */
export const SCENARIO_REGION = {
  centerLon: 15.6,
  centerLat: 45.9,
  widthKm: 300,
  heightKm: 200,
  /** Zellgröße der Rasterdaten in km (Gelände-Auflösung) */
  cellKm: 0.25,
};

export const SCENARIO_NATIONS: ScenarioNation[] = [
  { a3: 'VAL', name: 'Republik Valdoria', short: 'Valdoria', color: '#4f7fbf', areaShare: 0.4, homeland: 'west', capital: 'Valdorn', playable: true },
  { a3: 'KRN', name: 'Föderation Kronland', short: 'Kronland', color: '#bf4f4f', areaShare: 0.36, homeland: 'east', capital: 'Kronheim', playable: true },
  { a3: 'MAR', name: 'Königreich Marenia', short: 'Marenia', color: '#5fa86a', areaShare: 0.24, homeland: 'south', capital: 'Marenburg', playable: true },
];

/** Bündnislage zu Spielbeginn: Valdoria und Marenia verbündet, Kronland feindlich (Krieg bei Spielstart) */
export const SCENARIO_ALLIANCES: Array<[string, string]> = [['VAL', 'MAR']];
export const SCENARIO_WARS: Array<[string, string]> = [['KRN', 'VAL'], ['KRN', 'MAR']];
