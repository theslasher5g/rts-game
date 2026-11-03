import { bus } from '../core/EventBus';
import type { GeoData } from '../world/GeoData';
import { ROAD_CLASSES, type NavEdge, type NavNode, type RoadClass } from './types';

/** Zellgröße des Raum-Hashes (km) */
const HASH_KM = 8;
const MAGIC = 0x4e525757;

/**
 * Straßen-/Schienen-/Fährnetz als Graph (aus public/data/roads.bin, siehe scripts/build-roads.mjs).
 * Knoten/Kanten in Welt-km. Raum-Hashes für Knoten und Kantensegmente (CSR, 8-km-Zellen).
 */
export class NavGraph {
  readonly nodes: NavNode[];
  readonly edges: NavEdge[];
  /** Klassenindex je Kante (Index in ROAD_CLASSES) */
  readonly edgeCls: Uint8Array;
  /** Anzahl offener Kanten-Änderungen (für Caches) */
  version = 0;
  readonly stats: Record<string, unknown>;

  private readonly hw: number;
  private readonly hh: number;
  // Knoten-Hash
  private readonly nStart: Int32Array;
  private readonly nItems: Int32Array;
  // Segment-Hash: Einträge = edge*65536+seg wäre zu eng -> zwei Arrays
  private readonly sStart: Int32Array;
  private readonly sEdge: Int32Array;
  private readonly sSeg: Int32Array;
  private readonly edgeStamp: Uint32Array;
  private stampGen = 0;

  private constructor(nodes: NavNode[], edges: NavEdge[], cls: Uint8Array, widthKm: number, heightKm: number, stats: Record<string, unknown>) {
    this.nodes = nodes;
    this.edges = edges;
    this.edgeCls = cls;
    this.stats = stats;
    this.hw = Math.ceil(widthKm / HASH_KM) + 1;
    this.hh = Math.ceil(heightKm / HASH_KM) + 1;
    const cells = this.hw * this.hh;

    // Knoten-Hash
    const nCount = new Int32Array(cells + 1);
    const nCell = new Int32Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) {
      const c = this.cellOf(nodes[i].x, nodes[i].z);
      nCell[i] = c;
      nCount[c + 1]++;
    }
    for (let c = 0; c < cells; c++) nCount[c + 1] += nCount[c];
    this.nStart = nCount;
    this.nItems = new Int32Array(nodes.length);
    const fill = nCount.slice(0, cells);
    for (let i = 0; i < nodes.length; i++) this.nItems[fill[nCell[i]]++] = i;

