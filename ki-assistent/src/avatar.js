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

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Bild konnte nicht geladen werden'));
    img.src = src;
  });
}

function toCanvas(img, w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0, w, h);
  return c;
}

export class Avatar {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.level = 0; // Ziel-Lautstärke 0..1
    this.open = 0; // geglättete Mundöffnung 0..1
    this.speaking = false;
    this.thinking = false;
    this.listening = false;
    this.blink = 0;
    this.nextBlink = performance.now() + 2500;
    this.blinkStart = 0;
    this.motion = 1;
    this.config = null;
    this.ready = false;
    this.lastOpenPx = -1;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    const loop = (t) => {
      this.draw(t / 1000);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.bg = null;
  }

  /**
   * config: { image, mouthImage?, eyesImage?, mouth?: {x,y,w}, eyes?: [{x,y,r}], motion? }
   * Koordinaten normiert auf 0..1 bezogen auf Bildbreite/-höhe.
   */
  async setConfig(config) {
    this.ready = false;
    this.config = config;
    this.motion = config.motion ?? 1;
    const img = await loadImage(config.image);
    const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
    this.w = Math.round(img.width * scale);
    this.h = Math.round(img.height * scale);
    this.base = toCanvas(img, this.w, this.h);
    this.frame = toCanvas(img, this.w, this.h);
    this.frameCtx = this.frame.getContext('2d', { willReadFrequently: true });
    this.mouthImg = config.mouthImage ? toCanvas(await loadImage(config.mouthImage), this.w, this.h) : null;
    this.eyesImg = config.eyesImage ? toCanvas(await loadImage(config.eyesImage), this.w, this.h) : null;
    this.prepareMouth();
    this.prepareEyes();
    this.bg = null;
    this.lastOpenPx = -1;
    this.ready = true;
  }

  prepareMouth() {
    this.mouthRegion = null;
    const m = this.config.mouth;
    if (!m || this.mouthImg) return;
    const mx = m.x * this.w;
    const my = m.y * this.h;
    const mw = Math.max(6, m.w * this.w);
    const halfW = mw * 0.95;
    const jawH = mw * 1.5;
    const x0 = Math.max(0, Math.floor(mx - halfW));
    const x1 = Math.min(this.w, Math.ceil(mx + halfW));
    const y0 = Math.max(0, Math.floor(my - mw * 0.6));
    const y1 = Math.min(this.h, Math.ceil(my + jawH));
    const src = this.base.getContext('2d', { willReadFrequently: true }).getImageData(x0, y0, x1 - x0, y1 - y0);
    this.mouthRegion = { mx, my, mw, halfW, jawH, x0, y0, x1, y1, src, out: new ImageData(src.width, src.height) };
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
  renderMouth(open) {
    const R = this.mouthRegion;
    if (!R) return;
    const openPx = Math.round(open * R.mw * 0.42 * 2) / 2;
    if (openPx === this.lastOpenPx) return;
    this.lastOpenPx = openPx;
    const { src, out, x0, y0, mx, my, halfW, jawH, mw } = R;
    const W = src.width;
    const H = src.height;
    const s = src.data;
    const o = out.data;
    if (openPx <= 0) {
      o.set(s);
      this.frameCtx.putImageData(out, x0, y0);
      return;
    }
    const flat = mw * 0.42;
    for (let py = 0; py < H; py++) {
      const y = y0 + py;
      const dy = y - my;
      const fy = dy < 0 ? 0 : 1 - smoothstep(0, jawH, dy);
      for (let px = 0; px < W; px++) {
        const x = x0 + px;
        const ax = Math.abs(x - mx);
        const fx = ax <= flat ? 1 : 1 - smoothstep(flat, halfW, ax);
        const d = openPx * fx * fy;
        const i = (py * W + px) * 4;
        const sy = y - d;
        if (dy >= 0 && sy < my && fx > 0.02) {
          // Mundinnenraum: oben ein Hauch Zähne, sonst dunkel
          const gap = d - dy; // Abstand bis zur Unterlippe
          const depth = Math.min(1, dy / Math.max(1, d));
          const teeth = depth < 0.22 && openPx > 4 ? 1 : 0;
          const edge = Math.min(1, gap / 1.5, fx * 3);
          const ir = teeth ? 225 : 70 - depth * 30;
          const ig = teeth ? 215 : 22 - depth * 8;
          const ib = teeth ? 210 : 28 - depth * 10;
          // mit Originalpixel weich mischen
          const syi = Math.min(H - 1, Math.max(0, Math.round(sy - y0)));
          const si = (syi * W + px) * 4;
          o[i] = s[si] * (1 - edge) + ir * edge;
          o[i + 1] = s[si + 1] * (1 - edge) + ig * edge;
          o[i + 2] = s[si + 2] * (1 - edge) + ib * edge;
          o[i + 3] = 255;
        } else {
          // bilineare Abtastung in y-Richtung
          const fyy = sy - y0;
          const a = Math.max(0, Math.min(H - 1, Math.floor(fyy)));
          const b = Math.min(H - 1, a + 1);
          const t = Math.min(1, Math.max(0, fyy - a));
          const ia = (a * W + px) * 4;
          const ib = (b * W + px) * 4;
          o[i] = s[ia] + (s[ib] - s[ia]) * t;
          o[i + 1] = s[ia + 1] + (s[ib + 1] - s[ia + 1]) * t;
          o[i + 2] = s[ia + 2] + (s[ib + 2] - s[ia + 2]) * t;
          o[i + 3] = s[ia + 3] + (s[ib + 3] - s[ia + 3]) * t;
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
    const c = document.createElement('canvas');
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    const g = c.getContext('2d');
    const s = Math.max(c.width / this.w, c.height / this.h) * 1.1;
    g.filter = 'blur(24px) brightness(0.55) saturate(1.1)';
    g.drawImage(this.base, (c.width - this.w * s) / 2, (c.height - this.h * s) / 2, this.w * s, this.h * s);
    this.bg = c;
  }

  draw(t) {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (!this.ready) return;
    if (!this.bg) this.buildBackground();
    ctx.drawImage(this.bg, 0, 0);

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

    const fit = Math.min(W / this.w, H / this.h);
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
