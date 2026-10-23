# Video-Freisteller

Kleines Windows-Programm, mit dem man Videos **schneiden** und die Person **freistellen** kann. Standardmäßig landet sie
**auf weißem Hintergrund (MP4)**, auf Wunsch auch transparent (WebM/MOV). Alles wird lokal auf dem eigenen Rechner
berechnet, nichts wird hochgeladen.

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

**Freistellen – in drei Schritten**
1. Video öffnen. Die KI erkennt die Person automatisch.
2. Rechts unter „Ergebnis“ ist schon alles passend eingestellt: Hintergrund **Weiß**, Kante **Sauber – keine Aura**.
3. „Exportieren…“ klicken. Es entsteht eine MP4-Datei mit weißem Hintergrund.

Die Vorschau zeigt das Ergebnis so, wie es exportiert wird („Hintergrund: Wie Export“).

**Ergebnis-Einstellungen**
- **Erkennung:**
  - *Standard – schnell:* Video-KI (Robust Video Matting). Rechnet schnell und flimmerfrei, erkennt aber alle Personen
    im Bild und schneidet Gegenstände in der Hand eher ab.
  - *Maximal – wie im KI-Assistenten (BiRefNet):* dasselbe Modell wie im KI-Assistenten. Erkennt die Hauptperson samt
    Händen, Füßen und Gegenständen in der Hand am genauesten, Personen im Hintergrund bleiben weg. Ohne Grafikkarte ist es
    deutlich langsamer (mehrere Sekunden pro Bild). Unter der Auswahl steht nach dem ersten Vorschaubild, wie lange der
    Export ungefähr dauert.
  - *Sehr schnell:* nur für schwache Rechner.
- **Hintergrund:** *Weiß* (Standard), *Transparent* (WebM/MOV, z. B. für den KI-Assistenten) oder *Eigene Farbe*.
- **Kante „Sauber“** (Standard): Die Kante ist klar und liegt vollständig auf der Person. Es bleibt kein halbdurchsichtiger
  Rand mit Resten des alten Hintergrunds, also **keine Aura**. Feine, abstehende Haarspitzen werden dabei etwas
  vereinfacht.
  - *Kante nach innen* (Standard 1 px): höher stellen, falls am Rand noch ein dünner Streifen vom alten Hintergrund zu sehen ist.
  - *Kantenweichheit* (Standard 1 px): 0 ergibt eine harte Kante, höhere Werte einen weicheren Übergang. Der Übergang
    liegt immer nur nach innen.
- **Kante „Fein“**: die weiche Original-Kante der KI mit allen Haaren. Sie kann aber einen Saum zeigen. Nur für Spezialfälle.
- **Erweiterte Einstellungen anzeigen:** KI-Modell, Detailstufe, Grafikkarte. Bei Kante „Fein“ kommen weitere Regler dazu.

**Modus „Farbe“** (Green-Screen oder einfarbige Wand): Hintergrundfarbe per Pipette, „Auto (Bildrand)“ oder Schnellwahl
festlegen und mit der Toleranz einstellen, was verschwindet. Bei einer weißen Wand bleibt mit „Nur vom Bildrand aus
entfernen“ ein weißes Hemd erhalten.

**Transparenz prüfen:** Der Windows-Mediaplayer, „Filme & TV“ und VLC können bei WebM keine Transparenz anzeigen. Dort
erscheint die Figur auf **Schwarz**, genau wie bei den Videos aus dem KI-Assistenten: Durchsichtige Bereiche werden schwarz
gespeichert. Browser (Edge, Chrome) und der KI-Assistent zeigen sie transparent. Nach dem Export prüft man das mit
**„Mit Transparenz ansehen“**.

**Export (Strg+E)**

Welche Formate angeboten werden, hängt vom gewählten Hintergrund ab:

| Format | Transparenz | Hinweis |
|---|---|---|
| WebM (VP9) | ja, bei „Transparent“ | für Web und Browser. Im KI-Assistenten als Avatar-Video direkt nutzbar (Freistellen: „Video ist schon freigestellt“). |
| MOV ProRes 4444 | ja, bei „Transparent“ | für Premiere, DaVinci Resolve, Final Cut |
| MP4 (H.264) | nein | Standard mit weißem Hintergrund, läuft auf jedem Gerät. |

Die Grafikkarte wird über DirectML genutzt, wenn eine vorhanden ist (NVIDIA, AMD oder Intel). Sonst rechnet der Prozessor.
Unter „Erweiterte Einstellungen“ steht, worauf gerade gerechnet wird.

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
- BiRefNet (Modell): MIT, https://github.com/ZhengPeng7/BiRefNet
- ffmpeg (BtbN-Build): GPL
- PySide6/Qt: LGPL

Für die interne Nutzung ist das unproblematisch. Wird das Programm an Dritte weitergegeben, gelten die Bedingungen der GPL.
