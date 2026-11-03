# WW3: EUROPE

Browserbasiertes 3D-Echtzeit-Strategiespiel: Grand Strategy (Wirtschaft, Handel, Politik) trifft taktisches RTS
im Retro-Look der PS2-Ära. Läuft komplett im Browser, ohne Installation.

> **Stand: Phase 3 – Kampf.** Zusätzlich zu Phase 1 (3D-Karte, Kamera, Länderauswahl, PS2-Look) und Phase 2 (Straßennetz,
> Einheiten, Befehle): Kampfsystem mit Effekten, Deckung für Infanterie, Gebäude besetzen, Gräben und Befestigungen,
> Brücken sprengen und reparieren.

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
| Zeitraffer | `Leertaste` = Pause, `+` / `-` = Tempo (×10 bis ×7200) |

### Einheiten (Phase 2)

Tasten sind für deutsche QWERTZ-Tastaturen beschriftet. WASD bleibt der Kamera vorbehalten.

| Aktion | Eingabe |
| --- | --- |
| Einheit auswählen | Linksklick; `Shift` fügt hinzu; Doppelklick wählt alle gleichen Typs im Bild |
| Rahmenauswahl | Linke Maustaste ziehen |
| Bewegen | Rechtsklick; `Shift` + Rechtsklick hängt Wegpunkt an |
| Blickrichtung und Formationsbreite | Rechte Maustaste ziehen (mit Auswahl; ohne Auswahl verschiebt es die Karte) |
| Angriffsbewegung / Rückwärts / Patrouille | `G` / `V` / `B`, dann Linksklick (oder `Strg` + Rechtsklick für Angriffsbewegung) |
| Stopp / Halten | `T` / `Y` |
| Formation wechseln | `F` (Linie, Kolonne, Keil, Verteilt) |
| Kontrollgruppen | `Strg`+`1`–`9` belegen, `1`–`9` abrufen (doppelt = Kamera hin), `Shift`+`1`–`9` hinzufügen |
| Alle im Bild | `Strg`+`A` |
| Auswahl aufheben | `Esc` |
| Einheit zum Testen erzeugen | Button „+ Einheit“ im Befehlspanel, dann auf die Karte klicken |
| Angreifen | Rechtsklick auf einen feindlichen Verband (nur Länder im Krieg) |
| Feuerbefehl | `K`, dann Zielpunkt: Artillerie, Mörser, Raketenwerfer, Panzer beschießen ein Gebiet |
| Gebäude besetzen / räumen | `N`, dann Gebäude anklicken / `X` |
| Bauen (Pioniere) | Button „Bauen“, Bauwerk wählen, Start- und Endpunkt klicken (`Shift` verlängert) |
| Brücke sprengen / reparieren | `J` / `L`, dann Brücke anklicken (Pioniere nötig) |

**Krieg testen:** Im Panel „+ Einheit“ oben einen fremden Besitzer wählen, Einheiten platzieren und „Krieg erklären“
drücken. Einheiten von Ländern im Krieg bekämpfen sich automatisch. Bis zur Diplomatie (Phase 7) gibt es keinen
anderen Weg, einen Krieg auszulösen.

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

## Was Phase 2 enthält

- **Straßennetz:** Natural-Earth-Straßen (1:10m) und Bahnstrecken, zu einem Graphen mit rund 26.000 Knoten und
  33.000 Kanten verbunden. Brücken sind eigene Kanten (Vorbereitung für das Sprengen in Phase 3). OpenStreetMap ist aus der
  Entwicklungsumgebung nicht erreichbar; ein OSM-Import kann später ergänzt werden. Neu erzeugen: `npm run roads`.
- **Wegfindung:** Straße, Gelände (Hangneigung bremst, Flüsse blockieren) und See, mit Fähren. Schwere Fahrzeuge sind
  auf Straßen deutlich schneller. Typische Routen dauern unter 5 ms.
- **Einheiten:** 28 Typen (Infanterie, Panzer, Artillerie, Flugabwehr, Hubschrauber, Jets, Drohnen, Schiffe) mit eigenen
  Low-Poly-Modellen. Aus der Ferne erscheinen NATO-Symbole (blau = eigene und verbündete, rot = feindlich, grün = neutral).
