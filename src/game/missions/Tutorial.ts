/**
 * Geführtes Tutorial (Mission 1): Schrittfolge, die auf Aktionen des Spielers wartet.
 * Erkennung über Bus-Ereignisse ('units:selection', 'structure:added', 'oil:delivered', 'production:started' …)
 * und leichtes Polling von ctx/Auswahl/Kamera. Jeder Schritt hat deutschen Text, ein CSS-Selektor-Ziel zum Hervorheben
 * sowie „Weiter"/„Überspringen". Anzeige: src/ui/TutorialOverlay.ts.
 */
import { bus } from '../../core/EventBus';
import type { GameContext } from '../context';

export interface TutorialDeps {
  ctx: GameContext;
  /** aktueller Kameraabstand (z. B. () => rts.distance) */
  getCameraDistance: () => number;
  /** optional: Auswahl direkt abfragen (sonst aus 'units:selection') */
  getSelectedIds?: () => number[];
  /** optional: ist der Reiter ('production' | 'supply') im HUD offen? Sonst Klick-Erkennung per DOM */
  isTabOpen?: (id: 'production' | 'supply') => boolean;
  /** optional: existiert eine Kontrollgruppe? Sonst Strg+Ziffer-Erkennung per Tastatur */
  hasControlGroup?: () => boolean;
}

export interface TutorialStep {
  id: string;
  /** Anweisung (deutsch) */
  text: string;
  /** CSS-Selektor des zu pulsierenden UI-Elements (oder 'canvas' für einen Rahmen um die Karte) */
  target?: string;
  /** true: kein Spieler-Ereignis, nur „Weiter" */
  manual?: boolean;
}

interface StepImpl extends TutorialStep {
  /** wird beim Betreten des Schritts aufgerufen */
  enter?(t: Tutorial): void;
  /** Polling: true = erledigt */
  poll?(t: Tutorial): boolean;
}

type Flag = 'delivered' | 'production' | 'structure' | 'tabSupply' | 'group';

export class Tutorial {
  readonly steps: StepImpl[];
  index = -1;
  active = false;
  finished = false;
  /** Änderungsmeldung für die UI */
  onChange: (() => void) | null = null;
  /** wird nach Abschluss/Abbruch aufgerufen (Lead: Tutorial-Overlay ausblenden) */
  onEnd: ((completed: boolean) => void) | null = null;

  private readonly d: TutorialDeps;
  private readonly flags = new Set<Flag>();
  private sel: number[] = [];
  private offs: Array<() => void> = [];
  private acc = 0;
  private startCam = 0;
  private startPos = new Map<number, [number, number]>();
  private readonly a3: () => string;

  constructor(deps: TutorialDeps) {
    this.d = deps;
    this.a3 = () => deps.ctx.player() ?? deps.ctx.state.playerA3 ?? '';
    this.steps = this.buildSteps();
  }

  get total(): number {
    return this.steps.length;
  }

  get current(): TutorialStep | null {
    return this.active && this.index >= 0 && this.index < this.steps.length ? this.steps[this.index] : null;
  }

  // ------------------------------------------------------------------ Ablauf

