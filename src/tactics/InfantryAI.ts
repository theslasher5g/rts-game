/**
 * Phase 3 – Infanterie-KI (Zustandsautomat je Infanterie-Einheit).
 *
 * Zustände: IDLE, SEEK_COVER, IN_COVER, ADVANCE, PINNED, DODGE_GRENADE, VAULT, GARRISONED (+ TREAT für sanitäter).
 *
 * Schnittstelle zur restlichen Simulation (Felder an `Unit`):
 *   gesetzt von dieser KI:  posture, coverId, coverX/Z, coverDirX/Z, pinned, vaultT, suppression (nur Abklingen)
 *   gelesen von dieser KI:  suppression (CombatSystem erhöht), wounded, hp, garrisonId, orders, speedKmh
 *   `pinned = true`  => UnitManager soll die Einheit anhalten (Befehle bleiben), CombatSystem: nur Gegenfeuer mit Malus.
 *
 * Eigene Bewegungsbefehle (Deckung anlaufen, Sanitäter) werden als `ai.ownOrder` markiert; jeder andere Befehl in
 * `orders[0]` gilt als Spielerbefehl und wird nie überschrieben.
 */
import { bus } from '../core/EventBus';
import type { CoverPoint, Posture, WeaponKind } from '../combat/types';
import type { Order, Unit } from '../units/types';
import type { UnitManager } from '../units/UnitManager';
import { BEHIND_KM, type CoverSystem } from './CoverSystem';

export type AIState = 'IDLE' | 'SEEK_COVER' | 'IN_COVER' | 'ADVANCE' | 'PINNED' | 'DODGE_GRENADE' | 'VAULT' | 'GARRISONED' | 'TREAT';

// ---------------------------------------------------------------- Tuning
export const TUNING = {
  /** Bedrohungsradius = Faktor × sightKm */
  threatSightMult: 1.2,
  /** Suchradius Deckung (km) frei / bei 'hold' */
  coverRadius: 0.08,
  coverRadiusHold: 0.04,
  /** Suppression-Abklingen pro Spielsekunde, sobald > underFireGrace ohne Beschuss */
  suppressionDecay: 0.15,
  underFireGrace: 1.2,
  /** PINNED ab / bis */
  pinEnter: 0.7,
  pinExit: 0.4,
  /** Beschuss-Erkennung: Einschlag/Schuss näher als (km) */
  impactNear: 0.05,
  /** Sek. ohne Bedrohung bis Aufstehen */
  standAfter: 5,
  /** Granatenausweichen: Radius um Einschlagpunkt (km) */
  dodgeRadius: 0.04,
  dodgeFleeKm: 0.05,
  /** Springen */
  vaultDur: 0.6,
  vaultReachKm: 0.006,
  vaultCooldown: 3,
  /** Überwachungs-/Vorrückphase (s) */
  boundPeriod: 6,
  /** Sanitäter */
  medicRadiusKm: 0.3,
  medicReachKm: 0.03,
  treatSoldiersPerSec: 0.2,
  treatHpFracPerSec: 0.01,
  /** Verweildauer von Ereignissen im Ringpuffer (s) */
  eventTtl: 4,
};

const INDIRECT_DODGE: ReadonlySet<WeaponKind> = new Set<WeaponKind>(['grenade', 'mortar', 'howitzer', 'rocket_arty']);

export function isInfantry(u: Unit): boolean {
  return u.type.category === 'infantry' || u.type.model === 'soldier';
}

interface AIData {
  state: AIState;
  stateT: number;
  lastThink: number;
  nextThink: number;
  /** Eigener Bewegungsbefehl (Referenz in u.orders[0]) */
  ownOrder: Order | null;
  ownT: number;
  /** Anvisierte / belegte Deckung (CoverPoint.id), 0 = keine */
  coverId: number;
  calmT: number;
  threatX: number;
  threatZ: number;
  hasThreat: boolean;
  underFireT: number;
  damagedT: number;
  dodgeUntil: number;
  vaultCd: number;
  medicTarget: number;
}

