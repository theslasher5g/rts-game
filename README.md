# WW3: EUROPE

Browserbasiertes 3D-Echtzeit-Strategiespiel: Grand Strategy (Wirtschaft, Handel, Politik) trifft taktisches RTS
im Retro-Look der PS2-Ära. Läuft komplett im Browser, ohne Installation.

> **Stand: Phase 5 – Kleine Karte, Öl-Wirtschaft, Nachschub und Produktion.** Das Spiel ist von ganz Europa auf ein Szenario von
> etwa 300 × 200 km umgestellt: reales Gelände (Alpen, Adriaküste, Ebene), aber erfundene Länder, Städte, Straßen und Ölfelder.
> Fokus: Positionierung und Gefecht. **Öl ist die einzige Währung**: Ölfelder erobern, Straßen halten, den Gegner abschneiden.

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

## Mehrspieler (Phase 7)

**Aufbau:** Host-autoritativ. Ein Spieler (Host) rechnet die komplette Simulation im Browser, die anderen senden Befehle und
bekommen Zustand und Ereignisse zurück. Ein kleiner Node-Server vermittelt nur Lobby und Nachrichten. Bis zu **4 Spieler**, vier
Nationen: Valdoria, Kronland, Marenia, Pannonien. Modus **2 gegen 2** (Valdoria + Marenia gegen Kronland + Pannonien) oder
**Jeder gegen jeden**. Nationen ohne Spieler führt auf Wunsch die KI; verlässt ein Gast das Spiel, übernimmt die KI seine Nation.

**Starten (zwei Terminals):**

```bash
npm run server
```

```bash
npm run dev
```

Beide Spieler öffnen die Adresse des Dev-Servers (die Lobby verbindet sich über `/ws` mit dem Server). Oder `npm run mp` startet beides.
Für Freunde im Netz: `npm run build`, dann `npm run server` (liefert Spiel und Relay auf Port 8787), Adresse und Raumcode teilen.
Ohne Server geht ein lokaler Test mit zwei Tabs im selben Browser („Lokaler Test“ in der Lobby).

**Ablauf:** Hauptmenü → „Mehrspieler“ → Raum erstellen oder mit Code beitreten → Nation wählen → „Bereit“ → der Host startet.
Im Spiel: Spielerliste mit Verbindungsanzeige, Chat mit Enter, nur der Host steuert Pause und Tempo.

**Grenzschutz:** In den ersten 10 Minuten Echtzeit (freies Gefecht und Mehrspieler) sind die Grenzen gesperrt und es wird nicht gekämpft.
Ein Banner zeigt den Countdown.

## Was Phase 7 sonst enthält

- **Fähigkeiten (F1–F6):** Aufklärungsflug, Nebelwand, Artilleriefeuer, Luftschlag, Versorgungsabwurf, Notreparatur. Kosten Fässer, haben
  Abklingzeit; auf eigene oder verbündete Zivilgebiete gesperrt.
- **Funkprotokoll** mit Sprung zur Karte, Pings auf der Minikarte, Fortschrittsbalken beim Einnehmen von Ölfeldern.
- **Feste Größen:** Gebäude, Fahrzeuge und Objekte wachsen beim Zoomen nicht mehr mit.
- **Qualitätsstufen** (niedrig, mittel, hoch) in den Einstellungen, FPS- und Leistungsanzeige mit Strg+Umschalt+P.
- **Mehr Tasten:** `.` und `,` wechseln durch untätige Einheiten, Strg+Umschalt+A wählt alle Kampfeinheiten, Pos1 springt zum HQ, Tab durch
  die Basen.
- **Spielmechanik:** Fahrzeuge in Depots reparieren sich, Erfahrung verringert erlittenen Schaden, Produktion hat einen Sammelpunkt je Basis.

## Was Phase 6 enthält

- **KI-Befehlshaber:** Kronland überfällt Tankwagen-Konvois, nimmt Ölfelder, sprengt Brücken auf deinen Versorgungsrouten, belagert Raffinerie
  und Hauptquartier, greift in Wellen an und zieht sich zurück, wenn es zu schwach ist. Marenia verteidigt als Verbündeter.
  Drei Stufen (leicht, mittel, schwer) mit unterschiedlicher Reaktionszeit, Wellengröße und Fähigkeiten. Die KI hat dieselbe Wirtschaft
  wie du und keine Gratis-Einheiten.
