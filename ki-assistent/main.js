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
  safeStorage,
  dialog,
  clipboard,
  Notification,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const os = require('node:os');
const { friendlyCloudError, chatAnthropic, chatOpenAI, transcribeOpenAI } = require('./cloud.js');

const DIST = path.join(__dirname, 'dist');
const SMOKE = process.argv.includes('--smoke-test');

// Zwei getrennte Ausgaben, die nebeneinander installiert werden können:
//  - "lokal": ohne jede Cloud-Funktion
//  - "cloud": zusätzlich Claude, ChatGPT und OpenAI-Stimme
// Jede Ausgabe hat ihren eigenen Datenordner (Personas, Bilder, Videos, Gedächtnis).
const EDITION = process.env.KI_EDITION || require('./package.json').edition || 'cloud';
// Beta-Linie (nur Cloud): eigener Name und damit eigener Datenordner – läuft neben der normalen Ausgabe
const BETA = require('./package.json').kanal === 'beta';
const APP_NAME = (EDITION === 'lokal' ? 'KI-Assistent' : 'KI-Assistent Cloud') + (BETA ? ' Beta' : '');
app.setName(APP_NAME);
app.setPath('userData', path.join(app.getPath('appData'), APP_NAME));
ipcMain.on('app:edition', (e) => (e.returnValue = EDITION));

// ---------------------------------------------------------------- Bereiche: Dienstlich / Privat
// Jeder Bereich hat eigene Personas, Chats, Gedächtnis, Schlüssel und Google-Verbindung. Dienstlich liegt wie
// bisher direkt im Datenordner, Privat in einem eigenen Unterordner. Medien (Videos) teilen sich beide.
const areaFile = () => path.join(app.getPath('userData'), 'bereich.json');
let AREA = 'dienstlich';
try {
  if (JSON.parse(fs.readFileSync(areaFile(), 'utf8')).bereich === 'privat') AREA = 'privat';
} catch {}
const areaDir = () => (AREA === 'privat' ? path.join(app.getPath('userData'), 'privat') : app.getPath('userData'));
ipcMain.on('area:get', (e) => (e.returnValue = AREA));
const areaDirOf = (name) => (name === 'privat' ? path.join(app.getPath('userData'), 'privat') : app.getPath('userData'));
// Daten des anderen Bereichs lesen (für das Mitnehmen der Personas beim Wechsel)
ipcMain.handle('area:load', (_e, name) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(areaDirOf(name), 'daten.json'), 'utf8'));
  } catch {
    return null;
  }
});
ipcMain.handle('area:set', (_e, name, patch) => {
  const next = name === 'privat' ? 'privat' : 'dienstlich';
  if (patch && next !== AREA) {
    // Personas in den Zielbereich schreiben (Gedächtnis und Chats dort bleiben, wie sie sind)
    const file = path.join(areaDirOf(next), 'daten.json');
    let cur = {};
    try {
      cur = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {}
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify({ ...cur, ...patch }, null, 2));
    fs.renameSync(file + '.tmp', file);
  }
  fs.writeFileSync(areaFile(), JSON.stringify({ bereich: next }));
  // sauberer Neustart: alle Daten, Schlüssel und Verbindungen des anderen Bereichs laden
  setTimeout(() => {
    app.relaunch();
    app.exit(0);
  }, 150);
  return next;
});
// API-Schlüssel (Claude/OpenAI) aus Dienstlich übernehmen – ohne Google-Verbindung
ipcMain.handle('area:copyKeys', () => {
  if (AREA !== 'privat') return false;
  let from = {};
  try {
    from = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'schluessel.json'), 'utf8'));
  } catch {}
  const to = readKeyFile();
  for (const k of ['anthropic', 'openai']) if (from[k]) to[k] = from[k];
  if (from.enc != null) to.enc = from.enc;
  fs.mkdirSync(path.dirname(keyFile()), { recursive: true });
  fs.writeFileSync(keyFile(), JSON.stringify(to));
  return true;
});

