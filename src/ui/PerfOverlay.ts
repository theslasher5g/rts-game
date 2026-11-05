import type * as THREE from 'three';
import { bus } from '../core/EventBus';
import { perf } from '../core/perf';
import { Q, QUALITY_LEVELS } from '../core/quality';

export interface PerfSources {
  renderer: THREE.WebGLRenderer;
  /** Instanzzahlen für die Anzeige: Name -> Wert */
  counts: () => Record<string, number>;
  /** Spielt gerade eine Partie? (Qualitäts-Vorschlag nur im Spiel) */
  inGame: () => boolean;
}

/**
 * FPS-/Performance-Overlay. Umschalten mit Strg+Umschalt+P (oder Einstellung „FPS anzeigen“).
 * Zeigt FPS, Framezeit (Mittel/Spitze über 2 s), JS-Zeit je Phase, Draw Calls, Dreiecke, Instanzen, Heap.
 * Schlägt bei FPS < 24 über 5 s eine niedrigere Grafikqualität vor (nur Hinweis, kein automatischer Wechsel).
 */
export class PerfOverlay {
  private readonly el: HTMLDivElement;
  private readonly pre: HTMLPreElement;
  private visible = false;
  private acc = 0;
  private lowSince = 0;
  private suggestedFor = '';
  private readonly src: PerfSources;

  constructor(root: HTMLElement, src: PerfSources) {
    this.src = src;
    this.el = document.createElement('div');
    this.el.className = 'perf-overlay';
    this.el.style.cssText =
      'position:absolute;left:8px;top:8px;z-index:70;display:none;pointer-events:none;padding:6px 8px;' +
      "background:rgba(8,10,6,.72);color:#cfe8a8;font:11px/1.35 'Share Tech Mono',monospace;border:1px solid rgba(160,190,110,.35);";
    this.pre = document.createElement('pre');
    this.pre.style.cssText = 'margin:0;font:inherit;white-space:pre;';
    this.el.appendChild(this.pre);
    root.appendChild(this.el);
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === 'KeyP') {
          e.preventDefault();
          e.stopImmediatePropagation();
          this.setVisible(!this.visible);
        }
      },
      true,
    );
  }

  get isVisible(): boolean {
    return this.visible;
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.el.style.display = v ? '' : 'none';
    if (v) this.refresh();
  }

  /** je Frame aufrufen (nach dem Rendern); `dt` in Sekunden */
  update(dt: number): void {
    this.acc += dt;
    // Vorschlag (läuft auch bei verstecktem Overlay)
    const snap = this.acc >= 0.5 ? perf.snapshot() : null;
    if (snap) {
      if (this.src.inGame() && Q.level !== 'niedrig' && snap.fps > 0 && snap.fps < 24) {
        this.lowSince += this.acc;
        if (this.lowSince >= 5 && this.suggestedFor !== Q.level) {
          this.suggestedFor = Q.level;
          const lower = QUALITY_LEVELS[QUALITY_LEVELS.indexOf(Q.level) - 1];
          bus.emit('toast', { msg: `Niedrige Bildrate (${snap.fps.toFixed(0)} FPS): Grafikqualität „${lower}“ in den Einstellungen wählen`, kind: 'warn' });
        }
      } else this.lowSince = 0;
    }
    if (!this.visible || this.acc < 0.5) return;
    this.acc = 0;
    this.refresh();
    perf.decayMax();
  }

  private refresh(): void {
    const s = perf.snapshot();
    const info = this.src.renderer.info;
    const L: string[] = [];
    L.push(`${s.fps.toFixed(0).padStart(3)} FPS  ${s.avgMs.toFixed(1)} ms avg  ${s.worstMs.toFixed(1)} ms worst  [${Q.level}]`);
    L.push(`JS ${s.jsMs.toFixed(1)} ms/Frame`);
    for (const p of s.phases.slice(0, 10)) L.push(`  ${p.label.padEnd(10)} ${p.avg.toFixed(2).padStart(6)}  max ${p.max.toFixed(1)}`);
    L.push(`Draw ${info.render.calls}  Tris ${(info.render.triangles / 1000).toFixed(0)}k  Geo ${info.memory.geometries}  Tex ${info.memory.textures}`);
    const c = this.src.counts();
    L.push(Object.entries(c).map(([k, v]) => `${k} ${v >= 10000 ? (v / 1000).toFixed(0) + 'k' : v}`).join('  '));
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    if (mem) L.push(`Heap ${(mem.usedJSHeapSize / 1048576).toFixed(0)} MB`);
    this.pre.textContent = L.join('\n');
  }
}
