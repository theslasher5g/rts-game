import { bus } from '../core/EventBus';
import { blocOf, getProfile } from '../game/countryData';
import type { War } from '../game/War';
import type { TargetProtection } from '../combat/types';
import type { UnitManager } from '../units/UnitManager';
import type { Unit } from '../units/types';
import type { CivilCity, InfraInfo, ProtectionQuery, TargetClassification } from './types';

/**
 * Schnittstelle zum Zivilsystem (Agent A, src/civil/CivilianSystem.ts) – hier lokal deklariert,
 * strukturell identisch, damit dieses Modul nicht von der Datei abhängt.
 */
export interface CivilPort {
  cities: CivilCity[];
  infra: InfraInfo[];
  cityAt(x: number, z: number, extraKm?: number): CivilCity | null;
  cityById(id: number): CivilCity | undefined;
  infraNear(x: number, z: number, r: number, out: InfraInfo[]): InfraInfo[];
  populationNear(x: number, z: number, r: number): number;
  startEvacuation(cityId: number, destX?: number, destZ?: number): boolean;
  stopEvacuation(cityId: number): void;
  setController(cityId: number, a3: string): void;
  deliverAid(cityId: number, amount: number, by: string): void;
  damageInfra(id: number, amount: number, attacker: string): void;
  stats: { totalPop: number; killed: number; refugees: number };
}

export interface ProtectionDeps {
  civil: CivilPort;
  war: War;
  units: UnitManager;
  player: () => string | null;
}

/** Absicht (gezielter Angriff) bleibt so lange gültig (Spielzeit, Stunden) */
const INTENT_TTL_H = 5 / 60;
/** Waffen, die als Flächen-/Punktziel gelten (Kleinwaffen gegen Einheiten sind nie "gezielt auf Zivilisten") */
const DIRECT_SMALL = new Set(['rifle', 'mg', 'hmg', 'sniper', 'rpg', 'atgm', 'grenade', 'tank_gun', 'autocannon', 'air_gun']);

interface Intent {
  cityId: number;
  infraId: number;
  attacker: string;
  t: number;
  /** Ziel war eine militärische Kraft (Schild-/Kollateral-Fall), kein gezielter Zivilangriff */
  military: boolean;
}

const INFRA_NAMES: Record<string, string> = {
  hospital: 'Krankenhaus', school: 'Schule', power_plant: 'Kraftwerk', water_works: 'Wasserwerk', port: 'Hafen',
  airport: 'Flughafen', rail_station: 'Bahnhof', town_hall: 'Rathaus', church: 'Kirche',
};
export function infraName(kind: string): string {
  return INFRA_NAMES[kind] ?? kind;
}

/** Befreundet = gleich, Bündnisliste (in eine Richtung) oder gleicher Block (nicht neutral); nie bei Krieg */
export function isFriendly(war: { isHostile(a: string, b: string): boolean }, a: string, b: string): boolean {
  if (a === b) return true;
  if (war.isHostile(a, b)) return false;
  const pa = getProfile(a), pb = getProfile(b);
  if (pa && pa.allies.includes(b)) return true;
  if (pb && pb.allies.includes(a)) return true;
  const ba = blocOf(a);
  return ba !== 'NEUTRAL' && ba === blocOf(b);
}

/**
 * Zielschutz: eigene/verbündete Zivilgebiete und Infrastruktur sind gesperrt (TargetProtection),
 * feindliche Zivilgebiete erlaubt, aber als gezielter Angriff vermerkt (Kriegsverbrechen via Reputation.wasDeliberate).
 */
export class ProtectionSystem implements TargetProtection, ProtectionQuery {
  private readonly civil: CivilPort;
  private readonly war: War;
  private readonly units: UnitManager;
  private readonly player: () => string | null;

  private time = 0;
  private readonly intents: Intent[] = [];
  private readonly cache = new Map<number, boolean>();
  private readonly attackerIdx = new Map<string, number>();
  private readonly tmpI: InfraInfo[] = [];
  private readonly tmpU: Unit[] = [];
  /** Hook (Reputation verdrahtet das): gezielter Angriff auf evakuierende Stadt / Fluchtstrecke */
  onEvacuationAttack?: (cityId: number, attacker: string, severity: number) => void;
  /** Zähler für UI/Debug: abgelehnte Zielwahlen und gezielte Zivilangriffe */
  readonly stats = { blocked: 0, deliberateOrders: 0 };

