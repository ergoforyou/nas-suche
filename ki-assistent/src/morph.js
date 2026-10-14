// Flüssige 2D-Bewegung aus mehreren Bildern derselben Figur ("Morphing").
//
// Beim Laden wird für jedes Zusatzbild einmal berechnet, wie sich jeder Bildpunkt gegenüber dem Grundbild
// verschiebt (optischer Fluss, pyramidales Lucas-Kanade-Verfahren). Zur Laufzeit verformt die Grafikkarte
// beide Bilder entlang dieser Verschiebung aufeinander zu und blendet sie dabei über – so entsteht eine
// fließende Bewegung statt eines harten Überblendens.

const FLOW_MAX_SIDE = 200; // Rechenauflösung für den Fluss (reicht für weiche Bewegungen)

/** Graustufenbild (mit Alpha gewichtet, damit der Umriss der Figur zählt) in kleiner Auflösung. */
function grayOf(canvas, w, h) {
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(canvas, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = d[i * 4 + 3] / 255;
    out[i] = ((d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) / 255) * a + a * 0.25;
  }
  return out;
}

function downsample(img, w, h) {
  const w2 = Math.max(1, w >> 1);
  const h2 = Math.max(1, h >> 1);
  const out = new Float32Array(w2 * h2);
  for (let y = 0; y < h2; y++) {
    for (let x = 0; x < w2; x++) {
      const x0 = Math.min(w - 1, x * 2);
      const y0 = Math.min(h - 1, y * 2);
      const x1 = Math.min(w - 1, x0 + 1);
      const y1 = Math.min(h - 1, y0 + 1);
      out[y * w2 + x] = (img[y0 * w + x0] + img[y0 * w + x1] + img[y1 * w + x0] + img[y1 * w + x1]) / 4;
    }
  }
  return { img: out, w: w2, h: h2 };
}

function sample(img, w, h, x, y) {
  x = Math.max(0, Math.min(w - 1.001, x));
  y = Math.max(0, Math.min(h - 1.001, y));
  const x0 = x | 0;
  const y0 = y | 0;
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * w + x0;
  return (img[i] * (1 - fx) + img[i + 1] * fx) * (1 - fy) + (img[i + w] * (1 - fx) + img[i + w + 1] * fx) * fy;
}

/** Kastenfilter (getrennt nach Zeilen/Spalten) – für Fenstersummen und zum Glätten des Flusses. */
function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[y * w + Math.max(0, Math.min(w - 1, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc;
      acc += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.max(0, Math.min(h - 1, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/**
 * Dichter optischer Fluss von a nach b: Für jeden Punkt x gilt ungefähr a(x) ≈ b(x + f(x)).
 * Ergebnis in Bildpunkten der übergebenen Auflösung (u, v abwechselnd).
 */
export function computeFlow(a, b, w, h) {
  // Pyramide aufbauen
  const levels = [{ a, b, w, h }];
  while (Math.min(levels.at(-1).w, levels.at(-1).h) > 24 && levels.length < 5) {
    const L = levels.at(-1);
    const da = downsample(L.a, L.w, L.h);
    const db = downsample(L.b, L.w, L.h);
    levels.push({ a: da.img, b: db.img, w: da.w, h: da.h });
  }
  let u = null;
  let v = null;
  for (let li = levels.length - 1; li >= 0; li--) {
    const { a: A, b: Bi, w: W, h: H } = levels[li];
    const n = W * H;
    // Fluss der gröberen Stufe hochrechnen
    const nu = new Float32Array(n);
    const nv = new Float32Array(n);
    if (u) {
      const { w: pw, h: ph } = levels[li + 1];
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          nu[y * W + x] = sample(u, pw, ph, x / 2, y / 2) * 2;
          nv[y * W + x] = sample(v, pw, ph, x / 2, y / 2) * 2;
        }
      }
    }
    u = nu;
    v = nv;
    // Gradienten von a
    const Ix = new Float32Array(n);
    const Iy = new Float32Array(n);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        Ix[i] = (A[y * W + Math.min(W - 1, x + 1)] - A[y * W + Math.max(0, x - 1)]) / 2;
        Iy[i] = (A[Math.min(H - 1, y + 1) * W + x] - A[Math.max(0, y - 1) * W + x]) / 2;
      }
    }
    const r = 3;
    const Sxx = boxBlur(Ix.map((g) => g * g), W, H, r);
    const Syy = boxBlur(Iy.map((g) => g * g), W, H, r);
    const Sxy = boxBlur(Ix.map((g, i) => g * Iy[i]), W, H, r);
    const lambda = 0.02; // Regularisierung: in strukturlosen Flächen bleibt der Fluss klein
    for (let it = 0; it < 4; it++) {
      const ex = new Float32Array(n);
      const ey = new Float32Array(n);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          const It = sample(Bi, W, H, x + u[i], y + v[i]) - A[i];
          ex[i] = Ix[i] * It;
          ey[i] = Iy[i] * It;
        }
      }
      const Sxt = boxBlur(ex, W, H, r);
      const Syt = boxBlur(ey, W, H, r);
      for (let i = 0; i < n; i++) {
        const a11 = Sxx[i] + lambda;
        const a22 = Syy[i] + lambda;
        const a12 = Sxy[i];
        const det = a11 * a22 - a12 * a12;
        if (det < 1e-9) continue;
        const du = -(a22 * Sxt[i] - a12 * Syt[i]) / det;
        const dv = -(a11 * Syt[i] - a12 * Sxt[i]) / det;
        u[i] += Math.max(-2, Math.min(2, du));
        v[i] += Math.max(-2, Math.min(2, dv));
      }
    }
    // glätten (gegen Ausreißer), Fenstersumme -> Mittelwert
    const k = (2 * 2 + 1) ** 2;
    u = boxBlur(u, W, H, 2).map((s) => s / k);
    v = boxBlur(v, W, H, 2).map((s) => s / k);
  }
  const out = new Float32Array(w * h * 2);
  for (let i = 0; i < w * h; i++) {
    out[i * 2] = u[i];
    out[i * 2 + 1] = v[i];
  }
  return out;
}