    // Segment-Hash (jede Zelle der Segment-Bounding-Box)
    const sCount = new Int32Array(cells + 1);
    const visit = (cb: (cell: number, e: number, s: number) => void) => {
      for (let e = 0; e < edges.length; e++) {
        const g = edges[e].geom;
        for (let s = 0; s + 3 < g.length; s += 2) {
          const i0 = this.ci(Math.min(g[s], g[s + 2])), i1 = this.ci(Math.max(g[s], g[s + 2]));
          const j0 = this.cj(Math.min(g[s + 1], g[s + 3])), j1 = this.cj(Math.max(g[s + 1], g[s + 3]));
          for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) cb(j * this.hw + i, e, s >> 1);
        }
      }
    };
    let total = 0;
    visit((c) => { sCount[c + 1]++; total++; });
    for (let c = 0; c < cells; c++) sCount[c + 1] += sCount[c];
    this.sStart = sCount;
    this.sEdge = new Int32Array(total);
    this.sSeg = new Int32Array(total);
    const sFill = sCount.slice(0, cells);
    visit((c, e, s) => { const k = sFill[c]++; this.sEdge[k] = e; this.sSeg[k] = s; });
    this.edgeStamp = new Uint32Array(edges.length);
  }

  static async load(geo: GeoData, baseUrl = `${import.meta.env.BASE_URL}data/`): Promise<NavGraph> {
    const r = await fetch(baseUrl + 'roads.bin');
    if (!r.ok) throw new Error(`Konnte roads.bin nicht laden (${r.status}). Wurde "npm run roads" ausgeführt?`);
    return NavGraph.fromBuffer(await r.arrayBuffer(), geo);
  }

  /** Parst roads.bin (auch für Node-Tests nutzbar). */
  static fromBuffer(buf: ArrayBuffer, geo: GeoData): NavGraph {
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== MAGIC) throw new Error('roads.bin: falsches Format');
    const hLen = dv.getUint32(8, true);
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, hLen))) as {
      classes: string[]; quant: number; nodes: number; edges: number; interior: number; stats: Record<string, unknown>;
    };
    const pad4 = (n: number) => (n + 3) & ~3;
    let o = 12 + pad4(hLen);
    const nN = header.nodes, nE = header.edges, Q = header.quant;
    const nodeXZ = new Float32Array(buf, o, nN * 2); o += nN * 8;
    const ab = new Uint32Array(buf, o, nE * 2); o += nE * 8;
    const clsRaw = new Uint8Array(buf, o, nE);
    const flags = new Uint8Array(buf, o + nE, nE);
    const country = new Uint8Array(buf, o + nE * 2, nE);
    o += pad4(nE * 3);
    const gStart = new Uint32Array(buf, o, nE + 1); o += (nE + 1) * 4;
    const deltas = new Int16Array(buf, o, header.interior * 2);

    // Klassen des Datensatzes auf ROAD_CLASSES abbilden
    const clsMap = header.classes.map((c) => Math.max(0, ROAD_CLASSES.indexOf(c as RoadClass)));
    const nodes: NavNode[] = new Array(nN);
    for (let i = 0; i < nN; i++) nodes[i] = { id: i, x: nodeXZ[i * 2], z: nodeXZ[i * 2 + 1], edges: [] };
    const edges: NavEdge[] = new Array(nE);
    const cls = new Uint8Array(nE);
    for (let e = 0; e < nE; e++) {
      const a = ab[e * 2], b = ab[e * 2 + 1];
      const nInt = gStart[e + 1] - gStart[e];
      const geom = new Float32Array((nInt + 2) * 2);
      geom[0] = nodes[a].x; geom[1] = nodes[a].z;
      let px = Math.round(nodes[a].x * Q), pz = Math.round(nodes[a].z * Q);
      let len = 0;
      for (let k = 0; k < nInt; k++) {
        const d = (gStart[e] + k) * 2;
        px += deltas[d]; pz += deltas[d + 1];
        geom[(k + 1) * 2] = px / Q;
        geom[(k + 1) * 2 + 1] = pz / Q;
      }
      geom[(nInt + 1) * 2] = nodes[b].x; geom[(nInt + 1) * 2 + 1] = nodes[b].z;
      for (let k = 2; k < geom.length; k += 2) len += Math.hypot(geom[k] - geom[k - 2], geom[k + 1] - geom[k - 1]);
      cls[e] = clsMap[clsRaw[e]];
      edges[e] = {
        id: e, a, b,
        cls: ROAD_CLASSES[cls[e]],
        lengthKm: len,
        bridge: (flags[e] & 1) !== 0,
        open: true,
        geom,
        country: geo.countriesById.get(country[e])?.a3 ?? '',
      };
      nodes[a].edges.push(e);
      if (b !== a) nodes[b].edges.push(e);
    }
    return new NavGraph(nodes, edges, cls, geo.widthKm, geo.heightKm, header.stats);
  }

  private ci(x: number): number { return Math.max(0, Math.min(this.hw - 1, Math.floor(x / HASH_KM))); }
  private cj(z: number): number { return Math.max(0, Math.min(this.hh - 1, Math.floor(z / HASH_KM))); }
  private cellOf(x: number, z: number): number { return this.cj(z) * this.hw + this.ci(x); }

  /** Nächster Knoten innerhalb maxKm (optional gefiltert), -1 wenn keiner. */
  nearestNode(x: number, z: number, maxKm: number, filter?: (n: NavNode) => boolean): number {
    const i0 = this.ci(x - maxKm), i1 = this.ci(x + maxKm), j0 = this.cj(z - maxKm), j1 = this.cj(z + maxKm);
    let best = -1, bd = maxKm * maxKm;
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const c = j * this.hw + i;
        for (let k = this.nStart[c]; k < this.nStart[c + 1]; k++) {
          const n = this.nodes[this.nItems[k]];
          const d = (n.x - x) * (n.x - x) + (n.z - z) * (n.z - z);
          if (d <= bd && (!filter || filter(n))) { bd = d; best = n.id; }
        }
      }
    return best;
  }

  /**
   * Nächster Punkt auf einer Kante innerhalb maxKm. t = Anteil der Kantenlänge (0 = a, 1 = b).
   * Optionaler Filter auf Kanten (z. B. nur offene/befahrbare).
   */
  nearestEdgePoint(x: number, z: number, maxKm: number, filter?: (e: NavEdge) => boolean): { edge: number; t: number; x: number; z: number; distKm: number } | null {
    const i0 = this.ci(x - maxKm), i1 = this.ci(x + maxKm), j0 = this.cj(z - maxKm), j1 = this.cj(z + maxKm);
    let bd = maxKm * maxKm, be = -1, bs = 0, bt = 0, bx = 0, bz = 0;
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const c = j * this.hw + i;
        for (let k = this.sStart[c]; k < this.sStart[c + 1]; k++) {
          const e = this.sEdge[k], s = this.sSeg[k];
          const g = this.edges[e].geom;
          const ax = g[s * 2], az = g[s * 2 + 1], dx = g[s * 2 + 2] - ax, dz = g[s * 2 + 3] - az;
          const L2 = dx * dx + dz * dz;
          let t = L2 > 0 ? ((x - ax) * dx + (z - az) * dz) / L2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const px = ax + dx * t, pz = az + dz * t;
          const d = (px - x) * (px - x) + (pz - z) * (pz - z);
          if (d < bd && (!filter || filter(this.edges[e]))) { bd = d; be = e; bs = s; bt = t; bx = px; bz = pz; }
        }
      }
    if (be < 0) return null;
    return { edge: be, t: this.edgeParam(be, bs, bt), x: bx, z: bz, distKm: Math.sqrt(bd) };
  }

  /** km entlang Kante bis Segment seg + Anteil t -> normierter Parameter 0..1 */
  private edgeParam(e: number, seg: number, t: number): number {
    const g = this.edges[e].geom;
    let s = 0;
    for (let k = 0; k < seg; k++) s += Math.hypot(g[k * 2 + 2] - g[k * 2], g[k * 2 + 3] - g[k * 2 + 1]);
    s += t * Math.hypot(g[seg * 2 + 2] - g[seg * 2], g[seg * 2 + 3] - g[seg * 2 + 1]);
    const L = this.edges[e].lengthKm;
    return L > 0 ? Math.min(1, s / L) : 0;
  }

  /** Punkt bei Parameter t (0..1) auf Kante */
  pointOnEdge(edgeId: number, t: number, out: [number, number] = [0, 0]): [number, number] {
    const e = this.edges[edgeId], g = e.geom;
    let rem = t * e.lengthKm;
    for (let k = 0; k + 3 < g.length; k += 2) {
      const l = Math.hypot(g[k + 2] - g[k], g[k + 3] - g[k + 1]);
      if (rem <= l || k + 4 >= g.length) {
        const f = l > 0 ? Math.min(1, rem / l) : 0;
        out[0] = g[k] + (g[k + 2] - g[k]) * f;
        out[1] = g[k + 1] + (g[k + 3] - g[k + 1]) * f;
        return out;
      }
      rem -= l;
    }
    out[0] = g[0]; out[1] = g[1];
    return out;
  }

  setEdgeOpen(edgeId: number, open: boolean): void {
    const e = this.edges[edgeId];
    if (!e || e.open === open) return;
    e.open = open;
    this.version++;
    bus.emit('nav:edge', { edgeId, open });
  }

  /** Kanten, deren Segmente die Rechteck-Zellen berühren (grobe Vorauswahl über Bounding-Boxen, ohne Duplikate). */
  edgesInRect(x0: number, z0: number, x1: number, z1: number, out: number[]): number[] {
    out.length = 0;
    if (x1 < x0) [x0, x1] = [x1, x0];
    if (z1 < z0) [z0, z1] = [z1, z0];
    const gen = ++this.stampGen;
    if (gen === 0xffffffff) { this.edgeStamp.fill(0); this.stampGen = 1; }
    const i0 = this.ci(x0), i1 = this.ci(x1), j0 = this.cj(z0), j1 = this.cj(z1);
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const c = j * this.hw + i;
        for (let k = this.sStart[c]; k < this.sStart[c + 1]; k++) {
          const e = this.sEdge[k];
          if (this.edgeStamp[e] === this.stampGen) continue;
          // Segment-Bounding-Box gegen Rechteck
          const g = this.edges[e].geom, s = this.sSeg[k] * 2;
          if (Math.max(g[s], g[s + 2]) < x0 || Math.min(g[s], g[s + 2]) > x1 || Math.max(g[s + 1], g[s + 3]) < z0 || Math.min(g[s + 1], g[s + 3]) > z1) continue;
          this.edgeStamp[e] = this.stampGen;
          out.push(e);
        }
      }
    return out;
  }
}
