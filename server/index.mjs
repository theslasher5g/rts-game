#!/usr/bin/env node
/**
 * WW3: EUROPE – Mehrspieler-Relay (Lobby + Nachrichtenvermittlung), KEINE Spiellogik.
 * Host-autoritativ: Der Host-Browser simuliert; Gäste senden 'cmd' (nur an den Host), der Host sendet 'snap'/'evt' (nur an Gäste).
 *
 *   node server/index.mjs [--port 8787] [--host 0.0.0.0] [--dist ./dist] [--max-payload 2097152]
 *
 * Liefert zusätzlich den gebauten Ordner dist/ statisch aus (npm run build && npm run server) und /health.
 * Protokoll: siehe src/net/transport.ts (ClientToServer / ServerToClient).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- Konfiguration
function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const PORT = Number(arg('port', process.env.PORT || 8787));
const HOST = arg('host', process.env.HOST || '0.0.0.0');
const DIST = path.resolve(arg('dist', path.join(__dirname, '..', 'dist')));
const MAX_PAYLOAD = Number(arg('max-payload', 2 * 1024 * 1024)); // harte WebSocket-Grenze (Snapshots)
const MAX_CTRL_BYTES = 16 * 1024; // alles außer snap/evt
const MAX_EVT_BYTES = 256 * 1024;
const MAX_ROOMS = 200;
const MAX_CLIENTS = 600;
const MAX_CLIENTS_PER_IP = 24;
const NET_PROTOCOL = 1;
const MAX_PLAYERS = 4;
const NATIONS = ['VAL', 'KRN', 'MAR', 'PAN'];
const IDLE_TIMEOUT_MS = 120_000; // keine Nachricht vom Client (Clients pingen alle 5 s)
const HEARTBEAT_MS = 5_000;
const SLOW_CLIENT_BYTES = 4 * 1024 * 1024; // Snapshots für langsame Gäste verwerfen
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// ---------------------------------------------------------------- Logging
const t0 = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${t0()}]`, ...a);
const warn = (...a) => console.warn(`[${t0()}] !`, ...a);

// ---------------------------------------------------------------- Zustand
/** @type {Map<string, Client>} */
const clients = new Map();
/** @type {Map<string, Room>} */
const rooms = new Map();
const perIp = new Map();

/**
 * @typedef {{ id:string, ws:import('ws').WebSocket, ip:string, name:string, hello:boolean, room:Room|null, a3:string|null,
 *   ready:boolean, pingMs:number|undefined, lastMsg:number, lastPingSent:number, alive:boolean, tokens:number, tokenAt:number,
 *   chatTimes:number[] }} Client
 * @typedef {{ code:string, hostId:string, scenario:string, seed:number, fillAI:boolean, mode:'teams'|'ffa', started:boolean,
 *   peers:Client[], lastBroadcast:number }} Room
 */

function newId() {
  return randomBytes(6).toString('hex');
}
function newCode() {
  for (let n = 0; n < 50; n++) {
    let c = '';
    const b = randomBytes(6);
    for (let i = 0; i < 6; i++) c += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
    if (!rooms.has(c)) return c;
  }
  throw new Error('no code');
}

function cleanName(v) {
  const s = String(v ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .trim()
    .slice(0, 20);
  return s || 'Spieler';
}

function roomInfo(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    scenario: room.scenario,
    seed: room.seed,
    fillAI: room.fillAI,
    mode: room.mode,
    started: room.started,
    peers: room.peers.map((p) => ({
      id: p.id,
      name: p.name,
      a3: p.a3,
      ready: p.id === room.hostId ? true : p.ready,
      host: p.id === room.hostId,
      ...(p.pingMs !== undefined ? { pingMs: p.pingMs } : {}),
    })),
  };
}

