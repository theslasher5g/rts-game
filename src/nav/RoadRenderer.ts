import * as THREE from 'three';
import { bus } from '../core/EventBus';
import type { Settings } from '../core/types';
import type { GeoData } from '../world/GeoData';
import { terrainHeightKm } from '../world/Cities';
import type { NavGraph } from './NavGraph';
import { ROAD_CLASSES } from './types';
import {
  HALF_WIDTH_M, RibbonBuilder, type RoadNet, SCALE_GLSL, T_BALLAST, T_CROSSING, T_LAYBY, T_PATCH, T_RAMP, T_STEEL, TILE_KM, TYPE_OF_CLASS,
  getRoadNet, getRoadUniforms, stationAtOrAfter, stationAtOrBefore, type Crossing, type RestStop,
} from './RoadGeometry';
import { RoadProps, type PropTile } from './RoadProps';

/**
 * Straßen-/Schienen-/Fährnetz als aufs Gelände gelegte Bänder (ein Mesh je Klasse + Brücken).
 *
 * - Eigener ShaderMaterial (mit logdepthbuf-/fog-Chunks): Bandbreite wächst mit dem Kamera-
 *   abstand (konstante Pixelbreite, mit Mindestbreite in km), Höhe = Gelände (CPU-gesampelt, in km,
 *   Überhöhung per Uniform) + Abstandsaufschlag gegen Verschlucken durch das LOD-Gelände.
 * - Sichtbarkeit je Klasse nach Kamerahöhe; Meshes werden erst beim ersten Sichtbarwerden gebaut.
 * - Gesperrte Kanten (setEdgeState / Bus 'nav:edge'): rot gestrichelt (Attribut aClosed).
 *
 * Nahbereich (Kameraabstand < ~38 km): echte Fahrbahnbänder in 6-km-Kacheln (lazy, ≤ 3 Kacheln/Frame, LRU) mit
 * prozeduralem Querschnitt im Fragment-Shader (Asphalt, Mittel-/Randlinien, Seitenstreifen, Mittelstreifen,
 * Spurrillen, Schotterbett + Schwellen + Schienen), Kreuzungsflächen, Autobahnrampen, Rastplätze, Bahnübergänge.
 * Breite/Höhe wachsen mit dem Kameraabstand (strategischer Maßstab S, siehe RoadGeometry). Dazu Straßenmöblierung
 * (RoadProps, ≤ ~15 km). Die Linien-Darstellung bleibt als billige Fernansicht und als Rückfall erhalten.
 */

const DENSIFY_KM = 0.0625;

interface ClassStyle {
  color: number;
  /** Breite in internen Pixeln */
  px: number;
  minKm: number;
  /** Sichtbar bis Kamerahöhe (km) */
  maxY: number;
  lift: number;
  dash?: number;
}

