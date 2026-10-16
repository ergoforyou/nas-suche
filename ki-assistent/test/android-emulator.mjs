// Prüft die fertige Android-App in einem echten Emulator: installieren, starten und über die
// WebView-Fehlersuche (Chrome DevTools-Protokoll) nachsehen, ob die Oberfläche vollständig läuft.
// Fehler, die nur in der Android-WebView auftreten (z. B. fehlende Systemstimmen), fallen so vor dem Ausliefern auf.
// Aufruf: node test/android-emulator.mjs <app.apk>
import { execFileSync } from 'node:child_process';

import fs from 'node:fs';

// Beta-Linie (kanal.json): eigene App-ID
const kanal = new URL('../kanal.json', import.meta.url);
const BETA = fs.existsSync(kanal) && JSON.parse(fs.readFileSync(kanal, 'utf8')).kanal === 'beta';
const APP = BETA ? 'de.ergoforyou.kiassistent.beta' : 'de.ergoforyou.kiassistent';
const ACT = `${APP}/de.ergoforyou.kiassistent.MainActivity`;
const apk = process.argv[2];
if (!apk) throw new Error('Pfad zur APK fehlt');

const adb = (...args) => execFileSync('adb', args, { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what, detail = '') => {
  console.log(`${ok ? '✔' : '✘'} ${what}${detail ? ` – ${detail}` : ''}`);
  if (!ok) failed++;
};

adb('install', '-r', '-g', apk); // -g: Mikrofon-Recht gleich erteilen
adb('logcat', '-c');
adb('shell', 'am', 'start', '-W', '-n', ACT);

// WebView-Fehlersuche: Debug-Builds öffnen einen Socket "webview_devtools_remote_<pid>"
let pid = '';
let targets = [];
for (let i = 0; i < 60 && !targets.length; i++) {
  await sleep(1000);
  pid = adb('shell', 'pidof', APP).split(/\s+/)[0] ?? '';
  if (!pid) continue;
  try {
    adb('forward', 'tcp:9333', `localabstract:webview_devtools_remote_${pid}`);
    targets = (await (await fetch('http://127.0.0.1:9333/json/list')).json()).filter((t) => t.type === 'page');
  } catch {}
}
check(targets.length > 0, 'App gestartet, WebView erreichbar', `pid ${pid}`);
if (!targets.length) {
  console.log(adb('logcat', '-d', '-t', '300'));
  process.exit(1);
}

const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let seq = 0;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text);
  }
};
const send = (method, params = {}) =>
  new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
/** JavaScript in der App ausführen (async erlaubt) und das Ergebnis zurückgeben. */
async function run(expr) {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'Fehler im Test-Skript');
  return r.result?.result?.value;
}
await send('Runtime.enable');

// 1) Oberfläche vollständig gestartet (init() lief durch)
let ready = false;
for (let i = 0; i < 40 && !ready; i++) {
  ready = await run(`return !!window.__app && !!document.querySelector('#btnAttach') && !document.querySelector('#btnAttach').hidden`);
  if (!ready) await sleep(500);
}
check(ready, 'Oberfläche vollständig gestartet (Anhang-Knopf sichtbar)');
const info = await run(`return { title: document.querySelector('#titleVersion')?.textContent, edition: window.__app?.edition,
  mobile: document.documentElement.classList.contains('mobile'), provider: window.__app?.state?.settings?.provider }`);
console.log('  ', JSON.stringify(info));
check(info.mobile, 'Android-Darstellung aktiv');
check(/\d+\.\d+/.test(info.title ?? ''), 'Version in der Titelzeile', info.title);

// 2) Bild-im-Bild-Schnittstelle aus MainActivity.java
check(await run(`return !!window.KIPip?.supported?.() && typeof window.KIPip?.setAspect === 'function'`), 'Bild-im-Bild verfügbar (mit Fensterform)');
check(await run(`return typeof window.KIFiles?.saveAs === 'function' && typeof window.KIFiles?.pickTarget === 'function' && typeof window.KIFiles?.writeUri === 'function'`), '„Speichern unter …“ (auch Speicherort vorab) verfügbar');
check(await run(`return typeof window.KIAuth?.listen === 'function' && typeof window.KIAuth?.open === 'function'`), 'Google-Anmeldung (Empfänger) verfügbar');

// 3) Schlüssel im Android-Keystore verschlüsselt
check(await run(`return !!window.KIKeys?.available?.()`), 'Android-Keystore verfügbar');
const round = await run(`const e = KIKeys.encrypt('geheim-ä-123'); return { e, d: KIKeys.decrypt(e) }`);
check(round.d === 'geheim-ä-123' && !String(round.e).includes('geheim'), 'Verschlüsseln und Entschlüsseln');
const stored = await run(`
  await desktop.setKey('openai', 'sk-test-emulator-4711');
  const st = await desktop.keyStatus();
  const raw = JSON.stringify(await window.__keyFile());
  await desktop.setKey('openai', '');
  return { st, raw };`);
