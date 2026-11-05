/** Phase 4 – Modellkatalog: alle Geometrien + Auswahl der Variante je Einheit/Besitzer. */
import type * as THREE from 'three';
import type { ModelDef } from './geomUtils';
import { buildBomber, buildDroneFixed, buildDroneQuad, buildHeliAttack, buildHeliTransport, buildJet, buildRotorGeom } from './air';
import { buildSoldier, type SoldierKind } from './infantry';
import { buildDestroyer, buildFrigate, buildSubmarine } from './naval';
import { buildIfv, buildLightTank, buildMbt, buildSpaa, buildSpg } from './tanks';
import {
  buildAidTruck, buildAmbulance, buildApc8x8, buildFieldHospital, buildFuelTruck, buildMlrs, buildRecon4x4, buildSam, buildTruck,
} from './vehicles';

export type { ModelDef };
export { buildRotorGeom };

// Nordadria: Valdoria (VAL) = Leopard-Profil, Kronland (KRN) = T-90-Profil, Marenia (MAR) = Abrams-Profil, Pannonien (PAN) = T-90-Profil (Pakt mit KRN)
const WEST = new Set(['DEU', 'NOR', 'SWE', 'ESP', 'GRC', 'POL', 'VAL']);
const RUSSIAN = new Set(['RUS', 'BLR', 'KRN', 'PAN']);

/** Unit-Typ-ID -> Soldatenvariante */
const SOLDIER_KIND: Record<string, SoldierKind> = {
  inf_squad: 'inf', mg_team: 'mg', at_team: 'at', sniper_team: 'sniper', medic_team: 'medic', engineer_squad: 'eng', mortar_team: 'mortar',
};
const VARIANT_MODELS = new Set(['mbt', 'mbt_heavy', 'ifv']);

/** Schlüssel des Modell-Slots für einen Einheitentyp und Besitzer */
export function modelKeyFor(model: string, typeId: string, owner: string): string {
  if (model === 'soldier') return SOLDIER_KIND[typeId] ? `soldier:${typeId}` : 'soldier';
  if (VARIANT_MODELS.has(model)) return WEST.has(owner) ? `${model}@w` : RUSSIAN.has(owner) ? `${model}@r` : model;
  return model;
}

export function buildModels(): Record<string, ModelDef> {
  const M: Record<string, ModelDef> = {};
  // Kampfpanzer: Standard = Abrams-Profil, @w = Leopard-2-Profil, @r = T-90-Profil
  M.mbt = buildMbt('abrams', false);
  M['mbt@w'] = buildMbt('west', false);
  M['mbt@r'] = buildMbt('ru', false);
  M.mbt_heavy = buildMbt('abrams', true);
  M['mbt_heavy@w'] = buildMbt('west', true);
  M['mbt_heavy@r'] = buildMbt('ru', true);
  M.light_tank = buildLightTank();
  M.ifv = buildIfv('abrams');
  M['ifv@w'] = buildIfv('west');
  M['ifv@r'] = buildIfv('ru');
  M.recon_4x4 = buildRecon4x4();
  M.recon_8x8 = buildApc8x8();
  M.spg = buildSpg();
  M.mlrs = buildMlrs();
  M.spaa = buildSpaa();
  M.sam = buildSam();
  M.truck = buildTruck();
  M.aid_truck = buildAidTruck();
  M.fuel_truck = buildFuelTruck();
  M.field_hospital = buildFieldHospital();
  M.ambulance = buildAmbulance();
  M.soldier = buildSoldier('inf');
  for (const [id, kind] of Object.entries(SOLDIER_KIND)) M[`soldier:${id}`] = buildSoldier(kind);
  M.heli_attack = buildHeliAttack();
  M.heli_transport = buildHeliTransport();
  M.jet = buildJet();
  M.bomber = buildBomber();
  M.drone_fixed = buildDroneFixed();
  M.drone_quad = buildDroneQuad();
  M.destroyer = buildDestroyer();
  M.frigate = buildFrigate();
  M.submarine = buildSubmarine();
  return M;
}

export function rotorGeometry(): THREE.BufferGeometry {
  return buildRotorGeom();
}
