// Android-App (Capacitor): stellt der Oberfläche dieselbe Schnittstelle bereit wie auf dem PC der
// Electron-Hauptprozess (window.desktop). Daten und Schlüssel liegen im privaten App-Speicher,
// Claude/ChatGPT werden direkt aus der App angesprochen, Dateien über "Teilen" weitergegeben.
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { FilePicker } from '@capawesome/capacitor-file-picker';
import Anthropic, { toFile } from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import cloud from '../../cloud.js';
import googleLib from '../../google.js';

const { chatAnthropic, chatOpenAI, friendlyCloudError, transcribeOpenAI } = cloud;

// ---------------------------------------------------------------- Dateien im App-Speicher
async function readJson(path) {
  try {
    const { data } = await Filesystem.readFile({ path, directory: Directory.Data, encoding: Encoding.UTF8 });
    return JSON.parse(data);
  } catch {
    return null;
  }
}
async function writeJson(path, value) {
  await Filesystem.writeFile({ path, directory: Directory.Data, encoding: Encoding.UTF8, data: JSON.stringify(value), recursive: true });
}
function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
async function writeBytes(path, bytes, directory = Directory.Data) {
  const { uri } = await Filesystem.writeFile({ path, directory, data: toBase64(bytes), recursive: true });
  return uri;
}
const cleanName = (name) => String(name || 'Datei').split(/[\\/]/).pop().replace(/[:*?"<>|\x00-\x1f]+/g, '_').slice(0, 120) || 'Datei';

let data = null;
// Bereiche: Dienstlich (wie bisher) / Privat (eigene Daten und Schlüssel im Unterordner „privat/“)
let AREA = 'dienstlich';
try {
  if (localStorage.getItem('ki-bereich') === 'privat') AREA = 'privat';
} catch {}
const areaPath = (p) => (AREA === 'privat' ? `privat/${p}` : p);
// Schlüssel liegen verschlüsselt im App-Speicher: Der AES-Schlüssel dazu steckt im Android-Keystore
// (Hardware-geschützt, lässt sich nicht auslesen oder kopieren). window.KIKeys kommt aus MainActivity.java.
const vault = () => (window.KIKeys?.available?.() ? window.KIKeys : null);
const PROVIDERS = ['anthropic', 'openai', 'google'];
let keys = null;
async function loadKeys() {
  const file = (await readJson(areaPath('schluessel.json'))) ?? {};
  const v = vault();
  if (!file.enc) {
    // ältere Versionen: Klartext – gleich verschlüsselt neu speichern
    const plain = Object.fromEntries(PROVIDERS.filter((p) => file[p]).map((p) => [p, file[p]]));
    if (v && Object.keys(plain).length) await storeKeys(plain);
    return plain;
  }
  const out = {};
  for (const p of PROVIDERS) {
    if (!file[p] || !v) continue;
    const dec = v.decrypt(file[p]);
    if (dec) out[p] = dec;
    else console.warn(`Schlüssel für ${p} ließ sich nicht entschlüsseln – bitte neu eingeben.`);
  }
  return out;
}
async function storeKeys(k) {
  const v = vault();
  if (!v) return writeJson(areaPath('schluessel.json'), k);
  const file = { enc: 1 };
  for (const p of PROVIDERS) {
    if (!k[p]) continue;
    const enc = v.encrypt(k[p]);
    if (!enc) throw new Error('Schlüssel konnte nicht verschlüsselt werden.');
    file[p] = enc;
  }
  await writeJson(areaPath('schluessel.json'), file);
}
const getKeys = async () => (keys ??= await loadKeys());
// für den Emulator-Test: Liegt die Schlüsseldatei wirklich verschlüsselt vor?
window.__keyFile = () => readJson(areaPath('schluessel.json'));

// ---------------------------------------------------------------- Cloud-Anbieter
const CLOUD_OPTS = { dangerouslyAllowBrowser: true, maxRetries: 3 };
async function anthropicClient() {
  const k = (await getKeys()).anthropic;
  if (!k) throw new Error('Kein Claude-Schlüssel hinterlegt (⚙ → Verbindung).');
  return new Anthropic({ ...CLOUD_OPTS, apiKey: k });
}
async function openaiClient() {
  const k = (await getKeys()).openai;
  if (!k) throw new Error('Kein OpenAI-Schlüssel hinterlegt (⚙ → Verbindung).');
  return new OpenAI({ ...CLOUD_OPTS, apiKey: k });
}

// ---------------------------------------------------------------- Google Kalender und Aufgaben
// Anfragen laufen nativ (CapacitorHttp): keine Browser-Sperren für fremde Adressen (CORS).
async function googleHttp({ method, url, headers = {}, body }) {
  const type = Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
  const data = body == null ? undefined : /json/.test(type) ? JSON.parse(body) : /form/.test(type) ? Object.fromEntries(new URLSearchParams(body)) : body;
  const r = await CapacitorHttp.request({ method, url, headers, ...(data !== undefined ? { data } : {}) });
  let out = r.data;
  if (typeof out === 'string') {
    try {
      out = out ? JSON.parse(out) : null;
    } catch {}
  }
  return { status: r.status, data: out };
}
const google = googleLib.createGoogle({
  http: googleHttp,
  load: async () => {
    const raw = (await getKeys()).google;
    try {
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  save: async (t) => {
    const k = await getKeys();
    if (t) k.google = JSON.stringify(t);
    else delete k.google;
    await storeKeys(k);
  },
});
const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Berlin';
async function googleTools() {
  if (!(await google.status()).connected) return null;
  return {
    defs: googleLib.TOOLS,
    status: googleLib.TOOL_STATUS,
    run: (name, input) => googleLib.runTool(google, name, input, { timeZone: timeZone() }),
  };
}
// Antwort der Anmeldung (MainActivity.java -> Auth): "/?code=…&state=…"
let authWaiter = null;
window.__kiAuthDone = (target) => authWaiter?.(target);

const running = new Map();
const containers = new Map();
const uploads = new Map();
const apiUrl = (base, p) => String(base).replace(/\/+$/, '') + p;

async function saveCreatedFile(name, bytes) {
  const uri = await writeBytes(`Dateien/${Date.now()}-${cleanName(name)}`, bytes);
  return uri;
}

/** WAV (16 kHz, mono, 16 bit) für die Cloud-Spracherkennung. */

const notHere = (what) => async () => {
  throw new Error(`${what} gibt es nur in der PC-Version.`);
};

const api = {
  edition: 'mobile',
  platform: 'android',

  // ---- Daten
  loadData: async () => (data = await readJson(areaPath('daten.json'))),
  saveData: async (patch) => {
    data = { ...(data ?? {}), ...patch };
    await writeJson(areaPath('daten.json'), data);
  },

  // ---- Schlüssel (privater App-Speicher, mit dem Android-Keystore verschlüsselt)
  keyStatus: async () => {
    const k = await getKeys();
    return { anthropic: !!k.anthropic, openai: !!k.openai, encrypted: !!vault() };
  },
  setKey: async (provider, key) => {
    const k = await getKeys();
    const clean = String(key ?? '').trim();
    if (clean) k[provider] = clean;
    else delete k[provider];
    await storeKeys(k);
  },

  // ---- Modelle
  anthropicModels: async () => {
    const c = await anthropicClient();
    const out = [];
    for await (const m of c.models.list()) out.push({ id: m.id, name: m.display_name ?? m.id });
    return out.filter((m) => /^claude-/.test(m.id));
  },
  openaiModels: async () => {
    const c = await openaiClient();
    const ids = [];
    for await (const m of c.models.list()) ids.push(m.id);
    return ids.filter((id) => /^(gpt|o\d|chatgpt)/i.test(id) && !/(audio|tts|realtime|image|transcribe|search|embedding|instruct)/i.test(id)).sort();
  },
  openaiTtsModels: async () => {
    const c = await openaiClient();
    const ids = [];
    for await (const m of c.models.list()) ids.push(m.id);
    return ids.filter((id) => /tts/i.test(id) && !/transcribe/i.test(id)).sort();
  },
  // LM Studio auf dem PC im selben WLAN (dort „CORS aktivieren“ und Server im Netzwerk freigeben)
  listModels: async (baseUrl) => {
    const res = await fetch(apiUrl(baseUrl, '/v1/models'), { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`LM Studio antwortet mit ${res.status}`);
    return ((await res.json()).data ?? []).map((m) => m.id);
  },
  lmStudioPrompts: async () => [],

  // ---- Chat
  chat: (req, onEvent) => {
    const { id, provider = 'anthropic', baseUrl, model, messages, temperature, effort, web, files, conversation, google: useGoogle } = req;
    const ctrl = new AbortController();
    running.set(id, ctrl);
    const send = (type, payload) => onEvent({ id, type, payload });
    (async () => {
      try {
        if (provider === 'anthropic') {
          await chatAnthropic(await anthropicClient(), { model, messages, effort, web, files, conversation }, send, ctrl.signal, {
            containers,
            uploads,
            saveFile: saveCreatedFile,
            clientTools: useGoogle ? await googleTools() : null,
          });
        } else if (provider === 'openai') {
          await chatOpenAI(await openaiClient(), { model, messages, effort }, send, ctrl.signal, { clientTools: useGoogle ? await googleTools() : null });
        } else {
          const res = await fetch(apiUrl(baseUrl, '/v1/chat/completions'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, messages: messages.map(({ role, content }) => ({ role, content })), temperature, stream: true }),
            signal: ctrl.signal,
          });
          if (!res.ok) throw new Error(`LM Studio antwortet mit ${res.status}`);
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += dec.decode(value, { stream: true });
            let nl;
            while ((nl = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, nl).trim();
              buffer = buffer.slice(nl + 1);
              if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
              try {
                const delta = JSON.parse(line.slice(5)).choices?.[0]?.delta?.content;
                if (delta) send('delta', delta);
              } catch {}
            }
          }
          send('done');
        }
      } catch (err) {
        if (ctrl.signal.aborted) send('done');
        else {
          const SDK = provider === 'openai' ? OpenAI : Anthropic;
          const name = provider === 'openai' ? 'ChatGPT' : provider === 'anthropic' ? 'Claude' : 'LM Studio';
          send('error', provider === 'lmstudio' ? `${name}: ${err.message}` : friendlyCloudError(err, name, SDK));
        }
      } finally {
        running.delete(id);
      }
    })();
  },
  abortChat: (id) => running.get(id)?.abort(),

  // ---- Stimme (OpenAI)
  ttsCloudSpeak: async ({ text, voice, model, instructions, speed }) => {
    try {
      const c = await openaiClient();
      const classic = /^tts-1/.test(model || '');
      const classicVoices = ['alloy', 'ash', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer'];
      const res = await c.audio.speech.create({
        model: model || 'gpt-4o-mini-tts',
        voice: classic && !classicVoices.includes(voice) ? 'nova' : voice || 'nova',
        input: text,
        ...(instructions && !classic ? { instructions } : {}),
        ...(speed && speed !== 1 ? { speed } : {}),
        response_format: 'wav',
      });
      return new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      throw new Error(friendlyCloudError(err, 'OpenAI-Stimme', OpenAI));
    }
  },
  // ---- Spracherkennung in der Cloud (schneller als Whisper auf dem Handy)
  transcribeCloud: async (audio, language, model) => {
    try {
      return await transcribeOpenAI(await openaiClient(), toFile, audio, { language, model });
    } catch (err) {
      throw new Error(friendlyCloudError(err, 'Cloud-Spracherkennung', OpenAI));
    }
  },

  // ---- Medien (Videos, VRM-Figuren) im App-Speicher
  saveMedia: async (bytes, ext) => {
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${String(ext).replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin'}`;
    const uri = await writeBytes(`medien/${name}`, bytes);
    // ohne Android-Hülle (Browser-Test) gibt es keinen Dateiserver – dann direkt aus dem Speicher
    if (!Capacitor.isNativePlatform()) return URL.createObjectURL(new Blob([bytes]));
    return Capacitor.convertFileSrc(uri);
  },
  deleteMedia: async (url) => {
    const name = String(url).split('/medien/')[1];
    if (name && !name.includes('..')) await Filesystem.deleteFile({ path: `medien/${decodeURIComponent(name)}`, directory: Directory.Data }).catch(() => {});
  },

  // ---- Weitergeben (statt "Speichern unter" / "Im Ordner zeigen")
  /** „Speichern unter …“ mit Android-Dialog (Ordner und Name wählbar); ohne ihn über „Teilen“. */
  saveFileAs: async (name, bytes) => {
    const clean = cleanName(name);
    if (!window.KIFiles?.saveAs) {
      const uri = await writeBytes(clean, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), Directory.Cache);
      await Share.share({ title: clean, files: [uri] }).catch(() => {});
      return { ok: true, shared: true };
    }
    const id = String(Date.now() + Math.random());
    return new Promise((resolve) => {
      saveWaiters.set(id, resolve);
      window.KIFiles.saveAs(id, clean, toBase64(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)));
    });
  },
  /** Speicherort vorab wählen (vor längerer Berechnung): { target } oder { cancelled }. Ohne Dialog: Teilen am Ende. */
  pickSaveTarget: async (name) => {
    const clean = cleanName(name);
    if (!window.KIFiles?.pickTarget) return { target: { share: clean } };
    const id = String(Date.now() + Math.random());
    const r = await new Promise((resolve) => {
      saveWaiters.set(id, resolve);
      window.KIFiles.pickTarget(id, clean);
    });
    return r.ok ? { target: { uri: r.message } } : { cancelled: true, message: r.message };
  },
  writeSaveTarget: async (target, bytes) => {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (target?.uri) {
      const err = window.KIFiles.writeUri(target.uri, toBase64(b));
      if (err) throw new Error(err);
      return;
    }
    const uri = await writeBytes(target?.share ?? 'Datei', b, Directory.Cache);
    await Share.share({ title: target?.share, files: [uri] }).catch(() => {});
  },
  exportSave: async (name, ext, _label, bytes) => {
    const uri = await writeBytes(`${cleanName(name)}.${ext}`, bytes, Directory.Cache);
    await Share.share({ title: name, files: [uri] }).catch(() => {});
    return uri;
  },
  exportPdf: async () => {
    throw new Error('PDF gibt es auf dem Handy über „Word“ oder „Text“ und dann Teilen.');
  },
  exportShow: (uri) => Share.share({ files: [uri] }).catch(() => {}),
  openFile: async (uri) => {
    await Share.share({ files: [uri] }).catch(() => {});
    return '';
  },

  // ---- Ohne Entsprechung auf dem Handy
  modelInfo: async () => ({ dir: 'App-Speicher', bytes: 0 }),
  ttsServerInfo: notHere('Chatterbox'),
  ttsServerSpeak: notHere('Chatterbox'),
  ttsServerUpload: notHere('Chatterbox'),
  ttsServerMultilingual: notHere('Chatterbox'),
  onCommand: () => {},
  onAvatarCursor: () => {},

  // ---- Google Kalender und Aufgaben
  area: AREA,
  areaSet: async (name) => {
    try {
      localStorage.setItem('ki-bereich', name === 'privat' ? 'privat' : 'dienstlich');
    } catch {}
    setTimeout(() => location.reload(), 150);
    return name;
  },
  areaCopyKeys: async () => {
    if (AREA !== 'privat') return false;
    const from = (await readJson('schluessel.json')) ?? {};
    const to = (await readJson(areaPath('schluessel.json'))) ?? {};
    for (const k of ['anthropic', 'openai']) if (from[k]) to[k] = from[k];
    if (from.enc) to.enc = from.enc;
    await writeJson(areaPath('schluessel.json'), to);
    keys = null;
    return true;
  },
  kbLoad: async () => (AREA === 'dienstlich' ? ((await readJson('wissen.json')) ?? { docs: [] }) : null),
  kbSave: async (kb) => {
    if (AREA !== 'dienstlich') throw new Error('Firmenwissen gibt es nur im Bereich Dienstlich.');
    await writeJson('wissen.json', kb);
    return true;
  },
  googleStatus: () => google.status(),
  /** Anstehende Termine und Aufgaben (für Erinnerungen auf dem Handy). null = nicht verbunden. */
  /** Aufgabe in Google Aufgaben anlegen (Notizen „Merk dir …“). */
  googleAddTask: async ({ title, due }) => {
    if (!(await google.status()).connected) throw new Error('Google nicht verbunden');
    return googleLib.runTool(google, 'aufgabe_anlegen', { titel: title, ...(due ? { faellig: due } : {}) }, { timeZone: timeZone() });
  },
  googleUpcoming: async ({ timeZone: tz = timeZone(), hours = 48 } = {}) => {
    if (!(await google.status()).connected) return null;
    const local = (d) => d.toLocaleString('sv-SE', { timeZone: tz }).replace(' ', 'T').slice(0, 16);
    const now = new Date();
    const ev = await googleLib.runTool(google, 'kalender_termine_lesen', { von: local(now), bis: local(new Date(+now + hours * 3600e3)) }, { timeZone: tz });
    const ta = await googleLib.runTool(google, 'aufgaben_lesen', {}, { timeZone: tz });
    const until = local(new Date(+now + hours * 3600e3)).slice(0, 10);
    return { termine: ev.termine, aufgaben: (ta.aufgaben ?? []).filter((t) => t.faellig && t.faellig <= until) };
  },
  googleDisconnect: () => google.disconnect(),
  googleConnect: async ({ clientId, clientSecret }) => {
    if (!String(clientId || '').includes('.apps.googleusercontent.com')) throw new Error('Bitte die Client-ID aus der Google Cloud Console eintragen.');
    const auth = window.KIAuth;
    if (!auth) throw new Error('Anmeldung ist nur in der Android-App möglich.');
    const { verifier, challenge, state } = await googleLib.pkce();
    const port = auth.listen();
    if (!port) throw new Error('Anmeldung konnte nicht gestartet werden.');
    const redirectUri = `http://127.0.0.1:${port}`;
    const target = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Keine Anmeldung innerhalb von 5 Minuten.')), 5 * 60 * 1000);
      authWaiter = (t) => {
        clearTimeout(timer);
        authWaiter = null;
        resolve(t);
      };
      auth.open(googleLib.authUrl({ clientId, redirectUri, challenge, state }));
    });
    const q = new URL(target || '/', redirectUri).searchParams;
    if (q.get('state') !== state) throw new Error('Anmeldung abgebrochen.');
    if (q.get('error')) throw new Error(`Google: ${q.get('error')}`);
    const email = await google.exchange({ clientId, clientSecret, code: q.get('code'), verifier, redirectUri });
    return { connected: true, email };
  },

  // ---- Bild-im-Bild (siehe scripts/MainActivity.java)
  pipSupported: () => !!window.KIPip?.supported?.(),
  pipSetEnabled: (on) => window.KIPip?.setEnabled?.(!!on),
  pipEnter: () => window.KIPip?.enter?.(),
  pipSetAspect: (w, h) => window.KIPip?.setAspect?.(Math.round(w), Math.round(h)),
};

