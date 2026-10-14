"""Gesamte Pipeline: Bild(er) -> Maske -> Keypoints -> Rig + Mesh + Mimik -> VRM."""

from __future__ import annotations

import io
from dataclasses import dataclass, field

import numpy as np
from PIL import Image

from . import face, rig
from .keypoints import KEYPOINT_NAMES, detect_keypoints, validate_keypoints
from .segment import bleed_colors, compute_mask, dilate
from .views import SideProfile, back_texture, side_profile
from .vrm import MaterialSpec, MeshSpec, Primitive, write_vrm


@dataclass
class Options:
    height: float = 1.6          # Körpergröße in Metern
    vrm_version: str = "0"       # "0" (VRM 0.x, z.B. VSeeFace) oder "1" (VRM 1.0)
    tpose: bool = True           # Arme waagerecht / Beine senkrecht ausrichten (VRM erwartet T-Pose)
    depth: float = 1.0           # Faktor für die Dicke ("Aufblasen") des Körpers
    grid: int = 140              # Mesh-Auflösung: Zellen über die Körperhöhe
    background: str = "auto"     # auto | alpha | flood | rembg | none
    pose: str = "auto"           # auto | mediapipe | heuristic
    expressions: bool = True     # Blinzeln, Mundformen A/I/U/E/O, fröhlich
    name: str = "Avatar"
    author: str = "bild2vrm"
    max_texture: int = 2048


@dataclass
class Views:
    """Optionale Zusatzansichten derselben Figur."""
    back: Image.Image | None = None
    sides: list[tuple[Image.Image, str]] = field(default_factory=list)  # (Bild, Blickrichtung auto|left|right)


@dataclass
class Result:
    vrm: bytes
    keypoints: dict
    stats: dict = field(default_factory=dict)


class _ToWorld:
    """Pixel (Textur-Bild) -> Welt-2D (Meter, Y oben)."""

    def __init__(self, cx: float, ground_y: float, scale: float):
        self.cx, self.ground_y, self.scale = cx, ground_y, scale

    def __call__(self, px: np.ndarray) -> np.ndarray:
        px = np.asarray(px, dtype=np.float64)
        return np.stack([(px[..., 0] - self.cx) * self.scale, (self.ground_y - px[..., 1]) * self.scale], -1)


def analyze(image: Image.Image, opts: Options) -> tuple[np.ndarray, dict]:
    """Maske und automatisch erkannte Keypoints inkl. Gesichtsboxen (Originalbild-Koordinaten)."""
    mask = compute_mask(image, opts.background)
    kp = detect_keypoints(image, mask, opts.pose)
    kp.update(face.detect_face_boxes(np.asarray(image.convert("RGB")), mask, kp))
    return mask, kp


def cutout_preview(image: Image.Image, mask: np.ndarray) -> Image.Image:
    rgba = np.asarray(image.convert("RGBA")).copy()
    rgba[:, :, 3] = np.where(mask, 255, 0)
    return Image.fromarray(rgba)