// ---------------------------------------------------------------- Büro: markierten Text holen, einfügen, Präsentation erkennen
// Unter Windows ein dauerhaft laufender PowerShell-Helfer (Win32-Aufrufe, ohne zusätzliche Programme):
// Vordergrundfenster merken/zurückholen, Strg+C bzw. Strg+V senden, „Bitte nicht stören“-Zustand abfragen.
const HELPER_PS = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class KIHelfer {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int s);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public static void Loslassen() { foreach (byte b in new byte[] { 0x10, 0x11, 0x12, 0x5B, 0x5C }) keybd_event(b, 0, 2, UIntPtr.Zero); }
  public static void Strg(byte k) { keybd_event(0x11, 0, 0, UIntPtr.Zero); keybd_event(k, 0, 0, UIntPtr.Zero); keybd_event(k, 0, 2, UIntPtr.Zero); keybd_event(0x11, 0, 2, UIntPtr.Zero); }
}
"@
while ($true) {
  $l = [Console]::In.ReadLine(); if ($l -eq $null) { break }
  $p = $l.Split(' ')
  switch ($p[0]) {
    'FG' { [Console]::Out.WriteLine('OK ' + [KIHelfer]::GetForegroundWindow().ToInt64()) }
    'SETFG' { [KIHelfer]::SetForegroundWindow([IntPtr][Int64]$p[1]) | Out-Null; [Console]::Out.WriteLine('OK') }
    'COPY' { [KIHelfer]::Loslassen(); Start-Sleep -Milliseconds 80; [KIHelfer]::Strg(0x43); [Console]::Out.WriteLine('OK') }
    'PASTE' { [KIHelfer]::Loslassen(); Start-Sleep -Milliseconds 40; [KIHelfer]::Strg(0x56); [Console]::Out.WriteLine('OK') }
    'STATE' { $s = 0; [KIHelfer]::SHQueryUserNotificationState([ref]$s) | Out-Null; [Console]::Out.WriteLine('OK ' + $s) }
    default { [Console]::Out.WriteLine('OK') }
  }
}`;
let helper = null;
let helperReady = false;
let helperQueue = [];
let helperBuf = '';
function helperCmd(cmd) {
  if (process.platform !== 'win32') return Promise.resolve(null);
  if (!helper) {
    const { spawn } = require('node:child_process');
    // als Datei starten (stdin bleibt frei für die Befehle)
    const script = path.join(app.getPath('userData'), 'ki-helfer.ps1');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, '\ufeff' + HELPER_PS.replace(/\r?\n/g, '\r\n'));
    helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true });
    helper.stdout.on('data', (d) => {
      helperBuf += d.toString();
      let nl;
      while ((nl = helperBuf.indexOf('\n')) >= 0) {
        const line = helperBuf.slice(0, nl).trim();
        helperBuf = helperBuf.slice(nl + 1);
        if (line.startsWith('OK')) {
          helperReady = true;
          helperQueue.shift()?.(line.slice(2).trim());
        }
      }
    });
    helper.on('exit', () => {
      helper = null;
      helperReady = false;
      helperQueue.splice(0).forEach((r) => r(null));
    });
  }
  // erster Aufruf: PowerShell übersetzt den Helfer erst (Add-Type) – das kann auf langsamen Rechnern dauern
  const first = !helperReady;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), first ? 30000 : 8000);
    helperQueue.push((v) => {
      clearTimeout(timer);
      resolve(v);
    });
    helper.stdin.write(cmd + '\r\n');
  });
}
app.on('will-quit', () => helper?.kill());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Markierten Text der aktiven App holen (Strg+C), Zwischenablage danach wiederherstellen. */
async function grabSelection() {
  const hwnd = await helperCmd('FG');
  const before = clipboard.readText();
  let text = '';
  if (hwnd) {
    clipboard.writeText('');
    await helperCmd('COPY');
    for (let i = 0; i < 12 && !text; i++) {
      await wait(60);
      text = clipboard.readText();
    }
    clipboard.writeText(before);
  }
  // ohne Markierung (oder nicht Windows): Inhalt der Zwischenablage verwenden
  return { text: text || before, fromClipboard: !text, hwnd };
}

/** Text in die vorher aktive App einfügen (über die Zwischenablage, danach wiederhergestellt). */
async function pasteInto({ text, hwnd, restore = true }) {
  const before = clipboard.readText();
  clipboard.writeText(text);
  if (process.platform !== 'win32' || !hwnd) return { pasted: false };
  await helperCmd(`SETFG ${hwnd}`);
  await wait(150);
  await helperCmd('PASTE');
  if (restore) setTimeout(() => clipboard.writeText(before), 700);
  return { pasted: true };
}
ipcMain.handle('office:paste', (_e, opts) => pasteInto(opts));
ipcMain.handle('office:copy', (_e, text) => clipboard.writeText(String(text ?? '')));
ipcMain.handle('office:foreground', () => helperCmd('FG'));
// Windows-Zustand: 1 normal, 2 Vollbild-App, 3 Vollbild-Spiel/Video, 4 Präsentationsmodus, 5 Stille Stunden
ipcMain.handle('office:state', async () => Number(await helperCmd('STATE')) || 0);
ipcMain.handle('office:notify', (_e, { title, body, silent }) => {
  if (!Notification.isSupported()) return false;
  const n = new Notification({ title, body, silent: !!silent });
  n.on('click', () => {
    if (win && !win.isDestroyed()) {
      win.show();
      win.focus();
    }
  });
  n.show();
  return true;
});
ipcMain.handle('office:avatarVisible', (_e, on) => {
  if (avatarWin && !avatarWin.isDestroyed()) on ? avatarWin.showInactive() : avatarWin.hide();
});

// ---------------------------------------------------------------- Abgleich mit dem Handy im WLAN (nur Bereich Privat)
// Kleiner Server im eigenen Netz, nur solange das Abgleich-Fenster offen ist (höchstens 10 Minuten), geschützt mit
// einem zufälligen Code. Personas (mit Avatar, Posen, Schnellbefehlen) gehen direkt hin und her – ohne Cloud.
let syncServer = null;
let syncCode = '';
let syncTimer = null;
const syncWaiters = new Map();
ipcMain.on('sync:res', (_e, { rid, ok, result, error }) => {
  syncWaiters.get(rid)?.(ok ? { result } : { error });
  syncWaiters.delete(rid);
});
function askRenderer(op, data) {
  return new Promise((resolve, reject) => {
    const rid = Math.random().toString(36).slice(2);
    const t = setTimeout(() => {
      syncWaiters.delete(rid);
      reject(new Error('Zeitüberschreitung'));
    }, 120000);
    syncWaiters.set(rid, (r) => {
      clearTimeout(t);
      r.error ? reject(new Error(r.error)) : resolve(r.result);
    });
    win.webContents.send('sync:req', { rid, op, data });
  });
}
// Adressen im Heimnetz, beste zuerst: echte WLAN-/LAN-Adapter vor virtuellen (Hyper-V/WSL, Docker, VPN …),
// sonst landet z. B. die 172.x-Adresse von WSL im QR-Code und das Handy erreicht den PC nicht
const VIRTUAL_NIC = /vEthernet|Hyper-V|WSL|VirtualBox|VMware|Docker|Loopback|Tailscale|ZeroTier|TAP|TUN|VPN|Bluetooth|Npcap/i;
function lanAddresses() {
  const rank = (name, ip) =>
    (VIRTUAL_NIC.test(name) ? 10 : 0) +
    (/^192\.168\./.test(ip) ? 0 : /^10\./.test(ip) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : /^169\.254\./.test(ip) ? 8 : 4) +
    (/WLAN|Wi-?Fi|Wireless|Ethernet|LAN/i.test(name) ? 0 : 0.5);
  const all = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) all.push({ ip: i.address, r: rank(name, i.address) });
  }
  all.sort((a, b) => a.r - b.r);
  return all.length ? [...new Set(all.map((a) => a.ip))] : ['127.0.0.1'];
}
function stopSync() {
  clearTimeout(syncTimer);
  syncServer?.close();
  syncServer = null;
  syncCode = '';
}
ipcMain.handle('sync:stop', () => stopSync());
ipcMain.handle('sync:start', async () => {
  if (AREA !== 'privat') throw new Error('Der Abgleich mit dem Handy ist vorerst nur im Bereich Privat möglich.');
  stopSync();
  const http = require('node:http');
  syncCode = String(Math.floor(100000 + Math.random() * 900000));
  syncServer = http.createServer(async (req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'x-ki-code, content-type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
    if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
    if (req.headers['x-ki-code'] !== syncCode) return res.writeHead(403, cors).end('Code falsch');
    try {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname === '/info') {
        return res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }).end(JSON.stringify({ name: APP_NAME, area: AREA }));
      }
      if (req.method === 'GET' && url.pathname === '/personas') {
        const list = await askRenderer('list');
        return res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }).end(JSON.stringify(list));
      }
      if (req.method === 'GET' && url.pathname === '/persona') {
        const b64 = await askRenderer('export', url.searchParams.get('id'));
        return res.writeHead(200, { ...cors, 'Content-Type': 'application/zip' }).end(Buffer.from(b64, 'base64'));
      }
      if (req.method === 'POST' && url.pathname === '/persona') {
        const chunks = [];
        let size = 0;
        for await (const c of req) {
          size += c.length;
          if (size > 500 * 1024 * 1024) throw new Error('zu groß');
          chunks.push(c);
        }
        const name = await askRenderer('import', Buffer.concat(chunks).toString('base64'));
        return res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }).end(JSON.stringify({ name }));
      }
      res.writeHead(404, cors).end();
    } catch (e) {
      res.writeHead(500, cors).end(String(e.message));
    }
  });
  await new Promise((ok, fail) => syncServer.listen(0, '0.0.0.0', ok).on('error', fail));
  syncTimer = setTimeout(stopSync, 10 * 60e3);
  const port = syncServer.address().port;
  const urls = lanAddresses().map((ip) => `http://${ip}:${port}`);
  return { url: urls[0], urls, code: syncCode };
});

