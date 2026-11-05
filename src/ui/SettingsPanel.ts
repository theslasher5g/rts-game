import { bus } from '../core/EventBus';
import { DEFAULT_SETTINGS, type Settings } from '../core/types';
import { Q, QUALITY_LEVELS, isQualityLevel, onQualityChanged, setQuality, type QualityLevel } from '../core/quality';

const STORAGE_KEY = 'ww3.settings';

type NumKey = { [K in keyof Settings]-?: Settings[K] extends number ? K : never }[keyof Settings];
type BoolKey = { [K in keyof Settings]-?: NonNullable<Settings[K]> extends boolean ? K : never }[keyof Settings];

type Control =
  | { kind: 'range'; key: NumKey; label: string; desc: string; min: number; max: number; step: number; fmt: (v: number) => string }
  | { kind: 'bool'; key: BoolKey; label: string; desc: string };

const CONTROLS: Control[] = [
  { kind: 'range', key: 'heightExaggeration', label: 'Höhenüberhöhung', desc: 'Vertikale Skalierung des Geländes', min: 1, max: 15, step: 0.5, fmt: (v) => `${v.toFixed(1)}×` },
  { kind: 'range', key: 'pixelScale', label: 'Pixelgröße', desc: 'Interne Auflösung = Bildschirm / Wert', min: 1, max: 4, step: 1, fmt: (v) => `${v}` },
  { kind: 'bool', key: 'dithering', label: 'Dithering', desc: 'Bayer-Raster + Farbquantisierung' },
  { kind: 'range', key: 'colorBits', label: 'Farbtiefe', desc: 'Bits pro Farbkanal (PS2 ≈ 5)', min: 4, max: 8, step: 1, fmt: (v) => `${v} Bit` },
  { kind: 'range', key: 'politicalOverlay', label: 'Politische Färbung', desc: '0 = reines Gelände', min: 0, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` },
  { kind: 'bool', key: 'allowRotation', label: 'Kamerarotation', desc: 'Q/E und mittlere Maustaste' },
  { kind: 'bool', key: 'edgeScroll', label: 'Randscrollen', desc: 'Kamera am Bildschirmrand bewegen' },
  { kind: 'bool', key: 'showLabels', label: 'Ländernamen', desc: 'Beschriftungen auf der Karte' },
  { kind: 'bool', key: 'showCities', label: 'Städte', desc: 'Städte und Hauptstädte anzeigen' },
  { kind: 'bool', key: 'showRoads', label: 'Straßen & Schienen', desc: 'Straßen-, Schienen- und Fährnetz anzeigen' },
  { kind: 'bool', key: 'fogOfWar', label: 'Nebel des Krieges', desc: 'Gegner nur im Sichtbereich eigener Einheiten sehen' },
  { kind: 'bool', key: 'showFps', label: 'FPS anzeigen', desc: 'Leistungsanzeige (auch Strg+Umschalt+P)' },
];

const QUALITY_LABEL: Record<QualityLevel, string> = { niedrig: 'Niedrig', mittel: 'Mittel', hoch: 'Hoch' };

/** Lädt gespeicherte Einstellungen (localStorage) über DEFAULT_SETTINGS. */
export function loadSettings(): Settings {
  const s: Settings = { ...DEFAULT_SETTINGS };
  // Qualität: Preset aus core/quality (gespeichert oder automatisch erkannt) bestimmt auch die Standard-Pixelgröße
  s.quality = Q.level;
  s.pixelScale = Q.pixelScale;
  s.dithering = Q.dither;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const stored = JSON.parse(raw) as Record<string, unknown>;
      const target = s as unknown as Record<string, unknown>;
      for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
        const v = stored[k];
        if (v !== undefined && typeof v === typeof DEFAULT_SETTINGS[k]) target[k] = v;
      }
      if (!isQualityLevel(s.quality)) s.quality = Q.level;
      if (s.quality !== Q.level) s.quality = Q.level; // ww3.quality ist maßgeblich
    }
  } catch {
    /* localStorage nicht verfügbar oder beschädigt – Standardwerte */
  }
  return s;
}

function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* ignorieren */
  }
}

/**
 * Einstellungsfenster (modal). Die zuletzt erzeugte Instanz ist über
 * `SettingsPanel.instance` erreichbar (genutzt von Hauptmenü und HUD).
 */
export class SettingsPanel {
  static instance: SettingsPanel | null = null;

  private readonly settings: Settings;
  private readonly backdrop: HTMLDivElement;
  private readonly sync: Array<() => void> = [];
  private isOpen = false;

  constructor(root: HTMLElement, settings: Settings) {
    this.settings = settings;
    SettingsPanel.instance = this;
    // Qualitätswechsel (Panel, Konsole, Overlay-Vorschlag): Preset-Standards in die Einstellungen übernehmen
    onQualityChanged((q) => {
      this.settings.quality = q.level;
      this.settings.pixelScale = q.pixelScale;
      this.settings.dithering = q.dither;
      this.sync.forEach((f) => f());
      this.changed();
    });

    this.backdrop = document.createElement('div');
    this.backdrop.className = 'modal-backdrop hidden';
    const modal = document.createElement('div');
    modal.className = 'panel modal settings';
    this.backdrop.appendChild(modal);

    const head = document.createElement('div');
    head.className = 'panel-head';
    const title = document.createElement('span');
    title.textContent = 'Einstellungen';
    const x = document.createElement('button');
    x.className = 'btn btn-sm';
    x.textContent = '✕';
    x.title = 'Schließen (Esc)';
    x.addEventListener('click', () => this.close());
    head.append(title, x);

    const body = document.createElement('div');
    body.className = 'modal-body scroll';
    body.appendChild(this.buildQualityRow());
    for (const c of CONTROLS) body.appendChild(this.buildRow(c));

    const foot = document.createElement('div');
    foot.className = 'set-foot';
    const reset = document.createElement('button');
    reset.className = 'btn';
    reset.textContent = 'Standard';
    reset.addEventListener('click', () => {
      Object.assign(this.settings, DEFAULT_SETTINGS);
      setQuality(Q.level, false);
      this.settings.quality = Q.level;
      this.settings.pixelScale = Q.pixelScale;
      this.settings.dithering = Q.dither;
      this.sync.forEach((f) => f());
      this.changed();
    });
    const ok = document.createElement('button');
    ok.className = 'btn active';
    ok.textContent = 'Schließen';
    ok.addEventListener('click', () => this.close());
    foot.append(reset, ok);

    modal.append(head, body, foot);

    this.backdrop.addEventListener('pointerdown', (e) => {
      if (e.target === this.backdrop) this.close();
    });
    this.backdrop.addEventListener('wheel', (e) => e.stopPropagation());
    window.addEventListener('keydown', (e) => {
      if (this.isOpen && e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.close();
      }
    }, true);

    const layer = document.createElement('div');
    layer.className = 'ui-layer settings-layer';
    layer.style.zIndex = '30';
    layer.appendChild(this.backdrop);
    root.appendChild(layer);
  }

  get opened(): boolean {
    return this.isOpen;
  }

  open(): void {
    this.sync.forEach((f) => f());
    this.backdrop.classList.remove('hidden');
    this.isOpen = true;
  }

  close(): void {
    this.backdrop.classList.add('hidden');
    this.isOpen = false;
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  private changed(): void {
    saveSettings(this.settings);
    bus.emit('settings:changed', { settings: this.settings });
  }

  /** Grafikqualität: drei Schaltflächen (Preset setzt Budgets, Pixelgröße und Dithering) */
  private buildQualityRow(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'set-row';
    const label = document.createElement('label');
    label.textContent = 'Grafikqualität';
    const desc = document.createElement('span');
    desc.className = 'set-desc';
    desc.textContent = 'Sichtweiten, Detailmengen, Effekte, Pixelgröße';
    label.appendChild(desc);
    const group = document.createElement('div');
    group.className = 'set-quality';
    group.style.cssText = 'display:flex;gap:6px';
    const btns = new Map<QualityLevel, HTMLButtonElement>();
    for (const lv of QUALITY_LEVELS) {
      const b = document.createElement('button');
      b.className = 'btn btn-sm';
      b.dataset.quality = lv;
      b.textContent = QUALITY_LABEL[lv];
      b.addEventListener('click', () => {
        setQuality(lv); // der Abonnent im Konstruktor übernimmt Pixelgröße/Dithering und meldet 'settings:changed'
        this.sync.forEach((f) => f());
      });
      btns.set(lv, b);
      group.appendChild(b);
    }
    const val = document.createElement('span');
    val.className = 'set-val';
    this.sync.push(() => {
      for (const [lv, b] of btns) b.classList.toggle('active', lv === Q.level);
    });
    this.sync[this.sync.length - 1]();
    row.append(label, group, val);
    return row;
  }

  private buildRow(c: Control): HTMLElement {
    const row = document.createElement('div');
    row.className = 'set-row';
    const label = document.createElement('label');
    label.textContent = c.label;
    const desc = document.createElement('span');
    desc.className = 'set-desc';
    desc.textContent = c.desc;
    label.appendChild(desc);
    const val = document.createElement('span');
    val.className = 'set-val';

    if (c.kind === 'range') {
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(c.min);
      input.max = String(c.max);
      input.step = String(c.step);
      const id = `set-${c.key}`;
      input.id = id;
      label.htmlFor = id;
      const refresh = () => {
        input.value = String(this.settings[c.key]);
        val.textContent = c.fmt(this.settings[c.key]);
      };
      input.addEventListener('input', () => {
        this.settings[c.key] = Number(input.value);
        val.textContent = c.fmt(this.settings[c.key]);
        this.changed();
      });
      input.addEventListener('keydown', (e) => e.stopPropagation());
      this.sync.push(refresh);
      refresh();
      row.append(label, input, val);
    } else {
      const btn = document.createElement('button');
      btn.className = 'toggle';
      const refresh = () => {
        const on = this.settings[c.key];
        btn.classList.toggle('on', on);
        btn.textContent = on ? 'AN' : 'AUS';
      };
      btn.addEventListener('click', () => {
        this.settings[c.key] = !this.settings[c.key];
        refresh();
        this.changed();
      });
      this.sync.push(refresh);
      refresh();
      row.append(label, btn, val);
    }
    return row;
  }
}
