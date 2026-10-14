// Hauptprozess: Fenster, app://-Protokoll, Modell-Speicher, Verbindung zu LM Studio, Speicherung der Personas.
const {
  app,
  BrowserWindow,
  ipcMain,
  protocol,
  net,
  session,
  shell,
  screen,
  Menu,
  globalShortcut,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const DIST = path.join(__dirname, 'dist');
const SMOKE = process.argv.includes('--smoke-test');

// Für die automatische Gesichtserkennung (FaceDetector) im Avatar-Editor.
app.commandLine.appendSwitch('enable-experimental-web-platform-features');

// Eigenes Schema, damit fetch/Worker/WASM zuverlässig aus dem App-Paket laden.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

// ---------------------------------------------------------------- Datenspeicher
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

function patchData(patch) {
  saveData({ ...(loadData() ?? {}), ...patch });
}

ipcMain.handle('data:load', () => loadData());
ipcMain.handle('data:save', (_e, data) => patchData(data));

// ---------------------------------------------------------------- Modell-Speicher
// Die Oberfläche selbst hat keinen Internetzugang (CSP). Sprachmodelle werden über
// app://local/models/hf/<pfad> angefragt; der Hauptprozess liefert sie von der Festplatte
// oder lädt sie einmalig von Hugging Face und legt sie dort ab.
const modelDir = () => path.join(app.getPath('userData'), 'modelle');
let offline = false;

async function serveModel(rel) {
  const target = path.normalize(path.join(modelDir(), 'hf', rel));
  if (!target.startsWith(path.join(modelDir(), 'hf'))) return new Response('Verboten', { status: 403 });
  if (fs.existsSync(target)) {
    const size = fs.statSync(target).size;
    const res = await net.fetch(pathToFileURL(target).toString());
    return new Response(res.body, { status: 200, headers: { 'Content-Length': String(size) } });
  }
  if (offline) return new Response('Offline-Modus: Modell nicht vorhanden', { status: 404 });

  const upstream = await fetch(`https://huggingface.co/${rel}`, { redirect: 'follow' }).catch(() => null);
  if (!upstream) return new Response('Keine Internetverbindung', { status: 503 });
  if (!upstream.ok) return new Response(upstream.statusText, { status: upstream.status });

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const part = `${target}.${process.pid}.part`;
  const out = fs.createWriteStream(part);
  const reader = upstream.body.getReader();
  const body = new ReadableStream({
    async pull(ctrl) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          await new Promise((r) => out.end(r));
          fs.renameSync(part, target);
          ctrl.close();
          return;
        }
        out.write(value);
        ctrl.enqueue(value);
      } catch (err) {
        out.destroy();
        fs.rmSync(part, { force: true });
        ctrl.error(err);
      }
    },
    cancel() {
      reader.cancel();
      out.destroy();
      fs.rmSync(part, { force: true });
    },
  });
  const headers = {};
  const len = upstream.headers.get('content-length');
  if (len) headers['Content-Length'] = len;
  return new Response(body, { status: 200, headers });
}

ipcMain.handle('models:info', () => {
  let bytes = 0;
  const walk = (d) => {
    for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else bytes += fs.statSync(p).size;
    }
  };
  walk(modelDir());
  return { dir: modelDir(), bytes };
});
ipcMain.on('models:open', () => {
  fs.mkdirSync(modelDir(), { recursive: true });
  shell.openPath(modelDir());
});
ipcMain.on('net:offline', (_e, on) => (offline = !!on));

// ---------------------------------------------------------------- Fenster
let win; // Chat-Fenster
let avatarWin = null; // freischwebende Figur
let quitting = false;

