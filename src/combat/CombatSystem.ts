/**
 * Phase 3 – Kampfsimulation.
 *
 * Ablauf je Substep (≤ 0.5 Spielsekunden): Geschosse im Flug auflösen -> je Einheit: Abklingzeiten, Befehle
 * (attack / fireAt / Luftangriff), gestaffelte Zielsuche (Sicht + LOS + Aufklärungsmeldungen), Waffenwahl, Schüsse,
 * Moral/Rückzug -> gefallene Einheiten entfernen.
 *
 * Konventionen:
 *  - Alle Waffenwerte gelten für den ganzen Verband (siehe weapons.ts). Verbandsstärke: unit.membersAlive (aus hp).
 *  - Indirektes Feuer braucht in Phase 3 KEINEN Beobachter für Feuerbefehle (fireAt); automatisches indirektes
 *    Feuer greift nur Ziele an, die irgendeine eigene Einheit (Aufklärung/Sicht) in den letzten Sekunden gesichtet hat.
 *  - CombatSystem baut die Unterdrückung (unit.suppression) auch wieder ab und pflegt unit.morale, engaged, targetId,
 *    fireX/fireZ, cooldown, kills, wounded, membersAlive.
 *  - Befehle: orders[0].kind 'attack' (targetId) und 'fireAt' (x,z) – UnitManager hält 'fireAt' bzw. engagierte
 *    'attack'/'attackMove'-Einheiten an (siehe UnitManager.step).
 */
import { bus } from '../core/EventBus';
import type { Settings } from '../core/types';
import type { Order, Unit } from '../units/types';
import type { UnitManager } from '../units/UnitManager';
import type { GeoData } from '../world/GeoData';
import { BALANCE as B } from './Balance';
import { LineOfSight } from './LineOfSight';
import type { BuildingProvider, StructureProvider } from './providers';
import type { BuildingInfo, CoverQuery, ExplosionSize, ImpactSurface, SmokeQuery, StructureInfo, TargetProtection, WarQuery } from './types';
import { WEAPONS_BY_UNIT, type WeaponDef } from './weapons';

export type { BuildingProvider, StructureProvider } from './providers';

export interface CombatDeps {
  geo: GeoData;
  units: UnitManager;
  war: WarQuery;
  settings: Settings;
  smoke?: SmokeQuery;
  cover?: CoverQuery;
  protection?: TargetProtection;
  buildings?: BuildingProvider;
  structures?: StructureProvider;
}

export interface CombatStats {
  shots: number;
  hits: number;
  kills: number;
  scans: number;
  shellsInFlight: number;
  /** Frames, in denen die Kampfzeit gekürzt wurde (hoher Zeitraffer) */
  clampedFrames: number;
  damageDealt: number;
  /** Phase 4: Flächenschäden in eigenen/verbündeten Zivilgebieten (abgeschwächt) und abgewiesene Zielwahlen */
  civilSplashOwn: number;
  civilBlocked: number;
}

// ------------------------------------------------------------------ interne Typen

const MAXC = 12;
const MASK_GROUND = 1, MASK_AIR = 2, MASK_NAVAL = 4;
const TARGET_MASK: Record<string, number> = { ground: MASK_GROUND, air: MASK_AIR, naval: MASK_NAVAL };

interface CU {
  weapons: WeaponDef[];
  masks: number[];
  cd: Float32Array;
  wTgt: Int32Array;
  lastT: Int32Array;
  cands: Int32Array;
  cvis: Uint8Array;
  nC: number;
  scanT: number;
  driveT: number;
  seen: Float64Array;
  revealedUntil: number;
  lastFire: number;
  attackId: number;
  resume: Order | null;
  mission: boolean;
  mX: number;
  mZ: number;
  airPhase: number;
  minD: number;
  egX: number;
  egZ: number;
  egT: number;
  homeX: number;
  homeZ: number;
  hintId: number;
  hintT: number;
  hitX: number;
  hitZ: number;
  hitT: number;
  retreatUntil: number;
  hasTarget: boolean;
  dead: boolean;
  moraleT: number;
  /** Phase 4: Zeitpunkt der letzten 'combat:order-target'-Meldung dieser Einheit (Absicht auffrischen) */
  intentT: number;
}

interface Shell {
  active: boolean;
  t: number;
  w: WeaponDef;
  attackerId: number;
  owner: string;
  targetId: number;
  hit: boolean;
  x: number;
  y: number;
  z: number;
  prot: number;
  /** Anzahl Sprengpunkte-Index für Bomben-Stick (nur Info) */
  seq: number;
}

const SIZE_MUL: Record<string, number> = { infantry: 0.65, recon: 0.9, ifv: 1, tank: 1, artillery: 0.95, aa: 1, support: 1.05, helicopter: 0.85, jet: 0.7, drone: 0.45, naval: 1.3 };
const FLY_ALT: Record<string, number> = { heli_attack: 0.1, heli_transport: 0.15, jet: 1.2, bomber: 1.6, drone_fixed: 0.8, drone_quad: 0.04 };

/** Pseudo-Waffe für Munitionsexplosionen */
const COOKOFF: WeaponDef = {
  id: 'cookoff', name: 'Munitionsexplosion', kind: 'howitzer', damage: 45, armorPen: 30, rangeKm: 0, minRangeKm: 0, rofPerMin: 0, accuracy: 1,
  splashKm: 0.03, suppression: 0.3, projectileSpeedKmh: 0, indirect: false, targets: ['ground'], ammoPerShot: 0, needsLOS: false, moveFire: 0,
};

function wrapAngle(a: number): number {
  const T = Math.PI * 2;
  a = (a + Math.PI) % T;
  if (a < 0) a += T;
  return a - Math.PI;
}
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

function isInfantry(u: Unit): boolean {
  return u.type.category === 'infantry' || u.type.model === 'soldier';
}

export class CombatSystem {
  readonly stats: CombatStats = { shots: 0, hits: 0, kills: 0, scans: 0, shellsInFlight: 0, clampedFrames: 0, damageDealt: 0, civilSplashOwn: 0, civilBlocked: 0 };

  private readonly geo: GeoData;
  private readonly units: UnitManager;
  private readonly war: WarQuery;
  private exag: number;
  private smoke?: SmokeQuery;
  /** Phase 6: Nebel des Krieges (nur für die Seite des Spielers; KI-Nationen unberührt) */
  private fog: { isUnitVisible(u: Unit): boolean; isFriendly(a3: string): boolean } | null = null;
  private cover?: CoverQuery;
  private protection?: TargetProtection;
  private buildings?: BuildingProvider;
  private structures?: StructureProvider;
  private readonly los: LineOfSight;

  private time = 0;
  private rot = 0;
  private seed = 0x9e3779b9;
  private readonly states = new Map<number, CU>();
  private readonly shells: Shell[] = [];
  private readonly freeShells: number[] = [];
  private readonly dead: Unit[] = [];
  private scansThisStep = 0;
  private splashDepth = 0;

  // Besitzer-Indizes / Feindschaftsmatrix
  private readonly ownerIdx = new Map<string, number>();
  private readonly ownerNames: string[] = [];
  private readonly hostileM = new Int8Array(64 * 64).fill(-1);
  private readonly hasEnemyM = new Int8Array(64).fill(-1);
  private hostileT = 0;
  private readonly capitals = new Map<string, [number, number] | null>();

  // Scratch
  private readonly tmpU: Unit[] = [];
  private readonly tmpSplash: Unit[][] = [[], [], [], []];
  private readonly tmpB: BuildingInfo[] = [];
  private readonly tmpS: StructureInfo[] = [];
  private readonly preId = new Int32Array(24);
  private readonly preD = new Float64Array(24);
  private preN = 0;

  constructor(deps: CombatDeps) {
    this.geo = deps.geo;
    this.units = deps.units;
    this.war = deps.war;
    this.exag = deps.settings.heightExaggeration;
    this.smoke = deps.smoke;
    this.cover = deps.cover;
    this.protection = deps.protection;
    this.buildings = deps.buildings;
    this.structures = deps.structures;
    this.los = new LineOfSight(deps.geo, deps.settings, deps.smoke, deps.buildings);
    bus.on('unit:removed', ({ id }) => this.states.delete(id));
    bus.on('war:declared', () => this.invalidateHostility());
  }

  // ------------------------------------------------------------------ öffentliche API

  applySettings(s: Settings): void {
    this.exag = s.heightExaggeration;
    this.los.applySettings(s);
  }

  setProviders(p: Partial<{ smoke: SmokeQuery; cover: CoverQuery; protection: TargetProtection; buildings: BuildingProvider; structures: StructureProvider }>): void {
    if (p.smoke) this.smoke = p.smoke;
    if (p.cover) this.cover = p.cover;
    if (p.protection) this.protection = p.protection;
    if (p.buildings) this.buildings = p.buildings;
    if (p.structures) this.structures = p.structures;
    this.los.setProviders({ smoke: this.smoke, buildings: this.buildings });
  }

  /** Zu invalidieren, wenn sich Kriegszustände ändern (auch automatisch alle ~1 s und bei 'war:declared'). */
  invalidateHostility(): void {
    this.hostileM.fill(-1);
    this.hasEnemyM.fill(-1);
  }

