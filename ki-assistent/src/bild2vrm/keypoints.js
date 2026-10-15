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

// ------------------------------------------------------------------ MediaPipe

const POSE = { nose: 0, lShoulder: 11, rShoulder: 12, lElbow: 13, rElbow: 14, lWrist: 15, rWrist: 16,
  lHip: 23, rHip: 24, lKnee: 25, rKnee: 26, lAnkle: 27, rAnkle: 28 };

/**
 * Gelenkpunkte aus MediaPipe-Landmarks (Pixelkoordinaten).
 * pose: 33 Punkte {x, y, v} (v = Sichtbarkeit 0..1), face: 478 Punkte [x, y] oder null.
 * Fehlende Teile (z. B. Beine bei Halbkörperbildern) werden aus Körperproportionen ergänzt.
 * Rückgabe: { keypoints, halfBody, armsFree, chinY }
 */
export function keypointsFromLandmarks(pose, face, mask, w, h) {
  const inImg = (p, m = 0.01) => p.x > -m * w && p.x < w * (1 + m) && p.y > -m * h && p.y < h * (1 + m);
  const vis = (i) => pose[i] && pose[i].v > 0.5 && inImg(pose[i]);
  const P = (i) => [pose[i].x, pose[i].y];
  const ls = P(POSE.lShoulder), rs = P(POSE.rShoulder);
  const midSh = [(ls[0] + rs[0]) / 2, (ls[1] + rs[1]) / 2];
  const shW = Math.max(4, Math.abs(ls[0] - rs[0]));

  // Kopf: Gesichtspunkte, sonst Nase aus der Pose
  const cxHead = face ? face[1][0] : pose[POSE.nose].x;
  const chinY = face ? face[152][1] : pose[POSE.nose].y + 0.35 * shW;
  let top = face ? face[10][1] - 0.3 * (face[152][1] - face[10][1]) : pose[POSE.nose].y - 0.6 * shW;
  const col = Math.min(w - 1, Math.max(0, Math.round(cxHead)));
  for (let y = 0; y < h; y++) {
    let hit = false;
    for (let x = Math.max(0, col - 3); x <= Math.min(w - 1, col + 3); x++) if (mask[y * w + x]) { hit = true; break; }
    if (hit) { top = Math.min(top, y); break; }
  }
  const headPx = Math.max(8, chinY - top);
  const kp = {
    head_top: [cxHead, top],
    neck: [midSh[0], (chinY + midSh[1]) / 2],
    left_shoulder: ls, right_shoulder: rs,
  };

  // Hüfte: sichtbar oder aus den Proportionen (Hüfte ~ 4 Kopfhöhen unter dem Scheitel)
  const hipsVisible = vis(POSE.lHip) && vis(POSE.rHip);
  const hipY = hipsVisible ? (pose[POSE.lHip].y + pose[POSE.rHip].y) / 2 : top + 3.9 * headPx;
  const hipHalf = hipsVisible ? Math.abs(pose[POSE.lHip].x - pose[POSE.rHip].x) / 2 : 0.37 * shW;
  kp.left_hip = hipsVisible ? P(POSE.lHip) : [midSh[0] + hipHalf, hipY];
  kp.right_hip = hipsVisible ? P(POSE.rHip) : [midSh[0] - hipHalf, hipY];

  const legsVisible = vis(POSE.lAnkle) && vis(POSE.rAnkle) && vis(POSE.lKnee) && vis(POSE.rKnee);
  // Halbkörper nur, wenn die Figur am unteren Bildrand abgeschnitten ist; sonst (Beine nicht erkannt, z. B. bei
  // gezeichneten Figuren) kommen Hüfte/Knie/Knöchel aus der Silhouette.
  const { bottom } = maskBounds(mask, w, h);
  const cutOff = bottom >= h - 1 - Math.max(2, 0.01 * h);
  const fromMask = !legsVisible && !cutOff ? heuristicKeypoints(mask, w, h) : null;
  if (fromMask && !hipsVisible) { kp.left_hip = fromMask.left_hip; kp.right_hip = fromMask.right_hip; }
  for (const [side, knee, ankle] of [['left', POSE.lKnee, POSE.lAnkle], ['right', POSE.rKnee, POSE.rAnkle]]) {
    const hip = kp[`${side}_hip`];
    kp[`${side}_knee`] = legsVisible ? P(knee) : fromMask ? fromMask[`${side}_knee`] : [hip[0], top + 5.75 * headPx];
    kp[`${side}_ankle`] = legsVisible ? P(ankle) : fromMask ? fromMask[`${side}_ankle`] : [hip[0], top + 7.35 * headPx];
  }

  // Arme: frei beweglich nur, wenn Ellbogen und Handgelenke sichtbar sind und nicht vor dem Rumpf liegen
  let armsFree = true;
  for (const [side, sh, el, wr] of [['left', POSE.lShoulder, POSE.lElbow, POSE.lWrist], ['right', POSE.rShoulder, POSE.rElbow, POSE.rWrist]]) {
    const sgn = side === 'left' ? 1 : -1;
    if (vis(el) && vis(wr)) {
      kp[`${side}_elbow`] = P(el);
      kp[`${side}_wrist`] = P(wr);
      const torsoEdge = midSh[0] + sgn * 0.42 * shW;
      if (sgn * (pose[wr].x - torsoEdge) < 0 && pose[wr].y > midSh[1]) armsFree = false; // Hand vor dem Körper
    } else {
      armsFree = false;
      const s = P(sh);
      kp[`${side}_elbow`] = [s[0] + sgn * 0.1 * shW, s[1] + 1.3 * headPx];
      kp[`${side}_wrist`] = [s[0] + sgn * 0.15 * shW, s[1] + 2.5 * headPx];
    }
  }
  // Rückansicht: die linke Schulter der Person liegt im Bild links und es gibt kein Gesicht
  const backView = !face && ls[0] < rs[0];
  return { keypoints: kp, halfBody: !legsVisible && cutOff, armsFree, chinY, backView };
}