- **Missionen:** Sieg und Niederlage mit Endbildschirm (Bilanz: Verluste, Fässer, Felder, Konvois, Brücken, zivile Opfer), Kampagne mit
  7 Missionen („Erste Fässer“ bis „Entscheidung“) und freies Gefecht (Raffinerie und HQ des Gegners zerstören). Fortschritt wird im
  Browser gespeichert.
- **Anleitung:** Die erste Mission führt in 13 Schritten durch Auswahl, Befehle, Bauen, Ölfluss, Produktion und Kamera.
- **Nebel des Krieges:** Gegner siehst du nur, wenn eigene oder verbündete Einheiten sie sehen. Sichtlinien über Gelände und Rauch,
  Höhenbonus, Gelände und Minikarte werden dunkel (unerkundet) oder gedämpft (bekannt). In den Einstellungen abschaltbar.
- **Bedienung:** Jedes Fahrzeug ist ein eigener Verband (Infanterie bleibt in Trupps). Größerer Klickbereich mit Hervorhebung unter dem
  Mauszeiger. Die Befehlsknöpfe zeigen nur, was die Auswahl kann: Bauen, Sprengen und Reparieren nur für Pioniere, Gebäude besetzen nur
  für Infanterie.
- **Effekte:** Raketenspur und Einschlag kommen auch bei Zeitraffer gleichzeitig an.

## Detail-Update (Phase 5b)

- **Fahrzeuge:** Kampfpanzer, Schützenpanzer, Haubitzen, Raketenwerfer, Flugabwehr und LKW mit etwa dreimal so vielen Details.
  Türme drehen sich zum Ziel, Rohre schlagen beim Schuss zurück, Räder und Ketten laufen, Radar dreht sich. Ab 12 km wird
  automatisch eine einfachere Variante gezeichnet. Kampfpanzer gibt es in drei Varianten (Valdoria westlich, Kronland
  russisch, Marenia amerikanisch geprägt).
- **Infanterie:** Soldaten mit Helm, Weste, Rucksack und Waffenvarianten je Rolle (Gewehr, MG, Panzerabwehr, Scharfschütze, Sanitäter,
  Pionier, Mörser), eigene Tarnmuster je Nation, Lauf- und Zielanimation.
- **Flugzeuge und Schiffe:** Jäger, Bomber, Hubschrauber, Drohnen mit Fahrwerk, Nachbrenner und Positionslichtern; Schiffe mit
  drehenden Geschütztürmen und Radar.
- **Straßen:** Fahrbahnen mit Markierungen je Klasse, Bankett, Mittelstreifen, Rampen, Rastplätze, Bahnübergänge, Gleisbett mit
  Schwellen. 22 Arten von Straßenausstattung (Laternen, Leitplanken, Schilder, Schilderbrücken, Telefonmasten, Haltestellen,
  Oberleitungsmasten). Brücken als Balken, Bogen, Fachwerk oder Schrägseil, mit Trümmerzustand.
- **Häuser:** Läden mit Markisen, Balkone, Dachaufbauten, Fensterläden, Plattenbau-Treppenhäuser, Industriehallen, Kirchen, Scheunen.
  Straßenleben mit Laternen, Bäumen, geparkten Autos. Schadensstufen von leicht beschädigt bis Trümmer, brennende Gebäude.
- **Krater:** Echte Kraterschüsseln mit Wall und Auswurfstrahlen bei Einschlägen von Granaten, Raketen, Bomben und Lenkwaffen
  (Radius 1 bis 25 m), Glut bei großen Einschlägen, graue Asphaltkrater auf Straßen.

## Was Phase 5 enthält

- **Szenario „Operation Nordadria“:** 300 × 200 km, Raster 0,25 km, erzeugt aus echten Höhendaten. Drei erfundene Nationen
  (Valdoria, Kronland, Marenia) mit Grenzen entlang von Kämmen und Flüssen, 16 erfundene Städte, 9 Ölfelder, synthetisches
  Straßen- und Schienennetz mit 58 Brücken (Engstellen). Neu erzeugen: `npm run region` (optional `-- --seed 99`).
- **Öl-Wirtschaft:** Ölfelder fördern Fässer, Tankwagen-Konvois fahren auf dem echten Straßennetz zur Raffinerie. Angelieferte
  Fässer sind das Guthaben für Produktion und Nachschub. Gesprengte Brücken, Sperren und überfallene Konvois unterbrechen den
  Strom; Felder lassen sich erobern und beschädigen.
