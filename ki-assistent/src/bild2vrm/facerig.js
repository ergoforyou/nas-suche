// Gesichts-Rig aus MediaPipe-Gesichtspunkten (478 Punkte): feines Netz über dem Gesicht, das sich für die
// Ausdrücke verformt – das eigene Oberlid gleitet beim Blinzeln über das Auge, die Lippen öffnen sich entlang
// eines Schnitts und geben einen Mundinnenraum frei. Nichts wird aufgemalt; Farben kommen aus dem Foto.
import { BONES, ARM_BONES, BONE_INDEX, applyLbs, skinWeights } from './rig.js';
import { createImage } from './image.js';

// Indizes im MediaPipe-Gesichtsnetz. "L" = linkes Auge der Person (im Bild rechts).
const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176,
  149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
const EYES = {
  right: { upper: [33, 246, 161, 160, 159, 158, 157, 173, 133], lower: [33, 7, 163, 144, 145, 153, 154, 155, 133] },
  left: { upper: [263, 466, 388, 387, 386, 385, 384, 398, 362], lower: [263, 249, 390, 373, 374, 380, 381, 382, 362] },
};
const MOUTH = { right: 61, left: 291, upperInner: 13, lowerInner: 14, chin: 152 };
// Brauen (Ober- und Unterkante, jeweils von außen nach innen) und Iris (Mitte + 4 Randpunkte)
const BROWS = {
  right: { upper: [70, 63, 105, 66, 107], lower: [46, 53, 52, 65, 55] },
  left: { upper: [300, 293, 334, 296, 336], lower: [276, 283, 282, 295, 285] },
};
const IRIS = { right: [468, 469, 470, 471, 472], left: [473, 474, 475, 476, 477] };
const NOSE_BRIDGE = 168;

// Ausdrücke (VRM-1.0-Namen) -> Parameter
const SHAPES = {
  blinkLeft: { blink: { left: 1 } },
  blinkRight: { blink: { right: 1 } },
  aa: { mouth: { open: 1.0, width: 0.05 } },
  ih: { mouth: { open: 0.22, width: 0.45 } },
  ou: { mouth: { open: 0.3, width: -0.35, round: 1 } },
  ee: { mouth: { open: 0.45, width: 0.3 } },
  oh: { mouth: { open: 0.75, width: -0.2, round: 0.6 } },
  happy: { mouth: { smile: 1, open: 0.15 }, squint: 1 },
  relaxed: { mouth: { smile: 0.5 }, squint: 0.4 },
  // Stimmungen über Brauen, Lider und Mundwinkel (Brauen in Anteilen der Gesichtshöhe, + = nach unten)
  surprised: { brows: { inner: -0.035, outer: -0.03 }, lids: -0.22, mouth: { open: 0.4, round: 0.4 } },
  sad: { brows: { inner: -0.025, outer: 0.006 }, lids: 0.15, mouth: { smile: -0.8 } },
  angry: { brows: { inner: 0.03, outer: -0.004, inward: 0.012 }, lids: 0.2, mouth: { smile: -0.35, width: -0.1 } },
  // Blick (VRM lookAt): die Iris wandert im Auge; "links" = linke Seite der Figur = im Bild rechts
  lookLeft: { gaze: { x: 1, y: 0 } },
  lookRight: { gaze: { x: -1, y: 0 } },
  lookUp: { gaze: { x: 0, y: -0.6 }, lids: -0.08 },
  lookDown: { gaze: { x: 0, y: 0.45 }, lids: 0.12 },
};
export const FACE_EXPRESSIONS = {
  blink: [['blinkLeft', 1], ['blinkRight', 1]],
  blinkLeft: [['blinkLeft', 1]],
  blinkRight: [['blinkRight', 1]],
  aa: [['aa', 1]], ih: [['ih', 1]], ou: [['ou', 1]], ee: [['ee', 1]], oh: [['oh', 1]],
  happy: [['happy', 1]],
  relaxed: [['relaxed', 1]],
  surprised: [['surprised', 1]],
  sad: [['sad', 1]],
  angry: [['angry', 1]],
  lookLeft: [['lookLeft', 1]], lookRight: [['lookRight', 1]], lookUp: [['lookUp', 1]], lookDown: [['lookDown', 1]],
};

