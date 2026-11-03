import { bus } from '../core/EventBus';
import { getProfile, blocOf } from './countryData';
import type { War } from './War';
import type { CasualtyCause, WarCrimeKind } from '../civil/types';
import type { CivilPort } from '../civil/ProtectionSystem';
import { isFriendly, infraName } from '../civil/ProtectionSystem';

/** Optionale Absichts-Abfrage (ProtectionSystem) */
export interface IntentPort {
  wasDeliberate(cityId: number, attacker: string, t?: number): boolean;
  wasInfraTargeted?(infraId: number, attacker: string, t?: number): boolean;
  onEvacuationAttack?: (cityId: number, attacker: string, severity: number) => void;
}

export interface ReputationLogEntry {
  /** Spielzeit in Stunden seit Start (eigene Uhr: Summe der update()-dt) */
  t: number;
  a3: string;
  delta: number;
  reason: string;
}

export interface ReputationDeps {
  war: War;
  civil: CivilPort;
  player: () => string | null;
  protection?: IntentPort;
}

type Kind = 'deliberate' | 'bombardment' | 'collateral' | 'shield' | 'infrastructure' | 'starvation';

interface Pending {
  kind: Kind;
  attacker: string;
  cityId: number;
  killed: number;
  wounded: number;
  age: number;
}

interface InfraPending {
  attacker: string;
  cityId: number;
  kind: string;
  dI: number;
  destroyed: boolean;
  deliberate: boolean;
  age: number;
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
/** Schwere 0..1 aus Opferzahl (10 -> .26, 100 -> .5, 1000 -> .75, 10000 -> 1) */
const sevOf = (killed: number) => clamp(Math.log10(1 + killed) / 4, 0, 1);

const WINDOW_H = 0.08;          // Sammelfenster für Opferereignisse (~5 Spielminuten)
const RECOVERY_PER_DAY = 0.35;  // Erholung des Ansehens Richtung Basiswert
const WEARINESS_PER_DAY = 0.35; // Kriegsmüdigkeit (Zufriedenheit/Tag im Krieg)
const LOG_MAX = 200;

/**
 * Internationales Ansehen (−100..+100) und die zivilen Folgen von Kriegsverbrechen.
 * Zustandsunabhängig (kein GameState-Import): die Zufriedenheit wird über consumeSatisfactionDelta() abgeholt.
 * Spätere Phasen (Handel/Diplomatie) nutzen value(), tradePenalty(), priceMultiplier(), alliesLeaving().
 */
export class Reputation {
  readonly warCrimes = new Map<string, number>();
  log: ReputationLogEntry[] = [];
  /** Kollateralopfer je Angreifer (zivile Tote, nicht gezielt) */
  readonly collateralKilled = new Map<string, number>();

  private readonly war: War;
  private readonly civil: CivilPort;
  private readonly player: () => string | null;
  private protection?: IntentPort;

  private time = 0;
  private readonly rep = new Map<string, number>();
  private readonly satAcc = new Map<string, number>();
  private readonly radical = new Map<string, number>();
  private readonly pending = new Map<string, Pending>();
  private readonly infraPending = new Map<string, InfraPending>();
  private readonly infraLast = new Map<number, number>();
  private readonly flagSanction = new Set<string>();
  private readonly flagAllies = new Set<string>();
  private weariness = new Map<string, number>();
  private wearinessEmitT = 0;
  private emitting = false;

