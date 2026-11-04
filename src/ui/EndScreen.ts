import './missions.css';
import { bus } from '../core/EventBus';
import { getMission, nextMissionId } from '../game/missions/campaign';
import type { MissionSystem } from '../game/missions/MissionSystem';
import type { MissionReport, ObjectiveState } from '../game/missions/types';

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

function dur(h: number): string {
  const m = Math.round(h * 60);
  const d = Math.floor(m / 1440), hh = Math.floor((m % 1440) / 60), mm = m % 60;
  return `${d > 0 ? `${d} T ` : ''}${hh} Std ${String(mm).padStart(2, '0')} Min`;
}

export type EndAction = 'next' | 'retry' | 'menu';

/**
 * Vollbild-Endbildschirm bei 'mission:ended': SIEG / NIEDERLAGE, Grund, Statistik, Zielübersicht und Knöpfe.
 * Lead: const end = new EndScreen(uiRoot, missions); end.onAction = (a) => …  (für 'menu' reicht location.reload();
 * ohne onAction lädt „Hauptmenü" selbst neu, die anderen Aktionen tun dann nichts).
 */
export class EndScreen {
  /** Rückgabe true = vollständig behandelt (kein automatisches location.reload() bei 'menu') */
  onAction: ((a: EndAction) => void | boolean) | null = null;

  private readonly root: HTMLElement;
  private readonly missions: MissionSystem | null;
  private el: HTMLDivElement | null = null;
  private timer = 0;

  constructor(root: HTMLElement, missions: MissionSystem | null) {
    this.root = root;
    this.missions = missions;
    bus.on('mission:ended', () => {
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => {
        const m = this.missions;
        if (m) this.showReport(m.report(), m.objectives, m.current?.skirmish ?? false);
      }, 700);
    });
  }

  get visible(): boolean {
    return !!this.el;
  }

  hide(): void {
    window.clearTimeout(this.timer);
    this.el?.remove();
    this.el = null;
  }

  /** Direkt anzeigen (auch für Tests mit Fake-Daten) */
  showReport(r: MissionReport, objectives: readonly ObjectiveState[] = [], skirmish = false): void {
    this.hide();
    const victory = r.result === 'victory';
    const def = getMission(r.missionId);
    const next = victory && !skirmish ? nextMissionId(r.missionId) : null;
    const ov = document.createElement('div');
    ov.className = `es-overlay ${victory ? 'victory' : 'defeat'}`;
    const row = (k: string, v: string, bad = false) => `<tr><td>${k}</td><td${bad ? ' class="bad"' : ''}>${v}</td></tr>`;
    const stats =
      row('Spielzeit', dur(r.elapsedHours)) +
      row('Eigene Verluste', String(r.unitsLost), r.unitsLost > 0) +
      row('Feindverluste', String(r.unitsKilled)) +
      row('Gelieferte Fässer', String(r.barrelsDelivered)) +
      row('Ölfelder gehalten', `${r.fieldsHeld} / ${r.fieldsTotal}`) +
      row('Konvois verloren', String(r.convoysLost), r.convoysLost > 0) +
      row('Konvois abgefangen', String(r.convoysRaided)) +
      row('Brücken gesprengt', String(r.bridgesBlown)) +
      row('Zivile Opfer', String(r.civilKilled), r.civilKilled > 0) +
      (r.warCrimes !== null ? row('Kriegsverbrechen', String(r.warCrimes), r.warCrimes > 0) : '');
    const tops = objectives.filter((o) => !o.parentId && (o.visible || o.status !== 'pending'));
    const objs = tops
      .map((o) => `<div class="${o.status === 'done' ? 'ok' : o.status === 'failed' ? 'no' : o.constraint ? 'ok' : o.role === 'secondary' ? 'sec' : 'no'}">${
        o.status === 'done' || (o.constraint && o.status === 'active') ? '✓' : o.status === 'failed' ? '✗' : '–'
      } ${esc(o.text)}${o.role === 'secondary' ? ' <span class="muted">(optional)</span>' : ''}</div>`)
      .join('');
    ov.innerHTML = `
      <div class="panel es-panel">
        <div class="es-title">${victory ? 'SIEG' : 'NIEDERLAGE'}</div>
        <div class="es-mission">${esc(def?.name ?? (skirmish ? 'Freies Spiel' : 'Mission'))}</div>
        <div class="es-reason">${esc(r.reason)}</div>
        <div class="es-cols">
          <div><div class="es-sect">Bilanz</div><table class="es-table">${stats}</table></div>
          <div><div class="es-sect">Ziele</div><div class="es-objs">${objs || '<span class="muted">–</span>'}</div></div>
        </div>
        <div class="es-buttons"></div>
      </div>`;
    const btns = ov.querySelector('.es-buttons') as HTMLElement;
    const add = (label: string, a: EndAction, primary = false) => {
      const b = document.createElement('button');
      b.className = `btn${primary ? ' btn-primary' : ''}`;
      b.textContent = label;
      b.addEventListener('click', () => this.act(a));
      btns.appendChild(b);
    };
    if (next) add('Nächste Mission ▸', 'next', true);
    add('Wiederholen', 'retry', !next);
    add('Hauptmenü', 'menu');
    this.root.appendChild(ov);
    this.el = ov;
  }

  private act(a: EndAction): void {
    const handled = this.onAction ? this.onAction(a) : undefined;
    this.hide();
    if (a === 'menu' && handled !== true) location.reload();
  }
}
