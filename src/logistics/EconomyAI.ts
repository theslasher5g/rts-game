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

export class EconomyAI {
  private readonly deps: EconomyAIDeps;
  private readonly nextAt = new Map<string, number>();
  private readonly off = new Set<string>();
  private time = 0;
  private seed = 12345;

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
      let at = this.nextAt.get(a3);
      if (at === undefined) { at = 0.25 + idx * 0.1; this.nextAt.set(a3, at); }
      if (this.time < at) continue;
      this.nextAt.set(a3, this.time + CYCLE_HOURS);
      this.cycle(a3);
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

  private pickBase(a3: string, typeId: string): number | null {
    const { economy, production } = this.deps;
    let best: number | null = null, bq = 99;
    for (const b of economy.basesOf(a3)) {
      if (b.progress < 1) continue;
      if (!production.catalog(b.kind).some((e) => e.typeId === typeId)) continue;
      const q = production.queueOf(b.id).length;
      if (q < bq && q < 5) { bq = q; best = b.id; }
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

  private buildNear(a3: string, kind: BaseKind, hx: number, hz: number): void {
    const { production } = this.deps;
    for (let r = 2; r <= 10; r += 1.5) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2 + this.rnd();
        const x = hx + Math.cos(a) * r, z = hz + Math.sin(a) * r;
        if (!production.checkSite(a3, kind, x, z).ok) continue;
        const engs = this.deps.units.units.filter((u) => u.owner === a3 && u.type.id === 'engineer_squad').map((u) => u.id);
        const res = production.buildBase(a3, kind, x, z, engs);
        if (res.ok) {
          // Pioniere anfordern, falls keine vorhanden
          if (!engs.length) {
            const hq = this.deps.economy.nearestBase(a3, 'hq', hx, hz);
            if (hq) production.queue(hq.id, 'engineer_squad');
          }
          return;
        }
        return;
      }
    }
  }

  private sendEngineers(a3: string): void {
    const { economy, units } = this.deps;
    const sites = economy.basesOf(a3).filter((b) => b.progress < 1);
    if (!sites.length) return;
    for (const u of units.units) {
      if (u.owner !== a3 || u.type.id !== 'engineer_squad' || u.orders.length) continue;
      let best = sites[0], bd = Infinity;
      for (const s of sites) { const d = Math.hypot(s.x - u.x, s.z - u.z); if (d < bd) { bd = d; best = s; } }
      if (bd > 0.25) units.issueMove([u.id], best.x, best.z, {});
    }
  }
}
