import { bus } from '../core/EventBus';
import { getProfile } from '../game/countryData';
import type { WarQuery } from '../combat/types';
import type { UnitManager } from '../units/UnitManager';
import type { Unit } from '../units/types';
import type { CivilCity } from './types';
import type { CivilPort } from './ProtectionSystem';

export interface OccupationDeps {
  civil: CivilPort;
  units: UnitManager;
  war: WarQuery;
}

/** Spielstunden, die feindliche Bodentruppen unwidersprochen im Stadtkern stehen müssen */
const CAPTURE_H = 2;
/** Unruhe 0 -> 1 in ~3 Tagen bei völlig fehlender Garnison (Basisrate je Stunde) */
const UNREST_RATE = 1 / 72;
const REBEL_COOLDOWN_H = 12;
const MAX_REBELS_PER_CITY = 4;
const SLICE = 48;

const CAPTOR_CATS = new Set(['infantry', 'tank', 'ifv', 'recon']);
const ARMED_CATS = new Set(['infantry', 'tank', 'ifv', 'recon', 'artillery', 'aa']);
/** Gewicht einer Einheit in Trupp-Äquivalenten (Infanterietrupp = 1) */
const CAT_FACTOR: Record<string, number> = { infantry: 1, tank: 1.5, ifv: 1.2, recon: 0.5, artillery: 0.3, aa: 0.3 };

interface CityOcc {
  lastT: number;
  timer: number;
  captor: string;
  uprisingCd: number;
  rebels: number[];
  /** zuletzt gemeldete Unruhestufe (0..3) */
  stage: number;
  /** Hilfsguthaben (dämpft Unruhe), klingt ab */
  aid: number;
  lastKilled: number;
}

function isAlly(a: string, b: string): boolean {
  const pa = getProfile(a), pb = getProfile(b);
  return !!((pa && pa.allies.includes(b)) || (pb && pb.allies.includes(a)));
}

/**
 * Besatzung: Städte wechseln den Kontrolleur, wenn feindliche Bodentruppen ≥ 2 Spielstunden im Stadtkern stehen,
 * ohne dass bewaffnete Verteidiger (oder deren Verbündete) dort sind. Besetzte Städte brauchen eine Garnison;
 * fehlt sie, steigt die Unruhe bis zum Aufstand (kleine Aufständischen-Trupps des Ursprungslandes).
 */
export class Occupation {
  private readonly civil: CivilPort;
  private readonly units: UnitManager;
  private readonly war: WarQuery;
  private readonly st = new Map<number, CityOcc>();
  private readonly tmp: Unit[] = [];
  private time = 0;
  private prevTime = 0;
  private cursor = 0;

  constructor(deps: OccupationDeps) {
    this.civil = deps.civil;
    this.units = deps.units;
    this.war = deps.war;
    bus.on('civil:aid', (e) => {
      const s = this.stateOf(e.cityId);
      s.aid = Math.min(1, s.aid + 0.1 + 0.15 * Math.log10(1 + Math.max(0, e.amount)));
    });
  }

  private stateOf(id: number): CityOcc {
    let s = this.st.get(id);
    if (!s) this.st.set(id, (s = { lastT: this.prevTime, timer: 0, captor: '', uprisingCd: 0, rebels: [], stage: 0, aid: 0, lastKilled: 0 }));
    return s;
  }

  /** true, wenn die Stadt von einem anderen Land als dem Ursprungsland kontrolliert wird */
  isOccupied(cityId: number): boolean {
    const c = this.civil.cityById(cityId);
    return !!c && c.controller !== c.country;
  }

  /** Benötigte Garnisonsstärke in Trupp-Äquivalenten (~1 je 120 000 Einwohner, 1..12) */
  required(cityId: number): number {
    const c = this.civil.cityById(cityId);
    if (!c) return 1;
    return Math.max(1, Math.min(12, Math.ceil(Math.max(c.population, 0) / 120000)));
  }

  /** Summe der Kampfstärke befreundeter Einheiten des Kontrolleurs im Stadtradius */
  garrisonStrength(cityId: number): number {
    const c = this.civil.cityById(cityId);
    return c ? this.strengthOf(c, c.controller) : 0;
  }