/** Lineare Interpolation entlang einer nach x sortierten Punktliste. */
function curveY(pts, x) {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][0]) {
      const t = (x - pts[i - 1][0]) / Math.max(1e-6, pts[i][0] - pts[i - 1][0]);
      return pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t;
    }
  }
  return pts[pts.length - 1][1];
}

function eyeGeometry(lm, side) {
  const up = EYES[side].upper.map((i) => lm[i]).sort((a, b) => a[0] - b[0]);
  const lo = EYES[side].lower.map((i) => lm[i]).sort((a, b) => a[0] - b[0]);
  const xmin = Math.min(up[0][0], lo[0][0]), xmax = Math.max(up[up.length - 1][0], lo[lo.length - 1][0]);
  let hmax = 0;
  for (let k = 0; k <= 10; k++) {
    const x = xmin + ((xmax - xmin) * k) / 10;
    hmax = Math.max(hmax, curveY(lo, x) - curveY(up, x));
  }
  return { up, lo, xmin, xmax, w: xmax - xmin, hmax: Math.max(hmax, 1) };
}

/** Verschiebung (Pixel) eines Punkts für ein Auge: closeTop = Anteil, um den das Oberlid sinkt, raiseBottom = Unterlid hebt sich. */
function eyeDisplacement(e, x, y, closeTop, raiseBottom) {
  const margin = 0.3 * e.w;
  if (x < e.xmin - margin || x > e.xmax + margin) return 0;
  const wx = x < e.xmin ? 1 - (e.xmin - x) / margin : x > e.xmax ? 1 - (x - e.xmax) / margin : 1;
  const xc = Math.min(e.xmax, Math.max(e.xmin, x));
  const yu = curveY(e.up, xc), yl = curveY(e.lo, xc), h = Math.max(0, yl - yu);
  const top = closeTop * h, bottom = raiseBottom * h; // neue Lidlinien: yu + top, yl - bottom
  let s;
  if (y < yu) s = top * Math.exp(-(((yu - y) / (0.9 * e.hmax)) ** 2));
  else if (y <= yl) {
    const t = h > 1e-6 ? (y - yu) / h : 0; // 0 am Oberlid, 1 am Unterlid
    s = top * (1 - t) - bottom * t;
  } else s = -bottom * Math.exp(-(((y - yl) / (1.3 * e.hmax)) ** 2));
  return s * Math.max(0, wx);
}

/** Blick: Iris innerhalb der Lidöffnung verschieben (Lider und Augenwinkel bleiben stehen). */
function gazeDisplacement(e, ir, x, y, g) {
  if (x <= e.xmin || x >= e.xmax) return [0, 0];
  const yu = curveY(e.up, x), yl = curveY(e.lo, x), h = yl - yu;
  if (h <= 0 || y <= yu || y >= yl) return [0, 0];
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const lid = clamp01((y - yu) / (0.3 * h)) * clamp01((yl - y) / (0.3 * h));
  const corner = clamp01((x - e.xmin) / (0.2 * e.w)) * clamp01((e.xmax - x) / (0.2 * e.w));
  const wgt = Math.exp(-((x - ir.x) ** 2 + (y - ir.y) ** 2) / (1.6 * ir.r) ** 2) * lid * corner;
  return [g.x * 0.55 * ir.r * wgt, g.y * 0.35 * ir.r * wgt];
}

/** Weiche Verformung aus Anfassern (Gauß-gewichteter Mittelwert, klingt fern aller Anfasser auf 0 aus). */
function handleDisplacement(handles, x, y) {
  let ax = 0, ay = 0, ws = 0;
  for (const hd of handles) {
    const w = Math.exp(-(((x - hd.x) / hd.rx) ** 2 + ((y - hd.y) / hd.ry) ** 2));
    ax += w * hd.dx; ay += w * hd.dy; ws += w;
  }
  if (ws < 1e-6) return [0, 0];
  const f = Math.min(1, ws) / ws;
  return [ax * f, ay * f];
}

