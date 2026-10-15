// Gesamte Pipeline: Bild(er) -> Maske -> Keypoints -> Rig + Mesh + Mimik -> VRM (Uint8Array).
import { createImage, cropImage, encodePNG, loadImage, resizeImage, resizeMask } from './image.js';
import { bleedColors, computeMask, dilate } from './segment.js';
import { FACE_BOXES, KEYPOINT_NAMES, heuristicKeypoints, keypointsFromLandmarks, maskBounds, validateKeypoints } from './keypoints.js';
import { buildFaceRig, mouthInteriorTexture } from './facerig.js';
import { EXPRESSIONS, buildTiles, detectFaceBoxes } from './face.js';
import { averageProfiles, backTexture, sideProfile, splitSheet } from './views.js';
import { ARM_BONES, BONES, BONE_INDEX, applyLbs, buildFrontMesh, buildSkeleton, skinWeights, surfaceDepth, torsoHalfWidth, tposeTransforms, vertexNormals } from './rig.js';
import { writeVrm } from './vrm.js';

export { loadImage, splitSheet, KEYPOINT_NAMES, FACE_BOXES };

export const DEFAULT_OPTIONS = {
  height: 1.6,        // Körpergröße in Metern
  vrmVersion: '1',    // '1' (VRM 1.0) oder '0' (VRM 0.x, z. B. VSeeFace)
  tpose: true,        // Arme waagerecht / Beine senkrecht (VRM erwartet T-Pose)
  depth: 1.0,         // Körperdicke-Faktor
  grid: 140,          // Mesh-Auflösung über die Körperhöhe
  background: 'auto', // auto | alpha | flood | none
  expressions: true,  // Blinzeln, Mund A/I/U/E/O, fröhlich
  name: 'Avatar',
  author: 'bild2vrm',
  maxTexture: 2048,
};

/**
 * Maske, Gelenkpunkte und Hinweise (Bildkoordinaten).
 * landmarks (optional, z. B. von MediaPipe): { pose: 33 × {x, y, v}, face: 478 × [x, y] } in Pixeln.
 * Rückgabe: { mask, keypoints, halfBody, armsFree, faceMode: 'landmarks'|'boxes'|'none', warnings }
 */
export function analyze(image, options = {}, landmarks = null) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const mask = computeMask(image, opts.background);
  let kp, halfBody = false, armsFree = true, backView = false;
  if (landmarks?.pose) ({ keypoints: kp, halfBody, armsFree, backView } = keypointsFromLandmarks(landmarks.pose, landmarks.face, mask, image.width, image.height));
  else kp = heuristicKeypoints(mask, image.width, image.height);
  let faceMode = 'none';
  if (landmarks?.face) faceMode = 'landmarks';
  else if (boxFallbackAllowed(landmarks, backView)) {
    const boxes = detectFaceBoxes(image, mask, kp);
    if (Object.keys(boxes).length) { Object.assign(kp, boxes); faceMode = 'boxes'; }
  }
  const warnings = [];
  if (backView) warnings.push('Das ist eine Rückansicht. Bitte als „Rückansicht“ verwenden und eine Frontansicht laden.');
  if (!landmarks?.pose) warnings.push('Körper nur geschätzt (keine Körpererkennung) – Punkte bitte prüfen.');
  if (faceMode === 'none') warnings.push('Kein Gesicht erkannt (z. B. Rückansicht) – die Figur bekommt keine Mimik.');
  if (halfBody) warnings.push('Halbkörperbild – die Figur wird als Brustbild aufgebaut (Beine werden ergänzt, aber nicht angezeigt).');
  if (!armsFree) warnings.push('Arme liegen am oder vor dem Körper – sie bewegen sich mit dem Oberkörper.');
  return { mask, keypoints: kp, halfBody, armsFree, backView, faceMode, warnings };
}

/** Freigestellte Vorschau (Alpha = Maske). */
export function cutout(image, mask) {
  const out = { width: image.width, height: image.height, data: Uint8ClampedArray.from(image.data) };
  for (let i = 0; i < mask.length; i++) out.data[i * 4 + 3] = mask[i] ? 255 : 0;
  return out;
}

class ToWorld {
  constructor(cx, groundY, scale) { Object.assign(this, { cx, groundY, scale }); }
  call(x, y) { return [(x - this.cx) * this.scale, (this.groundY - y) * this.scale]; }
}

