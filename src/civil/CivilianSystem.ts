import * as THREE from 'three';
import { bus } from '../core/EventBus';
import type { Settings } from '../core/types';
import type { GeoData } from '../world/GeoData';
import type { Cities } from '../world/Cities';
import type { UnitManager } from '../units/UnitManager';
import type { NavGraph } from '../nav/NavGraph';
import type { MobilityProfile, Route } from '../nav/types';
import { OFFROAD_CLASS, ROAD_CLASSES } from '../nav/types';
import { getRelation } from '../game/countryData';
import type { Unit } from '../units/types';
import type { BuildingInfo } from '../combat/types';
import type { CasualtyCause, CivilCity, InfraInfo, InfraKind } from './types';
import { generateInfra, cityRadiusKm, rngFrom } from './infra';
import { terrainHeightKm } from '../world/Cities';
import { buildCivilGeometries, BUS_COLORS, CAR_COLORS, CLOTH_COLORS, INFRA_HEIGHT_M, INFRA_KINDS, TRUCK_COLORS, type VehicleModel } from './CivilModels';

/** Wegfindung (strukturell = Pathfinder) */
export interface RouteLike {
  findRoute(fx: number, fz: number, tx: number, tz: number, mob: MobilityProfile): Route | null;
}

export interface CivilianDeps {
  geo: GeoData;
  units: UnitManager;
  graph: NavGraph;
  pathfinder: RouteLike;
  cities: Cities;
  settings: Settings;
}

// ------------------------------------------------------------------ Tuning

/** Modellsichtbarkeit (Kameraabstand km) */
const INFRA_MODEL_MAX = 150;
const INFRA_ICON_MIN = 150;
const INFRA_ICON_MAX = 900;
const EMBLEM_MAX = 600;
const AMBIENT_MAX = 30;
const PED_MAX_DIST = 8;
const FLOW_LINE_MIN = 10;
const FLOW_LINE_MAX = 900;
/** Fahrzeug-/Fußgängerpools */
const VEH_POOL = 3000;
const PED_POOL = 4000;
/** Sichtmaßstab der Infrastruktur-Modelle: clamp(K·dist, 1, MAX) */
const INFRA_SCALE_K = 0.06;
const INFRA_SCALE_MAX = 12;
/** Sichtmaßstab der Fahrzeuge */
const VEH_SCALE_K = 2.0;
const VEH_SCALE_MIN = 3;
const VEH_SCALE_MAX = 90;
const MAX_FLOWS = 160;
const RECENT_FIRE_S = 25;
const BOMBARD_WINDOW_S = 60;
const BOMBARD_COUNT = 6;
const FLUSH_S = 2;

/** Kapazität Personen/h je Straßenklasse (Richtung, inkl. Busse) */
const CLASS_CAP: Record<string, number> = { motorway: 9000, primary: 4000, secondary: 2200, road: 1200, track: 400, rail: 3500, ferry: 800 };
const OFFROAD_CAP = 300;
/** Personen pro km Kolonne */
const FLOW_DENSITY = { car: 110, walk: 800, rail: 1000 };

const MOB_CAR: MobilityProfile = {
  domain: 'ground', roadSpeed: { motorway: 60, primary: 50, secondary: 40, road: 35, track: 15, ferry: 25 }, offroadSpeed: 6, offroadAllowed: false, slopePenalty: 0.8,
};
const MOB_WALK: MobilityProfile = {
  domain: 'ground', roadSpeed: { motorway: 4.5, primary: 4.5, secondary: 4.5, road: 4.5, track: 4.5 }, offroadSpeed: 3.5, offroadAllowed: true, slopePenalty: 0.4,
};
const MOB_RAIL: MobilityProfile = { domain: 'ground', roadSpeed: { rail: 80 }, offroadSpeed: 1, offroadAllowed: false, slopePenalty: 1 };

type FlowMode = 'car' | 'walk' | 'rail';

interface RoutePlan {
  route: Route;
  /** kumulierte km je Routenpunkt */
  cum: Float32Array;
  /** NavEdge-ID je Segment: -1 Gelände, -2 noch nicht ermittelt */
  edges: Int32Array;
  filled: number;
  mode: FlowMode;
  destCity: number;
  version: number;
}

interface RefugeeFlow {
  id: number;
  cityId: number;
  mode: FlowMode;
  people: number;
  headKm: number;
  seg: number;
  plan: RoutePlan;
  stallH: number;
  reroute: boolean;
  panic: boolean;
}

interface EvacState {
  destCity: number;
  destX: number;
  destZ: number;
  target: number;
  left: Record<FlowMode, number>;
  rate: Record<FlowMode, number>;
  timer: Record<FlowMode, number>;
  plans: Record<FlowMode, RoutePlan | null>;
}

interface CityX {
  bcount: number;
  dmgSum: number;
  lastAttack: number;
  impacts: number[];
  departed: number;
  hosted: number;
  wounded: number;
  hungerH: number;
  cutOff: boolean;
  starved: number;
  panicAllow: number;
  panicTimer: number;
  destCity: number;
  destX: number;
  destZ: number;
  panicPlans: Record<'car' | 'walk', RoutePlan | null>;
  evac: EvacState | null;
  scanTick: number;
  exitFactor: number;
  spots: Float32Array | null;
  aidLevel: number;
}

interface PendingCas {
  cityId: number;
  attacker: string;
  cause: CasualtyCause;
  killed: number;
  wounded: number;
  t0: number;
}

interface FireRec {
  tx: number;
  tz: number;
  owner: string;
  t: number;
}

interface CarrierState {
  cityId: number;
  dwellH: number;
  consumeH: number;
  cargo: number;
}

// ------------------------------------------------------------------ Hilfen

function hash01(a: number, b = 0): number {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x7f4a7c15, 0x85ebca6b)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39) >>> 0;
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

/** Gebäude-Verteilungsprofil: Kern dichter. Mittelwert über die Kreisfläche ≈ 1. */
function densityProfile(dNorm: number): number {
  const d = clamp(dNorm, 0, 1.1);
  return (2.2 * (1 - Math.min(1, d)) + 0.35) / 1.083;
}

const EXPLOSION_R: Record<string, number> = { tiny: 0.006, small: 0.015, medium: 0.03, large: 0.06, huge: 0.11 };

// ------------------------------------------------------------------ Atlas (Marker)

const ATLAS_N = 4;
const ICON_CELL: Record<InfraKind, number> = {
  hospital: 0, school: 1, power_plant: 2, water_works: 3, port: 4, airport: 5, rail_station: 6, town_hall: 7, church: 8,
};
const EMBLEM_CELL = 9;

function makeAtlas(): THREE.Texture {
  if (typeof document === 'undefined') {
    const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    t.needsUpdate = true;
    return t;
  }
  const S = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S * ATLAS_N;
  const g = cv.getContext('2d')!;
  const cell = (i: number, bg: string, draw: (c: CanvasRenderingContext2D) => void) => {
    g.save();
    g.translate((i % ATLAS_N) * S, Math.floor(i / ATLAS_N) * S);
    g.fillStyle = bg;
    g.strokeStyle = '#10151a';
    g.lineWidth = 3;
    g.beginPath();
    g.arc(S / 2, S / 2, S / 2 - 4, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.fillStyle = '#ffffff';
    g.strokeStyle = '#ffffff';
    draw(g);
    g.restore();
  };
  cell(0, '#2f9e54', (c) => { c.fillRect(27, 14, 10, 36); c.fillRect(14, 27, 36, 10); }); // Kreuz
  cell(1, '#d3a82a', (c) => { c.beginPath(); c.moveTo(14, 26); c.lineTo(32, 14); c.lineTo(50, 26); c.closePath(); c.fill(); c.fillRect(18, 28, 28, 18); c.fillStyle = '#d3a82a'; c.fillRect(28, 34, 8, 12); }); // Schule
  cell(2, '#d9772a', (c) => { c.beginPath(); c.moveTo(36, 10); c.lineTo(20, 34); c.lineTo(31, 34); c.lineTo(26, 54); c.lineTo(46, 28); c.lineTo(34, 28); c.closePath(); c.fill(); }); // Blitz
  cell(3, '#2f7fc8', (c) => { c.beginPath(); c.moveTo(32, 10); c.bezierCurveTo(46, 30, 50, 36, 50, 40); c.arc(32, 40, 18, 0, Math.PI, false); c.bezierCurveTo(14, 36, 18, 30, 32, 10); c.fill(); }); // Tropfen
  cell(4, '#2a5f8f', (c) => { c.lineWidth = 5; c.beginPath(); c.moveTo(32, 14); c.lineTo(32, 48); c.moveTo(20, 24); c.lineTo(44, 24); c.moveTo(16, 38); c.quadraticCurveTo(32, 58, 48, 38); c.stroke(); }); // Anker
  cell(5, '#6a7e94', (c) => { c.fillRect(30, 12, 4, 40); c.fillRect(14, 30, 36, 4); c.fillRect(24, 46, 16, 4); });
  cell(6, '#6d6d72', (c) => { c.fillRect(18, 16, 28, 24); c.fillStyle = '#6d6d72'; c.fillRect(22, 20, 8, 8); c.fillRect(34, 20, 8, 8); c.fillStyle = '#fff'; c.fillRect(16, 44, 32, 4); }); // Bahn
  cell(7, '#8c7a4e', (c) => { c.fillRect(14, 40, 36, 8); c.fillRect(18, 24, 6, 16); c.fillRect(30, 24, 6, 16); c.fillRect(42, 24, 6, 16); c.beginPath(); c.moveTo(12, 24); c.lineTo(32, 12); c.lineTo(52, 24); c.closePath(); c.fill(); });
  cell(8, '#7a6a8c', (c) => { c.fillRect(27, 16, 10, 34); c.fillRect(18, 24, 28, 8); });
  // Schutzzeichen (Haager Konvention: blau-weißes Schild/Raute)
  g.save();
  g.translate((EMBLEM_CELL % ATLAS_N) * S, Math.floor(EMBLEM_CELL / ATLAS_N) * S);
  g.fillStyle = '#ffffff';
  g.beginPath(); g.moveTo(32, 3); g.lineTo(61, 32); g.lineTo(32, 61); g.lineTo(3, 32); g.closePath(); g.fill();
  g.fillStyle = '#1c4fa8';
  g.beginPath(); g.moveTo(32, 10); g.lineTo(54, 32); g.lineTo(32, 54); g.lineTo(10, 32); g.closePath(); g.fill();
  g.fillStyle = '#ffffff';
  g.beginPath(); g.moveTo(32, 20); g.lineTo(44, 32); g.lineTo(32, 44); g.lineTo(20, 32); g.closePath(); g.fill();
  g.fillStyle = '#1c4fa8';
  g.fillRect(29, 24, 6, 16); g.fillRect(24, 29, 16, 6);
  g.restore();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}

const MARK_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 iPos;
attribute vec2 iData;
uniform vec2 uScreen;
uniform float uSize;
uniform float uBase;
uniform float uScale;
uniform float uPxPerKm;
varying vec2 vUv;
void main() {
  vec4 clip = projectionMatrix * viewMatrix * vec4(iPos, 1.0);
  float cell = floor(iData.x + 0.5);
  float offPx = iData.y * 0.001 * uScale * uPxPerKm + uBase;
  vec2 px = position.xy * uSize + vec2(0.0, offPx);
  clip.xy += px / uScreen * 2.0 * clip.w;
  gl_Position = clip;
  float cx = mod(cell, ${ATLAS_N.toFixed(1)});
  float cy = floor(cell / ${ATLAS_N.toFixed(1)});
  vUv = vec2((cx + uv.x) / ${ATLAS_N.toFixed(1)}, 1.0 - (cy + 1.0 - uv.y) / ${ATLAS_N.toFixed(1)});
  #include <logdepthbuf_vertex>
}
`;
const MARK_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D uAtlas;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(uAtlas, vUv);
  if (c.a < 0.4) discard;
  gl_FragColor = vec4(c.rgb, 1.0);
  #include <logdepthbuf_fragment>
}
`;

class MarkerLayer {
  readonly mesh: THREE.Mesh;
  readonly mat: THREE.ShaderMaterial;
  private readonly geom = new THREE.InstancedBufferGeometry();
  private readonly pos: Float32Array;
  private readonly data: Float32Array;
  constructor(atlas: THREE.Texture, capacity: number, order: number, name: string) {
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geom.index = quad.index;
    this.geom.setAttribute('position', quad.getAttribute('position'));
    this.geom.setAttribute('uv', quad.getAttribute('uv'));
    this.pos = new Float32Array(capacity * 3);
    this.data = new Float32Array(capacity * 2);
    const pa = new THREE.InstancedBufferAttribute(this.pos, 3);
    const da = new THREE.InstancedBufferAttribute(this.data, 2);
    pa.setUsage(THREE.DynamicDrawUsage);
    da.setUsage(THREE.DynamicDrawUsage);
    this.geom.setAttribute('iPos', pa);
    this.geom.setAttribute('iData', da);
    this.geom.instanceCount = 0;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: MARK_VERT,
      fragmentShader: MARK_FRAG,
      uniforms: {
        uAtlas: { value: atlas }, uScreen: { value: new THREE.Vector2(1, 1) }, uSize: { value: 22 }, uBase: { value: 0 },
        uScale: { value: 0 }, uPxPerKm: { value: 1 },
      },
      depthTest: false, depthWrite: false, fog: false, transparent: false,
    });
    this.mesh = new THREE.Mesh(this.geom, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = order;
    this.mesh.name = name;
    this.mesh.visible = false;
  }
  set(i: number, x: number, y: number, z: number, cell: number, hm: number): void {
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.data[i * 2] = cell; this.data[i * 2 + 1] = hm;
  }
  commit(n: number): void {
    this.geom.instanceCount = n;
    (this.geom.getAttribute('iPos') as THREE.BufferAttribute).needsUpdate = true;
    (this.geom.getAttribute('iData') as THREE.BufferAttribute).needsUpdate = true;
  }
}