// ---------------------------------------------------------------- Firmenwissen (nur Dienstlich)
const kbFile = () => path.join(app.getPath('userData'), 'wissen.json');
ipcMain.handle('kb:load', () => {
  if (AREA !== 'dienstlich') return null;
  try {
    return JSON.parse(fs.readFileSync(kbFile(), 'utf8'));
  } catch {
    return { docs: [] };
  }
});
ipcMain.handle('kb:save', (_e, kb) => {
  if (AREA !== 'dienstlich') throw new Error('Firmenwissen gibt es nur im Bereich Dienstlich.');
  const tmp = kbFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(kb));
  fs.renameSync(tmp, kbFile());
  return true;
});

// Für die automatische Gesichtserkennung (FaceDetector) im Avatar-Editor.
app.commandLine.appendSwitch('enable-experimental-web-platform-features');

// Eigenes Schema, damit fetch/Worker/WASM zuverlässig aus dem App-Paket laden.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

// ---------------------------------------------------------------- Datenspeicher
const dataFile = () => path.join(areaDir(), 'daten.json');

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

// ---------------------------------------------------------------- Dokumente speichern (PDF, Word, Markdown)
// Alles lokal: Word wird in der Oberfläche erzeugt, PDF hier über die Druckfunktion.
async function askSavePath(name, ext, label) {
  const parent = BrowserWindow.getFocusedWindow() ?? win;
  const { canceled, filePath } = await dialog.showSaveDialog(parent, {
    title: 'Speichern unter',
    defaultPath: path.join(app.getPath('documents'), `${name}.${ext}`),
    filters: [{ name: label, extensions: [ext] }],
  });
  return canceled ? null : filePath;
}

// Speicherort vorab wählen (z. B. vor dem Freistellen eines Videos), später hineinschreiben.
// Geschrieben wird nur an Pfade, die der Nutzer gerade selbst im Dialog gewählt hat.
const pickedTargets = new Set();
ipcMain.handle('file:pickTarget', async (_e, { name }) => {
  const ext = path.extname(name).slice(1) || 'bin';
  const file = await askSavePath(path.basename(name, path.extname(name)), ext, ext.toUpperCase());
  if (!file) return { cancelled: true };
  pickedTargets.add(file);
  return { target: { path: file } };
});
ipcMain.handle('file:writeTarget', async (_e, { target, bytes }) => {
  if (!pickedTargets.has(target?.path)) throw new Error('Speicherort nicht gewählt');
  pickedTargets.delete(target.path);
  fs.writeFileSync(target.path, Buffer.from(bytes));
});

ipcMain.handle('export:save', async (_e, { name, ext, label, bytes }) => {
  const file = await askSavePath(name, ext, label);
  if (!file) return null;
  fs.writeFileSync(file, Buffer.from(bytes));
  return file;
});

ipcMain.handle('export:pdf', async (_e, { name, html }) => {
  const file = await askSavePath(name, 'pdf', 'PDF-Dokument');
  if (!file) return null;
  // Unsichtbares Fenster ohne JavaScript, nur zum Setzen und Drucken des Dokuments
  const pdfWin = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, partition: 'pdf-export' } });
  try {
    pdfWin.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_d, cb) => cb({ cancel: true }));
    await pdfWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const pdf = await pdfWin.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: { top: 0.6, bottom: 0.6, left: 0.7, right: 0.7 },
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate:
        '<div style="font-size:8px;color:#888;width:100%;text-align:center"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    });
    fs.writeFileSync(file, pdf);
    return file;
  } finally {
    pdfWin.destroy();
  }
});

ipcMain.on('export:show', (_e, file) => file && shell.showItemInFolder(file));

// ---------------------------------------------------------------- Medien (Video-Posen)
// Videos liegen als Dateien im Benutzerordner, nicht in daten.json.
const mediaDir = () => path.join(app.getPath('userData'), 'medien');
ipcMain.handle('media:save', (_e, { bytes, ext }) => {
  fs.mkdirSync(mediaDir(), { recursive: true });
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${String(ext).replace(/[^a-z0-9]/gi, '').toLowerCase() || 'mp4'}`;
  fs.writeFileSync(path.join(mediaDir(), name), Buffer.from(bytes));
  return `app://local/media/${name}`;
});
ipcMain.handle('media:delete', (_e, url) => {
  const name = String(url).split('/media/')[1];
  if (name && !name.includes('..')) fs.rmSync(path.join(mediaDir(), name), { force: true });
});

// ---------------------------------------------------------------- Modell-Speicher
// Die Oberfläche selbst hat keinen Internetzugang (CSP). Sprachmodelle werden über
// app://local/models/hf/<pfad> angefragt; der Hauptprozess liefert sie von der Festplatte
// oder lädt sie einmalig von Hugging Face und legt sie dort ab.
// Sprachmodelle sind keine persönlichen Daten: Beide Ausgaben (lokal/Cloud) teilen sich einen Modellordner,
// damit nichts doppelt heruntergeladen werden muss. Ältere Ordner werden weiter mitbenutzt.
const modelDir = () => path.join(app.getPath('appData'), 'KI-Assistent Modelle');
const legacyModelDirs = () =>
  ['KI-Assistent', 'KI-Assistent Cloud'].map((n) => path.join(app.getPath('appData'), n, 'modelle'));
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
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

