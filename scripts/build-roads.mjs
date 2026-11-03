#!/usr/bin/env node
/**
 * WW3: EUROPE – Straßen-/Schienen-Pipeline (Phase 2)
 *
 * Quelle: Natural Earth 1:10m roads + railroads (public domain). OSM/Overpass ist optional
 * und wird hier nicht benötigt.
 *
 * Schritte:
 *   1. Linien laden, mit DERSELBEN LAEA-Projektion wie build-geodata.mjs (Parameter aus
 *      public/data/meta.json) in Welt-km projizieren, auf den Kartenausschnitt beschneiden.
 *   2. Topologie: Stützpunkte innerhalb SNAP_KM zu gemeinsamen Knoten verschmelzen (Straßen und
 *      Schienen getrennt), lose Enden an nahe Linien (T-Kreuzung) bzw. nahe Knoten anbinden,
 *      Fährenden mit dem Straßennetz verbinden.
 *   3. Grad-2-Ketten zu Kanten mit Polylinie zusammenfassen (Bruch bei Klassenwechsel).
 *   4. Brücken: Kettenabschnitte über Fluss-/See-/Meereszellen (countries.png G/R), bei denen die
 *      Landzellen davor/danach lokal NICHT über Land verbunden sind → eigene kurze Kante, bridge=1.
 *   5. Douglas-Peucker (SIMPLIFY_KM), Mini-Fragmente (< MIN_COMPONENT_KM) verwerfen.
 *   6. Ausgabe public/data/roads.bin (siehe Format unten).
 *
 * Format roads.bin (little endian):
 *   u32 magic 0x4e525757 ('WWRN'), u32 version, u32 headerBytes, header-JSON (UTF-8, auf 4 B gepolstert)
 *   f32[2*nodes]      Knoten x,z (km)
 *   u32[2*edges]      a,b
 *   u8[edges] cls (Index in classes), u8[edges] flags (1 = Brücke), u8[edges] countryId (countries.png R)
 *   (auf 4 B gepolstert)
 *   u32[edges+1]      Start-Index der inneren Stützpunkte je Kante
 *   i16[2*interior]   innere Stützpunkte als Deltas in 10-m-Einheiten (von quantisiertem Knoten a aus)
 *
 * Aufruf: npm run roads
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode } from 'fast-png';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'scripts', '.cache');
const OUT = join(ROOT, 'public', 'data');
mkdirSync(CACHE, { recursive: true });
const NE_BASE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson';

const CLASSES = ['motorway', 'primary', 'secondary', 'road', 'track', 'rail', 'ferry'];
const C_ROAD = 3, C_TRACK = 4, C_RAIL = 5, C_FERRY = 6;
const SNAP_KM = 0.3;
const TJUNCTION_KM = 0.6;
const GAP_NODE_KM = 1.0;
const FERRY_LINK_KM = 6;
const SIMPLIFY_KM = 0.2;
const MIN_COMPONENT_KM = 10;
const SAMPLE_KM = 0.25;
const Q = 100; // Quantisierung: 10 m

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

// ---------------------------------------------------------------- Meta + Raster
const meta = JSON.parse(readFileSync(join(OUT, 'meta.json'), 'utf8'));
const { lat0, lon0, radiusKm: R, xMinKm, yMaxKm } = meta.projection;
const { width: W, height: H, cellKm: CELL } = meta.grid;
const WKM = W * CELL, HKM = H * CELL;
const D2R = Math.PI / 180;
const sinP0 = Math.sin(lat0 * D2R), cosP0 = Math.cos(lat0 * D2R);
function project(lon, lat) {
  const p = lat * D2R, l = (lon - lon0) * D2R;
  const cosc = sinP0 * Math.sin(p) + cosP0 * Math.cos(p) * Math.cos(l);
  const k = Math.sqrt(2 / Math.max(1e-9, 1 + cosc));
  const px = R * k * Math.cos(p) * Math.sin(l);
  const py = R * k * (cosP0 * Math.sin(p) - sinP0 * Math.cos(p) * Math.cos(l));
  return [px - xMinKm, yMaxKm - py];
}

const cimg = decode(readFileSync(join(OUT, 'countries.png')));
const ids = new Uint8Array(W * H), water = new Uint8Array(W * H);
for (let k = 0, ch = cimg.channels; k < W * H; k++) { ids[k] = cimg.data[k * ch]; water[k] = cimg.data[k * ch + 1]; }
const cellOf = (x, z) => {
  const i = Math.min(W - 1, Math.max(0, Math.floor(x / CELL))), j = Math.min(H - 1, Math.max(0, Math.floor(z / CELL)));
  return j * W + i;
};
const isWet = (k) => ids[k] === 0 || water[k] !== 0;

// ---------------------------------------------------------------- Laden
function loadNE(name) {
  const file = join(CACHE, `${name}.geojson`);
  if (!existsSync(file)) {
    log('Lade', name);
    execFileSync('curl', ['-sSfL', '--retry', '4', '-o', file, `${NE_BASE}/${name}.geojson`], { stdio: 'inherit' });
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}
function linesOf(geom) {
  if (!geom) return [];
  if (geom.type === 'LineString') return [geom.coordinates];
  if (geom.type === 'MultiLineString') return geom.coordinates;
  return [];
}
function roadClass(p) {
  const t = p.type || '';
  if (t.startsWith('Ferry')) return C_FERRY;
  if (p.expressway === 1 && (t === 'Major Highway' || t === 'Secondary Highway')) return 0;
  if (t === 'Major Highway' || (t === 'Road' && p.expressway === 1)) return 1;
  if (t === 'Secondary Highway') return 2;
  if (t === 'Track') return C_TRACK;
  return C_ROAD;
}

/** Linien: { net (0 Straße/Fähre, 1 Schiene), cls, xs: number[] (x,z abwechselnd) } */
const lines = [];
function addFeature(net, cls, geom) {
  for (const line of linesOf(geom)) {
    let run = [];
    const flush = () => { if (run.length >= 4) lines.push({ net, cls, xz: run }); run = []; };
    for (const [lon, lat] of line) {
      if (lon < -45 || lon > 90 || lat < 20) { flush(); continue; }
      const [x, z] = project(lon, lat);
      if (x < 0 || z < 0 || x >= WKM || z >= HKM) { flush(); continue; }
      run.push(x, z);
    }
    flush();
  }
}
{
  const roads = loadNE('ne_10m_roads');
  for (const f of roads.features) addFeature(0, roadClass(f.properties), f.geometry);
  const rails = loadNE('ne_10m_railroads');
  for (const f of rails.features) addFeature(1, C_RAIL, f.geometry);
}
log(`Linien im Ausschnitt: ${lines.length}`);

