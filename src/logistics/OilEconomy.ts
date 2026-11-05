/**
 * Phase 5 – Ölwirtschaft: Felder fördern, Tankwagen-Konvois bringen die Fässer über das echte Straßennetz zur Raffinerie,
 * angelieferte Fässer sind das Guthaben (Pool) der Nation. Konvois sind echte Units (Typ 'tanker_truck'): sie können
 * beschossen werden, Straßen/Brücken können gesperrt werden, Felder können erobert werden.
 *
 * Basen (HQ, Raffinerie, Depots, Produktionsgebäude) liegen alle in `bases`; hier werden Schaden, Zerstörung, Bau- und
 * Reparaturfortschritt verwaltet. Gerendert werden Felder, HQs und Raffinerien (ProductionSystem zeichnet die übrigen).
 */
import * as THREE from 'three';
import { bus } from '../core/EventBus';
import type { GeoMeta, ScenarioMeta, Settings } from '../core/types';
import type { WarQuery } from '../combat/types';
import { OIL_START_BARRELS, SCENARIO_NATIONS } from '../game/scenario';
import type { Unit } from '../units/types';
import { getUnitType } from '../units/unitTypes';
import type { UnitManager } from '../units/UnitManager';
import type { GeoData } from '../world/GeoData';
import { BASE_DEFS, PRICE, SUPPLY_KINDS, type RouteLike } from './prices';
import { SiteLayer } from './siteVisuals';
import type { BaseInfo, BaseKind, ConvoyInfo, OilFieldInfo, OilPool } from './types';

export type { RouteLike };

// ------------------------------------------------------------------ Tuning
/** Fassungsvermögen eines Tankwagen-Konvois */
export const TRUCK_CAPACITY = 120;
/** Ab so vielen eingelagerten Fässern wird ein Konvoi geschickt */
const LOAD_MIN = 40;
const LOAD_HOURS = 0.15;
/** Verlust beim Abladen (Leckage) */
const DELIVER_EFF = 0.98;
/** Lieferung an das HQ statt an die Raffinerie */
const HQ_FALLBACK = 0.5;
const ARRIVE_KM = 0.45;
const RETRY_HOURS = 2;
/** Eroberung: Angreifer-Radius, Verteidiger-Radius, Dauer (Spielstunden) */
const CAPTURE_R = 0.6;
const DEFEND_R = 1.0;
const CAPTURE_HOURS = 1;
const FIELD_HP = 600;
const REPAIR_R = 0.3;
/** Mannschaft jeder Basis ohne Pioniere (Arbeiter) */
const CREW_WORKERS = 1.5;
const BALANCE_HOURS = 0.25;
const WINDOW_HOURS = 6;
const FLEET_PER_FIELD = 2;
const FLEET_MAX = 10;

/** Schaden von Einschlägen auf Basen/Felder (HP) je Waffenart */
const IMPACT_DMG: Partial<Record<string, number>> = {
  mg: 0.2, hmg: 0.5, autocannon: 1.5, tank_gun: 8, atgm: 12, rpg: 6, mortar: 10, howitzer: 55, rocket_arty: 45,
  heli_gun: 1, heli_rocket: 10, heli_atgm: 14, air_gun: 1.5, air_missile: 30, bomb: 280, naval_gun: 40,
  antiship_missile: 120, fpv: 22, grenade: 1.5, demo_charge: 120, flak: 0.5,
};
const EXPLOSION_DMG: Record<string, number> = { tiny: 0, small: 0, medium: 0, large: 25, huge: 70 };

export interface EconomyDeps {
  geo: GeoData;
  units: UnitManager;
  pathfinder: RouteLike;
  war: WarQuery & { isHostile(a: string, b: string): boolean };
  settings: Settings;
}

/** Optionale Anbindung an das Zivilsystem (Zufriedenheit der Stadt beim Standort) */
export interface CivilPort {
  cityAt(x: number, z: number, extraKm?: number): { satisfaction: number } | null;
}

interface Ledger {
  income: Array<{ t: number; v: number }>;
  spend: Array<{ t: number; v: number }>;
  dirty: boolean;
}

interface ConvoyRt {
  info: ConvoyInfo;
  retryAt: number;
  loadLeft: number;
}

interface FieldRt {
  info: OilFieldInfo;
  cutCheckAt: number;
  fireClock: number;
  lastEmitIntegrity: number;
}

export type FieldStateKind = 'running' | 'cutoff' | 'destroyed' | 'neutral' | 'full';

const _buf: Unit[] = [];

function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

export class OilEconomy {
  readonly fields: OilFieldInfo[] = [];
  readonly bases = new Map<number, BaseInfo>();
  readonly convoys = new Map<number, ConvoyInfo>();
  readonly object: THREE.Object3D;
  /** Zeit seit Spielbeginn in Spielstunden */
  time = 0;
  /** Mehrspieler (Gast): Spiegel – update() zeichnet nur noch; Felder/Basen/Konvois/Pools schreibt GuestSync in place */
  mirror = false;

  private readonly geo: GeoData;
  private readonly units: UnitManager;
  private readonly path: RouteLike;
  private readonly war: WarQuery & { isHostile(a: string, b: string): boolean };
  private readonly layer: SiteLayer;
  private exag: number;
  private civil: CivilPort | null = null;

