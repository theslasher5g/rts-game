/**
 * Phase 6 – KI-Befehlshaber (Gegner / verbündeter Verteidiger).
 *
 * Architektur (alles in Spielstunden, ein Denkzyklus = preset.thinkHours, aufgeteilt auf 3 Takte):
 *   Takt 0  Lage:      Einheiten sammeln, Sicht/Gedächtnis, Einflusskarte, Anlagen, Bedrohungen, Wirtschaftsplan
 *   Takt 1  Boden:     Zuteilung, Verteidigung (Posten/Alarm), Hauptmacht-Wellen, Artillerie
 *   Takt 2  Spezial:   Überfälle (Konvois/Felder), Luft, Marine, Pioniere (Brücken reparieren/sprengen)
 * Die KI nutzt dieselben Systeme wie der Spieler (UnitManager-Befehle, CombatSystem, StructureManager, ProductionSystem
 * über EconomyAI) – keine Gratis-Einheiten.
 */
import { bus } from '../core/EventBus';
import type { Difficulty, GameContext } from '../game/context';
import { EconomyAI } from '../logistics/EconomyAI';
import type { OilFieldInfo } from '../logistics/types';
import { SUPPLY_KINDS } from '../logistics/prices';
import type { Unit } from '../units/types';
import { AI_PRESETS, ALLY_HELP_RANGE_KM, DEFENDER_RANGE_KM, type AIPreset, type AIStyle } from './aiPresets';
import { centroid, isFast, isFoot, newGroup, setState, type BattleGroup, type Objective } from './groups';
import { Planner } from './Planner';
import { InfluenceMap, strengthOf } from './threat';

export interface AICommanderOptions {
  a3: string;
  difficulty: Difficulty;
  enabled?: boolean;
  style?: AIStyle;
  /** Gemeinsamer EconomyAI (empfohlen: der in main.ts vorhandene). Ohne Angabe erzeugt der Kommandeur einen eigenen. */
  econ?: EconomyAI;
}

interface Known { id: number; x: number; z: number; typeId: string; cat: string; owner: string; s: number; seen: number }
interface Post { key: string; x: number; z: number; w: number }
interface Alert { x: number; z: number; e: number; until: number; hq: boolean }
interface EngJob { kind: 'repair' | 'demolish'; edge: number; since: number; eta: number }
interface AirState { rearm: boolean; since: number }

const HEAVY_CATS = new Set(['tank', 'ifv']);
const GROUND_CORE = new Set(['infantry', 'recon', 'ifv', 'tank']);
const AIR_CATS = new Set(['helicopter', 'jet']);

export class AICommander {
  readonly a3: string;
  readonly debug: { plan: string; groups: number; targets: string[] } = { plan: 'init', groups: 0, targets: [] };
  readonly stats = { waves: 0, raids: 0, convoysKilled: 0, bridgesBlown: 0, bridgesRepaired: 0, fieldsTaken: 0, fieldsLost: 0, lost: 0, kills: 0, alerts: 0, sabotageTries: 0, fireMissions: 0 };

  private readonly ctx: GameContext;
  private difficulty: Difficulty;
  private readonly style: AIStyle;
  private enabled: boolean;
  private P: AIPreset;
  private readonly econ: EconomyAI;
  private readonly ownsEcon: boolean;
  private readonly planner: Planner;
  private readonly map: InfluenceMap;
  private readonly offs: Array<() => void> = [];

  private time = 0;
  private nextTick = 0.02;
  private phase = 0;
  private orders = 0;
  private seed = 0x9e3779b9;
  private inited = false;
  private nextEcon = 0;

  // --- Lage
  private readonly own: Unit[] = [];
  private readonly known = new Map<number, Known>();
  private readonly knownList: Known[] = [];
  private readonly ownFields: OilFieldInfo[] = [];
  private readonly targetFields: OilFieldInfo[] = [];
  private hq: [number, number] | null = null;
  private refinery: [number, number] | null = null;
  private staging: [number, number] = [0, 0];
  private stagingAt = -99;
  private readonly comp = { tank: 0, inf: 0, art: 0, air: 0, ifv: 0, total: 0, tankers: 0 };
  private readonly alerts: Alert[] = [];
  private alert: Alert | null = null;
  private calmSince = 0;

  // --- Gruppen
  private readonly groupOf = new Map<number, BattleGroup>();
  private readonly defense: BattleGroup;
  private readonly strike: BattleGroup;
  private readonly support: BattleGroup;
  private readonly air: BattleGroup;
  private readonly naval: BattleGroup;
  private readonly raidPool: BattleGroup;
  /** Nachschub für die Hauptmacht, solange diese unterwegs ist (kommt als Paket nach) */
  private readonly reserve: BattleGroup;
  private readonly raids: BattleGroup[] = [];
  private readonly posts = new Map<string, Post>();
  private readonly postOf = new Map<number, string>();
  private readonly navalHome = new Map<number, [number, number]>();
  private readonly airState = new Map<number, AirState>();
  private readonly rearm = new Set<number>();
  private nextWaveAt = 0;
  private nextRaidAt = 0;
  private nextRebalance = 2;
  private readonly blacklist = new Map<string, number>();

  // --- Pioniere
  private readonly engJobs = new Map<number, EngJob>();
  private readonly downBridges = new Set<number>();
  private readonly ourBlown = new Set<number>();
  private nextSabotageAt = 0;
  private sabCache: { at: number; ver: number; edges: Map<number, number>; own: Set<number> } = { at: -99, ver: -1, edges: new Map(), own: new Set() };

  // --- Scratch
  private readonly tmpA: Unit[] = [];
  private readonly tmpB: Unit[] = [];
  private readonly tmpIds: number[] = [];
  private readonly tmpIds2: number[] = [];
  private readonly tmpIds3: number[] = [];
  private readonly peak: [number, number, number] = [0, 0, 0];
  private readonly cen: [number, number] = [0, 0];
  private readonly byPost = new Map<string, number[]>();
  private readonly invMap = new Map<string, number>();
  private readonly tankerCargo = new Map<number, number>();

  constructor(ctx: GameContext, opts: AICommanderOptions) {
    this.ctx = ctx;
    this.a3 = opts.a3;
    this.difficulty = opts.difficulty;
    this.style = opts.style ?? 'aggressor';
    this.enabled = opts.enabled ?? true;
    this.P = AI_PRESETS[this.difficulty];
    this.planner = new Planner(ctx.pathfinder, ctx.graph);
    this.map = new InfluenceMap(ctx.geo.widthKm, ctx.geo.heightKm);
    if (opts.econ) { this.econ = opts.econ; this.ownsEcon = false; } else {
      this.econ = new EconomyAI({ geo: ctx.geo, economy: ctx.economy, production: ctx.production, units: ctx.units, war: ctx.war, getPlayer: ctx.player });
      this.ownsEcon = true;
    }
    this.econ.setManaged(this.a3, true);
    this.econ.engineerBusy = (id) => this.engJobs.has(id);
    const now = 0;
    this.defense = newGroup('defense', 'idle', now);
    this.strike = newGroup('strike', 'assemble', now);
    this.support = newGroup('support', 'idle', now);
    this.air = newGroup('air', 'idle', now);
    this.naval = newGroup('naval', 'idle', now);
    this.raidPool = newGroup('raid', 'idle', now);
    this.reserve = newGroup('strike', 'idle', now);
    this.applyPreset();
    this.hook();
  }

  // ================================================================== API

  setEnabled(b: boolean): void {
    this.enabled = b;
    this.econ.setEnabled(this.a3, b);
    if (b) this.econ.setManaged(this.a3, true);
  }

  setDifficulty(d: Difficulty): void {
    this.difficulty = d;
    this.P = AI_PRESETS[d];
    this.applyPreset();
  }

  /** Ereignis-Abos lösen (z. B. beim Zurück-ins-Menü) */
  dispose(): void {
    for (const f of this.offs) f();
    this.offs.length = 0;
  }

  update(dtGameHours: number, realDt: number): void {
    void realDt;
    if (!this.enabled || !(dtGameHours > 0)) return;
    this.time += dtGameHours;
    if (this.ownsEcon) this.econ.update(dtGameHours);
    if (this.time < this.nextTick) return;
    this.nextTick = this.time + this.P.thinkHours / 3;
    const ph = this.phase;
    this.phase = (ph + 1) % 3;
    this.orders = 0;
    this.planner.tick(this.time, ph === 0 ? 8 : 4);
    if (!this.inited) this.init();
    if (ph === 0) this.phaseSituation();
    else if (this.rnd() >= this.P.skipChance) {
      if (ph === 1) this.phaseGround(); else this.phaseSpecial();
    }
    this.updateDebug();
  }

  // ================================================================== Setup

  private applyPreset(): void {
    const P = this.P;
    this.econ.setCycle(this.a3, P.produceCycle);
    this.econ.setReserve(this.a3, P.reserveBarrels);
    this.econ.setUnitCap(this.a3, P.unitCap);
    const eco = this.ctx.economy as unknown as { setIncomeMultiplier?: (a3: string, f: number) => void };
    eco.setIncomeMultiplier?.(this.a3, P.incomeBonus);
  }

