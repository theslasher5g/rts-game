/**
 * Phase 7 – Übersetzer: Spielereignisse -> normierte Lagemeldungen ('alert' auf dem EventBus) für die Nation des Spielers
 * und seine Verbündeten. Alles gedrosselt (je Ort/Objekt/Art), deutsche Texte, Kind info/warn/danger.
 *
 * Wird NUR für die lokale Seite benutzt: Host und Gäste instanziieren je eine AlertSource für ihren eigenen Spieler
 * (die rohen Ereignisse kommen auf Gästen über NET_EVENTS an). Meldungen anderer Quellen (z. B. AbilitySystem-Warnungen)
 * laufen direkt als 'alert' ein; der EventLog filtert nach Team.
 */
import { bus } from '../core/EventBus';
import type { GameEvents } from '../core/types';
import type { GameContext } from '../game/context';
import { getUnitType } from '../units/unitTypes';

type Kind = 'info' | 'warn' | 'danger';

export interface AlertSourceOptions {
  /** Mindestabstand (ms, Echtzeit) gleicher Meldungen pro Schlüssel; Standard je Art unterschiedlich */
  now?: () => number;
}

const CELL_KM = 4;

export class AlertSource {
  private readonly ctx: GameContext;
  private readonly getPlayer: () => string | null;
  private readonly getAllies: () => string[];
  private readonly now: () => number;
  private readonly offs: Array<() => void> = [];
  private readonly last = new Map<string, number>();
  private readonly tankers = new Map<string, { x: number; z: number; t: number }>();
  private readonly baseCache = new Map<number, { x: number; z: number; name: string; owner: string }>();
  private readonly bridgePos = new Map<number, [number, number]>();
  private readonly impacts = new Map<number, number[]>();
  private readonly supplyBatch = new Map<'fuel' | 'ammo', { ids: Set<number>; timer: number }>();
  private baseCacheAt = -1e9;
  private timers = new Set<number>();

  constructor(ctx: GameContext, getPlayer: () => string | null, getAllies: () => string[] = () => [], opts: AlertSourceOptions = {}) {
    this.ctx = ctx;
    this.getPlayer = getPlayer;
    this.getAllies = getAllies;
    this.now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.bind();
  }