  // ------------------------------------------------------------------ Phase 7: Fähigkeiten (Call-ins)

  /**
   * Flächeneinschlag ohne Schützen (Artillerie-/Luftschlag-Fähigkeiten): löst nach flightSec (Spielsekunden) den normalen
   * Einschlagspfad aus (combat:impact/-explosion, Splitterschaden an Einheiten/Gebäuden/Bauwerken, Zivilschutz-Abschwächung).
   * Der Schaden zählt für `owner`; damageMul skaliert die Waffe (1 = Standardwaffe des Trägers).
   */
  strikeAt(owner: string, kind: 'howitzer' | 'bomb', x: number, z: number, flightSec = 0, damageMul = 1): void {
    let base: WeaponDef | undefined;
    for (const ws of Object.values(WEAPONS_BY_UNIT)) {
      base = ws.find((wd) => wd.kind === kind);
      if (base) break;
    }
    if (!base) return;
    const w: WeaponDef = damageMul === 1 ? base : { ...base, damage: base.damage * damageMul };
    this.schedule(w, { id: 0, owner } as Unit, 0, false, x, this.groundY(x, z), z, 0, flightSec, 0);
  }

  // ------------------------------------------------------------------ Phase 4: Zivilschutz

  /**
   * Waffen/Träger, die in eigenen/verbündeten Zivilgebieten NICHT einsetzbar sind (Artillerie, Luftschläge, Bomben, FPV,
   * Raketen, Schiffsartillerie). Direktfeuer (Gewehr, Panzerkanone, ...) bleibt für die Verteidigung eigener Städte erlaubt;
   * sein Streuschaden wird in splash() abgeschwächt.
   */
  private civilBlockedWeapon(u: Unit, w: WeaponDef): boolean {
    if (w.indirect || u.type.category === 'jet') return true;
    switch (w.kind) {
      case 'bomb': case 'fpv': case 'mortar': case 'howitzer': case 'rocket_arty': case 'heli_rocket':
      case 'naval_gun': case 'antiship_missile': case 'air_missile':
        return true;
      default:
        return false;
    }
  }

  /** Ist (x,z) für diese Waffe wegen Zivilschutz gesperrt? */
  private blockedFor(u: Unit, w: WeaponDef, x: number, z: number): boolean {
    if (!this.protection || !this.civilBlockedWeapon(u, w)) return false;
    return this.protection.isProtected(x, z, u.owner);
  }

  /** Mindestens eine Waffe der Einheit ist dort einsetzbar? (false = alles gesperrt) */
  private anyWeaponAllowed(u: Unit, st: CU, x: number, z: number): boolean {
    for (let i = 0; i < st.weapons.length; i++) if (!this.blockedFor(u, st.weapons[i], x, z)) return true;
    return false;
  }

  /** Meldet einen Zielpunkt/ein Ziel an das Schutz-/Ansehenssystem (gezielter Angriff). radiusKm 0 = Einheitenziel. */
  private emitOrderTarget(u: Unit, st: CU, x: number, z: number, radiusKm: number): void {
    let best: WeaponDef | null = null;
    for (let i = 0; i < st.weapons.length; i++) {
      const w = st.weapons[i];
      if (!best || w.splashKm > best.splashKm) best = w;
    }
    if (!best) return;
    st.intentT = this.time;
    bus.emit('combat:order-target', { attacker: u.owner, x, z, radiusKm, weapon: best.kind });
  }

  /** Begründung für eine Sperre (ProtectionSystem.classify, falls vorhanden) */
  private blockMsg(x: number, z: number, owner: string): string {
    const p = this.protection as (TargetProtection & { classify?: (x: number, z: number, a: string, r?: number) => { reason: string } }) | undefined;
    const r = p?.classify ? p.classify(x, z, owner, 0.05).reason : '';
    return r || 'Ziel liegt in einem geschützten Gebiet.';
  }

  /** Nebel des Krieges: Angriffsbefehle der Spieler-Seite auf nicht aufgeklärte Gegner werden abgelehnt (null = aus) */
  setFog(f: { isUnitVisible(u: Unit): boolean; isFriendly(a3: string): boolean } | null): void {
    this.fog = f;
  }

  orderAttack(unitIds: number[], targetId: number): void {
    const t = this.units.get(targetId);
    if (!t || t.hp <= 0) return;
    let warned = false;
    if (this.fog && !this.fog.isUnitVisible(t) && unitIds.some((id) => { const a = this.units.get(id); return !!a && this.fog!.isFriendly(a.owner); })) {
      bus.emit('toast', { msg: 'Ziel nicht aufgeklärt', kind: 'warn' });
      unitIds = unitIds.filter((id) => { const a = this.units.get(id); return !a || !this.fog!.isFriendly(a.owner); });
    }
    for (const id of unitIds) {
      const u = this.units.get(id);
      if (!u || u.hp <= 0 || u === t) continue;
      const st = this.stateOf(u);
      if (!st.weapons.length || !this.hostile(u.owner, t.owner)) continue;
      // Phase 4: eigene/verbündete Zivilgebiete – Artillerie, Luftschläge, Bomben, FPV gesperrt
      if (this.protection && !this.isAirborneTarget(t) && !this.anyWeaponAllowed(u, st, t.x, t.z)) {
        this.stats.civilBlocked++;
        if (!warned) {
          warned = true;
          bus.emit('toast', { msg: this.blockMsg(t.x, t.z, u.owner), kind: 'warn' });
        }
        continue;
      }
      this.emitOrderTarget(u, st, t.x, t.z, 0);
      st.attackId = targetId;
      st.mission = false;
      st.resume = null;
      st.airPhase = 0;
      st.minD = 1e9;
      st.driveT = 0;
      this.noteHome(u, st);
      u.stance = 'free';
      u.orders.length = 0;
      u.orders.push({ kind: 'attack', x: t.x, z: t.z, targetId });
      u.route = null;
      u.routeKm = 0;
      u.targetId = targetId;
    }
  }

  orderFireAt(unitIds: number[], x: number, z: number): void {
    let warned = false;
    for (const id of unitIds) {
      const u = this.units.get(id);
      if (!u || u.hp <= 0) continue;
      const st = this.stateOf(u);
      if (!st.weapons.length) continue;
      if (this.protection?.isProtected(x, z, u.owner)) {
        // Phase 4: Flächenfeuer-/Angriffsbefehle auf eigene/verbündete Zivilgebiete werden abgelehnt
        this.stats.civilBlocked++;
        if (!warned) {
          warned = true;
          bus.emit('toast', { msg: this.blockMsg(x, z, u.owner), kind: 'warn' });
        }
        continue;
      }
      this.emitOrderTarget(u, st, x, z, 0.03);
      st.attackId = 0;
      st.resume = null;
      st.mission = true;
      st.mX = x;
      st.mZ = z;
      st.airPhase = 0;
      st.minD = 1e9;
      st.driveT = 0;
      this.noteHome(u, st);
      u.stance = 'free';
      u.orders.length = 0;
      u.orders.push({ kind: 'fireAt', x, z });
      u.route = null;
      u.routeKm = 0;
      u.fireX = x;
      u.fireZ = z;
    }
  }

  stopFiring(unitIds: number[]): void {
    for (const id of unitIds) {
      const u = this.units.get(id);
      if (!u) continue;
      const st = this.states.get(id);
      if (st) {
        st.attackId = 0;
        st.mission = false;
        st.resume = null;
        st.airPhase = 0;
        st.wTgt.fill(0);
      }
      const k = u.orders.length ? u.orders[0].kind : '';
      if (k === 'attack' || k === 'fireAt') {
        u.orders.shift();
        u.route = null;
        u.routeKm = 0;
      }
      u.fireX = undefined;
      u.fireZ = undefined;
      u.targetId = 0;
      u.engaged = false;
    }
  }

  /** Jede Frame aufrufen; dtGameSec = state.lastHours * 3600 */
  /** Mehrspieler (Gast): Spiegel – keine Kampfsimulation, Wirkung/Effekte kommen als Host-Ereignisse */
  mirror = false;

  update(dtGameSec: number): void {
    if (this.mirror || !(dtGameSec > 0)) return;
    let dt = dtGameSec;
    if (dt > B.MAX_FRAME_SEC) {
      dt = B.MAX_FRAME_SEC;
      this.stats.clampedFrames++;
    }
    const n = Math.max(1, Math.ceil(dt / B.MAX_SUBSTEP));
    const h = dt / n;
    for (let i = 0; i < n; i++) this.step(h);
  }

  // ------------------------------------------------------------------ Zustand / Hilfen

  private rand(): number {
    let s = this.seed;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.seed = s >>> 0;
    return this.seed / 4294967296;
  }

