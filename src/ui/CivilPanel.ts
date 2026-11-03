import { bus } from '../core/EventBus';
import { getProfile } from '../game/countryData';
import type { Reputation } from '../game/Reputation';
import type { Occupation } from '../civil/Occupation';
import type { CivilPort } from '../civil/ProtectionSystem';
import type { CivilCity, InfraInfo, WarCrimeKind } from '../civil/types';

const INFRA_ICON: Record<string, string> = {
  hospital: '✚', school: '▤', power_plant: '⚡', water_works: '≈', port: '⚓', airport: '✈', rail_station: '▭', town_hall: '⌂', church: '✝',
};
const INFRA_NAME: Record<string, string> = {
  hospital: 'Krankenhaus', school: 'Schule', power_plant: 'Kraftwerk', water_works: 'Wasserwerk', port: 'Hafen',
  airport: 'Flughafen', rail_station: 'Bahnhof', town_hall: 'Rathaus', church: 'Kirche',
};
const CRIME_NAME: Record<WarCrimeKind, string> = {
  civilian_attack: 'Angriff auf Zivilisten',
  protected_infra: 'Angriff auf geschützte Infrastruktur',
  indiscriminate_bombardment: 'Flächenbombardement',
  human_shield_use: 'Menschliche Schutzschilde',
  hospital_attack: 'Angriff auf Krankenhaus',
  evacuation_attack: 'Angriff auf Evakuierung',
};

interface CrimeLine {
  text: string;
  mine: boolean;
  victimMe: boolean;
  sev: number;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

function fmt(n: number): string {
  n = Math.round(n);
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace('.', ',') + ' Mio';
  if (n >= 1e4) return Math.round(n / 1e3) + ' Tsd';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace('.', ',') + ' Tsd';
  return String(n);
}

function fmtT(h: number): string {
  const d = Math.floor(h / 24);
  const hh = Math.floor(h % 24);
  return `T${d + 1} ${String(hh).padStart(2, '0')}h`;
}

/**
 * Bevölkerungs-Panel (Phase 4): Ansehen, Opferzahlen, eigene/besetzte Städte, Stadtdetails, Kriegsverbrecher-Warnungen.
 * Kleiner Schalter oben rechts unter der Kopfleiste, Panel klappt darunter auf. DOM-Update höchstens 4×/s.
 */
export class CivilPanel {
  private readonly civil: CivilPort;
  private readonly rep: Reputation;
  private readonly getPlayer: () => string | null;
  private occupation: Occupation | null = null;

  private readonly toggle: HTMLButtonElement;
  private readonly badge: HTMLSpanElement;
  private readonly panel: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private visible = false;
  private selected = -1;
  private lastUpdate = 0;
  private lastSig = '';
  private readonly crimes: CrimeLine[] = [];
  private readonly off: Array<() => void> = [];

  constructor(root: HTMLElement, civil: CivilPort, rep: Reputation, getPlayer: () => string | null) {
    this.civil = civil;
    this.rep = rep;
    this.getPlayer = getPlayer;

    this.toggle = document.createElement('button');
    this.toggle.className = 'btn cv-toggle';
    this.toggle.type = 'button';
    this.toggle.title = 'Bevölkerung, Ansehen und Besatzung';
    this.toggle.append(document.createTextNode('☗ Bevölkerung '));
    this.badge = document.createElement('span');
    this.badge.className = 'cv-badge';
    this.toggle.appendChild(this.badge);
    this.toggle.addEventListener('click', () => (this.visible ? this.hide() : this.show()));

    this.panel = document.createElement('div');
    this.panel.className = 'panel cv-panel hidden';
    const head = document.createElement('div');
    head.className = 'panel-head cv-head';
    const t = document.createElement('span');
    t.textContent = 'BEVÖLKERUNG';
    const x = document.createElement('button');
    x.className = 'btn cv-x';
    x.type = 'button';
    x.textContent = '×';
    x.addEventListener('click', () => this.hide());
    head.append(t, x);
    this.body = document.createElement('div');
    this.body.className = 'cv-body';
    this.panel.append(head, this.body);
    this.panel.addEventListener('click', (e) => this.onClick(e));
    // Panel nicht an Spielwelt durchreichen
    for (const ev of ['pointerdown', 'mousedown', 'wheel', 'contextmenu'] as const) this.panel.addEventListener(ev, (e) => e.stopPropagation());
    this.toggle.addEventListener('pointerdown', (e) => e.stopPropagation());

    root.append(this.toggle, this.panel);

    this.off.push(
      bus.on('warcrime', (e) => {
        const me = this.getPlayer();
        const att = getProfile(e.attacker)?.name ?? e.attacker;
        const vic = getProfile(e.victim)?.name ?? e.victim;
        const city = this.civil.cityById(e.cityId)?.name ?? '';
        this.crimes.unshift({
          text: `${att}: ${CRIME_NAME[e.kind] ?? e.kind}${city ? ' in ' + city : ''} (Opfer: ${vic})`,
          mine: !!me && e.attacker === me,
          victimMe: !!me && e.victim === me,
          sev: e.severity,
        });
        if (this.crimes.length > 30) this.crimes.length = 30;
        this.lastSig = '';
      }),
    );
  }

