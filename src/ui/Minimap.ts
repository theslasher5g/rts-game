import { bus } from '../core/EventBus';
import { WATER_LAKE, WATER_RIVER } from '../core/types';
import { getProfile } from '../game/countryData';
import type { GeoData } from '../world/GeoData';

const MM_WIDTH = 300;

/** Gedämpfte Landtöne je MAPCOLOR9 (1..9) */
const TINTS: Array<[number, number, number]> = [
  [120, 116, 92],
  [128, 118, 84], [104, 116, 86], [126, 104, 88], [96, 110, 104], [122, 122, 80],
  [112, 98, 104], [134, 112, 76], [98, 118, 76], [116, 108, 96],
];

/**
 * Minimap unten links: einmalig vorgerendertes Kartenbild + günstige Overlay-Ebene
 * für den Kamera-Ausschnitt. Klick/Ziehen fokussiert die Kamera.
 */
export class Minimap {
  private readonly geo: GeoData;
  private readonly wrap: HTMLDivElement;
  private readonly base: HTMLCanvasElement;
  private readonly overlay: HTMLCanvasElement;
  private readonly bctx: CanvasRenderingContext2D;
  private readonly octx: CanvasRenderingContext2D;
  private readonly w: number;
  private readonly h: number;
  /** Länder-ID je Minimap-Pixel */
  private readonly ids: Uint8Array;
  /** Basisfarben (ohne Hervorhebung) */
  private readonly baseRgb: Uint8ClampedArray;
  private readonly border: Uint8Array;
  private readonly img: ImageData;
  private selectedId = -1;
  private playerId = -1;
  private lastFp = new Float64Array(8).fill(NaN);
  /** 1 = See, 2 = Fluss je Minimap-Pixel (aus allen Rasterzellen des Pixels) */
  private readonly water: Uint8Array;
  /** Besitzer (a3) je Ölfeld-ID; Startwert = Land, in dem das Feld liegt */
  private readonly oilOwner = new Map<number, string>();
  private markersDirty = true;
  private playerA3 = '';
  private dragging = false;

