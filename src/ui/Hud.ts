import { bus } from '../core/EventBus';
import { blocOf, getProfile, getRelation, relationClass, relationLabel, RESOURCE_INFO, type ResourceKey } from '../game/countryData';
import type { GameState } from '../game/GameState';
import { SPEED_LABELS } from '../game/GameState';
import type { GeoData } from '../world/GeoData';
import { SettingsPanel } from './SettingsPanel';

const MONTHS = ['Jan.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sep.', 'Okt.', 'Nov.', 'Dez.'];
const REFRESH_INTERVAL = 0.25;

const TABS: Array<{ id: string; title: string; phase: string; items: string[] }> = [
  { id: 'wirtschaft', title: 'Wirtschaft', phase: 'Phase 5', items: ['Haushalt & Steuern', 'Industrieproduktion', 'Fabriken & Infrastruktur'] },
  { id: 'handel', title: 'Handel', phase: 'Phase 6', items: ['Handelsabkommen', 'Rohstoffmärkte', 'Embargos & Sanktionen'] },
  { id: 'diplomatie', title: 'Diplomatie', phase: 'Phase 7', items: ['Bündnisse', 'Verträge', 'Kriegserklärungen'] },
  { id: 'militaer', title: 'Militär', phase: 'Phase 2–3', items: ['Einheiten & Verbände', 'Rekrutierung', 'Taktische Gefechte'] },
  { id: 'forschung', title: 'Forschung', phase: 'Phase 10', items: ['Technologiebaum', 'Rüstungsprojekte', 'Doktrinen'] },
];

interface ResCell {
  key: ResourceKey;
  root: HTMLDivElement;
  v: HTMLSpanElement;
  d: HTMLSpanElement;
  lastV: string;
  lastD: string;
}

/**
 * In-Game-HUD: Kopfleiste (Nation, Datum, Geschwindigkeit, Ressourcen),
 * Infopanel unten rechts, Platzhalter-Reiter rechts und Pause-Menü.
 * Hinweis: `update()` aktualisiert nur die Anzeige – `GameState.update()` ruft main.ts auf.
 */
export class Hud {
  private readonly geo: GeoData;
  private readonly state: GameState;
  private readonly layer: HTMLDivElement;
  private readonly flagEl: HTMLSpanElement;
  private readonly nameEl: HTMLSpanElement;
  private readonly govEl: HTMLSpanElement;
  private readonly dateEl: HTMLDivElement;
  private readonly speedBtns: HTMLButtonElement[] = [];
  private readonly zufVal: HTMLElement;
  private readonly zufBar: HTMLElement;
  private readonly res: ResCell[] = [];
  private readonly info: HTMLDivElement;
  private readonly infoBody: HTMLDivElement;
  private readonly infoMode: HTMLSpanElement;
  private readonly drawer: HTMLDivElement;
  private readonly drawerTitle: HTMLSpanElement;
  private readonly drawerBody: HTMLDivElement;
  private readonly tabBtns = new Map<string, HTMLButtonElement>();
  private readonly pauseBackdrop: HTMLDivElement;

  private isVisible = false;
  private acc = REFRESH_INTERVAL;
  private hoverId = 0;
  private selectedId = 0;
  private infoDirty = true;
  private shownInfoId = -1;
  private openTab: string | null = null;
  private lastSpeed = 1;
  private lastDate = '';
  private lastZuf = -1;
  private renderedSpeed = -1;
  private headerFor: string | null = null;
  private speedBeforePause = 1;

