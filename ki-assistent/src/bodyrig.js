// Körper-Rig für Bild-Avatare: MediaPipe Pose Landmarker findet einmalig Schultern, Ellbogen, Hände und Hüfte.
// Zur Laufzeit verformt dieselbe Grafikkarten-Verformung wie beim Gesicht (createFaceWarp) das Bild rund um
// diese Punkte: Atmen (Schultern und Brust heben sich), Schulterzucken, aufrechte oder eingesunkene Haltung
// passend zur Stimmung, leichtes Mitschwingen der Arme und kleine Handgesten beim Sprechen. Alles lokal.

// Indizes im MediaPipe-Körpermodell
const IDX = { nose: 0, lShoulder: 11, rShoulder: 12, lElbow: 13, rElbow: 14, lWrist: 15, rWrist: 16, lHip: 23, rHip: 24 };

let poseLandmarker = null;
async function getPose() {
  poseLandmarker ??= (async () => {
    const { PoseLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision');
    const base = new URL('wasm/mediapipe/', location.href).href;
    const fileset = await FilesetResolver.forVisionTasks(base);
    return PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: base + 'pose_landmarker_full.task', delegate: 'CPU' },
      runningMode: 'IMAGE',
      numPoses: 1,
    });
  })().catch((e) => {
    poseLandmarker = null;
    throw e;
  });
  return poseLandmarker;
}

/**
 * Körper im Bild finden. Koordinaten normiert (0..1). Nur gut sichtbare Punkte werden übernommen.
 * @returns {Promise<object|null>} null, wenn keine Schultern zu sehen sind
 */
export async function detectBodyRig(image) {
  const pose = await getPose();
  const pts = pose.detect(image)?.landmarks?.[0];
  if (!pts) return null;
  const P = (i, min = 0.5) => {
    const q = pts[i];
    if (!q || (q.visibility ?? 1) < min || q.x < -0.05 || q.x > 1.05 || q.y < -0.05 || q.y > 1.05) return null;
    return { x: q.x, y: q.y };
  };
  const rig = {
    lShoulder: P(IDX.lShoulder),
    rShoulder: P(IDX.rShoulder),
    lElbow: P(IDX.lElbow, 0.6),
    rElbow: P(IDX.rElbow, 0.6),
    lWrist: P(IDX.lWrist, 0.6),
    rWrist: P(IDX.rWrist, 0.6),
    lHip: P(IDX.lHip, 0.6),
    rHip: P(IDX.rHip, 0.6),
    nose: P(IDX.nose, 0.3),
  };
  if (!rig.lShoulder || !rig.rShoulder) return null;
  // zu schmale Schultern: eher Ganzkörper in weiter Ferne oder Fehlerkennung – dann lieber nichts tun
  if (Math.abs(rig.lShoulder.x - rig.rShoulder.x) < 0.08) return null;
  return rig;
}

/**
 * Anfasser für den aktuellen Moment (Pixel der Quelle).
 * st: { breathe -1..1, shrug 0..1, posture -1 (eingesunken) .. +1 (aufrecht), swing -1..1, gesture 0..1, side -1|1 }
 */
export function bodyHandles(rig, W, H, st) {
  const out = [];
  const px = (p) => ({ x: p.x * W, y: p.y * H });
  const ls = px(rig.lShoulder);
  const rs = px(rig.rShoulder);
  const sw = Math.hypot(ls.x - rs.x, ls.y - rs.y); // Schulterbreite als Maßstab
  const mid = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
  const anchor = (p, r) => out.push({ x: p.x, y: p.y, dx: 0, dy: 0, rx: r, ry: r });
  const b = st.breathe ?? 0;
  // shoulders: false = Schultern bleiben stehen (kein Heben, Zucken, Breiterwerden) – vermeidet Verzerrungen am
  // Schulterrand; Atmen der Brust und Arm-/Handbewegungen bleiben
  const still = st.shoulders === false;
  const lift = still ? 0 : -(b * 0.01 + (st.shrug ?? 0) * 0.045 + (st.posture ?? 0) * 0.014) * sw;
  const open = still ? 0 : (st.posture ?? 0) * 0.005 * sw + b * 0.002 * sw; // aufrecht: Schultern etwas breiter
  // Schultern: heben/senken, bei aufrechter Haltung leicht nach außen
  for (const [s, dir] of [
    [ls, Math.sign(ls.x - mid.x) || 1],
    [rs, Math.sign(rs.x - mid.x) || -1],
  ]) {
    out.push({ x: s.x, y: s.y, dx: dir * open, dy: lift, rx: sw * (still ? 0.22 : 0.3), ry: sw * 0.22 });
  }
  // Brust hebt sich beim Einatmen etwas
  out.push({ x: mid.x, y: mid.y + sw * 0.35, dx: 0, dy: -(b * 0.008 + (st.posture ?? 0) * 0.01) * sw, rx: sw * 0.38, ry: sw * 0.22 });
  // Gesicht hält still (Kopf und Mimik bewegt das Gesichts-Rig bzw. die Kopfbewegung)
  if (rig.nose) anchor(px(rig.nose), sw * 0.2);
  // Arme als Kette Schulter → Ellbogen → Hand: kleine Verschiebungen, dazwischen gemittelte Anfasser,
  // damit sich der Arm als Ganzes bewegt und nirgends ausbeult
  const sw2 = st.swing ?? 0;
  const g = st.gesture ?? 0;
  for (const [s0, e, w, k] of [
    [ls, rig.lElbow, rig.lWrist, 1],
    [rs, rig.rElbow, rig.rWrist, -1],
  ]) {
    const sideG = k === (st.side ?? 1) ? 1 : 0.35; // eine Hand gestikuliert mehr als die andere
    const chain = [{ ...s0, dx: 0, dy: lift }];
    // Mitschwingen: beide Arme in dieselbe Richtung (wie ein leichtes Pendeln), sonst wirkt der Oberkörper aufgebläht
    if (e) chain.push({ ...px(e), dx: sw2 * 0.005 * sw, dy: lift * 0.6 - g * sideG * 0.008 * sw });
    if (e && w) chain.push({ ...px(w), dx: (sw2 * 0.009 + k * g * sideG * 0.004) * sw, dy: lift * 0.3 - g * sideG * 0.022 * sw });
    for (let i = 1; i < chain.length; i++) {
      const a = chain[i - 1];
      const c = chain[i];
      const r = sw * 0.16;
      for (const f of [0.5, 1]) {
        out.push({
          x: a.x + (c.x - a.x) * f,
          y: a.y + (c.y - a.y) * f,
          dx: a.dx + (c.dx - a.dx) * f,
          dy: a.dy + (c.dy - a.dy) * f,
          rx: r,
          ry: r,
        });
      }
    }
  }
  // unten festhalten: Hüfte, sonst der untere Bildrand unter den Schultern
  const hips = [rig.lHip, rig.rHip].filter(Boolean).map(px);
  if (hips.length) hips.forEach((h) => anchor(h, sw * 0.35));
  else {
    const y = Math.min(H, mid.y + sw * 1.1);
    for (const x of [ls.x, mid.x, rs.x]) anchor({ x, y }, sw * 0.3);
  }
  return out;
}
