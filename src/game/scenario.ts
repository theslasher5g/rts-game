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
  { a3: 'VAL', name: 'Republik Valdoria', short: 'Valdoria', color: '#4f7fbf', areaShare: 0.3, homeland: 'west', capital: 'Valdorn', playable: true },
  { a3: 'KRN', name: 'Föderation Kronland', short: 'Kronland', color: '#bf4f4f', areaShare: 0.28, homeland: 'east', capital: 'Kronheim', playable: true },
  { a3: 'MAR', name: 'Königreich Marenia', short: 'Marenia', color: '#5fa86a', areaShare: 0.22, homeland: 'south', capital: 'Marenburg', playable: true },
  { a3: 'PAN', name: 'Großherzogtum Pannonien', short: 'Pannonien', color: '#d3a13c', areaShare: 0.2, homeland: 'north', capital: 'Pannburg', playable: true },
];

/**
 * Bündnislage der KAMPAGNE (Einzelspieler): Valdoria und Marenia verbündet, Kronland führt Krieg gegen beide.
 * Pannonien bleibt in der Kampagne neutral (nimmt nicht am Krieg teil), damit die Missionen unverändert gelten.
 */
export const SCENARIO_ALLIANCES: Array<[string, string]> = [['VAL', 'MAR']];
export const SCENARIO_WARS: Array<[string, string]> = [['KRN', 'VAL'], ['KRN', 'MAR']];

/**
 * MEHRSPIELER (bis zu 4 Spieler): Standard 2 gegen 2 – Valdoria + Marenia gegen Kronland + Pannonien.
 * Alternativ „Jeder gegen jeden“ (keine Bündnisse, jeder Krieg gegen jeden).
 */
export const MP_MAX_PLAYERS = 4;
export type MpMode = 'teams' | 'ffa';
export const MP_TEAMS: Array<[string, string]> = [['VAL', 'MAR'], ['KRN', 'PAN']];
/** Kriegs- und Bündnispaare für einen Mehrspieler-Modus */
export function mpDiplomacy(mode: MpMode): { alliances: Array<[string, string]>; wars: Array<[string, string]> } {
  const all = ['VAL', 'KRN', 'MAR', 'PAN'];
  const wars: Array<[string, string]> = [];
  const alliances: Array<[string, string]> = [];
  if (mode === 'teams') {
    alliances.push(['VAL', 'MAR'], ['KRN', 'PAN']);
    for (const a of ['VAL', 'MAR']) for (const b of ['KRN', 'PAN']) wars.push([a, b]);
  } else {
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) wars.push([all[i], all[j]]);
  }
  return { alliances, wars };
}

/**
 * Wirtschaft (ab Phase 5, Vorbild: Öl ist die einzige Währung): Ölfelder fördern, Tankwagen-Konvois liefern über das
 * Straßennetz an die Raffinerie, angelieferte Fässer sind das Guthaben für Produktion und Nachschub.
 * Siehe src/logistics/types.ts.
 */
export const OIL_START_BARRELS = 600;
export const OIL_FIELDS_PER_MAP = 12;
