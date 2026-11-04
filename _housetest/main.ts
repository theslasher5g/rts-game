import * as THREE from 'three';
import { GeoData } from '../src/world/GeoData';
import { GameRenderer } from '../src/render/GameRenderer';
import { Terrain } from '../src/world/Terrain';
import { Water } from '../src/world/Water';
import { Cities } from '../src/world/Cities';
import { Villages } from '../src/world/Villages';
import { DEFAULT_SETTINGS } from '../src/core/types';

(async () => {
  const settings = { ...DEFAULT_SETTINGS, pixelScale: 3 };
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  const geo = await GeoData.load();
  const gfx = new GameRenderer(canvas, settings);
  gfx.setSize(960, 540);
  const terrain = new Terrain(geo, settings);
  const water = new Water(geo, settings, terrain.heightTexture);
  const cities = new Cities(geo, settings);
  const villages = new Villages(geo, settings, cities);
  gfx.scene.add(terrain.object, water.object, cities.object, villages.object);
  const cam = new THREE.PerspectiveCamera(45, 960 / 540, 0.05, 10000);
  let time = 0;
  const w = window as any;
  w.T = { geo, cities, villages, cam, gfx, settings, THREE };
  w.go = (x: number, z: number, dist: number, pitchDeg: number, yawDeg: number) => {
    const e = settings.heightExaggeration;
    const gy = Math.max(0, geo.heightAt(x, z)) * e;
    const p = pitchDeg * Math.PI / 180, y = yawDeg * Math.PI / 180;
    cam.position.set(x - Math.sin(y) * Math.cos(p) * dist, gy + Math.sin(p) * dist, z - Math.cos(y) * Math.cos(p) * dist);
    cam.lookAt(x, gy, z);
    cam.updateMatrixWorld();
  };
  w.frame = (n = 3) => {
    for (let i = 0; i < n; i++) {
      time += 0.05;
      terrain.update(cam, time); water.update(cam, time); cities.update(cam); villages.update(cam);
      const a = (w.extraUpdate as any); if (a) a(time);
      gfx.render(cam, time);
    }
    return true;
  };
  w.ready = true;
})();