// Antwort des „Speichern unter …“-Dialogs (MainActivity.java)
const saveWaiters = new Map();
window.__kiSaveDone = (id, ok, msg) => {
  saveWaiters.get(id)?.({ ok, cancelled: !ok && msg === 'abgebrochen', message: msg });
  saveWaiters.delete(id);
};

// Native Seite meldet den Wechsel ins/aus dem Bild-im-Bild-Fenster: dann nur die Figur zeigen
window.__setPip = (on) => {
  document.documentElement.classList.toggle('pip', !!on);
  window.dispatchEvent(new Event('resize'));
};
if (window.KIPip?.supported?.()) document.documentElement.classList.add('pip-ok');

// ---------------------------------------------------------------- Dateien auswählen
// Die versteckten <input type="file">-Felder der Oberfläche öffnen in der Android-Hülle nicht zuverlässig die
// Dateiauswahl. Darum geht jeder Aufruf über die Android-Dateiauswahl; die gewählten Dateien landen danach im
// Feld, und die Oberfläche bekommt ganz normal ein "change"-Ereignis – alle Hochlade-Knöpfe funktionieren so.
const EXT_TYPES = { '.vrm': ['model/gltf-binary', 'application/octet-stream'], '.json': ['application/json', 'application/octet-stream'] };
const nativeClick = HTMLInputElement.prototype.click;

