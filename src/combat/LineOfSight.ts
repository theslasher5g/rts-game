/**
 * Phase 3 – Sichtlinie über das Höhenfeld (echte Höhen in km, ohne Überhöhung), Rauch und Gebäude.
 * Höhenangaben ah/bh = Augen-/Zielhöhe in km ÜBER DEM LOKALEN GELÄNDE (Infanterie 0.002, Fahrzeuge 0.003,
 * Hubschrauber 0.1–0.5, Jets 1+). Erdkrümmung wird ignoriert.
 */
import type { Settings } from '../core/types';
import type { GeoData } from '../world/GeoData';
import type { SmokeQuery } from './types';

export interface BuildingRay {
  /** h0/h1 = Strahlhöhen ÜBER DEM LOKALEN GELÄNDE am Start bzw. Ende (km) */
  raycastBlocked(x0: number, z0: number, x1: number, z1: number, h0: number, h1: number): boolean;
}

/** Rauchdichte × Weglänge (km), ab der die Sicht blockiert ist */
const SMOKE_BLOCK = 0.03;
/** Rechenbudget je Frame in Höhenfeld-Stichproben */
const SAMPLE_BUDGET = 60000;
const CACHE_TTL = 0.5;

export class LineOfSight {
  private geo: GeoData;
  private smoke?: SmokeQuery;
  private buildings?: BuildingRay;
  private samples = 0;
  private time = 0;
  /** Paar-Cache: Wert = ±Ablaufzeit (positiv = sichtbar) */
  private readonly cache = new Map<number, number>();
  /** Debug */
  budgetHits = 0;

  constructor(geo: GeoData, _settings?: Settings, smoke?: SmokeQuery, buildings?: BuildingRay) {
    this.geo = geo;
    this.smoke = smoke;
    this.buildings = buildings;
  }

  applySettings(_s: Settings): void {
    // Sichtberechnung nutzt echte Höhen – Überhöhung ist irrelevant
  }

  setProviders(p: { smoke?: SmokeQuery; buildings?: BuildingRay }): void {
    if (p.smoke) this.smoke = p.smoke;
    if (p.buildings) this.buildings = p.buildings;
  }

  /** Einmal je Frame/Substep: Zeit setzen (für Cache) und Budget zurücksetzen */
  beginFrame(timeSec: number): void {
    this.time = timeSec;
    this.samples = 0;
    if (this.cache.size > 30000) this.cache.clear();
  }

  get overBudget(): boolean {
    return this.samples > SAMPLE_BUDGET;
  }

  /** Mit Paar-Cache (~0.5 s). Über Budget: letzter Wert (auch abgelaufen), sonst false. */
  canSeeCached(idA: number, idB: number, ax: number, az: number, ah: number, bx: number, bz: number, bh: number): boolean {
    const key = idA < idB ? idA * 1048576 + idB : idB * 1048576 + idA;
    const c = this.cache.get(key);
    if (c !== undefined && Math.abs(c) > this.time) return c > 0;
    if (this.samples > SAMPLE_BUDGET) {
      this.budgetHits++;
      return c !== undefined ? c > 0 : false;
    }
    const v = this.canSee(ax, az, ah, bx, bz, bh);
    this.cache.set(key, v ? this.time + CACHE_TTL : -(this.time + CACHE_TTL));
    return v;
  }

  canSee(ax: number, az: number, ah: number, bx: number, bz: number, bh: number): boolean {
    const dx = bx - ax, dz = bz - az;
    const d = Math.hypot(dx, dz);
    if (d < 0.02) return true;
    const geo = this.geo;
    const a0 = Math.max(geo.heightAt(ax, az), 0) + ah;
    const b0 = Math.max(geo.heightAt(bx, bz), 0) + bh;
    const step = d < 2 ? 0.05 : Math.min(0.4, Math.max(0.05, d / 50));
    const n = Math.max(2, Math.ceil(d / step));
    // Randbereich ignorieren (Einheiten stehen auf Hängen)
    const margin = Math.min(0.04, d * 0.1);
    const tMin = margin / d, tMax = 1 - tMin;
    const smoke = this.smoke;
    let smokeAcc = 0;
    const stepLen = d / n;
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const x = ax + dx * t, z = az + dz * t;
      if (t >= tMin && t <= tMax) {
        const ray = a0 + (b0 - a0) * t;
        const g = Math.max(geo.heightAt(x, z), 0);
        if (g > ray + 0.0004) {
          this.samples += i;
          return false;
        }
      }
      if (smoke) {
        smokeAcc += smoke.densityAt(x, z) * stepLen;
        if (smokeAcc > SMOKE_BLOCK) {
          this.samples += i;
          return false;
        }
      }
    }
    this.samples += n;
    if (this.buildings && this.buildings.raycastBlocked(ax, az, bx, bz, ah, bh)) return false;
    return true;
  }
}
