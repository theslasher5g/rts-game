/** Kampfgruppen des KI-Befehlshabers: Rollen, Zustände und kleine Helfer. */
import type { Unit } from '../units/types';

export type GroupRole = 'defense' | 'strike' | 'support' | 'raid' | 'air' | 'naval';
export type GroupState = 'idle' | 'assemble' | 'advance' | 'assault' | 'retreat' | 'regroup' | 'raid' | 'return' | 'alert';

export interface Objective {
  kind: 'field' | 'refinery' | 'hq' | 'point';
  x: number;
  z: number;
  /** Feld-ID bzw. Basis-ID */
  id: number;
  name: string;
  /** Plan gilt mindestens bis dahin (Spielzeit) */
  commitUntil: number;
  /** Eigentümer zu Planbeginn (um Erfolg zu erkennen) */
  ownerAtStart: string;
  /** Belagerung von Anlagen: Basis-HP bei Beobachtungsbeginn und Zeitpunkt (Fortschrittskontrolle) */
  hp?: number;
  hpAt?: number;
}

export interface BattleGroup {
  id: number;
  role: GroupRole;
  state: GroupState;
  ids: number[];
  obj: Objective | null;
  since: number;
  startStrength: number;
  wave: number;
  /** Raids: aktuelles Ziel (Unit-ID, 0 = Feld) */
  targetUnit: number;
  lastOrderAt: number;
  /** Letzte Feuermission */
  fireX: number;
  fireZ: number;
  fireAt: number;
  /** Fußtruppen marschieren mit (nur bei nahen Zielen, beim Start festgelegt) */
  footOk: boolean;
}

let nextGroupId = 1;

export function newGroup(role: GroupRole, state: GroupState, now: number): BattleGroup {
  return { id: nextGroupId++, role, state, ids: [], obj: null, since: now, startStrength: 0, wave: 0, targetUnit: 0, lastOrderAt: -99, fireX: 0, fireZ: 0, fireAt: -99, footOk: false };
}

export function setState(g: BattleGroup, s: GroupState, now: number): void {
  if (g.state !== s) { g.state = s; g.since = now; g.lastOrderAt = -99; }
}

/** Mittelpunkt (Fahrzeuge bevorzugt: langsame Fußtruppen verfälschen die Lage der Spitze nicht) */
export function centroid(units: readonly Unit[], out: [number, number]): boolean {
  if (!units.length) return false;
  let x = 0, z = 0, n = 0;
  for (const u of units) { if (isFoot(u)) continue; x += u.x; z += u.z; n++; }
  if (n === 0) { for (const u of units) { x += u.x; z += u.z; } n = units.length; }
  out[0] = x / n; out[1] = z / n;
  return true;
}

/** Infanterie/Fußtruppen (langsam, eigene Marschgruppe) */
export function isFoot(u: Unit): boolean {
  return u.type.category === 'infantry' || u.type.id === 'mortar_team';
}

/** Schnelle Kräfte für Überfälle */
export function isFast(u: Unit): boolean {
  return u.type.id === 'recon_wheeled' || u.type.id === 'apc_wheeled' || u.type.id === 'light_tank' || u.type.id === 'ifv';
}
