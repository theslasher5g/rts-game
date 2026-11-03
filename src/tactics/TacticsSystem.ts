/**
 * Phase 3 – Taktiksystem: tickt CoverSystem und InfantryAI (gestaffelt).
 *
 * update(dtGameSec, realDt): dtGameSec = Spielzeit (0 bei Pause), realDt = Echtzeit (nur für Animationen/Timer).
 */
import { bus } from '../core/EventBus';
import type { Settings } from '../core/types';
import type { UnitManager } from '../units/UnitManager';
import type { GeoData } from '../world/GeoData';
import type { CoverSystem } from './CoverSystem';
import { InfantryAI, isInfantry } from './InfantryAI';

export interface TacticsDeps {
  geo: GeoData;
  units: UnitManager;
  cover: CoverSystem;
  isHostile: (a: string, b: string) => boolean;
  settings: Settings;
}

/** Max. Anteil der Einheiten, die pro Frame denken dürfen */
const THINK_FRACTION = 0.25;

export class TacticsSystem {
  readonly ai: InfantryAI;
  /** Einheiten-IDs, die gerade in einem Gebäude sind (werden übersprungen) */
  readonly inBuilding = new Set<number>();
  private time = 0;
  private cursor = 0;
  private settings: Settings;
  private vaulting = new Set<number>();
  private offs: Array<() => void> = [];

  constructor(private deps: TacticsDeps) {
    this.settings = deps.settings;
    this.ai = new InfantryAI(deps.units, deps.cover, deps.isHostile);
    this.offs.push(
      bus.on('building:garrison', (e) => {
        for (const id of e.unitIds) {
          if (e.enter) this.inBuilding.add(id);
          else this.inBuilding.delete(id);
        }
      }),
      bus.on('unit:removed', ({ id }) => this.inBuilding.delete(id)),
    );
  }

  get currentSettings(): Settings {
    return this.settings;
  }

  applySettings(s: Settings): void {
    this.settings = s;
    this.deps.cover.applySettings(s);
  }

  dispose(): void {
    for (const o of this.offs) o();
    this.ai.dispose();
  }

  update(dtGameSec: number, realDt: number): void {
    const { units, cover } = this.deps;
    this.time += dtGameSec;
    this.ai.setTime(this.time);
    if (dtGameSec > 0) cover.update(dtGameSec);

    const list = units.units;
    const n = list.length;
    if (n === 0) return;

    // Sprung-Animation läuft in Echtzeit weiter
    if (this.vaulting.size) {
      for (const id of this.vaulting) {
        const u = units.get(id);
        if (!u || !(u.vaultT && u.vaultT > 0)) {
          this.vaulting.delete(id);
          continue;
        }
        this.ai.tickVault(u, realDt);
      }
    }
    if (dtGameSec <= 0) return;

    const budget = Math.max(8, Math.ceil(n * THINK_FRACTION));
    let done = 0;
    if (this.cursor >= n) this.cursor = 0;
    for (let k = 0; k < n && done < budget; k++) {
      const idx = (this.cursor + k) % n;
      const u = list[idx];
      if (!isInfantry(u)) continue;
      if (u.hp <= 0) continue;
      const a = this.ai.data.get(u.id);
      if (a && a.nextThink > this.time) continue;
      if (this.inBuilding.has(u.id)) continue;
      this.ai.think(u);
      done++;
      if (u.vaultT && u.vaultT > 0) this.vaulting.add(u.id);
      if (k === n - 1) this.cursor = 0;
    }
    this.cursor = (this.cursor + Math.max(1, done)) % n;
  }
}
