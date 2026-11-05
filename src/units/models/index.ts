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

/** Bauanleitung je Modellschlüssel (lazy: UnitRenderer baut ein Modell erst bei Bedarf bzw. im Leerlauf) */
export const MODEL_BUILDERS: Record<string, () => ModelDef> = {
  // Kampfpanzer: Standard = Abrams-Profil, @w = Leopard-2-Profil, @r = T-90-Profil
  mbt: () => buildMbt('abrams', false),
  'mbt@w': () => buildMbt('west', false),
  'mbt@r': () => buildMbt('ru', false),
  mbt_heavy: () => buildMbt('abrams', true),
  'mbt_heavy@w': () => buildMbt('west', true),
  'mbt_heavy@r': () => buildMbt('ru', true),
  light_tank: () => buildLightTank(),
  ifv: () => buildIfv('abrams'),
  'ifv@w': () => buildIfv('west'),
  'ifv@r': () => buildIfv('ru'),
  recon_4x4: () => buildRecon4x4(),
  recon_8x8: () => buildApc8x8(),
  spg: () => buildSpg(),
  mlrs: () => buildMlrs(),
  spaa: () => buildSpaa(),
  sam: () => buildSam(),
  truck: () => buildTruck(),
  aid_truck: () => buildAidTruck(),
  fuel_truck: () => buildFuelTruck(),
  field_hospital: () => buildFieldHospital(),
  ambulance: () => buildAmbulance(),
  soldier: () => buildSoldier('inf'),
  ...Object.fromEntries(Object.entries(SOLDIER_KIND).map(([id, kind]) => [`soldier:${id}`, () => buildSoldier(kind)])),
  heli_attack: () => buildHeliAttack(),
  heli_transport: () => buildHeliTransport(),
  jet: () => buildJet(),
  bomber: () => buildBomber(),
  drone_fixed: () => buildDroneFixed(),
  drone_quad: () => buildDroneQuad(),
  destroyer: () => buildDestroyer(),
  frigate: () => buildFrigate(),
  submarine: () => buildSubmarine(),
};

/** Alle Modelle sofort bauen (Tests/Werkzeuge) */
export function buildModels(): Record<string, ModelDef> {
  const M: Record<string, ModelDef> = {};
  for (const [k, f] of Object.entries(MODEL_BUILDERS)) M[k] = f();
  return M;
}

export function rotorGeometry(): THREE.BufferGeometry {
  return buildRotorGeom();
}
