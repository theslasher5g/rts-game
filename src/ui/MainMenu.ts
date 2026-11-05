import { bus } from '../core/EventBus';
import { getProfile, getRelation, relationClass, relationLabel, START_PROFILES, type StartProfile } from '../game/countryData';
import { SCENARIO_NAME, SCENARIO_NATIONS } from '../game/scenario';
import type { GeoData } from '../world/GeoData';
import { SettingsPanel } from './SettingsPanel';
import { CampaignMenu } from './MissionPanel';
import { LobbyPanel } from './LobbyPanel';
import { getMission } from '../game/missions/campaign';

const SEED_KEY = 'ww3.seed';

const BRIEFING = [
  'Kronland ist über die Grenze gerückt. Valdoria und Marenia stehen allein gegen eine Übermacht an Panzern.',
  'Öl ist die einzige Währung: Jedes Fass bezahlt Produktion und Nachschub – und nur was die Raffinerie erreicht, zählt.',
  'Halte deine Straßen und Brücken, damit die Tankwagen-Konvois durchkommen.',
  'Erobere die Ölfelder der Region und sichere sie mit Einheiten.',
  'Schneide den Nachschub des Gegners ab: Eine gesprengte Brücke hungert eine ganze Armee aus.',
];

/**
 * Startbildschirm für das Szenario: Briefing, drei Nationen-Karten, Kartenseed und Startknopf.
 * Die Karte läuft dahinter weiter; eine Nationenwahl fokussiert die Kamera auf deren Hauptstadt.
 */
export class MainMenu {
  private readonly geo: GeoData;
  private readonly layer: HTMLDivElement;
  private readonly startBtn: HTMLButtonElement;
  private readonly hint: HTMLDivElement;
  private readonly seedInput: HTMLInputElement;
  private readonly cards = new Map<string, HTMLDivElement>();
  private selectedA3: string | null = null;
  private isVisible = false;
  private lobby: LobbyPanel | null = null;
  /** Lobby-Fenster (Mehrspieler): main.ts liest daraus die Sitzung (Transport, Spielerliste) */
  get lobbyPanel(): LobbyPanel | null {
    return this.lobby;
  }

  /**
   * Wird mit dem Seed aufgerufen, wenn „Zufallskarte" / ein neuer Seed bestätigt wird. Solange nichts gesetzt ist,
   * zeigt das Menü nur den Hinweis „Kartengenerator folgt". Der Lead verdrahtet hier die Kartenneuerzeugung.
   */
  onNewMap: ((seed: number) => void) | null = null;

