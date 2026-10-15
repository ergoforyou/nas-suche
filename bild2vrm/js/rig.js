// Skelett, 2.5D-Gittermesh, Skinning-Gewichte und T-Pose-Korrektur.
// Koordinaten: VRM-1.0-Konvention (Y oben, Figur schaut nach +Z, +X = linke Körperseite).
// Punkte in 2D werden als Float64Array [x0, y0, x1, y1, …] gehalten.

export const BONES = [
  ['hips', null], ['spine', 'hips'], ['chest', 'spine'], ['upperChest', 'chest'], ['neck', 'upperChest'], ['head', 'neck'],
  ['leftShoulder', 'upperChest'], ['leftUpperArm', 'leftShoulder'], ['leftLowerArm', 'leftUpperArm'], ['leftHand', 'leftLowerArm'],
  ['rightShoulder', 'upperChest'], ['rightUpperArm', 'rightShoulder'], ['rightLowerArm', 'rightUpperArm'], ['rightHand', 'rightLowerArm'],
  ['leftUpperLeg', 'hips'], ['leftLowerLeg', 'leftUpperLeg'], ['leftFoot', 'leftLowerLeg'],
  ['rightUpperLeg', 'hips'], ['rightLowerLeg', 'rightUpperLeg'], ['rightFoot', 'rightLowerLeg'],
];
export const BONE_INDEX = Object.fromEntries(BONES.map(([n], i) => [n, i]));
export const ARM_BONES = {
  left: ['leftUpperArm', 'leftLowerArm', 'leftHand'],
  right: ['rightUpperArm', 'rightLowerArm', 'rightHand'],
};
const NB = BONES.length;
const SQRT2 = Math.SQRT2;

const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/** Knochenköpfe/-enden (2D, Welt) aus Keypoints in Weltkoordinaten. */
export function buildSkeleton(kp, groundY = 0) {
  const hipC = lerp(kp.left_hip, kp.right_hip, 0.5), neck = kp.neck, top = kp.head_top;
  const pos = {
    hips: hipC, spine: lerp(hipC, neck, 0.3), chest: lerp(hipC, neck, 0.55), upperChest: lerp(hipC, neck, 0.78),
    neck, head: lerp(neck, top, 0.2),
  };
  const tail = { hips: pos.spine, spine: pos.chest, chest: pos.upperChest, upperChest: neck, neck: pos.head, head: top };
  for (const side of ['left', 'right']) {
    const sh = kp[`${side}_shoulder`], el = kp[`${side}_elbow`], wr = kp[`${side}_wrist`];
    const hp = kp[`${side}_hip`], kn = kp[`${side}_knee`], an = kp[`${side}_ankle`];
    pos[`${side}Shoulder`] = [neck[0] + (sh[0] - neck[0]) * 0.2, neck[1] + (sh[1] - neck[1]) * 0.6];
    tail[`${side}Shoulder`] = sh;
    pos[`${side}UpperArm`] = sh; tail[`${side}UpperArm`] = el;
    pos[`${side}LowerArm`] = el; tail[`${side}LowerArm`] = wr;
    pos[`${side}Hand`] = wr; tail[`${side}Hand`] = [wr[0] + (wr[0] - el[0]) * 0.35, wr[1] + (wr[1] - el[1]) * 0.35];
    pos[`${side}UpperLeg`] = hp; tail[`${side}UpperLeg`] = kn;
    pos[`${side}LowerLeg`] = kn; tail[`${side}LowerLeg`] = an;
    const footLen = Math.max(an[1] - groundY, 0.04);
    pos[`${side}Foot`] = an; tail[`${side}Foot`] = [an[0], an[1] - footLen];
  }
  return { heads: BONES.map(([n]) => [...pos[n]]), tails: BONES.map(([n]) => [...tail[n]]) };
}

