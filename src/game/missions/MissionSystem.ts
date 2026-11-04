/**
 * Phase 6 – MissionSystem: wertet datengetriebene Ziele (types.ts) gegen den GameContext aus.
 *
 * - load(def): löst Selektoren (umkämpftes Feld, Städte, Frontmitte) auf, wendet startOverride an, setzt Zähler zurück.
 * - update(dtGameHours): sammelt Zeit, wertet gedrosselt aus (alle TICK_EVERY Aufrufe), spawnt Wellen, prüft Sieg/Niederlage.
 * - Zähler für Abschüsse/Konvois/Brücken kommen ereignisgetrieben aus statsTracker (kein Scan pro Frame).
 * Bei Sieg/Niederlage: Bus 'mission:ended' (genau einmal) und ctx.state.speed = 0.
 */
import { bus } from '../../core/EventBus';
import type { GameContext } from '../context';
import type { OilFieldInfo } from '../../logistics/types';
import type { Unit } from '../../units/types';
import { markCompleted } from './campaign';
import { statsTracker } from './stats';
import type { AreaSel, CitySel, MissionDef, MissionReport, ObjectiveDef, ObjectiveState, StartOverride, WaveDef } from './types';

/** Auswertung nur jeden n-ten update()-Aufruf (~5–10×/s); Zeit wird trotzdem pro Aufruf summiert */
const TICK_EVERY = 8;
/** Karenzzeit (h), bevor „alle Einheiten verloren" zur Niederlage führt */
const NO_FORCES_GRACE_H = 0.5;
const MIN_BARRELS_TO_PRODUCE = 10;
const PRODUCERS = new Set(['hq', 'barracks', 'factory', 'airfield', 'shipyard']);
const CONSTRAINT_KINDS = new Set(['keepBase', 'keepCity', 'maxLosses']);

interface Rt {
  def: ObjectiveDef;
  st: ObjectiveState;
  parent: number;
  children: number[];
  acc: number;
  n0: number;
  peak: number;
  key: string;
  fieldId: number;
  cityId: number;
  /** destroyBase/keepBase: existierte die Basis beim Laden? */
  existed: number;
  ax: number;
  az: number;
  gated: boolean;
}

function fmt(n: number): string {
  return (Math.round(n * 10) / 10).toString().replace('.', ',');
}

export class MissionSystem {
  current: MissionDef | null = null;
  readonly objectives: ObjectiveState[] = [];
  result: 'running' | 'victory' | 'defeat' = 'running';
  reason = '';
  /** Spielstunden seit Missionsbeginn */
  elapsedHours = 0;
  /** Lead kann hier die Zahl der Kriegsverbrechen des Spielers liefern (für den Endbildschirm) */
  getWarCrimes: (() => number) | null = null;
  /** Mission 1: Tutorial gewünscht (nach load() lesen) */
  get wantsTutorial(): boolean {
    return !!this.current?.tutorial;
  }

  private readonly ctx: GameContext;
  private rts: Rt[] = [];
  private tops: number[] = [];
  private own = '';
  private enemies: string[] = [];
  private tick = 0;
  private pendingDt = 0;
  private waveIdx = 0;
  private hadHq = false;
  private hadRefinery = false;
  private noForcesFor = 0;
  private armedForces = false;
  private mid: [number, number] = [0, 0];
  private contestedField: OilFieldInfo | null = null;
  private readonly buf: Unit[] = [];

  constructor(ctx: GameContext) {
    this.ctx = ctx;
    statsTracker.ownerOf = (id) => this.ctx.units.get(id)?.owner ?? '';
    statsTracker.bind();
  }

  // ------------------------------------------------------------------ Laden

  load(def: MissionDef, opts: { applyStart?: boolean } = {}): void {
    this.reset();
    this.current = def;
    this.own = def.playerNation;
    this.enemies = def.enemies.slice();
    statsTracker.reset();
    statsTracker.setActive(true);
    this.resolveWorld();
    if (opts.applyStart !== false && def.startOverride) this.applyStartOverride(def.startOverride);
    for (const o of def.objectives) this.tops.push(this.build(o, -1));
    for (const r of this.rts) {
      r.gated = !!(r.def.after?.length || r.def.startHours);
      if (r.parent < 0 && !r.gated) this.activate(r, false);
    }
    for (const r of this.rts) this.syncState(r);
    bus.emit('mission:started', { id: def.id, name: def.name });
    this.evaluate(0);
  }