function sendJson(c, obj) {
  if (c.ws.readyState === 1) c.ws.send(JSON.stringify(obj));
}
function err(c, message) {
  sendJson(c, { t: 'error', message });
}
function broadcastRoom(room) {
  const msg = JSON.stringify({ t: 'room', room: roomInfo(room) });
  for (const p of room.peers) if (p.ws.readyState === 1) p.ws.send(msg);
  room.lastBroadcast = Date.now();
}

// ---------------------------------------------------------------- Raumlogik
function leaveRoom(c, reason) {
  const room = c.room;
  if (!room) return;
  c.room = null;
  c.a3 = null;
  c.ready = false;
  if (room.hostId === c.id) {
    // Host weg: Raum schließen, alle informieren
    for (const p of room.peers) {
      if (p === c) continue;
      p.room = null;
      p.a3 = null;
      p.ready = false;
      err(p, reason === 'leave' ? 'Der Host hat den Raum verlassen – Raum geschlossen.' : 'Verbindung zum Host verloren – Raum geschlossen.');
      sendJson(p, { t: 'room', room: null });
    }
    rooms.delete(room.code);
    log(`Raum ${room.code} geschlossen (Host ${c.name} weg, ${reason})`);
  } else {
    room.peers = room.peers.filter((p) => p !== c);
    log(`${c.name} verlässt Raum ${room.code} (${room.peers.length}/${MAX_PLAYERS})`);
    broadcastRoom(room);
  }
  sendJson(c, { t: 'room', room: null });
}

function resetReady(room) {
  for (const p of room.peers) if (p.id !== room.hostId) p.ready = false;
}

function isInt(v, lo, hi) {
  return typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
}

function handleCreate(c, m) {
  if (c.room) return err(c, 'Du bist bereits in einem Raum.');
  if (rooms.size >= MAX_ROOMS) return err(c, 'Server voll (zu viele Räume).');
  const scenario = typeof m.scenario === 'string' && m.scenario.length <= 40 ? m.scenario : 'adria-nord';
  const seed = isInt(m.seed, 0, 4294967295) ? m.seed : Math.floor(Math.random() * 1_000_000);
  const room = {
    code: newCode(),
    hostId: c.id,
    scenario,
    seed,
    fillAI: m.fillAI !== false,
    mode: m.mode === 'ffa' ? 'ffa' : 'teams',
    started: false,
    peers: [c],
    lastBroadcast: 0,
  };
  rooms.set(room.code, room);
  c.room = room;
  c.a3 = null;
  c.ready = false;
  log(`Raum ${room.code} erstellt von ${c.name}`);
  broadcastRoom(room);
}

function handleJoin(c, m) {
  if (c.room) return err(c, 'Du bist bereits in einem Raum.');
  const code = typeof m.code === 'string' ? m.code.trim().toUpperCase() : '';
  if (!/^[A-Z0-9]{6}$/.test(code)) return err(c, 'Ungültiger Raumcode.');
  const room = rooms.get(code);
  if (!room) return err(c, `Raum ${code} nicht gefunden.`);
  if (room.started) return err(c, 'Das Spiel in diesem Raum läuft bereits.');
  if (room.peers.length >= MAX_PLAYERS) return err(c, 'Raum ist voll (4/4).');
  room.peers.push(c);
  c.room = room;
  c.a3 = null;
  c.ready = false;
  log(`${c.name} betritt Raum ${code} (${room.peers.length}/${MAX_PLAYERS})`);
  broadcastRoom(room);
}

function handleSlot(c, m) {
  const room = c.room;
  if (!room) return err(c, 'Kein Raum.');
  if (room.started) return err(c, 'Spiel läuft bereits.');
  const a3 = m.a3 === null ? null : typeof m.a3 === 'string' ? m.a3 : undefined;
  if (a3 === undefined || (a3 !== null && !NATIONS.includes(a3))) return err(c, 'Unbekannte Nation.');
  if (a3 !== null && room.peers.some((p) => p !== c && p.a3 === a3)) return err(c, 'Diese Nation ist bereits vergeben.');
  c.a3 = a3;
  c.ready = false;
  broadcastRoom(room);
}

