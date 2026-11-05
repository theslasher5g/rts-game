import * as THREE from 'three';
import type { Settings } from '../core/types';
import { SUN_COLOR, SUN_DIR } from '../world/Terrain';

/** Nebel-/Horizontfarbe (sRGB-Hex) – leicht schmutziges Graublau */
export const FOG_COLOR = 0x8e989b;
const SKY_ZENITH = 0x4f6478;

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww; // auf die Far-Plane
}
`;
const SKY_FRAG = /* glsl */ `
uniform vec3 uHorizon;
uniform vec3 uZenith;
varying vec3 vDir;
void main() {
  float y = normalize(vDir).y;
  float t = smoothstep(0.0, 0.55, y);
  gl_FragColor = vec4(mix(uHorizon, uZenith, t), 1.0);
}
`;

const POST_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;
const POST_FRAG = /* glsl */ `
uniform sampler2D tScene;
uniform vec2 uLowRes;
uniform float uLevels;
uniform float uDither;
uniform float uTime;
varying vec2 vUv;

vec3 linearToSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float bayer4(vec2 p) {
  ivec2 q = ivec2(mod(p, 4.0));
  int i = q.x + q.y * 4;
  int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(m[i]) + 0.5) / 16.0;
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec2 pix = floor(vUv * uLowRes);                 // virtuelles (niedrig aufgelöstes) Pixel
  vec3 c = texture2D(tScene, (pix + 0.5) / uLowRes).rgb;
  c = linearToSrgb(c);

  // Grading: leicht entsättigt, warm/schmutzig, etwas Kontrast
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(vec3(l), c, 0.84);
  c = c * vec3(1.03, 1.0, 0.93) + vec3(0.018, 0.014, 0.004);
  c = (c - 0.5) * 1.07 + 0.5;

  // Vignette
  vec2 d = vUv - 0.5;
  c *= mix(0.74, 1.0, 1.0 - smoothstep(0.25, 0.85, length(d * vec2(1.0, 0.85)) * 1.15));
  // Scanlines + Körnung (sehr dezent)
  c *= 1.0 - 0.025 * mod(pix.y, 2.0);
  c += (hash12(pix + floor(uTime * 20.0) * 17.0) - 0.5) * 0.022;

  // Farbquantisierung mit 4x4-Bayer-Dithering
  if (uDither > 0.5) {
    c += (bayer4(pix) - 0.5) / uLevels;
    c = floor(clamp(c, 0.0, 1.0) * uLevels + 0.5) / uLevels;
  }
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

/**
 * Renderer mit PS2-artigem Post-Processing: Szene in niedrig aufgelöstes Ziel, dann Vollbild-Pass
 * (Nearest-Upscale, Quantisierung + Bayer-Dithering, Grading, Vignette, Scanlines, Körnung).
 */
export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;

  private readonly target: THREE.WebGLRenderTarget;
  private readonly postScene = new THREE.Scene();
  private readonly postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly postMat: THREE.ShaderMaterial;
  private readonly sky: THREE.Mesh;
  private readonly fog: THREE.Fog;
  private readonly camPos = new THREE.Vector3();
  private width = 1;
  private height = 1;
  private pixelScale = 2;

  constructor(canvas: HTMLCanvasElement, settings: Settings) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      logarithmicDepthBuffer: true,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.autoClear = true;
    this.renderer.info.autoReset = false; // zwei Render-Aufrufe je Frame (Szene + Post): Zähler selbst je Frame zurücksetzen
    canvas.style.imageRendering = 'pixelated';

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(FOG_COLOR);
    this.fog = new THREE.Fog(FOG_COLOR, 1000, 20000);
    scene.fog = this.fog;
    this.scene = scene;

    // Licht für Standardmaterialien (Gelände/Wasser rechnen eigenes Licht)
    this.sun = new THREE.DirectionalLight(SUN_COLOR.clone(), 2.6);
    this.sun.position.copy(SUN_DIR).multiplyScalar(1000);
    this.sun.target.position.set(0, 0, 0);
    this.hemi = new THREE.HemisphereLight(0xb4c0cc, 0x5a5042, 1.5);
    scene.add(this.sun, this.sun.target, this.hemi);

    // Himmelskuppel (folgt der Kamera)
    const skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: {
        uHorizon: { value: new THREE.Color(FOG_COLOR) },
        uZenith: { value: new THREE.Color(SKY_ZENITH) },
      },
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12), skyMat);
    this.sky.name = 'Sky';
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1000;
    scene.add(this.sky);

    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
      // 32-bit-Float-Tiefe: zusammen mit dem log. Tiefenpuffer genug Präzision von 1 km bis 20 000 km
      depthTexture: new THREE.DepthTexture(1, 1, THREE.FloatType),
    });

    this.postMat = new THREE.ShaderMaterial({
      vertexShader: POST_VERT,
      fragmentShader: POST_FRAG,
      uniforms: {
        tScene: { value: this.target.texture },
        uLowRes: { value: new THREE.Vector2(1, 1) },
        uLevels: { value: 31 },
        uDither: { value: 1 },
        uTime: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.postMat);
    quad.frustumCulled = false;
    this.postScene.add(quad);

    this.applySettings(settings);
    this.setSize(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight);
  }

  /** Größe in CSS-Pixeln */
  setSize(width: number, height: number): void {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.renderer.setSize(this.width, this.height, true);
    this.resizeTarget();
  }

  private resizeTarget(): void {
    const w = Math.max(1, Math.ceil(this.width / this.pixelScale));
    const h = Math.max(1, Math.ceil(this.height / this.pixelScale));
    this.target.setSize(w, h);
    (this.postMat.uniforms.uLowRes.value as THREE.Vector2).set(w, h);
  }

  /** Größe des internen (niedrig aufgelösten) Renderziels */
  get internalSize(): { width: number; height: number } {
    return { width: this.target.width, height: this.target.height };
  }

  applySettings(s: Settings): void {
    const ps = Math.max(1, Math.min(4, Math.round(s.pixelScale)));
    const bits = Math.max(2, Math.min(8, Math.round(s.colorBits)));
    this.postMat.uniforms.uLevels.value = Math.pow(2, bits) - 1;
    this.postMat.uniforms.uDither.value = s.dithering ? 1 : 0;
    if (ps !== this.pixelScale) {
      this.pixelScale = ps;
      this.resizeTarget();
    }
  }

  render(camera: THREE.PerspectiveCamera, timeSec: number): void {
    // Nebel an Kamerahöhe koppeln (Fernansicht klar, Nahansicht dunstig)
    camera.updateMatrixWorld();
    this.camPos.setFromMatrixPosition(camera.matrixWorld);
    const h = Math.max(1, this.camPos.y);
    this.fog.near = h * 1.1 + 15;
    this.fog.far = h * 3.6 + 150;
    // Himmel um die Kamera, innerhalb der Far-Plane
    this.sky.position.copy(this.camPos);
    this.sky.scale.setScalar(camera.far * 0.5);
    this.postMat.uniforms.uTime.value = timeSec;

    const r = this.renderer;
    r.info.reset();
    r.setRenderTarget(this.target);
    r.render(this.scene, camera);
    r.setRenderTarget(null);
    r.render(this.postScene, this.postCamera);
  }
}
