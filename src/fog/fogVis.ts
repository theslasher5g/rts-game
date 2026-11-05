/**
 * Kleiner gemeinsamer Nebel-Helfer für Renderer von Standorten/Bauwerken (OilEconomy, ProductionSystem, StructureManager):
 * Feindliche (nicht verbündete) Objekte werden nur gezeichnet, wenn ihr Standort aktuell sichtbar oder schon erkundet ist
 * (erkundete Standorte bleiben als "zuletzt gesehen" stehen, da sie sich nicht bewegen). Ohne Nebel: alles sichtbar.
 */
export interface FogProviderLike {
  readonly active: boolean;
  isFriendly(a3: string): boolean;
  isVisible(x: number, z: number, forA3?: string): boolean;
  isExplored(x: number, z: number): boolean;
}

let provider: FogProviderLike | null = null;

export function setFogProvider(f: FogProviderLike | null): void {
  provider = f;
}

/** true, wenn ein Standort/Bauwerk von `owner` bei (x,z) dem Spieler gezeigt werden darf */
export function isSiteVisible(owner: string, x: number, z: number): boolean {
  const f = provider;
  if (!f || !f.active) return true;
  if (f.isFriendly(owner)) return true;
  return f.isVisible(x, z) || f.isExplored(x, z);
}
