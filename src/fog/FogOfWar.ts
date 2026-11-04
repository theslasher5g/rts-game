/**
 * Phase 6 – Nebel des Krieges.
 *
 * Sichtraster 0.5 km (600×400): `vis` = aktuell sichtbar für die Seite des Spielers (Spieler + Verbündete),
 * `explored` = jemals gesehen (bleibt). Sichtberechnung je eigener/verbündeter Einheit und je Standort:
 * radiale Strahlen über ein auf 0.5 km reduziertes Höhenraster (Maximum je Zelle als Kammhöhe, Mittel als Zielhöhe)
 * mit Horizontwinkel (steilster bisher gesehener Geländewinkel) – ein Strahl endet an Rauch. Höhere Standorte sehen weiter.
 * Die Berechnung läuft in Jobs (Intervall ~0.3 s realer Zeit, Zeitbudget je update()), das Ergebnis wird atomar übernommen.
 * Nicht berücksichtigt (keine Daten): Vegetation und Gebäude als Sichtblocker.
 */
import * as THREE from 'three';
import { bus } from '../core/EventBus';
import type { Settings } from '../core/types';
import type { SmokeQuery } from '../combat/types';
import type { Unit } from '../units/types';
import type { UnitManager } from '../units/UnitManager';
import type { GeoData } from '../world/GeoData';
import { setFogUniforms, type FogUniforms } from './fogShader';

export interface FogOptions {
  /** a3 des Spielers (null = kein Spiel: alles sichtbar) */
  player: () => string | null;
  /** Verbündete eines Landes (a3 ohne das Land selbst oder mit – egal) */
  allies: (a3: string) => string[];
  smoke?: SmokeQuery;
}

export interface FogEconomyLike {
  bases: Map<number, { x: number; z: number; owner: string; kind?: string; progress?: number }>;
  fields: Array<{ id: number; x: number; z: number; owner: string; integrity?: number }>;
}

const CELL_KM = 0.5;
const JOB_INTERVAL = 0.3;       // s reale Zeit zwischen Berechnungen
const BUDGET_MS = 3;            // Zeitbudget je update()
const SYNC_INTERVAL_H = 3;      // Spielstunden zwischen syncFromEconomy
const MAX_R_GROUND_KM = 15;
const MAX_R_AIR_KM = 25;
const SMOKE_BLOCK = 0.03;
const TOL_KM = 0.001;           // 1 m Toleranz gegen Rasterrauschen

interface Site { x: number; z: number; r: number; owner: string }
interface TimedReveal { x: number; z: number; r: number; until: number }

export class FogOfWar {
  readonly cols: number;
  readonly rows: number;
  readonly cellKm = CELL_KM;
  readonly widthKm: number;
  readonly heightKm: number;
  /** R = sichtbar (0/255), G = erkundet (0/255) */
  readonly texture: THREE.DataTexture;
  /** CPU-Raster (committed) */
  readonly vis: Uint8Array;
  readonly explored: Uint8Array;

  private readonly geo: GeoData;
  private readonly units: UnitManager;
  private readonly opts: FogOptions;
  private smoke?: SmokeQuery;
  private readonly hMax: Float32Array;
  private readonly hAvg: Float32Array;
  private next: Uint8Array;
  private readonly texData: Uint8Array;
  private enabled = true;
  private _epoch = 1;
  private timer = 1e9;
  private realTime = 0;
  private gameHours = 0;
  private syncAt = -1;

  // Job
  private jobActive = false;
  private jobCursor = 0;
  private obs: number[] = []; // x, z, eye, R, air(0/1)
  private snap: number[] = [];  // Beobachter der letzten übernommenen Berechnung (für Luftziele)