  setOccupation(o: Occupation): void {
    this.occupation = o;
  }

  show(): void {
    this.visible = true;
    this.panel.classList.remove('hidden');
    this.toggle.classList.add('active');
    this.lastUpdate = 0;
    this.lastSig = '';
    this.refresh();
  }

  hide(): void {
    this.visible = false;
    this.panel.classList.add('hidden');
    this.toggle.classList.remove('active');
  }

  dispose(): void {
    for (const f of this.off) f();
    this.toggle.remove();
    this.panel.remove();
  }

  /** Stadt auswählen (Detailblock mit Infrastruktur); -1 = Auswahl aufheben. Öffnet das Panel. */
  selectCity(cityId: number): void {
    this.selected = this.civil.cityById(cityId) ? cityId : -1;
    if (this.selected >= 0 && !this.visible) this.show();
    else {
      this.lastSig = '';
      this.refresh();
    }
  }

  /** dt wird nicht benötigt (Echtzeit-Drosselung auf ≤ 4 Updates pro Sekunde) */
  update(_dt: number): void {
    const now = performance.now();
    const p = this.getPlayer();
    // Schalter-Badge billig mitführen (Ansehen), Panelinhalt nur bei Sichtbarkeit
    if (now - this.lastUpdate < 250) return;
    this.lastUpdate = now;
    if (p) {
      const v = Math.round(this.rep.value(p));
      this.badge.textContent = (v > 0 ? '+' : '') + v;
      this.badge.className = 'cv-badge ' + this.repClass(v);
    }
    if (this.visible) this.refresh();
  }

  // ------------------------------------------------------------------ Darstellung

  private repClass(v: number): string {
    return v <= -60 ? 'bad2' : v <= -40 ? 'bad' : v < 0 ? 'warn' : v < 30 ? 'mid' : 'good';
  }

  private refresh(): void {
    const p = this.getPlayer();
    if (!p) {
      this.body.innerHTML = '<div class="cv-empty">Kein Land gewählt.</div>';
      return;
    }
    const cities = this.civil.cities;
    const own: CivilCity[] = [];
    const held: CivilCity[] = [];
    let ownKilled = 0, enemyKilled = 0, ownRef = 0;
    for (let i = 0; i < cities.length; i++) {
      const c = cities[i];
      if (c.country === p) {
        ownKilled += c.killed;
        ownRef += c.refugees;
        own.push(c);
      } else {
        enemyKilled += c.killed;
        if (c.controller === p) held.push(c);
      }
    }
    own.sort((a, b) => b.populationStart - a.populationStart);
    const shown = own.slice(0, 12);
    // Problemstädte (Besatzung/Unruhe/Evakuierung) nach vorn
    for (const c of own.slice(12)) if (c.control !== 'normal' || c.controller !== p) shown.push(c);

    const val = this.rep.value(p);
    const sel = this.selected >= 0 ? this.civil.cityById(this.selected) : undefined;
    const sig = [
      Math.round(val * 10), this.rep.log.length, this.rep.warCrimes.get(p) ?? 0, this.rep.totalWarCrimes(),
      Math.round(this.rep.radicalization(p)), Math.round(ownKilled), Math.round(enemyKilled), Math.round(this.civil.stats.refugees / 100),
      shown.map((c) => `${c.id}:${c.control}:${c.evacuating ? 1 : 0}:${Math.round(c.satisfaction)}:${Math.round(c.population / 1000)}:${c.controller}`).join(','),
      held.map((c) => `${c.id}:${Math.round(c.unrest * 100)}:${this.occupation ? this.occupation.garrisonStrength(c.id).toFixed(1) : ''}`).join(','),
      sel ? `${sel.id}:${Math.round(sel.damage * 100)}:${Math.round(sel.killed)}:${this.infraSig(sel.id)}` : '',
      this.crimes.length,
    ].join('|');
    if (sig === this.lastSig) return;
    this.lastSig = sig;

    const parts: string[] = [];
    parts.push(this.renderRep(p, val));
    parts.push(this.renderCasualties(ownKilled, enemyKilled, ownRef));
    parts.push(this.renderOwn(shown, p));
    if (held.length) parts.push(this.renderHeld(held));
    if (sel) parts.push(this.renderDetail(sel));
    parts.push(this.renderCrimes());
    const top = this.body.scrollTop;
    this.body.innerHTML = parts.join('');
    this.body.scrollTop = top;
  }

