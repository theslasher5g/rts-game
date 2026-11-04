/**
 * Ereignisgetriebene Statistik (Verluste, Abschüsse, Lieferungen, Konvois, Brücken …) je Nation.
 * Läuft als Singleton `statsTracker`; MissionSystem ruft reset() beim Laden einer Mission, EndScreen liest die Zähler.
 * Die Bus-Abos werden einmal beim ersten bind() angelegt und bleiben bestehen (kein Aufräumen nötig).
 */
import { bus } from '../../core/EventBus';

export interface NationStats {
  /** eigene Einheitenverluste */
  lost: number;
  lostByCat: Record<string, number>;
  lostByType: Record<string, number>;
  /** Abschüsse (Killer gehört zu dieser Nation) */
  kills: number;
  killsByCat: Record<string, number>;
  /** Fässer, die diese Nation an die Raffinerie geliefert hat, und Anzahl Ladungen */
  delivered: number;
  loads: number;
  /** verlorene Konvois / von dieser Nation abgefangene Feindkonvois */
  convoysLost: number;
  convoysRaided: number;
  barrelsLost: number;
  fieldsCaptured: number;
  fieldsLost: number;
  citiesCaptured: number;
  structures: number;
  structureKinds: Record<string, number>;
  basesBuilt: Record<string, number>;
  produced: number;
  /** höchstes beobachtetes Einkommen (Fässer/h) */
  peakIncome: number;
}

export interface BridgeEvent {
  edgeId: number;
  x: number;
  z: number;
}

function blank(): NationStats {
  return {
    lost: 0, lostByCat: {}, lostByType: {}, kills: 0, killsByCat: {}, delivered: 0, loads: 0,
    convoysLost: 0, convoysRaided: 0, barrelsLost: 0, fieldsCaptured: 0, fieldsLost: 0, citiesCaptured: 0,
    structures: 0, structureKinds: {}, basesBuilt: {}, produced: 0, peakIncome: 0,
  };
}

function inc(r: Record<string, number>, k: string, n = 1): void {
  r[k] = (r[k] ?? 0) + n;
}

export class StatsTracker {
  readonly nations = new Map<string, NationStats>();
  readonly bridgesBlown: BridgeEvent[] = [];
  bridgesRepaired = 0;
  /** Auflösung Killer-Unit -> Besitzer (vom MissionSystem gesetzt) */
  ownerOf: (unitId: number) => string = () => '';
  private bound = false;
  private active = true;

  /** Statistik der Nation (wird bei Bedarf angelegt) */
  of(a3: string): NationStats {
    let s = this.nations.get(a3);
    if (!s) this.nations.set(a3, (s = blank()));
    return s;
  }

  reset(): void {
    this.nations.clear();
    this.bridgesBlown.length = 0;
    this.bridgesRepaired = 0;
  }

  setActive(on: boolean): void {
    this.active = on;
  }

  /** Abos anlegen (idempotent) */
  bind(): void {
    if (this.bound) return;
    this.bound = true;
    bus.on('unit:killed', (e) => {
      if (!this.active) return;
      const v = this.of(e.owner);
      v.lost++;
      inc(v.lostByCat, e.category);
      inc(v.lostByType, e.typeId);
      const ko = e.killerId ? this.ownerOf(e.killerId) : '';
      if (ko && ko !== e.owner) {
        const k = this.of(ko);
        k.kills++;
        inc(k.killsByCat, e.category);
      }
    });
    bus.on('convoy:lost', (e) => {
      if (!this.active) return;
      const v = this.of(e.owner);
      v.convoysLost++;
      v.barrelsLost += e.cargo;
      if (e.by) this.of(e.by).convoysRaided++;
    });
    bus.on('oil:delivered', (e) => {
      if (!this.active) return;
      const s = this.of(e.owner);
      s.delivered += e.barrels;
      s.loads++;
    });
    bus.on('oil:balance', (e) => {
      if (!this.active) return;
      const s = this.of(e.owner);
      if (e.incomePerHour > s.peakIncome) s.peakIncome = e.incomePerHour;
    });
    bus.on('bridge:destroyed', (e) => {
      if (!this.active) return;
      const g = e.geom;
      let x = 0, z = 0;
      const n = Math.floor(g.length / 2);
      if (n > 0) {
        for (let i = 0; i < n; i++) { x += g[i * 2]; z += g[i * 2 + 1]; }
        x /= n; z /= n;
      }
      this.bridgesBlown.push({ edgeId: e.edgeId, x, z });
    });
    bus.on('bridge:repaired', () => {
      if (this.active) this.bridgesRepaired++;
    });
    bus.on('structure:added', (e) => {
      if (!this.active) return;
      const s = this.of(e.owner);
      s.structures++;
      inc(s.structureKinds, e.kind);
    });
    bus.on('base:built', (e) => {
      if (this.active) inc(this.of(e.owner).basesBuilt, e.kind);
    });
    bus.on('production:complete', (e) => {
      if (this.active) this.of(e.owner).produced++;
    });
    bus.on('oil:field-captured', (e) => {
      if (!this.active) return;
      this.of(e.by).fieldsCaptured++;
      if (e.from) this.of(e.from).fieldsLost++;
    });
    bus.on('city:captured', (e) => {
      if (this.active) this.of(e.by).citiesCaptured++;
    });
  }
}

export const statsTracker = new StatsTracker();
