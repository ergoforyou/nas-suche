# ERGOFORYOU NAS-Suche – Ausrollen auf Windows, Mac, Chrome und Opera

## Überblick

Jeder Arbeitsplatz bekommt zwei Teile: das Programm NAS-Suche (Windows oder Mac) und einmalig die Browser-Erweiterung. Das Programm sucht, verschiebt und spricht mit dem NAS; der Browser ist nur die Oberfläche. Pro Arbeitsplatz dauert das Einrichten etwa 5 Minuten.

| Teil | Windows | Mac |
| --- | --- | --- |
| Programm | NasSuche.exe (eine Datei) | ERGOFORYOU NAS-Suche.app (aus NasSuche-Mac.zip) |
| Portable Variante | NasSuche-Portable.zip (USB-Stick) | – |
| Browser-Erweiterung | im Programm enthalten, wird beim Start abgelegt | im Programm enthalten, wird beim Start abgelegt |
| Browser | Chrome, Edge, Opera, Brave | Chrome, Edge, Opera, Brave |
| Nicht möglich | Firefox, Safari | Firefox, Safari |

Reihenfolge je Arbeitsplatz:

1. NAS-Freigabe erreichbar machen (Netzlaufwerk bzw. smb://).
2. Programm installieren und einmal starten.
3. Suchordner prüfen (bei Vorgabe-Datei schon eingetragen).
4. Browser-Erweiterung laden und das Symbol anheften.
5. Probe: im Browser suchen, eine Datei in einen anderen Ordner ziehen.

## Vorbereitung durch den Admin

Einmal einen Ordner auf dem NAS anlegen, der alles enthält; dann braucht kein Kollege eigene Einstellungen.

1. Auf dem NAS einen Ordner anlegen, z. B. `\\DiskStation\Daten\_NasSuche` (Mac: `smb://DiskStation/Daten/_NasSuche`).
2. Hineinlegen:
   - `NasSuche.exe` (Windows)
   - `NasSuche-Mac.zip` entpackt, also `ERGOFORYOU NAS-Suche.app` (Mac)
   - optional `NasSuche-Portable.zip` (USB-Stick)
3. **Vorgabe für Windows erstellen:** An einem eingerichteten PC *Einstellungen → Allgemein → „Als Vorgabe für alle Kollegen speichern …“*. Das legt `NasSuche.json` neben die EXE (Suchordner, Netzlaufwerke, feste Ordner wie „Digitale Eingänge“, Startordner, gemeinsamer Index).
4. **Vorgabe für Mac erstellen:** An einem eingerichteten Mac *Einstellungen → Browser & Kollegen → „Als Vorgabe speichern …“* und als `NasSuche.json` in den NAS-Ordner speichern, am besten in einen Unterordner `Mac`. Mac und Windows brauchen getrennte Vorgaben, weil die Pfade anders aussehen (`Z:\Kunden` gegenüber `/Volumes/Daten/Kunden`).
5. **Gemeinsamer Index (empfohlen ab 3 Arbeitsplätzen):** An genau einem Windows-PC *Einstellungen → Gemeinsamer Index* den NAS-Ordner wählen und „Dieser PC erstellt den gemeinsamen Index“ anhaken. Alle anderen laden den fertigen Index in Sekunden statt das NAS selbst einzulesen.

Kennwörter speichert das Programm nicht. Windows fragt sie einmal ab („Anmeldedaten speichern“), der Mac legt sie im Schlüsselbund ab.

## Windows-PC einrichten

1. `NasSuche.exe` vom NAS-Ordner auf den PC kopieren, z. B. nach `C:\Programme\ERGOFORYOU\` (oder direkt vom NAS starten).
2. Doppelklick. Erscheint „Der Computer wurde durch Windows geschützt“: **Weitere Informationen → Trotzdem ausführen** (nur beim ersten Mal).
3. Lag eine `NasSuche.json` neben der EXE, sind Suchordner und Netzlaufwerke schon eingetragen. Sonst *Einstellungen → Suchordner* bzw. *Netzlaufwerke* ausfüllen.
4. Fragt Windows nach Benutzer und Kennwort für das NAS: eingeben und „Anmeldedaten speichern“ anhaken.
5. *Einstellungen → Allgemein → „Mit Windows starten“* anhaken.
6. Weiter mit der Browser-Erweiterung (unten).

Portabel vom USB-Stick: `NasSuche-Portable.zip` entpacken, Ordner auf den Stick, `NasSuche.exe` starten. Einstellungen und Index liegen dann auf dem Stick, auf dem PC wird nichts eingetragen.

## Mac einrichten

Läuft ab macOS 11 auf Apple-Chip (M1–M4) und Intel; pro Mac etwa 5 Minuten.

1. `NasSuche-Mac.zip` doppelklicken und **„ERGOFORYOU NAS-Suche“ in den Ordner *Programme* ziehen.**
2. **Erster Start:** Rechtsklick auf die App → **Öffnen** → „Öffnen“ bestätigen. Klappt das nicht: *Systemeinstellungen → Datenschutz & Sicherheit → „Dennoch öffnen“*. Nur beim ersten Mal nötig.
3. **Vorgabe übernehmen:** *Einstellungen → Browser & Kollegen → „Vorgabe laden …“* und die `NasSuche.json` aus dem NAS-Ordner `Mac` wählen. Ohne Vorgabe: *Suchordner & NAS* ausfüllen, z. B. NAS-Freigabe `smb://DiskStation/Daten` und Suchordner `/Volumes/Daten`.
4. **NAS-Kennwort:** macOS fragt einmal nach Benutzer und Kennwort – „Im Schlüsselbund sichern“ anhaken.
5. **Zugriff erlauben:** Fragt macOS „… möchte auf Dateien auf einem Netzwerkvolume zugreifen“, auf **Erlauben** klicken. Kommt die Frage für „Google Chrome“ bzw. „Opera“, dort ebenfalls erlauben.
6. **Im Hintergrund starten:** *Einstellungen → Browser & Kollegen → „Beim Anmelden im Hintergrund starten“* anhaken und speichern. macOS meldet einmal „Hintergrundobjekt hinzugefügt“ – das ist richtig.
7. Weiter mit der Browser-Erweiterung (unten).

Test: im Finder **⌘K** drücken und `smb://DiskStation/Daten` verbinden. Klappt das, findet auch die Suche das NAS.

## Browser-Erweiterung einrichten (Chrome, Edge, Opera, Brave)

Die Erweiterung steckt im Programm; ein Knopf legt sie ab, danach wird sie einmal im Browser geladen. Firefox und Safari gehen nicht.

1. Im Programm den Einrichtungs-Knopf drücken – Windows: *Einstellungen → Allgemein → „NAS-Suche im Browser einrichten …“*, Mac: *Einstellungen → Browser & Kollegen → „NAS-Suche im Browser einrichten …“*. Der Ordnerpfad liegt danach in der Zwischenablage.
2. Im Browser die Erweiterungsseite öffnen (Adresse eintippen, siehe Tabelle).
3. **Entwicklermodus** einschalten.
4. **„Entpackte Erweiterung laden“** klicken und den Ordner wählen: Windows Strg+V ins Adressfeld; Mac ⌘⇧G, ⌘V, Return, „Auswählen“.
5. Das ERGOFORYOU-Symbol anheften (Chrome/Edge/Brave: Puzzle-Symbol, Opera: Würfel-Symbol).
6. Probe: Symbol klicken → Suche öffnet sich als Tab; eine Datei in WhatsApp Web oder Gmail ziehen.

| Browser | Erweiterungsseite | Seitenleiste | Startet das Programm selbst |
| --- | --- | --- | --- |
| Chrome | chrome://extensions | ja (Alt+Umschalt+S / ⌥⇧S) | ja |
| Edge | edge://extensions | ja | ja |
| Brave | brave://extensions | ja | ja |
| Opera, Opera GX | opera://extensions | nein, als Tab nutzen | nicht sicher – Autostart des Programms einschalten |

Tastenkürzel: **Alt+Umschalt+F** (Mac ⌥⇧F) öffnet die Suche als Tab. Bei Opera und auf dem Mac am besten immer den Autostart bzw. „Beim Anmelden im Hintergrund starten“ einschalten, dann ist die Suche ohne Wartezeit da.

Zum Ziehen in Webseiten: Am bequemsten zwei Tabs nebeneinander (geteilte Ansicht bzw. zwei Fenster) – links die NAS-Suche, rechts WhatsApp, Gmail, Drive oder Claude. Ordner werden nicht an Webseiten übergeben, nur Dateien.

## Updates verteilen

Eine neue Version ersetzt nur die Programmdatei; Einstellungen, Index und Erweiterung bleiben.

- **Windows:** neue `NasSuche.exe` über die alte kopieren (bzw. im NAS-Ordner austauschen) und starten. Die neue Version beendet die alte selbst.
- **Mac:** App beenden (Menüleisten-Symbol → Beenden), neue App in *Programme* ersetzen, einmal per Rechtsklick → Öffnen starten.
- **Browser-Erweiterung:** Das Programm legt beim Start die passende Erweiterung in denselben Ordner. Im Browser auf der Erweiterungsseite bei „ERGOFORYOU NAS-Suche“ einmal auf **Neu laden** (Kreispfeil) klicken. Offene Webseiten danach einmal neu laden (F5), damit das Hineinziehen wieder geht.

## Fehlerbehebung

| Problem | Lösung |
| --- | --- |
| Browser zeigt „Das Programm NAS-Suche läuft gerade nicht“ | Programm einmal starten; danach Autostart (Windows) bzw. „Beim Anmelden im Hintergrund starten“ (Mac) einschalten. Hilft nicht: im Programm erneut „NAS-Suche im Browser einrichten …“ drücken. |
| Mac: „Ordner gibt es nicht“ / NAS nicht verbunden | Im Finder ⌘K, `smb://DiskStation/Daten` verbinden. Klappt das nicht: IP-Adresse statt Namen probieren, Firmennetz/VPN prüfen. |
| Mac: „macOS verweigert den Zugriff“ | *Systemeinstellungen → Datenschutz & Sicherheit → Dateien und Ordner* → NAS-Suche (und ggf. Chrome/Opera) → „Netzwerkvolumes“ einschalten, Programm neu starten. |
| Mac: App lässt sich nicht öffnen | Rechtsklick → Öffnen, oder *Datenschutz & Sicherheit → „Dennoch öffnen“*. |
| Windows: „Der Computer wurde durch Windows geschützt“ | Weitere Informationen → Trotzdem ausführen (nur einmal). |
| Datei lässt sich nicht in eine Webseite ziehen | Webseite neu laden (F5). Direkt auf das Eingabefeld bzw. die Ablagefläche ziehen (blauer Rahmen). Alternativ Strg+C in der NAS-Suche, Strg+V in der Webseite. |
| Suche findet neue Dateien nicht | „Aktualisieren (F5)“. Geöffnete Ordner aktualisieren sich alle 10 Sekunden selbst. |
| Erweiterung nach Update veraltet | Erweiterungsseite → bei NAS-Suche „Neu laden“. |
| Opera: Symbol fehlt | Würfel-Symbol rechts oben → NAS-Suche anheften. Seitenleiste gibt es in Opera nicht, die Suche läuft als Tab. |
