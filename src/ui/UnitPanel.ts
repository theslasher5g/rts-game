import type { SelectionController } from '../control/SelectionController';
import { FORMATION_ORDER, ORDER_NAMES } from '../control/SelectionController';
import type { UnitManager } from '../units/UnitManager';
import type { Unit, UnitCategory, UnitTypeDef } from '../units/types';
import { FORMATION_NAMES } from '../units/types';
import { UNIT_TYPES } from '../units/unitTypes';
import { BUILD_CHOICES } from '../control/CombatControls';
import { START_PROFILES } from '../game/countryData';

/**
 * Phase 2 – Befehlspanel unten Mitte (zwischen Minikarte und Infopanel).
 * - Auswahl gruppiert nach Typ bzw. Detailansicht einer Einheit
 * - Formationen, Befehle (inkl. Platzhalter für Phase 3), Kontrollgruppen, Tastenhinweise
 * - Testmodus: Einheiten für den Spieler platzieren (bis Produktion in Phase 5 kommt)
 * DOM-Aktualisierung: Struktur bei Auswahländerung, Werte höchstens 4×/s.
 */

const REFRESH = 0.25;

const CATEGORY_NAMES: Record<UnitCategory, string> = {
  infantry: 'Infanterie',
  recon: 'Aufklärung',
  ifv: 'Schützenpanzer',
  tank: 'Kampfpanzer',
  artillery: 'Artillerie',
  aa: 'Flugabwehr',
  support: 'Unterstützung',
  helicopter: 'Hubschrauber',
  jet: 'Kampfflugzeuge',
  drone: 'Drohnen',
  naval: 'Marine',
};
const CATEGORY_ORDER: UnitCategory[] = ['infantry', 'recon', 'ifv', 'tank', 'artillery', 'aa', 'support', 'helicopter', 'jet', 'drone', 'naval'];

/** Verbandsbezeichnung je Kategorie [Singular, Plural] */
const ECHELON: Record<UnitCategory, [string, string]> = {
  infantry: ['Trupp', 'Trupps'],
  recon: ['Spähtrupp', 'Spähtrupps'],
  ifv: ['Zug', 'Züge'],
  tank: ['Zug', 'Züge'],
  artillery: ['Batterie', 'Batterien'],
  aa: ['Zug', 'Züge'],
  support: ['Zug', 'Züge'],
  helicopter: ['Schwarm', 'Schwärme'],
  jet: ['Rotte', 'Rotten'],
  drone: ['Schwarm', 'Schwärme'],
  naval: ['Schiff', 'Schiffe'],
};

/** Kategorie-Symbol (NATO-ähnlich, Text) */
const CATEGORY_ICON: Record<UnitCategory, string> = {
  infantry: '╳',
  recon: '◇',
  ifv: '⊠',
  tank: '⬭',
  artillery: '●',
  aa: '◠',
  support: '⚙',
  helicopter: '✣',
  jet: '✈',
  drone: '⌖',
  naval: '⚓',
};

interface DetailRefs {
  unit: Unit;
  hp: HTMLElement;
  hpBar: HTMLElement;
  fuel: HTMLElement;
  fuelBar: HTMLElement;
  ammo: HTMLElement;
  ammoBar: HTMLElement;
  morale: HTMLElement;
  moraleBar: HTMLElement;
  exp: HTMLElement;
  speed: HTMLElement;
  order: HTMLElement;
  eta: HTMLElement;
}

export class UnitPanel {
  private readonly units: UnitManager;
  private readonly ctl: SelectionController;
  private readonly layer: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly hint: HTMLDivElement;
  private readonly main: HTMLDivElement;
  private readonly headTitle: HTMLSpanElement;
  private readonly headInfo: HTMLSpanElement;
  private readonly selArea: HTMLDivElement;
  private readonly formBtns = new Map<string, HTMLButtonElement>();
  private readonly modeBtns = new Map<string, HTMLButtonElement>();
  private readonly groupBtns: HTMLButtonElement[] = [];
  private readonly groupRow: HTMLDivElement;
  private readonly spawnBtn: HTMLButtonElement;
  private readonly spawn: HTMLDivElement;
  private readonly build: HTMLDivElement;
  private readonly spawnTypeBtns = new Map<string, HTMLButtonElement>();

  private visible = false;
  private acc = REFRESH;
  private shownVersion = -1;
  private selSignature = '';
  private detail: DetailRefs | null = null;
  private tileCounts: Array<{ el: HTMLElement; typeId: string }> = [];

