// Android-Oberfläche (dist-mobile) im Browser mit Handy-Größe prüfen: Start, Claude-Anfrage direkt aus der
// App (Antwort simuliert), Speicherung über Neustart, Desktop-Knöpfe ausgeblendet.
import { chromium, devices } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
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
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '[freudig] Hallo vom Handy!' } },
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
check(!(await page.evaluate(() => [...document.querySelectorAll('.msg.assistant')].some((m) => m.textContent.includes('[freudig]')))), 'Stimmungsmarke nicht sichtbar');
check(/freudig/.test(JSON.stringify(request?.body?.system ?? '')), 'Stimmungsmarken im Systemprompt angefordert');
check(
  await page.waitForFunction(() => window.__app.avatarState.mood === 'freudig', null, { timeout: 5000 }).then(() => true, () => false),
  'Figur bekommt die Stimmung',
);
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
// Figur antippen -> Rahmen mit Schnellwahl; „Füllen“ füllt die Bühne
await page.click('#closeSettings').catch(() => {});
await page.keyboard.press('Escape').catch(() => {});
const stageBox = await page.locator('#stage').boundingBox();
await page.evaluate(() => {
  const a = window.__app.avatar;
  const r = a.rect;
  const c = a.canvas.getBoundingClientRect();
  const o = { clientX: c.left + r.x + r.w / 2, clientY: c.top + r.y + r.h / 2, button: 0, pointerId: 7, bubbles: true, pointerType: 'mouse' };
  a.canvas.dispatchEvent(new PointerEvent('pointerdown', o));
  a.canvas.dispatchEvent(new PointerEvent('pointerup', o));
});
const fillBtn = page.locator('.rb .fitbar button', { hasText: 'Füllen' });
check(await fillBtn.isVisible(), 'Schnellwahl im Rahmen sichtbar');
await fillBtn.click();
await page.waitForTimeout(300);
const fill = await page.evaluate(() => ({ r: window.__app.avatar.rect, fit: window.__app.state.personas[0].avatar.stageFit }));
check(
  fill.fit?.mode === 'fuellen' && (fill.r.w >= stageBox.width - 2 || fill.r.h >= stageBox.height - 2) && fill.r.y <= 1,
  'Füllen: Figur füllt die Bühne, Kopf oben',
  JSON.stringify(fill.r),
);
await page.locator('.rb .fitbar button', { hasText: 'Ganz' }).click();
await page.waitForTimeout(300);
const whole = await page.evaluate(() => window.__app.avatar.rect);
check(whole.w <= stageBox.width + 2 && whole.h <= stageBox.height + 2 && (whole.w >= stageBox.width - 2 || whole.h >= stageBox.height - 2), 'Ganz: ganze Figur, so groß wie möglich', JSON.stringify(whole));
// Körper-Rig: Schultern, Arme und Hüfte werden aus dem Grundbild erkannt, die Verformung läuft
const figur = 'data:image/png;base64,' + fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'figur-front.png')).toString('base64');
const body = await page.evaluate(async (img) => {
  const av = window.__app.persona().avatar;
  av.image = img;
  av.vrm = null;
  await window.__app.ensureRig();
  await new Promise((r) => setTimeout(r, 1500));
  return { found: !!av.bodyRig?.lShoulder && !!av.bodyRig?.rShoulder, warp: !!window.__app.avatar.layers?.[0]?.bodyWarp };
}, figur);
check(body.found && body.warp, 'Körper aus dem Grundbild erkannt und bewegt', JSON.stringify(body));
// 3D-Figur aus Bildern auf dem Handy: Das Auswahlfenster muss über dem Dialog liegen, das Bild ankommen
await page.evaluate(() => document.querySelector('.rb')?.setAttribute('hidden', ''));
await page.click('#btnSettings');
await page.click('#tabs [data-tab=avatar]');
await page.click('#avVrmCreate');
await page.waitForSelector('.b2v');
await page.click('.b2v [data-pick=front]');
await page.waitForSelector('#pickSheet');
const onTop = await page.evaluate(() => {
  const el = document.querySelector('#pickSheet .ps-main');
  const r = el.getBoundingClientRect();
  return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
});
check(onTop, 'Auswahlfenster liegt über dem 3D-Figur-Dialog');
await page.setInputFiles('#pickSheet input[type=file]', path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'figur-front.png'));
await page.waitForFunction(() => /Punkte prüfen|Figuren erkannt|Fehler|Rückansicht/.test(document.querySelector('.b2v-status')?.textContent ?? ''), null, { timeout: 60000 }).catch(() => {});
const b2v = await page.textContent('.b2v-status');
check(/Punkte prüfen|Figuren erkannt/.test(b2v) && !(await page.isDisabled('.b2v [data-act=create]')), 'Bild für die 3D-Figur übernommen', b2v.slice(0, 120));
await page.click('.b2v [data-act=create]');
await page.waitForFunction(() => /^Fertig|Fehler/.test(document.querySelector('.b2v-status').textContent), null, { timeout: 120000 }).catch(() => {});
const made = await page.textContent('.b2v-status');
check(/^Fertig/.test(made) && (await page.evaluate(() => !!window.__app.persona().avatar.vrm)), '3D-Figur auf dem Handy erstellt', made.slice(0, 100));
// VRM speichern („Speichern unter …“ der Android-App, hier nachgebildet) und wieder laden
await page.evaluate(() => {
  window.__saved = [];
  window.KIFiles = { saveAs: (id, name, b64) => { window.__saved.push({ name, b64 }); setTimeout(() => window.__kiSaveDone(id, true, 'content://test'), 50); } };
});
await page.click('.b2v [data-act=save]');
await page.waitForFunction(() => /Gespeichert|nicht möglich/.test(document.querySelector('.b2v-status').textContent), null, { timeout: 10000 }).catch(() => {});
const saved = await page.evaluate(() => ({ status: document.querySelector('.b2v-status').textContent, files: window.__saved.map((f) => ({ name: f.name, len: f.b64.length })), b64: window.__saved[0]?.b64 }));
check(/Gespeichert/.test(saved.status) && /\.vrm$/.test(saved.files[0]?.name ?? '') && saved.files[0].len > 10000, 'VRM-Datei auf dem Handy gespeichert', JSON.stringify(saved.files));
await page.click('.b2v [data-act=close]');
const vrmPath = path.join(os.tmpdir(), 'ki-test-figur.vrm');
fs.writeFileSync(vrmPath, Buffer.from(saved.b64 ?? '', 'base64'));
const before = await page.evaluate(() => window.__app.persona().avatar.vrm);
await page.click('#avVrm');
await page.waitForSelector('#pickSheet');
check(!(await page.getAttribute('#pickSheet input[type=file]', 'accept')), 'VRM-Auswahl zeigt alle Dateien (nicht ausgegraut)');
await page.setInputFiles('#pickSheet input[type=file]', path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'figur-front.png'));
check(/passt nicht/.test(await page.textContent('#pickSheet .ps-info')), 'Falsche Datei wird abgelehnt');
await page.setInputFiles('#pickSheet input[type=file]', vrmPath);
await page.waitForFunction((b) => window.__app.persona().avatar.vrm && window.__app.persona().avatar.vrm !== b, before, { timeout: 30000 }).catch(() => {});
const loaded = await page.evaluate(() => ({ vrm: !!window.__app.persona().avatar.vrm, layer: !!window.__app.avatar.layers?.[0]?.isVrm, name: window.__app.persona().avatar.vrmName }));
check(loaded.vrm && loaded.layer && /\.vrm$/.test(loaded.name ?? ''), 'Gespeicherte VRM-Datei wieder geladen und zugeordnet', JSON.stringify(loaded));
check(await page.isVisible('#avVrmSave'), 'Knopf „VRM-Datei speichern“ sichtbar');
// ---- Regler auf dem Handy: Antippen/Scrollen verstellt nichts, –/+ stellt fein ein
await page.evaluate(() => window.__app.persona().avatar.vrm && document.querySelector('#avVrmOff')?.click());
await page.waitForTimeout(300);
const slider = await page.evaluate(() => {
  const r = document.querySelector('#avMotion');
  const before = r.value;
  const o = { pointerId: 9, pointerType: 'touch', bubbles: true, clientX: 10, clientY: 10 };
  r.dispatchEvent(new PointerEvent('pointerdown', o));
  // so verhält sich der Browser beim Antippen der Leiste: Wert springt
  r.value = String(+r.max);
  r.dispatchEvent(new Event('input', { bubbles: true }));
  r.dispatchEvent(new PointerEvent('pointerup', o));
  r.dispatchEvent(new Event('change', { bubbles: true }));
  const afterTap = r.value;
  const motionAfterTap = window.__app.persona().avatar.motion ?? 1;
  const wrap = r.closest('.range-step');
  wrap?.querySelectorAll('button')[1].click();
  return { before, afterTap, motionAfterTap, hasButtons: !!wrap, afterPlus: r.value, motion: window.__app.persona().avatar.motion };
});
check(slider.afterTap === slider.before && String(slider.motionAfterTap) === slider.before, 'Regler: Antippen beim Scrollen verstellt nichts', JSON.stringify(slider));
check(slider.hasButtons && +slider.afterPlus > +slider.before && slider.motion === +slider.afterPlus, 'Regler: –/+ stellt genau ein');