  constructor(deps: ProtectionDeps) {
    this.civil = deps.civil;
    this.war = deps.war;
    this.units = deps.units;
    this.player = deps.player;
    bus.on('combat:order-target', (e) => this.onOrderTarget(e.attacker, e.x, e.z, e.radiusKm, e.weapon));
  }

  /** Spielzeit in Stunden (nur zum Abgleich der Absichten) */
  get now(): number {
    return this.time;
  }

  update(dtGameHours: number): void {
    if (!(dtGameHours > 0)) return;
    this.time += dtGameHours;
    this.cache.clear();
    for (let i = this.intents.length - 1; i >= 0; i--) if (this.time - this.intents[i].t > INTENT_TTL_H) this.intents.splice(i, 1);
  }

  // ------------------------------------------------------------------ TargetProtection

  /** true NUR für eigene/verbündete Zivilgebiete & Infrastruktur (Angriff gesperrt). Gecacht pro 50-m-Zelle und Frame. */
  isProtected(x: number, z: number, attackerA3: string): boolean {
    let ai = this.attackerIdx.get(attackerA3);
    if (ai === undefined) this.attackerIdx.set(attackerA3, (ai = this.attackerIdx.size));
    const key = (ai * 131072 + Math.floor(x * 20) + 2048) * 131072 + Math.floor(z * 20) + 2048;
    const c = this.cache.get(key);
    if (c !== undefined) return c;
    const r = this.classify(x, z, attackerA3, 0.02).cls === 'own_civil';
    if (this.cache.size > 20000) this.cache.clear();
    this.cache.set(key, r);
    return r;
  }

  // ------------------------------------------------------------------ ProtectionQuery

  classify(x: number, z: number, attackerA3: string, radiusKm = 0.05): TargetClassification {
    const reach = Math.max(radiusKm, 0.01);
    const city = this.civil.cityAt(x, z, 0.1 + reach);
    if (!city) return { cls: 'free', cityId: -1, infraId: -1, reason: '', populationAtRisk: 0 };

    const friendlyToController = isFriendly(this.war, attackerA3, city.controller);
    const occupiedFromOwn = city.controller !== city.country && !friendlyToController && isFriendly(this.war, attackerA3, city.country);
    const ownSide = friendlyToController;

    // Infrastruktur im Wirkungsradius
    const infra = this.civil.infraNear(x, z, reach, this.tmpI);
    let hit: InfraInfo | null = null;
    for (let i = 0; i < infra.length; i++) {
      const f = infra[i];
      if (f.integrity <= 0) continue;
      const dx = Math.max(0, Math.abs(x - f.x) - f.w * 0.5), dz = Math.max(0, Math.abs(z - f.z) - f.d * 0.5);
      if (Math.hypot(dx, dz) > reach) continue;
      if (!hit || (f.protectedStatus && !hit.protectedStatus) || (f.kind === 'hospital' && hit.kind !== 'hospital')) hit = f;
    }
    const pop = Math.round(this.civil.populationNear(x, z, Math.max(reach, 0.05)));

    if (ownSide) {
      const what = hit ? `${infraName(hit.kind)} (${city.name})` : `Stadtgebiet ${city.name}`;
      return {
        cls: 'own_civil', cityId: city.id, infraId: hit ? hit.id : -1,
        reason: `Gesperrt: ${what} – eigene bzw. verbündete Zivilisten, Beschuss nicht erlaubt.`,
        populationAtRisk: pop,
      };
    }
    if (hit && (hit.protectedStatus || hit.kind === 'hospital')) {
      return {
        cls: 'protected', cityId: city.id, infraId: hit.id,
        reason: hit.kind === 'hospital'
          ? `Krankenhaus in ${city.name}: Angriff ist ein schweres Kriegsverbrechen!`
          : `${infraName(hit.kind)} in ${city.name} steht unter Schutz: Angriff ist ein Kriegsverbrechen.`,
        populationAtRisk: pop,
      };
    }
    const military = this.militaryNear(x, z, Math.max(reach, 0.12), attackerA3);
    let reason: string;
    if (occupiedFromOwn) reason = `${city.name} ist besetzt: Beschuss trifft eigene Zivilisten (Kollateralschäden, Zufriedenheit sinkt).`;
    else if (military) reason = `Feindliche Kräfte in ${city.name}: Kollateralschäden unter Zivilisten zu erwarten.`;
    else reason = `Feindliches Zivilgebiet ${city.name}: gezielter Angriff auf Zivilisten ist ein Kriegsverbrechen.`;
    return { cls: 'enemy_civil', cityId: city.id, infraId: hit ? hit.id : -1, reason, populationAtRisk: pop };
  }

