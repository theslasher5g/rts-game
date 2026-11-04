import './missions.css';
import type { Tutorial } from '../game/missions/Tutorial';

/**
 * Nicht blockierende Tutorial-Karte (oben mittig) mit Anweisung, Schrittzähler, „Weiter"/„Überspringen" und einem
 * pulsierenden Rahmen um das Ziel-Element. Nur die Karte fängt Mausklicks ab; der Rahmen hat pointer-events: none.
 * Lead: new TutorialOverlay(uiRoot, tutorial); tutorial.start() startet die Anzeige; overlay.update() pro Frame.
 */
export class TutorialOverlay {
  private readonly layer: HTMLDivElement;
  private readonly card: HTMLDivElement;
  private readonly count: HTMLSpanElement;
  private readonly body: HTMLDivElement;
  private readonly steps: HTMLDivElement;
  private readonly wait: HTMLSpanElement;
  private readonly bNext: HTMLButtonElement;
  private readonly bSkip: HTMLButtonElement;
  private readonly pulse: HTMLDivElement;
  private readonly tut: Tutorial;
  private acc = 0;

  constructor(root: HTMLElement, tutorial: Tutorial) {
    this.tut = tutorial;
    this.layer = document.createElement('div');
    this.layer.className = 'ui-layer tut-layer hidden';
    this.card = document.createElement('div');
    this.card.className = 'panel tut-card';
    const head = document.createElement('div');
    head.className = 'panel-head';
    const t = document.createElement('span');
    t.textContent = 'Grundausbildung';
    this.count = document.createElement('span');
    this.count.className = 'muted';
    const end = document.createElement('button');
    end.className = 'btn btn-sm';
    end.textContent = 'Tutorial beenden';
    end.addEventListener('click', () => this.tut.skipAll());
    head.append(t, this.count, end);
    this.body = document.createElement('div');
    this.body.className = 'tut-body';
    this.steps = document.createElement('div');
    this.steps.className = 'tut-steps';
    const foot = document.createElement('div');
    foot.className = 'tut-foot';
    this.wait = document.createElement('span');
    this.wait.className = 'tut-wait';
    this.wait.textContent = 'Warte auf deine Aktion …';
    this.bSkip = document.createElement('button');
    this.bSkip.className = 'btn btn-sm';
    this.bSkip.textContent = 'Überspringen';
    this.bSkip.addEventListener('click', () => this.tut.skip());
    this.bNext = document.createElement('button');
    this.bNext.className = 'btn btn-sm active';
    this.bNext.textContent = 'Weiter ▸';
    this.bNext.addEventListener('click', () => this.tut.next());
    foot.append(this.wait, this.bSkip, this.bNext);
    this.card.append(head, this.body, this.steps, foot);
    this.layer.appendChild(this.card);
    this.pulse = document.createElement('div');
    this.pulse.className = 'tut-pulse hidden';
    this.layer.appendChild(this.pulse);
    root.appendChild(this.layer);
    this.tut.onChange = () => this.render();
  }

  /** Karte unten links statt oben mittig (falls das HUD kollidiert) */
  setCorner(bottomLeft: boolean): void {
    this.card.classList.toggle('bl', bottomLeft);
  }

  private render(): void {
    const t = this.tut;
    const s = t.current;
    if (!s) {
      this.layer.classList.add('hidden');
      this.pulse.classList.add('hidden');
      return;
    }
    this.layer.classList.remove('hidden');
    this.count.textContent = `Schritt ${t.index + 1} / ${t.total}`;
    this.body.textContent = s.text;
    this.steps.replaceChildren();
    for (let i = 0; i < t.total; i++) {
      const b = document.createElement('i');
      if (i < t.index) b.className = 'done';
      else if (i === t.index) b.className = 'cur';
      this.steps.appendChild(b);
    }
    this.bNext.style.display = s.manual ? '' : 'none';
    this.bSkip.style.display = s.manual ? 'none' : '';
    this.wait.style.display = s.manual ? 'none' : '';
    this.place();
  }

  /** pro Frame (Positionsabgleich ~5×/s; der Tutorial-Schritt selbst wird per Tutorial.update() geprüft) */
  update(realDt: number): void {
    this.acc += realDt;
    if (this.acc < 0.2) return;
    this.acc = 0;
    if (this.tut.active) this.place();
  }

  private place(): void {
    const sel = this.tut.current?.target;
    const p = this.pulse;
    if (!sel) { p.classList.add('hidden'); return; }
    if (sel === 'canvas') {
      p.classList.remove('hidden');
      p.classList.add('frame');
      return;
    }
    p.classList.remove('frame');
    let el: Element | null = null;
    try { el = document.querySelector(sel); } catch { el = null; }
    const r = el?.getBoundingClientRect();
    if (!r || r.width < 2 || r.height < 2 || (el as HTMLElement).offsetParent === null && getComputedStyle(el as HTMLElement).position !== 'fixed') {
      p.classList.add('hidden');
      return;
    }
    p.classList.remove('hidden');
    p.style.left = `${r.left - 3}px`;
    p.style.top = `${r.top - 3}px`;
    p.style.width = `${r.width + 6}px`;
    p.style.height = `${r.height + 6}px`;
  }
}
