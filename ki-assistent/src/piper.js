// Eigene, schlanke Piper-Anbindung (neuronale Sprachausgabe, komplett lokal).
//
// Warum nicht direkt piper-tts-web? Die Bibliothek übergibt die Laut-IDs des Phonemizers
// unverändert an das Stimmmodell. Bei deutschen Stimmen passen diese nicht zur Tabelle
// des Modells (z. B. wird "ç" wie in "ich" als zwei Zeichen ausgegeben) – Folge: falsche
// Aussprache oder der Fehler "indices element out of data bounds". Hier werden die Laute
// deshalb mit der phoneme_id_map der jeweiligen Stimme neu übersetzt.
import * as ort from 'onnxruntime-web/wasm';
import { createPiperPhonemize } from '../node_modules/@mintplex-labs/piper-tts-web/dist/piper-o91UDS6e.js';

const base = (p) => new URL(p, location.href).href;
const VOICE_BASE = base('models/hf/diffusionstudio/piper-voices/resolve/main/');

ort.env.wasm.wasmPaths = base('wasm/ort18/');
// Mehrere CPU-Kerne nutzen, wenn die Seite "cross-origin isolated" ist (setzt der Hauptprozess per Header).
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1)) : 1;

export function voicePath(id) {
  const [locale, name, quality] = id.split('-');
  return `${locale.split('_')[0]}/${locale}/${name}/${quality}/${id}.onnx`;
}

async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download fehlgeschlagen (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!onProgress || !res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress({ loaded, total });
  }
  const out = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// ---------------------------------------------------------------- Phonemizer (espeak-ng)
let phonemizerAssets = null;
function loadPhonemizerAssets() {
  phonemizerAssets ??= Promise.all([
    fetch(base('wasm/piper/piper_phonemize.wasm')).then((r) => r.arrayBuffer()),
    fetch(base('wasm/piper/piper_phonemize.data')).then((r) => r.arrayBuffer()),
  ]);
  return phonemizerAssets;
}

// Der Lautwandler (espeak-ng) wird einmal geladen und danach wiederverwendet.
let phonemizerModule = null;
let phonemizerOut = '';
function getPhonemizer() {
  phonemizerModule ??= loadPhonemizerAssets()
    .then(([wasm, data]) =>
      createPiperPhonemize({
        wasmBinary: wasm,
        getPreloadedPackage: () => data,
        noExitRuntime: true,
        print: (line) => (phonemizerOut += line),
        printErr: () => {},
        locateFile: (f) => base(`wasm/piper/${f.split('/').pop()}`),
      }),
    )
    .catch((e) => {
      phonemizerModule = null;
      throw e;
    });
  return phonemizerModule;
}

let phonemizeChain = Promise.resolve();

/** Liefert { phonemes, phoneme_ids } für einen Text in der angegebenen espeak-Sprache. */
export function phonemize(text, espeakVoice) {
  const run = phonemizeChain.then(async () => {
    const mod = await getPhonemizer();
    phonemizerOut = '';
    mod.callMain(['-l', espeakVoice, '--input', JSON.stringify([{ text }]), '--espeak_data', '/espeak-ng-data']);
    return JSON.parse(phonemizerOut);
  });
  phonemizeChain = run.catch(() => {});
  return run;
}

/**
 * Übersetzt die Ausgabe des Phonemizers in die IDs der Stimme.
 * Die Standard-IDs des Phonemizers (1 = Satzanfang, 2 = Satzende, 0 = Pause) liefern
 * die Satzgrenzen; jeder andere Eintrag gehört der Reihe nach zu einem Laut in `phonemes`.
 */
export function mapPhonemeIds({ phonemes, phoneme_ids }, idMap) {
  const flat = phonemes.flat();
  // Tokenfolge aufbauen: Satzanfang/-ende und die Laute in ihrer Reihenfolge
  const tokens = [];
  let k = 0;
  for (const id of phoneme_ids) {
    if (id === 0) continue;
    if (id === 1) tokens.push('^');
    else if (id === 2) tokens.push('$');
    else if (k < flat.length) tokens.push({ p: flat[k++] });
  }
  const BOS = idMap['^'] ?? [1];
  const EOS = idMap['$'] ?? [2];
  const PAD = idMap['_'] ?? [0];
  const ids = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '^') ids.push(...BOS, ...PAD);
    else if (t === '$') ids.push(...EOS);
    else {
      // Kombinierende Zeichen (z. B. c + ̧ = ç) wieder zusammensetzen
      const next = tokens[i + 1];
      if (next?.p && /^\p{M}$/u.test(next.p)) {
        // Die Stimme kann den Laut zusammengesetzt (ç) oder zerlegt (c + ̧) in ihrer Tabelle führen
        const pair = t.p + next.p;
        const key = [pair.normalize('NFC'), pair.normalize('NFD'), pair].find((k) => idMap[k]);
        if (key) {
          ids.push(...idMap[key], ...PAD);
          i++;
          continue;
        }
      }
      if (idMap[t.p]) ids.push(...idMap[t.p], ...PAD);
    }
  }
  return ids;
}

// ---------------------------------------------------------------- Stimmen
const voices = new Map();

async function loadVoice(id, onProgress) {
  if (!voices.has(id)) {
    const p = (async () => {
      const path = voicePath(id);
      const config = await (await fetch(VOICE_BASE + path + '.json')).json().catch(() => {
        throw new Error(`Stimme ${id} konnte nicht geladen werden`);
      });
      const model = await fetchWithProgress(VOICE_BASE + path, onProgress);
      const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
      return { config, session };
    })();
    voices.set(id, p);
    p.catch(() => voices.delete(id));
  }
  return voices.get(id);
}

/** Für Tests/Fehlersuche: Tabelle und IDs eines Textes ansehen. */
export async function debugVoice(id, text) {
  const { config } = await loadVoice(id);
  const ph = await phonemize(text, config.espeak?.voice ?? 'de');
  const special = Object.entries(config.phoneme_id_map).filter(([k]) => /[^\x20-\x7e]/.test(k) && /[çç]/u.test(k));
  return { num_symbols: config.num_symbols, special, phonemes: ph.phonemes, ids: mapPhonemeIds(ph, config.phoneme_id_map) };
}

export function preloadVoice(id, onProgress) {
  return loadVoice(id, onProgress);
}

let synthChain = Promise.resolve();

/** Erzeugt Sprache. rate > 1 = schneller (ohne Tonhöhe zu verändern). Liefert { audio, sampleRate }. */
export function synthesize(text, voiceId, { rate = 1, onProgress } = {}) {
  const run = synthChain.then(async () => {
    const { config, session } = await loadVoice(voiceId, onProgress);
    const clean = text.replace(/[\^$_]/g, ' ');
    const ph = await phonemize(clean, config.espeak?.voice ?? 'de');
    const ids = mapPhonemeIds(ph, config.phoneme_id_map);
    if (ids.length < 3) return null;
    const inf = config.inference ?? {};
    const feeds = {
      input: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
      input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
      scales: new ort.Tensor(
        'float32',
        Float32Array.from([inf.noise_scale ?? 0.667, (inf.length_scale ?? 1) / rate, inf.noise_w ?? 0.8]),
        [3],
      ),
    };
    if (config.num_speakers > 1) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([0n]), [1]);
    const { output } = await session.run(feeds);
    return { audio: output.data, sampleRate: config.audio?.sample_rate ?? 22050 };
  });
  synthChain = run.catch(() => {});
  return run;
}
