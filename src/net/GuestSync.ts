/**
 * Mehrspieler – Gast-Seite: wendet Host-Schnappschüsse auf die Spiegel-Systeme an und interpoliert Einheiten zwischen Schnappschüssen.
 *
 * Der Gast simuliert nichts (siehe NetGame): Einheiten werden mit den Host-IDs angelegt (UnitManager.spawnRemote), Wirtschaft,
 * Produktion, Bauwerke, Zivilzustand, Gebäudeschäden, Kriegszustand und Datum/Tempo werden in place überschrieben. Weitergereichte
 * Host-Ereignisse (Kampfeffekte, Meldungen ...) werden lokal auf dem Bus ausgelöst. Alles ist idempotent (verlorene/doppelte
 * Schnappschüsse sind harmlos; der nächste vollständige Schnappschuss heilt).
 */
import { bus } from '../core/EventBus';
import type { GameEvents } from '../core/types';
import type { StructureKind } from '../combat/types';
import { SPEED_HOURS_PER_SEC } from '../game/GameState';
import type { GameContext } from '../game/context';
import type { Reputation } from '../game/Reputation';
import { applyDiplomacyMode, type DiplomacyMode } from '../game/countryData';
import type { BaseKind, ConvoyInfo, OilFieldInfo } from '../logistics/types';
import type { Order, Unit } from '../units/types';
import {
  CITY_CONTROLS, CONVOY_STATES, F_AIR, F_ENGAGED, F_FIREAT, F_HOLD, F_PINNED, F_ROAD, NetSnapshot, ORDER_KINDS, POSTURES, Q_ANG, Q_POS, SNAPSHOT_VERSION, U,
} from './snapshot';
import type { NetTransport } from './transport';

export interface GuestSyncOptions {
  selfA3: string;
  reputation?: Pick<Reputation, 'setRemoteValue'> | null;
  /** Zeitquelle in ms (Tests) */
  now?: () => number;
}

export interface GuestSyncStats {
  received: number;
  applied: number;
  ignored: number;
  fullApplied: number;
  lastSeq: number;
  events: number;
}

/** Verlängerung (Extrapolation) bei ausbleibenden Schnappschüssen: maximal 1 s, danach halten */
const EXTRAP_MAX_S = 1;
/** Glättung zur autoritativen Position (1/s): Rest-Abstand fällt mit exp(-SMOOTH t) */
const SMOOTH = 14;
/** Ab diesem Abstand (km) wird gesprungen statt geglättet */
const SNAP_KM = 0.4;
/** Meldung "Verbindung steht, aber keine Daten" nach so vielen ms */
const STALL_MS = 3000;

/** Ereignisse, die nur den Zustand des Gastes ändern (kein erneutes Auslösen auf dem Bus nötig) */
const APPLY_ONLY = new Set(['nav:edge', 'war:declared', 'building:damaged']);

interface RemoteState {
  ax: number;
  az: number;
  ah: number;
  /** km/h */
  sp: number;
  /** Ankunftszeit (ms) */
  t: number;
  /** Spielstunden je Echtzeitsekunde bei Ankunft */
  hps: number;
  snap: boolean;
}

function wrapAngle(a: number): number {
  const T = Math.PI * 2;
  a = (a + Math.PI) % T;
  if (a < 0) a += T;
  return a - Math.PI;
}

export class GuestSync {
  readonly stats: GuestSyncStats = { received: 0, applied: 0, ignored: 0, fullApplied: 0, lastSeq: 0, events: 0 };
  /** true = Verbindung zum Host abgebrochen */
  disconnected = false;

  private readonly ctx: GameContext;
  private readonly transport: NetTransport;
  private readonly selfA3: string;
  private readonly rep: Pick<Reputation, 'setRemoteValue'> | null;
  private readonly now: () => number;
  private readonly offs: Array<() => void> = [];