  private stateOf(u: Unit): CU {
    let st = this.states.get(u.id);
    if (st) return st;
    const weapons = WEAPONS_BY_UNIT[u.type.id] ?? [];
    const n = weapons.length;
    const masks = weapons.map((w) => {
      let m = 0;
      for (const t of w.targets) m |= TARGET_MASK[t] ?? 0;
      return m;
    });
    st = {
      weapons, masks,
      cd: new Float32Array(n), wTgt: new Int32Array(n), lastT: new Int32Array(n),
      cands: new Int32Array(MAXC), cvis: new Uint8Array(MAXC), nC: 0,
      scanT: this.rand() * B.SCAN_INTERVAL, driveT: this.rand() * 0.4,
      seen: new Float64Array(64), revealedUntil: 0, lastFire: -99,
      attackId: 0, resume: null, mission: false, mX: 0, mZ: 0,
      airPhase: 0, minD: 1e9, egX: 0, egZ: 0, egT: 0, homeX: NaN, homeZ: NaN,
      hintId: 0, hintT: 0, hitX: 0, hitZ: 0, hitT: -99, retreatUntil: 0,
      hasTarget: false, dead: false, moraleT: this.rand(), intentT: -99,
    };
    for (let i = 0; i < n; i++) st.cd[i] = this.rand() * 1.5;
    if (u.membersAlive === undefined) u.membersAlive = u.type.memberCount;
    this.states.set(u.id, st);
    return st;
  }

  private noteHome(u: Unit, st: CU): void {
    if (Number.isNaN(st.homeX) && u.type.category === 'jet') {
      st.homeX = u.x;
      st.homeZ = u.z;
    }
  }

  private ownerIndex(o: string): number {
    let i = this.ownerIdx.get(o);
    if (i === undefined) {
      i = Math.min(63, this.ownerNames.length);
      this.ownerIdx.set(o, i);
      if (this.ownerNames.length < 64) this.ownerNames.push(o);
    }
    return i;
  }

  private hostile(a: string, b: string): boolean {
    if (a === b) return false;
    const ia = this.ownerIndex(a), ib = this.ownerIndex(b);
    if (ia === 63 || ib === 63) return this.war.isHostile(a, b);
    const k = ia * 64 + ib;
    let v = this.hostileM[k];
    if (v < 0) {
      v = this.war.isHostile(a, b) ? 1 : 0;
      this.hostileM[k] = v;
      this.hostileM[ib * 64 + ia] = v;
    }
    return v === 1;
  }

  private hasEnemies(o: string): boolean {
    const i = this.ownerIndex(o);
    let v = this.hasEnemyM[i];
    if (v < 0) {
      v = 0;
      for (const other of this.ownerNames) if (this.hostile(o, other)) { v = 1; break; }
      this.hasEnemyM[i] = v;
    }
    return v === 1;
  }

  private classMask(u: Unit): number {
    const d = u.type.mobility.domain;
    if (d === 'air') return u.type.category === 'helicopter' && !u.airborne ? MASK_GROUND : MASK_AIR;
    return d === 'naval' ? MASK_NAVAL : MASK_GROUND;
  }

  private isAirborneTarget(u: Unit): boolean {
    return (this.classMask(u) & MASK_AIR) !== 0;
  }

  private heightOf(u: Unit): number {
    const d = u.type.mobility.domain;
    if (d === 'air' && u.airborne) return FLY_ALT[u.type.model] ?? 0.3;
    if (isInfantry(u)) return u.posture === 'prone' ? 0.0008 : 0.0018;
    if (d === 'naval') return 0.015;
    return 0.0028;
  }

  private groundY(x: number, z: number): number {
    return Math.max(this.geo.heightAt(x, z), 0) * this.exag;
  }

  private memberFrac(u: Unit): number {
    return (u.membersAlive ?? u.type.memberCount) / u.type.memberCount;
  }

  // ------------------------------------------------------------------ Substep

  private step(dt: number): void {
    this.time += dt;
    this.los.beginFrame(this.time);
    if (this.time - this.hostileT > 1) {
      this.hostileT = this.time;
      this.invalidateHostility();
    }
    this.scansThisStep = 0;
    this.resolveShells(dt);

    const list = this.units.units;
    const n = list.length;
    if (n > 0) {
      this.rot = (this.rot + 7) % n;
      for (let k = 0; k < n; k++) {
        const u = list[(k + this.rot) % n];
        if (u.hp <= 0) continue;
        this.updateUnit(u, this.stateOf(u), dt);
      }
    }
    if (this.dead.length) {
      for (const u of this.dead) this.units.remove(u.id);
      this.dead.length = 0;
    }
  }

  private updateUnit(u: Unit, st: CU, dt: number): void {
    if (st.dead) return;
    // Unterdrückung / Moral
    if (u.suppression && u.suppression > 0) u.suppression = Math.max(0, u.suppression - B.SUPP_DECAY * dt);
    const supp = u.suppression ?? 0;
    if (u.morale < 0.95 && supp < 0.25) u.morale = Math.min(1, u.morale + B.MORALE_REGEN * dt);
    for (let i = 0; i < st.cd.length; i++) st.cd[i] -= dt;

    const nW = st.weapons.length;
    const air = u.type.mobility.domain === 'air';
    const canAct = !air || u.airborne !== false;
    const isRecon = u.type.sightKm > 0 && (nW > 0 || u.type.category === 'drone' || u.type.category === 'recon');
    if (!isRecon || !canAct) {
      u.engaged = false;
      return;
    }

    // Befehle auswerten
    const o0 = u.orders.length ? u.orders[0] : null;
    if (o0 && o0.kind === 'fireAt') {
      st.mission = true;
      st.mX = o0.x;
      st.mZ = o0.z;
      u.fireX = o0.x;
      u.fireZ = o0.z;
    } else if (st.mission) {
      st.mission = false;
      u.fireX = undefined;
      u.fireZ = undefined;
    }
    if (o0 && o0.kind === 'attack' && st.attackId === 0 && o0.targetId) st.attackId = o0.targetId;

    if (nW > 0) this.drive(u, st, dt);

    // Zielsuche
    st.scanT -= dt;
    if (st.scanT <= 0 && this.scansThisStep < B.MAX_SCANS_PER_STEP && this.hasEnemies(u.owner)) {
      this.scansThisStep++;
      this.scan(u, st);
    } else if (st.scanT <= 0 && !this.hasEnemies(u.owner)) {
      st.scanT = 1.5;
      st.nC = 0;
      st.wTgt.fill(0);
    }

    if (nW > 0) this.fireControl(u, st, dt);

    const engaged = st.hasTarget || this.time - st.lastFire < 2;
    u.engaged = engaged;
    let cdmin = 99;
    for (let i = 0; i < st.cd.length; i++) if (st.cd[i] < cdmin) cdmin = st.cd[i];
    u.cooldown = cdmin === 99 ? 0 : Math.max(0, cdmin);

    // Moral/Rückzug
    st.moraleT -= dt;
    if (st.moraleT <= 0) {
      st.moraleT = 1;
      this.checkRetreat(u, st);
    }
  }

  // ------------------------------------------------------------------ Moral

  private checkRetreat(u: Unit, st: CU): void {
    if (this.time < st.retreatUntil) return;
    const d = u.type.mobility.domain;
    if (d !== 'ground') return;
    const supp = u.suppression ?? 0;
    const thr = u.stance === 'hold' ? 0.08 : 0.2;
    if (!(u.morale < thr && supp > 0.4 && this.time - st.hitT < 10)) return;
    st.retreatUntil = this.time + 45;
    let dx = u.x - st.hitX, dz = u.z - st.hitZ;
    let l = Math.hypot(dx, dz);
    if (l < 1e-6) { dx = 0; dz = 1; l = 1; }
    dx /= l;
    dz /= l;
    const cap = this.capitalOf(u.owner);
    if (cap) {
      const cx = cap[0] - u.x, cz = cap[1] - u.z;
      const cl = Math.hypot(cx, cz);
      if (cl > 5) {
        dx = dx * 0.7 + (cx / cl) * 0.3;
        dz = dz * 0.7 + (cz / cl) * 0.3;
        const nl = Math.hypot(dx, dz) || 1;
        dx /= nl;
        dz /= nl;
      }
    }
    const dist = isInfantry(u) ? 1.2 : 3;
    st.attackId = 0;
    st.resume = null;
    this.units.issueMove([u.id], u.x + dx * dist, u.z + dz * dist, { kind: 'retreat' });
    u.morale = Math.min(1, u.morale + 0.15);
  }

  private capitalOf(owner: string): [number, number] | null {
    let c = this.capitals.get(owner);
    if (c === undefined) {
      c = null;
      const cities = this.geo.meta?.cities;
      if (cities) for (const ct of cities) if (ct.capital && ct.country === owner) { c = [ct.pos[0], ct.pos[1]]; break; }
      this.capitals.set(owner, c);
    }
    return c;
  }

  // ------------------------------------------------------------------ Befehle / Angriffsfahrt

  private setDest(u: Unit, kind: 'attack' | 'fireAt' | 'move', x: number, z: number, targetId: number, eps: number): void {
    const o = u.orders.length ? u.orders[0] : null;
    if (o && o.kind === kind) {
      if (Math.abs(o.x - x) + Math.abs(o.z - z) > eps) {
        o.x = x;
        o.z = z;
        u.route = null;
        u.routeKm = 0;
      }
      return;
    }
    const no: Order = { kind, x, z, targetId: targetId || undefined };
    if (o && (o.kind === 'attack' || o.kind === 'fireAt')) u.orders[0] = no;
    else u.orders.unshift(no);
    u.route = null;
    u.routeKm = 0;
  }

