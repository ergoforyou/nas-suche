// Spracherkennung mit Whisper, läuft komplett lokal in einem Web-Worker.
// Das Modell wird beim ersten Mal von Hugging Face geladen und danach im Cache gehalten.
import { pipeline, env, RawImage, AutoModel, AutoProcessor } from '@huggingface/transformers';

env.allowLocalModels = false;
// Modelle kommen über den Hauptprozess (app://local/models/hf/…), der sie auf der Festplatte speichert.
// Android-App: direkt von Hugging Face (Zwischenspeicher im Browser-Speicher der App)
env.remoteHost = typeof __HF_BASE__ !== 'undefined' ? __HF_BASE__ : new URL('models/hf/', self.location.href).href;
// PC: der Hauptprozess speichert die Modelle selbst. Android: im Browser-Speicher der App aufheben – sonst würde das
// Modell bei jedem Start neu geladen (mehrere hundert MB)
env.useBrowserCache = typeof __HF_BASE__ !== 'undefined';
// Im Worker nur einen Kern für die CPU-Variante: Mehrkern-WASM kann hier blockieren (GPU wird bevorzugt).
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.wasmPaths = new URL('wasm/tf/', self.location.href).href;

let asr = null;
let loadedModel = null;
let device = null;

async function load(model, progress) {
  if (asr && loadedModel === model) return;
  asr = null;
  const tryCreate = (dev, dtype) =>
    pipeline('automatic-speech-recognition', model, { device: dev, dtype, progress_callback: progress });
  // WebGPU nur nutzen, wenn wirklich eine Grafikkarte verfügbar ist – sonst CPU (WASM).
  const adapter = await navigator.gpu?.requestAdapter().catch(() => null);
  if (adapter) {
    try {
      asr = await tryCreate('webgpu', { encoder_model: 'fp32', decoder_model_merged: 'q4' });
      device = 'webgpu';
    } catch {
      asr = null;
    }
  }
  if (!asr) {
    asr = await tryCreate('wasm', 'q8');
    device = 'wasm';
  }
  loadedModel = model;
}

// Freistellen per KI (MODNet: auf Personen spezialisiertes Matting-Modell, ~25 MB, Apache-2.0)
let matting = null;
async function removeBackground({ rgba, width, height }, progress) {
  // Auf der Grafikkarte (WebGPU) deutlich schneller – wichtig für Videos mit vielen Einzelbildern
  matting ??= (async () => {
    const adapter = await navigator.gpu?.requestAdapter().catch(() => null);
    if (adapter) {
      try {
        return await pipeline('background-removal', 'Xenova/modnet', { device: 'webgpu', dtype: 'fp32', progress_callback: progress });
      } catch {}
    }
    return pipeline('background-removal', 'Xenova/modnet', { device: 'wasm', dtype: 'fp32', progress_callback: progress });
  })().catch((e) => {
    matting = null;
    throw e;
  });
  const seg = await matting;
  const img = new RawImage(new Uint8ClampedArray(rgba), width, height, 4);
  const [out] = await seg(img);
  // Ergebnis als RGBA in Originalgröße
  const rgbaOut = out.channels === 4 ? out : out.rgba();
  const resized = rgbaOut.width === width && rgbaOut.height === height ? rgbaOut : await rgbaOut.resize(width, height);
  return new Uint8ClampedArray(resized.data);
}

// Freistellen ganzer Figuren (BiRefNet lite, MIT-Lizenz): trennt auch Lücken zwischen Armen und Beinen sauber,
// wo das Porträt-Modell nur Kopf und Schultern gut kann. Größer (~110 MB) und langsamer – darum nur für Bilder.
let birefnet = null;
async function removeBackgroundFigure({ rgba, width, height }, progress) {
  birefnet ??= (async () => {
    const id = 'onnx-community/BiRefNet_lite';
    // Nur mit echter Grafikkarte: auf der CPU (WASM) reicht der Speicher für 1024×1024 nicht – dann MODNet
    const adapter = await navigator.gpu?.requestAdapter().catch(() => null);
    if (!adapter || adapter.isFallbackAdapter || adapter.info?.isFallbackAdapter) throw new Error('keine Grafikkarte (WebGPU)');
    const model = await AutoModel.from_pretrained(id, { device: 'webgpu', dtype: 'fp16', progress_callback: progress });
    const processor = await AutoProcessor.from_pretrained(id);
    return { model, processor };
  })().catch((e) => {
    birefnet = null;
    throw e;
  });
  const { model, processor } = await birefnet;
  const img = new RawImage(new Uint8ClampedArray(rgba), width, height, 4).rgb();
  const { pixel_values } = await processor(img);
  const out = await model({ input_image: pixel_values });
  const logits = out.output_image ?? Object.values(out)[0];
  const mask = await RawImage.fromTensor(logits[0].sigmoid().mul(255).to('uint8')).resize(width, height);
  const res = new Uint8ClampedArray(rgba);
  for (let i = 0; i < width * height; i++) res[i * 4 + 3] = mask.data[i];
  return res;
}