// ---------------------------------------------------------------- Knoten-Snapping
const nX = [], nZ = [], nNet = [];
const snapMaps = [new Map(), new Map()];
const sKey = (ci, cj) => ci * 40000 + cj;
function snap(net, x, z) {
  const m = snapMaps[net];
  const ci = Math.floor(x / SNAP_KM), cj = Math.floor(z / SNAP_KM);
  let best = -1, bd = SNAP_KM * SNAP_KM;
  for (let di = -1; di <= 1; di++)
    for (let dj = -1; dj <= 1; dj++) {
      const arr = m.get(sKey(ci + di, cj + dj));
      if (!arr) continue;
      for (const n of arr) {
        const d = (nX[n] - x) ** 2 + (nZ[n] - z) ** 2;
        if (d < bd) { bd = d; best = n; }
      }
    }
  if (best >= 0) return best;
  const id = nX.length;
  nX.push(x); nZ.push(z); nNet.push(net);
  const k = sKey(ci, cj);
  let arr = m.get(k);
  if (!arr) m.set(k, (arr = []));
  arr.push(id);
  return id;
}

// Links (kurze Segmente zwischen Knoten)
let lA = [], lB = [], lC = [];
const linkMap = new Map();
function addLink(a, b, cls) {
  if (a === b) return;
  const key = a < b ? a * 2097152 + b : b * 2097152 + a;
  const ex = linkMap.get(key);
  if (ex !== undefined) {
    if (cls < lC[ex]) lC[ex] = cls;
    return;
  }
  linkMap.set(key, lA.length);
  lA.push(a); lB.push(b); lC.push(cls);
}
for (const ln of lines) {
  let prev = -1;
  for (let k = 0; k < ln.xz.length; k += 2) {
    const n = snap(ln.net, ln.xz[k], ln.xz[k + 1]);
    if (prev >= 0 && n !== prev) addLink(prev, n, ln.cls);
    prev = n;
  }
}
log(`Rohknoten ${nX.length}, Links ${lA.length}`);