/** Abstand Punkt -> Strecke a-b */
function segDist(px, py, a, b) {
  const abx = b[0] - a[0], aby = b[1] - a[1];
  const den = Math.max(abx * abx + aby * aby, 1e-12);
  const t = Math.min(1, Math.max(0, ((px - a[0]) * abx + (py - a[1]) * aby) / den));
  return Math.hypot(px - (a[0] + t * abx), py - (a[1] + t * aby));
}

/** Rumpf-Halbbreite (Welt) an der schmalsten Zeile zwischen Brust und Hüfte. */
export function torsoHalfWidth(mask, w, h, toWorld, kp) {
  const cx = (kp.left_hip[0] + kp.right_hip[0]) / 2;
  const yTop = kp.neck[1] + 0.45 * (kp.left_hip[1] - kp.neck[1]);
  const yBot = (kp.left_hip[1] + kp.right_hip[1]) / 2;
  const shHalf = Math.abs(kp.left_shoulder[0] - kp.right_shoulder[0]) / 2;
  const c = Math.min(w - 1, Math.max(0, Math.round(cx)));
  let best = Infinity;
  for (let y = Math.max(0, Math.trunc(yTop)); y < Math.min(h, Math.trunc(yBot)); y++) {
    const row = y * w;
    if (!mask[row + c]) continue;
    let l = c;
    while (l >= 0 && mask[row + l]) l--;
    let r = c;
    while (r < w && mask[row + r]) r++;
    best = Math.min(best, Math.max(c - (l + 1) + 1, r - c));
  }
  const half = Number.isFinite(best) ? best : shHalf;
  return Math.min(1.4 * shHalf, Math.max(0.6 * shHalf, half)) * toWorld.scale;
}

/** Fasen-Distanz (in Zellen) jedes Gitterpunkts zum Rand einer Zellregion. */
function borderDistance(cells, rows, cols) {
  const R = rows + 1, C = cols + 1;
  const cell = (r, c) => (r >= 0 && c >= 0 && r < rows && c < cols ? cells[r * cols + c] : 0);
  const interior = new Uint8Array(R * C);
  const dist = new Float64Array(R * C);
  for (let r = 0; r < R; r++)
    for (let c = 0; c < C; c++) {
      const i = r * C + c;
      interior[i] = cell(r - 1, c - 1) && cell(r - 1, c) && cell(r, c - 1) && cell(r, c) ? 1 : 0;
      dist[i] = interior[i] ? 1e9 : 0;
    }
  const at = (r, c) => (r >= 0 && c >= 0 && r < R && c < C ? dist[r * C + c] : 0);
  for (let it = 0; it < rows + cols; it++) {
    let changed = false;
    const next = Float64Array.from(dist);
    for (let r = 0; r < R; r++)
      for (let c = 0; c < C; c++) {
        const i = r * C + c;
        if (!interior[i]) continue;
        const v = Math.min(dist[i], at(r - 1, c) + 1, at(r + 1, c) + 1, at(r, c - 1) + 1, at(r, c + 1) + 1,
          at(r - 1, c - 1) + SQRT2, at(r - 1, c + 1) + SQRT2, at(r + 1, c - 1) + SQRT2, at(r + 1, c + 1) + SQRT2);
        if (v !== dist[i]) { next[i] = v; changed = true; }
      }
    if (!changed) break;
    dist.set(next);
  }
  return dist;
}

