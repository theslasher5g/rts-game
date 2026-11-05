/**
 * Mehrspieler – Spielleiter: verdrahtet je nach Rolle Host (volle Simulation + Schnappschuss-Sender + Befehlsprüfung)
 * oder Gast (Spiegel + Befehls-Stellvertreter + Schnappschuss-Empfänger).
 *
 * WAS main.ts AUF GÄSTEN NICHT AUFRUFEN DARF (Simulation; läuft nur beim Host, `net.simulates`):
 *   tactics.update, structures-/economy-/supply-/production-Simulation (diese update()s sind im Spiegelmodus ungefährlich und dürfen
 *   weiter laufen: sie zeichnen nur), econAI.update, ais[].update, missions.update (Host: MP-Sieg prüft NetGame selbst),
 *   protection.update, reputation.update, occupation.update, state.zufriedenheit-Fortschreibung.
 * WAS auf Gästen WEITER aufgerufen werden muss: state.update (Datum läuft zwischen Schnappschüssen weiter), net.frame (vor units.update),
 *   units.update, combat.update (no-op), structures.update (no-op), economy/supply/production.update (zeichnen), civil.update (Ambient),
 *   fog.update, Renderer, UI.
 */
import { bus } from '../core/EventBus';
import type { GameContext } from '../game/context';
import type { Reputation } from '../game/Reputation';
import {
  installGuestProxies, installHostCommandHandler, installHostLocalScope,
  type CommandTargets, type GuestProxyHandle, type HostCommandHandle, type HostCommandOptions,
} from './commands';
import { GuestSync } from './GuestSync';
import { HostSync } from './HostSync';
import type { NetTransport } from './transport';

export interface NetGameOptions {
  role: 'host' | 'guest';
  /** Nation dieses Spielers */
  selfA3: string;
  /** Host: Nation des Peers (null = kein Spieler). Der Host selbst darf `selfA3` liefern. */
  nationOfPeer: (peerId: string) => string | null;
  /** Nationen unter KI-Kontrolle (Befehle von Gästen für diese Nationen werden verworfen) */
  aiNations: string[];
  seed: number;
  /** Diplomatiemodus ('teams'|'ffa'), wird mit dem Voll-Schnappschuss an Gäste gesendet */
  mode?: 'teams' | 'ffa';
  /** Ansehen (Reputation-Objekt) für Schnappschuss/Spiegel */
  reputation?: Reputation | null;
  /** Fähigkeiten-System (optional, Objekt mit use(...)) */
  abilities?: CommandTargets['abilities'];
  /** Schnappschuss-Intervall ms (Host, Standard 100) */
  snapshotIntervalMs?: number;
  /** Host: Skirmish-Sieg (letztes Team) selbst prüfen und 'mission:ended' mit `winners` senden (Standard true) */
  checkVictory?: boolean;
  /** Host: Optionen der Befehlsprüfung */
  command?: HostCommandOptions;
  /** Zeitquelle (Tests) */
  now?: () => number;
}

export class NetGame {
  readonly role: 'host' | 'guest';
  readonly selfA3: string;
  readonly seed: number;
  readonly hostSync: HostSync | null = null;
  readonly guestSync: GuestSync | null = null;
  readonly commands: HostCommandHandle | null = null;
  /** true = nach dem Ende eines MP-Spiels */
  gameOver = false;
  winners: string[] = [];

  private readonly ctx: GameContext;
  private readonly opts: NetGameOptions;
  private readonly proxies: GuestProxyHandle | null = null;
  private readonly restore: Array<() => void> = [];
  private victoryClock = 0;

  constructor(ctx: GameContext, transport: NetTransport, opts: NetGameOptions) {
    this.ctx = ctx;
    this.opts = opts;
    this.role = opts.role;
    this.selfA3 = opts.selfA3;
    this.seed = opts.seed;
    const targets: CommandTargets = { abilities: opts.abilities ?? null };
    const ai = new Set(opts.aiNations);

    if (opts.role === 'guest') {
      ctx.units.mirror = true;
      ctx.combat.mirror = true;
      ctx.economy.mirror = true;
      ctx.production.mirror = true;
      ctx.supply.mirror = true;
      ctx.structures.mirror = true;
      ctx.civil.mirror = true;
      ctx.state.timeLocked = true;
      this.proxies = installGuestProxies(ctx, transport, opts.selfA3, targets);
      this.guestSync = new GuestSync(ctx, transport, { selfA3: opts.selfA3, reputation: opts.reputation ?? null, now: opts.now });
      this.restore.push(() => {
        ctx.units.mirror = false; ctx.combat.mirror = false; ctx.economy.mirror = false; ctx.production.mirror = false;
        ctx.supply.mirror = false; ctx.structures.mirror = false; ctx.civil.mirror = false; ctx.state.timeLocked = false;
        this.proxies?.restore();
        this.guestSync?.dispose();
      });
    } else {
      this.restore.push(installHostLocalScope(ctx, targets));
      this.commands = installHostCommandHandler(
        ctx, transport,
        (peerId) => {
          const n = opts.nationOfPeer(peerId);
          return n && !ai.has(n) ? n : null;
        },
        targets, opts.command,
      );
      this.hostSync = new HostSync(ctx, transport, { mode: opts.mode, intervalMs: opts.snapshotIntervalMs, reputation: opts.reputation ?? null, now: opts.now });
      this.restore.push(() => { this.commands?.dispose(); this.hostSync?.dispose(); });
    }
    this.restore.push(transport.onPeersChanged(() => { /* Peerliste liest der Transport selbst */ }));
    bus.emit('net:state', { role: opts.role, connected: true });
  }

