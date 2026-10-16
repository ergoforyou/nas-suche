'use strict';
// Verbindung zum Programm Datei-Explorer (läuft im Hintergrund auf diesem PC).

const NAS = (() => {
  const HOST = 'de.ergoforyou.dateiexplorer';
  const FIRST = 47831, COUNT = 10;
  let port = null;
  let connecting = null;

  async function ping(p) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 1500);
      const r = await fetch(`http://127.0.0.1:${p}/ping`, { cache: 'no-store', signal: ctl.signal });
      clearTimeout(t);
      return (await r.text()).startsWith('DateiExplorer');
    } catch (e) {
      return false;
    }
  }

  // Nachricht an das Hilfsprogramm (startet den Explorer bei Bedarf, öffnet Dateien im Vordergrund).
  function native(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendNativeMessage(HOST, msg, (r) => {
          if (chrome.runtime.lastError) resolve({ ok: false, nohost: true, error: chrome.runtime.lastError.message });
          else resolve(r || { ok: false, error: 'keine Antwort' });
        });
      } catch (e) {
        resolve({ ok: false, nohost: true, error: String(e) });
      }
    });
  }

  async function doConnect() {
    const st = await chrome.storage.local.get('port');
    if (st.port && await ping(st.port)) return (port = st.port);
    const r = await native({ cmd: 'start' });
    if (r.ok && r.port) {
      await chrome.storage.local.set({ port: r.port });
      return (port = r.port);
    }
    for (let p = FIRST; p < FIRST + COUNT; p++) {
      if (await ping(p)) {
        await chrome.storage.local.set({ port: p });
        return (port = p);
      }
    }
    const err = new Error(r.nohost ? 'nohost' : (r.error || 'notrunning'));
    err.detail = r.error || '';
    throw err;
  }

  function connect() {
    if (!connecting) connecting = doConnect().finally(() => { connecting = null; });
    return connecting;
  }

  async function request(path, body, method) {
    const opt = { method: method || (body !== undefined ? 'POST' : 'GET'), headers: { 'X-DateiExplorer': '1' }, cache: 'no-store' };
    if (body !== undefined) {
      if (body instanceof Blob) opt.body = body;
      else { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
    }
    const r = await fetch(`http://127.0.0.1:${port}/api/${path}`, opt);
    if (!r.ok) throw new Error('Programm meldet Fehler ' + r.status);
    return r.json();
  }

  async function api(path, body, method) {
    if (!port) await connect();
    try {
      return await request(path, body, method);
    } catch (e) {
      if (body instanceof Blob) throw e;
      port = null; // Programm neu gestartet? neu verbinden und einmal wiederholen
      await connect();
      return request(path, body, method);
    }
  }

  return { connect, api, native, ping, get port() { return port; } };
})();