  constructor(deps: ReputationDeps) {
    this.war = deps.war;
    this.civil = deps.civil;
    this.player = deps.player;
    this.protection = deps.protection;
    if (this.protection) this.protection.onEvacuationAttack = (c, a, s) => this.evacuationAttack(c, a, s);

    bus.on('civil:casualties', (e) => this.onCasualties(e.cityId, e.country, e.killed, e.wounded, e.cause, e.attacker));
    bus.on('civil:infra', (e) => this.onInfra(e.id, e.kind, e.cityId, e.integrity, e.destroyed, e.attacker));
    bus.on('civil:aid', (e) => this.onAid(e.cityId, e.amount, e.by));
    // Zufriedenheitsbeiträge anderer Module (Besatzung, Aufstände) einsammeln – eigene Ereignisse ignorieren
    bus.on('satisfaction:delta', (e) => {
      if (this.emitting) return;
      this.satAcc.set(e.a3, (this.satAcc.get(e.a3) ?? 0) + e.delta);
    });
  }

  /** Absichtsprüfung nachträglich verdrahten (ProtectionSystem) */
  setProtection(p: IntentPort): void {
    this.protection = p;
    p.onEvacuationAttack = (c, a, s) => this.evacuationAttack(c, a, s);
  }

  // ------------------------------------------------------------------ Abfragen

  /** Basiswert aus Regierungsform/Block (Demokratie 40, Hybrid 10, Autoritär −10; ohne Profil nach Block) */
  baseline(a3: string): number {
    const p = getProfile(a3);
    if (p) return p.government === 'Demokratie' ? 40 : p.government === 'Hybrid' ? 10 : -10;
    const b = blocOf(a3);
    return b === 'NATO' ? 35 : b === 'CSTO' ? -10 : 0;
  }

  value(a3: string): number {
    const v = this.rep.get(a3);
    return v === undefined ? this.baseline(a3) : v;
  }

  /** Abgelegte (noch nicht abgeholte) Zufriedenheitsänderung; peek ohne Nullen */
  satisfactionDelta(a3: string): number {
    return this.satAcc.get(a3) ?? 0;
  }

  /** Aufsummierte Zufriedenheitsänderung zurückgeben und auf 0 setzen (Lead schreibt sie in GameState.zufriedenheit) */
  consumeSatisfactionDelta(a3: string): number {
    const v = this.satAcc.get(a3) ?? 0;
    this.satAcc.set(a3, 0);
    return v;
  }

  /** Radikalisierung der Bevölkerung von a3 gegen Angreifer (0..100): Basis für Aufstände/Widerstand/Feindseligkeit */
  radicalization(a3: string): number {
    return this.radical.get(a3) ?? 0;
  }

  /** Verbündete wenden sich ab (Ansehen ≤ −60) – für Phase 7 */
  alliesLeaving(a3: string): boolean {
    return this.value(a3) <= -60;
  }

  /** Sanktionen drohen / aktiv (Ansehen ≤ −40) */
  sanctioned(a3: string): boolean {
    return this.value(a3) <= -40;
  }

  /** Handelsabschlag 0..1 (0 ab −20 aufwärts, 1 bei −100) für Phase 6 */
  tradePenalty(a3: string): number {
    return clamp((-20 - this.value(a3)) / 80, 0, 1);
  }

  /** Preisfaktor für Importe/Handel (1 .. 1.6) */
  priceMultiplier(a3: string): number {
    return 1 + 0.6 * this.tradePenalty(a3);
  }

  /** Gesamtzahl Kriegsverbrechen aller Länder */
  totalWarCrimes(): number {
    let n = 0;
    for (const v of this.warCrimes.values()) n += v;
    return n;
  }

  // ------------------------------------------------------------------ Änderungen

  /** Ansehen ändern (öffentlich: auch für spätere Phasen) */
  change(a3: string, delta: number, reason: string): void {
    if (Math.abs(delta) < 0.005) return;
    const old = this.value(a3);
    const v = clamp(old + delta, -100, 100);
    const d = v - old;
    if (Math.abs(d) < 0.005) return;
    this.rep.set(a3, v);
    this.log.push({ t: this.time, a3, delta: d, reason });
    if (this.log.length > LOG_MAX) this.log.splice(0, this.log.length - LOG_MAX);
    bus.emit('reputation:changed', { a3, value: v, delta: d, reason });
    this.checkThresholds(a3, old, v);
  }

