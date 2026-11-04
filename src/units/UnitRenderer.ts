/**
 * Phase 2 – Darstellung der Einheiten.
 *
 * - Prozedurale Low-Poly-Modelle (flach schattiert, Vertexfarben), je Modell ein InstancedMesh
 *   über alle Mitglieder aller Verbände dieses Modells. Pro Vertex ein "Paint"-Kanal:
 *   0 = feste Farbe (Ketten, Glas), 1 = Tarnfarbe (Instanzfarbe × Vertexfarbe), 2 = Teamfarbe.
 * - Strategischer Sichtmaßstab: Modelle werden mit dem Kameraabstand hochskaliert (bleiben lesbar).
 * - Fernansicht: NATO-Taktische Zeichen (Billboards aus einem Canvas-Atlas, Freund/Feind/Neutral).
 * - Auswahlringe am Boden + Zustands-/Treibstoffbalken über ausgewählten Einheiten.
 */
import * as THREE from 'three';
import type { Settings } from '../core/types';
import { blocOf, getProfile, getRelation } from '../game/countryData';
import type { GeoData } from '../world/GeoData';
import type { Unit, UnitTypeDef } from './types';
import type { UnitManager } from './UnitManager';
import { UNIT_TYPES } from './unitTypes';
import { buildModels, modelKeyFor, rotorGeometry, type ModelDef as ModelDefT } from './models';

// ---------------------------------------------------------------- Tuning
/** Sichtmaßstab = clamp(K · Kameraabstand, MIN, MAX) */
export const VIS_SCALE_K = 4;
export const VIS_SCALE_MIN = 3;
export const VIS_SCALE_MAX = 600;
/** Ab diesem Kameraabstand (km) NATO-Zeichen statt 3D-Modelle (± Hysterese) */
export const COUNTER_DISTANCE = 120;
const COUNTER_HYST = 0.08;
/** Zeichengröße (CSS-Pixel) */
const COUNTER_PX = 36;
const BAR_W = 30;
const BAR_H = 7;

type ModelDef = ModelDefT;

// ---------------------------------------------------------------- Farben

const CAMO: Record<string, number> = {
  DEU: 0x4c5536, FRA: 0x5a5f3c, GBR: 0x55593c, POL: 0x4f5a37, RUS: 0x4b5832, UKR: 0x56603f, TUR: 0x5c5a3e,
  ITA: 0x6a6243, ESP: 0x6b6447, NLD: 0x4a5238, SWE: 0x4e5a45, NOR: 0x4d5543, FIN: 0x58604c, ROU: 0x5a5c3b,
  GRC: 0x5d5c3e, BLR: 0x4f5a36, HUN: 0x55583a,
};
const DESERT = new Set(['TUR', 'ESP', 'GRC', 'CYP', 'SYR', 'IRQ', 'IRN', 'SAU', 'EGY', 'LBY', 'DZA', 'TUN', 'MAR', 'JOR', 'ISR']);
const AIR_GREY = 0x7a8189;
const NAVAL_GREY = 0x7e858b;
const HELI_GREEN = 0x4a4f3e;
/** gedämpfte Teamfarben für nicht spielbare Staaten (nach mapColor 1..9) */
const MAPCOLOR_TEAM = [0x8a8a8a, 0xb0604a, 0x5a8a4a, 0x4a6ea8, 0xb09a40, 0x8a5aa0, 0x4aa0a0, 0xa07040, 0x6a7a9a, 0xa04a6a];

interface OwnerColors {
  ground: THREE.Color;
  heli: THREE.Color;
  air: THREE.Color;
  naval: THREE.Color;
  team: THREE.Color;
}

// ---------------------------------------------------------------- NATO-Zeichen

type Sym =
  | 'inf' | 'mg' | 'at' | 'sniper' | 'medic' | 'eng' | 'mortar' | 'recon_w' | 'mech' | 'mech_w' | 'armor' | 'armor_l'
  | 'medic_v' | 'aid' | 'hospital' | 'art' | 'mlrs' | 'aa' | 'sam' | 'supply' | 'rotary' | 'rotary_t' | 'fixed' | 'bomber' | 'uav' | 'fpv' | 'surface' | 'sub';

const TYPE_SYMBOL: Record<string, Sym> = {
  inf_squad: 'inf', mg_team: 'mg', at_team: 'at', sniper_team: 'sniper', medic_team: 'medic', engineer_squad: 'eng',
  mortar_team: 'mortar', recon_wheeled: 'recon_w', ifv: 'mech', apc_wheeled: 'mech_w', light_tank: 'armor_l',
  mbt_medium: 'armor', mbt_heavy: 'armor', sp_artillery: 'art', mlrs: 'mlrs', spaa: 'aa', sam: 'sam', supply_truck: 'supply', tanker_truck: 'supply', aid_convoy: 'aid', field_hospital: 'hospital', ambulance: 'medic_v',
  attack_heli: 'rotary', transport_heli: 'rotary_t', fighter: 'fixed', bomber: 'bomber', recon_drone: 'uav', fpv_swarm: 'fpv',
  destroyer: 'surface', frigate: 'surface', submarine: 'sub',
};

function echelonOf(t: UnitTypeDef): string {
  switch (t.category) {
    case 'infantry':
      return t.memberCount >= 6 ? '•' : 'ø';
    case 'tank':
    case 'ifv':
    case 'recon':
      return '•••';
    case 'artillery':
    case 'aa':
      return t.memberCount >= 3 ? 'I' : '•';
    case 'helicopter':
    case 'jet':
      return '••';
    case 'drone':
      return t.memberCount > 1 ? '••' : '';
    default:
      return '';
  }
}

const ATLAS_CELLS = 16;
const CELL_PX = 64;
const AFFIL_FILL = ['#80c8ff', '#ff8a80', '#aaffaa'];
const AFFIL_SEL = ['#ffffff', '#ffff60', '#ffffff'];