  private hook(): void {
    const a3 = this.a3;
    this.offs.push(bus.on('unit:killed', (e) => {
      if (e.owner === a3) {
        this.stats.lost++;
        if (e.typeId === 'tanker_truck') this.pushAlert(e.x, e.z, 10, false, 1.5);
      } else if (this.ctx.war.isHostile(a3, e.owner)) {
        const k = this.ctx.units.get(e.killerId);
        if (k && k.owner === a3) this.stats.kills++;
      }
    }));
    this.offs.push(bus.on('convoy:lost', (e) => { if (e.by === a3 && e.owner !== a3) this.stats.convoysKilled++; }));
    this.offs.push(bus.on('oil:field-captured', (e) => {
      if (e.by === a3) this.stats.fieldsTaken++;
      else if (e.from === a3) {
        this.stats.fieldsLost++;
        const f = this.ctx.economy.fields.find((q) => q.id === e.fieldId);
        if (f) this.pushAlert(f.x, f.z, 25, false, 3);
      }
    }));
    this.offs.push(bus.on('bridge:destroyed', (e) => {
      this.downBridges.add(e.edgeId);
      for (const [, j] of this.engJobs) if (j.kind === 'demolish' && j.edge === e.edgeId) { this.ourBlown.add(e.edgeId); this.stats.bridgesBlown++; }
    }));
    this.offs.push(bus.on('bridge:repaired', (e) => {
      this.downBridges.delete(e.edgeId);
      for (const [, j] of this.engJobs) if (j.kind === 'repair' && j.edge === e.edgeId) this.stats.bridgesRepaired++;
    }));
  }

  private init(): void {
    this.inited = true;
    this.nextWaveAt = this.P.firstWaveHours;
    this.nextRaidAt = this.P.raidStartHours;
    this.nextSabotageAt = this.P.sabotageStartHours;
    for (const e of this.ctx.graph.edges) if (e.bridge && !e.open && e.cls !== 'ferry') this.downBridges.add(e.id);
  }

  private rnd(): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  private canOrder(): boolean { return this.orders < this.P.maxOrders; }

  private move(ids: number[], x: number, z: number, kind: 'move' | 'attackMove' | 'retreat' = 'move'): boolean {
    if (!ids.length || !this.canOrder()) return false;
    this.orders++;
    this.ctx.units.issueMove(ids, x, z, { kind });
    return true;
  }

  private isEnemy(o: string): boolean { return this.ctx.war.isHostile(this.a3, o); }
  private isAlly(o: string): boolean { return !!o && o !== this.a3 && !this.ctx.war.isHostile(this.a3, o); }

  private pushAlert(x: number, z: number, e: number, hq: boolean, hours: number): void {
    for (const a of this.alerts) if (Math.hypot(a.x - x, a.z - z) < 8) { a.e = Math.max(a.e, e); a.until = Math.max(a.until, this.time + hours); a.hq = a.hq || hq; return; }
    if (this.alerts.length < 8) this.alerts.push({ x, z, e, until: this.time + hours, hq });
    this.stats.alerts++;
  }

  // ================================================================== Takt 0: Lage

  private phaseSituation(): void {
    const { units, economy, war } = this.ctx;
    const a3 = this.a3;
    const P = this.P;
    // eigene Einheiten
    this.own.length = 0;
    for (const u of units.units) if (u.owner === a3 && u.hp > 0 && u.garrisonId === undefined) this.own.push(u);
    // Sicht
    const map = this.map;
    map.clear();
    if (!P.seeAll) {
      for (const u of this.own) map.markVis(u.x, u.z, Math.max(P.visionKm, u.type.sightKm * 0.5));
      for (const b of economy.bases.values()) if (b.owner === a3) map.markVis(b.x, b.z, 6);
      for (const f of economy.fields) if (f.owner === a3) map.markVis(f.x, f.z, 6);
    }
    // Gegner: sichtbar -> aktualisieren, sonst Gedächtnis
    const enemyOwners = war.enemiesOf(a3);
    for (const u of units.units) {
      if (u.hp <= 0 || u.owner === a3 || u.garrisonId !== undefined) continue;
      if (!enemyOwners.includes(u.owner)) continue;
      const tanker = u.type.id === 'tanker_truck';
      const vis = P.seeAll || (P.seeTankers && tanker) || map.visible(u.x, u.z);
      let k = this.known.get(u.id);
      if (vis) {
        if (!k) { k = { id: u.id, x: u.x, z: u.z, typeId: u.type.id, cat: u.type.category, owner: u.owner, s: 0, seen: this.time }; this.known.set(u.id, k); }
        k.x = u.x; k.z = u.z; k.seen = this.time; k.s = strengthOf(u);
      }
    }
    this.knownList.length = 0;
    for (const [id, k] of this.known) {
      const u = units.get(id);
      if (!u || u.hp <= 0 || this.time - k.seen > P.memoryHours || !enemyOwners.includes(k.owner)) { this.known.delete(id); continue; }
      this.knownList.push(k);
    }
    // Einflusskarte + Zusammensetzung
    const c = this.comp;
    c.tank = c.inf = c.art = c.air = c.ifv = c.total = c.tankers = 0;
    for (const u of this.own) { const s = strengthOf(u); if (s > 0) map.addOwn(u.x, u.z, s); }
    for (const k of this.knownList) {
      if (k.s > 0) map.addEnemy(k.x, k.z, k.s);
      if (k.typeId === 'tanker_truck') c.tankers++;
      if (k.s <= 0) continue;
      c.total += k.s;
      if (k.cat === 'tank') c.tank += k.s; else if (k.cat === 'infantry') c.inf += k.s; else if (k.cat === 'artillery') c.art += k.s;
      else if (AIR_CATS.has(k.cat)) c.air += k.s; else if (k.cat === 'ifv') c.ifv += k.s;
    }
    // Anlagen
    const hq = economy.nearestBase(a3, 'hq', 0, 0) ?? economy.nearestBase(a3, 'any', 0, 0);
    const rf = economy.nearestBase(a3, 'refinery', hq?.x ?? 0, hq?.z ?? 0);
    this.hq = hq ? [hq.x, hq.z] : null;
    this.refinery = rf ? [rf.x, rf.z] : null;
    this.ownFields.length = 0;
    this.targetFields.length = 0;
    for (const f of economy.fields) {
      if (f.owner === a3) this.ownFields.push(f);
      else if ((!f.owner || this.isEnemy(f.owner)) && f.integrity >= 0.05) this.targetFields.push(f);
    }
    this.updateStaging();
    this.detectThreats();
    this.rebuildPosts();
    if (this.time >= this.nextEcon) { this.nextEcon = this.time + Math.max(0.5, P.thinkHours * 2); this.economyPlan(); }
  }

  /** Sammelpunkt der Hauptmacht: ein Stück vom HQ in Richtung Gegner */
  private updateStaging(): void {
    if (!this.hq) return;
    if (this.time - this.stagingAt < 3) return;
    this.stagingAt = this.time;
    const { economy, units, pathfinder } = this.ctx;
    let tx = this.hq[0] + 1, tz = this.hq[1];
    let bd = Infinity;
    for (const o of this.ctx.war.enemiesOf(this.a3)) {
      const b = economy.nearestBase(o, 'hq', this.hq[0], this.hq[1]);
      if (!b) continue;
      const d = Math.hypot(b.x - this.hq[0], b.z - this.hq[1]);
      if (d < bd) { bd = d; tx = b.x; tz = b.z; }
    }
    void units;
    const d = Math.hypot(tx - this.hq[0], tz - this.hq[1]) || 1;
    const step = this.style === 'defender' ? 4 : Math.min(12, d * 0.12);
    const px = this.hq[0] + ((tx - this.hq[0]) / d) * step, pz = this.hq[1] + ((tz - this.hq[1]) / d) * step;
    const p = pathfinder.nearestPassable(px, pz, this.planner.prof.heavy, 6);
    this.staging[0] = p ? p[0] : px;
    this.staging[1] = p ? p[1] : pz;
    this.econ.setRally(this.a3, this.staging[0], this.staging[1]);
  }

  private detectThreats(): void {
    const { economy } = this.ctx;
    const map = this.map;
    // Alarme ablaufen lassen
    for (let i = this.alerts.length - 1; i >= 0; i--) if (this.alerts[i].until < this.time) this.alerts.splice(i, 1);
    const check = (x: number, z: number, hq: boolean, r: number) => {
      const e = map.enemyNear(x, z, r);
      if (e >= 18) this.pushAlert(x, z, e, hq, 1.5);
    };
    if (this.hq) check(this.hq[0], this.hq[1], true, 14);
    if (this.refinery) check(this.refinery[0], this.refinery[1], true, 14);
    for (const f of this.ownFields) check(f.x, f.z, false, 8);
    // verbündete Anlagen: nur Verteidiger-Stil hilft aktiv (Bedrohungsmeldung -> Gegenangriffsziel)
    if (this.style === 'defender') {
      for (const b of economy.bases.values()) {
        if (!this.isAlly(b.owner) || (b.kind !== 'hq' && b.kind !== 'refinery')) continue;
        if (this.hq && Math.hypot(b.x - this.hq[0], b.z - this.hq[1]) > ALLY_HELP_RANGE_KM) continue;
        check(b.x, b.z, false, 12);
      }
    }
    let best: Alert | null = null, bs = 0;
    for (const a of this.alerts) {
      const s = a.e * (a.hq ? 2 : 1);
      if (s > bs) { bs = s; best = a; }
    }
    this.alert = best;
    if (best) this.calmSince = this.time;
  }