  /** Zufriedenheit des Heimatlandes ändern (wird gesammelt und im Bus gemeldet) */
  addSatisfaction(a3: string, delta: number, reason: string): void {
    if (Math.abs(delta) < 0.005) return;
    this.satAcc.set(a3, (this.satAcc.get(a3) ?? 0) + delta);
    this.emitting = true;
    try {
      bus.emit('satisfaction:delta', { a3, delta, reason });
    } finally {
      this.emitting = false;
    }
  }

  private addRadical(a3: string, d: number): void {
    this.radical.set(a3, clamp((this.radical.get(a3) ?? 0) + d, 0, 100));
  }

  /** Empfindlichkeit der Bevölkerung (Demokratie reagiert stark auf Kriegsverbrechen) */
  private sens(a3: string): number {
    const g = getProfile(a3)?.government;
    return g === 'Demokratie' ? 1.2 : g === 'Hybrid' ? 0.7 : g === 'Autoritär' ? 0.35 : 0.8;
  }

  private checkThresholds(a3: string, old: number, v: number): void {
    const isPlayer = this.player() === a3;
    const name = getProfile(a3)?.name ?? a3;
    if (v <= -40 && old > -40 && !this.flagSanction.has(a3)) {
      this.flagSanction.add(a3);
      bus.emit('toast', { msg: isPlayer ? 'Internationale Sanktionen drohen' : `Internationale Sanktionen gegen ${name} drohen`, kind: 'warn' });
    }
    if (v > -30) this.flagSanction.delete(a3);
    if (v <= -60 && old > -60 && !this.flagAllies.has(a3)) {
      this.flagAllies.add(a3);
      const msg = isPlayer ? 'Verbündete wenden sich ab: Bündnispartner drohen mit Austritt' : `Verbündete von ${name} wenden sich ab`;
      bus.emit('toast', { msg, kind: 'error' });
    }
    if (v > -50) this.flagAllies.delete(a3);
  }

  // ------------------------------------------------------------------ Kriegsverbrechen

  private crime(attacker: string, victim: string, kind: WarCrimeKind, cityId: number, severity: number, deltaRep: number, reason: string): void {
    this.warCrimes.set(attacker, (this.warCrimes.get(attacker) ?? 0) + 1);
    severity = clamp(severity, 0, 1);
    bus.emit('warcrime', { attacker, victim, kind, cityId, severity });
    // wiederholte Täter verlieren schneller Ansehen
    const rep = 1 + 0.05 * Math.min(10, (this.warCrimes.get(attacker) ?? 1) - 1);
    this.change(attacker, -Math.abs(deltaRep) * rep, reason);
    // Proteste im Heimatland des Täters
    this.addSatisfaction(attacker, -(1.5 + 7 * severity) * this.sens(attacker), 'Proteste wegen Kriegsverbrechen');
    const p = this.player();
    if (p && attacker === p) bus.emit('toast', { msg: `Kriegsverbrechen: ${reason}`, kind: 'error' });
    else if (p && victim === p) bus.emit('toast', { msg: `Kriegsverbrechen gegen uns: ${reason}`, kind: 'warn' });
  }

  /** Hook (ProtectionSystem): gezielter Angriff auf Evakuierung/Fluchtstrecke */
  evacuationAttack(cityId: number, attacker: string, severity: number): void {
    const city = this.civil.cityById(cityId);
    if (!city || isFriendly(this.war, attacker, city.controller)) return;
    const nm = city.name;
    this.crime(attacker, city.country, 'evacuation_attack', cityId, severity, 6 + 12 * severity, `Angriff auf Evakuierung aus ${nm}`);
    this.addRadical(city.country, 3 + 8 * severity);
    this.addSatisfaction(city.country, -(1 + 3 * severity), `Angriff auf Flüchtlinge aus ${nm}`);
  }

