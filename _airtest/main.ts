import * as THREE from 'three';
import { GameRenderer } from '../src/render/GameRenderer';
import { GeoData } from '../src/world/GeoData';
import { UnitManager } from '../src/units/UnitManager';
import { UnitRenderer } from '../src/units/UnitRenderer';
import { buildModels } from '../src/units/models';
import { DEFAULT_SETTINGS } from '../src/core/types';

interface Cfg {
  units: Array<{ type: string; owner: string; dx: number; dz: number; heading?: number; posture?: string; engaged?: boolean; speed?: number; airborne?: boolean; alt?: number; target?: number; members?: number }>;
  cam: { dx: number; dz: number; dist: number; pitch: number; yaw: number };
  land?: boolean;
  sea?: boolean;
}

async function main() {
  const M = buildModels();
  console.log('TRIS ' + Object.keys(M).map((k) => `${k}=${M[k].geom.getAttribute('position').count / 3}${M[k].lod ? '/lod' + M[k].lod.geom.getAttribute('position').count / 3 : ''}`).join(' '));
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  const settings = { ...DEFAULT_SETTINGS, pixelScale: 3 };
  const gfx = new GameRenderer(canvas, settings);
  gfx.applySettings(settings);
  gfx.setSize(960, 540);
  const geo = await GeoData.load();
  // Meeresstelle suchen
  let bx = 0, bz = 0, found = false;
  for (let x = 10; x < geo.widthKm - 10 && !found; x += 4) for (let z = 10; z < geo.heightKm - 10 && !found; z += 4) {
    let ok = true;
    for (let dx = -6; dx <= 6 && ok; dx += 3) for (let dz = -6; dz <= 6 && ok; dz += 3) if (geo.countryAt(x + dx, z + dz) !== 0 || geo.heightAt(x + dx, z + dz) > 0.001 || !geo.inside(x + dx, z + dz)) ok = false;
    if (ok) { bx = x; bz = z; found = true; }
  }
  let cnt = 0; for (let i = 0; i < geo.countryIds.length; i++) if (geo.countryIds[i] === 0) cnt++;
  console.log('zero ids', cnt, geo.countryIds.length, geo.widthKm, geo.heightKm, geo.heightAt(10,10));
  console.log('sea', bx, bz, found);
  const routes = { findRoute: () => null, passable: () => true, nearestPassable: (x: number, z: number) => [x, z] as [number, number] };
  const mgr = new UnitManager(geo, routes as never, settings);
  const ur = new UnitRenderer(mgr, geo, settings);
  gfx.scene.add(ur.object);
  const land = new THREE.Mesh(new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x5a6a3a }));
  land.scale.set(100, 1, 100);
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x2a5a78 }));
  sea.scale.set(100, 1, 100);
  gfx.scene.add(land, sea);
  const cam = new THREE.PerspectiveCamera(32, 960 / 540, 0.01, 10000);
  let time = 0;
  const w = window as unknown as Record<string, unknown>;
  const spawned: ReturnType<UnitManager['spawn']>[] = [];
  let cfg: Cfg | null = null;
  w.setup = (c: Cfg) => {
    cfg = c;
    for (const u of [...mgr.units]) mgr.remove(u.id);
    spawned.length = 0;
    land.visible = !!c.land; sea.visible = !!c.sea;
    land.position.set(bx, 0.0005, bz); sea.position.set(bx, 0, bz);
    for (const d of c.units) {
      const u = mgr.spawn(d.type, d.owner, bx + d.dx, bz + d.dz, d.heading ?? 0);
      if (!u) { console.warn('spawn fail', d.type); continue; }
      u.posture = (d.posture as never) ?? 'stand';
      u.engaged = d.engaged; u.speedKmh = d.speed ?? 0; u.airborne = !!d.airborne;
      if (d.alt !== undefined) u.y = d.alt;
      if (d.members) u.membersAlive = d.members;
      spawned.push(u);
    }
    // zweites Ziel
  };
  w.tick = (n: number, dt: number) => {
    for (let i = 0; i < n; i++) {
      time += dt;
      if (cfg) cfg.units.forEach((d, k) => {
        const u = spawned[k]; if (!u) return;
        if (d.speed) { const v = d.speed / 3600 * dt; u.x += Math.sin(u.heading) * v; u.z -= Math.cos(u.heading) * v; }
        if (d.alt !== undefined) u.y = d.alt;
      });
      const c = cfg!.cam;
      const tx = bx + c.dx, tz = bz + c.dz;
      const pr = (c.pitch * Math.PI) / 180, yw = (c.yaw * Math.PI) / 180;
      const ty = (c as { dy?: number }).dy ?? 0;
      cam.position.set(tx + Math.sin(yw) * Math.cos(pr) * c.dist, ty + Math.sin(pr) * c.dist, tz + Math.cos(yw) * Math.cos(pr) * c.dist);
      cam.lookAt(tx, ty, tz);
      cam.updateMatrixWorld();
      ur.update(cam, time, "DEU");
    }
    gfx.render(cam, time);
  };
  w.ready = true;
  w.mgr = mgr; w.geo = geo;
}
main();