  reset(): void {
    this.current = null;
    this.objectives.length = 0;
    this.rts = [];
    this.tops = [];
    this.result = 'running';
    this.reason = '';
    this.elapsedHours = 0;
    this.tick = 0;
    this.pendingDt = 0;
    this.waveIdx = 0;
    this.noForcesFor = 0;
    this.armedForces = false;
    this.contestedField = null;
    statsTracker.setActive(true);
  }

  /** KI soll (noch) nicht angreifen (Lead: AICommander pausieren) */
  aiHeld(): boolean {
    const a = this.current?.ai;
    if (!a || !a.hold || this.result !== 'running') return false;
    if (a.holdUntilHours !== undefined && this.elapsedHours >= a.holdUntilHours) return false;
    if (a.holdUntilObjective) {
      const r = this.rts.find((x) => x.def.id === a.holdUntilObjective);
      if (r && r.st.status === 'done') return false;
    }
    return true;
  }

  // ------------------------------------------------------------------ Auflösung von Selektoren

  private hqPos(a3: string): [number, number] | null {
    const n = this.ctx.geo.meta.scenario?.nations.find((x) => x.a3 === a3);
    if (n) return [n.hq[0], n.hq[1]];
    for (const b of this.ctx.economy.bases.values()) if (b.owner === a3 && b.kind === 'hq') return [b.x, b.z];
    return null;
  }

  private resolveWorld(): void {
    const eco = this.ctx.economy;
    const ownHq = this.hqPos(this.own);
    const enHq = this.hqPos(this.enemies[0] ?? '');
    this.mid = ownHq && enHq ? [(ownHq[0] + enHq[0]) / 2, (ownHq[1] + enHq[1]) / 2] : ownHq ?? [150, 100];
    let best: OilFieldInfo | null = null, bd = Infinity;
    for (const f of eco.fields) {
      if (f.owner === this.own || (f.owner && !this.ctx.war.isHostile(this.own, f.owner))) continue;
      const d = Math.hypot(f.x - this.mid[0], f.z - this.mid[1]);
      if (d < bd) { bd = d; best = f; }
    }
    this.contestedField = best;
    this.hadHq = eco.countBases(this.own, 'hq') > 0;
    this.hadRefinery = eco.countBases(this.own, 'refinery') > 0;
  }

  private cityIdOf(sel: CitySel): number {
    const cities = this.ctx.civil.cities;
    const meta = this.ctx.geo.meta;
    if (sel === 'ownCapital' || sel === 'enemyCapital') {
      const a3 = sel === 'ownCapital' ? this.own : this.enemies[0];
      const n = meta.scenario?.nations.find((x) => x.a3 === a3);
      if (n) return n.capitalCity;
      const c = cities.find((x) => x.capital && x.country === a3);
      return c ? c.id : -1;
    }
    if (sel === 'contested') {
      let id = -1, bd = Infinity;
      for (const c of cities) {
        if (c.country === this.own) continue;
        const d = Math.hypot(c.x - this.mid[0], c.z - this.mid[1]);
        if (d < bd) { bd = d; id = c.id; }
      }
      return id;
    }
    const low = sel.toLowerCase();
    const c = cities.find((x) => x.name.toLowerCase() === low);
    return c ? c.id : -1;
  }

  private areaPos(a: AreaSel): [number, number] {
    const at = a.at;
    if (typeof at === 'object') return [at.x, at.z];
    switch (at) {
      case 'ownHq': return this.hqPos(this.own) ?? this.mid;
      case 'enemyHq': return this.hqPos(this.enemies[0] ?? '') ?? this.mid;
      case 'ownCapital': case 'enemyCapital': {
        const c = this.ctx.civil.cities[this.cityIdOf(at)];
        return c ? [c.x, c.z] : this.mid;
      }
      case 'contested': return this.contestedField ? [this.contestedField.x, this.contestedField.z] : this.mid;
      default: return this.mid;
    }
  }

