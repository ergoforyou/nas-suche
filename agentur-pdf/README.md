# Agentur-PDF

PDF-Programm für die Agentur: Web-Oberfläche + lokaler Python-Dienst.
Architektur und Plan: [docs/ARCHITEKTUR_UND_PLAN.md](docs/ARCHITEKTUR_UND_PLAN.md)

## Stand

| Schritt | Inhalt | Status |
|---|---|---|
| M0 | Grundgerüst: Dienst, Befehlsregister, Menüband (6 Register), Befehlssuche Strg+K, Statusleiste, hell/dunkel | ✅ |
| M1 | Anzeigen: Tabs, Zoom (Strg+Mausrad, Regler, Seitenbreite/Ganze Seite/100 %, Bereich zoomen, Lupe), 4 Ansichtsmodi, Ansicht drehen, Miniaturen mit Größenregler, Lesezeichen, Volltextsuche (auch über alle Dokumente), zuletzt geöffnet, Favoriten-Ordner, Sitzung wiederherstellen, Passwort-PDFs | ✅ |
| M2 | Seiten organisieren: Miniaturen mit Mehrfachauswahl (Strg/Umschalt), Drag & Drop innerhalb und zwischen Dokumenten (Strg = kopieren), Dateien aus Explorer zwischen Miniaturen ablegen, Nebeneinander-Ansicht mit eigener Miniaturleiste je Dokument, Rechtsklickmenü, Drehen/Löschen (Entf)/Duplizieren/Extrahieren, leere Seite/Datei/Zwischenablage einfügen, Teilen (Seitenanzahl, Leerseiten, Lesezeichen, Dateigröße), Leerseiten entfernen, Rückgängig/Wiederholen (auch dokumentübergreifend), Speichern/Speichern unter mit Nachfrage beim Schließen | ✅ |
| M3–M8 | siehe Plan | offen |

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

## Tests

```bash
cd dienst && python -m pytest          # Kern + Schnittstelle + T7 (Renderzeiten)
cd oberflaeche && npx playwright test  # Oberfläche + T7 (Scrollen/Zoom im Browser)
```

## Sicherheit
Der Dienst lauscht nur auf `127.0.0.1` und verlangt ein bei jedem Start neu
erzeugtes Zugangs-Token. Andere Webseiten im Browser können ihn daher nicht
ansprechen.
