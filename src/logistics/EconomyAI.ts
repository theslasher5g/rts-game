/**
 * Phase 5 – minimaler Wirtschaftstreiber für KI-Nationen (kein Kommandeur): baut Kaserne/Fahrzeugwerk/Depot am HQ,
 * produziert alle ~6 Spielstunden im Rahmen des Budgets eine einfache Mischung und schickt einen Teil zur Front.
 * Ersetzt Raffinerie/HQ bei Verlust. Tankwagen-Ersatz übernimmt OilEconomy selbst.
 */
import type { WarQuery } from '../combat/types';
import type { ProductionSystem } from '../production/ProductionSystem';
import type { UnitManager } from '../units/UnitManager';
import type { GeoData } from '../world/GeoData';
import type { OilEconomy } from './OilEconomy';
import { BASE_DEFS, priceOf } from './prices';
import type { BaseKind } from './types';

export interface EconomyAIDeps {
  geo: GeoData;
  economy: OilEconomy;
  production: ProductionSystem;
  units: UnitManager;
  war: WarQuery;
  /** Spieler-Nation (wird nicht gesteuert) */
  getPlayer: () => string | null;
}

/** Produktionsmischung (Gewichte) */
const MIX: Array<{ w: number; types: string[] }> = [
  { w: 40, types: ['inf_squad', 'inf_squad', 'mg_team', 'at_team', 'mortar_team'] },
  { w: 30, types: ['mbt_medium', 'ifv', 'light_tank', 'apc_wheeled'] },
  { w: 15, types: ['sp_artillery', 'spaa', 'mlrs'] },
  { w: 10, types: ['supply_truck'] },
  { w: 5, types: ['engineer_squad', 'recon_wheeled'] },
];
const CYCLE_HOURS = 6;
const RESERVE = 120;
const BUILD_ORDER: BaseKind[] = ['barracks', 'factory', 'depot', 'barracks'];

/** Kommandeur-Schnittstelle (Phase 6): Nation wird von einem AICommander gesteuert */
interface Managed {
  weights: Record<string, number> | null;
  reserve: number;
  cycle: number;
  rally: [number, number] | null;
  unitCap: number;
  buildOrder: BaseKind[];
  requests: Array<{ typeId: string; count: number }>;
  baseRequests: Array<{ kind: BaseKind; x: number; z: number; radius: number }>;
  stats: { queued: number; bases: number; refused: number };
}

export class EconomyAI {
  private readonly deps: EconomyAIDeps;
  private readonly nextAt = new Map<string, number>();
  private readonly off = new Set<string>();
  private readonly managed = new Map<string, Managed>();
  /** Pioniere, die ein Kommandeur gerade für eigene Aufträge braucht (z. B. Brückensprengung) */
  engineerBusy: ((unitId: number) => boolean) | null = null;
  private time = 0;
  private seed = 12345;

  // ------------------------------------------------------------------ Kommandeur-Schnittstelle (Phase 6)

  /** true = Nation wird von einem AICommander gesteuert: gewichtete Produktion, Anforderungen, eigener Zyklus */
  setManaged(a3: string, on: boolean): void {
    if (!on) { this.managed.delete(a3); return; }
    if (this.managed.has(a3)) return;
    this.managed.set(a3, { weights: null, reserve: RESERVE, cycle: 1, rally: null, unitCap: 90, buildOrder: BUILD_ORDER.slice(), requests: [], baseRequests: [], stats: { queued: 0, bases: 0, refused: 0 } });
    this.nextAt.delete(a3);
  }

  isManaged(a3: string): boolean { return this.managed.has(a3); }

  /** Gewichte je Einheitentyp (typeId -> Gewicht >= 0) für die automatische Produktion */
  setPriorities(a3: string, weights: Record<string, number>): void {
    const m = this.managed.get(a3);
    if (m) m.weights = weights;
  }

  setReserve(a3: string, barrels: number): void { const m = this.managed.get(a3); if (m) m.reserve = barrels; }
  setCycle(a3: string, hours: number): void { const m = this.managed.get(a3); if (m) m.cycle = Math.max(0.1, hours); }
  setUnitCap(a3: string, n: number): void { const m = this.managed.get(a3); if (m) m.unitCap = n; }
  setBuildOrder(a3: string, kinds: BaseKind[]): void { const m = this.managed.get(a3); if (m) m.buildOrder = kinds.slice(); }
  /** Sammelpunkt neuer Einheiten (null = Basis-Standard) */
  setRally(a3: string, x: number, z: number): void { const m = this.managed.get(a3); if (m) m.rally = [x, z]; }

  /** typeId mehrfach (vorrangig, vor der Gewichtsproduktion) bestellen; wird im nächsten Zyklus soweit bezahlbar eingereiht */
  requestUnits(a3: string, typeId: string, count = 1): void {
    const m = this.managed.get(a3);
    if (!m) return;
    const r = m.requests.find((q) => q.typeId === typeId);
    if (r) r.count = Math.max(r.count, count); else if (m.requests.length < 12) m.requests.push({ typeId, count });
  }