/**
 * Avatar erzeugen.
 * image: Frontansicht ({width, height, data}); keypoints: optional (sonst automatisch);
 * views: { back?: Bild, sides?: [{ image, facing: 'auto'|'left'|'right' }] }
 * landmarks: optional MediaPipe-Punkte wie bei analyze() – liefern Gelenke, Halbkörper-Erkennung und das Gesichts-Rig.
 * Rückgabe: { vrm: Uint8Array, keypoints, stats }
 */
export async function generate(image, options = {}, keypoints = null, views = {}, landmarks = null) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const W = image.width, H = image.height;
  const mask = computeMask(image, opts.background);
  const info = landmarks?.pose ? keypointsFromLandmarks(landmarks.pose, landmarks.face, mask, W, H) : null;
  if (info?.backView && !keypoints) throw new Error('Das Bild zeigt die Figur von hinten. Bitte als Rückansicht verwenden und eine Frontansicht laden.');
  const halfBody = opts.halfBody ?? info?.halfBody ?? false;
  const armsFree = opts.armsFree ?? info?.armsFree ?? true;
  if (!keypoints) keypoints = info?.keypoints ?? heuristicKeypoints(mask, W, H);
  keypoints = validateKeypoints(keypoints);
  const faceLm = opts.expressions ? landmarks?.face ?? null : null;
  if (opts.expressions && !faceLm && !FACE_BOXES.every((k) => keypoints[k]) && boxFallbackAllowed(landmarks, info?.backView)) {
    Object.assign(keypoints, detectFaceBoxes(image, mask, keypoints));
  }

  // --- auf die Figur zuschneiden (+ Rand), Texturgröße begrenzen
  const bb = maskBounds(mask, W, H);
  const pad = Math.trunc(0.03 * (bb.bottom - bb.top + 1)) + 2;
  const x0 = Math.max(0, bb.left - pad), y0 = Math.max(0, bb.top - pad);
  const x1 = Math.min(W, bb.right + pad + 1), y1 = Math.min(H, bb.bottom + pad + 1);
  let rgba = cropImage(image, x0, y0, x1, y1);
  let w = x1 - x0, h = y1 - y0;
  let m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y * w + x] = mask[(y + y0) * W + x + x0];
  const f = Math.min(1, opts.maxTexture / Math.max(w, h));
  const kpPx = Object.fromEntries(KEYPOINT_NAMES.map((k) => [k, [(keypoints[k][0] - x0) * f, (keypoints[k][1] - y0) * f]]));
  const boxesPx = Object.fromEntries(FACE_BOXES.filter((k) => keypoints[k]).map((k) => {
    const b = keypoints[k];
    return [k, [(b[0] - x0) * f, (b[1] - y0) * f, (b[2] - x0) * f, (b[3] - y0) * f]];
  }));
  const lmPx = faceLm ? faceLm.map((p) => [(p[0] - x0) * f, (p[1] - y0) * f]) : null;
  if (f < 1) {
    const nw = Math.max(1, Math.round(w * f)), nh = Math.max(1, Math.round(h * f));
    rgba = resizeImage(rgba, nw, nh);
    m = resizeMask(m, w, h, nw, nh);
    w = nw; h = nh;
  }

  const rgb = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) { rgb[i * 3] = rgba.data[i * 4]; rgb[i * 3 + 1] = rgba.data[i * 4 + 1]; rgb[i * 3 + 2] = rgba.data[i * 4 + 2]; }
  const bled = bleedColors(rgb, m, w, h);
  const tex = createImage(w, h);
  for (let i = 0; i < w * h; i++) {
    tex.data[i * 4] = bled[i * 3]; tex.data[i * 4 + 1] = bled[i * 3 + 1]; tex.data[i * 4 + 2] = bled[i * 3 + 2]; tex.data[i * 4 + 3] = m[i] ? 255 : 0;
  }
  // Das Mesh folgt selbst der Silhouette – die Textur darf darüber hinaus deckend bleiben
  // (verhindert Löcher durch gemittelte Mipmaps bei flachem Blickwinkel).
  const mb = maskBounds(m, w, h);
  const cell = Math.max(2, Math.round((mb.bottom + 1 - mb.top) / opts.grid));
  const alphaWide = dilate(m, w, h, Math.max(3, Math.floor(cell / 2)));
  const withAlpha = (img) => { const o = { width: w, height: h, data: Uint8ClampedArray.from(img.data) }; for (let i = 0; i < w * h; i++) o.data[i * 4 + 3] = alphaWide[i] ? 255 : 0; return o; };
  const materials = [{ name: 'Front', png: await encodePNG(withAlpha(tex)) }];
  let backMaterial = 0;
  if (views.back) {
    materials.push({ name: 'Back', png: await encodePNG(withAlpha(backTexture(views.back, tex, opts.background))) });
    backMaterial = 1;
  }

  // --- Weltkoordinaten: Füße auf dem Boden, Figur = opts.height hoch.
  // Halbkörper: Maßstab aus der Kopfhöhe (Scheitel bis Kinn ≈ 13,5 % der Körpergröße), Boden liegt unterhalb des Bildes.
  const topPx = mb.top;
  let groundPx = mb.bottom + 1, scale = opts.height / (groundPx - topPx);
  if (halfBody) {
    const chinPx = lmPx ? lmPx[152][1] : kpPx.neck[1] - 0.2 * (kpPx.neck[1] - kpPx.head_top[1]);
    scale = (0.135 * opts.height) / Math.max(8, chinPx - kpPx.head_top[1]);
    groundPx = topPx + opts.height / scale;
  }
  const hipCx = (kpPx.left_hip[0] + kpPx.right_hip[0]) / 2;
  const tw = new ToWorld(hipCx, groundPx, scale);
  const toWorld = Object.assign((x, y) => tw.call(x, y), { scale });
  const kpW = Object.fromEntries(Object.entries(kpPx).map(([k, v]) => [k, toWorld(v[0], v[1])]));
  checkSides(kpW);
  const skel = buildSkeleton(kpW, 0);

  // --- Körper
  const fm = buildFrontMesh(m, w, h, cell, toWorld, skel, opts.height, torsoHalfWidth(m, w, h, toWorld, kpPx), armsFree);
  const sides = views.sides ?? [];
  const profile = sides.length ? averageProfiles(sides.map((s) => sideProfile(s.image, opts.height, s.facing ?? 'auto', opts.background))) : null;
  const depth = surfaceDepth(fm, (0.06 * opts.height) / 1.6, opts.depth, profile);
  const { joints, weights } = skinWeights(fm.xy, skel, fm.allowed, opts.height);
  const lbs = opts.tpose ? tposeTransforms(skel) : null;
  let xy = lbs ? applyLbs(fm.xy, joints, weights, lbs) : Float64Array.from(fm.xy);
  let minY = Infinity;
  for (let i = 1; i < xy.length; i += 2) minY = Math.min(minY, xy[i]);
  const dy = halfBody ? 0 : -minY; // Halbkörper: Bildunterkante ist kein Boden
  for (let i = 1; i < xy.length; i += 2) xy[i] += dy;
  const restHeads = (lbs ? lbs.newHeads : skel.heads).map((p) => [p[0], p[1] + dy]);

  const nv = fm.d.length;
  const surface = (sign) => {
    const pos = new Float64Array(nv * 3);
    for (let i = 0; i < nv; i++) { pos[3 * i] = xy[2 * i]; pos[3 * i + 1] = xy[2 * i + 1]; pos[3 * i + 2] = sign > 0 ? depth.front[i] : -depth.back[i]; }
    return pos;
  };
  const backTris = Uint32Array.from(fm.tris);
  for (let t = 0; t < backTris.length; t += 3) [backTris[t], backTris[t + 2]] = [backTris[t + 2], backTris[t]];
  const prim = (pos, tris, material) => ({ positions: pos, normals: vertexNormals(pos, tris), uvs: fm.uv, indices: tris, joints, weights, material });
  const frontPrim = prim(surface(1), fm.tris, 0);
  const meshes = [{ name: 'Body', primitives: [frontPrim, prim(surface(-1), backTris, backMaterial)] }];

  // --- Mimik
  const expressions = {};
  let faceMode = 'none';
  if (lmPx) {
    materials.push({ name: 'Mouth', png: await encodePNG(mouthInteriorTexture()) });
    const rig = buildFaceRig({ lm: lmPx, tex, fm, zFront: depth.front, frontNormals: frontPrim.normals, toWorld, skel, lbs, dy,
      height: opts.height, frontMaterial: 0, mouthMaterial: materials.length - 1 });
    if (rig) {
      meshes.push(rig.mesh);
      // Öffnung in der Körper-Vorderseite hinter dem Mund (sonst verdeckt sie den Mundraum)
      const [hx0, hy0, hx1, hy1] = rig.mouthHole, keep = [];
      for (let t = 0; t < fm.tris.length; t += 3) {
        let cx = 0, cy = 0;
        for (let k = 0; k < 3; k++) { cx += fm.uv[2 * fm.tris[t + k]] * w; cy += fm.uv[2 * fm.tris[t + k] + 1] * h; }
        cx /= 3; cy /= 3;
        if (!(cx > hx0 && cx < hx1 && cy > hy0 && cy < hy1)) keep.push(fm.tris[t], fm.tris[t + 1], fm.tris[t + 2]);
      }
      frontPrim.indices = Uint32Array.from(keep);
      faceMode = 'landmarks';
      const index = Object.fromEntries(rig.mesh.targetNames.map((n, i) => [n, i]));
      for (const [preset, parts] of Object.entries(rig.expressions)) expressions[preset] = parts.map(([t, wt]) => [1, index[t], wt]);
    } else materials.pop();
  } else if (opts.expressions && Object.keys(boxesPx).length === FACE_BOXES.length) {
    faceMode = 'boxes';
    const tiles = buildTiles(tex, boxesPx);
    if (tiles.names.length) {
      materials.push({ name: 'Face', png: await encodePNG(tiles.atlas) });
      meshes.push(faceMesh(tiles, fm, depth.front, frontPrim.normals, toWorld, skel, lbs, dy, opts.height, materials.length - 1));
      const index = Object.fromEntries(tiles.names.map((n, i) => [n, i]));
      for (const [preset, parts] of Object.entries(EXPRESSIONS)) {
        const binds = parts.filter(([t]) => t in index).map(([t, wt]) => [1, index[t], wt]);
        if (binds.length) expressions[preset] = binds;
      }
    }
  }

  const vrm = writeVrm({
    meshes, materials, bonePositions: restHeads.map((p) => [p[0], p[1], 0]),
    thumbnailPng: await thumbnail(rgba, kpPx), version: opts.vrmVersion, name: opts.name, author: opts.author, expressions,
  });
  const nVert = meshes.reduce((s, mm) => s + mm.primitives.reduce((a, p) => a + p.positions.length / 3, 0), 0);
  const nTri = meshes.reduce((s, mm) => s + mm.primitives.reduce((a, p) => a + p.indices.length / 3, 0), 0);
  return {
    vrm, keypoints,
    stats: { vertices: nVert, triangles: nTri, texture: `${w}x${h}`, bytes: vrm.length, expressions: Object.keys(expressions).sort(),
      faceMode, halfBody, armsFree,
      backView: !!views.back, sideViews: sides.length },
  };
}

