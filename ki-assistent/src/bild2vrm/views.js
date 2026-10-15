// Zusatzansichten: Rückansicht (Textur), Seitenansicht (Körperprofil), Turnaround-Blatt.
import { computeMask, bleedColors } from './segment.js';
import { createImage, flipHorizontal } from './image.js';

function bboxRows(mask, w, h) {
  let t = -1, b = -1;
  for (let y = 0; y < h; y++) {
    let any = false;
    for (let x = 0; x < w; x++) if (mask[y * w + x]) { any = true; break; }
    if (any) { if (t < 0) t = y; b = y + 1; }
  }
  return [t, b];
}

const median = (arr) => { const s = Float64Array.from(arr).sort(), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Horizontale Körpermitte: Median der Zeilenmitten im Bereich Unterbauch/Beine. */
function centerX(mask, w, h) {
  const [t, b] = bboxRows(mask, w, h), mids = [];
  for (let y = Math.trunc(t + 0.45 * (b - t)); y < Math.trunc(t + 0.9 * (b - t)); y++) {
    let lo = -1, hi = -1;
    for (let x = 0; x < w; x++) if (mask[y * w + x]) { if (lo < 0) lo = x; hi = x; }
    if (lo >= 0) mids.push((lo + hi) / 2);
  }
  if (mids.length) return median(mids);
  let s = 0, n = 0;
  for (let i = 0; i < w * h; i++) if (mask[i]) { s += i % w; n++; }
  return s / n;
}

/**
 * Rückansicht an die Fronttextur anpassen: gespiegelt, auf gleiche Körperhöhe skaliert, auf die
 * Körpermitte zentriert. Die Silhouette der Front bleibt, die Farben kommen aus der Rückansicht.
 */
export function backTexture(back, frontTex, background = 'auto') {
  const bm0 = computeMask(back, background);
  const src = { width: back.width, height: back.height, data: Uint8ClampedArray.from(back.data) };
  for (let i = 0; i < bm0.length; i++) src.data[i * 4 + 3] = bm0[i] ? 255 : 0;
  const img = flipHorizontal(src);
  const bw = img.width, bh = img.height;
  const bmask = Uint8Array.from({ length: bw * bh }, (_, i) => (img.data[i * 4 + 3] > 127 ? 1 : 0));
  const W = frontTex.width, H = frontTex.height;
  const fmask = Uint8Array.from({ length: W * H }, (_, i) => (frontTex.data[i * 4 + 3] > 127 ? 1 : 0));
  const [ft, fb] = bboxRows(fmask, W, H), [bt, bb] = bboxRows(bmask, bw, bh);
  const s = (fb - ft) / Math.max(1, bb - bt), fcx = centerX(fmask, W, H), bcx = centerX(bmask, bw, bh);
  // Ausgabe (x, y) -> Eingabe ((x - fcx) / s + bcx, (y - ft) / s + bt), bilinear
  const rgb = new Float32Array(W * H * 3), known = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const sx = (x + 0.5 - fcx) / s + bcx - 0.5, sy = (y + 0.5 - ft) / s + bt - 0.5;
      const x0 = Math.floor(sx), y0 = Math.floor(sy), tx = sx - x0, ty = sy - y0;
      const acc = [0, 0, 0, 0];
      for (const [xx, yy, wt] of [[x0, y0, (1 - tx) * (1 - ty)], [x0 + 1, y0, tx * (1 - ty)], [x0, y0 + 1, (1 - tx) * ty], [x0 + 1, y0 + 1, tx * ty]]) {
        if (xx < 0 || yy < 0 || xx >= bw || yy >= bh || !wt) continue;
        const k = (yy * bw + xx) * 4;
        for (let c = 0; c < 4; c++) acc[c] += img.data[k + c] * wt;
      }
      const i = y * W + x;
      rgb[i * 3] = acc[0]; rgb[i * 3 + 1] = acc[1]; rgb[i * 3 + 2] = acc[2];
      known[i] = acc[3] > 127 ? 1 : 0;
    }
  let nk = 0;
  for (const k of known) nk += k;
  if (nk < 50) throw new Error('Rückansicht: keine Figur gefunden.');
  const filled = bleedColors(rgb, known, W, H);
  const out = createImage(W, H);
  for (let i = 0; i < W * H; i++) {
    out.data[i * 4] = filled[i * 3]; out.data[i * 4 + 1] = filled[i * 3 + 1]; out.data[i * 4 + 2] = filled[i * 3 + 2];
    out.data[i * 4 + 3] = frontTex.data[i * 4 + 3];
  }
  return out;
}

