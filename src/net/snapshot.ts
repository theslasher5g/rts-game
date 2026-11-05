/**
 * Mehrspieler – Schnappschuss-Format (Host -> Gäste, ~10 Hz) und gemeinsame Tabellen/Hilfen.
 *
 * Alles ist JSON-fähig. Zahlen sind quantisiert (Position 1 m = Faktor 1000, Winkel 1 mrad, Anteile 1/1000), Einheiten werden als
 * kompakte Zahlenzeilen übertragen; zwischen den vollständigen Schnappschüssen (alle ~3 s, `full: 1`) senden Host-Deltas nur
 * geänderte Zeilen. Der Gast identifiziert Besitzer über die Tabelle `ow` und Einheitentypen über `tt` (nur in `full`).
 */
import type { Order, OrderKind, Unit } from '../units/types';

export const SNAPSHOT_VERSION = 1;

/** Quantisierung */
export const Q_POS = 1000;
export const Q_ANG = 1000;

export const ORDER_KINDS: Array<OrderKind | ''> = ['', 'move', 'attackMove', 'reverse', 'hold', 'defend', 'retreat', 'patrol', 'stop', 'attack', 'fireAt', 'garrison', 'build', 'demolish', 'repair'];
export const POSTURES = ['stand', 'crouch', 'prone'] as const;
export const CITY_CONTROLS = ['normal', 'evacuating', 'evacuated', 'occupied', 'unrest', 'ruined'] as const;
export const CONVOY_STATES = ['', 'idle', 'toField', 'loading', 'toBase', 'waiting', 'recall'] as const;

/** Spaltenindizes einer Einheitenzeile */
export const U = {
  ID: 0, TYPE: 1, OWNER: 2, X: 3, Z: 4, HEADING: 5, SPEED: 6, HP: 7, AMMO: 8, FUEL: 9, MORALE: 10, SUPP: 11, FLAGS: 12,
  TARGET: 13, ORDER: 14, OX: 15, OZ: 16, GARRISON: 17, MEMBERS: 18, FIREX: 19, FIREZ: 20,
  LEN: 21,
} as const;

/** Bits in der Spalte FLAGS: Bit 0-1 Haltung, 2 airborne, 3 onRoad, 4 engaged, 5 hold, 6 pinned, 7 hat Feuerziel (FIREX/FIREZ gültig) */
export const F_AIR = 4, F_ROAD = 8, F_ENGAGED = 16, F_HOLD = 32, F_PINNED = 64, F_FIREAT = 128;

export interface NetSnapshot {
  k: 's';
  v: number;
  /** laufende Nummer (ältere werden verworfen) */
  n: number;
  /** Host-Zeit (ms, Date.now()) */
  ts: number;
  /** 1 = vollständiger Zustand (Gast darf daraus Entferntes ableiten) */
  full: 0 | 1;
  /** Besitzer-Tabelle (a3) */
  ow: string[];
  /** Einheitentypen-Tabelle (nur bei full) */
  tt?: string[];
  /** [Datum ms, Geschwindigkeitsstufe, Grenzschutz s ×10, Waffenstillstand 0/1, Fortschrittsmarke Spielende 0/1] */
  g: number[];
  /** Diplomatiemodus ('teams' | 'ffa' | 'campaign'), nur bei full */
  dm?: string;
  /** Kriegspaare "A|B" (bei full oder Änderung) */
  wars?: string[];
  /** je Nation: [ownerIdx, Fässer, Einnahmen ×100, Ausgaben ×100, unterwegs, geliefert, Konvoiverluste, Fässerverluste] */
  oil: number[][];
  /** Ansehen: [ownerIdx, Wert ×10] */
  rep?: number[][];
  /** Einheiten (nur geänderte bzw. alle bei full) */
  u: number[][];
  /** entfernte Einheiten-IDs seit dem letzten Schnappschuss */
  ud?: number[];
  /** Namen neuer Einheiten [id, name] */
  nm?: Array<[number, string]>;
  /** Ölfelder: [id, ownerIdx+1, gelagert ×10, Integrität ×1000, flags(1 abgeschnitten, 2 brennt), Eroberung ×1000, Eroberer ownerIdx+1] */
  fl?: number[][];
  /** Basen: [id, kind, ownerIdx, x, z, progress ×1000, hp ×10, hpMax, radius ×1000, name] */
  bs?: Array<Array<number | string>>;
  bd?: number[];
  /** Produktionsaufträge: [id, baseId, typeId, rest ×1000, gesamt ×1000, rallyX|-1, rallyZ|-1, price, ownerIdx] */
  po?: Array<Array<number | string>>;
  pd?: number[];
  /** Konvois: [id, kind(0 oil,1 supply), ownerIdx, from, to, cargo, unitId, stateIdx, fieldId] */
  cv?: number[][];
  cd?: number[];
  /** Bauwerke: [id, kind, ownerIdx, progress ×1000, hp, hpMax] */
  st?: Array<Array<number | string>>;
  /** neue Bauwerke (Geometrie): [id, kind, ownerIdx, points[], fx ×1000, fz ×1000, edgeId, hpMax] */
  sn?: Array<[number, string, number, number[], number, number, number, number]>;
  sd?: number[];
  /** gesperrte Navigationskanten (komplette Liste, bei full oder Änderung) */
  ce?: number[];
  /** Städte: [id, Einwohner, Tote, Flüchtlinge, evakuiert ×1000, evakuiert-Flag, Zufriedenheit ×10, Unruhe ×1000, controllerIdx, controlIdx, Schaden ×1000] */
  ci?: number[][];
  /** zivile Infrastruktur: [id, Integrität ×1000] */
  inf?: number[][];
  /** beschädigte Gebäude: [id, Integrität ×1000] (Deltas oder bei full alle beschädigten) */
  bl?: number[][];
  /** Besatzungszahlen je Gebäude: [id, n] */
  bg?: number[][];
}

