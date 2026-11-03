import { decode } from 'fast-png';
import type { CountryMeta, GeoMeta } from '../core/types';

/**
 * Lädt die vorverarbeiteten Geodaten (siehe scripts/build-geodata.mjs) und stellt
 * CPU-seitige Abfragen bereit (Höhe, Land unter Position, Projektion).
 */
export class GeoData {
  readonly meta: GeoMeta;
  /** Rastermaße in Zellen */
  readonly width: number;
  readonly height: number;
  readonly cellKm: number;
  /** Kartenmaße in km (= Welteinheiten) */
  readonly widthKm: number;
  readonly heightKm: number;
  /** Höhe je Zelle in km (Meer negativ), Zeile 0 = Norden */
  readonly heightsKm: Float32Array;
  /** Länder-ID je Zelle (0 = Meer) */
  readonly countryIds: Uint8Array;
  /** Wasser-Flags je Zelle (WATER_LAKE / WATER_RIVER) */
  readonly waterFlags: Uint8Array;
  readonly countriesById = new Map<number, CountryMeta>();
  readonly countriesByA3 = new Map<string, CountryMeta>();

  private constructor(meta: GeoMeta, heightsKm: Float32Array, ids: Uint8Array, water: Uint8Array) {
    this.meta = meta;
    this.width = meta.grid.width;
    this.height = meta.grid.height;
    this.cellKm = meta.grid.cellKm;
    this.widthKm = this.width * this.cellKm;
    this.heightKm = this.height * this.cellKm;
    this.heightsKm = heightsKm;
    this.countryIds = ids;
    this.waterFlags = water;
    for (const c of meta.countries) {
      this.countriesById.set(c.id, c);
      this.countriesByA3.set(c.a3, c);
    }
  }

  static async load(baseUrl = `${import.meta.env.BASE_URL}data/`, onProgress?: (p: number, label: string) => void): Promise<GeoData> {
    const fetchBuf = async (name: string) => {
      const r = await fetch(baseUrl + name);
      if (!r.ok) throw new Error(`Konnte ${name} nicht laden (${r.status}). Wurde "npm run geodata" ausgeführt?`);
      return r.arrayBuffer();
    };
    onProgress?.(0.05, 'Lade Metadaten…');
    const meta = (await (await fetch(baseUrl + 'meta.json')).json()) as GeoMeta;
    onProgress?.(0.15, 'Lade Höhendaten…');
    const [hBuf, cBuf] = await Promise.all([fetchBuf('heights.png'), fetchBuf('countries.png')]);
    onProgress?.(0.55, 'Dekodiere Höhenmodell…');
    await nextFrame();
    const hImg = decode(new Uint8Array(hBuf));
    const n = meta.grid.width * meta.grid.height;
    const heightsKm = new Float32Array(n);
    const off = meta.grid.heightOffset;
    for (let k = 0; k < n; k++) heightsKm[k] = ((hImg.data[k] as number) - off) / 1000;
    onProgress?.(0.75, 'Dekodiere Ländergrenzen…');
    await nextFrame();
    const cImg = decode(new Uint8Array(cBuf));
    const ch = cImg.channels;
    const ids = new Uint8Array(n);
    const water = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      ids[k] = cImg.data[k * ch] as number;
      water[k] = cImg.data[k * ch + 1] as number;
    }
    onProgress?.(0.9, 'Baue Welt…');
    return new GeoData(meta, heightsKm, ids, water);
  }

  /** Bilinear interpolierte Höhe in km an Weltposition (x,z in km). */
  heightAt(x: number, z: number): number {
    const gx = x / this.cellKm - 0.5, gz = z / this.cellKm - 0.5;
    const i0 = clamp(Math.floor(gx), 0, this.width - 1), j0 = clamp(Math.floor(gz), 0, this.height - 1);
    const i1 = Math.min(i0 + 1, this.width - 1), j1 = Math.min(j0 + 1, this.height - 1);
    const fx = clamp(gx - i0, 0, 1), fz = clamp(gz - j0, 0, 1);
    const h = this.heightsKm, w = this.width;
    return (h[j0 * w + i0] * (1 - fx) + h[j0 * w + i1] * fx) * (1 - fz) + (h[j1 * w + i0] * (1 - fx) + h[j1 * w + i1] * fx) * fz;
  }

  /** Länder-ID an Weltposition (0 = Meer/außerhalb). */
  countryAt(x: number, z: number): number {
    const i = Math.floor(x / this.cellKm), j = Math.floor(z / this.cellKm);
    if (i < 0 || j < 0 || i >= this.width || j >= this.height) return 0;
    return this.countryIds[j * this.width + i];
  }

  inside(x: number, z: number): boolean {
    return x >= 0 && z >= 0 && x < this.widthKm && z < this.heightKm;
  }

  /** Geographische Koordinaten -> Welt-km [x, z] (Lambert Azimuthal Equal Area). */
  lonLatToWorld(lon: number, lat: number): [number, number] {
    const { lat0, lon0, radiusKm: R, xMinKm, yMaxKm } = this.meta.projection;
    const d = Math.PI / 180;
    const p = lat * d, l = (lon - lon0) * d, p0 = lat0 * d;
    const k = Math.sqrt(2 / Math.max(1e-9, 1 + Math.sin(p0) * Math.sin(p) + Math.cos(p0) * Math.cos(p) * Math.cos(l)));
    const px = R * k * Math.cos(p) * Math.sin(l);
    const py = R * k * (Math.cos(p0) * Math.sin(p) - Math.sin(p0) * Math.cos(p) * Math.cos(l));
    return [px - xMinKm, yMaxKm - py];
  }

  /** Welt-km -> [lon, lat] */
  worldToLonLat(x: number, z: number): [number, number] {
    const { lat0, lon0, radiusKm: R, xMinKm, yMaxKm } = this.meta.projection;
    const d = Math.PI / 180;
    const px = x + xMinKm, py = yMaxKm - z;
    const rho = Math.hypot(px, py);
    if (rho < 1e-9) return [lon0, lat0];
    const c = 2 * Math.asin(Math.min(1, rho / (2 * R)));
    const p0 = lat0 * d;
    const lat = Math.asin(Math.cos(c) * Math.sin(p0) + (py * Math.sin(c) * Math.cos(p0)) / rho);
    const lon = lon0 * d + Math.atan2(px * Math.sin(c), rho * Math.cos(p0) * Math.cos(c) - py * Math.sin(p0) * Math.sin(c));
    return [lon / d, lat / d];
  }
}

function clamp(v: number, a: number, b: number) {
  return v < a ? a : v > b ? b : v;
}
function nextFrame() {
  return new Promise<void>((r) => requestAnimationFrame(() => r()));
}