// ------------------------------------------------------------------ Seitenansicht

function interp(x, xs, ys) {
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  let lo = 0, hi = xs.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; }
  const t = (x - xs[lo]) / (xs[hi] - xs[lo] || 1);
  return ys[lo] + (ys[hi] - ys[lo]) * t;
}

export function makeProfile(heights, front, back) {
  return { heights, front, back, at: (y) => [interp(y, heights, front), interp(y, heights, back)] };
}

export function averageProfiles(ps) {
  const hs = ps[0].heights;
  const f = hs.map((y) => ps.reduce((s, p) => s + p.at(y)[0], 0) / ps.length);
  const b = hs.map((y) => ps.reduce((s, p) => s + p.at(y)[1], 0) / ps.length);
  return makeProfile(hs, f, b);
}

/** 'right', wenn die Figur im Bild nach rechts schaut (Füße zeigen nach vorn). */
export function guessFacing(mask, w, h) {
  const [t, b] = bboxRows(mask, w, h), H = b - t;
  const meanX = (y0, y1) => { let s = 0, n = 0; for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { s += x; n++; } return n ? s / n : null; };
  const feet = meanX(Math.trunc(b - 0.04 * H), b), ankles = meanX(Math.trunc(b - 0.14 * H), Math.trunc(b - 0.07 * H));
  if (feet != null && ankles != null && Math.abs(feet - ankles) > 0.004 * H) return feet > ankles ? 'right' : 'left';
  const head = meanX(t, Math.trunc(t + 0.15 * H)), neck = meanX(Math.trunc(t + 0.16 * H), Math.trunc(t + 0.16 * H) + 1);
  if (head != null && neck != null) return head > neck ? 'right' : 'left';
  return 'right';
}

/** Tiefenprofil aus einer Seitenansicht. facing: auto | left | right (Blickrichtung im Bild). */
export function sideProfile(side, height, facing = 'auto', background = 'auto') {
  const w = side.width, h = side.height, mask = computeMask(side, background);
  if (facing === 'auto') facing = guessFacing(mask, w, h);
  const sgn = facing === 'right' ? 1 : -1;
  const [t, b] = bboxRows(mask, w, h), H = b - t, scale = height / H;
  const n = b - t, fr = new Float64Array(n).fill(NaN), bk = new Float64Array(n).fill(NaN), mid = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const y = t + i;
    let lo = -1, hi = -1;
    for (let x = 0; x < w; x++) if (mask[y * w + x]) { if (lo < 0) lo = x; hi = x; }
    if (lo < 0) continue;
    fr[i] = sgn > 0 ? hi : lo; bk[i] = sgn > 0 ? lo : hi; mid[i] = (lo + hi) / 2;
  }
  // Körperebene: Gerade durch die Zeilenmitten von Rumpf und Beinen
  let sx = 0, sy = 0, sxx = 0, sxy = 0, m = 0;
  for (let i = 0; i < n; i++) {
    const r = t + i;
    if (r > t + 0.2 * H && r < t + 0.92 * H && !Number.isNaN(mid[i])) { sx += r; sy += mid[i]; sxx += r * r; sxy += r * mid[i]; m++; }
  }
  let a = 0, c;
  if (m > 5) { a = (m * sxy - sx * sy) / (m * sxx - sx * sx); c = (sy - a * sx) / m; }
  else c = median(Array.from(mid).filter((v) => !Number.isNaN(v)));
  let front = new Float64Array(n), backD = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const ref = a * (t + i) + c;
    front[i] = Number.isNaN(fr[i]) ? 0 : (fr[i] - ref) * sgn * scale;
    backD[i] = Number.isNaN(bk[i]) ? 0 : (ref - bk[i]) * sgn * scale;
  }
  const k = Math.max(1, Math.trunc(0.008 * H));
  const smooth = (arr) => Float64Array.from(arr, (_, i) => {
    let s = 0;
    for (let j = i - k; j <= i + k; j++) s += arr[Math.min(n - 1, Math.max(0, j))];
    return s / (2 * k + 1);
  });
  const minimum = 0.01 * height;
  front = smooth(front).map((v) => Math.max(v, minimum));
  backD = smooth(backD).map((v) => Math.max(v, minimum));
  // Zeilen -> Welthöhe (aufsteigend)
  const heights = [], f = [], bb = [];
  for (let i = n - 1; i >= 0; i--) { heights.push((b - (t + i)) * scale); f.push(front[i]); bb.push(backD[i]); }
  return makeProfile(heights, f, bb);
}

