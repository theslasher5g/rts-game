import * as THREE from 'three';
import type { Settings } from '../core/types';
import type { GeoData } from '../world/GeoData';

interface Label {
  el: HTMLDivElement;
  kind: 'country' | 'city';
  /** Länder-ID (nur Länder) */
  id: number;
  capital: boolean;
  wx: number;
  wz: number;
  pos: THREE.Vector3;
  /** sichtbar bis zu dieser Kameradistanz (km) */
  maxDist: number;
  /** ausgeblendet unterhalb dieser Distanz (große Länder aus nächster Nähe) */
  minDist: number;
  /** Ausdehnung des Landes in km (Schriftgrößen-Skalierung) */
  sizeKm: number;
  /** geschätzte Textbreite/-höhe in px bei Skalierung 1 */
  w: number;
  h: number;
  basePriority: number;
  priority: number;
  // zuletzt geschriebene DOM-Werte (Schreibzugriffe vermeiden)
  shown: boolean;
  lastOpacity: number;
  lastX: number;
  lastY: number;
  lastScale: number;
}

const MAX_RECTS = 512;
const BASE_COUNTRY_PX = 16;
/** Referenz-Kartengröße (km): auf die kleine Szenario-Karte (≈ 300 × 200) sind alle Schwellen abgestimmt */
const REF_SPAN_KM = 330;

/**
 * HTML-Beschriftungen für Länder und Städte, pro Frame projiziert.
 * DOM-Elemente werden einmalig erzeugt und nur per transform/opacity bewegt.
 */
export class Labels {
  private readonly geo: GeoData;
  private settings: Settings;
  private readonly labels: Label[] = [];
  private order: Label[] = [];
  private readonly tmp = new THREE.Vector3();
  private readonly rects = new Float32Array(MAX_RECTS * 4);
  private selectedId = 0;
  private playerId = 0;

  constructor(container: HTMLElement, geo: GeoData, settings: Settings) {
    this.geo = geo;
    this.settings = settings;

    // Schwellen in km für die 300×200-Karte; größere Karten skalieren (gedeckelt) mit
    const span = Math.max(geo.widthKm, geo.heightKm);
    const k = clamp(span / REF_SPAN_KM, 1, 4);
    const frag = document.createDocumentFragment();
    for (const c of geo.meta.countries) {
      if (c.cells < 4) continue;
      const sizeKm = Math.sqrt(c.cells * geo.cellKm * geo.cellKm);
      const el = document.createElement('div');
      el.className = 'lbl lbl-country';
      el.textContent = c.name;
      el.style.display = 'none';
      frag.appendChild(el);
      const len = c.name.length;
      this.labels.push({
        el, kind: 'country', id: c.id, capital: false,
        wx: c.label[0], wz: c.label[1], pos: new THREE.Vector3(),
        // Ländernamen: schon aus der Gesamtansicht (und weiter weg) sichtbar, erst aus sehr großer Nähe ausgeblendet
        maxDist: span * 2.5,
        minDist: sizeKm * 0.3,
        sizeKm,
        w: len * BASE_COUNTRY_PX * (0.55 + 0.32) + 4,
        h: BASE_COUNTRY_PX * 1.25,
        basePriority: 1_000_000 + c.cells,
        priority: 0,
        shown: false, lastOpacity: -1, lastX: NaN, lastY: NaN, lastScale: NaN,
      });
    }
    for (const city of geo.meta.cities) {
      const el = document.createElement('div');
      el.className = city.capital ? 'lbl lbl-city cap' : 'lbl lbl-city';
      el.textContent = city.name;
      el.style.display = 'none';
      frag.appendChild(el);
      const px = city.capital ? 13 : 11;
      this.labels.push({
        el, kind: 'city', id: 0, capital: city.capital,
        wx: city.pos[0], wz: city.pos[1], pos: new THREE.Vector3(),
        // Hauptstädte immer (auch Gesamtansicht); Städte ab 15k unter ~150 km, größere früher, Dörfer nur nah
        maxDist: city.capital ? span * 2.5 : (city.pop >= 100_000 ? 260 : city.pop >= 15_000 ? 150 : 60) * k,
        minDist: 0,
        sizeKm: 0,
        w: city.name.length * px * 0.6 + 12,
        h: px * 1.3,
        basePriority: (city.capital ? 900_000 : 0) + Math.min(city.pop / 100, 400_000),
        priority: 0,
        shown: false, lastOpacity: -1, lastX: NaN, lastY: NaN, lastScale: NaN,
      });
    }
    container.appendChild(frag);
    this.updateHeights();
    this.sortOrder();
  }

  applySettings(s: Settings): void {
    this.settings = s;
    this.updateHeights();
  }

  setSelected(id: number): void {
    if (id === this.selectedId) return;
    this.selectedId = id;
    this.refreshClasses();
  }

  setPlayer(id: number): void {
    if (id === this.playerId) return;
    this.playerId = id;
    this.refreshClasses();
  }