function drawCounter(ctx: CanvasRenderingContext2D, ox: number, oy: number, t: UnitTypeDef, affil: number, sel: boolean): void {
  const cx = ox + 32, cy = oy + 38;
  ctx.save();
  ctx.lineJoin = 'round';
  // Rahmen-Pfad
  const frame = () => {
    ctx.beginPath();
    if (affil === 1) {
      ctx.moveTo(cx, cy - 22);
      ctx.lineTo(cx + 22, cy);
      ctx.lineTo(cx, cy + 22);
      ctx.lineTo(cx - 22, cy);
      ctx.closePath();
    } else if (affil === 2) ctx.rect(cx - 17, cy - 17, 34, 34);
    else ctx.rect(cx - 23, cy - 15, 46, 30);
  };
  // Innenmaß für Symbole
  const hw = affil === 1 ? 14 : affil === 2 ? 15 : 21;
  const hh = affil === 1 ? 10 : affil === 2 ? 15 : 13;
  if (sel) {
    frame();
    ctx.lineWidth = 8;
    ctx.strokeStyle = AFFIL_SEL[affil];
    ctx.stroke();
  }
  frame();
  ctx.fillStyle = AFFIL_FILL[affil];
  ctx.fill();
  ctx.save();
  frame();
  ctx.clip();
  ctx.strokeStyle = '#000';
  ctx.fillStyle = '#000';
  ctx.lineWidth = 2.2;
  const line = (x0: number, y0: number, x1: number, y1: number) => {
    ctx.beginPath();
    ctx.moveTo(cx + x0, cy + y0);
    ctx.lineTo(cx + x1, cy + y1);
    ctx.stroke();
  };
  const X = () => {
    line(-hw - 4, -hh - 4, hw + 4, hh + 4);
    line(-hw - 4, hh + 4, hw + 4, -hh - 4);
  };
  const oval = (w = hw * 0.7, h = hh * 0.55) => {
    ctx.beginPath();
    ctx.ellipse(cx, cy, w, h, 0, 0, Math.PI * 2);
    ctx.stroke();
  };
  const dot = (r = 4, dy = 0) => {
    ctx.beginPath();
    ctx.arc(cx, cy + dy, r, 0, Math.PI * 2);
    ctx.fill();
  };
  const wheels = () => {
    ctx.lineWidth = 1.6;
    for (const dx of [-6, 0, 6]) {
      ctx.beginPath();
      ctx.arc(cx + dx, cy + hh - 4, 2, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.lineWidth = 2.2;
  };
  const text = (s: string, size: number, dy = 0) => {
    ctx.font = `bold ${size}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(s, cx, cy + dy);
  };
  const dome = () => {
    ctx.beginPath();
    ctx.ellipse(cx, cy + hh + 2, hw * 0.95, hh * 0.9, 0, Math.PI, 0);
    ctx.stroke();
  };
  const sym = TYPE_SYMBOL[t.id] ?? 'inf';
  switch (sym) {
    case 'inf':
      X();
      break;
    case 'mg':
      X();
      text('MG', 9, hh - 4);
      break;
    case 'sniper':
      X();
      text('S', 10, -hh + 5);
      break;
    case 'at':
      line(-hw, hh, 0, -hh);
      line(0, -hh, hw, hh);
      break;
    case 'medic':
      ctx.lineWidth = 3;
      line(0, -hh + 3, 0, hh - 3);
      line(-hh + 3, 0, hh - 3, 0);
      break;
    case 'eng':
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(cx - 9, cy + 5);
      ctx.lineTo(cx - 9, cy - 5);
      ctx.lineTo(cx + 9, cy - 5);
      ctx.lineTo(cx + 9, cy + 5);
      ctx.moveTo(cx, cy - 5);
      ctx.lineTo(cx, cy + 5);
      ctx.stroke();
      break;
    case 'mortar':
      dot(3, 5);
      line(0, 2, 0, -hh + 3);
      line(-4, -hh + 7, 0, -hh + 3);
      line(4, -hh + 7, 0, -hh + 3);
      break;
    case 'recon_w':
      line(-hw - 4, hh + 4, hw + 4, -hh - 4);
      wheels();
      break;
    case 'mech':
      X();
      oval();
      break;
    case 'mech_w':
      X();
      oval();
      wheels();
      break;
    case 'armor':
      oval();
      break;
    case 'armor_l':
      oval(hw * 0.55, hh * 0.45);
      break;
    case 'art':
      oval();
      dot(4);
      break;
    case 'mlrs':
      dot(3.5, 3);
      line(0, -1, 0, -hh + 2);
      line(-5, -hh + 6, 0, -hh + 2);
      line(5, -hh + 6, 0, -hh + 2);
      wheels();
      break;
    case 'aa':
      dome();
      oval(hw * 0.5, hh * 0.35);
      break;
    case 'sam':
      dome();
      line(0, hh, 0, -hh + 3);
      line(-4, -hh + 7, 0, -hh + 3);
      line(4, -hh + 7, 0, -hh + 3);
      break;
    case 'supply':
      ctx.lineWidth = 3;
      line(-hw - 3, hh - 4, hw + 3, hh - 4);
      text('V', 12, -2);
      break;
    case 'medic_v':
      ctx.lineWidth = 3;
      line(0, -hh + 3, 0, hh - 5);
      line(-hh + 3, -2, hh - 3, -2);
      wheels();
      break;
    case 'aid':
      ctx.lineWidth = 3;
      line(-hw - 3, hh - 4, hw + 3, hh - 4);
      line(0, -hh + 2, 0, hh - 7);
      line(-6, -3, 6, -3);
      break;
    case 'hospital':
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(cx - 10, cy + 8);
      ctx.lineTo(cx, cy - 8);
      ctx.lineTo(cx + 10, cy + 8);
      ctx.stroke();
      ctx.lineWidth = 3;
      line(0, -3, 0, 7);
      line(-5, 2, 5, 2);
      break;
    case 'rotary':
    case 'rotary_t': {
      ctx.beginPath();
      ctx.moveTo(cx - hw + 2, cy - 7);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx - hw + 2, cy + 7);
      ctx.closePath();
      ctx.moveTo(cx + hw - 2, cy - 7);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx + hw - 2, cy + 7);
      ctx.closePath();
      if (sym === 'rotary') ctx.fill();
      else ctx.stroke();
      break;
    }
    case 'fixed':
    case 'bomber':
      ctx.beginPath();
      ctx.moveTo(cx - hw + 2, cy + 3);
      ctx.quadraticCurveTo(cx - 6, cy - 9, cx, cy + 2);
      ctx.quadraticCurveTo(cx + 6, cy - 9, cx + hw - 2, cy + 3);
      ctx.stroke();
      if (sym === 'bomber') text('B', 9, 7);
      break;
    case 'uav':
    case 'fpv':
      ctx.beginPath();
      ctx.moveTo(cx - hw + 3, cy - 6);
      ctx.lineTo(cx, cy + 4);
      ctx.lineTo(cx + hw - 3, cy - 6);
      ctx.lineTo(cx, cy - 1);
      ctx.closePath();
      ctx.fill();
      if (sym === 'fpv') text('FPV', 8, 9);
      break;
    case 'surface':
      ctx.beginPath();
      ctx.moveTo(cx - hw + 2, cy - 2);
      ctx.lineTo(cx + hw - 2, cy - 2);
      ctx.lineTo(cx + hw - 7, cy + 6);
      ctx.lineTo(cx - hw + 7, cy + 6);
      ctx.closePath();
      ctx.fill();
      line(0, -2, 0, -9);
      break;
    case 'sub':
      ctx.beginPath();
      ctx.ellipse(cx, cy + 2, hw - 3, 4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(cx - 4, cy - 6, 6, 5);
      break;
  }
  ctx.restore();
  // Rahmenlinie
  frame();
  ctx.lineWidth = 2.2;
  ctx.strokeStyle = '#000';
  ctx.stroke();
  // Größenkennzeichen
  const ech = echelonOf(t);
  if (ech) {
    ctx.fillStyle = sel ? AFFIL_SEL[affil] : '#000';
    ctx.font = 'bold 13px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const top = affil === 1 ? cy - 22 : affil === 2 ? cy - 17 : cy - 15;
    if (!sel) {
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = 3;
      ctx.strokeText(ech, cx, top + 1);
    }
    ctx.fillText(ech, cx, top + 1);
  }
  ctx.restore();
}

const COUNTER_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 iPos;
attribute float iCell;
attribute float iSel;
uniform vec2 uScreen;
uniform float uSize;
varying vec2 vUv;
varying float vSel;
void main() {
  vec4 clip = projectionMatrix * viewMatrix * vec4(iPos, 1.0);
  float s = uSize * (1.0 + iSel * 0.12);
  clip.xy += position.xy * s / uScreen * 2.0 * clip.w;
  gl_Position = clip;
  float cx = mod(iCell, ${ATLAS_CELLS.toFixed(1)});
  float cy = floor(iCell / ${ATLAS_CELLS.toFixed(1)});
  vUv = vec2((cx + uv.x) / ${ATLAS_CELLS.toFixed(1)}, 1.0 - (cy + 1.0 - uv.y) / ${ATLAS_CELLS.toFixed(1)});
  vSel = iSel;
  #include <logdepthbuf_vertex>
}
`;
const COUNTER_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D uAtlas;
uniform float uTime;
varying vec2 vUv;
varying float vSel;
void main() {
  vec4 c = texture2D(uAtlas, vUv);
  if (c.a < 0.35) discard;
  c.rgb *= 1.0 + vSel * 0.18 * (0.5 + 0.5 * sin(uTime * 6.0));
  gl_FragColor = vec4(c.rgb, 1.0);
  #include <logdepthbuf_fragment>
}
`;

const BAR_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 iPos;
attribute vec2 iVal;
attribute float iOff;
uniform vec2 uScreen;
uniform vec2 uSize;
varying vec2 vUv;
varying vec2 vVal;
void main() {
  vec4 clip = projectionMatrix * viewMatrix * vec4(iPos, 1.0);
  vec2 px = position.xy * uSize + vec2(0.0, iOff);
  clip.xy += px / uScreen * 2.0 * clip.w;
  gl_Position = clip;
  vUv = uv;
  vVal = iVal;
  #include <logdepthbuf_vertex>
}
`;
const BAR_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec2 uSize;
varying vec2 vUv;
varying vec2 vVal;
void main() {
  vec2 p = vUv * uSize;
  vec3 col = vec3(0.06);
  bool border = p.x < 1.0 || p.y < 1.0 || p.x > uSize.x - 1.0 || p.y > uSize.y - 1.0 || abs(p.y - uSize.y * 0.45) < 0.5;
  if (!border) {
    if (vUv.y > 0.45) {
      if (vUv.x < vVal.x) col = mix(vec3(0.85, 0.15, 0.1), vec3(0.25, 0.85, 0.25), smoothstep(0.2, 0.8, vVal.x));
      else col = vec3(0.18, 0.05, 0.05);
    } else {
      col = vUv.x < vVal.y ? vec3(0.9, 0.65, 0.15) : vec3(0.15, 0.1, 0.03);
    }
  }
  gl_FragColor = vec4(col, 1.0);
  #include <logdepthbuf_fragment>
}
`;

// ---------------------------------------------------------------- Renderer

interface ModelSlot {
  def: ModelDef;
  mesh: THREE.InstancedMesh;
  team: THREE.InstancedBufferAttribute;
  cap: number;
  count: number;
  /** benötigte Kapazität (Vorlauf) */
  need: number;
}

interface UnitVis {
  /** aktuelle Mitglieder-Offsets (m, lokal: x rechts, z hinten) */
  off: Float32Array;
  init: boolean;
  pitch: number;
  roll: number;
  lastHeading: number;
  seen: number;
  /** Phase 3: weiche Haltung der Infanterie 0 = stehen, 1 = kauern, 2 = liegen */
  post: number;
}

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _cam = new THREE.Vector3();
const _sphere = new THREE.Sphere();
const _frustum = new THREE.Frustum();
const _pv = new THREE.Matrix4();
const _xAxis = new THREE.Vector3(1, 0, 0);
const _yAxis = new THREE.Vector3(0, 1, 0);
const _qTail = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
const _tmpOff = new Float32Array(64);
const _ringColor = new THREE.Color();

export class UnitRenderer {
  readonly object: THREE.Object3D;

  private readonly manager: UnitManager;
  private readonly geo: GeoData;
  private exag: number;
  private readonly models: Record<string, ModelDef>;
  private readonly slots = new Map<string, ModelSlot>();
  private readonly rotorSlot: ModelSlot;
  private readonly material: THREE.MeshLambertMaterial;
  private readonly vis = new Map<number, UnitVis>();
  private readonly ownerColors = new Map<string, OwnerColors>();
  private readonly affilCache = new Map<string, number>();
  private affilPlayer: string | null = '\u0000';
  private readonly typeIndex = new Map<string, number>();

  // Zeichen
  private readonly counterGeom: THREE.InstancedBufferGeometry;
  private readonly counterMat: THREE.ShaderMaterial;
  private readonly counterMesh: THREE.Mesh;
  private counterPos = new Float32Array(0);
  private counterCell = new Float32Array(0);
  private counterSel = new Float32Array(0);
  private counterCap = 0;

  // Balken
  private readonly barGeom: THREE.InstancedBufferGeometry;
  private readonly barMat: THREE.ShaderMaterial;
  private readonly barMesh: THREE.Mesh;
  private barPos = new Float32Array(0);
  private barVal = new Float32Array(0);
  private barOff = new Float32Array(0);
  private barCap = 0;

  // Auswahlringe
  private ringMesh: THREE.InstancedMesh;
  private ringCap = 0;
  private readonly ringGeom: THREE.BufferGeometry;
  private readonly ringMat: THREE.MeshBasicMaterial;

  private counterMode = false;
  private visScale = VIS_SCALE_MIN;
  private pxKm = 0.01;
  private camDist = 100;
  private lastTime = 0;
  private frameNo = 0;

  constructor(manager: UnitManager, geo: GeoData, settings: Settings) {
    this.manager = manager;
    this.geo = geo;
    this.exag = settings.heightExaggeration;
    Object.keys(UNIT_TYPES).forEach((id, i) => this.typeIndex.set(id, i));

    const group = new THREE.Group();
    group.name = 'Units';
    this.object = group;

    // Material mit Paint-Kanal (Tarn-/Teamfarbe je Instanz)
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    this.material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aPaint;\nattribute vec3 aTeam;')
        .replace(
          '#include <color_vertex>',
          `#include <color_vertex>
#ifdef USE_INSTANCING_COLOR
  vColor.rgb = color.rgb * mix(vec3(1.0), instanceColor.rgb, step(0.5, aPaint));
  if (aPaint > 1.5) vColor.rgb = color.rgb * aTeam;
#endif`,
        );
    };
    this.material.customProgramCacheKey = () => 'unit-paint-v1';

    this.models = buildModels();
    for (const key of Object.keys(this.models)) {
      const slot = this.makeSlot(this.models[key], 16);
      this.slots.set(key, slot);
      group.add(slot.mesh);
    }
    this.rotorSlot = this.makeSlot({ geom: rotorGeometry(), size: 1, boost: 1, livery: 'air', tilt: false }, 16);
    group.add(this.rotorSlot.mesh);

    // NATO-Zeichen
    const atlas = this.buildAtlas();
    const quad = new THREE.PlaneGeometry(1, 1);
    this.counterGeom = new THREE.InstancedBufferGeometry();
    this.counterGeom.index = quad.index;
    this.counterGeom.setAttribute('position', quad.getAttribute('position'));
    this.counterGeom.setAttribute('uv', quad.getAttribute('uv'));
    this.counterMat = new THREE.ShaderMaterial({
      vertexShader: COUNTER_VERT,
      fragmentShader: COUNTER_FRAG,
      uniforms: {
        uAtlas: { value: atlas },
        uScreen: { value: new THREE.Vector2(1, 1) },
        uSize: { value: COUNTER_PX },
        uTime: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
      fog: false,
    });
    this.counterMesh = new THREE.Mesh(this.counterGeom, this.counterMat);
    this.counterMesh.frustumCulled = false;
    this.counterMesh.renderOrder = 40;
    this.counterMesh.name = 'UnitCounters';
    group.add(this.counterMesh);

    this.barGeom = new THREE.InstancedBufferGeometry();
    const bq = new THREE.PlaneGeometry(1, 1);
    this.barGeom.index = bq.index;
    this.barGeom.setAttribute('position', bq.getAttribute('position'));
    this.barGeom.setAttribute('uv', bq.getAttribute('uv'));
    this.barMat = new THREE.ShaderMaterial({
      vertexShader: BAR_VERT,
      fragmentShader: BAR_FRAG,
      uniforms: { uScreen: { value: new THREE.Vector2(1, 1) }, uSize: { value: new THREE.Vector2(BAR_W, BAR_H) } },
      depthTest: false,
      depthWrite: false,
      fog: false,
    });
    this.barMesh = new THREE.Mesh(this.barGeom, this.barMat);
    this.barMesh.frustumCulled = false;
    this.barMesh.renderOrder = 41;
    this.barMesh.name = 'UnitBars';
    group.add(this.barMesh);

    // Auswahlringe
    this.ringGeom = new THREE.RingGeometry(0.9, 1.0, 40, 1);
    this.ringGeom.rotateX(-Math.PI / 2);
    this.ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false, fog: false });
    this.ringMesh = this.makeRingMesh(32);
    group.add(this.ringMesh);
  }

  // ------------------------------------------------------------ öffentliche API

  applySettings(s: Settings): void {
    this.exag = s.heightExaggeration;
  }

  /** Welt-Radius (km), den eine Einheit beim aktuellen Zoom optisch abdeckt (für Picking) */
  visualRadiusKm(u: Unit): number {
    if (this.counterMode) return (COUNTER_PX * 0.5) * this.pxKm;
    const def = this.models[this.keyOf(u)];
    if (!def) return 0.05 * this.visScale;
    return Math.max(this.unitRadius(def, u.type.memberCount), 10 * this.pxKm);
  }

  /** zuletzt ermittelter Kameraabstand zum Boden (km) */
  get cameraDistanceKm(): number {
    return this.camDist;
  }

  /** aktueller Sichtmaßstab der Modelle (×) */
  get visualScale(): number {
    return this.visScale;
  }

  /** true = Fernansicht mit NATO-Zeichen */
  get showingCounters(): boolean {
    return this.counterMode;
  }

  update(camera: THREE.PerspectiveCamera, timeSec: number, playerA3: string | null): void {
    const dt = clamp(timeSec - this.lastTime, 0, 0.1);
    this.lastTime = timeSec;
    this.frameNo++;
    if (playerA3 !== this.affilPlayer) {
      this.affilPlayer = playerA3;
      this.affilCache.clear();
    }

    // --- Kameraabstand (Blickstrahl bis Bodenebene)
    camera.updateMatrixWorld();
    _cam.setFromMatrixPosition(camera.matrixWorld);
    camera.getWorldDirection(_dir);
    const gy = Math.max(0, this.geo.heightAt(_cam.x, _cam.z)) * this.exag;
    const dist = _dir.y < -0.05 ? Math.max(0.5, (_cam.y - gy * 0.5) / -_dir.y) : Math.max(0.5, _cam.y);
    this.camDist = dist;
    const thr = COUNTER_DISTANCE * (this.counterMode ? 1 - COUNTER_HYST : 1 + COUNTER_HYST);
    this.counterMode = dist > thr;
    const s = clamp(VIS_SCALE_K * dist, VIS_SCALE_MIN, VIS_SCALE_MAX);
    this.visScale = s;
    const screenW = window.innerWidth || 1, screenH = window.innerHeight || 1;
    this.pxKm = (dist * 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / screenH;
    (this.counterMat.uniforms.uScreen.value as THREE.Vector2).set(screenW, screenH);
    (this.barMat.uniforms.uScreen.value as THREE.Vector2).set(screenW, screenH);
    this.counterMat.uniforms.uTime.value = timeSec;

    _pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pv);

    const units = this.manager.units;
    const n = units.length;

    // --- Kapazitäten
    for (const slot of this.slots.values()) {
      slot.count = 0;
      slot.need = 0;
    }
    this.rotorSlot.count = 0;
    this.rotorSlot.need = 0;
    if (!this.counterMode) {
      for (let i = 0; i < n; i++) {
        const u = units[i];
        const slot = this.slots.get(this.keyOf(u));
        if (!slot) continue;
        slot.need += u.type.memberCount;
        if (slot.def.rotors) this.rotorSlot.need += u.type.memberCount * slot.def.rotors.length;
      }
      for (const [key, slot] of this.slots) if (slot.need > slot.cap) this.growSlot(key, slot);
      if (this.rotorSlot.need > this.rotorSlot.cap) this.growRotor();
    }
    if (n > this.counterCap) this.growCounters(n);
    if (n > this.barCap) this.growBars(n);
    if (n > this.ringCap) this.growRings(n);

    let nCounters = 0, nBars = 0, nRings = 0;
    const smooth = 1 - Math.exp(-dt * 3);
    const maxDist = dist * 5 + 20;

    for (let i = 0; i < n; i++) {
      const u = units[i];
      const def = this.models[this.keyOf(u)];
      const domain = u.type.mobility.domain;
      const ground = domain === 'naval' ? 0 : Math.max(0, this.geo.heightAt(u.x, u.z)) * this.exag;
      let uy = u.y;
      if (domain === 'air') {
        // Flughöhe in Nahansicht stauchen, damit Luftfahrzeuge im Bild bleiben
        const alt = Math.max(0, u.y - ground);
        uy = ground + Math.min(alt, 0.15 * dist + 0.03);
        if (u.airborne && u.type.category !== 'jet') uy += Math.sin(timeSec * 1.7 + u.id) * 0.004 * s;
      }
      const radius = this.counterMode ? COUNTER_PX * this.pxKm : def ? this.unitRadius(def, u.type.memberCount) : 0.1;
      _sphere.center.set(u.x, uy, u.z);
      _sphere.radius = radius + (uy - ground);
      if (!_frustum.intersectsSphere(_sphere)) continue;
      if (!this.counterMode && _cam.distanceTo(_sphere.center) > maxDist) continue;

      const affil = this.affiliation(u.owner, playerA3);
      if (this.counterMode) {
        const k = nCounters * 3;
        this.counterPos[k] = u.x;
        this.counterPos[k + 1] = uy + 0.002 * dist;
        this.counterPos[k + 2] = u.z;
        const ti = this.typeIndex.get(u.type.id) ?? 0;
        this.counterCell[nCounters] = (ti * 3 + affil) * 2 + (u.selected ? 1 : 0);
        this.counterSel[nCounters] = u.selected ? 1 : 0;
        nCounters++;
      } else if (def) {
        this.drawUnit(u, def, uy, s, dt, smooth, timeSec);
      }

      if (u.selected) {
        // Ring
        const rr = this.counterMode ? COUNTER_PX * 0.62 * this.pxKm : Math.min(Math.max(radius * 0.45, 12 * this.pxKm), 30 * this.pxKm);
        _p.set(u.x, ground + 0.001 * dist, u.z);
        _s.set(rr, 1, rr);
        _m.compose(_p, _q.identity(), _s);
        this.ringMesh.setMatrixAt(nRings, _m);
        _ringColor.setHex(affil === 0 ? 0x66ff66 : affil === 1 ? 0xff5040 : 0xffe060);
        this.ringMesh.setColorAt(nRings, _ringColor);
        nRings++;
        // Balken
        const b = nBars * 3;
        this.barPos[b] = u.x;
        this.barPos[b + 1] = uy;
        this.barPos[b + 2] = u.z;
        this.barVal[nBars * 2] = clamp(u.hp / u.type.hp, 0, 1);
        this.barVal[nBars * 2 + 1] = Number.isFinite(u.type.fuelKm) ? clamp(u.fuel / u.type.fuelKm, 0, 1) : 1;
        this.barOff[nBars] = this.counterMode ? COUNTER_PX * 0.62 + 6 : Math.max(18, (radius / this.pxKm) * 0.8 + 8);
        nBars++;
      }
    }

    for (const slot of this.slots.values()) this.finishSlot(slot);
    this.finishSlot(this.rotorSlot);

    this.counterGeom.instanceCount = nCounters;
    this.counterMesh.visible = nCounters > 0;
    if (nCounters) {
      this.markDirty(this.counterGeom, 'iPos', nCounters * 3);
      this.markDirty(this.counterGeom, 'iCell', nCounters);
      this.markDirty(this.counterGeom, 'iSel', nCounters);
    }
    this.barGeom.instanceCount = nBars;
    this.barMesh.visible = nBars > 0;
    if (nBars) {
      this.markDirty(this.barGeom, 'iPos', nBars * 3);
      this.markDirty(this.barGeom, 'iVal', nBars * 2);
      this.markDirty(this.barGeom, 'iOff', nBars);
    }
    this.ringMesh.count = nRings;
    this.ringMesh.visible = nRings > 0;
    if (nRings) {
      this.ringMesh.instanceMatrix.needsUpdate = true;
      if (this.ringMesh.instanceColor) this.ringMesh.instanceColor.needsUpdate = true;
    }

    // Aufräumen verwaister Darstellungszustände
    if (this.frameNo % 120 === 0 && this.vis.size > n) {
      for (const [id, v] of this.vis) if (this.frameNo - v.seen > 120 && !this.manager.get(id)) this.vis.delete(id);
    }
  }

  // ------------------------------------------------------------ intern

  private readonly keyCache = new Map<UnitTypeDef, Map<string, string>>();
  /** Modell-Slot-Schlüssel (Variante je Typ/Besitzerland) */
  private keyOf(u: Unit): string {
    let m = this.keyCache.get(u.type);
    if (!m) this.keyCache.set(u.type, (m = new Map()));
    let k = m.get(u.owner);
    if (k === undefined) m.set(u.owner, (k = modelKeyFor(u.type.model, u.type.id, u.owner)));
    return k;
  }

  private unitRadius(def: ModelDef, members: number): number {
    const sp = this.memberSpacing(def);
    return this.visScale * 0.001 * (def.size * def.boost * 0.6 + sp * Math.sqrt(members) * 0.9);
  }

  private memberSpacing(def: ModelDef): number {
    return Math.max(def.size * def.boost * 1.7, 2.5);
  }

  /** Mitglieder eines Verbands in die Instanzpuffer schreiben */
  private drawUnit(u: Unit, def: ModelDef, uy: number, s: number, dt: number, smooth: number, time: number): void {
    // Phase 3: besetzte Gebäude -> unsichtbar
    if (u.garrisonId) return;
    const slot = this.slots.get(this.keyOf(u))!;
    // Phase 3: gefallene Soldaten nicht zeichnen (membersAlive, falls vom CombatSystem gesetzt)
    const nAll = Math.min(u.type.memberCount, 32);
    const n = Math.max(0, Math.min(nAll, Math.ceil(u.membersAlive ?? nAll)));
    let v = this.vis.get(u.id);
    if (!v) {
      v = { off: new Float32Array(nAll * 2), init: false, pitch: 0, roll: 0, lastHeading: u.heading, seen: 0, post: 0 };
      this.vis.set(u.id, v);
    }
    v.seen = this.frameNo;
    const sp = this.memberSpacing(def);
    const domain = u.type.mobility.domain;
    const moving = u.speedKmh > 0.5;
    const cat = u.type.category;

    // Phase 3: Deckungslinie (nur Infanterie, stehend)
    const coverLine = cat === 'infantry' && !!u.coverId && u.coverDirX !== undefined && u.coverDirZ !== undefined;
    const cdx = u.coverDirX ?? 0, cdz = u.coverDirZ ?? 0;
    // --- Ziel-Layout (m, lokal: x rechts, z nach hinten)
    const t = _tmpOff;
    for (let i = 0; i < n; i++) {
      let ox = 0, oz = 0;
      if (domain === 'air') {
        // gestaffelte Rotte/Schwarm
        const side = i % 2 === 1 ? 1 : -1;
        const k = Math.ceil(i / 2);
        ox = side * k * sp * 0.9;
        oz = k * sp * 0.7;
        if (cat === 'drone' && n > 2) {
          ox = (jit(u.id, i, 1)) * sp * 2.2;
          oz = (jit(u.id, i, 2)) * sp * 2.2;
        }
      } else if (domain === 'naval') {
        oz = i * sp * 1.4;
      } else if (coverLine && !moving) {
        // Phase 3: Mitglieder in Reihe entlang der Deckungslinie (quer zur Schutzrichtung), 2. Reihe leicht dahinter
        const perRow = Math.max(1, Math.min(n, 5));
        const row = Math.floor(i / perRow), col = i % perRow;
        const inRow = Math.min(perRow, n - row * perRow);
        const lat = (col - (inRow - 1) / 2) * sp * (u.posture === 'prone' ? 1.1 : 0.95);
        const back = row * sp * 0.9;
        // Welt-Vektoren (lat = (-dirZ, dirX), zurück = -dir) in lokale Koordinaten (rechts = (ch,sh), hinten = (-sh,ch))
        const wx = -cdz * lat - cdx * back, wz = cdx * lat - cdz * back;
        ox = wx * Math.cos(u.heading) + wz * Math.sin(u.heading);
        oz = -wx * Math.sin(u.heading) + wz * Math.cos(u.heading);
      } else if (moving && u.onRoad) {
        oz = i * sp * 1.25; // Kolonne
      } else if (moving) {
        const k = Math.ceil(i / 2);
        ox = (i === 0 ? 0 : i % 2 === 1 ? -1 : 1) * k * sp * 0.9;
        oz = k * sp * 0.8;
      } else {
        const cols = Math.max(1, Math.ceil(Math.sqrt(n * 2)));
        const row = Math.floor(i / cols), col = i % cols;
        const inRow = Math.min(cols, n - row * cols);
        const spread = cat === 'infantry' ? 1.2 : 1.35;
        ox = (col - (inRow - 1) / 2) * sp * spread + jit(u.id, i, 3) * sp * 0.5;
        oz = row * sp * 1.1 + jit(u.id, i, 4) * sp * 0.4;
      }
      t[i * 2] = ox;
      t[i * 2 + 1] = oz;
    }
    const off = v.off;
    if (!v.init) {
      for (let i = 0; i < n * 2; i++) off[i] = t[i];
      v.init = true;
    } else {
      for (let i = 0; i < n * 2; i++) off[i] += (t[i] - off[i]) * smooth;
    }

    // --- Neigung (Hang) / Querlage (Kurvenflug)
    const h = u.heading;
    const sh = Math.sin(h), ch = Math.cos(h);
    const ws = s * 0.001; // m -> km inkl. Sichtmaßstab
    if (def.tilt && domain === 'ground') {
      const half = Math.max(def.size * def.boost * ws * 0.5, 0.01);
      const hf = Math.max(0, this.geo.heightAt(u.x + sh * half, u.z - ch * half)) * this.exag;
      const hb = Math.max(0, this.geo.heightAt(u.x - sh * half, u.z + ch * half)) * this.exag;
      const target = clamp(Math.atan2(hf - hb, 2 * half), -0.35, 0.35);
      v.pitch += (target - v.pitch) * smooth;
    } else v.pitch = 0;
    if (cat === 'jet' || (cat === 'drone' && u.type.model === 'drone_fixed')) {
      const dh = wrap(h - v.lastHeading);
      const rate = dt > 0 ? dh / dt : 0;
      v.roll += (clamp(-rate * 0.6, -0.7, 0.7) - v.roll) * smooth;
    } else if (cat === 'helicopter') {
      v.pitch += ((moving ? -0.12 : 0) - v.pitch) * smooth; // Nase runter im Vorwärtsflug
    }
    v.lastHeading = h;

    const col = this.colorsFor(u.owner);
    const camo = def.livery === 'air' ? col.air : def.livery === 'naval' ? col.naval : def.livery === 'heli' ? col.heli : col.ground;
    const ic = slot.mesh.instanceColor!.array as Float32Array;
    const tc = slot.team.array as Float32Array;
    const scale = ws * def.boost;
    const isGround = domain === 'ground';
    // Phase 3: Haltung (Soldaten): stehen / kauern (~0.65 Höhe, vorgebeugt) / liegen (flach, nach vorn gekippt).
    // Bewegte Einheiten stehen immer (außer festgenagelt/Sprung).
    let postT = 0;
    if (cat === 'infantry' || u.type.model === 'soldier') {
      const pst = u.posture ?? 'stand';
      postT = moving && !u.pinned ? 0 : pst === 'prone' ? 2 : pst === 'crouch' ? 1 : 0;
    }
    v.post += (postT - v.post) * smooth;
    const pz = v.post;
    const lean = pz <= 1 ? pz * 0.3 : 0.3 + (pz - 1) * 1.15; // rad nach vorn (Kopf Richtung -z)
    const sy = pz <= 1 ? 1 - pz * 0.32 : 0.68 + (pz - 1) * 0.22; // Höhenskala
    const sz = pz > 1 ? 1 + (pz - 1) * 0.15 : 1; // liegend etwas gestreckt
    // Vault: kleiner Hüpfer (0.6 s)
    const vt = u.vaultT ?? 0;
    const hop = vt > 0 ? Math.sin(Math.PI * (1 - vt / 0.6)) * 0.9 * ws : 0;
    // In Deckung (stehend) schauen die Soldaten zur Bedrohung (= Schutzrichtung der Deckung)
    const coverYaw = coverLine && !moving ? Math.atan2(cdx, -cdz) : NaN;
    const airborne = !!u.airborne;
    for (let i = 0; i < n; i++) {
      if (slot.count >= slot.cap) break;
      const ox = off[i * 2] * ws, oz = off[i * 2 + 1] * ws;
      // lokal -> Welt (x rechts, z hinten): rechts = (cos h, sin h), hinten = (−sin h, cos h)
      const wx = u.x + ox * ch - oz * sh;
      const wz = u.z + ox * sh + oz * ch;
      let wy = uy;
      if (isGround) wy = Math.max(0, this.geo.heightAt(wx, wz)) * this.exag;
      const yawJ = !moving && isGround ? jit(u.id, i, 5) * (cat === 'infantry' ? 1.2 : 0.25) : 0;
      const yawBase = coverYaw === coverYaw ? coverYaw : h;
      _e.set(v.pitch, -yawBase + yawJ, v.roll);
      _q.setFromEuler(_e);
      if (lean > 0.001) {
        // Haltung: Kippung um die lokale X-Achse (nach dem Gieren)
        _q2.setFromAxisAngle(_xAxis, -lean);
        _q.multiply(_q2);
      }
      _p.set(wx, wy + hop, wz);
      if (pz > 0.001) _s.set(scale, scale * sy, scale * sz);
      else _s.setScalar(scale);
      _m.compose(_p, _q, _s);
      const k = slot.count;
      slot.mesh.setMatrixAt(k, _m);
      ic[k * 3] = camo.r;
      ic[k * 3 + 1] = camo.g;
      ic[k * 3 + 2] = camo.b;
      tc[k * 3] = col.team.r;
      tc[k * 3 + 1] = col.team.g;
      tc[k * 3 + 2] = col.team.b;
      slot.count++;

      if (def.rotors) {
        const rs = this.rotorSlot;
        const ric = rs.mesh.instanceColor!.array as Float32Array;
        for (let r = 0; r < def.rotors.length; r++) {
          if (rs.count >= rs.cap) break;
          const [rx, ry, rz, rad, axis] = def.rotors[r];
          const tail = axis === 'x';
          const spin = airborne ? time * (def.size < 2 ? 60 : tail ? 40 : 22) * (r % 2 === 0 ? 1 : -1) : (u.id * 0.7 + i + r) % 3;
          _q2.setFromAxisAngle(_yAxis, spin);
          if (tail) _q2.premultiply(_qTail); // Scheibe senkrecht (Normale = x)
          _m2.compose(_p.set(rx, ry, rz), _q2, _s.set(rad, 1, rad));
          _m2.premultiply(_m);
          rs.mesh.setMatrixAt(rs.count, _m2);
          ric[rs.count * 3] = 1;
          ric[rs.count * 3 + 1] = 1;
          ric[rs.count * 3 + 2] = 1;
          rs.count++;
        }
      }
    }
  }

  private finishSlot(slot: ModelSlot): void {
    slot.mesh.count = slot.count;
    slot.mesh.visible = slot.count > 0;
    if (slot.count) {
      slot.mesh.instanceMatrix.clearUpdateRanges();
      slot.mesh.instanceMatrix.addUpdateRange(0, slot.count * 16);
      slot.mesh.instanceMatrix.needsUpdate = true;
      const ic = slot.mesh.instanceColor!;
      ic.clearUpdateRanges();
      ic.addUpdateRange(0, slot.count * 3);
      ic.needsUpdate = true;
      slot.team.clearUpdateRanges();
      slot.team.addUpdateRange(0, slot.count * 3);
      slot.team.needsUpdate = true;
    }
  }

  private markDirty(g: THREE.BufferGeometry, name: string, len: number): void {
    const a = g.getAttribute(name) as THREE.InstancedBufferAttribute;
    a.clearUpdateRanges();
    a.addUpdateRange(0, len);
    a.needsUpdate = true;
  }

  private makeSlot(def: ModelDef, cap: number): ModelSlot {
    const team = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    team.setUsage(THREE.DynamicDrawUsage);
    def.geom.setAttribute('aTeam', team);
    const mesh = new THREE.InstancedMesh(def.geom, this.material, cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.visible = false;
    return { def, mesh, team, cap, count: 0, need: 0 };
  }

  private growSlot(key: string, slot: ModelSlot): void {
    const cap = Math.max(slot.need, slot.cap * 2);
    const fresh = this.makeSlot(slot.def, cap);
    fresh.mesh.name = `Unit_${key}`;
    this.object.remove(slot.mesh);
    slot.mesh.dispose();
    this.object.add(fresh.mesh);
    slot.mesh = fresh.mesh;
    slot.team = fresh.team;
    slot.cap = cap;
  }

  private growRotor(): void {
    const slot = this.rotorSlot;
    const cap = Math.max(slot.need, slot.cap * 2);
    const fresh = this.makeSlot(slot.def, cap);
    this.object.remove(slot.mesh);
    slot.mesh.dispose();
    this.object.add(fresh.mesh);
    slot.mesh = fresh.mesh;
    slot.team = fresh.team;
    slot.cap = cap;
  }

  private growCounters(n: number): void {
    const cap = Math.max(n, this.counterCap * 2, 64);
    this.counterCap = cap;
    this.counterPos = new Float32Array(cap * 3);
    this.counterCell = new Float32Array(cap);
    this.counterSel = new Float32Array(cap);
    this.counterGeom.setAttribute('iPos', new THREE.InstancedBufferAttribute(this.counterPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.counterGeom.setAttribute('iCell', new THREE.InstancedBufferAttribute(this.counterCell, 1).setUsage(THREE.DynamicDrawUsage));
    this.counterGeom.setAttribute('iSel', new THREE.InstancedBufferAttribute(this.counterSel, 1).setUsage(THREE.DynamicDrawUsage));
  }

  private growBars(n: number): void {
    const cap = Math.max(n, this.barCap * 2, 64);
    this.barCap = cap;
    this.barPos = new Float32Array(cap * 3);
    this.barVal = new Float32Array(cap * 2);
    this.barOff = new Float32Array(cap);
    this.barGeom.setAttribute('iPos', new THREE.InstancedBufferAttribute(this.barPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.barGeom.setAttribute('iVal', new THREE.InstancedBufferAttribute(this.barVal, 2).setUsage(THREE.DynamicDrawUsage));
    this.barGeom.setAttribute('iOff', new THREE.InstancedBufferAttribute(this.barOff, 1).setUsage(THREE.DynamicDrawUsage));
  }

  private makeRingMesh(cap: number): THREE.InstancedMesh {
    const m = new THREE.InstancedMesh(this.ringGeom, this.ringMat, cap);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    m.frustumCulled = false;
    m.renderOrder = 39;
    m.count = 0;
    m.name = 'UnitSelectionRings';
    this.ringCap = cap;
    return m;
  }

  private growRings(n: number): void {
    const fresh = this.makeRingMesh(Math.max(n, this.ringCap * 2));
    this.object.remove(this.ringMesh);
    this.ringMesh.dispose();
    this.ringMesh = fresh;
    this.object.add(fresh);
  }

  /** 0 = Freund (blau), 1 = Feind/sonstige (rot), 2 = neutral (grün) */
  private affiliation(owner: string, player: string | null): number {
    let a = this.affilCache.get(owner);
    if (a !== undefined) return a;
    if (!player) a = 2;
    else if (owner === player) a = 0;
    else {
      const allies = getProfile(player)?.allies ?? [];
      const rel = getRelation(player, owner);
      const bp = blocOf(player), bo = blocOf(owner);
      if (allies.includes(owner) || rel >= 60 || (bp !== 'NEUTRAL' && bp === bo && rel >= 20)) a = 0;
      else if (rel < 0) a = 1;
      else a = 2;
    }
    this.affilCache.set(owner, a);
    return a;
  }

  private colorsFor(owner: string): OwnerColors {
    let c = this.ownerColors.get(owner);
    if (c) return c;
    const prof = getProfile(owner);
    const meta = this.geo.countriesByA3.get(owner);
    const team = new THREE.Color();
    if (prof) team.setStyle(prof.color);
    else team.setHex(MAPCOLOR_TEAM[(meta?.mapColor ?? 0) % MAPCOLOR_TEAM.length]);
    const groundHex = CAMO[owner] ?? (DESERT.has(owner) ? 0x8a7a55 : 0x555a3c);
    c = {
      ground: new THREE.Color(groundHex).multiplyScalar(1.7),
      heli: new THREE.Color(DESERT.has(owner) ? 0x7a7458 : HELI_GREEN).multiplyScalar(1.6),
      air: new THREE.Color(AIR_GREY).multiplyScalar(1.3),
      naval: new THREE.Color(NAVAL_GREY).multiplyScalar(1.3),
      team,
    };
    this.ownerColors.set(owner, c);
    return c;
  }

  private buildAtlas(): THREE.Texture {
    const size = ATLAS_CELLS * CELL_PX;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, size, size);
    const ids = Object.keys(UNIT_TYPES);
    ids.forEach((id, ti) => {
      for (let affil = 0; affil < 3; affil++) {
        for (let sel = 0; sel < 2; sel++) {
          const cell = (ti * 3 + affil) * 2 + sel;
          if (cell >= ATLAS_CELLS * ATLAS_CELLS) continue;
          const ox = (cell % ATLAS_CELLS) * CELL_PX, oy = Math.floor(cell / ATLAS_CELLS) * CELL_PX;
          drawCounter(ctx, ox, oy, UNIT_TYPES[id], affil, sel === 1);
        }
      }
    });
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 1;
    return tex;
  }
}

function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}
function wrap(a: number): number {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}
/** deterministischer Jitter -0.5..0.5 je (Unit, Mitglied, Kanal) */
function jit(id: number, i: number, salt: number): number {
  let t = Math.imul(id * 31 + i * 7919 + salt * 104729, 0x27d4eb2d) >>> 0;
  t = Math.imul(t ^ (t >>> 15), 0x2c1b3c6d) >>> 0;
  return ((t ^ (t >>> 13)) >>> 0) / 4294967296 - 0.5;
}
