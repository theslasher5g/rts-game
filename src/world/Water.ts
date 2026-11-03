import * as THREE from 'three';
import type { GeoData } from './GeoData';
import type { Settings } from '../core/types';
import { SUN_COLOR, SUN_DIR, getHeightTexture, getNoiseTextures } from './Terrain';

/** Ausdehnung der Wasserfläche über den Kartenrand hinaus (km) */
const WATER_MARGIN_KM = 20000;

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
#include <fog_pars_vertex>
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
#include <fog_pars_fragment>

uniform sampler2D uHeight;
uniform sampler2D uNoiseN;
uniform sampler2D uNoiseL;
uniform vec2 uMapKm;
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
varying vec3 vWorld;

vec3 srgb(vec3 c) { return pow(c, vec3(2.2)); }

float fadeFor(vec2 uv, float a, float b) {
  vec2 fw = fwidth(uv);
  return 1.0 - smoothstep(a, b, max(fw.x, fw.y));
}

void main() {
  #include <logdepthbuf_fragment>
  vec2 xz = vWorld.xz;
  vec2 uv = xz / uMapKm;
  // Abstand außerhalb der Karte (km) -> Übergang zu Tiefsee
  vec2 outside = max(-xz, xz - uMapKm);
  float outKm = max(max(outside.x, outside.y), 0.0);
  float hk = texture2D(uHeight, clamp(uv, 0.0, 1.0)).r;
  hk = mix(hk, -4.0, smoothstep(0.0, 250.0, outKm));
  float depth = max(-hk, 0.0);

  vec3 cShallow = srgb(vec3(0.33, 0.47, 0.45));
  vec3 cMid     = srgb(vec3(0.16, 0.28, 0.33));
  vec3 cDeep    = srgb(vec3(0.08, 0.14, 0.21));
  vec3 col = mix(cShallow, cMid, smoothstep(0.0, 0.09, depth));
  col = mix(col, cDeep, smoothstep(0.09, 1.6, depth));

  // Wellen: quantisierte Zeit, niedrig aufgelöste Muster in 2 Skalen
  float tq = floor(uTime * 6.0) / 6.0;
  vec2 w1 = xz / 0.6 + vec2(tq * 0.9, tq * 0.35);
  vec2 w2 = xz / 14.0 + vec2(-tq * 0.25, tq * 0.18);
  float f1 = fadeFor(w1, 0.2, 0.6);
  float f2 = fadeFor(w2, 0.2, 0.6);
  vec2 n1 = vec2(texture2D(uNoiseN, w1 / 64.0).r, texture2D(uNoiseN, w1 / 64.0 + vec2(0.37, 0.71)).r) - 0.5;
  vec2 n2 = vec2(texture2D(uNoiseL, w2 / 64.0).r, texture2D(uNoiseL, w2 / 64.0 + vec2(0.53, 0.19)).r) - 0.5;
  vec2 slope = n1 * 0.35 * f1 + n2 * 0.25 * f2;
  vec3 n = normalize(vec3(slope.x, 1.0, slope.y));

  vec3 V = normalize(cameraPosition - vWorld);
  float ndl = max(dot(n, uSunDir), 0.0);
  vec3 amb = srgb(vec3(0.55, 0.60, 0.66)) * 0.55;
  col *= amb + uSunColor * ndl * 0.75;

  // Himmelsreflexion (Fresnel) + quantisiertes Glanzlicht
  float fres = pow(1.0 - max(dot(n, V), 0.0), 4.0);
  col = mix(col, srgb(vec3(0.55, 0.62, 0.68)), fres * 0.35);
  vec3 Hh = normalize(uSunDir + V);
  float spec = pow(max(dot(n, Hh), 0.0), 70.0);
  spec = floor(spec * 4.0 + 0.3) / 4.0;
  col += uSunColor * spec * 0.16 * max(f1, f2);

  // Brandung an der Küste
  float fwD = fwidth(depth);
  float coastBand = 1.0 - smoothstep(0.0, 0.004 + fwD * 1.5, depth);
  float foamNoise = texture2D(uNoiseN, (xz / 0.35 + vec2(tq * 0.6, -tq * 0.4)) / 64.0).r;
  float foam = coastBand * mix(0.6, step(0.45, foamNoise), f1) * step(outKm, 0.0);
  col = mix(col, srgb(vec3(0.78, 0.80, 0.78)), foam * 0.55);

  gl_FragColor = vec4(col, 1.0);
  #include <fog_fragment>
}
`;

export class Water {
  readonly object: THREE.Object3D;
  private readonly uniforms: Record<string, THREE.IUniform>;
  private readonly material: THREE.ShaderMaterial;

  constructor(geo: GeoData, settings: Settings, heightTex?: THREE.Texture) {
    const noise = getNoiseTextures();
    this.uniforms = {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uHeight: { value: heightTex ?? getHeightTexture(geo) },
      uNoiseN: { value: noise.nearest },
      uNoiseL: { value: noise.linear },
      uMapKm: { value: new THREE.Vector2(geo.widthKm, geo.heightKm) },
      uTime: { value: 0 },
      uSunDir: { value: SUN_DIR.clone() },
      uSunColor: { value: SUN_COLOR.clone() },
    };
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms,
      fog: true,
    });
    const w = geo.widthKm + 2 * WATER_MARGIN_KM;
    const h = geo.heightKm + 2 * WATER_MARGIN_KM;
    const g = new THREE.PlaneGeometry(w, h, 48, 48);
    g.rotateX(-Math.PI / 2);
    g.translate(geo.widthKm / 2, 0, geo.heightKm / 2);
    const mesh = new THREE.Mesh(g, this.material);
    mesh.name = 'Water';
    mesh.frustumCulled = false;
    mesh.renderOrder = 1; // nach dem Gelände zeichnen (Early-Z)
    this.object = mesh;
    this.applySettings(settings);
  }

  update(_camera: THREE.PerspectiveCamera, timeSec: number): void {
    this.uniforms.uTime.value = timeSec;
  }

  applySettings(_s: Settings): void {
    // Wasserfläche liegt unabhängig von der Überhöhung bei y = 0 – nichts zu tun.
  }
}
