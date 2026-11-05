/**
 * NetTransport + Lobby-API über BroadcastChannel (kein Server): zwei oder mehr Tabs im selben Browser.
 * Der Tab, der den Raum erstellt, ist Host und übernimmt die Rolle des Servers (Raumverwaltung wie server/index.mjs).
 * API identisch zu WsTransport (LobbyClient). Nutzdaten werden per structured clone übertragen.
 */
import { BaseTransport, type RoomOptions } from './index';
import { MAX_PLAYERS, type PeerInfo, type RoomInfo } from './transport';

const CHANNEL = 'ww3-mp-v1';
const NATIONS = ['VAL', 'KRN', 'MAR', 'PAN'];
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const HB_MS = 2000;
const TIMEOUT_MS = 8000;

interface Pkt {
  from: string;
  /** Empfänger-ID oder '*' */
  to: string;
  k: string;
  d?: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

interface HostPeer {
  id: string;
  name: string;
  a3: string | null;
  ready: boolean;
  pingMs?: number;
  lastSeen: number;
}

export class BroadcastTransport extends BaseTransport {
  readonly kind = 'broadcast' as const;
  private ch: BroadcastChannel | null = null;
  private name = 'Spieler';
  /** nur Host: autoritativer Raum */
  private hostRoom: { code: string; scenario: string; seed: number; fillAI: boolean; mode: 'teams' | 'ffa'; started: boolean; peers: HostPeer[] } | null = null;
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private lastHostSeen = 0;
  private joinWait: { resolve: (r: RoomInfo) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private onHide = () => {
    if (this._room) this.leaveRoom();
  };

  connect(_url: string, name: string): Promise<void> {
    this.disconnect();
    if (typeof BroadcastChannel === 'undefined') return Promise.reject(new Error('BroadcastChannel wird nicht unterstützt.'));
    this.name = name.trim().slice(0, 20) || 'Spieler';
    this._selfId = 'b' + Math.random().toString(36).slice(2, 10);
    this.ch = new BroadcastChannel(CHANNEL);
    this.ch.onmessage = (ev) => this.onPacket(ev.data as Pkt);
    window.addEventListener('pagehide', this.onHide);
    this.setStatus('open');
    this.hbTimer = setInterval(() => this.tick(), HB_MS);
    return Promise.resolve();
  }

  disconnect(): void {
    if (this._room) this.leaveRoom();
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.hbTimer = null;
    window.removeEventListener('pagehide', this.onHide);
    this.ch?.close();
    this.ch = null;
    this.joinWait && clearTimeout(this.joinWait.timer);
    this.joinWait = null;
    this.setStatus('closed');
  }

  // ------------------------------------------------ Lobby (Nutzeraktionen)
  createRoom(opts: RoomOptions = {}): Promise<RoomInfo> {
    if (!this.ch) return Promise.reject(new Error('Nicht verbunden.'));
    if (this._room) return Promise.reject(new Error('Du bist bereits in einem Raum.'));
    let code = '';
    for (let i = 0; i < 6; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    this.hostRoom = {
      code,
      scenario: opts.scenario ?? 'adria-nord',
      seed: opts.seed ?? Math.floor(Math.random() * 1_000_000),
      fillAI: opts.fillAI ?? true,
      mode: opts.mode === 'ffa' ? 'ffa' : 'teams',
      started: false,
      peers: [{ id: this._selfId, name: this.name, a3: null, ready: true, lastSeen: Date.now() }],
    };
    this.pushRoom();
    return Promise.resolve(this._room!);
  }

  joinRoom(code: string): Promise<RoomInfo> {
    if (!this.ch) return Promise.reject(new Error('Nicht verbunden.'));
    if (this._room) return Promise.reject(new Error('Du bist bereits in einem Raum.'));
    return new Promise<RoomInfo>((resolve, reject) => {
      if (this.joinWait) {
        clearTimeout(this.joinWait.timer);
        this.joinWait.reject(new Error('Abgebrochen'));
      }
      const timer = setTimeout(() => {
        this.joinWait = null;
        reject(new Error('Raum nicht gefunden (ist der Host-Tab offen?).'));
      }, 1500);
      this.joinWait = { resolve, reject, timer };
      this.send('*', 'join', { code: code.trim().toUpperCase(), name: this.name });
    });
  }

  leaveRoom(): void {
    const room = this._room;
    if (!room) return;
    const wasInGame = this._role !== 'offline';
    if (this.hostRoom) {
      this.send('*', 'close', { code: this.hostRoom.code, why: 'Der Host hat den Raum verlassen – Raum geschlossen.' });
      this.hostRoom = null;
    } else {
      this.send(room.hostId, 'leave', {});
    }
    this.resetGameState();
    this.setRoom(null);
    void wasInGame;
  }

  setSlot(a3: string | null): void {
    if (this.hostRoom) return this.hostSlot(this._selfId, a3);
    this.send(this._room?.hostId ?? '', 'slot', { a3 });
  }
  setReady(ready: boolean): void {
    if (this.hostRoom) return this.hostReady(this._selfId, ready);
    this.send(this._room?.hostId ?? '', 'ready', { ready });
  }
  configure(p: RoomOptions): void {
    const r = this.hostRoom;
    if (!r) return this.lobby.emit('error', 'Nur der Host darf den Raum konfigurieren.');
    if (r.started) return;
    let changed = false;
    if (typeof p.scenario === 'string' && p.scenario && p.scenario !== r.scenario) (r.scenario = p.scenario.slice(0, 40)), (changed = true);
    if (typeof p.seed === 'number' && Number.isInteger(p.seed) && p.seed >= 0 && p.seed <= 4294967295 && p.seed !== r.seed) (r.seed = p.seed), (changed = true);
    if (typeof p.fillAI === 'boolean' && p.fillAI !== r.fillAI) (r.fillAI = p.fillAI), (changed = true);
    if ((p.mode === 'teams' || p.mode === 'ffa') && p.mode !== r.mode) (r.mode = p.mode), (changed = true);
    if (changed) for (const q of r.peers) if (q.id !== this._selfId) q.ready = false;
    this.pushRoom();
  }
  startGame(): void {
    const r = this.hostRoom;
    if (!r) return this.lobby.emit('error', 'Nur der Host darf das Spiel starten.');
    if (r.started) return;
    if (r.peers.some((p) => !p.a3)) return this.lobby.emit('error', 'Nicht alle Spieler haben eine Nation gewählt.');
    if (r.peers.some((p) => p.id !== this._selfId && !p.ready)) return this.lobby.emit('error', 'Nicht alle Spieler sind bereit.');
    r.started = true;
    const info = this.buildInfo();
    this.send('*', 'start', { room: info });
    this.handleStarted(info, this._selfId);
  }
  sendChat(text: string): void {
    const t = text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300);
    if (!t || !this._room) return;
    if (this.hostRoom) return this.hostChat(this._selfId, t);
    this.send(this._room.hostId, 'chat', { text: t });
  }

  // ------------------------------------------------ NetTransport
  broadcastSnapshot(snapshot: unknown): void {
    if (this._role !== 'host') return;
    this.send('*', 'snap', snapshot);
  }
  broadcastEvent(name: string, payload: unknown): void {
    if (this._role !== 'host') return;
    this.send('*', 'evt', { name, payload });
  }
  sendCommand(method: string, args: unknown[]): void {
    if (this._role !== 'guest' || !this._room) return;
    this.send(this._room.hostId, 'cmd', { method, args });
  }

  // ------------------------------------------------ Host-Logik
  private buildInfo(): RoomInfo {
    const r = this.hostRoom!;
    return {
      code: r.code,
      hostId: this._selfId,
      scenario: r.scenario,
      seed: r.seed,
      fillAI: r.fillAI,
      mode: r.mode,
      started: r.started,
      peers: r.peers.map((p): PeerInfo => ({
        id: p.id,
        name: p.name,
        a3: p.a3,
        ready: p.id === this._selfId ? true : p.ready,
        host: p.id === this._selfId,
        ...(p.pingMs !== undefined ? { pingMs: p.pingMs } : {}),
      })),
    };
  }

  /** Raum an alle senden und lokal übernehmen */
  private pushRoom(): void {
    const info = this.buildInfo();
    this.send('*', 'room', { room: info });
    this.setRoom(info);
  }

  private hostSlot(id: string, a3: string | null): void {
    const r = this.hostRoom;
    const p = r?.peers.find((q) => q.id === id);
    if (!r || !p || r.started) return;
    if (a3 !== null && !NATIONS.includes(a3)) return this.hostError(id, 'Unbekannte Nation.');
    if (a3 !== null && r.peers.some((q) => q !== p && q.a3 === a3)) return this.hostError(id, 'Diese Nation ist bereits vergeben.');
    p.a3 = a3;
    p.ready = false;
    this.pushRoom();
  }
  private hostReady(id: string, ready: boolean): void {
    const r = this.hostRoom;
    const p = r?.peers.find((q) => q.id === id);
    if (!r || !p || r.started) return;
    if (ready && !p.a3) return this.hostError(id, 'Wähle zuerst eine Nation.');
    p.ready = ready;
    this.pushRoom();
  }
  private hostChat(id: string, text: string): void {
    const r = this.hostRoom;
    const p = r?.peers.find((q) => q.id === id);
    if (!r || !p) return;
    this.send('*', 'chat', { from: p.name, text });
    this.lobby.emit('chat', p.name, text);
  }
  private hostError(id: string, message: string): void {
    if (id === this._selfId) this.lobby.emit('error', message);
    else this.send(id, 'err', { message });
  }
  private dropPeer(id: string): void {
    const r = this.hostRoom;
    if (!r) return;
    const before = r.peers.length;
    r.peers = r.peers.filter((p) => p.id !== id);
    if (r.peers.length !== before) this.pushRoom();
  }

  // ------------------------------------------------ Paketverarbeitung
  private send(to: string, k: string, d?: unknown): void {
    if (!this.ch || !to) return;
    try {
      this.ch.postMessage({ from: this._selfId, to, k, d } satisfies Pkt);
    } catch (e) {
      console.warn('[net] BroadcastChannel send fehlgeschlagen', e);
    }
  }

  private onPacket(p: Pkt): void {
    if (!p || typeof p.k !== 'string' || p.from === this._selfId) return;
    if (p.to !== '*' && p.to !== this._selfId) return;
    const r = this.hostRoom;

    if (r) {
      // ---- Host
      const peer = r.peers.find((q) => q.id === p.from);
      if (peer) peer.lastSeen = Date.now();
      switch (p.k) {
        case 'join': {
          if (String(p.d?.code).toUpperCase() !== r.code) return;
          if (r.started) return this.send(p.from, 'err', { message: 'Das Spiel in diesem Raum läuft bereits.' });
          if (r.peers.length >= MAX_PLAYERS) return this.send(p.from, 'err', { message: 'Raum ist voll (4/4).' });
          if (peer) return;
          r.peers.push({ id: p.from, name: String(p.d?.name ?? 'Spieler').slice(0, 20) || 'Spieler', a3: null, ready: false, lastSeen: Date.now() });
          this.pushRoom();
          return;
        }
        case 'leave':
          return this.dropPeer(p.from);
        case 'slot':
          if (peer) this.hostSlot(p.from, p.d?.a3 ?? null);
          return;
        case 'ready':
          if (peer && typeof p.d?.ready === 'boolean') this.hostReady(p.from, p.d.ready);
          return;
        case 'chat':
          if (peer && typeof p.d?.text === 'string') this.hostChat(p.from, p.d.text.slice(0, 300));
          return;
        case 'cmd':
          if (peer && r.started && typeof p.d?.method === 'string' && Array.isArray(p.d?.args)) this.deliverCommand(p.from, p.d.method, p.d.args);
          return;
        case 'hbr':
          if (peer && typeof p.d?.ts === 'number') {
            const rtt = Math.round(Math.min(9999, performance.now() - p.d.ts));
            if (peer.pingMs === undefined || Math.abs(peer.pingMs - rtt) > 0) peer.pingMs = rtt;
          }
          return;
        default:
          return;
      }
    }

    // ---- Gast / ohne Raum
    const room = this._room;
    switch (p.k) {
      case 'room': {
        const info = p.d?.room as RoomInfo | undefined;
        if (!info) return;
        if (this.joinWait && info.peers.some((q) => q.id === this._selfId)) {
          const w = this.joinWait;
          this.joinWait = null;
          clearTimeout(w.timer);
          this.lastHostSeen = Date.now();
          this.setRoom(info);
          w.resolve(info);
          return;
        }
        if (room && p.from === room.hostId) {
          if (!info.peers.some((q) => q.id === this._selfId)) return this.kicked('Aus dem Raum entfernt.');
          this.lastHostSeen = Date.now();
          this.setRoom(info);
        }
        return;
      }
      case 'err':
        if (this.joinWait) {
          const w = this.joinWait;
          this.joinWait = null;
          clearTimeout(w.timer);
          w.reject(new Error(String(p.d?.message ?? 'Fehler')));
        } else this.lobby.emit('error', String(p.d?.message ?? 'Fehler'));
        return;
      default:
        break;
    }
    if (!room || p.from !== room.hostId) return;
    this.lastHostSeen = Date.now();
    switch (p.k) {
      case 'start':
        this.handleStarted(p.d.room as RoomInfo, this._selfId);
        return;
      case 'chat':
        this.lobby.emit('chat', String(p.d?.from ?? '?'), String(p.d?.text ?? ''));
        return;
      case 'close':
        return this.kicked(String(p.d?.why ?? 'Raum geschlossen.'));
      case 'hb':
        this.send(room.hostId, 'hbr', { ts: p.d?.ts });
        return;
      case 'snap':
        if (this._role === 'guest') this.deliverSnapshot(p.d);
        return;
      case 'evt':
        if (this._role === 'guest') this.deliverEvent(String(p.d?.name), p.d?.payload);
        return;
      default:
        return;
    }
  }

  private kicked(reason: string): void {
    const wasInGame = this._role !== 'offline';
    this.resetGameState();
    this.setRoom(null);
    this.lobby.emit('error', reason);
    if (wasInGame) this.emitDisconnect(reason);
  }

  private tick(): void {
    const now = Date.now();
    const r = this.hostRoom;
    if (r) {
      this.send('*', 'hb', { ts: performance.now() });
      for (const p of [...r.peers]) if (p.id !== this._selfId && now - p.lastSeen > TIMEOUT_MS) this.dropPeer(p.id);
      if (!r.started) this.pushRoom();
      else {
        // Ping-Werte weitergeben
        const info = this.buildInfo();
        this.send('*', 'room', { room: info });
        this._room = info;
      }
    } else if (this._room && now - this.lastHostSeen > TIMEOUT_MS) {
      this.kicked('Verbindung zum Host verloren.');
    }
    // eigene Latenz
    this._latency = this.self?.pingMs ?? 0;
  }
}
