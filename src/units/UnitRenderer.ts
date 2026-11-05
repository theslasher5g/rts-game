/**
 * Phase 2 – Darstellung der Einheiten.
 *
 * - Prozedurale Low-Poly-Modelle (flach schattiert, Vertexfarben), je Modell ein InstancedMesh
 *   über alle Mitglieder aller Verbände dieses Modells. Pro Vertex ein "Paint"-Kanal:
 *   0 = feste Farbe (Ketten, Glas), 1 = Tarnfarbe (Instanzfarbe × Vertexfarbe), 2 = Teamfarbe.
 * - Fester Darstellungsmaßstab (SCALE.units / SCALE.infantry, siehe core/scale.ts): Modelle wachsen NICHT mit dem Kameraabstand.
 * - Fernansicht: NATO-Taktische Zeichen (Billboards aus einem Canvas-Atlas, Freund/Feind/Neutral).
 * - Auswahlringe am Boden + Zustands-/Treibstoffbalken über ausgewählten Einheiten.
 */
import * as THREE from 'three';
import { bus } from '../core/EventBus';
import type { Settings } from '../core/types';
import { blocOf, getProfile, getRelation } from '../game/countryData';
import type { GeoData } from '../world/GeoData';
import type { Unit, UnitTypeDef } from './types';
import type { UnitManager } from './UnitManager';
import { UNIT_TYPES } from './unitTypes';
import { SCALE, counterDistanceKm, unitModelScale } from '../core/scale';
import { MODEL_BUILDERS, modelKeyFor, rotorGeometry, type ModelDef as ModelDefT } from './models';
import { Q } from '../core/quality';

// ---------------------------------------------------------------- Tuning
/**
 * Ab diesem Kameraabstand (km) NATO-Zeichen statt 3D-Modelle (± Hysterese): Referenzwert für 720 px Bildhöhe;
 * zur Laufzeit wird die Schwelle aus SCALE.units, FOV und Bildschirmhöhe berechnet (siehe core/scale.ts).
 */
export const COUNTER_DISTANCE = counterDistanceKm(720);
const COUNTER_HYST = 0.08;
/** Zeichengröße (CSS-Pixel) */
const COUNTER_PX = 36;
const BAR_W = 30;
const BAR_H = 7;

type ModelDef = ModelDefT;

// ---------------------------------------------------------------- Farben

const CAMO: Record<string, number> = {
  VAL: 0x4f5c4a, KRN: 0x6a6040, MAR: 0x8a7a55, PAN: 0x6b6a3c, DEU: 0x4c5536, FRA: 0x5a5f3c, GBR: 0x55593c, POL: 0x4f5a37, RUS: 0x4b5832, UKR: 0x56603f, TUR: 0x5c5a3e,
  ITA: 0x6a6243, ESP: 0x6b6447, NLD: 0x4a5238, SWE: 0x4e5a45, NOR: 0x4d5543, FIN: 0x58604c, ROU: 0x5a5c3b,
  GRC: 0x5d5c3e, BLR: 0x4f5a36, HUN: 0x55583a,
};
const DESERT = new Set(['TUR', 'ESP', 'GRC', 'CYP', 'SYR', 'IRQ', 'IRN', 'SAU', 'EGY', 'LBY', 'DZA', 'TUN', 'MAR', 'JOR', 'ISR']);
const AIR_GREY = 0x7a8189;
const NAVAL_GREY = 0x7e858b;
const HELI_GREEN = 0x4a4f3e;
/** gedämpfte Teamfarben für nicht spielbare Staaten (nach mapColor 1..9) */
const MAPCOLOR_TEAM = [0x8a8a8a, 0xb0604a, 0x5a8a4a, 0x4a6ea8, 0xb09a40, 0x8a5aa0, 0x4aa0a0, 0xa07040, 0x6a7a9a, 0xa04a6a];

interface OwnerColors {
  ground: THREE.Color;
  heli: THREE.Color;
  air: THREE.Color;
  naval: THREE.Color;
  team: THREE.Color;
}

// ---------------------------------------------------------------- NATO-Zeichen

type Sym =
  | 'inf' | 'mg' | 'at' | 'sniper' | 'medic' | 'eng' | 'mortar' | 'recon_w' | 'mech' | 'mech_w' | 'armor' | 'armor_l'
  | 'medic_v' | 'aid' | 'hospital' | 'art' | 'mlrs' | 'aa' | 'sam' | 'supply' | 'rotary' | 'rotary_t' | 'fixed' | 'bomber' | 'uav' | 'fpv' | 'surface' | 'sub';

const TYPE_SYMBOL: Record<string, Sym> = {
  inf_squad: 'inf', mg_team: 'mg', at_team: 'at', sniper_team: 'sniper', medic_team: 'medic', engineer_squad: 'eng',
  mortar_team: 'mortar', recon_wheeled: 'recon_w', ifv: 'mech', apc_wheeled: 'mech_w', light_tank: 'armor_l',
  mbt_medium: 'armor', mbt_heavy: 'armor', sp_artillery: 'art', mlrs: 'mlrs', spaa: 'aa', sam: 'sam', supply_truck: 'supply', tanker_truck: 'supply', aid_convoy: 'aid', field_hospital: 'hospital', ambulance: 'medic_v',
  attack_heli: 'rotary', transport_heli: 'rotary_t', fighter: 'fixed', bomber: 'bomber', recon_drone: 'uav', fpv_swarm: 'fpv',
  destroyer: 'surface', frigate: 'surface', submarine: 'sub',
};

function echelonOf(t: UnitTypeDef): string {
  switch (t.category) {
    case 'infantry':
      return t.memberCount >= 6 ? '•' : 'ø';
    case 'artillery':
    case 'aa':
      return t.memberCount >= 3 ? 'I' : '';
    case 'drone':
      return t.memberCount > 1 ? '••' : '';
    default:
      return '';
  }
}

const ATLAS_CELLS = 16;
const CELL_PX = 64;
const AFFIL_FILL = ['#80c8ff', '#ff8a80', '#aaffaa'];
const AFFIL_SEL = ['#ffffff', '#ffff60', '#ffffff'];