  private rebuildPosts(): void {
    this.posts.clear();
    if (this.hq) this.posts.set('hq', { key: 'hq', x: this.hq[0], z: this.hq[1], w: 2 });
    if (this.refinery) this.posts.set('ref', { key: 'ref', x: this.refinery[0], z: this.refinery[1], w: 2.5 });
    for (const f of this.ownFields) this.posts.set(`f${f.id}`, { key: `f${f.id}`, x: f.x, z: f.z, w: 1 + f.output / 60 });
    if (this.P.guardBridges) {
      let n = 0;
      for (const edge of this.sabCache.own) {
        if (n++ >= 2) break;
        const e = this.ctx.graph.edges[edge];
        if (!e || !e.open) continue;
        const p = this.ctx.graph.pointOnEdge(edge, 0.5);
        this.posts.set(`b${edge}`, { key: `b${edge}`, x: p[0], z: p[1], w: 0.8 });
      }
    }
  }

  // ================================================================== Wirtschaft

  private economyPlan(): void {
    const { economy } = this.ctx;
    const a3 = this.a3;
    const P = this.P;
    const c = this.comp;
    const armed = this.own.filter((u) => u.type.damage > 0).length;
    this.econ.setReserve(a3, P.reserveBarrels + armed * 0.4);
    const w: Record<string, number> = this.weights;
    const defender = this.style === 'defender';
    const set = (id: string, v: number) => { w[id] = v; };
    set('inf_squad', defender ? 18 : 13); set('at_team', 6); set('mg_team', 4); set('mortar_team', 3); set('engineer_squad', 0);
    set('mbt_medium', defender ? 11 : 16); set('mbt_heavy', defender ? 4 : 6); set('light_tank', 3); set('ifv', 11); set('apc_wheeled', 4); set('recon_wheeled', P.raidGroups > 0 ? 6 : 3);
    set('sp_artillery', defender ? 8 : 6); set('mlrs', 2); set('spaa', 3); set('sam', 0); set('supply_truck', 0);
    set('attack_heli', 0); set('fighter', 0); set('bomber', 0); set('sniper_team', 0);
    const hasAirfield = economy.countBases(a3, 'airfield') > 0;
    if (hasAirfield && P.airSorties) { set('attack_heli', 6); set('fighter', 2); set('bomber', defender ? 0 : 1.5); }
    if (P.counters && c.total > 20) {
      const t = c.tank / c.total, i = c.inf / c.total, ar = c.air / c.total;
      w.at_team += 12 * t; w.mbt_heavy += 8 * t; w.attack_heli += hasAirfield ? 8 * t : 0; w.ifv += 2 * t;
      w.mg_team += 8 * i; w.light_tank += 6 * i; w.ifv += 6 * i; w.mortar_team += 4 * i; w.mbt_medium += 4 * i;
      if (ar > 0.04) { w.spaa += 5 + 20 * ar; w.sam += (ar > 0.12 ? 3 : 0); w.fighter += hasAirfield ? 4 * ar * 10 : 0; }
    } else if (c.air > 0 && P.airSorties) { w.spaa += 3; }
    // Pioniere & Nachschub: Bedarf direkt bestellen
    const engs = this.own.filter((u) => u.type.id === 'engineer_squad').length;
    if (engs < P.engineers) this.econ.requestUnits(a3, 'engineer_squad', P.engineers - engs);
    const trucks = this.own.filter((u) => u.type.id === 'supply_truck').length;
    if (trucks < 2 + Math.floor(armed / 25)) this.econ.requestUnits(a3, 'supply_truck', 1);
    this.econ.setPriorities(a3, w);
    // Reiche KI baut Front-/Zusatzbasen
    const pool = economy.pool(a3).barrels;
    if (pool > P.richBarrels && this.hq) {
      const frontKm = Math.hypot(this.staging[0] - this.hq[0], this.staging[1] - this.hq[1]);
      if (economy.countBases(a3, 'depot') < 2 && frontKm > 3) this.econ.requestBase(a3, 'depot', this.staging[0], this.staging[1], 6);
      else if (economy.countBases(a3, 'factory') < 2) this.econ.requestBase(a3, 'factory', this.hq[0], this.hq[1], 12);
      else if (P.airSorties && !hasAirfield && pool > P.richBarrels + 150) this.econ.requestBase(a3, 'airfield', this.hq[0], this.hq[1], 12);
      else if (economy.countBases(a3, 'barracks') < 2) this.econ.requestBase(a3, 'barracks', this.hq[0], this.hq[1], 12);
    }
  }
  private readonly weights: Record<string, number> = {};

  // ================================================================== Takt 1: Boden

  private pruneGroup(g: BattleGroup): void {
    let n = 0;
    for (let i = 0; i < g.ids.length; i++) {
      const u = this.ctx.units.get(g.ids[i]);
      if (u && u.hp > 0 && u.owner === this.a3) g.ids[n++] = g.ids[i];
      else { this.groupOf.delete(g.ids[i]); this.postOf.delete(g.ids[i]); }
    }
    g.ids.length = n;
  }

  private addTo(g: BattleGroup, id: number): void {
    const old = this.groupOf.get(id);
    if (old === g) return;
    if (old) { const k = old.ids.indexOf(id); if (k >= 0) old.ids.splice(k, 1); }
    g.ids.push(id);
    this.groupOf.set(id, g);
    this.postOf.delete(id);
  }

  private unitsOf(g: BattleGroup, out: Unit[]): Unit[] {
    out.length = 0;
    for (const id of g.ids) { const u = this.ctx.units.get(id); if (u && u.hp > 0) out.push(u); }
    return out;
  }

  private strengthOfGroup(g: BattleGroup): number {
    let s = 0;
    for (const id of g.ids) { const u = this.ctx.units.get(id); if (u) s += strengthOf(u); }
    return s;
  }

  /** Neue Einheiten Rollen zuteilen */
  private assign(): void {
    const groups = [this.defense, this.strike, this.reserve, this.support, this.air, this.naval, this.raidPool, ...this.raids];
    for (const g of groups) this.pruneGroup(g);
    let core = 0;
    for (const u of this.own) if (GROUND_CORE.has(u.type.category) && u.type.damage > 0) core++;
    const P = this.P;
    const frac = this.style === 'defender' ? Math.max(P.defenseFrac, 0.55) : P.defenseFrac;
    const quota = Math.max(P.minDefenders, Math.ceil(core * frac));
    const sst = this.strike.state;
    const intake = sst === 'assemble' || sst === 'idle' || sst === 'alert' ? this.strike : this.reserve;
    for (const u of this.own) {
      if (this.groupOf.has(u.id)) continue;
      const t = u.type, cat = t.category;
      if (t.id === 'engineer_squad' || t.id === 'medic_team' || (t.damage <= 0 && cat !== 'helicopter' && cat !== 'jet')) continue;
      if (cat === 'artillery' && t.id !== 'mortar_team') { this.addTo(this.support, u.id); continue; }
      if (t.id === 'mortar_team') { this.addTo(this.support, u.id); continue; }
      if (cat === 'helicopter' || cat === 'jet' || cat === 'drone') { if (t.damage > 0) this.addTo(this.air, u.id); continue; }
      if (cat === 'naval') { this.addTo(this.naval, u.id); if (!this.navalHome.has(u.id)) this.navalHome.set(u.id, [u.x, u.z]); continue; }
      if (cat === 'aa') { this.addTo(t.id === 'sam' || this.defense.ids.length < quota + 2 ? this.defense : intake, u.id); continue; }
      if (t.damage <= 0 || !GROUND_CORE.has(cat)) continue;
      if (isFoot(u)) { this.addTo(this.defense.ids.length < quota * 1.3 ? this.defense : intake, u.id); continue; }
      if (P.raidGroups > 0 && isFast(u) && this.raidPool.ids.length + this.raids.reduce((s, r) => s + r.ids.length, 0) < P.raidGroups * 4 && this.style === 'aggressor') { this.addTo(this.raidPool, u.id); continue; }
      this.addTo(this.defense.ids.length < quota ? this.defense : intake, u.id);
    }
    // gelegentlich ausgleichen: Überhang der Verteidigung wandert zur Hauptmacht (nur ohne Alarm)
    if (this.time >= this.nextRebalance && !this.alert) {
      this.nextRebalance = this.time + 2;
      let extra = this.defense.ids.length - Math.ceil(quota * 1.4);
      for (let i = this.defense.ids.length - 1; i >= 0 && extra > 0; i--) {
        const u = this.ctx.units.get(this.defense.ids[i]);
        if (!u || isFoot(u) || u.type.category === 'aa' || this.postOf.get(u.id)?.startsWith('f')) continue;
        this.addTo(intake, u.id);
        extra--;
      }
    }
  }

  private phaseGround(): void {
    this.assign();
    this.manageDefense();
    if (this.style === 'defender') this.manageDefenderStrike(); else this.manageStrike();
    this.manageReserve();
    this.manageSupport();
  }

  // ------------------------------------------------------------------ Verteidigung