function buildAdj(alive) {
  const N = nX.length, L = lA.length;
  const deg = new Int32Array(N + 1);
  for (let l = 0; l < L; l++) if (!alive || alive[l]) { deg[lA[l]]++; deg[lB[l]]++; }
  const start = new Int32Array(N + 1);
  for (let n = 0; n < N; n++) start[n + 1] = start[n] + deg[n];
  const fill = start.slice(0, N);
  const adj = new Int32Array(start[N]);
  for (let l = 0; l < L; l++) if (!alive || alive[l]) { adj[fill[lA[l]]++] = l; adj[fill[lB[l]]++] = l; }
  return { start, adj, deg: (n) => start[n + 1] - start[n] };
}

// ---------------------------------------------------------------- Lose Enden verbinden
{
  const adj = buildAdj(null);
  // Segment-Hash (1-km-Zellen)
  const HC = 1;
  const segHash = new Map();
  const hk = (i, j) => i * 10000 + j;
  for (let l = 0; l < lA.length; l++) {
    const a = lA[l], b = lB[l];
    const i0 = Math.floor(Math.min(nX[a], nX[b]) / HC), i1 = Math.floor(Math.max(nX[a], nX[b]) / HC);
    const j0 = Math.floor(Math.min(nZ[a], nZ[b]) / HC), j1 = Math.floor(Math.max(nZ[a], nZ[b]) / HC);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > 4000) continue;
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++) {
        const k = hk(i, j);
        let arr = segHash.get(k);
        if (!arr) segHash.set(k, (arr = []));
        arr.push(l);
      }
  }
  const nodeHash = new Map();
  for (let n = 0; n < nX.length; n++) {
    if (adj.deg(n) === 0) continue;
    const k = hk(Math.floor(nX[n] / HC), Math.floor(nZ[n] / HC));
    let arr = nodeHash.get(k);
    if (!arr) nodeHash.set(k, (arr = []));
    arr.push(n);
  }
  const splits = new Map(); // link -> [{t, n}]
  const extra = [];
  let tj = 0, gaps = 0, ferryLinks = 0;
  const N0 = nX.length;
  for (let n = 0; n < N0; n++) {
    if (adj.deg(n) !== 1) continue;
    const myLink = adj.adj[adj.start[n]];
    const other = lA[myLink] === n ? lB[myLink] : lA[myLink];
    const isFerry = lC[myLink] === C_FERRY;
    const x = nX[n], z = nZ[n];
    // 1) T-Kreuzung: nächstes fremdes Segment
    let bestL = -1, bestD = TJUNCTION_KM, bestT = 0;
    const ci = Math.floor(x / HC), cj = Math.floor(z / HC);
    const seen = new Set();
    for (let di = -1; di <= 1; di++)
      for (let dj = -1; dj <= 1; dj++) {
        const arr = segHash.get(hk(ci + di, cj + dj));
        if (!arr) continue;
        for (const l of arr) {
          if (seen.has(l)) continue;
          seen.add(l);
          const a = lA[l], b = lB[l];
          if (a === n || b === n || a === other || b === other) continue;
          if (nNet[a] !== nNet[n]) continue;
          if (isFerry !== (lC[l] === C_FERRY)) continue;
          const dx = nX[b] - nX[a], dz = nZ[b] - nZ[a];
          const L2 = dx * dx + dz * dz;
          let t = L2 > 0 ? ((x - nX[a]) * dx + (z - nZ[a]) * dz) / L2 : 0;
          t = Math.max(0, Math.min(1, t));
          const d = Math.hypot(nX[a] + dx * t - x, nZ[a] + dz * t - z);
          if (d < bestD) { bestD = d; bestL = l; bestT = t; }
        }
      }
    if (bestL >= 0 && bestT > 0.001 && bestT < 0.999) {
      let arr = splits.get(bestL);
      if (!arr) splits.set(bestL, (arr = []));
      arr.push({ t: bestT, n });
      tj++;
      continue;
    }
    // 2) Lücke zu nahem Knoten (für Fähren: Straßenknoten bis FERRY_LINK_KM)
    const maxD = isFerry ? FERRY_LINK_KM : GAP_NODE_KM;
    const r = Math.ceil(maxD / HC);
    let bestN = -1, bd = maxD;
    for (let di = -r; di <= r; di++)
      for (let dj = -r; dj <= r; dj++) {
        const arr = nodeHash.get(hk(ci + di, cj + dj));
        if (!arr) continue;
        for (const m of arr) {
          if (m === n || m === other || nNet[m] !== nNet[n]) continue;
          if (isFerry) {
            // nur Knoten mit Nicht-Fähr-Link
            let ok = false;
            for (let q = adj.start[m]; q < adj.start[m + 1]; q++) if (lC[adj.adj[q]] !== C_FERRY) ok = true;
            if (!ok) continue;
          }
          const d = Math.hypot(nX[m] - x, nZ[m] - z);
          if (d < bd) { bd = d; bestN = m; }
        }
      }
    if (bestN >= 0) {
      extra.push([n, bestN, isFerry ? C_ROAD : lC[myLink]]);
      if (isFerry) ferryLinks++; else gaps++;
    }
  }
  const alive = new Uint8Array(lA.length).fill(1);
  for (const [l, arr] of splits) {
    arr.sort((p, q) => p.t - q.t);
    alive[l] = 0;
    let prev = lA[l];
    for (const { n } of arr) { if (n !== prev) { lA.push(prev); lB.push(n); lC.push(lC[l]); } prev = n; }
    if (prev !== lB[l]) { lA.push(prev); lB.push(lB[l]); lC.push(lC[l]); }
  }
  for (const [a, b, c] of extra) { lA.push(a); lB.push(b); lC.push(c); }
  // kompaktieren
  const nA = [], nB = [], nC = [];
  for (let l = 0; l < lA.length; l++) if (l >= alive.length || alive[l]) { nA.push(lA[l]); nB.push(lB[l]); nC.push(lC[l]); }
  lA = nA; lB = nB; lC = nC;
  log(`T-Kreuzungen ${tj}, Lücken geschlossen ${gaps}, Fähranbindungen ${ferryLinks}`);
}