  // ------------------------------------------------------------------ Aufbau der Ziele

  private build(o: ObjectiveDef, parent: number): number {
    const idx = this.rts.length;
    const constraint = o.constraint ?? CONSTRAINT_KINDS.has(o.kind);
    const st: ObjectiveState = {
      id: o.id, text: o.text, role: o.role ?? 'primary', status: 'pending', constraint, progress: 0, detail: '',
      visible: false, parentId: parent >= 0 ? this.rts[parent].def.id : '',
    };
    const rt: Rt = {
      def: o, st, parent, children: [], acc: 0, n0: 0, peak: 0, key: '', fieldId: -1, cityId: -1, existed: 0, ax: 0, az: 0, gated: false,
    };
    this.rts.push(rt);
    this.objectives.push(st);
    this.resolveObjective(rt);
    if (o.kind === 'all' || o.kind === 'any') {
      for (const c of o.children) rt.children.push(this.build(c, idx));
    }
    return idx;
  }

  private resolveObjective(r: Rt): void {
    const o = r.def;
    const eco = this.ctx.economy;
    switch (o.kind) {
      case 'holdCity': case 'keepCity':
        r.cityId = this.cityIdOf(o.city);
        r.st.text = o.text.replace('{stadt}', this.ctx.civil.cities[r.cityId]?.name ?? 'Stadt');
        break;
      case 'captureFields':
        if (o.from === 'contested') {
          r.fieldId = this.contestedField?.id ?? -1;
          r.st.text = o.text.replace('{feld}', this.contestedField?.name ?? 'Ölfeld');
        }
        break;
      case 'destroyBase':
        for (const e of this.enemies) r.existed += eco.countBases(e, o.base);
        break;
      case 'keepBase':
        r.existed = eco.countBases(this.own, o.base);
        break;
      case 'blowBridges':
        if (o.area) { const p = this.areaPos(o.area); r.ax = p[0]; r.az = p[1]; }
        break;
      case 'reachArea': {
        const p = this.areaPos(o.area);
        r.ax = p[0]; r.az = p[1];
        break;
      }
      default: break;
    }
  }

  /** Ziel wird aktiv: Zählerbasis merken */
  private activate(r: Rt, announce: boolean): void {
    r.st.status = 'active';
    const s = statsTracker.of(this.own);
    const o = r.def;
    switch (o.kind) {
      case 'deliverBarrels': r.n0 = s.delivered; break;
      case 'deliverLoads': r.n0 = s.loads; break;
      case 'repairBridges': r.n0 = statsTracker.bridgesRepaired; break;
      case 'buildStructures': r.n0 = this.structCount(o.kinds); break;
      case 'buildBase': r.n0 = this.ownBases(o.base); break;
      case 'maxLosses': r.n0 = this.ownLost(); break;
      case 'killUnits': r.n0 = this.enemyKills(o.category, o.typeIds); break;
      case 'destroyConvoys': r.n0 = this.enemyConvoys(); break;
      case 'blowBridges': r.n0 = this.bridgeCount(o.area ? r : null, o.area?.radiusKm ?? 0); break;
      default: break;
    }
    for (const c of r.children) this.activate(this.rts[c], false);
    this.syncState(r);
    if (announce && !r.st.constraint) bus.emit('mission:objective', { missionId: this.current?.id ?? '', objectiveId: r.def.id, state: 'active', text: r.st.text });
  }

  private syncState(r: Rt): void {
    const p = r.parent >= 0 ? this.rts[r.parent] : null;
    r.st.visible = p ? p.st.visible : r.st.status !== 'pending';
  }

  // ------------------------------------------------------------------ Zähler

  private ownLost(): number {
    const s = statsTracker.of(this.own);
    return s.lost - (s.lostByCat['support'] ?? 0);
  }

  private ownBases(kind: string): number {
    let n = 0;
    for (const b of this.ctx.economy.bases.values()) if (b.owner === this.own && b.kind === kind && b.progress >= 1) n++;
    return n;
  }