  private manageDefense(): void {
    const g = this.defense;
    if (!g.ids.length) return;
    const alert = this.alert;
    if (alert) {
      // alle Verteidiger innerhalb 45 km reagieren
      const ids = this.tmpIds;
      ids.length = 0;
      for (const id of g.ids) {
        const u = this.ctx.units.get(id);
        if (!u || u.type.category === 'aa' && u.type.id === 'sam') continue;
        if (Math.hypot(u.x - alert.x, u.z - alert.z) > 45) continue;
        const o = u.orders[0];
        if (o && o.kind === 'attackMove' && Math.hypot(o.x - alert.x, o.z - alert.z) < 4) continue;
        if (o && (o.kind === 'attack' || o.kind === 'fireAt')) continue;
        ids.push(id);
      }
      if (ids.length) {
        // Fuß- und Fahrzeugtruppen getrennt (Marschgeschwindigkeit)
        const feet = this.tmpIds2, fast = this.tmpIds3;
        feet.length = 0; fast.length = 0;
        for (const id of ids) { const u = this.ctx.units.get(id)!; (isFoot(u) ? feet : fast).push(id); }
        this.move(fast, alert.x, alert.z, 'attackMove');
        this.move(feet, alert.x, alert.z, 'attackMove');
      }
      setState(g, 'alert', this.time);
      return;
    }
    if (g.state === 'alert' && this.time - this.calmSince < 1) return; // Entwarnung abwarten
    g.state = 'idle';
    // Posten zuweisen und anlaufen
    if (!this.posts.size) return;
    this.byPost.clear();
    for (const id of g.ids) {
      const u = this.ctx.units.get(id);
      if (!u) continue;
      let key = this.postOf.get(id);
      if (!key || !this.posts.has(key)) key = this.choosePost(id);
      if (!key) continue;
      const p = this.posts.get(key)!;
      if (u.orders.length === 0 && Math.hypot(u.x - p.x, u.z - p.z) > 1.2 || (u.orders.length > 0 && u.orders[0].kind === 'attackMove' && Math.hypot(u.orders[0].x - p.x, u.orders[0].z - p.z) > 3 && !u.engaged)) {
        let arr = this.byPost.get(key);
        if (!arr) this.byPost.set(key, (arr = []));
        arr.push(id);
      }
    }
    for (const [key, ids] of this.byPost) {
      const p = this.posts.get(key)!;
      if (!this.move(ids, p.x + (this.rnd() - 0.5) * 0.8, p.z + (this.rnd() - 0.5) * 0.8)) break;
    }
  }

  private choosePost(id: number): string | undefined {
    const counts = this.invMap;
    counts.clear();
    for (const [uid, key] of this.postOf) if (uid !== id) counts.set(key, (counts.get(key) ?? 0) + 1);
    let best: string | undefined, bv = Infinity;
    for (const [key, p] of this.posts) {
      const v = (counts.get(key) ?? 0) / p.w;
      if (v < bv) { bv = v; best = key; }
    }
    if (best) this.postOf.set(id, best);
    return best;
  }

  // ------------------------------------------------------------------ Hauptmacht

  private hostileBasesOf(kind: 'refinery' | 'hq'): Array<{ id: number; x: number; z: number; owner: string }> {
    const out: Array<{ id: number; x: number; z: number; owner: string }> = [];
    for (const b of this.ctx.economy.bases.values()) if (b.kind === kind && b.progress >= 1 && this.isEnemy(b.owner)) out.push(b);
    return out;
  }

  private blocked(key: string): boolean {
    const t = this.blacklist.get(key);
    return t !== undefined && t > this.time;
  }

  /** Bestes Angriffsziel für die Hauptmacht (Straßenentfernung, Wert, Verteidigung) */
  private pickObjective(ownStrength: number): Objective | null {
    if (!this.hq) return null;
    const { map } = this;
    const P = this.P;
    let best: Objective | null = null, bs = 0;
    const from = this.staging;
    const consider = (kind: Objective['kind'], key: string, id: number, name: string, x: number, z: number, value: number, owner: string) => {
      if (this.blocked(key)) return;
      const km = this.planner.roadKm(from[0], from[1], x, z);
      if (!isFinite(km)) { this.blacklist.set(key, this.time + 6); return; }
      const guard = map.enemyNear(x, z, 7);
      if (ownStrength < guard * P.minRatio) return;
      const s = (value / (1 + km / 60)) * Math.min(2, ownStrength / (guard * P.minRatio + 10));
      if (s > bs) { bs = s; best = { kind, x, z, id, name, commitUntil: this.time + P.commitHours, ownerAtStart: owner }; }
    };
    for (const f of this.targetFields) {
      const v = (10 + f.output * 0.25) * (f.owner ? 1.4 : 1);
      consider('field', `f${f.id}`, f.id, f.name, f.x, f.z, v, f.owner);
    }
    // Raffinerie/HQ erst, wenn Feldziele knapp sind oder die KI klar überlegen ist
    const ready = this.stats.waves >= 1 || this.targetFields.length === 0;
    if (ready) {
      for (const b of this.hostileBasesOf('refinery')) consider('refinery', `r${b.id}`, b.id, `Raffinerie ${b.owner}`, b.x, b.z, 55, b.owner);
      for (const b of this.hostileBasesOf('hq')) consider('hq', `h${b.id}`, b.id, `HQ ${b.owner}`, b.x, b.z, 45, b.owner);
    }
    return best;
  }

  private manageStrike(): void {
    const g = this.strike;
    const P = this.P;
    const units = this.unitsOf(g, this.tmpA);
    const now = this.time;
    // Alarm am HQ/Raffinerie: Hauptmacht heimrufen (nicht mitten im Sturm auf ein Ziel)
    const alert = this.alert;
    if (alert && alert.hq && g.state !== 'alert' && g.state !== 'assault' && units.length) {
      const own = this.map.ownNear(alert.x, alert.z, 12);
      if (alert.e > own * 0.8) { setState(g, 'alert', now); g.obj = null; }
    }
    if (g.state === 'alert') {
      if (alert) {
        const ids = this.tmpIds; ids.length = 0;
        for (const u of units) if (!isFoot(u)) ids.push(u.id);
        if (now - g.lastOrderAt > 0.6 && this.move(ids, alert.x, alert.z, 'attackMove')) g.lastOrderAt = now;
      } else if (now - this.calmSince > 1) setState(g, 'assemble', now);
      return;
    }
    if (!units.length) { if (g.state !== 'assemble') setState(g, 'assemble', now); return; }
    centroid(units, this.cen);
    const strength = this.strengthOfGroup(g);
    switch (g.state) {
      case 'assemble': case 'idle': {
        // sammeln
        const idle = this.tmpIds; idle.length = 0;
        let ready = 0, readyS = 0, core = 0;
        for (const u of units) {
          if (u.type.category !== 'aa') core++;
          const d = Math.hypot(u.x - this.staging[0], u.z - this.staging[1]);
          if (d < 8) { ready++; readyS += strengthOf(u); } else if (u.orders.length === 0) idle.push(u.id);
        }
        if (idle.length && now - g.lastOrderAt > 0.5) { if (this.move(idle, this.staging[0] + (this.rnd() - 0.5) * 3, this.staging[1] + (this.rnd() - 0.5) * 3)) g.lastOrderAt = now; }
        const progress = Math.min(1, Math.max(0, (now - P.firstWaveHours) / 20));
        const target = Math.round(P.waveMin + (P.waveMax - P.waveMin) * progress);
        const waited = now - g.since;
        const enough = ready >= target || (waited > 6 && ready >= P.waveMin);
        if (now < this.nextWaveAt || !enough || core < P.waveMin) break;
        const obj = this.pickObjective(readyS);
        if (!obj) break;
        this.launch(g, obj, units, strength);
        break;
      }
      case 'advance': case 'assault': {
        const obj = g.obj;
        if (!obj) { setState(g, 'regroup', now); break; }
        // Erfolg / Ende
        if (this.objectiveDone(obj)) { this.onObjectiveDone(g, units); break; }
        // Rückzug prüfen
        const local = this.map.enemyNear(this.cen[0], this.cen[1], 6);
        let am = 0, an = 0;
        for (const u of units) if (!isFoot(u) && u.type.ammo > 0) { am += u.ammo / u.type.ammo; an++; }
        const weak = strength < g.startStrength * P.retreatFrac || (an > 3 && am / an < 0.12);
        const outgunned = local > 30 && local > strength * P.retreatEnemyRatio;
        if (weak || outgunned) { this.beginRetreat(g, units, obj); break; }
        const dObj = Math.hypot(this.cen[0] - obj.x, this.cen[1] - obj.z);
        if (g.state === 'advance' && dObj < 3) setState(g, 'assault', now);
        if (g.state === 'assault' && now - g.since > 5) { this.blacklist.set(this.objKey(obj), now + 10); this.beginRetreat(g, units, obj); break; }
        if (now - g.lastOrderAt >= 0.5 || g.lastOrderAt < 0) this.driveToObjective(g, units, obj);
        break;
      }
      case 'retreat': {
        const dep = this.nearestDepot(this.cen[0], this.cen[1]);
        const d = dep ? Math.hypot(this.cen[0] - dep[0], this.cen[1] - dep[1]) : 0;
        if (d < 4 || now - g.since > 3) { setState(g, 'regroup', now); }
        break;
      }
      case 'regroup': {
        let am = 0, n = 0;
        for (const u of units) { am += Math.min(u.ammo / Math.max(1, u.type.ammo), u.fuel / Math.max(1, u.type.fuelKm)); n++; }
        const ok = n === 0 || am / n > 0.6;
        if (ok || now - g.since > 3) {
          // schwer beschädigte Einheiten bleiben als Reserve daheim
          for (const u of units) if (u.hp < u.type.hp * 0.35) this.addTo(this.defense, u.id);
          g.obj = null;
          setState(g, 'assemble', now);
          const ids = this.tmpIds; ids.length = 0;
          for (const u of units) if (this.groupOf.get(u.id) === g) ids.push(u.id);
          this.move(ids, this.staging[0], this.staging[1]);
        }
        break;
      }
      default: break;
    }
  }

