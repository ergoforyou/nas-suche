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
    mask_small = ~(filled & ~was_sentinel)
    if scale < 1.0:
        mask_img = Image.fromarray((mask_small * 255).astype(np.uint8)).resize((full_w, full_h), Image.BILINEAR)
        return np.asarray(mask_img) > 127
    return mask_small


def bleed_colors(rgb: np.ndarray, mask: np.ndarray, iterations: int = 12) -> np.ndarray:
    """Spread edge colors into transparent pixels so texture filtering does not show halos."""
    out = rgb.astype(np.float32).copy()
    known = mask.copy()
    for _ in range(iterations):
        acc = np.zeros_like(out)
        cnt = np.zeros(known.shape, dtype=np.float32)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            shifted_known = np.roll(known, (dy, dx), axis=(0, 1))
            shifted_col = np.roll(out, (dy, dx), axis=(0, 1))
            acc += shifted_col * shifted_known[:, :, None]
            cnt += shifted_known
        grow = (~known) & (cnt > 0)
        if not grow.any():
            break
        out[grow] = acc[grow] / cnt[grow][:, None]
        known = known | grow
    return np.clip(out, 0, 255).astype(np.uint8)
