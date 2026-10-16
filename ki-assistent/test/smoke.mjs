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
      res.writeHead(up.status, { ...headers, 'Cross-Origin-Resource-Policy': 'same-origin' });
      if (!up.ok || !up.body) return res.end();
      return Readable.fromWeb(up.body).pipe(res);
    }
    const file = path.join(dist, pathname);
    if (!file.startsWith(dist) || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, {
      'Content-Type': types[path.extname(file)] ?? 'application/octet-stream',
      // wie in der App: Cross-Origin-Isolation für Mehrkern-WASM
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    });
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
console.log('crossOriginIsolated:', await page.evaluate(() => self.crossOriginIsolated), 'Kerne:', await page.evaluate(() => navigator.hardwareConcurrency));

console.log('Stimme:', JSON.stringify(await page.evaluate(() => window.__app.debugVoice('de_DE-thorsten-high', 'ich'))));

const quick = await Promise.race([
  page.evaluate(() => window.__app.selfTest()),
  new Promise((r) => setTimeout(() => r({ ok: false, error: 'Selbsttest hängt (Zeitüberschreitung)' }), 300000)),
]);
console.log('Selbsttest:', JSON.stringify(quick));
if (!quick.ok) {
  console.error('Selbsttest fehlgeschlagen');
  process.exit(1);
}

const cases = [
  // Standardstimme; "ich", "möchte", "dich" enthalten den ç-Laut, der früher falsch übersetzt wurde
  { text: 'Ich möchte dich etwas fragen. Das kostet z. B. 12 Euro.', lang: 'german', expect: [/möcht/i, /frag/i, /kostet/i, /beispiel/i] },
  { text: 'Hello, how are you today? I am fine, thank you.', lang: 'english', expect: [/hello/i, /today/i] },
];

let ok = true;
for (const c of cases) {
  const result = await page.evaluate(async ({ text, lang, voice: forced }) => {
    const { tts, stt } = window.__app;
    if (forced) tts.configure({ voices: { de: forced } });
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
    // genaueres Modell als "Prüfer", damit Fehler der Aussprache auffallen und nicht die der Erkennung
    stt.model = 'onnx-community/whisper-small';
    stt.language = lang;
    const heard = await stt.transcribe(audio);
    return { voice, seconds: +(pcm.audio.length / pcm.sampleRate).toFixed(2), ttsMs: Math.round(t1 - t0), sttMs: Math.round(performance.now() - t1), heard };
  }, c);
  const pass = c.expect.every((r) => r.test(result.heard));
  ok &&= pass;
  console.log(pass ? '✔' : '✘', JSON.stringify({ text: c.text, ...result }));
}

// KI-Freistellen: Figur vor Bürowand (Verlauf, Fenster, Regal) -> Wand transparent, Gesicht bleibt
const cut = await page.evaluate(async () => {
  const img = new Image();
  img.src = 'default-avatar.svg';
  await img.decode();
  const c = document.createElement('canvas');
  c.width = 600;
  c.height = 800;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, 600, 800);
  const t0 = performance.now();
  const rgba = await window.__app.stt.removeBackground(g.getImageData(0, 0, 600, 800));
  const alpha = (x, y) => rgba[(y * 600 + x) * 4 + 3];
  return {
    ms: Math.round(performance.now() - t0),
    wallTopLeft: alpha(20, 20),
    wallTopRight: alpha(580, 40),
    window: alpha(110, 120),
    face: alpha(300, 300),
    shirt: alpha(300, 560),
  };
});
const cutOk = cut.wallTopLeft < 60 && cut.wallTopRight < 60 && cut.face > 200;
ok &&= cutOk;
console.log(cutOk ? '✔' : '✘', 'KI-Freistellen', JSON.stringify(cut));