  // ------------------------------------------------------------------ Ereignisse

  private onCasualties(cityId: number, country: string, killed: number, wounded: number, cause: CasualtyCause, attacker: string): void {
    if (!(killed > 0) && !(wounded > 0)) return;
    let kind: Kind;
    if (cause === 'deliberate') kind = 'deliberate';
    else if (cause === 'shield') kind = 'shield';
    else if (cause === 'bombardment') kind = 'bombardment';
    else if (cause === 'infrastructure') kind = 'infrastructure';
    else if (cause === 'starvation') kind = 'starvation';
    else kind = 'collateral';
    // Absicht nachträglich: Kollateral-/Beschussopfer nach gezieltem Befehl auf Zivilgebiet gelten als gezielt
    if ((kind === 'collateral' || kind === 'bombardment') && this.protection?.wasDeliberate(cityId, attacker)) kind = 'deliberate';
    const key = `${kind}|${attacker}|${cityId}`;
    let p = this.pending.get(key);
    if (!p) this.pending.set(key, (p = { kind, attacker, cityId, killed: 0, wounded: 0, age: 0 }));
    p.killed += Math.max(0, killed);
    p.wounded += Math.max(0, wounded);
    void country;
  }

  private onInfra(id: number, kind: string, cityId: number, integrity: number, destroyed: boolean, attacker: string): void {
    const last = this.infraLast.get(id) ?? 1;
    this.infraLast.set(id, integrity);
    const dI = Math.max(0, last - integrity) + (destroyed && last <= integrity ? 0.3 : 0);
    if (dI <= 0 && !destroyed) return;
    const info = this.civil.infra.find((f) => f.id === id);
    const city = this.civil.cityById(cityId);
    if (!city || attacker === '' ) return;
    if (!(info?.protectedStatus || kind === 'hospital')) {
      // Nicht geschützte Infrastruktur: nur Zufriedenheit der Stadt-Heimat bei Zerstörung
      if (destroyed) this.addSatisfaction(city.country, -0.4, 'Zerstörte Infrastruktur');
      return;
    }
    const key = `${id}|${attacker}`;
    let p = this.infraPending.get(key);
    if (!p) {
      const deliberate = !!(this.protection?.wasInfraTargeted?.(id, attacker) || this.protection?.wasDeliberate(cityId, attacker));
      this.infraPending.set(key, (p = { attacker, cityId, kind, dI: 0, destroyed: false, deliberate, age: 0 }));
    }
    p.dI += dI;
    if (destroyed) p.destroyed = true;
    if (p.destroyed || p.dI >= 0.25) this.flushInfra(key);
  }

  private flushInfra(key: string): void {
    const p = this.infraPending.get(key);
    if (!p) return;
    this.infraPending.delete(key);
    const city = this.civil.cityById(p.cityId);
    if (!city) return;
    const own = p.attacker === city.country || isFriendly(this.war, p.attacker, city.controller);
    const nm = infraName(p.kind);
    const sev = clamp(p.dI + (p.destroyed ? 0.3 : 0), 0.1, 1);
    if (own) {
      // Eigenes/verbündetes Objekt (z. B. besetzte Stadt aus Sicht des Besitzers): nur Zufriedenheitsverlust
      this.addSatisfaction(city.country, -(1 + 3 * sev), `${nm} in ${city.name} beschädigt`);
      return;
    }
    if (p.deliberate) {
      const hosp = p.kind === 'hospital';
      const k: WarCrimeKind = hosp ? 'hospital_attack' : 'protected_infra';
      const base = hosp ? 22 : 11;
      this.crime(p.attacker, city.country, k, p.cityId, hosp ? Math.max(0.8, sev) : sev, base * (0.5 + 0.5 * sev),
        hosp ? `Angriff auf Krankenhaus in ${city.name}` : `Angriff auf geschützte Einrichtung (${nm}) in ${city.name}`);
      this.addRadical(city.country, hosp ? 8 : 4);
      this.addSatisfaction(city.country, -(2 + 4 * sev), `${nm} in ${city.name} angegriffen`);
    } else {
      // Kollateralschaden an Schutzobjekt: kleine Ansehensstrafe
      this.change(p.attacker, -(0.6 + 3 * sev), `Schutzobjekt (${nm}) in ${city.name} durch Kollateralschaden beschädigt`);
      this.addSatisfaction(city.country, -(1 + 2 * sev), `${nm} in ${city.name} beschädigt`);
    }
  }

