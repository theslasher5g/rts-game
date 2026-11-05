/**
 * Mehrspieler – Befehls-RPC (Gast -> Host).
 *
 * Gast: installGuestProxies() ersetzt die Befehlsmethoden der Systeme (units.issueMove, combat.orderAttack ...) am Objekt durch
 * Stellvertreter, die `transport.sendCommand(methode, args)` senden und einen harmlosen Standardwert liefern. Die Oberfläche
 * (SelectionController, CombatControls, ProductionPanel) ruft unverändert die Systemobjekte auf.
 *
 * Host: installHostCommandHandler() empfängt Befehle, prüft sie streng (Methode in NET_COMMANDS, Argumente wohlgeformt, jede
 * Einheit gehört der Nation des Absenders, Basen/Aufträge ebenso, Koordinaten auf Kartengrenzen geklemmt, Ratenbegrenzung)
 * und ruft dann die ECHTE Methode am Host-Objekt auf. Meldungen (toast), die dabei entstehen, gehen nur an den Absender.
 */
import { bus } from '../core/EventBus';
import type { Formation, MoveOptions } from '../units/types';
import { NET_COMMANDS, type NetTransport, type PeerInfo } from './transport';
import type { GameContext } from '../game/context';

type Fn = (...a: unknown[]) => unknown;

/** Optionale Ziel-Objekte außerhalb von GameContext */
export interface CommandTargets {
  /** Fähigkeiten-System (src/abilities): Objekt mit `use(...)` */
  abilities?: { use: Fn } | null;
}

const FORMATIONS = new Set<string>(['line', 'column', 'wedge', 'spread']);
const MOVE_KINDS = new Set<string>(['move', 'attackMove', 'reverse', 'retreat', 'patrol']);
const MAX_IDS = 400;
const MAX_POINTS = 64;
const RATE_PER_SEC = 60;
const RATE_BURST = 120;

// ------------------------------------------------------------------ Meldungs-Bereich (wer hat den Befehl ausgelöst?)

/** null = kein Befehl aktiv (globale Meldung); { a3: null } = lokaler Host-Befehl (privat); { a3 } = Gast-Befehl */
let scope: { a3: string | null } | null = null;

/** Für HostSync: In welchem Befehlskontext läuft gerade der Code, der ein Ereignis auslöst? */
export function currentCommandScope(): { a3: string | null } | null {
  return scope;
}

// ------------------------------------------------------------------ Methodenauflösung

function resolve(ctx: GameContext, t: CommandTargets, path: string): { obj: Record<string, unknown>; key: string } | null {
  const [o, k] = path.split('.');
  let obj: unknown = null;
  switch (o) {
    case 'units': obj = ctx.units; break;
    case 'combat': obj = ctx.combat; break;
    case 'structures': obj = ctx.structures; break;
    case 'production': obj = ctx.production; break;
    case 'economy': obj = ctx.economy; break;
    case 'abilities': obj = t.abilities ?? null; break;
    default: return null;
  }
  if (!obj || typeof (obj as Record<string, unknown>)[k] !== 'function') return null;
  return { obj: obj as Record<string, unknown>, key: k };
}

function clean(v: unknown, depth = 0): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'function' || depth > 4) return null;
  if (Array.isArray(v)) return v.map((x) => clean(x, depth + 1));
  if (ArrayBuffer.isView(v)) return Array.from(v as unknown as ArrayLike<number>);
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const c = clean(x, depth + 1);
      if (c !== null || x === null) out[k] = c;
    }
    return out;
  }
  return null;
}

/** Standard-Rückgabe eines Gast-Stellvertreters */
const GUEST_DEFAULTS: Record<string, () => unknown> = {
  'production.queue': () => ({ ok: true }),
  'production.buildBase': () => ({ ok: true, id: -1 }),
  'economy.rebuildBase': () => ({ ok: true }),
  'structures.orderBuild': () => -1,
};

export interface GuestProxyHandle {
  /** Ursprüngliche Methoden wiederherstellen */
  restore(): void;
  /** Anzahl gesendeter Befehle (Debug) */
  readonly sent: number;
}

/**
 * GAST: Befehlsmethoden durch Netzwerk-Stellvertreter ersetzen.
 * `abilities` ist optional (Fähigkeiten-Objekt, falls vorhanden). `chat.send` ist kein Objektaufruf: nutze `sendChat`.
 */
