#!/usr/bin/env node
/**
 * WW3: EUROPE – Regionen-Pipeline (Phase 5): kleine Karte auf echtem Gelände mit erfundenen Ländern.
 *
 * Ersetzt die Europa-Daten in public/data (heights.png, countries.png, meta.json, roads.bin):
 *   1. Gelände: ~300 x 200 km Ausschnitt (Nordadria/Alpen/Pannonische Ebene) aus AWS Terrarium-Kacheln (z10),
 *      eigene LAEA-Projektion, Zentrum = Kartenmitte, Zellgröße 0,25 km.
 *   2. Hydrologie aus dem Höhenmodell: Senken füllen (Priority-Flood), D8-Abfluss, Akkumulation -> Flüsse (G=2),
 *      Senken -> Seen (G=1).
 *   3. Erfundene Länder (VAL/KRN/MAR/PAN aus src/game/scenario.ts, 4 Nationen) per gewichtetem Multi-Source-Dijkstra, dessen
 *      Schrittkosten an Steigungen und Flüssen steigen -> Grenzen folgen Kämmen und Flüssen.
 *   4. Erfundene Städte, Ölfelder, Dörfer-Knoten, HQ/Raffinerie/Startplatz.
 *   5. Straßen-/Schienennetz per Least-Cost-Pfad (Netz-Rabatt -> gemeinsame Trassen/Engpässe), Chaikin-Glättung,
 *      Brücken an Fluss-/Seezellen, Ausgabe im roads.bin-Format von build-roads.mjs.
 *
 * Aufruf: node scripts/build-region.mjs [--seed N] [--out DIR]     (benötigt curl; Kacheln werden gecached)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode, encode } from 'fast-png';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'scripts', '.cache');
mkdirSync(join(CACHE, 'tiles'), { recursive: true });
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const SEED = Math.floor(+argOf('--seed', 4711));
const OUT = resolve(argOf('--out', join(ROOT, 'public', 'data')));
mkdirSync(OUT, { recursive: true });

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

// ---------------------------------------------------------------- Szenario-Vertrag (aus src/game/scenario.ts)
const scen = readFileSync(join(ROOT, 'src', 'game', 'scenario.ts'), 'utf8');
const grab = (re, d) => { const m = re.exec(scen); return m ? m[1] : d; };
const SCENARIO_ID = grab(/SCENARIO_ID\s*=\s*'([^']+)'/, 'adria-nord');
const SCENARIO_NAME = grab(/SCENARIO_NAME\s*=\s*'([^']+)'/, 'Operation Nordadria');
const OIL_FIELDS_PER_MAP = +grab(/OIL_FIELDS_PER_MAP\s*=\s*(\d+)/, 9);
const REGION = {
  centerLon: +grab(/centerLon:\s*([\d.]+)/, 15.6),
  centerLat: +grab(/centerLat:\s*([\d.]+)/, 45.9),
  widthKm: +grab(/widthKm:\s*([\d.]+)/, 300),
  heightKm: +grab(/heightKm:\s*([\d.]+)/, 200),
  cellKm: +grab(/cellKm:\s*([\d.]+)/, 0.25),
};
const NATIONS = [];
const MP_TEAMS = [...(/MP_TEAMS[^=]*=\s*\[(\[[^\]]+\]\s*,\s*\[[^\]]+\])\]/.exec(scen)?.[1] ?? "['VAL','MAR'],['KRN','PAN']").matchAll(/'(\w+)'\s*,\s*'(\w+)'/g)].map((m) => [m[1], m[2]]);
{
  const re = /a3:\s*'(\w+)',\s*name:\s*'([^']+)',\s*short:\s*'([^']+)',\s*color:\s*'([^']+)',\s*areaShare:\s*([\d.]+),\s*homeland:\s*'(\w+)',\s*capital:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(scen))) NATIONS.push({ a3: m[1], name: m[2], short: m[3], color: m[4], areaShare: +m[5], homeland: m[6], capital: m[7] });
  if (NATIONS.length !== 4) throw new Error('scenario.ts: Nationen nicht lesbar');
}
// Kartenfenster leicht verschoben: mehr Adria (Kvarner) im Südwesten, Julische Alpen im Nordwesten (siehe Bericht)
const CENTER_LON = 15.55, CENTER_LAT = 45.55;

// ---------------------------------------------------------------- Projektion (LAEA, Zentrum = Kartenmitte)
const R = 6371;
const CELL = REGION.cellKm;
const CHUNK = 64;
const W = Math.round(REGION.widthKm / CELL), H = Math.round(REGION.heightKm / CELL);
const N = W * H;
const WKM = W * CELL, HKM = H * CELL;
const X_MIN = -WKM / 2, Y_MAX = HKM / 2;
const D2R = Math.PI / 180;
const sinP0 = Math.sin(CENTER_LAT * D2R), cosP0 = Math.cos(CENTER_LAT * D2R);
function unproject(x, y) {
  const rho = Math.hypot(x, y);
  if (rho < 1e-9) return [CENTER_LON, CENTER_LAT];
  const c = 2 * Math.asin(Math.min(1, rho / (2 * R)));
  const sc = Math.sin(c), cc = Math.cos(c);
  const lat = Math.asin(cc * sinP0 + (y * sc * cosP0) / rho);
  const lon = CENTER_LON * D2R + Math.atan2(x * sc, rho * cosP0 * cc - y * sinP0 * sc);
  return [lon / D2R, lat / D2R];
}

// ---------------------------------------------------------------- Zufall
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED * 7919 + 17);
const rpick = (a) => a[Math.floor(rnd() * a.length)];
function hash2(x, y, s) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(s, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, y, s) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0, s), b = hash2(x0 + 1, y0, s), c = hash2(x0, y0 + 1, s), d = hash2(x0 + 1, y0 + 1, s);
  return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}

// ---------------------------------------------------------------- Heap
class Heap {
  constructor(cap = 1 << 20) { this.k = new Float64Array(cap); this.v = new Int32Array(cap); this.n = 0; }
  clear() { this.n = 0; }
  push(key, val) {
    if (this.n === this.k.length) {
      const k = new Float64Array(this.n * 2); k.set(this.k); this.k = k;
      const v = new Int32Array(this.n * 2); v.set(this.v); this.v = v;
    }
    let i = this.n++;
    const K = this.k, V = this.v;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (K[p] <= key) break;
      K[i] = K[p]; V[i] = V[p]; i = p;
    }
    K[i] = key; V[i] = val;
  }
  pop() {
    const K = this.k, V = this.v;
    const top = V[0];
    this.lastKey = K[0];
    const n = --this.n;
    if (n > 0) {
      const key = K[n], val = V[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && K[c + 1] < K[c]) c++;
        if (K[c] >= key) break;
        K[i] = K[c]; V[i] = V[c]; i = c;
      }
      K[i] = key; V[i] = val;
    }
    return top;
  }
}

// ---------------------------------------------------------------- 1) Höhenmodell
const TILE_Z = 10, NT = 1 << TILE_Z, TILE_BASE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const pix = (lon, lat) => {
  const s = Math.sin(Math.max(-85, Math.min(85, lat)) * D2R);
  return [((lon + 180) / 360) * NT * 256, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * NT * 256];
};
const demFile = join(CACHE, `region-dem-${CENTER_LON}-${CENTER_LAT}-${W}x${H}.f32`);
let heights = new Float32Array(N);
if (existsSync(demFile)) {
  const b = readFileSync(demFile);
  heights = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  log('Höhenmodell aus Cache');
} else {
  const need = new Set();
  for (let j = 0; j <= H; j += 4) for (let i = 0; i <= W; i += 4) {
    const [lon, lat] = unproject(X_MIN + i * CELL, Y_MAX - j * CELL);
    const [px, py] = pix(lon, lat);
    for (const o of [-2, 2]) for (const p of [-2, 2]) need.add(`${Math.floor((px + o) / 256)}_${Math.floor((py + p) / 256)}`);
  }
  const todo = [...need].filter((k) => !existsSync(join(CACHE, 'tiles', `${TILE_Z}_${k}.png`)));
  log(`${need.size} Kacheln, ${todo.length} fehlen`);
  if (todo.length) {
    const cfg = todo.map((k) => { const [x, y] = k.split('_'); return `url = "${TILE_BASE}/${TILE_Z}/${x}/${y}.png"\noutput = "${join(CACHE, 'tiles', `${TILE_Z}_${k}.png`)}"`; }).join('\n');
    const cf = join(CACHE, 'region-tiles.curl');
    writeFileSync(cf, cfg);
    execFileSync('curl', ['-sSfL', '--retry', '4', '--parallel', '--parallel-max', '8', '-K', cf], { stdio: 'inherit' });
  }
  const tiles = new Map();
  const getTile = (tx, ty) => {
    const key = `${tx}_${ty}`;
    let t = tiles.get(key);
    if (t) return t;
    const img = decode(readFileSync(join(CACHE, 'tiles', `${TILE_Z}_${key}.png`)));
    const ch = img.channels;
    t = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) t[i] = img.data[i * ch] * 256 + img.data[i * ch + 1] + img.data[i * ch + 2] / 256 - 32768;
    tiles.set(key, t);
    return t;
  };
  const px1 = (x, y) => getTile(x >> 8, y >> 8)[(y & 255) * 256 + (x & 255)];
  const sample = (lon, lat) => {
    const [px, py] = pix(lon, lat);
    const x0 = Math.floor(px - 0.5), y0 = Math.floor(py - 0.5), fx = px - 0.5 - x0, fy = py - 0.5 - y0;
    return (px1(x0, y0) * (1 - fx) + px1(x0 + 1, y0) * fx) * (1 - fy) + (px1(x0, y0 + 1) * (1 - fx) + px1(x0 + 1, y0 + 1) * fx) * fy;
  };
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    let s = 0;
    for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
      const [lon, lat] = unproject(X_MIN + (i + ox) * CELL, Y_MAX - (j + oy) * CELL);
      s += sample(lon, lat);
    }
    heights[j * W + i] = s / 4;
  }
  writeFileSync(demFile, Buffer.from(heights.buffer));
  log('Höhenmodell gesampelt');
}

// ---------------------------------------------------------------- Raster-Helfer
const DX = [1, -1, 0, 0, 1, 1, -1, -1], DY = [0, 0, 1, -1, 1, -1, 1, -1];
const DLEN = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];
const OPP = [1, 0, 3, 2, 7, 6, 5, 4];
const cx = (c) => c % W, cy = (c) => (c / W) | 0;
const cellAt = (xKm, zKm) => Math.min(H - 1, Math.max(0, Math.floor(zKm / CELL))) * W + Math.min(W - 1, Math.max(0, Math.floor(xKm / CELL)));
const kmX = (c) => (cx(c) + 0.5) * CELL, kmZ = (c) => (cy(c) + 0.5) * CELL;
const cellDistKm = (a, b) => Math.hypot(kmX(a) - kmX(b), kmZ(a) - kmZ(b));

function components(mask, conn8) {
  const lab = new Int32Array(N).fill(-1);
  const sizes = [];
  const stack = new Int32Array(N);
  const nd = conn8 ? 8 : 4;
  for (let s = 0; s < N; s++) {
    if (!mask[s] || lab[s] >= 0) continue;
    const id = sizes.length;
    let sp = 0, cnt = 0;
    stack[sp++] = s; lab[s] = id;
    while (sp) {
      const c = stack[--sp]; cnt++;
      const x = c % W, y = (c / W) | 0;
      for (let d = 0; d < nd; d++) {
        const nx = x + DX[d], ny = y + DY[d];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const n = ny * W + nx;
        if (mask[n] && lab[n] < 0) { lab[n] = id; stack[sp++] = n; }
      }
    }
    sizes.push(cnt);
  }
  return { lab, sizes };
}
/** Chamfer-Distanz (km) zur nächsten Zelle mit mask != 0 */
function distKm(mask) {
  const d = new Float32Array(N).fill(1e9);
  for (let k = 0; k < N; k++) if (mask[k]) d[k] = 0;
  const A = 1, B = Math.SQRT2;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = y * W + x; let v = d[k];
    if (x > 0) v = Math.min(v, d[k - 1] + A);
    if (y > 0) {
      v = Math.min(v, d[k - W] + A);
      if (x > 0) v = Math.min(v, d[k - W - 1] + B);
      if (x < W - 1) v = Math.min(v, d[k - W + 1] + B);
    }
    d[k] = v;
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const k = y * W + x; let v = d[k];
    if (x < W - 1) v = Math.min(v, d[k + 1] + A);
    if (y < H - 1) {
      v = Math.min(v, d[k + W] + A);
      if (x < W - 1) v = Math.min(v, d[k + W + 1] + B);
      if (x > 0) v = Math.min(v, d[k + W - 1] + B);
    }
    d[k] = v;
  }
  for (let k = 0; k < N; k++) d[k] = Math.min(d[k] * CELL, 999);
  return d;
}
function boxMean(arr, r) {
  const sat = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) { row += arr[y * W + x]; sat[(y + 1) * (W + 1) + x + 1] = sat[y * (W + 1) + x + 1] + row; }
  }
  const out = new Float32Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
    out[y * W + x] = (sat[y1 * (W + 1) + x1] - sat[y0 * (W + 1) + x1] - sat[y1 * (W + 1) + x0] + sat[y0 * (W + 1) + x0]) / ((x1 - x0) * (y1 - y0));
  }
  return out;
}

