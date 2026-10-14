"""Gelenkpunkte (Keypoints) einer Figur im Bild bestimmen.

Alle Punkte sind Pixelkoordinaten [x, y] im Originalbild. "left_*" meint die
linke Körperseite der Figur – bei einer Frontalansicht liegt sie im Bild RECHTS.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image

KEYPOINT_NAMES = [
    "head_top", "neck",
    "left_shoulder", "right_shoulder",
    "left_elbow", "right_elbow",
    "left_wrist", "right_wrist",
    "left_hip", "right_hip",
    "left_knee", "right_knee",
    "left_ankle", "right_ankle",
]


def load_keypoints(path: str | Path) -> dict:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return validate_keypoints(data)


def validate_keypoints(data: dict) -> dict:
    missing = [k for k in KEYPOINT_NAMES if k not in data]
    if missing:
        raise ValueError(f"Fehlende Keypoints: {', '.join(missing)}")
    out = {k: [float(data[k][0]), float(data[k][1])] for k in KEYPOINT_NAMES}
    # optional face boxes [x0, y0, x1, y1] for eyes and mouth
    for k in ("left_eye_box", "right_eye_box", "mouth_box"):
        if k in data and data[k] is not None:
            box = [float(v) for v in data[k]]
            if len(box) != 4 or box[2] <= box[0] or box[3] <= box[1]:
                raise ValueError(f"Ungültige Box für {k}: {data[k]}")
            out[k] = box
    return out


def detect_keypoints(img: Image.Image, mask: np.ndarray, method: str = "auto") -> dict:
    """method: auto (MediaPipe falls installiert, sonst Heuristik), mediapipe, heuristic."""
    if method in ("auto", "mediapipe"):
        try:
            kp = mediapipe_keypoints(img, mask)
            if kp is not None:
                return kp
        except ImportError:
            if method == "mediapipe":
                raise RuntimeError("Für --pose mediapipe bitte 'pip install mediapipe' ausführen.")
        if method == "mediapipe":
            raise RuntimeError("MediaPipe hat keine Person im Bild erkannt.")
    return heuristic_keypoints(mask)


# ---------------------------------------------------------------- heuristic

def _runs(row: np.ndarray) -> list[tuple[int, int]]:
    """Contiguous True runs of a 1D boolean row as (start, end) inclusive."""
    padded = np.concatenate([[False], row, [False]]).astype(np.int8)
    diff = np.diff(padded)
    starts = np.nonzero(diff == 1)[0]
    ends = np.nonzero(diff == -1)[0] - 1
    return list(zip(starts.tolist(), ends.tolist()))


def heuristic_keypoints(mask: np.ndarray) -> dict:
    """Estimate joints from the silhouette, assuming a standing figure seen from the front."""
    ys, xs = np.nonzero(mask)
    top, bottom = int(ys.min()), int(ys.max())
    H = float(bottom - top + 1)

    def row(frac: float) -> tuple[int, np.ndarray]:
        y = int(min(bottom, max(top, round(top + frac * H))))
        return y, mask[y]

    # Body center from the head region (heads are usually centered on the body).
    head_rows = mask[top:int(top + 0.12 * H) + 1]
    hy, hx = np.nonzero(head_rows)
    cx = float(hx.mean()) if len(hx) else float(xs.mean())

    neck_y = top + 0.155 * H
    sh_y, sh_row = row(0.20)
    ext = _runs(sh_row)
    left_ext = min(s for s, _ in ext) if ext else cx - 0.1 * H
    right_ext = max(e for _, e in ext) if ext else cx + 0.1 * H
    half_extent = max(cx - left_ext, right_ext - cx)

    tpose = half_extent > 0.30 * H
    sh_half = 0.10 * H if tpose else min(0.11 * H, half_extent * 0.75)

    kp: dict[str, list[float]] = {
        "head_top": [cx, float(top)],
        "neck": [cx, neck_y],
        "left_shoulder": [cx + sh_half, float(sh_y)],
        "right_shoulder": [cx - sh_half, float(sh_y)],
    }

    if tpose:
        for side, sgn in (("left", 1), ("right", -1)):
            reach = (right_ext - cx) if sgn > 0 else (cx - left_ext)
            kp[f"{side}_elbow"] = [cx + sgn * (sh_half + 0.45 * (reach - sh_half)), float(sh_y)]
            kp[f"{side}_wrist"] = [cx + sgn * (reach - 0.06 * H), float(sh_y)]
    else:
        for joint, frac, inset in (("elbow", 0.36, 0.025), ("wrist", 0.50, 0.03)):
            y, r = row(frac)
            runs = _runs(r)
            for side, sgn in (("left", 1), ("right", -1)):
                default = cx + sgn * (sh_half + (0.015 if joint == "elbow" else 0.03) * H)
                x = default
                if len(runs) >= 3:
                    run = runs[-1] if sgn > 0 else runs[0]
                    x = (run[0] + run[1]) / 2
                elif runs:
                    edge = max(e for _, e in runs) if sgn > 0 else min(s for s, _ in runs)
                    candidate = edge - sgn * inset * H
                    # Only trust the silhouette edge if it is plausibly an arm.
                    if abs(candidate - cx) < abs(default - cx) * 1.6:
                        x = candidate
                kp[f"{side}_{joint}"] = [float(x), float(y)]

    hip_y = top + 0.52 * H
    hip_half = 0.055 * H
    kp["left_hip"] = [cx + hip_half, hip_y]
    kp["right_hip"] = [cx - hip_half, hip_y]

    for joint, frac in (("knee", 0.74), ("ankle", 0.94)):
        y, r = row(frac)
        runs = [ru for ru in _runs(r) if abs((ru[0] + ru[1]) / 2 - cx) < 0.2 * H]
        lefts = [ru for ru in runs if (ru[0] + ru[1]) / 2 > cx]
        rights = [ru for ru in runs if (ru[0] + ru[1]) / 2 < cx]
        lx = (lefts[0][0] + lefts[0][1]) / 2 if lefts else cx + hip_half * 0.9
        rx = (rights[-1][0] + rights[-1][1]) / 2 if rights else cx - hip_half * 0.9
        kp[f"left_{joint}"] = [float(lx), float(y)]
        kp[f"right_{joint}"] = [float(rx), float(y)]

    return {k: [float(v[0]), float(v[1])] for k, v in kp.items()}


# ---------------------------------------------------------------- mediapipe

def mediapipe_keypoints(img: Image.Image, mask: np.ndarray) -> dict | None:
    """Pose detection with MediaPipe (optional dependency)."""
    import mediapipe as mp  # type: ignore

    rgb = np.asarray(img.convert("RGB"))
    with mp.solutions.pose.Pose(static_image_mode=True, model_complexity=2) as pose:
        res = pose.process(rgb)
    if not res.pose_landmarks:
        return None
    h, w = mask.shape
    lm = res.pose_landmarks.landmark

    def p(i: int) -> np.ndarray:
        return np.array([lm[i].x * w, lm[i].y * h])

    ls, rs = p(11), p(12)
    mid_sh = (ls + rs) / 2
    neck = mid_sh - np.array([0.0, 0.15 * np.linalg.norm(ls - rs)])
    nose = p(0)
    col = int(np.clip(round(nose[0]), 0, w - 1))
    ys = np.nonzero(mask[:, col])[0]
    head_top = np.array([nose[0], ys.min() if len(ys) else nose[1] - 0.6 * np.linalg.norm(ls - rs)])
    kp = {
        "head_top": head_top, "neck": neck,
        "left_shoulder": ls, "right_shoulder": rs,
        "left_elbow": p(13), "right_elbow": p(14),
        "left_wrist": p(15), "right_wrist": p(16),
        "left_hip": p(23), "right_hip": p(24),
        "left_knee": p(25), "right_knee": p(26),
        "left_ankle": p(27), "right_ankle": p(28),
    }
    return {k: [float(v[0]), float(v[1])] for k, v in kp.items()}