- **Nachschub:** Einheiten werden an Depots, HQ und Raffinerie aufgetankt und mit Munition versorgt; Nachschub-LKWs fahren zur
  Front. Ohne Nachschub sinkt die Moral.
- **Produktion:** Kaserne, Fabrik, Flugplatz, Werft und Depot (von Pionieren gebaut) produzieren Einheiten gegen Fässer.
  Panel „Produktion“ und „Nachschub“ am rechten Rand.
- **Gegner:** Die Nationen betreiben dieselbe Wirtschaft; ein einfacher Treiber produziert Streitkräfte (ein vollwertiger
  KI-Befehlshaber folgt in Phase 7).
- **Startbildschirm:** Briefing, drei Nationen zur Wahl mit Stärken und Schwächen, Seed-Feld (Kartengenerator zur Laufzeit folgt).

## Was Phase 4 enthält

- **Zivilisten:** Alle 172 Städte haben Einwohner, Zufriedenheit, Verluste und Zerstörungsgrad. Auf den Straßen fährt ziviler
  Verkehr, in Städten laufen Passanten (nur in Kameranähe simuliert, sonst gerechnet). Geschützte Infrastruktur:
  Krankenhäuser, Schulen, Kraftwerke, Wasserwerke und Häfen mit sichtbarem Schutzzeichen.
- **Schutzstatus:** Eigene und verbündete Städte können nicht beschossen oder bombardiert werden (Artillerie, Luftschläge,
  Bomben, Drohnen); direkter Beschuss zur Verteidigung bleibt erlaubt. Ein Feuerbefehl auf feindliche Städte verlangt eine
  Bestätigung mit Warnung, ein gezielter Angriff gilt als Kriegsverbrechen.
- **Ansehen:** Kriegsverbrechen, Kollateralschäden, Beschuss geschützter Infrastruktur und Missbrauch von Zivilisten als
  Schutzschild senken das internationale Ansehen und die Zufriedenheit zu Hause und radikalisieren die Opfer. Hilfslieferungen
  verbessern sie. Die Werte für Handel (Phase 6) und Bündnisse (Phase 7) sind schon vorbereitet.
- **Evakuierung:** Städte lassen sich im Panel „Bevölkerung“ evakuieren. Flüchtlinge fahren oder gehen auf den Straßen zu einer
  Aufnahmestadt und bremsen dort die eigenen Truppen. Gesprengte Brücken und Beschuss treffen die Kolonnen.
- **Besatzung:** Besetzte Städte brauchen eine Garnison, sonst steigt die Unruhe bis zum Aufstand.
- **Neue Einheiten:** Hilfskonvoi, Feldlazarett und Krankenwagen.
- **Detailliertere Einheiten:** rund zehnmal mehr Dreiecke, Tarnmuster, Laufwerke, Türme und Waffen. Kampfpanzer gibt es in
  westlicher, russischer und Standard-Variante.
- **Detailliertere Welt:** Städte mit Altstadt, Plattenbauten, Industrie, Hochhauskern, Parks und Fenstern; Wälder und
  Bäume, Dörfer mit Feldern, Feldparzellen, Hecken und Gesteinsschichten im Nahbereich des Geländes.

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
  civil/                    Zivilisten, Infrastruktur, Schutzstatus, Besatzung
  world/                    Karte, Städte, Wälder (Vegetation), Dörfer (Villages)
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
4. ✅ Zivilisten und Schutzstatus
5. ✅ Kleine Karte, Öl-Wirtschaft, Nachschub und Produktion
6. ✅ Missionen, Kampagne, Anleitung, Nebel des Krieges, KI-Befehlshaber
7. ✅ Mehrspieler (4er-Lobby), Fähigkeiten, Qualitätsstufen, Fehlerbehebung
8. Wetter, Jahreszeiten und Tageszeit
9. Zufallskarten, Speichern und Laden
10. Forschung, Drohnen, Balancing, Feinschliff

## Datenquellen & Lizenzen

- [Natural Earth](https://www.naturalearthdata.com/), gemeinfrei (public domain)
- [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/), Quellenangaben siehe
  [Attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)
- Grenzen nach Natural-Earth-Darstellung, ohne politische Wertung.
