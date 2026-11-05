/**
 * Winziger Frame-Profiler: `perf.frame(now)` am Frame-Anfang, danach `perf.mark('label')` am ENDE jedes Abschnitts –
 * die Zeit seit der vorigen Marke wird dem Label zugeschlagen (JS-Zeit; GPU-Arbeit ist hier NICHT enthalten).
 * Kosten: ein `performance.now()` je Marke (~0,05 µs … 1 µs).
 */

const WINDOW_MS = 2000;

interface Phase {
  /** gleitender Mittelwert (ms) */
  avg: number;
  /** größter Wert im aktuellen Fenster */
  max: number;
  /** Summe/Anzahl im aktuellen Fenster (für exakte Mittelwerte bei Tests) */
  sum: number;
  n: number;
  last: number;
}

export interface PerfSnapshot {
  fps: number;
  /** mittlere Framezeit (ms, Rendergrenze inkl. Wartezeit auf vsync/GPU) */
  avgMs: number;
  worstMs: number;
  /** JS-Zeit je Frame (Summe aller Marken, ms) */
  jsMs: number;
  phases: Array<{ label: string; avg: number; max: number }>;
}

class Perf {
  enabled = true;
  private readonly phases = new Map<string, Phase>();
  private t = 0;
  private lastFrame = 0;
  private frameJs = 0;
  private jsAvg = 0;
  private readonly times: number[] = [];
  private readonly stamps: number[] = [];
  private head = 0;
  private curLabel: string[] = [];
  private curMs: number[] = [];
  private curN = 0;
  /** Ausreißer-Frames (JS-Zeit > spikeMs): Zeitstempel, Summe, Abschnitte – für Tests/Diagnose */
  readonly spikes: Array<{ at: number; js: number; parts: Array<[string, number]> }> = [];
  spikeMs = 12;

  /** Frame-Beginn */
  frame(now: number): void {
    if (this.lastFrame > 0) {
      const dt = now - this.lastFrame;
      this.times.push(dt);
      this.stamps.push(now);
      while (this.stamps.length && now - this.stamps[this.head] > WINDOW_MS) this.head++;
      if (this.head > 256) {
        this.times.splice(0, this.head);
        this.stamps.splice(0, this.head);
        this.head = 0;
      }
    }
    this.lastFrame = now;
    this.jsAvg += (this.frameJs - this.jsAvg) * 0.1;
    if (this.frameJs > this.spikeMs && this.spikes.length < 200) {
      this.spikes.push({ at: now, js: this.frameJs, parts: this.curLabel.slice(0, this.curN).map((l, i): [string, number] => [l, Math.round(this.curMs[i] * 10) / 10]).filter((p) => p[1] > 1) });
    }
    this.curN = 0;
    this.frameJs = 0;
    this.t = performance.now();
  }

  /** Ende eines Abschnitts: Zeit seit der letzten Marke -> `label` */
  mark(label: string): void {
    if (!this.enabled) return;
    const n = performance.now();
    const d = n - this.t;
    this.t = n;
    this.frameJs += d;
    this.curLabel[this.curN] = label;
    this.curMs[this.curN++] = d;
    let p = this.phases.get(label);
    if (!p) this.phases.set(label, (p = { avg: d, max: d, sum: 0, n: 0, last: d }));
    p.avg += (d - p.avg) * 0.1;
    if (d > p.max) p.max = d;
    p.sum += d;
    p.n++;
    p.last = d;
  }

  /** Wert für Tests zurücksetzen (Summen/Max) */
  resetWindow(): void {
    for (const p of this.phases.values()) {
      p.max = 0;
      p.sum = 0;
      p.n = 0;
    }
  }

  /** exakte Mittelwerte seit `resetWindow()` (ms je Aufruf) */
  means(): Record<string, number> {
    const o: Record<string, number> = {};
    for (const [k, p] of this.phases) o[k] = p.n ? p.sum / p.n : 0;
    return o;
  }

  snapshot(): PerfSnapshot {
    let sum = 0, worst = 0;
    const n = this.times.length - this.head;
    for (let i = this.head; i < this.times.length; i++) {
      sum += this.times[i];
      if (this.times[i] > worst) worst = this.times[i];
    }
    const avg = n > 0 ? sum / n : 0;
    const phases = Array.from(this.phases, ([label, p]) => ({ label, avg: p.avg, max: p.max }));
    phases.sort((a, b) => b.avg - a.avg);
    return { fps: avg > 0 ? 1000 / avg : 0, avgMs: avg, worstMs: worst, jsMs: this.jsAvg, phases };
  }

  /** Spitzenwerte pro Anzeige-Intervall verwerfen */
  decayMax(): void {
    for (const p of this.phases.values()) p.max = p.last;
  }
}

export const perf = new Perf();