def generate(image: Image.Image, opts: Options, keypoints: dict | None = None, views: Views | None = None) -> Result:
    views = views or Views()
    image = image.convert("RGBA")
    mask = compute_mask(image, opts.background)
    if keypoints is None:
        keypoints = detect_keypoints(image, mask, opts.pose)
    keypoints = validate_keypoints(keypoints)
    if opts.expressions and not all(k in keypoints for k in face.FACE_BOXES):
        keypoints.update(face.detect_face_boxes(np.asarray(image.convert("RGB")), mask, keypoints))

    # --- crop to the figure (+ padding) and limit the texture size
    ys, xs = np.nonzero(mask)
    pad = int(0.03 * (ys.max() - ys.min() + 1)) + 2
    x0, y0 = max(0, xs.min() - pad), max(0, ys.min() - pad)
    x1, y1 = min(mask.shape[1], xs.max() + pad + 1), min(mask.shape[0], ys.max() + pad + 1)
    rgba = np.asarray(image)[y0:y1, x0:x1]
    m = mask[y0:y1, x0:x1]
    f = min(1.0, opts.max_texture / max(rgba.shape[:2]))
    kp_px = {k: (np.array(keypoints[k]) - [x0, y0]) * f for k in KEYPOINT_NAMES}
    boxes_px = {k: ((np.array(keypoints[k]).reshape(2, 2) - [x0, y0]) * f).ravel().tolist()
                for k in face.FACE_BOXES if k in keypoints}
    if f < 1.0:
        size = (max(1, round(rgba.shape[1] * f)), max(1, round(rgba.shape[0] * f)))
        rgba = np.asarray(Image.fromarray(rgba).resize(size, Image.LANCZOS))
        m = np.asarray(Image.fromarray(m.astype(np.uint8) * 255).resize(size, Image.BILINEAR)) > 127

    tex = np.dstack([bleed_colors(rgba[:, :, :3], m), np.where(m, 255, 0).astype(np.uint8)])
    # The mesh outline itself follows the silhouette, so the texture may stay opaque a few
    # pixels beyond it. This keeps mipmapped alpha above the cutoff at grazing angles
    # (otherwise the strongly stretched rim shows holes when seen from the side).
    rows = np.nonzero(m.any(1))[0]
    cell = max(2, int(round((rows.max() + 1 - rows.min()) / opts.grid)))
    alpha_wide = np.where(dilate(m, max(3, cell // 2)), 255, 0).astype(np.uint8)
    front_tex = tex.copy()
    front_tex[:, :, 3] = alpha_wide
    materials = [MaterialSpec("Front", _png(Image.fromarray(front_tex, "RGBA")))]
    back_material = 0
    if views.back is not None:
        back = back_texture(views.back, tex, opts.background)
        back[:, :, 3] = alpha_wide
        materials.append(MaterialSpec("Back", _png(Image.fromarray(back, "RGBA"))))
        back_material = 1

    # --- world mapping: feet on the ground, figure height = opts.height
    rows = np.nonzero(m.any(1))[0]
    top_px, ground_px = float(rows.min()), float(rows.max() + 1)
    scale = opts.height / (ground_px - top_px)
    hip_cx = (kp_px["left_hip"][0] + kp_px["right_hip"][0]) / 2
    to_world = _ToWorld(hip_cx, ground_px, scale)
    kp_w = {k: to_world(v) for k, v in kp_px.items()}
    _check_sides(kp_w)

    skel = rig.build_skeleton(kp_w, ground_y=0.0)

    # --- body mesh
    fm = rig.build_front_mesh(m, cell, to_world, skel, opts.height, rig.torso_half_width(m, to_world, kp_px))
    profile = None
    if views.sides:
        profile = SideProfile.average([side_profile(img, opts.height, facing, opts.background)
                                       for img, facing in views.sides])
    z_front, z_back = rig.surface_depth(fm, 0.06 * opts.height / 1.6, opts.depth, profile)
    joints, weights = rig.skin_weights(fm.xy, skel, fm.allowed, opts.height)

    lbs = rig.tpose_transforms(skel) if opts.tpose else None
    xy = rig.apply_lbs(fm.xy, joints, weights, *lbs) if lbs else fm.xy
    rest_heads = lbs[2] if lbs else skel.heads
    dy = -xy[:, 1].min()  # feet back on the ground after straightening
    xy = xy + [0.0, dy]
    rest_heads = rest_heads + [0.0, dy]

    def prim(pos, tris, mat):
        return Primitive(positions=pos, normals=rig.vertex_normals(pos, tris), uvs=fm.uv, indices=tris.astype(np.uint32),
                         joints=joints, weights=weights, material=mat)

    meshes = [MeshSpec("Body", [
        prim(np.column_stack([xy, z_front]), fm.tris, 0),
        prim(np.column_stack([xy, -z_back]), fm.tris[:, ::-1], back_material),
    ])]

    # --- facial expressions
    expressions = {}
    if opts.expressions and len(boxes_px) == len(face.FACE_BOXES):
        tiles = face.build_tiles(tex, boxes_px)
        if tiles.names:
            materials.append(MaterialSpec("Face", _png(Image.fromarray(tiles.atlas, "RGBA"))))
            front_normals = meshes[0].primitives[0].normals
            meshes.append(_face_mesh(tiles, fm, z_front, front_normals, to_world, skel, lbs, dy, opts.height,
                                     len(materials) - 1))
            index = {n: i for i, n in enumerate(tiles.names)}
            for preset, parts in face.EXPRESSIONS.items():
                binds = [(1, index[t], w) for t, w in parts if t in index]
                if binds:
                    expressions[preset] = binds

    bone_pos3 = np.column_stack([rest_heads, np.zeros(len(rest_heads))])
    vrm = write_vrm(meshes=meshes, materials=materials, bone_positions=bone_pos3,
                    thumbnail_png=_thumbnail(rgba, kp_px), version=opts.vrm_version,
                    name=opts.name, author=opts.author, expressions=expressions)
    n_vert = sum(len(p.positions) for mm in meshes for p in mm.primitives)
    n_tri = sum(len(p.indices) for mm in meshes for p in mm.primitives)
    stats = {"vertices": int(n_vert), "triangles": int(n_tri), "texture": f"{tex.shape[1]}x{tex.shape[0]}",
             "bytes": len(vrm), "expressions": sorted(expressions),
             "back_view": views.back is not None, "side_views": len(views.sides)}
    return Result(vrm=vrm, keypoints=keypoints, stats=stats)


def _face_mesh(tiles, fm, z_front, front_normals, to_world, skel, lbs, dy, height, material) -> MeshSpec:
    """Overlay patches for the expression tiles, folded flat until a morph target opens them."""
    n = 8
    body = np.nonzero(fm.part == 0)[0]
    allowed = np.ones(len(rig.BONES), dtype=bool)
    for side in rig.ARM_BONES.values():
        for b in side:
            allowed[rig.BONE_INDEX[b]] = False

    positions, uvs, tris, rest, full_list, normals = [], [], [], [], [], []
    for i, (box, (u0, v0, u1, v1), kind) in enumerate(zip(tiles.boxes, tiles.uv_rects, tiles.kinds)):
        gx, gy = np.meshgrid(np.linspace(box[0], box[2], n + 1), np.linspace(box[1], box[3], n + 1))
        px = np.stack([gx.ravel(), gy.ravel()], 1)
        xy = to_world(px)
        # depth: follow the face surface, slightly in front of it (later tiles on top)
        dist = np.linalg.norm(fm.xy[body][None] - xy[:, None], axis=2)
        near = np.argsort(dist, axis=1)[:, :4]
        z = z_front[body][near].mean(1) + height * (0.0025 + 0.0006 * i)
        # same normals as the face below, so lit shaders (MToon) shade the overlay identically
        nrm = front_normals[body][near].mean(1)
        normals.append(nrm / np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-9))
        j, w = rig.skin_weights(xy, skel, np.tile(allowed, (len(xy), 1)), height)
        if lbs:
            xy = rig.apply_lbs(xy, j, w, *lbs)
        full = np.column_stack([xy + [0.0, dy], z])
        grid = full.reshape(n + 1, n + 1, 3)
        anchor_row = 0 if kind in ("closed", "happy") else n // 2  # eyelid closes from the top, mouth opens from the middle
        folded = np.broadcast_to(grid[anchor_row][None], grid.shape).reshape(-1, 3).copy()
        base = len(np.concatenate(positions)) if positions else 0
        r, c = np.meshgrid(np.arange(n), np.arange(n), indexing="ij")
        tl = (r * (n + 1) + c).ravel() + base
        tris.append(np.concatenate([np.stack([tl, tl + n + 1, tl + n + 2], 1), np.stack([tl, tl + n + 2, tl + 1], 1)]))
        uvs.append(np.stack([u0 + (gx.ravel() - box[0]) / (box[2] - box[0]) * (u1 - u0),
                             v0 + (gy.ravel() - box[1]) / (box[3] - box[1]) * (v1 - v0)], 1))
        positions.append(folded)
        full_list.append((base, full - folded))
        rest.append((j, w))

    pos = np.concatenate(positions)
    targets = []
    for base, delta in full_list:
        t = np.zeros_like(pos)
        t[base:base + len(delta)] = delta
        targets.append(t)
    prim = Primitive(positions=pos, normals=np.concatenate(normals), uvs=np.concatenate(uvs), indices=np.concatenate(tris).astype(np.uint32),
                     joints=np.concatenate([j for j, _ in rest]), weights=np.concatenate([w for _, w in rest]),
                     material=material, targets=targets)
    return MeshSpec("Face", [prim], target_names=list(tiles.names))


def _check_sides(kp_w: dict) -> None:
    """left_* muss im Bild rechts liegen (Frontalansicht). Vertauschte Seiten früh melden."""
    swapped = [j for j in ("shoulder", "hip") if kp_w[f"left_{j}"][0] < kp_w[f"right_{j}"][0]]
    if swapped:
        raise ValueError(
            "Linke/rechte Keypoints scheinen vertauscht zu sein ("
            + ", ".join(swapped)
            + "). 'left_*' ist die linke Körperseite der Figur und liegt bei Frontalansicht im Bild rechts.")


def _thumbnail(rgba: np.ndarray, kp_px: dict) -> bytes:
    top, neck = kp_px["head_top"], kp_px["neck"]
    size = max(16.0, (neck[1] - top[1]) * 1.6)
    cx, cy = top[0], (top[1] + neck[1]) / 2
    box = tuple(int(round(v)) for v in (cx - size / 2, cy - size / 2, cx + size / 2, cy + size / 2))
    img = Image.fromarray(rgba, "RGBA").crop(box).resize((256, 256), Image.LANCZOS)
    bg = Image.new("RGBA", img.size, (235, 238, 245, 255))
    return _png(Image.alpha_composite(bg, img).convert("RGB"))


def _png(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


__all__ = ["Options", "Views", "Result", "generate", "analyze", "cutout_preview", "KEYPOINT_NAMES"]