function handleReady(c, m) {
  const room = c.room;
  if (!room || room.started) return;
  if (typeof m.ready !== 'boolean') return err(c, 'Ungültige Nachricht.');
  if (m.ready && !c.a3) return err(c, 'Wähle zuerst eine Nation.');
  c.ready = m.ready;
  broadcastRoom(room);
}

function handleConfig(c, m) {
  const room = c.room;
  if (!room) return err(c, 'Kein Raum.');
  if (room.hostId !== c.id) return err(c, 'Nur der Host darf den Raum konfigurieren.');
  if (room.started) return err(c, 'Spiel läuft bereits.');
  let changed = false;
  if (m.scenario !== undefined) {
    if (typeof m.scenario !== 'string' || m.scenario.length < 1 || m.scenario.length > 40) return err(c, 'Ungültiges Szenario.');
    if (m.scenario !== room.scenario) (room.scenario = m.scenario), (changed = true);
  }
  if (m.seed !== undefined) {
    if (!isInt(m.seed, 0, 4294967295)) return err(c, 'Ungültiger Seed.');
    if (m.seed !== room.seed) (room.seed = m.seed), (changed = true);
  }
  if (m.fillAI !== undefined) {
    if (typeof m.fillAI !== 'boolean') return err(c, 'Ungültige Einstellung.');
    if (m.fillAI !== room.fillAI) (room.fillAI = m.fillAI), (changed = true);
  }
  if (m.mode !== undefined) {
    if (m.mode !== 'teams' && m.mode !== 'ffa') return err(c, 'Ungültiger Modus.');
    if (m.mode !== room.mode) (room.mode = m.mode), (changed = true);
  }
  if (changed) resetReady(room);
  broadcastRoom(room);
}

function handleStart(c) {
  const room = c.room;
  if (!room) return err(c, 'Kein Raum.');
  if (room.hostId !== c.id) return err(c, 'Nur der Host darf das Spiel starten.');
  if (room.started) return err(c, 'Spiel läuft bereits.');
  if (room.peers.some((p) => !p.a3)) return err(c, 'Nicht alle Spieler haben eine Nation gewählt.');
  if (room.peers.some((p) => p.id !== room.hostId && !p.ready)) return err(c, 'Nicht alle Spieler sind bereit.');
  room.started = true;
  const info = roomInfo(room);
  for (const p of room.peers) sendJson(p, { t: 'start', room: info, you: p.id });
  log(`Raum ${room.code} gestartet: ${room.peers.map((p) => `${p.name}=${p.a3}`).join(', ')} · ${room.mode} · seed ${room.seed} · KI ${room.fillAI ? 'an' : 'aus'}`);
}

function handleChat(c, m) {
  const room = c.room;
  if (!room) return err(c, 'Kein Raum.');
  if (typeof m.text !== 'string') return err(c, 'Ungültige Nachricht.');
  const text = m.text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300);
  if (!text) return;
  const now = Date.now();
  c.chatTimes = c.chatTimes.filter((t) => now - t < 5000);
  if (c.chatTimes.length >= 5) return err(c, 'Zu viele Chatnachrichten – bitte kurz warten.');
  c.chatTimes.push(now);
  const msg = JSON.stringify({ t: 'chat', from: c.name, text });
  for (const p of room.peers) if (p.ws.readyState === 1) p.ws.send(msg);
}

function handleCmd(c, m) {
  const room = c.room;
  if (!room || !room.started) return;
  if (room.hostId === c.id) return err(c, 'Der Host sendet keine Befehle.');
  if (typeof m.method !== 'string' || m.method.length > 64 || !Array.isArray(m.args) || m.args.length > 32) return err(c, 'Ungültiger Befehl.');
  const host = room.peers.find((p) => p.id === room.hostId);
  if (host) sendJson(host, { t: 'cmd', from: c.id, method: m.method, args: m.args });
}

