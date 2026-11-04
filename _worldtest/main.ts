import { GeoData } from '../src/world/GeoData';
import { GameRenderer } from '../src/render/GameRenderer';
import { Terrain } from '../src/world/Terrain';
import { Water } from '../src/world/Water';
import { Cities } from '../src/world/Cities';
import { RTSCamera } from '../src/camera/RTSCamera';
import { Input } from '../src/core/Input';
import { DEFAULT_SETTINGS } from '../src/core/types';
import { NavGraph } from '../src/nav/NavGraph';
import * as WD from '../src/world/WorldDetail';

async function boot() {
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  const settings = { ...DEFAULT_SETTINGS, politicalOverlay: 0.2 };
  const geo = await GeoData.load(undefined);
  const graph = await NavGraph.load(geo);
  const gfx = new GameRenderer(canvas, settings);
  const terrain = new Terrain(geo, settings);
  const water = new Water(geo, settings, terrain.heightTexture);
  let t0 = performance.now();
  const cities = new Cities(geo, settings);
  const tCities = performance.now() - t0;
  gfx.scene.add(terrain.object, water.object, cities.object);
  let detail: any = null;
  const WDc = (WD as any).WorldDetail;
  if (WDc) { t0 = performance.now(); detail = new WDc(geo, settings, cities, graph); gfx.scene.add(detail.object); (window as any).tDetail = performance.now() - t0; }
  const input = new Input(canvas);
  const rts = new RTSCamera(canvas, input, geo, settings);
  rts.setAspect(canvas.clientWidth / canvas.clientHeight);
  gfx.setSize(canvas.clientWidth, canvas.clientHeight);
  let time = 0;
  const w = window as any;
  w.cities = cities; w.geo = geo; w.detail = detail; w.tCities = tCities;
  w.go = (x: number, z: number, dist: number, yaw = 0) => {
    rts.focus(x, z, dist, false);
    (rts as any).yaw = yaw; (rts as any).goalYaw = yaw;
    for (let i = 0; i < 3; i++) rts.update(0.016);
  };
  w.goCity = (name: string, dist: number) => {
    const c = geo.meta.cities.find((c) => c.name === name)!;
    w.go(c.pos[0], c.pos[1], dist);
  };
  w.goLL = (lon: number, lat: number, dist: number) => { const p = geo.lonLatToWorld(lon, lat); w.go(p[0], p[1], dist); };
  w.frames = (n: number) => {
    gfx.renderer.info.autoReset = false;
    const t = performance.now();
    for (let i = 0; i < n; i++) { time += 0.016; rts.update(0.016); terrain.update(rts.camera, time); water.update(rts.camera, time); cities.update(rts.camera); detail?.update(rts.camera, time); gfx.renderer.info.reset(); gfx.render(rts.camera, time); }
    return (performance.now() - t) / n;
  };
  w.info = () => ({ calls: gfx.renderer.info.render.calls, tris: gfx.renderer.info.render.triangles, cam: rts.camera.position.toArray() });
  w.ready = true;
}
boot().catch((e) => { console.error(e); (window as any).err = String(e); });
