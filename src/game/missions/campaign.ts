/**
 * Kampagne „Nordadria": 7 Missionen auf derselben Karte, dazu Freies Spiel (Skirmish) und Fortschritt (localStorage 'ww3.campaign').
 * Ziele nutzen Selektoren statt fester Feld-/Stadt-IDs ('contested' = Feld/Stadt nahe der Frontmitte), damit sie
 * auch auf anderen Kartenseeds funktionieren. Zeiten in Spielstunden.
 */
import type { MissionDef } from './types';

const KEY = 'ww3.campaign';

export const CAMPAIGN: MissionDef[] = [
  {
    id: 'm1',
    name: 'Erste Fässer',
    blurb: 'Tutorial: Einheiten führen, Ölfluss verstehen, erste Produktion. Der Feind hält still.',
    briefing: [
      'LAGE: Kronland hat die Grenze überschritten, doch an deiner Front ist es noch ruhig. Deine Raffinerie wartet auf Öl.',
      'AUFTRAG: Lerne die Grundlagen und bringe 400 Fässer per Tankwagen-Konvoi zur Raffinerie.',
      'AUFTRAG: Optional – baue mit den Pionieren einen Schützengraben und errichte eine Kaserne.',
      'HINWEIS: Öl ist die einzige Währung. Folge den Anweisungen unten links; Schritte lassen sich überspringen.',
    ],
    playerNation: 'VAL',
    enemies: ['KRN'],
    startOverride: { barrels: 500, enemyStrength: 0.5, extraUnits: [{ typeId: 'engineer_squad', count: 2, near: 'hq' }] },
    ai: { difficulty: 'leicht', hold: true },
    objectives: [
      { id: 'deliver', kind: 'deliverBarrels', total: 400, text: 'Liefere 400 Fässer an die Raffinerie' },
      { id: 'trench', kind: 'buildStructures', count: 1, role: 'secondary', text: 'Baue einen Graben oder Sandsäcke (Pioniere)' },
      { id: 'barracks', kind: 'buildBase', base: 'barracks', role: 'secondary', text: 'Baue eine Kaserne' },
    ],
    tutorial: true,
    loseWhenNoForces: false,
  },
  {
    id: 'm2',
    name: 'Die Brücke',
    blurb: 'Kronländische Kolonnen rollen über die Straßen. Sprenge eine Brücke und halte die Linie.',
    briefing: [
      'LAGE: Kronländische Panzerkolonnen marschieren auf der Hauptstraße nach Westen. Sie sind auf Brücken angewiesen.',
      'AUFTRAG: Sprenge mindestens eine Brücke zwischen den Fronten und vernichte 10 Feindfahrzeuge.',
      'AUFTRAG: Dein Hauptquartier darf nicht fallen. Optional: baue drei Stellungen.',
      'HINWEIS: Pioniere sprengen Brücken (J) und reparieren sie (L). Sprenge erst, wenn der Feind sie erreicht – deine eigenen Konvois brauchen sie auch.',
    ],
    playerNation: 'VAL',
    enemies: ['KRN'],
    startOverride: { barrels: 500, enemyStrength: 0.7, extraUnits: [{ typeId: 'engineer_squad', count: 3, near: 'hq' }, { typeId: 'at_team', count: 3, near: 'hq' }] },
    ai: { difficulty: 'leicht' },
    objectives: [
      { id: 'bridge', kind: 'blowBridges', count: 1, area: { at: 'midpoint', radiusKm: 80 }, text: 'Sprenge eine Brücke an der Front' },
      { id: 'kills', kind: 'killUnits', count: 10, text: 'Vernichte 10 Feindeinheiten' },
      { id: 'hq', kind: 'keepBase', base: 'hq', text: 'Halte das Hauptquartier' },
      { id: 'build', kind: 'buildStructures', count: 3, role: 'secondary', text: 'Baue 3 Stellungen (Gräben, Sandsäcke, Bunker)' },
    ],
    waves: [
      { atHours: 1.5, units: [['light_tank', 3], ['inf_squad', 3]], target: 'ownHq', distKm: 110, label: 'Kolonne auf der Hauptstraße gesichtet!' },
      { atHours: 4, units: [['mbt_medium', 3], ['ifv', 2], ['inf_squad', 3]], target: 'ownHq', distKm: 110, label: 'Zweite Kolonne rückt vor!' },
    ],
    timeLimitHours: 12,
  },
  {
    id: 'm3',
    name: 'Ölfeld Karsten',
    blurb: 'Erobere das umkämpfte Feld in der Kartenmitte und halte die Straße für deine Tankwagen offen.',
    briefing: [
      'LAGE: Das große Feld in der Kartenmitte (Feld Karsten) liegt in kronländischer Hand und bringt dem Gegner täglich Fässer.',
      'AUFTRAG: Nimm das Feld und halte es mindestens eine Stunde.',
      'AUFTRAG: Danach muss die Förderung fließen: bringe 3 Tankwagen-Ladungen zur Raffinerie.',
      'HINWEIS: Das Feld wird von kleinen Vorposten gehalten. Der Gegner wird kontern – bring Panzerabwehr mit und halte die Straße frei.',
    ],
    playerNation: 'VAL',
    enemies: ['KRN'],
    startOverride: {
      barrels: 700, enemyStrength: 0.8, spawnEnemyNearFields: true,
      extraUnits: [{ typeId: 'mbt_medium', count: 2, near: 'spawn' }, { typeId: 'ifv', count: 2, near: 'spawn' }, { typeId: 'at_team', count: 2, near: 'spawn' }],
    },
    ai: { difficulty: 'mittel' },
    objectives: [
      { id: 'field', kind: 'captureFields', from: 'contested', count: 1, holdHours: 1, text: 'Erobere und halte {feld} (1 h)' },
      { id: 'supply', kind: 'deliverLoads', count: 3, after: ['field'], text: 'Liefere 3 Ladungen Öl an die Raffinerie' },
      { id: 'hq', kind: 'keepBase', base: 'hq', text: 'Halte das Hauptquartier' },
      { id: 'raid', kind: 'destroyConvoys', count: 2, role: 'secondary', text: 'Fange 2 feindliche Konvois ab' },
    ],
    waves: [{ atHours: 5, units: [['light_tank', 4], ['inf_squad', 4], ['at_team', 2]], target: 'contested', distKm: 55, label: 'Kronländischer Gegenstoß auf das Ölfeld!' }],
    timeLimitHours: 16,
  },
  {
    id: 'm4',
    name: 'Abschneiden',
    blurb: 'Als Marenia: Brücken sprengen, Konvois überfallen – Kronlands Ölstrom auf unter 30 % drücken.',
    briefing: [
      'LAGE: Kronland führt Panzer und Munition über wenige Straßen heran. Sein Öleinkommen hält die Offensive am Laufen.',
      'AUFTRAG: Drücke das Einkommen des Gegners für 3 Stunden unter 30 % seines Höchstwerts.',
      'AUFTRAG: Sprenge Brücken und überfalle Tankwagen-Konvois – schnelle Aufklärer und Hubschrauber sind dafür ideal.',
      'HINWEIS: Der Gegner repariert Brücken und schickt neue Konvois. Halte den Druck aufrecht. Du spielst als Marenia, Valdoria ist verbündet.',
    ],
    playerNation: 'MAR',
    enemies: ['KRN'],
    startOverride: {
      barrels: 800, enemyStrength: 0.9,
      extraUnits: [{ typeId: 'recon_wheeled', count: 3, near: 'spawn' }, { typeId: 'attack_heli', count: 2, near: 'spawn' }, { typeId: 'engineer_squad', count: 2, near: 'spawn' }],
    },
    ai: { difficulty: 'mittel' },
    objectives: [
      { id: 'cut', kind: 'cutIncome', belowPct: 0.3, hours: 3, text: 'Kronlands Einkommen 3 h unter 30 % drücken' },
      { id: 'convoys', kind: 'destroyConvoys', count: 5, role: 'secondary', text: 'Zerstöre 5 feindliche Konvois' },
      { id: 'bridges', kind: 'blowBridges', count: 2, role: 'secondary', text: 'Sprenge 2 Brücken' },
      { id: 'hq', kind: 'keepBase', base: 'hq', text: 'Halte das Hauptquartier' },
    ],
    timeLimitHours: 22,
  },
  {
    id: 'm5',
    name: 'Verteidigung der Hauptstadt',
    blurb: 'Kronland greift in Wellen Valdorn an. Halte die Hauptstadt, bis die Verstärkung eintrifft.',
    briefing: [
      'LAGE: Die Front ist gebrochen. Kronländische Verbände sammeln sich zum Sturm auf Valdorn.',
      'AUFTRAG: Halte die Hauptstadt und das Hauptquartier 8 Stunden lang gegen mehrere Angriffswellen.',
      'AUFTRAG: Optional – vernichte 30 Feindeinheiten.',
      'HINWEIS: Gräben, Sandsäcke und Panzerabwehr in den Zufahrten machen den Unterschied. Mit jeder Welle wird es härter; produziere rechtzeitig.',
    ],
    playerNation: 'VAL',
    enemies: ['KRN'],
    startOverride: {
      barrels: 600, enemyStrength: 0.7,
      extraUnits: [{ typeId: 'mbt_medium', count: 3, near: 'hq' }, { typeId: 'at_team', count: 4, near: 'hq' }, { typeId: 'inf_squad', count: 4, near: 'hq' }, { typeId: 'engineer_squad', count: 2, near: 'hq' }],
    },
    ai: { difficulty: 'schwer' },
    objectives: [
      { id: 'survive', kind: 'surviveUntil', hours: 8, text: 'Halte Valdorn 8 Stunden' },
      { id: 'capital', kind: 'keepCity', city: 'ownCapital', text: 'Verliere die Hauptstadt nicht' },
      { id: 'hq', kind: 'keepBase', base: 'hq', text: 'Halte das Hauptquartier' },
      { id: 'kills', kind: 'killUnits', count: 30, role: 'secondary', text: 'Vernichte 30 Feindeinheiten' },
    ],
    waves: [
      { atHours: 1, units: [['light_tank', 3], ['inf_squad', 3]], target: 'ownCapital', label: 'Welle 1 nähert sich Valdorn.' },
      { atHours: 2.5, units: [['mbt_medium', 3], ['ifv', 2], ['inf_squad', 3]], target: 'ownCapital', label: 'Welle 2: Panzer und Schützenpanzer!' },
      { atHours: 4, units: [['mbt_medium', 4], ['sp_artillery', 2], ['ifv', 3]], target: 'ownCapital', label: 'Welle 3: Artillerie und schwere Panzer!' },
      { atHours: 5.5, units: [['mbt_heavy', 3], ['ifv', 3], ['inf_squad', 4], ['at_team', 2]], target: 'ownCapital', label: 'Welle 4: Großangriff auf Valdorn!' },
      { atHours: 7, units: [['mbt_heavy', 4], ['mbt_medium', 4], ['ifv', 4]], target: 'ownCapital', label: 'Letzte Welle: alles, was Kronland hat!' },
    ],
    timeLimitHours: 11,
  },
  {
    id: 'm6',
    name: 'Gegenstoß',
    blurb: 'Die Verstärkung ist da. Stoße nach Osten vor und zerstöre die kronländische Raffinerie.',
    briefing: [
      'LAGE: Der Angriff ist abgewehrt, Verstärkung ist eingetroffen. Kronland ist geschwächt, aber nicht geschlagen.',
      'AUFTRAG: Zerstöre die Raffinerie von Kronland – ohne sie fließt dort kein Öl mehr in die Produktion.',
      'AUFTRAG: Optional – erobere zwei feindliche Ölfelder, um den eigenen Nachschub zu sichern.',
      'HINWEIS: Der Weg ist weit. Schütze deine Tankwagen-Konvois, nimm Artillerie mit und lass Pioniere zerstörte Brücken instand setzen.',
    ],
    playerNation: 'VAL',
    enemies: ['KRN'],
    startOverride: {
      barrels: 900, enemyStrength: 0.9,
      extraUnits: [{ typeId: 'mbt_heavy', count: 3, near: 'spawn' }, { typeId: 'ifv', count: 3, near: 'spawn' }, { typeId: 'sp_artillery', count: 2, near: 'spawn' }, { typeId: 'engineer_squad', count: 2, near: 'spawn' }],
    },
    ai: { difficulty: 'schwer' },
    objectives: [
      { id: 'refinery', kind: 'destroyBase', base: 'refinery', text: 'Zerstöre die Raffinerie Kronlands' },
      { id: 'fields', kind: 'captureFields', from: 'enemy', count: 2, holdHours: 1, role: 'secondary', text: 'Erobere 2 feindliche Ölfelder' },
      { id: 'hq', kind: 'keepBase', base: 'hq', text: 'Halte das Hauptquartier' },
    ],
    timeLimitHours: 26,
  },
  {
    id: 'm7',
    name: 'Entscheidung',
    blurb: 'Totaler Krieg: Zerstöre Raffinerie und Hauptquartier Kronlands und halte deine eigenen.',
    briefing: [
      'LAGE: Kronland wirft alles in die Waagschale, auch am Boden und an den Ölfeldern herrscht offener Krieg.',
      'AUFTRAG: Zerstöre Raffinerie UND Hauptquartier von Kronland.',
      'AUFTRAG: Deine eigene Raffinerie und dein Hauptquartier dürfen nicht beide fallen. Marenia unterstützt dich.',
      'HINWEIS: Kombiniere alles – Konvois schützen, Brücken sprengen, Felder nehmen, Artillerie und Luftschläge. Wer das Öl kontrolliert, gewinnt.',
    ],
    playerNation: 'VAL',
    enemies: ['KRN'],
    startOverride: { barrels: 700, enemyStrength: 1.3, spawnEnemyNearFields: true },
    ai: { difficulty: 'schwer' },
    objectives: [
      { id: 'decisive', kind: 'all', text: 'Zerstöre Raffinerie und Hauptquartier Kronlands', children: [
        { id: 'refinery', kind: 'destroyBase', base: 'refinery', text: 'Raffinerie Kronlands zerstören' },
        { id: 'hq', kind: 'destroyBase', base: 'hq', text: 'Hauptquartier Kronlands zerstören' },
      ] },
      { id: 'fields', kind: 'captureFields', from: 'enemy', count: 3, holdHours: 1, role: 'secondary', text: 'Erobere 3 feindliche Ölfelder' },
      { id: 'kills', kind: 'killUnits', count: 40, role: 'secondary', text: 'Vernichte 40 Feindeinheiten' },
    ],
    timeLimitHours: 40,
  },
];

