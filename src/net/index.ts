/**
 * Mehrspieler-Netzwerkschicht: gemeinsame Typen, die Lobby-Schnittstelle (LobbyClient) und eine Basisklasse,
 * die WsTransport (WebSocket-Server) und BroadcastTransport (zwei Tabs, ohne Server) teilen.
 * Diese Datei importiert KEINE der konkreten Transporte (sonst Zirkelbezug) – Fabrik: MultiplayerSession.createLobbyClient().
 */
import type { NetTransport, PeerInfo, Role, RoomInfo } from './transport';

export type { NetTransport, PeerInfo, Role, RoomInfo } from './transport';
export { NET_COMMANDS, NET_EVENTS, MAX_PLAYERS, NET_PROTOCOL } from './transport';

export type LobbyMode = 'teams' | 'ffa';

export interface RoomOptions {
  scenario?: string;
  seed?: number;
  fillAI?: boolean;
  mode?: LobbyMode;
}

export type ConnStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface LobbyEvents {
  /** Raum hat sich geändert (null = nicht mehr in einem Raum) */
  room: (room: RoomInfo | null) => void;
  chat: (from: string, text: string) => void;
  /** Host hat das Spiel gestartet; Transport-role ist jetzt 'host' oder 'guest' */
  started: (room: RoomInfo, you: string) => void;
  error: (message: string) => void;
  disconnected: (reason: string) => void;
  status: (status: ConnStatus) => void;
}

/** Identische Lobby-API von WsTransport und BroadcastTransport. */
export interface LobbyClient extends NetTransport {
  readonly kind: 'ws' | 'broadcast';
  readonly status: ConnStatus;
  readonly room: RoomInfo | null;
  /** true, wenn dieser Client der Host des aktuellen Raums ist */
  readonly isHost: boolean;
  /** eigene Latenz zum Server/Host in ms (0 = unbekannt) */
  readonly latency: number;
  /** Eigener Peer-Eintrag im Raum */
  readonly self: PeerInfo | null;

  /** Verbindet (WS: URL des Servers; Broadcast: URL wird ignoriert). Löst nach dem Handshake auf. */
  connect(url: string, name: string): Promise<void>;
  disconnect(): void;
  createRoom(opts?: RoomOptions): Promise<RoomInfo>;
  joinRoom(code: string): Promise<RoomInfo>;
  leaveRoom(): void;
  setSlot(a3: string | null): void;
  setReady(ready: boolean): void;
  /** nur Host */
  configure(partial: RoomOptions): void;
  /** nur Host; verlangt: alle Spieler haben eine Nation und sind bereit */
  startGame(): void;
  sendChat(text: string): void;

  on<K extends keyof LobbyEvents>(ev: K, fn: LobbyEvents[K]): () => void;
}

/** Kleiner typisierter Emitter. */
export class Emitter<E extends { [K in keyof E]: (...a: never[]) => void }> {
  private map = new Map<keyof E, Set<(...a: never[]) => void>>();
  on<K extends keyof E>(ev: K, fn: E[K]): () => void {
    let s = this.map.get(ev);
    if (!s) this.map.set(ev, (s = new Set()));
    s.add(fn);
    return () => s!.delete(fn);
  }
  emit<K extends keyof E>(ev: K, ...args: Parameters<E[K]>): void {
    const s = this.map.get(ev);
    if (!s) return;
    for (const fn of [...s]) {
      try {
        (fn as (...a: unknown[]) => void)(...args);
      } catch (e) {
        console.error('[net] Handler-Fehler', ev, e);
      }
    }
  }
}

/** Gemeinsame Zustands- und Listener-Verwaltung beider Transporte. */
export abstract class BaseTransport implements LobbyClient {
  abstract readonly kind: 'ws' | 'broadcast';
  protected _status: ConnStatus = 'idle';
  protected _room: RoomInfo | null = null;
  protected _selfId = '';
  protected _role: Role = 'offline';
  protected _latency = 0;
  protected readonly lobby = new Emitter<LobbyEvents>();

  private snapFns = new Set<(s: unknown) => void>();
  private evtFns = new Set<(n: string, p: unknown) => void>();
  private cmdFns = new Set<(from: PeerInfo, m: string, a: unknown[]) => void>();
  private peerFns = new Set<(p: ReadonlyArray<PeerInfo>) => void>();
  private discFns = new Set<(r: string) => void>();
  private pendingSnap: { v: unknown } | null = null;

