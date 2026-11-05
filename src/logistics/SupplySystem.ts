/**
 * Phase 5 – Nachschub: Treibstoff + Munition (+ Verpflegung, abstrahiert) kosten Fässer.
 *
 * 1. Depots/HQ/Raffinerien/Flugplätze/Werften (Radius BaseInfo.radiusKm) füllen eigene Einheiten laufend auf; die Kosten
 *    (Anteil am Einheitenpreis, siehe prices.ts) werden vom Ölpool des Besitzers abgebucht. Pool leer -> keine Auffüllung
 *    und 'supply:low'.
 * 2. Frontnachschub: 'supply_truck' (Fracht = u.ammo-Zähler in Fass-Äquivalenten, Kapazität 20) werden automatisch vom
 *    nächsten angebundenen Depot zu Einheiten mit < 30 % Treibstoff/Munition geschickt (Haufen werden gebündelt), füllen
 *    alle eigenen Einheiten im Umkreis von 300 m und fahren zurück – alles über echte Routen (gesperrte Straße = kein Nachschub).
 * 3. Ohne Treibstoff/Munition sinkt die Moral (0,01/h) und 'supply:low' wird (ratenbegrenzt) gemeldet.
 */
import { bus } from '../core/EventBus';
import type { Settings } from '../core/types';
import type { WarQuery } from '../combat/types';
import type { Unit } from '../units/types';
import { getUnitType } from '../units/unitTypes';
import type { UnitManager } from '../units/UnitManager';
import type { GeoData } from '../world/GeoData';
import type { OilEconomy } from './OilEconomy';
import { AMMO_PRICE_FRAC, FUEL_PRICE_FRAC, priceOf, SUPPLY_KINDS, type RouteLike } from './prices';
import type { BaseInfo } from './types';

/** Frachtkapazität eines Versorgungs-LKW (Fass-Äquivalente) */
export const SUPPLY_CAPACITY = 20;
const LOW = 0.3;
const SERVE_R = 0.3;
const CLUSTER_R = 0.8;
const FUEL_RATE = 1.5; // Tankfüllungen pro Stunde am Depot
const AMMO_RATE = 1.0; // Munitionssätze pro Stunde am Depot
const TRUCK_SERVE_RATE = 1.2;
const LOAD_HOURS = 0.2;
const RETRY_HOURS = 2;
const WARN_INTERVAL = 45; // s Echtzeit je Einheit

export interface SupplyDeps {
  geo: GeoData;
  units: UnitManager;
  economy: OilEconomy;
  pathfinder: RouteLike;
  war: WarQuery;
  settings: Settings;
  /** nur für den Spieler 'supply:low' melden (sonst für alle) */
  getPlayer?: () => string | null;
}

type TruckState = 'idle' | 'toTarget' | 'serving' | 'toDepot' | 'loading' | 'waiting';

interface TruckRt {
  state: TruckState;
  tx: number;
  tz: number;
  t: number;
  retryAt: number;
  depotId: number;
}

export function fuelFrac(u: Unit): number {
  const f = u.type.fuelKm;
  return Number.isFinite(f) && f > 0 ? Math.min(1, Math.max(0, u.fuel / f)) : 1;
}
export function ammoFrac(u: Unit): number {
  return u.type.damage > 0 && u.type.ammo > 0 ? Math.min(1, Math.max(0, u.ammo / u.type.ammo)) : 1;
}

const _buf: Unit[] = [];

/** Reparatur in eigenen Versorgungsbasen: Anteil der Max-HP je Spielstunde, wenn die Einheit nicht unter Feuer steht */
export const BASE_REPAIR_PER_HOUR = 0.06;
/** Spielstunden ohne Treffer, bevor die Reparatur einsetzt (6 Minuten) */
const REPAIR_CALM_H = 0.1;

export class SupplySystem {
  readonly stats = { low: 0, out: 0, depots: 0 };