function drawCounter(ctx: CanvasRenderingContext2D, ox: number, oy: number, t: UnitTypeDef, affil: number, sel: boolean): void {
  const cx = ox + 32, cy = oy + 38;
  ctx.save();
  ctx.lineJoin = 'round';
  // Rahmen-Pfad
  const frame = () => {
    ctx.beginPath();
    if (affil === 1) {
      ctx.moveTo(cx, cy - 22);
      ctx.lineTo(cx + 22, cy);
      ctx.lineTo(cx, cy + 22);
      ctx.lineTo(cx - 22, cy);
      ctx.closePath();
    } else if (affil === 2) ctx.rect(cx - 17, cy - 17, 34, 34);
    else ctx.rect(cx - 23, cy - 15, 46, 30);
  };
  // Innenmaß für Symbole
  const hw = affil === 1 ? 14 : affil === 2 ? 15 : 21;
  const hh = affil === 1 ? 10 : affil === 2 ? 15 : 13;
  if (sel) {
    frame();
    ctx.lineWidth = 8;
    ctx.strokeStyle = AFFIL_SEL[affil];
    ctx.stroke();
  }
  frame();
  ctx.fillStyle = AFFIL_FILL[affil];
  ctx.fill();
  ctx.save();
  frame();
  ctx.clip();
  ctx.strokeStyle = '#000';
  ctx.fillStyle = '#000';
  ctx.lineWidth = 2.2;
  const line = (x0: number, y0: number, x1: number, y1: number) => {
    ctx.beginPath();
    ctx.moveTo(cx + x0, cy + y0);
    ctx.lineTo(cx + x1, cy + y1);
    ctx.stroke();
  };
  const X = () => {
    line(-hw - 4, -hh - 4, hw + 4, hh + 4);
    line(-hw - 4, hh + 4, hw + 4, -hh - 4);
  };
  const oval = (w = hw * 0.7, h = hh * 0.55) => {
    ctx.beginPath();
    ctx.ellipse(cx, cy, w, h, 0, 0, Math.PI * 2);
    ctx.stroke();
  };
  const dot = (r = 4, dy = 0) => {
    ctx.beginPath();
    ctx.arc(cx, cy + dy, r, 0, Math.PI * 2);
    ctx.fill();
  };
  const wheels = () => {
    ctx.lineWidth = 1.6;
    for (const dx of [-6, 0, 6]) {
      ctx.beginPath();
      ctx.arc(cx + dx, cy + hh - 4, 2, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.lineWidth = 2.2;
  };
  const text = (s: string, size: number, dy = 0) => {
    ctx.font = `bold ${size}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(s, cx, cy + dy);
  };
  const dome = () => {
    ctx.beginPath();
    ctx.ellipse(cx, cy + hh + 2, hw * 0.95, hh * 0.9, 0, Math.PI, 0);
    ctx.stroke();
  };
  const sym = TYPE_SYMBOL[t.id] ?? 'inf';
  switch (sym) {
    case 'inf':
      X();
      break;
    case 'mg':
      X();
      text('MG', 9, hh - 4);
      break;
    case 'sniper':
      X();
      text('S', 10, -hh + 5);
      break;
    case 'at':
      line(-hw, hh, 0, -hh);
      line(0, -hh, hw, hh);
      break;
    case 'medic':
      ctx.lineWidth = 3;
      line(0, -hh + 3, 0, hh - 3);
      line(-hh + 3, 0, hh - 3, 0);
      break;
    case 'eng':
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(cx - 9, cy + 5);
      ctx.lineTo(cx - 9, cy - 5);
      ctx.lineTo(cx + 9, cy - 5);
      ctx.lineTo(cx + 9, cy + 5);
      ctx.moveTo(cx, cy - 5);
      ctx.lineTo(cx, cy + 5);
      ctx.stroke();
      break;
    case 'mortar':
      dot(3, 5);
      line(0, 2, 0, -hh + 3);
      line(-4, -hh + 7, 0, -hh + 3);
      line(4, -hh + 7, 0, -hh + 3);
      break;
    case 'recon_w':
      line(-hw - 4, hh + 4, hw + 4, -hh - 4);
      wheels();
      break;
    case 'mech':
      X();
      oval();
      break;
    case 'mech_w':
      X();
      oval();
      wheels();
      break;
    case 'armor':
      oval();
      break;
    case 'armor_l':
      oval(hw * 0.55, hh * 0.45);
      break;
    case 'art':
      oval();
      dot(4);
      break;
    case 'mlrs':
      dot(3.5, 3);
      line(0, -1, 0, -hh + 2);
      line(-5, -hh + 6, 0, -hh + 2);
      line(5, -hh + 6, 0, -hh + 2);
      wheels();
      break;
    case 'aa':
      dome();
      oval(hw * 0.5, hh * 0.35);
      break;
    case 'sam':
      dome();
      line(0, hh, 0, -hh + 3);
      line(-4, -hh + 7, 0, -hh + 3);
      line(4, -hh + 7, 0, -hh + 3);
      break;
    case 'supply':
      ctx.lineWidth = 3;
      line(-hw - 3, hh - 4, hw + 3, hh - 4);
      text('V', 12, -2);
      break;
    case 'medic_v':
      ctx.lineWidth = 3;
      line(0, -hh + 3, 0, hh - 5);
      line(-hh + 3, -2, hh - 3, -2);
      wheels();
      break;
    case 'aid':
      ctx.lineWidth = 3;
      line(-hw - 3, hh - 4, hw + 3, hh - 4);
      line(0, -hh + 2, 0, hh - 7);
      line(-6, -3, 6, -3);
      break;
    case 'hospital':
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(cx - 10, cy + 8);
      ctx.lineTo(cx, cy - 8);
      ctx.lineTo(cx + 10, cy + 8);
      ctx.stroke();
      ctx.lineWidth = 3;
      line(0, -3, 0, 7);
      line(-5, 2, 5, 2);
      break;
    case 'rotary':
    case 'rotary_t': {
      ctx.beginPath();
      ctx.moveTo(cx - hw + 2, cy - 7);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx - hw + 2, cy + 7);
      ctx.closePath();
      ctx.moveTo(cx + hw - 2, cy - 7);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx + hw - 2, cy + 7);
      ctx.closePath();
      if (sym === 'rotary') ctx.fill();
      else ctx.stroke();
      break;
    }
    case 'fixed':
    case 'bomber':
      ctx.beginPath();
      ctx.moveTo(cx - hw + 2, cy + 3);
      ctx.quadraticCurveTo(cx - 6, cy - 9, cx, cy + 2);
      ctx.quadraticCurveTo(cx + 6, cy - 9, cx + hw - 2, cy + 3);
      ctx.stroke();
      if (sym === 'bomber') text('B', 9, 7);
      break;
    case 'uav':
    case 'fpv':
      ctx.beginPath();
      ctx.moveTo(cx - hw + 3, cy - 6);
      ctx.lineTo(cx, cy + 4);
      ctx.lineTo(cx + hw - 3, cy - 6);
      ctx.lineTo(cx, cy - 1);
      ctx.closePath();
      ctx.fill();
      if (sym === 'fpv') text('FPV', 8, 9);
      break;
    case 'surface':
      ctx.beginPath();
      ctx.moveTo(cx - hw + 2, cy - 2);
      ctx.lineTo(cx + hw - 2, cy - 2);
      ctx.lineTo(cx + hw - 7, cy + 6);
      ctx.lineTo(cx - hw + 7, cy + 6);
      ctx.closePath();
      ctx.fill();
      line(0, -2, 0, -9);
      break;
    case 'sub':
      ctx.beginPath();
      ctx.ellipse(cx, cy + 2, hw - 3, 4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(cx - 4, cy - 6, 6, 5);
      break;
  }
  ctx.restore();
  // Rahmenlinie
  frame();
  ctx.lineWidth = 2.2;
  ctx.strokeStyle = '#000';
  ctx.stroke();
  // Größenkennzeichen
  const ech = echelonOf(t);
  if (ech) {
    ctx.fillStyle = sel ? AFFIL_SEL[affil] : '#000';
    ctx.font = 'bold 13px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const top = affil === 1 ? cy - 22 : affil === 2 ? cy - 17 : cy - 15;
    if (!sel) {
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = 3;
      ctx.strokeText(ech, cx, top + 1);
    }
    ctx.fillText(ech, cx, top + 1);
  }
  ctx.restore();
}

const COUNTER_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 iPos;
attribute float iCell;
attribute float iSel;
uniform vec2 uScreen;
uniform float uSize;
varying vec2 vUv;
varying float vSel;
void main() {
  vec4 clip = projectionMatrix * viewMatrix * vec4(iPos, 1.0);
  float s = uSize * (1.0 + iSel * 0.12);
  clip.xy += position.xy * s / uScreen * 2.0 * clip.w;
  gl_Position = clip;
  float cx = mod(iCell, ${ATLAS_CELLS.toFixed(1)});
  float cy = floor(iCell / ${ATLAS_CELLS.toFixed(1)});
  vUv = vec2((cx + uv.x) / ${ATLAS_CELLS.toFixed(1)}, 1.0 - (cy + 1.0 - uv.y) / ${ATLAS_CELLS.toFixed(1)});
  vSel = iSel;
  #include <logdepthbuf_vertex>
}
`;
const COUNTER_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D uAtlas;
uniform float uTime;
varying vec2 vUv;
varying float vSel;
void main() {
  vec4 c = texture2D(uAtlas, vUv);
  if (c.a < 0.35) discard;
  c.rgb *= 1.0 + vSel * 0.18 * (0.5 + 0.5 * sin(uTime * 6.0));
  gl_FragColor = vec4(c.rgb, 1.0);
  #include <logdepthbuf_fragment>
}
`;

const BAR_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 iPos;
attribute vec2 iVal;
attribute float iOff;
uniform vec2 uScreen;
uniform vec2 uSize;
varying vec2 vUv;
varying vec2 vVal;
void main() {
  vec4 clip = projectionMatrix * viewMatrix * vec4(iPos, 1.0);
  vec2 px = position.xy * uSize + vec2(0.0, iOff);
  clip.xy += px / uScreen * 2.0 * clip.w;
  gl_Position = clip;
  vUv = uv;
  vVal = iVal;
  #include <logdepthbuf_vertex>
}
`;
const BAR_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec2 uSize;
varying vec2 vUv;
varying vec2 vVal;
void main() {
  vec2 p = vUv * uSize;
  vec3 col = vec3(0.06);
  bool border = p.x < 1.0 || p.y < 1.0 || p.x > uSize.x - 1.0 || p.y > uSize.y - 1.0 || abs(p.y - uSize.y * 0.45) < 0.5;
  if (!border) {
    if (vUv.y > 0.45) {
      if (vUv.x < vVal.x) col = mix(vec3(0.85, 0.15, 0.1), vec3(0.25, 0.85, 0.25), smoothstep(0.2, 0.8, vVal.x));
      else col = vec3(0.18, 0.05, 0.05);
    } else {
      col = vUv.x < vVal.y ? vec3(0.9, 0.65, 0.15) : vec3(0.15, 0.1, 0.03);
    }
  }
  gl_FragColor = vec4(col, 1.0);
  #include <logdepthbuf_fragment>
}
`;

// ---------------------------------------------------------------- Anim-Material (Soldaten / Luft / See)

/** Nationen-ID für Tarnmuster (Soldaten-Material): 1 VAL alpin, 2 KRN khaki/braun, 3 MAR sand/oliv, 4 Wüste, 5 Wald (Rückfall) */
const NATION_ID: Record<string, number> = { VAL: 1, KRN: 2, MAR: 3 };
/** Kameraabstand (km), ab dem Soldaten in der Low-Detail-Variante gezeichnet werden */
// Soldaten-LOD: Q.soldierLodKm (hoch = 3.5 km)

const ANIM_COMMON = /* glsl */ `
vec3 S(float r, float g, float b) { return pow(vec3(r, g, b) / 255.0, vec3(2.2)) * 1.6; }
`;
const ANIM_VERT_DECL = /* glsl */ `
attribute float aPaint;
attribute vec3 aTeam;
attribute float aPart;
attribute vec3 aPivot;
attribute vec4 iAnim;
uniform float uTime;
varying vec3 vObj;
varying vec3 vBase;
varying vec4 vInfo;
${ANIM_COMMON}
vec3 rotX(vec3 p, vec3 c, float a) { float s = sin(a), k = cos(a); vec3 d = p - c; return c + vec3(d.x, d.y * k - d.z * s, d.y * s + d.z * k); }
vec3 rotY(vec3 p, vec3 c, float a) { float s = sin(a), k = cos(a); vec3 d = p - c; return c + vec3(d.x * k + d.z * s, d.y, -d.x * s + d.z * k); }
vec3 rotZ(vec3 p, vec3 c, float a) { float s = sin(a), k = cos(a); vec3 d = p - c; return c + vec3(d.x * k - d.y * s, d.x * s + d.y * k, d.z); }
vec3 skinTone(float h) {
  float t = fract(h * 7.31);
  return mix(pow(vec3(238.0, 196.0, 164.0) / 255.0, vec3(2.2)), pow(vec3(112.0, 76.0, 52.0) / 255.0, vec3(2.2)), t * t) * 1.15;
}
vec3 gearTone(float nat, float h) {
  float v = 0.85 + 0.3 * fract(h * 3.7);
  if (nat < 1.5) return S(54.0, 60.0, 56.0) * v;
  if (nat < 2.5) return S(104.0, 86.0, 58.0) * v;
  if (nat < 3.5) return S(150.0, 126.0, 86.0) * v;
  if (nat < 4.5) return S(138.0, 118.0, 84.0) * v;
  return S(78.0, 80.0, 62.0) * v;
}
`;
const ANIM_VERT_COLOR = /* glsl */ `
#include <color_vertex>
{
  float nat = floor(iAnim.w + 0.001);
  float hs = iAnim.w - nat;
  vec3 c0 = color.rgb;
  vInfo = vec4(nat, hs, 0.0, 0.0);
  vBase = instanceColor.rgb;
  if (aPaint < 0.5) vColor.rgb = c0;
  else if (aPaint < 1.5) {
    if (nat > 0.5) { vColor.rgb = c0; vInfo.z = 1.0; } else vColor.rgb = c0 * instanceColor.rgb;
  } else if (aPaint < 2.5) vColor.rgb = c0 * aTeam;
  else if (aPaint < 3.5) vColor.rgb = c0 * skinTone(hs);
  else vColor.rgb = c0 * gearTone(nat, hs);
}
`;
const ANIM_VERT_BODY = /* glsl */ `
#include <begin_vertex>
{
  vObj = position;
  float part = aPart;
  float natI = floor(iAnim.w + 0.001);
  float hs = iAnim.w - natI;
  vec3 pv = aPivot;
  vec4 a = iAnim;
  float glow = 0.0;
  vec3 p = transformed;
  if (natI > 0.5) {
    // ---- Soldat: a.x = Schrittphase, a.y = Tempo (0..1: Gehen bis 0.5, Rennen bis 1), a.z = Anschlag 0..1
    float ph = a.x;
    float amp = clamp(a.y * 2.0, 0.0, 1.0);
    float run = clamp(a.y * 2.0 - 1.0, 0.0, 1.0);
    float aim = a.z;
    float idle = sin(uTime * 1.5 + hs * 40.0);
    if (part > 0.5 && part < 2.5) {
      float phi = ph + (pv.x >= 0.0 ? 0.0 : 3.14159);
      float th = sin(phi) * mix(0.45, 0.8, run) * amp;
      if (part < 1.5) p = rotX(p, vec3(pv.x, 0.93, pv.z), th);
      else {
        float kn = -max(0.0, cos(phi)) * mix(0.7, 1.2, run) * amp;
        p = rotX(p, pv, kn);
        p = rotX(p, vec3(pv.x, 0.93, pv.z), th);
      }
    } else if (part > 2.5) {
      if (part > 3.5 && part < 4.5) {
        float pitch = mix(-0.15 * amp + sin(ph * 2.0) * 0.05 * amp, 0.34, aim);
        p = rotX(p, vec3(0.0, 1.42, 0.0), pitch);
        p = rotY(p, vec3(0.0, 1.42, 0.0), sin(ph) * 0.12 * amp * (1.0 - aim * 0.7));
        p.y += 0.05 * aim;
      } else if (part > 4.5 && part < 5.5) {
        p = rotX(p, pv, sin(ph * 2.0 + 1.0) * 0.18 * amp + idle * 0.015);
      } else if (part > 5.5) {
        float k = part < 6.5 ? fract(hs * 3.17) : fract(hs * 5.31);
        if (k < 0.5) p = pv;
      }
      float lean = (0.05 + 0.13 * run) * amp + aim * 0.1;
      p = rotX(p, vec3(0.0, 0.95, 0.0), -lean);
      p = rotY(p, vec3(0.0, 0.95, 0.0), sin(ph) * 0.09 * amp);
      p.y += abs(sin(ph)) * 0.03 * amp * (1.0 + run) + idle * 0.004 * (1.0 - amp);
    }
    p *= mix(0.95, 1.05, hs);
  } else if (part > 0.5) {
    float g = a.z;
    if (part < 10.5) {
      // Hauptfahrwerk: nach innen einklappen
      float side = pv.x >= 0.0 ? 1.0 : -1.0;
      p = rotZ(p, pv, -side * g * 1.45);
      p = pv + (p - pv) * (1.0 - 0.3 * g);
    } else if (part < 11.5) {
      p = rotX(p, pv, -g * 1.5);
      p = pv + (p - pv) * (1.0 - 0.3 * g);
    } else if (part < 12.5) {
      // Fahrwerksklappe: bei eingefahrenem Fahrwerk geschlossen (zur Seite geklappt wenn ausgefahren)
      float side = pv.x >= 0.0 ? 1.0 : -1.0;
      p = rotZ(p, pv, side * (1.0 - g) * 1.3);
    } else if (part < 13.5) {
      glow = smoothstep(0.35, 0.9, a.y);
      float fl = glow * (0.85 + 0.15 * sin(uTime * 45.0 + hs * 10.0));
      p = pv + (p - pv) * vec3(step(0.03, fl), step(0.03, fl), fl);
    } else if (part < 14.5) {
      glow = step(0.78, fract(uTime * 0.85 + hs));
    } else if (part < 15.5) {
      float on = step(0.05, a.y);
      p = rotZ(p, pv, (uTime * 55.0) * on + hs * 6.0);
    } else if (part < 16.5) {
      p = rotY(p, pv, a.z);
    } else if (part < 18.5) {
      glow = 0.8;
    } else if (part > 39.5) {
      if (part < 40.5) p = rotY(p, pv, uTime * 2.2 + hs * 6.28);
      else if (part < 41.5) p = rotY(p, pv, a.z);
      else if (part < 42.5) p = rotY(p, pv, a.z * 0.85);
      else if (part < 43.5) p = rotZ(p, pv, uTime * (1.0 + a.y * 12.0));
      else if (part < 44.5) p = rotY(p, pv, -uTime * 1.3 + hs * 6.28);
      else glow = 0.8;
    }
  }
  vInfo.w = glow;
  transformed = p;
}
`;
const ANIM_FRAG_DECL = /* glsl */ `
varying vec3 vObj;
varying vec3 vBase;
varying vec4 vInfo;
${ANIM_COMMON}
float h31(vec3 p) { p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vn(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h31(i), h31(i + vec3(1, 0, 0)), f.x), mix(h31(i + vec3(0, 1, 0)), h31(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(h31(i + vec3(0, 0, 1)), h31(i + vec3(1, 0, 1)), f.x), mix(h31(i + vec3(0, 1, 1)), h31(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
vec3 camoTint(vec3 p, float nat, vec3 base) {
  float n = vn(p * 9.0) * 0.65 + vn(p * 19.0 + 4.0) * 0.35;
  if (nat < 1.5) {
    // Valdoria: alpines Grüngrau mit dunklen und hellgrauen Flecken
    return n < 0.4 ? S(50.0, 60.0, 52.0) : (n > 0.62 ? S(134.0, 142.0, 128.0) : S(88.0, 100.0, 82.0));
  } else if (nat < 2.5) {
    // Kronland: Khaki mit braunen Streifen
    float s = sin(p.y * 12.0 + p.x * 6.0 + n * 7.0);
    return s > 0.5 ? S(104.0, 78.0, 50.0) : (n < 0.3 ? S(72.0, 68.0, 46.0) : S(140.0, 124.0, 88.0));
  } else if (nat < 4.5) {
    // Marenia / Wüste: Sand mit Oliv und Braun
    return n < 0.37 ? S(104.0, 110.0, 68.0) : (n > 0.66 ? S(130.0, 98.0, 64.0) : S(174.0, 154.0, 108.0));
  }
  return base * (n < 0.36 ? vec3(0.62, 0.68, 0.56) : (n > 0.66 ? vec3(1.05, 0.86, 0.66) : vec3(1.0)));
}
`;

// ---------------------------------------------------------------- Fahrzeug-Material (Bodenfahrzeuge)

/** Kameraabstand (km), ab dem Fahrzeuge in der Low-Detail-Variante gezeichnet werden */
// Fahrzeug-LOD: Q.vehLodKm (hoch = 6 km)
/** Ab diesem Kameraabstand (km) werden Fahrzeug-Animationen nicht mehr fortgeschrieben */
// Fahrzeug-Animation: Q.vehAnimKm (hoch = 5 km)

const VEH_VERT_DECL = /* glsl */ `
attribute float aPaint;
attribute vec3 aTeam;
attribute vec4 aVPart;
attribute vec4 aVA;
attribute vec4 aVB;
attribute vec3 aCol1;
attribute vec3 aCol2;
varying float vTrk;
varying float vTrkOn;
vec3 vRotX(vec3 p, vec2 c, float a) { float s = sin(a), k = cos(a); float dy = p.y - c.x, dz = p.z - c.y; return vec3(p.x, c.x + dy * k - dz * s, c.y + dy * s + dz * k); }
vec3 vYaw(vec3 p, float tz, float a) { float s = sin(a), k = cos(a); float dx = p.x, dz = p.z - tz; return vec3(dx * k - dz * s, p.y, tz + dx * s + dz * k); }
vec3 vSpin(vec3 p, float cz, float a) { float s = sin(a), k = cos(a); float dx = p.x, dz = p.z - cz; return vec3(dx * k + dz * s, p.y, cz - dx * s + dz * k); }
`;
const VEH_VERT_COLOR = /* glsl */ `
#include <color_vertex>
{
  vec3 c0 = aVB.z < 0.5 ? color.rgb : (aVB.z < 1.5 ? aCol1 : aCol2);
  if (aPaint < 0.5) vColor.rgb = c0;
  else if (aPaint < 1.5) vColor.rgb = c0 * instanceColor.rgb;
  else vColor.rgb = c0 * aTeam;
  // Staub/Dreck an der unteren Wanne (je Instanz)
  float dirt = aVB.y * (1.0 - smoothstep(0.15, 1.5, position.y));
  vColor.rgb = mix(vColor.rgb, vColor.rgb * vec3(0.55, 0.47, 0.37) + vec3(0.02, 0.015, 0.01), dirt * 0.8);
}
`;
const VEH_VERT_BODY = /* glsl */ `
#include <begin_vertex>
{
  vTrk = 0.0;
  vTrkOn = 0.0;
  float kd = aVPart.x;
  if (kd > 0.5) {
    vec3 p = transformed;
    if (kd < 1.5) p = vYaw(p, aVPart.w, aVA.x);
    else if (kd < 2.5) { p.z += aVA.z; p = vRotX(p, aVPart.yz, aVA.y); p = vYaw(p, aVPart.w, aVA.x); }
    else if (kd < 3.5) p = vRotX(p, aVPart.yz, -aVA.w / aVPart.w);
    else if (kd < 4.5) { p = vSpin(p, aVPart.z, aVB.x); p = vYaw(p, aVPart.w, aVA.x); }
    else if (kd < 5.5) { vTrkOn = 1.0; vTrk = (p.y > aVPart.y ? p.z : -p.z) + aVA.w; }
    else p = vSpin(p, aVPart.z, aVB.x);
    transformed = p;
  }
}
`;
const VEH_FRAG_DECL = /* glsl */ `
varying float vTrk;
varying float vTrkOn;
`;
const VEH_FRAG_COLOR = /* glsl */ `
#include <color_fragment>
if (vTrkOn > 0.5) {
  float tu = vTrk * 3.2;
  float aa = 1.0 - smoothstep(0.2, 0.55, fwidth(tu));
  diffuseColor.rgb *= mix(0.8, fract(tu) < 0.3 ? 0.5 : 1.0, aa);
}
`;

function createVehicleMaterial(): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VEH_VERT_DECL}`)
      .replace('#include <color_vertex>', VEH_VERT_COLOR)
      .replace('#include <begin_vertex>', VEH_VERT_BODY);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${VEH_FRAG_DECL}`)
      .replace('#include <color_fragment>', VEH_FRAG_COLOR);
  };
  m.customProgramCacheKey = () => 'unit-veh-v1';
  return m;
}

/** Waffen, deren Abschuss einen Rohrrücklauf auslöst */
const RECOIL_WEAPONS = new Set(['tank_gun', 'howitzer', 'autocannon', 'flak', 'mortar']);

/** Animationszustand eines Fahrzeugverbands (Turm, Rohr, Rückstoß, Laufwerk) */
interface VehVis {
  tYaw: number;
  elev: number;
  odo: number;
  odoT: number;
  lx: number;
  lz: number;
  mv: number;
  bobY: number;
  wobP: number;
  wobR: number;
  nm: number;
  fireIdx: number;
  /** Sekunden seit dem letzten Schuss je Mitglied */
  rec: Float32Array;
  init: boolean;
}

// ---------------------------------------------------------------- Renderer

interface ModelSlot {
  def: ModelDef;
  mesh: THREE.InstancedMesh;
  team: THREE.InstancedBufferAttribute;
  cap: number;
  count: number;
  /** benötigte Kapazität (Vorlauf) */
  need: number;
  /** Anim-Attribut iAnim (vec4 je Instanz) – nur bei animierten Modellen */
  anim: THREE.InstancedBufferAttribute | null;
  /** Fahrzeug-Animation: aVA (Turm, Rohr, Rückstoß, Strecke) und aVB (Radar, Dreck, Tarnvariante) */
  va: THREE.InstancedBufferAttribute | null;
  vb: THREE.InstancedBufferAttribute | null;
}

interface UnitVis {
  /** aktuelle Mitglieder-Offsets (m, lokal: x rechts, z hinten) */
  off: Float32Array;
  init: boolean;
  pitch: number;
  roll: number;
  lastHeading: number;
  seen: number;
  /** Phase 3: weiche Haltung der Infanterie 0 = stehen, 1 = kauern, 2 = liegen */
  post: number;
  /** Fahrzeug-Animationszustand (nur Bodenfahrzeuge mit def.vanim) */
  veh?: VehVis;
  /** Animationszustand (Soldaten: Schrittphase, Tempo, Anschlag; Luft/See: Fahrwerk, Geschützdrehung) */
  walk: number;
  mv: number;
  aim: number;
  gear: number;
  slew: number;
}

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _cam = new THREE.Vector3();
const _sphere = new THREE.Sphere();
const _frustum = new THREE.Frustum();
const _pv = new THREE.Matrix4();
const _xAxis = new THREE.Vector3(1, 0, 0);
const _yAxis = new THREE.Vector3(0, 1, 0);
const _qTail = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
const _tmpOff = new Float32Array(64);
const _ringColor = new THREE.Color();

export class UnitRenderer {
  readonly object: THREE.Object3D;

  private readonly manager: UnitManager;
  private readonly geo: GeoData;
  private exag: number;
  /** Modelle werden lazy gebaut (ensureModel) und im Leerlauf vorgewärmt */
  private readonly models: Record<string, ModelDef> = {};
  private readonly slots = new Map<string, ModelSlot>();
  private readonly rotorSlot: ModelSlot;
  private readonly material: THREE.MeshLambertMaterial;
  /** Material für animierte Modelle (Soldaten, Luftfahrzeuge, Schiffe): Part-Animation im Vertex-Shader */
  private readonly animMaterial: THREE.MeshLambertMaterial;
  /** Material der animierten Bodenfahrzeuge (Turm/Rohr/Räder/Ketten per Vertex-Shader, Tarnvarianten, Dreck) */
  private readonly vehMaterial: THREE.MeshLambertMaterial = createVehicleMaterial();
  private lowLodVeh = false;
  private readonly animTime = { value: 0 };
  /** Schlüssel -> Low-Detail-Slot-Schlüssel */
  private readonly loKeys = new Map<string, string>();
  private lowLod = false;
  private readonly vis = new Map<number, UnitVis>();
  private readonly ownerColors = new Map<string, OwnerColors>();
  private readonly affilCache = new Map<string, number>();
  private affilPlayer: string | null = '\u0000';
  private fog: { isUnitVisible(u: Unit): boolean } | null = null;
  private readonly typeIndex = new Map<string, number>();

  // Zeichen
  private readonly counterGeom: THREE.InstancedBufferGeometry;
  private readonly counterMat: THREE.ShaderMaterial;
  private readonly counterMesh: THREE.Mesh;
  private counterPos = new Float32Array(0);
  private counterCell = new Float32Array(0);
  private counterSel = new Float32Array(0);
  private counterCap = 0;

  // Balken
  private readonly barGeom: THREE.InstancedBufferGeometry;
  private readonly barMat: THREE.ShaderMaterial;
  private readonly barMesh: THREE.Mesh;
  private barPos = new Float32Array(0);
  private barVal = new Float32Array(0);
  private barOff = new Float32Array(0);
  private barCap = 0;

  // Auswahlringe
  private ringMesh: THREE.InstancedMesh;
  private ringCap = 0;
  private readonly ringGeom: THREE.BufferGeometry;
  private readonly ringMat: THREE.MeshBasicMaterial;

  private counterMode = false;
  /** aktuelle Schwelle (km) für NATO-Zeichen (abhängig von der Bildschirmhöhe) */
  private counterDist = COUNTER_DISTANCE;
  private pxKm = 0.01;
  private camDist = 100;
  private lastTime = 0;
  private frameNo = 0;

  constructor(manager: UnitManager, geo: GeoData, settings: Settings) {
    this.manager = manager;
    this.geo = geo;
    this.exag = settings.heightExaggeration;
    Object.keys(UNIT_TYPES).forEach((id, i) => this.typeIndex.set(id, i));

    const group = new THREE.Group();
    group.name = 'Units';
    this.object = group;

    // Material mit Paint-Kanal (Tarn-/Teamfarbe je Instanz)
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    this.material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aPaint;\nattribute vec3 aTeam;')
        .replace(
          '#include <color_vertex>',
          `#include <color_vertex>
#ifdef USE_INSTANCING_COLOR
  vColor.rgb = color.rgb * mix(vec3(1.0), instanceColor.rgb, step(0.5, aPaint));
  if (aPaint > 1.5) vColor.rgb = color.rgb * aTeam;
#endif`,
        );
    };
    this.material.customProgramCacheKey = () => 'unit-paint-v1';

    this.animMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    this.animMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.animTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${ANIM_VERT_DECL}`)
        .replace('#include <color_vertex>', ANIM_VERT_COLOR)
        .replace('#include <begin_vertex>', ANIM_VERT_BODY);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${ANIM_FRAG_DECL}`)
        .replace('#include <color_fragment>', `#include <color_fragment>\n  if (vInfo.z > 0.5) diffuseColor.rgb *= camoTint(vObj, vInfo.x, vBase);`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n  totalEmissiveRadiance += diffuseColor.rgb * vInfo.w * 2.2;`);
    };
    this.animMaterial.customProgramCacheKey = () => 'unit-anim-v1';
    // Rohrrücklauf: Schuss-Ereignis -> nächstes Mitglied des Verbands zuckt zurück
    bus.on('combat:fire', (e) => {
      if (!RECOIL_WEAPONS.has(e.weapon)) return;
      const vv = this.vis.get(e.unitId)?.veh;
      if (vv) vv.rec[vv.fireIdx++ % vv.nm] = 0;
    });

    // Modelle: lazy (erste Einheit dieses Typs/Besitzers) + Vorwärmen im Leerlauf (Menü), statt ~0,4 s beim Start
    this.warmup(Object.keys(MODEL_BUILDERS));
    this.rotorSlot = this.makeSlot({ geom: rotorGeometry(), size: 1, boost: 1, livery: 'air', tilt: false }, 16);
    group.add(this.rotorSlot.mesh);

    // NATO-Zeichen
    const atlas = this.buildAtlas();
    const quad = new THREE.PlaneGeometry(1, 1);
    this.counterGeom = new THREE.InstancedBufferGeometry();
    this.counterGeom.index = quad.index;
    this.counterGeom.setAttribute('position', quad.getAttribute('position'));
    this.counterGeom.setAttribute('uv', quad.getAttribute('uv'));
    this.counterMat = new THREE.ShaderMaterial({
      vertexShader: COUNTER_VERT,
      fragmentShader: COUNTER_FRAG,
      uniforms: {
        uAtlas: { value: atlas },
        uScreen: { value: new THREE.Vector2(1, 1) },
        uSize: { value: COUNTER_PX },
        uTime: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
      fog: false,
    });
    this.counterMesh = new THREE.Mesh(this.counterGeom, this.counterMat);
    this.counterMesh.frustumCulled = false;
    this.counterMesh.renderOrder = 40;
    this.counterMesh.name = 'UnitCounters';
    group.add(this.counterMesh);

    this.barGeom = new THREE.InstancedBufferGeometry();
    const bq = new THREE.PlaneGeometry(1, 1);
    this.barGeom.index = bq.index;
    this.barGeom.setAttribute('position', bq.getAttribute('position'));
    this.barGeom.setAttribute('uv', bq.getAttribute('uv'));
    this.barMat = new THREE.ShaderMaterial({
      vertexShader: BAR_VERT,
      fragmentShader: BAR_FRAG,
      uniforms: { uScreen: { value: new THREE.Vector2(1, 1) }, uSize: { value: new THREE.Vector2(BAR_W, BAR_H) } },
      depthTest: false,
      depthWrite: false,
      fog: false,
    });
    this.barMesh = new THREE.Mesh(this.barGeom, this.barMat);
    this.barMesh.frustumCulled = false;
    this.barMesh.renderOrder = 41;
    this.barMesh.name = 'UnitBars';
    group.add(this.barMesh);

    // Auswahlringe
    this.ringGeom = new THREE.RingGeometry(0.9, 1.0, 40, 1);
    this.ringGeom.rotateX(-Math.PI / 2);
    this.ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false, fog: false });
    this.ringMesh = this.makeRingMesh(32);
    group.add(this.ringMesh);
  }

  // ------------------------------------------------------------ öffentliche API

  applySettings(s: Settings): void {
    this.exag = s.heightExaggeration;
  }

  /** Nebel des Krieges: Gegner, für die isUnitVisible false liefert, werden nicht gezeichnet (null = aus) */
  setFog(fog: { isUnitVisible(u: Unit): boolean } | null): void {
    this.fog = fog;
  }

  /** Welt-Radius (km), den eine Einheit beim aktuellen Zoom optisch abdeckt (für Picking) */
  visualRadiusKm(u: Unit): number {
    if (this.counterMode) return (COUNTER_PX * 0.5) * this.pxKm;
    const def = this.models[this.keyOf(u)];
    if (!def) return 0.1;
    return Math.max(this.unitRadius(def, u.type.memberCount), 10 * this.pxKm);
  }

  /**
   * Picking: tatsächlich gezeichnete Position des Einheitenmittelpunkts (Luftfahrzeuge werden in der Nahansicht
   * in der Höhe gestaucht, siehe update()). out = [x, y, z] in Welt-km.
   */
  pickAnchor(u: Unit, out: [number, number, number]): void {
    out[0] = u.x;
    out[2] = u.z;
    if (u.type.mobility.domain === 'air') {
      const ground = Math.max(0, this.geo.heightAt(u.x, u.z)) * this.exag;
      const alt = Math.max(0, u.y - ground);
      out[1] = ground + Math.min(alt, 0.15 * this.camDist + 0.03);
    } else out[1] = u.type.mobility.domain === 'naval' ? 0 : u.y;
  }

  /**
   * Picking: Radius (km) des Kreises, der alle gezeichneten Mitglieder der Einheit umschließt
   * (aus den aktuellen Darstellungs-Offsets; Fallback: visualRadiusKm).
   */
  pickRadiusKm(u: Unit): number {
    const base = this.visualRadiusKm(u);
    if (this.counterMode || u.type.memberCount <= 1) return base;
    const v = this.vis.get(u.id);
    const def = this.models[this.keyOf(u)];
    if (!v || !def || !v.init) return base;
    let m = 0;
    const n = Math.min(v.off.length >> 1, Math.ceil(u.membersAlive ?? u.type.memberCount));
    for (let i = 0; i < n; i++) m = Math.max(m, Math.hypot(v.off[i * 2], v.off[i * 2 + 1]));
    const r = 0.001 * (m + def.size * this.modelScale(def) * 0.6);
    return Math.max(base * 0.5, r);
  }

  /** zuletzt ermittelter Kameraabstand zum Boden (km) */
  get cameraDistanceKm(): number {
    return this.camDist;
  }

  /** aktueller Sichtmaßstab der Modelle (×) */
  get visualScale(): number {
    return SCALE.units;
  }

  /** Summe der aktuell gezeichneten Modell-Instanzen (Performance-Overlay) */
  get instanceTotal(): number {
    let n = 0;
    for (const slot of this.slots.values()) n += slot.count;
    return n;
  }

  /** true = Fernansicht mit NATO-Zeichen */
  get showingCounters(): boolean {
    return this.counterMode;
  }

  update(camera: THREE.PerspectiveCamera, timeSec: number, playerA3: string | null): void {
    const dt = clamp(timeSec - this.lastTime, 0, 0.1);
    this.lastTime = timeSec;
    this.frameNo++;
    if (playerA3 !== this.affilPlayer) {
      this.affilPlayer = playerA3;
      this.affilCache.clear();
    }

    // --- Kameraabstand (Blickstrahl bis Bodenebene)
    camera.updateMatrixWorld();
    _cam.setFromMatrixPosition(camera.matrixWorld);
    camera.getWorldDirection(_dir);
    const gy = Math.max(0, this.geo.heightAt(_cam.x, _cam.z)) * this.exag;
    const dist = _dir.y < -0.05 ? Math.max(0.5, (_cam.y - gy * 0.5) / -_dir.y) : Math.max(0.5, _cam.y);
    this.camDist = dist;
    this.lowLod = dist > Q.soldierLodKm * (this.lowLod ? 0.9 : 1.1);
    this.lowLodVeh = dist > Q.vehLodKm * (this.lowLodVeh ? 0.9 : 1.1);
    this.animTime.value = timeSec % 1024;
    const screenW = window.innerWidth || 1, screenH = window.innerHeight || 1;
    this.counterDist = counterDistanceKm(screenH, camera.fov);
    const thr = this.counterDist * (this.counterMode ? 1 - COUNTER_HYST : 1 + COUNTER_HYST);
    this.counterMode = dist > thr;
    this.pxKm = (dist * 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / screenH;
    (this.counterMat.uniforms.uScreen.value as THREE.Vector2).set(screenW, screenH);
    (this.barMat.uniforms.uScreen.value as THREE.Vector2).set(screenW, screenH);
    this.counterMat.uniforms.uTime.value = timeSec;

    _pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pv);

    const units = this.manager.units;
    const n = units.length;

    // --- Kapazitäten
    for (const slot of this.slots.values()) {
      slot.count = 0;
      slot.need = 0;
    }
    this.rotorSlot.count = 0;
    this.rotorSlot.need = 0;
    if (!this.counterMode) {
      for (let i = 0; i < n; i++) {
        const u = units[i];
        const slot = this.slots.get(this.slotKey(u));
        if (!slot) continue;
        slot.need += u.type.memberCount;
        if (slot.def.rotors) this.rotorSlot.need += u.type.memberCount * slot.def.rotors.length;
      }
      for (const [key, slot] of this.slots) if (slot.need > slot.cap) this.growSlot(key, slot);
      if (this.rotorSlot.need > this.rotorSlot.cap) this.growRotor();
    }
    if (n > this.counterCap) this.growCounters(n);
    if (n > this.barCap) this.growBars(n);
    if (n > this.ringCap) this.growRings(n);

    let nCounters = 0, nBars = 0, nRings = 0;
    const smooth = 1 - Math.exp(-dt * 3);
    const maxDist = dist * 5 + 20;

    const fog = this.fog;
    for (let i = 0; i < n; i++) {
      const u = units[i];
      if (fog && !fog.isUnitVisible(u)) continue; // Nebel des Krieges: nicht aufgeklärte Gegner nicht zeichnen
      const def = this.models[this.keyOf(u)];
      const domain = u.type.mobility.domain;
      const ground = domain === 'naval' ? 0 : Math.max(0, this.geo.heightAt(u.x, u.z)) * this.exag;
      let uy = u.y;
      if (domain === 'air') {
        // Flughöhe in Nahansicht stauchen, damit Luftfahrzeuge im Bild bleiben
        const alt = Math.max(0, u.y - ground);
        uy = ground + Math.min(alt, 0.15 * dist + 0.03);
        if (u.airborne && u.type.category !== 'jet') uy += Math.sin(timeSec * 1.7 + u.id) * 0.004 * SCALE.units;
      }
      const radius = this.counterMode ? COUNTER_PX * this.pxKm : def ? this.unitRadius(def, u.type.memberCount) : 0.1;
      _sphere.center.set(u.x, uy, u.z);
      _sphere.radius = radius + (uy - ground);
      if (!_frustum.intersectsSphere(_sphere)) continue;
      if (!this.counterMode && _cam.distanceTo(_sphere.center) > maxDist) continue;

      const affil = this.affiliation(u.owner, playerA3);
      if (this.counterMode) {
        const k = nCounters * 3;
        this.counterPos[k] = u.x;
        this.counterPos[k + 1] = uy + 0.002 * dist;
        this.counterPos[k + 2] = u.z;
        const ti = this.typeIndex.get(u.type.id) ?? 0;
        this.counterCell[nCounters] = (ti * 3 + affil) * 2 + (u.selected ? 1 : 0);
        this.counterSel[nCounters] = u.selected ? 1 : 0;
        nCounters++;
      } else if (def) {
        this.drawUnit(u, def, uy, dt, smooth, timeSec);
      }

      if (u.selected) {
        // Ring
        const rr = this.counterMode ? COUNTER_PX * 0.62 * this.pxKm : Math.min(Math.max(radius * 0.45, 12 * this.pxKm), 30 * this.pxKm);
        _p.set(u.x, ground + 0.001 * dist, u.z);
        _s.set(rr, 1, rr);
        _m.compose(_p, _q.identity(), _s);
        this.ringMesh.setMatrixAt(nRings, _m);
        _ringColor.setHex(affil === 0 ? 0x66ff66 : affil === 1 ? 0xff5040 : 0xffe060);
        this.ringMesh.setColorAt(nRings, _ringColor);
        nRings++;
        // Balken
        const b = nBars * 3;
        this.barPos[b] = u.x;
        this.barPos[b + 1] = uy;
        this.barPos[b + 2] = u.z;
        this.barVal[nBars * 2] = clamp(u.hp / u.type.hp, 0, 1);
        this.barVal[nBars * 2 + 1] = Number.isFinite(u.type.fuelKm) ? clamp(u.fuel / u.type.fuelKm, 0, 1) : 1;
        this.barOff[nBars] = this.counterMode ? COUNTER_PX * 0.62 + 6 : Math.max(18, (radius / this.pxKm) * 0.8 + 8);
        nBars++;
      }
    }

    for (const slot of this.slots.values()) this.finishSlot(slot);
    this.finishSlot(this.rotorSlot);

    this.counterGeom.instanceCount = nCounters;
    this.counterMesh.visible = nCounters > 0;
    if (nCounters) {
      this.markDirty(this.counterGeom, 'iPos', nCounters * 3);
      this.markDirty(this.counterGeom, 'iCell', nCounters);
      this.markDirty(this.counterGeom, 'iSel', nCounters);
    }
    this.barGeom.instanceCount = nBars;
    this.barMesh.visible = nBars > 0;
    if (nBars) {
      this.markDirty(this.barGeom, 'iPos', nBars * 3);
      this.markDirty(this.barGeom, 'iVal', nBars * 2);
      this.markDirty(this.barGeom, 'iOff', nBars);
    }
    this.ringMesh.count = nRings;
    this.ringMesh.visible = nRings > 0;
    if (nRings) {
      this.ringMesh.instanceMatrix.needsUpdate = true;
      if (this.ringMesh.instanceColor) this.ringMesh.instanceColor.needsUpdate = true;
    }

    // Aufräumen verwaister Darstellungszustände
    if (this.frameNo % 120 === 0 && this.vis.size > n) {
      for (const [id, v] of this.vis) if (this.frameNo - v.seen > 120 && !this.manager.get(id)) this.vis.delete(id);
    }
  }

  // ------------------------------------------------------------ intern

  private readonly keyCache = new Map<UnitTypeDef, Map<string, string>>();
  /** Modell-Slot-Schlüssel (Variante je Typ/Besitzerland) */
  private keyOf(u: Unit): string {
    let m = this.keyCache.get(u.type);
    if (!m) this.keyCache.set(u.type, (m = new Map()));
    let k = m.get(u.owner);
    if (k === undefined) {
      m.set(u.owner, (k = modelKeyFor(u.type.model, u.type.id, u.owner)));
      this.ensureModel(k);
    }
    return k;
  }

  /** Modell + Slots (Hoch-/Niedrig-Detail) bei Bedarf bauen */
  private ensureModel(key: string): void {
    if (this.models[key]) return;
    const build = MODEL_BUILDERS[key];
    if (!build) return;
    const def = build();
    this.models[key] = def;
    const slot = this.makeSlot(def, 16);
    this.slots.set(key, slot);
    this.object.add(slot.mesh);
    if (def.lod) {
      const lo = this.makeSlot(def.lod, 16);
      this.slots.set(`${key}#lo`, lo);
      this.loKeys.set(key, `${key}#lo`);
      this.object.add(lo.mesh);
    }
  }

  /** Restliche Modelle nacheinander im Leerlauf bauen (je Aufruf ein Modell, damit kein langer Frame entsteht) */
  private warmup(keys: string[]): void {
    let i = 0;
    const step = () => {
      while (i < keys.length && this.models[keys[i]]) i++;
      if (i >= keys.length) return;
      this.ensureModel(keys[i++]);
      window.setTimeout(step, 30);
    };
    window.setTimeout(step, 400);
  }

  /** Slot-Schlüssel inkl. Low-Detail-Variante (ab SOLDIER_LOD_KM Kameraabstand) */
  private slotKey(u: Unit): string {
    const k = this.keyOf(u);
    const lk = this.loKeys.get(k);
    if (lk === undefined) return k;
    return (this.models[k].vanim ? this.lowLodVeh : this.lowLod) ? lk : k;
  }

  private unitRadius(def: ModelDef, members: number): number {
    const sp = this.memberSpacing(def);
    return 0.001 * (def.size * this.modelScale(def) * 0.6 + sp * Math.sqrt(members) * 0.9);
  }

  /** fester Modellmaßstab (Modellmeter -> Darstellungsmeter), siehe SCALE */
  private modelScale(def: ModelDef): number {
    return unitModelScale(def.boost, def.anim === 'soldier');
  }

  /** Verbandsabstand in Darstellungsmetern (Layout-Offsets sind bereits skaliert) */
  private memberSpacing(def: ModelDef): number {
    return Math.max(def.size * this.modelScale(def) * 1.7, 2.5 * SCALE.units * 0.6);
  }

  /** Mitglieder eines Verbands in die Instanzpuffer schreiben */
  private drawUnit(u: Unit, def: ModelDef, uy: number, dt: number, smooth: number, time: number): void {
    // Phase 3: besetzte Gebäude -> unsichtbar
    if (u.garrisonId) return;
    const slot = this.slots.get(this.slotKey(u))!;
    // Phase 3: gefallene Soldaten nicht zeichnen (membersAlive, falls vom CombatSystem gesetzt)
    const nAll = Math.min(u.type.memberCount, 32);
    const n = Math.max(0, Math.min(nAll, Math.ceil(u.membersAlive ?? nAll)));
    let v = this.vis.get(u.id);
    if (!v) {
      v = { off: new Float32Array(nAll * 2), init: false, pitch: 0, roll: 0, lastHeading: u.heading, seen: 0, post: 0, walk: 0, mv: 0, aim: 0, gear: 0, slew: 0 };
      this.vis.set(u.id, v);
    }
    v.seen = this.frameNo;
    const sp = this.memberSpacing(def);
    const domain = u.type.mobility.domain;
    const moving = u.speedKmh > 0.5;
    const cat = u.type.category;

    // Phase 3: Deckungslinie (nur Infanterie, stehend)
    const coverLine = cat === 'infantry' && !!u.coverId && u.coverDirX !== undefined && u.coverDirZ !== undefined;
    const cdx = u.coverDirX ?? 0, cdz = u.coverDirZ ?? 0;
    // --- Ziel-Layout (m, lokal: x rechts, z nach hinten)
    const t = _tmpOff;
    for (let i = 0; i < n; i++) {
      let ox = 0, oz = 0;
      if (domain === 'air') {
        // gestaffelte Rotte/Schwarm
        const side = i % 2 === 1 ? 1 : -1;
        const k = Math.ceil(i / 2);
        ox = side * k * sp * 0.9;
        oz = k * sp * 0.7;
        if (cat === 'drone' && n > 2) {
          ox = (jit(u.id, i, 1)) * sp * 2.2;
          oz = (jit(u.id, i, 2)) * sp * 2.2;
        }
      } else if (domain === 'naval') {
        oz = i * sp * 1.4;
      } else if (coverLine && !moving) {
        // Phase 3: Mitglieder in Reihe entlang der Deckungslinie (quer zur Schutzrichtung), 2. Reihe leicht dahinter
        const perRow = Math.max(1, Math.min(n, 5));
        const row = Math.floor(i / perRow), col = i % perRow;
        const inRow = Math.min(perRow, n - row * perRow);
        const lat = (col - (inRow - 1) / 2) * sp * (u.posture === 'prone' ? 1.1 : 0.95);
        const back = row * sp * 0.9;
        // Welt-Vektoren (lat = (-dirZ, dirX), zurück = -dir) in lokale Koordinaten (rechts = (ch,sh), hinten = (-sh,ch))
        const wx = -cdz * lat - cdx * back, wz = cdx * lat - cdz * back;
        ox = wx * Math.cos(u.heading) + wz * Math.sin(u.heading);
        oz = -wx * Math.sin(u.heading) + wz * Math.cos(u.heading);
      } else if (moving && u.onRoad) {
        oz = i * sp * 1.25; // Kolonne
      } else if (moving) {
        const k = Math.ceil(i / 2);
        ox = (i === 0 ? 0 : i % 2 === 1 ? -1 : 1) * k * sp * 0.9;
        oz = k * sp * 0.8;
      } else {
        const cols = Math.max(1, Math.ceil(Math.sqrt(n * 2)));
        const row = Math.floor(i / cols), col = i % cols;
        const inRow = Math.min(cols, n - row * cols);
        const spread = cat === 'infantry' ? 1.2 : 1.35;
        // Einzelfahrzeug: exakt auf dem Einheitenmittelpunkt (kein Jitter), damit Klick/Auswahl genau trifft
        const jm = nAll > 1 ? 1 : 0;
        ox = (col - (inRow - 1) / 2) * sp * spread + jit(u.id, i, 3) * sp * 0.5 * jm;
        oz = row * sp * 1.1 + jit(u.id, i, 4) * sp * 0.4 * jm;
      }
      t[i * 2] = ox;
      t[i * 2 + 1] = oz;
    }
    const off = v.off;
    if (!v.init) {
      for (let i = 0; i < n * 2; i++) off[i] = t[i];
      v.init = true;
    } else {
      for (let i = 0; i < n * 2; i++) off[i] += (t[i] - off[i]) * smooth;
    }

    // --- Neigung (Hang) / Querlage (Kurvenflug)
    const h = u.heading;
    const sh = Math.sin(h), ch = Math.cos(h);
    const ws = 0.001; // Darstellungsmeter -> km (Layout-Offsets sind bereits skaliert)
    const ms = this.modelScale(def);
    if (def.tilt && domain === 'ground') {
      const half = Math.max(def.size * ms * ws * 0.5, 0.01);
      const hf = Math.max(0, this.geo.heightAt(u.x + sh * half, u.z - ch * half)) * this.exag;
      const hb = Math.max(0, this.geo.heightAt(u.x - sh * half, u.z + ch * half)) * this.exag;
      const target = clamp(Math.atan2(hf - hb, 2 * half), -0.35, 0.35);
      v.pitch += (target - v.pitch) * smooth;
    } else v.pitch = 0;
    if (cat === 'jet' || (cat === 'drone' && u.type.model === 'drone_fixed')) {
      const dh = wrap(h - v.lastHeading);
      const rate = dt > 0 ? dh / dt : 0;
      v.roll += (clamp(-rate * 0.6, -0.7, 0.7) - v.roll) * smooth;
    } else if (cat === 'helicopter') {
      v.pitch += ((moving ? -0.12 : 0) - v.pitch) * smooth; // Nase runter im Vorwärtsflug
    }
    v.lastHeading = h;

    const col = this.colorsFor(u.owner);
    const camo = def.livery === 'air' ? col.air : def.livery === 'naval' ? col.naval : def.livery === 'heli' ? col.heli : col.ground;
    const ic = slot.mesh.instanceColor!.array as Float32Array;
    const tc = slot.team.array as Float32Array;
    const scale = ws * ms;
    const isGround = domain === 'ground';
    // Phase 3: Haltung (Soldaten): stehen / kauern (~0.65 Höhe, vorgebeugt) / liegen (flach, nach vorn gekippt).
    // Bewegte Einheiten stehen immer (außer festgenagelt/Sprung).
    let postT = 0;
    if (cat === 'infantry' || u.type.model === 'soldier') {
      const pst = u.posture ?? 'stand';
      postT = moving && !u.pinned ? 0 : pst === 'prone' ? 2 : pst === 'crouch' ? 1 : 0;
    }
    v.post += (postT - v.post) * smooth;
    const pz = v.post;
    const lean = pz <= 1 ? pz * 0.3 : 0.3 + (pz - 1) * 1.15; // rad nach vorn (Kopf Richtung -z)
    const sy = pz <= 1 ? 1 - pz * 0.32 : 0.68 + (pz - 1) * 0.22; // Höhenskala
    const sz = pz > 1 ? 1 + (pz - 1) * 0.15 : 1; // liegend etwas gestreckt
    // Vault: kleiner Hüpfer (0.6 s)
    const vt = u.vaultT ?? 0;
    const hop = vt > 0 ? Math.sin(Math.PI * (1 - vt / 0.6)) * 0.9 * ws * ms : 0;
    // In Deckung (stehend) schauen die Soldaten zur Bedrohung (= Schutzrichtung der Deckung)
    const coverYaw = coverLine && !moving ? Math.atan2(cdx, -cdz) : NaN;
    const airborne = !!u.airborne;
    // --- Fahrzeug-Animation (Turm/Rohr/Rückstoß/Laufwerk, siehe vehPrep)
    const vv = slot.va && def.vanim ? this.vehPrep(u, v, def, dt, ws * ms, nAll, time) : null;
    const wobP = vv ? vv.wobP : 0, wobR = vv ? vv.wobR : 0, bobY = vv ? vv.bobY * ws * ms : 0;
    // --- Animationszustand für das Anim-Material (Soldaten: Gehen/Anschlag; Luft/See: Fahrwerk, Geschützdrehung)
    const an = slot.anim ? (slot.anim.array as Float32Array) : null;
    const animSoldier = def.anim === 'soldier';
    const nat = animSoldier ? NATION_ID[u.owner] ?? (DESERT.has(u.owner) ? 4 : 5) : 0;
    let aThrust = 0, aZ = 0;
    if (an) {
      if (animSoldier) {
        const spd = moving && !u.pinned ? u.speedKmh : 0;
        const tMv = spd > 0.3 ? Math.min(1, 0.1 + spd * 0.09) : 0;
        v.mv += (tMv - v.mv) * smooth;
        const rate = 5.5 + 4 * Math.max(0, v.mv * 2 - 1);
        v.walk = (v.walk + dt * rate * clamp(v.mv * 4, 0, 1)) % 628.3185;
        const aimT = u.engaged || (u.targetId ?? 0) > 0 ? 1 : 0;
        v.aim += (aimT - v.aim) * (1 - Math.exp(-dt * 7));
        aThrust = v.mv;
        aZ = v.aim;
      } else {
        const maxSp = u.type.mobility.offroadSpeed || 1;
        aThrust = airborne || domain === 'naval' ? clamp(0.35 + (0.65 * u.speedKmh) / maxSp, 0, 1) : 0;
        if (cat === 'jet') {
          const alt = u.y - Math.max(0, this.geo.heightAt(u.x, u.z)) * this.exag;
          const gt = airborne && alt > 0.05 ? 1 : 0;
          v.gear += (gt - v.gear) * (1 - Math.exp(-dt * 0.9));
          aZ = v.gear;
        } else {
          // Chin-Turm / Bordgeschütz dreht zum Ziel (relativ zum Bug)
          let want = 0;
          const tgt = u.targetId ? this.manager.get(u.targetId) : undefined;
          if (tgt) {
            want = -wrap(Math.atan2(tgt.x - u.x, -(tgt.z - u.z)) - u.heading);
            if (domain === 'air') want = clamp(want, -1.4, 1.4);
          }
          v.slew += clamp(wrap(want - v.slew), -dt * 2.2, dt * 2.2);
          aZ = v.slew;
        }
      }
    }
    for (let i = 0; i < n; i++) {
      if (slot.count >= slot.cap) break;
      const ox = off[i * 2] * ws, oz = off[i * 2 + 1] * ws;
      // lokal -> Welt (x rechts, z hinten): rechts = (cos h, sin h), hinten = (−sin h, cos h)
      const wx = u.x + ox * ch - oz * sh;
      const wz = u.z + ox * sh + oz * ch;
      let wy = uy;
      if (isGround) wy = Math.max(0, this.geo.heightAt(wx, wz)) * this.exag;
      const yawJ = !moving && isGround && nAll > 1 ? jit(u.id, i, 5) * (cat === 'infantry' ? 1.2 : 0.25) : 0;
      const yawBase = coverYaw === coverYaw ? coverYaw : h;
      _e.set(v.pitch + wobP, -yawBase + yawJ, v.roll + wobR);
      _q.setFromEuler(_e);
      if (lean > 0.001) {
        // Haltung: Kippung um die lokale X-Achse (nach dem Gieren)
        _q2.setFromAxisAngle(_xAxis, -lean);
        _q.multiply(_q2);
      }
      _p.set(wx, wy + hop + bobY, wz);
      if (pz > 0.001) _s.set(scale, scale * sy, scale * sz);
      else _s.setScalar(scale);
      _m.compose(_p, _q, _s);
      const k = slot.count;
      slot.mesh.setMatrixAt(k, _m);
      ic[k * 3] = camo.r;
      ic[k * 3 + 1] = camo.g;
      ic[k * 3 + 2] = camo.b;
      tc[k * 3] = col.team.r;
      tc[k * 3 + 1] = col.team.g;
      tc[k * 3 + 2] = col.team.b;
      if (an) {
        const hs = (jit(u.id, i, 9) + 0.5) * 0.99;
        an[k * 4] = animSoldier ? v.walk + (jit(u.id, i, 7) + 0.5) * 6.2832 : 0;
        an[k * 4 + 1] = aThrust;
        an[k * 4 + 2] = aZ;
        an[k * 4 + 3] = nat + hs;
      }
      if (vv) this.vehWrite(slot, k, vv, def, u.id, i, time);
      slot.count++;

      if (def.rotors) {
        const rs = this.rotorSlot;
        const ric = rs.mesh.instanceColor!.array as Float32Array;
        for (let r = 0; r < def.rotors.length; r++) {
          if (rs.count >= rs.cap) break;
          const [rx, ry, rz, rad, axis] = def.rotors[r];
          const tail = axis === 'x';
          const spin = airborne ? time * (def.size < 2 ? 60 : tail ? 40 : 22) * (r % 2 === 0 ? 1 : -1) : (u.id * 0.7 + i + r) % 3;
          _q2.setFromAxisAngle(_yAxis, spin);
          if (tail) _q2.premultiply(_qTail); // Scheibe senkrecht (Normale = x)
          _m2.compose(_p.set(rx, ry, rz), _q2, _s.set(rad, 1, rad));
          _m2.premultiply(_m);
          rs.mesh.setMatrixAt(rs.count, _m2);
          ric[rs.count * 3] = 1;
          ric[rs.count * 3 + 1] = 1;
          ric[rs.count * 3 + 2] = 1;
          rs.count++;
        }
      }
    }
  }

  /** Fahrzeug-Animationszustand fortschreiben: Strecke (Räder/Ketten), Turm/Rohr zum Ziel, Rückstoßzeiten, Federung */
  private vehPrep(u: Unit, v: UnitVis, def: ModelDef, dt: number, kmPerM: number, nm: number, _time: number): VehVis {
    const sp = def.vanim!;
    let w = v.veh;
    if (!w) {
      w = v.veh = {
        tYaw: 0, elev: sp.elevRest, odo: 0, odoT: 0, lx: u.x, lz: u.z, mv: 0, bobY: 0, wobP: 0, wobR: 0,
        nm: Math.max(1, nm), fireIdx: 0, rec: new Float32Array(Math.max(1, nm)).fill(9), init: true,
      };
    }
    // Strecke (Modellmeter, vorzeichenbehaftet) – auch aus der Ferne fortschreiben, damit nichts springt
    const dx = u.x - w.lx, dz = u.z - w.lz;
    w.lx = u.x;
    w.lz = u.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.5 && d > 1e-7) w.odoT += ((dx * Math.sin(u.heading) - dz * Math.cos(u.heading) >= 0 ? 1 : -1) * d) / kmPerM;
    if (this.camDist > Q.vehAnimKm) {
      w.odo = w.odoT;
      w.wobP = w.wobR = w.bobY = 0;
      return w;
    }
    w.odo += (w.odoT - w.odo) * (1 - Math.exp(-dt * 12));
    const moving = u.speedKmh > 0.5 ? 1 : 0;
    w.mv += (moving - w.mv) * (1 - Math.exp(-dt * 3));
    const ph = w.odo * 1.3;
    w.bobY = sp.bob * w.mv * (Math.sin(ph * 2.1) + 0.6 * Math.sin(ph * 3.7));
    w.wobP = 0.012 * w.mv * Math.sin(ph * 1.7);
    w.wobR = 0.01 * w.mv * Math.sin(ph * 2.3 + 1);
    // Ziel bestimmen
    let hasT = false, tx = 0, tz = 0;
    if (sp.turretRate > 0 || sp.elevMode !== 'none') {
      if (u.targetId) {
        const t = this.manager.get(u.targetId);
        if (t && t.hp > 0) {
          tx = t.x;
          tz = t.z;
          hasT = true;
        }
      }
      if (!hasT && u.fireX !== undefined && u.fireZ !== undefined) {
        tx = u.fireX;
        tz = u.fireZ;
        hasT = true;
      }
    }
    const engaged = !!u.engaged;
    const dKm = hasT ? Math.hypot(tx - u.x, tz - u.z) : 0;
    if (sp.turretRate > 0) {
      const want = hasT ? wrap(Math.atan2(tx - u.x, -(tz - u.z)) - u.heading) : 0;
      const step = sp.turretRate * dt;
      w.tYaw = wrap(w.tYaw + clamp(wrap(want - w.tYaw), -step, step));
    }
    // Rohrerhöhung
    let wantEl = sp.elevRest;
    const rng = Math.max(0.5, u.type.rangeKm);
    switch (sp.elevMode) {
      case 'direct':
        if (hasT) wantEl = sp.elevRest + Math.min(0.08, dKm * 0.015);
        break;
      case 'indirect':
        if (hasT) wantEl = 0.3 + 0.8 * clamp(dKm / rng, 0, 1);
        break;
      case 'launcher':
        if (hasT || engaged) wantEl = sp.elevMax * (0.65 + 0.35 * clamp(dKm / rng, 0, 1));
        break;
      case 'sam':
        if (hasT || engaged) wantEl = sp.elevMax;
        break;
      case 'aa':
        if (hasT) wantEl = 0.45 + 0.5 * clamp(1 - dKm / rng, 0, 1);
        else if (engaged) wantEl = 0.7;
        break;
      default:
        break;
    }
    wantEl = clamp(wantEl, sp.elevRest, sp.elevMax);
    if (sp.elevMode !== 'none') {
      const es = sp.elevRate * dt;
      w.elev += clamp(wantEl - w.elev, -es, es);
    }
    for (let i = 0; i < w.nm; i++) if (w.rec[i] < 9) w.rec[i] += dt;
    return w;
  }

  /** Instanzdaten eines Fahrzeugs (aVA/aVB) schreiben */
  private vehWrite(slot: ModelSlot, k: number, w: VehVis, def: ModelDef, id: number, i: number, time: number): void {
    const sp = def.vanim!;
    const va = slot.va!.array as Float32Array;
    const vb = slot.vb!.array as Float32Array;
    const t = w.rec[i % w.nm];
    let rc = 0;
    if (t < 0.35) {
      const x = t / 0.35;
      rc = x < 0.12 ? x / 0.12 : Math.pow(1 - (x - 0.12) / 0.88, 2);
    }
    const o = k * 4;
    va[o] = w.tYaw;
    va[o + 1] = w.elev;
    va[o + 2] = rc * sp.recoil;
    va[o + 3] = w.odo;
    vb[o] = (time * sp.radarRate + id * 0.7 + i * 1.9) % 6.2831853;
    vb[o + 1] = 0.25 + 0.7 * (jit(id, i, 12) + 0.5);
    vb[o + 2] = Math.min(2, Math.floor((jit(id, i, 11) + 0.5) * 3));
    vb[o + 3] = 0;
  }

  private finishSlot(slot: ModelSlot): void {
    slot.mesh.count = slot.count;
    slot.mesh.visible = slot.count > 0;
    if (slot.count) {
      slot.mesh.instanceMatrix.clearUpdateRanges();
      slot.mesh.instanceMatrix.addUpdateRange(0, slot.count * 16);
      slot.mesh.instanceMatrix.needsUpdate = true;
      const ic = slot.mesh.instanceColor!;
      ic.clearUpdateRanges();
      ic.addUpdateRange(0, slot.count * 3);
      ic.needsUpdate = true;
      slot.team.clearUpdateRanges();
      slot.team.addUpdateRange(0, slot.count * 3);
      slot.team.needsUpdate = true;
      if (slot.va && slot.vb) {
        for (const a of [slot.va, slot.vb]) {
          a.clearUpdateRanges();
          a.addUpdateRange(0, slot.count * 4);
          a.needsUpdate = true;
        }
      }
      if (slot.anim) {
        slot.anim.clearUpdateRanges();
        slot.anim.addUpdateRange(0, slot.count * 4);
        slot.anim.needsUpdate = true;
      }
    }
  }

  private markDirty(g: THREE.BufferGeometry, name: string, len: number): void {
    const a = g.getAttribute(name) as THREE.InstancedBufferAttribute;
    a.clearUpdateRanges();
    a.addUpdateRange(0, len);
    a.needsUpdate = true;
  }

  private makeSlot(def: ModelDef, cap: number): ModelSlot {
    const team = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    team.setUsage(THREE.DynamicDrawUsage);
    def.geom.setAttribute('aTeam', team);
    let anim: THREE.InstancedBufferAttribute | null = null;
    if (def.anim) {
      anim = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
      anim.setUsage(THREE.DynamicDrawUsage);
      def.geom.setAttribute('iAnim', anim);
    }
    let va: THREE.InstancedBufferAttribute | null = null, vb: THREE.InstancedBufferAttribute | null = null;
    if (def.vanim) {
      va = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
      vb = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
      def.geom.setAttribute('aVA', va);
      def.geom.setAttribute('aVB', vb);
    }
    const mesh = new THREE.InstancedMesh(def.geom, def.anim ? this.animMaterial : def.vanim ? this.vehMaterial : this.material, cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.visible = false;
    return { def, mesh, team, cap, count: 0, need: 0, anim, va, vb };
  }

  private growSlot(key: string, slot: ModelSlot): void {
    const cap = Math.max(slot.need, slot.cap * 2);
    const fresh = this.makeSlot(slot.def, cap);
    fresh.mesh.name = `Unit_${key}`;
    this.object.remove(slot.mesh);
    slot.mesh.dispose();
    this.object.add(fresh.mesh);
    slot.mesh = fresh.mesh;
    slot.team = fresh.team;
    slot.anim = fresh.anim;
    slot.va = fresh.va;
    slot.vb = fresh.vb;
    slot.cap = cap;
  }

  private growRotor(): void {
    const slot = this.rotorSlot;
    const cap = Math.max(slot.need, slot.cap * 2);
    const fresh = this.makeSlot(slot.def, cap);
    this.object.remove(slot.mesh);
    slot.mesh.dispose();
    this.object.add(fresh.mesh);
    slot.mesh = fresh.mesh;
    slot.team = fresh.team;
    slot.cap = cap;
  }

  private growCounters(n: number): void {
    const cap = Math.max(n, this.counterCap * 2, 64);
    this.counterCap = cap;
    this.counterPos = new Float32Array(cap * 3);
    this.counterCell = new Float32Array(cap);
    this.counterSel = new Float32Array(cap);
    this.counterGeom.setAttribute('iPos', new THREE.InstancedBufferAttribute(this.counterPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.counterGeom.setAttribute('iCell', new THREE.InstancedBufferAttribute(this.counterCell, 1).setUsage(THREE.DynamicDrawUsage));
    this.counterGeom.setAttribute('iSel', new THREE.InstancedBufferAttribute(this.counterSel, 1).setUsage(THREE.DynamicDrawUsage));
  }

  private growBars(n: number): void {
    const cap = Math.max(n, this.barCap * 2, 64);
    this.barCap = cap;
    this.barPos = new Float32Array(cap * 3);
    this.barVal = new Float32Array(cap * 2);
    this.barOff = new Float32Array(cap);
    this.barGeom.setAttribute('iPos', new THREE.InstancedBufferAttribute(this.barPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.barGeom.setAttribute('iVal', new THREE.InstancedBufferAttribute(this.barVal, 2).setUsage(THREE.DynamicDrawUsage));
    this.barGeom.setAttribute('iOff', new THREE.InstancedBufferAttribute(this.barOff, 1).setUsage(THREE.DynamicDrawUsage));
  }

  private makeRingMesh(cap: number): THREE.InstancedMesh {
    const m = new THREE.InstancedMesh(this.ringGeom, this.ringMat, cap);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    m.frustumCulled = false;
    m.renderOrder = 39;
    m.count = 0;
    m.name = 'UnitSelectionRings';
    this.ringCap = cap;
    return m;
  }

  private growRings(n: number): void {
    const fresh = this.makeRingMesh(Math.max(n, this.ringCap * 2));
    this.object.remove(this.ringMesh);
    this.ringMesh.dispose();
    this.ringMesh = fresh;
    this.object.add(fresh);
  }

  /** 0 = Freund (blau), 1 = Feind/sonstige (rot), 2 = neutral (grün) */
  private affiliation(owner: string, player: string | null): number {
    let a = this.affilCache.get(owner);
    if (a !== undefined) return a;
    if (!player) a = 2;
    else if (owner === player) a = 0;
    else {
      const allies = getProfile(player)?.allies ?? [];
      const rel = getRelation(player, owner);
      const bp = blocOf(player), bo = blocOf(owner);
      if (allies.includes(owner) || rel >= 60 || (bp !== 'NEUTRAL' && bp === bo && rel >= 20)) a = 0;
      else if (rel < 0) a = 1;
      else a = 2;
    }
    this.affilCache.set(owner, a);
    return a;
  }

  private colorsFor(owner: string): OwnerColors {
    let c = this.ownerColors.get(owner);
    if (c) return c;
    const prof = getProfile(owner);
    const meta = this.geo.countriesByA3.get(owner);
    const team = new THREE.Color();
    if (prof) team.setStyle(prof.color);
    else team.setHex(MAPCOLOR_TEAM[(meta?.mapColor ?? 0) % MAPCOLOR_TEAM.length]);
    const groundHex = CAMO[owner] ?? (DESERT.has(owner) ? 0x8a7a55 : 0x555a3c);
    c = {
      ground: new THREE.Color(groundHex).multiplyScalar(1.7),
      heli: new THREE.Color(DESERT.has(owner) ? 0x7a7458 : HELI_GREEN).multiplyScalar(1.6),
      air: new THREE.Color(AIR_GREY).multiplyScalar(1.3),
      naval: new THREE.Color(NAVAL_GREY).multiplyScalar(1.3),
      team,
    };
    this.ownerColors.set(owner, c);
    return c;
  }

  private buildAtlas(): THREE.Texture {
    const size = ATLAS_CELLS * CELL_PX;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, size, size);
    const ids = Object.keys(UNIT_TYPES);
    ids.forEach((id, ti) => {
      for (let affil = 0; affil < 3; affil++) {
        for (let sel = 0; sel < 2; sel++) {
          const cell = (ti * 3 + affil) * 2 + sel;
          if (cell >= ATLAS_CELLS * ATLAS_CELLS) continue;
          const ox = (cell % ATLAS_CELLS) * CELL_PX, oy = Math.floor(cell / ATLAS_CELLS) * CELL_PX;
          drawCounter(ctx, ox, oy, UNIT_TYPES[id], affil, sel === 1);
        }
      }
    });
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 1;
    return tex;
  }
}

function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}
function wrap(a: number): number {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}
/** deterministischer Jitter -0.5..0.5 je (Unit, Mitglied, Kanal) */
function jit(id: number, i: number, salt: number): number {
  let t = Math.imul(id * 31 + i * 7919 + salt * 104729, 0x27d4eb2d) >>> 0;
  t = Math.imul(t ^ (t >>> 15), 0x2c1b3c6d) >>> 0;
  return ((t ^ (t >>> 13)) >>> 0) / 4294967296 - 0.5;
}
