"""Skelett, aufgeblasenes 2.5D-Mesh, Skinning-Gewichte und T-Pose-Korrektur.

Koordinatensystem hier: VRM-1.0-Konvention (Y oben, Figur schaut nach +Z,
+X = linke Körperseite der Figur = im Bild rechts). Einheit: Meter.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

# (VRM humanoid bone name, parent)
BONES: list[tuple[str, str | None]] = [
    ("hips", None),
    ("spine", "hips"),
    ("chest", "spine"),
    ("upperChest", "chest"),
    ("neck", "upperChest"),
    ("head", "neck"),
    ("leftShoulder", "upperChest"),
    ("leftUpperArm", "leftShoulder"),
    ("leftLowerArm", "leftUpperArm"),
    ("leftHand", "leftLowerArm"),
    ("rightShoulder", "upperChest"),
    ("rightUpperArm", "rightShoulder"),
    ("rightLowerArm", "rightUpperArm"),
    ("rightHand", "rightLowerArm"),
    ("leftUpperLeg", "hips"),
    ("leftLowerLeg", "leftUpperLeg"),
    ("leftFoot", "leftLowerLeg"),
    ("rightUpperLeg", "hips"),
    ("rightLowerLeg", "rightUpperLeg"),
    ("rightFoot", "rightLowerLeg"),
]
BONE_INDEX = {name: i for i, (name, _) in enumerate(BONES)}


@dataclass
class Skeleton:
    heads: np.ndarray  # (B, 2) joint positions
    tails: np.ndarray  # (B, 2) segment end used for weighting


def build_skeleton(kp: dict[str, np.ndarray], ground_y: float) -> Skeleton:
    """Bone heads/tails in 2D world coordinates (from keypoints already in world space)."""
    lerp = lambda a, b, t: a + (b - a) * t  # noqa: E731
    hip_c = (kp["left_hip"] + kp["right_hip"]) / 2
    neck, top = kp["neck"], kp["head_top"]
    pos = {
        "hips": hip_c,
        "spine": lerp(hip_c, neck, 0.30),
        "chest": lerp(hip_c, neck, 0.55),
        "upperChest": lerp(hip_c, neck, 0.78),
        "neck": neck,
        "head": lerp(neck, top, 0.20),
    }
    tail = {
        "hips": pos["spine"], "spine": pos["chest"], "chest": pos["upperChest"],
        "upperChest": neck, "neck": pos["head"], "head": top,
    }
    for side in ("left", "right"):
        sh, el, wr = kp[f"{side}_shoulder"], kp[f"{side}_elbow"], kp[f"{side}_wrist"]
        hp, kn, an = kp[f"{side}_hip"], kp[f"{side}_knee"], kp[f"{side}_ankle"]
        S = side
        pos[f"{S}Shoulder"] = np.array([lerp(neck[0], sh[0], 0.2), lerp(neck[1], sh[1], 0.6)])
        tail[f"{S}Shoulder"] = sh
        pos[f"{S}UpperArm"], tail[f"{S}UpperArm"] = sh, el
        pos[f"{S}LowerArm"], tail[f"{S}LowerArm"] = el, wr
        pos[f"{S}Hand"], tail[f"{S}Hand"] = wr, wr + (wr - el) * 0.35
        pos[f"{S}UpperLeg"], tail[f"{S}UpperLeg"] = hp, kn
        pos[f"{S}LowerLeg"], tail[f"{S}LowerLeg"] = kn, an
        foot_len = max(an[1] - ground_y, 0.04)
        pos[f"{S}Foot"], tail[f"{S}Foot"] = an, an - np.array([0.0, foot_len])
    heads = np.array([pos[n] for n, _ in BONES], dtype=np.float64)
    tails = np.array([tail[n] for n, _ in BONES], dtype=np.float64)
    return Skeleton(heads, tails)


# ------------------------------------------------------------------ mesh

ARM_BONES = {side: [f"{side}UpperArm", f"{side}LowerArm", f"{side}Hand"] for side in ("left", "right")}
_DIAG = np.sqrt(2.0)


@dataclass
class FrontMesh:
    xy: np.ndarray        # (N, 2) world positions
    d: np.ndarray         # (N,) distance to the border of the vertex' part (world units)
    part: np.ndarray      # (N,) 0 = body, 1 = left arm, 2 = right arm
    row: np.ndarray       # (N,) grid row of the vertex
    uv: np.ndarray        # (N, 2)
    tris: np.ndarray      # (M, 3)
    allowed: np.ndarray   # (N, B) bones allowed to influence each vertex


def _border_distance(cells: np.ndarray) -> np.ndarray:
    """Chamfer distance (in cells) of every grid vertex to the border of the cell region."""
    c = np.pad(cells, 1)
    adj = [c[:-1, :-1], c[:-1, 1:], c[1:, :-1], c[1:, 1:]]
    interior = adj[0] & adj[1] & adj[2] & adj[3]
    dist = np.where(interior, 1e9, 0.0)
    for _ in range(sum(cells.shape)):
        p = np.pad(dist, 1)
        cand = np.minimum.reduce([
            dist,
            p[:-2, 1:-1] + 1, p[2:, 1:-1] + 1, p[1:-1, :-2] + 1, p[1:-1, 2:] + 1,
            p[:-2, :-2] + _DIAG, p[:-2, 2:] + _DIAG, p[2:, :-2] + _DIAG, p[2:, 2:] + _DIAG,
        ])
        cand[~interior] = 0.0
        if np.array_equal(cand, dist):
            break
        dist = cand
    return dist


def torso_half_width(mask: np.ndarray, to_world, kp_px: dict) -> float:
    """Half width of the torso (world units) at its narrowest row between chest and hips.

    Measured on the silhouette run through the body center; rows where the arms
    touch the body are wider and therefore ignored by taking the minimum."""
    cx = (kp_px["left_hip"][0] + kp_px["right_hip"][0]) / 2
    y_top = kp_px["neck"][1] + 0.45 * (kp_px["left_hip"][1] - kp_px["neck"][1])
    y_bot = (kp_px["left_hip"][1] + kp_px["right_hip"][1]) / 2
    sh_half = abs(kp_px["left_shoulder"][0] - kp_px["right_shoulder"][0]) / 2
    c = int(np.clip(round(cx), 0, mask.shape[1] - 1))
    widths = []
    for y in range(int(max(0, y_top)), int(min(mask.shape[0], y_bot))):
        row = mask[y]
        if not row[c]:
            continue
        left = c - (np.argmin(row[c::-1]) if not row[:c + 1].all() else c + 1)
        right = c + (np.argmin(row[c:]) if not row[c:].all() else len(row) - c)
        widths.append(max(c - left, right - c))
    half = min(widths) if widths else sh_half
    return float(np.clip(half, 0.6 * sh_half, 1.4 * sh_half)) * to_world.scale


def _classify_cells(centers: np.ndarray, skel: Skeleton, height: float, r_torso: float) -> np.ndarray:
    """Per cell: 0 = body, 1 = left arm, 2 = right arm, -1 = shoulder (joins arm and body)."""
    d = _segment_distance(centers, skel.heads, skel.tails)
    idx = lambda names: [BONE_INDEX[n] for n in names]  # noqa: E731
    r_arm = 0.03 * height
    torso = d[:, idx(["hips", "spine", "chest", "upperChest"])].min(1) - r_torso
    other = d[:, idx(["neck", "head", "leftUpperLeg", "leftLowerLeg", "leftFoot",
                      "rightUpperLeg", "rightLowerLeg", "rightFoot"])].min(1) - r_arm
    group = np.zeros(len(centers), dtype=np.int64)
    arm_l = d[:, idx(ARM_BONES["left"])].min(1) - r_arm
    arm_r = d[:, idx(ARM_BONES["right"])].min(1) - r_arm
    best_body = np.minimum(torso, other)
    group[(arm_l < best_body) & (arm_l <= arm_r)] = 1
    group[(arm_r < best_body) & (arm_r < arm_l)] = 2
    for g, side in ((1, "left"), (2, "right")):
        shoulder = skel.heads[BONE_INDEX[f"{side}UpperArm"]]
        near = np.linalg.norm(centers - shoulder, axis=1) < 2.0 * r_arm
        group[(group == g) & near] = -1
    return group


def _keep_main_arm_parts(group: np.ndarray, cr, cc, rows: int, cols: int) -> np.ndarray:
    """Arm cells not connected to the arm's main piece (incl. shoulder) go back to the body."""
    grid = np.full((rows, cols), -9, dtype=np.int64)
    grid[cr, cc] = group
    for g in (1, 2):
        cells = (grid == g) | (grid == -1)
        seen = np.zeros_like(cells)
        comps = []
        for start in zip(*np.nonzero(grid == g)):
            if seen[start]:
                continue
            stack, comp = [start], []
            seen[start] = True
            while stack:
                y, x = stack.pop()
                comp.append((y, x))
                for ny, nx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
                    if 0 <= ny < rows and 0 <= nx < cols and cells[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        stack.append((ny, nx))
            comps.append(comp)
        comps.sort(key=len, reverse=True)
        for comp in comps[1:]:
            for y, x in comp:
                if grid[y, x] == g:
                    grid[y, x] = 0
    return grid[cr, cc]


def _smooth_labels(group: np.ndarray, cr, cc, rows: int, cols: int, passes: int = 2) -> np.ndarray:
    """3x3 majority filter on the cell labels (removes isolated cells and thin slivers)."""
    labels = (-1, 0, 1, 2)
    for _ in range(passes):
        grid = np.full((rows + 2, cols + 2), 9, dtype=np.int64)
        grid[cr + 1, cc + 1] = group
        counts = np.zeros((len(labels), len(cr)), dtype=np.int64)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                nb = grid[cr + 1 + dy, cc + 1 + dx]
                for k, lab in enumerate(labels):
                    counts[k] += nb == lab
        best = np.array(labels)[counts.argmax(0)]
        group = np.where(counts.max(0) >= 5, best, group)
    return group


def _snap_to_silhouette(px: np.ndarray, border: np.ndarray, mask: np.ndarray, cell: int) -> None:
    """Move border vertices that lie outside the figure onto the nearest figure pixel (in place).

    Grid cells overlap the silhouette by up to one cell; without snapping that
    transparent rim would be stretched over the whole body depth when seen
    from the side."""
    h, w = mask.shape
    r = int(np.ceil(1.5 * cell))
    offs_y, offs_x = np.mgrid[-r:r + 1, -r:r + 1]
    dist = np.hypot(offs_y + 0.5, offs_x + 0.5)
    for i in np.nonzero(border)[0]:
        x, y = int(px[i, 0]), int(px[i, 1])
        if mask[min(y, h - 1), min(x, w - 1)]:
            continue
        ys, xs = y + offs_y, x + offs_x
        valid = (ys >= 0) & (ys < h) & (xs >= 0) & (xs < w)
        hit = np.zeros_like(valid)
        hit[valid] = mask[ys[valid], xs[valid]]
        if not hit.any():
            continue
        k = np.argmin(np.where(hit, dist, np.inf))
        px[i] = (xs.flat[k] + 0.5, ys.flat[k] + 0.5)


def build_front_mesh(mask: np.ndarray, cell: int, to_world, skel: Skeleton, height: float,
                     r_torso: float) -> FrontMesh:
    """Grid mesh over the silhouette.

    Arms are cut loose from the body (except at the shoulder) so that moving
    them into T-pose or animating them does not stretch the torso. For every
    vertex the distance to the border of its part is stored (used for depth)."""
    h, w = mask.shape
    rows, cols = -(-h // cell), -(-w // cell)
    padded = np.zeros((rows * cell, cols * cell), dtype=bool)
    padded[:h, :w] = mask
    covered = padded.reshape(rows, cell, cols, cell).any(axis=(1, 3))

    cr, cc = np.nonzero(covered)
    centers = to_world(np.stack([(cc + 0.5) * cell, (cr + 0.5) * cell], 1))
    group = _classify_cells(centers, skel, height, r_torso)
    group = _smooth_labels(group, cr, cc, rows, cols)
    group = _keep_main_arm_parts(group, cr, cc, rows, cols)

    # Corner vertices of every cell: TL, BL, BR, TR (flat index into the vertex grid).
    W1 = cols + 1
    corners = np.stack([cr * W1 + cc, (cr + 1) * W1 + cc, (cr + 1) * W1 + cc + 1, cr * W1 + cc + 1], 1)
    joint = np.zeros((rows + 1) * W1, dtype=bool)
    joint[corners[group == -1].ravel()] = True
    part = np.where(group > 0, group, 0)
    corner_part = np.where(joint[corners], 0, part[:, None])
    uniq, inv = np.unique(corners * 3 + corner_part, return_inverse=True)
    inv = inv.reshape(-1, 4)
    grid_idx, vpart = uniq // 3, uniq % 3
    tris = np.concatenate([inv[:, [0, 1, 2]], inv[:, [0, 2, 3]]])

    # Depth per part (the cut between arm and body counts as a border).
    d_cells = np.zeros(len(uniq))
    for g in (0, 1, 2):
        cells = np.zeros((rows, cols), dtype=bool)
        sel = (part == g) | (group == -1)
        cells[cr[sel], cc[sel]] = True
        dist = _border_distance(cells).ravel()
        d_cells[vpart == g] = dist[grid_idx[vpart == g]]
    d_world = d_cells * cell * to_world.scale

    vr, vc = grid_idx // W1, grid_idx % W1
    px = np.stack([np.minimum(vc * cell, w), np.minimum(vr * cell, h)], 1).astype(np.float64)
    _snap_to_silhouette(px, d_cells == 0, mask, cell)

    B = len(BONES)
    allowed = np.ones((len(uniq), B), dtype=bool)
    all_arms = [BONE_INDEX[n] for side in ARM_BONES for n in ARM_BONES[side]]
    body_only = (vpart == 0) & ~joint[grid_idx]
    allowed[np.ix_(body_only, all_arms)] = False
    for g, side in ((1, "left"), (2, "right")):
        keep = [BONE_INDEX[n] for n in ARM_BONES[side]]
        rows_g = vpart == g
        allowed[rows_g] = False
        allowed[np.ix_(rows_g, keep)] = True

    return FrontMesh(xy=to_world(px), d=d_world, part=vpart, row=vr, uv=px / np.array([w, h], dtype=np.float64),
                     tris=tris, allowed=allowed)


def surface_depth(fm: FrontMesh, radius: float, scale: float, profile=None) -> tuple[np.ndarray, np.ndarray]:
    """Depth of the front (+z) and back (-z) surface per vertex.

    Without a side profile the body gets a rounded edge of `radius` (constant
    thickness). With a profile (from a side view), body vertices follow an
    elliptic cross-section per grid row whose front/back extent comes from the
    side silhouette at that height."""
    circ = np.where(fm.d < radius, np.sqrt(np.clip(2 * fm.d * radius - fm.d ** 2, 0, None)), radius) * scale
    front, back = circ.copy(), circ.copy()
    if profile is not None:
        body = fm.part == 0
        rows = fm.row[body]
        dmax = np.zeros(rows.max() + 1)
        np.maximum.at(dmax, rows, fm.d[body])
        t = np.clip(fm.d[body] / np.maximum(dmax[rows], 1e-9), 0, 1)
        q = np.sqrt(1 - (1 - t) ** 2)
        f, b = profile.at(fm.xy[body, 1])
        front[body] = f * q * scale
        back[body] = b * q * scale
    return front, back


def _segment_distance(points: np.ndarray, a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Distances (N, B) from points (N,2) to segments a(B,2)-b(B,2)."""
    ab = b - a
    ap = points[:, None, :] - a[None, :, :]
    denom = np.maximum((ab ** 2).sum(-1), 1e-12)
    t = np.clip((ap * ab[None]).sum(-1) / denom[None], 0, 1)
    closest = a[None] + t[..., None] * ab[None]
    return np.linalg.norm(points[:, None, :] - closest, axis=-1)


def skin_weights(points: np.ndarray, skel: Skeleton, allowed: np.ndarray, height: float, sharpness: float = 4.0):
    """Inverse-distance skinning to bone segments (max. 4 influences)."""
    d = _segment_distance(points, skel.heads, skel.tails) / height
    w = np.where(allowed, 1.0 / (d + 0.012) ** sharpness, 0.0)

    order = np.argsort(-w, axis=1)[:, :4]
    top = np.take_along_axis(w, order, axis=1)
    top = top / np.maximum(top.sum(1, keepdims=True), 1e-12)
    top[top < 1e-4] = 0.0
    top = top / top.sum(1, keepdims=True)
    order[top == 0] = 0  # glTF: unused influences must point to joint 0
    return order.astype(np.uint16), top.astype(np.float32)


# ------------------------------------------------------------ T-pose

def _rot(v_from: np.ndarray, v_to: np.ndarray) -> np.ndarray:
    a = np.arctan2(v_to[1], v_to[0]) - np.arctan2(v_from[1], v_from[0])
    c, s = np.cos(a), np.sin(a)
    return np.array([[c, -s], [s, c]])


def tpose_transforms(skel: Skeleton, arms: bool = True, legs: bool = True):
    """Per-bone 2D rigid transforms that move arms horizontal and legs vertical.

    Returns (rotations (B,2,2), old_heads, new_heads)."""
    B = len(BONES)
    R = np.tile(np.eye(2), (B, 1, 1))
    new_heads = skel.heads.copy()
    H, T = skel.heads, skel.tails

    def chain(names, direction, rigid_last=False):
        prev_tail = None
        prev_R = None
        for k, name in enumerate(names):
            i = BONE_INDEX[name]
            if prev_tail is not None:
                new_heads[i] = prev_tail
            if rigid_last and k == len(names) - 1:
                R[i] = prev_R
            else:
                R[i] = _rot(T[i] - H[i], direction)
            prev_tail = new_heads[i] + R[i] @ (T[i] - H[i])
            prev_R = R[i]

    for side, sgn in (("left", 1.0), ("right", -1.0)):
        if arms:
            chain([f"{side}UpperArm", f"{side}LowerArm", f"{side}Hand"], np.array([sgn, 0.0]))
        if legs:
            chain([f"{side}UpperLeg", f"{side}LowerLeg", f"{side}Foot"], np.array([0.0, -1.0]), rigid_last=True)
    return R, H.copy(), new_heads


def apply_lbs(points: np.ndarray, joints: np.ndarray, weights: np.ndarray, R, old_heads, new_heads):
    out = np.zeros_like(points)
    for k in range(4):
        j = joints[:, k].astype(np.int64)
        local = points - old_heads[j]
        moved = np.einsum("nij,nj->ni", R[j], local) + new_heads[j]
        out += weights[:, k:k + 1] * moved
    return out


def vertex_normals(pos: np.ndarray, tris: np.ndarray) -> np.ndarray:
    n = np.zeros_like(pos)
    fn = np.cross(pos[tris[:, 1]] - pos[tris[:, 0]], pos[tris[:, 2]] - pos[tris[:, 0]])
    for k in range(3):
        np.add.at(n, tris[:, k], fn)
    length = np.linalg.norm(n, axis=1, keepdims=True)
    n = np.where(length > 1e-12, n / np.maximum(length, 1e-12), np.array([0.0, 0.0, 1.0]))
    return n