function relayToGuests(room, raw) {
  for (const p of room.peers) {
    if (p.id === room.hostId || p.ws.readyState !== 1) continue;
    if (p.ws.bufferedAmount > SLOW_CLIENT_BYTES) continue; // langsamer Gast: Nachricht verwerfen
    p.ws.send(raw);
  }
}

// ---------------------------------------------------------------- Nachrichtenverarbeitung
function onMessage(c, data, isBinary) {
  const now = Date.now();
  c.lastMsg = now;
  if (isBinary) return err(c, 'Binärnachrichten werden nicht unterstützt.');
  const raw = data.toString();
  const size = raw.length;

  // Schneller Pfad für Snapshots (Host → Gäste): nicht parsen, nur Absender prüfen
  if (size > 12 && raw.startsWith('{"t":"snap"')) {
    const room = c.room;
    if (!room || !room.started || room.hostId !== c.id) return err(c, 'Snapshots dürfen nur vom Host kommen.');
    return relayToGuests(room, raw);
  }

  const isHostBulk = c.room && c.room.hostId === c.id && c.room.started;
  if (size > (isHostBulk ? MAX_EVT_BYTES : MAX_CTRL_BYTES)) return err(c, `Nachricht zu groß (${size} Bytes).`);

  // Rate-Limit (Token-Bucket): Host-Ereignisse sind ausgenommen
  c.tokens = Math.min(400, c.tokens + ((now - c.tokenAt) / 1000) * 120);
  c.tokenAt = now;

  let m;
  try {
    m = JSON.parse(raw);
  } catch {
    return err(c, 'Ungültiges JSON.');
  }
  if (!m || typeof m !== 'object' || typeof m.t !== 'string' || m.t.length > 20) return err(c, 'Ungültige Nachricht.');

  if (m.t === 'evt') {
    const room = c.room;
    if (!room || !room.started || room.hostId !== c.id) return err(c, 'Ereignisse dürfen nur vom Host kommen.');
    if (typeof m.name !== 'string' || m.name.length > 64) return err(c, 'Ungültiges Ereignis.');
    return relayToGuests(room, raw);
  }
  if (!isHostBulk || m.t !== 'ping') {
    if (c.tokens < 1) return; // still verwerfen
    c.tokens -= 1;
  }

  if (m.t === 'hello') {
    if (c.hello) return;
    if (m.protocol !== NET_PROTOCOL) {
      err(c, `Protokoll ${m.protocol} wird nicht unterstützt (Server: ${NET_PROTOCOL}). Bitte Seite neu laden.`);
      return c.ws.close(1002, 'protocol');
    }
    c.name = cleanName(m.name);
    c.hello = true;
    log(`Verbunden: ${c.name} (${c.id}, ${c.ip})`);
    return sendJson(c, { t: 'welcome', id: c.id, protocol: NET_PROTOCOL });
  }
  if (!c.hello) return err(c, 'Erst "hello" senden.');

  switch (m.t) {
    case 'ping':
      return sendJson(c, { t: 'pong', ts: typeof m.ts === 'number' ? m.ts : 0 });
    case 'room:create':
      return handleCreate(c, m);
    case 'room:join':
      return handleJoin(c, m);
    case 'room:leave':
      return leaveRoom(c, 'leave');
    case 'room:slot':
      return handleSlot(c, m);
    case 'room:ready':
      return handleReady(c, m);
    case 'room:config':
      return handleConfig(c, m);
    case 'room:start':
      return handleStart(c);
    case 'chat':
      return handleChat(c, m);
    case 'cmd':
      return handleCmd(c, m);
    case 'snap':
      return err(c, 'Snapshots dürfen nur vom Host kommen.');
    default:
      return err(c, `Unbekannter Nachrichtentyp "${m.t.slice(0, 20)}".`);
  }
}