  private structCount(kinds?: string[]): number {
    const s = statsTracker.of(this.own);
    if (!kinds) return s.structures;
    let n = 0;
    for (const k of kinds) n += s.structureKinds[k] ?? 0;
    return n;
  }

  private enemyKills(cat?: string, types?: string[]): number {
    let n = 0;
    for (const e of this.enemies) {
      const s = statsTracker.of(e);
      if (types) for (const t of types) n += s.lostByType[t] ?? 0;
      else if (cat) n += s.lostByCat[cat] ?? 0;
      else n += s.lost;
    }
    return n;
  }

  private enemyConvoys(): number {
    let n = 0;
    for (const e of this.enemies) n += statsTracker.of(e).convoysLost;
    return n;
  }

  private bridgeCount(r: Rt | null, radius: number): number {
    const list = statsTracker.bridgesBlown;
    if (!r) return list.length;
    let n = 0;
    for (const b of list) if (Math.hypot(b.x - r.ax, b.z - r.az) <= radius) n++;
    return n;
  }

  // ------------------------------------------------------------------ update

  update(dtGameHours: number): void {
    if (!this.current || this.result !== 'running') return;
    this.elapsedHours += dtGameHours;
    this.pendingDt += dtGameHours;
    if (++this.tick % TICK_EVERY !== 0) return;
    const dt = this.pendingDt;
    this.pendingDt = 0;
    this.evaluate(dt);
  }

  private evaluate(dt: number): void {
    const def = this.current;
    if (!def || this.result !== 'running') return;
    this.spawnWaves();
    // Kindziele zuerst (höhere Indizes), dann Eltern
    for (let i = this.rts.length - 1; i >= 0; i--) this.evalRt(this.rts[i], dt);
    // Sieg: alle primären, nicht-Constraint-Ziele erledigt
    let primaries = 0, done = 0;
    for (const i of this.tops) {
      const r = this.rts[i];
      if (r.st.role !== 'primary') continue;
      if (r.st.status === 'failed') {
        return this.end('defeat', `Auftrag gescheitert: ${r.st.text}`);
      }
      if (r.st.constraint) continue;
      primaries++;
      if (r.st.status === 'done') done++;
    }
    if (primaries > 0 && done === primaries) return this.end('victory', 'Alle Hauptziele erfüllt.');
    const lose = this.checkDefeat(def, dt);
    if (lose) return this.end('defeat', lose);
    if (def.timeLimitHours !== undefined && this.elapsedHours >= def.timeLimitHours) return this.end('defeat', 'Zeitlimit überschritten.');
  }

  private checkDefeat(def: MissionDef, dt: number): string | null {
    const eco = this.ctx.economy;
    const hq = eco.countBases(this.own, 'hq') > 0;
    const ref = eco.countBases(this.own, 'refinery') > 0;
    const mode = def.loseWhen ?? 'hq_and_refinery';
    if (this.hadHq || this.hadRefinery) {
      const lostHq = this.hadHq && !hq, lostRef = this.hadRefinery && !ref;
      if (mode === 'hq_and_refinery' && (this.hadHq ? lostHq : true) && (this.hadRefinery ? lostRef : true) && (lostHq || lostRef)) return 'Hauptquartier und Raffinerie zerstört.';
      if (mode === 'hq' && lostHq) return 'Hauptquartier zerstört.';
      if (mode === 'refinery' && lostRef) return 'Raffinerie zerstört.';
      if (mode === 'either' && (lostHq || lostRef)) return lostHq ? 'Hauptquartier zerstört.' : 'Raffinerie zerstört.';
    }
    if (def.loseWhenNoForces !== false) {
      let combat = 0;
      const us = this.ctx.units.units;
      for (let i = 0; i < us.length; i++) {
        const u = us[i];
        if (u.owner === this.own && u.hp > 0 && u.type.damage > 0) { combat++; break; }
      }
      if (combat > 0) { this.armedForces = true; this.noForcesFor = 0; }
      else if (this.armedForces) {
        let canProduce = this.ctx.economy.pool(this.own).barrels >= MIN_BARRELS_TO_PRODUCE;
        if (canProduce) {
          canProduce = false;
          for (const b of eco.bases.values()) if (b.owner === this.own && b.progress >= 1 && PRODUCERS.has(b.kind)) { canProduce = true; break; }
        }
        if (canProduce) this.noForcesFor = 0;
        else {
          this.noForcesFor += dt;
          if (this.noForcesFor >= NO_FORCES_GRACE_H) return 'Alle Kampfeinheiten verloren – keine Produktion möglich.';
        }
      }
    }
    return null;
  }

