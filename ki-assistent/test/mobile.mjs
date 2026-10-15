// Android-Oberfläche (dist-mobile) im Browser mit Handy-Größe prüfen: Start, Claude-Anfrage direkt aus der
// App (Antwort simuliert), Speicherung über Neustart, Desktop-Knöpfe ausgeblendet.
import { chromium, devices } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist-mobile');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };
const server = http
  .createServer((req, res) => {
    const f = path.join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!f.startsWith(dist) || !fs.existsSync(f)) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] ?? 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  })
  .listen(8776);

const browser = await chromium.launch();
const page = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage();
// wie in der Android-WebView: keine Systemstimmen (speechSynthesis fehlt)
await page.addInitScript(() => {
  delete window.speechSynthesis;
  delete window.SpeechSynthesisUtterance;
  Object.defineProperty(window, 'speechSynthesis', { value: undefined, configurable: true });
});
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let request = null;
await page.route('https://api.anthropic.com/**', (route) => {
  request = { headers: route.request().headers(), body: JSON.parse(route.request().postData()) };
  const ev = (e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
  const evs = [
    { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hallo vom Handy!' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ];
  route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: evs.map(ev).join('') });
});

const check = (ok, label, detail = '') => {
  console.log(ok ? '✔' : '✘', label, detail);
  if (!ok) process.exitCode = 1;
};
await page.goto('http://localhost:8776/index.html');
await page.waitForFunction(() => window.__app, null, { timeout: 30000 });
check((await page.evaluate(() => window.__app.edition)) === 'mobile', 'Android-Ausgabe aktiv');
check((await page.evaluate(() => window.__app.state.settings.provider)) === 'anthropic', 'Claude ist Standard');
check(!(await page.isVisible('#btnFloat')) && !(await page.isVisible('#btnClose')), 'Desktop-Knöpfe ausgeblendet');
check((await page.isVisible('#btnLive')) && (await page.isVisible('#btnMic')), 'Live-Gespräch und Mikrofon sichtbar');
await page.evaluate(() => window.desktop.setKey('anthropic', 'sk-ant-test'));
await page.fill('#input', 'Hallo');
await page.click('#btnSend');
await page.waitForFunction(() => /Hallo vom Handy/.test(document.querySelector('.msg.assistant:last-child')?.textContent ?? ''), null, { timeout: 15000 });
check(request?.headers['anthropic-dangerous-direct-browser-access'] === 'true', 'Claude direkt aus der App angefragt', request?.body?.model);
await page.waitForTimeout(2500);
await page.reload();
await page.waitForFunction(() => window.__app);
await page.waitForTimeout(500);
const kept = await page.evaluate(() => Object.values(window.__app.state.history).reduce((n, h) => n + h.length, 0));
check(kept === 2, 'Verlauf bleibt nach Neustart erhalten', `(${kept} Nachrichten)`);
check((await page.evaluate(() => window.desktop.keyStatus())).anthropic, 'Schlüssel bleibt erhalten');
// Dateiauswahl: Android-Auswahl simulieren (ein kleines PNG), über die normalen Hochlade-Knöpfe
await page.evaluate(() => {
  window.__picked = [];
  window.__testPicker = {
    pickFiles: async (opts) => {
      window.__picked.push(opts);
      const c = document.createElement('canvas');
      c.width = 40;
      c.height = 60;
      c.getContext('2d').fillRect(10, 10, 20, 40);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      return { files: [{ name: 'bild.png', mimeType: 'image/png', size: blob.size, blob }] };
    },
  };
});
await page.click('#btnSettings');
await page.evaluate(() => document.querySelector('[data-tab=avatar]').click());
await page.evaluate(() => document.getElementById('avMorphAdd').click());
check(await page.isVisible('#pickSheet'), 'Auswahlfenster öffnet sich');
// Weg 1: direktes Antippen des echten Dateifelds
const png = await page.evaluate(async () => {
  const c = document.createElement('canvas');
  c.width = 40;
  c.height = 60;
  c.getContext('2d').fillRect(10, 10, 20, 40);
  return c.toDataURL('image/png').split(',')[1];
});
await page.setInputFiles('#pickSheet input[type=file]', { name: 'bild.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
await page.waitForFunction(() => (window.__app.state.personas[0].avatar.morphs?.length ?? 0) === 1, null, { timeout: 10000 }).catch(() => {});
check((await page.evaluate(() => window.__app.state.personas[0].avatar.morphs?.length ?? 0)) === 1, 'Bild über direktes Dateifeld übernommen');
check(!(await page.isVisible('#pickSheet')), 'Auswahlfenster schließt danach');
await page.evaluate(() => document.getElementById('btnCloseDrawer').click());
// Weg 2: Android-Dateiauswahl (simuliert) für einen Anhang
await page.evaluate(() => document.getElementById('btnAttach').click());
await page.click('#pickSheet [data-act=plugin]');
await page.waitForFunction(() => document.querySelectorAll('#attachments .chip').length === 1, null, { timeout: 10000 }).catch(() => {});
check((await page.$$('#attachments .chip')).length === 1, 'Anhang über Android-Dateiauswahl übernommen', JSON.stringify(await page.evaluate(() => window.__picked[0])));
// Schlüssel eingeben: beide Felder sichtbar (auch der OpenAI-Schlüssel, wenn Claude der Anbieter ist)
await page.click('#btnSettings');
await page.evaluate(() => document.querySelector('[data-tab=conn]').click());
check((await page.isVisible('#cClaudeKey')) && (await page.isVisible('#cOpenaiKey')), 'Claude- und OpenAI-Schlüsselfeld sichtbar');
await page.fill('#cOpenaiKey', 'sk-test-openai');
await page.click('#cOpenaiKeySave');
await page.waitForTimeout(300);
check((await page.evaluate(() => window.desktop.keyStatus())).openai, 'OpenAI-Schlüssel gespeichert');
await page.evaluate(() => document.querySelector('[data-tab=voice]').click());
check(!(await page.isVisible('#vSystemWrap')) && !(await page.evaluate(() => [...document.querySelectorAll('#vEngine option')].some((o) => o.value === 'server' && o.offsetParent !== null && getComputedStyle(o).display !== 'none'))), 'Chatterbox und Systemstimme ausgeblendet');
await page.evaluate(() => document.getElementById('btnCloseDrawer').click());
check(!errors.length, 'keine Skriptfehler', errors.join(' | '));
await browser.close();
server.close();
