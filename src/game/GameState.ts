import { bus } from '../core/EventBus';
import type { OilPool } from '../logistics/types';
import type { GeoData } from '../world/GeoData';
import { getProfile, type ResourceStock, type StartProfile } from './countryData';
import { OIL_START_BARRELS, SCENARIO_NATIONS, SCENARIO_WARS } from './scenario';

/**
 * Spielstunden pro Echtzeitsekunde je Geschwindigkeitsstufe (Index = speed).
 * Phase 2: taktisch spielbar – Stufe 1 = 10-fache Echtzeit, Stufe 5 = 2 Spielstunden/s.
 */
export const SPEED_HOURS_PER_SEC = [0, 10 / 3600, 60 / 3600, 300 / 3600, 1800 / 3600, 2];
/** Anzeige-Label je Stufe (Zeitraffer-Faktor) */
export const SPEED_LABELS = ['❚❚', '×10', '×60', '×300', '×1800', '×7200'];

const START_DATE = Date.UTC(2027, 2, 1, 6, 0, 0); // 01.03.2027, 06:00

function emptyStock(): ResourceStock {
  return { geld: 0, oel: 0, gas: 0, stahl: 0, nahrung: 0, munition: 0, seltene_erden: 0, industriegueter: 0, konsumgueter: 0 };
}

/**
 * Zentraler Spielzustand (Phase 5): Datum/Tempo, Zufriedenheit und das Ölguthaben des Spielers.
 * Das Öl rechnet nicht GameState selbst, sondern das Wirtschaftssystem (src/logistics) und meldet es per
 * Bus-Ereignis 'oil:balance' (für den Spieler) – oder direkt über `setOil()`.
 * Datum läuft in UTC; die Anzeige formatiert ebenfalls in UTC.
 */
export class GameState {
  playerA3: string | null = null;
  profile: StartProfile | null = null;
  date: Date = new Date(START_DATE);
  private _speed = 1;
  /**
   * Mehrspieler (Gast): true = Zeitsteuerung gesperrt. Zuweisungen an `speed` (Hud-Tasten, Skripte) werden ignoriert;
   * der Host-Wert kommt über setSpeedRemote().
   */
  timeLocked = false;
  /** 0 = Pause, 1..5 */
  get speed(): number {
    return this._speed;
  }
  set speed(v: number) {
    if (this.timeLocked) return;
    this._speed = v;
  }
  /** Gast: Geschwindigkeit des Hosts übernehmen */
  setSpeedRemote(v: number): void {
    this._speed = v;
  }
  /** Ölguthaben des Spielers (einzige Währung) */
  readonly oil: OilPool = { barrels: OIL_START_BARRELS, incomePerHour: 0, spendPerHour: 0, inTransit: 0 };
  /** @deprecated Kompatibilität: immer 0 (Ressourcenblöcke entfallen); Öl steht in `oil` */
  stock: ResourceStock = emptyStock();
  /** @deprecated Kompatibilität: immer 0 */
  readonly delta: ResourceStock = emptyStock();
  zufriedenheit = 50;

  private readonly geo: GeoData;

  constructor(geo: GeoData) {
    this.geo = geo;
    bus.on('oil:balance', (e) => {
      if (e.owner !== this.playerA3) return;
      this.oil.barrels = e.barrels;
      this.oil.incomePerHour = e.incomePerHour;
      this.syncShim();
    });
  }

  /** Kriegspaare zu Spielbeginn (Vorgabe aus dem Szenario); main.ts ruft dafür `war.declare(a, b)` */
  scenarioWars(): Array<[string, string]> {
    return SCENARIO_WARS.map(([a, b]) => [a, b]);
  }

  /** Teilweise Aktualisierung des Ölguthabens (z. B. spendPerHour / inTransit aus dem Wirtschaftssystem) */
  setOil(p: Partial<OilPool>): void {
    Object.assign(this.oil, p);
    this.syncShim();
  }

  startGame(a3: string): void {
    if (!SCENARIO_NATIONS.some((n) => n.a3 === a3 && n.playable)) {
      console.warn(`GameState.startGame: ${a3} ist keine spielbare Szenario-Nation`);
      return;
    }
    const p = getProfile(a3);
    if (!this.geo.countriesByA3.has(a3)) {
      console.warn(`GameState.startGame: ${a3} nicht in den Geodaten`);
    }
    this.playerA3 = a3;
    this.profile = p ?? null;
    this.date = new Date(START_DATE);
    this._speed = 1;
    this.oil.barrels = OIL_START_BARRELS;
    this.oil.incomePerHour = 0;
    this.oil.spendPerHour = 0;
    this.oil.inTransit = 0;
    this.syncShim();
    this.zufriedenheit = p?.zufriedenheit ?? 50;
  }

  /** Im letzten update() vergangene Spielstunden (0 bei Pause / im Menü) – für Einheiten-Simulation. */
  lastHours = 0;

  /**
   * Grenzschutz: verbleibende ECHTZEIT-Sekunden (nur bei laufender Zeit), in denen niemand die Grenze überschreiten darf und
   * nicht gekämpft wird. 0 = kein Schutz. Wird von main.ts beim Spielstart gesetzt (Skirmish und Mehrspieler: 600 s).
   */
  borderProtectSec = 0;

  update(dt: number): void {
    this.lastHours = 0;
    if (this.playerA3 && this.speed > 0 && this.borderProtectSec > 0) this.borderProtectSec = Math.max(0, this.borderProtectSec - dt);
    if (!this.playerA3 || this.speed <= 0) return;
    const hours = dt * (SPEED_HOURS_PER_SEC[Math.min(5, Math.max(0, Math.round(this.speed)))] ?? 0);
    if (hours <= 0) return;
    this.lastHours = hours;
    this.date.setTime(this.date.getTime() + hours * 3_600_000);
  }

  /** Alt-Felder `stock.oel` / `delta.oel` spiegeln das Ölguthaben (pro Tag), alle anderen bleiben 0 */
  private syncShim(): void {
    this.stock.oel = this.oil.barrels;
    this.delta.oel = (this.oil.incomePerHour - this.oil.spendPerHour) * 24;
  }
}
