/**
 * Mehrspieler – Host-Seite der Zustandssynchronisation.
 *
 * Der Host simuliert alles; HostSync baut ~10x pro Sekunde (Echtzeit) einen kompakten Schnappschuss (siehe snapshot.ts) und sendet ihn
 * per transport.broadcastSnapshot(). Dazwischen werden nur geänderte Zeilen gesendet; alle ~3 s ein vollständiger Zustand (Verluste/
 * Spätstarter heilen damit selbst). Zusätzlich leitet HostSync alle Bus-Ereignisse aus NET_EVENTS per transport.broadcastEvent() weiter.
 */
import { bus } from '../core/EventBus';
import type { GameContext } from '../game/context';
import type { Reputation } from '../game/Reputation';
import type { BaseInfo } from '../logistics/types';
import { currentCommandScope } from './commands';
import {
  CITY_CONTROLS, CONVOY_STATES, NetSnapshot, SNAPSHOT_VERSION, encodeUnit, q, roundPayload, sameRow,
} from './snapshot';
import { NET_EVENTS, type NetTransport } from './transport';

export interface HostSyncOptions {
  /** Abstand der Schnappschüsse in ms (Standard 100) */
  intervalMs?: number;
  /** Abstand vollständiger Schnappschüsse in ms (Standard 3000) */
  fullEveryMs?: number;
  /** Ansehen der Nationen mitsenden */
  reputation?: Pick<Reputation, 'value'> | null;
  /** Diplomatiemodus (applyDiplomacyMode) für Gäste mitsenden */
  mode?: string;
  /** Begrenzung combat:fire / combat:impact je Intervall (Standard 100) */
  fxBudget?: number;
  /** Zeitquelle (Tests) */
  now?: () => number;
}

export interface HostSyncStats {
  sent: number;
  fullSent: number;
  lastBytes: number;
  lastFullBytes: number;
  maxBytes: number;
  eventsSent: number;
  eventsDropped: number;
}

/** Ereignisse, die nicht weitergereicht werden (Zustand kommt per Schnappschuss; oder würde Gast-Simulation doppeln) */
const NOT_FORWARDED = new Set(['building:damaged', 'civil:casualties', 'civil:infra', 'civil:aid']);

/**
 * Kumulatives Delta gegen den letzten VOLLEN Schnappschuss: ein Delta enthält alles, was seit dem Voll-Stand anders ist. Damit sind
 * Deltas idempotent und verlustfest (ein verworfener/ersetzter Zwischen-Schnappschuss kostet nichts); der Gast heilt spätestens
 * mit dem nächsten Voll-Schnappschuss.
 */
class DeltaSet<R extends ReadonlyArray<unknown>> {
  base = new Map<number, R>();
  cur = new Map<number, R>();
  add(id: number, row: R): void {
    this.cur.set(id, row);
  }
  /** rows = zu sendende Zeilen, gone = seit dem Voll-Stand verschwundene IDs (nur bei Delta) */
  finish(full: boolean): { rows: R[]; gone: number[] } {
    const rows: R[] = [];
    for (const [id, r] of this.cur) if (full || !sameRow(this.base.get(id), r)) rows.push(r);
    const gone: number[] = [];
    if (!full) for (const id of this.base.keys()) if (!this.cur.has(id)) gone.push(id);
    if (full) { this.base = this.cur; this.cur = new Map(); } else this.cur.clear();
    return { rows, gone };
  }
}

export class HostSync {
  readonly stats: HostSyncStats = { sent: 0, fullSent: 0, lastBytes: 0, lastFullBytes: 0, maxBytes: 0, eventsSent: 0, eventsDropped: 0 };
  /** Letzter gebauter Schnappschuss (Debug/Test) */
  last: NetSnapshot | null = null;

  private readonly ctx: GameContext;
  private readonly transport: NetTransport;
  private readonly interval: number;
  private readonly fullEvery: number;
  private readonly rep: Pick<Reputation, 'value'> | null;
  private readonly fxBudgetMax: number;
  private readonly mode: string | undefined;
  private readonly now: () => number;
  private readonly offs: Array<() => void> = [];

  private seq = 0;
  private lastTick = -1e9;
  private lastFull = -1e9;
  private fullCount = 0;
  private forceFullNext = true;

  private readonly owners: string[] = [];
  private readonly ownerIdx = new Map<string, number>();
  private readonly types: string[] = [];
  private readonly typeIdx = new Map<string, number>();

