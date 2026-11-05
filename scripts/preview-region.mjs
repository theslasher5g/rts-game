#!/usr/bin/env node
/**
 * Vorschau der Regionen-Daten als PNG (Höhenschummerung, Länder, Flüsse, Straßen, Brücken, Städte, Ölfelder).
 * Aufruf: node scripts/preview-region.mjs [--data DIR] [--out FILE.png] [--scale 2] [--crop x0,z0,w,h]   (km)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode, encode } from 'fast-png';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const DIR = resolve(argOf('--data', join(ROOT, 'public', 'data')));
const OUTF = resolve(argOf('--out', '/tmp/region-preview.png'));
const SC = +argOf('--scale', 1);
const meta = JSON.parse(readFileSync(join(DIR, 'meta.json'), 'utf8'));
const { width: W, height: H, cellKm: CELL, heightOffset } = meta.grid;
const hImg = decode(readFileSync(join(DIR, 'heights.png')));
const cImg = decode(readFileSync(join(DIR, 'countries.png')));
const ch = cImg.channels;
const heights = new Float32Array(W * H), ids = new Uint8Array(W * H), water = new Uint8Array(W * H);
for (let k = 0; k < W * H; k++) { heights[k] = hImg.data[k] - heightOffset; ids[k] = cImg.data[k * ch]; water[k] = cImg.data[k * ch + 1]; }
const crop = argOf('--crop', `0,0,${W * CELL},${H * CELL}`).split(',').map(Number);
const [cx0, cz0, cw, chh] = crop;
const OW = Math.round((cw / CELL) * SC), OH = Math.round((chh / CELL) * SC);
const rgb = new Uint8Array(OW * OH * 3);
const NATCOL = [[0, 0, 0], [79, 127, 191], [191, 79, 79], [95, 168, 106], [211, 161, 60], [150, 150, 150], [150, 100, 150], [100, 150, 150]];
const toX = (x) => ((x - cx0) / cw) * OW, toY = (z) => ((z - cz0) / chh) * OH;
for (let oy = 0; oy < OH; oy++) for (let ox = 0; ox < OW; ox++) {
  const gx = Math.min(W - 1, Math.max(0, Math.floor((cx0 + (ox / OW) * cw) / CELL))), gy = Math.min(H - 1, Math.max(0, Math.floor((cz0 + (oy / OH) * chh) / CELL)));
  const k = gy * W + gx;
  let c;
  if (!ids[k]) c = [28, 58, 110];
  else {
    const hE = heights[gy * W + Math.min(W - 1, gx + 1)], hS = heights[Math.min(H - 1, gy + 1) * W + gx];
    const sh = 0.9 + Math.max(-0.25, Math.min(0.25, (heights[k] - hE + (heights[k] - hS)) / 140));
    const t = Math.min(1, heights[k] / 1800);
    const n = NATCOL[ids[k]];
    const base = [90 + 100 * t, 120 + 70 * t, 70 + 110 * t];
    c = [0, 1, 2].map((i) => (base[i] * 0.6 + n[i] * 0.4) * sh);
    if (water[k] === 2) c = [40, 110, 255]; else if (water[k] === 1) c = [0, 190, 255];
    // Grenze
    const r = ids[gy * W + Math.min(W - 1, gx + 1)], d = ids[Math.min(H - 1, gy + 1) * W + gx];
    if ((r && r !== ids[k]) || (d && d !== ids[k])) c = [20, 20, 20];
  }
  const q = (oy * OW + ox) * 3; rgb[q] = Math.max(0, Math.min(255, c[0])); rgb[q + 1] = Math.max(0, Math.min(255, c[1])); rgb[q + 2] = Math.max(0, Math.min(255, c[2]));
}
const set = (x, y, c) => { x = Math.round(x); y = Math.round(y); if (x < 0 || y < 0 || x >= OW || y >= OH) return; const q = (y * OW + x) * 3; rgb[q] = c[0]; rgb[q + 1] = c[1]; rgb[q + 2] = c[2]; };
const dot = (x, y, r, c) => { for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) set(toX(x) + dx, toY(y) + dy, c); };
const line = (x0, y0, x1, y1, c) => {
  const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
  for (let i = 0; i <= n; i++) set(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, c);
};
// roads
{
  const b = readFileSync(join(DIR, 'roads.bin'));
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  const dv = new DataView(ab);
  const hLen = dv.getUint32(8, true);
  const hd = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, 12, hLen)));
  const pad4 = (n) => (n + 3) & ~3;
  let o = 12 + pad4(hLen);
  const nn = hd.nodes, ne = hd.edges;
  const nodeXZ = new Float32Array(ab, o, nn * 2); o += nn * 8;
  const abn = new Uint32Array(ab, o, ne * 2); o += ne * 8;
  const cls = new Uint8Array(ab, o, ne), flags = new Uint8Array(ab, o + ne, ne);
  o += pad4(ne * 3);
  const gs = new Uint32Array(ab, o, ne + 1); o += (ne + 1) * 4;
  const dl = new Int16Array(ab, o, hd.interior * 2);
  const COL = [[255, 210, 0], [255, 255, 255], [235, 235, 150], [215, 190, 160], [150, 120, 90], [200, 60, 200], [0, 0, 0]];
  const order = [5, 4, 3, 2, 1, 0];
  for (const want of order) for (let e = 0; e < ne; e++) {
    if (cls[e] !== want) continue;
    let x = nodeXZ[abn[e * 2] * 2], z = nodeXZ[abn[e * 2] * 2 + 1];
    let qx = Math.round(x * hd.quant), qz = Math.round(z * hd.quant);
    const pts = [[x, z]];
    for (let k = gs[e]; k < gs[e + 1]; k++) { qx += dl[k * 2]; qz += dl[k * 2 + 1]; pts.push([qx / hd.quant, qz / hd.quant]); }
    pts.push([nodeXZ[abn[e * 2 + 1] * 2], nodeXZ[abn[e * 2 + 1] * 2 + 1]]);
    const c = flags[e] ? [255, 30, 30] : COL[want];
    for (let i = 1; i < pts.length; i++) {
      line(toX(pts[i - 1][0]), toY(pts[i - 1][1]), toX(pts[i][0]), toY(pts[i][1]), c);
      if (flags[e] && SC > 1) line(toX(pts[i - 1][0]) + 1, toY(pts[i - 1][1]), toX(pts[i][0]) + 1, toY(pts[i][1]), c);
    }
  }
}
const rs = Math.max(2, SC * 2);
for (const c of meta.cities) dot(c.pos[0], c.pos[1], c.capital ? rs + 2 : rs, c.capital ? [255, 255, 0] : [255, 255, 255]);
for (const f of meta.scenario?.oilFields ?? []) dot(f.pos[0], f.pos[1], rs, [0, 0, 0]);
for (const n of meta.scenario?.nations ?? []) { dot(n.hq[0], n.hq[1], rs - 1, [255, 0, 255]); dot(n.refinery[0], n.refinery[1], rs - 1, [255, 120, 0]); dot(n.spawn[0], n.spawn[1], rs, [0, 255, 255]); }
writeFileSync(OUTF, encode({ width: OW, height: OH, data: rgb, depth: 8, channels: 3 }));
console.log('->', OUTF, OW, 'x', OH);
