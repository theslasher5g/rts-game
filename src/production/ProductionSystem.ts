/**
 * Phase 5 – Produktion: Einheiten werden in Basen (Kaserne, Fahrzeugwerk, Flugplatz, Werft, Depot, HQ …) gegen Fässer
 * gekauft. Der Preis wird sofort abgebucht (Rückerstattung bei Abbruch), Aufträge laufen je Basis nacheinander (max. 5).
 * Neue Basen kosten Fässer und werden von Pionieren (Mann-Stunden wie StructureManager) plus einer kleinen Stammcrew gebaut.
 * Fertige Einheiten erscheinen am Ausgang der Basis und laufen zum Sammelpunkt.
 */
import type * as THREE from 'three';
import { bus } from '../core/EventBus';
import type { Settings } from '../core/types';
import { snapToTerrain } from '../structures/BuildTool';
import { getUnitType } from '../units/unitTypes';
import type { UnitManager } from '../units/UnitManager';
import type { Cities } from '../world/Cities';
import type { GeoData } from '../world/GeoData';
import type { OilEconomy } from '../logistics/OilEconomy';
import { BASE_DEFS, BUILDABLE, CATALOG, hoursOf, priceOf } from '../logistics/prices';
import { SiteLayer } from '../logistics/siteVisuals';
import type { BaseInfo, BaseKind, ProductionOrderInfo } from '../logistics/types';

export const MAX_QUEUE = 5;

export interface ProductionDeps {
  geo: GeoData;
  units: UnitManager;
  economy: OilEconomy;
  cities?: Cities;
  settings: Settings;
}

export interface CatalogEntry {
  typeId: string;
  name: string;
  price: number;
  hours: number;
}

export class ProductionSystem {
  readonly orders = new Map<number, ProductionOrderInfo>();
  readonly object: THREE.Object3D;

  private readonly geo: GeoData;
  private readonly units: UnitManager;
  private readonly eco: OilEconomy;
  private readonly layer: SiteLayer;
  private exag: number;
  private nextOrderId = 1;
  private readonly started = new Set<number>();
  private readonly spawnCount = new Map<number, number>();
  private readonly drawn = new Set<string>();
  private visClock = 0;
  private visDirty = true;

  constructor(deps: ProductionDeps) {
    this.geo = deps.geo;
    this.units = deps.units;
    this.eco = deps.economy;
    this.exag = deps.settings.heightExaggeration;
    this.layer = new SiteLayer(deps.geo, this.exag, 'ProductionSites');
    this.object = this.layer.object;
    bus.on('base:destroyed', ({ baseId }) => {
      for (const [id, o] of [...this.orders]) if (o.baseId === baseId) { this.orders.delete(id); this.started.delete(id); }
      this.visDirty = true;
    });
    bus.on('base:built', () => { this.visDirty = true; });
  }

  applySettings(s: Settings): void {
    this.exag = s.heightExaggeration;
    this.layer.setExag(this.exag);
  }

  // ------------------------------------------------------------------ Katalog

  catalog(kind: BaseKind): CatalogEntry[] {
    const out: CatalogEntry[] = [];
    for (const id of CATALOG[kind] ?? []) {
      const t = getUnitType(id);
      if (!t) continue;
      out.push({ typeId: id, name: t.name, price: priceOf(id), hours: hoursOf(id) });
    }
    return out;
  }

  /** Aufträge einer Basis in Reihenfolge (Kopf zuerst) */
  queueOf(baseId: number): ProductionOrderInfo[] {
    const out: ProductionOrderInfo[] = [];
    for (const o of this.orders.values()) if (o.baseId === baseId) out.push(o);
    return out;
  }

  /** Rate der Produktionseffizienz 0.6–1.0: Öl im Pool und Zustand der Basis */
  efficiency(b: BaseInfo): number {
    const pool = this.eco.pool(b.owner);
    const oil = pool.barrels > 10 ? 1 : 0.6;
    const hp = 0.7 + 0.3 * Math.max(0, Math.min(1, b.hp / b.hpMax));
    return Math.max(0.6, oil * hp);
  }

  // ------------------------------------------------------------------ Aufträge