// ---------------------------------------------------------------- 2) Meer, Inseln, Hydrologie
let sea = new Uint8Array(N);
for (let k = 0; k < N; k++) sea[k] = heights[k] <= 0 ? 1 : 0;
{
  // kleine Inseln -> Meer, kleine Binnen-"Meere" (DEM-Fehler) -> Land
  const land = sea.map((v) => 1 - v);
  const lc = components(land, false);
  for (let k = 0; k < N; k++) if (land[k] && lc.sizes[lc.lab[k]] < 400) sea[k] = 1;
  const sc = components(sea, false);
  const touches = new Uint8Array(sc.sizes.length);
  for (let i = 0; i < W; i++) for (const j of [0, H - 1]) { const l = sc.lab[j * W + i]; if (l >= 0) touches[l] = 1; }
  for (let j = 0; j < H; j++) for (const i of [0, W - 1]) { const l = sc.lab[j * W + i]; if (l >= 0) touches[l] = 1; }
  for (let k = 0; k < N; k++) if (sea[k] && !touches[sc.lab[k]] && sc.sizes[sc.lab[k]] < 300) sea[k] = 0;
}
for (let k = 0; k < N; k++) {
  if (sea[k]) heights[k] = Math.min(-8, Math.round(Math.min(heights[k], -8) / 25) * 25);
  else if (heights[k] < 3) heights[k] = 3;
}
const hs = boxMean(heights, 1);
const grad = new Float32Array(N); // Steigung (Höhe/Strecke)
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const xm = Math.max(0, x - 1), xp = Math.min(W - 1, x + 1), ym = Math.max(0, y - 1), yp = Math.min(H - 1, y + 1);
  const gx = (hs[y * W + xp] - hs[y * W + xm]) / ((xp - xm) * CELL * 1000);
  const gy = (hs[yp * W + x] - hs[ym * W + x]) / ((yp - ym) * CELL * 1000);
  grad[y * W + x] = Math.hypot(gx, gy);
}
// Priority-Flood
log('Hydrologie…');
const fill = new Float64Array(N), parent = new Int32Array(N).fill(-1), order = new Int32Array(N);
let nOrder = 0;
{
  const vis = new Uint8Array(N);
  const hp = new Heap(1 << 20);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = y * W + x;
    if (sea[k]) {
      vis[k] = 1; fill[k] = heights[k];
      let coast = false;
      for (let d = 0; d < 4 && !coast; d++) { const nx = x + DX[d], ny = y + DY[d]; if (nx >= 0 && ny >= 0 && nx < W && ny < H && !sea[ny * W + nx]) coast = true; }
      if (coast) hp.push(heights[k], k);
    } else if (x === 0 || y === 0 || x === W - 1 || y === H - 1) {
      vis[k] = 1; fill[k] = heights[k]; hp.push(heights[k], k);
    }
  }
  while (hp.n) {
    const c = hp.pop();
    order[nOrder++] = c;
    const x = c % W, y = (c / W) | 0;
    for (let d = 0; d < 8; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const n = ny * W + nx;
      if (vis[n]) continue;
      vis[n] = 1;
      const f = Math.max(heights[n], fill[c] + 0.0015 * DLEN[d]);
      fill[n] = f; parent[n] = c;
      hp.push(f, n);
    }
  }
}
const acc = new Float32Array(N).fill(1);
for (let i = nOrder - 1; i >= 0; i--) { const c = order[i], p = parent[c]; if (p >= 0) acc[p] += acc[c]; }
const CELL_KM2 = CELL * CELL;
const T1 = 260 / CELL_KM2, T2 = 1400 / CELL_KM2, T3 = 6000 / CELL_KM2;
const water = new Uint8Array(N); // 1 See, 2 Fluss
{
  const riv = new Uint8Array(N); // Breite 1..3
  for (let k = 0; k < N; k++) if (!sea[k] && acc[k] >= T1) riv[k] = acc[k] >= T3 ? 3 : acc[k] >= T2 ? 2 : 1;
  const put = (x, y) => { if (x >= 0 && y >= 0 && x < W && y < H && !sea[y * W + x]) water[y * W + x] = 2; };
  for (let k = 0; k < N; k++) {
    if (!riv[k]) continue;
    const x = k % W, y = (k / W) | 0, w = riv[k];
    put(x, y);
    if (w === 2) { put(x + 1, y); put(x, y + 1); put(x + 1, y + 1); }
    if (w === 3) { put(x + 1, y); put(x - 1, y); put(x, y + 1); put(x, y - 1); }
    // diagonale Schritte 4-zusammenhängend machen
    const p = parent[k];
    if (p >= 0 && !sea[p] && riv[p]) {
      const px = p % W, py = (p / W) | 0;
      if (px !== x && py !== y) {
        const a = y * W + px, b = py * W + x;
        put(heights[a] < heights[b] ? px : x, heights[a] < heights[b] ? y : py);
      }
    }
  }
  // Seen: Senken (Füllhöhe deutlich über Gelände)
  const lakeMask = new Uint8Array(N);
  for (let k = 0; k < N; k++) if (!sea[k] && fill[k] - heights[k] >= 1 && fill[k] - heights[k] <= 25 && grad[k] < 0.006) lakeMask[k] = 1;
  const lc = components(lakeMask, true);
  let nl = 0;
  for (let k = 0; k < N; k++) if (lakeMask[k] && lc.sizes[lc.lab[k]] >= 140 && lc.sizes[lc.lab[k]] <= 4000) { water[k] = 1; }
  for (const s of lc.sizes) if (s >= 160) nl++;
  log(`Seen: ${nl}`);
}
const wet = new Uint8Array(N); // Meer, See, Fluss
for (let k = 0; k < N; k++) wet[k] = sea[k] || water[k] ? 1 : 0;
const inland = new Uint8Array(N); // See/Fluss (Brückenzellen)
for (let k = 0; k < N; k++) inland[k] = !sea[k] && water[k] ? 1 : 0;
{
  let r = 0, l = 0; for (let k = 0; k < N; k++) { if (water[k] === 2) r++; else if (water[k] === 1) l++; }
  log(`Flusszellen ${r} (${(r * CELL_KM2).toFixed(0)} km²), Seezellen ${l}`);
}

// Gelände-Kennzahlen
const gBox2 = boxMean(grad, 2), gBox4 = boxMean(grad, 4), gBox8 = boxMean(grad, 8);
const hBox40 = boxMean(heights, 40);
const wetDist = distKm(wet), seaDist = distKm(sea), riverDist = distKm(inland);
const wetFrac = boxMean(Float32Array.from(wet), 40); // Wasseranteil im 20x20-km-Fenster (Startaufstellungen sollen nicht in Seenplatten liegen)
const wetNear = boxMean(Float32Array.from(wet), 20);
const tpi = new Float32Array(N); { const hb = boxMean(heights, 12); for (let k = 0; k < N; k++) tpi[k] = heights[k] - hb[k]; }

// ---------------------------------------------------------------- 3) Länder
log('Länder…');
const NN_ = NATIONS.length;
const landMask = sea.map((v) => 1 - v);
const mainLand = (() => {
  const lc = components(landMask, false);
  let best = 0; for (let i = 1; i < lc.sizes.length; i++) if (lc.sizes[i] > lc.sizes[best]) best = i;
  const m = new Uint8Array(N); for (let k = 0; k < N; k++) if (lc.lab[k] === best) m[k] = 1;
  return m;
})();
let landCount = 0; for (let k = 0; k < N; k++) if (mainLand[k]) landCount++;

