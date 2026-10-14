# Agentur-PDF – Architektur & Implementierungsplan (zur Freigabe)

Stand: 14.10.2026 · Grundlage: Feature-Spezifikation „PDF-Editor Eigenbau“ + Rückmeldungen vom 14.10.

## 0. Getroffene Entscheidungen

| Thema | Entscheidung |
|---|---|
| Architektur | **Web-Oberfläche + lokaler Python-Dienst.** Eine Oberfläche für Windows-Programm *und* spätere Chrome-Kachel. |
| Betrieb | Lokal auf jedem der 6 PCs (Windows 10, später 11). Dateien lokal und auf der NAS-Freigabe. |
| Office | **Kein Microsoft Office nötig.** Word/Excel/ODT → PDF über ein mitgeliefertes, unsichtbares LibreOffice (portable, im Installer enthalten, keine eigene Installation, kein Startmenü-Eintrag). Google-Docs-Dateien kommen als PDF/DOCX-Download und laufen genauso durch. |
| Scans | ScanSnap legt in einen Ordner ab → **Überwachungsordner** wird von P2 nach **P1** vorgezogen. |
| Neu | **Screenshot-Werkzeug** mit globaler Tastenkombination + Auto-OCR, **Foto-Entzerren/Zuschneiden** (abfotografierte Dokumente, WhatsApp-Bilder). |

## 1. Architektur im Überblick

```
┌──────────────────────── Windows-PC ────────────────────────────────┐
│                                                                     │
│  Agentur-PDF.exe (Tray-Programm, startet mit Windows)               │
│   ├─ Lokaler Dienst  (Python 3.12, FastAPI, nur 127.0.0.1)          │
│   │    ├─ Dokument-Kern   PyMuPDF  (Rendern, Seiten, Annotationen,  │
│   │    │                  Ebenen/OCG, Schwärzen, AES-256, Komprimieren)
│   │    ├─ OCR-Kern        Tesseract 5 (tessdata_best deu/eng/frk)   │
│   │    │                  + OpenCV-Vorverarbeitung                  │
│   │    ├─ Konverter       Bilder/HEIC, TXT, EML/MSG, LibreOffice    │
│   │    ├─ Auftragswarteschlange (OCR, Konvertieren im Hintergrund)  │
│   │    ├─ Überwachungsordner, Screenshot-Hotkey, Explorer-Pipe      │
│   │    └─ Benutzerdaten   %APPDATA%\AgenturPDF (Stempel, Unterschr.,│
│   │                       Stilvorlagen, Wörterbuch, Sitzung)        │
│   └─ App-Fenster (WebView2 = Edge-Engine, auf Win10 vorhanden)      │
│        └─ Oberfläche  TypeScript + React (Menüband, Tabs, Miniaturen│
│                       Werkzeuge, Befehlssuche Strg+K)               │
│                                                                     │
│  Explorer-Rechtsklick ──Named Pipe──► laufende Instanz              │
└─────────────────────────────────────────────────────────────────────┘
Später: dieselbe Oberfläche als Chrome-Kachel (PWA) gegen den lokalen
oder einen NAS-Dienst – kein Neubau nötig.
```

**Warum diese Aufteilung?**
- Die gesamte PDF-Logik (Bearbeiten, OCR, Schwärzen) bleibt in bewährten Bibliotheken auf dem PC. Damit sind Qualität und Geschwindigkeit dieselben wie in einem nativen Programm.
- Die Oberfläche ist eine Web-App. Das Windows-Fenster und die spätere Chrome-Kachel zeigen exakt dasselbe.
- Seiten werden vom Dienst als Bilder gerendert, mit Cache und Kacheln. Was man sieht, ist damit genau das, was gespeichert und gedruckt wird.

### 1.1 Kernbausteine

| Baustein | Aufgabe |
|---|---|
| **Dokumentmodell** | Jedes offene Dokument = PyMuPDF-`Document` im Dienst, eindeutige ID, Änderungszähler je Seite. Oberfläche hält nur Ansichtszustand. |
| **Undo-Stack** | PyMuPDF-Journal (eingebautes Undo/Redo auf PDF-Ebene) + eigene Befehlsobjekte für dokumentübergreifende Aktionen (Seiten von A nach B ziehen = *ein* Undo-Schritt). |
| **Rendering-Cache** | Seitenbilder je (Dokument, Seite, Zoomstufe, Ebenen-Sichtbarkeit, Änderungszähler). Sofort unscharfe Vorschau aus nächster Stufe, dann scharf nachladen; nur sichtbare Seiten ±2 rendern; ab 200 % Kachel-Rendering (512×512). |
| **Werkzeug-System** | Jedes Werkzeug (Hervorheben, Textfeld, Stempel, Schwärzen …) ist ein Modul mit: Maus-Verhalten, Eigenschaftsleiste, Befehl an den Dienst. „Werkzeug fixieren“ zentral. |
| **Befehlsregister** | Jede Funktion ist ein registrierter Befehl (Name, Stichworte, Tastenkürzel, Register). Daraus entstehen Menüband, Rechtsklick-Menüs **und** Befehlssuche Strg+K – nichts kann „verloren gehen“. |
| **Module je Register** | `start/`, `seiten/`, `kommentieren/`, `bearbeiten/`, `konvertieren/`, `schuetzen/` – jedes Modul meldet seine Befehle selbst an. |
| **Ebenen** | Feste OCGs: *Scan/Original*, *OCR-Text*, *Agentur-Eintragungen* (Text, Bilder, Unterschriften), *Stempel*, *Kommentare* (Annotationen). Ein-/ausblendbar, sperrbar, beim Druck/Export wählbar. |