  private endAttack(u: Unit, st: CU): void {
    st.attackId = 0;
    st.airPhase = 0;
    st.minD = 1e9;
    st.wTgt.fill(0);
    if (u.orders.length && u.orders[0].kind === 'attack') u.orders.shift();
    u.route = null;
    u.routeKm = 0;
    u.targetId = 0;
    if (st.resume) {
      u.orders.unshift(st.resume);
      st.resume = null;
    } else if (u.type.category === 'jet' && !Number.isNaN(st.homeX) && !u.orders.length) {
      u.orders.push({ kind: 'move', x: st.homeX, z: st.homeZ });
    }
  }

  private weaponReady(u: Unit, st: CU, i: number): boolean {
    return u.ammo >= st.weapons[i].ammoPerShot - 1e-6;
  }

  private drive(u: Unit, st: CU, dt: number): void {
    st.driveT -= dt;
    if (st.driveT > 0) return;
    st.driveT = 0.4;
    const o = u.orders.length ? u.orders[0] : null;
    const cat = u.type.category;

    // Feuermission: Flugzeuge fliegen Angriffslauf auf den Punkt
    if (st.mission && cat === 'jet') {
      if (!this.hasAmmoForRun(u, st)) {
        st.mission = false;
        u.orders.shift();
        u.fireX = u.fireZ = undefined;
        this.endAttack(u, st);
        return;
      }
      this.driveJetRun(u, st, st.mX, st.mZ, null, 'fireAt');
      return;
    }
    if (st.mission) return; // Boden: in fireControl

    if (st.attackId) {
      const t = this.units.get(st.attackId);
      if (!t || t.hp <= 0 || !this.hostile(u.owner, t.owner)) {
        this.endAttack(u, st);
        return;
      }
      if (o && o.kind !== 'attack') {
        // Spieler hat anderen Befehl gegeben
        st.attackId = 0;
        st.resume = null;
        return;
      }
      // Phase 4: Angriffsziel liegt (inzwischen) in gesperrtem eigenem/verbündetem Zivilgebiet
      if (this.protection && !this.isAirborneTarget(t) && !this.anyWeaponAllowed(u, st, t.x, t.z)) {
        this.stats.civilBlocked++;
        this.endAttack(u, st);
        return;
      }
      if (cat === 'jet') {
        if (this.isAirborneTarget(t)) this.driveJetAir(u, st, t);
        else if (!this.hasAmmoForRun(u, st)) this.endAttack(u, st);
        else this.driveJetRun(u, st, t.x, t.z, t, 'attack');
      } else this.drivePursuit(u, st, t);
      return;
    }

    // Autonomer Angriff (FPV-Schwarm, Jagdbomber, jeweils im Angriffsmarsch bzw. FPV ohne Befehl)
    if (st.nC === 0) return;
    const fpv = u.type.model === 'drone_quad' && u.type.category === 'drone';
    const bomber = cat === 'jet' && st.weapons.some((w) => w.kind === 'bomb');
    const eligible = (o && o.kind === 'attackMove' && (fpv || bomber)) || (fpv && !o && u.stance !== 'hold');
    if (!eligible) return;
    for (let i = 0; i < st.nC; i++) {
      const t = this.units.get(st.cands[i]);
      if (!t || t.hp <= 0 || this.isAirborneTarget(t)) continue;
      if (fpv && (t.type.category === 'infantry' && t.garrisonId)) continue;
      // Phase 4: autonome Angriffe (FPV, Jagdbomber) nie auf gesperrte Zivilgebiete
      if (this.protection && !this.anyWeaponAllowed(u, st, t.x, t.z)) continue;
      st.attackId = t.id;
      st.resume = o ? { ...o } : null;
      st.airPhase = 0;
      st.minD = 1e9;
      this.noteHome(u, st);
      if (o) u.orders.shift();
      u.orders.unshift({ kind: 'attack', x: t.x, z: t.z, targetId: t.id });
      u.route = null;
      u.routeKm = 0;
      return;
    }
  }

  private hasAmmoForRun(u: Unit, st: CU): boolean {
    for (let i = 0; i < st.weapons.length; i++) {
      const w = st.weapons[i];
      if (w.kind === 'bomb' ? u.ammo >= 1 : u.ammo >= 2 && (w.targets.includes('ground') || w.targets.includes('naval'))) return true;
    }
    return false;
  }

  private drivePursuit(u: Unit, st: CU, t: Unit): void {
    const cat = u.type.category;
    const tmask = this.classMask(t);
    let best = 0;
    for (let i = 0; i < st.weapons.length; i++) {
      if (!(st.masks[i] & tmask) || !this.weaponReady(u, st, i)) continue;
      if (st.weapons[i].kind === 'torpedo' && t.type.id !== 'submarine' && tmask !== MASK_NAVAL) continue;
      if (st.weapons[i].rangeKm > best) best = st.weapons[i].rangeKm;
    }
    if (best <= 0) {
      // nichts mehr, was wirken könnte
      this.endAttack(u, st);
      return;
    }
    const d = Math.hypot(t.x - u.x, t.z - u.z);
    const inRange = d <= best * 0.92;
    const los = inRange && (this.noLosNeeded(st, tmask) || this.seeUnit(u, t));
    if (los) return;
    if (u.stance === 'hold') return;
    if (cat === 'aa' || cat === 'support') return;
    if (tmask === MASK_AIR && cat !== 'helicopter') return;
    // Verfolgen. Artillerie rückt nur bis in Reichweite vor.
    let tx = t.x, tz = t.z;
    if (best > 1 && d > 1e-6) {
      const stand = best * 0.8;
      tx = t.x - ((t.x - u.x) / d) * stand;
      tz = t.z - ((t.z - u.z) / d) * stand;
      if (d < stand) { tx = u.x; tz = u.z; }
    }
    this.setDest(u, 'attack', tx, tz, t.id, 0.08);
  }

  private noLosNeeded(st: CU, tmask: number): boolean {
    for (let i = 0; i < st.weapons.length; i++) if ((st.masks[i] & tmask) && !st.weapons[i].needsLOS) return true;
    return false;
  }

  private driveJetAir(u: Unit, st: CU, t: Unit): void {
    let miss = false;
    for (let i = 0; i < st.weapons.length; i++) if (st.weapons[i].kind === 'air_missile' && u.ammo >= 1) miss = true;
    const standoff = miss ? 9 : 0.6;
    const dx = t.x - u.x, dz = t.z - u.z;
    const d = Math.hypot(dx, dz);
    if (d > standoff * 1.1 && d > 1e-6) this.setDest(u, 'attack', t.x - (dx / d) * standoff, t.z - (dz / d) * standoff, t.id, 0.5);
    else if (u.ammo < 2 && !miss) this.endAttack(u, st);
    else if (!u.orders.length) this.setDest(u, 'attack', t.x, t.z, t.id, 0.5);
  }

  /** Angriffslauf auf Bodenziel (Bomber/Jäger): Anflug -> Abwurf/Beschuss -> Abflug -> ggf. erneut */
  private driveJetRun(u: Unit, st: CU, tx: number, tz: number, tUnit: Unit | null, kind: 'attack' | 'fireAt'): void {
    const id = tUnit ? tUnit.id : 0;
    const dx = tx - u.x, dz = tz - u.z;
    const d = Math.hypot(dx, dz);
    if (st.airPhase === 0) {
      st.airPhase = 1;
      st.minD = d;
    }
    if (st.airPhase === 1) {
      this.setDest(u, kind, tx, tz, id, 0.3);
      if (d < st.minD) st.minD = d;
      // Bomber: Abwurf, wenn Vorhaltestrecke erreicht
      let bombW = -1;
      for (let i = 0; i < st.weapons.length; i++) if (st.weapons[i].kind === 'bomb') bombW = i;
      if (bombW >= 0 && u.ammo >= 1) {
        const alt = FLY_ALT[u.type.model] ?? 1.5;
        const fall = Math.sqrt((2 * alt * 1000) / 9.81);
        const lead = (u.speedKmh / 3600) * fall;
        if (d <= lead + 0.15 && u.speedKmh > 100) {
          this.dropBombs(u, st, bombW, tx, tz, fall, dx / (d || 1), dz / (d || 1), tUnit);
          this.beginEgress(u, st, tx, tz, kind, id);
          return;
        }
      }
      // Überflug ohne Abwurf / Beschusslauf beendet
      if (d > st.minD + 1.2 && st.minD < 6) this.beginEgress(u, st, tx, tz, kind, id);
      else if (d < 0.5 && bombW < 0 && this.time - st.lastFire > 1.2 && st.minD < 0.5) this.beginEgress(u, st, tx, tz, kind, id);
      return;
    }
    // Phase 2: Abflug
    st.egT -= 0.4;
    const ex = st.egX - u.x, ez = st.egZ - u.z;
    if (Math.hypot(ex, ez) < 2.5 || st.egT <= 0) {
      st.airPhase = 0;
      if (tUnit && (tUnit.hp <= 0 || !this.hasAmmoForRun(u, st))) this.endAttack(u, st);
      else if (!tUnit && !this.hasAmmoForRun(u, st)) {
        st.mission = false;
        if (u.orders.length && u.orders[0].kind === 'fireAt') u.orders.shift();
        u.fireX = u.fireZ = undefined;
        this.endAttack(u, st);
      }
      return;
    }
    this.setDest(u, kind, st.egX, st.egZ, id, 1);
  }

