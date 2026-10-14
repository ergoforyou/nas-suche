// Avatar-Animation aus einem einzelnen Bild ("PNGtuber light"):
// Atmen, leichtes Wiegen, Blinzeln, Kopfnicken beim Sprechen und ein Mund,
// der sich passend zur Lautstärke der Stimme öffnet.
//
// Zwei Wege für Mund/Augen:
//  1. Prozedural: Mund- und Augenpositionen werden im Bild markiert, die App
//     verformt das Bild an der Stelle (Kiefer klappt runter, Lider schließen).
//  2. Bildwechsel: Optional eigene Bilder "Mund offen" und "Augen zu" hochladen.

const MAX_SIDE = 1024;

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export function loadImage(src, host = window) {
  return new Promise((resolve, reject) => {
    const img = new host.Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Bild konnte nicht geladen werden'));
    img.src = src;
  });
}

function toCanvas(img, w, h, doc = document) {
  const c = doc.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0, w, h);
  return c;
}

/** Gemeinsamer Zustand, damit Chatfenster und freischwebende Figur synchron sind. */
export const avatarState = { level: 0, speaking: false, thinking: false, listening: false };

export class Avatar {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{transparent?: boolean}} opts transparent = ohne Hintergrund (freischwebend)
   */
  constructor(canvas, { transparent = false } = {}) {
    this.canvas = canvas;
    this.host = canvas.ownerDocument.defaultView;
    this.doc = canvas.ownerDocument;
    this.transparent = transparent;
    this.ctx = canvas.getContext('2d', { willReadFrequently: transparent });
    this.state = avatarState;
    this.open = 0; // geglättete Mundöffnung 0..1
    this.blink = 0;
    this.nextBlink = performance.now() + 2500;
    this.blinkStart = 0;
    this.motion = 1;
    this.config = null;
    this.ready = false;
    this.lastOpenPx = -1;
    this.active = true;
    new this.host.ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    const loop = (t) => {
      if (!this.active) return;
      this.draw(t / 1000);
      this.host.requestAnimationFrame(loop);
    };
    this.host.requestAnimationFrame(loop);
  }

  destroy() {
    this.active = false;
  }

  // Kompatibilität: Zustand liegt im gemeinsamen Objekt
  get speaking() {
    return this.state.speaking;
  }
  set speaking(v) {
    this.state.speaking = v;
  }
  get thinking() {
    return this.state.thinking;
  }
  set thinking(v) {
    this.state.thinking = v;
  }
  get listening() {
    return this.state.listening;
  }
  set listening(v) {
    this.state.listening = v;
  }
  get level() {
    return this.state.level;
  }
  set level(v) {
    this.state.level = v;
  }

  resize() {
    const dpr = this.host.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.bg = null;
  }

  /**
   * config: { image, mouthImage?, eyesImage?, mouthMask?, mouth?: {x,y,w}, eyes?: [{x,y,r}], motion?, mouthOpen? }
   * Koordinaten normiert auf 0..1 bezogen auf Bildbreite/-höhe.
   */
  async setConfig(config) {
    this.ready = false;
    this.config = config;
    this.motion = config.motion ?? 1;
    const img = await loadImage(config.image, this.host);
    const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
    this.w = Math.round(img.width * scale);
    this.h = Math.round(img.height * scale);
    this.base = toCanvas(img, this.w, this.h, this.doc);
    this.frame = toCanvas(img, this.w, this.h, this.doc);
    this.frameCtx = this.frame.getContext('2d', { willReadFrequently: true });
    const extra = async (src) => (src ? toCanvas(await loadImage(src, this.host), this.w, this.h, this.doc) : null);
    this.mouthImg = await extra(config.mouthImage);
    this.eyesImg = await extra(config.eyesImage);
    // Hat das Bild transparente Bereiche (freigestellt)? Dann kein weichgezeichneter Bildhintergrund.
    const corners = this.base.getContext('2d', { willReadFrequently: true });
    this.hasAlpha = [
      [0, 0],
      [this.w - 1, 0],
      [0, this.h - 1],
      [this.w - 1, this.h - 1],
    ].some(([x, y]) => corners.getImageData(x, y, 1, 1).data[3] < 128);
    const mask = await extra(config.mouthMask);
    this.maskData = mask ? mask.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, this.w, this.h).data : null;
    this.prepareMouth();
    this.prepareEyes();
    this.bg = null;
    this.lastOpenPx = -1;
    this.ready = true;
  }

  /**
   * Mundbereich vorbereiten. Grundlage ist entweder eine aufgemalte Lippen-Maske
   * (genau) oder die Mund-Markierung (geschätzt). Pro Bildspalte wird die Lippenfuge
   * gesucht (dunkelste Zeile), an der sich der Mund später öffnet, und die Farbe für
   * den Mundinnenraum aus den Lippen selbst abgeleitet.
   */
  prepareMouth() {
    this.mouthRegion = null;
    if (this.mouthImg) return;
    const W = this.w;
    const H = this.h;
    const baseData = this.base.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
    const lum = (x, y) => {
      const i = (y * W + x) * 4;
      return baseData[i] * 0.3 + baseData[i + 1] * 0.59 + baseData[i + 2] * 0.11;
    };

    // Spaltenbereich + Zeilenbereich je Spalte bestimmen
    let cols = null; // { x0, x1, top: [], bottom: [] }
    if (this.maskData) {
      const m = this.maskData;
      let x0 = W;
      let x1 = -1;
      const top = new Float32Array(W).fill(-1);
      const bottom = new Float32Array(W).fill(-1);
      for (let x = 0; x < W; x++) {
        for (let y = 0; y < H; y++) {
          if (m[(y * W + x) * 4 + 3] > 64) {
            if (top[x] < 0) top[x] = y;
            bottom[x] = y;
          }
        }
        if (top[x] >= 0) {
          if (x < x0) x0 = x;
          x1 = x;
        }
      }
      if (x1 > x0 + 3) cols = { x0, x1, top, bottom };
    }
    if (!cols) {
      const mk = this.config.mouth;
      if (!mk) return;
      const mx = mk.x * W;
      const my = mk.y * H;
      const mw = Math.max(6, mk.w * W);
      const x0 = Math.max(0, Math.round(mx - mw / 2));
      const x1 = Math.min(W - 1, Math.round(mx + mw / 2));
      const top = new Float32Array(W).fill(-1);
      const bottom = new Float32Array(W).fill(-1);
      for (let x = x0; x <= x1; x++) {
        // Lippenhöhe zur Mitte hin größer (Linsenform)
        const t = 1 - Math.pow((x - mx) / (mw / 2), 2);
        const half = Math.max(1, mw * 0.16 * Math.sqrt(Math.max(0, t)));
        top[x] = Math.max(0, my - half);
        bottom[x] = Math.min(H - 1, my + half);
      }
      cols = { x0, x1, top, bottom };
    }

    const { x0, x1, top, bottom } = cols;
    const mw = x1 - x0 + 1;
    const mx = (x0 + x1) / 2;

    // Lippenfuge je Spalte: dunkelste Zeile im mittleren Lippenbereich, danach geglättet
    const seamRaw = new Float32Array(W);
    const shapeRaw = new Float32Array(W);
    let maxSpan = 1;
    for (let x = x0; x <= x1; x++) maxSpan = Math.max(maxSpan, bottom[x] - top[x] + 1);
    const inner = [0, 0, 0, 0];
    for (let x = x0; x <= x1; x++) {
      if (top[x] < 0) continue;
      const a = Math.round(top[x] + (bottom[x] - top[x]) * 0.2);
      const b = Math.round(top[x] + (bottom[x] - top[x]) * 0.8);
      let best = a;
      let bestL = Infinity;
      for (let y = a; y <= b; y++) {
        const l = lum(x, y) + lum(Math.max(0, x - 1), y) + lum(Math.min(W - 1, x + 1), y);
        if (l < bestL) {
          bestL = l;
          best = y;
        }
      }
      seamRaw[x] = best;
      shapeRaw[x] = (bottom[x] - top[x] + 1) / maxSpan;
      // Innenfarbe: Farbe der Lippenfuge
      const i = (best * W + x) * 4;
      inner[0] += baseData[i];
      inner[1] += baseData[i + 1];
      inner[2] += baseData[i + 2];
      inner[3]++;
    }
    const smooth = (arr, r) => {
      const out = new Float32Array(W);
      for (let x = x0; x <= x1; x++) {
        let sum = 0;
        let n = 0;
        for (let k = -r; k <= r; k++) {
          const xx = x + k;
          if (xx >= x0 && xx <= x1 && top[xx] >= 0) {
            sum += arr[xx];
            n++;
          }
        }
        out[x] = n ? sum / n : arr[x];
      }
      return out;
    };
    const r = Math.max(1, Math.round(mw * 0.06));
    const seam = smooth(seamRaw, r);
    const shape = smooth(shapeRaw, r);
    // Form zu den Mundwinkeln hin weich auslaufen lassen
    for (let x = x0; x <= x1; x++) {
      const edge = Math.min(x - x0, x1 - x) / (mw * 0.18);
      shape[x] = Math.min(1, shape[x]) * Math.min(1, Math.max(0, edge)) ** 0.6;
    }

    // Mundinnenraum: abgedunkelte, leicht ins Rote gezogene Lippenfugenfarbe
    const n = Math.max(1, inner[3]);
    const lr = inner[0] / n;
    const lg = inner[1] / n;
    const lb = inner[2] / n;
    const innerColor = [lr * 0.38 + 18, lg * 0.22 + 4, lb * 0.24 + 6];

    const seamMin = Math.min(...Array.from(seam.subarray(x0, x1 + 1)));
    const seamMax = Math.max(...Array.from(seam.subarray(x0, x1 + 1)));
    const maxOpen = mw * 0.26 * (this.config.mouthOpen ?? 1);
    const upH = Math.max(4, maxSpan * 1.2); // Bereich oberhalb, der mit der Oberlippe mitgeht
    const jawH = Math.max(maxSpan * 1.5, mw * 0.7); // Bereich unterhalb (Unterlippe, Kinnansatz) – Gesichtskontur bleibt stehen
    const rx0 = x0;
    const rx1 = x1 + 1;
    const ry0 = Math.max(0, Math.floor(seamMin - upH - 2));
    const ry1 = Math.min(H, Math.ceil(seamMax + jawH));
    const src = this.base
      .getContext('2d', { willReadFrequently: true })
      .getImageData(rx0, ry0, rx1 - rx0, ry1 - ry0);
    this.mouthRegion = {
      x0: rx0,
      y0: ry0,
      src,
      out: new ImageData(src.width, src.height),
      seam,
      shape,
      innerColor,
      maxOpen,
      upH,
      jawH,
      mx,
      mw,
    };
  }

  prepareEyes() {
    this.eyeLids = [];
    if (this.eyesImg) return;
    const ctx = this.base.getContext('2d', { willReadFrequently: true });
    for (const e of this.config.eyes ?? []) {
      const x = e.x * this.w;
      const y = e.y * this.h;
      const r = Math.max(3, e.r * this.w);
      // Hautfarbe direkt über dem Auge abgreifen (Augenlid/Brauenbereich)
      const sy = Math.max(0, Math.round(y - r * 1.25));
      const sx = Math.max(0, Math.round(x - r * 0.6));
      const d = ctx.getImageData(sx, sy, Math.max(1, Math.round(r * 1.2)), Math.max(1, Math.round(r * 0.4))).data;
      let rr = 0,
        gg = 0,
        bb = 0,
        n = 0;
      for (let i = 0; i < d.length; i += 4) {
        rr += d[i];
        gg += d[i + 1];
        bb += d[i + 2];
        n++;
      }
      const skin = n ? [rr / n, gg / n, bb / n] : [200, 160, 140];
      this.eyeLids.push({ x, y, r, skin });
    }
  }

  setLevel(v) {
    this.level = v;
  }

  // ---------- Bild für den aktuellen Frame aufbauen ----------
  /**
   * Öffnet die Lippen aus dem Bild selbst: Oberlippe hebt sich leicht, Unterlippe und
   * Kinn gehen nach unten. Der entstehende Spalt bekommt eine aus den Lippen abgeleitete
   * dunkle Farbe mit weichem Übergang – kein aufgesetzter Mund.
   */
  renderMouth(open) {
    const R = this.mouthRegion;
    if (!R) return;
    const openPx = Math.round(open * R.maxOpen * 2) / 2;
    if (openPx === this.lastOpenPx) return;
    this.lastOpenPx = openPx;
    const { src, out, x0, y0, seam, shape, innerColor, upH, jawH } = R;
    const W = src.width;
    const H = src.height;
    const s = src.data;
    const o = out.data;
    if (openPx <= 0) {
      o.set(s);
      this.frameCtx.putImageData(out, x0, y0);
      return;
    }
    const [ir, ig, ib] = innerColor;
    const sample = (px, fy, i) => {
      const a = Math.max(0, Math.min(H - 1, Math.floor(fy)));
      const b = Math.min(H - 1, a + 1);
      const t = Math.min(1, Math.max(0, fy - a));
      const ia = (a * W + px) * 4;
      const ib2 = (b * W + px) * 4;
      o[i] = s[ia] + (s[ib2] - s[ia]) * t;
      o[i + 1] = s[ia + 1] + (s[ib2 + 1] - s[ia + 1]) * t;
      o[i + 2] = s[ia + 2] + (s[ib2 + 2] - s[ia + 2]) * t;
      o[i + 3] = s[ia + 3] + (s[ib2 + 3] - s[ia + 3]) * t;
    };
    for (let px = 0; px < W; px++) {
      const x = x0 + px;
      const f = shape[x];
      const sy = seam[x];
      const O = openPx * f;
      const U = O * 0.28; // Oberlippe hoch
      const D = O - U; // Unterlippe/Kinn runter
      for (let py = 0; py < H; py++) {
        const y = y0 + py;
        const i = (py * W + px) * 4;
        if (O < 0.3) {
          o[i] = s[i];
          o[i + 1] = s[i + 1];
          o[i + 2] = s[i + 2];
          o[i + 3] = s[i + 3];
          continue;
        }
        if (y < sy - U) {
          // oberhalb: Oberlippe nach oben schieben, nach oben hin auslaufend
          const d = U * (1 - smoothstep(0, upH, sy - U - y));
          sample(px, y + d - y0, i);
        } else if (y > sy + D) {
          // unterhalb: Unterlippe und Kinn nach unten, zum Kinn hin auslaufend
          const d = D * (1 - smoothstep(0, jawH, y - sy - D));
          sample(px, y - d - y0, i);
        } else {
          // Mundöffnung: innen dunkel, zu den Lippenrändern hin weich
          const t = (y - (sy - U)) / Math.max(0.5, U + D); // 0 oben .. 1 unten
          const edge = Math.min(1, Math.min(y - (sy - U), sy + D - y) / 1.2 + 0.15);
          const shade = 0.75 + 0.25 * Math.sin(t * Math.PI); // Mitte etwas heller (Zunge/Tiefe)
          const k = Math.min(1, f * 2.5) * edge;
          // Ausgangsfarbe: Lippenfuge an dieser Stelle
          const si = (Math.max(0, Math.min(H - 1, Math.round(sy - y0))) * W + px) * 4;
          o[i] = s[si] * (1 - k) + ir * shade * k;
          o[i + 1] = s[si + 1] * (1 - k) + ig * shade * k;
          o[i + 2] = s[si + 2] * (1 - k) + ib * shade * k;
          o[i + 3] = 255;
        }
      }
    }
    this.frameCtx.putImageData(out, x0, y0);
  }

  renderEyes(ctx, blink) {
    if (blink <= 0.02) return;
    if (this.eyesImg) {
      ctx.globalAlpha = Math.min(1, blink * 1.5);
      ctx.drawImage(this.eyesImg, 0, 0);
      ctx.globalAlpha = 1;
      return;
    }
    for (const e of this.eyeLids) {
      const { x, y, r, skin } = e;
      const ry = r * 0.7;
      const lidY = y - ry + 2 * ry * blink;
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(x, y, r * 1.08, ry * 1.15, 0, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = `rgb(${skin[0] | 0},${skin[1] | 0},${skin[2] | 0})`;
      ctx.fillRect(x - r * 1.2, y - ry * 1.3, r * 2.4, lidY - (y - ry * 1.3));
      ctx.restore();
      // Wimpernlinie
      ctx.strokeStyle = `rgba(${skin[0] * 0.35},${skin[1] * 0.3},${skin[2] * 0.3},${0.85 * blink})`;
      ctx.lineWidth = Math.max(1, r * 0.16);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.ellipse(x, lidY - ry * 0.25 * (1 - blink), r * 0.98, ry * 0.25, 0, 0.1, Math.PI - 0.1);
      ctx.stroke();
    }
  }

  buildBackground() {
    const c = this.doc.createElement('canvas');
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    const g = c.getContext('2d');
    // dezenter Verlauf, falls das Bild selbst transparent ist
    const grad = g.createLinearGradient(0, 0, 0, c.height);
    grad.addColorStop(0, '#26303f');
    grad.addColorStop(1, '#12161d');
    g.fillStyle = grad;
    g.fillRect(0, 0, c.width, c.height);
    if (!this.hasAlpha) {
      const s = Math.max(c.width / this.w, c.height / this.h) * 1.1;
      g.filter = 'blur(24px) brightness(0.55) saturate(1.1)';
      g.drawImage(this.base, (c.width - this.w * s) / 2, (c.height - this.h * s) / 2, this.w * s, this.h * s);
    }
    this.bg = c;
  }

  draw(t) {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (!this.ready) return;
    if (!this.transparent) {
      if (!this.bg) this.buildBackground();
      ctx.drawImage(this.bg, 0, 0);
    }

    // Mund glätten: schnell öffnen, etwas langsamer schließen
    const target = this.speaking ? this.level : 0;
    this.open += (target - this.open) * (target > this.open ? 0.55 : 0.3);

    // Blinzeln alle paar Sekunden
    const now = performance.now();
    if (now > this.nextBlink) {
      this.blinkStart = now;
      this.nextBlink = now + 2200 + Math.random() * 4000 + (Math.random() < 0.15 ? -1800 : 0);
    }
    const bt = (now - this.blinkStart) / 160;
    this.blink = bt < 1 ? Math.sin(bt * Math.PI) : 0;

    // Frame zusammensetzen
    if (this.mouthImg) {
      this.frameCtx.drawImage(this.base, 0, 0);
      if (this.open > 0.08) {
        this.frameCtx.globalAlpha = Math.min(1, this.open * 2.2);
        this.frameCtx.drawImage(this.mouthImg, 0, 0);
        this.frameCtx.globalAlpha = 1;
      }
      this.lastOpenPx = -1;
    } else {
      if (this.blinkWasDrawn) {
        // Augenbereich zurücksetzen
        this.frameCtx.drawImage(this.base, 0, 0);
        this.lastOpenPx = -1;
      }
      this.renderMouth(this.open);
    }
    this.renderEyes(this.frameCtx, this.blink);
    this.blinkWasDrawn = this.blink > 0.02 || !!this.mouthImg;

    // Körperbewegung: atmen, wiegen, beim Sprechen nicken
    const m = this.motion;
    const breathe = Math.sin(t * 1.7) * 0.006 * m;
    const sway = (Math.sin(t * 0.55) * 0.006 + Math.sin(t * 0.23) * 0.004) * m;
    const talk = this.speaking ? (Math.sin(t * 6.3) * 0.006 + Math.sin(t * 3.1) * 0.004) * this.open * m : 0;
    const think = this.thinking ? Math.sin(t * 1.2) * 0.008 * m : 0;
    const lean = this.listening ? 0.012 * m : 0;
    this.lean = (this.lean ?? 0) + (lean - (this.lean ?? 0)) * 0.05;

    // freischwebend etwas Rand lassen, damit beim Wiegen nichts abgeschnitten wird
    const fit = Math.min(W / this.w, H / this.h) * (this.transparent ? 0.94 : 1);
    const dw = this.w * fit;
    const dh = this.h * fit;
    ctx.save();
    ctx.translate(W / 2, (H + dh) / 2); // Drehpunkt unten Mitte
    ctx.rotate(sway + talk + think);
    ctx.scale(1 + this.lean, 1 + breathe + this.lean);
    ctx.translate(Math.sin(t * 0.4) * 2 * m, -talk * dh * 0.3);
    ctx.drawImage(this.frame, -dw / 2, -dh, dw, dh);
    ctx.restore();
  }
}