## 2. OCR – „solide statt verballhornt“

Bei PDF Architect entsteht das Problem, das ihr beschreibt (sinnlose Zeichen, andere Schriftarten), meistens im Modus „editierbarer Text“. Dort wird das Originalbild durch erkannten Text ersetzt, und jeder Erkennungsfehler wird sichtbar. Agentur-PDF macht das grundsätzlich anders:

1. **Das Bild bleibt unangetastet.** Der Standard ist „durchsuchbares Bild“: Der erkannte Text liegt *unsichtbar* auf eigener Ebene unter dem Originalbild. Das Dokument sieht danach **pixelgleich** aus wie vorher. Fehler beeinträchtigen höchstens die Suche, nie das Aussehen.
2. **Beste Modelle:** Tesseract 5 LSTM mit `tessdata_best` für Deutsch und Englisch, optional Fraktur. Keine „fast“-Modelle.
3. **Vorverarbeitung je Bildtyp:**
   - *Scan (300 dpi)*: Gerade-Ausrichten, Drehung erkennen, Entrauschen.
   - *Screenshot / WhatsApp-Bild (oft 72–96 dpi)*: 2–3-fach hochskalieren, kein Entrauschen (das zerstört Bildschirmschrift), bei Dunkelmodus Farben invertieren. Das ist der häufigste Grund für schlechte Screenshot-OCR.
   - *Handyfoto eines Dokuments*: erst entzerren (siehe 3.2), dann Kontrast und Beleuchtung ausgleichen.
4. **Wörterbuch-Unterstützung:** Das Benutzerwörterbuch mit Versicherungs-Fachbegriffen fließt als Tesseract-Wortliste ein.
5. **Erkennungsqualität sichtbar machen:** Unsichere Wörter lassen sich optional farbig anzeigen. Ihr seht sofort, wo die OCR nicht sicher ist, und sucht nicht blind.
6. **ScanSnap-Text:** Hat eine Seite schon einen Textlayer, wird nicht doppelt erkannt. Mit „OCR-Ebene ersetzen“ lässt sich der Text gezielt neu erkennen, falls die ScanSnap-Erkennung schwach war.
7. **Messbar:** Ein Testkorpus aus echten (anonymisierten) Agentur-Dokumenten wird bei jeder Änderung automatisch geprüft (Zeichenfehlerrate). Dafür bräuchte ich später 10–20 Beispielseiten von euch.

Eine zweite Erkennung neben Tesseract ist erst einmal nicht vorgesehen. Sollte Tesseract bei einzelnen Dokumentarten schwächeln, kann später PaddleOCR (läuft lokal, ohne Cloud) als zweite Erkennung dazukommen.

## 3. Neue Funktionen aus der Rückmeldung

### 3.1 Screenshot-Werkzeug [P1]
- Globale Tastenkombination, Standard **Strg+Umschalt+Druck** (kollidiert nicht mit ShareX, frei einstellbar).
- Bereich aufziehen, Fenster wählen oder ganzer Bildschirm (Mehrmonitor-fähig).
- Ablage automatisch im **zentralen Screenshot-Ordner** (einstellbar, z. B. NAS), Dateiname `JJJJ-MM-TT_HH-MM-SS_Kürzel.png` + gleichnamige durchsuchbare PDF.
- **Auto-OCR** im Hintergrund, erkannter Text kommt optional direkt in die Zwischenablage.
- Kleines Popup danach mit: *In offenes PDF einfügen* · *Als neue PDF öffnen* · *Text kopieren* · *Zuschneiden*.

### 3.2 Fotos & Bilder aufbereiten [P1]
- Dokumentkanten in Handyfotos automatisch erkennen und das Bild **perspektivisch entzerren**. Die vier Ecken sind per Maus korrigierbar.
- Zuschneiden, drehen, Filter „Dokument“ (Schwarz-Weiß, Schatten entfernen) und „Original“.
- Danach als Seite einfügen oder als neue PDF anlegen. Die OCR läuft automatisch.
- Das funktioniert direkt beim Zusammenführen (Rechtsklick im Explorer → Bilder werden aufbereitet) und für Bilder, die per Drag & Drop hereingezogen werden.

### 3.3 Überwachungsordner [P1, vorgezogen]
- Einer oder mehrere Ordner, z. B. der ScanSnap-Ausgang, werden beobachtet. Neue PDFs werden automatisch geprüft: Ist Text vorhanden? Wenn nicht, OCR. Gerade-Ausrichten und Leerseiten entfernen (Duplex) laufen ebenfalls mit.
- Ergebnis in Zielordner oder an Ort und Stelle. Das Original kommt optional in einen Unterordner `_Original`.

