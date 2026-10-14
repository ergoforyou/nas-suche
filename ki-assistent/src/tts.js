// Sprachausgabe: Piper (lokales neuronales TTS) oder die Systemstimmen des Betriebssystems.
// Text wird satzweise in eine Warteschlange gelegt, damit die Antwort schon während
// des Generierens gesprochen werden kann. Pro Satz wird die Sprache erkannt und die
// passende Stimme (Deutsch/Englisch) gewählt.
import { synthesize, preloadVoice } from './piper.js';

export const PIPER_VOICES = {
  de: [
    ['de_DE-thorsten-medium', 'Thorsten – männlich (empfohlen, schnell & deutlich)'],
    ['de_DE-thorsten-high', 'Thorsten – männlich, hohe Qualität (langsamer)'],
    ['de_DE-thorsten_emotional-medium', 'Thorsten emotional – männlich'],
    ['de_DE-karlsson-low', 'Karlsson – männlich'],
    ['de_DE-pavoque-low', 'Pavoque – männlich'],
    ['de_DE-kerstin-low', 'Kerstin – weiblich'],
    ['de_DE-ramona-low', 'Ramona – weiblich'],
    ['de_DE-eva_k-x_low', 'Eva K. – weiblich (einfach)'],
    ['de_DE-mls-medium', 'MLS – gemischt'],
  ],
  en: [
    ['en_US-lessac-high', 'Lessac (US) – female, best quality'],
    ['en_US-ryan-high', 'Ryan (US) – male, best quality'],
    ['en_US-amy-medium', 'Amy (US) – female'],
    ['en_US-joe-medium', 'Joe (US) – male'],
    ['en_US-hfc_female-medium', 'HFC (US) – female'],
    ['en_US-hfc_male-medium', 'HFC (US) – male'],
    ['en_GB-alba-medium', 'Alba (UK) – female'],
    ['en_GB-northern_english_male-medium', 'Northern English (UK) – male'],
    ['en_GB-cori-high', 'Cori (UK) – female, best quality'],
  ],
};
export const DEFAULT_VOICES = { de: 'de_DE-thorsten-medium', en: 'en_US-lessac-high' };

// Abkürzungen ausschreiben, damit sie nicht buchstabiert werden ("z. B." -> "zum Beispiel")
const ABBREVIATIONS = [
  [/\bz\.\s?B\./g, 'zum Beispiel'],
  [/\bd\.\s?h\./g, 'das heißt'],
  [/\bu\.\s?a\./g, 'unter anderem'],
  [/\bu\.\s?U\./g, 'unter Umständen'],
  [/\bo\.\s?Ä\./g, 'oder Ähnliches'],
  [/\bz\.\s?T\./g, 'zum Teil'],
  [/\bbzw\./g, 'beziehungsweise'],
  [/\busw\./g, 'und so weiter'],
  [/\betc\./g, 'et cetera'],
  [/\bca\./g, 'circa'],
  [/\bevtl\./g, 'eventuell'],
  [/\bggf\./g, 'gegebenenfalls'],
  [/\binkl\./g, 'inklusive'],
  [/\bexkl\./g, 'exklusive'],
  [/\bvgl\./g, 'vergleiche'],
  [/\bsog\./g, 'sogenannte'],
  [/\bNr\./g, 'Nummer'],
  [/\bDr\./g, 'Doktor'],
  [/\bProf\./g, 'Professor'],
  [/\bMio\./g, 'Millionen'],
  [/\bMrd\./g, 'Milliarden'],
  [/\be\.\s?g\./g, 'for example'],
  [/\bi\.\s?e\./g, 'that is'],
  [/(\d)\s?€/g, '$1 Euro'],
  [/€\s?(\d[\d.,]*)/g, '$1 Euro'],
  [/(\d)\s?%/g, '$1 Prozent'],
];