  private readonly units: UnitManager;
  private readonly eco: OilEconomy;
  private readonly path: RouteLike;
  private readonly getPlayer: (() => string | null) | undefined;
  private readonly autoOff = new Set<string>();
  private readonly trucks = new Map<number, TruckRt>();
  private readonly warned = new Map<number, number>();
  private readonly seen = new Set<number>();
  private readonly unreachable = new Map<string, number>();
  private readonly pending = new Map<string, number>();
  private readonly lastHit = new Map<number, number>();
  private time = 0;
  private clock = 0;
  private dispatchClock = 0;
  private statClock = 0;

  constructor(deps: SupplyDeps) {
    this.units = deps.units;
    this.eco = deps.economy;
    this.path = deps.pathfinder;
    this.getPlayer = deps.getPlayer;
    bus.on('unit:removed', ({ id }) => { this.trucks.delete(id); this.warned.delete(id); this.seen.delete(id); this.lastHit.delete(id); });
    bus.on('unit:damaged', ({ id, amount }) => { if (amount > 0 && !this.mirror) this.lastHit.set(id, this.time); });
  }

  setAutoResupply(owner: string, on: boolean): void {
    if (on) this.autoOff.delete(owner); else this.autoOff.add(owner);
  }

  isAutoResupply(owner: string): boolean {
    return !this.autoOff.has(owner);
  }

  applySettings(_s: Settings): void { /* nichts zu tun */ }

  // ------------------------------------------------------------------ Abfragen

  supplyStatus(unitId: number): { fuel: number; ammo: number; inSupply: boolean } {
    const u = this.units.get(unitId);
    if (!u) return { fuel: 0, ammo: 0, inSupply: false };
    return { fuel: fuelFrac(u), ammo: ammoFrac(u), inSupply: this.inSupply(u) };
  }

  private inSupply(u: Unit): boolean {
    for (const b of this.eco.bases.values()) {
      if (b.owner !== u.owner || b.progress < 1 || !SUPPLY_KINDS.has(b.kind)) continue;
      if (Math.hypot(b.x - u.x, b.z - u.z) <= b.radiusKm) return true;
    }
    for (const [id, t] of this.trucks) {
      if (t.state === 'idle') continue;
      const tr = this.units.get(id);
      if (tr && tr.owner === u.owner && tr.ammo > 1 && Math.hypot(tr.x - u.x, tr.z - u.z) <= SERVE_R) return true;
    }
    return false;
  }

  /** Eigene Einheiten mit < 30 % Treibstoff/Munition (bedürftigste zuerst) */
  lowUnits(owner: string): Unit[] {
    const out: Array<{ u: Unit; need: number }> = [];
    for (const u of this.units.units) {
      if (u.owner !== owner || u.hp <= 0) continue;
      const need = Math.min(fuelFrac(u), ammoFrac(u));
      if (need < LOW) out.push({ u, need });
    }
    out.sort((a, b) => a.need - b.need);
    return out.map((e) => e.u);
  }

  statsFor(owner: string): { low: number; out: number; depots: number; trucks: number } {
    let low = 0, out = 0, trucks = 0;
    for (const u of this.units.units) {
      if (u.owner !== owner || u.hp <= 0) continue;
      const need = Math.min(fuelFrac(u), ammoFrac(u));
      if (need < LOW) low++;
      if (need <= 0) out++;
      if (u.type.id === 'supply_truck') trucks++;
    }
    let depots = 0;
    for (const b of this.eco.bases.values()) if (b.owner === owner && b.progress >= 1 && (b.kind === 'depot' || b.kind === 'fuel_depot')) depots++;
    return { low, out, depots, trucks };
  }

  // ------------------------------------------------------------------ Update

  /** Mehrspieler (Gast): Spiegel – keine Nachschub-Simulation (nur Statistik für die Anzeige) */
  mirror = false;