  private readonly pools = new Map<string, OilPool>();
  private readonly ledgers = new Map<string, Ledger>();
  private readonly frt = new Map<number, FieldRt>();
  private readonly crt = new Map<number, ConvoyRt>();
  private readonly byUnit = new Map<number, number>();
  private readonly homes = new Map<string, Partial<Record<BaseKind, [number, number]>>>();
  private readonly freeTrucks = new Map<string, number>();
  private readonly nextSpawnAt = new Map<string, number>();
  private readonly owners: string[] = [];
  private nextBaseId = 1;
  private nextConvoyId = 1;
  private balClock = 0;
  private flushClock = 0;
  private dispatchClock = 0;
  private visClock = 0;
  private fireTimer = 0;
  private visDirty = true;
  private readonly offs: Array<() => void> = [];
  private readonly mob = getUnitType('tanker_truck')?.mobility;

  constructor(deps: EconomyDeps) {
    this.geo = deps.geo;
    this.units = deps.units;
    this.path = deps.pathfinder;
    this.war = deps.war;
    this.exag = deps.settings.heightExaggeration;
    this.layer = new SiteLayer(deps.geo, this.exag, 'EconomySites');
    this.object = this.layer.object;
    this.offs.push(
      bus.on('unit:killed', (e) => { if (!this.mirror) this.onKilled(e.id, e.killerId); }),
      bus.on('unit:removed', ({ id }) => { if (!this.mirror) this.onRemoved(id); }),
      bus.on('nav:edge', () => { for (const fr of this.frt.values()) fr.cutCheckAt = Math.min(fr.cutCheckAt, this.time); this.dispatchClock = 1; }),
      bus.on('combat:impact', (e) => { if (!this.mirror) this.onImpact(e.weapon, e.x, e.z, e.radiusKm, 1, e.owner); }),
      bus.on('combat:explosion', (e) => {
        if (this.mirror) return;
        const d = EXPLOSION_DMG[e.size] ?? 0;
        if (d > 0) this.onImpact('howitzer', e.x, e.z, 0.02, d / (IMPACT_DMG.howitzer ?? 55), e.owner);
      }),
    );
  }

  dispose(): void {
    for (const f of this.offs) f();
    this.offs.length = 0;
  }

  isHostile(a: string, b: string): boolean {
    return this.war.isHostile(a, b);
  }

  setCivil(port: CivilPort | null): void {
    this.civil = port;
  }

  applySettings(s: Settings): void {
    this.exag = s.heightExaggeration;
    this.layer.setExag(this.exag);
  }

  // ------------------------------------------------------------------ Szenario

  loadScenario(meta: ScenarioMeta | undefined): void {
    for (const c of [...this.convoys.values()]) this.units.remove(c.unitId);
    this.convoys.clear();
    this.crt.clear();
    this.byUnit.clear();
    for (const b of [...this.bases.keys()]) this.layer.remove(`b${b}`);
    for (const f of this.fields) this.layer.remove(`f${f.id}`);
    this.fields.length = 0;
    this.frt.clear();
    this.bases.clear();
    this.pools.clear();
    this.ledgers.clear();
    this.homes.clear();
    this.freeTrucks.clear();
    this.nextSpawnAt.clear();
    this.owners.length = 0;
    this.time = 0;
    this.nextBaseId = 1;

    const sc = meta ?? this.syntheticScenario();
    for (const n of sc.nations) {
      if (!this.owners.includes(n.a3)) this.owners.push(n.a3);
      this.pools.set(n.a3, { barrels: OIL_START_BARRELS, incomePerHour: 0, spendPerHour: 0, inTransit: 0, delivered: 0, lostConvoys: 0, lostBarrels: 0 });
      this.ledgers.set(n.a3, { income: [], spend: [], dirty: true });
      this.homes.set(n.a3, { hq: [n.hq[0], n.hq[1]], refinery: [n.refinery[0], n.refinery[1]] });
      this.addBase('hq', n.a3, n.hq[0], n.hq[1], 1);
      this.addBase('refinery', n.a3, n.refinery[0], n.refinery[1], 1);
    }
    for (const o of sc.oilFields) {
      const owner = this.owners.includes(o.country) ? o.country : '';
      const info: OilFieldInfo = {
        id: o.id, name: o.name, x: o.pos[0], z: o.pos[1], output: o.output, country: o.country, owner,
        integrity: 1, stored: 0, capacity: Math.round(o.output * 10 + 100), destBaseId: -1, cutOff: false, captureProgress: 0,
      };
      this.fields.push(info);
      this.frt.set(info.id, { info, cutCheckAt: 0, fireClock: 0, lastEmitIntegrity: 1 });
      if (owner) info.destBaseId = this.nearestBase(owner, 'refinery', info.x, info.z)?.id ?? -1;
    }
    for (const o of this.owners) {
      this.freeTrucks.set(o, this.desiredFleet(o));
      this.nextSpawnAt.set(o, 0);
    }
    if (!this.mirror) this.topUpFleet(); // Gast: Tankwagen kommen mit Host-IDs per Schnappschuss (sonst ID-Kollisionen)
    this.visDirty = true;
    this.syncVisuals();
    for (const o of this.owners) this.emitBalance(o);
  }

