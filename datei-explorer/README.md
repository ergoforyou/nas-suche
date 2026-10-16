# ERGOFORYOU Datei-Explorer – Alles an seinem Platz.

Ein Explorer für Windows 10/11 mit **zwei Ansichten nebeneinander** und der **Suche der NAS-Suche oben**.
**Eine einzige Datei `DateiExplorer.exe`. Keine Installation, keine Zusatzsoftware.**
Läuft unabhängig von der NAS-Suche – beide Programme können gleichzeitig laufen.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ERGOFORYOU  Datei-Explorer                      [Version 0.9.0 · Testversion] │
│ Neu ▾  Ausschneiden  Kopieren  Einfügen  Umbenennen  Löschen  Kopieren ⇄ …   │
├──────────────────────────────────────────────────────────────────────────────┤
│ Suchen: [angebot müller        ] [Überall ▾] □ im Pfad  Nur: □PDF □Bilder …   │  höchstens
│ Name               Typ     Ordner                         Größe  Geändert    │  ein Drittel
├──────────────┬───────────────────────────────┬───────────────────────────────┤
│ Schnellzugriff│ ← → ↑  Y: › Kunden › Wrobel ›│ ← → ↑  Y: › Eingang ›          │
│ Netzlaufwerke │ Name          Typ  Größe  …  │ Name          Typ  Größe  …   │  zwei Drittel
│ Dieser PC     │                              │                               │
└──────────────┴───────────────────────────────┴───────────────────────────────┘
```

## Versionsfeld
Oben rechts steht immer die Version, z. B. **„Version 0.9.0 · Testversion · Stand 16.10.2026 09:30“** –
auch in der Titelleiste und in der Chrome-Oberfläche.
* **Gelb hinterlegt + „Testversion“** = wir sind noch in der Versuchsphase.
* **„freigegeben“** (ohne gelbe Markierung) = endgültige Fassung. Umschalten in `brand.go`
  (`appVersion`, `appStage = ""`).

## Einrichten
1. `DateiExplorer.exe` auf den PC kopieren und starten.
2. **Wer die NAS-Suche schon eingerichtet hat, muss nichts tun:** Beim ersten Start werden Suchordner,
   Netzlaufwerke, feste Ordner, Kopierziele und der fertige Suchindex der NAS-Suche übernommen.
3. Sonst unter **Einstellungen** die Suchordner (z. B. `Z:\` oder `\\DiskStation\Daten`) und
   Netzlaufwerke eintragen, **Allgemein → Mit Windows starten** anhaken.

Einstellungen: `%APPDATA%\DateiExplorer\einstellungen.json`, Index: `%LOCALAPPDATA%\DateiExplorer\index.dat`.
Portabel (USB-Stick oder `portable.txt` neben der EXE): alles im Ordner `DateiExplorer-Daten` neben der EXE.
Ein gemeinsamer Index auf dem NAS (`NasSuche-Index.dat`) wird mitbenutzt – erstellt wird er weiter von der NAS-Suche.

## Bedienung

### Suche oben (höchstens ein Drittel des Fensters)
* Tippen = sofort Treffer. Mehrere Wörter: alle müssen vorkommen. Platzhalter `*.pdf`, `rechnung 2026*`.
* Haken **PDF · Bilder · Office · Ordner** mit Trefferzahl, **„Auch im Ordnerpfad“**.
* **Bereich:** „Überall“, „Nur im linken Ordner“ oder „Nur im rechten Ordner“ – Ordner außerhalb der
  Suchordner werden dabei direkt auf dem Laufwerk durchsucht.
* **Strg+F**, **Strg+E** oder **F3** springt ins Suchfeld. Die Trennlinie lässt sich verschieben.
* Doppelklick auf einen Ordner-Treffer öffnet ihn unten (in der zuletzt benutzten Seite).
  Rechtsklick → „Ordner links/rechts anzeigen“ öffnet den Ordner der Datei und markiert sie dort.

### Zwei Explorer-Ansichten unten
* **← → ↑** (Alt+←, Alt+→, Alt+↑, Rücktaste = zurück), Pfadleiste mit **›** für Unterordner,
  **✎** bzw. **Strg+L / F4 / Alt+D** = Pfad eintippen, **★** = feste Ordner, **⟳ / F5** = aktualisieren.
* Spalten Name, Typ, Größe, Geändert – Klick auf die Überschrift sortiert (bleibt gespeichert).
* Unter jeder Ansicht: Anzahl Elemente, Auswahl und Größe der Auswahl.
* Links Navigationsleiste wie im Explorer: Schnellzugriff, Netzlaufwerke, Dieser PC.
* Beim Start: fester Startordner (★ → „beim Start öffnen“), sonst der zuletzt benutzte Ordner.
* Ordner aktualisieren sich alle 5 Sekunden von selbst (neue Scans erscheinen automatisch).

### Dateien verschieben, kopieren, umbenennen, löschen
* **Ziehen = verschieben, mit Strg = kopieren** – zwischen links und rechts, **aus der Suche heraus**
  in einen Ordner unten oder auf einen Ordner der Trefferliste, auf Ordner im Navigationsbaum.
  Ordner **springen beim Verweilen auf** (Unterordner klappen darunter auf), das Ziel ist blau markiert.
* **Auch in den Windows-Explorer und auf den Desktop wird beim Ziehen verschoben** (Strg = kopieren).
  Outlook, Teams, Browser usw. bekommen wie gewohnt eine Kopie.
* **Ausschneiden (Strg+X), Kopieren (Strg+C), Einfügen (Strg+V)** – über die Windows-Zwischenablage,
  d. h. auch zwischen diesem Programm und dem normalen Windows-Explorer. Ausgeschnittenes wird blass angezeigt.
  Kopieren in denselben Ordner legt „… - Kopie“ an.
* **Kopieren ⇄ / Verschieben ⇄**: Markiertes direkt in den Ordner der anderen Seite.
  Rechtsklick → **Verschieben nach / Kopieren nach** (linker/rechter Ordner, gemerkte Ziele, Google Drive, Auswahl).
* **Umbenennen: F2** – mehrere markiert = gemeinsamer Name mit Nummer („Kunde Wrobel (1).pdf“, „(2)“ …).
* **Löschen: Entf = Papierkorb, Umschalt+Entf = endgültig** (Windows fragt wie gewohnt nach).
* **Neu:** Ordner (Strg+Umschalt+N) oder Textdokument – wird angelegt und gleich zum Benennen geöffnet.
* **Eigenschaften (Alt+Enter)**, **Öffnen mit …**, **Im Windows-Explorer zeigen**, Pfad/Name kopieren,
  **An Schnellzugriff anheften**, versteckte Dateien ein-/ausblenden (Rechtsklick auf leere Fläche).
* **„Weitere Optionen (Windows-Menü)“** im Rechtsklick zeigt das komplette Kontextmenü des
  Windows-Explorers (Senden an, 7-Zip, Freigeben …).
* Verschobenes, Umbenanntes, Gelöschtes und neu Angelegtes ist sofort richtig in der Suche.
* **Strg+Tab** wechselt Suche → links → rechts. Die Befehlsleiste oben wirkt auf die zuletzt angeklickte Ansicht.

## Im Browser (Chrome, Edge, Opera, Brave)
Dieselbe Oberfläche – Suche oben, zwei Ansichten unten, Befehlsleiste – als Tab im Browser.
**Einrichten:** *Einstellungen → Allgemein → „Explorer im Browser einrichten …“*, dann im Browser unter
`chrome://extensions` den Entwicklermodus einschalten, „Entpackte Erweiterung laden“ und den angezeigten
Ordner wählen (Pfad liegt in der Zwischenablage). Eigene Erweiterung – unabhängig von der NAS-Suche-Erweiterung.
* **Alt+Umschalt+E** öffnet den Explorer als Tab, **Alt+Umschalt+D** als Seitenleiste.
  Das Programm muss nicht geöffnet sein – der Browser startet es bei Bedarf im Hintergrund.
* Verschieben (Ziehen, Strg = kopieren), Ausschneiden/Kopieren/Einfügen (auch mit dem Windows-Explorer),
  Umbenennen (F2), Löschen (Entf), Neuer Ordner (**F7** – Strg+Umschalt+N ist im Browser belegt),
  Eigenschaften, Öffnen mit, Zurück/Vor/Nach oben, Pfad eintippen (F4).
* **Dateien direkt in WhatsApp Web, Gmail, Google Drive oder Claude ziehen** (wie bei der NAS-Suche).
* Einschränkung des Browsers: Ziehen **auf den Desktop / in den Windows-Explorer** legt dort nur eine
  **Kopie einer einzelnen Datei** ab. Zum Verschieben dorthin: Strg+X und im Explorer Strg+V.

## Selbst bauen (nur für Entwickler)
Benötigt Go ≥ 1.22: `./build.sh` erzeugt `DateiExplorer.exe` (funktioniert auch unter Linux/macOS).
Tests: `go test ./...`
