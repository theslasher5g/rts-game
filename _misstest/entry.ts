import '../src/ui/styles.css';
import '@fontsource/share-tech-mono';
import { bus } from '../src/core/EventBus';
import { MissionSystem } from '../src/game/missions/MissionSystem';
import { CAMPAIGN } from '../src/game/missions/campaign';
import { Tutorial } from '../src/game/missions/Tutorial';
import { MissionPanel, CampaignMenu } from '../src/ui/MissionPanel';
import { TutorialOverlay } from '../src/ui/TutorialOverlay';
import { EndScreen } from '../src/ui/EndScreen';

const bases = new Map<number, any>();
let bid = 1;
const addBase = (kind: string, owner: string) => bases.set(bid, { id: bid++, kind, owner, progress: 1 });
addBase('hq','VAL'); addBase('refinery','VAL'); addBase('hq','KRN'); addBase('refinery','KRN');
const fields = [{ id: 1, name: 'Feld Karsten-8', country: 'KRN', owner: 'KRN', x: 171, z: 79 }, { id: 3, name: 'Medved', country: 'VAL', owner: 'VAL', x: 135, z: 61 }];
const units: any[] = [{ id: 1, owner: 'VAL', hp: 10, x: 0, z: 0, type: { id: 'mbt_medium', category: 'tank', damage: 5 }, orders: [] }];
const ctx: any = {
  geo: { meta: { scenario: { nations: [{ a3: 'VAL', capitalCity: 0, hq: [85,53], refinery: [84,52], spawn: [95,57] }, { a3: 'KRN', capitalCity: 1, hq: [248,75], refinery: [250,74], spawn: [255,87] }] } } },
  state: { speed: 3, playerA3: 'VAL' }, war: { isHostile: (a: string, b: string) => a !== b && (a === 'KRN' || b === 'KRN') }, player: () => 'VAL',
  units: { units, get: (id: number) => units.find((u) => u.id === id), spawn: () => null, remove() {}, issueMove() {}, queryRadius: (_x: number, _z: number, _r: number, o: any[]) => { o.length = 0; return o; } },
  economy: { bases, fields, countBases: (a: string, k: string) => [...bases.values()].filter((b) => b.owner === a && b.kind === k).length, pool: () => ({ barrels: 500, incomePerHour: 20 }) },
  civil: { cities: [{ id: 0, name: 'Valdorn', country: 'VAL', controller: 'VAL', x: 80, z: 55 }, { id: 1, name: 'Kronheim', country: 'KRN', controller: 'KRN', x: 252, z: 76 }], stats: { killed: 340 } },
};
const ui = document.getElementById('ui')!;
const ms = new MissionSystem(ctx);
const panel = new MissionPanel(ui, ms);
const end = new EndScreen(ui, ms);
const tut = new Tutorial({ ctx, getCameraDistance: () => 80 });
const ov = new TutorialOverlay(ui, tut);
const camp = new CampaignMenu(ui);
const q = new URLSearchParams(location.search).get('s');
if (q === 'panel' || q === 'tut' || q === 'end' || q === 'defeat') {
  ms.load(CAMPAIGN[2]);
  bus.emit('oil:delivered', { owner: 'VAL', barrels: 120, fieldId: 3 });
  fields[0].owner = 'VAL';
  for (let i = 0; i < 40; i++) ms.update(0.03);
  panel.update(1);
}
if (q === 'tut') { tut.start(); bus.emit('units:selection', { ids: [1] }); tut.next(); tut.next(); tut.next(); }
if (q === 'end') { ms.load(CAMPAIGN[0]); for (let i = 0; i < 4; i++) bus.emit('oil:delivered', { owner: 'VAL', barrels: 120, fieldId: 3 }); for (let i = 0; i < 40; i++) ms.update(0.1); end.onAction = () => true; (end as any).showReport(ms.report(), ms.objectives); }
if (q === 'defeat') { ms.load(CAMPAIGN[1]); for (const [id, b] of bases) if (b.owner === 'VAL' && b.kind === 'hq') bases.delete(id); for (let i = 0; i < 40; i++) ms.update(0.1); (end as any).showReport({ ...ms.report(), warCrimes: 2 }, ms.objectives); }
if (q === 'camp') { try { localStorage.setItem('ww3.campaign', JSON.stringify({ done: ['m1', 'm2'] })); } catch {} camp.open(); }
(window as any).done = true;
