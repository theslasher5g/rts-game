import { bus } from '../src/core/EventBus';
import { Input } from '../src/core/Input';
import { RTSCamera } from '../src/camera/RTSCamera';
import { loadSettings } from '../src/ui/SettingsPanel';
import { GeoData } from '../src/world/GeoData';
import { NavGraph } from '../src/nav/NavGraph';
import { Pathfinder } from '../src/nav/Pathfinder';
import { GameRenderer } from '../src/render/GameRenderer';
import { Terrain } from '../src/world/Terrain';
import { Water } from '../src/world/Water';
import { Cities } from '../src/world/Cities';
import { WorldDetail } from '../src/world/WorldDetail';
import { RoadRenderer } from '../src/nav/RoadRenderer';
import { BridgeRenderer } from '../src/structures/BridgeRenderer';
import { StructureManager } from '../src/structures/StructureManager';
import { UnitManager } from '../src/units/UnitManager';
import { UnitRenderer } from '../src/units/UnitRenderer';
import { Effects } from '../src/fx/Effects';
import { cityRadiusKm } from '../src/world/Cities';

async function boot() {
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
  const settings = loadSettings();
  settings.pixelScale = 2;
  const geo = await GeoData.load(undefined, () => {});
  const graph = await NavGraph.load(geo);
  const pathfinder = new Pathfinder(geo, graph);
  const gfx = new GameRenderer(canvas, settings);
  const terrain = new Terrain(geo, settings);
  const water = new Water(geo, settings, terrain.heightTexture);
  const cities = new Cities(geo, settings);
  const worldDetail = new WorldDetail(geo, settings, cities, graph);
  gfx.scene.add(worldDetail.object);
  const roads = new RoadRenderer(geo, graph, settings);
  gfx.scene.add(terrain.object, water.object, roads.object, cities.object);
  const input = new Input(canvas);
  const rts = new RTSCamera(canvas, input, geo, settings);
  const units = new UnitManager(geo, pathfinder, settings);
  const unitRenderer = new UnitRenderer(units, geo, settings);
  gfx.scene.add(unitRenderer.object);
  const structures = new StructureManager(geo, units, graph, cities, settings);
  const bridges = new BridgeRenderer(geo, graph, settings);
  const effects = new Effects(geo, settings);
  gfx.scene.add(structures.object, bridges.object, effects.object);
  gfx.setSize(window.innerWidth, window.innerHeight);
  rts.setAspect(window.innerWidth / window.innerHeight);

  // --- Ort: Stadtrand mit Straße
  const params = new URLSearchParams(location.search);
  const cityName = params.get('city') ?? 'Felsenau';
  const city = geo.meta.cities.find((c: { name: string }) => c.name === cityName)!;
  const rad = cityRadiusKm(city.pop, city.capital);
  let best: { x: number; z: number; edge: number; t: number } | null = null;
  let bd = 1e9;
  for (let a = 0; a < 360; a += 10) {
    const px = city.pos[0] + Math.cos((a * Math.PI) / 180) * (rad + 0.15);
    const pz = city.pos[1] + Math.sin((a * Math.PI) / 180) * (rad + 0.15);
    const hit = graph.nearestEdgePoint(px, pz, 0.6, (e) => e.cls === 'primary' || e.cls === 'secondary' || e.cls === 'road');
    if (hit && hit.distKm < bd) { bd = hit.distKm; best = { x: hit.x, z: hit.z, edge: hit.edge, t: hit.t }; }
  }
  if (!best) throw new Error('no road');
  const e = graph.edges[best.edge];
  const p0 = graph.pointOnEdge(best.edge, Math.max(0, best.t - 0.02));
  const p1 = graph.pointOnEdge(best.edge, Math.min(1, best.t + 0.02));
  let dx = p1[0] - p0[0], dz = p1[1] - p0[1];
  const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
  const heading = Math.atan2(dx, -dz);
  const px = -dz, pz = dx; // perpendicular
  const X = best.x, Z = best.z;
  void e;
  // Einheiten auf der Straße (Kolonne) und daneben
  const spawn = (type: string, along: number, side: number) => units.spawn(type, 'VAL', X + dx * along + px * side, Z + dz * along + pz * side, heading);
  spawn('mbt_medium', 0, 0);
  spawn('mbt_medium', 0.12, 0);
  spawn('ifv', -0.1, 0);
  spawn('apc_wheeled', -0.2, 0);
  spawn('inf_squad', 0.04, 0.05);
  spawn('inf_squad', -0.04, -0.06);
  // Graben + Sandsäcke
  structures.addRemote({ id: 9001, kind: 'trench', owner: 'VAL', points: [X + px * 0.12 - dx * 0.1, Z + pz * 0.12 - dz * 0.1, X + px * 0.12 + dx * 0.1, Z + pz * 0.12 + dz * 0.1], progress: 1, hp: 100, hpMax: 100 }, X, Z, -1);
  structures.addRemote({ id: 9002, kind: 'bunker', owner: 'VAL', points: [X - px * 0.12, Z - pz * 0.12], progress: 1, hp: 100, hpMax: 100 }, X, Z, -1);
  // Krater, Wrack, Explosion
  for (let i = 0; i < 4; i++) bus.emit('combat:impact', { weapon: 'howitzer', x: X + dx * (0.2 + i * 0.03) + px * 0.03, y: 0, z: Z + dz * (0.2 + i * 0.03) + pz * 0.03, surface: 'dirt', radiusKm: 0.01 } as never);
  bus.emit('wreck:spawn', { x: X + dx * 0.3 - px * 0.03, y: 0, z: Z + dz * 0.3 - pz * 0.03, heading: 1, category: 'tank', typeId: 'mbt_medium', owner: 'VAL' } as never);
  bus.emit('combat:explosion', { x: X + dx * 0.35, y: 0, z: Z + dz * 0.35, size: 'medium', fire: true } as never);
  units.update(0);

  let time = 0;
  const frame = (dt: number) => {
    time += dt;
    rts.update(dt);
    terrain.update(rts.camera, time);
    water.update(rts.camera, time);
    cities.update(rts.camera);
    worldDetail.update(rts.camera, time);
    roads.update(rts.camera);
    bridges.update(rts.camera);
    structures.updateView(rts.camera);
    unitRenderer.update(rts.camera, time, 'VAL');
    effects.update(dt, rts.camera, time, units.units);
    gfx.render(rts.camera, time);
  };
  (window as unknown as Record<string, unknown>).__view = (distKm: number, n = 40) => {
    rts.focus(X, Z, distKm, false);
    for (let i = 0; i < n; i++) frame(0.05);
    return { counters: unitRenderer.showingCounters, dist: unitRenderer.cameraDistanceKm, pos: [X, Z], heading };
  };
  (window as unknown as Record<string, unknown>).__ready = true;
}
boot().catch((e) => { console.error(e); (window as unknown as Record<string, unknown>).__err = String(e); });
