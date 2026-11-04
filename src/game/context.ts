/**
 * Spielkontext (ab Phase 6): bündelt die Systeme, die KI-Befehlshaber, Missionen, Nebel des Krieges und Tutorial
 * brauchen. main.ts baut den Kontext nach der Initialisierung und reicht ihn durch.
 */
import type { CombatSystem } from '../combat/CombatSystem';
import type { CivilianSystem } from '../civil/CivilianSystem';
import type { OilEconomy } from '../logistics/OilEconomy';
import type { SupplySystem } from '../logistics/SupplySystem';
import type { NavGraph } from '../nav/NavGraph';
import type { Pathfinder } from '../nav/Pathfinder';
import type { ProductionSystem } from '../production/ProductionSystem';
import type { StructureManager } from '../structures/StructureManager';
import type { UnitManager } from '../units/UnitManager';
import type { Cities } from '../world/Cities';
import type { GeoData } from '../world/GeoData';
import type { GameState } from './GameState';
import type { War } from './War';

export interface GameContext {
  geo: GeoData;
  state: GameState;
  war: War;
  units: UnitManager;
  combat: CombatSystem;
  economy: OilEconomy;
  production: ProductionSystem;
  supply: SupplySystem;
  civil: CivilianSystem;
  structures: StructureManager;
  cities: Cities;
  graph: NavGraph;
  pathfinder: Pathfinder;
  /** a3 des Spielers (null im Menü) */
  player: () => string | null;
}

export type Difficulty = 'leicht' | 'mittel' | 'schwer';
