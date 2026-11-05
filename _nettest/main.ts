import '@fontsource/share-tech-mono';
import '../src/ui/styles.css';
import '../src/control/styles-control.css';
import '../src/ui/civil.css';
import '../src/ui/production.css';

import { bus } from '../src/core/EventBus';
import { Input } from '../src/core/Input';
import type { Settings } from '../src/core/types';
import { RTSCamera } from '../src/camera/RTSCamera';
import { SelectionController } from '../src/control/SelectionController';
import { AICommander } from '../src/ai/AICommander';
import { Sfx } from '../src/audio/Sfx';
import { FogOfWar } from '../src/fog/FogOfWar';
import type { GameContext } from '../src/game/context';
import { MissionSystem, Tutorial, nextMissionId, resolveMission } from '../src/game/missions';
import { EndScreen } from '../src/ui/EndScreen';
import { ProtectBanner } from '../src/ui/ProtectBanner';
import { MissionPanel } from '../src/ui/MissionPanel';
import { TutorialOverlay } from '../src/ui/TutorialOverlay';
import { EconomyAI } from '../src/logistics/EconomyAI';
import { OilEconomy } from '../src/logistics/OilEconomy';
import { SupplySystem } from '../src/logistics/SupplySystem';
import { ProductionSystem } from '../src/production/ProductionSystem';
import { ProductionPanel } from '../src/ui/ProductionPanel';
import { CivilianSystem } from '../src/civil/CivilianSystem';
import { Occupation } from '../src/civil/Occupation';
import { ProtectionSystem } from '../src/civil/ProtectionSystem';
import { Reputation } from '../src/game/Reputation';
import { CivilPanel } from '../src/ui/CivilPanel';
import { CombatSystem } from '../src/combat/CombatSystem';
import { Effects } from '../src/fx/Effects';
import { START_PROFILES, getProfile } from '../src/game/countryData';
import { War } from '../src/game/War';
import { BridgeRenderer } from '../src/structures/BridgeRenderer';
import { StructureManager } from '../src/structures/StructureManager';
import { CoverSystem } from '../src/tactics/CoverSystem';
import { TacticsSystem } from '../src/tactics/TacticsSystem';
import { GameState } from '../src/game/GameState';
import { NavGraph } from '../src/nav/NavGraph';
import { Pathfinder } from '../src/nav/Pathfinder';
import { RoadRenderer } from '../src/nav/RoadRenderer';
import { UnitManager } from '../src/units/UnitManager';
import { UnitRenderer } from '../src/units/UnitRenderer';
import { UnitPanel } from '../src/ui/UnitPanel';
import { GameRenderer } from '../src/render/GameRenderer';
import { Hud } from '../src/ui/Hud';
import { Labels } from '../src/ui/Labels';
import { hideLoading, setLoading, showLoadingError } from '../src/ui/Loading';
import { MainMenu } from '../src/ui/MainMenu';
import { Minimap } from '../src/ui/Minimap';
import { SettingsPanel, loadSettings } from '../src/ui/SettingsPanel';
import { Cities } from '../src/world/Cities';
import { WorldDetail } from '../src/world/WorldDetail';
import { GeoData } from '../src/world/GeoData';
import { Picker } from '../src/world/Picker';
import { Terrain } from '../src/world/Terrain';
import { Water } from '../src/world/Water';