// Wachstums-Kosten je Zelle
const growCost = new Float32Array(N);
for (let k = 0; k < N; k++) {
  const x = k % W, y = (k / W) | 0;
  const g = grad[k] / 0.09;
  let c = 1 + g * g * 0.9 + Math.max(0, tpi[k]) * 0.012;
  if (water[k] === 2) c += 22;
  else if (water[k] === 1) c += 30;
  const nz = 0.55 + 0.9 * vnoise(x / 60, y / 60, 11) + 0.25 * vnoise(x / 18, y / 18, 12);
  growCost[k] = c * nz;
}
function pickSeed(fx, fy, maxH) {
  const tx = fx * W, ty = fy * H;
  let best = -1, bd = 1e18;
  for (let k = 0; k < N; k++) {
    if (!mainLand[k] || wet[k] || heights[k] > maxH) continue;
    const d = (cx(k) - tx) ** 2 + (cy(k) - ty) ** 2;
    if (d < bd) { bd = d; best = k; }
  }
  return best;
}
const HOME = { west: [[0.14, 0.3]], east: [[0.9, 0.6]], south: [[0.5, 0.9], [0.345, 0.74]], north: [[0.76, 0.1]], center: [[0.5, 0.5]] };
const seedLists = NATIONS.map((n) => HOME[n.homeland].map((h) => pickSeed(h[0], h[1], 450)));
const seeds = seedLists.map((l) => l[0]);
const owner = new Uint8Array(N);
function grow(weights) {
  owner.fill(0);
  const dist = new Float32Array(N).fill(Infinity);
  const hp = new Heap(1 << 20);
  seedLists.forEach((l, i) => l.forEach((s) => { owner[s] = i + 1; dist[s] = 0; hp.push(0, s); }));
  while (hp.n) {
    const c = hp.pop();
    const dc = hp.lastKey;
    if (dc > dist[c]) continue;
    const x = c % W, y = (c / W) | 0, o = owner[c], wgt = weights[o - 1];
    for (let d = 0; d < 8; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const n = ny * W + nx;
      if (!mainLand[n]) continue;
      const nd = dc + DLEN[d] * 0.5 * (growCost[c] + growCost[n]) * wgt;
      if (nd < dist[n]) { dist[n] = nd; owner[n] = o; hp.push(nd, n); }
    }
  }
}
{
  const w = NATIONS.map(() => 1);
  for (let it = 0; it < 14; it++) {
    grow(w);
    const cnt = new Array(NN_ + 1).fill(0); for (let k = 0; k < N; k++) cnt[owner[k]]++;
    let maxErr = 0;
    NATIONS.forEach((n, i) => {
      const share = cnt[i + 1] / landCount;
      maxErr = Math.max(maxErr, Math.abs(share - n.areaShare));
      w[i] *= Math.pow(share / n.areaShare, 0.55);
    });
    const gm = Math.pow(w.reduce((a, b) => a * b, 1), 1 / NN_); for (let i = 0; i < NN_; i++) w[i] /= gm;
    if (maxErr < 0.008) break;
  }
  grow(w);
}
// glätten: Modus-Filter, Mini-Exklaven entfernen
for (let pass = 0; pass < 3; pass++) {
  const src = owner.slice();
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const k = y * W + x;
    if (!mainLand[k]) continue;
    const cnt = new Array(NN_ + 1).fill(0);
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const n = src[(y + dy) * W + x + dx]; if (n) cnt[n]++; }
    let b = src[k]; for (let o = 1; o <= NN_; o++) if (cnt[o] > cnt[b]) b = o;
    owner[k] = b;
  }
}
for (let o = 1; o <= NN_; o++) {
  const m = owner.map((v) => (v === o ? 1 : 0));
  const lc = components(m, false);
  let big = 0; for (let i = 1; i < lc.sizes.length; i++) if (lc.sizes[i] > lc.sizes[big]) big = i;
  for (let k = 0; k < N; k++) {
    if (!m[k] || lc.lab[k] === big || lc.sizes[lc.lab[k]] > 6000) continue;
    const x = k % W, y = (k / W) | 0, cnt = new Array(NN_ + 1).fill(0);
    for (let d = 0; d < 4; d++) { const nx = x + DX[d], ny = y + DY[d]; if (nx >= 0 && ny >= 0 && nx < W && ny < H) { const v = owner[ny * W + nx]; if (v && v !== o) cnt[v]++; } }
    let b = 0; for (let q = 1; q <= NN_; q++) if (cnt[q] > cnt[b]) b = q;
    if (b) owner[k] = b;
  }
}
// Inseln & Reste: nächstes Land (BFS über alle Zellen)
{
  const ids = owner.slice();
  let frontier = []; for (let k = 0; k < N; k++) if (ids[k]) frontier.push(k);
  while (frontier.length) {
    const next = [];
    for (const k of frontier) {
      const x = k % W, y = (k / W) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d], ny = y + DY[d];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const n = ny * W + nx;
        if (ids[n]) continue;
        ids[n] = ids[k];
        if (!sea[n]) owner[n] = ids[k];
        next.push(n);
      }
    }
    frontier = next;
  }
}
for (let k = 0; k < N; k++) if (sea[k]) owner[k] = 0;
const nationCells = new Array(NN_ + 1).fill(0); for (let k = 0; k < N; k++) nationCells[owner[k]]++;
let ownedLand = 0; for (let k = 1; k <= NN_; k++) ownedLand += nationCells[k];
const shares = NATIONS.map((n, i) => nationCells[i + 1] / ownedLand);
log('Flächenanteile', NATIONS.map((n, i) => `${n.a3} ${(shares[i] * 100).toFixed(1)}%`).join(' '));

// Distanz zu fremdem Gebiet (Grenzabstand) je Nation
const borderDist = [null];
for (let o = 1; o <= NN_; o++) {
  const m = new Uint8Array(N);
  for (let k = 0; k < N; k++) if (!sea[k] && owner[k] !== o) m[k] = 1; // fremdes Land (Meer zählt nicht als Grenze)
  borderDist.push(distKm(m));
}
const ownBorder = distKm(owner.map((v, k) => 0)); // Platzhalter (nicht genutzt)

// ---------------------------------------------------------------- 4) Städte, Ölfelder, Knoten
log('Städte & Ölfelder…');
const nationOf = (k) => owner[k] - 1;
const cities = []; // {name,nat,pop,capital,cell,port}
const taken = (cell, minKm, list = cities) => list.some((c) => cellDistKm(c.cell, cell) < minKm);

// Namensgeneratoren
const usedNames = new Set(NATIONS.map((n) => n.capital));
const FLAVOUR = {
  west: { stems: ['Val', 'Bre', 'Cor', 'Tol', 'Vel', 'Gra', 'Lju', 'Mor', 'Pol', 'Sta', 'Tri', 'Kra', 'Bov', 'Cel', 'Dra', 'Pre', 'Zel', 'Ora', 'Sev', 'Rav'], mids: ['', '', 'ni', 'vi', 'ko', 'la', 'ri', 'ba'], ends: ['ica', 'ovo', 'ec', 'ano', 'ino', 'je', 'burg', 'enza', 'jan', 'ik', 'ava', 'ona'] },
  east: { stems: ['Stein', 'Ost', 'Hohen', 'Wald', 'Grün', 'Rau', 'Eis', 'Lind', 'Berg', 'Drau', 'Mark', 'Fels', 'Neu', 'Kron', 'Bad', 'Nord', 'Alt', 'Rot'], mids: ['', '', '', 'en', 'er'], ends: ['dorf', 'burg', 'stadt', 'au', 'heim', 'furt', 'bach', 'itz', 'brück', 'ow', 'kirchen', 'hof'] },
  north: { stems: ['Szent', 'Nagy', 'Kis', 'Kecs', 'Deb', 'Győr', 'Pécs', 'Mis', 'Vesz', 'Tat', 'Eger', 'Szek', 'Zala', 'Bala', 'Kapos', 'Sop', 'Hód', 'Baj', 'Szol', 'Ráb'], mids: ['', '', 'a', 'e', 'o', 'ka'], ends: ['vár', 'falva', 'háza', 'hely', 'kút', 'ód', 'ány', 'esd', 'árd', 'szeg', 'laka', 'kert', 'pest', 'tó'] },
  south: { stems: ['Mar', 'Sol', 'Cal', 'Pia', 'Por', 'Ven', 'Ros', 'Lid', 'Tor', 'Bel', 'Cas', 'Mon', 'Sal', 'Vil', 'Cor', 'Ser', 'Lav'], mids: ['', 'e', 'a', 'o', 'ar'], ends: ['ena', 'ora', 'ino', 'etta', 'ago', 'ia', 'one', 'ara', 'ello', 'ona', 'eto', 'ola', 'azzo'] },
};
const flavourOf = (n) => FLAVOUR[n.homeland] ?? FLAVOUR.west;
function genName(nat) {
  const f = flavourOf(NATIONS[nat]);
  for (let t = 0; t < 200; t++) {
    const nm = rpick(f.stems) + rpick(f.mids) + rpick(f.ends);
    if (!usedNames.has(nm) && nm.length >= 5 && nm.length <= 11) { usedNames.add(nm); return nm; }
  }
  const nm = rpick(f.stems) + rpick(f.ends) + (usedNames.size % 9); usedNames.add(nm); return nm;
}

