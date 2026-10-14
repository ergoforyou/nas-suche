// Gesichtsausdrücke: Augen-/Mund-Erkennung und Ausdrucks-Kacheln (siehe face.py).
import { bleedColors } from './segment.js';
import { createImage } from './image.js';

export const TILES = [
  ['blinkLeft', 'left_eye_box', 'closed'],
  ['blinkRight', 'right_eye_box', 'closed'],
  ['happyLeft', 'left_eye_box', 'happy'],
  ['happyRight', 'right_eye_box', 'happy'],
  ['aa', 'mouth_box', 'a'],
  ['ih', 'mouth_box', 'i'],
  ['ou', 'mouth_box', 'u'],
  ['ee', 'mouth_box', 'e'],
  ['oh', 'mouth_box', 'o'],
];
export const EXPRESSIONS = {
  blink: [['blinkLeft', 1], ['blinkRight', 1]],
  blinkLeft: [['blinkLeft', 1]],
  blinkRight: [['blinkRight', 1]],
  happy: [['happyLeft', 1], ['happyRight', 1], ['ee', 1]],
  relaxed: [['happyLeft', 1], ['happyRight', 1]],
  aa: [['aa', 1]], ih: [['ih', 1]], ou: [['ou', 1]], ee: [['ee', 1]], oh: [['oh', 1]],
};
const VOWELS = { a: [0.55, 0.62], i: [0.62, 0.22], u: [0.26, 0.3], e: [0.52, 0.36], o: [0.36, 0.5] };