  private onAid(cityId: number, amount: number, by: string): void {
    const city = this.civil.cityById(cityId);
    if (!city || !(amount > 0)) return;
    const mag = clamp(0.2 + 0.3 * Math.log10(1 + amount), 0, 1.5);
    const own = isFriendly(this.war, by, city.controller) || isFriendly(this.war, by, city.country);
    if (own) {
      this.addSatisfaction(city.country, 0.3 + 0.7 * mag, `Hilfslieferung für ${city.name}`);
      this.change(by, 0.2 * mag, `Hilfslieferung für ${city.name}`);
    } else {
      this.change(by, 1.0 * mag, `Humanitäre Hilfe für ${city.name}`);
      this.addRadical(city.country, -2 * mag);
    }
  }

  // ------------------------------------------------------------------ Verarbeitung der gesammelten Opfer

  /** Alle gesammelten Opferereignisse sofort bewerten (update() tut das im Sammelfenster; Tests rufen es direkt) */
  flush(): void {
    for (const [key, p] of [...this.pending]) {
      this.pending.delete(key);
      this.processCasualties(p);
    }
    for (const key of [...this.infraPending.keys()]) this.flushInfra(key);
  }

  private processCasualties(p: Pending): void {
    const city = this.civil.cityById(p.cityId);
    if (!city || p.killed < 1) return;
    const attacker = p.attacker;
    const sev = sevOf(p.killed);
    const victim = city.country;
    const ownCity = attacker === city.country || isFriendly(this.war, attacker, city.controller);
    const atWar = this.war.isHostile(attacker, victim) || this.war.isHostile(attacker, city.controller);
    const out = atWar ? 1 : 1.5;
    const name = city.name;
    const k = Math.round(p.killed);

    // Heimatland der Stadt: Verluste drücken die Zufriedenheit (auch der Spieler bei eigenen Städten)
    const domestic = (0.5 + 4 * sev) * (p.kind === 'deliberate' ? 1.3 : 1) * (ownCity && p.kind === 'collateral' ? 0.8 : 1);

    if (p.kind === 'collateral' && ownCity) {
      // Gefechte in eigenen Städten: gering, aber gezählt und kostet Zufriedenheit
      this.collateralKilled.set(attacker, (this.collateralKilled.get(attacker) ?? 0) + p.killed);
      this.addSatisfaction(victim, -domestic, `${k} zivile Opfer in ${name} (Kollateral)`);
      this.change(attacker, -(0.1 + 1.0 * sev), `Zivile Verluste im Gefecht um ${name}`);
      return;
    }
    if (ownCity) {
      // Eigene Bevölkerung durch Beschuss/Hunger/Infrastrukturausfall
      this.addSatisfaction(victim, -domestic, `${k} zivile Opfer in ${name}`);
      return;
    }

    this.addSatisfaction(victim, -domestic, `${k} zivile Opfer in ${name}`);
    switch (p.kind) {
      case 'deliberate': {
        const kind: WarCrimeKind = 'civilian_attack';
        this.crime(attacker, victim, kind, p.cityId, sev, (3 + 15 * sev) * out, `Gezielter Angriff auf Zivilisten in ${name} (${k} Tote)`);
        this.addRadical(victim, 1 + 6 * sev);
        break;
      }
      case 'bombardment': {
        if (sev >= 0.55) {
          this.crime(attacker, victim, 'indiscriminate_bombardment', p.cityId, sev, (1 + 9 * sev) * out, `Flächenbombardement auf ${name} (${k} Tote)`);
        } else {
          this.change(attacker, -(1 + 9 * sev) * out, `Beschuss von ${name} (${k} zivile Tote)`);
        }
        this.collateralKilled.set(attacker, (this.collateralKilled.get(attacker) ?? 0) + p.killed);
        this.addRadical(victim, 0.5 + 3 * sev);
        break;
      }
      case 'shield': {
        // Schutzschild-Nutzer (Kontrolleur der Stadt) trägt die Hauptlast; Angreifer nur reduziert
        this.collateralKilled.set(attacker, (this.collateralKilled.get(attacker) ?? 0) + p.killed);
        this.change(attacker, -(0.1 + 0.6 * sev) * out, `Zivile Opfer als menschliche Schutzschilde in ${name}`);
        const user = city.controller;
        if (user !== attacker && this.war.isHostile(attacker, user)) {
          this.crime(user, victim, 'human_shield_use', p.cityId, 0.3 + 0.7 * sev, 1 + 6 * sev, `Menschliche Schutzschilde in ${name} (${k} Tote)`);
        }
        this.addRadical(victim, 0.3 + 2 * sev);
        break;
      }
      case 'infrastructure':
      case 'starvation': {
        this.change(attacker, -(0.1 + 1.5 * sev) * out, `Zivile Opfer durch Ausfall der Versorgung in ${name}`);
        this.addRadical(victim, 0.5 + 2 * sev);
        break;
      }
      default: {
        // Kollateral im feindlichen/neutralen Gebiet
        this.collateralKilled.set(attacker, (this.collateralKilled.get(attacker) ?? 0) + p.killed);
        this.change(attacker, -(0.2 + 2.5 * sev) * out, `Kollateralschäden in ${name} (${k} zivile Tote)`);
        this.addRadical(victim, 0.4 + 2.5 * sev);
      }
    }
  }