  private readonly rs = new Map<number, RemoteState>();
  private types: string[] = [];
  private haveFull = false;
  private dm = '';
  private lastSeq = 0;
  private lastArrival = 0;
  private hps = 0;
  private fieldById: Map<number, OilFieldInfo> | null = null;
  private lastClosed = new Set<number>();
  private stallShown = false;
  private readonly seenTmp = new Set<number>();
  /** IDs werden nie wiederverwendet: einmal entfernte Einheiten nicht durch verspätete Schnappschüsse wiederbeleben */
  private readonly dead = new Set<number>();

  constructor(ctx: GameContext, transport: NetTransport, opts: GuestSyncOptions) {
    this.ctx = ctx;
    this.transport = transport;
    this.selfA3 = opts.selfA3;
    this.rep = opts.reputation ?? null;
    this.now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.lastArrival = this.now();
    this.offs.push(
      transport.onSnapshot((s) => this.onSnapshot(s)),
      transport.onEvent((n, p) => this.onEvent(n, p)),
      transport.onDisconnect((reason) => this.onDisconnect(reason)),
    );
  }

  dispose(): void {
    for (const f of this.offs.splice(0)) f();
  }

  // ------------------------------------------------------------------ Kennzahlen

  /** ms seit dem letzten empfangenen Schnappschuss */
  get snapshotAgeMs(): number {
    return this.now() - this.lastArrival;
  }

  /** RTT zum Host in ms (aus der Peer-Liste des Transports; 0 = unbekannt) */
  get rttMs(): number {
    const self = this.transport.peers.find((p) => p.id === this.transport.selfId);
    return self?.pingMs ?? 0;
  }

  /** true = Verbindung steht, aber seit > 3 s kein Schnappschuss */
  get stalled(): boolean {
    return !this.disconnected && this.haveFull && this.snapshotAgeMs > STALL_MS;
  }

  get synced(): boolean {
    return this.haveFull;
  }

  // ------------------------------------------------------------------ Frame (Interpolation)

