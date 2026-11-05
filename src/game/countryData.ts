/**
 * Länderdaten des Szenarios "Operation Nordadria" (Phase 5): vier erfundene Nationen auf kleiner Karte.
 * Wirtschaft = Öl (siehe src/logistics/types.ts); die klassischen Ressourcenblöcke bleiben nur als
 * Kompatibilitätsschicht (alle Werte klein bzw. 0), die HUD zeigt ausschließlich Öl.
 * Militärzahlen sind Theaterstärken (Dutzende Panzer, keine Tausende).
 */

/** BUND = Bündnis Valdoria/Marenia, PAKT = Kronland-Pakt, NEUTRAL = alle anderen */
export type Bloc = 'BUND' | 'PAKT' | 'NEUTRAL';
export type Government = 'Demokratie' | 'Autoritär' | 'Hybrid';

export interface ResourceStock {
  geld: number;
  oel: number;
  gas: number;
  stahl: number;
  nahrung: number;
  munition: number;
  seltene_erden: number;
  industriegueter: number;
  konsumgueter: number;
}

export type ResourceKey = keyof ResourceStock;

export interface StartProfile {
  a3: string;
  name: string;
  /** Emoji-Flagge */
  flag: string;
  /** Teamfarbe (hex) */
  color: string;
  government: Government;
  bloc: Bloc;
  leaderTitle: string;
  /** Mio. Einwohner */
  population: number;
  /** Mrd $ */
  gdp: number;
  debtPct: number;
  inflation: number;
  /** 0..100 */
  zufriedenheit: number;
  /** Mrd $ */
  militaryBudget: number;
  /** aktive Soldaten, Tsd. */
  manpower: number;
  tanks: number;
  ifv: number;
  artillery: number;
  aircraft: number;
  helicopters: number;
  ships: number;
  drones: number;
  /** Lagerbestand */
  stock: ResourceStock;
  /** Produktion pro Tag */
  production: ResourceStock;
  /** Verbrauch pro Tag */
  consumption: ResourceStock;
  allies: string[];
  /** veraltet (Handel entfällt) – immer leer */
  tradePartners: string[];
  /** -100..100 zu wichtigen Staaten */
  relations: Record<string, number>;
  strengths: string[];
  weaknesses: string[];
  difficulty: 'Leicht' | 'Mittel' | 'Schwer';
  /** Phase 5: Kurzname, Hauptstadt (erfunden), Spielhinweis */
  short: string;
  capital: string;
  /** Ein-Satz-Charakterisierung für das Hauptmenü */
  blurb: string;
}

/** Anzeigeinfos der (Rest-)Ressourcen. Phase 5: nur Öl ist relevant; die anderen Schlüssel bleiben für Altcode. */
export const RESOURCE_INFO: ReadonlyArray<{ key: ResourceKey; name: string; short: string; unit: string; icon: string }> = [
  { key: 'oel', name: 'Öl', short: 'ÖL', unit: 'Fässer', icon: '🛢' },
];

/** Namen für Staaten außerhalb des Kartenausschnitts (Beziehungen/Partner). */
export const EXTERNAL_NAMES: Record<string, string> = {};

/** [geld, oel, gas, stahl, nahrung, munition, seltene_erden, industriegueter, konsumgueter] */
type R9 = [number, number, number, number, number, number, number, number, number];
function rs(v: R9): ResourceStock {
  return {
    geld: v[0], oel: v[1], gas: v[2], stahl: v[3], nahrung: v[4],
    munition: v[5], seltene_erden: v[6], industriegueter: v[7], konsumgueter: v[8],
  };
}

const BUND_ALLIES = (self: string) => ['VAL', 'MAR'].filter((a) => a !== self);

