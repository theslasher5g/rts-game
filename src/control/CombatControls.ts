import type { BuildingInfo, StructureKind } from '../combat/types';
import type { Unit } from '../units/types';
import type { ProtectionQuery } from '../civil/types';

/**
 * Phase 3 – Befehle rund um Kampf, Bauen, Gebäude und Brücken.
 * Die Ports sind schmale Schnittstellen zu CombatSystem / StructureManager / Cities / NavGraph / War,
 * damit SelectionController nicht von deren Implementierungen abhängt.
 */

export interface CombatPort {
  orderAttack(unitIds: number[], targetId: number): void;
  orderFireAt(unitIds: number[], x: number, z: number): void;
  stopFiring(unitIds: number[]): void;
}
export interface StructuresPort {
  orderBuild(engineerIds: number[], kind: StructureKind, points: number[], owner: string): number;
  orderGarrison(unitIds: number[], buildingId: number): void;
  ungarrison(unitIds: number[]): void;
  orderDemolish(engineerIds: number[], edgeId: number): void;
  orderRepair(engineerIds: number[], edgeId: number): void;
  bridgeEdgeNear(x: number, z: number, maxKm: number): number;
}
export interface CitiesPort {
  findBuildingAt(x: number, z: number, maxKm: number): BuildingInfo | null;
}
export interface WarPort {
  isHostile(a: string, b: string): boolean;
  declare(a: string, b: string): void;
}

export interface ControlServices {
  /** Phase 4: Zielklassifikation (eigene Zivilgebiete gesperrt, feindliche mit Warnung) */
  protection?: ProtectionQuery;
  combat?: CombatPort;
  structures?: StructuresPort;
  cities?: CitiesPort;
  war?: WarPort;
}

export interface BuildChoice {
  kind: StructureKind;
  label: string;
  tip: string;
  /** true = Linie (Start- und Endpunkt), false = einzelner Punkt */
  linear: boolean;
}

export const BUILD_CHOICES: BuildChoice[] = [
  { kind: 'trench', label: 'Graben', tip: 'Schützengraben ausheben (Start- und Endpunkt)', linear: true },
  { kind: 'foxhole', label: 'Schützenloch', tip: 'Einzelnes Schützenloch', linear: false },
  { kind: 'sandbags', label: 'Sandsäcke', tip: 'Sandsackwall (Start- und Endpunkt)', linear: true },
  { kind: 'tank_trap', label: 'Panzersperre', tip: 'Panzersperren-Reihe (Start- und Endpunkt)', linear: true },
  { kind: 'barbed_wire', label: 'Stacheldraht', tip: 'Stacheldrahtverhau (Start- und Endpunkt)', linear: true },
  { kind: 'mg_nest', label: 'MG-Nest', tip: 'MG-Nest aus Sandsäcken', linear: false },
  { kind: 'mortar_pit', label: 'Mörserstellung', tip: 'Mörserstellung', linear: false },
  { kind: 'at_position', label: 'PAK-Stellung', tip: 'Panzerabwehr-Stellung', linear: false },
  { kind: 'bunker', label: 'Bunker', tip: 'Betonbunker (Garnison 6)', linear: false },
  { kind: 'minefield', label: 'Minenfeld', tip: 'Minenfeld (Start- und Endpunkt)', linear: true },
  { kind: 'roadblock', label: 'Straßensperre', tip: 'Straßensperre: sperrt die nächste Straße', linear: false },
];

export type CombatMode = 'fireAt' | 'garrison' | 'demolish' | 'repair' | 'build';
export const COMBAT_MODES: readonly string[] = ['fireAt', 'garrison', 'demolish', 'repair', 'build'];

/** Minimaler Blick auf den SelectionController (vermeidet Zirkelimport) */
export interface ControllerPort {
  playerA3: string | null;
  commandIds(): number[];
  getUnit(id: number): Unit | undefined;
  toast(msg: string, kind?: 'info' | 'warn' | 'bad', ms?: number): void;
  /** Zoom-abhängiger Suchradius in km für Klicks auf Brücken/Gebäude */
  pickRadiusKm(): number;
}

export class CombatControls {
  services: ControlServices = {};
  buildKind: StructureKind = 'trench';
  /** Bereits gesetzte Punkte der aktuellen Bau-Linie [x,z,...] */
  private pending: number[] = [];
  /** Bestätigung für Angriffe auf feindliche Zivilgebiete: zweiter Klick auf (nahezu) denselben Punkt */
  private confirm: { x: number; z: number; t: number } | null = null;

  /**
   * Prüft ein Feuerziel gegen den Schutzstatus. true = Befehl darf erteilt werden.
   * Eigene/verbündete Zivilgebiete: gesperrt. Feindliche Zivilgebiete und geschützte Infrastruktur: Warnung,
   * Bestätigung durch erneuten Klick (Kriegsverbrechen, Ansehensverlust).
   */
  private checkTarget(x: number, z: number): boolean {
    const prot = this.services.protection;
    const me = this.c.playerA3;
    if (!prot || !me) return true;
    const cl = prot.classify(x, z, me, 0.4);
    if (cl.cls === 'free') {
      this.confirm = null;
      return true;
    }
    if (cl.cls === 'own_civil') {
      this.c.toast(`Gesperrt: ${cl.reason}`, 'bad', 3500);
      this.confirm = null;
      return false;
    }
    const now = performance.now();
    const c = this.confirm;
    if (c && now - c.t < 5000 && Math.hypot(c.x - x, c.z - z) < 1.5) {
      this.confirm = null;
      return true;
    }
    this.confirm = { x, z, t: now };
    const pop = cl.populationAtRisk > 0 ? ` (≈ ${Math.round(cl.populationAtRisk).toLocaleString('de-DE')} Zivilisten im Wirkungsbereich)` : '';
    this.c.toast(`WARNUNG: ${cl.reason}${pop}. Gezielter Angriff = Kriegsverbrechen. Zum Bestätigen erneut klicken.`, 'warn', 5000);
    return false;
  }