// Erlaubt SharedArrayBuffer und damit Mehrkern-Berechnung für Sprachausgabe/-erkennung.
const ISOLATION = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };

// Datei mit korrektem Content-Type ausliefern (WebAssembly lädt sonst nicht per Streaming)
async function serveFile(file, req) {
  if (!fs.existsSync(file)) return new Response('Nicht gefunden', { status: 404 });
  const range = req?.headers.get('range');
  if (range) {
    const size = fs.statSync(file).size;
    const [, a, b] = /bytes=(\d*)-(\d*)/.exec(range) ?? [];
    const start = a ? Number(a) : 0;
    const end = b ? Math.min(Number(b), size - 1) : size - 1;
    const stream = fs.createReadStream(file, { start, end });
    return new Response(require('node:stream').Readable.toWeb(stream), {
      status: 206,
      headers: {
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1),
        'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        ...ISOLATION,
      },
    });
  }
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
  for (const dir of legacyModelDirs()) {
    const old = path.normalize(path.join(dir, 'hf', rel));
    if (old.startsWith(path.join(dir, 'hf')) && fs.existsSync(old)) return serveFile(old);
  }
  if (offline) return new Response('Offline-Modus: Modell nicht vorhanden', { status: 404 });

  // Über den Netzwerkstapel von Chromium (nutzt System-Proxy und -Zertifikate), mit Wiederholungen,
  // falls Hugging Face kurz nicht erreichbar ist oder überlastet antwortet.
  let upstream = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1500 * attempt));
    upstream = await net.fetch(`https://huggingface.co/${rel}`, { redirect: 'follow' }).catch(() => null);
    if (upstream && (upstream.ok || upstream.status < 500)) break;
  }
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
// Chatfenster schließen: 'beenden' = alles aus (auch die freie Figur) | 'weiter' = Figur bleibt, Chat versteckt
let closeMode = 'beenden';
ipcMain.on('app:closeMode', (_e, mode) => (closeMode = mode === 'weiter' ? 'weiter' : 'beenden'));

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
    title: APP_NAME,
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
    if (quitting) return;
    // Bei freischwebender Figur: je nach Einstellung nur das Chatfenster verstecken oder alles beenden
    if (avatarWin && !avatarWin.isDestroyed()) {
      e.preventDefault();
      if (closeMode === 'weiter') win.hide();
      else quitCompletely();
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
    if (frameName === 'aktion' || frameName === 'diktat') {
      const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      const c = screen.getCursorScreenPoint();
      const small = frameName === 'diktat';
      const width = small ? 300 : 480;
      const height = small ? 56 : 420;
      const x = small ? Math.round(wa.x + (wa.width - width) / 2) : Math.min(Math.max(wa.x, c.x - 40), wa.x + wa.width - width);
      const y = small ? wa.y + wa.height - height - 24 : Math.min(Math.max(wa.y, c.y + 16), wa.y + wa.height - height);
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          x, y, width, height,
          frame: !small,
          resizable: !small,
          alwaysOnTop: true,
          skipTaskbar: small,
          minimizable: false,
          maximizable: false,
          focusable: !small,
          autoHideMenuBar: true,
          title: small ? 'Diktat' : 'Text bearbeiten – KI-Assistent',
          backgroundColor: '#14161b',
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
      avatarIgnoring = true;
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
      ipcMain.emit('avatar:setSize', null, { fraction: 0.3 });
      await new Promise((r) => setTimeout(r, 300));
      const sized = avatarWin.getBounds();
      const wa = screen.getDisplayMatching(sized).workArea;
      console.log('Avatar-Größe per Regler (30 %):', JSON.stringify(sized), 'Arbeitsfläche', wa.height);
      if (Math.abs(sized.height - Math.round(wa.height * 0.3)) > 2) return fail('Größen-Regler wirkt nicht');
      await js('window.__app.openOutput()');
      await new Promise((r) => setTimeout(r, 1500));
      if (!(await js('!!window.__app.outputReady()'))) return fail('Ausgabefenster nicht bereit');
      // Modell-Route prüfen: kleine Datei über den Hauptprozess laden
      const cfg = await js(
        "fetch('app://local/models/hf/onnx-community/whisper-tiny/resolve/main/config.json').then(r => r.ok ? r.json() : null).then(j => !!j && j.model_type)",
      );
      console.log('Modell-Route:', cfg);
      if (cfg !== 'whisper') return fail('Modell-Download über app:// fehlgeschlagen');
      // Cloud-SDKs müssen sich im Hauptprozess laden lassen
      console.log('Ausgabe:', EDITION, '| Datenordner:', app.getPath('userData'));
      const uiEdition = await js('window.__app.edition');
      const cloudOptions = await js("document.querySelectorAll('#cProvider option').length");
      console.log('Oberfläche:', uiEdition, '| Anbieter-Auswahl:', cloudOptions);
      if (uiEdition !== EDITION) return fail('Ausgabe in der Oberfläche falsch');
      if (EDITION === 'lokal') {
        if (cloudOptions !== 1) return fail('Lokale Ausgabe zeigt Cloud-Anbieter');
      } else {
        const sdkOk = typeof require('@anthropic-ai/sdk').default === 'function' && typeof require('openai').default === 'function';
        console.log('Cloud-SDKs geladen:', sdkOk);
        if (!sdkOk) return fail('Cloud-SDKs fehlen');
        // Claude-Streaming über den Chromium-Netzwerkweg (Testserver auf diesem Rechner)
        const viaChromium = await smokeCloudStream();
        console.log('Claude-Streaming über Chromium:', JSON.stringify(viaChromium));
        if (viaChromium.text !== 'Hallo Welt' || !viaChromium.aborted) return fail('Cloud-Streaming über Chromium');
      }
      // Büro: Text-Aktionsfenster öffnet sich mit allen Aktionen, Windows-Helfer antwortet
      await js("window.__app.openTextAction({ text: 'Sehr geehrte Damen und Herren, bitte senden Sie mir ein Angebot.' })");
      await new Promise((r) => setTimeout(r, 1500));
      const aktion = BrowserWindow.getAllWindows().find((w) => /aktion\.html/.test(w.webContents.getURL()));
      const buttons = aktion ? await aktion.webContents.executeJavaScript("document.querySelectorAll('.actions button').length") : 0;
      console.log('Text-Aktion: Fenster', !!aktion, '| Aktionen', buttons);
      if (!aktion || buttons < 5) return fail('Text-Aktionsfenster');
      aktion.close();
      if (process.platform === 'win32') {
        const st = Number(await helperCmd('STATE'));
        const fg = await helperCmd('FG');
        console.log('Windows-Helfer: Zustand', st, '| Vordergrundfenster', fg);
        if (!(st >= 1) || !fg) return fail('Windows-Helfer antwortet nicht');
      }
      // Firmenwissen in der echten App: PDF über pdf.js lesen (Datei liegt im Programm)
      const kbPdf = await js(`(async () => {
        const base = new URL('wasm/pdf/', location.href).href;
        const ok = await fetch(base + 'pdf.min.js').then((r) => r.ok);
        return { ok, area: window.__app.area };
      })()`);
      console.log('Firmenwissen (pdf.js im Paket):', JSON.stringify(kbPdf));
      if (!kbPdf.ok) return fail('pdf.js fehlt im Programm');
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
    if (rel.startsWith('/media/')) {
      const file = path.normalize(path.join(mediaDir(), rel.slice('/media/'.length)));
      if (!file.startsWith(mediaDir())) return new Response('Verboten', { status: 403 });
      return serveFile(file, req);
    }
    const file = path.normalize(path.join(DIST, rel));
    if (!file.startsWith(DIST)) return new Response('Verboten', { status: 403 });
    return serveFile(file);
  });

  // Mikrofon erlauben (nur für die eigene App-Oberfläche).
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(['media', 'audioCapture'].includes(permission));
  });

  createWindow();
  // Windows-Helfer für Strg+Alt+K / Diktat schon vorwärmen, damit der erste Aufruf sofort klappt
  if (process.platform === 'win32') setTimeout(() => helperCmd('STATE').catch(() => {}), 4000);

  // Systemweites Tastenkürzel zum Sprechen – auch wenn das Fenster nicht im Vordergrund ist.
  globalShortcut.register('Control+Alt+Space', () => win?.webContents.send('cmd', 'mic'));
  // Büro: markierten Text bearbeiten (Strg+Alt+K) und Diktat in die aktive App (Strg+Alt+D)
  globalShortcut.register('Control+Alt+K', async () => {
    const sel = await grabSelection();
    win?.webContents.send('cmd', 'textaction', { ...sel, cursor: screen.getCursorScreenPoint() });
  });
  globalShortcut.register('Control+Alt+D', async () => {
    const hwnd = await helperCmd('FG');
    win?.webContents.send('cmd', 'dictate', { hwnd });
  });
});