/** Overlays für die Ausdruckskacheln – zusammengefaltet, bis ein Morph-Target sie öffnet. */
function faceMesh(tiles, fm, zFront, frontNormals, toWorld, skel, lbs, dy, height, material) {
  const n = 8, G = (n + 1) * (n + 1);
  const body = [];
  for (let i = 0; i < fm.part.length; i++) if (fm.part[i] === 0) body.push(i);
  const NB = BONES.length;
  const allowedRow = new Uint8Array(NB).fill(1);
  for (const side of Object.values(ARM_BONES)) for (const b of side) allowedRow[BONE_INDEX[b]] = 0;
  const T = tiles.names.length, total = T * G;
  const positions = new Float64Array(total * 3), normals = new Float64Array(total * 3), uvs = new Float64Array(total * 2);
  const joints = new Uint16Array(total * 4), weights = new Float32Array(total * 4), indices = [];
  const targets = [];
  tiles.boxes.forEach((box, ti) => {
    const [u0, v0, u1, v1] = tiles.uvRects[ti], kind = tiles.kinds[ti], base = ti * G;
    const xy = new Float64Array(2 * G), z = new Float64Array(G);
    for (let r = 0; r <= n; r++)
      for (let c = 0; c <= n; c++) {
        const k = r * (n + 1) + c;
        const px = box[0] + ((box[2] - box[0]) * c) / n, py = box[1] + ((box[3] - box[1]) * r) / n;
        const p = toWorld(px, py);
        xy[2 * k] = p[0]; xy[2 * k + 1] = p[1];
        uvs[2 * (base + k)] = u0 + (c / n) * (u1 - u0); uvs[2 * (base + k) + 1] = v0 + (r / n) * (v1 - v0);
        // Tiefe/Normale: wie die Gesichtsfläche darunter (4 nächste Körperpunkte), leicht davor
        const near = nearest4(body, fm.xy, p[0], p[1]);
        z[k] = near.reduce((s, [, i]) => s + zFront[i], 0) / 4 + height * (0.0025 + 0.0006 * ti);
        const nm = [0, 1, 2].map((a) => near.reduce((s, [, i]) => s + frontNormals[3 * i + a], 0) / 4);
        const l = Math.max(Math.hypot(...nm), 1e-9);
        normals.set(nm.map((v) => v / l), 3 * (base + k));
      }
    const sw = skinWeights(xy, skel, (() => { const a = new Uint8Array(G * NB); for (let k = 0; k < G; k++) a.set(allowedRow, k * NB); return a; })(), height);
    joints.set(sw.joints, 4 * base); weights.set(sw.weights, 4 * base);
    const full = lbs ? applyLbs(xy, sw.joints, sw.weights, lbs) : xy;
    const anchorRow = kind === 'closed' || kind === 'happy' ? 0 : n / 2; // Lid schließt von oben, Mund öffnet aus der Mitte
    const delta = new Float64Array(total * 3);
    for (let r = 0; r <= n; r++)
      for (let c = 0; c <= n; c++) {
        const k = r * (n + 1) + c, a = anchorRow * (n + 1) + c;
        const fx = full[2 * k], fy = full[2 * k + 1] + dy, ax = full[2 * a], ay = full[2 * a + 1] + dy;
        positions.set([ax, ay, z[a]], 3 * (base + k));
        delta.set([fx - ax, fy - ay, z[k] - z[a]], 3 * (base + k));
      }
    targets.push(delta);
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++) {
        const tl = base + r * (n + 1) + c;
        indices.push(tl, tl + n + 1, tl + n + 2);
      }
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++) {
        const tl = base + r * (n + 1) + c;
        indices.push(tl, tl + n + 2, tl + 1);
      }
  });
  return {
    name: 'Face', targetNames: [...tiles.names],
    primitives: [{ positions, normals, uvs, indices: Uint32Array.from(indices), joints, weights, material, targets }],
  };
}