  constructor(root: HTMLElement, geo: GeoData) {
    this.geo = geo;
    this.w = MM_WIDTH;
    this.h = Math.round((MM_WIDTH * geo.heightKm) / geo.widthKm);

    const layer = document.createElement('div');
    layer.className = 'ui-layer';
    this.wrap = document.createElement('div');
    this.wrap.className = 'panel minimap hidden';
    const head = document.createElement('div');
    head.className = 'panel-head';
    const t = document.createElement('span');
    t.textContent = 'Lagekarte';
    head.appendChild(t);
    const cw = document.createElement('div');
    cw.className = 'mm-canvas-wrap';
    this.base = document.createElement('canvas');
    this.overlay = document.createElement('canvas');
    this.overlay.className = 'mm-overlay';
    for (const c of [this.base, this.overlay]) {
      c.width = this.w;
      c.height = this.h;
      c.style.width = `${this.w}px`;
      c.style.height = `${this.h}px`;
    }
    cw.append(this.base, this.overlay);
    this.wrap.append(head, cw);
    layer.appendChild(this.wrap);
    root.appendChild(layer);

    this.bctx = this.base.getContext('2d')!;
    this.octx = this.overlay.getContext('2d')!;
    this.img = this.bctx.createImageData(this.w, this.h);

    // --- Vorberechnung
    const n = this.w * this.h;
    this.ids = new Uint8Array(n);
    this.baseRgb = new Uint8ClampedArray(n * 3);
    this.border = new Uint8Array(n);
    this.water = new Uint8Array(n);
    const sx = geo.width / this.w, sy = geo.height / this.h;
    const heights = new Float32Array(n);
    for (let j = 0; j < this.h; j++) {
      const gj = Math.min(geo.height - 1, Math.floor((j + 0.5) * sy));
      for (let i = 0; i < this.w; i++) {
        const gi = Math.min(geo.width - 1, Math.floor((i + 0.5) * sx));
        const k = gj * geo.width + gi;
        this.ids[j * this.w + i] = geo.countryIds[k];
        heights[j * this.w + i] = geo.heightsKm[k];
      }
    }
    // Flüsse/Seen: jeder Fluss-Treffer im Pixelblock zählt (sonst verschwinden dünne Flüsse beim Verkleinern)
    const bx = Math.max(1, Math.round(sx)), by = Math.max(1, Math.round(sy));
    for (let j = 0; j < this.h; j++) {
      const g0 = Math.floor(j * sy);
      for (let i = 0; i < this.w; i++) {
        const h0 = Math.floor(i * sx);
        let rivers = 0, lakes = 0;
        for (let dj = 0; dj < by; dj++) {
          const gj = Math.min(geo.height - 1, g0 + dj);
          for (let di = 0; di < bx; di++) {
            const f = geo.waterFlags[gj * geo.width + Math.min(geo.width - 1, h0 + di)];
            if (f & WATER_RIVER) rivers++;
            else if (f & WATER_LAKE) lakes++;
          }
        }
        this.water[j * this.w + i] = lakes > (bx * by) / 2 ? 1 : rivers > 0 ? 2 : 0;
      }
    }
    for (let j = 0; j < this.h; j++) {
      for (let i = 0; i < this.w; i++) {
        const p = j * this.w + i;
        const id = this.ids[p];
        const hk = heights[p];
        let r: number, g: number, b: number;
        if (id === 0 && hk <= 0.002) {
          const d = Math.min(1, -hk / 3);
          r = 18 - d * 8; g = 34 - d * 14; b = 52 - d * 16;
        } else {
          const meta = geo.countriesById.get(id);
          const prof = meta ? getProfile(meta.a3) : undefined;
          const tint = prof ? mixTint(prof.color) : TINTS[meta ? meta.mapColor : 0] ?? TINTS[0];
          // einfache Schattierung: Höhe + Hangneigung (Licht aus NW)
          const hw = heights[p - 1 >= j * this.w ? p - 1 : p];
          const hn = heights[j > 0 ? p - this.w : p];
          const shade = clamp(1 + (hk - hw + hk - hn) * 2.2, 0.7, 1.3);
          const lift = Math.min(1, Math.max(0, hk) / 2.5);
          r = (tint[0] * (1 - lift) + 170 * lift) * shade * 0.8;
          g = (tint[1] * (1 - lift) + 160 * lift) * shade * 0.8;
          b = (tint[2] * (1 - lift) + 140 * lift) * shade * 0.8;
          if (id === 0) { r *= 0.7; g *= 0.7; b *= 0.7; }
        }
        const wt = this.water[p];
        if (wt === 1) { r = 40; g = 70; b = 105; } else if (wt === 2) { r = 70; g = 120; b = 170; }
        this.baseRgb[p * 3] = r;
        this.baseRgb[p * 3 + 1] = g;
        this.baseRgb[p * 3 + 2] = b;
        const right = i + 1 < this.w ? this.ids[p + 1] : id;
        const down = j + 1 < this.h ? this.ids[p + this.w] : id;
        if (right !== id || down !== id) this.border[p] = 1;
      }
    }
    this.renderBase(0, 0);

    for (const f of geo.meta.scenario?.oilFields ?? []) {
      const c = geo.countriesById.get(geo.countryAt(f.pos[0], f.pos[1]));
      this.oilOwner.set(f.id, c?.a3 ?? f.country);
    }
    bus.on('oil:field-captured', (e) => {
      this.oilOwner.set(e.fieldId, e.by);
      this.markersDirty = true;
    });

    // --- Eingabe
    const focusAt = (e: PointerEvent) => {
      const rect = this.overlay.getBoundingClientRect();
      const u = clamp((e.clientX - rect.left) / rect.width, 0, 1);
      const v = clamp((e.clientY - rect.top) / rect.height, 0, 1);
      bus.emit('camera:focus', { x: u * geo.widthKm, z: v * geo.heightKm });
    };
    this.overlay.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      this.dragging = true;
      this.overlay.setPointerCapture(e.pointerId);
      focusAt(e);
    });
    this.overlay.addEventListener('pointermove', (e) => {
      if (this.dragging) focusAt(e);
    });
    const end = (e: PointerEvent) => {
      this.dragging = false;
      if (this.overlay.hasPointerCapture(e.pointerId)) this.overlay.releasePointerCapture(e.pointerId);
    };
    this.overlay.addEventListener('pointerup', end);
    this.overlay.addEventListener('pointercancel', end);
    this.overlay.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
    this.overlay.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  show(): void {
    this.wrap.classList.remove('hidden');
  }

  hide(): void {
    this.wrap.classList.add('hidden');
  }

  update(footprint: Array<[number, number]>, selectedId: number, playerId: number): void {
    if (selectedId !== this.selectedId || playerId !== this.playerId) {
      this.renderBase(selectedId, playerId);
      this.playerA3 = this.geo.countriesById.get(playerId)?.a3 ?? '';
      this.markersDirty = true;
    }

    // Overlay nur bei Änderung neu zeichnen
    let changed = false;
    const fp = this.lastFp;
    const n = Math.min(4, footprint.length);
    for (let k = 0; k < n; k++) {
      const p = footprint[k];
      if (Math.abs(p[0] - fp[k * 2]) > 0.5 || Math.abs(p[1] - fp[k * 2 + 1]) > 0.5 || Number.isNaN(fp[k * 2])) {
        changed = true;
        fp[k * 2] = p[0];
        fp[k * 2 + 1] = p[1];
      }
    }
    if (!changed && !this.markersDirty) return;
    this.markersDirty = false;

    const ctx = this.octx;
    ctx.clearRect(0, 0, this.w, this.h);
    this.drawMarkers(ctx);
    if (n < 3) return;
    const kx = this.w / this.geo.widthKm, kz = this.h / this.geo.heightKm;
    ctx.beginPath();
    for (let k = 0; k < n; k++) {
      const x = Math.round(footprint[k][0] * kx) + 0.5;
      const y = Math.round(footprint[k][1] * kz) + 0.5;
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 210, 120, 0.10)';
    ctx.fill();
    ctx.strokeStyle = '#ffd27a';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  /** Ölfelder (Tropfen-Punkt, Rand in Besitzerfarbe) und Basis des Spielers (Quadrat) */
  private drawMarkers(ctx: CanvasRenderingContext2D): void {
    const sc = this.geo.meta.scenario;
    if (!sc) return;
    const kx = this.w / this.geo.widthKm, kz = this.h / this.geo.heightKm;
    for (const f of sc.oilFields) {
      const x = Math.round(f.pos[0] * kx), y = Math.round(f.pos[1] * kz);
      const owner = this.oilOwner.get(f.id) ?? '';
      ctx.fillStyle = ownerColor(owner, '#8b876f');
      ctx.fillRect(x - 3, y - 3, 7, 7);
      ctx.fillStyle = '#14110c';
      ctx.fillRect(x - 2, y - 2, 5, 5);
      ctx.fillStyle = '#ffc75a';
      ctx.fillRect(x - 1, y - 1, 3, 3);
      ctx.fillRect(x, y - 2, 1, 1);
    }
    const home = sc.nations.find((n) => n.a3 === this.playerA3);
    if (home) {
      const x = Math.round(home.hq[0] * kx), y = Math.round(home.hq[1] * kz);
      ctx.fillStyle = '#000';
      ctx.fillRect(x - 5, y - 5, 11, 11);
      ctx.fillStyle = ownerColor(home.a3, '#fff');
      ctx.fillRect(x - 4, y - 4, 9, 9);
      ctx.fillStyle = '#fff';
      ctx.fillRect(x - 1, y - 1, 3, 3);
    }
  }

  private renderBase(selectedId: number, playerId: number): void {
    this.selectedId = selectedId;
    this.playerId = playerId;
    const d = this.img.data;
    const n = this.w * this.h;
    for (let p = 0; p < n; p++) {
      const id = this.ids[p];
      let r = this.baseRgb[p * 3], g = this.baseRgb[p * 3 + 1], b = this.baseRgb[p * 3 + 2];
      if (id !== 0 && id === playerId) {
        r = r * 0.55 + 60; g = g * 0.55 + 120; b = b * 0.55 + 40;
      } else if (id !== 0 && id === selectedId) {
        r = r * 0.6 + 110; g = g * 0.6 + 85; b = b * 0.6 + 20;
      }
      if (this.border[p]) {
        const hi = id !== 0 && (id === playerId || id === selectedId);
        if (hi) { r = 255; g = 220; b = 140; } else { r *= 0.45; g *= 0.45; b *= 0.45; }
      }
      d[p * 4] = r;
      d[p * 4 + 1] = g;
      d[p * 4 + 2] = b;
      d[p * 4 + 3] = 255;
    }
    this.bctx.putImageData(this.img, 0, 0);
  }
}

function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

/** Landton: Mischung aus gedämpftem Gelände-Grün/Braun und Teamfarbe (Teamfarbe bleibt erkennbar) */
function mixTint(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return [100 * 0.7 + r * 0.3, 108 * 0.7 + g * 0.3, 88 * 0.7 + b * 0.3];
}

function ownerColor(a3: string, fallback: string): string {
  return getProfile(a3)?.color ?? fallback;
}
