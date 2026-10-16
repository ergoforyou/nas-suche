# Video-Freisteller

Kleines Windows-Programm, mit dem man Videos **schneiden** und den **Hintergrund freistellen** kann.
Der Export erfolgt als **WebM mit Transparenz**. Alles wird lokal auf dem eigenen Rechner berechnet, nichts wird hochgeladen.

## Installation

1. ZIP herunterladen (GitHub → *Actions* → „Video-Freisteller (Windows-EXE)“ → letzter Lauf → Artefakt
   *VideoFreisteller-Windows*, oder unter *Releases*).
2. Entpacken, z. B. nach `C:\Programme\VideoFreisteller`.
3. `VideoFreisteller.exe` starten. Eine Installation ist nicht nötig. ffmpeg und das KI-Modell sind enthalten.

> Windows SmartScreen kann beim ersten Start warnen, weil die EXE nicht signiert ist.
> Dann auf „Weitere Informationen“ → „Trotzdem ausführen“ klicken.

## Bedienung

**Video laden:** Datei ins Fenster ziehen oder „Video öffnen…“ (Strg+O).

**Schneiden**
- Mit der Zeitleiste, den Pfeiltasten (←/→ = 1 Bild, Shift+←/→ = 1 Sekunde) oder der Leertaste (Abspielen) zur Stelle springen.
- `I` setzt den Anfang, `O` setzt das Ende. Der gelbe Balken zeigt den aktuellen Bereich.
- Ohne weitere Schritte wird nur der Bereich von Anfang bis Ende exportiert.
- Für mehrere Stücke jeden Bereich mit „＋ Bereich zur Liste“ übernehmen. Die grünen Abschnitte werden in dieser
  Reihenfolge aneinandergehängt. Ein Doppelklick auf einen Listeneintrag springt zu diesem Bereich.
- Der Ton wird automatisch passend mitgeschnitten.

**Freistellen**

| Modus | Wofür |
|---|---|
| **KI – Person automatisch** (empfohlen) | Personen vor beliebigem Hintergrund, ohne Green-Screen. Arbeitet mit „Robust Video Matting“: weiche Haarkanten und kein Flackern zwischen den Bildern. |
| **Farbe** | Green-Screen, Blue-Screen oder **weißer Hintergrund**. Die Farbe mit der Pipette direkt im Bild anklicken. |
| **Nicht freistellen** | Nur schneiden bzw. umwandeln. |

- **KI-Modell:** „Genau“ (ResNet50) ist der Standard. Es erfasst Hände und Füße zuverlässig und ist kaum langsamer als „Schnell“ (MobileNet). Beide Modelle sind eingebaut.
- **Detailstufe:** 1,0 lassen. Niedriger macht die Kante verwaschen (Aura um die Figur). Höher bringt feinere Haare, dafür können unsichere Stellen wie Hände oder Füße wegfallen.
- **Toleranz / Weicher Übergang** (Farbe): Die Toleranz legt fest, was komplett verschwindet. Der weiche Übergang bestimmt, wie breit die Abstufung zur vollen Deckung ist (fein graduierte Kante).
- **Auto (Bildrand):** übernimmt die häufigste Farbe am Bildrand als Hintergrundfarbe, wie im KI-Assistenten.
- **Nur vom Bildrand aus entfernen** (wird bei „Weiß“ automatisch eingeschaltet): Es verschwindet nur Hintergrund, der mit dem
  Rand verbunden ist. Ein weißes Hemd vor weißer Wand bleibt also erhalten. Große, gleichmäßige Lücken, z. B. zwischen Arm
  und Körper, werden trotzdem entfernt.
- **Farbsaum entfernen / Kantenfarben entmischen:** entfernt grünen Schimmer bzw. hellen Saum an Haaren und Kanten.
- **Kanten feinjustieren** (gilt für beide Verfahren):
  - *An Bilddetails anpassen:* Die Kante folgt feinen Strukturen im Bild.
  - *Aura entfernen* (Standard 0,4): entfernt den hellen oder farbigen Schleier um die Figur. Bei Bedarf höher stellen.
    Bei sehr feinen, abstehenden Haaren eher niedriger.
  - *Schrumpfen/Erweitern:* in Pixeln.
  - *Weichzeichnen:* macht die Kante weicher.
  - *Alpha-Schwarz-/Weißpunkt:* Schleier wegnehmen bzw. fast deckende Stellen ganz deckend machen.
- **Ansicht „Maske (Alpha)“:** Weiß ist deckend, Schwarz transparent, Grau halbtransparent. Damit lässt sich die Abstufung am besten beurteilen.
- **Ansicht „Vorher | Nachher“** zeigt den direkten Vergleich. Als Hintergrund für die Vorschau gehen Schachbrett, Farben oder ein eigenes Bild.

**Wenn eine „Aura“ oder ein Saum um die Figur bleibt**
1. „Aura entfernen“ auf 0,6 bis 0,8 stellen.
2. „Kante schrumpfen“ auf 1 bis 2 px stellen.
3. In der Ansicht „Maske (Alpha)“ prüfen, ob um die Figur noch ein grauer Hof zu sehen ist. Wenn ja, den Alpha-Schwarzpunkt
   etwas anheben (z. B. 0,1).
4. Bei KI: „Kantenfarben bereinigen“ eingeschaltet lassen. Bei Farbe: „Kantenfarben entmischen“ eingeschaltet lassen.

**Transparenz prüfen:** Der Windows-Mediaplayer, „Filme & TV“ und VLC zeigen bei WebM keine Transparenz an. Dort sieht man
den alten Hintergrund. Nach dem Export deshalb auf **„Mit Transparenz ansehen“** klicken: Das öffnet das Video in Edge auf
Schachbrett, Schwarz, Weiß usw.

**Export (Strg+E)**

| Format | Transparenz | Hinweis |
|---|---|---|
| WebM (VP9) | ja | für Web und Browser. Im KI-Assistenten als Avatar-Video direkt nutzbar (Freistellen: „Video ist schon freigestellt“). |
| MOV ProRes 4444 | ja | für Premiere, DaVinci Resolve, Final Cut |
| MP4 (H.264) | nein | MP4 kann technisch keine Transparenz. Der Hintergrund wird mit einer wählbaren Farbe gefüllt. |

Die Grafikkarte wird über DirectML genutzt, wenn eine vorhanden ist (NVIDIA, AMD oder Intel). Sonst rechnet der Prozessor.
Im KI-Bereich steht, worauf gerade gerechnet wird.

## Entwicklung

```bash
pip install -r requirements.txt
python app.py
```

ffmpeg/ffprobe müssen im PATH liegen oder in `ffmpeg/`. Das KI-Modell gehört nach `models/` oder wird beim
ersten Start automatisch geladen. Die EXE baut der GitHub-Workflow `.github/workflows/video-freisteller.yml`
(PyInstaller auf `windows-latest`). Ein Tag `video-freisteller-v1.0` erzeugt zusätzlich ein Release mit der ZIP.

## Lizenzen

- Robust Video Matting (Modell): GPL-3.0, https://github.com/PeterL1n/RobustVideoMatting
- ffmpeg (BtbN-Build): GPL
- PySide6/Qt: LGPL

Für die interne Nutzung ist das unproblematisch. Wird das Programm an Dritte weitergegeben, gelten die Bedingungen der GPL.
