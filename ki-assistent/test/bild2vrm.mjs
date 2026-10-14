// End-to-End-Test „3D-Figur aus Bildern erstellen“ (bild2vrm) in der echten Oberfläche (Chromium via Playwright):
// Turnaround-Blatt laden -> automatisch aufteilen -> Figur erstellen -> VRM wird als 3D-Figur verwendet.
// Läuft ohne Internet (Testbild mit einfarbigem Hintergrund, kein KI-Modell nötig).
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };
const server = http
  .createServer((req, res) => {
    const file = path.join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  })
  .listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.addInitScript(() => {
  window.desktop = {
    loadData: async () => null, saveData: async () => {}, listModels: async () => [],
    setAlwaysOnTop() {}, chat() {}, abortChat() {}, minimize() {}, close() {}, show() {}, quit() {},
    onCommand() {}, setOffline() {}, modelInfo: async () => ({ dir: '', bytes: 0 }), openModelDir() {},
    avatarIgnoreMouse() {}, avatarDragStart() {}, avatarDragEnd() {}, avatarResize() {}, avatarMenu() {},
    saveMedia: async (bytes) => URL.createObjectURL(new Blob([bytes])), deleteMedia: async () => {},
    keyStatus: async () => ({}), lmStudioPrompts: async () => [],
  };
});
await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
await page.waitForFunction(() => window.__app);
await page.click('#btnSettings');
await page.click('#tabs [data-tab=avatar]');
await page.click('#avVrmCreate');
await page.waitForSelector('.b2v');

const chooser = page.waitForEvent('filechooser');
await page.click('.b2v [data-pick=sheet]');
await (await chooser).setFiles(path.join(here, 'fixtures', 'figur-turnaround.png'));
await page.waitForFunction(() => /Figuren erkannt|Fehler/.test(document.querySelector('.b2v-status').textContent), null, { timeout: 60000 });
const split = await page.textContent('.b2v-status');
await page.click('.b2v [data-act=create]');
await page.waitForFunction(() => /^Fertig|Fehler/.test(document.querySelector('.b2v-status').textContent), null, { timeout: 120000 });
const done = await page.textContent('.b2v-status');
const result = await page.evaluate(() => {
  const s = window.__app.state;
  const p = s.personas.find((x) => x.id === s.activeId) ?? s.personas[0];
  return { vrm: !!p.avatar.vrm, name: p.avatar.vrmName, layer: !!window.__app.avatar.layers?.[0]?.isVrm };
});
if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
await browser.close();
server.close();

const ok = /Front, Seite, Rücken/.test(split) && /^Fertig/.test(done) && result.vrm && result.layer && !errors.length;
console.log(ok ? '✔' : '✘', '3D-Figur aus Bildern', JSON.stringify({ split, done, ...result, errors }));
process.exit(ok ? 0 : 1);