  private beginEgress(u: Unit, st: CU, tx: number, tz: number, kind: 'attack' | 'fireAt', id: number): void {
    st.airPhase = 2;
    st.egT = 40;
    let dx = tx - u.x, dz = tz - u.z;
    let l = Math.hypot(dx, dz);
    if (l < 1e-6) { dx = Math.sin(u.heading); dz = -Math.cos(u.heading); l = 1; }
    st.egX = tx + (dx / l) * 14;
    st.egZ = tz + (dz / l) * 14;
    this.setDest(u, kind, st.egX, st.egZ, id, 0);
  }

  private dropBombs(u: Unit, st: CU, wi: number, tx: number, tz: number, fallSec: number, dirX: number, dirZ: number, tUnit: Unit | null): void {
    const w = st.weapons[wi];
    // Phase 4: kein Abwurf auf eigene/verbündete Zivilgebiete (auch nicht bei Überflug auf dem Weg); Absicht melden
    if (this.protection && this.protection.isProtected(tx, tz, u.owner)) {
      this.stats.civilBlocked++;
      return;
    }
    this.emitOrderTarget(u, st, tx, tz, tUnit ? 0 : 0.06);
    const n = Math.min(3, Math.floor(u.ammo / w.ammoPerShot));
    const exp = 0.85 + 0.3 * u.experience;
    const sc = (0.045 / exp) * (1 + (u.suppression ?? 0));
    for (let i = 0; i < n; i++) {
      const off = (i - (n - 1) / 2) * 0.07;
      const a = this.rand() * 6.283, r = sc * Math.sqrt(this.rand());
      const ix = tx + dirX * off + Math.cos(a) * r, iz = tz + dirZ * off + Math.sin(a) * r;
      u.ammo -= w.ammoPerShot;
      this.stats.shots++;
      const fy = u.y, ty = this.groundY(ix, iz);
      bus.emit('combat:fire', { unitId: u.id, weapon: w.kind, fx: u.x, fy, fz: u.z, tx: ix, ty, tz: iz, flightSec: fallSec + i * 0.4, indirect: true });
      this.schedule(w, u, tUnit ? tUnit.id : 0, false, ix, ty, iz, 0, fallSec + i * 0.4, i);
    }
    st.lastFire = this.time;
    st.revealedUntil = this.time + B.REVEAL_TTL * 2;
  }

  // ------------------------------------------------------------------ Sicht / Zielsuche

  private seeUnit(a: Unit, b: Unit): boolean {
    return this.los.canSeeCached(a.id, b.id, a.x, a.z, this.heightOf(a), b.x, b.z, this.heightOf(b));
  }

  private detectRange(u: Unit, st: CU, e: Unit): number {
    const sight = u.type.sightKm;
    const et = e.type;
    const moving = e.speedKmh > 2;
    let m = 1;
    const hidden = !!(e.garrisonId || e.coverId || e.posture === 'prone' || (e.stance === 'hold' && isInfantry(e)));
    if (!moving) m = isInfantry(e) ? 0.6 : 0.8;
    if (hidden && !moving) m = 0.5;
    const est = this.states.get(e.id);
    if (est && est.revealedUntil > this.time) m = Math.max(m, 1.25);
    if (st.hintId === e.id && st.hintT > this.time) m = Math.max(m, 1.15);
    if (et.category === 'jet') m *= 1.4;
    if (et.id === 'submarine') m *= u.type.mobility.domain === 'naval' || u.type.category === 'helicopter' ? 0.5 : 0.2;
    return sight * m;
  }

  private scan(u: Unit, st: CU): void {
    this.stats.scans++;
    st.scanT = B.SCAN_INTERVAL * (0.8 + this.rand() * 0.4);
    st.wTgt.fill(0);
    st.hasTarget = false;
    const oi = this.ownerIndex(u.owner);
    const sight = u.type.sightKm;
    const armed = st.weapons.length > 0;
    const tmp = this.tmpU;
    this.units.queryRadius(u.x, u.z, sight * 1.6, tmp);
    // nächste Kandidaten (Entfernung) vorselektieren
    const cap = armed ? 16 : 24;
    this.preN = 0;
    const pre = this.preId, preD = this.preD;
    for (let k = 0; k < tmp.length; k++) {
      const e = tmp[k];
      if (e === u || e.hp <= 0 || !this.hostile(u.owner, e.owner)) continue;
      const dx = e.x - u.x, dz = e.z - u.z;
      const d2 = dx * dx + dz * dz;
      const det = this.detectRange(u, st, e);
      if (d2 > det * det) continue;
      // sortiert einfügen (nächste zuerst), Puffer begrenzt auf cap
      let p: number;
      if (this.preN < cap) p = this.preN++;
      else if (d2 < preD[cap - 1]) p = cap - 1;
      else continue;
      while (p > 0 && preD[p - 1] > d2) {
        preD[p] = preD[p - 1];
        pre[p] = pre[p - 1];
        p--;
      }
      preD[p] = d2;
      pre[p] = e.id;
    }
    st.nC = 0;
    const forced = st.attackId ? this.units.get(st.attackId) : undefined;
    if (forced && forced.hp > 0) {
      st.cands[st.nC] = forced.id;
      st.cvis[st.nC] = this.seeUnit(u, forced) ? 1 : 0;
      st.nC++;
    }
    for (let k = 0; k < this.preN && st.nC < MAXC - 2; k++) {
      const e = this.units.get(pre[k]);
      if (!e || e.hp <= 0) continue;
      if (!this.seeUnit(u, e)) continue;
      const est = this.stateOf(e);
      est.seen[oi] = this.time + B.SEEN_TTL;
      if (forced && e === forced) continue;
      if (armed) {
        st.cands[st.nC] = e.id;
        st.cvis[st.nC] = 1;
        st.nC++;
      }
    }
    // Aufklärungsmeldungen für Waffen mit mehr Reichweite als Sicht (indirektes Feuer, Raketen, Schiffe)
    if (armed) {
      let maxR = 0;
      for (const w of st.weapons) if (w.rangeKm > maxR && w.autoFire !== false && !w.needsLOS) maxR = w.rangeKm;
      if (maxR > sight * 1.15) {
        this.units.queryRadius(u.x, u.z, Math.min(maxR, 90), tmp);
        let added = 0;
        for (let k = 0; k < tmp.length && st.nC < MAXC && added < 4; k++) {
          const e = tmp[k];
          if (e === u || e.hp <= 0 || !this.hostile(u.owner, e.owner)) continue;
          const est = this.states.get(e.id);
          if (!est || est.seen[oi] <= this.time) continue;
          let dup = false;
          for (let c = 0; c < st.nC; c++) if (st.cands[c] === e.id) dup = true;
          if (dup) continue;
          st.cands[st.nC] = e.id;
          st.cvis[st.nC] = 0;
          st.nC++;
          added++;
        }
      }
    }
    // Gegenfeuer: Schütze, der uns trifft, auch wenn nicht regulär entdeckt
    if (armed && st.hintId && st.hintT > this.time && st.nC < MAXC) {
      const e = this.units.get(st.hintId);
      if (e && e.hp > 0) {
        let dup = false;
        for (let c = 0; c < st.nC; c++) if (st.cands[c] === e.id) dup = true;
        if (!dup && Math.hypot(e.x - u.x, e.z - u.z) <= sight * 1.5 && this.seeUnit(u, e)) {
          st.cands[st.nC] = e.id;
          st.cvis[st.nC] = 1;
          st.nC++;
        }
      }
    }
  }

  // ------------------------------------------------------------------ Trefferwahrscheinlichkeit / Schaden

  private facingMult(t: Unit, ax: number, az: number): number {
    const ang = Math.atan2(ax - t.x, -(az - t.z));
    const diff = Math.abs(wrapAngle(ang - t.heading));
    return diff < 0.8 ? 1 : diff < 2.2 ? B.ARMOR_SIDE : B.ARMOR_REAR;
  }

  /** Schutz 0..0.9 durch Deckung/Gebäude/Haltung für Infanterie gegenüber Schuss aus (ax,az) */
  private coverProt(t: Unit, ax: number, az: number, w: WeaponDef): number {
    if (!isInfantry(t) && t.type.category !== 'artillery') return 0;
    let p = 0;
    const plunging = w.indirect || w.topAttack;
    if (t.garrisonId) p = 0.72;
    else if (t.coverId && this.cover) {
      const cp = this.cover.get(t.coverId);
      if (cp && cp.alive) {
        const dx = ax - t.x, dz = az - t.z;
        const l = Math.hypot(dx, dz) || 1;
        const dot = (cp.dirX * dx + cp.dirZ * dz) / l;
        if (dot > 0.25) {
          p = cp.protection;
          if (plunging && cp.kind !== 'trench' && cp.kind !== 'bunker' && cp.kind !== 'building') p *= 0.5;
        }
      }
    } else if (this.structures) {
      const arr = this.structures.structuresInRadius(t.x, t.z, 0.03, this.tmpS);
      for (let i = 0; i < arr.length; i++) {
        const s = arr[i];
        if (s.owner !== t.owner || s.progress < 0.99 || s.hp <= 0) continue;
        const sp = s.kind === 'bunker' ? 0.8 : s.kind === 'trench' ? 0.65 : s.kind === 'foxhole' ? 0.55 : s.kind === 'sandbags' || s.kind === 'mg_nest' || s.kind === 'at_position' || s.kind === 'mortar_pit' ? 0.5 : 0;
        if (sp > p) p = sp;
      }
    }
    const pp = t.posture === 'prone' ? 0.25 : t.posture === 'crouch' ? 0.1 : 0;
    p = 1 - (1 - p) * (1 - pp);
    return Math.min(0.9, p);
  }

