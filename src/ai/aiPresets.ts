/**
 * Phase 6 – Feinabstimmung des KI-Befehlshabers je Schwierigkeit (alle Zeiten in Spielstunden, Strecken in km).
 * Fairness: keine Gratis-Einheiten. 'schwer' sieht alles und denkt schnell, 'leicht' ist langsam und passiv.
 */
import type { Difficulty } from '../game/context';

export type AIStyle = 'aggressor' | 'defender';

export interface AIPreset {
  /** Ein voller Denkzyklus (alle Teilsysteme je einmal) in Spielstunden; Teilsysteme sind auf 3 Takte verteilt */
  thinkHours: number;
  /** Max. Befehlsaufrufe pro Takt */
  maxOrders: number;
  /** Wahrscheinlichkeit, einen Gruppen-Takt zu verschlafen (0..1) */
  skipChance: number;
  /** Sichtweite eigener Einheiten/Anlagen (km); seeAll = Aufklärung ohne Grenzen */
  visionKm: number;
  seeAll: boolean;
  /** Tankwagen-Konvois sind immer bekannt (milder Cheat) */
  seeTankers: boolean;
  /** Wie lange zuletzt gesehene Feindpositionen gelten */
  memoryHours: number;
  /** Mindestdauer, die ein Plan/Ziel gehalten wird (Anti-Oszillation) */
  commitHours: number;
  // --- Angriffswellen
  firstWaveHours: number;
  waveMin: number;
  waveMax: number;
  /** Zeit bis zur nächsten Welle nach Ende der letzten */
  waveCooldown: number;
  /** Mindest-Stärkeverhältnis (eigen/Feind am Ziel) für den Start */
  minRatio: number;
  /** Rückzug, wenn Gruppenstärke unter diesen Anteil der Startstärke fällt */
  retreatFrac: number;
  /** Rückzug, wenn Feind lokal stärker als eigene Gruppe * dieser Faktor */
  retreatEnemyRatio: number;
  /** Anteil der Bodentruppen, der daheim bleibt */
  defenseFrac: number;
  minDefenders: number;
  // --- Überfälle & Sabotage
  raidGroups: number;
  raidStartHours: number;
  raidCooldown: number;
  raidMinUnits: number;
  sabotage: boolean;
  sabotageStartHours: number;
  sabotageCooldown: number;
  /** max. Marschzeit der Pioniere zur Brücke */
  sabotageMaxEta: number;
  // --- Fähigkeiten
  fireMissions: boolean;
  airSorties: boolean;
  repairBridges: boolean;
  guardBridges: boolean;
  counters: boolean;
  /** Anzahl Pioniertrupps, die gehalten werden */
  engineers: number;
  // --- Wirtschaft
  reserveBarrels: number;
  /** ab diesem Guthaben werden Front-/Zusatzbasen gebaut */
  richBarrels: number;
  /** Obergrenze kampfstarker Einheiten (Performance) */
  unitCap: number;
  /** Produktionszyklus des EconomyAI (Spielstunden) */
  produceCycle: number;
  /** milder Öl-Bonus (Faktor, 1 = keiner); nur wirksam, wenn OilEconomy einen Hook bietet */
  incomeBonus: number;
}

export const AI_PRESETS: Record<Difficulty, AIPreset> = {
  leicht: {
    thinkHours: 1.0, maxOrders: 6, skipChance: 0.3, visionKm: 4, seeAll: false, seeTankers: false, memoryHours: 0.5, commitHours: 3,
    firstWaveHours: 10, waveMin: 4, waveMax: 6, waveCooldown: 10, minRatio: 1.3, retreatFrac: 0.6, retreatEnemyRatio: 1.0,
    defenseFrac: 0.5, minDefenders: 4,
    raidGroups: 0, raidStartHours: 99, raidCooldown: 99, raidMinUnits: 99,
    sabotage: false, sabotageStartHours: 99, sabotageCooldown: 99, sabotageMaxEta: 0,
    fireMissions: false, airSorties: false, repairBridges: true, guardBridges: false, counters: false, engineers: 1,
    reserveBarrels: 200, richBarrels: 700, unitCap: 45, produceCycle: 2.0, incomeBonus: 1,
  },
  mittel: {
    thinkHours: 0.5, maxOrders: 12, skipChance: 0.08, visionKm: 8, seeAll: false, seeTankers: true, memoryHours: 1.5, commitHours: 2,
    firstWaveHours: 5, waveMin: 8, waveMax: 12, waveCooldown: 6, minRatio: 1.0, retreatFrac: 0.45, retreatEnemyRatio: 1.3,
    defenseFrac: 0.35, minDefenders: 4,
    raidGroups: 1, raidStartHours: 3, raidCooldown: 4, raidMinUnits: 2,
    sabotage: true, sabotageStartHours: 6, sabotageCooldown: 10, sabotageMaxEta: 14,
    fireMissions: true, airSorties: true, repairBridges: true, guardBridges: false, counters: false, engineers: 2,
    reserveBarrels: 140, richBarrels: 450, unitCap: 70, produceCycle: 1.0, incomeBonus: 1,
  },
  schwer: {
    thinkHours: 0.25, maxOrders: 24, skipChance: 0, visionKm: 12, seeAll: true, seeTankers: true, memoryHours: 3, commitHours: 2,
    firstWaveHours: 3, waveMin: 10, waveMax: 16, waveCooldown: 3.5, minRatio: 0.85, retreatFrac: 0.3, retreatEnemyRatio: 1.8,
    defenseFrac: 0.25, minDefenders: 3,
    raidGroups: 2, raidStartHours: 1.5, raidCooldown: 2.5, raidMinUnits: 3,
    sabotage: true, sabotageStartHours: 2, sabotageCooldown: 6, sabotageMaxEta: 22,
    fireMissions: true, airSorties: true, repairBridges: true, guardBridges: true, counters: true, engineers: 3,
    reserveBarrels: 100, richBarrels: 320, unitCap: 100, produceCycle: 0.5, incomeBonus: 1.15,
  },
};

/** Defensiver Stil (z. B. verbündetes Marenia): Gegenangriffe nur im Umfeld eigener/verbündeter Anlagen */
export const DEFENDER_RANGE_KM = 55;
export const ALLY_HELP_RANGE_KM = 90;
