// Automatisches Gesichts-Rigging für Bild-Avatare.
// MediaPipe Face Landmarker findet einmalig ~478 Gesichtspunkte (Lider, Iris, Brauen, Lippen). Daraus entsteht
// ein kleines "Rig". Zur Laufzeit verschiebt eine Verformung per Grafikkarte die Bildpunkte rund um diese
// Punkte: echtes Blinzeln (Lid gleitet über das Auge), Blickbewegung der Iris, Augenbrauen, Mundwinkel und
// Mundbreite passend zum Laut. Alles läuft lokal.

// Indizes im MediaPipe-Gesichtsnetz (Sicht des Betrachters: "R" = rechtes Auge der Person = links im Bild)
const IDX = {
  rUpper: [246, 161, 160, 159, 158, 157, 173],
  rLower: [7, 163, 144, 145, 153, 154, 155],
  lUpper: [466, 388, 387, 386, 385, 384, 398],
  lLower: [249, 390, 373, 374, 380, 381, 382],
  rIris: [468, 469, 470, 471, 472],
  lIris: [473, 474, 475, 476, 477],
  rBrow: [70, 63, 105, 66, 107],
  lBrow: [300, 293, 334, 296, 336],
  mouthR: 61,
  mouthL: 291,
  upperLip: 13,
  lowerLip: 14,
  noseTip: 1,
  chin: 152,
  forehead: 10,
};

let landmarkerPromise = null;
async function getLandmarker() {
  landmarkerPromise ??= (async () => {
    const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision');
    const base = new URL('wasm/mediapipe/', location.href).href;
    const fileset = await FilesetResolver.forVisionTasks(base);
    return FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: base + 'face_landmarker.task', delegate: 'CPU' },
      runningMode: 'IMAGE',
      numFaces: 1,
    });
  })().catch((e) => {
    landmarkerPromise = null;
    throw e;
  });
  return landmarkerPromise;
}

/**
 * Gesicht im Bild finden und das Rig berechnen. Koordinaten normiert (0..1) auf Bildbreite/-höhe.
 * @returns {Promise<object|null>} null, wenn kein Gesicht gefunden wurde
 */
export async function detectFaceRig(image) {
  const lm = await getLandmarker();
  const res = lm.detect(image);
  const pts = res?.faceLandmarks?.[0];
  if (!pts || pts.length < 478) return null;
  const P = (i) => ({ x: pts[i].x, y: pts[i].y, z: pts[i].z });
  const many = (list) => list.map(P);
  const center = (list) => ({ x: list.reduce((s, p) => s + p.x, 0) / list.length, y: list.reduce((s, p) => s + p.y, 0) / list.length });
  const eye = (upper, lower, iris) => {
    const u = many(upper);
    const l = many(lower);
    const ir = many(iris);
    const c = ir[0];
    const r = ir.slice(1).reduce((s, p) => s + Math.hypot(p.x - c.x, p.y - c.y), 0) / 4;
    return { upper: u, lower: l, iris: { x: c.x, y: c.y, r } };
  };
  const rig = {
    rEye: eye(IDX.rUpper, IDX.rLower, IDX.rIris),
    lEye: eye(IDX.lUpper, IDX.lLower, IDX.lIris),
    rBrow: many(IDX.rBrow),
    lBrow: many(IDX.lBrow),
    mouth: { r: P(IDX.mouthR), l: P(IDX.mouthL), upper: P(IDX.upperLip), lower: P(IDX.lowerLip) },
    nose: P(IDX.noseTip),
    chin: P(IDX.chin),
    forehead: P(IDX.forehead),
  };
  rig.faceH = Math.hypot(rig.chin.x - rig.forehead.x, rig.chin.y - rig.forehead.y);
  rig.eyeCenter = center([rig.rEye.iris, rig.lEye.iris]);
  return rig;
}

