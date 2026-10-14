// Sprachausgabe: Piper (lokales neuronales TTS) oder die Systemstimmen des Betriebssystems.
// Text wird satzweise in eine Warteschlange gelegt, damit die Antwort schon während
// des Generierens gesprochen werden kann.
import { TtsSession } from '@mintplex-labs/piper-tts-web';

const WASM = {
  onnxWasm: new URL('wasm/ort18/', location.href).href,
  piperData: new URL('wasm/piper/piper_phonemize.data', location.href).href,
  piperWasm: new URL('wasm/piper/piper_phonemize.wasm', location.href).href,
};

export const PIPER_VOICES = [
  ['de_DE-thorsten-medium', 'Thorsten (männlich, mittel)'],
  ['de_DE-thorsten-high', 'Thorsten (männlich, hoch)'],
  ['de_DE-thorsten_emotional-medium', 'Thorsten emotional (männlich)'],
  ['de_DE-karlsson-low', 'Karlsson (männlich)'],
  ['de_DE-pavoque-low', 'Pavoque (männlich)'],
  ['de_DE-eva_k-x_low', 'Eva K. (weiblich)'],
  ['de_DE-kerstin-low', 'Kerstin (weiblich)'],
  ['de_DE-ramona-low', 'Ramona (weiblich)'],
  ['de_DE-mls-medium', 'MLS (gemischt)'],
  ['en_US-hfc_female-medium', 'English – HFC female'],
  ['en_US-ryan-medium', 'English – Ryan'],
];

export function cleanForSpeech(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' Codebeispiel. ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'Link')
    .replace(/[*_#>|~]+/g, ' ')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Teilt laufend eintreffenden Text in fertige Sätze. */
export class SentenceSplitter {
  constructor(onSentence) {
    this.buf = '';
    this.onSentence = onSentence;
  }
  push(text) {
    this.buf += text;
    // Satzende: . ! ? : oder Zeilenumbruch, gefolgt von Leerraum. Abkürzungen wie "z.B." grob abfangen.
    const re = /([\s\S]*?[^\s.]{2,}[.!?…:]+["»“)]?)(\s+)|([\s\S]*?)\n{1,}/;
    let m;
    while ((m = re.exec(this.buf))) {
      const sentence = (m[1] ?? m[3] ?? '').trim();
      this.buf = this.buf.slice(m[0].length);
      if (sentence) this.onSentence(sentence);
    }
  }
  flush() {
    const rest = this.buf.trim();
    this.buf = '';
    if (rest) this.onSentence(rest);
  }
}

export class SpeechOutput {
  constructor({ onLevel, onSpeakingChange, onStatus } = {}) {
    this.onLevel = onLevel ?? (() => {});
    this.onSpeakingChange = onSpeakingChange ?? (() => {});
    this.onStatus = onStatus ?? (() => {});
    this.engine = 'piper';
    this.piperVoice = 'de_DE-thorsten-medium';
    this.systemVoice = '';
    this.rate = 1;
    this.queue = [];
    this.playing = false;
    this.generation = 0;
    this.session = null;
    this.sessionVoice = null;
    this.ctx = null;
  }

  configure({ engine, piperVoice, systemVoice, rate }) {
    if (engine) this.engine = engine;
    if (piperVoice) this.piperVoice = piperVoice;
    if (systemVoice !== undefined) this.systemVoice = systemVoice;
    if (rate) this.rate = rate;
  }

  static systemVoices() {
    return speechSynthesis.getVoices();
  }

  async getSession(onProgress) {
    if (this.session && this.sessionVoice === this.piperVoice) return this.session;
    TtsSession._instance = null; // Bibliothek nutzt ein Singleton – beim Stimmwechsel neu anlegen
    this.session = null;
    const s = new TtsSession({ voiceId: this.piperVoice, wasmPaths: WASM, progress: onProgress });
    await s.waitReady;
    this.session = s;
    this.sessionVoice = this.piperVoice;
    return s;
  }

  preload(onProgress) {
    if (this.engine !== 'piper') return Promise.resolve();
    return this.getSession(onProgress);
  }

  /** Satz in die Warteschlange legen. Piper-Audio wird sofort vorberechnet. */
  enqueue(text) {
    const clean = cleanForSpeech(text);
    if (!clean) return;
    const gen = this.generation;
    const item = { text: clean, gen };
    if (this.engine === 'piper') {
      item.audio = this.synthPiper(clean).catch((err) => {
        this.onStatus(`Sprachausgabe-Fehler: ${err.message}`);
        return null;
      });
    }
    this.queue.push(item);
    if (!this.playing) this.playNext();
  }

  async synthPiper(text) {
    // Nacheinander synthetisieren, die Piper-Sitzung ist nicht parallel nutzbar.
    const prev = this.synthChain ?? Promise.resolve();
    const run = prev.then(async () => {
      const s = await this.getSession((p) => {
        if (p.total) this.onStatus(`Lade Stimme … ${Math.round((p.loaded / p.total) * 100)} %`);
      });
      return s.predict(text);
    });
    this.synthChain = run.catch(() => {});
    return run;
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
      if (this.engine === 'piper') {
        const blob = await item.audio;
        if (blob && item.gen === this.generation) await this.playBlob(blob);
      } else {
        await this.speakSystem(item.text);
      }
    } catch (err) {
      this.onStatus(`Sprachausgabe-Fehler: ${err.message}`);
    }
    if (item.gen === this.generation) this.playNext();
  }

  async playBlob(blob) {
    this.ctx ??= new AudioContext();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const buf = await this.ctx.decodeAudioData(await blob.arrayBuffer());
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = this.rate;
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    analyser.connect(this.ctx.destination);
    const samples = new Float32Array(analyser.fftSize);
    let raf;
    const tick = () => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const v of samples) sum += v * v;
      this.onLevel(Math.min(1, Math.sqrt(sum / samples.length) * 6));
      raf = requestAnimationFrame(tick);
    };
    this.currentSource = src;
    await new Promise((resolve) => {
      src.onended = resolve;
      src.start();
      tick();
    });
    cancelAnimationFrame(raf);
    this.currentSource = null;
    this.onLevel(0);
  }

  speakSystem(text) {
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      const voice = speechSynthesis.getVoices().find((v) => v.name === this.systemVoice);
      if (voice) u.voice = voice;
      u.lang = voice?.lang ?? 'de-DE';
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