/** Grobe automatische Gesichtserkennung (falls der Browser FaceDetector unterstützt). */
export async function detectFace(src) {
  if (!('FaceDetector' in window)) return null;
  try {
    const img = await loadImage(src);
    const faces = await new window.FaceDetector({ fastMode: false, maxDetectedFaces: 1 }).detect(img);
    const f = faces[0];
    if (!f) return null;
    const bb = f.boundingBox;
    const nx = (v) => v / img.width;
    const ny = (v) => v / img.height;
    const eyes = [];
    let mouth = null;
    for (const lm of f.landmarks ?? []) {
      const p = lm.locations?.[0] ?? lm.location;
      if (!p) continue;
      if (lm.type === 'eye') eyes.push({ x: nx(p.x), y: ny(p.y), r: nx(bb.width * 0.09) });
      if (lm.type === 'mouth') mouth = { x: nx(p.x), y: ny(p.y), w: nx(bb.width * 0.36) };
    }
    if (eyes.length < 2) {
      eyes.length = 0;
      eyes.push(
        { x: nx(bb.x + bb.width * 0.32), y: ny(bb.y + bb.height * 0.42), r: nx(bb.width * 0.09) },
        { x: nx(bb.x + bb.width * 0.68), y: ny(bb.y + bb.height * 0.42), r: nx(bb.width * 0.09) },
      );
    }
    mouth ??= { x: nx(bb.x + bb.width / 2), y: ny(bb.y + bb.height * 0.78), w: nx(bb.width * 0.36) };
    return { eyes, mouth };
  } catch {
    return null;
  }
}
