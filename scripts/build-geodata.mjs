#!/usr/bin/env node
/**
 * WW3: EUROPE – Geodaten-Pipeline (Phase 1)
 *
 * Lädt echte Geodaten herunter und backt sie in kompakte Spiel-Assets:
 *   - Natural Earth 1:50m: Ländergrenzen, Seen, Flüsse, Städte
 *   - AWS Terrain Tiles (Terrarium-Encoding, Quelle u. a. SRTM/GMTED/ETOPO): Höhen + Bathymetrie
 *
 * Projektion: Lambert Azimuthal Equal Area (wie EPSG:3035 "ETRS89-LAEA Europe"),
 * Zentrum 52°N / 10°E, sphärisch (R = 6371 km). 1 Rasterzelle = CELL_KM km.
 *
 * Ausgabe (public/data/):
 *   heights.png    16-bit Graustufen, Wert = Höhe[m] + 12000
 *   countries.png  RGB 8-bit: R = Länder-ID (0 = Meer), G = Wasser-Flags (1 = See, 2 = Fluss)
 *   meta.json      Rastermaße, Projektion, Länderliste, Städte
 *
 * Aufruf: npm run geodata   (benötigt curl im PATH; Downloads werden in scripts/.cache gecached)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode, encode } from 'fast-png';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'scripts', '.cache');
const OUT = join(ROOT, 'public', 'data');
mkdirSync(CACHE, { recursive: true });
mkdirSync(join(CACHE, 'tiles'), { recursive: true });
mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- Konfiguration
const R = 6371;
const LAT0 = 52, LON0 = 10;
const CELL_KM = 2;
const CHUNK = 64;
const W = 41 * CHUNK; // 2624 Zellen = 5248 km
const H = 35 * CHUNK; // 2240 Zellen = 4480 km
const X_MIN = -1920;  // km (Projektionskoordinaten, West)
const Y_MAX = 2380;   // km (Nord)
const TILE_Z = 6;
const NE_BASE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson';
const TILE_BASE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';

// ---------------------------------------------------------------- Projektion
const D2R = Math.PI / 180;
const sinP0 = Math.sin(LAT0 * D2R), cosP0 = Math.cos(LAT0 * D2R);
function project(lon, lat) {
  const p = lat * D2R, l = (lon - LON0) * D2R;
  const cosc = sinP0 * Math.sin(p) + cosP0 * Math.cos(p) * Math.cos(l);
  const k = Math.sqrt(2 / Math.max(1e-9, 1 + cosc));
  return [R * k * Math.cos(p) * Math.sin(l), R * k * (cosP0 * Math.sin(p) - sinP0 * Math.cos(p) * Math.cos(l))];
}
function unproject(x, y) {
  const rho = Math.hypot(x, y);
  if (rho < 1e-9) return [LON0, LAT0];
  const c = 2 * Math.asin(Math.min(1, rho / (2 * R)));
  const sc = Math.sin(c), cc = Math.cos(c);
  const lat = Math.asin(cc * sinP0 + (y * sc * cosP0) / rho);
  const lon = LON0 * D2R + Math.atan2(x * sc, rho * cosP0 * cc - y * sinP0 * sc);
  return [lon / D2R, lat / D2R];
}
/** Projektion -> Rasterkoordinaten (Zellen, kontinuierlich) */
function toGrid(lon, lat) {
  const [x, y] = project(lon, lat);
  return [(x - X_MIN) / CELL_KM, (Y_MAX - y) / CELL_KM];
}

// ---------------------------------------------------------------- Download-Helfer
function download(url, file) {
  if (existsSync(file)) return;
  execFileSync('curl', ['-sSfL', '--retry', '4', '-o', file, url], { stdio: 'inherit' });
}
function loadNE(name) {
  const file = join(CACHE, `${name}.geojson`);
  download(`${NE_BASE}/${name}.geojson`, file);
  return JSON.parse(readFileSync(file, 'utf8'));
}