// ---------------------------------------------------------------- Ketten
const chains = []; // { nodes: number[], cls }
{
  const adj = buildAdj(null);
  const used = new Uint8Array(lA.length);
  const isJunction = (n) => {
    const s = adj.start[n], e = adj.start[n + 1];
    if (e - s !== 2) return true;
    return lC[adj.adj[s]] !== lC[adj.adj[s + 1]];
  };
  const walk = (n0, l0) => {
    const nodes = [n0];
    let n = n0, l = l0;
    const cls = lC[l0];
    for (;;) {
      used[l] = 1;
      const m = lA[l] === n ? lB[l] : lA[l];
      nodes.push(m);
      if (m === n0 || isJunction(m)) break;
      const s = adj.start[m];
      const nl = adj.adj[s] === l ? adj.adj[s + 1] : adj.adj[s];
      if (used[nl]) break;
      n = m; l = nl;
    }
    chains.push({ nodes, cls });
  };
  for (let n = 0; n < nX.length; n++) {
    if (!isJunction(n)) continue;
    for (let q = adj.start[n]; q < adj.start[n + 1]; q++) if (!used[adj.adj[q]]) walk(n, adj.adj[q]);
  }
  for (let l = 0; l < lA.length; l++) if (!used[l]) walk(lA[l], l); // reine Ringe
  log(`Ketten ${chains.length}`);
}

