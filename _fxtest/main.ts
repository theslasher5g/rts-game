import { bus } from '../src/core/EventBus';
import { Input } from '../src/core/Input';
import { DEFAULT_SETTINGS } from '../src/core/types';
import { RTSCamera } from '../src/camera/RTSCamera';
import { GameRenderer } from '../src/render/GameRenderer';
import { GeoData } from '../src/world/GeoData';
import { Terrain } from '../src/world/Terrain';
import { Water } from '../src/world/Water';
import { Effects } from '../src/fx/Effects';
import { Sfx } from '../src/audio/Sfx';

async function boot() {
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
  const settings = { ...DEFAULT_SETTINGS };
  const geo = await GeoData.load();
  const gfx = new GameRenderer(canvas, settings);
  const terrain = new Terrain(geo, settings);
  const water = new Water(geo, settings, terrain.heightTexture);
  gfx.scene.add(terrain.object, water.object);
  const input = new Input(canvas);
  const rts = new RTSCamera(canvas, input, geo, settings);
  const fx = new Effects(geo, settings);
  gfx.scene.add(fx.object);
  const sfx = new Sfx();
  const resize = () => { gfx.setSize(window.innerWidth, window.innerHeight); rts.setAspect(window.innerWidth / window.innerHeight); };
  resize();
  let last = performance.now(), t0 = last, frames = 0, upMs = 0;
  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    rts.update(dt);
    const a = performance.now();
    fx.update(dt, rts.camera, (now - t0) / 1000);
    upMs += performance.now() - a; frames++;
    fx.shake.apply(rts.camera, dt);
    terrain.update(rts.camera, (now - t0) / 1000);
    water.update(rts.camera, (now - t0) / 1000);
    sfx.update(rts.camera);
    gfx.render(rts.camera, (now - t0) / 1000);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  (window as any).T = { geo, fx, bus, rts, sfx, gfx, stats: () => ({ upMs: upMs / Math.max(1, frames), particles: fx.particleCount }) };
  (window as any).READY = true;
}
boot().catch((e) => { console.error(e); (window as any).ERR = String(e); });