  constructor(root: HTMLElement, geo: GeoData) {
    this.geo = geo;
    this.layer = div('ui-layer main-menu hidden');

    // Titel
    const title = div('mm-title');
    const h1 = document.createElement('h1');
    h1.textContent = 'WW3: EUROPE';
    title.append(h1, div('mm-sub', `${geo.meta.scenario?.name ?? SCENARIO_NAME} – Öl ist die einzige Währung.`), div('mm-ver', 'KLEINE KARTE · ECHTES GELÄNDE · ERFUNDENE LÄNDER'));

    // Briefing (links oben)
    const brief = div('panel mm-brief');
    const bh = div('panel-head');
    bh.append(span('', 'Lagebesprechung'), span('muted', SCENARIO_NAME));
    const bb = div('mm-brief-body');
    const ul = document.createElement('ul');
    for (const line of BRIEFING) {
      const li = document.createElement('li');
      li.textContent = line;
      ul.appendChild(li);
    }
    bb.appendChild(ul);
    bb.appendChild(div('mm-goal', 'ZIEL: Straßen halten · Ölfelder nehmen · Gegnerischen Nachschub kappen'));
    brief.append(bh, bb);

    // Karte & Start (rechts oben)
    const side = div('panel mm-side');
    const sh = div('panel-head');
    sh.append(span('', 'Einsatz'), span('muted', 'Karte'));
    const sb = div('mm-side-body');
    const seedRow = div('mm-seed');
    seedRow.append(span('muted', 'KARTEN-SEED'));
    this.seedInput = document.createElement('input');
    this.seedInput.className = 'mm-seed-input';
    this.seedInput.type = 'text';
    this.seedInput.inputMode = 'numeric';
    this.seedInput.maxLength = 10;
    this.seedInput.spellcheck = false;
    this.seedInput.value = String(this.loadSeed());
    this.seedInput.addEventListener('change', () => this.commitSeed(true));
    this.seedInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') this.commitSeed(true);
    });
    this.seedInput.addEventListener('keyup', (e) => e.stopPropagation());
    const rnd = document.createElement('button');
    rnd.className = 'btn';
    rnd.textContent = '🎲 Zufallskarte';
    rnd.addEventListener('click', () => {
      this.seedInput.value = String(Math.floor(Math.random() * 1_000_000));
      this.commitSeed(true);
    });
    seedRow.append(this.seedInput, rnd);
    const note = div('mm-note', 'Jede Karte hat andere Ölfelder, Straßen und Städte.');
    this.startBtn = document.createElement('button');
    this.startBtn.className = 'btn btn-primary';
    this.startBtn.textContent = '▶ SPIEL STARTEN';
    this.startBtn.disabled = true;
    this.startBtn.addEventListener('click', () => this.start());
    this.hint = div('mm-hint', 'Wähle unten eine Nation.');
    const setBtn = document.createElement('button');
    setBtn.className = 'btn';
    setBtn.textContent = '⚙ Einstellungen';
    setBtn.addEventListener('click', () => SettingsPanel.instance?.toggle());
    // Phase 6: Kampagne (Missionen mit Briefing, Freischaltung in localStorage 'ww3.campaign')
    const campBtn = document.createElement('button');
    campBtn.className = 'btn';
    campBtn.textContent = '★ Kampagne (7 Missionen)';
    const camp = new CampaignMenu(root);
    campBtn.addEventListener('click', () => camp.open());
    camp.onStart = (missionId) => {
      const m = getMission(missionId);
      if (!m) return;
      this.commitSeed(false);
      bus.emit('game:start', { countryA3: m.playerNation, missionId });
      this.hide();
    };
    // Phase 7: Mehrspieler (Lobby für bis zu 4 Spieler)
    const mpBtn = document.createElement('button');
    mpBtn.className = 'btn';
    mpBtn.textContent = '⚔ Mehrspieler';
    this.lobby = new LobbyPanel(root);
    mpBtn.addEventListener('click', () => this.lobby?.open());
    this.lobby.onStart = () => {
      this.hide();
    };
    sb.append(seedRow, note, this.startBtn, campBtn, mpBtn, this.hint, setBtn);
    side.append(sh, sb);

    // Nationen-Karten (unten)
    const cards = div('mm-cards');
    for (const p of START_PROFILES) {
      if (!SCENARIO_NATIONS.some((n) => n.a3 === p.a3 && n.playable)) continue;
      const card = this.buildCard(p);
      this.cards.set(p.a3, card);
      cards.appendChild(card);
    }

    this.layer.append(title, brief, side, cards);
    root.appendChild(this.layer);

    // Anklicken eines Landes auf der Karte wählt die Nation ebenfalls
    bus.on('country:select', ({ id }) => {
      const c = this.geo.countriesById.get(id);
      if (c && getProfile(c.a3) && this.isVisible) this.setSelected(c.a3);
    });
  }

  get visible(): boolean {
    return this.isVisible;
  }

  /** aktueller Kartenseed (Zahl) */
  get seed(): number {
    return this.parseSeed(this.seedInput.value);
  }

  show(): void {
    this.layer.classList.remove('hidden');
    this.isVisible = true;
  }

  hide(): void {
    this.layer.classList.add('hidden');
    this.isVisible = false;
  }

  // ------------------------------------------------------------------ intern

  private loadSeed(): number {
    try {
      const v = localStorage.getItem(SEED_KEY);
      if (v !== null) return this.parseSeed(v);
    } catch {
      /* kein localStorage */
    }
    return this.geo.meta.scenario?.seed ?? 1;
  }

  private parseSeed(v: string): number {
    const n = Math.floor(Number(v.trim()));
    return Number.isFinite(n) && n >= 0 ? n % 4_294_967_295 : this.geo.meta.scenario?.seed ?? 1;
  }

  private commitSeed(announce: boolean): void {
    const seed = this.parseSeed(this.seedInput.value);
    this.seedInput.value = String(seed);
    try {
      localStorage.setItem(SEED_KEY, String(seed));
    } catch {
      /* ignorieren */
    }
    if (!announce) return;
    if (this.onNewMap) this.onNewMap(seed);
    else bus.emit('toast', { msg: `Seed ${seed} gespeichert – Kartengenerator folgt`, kind: 'info' });
  }

  private buildCard(p: StartProfile): HTMLDivElement {
    const card = div('mm-card');
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.style.setProperty('--nation', p.color);

    const head = div('mc-head');
    const txt = div('');
    txt.append(div('mc-name', p.name), div('mc-sub', `${p.government} · ${p.leaderTitle}`));
    head.append(span('flag mc-flag', p.flag), txt, span(`mm-diff diff-${p.difficulty}`, p.difficulty));
    card.appendChild(head);
    card.appendChild(div('mc-blurb', p.blurb));

    const mil = div('cd-mil');
    const cell = (v: string, k: string) => {
      const c = div('');
      c.append(span('v', v), span('k', k));
      mil.appendChild(c);
    };
    cell(String(Math.round(p.manpower)) + 'k', 'Soldaten');
    cell(String(p.tanks), 'Panzer');
    cell(String(p.ifv), 'SPz');
    cell(String(p.artillery), 'Artillerie');
    card.append(div('sect-title', 'Startstreitkräfte'), mil);

    const rel = div('mc-rel');
    for (const o of START_PROFILES) {
      if (o.a3 === p.a3) continue;
      const v = getRelation(p.a3, o.a3);
      rel.append(span('', `${o.flag} ${o.short}`), span(relationClass(v), relationLabel(v)));
    }
    card.append(div('sect-title', 'Lage'), rel);

    card.append(div('sect-title', 'Stärken'), bullets(p.strengths.slice(0, 2), false));
    card.append(div('sect-title', 'Schwächen'), bullets(p.weaknesses.slice(0, 2), true));

    card.addEventListener('click', () => this.pick(p.a3));
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        this.pick(p.a3);
      }
    });
    return card;
  }

  private pick(a3: string): void {
    this.setSelected(a3);
    const c = this.geo.countriesByA3.get(a3);
    if (c) bus.emit('country:select', { id: c.id });
    const [x, z] = this.capitalPos(a3);
    bus.emit('camera:focus', { x, z, distance: 90 });
  }

  /** Hauptstadtposition (km): Szenariodaten, sonst Hauptstadt aus den Städten, sonst Länder-Label */
  private capitalPos(a3: string): [number, number] {
    const m = this.geo.meta;
    const st = m.scenario?.nations.find((n) => n.a3 === a3);
    const city = st ? m.cities[st.capitalCity] : m.cities.find((c) => c.country === a3 && c.capital);
    if (city) return [city.pos[0], city.pos[1]];
    const c = this.geo.countriesByA3.get(a3);
    return c ? [c.label[0], c.label[1]] : [this.geo.widthKm / 2, this.geo.heightKm / 2];
  }

  private setSelected(a3: string | null): void {
    if (this.selectedA3 && this.selectedA3 !== a3) this.cards.get(this.selectedA3)?.classList.remove('active');
    this.selectedA3 = a3;
    this.cards.get(a3 ?? '')?.classList.add('active');
    const p = a3 ? getProfile(a3) : undefined;
    this.startBtn.disabled = !p;
    this.hint.textContent = p ? `Kommando übernehmen: ${p.name}` : 'Wähle unten eine Nation.';
  }

  private start(): void {
    if (!this.selectedA3 || !getProfile(this.selectedA3)) return;
    this.commitSeed(false);
    bus.emit('game:start', { countryA3: this.selectedA3 });
    this.hide();
  }
}

function bullets(items: string[], negative: boolean): HTMLUListElement {
  const ul = document.createElement('ul');
  ul.className = negative ? 'bullets neg-list' : 'bullets';
  items.forEach((t, i) => {
    const li = document.createElement('li');
    li.textContent = t;
    if (i > 0) li.className = 'mc-more';
    ul.appendChild(li);
  });
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