  constructor(root: HTMLElement, units: UnitManager, controller: SelectionController) {
    this.units = units;
    this.ctl = controller;

    this.layer = el('div', 'ui-layer ctl-layer hidden');
    this.panel = el('div', 'panel unit-panel');

    // ---------- Kompakter Hinweis (nichts ausgewählt)
    this.hint = el('div', 'up-hint');
    this.hint.append(
      el('span', 'up-hint-ic', '▸'),
      el('span', '', 'Einheiten mit Linksklick oder Rahmen auswählen · Rechtsklick: Bewegen'),
    );

    // ---------- Hauptbereich (Auswahl vorhanden)
    this.main = el('div', 'up-main hidden');
    const head = el('div', 'panel-head up-head');
    this.headTitle = el('span', '', 'Verband');
    this.headInfo = el('span', 'up-head-info', '');
    head.append(this.headTitle, this.headInfo);

    const body = el('div', 'up-body');
    this.selArea = el('div', 'up-sel scroll');

    const cmd = el('div', 'up-cmd');
    // Formationen
    const fRow = el('div', 'up-row');
    fRow.appendChild(el('span', 'up-lbl', 'Formation [F]'));
    const fBtns = el('div', 'up-btns');
    for (const f of FORMATION_ORDER) {
      const b = btn(FORMATION_NAMES[f], 'btn btn-sm');
      b.title = `Formation ${FORMATION_NAMES[f]} (F: wechseln)`;
      b.addEventListener('click', () => this.ctl.setFormation(f));
      fBtns.appendChild(b);
      this.formBtns.set(f, b);
    }
    fRow.appendChild(fBtns);

    // Befehle
    const oRow = el('div', 'up-row');
    oRow.appendChild(el('span', 'up-lbl', 'Befehle'));
    const oBtns = el('div', 'up-btns up-orders');
    const mk = (label: string, key: string, tip: string, fn: () => void, modeKey?: string) => {
      const b = btn('', 'btn btn-sm up-order');
      b.append(document.createTextNode(label), el('kbd', '', key));
      b.title = tip;
      b.addEventListener('click', fn);
      oBtns.appendChild(b);
      if (modeKey) this.modeBtns.set(modeKey, b);
      return b;
    };
    mk(ORDER_NAMES.move, 'RMT', 'Bewegen: Rechtsklick auf Karte (Shift: Wegpunkt, Rechts-Ziehen: Front & Blickrichtung) – oder hier klicken, dann Linksklick', () => this.toggleMode('move'), 'move');
    mk('Angriff', 'G', 'Angriffsbewegung (G, oder Strg+Rechtsklick): bewegen und unterwegs Feinde bekämpfen', () => this.toggleMode('attackMove'), 'attackMove');
    mk(ORDER_NAMES.reverse, 'V', 'Rückwärts fahren (V, dann Linksklick) – Front bleibt zum Feind', () => this.toggleMode('reverse'), 'reverse');
    mk(ORDER_NAMES.patrol, 'B', 'Patrouille (B, dann Linksklick; Shift: weitere Punkte)', () => this.toggleMode('patrol'), 'patrol');
    mk(ORDER_NAMES.hold, 'Y', 'Stellung halten (Y)', () => this.ctl.hold());
    mk(ORDER_NAMES.stop, 'T', 'Stopp: alle Befehle löschen (T)', () => this.ctl.stop());
    mk('Feuer', 'K', 'Feuerbefehl (K, dann Linksklick): Artillerie, Mörser, Raketenwerfer und Kampfpanzer feuern auf einen Punkt', () => this.toggleMode('fireAt'), 'fireAt');
    mk('Gebäude', 'N', 'Gebäude besetzen (N, dann Gebäude anklicken): Deckungs- und Sichtbonus', () => this.toggleMode('garrison'), 'garrison');
    mk('Räumen', 'X', 'Gebäude verlassen (X)', () => this.ctl.cc.ungarrison());
    mk('Bauen', 'C', 'Pioniere: Graben, Sandsäcke, Panzersperren, Bunker … (Palette öffnen)', () => this.toggleBuild(), 'build');
    mk('Sprengen', 'J', 'Brücke sprengen (J, dann Brücke anklicken) – Pioniere nötig', () => this.toggleMode('demolish'), 'demolish');
    mk('Reparieren', 'L', 'Brücke reparieren (L, dann Brücke anklicken) – Pioniere nötig', () => this.toggleMode('repair'), 'repair');
    const ph = btn('Eskorte', 'btn btn-sm up-order is-disabled');
    ph.title = 'Eskorte – folgt in einer späteren Phase';
    ph.setAttribute('aria-disabled', 'true');
    ph.addEventListener('click', () => this.ctl.toast('Eskorte – folgt in einer späteren Phase', 'info'));
    oBtns.appendChild(ph);
    oRow.appendChild(oBtns);
    cmd.append(fRow, oRow);

    body.append(this.selArea, cmd);
    this.main.append(head, body);

    // ---------- Fußzeile: Kontrollgruppen, Testmodus
    const foot = el('div', 'up-foot');
    this.groupRow = el('div', 'up-groups');
    this.groupRow.appendChild(el('span', 'up-lbl', 'Gruppen'));
    for (let n = 1; n <= 9; n++) {
      const b = btn('', 'btn btn-sm up-grp empty');
      b.title = `Gruppe ${n}: Klick/Taste ${n} wählen (2× Kamera) · Strg+${n} oder Rechtsklick: zuweisen · Shift+${n}: hinzufügen`;
      b.addEventListener('click', (e) => {
        if (e.ctrlKey || e.metaKey) this.ctl.assignGroup(n, false);
        else if (e.shiftKey) this.ctl.assignGroup(n, true);
        else this.ctl.recallGroup(n);
      });
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (this.ctl.hasSelection) this.ctl.assignGroup(n, false);
      });
      this.groupRow.appendChild(b);
      this.groupBtns.push(b);
    }
    const keys = el('div', 'up-keys');
    keys.textContent = 'LMT Auswahl · Shift +/− · Doppelklick Typ · Strg+A alle · RMT Bewegen · Strg+RMT Angriff · Esc Abbruch';
    this.spawnBtn = btn('+ Einheit', 'btn btn-sm up-spawn-btn');
    this.spawnBtn.title = 'Testmodus: Einheiten für die eigene Nation platzieren (bis zur Produktion in Phase 5)';
    this.spawnBtn.addEventListener('click', () => this.toggleSpawn());
    foot.append(this.groupRow, keys, this.spawnBtn);

    this.panel.append(this.hint, this.main, foot);

    // ---------- Testmodus-Panel
    this.spawn = el('div', 'panel up-spawn hidden');
    const sh = el('div', 'panel-head');
    const sx = btn('✕', 'btn btn-sm');
    sx.addEventListener('click', () => this.toggleSpawn(false));
    sh.append(el('span', '', 'Testmodus · Platzieren'), sx);
    const sb = el('div', 'up-spawn-body scroll');
    const byCat = new Map<UnitCategory, UnitTypeDef[]>();
    for (const t of Object.values(UNIT_TYPES)) {
      let arr = byCat.get(t.category);
      if (!arr) byCat.set(t.category, (arr = []));
      arr.push(t);
    }
    for (const cat of CATEGORY_ORDER) {
      const arr = byCat.get(cat);
      if (!arr || !arr.length) continue;
      sb.appendChild(el('div', 'sect-title', `${CATEGORY_ICON[cat]} ${CATEGORY_NAMES[cat]}`));
      const list = el('div', 'up-spawn-list');
      for (const t of arr) {
        const b = btn('', 'btn btn-sm up-spawn-type');
        b.append(el('b', '', t.short), el('span', '', t.name));
        b.title = `${t.name} · ${t.memberCount}× · ${fmtNum(t.cost, 0)} Mio $ – Klick, dann Linksklick auf Karte (Shift: mehrere)`;
        b.addEventListener('click', () => {
          if (this.ctl.mode === 'spawn' && this.ctl.spawnTypeId === t.id) this.ctl.cancelMode();
          else this.ctl.beginSpawn(t.id);
        });
        list.appendChild(b);
        this.spawnTypeBtns.set(t.id, b);
      }
      sb.appendChild(list);
    }
    sb.appendChild(el('div', 'mm-note', 'Platzierung nur zu Testzwecken. Rechtsklick oder Esc bricht ab.'));
    this.spawn.append(sh, sb);

    // Testwerkzeuge: Besitzer der gespawnten Einheiten + Kriegserklärung
    const tools = el('div', 'up-testtools');
    const ownerSel = document.createElement('select');
    ownerSel.className = 'btn btn-sm';
    const oOwn = document.createElement('option');
    oOwn.value = '';
    oOwn.textContent = 'Eigene Nation';
    ownerSel.appendChild(oOwn);
    for (const p of START_PROFILES) {
      const o = document.createElement('option');
      o.value = p.a3;
      o.textContent = `${p.flag} ${p.name}`;
      ownerSel.appendChild(o);
    }
    ownerSel.addEventListener('change', () => {
      this.ctl.testOwner = ownerSel.value || null;
    });
    const warBtn = btn('Krieg erklären', 'btn btn-sm');
    warBtn.title = 'Erklärt dem gewählten Besitzer den Krieg (Test, bis Diplomatie in Phase 7 kommt). Einheiten feindlicher Nationen kämpfen sofort.';
    warBtn.addEventListener('click', () => {
      const p = this.ctl.playerA3;
      const o = this.ctl.testOwner;
      if (!p || !o) return this.ctl.toast('Erst oben einen fremden Besitzer wählen', 'warn');
      this.ctl.cc.services.war?.declare(p, o);
    });
    tools.append(el('span', 'up-lbl', 'Besitzer'), ownerSel, warBtn);
    sb.prepend(tools);

    // Bau-Palette (Pioniere)
    this.build = el('div', 'panel up-build hidden');
    const bh = el('div', 'panel-head');
    const bx = btn('✕', 'btn btn-sm');
    bx.addEventListener('click', () => this.toggleBuild(false));
    bh.append(el('span', '', 'Pioniere · Bauen'), bx);
    const bb = el('div', 'up-spawn-list');
    for (const c of BUILD_CHOICES) {
      const b = btn(c.label, 'btn btn-sm up-spawn-type');
      b.title = c.tip;
      b.addEventListener('click', () => {
        this.ctl.beginBuild(c.kind);
        this.toggleBuild(false);
      });
      bb.appendChild(b);
    }
    this.build.append(bh, bb);

    this.panel.append(this.spawn, this.build);
    this.layer.appendChild(this.panel);
    root.appendChild(this.layer);

    // Buttons sollen keinen Fokus behalten (Leertaste = Pause im HUD)
    this.layer.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).closest('button')) e.preventDefault();
    });
  }

  show(): void {
    this.layer.classList.remove('hidden');
    this.visible = true;
    this.shownVersion = -1;
    this.acc = REFRESH;
  }

  hide(): void {
    this.layer.classList.add('hidden');
    this.visible = false;
    this.toggleSpawn(false);
  }

  update(dt: number): void {
    if (!this.visible) return;
    this.acc += dt;
    const v = this.ctl.version;
    const structural = v !== this.shownVersion;
    if (!structural && this.acc < REFRESH) return;
    this.acc = 0;
    if (structural) {
      this.shownVersion = v;
      this.renderStructure();
    }
    this.renderValues();
  }

  // ------------------------------------------------------------------ intern

  private toggleMode(m: 'move' | 'attackMove' | 'reverse' | 'patrol' | 'fireAt' | 'garrison' | 'demolish' | 'repair'): void {
    if (this.ctl.mode === m) this.ctl.cancelMode();
    else this.ctl.beginMode(m);
  }

  private toggleBuild(open?: boolean): void {
    const show = open ?? this.build.classList.contains('hidden');
    this.build.classList.toggle('hidden', !show);
  }

  private toggleSpawn(open?: boolean): void {
    const show = open ?? this.spawn.classList.contains('hidden');
    this.spawn.classList.toggle('hidden', !show);
    this.spawnBtn.classList.toggle('active', show);
    if (!show && this.ctl.mode === 'spawn') this.ctl.cancelMode();
  }

  private renderStructure(): void {
    const ctl = this.ctl;
    const sel = ctl.selectedUnits();
    const has = sel.length > 0;
    this.hint.classList.toggle('hidden', has);
    this.main.classList.toggle('hidden', !has);

    // Formation / Modus
    this.formBtns.forEach((b, f) => b.classList.toggle('active', f === ctl.formation));
    this.modeBtns.forEach((b, m) => b.classList.toggle('active', m === ctl.mode));
    const spawnId = ctl.mode === 'spawn' ? ctl.spawnTypeId : null;
    this.spawnTypeBtns.forEach((b, id) => b.classList.toggle('active', id === spawnId));

    // Gruppen
    for (let n = 1; n <= 9; n++) {
      const b = this.groupBtns[n - 1];
      const c = ctl.getGroup(n).length;
      b.classList.toggle('empty', c === 0);
      b.replaceChildren(el('b', '', String(n)), el('span', '', c ? String(c) : '·'));
    }

    if (!has) {
      this.detail = null;
      this.selSignature = '';
      this.tileCounts = [];
      this.selArea.replaceChildren();
      return;
    }

    // Kopf: Anzahl + Hierarchie
    const ech = new Map<string, number>();
    let members = 0;
    for (const u of sel) {
      const e = ECHELON[u.type.category] ?? ['Verband', 'Verbände'];
      ech.set(e[0] + '|' + e[1], (ech.get(e[0] + '|' + e[1]) ?? 0) + 1);
      members += u.type.memberCount;
    }
    const parts: string[] = [];
    ech.forEach((n, k) => {
      const [s, p] = k.split('|');
      parts.push(`${n} ${n === 1 ? s : p}`);
    });
    this.headTitle.textContent = sel.length === 1 ? sel[0].name || sel[0].type.name : `Verband · ${sel.length} Einheiten`;
    this.headInfo.textContent = `${parts.join(' · ')} · ${members} Fz/Mann`;

    const sig = sel
      .map((u) => u.id)
      .sort((a, b) => a - b)
      .join(',');
    if (sig === this.selSignature) return;
    this.selSignature = sig;

    if (sel.length === 1) this.renderDetail(sel[0]);
    else this.renderTiles(sel);
  }

  private renderTiles(sel: Unit[]): void {
    this.detail = null;
    const byType = new Map<string, Unit[]>();
    for (const u of sel) {
      let arr = byType.get(u.type.id);
      if (!arr) byType.set(u.type.id, (arr = []));
      arr.push(u);
    }
    const area = this.selArea;
    area.replaceChildren();
    const grid = el('div', 'up-tiles');
    this.tileCounts = [];
    const types = [...byType.entries()].sort(
      (a, b) => CATEGORY_ORDER.indexOf(a[1][0].type.category) - CATEGORY_ORDER.indexOf(b[1][0].type.category),
    );
    for (const [typeId, arr] of types) {
      const t = arr[0].type;
      const tile = btn('', 'up-tile');
      tile.title = `${t.name} – Klick: nur diese auswählen · Shift+Klick: abwählen`;
      const ic = el('span', 'up-tile-ic', CATEGORY_ICON[t.category] ?? '■');
      const lbl = el('span', 'up-tile-lbl', t.short);
      const cnt = el('span', 'up-tile-n', `×${arr.length}`);
      const hp = el('i', 'up-tile-hp');
      tile.append(ic, lbl, cnt, hp);
      tile.addEventListener('click', (e) => {
        const ids = arr.map((u) => u.id);
        if (e.shiftKey) this.ctl.deselect(ids);
        else this.ctl.select(ids);
      });
      grid.appendChild(tile);
      this.tileCounts.push({ el: hp, typeId });
    }
    area.appendChild(grid);
  }

  private renderDetail(u: Unit): void {
    this.tileCounts = [];
    const area = this.selArea;
    area.replaceChildren();
    const t = u.type;
    const top = el('div', 'up-d-top');
    top.append(el('span', 'up-d-ic', CATEGORY_ICON[t.category] ?? '■'));
    const nm = el('div', 'up-d-name');
    nm.append(el('b', '', t.name), el('span', 'muted', ` · ${t.short} · ${t.memberCount}× · ${CATEGORY_NAMES[t.category] ?? t.category}`));
    top.appendChild(nm);

    const grid = el('div', 'up-d-grid');
    const bar = (label: string): [HTMLElement, HTMLElement] => {
      const row = el('div', 'up-d-bar');
      const v = el('span', 'up-d-v', '');
      const m = el('div', 'meter');
      const i = el('i', '');
      m.appendChild(i);
      row.append(el('span', 'up-d-k', label), m, v);
      grid.appendChild(row);
      return [v, i];
    };
    const [hp, hpBar] = bar('Zustand');
    const [fuel, fuelBar] = bar('Treibst.');
    const [ammo, ammoBar] = bar('Munition');
    const [morale, moraleBar] = bar('Moral');

    const kv = el('div', 'kv up-d-kv');
    const exp = el('span', '', '');
    const speed = el('span', '', '');
    const order = el('span', 'amber', '');
    const eta = el('span', '', '');
    kv.append(el('span', '', 'Erfahrung'), exp, el('span', '', 'Tempo'), speed, el('span', '', 'Befehl'), order, el('span', '', 'Ankunft'), eta);

    const cols = el('div', 'up-d-cols');
    cols.append(grid, kv);
    area.append(top, cols);
    this.detail = { unit: u, hp, hpBar, fuel, fuelBar, ammo, ammoBar, morale, moraleBar, exp, speed, order, eta };
  }

  private renderValues(): void {
    const d = this.detail;
    if (d) {
      const u = this.units.get(d.unit.id);
      if (!u) return;
      const t = u.type;
      setBar(d.hp, d.hpBar, u.hp, t.hp, `${Math.max(0, Math.round(u.hp))}/${t.hp}`);
      if (Number.isFinite(t.fuelKm)) setBar(d.fuel, d.fuelBar, u.fuel, t.fuelKm, `${Math.round(u.fuel)} km`);
      else setBar(d.fuel, d.fuelBar, 1, 1, '∞');
      setBar(d.ammo, d.ammoBar, u.ammo, t.ammo, `${Math.round(u.ammo)}/${t.ammo}`);
      setBar(d.morale, d.moraleBar, u.morale, 1, `${Math.round(u.morale * 100)}%`);
      setText(d.exp, expLabel(u.experience));
      setText(d.speed, `${Math.round(u.speedKmh)} km/h`);
      setText(d.order, orderLabel(u));
      setText(d.eta, etaLabel(u));
      return;
    }
    if (this.tileCounts.length) {
      // Mittlerer Zustand je Typ als Balken
      const sel = this.ctl.selectedUnits();
      for (const tc of this.tileCounts) {
        let s = 0, n = 0;
        for (const u of sel) {
          if (u.type.id !== tc.typeId) continue;
          s += u.type.hp > 0 ? u.hp / u.type.hp : 0;
          n++;
        }
        const f = n ? s / n : 0;
        tc.el.style.width = `${Math.round(f * 100)}%`;
        tc.el.style.background = barColor(f);
      }
    }
  }
}