  update(dtGameHours: number, realDt: number): void {
    this.clock += realDt;
    this.statClock += realDt;
    const dt = dtGameHours > 0 && !this.mirror ? dtGameHours : 0;
    if (dt > 0) {
      this.time += dt;
      this.depotRefill(dt);
      this.repairInBases(dt);
      this.tickTrucks(dt);
      this.moraleAndWarn(dt);
      this.dispatchClock += realDt;
      if (this.dispatchClock >= 1.5 || dt > 0.3) { this.dispatchClock = 0; this.dispatch(); }
      this.flushCosts(false);
    }
    if (this.statClock >= 0.5) {
      this.statClock = 0;
      const p = this.getPlayer?.() ?? null;
      if (p) {
        const s = this.statsFor(p);
        this.stats.low = s.low; this.stats.out = s.out; this.stats.depots = s.depots;
      } else {
        let low = 0, out = 0;
        for (const u of this.units.units) {
          const need = Math.min(fuelFrac(u), ammoFrac(u));
          if (need < LOW) low++;
          if (need <= 0) out++;
        }
        let d = 0;
        for (const b of this.eco.bases.values()) if (b.progress >= 1 && (b.kind === 'depot' || b.kind === 'fuel_depot')) d++;
        this.stats.low = low; this.stats.out = out; this.stats.depots = d;
      }
    }
  }

  // ------------------------------------------------------------------ Kosten

  private canPay(owner: string, cost: number): boolean {
    return this.eco.pool(owner).barrels - (this.pending.get(owner) ?? 0) >= cost;
  }
  private charge(owner: string, cost: number): void {
    this.pending.set(owner, (this.pending.get(owner) ?? 0) + cost);
  }
  private flushCosts(force: boolean): void {
    for (const [o, v] of this.pending) {
      if (v >= 0.5 || (force && v > 0)) {
        this.eco.spend(o, Math.min(v, this.eco.pool(o).barrels), 'supply');
        this.pending.set(o, 0);
      }
    }
  }

  // ------------------------------------------------------------------ Depots

  private supplyBases(): BaseInfo[] {
    const out: BaseInfo[] = [];
    for (const b of this.eco.bases.values()) if (b.progress >= 1 && SUPPLY_KINDS.has(b.kind)) out.push(b);
    return out;
  }

  private depotRefill(dt: number): void {
    const done = new Set<number>();
    for (const b of this.supplyBases()) {
      this.units.queryRadius(b.x, b.z, b.radiusKm, _buf);
      for (const u of _buf) {
        if (u.owner !== b.owner || u.hp <= 0 || done.has(u.id) || u.garrisonId !== undefined) continue;
        if (u.type.id === 'supply_truck') continue; // Fracht wird über LKW-Zustand geladen
        const fMiss = 1 - fuelFrac(u), aMiss = 1 - ammoFrac(u);
        if (fMiss <= 0.001 && aMiss <= 0.001) continue;
        const price = priceOf(u.type.id);
        const fAdd = Math.min(fMiss, FUEL_RATE * dt), aAdd = Math.min(aMiss, AMMO_RATE * dt);
        const cost = fAdd * price * FUEL_PRICE_FRAC + aAdd * price * AMMO_PRICE_FRAC;
        if (!this.canPay(b.owner, cost)) {
          this.warn(u, aMiss > fMiss ? 'ammo' : 'fuel');
          continue;
        }
        this.charge(b.owner, cost);
        if (fAdd > 0) u.fuel = Math.min(u.type.fuelKm, u.fuel + fAdd * u.type.fuelKm);
        if (aAdd > 0) u.ammo = Math.min(u.type.ammo, u.ammo + aAdd * u.type.ammo);
        done.add(u.id);
      }
    }
  }

  /** Beschädigte Fahrzeuge regenerieren langsam in eigenen Depots/HQ/Raffinerien/Flugplätzen/Werften (nur wenn sie ruhig stehen) */
  private repairInBases(dt: number): void {
    const done = new Set<number>();
    for (const b of this.supplyBases()) {
      this.units.queryRadius(b.x, b.z, b.radiusKm, _buf);
      for (const u of _buf) {
        if (u.owner !== b.owner || u.hp <= 0 || u.hp >= u.type.hp || done.has(u.id) || u.garrisonId !== undefined) continue;
        const cat = u.type.category;
        if (cat === 'infantry' || cat === 'drone' || u.speedKmh > 3) continue;
        const hit = this.lastHit.get(u.id);
        if (hit !== undefined && this.time - hit < REPAIR_CALM_H) continue;
        u.hp = Math.min(u.type.hp, u.hp + u.type.hp * BASE_REPAIR_PER_HOUR * dt);
        done.add(u.id);
      }
    }
  }

