/**
 * Einflusskarte auf grobem Raster (2 km Zellen): Stärke eigener/gegnerischer Einheiten, Sichtfeld.
 * Alle Puffer werden wiederverwendet (keine Allokation pro Takt).
 */
import { priceOf } from '../logistics/prices';
import type { Unit } from '../units/types';

export const CELL_KM = 2;

/** Kampfwert einer Einheit (Fass-Preis * Gesundheitsanteil); unbewaffnete = 0 */
export function strengthOf(u: Unit): number {
  if (u.hp <= 0 || u.type.damage <= 0) return 0;
  const p = Math.max(4, priceOf(u.type.id));
  return p * Math.min(1, u.hp / Math.max(1, u.type.hp));
}

export class InfluenceMap {
  readonly w: number;
  readonly h: number;
  readonly own: Float32Array;
  readonly enemy: Float32Array;
  readonly vis: Uint8Array;

  constructor(widthKm: number, heightKm: number) {
    this.w = Math.ceil(widthKm / CELL_KM);
    this.h = Math.ceil(heightKm / CELL_KM);
    this.own = new Float32Array(this.w * this.h);
    this.enemy = new Float32Array(this.w * this.h);
    this.vis = new Uint8Array(this.w * this.h);
  }

  clear(): void {
    this.own.fill(0);
    this.enemy.fill(0);
    this.vis.fill(0);
  }

  private idx(x: number, z: number): number {
    const i = Math.min(this.w - 1, Math.max(0, Math.floor(x / CELL_KM)));
    const j = Math.min(this.h - 1, Math.max(0, Math.floor(z / CELL_KM)));
    return j * this.w + i;
  }

  addOwn(x: number, z: number, v: number): void { this.own[this.idx(x, z)] += v; }
  addEnemy(x: number, z: number, v: number): void { this.enemy[this.idx(x, z)] += v; }

  /** Sichtfeld: Kreis markieren */
  markVis(x: number, z: number, rKm: number): void {
    const r = Math.ceil(rKm / CELL_KM);
    const ci = Math.floor(x / CELL_KM), cj = Math.floor(z / CELL_KM);
    for (let j = Math.max(0, cj - r); j <= Math.min(this.h - 1, cj + r); j++) {
      for (let i = Math.max(0, ci - r); i <= Math.min(this.w - 1, ci + r); i++) {
        if ((i - ci) * (i - ci) + (j - cj) * (j - cj) <= r * r) this.vis[j * this.w + i] = 1;
      }
    }
  }

  visible(x: number, z: number): boolean { return this.vis[this.idx(x, z)] === 1; }

  /** Summe einer Ebene im Umkreis */
  sum(layer: Float32Array, x: number, z: number, rKm: number): number {
    const r = Math.ceil(rKm / CELL_KM);
    const ci = Math.floor(x / CELL_KM), cj = Math.floor(z / CELL_KM);
    let s = 0;
    for (let j = Math.max(0, cj - r); j <= Math.min(this.h - 1, cj + r); j++) {
      for (let i = Math.max(0, ci - r); i <= Math.min(this.w - 1, ci + r); i++) {
        if ((i - ci) * (i - ci) + (j - cj) * (j - cj) <= r * r) s += layer[j * this.w + i];
      }
    }
    return s;
  }

  enemyNear(x: number, z: number, rKm: number): number { return this.sum(this.enemy, x, z, rKm); }
  ownNear(x: number, z: number, rKm: number): number { return this.sum(this.own, x, z, rKm); }

  /**
   * Stärkste Feindzelle (Summe über 3x3) im Umkreis um (x,z); liefert false, wenn unter minValue.
   * Ergebnis in out = [x, z, wert]. `accept` darf Punkte ablehnen (z. B. Zivilgebiet, eigene Truppen nah).
   */
  peakEnemy(x: number, z: number, rKm: number, minValue: number, out: [number, number, number], accept?: (px: number, pz: number) => boolean): boolean {
    const r = Math.ceil(rKm / CELL_KM);
    const ci = Math.floor(x / CELL_KM), cj = Math.floor(z / CELL_KM);
    let best = minValue, found = false;
    for (let j = Math.max(1, cj - r); j <= Math.min(this.h - 2, cj + r); j++) {
      for (let i = Math.max(1, ci - r); i <= Math.min(this.w - 2, ci + r); i++) {
        if ((i - ci) * (i - ci) + (j - cj) * (j - cj) > r * r) continue;
        const c = j * this.w + i;
        if (this.enemy[c] <= 0) continue;
        let s = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) s += this.enemy[c + dj * this.w + di];
        if (s <= best) continue;
        const px = (i + 0.5) * CELL_KM, pz = (j + 0.5) * CELL_KM;
        if (accept && !accept(px, pz)) continue;
        best = s; found = true; out[0] = px; out[1] = pz; out[2] = s;
      }
    }
    return found;
  }
}