// ---------------------------------------------------------------- HTTP (statisch + /health)
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.wasm': 'application/wasm', '.map': 'application/json',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, protocol: NET_PROTOCOL, clients: clients.size, rooms: rooms.size, uptime: Math.round(process.uptime()) }));
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end();
  }
  if (!fs.existsSync(DIST)) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('WW3: EUROPE Mehrspieler-Relay läuft. (Kein dist/-Ordner – "npm run build" für statische Auslieferung.)\n');
  }
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  let file = path.normalize(path.join(DIST, rel));
  if (!file.startsWith(DIST)) {
    res.writeHead(403);
    return res.end();
  }
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    const st = fs.statSync(file);
    const ext = path.extname(file).toLowerCase();
    const headers = {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Nicht gefunden\n');
  }
});

// ---------------------------------------------------------------- WebSocket
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });

server.on('upgrade', (req, socket, head) => {
  const p = (req.url || '/').split('?')[0];
  if (p !== '/' && p !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').split(',')[0].trim();
  const n = perIp.get(ip) || 0;
  if (clients.size >= MAX_CLIENTS || n >= MAX_CLIENTS_PER_IP) {
    ws.send(JSON.stringify({ t: 'error', message: 'Server voll oder zu viele Verbindungen von dieser Adresse.' }));
    ws.close(1013, 'busy');
    return;
  }
  perIp.set(ip, n + 1);
  /** @type {Client} */
  const c = {
    id: newId(), ws, ip, name: 'Spieler', hello: false, room: null, a3: null, ready: false, pingMs: undefined,
    lastMsg: Date.now(), lastPingSent: 0, alive: true, tokens: 400, tokenAt: Date.now(), chatTimes: [],
  };
  clients.set(c.id, c);
  ws.on('message', (data, isBinary) => {
    try {
      onMessage(c, data, isBinary);
    } catch (e) {
      warn('Fehler bei Nachricht', e);
    }
  });
  ws.on('pong', () => {
    c.alive = true;
    c.lastMsg = Date.now();
    if (c.lastPingSent) {
      c.pingMs = Math.min(9999, Date.now() - c.lastPingSent);
    }
  });
  ws.on('error', () => {});
  ws.on('close', () => {
    clients.delete(c.id);
    const k = (perIp.get(ip) || 1) - 1;
    if (k <= 0) perIp.delete(ip);
    else perIp.set(ip, k);
    if (c.room) leaveRoom(c, 'disconnect');
    if (c.hello) log(`Getrennt: ${c.name} (${c.id})`);
  });
});

// Heartbeat: WebSocket-Ping (misst RTT), Idle-Timeout, Raum-Updates mit Ping-Werten
setInterval(() => {
  const now = Date.now();
  for (const c of clients.values()) {
    if (!c.alive || now - c.lastMsg > IDLE_TIMEOUT_MS) {
      warn(`Timeout: ${c.name} (${c.id})`);
      c.ws.terminate();
      continue;
    }
    c.alive = false;
    c.lastPingSent = now;
    try {
      c.ws.ping();
    } catch {
      /* ignorieren */
    }
  }
  for (const room of rooms.values()) if (!room.started && now - room.lastBroadcast > HEARTBEAT_MS - 100) broadcastRoom(room);
}, HEARTBEAT_MS).unref?.();
// (unref nicht nötig – der HTTP-Server hält den Prozess am Leben)

server.listen(PORT, HOST, () => {
  log(`WW3: EUROPE Relay auf http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (WebSocket: /ws)`);
  log(fs.existsSync(DIST) ? `Statische Dateien aus ${DIST}` : `Kein dist/-Ordner gefunden (${DIST}) – nur Relay`);
});

function shutdown() {
  log('Beende …');
  for (const c of clients.values()) c.ws.close(1001, 'shutdown');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
