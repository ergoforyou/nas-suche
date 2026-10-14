# WhatsApp KI-Panel (Chrome-Erweiterung)

Öffnet **Claude oder ChatGPT als kleines Fenster rechts neben WhatsApp Web**, ganz normal
mit eurem eigenen Login (eure bestehende Lizenz, keine API-Schlüssel). Oben im KI-Fenster
sitzt eine kleine grüne Werkzeugleiste:

- **Vorlagen-Knöpfe** (z. B. „Antwort vorschlagen“, „Förmlich (Sie)“, „Zusammenfassen“):
  liest den gerade geöffneten WhatsApp-Chat aus, setzt eure feste Grundanweisung davor und
  schickt alles an Claude/ChatGPT.
- **Eigene Anweisung** ins Feld tippen + Enter: genauso, nur mit freiem Text.
- **„⬅ Markierten Text in WhatsApp einfügen“**: Antwort in Claude/ChatGPT markieren, klicken,
  der Text steht im WhatsApp-Eingabefeld. **Gesendet wird nie automatisch.** Das macht ihr selbst.
- **Claude / ChatGPT** umschalten, **⚙** öffnet die Einstellungen.

Die Leiste lässt sich mit der Maus verschieben und mit „–“ zu einem kleinen Knopf einklappen.

## Installation (pro Rechner, ca. 2 Minuten)

1. Diesen Ordner `whatsapp-ki-panel` auf den Rechner kopieren (z. B. nach `C:\Tools\whatsapp-ki-panel`).
2. In Chrome `chrome://extensions` öffnen.
3. Oben rechts **Entwicklermodus** einschalten.
4. **„Entpackte Erweiterung laden“** → den Ordner auswählen.
5. Auf das Puzzle-Symbol in der Chrome-Leiste klicken und „WhatsApp KI-Panel“ anpinnen.

## Benutzung

1. WhatsApp Web öffnen (auch über „Open WhatsApp Web“) und einen Chat anklicken.
2. Auf das Erweiterungs-Symbol klicken oder **Alt+Shift+K** drücken. Das KI-Fenster öffnet sich
   rechts daneben, WhatsApp wird passend schmaler gemacht.
3. Beim ersten Mal im KI-Fenster ganz normal bei Claude bzw. ChatGPT anmelden.
4. Vorlagen-Knopf klicken. Fertig.

Das Tastenkürzel lässt sich unter `chrome://extensions/shortcuts` ändern. Es funktioniert auch,
wenn WhatsApp als App-Fenster ohne Chrome-Symbolleiste läuft.

## Feste Arbeitsweise für alle („Skills“)

Unter **⚙ Einstellungen**:

- **Grundanweisung**: steht vor jeder Anfrage (Tonfall, Du/Sie, Grußformel, was nie zugesagt
  werden darf …).
- **Vorlagen**: die Knöpfe in der Leiste. `{{KONTAKT}}` wird durch den Chatnamen ersetzt.
- **Claude-/ChatGPT-Adresse**: Hier kann die Adresse eines **Claude-Projekts**
  (`https://claude.ai/project/…`) oder eines **eigenen GPTs** (`https://chatgpt.com/g/…`)
  eingetragen werden. Dann gelten zusätzlich dessen hinterlegte Anweisungen und Dateien.
- **Exportieren / Importieren**: Einmal sauber einrichten, exportieren, bei allen Kollegen
  importieren. Dann arbeiten alle gleich.

## Gut zu wissen

- Übergeben werden nur die Nachrichten, die WhatsApp gerade geladen hat (Standard: die
  letzten 40). Für mehr Verlauf im Chat nach oben scrollen.
- Bilder, Sprachnachrichten usw. erscheinen als `[Bild]`, `[Sprachnachricht]` … Inhalte von
  Sprachnachrichten kann die Erweiterung nicht lesen.
- Telefonnummern, E-Mail-Adressen und IBANs werden standardmäßig vor der Übergabe
  unkenntlich gemacht (abschaltbar).
- Ändern WhatsApp, Claude oder ChatGPT ihre Oberfläche, kann das Auslesen bzw. Einfügen
  einmal haken. Dann müssen die Selektoren in `whatsapp.js` bzw. `ai-toolbar.js`
  angepasst werden. Notfall: Der Prompt liegt immer auch in der Zwischenablage (Strg+V).
- **Datenschutz:** Die Chatinhalte gehen an Anthropic bzw. OpenAI. Für Kundendaten bitte
  Business-/Team-Lizenzen mit Auftragsverarbeitungsvertrag verwenden.

## Dateien

| Datei | Zweck |
|---|---|
| `manifest.json` | Erweiterungs-Beschreibung, Rechte, Tastenkürzel |
| `background.js` | Öffnet und dockt das KI-Fenster an, baut den Prompt |
| `whatsapp.js` | Liest den Chat aus WhatsApp Web / fügt Text ins Eingabefeld ein |
| `ai-toolbar.js` | Werkzeugleiste auf claude.ai / chatgpt.com |
| `defaults.js` | Standard-Grundanweisung und Vorlagen |
| `options.html/js` | Einstellungsseite |