interface FireRec { t: number; shooter: number; fx: number; fz: number; tx: number; tz: number; arrive: number; weapon: WeaponKind; indirect: boolean }
interface ImpactRec { t: number; x: number; z: number }

const RING = 96;

export class InfantryAI {
  readonly data = new Map<number, AIData>();
  private now = 0;
  private fires: FireRec[] = [];
  private impacts: ImpactRec[] = [];
  private damaged = new Map<number, { t: number; attacker: number }>();
  private tmp: Unit[] = [];
  private tmpCover: CoverPoint[] = [];
  private offs: Array<() => void> = [];

  constructor(private units: UnitManager, private cover: CoverSystem, private isHostile: (a: string, b: string) => boolean) {
    this.offs.push(
      bus.on('combat:fire', (e) => {
        this.fires.push({ t: this.now, shooter: e.unitId, fx: e.fx, fz: e.fz, tx: e.tx, tz: e.tz, arrive: this.now + e.flightSec, weapon: e.weapon, indirect: e.indirect });
        if (this.fires.length > RING) this.fires.shift();
      }),
      bus.on('combat:impact', (e) => {
        this.impacts.push({ t: this.now, x: e.x, z: e.z });
        if (this.impacts.length > RING) this.impacts.shift();
      }),
      bus.on('unit:damaged', (e) => this.damaged.set(e.id, { t: this.now, attacker: e.attackerId })),
      bus.on('unit:removed', ({ id }) => this.forget(id)),
    );
  }

  dispose(): void {
    for (const o of this.offs) o();
    this.offs.length = 0;
  }

  setTime(t: number): void {
    this.now = t;
  }

  forget(id: number): void {
    const a = this.data.get(id);
    if (a && a.coverId) this.cover.release(a.coverId, id);
    this.data.delete(id);
    this.damaged.delete(id);
  }

  stateOf(id: number): AIState | undefined {
    return this.data.get(id)?.state;
  }

  private ai(u: Unit): AIData {
    let a = this.data.get(u.id);
    if (!a) {
      a = {
        state: 'IDLE', stateT: 0, lastThink: this.now, nextThink: this.now + (u.id % 7) * 0.05, ownOrder: null, ownT: 0, coverId: 0, calmT: 0,
        threatX: 0, threatZ: 0, hasThreat: false, underFireT: -99, damagedT: -99, dodgeUntil: -99, vaultCd: 0, medicTarget: 0,
      };
      this.data.set(u.id, a);
    }
    return a;
  }

  private setState(a: AIData, s: AIState): void {
    if (a.state !== s) {
      a.state = s;
      a.stateT = 0;
    }
  }

  /** Pro-Frame-Aufgabe: Sprung-Timer */
  tickVault(u: Unit, dt: number): void {
    if (u.vaultT && u.vaultT > 0) u.vaultT = Math.max(0, u.vaultT - dt);
  }

  // ------------------------------------------------------------ Denken