  queue(baseId: number, typeId: string, rally?: [number, number]): { ok: boolean; reason?: string } {
    const b = this.eco.bases.get(baseId);
    if (!b) return { ok: false, reason: 'Basis existiert nicht' };
    if (b.progress < 1) return { ok: false, reason: 'Basis noch im Bau' };
    if (!(CATALOG[b.kind] ?? []).includes(typeId)) return { ok: false, reason: 'Hier nicht herstellbar' };
    if (this.queueOf(baseId).length >= MAX_QUEUE) return { ok: false, reason: `Warteschlange voll (${MAX_QUEUE})` };
    if (b.kind === 'shipyard' && !this.seaSpot(b.x, b.z, 25)) return { ok: false, reason: 'Kein Zugang zum Meer' };
    const price = priceOf(typeId);
    if (!this.eco.spend(b.owner, price, `produktion:${typeId}`)) {
      const have = Math.floor(this.eco.pool(b.owner).barrels);
      return { ok: false, reason: `Zu wenig Öl: ${price} Fässer nötig, ${have} vorhanden` };
    }
    const hours = hoursOf(typeId);
    const o: ProductionOrderInfo = { id: this.nextOrderId++, baseId, typeId, remainingHours: hours, totalHours: hours, price, owner: b.owner };
    if (rally) { o.rallyX = rally[0]; o.rallyZ = rally[1]; }
    this.orders.set(o.id, o);
    this.promote(baseId);
    return { ok: true };
  }

  /** Sammelpunkt der Basis für alle (noch nicht fertigen) Aufträge setzen */
  setRally(baseId: number, x: number, z: number): void {
    for (const o of this.orders.values()) if (o.baseId === baseId) { o.rallyX = x; o.rallyZ = z; }
  }

  cancel(orderId: number): void {
    const o = this.orders.get(orderId);
    if (!o) return;
    const price = o.price ?? priceOf(o.typeId);
    const frac = this.started.has(orderId) ? Math.max(0, o.remainingHours / o.totalHours) : 1;
    this.orders.delete(orderId);
    this.started.delete(orderId);
    if (o.owner) this.eco.refund(o.owner, price * frac);
    this.promote(o.baseId);
  }

  /** Meldet den Start des Kopfauftrags einer Basis */
  private promote(baseId: number): void {
    const q = this.queueOf(baseId);
    if (!q.length) return;
    const head = q[0];
    if (this.started.has(head.id)) return;
    this.started.add(head.id);
    bus.emit('production:started', { baseId, typeId: head.typeId, owner: head.owner ?? this.eco.bases.get(baseId)?.owner ?? '' });
  }

  // ------------------------------------------------------------------ Bauen

  /** Prüft einen Bauplatz, ohne zu bauen */
  checkSite(owner: string, kind: BaseKind, x: number, z: number): { ok: boolean; reason?: string } {
    const def = BASE_DEFS[kind];
    if (!def) return { ok: false, reason: 'Unbekannter Basistyp' };
    if (!BUILDABLE.includes(kind)) return { ok: false, reason: 'Nicht baubar' };
    if (this.eco.countBases(owner, kind) >= def.maxCount) return { ok: false, reason: `Maximal ${def.maxCount} ${def.name}` };
    const t = snapToTerrain(this.geo, x, z);
    if (!t.land) return { ok: false, reason: 'Kein Bauland (Wasser/außerhalb)' };
    // Gelände flach genug? (Höhenunterschied auf 300 m)
    const h0 = this.geo.heightAt(x, z);
    let dh = 0;
    for (const [dx, dz] of [[0.15, 0], [-0.15, 0], [0, 0.15], [0, -0.15]]) {
      const w = snapToTerrain(this.geo, x + dx, z + dz);
      if (!w.land) return { ok: false, reason: 'Zu nah am Wasser' };
      dh = Math.max(dh, Math.abs(this.geo.heightAt(x + dx, z + dz) - h0));
    }
    if (dh / 0.15 > 0.14) return { ok: false, reason: 'Gelände zu steil' };
    for (const b of this.eco.bases.values()) {
      if (Math.hypot(b.x - x, b.z - z) < 0.35) return { ok: false, reason: 'Zu nah an anderer Basis' };
    }
    if (def.enemyClearKm > 0) {
      const buf: import('../units/types').Unit[] = [];
      this.units.queryRadius(x, z, def.enemyClearKm, buf);
      for (const u of buf) if (u.owner !== owner && this.eco.isHostile(owner, u.owner) && u.type.damage > 0) return { ok: false, reason: `Feind in der Nähe (< ${def.enemyClearKm} km)` };
    }
    if (kind === 'shipyard' && !this.seaSpot(x, z, 3)) return { ok: false, reason: 'Werft braucht Küste (Meer < 3 km)' };
    return { ok: true };
  }

  buildBase(owner: string, kind: BaseKind, x: number, z: number, engineerIds?: number[]): { ok: boolean; id: number; reason?: string } {
    if (kind === 'hq' || kind === 'refinery') {
      const r = this.eco.rebuildBase(owner, kind);
      if (!r.ok) return { ok: false, id: -1, reason: r.reason };
      for (const b of this.eco.bases.values()) if (b.owner === owner && b.kind === kind) return { ok: true, id: b.id };
      return { ok: true, id: -1 };
    }
    const chk = this.checkSite(owner, kind, x, z);
    if (!chk.ok) return { ok: false, id: -1, reason: chk.reason };
    const def = BASE_DEFS[kind];
    if (!this.eco.spend(owner, def.cost, `bau:${kind}`)) return { ok: false, id: -1, reason: `Zu wenig Öl: ${def.cost} Fässer nötig` };
    const b = this.eco.addBase(kind, owner, x, z, 0);
    if (engineerIds && engineerIds.length) {
      const ids = engineerIds.filter((id) => { const u = this.units.get(id); return !!u && u.owner === owner && u.type.id === 'engineer_squad'; });
      if (ids.length) this.units.issueMove(ids, x, z, { formation: 'spread' });
    }
    this.visDirty = true;
    return { ok: true, id: b.id };
  }

