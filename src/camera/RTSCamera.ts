import * as THREE from 'three';
import type { Settings } from '../core/types';
import type { Input } from '../core/Input';
import type { GeoData } from '../world/GeoData';

/**
 * Klassische RTS-Kamera (perspektivisch, enges FOV, zoomabhängige Neigung).
 *
 * Steuerung:
 *   Mausrad            Zoom (exponentiell, zum Mauszeiger hin)
 *   WASD / Pfeiltasten Schwenken (Shift = schneller)
 *   Rechte Maustaste   Karte greifen & ziehen (nur solange `rightDragPan` – Phase 2: aus, wenn Einheiten ausgewählt sind)
 *   Bildschirmrand     Schwenken (settings.edgeScroll)
 *   Q / E, Mittlere Maustaste horizontal ziehen: Drehen (settings.allowRotation)
 *   Pos1 / R           Norden oben (Drehung zurücksetzen)
 */

const FOV_DEG = 32;
const MIN_DIST = 6;
const MAX_DIST = 7500;
/** Neigung (Grad nach unten) bei minimalem / großem Abstand */
const PITCH_NEAR = 42;
const PITCH_FAR = 62;
/** Abstand, ab dem die volle Fern-Neigung erreicht ist */
const PITCH_FAR_DIST = 2500;
const LN_MIN = Math.log(MIN_DIST);
const LN_MAX = Math.log(MAX_DIST);
const LN_PITCH_FAR = Math.log(PITCH_FAR_DIST);

/** Zoomfaktor pro normierter Mausrad-Raste */
const ZOOM_PER_NOTCH = 1.18;
/** Dämpfungsraten (1/s) – größer = schneller */
const DAMP_PAN = 12;
const DAMP_ZOOM = 10;
const DAMP_YAW = 10;
const DAMP_HEIGHT = 6;
/** Schwenkgeschwindigkeit in Abständen pro Sekunde */
const PAN_SPEED = 0.85;
const PAN_FAST = 2.5;
const ROT_SPEED = 1.8; // rad/s
const DRAG_ROT = 0.006; // rad/px
const EDGE_PX = 12;
const FOCUS_DURATION = 1.2;

export class RTSCamera {
  readonly camera: THREE.PerspectiveCamera;
  /** Aktueller (gedämpfter) Bodenpunkt, auf den die Kamera blickt */
  readonly target = new THREE.Vector3();
  enabled = true;
  /**
   * Rechts-Ziehen schwenkt die Karte. Der SelectionController setzt das pro Frame auf false,
   * solange eigene Einheiten ausgewählt sind (Rechts-Ziehen = Formation/Blickrichtung).
   * Die Zieh-Pixel werden trotzdem verbraucht, damit beim Umschalten nichts springt.
   */
  rightDragPan = true;

  private readonly canvas: HTMLCanvasElement;
  private readonly input: Input;
  private readonly geo: GeoData;
  private exaggeration = 1;
  private allowRotation = true;
  private edgeScroll = true;

  // Zielzustand (ungedämpft)
  private goalX = 0;
  private goalZ = 0;
  private goalLnDist = 0;
  private goalYaw = 0;
  // Aktueller Zustand
  private lnDist = 0;
  private yaw = 0;
  private pitch = PITCH_FAR * THREE.MathUtils.DEG2RAD;

  // Zoom-zum-Cursor-Anker
  private anchorActive = false;
  private readonly anchor = new THREE.Vector3();
  private anchorNdcX = 0;
  private anchorNdcY = 0;

  // Fly-to-Animation
  private animActive = false;
  private animT = 0;
  private animX0 = 0;
  private animZ0 = 0;
  private animX1 = 0;
  private animZ1 = 0;
  private animLn0 = 0;
  private animLn1 = 0;
  private animBump = 0;

  // Temporäre Objekte (keine Allokation pro Frame)
  private readonly tmpO = new THREE.Vector3();
  private readonly tmpD = new THREE.Vector3();
  private readonly tmpP = new THREE.Vector3();
  private readonly footprint: Array<[number, number]> = [
    [0, 0],
    [0, 0],
    [0, 0],
    [0, 0],
  ];

