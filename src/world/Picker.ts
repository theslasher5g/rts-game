import * as THREE from 'three';
import type { MapPick, Settings } from '../core/types';
import type { GeoData } from './GeoData';

/**
 * Maus -> Welt: Strahl von der Kamera durch NDC, Ray-Marching gegen das Höhenfeld
 * (Boden = max(heightKm, 0) * heightExaggeration, Meer = y 0), danach binäre Verfeinerung.
 *
 * Das Marching beschränkt sich auf die Schicht y ∈ [0, maxGroundY], d. h. die Strahllänge ist
 * höchstens maxGroundY / sin(Neigung) – typischerweise < 100 Schritte.
 */
export class Picker {
  private readonly geo: GeoData;
  private exaggeration = 1;
  /** Maximale Geländehöhe in km (unüberhöht) */
  private readonly maxHeightKm: number;

  private readonly origin = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();

  constructor(geo: GeoData, settings: Settings) {
    this.geo = geo;
    let m = 0;
    const h = geo.heightsKm;
    for (let i = 0; i < h.length; i++) if (h[i] > m) m = h[i];
    this.maxHeightKm = m;
    this.applySettings(settings);
  }

  applySettings(s: Settings): void {
    this.exaggeration = s.heightExaggeration;
  }

  /** Bodenhöhe in Welt-Y an (x, z). */
  groundY(x: number, z: number): number {
    const h = this.geo.heightAt(x, z);
    return h > 0 ? h * this.exaggeration : 0;
  }

  pick(ndcX: number, ndcY: number, camera: THREE.PerspectiveCamera): MapPick | null {
    const o = this.origin.setFromMatrixPosition(camera.matrixWorld);
    const d = this.dir.set(ndcX, ndcY, 0.5).unproject(camera).sub(o).normalize();
    const geo = this.geo;

    const top = this.maxHeightKm * this.exaggeration + 0.01;
    const down = -d.y;
    let t0: number, t1: number;
    if (down > 1e-6) {
      t0 = o.y > top ? (o.y - top) / down : 0;
      t1 = o.y > 0 ? o.y / down : 0; // spätestens hier: Meeresoberfläche
    } else {
      // Strahl horizontal/aufwärts: nur Treffer möglich, wenn Kamera unterhalb der Gipfel
      if (o.y > top) return null;
      t0 = 0;
      t1 = top * 50 + 200;
    }

    // Auf Kartenrechteck (xz) beschneiden
    const W = geo.widthKm, H = geo.heightKm;
    if (Math.abs(d.x) > 1e-9) {
      let a = (0 - o.x) / d.x, b = (W - o.x) / d.x;
      if (a > b) { const tmp = a; a = b; b = tmp; }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
    } else if (o.x < 0 || o.x > W) return null;
    if (Math.abs(d.z) > 1e-9) {
      let a = (0 - o.z) / d.z, b = (H - o.z) / d.z;
      if (a > b) { const tmp = a; a = b; b = tmp; }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
    } else if (o.z < 0 || o.z > H) return null;
    if (t1 <= t0) return null;

    // Minimale Schrittweite: halbe Zelle, bei sehr nahem Blick feiner
    const camDist = Math.max(0.01, o.y - this.groundY(o.x, o.z));
    const minStep = Math.min(geo.cellKm * 0.5, Math.max(0.02, camDist * 0.01));
    // Konservative Schrittweite: Abstand / (Sinkrate + angenommener max. Geländeanstieg)
    const denom = (down > 0 ? down : 0) + 0.12 * this.exaggeration + 0.02;

    let tPrev = t0;
    let t = t0;
    let hit = false;
    let guard = 0;
    while (t <= t1 && guard++ < 4000) {
      const px = o.x + d.x * t, py = o.y + d.y * t, pz = o.z + d.z * t;
      const above = py - this.groundY(px, pz);
      if (above <= 0) {
        hit = true;
        break;
      }
      tPrev = t;
      // Adaptiv: großer Abstand über Grund -> großer Schritt
      const step = above / denom;
      t += step > minStep ? step : minStep;
    }
    if (!hit) {
      // Endpunkt prüfen (Meeresoberfläche liegt exakt bei t1)
      t = t1;
      const px = o.x + d.x * t, py = o.y + d.y * t, pz = o.z + d.z * t;
      if (py - this.groundY(px, pz) > 1e-4) return null;
    }

    // Binäre Verfeinerung zwischen tPrev (über Grund) und t (unter/auf Grund)
    let lo = tPrev, hi = t;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) * 0.5;
      const px = o.x + d.x * mid, py = o.y + d.y * mid, pz = o.z + d.z * mid;
      if (py - this.groundY(px, pz) > 0) lo = mid;
      else hi = mid;
    }
    const x = o.x + d.x * hi, z = o.z + d.z * hi;
    if (!geo.inside(x, z)) return null;
    return { x, y: this.groundY(x, z), z, countryId: geo.countryAt(x, z) };
  }
}