// Hauptstädte: im Kern, flach, nahe Fluss
const centroid = NATIONS.map(() => [0, 0, 0]);
for (let k = 0; k < N; k++) if (owner[k]) { const c = centroid[owner[k] - 1]; c[0] += cx(k); c[1] += cy(k); c[2]++; }
const cent = centroid.map((c) => [(c[0] / c[2] + 0.5) * CELL, (c[1] / c[2] + 0.5) * CELL]);
// Team-Symmetrie (2v2): Kronland darf nicht viel näher an Marenia liegen als die übrigen Gegnerpaare -> Hauptstadt Richtung Nordosten ziehen
const CAP_ANCHOR = { KRN: [0.88, 0.42] };
NATIONS.forEach((n, ni) => {
  let best = -1, bs = -1e9;
  const sx = kmX(seeds[ni]), sz = kmZ(seeds[ni]);
  for (let y = 8; y < H - 8; y += 3) for (let x = 8; x < W - 8; x += 3) {
    const k = y * W + x;
    if (owner[k] !== ni + 1 || !mainLand[k] || wet[k] || wetDist[k] < 1.2 || heights[k] > 420 || grad[k] > 0.05) continue;
    if (seaDist[k] < 3) continue;
    const bd = Math.min(borderDist[ni + 1][k], 35);
    const rv = riverDist[k];
    let s = (CAP_ANCHOR[n.a3] ? -0.45 * Math.hypot(kmX(k) - CAP_ANCHOR[n.a3][0] * WKM, kmZ(k) - CAP_ANCHOR[n.a3][1] * HKM) : 0) - wetFrac[k] * 12 + bd * 1.0 + (rv >= 1.5 && rv <= 7 ? 9 : 0) - gBox4[k] * 220 - 0.12 * Math.hypot(kmX(k) - cent[ni][0], kmZ(k) - cent[ni][1]) - 0.05 * Math.hypot(kmX(k) - sx, kmZ(k) - sz);
    if (s > bs) { bs = s; best = k; }
  }
  if (best < 0) throw new Error('Keine Hauptstadt-Position für ' + n.a3);
  cities.push({ name: n.capital, nat: ni, pop: 0, capital: true, cell: best, port: false });
});
// Weitere Städte
const CITY_COUNT = [6, 6, 5, 5];
const coastCells = NATIONS.map((n, ni) => { let c = 0; for (let k = 0; k < N; k += 3) if (owner[k] === ni + 1 && seaDist[k] < 2.5) c++; return c; });
const portsWanted = NATIONS.map((n, ni) => (coastCells[ni] > 800 ? 2 : coastCells[ni] > 150 ? 1 : 0));
function citySpots(ni, port) {
  const out = [];
  for (let y = 6; y < H - 6; y += 4) for (let x = 6; x < W - 6; x += 4) {
    const k = y * W + x;
    if (owner[k] !== ni + 1 || !mainLand[k] || wet[k] || heights[k] > 650 || gBox4[k] > 0.075) continue;
    if (port) { if (seaDist[k] < 0.9 || seaDist[k] > 3 || riverDist[k] < 0.5) continue; }
    else if (wetDist[k] < 0.9) continue;
    const rv = riverDist[k];
    let s = -gBox4[k] * 140 + (rv >= 1.2 && rv <= 6 ? 4 : 0) - heights[k] / 260 + rnd() * 3.5 + Math.min(borderDist[ni + 1][k], 18) * 0.12;
    if (!port && seaDist[k] > 0.9 && seaDist[k] < 3) s += 1.5;
    out.push([s, k]);
  }
  out.sort((a, b) => b[0] - a[0]);
  return out;
}
const SPACING = 25;
NATIONS.forEach((n, ni) => {
  let ports = 0;
  const want = CITY_COUNT[ni];
  for (let pass = 0; pass < 2; pass++) {
    const spacing = pass === 0 ? SPACING : 21;
    for (let guard = 0; cities.filter((c) => c.nat === ni).length < want && guard < 8; guard++) {
      const needPort = ports < portsWanted[ni];
      const spots = citySpots(ni, needPort);
      let placed = false;
      for (const [, k] of spots) {
        if (taken(k, spacing)) continue;
        cities.push({ name: genName(ni), nat: ni, pop: 0, capital: false, cell: k, port: needPort });
        if (needPort) ports++;
        placed = true; break;
      }
      if (!placed && needPort) { portsWanted[ni] = ports; }
      else if (!placed) break;
    }
  }
});
// Einwohnerzahlen
NATIONS.forEach((n, ni) => {
  const mine = cities.filter((c) => c.nat === ni);
  const cap = mine.find((c) => c.capital);
  cap.pop = Math.round((430 + rnd() * 440) / 5) * 5000;
  const rest = mine.filter((c) => !c.capital).sort((a, b) => 0 + (rnd() - 0.5));
  rest.forEach((c, i) => { c.pop = Math.max(15000, Math.round((cap.pop * Math.pow(i + 2, -1.55) * (0.55 + rnd() * 0.9)) / 1000) * 1000); });
});
{
  // Team-Bilanz: Einwohner je Team (MP_TEAMS) auf +-4 % angleichen (kleineres Team skaliert hoch)
  const teamOf = (ni) => MP_TEAMS.findIndex((t) => t.includes(NATIONS[ni].a3));
  const tot = [0, 0]; cities.forEach((c) => { tot[teamOf(c.nat)] += c.pop; });
  const lo = tot[0] < tot[1] ? 0 : 1, f = tot[1 - lo] / tot[lo];
  if (f > 1.04) cities.forEach((c) => { if (teamOf(c.nat) === lo) c.pop = Math.round((c.pop * (1 + (f - 1) * 0.98)) / 1000) * 1000; });
}
if (cities.length < 20 || cities.length > 23) log(`WARNUNG: ${cities.length} Städte`);

// HQ / Raffinerie / Spawn je Nation
const capCityIdx = NATIONS.map((n, ni) => cities.findIndex((c) => c.nat === ni && c.capital));
const startPos = NATIONS.map((n, ni) => {
  const cap = cities[capCityIdx[ni]];
  const enemies = NATIONS.map((_, i) => i).filter((i) => i !== ni);
  // Front: Richtung zur nächsten feindlichen Hauptstadt (Krieg laut Szenario), sonst nächste
  const foes = enemies.filter((i) => !MP_TEAMS.some((t) => t.includes(n.a3) && t.includes(NATIONS[i].a3)));
  const tgt = (foes.length ? foes : enemies).map((i) => cities[capCityIdx[i]]).sort((a, b) => cellDistKm(a.cell, cap.cell) - cellDistKm(b.cell, cap.cell))[0];
  const fx = kmX(tgt.cell) - kmX(cap.cell), fz = kmZ(tgt.cell) - kmZ(cap.cell), fl = Math.hypot(fx, fz);
  const dirx = fx / fl, dirz = fz / fl;
  const cr = cityRadiusKm(cap.pop, true);
  const find = (minD, maxD, from, better) => {
    let best = -1, bs = -1e9;
    const fxk = kmX(from), fzk = kmZ(from), r = Math.ceil(maxD / CELL);
    const x0 = cx(from), y0 = cy(from);
    for (let y = Math.max(2, y0 - r); y <= Math.min(H - 3, y0 + r); y += 2) for (let x = Math.max(2, x0 - r); x <= Math.min(W - 3, x0 + r); x += 2) {
      const k = y * W + x;
      const d = Math.hypot(kmX(k) - fxk, kmZ(k) - fzk);
      if (d < minD || d > maxD || owner[k] !== ni + 1 || !mainLand[k]) continue;
      const s = better(k, d, ((kmX(k) - fxk) * dirx + (kmZ(k) - fzk) * dirz) / Math.max(d, 1e-6));
      if (s > bs) { bs = s; best = k; }
    }
    return best;
  };
  // Wasser in der Nähe: Einheiten der Startaufstellung werden im Umkreis verteilt und dürfen nicht in Seen-/Sumpf-Taschen landen
  let hq = -1;
  for (const wn of [0.012, 0.03, 0.08, 1]) { hq = find(cr + 0.6, cr + 4.5, cap.cell, (k, d, cs) => (wetNear[k] > wn || wetDist[k] < 0.8 || gBox2[k] > 0.05 ? -1e9 : -wetFrac[k] * 120 - gBox2[k] * 120 - Math.abs(d - (cr + 1.8)) * 0.8 + cs * 0.8)); if (hq >= 0) break; }
  const ref = find(1.4, 3.2, hq, (k, d, cs) => (wetDist[k] < 0.6 || gBox2[k] > 0.05 || cellDistKm(k, cap.cell) < cr + 0.3 ? -1e9 : -gBox2[k] * 120 - Math.abs(d - 2) * 0.6 - cs * 0.6));
  // Startplatz: >= 35 km vom Fremdland (Meer zählt nicht), sonst schrittweise gelockert
  let spawn = -1, spawnBd = 0;
  for (const minBd of [35, 28, 22, 16, 10, 3]) {
    spawn = find(7, 15, cap.cell, (k, d, cs) => (wetDist[k] < 2 || wetNear[k] > 0.02 || wetFrac[k] > 0.2 || borderDist[ni + 1][k] < minBd || heights[k] > 700 ? -1e9 : -wetFrac[k] * 120 - gBox8[k] * 90 - gBox2[k] * 60 + cs * 2.2 - Math.abs(d - 10) * 0.08 + Math.min(borderDist[ni + 1][k], 40) * 0.05));
    if (spawn >= 0) { spawnBd = minBd; break; }
  }
  log(`Startplatz ${n.a3}: Grenzabstand ${borderDist[ni + 1][spawn].toFixed(1)} km (Vorgabe ${spawnBd})`);
  if (hq < 0 || ref < 0 || spawn < 0) throw new Error('HQ/Raffinerie/Spawn nicht gefunden für ' + n.a3);
  return { hq, ref, spawn };
});
// Ölfelder: je Nation 3 (1 umkämpft nahe einer Grenze zu einer Feindnation laut MP_TEAMS, 2 im Kernland)
const oilFields = [];
const teamIdx = (ni) => MP_TEAMS.findIndex((t) => t.includes(NATIONS[ni].a3));
{
  const cand = [];
  for (let y = 10; y < H - 10; y += 4) for (let x = 10; x < W - 10; x += 4) {
    const k = y * W + x;
    if (!owner[k] || !mainLand[k] || wet[k] || wetDist[k] < 1.5) continue;
    const strict = heights[k] <= 230 && gBox2[k] <= 0.02 && hBox40[k] <= 300;
    const loose = heights[k] <= 420 && gBox2[k] <= 0.04 && hBox40[k] <= 520;
    const valley = heights[k] <= 620 && gBox2[k] <= 0.05 && hBox40[k] <= 760; // Talboden im Gebirge (nur Notlösung)
    if (!strict && !loose && !valley) continue;
    if (cities.some((c) => cellDistKm(c.cell, k) < 9)) continue;
    if (startPos.some((p) => cellDistKm(p.hq, k) < 9 || cellDistKm(p.spawn, k) < 9)) continue;
    const ownCap = cities.find((c) => c.capital && c.nat === nationOf(k));
    cand.push({ k, ni: nationOf(k), score: -gBox4[k] * 40 - heights[k] / 120 - hBox40[k] / 250 - cellDistKm(ownCap.cell, k) / 22 + rnd() * 2 - (strict ? 0 : loose ? 6 : 10), bd: borderDist[nationOf(k) + 1][k], dCap: cellDistKm(ownCap.cell, k) });
  }
  cand.sort((a, b) => b.score - a.score);
  log(`Ölfeld-Kandidaten: ${cand.length}`);
  const ok = (k, spacing = 18) => !oilFields.some((f) => cellDistKm(f.cell, k) < spacing);
  const add = (k, contested) => oilFields.push({ cell: k, nat: nationOf(k), contested });
  // Feind-Team-Nation in der Nähe (Strahlensuche bis 32 km)?
  const foeNear = (q) => {
    const x = cx(q.k), y = cy(q.k);
    for (let r = 4; r <= 128; r += 4) for (let d = 0; d < 8; d++) { const nx = x + DX[d] * r, ny = y + DY[d] * r; if (nx >= 0 && ny >= 0 && nx < W && ny < H) { const o = owner[ny * W + nx] - 1; if (o >= 0 && teamIdx(o) !== teamIdx(q.ni)) return true; } }
    return false;
  };
  const perNation = OIL_FIELDS_PER_MAP / NATIONS.length;
  NATIONS.forEach((n, ni) => {
    // umkämpft: möglichst grenznah (bd 3..8 km) und gut platziert
    let c = cand.find((q) => q.ni === ni && ok(q.k) && q.bd >= 3 && q.bd < 9 && foeNear(q));
    if (!c) c = cand.find((q) => q.ni === ni && ok(q.k, 12) && q.bd < 14 && foeNear(q));
    if (c) add(c.k, true);
  });
  for (let round = 0; round < perNation; round++) NATIONS.forEach((n, ni) => {
    const have = oilFields.filter((f) => f.nat === ni).length;
    if (have >= perNation) return;
    // Kernlandfelder: ca. 40 km von der Hauptstadt (gleichmäßige Nachschubwege für alle Nationen), nicht an der Grenze
    const homeScore = (q) => q.score * 0.5 - Math.abs(q.dCap - 40) / 7;
    let c = null, cs = -1e9;
    for (const q of cand) if (q.ni === ni && q.bd >= 12 && q.dCap <= 75 && ok(q.k) && homeScore(q) > cs) { cs = homeScore(q); c = q; }
    if (!c) c = cand.find((q) => q.ni === ni && ok(q.k, 12) && q.bd >= 6);
    if (!c) c = cand.find((q) => q.ni === ni && ok(q.k, 9));
    if (c) add(c.k, false); else log('WARNUNG: kein Ölfeld für', n.a3);
  });
}
const OIL_SURN = {
  west: ['Karsten', 'Dolnik', 'Petran', 'Zorin', 'Lavrik', 'Medved', 'Brezan', 'Kovar', 'Sedlak', 'Vranec'],
  east: ['Karsten', 'Brandt', 'Voss', 'Hartmann', 'Reiter', 'Lorenz', 'Adler', 'Falke', 'Krüger', 'Nord'],
  south: ['Ferro', 'Sorel', 'Costa', 'Marin', 'Bellini', 'Vero', 'Rossa', 'Salina', 'Corvo', 'Dorada'],
};
OIL_SURN.north = ['Szabó', 'Nagy', 'Kovács', 'Tóth', 'Horváth', 'Varga', 'Balogh', 'Farkas', 'Molnár', 'Fekete'];
const OIL_PRE = { west: 'Polje', east: 'Feld', south: 'Campo', north: 'Kút' };
oilFields.forEach((f, i) => {
  const n = NATIONS[f.nat];
  let nm;
  do { nm = f.contested && n.a3 === 'KRN' ? `Feld Karsten-${1 + Math.floor(rnd() * 9)}` : `${OIL_PRE[n.homeland] ?? 'Feld'} ${rpick(OIL_SURN[n.homeland] ?? OIL_SURN.east)}-${1 + Math.floor(rnd() * 9)}`; } while (usedNames.has(nm));
  usedNames.add(nm);
  f.name = nm; f.id = i + 1;
  f.output = Math.round((f.contested ? 40 + rnd() * 20 : 20 + rnd() * 30));
});
{
  // Team-Bilanz der Förderleistung: Summe je Team auf +-3 % angleichen
  for (let it = 0; it < 4; it++) {
    const tot = [0, 0]; oilFields.forEach((f) => { tot[teamIdx(f.nat)] += f.output; });
    const lo = tot[0] < tot[1] ? 0 : 1, ratio = tot[1 - lo] / tot[lo];
    if (ratio < 1.02) break;
    oilFields.forEach((f) => { if (teamIdx(f.nat) === lo) f.output = Math.max(15, Math.min(70, Math.round(f.output * ratio))); });
  }  // Ausgleich: Marenia hat die kleinste Armee und die längste Front zu Kronland -> Team West bekommt ca. +7 % Förderleistung, Rest bei Marenia zuerst
  const tot = [0, 0]; oilFields.forEach((f) => { tot[teamIdx(f.nat)] += f.output; });
  let need = Math.round(tot[1] * 1.07 - tot[0]);
  const west = oilFields.filter((f) => teamIdx(f.nat) === 0).sort((x, y) => (NATIONS[x.nat].a3 === 'MAR' ? 0 : 1) - (NATIONS[y.nat].a3 === 'MAR' ? 0 : 1) || x.output - y.output);
  for (let pass = 0; pass < 6 && need > 0; pass++) for (const f of west) { if (need <= 0) break; const add = Math.min(need, 70 - f.output, 6); if (add > 0) { f.output += add; need -= add; } }
}