function createWindow() {
  const data = loadData();
  offline = !!data?.settings?.offline;
  const bounds = data?.window ?? { width: 460, height: 760 };
  win = new BrowserWindow({
    ...bounds,
    minWidth: 340,
    minHeight: 300,
    frame: false,
    backgroundColor: '#14161b',
    alwaysOnTop: data?.settings?.alwaysOnTop ?? false,
    title: 'KI-Assistent',
    show: !SMOKE,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Läuft weiter, auch wenn das Chatfenster versteckt ist (Sprachausgabe, Lippenbewegung).
      backgroundThrottling: false,
    },
  });
  win.loadURL('app://local/index.html');

  win.on('close', (e) => {
    patchData({ window: win.getBounds() });
    // Bei freischwebender Figur wird das Chatfenster nur versteckt.
    if (avatarWin && !avatarWin.isDestroyed() && !quitting) {
      e.preventDefault();
      win.hide();
    }
  });

  // Zusatzfenster (Figur, Ausgabe) werden von der Oberfläche per window.open geöffnet.
  win.webContents.setWindowOpenHandler(({ url, frameName }) => {
    if (!url.startsWith('app://local/')) {
      if (/^https?:/.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    }
    const saved = loadData() ?? {};
    if (frameName === 'avatar') {
      const b = saved.avatarBounds ?? defaultAvatarBounds();
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          ...b,
          frame: false,
          transparent: true,
          backgroundColor: '#00000000',
          hasShadow: false,
          resizable: false,
          alwaysOnTop: true,
          skipTaskbar: true,
          title: 'Avatar',
          webPreferences: { backgroundThrottling: false },
        },
      };
    }
    if (frameName === 'output') {
      const b = saved.outputBounds ?? { width: 720, height: 820 };
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          ...b,
          title: 'Ausgabe',
          backgroundColor: '#14161b',
          autoHideMenuBar: true,
          webPreferences: { backgroundThrottling: false },
        },
      };
    }
    return { action: 'deny' };
  });

  // Links nie in der App öffnen, sondern im Standardbrowser.
  const guard = (wc) => {
    wc.on('will-navigate', (e, url) => {
      if (!url.startsWith('app://local/')) {
        e.preventDefault();
        if (/^https?:/.test(url)) shell.openExternal(url);
      }
    });
  };
  guard(win.webContents);

  win.webContents.on('did-create-window', (child, { frameName }) => {
    child.setMenu(null);
    guard(child.webContents);
    child.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    if (frameName === 'avatar') {
      avatarWin = child;
      child.setAlwaysOnTop(true, 'floating');
      child.setIgnoreMouseEvents(true, { forward: true });
      const persist = () => !child.isDestroyed() && patchData({ avatarBounds: child.getBounds() });
      child.on('moved', persist);
      child.on('resized', persist);
      child.on('closed', () => {
        avatarWin = null;
        if (!win.isDestroyed() && !win.isVisible()) win.show();
      });
    }
    if (frameName === 'output') {
      child.on('close', () => patchData({ outputBounds: child.getBounds() }));
    }
  });

  if (SMOKE) runSmokeTest();
}

function defaultAvatarBounds() {
  const wa = screen.getPrimaryDisplay().workArea;
  const height = Math.round(wa.height * 0.4);
  const width = Math.round(height * 0.75);
  return { width, height, x: wa.x + wa.width - width - 40, y: wa.y + wa.height - height };
}

// Selbsttest für die Build-Pipeline: startet die Oberfläche, öffnet Figur und Ausgabe und beendet sich.
function runSmokeTest() {
  const fail = (why) => {
    console.error('SMOKE FAIL:', why);
    app.exit(1);
  };
  setTimeout(() => fail('Zeitüberschreitung'), 60000);
  win.webContents.on('preload-error', (_e, _p, err) => fail(err.message));
  win.webContents.on('did-fail-load', (_e, code, desc) => fail(`${code} ${desc}`));
  win.webContents.on('did-finish-load', async () => {
    try {
      await new Promise((r) => setTimeout(r, 3000));
      const js = (code) => win.webContents.executeJavaScript(code);
      if (!(await js('!!(window.__app && window.__app.avatar.ready)'))) return fail('Oberfläche nicht bereit');
      await js('window.__app.setFloating(true)');
      await new Promise((r) => setTimeout(r, 2500));
      if (!avatarWin) return fail('Avatar-Fenster nicht geöffnet');
      if (!(await js('!!window.__app.floatingReady()'))) return fail('Avatar-Fenster nicht bereit');
      await js('window.__app.openOutput()');
      await new Promise((r) => setTimeout(r, 1500));
      if (!(await js('!!window.__app.outputReady()'))) return fail('Ausgabefenster nicht bereit');
      // Modell-Route prüfen: kleine Datei über den Hauptprozess laden
      const cfg = await js(
        "fetch('app://local/models/hf/onnx-community/whisper-tiny/resolve/main/config.json').then(r => r.ok ? r.json() : null).then(j => !!j && j.model_type)",
      );
      console.log('Modell-Route:', cfg);
      if (cfg !== 'whisper') return fail('Modell-Download über app:// fehlgeschlagen');
      console.log('SMOKE OK');
      quitting = true;
      app.exit(0);
    } catch (err) {
      fail(err.message);
    }
  });
}

