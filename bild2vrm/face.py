"""Gesichtsausdrücke: Augen-/Mund-Erkennung und Ausdrucks-Kacheln.

Prinzip: Über Augen und Mund liegen kleine, dem Gesicht folgende Flächen
("Overlays"). Jede zeigt einen Zustand (Auge zu, Mund offen "A" …), der aus dem
Bild selbst erzeugt wird: Das Original-Merkmal wird mit Hautfarbe übermalt und
die neue Form gezeichnet. Im Ruhezustand sind die Flächen auf eine Linie
zusammengefaltet und unsichtbar; ein Morph-Target klappt sie auf – beim Auge
von oben nach unten wie ein Lid, beim Mund von der Mitte aus.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageDraw

from .segment import bleed_colors

FACE_BOXES = ["left_eye_box", "right_eye_box", "mouth_box"]

# (tile name, region, kind)  kind: closed / happy for eyes, vowel for the mouth
TILES = [
    ("blinkLeft", "left_eye_box", "closed"),
    ("blinkRight", "right_eye_box", "closed"),
    ("happyLeft", "left_eye_box", "happy"),
    ("happyRight", "right_eye_box", "happy"),
    ("aa", "mouth_box", "a"),
    ("ih", "mouth_box", "i"),
    ("ou", "mouth_box", "u"),
    ("ee", "mouth_box", "e"),
    ("oh", "mouth_box", "o"),
]
# VRM 1.0 expression presets built from the tiles: preset -> [(tile, weight)]
EXPRESSIONS = {
    "blink": [("blinkLeft", 1.0), ("blinkRight", 1.0)],
    "blinkLeft": [("blinkLeft", 1.0)],
    "blinkRight": [("blinkRight", 1.0)],
    "happy": [("happyLeft", 1.0), ("happyRight", 1.0), ("ee", 1.0)],
    "relaxed": [("happyLeft", 1.0), ("happyRight", 1.0)],
    "aa": [("aa", 1.0)], "ih": [("ih", 1.0)], "ou": [("ou", 1.0)], "ee": [("ee", 1.0)], "oh": [("oh", 1.0)],
}
# Mouth opening (width, height) relative to the mouth box
VOWELS = {"a": (0.55, 0.62), "i": (0.62, 0.22), "u": (0.26, 0.30), "e": (0.52, 0.36), "o": (0.36, 0.50)}


# ------------------------------------------------------------------ detection

def _components(mask: np.ndarray) -> list[np.ndarray]:
    """4-connected components of a small boolean array as lists of (y, x)."""
    seen = np.zeros_like(mask)
    comps = []
    h, w = mask.shape
    for start in zip(*np.nonzero(mask)):
        if seen[start]:
            continue
        stack, comp = [start], []
        seen[start] = True
        while stack:
            y, x = stack.pop()
            comp.append((y, x))
            for ny, nx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
                if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    stack.append((ny, nx))
        comps.append(np.array(comp))
    return comps


def _clip_box(box, w, h):
    x0, y0, x1, y1 = box
    return [float(np.clip(x0, 0, w - 1)), float(np.clip(y0, 0, h - 1)),
            float(np.clip(x1, 1, w)), float(np.clip(y1, 1, h))]


def detect_face_boxes(rgb: np.ndarray, mask: np.ndarray, kp: dict) -> dict:
    """Boxes [x0, y0, x1, y1] for both eyes and the mouth (image pixel coordinates).

    Looks for dark/contrasting blobs in the face; falls back to typical proportions."""
    h_img, w_img = mask.shape
    top, neck = np.array(kp["head_top"], float), np.array(kp["neck"], float)
    hh = max(8.0, neck[1] - top[1])
    cx = (top[0] + neck[0]) / 2
    eye_row = int(np.clip(top[1] + 0.58 * hh, 0, h_img - 1))
    cols = np.nonzero(mask[eye_row])[0]
    near = cols[np.abs(cols - cx) < 0.9 * hh] if len(cols) else cols
    head_w = float(near.max() - near.min() + 1) if len(near) > 4 else 0.75 * hh
    head_w = float(np.clip(head_w, 0.45 * hh, 1.2 * hh))

    ew, eh = 0.24 * head_w, 0.17 * hh
    mw, mh = 0.30 * head_w, 0.15 * hh
    boxes = {
        "left_eye_box": [cx + 0.2 * head_w - ew / 2, top[1] + 0.58 * hh - eh / 2, cx + 0.2 * head_w + ew / 2, top[1] + 0.58 * hh + eh / 2],
        "right_eye_box": [cx - 0.2 * head_w - ew / 2, top[1] + 0.58 * hh - eh / 2, cx - 0.2 * head_w + ew / 2, top[1] + 0.58 * hh + eh / 2],
        "mouth_box": [cx - mw / 2, top[1] + 0.84 * hh - mh / 2, cx + mw / 2, top[1] + 0.84 * hh + mh / 2],
    }

    # Skin colour: median of the lower-middle face
    sy0, sy1 = int(top[1] + 0.62 * hh), int(top[1] + 0.8 * hh)
    sx0, sx1 = int(cx - 0.22 * head_w), int(cx + 0.22 * head_w)
    region = rgb[max(0, sy0):max(1, sy1), max(0, sx0):max(1, sx1)].reshape(-1, 3)
    region_m = mask[max(0, sy0):max(1, sy1), max(0, sx0):max(1, sx1)].reshape(-1)
    if region_m.sum() < 10:
        return {k: _clip_box(v, w_img, h_img) for k, v in boxes.items()}
    skin = np.median(region[region_m], axis=0)

    def blob(x0, y0, x1, y1, thresh, prefer_x):
        x0, y0, x1, y1 = (int(round(v)) for v in _clip_box([x0, y0, x1, y1], w_img, h_img))
        if x1 - x0 < 4 or y1 - y0 < 4:
            return None
        patch = rgb[y0:y1, x0:x1].astype(np.int32)
        feat = (np.abs(patch - skin).sum(-1) > thresh) & mask[y0:y1, x0:x1]
        step = max(1, int(max(feat.shape) / 60))
        small = feat[::step, ::step]
        best, best_score = None, 0.0
        for comp in _components(small):
            if len(comp) < 3:
                continue
            ys, xs = comp[:, 0], comp[:, 1]
            if ys.min() == 0 and len(comp) > 0.15 * small.size:
                continue  # touches the top and is large: hair / bangs
            if ys.max() - ys.min() > 0.8 * small.shape[0]:
                continue
            cxc = xs.mean() * step + x0
            score = len(comp) / (1.0 + abs(cxc - prefer_x) / max(1.0, x1 - x0))
            if score > best_score:
                best_score, best = score, comp
        if best is None:
            return None
        ys, xs = best[:, 0] * step + y0, best[:, 1] * step + x0
        return [xs.min(), ys.min(), xs.max() + step, ys.max() + step]

    for key, sgn in (("left_eye_box", 1), ("right_eye_box", -1)):
        lo, hi = (cx + 0.04 * head_w, cx + 0.48 * head_w) if sgn > 0 else (cx - 0.48 * head_w, cx - 0.04 * head_w)
        b = blob(lo, top[1] + 0.32 * hh, hi, top[1] + 0.8 * hh, 110, cx + sgn * 0.2 * head_w)
        if b:
            bw, bh = b[2] - b[0], b[3] - b[1]
            bw, bh = np.clip(bw * 1.35, 0.6 * ew, 1.7 * ew), np.clip(bh * 1.5, 0.6 * eh, 1.9 * eh)
            c = ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)
            boxes[key] = [c[0] - bw / 2, c[1] - bh / 2, c[0] + bw / 2, c[1] + bh / 2]

    eye_bottom = max(boxes["left_eye_box"][3], boxes["right_eye_box"][3])
    b = blob(cx - 0.25 * head_w, eye_bottom + 0.05 * hh, cx + 0.25 * head_w, neck[1] - 0.02 * hh, 70, cx)
    if b:
        c = ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)
        bw = np.clip((b[2] - b[0]) * 1.6, 0.7 * mw, 1.6 * mw)
        bh = np.clip((b[3] - b[1]) * 2.5, 0.8 * mh, 1.8 * mh)
        boxes["mouth_box"] = [c[0] - bw / 2, c[1] - bh / 2, c[0] + bw / 2, c[1] + bh / 2]
    return {k: [float(v) for v in _clip_box(b, w_img, h_img)] for k, b in boxes.items()}


# ------------------------------------------------------------------ tiles

def _skin_fill(patch: np.ndarray, alpha: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Paint over facial features with the surrounding skin. Returns (filled rgb, feature mask)."""
    h, w = patch.shape[:2]
    border = np.concatenate([patch[0], patch[-1], patch[:, 0], patch[:, -1]]).astype(np.int32)
    skin = np.median(border, axis=0)
    diff = np.abs(patch.astype(np.int32) - skin).sum(-1)
    feature = (diff > 60) & alpha
    # Features reaching the patch border (hair, face outline) stay untouched.
    step = max(1, int(max(h, w) / 80))
    small = feature[::step, ::step]
    for comp in _components(small):
        ys, xs = comp[:, 0], comp[:, 1]
        if ys.min() == 0 or xs.min() == 0 or ys.max() == small.shape[0] - 1 or xs.max() == small.shape[1] - 1:
            for y, x in comp:
                feature[y * step:(y + 1) * step, x * step:(x + 1) * step] = False
    # grow slightly so anti-aliased outlines disappear too
    grown = feature.copy()
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        grown |= np.roll(feature, (dy, dx), axis=(0, 1))
    grown[0], grown[-1], grown[:, 0], grown[:, -1] = False, False, False, False
    filled = bleed_colors(patch, ~grown, iterations=max(h, w))
    return filled, feature


