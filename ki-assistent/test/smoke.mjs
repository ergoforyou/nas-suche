// End-to-End-Test der Sprachkette im Browser (Chromium via Playwright):
// Piper spricht Sätze (Deutsch mit "ich"-Laut, Abkürzungen, Zahlen; Englisch) -> Whisper erkennt sie wieder.
// Benötigt Internet (Modell-Download). Der Testserver bildet die Modell-Route der App nach.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.wasm': 'application/wasm',
};
const server = http
  .createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (pathname.startsWith('/models/hf/')) {
      const up = await fetch('https://huggingface.co/' + pathname.slice('/models/hf/'.length));
      const headers = {};
      if (up.headers.get('content-length')) headers['Content-Length'] = up.headers.get('content-length');
      res.writeHead(up.status, headers);
      if (!up.ok || !up.body) return res.end();
      return Readable.fromWeb(up.body).pipe(res);
    }
    const file = path.join(dist, pathname);
    if (!file.startsWith(dist) || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  })
  .listen(8799);

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
page.on('console', (m) => m.type() === 'error' && console.log('CONSOLE', m.text()));
await page.addInitScript(() => {
  window.desktop = {
    loadData: async () => null, saveData: async () => {}, listModels: async () => [],
    setAlwaysOnTop() {}, chat() {}, abortChat() {}, minimize() {}, close() {}, show() {}, quit() {},
    onCommand() {}, setOffline() {}, modelInfo: async () => ({ dir: '', bytes: 0 }), openModelDir() {},
    avatarIgnoreMouse() {}, avatarDragStart() {}, avatarDragEnd() {}, avatarResize() {}, avatarMenu() {},
  };
});
await page.goto('http://localhost:8799/index.html');
await page.waitForFunction(() => window.__app);

const cases = [
  { text: 'Ich möchte dich etwas fragen. Das kostet z. B. 12 Euro.', expect: [/ich/i, /frag/i] },
  { text: 'Hello, how are you today? I am fine, thank you.', expect: [/hello/i, /today/i] },
];

let ok = true;
for (const c of cases) {
  const result = await page.evaluate(async (text) => {
    const { tts, stt } = window.__app;
    const voice = tts.voiceFor(text);
    const t0 = performance.now();
    // gleicher Weg wie die App: Satz in die Warteschlange, Audio abfangen
    const pcm = await new Promise((resolve, reject) => {
      tts.playPcm = async (audio, sampleRate) => resolve({ audio, sampleRate });
      tts.onStatus = (s) => /übersprungen|Fehler/.test(s) && reject(new Error(s));
      tts.stop();
      tts.newTurn();
      tts.enqueue(text);
    });
    const t1 = performance.now();
    // auf 16 kHz Mono umrechnen, wie es das Mikrofon liefern würde
    const off = new OfflineAudioContext(1, Math.ceil((pcm.audio.length / pcm.sampleRate) * 16000), 16000);
    const buf = off.createBuffer(1, pcm.audio.length, pcm.sampleRate);
    buf.copyToChannel(Float32Array.from(pcm.audio), 0);
    const src = off.createBufferSource();
    src.buffer = buf;
    src.connect(off.destination);
    src.start();
    const audio = (await off.startRendering()).getChannelData(0).slice();
    stt.model = 'onnx-community/whisper-base';
    stt.language = null; // automatisch erkennen
    const heard = await stt.transcribe(audio);
    return { voice, seconds: +(pcm.audio.length / pcm.sampleRate).toFixed(2), ttsMs: Math.round(t1 - t0), sttMs: Math.round(performance.now() - t1), heard };
  }, c.text);
  const pass = c.expect.every((r) => r.test(result.heard));
  ok &&= pass;
  console.log(pass ? '✔' : '✘', JSON.stringify({ text: c.text, ...result }));
}

await browser.close();
server.close();
if (!ok) {
  console.error('Sprachkette fehlgeschlagen');
  process.exit(1);
}
console.log('Sprachkette OK');