  // ------------------------------------------------------------------ Moral / Warnungen

  private warn(u: Unit, what: 'fuel' | 'ammo'): void {
    const p = this.getPlayer?.();
    if (p !== undefined && p !== null && u.owner !== p) return;
    if (p === null) return;
    const last = this.warned.get(u.id) ?? -1e9;
    if (this.clock - last < WARN_INTERVAL) return;
    this.warned.set(u.id, this.clock);
    bus.emit('supply:low', { unitId: u.id, what });
  }

  private moraleAndWarn(dt: number): void {
    for (const u of this.units.units) {
      if (u.hp <= 0) continue;
      const f = fuelFrac(u), a = ammoFrac(u);
      if (f <= 0 || a <= 0) {
        u.morale = Math.max(0, u.morale - 0.01 * dt);
      }
      if (f < 0.15 || a < 0.15) this.warn(u, f <= a ? 'fuel' : 'ammo');
      if (u.type.id === 'supply_truck' && !this.seen.has(u.id)) {
        // erstmals gesehen: Fracht-Zähler initialisieren (CivilianSystem nutzt dieselbe Konvention)
        this.seen.add(u.id);
        if (u.ammo <= 0 && u.type.ammo === 0) u.ammo = SUPPLY_CAPACITY;
      }
    }
  }

  // ------------------------------------------------------------------ Frontnachschub

  private truckMob() {
    return getUnitType('supply_truck')!.mobility;
  }

  private routeOk(fx: number, fz: number, tx: number, tz: number): boolean {
    return this.path.routeExists ? this.path.routeExists(fx, fz, tx, tz, this.truckMob()) : this.path.findRoute(fx, fz, tx, tz, this.truckMob()) !== null;
  }

  private send(u: Unit, x: number, z: number): void {
    this.units.issueMove([u.id], x, z, { formation: 'column' });
  }

