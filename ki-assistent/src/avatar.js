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
import { createMorpher } from './morph.js';
import { createParallax, figureCenterX, imageKey } from './parallax.js';
import { createFaceWarp, faceHandles } from './facerig.js';
import { MOODS } from './mood.js';
import { bodyHandles } from './bodyrig.js';

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
// mood/moodAt: Stimmung aus der Antwort; viseme: Mundöffnung je Laut (null = unbekannt); voice: Mikrofonpegel (≥ 1 = Sprache)
export const avatarState = {
  level: 0, speaking: false, thinking: false, listening: false, shape: 0, mood: null, moodAt: 0, viseme: null, voice: 0,
  // kurze Anlässe (begrüßen, verabschieden, verstanden, Fehler, geschafft, Erinnerung): { name, at, until }
  event: null,
  // worauf gewartet wird: 'tool' (Internet, Datei) | 'calendar' (Kalender/Aufgaben) | null
  wait: null,
  // Tageszeit beeinflusst die Lebhaftigkeit (morgens munter, abends ruhiger)
  timeOfDay: true,
};

/** Kurzen Anlass auslösen – passende Posen haben dann Vorrang. */
export function fireEvent(name, ms = 3000) {
  const now = performance.now();
  avatarState.event = { name, at: now, until: now + ms };
}

