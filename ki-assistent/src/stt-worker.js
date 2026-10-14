// Spracherkennung mit Whisper, läuft komplett lokal in einem Web-Worker.
// Das Modell wird beim ersten Mal von Hugging Face geladen und danach im Cache gehalten.
import { pipeline, env, RawImage } from '@huggingface/transformers';

env.allowLocalModels = false;
// Modelle kommen über den Hauptprozess (app://local/models/hf/…), der sie auf der Festplatte speichert.
env.remoteHost = new URL('models/hf/', self.location.href).href;
env.useBrowserCache = false;
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
  matting ??= pipeline('background-removal', 'Xenova/modnet', { dtype: 'fp32', progress_callback: progress }).catch(
    (e) => {
      matting = null;
      throw e;
    },
  );
  const seg = await matting;
  const img = new RawImage(new Uint8ClampedArray(rgba), width, height, 4);
  const [out] = await seg(img);
  // Ergebnis als RGBA in Originalgröße
  const rgbaOut = out.channels === 4 ? out : out.rgba();
  const resized = rgbaOut.width === width && rgbaOut.height === height ? rgbaOut : await rgbaOut.resize(width, height);
  return new Uint8ClampedArray(resized.data);
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
    } else if (type === 'cutout') {
      const rgba = await removeBackground(data, (p) => self.postMessage({ id, type: 'progress', progress: p }));
      self.postMessage({ id, type: 'result', rgba }, [rgba.buffer]);
    }
  } catch (err) {
    self.postMessage({ id, type: 'error', error: String(err?.message || err) });
  }
};
