import './lobby.css';
import { getProfile } from '../game/countryData';
import { MP_TEAMS, SCENARIO_NATIONS } from '../game/scenario';
import { MAX_PLAYERS, type ConnStatus, type PeerInfo, type RoomInfo } from '../net/index';
import { WsTransport } from '../net/WsTransport';
import { MultiplayerSession, createLobbyClient, type LobbyKind, type MpStartInfo, type MpTransport } from '../net/MultiplayerSession';

const KEY_NAME = 'ww3.mpName';
const KEY_URL = 'ww3.mpUrl';
const KEY_KIND = 'ww3.mpKind';

const STATUS_TEXT: Record<ConnStatus, string> = {
  idle: 'NICHT VERBUNDEN',
  connecting: 'VERBINDE …',
  open: 'VERBUNDEN',
  reconnecting: 'NEUVERBINDUNG …',
  closed: 'GETRENNT',
};

/**
 * Modal „Mehrspieler“: Schritt 1 = Verbindung (Server-URL oder lokaler 2-Tab-Test), Schritt 2 = Raum mit vier Spieler-Plätzen,
 * Nationenwahl, Host-Einstellungen, Chat. Beim Start erzeugt die zugehörige MultiplayerSession 'game:start' (mit `mp`).
 */
export class LobbyPanel {
  private readonly backdrop: HTMLDivElement;
  private readonly statusEl: HTMLSpanElement;
  private readonly stepConnect: HTMLDivElement;
  private readonly stepRoom: HTMLDivElement;
  private readonly toastEl: HTMLDivElement;

  // Schritt 1
  private readonly kindBtns = new Map<LobbyKind, HTMLButtonElement>();
  private readonly urlRow: HTMLDivElement;
  private readonly urlInput: HTMLInputElement;
  private readonly nameInput: HTMLInputElement;
  private readonly codeInput: HTMLInputElement;
  private readonly createBtn: HTMLButtonElement;
  private readonly joinBtn: HTMLButtonElement;
  private readonly connNote: HTMLDivElement;

  // Schritt 2
  private readonly slotsEl: HTMLDivElement;
  private readonly codeEl: HTMLSpanElement;
  private readonly inviteEl: HTMLDivElement;
  private readonly hostBox: HTMLDivElement;
  private readonly modeBtns = new Map<string, HTMLButtonElement>();
  private readonly aiCheck: HTMLInputElement;
  private readonly seedInput: HTMLInputElement;
  private readonly guestInfo: HTMLDivElement;
  private readonly readyBtn: HTMLButtonElement;
  private readonly startBtn: HTMLButtonElement;
  private readonly startHint: HTMLDivElement;
  private readonly chatLog: HTMLDivElement;
  private readonly chatInput: HTMLInputElement;

  private kind: LobbyKind = 'ws';
  private transport: MpTransport | null = null;
  private offs: Array<() => void> = [];
  private busy = false;
  private lastKey = '';
  private readonly pingEls = new Map<string, HTMLSpanElement>();
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  /** aktuelle Sitzung (nach Verbindungsaufbau) */
  session: MultiplayerSession | null = null;
  /** Wird beim Start des Mehrspielerspiels aufgerufen (Lobby schließt sich selbst). 'game:start' wurde bereits gesendet. */
  onStart: ((info: MpStartInfo) => void) | null = null;

