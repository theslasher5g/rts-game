import { Input } from '../src/core/Input';
import { DEFAULT_SETTINGS } from '../src/core/types';
import { RTSCamera } from '../src/camera/RTSCamera';
import { GameRenderer } from '../src/render/GameRenderer';
import { GeoData } from '../src/world/GeoData';
import { Terrain } from '../src/world/Terrain';
import { Water } from '../src/world/Water';
import { NavGraph } from '../src/nav/NavGraph';
import { RoadRenderer } from '../src/nav/RoadRenderer';
import { BridgeRenderer } from '../src/structures/BridgeRenderer';
import { bus } from '../src/core/EventBus';
import { terrainHeightKm } from '../src/world/Cities';

async function boot() {
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  const settings = { ...DEFAULT_SETTINGS, pixelScale: 3 };
  const geo = await GeoData.load();
  const graph = await NavGraph.load(geo);
  const gfx = new GameRenderer(canvas, settings);
  const terrain = new Terrain(geo, settings);
  const water = new Water(geo, settings, terrain.heightTexture);
  const roads = new RoadRenderer(geo, graph, settings);
  const bridges = new BridgeRenderer(geo, graph, settings);
  gfx.scene.add(terrain.object, water.object, roads.object, bridges.object);
  const input = new Input(canvas);
  const rts = new RTSCamera(canvas, input, geo, settings);
  let time = 0;
  const tick = (n: number) => {
    for (let i = 0; i < n; i++) {
      time += 0.016;
      rts.update(0.016);
      terrain.update(rts.camera, time);
      water.update(rts.camera, time);
      roads.update(rts.camera);
      bridges.update(rts.camera);
    }
    gfx.render(rts.camera, time);
  };
  const go = (x: number, z: number, dist: number, yaw = 0) => {
    rts.focus(x, z, dist, false);
    (rts as any).goalYaw = yaw; (rts as any).yaw = yaw;
    rts.update(0.016);
  };
  const apply = () => { gfx.applySettings(settings); terrain.applySettings(settings); water.applySettings(settings); roads.applySettings(settings); bridges.applySettings(settings); };
  (window as any).__t = { geo, graph, rts, gfx, roads, bridges, settings, bus, tick, go, apply, terrainHeightKm };
  (window as any).__ready = true;
}
boot().catch((e) => { console.error(e); (window as any).__err = String(e); });