check(stored.st.openai && stored.st.encrypted, 'Schlüssel gespeichert (verschlüsselt gemeldet)');
check(!stored.raw.includes('sk-test-emulator'), 'Schlüssel liegt nicht im Klartext in der Datei', stored.raw.slice(0, 60));

// 4) Figur: Stimmung und Laute kommen an
const mood = await run(`
  const a = window.__app.avatar;
  window.__app.setMood('freudig');
  await new Promise((r) => setTimeout(r, 1500));
  return { name: a.moodCur?.name, smile: a.moodCur?.smile };`);
check(mood.name === 'freudig' && mood.smile > 0.2, 'Figur übernimmt die Stimmung', JSON.stringify(mood));

// 4b) Video mit transparentem Hintergrund aufnehmen (für „Freigestellt speichern“) – geht das in der Android-WebView?
const rec = await run(`
  const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8'];
  const mime = types.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
  if (!mime) return { mime: null };
  const c = document.createElement('canvas'); c.width = 96; c.height = 128;
  const g = c.getContext('2d');
  const track = c.captureStream(0).getVideoTracks()[0];
  const r = new MediaRecorder(track ? new MediaStream([track]) : c.captureStream(0), { mimeType: mime, videoBitsPerSecond: 2e6 });
  const chunks = []; r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  r.start(100);
  for (let i = 0; i < 20; i++) { g.clearRect(0, 0, 96, 128); g.fillStyle = '#3a6fd0'; g.fillRect(20, 30, 40, 70); track.requestFrame(); await new Promise((ok) => setTimeout(ok, 50)); }
  const stopped = await Promise.race([new Promise((ok) => { r.onstop = () => ok(true); r.stop(); }), new Promise((ok) => setTimeout(() => ok(false), 8000))]);
  const blob = new Blob(chunks, { type: 'video/webm' });
  if (!stopped || !blob.size) return { mime, stopped, size: blob.size };
  const v = document.createElement('video'); v.muted = true; v.src = URL.createObjectURL(blob);
  await Promise.race([new Promise((ok) => (v.onloadeddata = ok)), new Promise((ok) => setTimeout(ok, 5000))]);
  await Promise.race([new Promise((ok) => { v.onseeked = ok; v.currentTime = 0.4; }), new Promise((ok) => setTimeout(ok, 3000))]);
  const c2 = document.createElement('canvas'); c2.width = 96; c2.height = 128; const g2 = c2.getContext('2d'); g2.drawImage(v, 0, 0);
  const d = g2.getImageData(0, 0, 96, 128).data;
  return { mime, stopped, size: blob.size, corner: d[3], center: d[(60 * 96 + 40) * 4 + 3] };`);
console.log('   Aufnahme:', JSON.stringify(rec));
check(!!rec.mime && rec.stopped && rec.size > 200, 'Videoaufnahme (WebM) in der WebView möglich', JSON.stringify(rec));
// Kodierung kann am Rand minimal runden (Wert 1 statt 0) – „durchsichtig“ heißt fast 0
check(rec.corner <= 8 && rec.center > 200, 'Aufgenommenes Video behält den transparenten Hintergrund', JSON.stringify(rec));

// 4c) Handy-Funktionen: Teilen, Schnellstart, Erinnerungen, Hintergrund-Gespräch, Akku
const FNS = ['takeIntents', 'power', 'placeName', 'setReminders', 'setBackground', 'pinWidget', 'addTile', 'assistantSettings', 'appLog', 'deviceInfo', 'bondedDevices', 'setCar'];
check(await run(`return ${JSON.stringify(FNS)}.every((f) => typeof window.KIDevice?.[f] === 'function')`), 'Handy-Schnittstelle (KIDevice) vollständig');
const pw = await run(`return JSON.parse(KIDevice.power())`);
check(typeof pw.level === 'number' && pw.level >= 0, 'Akkustand lesbar', JSON.stringify(pw));
await run(`window.__app.state.settings.speak = false; document.querySelector('#input').value = ''; return true`);
adb('shell', 'am', 'start', '-a', 'android.intent.action.SEND', '-t', 'text/plain', '--es', 'android.intent.extra.TEXT', 'Geteilt-aus-Test', '-n', ACT);
let shared = '';
for (let i = 0; i < 20 && !shared.includes('Geteilt-aus-Test'); i++) {
  await sleep(500);
  shared = await run(`return document.querySelector('#input').value`);
}
check(shared.includes('Geteilt-aus-Test'), '„Teilen mit KI-Assistent“ kommt im Eingabefeld an', shared);
adb('shell', 'am', 'start', '-n', ACT, '--es', 'ki_action', 'testaktion');
let act = '';
for (let i = 0; i < 20 && act !== 'testaktion'; i++) {
  await sleep(500);
  act = await run(`return window.__app.lastIntent ?? ''`);
}
check(act === 'testaktion', 'Schnellstart (Widget/Kachel/Verknüpfung) erreicht die Oberfläche', act);
await run(`KIDevice.setReminders(JSON.stringify([{ key: 'test-' + Date.now(), at: Date.now() + 3000, title: 'Testerinnerung', text: 'Zahnarzt um 14 Uhr' }])); return true`);
let notif = '';
for (let i = 0; i < 20 && !notif.includes('Testerinnerung'); i++) {
  await sleep(1000);
  notif = adb('shell', 'dumpsys', 'notification', '--noredact');
}
check(notif.includes('Testerinnerung'), 'Erinnerung erscheint als Benachrichtigung');
await run(`KIDevice.setReminders('[]'); KIDevice.setBackground(true); return true`);
await sleep(2500);
const svc = adb('shell', 'dumpsys', 'activity', 'services', APP);
const bgOn = await run(`return KIDevice.backgroundRunning()`);
check(svc.includes('KIConversationService') && bgOn, 'Gespräch im Hintergrund: Dienst läuft');
await run(`KIDevice.setBackground(false); return true`);
await sleep(1500);
check(!(await run(`return KIDevice.backgroundRunning()`)), 'Hintergrund-Dienst lässt sich beenden');