  private infraSig(cityId: number): string {
    let s = '';
    const arr = this.civil.infra;
    for (let i = 0; i < arr.length; i++) if (arr[i].cityId === cityId) s += Math.round(arr[i].integrity * 20) + ',';
    return s;
  }

  private renderRep(p: string, val: number): string {
    const pos = ((val + 100) / 200) * 100;
    const events = this.rep.log.filter((e) => e.a3 === p).slice(-8).reverse();
    const mine = this.rep.warCrimes.get(p) ?? 0;
    const rad = Math.round(this.rep.radicalization(p));
    let state = 'Gute Reputation';
    if (this.rep.alliesLeaving(p)) state = 'Verbündete wenden sich ab!';
    else if (this.rep.sanctioned(p)) state = 'Sanktionen drohen';
    else if (val < 0) state = 'Angespannt';
    else if (val < 30) state = 'Neutral';
    const trade = Math.round(this.rep.tradePenalty(p) * 100);
    let h = '<div class="cv-sec"><div class="cv-h">Internationales Ansehen</div>';
    h += `<div class="cv-gauge"><i class="z1"></i><i class="z2"></i><i class="z3"></i><i class="z4"></i><i class="z5"></i><b style="left:${pos.toFixed(1)}%"></b></div>`;
    h += `<div class="cv-ticks"><span>−100</span><span>−40</span><span>0</span><span>+40</span><span>+100</span></div>`;
    h += `<div class="cv-row"><span class="${this.repClass(val)}">${val > 0 ? '+' : ''}${val.toFixed(1)}</span><span class="dim">${esc(state)}</span></div>`;
    h += `<div class="cv-row"><span class="dim">Kriegsverbrechen</span><span class="${mine ? 'bad' : ''}">${mine} <span class="dim">(gesamt ${this.rep.totalWarCrimes()})</span></span></div>`;
    h += `<div class="cv-row sm"><span class="dim">Handelsabschlag <span class="${trade ? 'warn' : ''}">${trade}%</span></span><span class="dim">Radikalisierung <span class="${rad > 25 ? 'warn' : ''}">${rad}</span></span></div>`;
    if (events.length) {
      h += '<ul class="cv-log">';
      for (const e of events) {
        h += `<li><b class="${e.delta < 0 ? 'bad' : 'good'}">${e.delta > 0 ? '+' : ''}${e.delta.toFixed(1)}</b> <span class="dim">${fmtT(e.t)}</span> ${esc(e.reason)}</li>`;
      }
      h += '</ul>';
    } else h += '<div class="cv-empty">Keine Ereignisse.</div>';
    return h + '</div>';
  }

