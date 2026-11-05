import '@fontsource/share-tech-mono';
import './ui/styles.css';
import './control/styles-control.css';
import './ui/civil.css';
import './ui/production.css';

import { bus } from './core/EventBus';
import { Input } from './core/Input';
import type { Settings } from './core/types';
import { RTSCamera } from './camera/RTSCamera';
import { SelectionController } from './control/SelectionController';
import { AICommander } from './ai/AICommander';
import { AbilitySystem } from './abilities/AbilitySystem';
import { AbilityBar } from './ui/AbilityBar';
import { AlertSource } from './ui/AlertSource';
import { EventLog } from './ui/EventLog';
import { FieldBars } from './ui/FieldBars';
import { Sfx } from './audio/Sfx';
import { NetGame } from './net/NetGame';
import { FogOfWar } from './fog/FogOfWar';
import type { GameContext } from './game/context';
import { mpDiplomacy } from './game/scenario';
import { MissionSystem, Tutorial, nextMissionId, resolveMission } from './game/missions';
import { EndScreen } from './ui/EndScreen';
import { ProtectBanner } from './ui/ProtectBanner';
import { MissionPanel } from './ui/MissionPanel';
import { TutorialOverlay } from './ui/TutorialOverlay';
import { EconomyAI } from './logistics/EconomyAI';
import { OilEconomy } from './logistics/OilEconomy';
import { SupplySystem } from './logistics/SupplySystem';
import { ProductionSystem } from './production/ProductionSystem';
import { ProductionPanel } from './ui/ProductionPanel';
import { CivilianSystem } from './civil/CivilianSystem';
import { Occupation } from './civil/Occupation';
import { ProtectionSystem } from './civil/ProtectionSystem';
import { Reputation } from './game/Reputation';
import { CivilPanel } from './ui/CivilPanel';
import { CombatSystem } from './combat/CombatSystem';
import { Effects } from './fx/Effects';
import { START_PROFILES, applyDiplomacyMode, getProfile } from './game/countryData';
import { War } from './game/War';
import { BridgeRenderer } from './structures/BridgeRenderer';
import { StructureManager } from './structures/StructureManager';
import { CoverSystem } from './tactics/CoverSystem';
import { TacticsSystem } from './tactics/TacticsSystem';
import { GameState } from './game/GameState';
import { NavGraph } from './nav/NavGraph';
import { Pathfinder } from './nav/Pathfinder';
import { RoadRenderer } from './nav/RoadRenderer';
import { UnitManager } from './units/UnitManager';
import { UnitRenderer } from './units/UnitRenderer';
import { UnitPanel } from './ui/UnitPanel';
import { GameRenderer } from './render/GameRenderer';
import { Hud } from './ui/Hud';
import { Labels } from './ui/Labels';
import { hideLoading, setLoading, showLoadingError } from './ui/Loading';
import { MainMenu } from './ui/MainMenu';
import { Minimap } from './ui/Minimap';
import { SettingsPanel, loadSettings } from './ui/SettingsPanel';
import { Cities } from './world/Cities';
import { WorldDetail } from './world/WorldDetail';
import { GeoData } from './world/GeoData';
import { Picker } from './world/Picker';
import { Terrain } from './world/Terrain';
import { Water } from './world/Water';