  private friendly = new Set<string>();
  private playerA3: string | null = null;
  private readonly sites = new Map<string, Site>();
  private readonly synced = new Set<string>();
  private nextSiteId = 1;
  private reveals: TimedReveal[] = [];
  private economy: FogEconomyLike | null = null;
  private terrainBound: { setFogEnabled(on: boolean): void } | null = null;
  private lastTerrainOn: boolean | null = null;
  private extraUniforms: FogUniforms[] = [];

  // Sichtbarkeits-Cache je Einheit (Epoche)
  private vEpoch = new Int32Array(1024);
  private vVal = new Uint8Array(1024);

  /** Debug/Test */
  stats = { lastJobMs: 0, lastObservers: 0, jobs: 0, samples: 0, newlyExplored: 0 };

  constructor(geo: GeoData, units: UnitManager, opts: FogOptions) {
    this.geo = geo;
    this.units = units;
    this.opts = opts;
    this.smoke = opts.smoke;
    this.widthKm = geo.widthKm;
    this.heightKm = geo.heightKm;
    this.cols = Math.ceil(geo.widthKm / CELL_KM);
    this.rows = Math.ceil(geo.heightKm / CELL_KM);
    const n = this.cols * this.rows;
    this.vis = new Uint8Array(n);
    this.next = new Uint8Array(n);
    this.explored = new Uint8Array(n);
    this.texData = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) this.texData[i * 4 + 3] = 255;
    this.texture = new THREE.DataTexture(this.texData, this.cols, this.rows, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;

    // Reduziertes Höhenraster
    this.hMax = new Float32Array(n);
    this.hAvg = new Float32Array(n);
    const f = Math.max(1, Math.round(CELL_KM / geo.cellKm));
    for (let j = 0; j < this.rows; j++) {
      for (let i = 0; i < this.cols; i++) {
        let mx = -1e9, sum = 0, c = 0;
        for (let dj = 0; dj < f; dj++) {
          const gj = Math.min(geo.height - 1, j * f + dj);
          for (let di = 0; di < f; di++) {
            const h = Math.max(geo.heightsKm[gj * geo.width + Math.min(geo.width - 1, i * f + di)], 0);
            if (h > mx) mx = h;
            sum += h;
            c++;
          }
        }
        this.hMax[j * this.cols + i] = mx;
        this.hAvg[j * this.cols + i] = sum / c;
      }
    }
    this.refreshSides();
  }

  // ------------------------------------------------------------------ Konfiguration

