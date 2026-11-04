import * as THREE from 'three';
import { GeoData } from '../src/world/GeoData';
import { GameRenderer } from '../src/render/GameRenderer';
import { Terrain } from '../src/world/Terrain';
import { Water } from '../src/world/Water';
import { Cities, BuildingLayer, STRIDE } from '../src/world/Cities';
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
  w.go = (x: number, z: number, dist: number, pitchDeg: number, yawDeg: number, yoff = 0) => {
    const e = settings.heightExaggeration;
    const gy = Math.max(0, w.flatBase ?? geo.heightAt(x, z)) * e + yoff;
    const p = pitchDeg * Math.PI / 180, y = yawDeg * Math.PI / 180;
    cam.position.set(x - Math.sin(y) * Math.cos(p) * dist, gy + Math.sin(p) * dist, z - Math.cos(y) * Math.cos(p) * dist);
    cam.lookAt(x, gy, z);
    cam.updateMatrixWorld();
  };
  w.frame = (n = 3) => {
    for (let i = 0; i < n; i++) {
      time += 0.05;
      if (terrain.object.visible) { terrain.update(cam, time); water.update(cam, time); } cities.update(cam); villages.update(cam);
      const a = (w.extraUpdate as any); if (a) a(time);
      gfx.render(cam, time);
    }
    return true;
  };
  // Showcase: Reihe je Typ x Zustand auf freiem Gelände
  const SZ = [[.03,.022,.04],[.03,.02,.036],[.075,.04,.036],[.16,.035,.026],[.15,.012,.055],[.04,.04,.04],[.018,.08,.018],[.075,.15,.075],[.075,.075,.04],[.12,.011,.05],[.03,.011,.026],[.05,.013,.03],[.06,.008,.025],[.035,.022,.02]];
  w.showcase = (x0: number, z0: number, types: number[], states: number[], gap = 0.18, style = 0) => {
    const data: number[] = [], typ: number[] = [], roof: number[] = [], integ: number[] = [];
    types.forEach((t, r) => states.forEach((st, c) => {
      const x = x0 + c * gap, z = z0 + r * gap;
      const base = w.flatBase ?? Math.max(0.0005, geo.heightAt(x, z));
      const [ww, hh, dd] = SZ[t];
      data.push(x, z, ww, hh, dd, 0, base, [0xd6cdb4, 0xc9a98a, 0xc0ccd4, 0xd0ccbf, 0xb0b2ae, 0xb9b5aa, 0xb0a090, 0xc0ccd4, 0xcbbf9f, 0xb0b2ae, 0xe0cfa8, 0x9a6a55, 0xb08468, 0xd6cdb4][t]);
      typ.push(t); roof.push(([0xb8644a, 0xc8683f, 0x8a8884, 0x8a8884, 0x80868a, 0x888880, 0, 0x8a8884, 0x4a4d54, 0x959a9e, 0xa65a42, 0x6a4a3a, 0x7a3a2e, 0x5a6a5a][t] | (style << 24)) >>> 0); integ.push(st);
    }));
    const layer = new BuildingLayer(new Float32Array(data), Uint8Array.from(typ), Uint32Array.from(roof), new Float32Array(integ));
    layer.setExag(settings.heightExaggeration);
    gfx.scene.add(layer.group);
    w.layers = (w.layers || []); w.layers.push(layer);
    return STRIDE;
  };
  w.flat = (x: number, z: number) => {
    const hb = Math.max(0.0005, geo.heightAt(x, z));
    w.flatBase = hb;
    terrain.object.visible = false; water.object.visible = false;
    const pl = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshBasicMaterial({ color: 0x6f6a4a }));
    pl.rotation.x = -Math.PI / 2; pl.position.set(x, hb * settings.heightExaggeration, z);
    gfx.scene.add(pl);
    return hb;
  };
  w.extraUpdate = (_t: number) => { for (const l of (w.layers || [])) l.update(cam.position, true); };
  w.ready = true;
})();
