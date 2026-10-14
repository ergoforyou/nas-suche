// KI-Freistellung für Video-Posen: Das Video wird beim Hochladen einmal Bild für Bild mit dem
// Personen-Modell (MODNet) freigestellt. Gespeichert werden nur die Masken (1 Byte pro Pixel);
// beim Abspielen wird die passende Maske auf das laufende Video gelegt.
//
// Dateiformat: "KIM1" | Breite u16 | Höhe u16 | fps u8 | 0 | Anzahl u16 | Masken …

const MAGIC = 'KIM1';
const HEADER = 12;

function seek(video, t) {
  return new Promise((resolve) => {
    const done = () => {
      video.removeEventListener('seeked', done);
      resolve();
    };
    video.addEventListener('seeked', done);
    video.currentTime = t;
  });
}

/**
 * @param {string} url Video-Adresse
 * @param {(img: ImageData) => Promise<Uint8ClampedArray>} removeBackground liefert RGBA mit Alpha
 * @param {(done: number, total: number) => void} onProgress
 */
export async function computeVideoMask(url, removeBackground, onProgress, { fps = 20, maxSide = 480 } = {}) {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.src = url;
  await new Promise((resolve, reject) => {
    v.onloadeddata = resolve;
    v.onerror = () => reject(new Error('Video konnte nicht gelesen werden'));
  });
  const scale = Math.min(1, maxSide / Math.max(v.videoWidth, v.videoHeight));
  const w = Math.max(2, Math.round(v.videoWidth * scale));
  const h = Math.max(2, Math.round(v.videoHeight * scale));
  const duration = Math.min(30, v.duration || 0);
  const n = Math.max(1, Math.min(65535, Math.ceil(duration * fps)));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });

  const out = new Uint8Array(HEADER + n * w * h);
  out.set([...MAGIC].map((ch) => ch.charCodeAt(0)), 0);
  const view = new DataView(out.buffer);
  view.setUint16(4, w, true);
  view.setUint16(6, h, true);
  view.setUint8(8, fps);
  view.setUint16(10, n, true);

  for (let i = 0; i < n; i++) {
    await seek(v, Math.min(duration - 0.001, i / fps));
    g.drawImage(v, 0, 0, w, h);
    const rgba = await removeBackground(g.getImageData(0, 0, w, h));
    const base = HEADER + i * w * h;
    for (let p = 0; p < w * h; p++) out[base + p] = rgba[p * 4 + 3];
    onProgress?.(i + 1, n);
  }
  v.src = '';
  return out;
}

/** Maskendatei laden. */
export async function loadVideoMask(url) {
  const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
  if (String.fromCharCode(...buf.subarray(0, 4)) !== MAGIC) throw new Error('Ungültige Maskendatei');
  const view = new DataView(buf.buffer, buf.byteOffset);
  const w = view.getUint16(4, true);
  const h = view.getUint16(6, true);
  const fps = view.getUint8(8);
  const n = view.getUint16(10, true);
  return { w, h, fps, n, frame: (i) => buf.subarray(HEADER + i * w * h, HEADER + (i + 1) * w * h) };
}
