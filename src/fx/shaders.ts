/**
 * Shader für die Effekte (Partikel, Bodendecals, Tracer-Bänder).
 * Alle Shader binden die three.js-Logdepth-Chunks ein (GameRenderer nutzt logarithmicDepthBuffer).
 *
 * Partikel rechnen in "Metern": Weltposition = Ursprung + lokal_m * K, K = 0.001 * uVis^sc
 * (uVis = strategischer Sichtmaßstab wie im UnitRenderer; sc = 1: voll skaliert, <1: schwächer skaliert).
 */

export const PARTICLE_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec4 aPos;   // lokal m (xyz), Größe m (Radius)
attribute vec3 aOrg;   // Weltursprung
attribute vec4 aCol;   // rgb, a
attribute vec4 aMisc;  // additiv(0..1), Rotation, Form*1000+Seed, Skalierungsexponent
uniform float uVis;
uniform float uPx;     // Weltgröße pro Pixel pro Einheit Tiefe
varying vec4 vCol;
varying vec2 vUv;
varying float vAdd;
varying float vRot;
varying float vSeed;
varying float vShape;
void main() {
  float K = 0.001 * pow(uVis, aMisc.w);
  vec3 w = aOrg + aPos.xyz * K;
  vec4 mv = viewMatrix * vec4(w, 1.0);
  float s = aPos.w * K;
  float minS = -mv.z * uPx * 1.6;
  s = aPos.w > 0.0 ? max(s, minS) : 0.0;
  mv.xy += position.xy * s;
  gl_Position = projectionMatrix * mv;
  vCol = aCol;
  vUv = position.xy;
  vAdd = aMisc.x;
  vRot = aMisc.y;
  float sh = floor(aMisc.z / 1000.0 + 0.001);
  vShape = sh;
  vSeed = aMisc.z - sh * 1000.0;
  #include <logdepthbuf_vertex>
}
`;

export const PARTICLE_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec4 vCol;
varying vec2 vUv;
varying float vAdd;
varying float vRot;
varying float vSeed;
varying float vShape;
float h21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  #include <logdepthbuf_fragment>
  float c = cos(vRot), s = sin(vRot);
  vec2 uv = mat2(c, -s, s, c) * vUv;
  float a = 1.0;
  float shade = 1.0;
  if (vShape < 0.5) {
    // klobiger, grob gerasterter Klecks
    const float N = 6.0;
    vec2 cell = floor((uv * 0.5 + 0.5) * N);
    vec2 ctr = ((cell + 0.5) / N) * 2.0 - 1.0;
    float d = length(ctr);
    float n = h21(cell + vSeed);
    a = step(d + (n - 0.5) * 0.55, 0.9);
    shade = 0.78 + 0.34 * n + 0.18 * (ctr.y * 0.6 - ctr.x * 0.3);
    if (a < 0.5) discard;
  } else if (vShape < 1.5) {
    // eckiger Span / Funke
    if (max(abs(uv.x), abs(uv.y)) > 1.0) discard;
  } else {
    // weiches, in Stufen quantisiertes Leuchten
    float d = length(vUv);
    a = floor(clamp(1.0 - d, 0.0, 1.0) * 4.0) / 4.0;
    if (a < 0.1) discard;
  }
  vec3 col = vCol.rgb * shade;
  col = col * col;                       // Gamma 2.0 -> linear (Farben sind in sRGB-Gefühl angegeben)
  float al = vCol.a * a;
  gl_FragColor = vec4(col * al, al * (1.0 - vAdd));
}
`;

