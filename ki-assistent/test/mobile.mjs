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
const claudeQueue = []; // vorbereitete Antworten (Ereignislisten) für die nächsten Claude-Anfragen
const claudeRequests = [];
await page.route('https://api.anthropic.com/**', (route) => {
  request = { headers: route.request().headers(), body: JSON.parse(route.request().postData()) };
  claudeRequests.push(request.body);
  const ev = (e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
  const evs = claudeQueue.length ? claudeQueue.shift() : [
    { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '[freudig] Hallo vom Handy!' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ];
  route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: evs.map(ev).join('') });
});

/** Minimale PDF-Datei mit einer Textzeile (für den Firmenwissen-Test). */
function makePdf(text) {
  const esc = text.replace(/[()\\]/g, (c) => `\\${c}`);
  const stream = `BT /F1 12 Tf 50 750 Td (${esc}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

const check = (ok, label, detail = '') => {
  console.log(ok ? '✔' : '✘', label, detail);
  if (!ok) process.exitCode = 1;
};
await page.goto('http://localhost:8776/index.html');
await page.waitForFunction(() => window.__app, null, { timeout: 30000 });
check((await page.evaluate(() => window.__app.edition)) === 'mobile', 'Android-Ausgabe aktiv');
check((await page.evaluate(() => window.__app.state.settings.provider)) === 'anthropic', 'Claude ist Standard');
check(!(await page.isVisible('#btnFloat')) && !(await page.isVisible('#btnClose')), 'Desktop-Knöpfe ausgeblendet');
// Wortfetzen im Live-Gespräch: Füllwörter, einzelne Wörter, unsichere Erkennung, zu wenig Stimme
const frag = await page.evaluate(() => {
  const F = window.__app.fragmentReason;
  const tone = (sec, amp) => Float32Array.from({ length: 16000 * sec }, (_, i) => Math.sin(i / 8) * amp);
  const quiet = new Float32Array(16000);
  const mix = new Float32Array(32000);
  mix.set(tone(0.2, 0.2)); // 0,2 s Geräusch, Rest Stille
  return {
    filler: F('Äh, hm.', null),
    word: F('Tabelle', null),
    ok: F('Stopp!', null),
    real: F('Wie wird das Wetter morgen?', null),
    unsure: F('der die', 0.3),
    sureShort: F('Wie spät ist es?', 0.9),
    v1: window.__app.voicedSeconds(tone(1, 0.2), 0.01),
    v0: window.__app.voicedSeconds(quiet, 0.01),
    vMix: window.__app.voicedSeconds(mix, 0.01),
  };
});
check(
  frag.filler && frag.word && !frag.ok && !frag.real && frag.unsure && !frag.sureShort && frag.v1 > 0.9 && frag.v0 === 0 && frag.vMix < 0.25,
  'Live-Gespräch: Füllwörter, Einzelwort-Fetzen, unsichere Erkennung und reine Geräusche werden aussortiert',
  JSON.stringify(frag),
);
// Kostenzähler: Preise (Listenpreise) und Anzeige in der Titelleiste
const price = await page.evaluate(() => {
  const P = window.__app.priceOf;
  return {
    sonnet: P({ kind: 'chat', model: 'claude-sonnet-5-5', in: 1e6, out: 1e6 }),
    haiku: P({ kind: 'chat', model: 'claude-haiku-5-5', in: 50000, out: 50000, searches: 3 }),
    haikuBig: P({ kind: 'chat', model: 'claude-haiku-5-5', in: 200000, out: 0 }),
    cache: P({ kind: 'chat', model: 'claude-opus-5-5', cacheRead: 1e6, cacheWrite: 1e6 }),
    stt: P({ kind: 'stt', model: 'gpt-4o-transcribe', seconds: 120 }),
    tts: P({ kind: 'tts', model: 'gpt-4o-mini-tts', seconds: 60 }),
    rt: P({ kind: 'realtime', audioIn: 1e6, audioOut: 1e6 }),
    unknown: P({ kind: 'chat', model: 'irgendwas', in: 10, out: 10 }),
  };
});
const near = (a, b) => Math.abs(a - b) < 1e-9;
check(
  near(price.sonnet, 12) && near(price.haiku, 0.005 + 0.025 + 0.03) && near(price.haikuBig, 0.1) && near(price.cache, 0.2 + 5) && near(price.stt, 0.012) && near(price.tts, 0.015) && near(price.rt, 96) && price.unknown === null,
  'Kostenzähler: Preise je Dienst richtig gerechnet',
  JSON.stringify(price),
);
check((await page.isVisible('#btnLive')) && (await page.isVisible('#btnMic')), 'Live-Gespräch und Mikrofon sichtbar');
await page.evaluate(() => window.desktop.setKey('anthropic', 'sk-ant-test'));
await page.fill('#input', 'Hallo');
await page.click('#btnSend');
await page.waitForFunction(() => /Hallo vom Handy/.test(document.querySelector('.msg.assistant:last-child')?.textContent ?? ''), null, { timeout: 15000 });
check(request?.headers['anthropic-dangerous-direct-browser-access'] === 'true', 'Claude direkt aus der App angefragt', request?.body?.model);
await page.waitForTimeout(300);
const costUi = await page.evaluate(() => {
  const s = window.__app.costs.summary();
  document.getElementById('btnCost').click();
  const pop = document.getElementById('costPop');
  const out = { today: s.today, chip: document.getElementById('btnCost').textContent, chipVisible: !document.getElementById('btnCost').hidden, pop: !pop.hidden && /Dieser Monat/.test(pop.textContent) };
  document.getElementById('btnCost').click();
  return out;
});
check(costUi.today > 0 && costUi.chipVisible && /\$/.test(costUi.chip) && costUi.pop, 'Kostenzähler: Claude-Anfrage gezählt, Anzeige und Details', JSON.stringify(costUi));
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
// Finger: kurzes Antippen stoppt die Sprachausgabe (kein Rahmen), langes Drücken öffnet den Rahmen
const tapRes = await page.evaluate(async () => {
  const a = window.__app.avatar;
  const r = a.rect;
  const c = a.canvas.getBoundingClientRect();
  const o = { clientX: c.left + r.x + r.w / 2, clientY: c.top + r.y + r.h / 2, button: 0, pointerId: 9, bubbles: true, pointerType: 'touch' };
  const t = window.__app.tts;
  const origStop = t.stop.bind(t);
  let stopped = 0;
  t.stop = () => {
    stopped++;
    origStop();
  };
  window.__app.state.busy = true;
  a.canvas.dispatchEvent(new PointerEvent('pointerdown', o));
  await new Promise((r2) => setTimeout(r2, 120));
  a.canvas.dispatchEvent(new PointerEvent('pointerup', o));
  window.__app.state.busy = false;
  const frameAfterTap = !document.querySelector('.rb').hidden;
  t.stop = origStop;
  a.canvas.dispatchEvent(new PointerEvent('pointerdown', { ...o, pointerId: 10 }));
  await new Promise((r2) => setTimeout(r2, 750));
  a.canvas.dispatchEvent(new PointerEvent('pointerup', { ...o, pointerId: 10 }));
  const frameAfterHold = !document.querySelector('.rb').hidden;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  return { stopped, frameAfterTap, frameAfterHold };
});
check(tapRes.stopped > 0 && !tapRes.frameAfterTap && tapRes.frameAfterHold, 'Handy: Figur antippen stoppt die Sprache (kein Rahmen), langes Drücken öffnet den Rahmen', JSON.stringify(tapRes));
// Zwei Finger zusammenziehen verkleinert die Figur – ohne vorher den Rahmen zu öffnen; Rahmen bleibt vom Rand weg
const pinchRes = await page.evaluate(async () => {
  const a = window.__app.avatar;
  const c = a.canvas.getBoundingClientRect();
  const r = a.rect;
  const cx = c.left + r.x + r.w / 2;
  const cy = c.top + r.y + r.h / 2;
  const before = a.layout.scale;
  const ev = (type, id, x, y) => a.canvas.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button: 0, pointerId: id, bubbles: true, pointerType: 'touch' }));
  ev('pointerdown', 21, cx - 80, cy);
  await new Promise((r2) => setTimeout(r2, 40));
  ev('pointerdown', 22, cx + 80, cy);
  for (let i = 1; i <= 5; i++) {
    ev('pointermove', 21, cx - 80 + i * 8, cy);
    ev('pointermove', 22, cx + 80 - i * 8, cy);
  }
  ev('pointerup', 21, cx - 40, cy);
  ev('pointerup', 22, cx + 40, cy);
  await new Promise((r2) => setTimeout(r2, 700)); // langes Drücken darf danach nicht noch den Rahmen öffnen
  const after = a.layout.scale;
  const frameShown = !document.querySelector('.rb').hidden;
  return { before, after, frameShown, def: a.defaultLayout };
});
check(pinchRes.after < pinchRes.before * 0.8 && !pinchRes.frameShown && pinchRes.def?.scale < 1, 'Handy: zwei Finger zusammenziehen verkleinert die Figur (ohne Rahmen); Standard etwas kleiner als die Bühne', JSON.stringify(pinchRes));
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
// Schultern: auf dem Handy beweglich, mit shoulders:false (PC) stehen sie still – Arme und Brust bewegen weiter
const shoulders = await page.evaluate(async () => {
  const av = window.__app.avatar;
  const a = av.layers?.find((L) => L.bodyRig) ?? av;
  if (!a.bodyRig) return { skip: true };
  const st = { breathe: 1, shrug: 1, posture: 1, swing: 1, gesture: 1, side: 1 };
  const H = window.__app.bodyHandles;
  const move = (hs) => hs.slice(0, 2).map((h) => Math.abs(h.dx) + Math.abs(h.dy));
  const arms = (hs) => hs.slice(4).some((h) => Math.abs(h.dx) + Math.abs(h.dy) > 0.01);
  const on = H(a.bodyRig, a.w, a.h, st);
  const off = H(a.bodyRig, a.w, a.h, { ...st, shoulders: false });
  return { phone: av.bodyShoulders, on: move(on), off: move(off), armsOff: arms(off) };
});
check(shoulders.skip || (shoulders.phone === true && shoulders.on.some((v) => v > 0.1) && shoulders.off.every((v) => v === 0) && shoulders.armsOff), 'Schultern: Handy beweglich, PC still (Arme bewegen weiter)', JSON.stringify(shoulders));
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
  window.__picked = [];
  window.KIFiles = {
    saveAs: (id, name, b64) => { window.__saved.push({ name, b64 }); setTimeout(() => window.__kiSaveDone(id, true, 'content://test'), 50); },
    // Speicherort vorab wählen, später schreiben (wie der Android-Dialog „Speichern unter …“)
    pickTarget: (id, name) => { window.__picked.push({ name, t: performance.now() }); setTimeout(() => window.__kiSaveDone(id, true, 'content://test/' + name), 50); },
    writeUri: (uri, b64) => { window.__saved.push({ name: decodeURIComponent(uri.split('/').pop()), b64, t: performance.now() }); return ''; },
  };
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
// ---- Mehrere Videos für denselben Anlass: zweites Video ersetzt nicht das erste, beide kommen abwechselnd dran
const alphaVideo = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'figur-alpha.webm');
const nBefore = await page.evaluate(() => window.__app.persona().avatar.poses.length);
await page.locator('.pose-row button[title^="Diese Pose bearbeiten"]').last().click();
page.once('dialog', (d) => d.accept()); // „als NEUE Pose hinzufügen?“ -> OK
await page.click('#avUpload');
await page.waitForSelector('#pickSheet');
await page.setInputFiles('#pickSheet input[type=file]', alphaVideo);
await page.waitForFunction((n) => window.__app.persona().avatar.poses.length === n + 1 && window.__app.persona().avatar.poses.at(-1).video, nBefore, { timeout: 20000 }).catch(() => {});
const after = await page.evaluate(() => window.__app.persona().avatar.poses.map((p) => !!p.video));
check(after.length === nBefore + 1 && after.slice(-2).every(Boolean), 'Zweites Video als neue Pose (erstes bleibt erhalten)', JSON.stringify(after));
// alle Video-Posen auf „beim Nachdenken“, ohne Abschnitt, ohne Schleife
const rotation = await page.evaluate(async () => {
  const av = window.__app.persona().avatar;
  for (const p of av.poses) if (p.video) Object.assign(p, { trigger: 'think', loop: false, clip: { start: 0, end: 1 } });
  await window.__app.avatar.setConfig(av);
  window.__app.avatar.previewPose(null); // Vorschau des Editors aus – wie nach dem Schließen der Einstellungen
  window.__app.avatarState.thinking = true;
  const seen = new Set();
  for (let t = 0; t < 60; t++) {
    await new Promise((r) => setTimeout(r, 200));
    const L = window.__app.avatar.layers[window.__app.avatar.current];
    if (L?.isVideo) seen.add(window.__app.avatar.current);
  }
  window.__app.avatarState.thinking = false;
  return { seen: [...seen], videos: window.__app.avatar.layers.filter((L) => L.isVideo).length };
});
check(rotation.videos >= 2 && rotation.seen.length >= 2, 'Mehrere Videos desselben Anlasses laufen abwechselnd', JSON.stringify(rotation));
// Ruhe-Videos statt Grundbild: in Ruhe laufen sie dauernd im Wechsel, beim Sprechen kommt das Grundbild (Lippen)
const restRes = await page.evaluate(async () => {
  const av = window.__app.persona().avatar;
  const vids = av.poses.filter((p) => p.video);
  const saved = vids.map((p) => p.trigger);
  vids.slice(0, 2).forEach((p) => (p.trigger = 'rest'));
  vids.slice(2).forEach((p) => (p.trigger = 'think'));
  await window.__app.avatar.setConfig(av);
  window.__app.avatar.previewPose(null);
  const A = window.__app.avatar;
  const S = window.__app.avatarState;
  S.thinking = S.listening = S.speaking = false;
  const seen = new Set();
  let base = 0;
  await new Promise((r) => setTimeout(r, 800));
  for (let t = 0; t < 50; t++) {
    await new Promise((r) => setTimeout(r, 200));
    if (A.current === 0) base++;
    else if (A.layers[A.current]?.config.trigger === 'rest') seen.add(A.current);
  }
  S.speaking = true;
  await new Promise((r) => setTimeout(r, 800));
  const speakCur = A.current;
  S.speaking = false;
  vids.forEach((p, i) => (p.trigger = saved[i]));
  await A.setConfig(av);
  return { seen: [...seen], base, speakCur };
});
check(restRes.seen.length === 2 && restRes.base <= 2 && restRes.speakCur === 0, 'Ruhe-Videos statt Grundbild: laufen im Wechsel, beim Sprechen Grundbild', JSON.stringify(restRes));
// Stimmung als Anlass: fröhliche Pose beim fröhlichen Sprechen
const moodPose = await page.evaluate(async () => {
  const av = window.__app.persona().avatar;
  const vids = av.poses.filter((p) => p.video);
  vids.forEach((p, i) => (p.trigger = i === 0 ? 'speak:freudig' : 'idle'));
  await window.__app.avatar.setConfig(av);
  window.__app.avatar.previewPose(null);
  const target = window.__app.avatar.layers.findIndex((L) => L.config?.trigger === 'speak:freudig');
  window.__app.setMood('freudig');
  window.__app.avatarState.speaking = true;
  let hit = false;
  for (let t = 0; t < 40 && !hit; t++) {
    await new Promise((r) => setTimeout(r, 250));
    window.__app.setMood('freudig');
    hit = window.__app.avatar.current === target;
  }
  window.__app.avatarState.speaking = false;
  return { target, hit };
});
check(moodPose.target > 0 && moodPose.hit, 'Pose für „beim Sprechen – fröhlich“ wird gezeigt', JSON.stringify(moodPose));
// Neue Anlässe: kurzer Anlass (geschafft), längeres Warten, Probe im Editor
const events = await page.evaluate(async () => {
  const app = window.__app;
  const av = app.persona().avatar;
  const vids = av.poses.filter((p) => p.video);
  const trig = ['event:success', 'think:long', 'idle:bored'];
  vids.forEach((p, i) => (p.trigger = trig[i % trig.length]));
  await app.avatar.setConfig(av);
  app.avatar.previewPose(null);
  const idx = (t) => app.avatar.layers.findIndex((L) => L.config?.trigger === t);
  const wait = async (cond, ms = 6000) => {
    for (let t = 0; t < ms / 100; t++) {
      if (cond()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };
  const out = {};
  app.fireEvent('success', 3000);
  out.success = await wait(() => app.avatar.current === idx('event:success'), 2500);
  await new Promise((r) => setTimeout(r, 3500));
  app.avatarState.thinking = true;
  app.avatarState.wait = 'tool';
  out.long = await wait(() => app.avatar.current === idx('think:long'), 3000);
  app.avatarState.thinking = false;
  app.avatarState.wait = null;
  app.avatar.simulateTrigger('idle:bored', 3000);
  out.probe = await wait(() => app.avatar.current === idx('idle:bored'), 2500);
  app.avatar.simulateTrigger(null);
  out.tod = app.timeOfDayEnergy(8) > 1 && app.timeOfDayEnergy(23) < 1;
  return out;
});
check(events.success, 'Anlass „geschafft“ zeigt seine Pose sofort', JSON.stringify(events));
check(events.long, 'Längeres Warten (Internet/Datei) hat eigene Pose', JSON.stringify(events));
check(events.probe, 'Anlass-Probe im Editor zeigt die passende Pose', JSON.stringify(events));
check(events.tod, 'Tageszeit: morgens munterer, abends ruhiger');
// ---- Langes Video: Schnitt-Werkzeug öffnet sich gleich nach dem Hochladen, „2 s ab hier“ schneidet
await page.click('#poseAdd');
await page.waitForSelector('#pickSheet');
await page.setInputFiles('#pickSheet input[type=file]', path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'figur-lang.webm'));
const toolOpen = await page.waitForSelector('#vtool video', { timeout: 20000 }).then(() => true, () => false);
check(toolOpen, 'Langes Video: Schnitt-Werkzeug öffnet sich automatisch', await page.evaluate(() => document.querySelector('#status')?.textContent + ' | ' + JSON.stringify(window.__app.persona().avatar.poses.at(-1))));
if (toolOpen) {
  await page.waitForFunction(() => document.querySelector('#vtool video').readyState >= 1);
  await page.evaluate(() => new Promise((r) => { const v = document.querySelector('#vtool video'); v.onseeked = r; v.currentTime = 1; }));
  // Live-Vorschau der Freistellung: „Einfarbige Wand“ wählen -> Ecke durchsichtig, Figur sichtbar
  await page.selectOption('#vtool .vt-mode', 'flood');
  await page.waitForTimeout(800);
  const pv = await page.evaluate(() => {
    const c = document.querySelector('#vtool .vt-prev');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const a = (fx, fy) => d[(Math.round(fy * (c.height - 1)) * c.width + Math.round(fx * (c.width - 1))) * 4 + 3];
    return { w: c.width, corner: a(0.03, 0.03), body: a(0.5, 0.55), tolVisible: !document.querySelector('#vtool .vt-tolwrap').hidden };
  });
  check(pv.w > 0 && pv.corner < 30 && pv.body > 200 && pv.tolVisible, 'Live-Vorschau der Freistellung im Schnitt-Werkzeug', JSON.stringify(pv));
  await page.click('#vtool [data-act=two]');
  await page.click('#vtool [data-act=apply]');
  const cut = await page.evaluate(() => window.__app.persona().avatar.poses.at(-1).clip);
  check(cut && Math.abs(cut.start - 1) < 0.06 && Math.abs(cut.end - 3) < 0.06, 'Video auf 2 Sekunden geschnitten', JSON.stringify(cut));
}
// ---- Abschnitt gleich freigestellt speichern (weißer Hintergrund -> WebM mit Transparenz)
await page.evaluate(() => {
  const p = window.__app.persona().avatar.poses.at(-1);
  p.cutMode = 'flood'; // einfarbige Wand (ohne KI-Download prüfbar)
  p.keyTol = 30;
});
await page.locator('.pose-opts button', { hasText: '✂' }).last().click();
await page.waitForSelector('#vtool video');
await page.waitForFunction(() => document.querySelector('#vtool video').readyState >= 1);
const savedBefore = await page.evaluate(() => window.__saved?.length ?? 0);
const videoBefore = await page.evaluate(() => window.__app.persona().avatar.poses.at(-1).video);
await page.click('#vtool [data-act=bake]');
await page.waitForFunction((v) => window.__app.persona().avatar.poses.at(-1).video !== v, videoBefore, { timeout: 60000 }).catch(() => {});
const baked = await page.evaluate(async (n) => {
  const p = window.__app.persona().avatar.poses.at(-1);
  const v = document.createElement('video');
  v.muted = true;
  v.src = p.video;
  await new Promise((r) => (v.onloadeddata = r));
  await new Promise((r) => { v.onseeked = r; v.currentTime = 0.5; });
  // aufgenommene WebM hat keinen Index – nach dem Springen auf das Bild warten (langsame Rechner)
  for (let i = 0; i < 60 && v.readyState < 2; i++) await new Promise((r) => setTimeout(r, 50));
  if (v.requestVideoFrameCallback) await Promise.race([new Promise((r) => v.requestVideoFrameCallback(r)), new Promise((r) => setTimeout(r, 500))]);
  const c = document.createElement('canvas');
  c.width = v.videoWidth;
  c.height = v.videoHeight;
  const g = c.getContext('2d');
  g.drawImage(v, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  const a = (fx, fy) => d[(Math.round(fy * (c.height - 1)) * c.width + Math.round(fx * (c.width - 1))) * 4 + 3];
  return { cutMode: p.cutMode, clip: p.clip ?? null, wall: a(0.03, 0.03), body: a(0.5, 0.55), file: window.__saved?.slice(n).map((f) => f.name), rs: v.readyState, t: v.currentTime, wh: [c.width, c.height], status: document.querySelector('#status')?.textContent };
}, savedBefore);
check(baked.cutMode === 'alpha' && baked.wall < 30 && baked.body > 200 && !baked.clip, 'Abschnitt als freigestelltes Video gespeichert (Hintergrund durchsichtig)', JSON.stringify(baked));
check(/freigestellt\.webm$/.test(baked.file?.[0] ?? ''), 'Freigestelltes Video auch als Datei gesichert', JSON.stringify(baked.file));
const order = await page.evaluate(() => ({ picked: window.__picked.at(-1)?.t, written: window.__saved.at(-1)?.t }));
check(order.picked && order.written && order.picked < order.written, 'Speicherort wird vor dem Freistellen abgefragt');
// Abbrechen während des Speicherns: Fenster schließt sich, Pose bleibt unverändert
await page.locator('.pose-opts button', { hasText: '✂' }).last().click();
await page.waitForSelector('#vtool video');
await page.waitForFunction(() => document.querySelector('#vtool video').readyState >= 1);
await page.selectOption('#vtool .vt-mode', 'flood');
const poseBefore = await page.evaluate(() => JSON.stringify(window.__app.persona().avatar.poses.at(-1)));
await page.click('#vtool [data-act=bake]');
await page.waitForTimeout(300);
const cancelBtn = await page.evaluate(() => ({ text: document.querySelector('#vtool [data-act=close]').textContent, enabled: !document.querySelector('#vtool [data-act=close]').disabled, bar: !document.querySelector('#vtool .vt-progress').hidden }));
check(cancelBtn.bar, 'Fortschrittsbalken beim Freistellen sichtbar');
await page.click('#vtool [data-act=close]');
await page.waitForTimeout(1500);
const afterCancel = await page.evaluate(() => ({ open: !!document.querySelector('#vtool'), pose: JSON.stringify(window.__app.persona().avatar.poses.at(-1)) }));
check(cancelBtn.enabled && /Abbrechen/.test(cancelBtn.text) && !afterCancel.open && afterCancel.pose === poseBefore, 'Speichern lässt sich abbrechen, Pose bleibt unverändert', JSON.stringify(cancelBtn));
// ---- Google Kalender & Aufgaben: Anmeldung (nachgebildet), dann fragt Claude den Kalender ab
const googleCalls = [];
await page.route('https://oauth2.googleapis.com/token', (route) => {
  const body = route.request().postData() ?? '';
  googleCalls.push({ url: 'token', body });
  const idToken = 'x.' + Buffer.from(JSON.stringify({ email: 'jens.test@gmail.com' })).toString('base64url') + '.y';
  route.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify({ access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600, id_token: idToken }) });
});
await page.route('https://www.googleapis.com/calendar/**', (route) => {
  googleCalls.push({ url: route.request().url(), auth: route.request().headers().authorization });
  route.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify({ items: [{ id: 'e1', summary: 'Zahnarzt', start: { dateTime: '2026-10-17T14:00:00+02:00' }, end: { dateTime: '2026-10-17T15:00:00+02:00' } }] }) });
});
await page.evaluate(() => {
  // Android-Anmeldung nachbilden: Browser „meldet“ sofort mit Code zurück
  window.KIAuth = { listen: () => 54321, open: (url) => setTimeout(() => window.__kiAuthDone('/?code=CODE1&state=' + new URL(url).searchParams.get('state')), 50) };
});
if (!(await page.isVisible('#tabs [data-tab=conn]'))) await page.click('#btnSettings');
await page.click('#tabs [data-tab=conn]');
await page.fill('#gClientId', '123-abc.apps.googleusercontent.com');
await page.fill('#gClientSecret', 'GOCSPX-test');
await page.click('#gConnect');
await page.waitForFunction(() => /Verbunden/.test(document.querySelector('#gInfo').textContent), null, { timeout: 10000 }).catch(() => {});
const gInfo = await page.textContent('#gInfo');
check(/jens\.test@gmail\.com/.test(gInfo) && /code=CODE1/.test(googleCalls[0]?.body ?? '') && /code_verifier=/.test(googleCalls[0]?.body ?? ''), 'Google verbunden (Anmeldung mit PKCE)', gInfo);
const stored = await page.evaluate(async () => JSON.stringify(await window.__keyFile()));
check(stored.includes('RT1'), 'Google-Token gespeichert (im Browser-Test ohne Keystore unverschlüsselt)', '');
await page.click('#closeSettings').catch(() => {});
// Claude: erst Werkzeug „Termine lesen“, dann Antwort mit dem Ergebnis
const sse = (blocks, stop) => [
  { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
  ...blocks,
  { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 3 } },
  { type: 'message_stop' },
];
claudeQueue.push(
  sse([
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'kalender_termine_lesen', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"von":"2026-10-17T00:00","bis":"2026-10-18T00:00"}' } },
    { type: 'content_block_stop', index: 0 },
  ], 'tool_use'),
  sse([
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '[ruhig] Morgen um 14 Uhr hast du den Zahnarzt.' } },
    { type: 'content_block_stop', index: 0 },
  ], 'end_turn'),
);
const nReq = claudeRequests.length;
await page.fill('#input', 'Was steht morgen an?');
await page.keyboard.press('Enter');
await page.waitForFunction(() => /Zahnarzt/.test([...document.querySelectorAll('.msg.assistant')].pop()?.textContent ?? ''), null, { timeout: 15000 }).catch(() => {});
const calReq = googleCalls.find((c) => c.url.includes('/calendar/'));
const firstReq = claudeRequests[nReq];
const secondReq = claudeRequests[nReq + 1];
check(firstReq?.tools?.some((t) => t.name === 'kalender_termine_lesen') && /Google-Kalender/.test(JSON.stringify([firstReq?.system, firstReq?.messages])), 'Claude bekommt Kalender-Werkzeuge und Datum/Uhrzeit', '');
check(calReq?.auth === 'Bearer AT1' && /timeMin=2026-10-1[67]T/.test(decodeURIComponent(calReq.url)), 'Kalender mit Token und Zeitraum abgefragt', calReq?.url?.slice(0, 120));
check(JSON.stringify(secondReq?.messages?.at(-1) ?? '').includes('Zahnarzt'), 'Ergebnis geht als tool_result zurück an Claude');
check(/Zahnarzt/.test(await page.evaluate(() => [...document.querySelectorAll('.msg.assistant')].pop()?.textContent ?? '')), 'Antwort mit Termin im Chat');
// ---- Bild-im-Bild: Fenster in Figurform, Figur füllt es, eigener Hintergrund
await page.click('#closeSettings').catch(() => {});
const pip = await page.evaluate(async () => {
  const calls = [];
  window.KIPip = { ...(window.KIPip ?? {}), setAspect: (w, h) => calls.push(w / h), supported: () => true, setEnabled() {}, enter() {} };
  const av = window.__app.persona().avatar;
  av.poses = [];
  av.vrm = null;
  await window.__app.avatar.setConfig(av);
  window.__app.updatePipShape();
  const a = window.__app.avatar;
  const figAspect = a.visibleAspect();
  window.__app.state.settings.pipBg = 'farbe';
  window.__app.state.settings.pipBgColor = '#ff0000';
  window.__setPip(true);
  await new Promise((r) => setTimeout(r, 400));
  const r = a.rect;
  const cw = a.canvas.clientWidth;
  const ch = a.canvas.clientHeight;
  const px = a.ctx.getImageData(2, 2, 1, 1).data;
  window.__setPip(false);
  return { aspect: calls.at(-1), figAspect, fillsW: r.w / cw, fillsH: r.h / ch, corner: [...px].slice(0, 3) };
});
check(Math.abs(pip.aspect - pip.figAspect) < 0.01, 'Bild-im-Bild-Fenster bekommt die Form der Figur', JSON.stringify(pip));
check(Math.max(pip.fillsW, pip.fillsH) > 0.98, 'Figur füllt das Bild-im-Bild-Fenster aus');
check(pip.corner[0] > 200 && pip.corner[1] < 40, 'Eigene Hintergrundfarbe im Bild-im-Bild');
// Engerer Zuschnitt (sichtbare Figur statt ganzes Bild) und Kamerafahrt auf den Oberkörper
const cam = await page.evaluate(async () => {
  const c = document.createElement('canvas');
  c.width = 400;
  c.height = 400;
  const g = c.getContext('2d');
  g.fillStyle = '#3a6fd0';
  g.fillRect(150, 40, 100, 320); // schmale Figur mit viel leerem Rand
  g.fillStyle = '#f0d0b0';
  g.beginPath();
  g.arc(200, 80, 35, 0, 7);
  g.fill();
  const av = window.__app.persona().avatar;
  Object.assign(av, { image: c.toDataURL('image/png'), original: null, eyes: [{ x: 0.47, y: 0.18, r: 0.02 }, { x: 0.53, y: 0.18, r: 0.02 }], mouth: { x: 0.5, y: 0.25, w: 0.05 }, faceRig: null, bodyRig: null, depth: null });
  const calls = [];
  window.KIPip.setAspect = (w, h) => calls.push(w / h);
  await window.__app.avatar.setConfig(av);
  window.__app.updatePipShape();
  const a = window.__app.avatar;
  window.__app.state.settings.pipCamera = true;
  window.__setPip(true);
  await new Promise((r) => setTimeout(r, 2500));
  const whole = a.rect.h;
  // Antwort kommt -> Kamera fährt heran; danach zurück zur ganzen Figur
  window.__app.setMood('ruhig');
  window.__app.avatarState.speaking = true;
  await new Promise((r) => setTimeout(r, 3000));
  const upper = a.rect.h;
  window.__app.avatarState.speaking = false;
  await new Promise((r) => setTimeout(r, 3500));
  const after = a.rect.h;
  window.__setPip(false);
  return { aspect: calls.at(-1), whole, upper, after };
});
check(cam.aspect < 0.5, 'Bild-im-Bild-Fenster nach der sichtbaren Figur (leere Ränder zählen nicht)', JSON.stringify(cam));
// höchstens bis zur Hüfte (die Test-Figur ist ein Brustbild – also nur wenig näher, nie aufs Gesicht)
check(cam.upper > cam.whole * 1.02 && cam.upper <= cam.whole * 1.52 && Math.abs(cam.after - cam.whole) < cam.whole * 0.08, 'Kamera fährt höchstens auf zwei Drittel der Figur (Oberkörper) und danach zurück', JSON.stringify(cam));
// ---- Persona als .kiavatar exportieren (mit Video) und wieder importieren
const exp = await page.evaluate(async (webmB64) => {
  const av = window.__app.persona().avatar;
  const bytes = Uint8Array.from(atob(webmB64), (c) => c.charCodeAt(0));
  const url = await window.desktop.saveMedia(bytes, 'webm');
  av.poses = [{ id: 'v1', name: 'Nicken', trigger: 'listen', video: url, cutMode: 'alpha', clip: { start: 0.5, end: 2 } }];
  window.__app.persona().memory = [];
  window.__savedBefore = window.__saved.length;
  return { personas: window.__app.state.personas.length, name: window.__app.persona().name, image: av.image.slice(0, 40) };
}, fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'figur-alpha.webm')).toString('base64'));
if (!(await page.isVisible('#tabs [data-tab=persona]'))) await page.click('#btnSettings');
await page.click('#tabs [data-tab=persona]');
await page.click('#personaExport');
await page.waitForFunction(() => window.__saved.length > window.__savedBefore, null, { timeout: 15000 }).catch(() => {});
const file = await page.evaluate(() => window.__saved.at(-1));
check(/\.kiavatar$/.test(file?.name ?? '') && file.b64.length > 2000, 'Persona als .kiavatar exportiert (mit Video)', file?.name);
const packPath = path.join(os.tmpdir(), 'ki-test.kiavatar');
fs.writeFileSync(packPath, Buffer.from(file?.b64 ?? '', 'base64'));
await page.click('#personaImport');
await page.waitForSelector('#pickSheet');
await page.setInputFiles('#pickSheet input[type=file]', packPath);
await page.waitForFunction((n) => window.__app.state.personas.length > n, exp.personas, { timeout: 20000 }).catch(() => {});
const imp = await page.evaluate(() => {
  const p = window.__app.persona();
  return { personas: window.__app.state.personas.length, name: p.name, image: p.avatar.image?.slice(0, 40), pose: p.avatar.poses?.[0] };
});
check(imp.personas === exp.personas + 1 && imp.name.startsWith(exp.name) && imp.image === exp.image, 'Persona importiert (Name, Bild)', JSON.stringify({ name: imp.name }));
check(imp.pose?.video && /^blob:|^http/.test(imp.pose.video) && imp.pose.clip?.start === 0.5 && imp.pose.trigger === 'listen', 'Video-Pose samt Abschnitt und Anlass übernommen', JSON.stringify(imp.pose));
// ---- Handy: Ort für Wetter/Verkehr, Teilen aus anderen Apps, Erinnerungen, Akku-Sparmodus
await page.route('https://www.googleapis.com/calendar/**', (route) => {
  const t = new Date(Date.now() + 2 * 3600e3).toISOString();
  route.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify({ items: [{ id: 'e2', summary: 'Teammeeting', location: 'Büro', start: { dateTime: t }, end: { dateTime: t } }] }) });
});
await page.route('https://tasks.googleapis.com/**', (route) => {
  const due = new Date(Date.now() + 24 * 3600e3).toISOString().slice(0, 10);
  route.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify({ items: [{ id: 'a1', title: 'Angebot schicken', due: `${due}T00:00:00.000Z`, status: 'needsAction' }] }) });
});
const phone = await page.evaluate(async () => {
  const app = window.__app;
  const out = { tab: !!document.querySelector('#tabs [data-tab=phone]') && getComputedStyle(document.querySelector('#tabs [data-tab=phone]')).display !== 'none' };
  app.state.settings.place = 'Hannover-List';
  app.state.place = await app.currentPlace();
  out.prompt = app.buildMessages().filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  app.state.place = '';
  app.state.settings.place = '';
  // Android-Schnittstelle nachbilden
  const events = [];
  const planned = [];
  window.KIDevice = {
    takeIntents: () => JSON.stringify(events.splice(0)),
    setReminders: (j) => planned.push(JSON.parse(j)),
    power: () => JSON.stringify({ level: 8, charging: false, saver: false }),
    notifyAllowed: () => true,
    askNotify() {},
    setBackground() {},
  };
  events.push({ action: 'share', subject: 'Artikel', text: 'https://example.org/bericht', files: [{ name: 'notiz.txt', mime: 'text/plain', data: btoa('Hallo Welt') }] });
  await window.__kiIntent();
  out.input = document.querySelector('#input').value;
  out.chips = [...document.querySelectorAll('#attachments .chip')].map((c) => c.textContent).join(' ');
  app.state.settings.reminders = true;
  await app.syncReminders();
  out.reminders = planned.at(-1);
  app.state.settings.reminders = false;
  app.checkPower();
  out.fps = app.avatar.maxFps;
  app.avatar.maxFps = 0;
  delete window.KIDevice;
  return out;
});
check(phone.tab, 'Reiter „Handy“ in den Einstellungen');
check(/Hannover-List/.test(phone.prompt) && /Jetzt ist/.test(phone.prompt), 'Ort und Uhrzeit gehen mit der Frage mit');
check(/Artikel/.test(phone.input) && /example\.org/.test(phone.input) && /notiz\.txt/.test(phone.chips), 'Geteilter Text und Datei kommen an', JSON.stringify({ input: phone.input, chips: phone.chips }));
const rem = phone.reminders ?? [];
check(
  rem.some((r) => /Teammeeting/.test(r.text) && /Büro/.test(r.text) && Math.abs(r.at - (Date.now() + 2 * 3600e3 - 15 * 60e3)) < 60e3) && rem.some((r) => /Angebot/.test(r.text)),
  'Erinnerungen für Termin (15 min vorher) und Aufgabe geplant',
  JSON.stringify(rem),
);
check(phone.fps === 5, 'Akku-Sparmodus: bei 8 % Akku nur noch 5 Bilder/s', String(phone.fps));
// ---- Firmenwissen: Word, PDF und Text aufnehmen, durchsuchen, passende Abschnitte gehen an Claude
const { Document, Packer, Paragraph } = await import('docx');
const docxB64 = (
  await Packer.toBuffer(
    new Document({ sections: [{ children: [new Paragraph('Allgemeine Geschäftsbedingungen'), new Paragraph('Die Zahlungsfrist beträgt 14 Tage netto ohne Abzug.')] }] }),
  )
).toString('base64');
const pdfB64 = makePdf('Leistungsbeschreibung: Die Ergonomie-Beratung am Arbeitsplatz dauert 90 Minuten.').toString('base64');
const kbRes = await page.evaluate(
  async ({ docxB64, pdfB64 }) => {
    const app = window.__app;
    const b = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const files = [
      new File(['Preisliste 2026\nWartung pro Stunde: 85 Euro netto\nAnfahrt pauschal: 30 Euro'], 'Preisliste.txt', { type: 'text/plain' }),
      new File([b(docxB64)], 'AGB.docx'),
      new File([b(pdfB64)], 'Leistungen.pdf', { type: 'application/pdf' }),
    ];
    const r = await app.addKbFiles(files);
    const top = (q) => app.kbSearch(q)[0]?.doc.name;
    return {
      area: app.area,
      added: r.ok,
      failed: r.failed,
      wartung: top('Was kostet die Wartung pro Stunde?'),
      frist: top('Wie lange ist die Zahlungsfrist?'),
      beratung: top('Wie lange dauert die Ergonomie-Beratung?'),
      none: app.kbSearch('Wie wird das Wetter morgen in Hamburg').length,
    };
  },
  { docxB64, pdfB64 },
);
check(kbRes.area === 'dienstlich' && kbRes.added.length === 3, 'Firmenwissen: Text, Word und PDF aufgenommen', JSON.stringify(kbRes));
check(kbRes.wartung === 'Preisliste.txt' && kbRes.frist === 'AGB.docx' && kbRes.beratung === 'Leistungen.pdf', 'Firmenwissen: Suche findet das passende Dokument', JSON.stringify(kbRes));
check(kbRes.none === 0, 'Firmenwissen: fremde Fragen bekommen keine Auszüge');
// Rest aus dem Teilen-Test entfernen (der Anhang würde sonst mitgehen) und einen kurzen Vorlauf anlegen
await page.evaluate(() => {
  document.querySelectorAll('#attachments .chip button').forEach((b) => b.click());
  window.__app.history().push({ role: 'user', content: 'Guten Morgen' }, { role: 'assistant', content: 'Guten Morgen! Was steht an?' });
});
const kbBefore = claudeRequests.length;
const msgsBefore = await page.evaluate(() => document.querySelectorAll('.msg.assistant').length);
await page.fill('#input', 'Was kostet die Wartung pro Stunde?');
await page.click('#btnSend');
await page
  .waitForFunction((n) => document.querySelectorAll('.msg.assistant').length > n && !document.querySelector('.msg.assistant.typing'), msgsBefore, { timeout: 15000 })
  .catch(() => {});
const chatReq = claudeRequests.slice(kbBefore).find((r) => JSON.stringify(r.messages ?? '').includes('Wartung pro Stunde'));
const sys = JSON.stringify([chatReq?.system, chatReq?.messages]);
check(!!chatReq && /internen Firmendokumenten/.test(sys) && /85 Euro/.test(sys) && !/Zahlungsfrist/.test(sys), 'Nur passende Abschnitte gehen an Claude', sys.slice(-200));
const kbNote = await page.evaluate(() => [...document.querySelectorAll('.msg.assistant')].at(-1)?.textContent ?? '');
check(/Firmenwissen mitgegeben: Preisliste\.txt/.test(kbNote), 'Antwort zeigt, welches Dokument mitgegeben wurde', kbNote.slice(-80));
// Gespeichertes Wissen: Claude bekommt die Werkzeuge und das App-Grundwissen; Speichern/Suchen über das Werkzeug
const toolNames = (chatReq?.tools ?? []).map((t) => t.name);
check(toolNames.includes('wissen_speichern') && toolNames.includes('wissen_suchen') && /Über dich und diese App/.test(sys) && /wissen_speichern/.test(sys), 'Claude kennt die App und kann Wissen speichern (Werkzeuge im Auftrag)', JSON.stringify(toolNames));
// Kosten sparen: Zwischenspeicher-Merkpunkte, wechselnder Zusammenhang an der Frage, Suchgrenze, Datei-Werkzeuge nur bei Bedarf
const lastUser = [...(chatReq?.messages ?? [])].reverse().find((m) => m.role === 'user');
const sysArr = Array.isArray(chatReq?.system) ? chatReq.system : [];
const cacheRes = {
  sysCached: !!sysArr[0]?.cache_control,
  sysStatic: !/Firmendokumenten|Jetzt ist/.test(JSON.stringify(chatReq?.system)),
  ctxAtQuestion: /<kontext>[\s\S]*Firmendokumenten/.test(JSON.stringify(lastUser?.content)),
  histCached: (chatReq?.messages ?? []).some((m) => m.role === 'assistant' && JSON.stringify(m.content).includes('cache_control')),
  searchMax: (chatReq?.tools ?? []).find((t) => t.name === 'web_search')?.max_uses,
  noFiles: !(chatReq?.tools ?? []).some((t) => t.name === 'code_execution'),
};
check(
  cacheRes.sysCached && cacheRes.sysStatic && cacheRes.ctxAtQuestion && cacheRes.histCached && cacheRes.searchMax === 3 && cacheRes.noFiles,
  'Kosten: Zwischenspeicher für Systemtext und Verlauf, Zusammenhang an der Frage, höchstens 3 Suchen, keine Datei-Werkzeuge ohne Bedarf',
  JSON.stringify(cacheRes),
);
const filesWanted = await page.evaluate(() => ({ excel: window.__app.filesNeeded('Mach mir daraus eine Excel-Tabelle', []), plain: window.__app.filesNeeded('Wie wird das Wetter?', []) }));
check(filesWanted.excel && !filesWanted.plain, 'Datei-Werkzeuge nur, wenn nach einer Datei gefragt wird', JSON.stringify(filesWanted));
const savedRes = await page.evaluate(async () => {
  const app = window.__app;
  const r = await app.runAppTool('wissen_speichern', { titel: 'Wallbox-Recherche', inhalt: 'Förderung für die Wallbox: KfW 442 bis 10.200 Euro, Antrag vor dem Kauf stellen. Quelle: kfw.de' });
  const found = await app.runAppTool('wissen_suchen', { suchbegriff: 'Wallbox Förderung' });
  const list = document.querySelectorAll('#savedList .saved-doc').length;
  return { r, found: found.treffer?.[0]?.titel, list };
});
check(savedRes.r.gespeichert && savedRes.found === 'Wallbox-Recherche' && savedRes.list >= 1, 'Gespeichertes Wissen: speichern, finden, in der Liste', JSON.stringify(savedRes));
// Selbstbild: die Figur notiert über sich selbst (Werkzeug), es geht im Systemtext mit; Nachdenken pflegt es
const selfRes = await page.evaluate(async () => {
  const app = window.__app;
  const p = app.persona();
  p.selbst = [
    { id: 'u1', text: 'Ich duze immer.', art: 'vorsatz', quelle: 'nutzer', created: 1 },
    { id: 'a1', text: 'Ich antworte oft zu lang.', art: 'schwaeche', quelle: 'gespraech', created: 2 },
  ];
  const r = await app.runAppTool('selbst_notieren', { eintrag: 'Ich nenne bei Recherchen immer die Quelle.', art: 'vorsatz' });
  const dup = await app.runAppTool('selbst_notieren', { eintrag: 'Ich nenne bei Recherchen immer die  Quelle.' });
  const sys = app.buildMessages().filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const ui = document.getElementById('selfList').textContent.includes('Quelle') || [...document.querySelectorAll('#selfList input')].some((i) => /Quelle/.test(i.value));
  const res = app.applyReflection(p, {
    gedanke: 'Ich war heute zu ausführlich.',
    neu: [{ text: 'Ich fasse mich kürzer.', art: 'vorsatz' }],
    aendern: [{ nr: 1, text: 'Ich sieze jetzt.' }],
    streichen: [2],
  });
  return { ok: r.notiert, dup: dup.notiert, inSys: /Dein Selbstbild/.test(sys) && /Quelle/.test(sys) && /selbst_notieren/.test(sys), ui, texts: p.selbst.map((e) => e.text), added: res.added.length, removed: res.removed, last: p.reflexion.at(-1)?.text };
});
check(selfRes.ok && !selfRes.dup && selfRes.inSys && selfRes.ui, 'Selbstbild: Figur notiert über sich (Werkzeug), keine Doppelten, geht im Systemtext mit', JSON.stringify(selfRes));
check(
  selfRes.texts.includes('Ich duze immer.') && !selfRes.texts.includes('Ich sieze jetzt.') && !selfRes.texts.includes('Ich antworte oft zu lang.') &&
    selfRes.texts.includes('Ich fasse mich kürzer.') && selfRes.last === 'Ich war heute zu ausführlich.',
  'Selbstbild: Nachdenken ergänzt und streicht, Einträge des Nutzers bleiben unangetastet',
  JSON.stringify(selfRes),
);
const reflBefore = claudeRequests.length;
claudeQueue.push([
  { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{"gedanke":"Mir fällt auf, dass ich gern Tabellen nutze.","neu":[{"text":"Ich nutze Tabellen nur, wenn sie wirklich helfen.","art":"vorsatz"}],"aendern":[],"streichen":[]}' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 30 } },
  { type: 'message_stop' },
]);
const reflRes = await page.evaluate(async () => {
  const app = window.__app;
  const h = app.history();
  while (h.length < 4) h.push({ role: 'user', content: 'Mach mal eine Übersicht.' }, { role: 'assistant', content: 'Hier eine Tabelle …' });
  const r = await app.reflect(true);
  const note = [...document.querySelectorAll('.msg.note')].at(-1)?.textContent ?? '';
  return { added: r?.added?.length, thought: r?.thought, note, has: app.persona().selbst.some((e) => /Tabellen nur/.test(e.text) && e.quelle === 'reflexion'), turns: app.persona().reflectTurns };
});
const reflReq = claudeRequests.slice(reflBefore).find((r) => JSON.stringify(r.system ?? '').includes('Denk ehrlich über dich nach'));
check(
  !!reflReq && /Letzte Gespräche/.test(JSON.stringify(reflReq.messages)) && reflRes.added === 1 && reflRes.has && /🪞/.test(reflRes.note) && reflRes.turns === 0,
  'Selbstbild: „Jetzt nachdenken“ – Figur denkt über die letzten Gespräche nach und ergänzt ihr Selbstbild',
  JSON.stringify(reflRes),
);

// ---- Automatischer Abgleich: Zusammenführen (auf beiden Geräten gleich) und der ganze Ablauf am Handy
const sync = await import('../src/abgleich.js');
{
  const pc = {
    personas: [{ id: 'pcmax', name: 'Max', prompt: 'PC-Text', updated: 10, memory: [{ id: 'm1', text: 'Jens mag Kaffee.', created: 1 }], selbst: [] }],
    history: { pcmax: [{ id: 'a', role: 'user', content: 'PC-Frage', t: 100 }] },
    saved: [{ id: 'w1', title: 'Wallbox', text: 'alt', created: 1 }],
    deleted: {},
  };
  const ph = {
    personas: [{ id: 'aamax', name: 'max', prompt: 'Handy-Text', updated: 20, memory: [{ id: 'm2', text: 'Jens fährt Rad.', created: 2 }, { id: 'm3', text: 'jens mag kaffee', created: 3 }], selbst: [] }],
    history: { aamax: [{ id: 'b', role: 'user', content: 'Handy-Frage', t: 50 }] },
    saved: [{ id: 'w2', title: 'Wallbox', text: 'neu', created: 1, updated: 5 }],
    deleted: {},
  };
  const canon = (m) => JSON.stringify({ p: m.personas.map(({ reflectTurns: _t, avatarStamp: _s, ...x }) => Object.fromEntries(Object.entries(x).sort())), h: m.history, w: m.saved.map((e) => e.text) });
  const m1 = sync.mergeSync(pc, ph);
  const m2 = sync.mergeSync(ph, pc);
  const del = sync.mergeSync(pc, { ...ph, deleted: { a: 5, m1: 5 } });
  const d = { base: ['x', 'y'], deleted: {} };
  sync.noteDeletions({ personas: [{ id: 'x' }] }, d, 1000);
  const res = {
    id: m1.personas[0].id,
    rename: m1.rename,
    prompt: m1.personas[0].prompt,
    mem: m1.personas[0].memory.map((e) => e.text),
    hist: m1.history.aamax?.map((x) => x.id),
    saved: m1.saved.map((e) => e.text),
    same: canon(m1) === canon(m2),
    delHist: del.history.aamax?.map((x) => x.id),
    delMem: del.personas[0].memory.map((e) => e.id),
    tomb: Object.keys(d.deleted),
  };
  check(
    res.id === 'aamax' && res.rename.pcmax === 'aamax' && res.prompt === 'Handy-Text' && res.mem.length === 2 && res.hist.join() === 'b,a' && res.saved.join() === 'neu' && res.same,
    'Abgleich: gleiche Persona wird erkannt (Name), neuerer Text gewinnt, Gedächtnis ohne Doppelte, Verlauf nach Zeit, Wissen neuerer Stand – auf beiden Geräten gleich',
    JSON.stringify(res),
  );
  check(res.delHist.join() === 'b' && !res.delMem.includes('m1') && res.tomb.join() === 'y', 'Abgleich: Gelöschtes bleibt gelöscht (kommt nicht vom anderen Gerät zurück)', JSON.stringify(res));
}
const syncArea = await page.evaluate(() => window.__app.area);
const syncActive = await page.evaluate(() => window.__app.persona().id);
const pcHits = [];
let pcFigure = null;
let pcStand = null;
await page.route('http://pc.test:47820/**', async (route) => {
  const req = route.request();
  const u = new URL(req.url());
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'x-ki-token, x-ki-code, content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  pcHits.push({ path: u.pathname, token: req.headers()['x-ki-token'] });
  const json = (x) => route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(x) });
  if (u.pathname === "/info") return json({ name: "PC", area: syncArea, urls: ['http://pc.test:47820'] });
  if (u.pathname === '/abgleich') {
    const stand = JSON.parse(req.postData()).stand;
    if (!pcStand) {
      pcStand = structuredClone(stand);
      // der PC hat inzwischen eigenes: eine Erinnerung, eine Antwort und eine neue Persona mit Figur
      const p = stand.personas.find((x) => x.id === syncActive) ?? stand.personas[0];
      p.memory.push({ id: 'pcmem', text: 'Vom PC gelernt: Jens fährt ein E-Auto.', created: Date.now() });
      p.avatarStamp = -1; // Figur des Handys ist neuer -> Handy schickt sie
      stand.history[p.id].push({ id: 'pcmsg', role: 'assistant', content: 'Antwort vom PC', t: Date.now() + 1 });
      stand.personas.push({ id: 'pcneu', name: 'Büro-Lina', prompt: 'Du bist Lina.', language: 'de', style: 'gespraech', avatarStamp: 5, memory: [], selbst: [] });
      stand.history.pcneu = [{ id: 'pcl1', role: 'user', content: 'Hallo Lina', t: 5 }];
    }
    return json({ area: syncArea, stand, urls: ['http://pc.test:47820'] });
  }
  if (u.pathname === '/figur') {
    pcFigure = req.postDataBuffer();
    return json({ ok: true });
  }
  if (u.pathname === '/persona' && pcFigure) return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/zip' }, body: pcFigure });
  return route.fulfill({ status: 404, headers: cors });
});
const syncRes = await page.evaluate(async () => {
  const app = window.__app;
  app.state.busy = false;
  app.pairWith(['http://unerreichbar.test:1', 'http://pc.test:47820'], 'a'.repeat(36));
  for (let i = 0; i < 100 && !app.state.abgleich.last; i++) await new Promise((r) => setTimeout(r, 100));
  const p = app.persona();
  const lina = app.state.personas.find((x) => x.name === 'Büro-Lina');
  return {
    last: !!app.state.abgleich.last,
    err: app.state.settings.syncPair?.error,
    urls: app.state.settings.syncPair?.urls,
    mem: p.memory.some((m) => /E-Auto/.test(m.text)),
    chat: document.getElementById('chat').textContent.includes('Antwort vom PC'),
    lina: !!lina,
    linaFig: lina?.avatarStamp,
    linaHist: app.state.history[lina?.id]?.length,
    state: document.getElementById('syncAutoState').textContent,
  };
});
check(
  syncRes.last && !syncRes.err && syncRes.mem && syncRes.chat && syncRes.lina && syncRes.linaFig === 5 && syncRes.linaHist === 1 && /Gekoppelt/.test(syncRes.state),
  'Abgleich am Handy: gekoppelt per QR-Inhalt, PC gefunden (zweite Adresse), Erinnerung, Antwort und neue Persona samt Figur vom PC übernommen',
  JSON.stringify(syncRes),
);
check(
  pcHits.length > 0 && pcHits.every((h) => h.token === 'a'.repeat(36)) && !!pcFigure && pcStand?.personas?.length >= 1 && Object.values(pcStand.history ?? {}).some((h) => h.length > 0),
  'Abgleich am Handy: Stand mit Verlauf und geänderte Figur gehen an den PC (nur mit Kopplungsschlüssel)',
  JSON.stringify({ hits: pcHits.map((h) => h.path), figur: pcFigure?.length }),
);
// Löschen am Handy: geht beim nächsten Abgleich als „gelöscht“ an den PC
const delRes = await page.evaluate(async () => {
  const app = window.__app;
  const p = app.persona();
  const gone = p.memory.find((m) => /E-Auto/.test(m.text));
  p.memory.splice(p.memory.indexOf(gone), 1);
  await app.autoSync({ manual: true });
  return { id: gone.id, back: app.persona().memory.some((m) => m.id === gone.id) };
});
const lastStand = await page.evaluate(() => window.__app.syncSnapshot());
check(!delRes.back && !!lastStand.deleted?.[delRes.id], 'Abgleich: am Handy Gelöschtes wird als gelöscht weitergegeben und kommt nicht zurück', JSON.stringify(delRes));
const svBefore = claudeRequests.length;
const svMsgs = await page.evaluate(() => document.querySelectorAll('.msg.assistant').length);
await page.fill('#input', 'Wie war das nochmal mit der Förderung für die Wallbox?');
await page.click('#btnSend');
await page
  .waitForFunction((n) => document.querySelectorAll('.msg.assistant').length > n && !document.querySelector('.msg.assistant.typing'), svMsgs, { timeout: 15000 })
  .catch(() => {});
const svReq = claudeRequests.slice(svBefore).find((r) => JSON.stringify(r.messages ?? '').includes('Wallbox'));
const svAll = JSON.stringify([svReq?.system, svReq?.messages]);
check(/gespeicherten Wissen/.test(svAll) && /KfW 442/.test(svAll), 'Gespeichertes Wissen geht bei passender Frage automatisch mit', svAll.slice(-160));
// Bereich Privat: eigene Daten, kein Firmenwissen – Claude-/OpenAI-Schlüssel kommen beim Wechsel mit
const keysBefore = await page.evaluate(async () => {
  const k = (await window.__keyFile()) ?? {};
  await window.__shareKeys('privat');
  return { anthropic: !!k.anthropic, openai: !!k.openai };
});
await page.evaluate(() => localStorage.setItem('ki-bereich', 'privat'));
await page.reload();
await page.waitForFunction(() => window.__app);
const priv = await page.evaluate(async () => ({
  area: window.__app.area,
  cls: document.documentElement.classList.contains('area-privat'),
  kb: await window.desktop.kbLoad(),
  history: Object.values(window.__app.state.history ?? {}).flat().length,
  keys: await window.desktop.keyStatus(),
}));
check(
  (!keysBefore.anthropic || priv.keys.anthropic) && (!keysBefore.openai || priv.keys.openai) && (keysBefore.anthropic || keysBefore.openai),
  'Bereichswechsel: Claude-/OpenAI-Schlüssel kommen mit (einmal eingeben reicht)',
  JSON.stringify({ before: keysBefore, privat: priv.keys }),
);
check(priv.area === 'privat' && priv.cls && priv.kb === null && priv.history === 0, 'Bereich Privat: getrennte Daten, kein Firmenwissen', JSON.stringify(priv));
// Bereichswechsel nimmt Personas mit (Avatar usw.), Gedächtnis bleibt je Bereich
const carry = await page.evaluate(async () => {
  const mine = [
    { id: 'a', name: 'Max', avatar: { image: 'neu.png', poses: [{ id: 'p1' }] }, voice: 'thorsten', memory: ['dienstlich-geheim'] },
    { id: 'b', name: 'Lisa', avatar: { image: 'lisa.png' }, memory: ['x'] },
  ];
  const other = { personas: [{ id: 'z', name: 'Max', avatar: { image: 'alt.png' }, memory: ['privat-merk'] }, { id: 'c', name: 'Nur privat', memory: [] }] };
  const r = window.__app.carryPersonas(mine, 'a', other);
  const max = r.personas.find((p) => p.name === 'Max');
  const lisa = r.personas.find((p) => p.name === 'Lisa');
  // Handy: Zielbereich wird wirklich geschrieben und lässt sich lesen
  const back = await window.desktop.areaLoad?.('privat');
  return {
    n: r.personas.length,
    maxImg: max.avatar.image,
    maxPoses: max.avatar.poses.length,
    maxMem: max.memory,
    maxId: max.id,
    active: r.activeId,
    lisaMem: lisa.memory,
    keepOnly: r.personas.some((p) => p.name === 'Nur privat'),
    loadOk: back === null || Array.isArray(back?.personas),
  };
});
check(
  carry.n === 3 && carry.maxImg === 'neu.png' && carry.maxPoses === 1 && carry.maxMem[0] === 'privat-merk' && carry.maxId === 'z' && carry.active === 'z' &&
    carry.lisaMem.length === 0 && carry.keepOnly && carry.loadOk,
  'Bereichswechsel: Personas samt Avatar kommen mit, Gedächtnis bleibt je Bereich',
  JSON.stringify(carry),
);
// Privat-Funktionen: Notiz per „Merk dir“, Fehlerprotokoll ohne Schlüssel, Fahrmodus
const privF = await page.evaluate(async () => {
  const app = window.__app;
  await window.desktop.setKey('anthropic', 'sk-ant-geheim-1234567890');
  document.querySelector('#input').value = 'Merk dir: Reifen wechseln bis Samstag';
  document.querySelector('#btnSend').click();
  await new Promise((r) => setTimeout(r, 600));
  const notes = app.state.settings.notes ?? [];
  const sat = new Date(`${notes[0]?.due}T12:00`).getDay();
  window.KIDevice = { appLog: () => 'Bearer abcdef sk-ant-geheim-1234567890 test@example.com', deviceInfo: () => '{"modell":"Test"}', power: () => '{}' };
  const savedName = [];
  const orig = window.desktop.saveFileAs;
  window.desktop.saveFileAs = async (name) => (savedName.push(name), { ok: true });
  const log = await app.saveBugReport();
  window.desktop.saveFileAs = orig;
  delete window.KIDevice;
  app.setDrive(true);
  const drive = { full: document.documentElement.classList.contains('stage-full'), live: app.state.settings.handsFree, prompt: /Fahrmodus/.test(app.buildMessages().filter((m) => m.role === 'system').map((m) => m.content).join('\n')) };
  app.setDrive(false);
  await window.desktop.setKey('anthropic', '');
  return {
    wrap: !document.querySelector('#privWrap').hidden,
    note: notes[0]?.text, sat, bubble: [...document.querySelectorAll('.msg.assistant')].at(-1)?.textContent,
    logOk: /Fehlerprotokoll/.test(log) && !/geheim|abcdef|test@example/.test(log), file: savedName[0],
    drive, after: { full: document.documentElement.classList.contains('stage-full'), live: app.state.settings.handsFree },
  };
});
check(privF.wrap, 'Privat: Notizen, Fahrmodus und Fehlerprotokoll sichtbar');
check(privF.note === 'Reifen wechseln' && privF.sat === 6 && /Notiert/.test(privF.bubble ?? ''), '„Merk dir … bis Samstag“ wird als Notiz mit Fälligkeit gespeichert', JSON.stringify(privF));
check(privF.logOk && /fehlerprotokoll/.test(privF.file ?? ''), 'Fehlerprotokoll gespeichert, ohne Schlüssel/Token/E-Mail');
const wake = await page.evaluate(() => {
  const app = window.__app;
  const a = app.matchWake('Hey Macks, wie wird das Wetter morgen?', 'Max');
  const b = app.matchWake('Wie wird das Wetter morgen?', 'Max');
  const c = app.matchWake('Hallo Lina.', 'Hey Lina');
  app.state.settings.notifyOn = true;
  app.state.settings.speak = false;
  app.readNotification({ app: 'com.whatsapp', title: 'Anna', text: 'Bin um 7 da' });
  return { a, b, c, st: document.querySelector('#status').textContent };
});
check(wake.a?.rest === 'wie wird das wetter morgen' && wake.b === null && wake.c?.rest === '', 'Aktivierungswort (frei wählbar, ähnlich klingend) erkannt, Frage danach übernommen', JSON.stringify(wake));
check(/Anna.*WhatsApp.*Bin um 7 da/.test(wake.st), 'Nachricht wird angesagt', wake.st);
// Abgleich mit dem PC im WLAN (PC nachgebildet): verbinden, Persona holen, Persona senden

const received = [];
const pcWissen = [{ title: 'Vom PC: Wallbox-Angebote', text: 'Drei Angebote verglichen: A 1.290 €, B 1.450 €, C 1.180 € (inkl. Montage).', created: Date.now() - 5000 }];
let wissenIn = null;
let pcArea = 'privat';
const pcPack = Buffer.from(file?.b64 ?? '', 'base64');
const pc = http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'x-ki-code, content-type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
  if (req.headers['x-ki-code'] !== '123456') return res.writeHead(403, cors).end();
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/info') return res.writeHead(200, cors).end(JSON.stringify({ name: 'KI-Assistent Cloud Beta', area: pcArea }));
  if (u.pathname === '/wissen' && req.method === 'GET') return res.writeHead(200, cors).end(JSON.stringify(pcWissen));
  if (u.pathname === '/wissen' && req.method === 'POST') {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => {
      wissenIn = JSON.parse(Buffer.concat(parts).toString('utf8'));
      res.writeHead(200, cors).end(JSON.stringify({ neu: wissenIn.length, aktualisiert: 0, gleich: 0 }));
    });
    return;
  }
  if (u.pathname === '/personas') return res.writeHead(200, cors).end(JSON.stringify([{ id: 'p1', name: 'Vom PC', poses: 1, quick: 2 }]));
  if (u.pathname === '/persona' && req.method === 'GET') return res.writeHead(200, cors).end(pcPack);
  if (u.pathname === '/persona' && req.method === 'POST') {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => {
      received.push(Buffer.concat(parts).length);
      res.writeHead(200, cors).end(JSON.stringify({ name: 'Max (am PC)' }));
    });
    return;
  }
  res.writeHead(404, cors).end();
});
await new Promise((r) => pc.listen(0, '127.0.0.1', r));
const pcUrl = `127.0.0.1:${pc.address().port}`;
const before2 = await page.evaluate(() => window.__app.state.personas.length);
await page.evaluate(({ pcUrl }) => {
  // wie aus dem QR-Code: zuerst eine nicht erreichbare Adresse (z. B. WSL-Adapter), dann die richtige
  document.querySelector('#syncAddr').value = `127.0.0.1:1,${pcUrl}`;
  document.querySelector('#syncCode').value = '123456';
  document.querySelector('#syncConnect').click();
}, { pcUrl });
await page.waitForFunction(() => document.querySelectorAll('#syncList button').length > 0, null, { timeout: 10000 }).catch(() => {});
const chosenAddr = await page.evaluate(() => document.querySelector('#syncAddr').value);
check(chosenAddr === pcUrl, 'Abgleich: mehrere Adressen – die erreichbare wird genommen', chosenAddr);
await page.evaluate(() => document.querySelector('#syncList button')?.click());
await page.waitForFunction((n) => window.__app.state.personas.length > n, before2, { timeout: 20000 }).catch(() => {});
await page.evaluate(() => document.querySelector('#syncSend')?.click());
await page.waitForTimeout(3000);
const after2 = await page.evaluate(() => window.__app.state.personas.length);
// gespeichertes Wissen holen und senden (Handy und PC im gleichen Bereich)
const knowRes = await page.evaluate(async () => {
  await window.__app.runAppTool('wissen_speichern', { titel: 'Vom Handy: Notiz', inhalt: 'Reifen beim Händler am Montag abholen, Auftrag 4711.' });
  const before = window.__app.state.saved.length;
  document.querySelector('#syncKnowGet').click();
  await new Promise((r) => setTimeout(r, 800));
  const got = window.__app.state.saved.some((e) => e.title === 'Vom PC: Wallbox-Angebote');
  document.querySelector('#syncKnowGet').click(); // zweimal holen: nichts doppelt
  await new Promise((r) => setTimeout(r, 800));
  const twice = window.__app.state.saved.filter((e) => e.title === 'Vom PC: Wallbox-Angebote').length;
  document.querySelector('#syncKnowSend').click();
  await new Promise((r) => setTimeout(r, 800));
  return { before, got, twice, visible: !document.querySelector('#syncKnow').hidden };
});
check(knowRes.got && knowRes.twice === 1 && knowRes.visible && Array.isArray(wissenIn) && wissenIn.some((e) => e.title === 'Vom Handy: Notiz'), 'Abgleich: gespeichertes Wissen vom PC geholt (ohne Doppelte) und an den PC gesendet', JSON.stringify({ ...knowRes, sent: wissenIn?.length }));
// PC in einem anderen Bereich: kein Abgleich (dienstlich und privat bleiben getrennt)
pcArea = 'dienstlich';
const mismatch = await page.evaluate(async () => {
  document.querySelector('#syncConnect').click();
  await new Promise((r) => setTimeout(r, 1200));
  return document.querySelector('#status').textContent;
});
check(/denselben Bereich/.test(mismatch), 'Abgleich: PC im anderen Bereich wird abgelehnt', mismatch);
pc.close();
check(after2 === before2 + 1, 'Abgleich: Persona vom PC übers WLAN geholt', `${before2} → ${after2}`);
check(received[0] > 1000, 'Abgleich: Persona an den PC gesendet', JSON.stringify(received));
// Echtzeit-Gespräch: WebRTC gegen eine nachgebildete Gegenstelle (statt OpenAI) – Ton, Mitschrift, Lippen
const rtRes = await page.evaluate(async () => {
  const app = window.__app;
  const tone = () => {
    const ctx = new AudioContext();
    const d = ctx.createMediaStreamDestination();
    const o = ctx.createOscillator();
    o.frequency.value = 220;
    o.connect(d);
    o.start();
    return d.stream;
  };
  const origGum = navigator.mediaDevices.getUserMedia;
  navigator.mediaDevices.getUserMedia = async () => tone();
  window.desktop.realtimeConnect = async ({ offerSdp, instructions, voice }) => {
    window.__rt = { instructions, voice };
    const pc2 = new RTCPeerConnection();
    const s = tone();
    s.getTracks().forEach((t) => pc2.addTrack(t, s));
    pc2.ondatachannel = (e) => {
      const dc = e.channel;
      dc.onopen = () => {
        const send = (o) => dc.send(JSON.stringify(o));
        send({ type: 'input_audio_buffer.speech_started' });
        send({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Wie spät ist es?' });
        send({ type: 'response.output_audio_transcript.delta', delta: 'Es ist ' });
        send({ type: 'response.output_audio_transcript.delta', delta: 'gleich drei.' });
        send({ type: 'response.output_audio_transcript.done' });
      };
    };
    await pc2.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    await pc2.setLocalDescription(await pc2.createAnswer());
    await new Promise((r) => {
      if (pc2.iceGatheringState === 'complete') return r();
      pc2.onicegatheringstatechange = () => pc2.iceGatheringState === 'complete' && r();
      setTimeout(r, 3000);
    });
    window.__pc2 = pc2;
    return pc2.localDescription.sdp;
  };
  await app.startRealtime();
  let maxLevel = 0;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 100));
    maxLevel = Math.max(maxLevel, app.avatarState.level);
  }
  const msgs = [...document.querySelectorAll('.msg')].slice(-2).map((m) => m.textContent.trim());
  const active = app.rtActive();
  app.stopRealtime();
  navigator.mediaDevices.getUserMedia = origGum;
  window.__pc2?.close();
  return { active, after: app.rtActive(), msgs, maxLevel, noMood: !/Stimmungsmarke|\[freudig\]/.test(window.__rt?.instructions ?? ''), voice: window.__rt?.voice };
});
check(rtRes.active && !rtRes.after, 'Echtzeit-Gespräch verbindet (WebRTC) und lässt sich beenden', JSON.stringify(rtRes));
check(/Wie spät ist es/.test(rtRes.msgs[0] ?? '') && /Es ist gleich drei/.test(rtRes.msgs[1] ?? ''), 'Echtzeit: Mitschrift von Frage und Antwort im Chat', JSON.stringify(rtRes.msgs));
check(rtRes.maxLevel > 0.05, 'Echtzeit: Lippen bewegen sich mit der Antwortstimme', String(rtRes.maxLevel));
check(rtRes.noMood && rtRes.voice === 'marin', 'Echtzeit: Persona-Anweisungen ohne Stimmungsmarken, Stimme gewählt');
check(privF.drive.full && privF.drive.live && privF.drive.prompt && !privF.after.full && !privF.after.live, 'Fahrmodus: Nur-Figur, Live, kurze Antworten – und wieder aus', JSON.stringify(privF.drive));
await page.evaluate(() => localStorage.setItem('ki-bereich', 'dienstlich'));
await page.reload();
await page.waitForFunction(() => window.__app);
const back = await page.evaluate(() => ({ area: window.__app.area, history: Object.values(window.__app.state.history ?? {}).flat().length }));
check(back.area === 'dienstlich' && back.history > 0, 'Zurück in Dienstlich: alles wieder da', JSON.stringify(back));
// Dienstlich: Aktivierungswort und WLAN-Abgleich sind da, die Privat-Extras nicht
const dienst = await page.evaluate(() => {
  document.getElementById('btnSettings').click();
  document.querySelector('[data-tab=phone]').click();
  const vis = (id) => !!document.getElementById(id)?.offsetParent;
  const out = { wake: vis('privWakeOn'), sync: vis('syncConnect'), notes: vis('privNotes') };
  document.getElementById('btnCloseDrawer')?.click();
  return out;
});
check(dienst.wake && dienst.sync && !dienst.notes, 'Dienstlich: Aktivierungswort und WLAN-Abgleich verfügbar (Privat-Extras nicht)', JSON.stringify(dienst));
// Wissen per Datei: Export (Datei wird gesichert) und Import (zusammenführen)
// „Speichern unter“ der Android-App nachbilden (nach dem Neuladen ist die frühere Nachbildung weg)
await page.evaluate(() => {
  window.__saved = [];
  window.KIFiles = { saveAs: (id, name, b64) => { window.__saved.push({ name, b64 }); setTimeout(() => window.__kiSaveDone(id, true, 'content://test'), 50); } };
});
const expBefore = 0;
await page.evaluate(() => window.__app.runAppTool('wissen_speichern', { titel: 'Export-Test', inhalt: 'Ein Eintrag, der in die Exportdatei gehört.' }));
await page.evaluate(() => document.getElementById('savedExport').click());
await page.waitForTimeout(500);
const expFiles = await page.evaluate((n) => (window.__saved ?? []).slice(n).map((f) => f.name), expBefore);
await page.setInputFiles('#savedImportFile', {
  name: 'Wissen.kiwissen',
  mimeType: 'application/json',
  buffer: Buffer.from(JSON.stringify({ typ: 'ki-wissen', version: 1, bereich: 'dienstlich', eintraege: [{ title: 'Aus Datei', text: 'Importierter Inhalt mit genug Text.', created: 1 }] })),
});
await page.waitForTimeout(500);
const impOk = await page.evaluate(() => window.__app.state.saved.some((e) => e.title === 'Aus Datei'));
check(expFiles.some((n) => /kiwissen$/.test(n)) && impOk, 'Wissen als Datei exportiert und wieder importiert', JSON.stringify({ expFiles, impOk }));
// ---- Schnellbefehle: Beispiele einfügen, Knopf über dem Eingabefeld nimmt den Text mit
if (!(await page.isVisible('#tabs [data-tab=buero]'))) await page.click('#btnSettings');
await page.click('#tabs [data-tab=buero]');
await page.click('#offQuickExamples');
await page.click('#btnCloseDrawer');
const chips = await page.evaluate(() => [...document.querySelectorAll('#quickBar .chip')].map((b) => b.textContent));
check(chips.includes('Angebot formulieren') && chips.length >= 4, 'Schnellbefehle über dem Eingabefeld', JSON.stringify(chips));
const qBefore = claudeRequests.length;
await page.fill('#input', 'Wartung 2 Std., Anfahrt Hannover');
await page.click('#quickBar .chip >> text=Angebot formulieren');
await page.waitForTimeout(1500);
const qReq = claudeRequests.slice(qBefore).find((r) => JSON.stringify(r.messages ?? '').includes('Formuliere aus diesen Angaben'));
check(!!qReq && JSON.stringify(qReq.messages).includes('Wartung 2 Std.'), 'Schnellbefehl schickt Anweisung samt Text');
await page.waitForFunction(() => !window.__app.state.busy, null, { timeout: 10000 }).catch(() => {});
// ---- Nur-Figur-Ansicht: Umschalter blendet alles außer Figur und Mikrofon aus, ✕ springt zurück
const full = await page.evaluate(async () => {
  document.querySelector('#btnStageFull').click();
  await new Promise((r) => setTimeout(r, 300));
  const vis = (sel) => !!document.querySelector(sel).offsetParent || getComputedStyle(document.querySelector(sel)).position === 'fixed';
  const on = { chat: vis('#chat'), composer: vis('.composer'), mic: vis('#fullMic'), stageH: document.querySelector('#stage').getBoundingClientRect().height, winH: innerHeight };
  document.querySelector('#fullExit').click();
  await new Promise((r) => setTimeout(r, 300));
  return { on, back: { chat: vis('#chat'), composer: vis('.composer'), mic: vis('#fullMic') } };
});
check(!full.on.chat && !full.on.composer && full.on.mic && full.on.stageH > full.on.winH * 0.9, 'Nur-Figur-Ansicht: nur Figur und Mikrofon', JSON.stringify(full.on));
check(full.back.chat && full.back.composer && !full.back.mic, 'Nur-Figur-Ansicht: ✕ springt zur ganzen App zurück', JSON.stringify(full.back));
// Handy: ⛶ lässt die Figur frei über anderen Apps schweben (mit Erlaubnis), sonst Nur-Figur-Ansicht in der App
const freeRes = await page.evaluate(async () => {
  const keep = window.KIFloat;
  let freed = 0;
  window.KIFloat = { ...(keep ?? {}), supported: () => true, allowed: () => true, free: () => (freed++, true) };
  document.querySelector('#btnStageFull').click();
  await new Promise((r) => setTimeout(r, 200));
  const inApp = document.documentElement.classList.contains('stage-full');
  window.KIFloat = keep;
  return { freed, inApp };
});
check(freeRes.freed === 1 && !freeRes.inApp, 'Handy: ⛶ startet die frei schwebende Figur (statt schwarzer Vollbild-Ansicht)', JSON.stringify(freeRes));
// Nur-Figur-Ansicht: Figur mit Rand; zwei Finger verkleinern (Kamera schaltet auf Hand um), Lage wird gemerkt
const fullZoom = await page.evaluate(async () => {
  const a = window.__app.avatar;
  const normal = { ...a.layout };
  document.querySelector('#btnStageFull').click();
  await new Promise((r) => setTimeout(r, 1200));
  const camBefore = a.pipFit;
  const r0 = { ...a.rect };
  const c = a.canvas.getBoundingClientRect();
  // Rand um die sichtbare Figur (durchsichtige Bildränder zählen nicht)
  const vb = a.visibleBox();
  const fx0 = r0.x + vb.x0 * r0.w;
  const fx1 = r0.x + vb.x1 * r0.w;
  const fy0 = r0.y + vb.y0 * r0.h;
  const fy1 = r0.y + vb.y1 * r0.h;
  const margin = { left: fx0, top: fy0, right: c.width - fx1, bottom: c.height - fy1 };
  const cx = c.left + r0.x + r0.w / 2;
  const cy = c.top + r0.y + r0.h / 2;
  const ev = (type, id, x, y) => a.canvas.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button: 0, pointerId: id, bubbles: true, pointerType: 'touch' }));
  ev('pointerdown', 31, cx - 100, cy);
  await new Promise((r) => setTimeout(r, 40));
  ev('pointerdown', 32, cx + 100, cy);
  for (let i = 1; i <= 5; i++) {
    ev('pointermove', 31, cx - 100 + i * 10, cy);
    ev('pointermove', 32, cx + 100 - i * 10, cy);
  }
  ev('pointerup', 31, cx - 50, cy);
  ev('pointerup', 32, cx + 50, cy);
  await new Promise((r) => setTimeout(r, 300));
  const r1 = { ...a.rect };
  const saved = window.__app.persona().avatar.fullStage;
  document.querySelector('#fullExit').click();
  await new Promise((r) => setTimeout(r, 300));
  const restored = Math.abs(a.layout.scale - normal.scale) < 1e-6 && !a.pipFit;
  // erneut öffnen: eigene Lage statt Kamera
  document.querySelector('#btnStageFull').click();
  await new Promise((r) => setTimeout(r, 300));
  const reopen = { cam: a.pipFit, scale: a.layout.scale };
  document.querySelector('#fullExit').click();
  await new Promise((r) => setTimeout(r, 200));
  return { camBefore, margin, h0: r0.h, h1: r1.h, saved: !!saved, restored, reopen, savedScale: saved?.scale };
});
const minMargin = Math.min(fullZoom.margin.left, fullZoom.margin.top, fullZoom.margin.right, fullZoom.margin.bottom);
check(
  fullZoom.camBefore && minMargin > 4 && fullZoom.h1 < fullZoom.h0 * 0.7 && fullZoom.saved && fullZoom.restored && !fullZoom.reopen.cam && Math.abs(fullZoom.reopen.scale - fullZoom.savedScale) < 1e-6,
  'Nur-Figur-Ansicht: Rand um die Figur, zwei Finger verkleinern, eigene Lage wird gemerkt',
  JSON.stringify(fullZoom),
);
// ---- Sprechblase, wenn der Ton aus ist
const bub = await page.evaluate(async () => {
  window.__app.state.settings.bubble = 'stumm';
  window.__app.showBubble('Das ist ein Test der Sprechblase.');
  const b = document.querySelector('#speechBubble');
  return { shown: !b.hidden, text: b.textContent };
});
check(bub.shown && /Sprechblase/.test(bub.text), 'Sprechblase neben der Figur', JSON.stringify(bub));
// ---- Beta: schwebende Figur – nur die Figur, Hintergrund durchsichtig
const fl = await page.evaluate(async () => {
  window.__setFloat(true);
  await new Promise((r) => setTimeout(r, 800));
  const c = document.querySelector('#avatar');
  const px = c.getContext('2d').getImageData(1, 1, 1, 1).data;
  const out = { corner: px[3], body: getComputedStyle(document.body).backgroundColor, chat: getComputedStyle(document.querySelector('#chat')).display };
  window.__setFloat(false);
  return out;
});
check(fl.corner === 0 && /rgba\(0, 0, 0, 0\)|transparent/.test(fl.body) && fl.chat === 'none', 'Schwebende Figur: nur Figur, Hintergrund durchsichtig', JSON.stringify(fl));
check(!errors.length, 'keine Skriptfehler', errors.join(' | '));
await browser.close();
server.close();
