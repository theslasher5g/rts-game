/** Phase 3 – Schnittstellen, die CombatSystem von Gebäude-/Bauwerksmodulen erwartet (Injektion über CombatSystem.setProviders). */
import type { BuildingInfo, StructureInfo } from './types';

export interface BuildingProvider {
  damageBuilding(id: number, amount: number, x: number, z: number): void;
  findBuildingAt(x: number, z: number, maxKm: number): BuildingInfo | null;
  buildingsInRadius(x: number, z: number, r: number, out: BuildingInfo[]): BuildingInfo[];
  /** h0/h1 = Strahlhöhen über dem lokalen Gelände (km) am Start bzw. Ende */
  raycastBlocked(x0: number, z0: number, x1: number, z1: number, h0: number, h1: number): boolean;
}

export interface StructureProvider {
  damageStructure(id: number, amount: number): void;
  structuresInRadius(x: number, z: number, r: number, out: StructureInfo[]): StructureInfo[];
}