// ---------------------------------------------------------------- Brücken-Erkennung
const visitStamp = new Uint32Array(W * H);
let visitGen = 0;
const bfsQueue = new Int32Array(W * H > 1 << 20 ? 1 << 20 : W * H);
/** true, wenn Landzellen ka und kb lokal (Fenster) über trockenes Land 4-verbunden sind */
function landConnected(ka, kb, radius) {
  if (ka === kb) return true;
  const ia = ka % W, ja = (ka / W) | 0, ib = kb % W, jb = (kb / W) | 0;
  const ci = (ia + ib) >> 1, cj = (ja + jb) >> 1;
  const i0 = Math.max(0, ci - radius), i1 = Math.min(W - 1, ci + radius);
  const j0 = Math.max(0, cj - radius), j1 = Math.min(H - 1, cj + radius);
  visitGen++;
  let qh = 0, qt = 0;
  bfsQueue[qt++] = ka;
  visitStamp[ka] = visitGen;
  while (qh < qt) {
    const k = bfsQueue[qh++];
    if (k === kb) return true;
    const i = k % W, j = (k / W) | 0;
    const nb = [i > i0 ? k - 1 : -1, i < i1 ? k + 1 : -1, j > j0 ? k - W : -1, j < j1 ? k + W : -1];
    for (const m of nb) {
      if (m < 0 || visitStamp[m] === visitGen || isWet(m)) continue;
      visitStamp[m] = visitGen;
      if (qt < bfsQueue.length) bfsQueue[qt++] = m;
    }
  }
  return false;
}

function polyFromNodes(nodes) {
  const xz = new Float64Array(nodes.length * 2);
  for (let k = 0; k < nodes.length; k++) { xz[k * 2] = nX[nodes[k]]; xz[k * 2 + 1] = nZ[nodes[k]]; }
  return xz;
}
function cumLen(xz) {
  const n = xz.length / 2, c = new Float64Array(n);
  for (let k = 1; k < n; k++) c[k] = c[k - 1] + Math.hypot(xz[k * 2] - xz[k * 2 - 2], xz[k * 2 + 1] - xz[k * 2 - 1]);
  return c;
}
function pointAt(xz, cl, s) {
  const n = cl.length;
  if (s <= 0) return [xz[0], xz[1], 0];
  if (s >= cl[n - 1]) return [xz[n * 2 - 2], xz[n * 2 - 1], n - 2];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cl[m] <= s) lo = m; else hi = m; }
  const t = (s - cl[lo]) / Math.max(1e-12, cl[lo + 1] - cl[lo]);
  return [xz[lo * 2] + (xz[lo * 2 + 2] - xz[lo * 2]) * t, xz[lo * 2 + 1] + (xz[lo * 2 + 3] - xz[lo * 2 + 1]) * t, lo];
}
/** Erste Landzelle entlang Richtung (dx,dz) ab (x,z), max. maxKm */
function landAlong(x, z, dx, dz, maxKm) {
  const L = Math.hypot(dx, dz);
  if (L < 1e-9) return -1;
  dx /= L; dz /= L;
  for (let s = SAMPLE_KM; s <= maxKm; s += SAMPLE_KM) {
    const px = x + dx * s, pz = z + dz * s;
    if (px < 0 || pz < 0 || px >= WKM || pz >= HKM) return -1;
    const k = cellOf(px, pz);
    if (!isWet(k)) return k;
  }
  return -1;
}