  private hitProb(u: Unit, w: WeaponDef, t: Unit, d: number, prot: number): number {
    const dr = Math.min(1, d / Math.max(w.rangeKm, 1e-6));
    const rf = w.guided ? 1 - 0.2 * dr : 1 - 0.5 * Math.pow(dr, 1.3);
    const mv = u.speedKmh > 2 ? w.moveFire : 1;
    const air = this.isAirborneTarget(t);
    let tm = 1;
    if (!w.guided) {
      tm = 1 - 0.4 * Math.min(1, t.speedKmh / (air ? 300 : 60));
      if (air && t.type.category === 'jet') tm *= 0.5;
    }
    const size = SIZE_MUL[t.type.category] ?? 1;
    const exp = 0.85 + 0.3 * u.experience;
    const mor = 0.7 + 0.3 * u.morale;
    const sup = 1 - 0.45 * (u.suppression ?? 0);
    const p = w.accuracy * rf * mv * tm * size * exp * mor * sup * (1 - 0.7 * prot);
    return clamp(p, 0.02, 0.97);
  }

  /** Erwarteter/tatsächlicher Direkttrefferschaden (ohne Zufall) */
  private shotDamage(w: WeaponDef, t: Unit, ax: number, az: number, prot: number): number {
    let dmg = w.damage;
    const armor = t.type.armor;
    if (armor > 0) {
      const fm = w.topAttack ? B.ARMOR_TOP : this.facingMult(t, ax, az);
      const ratio = w.armorPen / Math.max(1, armor * fm);
      const f = ratio >= 1 ? Math.min(1.35, 1 + (ratio - 1) * 0.35) : Math.max(0.02, ratio * ratio);
      dmg *= f;
      if (armor <= 15 && w.vsSoft) dmg *= w.vsSoft;
    } else if (w.vsSoft) dmg *= w.vsSoft;
    return dmg * (1 - 0.55 * prot);
  }

  private score(u: Unit, st: CU, wi: number, t: Unit, d: number, vis: boolean, forced: boolean): number {
    const w = st.weapons[wi];
    if (!(st.masks[wi] & this.classMask(t))) return 0;
    if (t.type.id === 'submarine' && w.kind !== 'torpedo') return 0;
    if (d > w.rangeKm || d < w.minRangeKm) return 0;
    if (w.needsLOS && !vis) return 0;
    if (!forced && w.autoFire === false) return 0;
    // Flak spart Munition für Luftziele
    if (w.kind === 'flak' && !(this.classMask(t) & MASK_AIR) && u.ammo < u.type.ammo * 0.6) return 0;
    if (!this.weaponReady(u, st, wi)) return 0;
    if (u.airborne === false && u.type.mobility.domain === 'air') return 0;
    // Phase 4: Zivilschutz je Waffenklasse (Direktfeuer in eigenen Städten bleibt erlaubt)
    if (this.protection && !this.isAirborneTarget(t) && this.blockedFor(u, w, t.x, t.z)) return 0;
    const prot = this.coverProt(t, u.x, u.z, w);
    const p = this.hitProb(u, w, t, d, prot);
    const dmg = this.shotDamage(w, t, u.x, u.z, prot);
    let v = ((p * dmg) / t.type.hp) * Math.pow(t.type.cost + 1, 0.6);
    if (!forced && v < B.MIN_SCORE) return 0;
    v *= 1 + 0.5 * (1 - t.hp / t.type.hp);
    if (t.targetId === u.id) v *= 1.5;
    if (forced) v += 1000;
    return v / (1 + (0.5 * d) / w.rangeKm);
  }

  // ------------------------------------------------------------------ Feuerleitung

  private fireControl(u: Unit, st: CU, dt: number): void {
    const nW = st.weapons.length;
    st.hasTarget = false;
    if (u.ammo <= 0) {
      if (st.mission) this.endMission(u, st);
      return;
    }
    const suppr = u.suppression ?? 0;
    const rofMod = Math.max(0.15, this.memberFrac(u)) * (1 - 0.6 * suppr) * (0.75 + 0.25 * u.morale);
    let primary = 0;

    for (let wi = 0; wi < nW; wi++) {
      const w = st.weapons[wi];
      if (st.mission) {
        this.fireMission(u, st, wi, w, rofMod);
        continue;
      }
      // Ziel wählen / prüfen
      let t: Unit | undefined = st.wTgt[wi] ? this.units.get(st.wTgt[wi]) : undefined;
      if (t) {
        const d = Math.hypot(t.x - u.x, t.z - u.z);
        if (t.hp <= 0 || d > w.rangeKm || d < w.minRangeKm || !(st.masks[wi] & this.classMask(t))) t = undefined;
        // Phase 4: Ziel ist inzwischen in ein gesperrtes Zivilgebiet gewandert
        else if (this.protection && !this.isAirborneTarget(t) && this.blockedFor(u, w, t.x, t.z)) t = undefined;
      }
      if (!t && st.nC > 0) t = this.pickTarget(u, st, wi);
      if (!t) {
        st.wTgt[wi] = 0;
        continue;
      }
      st.wTgt[wi] = t.id;
      st.hasTarget = true;
      if (!primary) primary = t.id;
      if (st.lastT[wi] !== t.id) {
        st.lastT[wi] = t.id;
        const aim = w.kind === 'tank_gun' ? 0.8 : w.guided ? 0.6 : 0.25;
        if (st.cd[wi] < aim) st.cd[wi] = aim;
      }
      let shots = 0;
      while (st.cd[wi] <= 0 && shots < 4 && u.ammo >= w.ammoPerShot - 1e-6 && t.hp > 0) {
        this.fireAtUnit(u, st, wi, w, t);
        st.cd[wi] += 60 / (w.rofPerMin * rofMod);
        shots++;
        if (u.hp <= 0 || st.dead) return;
      }
      if (st.cd[wi] < -1) st.cd[wi] = -1;
    }
    u.targetId = primary || st.attackId || 0;
    if (primary) this.faceTarget(u, primary, dt);
  }

  private faceTarget(u: Unit, tid: number, dt: number): void {
    if (u.speedKmh > 2) return;
    const d = u.type.mobility.domain;
    const cat = u.type.category;
    if (cat === 'jet' || cat === 'drone') return;
    if (this.time - (this.states.get(u.id)?.lastFire ?? -99) > 3) return;
    const t = this.units.get(tid);
    if (!t) return;
    const want = Math.atan2(t.x - u.x, -(t.z - u.z));
    const err = wrapAngle(want - u.heading);
    const rate = isInfantry(u) ? 6 : d === 'naval' ? 0.25 : cat === 'helicopter' ? 1 : 1.3;
    const turn = rate * dt;
    u.heading = wrapAngle(u.heading + clamp(err, -turn, turn));
  }

  private pickTarget(u: Unit, st: CU, wi: number): Unit | undefined {
    let best = 0, bestT: Unit | undefined;
    for (let c = 0; c < st.nC; c++) {
      const t = this.units.get(st.cands[c]);
      if (!t || t.hp <= 0) continue;
      const d = Math.hypot(t.x - u.x, t.z - u.z);
      const s = this.score(u, st, wi, t, d, st.cvis[c] === 1, t.id === st.attackId);
      if (s > best) { best = s; bestT = t; }
    }
    return bestT;
  }

  private endMission(u: Unit, st: CU): void {
    st.mission = false;
    u.fireX = u.fireZ = undefined;
    if (u.orders.length && u.orders[0].kind === 'fireAt') {
      u.orders.shift();
      u.route = null;
      u.routeKm = 0;
    }
  }