export const DECAL_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
#include <fog_pars_vertex>
attribute vec3 aC;   // Weltmitte
attribute vec4 aG;   // Hang gx, gz, Radius m, Typ
attribute vec4 aA;   // Alpha, Geburtszeit, Lebensdauer, Seed
uniform float uVis;
uniform float uTime;
uniform float uLift;
varying vec2 vUv;
varying float vType;
varying float vSeed;
varying float vAlpha;
varying float vAge;
varying float vT;
void main() {
  float K = 0.001 * uVis;
  float age = max(0.0, uTime - aA.y);
  float t = clamp(age / max(aA.z, 0.001), 0.0, 1.0);
  float rad = aG.z * K;
  vec2 off = position.xz * rad;
  vec3 wp = aC + vec3(off.x, 0.0, off.y);
  float slope = clamp(aG.x * off.x + aG.y * off.y, -rad * 1.2, rad * 1.2);
  wp.y += slope + uLift;
  vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  vUv = position.xz;
  vType = aG.w;
  vSeed = aA.w;
  vAlpha = aA.x;
  vAge = age;
  vT = t;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

export const DECAL_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
#include <fog_pars_fragment>
varying vec2 vUv;
varying float vType;
varying float vSeed;
varying float vAlpha;
varying float vAge;
varying float vT;
float h21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  #include <logdepthbuf_fragment>
  float d = length(vUv);
  const float N = 9.0;
  vec2 cell = floor((vUv * 0.5 + 0.5) * N);
  vec2 ctr = ((cell + 0.5) / N) * 2.0 - 1.0;
  float dq = length(ctr);
  float n = h21(cell + vSeed);
  vec3 col = vec3(0.0);
  float a = 0.0;
  if (vType < 0.5) {
    // Krater: dunkle Mulde mit hellerem Auswurfrand
    float e = dq + (n - 0.5) * 0.35;
    if (e > 1.0) discard;
    col = e < 0.55 ? vec3(0.035, 0.03, 0.028) : mix(vec3(0.12, 0.09, 0.065), vec3(0.2, 0.15, 0.1), n);
    a = 0.92;
  } else if (vType < 1.5) {
    // Brandfleck
    float e = dq + (n - 0.5) * 0.7;
    if (e > 1.0) discard;
    col = vec3(0.03, 0.028, 0.026) * (0.6 + 0.8 * n);
    a = 0.6 * (1.0 - smoothstep(0.55, 1.0, e));
  } else if (vType < 2.5) {
    // Druckwellenring
    float rr = 0.2 + 0.8 * sqrt(vT);
    float w = 0.16 - 0.08 * vT;
    float e = abs(d - rr);
    if (e > w || d > 1.0) discard;
    col = vec3(0.78, 0.72, 0.62);
    a = 0.55 * (1.0 - vT) * (1.0 - e / w);
  } else if (vType < 3.5) {
    // Wasserwellen
    float rr = 0.15 + 0.85 * vT;
    float w = 0.09;
    float e = min(abs(d - rr), abs(d - rr * 0.62));
    if (e > w || d > 1.0) discard;
    col = vec3(0.8, 0.88, 0.92);
    a = 0.6 * (1.0 - vT);
  } else {
    // Trümmerfeld
    float e = dq + (n - 0.5) * 0.5;
    if (e > 1.0) discard;
    float m = h21(cell * 1.7 + vSeed + 3.0);
    col = m > 0.7 ? vec3(0.4, 0.33, 0.28) : (m > 0.35 ? vec3(0.2, 0.18, 0.16) : vec3(0.1, 0.09, 0.085));
    a = 0.9;
  }
  float fade = vType < 1.5 || vType > 3.5 ? 1.0 - 0.55 * smoothstep(0.0, 900.0, vAge) : 1.0;
  col = col * col;
  gl_FragColor = vec4(col, a * vAlpha * fade);
  #include <fog_fragment>
}
`;

export const RIBBON_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 aA;
attribute vec3 aB;
attribute vec4 aCol;   // rgb, Breite px
uniform vec2 uRes;
varying vec4 vCol;
varying float vT;
void main() {
  vec4 pa = projectionMatrix * viewMatrix * vec4(aA, 1.0);
  vec4 pb = projectionMatrix * viewMatrix * vec4(aB, 1.0);
  vec4 p = mix(pa, pb, position.x);
  if (pa.w < 0.01 || pb.w < 0.01) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vCol = vec4(0.0); vT = 0.0; return; }
  vec2 d = (pb.xy / pb.w - pa.xy / pa.w) * uRes * 0.5;
  float l = length(d);
  vec2 dir = l > 1e-4 ? d / l : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  // zusätzlich in Längsrichtung um 1 px strecken, damit sehr kurze Spuren sichtbar bleiben
  vec2 offPx = nrm * position.y * aCol.w * 0.5 + dir * (position.x * 2.0 - 1.0) * 0.5;
  gl_Position = p;
  gl_Position.xy += offPx / uRes * 2.0 * p.w;
  vCol = aCol;
  vT = position.x;
  #include <logdepthbuf_vertex>
}
`;

export const RIBBON_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec4 vCol;
varying float vT;
void main() {
  #include <logdepthbuf_fragment>
  float a = vT;                       // Schweif -> Kopf
  vec3 c = mix(vCol.rgb * 0.7, vec3(1.0, 0.97, 0.8), a * a);
  gl_FragColor = vec4(c * (0.25 + a), 0.0);
}
`;
