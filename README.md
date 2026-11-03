# WW3: EUROPE

Browserbasiertes 3D-Echtzeit-Strategiespiel: Grand Strategy (Wirtschaft, Handel, Politik) trifft taktisches RTS
im Retro-Look der PS2-Ära. Läuft komplett im Browser, ohne Installation.

> **Stand: Phase 1 – Grundgerüst.** 3D-Karte Europas mit echten Grenzen und Höhendaten, isometrische RTS-Kamera
> mit stufenlosem Zoom, Länderauswahl mit Startwerten, PS2-Look-Shader.

## Schnellstart

Voraussetzung: [Node.js](https://nodejs.org/) ab Version 20.

```bash
npm install
```

```bash
npm run dev
```

Dann im Browser <http://localhost:5173> öffnen (Chrome, Edge oder Firefox mit WebGL2).

Für einen Produktions-Build (Ausgabe in `dist/`, statisch hostbar):

```bash
npm run build
```

```bash
npm run preview
```

Die fertig vorverarbeiteten Geodaten liegen bereits in `public/data/`. Neu erzeugen (lädt ca. 15 MB Rohdaten,
benötigt `curl`) mit:

```bash
npm run geodata
```

## Steuerung

| Aktion | Eingabe |
| --- | --- |
| Kamera verschieben | `W` `A` `S` `D` / Pfeiltasten, Bildschirmrand, rechte Maustaste ziehen |
| Schneller verschieben | `Shift` gedrückt halten |
| Zoom (zum Mauszeiger) | Mausrad – stufenlos von ganz Europa bis auf wenige Kilometer |
| Drehen | `Q` / `E` oder mittlere Maustaste ziehen (in Einstellungen abschaltbar) |
| Nordausrichtung | `R` oder `Pos1` |
| Land auswählen | Linksklick auf die Karte oder in der Länderliste |
| Heranfliegen | Doppelklick auf die Karte, Klick auf die Minikarte |
| Spielgeschwindigkeit | `Leertaste` = Pause, `1`–`5` = Tempo |

## Was Phase 1 enthält

- **Echte Geodaten:** Ländergrenzen, Seen, Flüsse und Städte aus Natural Earth (1:50m), Höhen und Meerestiefen
  aus den AWS Terrain Tiles (SRTM / GMTED / ETOPO). Projektion: Lambert-flächentreu, wie EPSG:3035
  (Standard für Europakarten). Raster: 2624 × 2240 Zellen à 2 km, also rund 5250 × 4480 km.
- **Gelände:** GPU-verschobenes Terrain in 64er-Chunks mit 6 LOD-Stufen, Instancing, Frustum-Culling und
  Randschürzen gegen Risse. Biome nach Höhe, Hangneigung und Breitengrad, Länder-Einfärbung und Grenzen
  direkt im Shader (Hover- und Auswahl-Hervorhebung), animiertes Wasser mit Tiefenfärbung.
- **PS2-Look:** Rendern in niedriger interner Auflösung, Vertex-Beleuchtung, Low-Res-Texturen,
  Farbquantisierung mit Bayer-Dithering, gedämpfte, schmutzige Farbpalette, Vignette und Distanznebel.
  Alles in den Einstellungen regelbar.
- **Kamera:** isometrische RTS-Kamera. Der Neigungswinkel passt sich dem Zoom an, gezoomt wird zum Mauszeiger,
  Kamerafahrten sind weich animiert.
- **Länderauswahl:** 17 spielbare Nationen mit Startwerten (Wirtschaft, Militär, Bevölkerung, Ressourcen,
  Handelspartner, Bündnisse, Beziehungen). Alle übrigen Länder sind auf der Karte vorhanden (später als KI-Nationen).
- **HUD:** Ressourcenleiste, Datum und Spieltempo, Minikarte, Länder-Infopanel und Platzhalter-Reiter
  für die folgenden Phasen.

## Projektstruktur

```
scripts/build-geodata.mjs   Geodaten-Pipeline (Download, Projektion, Rasterisierung)
public/data/                vorverarbeitete Karten-Assets (heights.png, countries.png, meta.json)
src/
  main.ts                   Bootstrap, Event-Verdrahtung, Game-Loop
  core/                     Typen, Event-Bus, Eingabe
  world/                    GeoData, Terrain (LOD), Wasser, Städte, Picking
  render/                   Renderer + PS2-Post-Processing
  camera/                   RTS-Kamera
  game/                     Spielzustand, Länder-Startprofile
  ui/                       Hauptmenü, HUD, Minikarte, Labels, Einstellungen
```

**Konventionen:** 1 Welteinheit = 1 km, X = Osten, Z = Süden, Y = Höhe × Überhöhung.
Die Module sind über einen typisierten Event-Bus entkoppelt (`src/core/EventBus.ts`), damit sie in späteren Phasen
server-autoritativ (Multiplayer) angebunden werden können.

## Roadmap

1. ✅ Grundgerüst: Karte, Kamera, Länderauswahl, PS2-Shader
2. Straßennetz (OSM) als Navigationsgraph, Einheiten, Auswahl, Formationen
3. Kampfsystem, Effekte, Deckung, Gebäude, Gräben, Brücken sprengen
4. Zivilisten und Schutzstatus
5. Ressourcen, Zufriedenheit, Logistik, Produktion
6. Handelssystem
7. Politik und Allianzen
8. Jahreszeiten und Wetter
9. Multiplayer
10. Forschung, Drohnen, KI, Balancing

## Datenquellen & Lizenzen

- [Natural Earth](https://www.naturalearthdata.com/), gemeinfrei (public domain)
- [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/), Quellenangaben siehe
  [Attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)
- Grenzen nach Natural-Earth-Darstellung, ohne politische Wertung.