/** Brücken-Intervalle [s0,s1] (km entlang Kette) */
function findBridges(xz, cl) {
  const L = cl[cl.length - 1];
  const ns = Math.max(2, Math.ceil(L / SAMPLE_KM) + 1);
  const step = L / (ns - 1);
  const wet = new Uint8Array(ns), cells = new Int32Array(ns);
  for (let s = 0; s < ns; s++) {
    const [x, z] = pointAt(xz, cl, s * step);
    cells[s] = cellOf(x, z);
    wet[s] = isWet(cells[s]) ? 1 : 0;
  }
  const runs = [];
  for (let s = 0; s < ns; s++) {
    if (!wet[s]) continue;
    let e = s;
    while (e + 1 < ns && wet[e + 1]) e++;
    const last = runs[runs.length - 1];
    if (last && (s - last[1]) * step < 0.6) last[1] = e;
    else runs.push([s, e]);
    s = e;
  }
  const out = [];
  for (const [s, e] of runs) {
    let kb, ka;
    if (s > 0) kb = cells[s - 1];
    else {
      const n = xz.length / 2;
      const [px, pz] = pointAt(xz, cl, Math.min(L, 1));
      kb = landAlong(xz[0], xz[1], xz[0] - px, xz[1] - pz, 8);
      void n;
    }
    if (e < ns - 1) ka = cells[e + 1];
    else {
      const n = xz.length / 2;
      const [px, pz] = pointAt(xz, cl, Math.max(0, L - 1));
      ka = landAlong(xz[n * 2 - 2], xz[n * 2 - 1], xz[n * 2 - 2] - px, xz[n * 2 - 1] - pz, 8);
    }
    if (kb < 0 || ka < 0) continue;
    const lenCells = ((e - s + 1) * step) / CELL;
    const radius = Math.max(10, Math.ceil(lenCells / 2) + 8);
    if (landConnected(kb, ka, radius)) continue;
    let s0 = Math.max(0, s * step - step * 0.5), s1 = Math.min(L, e * step + step * 0.5);
    if (s1 - s0 < 0.3) { const m = (s0 + s1) / 2; s0 = Math.max(0, m - 0.15); s1 = Math.min(L, m + 0.15); }
    // Endstücke < 0.15 km nicht als eigene Kante übrig lassen
    if (s0 < 0.15) s0 = 0;
    if (L - s1 < 0.15) s1 = L;
    out.push([s0, s1]);
  }
  return out;
}

// ---------------------------------------------------------------- Vereinfachung
function simplify(xz, tol) {
  const n = xz.length / 2;
  if (n <= 2) return xz;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  const t2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = xz[a * 2], az = xz[a * 2 + 1], dx = xz[b * 2] - ax, dz = xz[b * 2 + 1] - az;
    const L2 = dx * dx + dz * dz;
    let md = -1, mi = -1;
    for (let k = a + 1; k < b; k++) {
      const px = xz[k * 2] - ax, pz = xz[k * 2 + 1] - az;
      let d;
      if (L2 < 1e-12) d = px * px + pz * pz;
      else {
        const t = Math.max(0, Math.min(1, (px * dx + pz * dz) / L2));
        d = (px - dx * t) ** 2 + (pz - dz * t) ** 2;
      }
      if (d > md) { md = d; mi = k; }
    }
    if (md > t2) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  const out = [];
  for (let k = 0; k < n; k++) if (keep[k]) out.push(xz[k * 2], xz[k * 2 + 1]);
  // Segmente > 300 km unterteilen (i16-Deltas)
  const res = [out[0], out[1]];
  for (let k = 2; k < out.length; k += 2) {
    const px = res[res.length - 2], pz = res[res.length - 1];
    const d = Math.hypot(out[k] - px, out[k + 1] - pz);
    const parts = Math.ceil(d / 300);
    for (let p = 1; p < parts; p++) res.push(px + ((out[k] - px) * p) / parts, pz + ((out[k + 1] - pz) * p) / parts);
    res.push(out[k], out[k + 1]);
  }
  return res;
}

