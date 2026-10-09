# NAS-Suche

Schnelle Dateisuche für Synology-Netzlaufwerke (oder beliebige Ordner) unter Windows 10/11.
**Eine einzige Datei `NasSuche.exe`. Keine Installation, keine Zusatzsoftware.**

## Benutzung

1. `NasSuche.exe` auf den PC kopieren (z. B. Desktop) **oder** direkt vom NAS starten.
2. Beim ersten Start die Ordner festlegen, die durchsucht werden sollen,
   z. B. `Z:\` oder `\\DiskStation\Daten` („Ordner auswählen …“ oder Pfad eintippen).
3. Das Programm liest einmal alle Datei- und Ordnernamen ein (Fortschritt unten in der Statusleiste).
   Danach erscheinen Suchergebnisse **sofort beim Tippen**, auch bei Millionen Dateien.

### Suchen
* Mehrere Wörter: alle müssen im Namen vorkommen – `angebot müller`
* Platzhalter: `*.pdf`, `rechnung 2026*`, `bericht_??.docx`
* „Auch im Ordnerpfad suchen“: Wörter dürfen auch im Ordnernamen stehen – `kunden müller *.pdf`
* Auswahl „Nur Dateien“ / „Nur Ordner“
* Groß-/Kleinschreibung egal; Umlaute von Mac-Rechnern werden korrekt gefunden.

### Ergebnisse
* Doppelklick oder Enter: Datei öffnen
* Rechtsklick: Öffnen, Im Ordner anzeigen, Pfad kopieren, Name kopieren
* Strg+C: Pfad(e) kopieren · Spaltenkopf anklicken: sortieren
* **F5** bzw. „Index aktualisieren“: Ordner neu einlesen (passiert sonst automatisch alle 12 Stunden,
  einstellbar).

Synology-Systemordner (`#recycle`, `@eaDir`, `#snapshot` …) werden ignoriert (einstellbar).

## Gut zu wissen
* Der Index liegt pro Benutzer lokal unter `%LOCALAPPDATA%\NasSuche\index.dat`,
  die Einstellungen unter `%APPDATA%\NasSuche\einstellungen.json`.
* **Für alle Kollegen vorkonfigurieren:** Eine Datei `NasSuche.json` neben die EXE legen
  (gleicher Aufbau wie `einstellungen.json`). Wer noch keine eigenen Einstellungen hat, übernimmt diese.
* Das Programm ist nicht digital signiert. Beim ersten Start zeigt Windows ggf.
  „Der Computer wurde durch Windows geschützt“ → **Weitere Informationen → Trotzdem ausführen**.
* Gesucht wird nach Datei- und Ordnernamen, nicht im Inhalt der Dateien.

## Selbst bauen (nur für Entwickler)
Benötigt Go ≥ 1.22: `./build.sh` erzeugt `NasSuche.exe` (funktioniert auch unter Linux/macOS).
