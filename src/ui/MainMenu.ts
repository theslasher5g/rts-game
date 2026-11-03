import { bus } from '../core/EventBus';
import type { CountryMeta } from '../core/types';
import {
  EXTERNAL_NAMES, getProfile, relationClass, relationLabel, RESOURCE_INFO, START_PROFILES, type StartProfile,
} from '../game/countryData';
import type { GeoData } from '../world/GeoData';
import { SettingsPanel } from './SettingsPanel';

/**
 * Startbildschirm über der laufenden 3D-Karte: Länderliste links, Details rechts.
 */
export class MainMenu {
  private readonly geo: GeoData;
  private readonly layer: HTMLDivElement;
  private readonly detail: HTMLDivElement;
  private readonly startBtn: HTMLButtonElement;
  private readonly hint: HTMLDivElement;
  private readonly items = new Map<string, HTMLDivElement>();
  private selectedA3: string | null = null;
  private isVisible = false;

  constructor(root: HTMLElement, geo: GeoData) {
    this.geo = geo;
    this.layer = div('ui-layer main-menu hidden');

    // Titel
    const title = div('mm-title');
    const h1 = document.createElement('h1');
    h1.textContent = 'WW3: EUROPE';
    title.append(h1, div('mm-sub', 'Europa, 2027. Der Frieden ist vorbei.'), div('mm-ver', 'PHASE 1 · KARTE & NATIONEN'));

    // Linke Spalte
    const left = div('panel mm-left');
    const lh = div('panel-head');
    lh.append(span('', 'Nation wählen'), span('muted', `${START_PROFILES.length} spielbar`));
    const list = div('mm-list scroll');
    const sorted = START_PROFILES.slice().sort((a, b) => a.name.localeCompare(b.name, 'de'));
    for (const p of sorted) {
      const it = div('mm-item');
      it.tabIndex = 0;
      it.setAttribute('role', 'button');
      const flag = span('flag', p.flag);
      const name = span('mm-name', p.name);
      const diff = span(`mm-diff diff-${p.difficulty}`, p.difficulty);
      const meta = div('mm-meta');
      const sw = span('swatch');
      sw.style.background = p.color;
      meta.append(sw, span(`tag tag-${p.bloc}`, p.bloc), span('muted', p.government));
      it.append(flag, name, diff, meta);
      it.addEventListener('click', () => this.pick(p.a3));
      it.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          this.pick(p.a3);
        }
      });
      this.items.set(p.a3, it);
      list.appendChild(it);
    }
    const foot = div('mm-foot');
    const setBtn = document.createElement('button');
    setBtn.className = 'btn';
    setBtn.textContent = '⚙ Einstellungen';
    setBtn.addEventListener('click', () => SettingsPanel.instance?.toggle());
    const mpBtn = document.createElement('button');
    mpBtn.className = 'btn';
    mpBtn.disabled = true;
    mpBtn.textContent = 'Multiplayer';
    foot.append(setBtn, mpBtn, div('mm-note', 'Multiplayer – folgt in Phase 9'));
    left.append(lh, list, foot);

    // Rechte Spalte
    const right = div('panel mm-right');
    const rh = div('panel-head');
    rh.append(span('', 'Lagebericht'), span('muted', 'Stand: 03/2027'));
    this.detail = div('mm-detail scroll');
    const start = div('mm-start');
    this.startBtn = document.createElement('button');
    this.startBtn.className = 'btn btn-primary';
    this.startBtn.textContent = '▶ Spiel starten';
    this.startBtn.disabled = true;
    this.startBtn.addEventListener('click', () => this.start());
    this.hint = div('mm-hint', 'Wähle eine spielbare Nation aus der Liste oder auf der Karte.');
    start.append(this.startBtn, this.hint);
    right.append(rh, this.detail, start);

    this.layer.append(title, left, right);
    root.appendChild(this.layer);
    this.renderEmpty();

    bus.on('country:select', ({ id }) => this.onSelect(id));
  }

  get visible(): boolean {
    return this.isVisible;
  }

  show(): void {
    this.layer.classList.remove('hidden');
    this.isVisible = true;
  }

  hide(): void {
    this.layer.classList.add('hidden');
    this.isVisible = false;
  }

  private pick(a3: string): void {
    const c = this.geo.countriesByA3.get(a3);
    if (!c) {
      // Land nicht im Kartenausschnitt – trotzdem anzeigen
      this.showProfile(a3, undefined);
      return;
    }
    bus.emit('country:select', { id: c.id });
    bus.emit('camera:focus', { x: c.label[0], z: c.label[1], distance: focusDistance(c) });
  }

  private start(): void {
    if (!this.selectedA3 || !getProfile(this.selectedA3)) return;
    bus.emit('game:start', { countryA3: this.selectedA3 });
    this.hide();
  }

  private onSelect(id: number): void {
    const c = this.geo.countriesById.get(id);
    if (!c) {
      this.setSelected(null);
      this.renderEmpty();
      return;
    }
    this.showProfile(c.a3, c);
  }

  private showProfile(a3: string, c: CountryMeta | undefined): void {
    const p = getProfile(a3);
    if (p) {
      this.setSelected(a3);
      this.renderProfile(p);
    } else if (c) {
      this.setSelected(null);
      this.renderAi(c);
    }
  }

  private setSelected(a3: string | null): void {
    if (this.selectedA3 && this.selectedA3 !== a3) this.items.get(this.selectedA3)?.classList.remove('active');
    this.selectedA3 = a3;
    const it = a3 ? this.items.get(a3) : undefined;
    if (it) {
      it.classList.add('active');
      it.scrollIntoView({ block: 'nearest' });
    }
    const ok = !!a3 && !!getProfile(a3);
    this.startBtn.disabled = !ok;
    const name = a3 ? getProfile(a3)?.name : undefined;
    this.hint.textContent = ok && name ? `Kommando übernehmen: ${name}` : 'Wähle eine spielbare Nation aus der Liste oder auf der Karte.';
  }

  private renderEmpty(): void {
    this.detail.replaceChildren(div('cd-empty', 'KEINE NATION GEWÄHLT\n\nWähle links eine Nation oder klicke ein Land auf der Karte an.'));
    (this.detail.firstChild as HTMLElement).style.whiteSpace = 'pre-line';
  }

  private renderAi(c: CountryMeta): void {
    const d = this.detail;
    d.replaceChildren();
    const head = div('cd-head');
    const txt = div('');
    txt.append(div('cd-name', c.name));
    const sub = div('cd-sub');
    sub.append(span('', c.nameEn), span('muted', `· ${c.a3}`));
    txt.append(sub);
    head.append(span('flag', '⚑'), txt);
    d.append(head, div('cd-ai', 'KI-Nation – nicht spielbar in Phase 1'));
    d.append(sectTitle('Eckdaten'));
    const kv = div('kv');
    addKv(kv, 'Bevölkerung', c.population > 0 ? `${fmtNum(c.population / 1e6, 1)} Mio.` : '—');
    addKv(kv, 'BIP', c.gdpMd > 0 ? `${fmtInt(c.gdpMd / 1000)} Mrd $` : '—');
    addKv(kv, 'Fläche (ca.)', `${fmtInt(c.cells * this.geo.cellKm * this.geo.cellKm)} km²`);
    d.append(kv);
  }

  private renderProfile(p: StartProfile): void {
    const d = this.detail;
    d.replaceChildren();

    // Kopf
    const head = div('cd-head');
    const txt = div('');
    txt.append(div('cd-name', p.name));
    const sub = div('cd-sub');
    const sw = span('swatch');
    sw.style.background = p.color;
    sub.append(sw, span(`tag tag-${p.bloc}`, p.bloc), span('', p.government), span('muted', `· ${p.leaderTitle}`));
    txt.append(sub);
    head.append(span('flag', p.flag), txt);
    d.append(head);

    const diffRow = div('cd-sub');
    diffRow.append(span('muted', 'Schwierigkeit:'), span(`diff-${p.difficulty}`, p.difficulty.toUpperCase()));
    d.append(diffRow);

    // Staat & Wirtschaft
    d.append(sectTitle('Staat & Wirtschaft'));
    const kv = div('kv');
    addKv(kv, 'Bevölkerung', `${fmtNum(p.population, 1)} Mio.`);
    addKv(kv, 'BIP', `${fmtInt(p.gdp)} Mrd $`);
    addKv(kv, 'BIP pro Kopf', `${fmtInt((p.gdp * 1000) / p.population)} $`);
    addKv(kv, 'Staatsschulden', `${p.debtPct} % BIP`, p.debtPct > 100 ? 'neg' : '');
    addKv(kv, 'Inflation', `${fmtNum(p.inflation, 1)} %`, p.inflation > 6 ? 'neg' : '');
    addKv(kv, 'Zufriedenheit', `${p.zufriedenheit} / 100`, p.zufriedenheit < 45 ? 'neg' : p.zufriedenheit >= 60 ? 'pos' : '');
    d.append(kv);
    const meter = div('meter');
    const mi = document.createElement('i');
    mi.style.width = `${p.zufriedenheit}%`;
    mi.style.background = p.zufriedenheit < 45 ? 'var(--bad)' : p.zufriedenheit >= 60 ? 'var(--good)' : 'var(--amber)';
    meter.appendChild(mi);
    d.append(meter);

    // Militär
    d.append(sectTitle(`Militär · ${fmtNum(p.militaryBudget, 1)} Mrd $/Jahr`));
    const mil = div('cd-mil');
    const milCell = (v: string, k: string) => {
      const c = div('');
      c.append(span('v', v), span('k', k));
      mil.appendChild(c);
    };
    milCell(`${fmtInt(p.manpower)}k`, 'Soldaten');
    milCell(fmtInt(p.tanks), 'Panzer');
    milCell(fmtInt(p.ifv), 'SPz');
    milCell(fmtInt(p.artillery), 'Artillerie');
    milCell(fmtInt(p.aircraft), 'Flugzeuge');
    milCell(fmtInt(p.helicopters), 'Hubschr.');
    milCell(fmtInt(p.ships), 'Schiffe');
    milCell(fmtInt(p.drones), 'Drohnen');
    d.append(mil);

    // Ressourcen
    d.append(sectTitle('Ressourcen pro Tag'));
    const legend = div('res-legend');
    const lp = span('');
    const lpi = document.createElement('i');
    lpi.style.background = '#7fae58';
    lp.append(lpi, document.createTextNode('Produktion'));
    const lc = span('');
    const lci = document.createElement('i');
    lci.style.background = '#c27a3a';
    lc.append(lci, document.createTextNode('Verbrauch'));
    legend.append(lp, lc);
    d.append(legend);
    for (const r of RESOURCE_INFO) {
      const prod = p.production[r.key], cons = p.consumption[r.key];
      const max = Math.max(prod, cons, 1e-9);
      const row = div('res-row');
      row.title = `${r.name}: Produktion ${fmtNum(prod, prod < 10 ? 2 : 0)} / Verbrauch ${fmtNum(cons, cons < 10 ? 2 : 0)} ${r.unit} pro Tag · Lager ${fmtNum(p.stock[r.key], 0)} ${r.unit}`;
      const name = span('res-name', `${r.icon} ${r.name}`);
      const bars = div('res-bars');
      const bp = div('bar p');
      const bpi = document.createElement('i');
      bpi.style.width = `${(prod / max) * 100}%`;
      bp.appendChild(bpi);
      const bc = div('bar c');
      const bci = document.createElement('i');
      bci.style.width = `${(cons / max) * 100}%`;
      bc.appendChild(bci);
      bars.append(bp, bc);
      const ratio = cons > 0 ? prod / cons : prod > 0 ? 99 : 1;
      let state: string, cls: string;
      if (ratio >= 1.05) { state = 'Überschuss'; cls = 'pos'; }
      else if (ratio >= 0.95) { state = 'Ausgegl.'; cls = 'muted'; }
      else if (ratio >= 0.5) { state = 'Defizit'; cls = 'amber'; }
      else { state = 'Engpass'; cls = 'neg'; }
      row.append(name, bars, span(`res-state ${cls}`, state));
      d.append(row);
    }

    // Bündnisse & Handel
    d.append(sectTitle('Verbündete'));
    d.append(chips(p.allies.map((a) => this.nameOf(a))));
    d.append(sectTitle('Handelspartner'));
    d.append(chips(p.tradePartners.map((a) => this.nameOf(a))));

    // Beziehungen
    d.append(sectTitle('Beziehungen'));
    const rel = div('rel-list');
    const entries = Object.entries(p.relations).sort((a, b) => b[1] - a[1]);
    for (const [a3, v] of entries) {
      rel.append(span('', this.nameOf(a3)), span(`rv ${relationClass(v)}`, v > 0 ? `+${v}` : String(v)), span(relationClass(v), relationLabel(v)));
    }
    d.append(rel);

    // Stärken / Schwächen
    d.append(sectTitle('Stärken'));
    d.append(bullets(p.strengths, false));
    d.append(sectTitle('Schwächen'));
    d.append(bullets(p.weaknesses, true));
    d.scrollTop = 0;
  }

  private nameOf(a3: string): string {
    return getProfile(a3)?.name ?? this.geo.countriesByA3.get(a3)?.name ?? EXTERNAL_NAMES[a3] ?? a3;
  }
}

/** Kameradistanz zum Einrahmen eines Landes */
function focusDistance(c: CountryMeta): number {
  return Math.min(4200, Math.max(450, Math.sqrt(c.cells * 4) * 2.2));
}

function sectTitle(t: string): HTMLDivElement {
  return div('sect-title', t);
}

function addKv(kv: HTMLElement, k: string, v: string, cls = ''): void {
  kv.append(span('', k), span(cls, v));
}

function chips(items: string[]): HTMLDivElement {
  const c = div('chips');
  for (const t of items) c.appendChild(span('chip', t));
  return c;
}

function bullets(items: string[], negative: boolean): HTMLUListElement {
  const ul = document.createElement('ul');
  ul.className = negative ? 'bullets neg-list' : 'bullets';
  for (const t of items) {
    const li = document.createElement('li');
    li.textContent = t;
    ul.appendChild(li);
  }
  return ul;
}

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

const NF0 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
function fmtInt(v: number): string {
  return NF0.format(Math.round(v));
}
function fmtNum(v: number, digits: number): string {
  return v.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