/** Anfasser für die Brauen: Brauenpunkte bewegen sich, das Oberlid bleibt als Anker stehen. */
function browHandles(lm, eyes, b, fh) {
  const cx = lm[NOSE_BRIDGE][0], out = [];
  for (const side of ['left', 'right']) {
    const up = BROWS[side].upper.map((i) => lm[i]), lo = BROWS[side].lower.map((i) => lm[i]);
    const e = eyes[side];
    const browY = up.reduce((s2, p) => s2 + p[1], 0) / up.length;
    const lidY = e.up.reduce((s2, p) => s2 + p[1], 0) / e.up.length;
    const gap = Math.max(4, lidY - browY), bw = Math.max(4, Math.abs(up[0][0] - up[up.length - 1][0]));
    for (const row of [up, lo])
      row.forEach((p, k) => {
        const t = k / (row.length - 1); // 0 = außen, 1 = innen
        const dy = ((b.outer ?? 0) * (1 - t) + (b.inner ?? 0) * t) * fh;
        const dx = (b.inward ?? 0) * t * fh * Math.sign(cx - p[0]);
        out.push({ x: p[0], y: p[1], dx, dy, rx: 0.35 * bw, ry: 0.9 * gap });
      });
    for (const p of e.up) out.push({ x: p[0], y: p[1], dx: 0, dy: 0, rx: 0.15 * e.w, ry: 0.35 * gap });
  }
  return out;
}

/** Verschiebung (Pixel) für den Mund. lower: liegt der Punkt unterhalb des Lippenschnitts? */
function mouthDisplacement(m, x, y, lower, p) {
  const W = m.W, u = (x - m.cx) / (W / 2);
  const inside = Math.max(0, 1 - u * u);
  let dx = 0, dy = 0;
  if (p.open) {
    if (lower) dy += p.open * 0.42 * W * inside * Math.exp(-(((y - m.slitY) / (1.15 * W)) ** 2));
    else dy -= p.open * 0.08 * W * inside * Math.exp(-(((m.slitY - y) / (0.5 * W)) ** 2));
  }
  const band = Math.exp(-(((y - m.slitY) / (0.45 * W)) ** 2));
  if (p.width) dx += p.width * 0.18 * W * Math.max(-1.4, Math.min(1.4, u)) * Math.exp(-(u * u) / 1.6) * band;
  if (p.round) dx -= p.round * 0.12 * W * u * Math.exp(-(u * u) / 2) * band;
  if (p.smile) {
    for (const [cxk, cyk, sgn] of [[m.rx, m.ry, -1], [m.lx, m.ly, 1]]) {
      const g = Math.exp(-((x - cxk) ** 2 + (y - cyk) ** 2) / (0.38 * W) ** 2);
      dx += p.smile * sgn * 0.05 * W * g;
      dy -= p.smile * 0.09 * W * g;
    }
  }
  return [dx, dy];
}

function nearest4(ids, xy, x, y) {
  const best = [[Infinity, -1], [Infinity, -1], [Infinity, -1], [Infinity, -1]];
  for (const i of ids) {
    const d = Math.hypot(xy[2 * i] - x, xy[2 * i + 1] - y);
    if (d >= best[3][0]) continue;
    let k = 3;
    while (k > 0 && best[k - 1][0] > d) { best[k] = best[k - 1]; k--; }
    best[k] = [d, i];
  }
  return best.filter(([, i]) => i >= 0);
}

/** Textur für den Mundinnenraum (dunkler Rachen, obere Zahnreihe, Zunge). */
export function mouthInteriorTexture() {
  const w = 64, h = 48, img = createImage(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w - 0.5, v = (y + 0.5) / h;
      const r = Math.hypot(u * 1.6, v - 0.55);
      let c = [Math.round(55 + 40 * Math.max(0, 1 - r * 1.8)), 14, 22];
      if (v < 0.2 && Math.abs(u) < 0.36) c = [236, 232, 224]; // obere Zähne
      if (v > 0.72 && Math.hypot(u / 0.36, (v - 0.95) / 0.28) < 1) c = [176, 74, 84]; // Zunge
      const i = (y * w + x) * 4;
      img.data.set([...c, 255], i);
    }
  return img;
}