  private renderCasualties(ownK: number, enemyK: number, ownRef: number): string {
    const st = this.civil.stats;
    let h = '<div class="cv-sec"><div class="cv-h">Zivile Opfer</div>';
    h += `<div class="cv-row"><span class="dim">Tote: eigene Städte</span><span class="${ownK > 0 ? 'bad' : ''}">${fmt(ownK)}</span></div>`;
    h += `<div class="cv-row"><span class="dim">Tote: feindliche Städte</span><span>${fmt(enemyK)}</span></div>`;
    h += `<div class="cv-row"><span class="dim">Flüchtlinge (eig./ges.)</span><span class="nw">${fmt(ownRef)} / ${fmt(st.refugees)}</span></div>`;
    return h + '</div>';
  }

  private statusOf(c: CivilCity, p: string): { icon: string; label: string; cls: string } {
    if (c.controller !== p) return { icon: '⚑', label: 'Besetzt', cls: 'bad' };
    if (c.control === 'ruined') return { icon: '✖', label: 'Zerstört', cls: 'bad' };
    if (c.control === 'unrest' || c.unrest >= 0.3) return { icon: '!', label: 'Unruhen', cls: 'warn' };
    if (c.evacuating) return { icon: '➜', label: 'Evakuierung', cls: 'info' };
    if (c.control === 'evacuated') return { icon: '○', label: 'Evakuiert', cls: 'dim' };
    if (c.control === 'occupied') return { icon: '⚑', label: 'Besetzt', cls: 'warn' };
    return { icon: '●', label: 'Normal', cls: 'good' };
  }

  private renderOwn(list: CivilCity[], p: string): string {
    let h = '<div class="cv-sec"><div class="cv-h">Meine Städte</div>';
    if (!list.length) return h + '<div class="cv-empty">Keine Städte.</div></div>';
    h += '<div class="cv-cities">';
    for (const c of list) {
      const s = this.statusOf(c, p);
      const sat = Math.round(c.satisfaction);
      const evacBtn = c.controller === p && c.control !== 'ruined'
        ? `<button class="btn cv-mini" data-act="evac" data-id="${c.id}" title="${c.evacuating ? 'Evakuierung beenden' : 'Evakuierung starten'}">${c.evacuating ? 'Stopp' : 'Evakuieren'}</button>`
        : '';
      h += `<div class="cv-city${c.id === this.selected ? ' sel' : ''}" data-act="sel" data-id="${c.id}">`
        + `<span class="cv-ic ${s.cls}" title="${s.label}">${s.icon}</span>`
        + `<span class="cv-name" title="${esc(c.name)}">${esc(c.name)}${c.capital ? ' ★' : ''}</span>`
        + `<span class="cv-pop" title="Einwohner">${fmt(c.population)}</span>`
        + `<span class="cv-sat ${sat < 35 ? 'bad' : sat < 55 ? 'warn' : 'good'}" title="Zufriedenheit">${sat}%</span>`
        + `<button class="btn cv-mini" data-act="zoom" data-id="${c.id}" title="Zur Stadt">⌖</button>${evacBtn}</div>`;
    }
    return h + '</div></div>';
  }

  private renderHeld(list: CivilCity[]): string {
    let h = '<div class="cv-sec"><div class="cv-h">Besetzte Städte (Garnison)</div>';
    for (const c of list) {
      const have = this.occupation ? this.occupation.garrisonStrength(c.id) : 0;
      const need = this.occupation ? this.occupation.required(c.id) : 0;
      const ratio = need > 0 ? Math.min(1, have / need) : 0;
      const un = Math.round(c.unrest * 100);
      h += `<div class="cv-occ" data-act="sel" data-id="${c.id}">`
        + `<div class="cv-row"><span class="cv-name">${esc(c.name)}</span><span class="${un >= 50 ? 'bad' : un >= 25 ? 'warn' : 'dim'}">Unruhe ${un}%</span>`
        + `<button class="btn cv-mini" data-act="zoom" data-id="${c.id}" title="Zur Stadt">⌖</button></div>`;
      if (this.occupation) {
        h += `<div class="cv-bar"><i class="${ratio >= 1 ? 'ok' : ratio > 0.4 ? 'mid' : 'low'}" style="width:${(ratio * 100).toFixed(0)}%"></i></div>`
          + `<div class="cv-row sm"><span class="dim">Garnison</span><span>${have.toFixed(1)} / ${need}</span></div>`;
      }
      h += '</div>';
    }
    return h + '</div>';
  }

