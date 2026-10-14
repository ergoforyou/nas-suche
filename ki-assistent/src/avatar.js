// Avatar-Animation aus einem einzelnen Bild ("PNGtuber light"):
// Atmen, leichtes Wiegen, Blinzeln, Kopfnicken beim Sprechen und ein Mund,
// der sich passend zur Lautstärke der Stimme öffnet.
//
// Zwei Wege für Mund/Augen:
//  1. Prozedural: Mund- und Augenpositionen werden im Bild markiert, die App
//     verformt das Bild an der Stelle (Kiefer klappt runter, Lider schließen).
//  2. Bildwechsel: Optional eigene Bilder "Mund offen" und "Augen zu" hochladen.

import { borderColor } from './cutout.js';
import { loadVideoMask } from './videomask.js';

const MAX_SIDE = 1024;
const MAX_VIDEO_SIDE = 640; // Videos werden pro Bild verarbeitet – kleiner halten

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
  constructor(canvas, { transparent = false, useLayout = false } = {}) {
    this.useLayout = useLayout;
    this.layout = { x: 0, y: 0, scale: 1 };
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
    this.layers?.forEach((L) => L.isVideo && L.video.pause());
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
    this.flip = !!config.flip;
    // Position/Größe innerhalb der Bühne (nur im Chatfenster; die freie Figur nutzt das Fenster selbst)
    this.layout = { x: 0, y: 0, scale: 1, ...(this.useLayout ? config.stage ?? {} : {}) };
    // Ebene 0 = Grundbild, danach die Posen. Jede Ebene hat eigene Mund-/Augen-/Kopfdaten.
    const cfgs = [config, ...(config.poses ?? []).filter((p) => p?.image || p?.video)];
    const layers = [];
    for (const c of cfgs) {
      try {
        layers.push(await this.createLayer(c));
      } catch (e) {
        if (!layers.length) throw e; // Grundbild muss laden, defekte Posen werden übersprungen
      }
    }
    this.layers?.forEach((L) => L.isVideo && L.video.pause());
    this.layers = layers;
    const main = layers[0];
    Object.assign(this, { w: main.w, h: main.h, base: main.base, hasAlpha: main.hasAlpha });
    this.current = 0;
    this.prev = null;
    this.poseUntil = 0;
    this.bg = null;
    this.ready = true;
  }

  /** Video-Ebene: kurzer Clip (MP4/WebM), wird Bild für Bild gezeichnet und bei Bedarf freigestellt. */
  async createVideoLayer(cfg) {
    const L = Object.create(this);
    L.config = cfg;
    L.isVideo = true;
    L.head = null;
    const v = this.doc.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.loop = !!cfg.loop;
    v.src = cfg.video;
    await new Promise((resolve, reject) => {
      v.onloadeddata = resolve;
      v.onerror = () => reject(new Error('Video konnte nicht geladen werden (Format?)'));
    });
    const scale = Math.min(1, MAX_VIDEO_SIDE / Math.max(v.videoWidth, v.videoHeight));
    L.w = Math.max(2, Math.round(v.videoWidth * scale));
    L.h = Math.max(2, Math.round(v.videoHeight * scale));
    L.video = v;
    L.frame = this.doc.createElement('canvas');
    L.frame.width = L.w;
    L.frame.height = L.h;
    L.frameCtx = L.frame.getContext('2d', { willReadFrequently: true });
    // Freistellen: 'color' (Greenscreen), 'flood' (einfarbige Wand), 'ai' (vorberechnete KI-Masken), 'none'
    L.cutMode = cfg.cutMode ?? (cfg.key ? 'color' : 'none');
    if (L.cutMode === 'ai' && cfg.mask) {
      try {
        L.mask = await loadVideoMask(cfg.mask);
        L.w = L.mask.w;
        L.h = L.mask.h;
        L.frame.width = L.w;
        L.frame.height = L.h;
      } catch {
        L.mask = null;
      }
    }
    L.hasAlpha = L.cutMode !== 'none';
    L.keyColor = null;
    L.lastVideoTime = -1;
    return L;
  }

  /** Aktuelles Videobild zeichnen; einfarbigen Hintergrund (z. B. Greenscreen) entfernen. */
  buildVideoFrame() {
    const v = this.video;
    if (v.readyState < 2 || v.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = v.currentTime;
    const g = this.frameCtx;
    g.clearRect(0, 0, this.w, this.h);
    g.drawImage(v, 0, 0, this.w, this.h);
    const mode = this.cutMode;
    if (mode === 'none' || (mode === 'ai' && !this.mask)) return;
    const img = g.getImageData(0, 0, this.w, this.h);
    const d = img.data;
    if (mode === 'ai') {
      // vorberechnete KI-Maske des passenden Einzelbilds anwenden
      const M = this.mask;
      const a = M.frame(Math.min(M.n - 1, Math.max(0, Math.round(v.currentTime * M.fps))));
      for (let p = 0, i = 3; p < a.length; p++, i += 4) d[i] = a[p];
      g.putImageData(img, 0, 0);
      return;
    }
    if (mode === 'flood') {
      this.floodKey(d);
      g.putImageData(img, 0, 0);
      return;
    }
    // Hintergrundfarbe aus dem ersten Bild bestimmen und beibehalten (sonst flackert es)
    this.keyColor ??= borderColor(d, this.w, this.h);
    const [kr, kg, kb] = this.keyColor;
    const t1 = ((this.config.keyTol ?? 30) / 100) * 160;
    const t2 = t1 * 1.6;
    const greenKey = kg > kr + 30 && kg > kb + 30;
    for (let i = 0; i < d.length; i += 4) {
      const dr = d[i] - kr;
      const dg = d[i + 1] - kg;
      const db = d[i + 2] - kb;
      const dist = Math.sqrt(dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11) * 1.7;
      if (dist <= t1) d[i + 3] = 0;
      else if (dist < t2) {
        d[i + 3] = (d[i + 3] * (dist - t1)) / (t2 - t1);
        // grünen Farbsaum an den Kanten abschwächen
        if (greenKey) d[i + 1] = Math.min(d[i + 1], Math.max(d[i], d[i + 2]));
      }
    }
    g.putImageData(img, 0, 0);
  }

  /** Einfarbige Wand entfernen: nur Hintergrund, der vom Bildrand aus zusammenhängt (weiße Kleidung bleibt). */
  floodKey(d) {
    const W = this.w;
    const H = this.h;
    this.keyColor ??= borderColor(d, W, H);
    const [kr, kg, kb] = this.keyColor;
    const t1 = ((this.config.keyTol ?? 30) / 100) * 160;
    const t2 = t1 * 1.5;
    const dist = (p) => {
      const i = p * 4;
      const dr = d[i] - kr;
      const dg = d[i + 1] - kg;
      const db = d[i + 2] - kb;
      return Math.sqrt(dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11) * 1.7;
    };
    const bg = (this.floodBuf ??= new Uint8Array(W * H));
    bg.fill(0);
    const stack = (this.floodStack ??= new Int32Array(W * H));
    let sp = 0;
    const seed = (p) => {
      if (!bg[p] && dist(p) <= t1) {
        bg[p] = 1;
        stack[sp++] = p;
      }
    };
    // Nur vom oberen Rand und den oberen zwei Dritteln der Seiten aus füllen: Eine Person reicht meist bis zum
    // unteren Bildrand – sonst würde helle Kleidung dort als Hintergrund "ausgelaufen".
    for (let x = 0; x < W; x++) seed(x);
    for (let y = 0; y < H * 0.66; y++) {
      seed(y * W);
      seed(y * W + W - 1);
    }
    while (sp) {
      const p = stack[--sp];
      const x = p % W;
      if (x > 0) seed(p - 1);
      if (x < W - 1) seed(p + 1);
      if (p >= W) seed(p - W);
      if (p < W * (H - 1)) seed(p + W);
    }
    for (let p = 0; p < W * H; p++) {
      if (bg[p]) d[p * 4 + 3] = 0;
      else {
        // weicher Rand: Pixel direkt neben dem Hintergrund mit ähnlicher Farbe teiltransparent
        const x = p % W;
        const near = (x > 0 && bg[p - 1]) || (x < W - 1 && bg[p + 1]) || (p >= W && bg[p - W]) || (p < W * (H - 1) && bg[p + W]);
        if (near) {
          const di = dist(p);
          if (di < t2) d[p * 4 + 3] = Math.round((d[p * 4 + 3] * (di - t1)) / (t2 - t1));
        }
      }
    }
  }

  /** Eine Bild-Ebene vorbereiten. Die Ebene erbt alles Gemeinsame (Zustand, Bewegung) vom Avatar. */
  async createLayer(cfg) {
    if (cfg.video) return this.createVideoLayer(cfg);
    const L = Object.create(this);
    L.config = cfg;
    L.lastOpenPx = -1;
    L.blinkWasDrawn = false;
    const img = await loadImage(cfg.image, this.host);
    const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
    L.w = Math.round(img.width * scale);
    L.h = Math.round(img.height * scale);
    L.base = toCanvas(img, L.w, L.h, this.doc);
    L.frame = toCanvas(img, L.w, L.h, this.doc);
    L.frameCtx = L.frame.getContext('2d', { willReadFrequently: true });
    const extra = async (src) => (src ? toCanvas(await loadImage(src, this.host), L.w, L.h, this.doc) : null);
    L.mouthImg = await extra(cfg.mouthImage);
    L.eyesImg = await extra(cfg.eyesImage);
    // Hat das Bild transparente Bereiche (freigestellt)? Dann kein weichgezeichneter Bildhintergrund.
    const corners = L.base.getContext('2d', { willReadFrequently: true });
    L.hasAlpha = [
      [0, 0],
      [L.w - 1, 0],
      [0, L.h - 1],
      [L.w - 1, L.h - 1],
    ].some(([x, y]) => corners.getImageData(x, y, 1, 1).data[3] < 128);
    const mask = await extra(cfg.mouthMask);
    L.maskData = mask ? mask.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, L.w, L.h).data : null;
    L.prepareMouth();
    L.prepareEyes();
    L.prepareHead();
    return L;
  }

  /** Mund und Augen der Ebene für den aktuellen Moment einzeichnen. */
  buildFrame() {
    if (this.isVideo) return this.buildVideoFrame();
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
  }

  // ---------- Posen: passend zum Zustand wechseln, weich überblenden ----------
  /** Für den Editor: eine bestimmte Ebene festhalten (null = automatisch). */
  previewPose(index) {
    this.forcePose = index;
  }

  switchPose(i, now) {
    if (i === this.current) return;
    this.prev = this.current;
    this.current = i;
    this.fadeStart = now;
    const L = this.layers?.[i];
    if (L?.isVideo) {
      L.video.currentTime = 0;
      L.video.play().catch(() => {});
    }
  }

  /** Videos, die gerade nicht zu sehen sind, anhalten. */
  pauseHiddenVideos() {
    this.layers?.forEach((L, i) => {
      if (L.isVideo && i !== this.current && i !== this.prev && !L.video.paused) L.video.pause();
    });
  }

  updatePose(now) {
    const n = this.layers?.length ?? 0;
    const curL = this.layers?.[this.current];
    if (this.forcePose != null) {
      this.switchPose(Math.min(this.forcePose, n - 1), now);
      // Vorschau im Editor: Video immer wieder abspielen
      if (curL?.isVideo && curL.video.ended) {
        curL.video.currentTime = 0;
        curL.video.play().catch(() => {});
      }
      return;
    }
    // Einmal abgespielte Videos kehren danach zum Grundbild zurück
    if (curL?.isVideo && !curL.config.loop && curL.video.ended) {
      this.switchPose(0, now);
      this.poseUntil = now + 2500 + Math.random() * 4000;
      return;
    }
    if (n < 2) return this.switchPose(0, now);
    const st = this.speaking ? 'speak' : this.thinking ? 'think' : this.listening ? 'listen' : 'idle';
    const rnd = (a, b) => a + Math.random() * (b - a);
    const cand = [];
    for (let i = 1; i < n; i++) if ((this.layers[i].config.trigger ?? 'speak') === st) cand.push(i);
    if (st !== this.poseState) {
      this.poseState = st;
      this.poseUntil = 0;
    }
    if (now < this.poseUntil) return;
    const pick = (list) => list[Math.floor(Math.random() * list.length)];
    let next = 0;
    let hold;
    if (st === 'idle') {
      // meist das Grundbild, ab und zu eine Ruhe-Pose
      if (this.current === 0 && cand.length && Math.random() < 0.45) {
        next = pick(cand);
        hold = rnd(2500, 5500);
      } else hold = rnd(5000, 12000);
    } else if (st === 'speak') {
      // beim Sprechen zwischen Grundbild und Sprech-Posen wechseln
      const options = [0, ...cand].filter((i) => i !== this.current);
      next = cand.length ? pick(options.length ? options : [0]) : 0;
      hold = rnd(2200, 4500);
    } else {
      next = cand.length ? pick(cand) : 0;
      hold = 1e9; // bleibt, solange der Zustand anhält
    }
    const nextL = this.layers[next];
    if (nextL?.isVideo && !nextL.config.loop) hold = 1e9; // endet über "ended"
    this.switchPose(next, now);
    this.poseUntil = now + hold;
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

  /** Kopfbereich bestimmen: alles oberhalb des Halses kann sich unabhängig vom Körper bewegen. */
  prepareHead() {
    this.head = null;
    this.posed = this.doc.createElement('canvas');
    this.posed.width = this.w;
    this.posed.height = this.h;
    this.posedCtx = this.posed.getContext('2d');
    const eyes = this.config.eyes ?? [];
    const mouth = this.config.mouth;
    if (!eyes.length || !mouth) return;
    const eyeY = (eyes.reduce((a, e) => a + e.y, 0) / eyes.length) * this.h;
    const eyeX = (eyes.reduce((a, e) => a + e.x, 0) / eyes.length) * this.w;
    const mouthY = mouth.y * this.h;
    const faceH = Math.max(8, mouthY - eyeY);
    const neckY = Math.min(this.h - 2, mouthY + faceH * 1.25);
    this.head = { pivotX: (eyeX + mouth.x * this.w) / 2, neckY, band: faceH * 0.55, faceH };
  }

  // ---------- Verhalten: kleine Kopfbewegungen je nach Zustand ----------
  updateBehaviour(now, dt) {
    const h = (this.layers?.[this.current] ?? this).head;
    if (!h) return;
    const B = (this.behaviour ??= {
      tilt: 0, look: 0, nod: 0, vt: 0, vl: 0, vn: 0,
      target: { tilt: 0, look: 0, nod: 0 },
      next: now + 1500, kick: 0, lastKick: 0, lastLevel: 0,
    });
    const rnd = (a, b) => a + Math.random() * (b - a);
    const side = () => (Math.random() < 0.5 ? -1 : 1);
    const f = h.faceH;

    if (this.thinking) {
      // nachdenklich: Kopf schräg, Blick leicht nach oben
      if (B.mode !== 'think') {
        B.mode = 'think';
        B.target = { tilt: 0.05 * side(), look: f * 0.15 * side(), nod: -f * 0.08 };
      }
    } else if (this.listening) {
      if (B.mode !== 'listen') {
        B.mode = 'listen';
        B.target = { tilt: 0.03 * side(), look: 0, nod: f * 0.03 };
      }
    } else if (this.speaking) {
      B.mode = 'speak';
      if (now > B.next) {
        B.target = { tilt: rnd(-0.035, 0.035), look: rnd(-0.12, 0.12) * f, nod: 0 };
        B.next = now + rnd(900, 2200);
      }
      // Betonung: bei Silbenspitzen kurz nicken
      const lvl = this.level;
      if (lvl > 0.45 && B.lastLevel < 0.3 && now - B.lastKick > 380) {
        B.kick = f * rnd(0.04, 0.08);
        B.lastKick = now;
      }
      B.lastLevel = lvl;
    } else {
      // Leerlauf: ab und zu umschauen, Kopf neigen oder zurück zur Mitte
      if (B.mode !== 'idle') {
        B.mode = 'idle';
        B.next = now + rnd(800, 2000);
      }
      if (now > B.next) {
        const r = Math.random();
        if (r < 0.3) B.target = { tilt: 0, look: 0, nod: 0 };
        else if (r < 0.6) B.target = { tilt: rnd(0.02, 0.05) * side(), look: 0, nod: f * rnd(0, 0.04) };
        else if (r < 0.85) B.target = { tilt: rnd(-0.015, 0.015), look: f * rnd(0.1, 0.22) * side(), nod: 0 };
        else B.target = { tilt: 0, look: 0, nod: -f * 0.05 };
        B.next = now + rnd(1800, 5000);
      }
    }
    // weiche Federn hin zum Ziel
    const k = Math.min(1, dt * 0.004);
    for (const [x, v] of [['tilt', 'vt'], ['look', 'vl'], ['nod', 'vn']]) {
      B[v] += (B.target[x] - B[x]) * k * 1.6;
      B[v] *= 0.82;
      B[x] += B[v];
    }
    B.kick *= Math.pow(0.86, dt / 16);
  }

  /** Kopf über dem Hals verschieben/neigen (zeilenweise, ohne Nahtstelle). */
  renderPose() {
    const h = this.head;
    const m = this.motion;
    const B = this.behaviour;
    if (!h || !B || m <= 0) return this.frame;
    const ctx = this.posedCtx;
    const W = this.w;
    const yEnd = Math.min(this.h, Math.ceil(h.neckY + h.band));
    ctx.clearRect(0, 0, W, this.h);
    ctx.drawImage(this.frame, 0, yEnd, W, this.h - yEnd, 0, yEnd, W, this.h - yEnd);
    const tilt = B.tilt * m;
    const look = B.look * m;
    const nod = (B.nod + B.kick) * m;
    const step = 2;
    for (let y = 0; y < yEnd; y += step) {
      const wgt = 1 - smoothstep(h.neckY - h.band, h.neckY + h.band, y);
      const dx = ((h.neckY - y) * tilt + look) * wgt;
      const sy = Math.max(0, y - nod * wgt);
      const rows = Math.min(step, this.h - sy);
      if (rows > 0) ctx.drawImage(this.frame, 0, sy, W, rows, dx, y, W, rows);
    }
    return this.posed;
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

    const dt = Math.min(100, now - (this.lastNow ?? now));
    this.lastNow = now;
    this.updateBehaviour(now, dt);
    this.updatePose(now);
    const fade = this.prev == null ? 1 : Math.min(1, (now - this.fadeStart) / 380);
    if (fade >= 1) this.prev = null;
    this.pauseHiddenVideos();
    const visible = [];
    if (this.prev != null && this.layers[this.prev]) visible.push([this.layers[this.prev], 1]);
    const cur = this.layers[this.current] ?? this.layers[0];
    visible.push([cur, this.prev != null ? fade : 1]);
    const drawn = visible.map(([L, a]) => {
      L.buildFrame();
      return [L, L.renderPose(), a];
    });

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
    const L = this.layout;
    this.fitPx = this.h * fit; // Figurhöhe in Gerätepixeln bei Maßstab 1
    const dw = this.w * fit * L.scale;
    const dh = this.h * fit * L.scale;
    const bx = W / 2 + L.x * W;
    const by = (H + this.h * fit) / 2 + L.y * H;
    // Position der Figur (ohne Wiegen) für Auswahlrahmen und Trefferprüfung, in CSS-Pixeln
    const dpr = this.host.devicePixelRatio || 1;
    this.rect = { x: (bx - dw / 2) / dpr, y: (by - dh) / dpr, w: dw / dpr, h: dh / dpr };
    ctx.save();
    ctx.translate(bx, by); // Drehpunkt unten Mitte
    ctx.rotate(sway + talk + think);
    if (this.flip) ctx.scale(-1, 1);
    ctx.scale(1 + this.lean, 1 + breathe + this.lean);
    ctx.translate(Math.sin(t * 0.4) * 2 * m, -talk * dh * 0.3);
    // Posen mit anderem Seitenverhältnis auf gleiche Höhe bringen, unten mittig ausgerichtet
    for (const [L, img, a] of drawn) {
      const lw = dh * (L.w / L.h);
      ctx.globalAlpha = a;
      ctx.drawImage(img, -lw / 2, -dh, lw, dh);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  /** Figur so platzieren, dass sie das angegebene Rechteck (CSS-Pixel) ausfüllt. */
  setRect(r) {
    const dpr = this.host.devicePixelRatio || 1;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const fitPx = this.fitPx || H;
    const bx = (r.x + r.w / 2) * dpr;
    const by = (r.y + r.h) * dpr;
    this.layout = { x: (bx - W / 2) / W, y: (by - (H + fitPx) / 2) / H, scale: (r.h * dpr) / fitPx };
  }

  /** Liegt der Punkt (CSS-Pixel) auf der Figur? Bei freigestellten Bildern zählt nur die Figur selbst. */
  hitTest(x, y) {
    const r = this.rect;
    if (!r || x < r.x || y < r.y || x > r.x + r.w || y > r.y + r.h) return false;
    if (!this.hasAlpha) return true;
    const dpr = this.host.devicePixelRatio || 1;
    const px = Math.round(x * dpr);
    const py = Math.round(y * dpr);
    if (px < 0 || py < 0 || px >= this.canvas.width || py >= this.canvas.height) return false;
    return this.ctx.getImageData(px, py, 1, 1).data[3] > 30;
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