export function installGuestProxies(ctx: GameContext, transport: NetTransport, selfA3: string, targets: CommandTargets = {}): GuestProxyHandle {
  void selfA3;
  const restores: Array<() => void> = [];
  const handle = { sent: 0, restore: () => { for (const r of restores.splice(0)) r(); } };
  for (const path of NET_COMMANDS) {
    if (path === 'chat.send') continue;
    const r = resolve(ctx, targets, path);
    if (!r) continue;
    const orig = r.obj[r.key];
    const def = GUEST_DEFAULTS[path];
    r.obj[r.key] = (...args: unknown[]): unknown => {
      try {
        transport.sendCommand(path, clean(args) as unknown[]);
        handle.sent++;
      } catch (e) {
        console.debug('net: sendCommand fehlgeschlagen', path, e);
      }
      return def ? def() : undefined;
    };
    restores.push(() => { r.obj[r.key] = orig; });
  }
  return handle;
}

/** GAST: Chatnachricht an den Host (erscheint dort als Meldung) */
export function sendChat(transport: NetTransport, text: string): void {
  transport.sendCommand('chat.send', [String(text).slice(0, 200)]);
}

/**
 * HOST: lokale Befehle (Host-Spieler) markieren, damit ihre Fehlermeldungen privat bleiben (nicht an Gäste gehen).
 * Ruft die Originalmethoden unverändert auf.
 */
export function installHostLocalScope(ctx: GameContext, targets: CommandTargets = {}): () => void {
  const restores: Array<() => void> = [];
  for (const path of NET_COMMANDS) {
    if (path === 'chat.send') continue;
    const r = resolve(ctx, targets, path);
    if (!r) continue;
    const orig = r.obj[r.key] as Fn;
    r.obj[r.key] = function (this: unknown, ...a: unknown[]): unknown {
      const prev = scope;
      if (prev === null) scope = { a3: null };
      try {
        return orig.apply(r.obj, a);
      } finally {
        scope = prev;
      }
    };
    restores.push(() => { r.obj[r.key] = orig; });
  }
  return () => { for (const r of restores.splice(0)) r(); };
}

// ------------------------------------------------------------------ Host: Validierung

export interface HostCommandOptions {
  /** Prüft/ersetzt die Argumente von abilities.use (Standard: einfache Typprüfung, Nation vorangestellt wird nicht) */
  abilityArgs?: (nation: string, args: unknown[]) => unknown[] | null;
  /** Chat-Zustellung (Standard: 'alert'-Ereignis) */
  onChat?: (from: PeerInfo, nation: string | null, text: string) => void;
  /** Ratenlimit pro Peer (Befehle/s) */
  ratePerSec?: number;
}

export interface HostCommandStats {
  accepted: number;
  rejected: number;
  rateLimited: number;
  lastReject: string;
}