  // ------------------------------------------------------------------ Absicht

  /**
   * Wurde ein Angriff dieses Angreifers auf diese Stadt innerhalb der letzten ~5 Spielminuten gezielt befohlen
   * (und nicht auf eine militärische Kraft, sondern auf Zivilgebiet/Infrastruktur)? Reputation nutzt das,
   * um 'collateral'/'bombardment'/Infrastrukturschäden als Kriegsverbrechen einzustufen.
   */
  wasDeliberate(cityId: number, attacker: string, t: number = this.time): boolean {
    for (let i = 0; i < this.intents.length; i++) {
      const it = this.intents[i];
      if (it.cityId === cityId && it.attacker === attacker && !it.military && t - it.t <= INTENT_TTL_H && t >= it.t - 1e-9) return true;
    }
    return false;
  }

  /** Gezielter Angriff auf genau diese Infrastruktur (gleiche Regeln wie wasDeliberate) */
  wasInfraTargeted(infraId: number, attacker: string, t: number = this.time): boolean {
    for (let i = 0; i < this.intents.length; i++) {
      const it = this.intents[i];
      if (it.infraId === infraId && it.attacker === attacker && !it.military && t - it.t <= INTENT_TTL_H) return true;
    }
    return false;
  }

  private onOrderTarget(attacker: string, x: number, z: number, radiusKm: number, weapon: string): void {
    // Direktfeuer auf Einheiten (radiusKm = 0) ist Gefecht, kein gezielter Zivilangriff
    if (radiusKm <= 0 && DIRECT_SMALL.has(weapon)) return;
    const c = this.classify(x, z, attacker, Math.max(radiusKm, 0.02));
    if (c.cls === 'free' || c.cls === 'own_civil') return;
    const military = this.militaryNear(x, z, Math.max(radiusKm, 0.12), attacker);
    // Gezielter Punktbefehl auf militärfreies Zivilgebiet ODER auf geschützte Infrastruktur ohne Militär darin
    const unitTargeted = radiusKm <= 0;
    const m = military || unitTargeted;
    this.intents.push({ cityId: c.cityId, infraId: c.cls === 'protected' ? c.infraId : -1, attacker, t: this.time, military: m });
    if (this.intents.length > 400) this.intents.splice(0, 100);
    if (!m) {
      this.stats.deliberateOrders++;
      const city = this.civil.cityById(c.cityId);
      if (city && city.evacuating && this.onEvacuationAttack) this.onEvacuationAttack(city.id, attacker, 0.5);
    }
  }

  /** Feindliche (zum Angreifer feindliche) Einheiten in der Nähe => Ziel ist militärisch */
  private militaryNear(x: number, z: number, r: number, attacker: string): boolean {
    const arr = this.units.queryRadius(x, z, r, this.tmpU);
    for (let i = 0; i < arr.length; i++) {
      const u = arr[i];
      if (u.hp > 0 && u.owner !== attacker && this.war.isHostile(attacker, u.owner) && u.type.category !== 'support') return true;
    }
    return false;
  }

  /** Spieler-Hilfe für UI: ist dieser Spieler gerade als Angreifer relevant (nur Komfort) */
  isPlayer(a3: string): boolean {
    return this.player() === a3;
  }
}