app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    const { pathname } = new URL(req.url);
    const rel = decodeURIComponent(pathname);
    if (rel.startsWith('/models/hf/')) return serveModel(rel.slice('/models/hf/'.length));
    const file = path.normalize(path.join(DIST, rel));
    if (!file.startsWith(DIST)) return new Response('Verboten', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });

  // Mikrofon erlauben (nur für die eigene App-Oberfläche).
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(['media', 'audioCapture'].includes(permission));
  });

  createWindow();

  // Systemweites Tastenkürzel zum Sprechen – auch wenn das Fenster nicht im Vordergrund ist.
  globalShortcut.register('Control+Alt+Space', () => win?.webContents.send('cmd', 'mic'));
});

app.on('before-quit', () => (quitting = true));
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());

ipcMain.on('win:minimize', () => win?.minimize());
ipcMain.on('win:close', () => win?.close());
ipcMain.on('win:show', () => {
  win?.show();
  win?.focus();
});
ipcMain.on('win:alwaysOnTop', (_e, on) => win?.setAlwaysOnTop(!!on));
ipcMain.on('app:quit', () => {
  quitting = true;
  app.quit();
});

// ---------------------------------------------------------------- Freischwebende Figur
let drag = null;

ipcMain.on('avatar:ignoreMouse', (_e, ignore) => {
  if (avatarWin && !drag) avatarWin.setIgnoreMouseEvents(!!ignore, { forward: true });
});

ipcMain.on('avatar:dragStart', () => {
  if (!avatarWin) return;
  const cursor = screen.getCursorScreenPoint();
  const [x, y] = avatarWin.getPosition();
  drag = { dx: cursor.x - x, dy: cursor.y - y };
  avatarWin.setIgnoreMouseEvents(false);
  drag.timer = setInterval(() => {
    if (!avatarWin || avatarWin.isDestroyed()) return stopDrag();
    const c = screen.getCursorScreenPoint();
    avatarWin.setPosition(Math.round(c.x - drag.dx), Math.round(c.y - drag.dy));
  }, 16);
});

function stopDrag() {
  if (!drag) return;
  clearInterval(drag.timer);
  drag = null;
  if (avatarWin && !avatarWin.isDestroyed()) patchData({ avatarBounds: avatarWin.getBounds() });
}
ipcMain.on('avatar:dragEnd', stopDrag);

// Größe ändern; unten mittig verankert, damit die Figur "stehen" bleibt.
ipcMain.on('avatar:resize', (_e, { factor, aspect }) => {
  if (!avatarWin) return;
  const b = avatarWin.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  const ratio = aspect || b.width / b.height;
  const height = Math.round(Math.max(120, Math.min(wa.height, b.height * (factor ?? 1))));
  const width = Math.round(height * ratio);
  avatarWin.setBounds({
    x: Math.round(b.x + b.width / 2 - width / 2),
    y: b.y + b.height - height,
    width,
    height,
  });
  patchData({ avatarBounds: avatarWin.getBounds() });
});

ipcMain.on('avatar:menu', (_e, { listening }) => {
  const send = (cmd) => () => win?.webContents.send('cmd', cmd);
  Menu.buildFromTemplate([
    { label: listening ? 'Zuhören beenden' : 'Zuhören', click: send('mic') },
    { label: 'Chat öffnen', click: () => (win.show(), win.focus()) },
    { label: 'Ausgabefenster', click: send('output') },
    { type: 'separator' },
    { label: 'Größer', click: () => ipcMain.emit('avatar:resize', null, { factor: 1.15 }) },
    { label: 'Kleiner', click: () => ipcMain.emit('avatar:resize', null, { factor: 1 / 1.15 }) },
    { label: 'Zurück ins Chatfenster', click: send('dock') },
    { type: 'separator' },
    { label: 'Beenden', click: () => ((quitting = true), app.quit()) },
  ]).popup({ window: avatarWin ?? win });
});

// ---------------------------------------------------------------- LM Studio (OpenAI-kompatible API)
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