  private evalRt(r: Rt, dt: number): void {
    const st = r.st;
    if (st.status === 'done' || st.status === 'failed') return;
    if (st.status === 'pending') {
      if (r.parent >= 0) return;
      const o = r.def;
      if (o.startHours !== undefined && this.elapsedHours < o.startHours) return;
      if (o.after) for (const id of o.after) {
        const d = this.rts.find((x) => x.def.id === id);
        if (d && d.st.status !== 'done') return;
      }
      this.activate(r, true);
    }
    const o = r.def;
    // Zeitlimit des Ziels
    if (o.timeLimitHours !== undefined && !st.constraint && this.elapsedHours >= o.timeLimitHours) {
      return this.setStatus(r, 'failed');
    }
    if (o.kind === 'all' || o.kind === 'any') {
      let nd = 0, nf = 0, n = 0;
      for (const c of r.children) {
        const cs = this.rts[c].st;
        if (cs.constraint) continue;
        n++;
        if (cs.status === 'done') nd++;
        else if (cs.status === 'failed') nf++;
      }
      st.progress = n ? nd / n : 1;
      st.detail = `${nd} / ${n}`;
      if (o.kind === 'all') {
        if (nf > 0) this.setStatus(r, 'failed');
        else if (nd === n) this.setStatus(r, 'done');
      } else {
        if (nd > 0) this.setStatus(r, 'done');
        else if (nf === n) this.setStatus(r, 'failed');
      }
      return;
    }
    const met = this.evalLeaf(r, dt);
    if (st.constraint) {
      if (!met) this.setStatus(r, 'failed');
    } else if (met) {
      st.progress = 1;
      this.setStatus(r, 'done');
    }
  }

  private setStatus(r: Rt, status: 'done' | 'failed'): void {
    r.st.status = status;
    if (status === 'done') r.st.progress = 1;
    bus.emit('mission:objective', { missionId: this.current?.id ?? '', objectiveId: r.def.id, state: status, text: r.st.text });
  }

