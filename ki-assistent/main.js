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
const os = require('node:os');

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

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.data': 'application/octet-stream',
};

// Erlaubt SharedArrayBuffer und damit Mehrkern-Berechnung für Sprachausgabe/-erkennung.
const ISOLATION = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };

// Datei mit korrektem Content-Type ausliefern (WebAssembly lädt sonst nicht per Streaming)
async function serveFile(file) {
  if (!fs.existsSync(file)) return new Response('Nicht gefunden', { status: 404 });
  const res = await net.fetch(pathToFileURL(file).toString());
  const headers = { 'Content-Length': String(fs.statSync(file).size), ...ISOLATION };
  const type = MIME[path.extname(file).toLowerCase()];
  if (type) headers['Content-Type'] = type;
  return new Response(res.body, { status: 200, headers });
}

async function serveModel(rel) {
  const target = path.normalize(path.join(modelDir(), 'hf', rel));
  if (!target.startsWith(path.join(modelDir(), 'hf'))) return new Response('Verboten', { status: 403 });
  if (fs.existsSync(target)) return serveFile(target);
  if (offline) return new Response('Offline-Modus: Modell nicht vorhanden', { status: 404 });

  const upstream = await fetch(`https://huggingface.co/${rel}`, { redirect: 'follow' }).catch(() => null);
  if (!upstream) return new Response('Keine Internetverbindung', { status: 503 });
  if (!upstream.ok) return new Response(upstream.statusText, { status: upstream.status });

  // Bei komprimierter Übertragung passt die Längenangabe nicht zu den entpackten Daten
  const len = upstream.headers.get('content-encoding') ? null : upstream.headers.get('content-length');
  const headers = len ? { 'Content-Length': len, ...ISOLATION } : { ...ISOLATION };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const part = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.part`;
  const out = fs.createWriteStream(part);
  const reader = upstream.body.getReader();
  const body = new ReadableStream({
    async pull(ctrl) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          await new Promise((r) => out.end(r));
          // Unvollständige Downloads nie als fertiges Modell ablegen
          if (len && fs.statSync(part).size !== Number(len)) throw new Error('Download unvollständig');
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
          // Muss "true" sein: Unter Windows ignoriert Electron sonst auch Größenänderungen per setBounds.
          // (Mit der Maus am Rand ziehen geht bei rahmenlosen, transparenten Fenstern ohnehin nicht.)
          resizable: true,
          minWidth: 60,
          minHeight: 100,
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
  setTimeout(() => fail('Zeitüberschreitung'), 420000);
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
      // Größe ändern (wie Mausrad/Eckanfasser) muss das Fenster wirklich vergrößern
      const before = avatarWin.getBounds();
      ipcMain.emit('avatar:resize', null, { factor: 1.25 });
      await new Promise((r) => setTimeout(r, 300));
      const after = avatarWin.getBounds();
      console.log('Avatar-Größe:', JSON.stringify(before), '->', JSON.stringify(after));
      if (after.height <= before.height) return fail('Avatar-Fenster lässt sich nicht vergrößern');
      await js('window.__app.openOutput()');
      await new Promise((r) => setTimeout(r, 1500));
      if (!(await js('!!window.__app.outputReady()'))) return fail('Ausgabefenster nicht bereit');
      // Modell-Route prüfen: kleine Datei über den Hauptprozess laden
      const cfg = await js(
        "fetch('app://local/models/hf/onnx-community/whisper-tiny/resolve/main/config.json').then(r => r.ok ? r.json() : null).then(j => !!j && j.model_type)",
      );
      console.log('Modell-Route:', cfg);
      if (cfg !== 'whisper') return fail('Modell-Download über app:// fehlgeschlagen');
      // Sprachkette in der echten App: Piper spricht, Whisper erkennt
      const speech = await js('window.__app.selfTest()');
      console.log('Sprach-Selbsttest:', JSON.stringify(speech));
      if (!speech.ok) return fail('Sprachkette: ' + (speech.error || speech.heard));
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
    return serveFile(file);
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

// Größe über einen Eckanfasser ziehen: gegenüberliegende Ecke bleibt fest, Seitenverhältnis bleibt.
ipcMain.on('avatar:resizeStart', (_e, { corner, aspect }) => {
  if (!avatarWin) return;
  stopDrag();
  const b = avatarWin.getBounds();
  const ratio = aspect || b.width / b.height;
  const ax = corner.includes('w') ? b.x + b.width : b.x;
  const ay = corner.includes('n') ? b.y + b.height : b.y;
  avatarWin.setIgnoreMouseEvents(false);
  drag = {
    timer: setInterval(() => {
      if (!avatarWin || avatarWin.isDestroyed()) return stopDrag();
      const c = screen.getCursorScreenPoint();
      const wa = screen.getDisplayNearestPoint(c).workArea;
      let height = Math.max(Math.abs(c.y - ay), Math.abs(c.x - ax) / ratio);
      height = Math.max(120, Math.min(wa.height, height));
      const width = height * ratio;
      avatarWin.setBounds({
        x: Math.round(corner.includes('w') ? ax - width : ax),
        y: Math.round(corner.includes('n') ? ay - height : ay),
        width: Math.round(width),
        height: Math.round(height),
      });
    }, 16),
  };
});

ipcMain.on('avatar:menu', (_e, { listening }) => {
  const send = (cmd) => () => win?.webContents.send('cmd', cmd);
  Menu.buildFromTemplate([
    { label: listening ? 'Zuhören beenden' : 'Zuhören (Doppelklick)', click: send('mic') },
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

// ---------------------------------------------------------------- Lokaler Sprach-Server (Chatterbox)
// Ausdrucksstarke Stimmen auf der Grafikkarte: https://github.com/devnen/Chatterbox-TTS-Server
const ttsUrl = (base, p) => base.replace(/\/+$/, '') + p;

async function ttsJson(base, p, init = {}) {
  const res = await fetch(ttsUrl(base, p), { signal: AbortSignal.timeout(init.timeout ?? 5000), ...init });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.ok) throw new Error(json?.detail ?? json?.message ?? `Sprach-Server antwortet mit ${res.status}`);
  return json;
}

ipcMain.handle('tts:server:info', async (_e, base) => {
  const references = await ttsJson(base, '/get_reference_files'); // wirft, wenn der Server nicht läuft
  const predefined = await ttsJson(base, '/get_predefined_voices').catch(() => []);
  const model = await ttsJson(base, '/api/model-info').catch(() => null);
  return { references, predefined, model };
});

ipcMain.handle('tts:server:speak', async (_e, { base, body }) => {
  const res = await fetch(ttsUrl(base, '/tts'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`Sprach-Server: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return new Uint8Array(await res.arrayBuffer());
});