- **Verbände:** Formationen, Verbandsgeschwindigkeit = langsamste Einheit, Wegpunkte, Patrouille.
- **Zeitraffer:** Stufe 1 entspricht 10-facher Echtzeit, damit die Einheiten taktisch steuerbar bleiben.

## Was Phase 3 enthält

- **Kampf:** Sichtlinien über Gelände, Gebäude und Rauch; Treffer abhängig von Entfernung, Deckung und Panzerung
  (Front, Seite, Heck); Unterdrückung und Moral, Munition und Erfahrung. Alle 28 Einheitentypen haben Waffen, darunter
  Panzerkanonen, Panzerabwehrlenkwaffen, Artillerie mit Streuung, Raketenwerfer, Flugabwehr, Hubschrauber, Jets,
  Bomber, FPV-Drohnen, Schiffe und U-Boote.
- **Infanterie-Taktik:** Soldaten suchen selbst Deckung hinter Mauern, Wracks, Gräben, Trümmern und Geländekanten,
  ändern die Haltung (stehen, kauern, liegen), springen über niedrige Hindernisse, weichen Granaten aus und werden von
  Sanitätern versorgt. Unterdrückte Trupps bleiben liegen.
- **Effekte:** Partikel-Explosionen, Feuer, Rauchsäulen, Mündungsfeuer, Leuchtspur, Raketenspuren, Trümmer,
  Schockwellen, Einschlagskrater, ausgebrannte Wracks, Kamerawackeln und synthetisierte Geräusche (ohne Audiodateien).
- **Bauwerke:** Gräben, Sandsäcke, Panzersperren, Stacheldraht, Bunker, MG-Nester, Mörser- und PAK-Stellungen,
  Schützenlöcher, Minenfelder und Straßensperren. Pioniere bauen sie in Spielzeit, Fortschritt ist sichtbar.
- **Gebäude:** Infanterie besetzt Stadtgebäude (Deckung und Sichtbonus). Beschädigte Gebäude dunkeln und kippen, zerstörte
  fallen zu Trümmern zusammen.
- **Brücken:** Pioniere legen Sprengladungen, ziehen sich zurück und sprengen. Die Kante im Wegenetz wird gesperrt, die
  Wegfindung weicht aus. Reparatur ist möglich.

## Projektstruktur

```
scripts/build-geodata.mjs   Geodaten-Pipeline (Download, Projektion, Rasterisierung)
scripts/build-roads.mjs     Straßen-/Schienengraph aus Natural Earth
public/data/                vorverarbeitete Karten-Assets (heights.png, countries.png, meta.json)
src/
  main.ts                   Bootstrap, Event-Verdrahtung, Game-Loop
  core/                     Typen, Event-Bus, Eingabe
  world/                    GeoData, Terrain (LOD), Wasser, Städte, Picking
  render/                   Renderer + PS2-Post-Processing
  camera/                   RTS-Kamera
  nav/                      Straßengraph, Wegfindung, Straßen-Rendering
  units/                    Einheitentypen, Simulation, Modelle und NATO-Symbole
  control/                  Auswahl, Befehle, Kontrollgruppen, Kampf-/Bau-Befehle
  combat/                   Kampfsystem, Waffen, Sichtlinien
  tactics/                  Deckungssystem, Infanterie-KI
  structures/               Befestigungen, Gebäude-Besetzung, Brücken
  fx/, audio/               Partikel, Wracks, Kamerawackeln, Geräusche
  game/                     Spielzustand, Länder-Startprofile
  ui/                       Hauptmenü, HUD, Minikarte, Labels, Einstellungen
```

**Konventionen:** 1 Welteinheit = 1 km, X = Osten, Z = Süden, Y = Höhe × Überhöhung.
Die Module sind über einen typisierten Event-Bus entkoppelt (`src/core/EventBus.ts`), damit sie in späteren Phasen
server-autoritativ (Multiplayer) angebunden werden können.

## Roadmap

1. ✅ Grundgerüst: Karte, Kamera, Länderauswahl, PS2-Shader
2. ✅ Straßennetz als Navigationsgraph, Einheiten, Auswahl, Formationen
3. ✅ Kampfsystem, Effekte, Deckung, Gebäude, Gräben, Brücken sprengen
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