  think(u: Unit): void {
    const a = this.ai(u);
    const dt = Math.min(2, Math.max(0, this.now - a.lastThink));
    a.lastThink = this.now;
    a.nextThink = this.now + 0.25 + ((u.id * 7919) % 100) / 400; // 0.25 .. 0.5 s
    a.stateT += dt;
    this.prune();

    // --- Besetzt in Gebäude: nichts tun
    if (u.garrisonId) {
      this.dropCover(u, a);
      u.pinned = false;
      u.vaultT = 0;
      this.setState(a, 'GARRISONED');
      return;
    }
    if (a.state === 'GARRISONED') this.setState(a, 'IDLE');

    // --- Eigener Befehl noch aktiv?
    if (a.ownOrder) {
      a.ownT += dt;
      if (u.orders[0] !== a.ownOrder) {
        const finished = !u.orders.includes(a.ownOrder);
        a.ownOrder = null;
        if (finished) a.ownT = 0;
      } else if (a.ownT > 25) {
        u.orders.length = 0; // hängt fest -> aufgeben
        u.route = null;
        a.ownOrder = null;
      }
    }
    const hasPlayerOrder = u.orders.length > 0 && u.orders[0] !== a.ownOrder;
    const holding = u.stance === 'hold';

    // --- Beschuss / Bedrohung
    const underFire = this.detectFire(u, a);
    this.findThreat(u, a);
    let supp = u.suppression ?? 0;
    if (supp > 0 && this.now - a.underFireT > TUNING.underFireGrace) {
      supp = Math.max(0, supp - TUNING.suppressionDecay * dt);
      u.suppression = supp;
    }

    // --- Granaten
    this.checkDodge(u, a, hasPlayerOrder);
    if (this.now < a.dodgeUntil) {
      this.setState(a, 'DODGE_GRENADE');
      u.pinned = true;
      u.posture = 'prone';
      return;
    }
    if (a.state === 'DODGE_GRENADE') this.setState(a, 'IDLE');

    // --- Festgenagelt
    if (supp >= TUNING.pinEnter || (a.state === 'PINNED' && (supp > TUNING.pinExit || a.stateT < 1.5))) {
      this.setState(a, 'PINNED');
      u.pinned = true;
      u.posture = 'prone';
      return;
    }
    if (a.state === 'PINNED') {
      this.setState(a, 'IDLE');
      u.pinned = false;
    }

    // --- Spielerbefehl aktiv: gehen / vorrücken, nicht stören
    if (hasPlayerOrder) {
      this.dropCover(u, a);
      a.calmT = 0;
      const moving = u.speedKmh > 0.3;
      u.pinned = false;
      u.posture = 'stand';
      const o = u.orders[0];
      if (o.kind === 'attackMove' && a.hasThreat) {
        this.setState(a, 'ADVANCE');
        // Überwachungsphase (Bounding Overwatch): jede zweite Periode hält die Hälfte der Trupps an und deckt
        const d = Math.hypot(a.threatX - u.x, a.threatZ - u.z);
        if (d < u.type.rangeKm * 1.5 && Math.floor(this.now / TUNING.boundPeriod + u.id) % 2 === 1) {
          u.pinned = true;
          u.posture = 'crouch';
        }
      } else if (a.state === 'ADVANCE' || a.state === 'SEEK_COVER' || a.state === 'IN_COVER' || a.state === 'TREAT') this.setState(a, 'IDLE');
      if (moving && a.state !== 'VAULT') this.checkVault(u, a);
      if (a.state === 'VAULT' && a.stateT > TUNING.vaultDur) this.setState(a, 'IDLE');
      return;
    }
    if (a.state === 'VAULT' && a.stateT > TUNING.vaultDur) this.setState(a, 'IDLE');

    // --- Eigener Marsch zur Deckung / zum Verwundeten
    if (a.ownOrder) {
      u.pinned = false;
      if (a.state === 'SEEK_COVER') {
        const c = a.coverId ? this.cover.get(a.coverId) : undefined;
        if (!c) {
          this.cancelOwn(u, a); // Deckung zerstört
        } else {
          u.posture = 'stand';
          if (u.speedKmh > 0.3) this.checkVault(u, a);
          return;
        }
      } else if (a.state === 'TREAT' || a.medicTarget) {
        // Sanitäter läuft zum Verwundeten, wenn kein schweres Feuer
        if (underFire || supp > 0.4) this.cancelOwn(u, a);
        else {
          u.posture = 'stand';
          if (this.medic(u, a, dt, supp, underFire)) return;
        }
      }
    }

    // --- Ruhender Trupp: Sanitäter-Aufgaben
    if (u.type.id === 'medic_team' && !underFire && supp <= 0.4) {
      if (this.medic(u, a, dt, supp, underFire)) return;
    } else if (a.medicTarget) a.medicTarget = 0;

    // --- Deckung nehmen
    const threatened = a.hasThreat || underFire;
    if (threatened) {
      a.calmT = 0;
      const tx = a.hasThreat ? a.threatX : u.x + Math.sin(u.heading) * 0.5;
      const tz = a.hasThreat ? a.threatZ : u.z - Math.cos(u.heading) * 0.5;
      let c = a.coverId ? this.cover.get(a.coverId) : undefined;
      if (c && a.state === 'IN_COVER') {
        // Deckung gegen die aktuelle Bedrohung noch gültig?
        const cos = this.facing(c, tx, tz);
        if (cos < 0.2) {
          this.dropCover(u, a);
          c = undefined;
        }
      }
      if (!c) {
        const r = holding ? TUNING.coverRadiusHold : TUNING.coverRadius;
        const found = this.cover.find(u.x, u.z, tx, tz, r, 0.25);
        if (found) {
          a.coverId = found.id;
          this.cover.occupy(found.id, u.id, Math.max(1, u.membersAlive ?? u.type.memberCount));
          c = found;
          this.gotoCover(u, a, found, tx, tz);
          return;
        }
        // Keine Deckung: an Ort und Stelle ducken/hinlegen
        this.setState(a, 'IN_COVER');
        u.posture = supp > 0.3 || underFire ? 'prone' : 'crouch';
        u.pinned = false;
        this.clearCoverFields(u);
        return;
      }
      // In Deckung (angekommen?)
      const sx = c.x - c.dirX * BEHIND_KM, sz = c.z - c.dirZ * BEHIND_KM;
      if (Math.hypot(u.x - sx, u.z - sz) > 0.02) {
        this.gotoCover(u, a, c, tx, tz);
        return;
      }
      this.setState(a, 'IN_COVER');
      this.applyCover(u, c, supp > 0.3 || underFire ? (c.posture === 'stand' ? 'crouch' : c.posture) : c.posture);
      u.pinned = false;
      return;
    }

    // --- Keine Bedrohung
    u.pinned = false;
    if (a.state === 'IN_COVER' || a.state === 'SEEK_COVER') {
      a.calmT += dt;
      if (a.calmT >= TUNING.standAfter) {
        this.dropCover(u, a);
        this.setState(a, 'IDLE');
        u.posture = 'stand';
      } else if (a.state === 'IN_COVER' && !u.posture) u.posture = 'crouch';
      return;
    }
    this.setState(a, 'IDLE');
    u.posture = 'stand';
  }