  private renderDetail(c: CivilCity): string {
    const infra: InfraInfo[] = [];
    const arr = this.civil.infra;
    for (let i = 0; i < arr.length; i++) if (arr[i].cityId === c.id) infra.push(arr[i]);
    const ctl = c.controller !== c.country ? ` · besetzt von ${esc(getProfile(c.controller)?.name ?? c.controller)}` : '';
    let h = `<div class="cv-sec cv-detail"><div class="cv-h">${esc(c.name)}${c.capital ? ' ★' : ''} <span class="dim">${esc(getProfile(c.country)?.name ?? c.country)}${ctl}</span></div>`;
    h += `<div class="cv-row"><span class="dim">Einwohner</span><span>${fmt(c.population)} <span class="dim">/ ${fmt(c.populationStart)}</span></span></div>`;
    h += `<div class="cv-row"><span class="dim">Getötet</span><span class="${c.killed > 0 ? 'bad' : ''}">${fmt(c.killed)}</span></div>`;
    h += `<div class="cv-row"><span class="dim">Flüchtlinge</span><span>${fmt(c.refugees)}</span></div>`;
    h += `<div class="cv-row"><span class="dim">Zerstörung</span><span class="${c.damage > 0.4 ? 'bad' : ''}">${Math.round(c.damage * 100)}%</span></div>`;
    h += `<div class="cv-row"><span class="dim">Zufriedenheit</span><span>${Math.round(c.satisfaction)}%</span></div>`;
    if (infra.length) {
      h += '<div class="cv-sub">Infrastruktur</div><div class="cv-infra">';
      infra.sort((a, b) => Number(b.protectedStatus) - Number(a.protectedStatus) || a.kind.localeCompare(b.kind));
      for (const f of infra.slice(0, 14)) {
        const pct = Math.round(f.integrity * 100);
        h += `<div class="cv-inf"><span class="cv-ic ${f.kind === 'hospital' ? 'bad' : ''}">${INFRA_ICON[f.kind] ?? '■'}</span>`
          + `<span class="cv-iname">${INFRA_NAME[f.kind] ?? f.kind}</span>`
          + `<span class="cv-bar sm"><i class="${pct > 60 ? 'ok' : pct > 25 ? 'mid' : 'low'}" style="width:${pct}%"></i></span>`
          + `<span class="cv-flag${f.protectedStatus ? ' on' : ''}" title="${f.protectedStatus ? 'Geschützt: Angriff ist ein Kriegsverbrechen' : 'Nicht geschützt'}">${f.protectedStatus ? '⛨' : ''}</span></div>`;
      }
      h += '</div>';
    } else h += '<div class="cv-empty">Keine Infrastruktur erfasst.</div>';
    return h + '</div>';
  }

  private renderCrimes(): string {
    let h = '<div class="cv-sec"><div class="cv-h">Warnungen</div>';
    if (!this.crimes.length) return h + '<div class="cv-empty">Keine Kriegsverbrechen gemeldet.</div></div>';
    h += '<ul class="cv-log cv-crimes">';
    for (const c of this.crimes.slice(0, 8)) {
      h += `<li class="${c.mine ? 'mine' : c.victimMe ? 'vic' : ''}"><b class="bad">${c.sev >= 0.7 ? '!!' : '!'}</b> ${esc(c.text)}</li>`;
    }
    return h + '</ul></div>';
  }

  private onClick(e: MouseEvent): void {
    const el = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (!el) return;
    const id = Number(el.dataset.id);
    const act = el.dataset.act;
    const c = this.civil.cityById(id);
    if (!c) return;
    if (act === 'zoom') {
      e.stopPropagation();
      bus.emit('camera:focus', { x: c.x, z: c.z, distance: Math.max(6, c.radiusKm * 4) });
    } else if (act === 'evac') {
      e.stopPropagation();
      if (c.evacuating) this.civil.stopEvacuation(id);
      else if (!this.civil.startEvacuation(id)) bus.emit('toast', { msg: `Evakuierung von ${c.name} nicht möglich.`, kind: 'warn' });
      this.lastSig = '';
      this.refresh();
    } else if (act === 'sel') {
      this.selected = this.selected === id ? -1 : id;
      this.lastSig = '';
      this.refresh();
    }
  }
}
