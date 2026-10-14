# EML zu PDF

Wandelt E-Mails (`.eml`) automatisch in PDF um – die E-Mail selbst **und** jede Anlage.
Die PDFs landen im selben Ordner wie die `.eml` (also normalerweise im Downloads-Ordner).

## Was rauskommt

Aus `Rechnung.eml` (Betreff „Rechnung 4711“, vom 13.10.2026) mit zwei Anlagen wird:

```
2026-10-13 Rechnung 4711.pdf                       <- die E-Mail (Absender, Empfänger, Datum, Text, Bilder)
2026-10-13 Rechnung 4711 - Anlage Rechnung.pdf     <- PDF-Anlage
2026-10-13 Rechnung 4711 - Anlage Brief.pdf        <- Word-Anlage, umgewandelt
```

| Anlage | wird zu |
|---|---|
| PDF | PDF (unverändert übernommen) |
| Bilder (JPG, PNG, GIF, TIFF, BMP, WEBP) | PDF |
| Word, Excel, PowerPoint, RTF, OpenOffice | PDF (über Microsoft Office, sonst LibreOffice) |
| TXT, HTML, CSV, XML | PDF |
| weitergeleitete E-Mail (`.eml`) | eigene PDFs, inkl. deren Anlagen |
| alles andere (ZIP usw.) | wird im Original danebengelegt |

## Installation (Windows, einmalig)

1. **Python installieren** von <https://www.python.org/downloads/> – beim Setup unbedingt
   **„Add python.exe to PATH“** anhaken.
2. Diesen Ordner `eml2pdf` irgendwohin kopieren.
3. **Doppelklick auf `Installieren.bat`**. Admin-Rechte sind nicht nötig.

Danach gibt es drei Wege:

- **Automatik:** Jede neue `.eml` im Downloads-Ordner wird nach wenigen Sekunden umgewandelt.
  Das läuft unsichtbar im Hintergrund und startet bei jeder Windows-Anmeldung automatisch.
  (`.eml`-Dateien, die vor der Installation schon dalagen, werden nicht angefasst.)
- **Rechtsklick** auf eine `.eml` → **„In PDF umwandeln“**
  (unter Windows 11 zuerst „Weitere Optionen anzeigen“ bzw. Umschalt + Rechtsklick).
- **Mehrere Dateien:** markieren → Rechtsklick → **Senden an** → **„EML in PDF umwandeln“**.

Für das E-Mail-PDF wird Microsoft Edge benutzt (ist bei Windows dabei), für Office-Anlagen
Microsoft Office oder – falls nicht vorhanden – das kostenlose LibreOffice.

## Deinstallieren

Doppelklick auf `Deinstallieren.bat`. Die schon erzeugten PDFs bleiben erhalten.

## Wenn etwas nicht klappt

Protokoll: `%LOCALAPPDATA%\eml2pdf\eml2pdf.log` (in die Explorer-Adresszeile einfügen).

## Für Fortgeschrittene (Kommandozeile)

```
python eml2pdf.py DATEI.eml [...]           Dateien umwandeln
python eml2pdf.py --ueberwachen [ORDNER]    Ordner überwachen (Standard: Downloads)
       --ziel ORDNER                        PDFs in einen anderen Ordner schreiben
       --alle                               beim Überwachen auch vorhandene .eml umwandeln
```

Eigenen Zielordner für die Automatik: in der Verknüpfung
`shell:startup\EML zu PDF Automatik.lnk` hinter `--ueberwachen` z. B. `--ziel "D:\Belege"` ergänzen.