  /** true = Nebel aktiv (Spieler gesetzt und nicht abgeschaltet) */
  get active(): boolean {
    return this.enabled && this.playerA3 !== null;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Zähler, der sich bei jeder übernommenen Berechnung erhöht (Minimap/Renderer-Caches) */
  get epoch(): number {
    return this._epoch;
  }

  setEnabled(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    this._epoch++;
    this.pushTerrain();
  }

  applySettings(s: Settings): void {
    this.setEnabled(s.fogOfWar !== false);
  }

  setSmoke(q: SmokeQuery | undefined): void {
    this.smoke = q;
  }

  /** Komfort: Terrain-Fog verdrahten (Textur + Ein/Aus werden gepflegt) */
  bindTerrain(t: { setFogTexture(tex: THREE.Texture | null, widthKm: number, heightKm: number): void; setFogEnabled(on: boolean): void }): void {
    t.setFogTexture(this.texture, this.widthKm, this.heightKm);
    this.terrainBound = t;
    this.lastTerrainOn = null;
    this.pushTerrain();
  }

  /** Weitere Uniform-Sätze (eigene Shader/Materialien mit applyFogToMaterial) mit Textur und Ein/Aus versorgen */
  bindUniforms(u: FogUniforms): void {
    setFogUniforms(u, this.texture, this.widthKm, this.heightKm);
    u.uFogOn.value = this.active ? 1 : 0;
    this.extraUniforms.push(u);
  }

  private pushTerrain(): void {
    const on = this.active;
    if (this.lastTerrainOn !== on) {
      this.lastTerrainOn = on;
      this.terrainBound?.setFogEnabled(on);
      for (const u of this.extraUniforms) u.uFogOn.value = on ? 1 : 0;
    }
  }

  // ------------------------------------------------------------------ Abfragen

  private idx(x: number, z: number): number {
    const i = Math.floor(x / CELL_KM), j = Math.floor(z / CELL_KM);
    if (i < 0 || j < 0 || i >= this.cols || j >= this.rows) return -1;
    return j * this.cols + i;
  }

  /** a3 gehört zur Seite des Spielers (Spieler + Verbündete) */
  isFriendly(a3: string): boolean {
    return this.friendly.has(a3);
  }

  /**
   * Aktuell sichtbar für die Seite des Spielers (forA3 = Seite des Spielers oder ohne Angabe) – für andere Nationen
   * (KI) gilt keine Nebel-Einschränkung: true.
   */
  isVisible(x: number, z: number, forA3?: string): boolean {
    if (!this.active) return true;
    if (forA3 !== undefined && !this.friendly.has(forA3)) return true;
    const k = this.idx(x, z);
    return k >= 0 && this.vis[k] !== 0;
  }

  isExplored(x: number, z: number): boolean {
    if (!this.active) return true;
    const k = this.idx(x, z);
    return k >= 0 && this.explored[k] !== 0;
  }

  /** Eigene/verbündete Einheiten immer sichtbar; fremde nur im Sichtbereich (Luftziele auch ohne Geländesicht in Reichweite) */
  isUnitVisible(u: Unit): boolean {
    if (!this.active) return true;
    if (this.friendly.has(u.owner)) return true;
    const id = u.id;
    if (id >= 0 && id < 1 << 20) {
      if (id >= this.vEpoch.length) this.growCache(id);
      if (this.vEpoch[id] === this._epoch) return this.vVal[id] === 1;
      const v = this.computeUnitVisible(u);
      this.vEpoch[id] = this._epoch;
      this.vVal[id] = v ? 1 : 0;
      return v;
    }
    return this.computeUnitVisible(u);
  }

  private growCache(id: number): void {
    const n = Math.max(this.vEpoch.length * 2, id + 1);
    const e = new Int32Array(n), v = new Uint8Array(n);
    e.set(this.vEpoch);
    v.set(this.vVal);
    this.vEpoch = e;
    this.vVal = v;
  }

  private computeUnitVisible(u: Unit): boolean {
    const k = this.idx(u.x, u.z);
    if (k >= 0 && this.vis[k]) return true;
    // Luftziele: sichtbar, wenn ein eigener Beobachter in 70 % seiner Sichtweite ist (kein Geländeschatten am Himmel)
    if (u.airborne && u.type.mobility.domain === 'air') {
      const s = this.snap;
      for (let o = 0; o < s.length; o += 5) {
        const r = s[o + 3] * 0.7;
        const dx = u.x - s[o], dz = u.z - s[o + 1];
        if (dx * dx + dz * dz <= r * r) return true;
      }
    }
    return false;
  }

  // ------------------------------------------------------------------ Standorte & Aufklärung

  /** Statischer Beobachter (Basis/Feld/HQ). Rückgabe: ID für removeStaticObserver. */
  addStaticObserver(x: number, z: number, r: number, owner: string): number {
    const id = this.nextSiteId++;
    this.sites.set(`s${id}`, { x, z, r, owner });
    return id;
  }
  removeStaticObserver(id: number): void {
    this.sites.delete(`s${id}`);
  }
  registerSite(x: number, z: number, r: number, owner: string): number {
    return this.addStaticObserver(x, z, r, owner);
  }
  unregister(id: number): void {
    this.removeStaticObserver(id);
  }

  /** Wirkt auf Basen/Felder aus der Wirtschaft; wird alle paar Spielstunden aus update() aufgerufen. */
  attachEconomy(e: FogEconomyLike | null): void {
    this.economy = e;
    this.syncAt = -1;
  }

  syncFromEconomy(economy: FogEconomyLike = this.economy as FogEconomyLike): void {
    if (!economy) return;
    for (const k of this.synced) this.sites.delete(k);
    this.synced.clear();
    for (const [id, b] of economy.bases) {
      if (!this.friendly.has(b.owner)) continue;
      const done = b.progress === undefined || b.progress >= 1;
      const r = (b.kind === 'hq' ? 3 : 2.5) * (done ? 1 : 0.5);
      const key = `b${id}`;
      this.sites.set(key, { x: b.x, z: b.z, r, owner: b.owner });
      this.synced.add(key);
    }
    for (const f of economy.fields) {
      if (!f.owner || !this.friendly.has(f.owner)) continue;
      const key = `f${f.id}`;
      this.sites.set(key, { x: f.x, z: f.z, r: 2.5, owner: f.owner });
      this.synced.add(key);
    }
  }

  /**
   * Skriptaufdeckung: Scheibe wird dauerhaft als "erkundet" markiert; mit durationSec > 0 zusätzlich
   * für diese Zeit (reale Sekunden) voll sichtbar (ohne Geländeprüfung). forA3 muss zur Seite des Spielers gehören.
   */
  revealArea(x: number, z: number, r: number, forA3?: string, durationSec = 0): void {
    if (forA3 !== undefined && !this.friendly.has(forA3)) return;
    const added = this.disc(this.explored, x, z, r);
    if (durationSec > 0) {
      this.reveals.push({ x, z, r, until: this.realTime + durationSec });
      this.disc(this.vis, x, z, r);
      this._epoch++;
    }
    this.writeTexture();
    this._epoch++;
    if (added > 0) bus.emit('fog:revealed', { a3: forA3 ?? this.playerA3 ?? '', cells: added });
  }

  /** Markiert eine Scheibe in arr (Rückgabe: neu gesetzte Zellen) */
  private disc(arr: Uint8Array, x: number, z: number, r: number): number {
    const cx = x / CELL_KM, cz = z / CELL_KM, rc = r / CELL_KM;
    const i0 = Math.max(0, Math.floor(cx - rc)), i1 = Math.min(this.cols - 1, Math.ceil(cx + rc));
    const j0 = Math.max(0, Math.floor(cz - rc)), j1 = Math.min(this.rows - 1, Math.ceil(cz + rc));
    let c = 0;
    const r2 = rc * rc;
    for (let j = j0; j <= j1; j++) {
      const dz = j + 0.5 - cz;
      for (let i = i0; i <= i1; i++) {
        const dx = i + 0.5 - cx;
        if (dx * dx + dz * dz <= r2) {
          const k = j * this.cols + i;
          if (!arr[k]) { arr[k] = 1; c++; }
        }
      }
    }
    return c;
  }

  // ------------------------------------------------------------------ Update

  private refreshSides(): void {
    const p = this.opts.player();
    this.playerA3 = p;
    this.friendly.clear();
    if (p) {
      this.friendly.add(p);
      for (const a of this.opts.allies(p)) this.friendly.add(a);
    }
  }

  update(dtGameHours: number, realDt: number): void {
    this.realTime += realDt;
    this.gameHours += dtGameHours;
    const p = this.opts.player();
    if (p !== this.playerA3) {
      this.refreshSides();
      this.explored.fill(0);
      this.vis.fill(0);
      this._epoch++;
      this.jobActive = false;
      this.timer = 1e9;
      this.syncAt = -1;
      this.pushTerrain();
      if (p) this.writeTexture();
    }
    this.pushTerrain();
    if (!this.active) return;
    if (this.economy && (this.syncAt < 0 || this.gameHours >= this.syncAt)) {
      this.syncAt = this.gameHours + SYNC_INTERVAL_H;
      this.syncFromEconomy(this.economy);
    }
    this.timer += realDt;
    if (!this.jobActive) {
      if (this.timer < JOB_INTERVAL) return;
      this.timer = 0;
      this.beginJob();
    }
    this.runJob(BUDGET_MS);
  }

  /** Erzwingt eine vollständige Neuberechnung jetzt (Start/Tests) */
  updateNow(): void {
    this.refreshSides();
    this.syncAt = -1;
    if (this.economy) this.syncFromEconomy(this.economy);
    this.beginJob();
    this.runJob(1e9);
  }

  private beginJob(): void {
    const t0 = now();
    this.jobActive = true;
    this.jobCursor = 0;
    this.next.fill(0);
    const obs: number[] = (this.obs = []);
    const us = this.units.units;
    for (let i = 0; i < us.length; i++) {
      const u = us[i];
      if (u.hp <= 0 || !this.friendly.has(u.owner)) continue;
      const t = u.type;
      const cat = t.category;
      const airborne = !!u.airborne && t.mobility.domain === 'air';
      let eye: number;
      let r = t.sightKm;
      if (airborne) {
        eye = cat === 'jet' ? 0.8 : cat === 'drone' ? 0.25 : 0.12;
        r = Math.min(r, MAX_R_AIR_KM);
      } else {
        eye = cat === 'infantry' ? 0.0018 : cat === 'recon' ? 0.004 : t.mobility.domain === 'naval' ? 0.015 : 0.003;
        if (u.garrisonId) { r *= 1.25; eye += 0.006; }
        r = Math.min(r, MAX_R_GROUND_KM);
      }
      obs.push(u.x, u.z, eye, r, airborne ? 1 : 0);
    }
    for (const s of this.sites.values()) {
      if (!this.friendly.has(s.owner)) continue;
      obs.push(s.x, s.z, 0.012, s.r, 0);
    }
    this.stats.lastObservers = obs.length / 5;
    this.stats.lastJobMs = now() - t0;
  }

  private runJob(budgetMs: number): void {
    if (!this.jobActive) return;
    const t0 = now();
    const obs = this.obs;
    const total = obs.length;
    let samples = 0;
    while (this.jobCursor < total) {
      const o = this.jobCursor;
      samples += this.observe(obs[o], obs[o + 1], obs[o + 2], obs[o + 3]);
      this.jobCursor += 5;
      if (now() - t0 > budgetMs) break;
    }
    this.stats.lastJobMs += now() - t0;
    this.stats.samples = samples;
    if (this.jobCursor >= total) this.commit();
  }

  private commit(): void {
    this.jobActive = false;
    // zeitlich begrenzte Aufdeckungen
    if (this.reveals.length) {
      this.reveals = this.reveals.filter((r) => r.until > this.realTime);
      for (const r of this.reveals) this.disc(this.next, r.x, r.z, r.r);
    }
    const n = this.vis.length;
    let added = 0;
    const vis = this.vis, nx = this.next, ex = this.explored, d = this.texData;
    for (let k = 0, p = 0; k < n; k++, p += 4) {
      const v = nx[k];
      vis[k] = v;
      if (v && !ex[k]) { ex[k] = 1; added++; }
      d[p] = v ? 255 : 0;
      d[p + 1] = v || ex[k] ? 255 : 0;
    }
    this.texture.needsUpdate = true;
    this.snap = this.obs;
    this._epoch++;
    this.stats.jobs++;
    this.stats.newlyExplored = added;
    if (added > 0) bus.emit('fog:revealed', { a3: this.playerA3 ?? '', cells: added });
  }

  private writeTexture(): void {
    const d = this.texData, vis = this.vis, ex = this.explored;
    const n = vis.length;
    for (let k = 0, p = 0; k < n; k++, p += 4) {
      d[p] = vis[k] ? 255 : 0;
      d[p + 1] = ex[k] || vis[k] ? 255 : 0;
    }
    this.texture.needsUpdate = true;
  }

  /** Strahlverfahren für einen Beobachter; Rückgabe: Anzahl Stichproben */
  private observe(x: number, z: number, eyeH: number, rKm: number): number {
    const cols = this.cols, rows = this.rows;
    const hMax = this.hMax, hAvg = this.hAvg, out = this.next;
    const ox = x / CELL_KM, oz = z / CELL_KM;
    const oi = Math.floor(ox), oj = Math.floor(oz);
    if (oi < 0 || oj < 0 || oi >= cols || oj >= rows) return 0;
    const ok = oj * cols + oi;
    const hObs = Math.max(this.geo.heightAt(x, z), 0);
    const eye = hObs + eyeH;

    // Höhenbonus: Überhöhung gegenüber dem Umfeld (Ring bei ~80 % der Sichtweite)
    let rc = rKm / CELL_KM;
    if (eyeH < 0.05) {
      const ring = Math.max(2, rc * 0.8);
      let sum = 0;
      for (let a = 0; a < 8; a++) {
        const px = Math.floor(ox + Math.cos(a * 0.785398) * ring), pz = Math.floor(oz + Math.sin(a * 0.785398) * ring);
        sum += px >= 0 && pz >= 0 && px < cols && pz < rows ? hAvg[pz * cols + px] : hObs;
      }
      const prom = hObs - sum / 8;
      if (prom > 0) rc *= 1 + Math.min(0.35, prom * 1.2);
    }
    const R = Math.max(1, Math.floor(rc));
    // eigene Zelle + Nachbarn immer sichtbar
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const a = oi + di, b = oj + dj;
        if (a >= 0 && b >= 0 && a < cols && b < rows) out[b * cols + a] = 1;
      }
    }
    out[ok] = 1;
    // Große Radien: gröberes Raster (Strahlabstand, Schrittweite und Markierung in Blöcken)
    const stride = R > 40 ? 3 : R > 12 ? 2 : 1;
    const nRays = Math.min(720, Math.max(24, Math.ceil((6.2832 * R * 1.6) / stride)));
    const smoke = this.smoke;
    let samples = 0;
    const dAng = 6.283185307 / nRays;
    for (let r = 0; r < nRays; r++) {
      const ang = r * dAng;
      const dx = Math.cos(ang), dz = Math.sin(ang);
      let maxSlope = -1e9;
      let smokeAcc = 0;
      for (let s = stride; s <= R; s += stride) {
        const px = ox + dx * s, pz = oz + dz * s;
        if (px < 0 || pz < 0) break;
        const i = px | 0, j = pz | 0;
        if (i >= cols || j >= rows) break;
        const k = j * cols + i;
        const d = s * CELL_KM;
        samples++;
        {
          // Zielhöhe (Boden + 3 m) gegen den Horizont bisher
          if (hAvg[k] + 0.003 - eye >= maxSlope * d - TOL_KM) {
            out[k] = 1;
            if (stride > 1) {
              const i1 = i + 1 < cols ? i + 1 : i, j1 = j + 1 < rows ? j + 1 : j;
              out[j * cols + i1] = 1;
              out[j1 * cols + i] = 1;
              out[j1 * cols + i1] = 1;
              if (stride > 2) {
                const i0 = i > 0 ? i - 1 : i, j0 = j > 0 ? j - 1 : j;
                out[j * cols + i0] = 1; out[j0 * cols + i] = 1; out[j0 * cols + i0] = 1; out[j0 * cols + i1] = 1; out[j1 * cols + i0] = 1;
              }
            }
          }
        }
        const sl = (hMax[k] - eye) * INV[s];
        if (sl > maxSlope) maxSlope = sl;
        if (smoke) {
          smokeAcc += smoke.densityAt(px * CELL_KM, pz * CELL_KM) * CELL_KM * stride;
          if (smokeAcc > SMOKE_BLOCK) break;
        }
      }
    }
    return samples;
  }
}

const INV = new Float64Array(256);
for (let s = 1; s < 256; s++) INV[s] = 1 / (s * CELL_KM);

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