  // ------------------------------------------------------------------ Update

  update(dtGameHours: number, realDt = 1 / 60): void {
    const dt = dtGameHours > 0 ? dtGameHours : 0;
    if (dt > 0 && this.orders.size > 0) {
      const byBase = new Map<number, ProductionOrderInfo[]>();
      for (const o of this.orders.values()) {
        const a = byBase.get(o.baseId);
        if (a) a.push(o); else byBase.set(o.baseId, [o]);
      }
      for (const [baseId, q] of byBase) {
        const b = this.eco.bases.get(baseId);
        if (!b || b.progress < 1) continue;
        let budget = dt * this.efficiency(b);
        for (const o of q) {
          if (budget <= 0) break;
          if (!this.started.has(o.id)) this.promote(baseId);
          const use = Math.min(o.remainingHours, budget);
          o.remainingHours -= use;
          budget -= use;
          if (o.remainingHours <= 1e-6) this.complete(b, o);
          else break;
        }
      }
    }
    this.visClock += realDt;
    if (this.visDirty || this.visClock >= 0.3) { this.visClock = 0; this.visDirty = false; this.syncVisuals(); }
    this.layer.animate(realDt);
  }

  private complete(b: BaseInfo, o: ProductionOrderInfo): void {
    this.orders.delete(o.id);
    this.started.delete(o.id);
    const t = getUnitType(o.typeId);
    const n = (this.spawnCount.get(b.id) ?? 0) + 1;
    this.spawnCount.set(b.id, n);
    let x = b.x, z = b.z;
    if (t?.mobility.domain === 'naval') {
      const s = this.seaSpot(b.x, b.z, 25);
      if (!s) { this.eco.refund(b.owner, o.price ?? priceOf(o.typeId)); bus.emit('toast', { msg: 'Werft: kein Seeweg, Auftrag erstattet', kind: 'warn' }); return; }
      x = s[0]; z = s[1];
    } else {
      const a = n * 2.4, r = b.radiusKm * 0.35 + 0.05 * (n % 5);
      x = b.x + Math.cos(a) * r; z = b.z + Math.sin(a) * r;
    }
    const u = this.units.spawn(o.typeId, b.owner, x, z, 0);
    if (!u) {
      this.eco.refund(b.owner, o.price ?? priceOf(o.typeId));
      bus.emit('toast', { msg: `Produktion ${t?.name ?? o.typeId}: kein Platz, Auftrag erstattet`, kind: 'warn' });
      this.promote(b.id);
      return;
    }
    if (o.rallyX !== undefined && o.rallyZ !== undefined) this.units.issueMove([u.id], o.rallyX, o.rallyZ, {});
    bus.emit('production:complete', { baseId: b.id, typeId: o.typeId, owner: b.owner, unitId: u.id });
    this.promote(b.id);
  }

  /** Nächste Meereszelle um (x,z) bis maxKm */
  private seaSpot(x: number, z: number, maxKm: number): [number, number] | null {
    const g = this.geo;
    const step = Math.max(g.cellKm, 0.5);
    for (let r = step; r <= maxKm; r += step) {
      const n = Math.max(8, Math.ceil((2 * Math.PI * r) / step));
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
        if (g.inside(px, pz) && g.countryAt(px, pz) === 0) return [px, pz];
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ Darstellung

  private syncVisuals(): void {
    const seen = new Set<string>();
    for (const b of this.eco.bases.values()) {
      if (b.kind === 'hq' || b.kind === 'refinery') continue;
      const key = `b${b.id}`;
      seen.add(key);
      const busy = this.orders.size > 0 && this.queueOf(b.id).length > 0;
      this.layer.upsert(key, {
        kind: b.kind, x: b.x, z: b.z, owner: b.owner, progress: b.progress, fill: Math.min(1, this.queueOf(b.id).length / MAX_QUEUE),
        active: busy, burning: b.progress >= 1 && b.hp / b.hpMax < 0.35, health: b.hp / b.hpMax,
      });
    }
    for (const k of this.drawn) if (!seen.has(k)) this.layer.remove(k);
    this.drawn.clear();
    for (const k of seen) this.drawn.add(k);
  }

  updateView(camera: THREE.PerspectiveCamera): void {
    this.layer.updateView(camera);
  }
}
