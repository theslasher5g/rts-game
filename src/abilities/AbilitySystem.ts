/**
 * Phase 7 – Kommandeursfähigkeiten (Call-ins gegen Fässer, mit Abklingzeit).
 *
 * HOST-SEITIG: `use()` prüft, bezahlt (OilEconomy.spend) und plant den Effekt; Gäste leiten den Aufruf als RPC
 * 'abilities.use' (a3, id, x, z) an den Host. Einschläge laufen über CombatSystem.strikeAt (normaler Splash-Pfad),
 * damit Effekte, Ton, Krater, Zivilsystem und Ansehen wie bei normalem Beschuss reagieren.
 *
 * ZEITEN
 *  - Abklingzeiten in SPIELSTUNDEN (update(dtGameHours) summiert).
 *  - Effekt-Zeitleiste (Schüsse, Bombenabwurf) in SPIELSEKUNDEN, je update() höchstens 3 s (wie die Kampfsimulation,
 *    sonst würden Einschläge bei hohem Zeitraffer dem Kampfsystem davonlaufen).
 *  - Nebel-Aufdeckung und Rauchdauer: das Nebel-/Effektsystem rechnet in ECHTzeit-Sekunden. Die Spielzeitdauer wird über
 *    die gemessene Zeitraffer-Rate (Spielsekunden je Echtsekunde, geglättet) umgerechnet und auf einen spielbaren Bereich
 *    begrenzt (Aufklärung 20..90 s, Rauch 30..120 s).
 */
import { bus } from '../core/EventBus';
import type { CombatSystem } from '../combat/CombatSystem';
import type { WeaponKind } from '../combat/types';
import type { GameContext } from '../game/context';
import type { Settings } from '../core/types';
import type { ProtectionQuery } from '../civil/types';
import { SUPPLY_CAPACITY } from '../logistics/SupplySystem';
import type { Unit } from '../units/types';

export type AbilityId = 'recon_flight' | 'smoke_screen' | 'artillery_barrage' | 'airstrike' | 'supply_drop' | 'emergency_repair';

export interface AbilityDef {
  id: AbilityId;
  /** Deutscher Name */
  name: string;
  /** Kurzlabel für Schaltflächen */
  short: string;
  /** Symbol (Unicode) */
  icon: string;
  /** Taste (KeyboardEvent.code), z. B. 'F1' */
  key: string;
  /** Kosten in Fässern */
  cost: number;
  /** Abklingzeit in Spielstunden */
  cooldownH: number;
  /** Wirkungsradius (km) – Vorschaukreis; Luftschlag: halbe Länge der Bombenreihe */
  radiusKm: number;
  /** Fügt Schaden zu (Zivilschutz-Regeln gelten) */
  damaging: boolean;
  /** Beschreibung (Tooltip) */
  desc: string;
}

export const ABILITY_DEFS: AbilityDef[] = [
  { id: 'recon_flight', name: 'Aufklärungsflug', short: 'Aufkl.', icon: '◎', key: 'F1', cost: 30, cooldownH: 1.5, radiusKm: 4, damaging: false, desc: 'Drohne deckt 4 km Radius um das Ziel kurz auf (Nebel des Krieges).' },
  { id: 'smoke_screen', name: 'Nebelwand', short: 'Nebel', icon: '☁', key: 'F2', cost: 15, cooldownH: 0.5, radiusKm: 0.35, damaging: false, desc: 'Rauchwand (≈0,6 km breit) blockiert die Sicht für einige Minuten.' },
  { id: 'artillery_barrage', name: 'Artilleriefeuer', short: 'Artillerie', icon: '✹', key: 'F3', cost: 60, cooldownH: 2, radiusKm: 0.2, damaging: true, desc: '12 Granaten in 40 s auf 0,2 km Radius. Nicht auf eigene/verbündete Zivilgebiete.' },
  { id: 'airstrike', name: 'Luftschlag', short: 'Luftschlag', icon: '✈', key: 'F4', cost: 110, cooldownH: 3, radiusKm: 0.2, damaging: true, desc: 'Jet wirft nach ~60 s vier schwere Bomben in einer 0,4 km langen Reihe. Nicht auf eigene/verbündete Zivilgebiete.' },
  { id: 'supply_drop', name: 'Versorgungsabwurf', short: 'Nachschub', icon: '▣', key: 'F5', cost: 40, cooldownH: 2, radiusKm: 1.5, damaging: false, desc: 'Füllt Treibstoff und Munition aller eigenen Einheiten im Umkreis von 1,5 km.' },
  { id: 'emergency_repair', name: 'Notreparatur', short: 'Reparatur', icon: '✚', key: 'F6', cost: 50, cooldownH: 3, radiusKm: 1, damaging: false, desc: 'Stellt 40 % der Lebenspunkte eigener Fahrzeuge (und Basen/Ölfelder) im Umkreis von 1 km wieder her.' },
];

