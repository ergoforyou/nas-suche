// Android-App (Capacitor): stellt der Oberfläche dieselbe Schnittstelle bereit wie auf dem PC der
// Electron-Hauptprozess (window.desktop). Daten und Schlüssel liegen im privaten App-Speicher,
// Claude/ChatGPT werden direkt aus der App angesprochen, Dateien über "Teilen" weitergegeben.
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { FilePicker } from '@capawesome/capacitor-file-picker';
import Anthropic, { toFile } from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import cloud from '../../cloud.js';

const { chatAnthropic, chatOpenAI, friendlyCloudError } = cloud;

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
// Schlüssel liegen verschlüsselt im App-Speicher: Der AES-Schlüssel dazu steckt im Android-Keystore
// (Hardware-geschützt, lässt sich nicht auslesen oder kopieren). window.KIKeys kommt aus MainActivity.java.
const vault = () => (window.KIKeys?.available?.() ? window.KIKeys : null);
const PROVIDERS = ['anthropic', 'openai'];
let keys = null;
async function loadKeys() {
  const file = (await readJson('schluessel.json')) ?? {};
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
  if (!v) return writeJson('schluessel.json', k);
  const file = { enc: 1 };
  for (const p of PROVIDERS) {
    if (!k[p]) continue;
    const enc = v.encrypt(k[p]);
    if (!enc) throw new Error('Schlüssel konnte nicht verschlüsselt werden.');
    file[p] = enc;
  }
  await writeJson('schluessel.json', file);
}
const getKeys = async () => (keys ??= await loadKeys());
// für den Emulator-Test: Liegt die Schlüsseldatei wirklich verschlüsselt vor?
window.__keyFile = () => readJson('schluessel.json');

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

const running = new Map();
const containers = new Map();
const uploads = new Map();
const apiUrl = (base, p) => String(base).replace(/\/+$/, '') + p;

async function saveCreatedFile(name, bytes) {
  const uri = await writeBytes(`Dateien/${Date.now()}-${cleanName(name)}`, bytes);
  return uri;
}

/** WAV (16 kHz, mono, 16 bit) für die Cloud-Spracherkennung. */
function toWav(samples, rate = 16000) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  return new Uint8Array(buf);
}

const notHere = (what) => async () => {
  throw new Error(`${what} gibt es nur in der PC-Version.`);
};

const api = {
  edition: 'mobile',
  platform: 'android',

  // ---- Daten
  loadData: async () => (data = await readJson('daten.json')),
  saveData: async (patch) => {
    data = { ...(data ?? {}), ...patch };
    await writeJson('daten.json', data);
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
    const { id, provider = 'anthropic', baseUrl, model, messages, temperature, effort, web, files, conversation } = req;
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
          });
        } else if (provider === 'openai') {
          await chatOpenAI(await openaiClient(), { model, messages, effort }, send, ctrl.signal);
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
  transcribeCloud: async (audio, language) => {
    const c = await openaiClient();
    const res = await c.audio.transcriptions.create({
      file: await toFile(toWav(audio), 'sprache.wav', { type: 'audio/wav' }),
      model: 'gpt-4o-mini-transcribe',
      ...(language ? { language: language === 'english' ? 'en' : 'de' } : {}),
    });
    return (res.text ?? '').trim();
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

  // ---- Bild-im-Bild (siehe scripts/MainActivity.java)
  pipSupported: () => !!window.KIPip?.supported?.(),
  pipSetEnabled: (on) => window.KIPip?.setEnabled?.(!!on),
  pipEnter: () => window.KIPip?.enter?.(),
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
        <input type="file" ${target.multiple ? 'multiple' : ''} ${target.accept ? `accept="${target.accept}"` : ''} />
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
      const types = [...new Set(accept.flatMap((a) => (a.startsWith('.') ? EXT_TYPES[a.toLowerCase()] ?? ['application/octet-stream'] : [a])))];
      const { files } = await picker.pickFiles({ ...(types.length ? { types } : {}), limit: target.multiple ? 0 : 1 });
      if (!files?.length) return say('Keine Datei gewählt.');
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
