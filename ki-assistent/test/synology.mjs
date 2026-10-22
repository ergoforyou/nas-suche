// QuickConnect-Zugang (synology.js) gegen eine nachgebildete DSM-Schnittstelle prüfen: Adresse erkennen, Weiterleitung
// auf den Server der Region, Anmeldung, Dateien lesen/schreiben/löschen, bedingtes Schreiben, abgelaufene Sitzung.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseQuickConnect, createQuickConnect } = require('../synology.js');

let failed = 0;
const check = (ok, name, info = '') => {
  console.log(`${ok ? '✔' : '✘'} ${name}${ok ? '' : ` ${info}`}`);
  if (!ok) failed++;
};

const p1 = parseQuickConnect('https://jens.quickconnect.to/home/ki-assistent/');
const p2 = parseQuickConnect('quickconnect.to/jens/home/ki-assistent');
const p3 = parseQuickConnect('jens.de3.quickconnect.to/home/ki');
check(p1?.id === 'jens' && p1.folder === '/home/ki-assistent', 'Adresse ID.quickconnect.to/Ordner', JSON.stringify(p1));
check(p2?.id === 'jens' && p2.folder === '/home/ki-assistent', 'Adresse quickconnect.to/ID/Ordner', JSON.stringify(p2));
check(p3?.id === 'jens' && p3.folder === '/home/ki', 'Adresse mit Region', JSON.stringify(p3));
check(!parseQuickConnect('http://192.168.1.10:5005/home/ki') && !parseQuickConnect('http://100.1.2.3:5005/x'), 'WebDAV-Adressen bleiben WebDAV');

// nachgebildete NAS
const td = new TextDecoder();
const te = new TextEncoder();
const files = new Map(); // Pfad → { body, mtime }
let clock = 1000;
let sid = null;
let logins = 0;
let twoFactor = false;
const log = [];
const params = (url, body, headers) => {
  const q = Object.fromEntries(new URL(url).searchParams);
  if (body && /urlencoded/.test(headers['Content-Type'] ?? '')) Object.assign(q, Object.fromEntries(new URLSearchParams(td.decode(body))));
  return q;
};
const json = (o, url) => ({ status: 200, url, body: te.encode(JSON.stringify(o)) });
async function request(method, url, headers, body) {
  const u = new URL(url);
  log.push(`${method} ${u.host}${u.pathname}`);
  // QuickConnect leitet auf den Server der Region weiter
  if (u.host === 'jens.quickconnect.to') url = url.replace('jens.quickconnect.to', 'jens.de3.quickconnect.to');
  const q = params(url, body, headers);
  if (u.pathname === '/webapi/query.cgi') {
    return json({ success: true, data: { 'SYNO.API.Auth': { path: 'entry.cgi', maxVersion: 7 }, 'SYNO.FileStation.List': { path: 'entry.cgi', maxVersion: 2 }, 'SYNO.FileStation.Download': { path: 'entry.cgi', maxVersion: 2 }, 'SYNO.FileStation.Upload': { path: 'entry.cgi', maxVersion: 3 }, 'SYNO.FileStation.Delete': { path: 'entry.cgi', maxVersion: 2 } } }, url);
  }
  if (!url.includes('jens.de3.quickconnect.to')) return { status: 404, url, body: te.encode('<html>falsch</html>') };
  if (/multipart/.test(headers['Content-Type'] ?? '')) {
    if (q._sid !== sid) return json({ success: false, error: { code: 119 } }, url);
    const text = new TextDecoder('latin1').decode(body); // 1 Zeichen = 1 Byte
    const field = (n) => text.match(new RegExp(`name="${n}"\\r\\n\\r\\n([^\\r]*)`))?.[1];
    const fname = text.match(/filename="([^"]+)"/)[1];
    const start = text.indexOf('\r\n\r\n', text.indexOf('filename=')) + 4;
    const end = text.lastIndexOf('\r\n--');
    const order = text.indexOf('name="path"') < text.indexOf('name="file"');
    if (!order || field('overwrite') !== 'true') return json({ success: false, error: { code: 1800 } }, url);
    files.set(`${field('path')}/${fname}`, { body: body.slice(start, end), mtime: ++clock });
    return json({ success: true }, url);
  }
  if (q.api === 'SYNO.API.Auth') {
    if (q.account !== 'jens' || q.passwd !== 'geheim') return json({ success: false, error: { code: 400 } }, url);
    if (twoFactor) return json({ success: false, error: { code: 403 } }, url);
    logins++;
    sid = `sid${logins}`;
    return json({ success: true, data: { sid } }, url);
  }
  if (q._sid !== sid) return json({ success: false, error: { code: 119 } }, url);
  const path = q.path ? JSON.parse(q.path)[0] : '';
  if (q.api === 'SYNO.FileStation.List' && q.method === 'getinfo') {
    const f = files.get(path);
    return json({ success: true, data: { files: [f ? { path, additional: { size: f.body.length, time: { mtime: f.mtime } } } : { path, code: 408 }] } }, url);
  }
  if (q.api === 'SYNO.FileStation.Download') {
    const f = files.get(path);
    return f ? { status: 200, url, body: f.body } : json({ success: false, error: { code: 408 } }, url);
  }
  if (q.api === 'SYNO.FileStation.Delete') {
    files.delete(path);
    return json({ success: true }, url);
  }
  return json({ success: false, error: { code: 103 } }, url);
}

