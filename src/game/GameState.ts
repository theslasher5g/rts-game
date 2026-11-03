import type { GeoData } from '../world/GeoData';
import { getProfile, RESOURCE_INFO, type ResourceStock, type StartProfile } from './countryData';

/** Spielstunden pro Echtzeitsekunde je Geschwindigkeitsstufe (Index = speed). */
export const SPEED_HOURS_PER_SEC = [0, 1, 3, 6, 12, 24];

const START_DATE = Date.UTC(2027, 2, 1, 6, 0, 0); // 01.03.2027, 06:00

function emptyStock(): ResourceStock {
  return { geld: 0, oel: 0, gas: 0, stahl: 0, nahrung: 0, munition: 0, seltene_erden: 0, industriegueter: 0, konsumgueter: 0 };
}

/**
 * Zentraler Spielzustand (Phase 1: Platzhalter-Simulation).
 * Datum läuft in UTC; die Anzeige formatiert ebenfalls in UTC.
 */
export class GameState {
  playerA3: string | null = null;
  profile: StartProfile | null = null;
  date: Date = new Date(START_DATE);
  /** 0 = Pause, 1..5 */
  speed = 1;
  stock: ResourceStock = emptyStock();
  /** Netto pro Tag (Produktion - Verbrauch) */
  readonly delta: ResourceStock = emptyStock();
  zufriedenheit = 50;

  private readonly geo: GeoData;

  constructor(geo: GeoData) {
    this.geo = geo;
  }

  startGame(a3: string): void {
    const p = getProfile(a3);
    if (!p) {
      console.warn(`GameState.startGame: kein Startprofil für ${a3}`);
    }
    if (!this.geo.countriesByA3.has(a3)) {
      console.warn(`GameState.startGame: ${a3} nicht in den Geodaten`);
    }
    this.playerA3 = a3;
    this.profile = p ?? null;
    this.date = new Date(START_DATE);
    this.speed = 1;
    this.stock = p ? { ...p.stock } : emptyStock();
    for (const r of RESOURCE_INFO) {
      this.delta[r.key] = p ? p.production[r.key] - p.consumption[r.key] : 0;
    }
    this.zufriedenheit = p?.zufriedenheit ?? 50;
  }

  update(dt: number): void {
    if (!this.playerA3 || this.speed <= 0) return;
    const hours = dt * (SPEED_HOURS_PER_SEC[Math.min(5, Math.max(0, Math.round(this.speed)))] ?? 0);
    if (hours <= 0) return;
    this.date.setTime(this.date.getTime() + hours * 3_600_000);
    const days = hours / 24;
    for (const r of RESOURCE_INFO) {
      const v = this.stock[r.key] + this.delta[r.key] * days;
      this.stock[r.key] = v > 0 ? v : 0;
    }
  }
}