export interface AbilityFogPort {
  revealArea(x: number, z: number, r: number, forA3?: string, durationSec?: number): void;
}

export interface AbilityOptions {
  combat?: CombatSystem;
  fog?: AbilityFogPort | null;
  protection?: ProtectionQuery | null;
  /** Geländeüberhöhung (settings.heightExaggeration) für Flughöhen/Bodenhöhe der Effekte */
  exag?: number;
}

export interface AbilityCheck {
  ok: boolean;
  reason?: string;
  /** Erlaubt, aber heikel (feindliches Zivilgebiet: Kriegsverbrechen-Risiko) */
  warn?: string;
}

/** Konstanten (Spielsekunden, falls nicht anders vermerkt) */
export const AB = {
  RECON_REVEAL_GAME_H: 0.4,
  SMOKE_GAME_SEC: 120,
  BARRAGE_SHELLS: 12,
  BARRAGE_SPAN_SEC: 40,
  BARRAGE_DELAY_SEC: 8,
  BARRAGE_FLIGHT_SEC: 6,
  BARRAGE_DMG_MUL: 4,
  AIRSTRIKE_DELAY_SEC: 60,
  AIRSTRIKE_BOMBS: 4,
  AIRSTRIKE_LENGTH_KM: 0.4,
  AIRSTRIKE_FALL_SEC: 9,
  AIRSTRIKE_DMG_MUL: 1.5,
  REPAIR_FRAC: 0.4,
  MAX_FX_DT: 3,
} as const;

interface Timed {
  at: number;
  fn: () => void;
}

const REPAIRABLE_SKIP = new Set(['infantry', 'drone']);

export class AbilitySystem {
  readonly defs: AbilityDef[] = ABILITY_DEFS;

  private readonly ctx: GameContext;
  private combat: CombatSystem;
  private fog: AbilityFogPort | null;
  private protection: ProtectionQuery | null;
  private exag: number;

  /** Spielstunden seit Start (für Abklingzeiten) */
  private time = 0;
  /** Effekt-Zeitleiste in Spielsekunden */
  private fxTime = 0;
  private readonly ready = new Map<string, number>();
  private readonly timeline: Timed[] = [];
  private readonly tmpU: Unit[] = [];
  /** Spielsekunden je Echtsekunde (geglättet), Start ×10 */
  private rate = 10;
  private lastReal = 0;
  /** Zähler für Tests/Debug */
  readonly stats = { used: 0, shells: 0, bombs: 0, refilled: 0, repaired: 0 };

  constructor(ctx: GameContext, opts: AbilityOptions = {}) {
    this.ctx = ctx;
    this.combat = opts.combat ?? ctx.combat;
    this.fog = opts.fog ?? null;
    this.protection = opts.protection ?? null;
    this.exag = opts.exag ?? 6;
  }

  setFog(f: AbilityFogPort | null): void {
    this.fog = f;
  }
  setProtection(p: ProtectionQuery | null): void {
    this.protection = p;
  }
  applySettings(s: Settings): void {
    this.exag = s.heightExaggeration;
  }