// ------------------------------------------------------------------ Turnaround-Blatt

/** Blatt mit mehreren Ansichten in einzelne Figuren (links nach rechts) aufteilen. */
export function splitSheet(sheet, background = 'auto') {
  const W = sheet.width, H = sheet.height, mask = computeMask(sheet, background);
  const colCount = new Int32Array(W);
  let total = 0;
  for (let i = 0; i < W * H; i++) if (mask[i]) { colCount[i % W]++; total++; }
  const minCol = Math.max(1, 0.002 * H), runs = [];
  let start = -1;
  for (let x = 0; x <= W; x++) {
    const v = x < W && colCount[x] > minCol;
    if (v && start < 0) start = x;
    else if (!v && start >= 0) { runs.push([start, x]); start = -1; }
  }
  const merged = [];
  for (const r of runs) {
    if (merged.length && r[0] - merged[merged.length - 1][1] < 0.01 * W) merged[merged.length - 1][1] = r[1];
    else merged.push([...r]);
  }
  const figs = [];
  for (const [x0, x1] of merged) {
    let cnt = 0, t = -1, b = -1;
    for (let y = 0; y < H; y++) {
      let any = false;
      for (let x = x0; x < x1; x++) if (mask[y * W + x]) { cnt++; any = true; }
      if (any) { if (t < 0) t = y; b = y + 1; }
    }
    if (cnt < (0.05 * total) / Math.max(1, merged.length)) continue;
    const pad = Math.trunc(0.02 * (b - t)) + 2;
    const ya = Math.max(0, t - pad), yb = Math.min(H, b + pad), xa = Math.max(0, x0 - pad), xb = Math.min(W, x1 + pad);
    const crop = createImage(xb - xa, yb - ya);
    for (let y = ya; y < yb; y++)
      for (let x = xa; x < xb; x++) {
        const s = (y * W + x) * 4, d = ((y - ya) * crop.width + (x - xa)) * 4;
        crop.data[d] = sheet.data[s]; crop.data[d + 1] = sheet.data[s + 1]; crop.data[d + 2] = sheet.data[s + 2];
        crop.data[d + 3] = mask[y * W + x] ? 255 : 0;
      }
    figs.push({ image: crop, width: (x1 - x0) / Math.max(1, b - t) });
  }
  if (!figs.length) throw new Error('Im Turnaround-Blatt wurden keine Figuren gefunden.');
  // Seitenansichten sind (relativ zur Höhe) deutlich schmaler als Front/Rücken
  const widest = Math.max(...figs.map((f) => f.width));
  const wide = figs.filter((f) => f.width > 0.72 * widest);
  for (const f of figs) f.role = 'side';
  if (wide.length) {
    wide[0].role = 'front';
    if (wide.length > 1) wide[wide.length - 1].role = 'back';
  }
  return figs.map(({ image, role }) => ({ image, role }));
}

// ------------------------------------------------------------------ Rückseite ohne Rückansicht