  /** true = Bedingung (bei Constraints: „noch erfüllt") */
  private evalLeaf(r: Rt, dt: number): boolean {
    const o = r.def;
    const st = r.st;
    const eco = this.ctx.economy;
    const own = this.own;
    switch (o.kind) {
      case 'holdCity': {
        const c = this.ctx.civil.cities[r.cityId];
        if (!c) { st.detail = ''; return true; }
        if (c.controller === own) r.acc += dt; else r.acc = 0;
        st.progress = Math.min(1, r.acc / o.hours);
        this.setDetail(r, `${fmt(Math.min(r.acc, o.hours))} / ${fmt(o.hours)} h${c.controller === own ? '' : ' (nicht gehalten)'}`);
        return r.acc >= o.hours;
      }
      case 'keepCity': {
        const c = this.ctx.civil.cities[r.cityId];
        const ok = !c || c.controller === own;
        st.progress = ok ? 1 : 0;
        this.setDetail(r, ok ? 'gehalten' : 'verloren');
        return ok;
      }
      case 'captureFields': {
        const need = o.from === 'contested' ? 1 : o.count;
        let n = 0;
        if (o.from === 'contested') {
          const f = eco.fields.find((x) => x.id === r.fieldId);
          if (f && f.owner === own) n = 1;
          else if (!f) return true;
        } else {
          for (const f of eco.fields) {
            if (f.owner !== own) continue;
            if (o.from === 'enemy' && !this.enemies.includes(f.country)) continue;
            n++;
          }
        }
        const hold = o.holdHours ?? 1;
        if (n >= need) r.acc += dt; else r.acc = 0;
        st.progress = Math.min(1, (Math.min(n, need) / need) * 0.5 + Math.min(1, r.acc / hold) * 0.5);
        this.setDetail(r, need > 1 ? `${n} / ${need} Felder · ${fmt(Math.min(r.acc, hold))} / ${fmt(hold)} h` : `${fmt(Math.min(r.acc, hold))} / ${fmt(hold)} h`);
        return n >= need && r.acc >= hold;
      }
      case 'destroyBase': {
        if (r.existed === 0) return true;
        let left = 0;
        for (const e of this.enemies) left += eco.countBases(e, o.base);
        st.progress = 1 - left / r.existed;
        this.setDetail(r, left === 0 ? 'zerstört' : `${left} intakt`);
        return left === 0;
      }
      case 'keepBase': {
        if (r.existed === 0) return true;
        const ok = eco.countBases(own, o.base) > 0;
        st.progress = ok ? 1 : 0;
        this.setDetail(r, ok ? 'intakt' : 'zerstört');
        return ok;
      }
      case 'deliverBarrels': {
        const v = statsTracker.of(own).delivered - r.n0;
        st.progress = Math.min(1, v / o.total);
        this.setDetail(r, `${Math.floor(v)} / ${o.total} Fässer`);
        return v >= o.total;
      }
      case 'deliverLoads': {
        const v = statsTracker.of(own).loads - r.n0;
        st.progress = Math.min(1, v / o.count);
        this.setDetail(r, `${v} / ${o.count} Ladungen`);
        return v >= o.count;
      }
      case 'balance': {
        const v = eco.pool(own).barrels;
        st.progress = Math.min(1, v / o.barrels);
        this.setDetail(r, `${Math.floor(v)} / ${o.barrels} Fässer`);
        return v >= o.barrels;
      }
      case 'income': {
        const v = eco.pool(own).incomePerHour;
        st.progress = Math.min(1, v / o.perHour);
        this.setDetail(r, `${fmt(v)} / ${o.perHour} Fässer/h`);
        return v >= o.perHour;
      }
      case 'cutIncome': {
        let cur = 0, peak = 0;
        for (const e of this.enemies) { cur += eco.pool(e).incomePerHour; peak += statsTracker.of(e).peakIncome; }
        if (peak > r.peak) r.peak = peak;
        const armed = r.peak >= 10;
        const thr = o.belowAbs !== undefined ? o.belowAbs : (o.belowPct ?? 0.3) * r.peak;
        const ok = armed && cur < thr;
        if (ok) r.acc += dt; else r.acc = 0;
        st.progress = Math.min(1, r.acc / o.hours);
        const pct = armed ? Math.round((cur / r.peak) * 100) : 100;
        this.setDetail(r, armed ? `Gegner ${pct} % · ${fmt(Math.min(r.acc, o.hours))} / ${fmt(o.hours)} h` : 'Messe Gegner-Einkommen …');
        return r.acc >= o.hours;
      }
      case 'destroyConvoys': {
        const v = this.enemyConvoys() - r.n0;
        st.progress = Math.min(1, v / o.count);
        this.setDetail(r, `${v} / ${o.count} Konvois`);
        return v >= o.count;
      }
      case 'blowBridges': {
        const v = this.bridgeCount(o.area ? r : null, o.area?.radiusKm ?? 0) - r.n0;
        st.progress = Math.min(1, v / o.count);
        this.setDetail(r, `${v} / ${o.count} Brücken`);
        return v >= o.count;
      }
      case 'repairBridges': {
        const v = statsTracker.bridgesRepaired - r.n0;
        st.progress = Math.min(1, v / o.count);
        this.setDetail(r, `${v} / ${o.count} Brücken`);
        return v >= o.count;
      }
      case 'killUnits': {
        const v = this.enemyKills(o.category, o.typeIds) - r.n0;
        st.progress = Math.min(1, v / o.count);
        this.setDetail(r, `${v} / ${o.count} zerstört`);
        return v >= o.count;
      }
      case 'surviveUntil': {
        st.progress = Math.min(1, this.elapsedHours / o.hours);
        this.setDetail(r, `${fmt(Math.min(this.elapsedHours, o.hours))} / ${fmt(o.hours)} h`);
        return this.elapsedHours >= o.hours;
      }
      case 'maxLosses': {
        const v = this.ownLost() - r.n0;
        st.progress = Math.max(0, 1 - v / (o.count + 1));
        this.setDetail(r, `${v} / max. ${o.count} Verluste`);
        return v <= o.count;
      }
      case 'reachArea': {
        const need = o.count ?? 1;
        this.ctx.units.queryRadius(r.ax, r.az, o.area.radiusKm, this.buf);
        let n = 0;
        for (let i = 0; i < this.buf.length; i++) {
          const u = this.buf[i];
          if (u.owner !== own || u.hp <= 0) continue;
          if (o.category && u.type.category !== o.category) continue;
          if (o.typeIds && !o.typeIds.includes(u.type.id)) continue;
          n++;
        }
        st.progress = Math.min(1, n / need);
        this.setDetail(r, `${n} / ${need} im Zielgebiet`);
        return n >= need;
      }
      case 'buildBase': {
        const need = o.count ?? 1;
        const v = this.ownBases(o.base) - r.n0;
        st.progress = Math.min(1, v / need);
        this.setDetail(r, `${v} / ${need}`);
        return v >= need;
      }
      case 'buildStructures': {
        const v = this.structCount(o.kinds) - r.n0;
        st.progress = Math.min(1, v / o.count);
        this.setDetail(r, `${v} / ${o.count} Bauwerke`);
        return v >= o.count;
      }
      default: return false;
    }
  }