## 4. Implementierungsplan Stufe 1 (MVP)

Jeder Meilenstein ist für sich lauffähig und testbar.

| # | Meilenstein | Inhalt | Abnahmetest |
|---|---|---|---|
| M0 | Grundgerüst | Projektstruktur, Dienst + App-Fenster, Befehlsregister, Menüband (6 Register), Befehlssuche Strg+K, Statusleiste, Fluent-Optik hell/dunkel, CI-Tests | – |
| M1 | Anzeigen | Öffnen, Tabs, Rendering-Cache, Zoom (Strg+Mausrad, Regler, Breite/Seite/100 %, Lasso), Ansichtsmodi, Miniaturleiste mit Größenregler, Suche, zuletzt geöffnet, Sitzung wiederherstellen | **T7** (150 Seiten flüssig) |
| M2 | Seiten organisieren | Mehrfachauswahl, Drag & Drop innerhalb und **zwischen** Dokumenten, Nebeneinander-Ansicht (2+ Dokumente), Dateien aus Explorer/Outlook zwischen Miniaturen, Drehen/Löschen/Extrahieren/Teilen, Leerseiten entfernen, Undo | **T3** |
| M3 | Zusammenführen & Konvertieren | Dialog mit Reihenfolge, PDF/Bild/TIFF/HEIC/TXT/EML/MSG/DOCX/XLSX/ODT (LibreOffice portable), Explorer-Kontextmenü + Single-Instance | **T1** |
| M4 | OCR | OCR-Kern nach Abschnitt 2, Hintergrund-Aufträge mit Fortschritt, Bereichs-OCR → Zwischenablage, Überwachungsordner | **T2** |
| M5 | Bilder, Screenshot, Fotos | Bild einfügen mit Freistellung (Schwellwert + Kantenglättung), Unterschriften-/Stempelbibliothek, Screenshot-Werkzeug, Foto-Entzerren | **T4** |
| M6 | Bearbeiten & Kommentieren | Schreibmaschinen-Text mit Rechtschreibprüfung (Hunspell de_DE + Fachwörterbuch), Abdecken + Überschreiben, Schwebeleiste nach Textauswahl, Hervorheben/Unterstreichen/…, Notiz, Formen, Stilvorlagen, Kommentarliste, Stempel mit Datum + Kürzel, Formulare ausfüllen | **T5** |
| M7 | Schützen & Ausgabe | Schwärzen (echt, inkl. Suchmuster IBAN/Geburtsdatum), Passwort AES-256, Metadaten entfernen, Ebenen-Panel, Drucken mit/ohne Kommentare/Ebenen, Komprimieren mit Zielgröße, Auto-Sicherung | **T6**, **T8** |
| M8 | Auslieferung | PyInstaller-Paket, Setup.exe mit Silent-Install, Registrierung als PDF-Standardprogramm (optional), Explorer-Menü-Skript, Installationsanleitung | Installationstest auf sauberem Win10 |

**Stufe 2/3** bleiben wie in der Spezifikation. Zusätzlich vorgemerkt für Stufe 2: Chrome-Kachel (PWA) sowie Export nach Word und Google Docs.

## 5. Projektstruktur

```
agentur-pdf/
├─ dienst/                 # Python-Dienst
│  ├─ agentur_pdf/
│  │  ├─ api/              # FastAPI-Routen
│  │  ├─ kern/             # Dokumentmodell, Undo, Render-Cache, Ebenen
│  │  ├─ ocr/              # Tesseract, Vorverarbeitung, Bildtyp-Erkennung
│  │  ├─ konvertierung/    # Bilder, Office (LibreOffice), Mail
│  │  ├─ bild/             # Freistellung, Entzerren, Screenshot
│  │  ├─ windows/          # Tray, Hotkey, Named Pipe, Explorer, Überwachung
│  │  └─ benutzer/         # Einstellungen, Stempel, Unterschriften, Wörterbuch
│  └─ tests/               # pytest inkl. Abnahmetests T1–T8
├─ oberflaeche/            # TypeScript + React + Vite
│  └─ src/
│     ├─ befehle/          # Befehlsregister, Befehlssuche
│     ├─ module/           # start, seiten, kommentieren, bearbeiten, konvertieren, schuetzen
│     ├─ ansicht/          # Dokumentansicht, Miniaturen, Tabs, Nebeneinander
│     └─ werkzeuge/        # Werkzeug-System
├─ installer/              # PyInstaller-Spec, Inno-Setup-Skript, Registry-Skripte
└─ docs/
```

## 6. Lizenzen (keine Rechtsberatung)
PyMuPDF steht unter AGPL. Für die interne Nutzung im eigenen Büro ist das in der Regel unproblematisch, bei Weitergabe an Dritte vorher prüfen. Tesseract (Apache 2.0), LibreOffice (MPL 2.0), OpenCV (Apache 2.0), Hunspell-Wörterbuch de_DE (GPL/LGPL) und React (MIT) sind für euren Einsatz unkritisch.
