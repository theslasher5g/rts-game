import './abilities.css';
import { bus } from '../core/EventBus';

/**
 * Phase 7 – Funkprotokoll: Lagemeldungen ('alert' auf dem EventBus) für das Team des Spielers.
 * Eingeklappt erscheinen neue Meldungen kurz als Ticker (ältere blenden aus), ausgeklappt zeigt die Liste die letzten
 * Meldungen mit Spielzeit. Klick auf einen Eintrag mit Position -> Kamera springt dorthin ('camera:focus').
 * Gleiche Meldungen kurz hintereinander werden zu "×N" zusammengefasst. Ungelesen-Zähler am Kopf.
 * Position: unten rechts über dem Infopanel (.hud-info), rechts neben den Reitern.
 */

type Kind = 'info' | 'warn' | 'danger';

export interface EventLogOptions {
  getPlayer: () => string | null;
  /** Verbündete (zusätzlich zum Spieler) – deren Meldungen erscheinen ebenfalls */
  getAllies?: () => string[];
  /** Spielzeit-Beschriftung für Einträge, z. B. () => 'HH:MM' (Standard: leer) */
  getTimeLabel?: () => string;
  /** Akustischer Hinweis (optional), z. B. kind => sfx.beep?.(kind); höchstens ~1x/s */
  onBeep?: (kind: Kind) => void;
  /** Kartenmarkierung (optional): Minimap.ping */
  minimap?: { ping(x: number, z: number, kind: Kind): void };
  /** Maximale Anzahl gespeicherter Einträge (Standard 40) */
  max?: number;
  /** Ticker-Anzeigedauer eingeklappt in Sekunden (Standard 14) */
  tickerSec?: number;
  /** Kamera-Abstand beim Anspringen (km, Standard 25) */
  jumpDistance?: number;
}

interface Entry {
  a3: string;
  kind: Kind;
  base: string;
  text: string;
  x?: number;
  z?: number;
  time: string;
  t: number;
  count: number;
  el: HTMLDivElement;
  tEl: HTMLSpanElement;
  xEl: HTMLSpanElement;
  nEl: HTMLSpanElement;
}

const MERGE_MS = 9000;
const FRESH_MS = 4000;

export class EventLog {
  private readonly opts: EventLogOptions;
  private readonly wrap: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private readonly head: HTMLButtonElement;
  private readonly badge: HTMLSpanElement;
  private readonly entries: Entry[] = [];
  private readonly offs: Array<() => void> = [];
  private readonly timer: number;
  private readonly root: HTMLElement;
  private open = false;
  private unread = 0;
  private unreadDanger = false;
  private lastBeep = 0;
  private shown = false;

  constructor(root: HTMLElement, opts: EventLogOptions) {
    this.opts = opts;
    this.root = root;
    this.wrap = document.createElement('div');
    this.wrap.className = 'evl hidden';
    this.list = document.createElement('div');
    this.list.className = 'evl-list';
    this.head = document.createElement('button');
    this.head.type = 'button';
    this.head.className = 'evl-head';
    this.head.title = 'Funkprotokoll: Klick klappt die Liste auf; Einträge mit ⌖ springen zur Position';
    const lbl = document.createElement('span');
    lbl.textContent = '⌁ Funk';
    this.badge = document.createElement('span');
    this.badge.className = 'evl-badge zero';
    this.badge.textContent = '0';
    this.head.append(lbl, this.badge);
    this.head.addEventListener('click', () => this.setOpen(!this.open));
    this.wrap.append(this.list, this.head);
    root.appendChild(this.wrap);

    this.offs.push(bus.on('alert', (e) => this.onAlert(e)));
    this.timer = window.setInterval(() => {
      this.tick();
      this.place();
    }, 1000);
  }

  dispose(): void {
    for (const o of this.offs) o();
    window.clearInterval(this.timer);
    this.wrap.remove();
  }

  /** Nach Spielstart anzeigen / im Menü verbergen */
  show(): void {
    this.shown = true;
    this.wrap.classList.remove('hidden');
    this.place();
  }
  hide(): void {
    this.shown = false;
    this.wrap.classList.add('hidden');
  }

  /** Alle Einträge löschen (neues Spiel) */
  clear(): void {
    for (const e of this.entries) e.el.remove();
    this.entries.length = 0;
    this.unread = 0;
    this.unreadDanger = false;
    this.refreshBadge();
  }

  get count(): number {
    return this.entries.length;
  }

  setOpen(v: boolean): void {
    this.open = v;
    this.wrap.classList.toggle('open', v);
    if (v) {
      this.unread = 0;
      this.unreadDanger = false;
      this.refreshBadge();
      for (const e of this.entries) e.el.classList.remove('old', 'fade', 'gone');
      this.list.scrollTop = this.list.scrollHeight;
    }
    this.tick();
    this.place();
  }

  // ------------------------------------------------------------------ intern

  private inTeam(a3: string): boolean {
    const p = this.opts.getPlayer();
    if (!p) return false;
    return a3 === p || (this.opts.getAllies?.() ?? []).includes(a3);
  }