  /** Reserve: sammelt am Sammelpunkt; schließt als Paket zur Hauptmacht auf (kein tröpfchenweiser Nachschub) */
  private manageReserve(): void {
    const r = this.reserve, s = this.strike;
    if (!r.ids.length) return;
    const units = this.unitsOf(r, this.tmpB);
    const idle = this.tmpIds; idle.length = 0;
    let near = 0;
    for (const u of units) {
      if (Math.hypot(u.x - this.staging[0], u.z - this.staging[1]) < 8) near++;
      else if (u.orders.length === 0) idle.push(u.id);
    }
    if (idle.length && this.time - r.lastOrderAt > 0.5 && this.move(idle, this.staging[0] + (this.rnd() - 0.5) * 3, this.staging[1] + (this.rnd() - 0.5) * 3)) r.lastOrderAt = this.time;
    const mid = s.state === 'advance' || s.state === 'assault';
    const merge = s.state === 'assemble' || s.state === 'idle' || (mid && near >= Math.max(4, Math.floor(this.P.waveMin / 2)) && near >= units.length * 0.7);
    if (!merge) return;
    const add = this.strengthOfGroup(r);
    for (const id of r.ids.slice()) this.addTo(s, id);
    if (mid) { s.startStrength += add; s.lastOrderAt = -99; }
  }

  private objKey(o: Objective): string {
    return o.kind === 'field' ? `f${o.id}` : o.kind === 'refinery' ? `r${o.id}` : o.kind === 'hq' ? `h${o.id}` : `p${Math.round(o.x / 4)}_${Math.round(o.z / 4)}`;
  }

  private launch(g: BattleGroup, obj: Objective, units: Unit[], strength: number): void {
    g.obj = obj;
    g.wave++;
    g.footOk = this.planner.roadKm(this.staging[0], this.staging[1], obj.x, obj.z, this.planner.prof.foot) < 40;
    g.startStrength = strength;
    this.stats.waves++;
    setState(g, 'advance', this.time);
    this.driveToObjective(g, units, obj, true);
  }

  /** attackMove der Hauptmacht auf das Ziel; Fahrzeuge und Fußtruppen getrennt (Gruppentempo) */
  private driveToObjective(g: BattleGroup, units: Unit[], obj: Objective, force = false): void {
    const fast = this.tmpIds, foot = this.tmpIds2;
    fast.length = 0; foot.length = 0;
    const footOk = g.footOk;
    for (const u of units) {
      const o = u.orders[0];
      const needs = force || !o || (o.kind !== 'attack' && o.kind !== 'fireAt' && !(o.kind === 'attackMove' && Math.hypot(o.x - obj.x, o.z - obj.z) < 3));
      if (!needs) continue;
      if (isFoot(u)) { if (footOk) foot.push(u.id); } else fast.push(u.id);
    }
    // Basisziele: aus Reichweite auf die Anlage feuern, sobald nah genug und kein Feind in der Nähe
    if (g.state === 'assault' && (obj.kind === 'refinery' || obj.kind === 'hq') && this.map.enemyNear(this.cen[0], this.cen[1], 4) < 8) {
      const f = this.tmpIds3; f.length = 0;
      for (const u of units) if (Math.hypot(u.x - obj.x, u.z - obj.z) <= u.type.rangeKm * 0.95 && u.type.damage > 0 && u.type.category !== 'aa') f.push(u.id);
      if (f.length && this.canOrder() && !this.cityNear(obj.x, obj.z, 1.5)) { this.orders++; this.ctx.combat.orderFireAt(f, obj.x, obj.z); }
    }
    const a = this.move(fast, obj.x, obj.z, 'attackMove');
    const b = this.move(foot, obj.x, obj.z, 'attackMove');
    if (a || b || force) g.lastOrderAt = this.time;
  }

  private objectiveDone(o: Objective): boolean {
    const { economy } = this.ctx;
    if (o.kind === 'field') {
      const f = economy.fields.find((q) => q.id === o.id);
      return !f || f.owner === this.a3 || (f.owner !== '' && this.isAlly(f.owner)) || f.integrity < 0.05;
    }
    const b = economy.bases.get(o.id);
    return !b || !this.isEnemy(b.owner);
  }

  private onObjectiveDone(g: BattleGroup, units: Unit[]): void {
    const o = g.obj!;
    // Feld: Besatzung zurücklassen
    if (o.kind === 'field') {
      const f = this.ctx.economy.fields.find((q) => q.id === o.id);
      if (f && f.owner === this.a3) {
        let left = 0;
        for (const u of units) {
          if (left >= 2) break;
          if (u.type.category === 'aa' || Math.hypot(u.x - o.x, u.z - o.z) > 3) continue;
          this.addTo(this.defense, u.id);
          this.postOf.set(u.id, `f${f.id}`);
          left++;
        }
      }
    }
    const strength = this.strengthOfGroup(g);
    g.obj = null;
    const next = strength >= g.startStrength * 0.55 ? this.pickObjective(strength) : null;
    if (next) {
      g.obj = next;
      g.startStrength = Math.max(strength, g.startStrength * 0.8);
      setState(g, 'advance', this.time);
      this.driveToObjective(g, this.unitsOf(g, this.tmpA), next, true);
    } else {
      this.nextWaveAt = this.time + this.P.waveCooldown;
      setState(g, 'regroup', this.time);
      const dep = this.nearestDepot(this.cen[0], this.cen[1]);
      const ids = this.tmpIds; ids.length = 0;
      for (const id of g.ids) ids.push(id);
      if (dep) this.move(ids, dep[0], dep[1], 'move');
    }
  }

  private beginRetreat(g: BattleGroup, units: Unit[], obj: Objective): void {
    this.blacklist.set(this.objKey(obj), this.time + 8);
    this.nextWaveAt = this.time + this.P.waveCooldown;
    g.obj = null;
    setState(g, 'retreat', this.time);
    const dep = this.nearestDepot(this.cen[0], this.cen[1]) ?? this.hq;
    const ids = this.tmpIds; ids.length = 0;
    for (const u of units) ids.push(u.id);
    if (dep) { this.canOrderForce(); this.ctx.units.issueMove(ids, dep[0], dep[1], { kind: 'retreat' }); }
  }

  /** Rückzug darf das Befehlsbudget überschreiten (Notfall) */
  private canOrderForce(): void { this.orders++; }

  private nearestDepot(x: number, z: number): [number, number] | null {
    let best: [number, number] | null = null, bd = Infinity;
    for (const b of this.ctx.economy.bases.values()) {
      if (b.owner !== this.a3 || b.progress < 1 || !SUPPLY_KINDS.has(b.kind) || b.kind === 'airfield' || b.kind === 'shipyard') continue;
      const d = Math.hypot(b.x - x, b.z - z);
      if (d < bd) { bd = d; best = [b.x, b.z]; }
    }
    return best;
  }

  // ------------------------------------------------------------------ Verteidiger-Stil (z. B. MAR)

  /** Gegenangriffe nur auf Bedrohungen eigener/verbündeter Anlagen oder nahe Felder; sonst am Sammelpunkt bleiben */
  private manageDefenderStrike(): void {
    const g = this.strike;
    const now = this.time;
    const units = this.unitsOf(g, this.tmpA);
    if (!units.length) { setState(g, 'assemble', now); g.obj = null; return; }
    centroid(units, this.cen);
    const strength = this.strengthOfGroup(g);
    if (g.state === 'assemble' || g.state === 'idle' || g.state === 'alert') {
      const idle = this.tmpIds; idle.length = 0;
      for (const u of units) if (u.orders.length === 0 && Math.hypot(u.x - this.staging[0], u.z - this.staging[1]) > 6) idle.push(u.id);
      if (idle.length && now - g.lastOrderAt > 0.5 && this.move(idle, this.staging[0] + (this.rnd() - 0.5) * 3, this.staging[1] + (this.rnd() - 0.5) * 3)) g.lastOrderAt = now;
      if (strength < 30) return;
      // Ziel: Bedrohung (Alarm) bzw. Feindfeld im Umkreis eigener Felder
      let obj: Objective | null = null;
      const a = this.alert;
      if (a && this.map.enemyNear(a.x, a.z, 6) * this.P.minRatio < strength) obj = { kind: 'point', x: a.x, z: a.z, id: 0, name: 'Bedrohung', commitUntil: now + this.P.commitHours, ownerAtStart: '' };
      else if (now >= this.nextWaveAt) {
        let bs = 0;
        for (const f of this.targetFields) {
          if (!f.owner && false) continue;
          let near = Infinity;
          for (const o of this.ownFields) near = Math.min(near, Math.hypot(o.x - f.x, o.z - f.z));
          if (this.hq) near = Math.min(near, Math.hypot(this.hq[0] - f.x, this.hq[1] - f.z));
          if (near > DEFENDER_RANGE_KM || this.blocked(`f${f.id}`)) continue;
          const guard = this.map.enemyNear(f.x, f.z, 7);
          if (strength < guard * this.P.minRatio) continue;
          const km = this.planner.roadKm(this.staging[0], this.staging[1], f.x, f.z);
          if (!isFinite(km)) continue;
          const s = (10 + f.output * 0.25) / (1 + km / 40);
          if (s > bs) { bs = s; obj = { kind: 'field', x: f.x, z: f.z, id: f.id, name: f.name, commitUntil: now + this.P.commitHours, ownerAtStart: f.owner }; }
        }
      }
      if (obj && units.length >= Math.min(this.P.waveMin, 4)) {
        g.obj = obj; g.wave++; g.startStrength = strength; this.stats.waves++;
        setState(g, 'advance', now);
        this.driveToObjective(g, units, obj, true);
      }
      return;
    }
    // laufender Gegenangriff
    const obj = g.obj;
    if (!obj) { setState(g, 'regroup', now); return; }
    const done = obj.kind === 'point' ? this.map.enemyNear(obj.x, obj.z, 8) < 5 && now - g.since > 0.5 : this.objectiveDone(obj);
    const local = this.map.enemyNear(this.cen[0], this.cen[1], 6);
    if (done) { g.obj = null; this.nextWaveAt = now + this.P.waveCooldown * 0.5; setState(g, 'regroup', now); const ids = this.tmpIds; ids.length = 0; for (const u of units) ids.push(u.id); this.move(ids, this.staging[0], this.staging[1]); return; }
    if (g.state === 'regroup') { if (now - g.since > 2) setState(g, 'assemble', now); return; }
    if (strength < g.startStrength * this.P.retreatFrac || (local > 30 && local > strength * this.P.retreatEnemyRatio)) { this.beginRetreat(g, units, obj); return; }
    if (g.state === 'retreat') { if (now - g.since > 2.5) setState(g, 'regroup', now); return; }
    if (now - g.lastOrderAt >= 0.5) this.driveToObjective(g, units, obj);
  }

