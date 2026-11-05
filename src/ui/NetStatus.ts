import type { NetGame } from '../net/NetGame';
import type { MpStartInfo } from '../net/MultiplayerSession';
import { getProfile } from '../game/countryData';

/**
 * Mehrspieler-Anzeige: Spielerliste mit Teamfarben (rechts unter der Kopfleiste), Verbindungsanzeige (Ping, „keine Daten“)
 * und ein Hinweisbanner mit Knopf „Zurück zum Hauptmenü“, wenn der Host die Verbindung verliert.
 */
export class NetStatus {
  private readonly panel: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private readonly conn: HTMLSpanElement;
  private readonly lostBanner: HTMLDivElement;
  private net: NetGame | null = null;
  private acc = 0;
  private lastSig = '';

  constructor(root: HTMLElement) {
    this.panel = document.createElement('div');
    this.panel.className = 'panel net-panel hidden';
    const head = document.createElement('div');
    head.className = 'panel-head';
    const t = document.createElement('span');
    t.textContent = 'Mehrspieler';
    this.conn = document.createElement('span');
    this.conn.className = 'net-conn';
    head.append(t, this.conn);
    this.list = document.createElement('div');
    this.list.className = 'net-list';
    this.panel.append(head, this.list);

    this.lostBanner = document.createElement('div');
    this.lostBanner.className = 'panel net-lost hidden';
    const msg = document.createElement('div');
    msg.className = 'net-lost-msg';
    msg.textContent = 'Verbindung zum Host verloren – das Spiel läuft nicht mehr weiter.';
    const b = document.createElement('button');
    b.className = 'btn btn-primary';
    b.textContent = 'Zurück zum Hauptmenü';
    b.addEventListener('click', () => location.reload());
    this.lostBanner.append(msg, b);
    root.append(this.panel, this.lostBanner);
  }

  attach(net: NetGame, info: MpStartInfo): void {
    this.net = net;
    this.lastSig = '';
    this.lostBanner.classList.add('hidden');
    this.panel.classList.remove('hidden');
    this.list.replaceChildren();
    const me = info.selfA3;
    const allies = (a: string) => a === me || info.alliances.some(([x, y]) => (x === me && y === a) || (y === me && x === a));
    const row = (name: string, a3: string, tag: string) => {
      const r = document.createElement('div');
      r.className = 'net-row';
      const sw = document.createElement('i');
      sw.className = 'swatch';
      sw.style.background = getProfile(a3)?.color ?? '#888';
      const n = document.createElement('span');
      n.className = 'net-name';
      n.textContent = name;
      const tg = document.createElement('span');
      tg.className = 'net-tag ' + (allies(a3) ? 'ally' : 'foe');
      tg.textContent = tag;
      r.append(sw, n, tg);
      this.list.appendChild(r);
    };
    for (const p of info.players) {
      const team = info.mode === 'ffa' ? '' : allies(p.a3) ? 'Team' : 'Gegner';
      row(`${p.name}${p.id === info.selfId ? ' (du)' : ''} · ${getProfile(p.a3)?.short ?? p.a3}`, p.a3, team);
    }
    for (const a of info.aiNations) row(`KI · ${getProfile(a)?.short ?? a}`, a, info.mode === 'ffa' ? '' : allies(a) ? 'Team' : 'Gegner');
  }

  detach(): void {
    this.net = null;
    this.panel.classList.add('hidden');
    this.lostBanner.classList.add('hidden');
  }

  setConnection(connected: boolean): void {
    this.lostBanner.classList.toggle('hidden', connected);
  }

  update(dt: number): void {
    const n = this.net;
    if (!n) return;
    this.acc += dt;
    if (this.acc < 0.5) return;
    this.acc = 0;
    let text = '', cls = 'good';
    if (n.isHost) text = 'HOST';
    else if (!n.connected) { text = 'GETRENNT'; cls = 'bad'; }
    else if (!n.synced) { text = 'SYNC …'; cls = 'warn'; }
    else if (n.stalled) { text = 'KEINE DATEN'; cls = 'bad'; }
    else {
      const r = Math.round(n.rttMs);
      text = r > 0 ? `PING ${r} ms` : 'VERBUNDEN';
      cls = r > 250 ? 'warn' : 'good';
    }
    const sig = text + cls;
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    this.conn.textContent = text;
    this.conn.className = `net-conn ${cls}`;
  }
}
