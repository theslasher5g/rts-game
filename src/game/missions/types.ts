/**
 * Phase 6 – Missionen: datengetriebene Definitionen (Ziele, Start-Overrides, Wellen) und Laufzeitzustand.
 * Zeiten in Spielstunden. Alle Texte deutsch.
 */
import type { BaseKind } from '../../logistics/types';
import type { Difficulty } from '../context';

export type AiDifficulty = Difficulty;
export type ObjectiveRole = 'primary' | 'secondary';
export type ObjectiveStatus = 'pending' | 'active' | 'done' | 'failed';

/** Gebiet: Mittelpunkt (Selektor oder feste km-Position) + Radius */
export interface AreaSel {
  at: 'midpoint' | 'ownHq' | 'enemyHq' | 'ownCapital' | 'enemyCapital' | 'contested' | { x: number; z: number };
  radiusKm: number;
}

/** Stadt-Selektor: Hauptstadt, umkämpfte Stadt (nächste fremde Stadt zur Frontmitte) oder Name */
export type CitySel = 'ownCapital' | 'enemyCapital' | 'contested' | (string & {});

interface ObjBase {
  id: string;
  text: string;
  /** Standard: 'primary' */
  role?: ObjectiveRole;
  /** Bedingung, die dauerhaft gelten muss: erst bei Verletzung 'failed' (Hauptziel => Niederlage), nie 'done' */
  constraint?: boolean;
  /** wird erst aktiv, wenn diese Ziele erledigt sind (bis dahin ausgeblendet) */
  after?: string[];
  /** wird erst nach dieser Spielzeit (h) aktiv */
  startHours?: number;
  /** nicht erledigt bis zu dieser Zeit (h seit Missionsbeginn) => failed */
  timeLimitHours?: number;
}

export type ObjectiveDef = ObjBase &
  (
    | { kind: 'holdCity'; city: CitySel; hours: number }
    | { kind: 'keepCity'; city: CitySel }
    | { kind: 'captureFields'; from: 'any' | 'enemy' | 'contested'; count: number; holdHours?: number }
    | { kind: 'destroyBase'; base: 'refinery' | 'hq' }
    | { kind: 'keepBase'; base: 'hq' | 'refinery' }
    | { kind: 'deliverBarrels'; total: number }
    | { kind: 'deliverLoads'; count: number }
    | { kind: 'balance'; barrels: number }
    | { kind: 'income'; perHour: number }
    /** Feindeinkommen unter belowPct (0..1) des beobachteten Spitzenwerts bzw. unter belowAbs Fässer/h, N Stunden am Stück */
    | { kind: 'cutIncome'; belowPct?: number; belowAbs?: number; hours: number }
    | { kind: 'destroyConvoys'; count: number }
    | { kind: 'blowBridges'; count: number; area?: AreaSel }
    | { kind: 'repairBridges'; count: number }
    | { kind: 'killUnits'; count: number; category?: string; typeIds?: string[] }
    | { kind: 'surviveUntil'; hours: number }
    | { kind: 'maxLosses'; count: number }
    | { kind: 'reachArea'; area: AreaSel; category?: string; typeIds?: string[]; count?: number }
    | { kind: 'buildBase'; base: BaseKind; count?: number }
    | { kind: 'buildStructures'; count: number; kinds?: string[] }
    | { kind: 'all'; children: ObjectiveDef[] }
    | { kind: 'any'; children: ObjectiveDef[] }
  );

export type ObjectiveKind = ObjectiveDef['kind'];

/** Start-Overrides, die MissionSystem.load() selbst anwendet (nach spawnStartingForces + economy.loadScenario) */
export interface StartOverride {
  /** Startguthaben des Spielers in Fässern */
  barrels?: number;
  extraUnits?: Array<{ typeId: string; count: number; near: 'hq' | 'spawn' | `field:${number}` }>;
  /** 0.5..1.5: Anteil der feindlichen Kampfeinheiten (<1 entfernt, >1 verdoppelt anteilig) */
  enemyStrength?: number;
  /** kleine feindliche Vorposten an den (nicht eigenen) Ölfeldern */
  spawnEnemyNearFields?: boolean;
}

/** Angriffswelle (vom MissionSystem gespawnt und per Angriffsbefehl auf das Ziel gehetzt) */
export interface WaveDef {
  atHours: number;
  units: Array<[typeId: string, count: number]>;
  /** Ziel des Angriffs (Standard 'ownHq') */
  target?: 'ownCapital' | 'ownHq' | 'ownRefinery' | 'contested' | 'midpoint';
  /** Entfernung des Spawnpunkts vom Ziel in Richtung Feind (km), Standard 60 */
  distKm?: number;
  /** Meldung (Toast) beim Spawn */
  label?: string;
}

export interface AiSettings {
  difficulty: AiDifficulty;
  /** KI greift nicht an (lead: AICommander.paused) */
  hold?: boolean;
  /** …bis diese Zeit (h) bzw. bis dieses Ziel erledigt ist */
  holdUntilHours?: number;
  holdUntilObjective?: string;
}

export type LoseWhen = 'hq_and_refinery' | 'hq' | 'refinery' | 'either';

export interface MissionDef {
  id: string;
  name: string;
  /** Kurzbeschreibung für die Missionsauswahl */
  blurb: string;
  /** 4–6 Zeilen: Lage, Auftrag, Hinweis */
  briefing: string[];
  playerNation: string;
  /** Feindnationen (Ziele „Gegner" beziehen sich auf alle) */
  enemies: string[];
  startOverride?: StartOverride;
  ai: AiSettings;
  objectives: ObjectiveDef[];
  waves?: WaveDef[];
  timeLimitHours?: number;
  /** Standard 'hq_and_refinery' */
  loseWhen?: LoseWhen;
  /** Niederlage, wenn alle Kampfeinheiten verloren und keine Produktion möglich (Standard true) */
  loseWhenNoForces?: boolean;
  /** Mission 1: geführtes Tutorial starten (Lead: Tutorial.start()) */
  tutorial?: boolean;
  /** Freies Spiel (keine Kampagne): nichts wird freigeschaltet */
  skirmish?: boolean;
}

export interface ObjectiveState {
  id: string;
  text: string;
  role: ObjectiveRole;
  status: ObjectiveStatus;
  constraint: boolean;
  /** 0..1 */
  progress: number;
  /** z. B. „1,5 / 3 h" oder „2 / 3 Felder" */
  detail: string;
  /** sichtbar in der UI (false = noch nicht freigeschaltet) */
  visible: boolean;
  /** Elternziel (all/any) oder '' */
  parentId: string;
}

export interface MissionReport {
  missionId: string;
  result: 'running' | 'victory' | 'defeat';
  reason: string;
  elapsedHours: number;
  unitsLost: number;
  unitsKilled: number;
  barrelsDelivered: number;
  fieldsHeld: number;
  fieldsTotal: number;
  convoysLost: number;
  convoysRaided: number;
  bridgesBlown: number;
  civilKilled: number;
  /** optional: Kriegsverbrechen (Lead setzt MissionSystem.warCrimes) */
  warCrimes: number | null;
}