  // ------------------------------------------------------------------ Artillerie

  private cityNear(x: number, z: number, r: number): boolean {
    return !!this.ctx.civil.cityAt(x, z, r);
  }

  private manageSupport(): void {
    const g = this.support;
    const units = this.unitsOf(g, this.tmpA);
    if (!units.length) return;
    const now = this.time;
    centroid(units, this.cen);
    const cx = this.cen[0], cz = this.cen[1];
    // Nachladen: leere Geschütze zum Depot
    const dep = this.nearestDepot(cx, cz);
    const dry = this.tmpIds; dry.length = 0;
    for (const u of units) {
      const f = u.ammo / Math.max(1, u.type.ammo);
      if (f < 0.15 && !this.rearm.has(u.id)) { this.rearm.add(u.id); dry.push(u.id); } else if (f > 0.7) this.rearm.delete(u.id);
    }
    if (dry.length && dep) { this.canOrderForce(); this.ctx.combat.stopFiring(dry); this.ctx.units.issueMove(dry, dep[0], dep[1], { kind: 'retreat' }); }
    // Stellung: hinter der Hauptmacht, sonst Sammelpunkt/Alarm
    const st = this.strike;
    let px = this.staging[0], pz = this.staging[1];
    if ((st.state === 'advance' || st.state === 'assault') && st.ids.length) {
      const sc = this.cen2(st);
      if (sc) { const back = this.hq ? Math.atan2(this.hq[1] - sc[1], this.hq[0] - sc[0]) : 0; px = sc[0] + Math.cos(back) * 3; pz = sc[1] + Math.sin(back) * 3; }
    } else if (this.alert && this.hq) { px = this.hq[0]; pz = this.hq[1]; }
    const far = this.tmpIds2; far.length = 0;
    for (const u of units) {
      if (this.rearm.has(u.id)) continue;
      const o = u.orders[0];
      if (!o) { if (Math.hypot(u.x - px, u.z - pz) > 5) far.push(u.id); } else if (o.kind === 'move' && Math.hypot(o.x - px, o.z - pz) > 12) far.push(u.id);
    }
    if (far.length && now - g.lastOrderAt > 0.5 && this.move(far, px, pz)) g.lastOrderAt = now;
    // Feuermissionen
    if (!this.P.fireMissions) return;
    let maxR = 0;
    for (const u of units) if (!this.rearm.has(u.id)) maxR = Math.max(maxR, u.type.rangeKm * 0.9);
    if (maxR <= 0) return;
    const accept = (x: number, z: number) => !this.cityNear(x, z, 2) && this.map.ownNear(x, z, 2) < 1;
    const have = this.map.peakEnemy(cx, cz, Math.min(maxR, 60), 25, this.peak, accept);
    if (!have) {
      if (g.fireAt > 0 && now - g.fireAt > 0.4) {
        const ids = this.tmpIds3; ids.length = 0;
        for (const id of g.ids) ids.push(id);
        this.ctx.combat.stopFiring(ids);
        g.fireAt = -99;
      }
      return;
    }
    if (g.fireAt > 0 && Math.hypot(g.fireX - this.peak[0], g.fireZ - this.peak[1]) < 2 && now - g.fireAt < 0.6) return;
    const ids = this.tmpIds3; ids.length = 0;
    for (const u of units) {
      if (this.rearm.has(u.id) || u.ammo < 1) continue;
      if (Math.hypot(u.x - this.peak[0], u.z - this.peak[1]) <= u.type.rangeKm * 0.9) ids.push(u.id);
    }
    if (ids.length && this.canOrder()) {
      this.orders++;
      this.ctx.combat.orderFireAt(ids, this.peak[0], this.peak[1]);
      g.fireX = this.peak[0]; g.fireZ = this.peak[1]; g.fireAt = now;
      this.stats.fireMissions++;
    }
  }

  private cen2(g: BattleGroup): [number, number] | null {
    const u = this.unitsOf(g, this.tmpB);
    const out: [number, number] = [0, 0];
    return centroid(u, out) ? out : null;
  }

  // ================================================================== Takt 2: Spezial

  private phaseSpecial(): void {
    this.manageRaids();
    this.manageAir();
    this.manageNaval();
    this.manageEngineers();
  }

  // ------------------------------------------------------------------ Überfälle

  private tankersNow(): void {
    const m = this.tankerCargo;
    m.clear();
    for (const o of this.ctx.war.enemiesOf(this.a3)) for (const c of this.ctx.economy.convoysOf(o)) if (c.kind === 'oil') m.set(c.unitId, c.cargo);
  }

  private raidTarget(g: BattleGroup | null, x: number, z: number, strength: number, out: { unit: number; field: OilFieldInfo | null; x: number; z: number; name: string }): boolean {
    let bs = 0, found = false;
    const taken = this.tmpIds3;
    taken.length = 0;
    for (const r of this.raids) if (r !== g && r.targetUnit) taken.push(r.targetUnit);
    for (const k of this.knownList) {
      if (k.typeId !== 'tanker_truck' || taken.includes(k.id)) continue;
      const cargo = this.tankerCargo.get(k.id) ?? 0;
      if (cargo <= 0) continue;
      const guard = this.map.enemyNear(k.x, k.z, 5);
      if (guard > strength * 0.7) continue;
      const d = Math.hypot(k.x - x, k.z - z);
      if (d > 140) continue;
      const km = this.planner.roadKm(x, z, k.x, k.z, this.planner.prof.heavy);
      if (!isFinite(km)) continue;
      const s = (cargo + 40) / (km + 25);
      if (s > bs) { bs = s; found = true; out.unit = k.id; out.field = null; out.x = k.x; out.z = k.z; out.name = `Konvoi ${k.id}`; }
    }
    if (found) return true;
    for (const f of this.targetFields) {
      if (!f.owner || this.blocked(`rf${f.id}`)) continue;
      const guard = this.map.enemyNear(f.x, f.z, 6);
      if (guard > strength * 0.5) continue;
      const km = this.planner.roadKm(x, z, f.x, f.z, this.planner.prof.heavy);
      if (!isFinite(km)) continue;
      const s = (25 + f.output / 2) / (km + 30) * 0.7;
      if (s > bs) { bs = s; found = true; out.unit = 0; out.field = f; out.x = f.x; out.z = f.z; out.name = f.name; }
    }
    return found;
  }

  private readonly rt = { unit: 0, field: null as OilFieldInfo | null, x: 0, z: 0, name: '' };

  private manageRaids(): void {
    const P = this.P, now = this.time;
    if (P.raidGroups <= 0 || this.style === 'defender') return;
    this.tankersNow();
    // aktive Raids
    for (let i = this.raids.length - 1; i >= 0; i--) {
      const g = this.raids[i];
      this.pruneGroup(g);
      const units = this.unitsOf(g, this.tmpA);
      if (units.length === 0) { this.raids.splice(i, 1); continue; }
      centroid(units, this.cen);
      const strength = this.strengthOfGroup(g);
      if (g.state === 'raid') {
        let done = false;
        if (g.targetUnit) {
          const t = this.ctx.units.get(g.targetUnit);
          if (!t || t.hp <= 0) { done = true; }
          else if (now - g.lastOrderAt > 0.8) {
            const stale = units.some((u) => !u.targetId && u.orders.length === 0);
            if (stale && this.canOrder()) { this.orders++; this.ctx.combat.orderAttack(g.ids, g.targetUnit); g.lastOrderAt = now; }
          }
        } else if (g.obj) {
          const f = this.ctx.economy.fields.find((q) => q.id === g.obj!.id);
          if (!f || f.owner === this.a3 || f.integrity < 0.05) done = true;
          else if (now - g.lastOrderAt > 0.8) this.move(g.ids, f.x, f.z, 'attackMove') && (g.lastOrderAt = now);
        } else done = true;
        const lost = strength < g.startStrength * 0.5;
        if (lost || now - g.since > 6) { this.endRaid(g, units); continue; }
        if (done) {
          // nächstes Ziel suchen
          if (g.obj) { const f = this.ctx.economy.fields.find((q) => q.id === g.obj!.id); if (f && f.owner === this.a3) { this.garrisonRaiders(g, f, units); this.raids.splice(i, 1); continue; } }
          const rt = this.rt;
          if (this.raidTarget(g, this.cen[0], this.cen[1], strength, rt)) this.assignRaidTarget(g, rt);
          else this.endRaid(g, units);
        }
      } else if (g.state === 'return') {
        const dep = this.nearestDepot(this.cen[0], this.cen[1]);
        const d = dep ? Math.hypot(this.cen[0] - dep[0], this.cen[1] - dep[1]) : 0;
        if (d < 4 || now - g.since > 3) {
          for (const id of g.ids.slice()) this.addTo(this.raidPool, id);
          this.raids.splice(i, 1);
        }
      }
    }
    // neuer Raid
    if (this.raids.length >= P.raidGroups || now < this.nextRaidAt || this.raidPool.ids.length < P.raidMinUnits) return;
    if (this.alert) return; // erst Heimat sichern
    const pool = this.unitsOf(this.raidPool, this.tmpA);
    const ready = pool.filter((u) => Math.hypot(u.x - this.staging[0], u.z - this.staging[1]) < 12 && u.hp > u.type.hp * 0.6);
    if (ready.length < P.raidMinUnits) {
      const idle = this.tmpIds; idle.length = 0;
      for (const u of pool) if (u.orders.length === 0 && Math.hypot(u.x - this.staging[0], u.z - this.staging[1]) > 6) idle.push(u.id);
      this.move(idle, this.staging[0], this.staging[1]);
      return;
    }
    const sel = ready.slice(0, this.difficulty === 'schwer' ? 5 : 4);
    let s = 0, sx = 0, sz = 0;
    for (const u of sel) { s += strengthOf(u); sx += u.x; sz += u.z; }
    sx /= sel.length; sz /= sel.length;
    const rt = this.rt;
    if (!this.raidTarget(null, sx, sz, s, rt)) { this.nextRaidAt = now + 1; return; }
    const g = newGroup('raid', 'raid', now);
    for (const u of sel) this.addTo(g, u.id);
    g.startStrength = s;
    this.raids.push(g);
    this.stats.raids++;
    this.nextRaidAt = now + P.raidCooldown;
    this.assignRaidTarget(g, rt);
  }