/** Pro Zelle: 0 Körper, 1 linker Arm, 2 rechter Arm, -1 Schulter (verbindet Arm und Körper). */
function classifyCells(centers, skel, height, rTorso) {
  const n = centers.length / 2, rArm = 0.03 * height;
  const idx = (names) => names.map((b) => BONE_INDEX[b]);
  const torsoB = idx(['hips', 'spine', 'chest', 'upperChest']);
  const otherB = idx(['neck', 'head', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot']);
  const lB = idx(ARM_BONES.left), rB = idx(ARM_BONES.right);
  const group = new Int8Array(n);
  const minD = (x, y, bs) => Math.min(...bs.map((b) => segDist(x, y, skel.heads[b], skel.tails[b])));
  const shL = skel.heads[BONE_INDEX.leftUpperArm], shR = skel.heads[BONE_INDEX.rightUpperArm];
  for (let i = 0; i < n; i++) {
    const x = centers[2 * i], y = centers[2 * i + 1];
    const best = Math.min(minD(x, y, torsoB) - rTorso, minD(x, y, otherB) - rArm);
    const al = minD(x, y, lB) - rArm, ar = minD(x, y, rB) - rArm;
    if (al < best && al <= ar) group[i] = 1;
    else if (ar < best && ar < al) group[i] = 2;
    if (group[i] === 1 && Math.hypot(x - shL[0], y - shL[1]) < 2 * rArm) group[i] = -1;
    if (group[i] === 2 && Math.hypot(x - shR[0], y - shR[1]) < 2 * rArm) group[i] = -1;
  }
  return group;
}

/** 3x3-Mehrheitsfilter auf den Zell-Labels. */
function smoothLabels(group, cr, cc, rows, cols, passes = 2) {
  const labels = [-1, 0, 1, 2];
  let g = Int8Array.from(group);
  for (let p = 0; p < passes; p++) {
    const grid = new Int8Array((rows + 2) * (cols + 2)).fill(9);
    for (let i = 0; i < g.length; i++) grid[(cr[i] + 1) * (cols + 2) + cc[i] + 1] = g[i];
    const next = Int8Array.from(g);
    for (let i = 0; i < g.length; i++) {
      const counts = [0, 0, 0, 0];
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const v = grid[(cr[i] + 1 + dy) * (cols + 2) + cc[i] + 1 + dx];
          const k = labels.indexOf(v);
          if (k >= 0) counts[k]++;
        }
      let bi = 0;
      for (let k = 1; k < 4; k++) if (counts[k] > counts[bi]) bi = k;
      if (counts[bi] >= 5) next[i] = labels[bi];
    }
    g = next;
  }
  return g;
}

/** Arm-Zellen, die nicht am Hauptstück (inkl. Schulter) hängen, gehören zum Körper. */
function keepMainArmParts(group, cr, cc, rows, cols) {
  const grid = new Int8Array(rows * cols).fill(-9);
  for (let i = 0; i < group.length; i++) grid[cr[i] * cols + cc[i]] = group[i];
  for (const g of [1, 2]) {
    const seen = new Uint8Array(rows * cols), comps = [];
    for (let s = 0; s < rows * cols; s++) {
      if (grid[s] !== g || seen[s]) continue;
      const stack = [s], comp = [];
      seen[s] = 1;
      while (stack.length) {
        const i = stack.pop(), y = Math.floor(i / cols), x = i % cols;
        comp.push(i);
        for (const [ny, nx] of [[y + 1, x], [y - 1, x], [y, x + 1], [y, x - 1]]) {
          if (ny < 0 || nx < 0 || ny >= rows || nx >= cols) continue;
          const j = ny * cols + nx;
          if (!seen[j] && (grid[j] === g || grid[j] === -1)) { seen[j] = 1; stack.push(j); }
        }
      }
      comps.push(comp);
    }
    comps.sort((a, b) => b.length - a.length);
    for (const comp of comps.slice(1)) for (const i of comp) if (grid[i] === g) grid[i] = 0;
  }
  return Int8Array.from(group, (_, i) => grid[cr[i] * cols + cc[i]]);
}

/** Randpunkte außerhalb der Figur auf das nächste Figurpixel ziehen. */
function snapToSilhouette(px, border, mask, w, h, cell) {
  const r = Math.ceil(1.5 * cell);
  for (let i = 0; i < border.length; i++) {
    if (!border[i]) continue;
    const x = Math.trunc(px[2 * i]), y = Math.trunc(px[2 * i + 1]);
    if (mask[Math.min(y, h - 1) * w + Math.min(x, w - 1)]) continue;
    let best = Infinity, bx = 0, by = 0;
    for (let oy = -r; oy <= r; oy++)
      for (let ox = -r; ox <= r; ox++) {
        const ys = y + oy, xs = x + ox;
        if (ys < 0 || xs < 0 || ys >= h || xs >= w || !mask[ys * w + xs]) continue;
        const d = Math.hypot(oy + 0.5, ox + 0.5);
        if (d < best) { best = d; bx = xs; by = ys; }
      }
    if (Number.isFinite(best)) { px[2 * i] = bx + 0.5; px[2 * i + 1] = by + 0.5; }
  }
}

/**
 * Gittermesh über der Silhouette. Arme werden (außer an der Schulter) vom Körper getrennt.
 * Rückgabe: { xy, d, part, row, uv, tris, allowed }
 */
export function buildFrontMesh(mask, w, h, cell, toWorld, skel, height, rTorso, splitArms = true) {
  const rows = Math.ceil(h / cell), cols = Math.ceil(w / cell);
  const covered = new Uint8Array(rows * cols);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) if (mask[y * w + x]) covered[Math.floor(y / cell) * cols + Math.floor(x / cell)] = 1;
  const crA = [], ccA = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (covered[r * cols + c]) { crA.push(r); ccA.push(c); }
  const nc = crA.length, cr = Int32Array.from(crA), cc = Int32Array.from(ccA);
  const centers = new Float64Array(2 * nc);
  for (let i = 0; i < nc; i++) {
    const p = toWorld((cc[i] + 0.5) * cell, (cr[i] + 0.5) * cell);
    centers[2 * i] = p[0]; centers[2 * i + 1] = p[1];
  }
  // Arme nur abtrennen, wenn sie frei neben dem Körper liegen; sonst bleiben sie fest am Oberkörper.
  let group = new Int8Array(nc);
  if (splitArms) {
    group = classifyCells(centers, skel, height, rTorso);
    group = smoothLabels(group, cr, cc, rows, cols);
    group = keepMainArmParts(group, cr, cc, rows, cols);
  }

  const W1 = cols + 1;
  const corners = new Int32Array(nc * 4);
  for (let i = 0; i < nc; i++) {
    corners[4 * i] = cr[i] * W1 + cc[i];
    corners[4 * i + 1] = (cr[i] + 1) * W1 + cc[i];
    corners[4 * i + 2] = (cr[i] + 1) * W1 + cc[i] + 1;
    corners[4 * i + 3] = cr[i] * W1 + cc[i] + 1;
  }
  const joint = new Uint8Array((rows + 1) * W1);
  for (let i = 0; i < nc; i++) if (group[i] === -1) for (let k = 0; k < 4; k++) joint[corners[4 * i + k]] = 1;
  const part = Int8Array.from(group, (g) => (g > 0 ? g : 0));
  const keys = new Float64Array(nc * 4);
  for (let i = 0; i < nc; i++) for (let k = 0; k < 4; k++) {
    const v = corners[4 * i + k];
    keys[4 * i + k] = v * 3 + (joint[v] ? 0 : part[i]);
  }
  const uniq = Float64Array.from(new Set(keys)).sort();
  const index = new Map();
  uniq.forEach((k, i) => index.set(k, i));
  const inv = Int32Array.from(keys, (k) => index.get(k));
  const nv = uniq.length;
  const gridIdx = Int32Array.from(uniq, (k) => Math.floor(k / 3));
  const vpart = Int8Array.from(uniq, (k) => k % 3);
  const tris = new Uint32Array(nc * 6);
  for (let i = 0; i < nc; i++) {
    tris.set([inv[4 * i], inv[4 * i + 1], inv[4 * i + 2]], 3 * i);
    tris.set([inv[4 * i], inv[4 * i + 2], inv[4 * i + 3]], 3 * (nc + i));
  }

  // Tiefe je Teil (der Schnitt zwischen Arm und Körper zählt als Rand)
  const dCells = new Float64Array(nv);
  for (const g of [0, 1, 2]) {
    const cells = new Uint8Array(rows * cols);
    for (let i = 0; i < nc; i++) if (part[i] === g || group[i] === -1) cells[cr[i] * cols + cc[i]] = 1;
    const dist = borderDistance(cells, rows, cols);
    for (let v = 0; v < nv; v++) if (vpart[v] === g) dCells[v] = dist[gridIdx[v]];
  }
  const d = Float64Array.from(dCells, (x) => x * cell * toWorld.scale);
  const row = Int32Array.from(gridIdx, (gi) => Math.floor(gi / W1));
  const px = new Float64Array(2 * nv);
  for (let v = 0; v < nv; v++) {
    px[2 * v] = Math.min((gridIdx[v] % W1) * cell, w);
    px[2 * v + 1] = Math.min(row[v] * cell, h);
  }
  snapToSilhouette(px, Uint8Array.from(dCells, (x) => (x === 0 ? 1 : 0)), mask, w, h, cell);

  const allowed = new Uint8Array(nv * NB).fill(1);
  const allArms = [...ARM_BONES.left, ...ARM_BONES.right].map((b) => BONE_INDEX[b]);
  for (let v = 0; v < nv; v++) {
    if (vpart[v] === 0 && !joint[gridIdx[v]]) for (const b of allArms) allowed[v * NB + b] = 0;
    else if (vpart[v] > 0) {
      const keep = ARM_BONES[vpart[v] === 1 ? 'left' : 'right'].map((b) => BONE_INDEX[b]);
      for (let b = 0; b < NB; b++) allowed[v * NB + b] = keep.includes(b) ? 1 : 0;
    }
  }
  const xy = new Float64Array(2 * nv), uv = new Float64Array(2 * nv);
  for (let v = 0; v < nv; v++) {
    const p = toWorld(px[2 * v], px[2 * v + 1]);
    xy[2 * v] = p[0]; xy[2 * v + 1] = p[1];
    uv[2 * v] = px[2 * v] / w; uv[2 * v + 1] = px[2 * v + 1] / h;
  }
  return { xy, d, part: vpart, row, uv, tris, allowed };
}