app.on('before-quit', () => (quitting = true));
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());

ipcMain.on('win:minimize', () => win?.minimize());
// Nur-Figur-Ansicht: Chatfenster bildschirmfüllend (Esc bzw. ✕ zurück)
ipcMain.on('win:fullscreen', (_e, on) => win && !win.isDestroyed() && win.setFullScreen(!!on));
ipcMain.on('win:close', () => win?.close());
ipcMain.on('win:show', () => {
  win?.show();
  win?.focus();
});
ipcMain.on('win:alwaysOnTop', (_e, on) => win?.setAlwaysOnTop(!!on));
// Komplett beenden: alle Fenster schließen, laufende Anfragen abbrechen, Prozess sicher beenden
// (danach ist nichts mehr im Task-Manager – auch nicht, wenn ein Fenster hängt).
function quitCompletely() {
  quitting = true;
  for (const ctrl of running.values()) ctrl.abort();
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.destroy();
  app.quit();
  setTimeout(() => app.exit(0), 3000).unref();
}
ipcMain.on('app:quit', quitCompletely);

// ---------------------------------------------------------------- Freischwebende Figur
let drag = null;

let avatarIgnoring = true;
ipcMain.on('avatar:ignoreMouse', (_e, ignore) => {
  if (avatarWin && !avatarWin.isDestroyed() && !drag && avatarIgnoring !== !!ignore) {
    avatarIgnoring = !!ignore;
    avatarWin.setIgnoreMouseEvents(avatarIgnoring, { forward: true });
  }
});

// Mausposition selbst abfragen: Das Weiterreichen der Mausbewegung an durchklickbare Fenster
// ("forward") funktioniert nicht auf allen Windows-Rechnern. Die Oberfläche prüft, ob die Maus
// über der Figur ist, und schaltet das Durchklicken dann aus.
setInterval(() => {
  if (!avatarWin || avatarWin.isDestroyed() || !avatarWin.isVisible() || drag || !win || win.isDestroyed()) return;
  const c = screen.getCursorScreenPoint();
  const b = avatarWin.getBounds();
  const inside = c.x >= b.x && c.y >= b.y && c.x < b.x + b.width && c.y < b.y + b.height;
  if (!inside && avatarIgnoring) return;
  win.webContents.send('avatar:cursor', { inside, x: c.x - b.x, y: c.y - b.y });
}, 60);

