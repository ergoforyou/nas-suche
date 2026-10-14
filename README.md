# bild2vrm – aus einem Bild einen VRM-Avatar erzeugen (lokal)

`bild2vrm` erzeugt aus **einem Ganzkörperbild** (Frontalansicht, stehende Figur) – optional
ergänzt um **Rück- und Seitenansicht** – eine **VRM-Datei** mit Humanoid-Skelett und **Mimik**, die in VTuber-/Avatar-Programmen wie VSeeFace,
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
6. **Mimik** – Augen und Mund werden erkannt; daraus entstehen Blinzeln (beide/links/rechts),
   die Mundformen A, I, U, E, O für Lippensynchronisation sowie „fröhlich“ und „entspannt“.
7. **Zusatzansichten** – eine Rückansicht wird zur Textur der Rückseite (statt gespiegelter
   Front), eine Seitenansicht liefert das echte Körperprofil (Nase, Brust, Bauch, Po, Hinterkopf).
8. **Export** als VRM 0.x (Standard, für VSeeFace & Co.) oder VRM 1.0.

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

Öffnet `http://127.0.0.1:8765` im Browser: Frontbild hineinziehen (optional Rück- und
Seitenansicht oder gleich ein ganzes Turnaround-Blatt laden) → Gelenkpunkte und die Kästen um
Augen und Mund prüfen/verschieben → **VRM erzeugen**. Die Datei wird heruntergeladen und rechts als
animierte 3D-Vorschau angezeigt – mit Knöpfen zum Testen aller Ausdrücke, Auto-Blinzeln und
einer Sprech-Demo.

### Kommandozeile

```bash
python -m bild2vrm figur.png                    # -> figur.vrm (VRM 0.x)
python -m bild2vrm figur.png --vrm 1 -o av.vrm  # VRM 1.0
python -m bild2vrm figur.png --save-keypoints kp.json   # Punkte speichern …
python -m bild2vrm figur.png --keypoints kp.json        # … bearbeitet wiederverwenden
python -m bild2vrm front.png --back ruecken.png --side seite.png   # mit Zusatzansichten
python -m bild2vrm --sheet turnaround.png              # Blatt mit Front/Seite/Rücken nebeneinander
```

Wichtige Optionen: `--height 1.6` (Körpergröße in m), `--depth 1.0` (Körperdicke, 0 = flach),
`--grid 140` (Mesh-Auflösung), `--keep-pose` (keine T-Pose-Korrektur), `--no-face` (keine Mimik),
`--side-facing auto|left|right` (Blickrichtung im Seitenbild),
`--background auto|alpha|flood|rembg|none`, `--pose auto|mediapipe|heuristic`,
`--name`, `--author`. Alle Optionen: `python -m bild2vrm -h`.

Keypoint-JSON: Pixelkoordinaten `[x, y]` für `head_top, neck, left_/right_shoulder, _elbow,
_wrist, _hip, _knee, _ankle`, optional Kästen `[x0, y0, x1, y1]` für `left_eye_box`,
`right_eye_box`, `mouth_box`. **`left_*` = linke Körperseite der Figur, also im Bild rechts.**

## Mehrere Ansichten vorab erzeugen

Das Ergebnis wird deutlich besser, wenn neben der Frontansicht auch **Rücken** und **Seite**
vorliegen. Am einfachsten ist ein *Turnaround-* bzw. *Character-Sheet*: alle Ansichten
nebeneinander auf einfarbigem Hintergrund. Mit einem Bildgenerator geht das z. B. mit:

> character turnaround sheet of [Beschreibung der Figur], full body, front view, side view,
> back view, standing in A-pose, arms slightly away from the body, same scale, plain white
> background, flat lighting

Worauf es ankommt:

- **gleiche Pose und gleiche Größe** in allen Ansichten (Rückseite wird an der Front ausgerichtet)
- Figuren **nicht überlappend**, mit etwas Abstand nebeneinander
- Seitenansicht **im echten Profil** (90°), egal ob nach links oder rechts schauend
- Fotos realer Personen: Front, Seite, Rücken vor ruhigem Hintergrund aufnehmen

Eine Draufsicht (von oben) wird nicht benötigt – Breite kommt aus der Front-, Tiefe aus der
Seitenansicht.

## Gute Eingabebilder

- ganze Figur von Kopf bis Fuß, frontal, aufrecht stehend
- PNG mit transparentem Hintergrund (oder einfarbiger Hintergrund)
- Arme leicht vom Körper abgespreizt (A-Pose) oder T-Pose – Arme, die vor dem Körper liegen,
  lassen sich nicht sauber trennen
- Anime-/Comic-Figuren, Character-Sheets, VRoid-Screenshots funktionieren am besten

## Grenzen (ehrlich)

- Es entsteht ein **2.5D-Avatar**: von vorne sieht er aus wie das Bild; ohne Seitenansicht ist er
  von der Seite ein abgerundeter „Aufsteller“, ohne Rückansicht zeigt die Rückseite das
  gespiegelte Vorderbild. Seitlich wird die Textur der Front-/Rückansicht über die Rundung
  gezogen – eigene Seitentexturen gibt es nicht.
- **Mimik** wird aus dem Bild gezeichnet (geschlossenes Auge als Lidstrich, Mundformen als
  Öffnungen). Das wirkt bei Anime-/Comic-Stil gut, bei Fotos eher stilisiert. Die Kästen um
  Augen und Mund sollten in der Oberfläche geprüft werden.
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
