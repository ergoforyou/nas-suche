# EML zu PDF

Ein kleines Windows-Programm (eine einzige Datei, **kein Python, keine Zusatzsoftware**):
`.eml`-Dateien markieren → Rechtsklick → **„In PDF umwandeln“**.

Es entsteht ein PDF der E-Mail und je ein PDF pro Anlage – im selben Ordner wie die `.eml`:

```
2026-10-13 Rechnung 4711.pdf                        <- die E-Mail (Absender, Empfänger, Datum, Text, Bilder)
2026-10-13 Rechnung 4711 - Anlage Rechnung.pdf      <- PDF-Anlage
2026-10-13 Rechnung 4711 - Anlage Angebot.pdf       <- Word-Anlage, umgewandelt
```

## Installation (auf jedem Rechner, ca. 10 Sekunden)

1. [`dist/EML-zu-PDF.exe`](dist/EML-zu-PDF.exe) herunterladen bzw. vom Netzlaufwerk kopieren.
2. **Doppelklick** → „Ja“. Keine Admin-Rechte nötig.
3. Frage „Downloads-Ordner automatisch überwachen?“ beantworten:
   - **Ja:** Jede neu heruntergeladene `.eml` wird ohne Klick sofort umgewandelt.
   - **Nein:** Nur per Rechtsklick.

Falls Windows „Der Computer wurde durch Windows geschützt“ meldet: **Weitere Informationen → Trotzdem ausführen**
(das kommt bei Programmen ohne gekaufte Code-Signatur einmalig).

**Deinstallieren:** Einstellungen → Apps → „EML zu PDF“ → Deinstallieren.
**Update:** Neue `EML-zu-PDF.exe` einfach erneut doppelklicken.

## Bedienung

- Eine oder viele `.eml` markieren → Rechtsklick → **„In PDF umwandeln“**.
  Unter Windows 11 zuerst **„Weitere Optionen anzeigen“** (oder gleich Umschalt + Rechtsklick).
- Am Ende kommt **eine** Meldung mit dem Ergebnis – auch bei 50 markierten Mails.

## Was mit Anlagen passiert

| Anlage | Ergebnis |
|---|---|
| PDF | 1:1 übernommen (auch wenn die Datei keine Endung hat) |
| Word (doc, docx, rtf, odt) | PDF über Microsoft Word |
| Excel (xls, xlsx, ods) | PDF über Microsoft Excel |
| PowerPoint (ppt, pptx) | PDF über Microsoft PowerPoint |
| Bilder (JPG, PNG, GIF, TIFF, BMP, WEBP) | PDF |
| TXT, CSV, HTML, XML | PDF |
| weitergeleitete E-Mail | eigene PDFs, inkl. deren Anlagen |
| Outlook-`winmail.dat` | wird ausgepackt, die enthaltenen Anlagen werden umgewandelt |
| alles andere (ZIP, passwortgeschützte Dokumente …) | Original wird danebengelegt und in der Abschlussmeldung genannt |

Robustheit:
- **Das E-Mail-PDF entsteht immer.** Reihenfolge: Microsoft Edge (schönstes Layout) → Microsoft Word →
  eingebauter PDF-Erzeuger (braucht nichts weiter, Schrift ist in der .exe enthalten).
  Bild- und Textanlagen erzeugt das Programm immer selbst.
- Beschädigte oder abgeschnittene Mails: Es wird gerettet, was lesbar ist.
- Office-Dateien werden mit **abgeschalteten Makros** und ohne Rückfragen geöffnet; passwortgeschützte
  Dokumente blockieren nichts, sondern werden als Original abgelegt und gemeldet.
- Ist kein Microsoft Office installiert, wird automatisch **LibreOffice** benutzt (falls vorhanden).
- Es geht nie etwas verloren: Was nicht umwandelbar ist, liegt im Original daneben.

Protokoll bei Problemen: `%LOCALAPPDATA%\EML zu PDF\protokoll.txt` (in die Explorer-Adresszeile einfügen).

## Für Entwickler

Go-Programm, eingebettete Schrift: DejaVu Sans (freie Lizenz, siehe `fonts/LICENSE.txt`). Bauen (geht auch unter Linux/macOS): `./build.sh` → `dist/EML-zu-PDF.exe`.

```
EML-zu-PDF.exe DATEI.eml [...] [--ziel ORDNER] [--still]
EML-zu-PDF.exe --ueberwachen [ORDNER] [--alle]
EML-zu-PDF.exe --installieren | --deinstallieren
```