// Dörfer-Knoten
const hubs = [];
{
  const spots = [];
  for (let y = 6; y < H - 6; y += 4) for (let x = 6; x < W - 6; x += 4) {
    const k = y * W + x;
    if (!owner[k] || !mainLand[k] || wet[k] || wetDist[k] < 1.2 || gBox2[k] > 0.13 || heights[k] > 1000) continue;
    spots.push([rnd() - gBox4[k] * 3, k]);
  }
  spots.sort((a, b) => b[0] - a[0]);
  const near = (k, km) => cities.some((c) => cellDistKm(c.cell, k) < km) || oilFields.some((f) => cellDistKm(f.cell, k) < km) || hubs.some((h) => cellDistKm(h, k) < km);
  const perNat = NATIONS.map((n, i) => Math.round(34 * shares[i]));
  const cnt = NATIONS.map(() => 0);
  for (const [, k] of spots) {
    if (hubs.length >= 34) break;
    const ni = nationOf(k);
    if (cnt[ni] >= perNat[ni]) continue;
    if (!near(k, 7.5)) { hubs.push(k); cnt[ni]++; }
  }
}

function cityRadiusKm(pop, capital) {
  const popM = Math.max(0.02, pop / 1e6);
  return Math.min(9, 0.9 + Math.sqrt(popM) * 1.5 + (capital ? 0.3 : 0));
}

// ---------------------------------------------------------------- 5) Straßen- und Schienennetz
log('Straßennetz…');
const ROAD_CLASSES = ['motorway', 'primary', 'secondary', 'road', 'track', 'rail', 'ferry'];
const C_MOTOR = 0, C_PRIMARY = 1, C_SECOND = 2, C_ROAD = 3, C_TRACK = 4, C_RAIL = 5;
// Kostenprofile: 0 Straße, 1 Autobahn, 2 Schiene
const G0 = [0.08, 0.045, 0.03], GMAX = [0.42, 0.22, 0.075];
const PEN_RIVER = [5, 7, 9], PEN_LAKE = [12, 15, 20];
const F = [0, 1, 2].map(() => new Float32Array(N)), P = [0, 1, 2].map(() => new Float32Array(N));
for (let k = 0; k < N; k++) {
  const x = k % W, y = (k / W) | 0;
  const nz = 0.9 + 0.35 * vnoise(x / 22, y / 22, 5);
  for (let p = 0; p < 3; p++) {
    if (sea[k] || grad[k] > GMAX[p]) { F[p][k] = Infinity; continue; }
    const q = grad[k] / G0[p];
    F[p][k] = (1 + q * q) * nz;
    P[p][k] = water[k] === 2 ? PEN_RIVER[p] : water[k] === 1 ? PEN_LAKE[p] : 0;
  }
}
// Uferstreifen meiden (Straße soll nicht am Ufer entlang schrammen und dabei „Brücken“ bilden)
for (let k = 0; k < N; k++) {
  if (inland[k] || sea[k]) continue;
  const x = k % W, y = (k / W) | 0;
  let bank = false;
  for (let d = 0; d < 8 && !bank; d++) { const nx = x + DX[d], ny = y + DY[d]; if (nx >= 0 && ny >= 0 && nx < W && ny < H && inland[ny * W + nx]) bank = true; }
  if (bank) for (let p = 0; p < 3; p++) P[p][k] += 0.6;
}
const dirIndex = new Int8Array(9);
for (let d = 0; d < 8; d++) dirIndex[(DX[d] + 1) * 3 + (DY[d] + 1)] = d;
const pairKey = (a, b) => (a < b ? a * N + b : b * N + a);
const mkLayer = () => ({ netDir: new Uint8Array(N), pairs: new Map(), terminals: new Set() });
const roadL = mkLayer(), railL = mkLayer();
const dist = new Float64Array(N), prev = new Int32Array(N);
const heap = new Heap(1 << 20);
let XP = null; // Zusatzstrafe je Zelle (für Ausweichrouten)
/** Dijkstra; Ziel = Zelle, Maske (nicht 0) oder Menge (alle abarbeiten). Rückgabe: Endzelle oder -1 */
function search(srcs, prof, L, disc, target, mask, allSet) {
  dist.fill(Infinity); heap.clear();
  for (const s of srcs) { dist[s] = 0; prev[s] = -1; heap.push(0, s); }
  const Fp = F[prof], Pp = P[prof], net = L.netDir;
  let remain = allSet ? allSet.size : 0;
  while (heap.n) {
    const c = heap.pop(), dc = heap.lastKey;
    if (dc > dist[c]) continue;
    if (allSet) { if (allSet.has(c) && --remain === 0) return c; }
    else if (c === target || (mask && mask[c] && dc > 0)) return c;
    const x = c % W, y = (c / W) | 0, nb = net[c], fc = Fp[c];
    for (let d = 0; d < 8; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const n = ny * W + nx, fn = Fp[n];
      if (fn === Infinity) continue;
      let step = DLEN[d] * CELL * 0.5 * (fc + fn);
      if ((nb >> d) & 1) step *= disc; else step += Pp[n];
      if (XP) step += XP[n];
      const nd = dc + step;
      if (nd < dist[n]) { dist[n] = nd; prev[n] = c; heap.push(nd, n); }
    }
  }
  return -1;
}
function pathTo(end) { const p = []; for (let c = end; c >= 0; c = prev[c]) p.push(c); return p.reverse(); }
const crossings = [];
function addPath(path, cls, L) {
  if (L === roadL && cls <= C_SECOND) {
    for (let i = 1; i + 1 < path.length; i++) if (inland[path[i]] && !inland[path[i - 1]]) { let j = i; while (j + 1 < path.length && inland[path[j]]) j++; crossings.push([path[i - 1], path[j]]); }
  }
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i], b = path[i + 1];
    const d = dirIndex[(cx(b) - cx(a) + 1) * 3 + (cy(b) - cy(a) + 1)];
    L.netDir[a] |= 1 << d; L.netDir[b] |= 1 << OPP[d];
    const key = pairKey(a, b), old = L.pairs.get(key);
    if (old === undefined || cls < old) L.pairs.set(key, cls);
  }
}
function routeP2P(a, b, cls, L, prof, disc = 0.22) {
  L.terminals.add(a); L.terminals.add(b);
  if (a === b) return true;
  const e = search([a], prof, L, disc, b, null, null);
  if (e < 0) return false;
  addPath(pathTo(e), cls, L);
  return true;
}
function routeToNet(a, cls, L, prof, disc = 0.22) {
  L.terminals.add(a);
  if (L.netDir[a]) return true;
  const e = search([a], prof, L, disc, -1, L.netDir, null);
  if (e < 0) return false;
  addPath(pathTo(e), cls, L);
  return true;
}