const VS = `#version 300 es
in vec2 p;
out vec2 uv;
void main() {
  uv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 o;
uniform sampler2D A;
uniform sampler2D B;
uniform sampler2D FAB;
uniform sampler2D FBA;
uniform float t;
void main() {
  vec2 fab = texture(FAB, uv).xy;
  vec2 fba = texture(FBA, uv).xy;
  vec4 a = texture(A, uv - t * fab);
  vec4 b = texture(B, uv - (1.0 - t) * fba);
  o = mix(a, b, t);
}`;

const cache = new Map(); // Fluss nur einmal je Bildpaar berechnen

/**
 * @param {Document} doc
 * @param {HTMLCanvasElement} base Grundbild
 * @param {HTMLCanvasElement[]} targets Zusatzbilder in derselben Größe wie das Grundbild
 * @param {string[]} keys Kennungen der Bilder (für den Zwischenspeicher)
 */
export function createMorpher(doc, base, targets, keys = []) {
  const W = base.width;
  const H = base.height;
  const canvas = doc.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: true, alpha: true });
  if (!gl) return null;

  const s = Math.min(1, FLOW_MAX_SIDE / Math.max(W, H));
  const fw = Math.max(8, Math.round(W * s));
  const fh = Math.max(8, Math.round(H * s));
  const grayBase = grayOf(base, fw, fh);

  const prog = gl.createProgram();
  for (const [type, src] of [
    [gl.VERTEX_SHADER, VS],
    [gl.FRAGMENT_SHADER, FS],
  ]) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    gl.attachShader(prog, sh);
  }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const tex = (setup) => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    setup();
    return t;
  };
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  const imageTex = (c) => tex(() => gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c));
  const flowTex = (f) => {
    // in Bildkoordinaten (0..1) umrechnen
    const d = new Float32Array(f.length);
    for (let i = 0; i < f.length; i += 2) {
      d[i] = f[i] / fw;
      d[i + 1] = f[i + 1] / fh;
    }
    return tex(() => gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, fw, fh, 0, gl.RG, gl.FLOAT, d));
  };

  const baseTex = imageTex(base);
  const pairs = targets.map((c, i) => {
    const key = `${keys[0] ?? ''}|${keys[i + 1] ?? i}|${fw}x${fh}`;
    let flows = cache.get(key);
    if (!flows) {
      const g = grayOf(c, fw, fh);
      flows = { ab: computeFlow(grayBase, g, fw, fh), ba: computeFlow(g, grayBase, fw, fh) };
      cache.set(key, flows);
      if (cache.size > 8) cache.delete(cache.keys().next().value);
    }
    return { img: imageTex(c), ab: flowTex(flows.ab), ba: flowTex(flows.ba) };
  });

  const uni = (n) => gl.getUniformLocation(prog, n);
  gl.uniform1i(uni('A'), 0);
  gl.uniform1i(uni('B'), 1);
  gl.uniform1i(uni('FAB'), 2);
  gl.uniform1i(uni('FBA'), 3);
  const uT = uni('t');
  gl.viewport(0, 0, W, H);

  return {
    canvas,
    count: pairs.length,
    /** Zwischenbild zwischen Grundbild (t = 0) und Zusatzbild i (t = 1). */
    render(i, t) {
      const P = pairs[i];
      if (!P) return base;
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      [baseTex, P.img, P.ab, P.ba].forEach((tx, unit) => {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, tx);
      });
      gl.uniform1f(uT, t);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return canvas;
    },
    dispose() {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