  private assignRaidTarget(g: BattleGroup, rt: { unit: number; field: OilFieldInfo | null; x: number; z: number; name: string }): void {
    g.lastOrderAt = this.time;
    if (rt.unit) {
      g.targetUnit = rt.unit; g.obj = null;
      if (this.canOrder()) { this.orders++; this.ctx.combat.orderAttack(g.ids, rt.unit); }
    } else if (rt.field) {
      g.targetUnit = 0;
      g.obj = { kind: 'field', x: rt.field.x, z: rt.field.z, id: rt.field.id, name: rt.field.name, commitUntil: this.time + 2, ownerAtStart: rt.field.owner };
      this.move(g.ids, rt.field.x, rt.field.z, 'attackMove');
    }
    setState(g, 'raid', g.since);
  }

  private endRaid(g: BattleGroup, units: Unit[]): void {
    void units;
    if (g.obj) this.blacklist.set(`rf${g.obj.id}`, this.time + 4);
    g.targetUnit = 0; g.obj = null;
    setState(g, 'return', this.time);
    const dep = this.nearestDepot(this.cen[0], this.cen[1]) ?? this.hq;
    if (dep) { this.canOrderForce(); this.ctx.combat.stopFiring(g.ids); this.ctx.units.issueMove(g.ids, dep[0], dep[1], { kind: 'retreat' }); }
  }

  private garrisonRaiders(g: BattleGroup, f: OilFieldInfo, units: Unit[]): void {
    void units;
    for (const id of g.ids.slice()) { this.addTo(this.defense, id); this.postOf.set(id, `f${f.id}`); }
  }

  // ------------------------------------------------------------------ Luft

  private aaNear(x: number, z: number, r: number): boolean {
    for (const k of this.knownList) if (k.cat === 'aa' && Math.hypot(k.x - x, k.z - z) < r) return true;
    return false;
  }

  private manageAir(): void {
    const g = this.air;
    const units = this.unitsOf(g, this.tmpA);
    if (!units.length) return;
    const P = this.P, now = this.time;
    const home = this.nearestAirBase(units[0].x, units[0].z) ?? this.hq;
    const retreat = this.tmpIds; retreat.length = 0;
    const ready: { heli: number[]; fighter: number[]; bomber: number[]; fpv: number[] } = { heli: [], fighter: [], bomber: [], fpv: [] };
    for (const u of units) {
      let st = this.airState.get(u.id);
      if (!st) this.airState.set(u.id, (st = { rearm: false, since: now }));
      const am = u.ammo / Math.max(1, u.type.ammo), fu = u.fuel / Math.max(1, u.type.fuelKm);
      if (!st.rearm && (am < 0.2 || fu < 0.25 || u.hp < u.type.hp * 0.4)) { st.rearm = true; st.since = now; retreat.push(u.id); } else if (st.rearm && am > 0.8 && fu > 0.7 && u.hp > u.type.hp * 0.5) st.rearm = false;
      if (st.rearm || !P.airSorties) continue;
      const id = u.type.id;
      if (id === 'attack_heli') ready.heli.push(u.id); else if (id === 'fighter') ready.fighter.push(u.id); else if (id === 'bomber') ready.bomber.push(u.id); else if (id === 'fpv_swarm') ready.fpv.push(u.id);
    }
    if (retreat.length && home) { this.canOrderForce(); this.ctx.combat.stopFiring(retreat); this.ctx.units.issueMove(retreat, home[0], home[1], { kind: 'retreat' }); }
    if (now - g.lastOrderAt < 0.5) return;
    // Hubschrauber: Konvois und Panzer in Frontnähe jagen
    if (ready.heli.length) {
      const hu = this.ctx.units.get(ready.heli[0])!;
      let best: Known | null = null, bs = 0;
      for (const k of this.knownList) {
        if (k.typeId !== 'tanker_truck' && !HEAVY_CATS.has(k.cat)) continue;
        const d = Math.hypot(k.x - hu.x, k.z - hu.z);
        if (d > 130 || this.aaNear(k.x, k.z, 9)) continue;
        const s = (k.typeId === 'tanker_truck' ? 70 : 45) / (d + 20) * (this.map.ownNear(k.x, k.z, 10) > 0 ? 1.5 : 1);
        if (s > bs) { bs = s; best = k; }
      }
      if (best) {
        const idle = ready.heli.filter((id) => { const u = this.ctx.units.get(id)!; return !u.targetId && (u.orders.length === 0 || u.orders[0].kind !== 'attack'); });
        if (idle.length && this.canOrder()) { this.orders++; this.ctx.combat.orderAttack(idle, best.id); g.lastOrderAt = now; }
      }
    }
    if (ready.fighter.length) {
      let tgt: Known | null = null, bd = 150;
      const fu = this.ctx.units.get(ready.fighter[0])!;
      for (const k of this.knownList) { if (!AIR_CATS.has(k.cat)) continue; const d = Math.hypot(k.x - fu.x, k.z - fu.z); if (d < bd) { bd = d; tgt = k; } }
      const idle = ready.fighter.filter((id) => this.ctx.units.get(id)!.orders.length === 0);
      if (tgt && idle.length && this.canOrder()) { this.orders++; this.ctx.combat.orderAttack(idle, tgt.id); g.lastOrderAt = now; }
      else if (idle.length && this.strike.state === 'advance' && this.strike.ids.length) { const c = this.cen2(this.strike); if (c) this.move(idle, c[0], c[1], 'attackMove') && (g.lastOrderAt = now); }
    }
    if (ready.bomber.length && this.canOrder()) {
      const idle = ready.bomber.filter((id) => this.ctx.units.get(id)!.orders.length === 0);
      if (idle.length) {
        const b = this.ctx.units.get(idle[0])!;
        const accept = (x: number, z: number) => !this.cityNear(x, z, 3) && !this.aaNear(x, z, 12);
        if (this.map.peakEnemy(b.x, b.z, 140, 60, this.peak, accept)) { this.orders++; this.ctx.combat.orderFireAt(idle, this.peak[0], this.peak[1]); g.lastOrderAt = now; }
      }
    }
    if (ready.fpv.length && this.alert) {
      const idle = ready.fpv.filter((id) => this.ctx.units.get(id)!.orders.length === 0);
      this.move(idle, this.alert.x, this.alert.z, 'attackMove');
    }
  }

  private nearestAirBase(x: number, z: number): [number, number] | null {
    let best: [number, number] | null = null, bd = Infinity;
    for (const b of this.ctx.economy.bases.values()) {
      if (b.owner !== this.a3 || b.progress < 1 || (b.kind !== 'airfield' && b.kind !== 'hq')) continue;
      const d = Math.hypot(b.x - x, b.z - z) - (b.kind === 'airfield' ? 15 : 0);
      if (d < bd) { bd = d; best = [b.x, b.z]; }
    }
    return best;
  }

  // ------------------------------------------------------------------ Marine

  private manageNaval(): void {
    const units = this.unitsOf(this.naval, this.tmpA);
    if (!units.length) return;
    const now = this.time;
    if (now - this.naval.lastOrderAt < 1) return;
    for (const u of units) {
      if (u.orders.length > 0) continue;
      let best: Known | null = null, bd = 45;
      for (const k of this.knownList) {
        if (k.s <= 0) continue;
        const d = Math.hypot(k.x - u.x, k.z - u.z);
        if (d < bd && (k.cat === 'naval' || d < 14)) { bd = d; best = k; }
      }
      if (best && this.canOrder() && !this.cityNear(best.x, best.z, 3)) { this.orders++; this.ctx.units.issueMove([u.id], best.x, best.z, { kind: 'attackMove' }); this.naval.lastOrderAt = now; continue; }
      const h = this.navalHome.get(u.id);
      if (h && Math.hypot(u.x - h[0], u.z - h[1]) > 10 && this.canOrder()) { this.orders++; this.ctx.units.issueMove([u.id], h[0], h[1]); }
    }
  }