  /** Zusätzliche Basis nahe (x,z) bauen lassen (Pioniere werden entsandt) */
  requestBase(a3: string, kind: BaseKind, x: number, z: number, radiusKm = 6): void {
    const m = this.managed.get(a3);
    if (!m || m.baseRequests.length >= 3) return;
    if (m.baseRequests.some((b) => b.kind === kind)) return;
    m.baseRequests.push({ kind, x, z, radius: radiusKm });
  }

  /** Laufende Aufträge nach Typ (Preis ist bezahlt, Einheit noch nicht da) */
  inProduction(a3: string, out: Map<string, number> = new Map()): Map<string, number> {
    out.clear();
    for (const o of this.deps.production.orders.values()) {
      if (o.owner !== a3) continue;
      out.set(o.typeId, (out.get(o.typeId) ?? 0) + 1);
    }
    return out;
  }

  statsOf(a3: string): { queued: number; bases: number; refused: number } | null { return this.managed.get(a3)?.stats ?? null; }

  constructor(deps: EconomyAIDeps) {
    this.deps = deps;
  }

  setEnabled(a3: string, on: boolean): void {
    if (on) this.off.delete(a3); else this.off.add(a3);
  }

  private rnd(): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  update(dtGameHours: number): void {
    if (dtGameHours <= 0) return;
    this.time += dtGameHours;
    const player = this.deps.getPlayer();
    let idx = 0;
    for (const a3 of this.deps.economy.nations) {
      idx++;
      if (a3 === player || this.off.has(a3)) continue;
      const m = this.managed.get(a3);
      let at = this.nextAt.get(a3);
      if (at === undefined) { at = 0.25 + idx * 0.1; this.nextAt.set(a3, at); }
      if (this.time < at) continue;
      this.nextAt.set(a3, this.time + (m ? m.cycle : CYCLE_HOURS));
      if (m) this.managedCycle(a3, m); else this.cycle(a3);
    }
  }

  private cycle(a3: string): void {
    const { economy, production } = this.deps;
    // Verlorene Schlüsselgebäude ersetzen
    for (const k of ['refinery', 'hq'] as const) if (economy.countBases(a3, k) === 0) economy.rebuildBase(a3, k);
    const hq = economy.nearestBase(a3, 'hq', 0, 0) ?? economy.basesOf(a3)[0];
    if (!hq) return;
    // Pioniere zu Baustellen schicken
    this.sendEngineers(a3);
    // Basen bauen (eine pro Zyklus)
    for (const kind of BUILD_ORDER) {
      const have = economy.countBases(a3, kind);
      const need = BUILD_ORDER.filter((k) => k === kind).length;
      if (have >= need) continue;
      if (economy.pool(a3).barrels < BASE_DEFS[kind].cost + RESERVE * 0.5) break;
      this.buildNear(a3, kind, hq.x, hq.z);
      break;
    }
    // Produktion
    const front = this.frontPoint(a3, hq.x, hq.z);
    let budget = economy.pool(a3).barrels - RESERVE;
    let guard = 0;
    while (budget > 8 && guard++ < 8) {
      const total = MIX.reduce((s, m) => s + m.w, 0);
      let r = this.rnd() * total, group = MIX[0];
      for (const m of MIX) { if ((r -= m.w) <= 0) { group = m; break; } }
      const typeId = group.types[Math.floor(this.rnd() * group.types.length)];
      const price = priceOf(typeId);
      if (price > budget) continue;
      const base = this.pickBase(a3, typeId);
      if (!base) continue;
      const rally: [number, number] | undefined = front && this.rnd() < 0.7 ? [front[0] + (this.rnd() - 0.5) * 2, front[1] + (this.rnd() - 0.5) * 2] : undefined;
      if (production.queue(base, typeId, rally).ok) budget -= price;
    }
  }