// ---------------------------------------------------------------- Kanten bauen
const edges = []; // { a, b, cls, bridge, country, geom:number[] }
{
  let bridgeCount = 0;
  const extraNode = (x, z) => { const id = nX.length; nX.push(x); nZ.push(z); nNet.push(-1); return id; };
  for (const ch of chains) {
    const xz = polyFromNodes(ch.nodes);
    const cl = cumLen(xz);
    const L = cl[cl.length - 1];
    if (L <= 1e-6) continue;
    const brs = ch.cls === C_FERRY ? [] : findBridges(xz, cl);
    // Schnitte
    const cuts = [{ s: 0, node: ch.nodes[0] }];
    const flags = [];
    for (const [s0, s1] of brs) {
      const lastS = cuts[cuts.length - 1].s;
      if (s0 > lastS + 1e-6) {
        const [x, z] = pointAt(xz, cl, s0);
        flags.push(0);
        cuts.push({ s: s0, node: s1 >= L - 1e-9 && s0 <= 1e-9 ? -1 : extraNode(x, z) });
      }
      if (s1 < L - 1e-6) {
        const [x, z] = pointAt(xz, cl, s1);
        flags.push(1);
        cuts.push({ s: s1, node: extraNode(x, z) });
      } else {
        flags.push(1);
        cuts.push({ s: L, node: ch.nodes[ch.nodes.length - 1] });
      }
      bridgeCount++;
    }
    if (cuts[cuts.length - 1].s < L - 1e-9) { flags.push(0); cuts.push({ s: L, node: ch.nodes[ch.nodes.length - 1] }); }
    for (let p = 0; p + 1 < cuts.length; p++) {
      const sa = cuts[p].s, sb = cuts[p + 1].s;
      if (sb - sa < 1e-6) continue;
      // Teil-Polylinie
      const pts = [];
      const [ax, az] = pointAt(xz, cl, sa);
      pts.push(ax, az);
      for (let k = 0; k < cl.length; k++) if (cl[k] > sa + 1e-9 && cl[k] < sb - 1e-9) pts.push(xz[k * 2], xz[k * 2 + 1]);
      const [bx, bz] = pointAt(xz, cl, sb);
      pts.push(bx, bz);
      const geom = simplify(pts, SIMPLIFY_KM);
      // Land: häufigste Länder-ID entlang
      const cnt = new Map();
      for (let k = 0; k < geom.length; k += 2) {
        const id = ids[cellOf(geom[k], geom[k + 1])];
        if (id) cnt.set(id, (cnt.get(id) || 0) + 1);
      }
      let country = 0, bc = 0;
      for (const [id, c] of cnt) if (c > bc) { bc = c; country = id; }
      if (!country) {
        const [mx, mz] = pointAt(xz, cl, (sa + sb) / 2);
        country = ids[cellOf(mx, mz)];
      }
      edges.push({ a: cuts[p].node, b: cuts[p + 1].node, cls: ch.cls, bridge: flags[p] ? 1 : 0, country, geom, len: sb - sa });
    }
  }
  log(`Kanten ${edges.length}, Brücken ${bridgeCount}`);
}

// ---------------------------------------------------------------- Fragmente verwerfen
let finalEdges;
{
  const parent = new Int32Array(nX.length).map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (const e of edges) { const ra = find(e.a), rb = find(e.b); if (ra !== rb) parent[ra] = rb; }
  const tot = new Map();
  for (const e of edges) { const r = find(e.a); tot.set(r, (tot.get(r) || 0) + e.len); }
  finalEdges = edges.filter((e) => tot.get(find(e.a)) >= MIN_COMPONENT_KM);
  let comps = 0;
  for (const v of tot.values()) if (v >= MIN_COMPONENT_KM) comps++;
  log(`Fragmente verworfen: ${edges.length - finalEdges.length} Kanten; Komponenten übrig: ${comps}`);
}

