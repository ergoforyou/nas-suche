// Bild-Hilfsfunktionen für bild2vrm (Browser / Electron, ohne Abhängigkeiten).
// Ein "Bild" ist { width, height, data: Uint8ClampedArray (RGBA) } – kompatibel zu ImageData.

export function createImage(width, height) {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

/** Blob / File / ArrayBuffer / Data-URL -> Bild */
export async function loadImage(src) {
  let blob = src;
  if (typeof src === 'string') blob = await (await fetch(src)).blob();
  else if (src instanceof ArrayBuffer || ArrayBuffer.isView(src)) blob = new Blob([src]);
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  bmp.close?.();
  const d = g.getImageData(0, 0, c.width, c.height);
  return { width: d.width, height: d.height, data: d.data };
}

function toCanvas(img) {
  const c = new OffscreenCanvas(img.width, img.height);
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return c;
}

/** Hochwertig skalieren (über Canvas). */
export function resizeImage(img, width, height) {
  const c = new OffscreenCanvas(width, height);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(toCanvas(img), 0, 0, width, height);
  const d = g.getImageData(0, 0, width, height);
  return { width, height, data: d.data };
}

export function cropImage(img, x0, y0, x1, y1) {
  const w = x1 - x0, h = y1 - y0, out = createImage(w, h);
  for (let y = 0; y < h; y++) {
    const sy = y + y0;
    if (sy < 0 || sy >= img.height) continue;
    for (let x = 0; x < w; x++) {
      const sx = x + x0;
      if (sx < 0 || sx >= img.width) continue;
      const s = (sy * img.width + sx) * 4, d = (y * w + x) * 4;
      out.data[d] = img.data[s]; out.data[d + 1] = img.data[s + 1]; out.data[d + 2] = img.data[s + 2]; out.data[d + 3] = img.data[s + 3];
    }
  }
  return out;
}

export function flipHorizontal(img) {
  const out = createImage(img.width, img.height), w = img.width;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4, d = (y * w + (w - 1 - x)) * 4;
      for (let k = 0; k < 4; k++) out.data[d + k] = img.data[s + k];
    }
  return out;
}

/** Binäre Maske (Uint8Array 0/1) bilinear auf neue Größe skalieren (Schwelle 0.5). */
export function resizeMask(mask, w, h, nw, nh) {
  const out = new Uint8Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    const fy = Math.min(h - 1, Math.max(0, (y + 0.5) * h / nh - 0.5)), y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < nw; x++) {
      const fx = Math.min(w - 1, Math.max(0, (x + 0.5) * w / nw - 0.5)), x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), tx = fx - x0;
      const v = (mask[y0 * w + x0] * (1 - tx) + mask[y0 * w + x1] * tx) * (1 - ty) + (mask[y1 * w + x0] * (1 - tx) + mask[y1 * w + x1] * tx) * ty;
      out[y * nw + x] = v > 0.5 ? 1 : 0;
    }
  }
  return out;
}

// ------------------------------------------------------------------ PNG
// Eigener Encoder, damit die Farben unter transparenten Pixeln erhalten bleiben
// (Canvas würde sie durch vormultipliziertes Alpha auf Schwarz setzen).

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function zlib(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** RGBA- oder RGB-Bild als PNG kodieren. channels: 4 (RGBA) oder 3 (RGB, Alpha wird verworfen). */
export async function encodePNG(img, channels = 4) {
  const { width: w, height: h, data } = img;
  const raw = new Uint8Array((w * channels + 1) * h);
  for (let y = 0, o = 0; y < h; y++) {
    raw[o++] = 0; // Filter: none
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      raw[o++] = data[s]; raw[o++] = data[s + 1]; raw[o++] = data[s + 2];
      if (channels === 4) raw[o++] = data[s + 3];
    }
  }
  const idat = await zlib(raw);
  const chunk = (type, body) => {
    const out = new Uint8Array(12 + body.length), dv = new DataView(out.buffer);
    dv.setUint32(0, body.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(body, 8);
    dv.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
    return out;
  };
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  ihdr[8] = 8; ihdr[9] = channels === 4 ? 6 : 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
