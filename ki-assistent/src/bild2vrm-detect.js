// Gesichts- und Körpererkennung für „3D-Figur aus Bildern“ (MediaPipe Face/Pose Landmarker, Apache-2.0).
// Laufzeit und Modelle liegen lokal unter wasm/mediapipe/ (siehe build.mjs) – es geht nichts ins Internet.

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

/**
 * Gesicht (478 Punkte) und Körper (33 Gelenke) in einem Bild finden – Pixelkoordinaten.
 * Rückgabe: { face: [[x, y], …] | null, pose: [{ x, y, v }, …] | null }
 */
export async function detectFigure(canvas) {
  const { face, pose } = await vision();
  const W = canvas.width, H = canvas.height;
  const f = face.detect(canvas).faceLandmarks?.[0];
  const p = pose.detect(canvas).landmarks?.[0];
  return {
    face: f && f.length >= 478 ? f.map((q) => [q.x * W, q.y * H]) : null,
    pose: p ? p.map((q) => ({ x: q.x * W, y: q.y * H, v: q.visibility ?? 1 })) : null,
  };
}