// ---------------------------------------------------------------- Knoten kompaktieren + Ausgabe
const remap = new Int32Array(nX.length).fill(-1);
const outNodes = [];
for (const e of finalEdges) {
  for (const k of ['a', 'b']) {
    const n = e[k];
    if (remap[n] < 0) { remap[n] = outNodes.length / 2; outNodes.push(nX[n], nZ[n]); }
    e[k] = remap[n];
  }
}
const nNodes = outNodes.length / 2, nEdges = finalEdges.length;
let nInterior = 0;
for (const e of finalEdges) nInterior += e.geom.length / 2 - 2;

const stats = { nodes: nNodes, edges: nEdges, interiorPoints: nInterior, perClass: {}, bridges: 0, bridgesKm: 0, totalKm: 0 };
for (const c of CLASSES) stats.perClass[c] = { edges: 0, km: 0 };
for (const e of finalEdges) {
  const c = CLASSES[e.cls];
  stats.perClass[c].edges++;
  stats.perClass[c].km += e.len;
  stats.totalKm += e.len;
  if (e.bridge) { stats.bridges++; stats.bridgesKm += e.len; }
}
for (const c of CLASSES) stats.perClass[c].km = Math.round(stats.perClass[c].km);
stats.totalKm = Math.round(stats.totalKm);
stats.bridgesKm = Math.round(stats.bridgesKm * 10) / 10;

const header = {
  version: 1,
  generated: new Date().toISOString().slice(0, 10),
  source: 'Natural Earth 1:10m roads + railroads (public domain)',
  classes: CLASSES,
  quant: Q,
  nodes: nNodes,
  edges: nEdges,
  interior: nInterior,
  stats,
};
const hBytes = Buffer.from(JSON.stringify(header), 'utf8');
const pad4 = (n) => (n + 3) & ~3;
const size =
  12 + pad4(hBytes.length) + nNodes * 8 + nEdges * 8 + pad4(nEdges * 3) + (nEdges + 1) * 4 + pad4(nInterior * 4);
const buf = Buffer.alloc(size);
let o = 0;
buf.writeUInt32LE(0x4e525757, 0); buf.writeUInt32LE(1, 4); buf.writeUInt32LE(hBytes.length, 8);
o = 12;
hBytes.copy(buf, o); o += pad4(hBytes.length);
for (let k = 0; k < outNodes.length; k++) { buf.writeFloatLE(outNodes[k], o); o += 4; }
for (const e of finalEdges) { buf.writeUInt32LE(e.a, o); buf.writeUInt32LE(e.b, o + 4); o += 8; }
for (const e of finalEdges) buf[o++] = e.cls;
for (const e of finalEdges) buf[o++] = e.bridge;
for (const e of finalEdges) buf[o++] = e.country;
o = pad4(o);
{
  let acc = 0;
  for (const e of finalEdges) { buf.writeUInt32LE(acc, o); o += 4; acc += e.geom.length / 2 - 2; }
  buf.writeUInt32LE(acc, o); o += 4;
}
let maxDelta = 0;
for (const e of finalEdges) {
  // Startpunkt = Knoten a (Float32-gerundet wie beim Laden)
  let px = Math.round(Math.fround(outNodes[e.a * 2]) * Q), pz = Math.round(Math.fround(outNodes[e.a * 2 + 1]) * Q);
  for (let k = 2; k < e.geom.length - 2; k += 2) {
    const qx = Math.round(e.geom[k] * Q), qz = Math.round(e.geom[k + 1] * Q);
    const dx = qx - px, dz = qz - pz;
    maxDelta = Math.max(maxDelta, Math.abs(dx), Math.abs(dz));
    if (Math.abs(dx) > 32767 || Math.abs(dz) > 32767) throw new Error('Delta zu groß');
    buf.writeInt16LE(dx, o); buf.writeInt16LE(dz, o + 2); o += 4;
    px = qx; pz = qz;
  }
}
writeFileSync(join(OUT, 'roads.bin'), buf);
log('Statistik:', JSON.stringify(stats, null, 1));
log(`roads.bin: ${(size / 1024).toFixed(0)} KiB (max Delta ${maxDelta})`);