function boxBlur(rgb, w, h, r) {
  const out = Float32Array.from(rgb), tmp = new Float32Array(rgb.length);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++)
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        for (let x = -r; x <= r; x++) acc += out[(y * w + Math.min(w - 1, Math.max(0, x))) * 3 + c];
        for (let x = 0; x < w; x++) {
          tmp[(y * w + x) * 3 + c] = acc / (2 * r + 1);
          acc += out[(y * w + Math.min(w - 1, x + r + 1)) * 3 + c] - out[(y * w + Math.max(0, x - r)) * 3 + c];
        }
      }
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        for (let y = -r; y <= r; y++) acc += tmp[(Math.min(h - 1, Math.max(0, y)) * w + x) * 3 + c];
        for (let y = 0; y < h; y++) {
          out[(y * w + x) * 3 + c] = acc / (2 * r + 1);
          acc += tmp[(Math.min(h - 1, y + r + 1) * w + x) * 3 + c] - tmp[(Math.max(0, y - r) * w + x) * 3 + c];
        }
      }
  }
  return out;
}

/**
 * Rückseite, wenn keine Rückansicht vorliegt – statt eines gespiegelten zweiten Gesichts am Hinterkopf:
 * Kopf in Haarfarbe (oberste Haarreihe), Kleidung/Körper je Bildzeile in der vorherrschenden Farbe (schmale Details
 * wie Krawatte, Knöpfe, Augen verschwinden), leicht mit der weichgezeichneten Front gemischt.
 * headTop/chinY: Scheitel und Kinn (Texturpixel).
 */
export function syntheticBack(tex, headTop, chinY) {
  const w = tex.width, h = tex.height, n = w * h;
  const rgb = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { rgb[i * 3] = tex.data[i * 4]; rgb[i * 3 + 1] = tex.data[i * 4 + 1]; rgb[i * 3 + 2] = tex.data[i * 4 + 2]; }
  const blurred = boxBlur(rgb, w, h, Math.max(2, Math.round(0.02 * h)));
  const inMask = (i) => tex.data[i * 4 + 3] > 127;
  const med = (vals) => { if (!vals.length) return null; const s2 = Float64Array.from(vals).sort(); return s2[s2.length >> 1]; };
  // Zeilenfarbe (Median der Figurpixel), danach senkrecht geglättet
  const rowCol = [];
  for (let y = 0; y < h; y++) {
    const r = [], g = [], b = [];
    for (let x = 0; x < w; x++) { const i = y * w + x; if (inMask(i)) { r.push(rgb[i * 3]); g.push(rgb[i * 3 + 1]); b.push(rgb[i * 3 + 2]); } }
    rowCol.push(r.length ? [med(r), med(g), med(b)] : null);
  }
  const k = Math.max(1, Math.round(0.01 * h)), rowSm = [];
  for (let y = 0; y < h; y++) {
    const acc = [0, 0, 0];
    let c = 0;
    for (let j = y - k; j <= y + k; j++) if (rowCol[j]) { acc[0] += rowCol[j][0]; acc[1] += rowCol[j][1]; acc[2] += rowCol[j][2]; c++; }
    rowSm.push(c ? acc.map((v) => v / c) : [0, 0, 0]);
  }
  // Haarfarbe: Median der obersten Kopfzeilen
  const headH = Math.max(8, chinY - headTop);
  const hr = [], hg = [], hb = [];
  for (let y = Math.max(0, Math.floor(headTop)); y < Math.min(h, headTop + 0.12 * headH); y++)
    for (let x = 0; x < w; x++) { const i = y * w + x; if (inMask(i)) { hr.push(rgb[i * 3]); hg.push(rgb[i * 3 + 1]); hb.push(rgb[i * 3 + 2]); } }
  const hair = hr.length > 10 ? [med(hr), med(hg), med(hb)] : null;
  const headEnd = chinY + 0.08 * headH, band = 0.12 * headH;
  const out = createImage(w, h);
  for (let y = 0; y < h; y++) {
    // 1 im Kopf, 0 darunter, weicher Übergang am Hals
    const tHead = hair ? Math.min(1, Math.max(0, (headEnd - y) / band)) : 0;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      for (let c = 0; c < 3; c++) {
        const body = 0.8 * rowSm[y][c] + 0.2 * blurred[i * 3 + c];
        const head = hair ? 0.92 * hair[c] + 0.08 * blurred[i * 3 + c] : body;
        out.data[i * 4 + c] = head * tHead + body * (1 - tHead);
      }
      out.data[i * 4 + 3] = tex.data[i * 4 + 3];
    }
  }
  return out;
}