/** Tiefe von Vorder- (+z) und Rückseite (−z) je Vertex; mit Seitenprofil elliptischer Querschnitt. */
export function surfaceDepth(fm, radius, scale, profile = null, head = null) {
  const n = fm.d.length, front = new Float64Array(n), back = new Float64Array(n);
  const circ = (d, r) => (d < r ? Math.sqrt(Math.max(0, 2 * d * r - d * d)) : r);
  for (let i = 0; i < n; i++) {
    const d = fm.d[i];
    let z = circ(d, radius);
    // Kopf: ohne Seitenansicht deutlich runder und tiefer als der Rumpf (Kopf ist etwa so tief wie breit),
    // weicher Übergang am Hals
    if (head && fm.part[i] === 0) {
      const t = Math.min(1, Math.max(0, (fm.xy[2 * i + 1] - head.neckY) / Math.max(1e-6, head.blend)));
      if (t > 0) z = z + t * (circ(d, head.radius) * head.factor - z);
    }
    z *= scale;
    front[i] = z; back[i] = z;
  }
  if (profile) {
    let maxRow = 0;
    for (let i = 0; i < n; i++) if (fm.part[i] === 0) maxRow = Math.max(maxRow, fm.row[i]);
    const dmax = new Float64Array(maxRow + 1);
    for (let i = 0; i < n; i++) if (fm.part[i] === 0) dmax[fm.row[i]] = Math.max(dmax[fm.row[i]], fm.d[i]);
    for (let i = 0; i < n; i++) {
      if (fm.part[i] !== 0) continue;
      const t = Math.min(1, Math.max(0, fm.d[i] / Math.max(dmax[fm.row[i]], 1e-9)));
      const q = Math.sqrt(1 - (1 - t) ** 2);
      const [f, b] = profile.at(fm.xy[2 * i + 1]);
      front[i] = f * q * scale; back[i] = b * q * scale;
    }
  }
  return { front, back };
}