// ------------------------------------------------------------------ Hauptklasse

export class CivilianSystem {
  readonly cities: CivilCity[];
  readonly infra: InfraInfo[];
  readonly object = new THREE.Group();
  readonly stats = { totalPop: 0, killed: 0, refugees: 0 };

  private readonly geo: GeoData;
  private readonly units: UnitManager;
  private readonly graph: NavGraph;
  private readonly pf: RouteLike;
  private readonly buildings: Cities;
  private exag: number;

  private readonly cx: CityX[];
  private readonly infraYaw: number[];
  private readonly infraBase: Float32Array;
  private readonly infraByCity: number[][] = [];
  private maxR = 1;

  // Zeit
  private clock = 0; // Spielsekunden
  private hours = 6; // Spielstunden seit Start (06:00)
  private realClock = 0;

  // Ereignisse
  private readonly fire: FireRec[] = [];
  private readonly recentBlasts: Array<{ x: number; z: number; t: number }> = [];
  private readonly pending = new Map<string, PendingCas>();
  private lastShield = { x: 0, z: 0, t: -999, cityId: -1 };
  private readonly bldCity = new Map<number, number>();
  private readonly bldIntegrity = new Map<number, number>();
  private readonly infraDamageEmit: number[];
  private readonly _ui: Unit[] = [];

  // Flüsse
  private readonly flows: RefugeeFlow[] = [];
  private nextFlowId = 1;
  private readonly load = new Map<number, number>();
  private loadTimer = 0;
  private readonly fuel = new Map<string, number>();
  private plansThisFrame = 0;
  private readonly planFill: RoutePlan[] = [];

  // Hilfe
  private readonly carriers = new Map<number, CarrierState>();
  private aidAccH = 0;
  private aidAccReal = 0;
  private statTimer = 0;
  private hungerCursor = 0;

  // Rendering
  private readonly vehMeshes = {} as Record<VehicleModel, THREE.InstancedMesh>;
  private readonly vehCount = {} as Record<VehicleModel, number>;
  private readonly infraMeshes = {} as Record<InfraKind, THREE.InstancedMesh>;
  private readonly infraCount = {} as Record<InfraKind, number>;
  private readonly infraIdx: Record<string, number[]> = {};
  private readonly iconLayer: MarkerLayer;
  private readonly emblemLayer: MarkerLayer;
  private readonly flowLines: THREE.LineSegments;
  private readonly flowDots: THREE.Points;
  private readonly flowLinePos: Float32Array;
  private readonly flowLineCol: Float32Array;
  private readonly flowDotPos: Float32Array;
  private readonly flowDotCol: Float32Array;
  private camDist = 3000;
  private camFocusX = 0;
  private camFocusZ = 0;
  private readonly carCol: THREE.Color[] = CAR_COLORS.map((c) => new THREE.Color(c));
  private readonly busCol: THREE.Color[] = BUS_COLORS.map((c) => new THREE.Color(c));
  private readonly truckCol: THREE.Color[] = TRUCK_COLORS.map((c) => new THREE.Color(c));
  private readonly clothCol: THREE.Color[] = CLOTH_COLORS.map((c) => new THREE.Color(c));
  private readonly white = new THREE.Color(1, 1, 1);
  private edgeCum = new Map<number, Float32Array>();
  private ambient: Array<{ e: number; n: number; speed: number; rail: boolean }> = [];
  private ambientTimer = 99;
  private ambientFx = -1e9;
  private ambientFz = -1e9;
  private visTime = 0;
  private readonly _p: [number, number] = [0, 0];
  private readonly _d: [number, number] = [0, 0];
  private show = true;

