import './missions.css';
import { bus } from '../core/EventBus';
import { getMission, missionList } from '../game/missions/campaign';
import type { MissionSystem } from '../game/missions/MissionSystem';
import type { ObjectiveState } from '../game/missions/types';
import { getProfile } from '../game/countryData';

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

function fmtH(h: number): string {
  const m = Math.floor(h * 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')} h`;
}

/**
 * Kompakter Zieltracker (links unter der Ölanzeige, einklappbar): Missionsname, Zeit, Haupt- und Nebenziele mit
 * Haken/Kreuz/Fortschritt. Meldet Zieländerungen (Bus 'mission:objective') zusätzlich als Toast.
 * Lead: new MissionPanel(uiRoot, missions); show() beim Missionsstart; update(dtReal) pro Frame.
 */
export class MissionPanel {
  private readonly layer: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly title: HTMLSpanElement;
  private readonly body: HTMLDivElement;
  private readonly missions: MissionSystem;
  private acc = 1;
  private sig = '';
  private collapsed = false;

  constructor(root: HTMLElement, missions: MissionSystem) {
    this.missions = missions;
    this.layer = document.createElement('div');
    this.layer.className = 'ui-layer ms-layer hidden';
    this.panel = document.createElement('div');
    this.panel.className = 'panel ms-panel';
    const head = document.createElement('div');
    head.className = 'panel-head';
    this.title = document.createElement('span');
    const tg = document.createElement('span');
    tg.className = 'ms-toggle';
    tg.textContent = '[–]';
    head.append(this.title, tg);
    head.addEventListener('click', () => {
      this.collapsed = !this.collapsed;
      this.panel.classList.toggle('collapsed', this.collapsed);
      tg.textContent = this.collapsed ? '[+]' : '[–]';
    });
    this.body = document.createElement('div');
    this.body.className = 'ms-body';
    this.panel.append(head, this.body);
    this.layer.appendChild(this.panel);
    root.appendChild(this.layer);

    bus.on('mission:started', () => { this.sig = ''; this.show(); this.refresh(); });
    bus.on('mission:objective', (e) => {
      if (e.state === 'done') bus.emit('toast', { msg: `Ziel erreicht: ${e.text}`, kind: 'info' });
      else if (e.state === 'failed') bus.emit('toast', { msg: `Ziel gescheitert: ${e.text}`, kind: 'warn' });
      else bus.emit('toast', { msg: `Neues Ziel: ${e.text}`, kind: 'info' });
    });
    bus.on('mission:ended', () => this.refresh());
  }

  show(): void {
    this.layer.classList.remove('hidden');
  }

  hide(): void {
    this.layer.classList.add('hidden');
  }

  /** Position anpassen (CSS-Pixel), falls das HUD anders belegt ist */
  setPosition(top: number, left: number): void {
    this.panel.style.setProperty('--ms-top', `${top}px`);
    this.panel.style.setProperty('--ms-left', `${left}px`);
  }

  /** pro Frame mit echtem dt (s) */
  update(realDt: number): void {
    this.acc += realDt;
    if (this.acc < 0.25) return;
    this.acc = 0;
    this.refresh();
  }

  private refresh(): void {
    const m = this.missions;
    const def = m.current;
    if (!def) { this.hide(); return; }
    // Signatur: nur neu aufbauen, wenn sich etwas Sichtbares ändert
    let sig = `${m.result}|${Math.floor(m.elapsedHours * 20)}`;
    for (const o of m.objectives) sig += `|${o.status}${o.visible ? 1 : 0}${o.detail}${Math.round(o.progress * 50)}`;
    if (sig === this.sig) return;
    this.sig = sig;
    this.title.textContent = def.name;
    const lim = def.timeLimitHours;
    const left = lim !== undefined ? lim - m.elapsedHours : Infinity;
    let h = `<div class="ms-time"><span>Zeit ${fmtH(m.elapsedHours)}</span>${lim !== undefined ? `<span class="${left < 1 ? 'warn' : ''}">Limit ${fmtH(lim)}</span>` : '<span>kein Limit</span>'}</div>`;
    if (m.result !== 'running') h += `<div class="ms-result ${m.result}">${m.result === 'victory' ? 'SIEG' : 'NIEDERLAGE'}</div>`;
    const tops = m.objectives.filter((o) => o.visible && !o.parentId);
    const prim = tops.filter((o) => o.role === 'primary');
    const sec = tops.filter((o) => o.role === 'secondary');
    h += this.group(prim, m.objectives);
    if (sec.length) h += `<div class="ms-sect">Nebenziele</div>${this.group(sec, m.objectives)}`;
    this.body.innerHTML = h;
  }

  private group(list: ObjectiveState[], all: ObjectiveState[]): string {
    let h = '';
    for (const o of list) {
      h += this.row(o, false);
      for (const c of all) if (c.parentId === o.id && c.visible) h += this.row(c, true);
    }
    return h;
  }

  private row(o: ObjectiveState, sub: boolean): string {
    const ic = o.status === 'done' ? '✓' : o.status === 'failed' ? '✗' : o.constraint ? '◆' : '☐';
    const cls = ['ms-obj', o.status, o.role, o.constraint ? 'constraint' : '', sub ? 'sub' : ''].join(' ');
    const showBar = !o.constraint && o.status !== 'failed' && o.progress > 0 && o.progress < 1;
    return `<div class="${cls}"><span class="ms-ic">${ic}</span><span class="ms-txt">${esc(o.text)}</span>` +
      (o.detail && o.status !== 'done' ? `<span class="ms-det">${esc(o.detail)}</span>` : '') +
      (showBar ? `<span class="ms-bar"><i style="width:${Math.round(o.progress * 100)}%"></i></span>` : '') + '</div>';
  }
}

/**
 * Kampagnenauswahl als Modal (vom Hauptmenü geöffnet): Missionsliste (gesperrt/offen/erledigt, Freischaltung in
 * localStorage 'ww3.campaign') mit Briefing und Startknopf.
 */
export class CampaignMenu {
  private readonly backdrop: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private readonly detail: HTMLDivElement;
  private selId = 'm1';
  /** Wird mit der Missions-Id aufgerufen, wenn der Spieler „Mission starten" wählt */
  onStart: ((missionId: string) => void) | null = null;

  constructor(root: HTMLElement) {
    this.backdrop = document.createElement('div');
    this.backdrop.className = 'modal-backdrop hidden';
    const modal = document.createElement('div');
    modal.className = 'panel modal camp-modal';
    const head = document.createElement('div');
    head.className = 'panel-head';
    const t = document.createElement('span');
    t.textContent = 'Kampagne Nordadria';
    const x = document.createElement('button');
    x.className = 'btn btn-sm';
    x.textContent = '✕';
    x.addEventListener('click', () => this.close());
    head.append(t, x);
    const body = document.createElement('div');
    body.className = 'camp-body';
    this.list = document.createElement('div');
    this.list.className = 'camp-list';
    this.detail = document.createElement('div');
    this.detail.className = 'camp-detail';
    body.append(this.list, this.detail);
    modal.append(head, body);
    this.backdrop.appendChild(modal);
    this.backdrop.addEventListener('click', (e) => { if (e.target === this.backdrop) this.close(); });
    root.appendChild(this.backdrop);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen) { e.preventDefault(); e.stopPropagation(); this.close(); }
    }, true);
  }

  get isOpen(): boolean {
    return !this.backdrop.classList.contains('hidden');
  }

  open(): void {
    const l = missionList();
    const cur = l.find((e) => e.id === this.selId);
    if (!cur || cur.state === 'locked') this.selId = (l.find((e) => e.state === 'open') ?? l[0]).id;
    this.render();
    this.backdrop.classList.remove('hidden');
  }

  close(): void {
    this.backdrop.classList.add('hidden');
  }

  private render(): void {
    const l = missionList();
    this.list.replaceChildren();
    l.forEach((e, i) => {
      const row = document.createElement('div');
      row.className = `camp-row ${e.state}${e.id === this.selId ? ' sel' : ''}`;
      row.innerHTML = `<span class="n">${i + 1}</span><span class="nm">${esc(e.name)}</span><span class="st">${e.state === 'locked' ? '🔒' : e.state === 'done' ? '✓' : '▸'}</span>`;
      row.addEventListener('click', () => {
        if (e.state === 'locked') return;
        this.selId = e.id;
        this.render();
      });
      this.list.appendChild(row);
    });
    const e = l.find((x) => x.id === this.selId) ?? l[0];
    const def = getMission(e.id);
    this.detail.replaceChildren();
    if (!def) return;
    const nation = getProfile(def.playerNation);
    const h = document.createElement('h3');
    h.textContent = def.name;
    const meta = document.createElement('div');
    meta.className = 'camp-meta';
    meta.textContent = `${nation?.flag ?? ''} ${nation?.name ?? def.playerNation} · Gegner-KI: ${def.ai.difficulty}${def.timeLimitHours ? ` · Zeitlimit ${def.timeLimitHours} h` : ''}`;
    const ul = document.createElement('ul');
    ul.className = 'camp-brief';
    for (const line of def.briefing) {
      const li = document.createElement('li');
      li.textContent = line;
      ul.appendChild(li);
    }
    const foot = document.createElement('div');
    foot.className = 'camp-foot';
    const go = document.createElement('button');
    go.className = 'btn btn-primary';
    go.textContent = '▶ Mission starten';
    go.disabled = e.state === 'locked';
    go.addEventListener('click', () => {
      this.close();
      this.onStart?.(def.id);
    });
    foot.appendChild(go);
    this.detail.append(h, meta, ul, foot);
  }
}