// Stadtgraph
const nC = cities.length;
const cityCost = Array.from({ length: nC }, () => new Float64Array(nC).fill(Infinity));
for (let i = 0; i < nC; i++) {
  const others = new Set(cities.filter((_, j) => j !== i).map((c) => c.cell));
  search([cities[i].cell], 0, roadL, 1, -1, null, others);
  for (let j = 0; j < nC; j++) if (j !== i) cityCost[i][j] = dist[cities[j].cell];
}
for (let i = 0; i < nC; i++) for (let j = i + 1; j < nC; j++) { const m = Math.min(cityCost[i][j], cityCost[j][i]); cityCost[i][j] = cityCost[j][i] = m; }
const cityEdges = new Map(); // "i-j" -> {i,j,kind}
const eKey = (i, j) => (i < j ? `${i}-${j}` : `${j}-${i}`);
const addCityEdge = (i, j, kind) => { if (i !== j && isFinite(cityCost[i][j]) && !cityEdges.has(eKey(i, j))) cityEdges.set(eKey(i, j), { i: Math.min(i, j), j: Math.max(i, j), kind }); };
{
  // MST (Prim)
  const inT = new Uint8Array(nC); inT[0] = 1;
  for (let it = 1; it < nC; it++) {
    let bi = -1, bj = -1, bc = Infinity;
    for (let i = 0; i < nC; i++) if (inT[i]) for (let j = 0; j < nC; j++) if (!inT[j] && cityCost[i][j] < bc) { bc = cityCost[i][j]; bi = i; bj = j; }
    if (bj < 0) break;
    inT[bj] = 1; addCityEdge(bi, bj, 'mst');
  }
  // Relative-Neighbourhood-Graph für Schleifen
  for (let i = 0; i < nC; i++) for (let j = i + 1; j < nC; j++) {
    let ok = true;
    for (let k = 0; k < nC && ok; k++) if (k !== i && k !== j && Math.max(cityCost[i][k], cityCost[k][j]) < cityCost[i][j] * 0.97) ok = false;
    if (ok) addCityEdge(i, j, 'rng');
  }
  // mindestens 2 Verbindungen je Nationenpaar mit gemeinsamer Grenze
  const adj = Array.from({ length: NN_ }, () => new Array(NN_).fill(0));
  for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) { const o = owner[y * W + x]; for (const n of [owner[y * W + x + 1], owner[(y + 1) * W + x]]) if (o && n && o !== n) { adj[o - 1][n - 1]++; adj[n - 1][o - 1]++; } }
  log('Grenzlängen (Zellen): ' + adj.map((r, i) => NATIONS[i].a3 + ':' + r.join('/')).join(' '));
  for (let a = 0; a < NN_; a++) for (let b = a + 1; b < NN_; b++) {
    if (adj[a][b] < 40) continue;
    const cand = [];
    for (let i = 0; i < nC; i++) for (let j = 0; j < nC; j++) if (cities[i].nat === a && cities[j].nat === b) cand.push([cityCost[i][j], i, j]);
    cand.sort((x, y) => x[0] - y[0]);
    const have = [...cityEdges.values()].filter((e) => (cities[e.i].nat === a && cities[e.j].nat === b) || (cities[e.i].nat === b && cities[e.j].nat === a)).length;
    let need = Math.max(0, 2 - have);
    for (const [c, i, j] of cand) { if (!need) break; if (!cityEdges.has(eKey(i, j)) && c < cand[0][0] * 2.6) { addCityEdge(i, j, 'xb'); need--; } }
  }
  // jede Stadt mindestens 2 Verbindungen
  for (let i = 0; i < nC; i++) {
    const deg = () => [...cityEdges.values()].filter((e) => e.i === i || e.j === i).length;
    const order = [...Array(nC).keys()].filter((j) => j !== i).sort((x, y) => cityCost[i][x] - cityCost[i][y]);
    for (const j of order) { if (deg() >= 2) break; addCityEdge(i, j, 'deg'); }
  }
}
// Autobahnen: Hauptstadt - Hauptstadt (über bestehende Trassen); danach Primär/Sekundär
const capIdx = capCityIdx;
let motorOk = 0;
for (let a = 0; a < NN_; a++) for (let b = a + 1; b < NN_; b++) if (routeP2P(cities[capIdx[a]].cell, cities[capIdx[b]].cell, C_MOTOR, roadL, 1, 0.3)) motorOk++;
const edgeList = [...cityEdges.values()].sort((x, y) => cityCost[x.i][x.j] - cityCost[y.i][y.j]);
for (const e of edgeList) {
  const big = cities[e.i].capital || cities[e.j].capital || cities[e.i].pop + cities[e.j].pop > 330000;
  routeP2P(cities[e.i].cell, cities[e.j].cell, big ? C_PRIMARY : C_SECOND, roadL, 0);
}
// Ausweichrouten: zweite Trasse mit anderem Flussübergang (Redundanz; einige Engpässe bleiben)
let altCount = 0;
function altRoute(a, b, cls) {
  const e = search([a], 0, roadL, 0.22, b, null, null);
  if (e < 0) return;
  const base = dist[e];
  const p = pathTo(e);
  const zone = new Float32Array(N);
  let any = false;
  for (const c of p) {
    if (!inland[c]) continue;
    any = true;
    const x0 = cx(c), y0 = cy(c);
    for (let dy = -14; dy <= 14; dy++) for (let dx = -14; dx <= 14; dx++) {
      const nx = x0 + dx, ny = y0 + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H || dx * dx + dy * dy > 196) continue;
      if (inland[ny * W + nx]) zone[ny * W + nx] = 90;
    }
  }
  XP = zone;
  const e2 = search([a], 0, roadL, 0.6, b, null, null);
  XP = null;
  if (e2 < 0 || dist[e2] > base * 6.5) return;
  addPath(pathTo(e2), cls, roadL);
  altCount++;
}
for (const e of edgeList) {
  const big = cities[e.i].capital || cities[e.j].capital || cities[e.i].pop + cities[e.j].pop > 330000;
  if ((big || e.kind === 'xb') && rnd() < 0.7) altRoute(cities[e.i].cell, cities[e.j].cell, big ? C_SECOND : C_ROAD);
}
log(`Ausweichrouten: ${altCount}`);
// Umgehungen: zu den Flussübergängen der Hauptstraßen zweite Übergänge (nicht überall -> einige Engpässe bleiben)
{
  const done = [];
  let made = 0, tried = 0, skipped = 0;
  const cross = crossings.slice().sort(() => rnd() - 0.5);
  for (const [a, b] of cross) {
    const mx = (kmX(a) + kmX(b)) / 2, mz = (kmZ(a) + kmZ(b)) / 2;
    if (done.some(([x, z]) => Math.hypot(x - mx, z - mz) < 1)) continue;
    done.push([mx, mz]);
    if (skipped < 3 || rnd() < 0.62) { skipped++; continue; } // bewusst ohne Umgehung -> Engpässe
    tried++;
    const zone = new Float32Array(N);
    const x0 = cx(a), y0 = cy(a);
    for (let dy = -26; dy <= 26; dy++) for (let dx = -26; dx <= 26; dx++) {
      const nx = x0 + dx, ny = y0 + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H || dx * dx + dy * dy > 676) continue;
      if (inland[ny * W + nx]) zone[ny * W + nx] = 400;
    }
    XP = zone;
    const e2 = search([a], 0, roadL, 0.35, b, null, null);
    XP = null;
    if (e2 < 0 || dist[e2] > 330) continue;
    addPath(pathTo(e2), C_SECOND, roadL);
    made++;
  }
  log(`Umgehungen: ${made}/${tried} (Übergänge ${done.length})`);
}
// HQ & Raffinerie
startPos.forEach((sp, ni) => {
  routeP2P(sp.hq, cities[capIdx[ni]].cell, C_SECOND, roadL, 0);
  routeP2P(sp.ref, sp.hq, C_ROAD, roadL, 0);
});
// Ölfelder
for (const f of oilFields) { if (!routeToNet(f.cell, C_ROAD, roadL, 0)) log('WARNUNG: Ölfeld ohne Straße', f.name); }
// Dörfer
{
  const order = hubs.slice().sort(() => rnd() - 0.5);
  let ix = 0;
  for (const h of order) { routeToNet(h, ix++ % 5 < 3 ? C_ROAD : C_TRACK, roadL, 0); }
  // Querverbindungen (Tracks) zwischen benachbarten Dörfern
  const pairs = [];
  for (let i = 0; i < hubs.length; i++) for (let j = i + 1; j < hubs.length; j++) { const d = cellDistKm(hubs[i], hubs[j]); if (d > 7 && d < 16) pairs.push([d + rnd() * 6, i, j]); }
  pairs.sort((a, b) => a[0] - b[0]);
  const used = new Set(); let made = 0;
  for (const [, i, j] of pairs) { if (made >= 14) break; if (used.has(i) || used.has(j)) continue; if (routeP2P(hubs[i], hubs[j], C_TRACK, roadL, 0, 0.22)) { used.add(i); used.add(j); made++; } }
}
// Schiene
let railCount = 0;
for (const e of edgeList) {
  if (e.kind === 'deg' && rnd() < 0.5) continue;
  const big = cities[e.i].capital || cities[e.j].capital || cities[e.i].pop + cities[e.j].pop > 330000;
  if (!big && e.kind !== 'mst') continue;
  if (routeP2P(cities[e.i].cell, cities[e.j].cell, C_RAIL, railL, 2, 0.3)) railCount++;
}
log(`Netz-Routen fertig (Schiene ${railCount})`);

