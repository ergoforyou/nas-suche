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
Alle Einstellungen bleiben dauerhaft gespeichert (auch bei neuen Programmversionen).

**Suchordner und Netzlaufwerke hängen zusammen:**
* Wird ein Netzlaufwerk wie `Y:\` als Suchordner eingetragen, merkt sich das Programm automatisch,
  wohin `Y:` zeigt, und verbindet es bei jedem Start – auch bei bereits eingetragenen Ordnern.
* Unter „Netzlaufwerke“ hinzugefügte Freigaben werden mit dem Haken „auch durchsuchen“ direkt Suchordner.
* **Einstellungen → Allgemein → „Als Vorgabe für alle Kollegen speichern …“** legt eine `NasSuche.json`
  neben die EXE. Kollegen, die die EXE von dort starten, haben alles sofort eingerichtet.

## Portable Version (USB-Stick)
* `NasSuche-Portable.zip` entpacken und den Ordner auf den Stick kopieren – `NasSuche.exe` starten.
* Liegt die EXE auf einem USB-Stick oder neben ihr eine Datei `portable.txt`, arbeitet das Programm
  **portabel**: Einstellungen und Index im Ordner `NasSuche-Daten` neben der EXE, keine Registry-Einträge,
  kein Autostart. Der Fenstertitel zeigt „(portabel)“.
* Keine Firewall-Abfrage: das Programm öffnet keine Netzwerk-Ports.
* Die Download-Markierung der EXE wird beim ersten Start entfernt – die Windows-Sicherheitsabfrage
  erscheint danach nicht mehr bei jedem Start.
* Neue Versionen lösen ältere sanft ab (Beenden-Signal statt hartem Abbruch).

## Benutzung

* **Strg+Umschalt+F** (einstellbar) öffnet die Suche von überall – tippen, Ergebnis ist sofort da.
  Voraussetzung: das Programm läuft (Symbol neben der Uhr), am besten über „Mit Windows starten“.
* **Esc** leert das Suchfeld, zweimal Esc blendet das Fenster aus. Das X schließt nur das Fenster;
  **Beenden** über Rechtsklick auf das Symbol neben der Uhr.
* **Haken „Nur anzeigen“** unter dem Suchfeld: **PDF · Bilder · Office · Ordner** – beliebig kombinierbar,
  kein Haken = alles. Die Zahl neben jedem Haken zeigt sofort, wie viele Treffer es dort gibt. Die Haken
  können *vor* dem Tippen gesetzt werden; ohne Suchbegriff werden alle Dateien dieser Typen gelistet.
  Die Auswahl bleibt gespeichert.
  * Bilder: jpg, png, gif, tif, heic, webp, bmp, svg, psd, RAW-Formate …
  * Office: Word, Excel, PowerPoint, OpenDocument, csv, rtf, Visio, OneNote, E-Mails (msg/eml)
* **Trefferliste:** Ordner stehen immer oben, fett und gelb hinterlegt. Jede Zeile hat das Windows-Symbol
  ihres Dateityps, die Spalte **Typ** ist farbig: PDF rot, Bilder grün, Office blau, Ordner braun.
* **Sortierung bleibt stehen:** Ein Klick auf eine Spaltenüberschrift (z. B. zweimal „Geändert“ = neueste
  zuerst) gilt dauerhaft – für jede neue Suche und nach dem Neustart, links und rechts getrennt.
  Beim Sortieren nach Datum oder Größe stehen Ordner nicht mehr automatisch oben.
* Mehrere Wörter: alle müssen im Namen vorkommen – `angebot müller`
* Platzhalter: `*.pdf`, `rechnung 2026*`
* „Auch im Ordnerpfad suchen“: Wörter dürfen auch im Ordnernamen stehen
* **F5**: Index sofort aktualisieren

### Navigationsleiste wie im Explorer
* Links im Fenster: **Schnellzugriff** (angeheftete Ordner), **Netzlaufwerke** und **Dieser PC**
  (Desktop, Downloads, Dokumente, Bilder, alle Laufwerke) – beliebig aufklappbar.
* Knopf **„Navigation ausblenden / einblenden“** oben – die Wahl bleibt gespeichert.
* **Klick auf einen Ordner** zeigt ihn in der Ansicht, in der zuletzt gearbeitet wurde (links oder rechts).
* **Anheften:** Rechtsklick auf einen Ordner (im Baum oder in der Trefferliste) → **„An Schnellzugriff
  anheften“** – oder den Ordner einfach auf „Schnellzugriff“ ziehen. Lösen: Rechtsklick → „Vom Schnellzugriff lösen“.
* **Dateien auf einen Ordner im Baum ziehen** = verschieben (Strg = kopieren). Beim Verweilen klappt der
  Ordner auf, das Ziel ist markiert – wie im Explorer.
* Rechtsklick im Baum: „In linker / rechter Ansicht öffnen“, „Im Explorer öffnen“.

### Feste Ordner (z. B. „Digitale Eingänge“)
* Knopf **„Ordner ▼“** links neben jedem Suchfeld: feste Ordner mit einem Klick anzeigen – ohne Suchen.
* Ordner anzeigen (Doppelklick oder „Ordner auswählen und anzeigen …“), dann im Menü
  **„Angezeigten Ordner als festen Ordner merken …“** – Name vergeben, fertig (gilt für beide Seiten).
* **„Angezeigten Ordner beim Start links/rechts öffnen“**: z. B. links immer die digitalen Eingänge.
* Geöffnete Ordner aktualisieren sich alle 10 Sekunden von selbst – neue Scans erscheinen automatisch
  (nicht während man zieht; die Auswahl bleibt erhalten).
* Feste Ordner und Startordner werden mit „Als Vorgabe für alle Kollegen speichern“ mitgegeben.

### Zwei Ansichten nebeneinander (Dateien verschieben)
* Knopf **„Zweite Ansicht einblenden“** – rechts erscheint eine zweite, unabhängige Suche
  (eigene Haken, eigener Suchbegriff). Ausblenden mit demselben Knopf, die Wahl bleibt gespeichert.
* **Doppelklick auf einen Ordner** zeigt seinen Inhalt (live vom NAS) – mit „↑ Nach oben“,
  „Im Explorer“ und „× Zurück zur Suche“. Rücktaste = eine Ebene höher.
* **Pfadleiste wie im Explorer:** `Y: › Kunden › PW › Wrobel ›` – Klick auf eine Ebene springt dorthin,
  Klick auf **„›“** klappt alle Unterordner dieser Ebene auf (der aktuelle ist abgehakt). So wechselt man
  z. B. vom Kunden direkt in „Schaden“ oder zum nächsten Kunden.
* **Ziehen zwischen den Ansichten = verschieben**, mit gedrückter **Strg**-Taste = kopieren.
  Ziel ist der geöffnete Ordner oder ein Ordner in der Trefferliste, auf den man direkt zieht.
  Das Ziel wird beim Ziehen wie im Explorer **blau markiert**: die Ordnerzeile unter der Maus bzw. die
  Pfadleiste „▼ Hier ablegen“ des geöffneten Ordners. Die Statuszeile zeigt, was beim Loslassen passiert.
* **Ordner springen beim Ziehen auf:** Mit der Datei kurz (ca. ½ Sekunde) über einem Ordner verweilen –
  seine Unterordner klappen direkt darunter als Baum auf (`└─ Schaden`, `└─ Anträge` …), beliebig tief.
  So legt man gezielt beim richtigen Kunden im richtigen Unterordner ab; der Kunde bleibt darüber sichtbar.
  Am oberen/unteren Rand rollt die Liste automatisch weiter. Nach dem Loslassen klappt alles wieder zu.
* Verschobene Dateien werden sofort am neuen Ort gefunden (ohne neu einzulesen).
* Auch aus dem Windows-Explorer kann man Dateien in eine geöffnete Ordneransicht ziehen.
* Rechtsklick → **„In der anderen Ansicht öffnen“** öffnet den Ordner eines Treffers auf der anderen Seite.

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
