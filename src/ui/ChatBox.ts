import type { MpTransport } from '../net/MultiplayerSession';
import { getProfile } from '../game/countryData';

const MAX_LINES = 6;
const LINE_TTL_S = 14;

/**
 * Mehrspieler-Chat im Spiel: Eingabe mit Enter öffnen, Enter sendet, Esc schließt. Nachrichten laufen über den
 * Lobby-Kanal des Transports (Host verteilt an alle) und erscheinen als kurze Zeilen unten links (blenden nach einigen
 * Sekunden aus).
 */
export class ChatBox {
  private readonly el: HTMLDivElement;
  private readonly log: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private readonly lines: Array<{ el: HTMLDivElement; ttl: number }> = [];
  private offs: Array<() => void> = [];
  private transport: MpTransport | null = null;
  private colorOf: (name: string) => string = () => '';

  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'chat-box hidden';
    this.log = document.createElement('div');
    this.log.className = 'chat-log';
    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.className = 'chat-input hidden';
    this.input.maxLength = 200;
    this.input.placeholder = 'Nachricht an alle … (Enter: senden, Esc: schließen)';
    this.input.spellcheck = false;
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const t = this.input.value.trim();
        if (t) this.transport?.sendChat(t);
        this.input.value = '';
        this.closeInput();
      } else if (e.key === 'Escape') {
        this.input.value = '';
        this.closeInput();
      }
    });
    this.input.addEventListener('keyup', (e) => e.stopPropagation());
    this.input.addEventListener('blur', () => this.closeInput());
    this.el.append(this.log, this.input);
    root.appendChild(this.el);
  }

  /** Beim Spielstart (Mehrspieler) aufrufen; nameColor liefert die Teamfarbe zum Spielernamen (oder '') */
  attach(t: MpTransport, nameColor: (name: string) => string): void {
    this.detach();
    this.transport = t;
    this.colorOf = nameColor;
    this.el.classList.remove('hidden');
    this.offs.push(t.on('chat', (from, text) => this.add(from, text)));
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Enter' && e.code !== 'NumpadEnter') return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      const tg = e.target as HTMLElement | null;
      if (tg && (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA' || tg.isContentEditable)) return;
      if (document.querySelector('.modal-backdrop:not(.hidden)')) return;
      e.preventDefault();
      e.stopPropagation();
      this.openInput();
    };
    window.addEventListener('keydown', onKey, true);
    this.offs.push(() => window.removeEventListener('keydown', onKey, true));
  }

  detach(): void {
    for (const o of this.offs) o();
    this.offs = [];
    this.transport = null;
    this.el.classList.add('hidden');
    this.log.replaceChildren();
    this.lines.length = 0;
    this.closeInput();
  }

  private openInput(): void {
    this.input.classList.remove('hidden');
    this.el.classList.add('typing');
    this.input.focus();
    for (const l of this.lines) l.el.classList.remove('faded');
  }

  private closeInput(): void {
    if (this.input.classList.contains('hidden')) return;
    this.input.classList.add('hidden');
    this.el.classList.remove('typing');
    if (document.activeElement === this.input) this.input.blur();
  }

  private add(from: string, text: string): void {
    const row = document.createElement('div');
    row.className = 'chat-line';
    const n = document.createElement('b');
    n.textContent = from + ': ';
    const c = this.colorOf(from);
    if (c) n.style.color = c;
    const m = document.createElement('span');
    m.textContent = text;
    row.append(n, m);
    this.log.appendChild(row);
    this.lines.push({ el: row, ttl: LINE_TTL_S });
    while (this.lines.length > MAX_LINES) this.lines.shift()!.el.remove();
  }

  /** pro Frame (echtes dt in s) */
  update(dt: number): void {
    if (!this.lines.length || this.el.classList.contains('typing')) return;
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const l = this.lines[i];
      l.ttl -= dt;
      if (l.ttl <= 0) {
        l.el.remove();
        this.lines.splice(i, 1);
      } else if (l.ttl < 2) l.el.classList.add('faded');
    }
  }
}

/** Teamfarbe der Nation (Profilfarbe) */
export function nationColorOf(a3: string): string {
  return getProfile(a3)?.color ?? '';
}