// ---- Graph bauen
const nodePos = []; const nodeOfCell = new Map();
const nodeAt = (cell) => { let id = nodeOfCell.get(cell); if (id === undefined) { id = nodePos.length / 2; nodePos.push(kmX(cell), kmZ(cell)); nodeOfCell.set(cell, id); } return id; };
const newNode = (x, z) => { nodePos.push(x, z); return nodePos.length / 2 - 1; };
const outEdges = [];
const popc = (b) => { let n = 0; while (b) { n += b & 1; b >>= 1; } return n; };
function dp(pts, tol) {
  const n = pts.length / 2;
  if (n < 3) return pts;
  const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
  const st = [[0, n - 1]];
  while (st.length) {
    const [a, b] = st.pop();
    const ax = pts[a * 2], az = pts[a * 2 + 1], bx = pts[b * 2], bz = pts[b * 2 + 1];
    const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
    let md = -1, mi = -1;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i * 2] - ax, pz = pts[i * 2 + 1] - az;
      const t = L2 > 0 ? Math.max(0, Math.min(1, (px * dx + pz * dz) / L2)) : 0;
      const d = Math.hypot(px - t * dx, pz - t * dz);
      if (d > md) { md = d; mi = i; }
    }
    if (md > tol) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i * 2], pts[i * 2 + 1]);
  return out;
}
function chaikin(pts) {
  const n = pts.length / 2;
  if (n < 3) return pts;
  const out = [pts[0], pts[1]];
  for (let i = 0; i < n - 1; i++) {
    const ax = pts[i * 2], az = pts[i * 2 + 1], bx = pts[i * 2 + 2], bz = pts[i * 2 + 3];
    if (i > 0) out.push(0.75 * ax + 0.25 * bx, 0.75 * az + 0.25 * bz);
    if (i < n - 2) out.push(0.25 * ax + 0.75 * bx, 0.25 * az + 0.75 * bz);
  }
  out.push(pts[(n - 1) * 2], pts[(n - 1) * 2 + 1]);
  return out;
}
const polyLen = (pts) => { let l = 0; for (let i = 2; i < pts.length; i += 2) l += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]); return l; };
/** Punkt bei Bogenlänge s */
function pointAt(pts, s) {
  let acc = 0;
  for (let i = 2; i < pts.length; i += 2) {
    const l = Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
    if (acc + l >= s || i + 2 >= pts.length) { const f = l > 0 ? Math.min(1, (s - acc) / l) : 0; return [pts[i - 2] + (pts[i] - pts[i - 2]) * f, pts[i - 1] + (pts[i + 1] - pts[i - 1]) * f, i / 2 - 1, f]; }
    acc += l;
  }
  return [pts[pts.length - 2], pts[pts.length - 1], pts.length / 2 - 2, 1];
}
/** Teilpolylinie von s0 bis s1 */
function subPoly(pts, s0, s1) {
  const a = pointAt(pts, s0), b = pointAt(pts, s1);
  const out = [a[0], a[1]];
  for (let i = a[2] + 1; i <= b[2]; i++) out.push(pts[i * 2], pts[i * 2 + 1]);
  out.push(b[0], b[1]);
  return dp(out.length >= 4 ? out : [a[0], a[1], b[0], b[1]], 0.0001);
}
const wetAtKm = (x, z) => inland[cellAt(x, z)] === 1;
const MAX_EDGE_KM = 1.1, BRIDGE_MIN_KM = 0.16, BRIDGE_PAD = 0.07;
function emitChain(cellsPath, cls, aNode, bNode) {
  let pts = [];
  for (const c of cellsPath) pts.push(kmX(c), kmZ(c));
  pts = dp(pts, 0.12);
  pts = chaikin(chaikin(pts));
  pts = dp(pts, 0.03);
  const L = polyLen(pts);
  // Brückenintervalle
  const iv = [];
  const step = 0.04;
  const wetPts = [];
  for (const c of cellsPath) if (inland[c]) wetPts.push(kmX(c), kmZ(c));
  const nearWetPath = (x, z) => { for (let i = 0; i < wetPts.length; i += 2) if (Math.abs(wetPts[i] - x) < 0.5 && Math.abs(wetPts[i + 1] - z) < 0.5) return true; return false; };
  let inWet = false, s0 = 0;
  for (let s = 0; s <= L + 1e-9; s += step) {
    const [x, z] = pointAt(pts, Math.min(s, L));
    const w = wetPts.length > 0 && wetAtKm(x, z) && nearWetPath(x, z);
    if (w && !inWet) { inWet = true; s0 = s; }
    if (!w && inWet) { inWet = false; iv.push([s0, s]); }
  }
  if (inWet) iv.push([s0, L]);
  const merged = [];
  for (const v of iv) { const last = merged[merged.length - 1]; if (last && v[0] - last[1] < 0.2) last[1] = v[1]; else merged.push([v[0], v[1]]); }
  const bridges = merged.filter((v) => v[1] - v[0] >= BRIDGE_MIN_KM).map((v) => [Math.max(0, v[0] - BRIDGE_PAD), Math.min(L, v[1] + BRIDGE_PAD)]);
  // Segmente: [s0,s1,bridge]
  const segs = [];
  let cur = 0;
  for (const [b0, b1] of bridges) { if (b0 > cur + 0.02) segs.push([cur, b0, 0]); segs.push([Math.max(cur, b0), b1, 1]); cur = b1; }
  if (cur < L - 0.02 || !segs.length) segs.push([cur, L, 0]);
  // lange Segmente teilen
  const fin = [];
  for (const [a, b, br] of segs) {
    const len = b - a;
    const n = br ? 1 : Math.max(1, Math.ceil(len / MAX_EDGE_KM));
    for (let i = 0; i < n; i++) fin.push([a + (len * i) / n, a + (len * (i + 1)) / n, br]);
  }
  if (fin.length === 1 && aNode === bNode) { const m = fin[0]; fin.length = 0; fin.push([m[0], (m[0] + m[1]) / 2, 0], [(m[0] + m[1]) / 2, m[1], 0]); }
  let prevNode = aNode;
  fin.forEach(([a, b, br], i) => {
    const last = i === fin.length - 1;
    let endNode;
    if (last) endNode = bNode;
    else { const [x, z] = pointAt(pts, b); endNode = newNode(x, z); }
    const sp = subPoly(pts, a, b);
    // Endpunkte exakt auf Knoten
    sp[0] = nodePos[prevNode * 2]; sp[1] = nodePos[prevNode * 2 + 1];
    sp[sp.length - 2] = nodePos[endNode * 2]; sp[sp.length - 1] = nodePos[endNode * 2 + 1];
    outEdges.push({ a: prevNode, b: endNode, cls, bridge: br, geom: sp });
    prevNode = endNode;
  });
}
function buildLayer(L, cls0) {
  const cellsAct = [];
  for (let c = 0; c < N; c++) if (L.netDir[c]) cellsAct.push(c);
  const nbOf = (c, d) => (cy(c) + DY[d]) * W + cx(c) + DX[d];
  const clsOf = (c, d) => L.pairs.get(pairKey(c, nbOf(c, d)));
  const forced = new Set();
  const isNode = (c) => {
    if (L.terminals.has(c) || forced.has(c)) return true;
    const m = L.netDir[c];
    if (popc(m) !== 2) return true;
    let first = -1;
    for (let d = 0; d < 8; d++) if ((m >> d) & 1) { const k = clsOf(c, d); if (first < 0) first = k; else if (k !== first) return true; }
    return false;
  };
  const seen = new Set();
  const walk = (c0, d0) => {
    const key0 = pairKey(c0, nbOf(c0, d0));
    if (seen.has(key0)) return;
    const cls = L.pairs.get(key0);
    const path = [c0];
    let cur = c0, d = d0;
    for (;;) {
      const n = nbOf(cur, d);
      seen.add(pairKey(cur, n));
      path.push(n);
      if (isNode(n)) break;
      const m = L.netDir[n];
      let nd = -1;
      for (let q = 0; q < 8; q++) if (((m >> q) & 1) && q !== OPP[d]) nd = q;
      cur = n; d = nd;
    }
    emitChain(path, cls, nodeAt(c0), nodeAt(path[path.length - 1]));
  };
  for (const c of cellsAct) if (isNode(c)) for (let d = 0; d < 8; d++) if ((L.netDir[c] >> d) & 1) walk(c, d);
  // reine Schleifen ohne Knoten
  for (const c of cellsAct) for (let d = 0; d < 8; d++) if (((L.netDir[c] >> d) & 1) && !seen.has(pairKey(c, nbOf(c, d)))) { forced.add(c); walk(c, d); }
}
buildLayer(roadL);
buildLayer(railL);

// Länder-ID je Kante, Statistik
const countryOfPt = (x, z) => {
  const c = cellAt(x, z);
  if (owner[c]) return owner[c];
  const x0 = cx(c), y0 = cy(c);
  for (let r = 1; r < 12; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const nx = x0 + dx, ny = y0 + dy; if (nx >= 0 && ny >= 0 && nx < W && ny < H && owner[ny * W + nx]) return owner[ny * W + nx]; }
  return 0;
};
for (const e of outEdges) {
  const [mx, mz] = pointAt(e.geom, polyLen(e.geom) / 2);
  e.country = countryOfPt(mx, mz);
  e.len = polyLen(e.geom);
}

