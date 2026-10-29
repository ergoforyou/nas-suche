// NAS als Zentrale: Verschlüsselung (nascrypt.js) und Abgleich über einen lokalen Ordner am PC (naslocal.js).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { encrypt, decrypt, isEncrypted, cryptReq } = require('../nascrypt.js');
const { isLocalNas, localNasReq } = require('../naslocal.js');

let failed = 0;
const check = (ok, name, info = '') => {
  console.log(`${ok ? '✔' : '✘'} ${name}${ok ? '' : ` ${info}`}`);
  if (!ok) failed++;
};
const te = new TextEncoder();
const td = new TextDecoder();

// Verschlüsselung
const plain = te.encode('{"stand":"geheim – Notizen und Gespräche"}');
const enc = await encrypt(plain, 'Gartenzwerg 7');
check(isEncrypted(enc) && !td.decode(enc).includes('geheim'), 'verschlüsselt: Inhalt nicht lesbar');
check(td.decode(await decrypt(enc, 'Gartenzwerg 7')) === td.decode(plain), 'mit richtigem Passwort wieder lesbar');
let err = '';
try {
  await decrypt(enc, 'falsch');
} catch (e) {
  err = e.message;
}
check(/passt nicht/.test(err), 'falsches Passwort → verständlicher Fehler', err);
err = '';
try {
  await decrypt(enc, '');
} catch (e) {
  err = e.message;
}
check(/verschlüsselt/.test(err), 'ohne Passwort → Hinweis, es einzutragen', err);
check(td.decode(await decrypt(plain, 'egal')) === td.decode(plain), 'Unverschlüsseltes bleibt lesbar (Umstieg)');
const enc2 = await encrypt(plain, 'Gartenzwerg 7');
check(td.decode(enc.slice(22, 34)) !== td.decode(enc2.slice(22, 34)), 'jede Datei mit eigenem Zufallswert');

// lokaler Ordner (Synology-Client) + Verschlüsselung drumherum
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-nas-'));
const base = path.join(dir, 'ki-assistent');
fs.mkdirSync(base);
check(isLocalNas('D:\\SynologyDrive\\ki') && isLocalNas('\\\\NAS\\home\\ki') && isLocalNas('file:///home/jens/ki') && !isLocalNas('https://jens.quickconnect.to/home/ki') && !isLocalNas('http://192.168.1.10:5005/home'), 'Ordner vs. Adresse erkennen');
const send = async (m, p, b, h) => localNasReq(base, m, p, b, h);
const miss = await cryptReq(send, 'pw', 'GET', 'stand.json');
check(miss.status === 404, 'fehlende Datei → 404');
const put1 = await cryptReq(send, 'pw', 'PUT', 'stand.json', te.encode('{"a":1}'), { 'If-None-Match': '*' });
check(put1.status === 201 && /^"\d+-\d+"$/.test(put1.etag), 'neu anlegen mit ETag', JSON.stringify(put1));
check(isEncrypted(new Uint8Array(fs.readFileSync(path.join(base, 'stand.json')))), 'im Ordner liegt nur Verschlüsseltes');
const again = await cryptReq(send, 'pw', 'PUT', 'stand.json', te.encode('{"a":2}'), { 'If-None-Match': '*' });
check(again.status === 412, 'If-None-Match: Vorhandenes nicht überschreiben');
const got = await cryptReq(send, 'pw', 'GET', 'stand.json');
check(got.status === 200 && td.decode(got.body) === '{"a":1}' && got.etag === put1.etag, 'lesen und entschlüsseln');
await new Promise((r) => setTimeout(r, 20));
await cryptReq(send, 'pw', 'PUT', 'stand.json', te.encode('{"a":3}')); // das andere Gerät (über den Synology-Client)
const stale = await cryptReq(send, 'pw', 'PUT', 'stand.json', te.encode('{"a":4}'), { 'If-Match': got.etag });
check(stale.status === 412, 'If-Match: zwischendurch geändert wird erkannt');
const head = await cryptReq(send, 'pw', 'HEAD', 'stand.json');
check(head.status === 200 && head.etag && head.body.length === 0, 'HEAD liefert den Stand (leichter Änderungs-Check)');
check((await cryptReq(send, 'pw', 'GET', '../ausserhalb.txt')).status === 403, 'nichts außerhalb des Ordners');
check((await cryptReq(send, 'pw', 'DELETE', 'stand.json')).status === 204 && (await cryptReq(send, 'pw', 'HEAD', 'stand.json')).status === 404, 'löschen');
const gone = path.join(dir, 'nicht-da', 'auch-nicht');
check(localNasReq(gone, 'PUT', 'stand.json', te.encode('x')).status === 404 && !fs.existsSync(gone), 'Ordner des Synology-Clients fehlt (Laufwerk getrennt) → nicht still neu anlegen');
fs.rmSync(dir, { recursive: true, force: true });

console.log(failed ? `${failed} Prüfung(en) fehlgeschlagen` : 'NAS: alles in Ordnung');
process.exit(failed ? 1 : 0);
