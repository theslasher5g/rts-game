"use strict";
(() => {
  // src/core/EventBus.ts
  var EventBus = class {
    handlers = /* @__PURE__ */ new Map();
    on(type, fn) {
      let set = this.handlers.get(type);
      if (!set) this.handlers.set(type, set = /* @__PURE__ */ new Set());
      set.add(fn);
      return () => set.delete(fn);
    }
    emit(type, payload) {
      this.handlers.get(type)?.forEach((fn) => fn(payload));
    }
  };
  var bus = new EventBus();

  // src/game/missions/campaign.ts
  var KEY = "ww3.campaign";
  var CAMPAIGN = [
    {
      id: "m1",
      name: "Erste F\xE4sser",
      blurb: "Tutorial: Einheiten f\xFChren, \xD6lfluss verstehen, erste Produktion. Der Feind h\xE4lt still.",
      briefing: [
        "LAGE: Kronland hat die Grenze \xFCberschritten, doch an deiner Front ist es noch ruhig. Deine Raffinerie wartet auf \xD6l.",
        "AUFTRAG: Lerne die Grundlagen und bringe 400 F\xE4sser per Tankwagen-Konvoi zur Raffinerie.",
        "AUFTRAG: Optional \u2013 baue mit den Pionieren einen Sch\xFCtzengraben und errichte eine Kaserne.",
        "HINWEIS: \xD6l ist die einzige W\xE4hrung. Folge den Anweisungen unten links; Schritte lassen sich \xFCberspringen."
      ],
      playerNation: "VAL",
      enemies: ["KRN"],
      startOverride: { barrels: 500, enemyStrength: 0.5, extraUnits: [{ typeId: "engineer_squad", count: 2, near: "hq" }] },
      ai: { difficulty: "leicht", hold: true },
      objectives: [
        { id: "deliver", kind: "deliverBarrels", total: 400, text: "Liefere 400 F\xE4sser an die Raffinerie" },
        { id: "trench", kind: "buildStructures", count: 1, role: "secondary", text: "Baue einen Graben oder Sands\xE4cke (Pioniere)" },
        { id: "barracks", kind: "buildBase", base: "barracks", role: "secondary", text: "Baue eine Kaserne" }
      ],
      tutorial: true,
      loseWhenNoForces: false
    },
    {
      id: "m2",
      name: "Die Br\xFCcke",
      blurb: "Kronl\xE4ndische Kolonnen rollen \xFCber die Stra\xDFen. Sprenge eine Br\xFCcke und halte die Linie.",
      briefing: [
        "LAGE: Kronl\xE4ndische Panzerkolonnen marschieren auf der Hauptstra\xDFe nach Westen. Sie sind auf Br\xFCcken angewiesen.",
        "AUFTRAG: Sprenge mindestens eine Br\xFCcke zwischen den Fronten und vernichte 10 Feindfahrzeuge.",
        "AUFTRAG: Dein Hauptquartier darf nicht fallen. Optional: baue drei Stellungen.",
        "HINWEIS: Pioniere sprengen Br\xFCcken (J) und reparieren sie (L). Sprenge erst, wenn der Feind sie erreicht \u2013 deine eigenen Konvois brauchen sie auch."
      ],
      playerNation: "VAL",
      enemies: ["KRN"],
      startOverride: { barrels: 500, enemyStrength: 0.7, extraUnits: [{ typeId: "engineer_squad", count: 3, near: "hq" }, { typeId: "at_team", count: 3, near: "hq" }] },
      ai: { difficulty: "leicht" },
      objectives: [
        { id: "bridge", kind: "blowBridges", count: 1, area: { at: "midpoint", radiusKm: 80 }, text: "Sprenge eine Br\xFCcke an der Front" },
        { id: "kills", kind: "killUnits", count: 10, text: "Vernichte 10 Feindeinheiten" },
        { id: "hq", kind: "keepBase", base: "hq", text: "Halte das Hauptquartier" },
        { id: "build", kind: "buildStructures", count: 3, role: "secondary", text: "Baue 3 Stellungen (Gr\xE4ben, Sands\xE4cke, Bunker)" }
      ],
      waves: [
        { atHours: 1.5, units: [["light_tank", 3], ["inf_squad", 3]], target: "ownHq", distKm: 110, label: "Kolonne auf der Hauptstra\xDFe gesichtet!" },
        { atHours: 4, units: [["mbt_medium", 3], ["ifv", 2], ["inf_squad", 3]], target: "ownHq", distKm: 110, label: "Zweite Kolonne r\xFCckt vor!" }
      ],
      timeLimitHours: 12
    },
    {
      id: "m3",
      name: "\xD6lfeld Karsten",
      blurb: "Erobere das umk\xE4mpfte Feld in der Kartenmitte und halte die Stra\xDFe f\xFCr deine Tankwagen offen.",
      briefing: [
        "LAGE: Das gro\xDFe Feld in der Kartenmitte (Feld Karsten) liegt in kronl\xE4ndischer Hand und bringt dem Gegner t\xE4glich F\xE4sser.",
        "AUFTRAG: Nimm das Feld und halte es mindestens eine Stunde.",
        "AUFTRAG: Danach muss die F\xF6rderung flie\xDFen: bringe 3 Tankwagen-Ladungen zur Raffinerie.",
        "HINWEIS: Das Feld wird von kleinen Vorposten gehalten. Der Gegner wird kontern \u2013 bring Panzerabwehr mit und halte die Stra\xDFe frei."
      ],
      playerNation: "VAL",
      enemies: ["KRN"],
      startOverride: {
        barrels: 700,
        enemyStrength: 0.8,
        spawnEnemyNearFields: true,
        extraUnits: [{ typeId: "mbt_medium", count: 2, near: "spawn" }, { typeId: "ifv", count: 2, near: "spawn" }, { typeId: "at_team", count: 2, near: "spawn" }]
      },
      ai: { difficulty: "mittel" },
      objectives: [
        { id: "field", kind: "captureFields", from: "contested", count: 1, holdHours: 1, text: "Erobere und halte {feld} (1 h)" },
        { id: "supply", kind: "deliverLoads", count: 3, after: ["field"], text: "Liefere 3 Ladungen \xD6l an die Raffinerie" },
        { id: "hq", kind: "keepBase", base: "hq", text: "Halte das Hauptquartier" },
        { id: "raid", kind: "destroyConvoys", count: 2, role: "secondary", text: "Fange 2 feindliche Konvois ab" }
      ],
      waves: [{ atHours: 5, units: [["light_tank", 4], ["inf_squad", 4], ["at_team", 2]], target: "contested", distKm: 55, label: "Kronl\xE4ndischer Gegensto\xDF auf das \xD6lfeld!" }],
      timeLimitHours: 16
    },
    {
      id: "m4",
      name: "Abschneiden",
      blurb: "Als Marenia: Br\xFCcken sprengen, Konvois \xFCberfallen \u2013 Kronlands \xD6lstrom auf unter 30 % dr\xFCcken.",
      briefing: [
        "LAGE: Kronland f\xFChrt Panzer und Munition \xFCber wenige Stra\xDFen heran. Sein \xD6leinkommen h\xE4lt die Offensive am Laufen.",
        "AUFTRAG: Dr\xFCcke das Einkommen des Gegners f\xFCr 3 Stunden unter 30 % seines H\xF6chstwerts.",
        "AUFTRAG: Sprenge Br\xFCcken und \xFCberfalle Tankwagen-Konvois \u2013 schnelle Aufkl\xE4rer und Hubschrauber sind daf\xFCr ideal.",
        "HINWEIS: Der Gegner repariert Br\xFCcken und schickt neue Konvois. Halte den Druck aufrecht. Du spielst als Marenia, Valdoria ist verb\xFCndet."
      ],
      playerNation: "MAR",
      enemies: ["KRN"],
      startOverride: {
        barrels: 800,
        enemyStrength: 0.9,
        extraUnits: [{ typeId: "recon_wheeled", count: 3, near: "spawn" }, { typeId: "attack_heli", count: 2, near: "spawn" }, { typeId: "engineer_squad", count: 2, near: "spawn" }]
      },
      ai: { difficulty: "mittel" },
      objectives: [
        { id: "cut", kind: "cutIncome", belowPct: 0.3, hours: 3, text: "Kronlands Einkommen 3 h unter 30 % dr\xFCcken" },
        { id: "convoys", kind: "destroyConvoys", count: 5, role: "secondary", text: "Zerst\xF6re 5 feindliche Konvois" },
        { id: "bridges", kind: "blowBridges", count: 2, role: "secondary", text: "Sprenge 2 Br\xFCcken" },
        { id: "hq", kind: "keepBase", base: "hq", text: "Halte das Hauptquartier" }
      ],
      timeLimitHours: 22
    },
    {
      id: "m5",
      name: "Verteidigung der Hauptstadt",
      blurb: "Kronland greift in Wellen Valdorn an. Halte die Hauptstadt, bis die Verst\xE4rkung eintrifft.",
      briefing: [
        "LAGE: Die Front ist gebrochen. Kronl\xE4ndische Verb\xE4nde sammeln sich zum Sturm auf Valdorn.",
        "AUFTRAG: Halte die Hauptstadt und das Hauptquartier 8 Stunden lang gegen mehrere Angriffswellen.",
        "AUFTRAG: Optional \u2013 vernichte 30 Feindeinheiten.",
        "HINWEIS: Gr\xE4ben, Sands\xE4cke und Panzerabwehr in den Zufahrten machen den Unterschied. Mit jeder Welle wird es h\xE4rter; produziere rechtzeitig."
      ],
      playerNation: "VAL",
      enemies: ["KRN"],
      startOverride: {
        barrels: 600,
        enemyStrength: 0.7,
        extraUnits: [{ typeId: "mbt_medium", count: 3, near: "hq" }, { typeId: "at_team", count: 4, near: "hq" }, { typeId: "inf_squad", count: 4, near: "hq" }, { typeId: "engineer_squad", count: 2, near: "hq" }]
      },
      ai: { difficulty: "schwer" },
      objectives: [
        { id: "survive", kind: "surviveUntil", hours: 8, text: "Halte Valdorn 8 Stunden" },
        { id: "capital", kind: "keepCity", city: "ownCapital", text: "Verliere die Hauptstadt nicht" },
        { id: "hq", kind: "keepBase", base: "hq", text: "Halte das Hauptquartier" },
        { id: "kills", kind: "killUnits", count: 30, role: "secondary", text: "Vernichte 30 Feindeinheiten" }
      ],
      waves: [
        { atHours: 1, units: [["light_tank", 3], ["inf_squad", 3]], target: "ownCapital", label: "Welle 1 n\xE4hert sich Valdorn." },
        { atHours: 2.5, units: [["mbt_medium", 3], ["ifv", 2], ["inf_squad", 3]], target: "ownCapital", label: "Welle 2: Panzer und Sch\xFCtzenpanzer!" },
        { atHours: 4, units: [["mbt_medium", 4], ["sp_artillery", 2], ["ifv", 3]], target: "ownCapital", label: "Welle 3: Artillerie und schwere Panzer!" },
        { atHours: 5.5, units: [["mbt_heavy", 3], ["ifv", 3], ["inf_squad", 4], ["at_team", 2]], target: "ownCapital", label: "Welle 4: Gro\xDFangriff auf Valdorn!" },
        { atHours: 7, units: [["mbt_heavy", 4], ["mbt_medium", 4], ["ifv", 4]], target: "ownCapital", label: "Letzte Welle: alles, was Kronland hat!" }
      ],
      timeLimitHours: 11
    },
    {
      id: "m6",
      name: "Gegensto\xDF",
      blurb: "Die Verst\xE4rkung ist da. Sto\xDFe nach Osten vor und zerst\xF6re die kronl\xE4ndische Raffinerie.",
      briefing: [
        "LAGE: Der Angriff ist abgewehrt, Verst\xE4rkung ist eingetroffen. Kronland ist geschw\xE4cht, aber nicht geschlagen.",
        "AUFTRAG: Zerst\xF6re die Raffinerie von Kronland \u2013 ohne sie flie\xDFt dort kein \xD6l mehr in die Produktion.",
        "AUFTRAG: Optional \u2013 erobere zwei feindliche \xD6lfelder, um den eigenen Nachschub zu sichern.",
        "HINWEIS: Der Weg ist weit. Sch\xFCtze deine Tankwagen-Konvois, nimm Artillerie mit und lass Pioniere zerst\xF6rte Br\xFCcken instand setzen."
      ],
      playerNation: "VAL",
      enemies: ["KRN"],
      startOverride: {
        barrels: 900,
        enemyStrength: 0.9,
        extraUnits: [{ typeId: "mbt_heavy", count: 3, near: "spawn" }, { typeId: "ifv", count: 3, near: "spawn" }, { typeId: "sp_artillery", count: 2, near: "spawn" }, { typeId: "engineer_squad", count: 2, near: "spawn" }]
      },
      ai: { difficulty: "schwer" },
      objectives: [
        { id: "refinery", kind: "destroyBase", base: "refinery", text: "Zerst\xF6re die Raffinerie Kronlands" },
        { id: "fields", kind: "captureFields", from: "enemy", count: 2, holdHours: 1, role: "secondary", text: "Erobere 2 feindliche \xD6lfelder" },
        { id: "hq", kind: "keepBase", base: "hq", text: "Halte das Hauptquartier" }
      ],
      timeLimitHours: 26
    },
    {
      id: "m7",
      name: "Entscheidung",
      blurb: "Totaler Krieg: Zerst\xF6re Raffinerie und Hauptquartier Kronlands und halte deine eigenen.",
      briefing: [
        "LAGE: Kronland wirft alles in die Waagschale, auch am Boden und an den \xD6lfeldern herrscht offener Krieg.",
        "AUFTRAG: Zerst\xF6re Raffinerie UND Hauptquartier von Kronland.",
        "AUFTRAG: Deine eigene Raffinerie und dein Hauptquartier d\xFCrfen nicht beide fallen. Marenia unterst\xFCtzt dich.",
        "HINWEIS: Kombiniere alles \u2013 Konvois sch\xFCtzen, Br\xFCcken sprengen, Felder nehmen, Artillerie und Luftschl\xE4ge. Wer das \xD6l kontrolliert, gewinnt."
      ],
      playerNation: "VAL",
      enemies: ["KRN"],
      startOverride: { barrels: 700, enemyStrength: 1.3, spawnEnemyNearFields: true },
      ai: { difficulty: "schwer" },
      objectives: [
        { id: "decisive", kind: "all", text: "Zerst\xF6re Raffinerie und Hauptquartier Kronlands", children: [
          { id: "refinery", kind: "destroyBase", base: "refinery", text: "Raffinerie Kronlands zerst\xF6ren" },
          { id: "hq", kind: "destroyBase", base: "hq", text: "Hauptquartier Kronlands zerst\xF6ren" }
        ] },
        { id: "fields", kind: "captureFields", from: "enemy", count: 3, holdHours: 1, role: "secondary", text: "Erobere 3 feindliche \xD6lfelder" },
        { id: "kills", kind: "killUnits", count: 40, role: "secondary", text: "Vernichte 40 Feindeinheiten" }
      ],
      timeLimitHours: 40
    }
  ];
  function getMission(id) {
    return CAMPAIGN.find((m) => m.id === id);
  }
  function readDone() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return [];
      const o = JSON.parse(raw);
      return Array.isArray(o.done) ? o.done.filter((x) => typeof x === "string") : [];
    } catch {
      return [];
    }
  }
  function markCompleted(id) {
    const d = readDone();
    if (d.includes(id) || !CAMPAIGN.some((m) => m.id === id)) return;
    d.push(id);
    try {
      localStorage.setItem(KEY, JSON.stringify({ done: d }));
    } catch {
    }
  }
  function nextMissionId(id) {
    const i = CAMPAIGN.findIndex((m) => m.id === id);
    return i >= 0 && i + 1 < CAMPAIGN.length ? CAMPAIGN[i + 1].id : null;
  }
  function missionList() {
    const done = readDone();
    return CAMPAIGN.map((m, i) => ({
      id: m.id,
      name: m.name,
      blurb: m.blurb,
      playerNation: m.playerNation,
      difficulty: m.ai.difficulty,
      state: done.includes(m.id) ? "done" : i === 0 || done.includes(CAMPAIGN[i - 1].id) ? "open" : "locked"
    }));
  }

  // src/game/missions/stats.ts
  function blank() {
    return {
      lost: 0,
      lostByCat: {},
      lostByType: {},
      kills: 0,
      killsByCat: {},
      delivered: 0,
      loads: 0,
      convoysLost: 0,
      convoysRaided: 0,
      barrelsLost: 0,
      fieldsCaptured: 0,
      fieldsLost: 0,
      citiesCaptured: 0,
      structures: 0,
      structureKinds: {},
      basesBuilt: {},
      produced: 0,
      peakIncome: 0
    };
  }
  function inc(r, k, n = 1) {
    r[k] = (r[k] ?? 0) + n;
  }
  var StatsTracker = class {
    nations = /* @__PURE__ */ new Map();
    bridgesBlown = [];
    bridgesRepaired = 0;
    /** Auflösung Killer-Unit -> Besitzer (vom MissionSystem gesetzt) */
    ownerOf = () => "";
    bound = false;
    active = true;
    /** Statistik der Nation (wird bei Bedarf angelegt) */
    of(a3) {
      let s = this.nations.get(a3);
      if (!s) this.nations.set(a3, s = blank());
      return s;
    }
    reset() {
      this.nations.clear();
      this.bridgesBlown.length = 0;
      this.bridgesRepaired = 0;
    }
    setActive(on) {
      this.active = on;
    }
    /** Abos anlegen (idempotent) */
    bind() {
      if (this.bound) return;
      this.bound = true;
      bus.on("unit:killed", (e) => {
        if (!this.active) return;
        const v = this.of(e.owner);
        v.lost++;
        inc(v.lostByCat, e.category);
        inc(v.lostByType, e.typeId);
        const ko = e.killerId ? this.ownerOf(e.killerId) : "";
        if (ko && ko !== e.owner) {
          const k = this.of(ko);
          k.kills++;
          inc(k.killsByCat, e.category);
        }
      });
      bus.on("convoy:lost", (e) => {
        if (!this.active) return;
        const v = this.of(e.owner);
        v.convoysLost++;
        v.barrelsLost += e.cargo;
        if (e.by) this.of(e.by).convoysRaided++;
      });
      bus.on("oil:delivered", (e) => {
        if (!this.active) return;
        const s = this.of(e.owner);
        s.delivered += e.barrels;
        s.loads++;
      });
      bus.on("oil:balance", (e) => {
        if (!this.active) return;
        const s = this.of(e.owner);
        if (e.incomePerHour > s.peakIncome) s.peakIncome = e.incomePerHour;
      });
      bus.on("bridge:destroyed", (e) => {
        if (!this.active) return;
        const g = e.geom;
        let x = 0, z = 0;
        const n = Math.floor(g.length / 2);
        if (n > 0) {
          for (let i = 0; i < n; i++) {
            x += g[i * 2];
            z += g[i * 2 + 1];
          }
          x /= n;
          z /= n;
        }
        this.bridgesBlown.push({ edgeId: e.edgeId, x, z });
      });
      bus.on("bridge:repaired", () => {
        if (this.active) this.bridgesRepaired++;
      });
      bus.on("structure:added", (e) => {
        if (!this.active) return;
        const s = this.of(e.owner);
        s.structures++;
        inc(s.structureKinds, e.kind);
      });
      bus.on("base:built", (e) => {
        if (this.active) inc(this.of(e.owner).basesBuilt, e.kind);
      });
      bus.on("production:complete", (e) => {
        if (this.active) this.of(e.owner).produced++;
      });
      bus.on("oil:field-captured", (e) => {
        if (!this.active) return;
        this.of(e.by).fieldsCaptured++;
        if (e.from) this.of(e.from).fieldsLost++;
      });
      bus.on("city:captured", (e) => {
        if (this.active) this.of(e.by).citiesCaptured++;
      });
    }
  };
  var statsTracker = new StatsTracker();

  // src/game/missions/MissionSystem.ts
  var TICK_EVERY = 8;
  var NO_FORCES_GRACE_H = 0.5;
  var MIN_BARRELS_TO_PRODUCE = 10;
  var PRODUCERS = /* @__PURE__ */ new Set(["hq", "barracks", "factory", "airfield", "shipyard"]);
  var CONSTRAINT_KINDS = /* @__PURE__ */ new Set(["keepBase", "keepCity", "maxLosses"]);
  function fmt(n) {
    return (Math.round(n * 10) / 10).toString().replace(".", ",");
  }
  var MissionSystem = class {
    current = null;
    objectives = [];
    result = "running";
    reason = "";
    /** Spielstunden seit Missionsbeginn */
    elapsedHours = 0;
    /** Lead kann hier die Zahl der Kriegsverbrechen des Spielers liefern (für den Endbildschirm) */
    getWarCrimes = null;
    /** Mission 1: Tutorial gewünscht (nach load() lesen) */
    get wantsTutorial() {
      return !!this.current?.tutorial;
    }
    ctx;
    rts = [];
    tops = [];
    own = "";
    enemies = [];
    tick = 0;
    pendingDt = 0;
    waveIdx = 0;
    hadHq = false;
    hadRefinery = false;
    noForcesFor = 0;
    armedForces = false;
    mid = [0, 0];
    contestedField = null;
    buf = [];
    constructor(ctx2) {
      this.ctx = ctx2;
      statsTracker.ownerOf = (id) => this.ctx.units.get(id)?.owner ?? "";
      statsTracker.bind();
    }
    // ------------------------------------------------------------------ Laden
    load(def, opts = {}) {
      this.reset();
      this.current = def;
      this.own = def.playerNation;
      this.enemies = def.enemies.slice();
      statsTracker.reset();
      statsTracker.setActive(true);
      this.resolveWorld();
      if (opts.applyStart !== false && def.startOverride) this.applyStartOverride(def.startOverride);
      for (const o of def.objectives) this.tops.push(this.build(o, -1));
      for (const r of this.rts) {
        r.gated = !!(r.def.after?.length || r.def.startHours);
        if (r.parent < 0 && !r.gated) this.activate(r, false);
      }
      for (const r of this.rts) this.syncState(r);
      bus.emit("mission:started", { id: def.id, name: def.name });
      this.evaluate(0);
    }
    reset() {
      this.current = null;
      this.objectives.length = 0;
      this.rts = [];
      this.tops = [];
      this.result = "running";
      this.reason = "";
      this.elapsedHours = 0;
      this.tick = 0;
      this.pendingDt = 0;
      this.waveIdx = 0;
      this.noForcesFor = 0;
      this.armedForces = false;
      this.contestedField = null;
      statsTracker.setActive(true);
    }
    /** KI soll (noch) nicht angreifen (Lead: AICommander pausieren) */
    aiHeld() {
      const a = this.current?.ai;
      if (!a || !a.hold || this.result !== "running") return false;
      if (a.holdUntilHours !== void 0 && this.elapsedHours >= a.holdUntilHours) return false;
      if (a.holdUntilObjective) {
        const r = this.rts.find((x) => x.def.id === a.holdUntilObjective);
        if (r && r.st.status === "done") return false;
      }
      return true;
    }
    // ------------------------------------------------------------------ Auflösung von Selektoren
    hqPos(a3) {
      const n = this.ctx.geo.meta.scenario?.nations.find((x) => x.a3 === a3);
      if (n) return [n.hq[0], n.hq[1]];
      for (const b of this.ctx.economy.bases.values()) if (b.owner === a3 && b.kind === "hq") return [b.x, b.z];
      return null;
    }
    resolveWorld() {
      const eco = this.ctx.economy;
      const ownHq = this.hqPos(this.own);
      const enHq = this.hqPos(this.enemies[0] ?? "");
      this.mid = ownHq && enHq ? [(ownHq[0] + enHq[0]) / 2, (ownHq[1] + enHq[1]) / 2] : ownHq ?? [150, 100];
      let best = null, bd = Infinity;
      for (const f of eco.fields) {
        if (f.owner === this.own || f.owner && !this.ctx.war.isHostile(this.own, f.owner)) continue;
        const d = Math.hypot(f.x - this.mid[0], f.z - this.mid[1]);
        if (d < bd) {
          bd = d;
          best = f;
        }
      }
      this.contestedField = best;
      this.hadHq = eco.countBases(this.own, "hq") > 0;
      this.hadRefinery = eco.countBases(this.own, "refinery") > 0;
    }
    cityIdOf(sel) {
      const cities = this.ctx.civil.cities;
      const meta = this.ctx.geo.meta;
      if (sel === "ownCapital" || sel === "enemyCapital") {
        const a3 = sel === "ownCapital" ? this.own : this.enemies[0];
        const n = meta.scenario?.nations.find((x) => x.a3 === a3);
        if (n) return n.capitalCity;
        const c2 = cities.find((x) => x.capital && x.country === a3);
        return c2 ? c2.id : -1;
      }
      if (sel === "contested") {
        let id = -1, bd = Infinity;
        for (const c2 of cities) {
          if (c2.country === this.own) continue;
          const d = Math.hypot(c2.x - this.mid[0], c2.z - this.mid[1]);
          if (d < bd) {
            bd = d;
            id = c2.id;
          }
        }
        return id;
      }
      const low = sel.toLowerCase();
      const c = cities.find((x) => x.name.toLowerCase() === low);
      return c ? c.id : -1;
    }
    areaPos(a) {
      const at = a.at;
      if (typeof at === "object") return [at.x, at.z];
      switch (at) {
        case "ownHq":
          return this.hqPos(this.own) ?? this.mid;
        case "enemyHq":
          return this.hqPos(this.enemies[0] ?? "") ?? this.mid;
        case "ownCapital":
        case "enemyCapital": {
          const c = this.ctx.civil.cities[this.cityIdOf(at)];
          return c ? [c.x, c.z] : this.mid;
        }
        case "contested":
          return this.contestedField ? [this.contestedField.x, this.contestedField.z] : this.mid;
        default:
          return this.mid;
      }
    }
    // ------------------------------------------------------------------ Aufbau der Ziele
    build(o, parent) {
      const idx = this.rts.length;
      const constraint = o.constraint ?? CONSTRAINT_KINDS.has(o.kind);
      const st = {
        id: o.id,
        text: o.text,
        role: o.role ?? "primary",
        status: "pending",
        constraint,
        progress: 0,
        detail: "",
        visible: false,
        parentId: parent >= 0 ? this.rts[parent].def.id : ""
      };
      const rt = {
        def: o,
        st,
        parent,
        children: [],
        acc: 0,
        n0: 0,
        peak: 0,
        key: "",
        fieldId: -1,
        cityId: -1,
        existed: 0,
        ax: 0,
        az: 0,
        gated: false
      };
      this.rts.push(rt);
      this.objectives.push(st);
      this.resolveObjective(rt);
      if (o.kind === "all" || o.kind === "any") {
        for (const c of o.children) rt.children.push(this.build(c, idx));
      }
      return idx;
    }
    resolveObjective(r) {
      const o = r.def;
      const eco = this.ctx.economy;
      switch (o.kind) {
        case "holdCity":
        case "keepCity":
          r.cityId = this.cityIdOf(o.city);
          r.st.text = o.text.replace("{stadt}", this.ctx.civil.cities[r.cityId]?.name ?? "Stadt");
          break;
        case "captureFields":
          if (o.from === "contested") {
            r.fieldId = this.contestedField?.id ?? -1;
            r.st.text = o.text.replace("{feld}", this.contestedField?.name ?? "\xD6lfeld");
          }
          break;
        case "destroyBase":
          for (const e of this.enemies) r.existed += eco.countBases(e, o.base);
          break;
        case "keepBase":
          r.existed = eco.countBases(this.own, o.base);
          break;
        case "blowBridges":
          if (o.area) {
            const p = this.areaPos(o.area);
            r.ax = p[0];
            r.az = p[1];
          }
          break;
        case "reachArea": {
          const p = this.areaPos(o.area);
          r.ax = p[0];
          r.az = p[1];
          break;
        }
        default:
          break;
      }
    }
    /** Ziel wird aktiv: Zählerbasis merken */
    activate(r, announce) {
      r.st.status = "active";
      const s = statsTracker.of(this.own);
      const o = r.def;
      switch (o.kind) {
        case "deliverBarrels":
          r.n0 = s.delivered;
          break;
        case "deliverLoads":
          r.n0 = s.loads;
          break;
        case "repairBridges":
          r.n0 = statsTracker.bridgesRepaired;
          break;
        case "buildStructures":
          r.n0 = this.structCount(o.kinds);
          break;
        case "buildBase":
          r.n0 = this.ownBases(o.base);
          break;
        case "maxLosses":
          r.n0 = this.ownLost();
          break;
        case "killUnits":
          r.n0 = this.enemyKills(o.category, o.typeIds);
          break;
        case "destroyConvoys":
          r.n0 = this.enemyConvoys();
          break;
        case "blowBridges":
          r.n0 = this.bridgeCount(o.area ? r : null, o.area?.radiusKm ?? 0);
          break;
        default:
          break;
      }
      for (const c of r.children) this.activate(this.rts[c], false);
      this.syncState(r);
      if (announce && !r.st.constraint) bus.emit("mission:objective", { missionId: this.current?.id ?? "", objectiveId: r.def.id, state: "active", text: r.st.text });
    }
    syncState(r) {
      const p = r.parent >= 0 ? this.rts[r.parent] : null;
      r.st.visible = p ? p.st.visible : r.st.status !== "pending";
    }
    // ------------------------------------------------------------------ Zähler
    ownLost() {
      const s = statsTracker.of(this.own);
      return s.lost - (s.lostByCat["support"] ?? 0);
    }
    ownBases(kind) {
      let n = 0;
      for (const b of this.ctx.economy.bases.values()) if (b.owner === this.own && b.kind === kind && b.progress >= 1) n++;
      return n;
    }
    structCount(kinds) {
      const s = statsTracker.of(this.own);
      if (!kinds) return s.structures;
      let n = 0;
      for (const k of kinds) n += s.structureKinds[k] ?? 0;
      return n;
    }
    enemyKills(cat, types) {
      let n = 0;
      for (const e of this.enemies) {
        const s = statsTracker.of(e);
        if (types) for (const t of types) n += s.lostByType[t] ?? 0;
        else if (cat) n += s.lostByCat[cat] ?? 0;
        else n += s.lost;
      }
      return n;
    }
    enemyConvoys() {
      let n = 0;
      for (const e of this.enemies) n += statsTracker.of(e).convoysLost;
      return n;
    }
    bridgeCount(r, radius) {
      const list = statsTracker.bridgesBlown;
      if (!r) return list.length;
      let n = 0;
      for (const b of list) if (Math.hypot(b.x - r.ax, b.z - r.az) <= radius) n++;
      return n;
    }
    // ------------------------------------------------------------------ update
    update(dtGameHours) {
      if (!this.current || this.result !== "running") return;
      this.elapsedHours += dtGameHours;
      this.pendingDt += dtGameHours;
      if (++this.tick % TICK_EVERY !== 0) return;
      const dt = this.pendingDt;
      this.pendingDt = 0;
      this.evaluate(dt);
    }
    evaluate(dt) {
      const def = this.current;
      if (!def || this.result !== "running") return;
      this.spawnWaves();
      for (let i = this.rts.length - 1; i >= 0; i--) this.evalRt(this.rts[i], dt);
      let primaries = 0, done = 0;
      for (const i of this.tops) {
        const r = this.rts[i];
        if (r.st.role !== "primary") continue;
        if (r.st.status === "failed") {
          return this.end("defeat", `Auftrag gescheitert: ${r.st.text}`);
        }
        if (r.st.constraint) continue;
        primaries++;
        if (r.st.status === "done") done++;
      }
      if (primaries > 0 && done === primaries) return this.end("victory", "Alle Hauptziele erf\xFCllt.");
      const lose = this.checkDefeat(def, dt);
      if (lose) return this.end("defeat", lose);
      if (def.timeLimitHours !== void 0 && this.elapsedHours >= def.timeLimitHours) return this.end("defeat", "Zeitlimit \xFCberschritten.");
    }
    checkDefeat(def, dt) {
      const eco = this.ctx.economy;
      const hq = eco.countBases(this.own, "hq") > 0;
      const ref = eco.countBases(this.own, "refinery") > 0;
      const mode = def.loseWhen ?? "hq_and_refinery";
      if (this.hadHq || this.hadRefinery) {
        const lostHq = this.hadHq && !hq, lostRef = this.hadRefinery && !ref;
        if (mode === "hq_and_refinery" && (this.hadHq ? lostHq : true) && (this.hadRefinery ? lostRef : true) && (lostHq || lostRef)) return "Hauptquartier und Raffinerie zerst\xF6rt.";
        if (mode === "hq" && lostHq) return "Hauptquartier zerst\xF6rt.";
        if (mode === "refinery" && lostRef) return "Raffinerie zerst\xF6rt.";
        if (mode === "either" && (lostHq || lostRef)) return lostHq ? "Hauptquartier zerst\xF6rt." : "Raffinerie zerst\xF6rt.";
      }
      if (def.loseWhenNoForces !== false) {
        let combat = 0;
        const us = this.ctx.units.units;
        for (let i = 0; i < us.length; i++) {
          const u = us[i];
          if (u.owner === this.own && u.hp > 0 && u.type.damage > 0) {
            combat++;
            break;
          }
        }
        if (combat > 0) {
          this.armedForces = true;
          this.noForcesFor = 0;
        } else if (this.armedForces) {
          let canProduce = this.ctx.economy.pool(this.own).barrels >= MIN_BARRELS_TO_PRODUCE;
          if (canProduce) {
            canProduce = false;
            for (const b of eco.bases.values()) if (b.owner === this.own && b.progress >= 1 && PRODUCERS.has(b.kind)) {
              canProduce = true;
              break;
            }
          }
          if (canProduce) this.noForcesFor = 0;
          else {
            this.noForcesFor += dt;
            if (this.noForcesFor >= NO_FORCES_GRACE_H) return "Alle Kampfeinheiten verloren \u2013 keine Produktion m\xF6glich.";
          }
        }
      }
      return null;
    }
    evalRt(r, dt) {
      const st = r.st;
      if (st.status === "done" || st.status === "failed") return;
      if (st.status === "pending") {
        if (r.parent >= 0) return;
        const o2 = r.def;
        if (o2.startHours !== void 0 && this.elapsedHours < o2.startHours) return;
        if (o2.after) for (const id of o2.after) {
          const d = this.rts.find((x) => x.def.id === id);
          if (d && d.st.status !== "done") return;
        }
        this.activate(r, true);
      }
      const o = r.def;
      if (o.timeLimitHours !== void 0 && !st.constraint && this.elapsedHours >= o.timeLimitHours) {
        return this.setStatus(r, "failed");
      }
      if (o.kind === "all" || o.kind === "any") {
        let nd = 0, nf = 0, n = 0;
        for (const c of r.children) {
          const cs = this.rts[c].st;
          if (cs.constraint) continue;
          n++;
          if (cs.status === "done") nd++;
          else if (cs.status === "failed") nf++;
        }
        st.progress = n ? nd / n : 1;
        st.detail = `${nd} / ${n}`;
        if (o.kind === "all") {
          if (nf > 0) this.setStatus(r, "failed");
          else if (nd === n) this.setStatus(r, "done");
        } else {
          if (nd > 0) this.setStatus(r, "done");
          else if (nf === n) this.setStatus(r, "failed");
        }
        return;
      }
      const met = this.evalLeaf(r, dt);
      if (st.constraint) {
        if (!met) this.setStatus(r, "failed");
      } else if (met) {
        st.progress = 1;
        this.setStatus(r, "done");
      }
    }
    setStatus(r, status) {
      r.st.status = status;
      if (status === "done") r.st.progress = 1;
      bus.emit("mission:objective", { missionId: this.current?.id ?? "", objectiveId: r.def.id, state: status, text: r.st.text });
    }
    /** true = Bedingung (bei Constraints: „noch erfüllt") */
    evalLeaf(r, dt) {
      const o = r.def;
      const st = r.st;
      const eco = this.ctx.economy;
      const own = this.own;
      switch (o.kind) {
        case "holdCity": {
          const c = this.ctx.civil.cities[r.cityId];
          if (!c) {
            st.detail = "";
            return true;
          }
          if (c.controller === own) r.acc += dt;
          else r.acc = 0;
          st.progress = Math.min(1, r.acc / o.hours);
          this.setDetail(r, `${fmt(Math.min(r.acc, o.hours))} / ${fmt(o.hours)} h${c.controller === own ? "" : " (nicht gehalten)"}`);
          return r.acc >= o.hours;
        }
        case "keepCity": {
          const c = this.ctx.civil.cities[r.cityId];
          const ok = !c || c.controller === own;
          st.progress = ok ? 1 : 0;
          this.setDetail(r, ok ? "gehalten" : "verloren");
          return ok;
        }
        case "captureFields": {
          const need = o.from === "contested" ? 1 : o.count;
          let n = 0;
          if (o.from === "contested") {
            const f = eco.fields.find((x) => x.id === r.fieldId);
            if (f && f.owner === own) n = 1;
            else if (!f) return true;
          } else {
            for (const f of eco.fields) {
              if (f.owner !== own) continue;
              if (o.from === "enemy" && !this.enemies.includes(f.country)) continue;
              n++;
            }
          }
          const hold = o.holdHours ?? 1;
          if (n >= need) r.acc += dt;
          else r.acc = 0;
          st.progress = Math.min(1, Math.min(n, need) / need * 0.5 + Math.min(1, r.acc / hold) * 0.5);
          this.setDetail(r, need > 1 ? `${n} / ${need} Felder \xB7 ${fmt(Math.min(r.acc, hold))} / ${fmt(hold)} h` : `${fmt(Math.min(r.acc, hold))} / ${fmt(hold)} h`);
          return n >= need && r.acc >= hold;
        }
        case "destroyBase": {
          if (r.existed === 0) return true;
          let left = 0;
          for (const e of this.enemies) left += eco.countBases(e, o.base);
          st.progress = 1 - left / r.existed;
          this.setDetail(r, left === 0 ? "zerst\xF6rt" : `${left} intakt`);
          return left === 0;
        }
        case "keepBase": {
          if (r.existed === 0) return true;
          const ok = eco.countBases(own, o.base) > 0;
          st.progress = ok ? 1 : 0;
          this.setDetail(r, ok ? "intakt" : "zerst\xF6rt");
          return ok;
        }
        case "deliverBarrels": {
          const v = statsTracker.of(own).delivered - r.n0;
          st.progress = Math.min(1, v / o.total);
          this.setDetail(r, `${Math.floor(v)} / ${o.total} F\xE4sser`);
          return v >= o.total;
        }
        case "deliverLoads": {
          const v = statsTracker.of(own).loads - r.n0;
          st.progress = Math.min(1, v / o.count);
          this.setDetail(r, `${v} / ${o.count} Ladungen`);
          return v >= o.count;
        }
        case "balance": {
          const v = eco.pool(own).barrels;
          st.progress = Math.min(1, v / o.barrels);
          this.setDetail(r, `${Math.floor(v)} / ${o.barrels} F\xE4sser`);
          return v >= o.barrels;
        }
        case "income": {
          const v = eco.pool(own).incomePerHour;
          st.progress = Math.min(1, v / o.perHour);
          this.setDetail(r, `${fmt(v)} / ${o.perHour} F\xE4sser/h`);
          return v >= o.perHour;
        }
        case "cutIncome": {
          let cur = 0, peak = 0;
          for (const e of this.enemies) {
            cur += eco.pool(e).incomePerHour;
            peak += statsTracker.of(e).peakIncome;
          }
          if (peak > r.peak) r.peak = peak;
          const armed = r.peak >= 10;
          const thr = o.belowAbs !== void 0 ? o.belowAbs : (o.belowPct ?? 0.3) * r.peak;
          const ok = armed && cur < thr;
          if (ok) r.acc += dt;
          else r.acc = 0;
          st.progress = Math.min(1, r.acc / o.hours);
          const pct = armed ? Math.round(cur / r.peak * 100) : 100;
          this.setDetail(r, armed ? `Gegner ${pct} % \xB7 ${fmt(Math.min(r.acc, o.hours))} / ${fmt(o.hours)} h` : "Messe Gegner-Einkommen \u2026");
          return r.acc >= o.hours;
        }
        case "destroyConvoys": {
          const v = this.enemyConvoys() - r.n0;
          st.progress = Math.min(1, v / o.count);
          this.setDetail(r, `${v} / ${o.count} Konvois`);
          return v >= o.count;
        }
        case "blowBridges": {
          const v = this.bridgeCount(o.area ? r : null, o.area?.radiusKm ?? 0) - r.n0;
          st.progress = Math.min(1, v / o.count);
          this.setDetail(r, `${v} / ${o.count} Br\xFCcken`);
          return v >= o.count;
        }
        case "repairBridges": {
          const v = statsTracker.bridgesRepaired - r.n0;
          st.progress = Math.min(1, v / o.count);
          this.setDetail(r, `${v} / ${o.count} Br\xFCcken`);
          return v >= o.count;
        }
        case "killUnits": {
          const v = this.enemyKills(o.category, o.typeIds) - r.n0;
          st.progress = Math.min(1, v / o.count);
          this.setDetail(r, `${v} / ${o.count} zerst\xF6rt`);
          return v >= o.count;
        }
        case "surviveUntil": {
          st.progress = Math.min(1, this.elapsedHours / o.hours);
          this.setDetail(r, `${fmt(Math.min(this.elapsedHours, o.hours))} / ${fmt(o.hours)} h`);
          return this.elapsedHours >= o.hours;
        }
        case "maxLosses": {
          const v = this.ownLost() - r.n0;
          st.progress = Math.max(0, 1 - v / (o.count + 1));
          this.setDetail(r, `${v} / max. ${o.count} Verluste`);
          return v <= o.count;
        }
        case "reachArea": {
          const need = o.count ?? 1;
          this.ctx.units.queryRadius(r.ax, r.az, o.area.radiusKm, this.buf);
          let n = 0;
          for (let i = 0; i < this.buf.length; i++) {
            const u = this.buf[i];
            if (u.owner !== own || u.hp <= 0) continue;
            if (o.category && u.type.category !== o.category) continue;
            if (o.typeIds && !o.typeIds.includes(u.type.id)) continue;
            n++;
          }
          st.progress = Math.min(1, n / need);
          this.setDetail(r, `${n} / ${need} im Zielgebiet`);
          return n >= need;
        }
        case "buildBase": {
          const need = o.count ?? 1;
          const v = this.ownBases(o.base) - r.n0;
          st.progress = Math.min(1, v / need);
          this.setDetail(r, `${v} / ${need}`);
          return v >= need;
        }
        case "buildStructures": {
          const v = this.structCount(o.kinds) - r.n0;
          st.progress = Math.min(1, v / o.count);
          this.setDetail(r, `${v} / ${o.count} Bauwerke`);
          return v >= o.count;
        }
        default:
          return false;
      }
    }
    setDetail(r, s) {
      r.st.detail = s;
    }
    // ------------------------------------------------------------------ Wellen
    spawnWaves() {
      const waves = this.current?.waves;
      if (!waves) return;
      while (this.waveIdx < waves.length && waves[this.waveIdx].atHours <= this.elapsedHours) {
        this.spawnWave(waves[this.waveIdx]);
        this.waveIdx++;
      }
    }
    waveTarget(t) {
      switch (t) {
        case "ownCapital":
          return this.areaPos({ at: "ownCapital", radiusKm: 0 });
        case "ownRefinery": {
          const n = this.ctx.geo.meta.scenario?.nations.find((x) => x.a3 === this.own);
          return n ? [n.refinery[0], n.refinery[1]] : this.hqPos(this.own) ?? this.mid;
        }
        case "contested":
          return this.areaPos({ at: "contested", radiusKm: 0 });
        case "midpoint":
          return this.mid;
        default:
          return this.hqPos(this.own) ?? this.mid;
      }
    }
    spawnWave(w) {
      const enemy = this.enemies[0];
      if (!enemy) return;
      const [tx, tz] = this.waveTarget(w.target ?? "ownHq");
      const eh = this.hqPos(enemy) ?? [tx + 100, tz];
      let dx = eh[0] - tx, dz = eh[1] - tz;
      const dl = Math.hypot(dx, dz) || 1;
      dx /= dl;
      dz /= dl;
      const dist = Math.min(w.distKm ?? 60, dl * 0.9);
      const ids = [];
      for (const [typeId, count] of w.units) {
        for (let i = 0; i < count; i++) {
          let u = null;
          for (let t = 0; t < 5 && !u; t++) {
            const k = dist * (1 - t * 0.15);
            const a = ids.length * 2.399 % 6.283, r = 0.4 + ids.length % 5 * 0.25;
            u = this.ctx.units.spawn(typeId, enemy, tx + dx * k + Math.cos(a) * r, tz + dz * k + Math.sin(a) * r, Math.atan2(-dx, dz));
          }
          if (u) ids.push(u.id);
        }
      }
      if (ids.length) this.ctx.units.issueMove(ids, tx, tz, { kind: "attackMove" });
      bus.emit("toast", { msg: w.label ?? "Feindliche Verb\xE4nde n\xE4hern sich!", kind: "warn" });
    }
    // ------------------------------------------------------------------ Start-Overrides
    /** Wird von load() aufgerufen (nach spawnStartingForces + economy.loadScenario) */
    applyStartOverride(o) {
      const ctx2 = this.ctx;
      const own = this.own;
      if (o.barrels !== void 0) {
        const p = ctx2.economy.pool(own);
        p.barrels = o.barrels;
        bus.emit("oil:balance", { owner: own, barrels: p.barrels, incomePerHour: p.incomePerHour });
      }
      const eh = this.hqPos(this.enemies[0] ?? "");
      for (const g of o.extraUnits ?? []) {
        let px, pz;
        if (g.near === "hq") [px, pz] = this.hqPos(own) ?? this.mid;
        else if (g.near === "spawn") {
          const n = ctx2.geo.meta.scenario?.nations.find((x) => x.a3 === own);
          [px, pz] = n ? [n.spawn[0], n.spawn[1]] : this.hqPos(own) ?? this.mid;
        } else {
          const f = ctx2.economy.fields[Number(g.near.slice(6))];
          [px, pz] = f ? [f.x, f.z] : this.hqPos(own) ?? this.mid;
        }
        const head = eh ? Math.atan2(eh[0] - px, -(eh[1] - pz)) : 0;
        for (let i = 0; i < g.count; i++) {
          const a = i * 2.399, r = 0.5 + 0.25 * i;
          ctx2.units.spawn(g.typeId, own, px + Math.cos(a) * r, pz + Math.sin(a) * r, head);
        }
      }
      if (o.enemyStrength !== void 0 && o.enemyStrength !== 1) this.scaleEnemy(o.enemyStrength);
      if (o.spawnEnemyNearFields) {
        for (const f of ctx2.economy.fields) {
          if (!f.owner || !this.enemies.includes(f.owner)) continue;
          ctx2.units.spawn("inf_squad", f.owner, f.x + 0.4, f.z + 0.2);
          ctx2.units.spawn("at_team", f.owner, f.x - 0.4, f.z + 0.3);
          ctx2.units.spawn("light_tank", f.owner, f.x, f.z - 0.5);
        }
      }
    }
    scaleEnemy(s) {
      const units2 = this.ctx.units;
      const pool = [];
      for (const u of units2.units) {
        if (!this.enemies.includes(u.owner) || u.hp <= 0 || u.type.damage <= 0 || u.type.mobility.domain !== "ground") continue;
        pool.push(u);
      }
      const f = Math.min(1, Math.abs(s - 1));
      if (f <= 0) return;
      const step = 1 / f;
      let acc = 0;
      for (const u of pool) {
        acc += 1;
        if (acc < step) continue;
        acc -= step;
        if (s < 1) units2.remove(u.id);
        else units2.spawn(u.type.id, u.owner, u.x + 0.35, u.z + 0.35, u.heading);
      }
    }
    // ------------------------------------------------------------------ Ende & Bericht
    end(result, reason) {
      if (this.result !== "running" || !this.current) return;
      this.result = result;
      this.reason = reason;
      statsTracker.setActive(false);
      if (result === "victory" && !this.current.skirmish) markCompleted(this.current.id);
      this.ctx.state.speed = 0;
      bus.emit("mission:ended", { missionId: this.current.id, result, reason });
    }
    /** Zusammenfassung für den Endbildschirm */
    report() {
      const own = statsTracker.of(this.own);
      let kills = 0, convRaided = own.convoysRaided;
      for (const e of this.enemies) kills += statsTracker.of(e).lost;
      const eco = this.ctx.economy;
      let held = 0;
      for (const f of eco.fields) if (f.owner === this.own) held++;
      return {
        missionId: this.current?.id ?? "",
        result: this.result,
        reason: this.reason,
        elapsedHours: this.elapsedHours,
        unitsLost: own.lost,
        unitsKilled: kills,
        barrelsDelivered: Math.round(own.delivered),
        fieldsHeld: held,
        fieldsTotal: eco.fields.length,
        convoysLost: own.convoysLost,
        convoysRaided: convRaided,
        bridgesBlown: statsTracker.bridgesBlown.length,
        civilKilled: Math.round(this.ctx.civil.stats.killed),
        warCrimes: this.getWarCrimes ? this.getWarCrimes() : null
      };
    }
  };

  // src/game/missions/Tutorial.ts
  var Tutorial = class {
    steps;
    index = -1;
    active = false;
    finished = false;
    /** Änderungsmeldung für die UI */
    onChange = null;
    /** wird nach Abschluss/Abbruch aufgerufen (Lead: Tutorial-Overlay ausblenden) */
    onEnd = null;
    d;
    flags = /* @__PURE__ */ new Set();
    sel = [];
    offs = [];
    acc = 0;
    startCam = 0;
    startPos = /* @__PURE__ */ new Map();
    a3;
    constructor(deps) {
      this.d = deps;
      this.a3 = () => deps.ctx.player() ?? deps.ctx.state.playerA3 ?? "";
      this.steps = this.buildSteps();
    }
    get total() {
      return this.steps.length;
    }
    get current() {
      return this.active && this.index >= 0 && this.index < this.steps.length ? this.steps[this.index] : null;
    }
    // ------------------------------------------------------------------ Ablauf
    start() {
      this.stop(false);
      this.active = true;
      this.finished = false;
      this.flags.clear();
      this.sel = [];
      this.offs.push(
        bus.on("units:selection", ({ ids }) => {
          this.sel = ids;
        }),
        bus.on("structure:added", (e) => {
          if (e.owner === this.a3()) this.flags.add("structure");
        }),
        bus.on("bridge:destroyed", () => {
          if (this.current?.id === "build") this.flags.add("structure");
        }),
        bus.on("bridge:repaired", () => {
          if (this.current?.id === "build") this.flags.add("structure");
        }),
        bus.on("oil:delivered", (e) => {
          if (e.owner === this.a3()) this.flags.add("delivered");
        }),
        bus.on("production:started", (e) => {
          if (e.owner === this.a3()) this.flags.add("production");
        })
      );
      const onKey = (e) => {
        if ((e.ctrlKey || e.metaKey) && /^Digit[1-9]$/.test(e.code)) this.flags.add("group");
      };
      const onClick = (e) => {
        const b = e.target?.closest?.("button");
        if (b && b.textContent?.trim() === "Nachschub") this.flags.add("tabSupply");
      };
      window.addEventListener("keydown", onKey, true);
      document.addEventListener("click", onClick, true);
      this.offs.push(() => window.removeEventListener("keydown", onKey, true), () => document.removeEventListener("click", onClick, true));
      this.goto(0);
    }
    stop(completed = false) {
      for (const o of this.offs) o();
      this.offs.length = 0;
      const was = this.active;
      this.active = false;
      if (completed) this.finished = true;
      if (was) {
        this.onChange?.();
        this.onEnd?.(completed);
      }
    }
    /** Aktuellen Schritt als erledigt werten und weiter („Weiter" / „Überspringen") */
    next() {
      if (!this.active) return;
      this.goto(this.index + 1);
    }
    skip() {
      this.next();
    }
    /** Alle weiteren Schritte überspringen */
    skipAll() {
      this.stop(false);
    }
    goto(i) {
      if (i >= this.steps.length) {
        bus.emit("tutorial:step", { index: this.steps.length, total: this.steps.length, text: "Tutorial abgeschlossen." });
        this.stop(true);
        return;
      }
      this.index = i;
      this.acc = 0;
      const s = this.steps[i];
      s.enter?.(this);
      bus.emit("tutorial:step", { index: i, total: this.steps.length, text: s.text });
      this.onChange?.();
    }
    /** pro Frame mit echtem dt (Sekunden) aufrufen */
    update(realDt) {
      if (!this.active) return;
      this.acc += realDt;
      if (this.acc < 0.2) return;
      this.acc = 0;
      const s = this.steps[this.index];
      if (!s || s.manual) return;
      if (s.poll?.(this)) this.goto(this.index + 1);
    }
    // ------------------------------------------------------------------ Hilfen
    selected() {
      return this.d.getSelectedIds ? this.d.getSelectedIds() : this.sel;
    }
    selectedHas(pred) {
      for (const id of this.selected()) {
        const u = this.d.ctx.units.get(id);
        if (u && u.owner === this.a3() && pred(u.type.category, u.type.id)) return true;
      }
      return false;
    }
    selectedOrder(kinds) {
      for (const id of this.selected()) {
        const u = this.d.ctx.units.get(id);
        if (!u) continue;
        const k = u.orders[0]?.kind;
        if (k && kinds.includes(k)) return true;
      }
      return false;
    }
    rememberSelectionPositions() {
      this.startPos.clear();
      for (const id of this.selected()) {
        const u = this.d.ctx.units.get(id);
        if (u) this.startPos.set(id, [u.x, u.z]);
      }
    }
    selectionMoved(km) {
      for (const [id, p] of this.startPos) {
        const u = this.d.ctx.units.get(id);
        if (u && Math.hypot(u.x - p[0], u.z - p[1]) > km) return true;
      }
      return false;
    }
    buildSteps() {
      return [
        {
          id: "welcome",
          manual: true,
          target: ".hud-oil",
          text: "Willkommen, Kommandeur. \xD6l ist deine einzige W\xE4hrung: F\xE4sser bezahlen Einheiten und Nachschub. Ich zeige dir kurz die wichtigsten Handgriffe."
        },
        {
          id: "select",
          target: "canvas",
          text: "W\xE4hle einen Panzer: Linksklick auf die Einheit oder mit gedr\xFCckter Maustaste einen Rahmen aufziehen.",
          poll: (t) => t.selectedHas((c) => c === "tank" || c === "ifv" || c === "recon")
        },
        {
          id: "move",
          target: "canvas",
          text: "Rechtsklick auf die Karte: Die ausgew\xE4hlte Einheit f\xE4hrt dorthin. Shift h\xE4ngt weitere Wegpunkte an.",
          enter: (t) => t.rememberSelectionPositions(),
          poll: (t) => t.selectedOrder(["move"]) || t.selectionMoved(0.4)
        },
        {
          id: "attackmove",
          target: ".up-orders",
          text: "Angriffsbewegung: Dr\xFCcke G und klicke aufs Ziel (oder Strg+Rechtsklick). Die Einheit bek\xE4mpft Feinde unterwegs. T h\xE4lt an, Y h\xE4lt die Stellung.",
          poll: (t) => t.selectedOrder(["attackMove"])
        },
        {
          id: "engineers",
          target: "canvas",
          text: "Pioniere bauen und sprengen. W\xE4hle einen Pioniertrupp (Pi).",
          poll: (t) => t.selectedHas((_c, id) => id === "engineer_squad")
        },
        {
          id: "build",
          target: ".up-cmd",
          text: "Dr\xFCcke C (Bauen) und platziere einen Graben oder Sands\xE4cke \u2013 oder sprenge (J) bzw. repariere (L) eine Br\xFCcke.",
          poll: (t) => t.flags.has("structure")
        },
        {
          id: "oil",
          manual: true,
          target: ".hud-oil",
          text: "Oben links: dein \xD6lguthaben, die Einnahmen pro Stunde und das \xD6l, das auf Tankwagen unterwegs ist. Nur was die Raffinerie erreicht, z\xE4hlt."
        },
        {
          id: "delivery",
          target: ".hud-speed",
          text: "Tankwagen holen \xD6l von deinen Feldern und fahren \xFCber die Stra\xDFen zur Raffinerie. Warte auf die erste Lieferung \u2013 mit + erh\xF6hst du das Tempo, Leertaste pausiert.",
          enter: (t) => t.flags.delete("delivered"),
          poll: (t) => t.flags.has("delivered")
        },
        {
          id: "production",
          target: ".hud-tabs .btn:nth-child(1)",
          text: '\xD6ffne den Reiter \u201EProduktion" rechts oben, w\xE4hle eine Basis und stelle eine Einheit in die Warteschlange. Das kostet F\xE4sser.',
          poll: (t) => t.flags.has("production")
        },
        {
          id: "supply",
          target: ".hud-tabs .btn:nth-child(2)",
          text: 'Im Reiter \u201ENachschub" siehst du Konvois, \xD6lfelder und die Versorgung deiner Einheiten. \xD6ffne ihn.',
          poll: (t) => t.flags.has("tabSupply") || (t.d.isTabOpen?.("supply") ?? false)
        },
        {
          id: "zoom",
          target: "canvas",
          text: "Kamera: Mausrad zoomt, WASD oder Bildschirmrand scrollt, Q/E dreht. Zoome jetzt ein St\xFCck hinein oder heraus.",
          enter: (t) => {
            t.startCam = t.d.getCameraDistance();
          },
          poll: (t) => {
            const d = t.d.getCameraDistance();
            return t.startCam > 0 && d > 0 && Math.abs(Math.log(d / t.startCam)) > 0.2;
          }
        },
        {
          id: "group",
          target: ".up-groups",
          text: "Kontrollgruppen: W\xE4hle Einheiten und dr\xFCcke Strg+1 (bis 9). Danach reicht die Ziffer, um sie wieder auszuw\xE4hlen.",
          poll: (t) => t.flags.has("group") || (t.d.hasControlGroup?.() ?? false)
        },
        {
          id: "done",
          manual: true,
          text: "Das war die Grundausbildung. Dein Auftrag: bringe 400 F\xE4sser zur Raffinerie. Der Feind h\xE4lt still, bis du fertig bist \u2013 nimm dir Zeit."
        }
      ];
    }
  };

  // src/game/countryData.ts
  function rs(v) {
    return {
      geld: v[0],
      oel: v[1],
      gas: v[2],
      stahl: v[3],
      nahrung: v[4],
      munition: v[5],
      seltene_erden: v[6],
      industriegueter: v[7],
      konsumgueter: v[8]
    };
  }
  var BUND_ALLIES = (self) => ["VAL", "MAR"].filter((a) => a !== self);
  var START_PROFILES = [
    {
      a3: "VAL",
      name: "Republik Valdoria",
      short: "Valdoria",
      capital: "Valdorn",
      flag: "\u{1F535}",
      color: "#4f7fbf",
      government: "Demokratie",
      bloc: "BUND",
      leaderTitle: "Pr\xE4sident",
      population: 6.2,
      gdp: 95,
      debtPct: 48,
      inflation: 3.1,
      zufriedenheit: 58,
      militaryBudget: 2.4,
      manpower: 22,
      tanks: 36,
      ifv: 54,
      artillery: 24,
      aircraft: 8,
      helicopters: 6,
      ships: 0,
      drones: 20,
      stock: rs([0, 0, 0, 0, 0, 0, 0, 0, 0]),
      production: rs([0, 0, 0, 0, 0, 0, 0, 0, 0]),
      consumption: rs([0, 0, 0, 0, 0, 0, 0, 0, 0]),
      allies: BUND_ALLIES("VAL"),
      tradePartners: [],
      relations: { MAR: 80, KRN: -90 },
      strengths: ["Ausgewogenes Heer mit guter Artillerie", "Gebirgsriegel im Norden verk\xFCrzt die Front", "Zwei Raffineriestra\xDFen durch das Tal"],
      weaknesses: ["\xD6lfelder liegen weit von der Hauptstadt", "Die Ebene im Osten ist offen", "Wenige Pioniere f\xFCr Br\xFCckenreparaturen"],
      difficulty: "Mittel",
      blurb: "Gebirgsland im Westen. Solide Streitkr\xE4fte, aber lange Versorgungswege."
    },
    {
      a3: "KRN",
      name: "F\xF6deration Kronland",
      short: "Kronland",
      capital: "Kronheim",
      flag: "\u{1F534}",
      color: "#bf4f4f",
      government: "Autorit\xE4r",
      bloc: "PAKT",
      leaderTitle: "Bundesmarschall",
      population: 9,
      gdp: 120,
      debtPct: 31,
      inflation: 5.4,
      zufriedenheit: 46,
      militaryBudget: 3.9,
      manpower: 34,
      tanks: 64,
      ifv: 90,
      artillery: 40,
      aircraft: 14,
      helicopters: 10,
      ships: 0,
      drones: 30,
      stock: rs([0, 0, 0, 0, 0, 0, 0, 0, 0]),
      production: rs([0, 0, 0, 0, 0, 0, 0, 0, 0]),
      consumption: rs([0, 0, 0, 0, 0, 0, 0, 0, 0]),
      allies: [],
      tradePartners: [],
      relations: { VAL: -90, MAR: -90 },
      strengths: ["St\xE4rkste Panzerwaffe der Region", "Eigene \xD6lfelder in der Ebene", "Zentral gef\xFChrt, schneller Aufmarsch"],
      weaknesses: ["Abh\xE4ngig von wenigen Fernstra\xDFen und Br\xFCcken", "Kriegsm\xFCde Bev\xF6lkerung", "Kein Zugang zum Meer"],
      difficulty: "Schwer",
      blurb: "Aggressor aus der Ebene im Osten. Viele Panzer, aber ein langer, verwundbarer Nachschubweg."
    },
    {
      a3: "MAR",
      name: "K\xF6nigreich Marenia",
      short: "Marenia",
      capital: "Marenburg",
      flag: "\u{1F7E2}",
      color: "#5fa86a",
      government: "Hybrid",
      bloc: "BUND",
      leaderTitle: "K\xF6nig",
      population: 3.1,
      gdp: 38,
      debtPct: 55,
      inflation: 4.2,
      zufriedenheit: 62,
      militaryBudget: 0.9,
      manpower: 11,
      tanks: 14,
      ifv: 24,
      artillery: 12,
      aircraft: 4,
      helicopters: 4,
      ships: 6,
      drones: 8,
      stock: rs([0, 0, 0, 0, 0, 0, 0, 0, 0]),
      production: rs([0, 0, 0, 0, 0, 0, 0, 0, 0]),
      consumption: rs([0, 0, 0, 0, 0, 0, 0, 0, 0]),
      allies: BUND_ALLIES("MAR"),
      tradePartners: [],
      relations: { VAL: 80, KRN: -90 },
      strengths: ["Gut verteidigte K\xFCste und H\xE4fen", "Kurze Wege zwischen Raffinerie und Hafen", "Kleine, aber hoch motivierte Armee"],
      weaknesses: ["Sehr wenig Land und Reserven", "Nur ein \xD6lfeld im Kernland", "Ohne Valdoria kaum zu halten"],
      difficulty: "Leicht",
      blurb: "Kleines K\xFCstenk\xF6nigreich im S\xFCden. Wenig Truppen, aber kurze Wege und ein starker Hafen."
    }
  ];
  var BY_A3 = new Map(START_PROFILES.map((p) => [p.a3, p]));
  function getProfile(a3) {
    return BY_A3.get(a3);
  }

  // src/ui/MissionPanel.ts
  function esc(s) {
    return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  }
  function fmtH(h) {
    const m = Math.floor(h * 60);
    return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")} h`;
  }
  var MissionPanel = class {
    layer;
    panel;
    title;
    body;
    missions;
    acc = 1;
    sig = "";
    collapsed = false;
    constructor(root, missions) {
      this.missions = missions;
      this.layer = document.createElement("div");
      this.layer.className = "ui-layer ms-layer hidden";
      this.panel = document.createElement("div");
      this.panel.className = "panel ms-panel";
      const head = document.createElement("div");
      head.className = "panel-head";
      this.title = document.createElement("span");
      const tg = document.createElement("span");
      tg.className = "ms-toggle";
      tg.textContent = "[\u2013]";
      head.append(this.title, tg);
      head.addEventListener("click", () => {
        this.collapsed = !this.collapsed;
        this.panel.classList.toggle("collapsed", this.collapsed);
        tg.textContent = this.collapsed ? "[+]" : "[\u2013]";
      });
      this.body = document.createElement("div");
      this.body.className = "ms-body";
      this.panel.append(head, this.body);
      this.layer.appendChild(this.panel);
      root.appendChild(this.layer);
      bus.on("mission:started", () => {
        this.sig = "";
        this.show();
        this.refresh();
      });
      bus.on("mission:objective", (e) => {
        if (e.state === "done") bus.emit("toast", { msg: `Ziel erreicht: ${e.text}`, kind: "info" });
        else if (e.state === "failed") bus.emit("toast", { msg: `Ziel gescheitert: ${e.text}`, kind: "warn" });
        else bus.emit("toast", { msg: `Neues Ziel: ${e.text}`, kind: "info" });
      });
      bus.on("mission:ended", () => this.refresh());
    }
    show() {
      this.layer.classList.remove("hidden");
    }
    hide() {
      this.layer.classList.add("hidden");
    }
    /** Position anpassen (CSS-Pixel), falls das HUD anders belegt ist */
    setPosition(top, left) {
      this.panel.style.setProperty("--ms-top", `${top}px`);
      this.panel.style.setProperty("--ms-left", `${left}px`);
    }
    /** pro Frame mit echtem dt (s) */
    update(realDt) {
      this.acc += realDt;
      if (this.acc < 0.25) return;
      this.acc = 0;
      this.refresh();
    }
    refresh() {
      const m = this.missions;
      const def = m.current;
      if (!def) {
        this.hide();
        return;
      }
      let sig = `${m.result}|${Math.floor(m.elapsedHours * 20)}`;
      for (const o of m.objectives) sig += `|${o.status}${o.visible ? 1 : 0}${o.detail}${Math.round(o.progress * 50)}`;
      if (sig === this.sig) return;
      this.sig = sig;
      this.title.textContent = def.name;
      const lim = def.timeLimitHours;
      const left = lim !== void 0 ? lim - m.elapsedHours : Infinity;
      let h = `<div class="ms-time"><span>Zeit ${fmtH(m.elapsedHours)}</span>${lim !== void 0 ? `<span class="${left < 1 ? "warn" : ""}">Limit ${fmtH(lim)}</span>` : "<span>kein Limit</span>"}</div>`;
      if (m.result !== "running") h += `<div class="ms-result ${m.result}">${m.result === "victory" ? "SIEG" : "NIEDERLAGE"}</div>`;
      const tops = m.objectives.filter((o) => o.visible && !o.parentId);
      const prim = tops.filter((o) => o.role === "primary");
      const sec = tops.filter((o) => o.role === "secondary");
      h += this.group(prim, m.objectives);
      if (sec.length) h += `<div class="ms-sect">Nebenziele</div>${this.group(sec, m.objectives)}`;
      this.body.innerHTML = h;
    }
    group(list, all) {
      let h = "";
      for (const o of list) {
        h += this.row(o, false);
        for (const c of all) if (c.parentId === o.id && c.visible) h += this.row(c, true);
      }
      return h;
    }
    row(o, sub) {
      const ic = o.status === "done" ? "\u2713" : o.status === "failed" ? "\u2717" : o.constraint ? "\u25C6" : "\u2610";
      const cls = ["ms-obj", o.status, o.role, o.constraint ? "constraint" : "", sub ? "sub" : ""].join(" ");
      const showBar = !o.constraint && o.status !== "failed" && o.progress > 0 && o.progress < 1;
      return `<div class="${cls}"><span class="ms-ic">${ic}</span><span class="ms-txt">${esc(o.text)}</span>` + (o.detail && o.status !== "done" ? `<span class="ms-det">${esc(o.detail)}</span>` : "") + (showBar ? `<span class="ms-bar"><i style="width:${Math.round(o.progress * 100)}%"></i></span>` : "") + "</div>";
    }
  };
  var CampaignMenu = class {
    backdrop;
    list;
    detail;
    selId = "m1";
    /** Wird mit der Missions-Id aufgerufen, wenn der Spieler „Mission starten" wählt */
    onStart = null;
    constructor(root) {
      this.backdrop = document.createElement("div");
      this.backdrop.className = "modal-backdrop hidden";
      const modal = document.createElement("div");
      modal.className = "panel modal camp-modal";
      const head = document.createElement("div");
      head.className = "panel-head";
      const t = document.createElement("span");
      t.textContent = "Kampagne Nordadria";
      const x = document.createElement("button");
      x.className = "btn btn-sm";
      x.textContent = "\u2715";
      x.addEventListener("click", () => this.close());
      head.append(t, x);
      const body = document.createElement("div");
      body.className = "camp-body";
      this.list = document.createElement("div");
      this.list.className = "camp-list";
      this.detail = document.createElement("div");
      this.detail.className = "camp-detail";
      body.append(this.list, this.detail);
      modal.append(head, body);
      this.backdrop.appendChild(modal);
      this.backdrop.addEventListener("click", (e) => {
        if (e.target === this.backdrop) this.close();
      });
      root.appendChild(this.backdrop);
    }
    get isOpen() {
      return !this.backdrop.classList.contains("hidden");
    }
    open() {
      const l = missionList();
      const cur = l.find((e) => e.id === this.selId);
      if (!cur || cur.state === "locked") this.selId = (l.find((e) => e.state === "open") ?? l[0]).id;
      this.render();
      this.backdrop.classList.remove("hidden");
    }
    close() {
      this.backdrop.classList.add("hidden");
    }
    render() {
      const l = missionList();
      this.list.replaceChildren();
      l.forEach((e2, i) => {
        const row = document.createElement("div");
        row.className = `camp-row ${e2.state}${e2.id === this.selId ? " sel" : ""}`;
        row.innerHTML = `<span class="n">${i + 1}</span><span class="nm">${esc(e2.name)}</span><span class="st">${e2.state === "locked" ? "\u{1F512}" : e2.state === "done" ? "\u2713" : "\u25B8"}</span>`;
        row.addEventListener("click", () => {
          if (e2.state === "locked") return;
          this.selId = e2.id;
          this.render();
        });
        this.list.appendChild(row);
      });
      const e = l.find((x) => x.id === this.selId) ?? l[0];
      const def = getMission(e.id);
      this.detail.replaceChildren();
      if (!def) return;
      const nation = getProfile(def.playerNation);
      const h = document.createElement("h3");
      h.textContent = def.name;
      const meta = document.createElement("div");
      meta.className = "camp-meta";
      meta.textContent = `${nation?.flag ?? ""} ${nation?.name ?? def.playerNation} \xB7 Gegner-KI: ${def.ai.difficulty}${def.timeLimitHours ? ` \xB7 Zeitlimit ${def.timeLimitHours} h` : ""}`;
      const ul = document.createElement("ul");
      ul.className = "camp-brief";
      for (const line of def.briefing) {
        const li = document.createElement("li");
        li.textContent = line;
        ul.appendChild(li);
      }
      const foot = document.createElement("div");
      foot.className = "camp-foot";
      const go = document.createElement("button");
      go.className = "btn btn-primary";
      go.textContent = "\u25B6 Mission starten";
      go.disabled = e.state === "locked";
      go.addEventListener("click", () => {
        this.close();
        this.onStart?.(def.id);
      });
      foot.appendChild(go);
      this.detail.append(h, meta, ul, foot);
    }
  };

  // src/ui/TutorialOverlay.ts
  var TutorialOverlay = class {
    layer;
    card;
    count;
    body;
    steps;
    wait;
    bNext;
    bSkip;
    pulse;
    tut;
    acc = 0;
    constructor(root, tutorial) {
      this.tut = tutorial;
      this.layer = document.createElement("div");
      this.layer.className = "ui-layer tut-layer hidden";
      this.card = document.createElement("div");
      this.card.className = "panel tut-card";
      const head = document.createElement("div");
      head.className = "panel-head";
      const t = document.createElement("span");
      t.textContent = "Grundausbildung";
      this.count = document.createElement("span");
      this.count.className = "muted";
      const end2 = document.createElement("button");
      end2.className = "btn btn-sm";
      end2.textContent = "Tutorial beenden";
      end2.addEventListener("click", () => this.tut.skipAll());
      head.append(t, this.count, end2);
      this.body = document.createElement("div");
      this.body.className = "tut-body";
      this.steps = document.createElement("div");
      this.steps.className = "tut-steps";
      const foot = document.createElement("div");
      foot.className = "tut-foot";
      this.wait = document.createElement("span");
      this.wait.className = "tut-wait";
      this.wait.textContent = "Warte auf deine Aktion \u2026";
      this.bSkip = document.createElement("button");
      this.bSkip.className = "btn btn-sm";
      this.bSkip.textContent = "\xDCberspringen";
      this.bSkip.addEventListener("click", () => this.tut.skip());
      this.bNext = document.createElement("button");
      this.bNext.className = "btn btn-sm active";
      this.bNext.textContent = "Weiter \u25B8";
      this.bNext.addEventListener("click", () => this.tut.next());
      foot.append(this.wait, this.bSkip, this.bNext);
      this.card.append(head, this.body, this.steps, foot);
      this.layer.appendChild(this.card);
      this.pulse = document.createElement("div");
      this.pulse.className = "tut-pulse hidden";
      this.layer.appendChild(this.pulse);
      root.appendChild(this.layer);
      this.tut.onChange = () => this.render();
    }
    /** Karte unten links statt oben mittig (falls das HUD kollidiert) */
    setCorner(bottomLeft) {
      this.card.classList.toggle("bl", bottomLeft);
    }
    render() {
      const t = this.tut;
      const s = t.current;
      if (!s) {
        this.layer.classList.add("hidden");
        this.pulse.classList.add("hidden");
        return;
      }
      this.layer.classList.remove("hidden");
      this.count.textContent = `Schritt ${t.index + 1} / ${t.total}`;
      this.body.textContent = s.text;
      this.steps.replaceChildren();
      for (let i = 0; i < t.total; i++) {
        const b = document.createElement("i");
        if (i < t.index) b.className = "done";
        else if (i === t.index) b.className = "cur";
        this.steps.appendChild(b);
      }
      this.bNext.style.display = s.manual ? "" : "none";
      this.bSkip.style.display = s.manual ? "none" : "";
      this.wait.style.display = s.manual ? "none" : "";
      this.place();
    }
    /** pro Frame (Positionsabgleich ~5×/s; der Tutorial-Schritt selbst wird per Tutorial.update() geprüft) */
    update(realDt) {
      this.acc += realDt;
      if (this.acc < 0.2) return;
      this.acc = 0;
      if (this.tut.active) this.place();
    }
    place() {
      const sel = this.tut.current?.target;
      const p = this.pulse;
      if (!sel) {
        p.classList.add("hidden");
        return;
      }
      if (sel === "canvas") {
        p.classList.remove("hidden");
        p.classList.add("frame");
        return;
      }
      p.classList.remove("frame");
      let el = null;
      try {
        el = document.querySelector(sel);
      } catch {
        el = null;
      }
      const r = el?.getBoundingClientRect();
      if (!r || r.width < 2 || r.height < 2 || el.offsetParent === null && getComputedStyle(el).position !== "fixed") {
        p.classList.add("hidden");
        return;
      }
      p.classList.remove("hidden");
      p.style.left = `${r.left - 3}px`;
      p.style.top = `${r.top - 3}px`;
      p.style.width = `${r.width + 6}px`;
      p.style.height = `${r.height + 6}px`;
    }
  };

  // src/ui/EndScreen.ts
  function esc2(s) {
    return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  }
  function dur(h) {
    const m = Math.round(h * 60);
    const d = Math.floor(m / 1440), hh = Math.floor(m % 1440 / 60), mm = m % 60;
    return `${d > 0 ? `${d} T ` : ""}${hh} Std ${String(mm).padStart(2, "0")} Min`;
  }
  var EndScreen = class {
    /** Rückgabe true = vollständig behandelt (kein automatisches location.reload() bei 'menu') */
    onAction = null;
    root;
    missions;
    el = null;
    timer = 0;
    constructor(root, missions) {
      this.root = root;
      this.missions = missions;
      bus.on("mission:ended", () => {
        window.clearTimeout(this.timer);
        this.timer = window.setTimeout(() => {
          const m = this.missions;
          if (m) this.showReport(m.report(), m.objectives, m.current?.skirmish ?? false);
        }, 700);
      });
    }
    get visible() {
      return !!this.el;
    }
    hide() {
      window.clearTimeout(this.timer);
      this.el?.remove();
      this.el = null;
    }
    /** Direkt anzeigen (auch für Tests mit Fake-Daten) */
    showReport(r, objectives = [], skirmish = false) {
      this.hide();
      const victory = r.result === "victory";
      const def = getMission(r.missionId);
      const next = victory && !skirmish ? nextMissionId(r.missionId) : null;
      const ov2 = document.createElement("div");
      ov2.className = `es-overlay ${victory ? "victory" : "defeat"}`;
      const row = (k, v, bad = false) => `<tr><td>${k}</td><td${bad ? ' class="bad"' : ""}>${v}</td></tr>`;
      const stats = row("Spielzeit", dur(r.elapsedHours)) + row("Eigene Verluste", String(r.unitsLost), r.unitsLost > 0) + row("Feindverluste", String(r.unitsKilled)) + row("Gelieferte F\xE4sser", String(r.barrelsDelivered)) + row("\xD6lfelder gehalten", `${r.fieldsHeld} / ${r.fieldsTotal}`) + row("Konvois verloren", String(r.convoysLost), r.convoysLost > 0) + row("Konvois abgefangen", String(r.convoysRaided)) + row("Br\xFCcken gesprengt", String(r.bridgesBlown)) + row("Zivile Opfer", String(r.civilKilled), r.civilKilled > 0) + (r.warCrimes !== null ? row("Kriegsverbrechen", String(r.warCrimes), r.warCrimes > 0) : "");
      const tops = objectives.filter((o) => !o.parentId && (o.visible || o.status !== "pending"));
      const objs = tops.map((o) => `<div class="${o.status === "done" ? "ok" : o.status === "failed" ? "no" : o.constraint ? "ok" : o.role === "secondary" ? "sec" : "no"}">${o.status === "done" || o.constraint && o.status === "active" ? "\u2713" : o.status === "failed" ? "\u2717" : "\u2013"} ${esc2(o.text)}${o.role === "secondary" ? ' <span class="muted">(optional)</span>' : ""}</div>`).join("");
      ov2.innerHTML = `
      <div class="panel es-panel">
        <div class="es-title">${victory ? "SIEG" : "NIEDERLAGE"}</div>
        <div class="es-mission">${esc2(def?.name ?? (skirmish ? "Freies Spiel" : "Mission"))}</div>
        <div class="es-reason">${esc2(r.reason)}</div>
        <div class="es-cols">
          <div><div class="es-sect">Bilanz</div><table class="es-table">${stats}</table></div>
          <div><div class="es-sect">Ziele</div><div class="es-objs">${objs || '<span class="muted">\u2013</span>'}</div></div>
        </div>
        <div class="es-buttons"></div>
      </div>`;
      const btns = ov2.querySelector(".es-buttons");
      const add = (label, a, primary = false) => {
        const b = document.createElement("button");
        b.className = `btn${primary ? " btn-primary" : ""}`;
        b.textContent = label;
        b.addEventListener("click", () => this.act(a));
        btns.appendChild(b);
      };
      if (next) add("N\xE4chste Mission \u25B8", "next", true);
      add("Wiederholen", "retry", !next);
      add("Hauptmen\xFC", "menu");
      this.root.appendChild(ov2);
      this.el = ov2;
    }
    act(a) {
      const handled = this.onAction ? this.onAction(a) : void 0;
      this.hide();
      if (a === "menu" && handled !== true) location.reload();
    }
  };

  // _misstest/entry.ts
  var bases = /* @__PURE__ */ new Map();
  var bid = 1;
  var addBase = (kind, owner) => bases.set(bid, { id: bid++, kind, owner, progress: 1 });
  addBase("hq", "VAL");
  addBase("refinery", "VAL");
  addBase("hq", "KRN");
  addBase("refinery", "KRN");
  var fields = [{ id: 1, name: "Feld Karsten-8", country: "KRN", owner: "KRN", x: 171, z: 79 }, { id: 3, name: "Medved", country: "VAL", owner: "VAL", x: 135, z: 61 }];
  var units = [{ id: 1, owner: "VAL", hp: 10, x: 0, z: 0, type: { id: "mbt_medium", category: "tank", damage: 5 }, orders: [] }];
  var ctx = {
    geo: { meta: { scenario: { nations: [{ a3: "VAL", capitalCity: 0, hq: [85, 53], refinery: [84, 52], spawn: [95, 57] }, { a3: "KRN", capitalCity: 1, hq: [248, 75], refinery: [250, 74], spawn: [255, 87] }] } } },
    state: { speed: 3, playerA3: "VAL" },
    war: { isHostile: (a, b) => a !== b && (a === "KRN" || b === "KRN") },
    player: () => "VAL",
    units: { units, get: (id) => units.find((u) => u.id === id), spawn: () => null, remove() {
    }, issueMove() {
    }, queryRadius: (_x, _z, _r, o) => {
      o.length = 0;
      return o;
    } },
    economy: { bases, fields, countBases: (a, k) => [...bases.values()].filter((b) => b.owner === a && b.kind === k).length, pool: () => ({ barrels: 500, incomePerHour: 20 }) },
    civil: { cities: [{ id: 0, name: "Valdorn", country: "VAL", controller: "VAL", x: 80, z: 55 }, { id: 1, name: "Kronheim", country: "KRN", controller: "KRN", x: 252, z: 76 }], stats: { killed: 340 } }
  };
  var ui = document.getElementById("ui");
  var ms = new MissionSystem(ctx);
  var panel = new MissionPanel(ui, ms);
  var end = new EndScreen(ui, ms);
  var tut = new Tutorial({ ctx, getCameraDistance: () => 80 });
  var ov = new TutorialOverlay(ui, tut);
  var camp = new CampaignMenu(ui);
  var q = new URLSearchParams(location.search).get("s");
  if (q === "panel" || q === "tut" || q === "end" || q === "defeat") {
    ms.load(CAMPAIGN[2]);
    bus.emit("oil:delivered", { owner: "VAL", barrels: 120, fieldId: 3 });
    fields[0].owner = "VAL";
    for (let i = 0; i < 40; i++) ms.update(0.03);
    panel.update(1);
  }
  if (q === "tut") {
    tut.start();
    bus.emit("units:selection", { ids: [1] });
    tut.next();
    tut.next();
    tut.next();
  }
  if (q === "end") {
    ms.load(CAMPAIGN[0]);
    for (let i = 0; i < 4; i++) bus.emit("oil:delivered", { owner: "VAL", barrels: 120, fieldId: 3 });
    for (let i = 0; i < 40; i++) ms.update(0.1);
    end.onAction = () => true;
    end.showReport(ms.report(), ms.objectives);
  }
  if (q === "defeat") {
    ms.load(CAMPAIGN[1]);
    for (const [id, b] of bases) if (b.owner === "VAL" && b.kind === "hq") bases.delete(id);
    for (let i = 0; i < 40; i++) ms.update(0.1);
    end.showReport({ ...ms.report(), warCrimes: 2 }, ms.objectives);
  }
  if (q === "camp") {
    try {
      localStorage.setItem("ww3.campaign", JSON.stringify({ done: ["m1", "m2"] }));
    } catch {
    }
    camp.open();
  }
  window.done = true;
})();