ipcMain.handle('tts:server:upload', async (_e, { base, name, bytes }) => {
  const form = new FormData();
  form.append('files', new Blob([bytes], { type: /\.mp3$/i.test(name) ? 'audio/mpeg' : 'audio/wav' }), name);
  return ttsJson(base, '/upload_reference', { method: 'POST', body: form, timeout: 60000 });
});

// Auf das mehrsprachige Modell (u. a. Deutsch) umstellen und neu laden
ipcMain.handle('tts:server:multilingual', async (_e, base) => {
  await ttsJson(base, '/save_settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: { repo_id: 'chatterbox-multilingual' } }),
  });
  return ttsJson(base, '/restart_server', { method: 'POST', timeout: 600000 });
});

// Ordner mit den Einrichtungs-Skripten öffnen
ipcMain.on('tts:server:scripts', () => {
  const dir = app.isPackaged ? path.join(process.resourcesPath, 'tts-server') : path.join(__dirname, 'tts-server');
  shell.openPath(dir);
});

// ---------------------------------------------------------------- LM-Studio-Presets
// Der Systemprompt aus dem LM-Studio-Chat gilt nicht automatisch für Anfragen über die API.
// Deshalb lesen wir die gespeicherten Presets ein, damit sie in eine Persona übernommen werden können.
function lmStudioDirs() {
  const home = os.homedir();
  return [
    { dir: path.join(home, '.lmstudio', 'config-presets'), source: 'Preset' },
    { dir: path.join(home, '.lmstudio', 'hub', 'presets'), source: 'Preset' },
    { dir: path.join(home, '.cache', 'lm-studio', 'config-presets'), source: 'Preset' },
    { dir: path.join(home, '.lmstudio', 'conversations'), source: 'Chat' },
    { dir: path.join(home, '.cache', 'lm-studio', 'conversations'), source: 'Chat' },
  ];
}

function findJsonFiles(dir, depth = 0, out = []) {
  if (depth > 4 || !fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findJsonFiles(p, depth + 1, out);
    else if (/\.json$/i.test(e.name)) out.push(p);
  }
  return out;
}

function parsePromptFile(file, source) {
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    let systemPrompt = null;
    let temperature = null;
    // Felder können in verschiedenen Formaten und verschachtelt vorkommen:
    //  - { key: "llm.prediction.systemPrompt", value: "…" } (Presets ab LM Studio 0.3)
    //  - { systemPrompt: "…" } (Chats)
    //  - { inference_params: { pre_prompt, temp } } (LM Studio 0.2)
    const walk = (node, depth = 0) => {
      if (!node || typeof node !== 'object' || depth > 12) return;
      if (Array.isArray(node)) return node.forEach((n) => walk(n, depth + 1));
      if (typeof node.key === 'string' && 'value' in node) {
        if (node.key.endsWith('systemPrompt') && typeof node.value === 'string') systemPrompt ||= node.value;
        if (node.key.endsWith('temperature') && typeof node.value === 'number') temperature ??= node.value;
      }
      if (typeof node.systemPrompt === 'string') systemPrompt ||= node.systemPrompt;
      if (typeof node.pre_prompt === 'string') systemPrompt ||= node.pre_prompt;
      if (typeof node.temp === 'number') temperature ??= node.temp;
      for (const [k, v] of Object.entries(node)) if (k !== 'messages') walk(v, depth + 1);
    };
    walk(json);
    if (!systemPrompt?.trim()) return null;
    const name = (json.name || path.basename(file).replace(/(\.preset|\.conversation)?\.json$/i, '')).toString();
    return { name, systemPrompt: systemPrompt.trim(), temperature, source, mtime: fs.statSync(file).mtimeMs };
  } catch {
    return null;
  }
}

ipcMain.handle('lmstudio:prompts', () => {
  const all = lmStudioDirs()
    .flatMap(({ dir, source }) => findJsonFiles(dir).map((f) => parsePromptFile(f, source)))
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
  // gleiche Prompts nur einmal anzeigen (neuester Eintrag gewinnt)
  const seen = new Set();
  return all.filter((p) => !seen.has(p.systemPrompt) && seen.add(p.systemPrompt));
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