// ---------------------------------------------------------------- Hilfsfunktionen

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function btn(text: string, cls: string): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  b.tabIndex = -1;
  return b;
}

function setText(e: HTMLElement, s: string): void {
  if (e.textContent !== s) e.textContent = s;
}

function barColor(f: number): string {
  return f < 0.3 ? 'var(--bad)' : f < 0.6 ? 'var(--warn)' : 'var(--good)';
}

function setBar(v: HTMLElement, bar: HTMLElement, val: number, max: number, text: string): void {
  const f = max > 0 ? Math.max(0, Math.min(1, val / max)) : 0;
  setText(v, text);
  const w = `${Math.round(f * 100)}%`;
  if (bar.style.width !== w) {
    bar.style.width = w;
    bar.style.background = barColor(f);
  }
}

function fmtNum(v: number, digits: number): string {
  return v.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function expLabel(x: number): string {
  const ranks = ['Rekrut', 'Ausgebildet', 'Erfahren', 'Veteran', 'Elite'];
  const i = Math.max(0, Math.min(ranks.length - 1, Math.floor(x * ranks.length)));
  return `${ranks[i]} (${Math.round(x * 100)}%)`;
}

function orderLabel(u: Unit): string {
  if (u.stance === 'hold' && !u.orders.length) return 'Stellung halten';
  if (!u.orders.length) return 'Bereit';
  const o = u.orders[0];
  let s = ORDER_NAMES[o.kind] ?? o.kind;
  if (!u.route && o.kind !== 'hold' && o.kind !== 'stop' && o.kind !== 'defend') s += u.routePending ? ' (Wegsuche…)' : ' (kein Weg)';
  if (u.orders.length > 1) s += ` +${u.orders.length - 1}`;
  return s;
}

function etaLabel(u: Unit): string {
  const r = u.route;
  if (!r || !u.orders.length || r.lengthKm <= 0) return '—';
  const rem = Math.max(0, 1 - u.routeKm / r.lengthKm);
  const h = r.etaHours * rem;
  const km = Math.max(0, r.lengthKm - u.routeKm);
  return `${fmtHours(h)} · ${km < 10 ? fmtNum(km, 1) : fmtNum(km, 0)} km`;
}

/** Spielzeit-Dauer: 12 min · 1 h 05 min · 2 T 3 h */
function fmtHours(h: number): string {
  if (!Number.isFinite(h)) return '—';
  const min = Math.round(h * 60);
  if (min < 60) return `${min} min`;
  if (h < 48) return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
  return `${Math.floor(h / 24)} T ${Math.round(h % 24)} h`;
}