// ---------------------------------------------------------------- 1) Höhenraster
console.log(`Raster ${W}x${H} Zellen à ${CELL_KM} km`);
const tileCache = new Map();
function getTile(tx, ty) {
  const key = `${tx}_${ty}`;
  let t = tileCache.get(key);
  if (t) return t;
  const file = join(CACHE, 'tiles', `${TILE_Z}_${key}.png`);
  download(`${TILE_BASE}/${TILE_Z}/${tx}/${ty}.png`, file);
  const img = decode(readFileSync(file));
  const ch = img.channels;
  const h = new Float32Array(256 * 256);
  for (let i = 0; i < 256 * 256; i++) {
    const r = img.data[i * ch], g = img.data[i * ch + 1], b = img.data[i * ch + 2];
    h[i] = r * 256 + g + b / 256 - 32768;
  }
  t = h;
  tileCache.set(key, t);
  return t;
}
const N_TILES = 1 << TILE_Z;
function sampleElevation(lon, lat) {
  // Web-Mercator-Pixelkoordinaten auf Zoomstufe TILE_Z
  const latC = Math.max(-85, Math.min(85, lat));
  const px = ((lon + 180) / 360) * N_TILES * 256;
  const s = Math.sin(latC * D2R);
  const py = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * N_TILES * 256;
  const x0 = Math.floor(px - 0.5), y0 = Math.floor(py - 0.5);
  const fx = px - 0.5 - x0, fy = py - 0.5 - y0;
  const v = (x, y) => {
    x = ((x % (N_TILES * 256)) + N_TILES * 256) % (N_TILES * 256);
    y = Math.max(0, Math.min(N_TILES * 256 - 1, y));
    const t = getTile(x >> 8, y >> 8);
    return t[(y & 255) * 256 + (x & 255)];
  };
  return (v(x0, y0) * (1 - fx) + v(x0 + 1, y0) * fx) * (1 - fy) + (v(x0, y0 + 1) * (1 - fx) + v(x0 + 1, y0 + 1) * fx) * fy;
}

const heights = new Float32Array(W * H);
console.log('Sample Höhendaten (lädt fehlende Terrarium-Kacheln)…');
for (let j = 0; j < H; j++) {
  for (let i = 0; i < W; i++) {
    // 2x2-Supersampling pro Zelle für glattere Werte
    let sum = 0;
    for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
      const [lon, lat] = unproject(X_MIN + (i + ox) * CELL_KM, Y_MAX - (j + oy) * CELL_KM);
      sum += sampleElevation(lon, lat);
    }
    heights[j * W + i] = sum / 4;
  }
  if (j % 200 === 0) console.log(`  Zeile ${j}/${H}  (Kacheln: ${tileCache.size})`);
}

// ---------------------------------------------------------------- 2) Polygon-Rasterizer
/** Scanline-Füllung (Even-Odd) eines Polygons mit Löchern. rings: Array von [lon,lat]-Ringen */
function fillPolygon(rings, buf, value) {
  const edges = [];
  let minY = Infinity, maxY = -Infinity;
  for (const ring of rings) {
    const pts = ring.map(([lon, lat]) => toGrid(lon, lat));
    for (let k = 0; k < pts.length - 1; k++) {
      const [x1, y1] = pts[k], [x2, y2] = pts[k + 1];
      if (y1 === y2) continue;
      // Kanten mit absurder Länge (z. B. Projektions-Wrap weit außerhalb) verwerfen
      if (Math.abs(x2 - x1) > W * 2) continue;
      edges.push([x1, y1, x2, y2]);
      minY = Math.min(minY, y1, y2);
      maxY = Math.max(maxY, y1, y2);
    }
  }
  const j0 = Math.max(0, Math.floor(minY)), j1 = Math.min(H - 1, Math.ceil(maxY));
  const xs = [];
  for (let j = j0; j <= j1; j++) {
    const yc = j + 0.5;
    xs.length = 0;
    for (const [x1, y1, x2, y2] of edges) {
      if ((y1 <= yc && y2 > yc) || (y2 <= yc && y1 > yc)) xs.push(x1 + ((yc - y1) / (y2 - y1)) * (x2 - x1));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = Math.max(0, Math.ceil(xs[k] - 0.5)), b = Math.min(W - 1, Math.floor(xs[k + 1] - 0.5));
      for (let i = a; i <= b; i++) buf[j * W + i] = value;
    }
  }
}
function polygonsOf(geom) {
  if (!geom) return [];
  if (geom.type === 'Polygon') return [geom.coordinates];
  if (geom.type === 'MultiPolygon') return geom.coordinates;
  return [];
}
function linesOf(geom) {
  if (!geom) return [];
  if (geom.type === 'LineString') return [geom.coordinates];
  if (geom.type === 'MultiLineString') return geom.coordinates;
  return [];
}