/** Lebhaftigkeit je nach Tageszeit (1 = normal). */
export function timeOfDayEnergy(h = new Date().getHours()) {
  if (h >= 6 && h < 10) return 1.1;
  if (h >= 18 && h < 22) return 0.88;
  if (h >= 22 || h < 6) return 0.75;
  return 1;
}

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
    // Körper-Rig: Schultern bewegen nur auf dem Handy; am PC bleiben sie stehen (sonst Verzerrungen am Schulterrand)
    this.bodyShoulders = globalThis.desktop?.platform === 'android';
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
    this.maxFps = 0; // 0 = so flüssig wie möglich; Akku-Sparmodus setzt z. B. 15
    let lastDraw = -1e9;
    const loop = (t) => {
      if (!this.active) return;
      if (!this.maxFps || t - lastDraw >= 1000 / this.maxFps - 4) {
        lastDraw = t;
        this.draw(t / 1000);
      }
      this.host.requestAnimationFrame(loop);
    };
    this.host.requestAnimationFrame(loop);
  }

  destroy() {
    this.active = false;
    this.layers?.forEach((L) => {
      L.morpher?.dispose();
      L.faceWarp?.dispose();
      L.bodyWarp?.dispose();
    });
    this.parallax?.dispose();
    this.layers?.forEach((L) => L.isVideo && L.video.pause());
    this.vrmFigure?.dispose();
    this.vrmFigure = null;
  }

  /** Zeichenauflösung: auf dem Handy höchstens 1,5-fach – spart viel Rechenzeit, sieht kaum anders aus. */
  get dpr() {
    const d = this.host.devicePixelRatio || 1;
    return this.doc.documentElement.classList.contains('mobile') ? Math.min(d, 1.5) : d;
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
    const dpr = this.dpr;
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
    this.idleHead = config.idleHead ?? 0.25; // Kopfbewegung im Leerlauf (0 = still)
    // Ruhiges Foto: ein Einzelbild nicht als Ganzes wiegen und verformen (wirkt künstlich) – nur Augen, Mund, Atmen
    this.calmPhoto = config.calmPhoto !== false;
    this.vrmYaw = config.vrmYaw ?? 0; // 3D-Figur: Drehung in Grad
    this.turnYaw = config.turnYaw ?? 0; // Bild-Figur: leichte Drehung in Grad (braucht Tiefenkarte)
    this.turnAuto = !!config.turnAuto; // Bild-Figur: im Leerlauf leicht mitdrehen
    this.vrmFraming = config.vrmFraming ?? 'brust'; // 3D-Figur: Bildausschnitt
    this.flip = !!config.flip;
    // Position/Größe innerhalb der Bühne (nur im Chatfenster; die freie Figur nutzt das Fenster selbst)
    // Standard etwas kleiner als die Bühne (Handy), damit rundum Platz zum Anfassen bleibt
    this.layout = { ...(this.defaultLayout ?? { x: 0, y: 0, scale: 1 }), ...(this.useLayout ? config.stage ?? {} : {}) };
    // feste Einpassung (passt sich an, wenn sich die Bühne ändert, z. B. Drehen des Handys)
    this.fitMode = this.useLayout && !config.stage ? config.stageFit ?? null : null;
    // Ebene 0 = Grundbild, danach die Posen. Jede Ebene hat eigene Mund-/Augen-/Kopfdaten.
    const cfgs = config.vrm ? [] : [config, ...(config.poses ?? []).filter((p) => p?.image || p?.video)];
    const layers = config.vrm ? [await this.createVrmLayer(config)] : [];
    if (!config.vrm && this.vrmFigure) {
      this.vrmFigure.dispose();
      this.vrmFigure = null;
    }
    for (const c of cfgs) {
      try {
        layers.push(await this.createLayer(c));
      } catch (e) {
        if (!layers.length) throw e; // Grundbild muss laden, defekte Posen werden übersprungen
      }
    }
    this.layers?.forEach((L) => {
      if (L.isVideo) L.video.pause();
      L.morpher?.dispose();
      L.faceWarp?.dispose();
    });
    this.layers = layers;
    const main = layers[0];
    Object.assign(this, { w: main.w, h: main.h, base: main.base, hasAlpha: main.hasAlpha });
    // Tiefenkarte für das leichte Drehen des Bild-Avatars
    this.parallax?.dispose();
    this.parallax = null;
    if (config.depth && config.depthFor === imageKey(config.image) && !config.vrm && !main.isVideo) {
      try {
        const depthImg = await loadImage(config.depth, this.host);
        this.parallax = createParallax(this.doc, depthImg, figureCenterX(main.base));
      } catch (e) {
        console.warn('Tiefenkarte:', e);
      }
    }
    this.current = 0;
    this.prev = null;
    this.poseUntil = 0;
    this.bg = null;
    this.ready = true;
  }

  /** 3D-Figur (VRM): wird in eine eigene WebGL-Leinwand gezeichnet und dann wie ein Bild verwendet. */
  async createVrmLayer(cfg) {
    if (this.vrmFigure?.url !== cfg.vrm) {
      this.vrmFigure?.dispose();
      this.vrmFigure = null;
      const { createVrmFigure } = await import('./vrm.js');
      this.vrmFigure = await createVrmFigure(this.doc, cfg.vrm);
    }
    const fig = this.vrmFigure;
    const L = Object.create(this);
    Object.assign(L, { config: cfg, isVrm: true, head: null, w: fig.width, h: fig.height, hasAlpha: true, frame: fig.canvas, base: fig.canvas });
    L.buildFrame = () =>
      fig.render({
        speaking: this.speaking,
        thinking: this.thinking,
        listening: this.listening,
        open: this.open,
        blink: this.blink,
        motion: this.motion,
        idleHead: this.idleHead,
        yaw: this.vrmYaw ?? 0,
        framing: this.vrmFraming ?? 'brust',
        mood: this.moodCur,
        ack: this.ackPulse,
        browKick: this.listening && performance.now() - (this.listen?.browAt ?? -1e9) < 700,
        shape: this.state.shape ?? 0,
      });
    return L;
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
    // Abschnitt: nur ein Teil des Videos wird verwendet (Anfang/Ende in Sekunden)
    const clip = cfg.clip && cfg.clip.end > cfg.clip.start + 0.2 ? cfg.clip : null;
    L.clip = clip;
    v.loop = !!cfg.loop && !clip;
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
    // Freistellen: 'color' (Greenscreen), 'flood' (einfarbige Wand), 'ai' (vorberechnete KI-Masken),
    // 'alpha' (Video ist schon freigestellt, z. B. WebM mit Transparenz), 'none'
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
    if (mode === 'none' || mode === 'alpha' || (mode === 'ai' && !this.mask)) return;
    const img = g.getImageData(0, 0, this.w, this.h);
    const d = img.data;
    if (mode === 'ai') {
      // vorberechnete KI-Maske des passenden Einzelbilds anwenden
      const M = this.mask;
      const a = M.frame(Math.min(M.n - 1, Math.max(0, Math.round((v.currentTime - (M.start ?? 0)) * M.fps))));
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
    // Gesichts-Rig (automatisch erkannte Gesichtspunkte) – nur, wenn es zu genau diesem Bild gehört
    if (cfg.faceRig && cfg.faceRigFor === imageKey(cfg.image) && cfg.faceRigOn !== false) {
      L.faceRig = cfg.faceRig;
      L.faceWarp = createFaceWarp(this.doc);
    }
    // Körper-Rig (Schultern, Arme): Atmen, Haltung, kleine Gesten – ebenfalls nur für genau dieses Bild
    if (cfg.bodyRig && cfg.bodyRigFor === imageKey(cfg.image) && cfg.bodyRigOn !== false) {
      L.bodyRig = cfg.bodyRig;
      L.bodyWarp = createFaceWarp(this.doc);
    }
    // Bewegungsbilder: fließender Übergang zwischen Grundbild und Zusatzbildern im Leerlauf
    L.morpher = null;
    const morphs = (cfg.morphs ?? []).filter(Boolean).slice(0, 4);
    if (morphs.length) {
      try {
        const imgs = [];
        for (const src of morphs) imgs.push(toCanvas(await loadImage(src, this.host), L.w, L.h, this.doc));
        const key = (s) => `${s.length}:${s.slice(-64)}`;
        L.morpher = createMorpher(this.doc, L.base, imgs, [key(cfg.image), ...morphs.map(key)]);
      } catch (e) {
        console.warn('Bewegungsbilder:', e);
      }
    }
    return L;
  }

  /** Leichtes Mitdrehen im Leerlauf/beim Sprechen (Grad), weich zwischen zufälligen Zielen. */
  updateAutoTurn(now, dt) {
    const A = (this.autoTurn ??= { v: 0, target: 0, next: 0 });
    if (!this.turnAuto) {
      A.v *= 0.9;
      return A.v;
    }
    if (now > A.next) {
      const range = this.speaking ? 5 : this.thinking ? 8 : 7;
      A.target = (Math.random() * 2 - 1) * range * (this.motion ?? 1);
      A.next = now + (this.speaking ? 1500 + Math.random() * 1800 : 3000 + Math.random() * 4000);
    }
    A.v += (A.target - A.v) * Math.min(1, dt / (this.speaking ? 600 : 1400));
    return A.v;
  }

  /** Vorschau im Editor: sofort zu Bewegungsbild i und nach kurzer Zeit zurück. */
  previewMorph(i) {
    const now = performance.now();
    this.morph = { t: this.morph?.t ?? 0, idx: i, last: i, phase: 'pose', until: now + 2600 };
  }

  /** Bewegungsbilder: im Leerlauf ab und zu fließend zu einem Zusatzbild und zurück. */
  updateMorph(now, dt) {
    const L = this.layers?.[this.current];
    const M = (this.morph ??= { t: 0, idx: 0, phase: 'base', until: now + 2000, last: -1 });
    if (!L?.morpher || this.prev != null) {
      M.t = 0;
      this.morphT = 0;
      return;
    }
    const rnd = (a, b) => a + Math.random() * (b - a);
    const busy = this.speaking || this.listening || this.forcePose != null;
    if (busy) {
      // zum Sprechen/Zuhören zurück zum Grundbild (dort sitzen Mund- und Augenanimation)
      M.phase = 'base';
      M.until = now + rnd(2500, 5000);
    } else if (now > M.until) {
      if (M.phase === 'base') {
        const n = L.morpher.count;
        let i = Math.floor(Math.random() * n);
        if (n > 1 && i === M.last) i = (i + 1) % n;
        M.idx = M.last = i;
        M.phase = 'pose';
        M.until = now + rnd(2600, 5200);
      } else {
        M.phase = 'base';
        M.until = now + rnd(2500, 6000);
      }
    }
    const target = M.phase === 'pose' ? 1 : 0;
    const step = dt / (busy ? 220 : 1300);
    M.t += Math.max(-step, Math.min(step, target - M.t));
    this.morphT = M.t * M.t * (3 - 2 * M.t); // weich anfahren und abbremsen
    this.morphIdx = M.idx;
  }

  /** Mund und Augen der Ebene für den aktuellen Moment einzeichnen. */
  buildFrame() {
    if (this.isVideo) return this.buildVideoFrame();
    if (this.morpher) {
      const t = this.morphT ?? 0;
      if (t > 0.003) {
        this.frameCtx.clearRect(0, 0, this.w, this.h);
        this.frameCtx.drawImage(this.morpher.render(this.morphIdx ?? 0, t), 0, 0);
        this.morphDrawn = true;
        return;
      }
      if (this.morphDrawn) {
        this.frameCtx.clearRect(0, 0, this.w, this.h);
        this.frameCtx.drawImage(this.base, 0, 0);
        this.lastOpenPx = -1;
        this.morphDrawn = false;
      }
    }
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
    if (!this.faceWarp) this.renderEyes(this.frameCtx, this.blink);
    let out = this.frame;
    // Körper-Rig: Schultern, Brust und Arme per Verformung
    if (this.bodyWarp && !this.calmNow) out = this.bodyWarp.render(out, bodyHandles(this.bodyRig, this.w, this.h, this.bodyState()));
    // Gesichts-Rig: Blinzeln, Blick, Brauen und Mundform per Verformung (statt aufgemalter Lider)
    if (this.faceWarp) out = this.faceWarp.render(out, faceHandles(this.faceRig, this.w, this.h, this.faceState()));
    if (out !== this.frame) {
      this.frameCtx.clearRect(0, 0, this.w, this.h);
      this.frameCtx.drawImage(out, 0, 0);
      this.blinkWasDrawn = true; // nächstes Bild wieder vom Grundbild aufbauen
      this.lastOpenPx = -1;
      return;
    }
    this.blinkWasDrawn = this.blink > 0.02 || !!this.mouthImg;
  }

  /** Körperhaltung für das Körper-Rig: Atmen, Haltung je nach Stimmung, Schulterzucken, Gesten beim Sprechen. */
  bodyState() {
    const now = performance.now();
    const t = now / 1000;
    const S = (this.body ??= { posture: 0, shrug: 0, shrugAt: 0, gesture: 0, side: 1, nextSide: 0, lvl: 0 });
    const mc = this.moodCur ?? MOODS.ruhig;
    const m = Math.min(1.5, this.motion ?? 1);
    // Haltung: freudig aufrecht, traurig eingesunken; beim Zuhören aufmerksam
    const postureT = Math.max(-1, Math.min(1, (mc.energy - 1) * 1.5 + (this.listening ? 0.25 : 0)));
    S.posture += (postureT - S.posture) * 0.03;
    // Schulterzucken: beim Nachdenken leicht gehalten, bei „nachdenklich“ ab und zu kurz
    if (this.speaking && mc.brow > 0.25 && mc.energy < 0.9 && now - S.shrugAt > 4500 && Math.random() < 0.01) S.shrugAt = now;
    const pulse = (now - S.shrugAt) / 900;
    const shrugT = (this.thinking ? 0.18 : 0) + (pulse >= 0 && pulse < 1 ? Math.sin(pulse * Math.PI) * 0.7 : 0);
    S.shrug += (shrugT - S.shrug) * 0.12;
    // Gesten: Hände folgen der Sprechlautstärke (geglättet), mal mehr die eine, mal die andere Hand
    S.lvl += ((this.speaking ? this.level : 0) - S.lvl) * 0.06;
    S.gesture += (Math.min(1, S.lvl * 1.6 * mc.energy) - S.gesture) * 0.08;
    if (now > S.nextSide) {
      S.side = Math.random() < 0.5 ? -1 : 1;
      S.nextSide = now + 2500 + Math.random() * 4000;
    }
    const breatheRate = this.speaking ? 2.1 : 1.7; // gleicher Takt wie das Atmen des ganzen Bildes
    return {
      breathe: Math.sin(t * breatheRate) * m,
      shrug: S.shrug * m,
      posture: S.posture * m,
      swing: (Math.sin(t * 0.9) * 0.6 + Math.sin(t * 0.37) * 0.4) * m,
      gesture: S.gesture * m,
      side: S.side,
      shoulders: this.bodyShoulders !== false,
    };
  }

  /** Mimik für das Gesichts-Rig: Blicksprünge, Brauen je nach Zustand, leichtes Lächeln, Mundform. */
  faceState() {
    const now = performance.now();
    const F = (this.face ??= { gx: 0, gy: 0, tx: 0, ty: 0, next: 0, brow: 0, smile: 0.2, shape: 0, lastLevel: 0, browKick: 0 });
    if (now > F.next) {
      // Blicksprünge (Sakkaden): meist kurz zur Seite und zurück zur Mitte
      // beim Zuhören meist Blickkontakt
      const center = Math.random() < (this.listening ? 0.85 : this.speaking ? 0.55 : 0.4);
      F.tx = center ? 0 : (Math.random() * 2 - 1) * (this.thinking ? 0.9 : 0.7);
      F.ty = center ? 0 : this.thinking ? -0.6 : (Math.random() * 2 - 1) * 0.3;
      F.next = now + (this.speaking ? 700 + Math.random() * 1600 : 1200 + Math.random() * 2800);
    }
    // Sakkaden sind schnell
    F.gx += (F.tx - F.gx) * 0.35;
    F.gy += (F.ty - F.gy) * 0.35;
    // Mikrobewegungen: echte Augen stehen nie ganz still – kleine Sprünge zwischen den großen
    if (now > (F.microNext ?? 0)) {
      F.mx = (Math.random() * 2 - 1) * 0.07;
      F.my = (Math.random() * 2 - 1) * 0.04;
      F.microNext = now + 250 + Math.random() * 600;
    }
    // Brauen: Nachdenken/Zuhören hebt, beim Sprechen kurz bei Betonungen
    const lvl = this.level;
    if (this.speaking && lvl > 0.55 && F.lastLevel < 0.35 && Math.random() < 0.35) F.browKick = 0.6;
    F.lastLevel = lvl;
    F.browKick *= 0.93;
    const mc = this.moodCur ?? MOODS.ruhig;
    const browAt = this.listen?.browAt;
    if (browAt && F.browSeen !== browAt) {
      F.browSeen = browAt;
      F.browKick = Math.max(F.browKick, 0.5);
    }
    const browTarget = (this.thinking ? 0.55 : this.listening ? 0.35 : 0) + mc.brow;
    F.brow += (browTarget - F.brow) * 0.06;
    const smileBase = this.speaking ? 0.3 : this.thinking ? 0.05 : this.listening ? 0.25 : 0.2;
    F.smile += (Math.max(-0.5, Math.min(1, smileBase + mc.smile)) - F.smile) * 0.05;
    F.shape += ((this.speaking ? this.state.shape ?? 0 : 0) * Math.min(1, this.open * 2) - F.shape) * 0.35;
    // Augen und Mimik bleiben auch beim ruhigen Foto voll lebendig – sie tragen dort den ganzen Ausdruck
    const m = this.calmNow ? Math.max(1, Math.min(1.5, this.motion ?? 1)) : Math.min(1.5, this.motion ?? 1);
    const brow = Math.max(-1, Math.min(1, (F.brow + F.browKick) * m));
    return { blink: this.blink, gazeX: (F.gx + (F.mx ?? 0)) * m, gazeY: (F.gy + (F.my ?? 0)) * m, brow, smile: F.smile * m, shape: F.shape };
  }

  // ---------- Posen: passend zum Zustand wechseln, weich überblenden ----------
  /** Für den Editor: eine bestimmte Ebene festhalten (null = automatisch). */
  previewPose(index) {
    this.forcePose = index;
  }

  /** Für den Editor: einen Anlass ein paar Sekunden lang durchspielen (zeigt, welche Posen dann drankommen). */
  simulateTrigger(trigger, ms = 6000) {
    const now = performance.now();
    this.forcePose = null;
    this.simulate = trigger ? { t: trigger, until: now + ms } : null;
    this.poseUntil = 0;
  }

  switchPose(i, now) {
    if (i === this.current) return;
    this.prev = this.current;
    this.current = i;
    this.fadeStart = now;
    const L = this.layers?.[i];
    if (L?.isVideo) this.restartVideo(L);
  }

  /** Video (bzw. seinen Abschnitt) von vorn abspielen. */
  restartVideo(L) {
    L.clipDone = false;
    L.video.currentTime = L.clip?.start ?? 0;
    L.video.play().catch(() => {});
  }

  /** Ist das Video (bzw. der Abschnitt) zu Ende? Abschnitte in Schleife springen zurück an den Anfang. */
  videoEnded(L) {
    if (L.clip && !L.clipDone && L.video.currentTime >= L.clip.end - 0.03) {
      if (L.config.loop) L.video.currentTime = L.clip.start;
      else {
        L.video.pause();
        L.clipDone = true;
      }
    }
    return L.video.ended || !!L.clipDone;
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
      if (curL?.isVideo && this.videoEnded(curL)) this.restartVideo(curL);
      return;
    }
    // Ruhe-Videos (Anlass „rest“) ersetzen in Ruhe das Grundbild: laufen dauernd, mehrere im Wechsel.
    // Beim Sprechen bleibt das Grundbild (dort sitzt die Lippenbewegung).
    const rest = [];
    for (let i = 1; i < n; i++) if (this.layers[i].config.trigger === 'rest') rest.push(i);
    const isRest = (i) => rest.includes(i);
    const nextRest = () => (rest.length ? rest[(this.restK = ((this.restK ?? -1) + 1) % rest.length)] : 0);
    const home = () => (this.speaking || !rest.length ? 0 : isRest(this.current) ? this.current : nextRest());
    const isHome = (i) => i === 0 || isRest(i);
    // Einmal abgespielte Videos kehren danach zum Grundbild (bzw. Ruhe-Video) zurück
    if (curL?.isVideo && this.videoEnded(curL) && !curL.config.loop) {
      if (!this.speaking && rest.length) {
        const h = nextRest();
        if (h === this.current) this.restartVideo(curL);
        else this.switchPose(h, now);
      } else this.switchPose(0, now);
      // beim Nachdenken/Zuhören gleich das nächste Video, sonst etwas Pause mit dem Grundbild
      const lasting = this.thinking || this.listening;
      this.poseUntil = now + (lasting ? 400 + Math.random() * 1100 : 2500 + Math.random() * 4000);
      return;
    }
    if (n < 2) return this.switchPose(0, now);
    const base = this.speaking ? 'speak' : this.thinking ? 'think' : this.listening ? 'listen' : 'idle';
    // Zeitpunkte für „lange warten“ und „gelangweilt“
    if (this.thinking && !this.wasThinking) this.thinkStart = now;
    this.wasThinking = this.thinking;
    this.lastBusy ??= now;
    if (base !== 'idle') this.lastBusy = now;
    const ev = this.state.event && now < this.state.event.until ? this.state.event : null;
    const sim = this.simulate && now < this.simulate.until ? this.simulate : null;
    if (!sim && this.simulate) {
      this.simulate = null;
      this.poseUntil = 0;
    }
    // Beginn einer Antwort merken (für Posen „am Anfang einer Antwort“)
    if (this.speaking && !this.wasSpeaking) this.speakStart = now;
    this.wasSpeaking = this.speaking;
    // Genauere Anlässe haben Vorrang, wenn es dafür Posen gibt
    const prefs = [];
    if (base === 'speak') {
      if (now - (this.speakStart ?? 0) < 2500 && !this.startPlayed) prefs.push('start');
      const mood = this.moodCur?.name;
      if (mood && mood !== 'ruhig') prefs.push(`speak:${mood}`);
    } else if (base === 'listen') {
      // Nutzer spricht gerade (oder eben noch): aufmerksam zuhören
      const L = this.listen;
      if (L?.talking || now - (L?.quietSince || 0) < 1500) prefs.push('listen:talk');
      const mood = this.moodCur?.name;
      if (mood && mood !== 'ruhig') prefs.push(`listen:${mood}`);
    } else if (base === 'think') {
      // Warten: Kalender, Internet/Datei oder einfach länger als 3 s
      if (this.state.wait === 'calendar') prefs.push('think:calendar');
      if (this.state.wait || now - (this.thinkStart ?? now) > 3000) prefs.push('think:long');
    } else {
      // Ruhe: gelangweilt (5 min), Tageszeit (morgens/abends), zur Seite schauen (1 min) – was es an Posen gibt
      const quiet = now - this.lastBusy;
      if (quiet > 5 * 60e3) prefs.push('idle:bored');
      const h = new Date().getHours();
      if (h >= 6 && h < 10) prefs.push('idle:morning');
      if (h >= 20) prefs.push('idle:evening');
      if (quiet > 60e3) prefs.push('idle:away');
    }
    if (base !== 'speak') this.startPlayed = false;
    prefs.push(base);
    // kurze Anlässe gehen allem anderen vor; die Editor-Probe ersetzt alles
    if (ev) prefs.unshift(`event:${ev.name}`);
    if (sim) prefs.splice(0, prefs.length, sim.t);
    const byTrigger = (t) => {
      const out = [];
      for (let i = 1; i < n; i++) if ((this.layers[i].config.trigger ?? 'speak') === t) out.push(i);
      return out;
    };
    let st = base;
    let cand = [];
    for (const t of prefs) {
      cand = byTrigger(t);
      if (cand.length) {
        st = t;
        break;
      }
    }
    if (st === 'start') this.startPlayed = true;
    const oneShot = !!sim || st.startsWith('event:');
    // neuer Anlass mit passender Pose: sofort zeigen
    if (ev && st === `event:${ev.name}` && this.evSeen !== ev.at) {
      this.evSeen = ev.at;
      this.poseUntil = 0;
    }
    // Wechsel des Grundzustands (sprechen, nachdenken, zuhören, Ruhe) sofort zeigen; feinere Wechsel
    // (Stimmung, aufmerksam zuhören) erst, wenn die aktuelle Pose ihre Zeit gehabt hat
    if (base !== this.poseBase) {
      this.poseBase = base;
      this.poseUntil = 0;
    } else if (st !== this.poseState && !(curL?.isVideo && !curL.config.loop && !this.videoEnded(curL))) {
      this.poseUntil = Math.min(this.poseUntil, now + 600);
    }
    this.poseState = st;
    if (now < this.poseUntil) return;
    const rnd = (a, b) => a + Math.random() * (b - a);
    // Abwechseln statt Zufall: mehrere Posen desselben Anlasses kommen der Reihe nach dran, nie zweimal hintereinander
    this.rot ??= {};
    const nextOf = (list) => {
      if (!list.length) return 0;
      const k = (this.rot[st] = ((this.rot[st] ?? -1) + 1) % list.length);
      const pick = list[k];
      return pick === this.current && list.length > 1 ? list[(k + 1) % list.length] : pick;
    };
    let next = 0;
    let hold;
    if (oneShot) {
      next = nextOf(cand);
      hold = sim ? Math.max(1500, sim.until - now) : Math.max(1500, ev.until - now);
    } else if (base === 'idle') {
      // meist das Grundbild (oder Ruhe-Video), ab und zu eine Ruhe-Pose (gelangweilt: öfter)
      if (isHome(this.current) && cand.length && Math.random() < (st === 'idle:bored' || st === 'idle:away' ? 0.8 : 0.45)) {
        next = nextOf(cand);
        hold = rnd(2500, 5500);
      } else {
        next = home();
        hold = rnd(5000, 12000);
      }
    } else if (base === 'speak') {
      // beim Sprechen: Grundbild (mit Lippenbewegung) und Sprech-Posen im Wechsel
      next = cand.length && (this.current === 0 || st === 'start') ? nextOf(cand) : 0;
      hold = next === 0 ? rnd(1800, 3500) : rnd(2200, 4500);
    } else {
      next = cand.length ? nextOf(cand) : home();
      // mehrere Posen: nach einer Weile zur nächsten wechseln; eine einzige bleibt, solange der Zustand anhält
      hold = cand.length > 1 ? rnd(5000, 9000) : 1e9;
    }
    const nextL = this.layers[next];
    if (nextL?.isVideo && !nextL.config.loop) hold = 1e9; // endet über "ended"
    // Anlass mitteilen (für „Anlässe anzeigen“), nur bei einem Wechsel
    if (next !== this.current && next !== 0) this.onPose?.(nextL?.config ?? null, st);
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

  // ---------- Stimmung: weich zwischen den Gesichtsausdrücken überblenden ----------
  updateMood(now, dt) {
    const st = this.state;
    // Die Stimmung hält, solange gesprochen wird, und klingt danach langsam ab
    // ohne aktuelle Stimmung aus der Antwort: die Tagesstimmung der Figur (halb so stark) – sie wirkt auf Gesicht und Posen
    const live = st.mood && (st.speaking || st.thinking || now - st.moodAt < 7000);
    const base = !live && st.baseMood && MOODS[st.baseMood] ? st.baseMood : null;
    const name = live ? st.mood : base ?? 'ruhig';
    const full = MOODS[name] ?? MOODS.ruhig;
    const target = base ? Object.fromEntries(Object.keys(MOODS.ruhig).map((k) => [k, (MOODS.ruhig[k] + full[k]) / 2])) : full;
    const M = (this.moodCur ??= { ...MOODS.ruhig, side: 1, name: 'ruhig' });
    if (M.name !== name) {
      M.name = name;
      M.side = Math.random() < 0.5 ? -1 : 1;
    }
    const k = Math.min(1, dt / 450);
    // Tageszeit: nur die Lebhaftigkeit (Kopfbewegung, Gesten), einmal pro Minute neu bestimmt
    if (!this.todAt || now - this.todAt > 60e3) {
      this.todAt = now;
      this.tod = st.timeOfDay === false ? 1 : timeOfDayEnergy();
    }
    for (const key of Object.keys(MOODS.ruhig)) M[key] += ((key === 'energy' ? target[key] * this.tod : target[key]) - M[key]) * k;
    return M;
  }

  /** Zuhören: nicken, wenn der Nutzer eine kurze Pause macht; Brauen gehen beim Sprechbeginn kurz hoch. */
  updateListening(now) {
    const Lr = (this.listen ??= { talking: false, since: 0, quietSince: 0, lastNod: 0, nodAt: 0, browAt: 0 });
    if (!this.listening) {
      Lr.talking = false;
      return Lr;
    }
    const loud = (this.state.voice ?? 0) >= 1;
    if (loud) {
      if (!Lr.talking) {
        Lr.talking = true;
        Lr.since = now;
        if (now - Lr.browAt > 2500 && Math.random() < 0.6) Lr.browAt = now;
      }
      Lr.quietSince = 0;
    } else if (Lr.talking) {
      Lr.quietSince ||= now;
      const quiet = now - Lr.quietSince;
      // Nach einem Satzteil (mind. 0,9 s gesprochen) kurz zustimmend nicken
      if (quiet > 260 && now - Lr.since > 900 && now - Lr.lastNod > 1600) {
        if (Math.random() < 0.75) Lr.nodAt = now;
        Lr.lastNod = now;
        Lr.talking = false;
      } else if (quiet > 1200) Lr.talking = false;
    }
    return Lr;
  }

  /** Kurzer Nick-Impuls (0..1) nach dem Zuhören-Nicken – auch für die 3D-Figur. */
  get ackPulse() {
    const t = (performance.now() - (this.listen?.nodAt ?? -1e9)) / 520;
    return t >= 0 && t < 1 ? Math.sin(t * Math.PI) : 0;
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
    const energy = this.moodCur?.energy ?? 1;

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
        B.next = now + rnd(2500, 4500);
      }
      // aufmerksam: ab und zu die Kopfneigung wechseln, Blick bleibt beim Nutzer
      if (now > B.next) {
        B.target = { tilt: rnd(0.015, 0.04) * side(), look: rnd(-0.03, 0.03) * f, nod: f * rnd(0.01, 0.04) };
        B.next = now + rnd(2500, 5000);
      }
    } else if (this.speaking) {
      B.mode = 'speak';
      if (now > B.next) {
        B.target = { tilt: rnd(-0.035, 0.035) * energy, look: rnd(-0.12, 0.12) * f * energy, nod: 0 };
        B.next = now + rnd(900, 2200) / Math.max(0.6, energy);
      }
      // Betonung: bei Silbenspitzen kurz nicken
      const lvl = this.level;
      if (lvl > 0.45 && B.lastLevel < 0.3 && now - B.lastKick > 380) {
        B.kick = f * rnd(0.04, 0.08) * Math.min(1.3, energy);
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
        const g = this.idleHead ?? 0.25; // 0 = Kopf bleibt im Leerlauf ruhig in der Mitte
        if (r < 0.3 || g <= 0) B.target = { tilt: 0, look: 0, nod: 0 };
        else if (r < 0.6) B.target = { tilt: rnd(0.02, 0.05) * side() * g, look: 0, nod: f * rnd(0, 0.04) * g };
        else if (r < 0.85) B.target = { tilt: rnd(-0.015, 0.015) * g, look: f * rnd(0.1, 0.22) * side() * g, nod: 0 };
        else B.target = { tilt: 0, look: 0, nod: -f * 0.05 * g };
        B.next = now + rnd(2500, 6000);
      }
    }
    // weiche Federn hin zum Ziel
    // im Leerlauf langsamer und weicher, damit nichts „zuckt“
    const k = Math.min(1, dt * (B.mode === 'idle' ? 0.0015 : 0.004));
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
    // ruhiges Foto: Kopf nur ganz leicht bewegen (stärkeres Verschieben verzerrt Hals und Hintergrund)
    const m = this.motion * (this.calmNow ? 0.2 : 1);
    const B = this.behaviour;
    if (!h || !B || m <= 0) return this.frame;
    const ctx = this.posedCtx;
    const W = this.w;
    const yEnd = Math.min(this.h, Math.ceil(h.neckY + h.band));
    ctx.clearRect(0, 0, W, this.h);
    ctx.drawImage(this.frame, 0, yEnd, W, this.h - yEnd, 0, yEnd, W, this.h - yEnd);
    const mc = this.moodCur;
    const tilt = (B.tilt + (mc ? mc.tilt * mc.side : 0)) * m;
    const look = B.look * m;
    const nod = (B.nod + B.kick + ((mc?.nod ?? 0) + this.ackPulse * 0.07) * h.faceH) * m;
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
    // eigener Hintergrund (z. B. im Bild-im-Bild-Fenster): { kind: 'dunkel' | 'hell' | 'farbe' | 'unscharf', color }
    const bs = this.bgStyle;
    if (bs?.kind === 'hell' || bs?.kind === 'farbe') {
      g.fillStyle = bs.kind === 'hell' ? '#f2f3f5' : bs.color || '#1e2430';
      g.fillRect(0, 0, c.width, c.height);
      this.bg = c;
      return;
    }
    // dezenter Verlauf, falls das Bild selbst transparent ist
    const grad = g.createLinearGradient(0, 0, 0, c.height);
    grad.addColorStop(0, '#26303f');
    grad.addColorStop(1, '#12161d');
    g.fillStyle = grad;
    g.fillRect(0, 0, c.width, c.height);
    if (!this.hasAlpha || bs?.kind === 'unscharf') {
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
    // Laute bestimmen die Form: bei m/b/p schließen sich die Lippen, bei a weit offen
    const vis = this.state.viseme;
    const shapeOpen = vis == null ? 1 : vis < 0.05 ? 0.04 : 0.35 + 0.75 * vis;
    const target = this.speaking ? Math.min(1, this.level * shapeOpen) : 0;
    this.open += (target - this.open) * (target > this.open ? 0.55 : vis != null && vis < 0.05 ? 0.6 : 0.3);

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
    this.updateMood(now, dt);
    this.updateListening(now);
    this.updateBehaviour(now, dt);
    this.updatePose(now);
    this.updateMorph(now, dt);
    const fade = this.prev == null ? 1 : Math.min(1, (now - this.fadeStart) / 380);
    if (fade >= 1) this.prev = null;
    this.pauseHiddenVideos();
    const visible = [];
    if (this.prev != null && this.layers[this.prev]) visible.push([this.layers[this.prev], 1]);
    const cur = this.layers[this.current] ?? this.layers[0];
    visible.push([cur, this.prev != null ? fade : 1]);
    // gerade ein Foto (kein Video, keine 3D-Figur) zu sehen? Dann ruhig: die Ebenen erben calmNow
    this.calmNow = !!this.calmPhoto && !cur.isVideo && !cur.isVrm;
    const drawn = visible.map(([L, a]) => {
      L.buildFrame();
      return [L, L.renderPose(), a];
    });
    // Bild-Figur leicht drehen (Grundbild inkl. Mund, Augen und Bewegungsbildern)
    if (this.parallax) {
      const yaw = (this.turnYaw ?? 0) + this.updateAutoTurn(now, dt);
      if (Math.abs(yaw) > 0.15) {
        for (const d of drawn) if (d[0] === this.layers[0]) d[1] = this.parallax.render(d[1], (yaw * Math.PI) / 180);
      }
    }

    // Körperbewegung: atmen, wiegen, beim Sprechen nicken (3D-Figuren bewegen sich selbst)
    const vrm = this.layers[0]?.isVrm;
    // ruhiges Foto: kaum Wiegen und Nicken des ganzen Bildes, Atmen nur angedeutet
    const m = vrm ? 0 : this.motion * (this.calmNow ? 0.12 : 1);
    const mb = vrm ? 0 : this.motion * (this.calmNow ? 0.45 : 1);
    const breathe = Math.sin(t * 1.7) * (this.layers[0]?.bodyWarp ? 0.002 : 0.006) * mb;
    const sway = (Math.sin(t * 0.55) * 0.006 + Math.sin(t * 0.23) * 0.004) * m;
    const energy = this.moodCur?.energy ?? 1;
    const talk = this.speaking ? (Math.sin(t * 6.3) * 0.006 + Math.sin(t * 3.1) * 0.004) * this.open * m * energy : 0;
    const think = this.thinking ? Math.sin(t * 1.2) * 0.008 * m : 0;
    const lean = this.listening ? 0.012 * m : 0;
    this.lean = (this.lean ?? 0) + (lean - (this.lean ?? 0)) * 0.05;

    // freischwebend etwas Rand lassen, damit beim Wiegen nichts abgeschnitten wird
    const fit = Math.min(W / this.w, H / this.h) * (this.transparent && !this.pipFit ? 0.94 : 1);
    // Bild-im-Bild: Fenster hat die Form der Figur – Figur füllt es ganz aus
    // (mit Kamerafahrten: ab und zu langsam auf Oberkörper oder Gesicht und zurück)
    const L = this.pipFit ? this.cameraLayout(now, dt, W, H, fit) : this.fitMode ? this.fitLayout(this.fitMode, W, H) : this.layout;
    this.lastLayout = L; // zuletzt gezeigte Lage (z. B. um von der Kamera nahtlos auf Handbetrieb zu wechseln)
    this.fitPx = this.h * fit; // Figurhöhe in Gerätepixeln bei Maßstab 1
    const dw = this.w * fit * L.scale;
    const dh = this.h * fit * L.scale;
    const bx = W / 2 + L.x * W;
    const by = (H + this.h * fit) / 2 + L.y * H;
    // Position der Figur (ohne Wiegen) für Auswahlrahmen und Trefferprüfung, in CSS-Pixeln
    const dpr = this.dpr;
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

  /**
   * Einpassung in die Bühne berechnen.
   * mode: 'ganz' = ganze Figur so groß wie möglich, 'fuellen' = Bühne ganz ausfüllen (Ränder werden abgeschnitten)
   * align: 'unten' | 'mitte' | 'oben'
   */
  fitLayout({ mode = 'ganz', align = 'mitte' } = {}, W = this.canvas.width, H = this.canvas.height) {
    const base = Math.min(W / this.w, H / this.h) * (this.transparent && !this.pipFit ? 0.94 : 1);
    const f = mode === 'fuellen' ? Math.max(W / this.w, H / this.h) : Math.min(W / this.w, H / this.h);
    const dh = this.h * f;
    const by = align === 'unten' ? H : align === 'oben' ? dh : (H + dh) / 2;
    return { x: 0, y: (by - (H + this.h * base) / 2) / H, scale: f / base };
  }

  /** Sichtbare Figur im Grundbild (0..1): leere, durchsichtige Ränder zählen nicht mit. */
  visibleBox() {
    const L0 = this.layers?.[0];
    if (!L0) return { x0: 0, y0: 0, x1: 1, y1: 1 };
    if (L0.visBox && L0.visBoxFor === L0.base) return L0.visBox;
    let box = { x0: 0, y0: 0, x1: 1, y1: 1 };
    if (L0.hasAlpha && !L0.isVrm && !L0.isVideo && L0.base) {
      const s = Math.min(1, 160 / Math.max(L0.w, L0.h));
      const w = Math.max(2, Math.round(L0.w * s));
      const h = Math.max(2, Math.round(L0.h * s));
      const c = this.doc.createElement('canvas');
      c.width = w;
      c.height = h;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(L0.base, 0, 0, w, h);
      const d = g.getImageData(0, 0, w, h).data;
      let x0 = w;
      let y0 = h;
      let x1 = -1;
      let y1 = -1;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (d[(y * w + x) * 4 + 3] > 24) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }
      }
      // etwas Luft lassen (Wiegen, Haare)
      if (x1 >= 0) {
        const px = 0.03;
        box = {
          x0: Math.max(0, x0 / w - px),
          y0: Math.max(0, y0 / h - px),
          x1: Math.min(1, (x1 + 1) / w + px),
          y1: Math.min(1, (y1 + 1) / h + px),
        };
      }
    }
    L0.visBox = box;
    L0.visBoxFor = L0.base;
    return box;
  }

  /** Seitenverhältnis der sichtbaren Figur (für die Form des Bild-im-Bild-Fensters). */
  visibleAspect() {
    const b = this.visibleBox();
    return ((b.x1 - b.x0) * this.w) / ((b.y1 - b.y0) * this.h);
  }

  /**
   * Bild-im-Bild: virtuelle Kamera. Meist die ganze (sichtbare) Figur, zwischendurch langsam auf Oberkörper oder
   * – beim Sprechen – das Gesicht, dann wieder zurück. Liefert ein Layout wie fitLayout.
   */
  cameraLayout(now, dt, W, H, fit) {
    const box = this.visibleBox();
    const C = (this.cam ??= { shot: 'ganz', until: now + 6000, x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1, talking: false });
    // Kamera folgt dem Gespräch: Kommt die Antwort, fährt sie langsam auf den Oberkörper (bis etwa zur Hüfte –
    // nie näher), bei längeren Antworten zwischendurch kurz zurück zur ganzen Figur; danach wieder ganz.
    if (this.camera !== false) {
      if (this.speaking && !C.talking) {
        C.talking = true;
        C.shot = 'oberkoerper';
        C.until = now + 8000 + Math.random() * 4000;
      } else if (!this.speaking && C.talking) {
        C.talking = false;
        C.shot = 'ganz';
        C.until = now + 1e9; // in Ruhe bleibt die ganze Figur
      } else if (this.speaking && now > C.until) {
        C.shot = C.shot === 'ganz' ? 'oberkoerper' : 'ganz';
        C.until = now + (C.shot === 'ganz' ? 3500 + Math.random() * 2000 : 8000 + Math.random() * 4000);
      }
    } else C.shot = 'ganz';
    // Zielausschnitt (normiert auf das Grundbild)
    const cfg = this.layers?.[0]?.config ?? this.config ?? {};
    const eyes = cfg.eyes ?? [];
    const eyeY = eyes.length ? eyes.reduce((a, e) => a + e.y, 0) / eyes.length : null;
    const faceX = eyes.length ? eyes.reduce((a, e) => a + e.x, 0) / eyes.length : (box.x0 + box.x1) / 2;
    const mouthY = cfg.mouth?.y ?? (eyeY != null ? eyeY + 0.06 : null);
    const bh = box.y1 - box.y0;
    let t = { ...box };
    if (C.shot !== 'ganz' && eyeY != null) {
      const face = Math.max(0.04, (mouthY - eyeY) * 2.6); // Gesichtshöhe (normiert)
      // Oberkörper: mindestens zwei Drittel der Figur (höchstens 1,5-fach vergrößert), vom Scheitel abwärts – nie enger
      const h = Math.min(bh, Math.max(face * 4.6, bh * (2 / 3)));
      const y0 = Math.max(box.y0, Math.min(eyeY - face * 0.9, box.y1 - h));
      // Breite passend zum Fenster, um die Gesichtsmitte
      const w = Math.min(1, (h * this.h * (W / H)) / this.w);
      const x0 = Math.min(Math.max(0, faceX - w / 2), 1 - w);
      t = { x0, y0, x1: x0 + w, y1: Math.min(1, y0 + h) };
    }
    // weich hinfahren (langsamer Schwenk, ca. 1,5 s)
    const k = Math.min(1, (dt || 16) / 900);
    for (const key of ['x0', 'y0', 'x1', 'y1']) C[key] += (t[key] - C[key]) * k;
    // Ausschnitt ins Fenster einpassen (ganz sichtbar, zentriert)
    const rw = (C.x1 - C.x0) * this.w;
    const rh = (C.y1 - C.y0) * this.h;
    // camMargin < 1: etwas Rand lassen (Nur-Figur-Ansicht), im echten Bild-im-Bild füllt die Figur das Fenster
    const f = Math.min(W / rw, H / rh) * (this.camMargin ?? 1);
    const cx = this.flip ? 1 - (C.x0 + C.x1) / 2 : (C.x0 + C.x1) / 2;
    const cy = (C.y0 + C.y1) / 2;
    const bx = W / 2 + (0.5 - cx) * this.w * f;
    const by = H / 2 + (1 - cy) * this.h * f;
    return { x: (bx - W / 2) / W, y: (by - (H + this.h * fit) / 2) / H, scale: f / fit };
  }

  /** Feste Einpassung lösen (vor dem Verschieben/Skalieren von Hand). */
  freeLayout() {
    if (!this.fitMode) return;
    this.layout = this.fitLayout(this.fitMode);
    this.fitMode = null;
  }

  /** Figur so platzieren, dass sie das angegebene Rechteck (CSS-Pixel) ausfüllt. */
  setRect(r) {
    const dpr = this.dpr;
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
    const dpr = this.dpr;
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