export interface HostCommandHandle {
  dispose(): void;
  readonly stats: HostCommandStats;
  /** Test-Einstieg: einen Befehl direkt verarbeiten (wie von transport.onCommand) */
  handle(from: PeerInfo, method: string, args: unknown[]): boolean;
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1e9;
}
function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function clampN(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

/**
 * HOST: Befehle von Gästen entgegennehmen, prüfen, ausführen.
 * resolveNation(peerId) liefert die Nation des Spielers (null = kein Mensch/unbekannt -> Befehl wird verworfen).
 */
export function installHostCommandHandler(
  ctx: GameContext,
  transport: NetTransport,
  resolveNation: (peerId: string) => string | null,
  targets: CommandTargets = {},
  opts: HostCommandOptions = {},
): HostCommandHandle {
  const stats: HostCommandStats = { accepted: 0, rejected: 0, rateLimited: 0, lastReject: '' };
  const buckets = new Map<string, { tokens: number; t: number }>();
  const rate = opts.ratePerSec ?? RATE_PER_SEC;
  const W = ctx.geo.widthKm, H = ctx.geo.heightKm;
  const nowMs = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  // Originalmethoden einmalig festhalten (unabhängig von späterem Umhängen)
  const origs = new Map<string, { obj: Record<string, unknown>; fn: Fn }>();
  for (const path of NET_COMMANDS) {
    if (path === 'chat.send') continue;
    const r = resolve(ctx, targets, path);
    if (r) origs.set(path, { obj: r.obj, fn: r.obj[r.key] as Fn });
  }

  const reject = (peer: PeerInfo, method: string, why: string): false => {
    stats.rejected++;
    stats.lastReject = `${peer.id}:${method}: ${why}`;
    console.debug('net: Befehl abgelehnt', stats.lastReject);
    return false;
  };

  /** Einheiten-IDs prüfen: Besitz erzwingen. null = ablehnen. Nicht (mehr) vorhandene IDs werden stillschweigend entfernt. */
  const ownedIds = (v: unknown, nation: string): number[] | null => {
    if (!Array.isArray(v) || v.length === 0 || v.length > MAX_IDS) return null;
    const out: number[] = [];
    for (const id of v) {
      if (!isInt(id)) return null;
      const u = ctx.units.get(id);
      if (!u) continue;
      if (u.owner !== nation) return null;
      out.push(id);
    }
    return out;
  };

  const ownBase = (id: unknown, nation: string): boolean => {
    if (!isInt(id)) return false;
    const b = ctx.economy.bases.get(id);
    return !!b && b.owner === nation;
  };

  const px = (v: unknown): number | null => (isNum(v) ? clampN(v, 0, W) : null);
  const pz = (v: unknown): number | null => (isNum(v) ? clampN(v, 0, H) : null);

  const moveOpts = (v: unknown): MoveOptions | null => {
    if (v === undefined || v === null) return {};
    if (typeof v !== 'object' || Array.isArray(v)) return null;
    const o = v as Record<string, unknown>;
    const out: MoveOptions = {};
    if (o.formation !== undefined) { if (typeof o.formation !== 'string' || !FORMATIONS.has(o.formation)) return null; out.formation = o.formation as Formation; }
    if (o.facing !== undefined) { if (!isNum(o.facing)) return null; out.facing = o.facing; }
    if (o.queue !== undefined) out.queue = o.queue === true;
    if (o.kind !== undefined) { if (typeof o.kind !== 'string' || !MOVE_KINDS.has(o.kind)) return null; out.kind = o.kind as MoveOptions['kind']; }
    if (o.widthKm !== undefined) { if (!isNum(o.widthKm)) return null; out.widthKm = clampN(o.widthKm, 0, 60); }
    return out;
  };

  const run = (path: string, nation: string, args: unknown[]): void => {
    const o = origs.get(path);
    if (!o) throw new Error('Methode nicht verfügbar');
    const prev = scope;
    scope = { a3: nation };
    try {
      o.fn.apply(o.obj, args);
    } finally {
      scope = prev;
    }
  };

  /** Validiert und liefert die zu verwendenden Argumente (oder null = ablehnen) */
  const validate = (path: string, nation: string, a: unknown[]): unknown[] | string => {
    switch (path) {
      case 'units.issueMove': {
        const ids = ownedIds(a[0], nation); const x = px(a[1]); const z = pz(a[2]); const mo = moveOpts(a[3]);
        if (!ids || x === null || z === null || !mo) return 'Argumente';
        return ids.length ? [ids, x, z, mo] : 'leer';
      }
      case 'units.issueStop':
      case 'units.issueHold':
      case 'combat.stopFiring':
      case 'structures.ungarrison': {
        const ids = ownedIds(a[0], nation);
        if (!ids) return 'Einheiten';
        return ids.length ? [ids] : 'leer';
      }
      case 'units.setFormation': {
        const ids = ownedIds(a[0], nation);
        if (!ids || typeof a[1] !== 'string' || !FORMATIONS.has(a[1])) return 'Argumente';
        return ids.length ? [ids, a[1]] : 'leer';
      }
      case 'combat.orderAttack': {
        const ids = ownedIds(a[0], nation);
        if (!ids || !isInt(a[1])) return 'Argumente';
        return ids.length ? [ids, a[1]] : 'leer';
      }
      case 'combat.orderFireAt': {
        const ids = ownedIds(a[0], nation); const x = px(a[1]); const z = pz(a[2]);
        if (!ids || x === null || z === null) return 'Argumente';
        return ids.length ? [ids, x, z] : 'leer';
      }
      case 'structures.orderBuild': {
        const ids = ownedIds(a[0], nation);
        if (!ids || typeof a[1] !== 'string' || !Array.isArray(a[2]) || a[2].length < 2 || a[2].length > MAX_POINTS * 2 || a[2].length % 2 !== 0) return 'Argumente';
        const pts: number[] = [];
        for (let i = 0; i < a[2].length; i += 2) {
          const x = px(a[2][i]), z = pz(a[2][i + 1]);
          if (x === null || z === null) return 'Punkte';
          pts.push(x, z);
        }
        if (a[4] !== undefined && a[4] !== null && !isNum(a[4])) return 'facing';
        return ids.length ? [ids, a[1], pts, nation, a[4] ?? undefined] : 'leer';
      }
      case 'structures.orderGarrison': {
        const ids = ownedIds(a[0], nation);
        if (!ids || !isInt(a[1])) return 'Argumente';
        return ids.length ? [ids, a[1]] : 'leer';
      }
      case 'structures.orderDemolish':
      case 'structures.orderRepair': {
        const ids = ownedIds(a[0], nation);
        if (!ids || !isInt(a[1]) || a[1] >= ctx.graph.edges.length) return 'Argumente';
        return ids.length ? [ids, a[1]] : 'leer';
      }
      case 'production.queue': {
        if (!ownBase(a[0], nation) || typeof a[1] !== 'string' || a[1].length > 40) return 'Basis';
        let rally: [number, number] | undefined;
        if (Array.isArray(a[2])) { const x = px(a[2][0]), z = pz(a[2][1]); if (x === null || z === null) return 'Sammelpunkt'; rally = [x, z]; }
        return [a[0], a[1], rally];
      }
      case 'production.cancel': {
        if (!isInt(a[0])) return 'Auftrag';
        const o = ctx.production.orders.get(a[0]);
        if (!o) return 'leer';
        const b = ctx.economy.bases.get(o.baseId);
        if (!b || b.owner !== nation) return 'fremder Auftrag';
        return [a[0]];
      }
      case 'production.setRally': {
        const x = px(a[1]), z = pz(a[2]);
        if (!ownBase(a[0], nation) || x === null || z === null) return 'Basis';
        return [a[0], x, z];
      }
      case 'production.buildBase': {
        // (owner, kind, x, z, engineerIds?) – owner wird durch die Nation des Absenders ersetzt
        const x = px(a[2]), z = pz(a[3]);
        if (typeof a[1] !== 'string' || a[1].length > 20 || x === null || z === null) return 'Argumente';
        let eng: number[] | undefined;
        if (a[4] !== undefined && a[4] !== null) {
          const ids = ownedIds(a[4], nation);
          if (!ids) return 'Pioniere';
          eng = ids;
        }
        return [nation, a[1], x, z, eng];
      }
      case 'economy.rebuildBase': {
        if (a[1] !== 'hq' && a[1] !== 'refinery') return 'Basistyp';
        return [nation, a[1]];
      }
      case 'abilities.use': {
        if (!targets.abilities) return 'keine Fähigkeiten';
        if (opts.abilityArgs) { const r = opts.abilityArgs(nation, a); return r ?? 'Fähigkeit'; }
        // AbilitySystem.use(a3, id, x, z): die Nation wird IMMER durch die des Absenders ersetzt (kein Fremdeinsatz)
        const id = a[1];
        if (a.length !== 4 || typeof id !== 'string' || id.length > 30 || !isNum(a[2]) || !isNum(a[3])) return 'Argumente';
        const defFn = (targets.abilities as unknown as { def?: (id: string) => { damaging?: boolean } | undefined }).def;
        if (ctx.war.ceasefire && defFn?.call(targets.abilities, id)?.damaging) return 'Grenzschutz';
        return [nation, id, clampN(a[2], 0, W), clampN(a[3], 0, H)];
      }
      default:
        return 'unbekannt';
    }
  };

  const handle = (from: PeerInfo, method: string, args: unknown[]): boolean => {
    // Ratenbegrenzung (Token-Bucket)
    const t = nowMs();
    let b = buckets.get(from.id);
    if (!b) buckets.set(from.id, (b = { tokens: RATE_BURST, t }));
    b.tokens = Math.min(RATE_BURST, b.tokens + ((t - b.t) / 1000) * rate);
    b.t = t;
    if (b.tokens < 1) { stats.rateLimited++; return false; }
    b.tokens -= 1;

    if (typeof method !== 'string' || !(NET_COMMANDS as readonly string[]).includes(method)) return reject(from, String(method), 'nicht erlaubt');
    if (!Array.isArray(args) || args.length > 8) return reject(from, method, 'Argumentliste');
    const nation = resolveNation(from.id);
    if (!nation) return reject(from, method, 'keine Nation / kein Spieler');

    if (method === 'chat.send') {
      const text = typeof args[0] === 'string' ? args[0].replace(/[\u0000-\u001f]/g, ' ').slice(0, 200).trim() : '';
      if (!text) return reject(from, method, 'leer');
      if (opts.onChat) opts.onChat(from, nation, text);
      else bus.emit('alert', { a3: nation, kind: 'info', text: `${from.name}: ${text}` });
      stats.accepted++;
      return true;
    }

    const v = validate(method, nation, args);
    if (typeof v === 'string') {
      if (v === 'leer') return true; // Ziele inzwischen weg: harmlos ignorieren
      return reject(from, method, v);
    }
    try {
      run(method, nation, v);
      stats.accepted++;
      return true;
    } catch (e) {
      return reject(from, method, `Ausführung: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const off = transport.onCommand((from, method, args) => { handle(from, method, args); });
  return { dispose: off, stats, handle };
}