/** Inverse-Distanz-Skinning zu Knochensegmenten (max. 4 Einflüsse). */
export function skinWeights(points, skel, allowed, height, sharpness = 4) {
  const n = points.length / 2;
  const joints = new Uint16Array(4 * n), weights = new Float32Array(4 * n);
  const w = new Float64Array(NB), order = [...Array(NB).keys()];
  for (let i = 0; i < n; i++) {
    const x = points[2 * i], y = points[2 * i + 1];
    for (let b = 0; b < NB; b++) {
      w[b] = allowed && !allowed[i * NB + b] ? 0 : 1 / (segDist(x, y, skel.heads[b], skel.tails[b]) / height + 0.012) ** sharpness;
    }
    order.sort((a, b) => w[b] - w[a]);
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += w[order[k]];
    const top = [0, 1, 2, 3].map((k) => w[order[k]] / Math.max(sum, 1e-12)).map((v) => (v < 1e-4 ? 0 : v));
    const s2 = top.reduce((a, b) => a + b, 0);
    for (let k = 0; k < 4; k++) {
      const v = top[k] / s2;
      weights[4 * i + k] = v;
      joints[4 * i + k] = v === 0 ? 0 : order[k];
    }
  }
  return { joints, weights };
}

function rot(from, to) {
  const a = Math.atan2(to[1], to[0]) - Math.atan2(from[1], from[0]);
  return [Math.cos(a), -Math.sin(a), Math.sin(a), Math.cos(a)];
}