  /** Testszenario, wenn die Kartendaten (noch) keine Szenario-Daten enthalten: um die Kartenmitte */
  private syntheticScenario(): ScenarioMeta {
    const geo = this.geo;
    const land = (x: number, z: number): [number, number] => {
      for (let r = 0; r < 60; r += 1.5) {
        for (let a = 0; a < 12; a++) {
          const px = x + Math.cos((a * Math.PI) / 6) * r, pz = z + Math.sin((a * Math.PI) / 6) * r;
          if (!geo.inside(px, pz)) continue;
          const i = Math.floor(px / geo.cellKm), j = Math.floor(pz / geo.cellKm);
          if (geo.countryAt(px, pz) !== 0 && geo.waterFlags[j * geo.width + i] === 0) return [px, pz];
        }
      }
      return [x, z];
    };
    const cx = geo.widthKm / 2, cz = geo.heightKm / 2;
    const nat = (a3: string, dx: number, dz: number) => ({
      a3, capitalCity: 0, hq: land(cx + dx, cz + dz), refinery: land(cx + dx + 5, cz + dz + 4), spawn: land(cx + dx, cz + dz + 8),
    });
    const nations = [nat('VAL', -45, 0), nat('KRN', 45, 0), nat('MAR', 0, 50)];
    const fieldAt = (id: number, name: string, country: string, dx: number, dz: number, output: number) => ({ id, name, country, pos: land(cx + dx, cz + dz), output });
    return {
      id: 'synthetic', name: 'Testszenario', seed: 1, nations,
      oilFields: [
        fieldAt(1, 'Westfeld', 'VAL', -55, -18, 40), fieldAt(2, 'Südwestfeld', 'VAL', -40, 22, 30),
        fieldAt(3, 'Ostfeld', 'KRN', 55, -15, 45), fieldAt(4, 'Nordostfeld', 'KRN', 38, -25, 30),
        fieldAt(5, 'Küstenfeld', 'MAR', -12, 60, 35), fieldAt(6, 'Zentralfeld', '', 0, -5, 55),
      ],
    };
  }

  // ------------------------------------------------------------------ Pools

  pool(a3: string): OilPool {
    let p = this.pools.get(a3);
    if (!p) {
      p = { barrels: OIL_START_BARRELS, incomePerHour: 0, spendPerHour: 0, inTransit: 0, delivered: 0, lostConvoys: 0, lostBarrels: 0 };
      this.pools.set(a3, p);
      this.ledgers.set(a3, { income: [], spend: [], dirty: true });
      if (!this.owners.includes(a3)) this.owners.push(a3);
    }
    return p;
  }

  private ledger(a3: string): Ledger {
    this.pool(a3);
    return this.ledgers.get(a3)!;
  }

  /** Fässer ausgeben; false, wenn nicht genug */
  spend(a3: string, barrels: number, _reason?: string): boolean {
    if (barrels <= 0) return true;
    const p = this.pool(a3);
    if (p.barrels + 1e-9 < barrels) return false;
    p.barrels = Math.max(0, p.barrels - barrels);
    const l = this.ledger(a3);
    l.spend.push({ t: this.time, v: barrels });
    l.dirty = true;
    return true;
  }

  /** Rückerstattung (zählt als negative Ausgabe, nicht als Einnahme) */
  refund(a3: string, barrels: number): void {
    if (barrels <= 0) return;
    this.pool(a3).barrels += barrels;
    const l = this.ledger(a3);
    l.spend.push({ t: this.time, v: -barrels });
    l.dirty = true;
  }

  private income(a3: string, barrels: number): void {
    const p = this.pool(a3);
    p.barrels += barrels;
    p.delivered = (p.delivered ?? 0) + barrels;
    const l = this.ledger(a3);
    l.income.push({ t: this.time, v: barrels });
    l.dirty = true;
  }

  private refreshRates(a3: string): void {
    const p = this.pool(a3), l = this.ledger(a3);
    const win = Math.min(WINDOW_HOURS, Math.max(1, this.time));
    const cut = this.time - WINDOW_HOURS;
    while (l.income.length && l.income[0].t < cut) l.income.shift();
    while (l.spend.length && l.spend[0].t < cut) l.spend.shift();
    let i = 0, s = 0;
    for (const e of l.income) i += e.v;
    for (const e of l.spend) s += e.v;
    p.incomePerHour = i / win;
    p.spendPerHour = Math.max(0, s / win);
    let tr = 0;
    for (const c of this.convoys.values()) if (c.owner === a3 && c.kind === 'oil') tr += c.cargo;
    p.inTransit = tr;
  }

  private emitBalance(a3: string): void {
    this.refreshRates(a3);
    const p = this.pool(a3);
    bus.emit('oil:balance', { owner: a3, barrels: p.barrels, incomePerHour: p.incomePerHour });
    this.ledger(a3).dirty = false;
  }

  // ------------------------------------------------------------------ Abfragen

  fieldAt(x: number, z: number, r: number): OilFieldInfo | null {
    let best: OilFieldInfo | null = null, bd = r;
    for (const f of this.fields) {
      const d = Math.hypot(f.x - x, f.z - z);
      if (d <= bd) { bd = d; best = f; }
    }
    return best;
  }

