// Spracherkennung mit Whisper, läuft komplett lokal in einem Web-Worker.
// Das Modell wird beim ersten Mal von Hugging Face geladen und danach im Cache gehalten.
import { pipeline, env } from '@huggingface/transformers';

env.allowLocalModels = false;
env.backends.onnx.wasm.wasmPaths = new URL('wasm/tf/', self.location.href).href;

let asr = null;
let loadedModel = null;
let device = null;

async function load(model, progress) {
  if (asr && loadedModel === model) return;
  asr = null;
  const tryCreate = (dev, dtype) =>
    pipeline('automatic-speech-recognition', model, { device: dev, dtype, progress_callback: progress });
  try {
    if (!('gpu' in navigator)) throw new Error('kein WebGPU');
    asr = await tryCreate('webgpu', { encoder_model: 'fp32', decoder_model_merged: 'q4' });
    device = 'webgpu';
  } catch {
    asr = await tryCreate('wasm', 'q8');
    device = 'wasm';
  }
  loadedModel = model;
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
    }
  } catch (err) {
    self.postMessage({ id, type: 'error', error: String(err?.message || err) });
  }
};