export const START_PROFILES: StartProfile[] = [
  {
    a3: 'VAL', name: 'Republik Valdoria', short: 'Valdoria', capital: 'Valdorn', flag: '🔵', color: '#4f7fbf',
    government: 'Demokratie', bloc: 'BUND', leaderTitle: 'Präsident',
    population: 6.2, gdp: 95, debtPct: 48, inflation: 3.1, zufriedenheit: 58,
    militaryBudget: 2.4, manpower: 22, tanks: 36, ifv: 54, artillery: 24, aircraft: 8, helicopters: 6, ships: 0, drones: 20,
    stock: rs([0, 0, 0, 0, 0, 0, 0, 0, 0]),
    production: rs([0, 0, 0, 0, 0, 0, 0, 0, 0]),
    consumption: rs([0, 0, 0, 0, 0, 0, 0, 0, 0]),
    allies: BUND_ALLIES('VAL'), tradePartners: [],
    relations: { MAR: 80, KRN: -90, PAN: -40 },
    strengths: ['Ausgewogenes Heer mit guter Artillerie', 'Gebirgsriegel im Norden verkürzt die Front', 'Zwei Raffineriestraßen durch das Tal'],
    weaknesses: ['Ölfelder liegen weit von der Hauptstadt', 'Die Ebene im Osten ist offen', 'Wenige Pioniere für Brückenreparaturen'],
    difficulty: 'Mittel',
    blurb: 'Gebirgsland im Westen. Solide Streitkräfte, aber lange Versorgungswege.',
  },
  {
    a3: 'KRN', name: 'Föderation Kronland', short: 'Kronland', capital: 'Kronheim', flag: '🔴', color: '#bf4f4f',
    government: 'Autoritär', bloc: 'PAKT', leaderTitle: 'Bundesmarschall',
    population: 9.0, gdp: 120, debtPct: 31, inflation: 5.4, zufriedenheit: 46,
    militaryBudget: 3.9, manpower: 34, tanks: 64, ifv: 90, artillery: 40, aircraft: 14, helicopters: 10, ships: 0, drones: 30,
    stock: rs([0, 0, 0, 0, 0, 0, 0, 0, 0]),
    production: rs([0, 0, 0, 0, 0, 0, 0, 0, 0]),
    consumption: rs([0, 0, 0, 0, 0, 0, 0, 0, 0]),
    allies: ['PAN'], tradePartners: [],
    relations: { VAL: -90, MAR: -90, PAN: 75 },
    strengths: ['Stärkste Panzerwaffe der Region', 'Eigene Ölfelder in der Ebene', 'Zentral geführt, schneller Aufmarsch'],
    weaknesses: ['Abhängig von wenigen Fernstraßen und Brücken', 'Kriegsmüde Bevölkerung', 'Kein Zugang zum Meer'],
    difficulty: 'Schwer',
    blurb: 'Aggressor aus der Ebene im Osten. Viele Panzer, aber ein langer, verwundbarer Nachschubweg.',
  },
  {
    a3: 'MAR', name: 'Königreich Marenia', short: 'Marenia', capital: 'Marenburg', flag: '🟢', color: '#5fa86a',
    government: 'Hybrid', bloc: 'BUND', leaderTitle: 'König',
    population: 3.1, gdp: 38, debtPct: 55, inflation: 4.2, zufriedenheit: 62,
    militaryBudget: 0.9, manpower: 11, tanks: 14, ifv: 24, artillery: 12, aircraft: 4, helicopters: 4, ships: 6, drones: 8,
    stock: rs([0, 0, 0, 0, 0, 0, 0, 0, 0]),
    production: rs([0, 0, 0, 0, 0, 0, 0, 0, 0]),
    consumption: rs([0, 0, 0, 0, 0, 0, 0, 0, 0]),
    allies: BUND_ALLIES('MAR'), tradePartners: [],
    relations: { VAL: 80, KRN: -90, PAN: -40 },
    strengths: ['Gut verteidigte Küste und Häfen', 'Kurze Wege zwischen Raffinerie und Hafen', 'Kleine, aber hoch motivierte Armee'],
    weaknesses: ['Sehr wenig Land und Reserven', 'Ein Ölfeld liegt direkt an der umkämpften Grenze', 'Ohne Valdoria kaum zu halten'],
    difficulty: 'Leicht',
    blurb: 'Kleines Küstenkönigreich im Süden. Wenig Truppen, aber kurze Wege und ein starker Hafen.',
  },
  {
    a3: 'PAN', name: 'Großherzogtum Pannonien', short: 'Pannonien', capital: 'Pannburg', flag: '🟡', color: '#d3a13c',
    government: 'Hybrid', bloc: 'PAKT', leaderTitle: 'Großherzog',
    population: 5.0, gdp: 62, debtPct: 41, inflation: 4.8, zufriedenheit: 54,
    militaryBudget: 1.7, manpower: 17, tanks: 26, ifv: 40, artillery: 18, aircraft: 6, helicopters: 5, ships: 0, drones: 12,
    stock: rs([0, 0, 0, 0, 0, 0, 0, 0, 0]),
    production: rs([0, 0, 0, 0, 0, 0, 0, 0, 0]),
    consumption: rs([0, 0, 0, 0, 0, 0, 0, 0, 0]),
    allies: ['KRN'], tradePartners: [],
    relations: { KRN: 75, VAL: -65, MAR: -65 },
    strengths: ['Weite Ebene und ölreiches Tiefland', 'Schnelle Panzer- und Artillerieverbände', 'Starker Partner im Kronland-Pakt'],
    weaknesses: ['Schwach im Gebirge', 'Kein Meereszugang, kaum Häfen', 'Offene Flanke zu Valdoria im Westen'],
    difficulty: 'Mittel',
    blurb: 'Flaches Großherzogtum im Norden. Ölreiche Ebene und bewegliche Verbände, aber ohne Küste und Gebirgsschutz.',
  },
];