  // ------------------------------------------------------------------ Abfragen

  /** true = diese Instanz simuliert (Host). Gäste rufen KI/Kampf/Wirtschaftssimulation nicht auf. */
  get simulates(): boolean {
    return this.role === 'host';
  }
  get isHost(): boolean {
    return this.role === 'host';
  }
  get isGuest(): boolean {
    return this.role === 'guest';
  }
  /** Nur der Host steuert Pause/Zeitraffer (Hud: Tasten für Gäste ausblenden) */
  get canControlTime(): boolean {
    return this.role === 'host';
  }
  get connected(): boolean {
    return this.guestSync ? !this.guestSync.disconnected : true;
  }
  /** RTT zum Host (ms, 0 = unbekannt); beim Host 0 */
  get rttMs(): number {
    return this.guestSync?.rttMs ?? 0;
  }
  /** ms seit dem letzten Schnappschuss (Gast); beim Host 0 */
  get snapshotAgeMs(): number {
    return this.guestSync?.snapshotAgeMs ?? 0;
  }
  get stalled(): boolean {
    return this.guestSync?.stalled ?? false;
  }
  /** Gast: erster vollständiger Schnappschuss ist eingetroffen */
  get synced(): boolean {
    return this.guestSync ? this.guestSync.synced : true;
  }

  // ------------------------------------------------------------------ Frame

  /**
   * Einmal je Frame, direkt nach state.update(dt) und VOR units.update() aufrufen.
   * Host: Schnappschuss-Takt + Siegprüfung. Gast: Einheiten-Interpolation.
   */
  frame(dtReal: number, _dtGameHours = 0): void {
    void _dtGameHours;
    if (this.guestSync) {
      this.guestSync.frame(dtReal);
      return;
    }
    this.hostSync?.tick();
    this.victoryClock += dtReal;
    if (this.victoryClock >= 1) {
      this.victoryClock = 0;
      if (this.opts.checkVictory !== false && !this.gameOver) this.checkVictory();
    }
  }

  // ------------------------------------------------------------------ Sieg (Host)

  /**
   * Skirmish: Eine Nation ist ausgeschieden, wenn sie weder HQ noch Raffinerie besitzt. Sobald alle verbleibenden Nationen
   * untereinander nicht im Krieg stehen (letztes Team), endet das Spiel: 'mission:ended' mit winners (der Host-Spieler sieht
   * victory/defeat nach eigener Nation, Gäste rechnen es aus winners selbst aus).
   */
  private checkVictory(): void {
    const { economy, war, state } = this.ctx;
    if (war.ceasefire) return;
    const alive: string[] = [];
    for (const a3 of economy.nations) {
      let has = false;
      for (const b of economy.bases.values()) if (b.owner === a3 && (b.kind === 'hq' || b.kind === 'refinery')) { has = true; break; }
      if (has) alive.push(a3);
    }
    if (alive.length === 0) return;
    // noch Krieg unter den Überlebenden?
    for (let i = 0; i < alive.length; i++) for (let j = i + 1; j < alive.length; j++) if (war.isHostile(alive[i], alive[j])) return;
    this.finish(alive, alive.length === 1 ? `${alive[0]} hat gesiegt` : `${alive.join(' + ')} haben gesiegt`);
    void state;
  }

  /** Spiel beenden (Host): Sieger festlegen, Zeit anhalten, 'mission:ended' auslösen */
  finish(winners: string[], reason: string): void {
    if (this.gameOver || this.role !== 'host') return;
    this.gameOver = true;
    this.winners = winners.slice();
    this.ctx.state.speed = 0;
    bus.emit('mission:ended', {
      missionId: 'mp-skirmish',
      result: winners.includes(this.selfA3) ? 'victory' : 'defeat',
      reason,
      winners,
    } as never);
  }

  dispose(): void {
    for (const f of this.restore.splice(0).reverse()) f();
    bus.emit('net:state', { role: 'offline', connected: false });
  }
}