def _dark_color(patch: np.ndarray, feature: np.ndarray) -> tuple[int, int, int]:
    px = patch[feature] if feature.sum() > 3 else patch.reshape(-1, 3)
    lum = px.astype(np.int32).sum(-1)
    dark = px[lum <= np.percentile(lum, 15)]
    return tuple(int(v) for v in dark.mean(0)) if len(dark) else (40, 30, 30)


def make_tile(patch_rgba: np.ndarray, kind: str) -> np.ndarray:
    """Expression image for one region (same size as the input patch)."""
    rgb, alpha = patch_rgba[:, :, :3], patch_rgba[:, :, 3] > 127
    h, w = rgb.shape[:2]
    filled, feature = _skin_fill(rgb, alpha)
    line = _dark_color(rgb, feature)
    ss = 4
    img = Image.fromarray(filled).resize((w * ss, h * ss), Image.BILINEAR)
    d = ImageDraw.Draw(img)
    W, H = w * ss, h * ss
    if kind in ("closed", "happy"):
        thick = max(ss * 2, int(0.09 * H))
        xs = np.linspace(0.12 * W, 0.88 * W, 24)
        t = (xs - W / 2) / (0.38 * W)
        if kind == "closed":
            ys = 0.52 * H + 0.10 * H * (t ** 2) * -1 + 0.10 * H  # gentle downward curve ‿
        else:
            ys = 0.62 * H - 0.22 * H * (1 - t ** 2)  # arch ^
        d.line(list(zip(xs.tolist(), ys.tolist())), fill=line, width=thick, joint="curve")
    else:
        rw, rh = VOWELS[kind]
        ew, eh = rw * W / 2, rh * H / 2
        inner = tuple(int(c * 0.55) for c in line) if sum(line) > 150 else (70, 22, 30)
        inner = (max(inner[0], 60), inner[1], inner[2])
        d.ellipse([W / 2 - ew, H / 2 - eh, W / 2 + ew, H / 2 + eh], fill=inner, outline=line, width=max(ss, int(0.05 * H)))
        if kind in ("a", "o"):
            tw, th = ew * 0.6, eh * 0.45
            d.ellipse([W / 2 - tw, H / 2 + eh - 2 * th, W / 2 + tw, H / 2 + eh - 2], fill=(200, 90, 100))
        if kind in ("a", "e", "i"):
            d.rectangle([W / 2 - ew * 0.65, H / 2 - eh + ss, W / 2 + ew * 0.65, H / 2 - eh + max(ss * 2, eh * 0.28)], fill=(250, 250, 250))
    out = np.asarray(img.resize((w, h), Image.LANCZOS))
    return np.dstack([out, patch_rgba[:, :, 3]])