/** Aus dem Rig die bisherigen Markierungen (Augen, Mund) ableiten – für die vorhandene Mund-/Augenlogik. */
export function markersFromRig(rig) {
  const eyeMarker = (e) => ({ x: e.iris.x, y: e.iris.y, r: Math.max(0.006, e.iris.r * 1.6) });
  return {
    eyes: [eyeMarker(rig.rEye), eyeMarker(rig.lEye)],
    mouth: {
      x: (rig.mouth.l.x + rig.mouth.r.x) / 2,
      y: (rig.mouth.upper.y + rig.mouth.lower.y) / 2,
      w: Math.abs(rig.mouth.l.x - rig.mouth.r.x) * 1.15,
    },
  };
}

const MAX_HANDLES = 96;
const VS = `#version 300 es
in vec2 p;
out vec2 uv;
void main() {
  uv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  gl_Position = vec4(p, 0.0, 1.0);
}`;
// Rückwärts-Verformung: Jeder Zielpunkt holt seine Farbe von "Ziel minus Verschiebung".
// Die Verschiebung ist ein gewichteter Mittelwert der Anfasser in der Nähe (weiche Gauß-Gewichte, je Achse
// eigener Radius) – so entsteht ein glattes Verschiebungsfeld ohne Risse.
const FS = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 o;
uniform sampler2D S;
uniform vec2 size;
uniform int n;
uniform vec4 h[${MAX_HANDLES}];  // x, y, dx, dy (Pixel)
uniform vec2 rad[${MAX_HANDLES}]; // Radius x, y (Pixel)
void main() {
  vec2 px = uv * size;
  vec2 acc = vec2(0.0);
  float wsum = 0.0;
  for (int i = 0; i < ${MAX_HANDLES}; i++) {
    if (i >= n) break;
    vec2 d = (px - h[i].xy) / rad[i];
    float w = exp(-dot(d, d));
    acc += w * h[i].zw;
    wsum += w;
  }
  // gewichteter Mittelwert; weit weg von allen Anfassern klingt die Verschiebung weich auf 0 aus
  vec2 disp = wsum > 1e-5 ? acc / wsum * min(1.0, wsum) : vec2(0.0);
  o = texture(S, (px - disp) / size);
}`;

/** Verformer für eine Ebene: zeichnet die Quelle mit den aktuellen Anfassern. */
export function createFaceWarp(doc) {
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
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  const u = (name) => gl.getUniformLocation(prog, name);
  gl.uniform1i(u('S'), 0);
  const uSize = u('size');
  const uN = u('n');
  const uH = u('h');
  const uR = u('rad');
  const hArr = new Float32Array(MAX_HANDLES * 4);
  const rArr = new Float32Array(MAX_HANDLES * 2);

  return {
    /** handles: [{x, y, dx, dy, rx, ry}] in Pixeln der Quelle */
    render(src, handles) {
      if (canvas.width !== src.width || canvas.height !== src.height) {
        canvas.width = src.width;
        canvas.height = src.height;
        gl.viewport(0, 0, src.width, src.height);
      }
      const n = Math.min(MAX_HANDLES, handles.length);
      for (let i = 0; i < n; i++) {
        const H = handles[i];
        hArr.set([H.x, H.y, H.dx, H.dy], i * 4);
        rArr.set([Math.max(1, H.rx), Math.max(1, H.ry)], i * 2);
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.uniform2f(uSize, src.width, src.height);
      gl.uniform1i(uN, n);
      gl.uniform4fv(uH, hArr);
      gl.uniform2fv(uR, rArr);
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

/**
 * Anfasser für den aktuellen Moment berechnen.
 * st: { blink 0..1, gazeX/gazeY (-1..1), brow (-1..1, + = hoch), smile (0..1), shape (-1 rund .. +1 breit), open (0..1) }
 */
export function faceHandles(rig, W, H, st) {
  const out = [];
  const px = (p) => ({ x: p.x * W, y: p.y * H });
  const fh = rig.faceH * H;
  const anchor = (p, rx, ry) => out.push({ x: p.x, y: p.y, dx: 0, dy: 0, rx, ry });
  const browLift = -(st.brow ?? 0) * fh * 0.024;
  // Punkt auf einer Linie aus Landmarken (t = 0..1)
  const along = (pts, t) => {
    const f = t * (pts.length - 1);
    const i = Math.min(pts.length - 2, Math.floor(f));
    const k = f - i;
    return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * k, y: pts[i].y + (pts[i + 1].y - pts[i].y) * k };
  };
  for (const [e, browPts] of [
    [rig.rEye, rig.rBrow],
    [rig.lEye, rig.lBrow],
  ]) {
    const up = e.upper.map(px);
    const lo = e.lower.map(px);
    const width = Math.hypot(up.at(-1).x - up[0].x, up.at(-1).y - up[0].y);
    const eyeH = Math.max(2, up.reduce((s, p, i) => s + (lo[i].y - p.y), 0) / up.length);
    const ir = px(e.iris);
    const irR = e.iris.r * W;
    // Unterlid und Augenwinkel bleiben stehen (Anker etwas unterhalb: so deckt das Oberlid das Auge ganz ab)
    for (const t of [0.2, 0.4, 0.6, 0.8]) {
      const p = along(lo, t);
      anchor({ x: p.x, y: p.y + eyeH * 0.6 }, width * 0.16, eyeH * 0.45);
    }
    anchor(up[0], width * 0.1, eyeH * 0.6);
    anchor(up.at(-1), width * 0.1, eyeH * 0.6);
    // Brauen: heben/senken; die Stirn darüber hält still, damit nichts verschmiert
    for (const t of [0.1, 0.5, 0.9]) {
      const p = along(browPts.map(px), t);
      out.push({ x: p.x, y: p.y, dx: 0, dy: browLift, rx: width * 0.38, ry: eyeH * 1.3 });
      anchor({ x: p.x, y: p.y - eyeH * 3.2 }, width * 0.4, eyeH * 1.6);
    }
    if (st.blink > 0.01) {
      // Oberlid gleitet zum Unterlid – gleichmäßig verteilt entlang des ganzen Lids, damit keine Stufen entstehen
      for (let j = 0; j < 8; j++) {
        const t = 0.08 + (j / 7) * 0.84;
        const u = along(up, t);
        const l = along(lo, t);
        const gap = l.y - u.y;
        const dy = gap * st.blink * 1.3;
        out.push({ x: u.x, y: u.y + gap * 0.6 * st.blink, dx: 0, dy, rx: width * 0.1, ry: eyeH * 0.6 });
        out.push({ x: u.x, y: u.y - eyeH * 0.6, dx: 0, dy: dy * 0.45, rx: width * 0.1, ry: eyeH * 0.6 });
      }
    } else {
      // Oberlid halten, damit Brauen oder Blick das Auge nicht mitziehen
      for (const t of [0.25, 0.5, 0.75]) anchor(along(up, t), width * 0.14, eyeH * 0.4);
    }
    // Blick: Iris verschiebt sich innerhalb des Auges
    if ((st.gazeX || st.gazeY) && st.blink < 0.6) {
      out.push({ x: ir.x, y: ir.y, dx: (st.gazeX ?? 0) * irR * 0.7, dy: (st.gazeY ?? 0) * irR * 0.25, rx: irR * 0.9, ry: irR * 0.9 });
    }
  }
  // Mund: Mundwinkel nach außen/innen (Laut) und leicht nach oben (Lächeln); Mundmitte bleibt
  const mr = px(rig.mouth.r);
  const ml = px(rig.mouth.l);
  const mw = Math.hypot(ml.x - mr.x, ml.y - mr.y);
  const wide = (st.shape ?? 0) * mw * 0.09;
  const lift = (st.smile ?? 0) * fh * 0.025;
  if (wide || lift) {
    const dir = Math.sign(ml.x - mr.x) || 1;
    out.push({ x: mr.x, y: mr.y, dx: -dir * wide, dy: -lift, rx: mw * 0.22, ry: mw * 0.2 });
    out.push({ x: ml.x, y: ml.y, dx: dir * wide, dy: -lift, rx: mw * 0.22, ry: mw * 0.2 });
    anchor(px(rig.nose), mw * 0.3, mw * 0.2);
    anchor({ x: (mr.x + ml.x) / 2, y: (mr.y + ml.y) / 2 }, mw * 0.12, mw * 0.25);
  }
  return out;
}