  private setDetail(r: Rt, s: string): void {
    r.st.detail = s;
  }

  // ------------------------------------------------------------------ Wellen

  private spawnWaves(): void {
    const waves = this.current?.waves;
    if (!waves) return;
    while (this.waveIdx < waves.length && waves[this.waveIdx].atHours <= this.elapsedHours) {
      this.spawnWave(waves[this.waveIdx]);
      this.waveIdx++;
    }
  }

  private waveTarget(t: NonNullable<WaveDef['target']>): [number, number] {
    switch (t) {
      case 'ownCapital': return this.areaPos({ at: 'ownCapital', radiusKm: 0 });
      case 'ownRefinery': {
        const n = this.ctx.geo.meta.scenario?.nations.find((x) => x.a3 === this.own);
        return n ? [n.refinery[0], n.refinery[1]] : this.hqPos(this.own) ?? this.mid;
      }
      case 'contested': return this.areaPos({ at: 'contested', radiusKm: 0 });
      case 'midpoint': return this.mid;
      default: return this.hqPos(this.own) ?? this.mid;
    }
  }

  private spawnWave(w: WaveDef): void {
    const enemy = this.enemies[0];
    if (!enemy) return;
    const [tx, tz] = this.waveTarget(w.target ?? 'ownHq');
    const eh = this.hqPos(enemy) ?? [tx + 100, tz];
    let dx = eh[0] - tx, dz = eh[1] - tz;
    const dl = Math.hypot(dx, dz) || 1;
    dx /= dl; dz /= dl;
    const dist = Math.min(w.distKm ?? 60, dl * 0.9);
    const ids: number[] = [];
    for (const [typeId, count] of w.units) {
      for (let i = 0; i < count; i++) {
        let u: Unit | null = null;
        for (let t = 0; t < 5 && !u; t++) {
          const k = dist * (1 - t * 0.15);
          const a = (ids.length * 2.399) % 6.283, r = 0.4 + (ids.length % 5) * 0.25;
          u = this.ctx.units.spawn(typeId, enemy, tx + dx * k + Math.cos(a) * r, tz + dz * k + Math.sin(a) * r, Math.atan2(-dx, dz));
        }
        if (u) ids.push(u.id);
      }
    }
    if (ids.length) this.ctx.units.issueMove(ids, tx, tz, { kind: 'attackMove' });
    bus.emit('toast', { msg: w.label ?? 'Feindliche Verbände nähern sich!', kind: 'warn' });
  }

  // ------------------------------------------------------------------ Start-Overrides