  private nearestSupplyBase(owner: string, x: number, z: number, prefer: 'depot' | 'any' = 'any'): BaseInfo | null {
    let best: BaseInfo | null = null, bd = Infinity;
    for (const b of this.eco.bases.values()) {
      if (b.owner !== owner || b.progress < 1 || !SUPPLY_KINDS.has(b.kind)) continue;
      if (b.kind === 'airfield' || b.kind === 'shipyard') continue;
      let d = Math.hypot(b.x - x, b.z - z);
      if (prefer === 'depot' && b.kind !== 'depot' && b.kind !== 'fuel_depot') d += 8; // Depots bevorzugen, HQ/Raffinerie als Rückfall
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  private dispatch(): void {
    const owners = new Set<string>();
    for (const b of this.eco.bases.values()) owners.add(b.owner);
    let budget = 2;
    for (const owner of owners) {
      if (this.autoOff.has(owner)) continue;
      // Bedürftige Einheiten außerhalb von Versorgungsradien
      const needy: Unit[] = [];
      for (const u of this.units.units) {
        if (u.owner !== owner || u.hp <= 0 || u.garrisonId !== undefined || u.type.mobility.domain === 'air') continue;
        if (u.type.id === 'supply_truck' || u.type.id === 'tanker_truck') continue;
        if (Math.min(fuelFrac(u), ammoFrac(u)) >= LOW) continue;
        if (this.nearBase(u) || this.coveredByTruck(u)) continue;
        needy.push(u);
      }
      if (!needy.length) continue;
      const idle: Array<{ u: Unit; rt: TruckRt }> = [];
      for (const [id, rt] of this.trucks) {
        const u = this.units.get(id);
        if (u && u.owner === owner && rt.state === 'idle' && u.orders.length === 0) idle.push({ u, rt });
      }
      // Neue LKW erfassen (noch ohne Zustand)
      for (const u of this.units.units) {
        if (u.owner !== owner || u.type.id !== 'supply_truck' || this.trucks.has(u.id) || u.orders.length > 0) continue;
        if (!this.seen.has(u.id)) { this.seen.add(u.id); if (u.ammo <= 0 && u.type.ammo === 0) u.ammo = SUPPLY_CAPACITY; }
        const rt: TruckRt = { state: 'idle', tx: u.x, tz: u.z, t: 0, retryAt: 0, depotId: -1 };
        this.trucks.set(u.id, rt);
        idle.push({ u, rt });
      }
      if (!idle.length) continue;
      needy.sort((a, b) => Math.min(fuelFrac(a), ammoFrac(a)) - Math.min(fuelFrac(b), ammoFrac(b)));
      const used = new Set<number>();
      for (const seed of needy) {
        if (used.has(seed.id) || !idle.length || budget <= 0) break;
        // Haufen bilden
        let cx = 0, cz = 0, n = 0;
        for (const o of needy) {
          if (used.has(o.id) || Math.hypot(o.x - seed.x, o.z - seed.z) > CLUSTER_R) continue;
          used.add(o.id);
          cx += o.x; cz += o.z; n++;
        }
        cx /= n; cz /= n;
        const key = `${owner}:${Math.round(cx / 2)}:${Math.round(cz / 2)}`;
        if ((this.unreachable.get(key) ?? 0) > this.time) continue;
        // geeignetsten LKW wählen: Fracht bevorzugt, sonst nächster
        let bi = -1, bs = Infinity;
        for (let i = 0; i < idle.length; i++) {
          const t = idle[i].u;
          const d = Math.hypot(t.x - cx, t.z - cz);
          const s = d + (t.ammo >= 6 ? 0 : 1000);
          if (s < bs) { bs = s; bi = i; }
        }
        const { u: truck, rt } = idle[bi];
        budget--;
        if (truck.ammo >= 6) {
          if (!this.routeOk(truck.x, truck.z, cx, cz)) { this.unreachable.set(key, this.time + RETRY_HOURS); continue; }
          rt.state = 'toTarget'; rt.tx = cx; rt.tz = cz; rt.t = 0;
          this.send(truck, cx, cz);
          bus.emit('convoy:started', { convoyId: truck.id, owner, kind: 'supply' });
        } else {
          const dep = this.nearestSupplyBase(owner, truck.x, truck.z, 'depot');
          if (!dep || !this.routeOk(truck.x, truck.z, dep.x, dep.z) || !this.routeOk(dep.x, dep.z, cx, cz)) {
            this.unreachable.set(key, this.time + RETRY_HOURS);
            continue;
          }
          rt.state = 'toDepot'; rt.depotId = dep.id; rt.tx = cx; rt.tz = cz; rt.t = 0;
          this.send(truck, dep.x, dep.z);
          bus.emit('convoy:started', { convoyId: truck.id, owner, kind: 'supply' });
        }
        idle.splice(bi, 1);
      }
    }
  }

  private nearBase(u: Unit): boolean {
    for (const b of this.eco.bases.values()) {
      if (b.owner !== u.owner || b.progress < 1 || !SUPPLY_KINDS.has(b.kind)) continue;
      if (Math.hypot(b.x - u.x, b.z - u.z) <= b.radiusKm) return true;
    }
    return false;
  }

  private coveredByTruck(u: Unit): boolean {
    for (const [id, rt] of this.trucks) {
      if (rt.state === 'idle' || rt.state === 'waiting') continue;
      const tr = this.units.get(id);
      if (!tr || tr.owner !== u.owner) continue;
      if (Math.hypot(rt.tx - u.x, rt.tz - u.z) <= CLUSTER_R + SERVE_R) return true;
    }
    return false;
  }

  private tickTrucks(dt: number): void {
    for (const [id, rt] of [...this.trucks]) {
      const u = this.units.get(id);
      if (!u) { this.trucks.delete(id); continue; }
      switch (rt.state) {
        case 'idle':
          break;
        case 'toDepot': {
          const dep = this.eco.bases.get(rt.depotId);
          if (!dep) { rt.state = 'idle'; break; }
          if (Math.hypot(u.x - dep.x, u.z - dep.z) < Math.max(0.5, Math.min(dep.radiusKm, 1.0) * 0.6)) { rt.state = 'loading'; rt.t = LOAD_HOURS; u.speedKmh = 0; }
          else if (u.orders.length === 0) { rt.state = 'waiting'; rt.retryAt = this.time + RETRY_HOURS; }
          break;
        }
        case 'loading': {
          rt.t -= dt;
          if (rt.t > 0) break;
          const miss = SUPPLY_CAPACITY - u.ammo;
          const pay = Math.min(miss, this.eco.pool(u.owner).barrels);
          if (pay > 0 && this.eco.spend(u.owner, pay, 'supply-load')) u.ammo += pay;
          u.fuel = u.type.fuelKm;
          if (u.ammo >= 5 && Number.isFinite(rt.tx) && this.routeOk(u.x, u.z, rt.tx, rt.tz)) {
            rt.state = 'toTarget';
            this.send(u, rt.tx, rt.tz);
          } else { rt.state = 'idle'; }
          break;
        }
        case 'toTarget': {
          if (Math.hypot(u.x - rt.tx, u.z - rt.tz) < 0.25) { rt.state = 'serving'; rt.t = 0; u.speedKmh = 0; }
          else if (u.orders.length === 0) { rt.state = 'waiting'; rt.retryAt = this.time + RETRY_HOURS; }
          break;
        }
        case 'serving': {
          rt.t += dt;
          const served = this.serve(u, dt);
          if (!served || u.ammo < 0.5 || rt.t > 1.5) this.goHome(u, rt);
          break;
        }
        case 'waiting':
          if (this.time >= rt.retryAt) this.goHome(u, rt);
          break;
      }
    }
  }

  /** Alle eigenen Einheiten im Umkreis aus der LKW-Fracht versorgen; true, wenn noch jemand Bedarf hatte */
  private serve(truck: Unit, dt: number): boolean {
    this.units.queryRadius(truck.x, truck.z, SERVE_R, _buf);
    let any = false;
    for (const u of _buf) {
      if (u.owner !== truck.owner || u.id === truck.id || u.hp <= 0 || u.type.id === 'supply_truck') continue;
      const fMiss = 1 - fuelFrac(u), aMiss = 1 - ammoFrac(u);
      if (fMiss <= 0.02 && aMiss <= 0.02) continue;
      any = true;
      if (truck.ammo < 0.1) break;
      const price = priceOf(u.type.id);
      let fAdd = Math.min(fMiss, FUEL_RATE * TRUCK_SERVE_RATE * dt), aAdd = Math.min(aMiss, AMMO_RATE * TRUCK_SERVE_RATE * dt);
      let cost = fAdd * price * FUEL_PRICE_FRAC + aAdd * price * AMMO_PRICE_FRAC;
      if (cost > truck.ammo) { const k = truck.ammo / cost; fAdd *= k; aAdd *= k; cost = truck.ammo; }
      truck.ammo -= cost;
      if (fAdd > 0) u.fuel = Math.min(u.type.fuelKm, u.fuel + fAdd * u.type.fuelKm);
      if (aAdd > 0) u.ammo = Math.min(u.type.ammo, u.ammo + aAdd * u.type.ammo);
    }
    return any;
  }

  private goHome(u: Unit, rt: TruckRt): void {
    const dep = this.nearestSupplyBase(u.owner, u.x, u.z, 'depot');
    if (!dep) { rt.state = 'idle'; return; }
    if (Math.hypot(u.x - dep.x, u.z - dep.z) < 0.5) {
      rt.state = 'loading'; rt.depotId = dep.id; rt.t = LOAD_HOURS; rt.tx = u.x; rt.tz = u.z;
      return;
    }
    if (!this.routeOk(u.x, u.z, dep.x, dep.z)) { rt.state = 'waiting'; rt.retryAt = this.time + RETRY_HOURS; return; }
    rt.state = 'toDepot';
    rt.depotId = dep.id;
    rt.tx = NaN; rt.tz = NaN;
    this.send(u, dep.x, dep.z);
  }
}