// ---------------------------------------------------------------- 3) Länder
console.log('Rastere Länder…');
const countriesGeo = loadNE('ne_50m_admin_0_countries');
const ids = new Uint8Array(W * H);
const countryList = [];
let nextId = 1;
const features = countriesGeo.features
  .map((f) => ({ f, p: f.properties }))
  .filter(({ f }) => {
    const [x0, y0, x1, y1] = f.bbox ?? [-180, -90, 180, 90];
    return x1 > -45 && x0 < 90 && y1 > 25 && y0 < 82;
  })
  .sort((a, b) => a.p.ADM0_A3.localeCompare(b.p.ADM0_A3));
for (const { f, p } of features) {
  const id = nextId;
  const tmp = new Uint8Array(W * H);
  for (const poly of polygonsOf(f.geometry)) fillPolygon(poly, tmp, 1);
  let count = 0;
  for (let k = 0; k < W * H; k++) if (tmp[k]) { ids[k] = id; count++; }
  if (count < 3) continue; // nicht (sinnvoll) im Kartenausschnitt
  nextId++;
  const [lx, ly] = toGrid(p.LABEL_X, p.LABEL_Y);
  countryList.push({
    id,
    a3: p.ADM0_A3,
    name: p.NAME_DE || p.NAME,
    nameEn: p.NAME,
    mapColor: p.MAPCOLOR9,
    population: p.POP_EST,
    gdpMd: p.GDP_MD,
    label: [+(lx * CELL_KM).toFixed(1), +(ly * CELL_KM).toFixed(1)],
    labelRank: p.LABELRANK,
    cells: count,
  });
  if (nextId > 250) throw new Error('Zu viele Länder für 8-bit-IDs');
}
console.log(`  ${countryList.length} Länder im Ausschnitt`);

// ---------------------------------------------------------------- 4) Küsten bereinigen
// DEM-Land außerhalb aller Länderpolygone (Generalisierung der 1:50m-Küste): dem nächsten Land
// zuschlagen (max. 4 Zellen), sonst zu Meer machen. So passen Küstenlinie und Grenzen zusammen.
{
  let frontier = [];
  const dist = new Uint8Array(W * H).fill(255);
  for (let k = 0; k < W * H; k++) if (ids[k]) { dist[k] = 0; frontier.push(k); }
  for (let d = 1; d <= 4 && frontier.length; d++) {
    const next = [];
    for (const k of frontier) {
      const i = k % W, j = (k / W) | 0;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
        const n = nj * W + ni;
        if (dist[n] !== 255 || heights[n] <= 0) continue;
        dist[n] = d;
        ids[n] = ids[k];
        next.push(n);
      }
    }
    frontier = next;
  }
}

