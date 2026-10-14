"""Zusätzliche Ansichten: Rückansicht (Textur), Seitenansicht (Körperprofil), Turnaround-Blatt."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from PIL import Image

from .segment import bleed_colors, compute_mask


def _bbox_rows(mask: np.ndarray) -> tuple[int, int]:
    rows = np.nonzero(mask.any(1))[0]
    return int(rows.min()), int(rows.max()) + 1


# ------------------------------------------------------------------ back view

def back_texture(back: Image.Image, front_tex: np.ndarray, background: str = "auto") -> np.ndarray:
    """Align a back view to the front texture.

    The back view is mirrored (so the figure's left side lies where it is in the
    front texture), scaled to the same body height and centred on the body. The
    silhouette of the front is kept; colours come from the back view."""
    rgba = np.asarray(back.convert("RGBA")).copy()
    bmask = compute_mask(back, background)
    rgba[:, :, 3] = np.where(bmask, 255, 0)
    rgba = rgba[:, ::-1]
    bmask = bmask[:, ::-1]

    fmask = front_tex[:, :, 3] > 127
    ft, fb = _bbox_rows(fmask)
    bt, bb = _bbox_rows(bmask)
    s = (fb - ft) / max(1, bb - bt)
    fcx = _center_x(fmask)
    bcx = _center_x(bmask)

    H, W = front_tex.shape[:2]
    # output (x, y) -> input (a x + b y + c, d x + e y + f)
    data = (1 / s, 0, bcx - fcx / s, 0, 1 / s, bt - ft / s)
    warped = np.asarray(Image.fromarray(np.ascontiguousarray(rgba), "RGBA").transform(
        (W, H), Image.AFFINE, data, resample=Image.BILINEAR))
    known = warped[:, :, 3] > 127
    if known.sum() < 50:
        raise RuntimeError("Rückansicht: keine Figur gefunden.")
    rgb = bleed_colors(warped[:, :, :3], known)
    return np.dstack([rgb, front_tex[:, :, 3]])


def _center_x(mask: np.ndarray) -> float:
    """Horizontal body centre: mean of the per-row midpoints in the lower torso / leg area."""
    t, b = _bbox_rows(mask)
    mids = []
    for y in range(int(t + 0.45 * (b - t)), int(t + 0.9 * (b - t))):
        xs = np.nonzero(mask[y])[0]
        if len(xs):
            mids.append((xs.min() + xs.max()) / 2)
    return float(np.median(mids)) if mids else float(np.nonzero(mask)[1].mean())


# ------------------------------------------------------------------ side view

@dataclass
class SideProfile:
    heights: np.ndarray  # world heights (ascending, metres)
    front: np.ndarray    # distance from the body plane to the front surface
    back: np.ndarray     # distance from the body plane to the back surface

    def at(self, y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        return (np.interp(y, self.heights, self.front), np.interp(y, self.heights, self.back))

    @staticmethod
    def average(profiles: list["SideProfile"]) -> "SideProfile":
        hs = profiles[0].heights
        fr = np.mean([np.interp(hs, p.heights, p.front) for p in profiles], 0)
        bk = np.mean([np.interp(hs, p.heights, p.back) for p in profiles], 0)
        return SideProfile(hs, fr, bk)


def guess_facing(mask: np.ndarray) -> str:
    """'right' if the figure looks to the right side of the image (feet point forward)."""
    t, b = _bbox_rows(mask)
    H = b - t
    feet = mask[int(b - 0.04 * H):b]
    ankles = mask[int(b - 0.14 * H):int(b - 0.07 * H)]
    fy, fx = np.nonzero(feet)
    ay, ax = np.nonzero(ankles)
    if len(fx) and len(ax) and abs(fx.mean() - ax.mean()) > 0.004 * H:
        return "right" if fx.mean() > ax.mean() else "left"
    # fallback: the face side of the head usually has more mass in front of the neck
    head = mask[t:int(t + 0.15 * H)]
    neck_row = mask[int(t + 0.16 * H)]
    hy, hx = np.nonzero(head)
    nx = np.nonzero(neck_row)[0]
    if len(hx) and len(nx):
        return "right" if hx.mean() > nx.mean() else "left"
    return "right"


def side_profile(side: Image.Image, height: float, facing: str = "auto", background: str = "auto") -> SideProfile:
    """Depth profile from a side view (left or right). facing: auto | left | right
    (the direction the figure looks in the image)."""
    mask = compute_mask(side, background)
    if facing == "auto":
        facing = guess_facing(mask)
    sgn = 1.0 if facing == "right" else -1.0
    t, b = _bbox_rows(mask)
    H = b - t
    scale = height / H

    rows = np.arange(t, b)
    fr_px = np.full(len(rows), np.nan)
    bk_px = np.full(len(rows), np.nan)
    mid = np.full(len(rows), np.nan)
    for i, y in enumerate(rows):
        xs = np.nonzero(mask[y])[0]
        if len(xs):
            front_edge = xs.max() if sgn > 0 else xs.min()
            back_edge = xs.min() if sgn > 0 else xs.max()
            fr_px[i], bk_px[i] = front_edge, back_edge
            mid[i] = (xs.min() + xs.max()) / 2

    # Body plane: straight line fitted through the midpoints of torso and legs.
    sel = (rows > t + 0.2 * H) & (rows < t + 0.92 * H) & ~np.isnan(mid)
    if sel.sum() > 5:
        a, c = np.polyfit(rows[sel], mid[sel], 1)
    else:
        a, c = 0.0, float(np.nanmedian(mid))
    ref = a * rows + c
    front = np.nan_to_num((fr_px - ref) * sgn * scale, nan=0.0)
    back = np.nan_to_num((ref - bk_px) * sgn * scale, nan=0.0)

    k = max(1, int(0.008 * H))
    kernel = np.ones(2 * k + 1) / (2 * k + 1)
    front = np.convolve(np.pad(front, k, mode="edge"), kernel, "valid")
    back = np.convolve(np.pad(back, k, mode="edge"), kernel, "valid")
    minimum = 0.01 * height
    front, back = np.maximum(front, minimum), np.maximum(back, minimum)

    heights = (b - rows) * scale  # world height of each row (descending)
    return SideProfile(heights[::-1].astype(float), front[::-1], back[::-1])


# ------------------------------------------------------------------ turnaround sheet

def split_sheet(sheet: Image.Image, background: str = "auto") -> list[dict]:
    """Split a turnaround / character sheet into single figures (left to right).

    Returns [{"image": RGBA PIL image, "role": guessed role}], role in front/side/back."""
    rgba = np.asarray(sheet.convert("RGBA")).copy()
    mask = compute_mask(sheet, background)
    H, W = mask.shape
    occ = mask.sum(0) > max(1, 0.002 * H)
    runs, start = [], None
    for x, v in enumerate(np.append(occ, False)):
        if v and start is None:
            start = x
        elif not v and start is not None:
            runs.append([start, x])
            start = None
    # merge runs separated by tiny gaps, drop specks
    merged = []
    for r in runs:
        if merged and r[0] - merged[-1][1] < 0.01 * W:
            merged[-1][1] = r[1]
        else:
            merged.append(r)
    figs = []
    for x0, x1 in merged:
        m = mask[:, x0:x1]
        if m.sum() < 0.05 * mask.sum() / max(1, len(merged)):
            continue
        t, b = _bbox_rows(m)
        pad = int(0.02 * (b - t)) + 2
        y0, y1 = max(0, t - pad), min(H, b + pad)
        xa, xb = max(0, x0 - pad), min(W, x1 + pad)
        crop = rgba[y0:y1, xa:xb].copy()
        crop[:, :, 3] = np.where(mask[y0:y1, xa:xb], 255, 0)
        figs.append({"image": Image.fromarray(crop, "RGBA"), "width": (x1 - x0) / max(1, b - t)})
    if not figs:
        raise RuntimeError("Im Turnaround-Blatt wurden keine Figuren gefunden.")

    # Side views are clearly narrower (relative to their height) than front/back.
    widest = max(f["width"] for f in figs)
    wide = [f for f in figs if f["width"] > 0.72 * widest]
    for f in figs:
        f["role"] = "side"
    if wide:
        wide[0]["role"] = "front"
        if len(wide) > 1:
            wide[-1]["role"] = "back"
    for f in figs:
        del f["width"]
    return figs