ipcMain.on('avatar:dragStart', () => {
  if (!avatarWin) return;
  stopDrag();
  const cursor = screen.getCursorScreenPoint();
  const b = avatarWin.getBounds();
  // Größe festhalten: Beim Wechsel auf einen Bildschirm mit anderer Skalierung ändert Windows sonst die Größe
  // bzw. setPosition „klebt“ am Bildschirmrand. Darum immer die kompletten Maße setzen.
  drag = { dx: cursor.x - b.x, dy: cursor.y - b.y, width: b.width, height: b.height, last: null, started: Date.now() };
  avatarWin.setIgnoreMouseEvents(false);
  avatarIgnoring = false;
  drag.timer = setInterval(() => {
    if (!avatarWin || avatarWin.isDestroyed()) return stopDrag();
    // Sicherheitsnetz, falls das Loslassen der Maus nicht ankommt
    if (Date.now() - drag.started > 60000) return stopDrag();
    const c = screen.getCursorScreenPoint();
    const key = `${c.x},${c.y}`;
    if (key === drag.last) return;
    drag.last = key;
    const target = { x: Math.round(c.x - drag.dx), y: Math.round(c.y - drag.dy), width: drag.width, height: drag.height };
    avatarWin.setBounds(target);
    const now = avatarWin.getBounds();
    if (now.width !== target.width || now.height !== target.height) avatarWin.setBounds(target);
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
  avatarIgnoring = false;
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

// Größe direkt setzen (Regler in den Einstellungen): Anteil an der Bildschirmhöhe, unten mittig verankert
ipcMain.on('avatar:setSize', (_e, { fraction, aspect }) => {
  if (!avatarWin) return;
  const b = avatarWin.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  const height = Math.round(Math.max(120, Math.min(wa.height, wa.height * fraction)));
  const width = Math.round(height * (aspect || b.width / b.height));
  avatarWin.setBounds({
    x: Math.round(Math.min(Math.max(wa.x, b.x + b.width / 2 - width / 2), wa.x + wa.width - width)),
    y: Math.round(Math.min(Math.max(wa.y, b.y + b.height - height), wa.y + wa.height - height)),
    width,
    height,
  });
  patchData({ avatarBounds: avatarWin.getBounds() });
});

// Figur auf einen anderen Bildschirm setzen (unten rechts, gleiche Größe)
function moveAvatarToDisplay(display) {
  if (!avatarWin || avatarWin.isDestroyed()) return;
  const { width, height } = avatarWin.getBounds();
  const wa = display.workArea;
  const h = Math.min(height, wa.height);
  const w = Math.round((width * h) / height);
  const target = { x: wa.x + wa.width - w - 40, y: wa.y + wa.height - h, width: w, height: h };
  avatarWin.setBounds(target);
  avatarWin.setBounds(target);
  patchData({ avatarBounds: avatarWin.getBounds() });
}

ipcMain.on('avatar:menu', (_e, { listening }) => {
  const send = (cmd) => () => win?.webContents.send('cmd', cmd);
  const displays = screen.getAllDisplays().sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
  const current = avatarWin ? screen.getDisplayMatching(avatarWin.getBounds()).id : null;
  const screenMenu =
    displays.length > 1
      ? [
          {
            label: 'Auf Bildschirm verschieben',
            submenu: displays.map((d, i) => ({
              label: `Bildschirm ${i + 1}${i === 0 ? ' (links)' : i === displays.length - 1 ? ' (rechts)' : ''}${d.id === current ? ' – hier' : ''}`,
              enabled: d.id !== current,
              click: () => moveAvatarToDisplay(d),
            })),
          },
        ]
      : [];
  Menu.buildFromTemplate([
    { label: listening ? 'Zuhören beenden' : 'Zuhören (Doppelklick)', click: send('mic') },
    { label: 'Chat öffnen', click: () => (win.show(), win.focus()) },
    { label: 'Ausgabefenster', click: send('output') },
    ...screenMenu,
    { label: 'Neuer Chat', click: send('newchat') },
    { type: 'separator' },
    { label: 'Größer', click: () => ipcMain.emit('avatar:resize', null, { factor: 1.15 }) },
    { label: 'Kleiner', click: () => ipcMain.emit('avatar:resize', null, { factor: 1 / 1.15 }) },
    { label: 'Zurück ins Chatfenster', click: send('dock') },
    { type: 'separator' },
    { label: 'KI-Assistent komplett beenden', click: quitCompletely },
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

// ---------------------------------------------------------------- API-Schlüssel (Cloud-Anbieter)
// Schlüssel werden mit der Verschlüsselung des Betriebssystems (Windows: DPAPI) gespeichert und
// verlassen den Hauptprozess nie – die Oberfläche erfährt nur, ob einer hinterlegt ist.
const keyFile = () => path.join(areaDir(), 'schluessel.json');

function readKeyFile() {
  try {
    return JSON.parse(fs.readFileSync(keyFile(), 'utf8'));
  } catch {
    return {};
  }
}

function getKey(provider) {
  const raw = readKeyFile()[provider];
  if (!raw) return null;
  try {
    const buf = Buffer.from(raw.data, 'base64');
    return raw.encrypted ? safeStorage.decryptString(buf) : buf.toString('utf8');
  } catch {
    return null;
  }
}

/** Wert verschlüsselt speichern (leer = löschen). */
function writeKey(name, value) {
  const all = readKeyFile();
  const clean = String(value ?? '').trim();
  if (!clean) delete all[name];
  else {
    const encrypted = safeStorage.isEncryptionAvailable();
    all[name] = { encrypted, data: (encrypted ? safeStorage.encryptString(clean) : Buffer.from(clean, 'utf8')).toString('base64') };
  }
  fs.mkdirSync(path.dirname(keyFile()), { recursive: true });
  fs.writeFileSync(keyFile(), JSON.stringify(all));
}

ipcMain.handle('keys:status', () => {
  const k = readKeyFile();
  return { anthropic: !!k.anthropic, openai: !!k.openai, encrypted: safeStorage.isEncryptionAvailable() };
});

ipcMain.handle('keys:set', (_e, { provider, key }) => {
  if (EDITION === 'lokal') throw new Error('Diese Ausgabe nutzt keine Cloud-Anbieter.');
  if (!['anthropic', 'openai'].includes(provider)) throw new Error('Unbekannter Anbieter');
  const all = readKeyFile();
  const clean = String(key ?? '').trim();
  if (!clean) delete all[provider];
  else {
    const encrypted = safeStorage.isEncryptionAvailable();
    all[provider] = {
      encrypted,
      data: (encrypted ? safeStorage.encryptString(clean) : Buffer.from(clean, 'utf8')).toString('base64'),
    };
  }
  fs.mkdirSync(path.dirname(keyFile()), { recursive: true });
  fs.writeFileSync(keyFile(), JSON.stringify(all));
});

// Cloud-Anfragen über den Netzwerkstapel von Chromium: Er nutzt Zertifikate und Proxy von Windows (wie Edge
// oder Chrome). Virenscanner mit HTTPS-Prüfung oder Firmen-Proxys lassen die Node-eigenen Verbindungen sonst
// scheitern – die App meldet dann „keine Verbindung“, obwohl das Internet funktioniert.
// Anfragen, die Chromium nicht abbilden kann (z. B. manche Datei-Uploads), laufen ersatzweise über Node.
async function systemFetch(url, init = {}) {
  try {
    return await net.fetch(typeof url === 'string' ? url : (url?.url ?? String(url)), init);
  } catch (err) {
    if (init.signal?.aborted || err?.name === 'AbortError') throw err;
    try {
      return await fetch(url, init);
    } catch {
      throw err;
    }
  }
}
const CLOUD_OPTS = { fetch: systemFetch, maxRetries: 3 };

/** Für den Selbsttest: Claude-Antwort von einem lokalen Testserver streamen und einen Abbruch prüfen. */
async function smokeCloudStream() {
  const http = require('node:http');
  const events = [
    { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hallo ' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Welt' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ];
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (req.headers['x-hang']) return; // hängt, bis abgebrochen wird
    for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const Anthropic = require('@anthropic-ai/sdk').default;
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  try {
    let text = '';
    const client = new Anthropic({ ...CLOUD_OPTS, apiKey: 'test', baseURL });
    await chatAnthropic(client, { model: 'claude-haiku-5-5', messages: [{ role: 'user', content: 'x' }] }, (t, p) => t === 'delta' && (text += p));
    const ctrl = new AbortController();
    const hanging = new Anthropic({ ...CLOUD_OPTS, apiKey: 'test', baseURL, defaultHeaders: { 'x-hang': '1' }, maxRetries: 0 });
    setTimeout(() => ctrl.abort(), 500);
    let aborted = false;
    await chatAnthropic(hanging, { model: 'claude-haiku-5-5', messages: [{ role: 'user', content: 'x' }] }, () => {}, ctrl.signal).catch(() => (aborted = ctrl.signal.aborted));
    return { text, aborted };
  } catch (err) {
    return { error: String(err?.message ?? err) };
  } finally {
    server.close();
  }
}

function anthropicClient() {
  const Anthropic = require('@anthropic-ai/sdk').default;
  const key = getKey('anthropic');
  // Ohne hinterlegten Schlüssel liest das SDK ANTHROPIC_API_KEY aus der Umgebung
  return { Anthropic, client: new Anthropic({ ...CLOUD_OPTS, ...(key ? { apiKey: key } : {}) }) };
}

function openaiClient() {
  const OpenAI = require('openai').default;
  const key = getKey('openai');
  return { OpenAI, client: new OpenAI({ ...CLOUD_OPTS, ...(key ? { apiKey: key } : {}) }) };
}

function cloudBlocked(provider) {
  if (provider === 'lmstudio') return null;
  if (EDITION === 'lokal') return 'Diese Ausgabe arbeitet ausschließlich lokal – Cloud-Anbieter sind nicht enthalten.';
  return offline ? 'Offline-Modus ist aktiv – Cloud-Anbieter sind gesperrt (⚙ → Verbindung).' : null;
}

ipcMain.handle('openai:models', async () => {
  if (cloudBlocked('openai')) throw new Error(cloudBlocked('openai'));
  const { client } = openaiClient();
  const ids = [];
  for await (const m of client.models.list()) ids.push(m.id);
  return ids
    .filter((id) => /^(gpt|o\d|chatgpt)/i.test(id) && !/(audio|tts|realtime|image|transcribe|search|embedding|instruct)/i.test(id))
    .sort();
});

// Alle Claude-Modelle, die das eigene Anthropic-Konto nutzen darf (auch neuere als die fest eingetragenen)
ipcMain.handle('anthropic:models', async () => {
  if (cloudBlocked('anthropic')) throw new Error(cloudBlocked('anthropic'));
  const { client } = anthropicClient();
  const out = [];
  for await (const m of client.models.list()) out.push({ id: m.id, name: m.display_name ?? m.id });
  return out.filter((m) => /^claude-/.test(m.id));
});

// Alle Sprachausgabe-Modelle des eigenen OpenAI-Kontos (auch neuere/größere als die bekannten)
ipcMain.handle('openai:ttsModels', async () => {
  if (cloudBlocked('openai')) throw new Error(cloudBlocked('openai'));
  const { client } = openaiClient();
  const ids = [];
  for await (const m of client.models.list()) ids.push(m.id);
  return ids.filter((id) => /tts/i.test(id) && !/transcribe/i.test(id)).sort();
});

// Cloud-Stimme (OpenAI): ausdrucksstarke Sprachausgabe ohne eigene Grafikkarte
ipcMain.handle('tts:cloud:speak', async (_e, { text, voice, model, instructions, speed }) => {
  const blocked = cloudBlocked('openai');
  if (blocked) throw new Error(blocked);
  try {
    const { client } = openaiClient();
    // Die klassischen Modelle (tts-1, tts-1-hd) kennen keinen Sprechstil und nicht alle neuen Stimmen
    const classic = /^tts-1/.test(model || '');
    const classicVoices = ['alloy', 'ash', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer'];
    const res = await client.audio.speech.create({
      model: model || 'gpt-4o-mini-tts',
      voice: classic && !classicVoices.includes(voice) ? 'nova' : voice || 'nova',
      input: text,
      ...(instructions && !classic ? { instructions } : {}),
      ...(speed && speed !== 1 ? { speed } : {}),
      response_format: 'wav',
    });
    return new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    throw new Error(friendlyCloudError(err, 'OpenAI-Stimme', require('openai').default));
  }
});

// Spracherkennung in der Cloud (OpenAI): schnell auch auf schwächeren PCs; nur in der Cloud-Ausgabe
ipcMain.handle('stt:cloud', async (_e, { audio, language, model }) => {
  const blocked = cloudBlocked('openai');
  if (blocked) throw new Error(blocked);
  try {
    const { client } = openaiClient();
    const { toFile } = require('openai');
    return await transcribeOpenAI(client, toFile, audio instanceof Float32Array ? audio : Float32Array.from(audio), { language, model });
  } catch (err) {
    throw new Error(friendlyCloudError(err, 'Cloud-Spracherkennung', require('openai').default));
  }
});

// ---------------------------------------------------------------- Google Kalender und Aufgaben (nur Cloud-Ausgabe)
// Anmeldung im Standardbrowser; Google leitet danach an http://127.0.0.1:<Port> zurück, wo die App kurz lauscht.
// Das Token liegt verschlüsselt (Windows) in schluessel.json und verlässt den Hauptprozess nie.
const googleLib = require('./google.js');
const google = googleLib.createGoogle({
  http: async ({ method, url, headers, body }) => {
    const res = await systemFetch(url, { method, headers, body });
    const text = await res.text();
    let data = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {}
    return { status: res.status, data };
  },
  load: async () => {
    const raw = getKey('google');
    try {
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  save: async (t) => writeKey('google', t ? JSON.stringify(t) : ''),
});

ipcMain.handle('google:upcoming', async (_e, { timeZone: tz = 'Europe/Berlin', hours = 48 } = {}) => {
  if (EDITION === 'lokal' || !(await google.status()).connected) return null;
  const local = (d) => d.toLocaleString('sv-SE', { timeZone: tz }).replace(' ', 'T').slice(0, 16);
  const now = new Date();
  const until = new Date(+now + hours * 3600e3);
  const ev = await googleLib.runTool(google, 'kalender_termine_lesen', { von: local(now), bis: local(until) }, { timeZone: tz });
  const ta = await googleLib.runTool(google, 'aufgaben_lesen', {}, { timeZone: tz });
  const last = local(until).slice(0, 10);
  return { termine: ev.termine, aufgaben: (ta.aufgaben ?? []).filter((t) => t.faellig && t.faellig <= last) };
});
ipcMain.handle('google:status', () => (EDITION === 'lokal' ? { connected: false, blocked: true } : google.status()));
ipcMain.handle('google:disconnect', () => google.disconnect());
ipcMain.handle('google:connect', async (_e, { clientId, clientSecret }) => {
  if (EDITION === 'lokal') throw new Error('Diese Ausgabe arbeitet ausschließlich lokal.');
  if (!String(clientId || '').includes('.apps.googleusercontent.com')) throw new Error('Bitte die Client-ID aus der Google Cloud Console eintragen.');
  const http = require('node:http');
  const { verifier, challenge, state } = await googleLib.pkce();
  // kurz auf 127.0.0.1 lauschen, bis Google mit dem Anmeldecode zurückleitet
  const result = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (!u.searchParams.has('code') && !u.searchParams.has('error')) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<meta charset="utf-8"><body style="font:16px sans-serif;padding:40px">✔ Fertig – du kannst dieses Fenster schließen und zum KI-Assistenten zurückkehren.</body>');
      server.close();
      clearTimeout(timer);
      if (u.searchParams.get('state') !== state) return reject(new Error('Anmeldung abgebrochen (ungültige Antwort).'));
      if (u.searchParams.get('error')) return reject(new Error(`Google: ${u.searchParams.get('error')}`));
      resolve({ code: u.searchParams.get('code'), redirectUri: `http://127.0.0.1:${server.address()?.port ?? port}` });
    });
    let port = 0;
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('Keine Anmeldung innerhalb von 5 Minuten.'));
    }, 5 * 60 * 1000);
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      shell.openExternal(googleLib.authUrl({ clientId, redirectUri: `http://127.0.0.1:${port}`, challenge, state }));
    });
  });
  const email = await google.exchange({ clientId, clientSecret, code: result.code, verifier, redirectUri: result.redirectUri });
  if (win && !win.isDestroyed()) win.focus();
  return { connected: true, email };
});

/** Werkzeuge für den Chat, wenn Google verbunden ist. */
async function googleTools(timeZone) {
  if (EDITION === 'lokal' || !(await google.status()).connected) return null;
  return {
    defs: googleLib.TOOLS,
    status: googleLib.TOOL_STATUS,
    run: (name, input) => googleLib.runTool(google, name, input, { timeZone }),
  };
}

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

// ---------------------------------------------------------------- Von Claude erstellte Dateien
// Landen in "Dokumente\KI-Assistent Dateien"; Dateinamen werden bereinigt, nichts wird überschrieben.
const createdDir = () => path.join(app.getPath('documents'), `${APP_NAME} Dateien`);
const claudeContainers = new Map(); // Gespräch -> Arbeitsbereich bei Anthropic
const claudeUploads = new Map(); // Anhang -> Datei-ID bei Anthropic
function saveCreatedFile(name, bytes) {
  const dir = createdDir();
  fs.mkdirSync(dir, { recursive: true });
  const clean = path.basename(String(name || 'Datei')).replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').slice(0, 120) || 'Datei';
  const ext = path.extname(clean);
  const stem = clean.slice(0, clean.length - ext.length);
  let file = path.join(dir, clean);
  for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${stem} (${i})${ext}`);
  fs.writeFileSync(file, Buffer.from(bytes));
  return file;
}
// Nur Dokument- und Bildformate direkt öffnen – alles andere nur im Ordner zeigen
const OPENABLE = /\.(xlsx|xls|csv|docx|pptx|pdf|png|jpe?g|gif|webp|txt|md|json)$/i;
ipcMain.handle('file:open', async (_e, file) => {
  const resolved = path.resolve(String(file));
  if (!resolved.startsWith(createdDir() + path.sep) || !fs.existsSync(resolved)) return 'Datei nicht gefunden.';
  if (!OPENABLE.test(resolved)) {
    shell.showItemInFolder(resolved);
    return '';
  }
  return shell.openPath(resolved);
});

ipcMain.on('llm:chat', async (e, { id, provider = 'lmstudio', baseUrl, model, messages, temperature, effort, web, files, conversation, google: useGoogle, timeZone }) => {
  const ctrl = new AbortController();
  running.set(id, ctrl);
  const send = (type, payload) => {
    if (!e.sender.isDestroyed()) e.sender.send('llm:event', { id, type, payload });
  };
  const blocked = cloudBlocked(provider);
  if (blocked) {
    running.delete(id);
    return send('error', blocked);
  }
  if (provider === 'anthropic' || provider === 'openai') {
    const name = provider === 'anthropic' ? 'Claude' : 'ChatGPT';
    try {
      if (provider === 'anthropic') {
        const clientTools = useGoogle ? await googleTools(timeZone) : null;
        const ctx = { containers: claudeContainers, uploads: claudeUploads, saveFile: saveCreatedFile, clientTools };
        const req = { model, messages, effort, web, files, conversation };
        try {
          await chatAnthropic(anthropicClient().client, req, send, ctrl.signal, ctx);
        } catch (err) {
          // abgelaufener Arbeitsbereich (nach 30 Tagen) oder gelöschte Datei: einmal frisch beginnen
          if (!files || ctrl.signal.aborted || !/container|file/i.test(String(err?.message))) throw err;
          claudeContainers.delete(conversation);
          claudeUploads.clear();
          await chatAnthropic(anthropicClient().client, req, send, ctrl.signal, ctx);
        }
      }
      else {
        const clientTools = useGoogle ? await googleTools(timeZone) : null;
        await chatOpenAI(openaiClient().client, { model, messages, effort }, send, ctrl.signal, { clientTools });
      }
    } catch (err) {
      const SDK = provider === 'anthropic' ? require('@anthropic-ai/sdk').default : require('openai').default;
      if (ctrl.signal.aborted || err instanceof SDK.APIUserAbortError) send('done');
      else send('error', friendlyCloudError(err, name, SDK));
    } finally {
      running.delete(id);
    }
    return;
  }
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