@dataclass
class FaceTiles:
    atlas: np.ndarray          # RGBA atlas image
    names: list[str]           # tile names (= morph target names)
    boxes: list[list[float]]   # source box per tile (texture px)
    uv_rects: list[tuple[float, float, float, float]]  # u0, v0, u1, v1 inside the atlas
    kinds: list[str]


def build_tiles(tex: np.ndarray, boxes: dict) -> FaceTiles:
    """Cut the regions out of the texture and render one tile per expression."""
    h_img, w_img = tex.shape[:2]
    imgs, names, srcs, kinds = [], [], [], []
    for name, region, kind in TILES:
        x0, y0, x1, y1 = (int(round(v)) for v in _clip_box(boxes[region], w_img, h_img))
        if x1 - x0 < 4 or y1 - y0 < 4:
            continue
        imgs.append(make_tile(tex[y0:y1, x0:x1], kind))
        names.append(name)
        srcs.append([x0, y0, x1, y1])
        kinds.append(kind)
    pad = 2
    aw = sum(i.shape[1] + 2 * pad for i in imgs)
    ah = max(i.shape[0] for i in imgs) + 2 * pad
    atlas = np.zeros((ah, aw, 4), dtype=np.uint8)
    rects, x = [], 0
    for im in imgs:
        th, tw = im.shape[:2]
        atlas[pad:pad + th, x + pad:x + pad + tw] = im
        # replicate edges into the padding to avoid filtering seams
        atlas[:pad, x + pad:x + pad + tw] = im[:1]
        atlas[pad + th:, x + pad:x + pad + tw] = im[-1:]
        atlas[:, x:x + pad] = atlas[:, x + pad:x + pad + 1]
        atlas[:, x + pad + tw:x + 2 * pad + tw] = atlas[:, x + pad + tw - 1:x + pad + tw]
        rects.append(((x + pad) / aw, pad / ah, (x + pad + tw) / aw, (pad + th) / ah))
        x += tw + 2 * pad
    return FaceTiles(atlas=atlas, names=names, boxes=srcs, uv_rects=rects, kinds=kinds)