export function q(v: number, f: number): number {
  return Math.round(v * f);
}

/** Zahlen in einer Ereignisnutzlast kürzen (3 Nachkommastellen); Tiefe begrenzt. */
export function roundPayload(p: unknown, depth = 0): unknown {
  if (typeof p === 'number') return Number.isInteger(p) ? p : Math.round(p * 1000) / 1000;
  if (p === null || typeof p !== 'object' || depth > 4) return p;
  if (Array.isArray(p)) return p.map((v) => roundPayload(v, depth + 1));
  if (ArrayBuffer.isView(p)) return Array.from(p as unknown as ArrayLike<number>, (v) => roundPayload(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p as Record<string, unknown>)) out[k] = roundPayload(v, depth + 1);
  return out;
}

/** Array-Zeilen elementweise vergleichen (true = gleich) */
export function sameRow(a: ReadonlyArray<unknown> | undefined, b: ReadonlyArray<unknown>): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Einheit -> Zeile. owners/types liefern die Tabellenindizes (vergeben bei Bedarf). */
export function encodeUnit(u: Unit, ownerIdx: number, typeIdx: number): number[] {
  const o: Order | undefined = u.orders[0];
  let ok = 0;
  if (o) {
    ok = ORDER_KINDS.indexOf(o.kind);
    if (ok < 0) ok = 0;
  }
  const post = u.posture ? Math.max(0, POSTURES.indexOf(u.posture)) : 0;
  let flags = post;
  if (u.airborne) flags |= F_AIR;
  if (u.onRoad) flags |= F_ROAD;
  if (u.engaged) flags |= F_ENGAGED;
  if (u.stance === 'hold') flags |= F_HOLD;
  if (u.pinned) flags |= F_PINNED;
  const hasFire = u.fireX !== undefined && u.fireZ !== undefined;
  if (hasFire) flags |= F_FIREAT;
  const tid = o && o.targetId !== undefined ? o.targetId : u.targetId ?? 0;
  const row = new Array<number>(U.LEN);
  row[U.ID] = u.id;
  row[U.TYPE] = typeIdx;
  row[U.OWNER] = ownerIdx;
  row[U.X] = q(u.x, Q_POS);
  row[U.Z] = q(u.z, Q_POS);
  row[U.HEADING] = q(u.heading, Q_ANG);
  row[U.SPEED] = q(u.speedKmh, 10);
  row[U.HP] = q(u.hp, 10);
  row[U.AMMO] = Math.round(u.ammo);
  row[U.FUEL] = Number.isFinite(u.fuel) ? Math.round(u.fuel) : -1;
  row[U.MORALE] = q(u.morale, 100);
  row[U.SUPP] = q(u.suppression ?? 0, 100);
  row[U.FLAGS] = flags;
  row[U.TARGET] = tid;
  row[U.ORDER] = ok;
  row[U.OX] = o ? q(o.x, Q_POS) : 0;
  row[U.OZ] = o ? q(o.z, Q_POS) : 0;
  row[U.GARRISON] = u.garrisonId !== undefined ? u.garrisonId + 1 : 0;
  row[U.MEMBERS] = u.membersAlive ?? 0;
  row[U.FIREX] = hasFire ? q(u.fireX!, Q_POS) : 0;
  row[U.FIREZ] = hasFire ? q(u.fireZ!, Q_POS) : 0;
  return row;
}

/** true, wenn sich eine Zeile außer reinen Positions-Rauschen-Feldern geändert hat (für Delta-Auswahl: exakter Vergleich) */
export function unitRowChanged(prev: number[] | undefined, next: number[]): boolean {
  return !sameRow(prev, next);
}

/** Geschätzte Größe in Bytes (JSON) */
export function snapshotBytes(s: NetSnapshot): number {
  return JSON.stringify(s).length;
}