const BY_A3 = new Map(START_PROFILES.map((p) => [p.a3, p]));

export function getProfile(a3: string): StartProfile | undefined {
  return BY_A3.get(a3);
}

export function relationLabel(v: number): 'Feindlich' | 'Angespannt' | 'Neutral' | 'Freundlich' | 'Verbündet' {
  if (v <= -50) return 'Feindlich';
  if (v <= -15) return 'Angespannt';
  if (v < 25) return 'Neutral';
  if (v < 70) return 'Freundlich';
  return 'Verbündet';
}

/** CSS-Klassen-Suffix zu relationLabel (für Färbung). */
export function relationClass(v: number): string {
  if (v <= -50) return 'rel-hostile';
  if (v <= -15) return 'rel-tense';
  if (v < 25) return 'rel-neutral';
  if (v < 70) return 'rel-friendly';
  return 'rel-allied';
}

export function blocOf(a3: string): Bloc {
  const p = BY_A3.get(a3);
  if (p) return p.bloc;
  return 'NEUTRAL';
}

/** Beziehung von `from` zu `to` (-100..100): explizit, sonst symmetrisch, sonst aus Blockzugehörigkeit. */
export function getRelation(from: string, to: string): number {
  if (from === to) return 100;
  const a = BY_A3.get(from)?.relations[to];
  if (a !== undefined) return a;
  const b = BY_A3.get(to)?.relations[from];
  if (b !== undefined) return b;
  const ba = blocOf(from), bb = blocOf(to);
  if (ba === 'NEUTRAL' || bb === 'NEUTRAL') return 5;
  return ba === bb ? 45 : -45;
}

/**
 * Diplomatische Grundhaltung je Spielmodus (veränderbar, da Profile statisch sind):
 *  - 'campaign': Einzelspieler-Kampagne; Pannonien neutral (keine Bündnisse, kein Krieg), KRN gegen VAL+MAR.
 *  - 'teams': 2 gegen 2 (VAL+MAR gegen KRN+PAN); auch Standard für Pannonien im freien Spiel.
 *  - 'ffa': jeder gegen jeden, keine Bündnisse.
 * Muss VOR dem Aufbau von HUD/Renderer/Fog (affiliation-Cache, allies) aufgerufen werden. Der tatsächliche Kriegszustand
 * kommt aus War/scenario.ts, dies setzt nur Beziehungswerte, Bündnislisten und Blockzugehörigkeit.
 */
export type DiplomacyMode = 'campaign' | 'teams' | 'ffa';
export function applyDiplomacyMode(mode: DiplomacyMode): void {
  const set = (a3: string, allies: string[], bloc: Bloc, rel: Record<string, number>) => {
    const p = BY_A3.get(a3);
    if (!p) return;
    p.allies = allies;
    p.bloc = bloc;
    p.relations = rel;
  };
  if (mode === 'teams') {
    set('VAL', ['MAR'], 'BUND', { MAR: 80, KRN: -90, PAN: -65 });
    set('MAR', ['VAL'], 'BUND', { VAL: 80, KRN: -90, PAN: -65 });
    set('KRN', ['PAN'], 'PAKT', { VAL: -90, MAR: -90, PAN: 75 });
    set('PAN', ['KRN'], 'PAKT', { KRN: 75, VAL: -65, MAR: -65 });
  } else if (mode === 'ffa') {
    const all = ['VAL', 'KRN', 'MAR', 'PAN'];
    for (const a of all) set(a, [], 'NEUTRAL', Object.fromEntries(all.filter((b) => b !== a).map((b) => [b, -70])));
  } else {
    set('VAL', ['MAR'], 'BUND', { MAR: 80, KRN: -90, PAN: 5 });
    set('MAR', ['VAL'], 'BUND', { VAL: 80, KRN: -90, PAN: 5 });
    set('KRN', [], 'PAKT', { VAL: -90, MAR: -90, PAN: 10 });
    set('PAN', [], 'NEUTRAL', { KRN: 10, VAL: 5, MAR: 5 });
  }
}
