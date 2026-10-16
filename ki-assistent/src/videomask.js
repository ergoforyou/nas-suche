// KI-Freistellung für Video-Posen: Das Video wird beim Hochladen einmal Bild für Bild mit dem
// Personen-Modell (MODNet) freigestellt. Gespeichert werden nur die Masken (1 Byte pro Pixel);
// beim Abspielen wird die passende Maske auf das laufende Video gelegt.
//
// Dateiformat: "KIM1" | Breite u16 | Höhe u16 | fps u8 | 0 | Anzahl u16 | Masken …
//              "KIM2" | wie KIM1 | Startzeit f32 (Sekunden) | Masken …   (nur ein Abschnitt des Videos)

const MAGIC = 'KIM2';
const HEADER = 16;

export function seek(video, t, ms = 3000) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      video.removeEventListener('seeked', done);
      resolve();
    };
    // manche Geräte melden kein „seeked“, wenn sich die Zeit nicht ändert – dann nach kurzer Zeit weiter
    const timer = setTimeout(done, Math.abs(video.currentTime - t) < 0.001 ? 50 : ms);
    video.addEventListener('seeked', done);
    video.currentTime = t;
  });
}

/**
 * @param {string} url Video-Adresse
 * @param {(img: ImageData) => Promise<Uint8ClampedArray>} removeBackground liefert RGBA mit Alpha
 * @param {(done: number, total: number) => void} onProgress
 */
export async function computeVideoMask(url, removeBackground, onProgress, { fps = 20, maxSide = 480, start = 0, end = Infinity, shouldStop = () => false } = {}) {
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
  // nur der gewählte Abschnitt (spart bei langen Videos viel Rechenzeit), höchstens 30 Sekunden
  const t0 = Math.max(0, Math.min(start, (v.duration || 0) - 0.05));
  const t1 = Math.min(v.duration || 0, end, t0 + 30);
  const duration = t1;
  const n = Math.max(1, Math.min(65535, Math.ceil((t1 - t0) * fps)));
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
  view.setFloat32(12, t0, true);

  for (let i = 0; i < n; i++) {
    if (shouldStop()) throw new Error('abgebrochen');
    await seek(v, Math.min(duration - 0.001, t0 + i / fps));
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
  const magic = String.fromCharCode(...buf.subarray(0, 4));
  if (magic !== 'KIM1' && magic !== 'KIM2') throw new Error('Ungültige Maskendatei');
  const view = new DataView(buf.buffer, buf.byteOffset);
  const w = view.getUint16(4, true);
  const h = view.getUint16(6, true);
  const fps = view.getUint8(8);
  const n = view.getUint16(10, true);
  const head = magic === 'KIM2' ? 16 : 12;
  const start = magic === 'KIM2' ? view.getFloat32(12, true) : 0;
  return { w, h, fps, n, start, frame: (i) => buf.subarray(head + i * w * h, head + (i + 1) * w * h) };
}