  /** Jeden Frame VOR units.update() aufrufen: Einheiten zur (extrapolierten) Host-Position führen. Allokationsfrei. */
  frame(dtReal: number): void {
    const now = this.now();
    const k = 1 - Math.exp(-Math.max(0, Math.min(0.25, dtReal)) * SMOOTH);
    const units = this.ctx.units.units;
    const rs = this.rs;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      const r = rs.get(u.id);
      if (!r) continue;
      let age = (now - r.t) / 1000;
      if (age > EXTRAP_MAX_S) age = EXTRAP_MAX_S;
      else if (age < 0) age = 0;
      const adv = r.sp * r.hps * age;
      const tx = adv > 0 ? r.ax + Math.sin(r.ah) * adv : r.ax;
      const tz = adv > 0 ? r.az - Math.cos(r.ah) * adv : r.az;
      const dx = tx - u.x, dz = tz - u.z;
      if (r.snap || dx * dx + dz * dz > SNAP_KM * SNAP_KM) {
        u.x = tx;
        u.z = tz;
        u.heading = r.ah;
        r.snap = false;
      } else {
        u.x += dx * k;
        u.z += dz * k;
        u.heading = wrapAngle(u.heading + wrapAngle(r.ah - u.heading) * k);
      }
    }
    // Hinweis bei Stillstand der Daten (einmalig)
    if (this.stalled && !this.stallShown) {
      this.stallShown = true;
      bus.emit('toast', { msg: 'Keine Daten vom Host – Verbindung instabil …', kind: 'warn' });
    } else if (!this.stalled && this.stallShown) {
      this.stallShown = false;
    }
  }

  // ------------------------------------------------------------------ Verbindung

  private onDisconnect(reason: string): void {
    if (this.disconnected) return;
    this.disconnected = true;
    bus.emit('net:state', { role: 'guest', connected: false, reason: 'Host getrennt' });
    bus.emit('toast', { msg: `Host getrennt${reason ? ` (${reason})` : ''}`, kind: 'error' });
  }

  // ------------------------------------------------------------------ Schnappschuss anwenden

  private onSnapshot(raw: unknown): void {
    this.stats.received++;
    const s = raw as NetSnapshot | null;
    if (!s || s.k !== 's' || s.v !== SNAPSHOT_VERSION || !Array.isArray(s.u) || !Array.isArray(s.g)) { this.stats.ignored++; return; }
    // Neustart des Hosts (Seriennummer springt zurück) zulassen
    if (s.n <= this.lastSeq && !(s.full && s.n < 3)) { this.stats.ignored++; return; }
    if (!this.haveFull && !s.full) { this.stats.ignored++; return; }
    try {
      this.apply(s);
    } catch (e) {
      console.error('GuestSync: Schnappschuss fehlerhaft', e);
      this.stats.ignored++;
      return;
    }
    this.lastSeq = s.n;
    this.stats.lastSeq = s.n;
    this.stats.applied++;
    this.lastArrival = this.now();
    if (s.full) { this.haveFull = true; this.stats.fullApplied++; }
  }

  private apply(s: NetSnapshot): void {
    const ctx = this.ctx;
    const ow = s.ow;
    const t = this.now();
    if (s.tt) this.types = s.tt;
    const own = (i: number): string => ow[i] ?? '';

    // --- Spielzustand
    const st = ctx.state;
    st.date.setTime(s.g[0]);
    st.setSpeedRemote(s.g[1]);
    st.borderProtectSec = s.g[2] / 10;
    ctx.war.ceasefire = s.g[3] === 1;
    this.hps = SPEED_HOURS_PER_SEC[Math.min(5, Math.max(0, Math.round(s.g[1])))] ?? 0;

    if (s.dm && s.dm !== this.dm) { this.dm = s.dm; applyDiplomacyMode(s.dm as DiplomacyMode); }
    if (s.wars) this.applyWars(s.wars);

    for (const r of s.oil) {
      const a3 = own(r[0]);
      if (!a3) continue;
      const p = ctx.economy.pool(a3);
      p.barrels = r[1]; p.incomePerHour = r[2] / 100; p.spendPerHour = r[3] / 100; p.inTransit = r[4];
      p.delivered = r[5]; p.lostConvoys = r[6]; p.lostBarrels = r[7];
      if (a3 === this.selfA3) st.setOil({ barrels: p.barrels, incomePerHour: p.incomePerHour, spendPerHour: p.spendPerHour, inTransit: p.inTransit });
    }
    if (s.rep && this.rep) for (const r of s.rep) { const a3 = own(r[0]); if (a3) this.rep.setRemoteValue(a3, r[1] / 10); }

    this.applyUnits(s, t, own);
    this.applyEconomy(s, own);
    this.applyStructures(s, own);
    this.applyCivil(s, own);

    if (s.ce) this.applyEdges(s.ce);
    if (s.bl) {
      for (const [id, v] of s.bl) {
        if (!ctx.cities.hasBuilding(id)) continue;
        const iv = v / 1000;
        if (Math.abs(ctx.cities.getBuilding(id).integrity - iv) > 1e-6) ctx.cities.setIntegrity(id, iv);
      }
    }
    if (s.bg) for (const [id, n] of s.bg) ctx.cities.setGarrison(id, n);
  }

  private applyWars(list: string[]): void {
    const war = this.ctx.war;
    const want = new Set<string>(list);
    for (const k of want) {
      const [a, b] = k.split('|');
      if (a && b) war.declare(a, b);
    }
    if (typeof war.listPairs === 'function') {
      for (const [a, b] of war.listPairs()) if (!want.has(`${a}|${b}`) && !want.has(`${b}|${a}`)) war.makePeace(a, b);
    }
  }

  private applyUnits(s: NetSnapshot, t: number, own: (i: number) => string): void {
    const units = this.ctx.units;
    const names = new Map<number, string>();
    if (s.nm) for (const [id, n] of s.nm) names.set(id, n);
    const seen = this.seenTmp;
    if (s.full) seen.clear();
    for (const row of s.u) {
      const id = row[U.ID];
      if (s.full) seen.add(id);
      let u = units.get(id);
      const x = row[U.X] / Q_POS, z = row[U.Z] / Q_POS, h = row[U.HEADING] / Q_ANG;
      if (!u) {
        if (this.dead.has(id)) continue;
        const typeId = this.types[row[U.TYPE]];
        if (!typeId) continue;
        const nu = units.spawnRemote(id, typeId, own(row[U.OWNER]), x, z, h, names.get(id));
        if (!nu) continue;
        u = nu;
      } else if (names.has(id)) {
        u.name = names.get(id)!;
      }
      let r = this.rs.get(id);
      if (!r) this.rs.set(id, (r = { ax: x, az: z, ah: h, sp: 0, t, hps: this.hps, snap: true }));
      r.ax = x; r.az = z; r.ah = h; r.sp = row[U.SPEED] / 10; r.t = t; r.hps = this.hps;
      this.applyUnitFields(u, row, r);
    }
    if (s.ud) for (const id of s.ud) this.dropUnit(id);
    if (s.full) {
      const gone: number[] = [];
      for (const u of units.units) if (!seen.has(u.id)) gone.push(u.id);
      for (const id of gone) this.dropUnit(id);
    }
  }

  private dropUnit(id: number): void {
    this.dead.add(id);
    this.rs.delete(id);
    this.ctx.units.removeRemote(id);
  }

  private applyUnitFields(u: Unit, row: number[], r: RemoteState): void {
    u.speedKmh = r.sp;
    u.hp = row[U.HP] / 10;
    u.ammo = row[U.AMMO];
    u.fuel = row[U.FUEL] < 0 ? Infinity : row[U.FUEL];
    u.morale = row[U.MORALE] / 100;
    u.suppression = row[U.SUPP] / 100;
    const f = row[U.FLAGS];
    u.posture = POSTURES[f & 3] ?? 'stand';
    u.airborne = (f & F_AIR) !== 0;
    u.onRoad = (f & F_ROAD) !== 0;
    u.engaged = (f & F_ENGAGED) !== 0;
    u.stance = (f & F_HOLD) !== 0 ? 'hold' : 'free';
    u.pinned = (f & F_PINNED) !== 0;
    u.targetId = row[U.TARGET];
    u.routePending = false;
    const g = row[U.GARRISON];
    if (g > 0) {
      u.garrisonId = g - 1;
      r.snap = true;
    } else u.garrisonId = undefined;
    const m = row[U.MEMBERS];
    u.membersAlive = m > 0 ? m : undefined;
    if ((f & F_FIREAT) !== 0) { u.fireX = row[U.FIREX] / Q_POS; u.fireZ = row[U.FIREZ] / Q_POS; } else { u.fireX = undefined; u.fireZ = undefined; }
    // Befehl zur Anzeige (Zielmarker, Panel): ein einziger, in place gepflegter Eintrag
    const ok = row[U.ORDER];
    if (ok === 0) {
      if (u.orders.length) u.orders.length = 0;
    } else {
      let o: Order | undefined = u.orders[0];
      if (!o) u.orders.push((o = { kind: 'move', x: 0, z: 0 }));
      if (u.orders.length > 1) u.orders.length = 1;
      o.kind = ORDER_KINDS[ok] as Order['kind'];
      o.x = row[U.OX] / Q_POS;
      o.z = row[U.OZ] / Q_POS;
      const tid = row[U.TARGET];
      o.targetId = tid > 0 ? tid : undefined;
    }
  }

  private applyEconomy(s: NetSnapshot, own: (i: number) => string): void {
    const { economy, production } = this.ctx;
    if (s.fl) {
      if (!this.fieldById) this.fieldById = new Map(economy.fields.map((f) => [f.id, f]));
      for (const r of s.fl) {
        const f = this.fieldById.get(r[0]);
        if (!f) continue;
        f.owner = r[1] > 0 ? own(r[1] - 1) : '';
        f.stored = r[2] / 10;
        f.integrity = r[3] / 1000;
        f.cutOff = (r[4] & 1) !== 0;
        f.burning = (r[4] & 2) !== 0;
        f.captureProgress = r[5] / 1000;
        f.capturer = r[6] > 0 ? own(r[6] - 1) : '';
      }
    }
    if (s.bs) {
      const seen = s.full ? new Set<number>() : null;
      for (const r of s.bs) {
        const id = r[0] as number;
        seen?.add(id);
        let b = economy.bases.get(id);
        const kind = r[1] as BaseKind;
        if (!b) {
          b = { id, kind, owner: '', x: 0, z: 0, progress: 0, hp: 0, hpMax: 1, radiusKm: 0.4 };
          economy.bases.set(id, b);
        }
        b.kind = kind;
        b.owner = own(r[2] as number);
        b.x = (r[3] as number) / 1000; b.z = (r[4] as number) / 1000;
        b.progress = (r[5] as number) / 1000;
        b.hp = (r[6] as number) / 10; b.hpMax = r[7] as number;
        b.radiusKm = (r[8] as number) / 1000;
        if (r[9]) b.name = r[9] as string;
      }
      if (seen) for (const id of Array.from(economy.bases.keys())) if (!seen.has(id)) economy.removeBaseRemote(id);
    } else if (s.full) {
      for (const id of Array.from(economy.bases.keys())) economy.removeBaseRemote(id);
    }
    if (s.bd) for (const id of s.bd) economy.removeBaseRemote(id);

    if (s.po || s.full) {
      const seen = new Set<number>();
      for (const r of s.po ?? []) {
        const id = r[0] as number;
        seen.add(id);
        let o = production.orders.get(id);
        if (!o) { o = { id, baseId: 0, typeId: '', remainingHours: 0, totalHours: 0 }; production.orders.set(id, o); }
        o.baseId = r[1] as number; o.typeId = r[2] as string;
        o.remainingHours = (r[3] as number) / 1000; o.totalHours = (r[4] as number) / 1000;
        const rx = r[5] as number, rz = r[6] as number;
        o.rallyX = rx >= 0 ? rx / 1000 : undefined; o.rallyZ = rz >= 0 ? rz / 1000 : undefined;
        o.price = r[7] as number; o.owner = own(r[8] as number);
      }
      if (s.full) for (const id of Array.from(production.orders.keys())) if (!seen.has(id)) production.orders.delete(id);
    }
    if (s.pd) for (const id of s.pd) production.orders.delete(id);

    if (s.cv || s.full) {
      const seen = new Set<number>();
      for (const r of s.cv ?? []) {
        seen.add(r[0]);
        let c: ConvoyInfo | undefined = economy.convoys.get(r[0]);
        if (!c) { c = { id: r[0], kind: 'oil', owner: '', fromBaseId: 0, toBaseId: 0, cargo: 0, unitId: 0 }; economy.convoys.set(r[0], c); }
        c.kind = r[1] === 0 ? 'oil' : 'supply'; c.owner = own(r[2]); c.fromBaseId = r[3]; c.toBaseId = r[4]; c.cargo = r[5]; c.unitId = r[6];
        c.state = (CONVOY_STATES[r[7]] || undefined) as ConvoyInfo['state'];
        c.fieldId = r[8] >= 0 ? r[8] : undefined;
      }
      if (s.full) for (const id of Array.from(economy.convoys.keys())) if (!seen.has(id)) economy.convoys.delete(id);
    }
    if (s.cd) for (const id of s.cd) economy.convoys.delete(id);
  }

  private applyStructures(s: NetSnapshot, own: (i: number) => string): void {
    const sm = this.ctx.structures;
    if (s.sn) {
      for (const [id, kind, owner, points, fx, fz, edge, hpMax] of s.sn) {
        if (sm.structures.has(id)) continue;
        sm.addRemote({ id, kind: kind as StructureKind, owner: own(owner), points, progress: 0, hp: 1, hpMax }, fx / 1000, fz / 1000, edge);
      }
    }
    const seen = s.full ? new Set<number>() : null;
    if (s.st) {
      for (const r of s.st) {
        const id = r[0] as number;
        seen?.add(id);
        sm.updateRemote(id, (r[3] as number) / 1000, r[4] as number, r[5] as number);
      }
    }
    if (s.sd) for (const id of s.sd) sm.removeRemote(id);
    if (seen) for (const id of Array.from(sm.structures.keys())) if (!seen.has(id)) sm.removeRemote(id);
  }

  private applyCivil(s: NetSnapshot, own: (i: number) => string): void {
    const civil = this.ctx.civil;
    if (!civil) return;
    if (s.ci) {
      for (const r of s.ci) {
        const c = civil.cities[r[0]];
        if (!c) continue;
        c.population = r[1]; c.killed = r[2]; c.refugees = r[3]; c.evacuated = r[4] / 1000; c.evacuating = r[5] === 1;
        c.satisfaction = r[6] / 10; c.unrest = r[7] / 1000; c.controller = own(r[8]) || c.controller;
        c.control = CITY_CONTROLS[r[9]] ?? 'normal'; c.damage = r[10] / 1000;
      }
    }
    if (s.inf) for (const [id, v] of s.inf) { const it = civil.infra[id]; if (it) it.integrity = v / 1000; }
  }

  private applyEdges(closed: number[]): void {
    const g = this.ctx.graph;
    const next = new Set<number>(closed);
    for (const id of next) {
      const e = g.edges[id];
      if (e && e.open) g.setEdgeOpen(id, false);
    }
    for (const id of this.lastClosed) {
      if (next.has(id)) continue;
      const e = g.edges[id];
      if (e && !e.open) g.setEdgeOpen(id, true);
    }
    this.lastClosed = next;
  }

  // ------------------------------------------------------------------ Ereignisse

  private onEvent(name: string, payload: unknown): void {
    this.stats.events++;
    const ctx = this.ctx;
    const p = payload as Record<string, unknown> | null;
    if (!p || typeof p !== 'object') return;
    switch (name) {
      case 'nav:edge': {
        const id = p.edgeId as number;
        const e = ctx.graph.edges[id];
        if (e) ctx.graph.setEdgeOpen(id, p.open === true);
        return;
      }
      case 'war:declared':
        ctx.war.declare(String(p.a), String(p.b));
        return;
      case 'building:damaged':
        if (ctx.cities.hasBuilding(p.id as number)) ctx.cities.setIntegrity(p.id as number, p.integrity as number);
        return;
      case 'building:destroyed':
        if (ctx.cities.hasBuilding(p.id as number)) ctx.cities.setIntegrity(p.id as number, 0);
        break;
      case 'unit:killed':
        this.dropUnit(p.id as number);
        break;
      case 'structure:removed':
        ctx.structures.removeRemote(p.id as number);
        break;
      case 'toast':
        if (typeof p.to === 'string' && p.to !== this.selfA3) return;
        break;
      case 'mission:ended': {
        const winners = p.winners;
        if (Array.isArray(winners)) {
          const res: 'victory' | 'defeat' = winners.includes(this.selfA3) ? 'victory' : 'defeat';
          bus.emit('mission:ended', { ...(p as unknown as GameEvents['mission:ended']), result: res });
          return;
        }
        break;
      }
      case 'civil:casualties':
      case 'civil:infra':
      case 'civil:aid':
        return;
      default:
        break;
    }
    if (APPLY_ONLY.has(name)) return;
    (bus.emit as (n: string, p: unknown) => void)(name, payload);
  }
}