  // ------------------------------------------------------------ Hilfen

  private facing(c: CoverPoint, tx: number, tz: number): number {
    const dx = tx - c.x, dz = tz - c.z;
    const l = Math.hypot(dx, dz);
    return l > 1e-6 ? (c.dirX * dx + c.dirZ * dz) / l : 1;
  }

  private gotoCover(u: Unit, a: AIData, c: CoverPoint, tx: number, tz: number): void {
    const sx = c.x - c.dirX * BEHIND_KM, sz = c.z - c.dirZ * BEHIND_KM;
    this.setState(a, 'SEEK_COVER');
    u.posture = 'stand';
    this.clearCoverFields(u);
    if (Math.hypot(u.x - sx, u.z - sz) < 0.004) {
      // schon (fast) dort
      this.setState(a, 'IN_COVER');
      this.applyCover(u, c, c.posture);
      return;
    }
    if (a.ownOrder && u.orders[0] === a.ownOrder && Math.hypot(a.ownOrder.x - sx, a.ownOrder.z - sz) < 0.01) return; // läuft schon
    const stance = u.stance;
    this.units.issueMove([u.id], sx, sz, { kind: 'move', facing: Math.atan2(tx - sx, -(tz - sz)) });
    u.stance = stance; // issueMove setzt 'free'
    a.ownOrder = u.orders[0] ?? null;
    a.ownT = 0;
  }

  private applyCover(u: Unit, c: CoverPoint, posture: Posture): void {
    u.posture = posture;
    u.coverId = c.id;
    u.coverX = c.x;
    u.coverZ = c.z;
    u.coverDirX = c.dirX;
    u.coverDirZ = c.dirZ;
  }