  constructor(root: HTMLElement) {
    this.backdrop = div('modal-backdrop lobby-backdrop hidden');
    const modal = div('panel modal lobby-modal');

    const head = div('panel-head');
    this.statusEl = span('lb-status muted', STATUS_TEXT.idle);
    const x = button('btn btn-sm', '✕');
    x.title = 'Schließen (Raum bleibt bestehen)';
    x.addEventListener('click', () => this.close());
    head.append(span('', 'Mehrspieler'), this.statusEl, x);

    const body = div('lb-body');
    this.toastEl = div('lb-toast hidden');

    // ---------------- Schritt 1: Verbindung
    this.stepConnect = div('lb-connect');
    const modeRow = div('lb-kind');
    const mkKind = (k: LobbyKind, label: string) => {
      const b = button('btn', label);
      b.addEventListener('click', () => this.setKind(k));
      this.kindBtns.set(k, b);
      modeRow.appendChild(b);
    };
    mkKind('ws', 'Server (Internet / LAN)');
    mkKind('broadcast', 'Lokaler Test (2 Tabs)');

    this.urlRow = div('lb-field');
    this.urlRow.append(span('lb-label', 'SERVER-ADRESSE'));
    this.urlInput = input('text', 120);
    this.urlInput.placeholder = WsTransport.defaultUrl();
    this.urlRow.appendChild(this.urlInput);

    const nameRow = div('lb-field');
    nameRow.append(span('lb-label', 'SPIELERNAME'));
    this.nameInput = input('text', 20);
    this.nameInput.placeholder = 'Kommandant';
    nameRow.appendChild(this.nameInput);

    const actions = div('lb-actions');
    this.createBtn = button('btn btn-primary', '＋ Raum erstellen');
    this.createBtn.addEventListener('click', () => void this.connectThen('create'));
    const joinBox = div('lb-join');
    this.codeInput = input('text', 6);
    this.codeInput.className = 'lb-code-input';
    this.codeInput.placeholder = 'CODE';
    this.codeInput.addEventListener('input', () => {
      this.codeInput.value = this.codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    });
    this.codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void this.connectThen('join');
    });
    this.joinBtn = button('btn', '→ Beitreten');
    this.joinBtn.addEventListener('click', () => void this.connectThen('join'));
    joinBox.append(this.codeInput, this.joinBtn);
    actions.append(this.createBtn, joinBox);

    this.connNote = div('lb-note');
    this.stepConnect.append(modeRow, this.urlRow, nameRow, actions, this.connNote);

    // ---------------- Schritt 2: Raum
    this.stepRoom = div('lb-room hidden');
    const left = div('lb-left');
    this.slotsEl = div('lb-slots');
    left.appendChild(this.slotsEl);

    const right = div('lb-right');

    const codeBox = div('lb-codebox');
    codeBox.append(span('lb-label', 'RAUMCODE'));
    this.codeEl = span('lb-code', '------');
    const copy = button('btn btn-sm', '⧉ Kopieren');
    copy.addEventListener('click', () => this.copyCode());
    codeBox.append(this.codeEl, copy);
    this.inviteEl = div('lb-note');

    this.hostBox = div('lb-host');
    this.hostBox.append(span('lb-label', 'HOST-EINSTELLUNGEN'));
    const modeRow2 = div('lb-modes');
    const mkMode = (m: 'teams' | 'ffa', label: string) => {
      const b = button('btn btn-sm', label);
      b.addEventListener('click', () => this.transport?.configure({ mode: m }));
      this.modeBtns.set(m, b);
      modeRow2.appendChild(b);
    };
    mkMode('teams', '2 gegen 2');
    mkMode('ffa', 'Jeder gegen jeden');
    const aiRow = el('label', 'lb-check');
    this.aiCheck = document.createElement('input');
    this.aiCheck.type = 'checkbox';
    this.aiCheck.addEventListener('change', () => this.transport?.configure({ fillAI: this.aiCheck.checked }));
    aiRow.append(this.aiCheck, span('', 'Leere Plätze mit KI füllen'));
    const seedRow = div('lb-seed');
    seedRow.append(span('lb-label', 'KARTEN-SEED'));
    this.seedInput = input('text', 10);
    this.seedInput.inputMode = 'numeric';
    this.seedInput.addEventListener('change', () => this.commitSeed());
    this.seedInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.commitSeed();
    });
    const rnd = button('btn btn-sm', '🎲');
    rnd.title = 'Zufälliger Seed';
    rnd.addEventListener('click', () => {
      this.seedInput.value = String(Math.floor(Math.random() * 1_000_000));
      this.commitSeed();
    });
    seedRow.append(this.seedInput, rnd);
    this.hostBox.append(modeRow2, aiRow, seedRow);

    this.guestInfo = div('lb-note lb-guestinfo');

    const chat = div('lb-chat');
    this.chatLog = div('lb-chatlog scroll');
    this.chatInput = input('text', 300);
    this.chatInput.placeholder = 'Nachricht …';
    this.chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const t = this.chatInput.value.trim();
        if (t) this.transport?.sendChat(t);
        this.chatInput.value = '';
      }
    });
    chat.append(this.chatLog, this.chatInput);

    const foot = div('lb-foot');
    const leave = button('btn', '⏏ Raum verlassen');
    leave.addEventListener('click', () => this.leave());
    this.readyBtn = button('btn', '✔ Bereit');
    this.readyBtn.addEventListener('click', () => {
      const me = this.transport?.self;
      this.transport?.setReady(!me?.ready);
    });
    this.startBtn = button('btn btn-primary', '▶ Spiel starten');
    this.startBtn.addEventListener('click', () => this.transport?.startGame());
    this.startHint = div('lb-starthint');
    foot.append(leave, this.startHint, this.readyBtn, this.startBtn);

    right.append(codeBox, this.inviteEl, this.hostBox, this.guestInfo, chat);
    this.stepRoom.append(left, right, foot);

    body.append(this.stepConnect, this.stepRoom, this.toastEl);
    modal.append(head, body);
    this.backdrop.appendChild(modal);
    this.backdrop.addEventListener('click', (e) => {
      if (e.target === this.backdrop) this.close();
    });
    // Tasten im Modal dürfen keine Spiel-Hotkeys auslösen
    for (const ev of ['keydown', 'keyup'] as const) {
      this.backdrop.addEventListener(ev, (e) => {
        if (e.target instanceof HTMLInputElement && e.key !== 'Escape') e.stopPropagation();
      });
    }
    root.appendChild(this.backdrop);

    // gespeicherte Werte
    this.nameInput.value = load(KEY_NAME) || '';
    this.urlInput.value = load(KEY_URL) || '';
    const k = load(KEY_KIND);
    this.setKind(k === 'broadcast' ? 'broadcast' : 'ws');
    this.renderStep();
  }

  get isOpen(): boolean {
    return !this.backdrop.classList.contains('hidden');
  }

  open(): void {
    this.backdrop.classList.remove('hidden');
    this.renderStep();
    if (!this.transport?.room) (this.nameInput.value ? this.createBtn : this.nameInput).focus();
  }

  close(): void {
    this.backdrop.classList.add('hidden');
  }

  // ------------------------------------------------------------------ Schritt 1
  private setKind(k: LobbyKind): void {
    if (this.transport && this.kind !== k) this.teardown();
    this.kind = k;
    save(KEY_KIND, k);
    for (const [kk, b] of this.kindBtns) b.classList.toggle('active', kk === k);
    this.urlRow.classList.toggle('hidden', k !== 'ws');
    this.connNote.textContent =
      k === 'ws'
        ? 'Starte den Server mit „npm run server“ (Port 8787). Im Dev-Modus genügt die Standardadresse, sie läuft über den Vite-Proxy.'
        : 'Ohne Server: Öffne das Spiel in einem zweiten Tab (gleicher Browser). Der Tab, der den Raum erstellt, ist Host.';
  }

  private async connectThen(action: 'create' | 'join'): Promise<void> {
    if (this.busy) return;
    const name = this.nameInput.value.trim() || 'Kommandant';
    const code = this.codeInput.value.trim().toUpperCase();
    if (action === 'join' && code.length !== 6) return this.toast('Bitte den 6-stelligen Raumcode eingeben.');
    this.busy = true;
    this.createBtn.disabled = this.joinBtn.disabled = true;
    save(KEY_NAME, this.nameInput.value.trim());
    try {
      if (!this.transport || this.transport.status !== 'open') await this.connect(name);
      const t = this.transport!;
      if (action === 'create') {
        const seed = Math.floor(Math.random() * 1_000_000);
        await t.createRoom({ scenario: 'adria-nord', seed, fillAI: true, mode: 'teams' });
      } else {
        await t.joinRoom(code);
      }
    } catch (e) {
      this.toast(e instanceof Error ? e.message : String(e));
      if (this.transport && !this.transport.room && this.transport.status !== 'open') this.teardown();
    } finally {
      this.busy = false;
      this.createBtn.disabled = this.joinBtn.disabled = false;
      this.renderStep();
    }
  }

  private async connect(name: string): Promise<void> {
    this.teardown();
    const t = createLobbyClient(this.kind);
    this.transport = t;
    this.attach(t);
    if (this.kind === 'broadcast') {
      await t.connect('', name);
      return;
    }
    const typed = this.urlInput.value.trim();
    save(KEY_URL, typed);
    const candidates = typed ? [typed] : [WsTransport.defaultUrl(), WsTransport.directUrl()];
    let lastErr: unknown = null;
    for (const url of candidates) {
      try {
        await t.connect(url, name);
        return;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('Server nicht erreichbar.');
  }

  private attach(t: MpTransport): void {
    this.session = new MultiplayerSession({ transport: t });
    this.session.onStart((info) => {
      this.close();
      this.onStart?.(info);
    });
    this.offs.push(
      t.on('room', () => this.renderStep()),
      t.on('status', (s) => this.setStatus(s)),
      t.on('error', (m) => this.toast(m)),
      t.on('chat', (from, text) => this.addChat(from, text)),
      t.on('disconnected', (r) => {
        this.toast(r);
        this.renderStep();
      }),
    );
    this.setStatus(t.status);
  }

  private teardown(): void {
    for (const o of this.offs) o();
    this.offs = [];
    this.session?.dispose();
    this.session = null;
    this.transport?.disconnect();
    this.transport = null;
    this.chatLog.textContent = '';
    this.setStatus('idle');
  }

  private leave(): void {
    this.transport?.leaveRoom();
    this.chatLog.textContent = '';
    this.renderStep();
  }

  private setStatus(s: ConnStatus): void {
    this.statusEl.textContent = STATUS_TEXT[s];
    this.statusEl.className = 'lb-status ' + (s === 'open' ? 'ok' : s === 'closed' ? 'bad' : 'muted');
  }

  // ------------------------------------------------------------------ Schritt 2
  private renderStep(): void {
    const room = this.transport?.room ?? null;
    this.stepConnect.classList.toggle('hidden', !!room);
    this.stepRoom.classList.toggle('hidden', !room);
    if (!room) this.lastKey = '';
    if (room) this.renderRoom(room);
  }

  private renderRoom(room: RoomInfo): void {
    const t = this.transport!;
    // Nur neu aufbauen, wenn sich etwas Sichtbares außer den Ping-Werten geändert hat (sonst gehen Klicks verloren)
    const key = JSON.stringify({ ...room, peers: room.peers.map((p) => ({ ...p, pingMs: 0 })), self: t.selfId });
    if (key === this.lastKey) {
      for (const p of room.peers) {
        const e = this.pingEls.get(p.id);
        if (e) e.textContent = this.pingText(p, p.id === t.selfId);
      }
      return;
    }
    this.lastKey = key;
    this.pingEls.clear();
    const selfId = t.selfId;
    const isHost = room.hostId === selfId;
    const me = room.peers.find((p) => p.id === selfId) ?? null;

    this.codeEl.textContent = room.code;
    const addr = this.kind === 'ws' ? (this.urlInput.value.trim() || WsTransport.defaultUrl()) : null;
    this.inviteEl.textContent =
      this.kind === 'ws'
        ? `Teile den Code und die Adresse: ${addr?.replace(/^wss?:\/\//, '')}`
        : 'Öffne das Spiel in einem zweiten Tab, wähle „Mehrspieler“ → „Lokaler Test“ und gib den Code ein.';

    // Slots
    this.slotsEl.textContent = '';
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const p = room.peers[i];
      this.slotsEl.appendChild(p ? this.peerCard(room, p, p.id === selfId) : this.emptyCard(room, i));
    }

    // Host-Bereich
    this.hostBox.classList.toggle('hidden', !isHost);
    this.guestInfo.classList.toggle('hidden', isHost);
    if (!isHost) {
      this.guestInfo.textContent = `Modus: ${room.mode === 'teams' ? '2 gegen 2' : 'Jeder gegen jeden'} · KI-Füllung: ${room.fillAI ? 'an' : 'aus'} · Seed ${room.seed}`;
    } else {
      for (const [m, b] of this.modeBtns) b.classList.toggle('active', m === room.mode);
      this.aiCheck.checked = room.fillAI;
      if (document.activeElement !== this.seedInput) this.seedInput.value = String(room.seed);
    }

    // Fuß
    const allNation = room.peers.every((p) => !!p.a3);
    const allReady = room.peers.every((p) => p.host || p.ready);
    this.readyBtn.classList.toggle('hidden', isHost);
    this.startBtn.classList.toggle('hidden', !isHost);
    this.readyBtn.disabled = !me?.a3;
    this.readyBtn.classList.toggle('active', !!me?.ready);
    this.readyBtn.textContent = me?.ready ? '✔ Bereit (abbrechen)' : '✔ Bereit';
    this.startBtn.disabled = !(isHost && allNation && allReady);
    this.startHint.textContent = !allNation
      ? 'Alle Spieler müssen eine Nation wählen.'
      : !allReady
        ? 'Warte, bis alle bereit sind …'
        : isHost
          ? 'Alle bereit – Spiel kann starten.'
          : 'Warte auf den Host …';
  }

  private pingText(p: PeerInfo, isSelf: boolean): string {
    if (p.pingMs !== undefined) return `${p.pingMs} ms`;
    return isSelf && this.transport && this.transport.latency ? `${this.transport.latency} ms` : '';
  }

  private emptyCard(room: RoomInfo, i: number): HTMLDivElement {
    const c = div('lb-slot empty');
    c.append(div('lb-slot-no', `PLATZ ${i + 1}`), div('lb-pname', 'Frei'), div('lb-nat-sub', room.fillAI ? 'Nicht gewählte Nationen übernimmt die KI.' : 'Wartet auf Spieler …'));
    return c;
  }

  private peerCard(room: RoomInfo, p: PeerInfo, isSelf: boolean): HTMLDivElement {
    const nat = p.a3 ? SCENARIO_NATIONS.find((n) => n.a3 === p.a3) : undefined;
    const c = div('lb-slot' + (isSelf ? ' self' : '') + (nat ? ' has-nat' : ''));
    if (nat) c.style.setProperty('--nation', nat.color);

    const top = div('lb-slot-top');
    const crown = span('lb-crown', p.host ? '♛' : '');
    crown.title = p.host ? 'Host' : '';
    const name = span('lb-pname', p.name + (isSelf ? ' (du)' : ''));
    const ping = span('lb-ping muted', this.pingText(p, isSelf));
    this.pingEls.set(p.id, ping);
    const ready = span('lb-ready' + (p.ready || p.host ? ' on' : ''), p.ready || p.host ? '✔' : '○');
    ready.title = p.host ? 'Host' : p.ready ? 'Bereit' : 'Nicht bereit';
    top.append(crown, name, ping, ready);
    c.appendChild(top);

    // gewählte Nation
    const info = div('lb-nat');
    if (nat) {
      const prof = getProfile(nat.a3);
      const head = div('lb-nat-head');
      head.append(span('lb-flag', prof?.flag ?? '■'), span('lb-nat-name', nat.name));
      if (prof) head.append(span(`mm-diff diff-${prof.difficulty}`, prof.difficulty));
      info.append(head, div('lb-nat-sub', this.teamText(room, nat.a3) + (prof ? ` · ${prof.blurb}` : '')));
    } else {
      info.append(div('lb-nat-head muted', 'Keine Nation gewählt'));
    }
    c.appendChild(info);

    // Nationenwahl (nur für den eigenen Platz)
    if (isSelf) {
      const pick = div('lb-pick');
      for (const n of SCENARIO_NATIONS) {
        if (!n.playable) continue;
        const owner = room.peers.find((q) => q.a3 === n.a3);
        const taken = !!owner && owner.id !== p.id;
        const b = button('lb-nat-btn' + (p.a3 === n.a3 ? ' active' : ''), '');
        b.style.setProperty('--nation', n.color);
        b.append(span('lb-dot', ''), span('', n.short));
        b.disabled = taken;
        b.title = taken ? `${n.name} – vergeben an ${owner!.name}` : n.name;
        b.addEventListener('click', () => this.transport?.setSlot(p.a3 === n.a3 ? null : n.a3));
        pick.appendChild(b);
      }
      c.appendChild(pick);
    }
    return c;
  }

  private teamText(room: RoomInfo, a3: string): string {
    if (room.mode !== 'teams') return 'Jeder gegen jeden';
    const idx = MP_TEAMS.findIndex((t) => t.includes(a3));
    return idx >= 0 ? `Team ${idx + 1}` : '';
  }

  // ------------------------------------------------------------------ Hilfen
  private commitSeed(): void {
    const n = Math.floor(Number(this.seedInput.value.trim()));
    if (Number.isFinite(n) && n >= 0 && n <= 4294967295) this.transport?.configure({ seed: n });
    else this.toast('Ungültiger Seed.');
    const r = this.transport?.room;
    if (r) this.seedInput.value = String(r.seed);
  }

  private copyCode(): void {
    const code = this.transport?.room?.code;
    if (!code) return;
    const done = () => this.toast(`Code ${code} kopiert.`, 'info');
    try {
      void navigator.clipboard.writeText(code).then(done, () => this.toast(`Code: ${code}`, 'info'));
    } catch {
      this.toast(`Code: ${code}`, 'info');
    }
  }

  private addChat(from: string, text: string): void {
    const line = div('lb-chatline');
    line.append(span('lb-chatfrom', from + ': '), span('', text));
    this.chatLog.appendChild(line);
    while (this.chatLog.childElementCount > 80) this.chatLog.firstElementChild?.remove();
    this.chatLog.scrollTop = this.chatLog.scrollHeight;
  }

  private toast(msg: string, kind: 'error' | 'info' = 'error'): void {
    this.toastEl.textContent = msg;
    this.toastEl.className = 'lb-toast ' + kind;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toastEl.classList.add('hidden'), 4500);
  }
}

// ---------------------------------------------------------------------- DOM-Helfer
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function div(cls: string, text?: string): HTMLDivElement {
  return el('div', cls, text);
}
function span(cls: string, text?: string): HTMLSpanElement {
  return el('span', cls, text);
}
function button(cls: string, text: string): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  return b;
}
function input(type: string, maxLength: number): HTMLInputElement {
  const i = document.createElement('input');
  i.type = type;
  i.maxLength = maxLength;
  i.spellcheck = false;
  i.autocomplete = 'off';
  return i;
}
function load(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function save(k: string, v: string): void {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignorieren */
  }
}