/** 4er-Zusammenhangskomponenten einer kleinen Maske (Liste von Index-Arrays, zeilenweise Reihenfolge). */
function components(mask, w, h) {
  const seen = new Uint8Array(w * h), comps = [];
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || seen[s]) continue;
    const stack = [s], comp = [];
    seen[s] = 1;
    while (stack.length) {
      const i = stack.pop(), y = Math.floor(i / w), x = i % w;
      comp.push(i);
      for (const [ny, nx] of [[y + 1, x], [y - 1, x], [y, x + 1], [y, x - 1]]) {
        if (ny < 0 || nx < 0 || ny >= h || nx >= w) continue;
        const j = ny * w + nx;
        if (mask[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    comps.push(comp);
  }
  return comps;
}

const clipBox = ([x0, y0, x1, y1], w, h) => [
  Math.min(w - 1, Math.max(0, x0)), Math.min(h - 1, Math.max(0, y0)), Math.min(w, Math.max(1, x1)), Math.min(h, Math.max(1, y1)),
];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const median = (arr) => { const s = Float64Array.from(arr).sort(), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Kästen [x0, y0, x1, y1] für beide Augen und den Mund (Bildpixel). */
export function detectFaceBoxes(img, mask, kp) {
  const W = img.width, H = img.height, D = img.data;
  const top = kp.head_top, neck = kp.neck;
  const hh = Math.max(8, neck[1] - top[1]);
  const cx = (top[0] + neck[0]) / 2;
  const eyeRow = clamp(Math.trunc(top[1] + 0.58 * hh), 0, H - 1);
  const near = [];
  for (let x = 0; x < W; x++) if (mask[eyeRow * W + x] && Math.abs(x - cx) < 0.9 * hh) near.push(x);
  let headW = near.length > 4 ? Math.max(...near) - Math.min(...near) + 1 : 0.75 * hh;
  headW = clamp(headW, 0.45 * hh, 1.2 * hh);

  const ew = 0.24 * headW, eh = 0.17 * hh, mw = 0.3 * headW, mh = 0.15 * hh;
  const box = (x, y, bw, bh) => [x - bw / 2, y - bh / 2, x + bw / 2, y + bh / 2];
  const boxes = {
    left_eye_box: box(cx + 0.2 * headW, top[1] + 0.58 * hh, ew, eh),
    right_eye_box: box(cx - 0.2 * headW, top[1] + 0.58 * hh, ew, eh),
    mouth_box: box(cx, top[1] + 0.84 * hh, mw, mh),
  };

  // Hautfarbe: Median der unteren Gesichtsmitte
  const sy0 = Math.max(0, Math.trunc(top[1] + 0.62 * hh)), sy1 = Math.max(1, Math.trunc(top[1] + 0.8 * hh));
  const sx0 = Math.max(0, Math.trunc(cx - 0.22 * headW)), sx1 = Math.max(1, Math.trunc(cx + 0.22 * headW));
  const sr = [], sg = [], sb = [];
  for (let y = sy0; y < Math.min(H, sy1); y++)
    for (let x = sx0; x < Math.min(W, sx1); x++) {
      const i = y * W + x;
      if (mask[i]) { sr.push(D[i * 4]); sg.push(D[i * 4 + 1]); sb.push(D[i * 4 + 2]); }
    }
  const finish = () => Object.fromEntries(Object.entries(boxes).map(([k, b]) => [k, clipBox(b, W, H)]));
  if (sr.length < 10) return finish();
  const skin = [median(sr), median(sg), median(sb)];

  const blob = (bx0, by0, bx1, by1, thresh, preferX) => {
    const [cx0, cy0, cx1, cy1] = clipBox([bx0, by0, bx1, by1], W, H).map(Math.round);
    if (cx1 - cx0 < 4 || cy1 - cy0 < 4) return null;
    const pw = cx1 - cx0, ph = cy1 - cy0;
    const step = Math.max(1, Math.trunc(Math.max(pw, ph) / 60));
    const sw = Math.ceil(pw / step), sh = Math.ceil(ph / step), small = new Uint8Array(sw * sh);
    for (let y = 0; y < sh; y++)
      for (let x = 0; x < sw; x++) {
        const i = (cy0 + y * step) * W + cx0 + x * step;
        const diff = Math.abs(D[i * 4] - skin[0]) + Math.abs(D[i * 4 + 1] - skin[1]) + Math.abs(D[i * 4 + 2] - skin[2]);
        small[y * sw + x] = diff > thresh && mask[i] ? 1 : 0;
      }
    let best = null, bestScore = 0;
    for (const comp of components(small, sw, sh)) {
      if (comp.length < 3) continue;
      const ys = comp.map((i) => Math.floor(i / sw)), xs = comp.map((i) => i % sw);
      const ymin = Math.min(...ys), ymax = Math.max(...ys);
      if (ymin === 0 && comp.length > 0.15 * sw * sh) continue; // Haare / Pony
      if (ymax - ymin > 0.8 * sh) continue;
      const cxc = (xs.reduce((a, b) => a + b, 0) / xs.length) * step + cx0;
      const score = comp.length / (1 + Math.abs(cxc - preferX) / Math.max(1, cx1 - cx0));
      if (score > bestScore) { bestScore = score; best = { xs, ys }; }
    }
    if (!best) return null;
    return [Math.min(...best.xs) * step + cx0, Math.min(...best.ys) * step + cy0, Math.max(...best.xs) * step + cx0 + step, Math.max(...best.ys) * step + cy0 + step];
  };

  for (const [key, sgn] of [['left_eye_box', 1], ['right_eye_box', -1]]) {
    const [lo, hi] = sgn > 0 ? [cx + 0.04 * headW, cx + 0.48 * headW] : [cx - 0.48 * headW, cx - 0.04 * headW];
    const b = blob(lo, top[1] + 0.32 * hh, hi, top[1] + 0.8 * hh, 110, cx + sgn * 0.2 * headW);
    if (b) {
      const bw = clamp((b[2] - b[0]) * 1.35, 0.6 * ew, 1.7 * ew), bh = clamp((b[3] - b[1]) * 1.5, 0.6 * eh, 1.9 * eh);
      boxes[key] = box((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, bw, bh);
    }
  }
  const eyeBottom = Math.max(boxes.left_eye_box[3], boxes.right_eye_box[3]);
  const b = blob(cx - 0.25 * headW, eyeBottom + 0.05 * hh, cx + 0.25 * headW, neck[1] - 0.02 * hh, 70, cx);
  if (b) {
    const bw = clamp((b[2] - b[0]) * 1.6, 0.7 * mw, 1.6 * mw), bh = clamp((b[3] - b[1]) * 2.5, 0.8 * mh, 1.8 * mh);
    boxes.mouth_box = box((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, bw, bh);
  }
  return finish();
}

// ------------------------------------------------------------------ Kacheln

/** Gesichtsmerkmale im Ausschnitt mit umgebender Haut übermalen. */
function skinFill(patch) {
  const { width: w, height: h, data } = patch, n = w * h;
  const border = [];
  for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) border.push(y * w, y * w + w - 1);
  const skin = [0, 1, 2].map((c) => median(border.map((i) => data[i * 4 + c])));
  const feature = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const diff = Math.abs(data[i * 4] - skin[0]) + Math.abs(data[i * 4 + 1] - skin[1]) + Math.abs(data[i * 4 + 2] - skin[2]);
    feature[i] = diff > 60 && data[i * 4 + 3] > 127 ? 1 : 0;
  }
  // Merkmale, die den Rand berühren (Haare, Gesichtskontur), bleiben stehen
  const step = Math.max(1, Math.trunc(Math.max(h, w) / 80));
  const sw = Math.ceil(w / step), sh = Math.ceil(h / step), small = new Uint8Array(sw * sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) small[y * sw + x] = feature[y * step * w + x * step];
  for (const comp of components(small, sw, sh)) {
    const touches = comp.some((i) => { const y = Math.floor(i / sw), x = i % sw; return y === 0 || x === 0 || y === sh - 1 || x === sw - 1; });
    if (!touches) continue;
    for (const i of comp) {
      const y = Math.floor(i / sw), x = i % sw;
      for (let yy = y * step; yy < Math.min(h, (y + 1) * step); yy++) for (let xx = x * step; xx < Math.min(w, (x + 1) * step); xx++) feature[yy * w + xx] = 0;
    }
  }
  const grown = Uint8Array.from(feature);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (feature[i]) continue;
      if ((x > 0 && feature[i - 1]) || (x < w - 1 && feature[i + 1]) || (y > 0 && feature[i - w]) || (y < h - 1 && feature[i + w])) grown[i] = 1;
    }
  for (let x = 0; x < w; x++) { grown[x] = 0; grown[(h - 1) * w + x] = 0; }
  for (let y = 0; y < h; y++) { grown[y * w] = 0; grown[y * w + w - 1] = 0; }
  const rgb = new Float32Array(n * 3), known = new Uint8Array(n);
  for (let i = 0; i < n; i++) { rgb[i * 3] = data[i * 4]; rgb[i * 3 + 1] = data[i * 4 + 1]; rgb[i * 3 + 2] = data[i * 4 + 2]; known[i] = grown[i] ? 0 : 1; }
  return { filled: bleedColors(rgb, known, w, h, Math.max(h, w)), feature };
}

function darkColor(patch, feature) {
  const { data } = patch, px = [];
  let nf = 0;
  for (const f of feature) nf += f;
  for (let i = 0; i < feature.length; i++) if (nf <= 3 || feature[i]) px.push([data[i * 4], data[i * 4 + 1], data[i * 4 + 2]]);
  const lum = px.map((p) => p[0] + p[1] + p[2]);
  const sorted = Float64Array.from(lum).sort();
  const pos = 0.15 * (sorted.length - 1), lo = Math.floor(pos);
  const p15 = sorted[lo] + (sorted[Math.min(sorted.length - 1, lo + 1)] - sorted[lo]) * (pos - lo);
  const dark = px.filter((_, i) => lum[i] <= p15);
  if (!dark.length) return [40, 30, 30];
  return [0, 1, 2].map((c) => Math.trunc(dark.reduce((a, p) => a + p[c], 0) / dark.length));
}

const rgbCss = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;

/** Ausdrucksbild für einen Bereich (gleiche Größe wie der Ausschnitt). */
export function makeTile(patch, kind) {
  const { width: w, height: h } = patch;
  const { filled, feature } = skinFill(patch);
  const line = darkColor(patch, feature);
  const ss = 4, Wc = w * ss, Hc = h * ss;
  const base = new OffscreenCanvas(w, h);
  const bimg = new ImageData(w, h);
  for (let i = 0; i < w * h; i++) { bimg.data[i * 4] = filled[i * 3]; bimg.data[i * 4 + 1] = filled[i * 3 + 1]; bimg.data[i * 4 + 2] = filled[i * 3 + 2]; bimg.data[i * 4 + 3] = 255; }
  base.getContext('2d').putImageData(bimg, 0, 0);
  const big = new OffscreenCanvas(Wc, Hc), g = big.getContext('2d');
  g.imageSmoothingEnabled = true;
  g.drawImage(base, 0, 0, Wc, Hc);
  g.lineJoin = 'round';
  if (kind === 'closed' || kind === 'happy') {
    g.strokeStyle = rgbCss(line);
    g.lineWidth = Math.max(ss * 2, Math.trunc(0.09 * Hc));
    g.beginPath();
    for (let k = 0; k < 24; k++) {
      const x = 0.12 * Wc + (0.76 * Wc * k) / 23, t = (x - Wc / 2) / (0.38 * Wc);
      const y = kind === 'closed' ? 0.62 * Hc - 0.1 * Hc * t * t : 0.62 * Hc - 0.22 * Hc * (1 - t * t);
      if (k) g.lineTo(x, y); else g.moveTo(x, y);
    }
    g.stroke();
  } else {
    const [rw, rh] = VOWELS[kind], ew = (rw * Wc) / 2, eh = (rh * Hc) / 2;
    let inner = line[0] + line[1] + line[2] > 150 ? line.map((c) => Math.trunc(c * 0.55)) : [70, 22, 30];
    inner = [Math.max(inner[0], 60), inner[1], inner[2]];
    g.beginPath();
    g.ellipse(Wc / 2, Hc / 2, ew, eh, 0, 0, Math.PI * 2);
    g.fillStyle = rgbCss(inner);
    g.fill();
    if (kind === 'a' || kind === 'o') {
      const tw = ew * 0.6, th = eh * 0.45;
      g.save(); g.clip();
      g.beginPath(); g.ellipse(Wc / 2, Hc / 2 + eh - th - 1, tw, th, 0, 0, Math.PI * 2);
      g.fillStyle = 'rgb(200,90,100)'; g.fill();
      g.restore();
    }
    if (kind === 'a' || kind === 'e' || kind === 'i') {
      g.save();
      g.beginPath(); g.ellipse(Wc / 2, Hc / 2, ew, eh, 0, 0, Math.PI * 2); g.clip();
      g.fillStyle = 'rgb(250,250,250)';
      g.fillRect(Wc / 2 - ew * 0.65, Hc / 2 - eh + ss, ew * 1.3, Math.max(ss * 2, eh * 0.28) - ss);
      g.restore();
    }
    g.beginPath();
    g.ellipse(Wc / 2, Hc / 2, ew, eh, 0, 0, Math.PI * 2);
    g.strokeStyle = rgbCss(line);
    g.lineWidth = Math.max(ss, Math.trunc(0.05 * Hc));
    g.stroke();
  }
  const small = new OffscreenCanvas(w, h), sg = small.getContext('2d', { willReadFrequently: true });
  sg.imageSmoothingEnabled = true; sg.imageSmoothingQuality = 'high';
  sg.drawImage(big, 0, 0, w, h);
  const out = sg.getImageData(0, 0, w, h);
  for (let i = 0; i < w * h; i++) out.data[i * 4 + 3] = patch.data[i * 4 + 3];
  return { width: w, height: h, data: out.data };
}

/** Bereiche aus der Textur schneiden und je Ausdruck eine Kachel in einen Atlas legen. */
export function buildTiles(tex, boxes) {
  const imgs = [], names = [], srcs = [], kinds = [];
  for (const [name, region, kind] of TILES) {
    const [x0, y0, x1, y1] = clipBox(boxes[region], tex.width, tex.height).map(Math.round);
    if (x1 - x0 < 4 || y1 - y0 < 4) continue;
    const patch = createImage(x1 - x0, y1 - y0);
    for (let y = 0; y < patch.height; y++)
      for (let x = 0; x < patch.width; x++) {
        const s = ((y + y0) * tex.width + x + x0) * 4, d = (y * patch.width + x) * 4;
        for (let k = 0; k < 4; k++) patch.data[d + k] = tex.data[s + k];
      }
    imgs.push(makeTile(patch, kind)); names.push(name); srcs.push([x0, y0, x1, y1]); kinds.push(kind);
  }
  if (!imgs.length) return { atlas: null, names, boxes: srcs, uvRects: [], kinds };
  const pad = 2;
  const aw = imgs.reduce((s, im) => s + im.width + 2 * pad, 0), ah = Math.max(...imgs.map((im) => im.height)) + 2 * pad;
  const atlas = createImage(aw, ah), A = atlas.data;
  const put = (ax, ay, im, sx, sy) => { const s = (sy * im.width + sx) * 4, d = (ay * aw + ax) * 4; for (let k = 0; k < 4; k++) A[d + k] = im.data[s + k]; };
  const uvRects = [];
  let x = 0;
  for (const im of imgs) {
    const tw = im.width, th = im.height;
    for (let ay = 0; ay < ah; ay++)
      for (let ax = x; ax < x + tw + 2 * pad; ax++) {
        const sx = clamp(ax - x - pad, 0, tw - 1), sy = clamp(ay - pad, 0, th - 1);
        put(ax, ay, im, sx, sy); // Rand wird in den Abstand hinein wiederholt
      }
    uvRects.push([(x + pad) / aw, pad / ah, (x + pad + tw) / aw, (pad + th) / ah]);
    x += tw + 2 * pad;
  }
  return { atlas, names, boxes: srcs, uvRects, kinds };
}