  constructor(root: HTMLElement, geo: GeoData, state: GameState) {
    this.geo = geo;
    this.state = state;
    this.layer = div('ui-layer hud hidden');

    // ---------- Kopfleiste
    const top = div('hud-top');
    const bar = div('panel hud-bar');
    const nation = div('hud-nation');
    this.flagEl = span('flag', '⚑');
    const nt = div('');
    this.nameEl = span('hud-cname', '—');
    this.govEl = span('hud-gov', '');
    nt.append(this.nameEl, document.createElement('br'), this.govEl);
    nation.append(this.flagEl, nt);

    const time = div('hud-time');
    this.dateEl = div('hud-date', '—');
    const speeds = div('hud-speed');
    const labels = SPEED_LABELS;
    labels.forEach((l, i) => {
      const b = button(l, 'btn');
      b.title = i === 0 ? 'Pause (Leertaste)' : `Geschwindigkeit ${i} (Taste ${i})`;
      b.addEventListener('click', () => this.setSpeed(i));
      speeds.appendChild(b);
      this.speedBtns.push(b);
    });
    time.append(this.dateEl, speeds);

    const right = div('hud-right');
    const zuf = div('hud-zuf');
    const zl = span('', 'Zufriedenheit ');
    this.zufVal = document.createElement('b');
    zl.appendChild(this.zufVal);
    const meter = div('meter');
    this.zufBar = document.createElement('i');
    meter.appendChild(this.zufBar);
    zuf.append(zl, meter);
    const menuBtn = button('☰ Menü', 'btn');
    menuBtn.title = 'Menü (Esc)';
    menuBtn.addEventListener('click', () => this.openPause());
    right.append(zuf, menuBtn);
    bar.append(nation, time, right);

    // Ressourcenleiste
    const resBar = div('panel hud-res');
    for (const r of RESOURCE_INFO) {
      const cell = div('res');
      cell.title = `${r.name} – Lagerbestand und Netto pro Tag (${r.unit})`;
      const k = span('res-k');
      k.append(span('ic', r.icon), document.createTextNode(r.short));
      const v = span('res-v', '—');
      const d = span('res-d', '');
      cell.append(k, v, d);
      resBar.appendChild(cell);
      this.res.push({ key: r.key, root: cell, v, d, lastV: '', lastD: '' });
    }
    top.append(bar, resBar);

    // ---------- Reiter rechts
    const tabs = div('hud-tabs');
    for (const t of TABS) {
      const b = button(t.title, 'btn');
      b.addEventListener('click', () => this.toggleTab(t.id));
      tabs.appendChild(b);
      this.tabBtns.set(t.id, b);
    }
    this.drawer = div('panel hud-drawer hidden');
    const dh = div('panel-head');
    this.drawerTitle = span('', '');
    const dx = button('✕', 'btn btn-sm');
    dx.addEventListener('click', () => this.toggleTab(null));
    dh.append(this.drawerTitle, dx);
    this.drawerBody = div('drawer-body scroll');
    this.drawer.append(dh, this.drawerBody);

    // ---------- Infopanel unten rechts
    this.info = div('panel hud-info');
    const ih = div('panel-head');
    this.infoMode = span('hi-mode', '');
    ih.append(span('', 'Aufklärung'), this.infoMode);
    this.infoBody = div('hud-info-body');
    this.info.append(ih, this.infoBody);

    // ---------- Pause-Menü
    this.pauseBackdrop = div('modal-backdrop hidden');
    const pm = div('panel modal pause-menu');
    const ph = div('panel-head');
    ph.append(span('', 'Pause'), span('muted', 'Spiel angehalten'));
    const pb = div('modal-body');
    const bResume = button('▶ Fortsetzen', 'btn active');
    bResume.addEventListener('click', () => this.closePause());
    const bSettings = button('⚙ Einstellungen', 'btn');
    bSettings.addEventListener('click', () => SettingsPanel.instance?.open());
    const bMain = button('⏏ Hauptmenü', 'btn');
    bMain.addEventListener('click', () => location.reload());
    pb.append(bResume, bSettings, bMain, div('mm-note', 'Hauptmenü verwirft den aktuellen Spielstand.'));
    pm.append(ph, pb);
    this.pauseBackdrop.appendChild(pm);
    this.pauseBackdrop.addEventListener('pointerdown', (e) => {
      if (e.target === this.pauseBackdrop) this.closePause();
    });

    this.layer.append(top, tabs, this.drawer, this.info, this.pauseBackdrop);
    root.appendChild(this.layer);

    // ---------- Ereignisse
    bus.on('country:select', ({ id }) => {
      this.selectedId = id;
      this.infoDirty = true;
    });
    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  show(): void {
    this.layer.classList.remove('hidden');
    this.isVisible = true;
    this.acc = REFRESH_INTERVAL;
    this.infoDirty = true;
  }

  hide(): void {
    this.layer.classList.add('hidden');
    this.isVisible = false;
  }

  setHoverInfo(id: number): void {
    if (id === this.hoverId) return;
    this.hoverId = id;
    this.infoDirty = true;
  }

  update(dt: number): void {
    if (!this.isVisible) return;
    this.acc += dt;
    if (this.acc < REFRESH_INTERVAL) return;
    this.acc = 0;
    const st = this.state;

    // Kopf (nur bei Nationswechsel)
    if (st.playerA3 !== this.headerFor) {
      this.headerFor = st.playerA3;
      const p = st.profile;
      const meta = st.playerA3 ? this.geo.countriesByA3.get(st.playerA3) : undefined;
      this.flagEl.textContent = p?.flag ?? '⚑';
      this.nameEl.textContent = p?.name ?? meta?.name ?? st.playerA3 ?? '—';
      this.govEl.textContent = p ? `${p.government} · ${p.bloc} · ${p.leaderTitle}` : '';
      this.infoDirty = true;
      this.shownInfoId = -1;
    }

    // Datum
    const date = formatDate(st.date);
    if (date !== this.lastDate) {
      this.dateEl.textContent = date;
      this.lastDate = date;
    }
    if (st.speed !== this.renderedSpeed) {
      this.renderedSpeed = st.speed;
      this.speedBtns.forEach((b, i) => b.classList.toggle('active', i === st.speed));
      this.dateEl.classList.toggle('paused', st.speed === 0);
    }

    // Zufriedenheit
    const z = Math.round(st.zufriedenheit);
    if (z !== this.lastZuf) {
      this.lastZuf = z;
      this.zufVal.textContent = `${z}%`;
      this.zufBar.style.width = `${z}%`;
      this.zufBar.style.background = z < 45 ? 'var(--bad)' : z >= 60 ? 'var(--good)' : 'var(--amber)';
    }

    // Ressourcen
    for (const c of this.res) {
      const v = fmtCompact(st.stock[c.key]);
      const dv = st.delta[c.key];
      const d = `${dv > 0 ? '+' : dv < 0 ? '−' : '±'}${fmtCompact(Math.abs(dv))}/T`;
      if (v !== c.lastV) {
        c.v.textContent = v;
        c.lastV = v;
        // Warnung, wenn Vorrat < 30 Tage
        c.root.classList.toggle('low', dv < 0 && st.stock[c.key] < -dv * 30);
      }
      if (d !== c.lastD) {
        c.d.textContent = d;
        c.d.className = `res-d ${dv > 0 ? 'pos' : dv < 0 ? 'neg' : 'muted'}`;
        c.lastD = d;
      }
    }

    if (this.infoDirty) this.renderInfo();
  }

  // ------------------------------------------------------------------ intern

  private setSpeed(s: number): void {
    const v = Math.max(0, Math.min(5, Math.round(s)));
    if (v > 0) this.lastSpeed = v;
    this.state.speed = v;
    this.acc = REFRESH_INTERVAL; // sofort neu zeichnen
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.isVisible || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (SettingsPanel.instance?.opened) return;
    const paused = !this.pauseBackdrop.classList.contains('hidden');
    if (e.key === 'Escape') {
      e.preventDefault();
      if (paused) this.closePause();
      else if (this.openTab) this.toggleTab(null);
      else this.openPause();
      return;
    }
    if (paused) return;
    if (e.code === 'Space') {
      e.preventDefault();
      this.setSpeed(this.state.speed === 0 ? this.lastSpeed : 0);
      return;
    }
    if (e.key >= '1' && e.key <= '5' && e.key.length === 1) {
      e.preventDefault();
      this.setSpeed(Number(e.key));
    }
  }

  private openPause(): void {
    if (!this.pauseBackdrop.classList.contains('hidden')) return;
    this.speedBeforePause = this.state.speed;
    this.setSpeed(0);
    this.pauseBackdrop.classList.remove('hidden');
  }

  private closePause(): void {
    this.pauseBackdrop.classList.add('hidden');
    SettingsPanel.instance?.close();
    this.setSpeed(this.speedBeforePause);
  }

  private toggleTab(id: string | null): void {
    const next = id === this.openTab ? null : id;
    this.openTab = next;
    this.tabBtns.forEach((b, k) => b.classList.toggle('active', k === next));
    const tab = TABS.find((t) => t.id === next);
    if (!tab) {
      this.drawer.classList.add('hidden');
      return;
    }
    this.drawerTitle.textContent = tab.title;
    const body = this.drawerBody;
    body.replaceChildren();
    body.append(div('muted', 'MODUL IN ENTWICKLUNG'), div('phase', `Folgt in ${tab.phase}`));
    const ul = document.createElement('ul');
    for (const it of tab.items) {
      const li = document.createElement('li');
      li.textContent = it;
      ul.appendChild(li);
    }
    body.appendChild(ul);
    this.drawer.classList.remove('hidden');
  }

  private renderInfo(): void {
    this.infoDirty = false;
    const id = this.hoverId || this.selectedId;
    const mode = this.hoverId ? 'ZEIGER' : this.selectedId ? 'AUSWAHL' : '';
    this.infoMode.textContent = mode;
    if (id === this.shownInfoId) return;
    this.shownInfoId = id;
    const b = this.infoBody;
    b.replaceChildren();
    const c = this.geo.countriesById.get(id);
    if (!c) {
      b.appendChild(div('muted', id === 0 && this.hoverId === 0 && this.selectedId === 0 ? 'Land unter dem Mauszeiger oder ausgewählt anzeigen.' : 'Offene See / internationales Gewässer'));
      return;
    }
    const p = getProfile(c.a3);
    const name = div('hi-name');
    name.append(span('flag', p?.flag ?? '⚑'), span('', c.name));
    b.appendChild(name);
    const kv = div('kv');
    const player = this.state.playerA3;
    if (player && c.a3 === player) {
      kv.append(span('', 'Status'), span('pos', 'Eigene Nation'));
    } else if (player) {
      const rel = getRelation(player, c.a3);
      kv.append(span('', 'Beziehung'), span(relationClass(rel), `${relationLabel(rel)} (${rel > 0 ? '+' : ''}${rel})`));
    }
    const bloc = blocOf(c.a3);
    const blocEl = span('');
    blocEl.appendChild(span(`tag tag-${bloc}`, bloc));
    kv.append(span('', 'Block'), blocEl);
    const pop = p ? p.population : c.population / 1e6;
    kv.append(span('', 'Bevölkerung'), span('', pop > 0 ? `${fmtNum(pop, 1)} Mio.` : '—'));
    const gdp = p ? p.gdp : c.gdpMd / 1000;
    kv.append(span('', 'BIP'), span('', gdp > 0 ? `${fmtNum(gdp, 0)} Mrd $` : '—'));
    if (p) {
      kv.append(span('', 'Regierung'), span('', p.government));
    } else {
      kv.append(span('', 'Kontrolle'), span('muted', 'KI-Nation'));
    }
    b.appendChild(kv);
  }
}

// ---------------------------------------------------------------- Hilfsfunktionen

function div(cls: string, text?: string): HTMLDivElement {
  const e = document.createElement('div');
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function span(cls: string, text?: string): HTMLSpanElement {
  const e = document.createElement('span');
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(text: string, cls: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = text;
  return b;
}

function fmtNum(v: number, digits: number): string {
  return v.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Kompakte Zahl: 0,42 · 5,2 · 120 · 1.250 · 18,4 Tsd · 1,2 Mio */
function fmtCompact(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `${fmtNum(v / 1e6, 1)} Mio`;
  if (a >= 1e4) return `${fmtNum(v / 1e3, 1)} Tsd`;
  if (a >= 100) return fmtNum(v, 0);
  if (a >= 10) return fmtNum(v, 1);
  if (a === 0) return '0';
  return fmtNum(v, 2);
}

function formatDate(d: Date): string {
  const day = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  return `${day}. ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} · ${h}:00`;
}
