// Hintergrund entfernen ("freistellen") für einfarbige Hintergründe, z. B. weiße Fotowand.
// Vom Bildrand aus werden alle zusammenhängenden Pixel entfernt, deren Farbe nah an der
// Hintergrundfarbe liegt. Innenflächen (z. B. ein weißes Hemd) bleiben erhalten, solange sie
// nicht mit dem Rand verbunden sind. Danach werden die Kanten weichgezeichnet und das Bild
// auf die Figur zugeschnitten.

/** Häufigste (grob quantisierte) Farbe am Bildrand = Hintergrundfarbe. */
function borderColor(d, w, h) {
  const counts = new Map();
  const add = (x, y) => {
    const i = (y * w + x) * 4;
    if (d[i + 3] < 128) return;
    const key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
    const c = counts.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    c.n++;
    c.r += d[i];
    c.g += d[i + 1];
    c.b += d[i + 2];
    counts.set(key, c);
  };
  for (let x = 0; x < w; x++) {
    add(x, 0);
    add(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    add(0, y);
    add(w - 1, y);
  }
  let best = null;
  for (const c of counts.values()) if (!best || c.n > best.n) best = c;
  return best ? [best.r / best.n, best.g / best.n, best.b / best.n] : [255, 255, 255];
}

/**
 * @param {HTMLCanvasElement} canvas Bild (wird nicht verändert)
 * @param {{tolerance?: number, feather?: number}} opts tolerance 0..100, feather in px
 * @returns {{canvas: HTMLCanvasElement, crop: {x:number,y:number,w:number,h:number}, removed:number}}
 */
export function removeBackground(canvas, { tolerance = 30, feather = 1.5 } = {}) {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const [br, bg, bb] = borderColor(d, w, h);
  const tol = (tolerance / 100) * 160; // Farbabstand
  const soft = tol * 1.35;

  const dist = (i) => {
    const dr = d[i] - br;
    const dg = d[i + 1] - bg;
    const db = d[i + 2] - bb;
    return Math.sqrt(dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11) * 1.7;
  };

  // Flutfüllung vom Rand aus
  const bgMask = new Uint8Array(w * h); // 1 = Hintergrund
  const stack = [];
  const seed = (x, y) => {
    const p = y * w + x;
    if (!bgMask[p] && (d[p * 4 + 3] < 20 || dist(p * 4) <= tol)) {
      bgMask[p] = 1;
      stack.push(p);
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x, 0);
    seed(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    seed(0, y);
    seed(w - 1, y);
  }
  while (stack.length) {
    const p = stack.pop();
    const x = p % w;
    const y = (p / w) | 0;
    if (x > 0) seed(x - 1, y);
    if (x < w - 1) seed(x + 1, y);
    if (y > 0) seed(x, y - 1);
    if (y < h - 1) seed(x, y + 1);
  }

  // Alpha-Maske: Hintergrund 0, Übergangszone weich, Rest 255
  const alpha = new Float32Array(w * h);
  let removed = 0;
  for (let p = 0; p < w * h; p++) {
    if (bgMask[p]) {
      alpha[p] = 0;
      removed++;
    } else {
      // Pixel direkt neben dem Hintergrund mit ähnlicher Farbe halbtransparent machen (Kantensaum)
      const di = dist(p * 4);
      alpha[p] = di < soft ? Math.max(0, Math.min(1, (di - tol) / (soft - tol))) : 1;
      // nur am Rand der Figur anwenden
      const x = p % w;
      const y = (p / w) | 0;
      const nearBg =
        (x > 0 && bgMask[p - 1]) || (x < w - 1 && bgMask[p + 1]) || (y > 0 && bgMask[p - w]) || (y < h - 1 && bgMask[p + w]);
      if (!nearBg) alpha[p] = 1;
    }
  }

  // Kanten weichzeichnen (zweifacher Box-Blur der Maske)
  const r = Math.round(feather);
  let a = alpha;
  if (r > 0) {
    for (let pass = 0; pass < 2; pass++) {
      const tmp = new Float32Array(w * h);
      for (let y = 0; y < h; y++) {
        let acc = 0;
        for (let x = -r; x <= r; x++) acc += a[y * w + Math.min(w - 1, Math.max(0, x))];
        for (let x = 0; x < w; x++) {
          tmp[y * w + x] = acc / (2 * r + 1);
          acc += a[y * w + Math.min(w - 1, x + r + 1)] - a[y * w + Math.max(0, x - r)];
        }
      }
      const out = new Float32Array(w * h);
      for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
        for (let y = 0; y < h; y++) {
          out[y * w + x] = acc / (2 * r + 1);
          acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
        }
      }
      a = out;
    }
    // Weichzeichnen nur nach innen wirken lassen: Hintergrund bleibt komplett transparent
    for (let p = 0; p < w * h; p++) if (bgMask[p]) a[p] = 0;
  }

  // Maske anwenden und Begrenzungsrahmen bestimmen
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let p = 0; p < w * h; p++) {
    const v = Math.round(d[p * 4 + 3] * a[p]);
    d[p * 4 + 3] = v;
    if (v > 16) {
      const x = p % w;
      const y = (p / w) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return { canvas, crop: { x: 0, y: 0, w, h }, removed: 0 };

  const pad = Math.round(Math.max(w, h) * 0.02);
  const crop = {
    x: Math.max(0, minX - pad),
    y: Math.max(0, minY - pad),
    w: Math.min(w, maxX + pad + 1) - Math.max(0, minX - pad),
    h: Math.min(h, maxY + pad + 1) - Math.max(0, minY - pad),
  };
  const full = canvas.ownerDocument.createElement('canvas');
  full.width = w;
  full.height = h;
  full.getContext('2d').putImageData(img, 0, 0);
  const out = canvas.ownerDocument.createElement('canvas');
  out.width = crop.w;
  out.height = crop.h;
  out.getContext('2d').drawImage(full, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
  return { canvas: out, crop, removed: removed / (w * h) };
}

/** Prüft, ob ein Bild bereits transparente Bereiche hat. */
export function hasTransparency(canvas) {
  const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 3; i < d.length; i += 4 * 7) if (d[i] < 250) return true;
  return false;
}
