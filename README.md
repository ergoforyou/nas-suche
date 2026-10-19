# DiktierFlow

Spracheingabe für Windows nach dem Vorbild von Wispr Flow: Tastenkombination drücken, sprechen, und der fertig formulierte Text erscheint im aktiven Programm. Das funktioniert in Outlook, Word, im Browser, in Teams und überall sonst, wo man tippen kann.

## Funktionen

| Funktion | Beschreibung |
|---|---|
| **Diktieren** `Strg+Win+Leertaste` | Kurz tippen startet den **Freihand-Modus** für lange Diktate, ein erneuter Druck stoppt. Gedrückt halten ist **Push-to-Talk**, beim Loslassen ist Schluss. `Esc` bricht ab. |
| **Varianten** `Strg+Win+Umschalt+Leertaste` | Nach dem Diktat erscheinen drei Fassungen: *Korrigiert*, *Professionell* und *Freundlich & locker*. Die Tasten `1`/`2`/`3` fügen die gewählte Fassung ein, `0` den Rohtext. Alle Fassungen lassen sich vorher noch bearbeiten. |
| **Befehls-Modus** `Strg+Win+Alt+Leertaste` | Text markieren und z. B. sagen: „mach daraus eine höfliche E-Mail“ oder „übersetz das ins Englische“. Der markierte Text wird ersetzt. |
| **Starke Spracherkennung** | Standard ist OpenAI `gpt-4o-transcribe` in der Cloud. Bei Ausfall oder im Datenschutz-Modus springt automatisch **lokales Whisper** ein (`large-v3-turbo`). |
| **Nachbearbeitung mit Claude** | Entfernt Füllwörter („äh“, „ähm“), setzt Satzzeichen und löst Selbstkorrekturen auf („Dienstag, nein Mittwoch“ wird zu „Mittwoch“). Gesprochene Befehle wie „neuer Absatz“ werden umgesetzt. |
| **Stil je Programm** | Outlook und Word formell, Teams, WhatsApp und Slack locker, im Terminal unverändert. Einstellbar in `config.json` → `app_styles`. |
| **Selbstlernen** | Korrigierst du den eingefügten Text, liest das Programm das Textfeld einige Sekunden später erneut aus und merkt sich Hörfehler wie „Ergo vor ju“ → „ErgoForYou“. Ab der 2. Beobachtung gilt die Korrektur automatisch. Inhaltliche Änderungen wie „Montag“ → „Dienstag“ und reine Grammatik werden **nicht** gelernt. |
| **Verlauf** | Jedes Diktat wird lokal gespeichert: Rohtext, fertiger Text, Varianten, Programm und Audio. Einträge lassen sich durchsuchen, kopieren und an anderer Stelle erneut einfügen. Das Audio kann neu erkannt werden, falls etwas schiefging. |
| **Wörterbuch & Textbausteine** | Namen und Fachbegriffe in der richtigen Schreibweise. Bausteine wie die Signatur ruft man per Sprache ab: „füge meine Signatur ein“. |
| **Lange Diktate** | Die Aufnahme wird an Sprechpausen in Stücke geteilt und schon während des Sprechens erkannt. Auch nach 10 Minuten kommt der Text daher sofort. |
| **Datenschutz-Modus** | Nichts verlässt den Rechner: lokales Whisper und einfache Offline-Bereinigung. |

## Installation (Windows 10/11)

1. **Python 3.11 oder neuer** installieren (python.org, dabei „Add to PATH“ anhaken).
2. Diesen Ordner herunterladen und `install.bat` doppelklicken.
3. `start.bat` doppelklicken. Im Infobereich der Taskleiste erscheint ein blaues Mikrofon-Symbol.
4. Beim ersten Start öffnen sich die Einstellungen. Dort kommen die API-Schlüssel hinein:
   - **Anthropic** (für Claude): <https://console.anthropic.com>
   - **OpenAI** (für die Cloud-Spracherkennung): <https://platform.openai.com>

   Alternativ setzt du die Umgebungsvariablen `ANTHROPIC_API_KEY` und `OPENAI_API_KEY`.
5. Optional: „Mit Windows starten“ anhaken.

Eine eigenständige EXE ohne Python-Installation baut `build_exe.bat` nach `dist\DiktierFlow\`.

**Lokales Whisper:** Beim ersten Einsatz wird das Modell einmalig heruntergeladen. Für `large-v3-turbo` sind das etwa 1,6 GB. Auf einem Laptop ohne Grafikkarte dauert die Erkennung damit etwa so lange wie das Diktat selbst. Wer es schneller braucht, wählt in den Einstellungen `small`.

## Kosten (Richtwerte)

- Spracherkennung `gpt-4o-transcribe`: etwa 0,6 Cent pro Minute
- Claude Opus 5.5 für die Bereinigung: etwa 0,1–0,3 Cent pro Diktat. Für mehr Tempo und niedrigere Kosten lässt sich in den Einstellungen Sonnet 5.5 oder Haiku 5.5 wählen.

Bei einer Stunde Diktieren pro Tag kommt man grob auf 5–10 € im Monat.

## Daten

Alles liegt in `%APPDATA%\DiktierFlow\`:

- `config.json`: alle Einstellungen, auch die, die nicht im Einstellungsfenster stehen
- `diktierflow.db`: Verlauf, gelernte Korrekturen, Wörterbuch, Bausteine (SQLite)
- `audio\`: Aufnahmen, werden nach 14 Tagen gelöscht (`keep_audio_days`)
- `diktierflow.log`: Protokoll zur Fehlersuche

## Aufbau

```
diktierflow/
  app.py          Ablauf: Taste → Aufnahme → Erkennung → Claude → Einfügen → Lernen
  hotkey.py       globale Tasten, Tippen/Halten-Logik, Unterdrückung des Startmenüs
  audio.py        Mikrofon, Pegel, Aufteilung langer Diktate
  stt.py          Cloud-/lokale/hybride Spracherkennung, Filter für Whisper-Halluzinationen
  postprocess.py  Claude: Bereinigung, Varianten, Befehls-Modus; Offline-Fallback
  learning.py     Erkennen und Anwenden von Korrekturen (Diff + Kölner Phonetik)
  textio.py       Einfügen, Markierung lesen, aktives Programm, Textfeld erneut lesen
  storage.py      SQLite
  ui/             Aufnahme-Anzeige, Varianten-Auswahl, Verlauf, Einstellungen
```

Tests: `pip install pytest && python -m pytest`

## Bekannte Grenzen

- Das automatische Lernen braucht Programme, deren Textfelder sich über Windows UI Automation auslesen lassen. Bei Browsern, Office und den meisten nativen Apps klappt das, bei manchen Electron-Apps nicht. Dort korrigierst du im Verlauf und klickst „Korrektur speichern & lernen“.
- Programme, die mit Administratorrechten laufen, nehmen von einem normal gestarteten DiktierFlow keine Eingaben an.

## Fahrplan

- **Android:** eigene Tastatur-App mit Mikrofon-Taste. Sie nutzt dieselbe Erkennung und Claude-Bereinigung, Wörterbuch und gelernte Korrekturen werden mit dem PC abgeglichen, z. B. über das NAS.
- Optional ein eigener Whisper-Server im Heimnetz, auf dem NAS oder einem PC mit Grafikkarte, den PC und Handy gemeinsam nutzen.
