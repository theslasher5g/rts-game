/** No-op-Transport für das Einzelspiel (role 'offline'): nichts wird gesendet, nichts kommt an. */
import type { NetTransport, PeerInfo, Role } from './transport';

export class OfflineTransport implements NetTransport {
  readonly role: Role = 'offline';
  readonly selfId = 'local';
  readonly peers: ReadonlyArray<PeerInfo> = [];

  broadcastSnapshot(_snapshot: unknown): void {}
  broadcastEvent(_name: string, _payload: unknown): void {}
  sendCommand(_method: string, _args: unknown[]): void {}

  onSnapshot(_fn: (snapshot: unknown) => void): () => void {
    return () => {};
  }
  onEvent(_fn: (name: string, payload: unknown) => void): () => void {
    return () => {};
  }
  onCommand(_fn: (from: PeerInfo, method: string, args: unknown[]) => void): () => void {
    return () => {};
  }
  onPeersChanged(_fn: (peers: ReadonlyArray<PeerInfo>) => void): () => void {
    return () => {};
  }
  onDisconnect(_fn: (reason: string) => void): () => void {
    return () => {};
  }
}