/** Die 4 nächsten Punkte (Indizes aus `ids`) zu (x, y) als [[dist, index], …]. */
function nearest4(ids, xy, x, y) {
  const best = [[Infinity, -1], [Infinity, -1], [Infinity, -1], [Infinity, -1]];
  for (const i of ids) {
    const d = Math.hypot(xy[2 * i] - x, xy[2 * i + 1] - y);
    if (d >= best[3][0]) continue;
    let k = 3;
    while (k > 0 && best[k - 1][0] > d) { best[k] = best[k - 1]; k--; }
    best[k] = [d, i];
  }
  return best;
}

/**
 * Ersatz-Erkennung (dunkle Flecken als Augen/Mund) nur für gezeichnete Figuren: wenn keine Erkennung lief oder
 * MediaPipe gar keine Person findet. Erkennt es eine Person, aber kein Gesicht (Profil, Rückansicht, zu klein),
 * gibt es keine Mimik – geratene Augen landen bei Fotos sonst im Haar oder am Ohr.
 */
function boxFallbackAllowed(landmarks, backView) {
  if (backView) return false;
  return !landmarks || !landmarks.pose;
}

function checkSides(kpW) {
  const swapped = ['shoulder', 'hip'].filter((j) => kpW[`left_${j}`][0] < kpW[`right_${j}`][0]);
  if (swapped.length) {
    throw new Error(`Linke/rechte Gelenkpunkte scheinen vertauscht zu sein (${swapped.join(', ')}). `
      + "'left_*' ist die linke Körperseite der Figur und liegt bei Frontalansicht im Bild rechts.");
  }
}

async function thumbnail(rgba, kpPx) {
  const top = kpPx.head_top, neck = kpPx.neck;
  const size = Math.max(16, (neck[1] - top[1]) * 1.6), cx = top[0], cy = (top[1] + neck[1]) / 2;
  const crop = cropImage(rgba, Math.round(cx - size / 2), Math.round(cy - size / 2), Math.round(cx + size / 2), Math.round(cy + size / 2));
  const small = resizeImage(crop, 256, 256);
  for (let i = 0; i < 256 * 256; i++) {
    const a = small.data[i * 4 + 3] / 255, bg = [235, 238, 245];
    for (let c = 0; c < 3; c++) small.data[i * 4 + c] = Math.round(small.data[i * 4 + c] * a + bg[c] * (1 - a));
    small.data[i * 4 + 3] = 255;
  }
  return encodePNG(small, 3);
}
