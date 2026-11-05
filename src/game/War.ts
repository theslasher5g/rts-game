import { bus } from '../core/EventBus';
import type { WarQuery } from '../combat/types';

/**
 * Kriegszustand zwischen Ländern (Phase 3: einfache Paarliste; Phase 7 ergänzt Casus Belli, Bündnisfall, Diplomatie).
 * Eigene Einheiten und Einheiten von Nicht-Kriegsparteien werden nie beschossen.
 */
export class War implements WarQuery {
  private readonly pairs = new Set<string>();

  private key(a: string, b: string) {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  /** Waffenstillstand (Grenzschutz zu Spielbeginn): solange er gilt, ist niemand feindlich – es wird nicht gekämpft. */
  ceasefire = false;

  isHostile(a: string, b: string): boolean {
    return !this.ceasefire && a !== b && this.pairs.has(this.key(a, b));
  }

  /** Alle Kriegspaare (a3, a3), unabhängig vom Waffenstillstand */
  listPairs(): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (const k of this.pairs) {
      const [x, y] = k.split('|');
      out.push([x, y]);
    }
    return out;
  }

  declare(a: string, b: string): void {
    if (a === b || this.pairs.has(this.key(a, b))) return;
    this.pairs.add(this.key(a, b));
    bus.emit('war:declared', { a, b });
  }

  makePeace(a: string, b: string): void {
    this.pairs.delete(this.key(a, b));
  }

  /** Alle Gegner von a */
  enemiesOf(a: string): string[] {
    const out: string[] = [];
    for (const k of this.pairs) {
      const [x, y] = k.split('|');
      if (x === a) out.push(y);
      else if (y === a) out.push(x);
    }
    return out;
  }

  clear(): void {
    this.pairs.clear();
  }
}