  // ------------------------------------------------------------------ Zeit

  update(dtGameHours: number): void {
    if (!(dtGameHours > 0)) return;
    this.time += dtGameHours;
    // Opferfenster
    for (const [key, p] of this.pending) {
      p.age += dtGameHours;
      if (p.age >= WINDOW_H) {
        this.pending.delete(key);
        this.processCasualties(p);
      }
    }
    for (const [key, p] of this.infraPending) {
      p.age += dtGameHours;
      if (p.age >= 0.5) this.flushInfra(key);
    }
    // Erholung des Ansehens, Abklingen der Radikalisierung
    const rec = (RECOVERY_PER_DAY * dtGameHours) / 24;
    for (const [a3, v] of this.rep) {
      const b = this.baseline(a3);
      if (v < b) this.rep.set(a3, Math.min(b, v + rec));
      else if (v > b) this.rep.set(a3, Math.max(b, v - rec));
    }
    for (const [a3, v] of this.radical) if (v > 0) this.radical.set(a3, Math.max(0, v - (0.5 * dtGameHours) / 24));
    // Kriegsmüdigkeit: täglich gebündelt melden
    const p = this.player();
    const countries = new Set<string>();
    if (p) countries.add(p);
    for (const a3 of this.warCrimes.keys()) countries.add(a3);
    for (const a3 of countries) {
      if (this.war.enemiesOf(a3).length > 0) this.weariness.set(a3, (this.weariness.get(a3) ?? 0) + (WEARINESS_PER_DAY * dtGameHours) / 24);
    }
    this.wearinessEmitT += dtGameHours;
    if (this.wearinessEmitT >= 24) {
      this.wearinessEmitT = 0;
      for (const [a3, w] of this.weariness) if (w > 0.01) this.addSatisfaction(a3, -w, 'Kriegsmüdigkeit');
      this.weariness = new Map();
    }
  }
}
