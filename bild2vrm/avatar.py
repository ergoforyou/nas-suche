"""Gesamte Pipeline: Bild -> Maske -> Keypoints -> Rig + Mesh -> VRM."""

from __future__ import annotations

import io
from dataclasses import dataclass, field

import numpy as np
from PIL import Image

from . import rig
from .keypoints import KEYPOINT_NAMES, detect_keypoints, validate_keypoints
from .segment import bleed_colors, compute_mask
from .vrm import write_vrm


@dataclass
class Options:
    height: float = 1.6          # Körpergröße in Metern
    vrm_version: str = "0"       # "0" (VRM 0.x, z.B. VSeeFace) oder "1" (VRM 1.0)
    tpose: bool = True           # Arme waagerecht / Beine senkrecht ausrichten (VRM erwartet T-Pose)
    depth: float = 1.0           # Faktor für die Dicke ("Aufblasen") des Körpers
    grid: int = 140              # Mesh-Auflösung: Zellen über die Körperhöhe
    background: str = "auto"     # auto | alpha | flood | rembg | none
    pose: str = "auto"           # auto | mediapipe | heuristic
    name: str = "Avatar"
    author: str = "bild2vrm"
    max_texture: int = 2048


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
    """Maske und automatisch erkannte Keypoints (Originalbild-Koordinaten)."""
    mask = compute_mask(image, opts.background)
    return mask, detect_keypoints(image, mask, opts.pose)


def cutout_preview(image: Image.Image, mask: np.ndarray) -> Image.Image:
    rgba = np.asarray(image.convert("RGBA")).copy()
    rgba[:, :, 3] = np.where(mask, 255, 0)
    return Image.fromarray(rgba)


def generate(image: Image.Image, opts: Options, keypoints: dict | None = None) -> Result:
    image = image.convert("RGBA")
    mask = compute_mask(image, opts.background)
    if keypoints is None:
        keypoints = detect_keypoints(image, mask, opts.pose)
    keypoints = validate_keypoints(keypoints)

    # --- crop to the figure (+ padding) and limit the texture size
    ys, xs = np.nonzero(mask)
    pad = int(0.03 * (ys.max() - ys.min() + 1)) + 2
    x0, y0 = max(0, xs.min() - pad), max(0, ys.min() - pad)
    x1, y1 = min(mask.shape[1], xs.max() + pad + 1), min(mask.shape[0], ys.max() + pad + 1)
    rgba = np.asarray(image)[y0:y1, x0:x1]
    m = mask[y0:y1, x0:x1]
    f = min(1.0, opts.max_texture / max(rgba.shape[:2]))
    kp_px = {k: (np.array(v) - [x0, y0]) * f for k, v in keypoints.items()}
    if f < 1.0:
        size = (max(1, round(rgba.shape[1] * f)), max(1, round(rgba.shape[0] * f)))
        rgba = np.asarray(Image.fromarray(rgba).resize(size, Image.LANCZOS))
        m = np.asarray(Image.fromarray(m.astype(np.uint8) * 255).resize(size, Image.BILINEAR)) > 127

    tex = np.dstack([bleed_colors(rgba[:, :, :3], m), np.where(m, 255, 0).astype(np.uint8)])
    tex_png = _png(Image.fromarray(tex, "RGBA"))

    # --- world mapping: feet on the ground, figure height = opts.height
    rows = np.nonzero(m.any(1))[0]
    top_px, ground_px = float(rows.min()), float(rows.max() + 1)
    scale = opts.height / (ground_px - top_px)
    hip_cx = (kp_px["left_hip"][0] + kp_px["right_hip"][0]) / 2
    to_world = _ToWorld(hip_cx, ground_px, scale)
    kp_w = {k: to_world(v) for k, v in kp_px.items()}
    _check_sides(kp_w)

    skel = rig.build_skeleton(kp_w, ground_y=0.0)

    # --- mesh
    cell = max(2, int(round((ground_px - top_px) / opts.grid)))
    r_torso = rig.torso_half_width(m, to_world, kp_px)
    fm = rig.build_front_mesh(m, cell, to_world, skel, opts.height, r_torso,
                              depth_radius=0.06 * opts.height / 1.6, depth_scale=opts.depth)
    xy, z, uv, tris = fm.xy, fm.z, fm.uv, fm.tris
    joints, weights = rig.skin_weights(xy, skel, fm.allowed, opts.height)

    rest_heads = skel.heads
    if opts.tpose:
        R, old_h, new_h = rig.tpose_transforms(skel)
        xy = rig.apply_lbs(xy, joints, weights, R, old_h, new_h)
        rest_heads = new_h

    # Feet back on the ground after straightening.
    dy = -xy[:, 1].min()
    xy = xy + [0.0, dy]
    rest_heads = rest_heads + [0.0, dy]

    n = len(xy)
    front = np.column_stack([xy, z])
    back = np.column_stack([xy, -z])
    positions = np.concatenate([front, back])
    uvs = np.concatenate([uv, uv])
    indices = np.concatenate([tris, tris[:, ::-1] + n]).astype(np.uint32)
    normals = rig.vertex_normals(positions, indices)
    bone_pos3 = np.column_stack([rest_heads, np.zeros(len(rest_heads))])

    vrm = write_vrm(
        positions=positions, normals=normals, uvs=uvs, indices=indices,
        joints=np.concatenate([joints, joints]), weights=np.concatenate([weights, weights]),
        bone_positions=bone_pos3, texture_png=tex_png,
        thumbnail_png=_thumbnail(rgba, kp_px), version=opts.vrm_version,
        name=opts.name, author=opts.author,
    )
    stats = {"vertices": int(len(positions)), "triangles": int(len(indices)),
             "texture": f"{tex.shape[1]}x{tex.shape[0]}", "bytes": len(vrm)}
    return Result(vrm=vrm, keypoints=keypoints, stats=stats)


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


__all__ = ["Options", "Result", "generate", "analyze", "cutout_preview", "KEYPOINT_NAMES"]
