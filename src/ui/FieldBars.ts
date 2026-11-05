import './abilities.css';
import * as THREE from 'three';
import type { OilEconomy } from '../logistics/OilEconomy';
import type { OilFieldInfo } from '../logistics/types';

export interface FieldBarsOptions {
  /** Geländehöhe in Welt-Y (Überhöhung eingerechnet) am Feld, Standard 0 */
  groundY?: (x: number, z: number) => number;
  /** Sichtbarkeitsfilter (z. B. Nebel des Krieges: nur erkundete Orte) */
  isVisible?: (x: number, z: number) => boolean;
  /** Anzeige nur, wenn die Kamera näher als dieser Abstand (km) am Feld ist (Standard 150) */
  maxDistanceKm?: number;
  /** Höchstzahl gleichzeitiger Balken (Standard 8) */
  max?: number;
}

/**
 * Phase 7 – Eroberungsbalken über Ölfeldern: für Felder mit `captureProgress` > 0 ein kleiner, am Feld verankerter
 * Fortschrittsbalken (DOM, aus der Kamera projiziert) in der Farbe des Eroberers. Pro Frame `update()` aufrufen.
 */
export class FieldBars {
  private readonly layer: HTMLDivElement;
  private readonly pool: Array<{ el: HTMLDivElement; fill: HTMLElement; label: HTMLElement }> = [];
  private readonly v = new THREE.Vector3();
  private readonly economy: OilEconomy;
  private readonly getCamera: () => THREE.PerspectiveCamera;
  private readonly colour: (a3: string) => string;
  private readonly opts: FieldBarsOptions;
  private active = 0;

  constructor(root: HTMLElement, economy: OilEconomy, getCamera: () => THREE.PerspectiveCamera, nationColour: (a3: string) => string, opts: FieldBarsOptions = {}) {
    this.economy = economy;
    this.getCamera = getCamera;
    this.colour = nationColour;
    this.opts = opts;
    this.layer = document.createElement('div');
    this.layer.className = 'fb-layer';
    // hinter allen Panels, über dem Canvas
    root.insertBefore(this.layer, root.firstChild);
  }

  dispose(): void {
    this.layer.remove();
  }

  /** Anzahl aktuell sichtbarer Balken (Tests) */
  get visibleCount(): number {
    return this.active;
  }

  update(): void {
    const cam = this.getCamera();
    const maxD = this.opts.maxDistanceKm ?? 150;
    const max = this.opts.max ?? 8;
    const W = this.layer.clientWidth || window.innerWidth, H = this.layer.clientHeight || window.innerHeight;
    const cands: Array<{ f: OilFieldInfo; d: number }> = [];
    for (const f of this.economy.fields) {
      const p = f.captureProgress ?? 0;
      if (p <= 0.001) continue;
      const d = Math.hypot(cam.position.x - f.x, cam.position.z - f.z, cam.position.y - (this.opts.groundY?.(f.x, f.z) ?? 0));
      if (d > maxD) continue;
      if (this.opts.isVisible && !this.opts.isVisible(f.x, f.z)) continue;
      cands.push({ f, d });
    }
    cands.sort((a, b) => a.d - b.d);
    let n = 0;
    for (const c of cands) {
      if (n >= max) break;
      const f = c.f;
      const y = (this.opts.groundY?.(f.x, f.z) ?? 0) + 0.25;
      this.v.set(f.x, y, f.z).project(cam);
      if (this.v.z > 1 || this.v.z < -1 || Math.abs(this.v.x) > 1.1 || Math.abs(this.v.y) > 1.1) continue;
      const slot = this.slot(n);
      const sx = (this.v.x * 0.5 + 0.5) * W, sy = (-this.v.y * 0.5 + 0.5) * H - 18;
      slot.el.style.display = '';
      slot.el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px)`;
      const pct = Math.min(1, f.captureProgress ?? 0);
      slot.fill.style.width = `${(pct * 100).toFixed(0)}%`;
      slot.fill.style.background = this.colour(f.capturer ?? '');
      slot.label.textContent = `${f.name} ${Math.round(pct * 100)} %`;
      n++;
    }
    for (let i = n; i < this.pool.length; i++) this.pool[i].el.style.display = 'none';
    this.active = n;
  }

  private slot(i: number) {
    while (this.pool.length <= i) {
      const el = document.createElement('div');
      el.className = 'fb-bar';
      el.style.display = 'none';
      const fill = document.createElement('i');
      const label = document.createElement('span');
      el.append(label, fill);
      this.layer.appendChild(el);
      this.pool.push({ el, fill, label });
    }
    return this.pool[i];
  }
}