  /** nächste fertige Basis; kind 'supply' = alle Nachschubbasen, 'any' = beliebig */
  nearestBase(a3: string, kind: BaseKind | 'supply' | 'any', x: number, z: number): BaseInfo | null {
    let best: BaseInfo | null = null, bd = Infinity;
    for (const b of this.bases.values()) {
      if (b.owner !== a3 || b.progress < 1) continue;
      if (kind === 'supply' ? !SUPPLY_KINDS.has(b.kind) : kind !== 'any' && b.kind !== kind) continue;
      const d = Math.hypot(b.x - x, b.z - z);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  basesOf(a3: string): BaseInfo[] {
    const out: BaseInfo[] = [];
    for (const b of this.bases.values()) if (b.owner === a3) out.push(b);
    return out;
  }

  fieldsOf(a3: string): OilFieldInfo[] {
    return this.fields.filter((f) => f.owner === a3);
  }

  /** Zustand eines Feldes für die UI */
  fieldState(f: OilFieldInfo): FieldStateKind {
    if (f.integrity < 0.05) return 'destroyed';
    if (!f.owner) return 'neutral';
    if (f.cutOff) return 'cutoff';
    if (f.stored >= f.capacity - 1) return 'full';
    return 'running';
  }

  countBases(a3: string, kind: BaseKind): number {
    let n = 0;
    for (const b of this.bases.values()) if (b.owner === a3 && b.kind === kind) n++;
    return n;
  }

  convoysOf(a3: string): ConvoyInfo[] {
    const out: ConvoyInfo[] = [];
    for (const c of this.convoys.values()) if (c.owner === a3) out.push(c);
    return out;
  }

  // ------------------------------------------------------------------ Basen

  addBase(kind: BaseKind, owner: string, x: number, z: number, progress = 1, name?: string): BaseInfo {
    const def = BASE_DEFS[kind];
    const id = this.nextBaseId++;
    const n = this.countBases(owner, kind) + 1;
    const b: BaseInfo = {
      id, kind, owner, x, z, progress, hp: def.hpMax * Math.max(0.15, progress), hpMax: def.hpMax, radiusKm: def.radiusKm,
      name: name ?? (def.maxCount > 1 ? `${def.name} ${n}` : def.name),
    };
    this.bases.set(id, b);
    this.visDirty = true;
    return b;
  }

  /** Ist ein Wiederaufbau von HQ/Raffinerie möglich (Standort bekannt, nicht vorhanden)? */
  canRebuild(owner: string, kind: 'hq' | 'refinery'): boolean {
    return !!this.homes.get(owner)?.[kind] && this.countBases(owner, kind) === 0;
  }

  /** Zerstörte Raffinerie/HQ erneut aufbauen (kostet Fässer; Bau läuft automatisch mit der Basismannschaft + Pionieren) */
  rebuildBase(owner: string, kind: 'hq' | 'refinery'): { ok: boolean; reason?: string } {
    const home = this.homes.get(owner)?.[kind];
    if (!home) return { ok: false, reason: 'Kein Standort bekannt' };
    for (const b of this.bases.values()) if (b.owner === owner && b.kind === kind) return { ok: false, reason: 'Existiert bereits' };
    const cost = BASE_DEFS[kind].cost;
    if (!this.spend(owner, cost, 'rebuild')) return { ok: false, reason: `Zu wenig Öl (${cost} Fässer nötig)` };
    this.addBase(kind, owner, home[0], home[1], 0);
    return { ok: true };
  }

  /** Basis auf Schaden prüfen: Schaden direkt zufügen */
  damageBase(id: number, amount: number): void {
    const b = this.bases.get(id);
    if (!b || amount <= 0) return;
    b.hp -= amount;
    this.visDirty = true;
    if (b.hp <= 0) this.destroyBase(b);
  }

  private destroyBase(b: BaseInfo): void {
    this.bases.delete(b.id);
    this.layer.remove(`b${b.id}`);
    const y = this.groundY(b.x, b.z);
    const s = BASE_DEFS[b.kind].sizeKm;
    bus.emit('combat:explosion', { x: b.x, y, z: b.z, size: 'huge', fire: true, owner: b.owner });
    for (let i = 0; i < 4; i++) {
      const a = Math.random() * 6.28, r = Math.random() * s;
      const x = b.x + Math.cos(a) * r, z = b.z + Math.sin(a) * r;
      bus.emit('combat:explosion', { x, y: this.groundY(x, z), z, size: i < 2 ? 'large' : 'medium', fire: true, owner: b.owner });
    }
    bus.emit('base:destroyed', { baseId: b.id, owner: b.owner });
    bus.emit('toast', { msg: `${b.name ?? b.kind} (${b.owner}) zerstört`, kind: 'warn' });
    this.visDirty = true;
  }

  private groundY(x: number, z: number): number {
    return Math.max(0, this.geo.heightAt(x, z)) * this.exag;
  }

  // ------------------------------------------------------------------ Einschläge

  private onImpact(weapon: string, x: number, z: number, radiusKm: number, mult = 1, shooter?: string): void {
    const d0 = (IMPACT_DMG[weapon] ?? 0) * mult;
    if (d0 <= 0) return;
    for (const f of this.fields) {
      if (f.integrity <= 0) continue;
      if (shooter && f.owner && !this.war.isHostile(shooter, f.owner)) continue;
      const R = 0.1 + radiusKm;
      const d = Math.hypot(f.x - x, f.z - z);
      if (d > R) continue;
      const k = 1 - (d / R) * 0.6;
      f.integrity = Math.max(0, f.integrity - (d0 * 1.3 * k) / FIELD_HP);
      this.visDirty = true;
      const rt = this.frt.get(f.id)!;
      if (Math.abs(rt.lastEmitIntegrity - f.integrity) >= 0.02) {
        rt.lastEmitIntegrity = f.integrity;
        bus.emit('oil:field-damaged', { fieldId: f.id, integrity: f.integrity });
      }
    }
    for (const b of [...this.bases.values()]) {
      if (shooter && !this.war.isHostile(shooter, b.owner)) continue;
      const R = BASE_DEFS[b.kind].sizeKm + radiusKm;
      const d = Math.hypot(b.x - x, b.z - z);
      if (d > R) continue;
      const k = 1 - (d / R) * 0.6;
      this.damageBase(b.id, d0 * k);
    }
  }

  // ------------------------------------------------------------------ Konvois

  private desiredFleet(owner: string): number {
    let n = 0;
    for (const f of this.fields) if (f.owner === owner) n++;
    return Math.min(FLEET_MAX, n * FLEET_PER_FIELD);
  }

  private spawnPoint(owner: string): [number, number] | null {
    const b = this.nearestBase(owner, 'refinery', 0, 0) ?? this.nearestBase(owner, 'hq', 0, 0);
    if (!b) return null;
    const n = this.countConvoys(owner);
    const a = n * 2.4, r = 0.12 + (n % 4) * 0.05;
    return [b.x + Math.cos(a) * r, b.z + Math.sin(a) * r];
  }

  private countConvoys(owner: string): number {
    let n = 0;
    for (const c of this.convoys.values()) if (c.owner === owner) n++;
    return n;
  }

  private spawnConvoy(owner: string): ConvoyInfo | null {
    const p = this.spawnPoint(owner);
    if (!p) return null;
    const u = this.units.spawn('tanker_truck', owner, p[0], p[1], 0, `Tankwagen ${this.nextConvoyId}`);
    if (!u) return null;
    const home = this.nearestBase(owner, 'refinery', u.x, u.z) ?? this.nearestBase(owner, 'hq', u.x, u.z);
    const info: ConvoyInfo = { id: this.nextConvoyId++, kind: 'oil', owner, fromBaseId: home?.id ?? -1, toBaseId: home?.id ?? -1, cargo: 0, unitId: u.id, state: 'idle', fieldId: -1 };
    this.convoys.set(info.id, info);
    this.crt.set(info.id, { info, retryAt: 0, loadLeft: 0 });
    this.byUnit.set(u.id, info.id);
    return info;
  }

  private topUpFleet(): void {
    for (const o of this.owners) {
      const want = this.desiredFleet(o);
      let have = this.countConvoys(o);
      if (have >= want) continue;
      if (!this.nearestBase(o, 'refinery', 0, 0) && !this.nearestBase(o, 'hq', 0, 0)) continue;
      let guard = 0;
      while (have < want && guard++ < FLEET_MAX && this.time >= (this.nextSpawnAt.get(o) ?? 0)) {
        const free = this.freeTrucks.get(o) ?? 0;
        if (free <= 0 && !this.spend(o, PRICE.tanker_truck, 'tanker')) break;
        if (!this.spawnConvoy(o)) {
          if (free <= 0) this.refund(o, PRICE.tanker_truck);
          this.nextSpawnAt.set(o, this.time + 0.5);
          break;
        }
        if (free > 0) this.freeTrucks.set(o, free - 1);
        else this.nextSpawnAt.set(o, this.time + 0.5);
        have++;
      }
    }
  }

  private onKilled(unitId: number, killerId: number): void {
    const cid = this.byUnit.get(unitId);
    if (cid === undefined) return;
    const c = this.convoys.get(cid);
    if (!c) return;
    const by = this.units.get(killerId)?.owner ?? '';
    const p = this.pool(c.owner);
    p.lostConvoys = (p.lostConvoys ?? 0) + 1;
    p.lostBarrels = (p.lostBarrels ?? 0) + c.cargo;
    bus.emit('convoy:lost', { convoyId: c.id, owner: c.owner, cargo: c.cargo, by });
    this.dropConvoy(c);
  }

  private onRemoved(unitId: number): void {
    const cid = this.byUnit.get(unitId);
    if (cid === undefined) return;
    const c = this.convoys.get(cid);
    if (c) this.dropConvoy(c);
  }

  private dropConvoy(c: ConvoyInfo): void {
    this.convoys.delete(c.id);
    this.crt.delete(c.id);
    this.byUnit.delete(c.unitId);
  }

  private truckMob() {
    return this.mob ?? getUnitType('tanker_truck')!.mobility;
  }

  private routeOk(fx: number, fz: number, tx: number, tz: number): boolean {
    return this.path.routeExists ? this.path.routeExists(fx, fz, tx, tz, this.truckMob()) : this.path.findRoute(fx, fz, tx, tz, this.truckMob()) !== null;
  }

  private destFor(owner: string, x: number, z: number): BaseInfo | null {
    return this.nearestBase(owner, 'refinery', x, z) ?? this.nearestBase(owner, 'hq', x, z);
  }

  private sendTo(_c: ConvoyInfo, u: Unit, x: number, z: number): void {
    this.units.issueMove([u.id], x, z, { formation: 'column' });
  }

  private tickConvoys(dt: number): void {
    for (const rt of [...this.crt.values()]) {
      const c = rt.info;
      const u = this.units.get(c.unitId);
      if (!u) { this.dropConvoy(c); continue; }
      const field = c.fieldId !== undefined && c.fieldId >= 0 ? this.frt.get(c.fieldId)?.info : undefined;
      switch (c.state) {
        case 'idle':
          break;
        case 'toField': {
          if (!field || field.owner !== c.owner || field.integrity < 0.05) { this.recall(c, u); break; }
          const d = Math.hypot(u.x - field.x, u.z - field.z);
          if (d < ARRIVE_KM) { c.state = 'loading'; rt.loadLeft = LOAD_HOURS; u.speedKmh = 0; }
          else if (u.orders.length === 0) this.toWaiting(rt);
          break;
        }
        case 'loading': {
          if (!field || field.owner !== c.owner) { this.recall(c, u); break; }
          rt.loadLeft -= dt;
          if (rt.loadLeft > 0) break;
          const cargo = Math.min(TRUCK_CAPACITY, field.stored);
          field.stored -= cargo;
          c.cargo = cargo;
          const dest = this.destFor(c.owner, field.x, field.z);
          if (!dest) { c.state = 'waiting'; rt.retryAt = this.time + RETRY_HOURS; break; }
          c.toBaseId = dest.id;
          c.state = 'toBase';
          this.sendTo(c, u, dest.x, dest.z);
          break;
        }
        case 'toBase': {
          let dest = this.bases.get(c.toBaseId);
          if (!dest || dest.progress < 1) {
            dest = this.destFor(c.owner, u.x, u.z) ?? undefined;
            if (!dest) { this.toWaiting(rt); break; }
            c.toBaseId = dest.id;
            this.sendTo(c, u, dest.x, dest.z);
            break;
          }
          const d = Math.hypot(u.x - dest.x, u.z - dest.z);
          if (d < Math.max(ARRIVE_KM, 0.3)) this.deliver(c, u, dest);
          else if (u.orders.length === 0) this.toWaiting(rt);
          break;
        }
        case 'recall': {
          const dest = this.bases.get(c.toBaseId) ?? this.destFor(c.owner, u.x, u.z);
          if (!dest) { this.toWaiting(rt); break; }
          c.toBaseId = dest.id;
          const d = Math.hypot(u.x - dest.x, u.z - dest.z);
          if (d < Math.max(ARRIVE_KM, 0.3)) {
            if (c.cargo > 0) this.deliver(c, u, dest);
            else { c.state = 'idle'; c.fieldId = -1; }
          } else if (u.orders.length === 0) this.toWaiting(rt);
          break;
        }
        case 'waiting': {
          if (this.time < rt.retryAt) break;
          // erneut versuchen: Ziel je nach Ladung
          let tx: number, tz: number, next: ConvoyInfo['state'];
          if (c.cargo > 0) {
            const dest = this.destFor(c.owner, u.x, u.z);
            if (!dest) { rt.retryAt = this.time + RETRY_HOURS; break; }
            c.toBaseId = dest.id; tx = dest.x; tz = dest.z; next = 'toBase';
          } else if (field && field.owner === c.owner && field.integrity >= 0.05 && c.fieldId !== undefined && c.fieldId >= 0) {
            tx = field.x; tz = field.z; next = 'toField';
          } else {
            const dest = this.destFor(c.owner, u.x, u.z);
            if (!dest) { rt.retryAt = this.time + RETRY_HOURS; break; }
            c.toBaseId = dest.id; tx = dest.x; tz = dest.z; next = 'recall';
          }
          if (this.routeOk(u.x, u.z, tx, tz)) { c.state = next; this.sendTo(c, u, tx, tz); }
          else rt.retryAt = this.time + RETRY_HOURS;
          break;
        }
      }
    }
  }

  private toWaiting(rt: ConvoyRt): void {
    rt.info.state = 'waiting';
    rt.retryAt = this.time + RETRY_HOURS;
    const f = rt.info.fieldId !== undefined ? this.frt.get(rt.info.fieldId) : undefined;
    if (f && rt.info.cargo === 0) f.info.cutOff = true;
  }

  private recall(c: ConvoyInfo, u: Unit): void {
    const dest = this.destFor(c.owner, u.x, u.z);
    c.fieldId = c.cargo > 0 ? c.fieldId : -1;
    if (!dest) { c.state = 'waiting'; this.crt.get(c.id)!.retryAt = this.time + RETRY_HOURS; return; }
    c.toBaseId = dest.id;
    c.state = 'recall';
    this.sendTo(c, u, dest.x, dest.z);
  }

  private refineryMult(b: BaseInfo): number {
    if (b.kind !== 'refinery') return HQ_FALLBACK;
    if (!this.civil) return 1;
    const city = this.civil.cityAt(b.x, b.z, 6);
    if (!city) return 1;
    return 0.7 + 0.3 * clamp(city.satisfaction / 100, 0, 1);
  }

  private deliver(c: ConvoyInfo, u: Unit, dest: BaseInfo): void {
    const barrels = c.cargo * DELIVER_EFF * this.refineryMult(dest);
    const fid = c.fieldId ?? -1;
    if (barrels > 0) {
      this.income(c.owner, barrels);
      bus.emit('oil:delivered', { owner: c.owner, barrels, fieldId: fid });
    }
    c.cargo = 0;
    c.state = 'idle';
    c.fieldId = -1;
    c.fromBaseId = dest.id;
    u.fuel = u.type.fuelKm;
    u.speedKmh = 0;
    this.ledger(c.owner).dirty = true;
  }

  // ------------------------------------------------------------------ Disposition

  private dispatch(): void {
    for (const owner of this.owners) {
      let idle: ConvoyRt[] | null = null;
      const own = this.fields.filter((f) => f.owner === owner && f.integrity >= 0.05);
      if (!own.length) continue;
      // Reservierte Menge je Feld (Konvois unterwegs dorthin)
      own.sort((a, b) => b.stored - a.stored);
      for (const f of own) {
        let reserved = 0;
        for (const rt of this.crt.values()) if (rt.info.owner === owner && rt.info.fieldId === f.id && (rt.info.state === 'toField' || rt.info.state === 'loading') && rt.info.cargo === 0) reserved += TRUCK_CAPACITY;
        if (f.stored - reserved < LOAD_MIN) continue;
        if (f.cutOff) continue;
        if (!idle) idle = [...this.crt.values()].filter((r) => r.info.owner === owner && r.info.state === 'idle' && this.units.get(r.info.unitId));
        if (!idle.length) break;
        // nächster freier Konvoi
        let bi = -1, bd = Infinity;
        for (let i = 0; i < idle.length; i++) {
          const u = this.units.get(idle[i].info.unitId)!;
          const d = Math.hypot(u.x - f.x, u.z - f.z);
          if (d < bd) { bd = d; bi = i; }
        }
        const rt = idle[bi];
        const u = this.units.get(rt.info.unitId)!;
        const dest = this.destFor(owner, f.x, f.z);
        if (!dest) { f.cutOff = true; continue; }
        f.destBaseId = dest.id;
        idle.splice(bi, 1);
        rt.info.state = 'toField';
        rt.info.fieldId = f.id;
        rt.info.fromBaseId = dest.id;
        rt.info.toBaseId = dest.id;
        this.sendTo(rt.info, u, f.x, f.z);
        bus.emit('convoy:started', { convoyId: rt.info.id, owner, kind: 'oil' });
      }
    }
    // Erreichbarkeit prüfen (bis zu 4 fällige Felder je Aufruf; nach 'nav:edge' sind alle sofort fällig)
    {
      let budget = 4;
      for (const fr of this.frt.values()) {
        const f = fr.info;
        if (this.time < fr.cutCheckAt || !f.owner) continue;
        fr.cutCheckAt = this.time + 1;
        const home = this.destFor(f.owner, f.x, f.z);
        f.cutOff = home ? !this.routeOk(home.x, home.z, f.x, f.z) : true;
        if (--budget <= 0) break;
      }
    }
  }

  // ------------------------------------------------------------------ Eroberung

  captureFieldCheck(dt = 0): void {
    const counts = new Map<string, number>();
    for (const f of this.fields) {
      if (f.integrity < 0.02 && !f.owner) continue;
      counts.clear();
      let defenders = 0;
      this.units.queryRadius(f.x, f.z, DEFEND_R, _buf);
      for (const u of _buf) {
        if (u.type.damage <= 0 || u.type.mobility.domain !== 'ground' || u.hp <= 0 || u.garrisonId !== undefined) continue;
        if (f.owner && u.owner === f.owner) { defenders++; continue; }
        if (Math.hypot(u.x - f.x, u.z - f.z) > CAPTURE_R) continue;
        if (f.owner && !this.war.isHostile(f.owner, u.owner)) continue;
        counts.set(u.owner, (counts.get(u.owner) ?? 0) + 1);
      }
      if (defenders === 0 && counts.size > 0) {
        let by = '', bc = 0;
        for (const [o, n] of counts) if (n > bc) { bc = n; by = o; }
        if (f.capturer !== by) {
          f.capturer = by; f.captureProgress = 0;
          if (f.owner) bus.emit('alert', { a3: f.owner, kind: 'danger', text: `Ölfeld ${f.name} wird von ${by} eingenommen – Gegenwehr nötig (1 Spielstunde)`, x: f.x, z: f.z });
        }
        f.captureProgress = (f.captureProgress ?? 0) + dt / CAPTURE_HOURS;
        if (f.captureProgress >= 1) this.captureField(f, by);
      } else if ((f.captureProgress ?? 0) > 0) {
        f.captureProgress = Math.max(0, (f.captureProgress ?? 0) - dt * 2);
        if (f.captureProgress === 0) f.capturer = undefined;
      }
    }
  }

  private captureField(f: OilFieldInfo, by: string): void {
    const from = f.owner;
    f.owner = by;
    f.captureProgress = 0;
    f.capturer = undefined;
    f.cutOff = false;
    f.destBaseId = this.nearestBase(by, 'refinery', f.x, f.z)?.id ?? -1;
    this.pool(by);
    const fr = this.frt.get(f.id);
    if (fr) { fr.cutCheckAt = 0; }
    // Konvois des alten Besitzers, die dorthin unterwegs sind, zurückrufen
    for (const rt of this.crt.values()) {
      const c = rt.info;
      if (c.fieldId === f.id && c.owner === from && c.cargo === 0 && (c.state === 'toField' || c.state === 'loading' || c.state === 'waiting')) {
        const u = this.units.get(c.unitId);
        if (u) this.recall(c, u);
      }
    }
    bus.emit('oil:field-captured', { fieldId: f.id, by, from });
    bus.emit('toast', { msg: `Ölfeld ${f.name} von ${by} erobert`, kind: 'info' });
    this.visDirty = true;
  }

  // ------------------------------------------------------------------ Pflege (Reparatur/Bau)

  private workersAround(x: number, z: number, owner: string): number {
    let w = 0;
    this.units.queryRadius(x, z, REPAIR_R, _buf);
    for (const u of _buf) {
      if (u.type.id !== 'engineer_squad' || u.owner !== owner || u.hp <= 0) continue;
      w += Math.max(1, Math.round((u.type.memberCount * u.hp) / Math.max(1, u.type.hp)));
    }
    return w;
  }

  private maintain(dt: number): void {
    for (const f of this.fields) {
      if (f.integrity >= 1 || !f.owner) continue;
      const w = this.workersAround(f.x, f.z, f.owner);
      if (w > 0) {
        f.integrity = Math.min(1, f.integrity + 0.1 * (w / 6) * dt);
        this.visDirty = true;
      }
    }
    for (const b of this.bases.values()) {
      const def = BASE_DEFS[b.kind];
      if (b.progress < 1) {
        const w = this.workersAround(b.x, b.z, b.owner) + CREW_WORKERS;
        b.progress = Math.min(1, b.progress + (dt * w) / def.manHours);
        b.hp = Math.max(b.hp, def.hpMax * Math.max(0.15, b.progress));
        this.visDirty = true;
        if (b.progress >= 1) {
          b.hp = b.hpMax;
          bus.emit('base:built', { baseId: b.id, kind: b.kind, owner: b.owner });
          bus.emit('toast', { msg: `${b.name ?? def.name} fertiggestellt`, kind: 'info' });
          this.topUpFleetSoon();
        }
      } else if (b.hp < b.hpMax) {
        const w = this.workersAround(b.x, b.z, b.owner);
        if (w > 0) { b.hp = Math.min(b.hpMax, b.hp + b.hpMax * 0.03 * (w / 6) * dt); this.visDirty = true; }
      }
    }
  }

  private topUpFleetSoon(): void {
    for (const o of this.owners) this.nextSpawnAt.set(o, Math.min(this.nextSpawnAt.get(o) ?? 0, this.time));
  }

  // ------------------------------------------------------------------ Update

  /** Gast: Basis aus dem Spiegel entfernen (inkl. Darstellung) */
  removeBaseRemote(id: number): void {
    this.bases.delete(id);
    this.layer.remove(`b${id}`);
    this.visDirty = true;
  }

  update(dtGameHours: number, realDt: number): void {
    if (this.mirror) {
      this.visClock += realDt;
      if (this.visClock >= 0.25 || this.visDirty) { this.visClock = 0; this.syncVisuals(); }
      this.layer.animate(realDt);
      return;
    }
    const dt = dtGameHours > 0 ? dtGameHours : 0;
    if (dt > 0) {
      this.time += dt;
      for (const f of this.fields) {
        if (!f.owner || f.integrity < 0.05) continue;
        if (f.stored < f.capacity) f.stored = Math.min(f.capacity, f.stored + f.output * f.integrity * dt);
      }
      this.tickConvoys(dt);
      this.captureFieldCheck(dt);
      this.maintain(dt);
      this.fires(realDt);
      this.topUpFleet();
      this.dispatchClock += realDt;
      if (this.dispatchClock >= 0.4 || dt > 0.3) { this.dispatchClock = 0; this.dispatch(); }
      this.balClock += dt;
      if (this.balClock >= BALANCE_HOURS) {
        this.balClock = 0;
        for (const o of this.owners) this.emitBalance(o);
      }
    }
    this.flushClock += realDt;
    if (this.flushClock >= 0.25) {
      this.flushClock = 0;
      for (const o of this.owners) if (this.ledger(o).dirty) this.emitBalance(o);
    }
    this.visClock += realDt;
    if (this.visClock >= 0.25 || this.visDirty) { this.visClock = 0; this.syncVisuals(); }
    this.layer.animate(realDt);
  }

  /** Brennende Felder: gelegentlich Feuer-Explosionen */
  private fires(realDt: number): void {
    this.fireTimer += realDt;
    if (this.fireTimer < 1) return;
    const dtr = this.fireTimer;
    this.fireTimer = 0;
    for (const f of this.fields) {
      f.burning = f.integrity < 0.4 && f.integrity > 0;
      if (!f.burning) continue;
      const fr = this.frt.get(f.id)!;
      fr.fireClock += dtr;
      if (fr.fireClock >= 6) {
        fr.fireClock = 0;
        const a = Math.random() * 6.28, r = Math.random() * 0.04;
        const x = f.x + Math.cos(a) * r, z = f.z + Math.sin(a) * r;
        bus.emit('combat:explosion', { x, y: this.groundY(x, z), z, size: 'small', fire: true });
      }
    }
  }

  // ------------------------------------------------------------------ Darstellung

  private syncVisuals(): void {
    this.visDirty = false;
    for (const f of this.fields) {
      this.layer.upsert(`f${f.id}`, {
        kind: 'rig', x: f.x, z: f.z, owner: f.owner, progress: 1, fill: f.stored / Math.max(1, f.capacity),
        active: !!f.owner && f.integrity >= 0.05 && f.stored < f.capacity, burning: f.integrity < 0.4 && f.integrity > 0, health: f.integrity,
      });
    }
    for (const b of this.bases.values()) {
      if (b.kind !== 'hq' && b.kind !== 'refinery') continue;
      const p = this.pool(b.owner);
      b.stock = b.kind === 'refinery' ? p.barrels : undefined;
      this.layer.upsert(`b${b.id}`, {
        kind: b.kind, x: b.x, z: b.z, owner: b.owner, progress: b.progress, fill: clamp(p.barrels / 1500, 0, 1),
        active: b.kind === 'refinery' && b.progress >= 1, burning: b.hp / b.hpMax < 0.35 && b.progress >= 1, health: b.hp / b.hpMax,
      });
    }
  }

  /** Optional: Maßstab explizit mit der Kamera aktualisieren (sonst automatisch beim Zeichnen) */
  updateView(camera: THREE.PerspectiveCamera): void {
    this.layer.updateView(camera);
  }

  get cameraDistanceKm(): number {
    return this.layer.camDistKm;
  }

  /** Nationen mit Pool (für UI/KI) */
  get nations(): readonly string[] {
    return this.owners;
  }

  /** Alle bekannten Nationen aus den Szenario-Konstanten (Fallback) */
  static defaultNations(): string[] {
    return SCENARIO_NATIONS.map((n) => n.a3);
  }
}

export type { GeoMeta };
