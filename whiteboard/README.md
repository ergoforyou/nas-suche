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

## Speichern auf dem Netzlaufwerk (fürs Team)

Oben rechts auf **„Nur lokal“** klicken → **„Ordner auf dem Netzlaufwerk wählen…“**
→ z. B. `Z:\Whiteboard` oder `\\NAS\Team\Whiteboard` auswählen und Zugriff erlauben.
Alle im Team machen das einmal mit **demselben Ordner** – dann sehen alle dieselben Boards.

So sieht der Ordner danach aus:

```
Whiteboard\
  Eingang\              ← jedes Board ist ein normaler Unterordner
    Angebot_2026.pdf     ← mit den echten Dateien
  Kunde Meier\
    Vertrag.pdf
  _whiteboard\          ← Verwaltung (Positionen, Notizen, Erledigt …) – nicht anfassen
```

- **Automatisch gespeichert:** Alles landet sofort lokal und wird alle paar Sekunden mit
  dem Ordner abgeglichen. Änderungen von Kollegen erscheinen nach wenigen Sekunden
  und sind als **NEU** markiert.
- **Funktioniert auch im Explorer:** Eine Datei, die man direkt in einen Board-Ordner
  legt, erscheint als neue Karte. Ein neuer Unterordner wird ein neues Board. Wird eine
  Datei im Explorer bearbeitet, aktualisiert sich die Karte.
- **Verschieben** einer Karte in ein anderes Board verschiebt auch die Datei in den
  passenden Ordner.
- **Laufwerk nicht erreichbar** (z. B. ohne VPN): Der Punkt wird orange, man arbeitet
  normal weiter, alles wird nachgeholt, sobald das Laufwerk wieder da ist.
- **Nach einem Chrome-Neustart** fragt Chrome ggf. einmal nach: Knopf **„Freigeben“**
  oben rechts anklicken.
- **Gleichzeitig dieselbe Karte bearbeitet?** Dann gilt die zuletzt gespeicherte Fassung.
- Abgeglichen wird, solange das Whiteboard (Tab oder Seitenbereich) offen ist. Was per
  Rechtsklick/Shortcut bei geschlossenem Whiteboard reinkommt, wird beim nächsten
  Öffnen übertragen.
- Wird ein Board umbenannt, behält der Ordner seinen ursprünglichen Namen.
- Wer im NAS keine Schreibrechte auf den Ordner hat, kommt auch nicht ans Whiteboard –
  die Rechte steuerst du also wie gewohnt über das NAS.

## Damit nichts verloren geht

- Löschen legt in den **Papierkorb** (mit „Rückgängig“ bzw. `Strg+Z`). Die Datei bleibt
  bis dahin auch im Ordner. Erst „endgültig löschen“ entfernt sie – auch auf dem
  Netzlaufwerk und für alle im Team. Gelöschte Boards schieben ihre Inhalte ebenfalls
  in den Papierkorb.
- Ohne Netzlaufwerk liegt alles lokal im Chrome-Profil (dauerhaft, auch nach Neustart).
  Dann vor einer Deinstallation unbedingt **„Alles sichern (ZIP)“**.
- **Export/Import** als ZIP funktioniert weiterhin, z. B. um ein Board an jemanden
  außerhalb des Teams zu geben.

## Dateien

| Datei | Zweck |
|---|---|
| `manifest.json` | Erweiterungs-Definition (Manifest V3) |
| `background.js` | Rechtsklick-Menüs, Screenshot-Shortcut, Zähler am Symbol |
| `board.html/.css/.js` | Die Whiteboard-Oberfläche |
| `db.js` | Lokale Speicher-Schicht (IndexedDB), zugleich Puffer für den Abgleich |
| `nas.js` | Abgleich mit dem Ordner auf dem Netzlaufwerk |
| `zip.js` | Export/Import als ZIP ohne externe Bibliotheken |

**Berechtigungen:** „Zugriff auf alle Websites“ wird nur benötigt, um Bilder von
Webseiten herunterzuladen und Screenshots per Shortcut aufzunehmen. Es werden
keine Daten an irgendeinen Server gesendet – gespeichert wird nur lokal und im
gewählten Ordner.
