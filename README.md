# bild2vrm – aus einem Bild einen VRM-Avatar erzeugen (lokal)

`bild2vrm` erzeugt aus **einem Ganzkörperbild** (Frontalansicht, stehende Figur) eine
**VRM-Datei** mit Humanoid-Skelett, die in VTuber-/Avatar-Programmen wie VSeeFace,
VMagicMirror, Warudo, VNyan, VRoid Hub, Blender (VRM-Add-on) oder Unity (UniVRM) geladen
werden kann. Alles läuft **lokal** – keine Cloud, kein Upload, die Web-Oberfläche bringt
sogar ihre 3D-Vorschau offline mit.

## Wie es funktioniert

1. **Freistellen** – nutzt die Transparenz des PNG; bei einfarbigem Hintergrund wird
   dieser automatisch entfernt (optional KI-Freistellen mit `rembg`).
2. **Gelenkpunkte** – Kopf, Hals, Schultern, Ellbogen, Handgelenke, Hüfte, Knie, Knöchel
   werden geschätzt (optional mit MediaPipe) und können in der Oberfläche per Maus
   korrigiert werden.
3. **2.5D-Mesh** – die Silhouette wird als Gitter-Mesh „aufgeblasen“ (runde Körperform
   statt flacher Pappe), Vorder- und Rückseite tragen das Bild als Textur.
   Arme werden vom Oberkörper getrennt, damit sie sich frei bewegen lassen.
4. **Rigging** – 20 VRM-Humanoid-Bones mit automatischen Skinning-Gewichten.
5. **T-Pose** – VRM erwartet eine T-Pose: hängende Arme werden waagerecht, Beine senkrecht
   ausgerichtet.
6. **Export** als VRM 0.x (Standard, für VSeeFace & Co.) oder VRM 1.0.

## Installation

Python 3.10+:

```bash
pip install -r requirements.txt
```

## Benutzung

### Oberfläche (empfohlen)

```bash
python -m bild2vrm --gui
```

Öffnet `http://127.0.0.1:8765` im Browser: Bild hineinziehen → Gelenkpunkte prüfen/verschieben
→ **VRM erzeugen**. Die Datei wird heruntergeladen und rechts als animierte 3D-Vorschau angezeigt.

### Kommandozeile

```bash
python -m bild2vrm figur.png                    # -> figur.vrm (VRM 0.x)
python -m bild2vrm figur.png --vrm 1 -o av.vrm  # VRM 1.0
python -m bild2vrm figur.png --save-keypoints kp.json   # Punkte speichern …
python -m bild2vrm figur.png --keypoints kp.json        # … bearbeitet wiederverwenden
```

Wichtige Optionen: `--height 1.6` (Körpergröße in m), `--depth 1.0` (Körperdicke, 0 = flach),
`--grid 140` (Mesh-Auflösung), `--keep-pose` (keine T-Pose-Korrektur),
`--background auto|alpha|flood|rembg|none`, `--pose auto|mediapipe|heuristic`,
`--name`, `--author`. Alle Optionen: `python -m bild2vrm -h`.

Keypoint-JSON: Pixelkoordinaten `[x, y]` für `head_top, neck, left_/right_shoulder, _elbow,
_wrist, _hip, _knee, _ankle`. **`left_*` = linke Körperseite der Figur, also im Bild rechts.**

## Gute Eingabebilder

- ganze Figur von Kopf bis Fuß, frontal, aufrecht stehend
- PNG mit transparentem Hintergrund (oder einfarbiger Hintergrund)
- Arme leicht vom Körper abgespreizt (A-Pose) oder T-Pose – Arme, die vor dem Körper liegen,
  lassen sich nicht sauber trennen
- Anime-/Comic-Figuren, Character-Sheets, VRoid-Screenshots funktionieren am besten

## Grenzen (ehrlich)

- Es entsteht ein **2.5D-Avatar**: von vorne sieht er aus wie das Bild, von der Seite ist er
  ein abgerundeter „Aufsteller“, die Rückseite zeigt das gespiegelte Vorderbild.
- **Keine Gesichtsausdrücke** (Blinzeln, Mundbewegung): Ausdrücke sind als leere Presets
  angelegt; Kopf-, Oberkörper- und Armbewegungen per Tracking funktionieren.
- Lange Haare/Röcke werden nicht als eigene Physik-Teile (Spring Bones) erzeugt.

## Warum kein Live2D?

Live2D-Modelle (`.moc3`) sind ein proprietäres Format, das nur mit dem Live2D Cubism Editor
erzeugt werden kann – es gibt keine offene Spezifikation und keinen freien Exporter. Ein Tool,
das aus einem Bild „echte“ Live2D-Dateien baut, ist deshalb lokal nicht seriös umsetzbar.
Die offene Alternative wäre Inochi2D; für 3D-/VTuber-Software ist VRM der offene Standard.

## Tests

```bash
python -m unittest discover -s tests
```

## Lizenzen

Mitgelieferte Bibliotheken für die Vorschau (`bild2vrm/static/vendor`): three.js (MIT) und
@pixiv/three-vrm (MIT), siehe die dortigen Lizenzdateien.
