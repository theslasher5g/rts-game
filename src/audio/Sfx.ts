/**
 * Phase 3 – Rein synthetisierte Soundeffekte (WebAudio, keine Assets).
 *
 * Abonniert die Kampf-/Struktur-Events des EventBus. Lautstärke, Tiefpass (Dunst/Ferne) und Panning
 * hängen von der Entfernung zum Kamera-Blickpunkt und vom Zoom ab: je weiter herausgezoomt, desto
 * größer der hörbare Radius – aber nur große Ereignisse (Explosionen, Brücken, schwere Geschütze) dringen durch.
 * Ein Stimmen-Limiter (max. 16) verdrängt die leiseste Stimme, ein Master-Kompressor fängt Spitzen ab.
 */
import * as THREE from 'three';
import { bus } from '../core/EventBus';
import type { WeaponKind } from '../combat/types';

const MAX_VOICES = 16;

function clamp(v: number, a: number, b: number): number { return v < a ? a : v > b ? b : v; }
function rr(a: number, b: number): number { return a + (b - a) * Math.random(); }
function smooth(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

interface Voice {
  end: number;
  vol: number;
  gain: GainNode;
}

interface Ctx {
  /** Ausgabeknoten der Stimme (hier anschließen) */
  out: AudioNode;
  /** Startzeit (inkl. Laufzeitverzögerung) */
  t: number;
  /** 0..1 Lautstärke nach Entfernung */
  g: number;
  /** Entfernung zum Hörer in km relativ zum hörbaren Radius (0 nah, 1 Rand) */
  far: number;
}

const WEAPON_REACH: Partial<Record<WeaponKind, number>> = {
  rifle: 1, mg: 1.1, hmg: 1.5, sniper: 1.6, autocannon: 1.6, tank_gun: 2.8, atgm: 1.4, rpg: 1.4, mortar: 2.2, howitzer: 5, rocket_arty: 5,
  sam: 2.2, flak: 2, heli_gun: 1.4, heli_rocket: 1.6, heli_atgm: 1.4, air_gun: 1.6, air_missile: 1.8, bomb: 2, naval_gun: 5.5, torpedo: 1.4,
  antiship_missile: 2.5, fpv: 0.8, grenade: 0.8, demo_charge: 1,
};

const X_DUR = [0.55, 0.95, 1.6, 2.5, 3.8];
const X_GAIN = [0.32, 0.5, 0.72, 0.92, 1.0];
const X_LP = [2000, 1400, 950, 700, 520];
const X_REACH = [1.2, 2.2, 4, 7, 12];
const SIZE_IDX: Record<string, number> = { tiny: 0, small: 1, medium: 2, large: 3, huge: 4 };

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private revSend: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private enabled = true;
  private volume = 0.7;
  private readonly voices: Voice[] = [];
  private readonly lastAt = new Map<string, number>();

  // Hörer
  private lx = 0;
  private lz = 0;
  private dist = 100;
  private rx = 1;
  private rz = 0;
  private haveListener = false;
  private readonly dir = new THREE.Vector3();
  private readonly right = new THREE.Vector3();

  constructor() {
    bus.on('combat:fire', (e) => this.onFire(e.weapon, e.fx, e.fz, e.tx, e.tz, e.flightSec));
    bus.on('combat:impact', (e) => this.onImpact(e.surface, e.x, e.z, e.radiusKm));
    bus.on('combat:explosion', (e) => this.onExplosion(e.x, e.z, SIZE_IDX[e.size] ?? 1));
    bus.on('building:destroyed', (e) => this.onBuilding(e.x, e.z));
    bus.on('bridge:destroyed', (e) => {
      const n = Math.floor(e.geom.length / 2);
      if (n < 1) return;
      const i = Math.floor(n / 2);
      this.onBridge(e.geom[i * 2], e.geom[i * 2 + 1]);
    });
    bus.on('smoke:spawn', (e) => this.onSmoke(e.x, e.z));
  }

  // ------------------------------------------------------------ Öffentliche API
  /** Nach der ersten Benutzergeste aufrufen (Autoplay-Policy). */
  resume(): void {
    try {
      if (!this.ctx) this.init();
      if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
    } catch {
      /* Audio nicht verfügbar */
    }
  }

  setEnabled(b: boolean): void {
    this.enabled = b;
    this.applyMaster();
  }

  setVolume(v: number): void {
    this.volume = clamp(v, 0, 1);
    this.applyMaster();
  }

  /** Hörer = Bodenpunkt, auf den die Kamera blickt; Abstand bestimmt hörbaren Radius. */
  update(camera: THREE.PerspectiveCamera): void {
    camera.updateMatrixWorld();
    camera.getWorldDirection(this.dir);
    const p = camera.position;
    const dist = this.dir.y < -0.05 ? Math.max(0.5, p.y / -this.dir.y) : Math.max(0.5, p.y);
    this.dist = dist;
    this.lx = p.x + this.dir.x * dist;
    this.lz = p.z + this.dir.z * dist;
    this.right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    const l = Math.hypot(this.right.x, this.right.z) || 1;
    this.rx = this.right.x / l;
    this.rz = this.right.z / l;
    this.haveListener = true;
  }

  // ------------------------------------------------------------ Initialisierung
  private init(): void {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    const master = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 14;
    comp.ratio.value = 6;
    comp.attack.value = 0.004;
    comp.release.value = 0.2;
    master.connect(comp);
    comp.connect(ctx.destination);
    this.master = master;
    // Rauschpuffer (2 s)
    const len = ctx.sampleRate * 2;
    const nb = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = nb.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = nb;
    // Hall (generierter Impuls)
    const rl = Math.floor(ctx.sampleRate * 1.8);
    const ib = ctx.createBuffer(2, rl, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const ch = ib.getChannelData(c);
      for (let i = 0; i < rl; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / rl, 2.6);
    }
    const conv = ctx.createConvolver();
    conv.buffer = ib;
    const send = ctx.createGain();
    send.gain.value = 1;
    send.connect(conv);
    const wet = ctx.createGain();
    wet.gain.value = 0.5;
    conv.connect(wet);
    wet.connect(master);
    this.revSend = send;
    this.applyMaster();
  }

  private applyMaster(): void {
    if (!this.master || !this.ctx) return;
    this.master.gain.setTargetAtTime(this.enabled ? this.volume : 0, this.ctx.currentTime, 0.03);
  }

  // ------------------------------------------------------------ Stimmen
  /**
   * Stimme für ein Ereignis an (x,z) eröffnen.
   * reach: Hörweiten-Faktor (1 = Kleinwaffe). big: dringt auch bei weitem Herauszoomen durch.
   */
  private begin(kind: string, x: number, z: number, reach: number, vol: number, dur: number, minInterval = 0, wet = 0): Ctx | null {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.enabled || !this.haveListener || ctx.state !== 'running') return null;
    const now = ctx.currentTime;
    if (minInterval > 0) {
      const last = this.lastAt.get(kind) ?? -10;
      if (now - last < minInterval) return null;
    }
    const d = Math.hypot(x - this.lx, z - this.lz);
    // hörbarer Radius wächst mit dem Zoom
    const rA = Math.max(1.5, this.dist * 1.1) * reach;
    const far = d / rA;
    if (far > 2.2) return null;
    let g = vol / (1 + far * far * 3);
    // beim weiten Herauszoomen nur Großes, leise
    const zoomQuiet = 1 - smooth(250, 3500, this.dist) * (reach >= 4 ? 0.65 : 0.97);
    g *= zoomQuiet;
    if (g < 0.012) return null;
    // Stimmen-Limiter
    for (let i = this.voices.length - 1; i >= 0; i--) if (this.voices[i].end < now) this.voices.splice(i, 1);
    if (this.voices.length >= MAX_VOICES) {
      let qi = 0;
      for (let i = 1; i < this.voices.length; i++) if (this.voices[i].vol < this.voices[qi].vol) qi = i;
      if (this.voices[qi].vol >= g) return null;
      const q = this.voices[qi];
      q.gain.gain.cancelScheduledValues(now);
      q.gain.gain.setTargetAtTime(0, now, 0.02);
      q.end = now + 0.1;
      this.voices.splice(qi, 1);
    }
    this.lastAt.set(kind, now);
    // Kette: voiceGain -> Tiefpass (Ferne) -> Pan -> master (+ Hall-Send)
    const vg = ctx.createGain();
    vg.gain.value = g;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 18000 - 15500 * smooth(0.1, 2.0, far);
    vg.connect(lp);
    let tail: AudioNode = lp;
    if (typeof ctx.createStereoPanner === 'function') {
      const pan = ctx.createStereoPanner();
      const side = ((x - this.lx) * this.rx + (z - this.lz) * this.rz) / Math.max(0.8, this.dist * 0.9);
      pan.pan.value = clamp(side, -0.8, 0.8);
      lp.connect(pan);
      tail = pan;
    }
    tail.connect(this.master);
    if (wet > 0 && this.revSend) {
      const ws = ctx.createGain();
      ws.gain.value = wet * (0.4 + 0.6 * Math.min(1, far * 1.5));
      tail.connect(ws);
      ws.connect(this.revSend);
    }
    this.voices.push({ end: now + dur + 0.1, vol: g, gain: vg });
    // Schalllaufzeit (stark gestaucht)
    const delay = Math.min(1.2, d * 0.12);
    return { out: vg, t: now + 0.005 + delay, g, far };
  }

  // ------------------------------------------------------------ Syntheseblöcke
  private burst(c: Ctx, at: number, dur: number, type: BiquadFilterType, f0: number, f1: number, q: number, gain: number, attack = 0.003): void {
    const ctx = this.ctx!;
    const t = c.t + at;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const off = Math.random() * 1.5;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(c.out);
    src.start(t, off, dur + 0.05);
    src.stop(t + dur + 0.06);
  }

  private tone(c: Ctx, at: number, type: OscillatorType, f0: number, f1: number, dur: number, gain: number, attack = 0.004): void {
    const ctx = this.ctx!;
    const t = c.t + at;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(10, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(c.out);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private crack(c: Ctx, at: number, gain: number, hp: number, thump: number): void {
    this.burst(c, at, 0.045, 'highpass', hp * rr(0.9, 1.15), hp * 1.4, 0.7, gain);
    if (thump > 0) this.tone(c, at, 'sine', rr(190, 240), 65, 0.08, gain * thump);
  }

  private boom(c: Ctx, at: number, dur: number, gain: number, lp: number, sub: number): void {
    this.burst(c, at, 0.06, 'highpass', 900, 1800, 0.7, gain * 0.7);
    this.burst(c, at, dur, 'lowpass', lp, 110, 0.9, gain, 0.006);
    this.tone(c, at, 'sine', sub * 1.7, sub * 0.45, dur * 0.85, gain * 0.95, 0.008);
  }

  // ------------------------------------------------------------ Ereignisse
  private onFire(w: WeaponKind, fx: number, fz: number, tx: number, tz: number, flight: number): void {
    const reach = WEAPON_REACH[w] ?? 1;
    switch (w) {
      case 'rifle': {
        const c = this.begin('rifle', fx, fz, reach, 0.34, 0.25, 0.035, 0.05);
        if (c) this.crack(c, 0, 0.7, 1800, 0.6);
        break;
      }
      case 'mg': {
        const c = this.begin('mg', fx, fz, reach, 0.34, 0.5, 0.07, 0.05);
        if (c) for (let i = 0; i < 3; i++) this.crack(c, i * rr(0.065, 0.085), 0.55, 1500, 0.7);
        break;
      }
      case 'hmg': {
        const c = this.begin('hmg', fx, fz, reach, 0.5, 0.5, 0.08, 0.1);
        if (c) for (let i = 0; i < 3; i++) { this.crack(c, i * 0.1, 0.75, 900, 1.0); this.burst(c, i * 0.1, 0.14, 'lowpass', 900, 200, 0.8, 0.3); }
        break;
      }
      case 'sniper': {
        const c = this.begin('sniper', fx, fz, reach, 0.55, 1.2, 0.2, 0.3);
        if (c) { this.crack(c, 0, 1.0, 1300, 0.9); this.burst(c, 0.05, 0.6, 'lowpass', 1200, 200, 0.8, 0.25); this.burst(c, 0.38, 0.5, 'lowpass', 600, 150, 0.8, 0.12); }
        break;
      }
      case 'autocannon': {
        const c = this.begin('autocannon', fx, fz, reach, 0.55, 0.5, 0.1, 0.1);
        if (c) for (let i = 0; i < 4; i++) { this.crack(c, i * 0.06, 0.7, 1100, 1.2); this.tone(c, i * 0.06, 'square', 140, 60, 0.06, 0.12); }
        break;
      }
      case 'flak':
      case 'air_gun':
      case 'heli_gun': {
        const c = this.begin(w, fx, fz, reach, 0.45, 0.45, 0.1, 0.1);
        if (c) for (let i = 0; i < 5; i++) this.crack(c, i * 0.045, 0.5, 1400, 0.8);
        break;
      }
      case 'tank_gun': {
        const c = this.begin('tank_gun', fx, fz, reach, 0.85, 1.4, 0.06, 0.35);
        if (c) { this.boom(c, 0, 0.7, 0.9, 1100, 75); this.crack(c, 0, 0.8, 1500, 0); }
        break;
      }
      case 'naval_gun': {
        const c = this.begin('naval_gun', fx, fz, reach, 1.0, 2.2, 0.1, 0.5);
        if (c) { this.boom(c, 0, 1.4, 1.0, 800, 55); this.burst(c, 0.5, 1.2, 'lowpass', 300, 80, 0.8, 0.4); }
        break;
      }
      case 'howitzer': {
        const c = this.begin('howitzer', fx, fz, reach, 1.0, 2.8, 0.08, 0.5);
        if (c) { this.boom(c, 0, 1.0, 1.0, 900, 50); this.burst(c, 0.45, 1.6, 'lowpass', 400, 70, 0.8, 0.5); this.tone(c, 0.35, 'sine', 40, 22, 1.4, 0.4); }
        break;
      }
      case 'mortar': {
        const c = this.begin('mortar', fx, fz, reach, 0.6, 0.6, 0.07, 0.25);
        if (c) { this.tone(c, 0, 'sine', 160, 55, 0.2, 0.9); this.burst(c, 0, 0.2, 'lowpass', 1400, 200, 0.8, 0.6); this.burst(c, 0.02, 0.35, 'bandpass', 900, 500, 1.5, 0.25); }
        break;
      }
      case 'rocket_arty': {
        const c = this.begin('rocket_arty', fx, fz, reach, 0.9, 2.6, 0.12, 0.45);
        if (c) { this.boom(c, 0, 0.7, 0.7, 1400, 70); this.burst(c, 0.05, 2.0, 'bandpass', 500, 2400, 1.0, 0.5, 0.2); }
        break;
      }
      case 'atgm':
      case 'rpg':
      case 'heli_rocket':
      case 'heli_atgm':
      case 'sam':
      case 'air_missile':
      case 'antiship_missile': {
        const long = w === 'sam' || w === 'air_missile' || w === 'antiship_missile';
        const c = this.begin(w, fx, fz, reach, long ? 0.7 : 0.6, long ? 1.6 : 1.0, 0.08, 0.3);
        if (c) {
          const d = long ? 1.5 : 0.8;
          this.burst(c, 0, d, 'bandpass', 450, 2800, 1.1, long ? 0.6 : 0.5, 0.06);
          this.tone(c, 0, 'sine', 130, 45, 0.25, 0.7);
          if (w === 'rpg') this.crack(c, 0, 0.6, 1100, 0);
        }
        break;
      }
      case 'bomb': {
        const c = this.begin('bomb', fx, fz, reach, 0.35, Math.max(0.5, flight), 0.2, 0.2);
        if (c && flight > 0.5) {
          const dur = Math.min(2.5, flight);
          // Pfeifen: fallende Frequenz
          this.tone(c, 0, 'sine', 2300, 750, dur, 0.1, 0.1);
          this.burst(c, 0, dur, 'bandpass', 2800, 900, 3, 0.1, 0.1);
        }
        break;
      }
      case 'torpedo': {
        const c = this.begin('torpedo', fx, fz, reach, 0.5, 1.0, 0.2, 0.2);
        if (c) { this.tone(c, 0, 'sine', 90, 50, 0.5, 0.6); this.burst(c, 0.02, 0.4, 'bandpass', 700, 300, 1.2, 0.4); }
        break;
      }
      case 'fpv': {
        const c = this.begin('fpv', fx, fz, reach, 0.22, 0.5, 0.25, 0);
        if (c) { this.tone(c, 0, 'sawtooth', 320, 520, 0.45, 0.25, 0.05); }
        break;
      }
      default:
        break;
    }
    void tx; void tz;
  }

  private onImpact(surface: string, x: number, z: number, radiusKm: number): void {
    const rm = clamp(radiusKm * 1000, 1, 40);
    const k = clamp(0.2 + rm * 0.03, 0.2, 0.8);
    switch (surface) {
      case 'ground': {
        const c = this.begin('imp_g', x, z, 0.8 + rm * 0.06, k, 0.4, 0.05);
        if (c) { this.tone(c, 0, 'sine', 100, 45, 0.14, 0.9); this.burst(c, 0, 0.18, 'lowpass', 900, 150, 0.8, 0.7); }
        break;
      }
      case 'water': {
        const c = this.begin('imp_w', x, z, 0.8 + rm * 0.06, k, 0.6, 0.06);
        if (c) { this.burst(c, 0, 0.45, 'bandpass', 1800, 600, 0.9, 0.7, 0.03); this.tone(c, 0, 'sine', 90, 50, 0.2, 0.5); }
        break;
      }
      case 'building': {
        const c = this.begin('imp_b', x, z, 0.8 + rm * 0.06, k * 1.1, 0.5, 0.06);
        if (c) { this.burst(c, 0, 0.3, 'lowpass', 1400, 250, 0.9, 0.8); this.tone(c, 0, 'sine', 120, 55, 0.15, 0.6); this.burst(c, 0.08, 0.2, 'bandpass', 2500, 1500, 1.5, 0.3); }
        break;
      }
      case 'armor': {
        const c = this.begin('imp_a', x, z, 1.0, k * 1.1, 0.5, 0.05);
        if (c) { this.burst(c, 0, 0.03, 'highpass', 3000, 4000, 0.7, 0.8); this.tone(c, 0, 'triangle', rr(1500, 2100), rr(1100, 1500), 0.22, 0.5); this.tone(c, 0, 'sine', 140, 70, 0.1, 0.5); }
        break;
      }
      case 'flesh': {
        const c = this.begin('imp_f', x, z, 0.4, 0.14, 0.15, 0.08);
        if (c) this.burst(c, 0, 0.09, 'lowpass', 500, 150, 0.7, 0.8);
        break;
      }
      default: {
        const c = this.begin('imp_s', x, z, 0.9, k, 0.3, 0.06);
        if (c) { this.burst(c, 0, 0.09, 'bandpass', 1800, 1000, 1.4, 0.8); this.tone(c, 0, 'sine', 110, 60, 0.1, 0.4); }
      }
    }
  }

  private onExplosion(x: number, z: number, sz: number): void {
    const c = this.begin('expl' + sz, x, z, X_REACH[sz], X_GAIN[sz], X_DUR[sz] + 0.8, sz >= 2 ? 0.02 : 0.04, sz >= 2 ? 0.55 : 0.25);
    if (!c) return;
    const dur = X_DUR[sz];
    this.boom(c, 0, dur, 1, X_LP[sz], 85 - sz * 10);
    // Trümmerregen
    const n = 2 + sz * 2;
    for (let i = 0; i < n; i++) this.burst(c, rr(0.15, dur * 1.1), rr(0.05, 0.14), 'bandpass', rr(1200, 3200), 800, 2, rr(0.08, 0.2) * (1 - i / (n + 1)));
    if (sz >= 3) this.burst(c, 0.3, dur * 1.3, 'lowpass', 260, 60, 0.7, 0.5);
  }

  private onBuilding(x: number, z: number): void {
    const c = this.begin('bldg', x, z, 4, 0.8, 3.6, 0.3, 0.5);
    if (!c) return;
    this.burst(c, 0, 0.12, 'highpass', 800, 1500, 0.7, 0.7);
    this.tone(c, 0, 'sine', 70, 28, 1.6, 0.8, 0.02);
    this.burst(c, 0.05, 2.4, 'lowpass', 420, 90, 0.8, 0.85, 0.1);
    for (let i = 0; i < 7; i++) this.burst(c, rr(0.3, 2.4), rr(0.1, 0.3), 'bandpass', rr(500, 1800), 300, 1.2, rr(0.15, 0.4));
  }

  private onBridge(x: number, z: number): void {
    const c = this.begin('bridge', x, z, 8, 1.0, 5.4, 0.5, 0.6);
    if (!c) return;
    this.boom(c, 0, 1.6, 0.9, 700, 62);
    this.burst(c, 0.2, 4.2, 'lowpass', 360, 70, 0.8, 0.8, 0.15);
    this.tone(c, 0.1, 'sine', 55, 24, 3.5, 0.7, 0.05);
    for (let i = 0; i < 9; i++) {
      const at = rr(0.2, 3.4);
      this.burst(c, at, rr(0.12, 0.35), 'bandpass', rr(400, 1500), 250, 1.6, rr(0.25, 0.55));
      this.tone(c, at, 'triangle', rr(240, 520), rr(150, 300), rr(0.2, 0.5), rr(0.08, 0.18)); // Metallklirren
    }
  }

  private onSmoke(x: number, z: number): void {
    const c = this.begin('smoke', x, z, 1.2, 0.35, 1.0, 0.1, 0.1);
    if (!c) return;
    this.tone(c, 0, 'sine', 180, 80, 0.12, 0.5);
    this.burst(c, 0.04, 0.9, 'bandpass', 3500, 2000, 0.8, 0.35, 0.05);
  }
}
