/**
 * Phase 7 – KI-Nutzung der Fähigkeiten (optionaler Hook, vom Lead pro Frame aufzurufen: `abilityAI.update(state.lastHours)`).
 * Billige Regeln, schwierigkeitsabhängig: Artillerie/Luftschlag auf Gegnerhaufen bzw. Basen nahe eigener Truppen,
 * Rauch für unterdrückte Gruppen, Versorgungsabwurf für ausgelaugte Gruppen. Die KI zielt nie auf Zivilgebiete
 * (checkTarget muss 'free' liefern), nutzt also keine Kriegsverbrechen.
 */
import type { Difficulty, GameContext } from '../game/context';
import type { AbilitySystem } from './AbilitySystem';
import type { Unit } from '../units/types';
import type { ProtectionQuery } from '../civil/types';

export interface AbilityAIOptions {
  difficulty: Difficulty | (() => Difficulty);
  /** Nationen, die die KI steuert (z. B. alle außer dem Spieler) */
  nations: () => string[];
  protection?: ProtectionQuery | null;
}

interface Tune {
  /** Spielstunden zwischen zwei Entscheidungen je Nation */
  period: number;
  /** Fässer, die mindestens übrig bleiben müssen */
  reserve: number;
  /** Mindestgröße eines Gegnerhaufens für Artillerie */
  minCluster: number;
  air: boolean;
  support: boolean;
}

const TUNE: Record<Difficulty, Tune> = {
  leicht: { period: 1.6, reserve: 260, minCluster: 5, air: false, support: false },
  mittel: { period: 0.8, reserve: 160, minCluster: 4, air: true, support: true },
  schwer: { period: 0.4, reserve: 90, minCluster: 3, air: true, support: true },
};

export class AbilityAI {
  private readonly ctx: GameContext;
  private readonly ab: AbilitySystem;
  private readonly opts: AbilityAIOptions;
  private readonly next = new Map<string, number>();
  private time = 0;
  private readonly tmpA: Unit[] = [];
  private readonly tmpB: Unit[] = [];
  enabled = true;
  readonly stats = { barrage: 0, airstrike: 0, smoke: 0, supply: 0 };

  constructor(ctx: GameContext, abilities: AbilitySystem, opts: AbilityAIOptions) {
    this.ctx = ctx;
    this.ab = abilities;
    this.opts = opts;
  }

  private get diff(): Difficulty {
    const d = this.opts.difficulty;
    return typeof d === 'function' ? d() : d;
  }

  update(dtGameHours: number): void {
    if (!this.enabled || !(dtGameHours > 0)) return;
    this.time += dtGameHours;
    const t = TUNE[this.diff];
    for (const a3 of this.opts.nations()) {
      const due = this.next.get(a3);
      if (due === undefined) {
        // gestaffelter Start, damit nicht alle Nationen gleichzeitig entscheiden
        this.next.set(a3, this.time + t.period * (0.5 + Math.random()));
        continue;
      }
      if (this.time < due) continue;
      this.next.set(a3, this.time + t.period * (0.8 + Math.random() * 0.4));
      this.decide(a3, t);
    }
  }

  private decide(a3: string, t: Tune): void {
    const eco = this.ctx.economy;
    const war = this.ctx.war;
    const own: Unit[] = [];
    for (const u of this.ctx.units.units) if (u.owner === a3 && u.hp > 0 && u.type.category !== 'support' && u.type.category !== 'drone') own.push(u);
    if (!own.length) return;
    const afford = (id: string) => {
      const d = this.ab.def(id);
      return !!d && this.ab.cooldownLeft(a3, id) <= 0 && eco.pool(a3).barrels >= d.cost + t.reserve;
    };
    // höchstens 40 Stichproben eigener Einheiten
    const step = Math.max(1, Math.floor(own.length / 40));

    // 1. Gegnerhaufen in Sichtweite eigener Truppen
    let best: { x: number; z: number; n: number; w: number } | null = null;
    if (afford('artillery_barrage') || (t.air && afford('airstrike'))) {
      for (let i = 0; i < own.length; i += step) {
        const o = own[i];
        const near = this.ctx.units.queryRadius(o.x, o.z, Math.max(2, o.type.sightKm), this.tmpA);
        for (const h of near) {
          if (h.hp <= 0 || h.owner === a3 || !war.isHostile(a3, h.owner) || h.airborne) continue;
          const cl = this.ctx.units.queryRadius(h.x, h.z, 0.25, this.tmpB);
          let n = 0, w = 0, cx = 0, cz = 0;
          for (const e of cl) {
            if (e.hp <= 0 || e.owner === a3 || !war.isHostile(a3, e.owner) || e.airborne) continue;
            n++;
            const wt = e.type.armor > 15 ? 2 : 1;
            w += wt;
            cx += e.x;
            cz += e.z;
          }
          if (n >= t.minCluster && (!best || w > best.w)) best = { x: cx / n, z: cz / n, n, w };
        }
      }
    }
    if (best) {
      // eigene Truppen nicht im Wirkungsradius
      const friendly = this.ctx.units.queryRadius(best.x, best.z, 0.35, this.tmpA).some((u) => u.hp > 0 && (u.owner === a3 || !war.isHostile(a3, u.owner)));
      if (!friendly) {
        if (t.air && best.w >= t.minCluster * 1.6 && afford('airstrike') && this.ab.checkTarget(a3, 'airstrike', best.x, best.z).ok && this.isFree(a3, best.x, best.z)) {
          if (this.ab.use(a3, 'airstrike', best.x, best.z).ok) { this.stats.airstrike++; return; }
        }
        if (afford('artillery_barrage') && this.isFree(a3, best.x, best.z)) {
          if (this.ab.use(a3, 'artillery_barrage', best.x, best.z).ok) { this.stats.barrage++; return; }
        }
      }
    }

    if (!t.support) return;
    // 2. Unterdrückte Gruppe -> Nebel; 3. ausgelaugte Gruppe -> Versorgungsabwurf
    for (let i = 0; i < own.length; i += step) {
      const o = own[i];
      const grp = this.ctx.units.queryRadius(o.x, o.z, 1.2, this.tmpA).filter((u) => u.owner === a3 && u.hp > 0);
      if (grp.length < 4) continue;
      let sup = 0, need = 0, cx = 0, cz = 0;
      for (const u of grp) {
        if ((u.suppression ?? 0) > 0.35) sup++;
        const tt = u.type;
        const fuelLow = Number.isFinite(tt.fuelKm) && tt.fuelKm > 0 && u.fuel < tt.fuelKm * 0.3;
        const ammoLow = tt.damage > 0 && tt.ammo > 0 && u.ammo < tt.ammo * 0.3;
        if (fuelLow || ammoLow) need++;
        cx += u.x;
        cz += u.z;
      }
      cx /= grp.length;
      cz /= grp.length;
      if (need >= Math.max(3, grp.length * 0.4) && afford('supply_drop') && this.ab.use(a3, 'supply_drop', cx, cz).ok) { this.stats.supply++; return; }
      if (sup >= Math.max(3, grp.length * 0.4) && afford('smoke_screen') && this.ab.use(a3, 'smoke_screen', cx, cz).ok) { this.stats.smoke++; return; }
    }
  }

  /** KI meidet Zivilgebiete grundsätzlich (keine Kriegsverbrechen) */
  private isFree(a3: string, x: number, z: number): boolean {
    const p = this.opts.protection;
    return !p || p.classify(x, z, a3, 0.3).cls === 'free';
  }
}