  private clearCoverFields(u: Unit): void {
    u.coverId = 0;
    u.coverX = undefined;
    u.coverZ = undefined;
    u.coverDirX = undefined;
    u.coverDirZ = undefined;
  }

  private dropCover(u: Unit, a: AIData): void {
    if (a.coverId) this.cover.release(a.coverId, u.id);
    a.coverId = 0;
    if (a.ownOrder) this.cancelOwn(u, a);
    if (u.coverId) this.clearCoverFields(u);
  }

  private cancelOwn(u: Unit, a: AIData): void {
    if (a.ownOrder && u.orders[0] === a.ownOrder) {
      u.orders.length = 0;
      u.route = null;
      u.routeKm = 0;
    }
    a.ownOrder = null;
  }

  private prune(): void {
    const t = this.now - TUNING.eventTtl;
    while (this.fires.length && this.fires[0].t < t && this.fires[0].arrive < this.now - 1) this.fires.shift();
    while (this.impacts.length && this.impacts[0].t < t) this.impacts.shift();
  }

  /** Beschuss in der Nähe? Merkt sich Bedrohungsrichtung (Schütze) */
  private detectFire(u: Unit, a: AIData): boolean {
    const R = TUNING.impactNear, R2 = R * R;
    let hit = false;
    for (const i of this.impacts) {
      if (this.now - i.t > 2) continue;
      const dx = i.x - u.x, dz = i.z - u.z;
      if (dx * dx + dz * dz < R2) { hit = true; break; }
    }
    a.hasThreat = false;
    for (const f of this.fires) {
      if (f.indirect || this.now - f.t > 3) continue;
      const dx = f.tx - u.x, dz = f.tz - u.z;
      if (dx * dx + dz * dz > R2) continue;
      const sh = this.units.get(f.shooter);
      if (sh && !this.isHostile(sh.owner, u.owner)) continue;
      hit = true;
      a.threatX = f.fx;
      a.threatZ = f.fz;
      a.hasThreat = true;
    }
    const d = this.damaged.get(u.id);
    if (d && this.now - d.t < 3) {
      hit = true;
      const at = this.units.get(d.attacker);
      if (at && !a.hasThreat) { a.threatX = at.x; a.threatZ = at.z; a.hasThreat = true; }
    }
    if (hit) a.underFireT = this.now;
    return this.now - a.underFireT < 2;
  }

  /** Nächste feindliche Einheit im Bedrohungsradius */
  private findThreat(u: Unit, a: AIData): void {
    const R = u.type.sightKm * TUNING.threatSightMult;
    const list = this.units.queryRadius(u.x, u.z, R, this.tmp);
    let best = Infinity;
    let found = false;
    for (const o of list) {
      if (o.id === u.id || o.owner === u.owner || o.hp <= 0) continue;
      if (o.garrisonId) continue;
      if (o.type.mobility.domain === 'air' && o.type.category !== 'helicopter') continue;
      const d = (o.x - u.x) ** 2 + (o.z - u.z) ** 2;
      if (d >= best || !this.isHostile(u.owner, o.owner)) continue;
      best = d;
      a.threatX = o.x;
      a.threatZ = o.z;
      found = true;
    }
    if (found) a.hasThreat = true;
  }

  /** Eingehende Granaten/Mörser: ducken und ggf. ausweichen */
  private checkDodge(u: Unit, a: AIData, hasPlayerOrder: boolean): void {
    for (const f of this.fires) {
      if (!INDIRECT_DODGE.has(f.weapon)) continue;
      if (this.now > f.arrive + 0.3 || f.arrive < a.dodgeUntil - 1.8) continue;
      const dx = u.x - f.tx, dz = u.z - f.tz;
      const d = Math.hypot(dx, dz);
      if (d > TUNING.dodgeRadius) continue;
      const sh = this.units.get(f.shooter);
      if (sh && !this.isHostile(sh.owner, u.owner)) continue;
      if (a.dodgeUntil > f.arrive) continue; // schon abgedeckt
      a.dodgeUntil = f.arrive + 1.8;
      a.underFireT = this.now;
      if (!hasPlayerOrder && f.arrive - this.now > 0.8 && !a.ownOrder) {
        const l = Math.max(d, 1e-4);
        const fx = u.x + (dx / l) * TUNING.dodgeFleeKm, fz = u.z + (dz / l) * TUNING.dodgeFleeKm;
        const stance = u.stance;
        this.dropCover(u, a);
        this.units.issueMove([u.id], fx, fz, { kind: 'move' });
        u.stance = stance;
        a.ownOrder = u.orders[0] ?? null;
        a.ownT = 0;
      }
    }
  }

