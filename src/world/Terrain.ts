import * as THREE from 'three';
import type { GeoData } from './GeoData';
import type { Settings } from '../core/types';

/**
 * GPU-verschobenes, gechunktes LOD-Gelände (Defilade/PS2-Look).
 *
 * - Höhen: eine R16F-DataTexture (LinearFilter) – Vertex-Shader sampelt Höhe + 4 Nachbarn
 *   (Normale) und berechnet Gouraud-Licht (fixe Sonne + hemisphärisches Ambient).
 * - Länder-IDs + Wasser-Flags: RG8-DataTexture (NearestFilter, texelFetch).
 * - Eine geteilte Gittergeometrie pro LOD-Stufe (Schrittweite 1..32 Zellen über 64-Zellen-Chunk)
 *   inkl. Skirt-Ring gegen LOD-Risse; pro Stufe ein instanziertes Mesh mit Chunk-Ursprung
 *   je Instanz. LOD-Wahl + Frustum-Culling pro Frame auf der CPU (ohne Allokationen).
 */

/** Richtung ZUR Sonne (normiert), Welt-Koordinaten (X Ost, Y hoch, Z Süd). Licht aus Nordwest. */
export const SUN_DIR = new THREE.Vector3(-0.52, 0.72, -0.46).normalize();
/** Sonnenfarbe (linear) */
export const SUN_COLOR = new THREE.Color(1.0, 0.93, 0.82);

const LOD_STEPS = [1, 2, 4, 8, 16, 32];
/** Referenz-Bildhöhe (interne Pixel) für die LOD-Fehlerabschätzung */
const LOD_REF_HEIGHT = 700;
/** Gewünschte Pixel pro Gitterkante */
const LOD_PX_PER_VERTEX = 2;

// ------------------------------------------------------------------ geteilte Texturen

const heightTexCache = new WeakMap<GeoData, THREE.DataTexture>();
const idTexCache = new WeakMap<GeoData, THREE.DataTexture>();
let noiseNearest: THREE.DataTexture | null = null;
let noiseLinear: THREE.DataTexture | null = null;

/** Höhentextur (R16F, Werte = Höhe in km, LinearFilter). Pro GeoData gecacht und geteilt (Terrain + Water). */
export function getHeightTexture(geo: GeoData): THREE.DataTexture {
  let tex = heightTexCache.get(geo);
  if (tex) return tex;
  const n = geo.width * geo.height;
  const data = new Uint16Array(n);
  const src = geo.heightsKm;
  const toHalf = THREE.DataUtils.toHalfFloat;
  for (let k = 0; k < n; k++) data[k] = toHalf(src[k]);
  tex = new THREE.DataTexture(data, geo.width, geo.height, THREE.RedFormat, THREE.HalfFloatType);
  tex.internalFormat = 'R16F';
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  heightTexCache.set(geo, tex);
  return tex;
}

/** Länder-ID (R) + Wasser-Flags (G) als RG8, NearestFilter. Pro GeoData gecacht. */
export function getCountryTexture(geo: GeoData): THREE.DataTexture {
  let tex = idTexCache.get(geo);
  if (tex) return tex;
  const n = geo.width * geo.height;
  const data = new Uint8Array(n * 2);
  const ids = geo.countryIds, wf = geo.waterFlags;
  for (let k = 0; k < n; k++) {
    data[k * 2] = ids[k];
    data[k * 2 + 1] = wf[k];
  }
  tex = new THREE.DataTexture(data, geo.width, geo.height, THREE.RGFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  idTexCache.set(geo, tex);
  return tex;
}

let noiseDataCache: Uint8Array | null = null;
const NOISE_S = 64;
/** 64x64-Rauschdaten (deterministisch; gemeinsam für GPU-Textur und CPU-Abfragen wie forestMask). */
function getNoiseData(): Uint8Array {
  if (noiseDataCache) return noiseDataCache;
  const S = NOISE_S;
  let seed = 1337;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const white = new Float32Array(S * S);
  for (let k = 0; k < S * S; k++) white[k] = rnd();
  // Zwei Oktaven: geglättetes Grundrauschen + feines weißes Rauschen
  const data = new Uint8Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) sum += white[((y + dy + S) % S) * S + ((x + dx + S) % S)];
      const v = (sum / 9 - 0.5) * 2.2 + 0.5; // Kontrast wieder anheben
      const m = v * 0.65 + white[y * S + x] * 0.35;
      data[y * S + x] = Math.max(0, Math.min(255, Math.round(m * 255)));
    }
  }
  noiseDataCache = data;
  return data;
}