  private strengthOf(c: CivilCity, owner: string): number {
    const arr = this.units.queryRadius(c.x, c.z, Math.max(c.radiusKm, 0.3), this.tmp);
    let s = 0;
    for (let i = 0; i < arr.length; i++) {
      const u = arr[i];
      if (u.hp <= 0 || u.owner !== owner) continue;
      s += this.weight(u);
    }
    return s;
  }

  private weight(u: Unit): number {
    const f = CAT_FACTOR[u.type.category];
    if (!f || u.type.mobility.domain !== 'ground') return 0;
    const n = u.type.memberCount || 1;
    return f * Math.min(1, (u.membersAlive ?? n) / n);
  }

  update(dtGameHours: number): void {
    if (!(dtGameHours > 0)) return;
    this.prevTime = this.time;
    this.time += dtGameHours;
    const cities = this.civil.cities;
    const n = cities.length;
    if (!n) return;
    const count = Math.min(n, SLICE);
    for (let k = 0; k < count; k++) {
      const c = cities[(this.cursor + k) % n];
      this.updateCity(c);
    }
    this.cursor = (this.cursor + count) % n;
  }

  private updateCity(c: CivilCity): void {
    const s = this.stateOf(c.id);
    const dt = this.time - s.lastT;
    s.lastT = this.time;
    if (dt <= 0) return;
    s.aid = Math.max(0, s.aid - dt / 120);
    s.uprisingCd = Math.max(0, s.uprisingCd - dt);

    this.scanCapture(c, s, dt);
    this.updateUnrest(c, s, dt);
  }

  // ------------------------------------------------------------------ Einnahme / Befreiung

  private scanCapture(c: CivilCity, s: CityOcc, dt: number): void {
    const core = Math.max(0.4, c.radiusKm * 0.6);
    const reach = Math.max(core, c.radiusKm);
    const arr = this.units.queryRadius(c.x, c.z, reach, this.tmp);
    const C = c.controller;
    const strength = new Map<string, number>();
    let defenders = 0;
    for (let i = 0; i < arr.length; i++) {
      const u = arr[i];
      if (u.hp <= 0 || u.type.mobility.domain !== 'ground') continue;
      const cat = u.type.category;
      const d = Math.hypot(u.x - c.x, u.z - c.z);
      if (u.owner === C || (!this.war.isHostile(u.owner, C) && isAlly(u.owner, C))) {
        if (ARMED_CATS.has(cat) && d <= reach) defenders += this.weight(u) || 0.1;
        continue;
      }
      if (!this.war.isHostile(u.owner, C)) continue;
      if (CAPTOR_CATS.has(cat) && d <= core) strength.set(u.owner, (strength.get(u.owner) ?? 0) + Math.max(this.weight(u), 0.05));
    }
    let best = '', bestS = 0;
    for (const [o, v] of strength) if (v > bestS) { bestS = v; best = o; }
    if (!best || defenders > 0.05) {
      s.timer = 0;
      s.captor = '';
      return;
    }
    if (s.captor !== best) {
      s.captor = best;
      s.timer = 0;
    }
    s.timer += dt;
    if (s.timer < CAPTURE_H) return;

    const liberated = best === c.country || (isAlly(best, c.country) && !this.war.isHostile(best, c.country));
    const newCtl = liberated ? c.country : best;
    if (newCtl === C) {
      s.timer = 0;
      return;
    }
    this.civil.setController(c.id, newCtl);
    s.timer = 0;
    s.captor = '';
    s.stage = 0;
    c.unrest = liberated ? 0 : Math.min(c.unrest, 0.1);
    if (newCtl === c.country) c.control = c.control === 'unrest' || c.control === 'occupied' ? 'normal' : c.control;
    bus.emit('city:captured', { cityId: c.id, by: newCtl, from: C });
    bus.emit('toast', { msg: liberated ? `${c.name} wurde befreit.` : `${c.name} wurde von ${nameOf(newCtl)} besetzt.`, kind: 'info' });
    bus.emit('satisfaction:delta', { a3: newCtl, delta: liberated ? 2 : 1, reason: liberated ? `${c.name} befreit` : `${c.name} eingenommen` });
    bus.emit('satisfaction:delta', { a3: C, delta: -2, reason: `${c.name} verloren` });
    if (liberated) {
      if (newCtl !== c.country) bus.emit('satisfaction:delta', { a3: c.country, delta: 1, reason: `${c.name} befreit` });
    } else {
      bus.emit('satisfaction:delta', { a3: c.country, delta: -3, reason: `${c.name} besetzt` });
    }
  }

