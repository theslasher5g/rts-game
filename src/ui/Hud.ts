import { bus } from '../core/EventBus';
import { blocOf, getProfile, getRelation, relationClass, relationLabel } from '../game/countryData';
import type { GameState } from '../game/GameState';
import { SPEED_LABELS } from '../game/GameState';
import type { GeoData } from '../world/GeoData';
import { SettingsPanel } from './SettingsPanel';

const MONTHS = ['Jan.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sep.', 'Okt.', 'Nov.', 'Dez.'];
const REFRESH_INTERVAL = 0.25;

interface TabInfo {
  id: string;
  title: string;
  el: HTMLElement;
  btn: HTMLButtonElement;
  onToggle?: (open: boolean) => void;
}

const OIL_ICON = '<svg viewBox="0 0 16 20" width="16" height="20" aria-hidden="true"><path d="M8 1 C8 1 2 8.5 2 12.5 A6 6 0 0 0 14 12.5 C14 8.5 8 1 8 1 Z" fill="#14110c" stroke="#e3a534" stroke-width="1.4"/><path d="M5.2 12.2 A3 3 0 0 0 8 15.2" fill="none" stroke="#e3a534" stroke-width="1.2" stroke-linecap="round"/></svg>';

/**
 * In-Game-HUD (Phase 5): Kopfleiste (Nation, Datum, Geschwindigkeit, Zufriedenheit), Ölanzeige (einzige Währung),
 * Slot `#hud-supply` für Versorgungsübersicht, Infopanel unten rechts, Reiter rechts (`registerTab`) und Pause-Menü.
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
  private readonly oilBar: HTMLDivElement;
  private readonly oilVal: HTMLElement;
  private readonly oilIncome: HTMLElement;
  private readonly oilSpend: HTMLElement;
  private readonly oilTransit: HTMLElement;
  private lastOil = '';
  /** Von außen gesetzter Info-Override (Ölfeld, Stadt, Basis …) */
  private entityInfo: { title: string; rows: Array<[string, string]> } | null = null;
  private readonly info: HTMLDivElement;
  private readonly infoBody: HTMLDivElement;
  private readonly infoMode: HTMLSpanElement;
  private readonly drawer: HTMLDivElement;
  private readonly drawerTitle: HTMLSpanElement;
  private readonly drawerBody: HTMLDivElement;
  private readonly tabs = new Map<string, TabInfo>();
  private readonly tabsEl: HTMLDivElement;
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
      b.title = i === 0 ? 'Pause (Leertaste)' : `Zeitraffer ${SPEED_LABELS[i]} (Tasten + / −)`;
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

    // Ölleiste (einzige Währung) + Slot für Nachschubübersicht
    this.oilBar = div('panel hud-oil');
    const oilMain = div('oil-main');
    oilMain.title = 'Öl ist die einzige Währung: Produktion und Nachschub kosten Fässer. Konvois liefern über das Straßennetz.';
    const ic = span('oil-ic');
    ic.innerHTML = OIL_ICON;
    const ov = div('oil-vals');
    ov.append(span('oil-k', 'ÖL · FÄSSER'));
    this.oilVal = span('oil-v', '—');
    ov.appendChild(this.oilVal);
    oilMain.append(ic, ov);
    const oilFlow = div('oil-flow');
    this.oilIncome = span('oil-inc pos', '+0/h');
    this.oilIncome.title = 'Einnahmen pro Spielstunde (angelieferte Fässer)';
    this.oilSpend = span('oil-spd neg', '−0/h');
    this.oilSpend.title = 'Ausgaben pro Spielstunde (Produktion, Nachschub)';
    this.oilTransit = span('oil-trn', '⛟ 0 unterwegs');
    this.oilTransit.title = 'Fässer in Tankwagen-Konvois auf dem Weg zur Raffinerie';
    oilFlow.append(this.oilIncome, this.oilSpend, this.oilTransit);
    const supply = div('hud-supply');
    supply.id = 'hud-supply';
    this.oilBar.append(oilMain, oilFlow, supply);
    top.append(bar, this.oilBar);

    // ---------- Reiter rechts (Inhalte liefern andere Module per registerTab)
    this.tabsEl = div('hud-tabs');
    const tabs = this.tabsEl;
    this.drawer = div('panel hud-drawer hidden');
    const dh = div('panel-head');
    this.drawerTitle = span('', '');
    const dx = button('✕', 'btn btn-sm');
    dx.addEventListener('click', () => this.toggleTab(null));
    dh.append(this.drawerTitle, dx);
    this.drawerBody = div('drawer-body scroll');
    this.drawer.append(dh, this.drawerBody);
    this.registerTab('production', 'Produktion', Object.assign(div('hud-tab-content'), { id: 'hud-tab-production' }));
    this.registerTab('supply', 'Nachschub', Object.assign(div('hud-tab-content'), { id: 'hud-tab-supply' }));

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

  /** Liefert true, wenn Esc anderweitig verbraucht wird (z. B. Einheitenauswahl aktiv) */
  escapeGuard: (() => boolean) | null = null;

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
      this.govEl.textContent = p ? `${p.government} · ${blocName(p.bloc)} · ${p.leaderTitle}` : '';
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

    // Öl
    const o = st.oil;
    const key = `${Math.floor(o.barrels)}|${Math.round(o.incomePerHour * 10)}|${Math.round(o.spendPerHour * 10)}|${Math.round(o.inTransit)}`;
    if (key !== this.lastOil) {
      this.lastOil = key;
      this.oilVal.textContent = fmtNum(Math.floor(o.barrels), 0);
      this.oilIncome.textContent = `▲ +${fmtCompact(o.incomePerHour)}/h`;
      this.oilIncome.className = `oil-inc ${o.incomePerHour > 0 ? 'pos' : 'muted'}`;
      this.oilSpend.textContent = `▼ −${fmtCompact(o.spendPerHour)}/h`;
      this.oilSpend.className = `oil-spd ${o.spendPerHour > 0 ? 'neg' : 'muted'}`;
      this.oilTransit.textContent = `⛟ ${fmtCompact(o.inTransit)} unterwegs`;
      this.oilBar.classList.toggle('low', o.barrels < 50 || (o.spendPerHour > o.incomePerHour && o.barrels < (o.spendPerHour - o.incomePerHour) * 6));
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
      // Phase 2: Esc hebt zuerst eine Einheitenauswahl auf (SelectionController), erst dann Pausemenü
      if (!paused && !this.openTab && this.escapeGuard?.()) return;
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
    // Phase 2: Ziffern gehören den Kontrollgruppen – Tempo über +/- bzw. Numpad +/-
    if (e.key === '+' || e.code === 'NumpadAdd') {
      e.preventDefault();
      this.setSpeed(Math.min(5, Math.max(1, this.state.speed + 1)));
    } else if (e.key === '-' || e.code === 'NumpadSubtract') {
      e.preventDefault();
      if (this.state.speed > 1) this.setSpeed(this.state.speed - 1);
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

  /**
   * Meldet einen Reiter am rechten Rand an. Existiert die ID schon (z. B. 'production', 'supply'), wird der Inhalt
   * des vorhandenen Containers durch `el` ersetzt. `onToggle` meldet Öffnen/Schließen.
   */
  registerTab(id: string, label: string, el: HTMLElement, onToggle?: (open: boolean) => void): void {
    const ex = this.tabs.get(id);
    if (ex) {
      if (ex.el !== el) {
        ex.el.replaceChildren(el);
        if (!el.id) el.id = `${ex.el.id}-inner`;
      }
      ex.btn.textContent = label;
      ex.title = label;
      if (onToggle) ex.onToggle = onToggle;
      return;
    }
    const btn = button(label, 'btn');
    btn.addEventListener('click', () => this.toggleTab(id));
    el.classList.add('hud-tab-pane');
    el.hidden = true;
    this.drawerBody.appendChild(el);
    this.tabsEl.appendChild(btn);
    this.tabs.set(id, { id, title: label, el, btn, onToggle });
  }

  /** Setzt/entfernt die Detailanzeige im Infopanel (Ölfeld, Stadt, Basis …); null = zurück zur Länderanzeige */
  setEntityInfo(title: string | null, rows: Array<[string, string]> = []): void {
    this.entityInfo = title ? { title, rows } : null;
    this.shownInfoId = -1;
    this.infoDirty = true;
  }

  private toggleTab(id: string | null): void {
    const next = id === this.openTab ? null : id;
    const prev = this.openTab;
    this.openTab = next;
    this.tabs.forEach((t, k) => {
      t.btn.classList.toggle('active', k === next);
      t.el.hidden = k !== next;
    });
    if (prev && prev !== next) this.tabs.get(prev)?.onToggle?.(false);
    const tab = next ? this.tabs.get(next) : undefined;
    if (!tab) {
      this.drawer.classList.add('hidden');
      return;
    }
    this.drawerTitle.textContent = tab.title;
    this.drawer.classList.remove('hidden');
    tab.onToggle?.(true);
  }

  private renderInfo(): void {
    this.infoDirty = false;
    const b = this.infoBody;
    if (this.entityInfo) {
      this.infoMode.textContent = 'OBJEKT';
      this.shownInfoId = -2;
      b.replaceChildren();
      b.appendChild(div('hi-name', this.entityInfo.title));
      const kv = div('kv');
      for (const [k, v] of this.entityInfo.rows) kv.append(span('', k), span('', v));
      b.appendChild(kv);
      return;
    }
    const id = this.hoverId || this.selectedId;
    const mode = this.hoverId ? 'ZEIGER' : this.selectedId ? 'AUSWAHL' : '';
    this.infoMode.textContent = mode;
    if (id === this.shownInfoId) return;
    this.shownInfoId = id;
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
    blocEl.appendChild(span(`tag tag-${bloc}`, blocName(bloc)));
    kv.append(span('', 'Bündnis'), blocEl);
    const pop = p ? p.population : c.population / 1e6;
    kv.append(span('', 'Bevölkerung'), span('', pop > 0 ? `${fmtNum(pop, 1)} Mio.` : '—'));
    if (p) {
      kv.append(span('', 'Regierung'), span('', p.government), span('', 'Hauptstadt'), span('', p.capital));
    }
    const fields = this.geo.meta.scenario?.oilFields.filter((f) => f.country === c.a3) ?? [];
    if (fields.length) {
      const out = fields.reduce((s, f) => s + f.output, 0);
      kv.append(span('', 'Ölfelder'), span('', `${fields.length} · ${fmtNum(out, 0)} Fässer/h`));
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

function blocName(b: string): string {
  return b === 'BUND' ? 'Bündnis' : b === 'PAKT' ? 'Kronland-Pakt' : 'Neutral';
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