/**
 * Gesichts-Mesh mit Morph-Targets.
 * lm: 478 Punkte [x, y] in Texturpixeln; tex: Bild mit Alpha; fm/zFront/frontNormals: Körper-Vorderseite.
 * Rückgabe: { mesh, expressions } – mesh nutzt frontMaterial (Fototextur) und mouthMaterial (Innenraum).
 */
export function buildFaceRig({ lm, tex, fm, zFront, frontNormals, toWorld, skel, lbs, dy, height, frontMaterial, mouthMaterial }) {
  const W = tex.width, H = tex.height;
  const ovalX = FACE_OVAL.map((i) => lm[i][0]), ovalY = FACE_OVAL.map((i) => lm[i][1]);
  const fx0 = Math.min(...ovalX), fx1 = Math.max(...ovalX), fy0 = Math.min(...ovalY), fy1 = Math.max(...ovalY);
  const fw = fx1 - fx0, fh = fy1 - fy0;
  const rx0 = Math.max(0, fx0 - 0.06 * fw), rx1 = Math.min(W, fx1 + 0.06 * fw);
  const ry0 = Math.max(0, fy0 + 0.12 * fh), ry1 = Math.min(H, fy1 + 0.2 * fh); // Stirn-/Haaransatz bleibt beim Körper
  const cell = Math.max(0.75, fh / 110);
  const nx = Math.max(2, Math.ceil((rx1 - rx0) / cell)), ny = Math.max(2, Math.ceil((ry1 - ry0) / cell));
  const C = nx + 1;

  // Mund: gerader Schnitt in Höhe der Lippenmitte zwischen den Mundwinkeln
  const mr = lm[MOUTH.right], ml = lm[MOUTH.left];
  const mouth = {
    rx: Math.min(mr[0], ml[0]), ry: mr[0] < ml[0] ? mr[1] : ml[1],
    lx: Math.max(mr[0], ml[0]), ly: mr[0] < ml[0] ? ml[1] : mr[1],
    cx: (mr[0] + ml[0]) / 2, slitY: (lm[MOUTH.upperInner][1] + lm[MOUTH.lowerInner][1]) / 2,
  };
  mouth.W = Math.max(4, mouth.lx - mouth.rx);
  const slitRow = Math.round((mouth.slitY - ry0) / cell);
  const slitC0 = Math.ceil((mouth.rx - rx0) / cell) + 1, slitC1 = Math.floor((mouth.lx - rx0) / cell) - 1;

  // Zellen, die etwas von der Figur enthalten
  const covered = (r, c) => {
    const x0 = Math.floor(rx0 + c * cell), x1 = Math.min(W, Math.ceil(rx0 + (c + 1) * cell));
    const y0 = Math.floor(ry0 + r * cell), y1 = Math.min(H, Math.ceil(ry0 + (r + 1) * cell));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (tex.data[(y * W + x) * 4 + 3] > 127) return true;
    return false;
  };
  const vid = new Map(); // Schlüssel: Gitterpunkt*2 + (1 = Duplikat unterhalb des Lippenschnitts)
  const px = [], lowerSide = [];
  const vertex = (r, c, dup) => {
    const key = (r * C + c) * 2 + (dup ? 1 : 0);
    if (!vid.has(key)) {
      vid.set(key, px.length / 2);
      px.push(Math.min(W, rx0 + c * cell), Math.min(H, ry0 + r * cell));
      lowerSide.push(dup || ry0 + r * cell > mouth.slitY ? 1 : 0);
    }
    return vid.get(key);
  };
  const isSlit = (r, c) => r === slitRow && c >= slitC0 && c <= slitC1 + 1;
  const tris = [];
  for (let r = 0; r < ny; r++)
    for (let c = 0; c < nx; c++) {
      if (!covered(r, c)) continue;
      // Zellen direkt unter dem Schnitt hängen an den duplizierten Punkten
      const below = r === slitRow && c >= slitC0 && c <= slitC1;
      const tl = vertex(r, c, below && isSlit(r, c)), tr = vertex(r, c + 1, below && isSlit(r, c + 1));
      const bl = vertex(r + 1, c, false), br = vertex(r + 1, c + 1, false);
      tris.push(tl, bl, br, tl, br, tr);
    }
  const n = px.length / 2;
  if (!n) return null;

  // Lage: wie die Körperoberfläche darunter, minimal davor
  const body = [];
  for (let i = 0; i < fm.part.length; i++) if (fm.part[i] === 0) body.push(i);
  const xy = new Float64Array(2 * n), z = new Float64Array(n), normals = new Float64Array(3 * n), uvs = new Float64Array(2 * n);
  const eps = 0.0015 * height;
  for (let i = 0; i < n; i++) {
    const p = toWorld(px[2 * i], px[2 * i + 1]);
    xy[2 * i] = p[0]; xy[2 * i + 1] = p[1];
    uvs[2 * i] = px[2 * i] / W; uvs[2 * i + 1] = px[2 * i + 1] / H;
    const near = nearest4(body, fm.xy, p[0], p[1]);
    z[i] = near.reduce((s, [, k]) => s + zFront[k], 0) / near.length + eps;
    const nm = [0, 1, 2].map((a) => near.reduce((s, [, k]) => s + frontNormals[3 * k + a], 0) / near.length);
    const l = Math.max(Math.hypot(...nm), 1e-9);
    normals.set(nm.map((v) => v / l), 3 * i);
  }
  const allowed = new Uint8Array(BONES.length).fill(1);
  for (const side of Object.values(ARM_BONES)) for (const b of side) allowed[BONE_INDEX[b]] = 0;
  const allowAll = (count) => { const a = new Uint8Array(count * BONES.length); for (let k = 0; k < count; k++) a.set(allowed, k * BONES.length); return a; };
  const sw = skinWeights(xy, skel, allowAll(n), height);
  const posed = lbs ? applyLbs(xy, sw.joints, sw.weights, lbs) : xy;
  const positions = new Float64Array(3 * n);
  for (let i = 0; i < n; i++) positions.set([posed[2 * i], posed[2 * i + 1] + dy, z[i]], 3 * i);

  // Ruhelage-Tiefe als Gitter (für Verschiebungen: die Fläche bleibt auf der Gesichtswölbung)
  const zGrid = new Float64Array((ny + 1) * C).fill(NaN);
  for (const [key, i] of vid) if (key % 2 === 0) zGrid[key / 2] = z[i];
  const zAt = (x, y) => {
    const gx = Math.min(nx, Math.max(0, (x - rx0) / cell)), gy = Math.min(ny, Math.max(0, (y - ry0) / cell));
    const c0 = Math.min(nx - 1, Math.floor(gx)), r0 = Math.min(ny - 1, Math.floor(gy)), tx = gx - c0, ty = gy - r0;
    let acc = 0, wsum = 0;
    for (const [r, c, wt] of [[r0, c0, (1 - tx) * (1 - ty)], [r0, c0 + 1, tx * (1 - ty)], [r0 + 1, c0, (1 - tx) * ty], [r0 + 1, c0 + 1, tx * ty]]) {
      const v = zGrid[r * C + c];
      if (!Number.isNaN(v) && wt > 0) { acc += v * wt; wsum += wt; }
    }
    return wsum > 0 ? acc / wsum : NaN;
  };

  // Morph-Targets
  const eyes = { left: eyeGeometry(lm, 'left'), right: eyeGeometry(lm, 'right') };
  const iris = {};
  for (const side of ['left', 'right']) {
    const c = lm[IRIS[side][0]], rim = IRIS[side].slice(1).map((i) => lm[i]);
    iris[side] = { x: c[0], y: c[1], r: Math.max(1, rim.reduce((s2, p) => s2 + Math.hypot(p[0] - c[0], p[1] - c[1]), 0) / rim.length) };
  }
  const names = Object.keys(SHAPES), targets = [];
  for (const name of names) {
    const sh = SHAPES[name], t = new Float64Array(3 * n);
    const brows = sh.brows ? browHandles(lm, eyes, sh.brows, fh) : null;
    for (let i = 0; i < n; i++) {
      const x = px[2 * i], y = px[2 * i + 1];
      let dx = 0, dyp = 0;
      for (const side of ['left', 'right']) {
        const amount = sh.blink?.[side] ?? 0;
        if (amount) dyp += eyeDisplacement(eyes[side], x, y, 0.94 * amount, 0);
        if (sh.squint) dyp += eyeDisplacement(eyes[side], x, y, 0.3 * sh.squint, 0.25 * sh.squint);
        if (sh.lids) dyp += eyeDisplacement(eyes[side], x, y, sh.lids, 0);
        if (sh.gaze) {
          const [gx, gy] = gazeDisplacement(eyes[side], iris[side], x, y, sh.gaze);
          dx += gx; dyp += gy;
        }
      }
      if (brows) {
        const [bx, by] = handleDisplacement(brows, x, y);
        dx += bx; dyp += by;
      }
      if (sh.mouth) {
        const [mx, my] = mouthDisplacement(mouth, x, y, lowerSide[i] === 1, sh.mouth);
        dx += mx; dyp += my;
      }
      t[3 * i] = dx * toWorld.scale;
      t[3 * i + 1] = -dyp * toWorld.scale;
      if (dx || dyp) {
        const zn = zAt(x + dx, y + dyp);
        if (!Number.isNaN(zn)) t[3 * i + 2] = zn - z[i];
      }
    }
    targets.push(t);
  }

  // Mundinnenraum: liegt zwischen Körper und Gesichtsnetz, nur bei geöffneten Lippen sichtbar
  const mx0 = mouth.rx + 0.04 * mouth.W, mx1 = mouth.lx - 0.04 * mouth.W;
  const my0 = mouth.slitY - 0.12 * mouth.W, my1 = mouth.slitY + 0.5 * mouth.W;
  const gm = 14, mn = (gm + 1) * (gm + 1);
  const faceIds = Array.from({ length: n }, (_, i) => i);
  const mxy = new Float64Array(2 * mn), mz = new Float64Array(mn), muv = new Float64Array(2 * mn), mnrm = new Float64Array(3 * mn);
  for (let r = 0; r <= gm; r++)
    for (let c = 0; c <= gm; c++) {
      const k = r * (gm + 1) + c, x = mx0 + ((mx1 - mx0) * c) / gm, y = my0 + ((my1 - my0) * r) / gm;
      const p = toWorld(x, y);
      mxy[2 * k] = p[0]; mxy[2 * k + 1] = p[1];
      // im Kopf hinter den Lippen (der Körper bekommt dort eine Öffnung, siehe mouthHole)
      const near = nearest4(faceIds, xy, p[0], p[1]);
      mz[k] = near.reduce((s, [, q]) => s + z[q], 0) / near.length - 0.012 * height;
      muv.set([c / gm, r / gm], 2 * k);
      mnrm.set([0, 0, 1], 3 * k);
    }
  const msw = skinWeights(mxy, skel, allowAll(mn), height);
  const mposed = lbs ? applyLbs(mxy, msw.joints, msw.weights, lbs) : mxy;
  const mpos = new Float64Array(3 * mn);
  for (let k = 0; k < mn; k++) mpos.set([mposed[2 * k], mposed[2 * k + 1] + dy, mz[k]], 3 * k);
  const mtris = [];
  for (let r = 0; r < gm; r++)
    for (let c = 0; c < gm; c++) {
      const tl = r * (gm + 1) + c;
      mtris.push(tl, tl + gm + 1, tl + gm + 2, tl, tl + gm + 2, tl + 1);
    }

  const mesh = {
    name: 'Face', targetNames: names,
    primitives: [
      { positions, normals, uvs, indices: Uint32Array.from(tris), joints: sw.joints, weights: sw.weights, material: frontMaterial, targets },
      { positions: mpos, normals: mnrm, uvs: muv, indices: Uint32Array.from(mtris), joints: msw.joints, weights: msw.weights,
        material: mouthMaterial, targets: names.map(() => new Float64Array(3 * mn)) },
    ],
  };
  // Bereich, in dem die Körper-Vorderseite offen sein muss, damit der Mundraum sichtbar wird (etwas kleiner als
  // der Innenraum – das Gesichtsnetz deckt die Ränder in Ruhe ab)
  const mouthHole = [mx0 + 0.05 * mouth.W, mouth.slitY - 0.08 * mouth.W, mx1 - 0.05 * mouth.W, my1 - 0.05 * mouth.W];
  return { mesh, expressions: FACE_EXPRESSIONS, mouthHole, stats: { faceVertices: n, cell } };
}
