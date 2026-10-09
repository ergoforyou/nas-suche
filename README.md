# ERGOFORYOU NAS-Suche – wenn es schnell gehen muss

Schnelle Dateisuche für Synology-Netzlaufwerke (oder beliebige Ordner) unter Windows 10/11.
**Eine einzige Datei `NasSuche.exe`. Keine Installation, keine Zusatzsoftware.**

## Einrichten (einmalig)

1. `NasSuche.exe` auf den PC kopieren (z. B. `C:\Programme\ERGOFORYOU\`) oder vom NAS starten.
2. Beim ersten Start unter **Einstellungen** festlegen:
   * **Suchordner** – z. B. `\\DiskStation\Daten` oder `Z:\`
   * **Netzlaufwerke** – werden bei jedem Start automatisch verbunden (z. B. `Z:` → `\\DiskStation\Daten`).
     Fehlen Zugangsdaten, fragt Windows einmal nach („Anmeldedaten speichern“ anhaken).
   * **Allgemein → Mit Windows starten** anhaken.

Ab dann läuft die Suche im Hintergrund (Symbol unten rechts neben der Uhr) und hält den Index aktuell.

## Benutzung

* **Strg+Alt+Leertaste** (einstellbar) öffnet die Suche von überall – tippen, Ergebnis ist sofort da.
* **Esc** leert das Suchfeld, zweimal Esc blendet das Fenster aus. Das X schließt nur das Fenster;
  **Beenden** über Rechtsklick auf das Symbol neben der Uhr.
* **Haken „Nur anzeigen“** unter dem Suchfeld: **PDF · Bilder · Office · Ordner** – beliebig kombinierbar,
  kein Haken = alles. Die Zahl neben jedem Haken zeigt sofort, wie viele Treffer es dort gibt. Die Haken
  können *vor* dem Tippen gesetzt werden; ohne Suchbegriff werden alle Dateien dieser Typen gelistet.
  Die Auswahl bleibt gespeichert.
  * Bilder: jpg, png, gif, tif, heic, webp, bmp, svg, psd, RAW-Formate …
  * Office: Word, Excel, PowerPoint, OpenDocument, csv, rtf, Visio, OneNote, E-Mails (msg/eml)
* Mehrere Wörter: alle müssen im Namen vorkommen – `angebot müller`
* Platzhalter: `*.pdf`, `rechnung 2026*`
* „Auch im Ordnerpfad suchen“: Wörter dürfen auch im Ordnernamen stehen
* **F5**: Index sofort aktualisieren

### Mit den Treffern weiterarbeiten
* **Herausziehen** (Drag & Drop): Treffer mit der Maus in den Explorer, Outlook, Teams, oder in den
  Browser (Google Drive, Claude, …) ziehen – mehrere Dateien gleichzeitig möglich.
* **Strg+C** kopiert die Dateien selbst (wie im Explorer) → mit Strg+V einfügen.
* **Rechtsklick → Kopieren nach**: merkt sich die zuletzt benutzten Zielordner; Google Drive für
  Desktop (`G:\Meine Ablage`) wird automatisch angeboten.
* Doppelklick/Enter öffnet, „Im Ordner anzeigen“, „Pfad kopieren“ (Strg+Umschalt+C).

## Gemeinsamer Index für das ganze Team

Statt dass jeder PC das NAS selbst einliest:
1. An **einem** PC unter *Einstellungen → Gemeinsamer Index* einen Ordner auf dem NAS wählen
   (z. B. `\\DiskStation\Daten\_NasSuche`) und den Haken **„Dieser PC erstellt … den gemeinsamen Index“** setzen.
   Suchordner dort als Netzwerkpfad (`\\DiskStation\…`) eintragen.
2. An allen anderen PCs nur denselben Ordner eintragen (ohne Haken). Sie laden den fertigen Index
   in Sekunden und prüfen alle 5 Minuten, ob es einen neueren gibt.

**Für alle vorkonfigurieren:** `NasSuche.json` neben die EXE legen, z. B.
```json
{
  "gemeinsamer_index_ordner": "\\\\DiskStation\\Daten\\_NasSuche",
  "netzlaufwerke": [{ "laufwerk": "Z:", "pfad": "\\\\DiskStation\\Daten" }]
}
```
Wer noch keine eigenen Einstellungen hat, übernimmt diese Vorgabe.

## Gut zu wissen
* Gesucht wird nach Datei- und Ordnernamen, nicht im Inhalt.
* Synology-Systemordner (`#recycle`, `@eaDir`, `#snapshot` …) werden ignoriert.
* Dateien: Index `%LOCALAPPDATA%\NasSuche\index.dat`, Einstellungen `%APPDATA%\NasSuche\einstellungen.json`.
  Kennwörter speichert das Programm nicht – das übernimmt Windows.
* Das Programm ist nicht digital signiert. Beim ersten Start ggf.
  „Der Computer wurde durch Windows geschützt“ → **Weitere Informationen → Trotzdem ausführen**.
* Branding (Name, Slogan, Farben) steht zentral in `branding.go`. Schrift: Montserrat (SIL Open Font License).

## Selbst bauen (nur für Entwickler)
Benötigt Go ≥ 1.22: `./build.sh` erzeugt `NasSuche.exe` (funktioniert auch unter Linux/macOS).
