// Gelenkpunkte (Keypoints) einer stehenden Figur in Frontalansicht schätzen.
// Alle Punkte sind Pixelkoordinaten [x, y]. "left_*" ist die linke Körperseite der Figur
// – bei Frontalansicht im Bild RECHTS.

export const KEYPOINT_NAMES = [
  'head_top', 'neck',
  'left_shoulder', 'right_shoulder',
  'left_elbow', 'right_elbow',
  'left_wrist', 'right_wrist',
  'left_hip', 'right_hip',
  'left_knee', 'right_knee',
  'left_ankle', 'right_ankle',
];
export const FACE_BOXES = ['left_eye_box', 'right_eye_box', 'mouth_box'];

export function validateKeypoints(data) {
  const missing = KEYPOINT_NAMES.filter((k) => !data?.[k]);
  if (missing.length) throw new Error(`Fehlende Keypoints: ${missing.join(', ')}`);
  const out = {};
  for (const k of KEYPOINT_NAMES) out[k] = [Number(data[k][0]), Number(data[k][1])];
  for (const k of FACE_BOXES) {
    if (data[k] == null) continue;
    const b = data[k].map(Number);
    if (b.length !== 4 || b[2] <= b[0] || b[3] <= b[1]) throw new Error(`Ungültige Box für ${k}`);
    out[k] = b;
  }
  return out;
}

/** Zusammenhängende Läufe (start, end inklusiv) einer Zeile der Maske. */
export function runs(mask, w, y) {
  const out = [];
  let start = -1;
  for (let x = 0; x <= w; x++) {
    const v = x < w && mask[y * w + x];
    if (v && start < 0) start = x;
    else if (!v && start >= 0) { out.push([start, x - 1]); start = -1; }
  }
  return out;
}

export function maskBounds(mask, w, h) {
  let top = h, bottom = -1, left = w, right = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (mask[y * w + x]) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
  return { top, bottom, left, right };
}

/** Gelenke aus der Silhouette schätzen (stehende Figur, Frontalansicht). */
export function heuristicKeypoints(mask, w, h) {
  const { top, bottom } = maskBounds(mask, w, h);
  const H = bottom - top + 1;
  const rowAt = (frac) => Math.min(bottom, Math.max(top, Math.round(top + frac * H)));

  // Körpermitte aus der Kopfregion
  let sx = 0, n = 0;
  for (let y = top; y <= Math.floor(top + 0.12 * H); y++)
    for (let x = 0; x < w; x++) if (mask[y * w + x]) { sx += x; n++; }
  let cx;
  if (n) cx = sx / n;
  else {
    let s = 0, c = 0;
    for (let i = 0; i < w * h; i++) if (mask[i]) { s += i % w; c++; }
    cx = s / c;
  }

  const neckY = top + 0.155 * H;
  const shY = rowAt(0.2);
  const ext = runs(mask, w, shY);
  const leftExt = ext.length ? Math.min(...ext.map((r) => r[0])) : cx - 0.1 * H;
  const rightExt = ext.length ? Math.max(...ext.map((r) => r[1])) : cx + 0.1 * H;
  const halfExtent = Math.max(cx - leftExt, rightExt - cx);
  const tpose = halfExtent > 0.3 * H;
  const shHalf = tpose ? 0.1 * H : Math.min(0.11 * H, halfExtent * 0.75);

  const kp = {
    head_top: [cx, top],
    neck: [cx, neckY],
    left_shoulder: [cx + shHalf, shY],
    right_shoulder: [cx - shHalf, shY],
  };

  if (tpose) {
    for (const [side, sgn] of [['left', 1], ['right', -1]]) {
      const reach = sgn > 0 ? rightExt - cx : cx - leftExt;
      kp[`${side}_elbow`] = [cx + sgn * (shHalf + 0.45 * (reach - shHalf)), shY];
      kp[`${side}_wrist`] = [cx + sgn * (reach - 0.06 * H), shY];
    }
  } else {
    for (const [joint, frac, inset] of [['elbow', 0.36, 0.025], ['wrist', 0.5, 0.03]]) {
      const y = rowAt(frac), rs = runs(mask, w, y);
      for (const [side, sgn] of [['left', 1], ['right', -1]]) {
        const def = cx + sgn * (shHalf + (joint === 'elbow' ? 0.015 : 0.03) * H);
        let x = def;
        if (rs.length >= 3) {
          const run = sgn > 0 ? rs[rs.length - 1] : rs[0];
          x = (run[0] + run[1]) / 2;
        } else if (rs.length) {
          const edge = sgn > 0 ? Math.max(...rs.map((r) => r[1])) : Math.min(...rs.map((r) => r[0]));
          const cand = edge - sgn * inset * H;
          if (Math.abs(cand - cx) < Math.abs(def - cx) * 1.6) x = cand;
        }
        kp[`${side}_${joint}`] = [x, y];
      }
    }
  }

  const hipY = top + 0.52 * H, hipHalf = 0.055 * H;
  kp.left_hip = [cx + hipHalf, hipY];
  kp.right_hip = [cx - hipHalf, hipY];
  for (const [joint, frac] of [['knee', 0.74], ['ankle', 0.94]]) {
    const y = rowAt(frac);
    const rs = runs(mask, w, y).filter((r) => Math.abs((r[0] + r[1]) / 2 - cx) < 0.2 * H);
    const lefts = rs.filter((r) => (r[0] + r[1]) / 2 > cx), rights = rs.filter((r) => (r[0] + r[1]) / 2 < cx);
    const lx = lefts.length ? (lefts[0][0] + lefts[0][1]) / 2 : cx + hipHalf * 0.9;
    const rx = rights.length ? (rights[rights.length - 1][0] + rights[rights.length - 1][1]) / 2 : cx - hipHalf * 0.9;
    kp[`left_${joint}`] = [lx, y];
    kp[`right_${joint}`] = [rx, y];
  }
  return kp;
}