import { NetGame } from '../src/net/NetGame';
import { BroadcastTransport } from '../src/net/BroadcastTransport';
import { mpDiplomacy } from '../src/game/scenario';
import type { RoomInfo } from '../src/net/transport';

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
  let net: NetGame | null = null;
  const startMp = (room: RoomInfo, you: string, lobby: BroadcastTransport) => {
    const self = room.peers.find((p) => p.id === you)!;
    const countryA3 = self.a3!;
    const isHost = room.hostId === you;
    const c = geo.countriesByA3.get(countryA3);
    playerId = c?.id ?? 0;
    state.startGame(countryA3);
    terrain.setPlayer(playerId);
    labels.setPlayer(playerId);
    menu.hide();
    hud.show();
    minimap.show();
    ctl.playerA3 = countryA3;
    ctl.enabled = true;
    unitPanel.show();
    if (civilToggle) civilToggle.style.display = '';
    const dip = mpDiplomacy(room.mode);
    for (const [a, b] of dip.wars) war.declare(a, b);
    const all = ['VAL', 'KRN', 'MAR', 'PAN'];
    const humans = room.peers.map((p) => p.a3).filter((x): x is string => !!x);
    const aiNations = all.filter((a) => !humans.includes(a));
    if (isHost) for (const a3 of all) units.spawnStartingForces(a3, a3 === countryA3);
    economy.loadScenario(geo.meta.scenario);
    prodPanel.show();
    fog.setEnabled(false);
    fog.updateNow();
    if (isHost) {
      for (const a3 of aiNations) ais.push(new AICommander(ctx, { a3, difficulty: 'mittel', style: 'aggressor', econ: econAI }));
    }
    state.borderProtectSec = 0;
    syncProtection();
    net = new NetGame(ctx, lobby, {
      role: isHost ? 'host' : 'guest', selfA3: countryA3, seed: room.seed, aiNations, reputation,
      nationOfPeer: (id) => room.peers.find((p) => p.id === id)?.a3 ?? null,
    });
    const hq = geo.meta.scenario?.nations.find((n) => n.a3 === countryA3)?.hq;
    if (hq) rts.focus(hq[0], hq[1], 25);
    (window as unknown as { nt: Record<string, unknown> }).nt.net = net;
  };
  void bus;
  void missions; void missionPanel; void endScreen; void tutorial; void tutorialOverlay; void resolveMission; void nextMissionId; void MissionSystem; void Tutorial; void START_PROFILES;

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
    syncProtection();
    protectBanner.update();
    if (net) net.frame(dt, state.lastHours);
    units.update(state.lastHours);
    const gameSec = state.lastHours * 3600;
    effects.timeScale = dt > 0 ? Math.max(1, Math.min(gameSec, 3) / dt) : 1;
    const sim = !net || net.simulates;
    if (sim) tactics.update(gameSec, dt);
    combat.update(gameSec);
    structures.update(state.lastHours, dt);
    if (state.playerA3) {
      economy.update(state.lastHours, dt);
      supply.update(state.lastHours, dt);
      production.update(state.lastHours, dt);
      if (sim) {
        econAI.update(state.lastHours);
        for (const a of ais) a.update(state.lastHours, dt);
      }
      fog.update(state.lastHours, dt);
    }
    civil.update(state.lastHours, dt, rts.camera);
    if (state.lastHours > 0 && sim) {
      protection.update(state.lastHours);
      reputation.update(state.lastHours);
      occupation.update(state.lastHours);
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
  const lobby = new BroadcastTransport();
  const nt: Record<string, unknown> = { lobby };
  (window as unknown as { nt: unknown }).nt = nt;
  const role = new URLSearchParams(location.search).get('role') ?? 'host';
  await lobby.connect('', role === 'host' ? 'Host' : 'Gast');
  lobby.on('started', (room, you) => startMp(room, you, lobby));
  nt.ready = true;
  if (role === 'host') {
    const room = await lobby.createRoom({ fillAI: true, mode: 'teams' });
    lobby.setSlot('VAL');
    nt.code = room.code;
  }
  nt.join = async (code: string) => { await lobby.joinRoom(code); lobby.setSlot('KRN'); lobby.setReady(true); };
  nt.start = () => lobby.startGame();

  // Debug-Zugriff in der Konsole
  Object.assign(nt, { ctx, ctl, rts, ais, hud, state, units, economy, production, structures, graph, war, combat, civil, cities, settings, ww3: {} }); (window as unknown as { ww3: unknown }).ww3 = { geo, settings, terrain, rts, state, gfx, units, ctl, pathfinder, graph, war, combat, structures, cities, effects, cover, sfx, civil, reputation, occupation, worldDetail, economy, supply, production, fog, missions, ais };
}

boot().catch((err: unknown) => {
  console.error(err);
  showLoadingError(err instanceof Error ? err.message : String(err));
});