  private onAlert(e: { a3: string; kind: Kind; text: string; x?: number; z?: number }): void {
    if (!this.inTeam(e.a3)) return;
    const now = performance.now();
    const last = this.entries[this.entries.length - 1];
    // Zusammenfassen: gleicher Text (ohne Koordinaten-Anhang) kurz zuvor
    const base = baseText(e.text);
    for (let i = this.entries.length - 1; i >= 0 && i >= this.entries.length - 6; i--) {
      const q = this.entries[i];
      if (now - q.t > MERGE_MS) break;
      if (q.a3 === e.a3 && q.base === base && q.kind === e.kind) {
        q.count++;
        q.t = now;
        q.text = e.text;
        if (e.x !== undefined) { q.x = e.x; q.z = e.z; }
        q.time = this.opts.getTimeLabel?.() ?? q.time;
        this.fill(q);
        this.list.appendChild(q.el);
        this.entries.splice(i, 1);
        this.entries.push(q);
        this.afterAdd(q, false);
        return;
      }
    }
    void last;
    const el = document.createElement('div');
    const tEl = document.createElement('span');
    tEl.className = 'evl-t';
    const xEl = document.createElement('span');
    xEl.className = 'evl-x';
    const nEl = document.createElement('span');
    nEl.className = 'evl-j';
    el.append(tEl, xEl, nEl);
    const q: Entry = { a3: e.a3, kind: e.kind, base, text: e.text, x: e.x, z: e.z, time: this.opts.getTimeLabel?.() ?? '', t: now, count: 1, el, tEl, xEl, nEl };
    el.addEventListener('click', () => {
      if (q.x === undefined || q.z === undefined) return;
      bus.emit('camera:focus', { x: q.x, z: q.z, distance: this.opts.jumpDistance ?? 25 });
    });
    this.fill(q);
    this.list.appendChild(el);
    this.entries.push(q);
    const max = this.opts.max ?? 40;
    while (this.entries.length > max) this.entries.shift()!.el.remove();
    this.afterAdd(q, true);
  }

  private fill(q: Entry): void {
    q.el.className = `evl-row ${q.kind}${q.x !== undefined ? ' pos' : ''} fresh`;
    q.tEl.textContent = q.time;
    q.xEl.textContent = q.text;
    if (q.count > 1) {
      const n = document.createElement('b');
      n.className = 'evl-n';
      n.textContent = ` ×${q.count}`;
      q.xEl.appendChild(n);
    }
    q.nEl.textContent = q.x !== undefined ? '⌖' : '';
    q.el.title = q.x !== undefined ? 'Klick: Kamera springt zur Position' : '';
  }

  private afterAdd(q: Entry, isNew: boolean): void {
    void isNew;
    const now = performance.now();
    if (!this.open) {
      this.unread++;
      if (q.kind === 'danger') this.unreadDanger = true;
      this.refreshBadge();
    } else this.list.scrollTop = this.list.scrollHeight;
    if (q.x !== undefined && q.z !== undefined && this.opts.minimap) this.opts.minimap.ping(q.x, q.z, q.kind);
    if (q.kind !== 'info' && now - this.lastBeep > 1000) {
      this.lastBeep = now;
      this.opts.onBeep?.(q.kind);
    }
    this.tick();
    this.place();
  }

  private refreshBadge(): void {
    this.badge.textContent = String(Math.min(99, this.unread));
    this.badge.classList.toggle('zero', this.unread === 0);
    this.badge.classList.toggle('danger', this.unread > 0 && this.unreadDanger);
  }

  /** Ticker: eingeklappt nur junge Einträge zeigen (sanft ausblenden); höchstens 5 sichtbar */
  private tick(): void {
    const now = performance.now();
    const ttl = (this.opts.tickerSec ?? 14) * 1000;
    let visible = 0;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const q = this.entries[i];
      const age = now - q.t;
      q.el.classList.toggle('fresh', age < FRESH_MS);
      if (this.open) continue;
      const tooMany = visible >= 5;
      const young = age < ttl && !tooMany;
      if (young) visible++;
      const fade = !young && !tooMany && age < ttl + 700;
      q.el.classList.toggle('fade', fade);
      q.el.classList.toggle('old', !young && !fade);
    }
    if (this.open && !this.entries.length && !this.list.firstChild) {
      const em = document.createElement('div');
      em.className = 'evl-empty';
      em.textContent = 'Keine Meldungen';
      this.list.appendChild(em);
    } else if (this.entries.length) this.list.querySelector('.evl-empty')?.remove();
  }

  /** Über dem Infopanel andocken (dessen Höhe schwankt) */
  private place(): void {
    if (!this.shown) return;
    let h = 0;
    this.root.querySelectorAll<HTMLElement>('.hud-info').forEach((m) => {
      if (m.offsetParent !== null) h = Math.max(h, m.offsetHeight);
    });
    this.wrap.style.bottom = `${12 + (h ? h + 8 : 0)}px`;
  }
}

/** Text ohne Koordinaten-Klammern und Zahlen: Grundlage zum Zusammenfassen */
function baseText(t: string): string {
  return t.replace(/\(\d+\|\d+\)/g, '').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}
