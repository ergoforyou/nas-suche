# Agentur-PDF

PDF-Programm für die Agentur: Web-Oberfläche + lokaler Python-Dienst.
Architektur und Plan: [docs/ARCHITEKTUR_UND_PLAN.md](docs/ARCHITEKTUR_UND_PLAN.md)

## Stand

| Schritt | Inhalt | Status |
|---|---|---|
| M0 | Grundgerüst: Dienst, Befehlsregister, Menüband (6 Register), Befehlssuche Strg+K, Statusleiste, hell/dunkel | ✅ |
| M1 | Anzeigen: Tabs, Zoom (Strg+Mausrad, Regler, Seitenbreite/Ganze Seite/100 %, Bereich zoomen, Lupe), 4 Ansichtsmodi, Ansicht drehen, Miniaturen mit Größenregler, Lesezeichen, Volltextsuche (auch über alle Dokumente), zuletzt geöffnet, Favoriten-Ordner, Sitzung wiederherstellen, Passwort-PDFs | ✅ |
| M2 | Seiten organisieren: Miniaturen mit Mehrfachauswahl (Strg/Umschalt), Drag & Drop innerhalb und zwischen Dokumenten (Strg = kopieren), Dateien aus Explorer zwischen Miniaturen ablegen, Nebeneinander-Ansicht mit eigener Miniaturleiste je Dokument, Rechtsklickmenü, Drehen/Löschen (Entf)/Duplizieren/Extrahieren, leere Seite/Datei/Zwischenablage einfügen, Teilen (Seitenanzahl, Leerseiten, Lesezeichen, Dateigröße), Leerseiten entfernen, Rückgängig/Wiederholen (auch dokumentübergreifend), Speichern/Speichern unter mit Nachfrage beim Schließen | ✅ |
| M3 | Zusammenführen-Dialog (Reihenfolge per Drag & Drop/Pfeilen, Lesezeichen je Datei, Mail-Anhänge), Umwandlung von Word/Excel/PowerPoint/ODT/RTF (LibreOffice, kein MS Office nötig), Bildern (TIFF mehrseitig, HEIC, Handyfotos), Text und E-Mails (EML, Outlook-MSG), Hintergrundaufträge mit Fortschritt, Einzelinstanz, Explorer-Rechtsklick (`--explorer-einrichten`) | ✅ |
| M4 | Texterkennung als unsichtbare Textebene (Seitenbild bleibt unverändert), Scan/Foto/Bildschirmfoto/Dunkelmodus, Schräglage und Ausrichtung, Umlaut-Rettung per Wörterbuch, Hinweis bei Scans ohne Text, „Text aus Bereich“ (Taste T), unsichere Wörter markieren, Überwachungsordner (ScanSnap) mit Leerseiten-Entfernung | ✅ |
| M5 | Bilder & Unterschriften mit Freistellung (Beleuchtungsausgleich, weiche Kanten) und Bibliothek, Foto aufbereiten (Kanten erkennen, entzerren, Schatten entfernen, S/W), Screenshot-Werkzeug mit globalem Tastenkürzel, Bereichsauswahl, Ablage + OCR-PDF, Zwischenablage | ✅ |
| M6 | Anmerkungen als echte PDF-Anmerkungen: Hervorheben/Unterstreichen/Durchstreichen/Wellenlinie über Textauswahl (mit Schwebeleiste), Notiz, Textfeld, Schreibmaschine mit Rechtschreibprüfung (Hunspell + Fachwörter, Vorschläge per Rechtsklick), Formen, Pfeil, Freihand, Stempel mit Datum/Kürzel, Abdecken, Auswählen/Verschieben/Größe ändern, Kommentarliste, Formulare ausfüllen | ✅ |
| M7 | Schwärzen (Bereich, Textauswahl, Suchmuster IBAN/E-Mail/Telefon/Datum, auch OCR-Text), Kennwort AES-256 mit Rechten, Metadaten, Ebenen-Panel, Drucken mit Vorschau und Export ohne Kommentare/Ebenen, Komprimieren, Seiten als Bilder, Text-Export | ✅ |
| M8 | Setup.exe (pro Benutzer), Updates über NAS-Ordner, Standard-PDF-Programm, Explorer-Rechtsklick, PDF-Drucker, Sperrhinweis/automatische Sicherung, gemeinsame Einstellungen | ✅ (Windows-11-Kontextmenü direkt im neuen Menü, Chrome-Kachel offen) |
| M9 | Text bearbeiten, Formularfelder gestalten, Dokumente vergleichen, Stapelverarbeitung | ✅ |

## Starten (Entwicklung)

```bash
# Dienst
cd dienst
pip install -e ".[test]"          # unter Windows zusätzlich: pip install -e ".[windows]"
python -m agentur_pdf datei.pdf   # Windows: eigenes App-Fenster; sonst Browser

# Oberfläche bauen (einmalig bzw. nach Änderungen)
cd ../oberflaeche
npm install
npm run build
```

Für die Entwicklung mit automatischem Neuladen:
`python -m agentur_pdf --nur-dienst --port 8765 --token dev` und `npm run dev`,
dann `http://localhost:5173/#t=dev` öffnen.

## Explorer-Rechtsklick (Windows)

```bash
python -m agentur_pdf --explorer-einrichten   # pro Benutzer, ohne Adminrechte
python -m agentur_pdf --explorer-entfernen
python -m agentur_pdf --explorer-reg einträge.reg   # zum Prüfen/Verteilen
```

Einträge: „Mit Agentur-PDF öffnen“, „Zu einer PDF zusammenführen“ (auch bei
Mehrfachauswahl – alle Dateien landen in einem Dialog), „In PDF umwandeln“.
Unter Windows 11 erscheinen sie vorerst unter „Weitere Optionen anzeigen“.

## Texterkennung an eigenen Dokumenten messen

```bash
python werkzeuge/ocr_messung.py "C:\Pfad\zu\Beispiel-PDFs"
```

Misst, wie viele Wörter wiedergefunden werden bzw. wie viele echte deutsche
Wörter die Erkennung liefert (im Vergleich zu vorhandener Scanner-OCR).
Die Dokumente verlassen den PC dabei nicht.

## Tests

```bash
cd dienst && python -m pytest          # Kern + Schnittstelle + T7 (Renderzeiten)
cd oberflaeche && npx playwright test  # Oberfläche + T7 (Scrollen/Zoom im Browser)
```

## Sicherheit
Der Dienst lauscht nur auf `127.0.0.1` und verlangt ein bei jedem Start neu
erzeugtes Zugangs-Token. Andere Webseiten im Browser können ihn daher nicht
ansprechen.