  // ------------------------------------------------------------------ Pioniere / Brücken

  /** Wie oft eine Brücke auf den Konvoirouten (Felder -> Raffinerie) der Nation liegt */
  private refreshSabotage(): void {
    const c = this.sabCache;
    if (this.time - c.at < 3 && c.ver === this.ctx.graph.version) return;
    c.at = this.time; c.ver = this.ctx.graph.version;
    c.edges.clear(); c.own.clear();
    const { economy } = this.ctx;
    const list: number[] = [];
    const routesFor = (owner: string, into: Map<number, number> | Set<number>) => {
      const ref = economy.nearestBase(owner, 'refinery', 0, 0) ?? economy.nearestBase(owner, 'hq', 0, 0);
      if (!ref) return;
      for (const f of economy.fields) {
        if (f.owner !== owner) continue;
        const r = this.planner.route(ref.x, ref.z, f.x, f.z, this.planner.prof.truck);
        if (!r) continue;
        this.planner.bridgesOnRoute(r, list);
        for (const e of list) { if (into instanceof Map) into.set(e, (into.get(e) ?? 0) + f.output); else into.add(e); }
      }
    };
    routesFor(this.a3, c.own);
    for (const o of this.ctx.war.enemiesOf(this.a3)) routesFor(o, c.edges);
    // eigene Angriffsroute nicht kappen
    const obj = this.strike.obj;
    if (obj) {
      const r = this.planner.route(this.staging[0], this.staging[1], obj.x, obj.z);
      if (r) { this.planner.bridgesOnRoute(r, list); for (const e of list) c.own.add(e); }
    }
  }

  private freeEngineers(): Unit[] {
    const out: Unit[] = [];
    for (const u of this.own) if (u.type.id === 'engineer_squad' && !this.engJobs.has(u.id) && u.buildingStructureId === undefined && !this.siteNear(u)) out.push(u);
    return out;
  }

  private manageEngineers(): void {
    const P = this.P, now = this.time;
    const { structures, graph } = this.ctx;
    // Aufträge prüfen
    for (const [id, j] of this.engJobs) {
      const u = this.ctx.units.get(id);
      const e = graph.edges[j.edge];
      const done = j.kind === 'demolish' ? !e.open : e.open;
      if (!u || u.hp <= 0 || done || now - j.since > j.eta * 2 + 3) {
        this.engJobs.delete(id);
        if (j.kind === 'demolish') this.nextSabotageAt = Math.max(this.nextSabotageAt, now + (done ? P.sabotageCooldown : 1));
        if (u && u.hp > 0 && this.hq && this.canOrder()) { this.orders++; this.ctx.units.issueMove([id], this.hq[0] + 0.5, this.hq[1] + 0.5); }
      }
    }
    // Reparatur wichtiger Brücken
    if (P.repairBridges && this.hq) {
      let tries = 0;
      for (const edge of this.downBridges) {
        if (tries >= 2) break;
        const e = graph.edges[edge];
        if (!e || e.open) { this.downBridges.delete(edge); continue; }
        if (this.ourBlown.has(edge)) continue;
        const mid = graph.pointOnEdge(edge, 0.5);
        if (this.repairTaken(edge)) continue;
        if (!this.bridgeMatters(mid[0], mid[1])) continue;
        const eng = this.nearestEngineer(mid[0], mid[1], 20);
        if (!eng) { this.econ.requestUnits(this.a3, 'engineer_squad', 1); continue; }
        tries++;
        structures.orderRepair([eng.u.id], edge);
        this.engJobs.set(eng.u.id, { kind: 'repair', edge, since: now, eta: eng.eta });
      }
    }
    // Sabotage
    if (P.sabotage && now >= this.nextSabotageAt && this.style === 'aggressor') this.trySabotage();
    // freie Pioniere heim
    if (this.hq) {
      const idle = this.tmpIds; idle.length = 0;
      for (const u of this.freeEngineers()) if (u.orders.length === 0 && Math.hypot(u.x - this.hq[0], u.z - this.hq[1]) > 8 && !this.siteNear(u)) idle.push(u.id);
      this.move(idle, this.hq[0] + 1, this.hq[1] + 1);
    }
  }

  private siteNear(u: Unit): boolean {
    for (const b of this.ctx.economy.bases.values()) if (b.owner === this.a3 && b.progress < 1 && Math.hypot(b.x - u.x, b.z - u.z) < 2) return true;
    return false;
  }

  private repairTaken(edge: number): boolean {
    for (const [, j] of this.engJobs) if (j.kind === 'repair' && j.edge === edge) return true;
    return false;
  }

  /** Lohnt die Reparatur? Nahe HQ/Raffinerie/eigenen Feldern, oder zwischen abgeschnittenen Feldern und Raffinerie */
  private bridgeMatters(x: number, z: number): boolean {
    if (this.hq && Math.hypot(x - this.hq[0], z - this.hq[1]) < 35) return true;
    if (this.refinery && Math.hypot(x - this.refinery[0], z - this.refinery[1]) < 35) return true;
    for (const f of this.ownFields) {
      if (Math.hypot(x - f.x, z - f.z) < 20) return true;
      if (f.cutOff && this.refinery && distSeg(x, z, f.x, f.z, this.refinery[0], this.refinery[1]) < 20) return true;
    }
    return false;
  }

  private nearestEngineer(x: number, z: number, maxEta: number): { u: Unit; eta: number } | null {
    let best: Unit | null = null, be = maxEta;
    for (const u of this.freeEngineers()) {
      const straight = Math.hypot(u.x - x, u.z - z) / 5;
      if (straight > maxEta) continue;
      const eta = this.planner.etaHours(u.x, u.z, x, z, this.planner.prof.foot);
      if (eta < be) { be = eta; best = u; }
    }
    return best ? { u: best, eta: be } : null;
  }

  private trySabotage(): void {
    this.refreshSabotage();
    const c = this.sabCache;
    const { graph, structures } = this.ctx;
    let best = -1, bs = -Infinity, bEng: { u: Unit; eta: number } | null = null;
    let n = 0;
    for (const [edge, use] of c.edges) {
      const e = graph.edges[edge];
      if (!e || !e.open || c.own.has(edge) || this.ourBlown.has(edge) || this.blocked(`s${edge}`)) continue;
      if (n++ > 10) break;
      const mid = graph.pointOnEdge(edge, 0.5);
      if (this.map.enemyNear(mid[0], mid[1], 5) > 25) continue;
      const eng = this.nearestEngineer(mid[0], mid[1], this.P.sabotageMaxEta);
      if (!eng) continue;
      const s = use / 10 - eng.eta;
      if (s > bs) { bs = s; best = edge; bEng = eng; }
    }
    if (best < 0 || !bEng) {
      if (!this.freeEngineers().length) this.econ.requestUnits(this.a3, 'engineer_squad', 1);
      this.nextSabotageAt = this.time + 1.5;
      return;
    }
    this.stats.sabotageTries++;
    structures.orderDemolish([bEng.u.id], best);
    this.engJobs.set(bEng.u.id, { kind: 'demolish', edge: best, since: this.time, eta: bEng.eta });
    this.blacklist.set(`s${best}`, this.time + 12);
    this.nextSabotageAt = this.time + 1; // Erfolg setzt den Abklingzeitraum
  }

  // ================================================================== Debug

  private updateDebug(): void {
    const d = this.debug;
    const s = this.strike;
    const parts: string[] = [];
    parts.push(this.style === 'defender' ? 'Verteidiger' : `Welle ${s.wave}`);
    parts.push(`${s.state}${s.obj ? '→' + s.obj.name : ''}`);
    if (this.raids.length) parts.push(`Raids ${this.raids.length}`);
    if (this.alert) parts.push('ALARM');
    if (this.engJobs.size) parts.push(`Pi ${this.engJobs.size}`);
    d.plan = parts.join(' | ');
    d.groups = 4 + this.raids.length + (this.air.ids.length ? 1 : 0) + (this.naval.ids.length ? 1 : 0);
    d.targets.length = 0;
    if (s.obj) d.targets.push(`Hauptmacht: ${s.obj.name}`);
    for (const r of this.raids) d.targets.push(r.targetUnit ? `Raid: Konvoi ${r.targetUnit}` : r.obj ? `Raid: ${r.obj.name}` : 'Raid: Rückkehr');
    for (const [, j] of this.engJobs) d.targets.push(`${j.kind === 'demolish' ? 'Sprengung' : 'Reparatur'} Brücke ${j.edge}`);
    if (this.alert) d.targets.push(`Alarm (${this.alert.x.toFixed(0)}, ${this.alert.z.toFixed(0)})`);
  }

  /** Gruppengrößen für Tests/Overlays */
  get sizes(): { defense: number; strike: number; support: number; raid: number; air: number; naval: number; strikeState: string } {
    return { defense: this.defense.ids.length, strike: this.strike.ids.length, support: this.support.ids.length, raid: this.raidPool.ids.length + this.raids.reduce((s, r) => s + r.ids.length, 0), air: this.air.ids.length, naval: this.naval.ids.length, strikeState: this.strike.state };
  }
}

function distSeg(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
  return Math.hypot(ax + dx * t - px, az + dz * t - pz);
}