  private readonly dUnits = new DeltaSet<number[]>();
  private readonly dFields = new DeltaSet<number[]>();
  private readonly dBases = new DeltaSet<Array<number | string>>();
  private readonly dOrders = new DeltaSet<Array<number | string>>();
  private readonly dConvoys = new DeltaSet<number[]>();
  private readonly dStructs = new DeltaSet<Array<number | string>>();
  private readonly dCities = new DeltaSet<number[]>();
  private readonly dInfra = new DeltaSet<number[]>();
  private readonly dGarrison = new DeltaSet<number[]>();
  private readonly dBld = new DeltaSet<number[]>();
  private readonly structGeo = new Map<number, NonNullable<NetSnapshot['sn']>[number]>();
  private readonly structBase = new Set<number>();
  private readonly nameBase = new Set<number>();
  private readonly closedEdges = new Set<number>();
  private readonly bldAll = new Map<number, number>();
  private baseEdges = '';
  private baseWars = '';
  private baseRep = '';
  private fxLeft = 0;

  constructor(ctx: GameContext, transport: NetTransport, opts: HostSyncOptions = {}) {
    this.ctx = ctx;
    this.transport = transport;
    this.interval = opts.intervalMs ?? 100;
    this.fullEvery = opts.fullEveryMs ?? 3000;
    this.rep = opts.reputation ?? null;
    this.mode = opts.mode;
    this.fxBudgetMax = opts.fxBudget ?? 100;
    this.fxLeft = this.fxBudgetMax;
    this.now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));

    for (const a3 of ctx.economy.nations) this.own(a3);
    for (let i = 0; i < ctx.graph.edges.length; i++) if (!ctx.graph.edges[i].open) this.closedEdges.add(i);

    this.offs.push(
      bus.on('nav:edge', ({ edgeId, open }) => {
        if (open) this.closedEdges.delete(edgeId); else this.closedEdges.add(edgeId);
      }),
      bus.on('building:damaged', ({ id, integrity }) => {
        this.bldAll.set(id, integrity);
      }),
      transport.onPeersChanged(() => { this.forceFullNext = true; }),
    );
    for (const name of NET_EVENTS) {
      if (NOT_FORWARDED.has(name)) continue;
      this.offs.push(bus.on(name as never, ((payload: unknown) => this.forward(name, payload)) as never));
    }
  }

  dispose(): void {
    for (const f of this.offs.splice(0)) f();
  }

  /** Beim nächsten Tick einen vollständigen Schnappschuss senden */
  forceFull(): void {
    this.forceFullNext = true;
  }

  // ------------------------------------------------------------------ Ereignisse

  private forward(name: string, payload: unknown): void {
    if (name === 'combat:fire' || name === 'combat:impact') {
      if (this.fxLeft <= 0) { this.stats.eventsDropped++; return; }
      this.fxLeft--;
    }
    let out = payload;
    if (name === 'toast') {
      // Meldungen, die ein Befehl auslöst, gehen nur an dessen Absender; Host-eigene Fehlermeldungen bleiben privat.
      const sc = currentCommandScope();
      if (sc) {
        if (sc.a3 === null) return;
        out = { ...(payload as object), to: sc.a3 };
      }
    }
    this.stats.eventsSent++;
    this.transport.broadcastEvent(name, roundPayload(out));
  }

  // ------------------------------------------------------------------ Takt

  /** Jeden Frame aufrufen (Echtzeit-gesteuert). Gibt true zurück, wenn ein Schnappschuss gesendet wurde. */
  tick(): boolean {
    const t = this.now();
    if (t - this.lastTick < this.interval) return false;
    this.lastTick = t;
    this.fxLeft = this.fxBudgetMax;
    const full = this.forceFullNext || t - this.lastFull >= this.fullEvery;
    const snap = this.build(full);
    if (full) { this.lastFull = t; this.forceFullNext = false; this.fullCount++; }
    this.last = snap;
    const bytes = JSON.stringify(snap).length;
    this.stats.sent++;
    this.stats.lastBytes = bytes;
    if (bytes > this.stats.maxBytes) this.stats.maxBytes = bytes;
    if (full) { this.stats.fullSent++; this.stats.lastFullBytes = bytes; }
    this.transport.broadcastSnapshot(snap);
    return true;
  }

  private own(a3: string): number {
    let i = this.ownerIdx.get(a3);
    if (i === undefined) {
      i = this.owners.length;
      this.owners.push(a3);
      this.ownerIdx.set(a3, i);
    }
    return i;
  }

  private typeOf(id: string): number {
    let i = this.typeIdx.get(id);
    if (i === undefined) {
      i = this.types.length;
      this.types.push(id);
      this.typeIdx.set(id, i);
    }
    return i;
  }

  // ------------------------------------------------------------------ Schnappschuss

  /** Schnappschuss bauen (öffentlich für Tests) */
  build(full: boolean): NetSnapshot {
    const { ctx } = this;
    const snap: NetSnapshot = {
      k: 's', v: SNAPSHOT_VERSION, n: ++this.seq, ts: Date.now(), full: full ? 1 : 0, ow: [], g: [], oil: [], u: [],
    };
    const st = ctx.state;
    snap.g = [st.date.getTime(), st.speed, q(st.borderProtectSec ?? 0, 10), ctx.war.ceasefire ? 1 : 0, 0];

    // --- Krieg
    const pairs = typeof ctx.war.listPairs === 'function' ? ctx.war.listPairs().map(([a, b]) => `${a}|${b}`).sort().join(',') : '';
    if (full || pairs !== this.baseWars) snap.wars = pairs ? pairs.split(',') : [];
    if (full) this.baseWars = pairs;

    // --- Öl-Pools
    for (const a3 of ctx.economy.nations) {
      const p = ctx.economy.pool(a3);
      snap.oil.push([this.own(a3), Math.round(p.barrels * 10) / 10, q(p.incomePerHour, 100), q(p.spendPerHour, 100), Math.round(p.inTransit), Math.round(p.delivered ?? 0), p.lostConvoys ?? 0, Math.round(p.lostBarrels ?? 0)]);
    }
    if (this.rep) {
      const rows: number[][] = [];
      for (const a3 of ctx.economy.nations) rows.push([this.own(a3), q(this.rep.value(a3), 10)]);
      const key = JSON.stringify(rows);
      if (full || key !== this.baseRep) snap.rep = rows;
      if (full) this.baseRep = key;
    }

    this.buildUnits(snap, full);
    this.buildEconomy(snap, full);
    this.buildStructures(snap, full);
    this.buildCivil(snap, full);

    const ce = Array.from(this.closedEdges).sort((a, b) => a - b);
    const ceKey = ce.join(',');
    if (full || ceKey !== this.baseEdges) snap.ce = ce;
    if (full) this.baseEdges = ceKey;
    snap.ow = this.owners.slice();
    if (full) snap.tt = this.types.slice();
    if (full && this.mode) snap.dm = this.mode;
    return snap;
  }

  private buildUnits(snap: NetSnapshot, full: boolean): void {
    const { units } = this.ctx;
    const names: Array<[number, string]> = [];
    const withNames = full && this.fullCount % 3 === 0;
    const garrison = new Map<number, number>();
    const d = this.dUnits;
    for (const u of units.units) {
      if (u.hp <= 0) continue;
      d.add(u.id, encodeUnit(u, this.own(u.owner), this.typeOf(u.type.id)));
      if (withNames || !this.nameBase.has(u.id)) names.push([u.id, u.name]);
      if (u.garrisonId !== undefined) garrison.set(u.garrisonId, (garrison.get(u.garrisonId) ?? 0) + u.type.memberCount);
    }
    const r = d.finish(full);
    snap.u = r.rows;
    if (r.gone.length) snap.ud = r.gone;
    if (full) { this.nameBase.clear(); for (const id of d.base.keys()) this.nameBase.add(id); }
    // Delta: alle seit dem Voll-Stand neuen Einheiten (nicht in nameBase) tragen ihren Namen
    if (names.length) snap.nm = names;
    // Besatzungen (Gebäude)
    for (const [id, n] of garrison) this.dGarrison.add(id, [id, n]);
    const g = this.dGarrison.finish(full);
    const bg = g.rows.slice();
    for (const id of g.gone) bg.push([id, 0]);
    if (bg.length) snap.bg = bg;
  }

  private buildEconomy(snap: NetSnapshot, full: boolean): void {
    const { economy, production } = this.ctx;
    // Felder
    for (const f of economy.fields) {
      this.dFields.add(f.id, [f.id, f.owner ? this.own(f.owner) + 1 : 0, q(f.stored, 10), q(f.integrity, 1000), (f.cutOff ? 1 : 0) | (f.burning ? 2 : 0), q(f.captureProgress ?? 0, 1000), f.capturer ? this.own(f.capturer) + 1 : 0]);
    }
    const fl = this.dFields.finish(full);
    if (fl.rows.length) snap.fl = fl.rows;
    // Basen
    for (const b of economy.bases.values()) this.dBases.add(b.id, this.baseRow(b));
    const bs = this.dBases.finish(full);
    if (bs.rows.length) snap.bs = bs.rows;
    if (bs.gone.length) snap.bd = bs.gone;
    // Produktionsaufträge
    for (const o of production.orders.values()) {
      this.dOrders.add(o.id, [o.id, o.baseId, o.typeId, q(o.remainingHours, 1000), q(o.totalHours, 1000), o.rallyX !== undefined ? q(o.rallyX, 1000) : -1, o.rallyZ !== undefined ? q(o.rallyZ, 1000) : -1, Math.round(o.price ?? 0), this.own(o.owner ?? economy.bases.get(o.baseId)?.owner ?? '')]);
    }
    const po = this.dOrders.finish(full);
    if (po.rows.length) snap.po = po.rows;
    if (po.gone.length) snap.pd = po.gone;
    // Konvois
    for (const c of economy.convoys.values()) {
      this.dConvoys.add(c.id, [c.id, c.kind === 'oil' ? 0 : 1, this.own(c.owner), c.fromBaseId, c.toBaseId, Math.round(c.cargo), c.unitId, Math.max(0, CONVOY_STATES.indexOf((c.state ?? '') as (typeof CONVOY_STATES)[number])), c.fieldId ?? -1]);
    }
    const cv = this.dConvoys.finish(full);
    if (cv.rows.length) snap.cv = cv.rows;
    if (cv.gone.length) snap.cd = cv.gone;
  }

  private baseRow(b: BaseInfo): Array<number | string> {
    return [b.id, b.kind, this.own(b.owner), q(b.x, 1000), q(b.z, 1000), q(b.progress, 1000), q(b.hp, 10), Math.round(b.hpMax), q(b.radiusKm, 1000), b.name ?? ''];
  }

  private buildStructures(snap: NetSnapshot, full: boolean): void {
    const { structures } = this.ctx;
    const d = this.dStructs;
    const live = new Set<number>();
    for (const s of structures.structures.values()) {
      live.add(s.id);
      if (!this.structGeo.has(s.id)) {
        const ex = structures.exportRemote(s.id);
        if (ex) this.structGeo.set(s.id, [s.id, s.kind, this.own(s.owner), s.points.map((v) => Math.round(v * 1000) / 1000), q(ex.fx, 1000), q(ex.fz, 1000), ex.edgeId, Math.round(s.hpMax)]);
      }
      d.add(s.id, [s.id, s.kind, this.own(s.owner), q(s.progress, 1000), Math.round(s.hp), Math.round(s.hpMax)]);
    }
    const r = d.finish(full);
    for (const id of Array.from(this.structGeo.keys())) if (!live.has(id)) this.structGeo.delete(id);
    // Geometrie: alle, die der Gast nicht im Voll-Stand hatte (cumulativ), bzw. alle bei full
    const sn: NonNullable<NetSnapshot['sn']> = [];
    for (const row of r.rows) {
      const id = row[0] as number;
      const g = this.structGeo.get(id);
      if (g && (full || !this.structBase.has(id))) sn.push(g);
    }
    if (full) { this.structBase.clear(); for (const id of d.base.keys()) this.structBase.add(id); }
    if (sn.length) snap.sn = sn;
    if (r.rows.length) snap.st = r.rows;
    if (r.gone.length) snap.sd = r.gone;
  }

  private buildCivil(snap: NetSnapshot, full: boolean): void {
    const { civil } = this.ctx;
    if (civil && civil.cities) {
      for (const c of civil.cities) {
        this.dCities.add(c.id, [c.id, Math.round(c.population), Math.round(c.killed), Math.round(c.refugees), q(c.evacuated, 1000), c.evacuating ? 1 : 0, q(c.satisfaction, 10), q(c.unrest, 1000), this.own(c.controller), Math.max(0, CITY_CONTROLS.indexOf(c.control)), q(c.damage, 1000)]);
      }
      const ci = this.dCities.finish(full);
      if (ci.rows.length) snap.ci = ci.rows;
      for (const it of civil.infra) this.dInfra.add(it.id, [it.id, q(it.integrity, 1000)]);
      const inf = this.dInfra.finish(full);
      if (inf.rows.length) snap.inf = inf.rows;
    }
    // Gebäude-Integrität (beschädigte Gebäude)
    for (const [id, v] of this.bldAll) this.dBld.add(id, [id, q(v, 1000)]);
    const bl = this.dBld.finish(full);
    if (bl.rows.length) snap.bl = bl.rows;
  }
}