  /** Wird von load() aufgerufen (nach spawnStartingForces + economy.loadScenario) */
  applyStartOverride(o: StartOverride): void {
    const ctx = this.ctx;
    const own = this.own;
    if (o.barrels !== undefined) {
      const p = ctx.economy.pool(own);
      p.barrels = o.barrels;
      bus.emit('oil:balance', { owner: own, barrels: p.barrels, incomePerHour: p.incomePerHour });
    }
    const eh = this.hqPos(this.enemies[0] ?? '');
    for (const g of o.extraUnits ?? []) {
      let px: number, pz: number;
      if (g.near === 'hq') [px, pz] = this.hqPos(own) ?? this.mid;
      else if (g.near === 'spawn') {
        const n = ctx.geo.meta.scenario?.nations.find((x) => x.a3 === own);
        [px, pz] = n ? [n.spawn[0], n.spawn[1]] : this.hqPos(own) ?? this.mid;
      } else {
        const f = ctx.economy.fields[Number(g.near.slice(6))];
        [px, pz] = f ? [f.x, f.z] : this.hqPos(own) ?? this.mid;
      }
      const head = eh ? Math.atan2(eh[0] - px, -(eh[1] - pz)) : 0;
      for (let i = 0; i < g.count; i++) {
        const a = i * 2.399, r = 0.5 + 0.25 * i;
        ctx.units.spawn(g.typeId, own, px + Math.cos(a) * r, pz + Math.sin(a) * r, head);
      }
    }
    if (o.enemyStrength !== undefined && o.enemyStrength !== 1) this.scaleEnemy(o.enemyStrength);
    if (o.spawnEnemyNearFields) {
      for (const f of ctx.economy.fields) {
        if (!f.owner || !this.enemies.includes(f.owner)) continue;
        ctx.units.spawn('inf_squad', f.owner, f.x + 0.4, f.z + 0.2);
        ctx.units.spawn('at_team', f.owner, f.x - 0.4, f.z + 0.3);
        ctx.units.spawn('light_tank', f.owner, f.x, f.z - 0.5);
      }
    }
  }

  private scaleEnemy(s: number): void {
    const units = this.ctx.units;
    const pool: Unit[] = [];
    for (const u of units.units) {
      if (!this.enemies.includes(u.owner) || u.hp <= 0 || u.type.damage <= 0 || u.type.mobility.domain !== 'ground') continue;
      pool.push(u);
    }
    const f = Math.min(1, Math.abs(s - 1));
    if (f <= 0) return;
    const step = 1 / f;
    let acc = 0;
    for (const u of pool) {
      acc += 1;
      if (acc < step) continue;
      acc -= step;
      if (s < 1) units.remove(u.id);
      else units.spawn(u.type.id, u.owner, u.x + 0.35, u.z + 0.35, u.heading);
    }
  }

  // ------------------------------------------------------------------ Ende & Bericht

  private end(result: 'victory' | 'defeat', reason: string): void {
    if (this.result !== 'running' || !this.current) return;
    this.result = result;
    this.reason = reason;
    statsTracker.setActive(false);
    if (result === 'victory' && !this.current.skirmish) markCompleted(this.current.id);
    this.ctx.state.speed = 0;
    bus.emit('mission:ended', { missionId: this.current.id, result, reason });
  }

  /** Zusammenfassung für den Endbildschirm */
  report(): MissionReport {
    const own = statsTracker.of(this.own);
    let kills = 0, convRaided = own.convoysRaided;
    for (const e of this.enemies) kills += statsTracker.of(e).lost;
    const eco = this.ctx.economy;
    let held = 0;
    for (const f of eco.fields) if (f.owner === this.own) held++;
    return {
      missionId: this.current?.id ?? '',
      result: this.result,
      reason: this.reason,
      elapsedHours: this.elapsedHours,
      unitsLost: own.lost,
      unitsKilled: kills,
      barrelsDelivered: Math.round(own.delivered),
      fieldsHeld: held,
      fieldsTotal: eco.fields.length,
      convoysLost: own.convoysLost,
      convoysRaided: convRaided,
      bridgesBlown: statsTracker.bridgesBlown.length,
      civilKilled: Math.round(this.ctx.civil.stats.killed),
      warCrimes: this.getWarCrimes ? this.getWarCrimes() : null,
    };
  }
}
