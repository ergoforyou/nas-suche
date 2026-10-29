// Abgleich über einen lokalen Ordner am PC – z. B. den Ordner, den der Synology-Client (Drive) oder ein Netzlaufwerk
// einbindet: die App schreibt hinein, die Synology überträgt es selbst. Verhält sich wie die WebDAV-Anfragen
// (GET/PUT/HEAD/DELETE mit Statuscodes, ETag = Änderungszeit + Größe, If-Match/If-None-Match).
const fs = require('node:fs');
const path = require('node:path');

const isLocalNas = (b) => /^[A-Za-z]:[\\/]/.test(String(b)) || /^\\\\/.test(String(b)) || /^file:/i.test(String(b)) || (process.platform !== 'win32' && String(b).startsWith('/'));
function localNasReq(base, method, rel, body, headers = {}) {
  const root = path.resolve(/^file:/i.test(base) ? require('node:url').fileURLToPath(base) : base);
  const file = path.resolve(root, String(rel).replace(/^[\\/]+/, ''));
  if (!file.startsWith(root + path.sep)) return { status: 403, body: new Uint8Array() };
  const etagOf = (st) => `"${Math.round(st.mtimeMs)}-${st.size}"`;
  let st = null;
  try {
    st = fs.statSync(file);
  } catch {}
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  if (method === 'GET') return st ? { status: 200, etag: etagOf(st), body: new Uint8Array(fs.readFileSync(file)) } : { status: 404, body: new Uint8Array() };
  if (method === 'HEAD') return st ? { status: 200, etag: etagOf(st), body: new Uint8Array() } : { status: 404, body: new Uint8Array() };
  if (method === 'DELETE') {
    if (!st) return { status: 404, body: new Uint8Array() };
    fs.unlinkSync(file);
    return { status: 204, body: new Uint8Array() };
  }
  if (method === 'PUT') {
    if (h['if-none-match'] === '*' && st) return { status: 412, body: new Uint8Array() };
    if (h['if-match'] && (!st || etagOf(st) !== h['if-match'])) return { status: 412, body: new Uint8Array() };
    if (!fs.existsSync(root)) {
      // Ordner des Synology-Clients nicht da (Laufwerk getrennt?): nicht still einen neuen anlegen
      if (!fs.existsSync(path.dirname(root))) return { status: 404, body: new Uint8Array() };
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, Buffer.from(body ?? new Uint8Array()));
    fs.renameSync(tmp, file);
    return { status: st ? 204 : 201, etag: etagOf(fs.statSync(file)), body: new Uint8Array() };
  }
  return { status: 405, body: new Uint8Array() };
}

module.exports = { isLocalNas, localNasReq };
