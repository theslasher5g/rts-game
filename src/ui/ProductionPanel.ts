import { bus } from '../core/EventBus';
import type { OilEconomy } from '../logistics/OilEconomy';
import { BASE_DEFS, BUILDABLE } from '../logistics/prices';
import type { BaseInfo, BaseKind, OilFieldInfo } from '../logistics/types';
import type { SupplySystem } from '../logistics/SupplySystem';
import type { ProductionSystem } from '../production/ProductionSystem';
import { MAX_QUEUE } from '../production/ProductionSystem';

/**
 * Phase 5 – Produktions- und Nachschub-Panel (Reiter 'Produktion' und 'Nachschub').
 * Mit `hud` werden zwei HUD-Reiter registriert, sonst erscheint ein schwebendes Panel unter dem Menü-Button.
 * DOM-Aktualisierung höchstens 4×/s; Struktur wird nur neu gebaut, wenn sie sich ändert (Klicks bleiben stabil),
 * Zahlen/Balken werden gezielt nachgeführt.
 * Karteninteraktion: der Lead ruft `onMapClick(x, z)` bei jedem Linksklick auf die Karte auf (true = verbraucht)
 * und fragt `isTargeting()` für den Fadenkreuz-Cursor ab.
 */

export interface ProductionPanelDeps {
  production: ProductionSystem;
  economy: OilEconomy;
  supply: SupplySystem;
  getPlayer: () => string | null;
  hud?: { registerTab(id: string, label: string, el: HTMLElement): void } | null;
  root: HTMLElement;
  /** aktuell ausgewählte Einheiten (Pioniere für den Basisbau) */
  getSelectedIds?: () => number[];
}

type Mode = { kind: 'none' } | { kind: 'rally'; baseId: number } | { kind: 'place'; base: BaseKind };

const REFRESH = 0.25;
const KIND_LETTER: Record<BaseKind, string> = { hq: 'HQ', refinery: 'RF', barracks: 'KS', factory: 'FW', airfield: 'FP', shipyard: 'WF', depot: 'DP', fuel_depot: 'TL' };

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}
function fmt(n: number): string {
  return Math.round(n).toLocaleString('de-DE');
}
function fmtRate(n: number): string {
  return `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(1).replace('.', ',')}`;
}

interface Built {
  html: string;
  dyn: Array<{ k: string; text?: string; width?: number; cls?: [string, boolean] }>;
}

export class ProductionPanel {
  private readonly d: ProductionPanelDeps;
  private readonly prodEl: HTMLDivElement;
  private readonly supEl: HTMLDivElement;
  private floating: HTMLDivElement | null = null;
  private floatTabs: HTMLButtonElement[] = [];
  private tab: 'production' | 'supply' = 'production';
  private visible = false;
  private acc = REFRESH;
  private selBase = -1;
  private mode: Mode = { kind: 'none' };
  private sig = { production: '', supply: '' };
  private lowIdx = 0;
  private msg = '';
  private msgT = 0;

  constructor(deps: ProductionPanelDeps) {
    this.d = deps;
    this.prodEl = document.createElement('div');
    this.prodEl.className = 'prod-panel';
    this.supEl = document.createElement('div');
    this.supEl.className = 'prod-panel';
    for (const el of [this.prodEl, this.supEl]) el.addEventListener('click', (e) => this.onClick(e));
    if (deps.hud) {
      deps.hud.registerTab('production', 'Produktion', this.prodEl);
      deps.hud.registerTab('supply', 'Nachschub', this.supEl);
      this.visible = true;
    } else {
      this.buildFloating();
    }
  }

