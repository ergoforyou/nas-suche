# ERGOFORYOU NAS-Suche – Ausrollen auf Windows, Mac, Chrome und Opera

## Überblick

Jeder Arbeitsplatz bekommt das Programm NAS-Suche **lokal auf den eigenen Rechner** (Windows oder Mac) und einmalig die Browser-Erweiterung. Jeder Rechner hat seine eigenen Einstellungen und seinen eigenen Suchindex – kein zentraler Programmordner, keine gemeinsame Anmeldung, kein gemeinsamer Index auf dem NAS. Gesucht wird im lokalen Index, das NAS wird dabei nicht belastet. Pro Arbeitsplatz dauert das Einrichten etwa 5 Minuten.

| Teil | Windows | Mac |
| --- | --- | --- |
| Programm | NasSuche.exe (eine Datei) | ERGOFORYOU NAS-Suche.app (aus NasSuche-Mac.zip) |
| Portable Variante | NasSuche-Portable.zip (USB-Stick) | – |
| Browser-Erweiterung | im Programm enthalten, wird beim Start abgelegt | im Programm enthalten, wird beim Start abgelegt |
| Browser | Chrome, Edge, Opera, Brave | Chrome, Edge, Opera, Brave |
| Nicht möglich | Firefox, Safari | Firefox, Safari |

Reihenfolge je Arbeitsplatz:

1. Programmdatei auf den eigenen Rechner kopieren – nicht auf dem NAS ablegen und nicht von dort starten.
2. Programm starten, NAS-Freigabe und Suchordner eintragen.
3. Erstes Einlesen abwarten (einige Minuten) – am besten nicht an allen Rechnern gleichzeitig.
4. Browser-Erweiterung laden und das Symbol anheften.
5. Probe: im Browser suchen, eine Datei in einen anderen Ordner ziehen.

## Dateien verteilen – jeder installiert für sich

Die Programmdateien gehen direkt an die Kollegen – per E-Mail, USB-Stick oder Download-Link, nicht über einen gemeinsamen Ordner auf dem NAS. Jeder legt das Programm auf seinen eigenen Rechner.

| Datei | Für | Ablage auf dem eigenen Rechner |
| --- | --- | --- |
| NasSuche.exe | Windows | z. B. Dokumente\ERGOFORYOU (keine Administratorrechte nötig) |
| NasSuche-Mac.zip | Mac | entpackt im Ordner Programme |
| NasSuche-Portable.zip | USB-Stick (optional) | auf dem Stick |
| Anleitung-NAS-Suche-Ausrollen.pdf | alle | – |

- **Einstellungen:** Jeder trägt NAS-Freigabe und Suchordner selbst ein (Abschnitte Windows bzw. Mac).
- **Abkürzung, optional:** Ein eingerichteter Rechner kann seine Einstellungen als Datei `NasSuche.json` speichern und per E-Mail weitergeben – Windows: *Einstellungen → Allgemein → „Als Vorgabe … speichern“*, Mac: *Einstellungen → Browser & Kollegen → „Als Vorgabe speichern …“*. Windows: Datei vor dem ersten Start neben die `NasSuche.exe` legen; Mac: *„Vorgabe laden …“*. Danach ist jeder Rechner unabhängig, es bleibt keine Verbindung untereinander.
- **Gemeinsamer Index:** nicht verwenden – unter *Einstellungen → Gemeinsamer Index* (Windows) bleibt das Feld leer.

Kennwörter speichert das Programm nicht. Windows fragt sie einmal ab („Anmeldedaten speichern“), der Mac legt sie im Schlüsselbund ab.

## Netzlast gering halten

Die Suche läuft komplett auf dem eigenen Rechner und belastet das NAS nicht. Das NAS wird nur beim Einlesen gelesen – und dann nur Ordner- und Dateinamen, keine Dateiinhalte. Damit bleibt die Gigabit-Leitung frei, auch wenn viele parallel arbeiten:

- **Nur die nötigen Bereiche** als Suchordner eintragen, z. B. Kunden und Digitale Eingänge statt der ganzen Freigabe.
- **Erstes Einlesen staffeln:** nicht alle Rechner zur selben Zeit einrichten.
- **Seltener automatisch aktualisieren:** *Einstellungen → „Index automatisch aktualisieren alle … Stunden“* auf 8–12 setzen (Standard 4). Geöffnete Ordner zeigen neue Dateien trotzdem sofort, weil die Ordneransicht live vom NAS liest.
- **Windows sanfter einlesen lassen:** *Einstellungen → Allgemein → „Gleichzeitige Zugriffe beim Einlesen“* auf 4 senken (Standard 16) – dauert etwas länger, belastet das NAS weniger.
- **Nach dem Umräumen auf dem NAS:** geänderte Pfade in den Suchordnern anpassen, dann einmal **Aktualisieren (F5)**. Was man über die NAS-Suche selbst verschiebt oder umbenennt, kennt der Index sofort.

## Windows-PC einrichten

1. `NasSuche.exe` auf den eigenen PC kopieren, z. B. nach `Dokumente\ERGOFORYOU\`. Nicht vom NAS starten.
2. Doppelklick. Erscheint „Der Computer wurde durch Windows geschützt“: **Weitere Informationen → Trotzdem ausführen** (nur beim ersten Mal).
3. *Einstellungen → Netzlaufwerke*: das NAS-Laufwerk eintragen (z. B. `Z:` → `\\DiskStation\Daten`). *Einstellungen → Suchordner*: nur die nötigen Bereiche, z. B. `Z:\Kunden` und `Z:\Digitale Eingänge`. (Liegt eine weitergegebene `NasSuche.json` neben der EXE, ist das schon eingetragen.)
4. Fragt Windows nach Benutzer und Kennwort für das NAS: eingeben und „Anmeldedaten speichern“ anhaken.
5. *Einstellungen → Allgemein*: „Mit Windows starten“ anhaken; „Index automatisch aktualisieren“ auf 8–12 Stunden.
6. Weiter mit der Browser-Erweiterung (unten).

Portabel vom USB-Stick: `NasSuche-Portable.zip` entpacken, Ordner auf den Stick, `NasSuche.exe` starten. Einstellungen und Index liegen dann auf dem Stick, auf dem PC wird nichts eingetragen.

## Mac einrichten

Läuft ab macOS 11 auf Apple-Chip (M1–M4) und Intel; pro Mac etwa 5 Minuten.

1. `NasSuche-Mac.zip` doppelklicken und **„ERGOFORYOU NAS-Suche“ in den Ordner „Programme“ ziehen** – auf dem eigenen Mac, nicht auf dem NAS.
2. **Erster Start:** Rechtsklick auf die App → **Öffnen** → „Öffnen“ bestätigen. Klappt das nicht: *Systemeinstellungen → Datenschutz & Sicherheit → „Dennoch öffnen“*. Nur beim ersten Mal nötig.
3. **Einstellungen → Suchordner & NAS:** NAS-Freigabe eintragen (z. B. `smb://DiskStation/Daten`) und nur die nötigen Bereiche als Suchordner (z. B. `/Volumes/Daten/Kunden`, `/Volumes/Daten/Digitale Eingänge` – siehe nächster Abschnitt). Wer eine `NasSuche.json` per E-Mail bekommen hat: *Browser & Kollegen → „Vorgabe laden …“*.
4. **NAS-Kennwort:** macOS fragt einmal nach Benutzer und Kennwort – „Im Schlüsselbund sichern“ anhaken.
5. **Zugriff erlauben:** Fragt macOS „… möchte auf Dateien auf einem Netzwerkvolume zugreifen“, auf **Erlauben** klicken. Kommt die Frage für „Google Chrome“ bzw. „Opera“, dort ebenfalls erlauben.
6. **Im Hintergrund starten:** *Einstellungen → Browser & Kollegen → „Beim Anmelden im Hintergrund starten“* anhaken und speichern. macOS meldet einmal „Hintergrundobjekt hinzugefügt“ – das ist richtig.
7. *Suchordner & NAS → „Index automatisch aktualisieren alle … Stunden“* auf 8–12 setzen.
8. Weiter mit der Browser-Erweiterung (unten).

Test: im Finder **⌘K** drücken und `smb://DiskStation/Daten` verbinden. Klappt das, findet auch die Suche das NAS.

## Mac: nur eine NAS-Freigabe – Kunden und Digitale Eingänge gezielt einbinden

