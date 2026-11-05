/**
 * Mehrspieler (Phase 7) – gemeinsamer Vertrag.
 *
 * Architektur: HOST-AUTORITATIV. Ein Spieler (Host) führt die komplette Simulation im Browser aus (wie im Einzelspiel);
 * Gäste senden Befehle (RPC) an den Host und bekommen Zustands-Schnappschüsse sowie Spielereignisse zurück und rendern damit.
 * Ein kleiner Node-Server (server/index.mjs, WebSocket) vermittelt nur Lobby und Nachrichten (Relay). Für lokale Tests gibt es
 * zusätzlich einen BroadcastChannel-Transport (zwei Tabs im selben Browser, ohne Server).
 *
 * Konventionen: Alle Nutzdaten sind JSON-fähig (Zahlen, Strings, Arrays, einfache Objekte). Der Host prüft jeden Befehl:
 * Einheiten-IDs müssen der Nation des Absenders gehören; nur der Host steuert Pause und Zeitraffer.
 */

export type Role = 'host' | 'guest' | 'offline';

export interface PeerInfo {
  id: string;
  name: string;
  /** gewählte Nation (a3) oder null */
  a3: string | null;
  ready: boolean;
  host: boolean;
  /** RTT in ms, falls bekannt */
  pingMs?: number;
}

export interface RoomInfo {
  code: string;
  hostId: string;
  /** Kartenseed / Szenario */
  scenario: string;
  seed: number;
  /** Nationen, die von der KI übernommen werden, wenn kein Spieler sie wählt */
  fillAI: boolean;
  /** 'teams' = 2 gegen 2 (VAL+MAR vs KRN+PAN), 'ffa' = jeder gegen jeden */
  mode: 'teams' | 'ffa';
  started: boolean;
  peers: PeerInfo[];
}

export interface NetTransport {
  readonly role: Role;
  readonly selfId: string;
  readonly peers: ReadonlyArray<PeerInfo>;

  /** Host → alle Gäste: Zustands-Schnappschuss (darf verloren gehen, neuere ersetzen ältere) */
  broadcastSnapshot(snapshot: unknown): void;
  /** Host → alle Gäste: Spielereignis (zuverlässig, in Reihenfolge) */
  broadcastEvent(name: string, payload: unknown): void;
  /** Gast → Host: Befehl (zuverlässig, in Reihenfolge) */
  sendCommand(method: string, args: unknown[]): void;

  onSnapshot(fn: (snapshot: unknown) => void): () => void;
  onEvent(fn: (name: string, payload: unknown) => void): () => void;
  /** Nur beim Host: ein Gast hat einen Befehl gesendet */
  onCommand(fn: (from: PeerInfo, method: string, args: unknown[]) => void): () => void;
  onPeersChanged(fn: (peers: ReadonlyArray<PeerInfo>) => void): () => void;
  onDisconnect(fn: (reason: string) => void): () => void;
}

/** Erlaubte Befehle (Methodenpfade) von Gästen an den Host. Alles andere wird verworfen. */
export const NET_COMMANDS = [
  'units.issueMove', 'units.issueStop', 'units.issueHold', 'units.setFormation',
  'combat.orderAttack', 'combat.orderFireAt', 'combat.stopFiring',
  'structures.orderBuild', 'structures.orderGarrison', 'structures.ungarrison', 'structures.orderDemolish', 'structures.orderRepair',
  'production.queue', 'production.cancel', 'production.setRally', 'production.buildBase',
  'economy.rebuildBase',
  'abilities.use',
  'chat.send',
] as const;
export type NetCommand = (typeof NET_COMMANDS)[number];

/** Bus-Ereignisse, die der Host an Gäste weiterreicht (Effekte, Ton, UI-Meldungen). Rein lokale Ereignisse stehen nicht darin. */
export const NET_EVENTS: ReadonlySet<string> = new Set([
  'combat:fire', 'combat:impact', 'combat:explosion', 'unit:killed', 'wreck:spawn', 'smoke:spawn',
  'building:damaged', 'building:destroyed', 'bridge:destroyed', 'bridge:repaired', 'nav:edge',
  'structure:added', 'structure:removed', 'cover:add', 'cover:remove',
  'oil:delivered', 'oil:field-captured', 'oil:field-damaged', 'production:complete', 'base:built', 'base:destroyed',
  'convoy:started', 'convoy:lost', 'supply:low',
  'civil:casualties', 'civil:infra', 'civil:evacuate', 'civil:aid', 'warcrime', 'reputation:changed', 'city:captured', 'city:unrest', 'city:uprising',
  'war:declared', 'toast', 'mission:ended', 'ability:used', 'alert',
]);

/** Lobby-Nachrichten zwischen Client und Server (server/index.mjs). Der Server ist ein reiner Relay ohne Spiellogik. */
export type ClientToServer =
  | { t: 'hello'; name: string; protocol: number }
  | { t: 'room:create'; scenario: string; seed: number; fillAI: boolean }
  | { t: 'room:join'; code: string }
  | { t: 'room:leave' }
  | { t: 'room:slot'; a3: string | null }
  | { t: 'room:ready'; ready: boolean }
  | { t: 'room:config'; scenario?: string; seed?: number; fillAI?: boolean; mode?: 'teams' | 'ffa' }
  | { t: 'room:start' }
  | { t: 'chat'; text: string }
  | { t: 'cmd'; method: string; args: unknown[] }
  | { t: 'snap'; data: unknown }
  | { t: 'evt'; name: string; payload: unknown }
  | { t: 'ping'; ts: number };

export type ServerToClient =
  | { t: 'welcome'; id: string; protocol: number }
  | { t: 'room'; room: RoomInfo | null }
  | { t: 'start'; room: RoomInfo; you: string }
  | { t: 'chat'; from: string; text: string }
  | { t: 'cmd'; from: string; method: string; args: unknown[] }
  | { t: 'snap'; data: unknown }
  | { t: 'evt'; name: string; payload: unknown }
  | { t: 'error'; message: string }
  | { t: 'pong'; ts: number };

export const NET_PROTOCOL = 1;
/** Lobby: bis zu 4 Spieler (siehe MP_MAX_PLAYERS in src/game/scenario.ts), 4 Nationen: VAL, KRN, MAR, PAN */
export const MAX_PLAYERS = 4;