  private buildFloating(): void {
    const f = document.createElement('div');
    f.className = 'prod-floating hidden';
    const tabs = document.createElement('div');
    tabs.className = 'prod-tabs';
    const mk = (id: 'production' | 'supply', label: string) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', () => { this.tab = id; this.applyTab(); this.sig = { production: '', supply: '' }; this.refresh(); });
      tabs.appendChild(b);
      this.floatTabs.push(b);
    };
    mk('production', 'Produktion');
    mk('supply', 'Nachschub');
    const body = document.createElement('div');
    body.className = 'prod-body';
    body.append(this.prodEl, this.supEl);
    f.append(tabs, body);
    this.d.root.appendChild(f);
    this.floating = f;
    this.applyTab();
  }

  private applyTab(): void {
    this.prodEl.hidden = this.floating !== null && this.tab !== 'production';
    this.supEl.hidden = this.floating !== null && this.tab !== 'supply';
    this.floatTabs.forEach((b, i) => b.classList.toggle('active', (i === 0) === (this.tab === 'production')));
  }

  show(): void {
    this.visible = true;
    this.floating?.classList.remove('hidden');
    this.sig = { production: '', supply: '' };
    this.refresh();
  }

  hide(): void {
    this.visible = false;
    this.floating?.classList.add('hidden');
    this.cancelMode();
  }

  toggle(): void {
    if (this.visible && this.floating) this.hide(); else this.show();
  }

  // ------------------------------------------------------------------ Karteninteraktion

  isTargeting(): boolean {
    return this.mode.kind !== 'none';
  }

  cancelMode(): void {
    if (this.mode.kind !== 'none') { this.mode = { kind: 'none' }; this.sig.production = ''; }
  }

  /** Basistyp wählen: der nächste Kartenklick platziert die Baustelle */
  beginPlaceBase(kind: BaseKind): void {
    this.mode = { kind: 'place', base: kind };
    this.sig.production = '';
    this.say(`${BASE_DEFS[kind].name}: Bauplatz auf der Karte wählen (Esc bricht ab)`);
  }

  /** Kartenklick im Platzierungsmodus */
  placeAt(x: number, z: number): { ok: boolean; reason?: string } {
    if (this.mode.kind !== 'place') return { ok: false, reason: 'Kein Platzierungsmodus' };
    const player = this.d.getPlayer();
    if (!player) return { ok: false, reason: 'Kein Spieler' };
    const kind = this.mode.base;
    const eng = this.d.getSelectedIds?.() ?? [];
    const r = this.d.production.buildBase(player, kind, x, z, eng);
    if (r.ok) {
      this.mode = { kind: 'none' };
      this.say(`${BASE_DEFS[kind].name} im Bau – Pioniere in die Nähe schicken beschleunigt den Bau`);
      bus.emit('toast', { msg: `${BASE_DEFS[kind].name}: Baustelle angelegt`, kind: 'info' });
    } else {
      this.say(r.reason ?? 'Bau nicht möglich');
      bus.emit('toast', { msg: r.reason ?? 'Bau nicht möglich', kind: 'warn' });
    }
    this.sig.production = '';
    this.refresh();
    return r;
  }

  /** Für den Lead: bei jedem Linksklick auf die Karte aufrufen; true = Klick wurde verbraucht */
  onMapClick(x: number, z: number): boolean {
    if (this.mode.kind === 'rally') {
      this.d.production.setRally(this.mode.baseId, x, z);
      this.say('Sammelpunkt gesetzt');
      this.mode = { kind: 'none' };
      this.sig.production = '';
      this.refresh();
      return true;
    }
    if (this.mode.kind === 'place') {
      this.placeAt(x, z);
      return true;
    }
    return false;
  }

  selectBase(id: number): void {
    this.selBase = id;
    this.sig.production = '';
  }

  private say(m: string): void {
    this.msg = m;
    this.msgT = 6;
    this.sig.production = '';
  }

  // ------------------------------------------------------------------ Update

  update(dt: number): void {
    if (this.msgT > 0) {
      this.msgT -= dt;
      if (this.msgT <= 0) { this.msg = ''; this.sig.production = ''; }
    }
    this.acc += dt;
    if (this.acc < REFRESH) return;
    this.acc = 0;
    if (!this.visible) return;
    this.refresh();
  }

  private refresh(): void {
    const player = this.d.getPlayer();
    if (!player) return;
    if (!this.prodEl.hidden) this.render(this.prodEl, 'production', this.buildProduction(player));
    if (!this.supEl.hidden) this.render(this.supEl, 'supply', this.buildSupply(player));
  }

  private render(el: HTMLElement, id: 'production' | 'supply', b: Built): void {
    if (this.sig[id] !== b.html) {
      this.sig[id] = b.html;
      el.innerHTML = b.html;
    }
    for (const d of b.dyn) {
      const n = el.querySelector<HTMLElement>(`[data-k="${d.k}"]`);
      if (!n) continue;
      if (d.text !== undefined && n.textContent !== d.text) n.textContent = d.text;
      if (d.width !== undefined) n.style.width = `${Math.max(0, Math.min(100, d.width)).toFixed(1)}%`;
      if (d.cls) n.classList.toggle(d.cls[0], d.cls[1]);
    }
  }

  // ------------------------------------------------------------------ Produktion

  private buildProduction(player: string): Built {
    const { economy, production } = this.d;
    const dyn: Built['dyn'] = [];
    const pool = economy.pool(player);
    let h = '<h4>Ölguthaben</h4>';
    h += '<div class="prod-bal"><span>Fässer</span><span class="prod-oil" data-k="bal"></span><span>Einnahmen/h</span><span data-k="inc"></span><span>Ausgaben/h</span><span data-k="spd"></span></div>';
    dyn.push({ k: 'bal', text: fmt(pool.barrels) });
    dyn.push({ k: 'inc', text: fmtRate(pool.incomePerHour) });
    dyn.push({ k: 'spd', text: fmtRate(-pool.spendPerHour) });

    const bases = economy.basesOf(player).sort((a, b) => a.id - b.id);
    if (this.selBase < 0 || !economy.bases.has(this.selBase) || economy.bases.get(this.selBase)!.owner !== player) {
      const first = bases.find((b) => b.progress >= 1 && production.catalog(b.kind).length > 0 && b.kind !== 'refinery') ?? bases[0];
      this.selBase = first ? first.id : -1;
    }
    if (this.msg) h += `<div class="prod-hint">${esc(this.msg)}</div>`;
    if (this.mode.kind === 'rally') h += '<div class="prod-hint">Sammelpunkt: Ziel auf der Karte anklicken</div>';
    if (this.mode.kind === 'place') h += `<div class="prod-hint">${esc(BASE_DEFS[this.mode.base].name)}: Bauplatz auf der Karte anklicken</div>`;

    h += '<h4>Basen</h4>';
    if (!bases.length) h += '<div class="prod-empty">Keine Basen</div>';
    for (const b of bases) {
      const q = production.queueOf(b.id).length;
      h += `<div class="prod-row click${b.id === this.selBase ? ' sel' : ''}" data-act="selbase" data-id="${b.id}">`;
      h += `<span class="nm">[${KIND_LETTER[b.kind]}] ${esc(b.name ?? BASE_DEFS[b.kind].name)}</span>`;
      h += `<button class="prod-btn" data-act="zoom" data-x="${b.x}" data-z="${b.z}" title="Zur Basis">⌖</button>`;
      h += `<div class="prod-bar hp" data-k="hpbar${b.id}"><i data-k="hp${b.id}"></i></div>`;
      h += `<div class="sub"><span data-k="bst${b.id}"></span><span>Auftr. ${q}/${MAX_QUEUE}</span></div></div>`;
      const frac = b.hp / b.hpMax;
      dyn.push({ k: `hp${b.id}`, width: (b.progress < 1 ? b.progress : frac) * 100 });
      dyn.push({ k: `hpbar${b.id}`, cls: ['low', b.progress >= 1 && frac < 0.4] });
      dyn.push({ k: `bst${b.id}`, text: b.progress < 1 ? `Bau ${Math.round(b.progress * 100)} %` : `Zustand ${Math.round(frac * 100)} %` });
    }
    for (const k of ['hq', 'refinery'] as const) {
      if (economy.canRebuild(player, k)) {
        const c = BASE_DEFS[k].cost;
        h += `<div class="prod-actions"><button class="prod-btn" data-act="rebuild" data-kind="${k}" ${pool.barrels < c ? 'disabled title="Zu wenig Öl"' : ''}><span>${BASE_DEFS[k].name} wiederaufbauen</span><span class="pr">${c} F</span></button></div>`;
      }
    }

    const sel = this.selBase >= 0 ? economy.bases.get(this.selBase) : undefined;
    if (sel) {
      h += `<h4>${esc(sel.name ?? BASE_DEFS[sel.kind].name)} – Produktion</h4>`;
      if (sel.progress < 1) h += '<div class="prod-empty">Im Bau – Produktion erst nach Fertigstellung. Pioniere in der Nähe beschleunigen den Bau.</div>';
      else {
        const cat = production.catalog(sel.kind);
        const full = production.queueOf(sel.id).length >= MAX_QUEUE;
        h += '<div class="prod-buy">';
        for (const e of cat) {
          const poor = pool.barrels < e.price;
          const dis = poor || full;
          const why = full ? `Warteschlange voll (${MAX_QUEUE})` : poor ? `Zu wenig Öl: ${e.price} Fässer nötig` : '';
          h += `<button class="prod-btn" data-act="buy" data-type="${e.typeId}" ${dis ? `disabled title="${esc(why)}"` : `title="${e.hours} Spielstunden"`}><span>${esc(e.name)}</span><span class="pr">${e.price} F · ${e.hours.toFixed(1).replace('.', ',')} h</span></button>`;
        }
        h += '</div>';
        const q = production.queueOf(sel.id);
        h += '<h4>Warteschlange</h4>';
        if (!q.length) h += '<div class="prod-empty">leer</div>';
        for (const o of q) {
          const nm = cat.find((c) => c.typeId === o.typeId)?.name ?? o.typeId;
          h += `<div class="prod-row"><span class="nm">${esc(nm)}</span><button class="prod-btn x" data-act="cancel" data-id="${o.id}" title="Abbrechen (Rückerstattung)">✕</button>`;
          h += `<div class="prod-bar"><i data-k="po${o.id}"></i></div><div class="sub"><span data-k="pt${o.id}"></span><span>${o.rallyX !== undefined ? 'Sammelpunkt' : ''}</span></div></div>`;
          dyn.push({ k: `po${o.id}`, width: (1 - o.remainingHours / o.totalHours) * 100 });
          dyn.push({ k: `pt${o.id}`, text: `noch ${o.remainingHours.toFixed(1).replace('.', ',')} h` });
        }
        h += `<div class="prod-actions"><button class="prod-btn${this.mode.kind === 'rally' ? ' on' : ''}" data-act="rally" data-id="${sel.id}">Sammelpunkt setzen</button></div>`;
      }
    }

    h += '<h4>Bauen</h4><div class="prod-buy">';
    for (const k of BUILDABLE) {
      const def = BASE_DEFS[k];
      const n = economy.countBases(player, k);
      const poor = pool.barrels < def.cost, maxed = n >= def.maxCount;
      const why = maxed ? `Maximal ${def.maxCount}` : poor ? `Zu wenig Öl: ${def.cost} Fässer nötig` : '';
      const on = this.mode.kind === 'place' && this.mode.base === k;
      h += `<button class="prod-btn${on ? ' on' : ''}" data-act="place" data-kind="${k}" ${poor || maxed ? `disabled title="${esc(why)}"` : ''}><span>${def.name} (${n}/${def.maxCount})</span><span class="pr">${def.cost} F</span></button>`;
    }
    h += '</div><div class="prod-empty">Bauplatz: flaches Land, kein Feind in der Nähe. Ausgewählte Pioniertrupps laufen zur Baustelle.</div>';
    return { html: h, dyn };
  }

  // ------------------------------------------------------------------ Nachschub

  private fieldTag(f: OilFieldInfo, player: string): { cls: string; text: string; row: string } {
    const eco = this.d.economy;
    if (f.integrity < 0.05) return { cls: 'dead', text: 'Zerstört', row: 'bad' };
    if (!f.owner) return { cls: 'neu', text: 'Neutral', row: '' };
    if (f.owner !== player) return eco.isHostile(player, f.owner) ? { cls: 'en', text: 'Feindlich', row: '' } : { cls: 'ally', text: 'Verbündet', row: '' };
    if (f.cutOff) return { cls: 'cut', text: 'Abgeschnitten', row: 'bad' };
    if (f.stored >= f.capacity - 1) return { cls: 'neu', text: 'Lager voll', row: 'warn' };
    return { cls: 'ok', text: 'Gefördert', row: '' };
  }

  private buildSupply(player: string): Built {
    const { economy, supply } = this.d;
    const dyn: Built['dyn'] = [];
    const pool = economy.pool(player);
    let h = '<h4>Ölbilanz</h4><div class="prod-bal">';
    h += '<span>Guthaben</span><span class="prod-oil" data-k="s_bal"></span><span>Einnahmen/h</span><span data-k="s_inc"></span><span>Ausgaben/h</span><span data-k="s_spd"></span><span>Saldo/h</span><span data-k="s_net"></span><span>Unterwegs</span><span data-k="s_tr"></span>';
    h += '</div>';
    const net = pool.incomePerHour - pool.spendPerHour;
    dyn.push({ k: 's_bal', text: `${fmt(pool.barrels)} F` });
    dyn.push({ k: 's_inc', text: fmtRate(pool.incomePerHour) });
    dyn.push({ k: 's_spd', text: fmtRate(-pool.spendPerHour) });
    dyn.push({ k: 's_net', text: fmtRate(net), cls: ['pos', net >= 0] });
    dyn.push({ k: 's_tr', text: `${fmt(pool.inTransit)} F` });

    // Ölfelder
    const fields = [...economy.fields].sort((a, b) => (a.owner === player ? 0 : 1) - (b.owner === player ? 0 : 1) || a.id - b.id);
    h += '<h4>Ölfelder</h4>';
    for (const f of fields) {
      const tag = this.fieldTag(f, player);
      h += `<div class="prod-row ${tag.row}"><span class="nm">${esc(f.name)}</span><button class="prod-btn" data-act="zoom" data-x="${f.x}" data-z="${f.z}" title="Zum Feld">⌖</button>`;
      h += `<div class="sub"><span class="prod-tag ${tag.cls}">${tag.text}</span><span data-k="fo${f.id}"></span></div>`;
      h += `<div class="prod-bar"><i data-k="fs${f.id}"></i></div></div>`;
      const own = f.owner === player;
      dyn.push({ k: `fo${f.id}`, text: `${f.owner || '–'} · ${Math.round(f.output * f.integrity)}/h · ${own ? `${Math.round(f.stored)}/${f.capacity}` : `${Math.round(f.integrity * 100)} %`}` });
      dyn.push({ k: `fs${f.id}`, width: (own ? f.stored / f.capacity : f.integrity) * 100 });
    }

    // Konvois
    const cs = economy.convoysOf(player);
    let moving = 0, waiting = 0, idle = 0;
    for (const c of cs) {
      if (c.state === 'idle') idle++;
      else if (c.state === 'waiting') waiting++;
      else moving++;
    }
    h += '<h4>Konvois</h4><div class="prod-bal">';
    h += `<span>Unterwegs</span><span data-k="cv_m"></span><span>Wartend (Weg gesperrt)</span><span data-k="cv_w"></span><span>Bereit</span><span data-k="cv_i"></span><span>Verloren</span><span data-k="cv_l"></span></div>`;
    dyn.push({ k: 'cv_m', text: String(moving) });
    dyn.push({ k: 'cv_w', text: String(waiting), cls: ['neg', waiting > 0] });
    dyn.push({ k: 'cv_i', text: String(idle) });
    dyn.push({ k: 'cv_l', text: `${pool.lostConvoys ?? 0} (${fmt(pool.lostBarrels ?? 0)} F)`, cls: ['neg', (pool.lostConvoys ?? 0) > 0] });

    // Depots
    const depots = economy.basesOf(player).filter((b: BaseInfo) => b.kind === 'depot' || b.kind === 'fuel_depot' || b.kind === 'refinery' || b.kind === 'hq');
    h += '<h4>Depots</h4>';
    for (const b of depots) {
      h += `<div class="prod-row"><span class="nm">[${KIND_LETTER[b.kind]}] ${esc(b.name ?? BASE_DEFS[b.kind].name)}</span><button class="prod-btn" data-act="zoom" data-x="${b.x}" data-z="${b.z}" title="Zum Depot">⌖</button><div class="sub"><span data-k="dp${b.id}"></span></div></div>`;
      dyn.push({ k: `dp${b.id}`, text: b.progress < 1 ? `Bau ${Math.round(b.progress * 100)} %` : `Zustand ${Math.round((b.hp / b.hpMax) * 100)} % · Radius ${b.radiusKm.toFixed(1).replace('.', ',')} km` });
    }

    // Versorgungslage
    const st = supply.statsFor(player);
    h += '<h4>Versorgungslage</h4><div class="prod-bal">';
    h += '<span>Einheiten &lt; 30 %</span><span data-k="sl"></span><span>Ohne Treibstoff/Munition</span><span data-k="so"></span><span>Versorgungs-LKW</span><span data-k="st"></span></div>';
    dyn.push({ k: 'sl', text: String(st.low), cls: ['neg', st.low > 0] });
    dyn.push({ k: 'so', text: String(st.out), cls: ['neg', st.out > 0] });
    dyn.push({ k: 'st', text: String(st.trucks) });
    h += `<div class="prod-actions"><button class="prod-btn" data-act="nextlow" ${st.low === 0 ? 'disabled' : ''}>Nächste Einheit anzeigen</button>`;
    const auto = supply.isAutoResupply(player);
    h += `<button class="prod-btn${auto ? ' on' : ''}" data-act="auto">Auto-Nachschub: ${auto ? 'an' : 'aus'}</button></div>`;
    return { html: h, dyn };
  }

  // ------------------------------------------------------------------ Klicks

  private onClick(e: MouseEvent): void {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!t || (t as HTMLButtonElement).disabled) return;
    const player = this.d.getPlayer();
    if (!player) return;
    const act = t.dataset.act;
    switch (act) {
      case 'selbase':
        this.selBase = Number(t.dataset.id);
        this.sig.production = '';
        this.refresh();
        break;
      case 'zoom':
        e.stopPropagation();
        bus.emit('camera:focus', { x: Number(t.dataset.x), z: Number(t.dataset.z), distance: 12 });
        break;
      case 'buy': {
        const r = this.d.production.queue(this.selBase, t.dataset.type ?? '');
        if (!r.ok) { this.say(r.reason ?? 'Nicht möglich'); bus.emit('toast', { msg: r.reason ?? 'Nicht möglich', kind: 'warn' }); }
        this.sig.production = '';
        this.refresh();
        break;
      }
      case 'cancel':
        this.d.production.cancel(Number(t.dataset.id));
        this.sig.production = '';
        this.refresh();
        break;
      case 'rally':
        this.mode = this.mode.kind === 'rally' ? { kind: 'none' } : { kind: 'rally', baseId: Number(t.dataset.id) };
        this.sig.production = '';
        this.refresh();
        break;
      case 'place': {
        const k = t.dataset.kind as BaseKind;
        if (this.mode.kind === 'place' && this.mode.base === k) this.cancelMode(); else this.beginPlaceBase(k);
        this.refresh();
        break;
      }
      case 'rebuild': {
        const r = this.d.production.buildBase(player, t.dataset.kind as BaseKind, 0, 0);
        this.say(r.ok ? 'Wiederaufbau begonnen' : r.reason ?? 'Nicht möglich');
        this.refresh();
        break;
      }
      case 'nextlow': {
        const list = this.d.supply.lowUnits(player);
        if (!list.length) break;
        const u = list[this.lowIdx++ % list.length];
        bus.emit('camera:focus', { x: u.x, z: u.z, distance: 5 });
        break;
      }
      case 'auto':
        this.d.supply.setAutoResupply(player, !this.d.supply.isAutoResupply(player));
        this.sig.supply = '';
        this.refresh();
        break;
    }
  }
}