  def(id: string): AbilityDef | undefined {
    return this.defs.find((d) => d.id === id);
  }

  // ------------------------------------------------------------------ Abklingzeit

  /** Verbleibende Abklingzeit in Spielstunden (0 = bereit) */
  cooldownLeft(a3: string, id: string): number {
    const t = this.ready.get(`${a3}|${id}`);
    return t === undefined ? 0 : Math.max(0, t - this.time);
  }

  /** Verbleibender Anteil 0..1 (für Anzeige) */
  cooldownFrac(a3: string, id: string): number {
    const d = this.def(id);
    return d ? Math.min(1, this.cooldownLeft(a3, id) / d.cooldownH) : 0;
  }

  // ------------------------------------------------------------------ Prüfung & Einsatz

  /** Zielprüfung ohne Kosten/Wirkung (für die Vorschau der Oberfläche). Prüft Fässer und Abklingzeit NICHT. */
  checkTarget(a3: string, id: string, x: number, z: number): AbilityCheck {
    const d = this.def(id);
    if (!d) return { ok: false, reason: 'Unbekannte Fähigkeit' };
    const geo = this.ctx.geo;
    if (!Number.isFinite(x) || !Number.isFinite(z) || x < 0 || z < 0 || x >= geo.widthKm || z >= geo.heightKm) return { ok: false, reason: 'Ziel liegt außerhalb der Karte' };
    if (d.damaging && this.protection) {
      const reach = id === 'airstrike' ? AB.AIRSTRIKE_LENGTH_KM * 0.5 + 0.05 : d.radiusKm;
      const c = this.protection.classify(x, z, a3, reach);
      if (c.cls === 'own_civil') return { ok: false, reason: c.reason || 'Gesperrt: eigene Zivilisten' };
      if (c.cls === 'enemy_civil' || c.cls === 'protected') return { ok: true, warn: c.reason };
    }
    if (id === 'supply_drop' && !this.unitsNear(a3, x, z, d.radiusKm, (u) => this.needsSupply(u)).length) {
      return { ok: false, reason: 'Keine eigenen Einheiten mit Nachschubbedarf im Zielgebiet' };
    }
    if (id === 'emergency_repair' && !this.hasRepairTargets(a3, x, z, d.radiusKm)) {
      return { ok: false, reason: 'Nichts zu reparieren im Zielgebiet' };
    }
    return { ok: true };
  }

  use(a3: string, id: string, x: number, z: number): { ok: boolean; reason?: string; warn?: string } {
    const d = this.def(id);
    if (!d) return { ok: false, reason: 'Unbekannte Fähigkeit' };
    if (!a3) return { ok: false, reason: 'Keine Nation' };
    const left = this.cooldownLeft(a3, id);
    if (left > 1e-9) return { ok: false, reason: `${d.name}: noch ${fmtH(left)} Abklingzeit` };
    const chk = this.checkTarget(a3, id, x, z);
    if (!chk.ok) return chk;
    const eco = this.ctx.economy;
    if (eco.pool(a3).barrels + 1e-9 < d.cost) return { ok: false, reason: `Zu wenig Öl (${d.cost} Fässer nötig)` };
    if (!eco.spend(a3, d.cost, `ability:${id}`)) return { ok: false, reason: `Zu wenig Öl (${d.cost} Fässer nötig)` };
    this.ready.set(`${a3}|${id}`, this.time + d.cooldownH);
    this.stats.used++;

    switch (id as AbilityId) {
      case 'recon_flight': this.doRecon(a3, x, z); break;
      case 'smoke_screen': this.doSmoke(x, z); break;
      case 'artillery_barrage': this.doBarrage(a3, x, z); break;
      case 'airstrike': this.doAirstrike(a3, x, z); break;
      case 'supply_drop': this.doSupply(a3, x, z); break;
      case 'emergency_repair': this.doRepair(a3, x, z); break;
    }
    bus.emit('ability:used', { id, a3, x, z });
    this.announce(a3, d, x, z);
    return { ok: true, warn: chk.warn };
  }