Trifft zu, wenn der Mac nur eine Freigabe verbindet (z. B. `smb://DiskStation/Daten`), in der alle Bereiche als Unterordner liegen. Der Mac verbindet immer die ganze Freigabe – einzelne Unterordner lassen sich nicht als eigenes Laufwerk verbinden. Das ist für die Suche auch nicht nötig: Die NAS-Suche durchsucht nur die Unterordner, die man als Suchordner einträgt. Weniger Ordner = kleinerer Index = schnellere Suche und schnelleres Einlesen.

1. **Freigabe prüfen:** Im Finder **⌘K**, `smb://DiskStation/Daten` eingeben (Servername und Freigabe wie bei euch), **Verbinden**, Kennwort im Schlüsselbund sichern. Die Freigabe erscheint als `/Volumes/Daten`; darin liegen z. B. `Kunden` und `Digitale Eingänge`.
2. **NAS-Suche → Einstellungen → Suchordner & NAS.**
3. Unter **„NAS-Freigaben, die beim Start verbunden werden“** genau eine Zeile: `smb://DiskStation/Daten`.
4. Unter **„Diese Ordner werden durchsucht“** den bisherigen Eintrag `/Volumes/Daten` (falls vorhanden) markieren → **Entfernen**.
5. Die gewünschten Bereiche einzeln hinzufügen – per **„Ordner auswählen …“** (links in der Seitenleiste „Daten“ wählen, dann den Unterordner) oder Pfad eintippen und **Hinzufügen**:
   - `smb://DiskStation/Daten/Kunden`
   - `smb://DiskStation/Daten/Digitale Eingänge`
6. Die NAS-Suche macht daraus automatisch `/Volumes/Daten/Kunden` und `/Volumes/Daten/Digitale Eingänge` und trägt die Freigabe zum Verbinden ein. **Speichern** – das erste Einlesen dauert je nach Größe einige Minuten, danach ist die Suche sofort da.
7. **Feste Ordner anlegen:** In der Suche *Ordner ▾ → „Ordner auswählen und anzeigen …“* → `Digitale Eingänge` → *Ordner ▾ → „Angezeigten Ordner als festen Ordner merken …“*. Ebenso für `Kunden`. Im Browser erscheinen sie zusätzlich unter **Schnellzugriff**.
8. Optional: *Ordner ▾ → „Angezeigten Ordner beim Start links öffnen“* für die Digitalen Eingänge, rechts die Kunden-Suche.
9. Optional für Kollegen: *Einstellungen → Browser & Kollegen → „Als Vorgabe speichern …“* und die `NasSuche.json` per E-Mail weitergeben. Der Kollege wählt auf seinem Mac *„Vorgabe laden …“* – danach hat er dieselbe Einrichtung, aber mit eigenem Programm und eigenem Index.

| Eintrag | Beispiel | Wirkung |
| --- | --- | --- |
| NAS-Freigabe | smb://DiskStation/Daten | wird beim Start und Anmelden automatisch verbunden |
| Suchordner 1 | /Volumes/Daten/Kunden | wird durchsucht |
| Suchordner 2 | /Volumes/Daten/Digitale Eingänge | wird durchsucht |
| Alles andere in „Daten“ | – | wird nicht eingelesen, bleibt im Finder erreichbar |

Noch bequemer im Finder: die Ordner `Kunden` und `Digitale Eingänge` aus dem Finder-Fenster in die Seitenleiste unter *Favoriten* ziehen. Sollen die Bereiche wirklich als getrennte Laufwerke erscheinen, muss der NAS-Admin sie in der Synology-Verwaltung (DSM → Systemsteuerung → Freigegebener Ordner) als eigene Freigaben anlegen; das ändert aber auch die Pfade an den Windows-PCs und ist für die Suche nicht nötig.

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

- **Windows:** neue `NasSuche.exe` (per E-Mail oder Stick) über die alte auf dem eigenen PC kopieren und starten. Die neue Version beendet die alte selbst.
- **Mac:** App beenden (Menüleisten-Symbol → Beenden), neue App in *Programme* ersetzen, einmal per Rechtsklick → Öffnen starten.
- **Browser-Erweiterung:** Das Programm legt beim Start die passende Erweiterung in denselben Ordner wie bisher. Im Browser auf der Erweiterungsseite bei „ERGOFORYOU NAS-Suche“ einmal auf **Neu laden** (Kreispfeil) klicken. Offene Webseiten danach einmal neu laden (F5), damit das Hineinziehen wieder geht.

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