// Tiefenschätzung (Depth Anything V2 Small, Apache-2.0): Wie weit ist jeder Bildpunkt entfernt?
// Wird einmal pro Avatar-Bild gebraucht, damit sich das Bild leicht "drehen" lässt.
let depthPipe = null;
async function estimateDepth({ rgba, width, height }, progress) {
  depthPipe ??= pipeline('depth-estimation', 'onnx-community/depth-anything-v2-small', {
    device: 'wasm',
    dtype: 'q8',
    progress_callback: progress,
  }).catch((e) => {
    depthPipe = null;
    throw e;
  });
  const est = await depthPipe;
  const img = new RawImage(new Uint8ClampedArray(rgba), width, height, 4);
  const { depth } = await est(img);
  const d = depth.width === width && depth.height === height ? depth : await depth.resize(width, height);
  const gray = d.channels === 1 ? d : d.grayscale();
  return new Uint8ClampedArray(gray.data);
}

// Bedeutungssuche (multilingual-e5-small, MIT, ~120 MB): Text → Vektor. Läuft in einem eigenen Worker, damit das
// Berechnen im Hintergrund die Spracherkennung nicht aufhält.
let extractor = null;
async function embedTexts(model, texts, progress) {
  extractor ??= pipeline('feature-extraction', model, { device: 'wasm', dtype: 'q8', progress_callback: progress }).catch((e) => {
    extractor = null;
    throw e;
  });
  const fx = await extractor;
  const out = await fx(texts, { pooling: 'mean', normalize: true });
  const dim = out.dims.at(-1);
  return texts.map((_, i) => out.data.slice(i * dim, (i + 1) * dim));
}

self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    if (type === 'load') {
      await load(data.model, (p) => self.postMessage({ id, type: 'progress', progress: p }));
      self.postMessage({ id, type: 'ready', device });
    } else if (type === 'transcribe') {
      await load(data.model, (p) => self.postMessage({ id, type: 'progress', progress: p }));
      const out = await asr(data.audio, {
        language: data.language || 'german',
        task: 'transcribe',
        chunk_length_s: 30,
        stride_length_s: 5,
      });
      self.postMessage({ id, type: 'result', text: (out.text || '').trim() });
    } else if (type === 'embed') {
      const vecs = await embedTexts(data.model, data.texts, (p) => self.postMessage({ id, type: 'progress', progress: p }));
      self.postMessage({ id, type: 'result', vecs }, vecs.map((v) => v.buffer));
    } else if (type === 'depth') {
      const depth = await estimateDepth(data, (p) => self.postMessage({ id, type: 'progress', progress: p }));
      self.postMessage({ id, type: 'result', depth }, [depth.buffer]);
    } else if (type === 'cutout') {
      const progress = (p) => self.postMessage({ id, type: 'progress', progress: p });
      let rgba = null;
      let model = 'MODNet';
      if (data.quality === 'figur') {
        try {
          rgba = await removeBackgroundFigure(data, progress);
          model = 'BiRefNet';
        } catch (e) {
          console.warn('BiRefNet nicht verfügbar, nutze MODNet:', e);
        }
      }
      rgba ??= await removeBackground(data, progress);
      self.postMessage({ id, type: 'result', rgba, model }, [rgba.buffer]);
    }
  } catch (err) {
    self.postMessage({ id, type: 'error', error: String(err?.message || err) });
  }
};