  // ------------------------------------------------------------------ Takt

  update(dtGameHours: number): void {
    if (!(dtGameHours > 0)) return;
    this.time += dtGameHours;
    const dtSec = dtGameHours * 3600;
    // Zeitraffer-Rate messen (nur für Echtzeit-Umrechnung)
    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    if (this.lastReal > 0 && now > this.lastReal) {
      const r = dtSec / ((now - this.lastReal) / 1000);
      if (Number.isFinite(r) && r > 0) this.rate += (Math.min(r, 20000) - this.rate) * 0.1;
    }
    this.lastReal = now;
    if (!this.timeline.length) return;
    this.fxTime += Math.min(dtSec, AB.MAX_FX_DT);
    for (let i = 0; i < this.timeline.length; ) {
      const t = this.timeline[i];
      if (t.at <= this.fxTime) {
        this.timeline.splice(i, 1);
        t.fn();
      } else i++;
    }
  }

  /** Offene Effekte (Tests/Debug) */
  get pending(): number {
    return this.timeline.length;
  }

  private later(sec: number, fn: () => void): void {
    this.timeline.push({ at: this.fxTime + sec, fn });
  }

  /** Spielsekunden → Echtsekunden (begrenzt) */
  private realSec(gameSec: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, gameSec / Math.max(1, this.rate)));
  }

  private groundY(x: number, z: number): number {
    return Math.max(this.ctx.geo.heightAt(x, z), 0) * this.exag;
  }

  // ------------------------------------------------------------------ Effekte

  private doRecon(a3: string, x: number, z: number): void {
    const dur = this.realSec(AB.RECON_REVEAL_GAME_H * 3600, 20, 90);
    this.fog?.revealArea(x, z, 4, a3, dur);
  }

  private doSmoke(x: number, z: number): void {
    const dur = this.realSec(AB.SMOKE_GAME_SEC, 30, 120);
    // Wand aus drei überlappenden Wolken (Ost-West)
    bus.emit('smoke:spawn', { x, z, radiusKm: 0.25, durationSec: dur, density: 0.95 });
    for (const s of [-1, 1]) bus.emit('smoke:spawn', { x: x + s * 0.22, z, radiusKm: 0.2, durationSec: dur, density: 0.9 });
  }

  private doBarrage(a3: string, x: number, z: number): void {
    const d = this.def('artillery_barrage')!;
    this.orderTarget(a3, x, z, d.radiusKm, 'howitzer');
    const org = this.origin(a3, x, z);
    const proxy = this.proxyUnit(a3);
    const oy = this.groundY(org[0], org[1]) + 0.01;
    for (let i = 0; i < AB.BARRAGE_SHELLS; i++) {
      const at = AB.BARRAGE_DELAY_SEC + (i * AB.BARRAGE_SPAN_SEC) / AB.BARRAGE_SHELLS;
      this.later(at, () => {
        const ang = Math.random() * Math.PI * 2, r = d.radiusKm * Math.sqrt(Math.random());
        const tx = x + Math.cos(ang) * r, tz = z + Math.sin(ang) * r;
        const ty = this.groundY(tx, tz);
        bus.emit('combat:fire', { unitId: proxy, weapon: 'howitzer' as WeaponKind, fx: org[0], fy: oy, fz: org[1], tx, ty, tz, flightSec: AB.BARRAGE_FLIGHT_SEC, indirect: true });
        this.combat.strikeAt(a3, 'howitzer', tx, tz, AB.BARRAGE_FLIGHT_SEC, AB.BARRAGE_DMG_MUL);
        this.stats.shells++;
      });
    }
  }

  private doAirstrike(a3: string, x: number, z: number): void {
    const half = AB.AIRSTRIKE_LENGTH_KM * 0.5;
    this.orderTarget(a3, x, z, half + 0.05, 'bomb');
    const org = this.origin(a3, x, z);
    let dx = x - org[0], dz = z - org[1];
    const L = Math.hypot(dx, dz);
    if (L < 1e-6) { dx = 0; dz = 1; } else { dx /= L; dz /= L; }
    const proxy = this.proxyUnit(a3);
    const spacing = AB.AIRSTRIKE_LENGTH_KM / (AB.AIRSTRIKE_BOMBS - 1);
    const alt = this.groundY(x, z) + 1.4;
    for (let i = 0; i < AB.AIRSTRIKE_BOMBS; i++) {
      const off = -half + i * spacing;
      this.later(AB.AIRSTRIKE_DELAY_SEC + i * 0.5, () => {
        const sx = Math.random() * 0.016 - 0.008, sz = Math.random() * 0.016 - 0.008;
        const tx = x + dx * off + sx, tz = z + dz * off + sz;
        const ty = this.groundY(tx, tz);
        // Jet fliegt die Reihe ab: Abwurfpunkt über dem Ziel, Flugrichtung von der Basis her
        bus.emit('combat:fire', { unitId: proxy, weapon: 'bomb' as WeaponKind, fx: tx - dx * 0.25, fy: alt, fz: tz - dz * 0.25, tx, ty, tz, flightSec: AB.AIRSTRIKE_FALL_SEC, indirect: true });
        this.combat.strikeAt(a3, 'bomb', tx, tz, AB.AIRSTRIKE_FALL_SEC, AB.AIRSTRIKE_DMG_MUL);
        this.stats.bombs++;
      });
    }
  }

  private needsSupply(u: Unit): boolean {
    const t = u.type;
    if (t.id === 'supply_truck') return u.ammo < SUPPLY_CAPACITY * 0.95;
    if (Number.isFinite(t.fuelKm) && t.fuelKm > 0 && u.fuel < t.fuelKm * 0.95) return true;
    if (t.damage > 0 && t.ammo > 0 && u.ammo < t.ammo * 0.95) return true;
    return false;
  }

  private doSupply(a3: string, x: number, z: number): void {
    const d = this.def('supply_drop')!;
    const us = this.unitsNear(a3, x, z, d.radiusKm, () => true);
    let n = 0;
    for (const u of us) {
      const t = u.type;
      let changed = false;
      if (Number.isFinite(t.fuelKm) && t.fuelKm > 0 && u.fuel < t.fuelKm) { u.fuel = t.fuelKm; changed = true; }
      if (t.id === 'supply_truck') { if (u.ammo < SUPPLY_CAPACITY) { u.ammo = SUPPLY_CAPACITY; changed = true; } }
      else if (t.ammo > 0 && u.ammo < t.ammo) { u.ammo = t.ammo; changed = true; }
      if (changed) n++;
    }
    this.stats.refilled += n;
    // Kiste/Rauchsignal am Abwurfpunkt
    bus.emit('smoke:spawn', { x, z, radiusKm: 0.05, durationSec: 12, density: 0.45 });
  }

  private hasRepairTargets(a3: string, x: number, z: number, r: number): boolean {
    if (this.unitsNear(a3, x, z, r, (u) => !REPAIRABLE_SKIP.has(u.type.category) && u.hp < u.type.hp - 1e-6).length) return true;
    const eco = this.ctx.economy;
    for (const b of eco.bases.values()) if (b.owner === a3 && b.progress >= 1 && b.hp < b.hpMax && Math.hypot(b.x - x, b.z - z) <= r) return true;
    for (const f of eco.fields) if (f.owner === a3 && f.integrity < 1 && Math.hypot(f.x - x, f.z - z) <= r) return true;
    return false;
  }

  private doRepair(a3: string, x: number, z: number): void {
    const d = this.def('emergency_repair')!;
    let n = 0;
    for (const u of this.unitsNear(a3, x, z, d.radiusKm, (v) => !REPAIRABLE_SKIP.has(v.type.category) && v.hp < v.type.hp - 1e-6)) {
      const max = u.type.hp;
      u.hp = Math.min(max, u.hp + max * AB.REPAIR_FRAC);
      const m = u.type.memberCount;
      u.membersAlive = Math.max(1, Math.ceil((u.hp / max) * m - 1e-6));
      n++;
    }
    const eco = this.ctx.economy;
    for (const b of eco.bases.values()) {
      if (b.owner === a3 && b.progress >= 1 && b.hp < b.hpMax && Math.hypot(b.x - x, b.z - z) <= d.radiusKm) { b.hp = Math.min(b.hpMax, b.hp + b.hpMax * AB.REPAIR_FRAC); n++; }
    }
    for (const f of eco.fields) {
      if (f.owner === a3 && f.integrity < 1 && Math.hypot(f.x - x, f.z - z) <= d.radiusKm) { f.integrity = Math.min(1, f.integrity + AB.REPAIR_FRAC); n++; }
    }
    this.stats.repaired += n;
  }

  // ------------------------------------------------------------------ Hilfen

  private unitsNear(a3: string, x: number, z: number, r: number, pred: (u: Unit) => boolean): Unit[] {
    const arr = this.ctx.units.queryRadius(x, z, r, this.tmpU);
    const out: Unit[] = [];
    for (const u of arr) if (u.owner === a3 && u.hp > 0 && pred(u)) out.push(u);
    return out;
  }

  /** Absicht melden: Schutz-/Ansehenssystem bewertet den gezielten Angriff wie einen Feuerbefehl */
  private orderTarget(a3: string, x: number, z: number, radiusKm: number, weapon: WeaponKind): void {
    bus.emit('combat:order-target', { attacker: a3, x, z, radiusKm, weapon });
  }

  /** Abschussort: nächste eigene Basis, sonst 12 km nördlich des Ziels (Karte begrenzt) */
  private origin(a3: string, x: number, z: number): [number, number] {
    const b = this.ctx.economy.nearestBase(a3, 'any', x, z);
    if (b && Math.hypot(b.x - x, b.z - z) > 0.5) return [b.x, b.z];
    return [x, Math.max(0, z - 12)];
  }

  /** Eine eigene Einheit als nomineller Schütze (Zivilsystem ordnet Opfer über den Besitzer der feuernden Einheit zu) */
  private proxyUnit(a3: string): number {
    for (const u of this.ctx.units.units) if (u.owner === a3 && u.hp > 0) return u.id;
    return 0;
  }

  /** Warnmeldungen: Gegner im Wirkungsgebiet erhalten 'Luftschlag im Anmarsch' o. Ä.; der Anwender eine Bestätigung */
  private announce(a3: string, d: AbilityDef, x: number, z: number): void {
    bus.emit('alert', { a3, kind: 'info', text: `${d.name} angefordert`, x, z });
    const warnText: Partial<Record<AbilityId, string>> = {
      artillery_barrage: 'Artilleriefeuer im Anmarsch',
      airstrike: 'Luftschlag im Anmarsch – Deckung suchen',
      recon_flight: 'Feindliche Aufklärungsdrohne im Gebiet',
    };
    const text = warnText[d.id];
    if (!text) return;
    const victims = new Set<string>();
    const war = this.ctx.war;
    const reach = Math.max(d.radiusKm, 0.5) + (d.id === 'recon_flight' ? 0 : 0.5);
    for (const u of this.ctx.units.queryRadius(x, z, reach, this.tmpU)) if (u.hp > 0 && u.owner !== a3 && war.isHostile(a3, u.owner)) victims.add(u.owner);
    for (const b of this.ctx.economy.bases.values()) if (b.owner !== a3 && war.isHostile(a3, b.owner) && Math.hypot(b.x - x, b.z - z) <= reach + 0.5) victims.add(b.owner);
    const cid = this.ctx.geo.countryAt(x, z);
    const c = cid ? this.ctx.geo.countriesById.get(cid)?.a3 : undefined;
    if (c && c !== a3 && war.isHostile(a3, c)) victims.add(c);
    for (const v of victims) bus.emit('alert', { a3: v, kind: d.id === 'recon_flight' ? 'warn' : 'danger', text, x, z });
  }
}

function fmtH(h: number): string {
  const m = Math.ceil(h * 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}