const STYLES: Record<string, ClassStyle> = {
  motorway: { color: 0xe6b84a, px: 2.0, minKm: 0.03, maxY: 1e9, lift: 0.002 },
  primary: { color: 0xd8d2b4, px: 1.6, minKm: 0.02, maxY: 2600, lift: 0.0 },
  secondary: { color: 0xc4bfa6, px: 1.3, minKm: 0.015, maxY: 1100, lift: 0.0 },
  road: { color: 0xa9a58f, px: 1.1, minKm: 0.012, maxY: 420, lift: 0.0 },
  track: { color: 0x8a7f66, px: 1.0, minKm: 0.01, maxY: 180, lift: 0.0, dash: 0.6 },
  rail: { color: 0x2c2a2a, px: 1.3, minKm: 0.012, maxY: 1400, lift: 0.002, dash: 0.5 },
  ferry: { color: 0x9fd0e8, px: 1.4, minKm: 0.12, maxY: 1500, lift: 0.0, dash: 5 },
  bridge: { color: 0xf0e2b0, px: 2.2, minKm: 0.03, maxY: 1100, lift: 0.004 },
};

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
#include <fog_pars_vertex>
attribute vec3 aSide;   // perp.x, perp.z, side
attribute vec2 aInfo;   // km entlang, gesperrt
uniform float uExag;
uniform float uPx;
uniform float uMinKm;
uniform float uLift;
uniform float uDistLift;
varying float vDist;
varying float vClosed;
varying float vSide;
varying vec2 vXZ;
void main() {
  vec3 p = position;                       // x, Höhe(km), z
  vec4 mv0 = viewMatrix * vec4(p.x, p.y * uExag, p.z, 1.0);
  float d = max(1.0, length(mv0.xyz));
  float w = max(uMinKm, uPx * d * 0.00133);
  float dl = uDistLift > 0.0 ? uDistLift + 0.0023 * smoothstep(15.0, 60.0, d) : 0.0;
  vec3 wp = vec3(p.x + aSide.x * aSide.z * w * 0.5, p.y * uExag + uLift + d * dl, p.z + aSide.y * aSide.z * w * 0.5);
  vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  vDist = aInfo.x;
  vClosed = aInfo.y;
  vSide = aSide.z;
  vXZ = wp.xz;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
#include <fog_pars_fragment>
uniform vec3 uColor;
uniform float uDash;     // Periode in km (0 = durchgezogen)
uniform float uDashMode; // 0 Lücken, 1 Schwellen (hell/dunkel)
uniform float uNear;     // 1 = nah (Muster sichtbar), 0 = fern (Muster ausgeblendet)
varying float vDist;
varying float vClosed;
varying float vSide;
varying vec2 vXZ;
uniform sampler2D uMask;
uniform vec3 uMaskInfo;  // Kacheln x, z, Kachelgröße km (0 = aus)
uniform float uUseMask;
void main() {
  #include <logdepthbuf_fragment>
  if (uUseMask > 0.5 && uMaskInfo.z > 0.0) {
    vec2 tc = (floor(vXZ / uMaskInfo.z) + 0.5) / uMaskInfo.xy;
    if (texture2D(uMask, tc).r > 0.5) discard;
  }
  vec3 col = uColor;
  if (vClosed > 0.5) {
    if (fract(vDist / 0.8) > 0.55) discard;
    col = vec3(0.85, 0.08, 0.05);
  } else if (uDash > 0.0) {
    float f = fract(vDist / uDash);
    if (uDashMode < 0.5) {
      if (f > 0.6 && uNear > 0.0) discard;
    } else {
      col *= mix(1.0, f < 0.35 ? 1.9 : 0.8, uNear);
    }
  }
  gl_FragColor = vec4(col, 1.0);
  #include <fog_fragment>
}
`;


// ====================================================================== Fahrbahnbänder (Nahbereich)

const RIB_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
#include <fog_pars_vertex>
${SCALE_GLSL}
attribute vec4 aSide;   // perpX, perpZ, Seite, Querversatz (km)
attribute vec4 aInfo;   // Längsposition km, Halbbreite km, Typ, gesperrt
uniform float uLift0;
uniform float uLift1;
varying float vAlong;
varying float vLat;
varying float vType;
varying float vClosed;
varying float vDist;
float rankOf(float t) {
  // Lift-Rangfolge: Schiene < Weg < Straße < Autobahn < Kreuzung < Übergang
  if (t < 0.5) return 5.0;      // Autobahn
  if (t < 1.5) return 4.0;
  if (t < 2.5) return 3.0;
  if (t < 3.5) return 2.0;
  if (t < 4.5) return 1.0;
  if (t < 5.5) return 0.0;      // Schiene
  if (t < 6.5) return 7.0;      // Kreuzungsfläche
  if (t < 7.5) return 4.5;      // Rampe
  if (t < 8.5) return 5.5;      // Rastplatz
  if (t < 9.5) return 8.0;      // Bahnübergang
  if (t < 10.5) return 9.0;     // Schienenstück am Übergang
  return 7.5;                   // Schotterfläche
}
void main() {
  vec2 c = position.xz;
  float g0 = groundKm(c) * uExag;
  float d = max(1.0, distance(cameraPosition, vec3(c.x, g0, c.y)));
  float S = roadScale(d);
  vec2 xz = c + aSide.xy * (aSide.z * aInfo.y + aSide.w) * S;
  float g = groundKm(xz) * uExag;
  float lift = uLift0 + d * (uLift1 + 0.00014 * rankOf(aInfo.z));
  vec4 mvPosition = viewMatrix * vec4(xz.x, g + lift, xz.y, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  vAlong = aInfo.x;
  vLat = aSide.z * aInfo.y * 1000.0;
  vType = aInfo.z;
  vClosed = aInfo.w;
  vDist = d;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

const RIB_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
#include <fog_pars_fragment>
uniform vec3 uLight;
varying float vAlong;
varying float vLat;
varying float vType;
varying float vClosed;
varying float vDist;

float hs(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec3 sr(vec3 c) { return pow(c, vec3(2.2)); }
float pw2(float x) { return exp2(ceil(log2(max(1.0, x)))); }
float pxL;
// Linie mit Flächendeckung (Teilpixel-Linien werden blasser statt zu Streifen aufzublähen)
float band(float x, float c, float w) {
  float cov = clamp(0.5 + (w - abs(x - c)) / pxL, 0.0, 1.0);
  return cov * clamp(2.0 * w / pxL + 0.18, 0.0, 1.0);
}

void main() {
  #include <logdepthbuf_fragment>
  float lat = vLat;
  float a = abs(lat);
  pxL = max(fwidth(lat), 0.03);
  float am = vAlong * 1000.0;
  float pxA = max(fwidth(am), 0.03);
  float aqN = pw2(pxA * 0.8);
  float lq = pw2(pxL * 1.2);
  float nA = hs(vec2(floor(am / (3.0 * aqN)), floor((lat + 9.0) / (0.9 * lq))));
  float nB = hs(vec2(floor(am / (6.0 * aqN)), floor((lat + 9.0) / (2.4 * lq))));
  float dash12 = step(fract(am / (12.0 * pw2(5.0 * pxA / 12.0))), 0.34);
  float dash9 = step(fract(am / (9.0 * pw2(5.0 * pxA / 9.0))), 0.4);

  vec3 cAsph = sr(vec3(0.29, 0.29, 0.30));
  vec3 cAsphW = sr(vec3(0.38, 0.37, 0.35));
  vec3 cGrav = sr(vec3(0.55, 0.50, 0.41));
  vec3 cVerge = sr(vec3(0.33, 0.38, 0.21));
  vec3 cWhite = sr(vec3(0.90, 0.90, 0.85));
  vec3 cYell = sr(vec3(0.93, 0.74, 0.20));
  vec3 cConc = sr(vec3(0.66, 0.65, 0.61));
  vec3 cDirt = sr(vec3(0.48, 0.38, 0.26));
  vec3 cDirtD = sr(vec3(0.30, 0.23, 0.16));
  vec3 cGrass = sr(vec3(0.38, 0.45, 0.24));
  vec3 cBall = sr(vec3(0.46, 0.44, 0.41));
  vec3 cSleep = sr(vec3(0.22, 0.18, 0.15));
  vec3 cSteel = sr(vec3(0.72, 0.72, 0.74));
  vec3 col = cAsph;
  vec3 flatC = sr(vec3(0.78, 0.76, 0.66));
  int t = int(vType + 0.5);

  if (t == 0) {            // Autobahn: 2 Fahrbahnen + Mittelstreifen
    flatC = sr(vec3(0.90, 0.72, 0.29));
    if (a < 1.9) {
      col = cConc * (0.92 + 0.12 * nA);
      col = mix(col, cConc * 0.5, band(a, 0.0, 0.16));
    } else if (a < 11.6) {
      col = mix(cAsph, cAsphW, step(0.62, nB) * 0.55);
      if (a > 9.0) col = mix(col, cAsphW, 0.75);
      float w = band(a, 2.45, 0.13) + band(a, 9.0, 0.15) + band(a, 5.75, 0.12) * dash12;
      col = mix(col, cWhite, clamp(w, 0.0, 1.0));
    } else if (a < 12.9) {
      col = mix(cGrav, cGrav * 0.82, nA);
    } else {
      col = mix(cVerge, cVerge * 1.18, nA);
    }
  } else if (t == 1) {     // Fernstraße: 2 Spuren
    flatC = sr(vec3(0.85, 0.82, 0.71));
    if (a < 3.75) {
      col = mix(cAsph, cAsphW, step(0.7, nB) * 0.5);
      float w = band(a, 3.35, 0.13) + band(a, 0.0, 0.14) * dash12;
      col = mix(col, cWhite, clamp(w, 0.0, 1.0));
    } else if (a < 5.0) {
      col = mix(cGrav, cGrav * 0.82, nA);
    } else {
      col = mix(cVerge, cVerge * 1.18, nA);
    }
  } else if (t == 2) {     // Landstraße: schmaler, abgenutzt, gelbe Mittellinie
    flatC = sr(vec3(0.77, 0.75, 0.65));
    if (a < 3.0) {
      col = mix(cAsph * 1.1, cAsphW, 0.35 + step(0.62, nB) * 0.5);
      float w = band(a, 0.0, 0.12) * dash9;
      col = mix(col, cYell, w);
    } else if (a < 3.9) {
      col = mix(cGrav, cGrav * 0.8, nA);
    } else {
      col = mix(cVerge, cVerge * 1.18, nA);
    }
  } else if (t == 3) {     // Nebenstraße: sehr schmal, geflickt
    flatC = sr(vec3(0.66, 0.64, 0.56));
    if (a < 2.25) {
      col = mix(cAsphW, cAsph * 1.1, step(0.55, nB) * 0.7);
      col = mix(col, cAsph * 0.8, step(0.86, hs(vec2(floor(am / (7.0 * aqN)), floor((lat + 4.0) / 2.5)))) * 0.8);
    } else if (a < 3.1) {
      col = mix(cGrav, cGrav * 0.8, nA);
    } else {
      col = mix(cVerge, cVerge * 1.18, nA);
    }
  } else if (t == 4) {     // Feldweg: Spurrillen + Grasmittelstreifen
    flatC = sr(vec3(0.54, 0.50, 0.40));
    if (a < 2.55) {
      col = mix(cDirt, cDirt * 0.85, nA);
      col = mix(col, cDirtD, band(a, 1.05, 0.34));
      col = mix(col, cGrass, step(a, 0.5 + pxL * 0.3) * 0.9);
    } else {
      col = mix(cVerge, cVerge * 1.15, nA);
    }
  } else if (t == 5) {     // Schiene: Schotterbett, Schwellen, Schienen
    flatC = sr(vec3(0.17, 0.16, 0.16));
    float aqS = pw2(4.0 * pxA / 0.65);
    float sl = step(fract(am / (0.65 * aqS)), 0.32);
    if (a < 2.1) {
      col = mix(cBall, cBall * 0.78, nA);
      float slW = step(a, 1.35) * sl;
      col = mix(col, cSleep, slW * (1.0 - smoothstep(6.0, 20.0, aqS)));
      float rl = band(a, 0.72, 0.1);
      col = mix(col, cSteel, rl);
    } else if (a < 3.0) {
      col = mix(cGrav, cGrav * 0.82, nA);
    } else {
      col = mix(cVerge, cVerge * 1.18, nA);
    }
  } else if (t == 6) {     // Kreuzungsfläche
    col = mix(cAsph * 1.05, cAsphW, step(0.55, nA) * 0.5);
  } else if (t == 7) {     // Rampe
    flatC = sr(vec3(0.85, 0.82, 0.71));
    if (a < 3.0) {
      col = mix(cAsph, cAsphW, step(0.7, nB) * 0.4);
      col = mix(col, cWhite, band(a, 2.6, 0.12));
    } else {
      col = mix(cGrav, cGrav * 0.8, nA);
    }
  } else if (t == 8) {     // Rastplatz: Parkbuchten
    col = mix(cAsph * 1.1, cAsphW, 0.4);
    float bay = step(fract(am / 3.6), 0.07) * step(1.2, a);
    col = mix(col, cWhite, bay);
    col = mix(col, cGrav, step(4.0, a));
  } else if (t == 9) {     // Bahnübergang: Plattenbelag
    col = mix(cConc * 0.8, cConc * 0.55, step(0.5, fract(am / 1.6)));
  } else if (t == 10) {    // Schienenstück
    col = cSteel;
  } else {                 // Schotterfläche (Gleisknoten)
    col = mix(cBall, cBall * 0.78, nA);
  }

  col = mix(col, flatC, smoothstep(9.0, 24.0, vDist));
  if (vClosed > 0.5) {
    float st = step(0.5, fract(am / (10.0 * pw2(5.0 * pxA / 10.0))));
    col = mix(col, vec3(0.85, 0.06, 0.03), 0.82 * st);
  }
  gl_FragColor = vec4(col * uLight, 1.0);
  #include <fog_fragment>
}
`;

interface Part {
  cls: string;
  mat: THREE.ShaderMaterial;
  mesh: THREE.Mesh | null;
  /** Kanten dieser Klasse */
  edges: number[];
  closedAttr: THREE.BufferAttribute | null;
  /** edgeId -> [Startvertex, Anzahl] */
  ranges: Map<number, [number, number]>;
  maxY: number;
  minY: number;
}

interface Tile {
  key: number;
  tx: number;
  tz: number;
  ribbon: THREE.Mesh | null;
  ranges: Map<number, Array<[number, number]>>;
  props: PropTile | null;
  built: boolean;
  propsBuilt: boolean;
  last: number;
  dist: number;
  crossings: Crossing[];
  stops: RestStop[];
}

/** Ab diesem Kameraabstand (km) gibt es nur noch die Linien-Darstellung */
const DETAIL_MAX = 38;
/** Props nur bis zu diesem Kameraabstand */
const PROP_MAX_DIST = 15;
const TILE_BUILDS_PER_FRAME = 3;
const MAX_TILES = 150;
const PROP_BUDGET = 60000;
void T_BALLAST;

export class RoadRenderer {
  readonly object = new THREE.Group();
  private readonly geo: GeoData;
  private readonly graph: NavGraph;
  private readonly parts: Part[] = [];
  private readonly partOfEdge: Int8Array;
  private readonly closed = new Set<number>();
  private exag: number;
  private show: boolean;

  // --- Nahbereich
  private readonly net: RoadNet;
  private readonly props: RoadProps;
  private readonly detail = new THREE.Group();
  private readonly ribMat: THREE.ShaderMaterial;
  private readonly shared: Record<string, THREE.IUniform>;
  private readonly tiles = new Map<number, Tile>();
  private frame = 0;
  private readonly cand: Tile[] = [];
  private readonly camPos = new THREE.Vector3();
  private readonly camDir = new THREE.Vector3();
  private readonly tmp4 = new Float64Array(4);
  private readonly mask: Uint8Array;
  private readonly maskTex: THREE.DataTexture;
  private readonly maskInfo = new THREE.Vector3(1, 1, 0);
  private readonly maskW: number;
  private readonly maskH: number;

  constructor(geo: GeoData, graph: NavGraph, settings: Settings) {
    this.geo = geo;
    this.graph = graph;
    this.exag = settings.heightExaggeration;
    this.show = settings.showRoads;
    this.object.name = 'Roads';
    this.object.visible = this.show;

    this.maskW = Math.ceil(geo.widthKm / TILE_KM) + 2;
    this.maskH = Math.ceil(geo.heightKm / TILE_KM) + 2;
    this.mask = new Uint8Array(this.maskW * this.maskH);
    this.maskTex = new THREE.DataTexture(this.mask, this.maskW, this.maskH, THREE.RedFormat, THREE.UnsignedByteType);
    this.maskTex.minFilter = this.maskTex.magFilter = THREE.NearestFilter;
    this.maskTex.needsUpdate = true;
    const order = ['motorway', 'primary', 'secondary', 'road', 'track', 'rail', 'ferry', 'bridge'];
    for (const cls of order) {
      const st = STYLES[cls];
      const mat = new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        fog: true,
        uniforms: THREE.UniformsUtils.merge([
          THREE.UniformsLib.fog,
          {
            uColor: { value: new THREE.Color(st.color) },
            uExag: { value: this.exag },
            uPx: { value: st.px },
            uMinKm: { value: st.minKm },
            uLift: { value: st.lift },
            uDistLift: { value: cls === 'ferry' ? 0 : 0.0012 },
            uDash: { value: st.dash ?? 0 },
            uDashMode: { value: cls === 'rail' ? 1 : 0 },
            uNear: { value: 1 },
            uMask: { value: this.maskTex },
            uMaskInfo: { value: this.maskInfo },
            uUseMask: { value: cls === 'ferry' || cls === 'bridge' ? 0 : 1 },
          },
        ]),
        side: THREE.DoubleSide,
      });
      this.parts.push({ cls, mat, mesh: null, edges: [], closedAttr: null, ranges: new Map(), maxY: st.maxY, minY: cls === 'bridge' ? 45 : 0 });
    }
    this.partOfEdge = new Int8Array(graph.edges.length);
    const idx = (c: string) => order.indexOf(c);
    for (const e of graph.edges) {
      const p = idx(e.cls);
      this.partOfEdge[e.id] = p;
      this.parts[p].edges.push(e.id);
      // Brücken zusätzlich als hervorgehobenes, leicht erhöhtes Band (nur Straßen)
      if (e.bridge && e.cls !== 'ferry' && e.cls !== 'rail') this.parts[idx('bridge')].edges.push(e.id);
    }
    // Brücken überlagern die Klasse: Kante auch im normalen Mesh lassen (ununterbrochenes Band),
    // das Brückenmesh liegt leicht darüber. Bewahrt Kantenzuordnung für setEdgeState.
    bus.on('nav:edge', ({ edgeId, open }) => this.setEdgeState(edgeId, open));
    void ROAD_CLASSES;

    // Nahbereich: Bänder + Props
    this.net = getRoadNet(geo, graph);
    this.shared = getRoadUniforms(geo);
    this.shared.uExag.value = this.exag;
    this.ribMat = new THREE.ShaderMaterial({
      vertexShader: RIB_VERT,
      fragmentShader: RIB_FRAG,
      fog: true,
      side: THREE.DoubleSide,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { uLight: { value: new THREE.Vector3(0.98, 0.95, 0.9) }, uLift0: { value: 0.002 + 0.0006 * this.exag }, uLift1: { value: 0.0016 } },
      ]),
    });
    Object.assign(this.ribMat.uniforms, this.shared);
    this.props = new RoadProps(geo, this.net);
    this.detail.name = 'RoadDetail';
    this.object.add(this.detail);
  }

  /** Anzahl lebender Prop-Instanzen (Debug) */
  get propCount(): number {
    return this.props.total;
  }

  applySettings(s: Settings): void {
    this.exag = s.heightExaggeration;
    this.show = s.showRoads;
    this.object.visible = this.show;
    for (const p of this.parts) p.mat.uniforms.uExag.value = this.exag;
    this.shared.uExag.value = this.exag;
    this.ribMat.uniforms.uLift0.value = 0.002 + 0.0006 * this.exag;
  }

  setEdgeState(edgeId: number, open: boolean): void {
    if (open) this.closed.delete(edgeId);
    else this.closed.add(edgeId);
    const e = this.graph.edges[edgeId];
    if (!e) return;
    const targets = [this.parts[this.partOfEdge[edgeId]], this.parts[this.parts.length - 1]];
    for (const p of targets) {
      if (!p || !p.closedAttr) continue;
      const r = p.ranges.get(edgeId);
      if (!r) continue;
      const arr = p.closedAttr.array as Float32Array;
      for (let v = r[0]; v < r[0] + r[1]; v++) arr[v * 2 + 1] = open ? 0 : 1;
      p.closedAttr.needsUpdate = true;
    }
    // Bänder im Nahbereich
    for (const t of this.tiles.values()) {
      const r = t.ranges.get(edgeId);
      if (!r || !t.ribbon) continue;
      const attr = t.ribbon.geometry.getAttribute('aInfo') as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      for (const [v0, n] of r) for (let v = v0; v < v0 + n; v++) arr[v * 4 + 3] = open ? 0 : 1;
      attr.needsUpdate = true;
    }
  }

  update(camera: THREE.PerspectiveCamera): void {
    if (!this.show) return;
    const y = camera.position.y;
    for (const p of this.parts) {
      const vis = y <= p.maxY && y >= p.minY;
      if (vis && !p.mesh) this.build(p);
      if (p.mesh) p.mesh.visible = vis;
      p.mat.uniforms.uNear.value = y < 120 ? 1 : y < 260 ? 1 - (y - 120) / 140 : 0;
    }
    this.updateDetail(camera);
  }


  // ------------------------------------------------------------------ Nahbereich (Kacheln)

  private updateDetail(camera: THREE.PerspectiveCamera): void {
    this.frame++;
    camera.updateMatrixWorld();
    this.camPos.setFromMatrixPosition(camera.matrixWorld);
    camera.getWorldDirection(this.camDir);
    const cp = this.camPos, dir = this.camDir;
    // Blickpunkt am Boden (2 Iterationen gegen das überhöhte Gelände)
    let fx = cp.x, fz = cp.z, fy = 0;
    if (dir.y < -0.05) {
      for (let k = 0; k < 3; k++) {
        const t = (cp.y - fy) / -dir.y;
        fx = cp.x + dir.x * t;
        fz = cp.z + dir.z * t;
        fy = Math.max(0, terrainHeightKm(this.geo, fx, fz)) * this.exag;
      }
    } else {
      fy = Math.max(0, terrainHeightKm(this.geo, fx, fz)) * this.exag;
    }
    const dist = Math.max(1, Math.hypot(cp.x - fx, cp.y - fy, cp.z - fz));
    const vis = dist < DETAIL_MAX;
    this.detail.visible = vis;
    if (!vis) { this.setMask(false, fx, fz, 0); return; }
    const R = Math.min(34, Math.max(7, dist * 1.35));
    const propR = dist < PROP_MAX_DIST ? Math.min(15, Math.max(5, dist * 1.3 + 2)) : 0;
    const t0x = Math.floor((fx - R) / TILE_KM), t1x = Math.floor((fx + R) / TILE_KM);
    const t0z = Math.floor((fz - R) / TILE_KM), t1z = Math.floor((fz + R) / TILE_KM);
    this.cand.length = 0;
    for (let tz = t0z; tz <= t1z; tz++) {
      for (let tx = t0x; tx <= t1x; tx++) {
        const key = this.net.key(tx, tz);
        let t = this.tiles.get(key);
        const cx = (tx + 0.5) * TILE_KM, cz = (tz + 0.5) * TILE_KM;
        const dd = Math.hypot(cx - fx, cz - fz);
        if (dd > R + TILE_KM * 0.72) { if (t) { if (t.ribbon) t.ribbon.visible = false; if (t.props) t.props.group.visible = false; } continue; }
        if (!t) {
          if (cx < -TILE_KM || cz < -TILE_KM || cx > this.geo.widthKm + TILE_KM || cz > this.geo.heightKm + TILE_KM) continue;
          t = { key, tx, tz, ribbon: null, ranges: new Map(), props: null, built: false, propsBuilt: false, last: 0, dist: dd, crossings: [], stops: [] };
          this.tiles.set(key, t);
        }
        t.last = this.frame;
        t.dist = dd;
        if (t.ribbon) t.ribbon.visible = true;
        const wantProps = dd < propR + TILE_KM * 0.5;
        if (t.props) t.props.group.visible = wantProps;
        if (!t.built || (wantProps && !t.propsBuilt)) this.cand.push(t);
      }
    }
    if (this.cand.length > 0) {
      this.cand.sort((a, b) => a.dist - b.dist);
      let budget = TILE_BUILDS_PER_FRAME;
      for (const t of this.cand) {
        if (budget <= 0) break;
        if (!t.built) {
          this.buildRibbon(t);
          budget--;
        } else if (!t.propsBuilt && t.dist < propR + TILE_KM * 0.5) {
          this.buildProps(t);
          budget--;
        }
        if (!t.propsBuilt && !t.built) continue;
        if (budget > 0 && t.built && !t.propsBuilt && t.dist < propR + TILE_KM * 0.5) {
          this.buildProps(t);
          budget--;
        }
      }
    }
    this.setMask(true, fx, fz, R);
    this.evict();
  }

  /** Maske der fertigen Kachelbänder: dort werden die Fern-Linien ausgeblendet */
  private setMask(on: boolean, fx: number, fz: number, R: number): void {
    let dirty = false;
    this.maskInfo.set(this.maskW, this.maskH, on ? TILE_KM : 0);
    for (const t of this.tiles.values()) {
      if (t.tx < 0 || t.tz < 0 || t.tx >= this.maskW || t.tz >= this.maskH) continue;
      const want = on && t.built && t.last === this.frame && Math.hypot((t.tx + 0.5) * TILE_KM - fx, (t.tz + 0.5) * TILE_KM - fz) <= R + TILE_KM * 0.72 ? 255 : 0;
      const i = t.tz * this.maskW + t.tx;
      if (this.mask[i] !== want) { this.mask[i] = want; dirty = true; }
    }
    if (dirty) this.maskTex.needsUpdate = true;
  }

  private evict(): void {
    // Props: Obergrenze Instanzen/Kacheln, Bänder: Kachelanzahl
    if (this.props.total > PROP_BUDGET || this.tiles.size > MAX_TILES) {
      const list = Array.from(this.tiles.values()).filter((t) => t.last < this.frame).sort((a, b) => a.last - b.last);
      for (const t of list) {
        if (this.props.total <= PROP_BUDGET && this.tiles.size <= MAX_TILES) break;
        if (t.props) { this.props.disposeTile(t.props); t.props = null; t.propsBuilt = false; }
        if (this.tiles.size > MAX_TILES) {
          if (t.ribbon) { this.detail.remove(t.ribbon); t.ribbon.geometry.dispose(); t.ribbon = null; }
          if (t.tx >= 0 && t.tz >= 0 && t.tx < this.maskW && t.tz < this.maskH) this.mask[t.tz * this.maskW + t.tx] = 0;
          this.maskTex.needsUpdate = true;
          this.tiles.delete(t.key);
        }
      }
    }
  }

  private buildProps(t: Tile): void {
    t.propsBuilt = true;
    const pt: PropTile | null = this.props.buildTile(t.tx, t.tz, t.crossings, t.stops);
    if (pt) {
      t.props = pt;
      this.detail.add(pt.group);
    }
  }

  private buildRibbon(t: Tile): void {
    t.built = true;
    const net = this.net, graph = this.graph;
    const rb = new RibbonBuilder();
    const x0 = t.tx * TILE_KM, x1 = x0 + TILE_KM, z0 = t.tz * TILE_KM, z1 = z0 + TILE_KM;
    const inTile = (x: number, z: number) => x >= x0 && x < x1 && z >= z0 && z < z1;
    const list = net.tileEdges(t.tx, t.tz);
    if (list) {
      for (let li = 0; li < list.length; li += 3) {
        const e = graph.edges[list[li]];
        if (e.bridge || e.cls === 'ferry') continue;
        const st = net.stations(e.id);
        const type = TYPE_OF_CLASS[e.cls], hw = HALF_WIDTH_M[e.cls];
        const closed = this.closed.has(e.id) ? 1 : 0;
        const i0 = Math.max(0, stationAtOrBefore(st, list[li + 1]) - 1);
        const i1 = Math.min(st.n - 1, stationAtOrAfter(st, list[li + 2]) + 1);
        let run = -1;
        for (let i = i0; i < i1; i++) {
          const inside = inTile((st.xz[i * 2] + st.xz[i * 2 + 2]) * 0.5, (st.xz[i * 2 + 1] + st.xz[i * 2 + 3]) * 0.5);
          if (inside && run < 0) run = i;
          if (run >= 0 && (!inside || i === i1 - 1)) {
            rb.strip(st, run, inside ? i + 1 : i, hw, type, closed, 0, e.id);
            run = -1;
          }
        }
      }
    }
    // Kreuzungen / Knicke
    const nodes = net.tileNodes(t.tx, t.tz);
    if (nodes) {
      for (const nid of nodes) {
        const n = graph.nodes[nid];
        if (!inTile(n.x, n.z)) continue;
        let maxHw = 0, rail = 0, road = 0, wayCount = 0;
        const away: number[] = [];
        for (const eid of n.edges) {
          const e = graph.edges[eid];
          if (e.cls === 'ferry') continue;
          wayCount++;
          if (e.cls === 'rail') rail++; else { road++; maxHw = Math.max(maxHw, HALF_WIDTH_M[e.cls]); }
          const st = net.stations(eid);
          const first = e.a === nid;
          const k = first ? 0 : st.n - 1;
          away.push(first ? st.tx[k] : -st.tx[k], first ? st.tz[k] : -st.tz[k]);
        }
        if (wayCount < 2) continue;
        let need = wayCount >= 3;
        if (!need && wayCount === 2) need = away[0] * away[2] + away[1] * away[3] > -0.965;
        if (!need) continue;
        if (road > 0) rb.disc(n.x, n.z, maxHw * 0.86, T_PATCH, 12);
        else if (rail > 0) rb.disc(n.x, n.z, 3.6, T_BALLAST, 10);
        this.addRamps(rb, nid, inTile);
      }
    }
    // Bahnübergänge
    t.crossings = net.crossings(t.tx, t.tz);
    for (const c of t.crossings) {
      const sinA = Math.max(0.35, Math.abs(c.rtx * c.ttz - c.rtz * c.ttx));
      rb.bar(c.x, c.z, c.rtx, c.rtz, Math.min(18, Math.max(8, 6.5 / sinA)), c.roadHwM * 0.74, T_CROSSING);
      for (const off of [-0.72, 0.72]) rb.bar(c.x, c.z, c.ttx, c.ttz, (c.roadHwM * 1.5) / sinA, 0.42, T_STEEL, off * 0.001);
    }
    // Rastplätze
    t.stops = net.restStops(t.tx, t.tz);
    const tmp = this.tmp4;
    for (const r of t.stops) {
      const st = net.stations(r.edge);
      const lat = r.side * (r.hwM * 0.95 + 5.0) * 0.001;
      const taper = [0.3, 1, 1, 1, 0.3];
      const sa = [-60, -35, 0, 35, 60];
      const first = rb.vcount;
      for (let k = 0; k < 5; k++) {
        net.pointAt(st, r.s + sa[k] * 0.001, tmp);
        const hw = 4.8 * taper[k] * 0.001;
        const v = rb.vertex(tmp[0], tmp[1], -tmp[3], tmp[2], -1, lat, 0, hw, T_LAYBY, 0);
        rb.vertex(tmp[0], tmp[1], -tmp[3], tmp[2], 1, lat, 0, hw, T_LAYBY, 0);
        void v;
      }
      for (let k = 0; k < 4; k++) {
        const a = first + k * 2;
        rb.idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    t.ranges = rb.ranges;
    const g = rb.toGeometry();
    if (g) {
      const m = new THREE.Mesh(g, this.ribMat);
      m.frustumCulled = false;
      m.renderOrder = 2;
      m.name = `RoadTile-${t.tx}-${t.tz}`;
      t.ribbon = m;
      this.detail.add(m);
    }
  }

  /** Auf-/Abfahrt-Hinweis an Anschlussstellen Autobahn ↔ andere Straße */
  private addRamps(rb: RibbonBuilder, nid: number, inTile: (x: number, z: number) => void | boolean): void {
    void inTile;
    const net = this.net, graph = this.graph, n = graph.nodes[nid];
    const mw: number[] = [], others: number[] = [];
    for (const eid of n.edges) {
      const e = graph.edges[eid];
      if (e.bridge) continue;
      if (e.cls === 'motorway') mw.push(eid);
      else if (e.cls !== 'rail' && e.cls !== 'ferry' && e.cls !== 'track') others.push(eid);
    }
    if (mw.length < 1 || mw.length > 2 || others.length < 1) return;
    const m = graph.edges[mw[0]], f = graph.edges[others[0]];
    const stM = net.stations(m.id), stF = net.stations(f.id);
    const dm = Math.min(0.5, stM.total * 0.45), df = Math.min(0.32, stF.total * 0.4);
    const tmp = this.tmp4;
    net.pointAt(stM, m.a === nid ? dm : stM.total - dm, tmp);
    const pmx = tmp[0], pmz = tmp[1];
    const dmx = m.a === nid ? -tmp[2] : tmp[2], dmz = m.a === nid ? -tmp[3] : tmp[3];
    net.pointAt(stF, f.a === nid ? df : stF.total - df, tmp);
    const pfx = tmp[0], pfz = tmp[1];
    const afx = f.a === nid ? tmp[2] : -tmp[2], afz = f.a === nid ? tmp[3] : -tmp[3];
    for (const side of [-1, 1]) {
      const nx = -dmz * side, nz = dmx * side;
      const p1x = pmx + dmx * dm * 0.5 + nx * 0.07, p1z = pmz + dmz * dm * 0.5 + nz * 0.07;
      const p2x = pfx - afx * df * 0.8 + nx * 0.035, p2z = pfz - afz * df * 0.8 + nz * 0.035;
      const pts: number[] = [];
      const N = 9;
      for (let k = 0; k <= N; k++) {
        const u = k / N, w = 1 - u;
        pts.push(
          w * w * w * pmx + 3 * w * w * u * p1x + 3 * w * u * u * p2x + u * u * u * pfx,
          w * w * w * pmz + 3 * w * w * u * p1z + 3 * w * u * u * p2z + u * u * u * pfz,
        );
      }
      rb.poly(pts, 3.4, T_RAMP);
    }
  }

  // ------------------------------------------------------------------ Geometrie

  private build(p: Part): void {
    const geo = this.geo, g = this.graph;
    const naval = p.cls === 'ferry';
    // Anzahl Vertices vorab schätzen
    let pointCount = 0;
    const dens: Float32Array[] = [];
    for (const eid of p.edges) {
      const e = g.edges[eid];
      const src = e.geom;
      const out: number[] = [src[0], src[1]];
      for (let k = 2; k < src.length; k += 2) {
        const px = out[out.length - 2], pz = out[out.length - 1];
        const d = Math.hypot(src[k] - px, src[k + 1] - pz);
        const parts = Math.max(1, Math.ceil(d / DENSIFY_KM));
        for (let q = 1; q < parts; q++) out.push(px + ((src[k] - px) * q) / parts, pz + ((src[k + 1] - pz) * q) / parts);
        out.push(src[k], src[k + 1]);
      }
      const f = new Float32Array(out);
      dens.push(f);
      pointCount += f.length / 2;
    }
    const V = pointCount * 2;
    const pos = new Float32Array(V * 3), side = new Float32Array(V * 3), info = new Float32Array(V * 2);
    const index = new Uint32Array(Math.max(0, (pointCount - p.edges.length)) * 6);
    let v = 0, ii = 0;
    for (let n = 0; n < p.edges.length; n++) {
      const eid = p.edges[n], pts = dens[n], m = pts.length / 2;
      const v0 = v;
      let km = 0;
      for (let k = 0; k < m; k++) {
        const x = pts[k * 2], z = pts[k * 2 + 1];
        if (k > 0) km += Math.hypot(x - pts[k * 2 - 2], z - pts[k * 2 - 1]);
        // Tangente aus Nachbarn
        const ax = pts[Math.max(0, k - 1) * 2], az = pts[Math.max(0, k - 1) * 2 + 1];
        const bx = pts[Math.min(m - 1, k + 1) * 2], bz = pts[Math.min(m - 1, k + 1) * 2 + 1];
        let dx = bx - ax, dz = bz - az;
        const L = Math.hypot(dx, dz) || 1;
        dx /= L; dz /= L;
        const h = naval ? 0 : Math.max(0, terrainHeightKm(geo, x, z));
        const cl = this.closed.has(eid) ? 1 : 0;
        for (let s = 0; s < 2; s++) {
          pos[v * 3] = x; pos[v * 3 + 1] = h; pos[v * 3 + 2] = z;
          side[v * 3] = -dz; side[v * 3 + 1] = dx; side[v * 3 + 2] = s === 0 ? -1 : 1;
          info[v * 2] = km; info[v * 2 + 1] = cl;
          v++;
        }
        if (k > 0) {
          const a = v - 4, b = v - 3, c = v - 2, d = v - 1;
          index[ii++] = a; index[ii++] = b; index[ii++] = c;
          index[ii++] = b; index[ii++] = d; index[ii++] = c;
        }
      }
      p.ranges.set(eid, [v0, v - v0]);
    }
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    bg.setAttribute('aSide', new THREE.BufferAttribute(side, 3));
    const infoAttr = new THREE.BufferAttribute(info, 2);
    infoAttr.setUsage(THREE.DynamicDrawUsage);
    bg.setAttribute('aInfo', infoAttr);
    bg.setIndex(new THREE.BufferAttribute(index.subarray(0, ii), 1));
    bg.boundingSphere = new THREE.Sphere(new THREE.Vector3(geo.widthKm / 2, 0, geo.heightKm / 2), 1e5);
    bg.boundingBox = new THREE.Box3(new THREE.Vector3(-1e5, -1e5, -1e5), new THREE.Vector3(1e5, 1e5, 1e5));
    p.closedAttr = infoAttr;
    const mesh = new THREE.Mesh(bg, p.mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = p.cls === 'bridge' ? 3 : p.cls === 'ferry' ? 1 : 2;
    mesh.name = `Roads-${p.cls}`;
    p.mesh = mesh;
    this.object.add(mesh);
  }
}
