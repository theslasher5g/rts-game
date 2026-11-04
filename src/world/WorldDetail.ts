import * as THREE from 'three';
import type { GeoData } from './GeoData';
import type { Settings } from '../core/types';
import type { NavGraph } from '../nav/NavGraph';
import type { Cities } from './Cities';
import { Vegetation, type Season } from './Vegetation';
import { Villages } from './Villages';

/**
 * Fassade für Phase 4 "Weltdetails": Vegetation (Wälder/Bäume/Hecken) + Dörfer.
 * main.ts: `const wd = new WorldDetail(geo, settings, cities, graph); scene.add(wd.object);`
 * pro Frame `wd.update(camera, time)`, bei Einstellungsänderung `wd.applySettings(s)`.
 */
export class WorldDetail {
  readonly object: THREE.Object3D;
  readonly vegetation: Vegetation;
  readonly villages: Villages;

  constructor(geo: GeoData, settings: Settings, cities: Cities, graph?: NavGraph) {
    this.vegetation = new Vegetation(geo, settings, graph);
    this.villages = new Villages(geo, settings, cities, graph);
    this.vegetation.setClearingProvider((x0, z0, x1, z1) => this.villages.clearingsInRect(x0, z0, x1, z1));
    const g = new THREE.Group();
    g.name = 'WorldDetail';
    g.add(this.villages.object, this.vegetation.object);
    this.object = g;
  }

  update(camera: THREE.PerspectiveCamera, timeSec: number): void {
    this.villages.update(camera);
    this.vegetation.update(camera, timeSec);
  }

  applySettings(s: Settings): void {
    this.vegetation.applySettings(s);
    this.villages.applySettings(s);
  }

  setSeason(s: Season): void {
    this.vegetation.setSeason(s);
  }

  /** Waldanteil 0..1 (Gameplay-Hook: Deckung/Tarnung) */
  forestDensityAt(x: number, z: number): number {
    return this.vegetation.forestDensityAt(x, z);
  }
}