  dispose(): void {
    for (const o of this.offs) o();
    this.offs.length = 0;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  // ------------------------------------------------------------------ Hilfen

  private team(a3: string): boolean {
    const p = this.getPlayer();
    return !!p && (a3 === p || this.getAllies().includes(a3));
  }

  /** true, wenn für diesen Schlüssel noch kein Eintrag innerhalb von minMs gesendet wurde (und merkt sich den Zeitpunkt) */
  private gate(key: string, minMs: number): boolean {
    const t = this.now();
    const l = this.last.get(key);
    if (l !== undefined && t - l < minMs) return false;
    this.last.set(key, t);
    if (this.last.size > 600) for (const [k, v] of this.last) if (t - v > 120000) this.last.delete(k);
    return true;
  }

  private emit(a3: string, kind: Kind, text: string, x?: number, z?: number): void {
    bus.emit('alert', x === undefined || z === undefined ? { a3, kind, text } : { a3, kind, text, x, z });
  }

  private nation(a3: string): string {
    return this.ctx.geo.countriesByA3.get(a3)?.name ?? a3;
  }

  /** 'nahe Stadt (x|z)' bzw. Koordinaten */
  private where(x: number, z: number): string {
    let best = '', bd = 30;
    for (const c of this.ctx.geo.meta.cities) {
      const d = Math.hypot(c.pos[0] - x, c.pos[1] - z);
      if (d < bd) { bd = d; best = c.name; }
    }
    const co = `${Math.round(x)}|${Math.round(z)}`;
    return best ? `${best} (${co})` : `(${co})`;
  }

  private cell(x: number, z: number): number {
    return Math.floor(x / CELL_KM) * 4096 + Math.floor(z / CELL_KM);
  }

  private refreshBases(): void {
    const t = this.now();
    if (t - this.baseCacheAt < 2000) return;
    this.baseCacheAt = t;
    this.baseCache.clear();
    for (const b of this.ctx.economy.bases.values()) this.baseCache.set(b.id, { x: b.x, z: b.z, name: b.name ?? b.kind, owner: b.owner });
  }

  private later(fn: () => void, ms: number): number {
    const h = window.setTimeout(() => { this.timers.delete(h); fn(); }, ms);
    this.timers.add(h);
    return h;
  }

  // ------------------------------------------------------------------ Ereignisse

  private bind(): void {
    const on = <K extends keyof GameEvents>(k: K, fn: (e: GameEvents[K]) => void) => this.offs.push(bus.on(k, fn));
    const { economy, units } = this.ctx;

    // Konvois: Position über den zerstörten Tankwagen (unit:killed kommt vor/nach convoy:lost -> Mikrotask)
    on('unit:killed', (e) => {
      if (e.typeId === 'tanker_truck' || e.typeId === 'supply_truck') this.tankers.set(e.owner, { x: e.x, z: e.z, t: this.now() });
      if (!this.team(e.owner) || e.category === 'support' || e.category === 'drone') return;
      if (!this.gate(`kill:${this.cell(e.x, e.z)}`, 15000)) return;
      const nm = getUnitType(e.typeId)?.name ?? 'Einheit';
      this.emit(e.owner, 'danger', `Verlust: ${nm} bei ${this.where(e.x, e.z)}`, e.x, e.z);
    });
    on('convoy:lost', (e) => {
      if (!this.team(e.owner)) return;
      queueMicrotask(() => {
        const tk = this.tankers.get(e.owner);
        const pos = tk && this.now() - tk.t < 3000 ? tk : null;
        const cargo = e.cargo > 0 ? ` (${Math.round(e.cargo)} Fässer)` : '';
        const by = e.by && e.by !== e.owner ? ` durch ${this.nation(e.by)}` : '';
        this.emit(e.owner, 'danger', pos ? `Konvoi verloren bei ${this.where(pos.x, pos.z)}${cargo}${by}` : `Konvoi verloren${cargo}${by}`, pos?.x, pos?.z);
      });
    });

    on('oil:field-captured', (e) => {
      const f = economy.fields.find((q) => q.id === e.fieldId);
      if (!f) return;
      if (e.from && this.team(e.from) && !this.team(e.by)) this.emit(e.from, 'danger', `Ölfeld ${f.name} verloren an ${this.nation(e.by)}`, f.x, f.z);
      else if (this.team(e.by)) this.emit(e.by, 'info', `Ölfeld ${f.name} erobert`, f.x, f.z);
    });
    on('oil:field-damaged', (e) => {
      const f = economy.fields.find((q) => q.id === e.fieldId);
      if (!f || !f.owner || !this.team(f.owner)) return;
      if (!this.gate(`field:${f.id}`, 30000)) return;
      this.emit(f.owner, e.integrity < 0.4 ? 'danger' : 'warn', `Ölfeld ${f.name} beschädigt (${Math.round(e.integrity * 100)} %)`, f.x, f.z);
    });

    // Basen
    on('base:built', () => { this.baseCacheAt = -1e9; });
    on('base:destroyed', (e) => {
      const b = this.baseCache.get(e.baseId);
      if (!this.team(e.owner)) return;
      this.emit(e.owner, 'danger', `Basis zerstört: ${b?.name ?? 'Gebäude'}`, b?.x, b?.z);
    });
    on('combat:impact', (e) => {
      this.refreshBases();
      const t = this.now();
      for (const [id, b] of this.baseCache) {
        if (!this.team(b.owner)) continue;
        if (Math.abs(b.x - e.x) > 0.8 || Math.abs(b.z - e.z) > 0.8) continue;
        let arr = this.impacts.get(id);
        if (!arr) this.impacts.set(id, (arr = []));
        arr.push(t);
        while (arr.length && t - arr[0] > 12000) arr.shift();
        if (arr.length >= 6 && this.gate(`base:${id}`, 60000)) {
          this.emit(b.owner, 'danger', `${b.name} unter Beschuss`, b.x, b.z);
          arr.length = 0;
        }
      }
    });

    // Brücken
    on('bridge:destroyed', (e) => {
      const n = Math.floor(e.geom.length / 2);
      if (n < 1) return;
      const i = Math.floor(n / 2);
      const x = e.geom[i * 2], z = e.geom[i * 2 + 1];
      this.bridgePos.set(e.edgeId, [x, z]);
      const p = this.getPlayer();
      if (p) this.emit(p, 'warn', `Brücke gesprengt bei ${this.where(x, z)}`, x, z);
    });
    on('bridge:repaired', (e) => {
      const pos = this.bridgePos.get(e.edgeId);
      const p = this.getPlayer();
      if (p) this.emit(p, 'info', pos ? `Brücke repariert bei ${this.where(pos[0], pos[1])}` : 'Brücke repariert', pos?.[0], pos?.[1]);
    });

    // Einheiten unter Beschuss (je ~4-km-Zelle gedrosselt)
    on('unit:damaged', (e) => {
      if (e.amount <= 0) return;
      const u = units.get(e.id);
      if (!u || !this.team(u.owner) || u.type.category === 'drone') return;
      if (!this.gate(`dmg:${this.cell(u.x, u.z)}`, 25000)) return;
      this.emit(u.owner, 'warn', `Einheiten unter Beschuss bei ${this.where(u.x, u.z)}`, u.x, u.z);
    });

    // Nachschub knapp (gebündelt)
    on('supply:low', (e) => {
      const u = units.get(e.unitId);
      if (!u || !this.team(u.owner)) return;
      let b = this.supplyBatch.get(e.what);
      if (!b) {
        b = { ids: new Set(), timer: 0 };
        this.supplyBatch.set(e.what, b);
        const what = e.what;
        b.timer = this.later(() => this.flushSupply(what), 4000);
      }
      b.ids.add(e.unitId);
    });

    // Produktion
    on('production:complete', (e) => {
      if (!this.team(e.owner)) return;
      const u = units.get(e.unitId);
      const nm = getUnitType(e.typeId)?.name ?? e.typeId;
      this.emit(e.owner, 'info', `${nm} fertig`, u?.x, u?.z);
    });

    // Städte
    on('city:captured', (e) => {
      const c = this.ctx.civil.cityById?.(e.cityId);
      if (!c) return;
      if (this.team(e.by)) this.emit(e.by, 'info', `Stadt ${c.name} erobert`, c.x, c.z);
      else if (e.from && this.team(e.from)) this.emit(e.from, 'danger', `Stadt ${c.name} verloren an ${this.nation(e.by)}`, c.x, c.z);
    });
    on('city:unrest', (e) => {
      const c = this.ctx.civil.cityById?.(e.cityId);
      if (!c || !this.team(c.controller) || e.level < 0.5) return;
      if (!this.gate(`unrest:${e.cityId}`, 120000)) return;
      this.emit(c.controller, 'warn', `Unruhen in ${c.name}`, c.x, c.z);
    });
    on('city:uprising', (e) => {
      const c = this.ctx.civil.cityById?.(e.cityId);
      if (!c || !this.team(e.against)) return;
      this.emit(e.against, 'danger', `Aufstand in ${c.name}`, c.x, c.z);
    });

    // Politik
    on('war:declared', (e) => {
      if (this.team(e.a)) this.emit(e.a, 'danger', `Krieg gegen ${this.nation(e.b)}`);
      else if (this.team(e.b)) this.emit(e.b, 'danger', `${this.nation(e.a)} erklärt den Krieg`);
    });
    on('warcrime', (e) => {
      if (!this.gate(`wc:${e.attacker}`, 30000)) return;
      if (this.team(e.attacker)) this.emit(e.attacker, 'warn', 'Kriegsverbrechen gemeldet: Ansehen sinkt');
      else if (this.team(e.victim)) this.emit(e.victim, 'warn', `Kriegsverbrechen von ${this.nation(e.attacker)} gemeldet`);
    });

    // Missionen
    on('mission:objective', (e) => {
      const p = this.getPlayer();
      if (!p) return;
      if (e.state === 'done') this.emit(p, 'info', `Missionsziel erreicht: ${e.text}`);
      else if (e.state === 'failed') this.emit(p, 'danger', `Missionsziel gescheitert: ${e.text}`);
    });
    on('mission:ended', (e) => {
      const p = this.getPlayer();
      if (p) this.emit(p, e.result === 'victory' ? 'info' : 'danger', e.result === 'victory' ? 'Mission gewonnen' : 'Mission verloren');
    });
  }

  private flushSupply(what: 'fuel' | 'ammo'): void {
    const b = this.supplyBatch.get(what);
    this.supplyBatch.delete(what);
    if (!b) return;
    if (!this.gate(`sup:${what}`, 20000)) return;
    let n = 0, sx = 0, sz = 0, owner = '';
    for (const id of b.ids) {
      const u = this.ctx.units.get(id);
      if (!u || u.hp <= 0) continue;
      n++;
      sx += u.x;
      sz += u.z;
      owner = u.owner;
    }
    if (!n) return;
    const x = sx / n, z = sz / n;
    this.emit(owner, 'warn', `${n} ${n === 1 ? 'Einheit' : 'Einheiten'} ohne ${what === 'ammo' ? 'Munition' : 'Treibstoff'}`, x, z);
  }
}
