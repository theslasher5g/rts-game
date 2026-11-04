import '@fontsource/share-tech-mono';
import './ui/styles.css';
import './control/styles-control.css';
import './ui/civil.css';

import { bus } from './core/EventBus';
import { Input } from './core/Input';
import type { Settings } from './core/types';
import { RTSCamera } from './camera/RTSCamera';
import { SelectionController } from './control/SelectionController';
import { Sfx } from './audio/Sfx';
import { CivilianSystem } from './civil/CivilianSystem';
import { Occupation } from './civil/Occupation';
import { ProtectionSystem } from './civil/ProtectionSystem';
import { Reputation } from './game/Reputation';
import { CivilPanel } from './ui/CivilPanel';
import { CombatSystem } from './combat/CombatSystem';
import { Effects } from './fx/Effects';
import { START_PROFILES } from './game/countryData';
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
  bus.on('game:start', ({ countryA3 }) => {
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
    for (const p of START_PROFILES) units.spawnStartingForces(p.a3, p.a3 === countryA3);
    if (c) rts.focus(c.label[0], c.label[1], Math.min(2200, Math.max(500, Math.sqrt(c.cells * 4) * 2.2)));
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
    units.update(state.lastHours);
    const gameSec = state.lastHours * 3600;
    tactics.update(gameSec, dt);
    combat.update(gameSec);
    structures.update(state.lastHours, dt);
    if (state.lastHours > 0) {
      civil.update(state.lastHours, dt, rts.camera);
      protection.update(state.lastHours);
      reputation.update(state.lastHours);
      occupation.update(state.lastHours);
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
      minimap.update(rts.getGroundFootprint(), selectedId, playerId);
    }
    requestAnimationFrame(frame);
  };

  hideLoading();
  menu.show();
  requestAnimationFrame(frame);

  // Debug-Zugriff in der Konsole
  (window as unknown as { ww3: unknown }).ww3 = { geo, settings, terrain, rts, state, gfx, units, ctl, pathfinder, graph, war, combat, structures, cities, effects, cover, sfx, civil, reputation, occupation, worldDetail };
}

boot().catch((err: unknown) => {
  console.error(err);
  showLoadingError(err instanceof Error ? err.message : String(err));
});
