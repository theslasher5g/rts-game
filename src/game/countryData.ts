/**
 * Startwerte der spielbaren Nationen (Phase 1).
 * Grob an realen Werten (≈ 2025) orientiert, für das Spiel vereinfacht/gerundet.
 *
 * Einheiten der Ressourcen (Lager / pro Tag):
 *   geld            Mrd $          (Staatseinnahmen/-ausgaben pro Tag, Lager = Reserven)
 *   oel             Tsd. Barrel
 *   gas             Mio. m³
 *   stahl           kt
 *   nahrung         kt
 *   munition        Tsd. Schuss/Granaten (abstrakt)
 *   seltene_erden   t
 *   industriegueter kt (abstrakt)
 *   konsumgueter    kt (abstrakt)
 */

export type Bloc = 'NATO' | 'CSTO' | 'NEUTRAL';
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
  tradePartners: string[];
  /** -100..100 zu wichtigen Staaten */
  relations: Record<string, number>;
  strengths: string[];
  weaknesses: string[];
  difficulty: 'Leicht' | 'Mittel' | 'Schwer';
}

/** Reihenfolge & Anzeigeinfos der Ressourcen (für UI). */
export const RESOURCE_INFO: ReadonlyArray<{ key: ResourceKey; name: string; short: string; unit: string; icon: string }> = [
  { key: 'geld', name: 'Geld', short: 'GELD', unit: 'Mrd $', icon: '$' },
  { key: 'oel', name: 'Öl', short: 'ÖL', unit: 'Tsd. bbl', icon: '⛽' },
  { key: 'gas', name: 'Gas', short: 'GAS', unit: 'Mio. m³', icon: '♨' },
  { key: 'stahl', name: 'Stahl', short: 'STAHL', unit: 'kt', icon: '⚒' },
  { key: 'nahrung', name: 'Nahrung', short: 'NAHR.', unit: 'kt', icon: '✿' },
  { key: 'munition', name: 'Munition', short: 'MUN.', unit: 'Tsd.', icon: '⁍' },
  { key: 'seltene_erden', name: 'Seltene Erden', short: 'S.ERDEN', unit: 't', icon: '◈' },
  { key: 'industriegueter', name: 'Industriegüter', short: 'IND.', unit: 'kt', icon: '⚙' },
  { key: 'konsumgueter', name: 'Konsumgüter', short: 'KONS.', unit: 'kt', icon: '▣' },
];

/** Namen für Staaten außerhalb des Kartenausschnitts (Beziehungen/Partner). */
export const EXTERNAL_NAMES: Record<string, string> = {
  USA: 'USA',
  CHN: 'China',
  IND: 'Indien',
  JPN: 'Japan',
  KOR: 'Südkorea',
  PRK: 'Nordkorea',
  CAN: 'Kanada',
  QAT: 'Katar',
  BRA: 'Brasilien',
};

/** [geld, oel, gas, stahl, nahrung, munition, seltene_erden, industriegueter, konsumgueter] */
type R9 = [number, number, number, number, number, number, number, number, number];
function rs(v: R9): ResourceStock {
  return {
    geld: v[0], oel: v[1], gas: v[2], stahl: v[3], nahrung: v[4],
    munition: v[5], seltene_erden: v[6], industriegueter: v[7], konsumgueter: v[8],
  };
}

const NATO_EU = ['DEU', 'FRA', 'GBR', 'POL', 'ITA', 'ESP', 'NLD', 'SWE', 'NOR', 'FIN', 'ROU', 'GRC', 'HUN', 'TUR'];
const natoAllies = (self: string) => ['USA', ...NATO_EU.filter((a) => a !== self)];

