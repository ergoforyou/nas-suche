"""Freistellen: Vordergrund-Maske aus einem Bild bestimmen."""

from __future__ import annotations

import numpy as np
from PIL import Image, ImageDraw

_SENTINEL = (255, 0, 254)


def compute_mask(img: Image.Image, method: str = "auto", tolerance: int = 40) -> np.ndarray:
    """Return a boolean foreground mask (H x W).

    method:
      auto  - use the alpha channel if the image has real transparency, otherwise "flood"
      alpha - use the alpha channel (alpha > 127)
      flood - flood-fill the background starting from the image border (plain backgrounds)
      rembg - AI background removal with the optional `rembg` package
      none  - the whole image is foreground
    """
    rgba = img.convert("RGBA")
    alpha = np.asarray(rgba)[:, :, 3]

    if method == "auto":
        method = "alpha" if (alpha < 128).mean() > 0.01 else "flood"

    if method == "alpha":
        mask = alpha > 127
    elif method == "flood":
        mask = _flood_mask(rgba, tolerance)
    elif method == "rembg":
        try:
            from rembg import remove  # type: ignore
        except ImportError as exc:  # pragma: no cover - optional dependency
            raise RuntimeError("Für --background rembg bitte 'pip install rembg' ausführen.") from exc
        cut = remove(rgba.convert("RGB"))
        mask = np.asarray(cut.convert("RGBA"))[:, :, 3] > 127
    elif method == "none":
        mask = np.ones(alpha.shape, dtype=bool)
    else:
        raise ValueError(f"Unbekannte Freistell-Methode: {method}")

    if mask.sum() < 100:
        raise RuntimeError("Keine Figur im Bild gefunden (Maske ist leer). Bitte ein PNG mit transparentem Hintergrund verwenden.")
    return mask


def _flood_mask(rgba: Image.Image, tolerance: int) -> np.ndarray:
    """Background = everything connected to the border with a color close to the border color."""
    full_w, full_h = rgba.size
    scale = min(1.0, 1024 / max(full_w, full_h))
    small = rgba.convert("RGB")
    if scale < 1.0:
        small = small.resize((max(1, int(full_w * scale)), max(1, int(full_h * scale))), Image.BILINEAR)
    w, h = small.size
    orig = np.asarray(small).astype(np.int32)
    border = np.concatenate([orig[0], orig[-1], orig[:, 0], orig[:, -1]])
    bg_color = np.median(border, axis=0)

    work = small.copy()
    step = max(1, min(w, h) // 64)
    seeds = [(x, 0) for x in range(0, w, step)] + [(x, h - 1) for x in range(0, w, step)]
    seeds += [(0, y) for y in range(0, h, step)] + [(w - 1, y) for y in range(0, h, step)]
    for sx, sy in seeds:
        if work.getpixel((sx, sy)) == _SENTINEL:
            continue
        if np.abs(orig[sy, sx] - bg_color).sum() > tolerance * 3:
            continue
        ImageDraw.floodfill(work, (sx, sy), _SENTINEL, thresh=tolerance)

    filled = np.all(np.asarray(work) == np.array(_SENTINEL), axis=2)
    was_sentinel = np.all(orig == np.array(_SENTINEL), axis=2)
    mask = ~(filled & ~was_sentinel)
    if scale < 1.0:
        mask_img = Image.fromarray((mask * 255).astype(np.uint8)).resize((full_w, full_h), Image.BILINEAR)
        mask = np.asarray(mask_img) > 127
    # Refine the edge at full resolution: background-coloured pixels in a thin band
    # along the outline are removed (upscaling the mask otherwise leaves a light rim).
    full = np.asarray(rgba.convert("RGB")).astype(np.int32)
    near_bg = np.abs(full - bg_color).sum(-1) <= tolerance * 3
    band = mask & dilate(~mask, max(2, int(round(2 / scale))))
    return mask & ~(band & near_bg)


def dilate(mask: np.ndarray, r: int) -> np.ndarray:
    """Binary dilation with a 4-neighbourhood, r steps."""
    out = mask.copy()
    for _ in range(r):
        p = np.pad(out, 1)
        out = out | p[:-2, 1:-1] | p[2:, 1:-1] | p[1:-1, :-2] | p[1:-1, 2:]
    return out


def bleed_colors(rgb: np.ndarray, mask: np.ndarray, iterations: int = 12, fill_all: bool = True) -> np.ndarray:
    """Spread edge colours into transparent pixels.

    Prevents halos with texture filtering: first a few smooth dilation steps at
    the edge, then (fill_all) every remaining transparent pixel gets the colour
    of the nearest region via a push-pull pyramid, so mipmaps seen at grazing
    angles do not mix in the background colour."""
    out = rgb.astype(np.float32).copy()
    known = mask.astype(bool).copy()
    for _ in range(iterations):
        pk = np.pad(known, 1)
        pc = np.pad(out * known[:, :, None], ((1, 1), (1, 1), (0, 0)))
        acc = pc[:-2, 1:-1] + pc[2:, 1:-1] + pc[1:-1, :-2] + pc[1:-1, 2:]
        cnt = (pk[:-2, 1:-1].astype(np.float32) + pk[2:, 1:-1] + pk[1:-1, :-2] + pk[1:-1, 2:])
        grow = (~known) & (cnt > 0)
        if not grow.any():
            break
        out[grow] = acc[grow] / cnt[grow][:, None]
        known = known | grow
    if fill_all and not known.all() and known.any():
        out = _push_pull(out, known)
    return np.clip(out, 0, 255).astype(np.uint8)


def _push_pull(img: np.ndarray, known: np.ndarray) -> np.ndarray:
    """Fill unknown pixels from coarser, known-weighted averages."""
    if known.all() or min(known.shape) <= 1:
        return img
    h, w = known.shape
    H, W = h + h % 2, w + w % 2
    pi = np.zeros((H, W, img.shape[2]), np.float32)
    pk = np.zeros((H, W), np.float32)
    pi[:h, :w] = img * known[:, :, None]
    pk[:h, :w] = known
    csum = pi.reshape(H // 2, 2, W // 2, 2, -1).sum((1, 3))
    ksum = pk.reshape(H // 2, 2, W // 2, 2).sum((1, 3))
    coarse_known = ksum > 0
    coarse = np.where(coarse_known[:, :, None], csum / np.maximum(ksum, 1e-9)[:, :, None], 0)
    coarse = _push_pull(coarse, coarse_known)
    up = np.repeat(np.repeat(coarse, 2, 0), 2, 1)[:h, :w]
    return np.where(known[:, :, None], img, up)
