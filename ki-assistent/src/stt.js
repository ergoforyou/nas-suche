// Mikrofonaufnahme mit einfacher Sprachpausen-Erkennung + Whisper-Worker.

const SAMPLE_RATE = 16000;

export class SpeechInput {
  constructor({ onLevel, onStatus } = {}) {
    this.onLevel = onLevel ?? (() => {});
    this.onStatus = onStatus ?? (() => {});
    this.worker = new Worker(new URL('stt-worker.js', location.href), { type: 'module' });
    this.pending = new Map();
    this.nextId = 1;
    this.worker.onmessage = ({ data }) => {
      const p = this.pending.get(data.id);
      if (!p) return;
      if (data.type === 'progress') p.onProgress?.(data.progress);
      else {
        this.pending.delete(data.id);
        if (data.type === 'error') p.reject(new Error(data.error));
        else p.resolve(data);
      }
    };
    this.model = 'onnx-community/whisper-base';
    this.language = 'german';
    this.stream = null;
    this.ctx = null;
    this.deviceId = ''; // gewähltes Mikrofon ('' = Standard des Systems)
  }

  /** Anderes Mikrofon wählen: das offene wird geschlossen, beim nächsten Zuhören öffnet sich das neue. */
  setDevice(id) {
    if ((id || '') === this.deviceId) return;
    this.deviceId = id || '';
    this.closeMic();
  }

  closeMic() {
    if (this.rec) this.cancel?.();
    try {
      this.processor?.disconnect();
    } catch {}
    const wasOpen = !!this.stream;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.stream = null;
    if (wasOpen) this.onMicClose?.();
    this.ctx = null;
    this.processor = null;
  }