export function getMission(id: string): MissionDef | undefined {
  return CAMPAIGN.find((m) => m.id === id);
}

/** Freies Spiel: Raffinerie und Hauptquartier des Gegners zerstören; verlieren, wenn beide eigenen fallen */
export function skirmishMission(playerA3: string): MissionDef {
  const enemies = playerA3 === 'KRN' ? ['VAL', 'MAR'] : ['KRN'];
  return {
    id: 'skirmish',
    name: 'Freies Spiel',
    blurb: 'Ohne Kampagne: zerstöre Raffinerie und Hauptquartier des Gegners.',
    briefing: [
      'Zerstöre Raffinerie und Hauptquartier des Gegners.',
      'Verlierst du Hauptquartier und Raffinerie, ist der Krieg verloren.',
    ],
    playerNation: playerA3,
    enemies,
    ai: { difficulty: 'mittel' },
    objectives: [
      { id: 'decisive', kind: 'all', text: 'Zerstöre Raffinerie und Hauptquartier des Gegners', children: [
        { id: 'refinery', kind: 'destroyBase', base: 'refinery', text: 'Gegnerische Raffinerie zerstören' },
        { id: 'hq', kind: 'destroyBase', base: 'hq', text: 'Gegnerisches Hauptquartier zerstören' },
      ] },
    ],
    skirmish: true,
  };
}