  private fireMission(u: Unit, st: CU, wi: number, w: WeaponDef, rofMod: number): void {
    if (u.type.category === 'jet') return;
    if (w.splashKm <= 0 || w.kind === 'bomb' || w.kind === 'fpv' || w.kind === 'demo_charge') return;
    const dx = st.mX - u.x, dz = st.mZ - u.z;
    const d = Math.hypot(dx, dz);
    if (d > w.rangeKm || d < w.minRangeKm) {
      // keine Waffe erreicht das Ziel: Mission nach der letzten Waffe beenden
      let any = false;
      for (let i = 0; i < st.weapons.length; i++) {
        const o = st.weapons[i];
        if (o.splashKm > 0 && d <= o.rangeKm && d >= o.minRangeKm) any = true;
      }
      if (!any) {
        bus.emit('toast', { msg: `${u.name}: Ziel außerhalb der Reichweite.`, kind: 'warn' });
        this.endMission(u, st);
      }
      return;
    }
    if (!w.indirect && !this.los.canSee(u.x, u.z, this.heightOf(u), st.mX, st.mZ, 0.002)) return;
    if (!this.weaponReady(u, st, wi)) {
      let any = false;
      for (let i = 0; i < st.weapons.length; i++) if (st.weapons[i].splashKm > 0 && this.weaponReady(u, st, i)) any = true;
      if (!any) this.endMission(u, st);
      return;
    }
    if (st.cd[wi] > 0) return;
    if (this.protection && this.protection.isProtected(st.mX, st.mZ, u.owner)) {
      bus.emit('toast', { msg: 'Ziel liegt in einem geschützten Gebiet.', kind: 'warn' });
      this.endMission(u, st);
      return;
    }
    st.hasTarget = true;
    // Phase 4: Absicht alle ~2 Spielminuten auffrischen (laufende Feuermission = gezielter Befehl)
    if (this.time - st.intentT > 120) this.emitOrderTarget(u, st, st.mX, st.mZ, 0.03);
    let shots = 0;
    while (st.cd[wi] <= 0 && shots < 3 && u.ammo >= w.ammoPerShot - 1e-6) {
      const a = this.rand() * 6.283, r = 0.025 * Math.sqrt(this.rand());
      this.fireAtPoint(u, st, w, st.mX + Math.cos(a) * r, st.mZ + Math.sin(a) * r, 0, false);
      st.cd[wi] += 60 / (w.rofPerMin * rofMod);
      shots++;
    }
  }

  // ------------------------------------------------------------------ Schüsse

  private muzzleY(u: Unit): number {
    return u.y + (u.type.mobility.domain === 'air' ? 0 : 0.0025 * this.exag);
  }

  private fireAtUnit(u: Unit, st: CU, _wi: number, w: WeaponDef, t: Unit): void {
    const dx = t.x - u.x, dz = t.z - u.z;
    const d = Math.hypot(dx, dz);
    this.stats.shots++;
    st.lastFire = this.time;
    st.revealedUntil = this.time + (w.indirect ? 1 : B.REVEAL_TTL);
    u.ammo = Math.max(0, u.ammo - w.ammoPerShot);

    // Kamikaze: Schütze wird verbraucht
    if (w.kamikaze) this.consumeKamikaze(u);

    if (w.indirect) {
      this.fireAtPoint(u, st, w, t.x, t.z, t.id, true, t);
      return;
    }
    const prot = this.coverProt(t, u.x, u.z, w);
    const p = this.hitProb(u, w, t, d, prot);
    const hit = this.rand() < p;
    const speedKms = w.projectileSpeedKmh / 3600;
    const flight = speedKms > 0 ? d / speedKms : 0;
    // Vorhalt
    let ax = t.x, az = t.z;
    if (flight > 0.4 && t.speedKmh > 2) {
      const v = (t.speedKmh / 3600) * flight * (w.guided ? 0.9 : 0.8);
      ax += Math.sin(t.heading) * v;
      az -= Math.cos(t.heading) * v;
    }
    let ix = ax, iz = az, iy: number;
    const air = this.isAirborneTarget(t);
    if (hit) iy = air ? t.y : t.y + 0.002 * this.exag;
    else {
      const ang = this.rand() * 6.283;
      let r = 0.004 + (1 - p) * 0.025 * (1 + d);
      if (air) r = w.splashKm * (0.4 + this.rand() * 1.4);
      r = Math.min(r, 0.2) * (0.5 + this.rand() * 0.5);
      ix += Math.cos(ang) * r;
      iz += Math.sin(ang) * r;
      iy = air ? t.y + (this.rand() - 0.5) * 0.02 * this.exag : this.groundY(ix, iz);
    }
    bus.emit('combat:fire', { unitId: u.id, weapon: w.kind, fx: u.x, fy: this.muzzleY(u), fz: u.z, tx: ix, ty: iy, tz: iz, flightSec: flight, indirect: false });
    if (hit) this.stats.hits++;
    this.schedule(w, u, t.id, hit, ix, iy, iz, prot, flight, 0);
    // Gegenfeuer-Hinweis für das Opfer
    const tst = this.stateOf(t);
    tst.hintId = u.id;
    tst.hintT = this.time + 6;
    tst.hitX = u.x;
    tst.hitZ = u.z;
    tst.hitT = this.time;
  }

  private consumeKamikaze(u: Unit): void {
    const n = u.type.memberCount;
    u.hp -= u.type.hp / n;
    u.membersAlive = Math.max(0, (u.membersAlive ?? n) - 1);
    if (u.hp <= 0.5 || u.ammo < 0.5) this.killUnit(u, 0, 'expended', true);
  }

  /** Indirekter/Flächenschuss: Ziel (x,z) + Streuung, Einschlag nach Flugzeit */
  private fireAtPoint(u: Unit, st: CU, w: WeaponDef, x: number, z: number, targetId: number, countAmmo: boolean, tUnit?: Unit): void {
    if (!countAmmo) {
      u.ammo = Math.max(0, u.ammo - w.ammoPerShot);
      this.stats.shots++;
      st.lastFire = this.time;
      st.revealedUntil = this.time + 1;
    }
    const d = Math.hypot(x - u.x, z - u.z);
    const speedKms = w.projectileSpeedKmh / 3600;
    const flight = speedKms > 0 ? d / speedKms : 0;
    let ax = x, az = z;
    if (tUnit && tUnit.speedKmh > 2 && flight > 0.5) {
      const v = (tUnit.speedKmh / 3600) * flight * 0.7;
      ax += Math.sin(tUnit.heading) * v;
      az -= Math.cos(tUnit.heading) * v;
    }
    const exp = 0.85 + 0.3 * u.experience;
    const rad = ((0.006 + (w.scatter ?? 0.002) * d) / exp) * (1 + 0.5 * (u.suppression ?? 0));
    const a = this.rand() * 6.283, r = rad * Math.sqrt(this.rand());
    const ix = ax + Math.cos(a) * r, iz = az + Math.sin(a) * r;
    const iy = this.groundY(ix, iz);
    bus.emit('combat:fire', { unitId: u.id, weapon: w.kind, fx: u.x, fy: this.muzzleY(u), fz: u.z, tx: ix, ty: iy, tz: iz, flightSec: flight, indirect: true });
    this.schedule(w, u, 0, false, ix, iy, iz, 0, flight, 0);
    void targetId;
  }

  // ------------------------------------------------------------------ Geschosse im Flug

  private schedule(w: WeaponDef, u: Unit, targetId: number, hit: boolean, x: number, y: number, z: number, prot: number, flight: number, seq: number): void {
    if (flight <= 0) {
      this.resolveImpact(w, u.id, u.owner, targetId, hit, x, y, z, prot);
      return;
    }
    let s: Shell;
    const fi = this.freeShells.pop();
    if (fi !== undefined) s = this.shells[fi];
    else {
      s = { active: false, t: 0, w, attackerId: 0, owner: '', targetId: 0, hit: false, x: 0, y: 0, z: 0, prot: 0, seq: 0 };
      this.shells.push(s);
    }
    s.active = true;
    s.t = flight;
    s.w = w;
    s.attackerId = u.id;
    s.owner = u.owner;
    s.targetId = targetId;
    s.hit = hit;
    s.x = x;
    s.y = y;
    s.z = z;
    s.prot = prot;
    s.seq = seq;
    this.stats.shellsInFlight++;
  }

  private resolveShells(dt: number): void {
    const arr = this.shells;
    for (let i = 0; i < arr.length; i++) {
      const s = arr[i];
      if (!s.active) continue;
      s.t -= dt;
      if (s.t > 0) continue;
      s.active = false;
      this.freeShells.push(i);
      this.stats.shellsInFlight--;
      this.resolveImpact(s.w, s.attackerId, s.owner, s.targetId, s.hit, s.x, s.y, s.z, s.prot);
    }
  }

  private resolveImpact(w: WeaponDef, attackerId: number, owner: string, targetId: number, hit: boolean, x: number, y: number, z: number, prot: number): void {
    const t = targetId ? this.units.get(targetId) : undefined;
    let surface: ImpactSurface = 'ground';
    let excludeId = 0;
    const attacker = this.units.get(attackerId);
    if (hit && t && t.hp > 0 && !this.stateOf(t).dead) {
      // Lenkwaffen/Flak treffen am aktuellen Ort
      x = t.x;
      z = t.z;
      y = this.isAirborneTarget(t) ? t.y : t.y + 0.002 * this.exag;
      excludeId = t.id;
      surface = isInfantry(t) ? 'flesh' : 'armor';
      let dmg = this.shotDamage(w, t, attacker ? attacker.x : x, attacker ? attacker.z : z, prot) * (0.8 + this.rand() * 0.4);
      let supAdd = w.suppression;
      if (t.garrisonId) {
        dmg *= 0.4;
        this.buildings?.damageBuilding(t.garrisonId, w.damage * (w.buildingMul ?? 0.05) * 0.7, x, z);
        surface = 'building';
      }
      supAdd *= this.suppressMul(t, w);
      this.applyDamage(t, dmg, attackerId, w.kind, supAdd, attacker?.x ?? x, attacker?.z ?? z, 1);
    } else {
      if (this.geo.heightAt(x, z) < 0) surface = 'water';
      else if (this.buildings) {
        const arr = this.buildings.buildingsInRadius(x, z, 0.02, this.tmpB);
        if (arr.length) surface = 'building';
      }
      if (t && t.hp > 0 && !hit && w.splashKm <= 0) {
        // Streufeuer: Nahtreffer unterdrückt das Ziel
        this.addSuppression(t, w.suppression * 0.5 * this.suppressMul(t, w), attacker?.x ?? x, attacker?.z ?? z);
      }
    }
    // Airburst (Flak/SAM) in der Luft
    const airburst = w.targets.includes('air') && !w.targets.includes('ground') && !(hit && t) ;
    bus.emit('combat:impact', { weapon: w.kind, x, y, z, surface: airburst ? 'ground' : surface, radiusKm: Math.max(w.splashKm, 0.004) });
    if (w.splashKm > 0.025 || w.kind === 'bomb') bus.emit('combat:explosion', { x, y, z, size: this.explSize(w), fire: w.damage >= 80 });
    else if (airburst || w.splashKm > 0.012) bus.emit('combat:explosion', { x, y, z, size: 'tiny', fire: false });
    if (w.splashKm > 0 || w.suppression > 0.05) this.splash(w, attackerId, owner, x, z, excludeId, attacker);
  }

