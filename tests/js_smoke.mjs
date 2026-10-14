// Smoke-Test der JavaScript-Version in Chromium (Playwright):
//   python tests/make_test_figure.py /tmp/figur.png && node tests/js_smoke.mjs /tmp/figur.png
// Erzeugt VRM 0.x und 1.0 im Browser und prüft Aufbau, Humanoid-Bones und Ausdrücke.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const server = http.createServer((req, res) => {
  const file = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : 'text/html' });
  res.end(fs.readFileSync(file));
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

const img = fs.readFileSync(process.argv[2] ?? '/tmp/figur.png').toString('base64');
const browser = await chromium.launch();
const page = await browser.newPage();
let failed = false;
page.on('pageerror', (e) => { console.error('pageerror', e.message); failed = true; });
await page.goto(`${base}/README.md`);
for (const version of ['0', '1']) {
  const r = await page.evaluate(async ({ img, version, base }) => {
    const B = await import(`${base}/bild2vrm/js/index.js`);
    const front = await B.loadImage('data:image/png;base64,' + img);
    const { vrm, stats } = await B.generate(front, { vrmVersion: version, name: 'Test' });
    const dv = new DataView(vrm.buffer, vrm.byteOffset);
    const jlen = dv.getUint32(12, true);
    const gltf = JSON.parse(new TextDecoder().decode(vrm.subarray(20, 20 + jlen)));
    return { magic: dv.getUint32(0, true), total: dv.getUint32(8, true), len: vrm.length, gltf, stats };
  }, { img, version, base });
  const ext = version === '0' ? r.gltf.extensions.VRM : r.gltf.extensions.VRMC_vrm;
  const bones = version === '0' ? ext.humanoid.humanBones.length : Object.keys(ext.humanoid.humanBones).length;
  const ok = r.magic === 0x46546c67 && r.total === r.len && bones === 20 && r.stats.expressions.length === 10
    && r.gltf.meshes.map((m) => m.name).join() === 'Body,Face';
  console.log(`VRM ${version}: ${ok ? 'OK' : 'FEHLER'}`, JSON.stringify(r.stats));
  failed ||= !ok;
}
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