async function boot() {
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
  const uiRoot = document.getElementById('ui') as HTMLElement;
  const labelRoot = document.getElementById('labels') as HTMLElement;

  const settings: Settings = loadSettings();
  const geo = await GeoData.load(undefined, setLoading);
  setLoading(0.93, 'Lade Straßen- und Schienennetz…');
  const graph = await NavGraph.load(geo);
  const pathfinder = new Pathfinder(geo, graph);

  // --- Welt & Rendering
  const gfx = new GameRenderer(canvas, settings);
  const terrain = new Terrain(geo, settings);
  const water = new Water(geo, settings, terrain.heightTexture);
  const cities = new Cities(geo, settings);
  const worldDetail = new WorldDetail(geo, settings, cities, graph);
  gfx.scene.add(worldDetail.object);
  const roads = new RoadRenderer(geo, graph, settings);
  gfx.scene.add(terrain.object, water.object, roads.object, cities.object);

  // --- Kamera & Eingabe
  const input = new Input(canvas);
  const rts = new RTSCamera(canvas, input, geo, settings);
  const picker = new Picker(geo, settings);

  // --- Einheiten (Phase 2)
  const units = new UnitManager(geo, pathfinder, settings);
  const unitRenderer = new UnitRenderer(units, geo, settings);
  gfx.scene.add(unitRenderer.object);
  const ctl = new SelectionController({ canvas, uiRoot, input, rts, picker, units, unitRenderer, geo, settings });
  ctl.enabled = false;
  gfx.scene.add(ctl.object);
  const unitPanel = new UnitPanel(uiRoot, units, ctl);

  // --- Kampf, Taktik, Bauwerke, Effekte (Phase 3)
  const war = new War();
  const cover = new CoverSystem(geo, settings);
  const tactics = new TacticsSystem({ geo, units, cover, isHostile: (a, b) => war.isHostile(a, b), settings });
  const structures = new StructureManager(geo, units, graph, cities, settings);
  structures.setWar(war);
  const bridges = new BridgeRenderer(geo, graph, settings);
  const effects = new Effects(geo, settings);
  const sfx = new Sfx();
  // Krater auf Straßen bekommen Asphaltfarbe
  effects.setRoadQuery((x, z) => graph.nearestEdgePoint(x, z, 0.02) !== null);
  const combat = new CombatSystem({ geo, units, war, settings, smoke: effects.smoke, cover, buildings: cities, structures });
  gfx.scene.add(structures.object, bridges.object, effects.object);

  // --- Zivilisten, Schutzstatus, Ansehen, Besatzung (Phase 4)
  const civil = new CivilianSystem({ geo, units, graph, pathfinder, cities, settings });
  gfx.scene.add(civil.object);
  const playerOf = () => state.playerA3;
  const protection = new ProtectionSystem({ civil, war, units, player: playerOf });
  combat.setProviders({ protection });
  const reputation = new Reputation({ war, civil, player: playerOf, protection });
  const occupation = new Occupation({ civil, units, war });
  const civilPanel = new CivilPanel(uiRoot, civil, reputation, playerOf);
  civilPanel.setOccupation(occupation);
  // Panel startet zugeklappt; der Umschalter erscheint erst im Spiel
  const civilToggle = uiRoot.querySelector('.cv-toggle') as HTMLElement | null;
  if (civilToggle) civilToggle.style.display = 'none';
  units.roadSpeedFactor = (x, z) => civil.speedFactorAt(x, z);

  // --- Öl-Wirtschaft, Nachschub, Produktion (Phase 5)
  const economy = new OilEconomy({ geo, units, pathfinder, war, settings });
  economy.setCivil(civil);
  const supply = new SupplySystem({ geo, units, economy, pathfinder, war, settings, getPlayer: playerOf });
  const production = new ProductionSystem({ geo, units, economy, cities, settings });
  const econAI = new EconomyAI({ geo, economy, production, units, war, getPlayer: playerOf });
  gfx.scene.add(economy.object, production.object);
  ctl.cc.services = { combat, structures, cities, war, protection };
  const unlockAudio = () => sfx.resume();
  window.addEventListener('pointerdown', unlockAudio, { once: true });
  window.addEventListener('keydown', unlockAudio, { once: true });
  bus.on('toast', ({ msg, kind }) => ctl.toast(msg, kind === 'error' ? 'bad' : kind ?? 'info'));

  // --- Spielzustand & UI
  const state = new GameState(geo);
  const labels = new Labels(labelRoot, geo, settings);
  const minimap = new Minimap(uiRoot, geo);
  const settingsPanel = new SettingsPanel(uiRoot, settings);
  const menu = new MainMenu(uiRoot, geo);
  const hud = new Hud(uiRoot, geo, state);
  const prodPanel = new ProductionPanel({ production, economy, supply, getPlayer: playerOf, hud, root: uiRoot, getSelectedIds: () => ctl.selectedUnits().map((u) => u.id) });

  // --- Spielkontext, Nebel des Krieges, KI, Missionen (Phase 6)
  const ctx: GameContext = { geo, state, war, units, combat, economy, production, supply, civil, structures, cities, graph, pathfinder, player: playerOf };
  const fog = new FogOfWar(geo, units, { player: playerOf, allies: (a3) => getProfile(a3)?.allies ?? [], smoke: effects.smoke });
  fog.bindTerrain(terrain);
  fog.attachEconomy(economy);
  unitRenderer.setFog(fog);
  combat.setFog(fog);
  minimap.setFog(fog);
  ctl.isUnitVisible = (u) => fog.isUnitVisible(u);
  fog.applySettings(settings);
  const missions = new MissionSystem(ctx);
  missions.getWarCrimes = () => reputation.totalWarCrimes();
  const missionPanel = new MissionPanel(uiRoot, missions);
  const endScreen = new EndScreen(uiRoot, missions);
  const tutorial = new Tutorial({ ctx, getCameraDistance: () => rts.distance, getSelectedIds: () => ctl.selectedUnits().map((u) => u.id) });
  const tutorialOverlay = new TutorialOverlay(uiRoot, tutorial);
  const protectBanner = new ProtectBanner(uiRoot, state);

  // --- Fähigkeiten, Funkprotokoll, Ölfeld-Balken (Phase 7)
  const nationColour = (a3: string) => getProfile(a3)?.color ?? '#cccccc';
  const alliesOfPlayer = () => getProfile(state.playerA3 ?? '')?.allies ?? [];
  const abilities = new AbilitySystem(ctx, { combat, fog, protection, exag: settings.heightExaggeration });
  // Während des Grenzschutzes sind Kampffähigkeiten gesperrt (kein Gefecht)
  const abilityPort = {
    defs: abilities.defs,
    use: (a3: string, id: string, x: number, z: number) => {
      const def = abilities.def(id);
      if (war.ceasefire && def?.damaging) return { ok: false, reason: 'Grenzschutz läuft – keine Kampffähigkeiten' };
      return abilities.use(a3, id, x, z);
    },
    cooldownLeft: (a3: string, id: string) => abilities.cooldownLeft(a3, id),
    checkTarget: (a3: string, id: string, x: number, z: number) => abilities.checkTarget(a3, id, x, z),
  };
  const toNdc = (cx: number, cy: number) => {
    const r = canvas.getBoundingClientRect();
    return picker.pick(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1, rts.camera);
  };
  const abilityBar = new AbilityBar(uiRoot, {
    abilities: abilityPort,
    getPlayer: playerOf,
    getBarrels: () => (state.playerA3 ? economy.pool(state.playerA3).barrels : 0),
    getCamera: () => rts.camera,
    canvas,
    pick: (cx, cy) => toNdc(cx, cy),
    groundY: (x, z) => picker.groundY(x, z),
    getGameHours: () => state.date.getTime() / 3.6e6,
    keys: ctl,
  });
  const eventLog = new EventLog(uiRoot, {
    getPlayer: playerOf,
    getAllies: alliesOfPlayer,
    getTimeLabel: () => state.date.toISOString().slice(11, 16),
    minimap,
  });
  const alerts = new AlertSource(ctx, playerOf, alliesOfPlayer);
  void alerts;
  const fieldBars = new FieldBars(uiRoot, economy, () => rts.camera, nationColour, { groundY: (x, z) => picker.groundY(x, z), isVisible: (x, z) => fog.isExplored(x, z) });
  ctl.baseProvider = () => (state.playerA3 ? economy.basesOf(state.playerA3) : []);
  // Grenzschutz: Gebiet von Verbündeten ist für eigene Einheiten offen
  units.borderFriendly = (owner, a3) => !!getProfile(owner)?.allies.includes(a3) || !!getProfile(a3)?.allies.includes(owner);
  let protectActive = false;
  const syncProtection = () => {
    const on = state.borderProtectSec > 0 && !!state.playerA3;
    if (on === protectActive) return;
    protectActive = on;
    war.ceasefire = on;
    units.borderClosed = on;
    combat.invalidateHostility();
    if (!on && state.playerA3) {
      // Schutz beendet: Kriegszustand neu bekannt machen (Caches von KI, Kampf, Ansehen) und melden
      for (const [a, b] of war.listPairs()) bus.emit('war:declared', { a, b });
      bus.emit('alert', { a3: state.playerA3, kind: 'danger', text: 'Grenzschutz beendet – die Grenzen sind offen, der Krieg beginnt' });
      bus.emit('toast', { msg: 'Grenzschutz beendet – der Krieg beginnt', kind: 'warn' });
    }
  };
  const ais: AICommander[] = [];
  // Mehrspieler (Host-autoritativ): null im Einzelspiel
  let net: NetGame | null = null;
  let aiHeld = false;
  endScreen.onAction = (a) => {
    if (a === 'menu') return false;
    const cur = missions.current;
    const id = a === 'next' && cur ? nextMissionId(cur.id) : cur?.id;
    if (!id || !cur) return false;
    try {
      sessionStorage.setItem('ww3.autostart', `${id}|${cur.playerNation}`);
    } catch {
      /* ignorieren */
    }
    location.reload();
    return true;
  };
  void settingsPanel;

  let hoveredId = 0;
  let selectedId = 0;
  let playerId = 0;

  // --- Ereignisverdrahtung
  bus.on('settings:changed', ({ settings: s }) => {
    gfx.applySettings(s);
    terrain.applySettings(s);
    water.applySettings(s);
    cities.applySettings(s);
    roads.applySettings(s);
    units.applySettings(s);
    unitRenderer.applySettings(s);
    structures.applySettings(s);
    economy.applySettings(s);
    fog.applySettings(s);
    abilities.applySettings(s);
    production.applySettings(s);
    civil.applySettings(s);
    worldDetail.applySettings(s);
    bridges.applySettings(s);
    effects.applySettings(s);
    combat.applySettings(s);
    cover.applySettings(s);
    tactics.applySettings(s);
    rts.applySettings(s);
    picker.applySettings(s);
    labels.applySettings(s);
  });
  bus.on('country:select', ({ id }) => {
    selectedId = id;
    terrain.setSelected(id);
    labels.setSelected(id);
  });
  bus.on('camera:focus', ({ x, z, distance }) => rts.focus(x, z, distance));
  bus.on('game:start', ({ countryA3, missionId, mp }) => {
    // Diplomatie je Modus: Kampagne/Gefecht (Pannonien neutral), außer wenn man selbst Pannonien spielt (2 gegen 2)
    const session = mp ? menu.lobbyPanel?.session ?? null : null;
    const mpInfo = session?.startInfo ?? null;
    applyDiplomacyMode(mp ? mp.mode : countryA3 === 'PAN' ? 'teams' : 'campaign');
    const c = geo.countriesByA3.get(countryA3);
    playerId = c?.id ?? 0;
    state.startGame(countryA3);
    terrain.setPlayer(playerId);
    labels.setPlayer(playerId);
    menu.hide();
    hud.show();
    minimap.show();
    // Streitkräfte: eigene + KI-Garnisonen der übrigen spielbaren Nationen
    ctl.playerA3 = countryA3;
    ctl.enabled = true;
    unitPanel.show();
    if (civilToggle) civilToggle.style.display = '';
    const isGuest = !!mp && mp.role === 'guest';
    for (const [a, b] of mp ? mpDiplomacy(mp.mode).wars : state.scenarioWars()) war.declare(a, b);
    // Gäste erzeugen keine Einheiten: der Host schickt sie per Schnappschuss
    if (!isGuest) for (const p of START_PROFILES) units.spawnStartingForces(p.a3, p.a3 === countryA3);
    economy.loadScenario(geo.meta.scenario);
    prodPanel.show();
    abilityBar.show();
    eventLog.clear();
    eventLog.show();
    // Mission, Nebel, KI-Befehlshaber
    const def = resolveMission(missionId, countryA3);
    fog.setEnabled(settings.fogOfWar !== false);
    // Startaufklärung: Umgebung des HQ und die eigenen Ölfelder sind als „erkundet“ bekannt (Terrain sichtbar, Gegner nicht)
    const startMeta = geo.meta.scenario?.nations.find((n) => n.a3 === countryA3);
    if (startMeta) {
      fog.revealArea(startMeta.hq[0], startMeta.hq[1], 22);
      for (const f of economy.fields) if (f.owner === countryA3) fog.revealArea(f.x, f.z, 7);
    }
    fog.updateNow();
    if (!mp) missions.load(def);
    for (const a of ais) a.dispose();
    ais.length = 0;
    const wars = war.listPairs();
    // Mehrspieler: Nationen ohne Mensch werden (wenn gewünscht) vom Host per KI geführt, Gäste führen keine KI aus
    if (mp && mpInfo && !isGuest) {
      for (const a3 of mpInfo.aiNations) ais.push(new AICommander(ctx, { a3, difficulty: 'mittel', style: 'aggressor', econ: econAI }));
    }
    for (const p of mp ? [] : START_PROFILES) {
      if (p.a3 === countryA3) continue;
      const atWar = wars.some(([x, y]) => x === p.a3 || y === p.a3);
      const allied = !!getProfile(countryA3)?.allies.includes(p.a3);
      if (!atWar && !allied) continue; // neutrale Nationen (Pannonien in der Kampagne) bekommen keinen Befehlshaber
      ais.push(new AICommander(ctx, { a3: p.a3, difficulty: def.ai.difficulty, style: atWar ? 'aggressor' : 'defender', econ: econAI }));
    }
    aiHeld = false;
    // Grenzschutz: 10 Minuten Echtzeit im freien Gefecht (Kampagne: Zeitplan der Mission gilt)
    state.borderProtectSec = mp || def.id === 'skirmish' ? 600 : 0;
    syncProtection();
    if (!mp && missions.wantsTutorial) tutorial.start();
    // Netzwerk: Host rechnet, Gäste spiegeln (Befehle laufen per Proxy zum Host)
    if (net) net.dispose();
    net = null;
    endScreen.suppress = !!mp;
    if (mp && session && mpInfo) {
      net = new NetGame(ctx, session.transport, {
        role: mp.role,
        selfA3: countryA3,
        nationOfPeer: (peerId) => mpInfo.players.find((p) => p.id === peerId)?.a3 ?? null,
        aiNations: mpInfo.aiNations,
        seed: mp.seed,
        mode: mp.mode,
        reputation,
        abilities: abilities as unknown as { use: (...args: unknown[]) => unknown },
      });
    }
    const hq = geo.meta.scenario?.nations.find((n) => n.a3 === countryA3)?.hq;
    if (hq) rts.focus(hq[0], hq[1], 80);
    else if (c) rts.focus(c.label[0], c.label[1], 80);
  });

  // Mehrspieler: einfaches Ergebnis (Sieg/Niederlage für das eigene Team)
  bus.on('mission:ended', ({ result, reason }) => {
    if (!net) return;
    const el = document.createElement('div');
    el.style.cssText =
      'position:absolute;inset:0;z-index:60;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;' +
      "background:rgba(10,12,8,.78);font-family:'Share Tech Mono',monospace;color:#e8dfb4;text-align:center;";
    const h = document.createElement('div');
    h.style.cssText = `font-size:64px;letter-spacing:.3em;color:${result === 'victory' ? '#7fd26a' : '#d96a5a'};`;
    h.textContent = result === 'victory' ? 'SIEG' : 'NIEDERLAGE';
    const r = document.createElement('div');
    r.style.cssText = 'font-size:16px;max-width:560px;';
    r.textContent = reason;
    const b = document.createElement('button');
    b.className = 'btn btn-primary';
    b.textContent = 'Zurück zum Hauptmenü';
    b.addEventListener('click', () => location.reload());
    el.append(h, r, b);
    uiRoot.appendChild(el);
  });

  // Hover jedes Frame neu bestimmen (auch wenn sich nur die Kamera bewegt) – Picking kostet ~µs.
  const updateHover = () => {
    const hit = input.mouse.inside ? picker.pick(input.mouse.ndcX, input.mouse.ndcY, rts.camera) : null;
    const id = hit?.countryId ?? 0;
    if (id !== hoveredId) {
      hoveredId = id;
      terrain.setHover(id);
      hud.setHoverInfo(id);
      bus.emit('country:hover', { id });
    }
  };

  input.onClick((e) => {
    const { ndcX, ndcY, button, double } = e;
    if (button !== 0) return;
    if (abilityBar.isTargeting()) {
      const h = picker.pick(ndcX, ndcY, rts.camera);
      if (h && abilityBar.onMapClick(h.x, h.z)) return;
    }
    if (prodPanel.isTargeting()) {
      const h = picker.pick(ndcX, ndcY, rts.camera);
      if (h && prodPanel.onMapClick(h.x, h.z)) return;
    }
    if (ctl.handleClick(e)) return; // Einheit angeklickt / Befehlsmodus aktiv
    const hit = picker.pick(ndcX, ndcY, rts.camera);
    if (!hit) return;
    bus.emit('country:select', { id: hit.countryId });
    const city = civil.cityAt(hit.x, hit.z, 1.5);
    if (city) civilPanel.selectCity(city.id);
    if (double) rts.focus(hit.x, hit.z, Math.max(30, rts.distance * 0.35));
  });

  // --- Größe
  const resize = () => {
    const w = window.innerWidth, h = window.innerHeight;
    gfx.setSize(w, h);
    rts.setAspect(w / h);
  };
  window.addEventListener('resize', resize);
  resize();

  // --- Game-Loop
  let last = performance.now();
  const t0 = last;
  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const time = (now - t0) / 1000;

    rts.update(dt);
    updateHover();
    state.update(dt);
    net?.frame(dt, state.lastHours);
    syncProtection();
    protectBanner.update();
    units.update(state.lastHours);
    const gameSec = state.lastHours * 3600;
    // Der Kampf rechnet je Frame höchstens 3 Spielsekunden: genau diese Rate muss die Effekt-Darstellung kennen
    effects.timeScale = dt > 0 ? Math.max(1, Math.min(gameSec, 3) / dt) : 1;
    if (!net || net.simulates) tactics.update(gameSec, dt);
    combat.update(gameSec);
    abilities.update(state.lastHours);
    structures.update(state.lastHours, dt);
    if (state.playerA3) {
      economy.update(state.lastHours, dt);
      supply.update(state.lastHours, dt);
      production.update(state.lastHours, dt);
      if (!net || net.simulates) econAI.update(state.lastHours);
      const hold = missions.aiHeld();
      if (hold !== aiHeld) {
        aiHeld = hold;
        for (const a of ais) a.setEnabled(!hold);
      }
      for (const a of ais) a.update(state.lastHours, dt);
      fog.update(state.lastHours, dt);
      if (!net) missions.update(state.lastHours);
    }
    if (state.lastHours > 0) {
      civil.update(state.lastHours, dt, rts.camera);
      if (!net || net.simulates) {
        protection.update(state.lastHours);
        reputation.update(state.lastHours);
        occupation.update(state.lastHours);
      }
      if (state.playerA3) {
        state.zufriedenheit = Math.max(0, Math.min(100, state.zufriedenheit + reputation.consumeSatisfactionDelta(state.playerA3)));
      }
    } else {
      civil.update(0, dt, rts.camera);
    }
    ctl.update(dt);
    terrain.update(rts.camera, time);
    water.update(rts.camera, time);
    cities.update(rts.camera);
    worldDetail.update(rts.camera, time);
    roads.update(rts.camera);
    bridges.update(rts.camera);
    unitRenderer.update(rts.camera, time, state.playerA3);
    effects.update(dt, rts.camera, time, units.units);
    effects.shake.apply(rts.camera, dt);
    sfx.update(rts.camera);
    gfx.render(rts.camera, time);
    labels.update(rts.camera, window.innerWidth, window.innerHeight);
    if (state.playerA3) {
      hud.update(dt);
      unitPanel.update(dt);
      civilPanel.update(dt);
      prodPanel.update(dt);
      fieldBars.update();
      missionPanel.update(dt);
      tutorial.update(dt);
      tutorialOverlay.update(dt);
      minimap.update(rts.getGroundFootprint(), selectedId, playerId);
    }
    requestAnimationFrame(frame);
  };

  hideLoading();
  menu.show();
  requestAnimationFrame(frame);
  // Nach „Wiederholen“/„Nächste Mission“ startet die Mission automatisch
  try {
    const auto = sessionStorage.getItem('ww3.autostart');
    if (auto) {
      sessionStorage.removeItem('ww3.autostart');
      const [mid, a3] = auto.split('|');
      bus.emit('game:start', { countryA3: a3 || 'VAL', missionId: mid });
    }
  } catch {
    /* ignorieren */
  }

  // Debug-Zugriff in der Konsole
  (window as unknown as { ww3: unknown }).ww3 = { geo, settings, terrain, rts, state, gfx, units, ctl, pathfinder, graph, war, combat, structures, cities, effects, cover, sfx, civil, reputation, occupation, worldDetail, economy, supply, production, fog, missions, ais, abilities, abilityBar, eventLog, menu, getNet: () => net };
}

boot().catch((err: unknown) => {
  console.error(err);
  showLoadingError(err instanceof Error ? err.message : String(err));
});
