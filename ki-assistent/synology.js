// Synology über QuickConnect: QuickConnect leitet kein WebDAV weiter, wohl aber die DSM-Oberfläche – darüber geht die
// File-Station-Schnittstelle (SYNO.API.Auth, SYNO.FileStation.*). Hier wird sie so verpackt, dass sie sich wie die
// WebDAV-Anfragen verhält (GET/PUT/HEAD/DELETE mit Statuscodes und ETag), damit der Abgleich unverändert bleibt.
// Adresse z. B. https://jens.quickconnect.to/home/ki-assistent (Ordner wie in der File Station).
// request(method, url, headers, body) → { status, body: Uint8Array, url? } – der Netzzugriff der jeweiligen Umgebung.

/** QuickConnect-Adresse erkennen: „jens.quickconnect.to/home/ki“ oder „https://quickconnect.to/jens/home/ki“. */
function parseQuickConnect(address) {
  const s = String(address ?? '').trim().replace(/^https?:\/\//i, '');
  let m = s.match(/^([a-z0-9][a-z0-9.-]*?)(?:\.[a-z0-9-]+)?\.quickconnect\.(?:to|cn)(?::\d+)?(\/[^?#]*)?$/i);
  if (m && !/^(global|www)$/i.test(m[1])) return { id: m[1], folder: cleanFolder(m[2]) };
  m = s.match(/^quickconnect\.(?:to|cn)\/([a-z0-9][a-z0-9.-]*)(\/[^?#]*)?$/i);
  if (m) return { id: m[1], folder: cleanFolder(m[2]) };
  return null;
}
function cleanFolder(p) {
  const f = decodeURIComponent(String(p ?? '')).replace(/\/+$/, '').replace(/\/{2,}/g, '/');
  return f && f !== '/' ? (f.startsWith('/') ? f : `/${f}`) : '';
}

const td = new TextDecoder();
const te = new TextEncoder();
const form = (o) =>
  Object.entries(o)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
const jsonOf = (bytes) => {
  try {
    return JSON.parse(td.decode(bytes));
  } catch {
    return null;
  }
};

// Fehlernummern der DSM-Schnittstelle → verständlicher Text (Anmeldung) bzw. WebDAV-ähnlicher Status (Dateien)
const AUTH_ERRORS = {
  400: 'Benutzer oder Passwort falsch',
  401: 'Benutzerkonto ist deaktiviert',
  402: 'Benutzer hat keine Berechtigung für die File Station',
  403: 'Das Konto hat Zwei-Faktor-Anmeldung – bitte einen eigenen Benutzer ohne 2FA für die App anlegen',
  404: 'Das Konto hat Zwei-Faktor-Anmeldung – bitte einen eigenen Benutzer ohne 2FA für die App anlegen',
  406: 'Das Konto verlangt Zwei-Faktor-Anmeldung – bitte einen eigenen Benutzer ohne 2FA für die App anlegen',
  407: 'Zu viele Fehlversuche – die NAS hat diese Adresse gesperrt (DSM → Sicherheit → Schutz → Zulassen/Blockieren)',
  410: 'Passwort ist abgelaufen – bitte in DSM ändern',
};
const SESSION_GONE = new Set([105, 106, 107, 119]);
function fileStatus(code) {
  if (code === 408 || code === 418) return 404; // nicht vorhanden / ungültiger Pfad
  if (code === 105 || code === 407) return 403; // keine Berechtigung
  if (code === 416 || code === 1802) return 507; // kein Platz
  if (code === 414) return 412;
  return 500;
}

function createQuickConnect({ request }) {
  const clients = new Map();
  /** Ein angemeldeter Zugang je Adresse und Benutzer (die Sitzung bleibt, bis die NAS sie verwirft). */
  function client(address, user, password) {
    const qc = parseQuickConnect(address);
    if (!qc) throw new Error('keine QuickConnect-Adresse');
    if (!qc.folder) throw new Error('Bitte den Ordner mit angeben, z. B. https://ID.quickconnect.to/home/ki-assistent');
    const key = `${qc.id}|${qc.folder}|${user}`;
    let c = clients.get(key);
    if (!c) {
      c = { qc, base: null, apis: null, sid: null, pw: null };
      clients.set(key, c);
    }
    if (c.pw !== password) {
      c.sid = null;
      c.pw = password;
    }
    return c;
  }

  async function start(c) {
    if (c.base && c.apis) return;
    const base = `https://${c.qc.id}.quickconnect.to`;
    const q = `/webapi/query.cgi?${form({ api: 'SYNO.API.Info', version: 1, method: 'query', query: 'SYNO.API.Auth,SYNO.FileStation.' })}`;
    const r = await request('GET', base + q, {}, null);
    const j = jsonOf(r.body);
    if (!j?.success) {
      const html = /quickconnect|<html/i.test(td.decode(r.body.slice(0, 2000)));
      throw new Error(
        html
          ? 'QuickConnect erreicht die NAS nicht – ist sie an, die QuickConnect-ID richtig und unter Systemsteuerung → Externer Zugriff → QuickConnect → Erweitert „DSM“ freigegeben?'
          : `QuickConnect antwortet nicht wie erwartet (${r.status})`,
      );
    }
    // QuickConnect leitet ggf. auf einen Server der Region weiter (z. B. jens.de3.quickconnect.to): dort weiter
    c.base = r.url ? new URL(r.url).origin : base;
    c.apis = j.data ?? {};
    for (const a of ['SYNO.API.Auth', 'SYNO.FileStation.List', 'SYNO.FileStation.Download', 'SYNO.FileStation.Upload', 'SYNO.FileStation.Delete']) {
      if (!c.apis[a]) throw new Error(`Die NAS bietet ${a} nicht an (File Station eingeschaltet?)`);
    }
  }
  const url = (c, api) => `${c.base}/webapi/${c.apis[api].path}`;

  async function login(c, user) {
    const r = await request(
      'POST',
      url(c, 'SYNO.API.Auth'),
      { 'Content-Type': 'application/x-www-form-urlencoded' },
      te.encode(form({ api: 'SYNO.API.Auth', version: Math.min(6, c.apis['SYNO.API.Auth'].maxVersion ?? 6), method: 'login', account: user, passwd: c.pw ?? '', session: 'FileStation', format: 'sid' })),
    );
    const j = jsonOf(r.body);
    if (!j?.success || !j.data?.sid) {
      const code = j?.error?.code;
      throw new Error(`NAS-Anmeldung: ${AUTH_ERRORS[code] ?? `Fehler ${code ?? r.status}`}`);
    }
    c.sid = j.data.sid;
  }

  /** Aufruf mit Sitzung; ist sie abgelaufen, einmal neu anmelden. */
  async function call(c, user, api, method, params, version = 2, retry = true) {
    if (!c.sid) await login(c, user);
    const r = await request(
      'POST',
      url(c, api),
      { 'Content-Type': 'application/x-www-form-urlencoded' },
      te.encode(form({ api, version: Math.min(version, c.apis[api].maxVersion ?? version), method, ...params, _sid: c.sid })),
    );
    const j = jsonOf(r.body);
    if (!j) throw new Error(`NAS antwortet nicht wie erwartet (${r.status})`);
    if (!j.success && retry && SESSION_GONE.has(j.error?.code)) {
      c.sid = null;
      return call(c, user, api, method, params, version, false);
    }
    return j;
  }

  async function info(c, user, file) {
    const j = await call(c, user, 'SYNO.FileStation.List', 'getinfo', { path: JSON.stringify([file]), additional: '["time","size"]' });
    if (!j.success) return { status: fileStatus(j.error?.code) };
    const f = j.data?.files?.[0];
    if (!f || f.code) return { status: 404 };
    const t = f.additional?.time?.mtime ?? 0;
    return { status: 200, etag: `"${t}-${f.additional?.size ?? 0}"` };
  }

  /** Wie eine WebDAV-Anfrage: GET, HEAD, PUT (mit If-Match / If-None-Match), DELETE auf eine Datei im Ordner. */
  async function req({ address, user, password, method = 'GET', path = '', body, headers = {} }) {
    const c = client(address, user, password);
    await start(c);
    const name = String(path).replace(/^\/+/, '');
    if (!name || name.includes('/')) throw new Error('nur Dateien direkt im Ordner');
    const file = `${c.qc.folder}/${name}`;
    const empty = new Uint8Array();
    if (method === 'HEAD' || method === 'GET') {
      const i = await info(c, user, file);
      if (i.status !== 200 || method === 'HEAD') return { status: i.status, etag: i.etag ?? null, body: empty };
      const r = await request('GET', `${url(c, 'SYNO.FileStation.Download')}?${form({ api: 'SYNO.FileStation.Download', version: 2, method: 'download', path: JSON.stringify([file]), mode: 'download', _sid: c.sid })}`, {}, null);
      const j = r.body.length < 400 ? jsonOf(r.body) : null;
      if (j && j.success === false) return { status: fileStatus(j.error?.code), etag: null, body: empty };
      if (r.status !== 200) return { status: r.status || 500, etag: null, body: empty };
      return { status: 200, etag: i.etag, body: r.body };
    }
    if (method === 'DELETE') {
      const j = await call(c, user, 'SYNO.FileStation.Delete', 'delete', { path: JSON.stringify([file]) });
      return { status: j.success ? 204 : fileStatus(j.error?.code), etag: null, body: empty };
    }
    if (method === 'PUT') {
      // bedingtes Schreiben nachbilden: Stand (Änderungszeit + Größe) unmittelbar vorher prüfen
      if (headers['If-Match'] || headers['If-None-Match']) {
        const i = await info(c, user, file);
        if (headers['If-None-Match'] === '*' && i.status === 200) return { status: 412, etag: null, body: empty };
        if (headers['If-Match'] && (i.status !== 200 || i.etag !== headers['If-Match'])) return { status: 412, etag: null, body: empty };
      }
      if (!c.sid) await login(c, user);
      const boundary = `----kiassistent${Math.random().toString(36).slice(2)}`;
      const field = (k, v) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
      // Reihenfolge wichtig: erst die Angaben, die Datei zuletzt
      const head = te.encode(
        field('api', 'SYNO.FileStation.Upload') +
          field('version', '2') +
          field('method', 'upload') +
          field('path', c.qc.folder) +
          field('create_parents', 'true') +
          field('overwrite', 'true') +
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      );
      const tail = te.encode(`\r\n--${boundary}--\r\n`);
      const data = new Uint8Array(body ?? []);
      const all = new Uint8Array(head.length + data.length + tail.length);
      all.set(head, 0);
      all.set(data, head.length);
      all.set(tail, head.length + data.length);
      const send = () => request('POST', `${url(c, 'SYNO.FileStation.Upload')}?${form({ api: 'SYNO.FileStation.Upload', version: 2, method: 'upload', _sid: c.sid })}`, { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, all);
      let r = await send();
      let j = jsonOf(r.body);
      if (j && !j.success && SESSION_GONE.has(j.error?.code)) {
        await login(c, user);
        r = await send();
        j = jsonOf(r.body);
      }
      if (!j) return { status: r.status || 500, etag: null, body: empty };
      return { status: j.success ? 201 : fileStatus(j.error?.code), etag: null, body: empty };
    }
    return { status: 405, etag: null, body: empty };
  }

  return { req };
}

module.exports = { parseQuickConnect, createQuickConnect };
