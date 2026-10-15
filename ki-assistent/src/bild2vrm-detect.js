// Gesichts- und Körpererkennung für „3D-Figur aus Bildern“ (MediaPipe Face/Pose Landmarker, Apache-2.0).
// Laufzeit und Modelle liegen lokal unter wasm/mediapipe/ (siehe build.mjs) – es geht nichts ins Internet.
//
// Der Gesichtsdetektor von MediaPipe ist für nahe Gesichter gebaut: auf Ganzkörperbildern ist das Gesicht oft nur
// 60–100 Pixel groß und wird dann nicht gefunden. Deshalb wird der Kopfbereich (aus der Körpererkennung oder von
// Hand markiert) ausgeschnitten, vergrößert und dort gesucht.

let visionPromise = null;
function vision() {
  visionPromise ??= (async () => {
    const V = await import('@mediapipe/tasks-vision');
    const base = new URL('wasm/mediapipe/', location.href).href;
    const fileset = await V.FilesetResolver.forVisionTasks(base);
    const [face, pose] = await Promise.all([
      V.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: base + 'face_landmarker.task', delegate: 'CPU' }, runningMode: 'IMAGE', numFaces: 1,
      }),
      V.PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: base + 'pose_landmarker_full.task', delegate: 'CPU' }, runningMode: 'IMAGE', numPoses: 1,
      }),
    ]);
    return { face, pose };
  })().catch((e) => {
    visionPromise = null;
    throw e;
  });
  return visionPromise;
}

/** Gesicht in einem Bildausschnitt suchen (vergrößert auf ~640 px) und die Punkte zurückrechnen. */
function faceInBox(faceLm, canvas, box) {
  const W = canvas.width, H = canvas.height;
  const x0 = Math.max(0, Math.floor(box[0])), y0 = Math.max(0, Math.floor(box[1]));
  const x1 = Math.min(W, Math.ceil(box[2])), y1 = Math.min(H, Math.ceil(box[3]));
  const bw = x1 - x0, bh = y1 - y0;
  if (bw < 8 || bh < 8) return null;
  const s = 640 / Math.max(bw, bh);
  const c = document.createElement('canvas');
  c.width = Math.round(bw * s); c.height = Math.round(bh * s);
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(canvas, x0, y0, bw, bh, 0, 0, c.width, c.height);
  const f = faceLm.detect(c).faceLandmarks?.[0];
  if (!f || f.length < 478) return null;
  return f.map((q) => [x0 + (q.x * c.width) / s, y0 + (q.y * c.height) / s]);
}

/** Kopfbereich aus der Körpererkennung (Nase, Augen, Ohren, Schultern) – als Suchfenster für das Gesicht. */
function headBoxFromPose(p, W, H) {
  const pt = (i) => (p[i] && p[i].v > 0.3 ? [p[i].x, p[i].y] : null);
  const nose = pt(0);
  if (!nose) return null;
  const ears = [pt(7), pt(8)].filter(Boolean), sh = [pt(11), pt(12)].filter(Boolean);
  let size = 0;
  if (ears.length === 2) size = Math.hypot(ears[0][0] - ears[1][0], ears[0][1] - ears[1][1]) * 2.4;
  if (sh.length === 2) size = Math.max(size, Math.hypot(sh[0][0] - sh[1][0], sh[0][1] - sh[1][1]) * 1.1);
  if (!size) size = Math.min(W, H) * 0.25;
  return [nose[0] - size / 2, nose[1] - size * 0.6, nose[0] + size / 2, nose[1] + size * 0.4];
}

/**
 * Gesicht (478 Punkte) und Körper (33 Gelenke) finden – Pixelkoordinaten.
 * faceBox (optional, [x0, y0, x1, y1]): von Hand markierter Gesichtsbereich.
 * Rückgabe: { face: [[x, y], …] | null, pose: [{ x, y, v }, …] | null, faceSource: 'image'|'pose'|'manual'|null }
 */
export async function detectFigure(canvas, { faceBox = null } = {}) {
  const { face, pose } = await vision();
  const W = canvas.width, H = canvas.height;
  const p = pose.detect(canvas).landmarks?.[0];
  const poseOut = p ? p.map((q) => ({ x: q.x * W, y: q.y * H, v: q.visibility ?? 1 })) : null;
  let faceOut = null, faceSource = null;
  if (faceBox) {
    // von Hand markiert: etwas Rand dazu, dann suchen
    const [x0, y0, x1, y1] = faceBox, mx = (x1 - x0) * 0.25, my = (y1 - y0) * 0.25;
    faceOut = faceInBox(face, canvas, [x0 - mx, y0 - my, x1 + mx, y1 + my]);
    if (faceOut) faceSource = 'manual';
  } else {
    const f = face.detect(canvas).faceLandmarks?.[0];
    if (f && f.length >= 478) { faceOut = f.map((q) => [q.x * W, q.y * H]); faceSource = 'image'; }
    // Nur bei Figuren von vorne im Kopfbereich nachsuchen: bei Rückansichten (linke Schulter der Person liegt im
    // Bild links) würde der Detektor sonst im Hinterkopf ein Gesicht „finden“.
    const fromFront = poseOut && poseOut[11].x > poseOut[12].x;
    if (!faceOut && fromFront) {
      const box = headBoxFromPose(poseOut, W, H);
      if (box) {
        for (const grow of [1, 1.6]) {
          const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2, hw = ((box[2] - box[0]) / 2) * grow, hh = ((box[3] - box[1]) / 2) * grow;
          faceOut = faceInBox(face, canvas, [cx - hw, cy - hh, cx + hw, cy + hh]);
          if (faceOut) { faceSource = 'pose'; break; }
        }
      }
    }
  }
  return { face: faceOut, pose: poseOut, faceSource };
}
