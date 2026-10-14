# Whiteboard für Chrome

Eine Ablage-Fläche direkt im Browser: Screenshots, Text-Snippets, Links und ganze
Dateien draufpacken, in Boards („Pakete“/Ordner) sortieren und im Blick behalten,
bis sie erledigt sind.

## Installieren (ca. 1 Minute)

1. In Chrome `chrome://extensions` öffnen.
2. Oben rechts den **Entwicklermodus** einschalten.
3. **„Entpackte Erweiterung laden“** klicken und diesen Ordner `whiteboard/` auswählen.
4. Optional: Über das Puzzle-Symbol das Whiteboard an die Symbolleiste anheften.

## Was rein kann – und wie

| Was | Wie |
|---|---|
| Screenshot | `Win+Shift+S` (bzw. Snipping-Tool), dann im Whiteboard `Strg+V` |
| Screenshot der aktuellen Webseite | `Alt+Shift+S` oder Rechtsklick → „Screenshot dieser Seite aufs Whiteboard“ |
| Text-Snippet | Text markieren → Rechtsklick → „Auswahl aufs Whiteboard“, oder `Strg+V` im Board |
| Link / Webseite | Rechtsklick auf Link bzw. Seite → „…aufs Whiteboard“, oder URL einfügen |
| Bild aus dem Web | Rechtsklick aufs Bild → „Bild aufs Whiteboard“ |
| Ganze Dateien (PDF, Excel, ZIP …) | Einfach auf die Fläche ziehen oder Button „Datei“ |
| Eigene Notiz | Doppelklick auf eine freie Stelle |

Alles, was **von außen** reinkommt (Rechtsklick, Shortcut), landet im gerade
geöffneten Board, wird orange als **NEU** markiert und am Symbol gezählt – so
fällt nichts durch, bis du es angeklickt hast.

## Arbeiten auf dem Board

- **Verschieben:** Karte an der Kopfzeile ziehen. **Größe ändern:** Ecke unten rechts.
- **In ein anderes Board:** Karte auf das Board in der linken Leiste ziehen.
  Dateien kann man auch direkt aus dem Explorer auf ein Board in der Leiste ziehen.
- **Weiterverarbeiten:** Bilder und Dateien lassen sich aus dem Board wieder
  heraus auf den Desktop/in einen Ordner ziehen, öffnen, herunterladen oder
  (Bilder, Text) in die Zwischenablage kopieren.
- **Erledigt-Haken**, **Farbe**, **Notizfeld** an jeder Karte, **Suche** oben.
- **Aufräumen** ordnet alles in Reihen an (Erledigtes ans Ende).
- **Zoom:** `Strg + Mausrad`. **Fläche verschieben:** auf freier Stelle ziehen.
- **Seitenbereich:** Rechtsklick aufs Erweiterungs-Symbol → „Whiteboard im
  Seitenbereich öffnen“ – dann bleibt es neben jeder Webseite sichtbar.

## Damit nichts verloren geht

- Löschen legt in den **Papierkorb** (mit „Rückgängig“ bzw. `Strg+Z`). Endgültig
  weg ist etwas erst, wenn man es dort löscht. Auch gelöschte Boards schieben
  ihre Inhalte in den Papierkorb.
- Gespeichert wird lokal im Chrome-Profil (IndexedDB, unbegrenzter Speicher,
  dauerhaft angefordert).
- **„Alles sichern (ZIP)“** erstellt eine komplette Sicherung inkl. aller Dateien.
  Achtung: Wird die Erweiterung deinstalliert, sind die lokalen Daten weg –
  vorher sichern.

## Team-Zugriff

**Heute schon:** Board über **Export** als ZIP speichern (z. B. auf das NAS oder
ein geteiltes Laufwerk legen), Kollegen holen es per **Import** in ihr Whiteboard.
Die ZIP enthält eine `whiteboard.json` und alle Dateien im Klartext-Ordner
`dateien/` – also auch ohne Erweiterung lesbar.

**Nächster Ausbauschritt (geplant):** Echte gemeinsame Boards über einen
zentralen Speicher. Die gesamte Speicherlogik steckt in `db.js`, sodass dort ein
Sync-Backend angeschlossen werden kann, ohne die Oberfläche umzubauen. Mögliche
Ziele: NAS per WebDAV (z. B. Synology), Google Drive oder ein kleiner
Server/Supabase für Live-Zusammenarbeit.

## Dateien

| Datei | Zweck |
|---|---|
| `manifest.json` | Erweiterungs-Definition (Manifest V3) |
| `background.js` | Rechtsklick-Menüs, Screenshot-Shortcut, Zähler am Symbol |
| `board.html/.css/.js` | Die Whiteboard-Oberfläche |
| `db.js` | Speicher-Schicht (IndexedDB) – hier docken später Team-Funktionen an |
| `zip.js` | Export/Import als ZIP ohne externe Bibliotheken |

**Berechtigungen:** „Zugriff auf alle Websites“ wird nur benötigt, um Bilder von
Webseiten herunterzuladen und Screenshots per Shortcut aufzunehmen. Es werden
keine Daten an irgendeinen Server gesendet.