export const START_PROFILES: StartProfile[] = [
  {
    a3: 'DEU', name: 'Deutschland', flag: '🇩🇪', color: '#d9a826',
    government: 'Demokratie', bloc: 'NATO', leaderTitle: 'Bundeskanzler',
    population: 84, gdp: 4600, debtPct: 63, inflation: 2.2, zufriedenheit: 58,
    militaryBudget: 90, manpower: 182, tanks: 300, ifv: 700, artillery: 230, aircraft: 225, helicopters: 160, ships: 65, drones: 400,
    stock: rs([120, 180000, 22000, 3000, 9000, 1200, 800, 6000, 9000]),
    production: rs([5.2, 50, 15, 100, 140, 6, 0, 220, 260]),
    consumption: rs([5.5, 2100, 220, 95, 130, 4, 30, 180, 240]),
    allies: natoAllies('DEU'), tradePartners: ['USA', 'CHN', 'FRA', 'NLD', 'POL', 'ITA'],
    relations: { FRA: 80, POL: 60, GBR: 70, USA: 70, UKR: 65, TUR: 25, HUN: 20, CHN: 10, BLR: -55, RUS: -60 },
    strengths: ['Stärkste Industrie Europas', 'Hohe Finanzkraft', 'Hochwertige Rüstungsindustrie (Leopard, Rheinmetall)'],
    weaknesses: ['Abhängig von Energieimporten', 'Kleine, unterausgestattete Bundeswehr', 'Langsame Beschaffung'],
    difficulty: 'Mittel',
  },
  {
    a3: 'FRA', name: 'Frankreich', flag: '🇫🇷', color: '#3e6fd8',
    government: 'Demokratie', bloc: 'NATO', leaderTitle: 'Präsident',
    population: 68, gdp: 3200, debtPct: 112, inflation: 1.8, zufriedenheit: 45,
    militaryBudget: 65, manpower: 203, tanks: 220, ifv: 630, artillery: 160, aircraft: 290, helicopters: 300, ships: 180, drones: 300,
    stock: rs([90, 120000, 13000, 2000, 10000, 1500, 400, 4000, 6000]),
    production: rs([4.0, 15, 0.1, 30, 200, 5, 0, 140, 180]),
    consumption: rs([4.4, 1500, 110, 40, 150, 4, 18, 130, 170]),
    allies: natoAllies('FRA'), tradePartners: ['DEU', 'ITA', 'ESP', 'BEL', 'USA', 'GBR'],
    relations: { DEU: 80, GBR: 65, ITA: 60, USA: 60, UKR: 60, POL: 50, TUR: 10, CHN: 10, BLR: -50, RUS: -55 },
    strengths: ['Atommacht mit eigener Abschreckung', 'Starke Atomenergie', 'Kampferprobte Expeditionsstreitkräfte'],
    weaknesses: ['Hohe Staatsverschuldung', 'Soziale Unruhen', 'Geringe Munitionsvorräte'],
    difficulty: 'Mittel',
  },
  {
    a3: 'GBR', name: 'Vereinigtes Königreich', flag: '🇬🇧', color: '#c8333a',
    government: 'Demokratie', bloc: 'NATO', leaderTitle: 'Premierminister',
    population: 69, gdp: 3600, debtPct: 100, inflation: 3.0, zufriedenheit: 48,
    militaryBudget: 80, manpower: 140, tanks: 210, ifv: 600, artillery: 120, aircraft: 250, helicopters: 280, ships: 70, drones: 300,
    stock: rs([100, 90000, 2000, 1500, 7000, 1100, 300, 4500, 7000]),
    production: rs([4.6, 700, 90, 15, 120, 4, 0, 130, 190]),
    consumption: rs([5.0, 1450, 190, 25, 170, 3, 18, 140, 200]),
    allies: natoAllies('GBR'), tradePartners: ['USA', 'DEU', 'NLD', 'FRA', 'IRL', 'CHN'],
    relations: { USA: 85, FRA: 65, DEU: 70, POL: 65, UKR: 75, NOR: 70, TUR: 25, CHN: -10, BLR: -60, RUS: -70 },
    strengths: ['Atommacht', 'Starke Marine & Nachrichtendienste', 'Inselposition schützt vor Bodenangriffen'],
    weaknesses: ['Kleine Landstreitkräfte', 'Hoher Nahrungsimport', 'Schrumpfende Stahlindustrie'],
    difficulty: 'Mittel',
  },
  {
    a3: 'POL', name: 'Polen', flag: '🇵🇱', color: '#d84a6a',
    government: 'Demokratie', bloc: 'NATO', leaderTitle: 'Präsident',
    population: 37, gdp: 950, debtPct: 58, inflation: 4.0, zufriedenheit: 60,
    militaryBudget: 45, manpower: 200, tanks: 800, ifv: 1600, artillery: 600, aircraft: 100, helicopters: 80, ships: 40, drones: 350,
    stock: rs([40, 30000, 4000, 1200, 6000, 900, 50, 1500, 2500]),
    production: rs([1.2, 15, 11, 25, 110, 4, 0, 60, 80]),
    consumption: rs([1.3, 700, 55, 30, 90, 3, 5, 55, 75]),
    allies: natoAllies('POL'), tradePartners: ['DEU', 'CZE', 'FRA', 'GBR', 'ITA', 'NLD'],
    relations: { USA: 85, UKR: 60, GBR: 65, DEU: 55, FRA: 50, FIN: 60, HUN: 10, TUR: 30, BLR: -75, RUS: -85 },
    strengths: ['Rasch wachsende, moderne Armee', 'Höchste Verteidigungsquote der NATO', 'Starke Landwirtschaft'],
    weaknesses: ['Frontstaat zu Russland/Belarus', 'Kohleabhängige Energie', 'Begrenzte Luft- und Seemacht'],
    difficulty: 'Mittel',
  },
  {
    a3: 'RUS', name: 'Russland', flag: '🇷🇺', color: '#a3302a',
    government: 'Autoritär', bloc: 'CSTO', leaderTitle: 'Präsident',
    population: 144, gdp: 2100, debtPct: 20, inflation: 9.0, zufriedenheit: 52,
    militaryBudget: 150, manpower: 1300, tanks: 2500, ifv: 5000, artillery: 4500, aircraft: 1200, helicopters: 900, ships: 230, drones: 4000,
    stock: rs([450, 400000, 900000, 8000, 25000, 9000, 1500, 7000, 5000]),
    production: rs([3.5, 10000, 1700, 200, 400, 30, 8, 180, 160]),
    consumption: rs([4.0, 3500, 1300, 120, 360, 32, 6, 170, 190]),
    allies: ['BLR', 'ARM', 'KAZ', 'PRK'], tradePartners: ['CHN', 'IND', 'TUR', 'BLR', 'KAZ'],
    relations: { BLR: 90, CHN: 70, IRN: 60, TUR: 15, HUN: 5, DEU: -60, FRA: -55, GBR: -70, POL: -85, UKR: -95, USA: -75 },
    strengths: ['Riesige Rohstoff- und Energiereserven', 'Größtes Atomwaffenarsenal', 'Enorme Personalreserven & Kriegswirtschaft'],
    weaknesses: ['Sanktionen & technologische Rückstände', 'Hohe Verluste an Material', 'Inflation & Fachkräftemangel'],
    difficulty: 'Leicht',
  },
  {
    a3: 'UKR', name: 'Ukraine', flag: '🇺🇦', color: '#3a8ad8',
    government: 'Demokratie', bloc: 'NEUTRAL', leaderTitle: 'Präsident',
    population: 33, gdp: 190, debtPct: 95, inflation: 12, zufriedenheit: 55,
    militaryBudget: 40, manpower: 900, tanks: 1000, ifv: 2500, artillery: 1800, aircraft: 90, helicopters: 50, ships: 10, drones: 12000,
    stock: rs([25, 8000, 9000, 900, 9000, 1500, 30, 400, 800]),
    production: rs([0.4, 50, 50, 20, 250, 8, 0.5, 20, 25]),
    consumption: rs([0.9, 230, 55, 15, 90, 15, 1, 30, 40]),
    allies: ['POL', 'GBR', 'USA'], tradePartners: ['POL', 'DEU', 'TUR', 'ROU', 'ITA', 'CHN'],
    relations: { POL: 60, GBR: 75, DEU: 65, FRA: 60, USA: 60, ROU: 50, TUR: 35, HUN: -20, BLR: -70, RUS: -95 },
    strengths: ['Kampferprobteste Armee Europas', 'Weltspitze bei Drohnenkrieg', 'Riesige Agrarproduktion'],
    weaknesses: ['Abhängig von westlicher Hilfe', 'Zerstörte Infrastruktur', 'Hohe Staatsdefizite'],
    difficulty: 'Schwer',
  },
  {
    a3: 'TUR', name: 'Türkei', flag: '🇹🇷', color: '#e0503a',
    government: 'Hybrid', bloc: 'NATO', leaderTitle: 'Präsident',
    population: 86, gdp: 1350, debtPct: 30, inflation: 35, zufriedenheit: 47,
    militaryBudget: 30, manpower: 355, tanks: 2200, ifv: 3500, artillery: 1800, aircraft: 300, helicopters: 400, ships: 180, drones: 1500,
    stock: rs([140, 30000, 5000, 2500, 10000, 2000, 100, 2500, 4000]),
    production: rs([1.6, 80, 2, 100, 230, 7, 0.5, 100, 140]),
    consumption: rs([1.8, 1000, 140, 90, 210, 5, 6, 90, 130]),
    allies: ['USA', 'GBR', 'AZE'], tradePartners: ['DEU', 'RUS', 'CHN', 'ITA', 'GBR', 'IRQ'],
    relations: { AZE: 90, GBR: 25, DEU: 25, UKR: 35, RUS: 15, USA: 20, ITA: 30, HUN: 35, FRA: 10, GRC: -30, CYP: -60 },
    strengths: ['Zweitgrößte Armee der NATO', 'Kontrolle über Bosporus & Dardanellen', 'Starke Drohnenindustrie (Bayraktar)'],
    weaknesses: ['Sehr hohe Inflation', 'Energieimporte nötig', 'Spannungen mit Griechenland'],
    difficulty: 'Mittel',
  },
  {
    a3: 'ITA', name: 'Italien', flag: '🇮🇹', color: '#3aa05a',
    government: 'Demokratie', bloc: 'NATO', leaderTitle: 'Ministerpräsident',
    population: 59, gdp: 2350, debtPct: 137, inflation: 1.6, zufriedenheit: 46,
    militaryBudget: 38, manpower: 165, tanks: 200, ifv: 1000, artillery: 200, aircraft: 230, helicopters: 380, ships: 160, drones: 200,
    stock: rs([80, 80000, 17000, 1800, 8000, 900, 200, 3500, 6000]),
    production: rs([3.0, 90, 8, 60, 150, 3, 0, 150, 190]),
    consumption: rs([3.3, 1200, 170, 70, 160, 2.5, 12, 140, 180]),
    allies: natoAllies('ITA'), tradePartners: ['DEU', 'FRA', 'USA', 'ESP', 'CHN', 'CHE'],
    relations: { FRA: 60, DEU: 65, ESP: 65, USA: 70, GRC: 55, UKR: 55, TUR: 30, HUN: 30, BLR: -45, RUS: -45 },
    strengths: ['Starke Mittelmeermarine', 'Breite Industrie- und Rüstungsbasis', 'Zentrale Lage im Mittelmeer'],
    weaknesses: ['Extrem hohe Staatsverschuldung', 'Gas- und Ölimporte', 'Alternde Bevölkerung'],
    difficulty: 'Mittel',
  },
  {
    a3: 'ESP', name: 'Spanien', flag: '🇪🇸', color: '#e0b030',
    government: 'Demokratie', bloc: 'NATO', leaderTitle: 'Ministerpräsident',
    population: 49, gdp: 1750, debtPct: 102, inflation: 2.5, zufriedenheit: 52,
    militaryBudget: 25, manpower: 120, tanks: 330, ifv: 1100, artillery: 250, aircraft: 170, helicopters: 200, ships: 140, drones: 120,
    stock: rs([60, 60000, 3500, 1200, 9000, 700, 80, 2200, 4000]),
    production: rs([2.0, 1, 0.1, 35, 180, 2, 0, 80, 120]),
    consumption: rs([2.2, 1250, 90, 38, 140, 1.5, 7, 85, 125]),
    allies: natoAllies('ESP'), tradePartners: ['FRA', 'DEU', 'PRT', 'ITA', 'USA', 'MAR'],
    relations: { PRT: 85, FRA: 65, ITA: 65, DEU: 60, USA: 55, GBR: 40, MAR: 20, TUR: 25, BLR: -40, RUS: -40 },
    strengths: ['Weit entfernt von der Ostfront', 'Große LNG-Importkapazität', 'Starke Landwirtschaft'],
    weaknesses: ['Niedrige Verteidigungsausgaben', 'Fast keine eigenen Energierohstoffe', 'Hohe Jugendarbeitslosigkeit'],
    difficulty: 'Leicht',
  },
  {
    a3: 'NLD', name: 'Niederlande', flag: '🇳🇱', color: '#e07a26',
    government: 'Demokratie', bloc: 'NATO', leaderTitle: 'Ministerpräsident',
    population: 18, gdp: 1200, debtPct: 44, inflation: 3.2, zufriedenheit: 60,
    militaryBudget: 25, manpower: 34, tanks: 50, ifv: 300, artillery: 60, aircraft: 50, helicopters: 70, ships: 50, drones: 100,
    stock: rs([50, 120000, 9000, 400, 4000, 250, 60, 1500, 2500]),
    production: rs([1.5, 20, 40, 18, 160, 1, 0, 60, 70]),
    consumption: rs([1.6, 900, 90, 12, 50, 0.8, 4, 50, 60]),
    allies: natoAllies('NLD'), tradePartners: ['DEU', 'BEL', 'FRA', 'GBR', 'USA', 'CHN'],
    relations: { DEU: 80, GBR: 75, FRA: 65, USA: 70, UKR: 65, POL: 55, TUR: 20, HUN: 0, BLR: -50, RUS: -60 },
    strengths: ['Rotterdam – größter Hafen Europas', 'Hochtechnologie (ASML)', 'Agrarexport-Weltmacht'],
    weaknesses: ['Sehr kleine Streitkräfte', 'Kein strategischer Tiefenraum', 'Hohe Importabhängigkeit bei Öl'],
    difficulty: 'Schwer',
  },
  {
    a3: 'SWE', name: 'Schweden', flag: '🇸🇪', color: '#2f8fd0',
    government: 'Demokratie', bloc: 'NATO', leaderTitle: 'Ministerpräsident',
    population: 10.6, gdp: 640, debtPct: 33, inflation: 2.0, zufriedenheit: 64,
    militaryBudget: 15, manpower: 25, tanks: 120, ifv: 450, artillery: 50, aircraft: 95, helicopters: 50, ships: 60, drones: 120,
    stock: rs([55, 25000, 50, 500, 3000, 400, 60, 1100, 1500]),
    production: rs([0.75, 0, 0, 13, 40, 2.5, 0.3, 45, 40]),
    consumption: rs([0.78, 300, 2, 9, 35, 1.5, 2, 35, 35]),
    allies: natoAllies('SWE'), tradePartners: ['NOR', 'DEU', 'FIN', 'DNK', 'USA', 'GBR'],
    relations: { FIN: 90, NOR: 85, DEU: 70, GBR: 70, USA: 65, UKR: 70, POL: 60, TUR: 0, BLR: -50, RUS: -70 },
    strengths: ['Eigene Kampfjets (Gripen) & U-Boote', 'Gesunde Staatsfinanzen', 'Eisenerz & Stahl'],
    weaknesses: ['Kleine aktive Armee', 'Lange Ostseeküste zu verteidigen', 'Ölimporte nötig'],
    difficulty: 'Mittel',
  },
  {
    a3: 'NOR', name: 'Norwegen', flag: '🇳🇴', color: '#b83a4a',
    government: 'Demokratie', bloc: 'NATO', leaderTitle: 'Ministerpräsident',
    population: 5.6, gdp: 520, debtPct: 40, inflation: 3.0, zufriedenheit: 72,
    militaryBudget: 10, manpower: 25, tanks: 50, ifv: 150, artillery: 40, aircraft: 50, helicopters: 40, ships: 50, drones: 60,
    stock: rs([300, 50000, 5000, 200, 1500, 200, 20, 600, 900]),
    production: rs([0.75, 1900, 330, 2, 15, 1, 0, 20, 20]),
    consumption: rs([0.65, 200, 15, 3, 20, 0.6, 1, 22, 24]),
    allies: natoAllies('NOR'), tradePartners: ['GBR', 'DEU', 'NLD', 'SWE', 'FRA', 'USA'],
    relations: { SWE: 85, FIN: 80, GBR: 75, USA: 70, DEU: 70, DNK: 85, UKR: 65, TUR: 10, BLR: -45, RUS: -55 },
    strengths: ['Europas Öl- und Gaslieferant', 'Riesiger Staatsfonds', 'Höchste Zufriedenheit'],
    weaknesses: ['Sehr kleine Bevölkerung', 'Grenze zu Russland im hohen Norden', 'Nahrungsimporte'],
    difficulty: 'Leicht',
  },
  {
    a3: 'FIN', name: 'Finnland', flag: '🇫🇮', color: '#d8e0f0',
    government: 'Demokratie', bloc: 'NATO', leaderTitle: 'Präsident',
    population: 5.6, gdp: 310, debtPct: 82, inflation: 1.5, zufriedenheit: 63,
    militaryBudget: 7.5, manpower: 24, tanks: 200, ifv: 700, artillery: 700, aircraft: 62, helicopters: 20, ships: 30, drones: 100,
    stock: rs([25, 20000, 300, 400, 2500, 600, 20, 600, 700]),
    production: rs([0.4, 0, 0, 11, 18, 2, 0.2, 25, 20]),
    consumption: rs([0.42, 200, 6, 7, 18, 1, 1, 20, 20]),
    allies: natoAllies('FIN'), tradePartners: ['SWE', 'DEU', 'USA', 'NLD', 'CHN', 'NOR'],
    relations: { SWE: 90, NOR: 80, EST: 85, DEU: 65, USA: 70, POL: 60, UKR: 70, TUR: 0, BLR: -55, RUS: -75 },
    strengths: ['Große ausgebildete Reserve (280 Tsd.)', 'Stärkste Artillerie Westeuropas', 'Gesellschaftliche Wehrbereitschaft'],
    weaknesses: ['1.340 km Grenze zu Russland', 'Kleine Volkswirtschaft', 'Abhängig von Energieimporten'],
    difficulty: 'Schwer',
  },
  {
    a3: 'ROU', name: 'Rumänien', flag: '🇷🇴', color: '#d0c030',
    government: 'Demokratie', bloc: 'NATO', leaderTitle: 'Präsident',
    population: 19, gdp: 380, debtPct: 55, inflation: 6.5, zufriedenheit: 44,
    militaryBudget: 9, manpower: 70, tanks: 380, ifv: 500, artillery: 600, aircraft: 50, helicopters: 70, ships: 30, drones: 80,
    stock: rs([20, 15000, 3500, 400, 5000, 400, 20, 500, 700]),
    production: rs([0.4, 70, 25, 9, 90, 1.5, 0, 22, 25]),
    consumption: rs([0.46, 230, 30, 9, 60, 1, 1, 22, 28]),
    allies: natoAllies('ROU'), tradePartners: ['DEU', 'ITA', 'HUN', 'FRA', 'POL', 'TUR'],
    relations: { MDA: 85, USA: 75, POL: 60, FRA: 60, UKR: 50, DEU: 55, TUR: 35, HUN: 10, BLR: -50, RUS: -65 },
    strengths: ['Eigene Gasförderung im Schwarzen Meer', 'Agrarüberschüsse', 'Wichtige NATO-Basis am Schwarzen Meer'],
    weaknesses: ['Veraltetes Material', 'Hohes Haushaltsdefizit', 'Politische Instabilität'],
    difficulty: 'Schwer',
  },
  {
    a3: 'GRC', name: 'Griechenland', flag: '🇬🇷', color: '#4aa8e0',
    government: 'Demokratie', bloc: 'NATO', leaderTitle: 'Ministerpräsident',
    population: 10.3, gdp: 260, debtPct: 150, inflation: 2.7, zufriedenheit: 41,
    militaryBudget: 8.5, manpower: 130, tanks: 1200, ifv: 1500, artillery: 700, aircraft: 230, helicopters: 140, ships: 120, drones: 60,
    stock: rs([15, 15000, 800, 200, 3000, 600, 10, 300, 500]),
    production: rs([0.25, 3, 0, 3, 35, 1, 0, 8, 12]),
    consumption: rs([0.27, 300, 15, 4, 30, 1, 0.5, 12, 15]),
    allies: natoAllies('GRC').filter((a) => a !== 'TUR'), tradePartners: ['ITA', 'DEU', 'CYP', 'BGR', 'TUR', 'CHN'],
    relations: { CYP: 95, FRA: 75, USA: 70, ITA: 55, DEU: 45, UKR: 45, BLR: -30, RUS: -35, TUR: -30 },
    strengths: ['Große Panzer- und Luftwaffe für die Größe', 'Inselketten in der Ägäis', 'Moderne Rafale/F-35-Beschaffung'],
    weaknesses: ['Höchste Staatsverschuldung Europas', 'Rivalität mit der Türkei', 'Kaum Industrie'],
    difficulty: 'Mittel',
  },
  {
    a3: 'BLR', name: 'Belarus', flag: '🇧🇾', color: '#8a3a5a',
    government: 'Autoritär', bloc: 'CSTO', leaderTitle: 'Präsident',
    population: 9.1, gdp: 75, debtPct: 40, inflation: 6.0, zufriedenheit: 40,
    militaryBudget: 1.5, manpower: 48, tanks: 500, ifv: 1000, artillery: 500, aircraft: 70, helicopters: 50, ships: 0, drones: 100,
    stock: rs([8, 8000, 3000, 400, 3500, 500, 5, 300, 300]),
    production: rs([0.08, 30, 0.5, 7, 35, 1, 0, 10, 10]),
    consumption: rs([0.09, 450, 50, 4, 28, 0.8, 0.5, 9, 10]),
    allies: ['RUS', 'KAZ', 'ARM'], tradePartners: ['RUS', 'CHN', 'KAZ', 'UKR', 'TUR'],
    relations: { RUS: 90, CHN: 50, KAZ: 40, TUR: 0, HUN: -10, DEU: -55, LTU: -70, POL: -75, UKR: -70, USA: -60 },
    strengths: ['Russisches Atomschild', 'Strategische Lage am Suwałki-Korridor', 'Landwirtschaft & Schwerindustrie'],
    weaknesses: ['Völlige Abhängigkeit von Russland', 'Sanktionen & Isolation', 'Kleines Militärbudget'],
    difficulty: 'Schwer',
  },
  {
    a3: 'HUN', name: 'Ungarn', flag: '🇭🇺', color: '#5a9a3a',
    government: 'Hybrid', bloc: 'NATO', leaderTitle: 'Ministerpräsident',
    population: 9.6, gdp: 220, debtPct: 74, inflation: 4.5, zufriedenheit: 50,
    militaryBudget: 5, manpower: 33, tanks: 100, ifv: 250, artillery: 60, aircraft: 30, helicopters: 40, ships: 0, drones: 50,
    stock: rs([12, 9000, 6000, 200, 3500, 200, 10, 400, 500]),
    production: rs([0.22, 15, 4, 3, 50, 0.6, 0, 18, 18]),
    consumption: rs([0.24, 170, 25, 4, 30, 0.4, 1, 16, 18]),
    allies: natoAllies('HUN'), tradePartners: ['DEU', 'AUT', 'SVK', 'ROU', 'CHN', 'RUS'],
    relations: { SRB: 60, TUR: 35, SVK: 40, DEU: 25, CHN: 40, RUS: 5, POL: 10, ROU: 10, UKR: -20, BLR: -10 },
    strengths: ['Gute Beziehungen in beide Lager', 'Autoindustrie & Batteriefabriken', 'Agrarüberschüsse'],
    weaknesses: ['Abhängig von russischer Energie', 'Konflikt mit der EU', 'Sehr kleine Streitkräfte'],
    difficulty: 'Mittel',
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

/** NATO-Mitglieder im Kartenausschnitt (für Standardbeziehungen nicht spielbarer Staaten). */
const NATO_ALL = new Set([...NATO_EU, 'USA', 'CAN', 'BEL', 'DNK', 'PRT', 'CZE', 'SVK', 'SVN', 'HRV', 'BGR', 'EST', 'LVA', 'LTU', 'LUX', 'ALB', 'MNE', 'MKD', 'ISL']);
const CSTO_ALL = new Set(['RUS', 'BLR', 'KAZ', 'ARM']);

export function blocOf(a3: string): Bloc {
  const p = BY_A3.get(a3);
  if (p) return p.bloc;
  if (NATO_ALL.has(a3)) return 'NATO';
  if (CSTO_ALL.has(a3)) return 'CSTO';
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