  // ------------------------------------------------------------------ Unruhe / Aufstand

  private updateUnrest(c: CivilCity, s: CityOcc, dt: number): void {
    const occupied = c.controller !== c.country;
    if (!occupied) {
      if (c.unrest > 0) c.unrest = Math.max(0, c.unrest - dt / 24);
      if (c.unrest < 0.15) s.stage = 0;
      if (c.control === 'unrest' && c.unrest < 0.3) c.control = 'normal';
      return;
    }
    const need = this.required(c.id);
    const have = this.strengthOf(c, c.controller);
    const deficit = clamp01(1 - have / need);
    const killedNow = c.killed;
    const casualtyFrac = Math.min(1, killedNow / Math.max(1, c.populationStart * 0.02));
    s.lastKilled = killedNow;
    if (deficit > 0.05) {
      const aggr = 1 + 2 * (c.damage || 0) + 2.5 * casualtyFrac + Math.max(0, (50 - c.satisfaction) / 100);
      const calm = 1 - 0.6 * Math.min(1, s.aid);
      c.unrest = Math.min(1, c.unrest + UNREST_RATE * deficit * aggr * calm * dt);
    } else {
      // ausreichend Garnison: Unruhe klingt ab (schneller mit Hilfslieferungen)
      c.unrest = Math.max(0, c.unrest - (1 / 96) * (1 + 2 * s.aid) * dt);
    }
    if (c.unrest < 0.15) s.stage = 0;
    const stage = c.unrest >= 0.75 ? 3 : c.unrest >= 0.5 ? 2 : c.unrest >= 0.25 ? 1 : 0;
    if (stage > s.stage) {
      s.stage = stage;
      bus.emit('city:unrest', { cityId: c.id, level: c.unrest });
      bus.emit('toast', { msg: `Unruhen in ${c.name} (${Math.round(c.unrest * 100)} %)`, kind: 'warn' });
    }
    if (c.unrest >= 0.3 && c.control !== 'ruined' && c.control !== 'evacuated') c.control = 'unrest';
    else if (c.unrest < 0.2 && c.control === 'unrest') c.control = 'occupied';
    if (c.unrest >= 1) this.uprising(c, s);
  }

  private uprising(c: CivilCity, s: CityOcc): void {
    if (s.uprisingCd > 0) {
      c.unrest = 0.9;
      return;
    }
    bus.emit('city:uprising', { cityId: c.id, against: c.controller });
    bus.emit('toast', { msg: `Aufstand in ${c.name} gegen ${nameOf(c.controller)}!`, kind: 'error' });
    bus.emit('satisfaction:delta', { a3: c.controller, delta: -1.5, reason: `Aufstand in ${c.name}` });
    s.uprisingCd = REBEL_COOLDOWN_H;
    c.unrest = 0.55;
    s.stage = 2;
    // Aufständische des Ursprungslandes am Stadtrand
    s.rebels = s.rebels.filter((id) => {
      const u = this.units.get(id);
      return !!u && u.hp > 0;
    });
    const want = c.population > 800000 ? 2 : 1;
    for (let i = 0; i < want && s.rebels.length < MAX_REBELS_PER_CITY; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.max(0.3, c.radiusKm * 0.9);
      const u = this.units.spawn('inf_squad', c.country, c.x + Math.cos(a) * r, c.z + Math.sin(a) * r, a + Math.PI, `Widerstand ${c.name}`);
      if (u) s.rebels.push(u.id);
    }
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function nameOf(a3: string): string {
  return getProfile(a3)?.name ?? a3;
}