  start(): void {
    this.stop(false);
    this.active = true;
    this.finished = false;
    this.flags.clear();
    this.sel = [];
    this.offs.push(
      bus.on('units:selection', ({ ids }) => { this.sel = ids; }),
      bus.on('structure:added', (e) => { if (e.owner === this.a3()) this.flags.add('structure'); }),
      bus.on('bridge:destroyed', () => { if (this.current?.id === 'build') this.flags.add('structure'); }),
      bus.on('bridge:repaired', () => { if (this.current?.id === 'build') this.flags.add('structure'); }),
      bus.on('oil:delivered', (e) => { if (e.owner === this.a3()) this.flags.add('delivered'); }),
      bus.on('production:started', (e) => { if (e.owner === this.a3()) this.flags.add('production'); }),
    );
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && /^Digit[1-9]$/.test(e.code)) this.flags.add('group');
    };
    const onClick = (e: MouseEvent) => {
      const b = (e.target as HTMLElement | null)?.closest?.('button');
      if (b && b.textContent?.trim() === 'Nachschub') this.flags.add('tabSupply');
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('click', onClick, true);
    this.offs.push(() => window.removeEventListener('keydown', onKey, true), () => document.removeEventListener('click', onClick, true));
    this.goto(0);
  }

  stop(completed = false): void {
    for (const o of this.offs) o();
    this.offs.length = 0;
    const was = this.active;
    this.active = false;
    if (completed) this.finished = true;
    if (was) {
      this.onChange?.();
      this.onEnd?.(completed);
    }
  }

  /** Aktuellen Schritt als erledigt werten und weiter („Weiter" / „Überspringen") */
  next(): void {
    if (!this.active) return;
    this.goto(this.index + 1);
  }

  skip(): void {
    this.next();
  }

  /** Alle weiteren Schritte überspringen */
  skipAll(): void {
    this.stop(false);
  }

  private goto(i: number): void {
    if (i >= this.steps.length) {
      bus.emit('tutorial:step', { index: this.steps.length, total: this.steps.length, text: 'Tutorial abgeschlossen.' });
      this.stop(true);
      return;
    }
    this.index = i;
    this.acc = 0;
    const s = this.steps[i];
    s.enter?.(this);
    bus.emit('tutorial:step', { index: i, total: this.steps.length, text: s.text });
    this.onChange?.();
  }

  /** pro Frame mit echtem dt (Sekunden) aufrufen */
  update(realDt: number): void {
    if (!this.active) return;
    this.acc += realDt;
    if (this.acc < 0.2) return;
    this.acc = 0;
    const s = this.steps[this.index];
    if (!s || s.manual) return;
    if (s.poll?.(this)) this.goto(this.index + 1);
  }

  // ------------------------------------------------------------------ Hilfen

  private selected(): number[] {
    return this.d.getSelectedIds ? this.d.getSelectedIds() : this.sel;
  }

  private selectedHas(pred: (cat: string, typeId: string) => boolean): boolean {
    for (const id of this.selected()) {
      const u = this.d.ctx.units.get(id);
      if (u && u.owner === this.a3() && pred(u.type.category, u.type.id)) return true;
    }
    return false;
  }

  private selectedOrder(kinds: string[]): boolean {
    for (const id of this.selected()) {
      const u = this.d.ctx.units.get(id);
      if (!u) continue;
      const k = u.orders[0]?.kind;
      if (k && kinds.includes(k)) return true;
    }
    return false;
  }

  private rememberSelectionPositions(): void {
    this.startPos.clear();
    for (const id of this.selected()) {
      const u = this.d.ctx.units.get(id);
      if (u) this.startPos.set(id, [u.x, u.z]);
    }
  }

  private selectionMoved(km: number): boolean {
    for (const [id, p] of this.startPos) {
      const u = this.d.ctx.units.get(id);
      if (u && Math.hypot(u.x - p[0], u.z - p[1]) > km) return true;
    }
    return false;
  }

  private buildSteps(): StepImpl[] {
    return [
      {
        id: 'welcome', manual: true, target: '.hud-oil',
        text: 'Willkommen, Kommandeur. Öl ist deine einzige Währung: Fässer bezahlen Einheiten und Nachschub. Ich zeige dir kurz die wichtigsten Handgriffe.',
      },
      {
        id: 'select', target: 'canvas',
        text: 'Wähle einen Panzer: Linksklick auf die Einheit oder mit gedrückter Maustaste einen Rahmen aufziehen.',
        poll: (t) => t.selectedHas((c) => c === 'tank' || c === 'ifv' || c === 'recon'),
      },
      {
        id: 'move', target: 'canvas',
        text: 'Rechtsklick auf die Karte: Die ausgewählte Einheit fährt dorthin. Shift hängt weitere Wegpunkte an.',
        enter: (t) => t.rememberSelectionPositions(),
        poll: (t) => t.selectedOrder(['move']) || t.selectionMoved(0.4),
      },
      {
        id: 'attackmove', target: '.up-orders',
        text: 'Angriffsbewegung: Drücke G und klicke aufs Ziel (oder Strg+Rechtsklick). Die Einheit bekämpft Feinde unterwegs. T hält an, Y hält die Stellung.',
        poll: (t) => t.selectedOrder(['attackMove']),
      },
      {
        id: 'engineers', target: 'canvas',
        text: 'Pioniere bauen und sprengen. Wähle einen Pioniertrupp (Pi).',
        poll: (t) => t.selectedHas((_c, id) => id === 'engineer_squad'),
      },
      {
        id: 'build', target: '.up-cmd',
        text: 'Drücke C (Bauen) und platziere einen Graben oder Sandsäcke – oder sprenge (J) bzw. repariere (L) eine Brücke.',
        poll: (t) => t.flags.has('structure'),
      },
      {
        id: 'oil', manual: true, target: '.hud-oil',
        text: 'Oben links: dein Ölguthaben, die Einnahmen pro Stunde und das Öl, das auf Tankwagen unterwegs ist. Nur was die Raffinerie erreicht, zählt.',
      },
      {
        id: 'delivery', target: '.hud-speed',
        text: 'Tankwagen holen Öl von deinen Feldern und fahren über die Straßen zur Raffinerie. Warte auf die erste Lieferung – mit + erhöhst du das Tempo, Leertaste pausiert.',
        enter: (t) => t.flags.delete('delivered'),
        poll: (t) => t.flags.has('delivered'),
      },
      {
        id: 'production', target: '.hud-tabs .btn:nth-child(1)',
        text: 'Öffne den Reiter „Produktion" rechts oben, wähle eine Basis und stelle eine Einheit in die Warteschlange. Das kostet Fässer.',
        poll: (t) => t.flags.has('production'),
      },
      {
        id: 'supply', target: '.hud-tabs .btn:nth-child(2)',
        text: 'Im Reiter „Nachschub" siehst du Konvois, Ölfelder und die Versorgung deiner Einheiten. Öffne ihn.',
        poll: (t) => t.flags.has('tabSupply') || (t.d.isTabOpen?.('supply') ?? false),
      },
      {
        id: 'zoom', target: 'canvas',
        text: 'Kamera: Mausrad zoomt, WASD oder Bildschirmrand scrollt, Q/E dreht. Zoome jetzt ein Stück hinein oder heraus.',
        enter: (t) => { t.startCam = t.d.getCameraDistance(); },
        poll: (t) => {
          const d = t.d.getCameraDistance();
          return t.startCam > 0 && d > 0 && Math.abs(Math.log(d / t.startCam)) > 0.2;
        },
      },
      {
        id: 'group', target: '.up-groups',
        text: 'Kontrollgruppen: Wähle Einheiten und drücke Strg+1 (bis 9). Danach reicht die Ziffer, um sie wieder auszuwählen.',
        poll: (t) => t.flags.has('group') || (t.d.hasControlGroup?.() ?? false),
      },
      {
        id: 'done', manual: true,
        text: 'Das war die Grundausbildung. Dein Auftrag: bringe 400 Fässer zur Raffinerie. Der Feind hält still, bis du fertig bist – nimm dir Zeit.',
      },
    ];
  }
}