export function cleanForSpeech(text) {
  for (const [re, rep] of ABBREVIATIONS) text = text.replace(re, rep);
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*\|.*\|\s*$/gm, ' ') // Tabellenzeilen nicht vorlesen
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'Link')
    .replace(/^\s*([-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_#>|~^$]+/g, ' ')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/[^\p{Script=Latin}\p{N}\p{P}\p{Zs}\s€$%&+=°§]/gu, ' ') // fremde Schriften überspringen
    .replace(/\s+/g, ' ')
    .trim();
}

const DE_WORDS = new Set(
  'der die das und ist nicht ich du wir sie es ein eine einen mit auf für von zu den dem im ist sind war hat haben auch noch nur wie was wenn dann aber oder schon sehr gut kann können wird werden mir dir mich dich sich hier dort heute gerne bitte danke ja nein über bei nach aus'.split(
    ' ',
  ),
);
const EN_WORDS = new Set(
  'the and is are was were not you we they it a an with on for of to in this that have has be will would can could do does did what when if then but or very good me my your here there today please thanks yes no about at from just like so'.split(
    ' ',
  ),
);

/** Grobe Spracherkennung für einen Satz: 'de' oder 'en' (sonst Standard). */
export function detectLanguage(text, fallback = 'de') {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  let de = 0;
  let en = 0;
  for (const w of words) {
    if (DE_WORDS.has(w)) de++;
    if (EN_WORDS.has(w)) en++;
  }
  if (/[äöüß]/i.test(text)) de += 2;
  if (de === en) return fallback;
  return de > en ? 'de' : 'en';
}

/** Teilt laufend eintreffenden Text in fertige Sätze. */
export class SentenceSplitter {
  constructor(onSentence) {
    this.buf = '';
    this.onSentence = onSentence;
    this.inCode = false;
    this.first = true;
  }
  push(text) {
    this.buf += text;
    // Damit die Stimme schnell einsetzt: das allererste Stück schon am ersten Komma abschicken
    if (this.first && !this.inCode) {
      const m = /^([^\n`]{12,}?[,;–—])\s+/.exec(this.buf);
      if (m) {
        this.first = false;
        this.buf = this.buf.slice(m[0].length);
        this.onSentence(m[1].trim());
      }
    }
    // Satzende: . ! ? : oder Zeilenumbruch, gefolgt von Leerraum. Abkürzungen wie "z.B." grob abfangen.
    const re = /([\s\S]*?[^\s.]{2,}[.!?…:]+["»“)]?)(\s+)|([\s\S]*?)\n{1,}/;
    let m;
    while ((m = re.exec(this.buf))) {
      const sentence = (m[1] ?? m[3] ?? '').trim();
      this.buf = this.buf.slice(m[0].length);
      this.first = false;
      // Codeblöcke komplett überspringen
      const fences = (sentence.match(/```/g) ?? []).length;
      const wasInCode = this.inCode;
      if (fences % 2) this.inCode = !this.inCode;
      if (sentence && !wasInCode && !fences) this.onSentence(sentence);
    }
  }
  flush() {
    const rest = this.buf.trim();
    this.buf = '';
    if (rest && !this.inCode && !rest.includes('```')) this.onSentence(rest);
    this.inCode = false;
  }
}

export class SpeechOutput {
  constructor({ onLevel, onSpeakingChange, onStatus } = {}) {
    this.onLevel = onLevel ?? (() => {});
    this.onSpeakingChange = onSpeakingChange ?? (() => {});
    this.onStatus = onStatus ?? (() => {});
    this.engine = 'piper';
    this.voices = { ...DEFAULT_VOICES };
    this.language = 'de';
    this.systemVoice = '';
    this.rate = 1;
    this.maxSentences = 0;
    this.queue = [];
    this.playing = false;
    this.generation = 0;
    this.spokenInTurn = 0;
    this.ctx = null;
  }

  configure({ engine, voices, language, systemVoice, rate, maxSentences, server, cloud }) {
    if (server) this.server = { ...this.server, ...server };
    if (cloud) this.cloud = { ...this.cloud, ...cloud };
    if (engine) this.engine = engine;
    if (voices) this.voices = { ...DEFAULT_VOICES, ...voices };
    if (language) this.language = language;
    if (systemVoice !== undefined) this.systemVoice = systemVoice;
    if (rate) this.rate = rate;
    if (maxSentences !== undefined) this.maxSentences = maxSentences;
  }

  static systemVoices() {
    return speechSynthesis.getVoices();
  }

  voiceFor(text) {
    const lang = detectLanguage(text, this.language);
    return this.voices[lang] ?? this.voices[this.language];
  }

  /** Sprach-Server (Chatterbox): ein Satz -> Audio. Anfragen laufen nacheinander. */
  synthServer(text) {
    const v = this.server ?? {};
    const lang = detectLanguage(text, this.language);
    const [mode, file] = (v.voice || '').split(/:(.*)/s);
    const body = {
      text,
      output_format: 'wav',
      split_text: true,
      chunk_size: 250,
      language: lang,
      ...(mode === 'clone' ? { voice_mode: 'clone', reference_audio_filename: file } : {}),
      ...(mode === 'predefined' ? { voice_mode: 'predefined', predefined_voice_id: file } : {}),
      ...(v.exaggeration != null ? { exaggeration: v.exaggeration } : {}),
      ...(v.cfg != null ? { cfg_weight: v.cfg } : {}),
      ...(v.temperature != null ? { temperature: v.temperature } : {}),
      ...(this.rate !== 1 ? { speed_factor: this.rate } : {}),
    };
    const prev = this.serverChain ?? Promise.resolve();
    const run = prev.then(async () => {
      const bytes = await window.desktop.ttsServerSpeak(v.url || 'http://localhost:8004', body);
      this.ctx ??= new AudioContext();
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const buf = await this.ctx.decodeAudioData(ab);
      return { audio: buf.getChannelData(0), sampleRate: buf.sampleRate };
    });
    this.serverChain = run.catch(() => {});
    return run;
  }

  /** Cloud-Stimme (OpenAI): ein Satz -> Audio. Anfragen laufen parallel (die Warteschlange hält die Reihenfolge). */
  synthCloud(text) {
    const c = this.cloud ?? {};
    const run = (async () => {
      const bytes = await window.desktop.ttsCloudSpeak({
        text,
        voice: c.voice,
        model: c.model,
        instructions: c.instructions,
        speed: this.rate,
      });
      this.ctx ??= new AudioContext();
      const buf = await this.ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      return { audio: buf.getChannelData(0), sampleRate: buf.sampleRate };
    })();
    return run;
  }

  async preload(onProgress) {
    if (this.engine !== 'piper') return;
    for (const id of new Set([this.voices[this.language], this.voices[this.language === 'de' ? 'en' : 'de']])) {
      await preloadVoice(id, onProgress);
    }
  }

  /** Neue Antwort beginnt: Satzzähler für "maximal vorlesen" zurücksetzen. */
  newTurn() {
    this.spokenInTurn = 0;
  }

  /** Satz in die Warteschlange legen. Piper-Audio wird sofort vorberechnet. */
  enqueue(text) {
    const clean = cleanForSpeech(text);
    if (!clean || !/[\p{L}\p{N}]/u.test(clean)) return;
    if (this.maxSentences && this.spokenInTurn >= this.maxSentences) return;
    this.spokenInTurn++;
    const gen = this.generation;
    const item = { text: clean, gen };
    if (this.engine !== 'system') {
      const job =
        this.engine === 'server'
          ? this.synthServer(clean)
          : this.engine === 'cloud'
            ? this.synthCloud(clean)
            : synthesize(clean, this.voiceFor(clean), {
              rate: this.rate,
              onProgress: ({ loaded, total }) =>
                total && this.onStatus(`Stimme wird geladen … ${Math.round((loaded / total) * 100)} % (nur beim ersten Mal)`),
            });
      item.audio = job
        .then((r) => {
          this.onStatus('');
          return r;
        })
        .catch((err) => {
          // Ein fehlerhafter Satz soll nicht die ganze Ausgabe stoppen.
          console.warn('Sprachausgabe:', clean, err);
          this.onStatus(`Sprachausgabe: ein Satz wurde übersprungen (${err.message})`);
          return null;
        });
    }
    this.queue.push(item);
    if (!this.playing) this.playNext();
  }

  async playNext() {
    const item = this.queue.shift();
    if (!item) {
      this.playing = false;
      this.onLevel(0);
      this.onSpeakingChange(false);
      return;
    }
    if (!this.playing) {
      this.playing = true;
      this.onSpeakingChange(true);
    }
    try {
      if (item.audio) {
        const result = await item.audio;
        if (result && item.gen === this.generation) await this.playPcm(result.audio, result.sampleRate);
      } else {
        await this.speakSystem(item.text);
      }
    } catch (err) {
      this.onStatus(`Sprachausgabe-Fehler: ${err.message}`);
    }
    if (item.gen === this.generation) this.playNext();
  }

  async playPcm(pcm, sampleRate) {
    this.ctx ??= new AudioContext();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const buf = this.ctx.createBuffer(1, pcm.length, sampleRate);
    buf.copyToChannel(pcm instanceof Float32Array ? pcm : Float32Array.from(pcm), 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    analyser.connect(this.ctx.destination);
    const samples = new Float32Array(analyser.fftSize);
    // setInterval statt requestAnimationFrame: läuft auch, wenn das Chatfenster versteckt ist.
    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const v of samples) sum += v * v;
      this.onLevel(Math.min(1, Math.sqrt(sum / samples.length) * 6));
    }, 33);
    this.currentSource = src;
    await new Promise((resolve) => {
      src.onended = resolve;
      src.start();
    });
    clearInterval(timer);
    this.currentSource = null;
    this.onLevel(0);
  }

  speakSystem(text) {
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      const voice = speechSynthesis.getVoices().find((v) => v.name === this.systemVoice);
      if (voice) u.voice = voice;
      u.lang = voice?.lang ?? (this.language === 'en' ? 'en-US' : 'de-DE');
      u.rate = this.rate;
      // Systemstimmen liefern kein Audiosignal – Mundbewegung wird simuliert.
      let t = 0;
      const timer = setInterval(() => {
        t += 1;
        this.onLevel(0.25 + 0.55 * Math.abs(Math.sin(t * 0.9)) * Math.random());
      }, 90);
      const done = () => {
        clearInterval(timer);
        this.onLevel(0);
        resolve();
      };
      u.onend = done;
      u.onerror = done;
      speechSynthesis.speak(u);
    });
  }

  /** Alles sofort abbrechen (z. B. wenn der Nutzer dazwischenredet). */
  stop() {
    this.generation++;
    this.queue = [];
    try {
      this.currentSource?.stop();
    } catch {}
    speechSynthesis.cancel();
    this.playing = false;
    this.onLevel(0);
    this.onSpeakingChange(false);
  }

  get speaking() {
    return this.playing;
  }
}