// ---- Großer Markier-Editor: Mundpunkt ziehen und übernehmen
await page.click('#avMarkBig');
await page.waitForSelector('#markEd canvas');
await page.waitForTimeout(300);
const mouthBefore = await page.evaluate(() => ({ ...window.__app.persona().avatar.mouth }));
const startPt = await page.evaluate(() => {
  const ed = document.querySelector('#markEd');
  const r = ed.querySelector('canvas').getBoundingClientRect();
  const p = ed.pointOnScreen('mouth');
  return { x: r.left + p.x, y: r.top + p.y };
});
if (startPt) {
  await page.mouse.move(startPt.x, startPt.y);
  await page.mouse.down();
  await page.mouse.move(startPt.x + 30, startPt.y + 20, { steps: 5 });
  await page.mouse.up();
}
await page.click('#markEd [data-act=done]');
const mouthAfter = await page.evaluate(() => ({ ...window.__app.persona().avatar.mouth }));
check(!!startPt && (mouthAfter.x !== mouthBefore.x || mouthAfter.y !== mouthBefore.y), 'Großer Editor: Mundpunkt verschoben und übernommen', JSON.stringify({ mouthBefore, mouthAfter }));

// ---- Video mit transparentem Hintergrund als Pose, Abschnitt wählen, Abschnitt als neue Pose, Standbild
const posesBefore = await page.evaluate(() => (window.__app.persona().avatar.poses ?? []).length);
await page.click('#poseAdd');
await page.waitForSelector('#pickSheet');
await page.setInputFiles('#pickSheet input[type=file]', path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'figur-alpha.webm'));
await page.waitForFunction((n) => (window.__app.persona().avatar.poses ?? []).length > n && window.__app.persona().avatar.poses.at(-1).cutMode, posesBefore, { timeout: 20000 }).catch(() => {});
const vpose = await page.evaluate(() => window.__app.persona().avatar.poses.at(-1));
check(vpose?.cutMode === 'alpha', 'Video mit Transparenz erkannt (keine KI-Freistellung nötig)', vpose?.cutMode);
await page.locator('.pose-opts button', { hasText: 'Abschnitt' }).last().click();
await page.waitForSelector('#vtool video');
await page.waitForFunction(() => document.querySelector('#vtool video').readyState >= 1);
await page.evaluate(async () => {
  const v = document.querySelector('#vtool video');
  const seek = (t) => new Promise((r) => { v.onseeked = r; v.currentTime = t; });
  await seek(0.5);
  document.querySelector('#vtool [data-act=start]').click();
  await seek(2.0);
  document.querySelector('#vtool [data-act=end]').click();
});
await page.click('#vtool [data-act=newpose]');
await page.click('#vtool [data-act=apply]');
const clips = await page.evaluate(() => window.__app.persona().avatar.poses.slice(-2).map((p) => ({ clip: p.clip, video: p.video })));
check(clips.length === 2 && clips.every((c) => c.clip && Math.abs(c.clip.start - 0.5) < 0.06 && Math.abs(c.clip.end - 2) < 0.06) && clips[0].video === clips[1].video, 'Video-Abschnitt gewählt und als weitere Pose angelegt', JSON.stringify(clips));
const layerClip = await page.waitForFunction(() => window.__app.avatar.layers?.find((L) => L.clip)?.clip, null, { timeout: 10000 }).then((h) => h.jsonValue()).catch(() => null);
check(layerClip && Math.abs(layerClip.start - 0.5) < 0.06, 'Figur spielt nur den Abschnitt', JSON.stringify(layerClip));
const imgBefore = await page.evaluate(() => window.__app.persona().avatar.image);
await page.locator('.pose-opts button', { hasText: '✂' }).last().click();
await page.waitForSelector('#vtool video');
await page.waitForFunction(() => document.querySelector('#vtool video').readyState >= 2);
page.once('dialog', (d) => d.accept());
await page.click('#vtool [data-act=still]');
await page.waitForFunction((b) => window.__app.persona().avatar.image && window.__app.persona().avatar.image !== b, imgBefore, { timeout: 20000 }).catch(() => {});
check(await page.evaluate((b) => window.__app.persona().avatar.image !== b, imgBefore), 'Standbild aus dem Video als Grundbild übernommen');
// ---- Gefühl in der Stimme: Stimmung der Antwort geht als Sprechanweisung an die OpenAI-Stimme
let ttsBody = null;
await page.route('https://api.openai.com/v1/audio/speech', (route) => {
  ttsBody = JSON.parse(route.request().postData());
  // kurze, gültige WAV-Datei (Stille) zurückgeben
  const n = 1600;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  route.fulfill({ status: 200, headers: { 'content-type': 'audio/wav', 'access-control-allow-origin': '*' }, body: b });
});
await page.evaluate(() => {
  const t = window.__app.tts;
  t.configure({ engine: 'cloud', cloud: { voice: 'nova', model: 'gpt-4o-mini-tts', instructions: 'Sprich warm.', emotion: true } });
  t.enqueue('Das ist ja großartig!', { mood: 'freudig' });
});
await page.waitForFunction(() => true);
for (let i = 0; i < 40 && !ttsBody; i++) await page.waitForTimeout(250);
check(/Sprich warm\./.test(ttsBody?.instructions ?? '') && /fröhlich/.test(ttsBody?.instructions ?? ''), 'Gefühl in der Stimme: Stimmung geht an die OpenAI-Stimme', ttsBody?.instructions);
await page.evaluate(() => window.__app.tts.stop());
check(!errors.length, 'keine Skriptfehler', errors.join(' | '));
await browser.close();
server.close();