  /** Niedrige Deckung auf dem Weg überspringen */
  private checkVault(u: Unit, a: AIData): void {
    if (this.now < a.vaultCd || (u.vaultT ?? 0) > 0) return;
    const near = this.cover.near(u.x + Math.sin(u.heading) * 0.003, u.z - Math.cos(u.heading) * 0.003, TUNING.vaultReachKm, this.tmpCover);
    for (const c of near) {
      if (!c.vaultable) continue;
      // nur Hindernisse, die im Weg liegen (Bewegung grob quer zur Deckungsrichtung)
      const along = Math.abs(Math.sin(u.heading) * c.dirX - Math.cos(u.heading) * c.dirZ);
      if (along < 0.4) continue;
      this.setState(a, 'VAULT');
      u.vaultT = TUNING.vaultDur;
      a.vaultCd = this.now + TUNING.vaultCooldown;
      return;
    }
  }

  /**
   * Sanitäter: sucht verwundete Freunde, läuft hin, behandelt. true = beschäftigt (nicht weiter denken).
   */
  private medic(u: Unit, a: AIData, dt: number, supp: number, underFire: boolean): boolean {
    let t = a.medicTarget ? this.units.get(a.medicTarget) : undefined;
    if (t && ((t.wounded ?? 0) <= 0 || t.garrisonId || this.isHostile(u.owner, t.owner))) t = undefined;
    if (!t) {
      a.medicTarget = 0;
      let best = Infinity;
      for (const o of this.units.queryRadius(u.x, u.z, TUNING.medicRadiusKm, this.tmp)) {
        if (o.id === u.id || o.owner !== u.owner || (o.wounded ?? 0) <= 0 || o.garrisonId) continue;
        const d = (o.x - u.x) ** 2 + (o.z - u.z) ** 2;
        if (d < best) { best = d; t = o; }
      }
      if (!t) {
        if (a.state === 'TREAT') this.setState(a, 'IDLE');
        return false;
      }
      a.medicTarget = t.id;
    }
    // unter schwerem Feuer die Deckung nicht verlassen
    if (underFire || supp > 0.4) return false;
    if ((t.suppression ?? 0) > 0.8 && a.state !== 'TREAT') return false;
    const d = Math.hypot(t.x - u.x, t.z - u.z);
    if (d <= TUNING.medicReachKm) {
      if (a.ownOrder) this.cancelOwn(u, a);
      this.setState(a, 'TREAT');
      u.posture = 'crouch';
      this.clearCoverFields(u);
      const w = t.wounded ?? 0;
      t.wounded = Math.max(0, w - TUNING.treatSoldiersPerSec * dt);
      if (t.wounded < 0.05) t.wounded = 0;
      t.hp = Math.min(t.type.hp, t.hp + t.type.hp * TUNING.treatHpFracPerSec * dt);
      return true;
    }
    // hinlaufen
    this.setState(a, 'TREAT');
    if (!(a.ownOrder && u.orders[0] === a.ownOrder && Math.hypot(a.ownOrder.x - t.x, a.ownOrder.z - t.z) < 0.04)) {
      const stance = u.stance;
      this.dropCover(u, a);
      this.units.issueMove([u.id], t.x, t.z, { kind: 'move' });
      u.stance = stance;
      a.ownOrder = u.orders[0] ?? null;
      a.ownT = 0;
    }
    u.posture = 'stand';
    return true;
  }
}
