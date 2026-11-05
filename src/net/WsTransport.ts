/**
 * NetTransport + Lobby-API über WebSocket (Server: server/index.mjs).
 * Gäste halten nur den neuesten Snapshot (BaseTransport.deliverSnapshot). Die Lobby verbindet sich bei Abbruch automatisch
 * neu (nicht mitten im Spiel – dort wird onDisconnect gemeldet).
 */
import { BaseTransport, type RoomOptions } from './index';
import { NET_PROTOCOL, type ClientToServer, type RoomInfo, type ServerToClient } from './transport';

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 8000];

interface Pending {
  resolve: (r: RoomInfo) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class WsTransport extends BaseTransport {
  readonly kind = 'ws' as const;
  private ws: WebSocket | null = null;
  private url = '';
  private name = 'Spieler';
  private pending: Pending | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTries = 0;
  private manualClose = false;
  private leaving = false;

  /** Standardadresse: gleicher Ursprung /ws (Vite-Proxy oder `npm run server` mit dist/) */
  static defaultUrl(): string {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }
  /** Alternative: direkt der Relay-Port auf dem gleichen Rechner */
  static directUrl(): string {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.hostname}:8787`;
  }

  static normalizeUrl(input: string): string {
    let u = input.trim();
    if (!u) return WsTransport.defaultUrl();
    if (u.startsWith('/')) return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${u}`;
    u = u.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://');
    if (!/^wss?:\/\//i.test(u)) u = (location.protocol === 'https:' ? 'wss://' : 'ws://') + u;
    return u;
  }

  connect(url: string, name: string): Promise<void> {
    this.disconnect();
    this.manualClose = false;
    this.url = WsTransport.normalizeUrl(url);
    this.name = name.trim().slice(0, 20) || 'Spieler';
    this.reconnectTries = 0;
    return this.open(false);
  }

  private open(isReconnect: boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.setStatus(isReconnect ? 'reconnecting' : 'connecting');
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.url);
      } catch (e) {
        this.setStatus('closed');
        reject(new Error('Ungültige Serveradresse.'));
        return;
      }
      this.ws = ws;
      let welcomed = false;
      const timeout = setTimeout(() => {
        if (!welcomed) {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          reject(new Error('Zeitüberschreitung beim Verbinden.'));
        }
      }, 8000);

