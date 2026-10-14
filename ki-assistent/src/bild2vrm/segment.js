// Freistellen: Vordergrund-Maske (Uint8Array 0/1) aus einem Bild bestimmen.
import { resizeImage, resizeMask } from './image.js';

/**
 * method: auto (Transparenz, sonst einfarbiger Hintergrund) | alpha | flood | none
 * (KI-Freistellen erledigt der Aufrufer vorher, z. B. cutout.js im KI-Assistenten – das Ergebnis
 *  hat dann Transparenz und wird hier mit "auto"/"alpha" übernommen.)
 */
export function computeMask(img, method = 'auto', tolerance = 40) {
  const { width: w, height: h, data } = img, n = w * h;
  if (method === 'auto') {
    let transparent = 0;
    for (let i = 0; i < n; i++) if (data[i * 4 + 3] < 128) transparent++;
    method = transparent / n > 0.01 ? 'alpha' : 'flood';
  }
  let mask;
  if (method === 'alpha') {
    mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) mask[i] = data[i * 4 + 3] > 127 ? 1 : 0;
  } else if (method === 'flood') mask = floodMask(img, tolerance);
  else if (method === 'none') mask = new Uint8Array(n).fill(1);
  else throw new Error(`Unbekannte Freistell-Methode: ${method}`);
  let count = 0;
  for (let i = 0; i < n; i++) count += mask[i];
  if (count < 100) throw new Error('Keine Figur im Bild gefunden (Maske ist leer). Bitte ein PNG mit transparentem Hintergrund verwenden.');
  return mask;
}

function median(values) {
  const s = Float64Array.from(values).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Hintergrund = alles, was vom Rand aus mit randähnlicher Farbe erreichbar ist. */
function floodMask(img, tolerance) {
  const W = img.width, H = img.height;
  const scale = Math.min(1, 1024 / Math.max(W, H));
  const small = scale < 1 ? resizeImage(img, Math.max(1, Math.round(W * scale)), Math.max(1, Math.round(H * scale))) : img;
  const w = small.width, h = small.height, d = small.data;
  const border = [];
  for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) border.push(y * w, y * w + w - 1);
  const bg = [0, 1, 2].map((c) => median(border.map((i) => d[i * 4 + c])));

  const filled = new Uint8Array(w * h);
  const step = Math.max(1, Math.floor(Math.min(w, h) / 64));
  const seeds = [];
  for (let x = 0; x < w; x += step) seeds.push([x, 0], [x, h - 1]);
  for (let y = 0; y < h; y += step) seeds.push([0, y], [w - 1, y]);
  const stack = new Int32Array(w * h);
  for (const [sx, sy] of seeds) {
    const s = sy * w + sx;
    if (filled[s]) continue;
    if (Math.abs(d[s * 4] - bg[0]) + Math.abs(d[s * 4 + 1] - bg[1]) + Math.abs(d[s * 4 + 2] - bg[2]) > tolerance * 3) continue;
    const r0 = d[s * 4], g0 = d[s * 4 + 1], b0 = d[s * 4 + 2];
    let top = 0;
    stack[top++] = s; filled[s] = 1;
    while (top) {
      const i = stack[--top], x = i % w, y = (i - x) / w;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const j of nb) {
        if (j < 0 || filled[j]) continue;
        if (Math.abs(d[j * 4] - r0) + Math.abs(d[j * 4 + 1] - g0) + Math.abs(d[j * 4 + 2] - b0) <= tolerance) {
          filled[j] = 1; stack[top++] = j;
        }
      }
    }
  }
  let mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = filled[i] ? 0 : 1;
  if (scale < 1) mask = resizeMask(mask, w, h, W, H);
  // Rand in voller Auflösung nachschärfen (Hochskalieren hinterlässt sonst einen hellen Saum).
  const inv = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) inv[i] = mask[i] ? 0 : 1;
  const nearOutside = dilate(inv, W, H, Math.max(2, Math.round(2 / scale)));
  const D = img.data;
  for (let i = 0; i < W * H; i++) {
    if (!mask[i] || !nearOutside[i]) continue;
    if (Math.abs(D[i * 4] - bg[0]) + Math.abs(D[i * 4 + 1] - bg[1]) + Math.abs(D[i * 4 + 2] - bg[2]) <= tolerance * 3) mask[i] = 0;
  }
  return mask;
}