// KI-Freistellung für Videos: kurzes Video (Figur vor Bürowand, leichte Bewegung) Bild für Bild
const vid = await page.evaluate(async () => {
  const img = new Image();
  img.src = 'default-avatar.svg';
  await img.decode();
  const c = document.createElement('canvas');
  c.width = 300;
  c.height = 400;
  const g = c.getContext('2d');
  const rec = new MediaRecorder(c.captureStream(30), { mimeType: 'video/webm;codecs=vp8' });
  const chunks = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  rec.start();
  const t0 = performance.now();
  await new Promise((done) => {
    const f = () => {
      const t = (performance.now() - t0) / 1000;
      g.drawImage(img, Math.sin(t * 3) * 6, 0, 300, 400);
      if (t < 1.5) requestAnimationFrame(f);
      else done();
    };
    f();
  });
  rec.stop();
  await new Promise((r) => (rec.onstop = r));
  const url = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
  const t1 = performance.now();
  const bytes = await window.__app.computeVideoMask(url, (im) => window.__app.stt.removeBackground(im), null, { fps: 10 });
  const w = bytes[4] | (bytes[5] << 8);
  const h = bytes[6] | (bytes[7] << 8);
  const n = bytes[10] | (bytes[11] << 8);
  const head = String.fromCharCode(...bytes.subarray(0, 4)) === 'KIM2' ? 16 : 12;
  const at = (i, fx, fy) => bytes[head + i * w * h + Math.round(h * fy) * w + Math.round(w * fx)];
  // nur ein Abschnitt: weniger Bilder, Startzeit steht in der Datei
  const part = await window.__app.computeVideoMask(url, (im) => window.__app.stt.removeBackground(im), null, { fps: 10, start: 0.3, end: 0.8 });
  const partFrames = part[10] | (part[11] << 8);
  const partStart = new DataView(part.buffer).getFloat32(12, true);
  return { frames: n, w, h, ms: Math.round(performance.now() - t1), wall: at(0, 0.03, 0.03), face: at(0, 0.5, 0.37), lastWall: at(n - 1, 0.97, 0.05), lastFace: at(n - 1, 0.5, 0.37), partFrames, partStart: +partStart.toFixed(2) };
});
const vidOk = vid.frames > 5 && vid.wall < 60 && vid.lastWall < 60 && vid.face > 200 && vid.lastFace > 200 && vid.partFrames === 5 && vid.partStart === 0.3;
ok &&= vidOk;
console.log(vidOk ? '✔' : '✘', 'KI-Video-Freistellen', JSON.stringify(vid));

// KI-Tiefenschätzung (für das leichte Drehen von Bild-Avataren): Figur muss sich vom Hintergrund abheben
const depth = await page.evaluate(async () => {
  const img = new Image();
  img.src = 'default-avatar.svg';
  await img.decode();
  const c = document.createElement('canvas');
  c.width = 300;
  c.height = 400;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, 300, 400);
  const t0 = performance.now();
  const d = await window.__app.stt.estimateDepth(g.getImageData(0, 0, 300, 400));
  const at = (fx, fy) => d[Math.round(fy * 400) * 300 + Math.round(fx * 300)];
  return { ms: Math.round(performance.now() - t0), n: d.length, face: at(0.5, 0.37), wall: at(0.05, 0.05) };
});
const depthOk = depth.n === 300 * 400 && depth.face > depth.wall + 20;
ok &&= depthOk;
console.log(depthOk ? '✔' : '✘', 'KI-Tiefe', JSON.stringify(depth));

// Freistellen ganzer Figuren (BiRefNet): Figur bleibt, Lücken zwischen Armen/Beinen und Hintergrund verschwinden
const figB64 = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'figur-front.png')).toString('base64');
const fig = await page.evaluate(async (b64) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  // Hintergrund leicht verrauscht und nicht ganz einfarbig, damit nicht das Farbverfahren gewinnt
  const c = document.createElement('canvas');
  c.width = 300;
  c.height = 500;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 300, 500);
  grad.addColorStop(0, '#d8dde6');
  grad.addColorStop(1, '#b9c2cf');
  g.fillStyle = grad;
  g.fillRect(0, 0, 300, 500);
  g.drawImage(img, 0, 0, 300, 500);
  const t0 = performance.now();
  const rgba = await window.__app.stt.removeBackground(g.getImageData(0, 0, 300, 500), null, { quality: 'figur' });
  const a = (fx, fy) => rgba[(Math.round(fy * 500) * 300 + Math.round(fx * 300)) * 4 + 3];
  return { ms: Math.round(performance.now() - t0), model: window.__app.stt.cutoutModel, torso: a(0.5, 0.35), head: a(0.5, 0.12), wall: a(0.05, 0.05), legGap: a(0.5, 0.8) };
}, figB64);
// BiRefNet nur mit Grafikkarte; ohne (wie hier) muss MODNet sauber übernehmen
const figOk = ['BiRefNet', 'MODNet'].includes(fig.model) && fig.torso > 200 && fig.wall < 40 && (fig.model !== 'BiRefNet' || fig.legGap < 80);
ok &&= figOk;
console.log(figOk ? '✔' : '✘', 'KI-Freistellen ganzer Figuren', JSON.stringify(fig));

await browser.close();
server.close();
if (!ok) {
  console.error('Sprachkette fehlgeschlagen');
  process.exit(1);
}
console.log('Sprachkette OK');