// ---------------------------------------------------------------- 6) Ausgabe: roads.bin
const nNodes = nodePos.length / 2, nEdges = outEdges.length;
{
  // Knoten, die keine Kante haben, entfernen wäre nötig, falls vorhanden -> Kompaktierung
  const used = new Uint8Array(nNodes);
  for (const e of outEdges) { used[e.a] = 1; used[e.b] = 1; }
  const remap = new Int32Array(nNodes).fill(-1);
  let q = 0; const np = [];
  for (let i = 0; i < nNodes; i++) if (used[i]) { remap[i] = q++; np.push(nodePos[i * 2], nodePos[i * 2 + 1]); }
  for (const e of outEdges) { e.a = remap[e.a]; e.b = remap[e.b]; }
  nodePos.length = 0; nodePos.push(...np);
  for (const [cell, id] of [...nodeOfCell]) nodeOfCell.set(cell, remap[id]);
}
const NN = nodePos.length / 2;
const QZ = 100;
let nInterior = 0;
for (const e of outEdges) nInterior += e.geom.length / 2 - 2;
const stats = { nodes: NN, edges: nEdges, interiorPoints: nInterior, perClass: {}, bridges: 0, bridgesKm: 0, totalKm: 0 };
for (const c of ROAD_CLASSES) stats.perClass[c] = { edges: 0, km: 0 };
for (const e of outEdges) {
  const c = ROAD_CLASSES[e.cls];
  stats.perClass[c].edges++; stats.perClass[c].km += e.len; stats.totalKm += e.len;
  if (e.bridge) { stats.bridges++; stats.bridgesKm += e.len; if (e.cls === C_RAIL) stats.railBridges = (stats.railBridges ?? 0) + 1; }
}
for (const c of ROAD_CLASSES) stats.perClass[c].km = Math.round(stats.perClass[c].km);
stats.totalKm = Math.round(stats.totalKm); stats.bridgesKm = Math.round(stats.bridgesKm * 10) / 10;
{
  const header = { version: 2, generated: new Date().toISOString().slice(0, 10), source: 'synthetisch erzeugt (scripts/build-region.mjs, Seed ' + SEED + ')', classes: ROAD_CLASSES, quant: QZ, nodes: NN, edges: nEdges, interior: nInterior, stats };
  const hBytes = Buffer.from(JSON.stringify(header), 'utf8');
  const pad4 = (n) => (n + 3) & ~3;
  const size = 12 + pad4(hBytes.length) + NN * 8 + nEdges * 8 + pad4(nEdges * 3) + (nEdges + 1) * 4 + pad4(nInterior * 4);
  const buf = Buffer.alloc(size);
  let o = 0;
  buf.writeUInt32LE(0x4e525757, 0); buf.writeUInt32LE(1, 4); buf.writeUInt32LE(hBytes.length, 8);
  o = 12; hBytes.copy(buf, o); o += pad4(hBytes.length);
  for (let k = 0; k < nodePos.length; k++) { buf.writeFloatLE(nodePos[k], o); o += 4; }
  for (const e of outEdges) { buf.writeUInt32LE(e.a, o); buf.writeUInt32LE(e.b, o + 4); o += 8; }
  for (const e of outEdges) buf[o++] = e.cls;
  for (const e of outEdges) buf[o++] = e.bridge;
  for (const e of outEdges) buf[o++] = e.country;
  o = pad4(o);
  { let acc = 0; for (const e of outEdges) { buf.writeUInt32LE(acc, o); o += 4; acc += e.geom.length / 2 - 2; } buf.writeUInt32LE(acc, o); o += 4; }
  for (const e of outEdges) {
    let px = Math.round(Math.fround(nodePos[e.a * 2]) * QZ), pz = Math.round(Math.fround(nodePos[e.a * 2 + 1]) * QZ);
    for (let k = 2; k < e.geom.length - 2; k += 2) {
      const qx = Math.round(e.geom[k] * QZ), qz = Math.round(e.geom[k + 1] * QZ);
      buf.writeInt16LE(qx - px, o); buf.writeInt16LE(qz - pz, o + 2); o += 4;
      px = qx; pz = qz;
    }
  }
  writeFileSync(join(OUT, 'roads.bin'), buf);
  log(`roads.bin ${(size / 1024).toFixed(0)} KiB`);
}
// Konnektivität (ohne Schiene)
{
  const par = Array.from({ length: NN }, (_, i) => i);
  const find = (a) => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
  for (const e of outEdges) if (e.cls !== C_RAIL) par[find(e.a)] = find(e.b);
  const roots = new Map();
  for (const e of outEdges) if (e.cls !== C_RAIL) roots.set(find(e.a), (roots.get(find(e.a)) ?? 0) + 1);
  stats.roadComponents = roots.size;
  log(`Straßen-Komponenten: ${roots.size} (Kanten je: ${[...roots.values()].sort((a, b) => b - a).join(',')})`);
}

// ---------------------------------------------------------------- 7) Ausgabe: heights.png, countries.png, meta.json
const h16 = new Uint16Array(N);
for (let k = 0; k < N; k++) h16[k] = Math.max(0, Math.min(65535, Math.round(heights[k] + 12000)));
writeFileSync(join(OUT, 'heights.png'), encode({ width: W, height: H, data: h16, depth: 16, channels: 1 }));
const rgb = new Uint8Array(N * 3);
for (let k = 0; k < N; k++) { rgb[k * 3] = owner[k]; rgb[k * 3 + 1] = sea[k] ? 0 : water[k]; }
writeFileSync(join(OUT, 'countries.png'), encode({ width: W, height: H, data: rgb, depth: 8, channels: 3 }));

const r2 = (v) => +v.toFixed(2);
const sortedCities = cities.map((c, i) => ({ c, i })).sort((a, b) => b.c.pop - a.c.pop || a.i - b.i);
const cityIndex = new Map(sortedCities.map((s, k) => [s.i, k]));
const MAPCOL = [3, 6, 4, 5];
const NAME_EN = { VAL: 'Republic of Valdoria', KRN: 'Federation of Kronland', MAR: 'Kingdom of Marenia', PAN: 'Grand Duchy of Pannonia' };
const countriesMeta = NATIONS.map((n, ni) => {
  let best = -1, bd = 1e18;
  for (let k = 0; k < N; k += 2) if (owner[k] === ni + 1 && mainLand[k] && !wet[k]) { const d = (kmX(k) - cent[ni][0]) ** 2 + (kmZ(k) - cent[ni][1]) ** 2; if (d < bd) { bd = d; best = k; } }
  const pop = cities.filter((c) => c.nat === ni).reduce((s, c) => s + c.pop, 0);
  return { id: ni + 1, a3: n.a3, name: n.name, nameEn: NAME_EN[n.a3] ?? n.name, mapColor: MAPCOL[ni], population: Math.round(pop * 3.4 / 1000) * 1000, gdpMd: Math.round(pop * 3.4 / 1e6 * 24000), label: [r2(kmX(best)), r2(kmZ(best))], labelRank: 1, cells: nationCells[ni + 1] };
});
const cityNodePos = (cell) => [r2(kmX(cell)), r2(kmZ(cell))];
const meta = {
  version: 3,
  generated: new Date().toISOString().slice(0, 10),
  sources: [
    'AWS Terrain Tiles / Terrarium (SRTM, GMTED2010, ETOPO1 u. a.) – registry.opendata.aws/terrain-tiles',
    'Natural Earth (public domain) – naturalearthdata.com (nur Referenz)',
    'Fiktive Länder, Städte und Straßen: synthetisch erzeugt (scripts/build-region.mjs)',
  ],
  projection: { type: 'laea', lat0: CENTER_LAT, lon0: CENTER_LON, radiusKm: R, xMinKm: X_MIN, yMaxKm: Y_MAX },
  grid: { width: W, height: H, cellKm: CELL, chunkCells: CHUNK, heightOffset: 12000 },
  countries: countriesMeta,
  cities: sortedCities.map(({ c }) => ({ name: c.name, country: NATIONS[c.nat].a3, pop: c.pop, capital: c.capital, pos: cityNodePos(c.cell) })),
  scenario: {
    id: SCENARIO_ID,
    name: SCENARIO_NAME,
    seed: SEED,
    nations: NATIONS.map((n, ni) => ({ a3: n.a3, capitalCity: cityIndex.get(capCityIdx[ni]), hq: cityNodePos(startPos[ni].hq), refinery: cityNodePos(startPos[ni].ref), spawn: cityNodePos(startPos[ni].spawn) })),
    oilFields: oilFields.map((f) => ({ id: f.id, name: f.name, country: NATIONS[f.nat].a3, pos: cityNodePos(f.cell), output: f.output })),
  },
};
writeFileSync(join(OUT, 'meta.json'), JSON.stringify(meta));

// ---------------------------------------------------------------- 8) Zusammenfassung
console.log('\n=== ZUSAMMENFASSUNG ===');
console.log(`Raster ${W}x${H}, Zelle ${CELL} km, ${WKM}x${HKM} km, Zentrum ${CENTER_LON}E ${CENTER_LAT}N, Seed ${SEED}`);
console.log('Flächen: ' + NATIONS.map((n, i) => `${n.a3} ${(shares[i] * 100).toFixed(1)}% (Ziel ${(n.areaShare * 100).toFixed(0)}%)`).join(', '));
console.log('Städte:\n' + meta.cities.map((c) => `  ${c.name.padEnd(14)} ${c.country} ${String(c.pop).padStart(7)}${c.capital ? ' Hauptstadt' : ''}${cities.find((q) => q.name === c.name).port ? ' Hafen' : ''}`).join('\n'));
console.log('Ölfelder:\n' + oilFields.map((f) => `  ${f.name.padEnd(20)} ${NATIONS[f.nat].a3} ${String(f.output).padStart(3)} bbl/h${f.contested ? ' umkämpft' : ''}`).join('\n'));
console.log('Ölfelder je Nation: ' + NATIONS.map((n, i) => `${n.a3} ${oilFields.filter((f) => f.nat === i).length}`).join(', '));
console.log(`Dörfer-Knoten: ${hubs.length}`);
console.log(`Netz: ${NN} Knoten, ${nEdges} Kanten, ${stats.totalKm} km, Brücken ${stats.bridges} (${stats.bridgesKm} km)`);
console.log('Klassen: ' + ROAD_CLASSES.map((c) => `${c} ${stats.perClass[c].edges}/${stats.perClass[c].km}km`).join(', '));
console.log('Fertig ->', OUT);