/** Binäre Dilatation (4er-Nachbarschaft), r Schritte. */
export function dilate(mask, w, h, r) {
  let cur = Uint8Array.from(mask);
  for (let k = 0; k < r; k++) {
    const next = Uint8Array.from(cur);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (cur[i]) continue;
        if ((x > 0 && cur[i - 1]) || (x < w - 1 && cur[i + 1]) || (y > 0 && cur[i - w]) || (y < h - 1 && cur[i + w])) next[i] = 1;
      }
    cur = next;
  }
  return cur;
}

/**
 * Randfarben in transparente Pixel ausbluten lassen (gegen Säume bei Texturfilterung):
 * erst einige weiche Schritte am Rand, dann (fillAll) alles übrige per Push-Pull-Pyramide.
 * rgb: Float32Array/Uint8 (w*h*3), known: Uint8Array (w*h). Rückgabe: Uint8ClampedArray (w*h*3).
 */
export function bleedColors(rgb, known0, w, h, iterations = 12, fillAll = true) {
  const out = Float32Array.from(rgb);
  let known = Uint8Array.from(known0);
  for (let it = 0; it < iterations; it++) {
    const grow = [];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (known[i]) continue;
        let cnt = 0, r = 0, g = 0, b = 0;
        for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
          if (j >= 0 && known[j]) { cnt++; r += out[j * 3]; g += out[j * 3 + 1]; b += out[j * 3 + 2]; }
        }
        if (cnt) grow.push(i, r / cnt, g / cnt, b / cnt);
      }
    if (!grow.length) break;
    for (let k = 0; k < grow.length; k += 4) {
      const i = grow[k];
      out[i * 3] = grow[k + 1]; out[i * 3 + 1] = grow[k + 2]; out[i * 3 + 2] = grow[k + 3];
      known[i] = 1;
    }
  }
  let all = true, any = false;
  for (let i = 0; i < w * h; i++) { if (known[i]) any = true; else all = false; }
  const res = fillAll && !all && any ? pushPull(out, known, w, h) : out;
  return Uint8ClampedArray.from(res, (v) => Math.round(v));
}

function pushPull(img, known, w, h) {
  let all = true;
  for (let i = 0; i < w * h; i++) if (!known[i]) { all = false; break; }
  if (all || Math.min(w, h) <= 1) return img;
  const cw = (w + (w % 2)) / 2, ch = (h + (h % 2)) / 2;
  const coarse = new Float32Array(cw * ch * 3), ck = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      let n = 0, r = 0, g = 0, b = 0;
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++) {
          const sx = 2 * x + dx, sy = 2 * y + dy;
          if (sx >= w || sy >= h) continue;
          const i = sy * w + sx;
          if (known[i]) { n++; r += img[i * 3]; g += img[i * 3 + 1]; b += img[i * 3 + 2]; }
        }
      const c = y * cw + x;
      if (n) { ck[c] = 1; coarse[c * 3] = r / n; coarse[c * 3 + 1] = g / n; coarse[c * 3 + 2] = b / n; }
    }
  const filled = pushPull(coarse, ck, cw, ch);
  const out = Float32Array.from(img);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (known[i]) continue;
      const c = (y >> 1) * cw + (x >> 1);
      out[i * 3] = filled[c * 3]; out[i * 3 + 1] = filled[c * 3 + 1]; out[i * 3 + 2] = filled[c * 3 + 2];
    }
  return out;
}