/** Nur Endungen (z. B. ".vrm") würden in der Android-Auswahl alle Dateien ausgrauen – dann alles zulassen. */
const pickAccept = (accept) => (String(accept || '').split(',').some((a) => a.trim().startsWith('.')) ? '' : accept || '');
/** Passt die Endung zur erwarteten (z. B. nur .vrm)? Liefert sonst eine Meldung. */
function extMismatch(accept, names) {
  const exts = String(accept || '').split(',').map((a) => a.trim().toLowerCase()).filter((a) => a.startsWith('.'));
  if (!exts.length) return '';
  const bad = names.find((n) => !exts.some((e) => String(n).toLowerCase().endsWith(e)));
  return bad ? `„${bad}“ passt nicht – bitte eine Datei mit ${exts.join(' / ')} wählen.` : '';
}

/** Gewählte Dateien in das Feld der Oberfläche übernehmen und dessen "change" auslösen. */
function deliver(input, fileList) {
  const dt = new DataTransfer();
  for (const f of fileList) dt.items.add(f);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * Auswahlfenster mit zwei unabhängigen Wegen:
 *  1. ein echtes, sichtbares Dateifeld zum direkten Antippen (Standardweg der Android-WebView)
 *  2. die Android-Dateiauswahl über die Erweiterung (FilePicker)
 * Jede Rückmeldung erscheint im Fenster – so ist auf dem Handy sichtbar, was passiert.
 */
function openPickSheet(target) {
  document.getElementById('pickSheet')?.remove();
  const sheet = document.createElement('div');
  sheet.id = 'pickSheet';
  sheet.innerHTML = `
    <div class="ps-box">
      <h3>Datei auswählen</h3>
      <label class="ps-btn ps-main">📁 Datei auswählen
        <input type="file" ${target.multiple ? 'multiple' : ''} ${pickAccept(target.accept) ? `accept="${pickAccept(target.accept)}"` : ''} />
      </label>
      <button class="ps-btn" data-act="plugin">Android-Dateiauswahl (anderer Weg)</button>
      <button class="ps-btn ps-cancel" data-act="cancel">Abbrechen</button>
      <p class="ps-info"></p>
    </div>`;
  document.body.appendChild(sheet);
  const info = sheet.querySelector('.ps-info');
  const say = (t) => (info.textContent = t);
  const close = () => sheet.remove();
  const direct = sheet.querySelector('input[type=file]');
  direct.addEventListener('click', () => say('Dateiauswahl wird geöffnet …'));
  direct.addEventListener('change', () => {
    if (!direct.files?.length) return say('Keine Datei gewählt.');
    const wrong = extMismatch(target.accept, [...direct.files].map((f) => f.name));
    if (wrong) return say(wrong);
    const files = [...direct.files];
    close();
    deliver(target, files);
  });
  sheet.querySelector('[data-act=cancel]').onclick = close;
  sheet.addEventListener('click', (e) => e.target === sheet && close());
  sheet.querySelector('[data-act=plugin]').onclick = async () => {
    const picker = window.__testPicker ?? (Capacitor.isNativePlatform() ? FilePicker : null);
    if (!picker) return say('Android-Dateiauswahl ist hier nicht verfügbar.');
    say('Android-Dateiauswahl wird geöffnet …');
    try {
      const accept = (target.accept || '').split(',').map((s) => s.trim()).filter(Boolean);
      // Endungen wie .vrm kennt Android nicht als Dateityp – dann alle Dateien anbieten und danach prüfen
      const types = accept.some((a) => a.startsWith('.')) ? [] : accept;
      const { files } = await picker.pickFiles({ ...(types.length ? { types } : {}), limit: target.multiple ? 0 : 1 });
      if (!files?.length) return say('Keine Datei gewählt.');
      const wrong = extMismatch(target.accept, files.map((f) => f.name));
      if (wrong) return say(wrong);
      say('Datei wird geladen …');
      const out = [];
      for (const f of files) {
        const blob = f.blob ?? (await (await fetch(f.webPath ?? Capacitor.convertFileSrc(f.path))).blob());
        out.push(new File([blob], f.name || 'Datei', { type: f.mimeType || blob.type }));
      }
      close();
      deliver(target, out);
    } catch (e) {
      const msg = String(e?.message ?? e);
      say(/cancel/i.test(msg) ? 'Abgebrochen.' : `Android-Dateiauswahl nicht möglich: ${msg}`);
    }
  };
}

// Jeder "Hochladen"-Knopf der Oberfläche ruft input.click() auf – auf dem Handy öffnet das unser Auswahlfenster
HTMLInputElement.prototype.click = function () {
  if (this.type !== 'file' || this.closest?.('#pickSheet')) return nativeClick.call(this);
  openPickSheet(this);
};

// Alles Übrige (Fensterfunktionen, freie Figur …) gibt es auf dem Handy nicht: still ignorieren
window.desktop = new Proxy(api, { get: (t, k) => (k in t ? t[k] : () => {}) });
document.documentElement.classList.add('mobile');
// Eingabefeld beim Antippen über die Tastatur schieben (sonst verdeckt sie z. B. die Schlüsselfelder)
document.addEventListener('focusin', (e) => {
  if (e.target.matches?.('input, textarea, select')) setTimeout(() => e.target.scrollIntoView({ block: 'center', behavior: 'smooth' }), 350);
});

// ---------------------------------------------------------------- Regler auf dem Handy
// Beim Scrollen streift der Finger leicht einen Regler und verstellt ihn. Darum gilt hier:
//  - Antippen der Leiste verstellt nichts (der Wert springt zurück),
//  - der Regler bewegt sich erst, wenn der Finger deutlich zur Seite zieht – senkrechtes Wischen scrollt,
//  - neben jedem Regler gibt es –/+ für genaues Einstellen.
let rangeGesture = null;
document.addEventListener(
  'pointerdown',
  (e) => {
    const el = e.target;
    if (e.pointerType === 'mouse' || !(el instanceof HTMLInputElement) || el.type !== 'range') return;
    rangeGesture = { el, x: e.clientX, y: e.clientY, value: el.value, ok: false };
  },
  true,
);
document.addEventListener(
  'pointermove',
  (e) => {
    const g = rangeGesture;
    if (!g || g.ok) return;
    const dx = Math.abs(e.clientX - g.x);
    const dy = Math.abs(e.clientY - g.y);
    if (dx > 12 && dx > dy * 1.5) g.ok = true;
  },
  true,
);
const guardRange = (e) => {
  const g = rangeGesture;
  if (!g || g.ok || e.target !== g.el) return;
  // noch kein seitliches Ziehen: Änderung verwerfen und an die App nicht weitergeben
  e.stopImmediatePropagation();
  g.el.value = g.value;
};
document.addEventListener('input', guardRange, true);
document.addEventListener('change', guardRange, true);
const endRange = () => {
  const g = rangeGesture;
  rangeGesture = null;
  if (g && !g.ok && g.el.value !== g.value) g.el.value = g.value;
};
document.addEventListener('pointerup', endRange, true);
document.addEventListener('pointercancel', endRange, true);

/** –/+ neben einen Regler setzen (einmal je Regler). */
function addRangeButtons(r) {
  if (r.dataset.steps || r.closest('.range-step, .b2v') || r.classList.contains('vt-pos')) return;
  r.dataset.steps = '1';
  const wrap = document.createElement('span');
  wrap.className = 'range-step';
  r.replaceWith(wrap);
  const btn = (label, dir) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.onclick = (e) => {
      e.preventDefault();
      const min = +r.min || 0;
      const max = r.max === '' ? 100 : +r.max;
      const step = r.step && r.step !== 'any' ? +r.step : (max - min) / 100;
      const fine = Math.max(step, (max - min) / 50);
      const v = Math.min(max, Math.max(min, +r.value + dir * fine));
      r.value = String(Math.round(v / step) * step);
      r.dispatchEvent(new Event('input', { bubbles: true }));
      r.dispatchEvent(new Event('change', { bubbles: true }));
    };
    return b;
  };
  wrap.append(btn('−', -1), r, btn('+', 1));
}
const scanRanges = (root = document) => root.querySelectorAll?.('input[type=range]').forEach(addRangeButtons);
new MutationObserver((list) => {
  for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1) (n.matches?.('input[type=range]') ? addRangeButtons(n) : scanRanges(n));
}).observe(document.documentElement, { childList: true, subtree: true });
document.addEventListener('DOMContentLoaded', () => scanRanges());
scanRanges();
