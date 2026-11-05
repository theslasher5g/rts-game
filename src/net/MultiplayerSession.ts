/**
 * Klebstoff zwischen Lobby und Spielstart: Wenn der Raum startet, werden Nationen, KI-Nationen, Diplomatie, Seed und Rolle
 * aufgelöst und 'game:start' (mit optionalem `mp`) auf dem Bus ausgelöst. Der Lead verdrahtet das in main.ts.
 */
import { bus } from '../core/EventBus';
import { SCENARIO_NATIONS, mpDiplomacy, type MpMode } from '../game/scenario';
import type { LobbyClient } from './index';
import type { NetTransport, RoomInfo } from './transport';
import { BroadcastTransport } from './BroadcastTransport';
import { WsTransport } from './WsTransport';

export type MpTransport = LobbyClient & NetTransport;

export interface MpPlayer {
  id: string;
  name: string;
  a3: string;
}

export interface MpStartInfo {
  mode: MpMode;
  role: 'host' | 'guest';
  selfId: string;
  /** Nation dieses Spielers */
  selfA3: string;
  seed: number;
  scenario: string;
  fillAI: boolean;
  players: MpPlayer[];
  /** Nationen, die der HOST per KI steuert (nur bei fillAI) */
  aiNations: string[];
  /** Nationen ohne Spieler und ohne KI (fillAI aus) */
  idleNations: string[];
  wars: Array<[string, string]>;
  alliances: Array<[string, string]>;
  playerNations: string[];
}

export interface StartDescription {
  aiNations: string[];
  wars: Array<[string, string]>;
  alliances: Array<[string, string]>;
  playerNations: string[];
}

export type LobbyKind = 'ws' | 'broadcast';

export function createLobbyClient(kind: LobbyKind): MpTransport {
  return kind === 'ws' ? new WsTransport() : new BroadcastTransport();
}

/** Alle spielbaren Nationen des Szenarios (a3), höchstens 4. */
export function mpNations(): string[] {
  return SCENARIO_NATIONS.filter((n) => n.playable).map((n) => n.a3);
}

/** Reine Funktion: Startbeschreibung aus einem gestarteten Raum. */
export function describeRoom(room: RoomInfo): StartDescription {
  const mode: MpMode = room.mode === 'ffa' ? 'ffa' : 'teams';
  const playerNations = room.peers.map((p) => p.a3).filter((a): a is string => !!a);
  const aiNations = room.fillAI ? mpNations().filter((a) => !playerNations.includes(a)) : [];
  const { wars, alliances } = mpDiplomacy(mode);
  return { aiNations, wars, alliances, playerNations };
}

export class MultiplayerSession {
  readonly transport: MpTransport;
  private startFns: Array<(info: MpStartInfo) => void> = [];
  private info: MpStartInfo | null = null;
  private offStart: () => void;
  /** true (Standard): beim Start zusätzlich bus.emit('game:start', …) */
  emitGameStart = true;

  constructor(opts: { transport: MpTransport }) {
    this.transport = opts.transport;
    this.offStart = this.transport.on('started', (room, you) => this.handleStart(room, you));
    if (this.transport.room?.started) this.handleStart(this.transport.room, this.transport.selfId);
  }

  get mode(): MpMode {
    return this.transport.room?.mode === 'ffa' ? 'ffa' : 'teams';
  }
  /** Spieler mit gewählter Nation (Reihenfolge wie im Raum) */
  get players(): MpPlayer[] {
    return (this.transport.room?.peers ?? []).filter((p) => !!p.a3).map((p) => ({ id: p.id, name: p.name, a3: p.a3! }));
  }
  get started(): boolean {
    return this.info !== null;
  }
  get startInfo(): MpStartInfo | null {
    return this.info;
  }
  get role(): 'host' | 'guest' | 'offline' {
    return this.transport.role;
  }

  /** Callback bei Spielstart; ist das Spiel schon gestartet, wird sofort aufgerufen. */
  onStart(fn: (info: MpStartInfo) => void): () => void {
    this.startFns.push(fn);
    if (this.info) fn(this.info);
    return () => {
      this.startFns = this.startFns.filter((f) => f !== fn);
    };
  }

  /** { aiNations, wars, alliances, playerNations } des aktuellen Raums (vor und nach dem Start verwendbar) */
  describeStart(): StartDescription {
    const room = this.transport.room;
    if (!room) return { aiNations: [], wars: [], alliances: [], playerNations: [] };
    return describeRoom(room);
  }

  dispose(): void {
    this.offStart();
    this.startFns = [];
  }

  private handleStart(room: RoomInfo, you: string): void {
    const me = room.peers.find((p) => p.id === you);
    if (!me || !me.a3) return;
    const d = describeRoom(room);
    const info: MpStartInfo = {
      mode: room.mode === 'ffa' ? 'ffa' : 'teams',
      role: room.hostId === you ? 'host' : 'guest',
      selfId: you,
      selfA3: me.a3,
      seed: room.seed,
      scenario: room.scenario,
      fillAI: room.fillAI,
      players: room.peers.filter((p) => !!p.a3).map((p) => ({ id: p.id, name: p.name, a3: p.a3! })),
      aiNations: d.aiNations,
      idleNations: room.fillAI ? [] : mpNations().filter((a) => !d.playerNations.includes(a)),
      wars: d.wars,
      alliances: d.alliances,
      playerNations: d.playerNations,
    };
    this.info = info;
    for (const fn of [...this.startFns]) {
      try {
        fn(info);
      } catch (e) {
        console.error('[mp] onStart-Fehler', e);
      }
    }
    if (this.emitGameStart) {
      bus.emit('game:start', {
        countryA3: info.selfA3,
        mp: { mode: info.mode, players: info.players, selfId: info.selfId, role: info.role, seed: info.seed },
      });
    }
  }
}