  constructor(canvas: HTMLCanvasElement, input: Input, geo: GeoData, settings: Settings) {
    this.canvas = canvas;
    this.input = input;
    this.geo = geo;
    const aspect = canvas.clientWidth > 0 && canvas.clientHeight > 0 ? canvas.clientWidth / canvas.clientHeight : 16 / 9;
    this.camera = new THREE.PerspectiveCamera(FOV_DEG, aspect, 1, 10000);
    this.applySettings(settings);

    // Startansicht: ganz Europa
    const cx = Math.min(2600, geo.widthKm * 0.5), cz = Math.min(2300, geo.heightKm * 0.52);
    this.goalX = cx;
    this.goalZ = cz;
    this.goalLnDist = this.lnDist = Math.log(6500);
    this.target.set(cx, this.groundY(cx, cz), cz);
    this.applyCamera();
  }

  get distance(): number {
    return Math.exp(this.lnDist);
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  applySettings(s: Settings): void {
    this.exaggeration = s.heightExaggeration;
    this.allowRotation = s.allowRotation;
    this.edgeScroll = s.edgeScroll;
  }

  /** Sanfter Flug zu (x, z). distance: optionaler Ziel-Abstand (sonst aktueller). */
  focus(x: number, z: number, distance?: number, animate = true): void {
    const p = this.clampXZ(x, z);
    const ln1 = distance !== undefined ? clampLn(Math.log(Math.max(distance, 1e-3))) : this.goalLnDist;
    this.anchorActive = false;
    if (!animate) {
      this.animActive = false;
      this.goalX = p[0];
      this.goalZ = p[1];
      this.target.x = p[0];
      this.target.z = p[1];
      this.target.y = this.groundY(p[0], p[1]);
      this.goalLnDist = this.lnDist = ln1;
      this.applyCamera();
      return;
    }
    this.animActive = true;
    this.animT = 0;
    this.animX0 = this.target.x;
    this.animZ0 = this.target.z;
    this.animX1 = p[0];
    this.animZ1 = p[1];
    this.animLn0 = this.lnDist;
    this.animLn1 = ln1;
    // Bei weiten Flügen kurz herauszoomen (Bogen), damit man sieht, wohin es geht
    const travel = Math.hypot(this.animX1 - this.animX0, this.animZ1 - this.animZ0);
    const lnTravel = Math.log(Math.max(travel * 0.9, 1e-3));
    this.animBump = Math.max(0, Math.min(LN_MAX, lnTravel) - Math.max(this.animLn0, this.animLn1));
  }

  update(dt: number): void {
    if (!(dt > 0)) dt = 0;
    if (dt > 0.1) dt = 0.1;
    const input = this.input;
    const dist = Math.exp(this.lnDist);

    // ---------- Eingaben ----------
    let wheel = input.consumeWheel();
    const rDrag = input.consumeDrag(2);
    const rdx = rDrag.dx, rdy = rDrag.dy;
    const mDrag = input.consumeDrag(1);
    const mdx = mDrag.dx;
    if (!this.enabled) {
      wheel = 0;
    }

    let panX = 0, panY = 0; // Bildschirmachsen: +X rechts, +Y vorwärts (oben)
    let rot = 0;
    let userMoved = false;
    if (this.enabled) {
      const fast = input.isDown('ShiftLeft') || input.isDown('ShiftRight');
      if (input.isDown('KeyW') || input.isDown('ArrowUp')) panY += 1;
      if (input.isDown('KeyS') || input.isDown('ArrowDown')) panY -= 1;
      if (input.isDown('KeyD') || input.isDown('ArrowRight')) panX += 1;
      if (input.isDown('KeyA') || input.isDown('ArrowLeft')) panX -= 1;
      if (this.edgeScroll && input.mouse.inside && input.mouse.buttons === 0) {
        const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
        const mx = input.mouse.x, my = input.mouse.y;
        if (w > 0 && h > 0 && mx >= 0 && my >= 0 && mx <= w && my <= h) {
          if (mx < EDGE_PX) panX -= 1;
          else if (mx > w - EDGE_PX) panX += 1;
          if (my < EDGE_PX) panY += 1;
          else if (my > h - EDGE_PX) panY -= 1;
        }
      }
      if (panX !== 0 || panY !== 0) {
        const len = Math.hypot(panX, panY);
        const speed = (dist * PAN_SPEED * (fast ? PAN_FAST : 1) * dt) / len;
        panX *= speed;
        panY *= speed;
        userMoved = true;
      }

      // Rechte Maustaste: Karte greifen (Pixel -> Welt am Zielpunkt)
      if (this.rightDragPan && (rdx !== 0 || rdy !== 0)) {
        const h = this.canvas.clientHeight || 1;
        const wpp = (2 * dist * Math.tan((FOV_DEG * THREE.MathUtils.DEG2RAD) / 2)) / h;
        panX -= rdx * wpp;
        panY += (rdy * wpp) / Math.max(0.3, Math.sin(this.pitch));
        userMoved = true;
      }

      if (this.allowRotation) {
        if (input.isDown('KeyQ')) rot -= ROT_SPEED * dt;
        if (input.isDown('KeyE')) rot += ROT_SPEED * dt;
        if (mdx !== 0) rot += mdx * DRAG_ROT;
        if (input.isDown('Home') || input.isDown('KeyR')) {
          // Kürzester Weg nach Norden (Umwickeln um 2π ist visuell unsichtbar)
          this.yaw = wrapAngle(this.yaw);
          this.goalYaw = 0;
        }
      } else if (this.goalYaw !== 0) {
        this.yaw = wrapAngle(this.yaw);
        this.goalYaw = 0;
      }
      if (rot !== 0) {
        this.goalYaw += rot;
        userMoved = true;
      }
    }

    if (userMoved || wheel !== 0) {
      if (this.animActive) {
        // Benutzereingabe bricht Fly-to ab
        this.animActive = false;
        this.goalX = this.target.x;
        this.goalZ = this.target.z;
        this.goalLnDist = this.lnDist;
      }
    }
    if (userMoved) this.anchorActive = false;

    // Schwenk auf Ziel anwenden (in Blickrichtung ausgerichtet)
    if (panX !== 0 || panY !== 0) {
      const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
      // vorwärts = (-sin, -cos), rechts = (cos, -sin)
      this.goalX += panX * cy - panY * sy;
      this.goalZ += -panX * sy - panY * cy;
      this.clampGoal();
    }

    // Zoom zum Cursor
    if (wheel !== 0) {
      this.goalLnDist = clampLn(this.goalLnDist + wheel * Math.log(ZOOM_PER_NOTCH));
      const m = input.mouse;
      const nx = m.inside ? m.ndcX : 0, ny = m.inside ? m.ndcY : 0;
      if (!this.anchorActive || Math.abs(nx - this.anchorNdcX) > 0.004 || Math.abs(ny - this.anchorNdcY) > 0.004) {
        if (this.rayToPlane(nx, ny, this.target.y, this.anchor)) {
          this.anchorActive = true;
          this.anchorNdcX = nx;
          this.anchorNdcY = ny;
        } else {
          this.anchorActive = false;
        }
      }
    }

    // ---------- Animation / Dämpfung ----------
    const kPan = 1 - Math.exp(-DAMP_PAN * dt);
    const kZoom = 1 - Math.exp(-DAMP_ZOOM * dt);
    const kYaw = 1 - Math.exp(-DAMP_YAW * dt);
    const kH = 1 - Math.exp(-DAMP_HEIGHT * dt);

    if (this.animActive) {
      this.animT += dt / FOCUS_DURATION;
      const t = this.animT >= 1 ? 1 : this.animT;
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      this.target.x = this.goalX = this.animX0 + (this.animX1 - this.animX0) * e;
      this.target.z = this.goalZ = this.animZ0 + (this.animZ1 - this.animZ0) * e;
      this.lnDist = this.goalLnDist = this.animLn0 + (this.animLn1 - this.animLn0) * e + this.animBump * Math.sin(Math.PI * t);
      if (t >= 1) this.animActive = false;
    } else {
      this.target.x += (this.goalX - this.target.x) * kPan;
      this.target.z += (this.goalZ - this.target.z) * kPan;
      this.lnDist += (this.goalLnDist - this.lnDist) * kZoom;
    }
    this.yaw += (this.goalYaw - this.yaw) * kYaw;

    // Zielhöhe folgt dem Gelände (geglättet)
    this.target.y += (this.groundY(this.target.x, this.target.z) - this.target.y) * kH;

    this.applyCamera();

    // Zoom-Anker: Punkt unter dem Cursor stabil halten
    if (this.anchorActive) {
      if (this.rayToPlane(this.anchorNdcX, this.anchorNdcY, this.anchor.y, this.tmpP)) {
        const dx = this.anchor.x - this.tmpP.x, dz = this.anchor.z - this.tmpP.z;
        this.target.x += dx;
        this.target.z += dz;
        this.goalX += dx;
        this.goalZ += dz;
        this.clampGoal();
        const c = this.clampXZ(this.target.x, this.target.z);
        this.target.x = c[0];
        this.target.z = c[1];
        this.applyCamera();
      }
      if (Math.abs(this.goalLnDist - this.lnDist) < 1e-4) this.anchorActive = false;
    }
  }

  /**
   * Vier Ecken des Sichtkegels geschnitten mit y = 0 (bei Horizont auf weite Distanz begrenzt).
   * Reihenfolge: unten-links, unten-rechts, oben-rechts, oben-links. Liefert ein wiederverwendetes Array.
   */
  getGroundFootprint(): Array<[number, number]> {
    const maxLen = Math.max(this.distance * 4, 50);
    this.cornerOnGround(-1, -1, maxLen, this.footprint[0]);
    this.cornerOnGround(1, -1, maxLen, this.footprint[1]);
    this.cornerOnGround(1, 1, maxLen, this.footprint[2]);
    this.cornerOnGround(-1, 1, maxLen, this.footprint[3]);
    return this.footprint;
  }

  // ------------------------------------------------------------------

  private cornerOnGround(nx: number, ny: number, maxLen: number, out: [number, number]): void {
    const o = this.tmpO.copy(this.camera.position);
    const d = this.tmpD.set(nx, ny, 0.5).unproject(this.camera).sub(o).normalize();
    let t = maxLen;
    if (d.y < -1e-6) {
      const th = o.y / -d.y;
      if (th < t) t = th;
    } else {
      // Kein Bodenschnitt: horizontal projiziert begrenzen
      const hl = Math.hypot(d.x, d.z) || 1;
      out[0] = o.x + (d.x / hl) * maxLen;
      out[1] = o.z + (d.z / hl) * maxLen;
      return;
    }
    out[0] = o.x + d.x * t;
    out[1] = o.z + d.z * t;
  }

  /** Strahl durch NDC mit Ebene y = planeY schneiden (aktuelle Kameramatrix). */
  private rayToPlane(nx: number, ny: number, planeY: number, out: THREE.Vector3): boolean {
    const o = this.tmpO.copy(this.camera.position);
    const d = this.tmpD.set(nx, ny, 0.5).unproject(this.camera).sub(o).normalize();
    if (d.y > -1e-4) return false;
    const t = (o.y - planeY) / -d.y;
    if (t <= 0) return false;
    out.set(o.x + d.x * t, planeY, o.z + d.z * t);
    return true;
  }

  /** Positioniert die Kamera anhand target/yaw/lnDist (Neigung aus Abstand). */
  private applyCamera(): void {
    const dist = Math.exp(this.lnDist);
    let tp = (this.lnDist - LN_MIN) / (LN_PITCH_FAR - LN_MIN);
    tp = tp < 0 ? 0 : tp > 1 ? 1 : tp;
    tp = tp * tp * (3 - 2 * tp);
    this.pitch = (PITCH_NEAR + (PITCH_FAR - PITCH_NEAR) * tp) * THREE.MathUtils.DEG2RAD;

    const h = Math.cos(this.pitch) * dist, v = Math.sin(this.pitch) * dist;
    const cam = this.camera;
    const px = this.target.x + Math.sin(this.yaw) * h;
    const pz = this.target.z + Math.cos(this.yaw) * h;
    let py = this.target.y + v;
    // Nie unter das Gelände
    const minY = this.groundY(px, pz) + Math.max(0.15, dist * 0.08);
    if (py < minY) py = minY;
    cam.position.set(px, py, pz);
    cam.up.set(0, 1, 0);
    cam.lookAt(this.target);

    const near = Math.max(0.02, dist * 0.01);
    const far = dist * 8 + 3000;
    if (cam.near !== near || cam.far !== far) {
      cam.near = near;
      cam.far = far;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
  }

  private groundY(x: number, z: number): number {
    const h = this.geo.heightAt(x, z);
    return h > 0 ? h * this.exaggeration : 0;
  }

  private clampGoal(): void {
    const c = this.clampXZ(this.goalX, this.goalZ);
    this.goalX = c[0];
    this.goalZ = c[1];
  }

  private readonly clampOut: [number, number] = [0, 0];
  private clampXZ(x: number, z: number): [number, number] {
    const m = 20;
    const W = this.geo.widthKm, H = this.geo.heightKm;
    this.clampOut[0] = x < m ? m : x > W - m ? W - m : x;
    this.clampOut[1] = z < m ? m : z > H - m ? H - m : z;
    return this.clampOut;
  }
}

function clampLn(ln: number): number {
  return ln < LN_MIN ? LN_MIN : ln > LN_MAX ? LN_MAX : ln;
}

function wrapAngle(a: number): number {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}
