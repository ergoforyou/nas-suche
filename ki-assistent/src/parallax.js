// Leichtes Drehen eines Bild-Avatars ("2,5D"): Mit einer Tiefenkarte (wie weit ist jeder Bildpunkt entfernt?)
// werden nahe Teile (Nase, Brust) beim Drehen stärker verschoben als ferne (Ohren, Haare, Hintergrund).
// Für kleine Winkel (bis etwa ±20°) wirkt das wie eine echte Drehung.

const DEPTH_SIDE = 256;

/** Kurze Kennung eines Bildes: Die Tiefenkarte gilt nur für genau das Bild, aus dem sie berechnet wurde. */
export const imageKey = (src) => `${String(src).length}:${String(src).slice(-48)}`;

/** Kastenweichzeichner für ein Graustufenfeld (mehrfach angewandt ≈ Gauß). */
function blur(src, w, h, r, passes = 2) {
  let a = src;
  for (let p = 0; p < passes; p++) {
    const tmp = new Float32Array(w * h);
    const out = new Float32Array(w * h);
    const n = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += a[y * w + Math.max(0, Math.min(w - 1, x))];
      for (let x = 0; x < w; x++) {
        tmp[y * w + x] = acc / n;
        acc += a[y * w + Math.min(w - 1, x + r + 1)] - a[y * w + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[Math.max(0, Math.min(h - 1, y)) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = acc / n;
        acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
      }
    }
    a = out;
  }
  return a;
}

/**
 * Tiefenkarte als kleines Graustufenbild (Data-URL) erzeugen.
 * @param {HTMLCanvasElement} image Avatar-Bild
 * @param {(imageData: ImageData) => Promise<Uint8ClampedArray>} [estimate] KI-Tiefenschätzung (optional)
 */
export async function buildDepthMap(image, estimate) {
  const s = Math.min(1, DEPTH_SIDE / Math.max(image.width, image.height));
  const w = Math.max(8, Math.round(image.width * s));
  const h = Math.max(8, Math.round(image.height * s));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(image, 0, 0, w, h);
  const id = g.getImageData(0, 0, w, h);
  const alpha = new Float32Array(w * h);
  let transparent = 0;
  for (let i = 0; i < w * h; i++) {
    alpha[i] = id.data[i * 4 + 3] / 255;
    if (alpha[i] < 0.5) transparent++;
  }
  const cutout = transparent > w * h * 0.05;

  // Ersatz ohne KI: Figur "aufblasen" – Mitte des Umrisses nah, Ränder fern
  const r = Math.max(2, Math.round(Math.min(w, h) * 0.06));
  const dome = blur(cutout ? alpha : new Float32Array(w * h).fill(1), w, h, r, 3);
  let depth = dome.map((v, i) => Math.sqrt(Math.max(0, v)) * (cutout ? alpha[i] : 1));
  let source = 'Umriss';

  if (estimate) {
    try {
      const ai = await estimate(id);
      const d = new Float32Array(w * h);
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < w * h; i++) {
        if (cutout && alpha[i] < 0.5) continue;
        lo = Math.min(lo, ai[i]);
        hi = Math.max(hi, ai[i]);
      }
      const span = Math.max(1, hi - lo);
      for (let i = 0; i < w * h; i++) d[i] = Math.max(0, (ai[i] - lo) / span) * (cutout ? alpha[i] : 1);
      // KI-Tiefe mit etwas Umriss-Wölbung mischen: wirkt runder, weniger "Pappkamerad"
      depth = d.map((v, i) => v * 0.75 + depth[i] * 0.25);
      source = 'KI';
    } catch (e) {
      console.warn('Tiefenschätzung nicht möglich, nutze Umriss:', e);
    }
  }
  // Tiefe über den Umriss hinaus weich fortsetzen: Ein harter Sprung am Rand erzeugt beim Drehen „Geisterbilder“
  if (cutout) {
    const R = Math.max(3, Math.round(Math.min(w, h) * 0.08));
    const num = blur(depth.map((v, i) => v * alpha[i]), w, h, R, 3);
    const den = blur(alpha, w, h, R, 3);
    depth = depth.map((v, i) => v * alpha[i] + (den[i] > 1e-4 ? num[i] / den[i] : 0) * (1 - alpha[i]));
  }
  depth = blur(depth, w, h, 3, 2); // weiche Übergänge, sonst reißt das Bild an Kanten
  const out = g.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = Math.round(Math.max(0, Math.min(1, depth[i])) * 255);
    out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = v;
    out.data[i * 4 + 3] = 255;
  }
  g.putImageData(out, 0, 0);
  return { url: c.toDataURL('image/png'), source };
}

const VS = `#version 300 es
in vec2 p;
out vec2 uv;
void main() {
  uv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

// Rückwärts-Abbildung: Für jeden Zielpunkt die Quellposition suchen, deren gedrehte Lage hier landet
// (Fixpunkt-Iteration, da die Tiefe an der noch unbekannten Quellposition gebraucht wird).
const FS = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 o;
uniform sampler2D S;
uniform sampler2D D;
uniform float c;
uniform float s;
uniform float k;
uniform float cx;
void main() {
  float xs = uv.x;
  for (int i = 0; i < 8; i++) {
    float z = texture(D, vec2(xs, uv.y)).r - 0.5;
    xs = mix(xs, cx + (uv.x - cx - z * k * s) / c, 0.7); // gedämpft, damit es an steilen Stellen nicht springt
  }
  if (xs < 0.0 || xs > 1.0) { o = vec4(0.0); return; }
  o = texture(S, vec2(xs, uv.y));
}`;

/**
 * @param {Document} doc
 * @param {HTMLCanvasElement|HTMLImageElement} depthImg Tiefenkarte
 * @param {number} cx Drehachse (0..1, Mitte der Figur)
 */
export function createParallax(doc, depthImg, cx = 0.5) {
  const canvas = doc.createElement('canvas');
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: true, alpha: true });
  if (!gl) return null;
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
  const mkTex = () => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  const srcTex = mkTex();
  const depthTex = mkTex();
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, depthImg);
  const u = (n) => gl.getUniformLocation(prog, n);
  gl.uniform1i(u('S'), 0);
  gl.uniform1i(u('D'), 1);
  gl.uniform1f(u('cx'), cx);
  // Tiefe der Figur im Verhältnis zur Bildbreite (Kopf/Oberkörper sind etwa halb so tief wie breit)
  gl.uniform1f(u('k'), 0.2);
  const uc = u('c');
  const us = u('s');

  return {
    canvas,
    /** Quelle (Leinwand) um yaw (Bogenmaß) gedreht zeichnen. */
    render(src, yaw) {
      if (canvas.width !== src.width || canvas.height !== src.height) {
        canvas.width = src.width;
        canvas.height = src.height;
        gl.viewport(0, 0, src.width, src.height);
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, depthTex);
      gl.uniform1f(uc, Math.cos(yaw));
      gl.uniform1f(us, Math.sin(yaw));
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return canvas;
    },
    dispose() {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}

/** Horizontale Mitte der sichtbaren Figur (0..1) – dort liegt die Drehachse. */
export function figureCenterX(img) {
  const w = 64;
  const h = Math.max(8, Math.round((img.height / img.width) * 64));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  let sum = 0;
  let wsum = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = d[(y * w + x) * 4 + 3];
      sum += a * x;
      wsum += a;
    }
  }
  return wsum ? (sum / wsum + 0.5) / w : 0.5;
}