/** 64x64-Rauschtextur (R8, wiederholend) – nearest- und linear-gefilterte Variante mit denselben Daten. */
export function getNoiseTextures(): { nearest: THREE.DataTexture; linear: THREE.DataTexture } {
  if (!noiseNearest || !noiseLinear) {
    const S = NOISE_S;
    const data = getNoiseData();
    const make = (filter: THREE.MagnificationTextureFilter) => {
      const t = new THREE.DataTexture(data, S, S, THREE.RedFormat, THREE.UnsignedByteType);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.magFilter = filter;
      t.minFilter = filter;
      t.generateMipmaps = false;
      t.unpackAlignment = 1;
      t.colorSpace = THREE.NoColorSpace;
      t.needsUpdate = true;
      return t;
    };
    noiseNearest = make(THREE.NearestFilter);
    noiseLinear = make(THREE.LinearFilter);
  }
  return { nearest: noiseNearest, linear: noiseLinear };
}

/** Bilineares Rauschen wie texture2D(uNoiseL, uv/64) im Shader (u,v = Weltkoordinate / Skalierung). */
function noiseLinearAt(u: number, v: number): number {
  const d = getNoiseData(), S = NOISE_S;
  const x = u - 0.5, y = v - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const ix0 = ((x0 % S) + S) % S, ix1 = (ix0 + 1) % S;
  const iy0 = ((y0 % S) + S) % S, iy1 = (iy0 + 1) % S;
  const a = d[iy0 * S + ix0], b = d[iy0 * S + ix1], c = d[iy1 * S + ix0], e = d[iy1 * S + ix1];
  return ((a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + e * fx) * fy) / 255;
}

function smoothstepJs(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Waldanteil 0..1 an einer Weltposition – exakte CPU-Entsprechung der `forest`-Variable im Terrain-Fragment-Shader
 * (Biom-Rauschen nBig/nHuge, Breitengrad, Trockenheit, Höhenband). Die Baumschicht (Vegetation) nutzt dieselbe Funktion,
 * damit Geländeton und Bäume übereinstimmen.
 */
export function forestMask(geo: GeoData, x: number, z: number): number {
  const mapX = geo.width * geo.cellKm, mapZ = geo.height * geo.cellKm;
  const lat = Math.max(0, Math.min(1, z / mapZ));
  const lon = Math.max(0, Math.min(1, x / mapX));
  const nBig = noiseLinearAt(x / 45, z / 45);
  const nHuge = noiseLinearAt(x / 260 + 17, z / 260 + 17);
  const dry = Math.max(0, Math.min(1, smoothstepJs(0.76, 0.9, lat + (nHuge - 0.5) * 0.08) + smoothstepJs(0.58, 0.78, lat) * smoothstepJs(0.72, 0.92, lon) * 0.8));
  let f = smoothstepJs(0.5, 0.66, nHuge * 0.6 + nBig * 0.4 + (0.3 - lat) * 0.5) * (1 - dry);
  const hk = geo.heightAt(x, z);
  f = Math.max(f, smoothstepJs(0.35, 0.8, hk) * (1 - smoothstepJs(1.2, 1.7, hk)) * 0.75 * (1 - dry));
  return f;
}

/** Trockenheit 0..1 (wie `dry` im Shader) */
export function dryMask(geo: GeoData, x: number, z: number): number {
  const mapX = geo.width * geo.cellKm, mapZ = geo.height * geo.cellKm;
  const lat = Math.max(0, Math.min(1, z / mapZ));
  const lon = Math.max(0, Math.min(1, x / mapX));
  const nHuge = noiseLinearAt(x / 260 + 17, z / 260 + 17);
  return Math.max(0, Math.min(1, smoothstepJs(0.76, 0.9, lat + (nHuge - 0.5) * 0.08) + smoothstepJs(0.58, 0.78, lat) * smoothstepJs(0.72, 0.92, lon) * 0.8));
}

/** Gedämpfte Länderfarben (sRGB) für Natural-Earth MAPCOLOR9 1..9 */
const MAP_COLORS = [0x8c7d5c, 0x6e8a5f, 0x9b6b5b, 0x6b7f95, 0x908b66, 0x7e6b8b, 0xa38b69, 0x5f8a84, 0x95775f];
const PLAYER_COLOR = 0x4a88c0;

// ------------------------------------------------------------------ Geometrie

/** Gitter für einen Chunk (chunkCells x chunkCells Zellen) mit Schrittweite step inkl. Skirt-Ring. */
function buildLodGeometry(chunkCells: number, step: number, maxInstances: number): { geo: THREE.InstancedBufferGeometry; chunkAttr: THREE.InstancedBufferAttribute } {
  const n = chunkCells / step; // Quads pro Seite
  const top = (n + 1) * (n + 1);
  const ring = 4 * n;
  const pos = new Float32Array((top + ring) * 3);
  let v = 0;
  for (let j = 0; j <= n; j++)
    for (let i = 0; i <= n; i++) {
      pos[v++] = i * step;
      pos[v++] = 0;
      pos[v++] = j * step;
    }
  // Randring im Uhrzeigersinn (Indizes der oberen Vertices)
  const ringIdx: number[] = [];
  for (let i = 0; i < n; i++) ringIdx.push(i); // Nordkante West->Ost
  for (let j = 0; j < n; j++) ringIdx.push(j * (n + 1) + n); // Ostkante Nord->Süd
  for (let i = n; i > 0; i--) ringIdx.push(n * (n + 1) + i); // Südkante Ost->West
  for (let j = n; j > 0; j--) ringIdx.push(j * (n + 1)); // Westkante Süd->Nord
  for (let r = 0; r < ring; r++) {
    const s = ringIdx[r];
    pos[v++] = pos[s * 3];
    pos[v++] = 1; // Skirt-Flag
    pos[v++] = pos[s * 3 + 2];
  }
  const idxCount = n * n * 6 + ring * 6;
  const vertCount = top + ring;
  const index = vertCount > 65535 ? new Uint32Array(idxCount) : new Uint16Array(idxCount);
  let k = 0;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i, b = a + 1, c = a + (n + 1), d = c + 1;
      // CCW von oben gesehen (Y hoch, Z nach Süden)
      index[k++] = a; index[k++] = c; index[k++] = b;
      index[k++] = b; index[k++] = c; index[k++] = d;
    }
  for (let r = 0; r < ring; r++) {
    const a = ringIdx[r], b = ringIdx[(r + 1) % ring];
    const sa = top + r, sb = top + ((r + 1) % ring);
    index[k++] = a; index[k++] = b; index[k++] = sa;
    index[k++] = b; index[k++] = sb; index[k++] = sa;
  }
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  const chunkAttr = new THREE.InstancedBufferAttribute(new Float32Array(maxInstances * 2), 2);
  chunkAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aChunk', chunkAttr);
  geo.instanceCount = 0;
  // Bounding-Volumen werden nicht genutzt (eigenes Culling), aber gegen Warnungen setzen:
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
  geo.boundingBox = new THREE.Box3(new THREE.Vector3(-1e7, -1e7, -1e7), new THREE.Vector3(1e7, 1e7, 1e7));
  return { geo, chunkAttr };
}

