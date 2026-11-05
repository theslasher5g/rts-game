import type { GameState } from '../game/GameState';

/**
 * Grenzschutz-Anzeige: Solange der Grenzschutz läuft, zeigt ein Banner unter der Kopfleiste den Countdown.
 * Während dieser Zeit sind die Grenzen gesperrt und es wird nicht gekämpft (siehe War.ceasefire / UnitManager.borderClosed).
 */
export class ProtectBanner {
  private readonly el: HTMLDivElement;
  private shown = false;
  private lastText = '';

  constructor(root: HTMLElement, private readonly state: GameState) {
    this.el = document.createElement('div');
    this.el.className = 'protect-banner';
    this.el.style.cssText =
      'position:absolute;top:44px;left:50%;transform:translateX(-50%);z-index:20;display:none;pointer-events:none;' +
      "font:12px/1.2 'Share Tech Mono',monospace;letter-spacing:.12em;text-transform:uppercase;color:#f0d98a;" +
      'background:rgba(30,32,22,.88);border:1px solid #b89a3c;padding:5px 14px;text-align:center;max-width:max(300px,calc(100vw - 660px));box-shadow:0 2px 10px rgba(0,0,0,.5);';
    root.appendChild(this.el);
  }

  update(): void {
    const left = this.state.borderProtectSec;
    const on = left > 0 && !!this.state.playerA3;
    if (on !== this.shown) {
      this.shown = on;
      this.el.style.display = on ? 'block' : 'none';
    }
    if (!on) return;
    const s = Math.ceil(left);
    const text = `Grenzschutz  ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}  ·  Grenzen gesperrt, kein Gefecht`;
    if (text !== this.lastText) {
      this.lastText = text;
      this.el.textContent = text;
    }
  }
}