const qc = createQuickConnect({ request });
const address = 'https://jens.quickconnect.to/home/ki-assistent';
const r = (method, path, body, headers = {}, password = 'geheim') => qc.req({ address, user: 'jens', password, method, path, body, headers });

const miss = await r('GET', 'stand.json');
check(miss.status === 404, 'fehlende Datei → 404', JSON.stringify(miss.status));
const put1 = await r('PUT', 'stand.json', te.encode('{"a":1}'), { 'If-None-Match': '*' });
check([200, 201, 204].includes(put1.status), 'neue Datei hochladen', String(put1.status));
check(log.some((l) => l.includes('jens.de3.quickconnect.to')) && log.filter((l) => l.includes('jens.quickconnect.to')).length === 1, 'Weiterleitung auf den Server der Region gemerkt', JSON.stringify(log));
const got = await r('GET', 'stand.json');
check(got.status === 200 && td.decode(got.body) === '{"a":1}' && /^"\d+-7"$/.test(got.etag), 'Datei lesen mit Stand (ETag)', JSON.stringify({ s: got.status, b: td.decode(got.body), e: got.etag }));
const again = await r('PUT', 'stand.json', te.encode('{"a":2}'), { 'If-None-Match': '*' });
check(again.status === 412, 'If-None-Match: vorhandene Datei nicht überschreiben', String(again.status));
// das andere Gerät schreibt dazwischen
await r('PUT', 'stand.json', te.encode('{"a":3}'));
const stale = await r('PUT', 'stand.json', te.encode('{"a":4}'), { 'If-Match': got.etag });
check(stale.status === 412, 'If-Match: zwischendurch geänderte Datei wird erkannt', String(stale.status));
const cur = await r('GET', 'stand.json');
const ok = await r('PUT', 'stand.json', te.encode('{"a":5}'), { 'If-Match': cur.etag });
check([200, 201, 204].includes(ok.status) && td.decode((await r('GET', 'stand.json')).body) === '{"a":5}', 'If-Match mit aktuellem Stand schreibt', String(ok.status));
const bin = new Uint8Array([0, 1, 2, 255, 13, 10, 45, 45]);
await r('PUT', 'figur-x.kiavatar', bin);
const binBack = await r('GET', 'figur-x.kiavatar');
check(binBack.body.length === bin.length && binBack.body.every((b, i) => b === bin[i]), 'Binärdatei unverändert hin und zurück');
const head = await r('HEAD', 'figur-x.kiavatar');
check(head.status === 200 && head.body.length === 0, 'HEAD prüft nur, ob es die Datei gibt');
const del = await r('DELETE', 'figur-x.kiavatar');
check(del.status === 204 && (await r('HEAD', 'figur-x.kiavatar')).status === 404, 'Datei löschen');
// Sitzung abgelaufen → neu anmelden
sid = 'verworfen';
const before = logins;
const after = await r('GET', 'stand.json');
check(after.status === 200 && logins === before + 1, 'abgelaufene Sitzung: einmal neu anmelden', JSON.stringify({ s: after.status, logins }));
sid = 'verworfen2';
const up = await r('PUT', 'neu.json', te.encode('x'));
check([200, 201, 204].includes(up.status), 'abgelaufene Sitzung beim Hochladen: neu anmelden', String(up.status));
// falsches Passwort und Zwei-Faktor
const msg = async (fn) => {
  try {
    await fn();
    return '';
  } catch (e) {
    return e.message;
  }
};
const wrong = await msg(() => r('GET', 'stand.json', null, {}, 'falsch'));
check(/Passwort falsch/.test(wrong), 'falsches Passwort verständlich gemeldet', wrong);
twoFactor = true;
sid = 'weg';
const tf = await msg(() => r('GET', 'stand.json'));
check(/Zwei-Faktor/.test(tf), 'Zwei-Faktor-Konto verständlich gemeldet', tf);
const noFolder = await msg(() => qc.req({ address: 'https://jens.quickconnect.to', user: 'jens', password: 'geheim', method: 'GET', path: 'stand.json' }));
check(/Ordner/.test(noFolder), 'ohne Ordner: Hinweis', noFolder);

console.log(failed ? `${failed} Prüfung(en) fehlgeschlagen` : 'QuickConnect: alles in Ordnung');
process.exit(failed ? 1 : 0);
