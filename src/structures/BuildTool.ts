/**
 * Geometrie-Helfer fürs Bauen (rein funktional, ohne Szene): Polylinien abtasten, Abstände, Gelände-Snapping.
 * Polylinien sind flache Arrays [x0,z0,x1,z1,...] in Welt-km.
 */
import type { GeoData } from '../world/GeoData';

/** Gesamtlänge einer Polylinie (km) */
export function polylineLength(points: number[]): number {
  let l = 0;
  for (let i = 2; i < points.length; i += 2) l += Math.hypot(points[i] - points[i - 2], points[i + 1] - points[i - 1]);
  return l;
}

/** Punkte im festen Abstand stepKm entlang der Polylinie (inkl. Start und Ende). Einzelpunkt -> unverändert. */
export function sampleLine(points: number[], stepKm: number): number[] {
  if (points.length < 4) return points.slice();
  const out: number[] = [points[0], points[1]];
  const step = Math.max(1e-6, stepKm);
  let carry = 0; // km seit letztem Sample
  for (let i = 2; i < points.length; i += 2) {
    const ax = points[i - 2], az = points[i - 1], bx = points[i], bz = points[i + 1];
    const L = Math.hypot(bx - ax, bz - az);
    if (L <= 0) continue;
    let d = step - carry;
    while (d <= L + 1e-9) {
      out.push(ax + ((bx - ax) * d) / L, az + ((bz - az) * d) / L);
      d += step;
    }
    carry = L - (d - step);
  }
  const lx = points[points.length - 2], lz = points[points.length - 1];
  if (Math.hypot(out[out.length - 2] - lx, out[out.length - 1] - lz) > step * 0.35) out.push(lx, lz);
  else { out[out.length - 2] = lx; out[out.length - 1] = lz; }
  return out;
}

/** Punkt + Richtung (normiert) bei Strecke distKm entlang der Polylinie (geklemmt). */
export function pointAlong(points: number[], distKm: number, out: { x: number; z: number; dx: number; dz: number } = { x: 0, z: 0, dx: 0, dz: -1 }): { x: number; z: number; dx: number; dz: number } {
  if (points.length < 4) {
    out.x = points[0] ?? 0; out.z = points[1] ?? 0; out.dx = 0; out.dz = -1;
    return out;
  }
  let rem = Math.max(0, distKm);
  for (let i = 2; i < points.length; i += 2) {
    const ax = points[i - 2], az = points[i - 1], bx = points[i], bz = points[i + 1];
    const L = Math.hypot(bx - ax, bz - az);
    if (L <= 0) continue;
    if (rem <= L || i + 2 >= points.length) {
      const f = Math.min(1, rem / L);
      out.x = ax + (bx - ax) * f; out.z = az + (bz - az) * f;
      out.dx = (bx - ax) / L; out.dz = (bz - az) / L;
      return out;
    }
    rem -= L;
  }
  return out;
}

/** Kürzester Abstand (km) Punkt -> Polylinie (Einzelpunkt: Punktabstand). */
export function distToPolyline(x: number, z: number, points: number[]): number {
  if (points.length < 4) return Math.hypot(x - (points[0] ?? 0), z - (points[1] ?? 0));
  let best = Infinity;
  for (let i = 2; i < points.length; i += 2) {
    const ax = points[i - 2], az = points[i - 1], dx = points[i] - ax, dz = points[i + 1] - az;
    const L2 = dx * dx + dz * dz;
    let t = L2 > 0 ? ((x - ax) * dx + (z - az) * dz) / L2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(x - (ax + dx * t), z - (az + dz * t));
    if (d < best) best = d;
  }
  return best;
}

/** Zieh-Eingabe ausdünnen: Punkte näher als minStepKm zum letzten behaltenen werden verworfen. */
export function simplifyLine(points: number[], minStepKm: number): number[] {
  if (points.length < 4) return points.slice();
  const out = [points[0], points[1]];
  for (let i = 2; i < points.length - 2; i += 2) {
    if (Math.hypot(points[i] - out[out.length - 2], points[i + 1] - out[out.length - 1]) >= minStepKm) out.push(points[i], points[i + 1]);
  }
  out.push(points[points.length - 2], points[points.length - 1]);
  return out;
}

/** Normierte Linksnormale (x,z) der Polylinie am Anfang bzw. im Mittel; (1,0)-Fallback. */
export function lineNormal(points: number[]): [number, number] {
  if (points.length < 4) return [0, -1];
  const dx = points[points.length - 2] - points[0], dz = points[points.length - 1] - points[1];
  const l = Math.hypot(dx, dz);
  return l > 0 ? [-dz / l, dx / l] : [0, -1];
}

/** Blickrichtung (Heading 0 = Norden, im Uhrzeigersinn) -> Einheitsvektor (x,z) */
export function headingToDir(heading: number): [number, number] {
  return [Math.sin(heading), -Math.cos(heading)];
}

/** Gelände-Snapping: Höhe in km (Meer >= 0 geklemmt), ob Land und ob Wasser (Fluss/See). */
export function snapToTerrain(geo: GeoData, x: number, z: number): { x: number; z: number; heightKm: number; land: boolean } {
  const i = Math.floor(x / geo.cellKm), j = Math.floor(z / geo.cellKm);
  const inside = i >= 0 && j >= 0 && i < geo.width && j < geo.height;
  const water = !inside || geo.waterFlags[j * geo.width + i] !== 0;
  const h = geo.heightAt(x, z);
  return { x, z, heightKm: Math.max(0, h), land: inside && !water && h > 0 && geo.countryAt(x, z) !== 0 };
}

/** Baubar: Land, kein Wasser. */
export function isBuildable(geo: GeoData, x: number, z: number): boolean {
  return snapToTerrain(geo, x, z).land;
}