  /** Zyklus einer kommandierten Nation: Infrastruktur, Anforderungen, dann gewichtete Mischung (kurze Warteschlangen) */
  private managedCycle(a3: string, m: Managed): void {
    const { economy, production, units } = this.deps;
    for (const k of ['refinery', 'hq'] as const) if (economy.countBases(a3, k) === 0) economy.rebuildBase(a3, k);
    const hq = economy.nearestBase(a3, 'hq', 0, 0) ?? economy.basesOf(a3)[0];
    if (!hq) return;
    this.sendEngineers(a3);
    // Basis-Anforderungen des Kommandeurs, sonst Standard-Ausbau
    let built = false;
    for (let i = 0; i < m.baseRequests.length && !built; i++) {
      const q = m.baseRequests[i];
      if (economy.pool(a3).barrels < BASE_DEFS[q.kind].cost + m.reserve * 0.4) continue;
      m.baseRequests.splice(i, 1);
      i--;
      if (this.buildNear(a3, q.kind, q.x, q.z, q.radius)) { m.stats.bases++; built = true; }
    }
    if (!built && !m.baseRequests.length) {
      for (const kind of m.buildOrder) {
        const need = m.buildOrder.filter((k) => k === kind).length;
        if (economy.countBases(a3, kind) >= need) continue;
        if (economy.pool(a3).barrels < BASE_DEFS[kind].cost + m.reserve * 0.5) break;
        if (this.buildNear(a3, kind, hq.x, hq.z, 10)) m.stats.bases++;
        break;
      }
    }
    // Obergrenze kampfstarker Einheiten (inkl. in Produktion)
    let armed = 0;
    for (const u of units.units) if (u.owner === a3 && u.type.damage > 0) armed++;
    armed += production.orders.size;
    let budget = economy.pool(a3).barrels - m.reserve;
    const rally = m.rally;
    const rl = (): [number, number] | undefined => rally ? [rally[0] + (this.rnd() - 0.5) * 2, rally[1] + (this.rnd() - 0.5) * 2] : undefined;
    // Vorrangige Anforderungen
    for (const r of m.requests) {
      while (r.count > 0 && budget >= priceOf(r.typeId) * 0.5) {
        const base = this.pickBase(a3, r.typeId, 3);
        if (!base) { m.stats.refused++; r.count = 0; break; }
        if (!production.queue(base, r.typeId, rl()).ok) { r.count = 0; break; }
        budget -= priceOf(r.typeId);
        r.count--;
        m.stats.queued++;
      }
    }
    m.requests = m.requests.filter((r) => r.count > 0);
    // Gewichtete Produktion
    const w = m.weights;
    if (!w) return;
    const ids = Object.keys(w).filter((k) => w[k] > 0);
    let total = 0;
    for (const k of ids) total += w[k];
    let guard = 0;
    while (budget > 8 && guard++ < 14 && total > 0 && armed < m.unitCap) {
      let r = this.rnd() * total, typeId = ids[0];
      for (const k of ids) { if ((r -= w[k]) <= 0) { typeId = k; break; } }
      const price = priceOf(typeId);
      if (price > budget) continue;
      const base = this.pickBase(a3, typeId, 2);
      if (base === null) continue;
      if (production.queue(base, typeId, rl()).ok) { budget -= price; armed++; m.stats.queued++; }
    }
  }

  private pickBase(a3: string, typeId: string, maxQueue = 5): number | null {
    const { economy, production } = this.deps;
    let best: number | null = null, bq = 99;
    for (const b of economy.basesOf(a3)) {
      if (b.progress < 1) continue;
      if (!production.catalog(b.kind).some((e) => e.typeId === typeId)) continue;
      const q = production.queueOf(b.id).length;
      if (q < bq && q < maxQueue) { bq = q; best = b.id; }
    }
    return best;
  }

  /** Ein Punkt 35 % des Weges vom eigenen HQ zum nächsten feindlichen HQ */
  private frontPoint(a3: string, hx: number, hz: number): [number, number] | null {
    const { economy, war } = this.deps;
    let best: [number, number] | null = null, bd = Infinity;
    for (const o of economy.nations) {
      if (o === a3 || !war.isHostile(a3, o)) continue;
      const eh = economy.nearestBase(o, 'hq', hx, hz);
      if (!eh) continue;
      const d = Math.hypot(eh.x - hx, eh.z - hz);
      if (d < bd) { bd = d; best = [hx + (eh.x - hx) * 0.35, hz + (eh.z - hz) * 0.35]; }
    }
    return best;
  }

  private buildNear(a3: string, kind: BaseKind, hx: number, hz: number, maxR = 10): boolean {
    const { production } = this.deps;
    for (let r = 2; r <= maxR; r += 1.5) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2 + this.rnd();
        const x = hx + Math.cos(a) * r, z = hz + Math.sin(a) * r;
        if (!production.checkSite(a3, kind, x, z).ok) continue;
        const engs = this.deps.units.units.filter((u) => u.owner === a3 && u.type.id === 'engineer_squad' && !(this.engineerBusy?.(u.id))).map((u) => u.id);
        const res = production.buildBase(a3, kind, x, z, engs);
        if (res.ok) {
          // Pioniere anfordern, falls keine vorhanden
          if (!engs.length) {
            const hq = this.deps.economy.nearestBase(a3, 'hq', hx, hz);
            if (hq) production.queue(hq.id, 'engineer_squad');
          }
        }
        return res.ok;
      }
    }
    return false;
  }

  private sendEngineers(a3: string): void {
    const { economy, units } = this.deps;
    const sites = economy.basesOf(a3).filter((b) => b.progress < 1);
    if (!sites.length) return;
    for (const u of units.units) {
      if (u.owner !== a3 || u.type.id !== 'engineer_squad' || u.orders.length || this.engineerBusy?.(u.id)) continue;
      let best = sites[0], bd = Infinity;
      for (const s of sites) { const d = Math.hypot(s.x - u.x, s.z - u.z); if (d < bd) { bd = d; best = s; } }
      if (bd > 0.25) units.issueMove([u.id], best.x, best.z, {});
    }
  }
}