  call(msg, onProgress, transfer) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ ...msg, id }, transfer ?? []);
    });
  }

  /**
   * Hintergrund per KI entfernen (läuft im Worker, damit die Oberfläche flüssig bleibt).
   * quality 'figur' = genaues Modell für ganze Figuren (BiRefNet), sonst das schnelle Porträt-Modell (MODNet).
   */
  async removeBackground(imageData, onProgress, { quality = 'schnell' } = {}) {
    const rgba = new Uint8ClampedArray(imageData.data);
    const res = await this.call(
      { type: 'cutout', rgba, width: imageData.width, height: imageData.height, quality },
      onProgress,
      [rgba.buffer],
    );
    this.cutoutModel = res.model;
    return res.rgba;
  }

  /** KI-Tiefenkarte (0 = weit weg, 255 = nah) in der Größe des Bildes. */
  async estimateDepth(imageData, onProgress) {
    const rgba = new Uint8ClampedArray(imageData.data);
    const res = await this.call({ type: 'depth', rgba, width: imageData.width, height: imageData.height }, onProgress, [rgba.buffer]);
    return res.depth;
  }

  preload(onProgress) {
    return this.call({ type: 'load', model: this.model }, onProgress);
  }

  /** Modell laden und einmal „trocken“ laufen lassen – der erste echte Satz ist dann sofort dran. */
  async warmup(onProgress) {
    if (this.warmedFor === this.model) return;
    this.warmedFor = this.model;
    try {
      await this.transcribe(new Float32Array(16000), onProgress);
    } catch {
      this.warmedFor = null;
    }
  }

  async transcribe(audio, onProgress, model = this.model) {
    const res = await this.call(
      { type: 'transcribe', model, language: this.language, audio },
      onProgress,
      [audio.buffer],
    );
    return res.text;
  }

  async ensureMic() {
    if (this.stream) return;
    this.onMicOpen?.(); // Handy: Headset als Sprechgerät wählen, bevor das Mikrofon aufgeht
    const audio = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: this.deviceId ? { ...audio, deviceId: { exact: this.deviceId } } : audio });
    } catch (e) {
      // gewähltes Mikrofon nicht angeschlossen: Standard des Systems nehmen
      if (!this.deviceId || !/NotFound|Overconstrained/i.test(e?.name ?? '')) throw e;
      this.stream = await navigator.mediaDevices.getUserMedia({ audio });
    }
    this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.processor = this.ctx.createScriptProcessor(2048, 1, 1);
    src.connect(this.processor);
    this.processor.connect(this.ctx.destination);
    this.processor.onaudioprocess = (ev) => this.handleAudio(ev.inputBuffer.getChannelData(0));
  }

  /**
   * Startet das Zuhören. Liefert ein Promise mit den Audiodaten, sobald nach dem
   * Sprechen eine Pause erkannt wurde oder stop() aufgerufen wird.
   * waitForSpeech: true = erst aufnehmen, wenn jemand spricht (Freihand-Modus).
   */
  // threshold und startMs dürfen Funktionen sein (Live-Gespräch: strenger, solange der Avatar spricht).
  // startMs: so lange muss es laut sein, bis es als Sprechen gilt. onSpeechStart: Beginn des Sprechens.
  async listen({ waitForSpeech = false, silenceMs = 1100, threshold = 0.015, maxMs = 30000, startMs = 0, adaptive = true, minThreshold = 0.003, onSpeechStart } = {}) {
    await this.ensureMic();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    return new Promise((resolve) => {
      this.rec = {
        chunks: [],
        preroll: [],
        speaking: !waitForSpeech,
        heardSpeech: false,
        silentFor: 0,
        total: 0,
        threshold,
        silenceMs,
        maxMs,
        startMs,
        adaptive,
        minThreshold,
        loudFor: 0,
        onSpeechStart,
        resolve,
      };
    });
  }

  handleAudio(input) {
    const data = new Float32Array(input);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    this.onLevel(rms);
    // Ruhepegel: fällt sofort mit, steigt nur langsam (Sprechen hebt ihn kaum an)
    this.floor = this.floor == null ? rms : rms < this.floor ? rms : this.floor + (rms - this.floor) * 0.002;

    const r = this.rec;
    if (!r) return;
    const ms = (data.length / SAMPLE_RATE) * 1000;
    const value = (v) => (typeof v === 'function' ? v() : v);
    // Ruhepegel mitlernen: Leise Headset-Mikrofone erreichen die eingestellte Schwelle oft nie.
    // Die Schwelle sinkt dann bis auf das Vierfache des Ruhepegels – höher als eingestellt wird sie nie.
    const th = value(r.threshold);
    const loud = rms > (value(r.adaptive) ? Math.min(th, Math.max(this.floor * 4, value(r.minThreshold) ?? 0.003)) : th);

    if (!r.speaking) {
      // Kurzen Vorlauf behalten, damit der Wortanfang nicht abgeschnitten wird.
      r.preroll.push(data);
      if (r.preroll.length > 6) r.preroll.shift();
      r.loudFor = loud ? r.loudFor + ms : 0;
      if (loud && r.loudFor >= value(r.startMs)) {
        r.speaking = true;
        r.chunks.push(...r.preroll);
        r.heardSpeech = true;
        r.onSpeechStart?.();
      }
      return;
    }

    r.chunks.push(data);
    r.total += ms;
    if (loud) {
      r.heardSpeech = true;
      r.silentFor = 0;
    } else {
      r.silentFor += ms;
    }
    if ((r.heardSpeech && r.silentFor > r.silenceMs) || r.total > r.maxMs) this.finish();
  }

  finish() {
    const r = this.rec;
    if (!r) return;
    this.rec = null;
    if (!r.heardSpeech) return r.resolve(null);
    const len = r.chunks.reduce((n, c) => n + c.length, 0);
    const audio = new Float32Array(len);
    let off = 0;
    for (const c of r.chunks) {
      audio.set(c, off);
      off += c.length;
    }
    r.resolve(audio);
  }

  stop() {
    this.finish();
  }

  cancel() {
    const r = this.rec;
    this.rec = null;
    r?.resolve(null);
  }

  get listening() {
    return !!this.rec;
  }
}
