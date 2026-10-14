// End-to-End-Test der Sprachkette im Browser (Chromium via Playwright):
// Piper spricht einen Satz -> Whisper erkennt ihn wieder. Benötigt Internet (Modell-Download).
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.wasm': 'application/wasm',
};
const server = http
  .createServer((req, res) => {
    const file = path.join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname));
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
await page.addInitScript(() => {
  window.desktop = {
    loadData: async () => null, saveData: async () => {}, listModels: async () => [],
    setAlwaysOnTop() {}, chat() {}, abortChat() {}, minimize() {}, close() {},
  };
});
await page.goto('http://localhost:8799/index.html');
await page.waitForFunction(() => window.__app);

const result = await page.evaluate(async () => {
  const { tts, stt } = window.__app;
  tts.configure({ engine: 'piper', piperVoice: 'de_DE-thorsten-medium' });
  const t0 = performance.now();
  const wav = await tts.synthPiper('Hallo Welt. Heute ist ein schöner Tag.');
  const t1 = performance.now();
  // auf 16 kHz Mono umrechnen, wie es das Mikrofon liefern würde
  const ctx = new AudioContext();
  const decoded = await ctx.decodeAudioData(await wav.arrayBuffer());
  const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const audio = (await off.startRendering()).getChannelData(0).slice();
  stt.model = 'onnx-community/whisper-base';
  const text = await stt.transcribe(audio);
  return { wavBytes: wav.size, seconds: decoded.duration, ttsMs: Math.round(t1 - t0), sttMs: Math.round(performance.now() - t1), text };
});

console.log(JSON.stringify(result, null, 2));
await browser.close();
server.close();

if (!result.wavBytes || !/hallo/i.test(result.text) || !/tag/i.test(result.text)) {
  console.error('Sprachkette fehlgeschlagen');
  process.exit(1);
}
console.log('Sprachkette OK');