  constructor(private readonly c: ControllerPort) {}

  isHostileOwner(owner: string): boolean {
    const p = this.c.playerA3;
    return !!p && !!this.services.war?.isHostile(p, owner);
  }

  attack(ids: number[], target: Unit): void {
    if (!this.services.combat) return this.c.toast('Kampfsystem nicht verfügbar', 'warn');
    this.services.combat.orderAttack(ids, target.id);
  }

  stopFiring(ids: number[]): void {
    this.services.combat?.stopFiring(ids);
  }

  private filterIds(ids: number[], pred: (u: Unit) => boolean): number[] {
    const out: number[] = [];
    for (const id of ids) {
      const u = this.c.getUnit(id);
      if (u && pred(u)) out.push(id);
    }
    return out;
  }

  private engineers(): number[] {
    return this.filterIds(this.c.commandIds(), (u) => u.type.id === 'engineer_squad');
  }

  resetBuild(): void {
    this.confirm = null;
    this.pending = [];
  }

  get pendingPoints(): number {
    return this.pending.length / 2;
  }

  /** Hinweis-Text für den aktuellen Modus (Anzeige oben) */
  hint(mode: CombatMode): string {
    switch (mode) {
      case 'fireAt':
        return 'Feuerbefehl: Zielpunkt wählen – Artillerie/Mörser/Raketen feuern auf das Gebiet';
      case 'garrison':
        return 'Gebäude besetzen: Gebäude anklicken (nur Infanterie)';
      case 'demolish':
        return 'Brücke sprengen: Brücke anklicken (Pioniere nötig)';
      case 'repair':
        return 'Brücke reparieren: zerstörte Brücke anklicken (Pioniere nötig)';
      case 'build': {
        const b = BUILD_CHOICES.find((x) => x.kind === this.buildKind);
        if (!b) return 'Bauen';
        if (b.linear) return this.pending.length ? `${b.label}: Endpunkt wählen (Shift: weiter)` : `${b.label}: Startpunkt wählen`;
        return `${b.label}: Standort wählen (Shift: weitere)`;
      }
    }
  }

  /** Linksklick im Modus. Rückgabe true = Modus beenden. */
  handleModeClick(mode: CombatMode, x: number, z: number, shift: boolean): boolean {
    const s = this.services;
    const ids = this.c.commandIds();
    const player = this.c.playerA3;
    if (!player) return true;

    if (mode === 'fireAt') {
      if (!s.combat) {
        this.c.toast('Kampfsystem nicht verfügbar', 'warn');
        return true;
      }
      const shooters = this.filterIds(ids, (u) => u.type.category === 'artillery' || u.type.category === 'naval' || u.type.category === 'aa' || u.type.category === 'tank' || u.type.category === 'ifv');
      if (!shooters.length) {
        this.c.toast('Keine feuerfähigen Einheiten ausgewählt', 'warn');
        return true;
      }
      if (!this.checkTarget(x, z)) return false;
      s.combat.orderFireAt(shooters, x, z);
      return !shift;
    }

    if (mode === 'garrison') {
      const b = s.cities?.findBuildingAt(x, z, this.c.pickRadiusKm());
      if (!b || !s.structures) {
        this.c.toast('Kein Gebäude getroffen', 'warn');
        return false;
      }
      const inf = this.filterIds(ids, (u) => u.type.category === 'infantry');
      if (!inf.length) {
        this.c.toast('Nur Infanterie kann Gebäude besetzen', 'warn');
        return true;
      }
      s.structures.orderGarrison(inf, b.id);
      return !shift;
    }

    if (mode === 'demolish' || mode === 'repair') {
      const eng = this.engineers();
      if (!eng.length) {
        this.c.toast('Pioniere auswählen (Pionier-Trupp)', 'warn');
        return true;
      }
      const edge = s.structures?.bridgeEdgeNear(x, z, this.c.pickRadiusKm()) ?? -1;
      if (edge < 0 || !s.structures) {
        this.c.toast('Keine Brücke getroffen', 'warn');
        return false;
      }
      if (mode === 'demolish') s.structures.orderDemolish(eng, edge);
      else s.structures.orderRepair(eng, edge);
      return !shift;
    }

    // build
    const eng = this.engineers();
    if (!eng.length) {
      this.c.toast('Pioniere auswählen (Pionier-Trupp)', 'warn');
      return true;
    }
    if (!s.structures) return true;
    const choice = BUILD_CHOICES.find((b) => b.kind === this.buildKind);
    if (!choice) return true;
    if (!choice.linear) {
      s.structures.orderBuild(eng, choice.kind, [x, z], player);
      return !shift;
    }
    this.pending.push(x, z);
    if (this.pending.length < 4) return false; // Startpunkt gesetzt
    const pts = this.pending.slice();
    s.structures.orderBuild(eng, choice.kind, pts, player);
    if (shift) {
      // Polylinie weiterführen: letzter Punkt ist neuer Start
      this.pending = [x, z];
      return false;
    }
    this.pending = [];
    return true;
  }

  ungarrison(): void {
    const inf = this.filterIds(this.c.commandIds(), () => true);
    this.services.structures?.ungarrison(inf);
  }
}