  private explSize(w: WeaponDef): ExplosionSize {
    const s = w.splashKm;
    return s >= 0.1 ? 'huge' : s >= 0.06 ? 'large' : s >= 0.03 ? 'medium' : 'small';
  }

  private suppressMul(t: Unit, w: WeaponDef): number {
    const a = t.type.armor;
    if (a > 40) return w.splashKm > 0.02 ? 0.5 : 0.15;
    if (a > 15) return w.splashKm > 0.02 ? 0.7 : 0.4;
    return 1;
  }

  private addSuppression(t: Unit, amount: number, fromX: number, fromZ: number): void {
    if (amount <= 0) return;
    const cat = t.type.category;
    if (cat === 'jet' || cat === 'drone') return;
    t.suppression = Math.min(1, (t.suppression ?? 0) + amount);
    t.morale = Math.max(0, t.morale - amount * 0.1);
    const st = this.states.get(t.id);
    if (st) {
      st.hitX = fromX;
      st.hitZ = fromZ;
      st.hitT = this.time;
    }
  }

  /** Splitterschaden, Nahtreffer-Unterdrückung, Gebäude- und Bauwerksschaden */
  private splash(w: WeaponDef, attackerId: number, owner: string, x: number, z: number, excludeId: number, attacker: Unit | undefined): void {
    const R = w.splashKm;
    const supR = Math.max(R * 3, w.suppression > 0.05 && R <= 0 ? 0.02 : 0);
    const reach = Math.max(R, supR);
    if (reach <= 0) return;
    const depth = this.splashDepth;
    if (depth > 3) return;
    this.splashDepth++;
    const arr = this.units.queryRadius(x, z, reach, this.tmpSplash[depth]);
    const aa = w.targets.includes('air') && !w.targets.includes('ground');
    const aaGround = w.targets.includes('air') && w.targets.includes('ground');
    const ax = attacker ? attacker.x : x, az = attacker ? attacker.z : z;
    for (let i = 0; i < arr.length; i++) {
      const e = arr[i];
      if (e.id === excludeId || e.id === attackerId || e.hp <= 0) continue;
      const eAir = this.isAirborneTarget(e);
      if (eAir && !(aa || aaGround)) continue;
      if (!eAir && aa) continue;
      const d = Math.hypot(e.x - x, e.z - z);
      const isHost = this.hostile(owner, e.owner);
      const ff = isHost ? 1 : B.FRIENDLY_FIRE;
      if (d <= R && R > 0) {
        const fall = 1 - d / R;
        let dmg = w.damage * (0.55 * fall + 0.45 * fall * fall);
        const armor = e.type.armor;
        if (armor > 15) {
          const f = clamp(((w.armorPen * 0.5) / (armor * 0.7)) ** 2, 0.02, 1);
          dmg *= f;
        }
        const prot = this.coverProt(e, x + (ax - x) * 0.01, z + (az - z) * 0.01, w);
        dmg *= 1 - 0.7 * prot;
        if (e.garrisonId) dmg *= 0.5;
        dmg *= ff;
        this.applyDamage(e, dmg, attackerId, w.kind, w.suppression * this.suppressMul(e, w) * ff, x, z, 0);
      } else if (isHost && d <= reach && !eAir) {
        const f = R > 0 ? 1 - (d - R) / Math.max(reach - R, 1e-6) : 1 - d / reach;
        this.addSuppression(e, w.suppression * 0.5 * f * this.suppressMul(e, w), x, z);
      }
    }
    this.splashDepth--;
    // Gebäude und Bauwerke
    if (R > 0 && !aa) {
      if (this.buildings) {
        const bs = this.buildings.buildingsInRadius(x, z, R + 0.015, this.tmpB);
        // Phase 4: Streuschaden in eigenen/verbündeten Zivilgebieten stark abgeschwächt und gezählt
        let civMul = 1;
        if (this.protection && bs.length && this.protection.isProtected(x, z, owner)) {
          civMul = 0.2;
          this.stats.civilSplashOwn++;
        }
        const mul = (w.buildingMul ?? 0.3) * civMul;
        for (let i = 0; i < bs.length; i++) {
          const b = bs[i];
          if (b.integrity <= 0) continue;
          const bd = Math.max(0, Math.hypot(b.x - x, b.z - z) - Math.max(b.w, b.d) * 0.5);
          if (bd > R) continue;
          this.buildings.damageBuilding(b.id, w.damage * mul * (1 - bd / R), x, z);
        }
      }
      if (this.structures) {
        const ss = this.structures.structuresInRadius(x, z, R, this.tmpS);
        for (let i = 0; i < ss.length; i++) {
          const s = ss[i];
          if (s.hp <= 0) continue;
          this.structures.damageStructure(s.id, w.damage * (w.buildingMul ?? 0.3) * 0.8);
        }
      }
    }
  }

  // ------------------------------------------------------------------ Schaden / Tod

  private applyDamage(t: Unit, dmg: number, attackerId: number, cause: string, supAdd: number, fromX: number, fromZ: number, direct: number): void {
    if (t.hp <= 0 || dmg <= 0 && supAdd <= 0) return;
    const st = this.stateOf(t);
    if (st.dead) return;
    const maxHp = t.type.hp;
    if (dmg > 0) {
      dmg = Math.min(dmg, t.hp);
      t.hp -= dmg;
      this.stats.damageDealt += dmg;
      t.morale = Math.max(0, t.morale - (dmg / maxHp) * B.MORALE_PER_DMG);
      const n = t.type.memberCount;
      const alive = t.hp <= 0 ? 0 : Math.max(1, Math.ceil((t.hp / maxHp) * n - 1e-6));
      t.membersAlive = alive;
      if (isInfantry(t)) t.wounded = Math.min(alive, Math.round((n - alive) * 0.5));
    }
    this.addSuppression(t, supAdd, fromX, fromZ);
    if (direct === 0 && dmg <= 0) return;
    bus.emit('unit:damaged', { id: t.id, amount: dmg, hp: Math.max(0, t.hp), attackerId, suppression: t.suppression ?? 0 });
    if (t.hp <= 0.001) this.killUnit(t, attackerId, cause, false);
  }

  private killUnit(u: Unit, killerId: number, cause: string, expended: boolean): void {
    const st = this.stateOf(u);
    if (st.dead) return;
    st.dead = true;
    u.hp = 0;
    u.membersAlive = 0;
    u.engaged = false;
    this.dead.push(u);
    const cat = u.type.category;
    if (!expended) {
      this.stats.kills++;
      const k = killerId ? this.units.get(killerId) : undefined;
      if (k) {
        k.kills = (k.kills ?? 0) + 1;
        k.experience = Math.min(1, k.experience + B.XP_PER_KILL);
        k.morale = Math.min(1, k.morale + 0.05);
      }
    }
    bus.emit('unit:killed', { id: u.id, typeId: u.type.id, category: cat, owner: u.owner, x: u.x, y: u.y, z: u.z, heading: u.heading, killerId, cause });
    const soft = isInfantry(u);
    const vehicle = !soft && cat !== 'drone';
    if (vehicle || expended) {
      const size: ExplosionSize = cat === 'naval' ? 'huge' : cat === 'tank' || cat === 'jet' || cat === 'helicopter' || cat === 'artillery' ? 'large' : cat === 'drone' ? 'tiny' : 'medium';
      bus.emit('combat:explosion', { x: u.x, y: u.y, z: u.z, size: expended ? 'small' : size, fire: !expended });
    }
    if (vehicle && !expended) {
      bus.emit('wreck:spawn', { x: u.x, y: u.y, z: u.z, heading: u.heading, category: cat, typeId: u.type.id, owner: u.owner });
      if (u.ammo > 0.5 && cat !== 'naval' && this.rand() < B.COOKOFF_CHANCE && this.splashDepth < 2) {
        bus.emit('combat:explosion', { x: u.x, y: u.y, z: u.z, size: 'large', fire: true });
        this.splash(COOKOFF, u.id, u.owner, u.x, u.z, u.id, undefined);
      }
    }
  }
}
