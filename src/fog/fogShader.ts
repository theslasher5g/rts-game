/**
 * Nebel des Krieges – gemeinsamer Shader-Baustein.
 * Die Fog-Textur (FogOfWar.texture) ist RGBA8, 0.5 km je Texel: R = aktuell sichtbar, G = erkundet.
 * UV = Weltposition (x, z) / Kartengröße in km (Zeile 0 = Norden).
 *
 * Nutzung in eigenen ShaderMaterials:
 *   - uniforms: { ...createFogUniforms() } (bzw. die Objekte des Terrains teilen) und FOG_GLSL in den Fragment-Shader,
 *     am Ende:  gl_FragColor.rgb = fogOfWar(gl_FragColor.rgb, worldXZ);
 * Nutzung mit Standard-Materialien (Lambert/Basic/Standard): applyFogToMaterial(material, uniforms).
 *
 * Hinweis: Water.ts / Cities.ts / Vegetation / Roads sind nicht Teil dieser Phase – ihre Besitzer rufen
 * applyFogToMaterial() bzw. FOG_GLSL später auf (siehe Bericht).
 */
import * as THREE from 'three';

export interface FogUniforms {
  uFog: THREE.IUniform<THREE.Texture>;
  uFogSize: THREE.IUniform<THREE.Vector2>;
  uFogOn: THREE.IUniform<number>;
}

let defaultTex: THREE.DataTexture | null = null;
/** 1×1-Textur "alles sichtbar" für den Fall ohne Fog */
function whiteTexture(): THREE.DataTexture {
  if (!defaultTex) {
    defaultTex = new THREE.DataTexture(new Uint8Array([255, 255, 0, 255]), 1, 1, THREE.RGBAFormat);
    defaultTex.needsUpdate = true;
  }
  return defaultTex;
}

export function createFogUniforms(): FogUniforms {
  return {
    uFog: { value: whiteTexture() },
    uFogSize: { value: new THREE.Vector2(1, 1) },
    uFogOn: { value: 0 },
  };
}

export function setFogUniforms(u: FogUniforms, tex: THREE.Texture | null, widthKm: number, heightKm: number): void {
  u.uFog.value = tex ?? whiteTexture();
  u.uFogSize.value.set(widthKm, heightKm);
  if (!tex) u.uFogOn.value = 0;
}

/** Uniform-Deklarationen + Funktion fogOfWar(colLinear, worldXZ) */
export const FOG_GLSL = /* glsl */ `
uniform sampler2D uFog;
uniform vec2 uFogSize;
uniform float uFogOn;
float fogHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 fogOfWar(vec3 col, vec2 xz) {
  if (uFogOn < 0.5) return col;
  vec2 f = texture2D(uFog, xz / uFogSize).rg;
  float n = (fogHash(gl_FragCoord.xy) - 0.5) * 0.22;
  float vis = smoothstep(0.30, 0.70, f.r + n);
  float exp = smoothstep(0.30, 0.70, f.g + n);
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  vec3 known = mix(col, vec3(l), 0.62) * 0.58;
  vec3 unk = vec3(l) * vec3(0.55, 0.62, 0.78) * 0.15 + vec3(0.003, 0.005, 0.009);
  return mix(mix(unk, known, exp), col, vis);
}
`;

/**
 * Hängt den Fog-Look an ein Standard-Material (MeshLambert/Basic/Standard, auch instanziert).
 * Das Material teilt die Uniform-Objekte (Textur-Wechsel wirkt sofort). Bestehendes onBeforeCompile bleibt erhalten.
 */
export function applyFogToMaterial(material: THREE.Material, fogUniforms: FogUniforms): void {
  const prev = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.call(material, shader, renderer);
    shader.uniforms.uFog = fogUniforms.uFog;
    shader.uniforms.uFogSize = fogUniforms.uFogSize;
    shader.uniforms.uFogOn = fogUniforms.uFogOn;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vFogXZ;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        {
          vec4 fogWP = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
          fogWP = instanceMatrix * fogWP;
          #endif
          vFogXZ = (modelMatrix * fogWP).xz;
        }`,
      );
    const frag = shader.fragmentShader.replace('#include <common>', `#include <common>\nvarying vec2 vFogXZ;\n${FOG_GLSL}`);
    const apply = 'gl_FragColor.rgb = fogOfWar(gl_FragColor.rgb, vFogXZ);';
    if (frag.includes('#include <opaque_fragment>')) shader.fragmentShader = frag.replace('#include <opaque_fragment>', `#include <opaque_fragment>\n${apply}`);
    else shader.fragmentShader = frag.replace('#include <fog_fragment>', `${apply}\n#include <fog_fragment>`);
  };
  material.customProgramCacheKey = () => `${prevKey ? prevKey.call(material) : ''}|fogow`;
  material.needsUpdate = true;
}