  update(camera: THREE.PerspectiveCamera, width: number, height: number): void {
    const s = this.settings;
    const showCountries = s.showLabels;
    const showCities = s.showLabels && s.showCities;
    const cam = camera.position;
    const halfW = width * 0.5, halfH = height * 0.5;
    const rects = this.rects;
    let nRects = 0;
    // Pixel pro km bei Distanz 1 (für Schriftgröße)
    const pxPerUnit = height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5));

    for (let i = 0; i < this.order.length; i++) {
      const L = this.order[i];
      let visible = L.kind === 'country' ? showCountries : showCities;
      let opacity = 0;
      let x = 0, y = 0, scale = 1, w = 0, h = 0;

      if (visible) {
        const dist = cam.distanceTo(L.pos);
        const isSpecial = L.kind === 'country' && (L.id === this.selectedId || L.id === this.playerId);
        const maxD = isSpecial ? L.maxDist * 1.6 : L.maxDist;
        if (dist > maxD || dist < L.minDist) visible = false;
        else {
          this.tmp.copy(L.pos).project(camera);
          const nz = this.tmp.z;
          if (nz < -1 || nz > 1) visible = false;
          else {
            x = (this.tmp.x * halfW) + halfW;
            y = (-this.tmp.y * halfH) + halfH;
            if (L.kind === 'country') {
              const px = (L.sizeKm / dist) * pxPerUnit * 0.09;
              scale = clamp(px, 10, 26) / BASE_COUNTRY_PX;
              // Ein- und Ausblenden an den Grenzen
              const fadeFar = clamp((maxD - dist) / (maxD * 0.25), 0, 1);
              const fadeNear = L.minDist > 0 ? clamp((dist - L.minDist) / (L.minDist * 0.6), 0, 1) : 1;
              opacity = fadeFar * fadeNear;
            } else {
              opacity = clamp((maxD - dist) / (maxD * 0.2), 0, 1);
            }
            w = L.w * scale;
            h = L.h * scale;
            // Länder zentriert, Städte links verankert (Punkt an Position)
            const left = L.kind === 'country' ? x - w * 0.5 : x - 4;
            const top = y - h * 0.5;
            if (left + w < 0 || top + h < 0 || left > width || top > height || opacity < 0.04) visible = false;
            else {
              // Überlappung (gierig, nach Priorität sortiert)
              for (let r = 0; r < nRects; r++) {
                const o = r * 4;
                if (left < rects[o + 2] && left + w > rects[o] && top < rects[o + 3] && top + h > rects[o + 1]) {
                  visible = false;
                  break;
                }
              }
              if (visible && nRects < MAX_RECTS) {
                const o = nRects * 4;
                rects[o] = left - 2;
                rects[o + 1] = top - 1;
                rects[o + 2] = left + w + 2;
                rects[o + 3] = top + h + 1;
                nRects++;
              }
              if (visible) {
                x = left;
                y = top;
              }
            }
          }
        }
      }

      if (!visible) {
        if (L.shown) {
          L.el.style.display = 'none';
          L.shown = false;
        }
        continue;
      }
      if (!L.shown) {
        L.el.style.display = '';
        L.shown = true;
      }
      const op = Math.round(opacity * 20) / 20;
      if (op !== L.lastOpacity) {
        L.el.style.opacity = String(op);
        L.lastOpacity = op;
      }
      const tx = Math.round(x), ty = Math.round(y);
      const sc = Math.round(scale * 50) / 50;
      if (tx !== L.lastX || ty !== L.lastY || sc !== L.lastScale) {
        L.el.style.transform = L.kind === 'country' ? `translate(${tx}px,${ty}px) scale(${sc})` : `translate(${tx}px,${ty}px)`;
        L.lastX = tx;
        L.lastY = ty;
        L.lastScale = sc;
      }
    }
  }

  private updateHeights(): void {
    const ex = this.settings.heightExaggeration;
    for (const L of this.labels) {
      const hKm = Math.max(this.geo.heightAt(L.wx, L.wz), 0);
      L.pos.set(L.wx, hKm * ex + (L.kind === 'country' ? 2 : 1), L.wz);
    }
  }

  private refreshClasses(): void {
    for (const L of this.labels) {
      if (L.kind !== 'country') continue;
      L.el.classList.toggle('sel', L.id === this.selectedId && L.id !== 0);
      L.el.classList.toggle('player', L.id === this.playerId && L.id !== 0);
    }
    this.sortOrder();
  }

  private sortOrder(): void {
    for (const L of this.labels) {
      let p = L.basePriority;
      if (L.kind === 'country' && L.id !== 0) {
        if (L.id === this.playerId) p += 1e9;
        if (L.id === this.selectedId) p += 2e9;
      }
      L.priority = p;
    }
    this.order = this.labels.slice().sort((a, b) => b.priority - a.priority);
  }
}

function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}
