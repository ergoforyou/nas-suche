# E-Mail → PDF (mit Anhängen) – Chrome-Erweiterung

Mit einem Rechtsklick wird eine E-Mail aus **Outlook Web (Microsoft 365)** oder **Gmail** als
**eine einzige PDF-Datei** gespeichert: zuerst die E-Mail mit Kopfdaten, danach alle Anhänge.

Die Umwandlung läuft komplett lokal im Browser. Es wird nichts an fremde Server geschickt.

## Installation (einmalig, ca. 1 Minute)

1. Den Ordner `mail-pdf-extension` auf den PC kopieren (z. B. `C:\Tools\mail-pdf-extension`).
2. In Chrome (oder Edge) `chrome://extensions` öffnen (Edge: `edge://extensions`).
3. Oben rechts den **Entwicklermodus** einschalten.
4. **„Entpackte Erweiterung laden“** anklicken und den Ordner `mail-pdf-extension` auswählen.
5. Optional: Die Erweiterung über das Puzzle-Symbol an die Symbolleiste anheften.
6. Bereits geöffnete Outlook- und Gmail-Tabs einmal neu laden (F5).

## Bedienung

| Was | Wie |
|---|---|
| Geöffnete E-Mail speichern | Rechtsklick in die E-Mail → **„E-Mail als PDF speichern (mit Anhängen)“** |
| Ohne Öffnen | Rechtsklick auf die E-Mail in der Liste → derselbe Menüpunkt |
| Ganzen Verlauf | Rechtsklick → **„Ganzen Verlauf als PDF speichern“** |
| Per Tastatur | **Alt+Shift+P** (oder das rote Symbol in der Symbolleiste) |
| .eml- oder .msg-Datei (z. B. aus Google Drive) | Rechtsklick auf das Symbol → „EML-/MSG-Datei in PDF umwandeln …“ und die Datei hineinziehen |

Kurz erscheint ein kleines Fortschrittsfenster. Danach liegt die PDF unter
`Downloads\E-Mail-Archiv\2026-10-06_Frank Schwartz_Unterlagen.pdf`.
Ordner und Dateiname lassen sich in den Einstellungen ändern.

Während der Umwandlung zeigt Chrome kurz den Hinweis *„… hat begonnen, diesen Browser zu debuggen“*.
Das ist normal: Die Erweiterung nutzt die Druckfunktion von Chrome, damit die PDF genauso aussieht
wie beim Drucken. Der Hinweis verschwindet danach automatisch.

## Was mit den Anhängen passiert

| Anhang | Ergebnis in der PDF |
|---|---|
| PDF | Seiten werden 1:1 übernommen |
| Geschützte/verschlüsselte PDF | Seiten werden als Bild eingefügt, das Original wird zusätzlich eingebettet |
| Bilder (JPG, PNG, GIF, WebP, BMP, SVG) | je eine Seite, Handyfotos richtig gedreht |
| Word (.docx) | in Seiten umgewandelt (Text, Tabellen, Bilder; das Layout ist vereinfacht) |
| Excel (.xlsx, .xls, .ods) | jedes Tabellenblatt als Tabelle im Querformat |
| Text, CSV, HTML | als Seiten |
| Weitergeleitete E-Mails (.eml/.msg) | als eigene Seiten, mit deren Anhängen |
| Alles andere (ZIP, .doc, .pptx, TIFF …) | **als Datei in der PDF eingebettet**: Im PDF-Reader über die Büroklammer bzw. „Anhänge“ öffnen |

Auf dem Deckblatt steht jeder Anhang mit der Seite, auf der er beginnt.
Optional werden auf jede Seite Seitenzahlen gedruckt („Seite 3 von 9“).
Signaturbilder und Logos, die nur im E-Mail-Text stehen, werden nicht noch einmal einzeln angehängt.

## Einstellungen

Rechtsklick auf das Symbol → „Optionen“ (oder „Einstellungen“ im Fortschrittsfenster):

- Unterordner und Muster für den Dateinamen (`{datum}`, `{zeit}`, `{absender}`, `{betreff}`)
- „[EXTERN]“, „AW:“, „WG:“ automatisch aus dem Dateinamen entfernen
- Jedes Mal fragen, wo gespeichert werden soll
- Original-E-Mail (.eml) und Original-Anhänge zusätzlich in die PDF einbetten (Beweissicherung)

**Direkt in Google Drive speichern:** Wenn *Google Drive für Desktop* installiert ist, kann man in Chrome
unter *Einstellungen → Downloads* den Download-Speicherort auf einen Drive-Ordner setzen
(oder die Option „Jedes Mal fragen“ aktivieren und dort den Drive-Ordner wählen).

## Wenn etwas nicht klappt

- **„Keine E-Mail gefunden“**: Die E-Mail öffnen und direkt in den Text rechtsklicken.
- **Outlook meldet einen Anmeldefehler**: Den Outlook-Tab mit F5 neu laden und es erneut versuchen.
  Die Erweiterung verwendet die bestehende Anmeldung von Outlook im Browser.
- **Notlösung, die immer funktioniert**: Die E-Mail als Datei herunterladen
  (Outlook: „…“ → „Speichern unter“/„Herunterladen“, Gmail: „⋮“ → „Nachricht herunterladen“)
  und die .eml-Datei in das Fenster der Erweiterung ziehen.
- Bei Unterhaltungen (Konversationsansicht in Outlook) wird die **neueste** Nachricht gespeichert,
  mit „Ganzen Verlauf“ alle Nachrichten.

## Technik (für Interessierte)

- Manifest V3, keine externen Server, alle Bibliotheken liegen in `lib/`:
  pdf-lib (PDF zusammenfügen), postal-mime (.eml), @kenjiuno/msgreader (.msg), mammoth (.docx),
  SheetJS (Excel) und pdf.js (geschützte PDFs).
- Outlook: Das Original (MIME) wird über die Outlook-Web-Schnittstelle `service.svc` (GetItem mit
  `IncludeMimeContent`) und der Sitzung des Benutzers abgerufen.
  Gmail: über „Original herunterladen“ (`view=att … attid=0`) bzw. „Original anzeigen“.
- HTML wird mit der Chrome-Druckfunktion (`Page.printToPDF`) in einem unsichtbaren, minimierten Fenster
  zu PDF. Skripte aus E-Mails werden vorher entfernt und zusätzlich per Content-Security-Policy blockiert.
- Domains: `outlook.office.com`, `outlook.office365.com`, `outlook.live.com`, `outlook.cloud.microsoft`, `mail.google.com`.
  Für ein firmeneigenes Exchange-OWA muss die Domain in `manifest.json` ergänzt werden.
