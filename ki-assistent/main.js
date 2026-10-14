// Hauptprozess: Fenster, app://-Protokoll, Verbindung zu LM Studio, Speicherung der Personas.
const { app, BrowserWindow, ipcMain, protocol, net, session, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const DIST = path.join(__dirname, 'dist');

// Für die automatische Gesichtserkennung (FaceDetector) im Avatar-Editor.
app.commandLine.appendSwitch('enable-experimental-web-platform-features');

// Eigenes Schema, damit fetch/Worker/WASM zuverlässig aus dem App-Paket laden.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

const dataFile = () => path.join(app.getPath('userData'), 'daten.json');

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(dataFile(), 'utf8'));
  } catch {
    return null;
  }
}

function saveData(data) {
  fs.mkdirSync(path.dirname(dataFile()), { recursive: true });
  const tmp = dataFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, dataFile());
}

let win;

function createWindow() {
  const data = loadData();
  const bounds = data?.window ?? { width: 460, height: 760 };
  win = new BrowserWindow({
    ...bounds,
    minWidth: 340,
    minHeight: 480,
    frame: false,
    backgroundColor: '#14161b',
    alwaysOnTop: data?.settings?.alwaysOnTop ?? false,
    title: 'KI-Assistent',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadURL('app://local/index.html');

  // Selbsttest für die Build-Pipeline: Startet die Oberfläche und beendet sich wieder.
  if (process.argv.includes('--smoke-test')) {
    const fail = (why) => {
      console.error('SMOKE FAIL:', why);
      app.exit(1);
    };
    win.webContents.on('preload-error', (_e, _p, err) => fail(err.message));
    win.webContents.on('did-fail-load', (_e, code, desc) => fail(`${code} ${desc}`));
    win.webContents.on('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 3000));
      const ok = await win.webContents.executeJavaScript('!!(window.__app && window.__app.avatar.ready)');
      if (!ok) return fail('Oberfläche nicht bereit');
      console.log('SMOKE OK');
      app.exit(0);
    });
  }

  const persistBounds = () => {
    const current = loadData() ?? {};
    current.window = win.getBounds();
    saveData(current);
  };
  win.on('close', persistBounds);

  // Externe Links im Standardbrowser öffnen.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    const { pathname } = new URL(req.url);
    const file = path.normalize(path.join(DIST, decodeURIComponent(pathname)));
    if (!file.startsWith(DIST)) return new Response('Verboten', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });

  // Mikrofon erlauben (nur für die eigene App-Oberfläche).
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(['media', 'audioCapture'].includes(permission));
  });

  createWindow();
});

app.on('window-all-closed', () => app.quit());

// ---------- Datenspeicher ----------
ipcMain.handle('data:load', () => loadData());
ipcMain.handle('data:save', (_e, data) => {
  const current = loadData() ?? {};
  saveData({ ...current, ...data });
});

// ---------- Fenster ----------
ipcMain.on('win:minimize', () => win?.minimize());
ipcMain.on('win:close', () => win?.close());
ipcMain.on('win:alwaysOnTop', (_e, on) => win?.setAlwaysOnTop(!!on));

// ---------- LM Studio (OpenAI-kompatible API) ----------
// Die Anfragen laufen über den Hauptprozess, damit es keine CORS-Probleme gibt.
function apiUrl(base, p) {
  return base.replace(/\/+$/, '') + p;
}

ipcMain.handle('llm:models', async (_e, baseUrl) => {
  const res = await fetch(apiUrl(baseUrl, '/v1/models'), { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`LM Studio antwortet mit ${res.status}`);
  const json = await res.json();
  return (json.data ?? []).map((m) => m.id);
});

const running = new Map();

ipcMain.on('llm:chat', async (e, { id, baseUrl, model, messages, temperature }) => {
  const ctrl = new AbortController();
  running.set(id, ctrl);
  const send = (type, payload) => {
    if (!e.sender.isDestroyed()) e.sender.send('llm:event', { id, type, payload });
  };
  try {
    const res = await fetch(apiUrl(baseUrl, '/v1/chat/completions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, temperature, stream: true }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`LM Studio antwortet mit ${res.status}: ${await res.text()}`);

    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
          if (delta) send('delta', delta);
        } catch {
          // unvollständige Zeile ignorieren
        }
      }
    }
    send('done');
  } catch (err) {
    if (err.name === 'AbortError') send('done');
    else send('error', err.message);
  } finally {
    running.delete(id);
  }
});

ipcMain.on('llm:abort', (_e, id) => running.get(id)?.abort());