// ------------------------------------------------------------------ Shader

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
#include <fog_pars_vertex>

attribute vec2 aChunk;
uniform sampler2D uHeight;
uniform vec2 uGrid;
uniform float uCellKm;
uniform float uExag;
uniform float uStep;
uniform vec3 uSunDir;
uniform vec3 uSunColor;

varying vec3 vLight;
varying vec3 vWorld;
varying float vHeightKm;
varying float vSlope;

float hAt(vec2 g) { return texture2D(uHeight, g / uGrid).r; }

void main() {
  vec2 g = aChunk + position.xz;            // Zellecken-Koordinaten
  float h = hAt(g);
  float s = uStep;
  float hl = hAt(g - vec2(s, 0.0));
  float hr = hAt(g + vec2(s, 0.0));
  float hu = hAt(g - vec2(0.0, s));
  float hd = hAt(g + vec2(0.0, s));
  vec2 grad = vec2(hr - hl, hd - hu) / (2.0 * s * uCellKm);   // km/km (real)
  vSlope = length(grad);
  vec3 n = normalize(vec3(-grad.x * uExag, 1.0, -grad.y * uExag));

  // Gouraud: Sonne + hemisphärisches Ambient (linear)
  vec3 sky = vec3(0.50, 0.56, 0.66);
  vec3 ground = vec3(0.24, 0.21, 0.17);
  vec3 amb = mix(ground, sky, n.y * 0.5 + 0.5) * 0.62;
  float ndl = max(dot(n, uSunDir), 0.0);
  vLight = amb + uSunColor * ndl * 0.95;

  // Meeresboden minimal absenken -> kein Z-Fighting mit der Wasserfläche bei y = 0
  float y = h < 0.0 ? h * uExag - 0.06 : h * uExag;
  if (position.y > 0.5) {
    bool mapEdge = g.x <= 0.0 || g.y <= 0.0 || g.x >= uGrid.x || g.y >= uGrid.y;
    y = mapEdge ? min(y, 0.0) - 3.0 : y - (0.3 + uExag * 0.06 * s);
  }
  vHeightKm = h;
  vWorld = vec3(g.x * uCellKm, y, g.y * uCellKm);
  vec4 mvPosition = modelViewMatrix * vec4(vWorld, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
#include <fog_pars_fragment>

uniform sampler2D uIds;
uniform sampler2D uPalette;
uniform sampler2D uNoiseN;
uniform sampler2D uNoiseL;
uniform vec2 uGrid;
uniform float uCellKm;
uniform float uOverlay;
uniform float uHover;
uniform float uSelected;
uniform float uPlayer;
uniform float uTime;
uniform float uBorderPx;

varying vec3 vLight;
varying vec3 vWorld;
varying float vHeightKm;
varying float vSlope;

vec3 srgb(vec3 c) { return pow(c, vec3(2.2)); }
float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float lumOf(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

int idAt(vec2 p) {
  ivec2 c = clamp(ivec2(floor(p)), ivec2(0), ivec2(uGrid) - 1);
  return int(texelFetch(uIds, c, 0).r * 255.0 + 0.5);
}

float wfAt(ivec2 c) {
  c = clamp(c, ivec2(0), ivec2(uGrid) - 1);
  return texelFetch(uIds, c, 0).g > 0.002 ? 1.0 : 0.0;
}
float waterCoverage(vec2 p) {
  vec2 q = p - 0.5;
  ivec2 i = ivec2(floor(q));
  vec2 f = fract(q);
  float a = wfAt(i), b = wfAt(i + ivec2(1, 0)), c = wfAt(i + ivec2(0, 1)), d = wfAt(i + ivec2(1, 1));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// Rauschen in Weltraum mit Ausblendung bei Unterabtastung
float noiseN(vec2 uv) {
  vec2 fw = fwidth(uv);
  float fade = 1.0 - smoothstep(0.35, 1.0, max(fw.x, fw.y));
  return mix(0.5, texture2D(uNoiseN, uv / 64.0).r, fade);
}
float noiseL(vec2 uv) {
  vec2 fw = fwidth(uv);
  float fade = 1.0 - smoothstep(0.5, 2.0, max(fw.x, fw.y));
  return mix(0.5, texture2D(uNoiseL, uv / 64.0).r, fade);
}

void main() {
  #include <logdepthbuf_fragment>
  vec2 p = vWorld.xz / uCellKm;
  ivec2 cell = clamp(ivec2(floor(p)), ivec2(0), ivec2(uGrid) - 1);
  vec4 cid = texelFetch(uIds, cell, 0);
  int id = int(cid.r * 255.0 + 0.5);
  float hk = vHeightKm;
  vec2 wxz = vWorld.xz;
  vec2 mapKm = uGrid * uCellKm;
  float lat = clamp(vWorld.z / mapKm.y, 0.0, 1.0);   // 0 = Norden, 1 = Süden
  float lon = clamp(vWorld.x / mapKm.x, 0.0, 1.0);

  // --- Rauschen (3 Skalen)
  float nFine = noiseN(wxz / 0.25);
  float nGrit = noiseN(wxz / 1.5);
  float nMid = noiseL(wxz / 4.0);
  float nBig = noiseL(wxz / 45.0);
  float nHuge = noiseL(wxz / 260.0 + 17.0);

  // --- Biome (sRGB-Definitionen -> linear)
  vec3 cGrass  = srgb(vec3(0.46, 0.52, 0.30));
  vec3 cFarm   = srgb(vec3(0.60, 0.58, 0.38));
  vec3 cForest = srgb(vec3(0.19, 0.28, 0.15));
  vec3 cDry    = srgb(vec3(0.63, 0.58, 0.41));
  vec3 cDesert = srgb(vec3(0.77, 0.66, 0.47));
  vec3 cTundra = srgb(vec3(0.52, 0.52, 0.44));
  vec3 cSand   = srgb(vec3(0.72, 0.67, 0.50));
  vec3 cRock   = srgb(vec3(0.46, 0.43, 0.39));
  vec3 cSnow   = srgb(vec3(0.88, 0.89, 0.91));
  vec3 cFloor  = srgb(vec3(0.16, 0.20, 0.21));
  vec3 cLake   = srgb(vec3(0.20, 0.32, 0.38));

  float dry = smoothstep(0.76, 0.90, lat + (nHuge - 0.5) * 0.08)
            + smoothstep(0.58, 0.78, lat) * smoothstep(0.72, 0.92, lon) * 0.8;
  dry = clamp(dry, 0.0, 1.0);
  vec3 col = mix(cGrass, cFarm, smoothstep(0.45, 0.6, nBig));
  float forest = smoothstep(0.5, 0.66, nHuge * 0.6 + nBig * 0.4 + (0.3 - lat) * 0.5) * (1.0 - dry);
  forest = max(forest, smoothstep(0.35, 0.8, hk) * (1.0 - smoothstep(1.2, 1.7, hk)) * 0.75 * (1.0 - dry));
  col = mix(col, cForest, forest);
  col *= 1.0 - forest * 0.16 * (1.0 - noiseN(wxz / 0.11));   // Kronen-Sprenkel passend zur Baumschicht
  col = mix(col, mix(cDry, cDesert, smoothstep(0.85, 0.97, lat)), dry);
  col = mix(col, cTundra, smoothstep(0.12, 0.03, lat) * 0.8);
  // Küste: Sand
  float nearSea = 0.0;
  for (int k = 0; k < 4; k++) {
    vec2 o = vec2(k == 0 ? 1.6 : (k == 1 ? -1.6 : 0.0), k == 2 ? 1.6 : (k == 3 ? -1.6 : 0.0));
    if (idAt(p + o) == 0 && waterCoverage(p + o) < 0.5) nearSea = 1.0;
  }
  col = mix(col, cSand, nearSea * (1.0 - smoothstep(0.004, 0.035, hk + (nMid - 0.5) * 0.01)));
  // Fels an steilen/hohen Lagen
  float rock = max(smoothstep(0.06, 0.17, vSlope + (nMid - 0.5) * 0.05), smoothstep(1.3, 2.3, hk));
  col = mix(col, cRock, rock * 0.9);
  // Schnee: Schneegrenze sinkt nach Norden
  float snowLine = mix(0.7, 2.45, smoothstep(0.04, 0.75, lat)) + (nMid - 0.5) * 0.35;
  float snow = smoothstep(snowLine - 0.12, snowLine + 0.12, hk) * (1.0 - 0.5 * smoothstep(0.35, 0.6, vSlope));
  col = mix(col, cSnow, snow);
  // --- Nahdetail (blendet ab ~40 km Kameraabstand ein, ab ~150 km vollständig aus; keine Schleifen, keine Texturen)
  float dtl = 1.0 - smoothstep(40.0, 150.0, vFogDepth);
  if (dtl > 0.001) {
    float lowland = 1.0 - smoothstep(0.25, 0.6, hk);
    float flatness = 1.0 - smoothstep(0.03, 0.09, vSlope);
    // Feldparzellen (gedrehtes Raster 0.42 km): Kulturfarben, Furchen, Hecken an den Rändern
    vec2 fq = vec2(wxz.x * 0.9553 + wxz.y * 0.2955, -wxz.x * 0.2955 + wxz.y * 0.9553);
    vec2 pq = fq / 0.42;
    vec2 pc = floor(pq);
    vec2 pf = fract(pq);
    float ph = hash21(pc);
    float ph2 = hash21(pc + 7.3);
    float farmish = (0.3 + 0.7 * smoothstep(0.4, 0.6, nBig)) * lowland * flatness * (1.0 - forest) * (1.0 - dry);
    vec3 crop = ph < 0.25 ? srgb(vec3(0.72, 0.64, 0.33)) : (ph < 0.5 ? srgb(vec3(0.38, 0.5, 0.22)) : (ph < 0.7 ? srgb(vec3(0.46, 0.34, 0.22)) : (ph < 0.88 ? srgb(vec3(0.58, 0.58, 0.36)) : srgb(vec3(0.3, 0.42, 0.2)))));
    vec2 fwq = fwidth(fq);
    float fa = max(fwq.x, fwq.y);
    float st = ph2 < 0.5 ? fq.x : fq.y;
    float stripe = mix(0.5 + 0.5 * sin(st * 6.2832 / 0.011), 0.5, smoothstep(0.004, 0.012, fa));
    crop *= 0.84 + 0.3 * stripe;
    float edgeKm = min(min(pf.x, 1.0 - pf.x), min(pf.y, 1.0 - pf.y)) * 0.42;
    float hedge = 1.0 - smoothstep(0.003, 0.007 + fa, edgeKm);
    vec3 fieldCol = mix(crop, srgb(vec3(0.2, 0.3, 0.14)), hedge * 0.8);
    col = mix(col, fieldCol, farmish * dtl * 0.8);
    // Gras-/Erdvariation
    float n1 = noiseN(wxz / 0.02 + 7.0);
    float n2 = noiseL(wxz / 0.15 + 3.0);
    col *= 1.0 + dtl * (0.14 * (n2 - 0.5) + 0.1 * (n1 - 0.5));
    float dirt = smoothstep(0.7, 0.9, noiseL(wxz / 0.6 + 11.0)) * (1.0 - forest) * (1.0 - snow);
    col = mix(col, srgb(vec3(0.42, 0.34, 0.24)), dtl * dirt * 0.35);
    // Felsschichtung an Hängen
    float sph = hk * 220.0 + nMid * 5.0;
    float strata = mix(0.5 + 0.5 * sin(sph), 0.5, smoothstep(0.25, 0.8, fwidth(sph)));
    col *= mix(1.0, 0.82 + 0.3 * strata, rock * dtl);
    // Getrockneter Schlamm (Süden): Risse entlang von Rauschkonturen
    float crack = 1.0 - smoothstep(0.0, 0.03 + 0.2 * fa, abs(noiseL(wxz / 0.35 + 5.0) - 0.5));
    col *= 1.0 - 0.24 * crack * dry * dtl;
    // Strand: feuchter Sand nahe der Wasserlinie
    float wet = nearSea * (1.0 - smoothstep(0.0, 0.012, hk));
    col *= 1.0 - 0.2 * wet * dtl;
  }
  // Meeresboden (unter der Wasserfläche)
  if (hk < 0.0 && id == 0) col = mix(cSand, cFloor, smoothstep(0.0, 0.04, -hk));
  // Seen / Flüsse
  // Seen / Flüsse: binäre Flags bilinear interpolieren und schwellen -> abgerundete Konturen
  if (waterCoverage(p) > 0.42) col = cLake * (0.9 + 0.2 * nMid);

  // Körnige Detailtextur
  float nMicro = noiseN(wxz / 0.07 + 31.0);
  col *= 0.8 + 0.2 * nFine + 0.12 * nMicro + 0.1 * nGrit + 0.06 * nMid - 0.06;
  col *= vec3(1.0 + (nGrit - 0.5) * 0.08, 1.0, 1.0 - (nGrit - 0.5) * 0.08);

  // --- Politische Einfärbung
  int sel = int(uSelected + 0.5);
  int hov = int(uHover + 0.5);
  int ply = int(uPlayer + 0.5);
  if (id > 0 && waterCoverage(p) <= 0.42) {
    vec3 pc = texelFetch(uPalette, ivec2(id, 0), 0).rgb;
    float ov = uOverlay * (1.0 - 0.7 * snow);
    if (id == ply) ov = max(ov, 0.35);
    if (id == sel) ov = min(1.0, ov + 0.25);
    float l = lumOf(col);
    vec3 tinted = (col * 0.45 + vec3(l) * 0.55) * (pc / max(lumOf(pc), 0.02));
    col = mix(col, tinted, clamp(ov, 0.0, 1.0));
    if (id == ply) col *= 1.08;
    if (id == hov) col = col * 1.22 + 0.015;
  }

  // --- Grenzen: Nachbarschaft im Radius ~uBorderPx Bildschirmpixel abtasten
  vec2 fw = fwidth(p);
  float r = clamp(max(fw.x, fw.y) * uBorderPx, 0.02, 60.0);
  float pol = 0.0, coast = 0.0, selE = 0.0, hovE = 0.0, plyE = 0.0;
  for (int k = 0; k < 8; k++) {
    float a = float(k) * 0.78539816;
    vec2 o = vec2(cos(a), sin(a)) * r;
    int nb = idAt(p + o);
    if (nb != id) {
      if (nb == 0 || id == 0) coast = 1.0; else pol = 1.0;
      if (sel > 0 && (nb == sel || id == sel)) selE = 1.0;
      if (hov > 0 && (nb == hov || id == hov)) hovE = 1.0;
      if (ply > 0 && (nb == ply || id == ply)) plyE = 1.0;
    }
  }
  if (sel > 0 && selE == 0.0) {
    for (int k = 0; k < 8; k++) {
      float a = float(k) * 0.78539816 + 0.39;
      int nb = idAt(p + vec2(cos(a), sin(a)) * r * 2.2);
      if (nb != id && (nb == sel || id == sel)) selE = 0.75;
    }
  }
  vec3 cBorder = srgb(vec3(0.07, 0.06, 0.05));
  col = mix(col, cBorder, max(pol * 0.82, coast * 0.35 * step(0.0, hk + 0.01)));
  col = mix(col, srgb(vec3(0.72, 0.82, 0.92)), plyE * 0.45);
  col = mix(col, srgb(vec3(0.92, 0.88, 0.74)), hovE * 0.55);
  float pulse = 0.5 + 0.5 * sin(uTime * 4.0);
  col = mix(col, srgb(vec3(1.0, 0.86, 0.42)) * (0.8 + 0.6 * pulse), selE);

  gl_FragColor = vec4(col * vLight, 1.0);
  #include <fog_fragment>
}
`;

// ------------------------------------------------------------------ Terrain

interface LodLevel {
  step: number;
  mesh: THREE.Mesh;
  geo: THREE.InstancedBufferGeometry;
  attr: THREE.InstancedBufferAttribute;
  arr: Float32Array;
  count: number;
}

export class Terrain {
  readonly object: THREE.Object3D;
  /** Geteilte Höhentextur (R16F, km) – kann an Water übergeben werden. */
  readonly heightTexture: THREE.DataTexture;
  readonly countryTexture: THREE.DataTexture;
  readonly paletteTexture: THREE.DataTexture;

  private readonly geo: GeoData;
  private readonly uniforms: Record<string, THREE.IUniform>;
  private readonly lods: LodLevel[] = [];
  private readonly chunksX: number;
  private readonly chunksZ: number;
  private readonly chunkCells: number;
  private readonly chunkMinH: Float32Array;
  private readonly chunkMaxH: Float32Array;
  private readonly boxes: THREE.Box3[] = [];
  private exag = 1;

  // Scratch-Objekte (keine Allokationen pro Frame)
  private readonly frustum = new THREE.Frustum();
  private readonly projView = new THREE.Matrix4();
  private readonly camPos = new THREE.Vector3();

  constructor(geo: GeoData, settings: Settings) {
    this.geo = geo;
    this.chunkCells = geo.meta.grid.chunkCells;
    this.chunksX = Math.ceil(geo.width / this.chunkCells);
    this.chunksZ = Math.ceil(geo.height / this.chunkCells);
    const nChunks = this.chunksX * this.chunksZ;

    this.heightTexture = getHeightTexture(geo);
    this.countryTexture = getCountryTexture(geo);
    this.paletteTexture = this.buildPalette();
    const noise = getNoiseTextures();

    // Min/Max-Höhe je Chunk (km), inkl. 1 Zelle Rand
    this.chunkMinH = new Float32Array(nChunks);
    this.chunkMaxH = new Float32Array(nChunks);
    const W = geo.width, H = geo.height, hs = geo.heightsKm, C = this.chunkCells;
    for (let cz = 0; cz < this.chunksZ; cz++)
      for (let cx = 0; cx < this.chunksX; cx++) {
        let mn = Infinity, mx = -Infinity;
        const x0 = Math.max(0, cx * C - 1), x1 = Math.min(W - 1, cx * C + C);
        const z0 = Math.max(0, cz * C - 1), z1 = Math.min(H - 1, cz * C + C);
        for (let z = z0; z <= z1; z++) {
          const row = z * W;
          for (let x = x0; x <= x1; x++) {
            const h = hs[row + x];
            if (h < mn) mn = h;
            if (h > mx) mx = h;
          }
        }
        const ci = cz * this.chunksX + cx;
        this.chunkMinH[ci] = mn;
        this.chunkMaxH[ci] = mx;
        this.boxes.push(new THREE.Box3());
      }

    this.uniforms = {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uHeight: { value: this.heightTexture },
      uIds: { value: this.countryTexture },
      uPalette: { value: this.paletteTexture },
      uNoiseN: { value: noise.nearest },
      uNoiseL: { value: noise.linear },
      uGrid: { value: new THREE.Vector2(geo.width, geo.height) },
      uCellKm: { value: geo.cellKm },
      uExag: { value: settings.heightExaggeration },
      uSunDir: { value: SUN_DIR.clone() },
      uSunColor: { value: SUN_COLOR.clone() },
      uOverlay: { value: settings.politicalOverlay },
      uHover: { value: 0 },
      uSelected: { value: 0 },
      uPlayer: { value: 0 },
      uTime: { value: 0 },
      uBorderPx: { value: 0.85 },
    };

    const group = new THREE.Group();
    group.name = 'Terrain';
    for (const step of LOD_STEPS) {
      const { geo: g, chunkAttr } = buildLodGeometry(C, step, nChunks);
      const mat = new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: { ...this.uniforms, uStep: { value: step } },
        fog: true,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(g, mat);
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.visible = false;
      mesh.name = `TerrainLOD${step}`;
      group.add(mesh);
      this.lods.push({ step, mesh, geo: g, attr: chunkAttr, arr: chunkAttr.array as Float32Array, count: 0 });
    }
    this.object = group;
    this.applySettings(settings);
  }

  private buildPalette(): THREE.DataTexture {
    const data = new Uint8Array(256 * 4);
    const c = new THREE.Color();
    const put = (i: number, hex: number) => {
      c.setHex(hex); // -> linear (ColorManagement)
      data[i * 4] = Math.round(c.r * 255);
      data[i * 4 + 1] = Math.round(c.g * 255);
      data[i * 4 + 2] = Math.round(c.b * 255);
      data[i * 4 + 3] = 255;
    };
    put(0, PLAYER_COLOR); // Index 0 = Spielerfarbe (ID 0 ist Meer)
    for (let i = 1; i < 256; i++) {
      const meta = this.geo.countriesById.get(i);
      const mc = meta ? Math.max(1, Math.min(9, meta.mapColor | 0)) : ((i % 9) + 1);
      put(i, MAP_COLORS[mc - 1]);
    }
    const tex = new THREE.DataTexture(data, 256, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  private updateBoxes(): void {
    const C = this.chunkCells, ck = this.geo.cellKm, e = this.exag;
    for (let cz = 0; cz < this.chunksZ; cz++)
      for (let cx = 0; cx < this.chunksX; cx++) {
        const ci = cz * this.chunksX + cx;
        const b = this.boxes[ci];
        b.min.set(cx * C * ck, Math.min(this.chunkMinH[ci] * e, 0) - 4, cz * C * ck);
        b.max.set((cx + 1) * C * ck, Math.max(this.chunkMaxH[ci] * e, 0) + 0.5, (cz + 1) * C * ck);
      }
  }

  update(camera: THREE.PerspectiveCamera, timeSec: number): void {
    this.uniforms.uTime.value = timeSec;
    camera.updateMatrixWorld();
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    camera.getWorldPosition(this.camPos);

    const pxAngle = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5)) / (LOD_REF_HEIGHT * camera.zoom);
    const kmPerCell = this.geo.cellKm;
    const lods = this.lods;
    for (let l = 0; l < lods.length; l++) lods[l].count = 0;

    const C = this.chunkCells;
    const nLod = lods.length;
    for (let ci = 0; ci < this.boxes.length; ci++) {
      // Chunks komplett unter Wasser sind vom (opaken) Wasser verdeckt
      if (this.chunkMaxH[ci] < -0.012) continue;
      const box = this.boxes[ci];
      if (!this.frustum.intersectsBox(box)) continue;
      const dist = box.distanceToPoint(this.camPos);
      const stepCells = (dist * pxAngle * LOD_PX_PER_VERTEX) / kmPerCell;
      let li = stepCells <= 1 ? 0 : Math.floor(Math.log2(stepCells));
      if (li >= nLod) li = nLod - 1;
      const lod = lods[li];
      const o = lod.count * 2;
      lod.arr[o] = (ci % this.chunksX) * C;
      lod.arr[o + 1] = Math.floor(ci / this.chunksX) * C;
      lod.count++;
    }
    for (let l = 0; l < nLod; l++) {
      const lod = lods[l];
      lod.geo.instanceCount = lod.count;
      lod.mesh.visible = lod.count > 0;
      if (lod.count > 0) {
        lod.attr.clearUpdateRanges();
        lod.attr.addUpdateRange(0, lod.count * 2);
        lod.attr.needsUpdate = true;
      }
    }
  }

  setHover(countryId: number): void {
    this.uniforms.uHover.value = countryId | 0;
  }

  setSelected(countryId: number): void {
    this.uniforms.uSelected.value = countryId | 0;
  }

  setPlayer(countryId: number): void {
    this.uniforms.uPlayer.value = countryId | 0;
  }

  applySettings(s: Settings): void {
    this.uniforms.uOverlay.value = s.politicalOverlay;
    if (s.heightExaggeration !== this.exag) {
      this.exag = s.heightExaggeration;
      this.uniforms.uExag.value = this.exag;
      this.updateBoxes();
    }
  }
}