// ------------------------------------------------------------------ Fortschritt

function readDone(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const o = JSON.parse(raw) as { done?: unknown };
    return Array.isArray(o.done) ? o.done.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function completedMissions(): string[] {
  return readDone();
}

export function isCompleted(id: string): boolean {
  return readDone().includes(id);
}

/** Mission 1 ist immer frei, jede weitere nach Abschluss der vorherigen */
export function isUnlocked(id: string): boolean {
  const i = CAMPAIGN.findIndex((m) => m.id === id);
  if (i < 0) return false;
  return i === 0 || readDone().includes(CAMPAIGN[i - 1].id);
}

export function markCompleted(id: string): void {
  const d = readDone();
  if (d.includes(id) || !CAMPAIGN.some((m) => m.id === id)) return;
  d.push(id);
  try {
    localStorage.setItem(KEY, JSON.stringify({ done: d }));
  } catch {
    /* kein localStorage */
  }
}

export function resetCampaignProgress(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignorieren */
  }
}

/** Id der Folgemission (oder null nach der letzten) */
export function nextMissionId(id: string): string | null {
  const i = CAMPAIGN.findIndex((m) => m.id === id);
  return i >= 0 && i + 1 < CAMPAIGN.length ? CAMPAIGN[i + 1].id : null;
}

/** Auswahldaten für das Menü */
export interface MissionListEntry {
  id: string;
  name: string;
  blurb: string;
  playerNation: string;
  difficulty: string;
  state: 'locked' | 'open' | 'done';
}

export function missionList(): MissionListEntry[] {
  const done = readDone();
  return CAMPAIGN.map((m, i) => ({
    id: m.id,
    name: m.name,
    blurb: m.blurb,
    playerNation: m.playerNation,
    difficulty: m.ai.difficulty,
    state: done.includes(m.id) ? 'done' : i === 0 || done.includes(CAMPAIGN[i - 1].id) ? 'open' : 'locked',
  }));
}

/** Mission zur Id: Kampagne oder (id 'skirmish') freies Spiel */
export function resolveMission(id: string | undefined, playerA3: string): MissionDef {
  return (id ? getMission(id) : undefined) ?? skirmishMission(playerA3);
}