  constructor(deps: CivilianDeps) {
    this.geo = deps.geo;
    this.units = deps.units;
    this.graph = deps.graph;
    this.pf = deps.pathfinder;
    this.buildings = deps.cities;
    this.exag = deps.settings.heightExaggeration;
    this.object.name = 'Civil';

    // --- Städte
    const meta = this.geo.meta.cities;
    this.cities = meta.map((c, id) => {
      const R = cityRadiusKm(c.pop, c.capital);
      this.maxR = Math.max(this.maxR, R);
      return {
        id, name: c.name, country: c.country, controller: c.country, capital: c.capital, x: c.pos[0], z: c.pos[1], radiusKm: R,
        populationStart: c.pop, population: c.pop, refugees: 0, killed: 0, evacuated: 0, evacuating: false, satisfaction: 60,
        unrest: 0, control: 'normal', damage: 0,
      } satisfies CivilCity;
    });
    this.cx = this.cities.map((c) => {
      const list: BuildingInfo[] = [];
      this.buildings.buildingsInRadius(c.x, c.z, c.radiusKm * 1.05, list);
      return {
        bcount: Math.max(8, list.length), dmgSum: 0, lastAttack: -1e9, impacts: [], departed: 0, hosted: 0, wounded: 0, hungerH: 0, cutOff: false,
        starved: 0, panicAllow: 0, panicTimer: 0, destCity: -2, destX: 0, destZ: 0, panicPlans: { car: null, walk: null }, evac: null, scanTick: 0,
        exitFactor: -1, spots: null, aidLevel: 0,
      } satisfies CityX;
    });

    // --- Infrastruktur
    const gen = generateInfra(this.geo, meta, this.buildings);
    this.infra = gen.infra;
    this.infraYaw = gen.yaw;
    this.infraDamageEmit = this.infra.map(() => 1);
    this.infraBase = new Float32Array(this.infra.length);
    for (let c = 0; c < this.cities.length; c++) this.infraByCity.push([]);
    this.infra.forEach((it, i) => {
      this.infraByCity[it.cityId].push(i);
      const h = Math.max(it.w, it.d) * 0.5;
      this.infraBase[i] = Math.max(0, Math.min(
        terrainHeightKm(this.geo, it.x - h, it.z - h), terrainHeightKm(this.geo, it.x + h, it.z - h), terrainHeightKm(this.geo, it.x - h, it.z + h), terrainHeightKm(this.geo, it.x + h, it.z + h), terrainHeightKm(this.geo, it.x, it.z)));
    });

    // --- Meshes
    const geoms = buildCivilGeometries();
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide });
    const mk = (g: THREE.BufferGeometry, cap: number, name: string): THREE.InstancedMesh => {
      const m = new THREE.InstancedMesh(g, mat, Math.max(1, cap));
      m.name = name;
      m.count = 0;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.setColorAt(0, this.white);
      if (m.instanceColor) m.instanceColor.setUsage(THREE.DynamicDrawUsage);
      this.object.add(m);
      return m;
    };
    const caps: Record<VehicleModel, number> = { car: VEH_POOL, hatch: 1500, suv: 1200, bus: 500, truck: 900, carLoaded: 1500, train: 120, ped: PED_POOL, pedPack: 1500 };
    (Object.keys(caps) as VehicleModel[]).forEach((k) => { this.vehMeshes[k] = mk(geoms.vehicles[k], caps[k], 'Civil_' + k); this.vehCount[k] = 0; });
    for (const k of INFRA_KINDS) {
      const idx: number[] = [];
      this.infra.forEach((it, i) => { if (it.kind === k) idx.push(i); });
      this.infraIdx[k] = idx;
      this.infraMeshes[k] = mk(geoms.infra[k], idx.length, 'Infra_' + k);
      this.infraCount[k] = 0;
    }

    const atlas = makeAtlas();
    this.iconLayer = new MarkerLayer(atlas, this.infra.length, 38, 'InfraIcons');
    this.emblemLayer = new MarkerLayer(atlas, this.infra.length, 39, 'InfraEmblems');
    this.object.add(this.iconLayer.mesh, this.emblemLayer.mesh);

    // Flusslinien/-punkte
    const LSEG = 24;
    this.flowLinePos = new Float32Array(MAX_FLOWS * LSEG * 2 * 3);
    this.flowLineCol = new Float32Array(MAX_FLOWS * LSEG * 2 * 3);
    const lg = new THREE.BufferGeometry();
    const lpa = new THREE.BufferAttribute(this.flowLinePos, 3);
    lpa.setUsage(THREE.DynamicDrawUsage);
    lg.setAttribute('position', lpa);
    lg.setAttribute('color', new THREE.BufferAttribute(this.flowLineCol, 3).setUsage(THREE.DynamicDrawUsage));
    lg.setDrawRange(0, 0);
    this.flowLines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ vertexColors: true, fog: false, transparent: true, opacity: 0.95 }));
    this.flowLines.frustumCulled = false;
    this.flowLines.renderOrder = 30;
    this.flowLines.name = 'RefugeeLines';
    this.flowDotPos = new Float32Array(MAX_FLOWS * 2 * 3);
    this.flowDotCol = new Float32Array(MAX_FLOWS * 2 * 3);
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(this.flowDotPos, 3).setUsage(THREE.DynamicDrawUsage));
    dg.setAttribute('color', new THREE.BufferAttribute(this.flowDotCol, 3).setUsage(THREE.DynamicDrawUsage));
    dg.setDrawRange(0, 0);
    this.flowDots = new THREE.Points(dg, new THREE.PointsMaterial({ size: 6, sizeAttenuation: false, vertexColors: true, fog: false, depthWrite: false }));
    this.flowDots.frustumCulled = false;
    this.flowDots.renderOrder = 31;
    this.flowDots.name = 'RefugeeDots';
    this.object.add(this.flowLines, this.flowDots);

    this.bindEvents();
    this.recomputeStats();
  }

  // ================================================================== öffentliche API

  cityById(id: number): CivilCity | undefined {
    return this.cities[id];
  }

  /** Stadt, in deren Radius (+extraKm) der Punkt liegt (bei mehreren: kleinste normierte Entfernung) */
  cityAt(x: number, z: number, extraKm = 0): CivilCity | null {
    let best: CivilCity | null = null;
    let bd = Infinity;
    const lim = this.maxR + extraKm;
    for (const c of this.cities) {
      const dx = x - c.x;
      if (dx > lim || dx < -lim) continue;
      const dz = z - c.z;
      const R = c.radiusKm + extraKm;
      const d2 = dx * dx + dz * dz;
      if (d2 > R * R) continue;
      const n = Math.sqrt(d2) / R;
      if (n < bd) { bd = n; best = c; }
    }
    return best;
  }

  infraNear(x: number, z: number, r: number, out: InfraInfo[]): InfraInfo[] {
    out.length = 0;
    for (const it of this.infra) {
      const dx = it.x - x, dz = it.z - z;
      const rr = r + Math.max(it.w, it.d) * 0.5;
      if (dx * dx + dz * dz <= rr * rr) out.push(it);
    }
    return out;
  }

  getInfra(id: number): InfraInfo | undefined {
    return this.infra[id];
  }

  infraOfCity(cityId: number): InfraInfo[] {
    return (this.infraByCity[cityId] ?? []).map((i) => this.infra[i]);
  }

  /** Geschätzte lebende Zivilisten im Umkreis r (km) um (x,z), inkl. Flüchtlingskolonnen */
  populationNear(x: number, z: number, r: number): number {
    let sum = 0;
    for (const c of this.cities) {
      if (c.population <= 0) continue;
      const R = c.radiusKm;
      const d = Math.hypot(x - c.x, z - c.z);
      if (d > R + r) continue;
      const ov = circleOverlap(R, r, d);
      if (ov <= 0) continue;
      const rho = (c.population * 0.9) / (Math.PI * R * R);
      const f = densityProfile(Math.min(1, d / R));
      sum += Math.min(c.population, rho * ov * (r > R * 0.5 ? 1 : f));
    }
    for (const f of this.flows) {
      const hx = this.planPoint(f.plan, f.headKm, this._p);
      void hx;
      const dx = this._p[0] - x, dz = this._p[1] - z;
      if (dx * dx + dz * dz <= (r + 0.5) * (r + 0.5)) sum += f.people * 0.5;
    }
    return Math.round(sum);
  }

  setController(cityId: number, a3: string): void {
    const c = this.cities[cityId];
    if (!c || c.controller === a3) return;
    const cx = this.cx[cityId];
    c.controller = a3;
    if (a3 !== c.country) {
      if (c.control !== 'ruined') c.control = 'occupied';
      if (cx.evac) { cx.evac = null; c.evacuating = false; }
      c.satisfaction = Math.max(0, c.satisfaction - 20);
      cx.panicAllow = Math.max(cx.panicAllow, c.population * 0.2);
      cx.lastAttack = this.clock;
    } else if (c.control === 'occupied' || c.control === 'unrest') {
      c.control = c.population < 1 ? 'ruined' : 'normal';
    }
  }

  /** Aid in "Hilfseinheiten" (Lieferung eines Konvois ≈ 50) – hebt Zufriedenheit (skaliert mit Einwohnerzahl), lindert Hunger. */
  deliverAid(cityId: number, amount: number, by: string): void {
    const c = this.cities[cityId];
    if (!c || amount <= 0 || c.control === 'ruined') return;
    const gain = amount * 0.08 * clamp(500_000 / Math.max(20_000, c.population), 0.05, 4);
    c.satisfaction = clamp(c.satisfaction + gain, 0, 100);
    const cx = this.cx[cityId];
    cx.hungerH = Math.max(0, cx.hungerH - amount * 1.5);
    cx.aidLevel = Math.min(1, cx.aidLevel + amount * 0.002);
    bus.emit('civil:aid', { cityId, amount, by });
  }

  damageInfra(id: number, amount: number, attacker: string): void {
    const it = this.infra[id];
    if (!it || amount <= 0 || it.integrity <= 0) return;
    const before = it.integrity;
    it.integrity = Math.max(0, before - amount);
    const destroyed = it.integrity <= 0;
    if (destroyed || Math.floor(it.integrity * 10) < Math.floor(this.infraDamageEmit[id] * 10)) {
      this.infraDamageEmit[id] = it.integrity;
      bus.emit('civil:infra', { id, kind: it.kind, cityId: it.cityId, integrity: it.integrity, destroyed, attacker });
    }
    if (destroyed) this.onInfraDestroyed(it, attacker);
  }

  /** Auslastung 0..1 der Kante durch Flüchtlingskolonnen */
  refugeeLoadOnEdge(edgeId: number): number {
    return this.load.get(edgeId) ?? 0;
  }

  /**
   * Geschwindigkeitsfaktor für Militär auf Straßen: 1 = frei, bis 0.3 auf stark verstopfter Kante.
   * VERDRAHTUNG (Lead): im UnitManager-Bewegungsschritt für Einheiten mit `u.onRoad` die Geschwindigkeit mit
   * `civil.speedFactorAt(u.x, u.z)` multiplizieren (z. B. effectiveSpeed = min(routeSpeed, groupSpeedCap) * factor).
   * Kosten: O(1), wenn keine Kolonne unterwegs ist (häufigster Fall); sonst ein Straßen-Nearest-Lookup mit Filter.
   */
  speedFactorAt(x: number, z: number): number {
    if (this.load.size === 0) return 1;
    const ep = this.graph.nearestEdgePoint(x, z, 0.12, (e) => this.load.has(e.id));
    if (!ep) return 1;
    const l = this.load.get(ep.edge) ?? 0;
    return clamp(1 - 0.7 * l, 0.3, 1);
  }

  /** Verfügbarkeit von Treibstoff für zivile Fahrzeuge je Land (0..1, Standard 1) – beeinflusst den Anteil motorisierter Evakuierter */
  setFuelFactor(a3: string, f: number): void {
    this.fuel.set(a3, clamp(f, 0, 1));
  }

  /** Aktive Flüchtlingsströme (Debug/UI) */
  get activeFlows(): ReadonlyArray<{ id: number; cityId: number; mode: string; people: number; headKm: number; lengthKm: number }> {
    return this.flows.map((f) => ({ id: f.id, cityId: f.cityId, mode: f.mode, people: f.people, headKm: f.headKm, lengthKm: f.plan.route.lengthKm }));
  }

  startEvacuation(cityId: number, destX?: number, destZ?: number): boolean {
    const c = this.cities[cityId];
    if (!c) return false;
    const cx = this.cx[cityId];
    if (c.control === 'ruined' || c.control === 'occupied' || c.population < 50 || cx.evac) return false;
    // Ziel
    let destCity = -1, dx = destX, dz = destZ;
    if (dx === undefined || dz === undefined) {
      const d = this.chooseDestination(c);
      destCity = d.city; dx = d.x; dz = d.z;
    } else {
      const nc = this.cityAt(dx, dz, 3);
      destCity = nc && nc.id !== cityId ? nc.id : -1;
    }
    const target = c.population * 0.85;
    const plans: Record<FlowMode, RoutePlan | null> = {
      car: this.makePlan(c.x, c.z, dx, dz, 'car', destCity),
      walk: this.makePlan(c.x, c.z, dx, dz, 'walk', destCity),
      rail: this.makePlan(c.x, c.z, dx, dz, 'rail', destCity),
    };
    if (plans.rail && plans.rail.route.lengthKm < 5) plans.rail = null;
    if (!plans.car && !plans.walk) return false;
    const fuel = this.fuel.get(c.country) ?? 1;
    const rail = plans.rail ? target * 0.25 : 0;
    const motor = plans.car ? (target - rail) * 0.55 * fuel : 0;
    const walk = target - rail - motor;
    if (cx.exitFactor < 0) cx.exitFactor = this.computeExitFactor(c);
    const carCap = plans.car ? this.planCapacity(plans.car) * cx.exitFactor : 0;
    const railCap = plans.rail ? CLASS_CAP.rail : 0;
    cx.evac = {
      destCity, destX: dx, destZ: dz, target,
      left: { car: motor, walk: plans.walk ? walk : 0, rail },
      rate: { car: Math.max(200, carCap), walk: Math.max(300, walk / 24), rail: railCap },
      timer: { car: 0, walk: 0, rail: 0 },
      plans,
    };
    if (!plans.walk && plans.car) cx.evac.left.car += walk;
    c.evacuating = true;
    c.control = 'evacuating';
    bus.emit('civil:evacuate', { cityId, start: true });
    return true;
  }

  stopEvacuation(cityId: number): void {
    const c = this.cities[cityId];
    const cx = this.cx[cityId];
    if (!c || !cx.evac) return;
    cx.evac = null;
    c.evacuating = false;
    if (c.control === 'evacuating' || c.control === 'evacuated') c.control = c.controller !== c.country ? 'occupied' : c.population < 1 ? 'ruined' : 'normal';
    bus.emit('civil:evacuate', { cityId, start: false });
  }

  applySettings(s: Settings): void {
    this.exag = s.heightExaggeration;
    this.show = s.showCities;
    this.object.visible = s.showCities;
  }

  // ================================================================== Ereignisse

  private bindEvents(): void {
    bus.on('combat:fire', (e) => {
      const u = this.units.get(e.unitId);
      if (!u) return;
      this.fire.push({ tx: e.tx, tz: e.tz, owner: u.owner, t: this.clock });
      if (this.fire.length > 400) this.fire.splice(0, 200);
    });
    bus.on('combat:impact', (e) => {
      if (e.surface === 'water' || e.surface === 'armor' || e.surface === 'flesh') return;
      this.blast(e.x, e.z, e.radiusKm, e.surface === 'building' ? 1.4 : 1, 'impact');
    });
    bus.on('combat:explosion', (e) => this.blast(e.x, e.z, EXPLOSION_R[e.size] ?? 0.02, 0.5, 'explosion'));
    bus.on('building:damaged', (e) => {
      const prev = this.bldIntegrity.get(e.id) ?? 1;
      this.bldIntegrity.set(e.id, e.integrity);
      const b = this.buildings.getBuilding(e.id);
      const c = this.bldCityOf(e.id, b.x, b.z);
      if (c) this.cx[c.id].dmgSum += Math.max(0, prev - e.integrity);
    });
    bus.on('building:destroyed', (e) => this.onBuildingDestroyed(e.id, e.x, e.z));
    bus.on('bridge:destroyed', (e) => this.onBridgeDestroyed(e.edgeId, e.geom));
    bus.on('nav:edge', (e) => { if (!e.open) this.onEdgeClosed(e.edgeId); });
    bus.on('city:captured', (e) => this.setController(e.cityId, e.by));
  }

  private bldCityOf(id: number, x: number, z: number): CivilCity | null {
    let ci = this.bldCity.get(id);
    if (ci === undefined) {
      const c = this.cityAt(x, z, 0.5);
      ci = c ? c.id : -1;
      this.bldCity.set(id, ci);
    }
    return ci >= 0 ? this.cities[ci] : null;
  }

  private findAttacker(x: number, z: number, r: number): string {
    const maxD = Math.max(0.6, r * 4 + 0.3);
    let best = '', bd = maxD * maxD;
    for (let i = this.fire.length - 1; i >= 0; i--) {
      const f = this.fire[i];
      if (this.clock - f.t > RECENT_FIRE_S) break;
      const d2 = (f.tx - x) * (f.tx - x) + (f.tz - z) * (f.tz - z);
      if (d2 < bd) { bd = d2; best = f.owner; }
    }
    return best;
  }

  /** Wirkung eines Einschlags/einer Explosion auf Stadtbevölkerung, Infrastruktur und Flüchtlingskolonnen */
  private blast(x: number, z: number, r: number, weight: number, src: 'impact' | 'explosion'): void {
    // Doppelzählung (Einschlag + zugehörige Explosion) vermeiden
    for (let i = this.recentBlasts.length - 1; i >= 0; i--) {
      const b = this.recentBlasts[i];
      if (this.clock - b.t > 1.2) { this.recentBlasts.splice(0, i + 1); break; }
      if (src === 'explosion' && Math.abs(b.x - x) < 0.04 && Math.abs(b.z - z) < 0.04) return;
    }
    if (src === 'impact') this.recentBlasts.push({ x, z, t: this.clock });
    const attacker = this.findAttacker(x, z, r);

    this.blastFlows(x, z, r, attacker, 'collateral');

    // Infrastruktur
    for (const it of this.infra) {
      const dx = it.x - x, dz = it.z - z;
      const rr = r * 1.5 + Math.max(it.w, it.d) * 0.5;
      if (dx * dx + dz * dz > rr * rr) continue;
      if (it.integrity <= 0) continue;
      this.damageInfra(it.id, Math.min(0.6, (0.0035 + r * 1.8) * weight), attacker);
    }

    const c = this.cityAt(x, z, 0.15);
    if (!c || c.control === 'ruined') return;
    const cx = this.cx[c.id];
    const R = c.radiusKm;
    const d = Math.hypot(x - c.x, z - c.z);
    const f = densityProfile(d / R);
    const rho = (c.population / (Math.PI * R * R)) * 0.6;
    const rEff = Math.max(0.004, r * 1.25);
    const mean = rho * f * Math.PI * rEff * rEff * 0.06 * weight;
    // Beschuss-Zähler (Flächenbeschuss)
    cx.impacts.push(this.clock);
    while (cx.impacts.length && this.clock - cx.impacts[0] > BOMBARD_WINDOW_S) cx.impacts.shift();
    cx.lastAttack = this.clock;
    if (cx.panicAllow <= 0 && c.controller === c.country) cx.panicAllow = c.population * 0.35;

    let cause: CasualtyCause = cx.impacts.length >= BOMBARD_COUNT ? 'bombardment' : 'collateral';
    // Menschlicher Schild: besetztes Zivilgebäude am Einschlagort
    const b = this.buildings.findBuildingAt(x, z, Math.max(0.02, r));
    if (b && b.garrisoned > 0) {
      const us = this.units.queryRadius(b.x, b.z, Math.max(b.w, b.d), this._ui);
      for (const u of us) {
        if (u.garrisonId === b.id && u.owner !== attacker) { cause = 'shield'; break; }
      }
      if (cause === 'shield') this.lastShield = { x, z, t: this.clock, cityId: c.id };
    }
    this.addCasualties(c.id, attacker, cause, mean, mean * 2.5);
  }

  private blastFlows(x: number, z: number, r: number, attacker: string, cause: CasualtyCause): void {
    if (!this.flows.length) return;
    const reach = r * 1.5 + 0.02;
    for (const f of this.flows) {
      const dist = this.distToFlow(f, x, z);
      if (dist > reach) continue;
      const dens = FLOW_DENSITY[f.mode];
      const kill = Math.min(f.people * 0.6, dens * Math.min(2 * reach, 0.3) * 0.5 * (f.mode === 'walk' ? 1 : 0.7));
      if (kill < 0.01) continue;
      this.addCasualties(f.cityId, attacker, cause, kill, kill * 2, f);
    }
  }

  private distToFlow(f: RefugeeFlow, x: number, z: number): number {
    const p = f.plan.route.points, cum = f.plan.cum;
    const L = Math.max(0.1, f.people / FLOW_DENSITY[f.mode]);
    const tail = Math.max(0, f.headKm - L);
    let best = Infinity;
    let s = Math.max(0, f.seg - 1);
    // Segment des Schwanzes finden
    while (s > 0 && cum[s] > tail) s--;
    for (; s + 1 < cum.length && cum[s] <= f.headKm; s++) {
      const ax = p[s * 2], az = p[s * 2 + 1], bx = p[s * 2 + 2], bz = p[s * 2 + 3];
      const dx = bx - ax, dz = bz - az;
      const L2 = dx * dx + dz * dz;
      const t = L2 > 0 ? clamp(((x - ax) * dx + (z - az) * dz) / L2, 0, 1) : 0;
      const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
      if (d < best) best = d;
    }
    return best;
  }

  private onBuildingDestroyed(id: number, x: number, z: number): void {
    const c = this.bldCityOf(id, x, z);
    if (!c || c.control === 'ruined') return;
    const cx = this.cx[c.id];
    const b = this.buildings.getBuilding(id);
    const vol = b.w * b.d * Math.max(0.02, b.h);
    const occupants = ((c.population * 0.4) / cx.bcount) * clamp(vol / 0.01, 0.3, 4);
    const attacker = this.findAttacker(x, z, 0.05);
    const shield = this.clock - this.lastShield.t < 6 && this.lastShield.cityId === c.id && Math.hypot(this.lastShield.x - x, this.lastShield.z - z) < 0.25;
    this.addCasualties(c.id, attacker, shield ? 'shield' : 'collateral', occupants * 0.25, occupants * 0.4);
    cx.lastAttack = this.clock;
    // Zerstörungsanteil
    c.damage = clamp(cx.dmgSum / cx.bcount, 0, 1);
  }

  private onInfraDestroyed(it: InfraInfo, attacker: string): void {
    const c = this.cities[it.cityId];
    const scale = clamp(Math.sqrt(c.populationStart / 1e6), 0.5, 2.2);
    const base: Record<string, number> = { hospital: 180, school: 120, power_plant: 25, water_works: 6, port: 35, rail_station: 40, town_hall: 25, church: 20, airport: 30 };
    const day = this.hours % 24 > 7 && this.hours % 24 < 16 ? 1 : 0.15;
    const dead = (base[it.kind] ?? 10) * scale * (it.kind === 'school' ? day : 1) * (0.6 + 0.8 * hash01(it.id, 7));
    this.addCasualties(c.id, attacker, 'infrastructure', dead, dead * 1.5);
    c.damage = clamp(c.damage + 0.01, 0, 1);
    const cx = this.cx[c.id];
    if (it.kind === 'power_plant') c.satisfaction = Math.max(0, c.satisfaction - 6);
    else if (it.kind === 'hospital') { c.satisfaction = Math.max(0, c.satisfaction - 5); cx.wounded *= 1.1; }
    else if (it.kind === 'water_works') { cx.hungerH += 48; c.satisfaction = Math.max(0, c.satisfaction - 6); }
    else if (it.kind === 'port') c.satisfaction = Math.max(0, c.satisfaction - 2);
  }

  private onBridgeDestroyed(edgeId: number, geom: number[]): void {
    for (const f of this.flows) {
      for (let i = 0; i + 1 < geom.length; i += 2) {
        const d = this.distToFlow(f, geom[i], geom[i + 1]);
        if (d < 0.15) {
          const kill = f.people * 0.1;
          this.addCasualties(f.cityId, this.findAttacker(geom[i], geom[i + 1], 0.1), 'infrastructure', kill, kill * 2, f);
          break;
        }
      }
    }
    void edgeId;
  }

  private onEdgeClosed(edgeId: number): void {
    const e = this.graph.edges[edgeId];
    if (!e) return;
    const g = e.geom;
    for (const f of this.flows) {
      if (f.reroute) continue;
      const p = f.plan.route.points;
      let hit = false;
      for (let k = 0; k + 1 < g.length && !hit; k += 2) {
        for (let s = Math.max(0, f.seg); s + 1 < f.plan.cum.length; s++) {
          const ax = p[s * 2], az = p[s * 2 + 1], dx = p[s * 2 + 2] - ax, dz = p[s * 2 + 3] - az;
          const L2 = dx * dx + dz * dz;
          const t = L2 > 0 ? clamp(((g[k] - ax) * dx + (g[k + 1] - az) * dz) / L2, 0, 1) : 0;
          if (Math.hypot(ax + dx * t - g[k], az + dz * t - g[k + 1]) < 0.06) { hit = true; break; }
        }
      }
      if (hit) f.reroute = true;
    }
  }

  // ================================================================== Opfer & Zustand

  private addCasualties(cityId: number, attacker: string, cause: CasualtyCause, killed: number, wounded: number, flow?: RefugeeFlow): void {
    if (killed <= 0 && wounded <= 0) return;
    const c = this.cities[cityId];
    if (flow) {
      // Opfer unter Flüchtlingen werden sofort abgezogen
      const k = Math.min(flow.people, killed);
      flow.people -= k;
      c.refugees = Math.max(0, c.refugees - k);
      killed = k;
    }
    const key = `${cityId}|${attacker}|${cause}`;
    let p = this.pending.get(key);
    if (!p) { p = { cityId, attacker, cause, killed: 0, wounded: 0, t0: this.clock }; this.pending.set(key, p); }
    p.killed += killed;
    p.wounded += wounded;
    if (!flow) {
      // Bevölkerung der Stadt sofort (float) reduzieren
      c.population = Math.max(0, c.population - killed);
    }
    c.killed += killed;
    this.stats.killed += killed;
    this.cx[cityId].wounded += wounded;
  }

  private flushCasualties(force = false): void {
    for (const [key, p] of this.pending) {
      if (!force && this.clock - p.t0 < FLUSH_S) continue;
      const k = Math.floor(p.killed), w = Math.floor(p.wounded);
      if (k < 1 && w < 1) { if (this.clock - p.t0 > 30) this.pending.delete(key); continue; }
      p.killed -= k; p.wounded -= w;
      p.t0 = this.clock;
      const c = this.cities[p.cityId];
      const drop = clamp((k / Math.max(1, c.populationStart)) * 900, 0, 8) + (p.cause === 'bombardment' ? 0.4 : 0);
      c.satisfaction = Math.max(0, c.satisfaction - drop);
      bus.emit('civil:casualties', { cityId: p.cityId, country: c.country, killed: k, wounded: w, cause: p.cause, attacker: p.attacker });
    }
  }

  // ================================================================== Routen / Flüsse

  private makePlan(fx: number, fz: number, tx: number, tz: number, mode: FlowMode, destCity: number): RoutePlan | null {
    const mob = mode === 'car' ? MOB_CAR : mode === 'walk' ? MOB_WALK : MOB_RAIL;
    const route = this.pf.findRoute(fx, fz, tx, tz, mob);
    if (!route || route.points.length < 4 || route.lengthKm < 0.2) return null;
    const n = route.points.length / 2;
    const cum = new Float32Array(n);
    const p = route.points;
    for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(p[i * 2] - p[i * 2 - 2], p[i * 2 + 1] - p[i * 2 - 1]);
    const plan: RoutePlan = { route, cum, edges: new Int32Array(n - 1).fill(-2), filled: 0, mode, destCity, version: this.graph.version };
    this.planFill.push(plan);
    return plan;
  }

  /** Straßenkanten-IDs der Plansegmente schrittweise zuordnen (Budget je Frame) */
  private fillPlans(budget: number): void {
    while (budget > 0 && this.planFill.length) {
      const plan = this.planFill[0];
      const nSeg = plan.edges.length;
      const p = plan.route.points;
      let guard = 0;
      while (plan.filled < nSeg && budget > 0 && guard++ < 4000) {
        const s = plan.filled++;
        budget--;
        if (plan.route.segClass[s] === OFFROAD_CLASS) { plan.edges[s] = -1; continue; }
        const ep = this.graph.nearestEdgePoint((p[s * 2] + p[s * 2 + 2]) / 2, (p[s * 2 + 1] + p[s * 2 + 3]) / 2, 0.08);
        plan.edges[s] = ep ? ep.edge : -1;
      }
      if (plan.filled >= nSeg) this.planFill.shift();
    }
  }

  private planPoint(plan: RoutePlan, km: number, out: [number, number]): number {
    const cum = plan.cum, p = plan.route.points;
    const n = cum.length;
    if (km <= 0) { out[0] = p[0]; out[1] = p[1]; return 0; }
    if (km >= cum[n - 1]) { out[0] = p[(n - 1) * 2]; out[1] = p[(n - 1) * 2 + 1]; return n - 2; }
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (cum[m] <= km) lo = m; else hi = m;
    }
    const l = cum[lo + 1] - cum[lo];
    const t = l > 0 ? (km - cum[lo]) / l : 0;
    out[0] = p[lo * 2] + (p[lo * 2 + 2] - p[lo * 2]) * t;
    out[1] = p[lo * 2 + 1] + (p[lo * 2 + 3] - p[lo * 2 + 1]) * t;
    return lo;
  }

  private planCapacity(plan: RoutePlan): number {
    const r = plan.route;
    const lenByCls = new Map<number, number>();
    for (let s = 0; s < r.segClass.length; s++) {
      const l = plan.cum[s + 1] - plan.cum[s];
      lenByCls.set(r.segClass[s], (lenByCls.get(r.segClass[s]) ?? 0) + l);
    }
    let cap = Infinity;
    for (const [cls, l] of lenByCls) {
      if (l < r.lengthKm * 0.03) continue;
      const cc = cls === OFFROAD_CLASS ? OFFROAD_CAP : CLASS_CAP[ROAD_CLASSES[cls]] ?? 800;
      if (cc < cap) cap = cc;
    }
    return Number.isFinite(cap) ? cap : OFFROAD_CAP;
  }

  private computeExitFactor(c: CivilCity): number {
    const out: number[] = [];
    this.graph.edgesInRect(c.x - c.radiusKm, c.z - c.radiusKm, c.x + c.radiusKm, c.z + c.radiusKm, out);
    let exits = 0;
    for (const id of out) {
      const e = this.graph.edges[id];
      if (e.cls === 'rail' || e.cls === 'ferry' || e.cls === 'track' || !e.open) continue;
      const g = e.geom;
      const d0 = Math.hypot(g[0] - c.x, g[1] - c.z), d1 = Math.hypot(g[g.length - 2] - c.x, g[g.length - 1] - c.z);
      if ((d0 < c.radiusKm) !== (d1 < c.radiusKm)) exits++;
    }
    return clamp(1 + 0.35 * (exits - 1), 1, 2.4);
  }

  private chooseDestination(c: CivilCity): { city: number; x: number; z: number } {
    const enemies: Array<[number, number]> = [];
    for (const u of this.units.units) if (getRelation(c.country, u.owner) < -20 && u.type.category !== 'naval') enemies.push([u.x, u.z]);
    const enemyDist = (x: number, z: number): number => {
      let m = 400;
      for (const [ex, ez] of enemies) { const d = Math.hypot(ex - x, ez - z); if (d < m) m = d; }
      return m;
    };
    const e1 = enemyDist(c.x, c.z);
    let best: CivilCity | null = null, bs = Infinity;
    let any: CivilCity | null = null, ad = Infinity;
    for (const o of this.cities) {
      if (o.id === c.id || o.country !== c.country || o.control === 'ruined' || o.control === 'occupied') continue;
      const d = Math.hypot(o.x - c.x, o.z - c.z);
      if (d < 8 || d > 900) continue;
      if (d < ad) { ad = d; any = o; }
      const e2 = enemyDist(o.x, o.z);
      if (enemies.length && e2 <= e1 + 10) continue;
      const s = d - 0.8 * e2;
      if (s < bs) { bs = s; best = o; }
    }
    if (!best) {
      const cap = this.cities.find((o) => o.capital && o.country === c.country && o.id !== c.id && o.control !== 'occupied');
      best = cap ?? any;
    }
    if (best) return { city: best.id, x: best.x, z: best.z };
    // kein Ziel: 60 km weg vom nächsten Feind (oder nach Osten)
    let ax = 1, az = 0, md = Infinity;
    for (const [ex, ez] of enemies) { const d = Math.hypot(ex - c.x, ez - c.z); if (d < md) { md = d; ax = (c.x - ex) / (d || 1); az = (c.z - ez) / (d || 1); } }
    let x = c.x + ax * 60, z = c.z + az * 60;
    if (this.geo.countryAt(x, z) === 0) { x = c.x - ax * 60; z = c.z - az * 60; }
    return { city: -1, x, z };
  }

  private spawnFlow(cityId: number, mode: FlowMode, people: number, plan: RoutePlan, panic: boolean): void {
    if (people < 1) return;
    const c = this.cities[cityId];
    const cx = this.cx[cityId];
    // Bevölkerung verlässt die Stadt
    people = Math.min(people, c.population);
    c.population -= people;
    c.refugees += people;
    cx.departed += people;
    c.evacuated = clamp(cx.departed / c.populationStart, 0, 1);
    // Bei Überlast: in letzten Strom desselben Plans einreihen
    if (this.flows.length >= MAX_FLOWS) {
      for (let i = this.flows.length - 1; i >= 0; i--) {
        const f = this.flows[i];
        if (f.cityId === cityId && f.mode === mode && f.headKm < 3) { f.people += people; return; }
      }
    }
    this.flows.push({ id: this.nextFlowId++, cityId, mode, people, headKm: 0, seg: 0, plan, stallH: 0, reroute: false, panic });
  }

  private arrive(f: RefugeeFlow): void {
    const c = this.cities[f.cityId];
    c.refugees = Math.max(0, c.refugees - f.people);
    const d = f.plan.destCity >= 0 ? this.cities[f.plan.destCity] : null;
    if (d && d.control !== 'ruined') {
      d.population += f.people;
      const dx = this.cx[d.id];
      dx.hosted += f.people;
      d.satisfaction = Math.max(0, d.satisfaction - clamp((f.people / Math.max(50_000, d.populationStart)) * 6, 0, 3));
    }
    this.displacedArrived += f.people;
  }
  private displacedArrived = 0;

  private dissolve(f: RefugeeFlow): void {
    // Strom bricht ab: Menschen kehren (teilweise) zurück
    const c = this.cities[f.cityId];
    c.refugees = Math.max(0, c.refugees - f.people);
    if (c.control !== 'ruined') c.population += f.people * 0.9;
  }

  // ================================================================== Simulation

  update(dtGameHours: number, realDt: number, camera: THREE.PerspectiveCamera): void {
    this.realClock += realDt;
    this.plansThisFrame = 0;
    this.computeCamera(camera);
    if (dtGameHours > 0) {
      this.clock += dtGameHours * 3600;
      this.hours += dtGameHours;
      this.simulate(dtGameHours);
    }
    this.fillPlans(500);
    this.flushCasualties();
    this.aidAccH += dtGameHours;
    this.aidAccReal += realDt;
    if (this.aidAccReal >= 0.3) {
      this.processAid(this.aidAccH);
      this.aidAccH = 0;
      this.aidAccReal = 0;
    }
    this.statTimer += realDt;
    if (this.statTimer > 0.5) { this.statTimer = 0; this.recomputeStats(); }
    this.render(dtGameHours, realDt, camera);
  }

  private simulate(dtH: number): void {
    // Evakuierungen
    for (const c of this.cities) {
      const cx = this.cx[c.id];
      const ev = cx.evac;
      if (ev) this.stepEvac(c, cx, ev, dtH);
      this.stepPanic(c, cx, dtH);
      this.stepCityState(c, cx, dtH);
    }
    this.stepFlows(dtH);
    // Hunger-Check (Straßenabschnitt) reihum, eine Stadt je Aufruf
    if (this.cities.length) {
      this.hungerCursor = (this.hungerCursor + 1) % this.cities.length;
      this.scanCutOff(this.cities[this.hungerCursor], this.cx[this.hungerCursor]);
    }
    // Infra-Diagnose
    this.loadTimer += dtH;
    this.rebuildLoad();
  }

  private stepEvac(c: CivilCity, cx: CityX, ev: EvacState, dtH: number): void {
    if (c.control === 'occupied') { this.stopEvacuation(c.id); return; }
    const modes: FlowMode[] = ['car', 'walk', 'rail'];
    let left = 0;
    for (const m of modes) {
      const plan = ev.plans[m];
      if (!plan || ev.left[m] <= 0) { if (!plan) ev.left[m] = 0; continue; }
      ev.timer[m] += dtH;
      const step = 0.25;
      while (ev.timer[m] >= step && ev.left[m] > 0) {
        ev.timer[m] -= step;
        const chunk = Math.min(ev.left[m], Math.max(30, ev.rate[m] * step));
        if (this.flows.length >= MAX_FLOWS && chunk < 5000) { ev.timer[m] = 0; break; }
        ev.left[m] -= chunk;
        this.spawnFlow(c.id, m, chunk, plan, false);
      }
      left += ev.left[m];
    }
    if (left < 1) {
      cx.evac = null;
      c.evacuating = false;
      if (c.control === 'evacuating') c.control = c.population < 1 ? 'ruined' : 'evacuated';
      bus.emit('civil:evacuate', { cityId: c.id, start: false });
    }
  }

  private stepPanic(c: CivilCity, cx: CityX, dtH: number): void {
    if (cx.evac || c.control === 'ruined' || cx.panicAllow < 50) return;
    const attacked = this.clock - cx.lastAttack < 12 * 3600;
    const occupied = c.control === 'occupied';
    if (!attacked && !occupied) return;
    cx.panicTimer += dtH;
    if (cx.panicTimer < 0.5) return;
    cx.panicTimer = 0;
    if (this.plansThisFrame >= 1 && !(cx.panicPlans.car || cx.panicPlans.walk)) return;
    if (cx.destCity === -2) {
      const d = this.chooseDestination(c);
      cx.destCity = d.city; cx.destX = d.x; cx.destZ = d.z;
    }
    if (!cx.panicPlans.car && !cx.panicPlans.walk) {
      this.plansThisFrame++;
      cx.panicPlans.car = this.makePlan(c.x, c.z, cx.destX, cx.destZ, 'car', cx.destCity);
      cx.panicPlans.walk = cx.panicPlans.car ? null : this.makePlan(c.x, c.z, cx.destX, cx.destZ, 'walk', cx.destCity);
      if (!cx.panicPlans.car && !cx.panicPlans.walk) { cx.panicAllow = 0; return; }
    }
    const chunk = Math.min(cx.panicAllow, Math.max(200, c.population * (occupied ? 0.006 : 0.012)));
    cx.panicAllow -= chunk;
    if (cx.panicPlans.car) {
      this.spawnFlow(c.id, 'car', chunk * 0.6, cx.panicPlans.car, true);
      const w = this.makePlan(c.x, c.z, cx.destX, cx.destZ, 'walk', cx.destCity);
      if (w) this.spawnFlow(c.id, 'walk', chunk * 0.4, w, true); else this.spawnFlow(c.id, 'car', chunk * 0.4, cx.panicPlans.car, true);
    } else if (cx.panicPlans.walk) this.spawnFlow(c.id, 'walk', chunk, cx.panicPlans.walk, true);
  }

  private stepCityState(c: CivilCity, cx: CityX, dtH: number): void {
    if (c.control === 'ruined') { c.satisfaction = 0; return; }
    if (c.population < 1) {
      c.population = 0;
      c.control = 'ruined';
      c.satisfaction = 0;
      return;
    }
    const days = dtH / 24;
    const recent = this.clock - cx.lastAttack < 24 * 3600;
    // Verwundete heilen
    if (cx.wounded > 0) cx.wounded = Math.max(0, cx.wounded - cx.wounded * 0.02 * dtH - dtH * 5);
    // Hunger
    if (cx.cutOff) cx.hungerH += dtH; else cx.hungerH = Math.max(0, cx.hungerH - dtH * 2);
    cx.aidLevel = Math.max(0, cx.aidLevel - dtH * 0.01);
    if (cx.hungerH > 72) {
      c.satisfaction = Math.max(0, c.satisfaction - days * 3 * Math.min(3, 1 + (cx.hungerH - 72) / 96));
      if (cx.hungerH > 168 && cx.aidLevel < 0.2) {
        const cap = c.populationStart * 0.05;
        if (cx.starved < cap) {
          const k = Math.min(cap - cx.starved, c.population * 0.0006 * days);
          cx.starved += k;
          c.population -= k;
          c.killed += k;
          this.stats.killed += k;
          const key = `${c.id}||starvation`;
          let p = this.pending.get(key);
          if (!p) { p = { cityId: c.id, attacker: '', cause: 'starvation', killed: 0, wounded: 0, t0: this.clock }; this.pending.set(key, p); }
          p.killed += k;
          p.wounded += k * 0.5;
        }
      }
    }
    // Zufriedenheit strebt Zielwert an
    const occupied = c.control === 'occupied' || c.controller !== c.country;
    const target = 60 - c.damage * 35 - (occupied ? 15 : 0) - (cx.hungerH > 72 ? 20 : 0) - clamp((c.killed / Math.max(1, c.populationStart)) * 400, 0, 20) - (recent ? 5 : 0);
    const rate = (c.satisfaction > target ? 8 : 3) * days;
    if (c.satisfaction > target) c.satisfaction = Math.max(target, c.satisfaction - rate);
    else if (!recent) c.satisfaction = Math.min(target, c.satisfaction + rate);
    c.unrest = occupied ? clamp((50 - c.satisfaction) / 50 + 0.1, 0, 1) : clamp((25 - c.satisfaction) / 50, 0, 0.5);
    c.damage = clamp(cx.dmgSum / cx.bcount, c.damage, 1);
  }

  private scanCutOff(c: CivilCity, cx: CityX): void {
    if (c.control === 'ruined') return;
    const out: number[] = [];
    this.graph.edgesInRect(c.x - 30, c.z - 30, c.x + 30, c.z + 30, out);
    let total = 0, closed = 0;
    for (const id of out) {
      const e = this.graph.edges[id];
      if (e.cls === 'rail' || e.cls === 'ferry' || e.cls === 'track') continue;
      total++;
      if (!e.open) closed++;
    }
    cx.cutOff = c.control === 'occupied' || (total > 0 && closed / total >= 0.5);
  }

  private stepFlows(dtH: number): void {
    let reroutes = 0;
    for (let i = this.flows.length - 1; i >= 0; i--) {
      const f = this.flows[i];
      const plan = f.plan;
      if (f.people < 1) { this.flows.splice(i, 1); continue; }
      if (f.reroute && reroutes < 2) {
        reroutes++;
        f.reroute = false;
        const pts = plan.route.points;
        const end = plan.route.points.length / 2 - 1;
        const cur: [number, number] = [0, 0];
        this.planPoint(plan, f.headKm, cur);
        const np = this.makePlan(cur[0], cur[1], pts[end * 2], pts[end * 2 + 1], f.mode, plan.destCity);
        if (np) { f.plan = np; f.headKm = 0; f.seg = 0; f.stallH = 0; } else f.stallH += 0.01;
      }
      const p2 = f.plan;
      // Segment
      while (f.seg + 1 < p2.cum.length - 1 && p2.cum[f.seg + 1] <= f.headKm) f.seg++;
      const edge = p2.edges[f.seg];
      if (edge >= 0 && !this.graph.edges[edge].open) {
        f.stallH += dtH;
        f.reroute = true;
        if (f.stallH > 12) { this.dissolve(f); this.flows.splice(i, 1); }
        continue;
      }
      let v = f.mode === 'walk' ? 4 : Math.min(p2.route.segSpeed[Math.min(f.seg, p2.route.segSpeed.length - 1)] || 20, f.mode === 'car' ? 60 : 80);
      if (edge >= 0) {
        const l = this.load.get(edge) ?? 0;
        if (l > 0.5) v *= 1 - 0.65 * (l - 0.5) * 2;
      }
      f.headKm += Math.max(0.2, v) * dtH;
      if (f.headKm >= p2.cum[p2.cum.length - 1]) {
        this.arrive(f);
        this.flows.splice(i, 1);
      }
    }
  }

  private rebuildLoad(): void {
    this.load.clear();
    if (!this.flows.length) return;
    const occ = new Map<number, number>();
    for (const f of this.flows) {
      const plan = f.plan;
      const L = Math.max(0.1, f.people / FLOW_DENSITY[f.mode]);
      const tail = Math.max(0, f.headKm - L);
      let s = f.seg;
      while (s > 0 && plan.cum[s] > tail) s--;
      for (; s + 1 < plan.cum.length && plan.cum[s] < f.headKm; s++) {
        const e = plan.edges[s];
        if (e < 0) continue;
        const a = Math.max(plan.cum[s], tail), b = Math.min(plan.cum[s + 1], f.headKm);
        if (b > a) occ.set(e, (occ.get(e) ?? 0) + (b - a));
      }
    }
    for (const [e, km] of occ) {
      const len = Math.max(0.3, Math.min(3, this.graph.edges[e].lengthKm));
      this.load.set(e, Math.min(1, km / len));
    }
  }

  // ------------------------------------------------------------------ Hilfe

  private processAid(dtH: number): void {
    if (dtH <= 0) return;
    const seen = new Set<number>();
    for (const u of this.units.units) {
      const id = u.type.id;
      const isAid = id === 'aid_convoy' || id === 'supply_truck';
      const isMedic = id === 'medic_team';
      if (!isAid && !isMedic) continue;
      if (u.speedKmh > 1) { this.carriers.delete(u.id); continue; }
      const c = this.cityAt(u.x, u.z);
      if (!c || c.control === 'ruined') { this.carriers.delete(u.id); continue; }
      const friendly = u.owner === c.controller || u.owner === c.country || getRelation(u.owner, c.country) >= 20 || getRelation(u.owner, c.controller) >= 20;
      if (!friendly) { this.carriers.delete(u.id); continue; }
      seen.add(u.id);
      let st = this.carriers.get(u.id);
      if (!st || st.cityId !== c.id) {
        st = { cityId: c.id, dwellH: 0, consumeH: 0, cargo: u.ammo > 0 ? u.ammo : id === 'supply_truck' ? 20 : 0 };
        this.carriers.set(u.id, st);
      }
      st.dwellH += dtH;
      if (st.dwellH < 0.25) continue;
      st.consumeH += dtH;
      while (st.consumeH >= 0.5) {
        st.consumeH -= 0.5;
        if (isAid) {
          if (st.cargo < 1) break;
          st.cargo -= 1;
          if (u.ammo > 0) u.ammo = Math.max(0, u.ammo - 1);
          this.deliverAid(c.id, 50, u.owner);
        } else {
          const cx = this.cx[c.id];
          cx.wounded = Math.max(0, cx.wounded - 40);
          c.satisfaction = Math.min(100, c.satisfaction + 0.4);
          bus.emit('civil:aid', { cityId: c.id, amount: 5, by: u.owner });
        }
      }
    }
    for (const id of this.carriers.keys()) if (!seen.has(id)) this.carriers.delete(id);
  }

  private recomputeStats(): void {
    let pop = 0, killed = 0, ref = 0;
    for (const c of this.cities) { pop += c.population; killed += c.killed; ref += c.refugees; }
    this.stats.totalPop = pop + ref;
    this.stats.killed = killed;
    this.stats.refugees = ref + this.displacedArrived;
  }

  // ================================================================== Rendering

  private computeCamera(camera: THREE.PerspectiveCamera): void {
    camera.updateMatrixWorld();
    const cam = _v1.setFromMatrixPosition(camera.matrixWorld);
    camera.getWorldDirection(_v2);
    const gy = Math.max(0, this.geo.heightAt(cam.x, cam.z)) * this.exag;
    const dist = _v2.y < -0.05 ? Math.max(0.5, (cam.y - gy * 0.5) / -_v2.y) : Math.max(0.5, cam.y);
    this.camDist = dist;
    this.camFocusX = cam.x + _v2.x * dist;
    this.camFocusZ = cam.z + _v2.z * dist;
  }

  private render(dtH: number, realDt: number, camera: THREE.PerspectiveCamera): void {
    const dist = this.camDist;
    const scrW = typeof window !== 'undefined' ? window.innerWidth || 1280 : 1280;
    const scrH = typeof window !== 'undefined' ? window.innerHeight || 720 : 720;
    const pxPerKm = scrH / (dist * 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    // Ambiente Sichtzeit (kosmetisch): läuft mit der Spielzeit, auf ×10 Echtzeit begrenzt, steht bei Pause
    const gs = realDt > 0 ? clamp((dtH * 3600) / realDt, 0, 10) : 0;
    this.visTime += realDt * gs;

    const showInfra = this.show;
    // --- Infrastruktur-Modelle / Icons / Embleme
    const s = clamp(INFRA_SCALE_K * dist, 1, INFRA_SCALE_MAX);
    const models = showInfra && dist < INFRA_MODEL_MAX;
    const icons = showInfra && dist >= INFRA_ICON_MIN && dist <= INFRA_ICON_MAX;
    const emblems = showInfra && dist <= EMBLEM_MAX;
    for (const k of INFRA_KINDS) this.infraMeshes[k].visible = models;
    this.iconLayer.mesh.visible = icons;
    this.emblemLayer.mesh.visible = emblems;
    for (const L of [this.iconLayer, this.emblemLayer]) {
      (L.mat.uniforms.uScreen.value as THREE.Vector2).set(scrW, scrH);
      L.mat.uniforms.uPxPerKm.value = pxPerKm;
    }
    this.iconLayer.mat.uniforms.uSize.value = 22;
    this.iconLayer.mat.uniforms.uScale.value = 0;
    this.iconLayer.mat.uniforms.uBase.value = 0;
    this.emblemLayer.mat.uniforms.uSize.value = 17;
    this.emblemLayer.mat.uniforms.uScale.value = icons ? 0 : s;
    this.emblemLayer.mat.uniforms.uBase.value = icons ? 22 : 12;

    if (models) this.renderInfraModels(s);
    if (icons || emblems) this.renderMarkers(icons, emblems, s);

    // --- Fahrzeuge / Fußgänger
    for (const k of Object.keys(this.vehCount) as VehicleModel[]) this.vehCount[k] = 0;
    if (this.show && dist < AMBIENT_MAX) {
      const vs = clamp(VEH_SCALE_K * dist, VEH_SCALE_MIN, VEH_SCALE_MAX);
      this.renderAmbient(vs, dist, dtH);
      if (dist < PED_MAX_DIST) this.renderPeds(Math.min(vs, 14), dist);
      this.renderFlowInstances(vs, dist);
    }
    for (const k of Object.keys(this.vehCount) as VehicleModel[]) {
      const m = this.vehMeshes[k];
      m.count = this.vehCount[k];
      m.visible = m.count > 0;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }

    // --- Flusslinien
    this.renderFlowLines(dist);
  }

  private groundY(x: number, z: number): number {
    return Math.max(0, this.geo.heightAt(x, z)) * this.exag;
  }

  private setInst(m: THREE.InstancedMesh, i: number, x: number, y: number, z: number, yaw: number, sc: number, sy: number, col: THREE.Color): void {
    const a = m.instanceMatrix.array as Float32Array;
    const o = i * 16;
    const c = Math.cos(yaw), sn = Math.sin(yaw);
    a[o] = c * sc; a[o + 1] = 0; a[o + 2] = -sn * sc; a[o + 3] = 0;
    a[o + 4] = 0; a[o + 5] = sy; a[o + 6] = 0; a[o + 7] = 0;
    a[o + 8] = sn * sc; a[o + 9] = 0; a[o + 10] = c * sc; a[o + 11] = 0;
    a[o + 12] = x; a[o + 13] = y; a[o + 14] = z; a[o + 15] = 1;
    const ca = m.instanceColor!.array as Float32Array;
    ca[i * 3] = col.r; ca[i * 3 + 1] = col.g; ca[i * 3 + 2] = col.b;
  }

  private addVeh(model: VehicleModel, x: number, z: number, yaw: number, sc: number, col: THREE.Color, lift: number): void {
    const n = this.vehCount[model];
    const m = this.vehMeshes[model];
    if (n >= m.instanceMatrix.count) return;
    this.setInst(m, n, x, this.groundY(x, z) + lift, z, yaw, sc, sc, col);
    this.vehCount[model] = n + 1;
  }

  private renderInfraModels(s: number): void {
    const range = Math.max(40, this.camDist * 2.4);
    const sc = 0.001 * s;
    const col = new THREE.Color();
    for (const k of INFRA_KINDS) {
      const m = this.infraMeshes[k];
      let n = 0;
      for (const i of this.infraIdx[k]) {
        const it = this.infra[i];
        if (Math.abs(it.x - this.camFocusX) > range || Math.abs(it.z - this.camFocusZ) > range) continue;
        const integ = it.integrity;
        let sy = sc;
        let shade = 1;
        let yaw = this.infraYaw[i];
        if (integ <= 0) { sy = sc * 0.12; shade = 0.28; }
        else if (integ < 0.6) shade = 0.55 + integ * 0.7;
        col.setRGB(shade, shade * 0.98, shade * 0.96);
        this.setInst(m, n, it.x, this.infraBase[i] * this.exag - 0.0015 * s, it.z, yaw, sc, sy, col);
        n++;
        yaw = 0;
      }
      m.count = n;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }

  private renderMarkers(icons: boolean, emblems: boolean, s: number): void {
    const range = Math.max(150, this.camDist * 2.4);
    let ni = 0, ne = 0;
    const lift = icons ? 0.4 : 0.02;
    for (const it of this.infra) {
      if (it.integrity <= 0 && !icons) continue;
      if (Math.abs(it.x - this.camFocusX) > range || Math.abs(it.z - this.camFocusZ) > range) continue;
      const y = this.infraBase[it.id] * this.exag + lift;
      if (icons) this.iconLayer.set(ni++, it.x, y, it.z, ICON_CELL[it.kind], 0);
      if (emblems && it.protectedStatus && it.integrity > 0) this.emblemLayer.set(ne++, it.x, y, it.z, EMBLEM_CELL, INFRA_HEIGHT_M[it.kind]);
    }
    void s;
    this.iconLayer.commit(ni);
    this.emblemLayer.commit(ne);
  }

  // ------------------------------------------------------------------ Ambiente Fahrzeuge

  private edgeCumOf(id: number): Float32Array {
    let c = this.edgeCum.get(id);
    if (!c) {
      const g = this.graph.edges[id].geom;
      const n = g.length / 2;
      c = new Float32Array(n);
      for (let i = 1; i < n; i++) c[i] = c[i - 1] + Math.hypot(g[i * 2] - g[i * 2 - 2], g[i * 2 + 1] - g[i * 2 - 1]);
      if (this.edgeCum.size > 6000) this.edgeCum.clear();
      this.edgeCum.set(id, c);
    }
    return c;
  }

  /** Punkt und Richtung bei Strecke d (km) entlang Kante; out p=[x,z], dir=[dx,dz] normiert */
  private sampleEdge(id: number, d: number, p: [number, number], dir: [number, number]): void {
    const g = this.graph.edges[id].geom;
    const cum = this.edgeCumOf(id);
    const n = cum.length;
    let i = 1;
    while (i < n - 1 && cum[i] < d) i++;
    const l = cum[i] - cum[i - 1];
    const t = l > 0 ? clamp((d - cum[i - 1]) / l, 0, 1) : 0;
    const dx = g[i * 2] - g[i * 2 - 2], dz = g[i * 2 + 1] - g[i * 2 - 1];
    p[0] = g[i * 2 - 2] + dx * t;
    p[1] = g[i * 2 - 1] + dz * t;
    const L = Math.hypot(dx, dz) || 1;
    dir[0] = dx / L; dir[1] = dz / L;
  }

  private dayFactor(): number {
    const h = this.hours % 24;
    // Berufsverkehr 7–9 und 16–18, Nacht ruhig
    const peak = Math.exp(-((h - 8) ** 2) / 4) + Math.exp(-((h - 17) ** 2) / 5);
    const base = h > 6 && h < 21 ? 0.55 : 0.15;
    return clamp(base + 0.5 * peak, 0.1, 1.2);
  }

  private refreshAmbient(dist: number): void {
    const R = Math.min(AMBIENT_MAX, Math.max(5, dist * 2.2));
    const fx = this.camFocusX, fz = this.camFocusZ;
    const out: number[] = [];
    this.graph.edgesInRect(fx - R, fz - R, fx + R, fz + R, out);
    const near = this.cities.filter((c) => Math.abs(c.x - fx) < R + 70 && Math.abs(c.z - fz) < R + 70 && c.control !== 'ruined');
    const vs = clamp(VEH_SCALE_K * dist, VEH_SCALE_MIN, VEH_SCALE_MAX);
    const thin = Math.min(1, 7 / vs);
    const day = this.dayFactor();
    const baseD: Record<string, number> = { motorway: 6, primary: 4, secondary: 2.5, road: 1.2, track: 0.2 };
    const list: Array<{ e: number; n: number; speed: number; rail: boolean }> = [];
    let total = 0;
    for (const id of out) {
      const e = this.graph.edges[id];
      if (!e.open || e.cls === 'ferry') continue;
      const gx = e.geom[0], gz = e.geom[1];
      if (Math.abs(gx - fx) > R * 1.3 && Math.abs(e.geom[e.geom.length - 2] - fx) > R * 1.3) { /* weit weg: trotzdem teilweise sichtbar */ }
      if (e.cls === 'rail') {
        const n = hash01(id, 3) < e.lengthKm * 0.05 * day ? 1 : 0;
        if (n) list.push({ e: id, n, speed: 70 + hash01(id, 5) * 30, rail: true });
        continue;
      }
      let boost = 1;
      const mx = (gx + e.geom[e.geom.length - 2]) / 2, mz = (gz + e.geom[e.geom.length - 1]) / 2;
      for (const c of near) {
        const d = Math.hypot(mx - c.x, mz - c.z);
        const pm = Math.sqrt(Math.max(0.05, (c.population / Math.max(1, c.populationStart)) * c.populationStart / 1e6));
        boost = Math.max(boost, 1 + 3.5 * pm * Math.exp(-d / (5 + 5 * pm)));
      }
      const dens = (baseD[e.cls] ?? 1) * boost * day * thin;
      const nf = e.lengthKm * dens;
      const n = Math.floor(nf) + (hash01(id, 11) < nf - Math.floor(nf) ? 1 : 0);
      if (n <= 0) continue;
      list.push({ e: id, n, speed: e.cls === 'motorway' ? 95 : e.cls === 'primary' ? 75 : e.cls === 'secondary' ? 60 : 45, rail: false });
      total += n;
    }
    // Pool-Begrenzung
    if (total > VEH_POOL * 0.9) {
      const f = (VEH_POOL * 0.9) / total;
      for (const l of list) if (!l.rail) l.n = Math.max(0, Math.floor(l.n * f + hash01(l.e, 13)));
    }
    this.ambient = list;
    this.ambientFx = fx; this.ambientFz = fz;
  }

  private renderAmbient(vs: number, dist: number, dtH: number): void {
    void dtH;
    this.ambientTimer += 1;
    const moved = Math.hypot(this.camFocusX - this.ambientFx, this.camFocusZ - this.ambientFz);
    if (this.ambientTimer > 15 || moved > Math.max(0.5, dist * 0.25)) { this.ambientTimer = 0; this.refreshAmbient(dist); }
    const sc = 0.001 * vs;
    const lane = 0.0014 * vs;
    const lift = 0.0008 * vs;
    const t = this.visTime;
    const R = Math.min(AMBIENT_MAX, Math.max(5, dist * 2.2));
    for (const a of this.ambient) {
      const e = this.graph.edges[a.e];
      if (!e.open) continue;
      const len = e.lengthKm;
      if (a.rail) {
        const dir = hash01(a.e, 17) < 0.5 ? 1 : -1;
        const ph = hash01(a.e, 19);
        let pos = ((ph + (dir * t * a.speed) / 3600 / Math.max(0.5, len)) % 1 + 1) % 1;
        pos *= len;
        this.sampleEdge(a.e, pos, this._p, this._d);
        if (Math.abs(this._p[0] - this.camFocusX) > R || Math.abs(this._p[1] - this.camFocusZ) > R) continue;
        const yaw = Math.atan2(this._d[0] * dir, this._d[1] * dir);
        this.addVeh('train', this._p[0], this._p[1], yaw, 0.001 * Math.min(vs, 14), this.white, 0.0008 * Math.min(vs, 14));
        continue;
      }
      for (let k = 0; k < a.n; k++) {
        const h0 = hash01(a.e * 131 + k, 1), h1 = hash01(a.e * 131 + k, 2), h2 = hash01(a.e * 131 + k, 3);
        const dir = h1 < 0.5 ? 1 : -1;
        const spd = a.speed * (0.75 + 0.35 * h2);
        const pos = (((h0 + (dir * t * spd) / 3600 / Math.max(0.3, len)) % 1) + 1) % 1 * len;
        this.sampleEdge(a.e, pos, this._p, this._d);
        if (Math.abs(this._p[0] - this.camFocusX) > R || Math.abs(this._p[1] - this.camFocusZ) > R) continue;
        const dx = this._d[0] * dir, dz = this._d[1] * dir;
        // Rechtsverkehr: Versatz nach rechts der Fahrtrichtung
        const x = this._p[0] - dz * lane, z = this._p[1] + dx * lane;
        const yaw = Math.atan2(dx, dz);
        const hv = hash01(a.e * 977 + k, 4);
        if (hv < 0.5) this.addVeh('car', x, z, yaw, sc, this.carCol[(a.e + k) % this.carCol.length], lift);
        else if (hv < 0.72) this.addVeh('hatch', x, z, yaw, sc, this.carCol[(a.e * 3 + k) % this.carCol.length], lift);
        else if (hv < 0.84) this.addVeh('suv', x, z, yaw, sc, this.carCol[(a.e * 5 + k) % this.carCol.length], lift);
        else if (hv < 0.93) this.addVeh('truck', x, z, yaw, sc, this.truckCol[(a.e + k) % this.truckCol.length], lift);
        else this.addVeh('bus', x, z, yaw, sc, this.busCol[(a.e + k) % this.busCol.length], lift);
      }
    }
  }

  // ------------------------------------------------------------------ Fußgänger

  private citySpots(c: CivilCity): Float32Array {
    const cx = this.cx[c.id];
    if (cx.spots) return cx.spots;
    const rnd = rngFrom(c.name + ':peds');
    const n = Math.round(clamp(80 + Math.sqrt(c.populationStart / 1e6) * 160, 60, 420));
    const list: number[] = [];
    for (let i = 0; i < n * 3 && list.length < n * 5; i++) {
      const r = c.radiusKm * 0.95 * Math.pow(rnd(), 1.4);
      const a = rnd() * Math.PI * 2;
      const x = c.x + Math.cos(a) * r, z = c.z + Math.sin(a) * r;
      if (this.geo.countryAt(x, z) === 0 || this.geo.heightAt(x, z) <= 0.002) continue;
      if (this.buildings.findBuildingAt(x, z, 0.005)) continue;
      const ang = rnd() * Math.PI * 2;
      list.push(x, z, Math.cos(ang), Math.sin(ang), 0.03 + rnd() * 0.07);
    }
    cx.spots = new Float32Array(list);
    return cx.spots;
  }

  private renderPeds(ps: number, dist: number): void {
    const R = Math.max(2.5, dist * 2.2);
    const sc = 0.001 * ps;
    const t = this.visTime;
    const night = this.hours % 24 > 6 && this.hours % 24 < 22 ? 1 : 0.2;
    let total = 0;
    for (const c of this.cities) {
      if (total >= PED_POOL) break;
      if (c.control === 'ruined') continue;
      if (Math.abs(c.x - this.camFocusX) > R + c.radiusKm || Math.abs(c.z - this.camFocusZ) > R + c.radiusKm) continue;
      const frac = clamp(c.population / Math.max(1, c.populationStart), 0, 1.5) * night;
      if (frac <= 0.01) continue;
      const spots = this.citySpots(c);
      const cnt = spots.length / 5;
      const take = Math.floor(cnt * Math.min(1, frac));
      const panic = this.clock - this.cx[c.id].lastAttack < 3600 ? 3 : 1;
      for (let i = 0; i < take && total < PED_POOL; i++) {
        const o = i * 5;
        const span = spots[o + 4];
        const phase = ((t * 0.0014 * panic * (0.6 + hash01(i, c.id)) + hash01(i, 7)) % 2);
        const f = phase < 1 ? phase : 2 - phase;
        const dir = phase < 1 ? 1 : -1;
        const x = spots[o] + spots[o + 2] * span * (f - 0.5), z = spots[o + 1] + spots[o + 3] * span * (f - 0.5);
        if (Math.abs(x - this.camFocusX) > R || Math.abs(z - this.camFocusZ) > R) continue;
        const yaw = Math.atan2(spots[o + 2] * dir, spots[o + 3] * dir);
        this.addVeh(hash01(i, 9) < 0.2 ? 'pedPack' : 'ped', x, z, yaw, sc, this.clothCol[(i + c.id) % this.clothCol.length], 0.0004 * ps);
        total++;
      }
    }
  }

  // ------------------------------------------------------------------ Flüchtlingsströme

  private renderFlowInstances(vs: number, dist: number): void {
    if (!this.flows.length) return;
    const R = Math.max(5, dist * 2.2);
    const sc = 0.001 * vs;
    const psc = 0.001 * Math.min(vs, 14);
    for (const f of this.flows) {
      const plan = f.plan;
      this.planPoint(plan, f.headKm, this._p);
      const L = Math.max(0.12, f.people / FLOW_DENSITY[f.mode]);
      const tail = Math.max(0, f.headKm - L);
      const occ = f.headKm - tail;
      if (occ <= 0.001) continue;
      // grob: Kopf/Mitte/Schwanz in Sichtweite?
      const hx = this._p[0], hz = this._p[1];
      this.planPoint(plan, tail, this._d);
      const nearHead = Math.abs(hx - this.camFocusX) < R + occ && Math.abs(hz - this.camFocusZ) < R + occ;
      if (!nearHead) continue;
      if (f.mode === 'rail') {
        const seg = this.planPoint(plan, f.headKm, this._p);
        const p = plan.route.points;
        const yaw = Math.atan2(p[seg * 2 + 2] - p[seg * 2], p[seg * 2 + 3] - p[seg * 2 + 1]);
        this.addVeh('train', this._p[0], this._p[1], yaw, 0.001 * Math.min(vs, 14), this.white, 0.0008 * Math.min(vs, 14));
        continue;
      }
      const carLike = f.mode === 'car';
      const lenM = carLike ? 4.6 * vs : 0.7 * Math.min(vs, 14);
      const minGap = (lenM * 1.15) / 1000;
      const want = carLike ? f.people / 2.3 : f.people / 6;
      const n = Math.min(Math.floor(occ / minGap), Math.floor(want), carLike ? 240 : 400);
      if (n <= 0) continue;
      const gap = occ / n;
      for (let i = 0; i < n; i++) {
        const d = f.headKm - i * gap - hash01(f.id * 977 + i, 1) * gap * 0.3;
        if (d < 0) break;
        const seg = this.planPoint(plan, d, this._p);
        const p = plan.route.points;
        const dx = p[seg * 2 + 2] - p[seg * 2], dz = p[seg * 2 + 3] - p[seg * 2 + 1];
        const l = Math.hypot(dx, dz) || 1;
        const nx = dx / l, nz = dz / l;
        const lane = ((i % (carLike ? 2 : 3)) - (carLike ? 0.5 : 1)) * (carLike ? 0.0016 * vs : 0.0008 * Math.min(vs, 14));
        const x = this._p[0] - nz * lane, z = this._p[1] + nx * lane;
        if (Math.abs(x - this.camFocusX) > R || Math.abs(z - this.camFocusZ) > R) continue;
        const yaw = Math.atan2(nx, nz);
        const hv = hash01(f.id * 31 + i, 2);
        if (carLike) {
          if (hv < 0.55) this.addVeh('carLoaded', x, z, yaw, sc, this.carCol[(i + f.id) % this.carCol.length], 0.0008 * vs);
          else if (hv < 0.75) this.addVeh('hatch', x, z, yaw, sc, this.carCol[(i * 3 + f.id) % this.carCol.length], 0.0008 * vs);
          else if (hv < 0.9) this.addVeh('bus', x, z, yaw, sc, this.busCol[i % this.busCol.length], 0.0008 * vs);
          else this.addVeh('truck', x, z, yaw, sc, this.truckCol[i % this.truckCol.length], 0.0008 * vs);
        } else {
          this.addVeh(hv < 0.7 ? 'pedPack' : 'ped', x, z, yaw, psc, this.clothCol[(i + f.id) % this.clothCol.length], 0.0004 * Math.min(vs, 14));
        }
      }
    }
  }

  private renderFlowLines(dist: number): void {
    const lines = this.flowLines.geometry as THREE.BufferGeometry;
    const dots = this.flowDots.geometry as THREE.BufferGeometry;
    const vis = this.show && dist >= FLOW_LINE_MIN && dist <= FLOW_LINE_MAX && this.flows.length > 0;
    this.flowLines.visible = vis;
    this.flowDots.visible = vis;
    if (!vis) return;
    const lift = 0.03 + dist * 0.002;
    let nv = 0, nd = 0;
    const T = this.realClock;
    for (const f of this.flows) {
      const plan = f.plan;
      const L = Math.max(0.3, f.people / FLOW_DENSITY[f.mode]);
      const tail = Math.max(0, f.headKm - L);
      const occ = f.headKm - tail;
      const segs = clamp(Math.ceil(occ / 1.2), 1, 24);
      const col = f.mode === 'car' ? [1.0, 0.72, 0.2] : f.mode === 'walk' ? [0.95, 0.95, 0.88] : [0.45, 0.75, 1.0];
      const k = 0.65 + 0.35 * Math.sin(T * 4 + f.id);
      let px = 0, py = 0, pz = 0;
      for (let i = 0; i <= segs; i++) {
        this.planPoint(plan, tail + (occ * i) / segs, this._p);
        const y = this.groundY(this._p[0], this._p[1]) + lift;
        if (i > 0) {
          const o = nv * 3;
          this.flowLinePos[o] = px; this.flowLinePos[o + 1] = py; this.flowLinePos[o + 2] = pz;
          this.flowLinePos[o + 3] = this._p[0]; this.flowLinePos[o + 4] = y; this.flowLinePos[o + 5] = this._p[1];
          for (let q = 0; q < 2; q++) { this.flowLineCol[o + q * 3] = col[0] * k; this.flowLineCol[o + q * 3 + 1] = col[1] * k; this.flowLineCol[o + q * 3 + 2] = col[2] * k; }
          nv += 2;
        }
        px = this._p[0]; py = y; pz = this._p[1];
      }
      // Kopf-Punkt
      const o = nd * 3;
      this.flowDotPos[o] = px; this.flowDotPos[o + 1] = py + lift * 0.5; this.flowDotPos[o + 2] = pz;
      this.flowDotCol[o] = col[0]; this.flowDotCol[o + 1] = col[1]; this.flowDotCol[o + 2] = col[2];
      nd++;
    }
    lines.setDrawRange(0, nv);
    (lines.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (lines.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    dots.setDrawRange(0, nd);
    (dots.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (dots.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();

/** Fläche der Schnittmenge zweier Kreise (Radien R, r; Mittelpunktsabstand d) */
function circleOverlap(R: number, r: number, d: number): number {
  if (d >= R + r) return 0;
  if (d <= Math.abs(R - r)) return Math.PI * Math.min(R, r) ** 2;
  const a = R * R * Math.acos(clamp((d * d + R * R - r * r) / (2 * d * R), -1, 1));
  const b = r * r * Math.acos(clamp((d * d + r * r - R * R) / (2 * d * r), -1, 1));
  const c = 0.5 * Math.sqrt(Math.max(0, (-d + r + R) * (d + r - R) * (d - r + R) * (d + r + R)));
  return a + b - c;
}
