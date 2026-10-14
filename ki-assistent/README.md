# KI-Assistent

Ein schlankes Desktop-Chatfenster mit animiertem Avatar, das mit einem **lokalen Sprachmodell aus LM Studio**
spricht. Spracherkennung und Sprachausgabe laufen ebenfalls lokal auf dem eigenen Rechner.

| Baustein | Technik | lokal? |
|---|---|---|
| Sprachmodell | LM Studio (OpenAI-kompatibler Server, Port 1234) | ✔ |
| Spracherkennung | Whisper (tiny / base / small) über transformers.js, WebGPU oder CPU | ✔ |
| Sprachausgabe | Piper (neuronale Stimmen, z. B. „Thorsten“) oder Systemstimmen | ✔ |
| Avatar | eigenes Bild, animiert: Atmen, Wiegen, Blinzeln, Mundbewegung zur Stimme | ✔ |

> Beim **ersten** Benutzen werden die Sprachmodelle einmalig von Hugging Face geladen (ca. 80 MB Whisper +
> 60 MB Stimme). Danach funktioniert alles offline. Unter ⚙ → Sprache → „Sprachmodelle jetzt herunterladen“
> lässt sich das vorab erledigen.

## Benutzen

1. **LM Studio** installieren, ein Modell laden (z. B. Qwen3 8B, Llama 3.1 8B, Mistral) und unter
   **Developer → Start Server** den lokalen Server starten.
2. `KI-Assistent-…-nsis.exe` (Installer, legt eine Desktop-Verknüpfung an) oder `KI-Assistent-…-portable.exe`
   (ohne Installation) starten.
3. Lostippen oder auf 🎤 klicken (bzw. **Strg + Leertaste**) und sprechen. Nach einer kurzen Sprechpause
   wird automatisch abgeschickt.

### Bedienung

- **🎤** – einmal zuhören. Im **Freihand-Modus** (⚙ → Sprache) hört der Assistent ständig zu, sobald er
  fertig gesprochen hat.
- **■ / Esc** – Antwort und Sprachausgabe abbrechen.
- **📌** – Fenster immer im Vordergrund.
- Die Trennlinie unter dem Avatar lässt sich mit der Maus verschieben.

### Eigene Persona & Avatar

Unter ⚙ → **Persona**: Name, Charakter/Rolle (Systemprompt) und Begrüßung. Mehrere Personas sind möglich,
jede hat ihren eigenen Gesprächsverlauf. Personas lassen sich als `.persona.json` exportieren und an andere
weitergeben – das Avatarbild ist mit enthalten.

Unter ⚙ → **Avatar**:

1. **Bild hochladen** – z. B. ein Foto oder eine Zeichnung von jemandem am Schreibtisch.
2. Auf **👄 Mund** klicken und dann im Bild auf die Mundmitte klicken, danach auf beide Augen
   (der Modus springt automatisch weiter). Mit den Reglern Mundbreite und Augengröße anpassen.
3. **▶ Testsprechen** zum Ausprobieren.

Tipps: Frontal aufgenommene Gesichter mit geschlossenem Mund funktionieren am besten.
Für gezeichnete Figuren kann man unter „Fortgeschritten“ zusätzlich eigene Bilder mit **offenem Mund** und
**geschlossenen Augen** hochladen (PNGtuber-Stil); dann wird zwischen den Bildern überblendet.

## Entwickeln

```bash
cd ki-assistent
npm install
npm start          # baut die Oberfläche und startet die App
npm test           # Sprachkette Piper → Whisper im Browser testen (braucht Internet)
npm run dist       # Windows-Installer + portable .exe nach release/
```

Die Windows-Programme werden bei jedem Push von GitHub Actions gebaut (Workflow „KI-Assistent“,
Artefakt **KI-Assistent-Windows**). Ein Tag `ki-assistent-v0.1.0` erzeugt zusätzlich ein GitHub-Release.

### Aufbau

```
main.js           Electron-Hauptprozess: Fenster, app://-Protokoll, LM-Studio-Anbindung (Streaming), Speicher
preload.js        sichere Brücke zwischen Oberfläche und Hauptprozess
src/app.js        Oberfläche: Chat, Einstellungen, Personas, Ablaufsteuerung
src/avatar.js     Avatar-Animation (Canvas)
src/stt.js        Mikrofon + Sprechpausen-Erkennung
src/stt-worker.js Whisper im Web-Worker
src/tts.js        Piper / Systemstimmen, satzweise Ausgabe während die Antwort noch entsteht
build.mjs         bündelt alles nach dist/ inkl. der WASM-Laufzeiten (keine CDN-Abhängigkeit)
```

Daten (Einstellungen, Personas, Verläufe) liegen in `%APPDATA%\KI-Assistent\daten.json`.