      ws.onopen = () => this.sendRaw({ t: 'hello', name: this.name, protocol: NET_PROTOCOL });
      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return;
        let m: ServerToClient;
        try {
          m = JSON.parse(ev.data) as ServerToClient;
        } catch {
          return;
        }
        if (m.t === 'welcome') {
          welcomed = true;
          clearTimeout(timeout);
          this._selfId = m.id;
          this.reconnectTries = 0;
          this.setStatus('open');
          this.startPing();
          resolve();
          return;
        }
        this.onServerMessage(m);
      };
      ws.onerror = () => {
        /* onclose folgt */
      };
      ws.onclose = (ev) => {
        clearTimeout(timeout);
        if (this.ws === ws) this.ws = null;
        this.stopPing();
        if (!welcomed) {
          this.setStatus('closed');
          reject(new Error(isReconnect ? 'Neuverbindung fehlgeschlagen.' : 'Server nicht erreichbar.'));
          if (isReconnect) this.scheduleReconnect();
          return;
        }
        this.onClosed(ev.reason || (ev.code === 1013 ? 'Server voll' : 'Verbindung getrennt'));
      };
    });
  }

  private onClosed(reason: string): void {
    const inGame = this._role !== 'offline';
    const hadRoom = !!this._room;
    this.rejectPending(new Error(reason));
    if (this.manualClose) {
      this.setStatus('closed');
      return;
    }
    if (hadRoom) this.setRoom(null);
    this._selfId = '';
    if (inGame) {
      this.resetGameState();
      // Mitten im Spiel: keine automatische Neuverbindung
      this.setStatus('closed');
      this.emitDisconnect(reason);
      return;
    }
    this.emitDisconnect(reason);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.manualClose || this.reconnectTimer) return;
    if (this.reconnectTries >= RECONNECT_DELAYS.length) {
      this.setStatus('closed');
      return;
    }
    const delay = RECONNECT_DELAYS[this.reconnectTries++];
    this.setStatus('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open(true).then(
        () => this.lobby.emit('error', 'Verbindung wiederhergestellt – bitte Raum erneut erstellen oder beitreten.'),
        () => {
          /* scheduleReconnect wurde im onclose aufgerufen */
        },
      );
    }, delay);
  }

  disconnect(): void {
    this.manualClose = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopPing();
    this.rejectPending(new Error('Getrennt'));
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    const had = this._room;
    this._room = null;
    this.resetGameState();
    if (had) this.lobby.emit('room', null);
    this._selfId = '';
    this.setStatus('closed');
  }

  // ------------------------------------------------ Lobby
  createRoom(opts: RoomOptions = {}): Promise<RoomInfo> {
    const msg = {
      t: 'room:create',
      scenario: opts.scenario ?? 'adria-nord',
      seed: opts.seed ?? Math.floor(Math.random() * 1_000_000),
      fillAI: opts.fillAI ?? true,
      mode: opts.mode ?? 'teams',
    } as ClientToServer;
    return this.request(msg);
  }
  joinRoom(code: string): Promise<RoomInfo> {
    return this.request({ t: 'room:join', code: code.trim().toUpperCase() });
  }
  leaveRoom(): void {
    this.leaving = true;
    this.sendRaw({ t: 'room:leave' });
    this.resetGameState();
  }
  setSlot(a3: string | null): void {
    this.sendRaw({ t: 'room:slot', a3 });
  }
  setReady(ready: boolean): void {
    this.sendRaw({ t: 'room:ready', ready });
  }
  configure(partial: RoomOptions): void {
    this.sendRaw({ t: 'room:config', ...partial });
  }
  startGame(): void {
    this.sendRaw({ t: 'room:start' });
  }
  sendChat(text: string): void {
    this.sendRaw({ t: 'chat', text });
  }

  // ------------------------------------------------ NetTransport
  broadcastSnapshot(snapshot: unknown): void {
    if (this._role !== 'host') return;
    this.sendRaw({ t: 'snap', data: snapshot });
  }
  broadcastEvent(name: string, payload: unknown): void {
    if (this._role !== 'host') return;
    this.sendRaw({ t: 'evt', name, payload });
  }
  sendCommand(method: string, args: unknown[]): void {
    if (this._role !== 'guest') return;
    this.sendRaw({ t: 'cmd', method, args });
  }

  // ------------------------------------------------ intern
  private sendRaw(m: ClientToServer): void {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  }

  private request(msg: ClientToServer): Promise<RoomInfo> {
    return new Promise<RoomInfo>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return reject(new Error('Nicht verbunden.'));
      this.rejectPending(new Error('Abgebrochen'));
      const timer = setTimeout(() => this.rejectPending(new Error('Keine Antwort vom Server.')), 6000);
      this.pending = { resolve, reject, timer };
      this.sendRaw(msg);
    });
  }
  private rejectPending(e: Error): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    p.reject(e);
  }

  private onServerMessage(m: ServerToClient): void {
    switch (m.t) {
      case 'room': {
        if (m.room === null) {
          const wasInGame = this._role !== 'offline' && !this.leaving;
          this._role = 'offline';
          this.leaving = false;
          this.setRoom(null);
          if (wasInGame) this.emitDisconnect('Der Host hat das Spiel beendet.');
        } else {
          this.setRoom(m.room);
          if (this.pending) {
            const p = this.pending;
            this.pending = null;
            clearTimeout(p.timer);
            p.resolve(m.room);
          }
        }
        break;
      }
      case 'start':
        this.handleStarted(m.room, m.you);
        break;
      case 'chat':
        this.lobby.emit('chat', m.from, m.text);
        break;
      case 'cmd':
        if (this._role === 'host') this.deliverCommand(m.from, m.method, Array.isArray(m.args) ? m.args : []);
        break;
      case 'snap':
        if (this._role === 'guest') this.deliverSnapshot(m.data);
        break;
      case 'evt':
        if (this._role === 'guest') this.deliverEvent(m.name, m.payload);
        break;
      case 'error':
        this.rejectPending(new Error(m.message));
        this.lobby.emit('error', m.message);
        break;
      case 'pong':
        this._latency = Math.max(0, Math.round(performance.now() - m.ts));
        break;
      default:
        break;
    }
  }

  private startPing(): void {
    this.stopPing();
    const ping = () => this.sendRaw({ t: 'ping', ts: performance.now() });
    ping();
    this.pingTimer = setInterval(ping, 5000);
  }
  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
}