  get role(): Role {
    return this._role;
  }
  get selfId(): string {
    return this._selfId;
  }
  get peers(): ReadonlyArray<PeerInfo> {
    return this._room?.peers ?? [];
  }
  get status(): ConnStatus {
    return this._status;
  }
  get room(): RoomInfo | null {
    return this._room;
  }
  get isHost(): boolean {
    return !!this._room && this._room.hostId === this._selfId;
  }
  get latency(): number {
    return this._latency;
  }
  get self(): PeerInfo | null {
    return this.peers.find((p) => p.id === this._selfId) ?? null;
  }

  abstract connect(url: string, name: string): Promise<void>;
  abstract disconnect(): void;
  abstract createRoom(opts?: RoomOptions): Promise<RoomInfo>;
  abstract joinRoom(code: string): Promise<RoomInfo>;
  abstract leaveRoom(): void;
  abstract setSlot(a3: string | null): void;
  abstract setReady(ready: boolean): void;
  abstract configure(partial: RoomOptions): void;
  abstract startGame(): void;
  abstract sendChat(text: string): void;
  abstract broadcastSnapshot(snapshot: unknown): void;
  abstract broadcastEvent(name: string, payload: unknown): void;
  abstract sendCommand(method: string, args: unknown[]): void;

  on<K extends keyof LobbyEvents>(ev: K, fn: LobbyEvents[K]): () => void {
    return this.lobby.on(ev, fn);
  }
  onSnapshot(fn: (s: unknown) => void): () => void {
    this.snapFns.add(fn);
    return () => this.snapFns.delete(fn);
  }
  onEvent(fn: (n: string, p: unknown) => void): () => void {
    this.evtFns.add(fn);
    return () => this.evtFns.delete(fn);
  }
  onCommand(fn: (from: PeerInfo, m: string, a: unknown[]) => void): () => void {
    this.cmdFns.add(fn);
    return () => this.cmdFns.delete(fn);
  }
  onPeersChanged(fn: (p: ReadonlyArray<PeerInfo>) => void): () => void {
    this.peerFns.add(fn);
    return () => this.peerFns.delete(fn);
  }
  onDisconnect(fn: (r: string) => void): () => void {
    this.discFns.add(fn);
    return () => this.discFns.delete(fn);
  }

  // ------------------------------------------------ für Unterklassen
  protected setStatus(s: ConnStatus): void {
    if (this._status === s) return;
    this._status = s;
    this.lobby.emit('status', s);
  }

  protected setRoom(room: RoomInfo | null): void {
    this._room = room;
    this.lobby.emit('room', room);
    const peers = this.peers;
    for (const fn of [...this.peerFns]) safe(() => fn(peers));
  }

  protected handleStarted(room: RoomInfo, you: string): void {
    this._selfId = you || this._selfId;
    this._role = room.hostId === this._selfId ? 'host' : 'guest';
    this._room = room;
    this.lobby.emit('room', room);
    this.lobby.emit('started', room, this._selfId);
  }

  /** Snapshot-Zustellung: neuere ersetzen ältere, solange der Empfänger noch nicht dran war. */
  protected deliverSnapshot(data: unknown): void {
    const first = !this.pendingSnap;
    this.pendingSnap = { v: data };
    if (!first) return;
    setTimeout(() => {
      const p = this.pendingSnap;
      this.pendingSnap = null;
      if (!p) return;
      for (const fn of [...this.snapFns]) safe(() => fn(p.v));
    }, 0);
  }
  protected deliverEvent(name: string, payload: unknown): void {
    for (const fn of [...this.evtFns]) safe(() => fn(name, payload));
  }
  protected deliverCommand(fromId: string, method: string, args: unknown[]): void {
    const from = this.peers.find((p) => p.id === fromId);
    if (!from) return;
    for (const fn of [...this.cmdFns]) safe(() => fn(from, method, args));
  }
  protected emitDisconnect(reason: string): void {
    this.lobby.emit('disconnected', reason);
    for (const fn of [...this.discFns]) safe(() => fn(reason));
  }
  protected resetGameState(): void {
    this._role = 'offline';
    this.pendingSnap = null;
  }
}

function safe(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    console.error('[net] Handler-Fehler', e);
  }
}