/** Starre 2D-Transformationen je Knochen: Arme waagerecht, Beine senkrecht. */
export function tposeTransforms(skel, arms = true, legs = true) {
  const R = BONES.map(() => [1, 0, 0, 1]);
  const newHeads = skel.heads.map((p) => [...p]);
  const H = skel.heads, T = skel.tails;
  const chain = (names, dir, rigidLast = false) => {
    let prevTail = null, prevR = null;
    names.forEach((name, k) => {
      const i = BONE_INDEX[name];
      if (prevTail) newHeads[i] = prevTail;
      R[i] = rigidLast && k === names.length - 1 ? prevR : rot([T[i][0] - H[i][0], T[i][1] - H[i][1]], dir);
      const vx = T[i][0] - H[i][0], vy = T[i][1] - H[i][1], m = R[i];
      prevTail = [newHeads[i][0] + m[0] * vx + m[1] * vy, newHeads[i][1] + m[2] * vx + m[3] * vy];
      prevR = R[i];
    });
  };
  for (const [side, sgn] of [['left', 1], ['right', -1]]) {
    if (arms) chain([`${side}UpperArm`, `${side}LowerArm`, `${side}Hand`], [sgn, 0]);
    if (legs) chain([`${side}UpperLeg`, `${side}LowerLeg`, `${side}Foot`], [0, -1], true);
  }
  return { R, oldHeads: H.map((p) => [...p]), newHeads };
}

export function applyLbs(points, joints, weights, t) {
  const n = points.length / 2, out = new Float64Array(points.length);
  for (let i = 0; i < n; i++) {
    let x = 0, y = 0;
    for (let k = 0; k < 4; k++) {
      const wgt = weights[4 * i + k];
      if (!wgt) continue;
      const j = joints[4 * i + k], m = t.R[j], o = t.oldHeads[j], nh = t.newHeads[j];
      const lx = points[2 * i] - o[0], ly = points[2 * i + 1] - o[1];
      x += wgt * (m[0] * lx + m[1] * ly + nh[0]);
      y += wgt * (m[2] * lx + m[3] * ly + nh[1]);
    }
    out[2 * i] = x; out[2 * i + 1] = y;
  }
  return out;
}

export function vertexNormals(pos, tris) {
  const n = new Float64Array(pos.length);
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    for (const i of [a, b, c]) { n[i] += fx; n[i + 1] += fy; n[i + 2] += fz; }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]);
    if (l > 1e-12) { n[i] /= l; n[i + 1] /= l; n[i + 2] /= l; } else { n[i] = 0; n[i + 1] = 0; n[i + 2] = 1; }
  }
  return n;
}