// ---------------------------------------------------------------- 5) Seen & Flüsse
console.log('Rastere Seen und Flüsse…');
const water = new Uint8Array(W * H);
const lakes = loadNE('ne_50m_lakes');
for (const f of lakes.features) for (const poly of polygonsOf(f.geometry)) fillPolygon(poly, water, 1);
const rivers = loadNE('ne_50m_rivers_lake_centerlines');
function plot(i, j, v) {
  if (i < 0 || j < 0 || i >= W || j >= H) return;
  const k = j * W + i;
  if (!water[k]) water[k] = v;
}
for (const f of rivers.features) {
  const major = f.properties.scalerank <= 2;
  for (const line of linesOf(f.geometry)) {
    const pts = line.map(([lon, lat]) => toGrid(lon, lat));
    for (let k = 0; k < pts.length - 1; k++) {
      const [x1, y1] = pts[k], [x2, y2] = pts[k + 1];
      const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1) * 3) + 1;
      let pi = -1, pj = -1;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const i = Math.floor(x1 + (x2 - x1) * t), j = Math.floor(y1 + (y2 - y1) * t);
        if (i === pi && j === pj) continue;
        // 4-zusammenhängend halten
        if (pi >= 0 && i !== pi && j !== pj) plot(i, pj, 2);
        plot(i, j, 2);
        if (major) { plot(i + 1, j, 2); plot(i, j + 1, 2); }
        pi = i; pj = j;
      }
    }
  }
}

// ---------------------------------------------------------------- 6) Höhen finalisieren
let landCells = 0;
for (let k = 0; k < W * H; k++) {
  if (ids[k]) {
    landCells++;
    if (heights[k] < 3) heights[k] = 3; // Polder & Küstenzellen über Meeresniveau heben
  } else {
    // Meer: mindestens -8 m, Bathymetrie auf 25 m quantisiert (bessere Kompression)
    heights[k] = Math.min(-8, Math.round(heights[k] / 25) * 25);
    water[k] = 0;
  }
}
console.log(`  Landzellen: ${landCells}`);

// ---------------------------------------------------------------- 7) Städte
const placesGeo = loadNE('ne_50m_populated_places');
const cities = [];
for (const f of placesGeo.features) {
  const p = f.properties;
  const [gx, gy] = toGrid(p.LONGITUDE, p.LATITUDE);
  const i = Math.floor(gx), j = Math.floor(gy);
  if (i < 0 || j < 0 || i >= W || j >= H) continue;
  const cid = ids[j * W + i];
  if (!cid) continue;
  const capital = p.ADM0CAP === 1 || p.FEATURECLA === 'Admin-0 capital';
  if (!capital && p.POP_MAX < 250000) continue;
  cities.push({
    name: p.NAME_DE || p.NAME,
    country: countryList.find((c) => c.id === cid).a3,
    pop: p.POP_MAX,
    capital,
    pos: [+(gx * CELL_KM).toFixed(2), +(gy * CELL_KM).toFixed(2)],
  });
}
cities.sort((a, b) => b.pop - a.pop);
console.log(`  ${cities.length} Städte`);

// ---------------------------------------------------------------- 8) Ausgabe
const h16 = new Uint16Array(W * H);
for (let k = 0; k < W * H; k++) h16[k] = Math.max(0, Math.min(65535, Math.round(heights[k] + 12000)));
writeFileSync(join(OUT, 'heights.png'), encode({ width: W, height: H, data: h16, depth: 16, channels: 1 }));

const rgb = new Uint8Array(W * H * 3);
for (let k = 0; k < W * H; k++) { rgb[k * 3] = ids[k]; rgb[k * 3 + 1] = water[k]; }
writeFileSync(join(OUT, 'countries.png'), encode({ width: W, height: H, data: rgb, depth: 8, channels: 3 }));

const meta = {
  version: 1,
  generated: new Date().toISOString().slice(0, 10),
  sources: [
    'Natural Earth 1:50m (public domain) – naturalearthdata.com',
    'AWS Terrain Tiles / Terrarium (SRTM, GMTED2010, ETOPO1 u. a.) – registry.opendata.aws/terrain-tiles',
  ],
  projection: { type: 'laea', lat0: LAT0, lon0: LON0, radiusKm: R, xMinKm: X_MIN, yMaxKm: Y_MAX },
  grid: { width: W, height: H, cellKm: CELL_KM, chunkCells: CHUNK, heightOffset: 12000 },
  countries: countryList,
  cities,
};
writeFileSync(join(OUT, 'meta.json'), JSON.stringify(meta));
console.log('Fertig ->', OUT);