// 4d) Beta: schwebende Figur über anderen Apps
if (BETA) {
  check(await run(`return typeof window.KIFloat?.now === 'function' && window.KIFloat.supported()`), 'Schwebende Figur: Schnittstelle vorhanden');
  adb('shell', 'appops', 'set', APP, 'SYSTEM_ALERT_WINDOW', 'allow');
  await sleep(500);
  const allowed = await run(`return KIFloat.allowed()`);
  check(allowed, 'Erlaubnis „Über anderen Apps einblenden“ erkannt');
  await run(`window.__app.state.settings.floatOverlay = true; KIFloat.setEnabled(true); KIFloat.now(); return true`);
  let fl = {};
  for (let i = 0; i < 20 && !(fl.showing && fl.cls); i++) {
    await sleep(500);
    fl = await run(`return { showing: KIFloat.showing(), cls: document.documentElement.classList.contains('float-ov'), transparent: window.__app.avatar.transparent }`);
  }
  check(fl.showing && fl.cls && fl.transparent, 'Figur schwebt nach dem Verlassen der App (durchsichtig)', JSON.stringify(fl));
  // Stufe 2: Sprechblase neben der Figur
  await run(`KIFloat.bubble('Hallo, ich bin eine Sprechblase.', 4000); return true`);
  await sleep(800);
  const winList = adb('shell', 'dumpsys', 'window', 'windows');
  const overlays = (winList.match(new RegExp(APP.replace(/\./g, '\\.'), 'g')) ?? []).length;
  check(overlays >= 2, 'Sprechblase als eigenes Fenster neben der Figur', `Fenster der App: ${overlays}`);
  const log = await run(`return KIDevice.appLog().length`);
  check(log > 0, 'Systemprotokoll der App lesbar (Fehlerprotokoll)', String(log));
  // Antippen = sprechen (kommt als „talk“ an): Fensterposition aus den Einstellungen ist unbekannt – Ereignis direkt prüfen
  const live = await run(`return document.querySelector('#avatar').width > 0`);
  check(live, 'Figur zeichnet weiter im schwebenden Fenster');
  adb('shell', 'am', 'start', '-n', ACT);
  for (let i = 0; i < 20 && (fl.showing || fl.cls); i++) {
    await sleep(500);
    fl = await run(`return { showing: KIFloat.showing(), cls: document.documentElement.classList.contains('float-ov') }`);
  }
  check(!fl.showing && !fl.cls, 'Zurück in der App: Figur wieder in der App, normale Ansicht', JSON.stringify(fl));
  check(await run(`return !!document.querySelector('#btnMic') && document.querySelector('#btnMic').getBoundingClientRect().width > 0`), 'Oberfläche nach dem Schweben voll bedienbar');
  await run(`window.__app.state.settings.floatOverlay = false; KIFloat.setEnabled(false); return true`);
}

// 5) Keine Skriptfehler (auch nicht beim Start – die stehen im Systemprotokoll)
const log = adb('logcat', '-d', '-s', 'Capacitor/Console:E', 'chromium:E');
// nur unbehandelte Fehler zählen (Capacitor meldet z. B. beim Start harmlos „Error injecting safe area CSS“)
// Capacitor selbst feuert beim Start manchmal ein natives Ereignis, bevor sein Skript geladen ist
// („Capacitor.triggerEvent“) – das stammt nicht aus der App und ist harmlos.
const startErrors = log.split('\n').filter((l) => /Uncaught/.test(l) && !/reading 'triggerEvent'/.test(l));
check(!startErrors.length && !consoleErrors.length, 'Keine Skriptfehler', [...startErrors, ...consoleErrors].join(' | ').slice(0, 400));

ws.close();
console.log(failed ? `\n${failed} Prüfung(en) fehlgeschlagen` : '\nAlles in Ordnung.');
process.exit(failed ? 1 : 0);
