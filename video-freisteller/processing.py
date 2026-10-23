"""Verarbeitungskern: Video einlesen, Hintergrund freistellen, exportieren.

Freistellung liefert immer RGBA (uint8) mit weichem, fein abgestuftem
Alpha-Kanal (256 Stufen). Zwei Verfahren:

* KI (Robust Video Matting, ONNX): Personen ohne Green-Screen, inkl.
  Haarkanten und zeitlicher Stabilitaet ueber die rekurrenten Zustaende.
* Farbe (Chroma-Key): Abstand in der CbCr-Ebene mit weichem Uebergang,
  richtungsbasiertem Despill und optionaler Kantenverfeinerung.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import urllib.request
from dataclasses import asdict, dataclass, field
from fractions import Fraction
from pathlib import Path

import cv2
import numpy as np

APP_NAME = "VideoFreisteller"
RVM_BASE = "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/"
BIREF_BASE = "https://github.com/ZhengPeng7/BiRefNet/releases/download/v1/"
# Alle Modelle sind in der EXE enthalten; fehlt eines, wird es einmalig geladen.
MODELS = {
    # Qualitaet: (Dateiname, Download-URL)
    "schnell": ("rvm_mobilenetv3_fp32.onnx", RVM_BASE + "rvm_mobilenetv3_fp32.onnx"),  # ~15 MB
    "hoch": ("rvm_resnet50_fp32.onnx", RVM_BASE + "rvm_resnet50_fp32.onnx"),          # ~100 MB
    # BiRefNet lite (MIT) – wie im KI-Assistenten; sehr genaue Figur, langsam ohne Grafikkarte
    "birefnet": ("birefnet_lite.onnx",
                 BIREF_BASE + "BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx"),      # ~225 MB
}
MODEL_SIZES = {"schnell": "15 MB", "hoch": "100 MB", "birefnet": "225 MB"}

# Unter Windows kein Konsolenfenster fuer ffmpeg aufpoppen lassen.
_NO_WINDOW = 0x08000000 if os.name == "nt" else 0


# --------------------------------------------------------------------------
# Hilfsprogramme / Pfade
# --------------------------------------------------------------------------

def _base_dirs() -> list[Path]:
    dirs = []
    if getattr(sys, "frozen", False):
        dirs.append(Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent)))
        dirs.append(Path(sys.executable).parent)
    dirs.append(Path(__file__).resolve().parent)
    return dirs


def user_data_dir() -> Path:
    root = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~/.local/share")
    d = Path(root) / APP_NAME
    d.mkdir(parents=True, exist_ok=True)
    return d


def find_tool(name: str) -> str:
    exe = name + (".exe" if os.name == "nt" else "")
    for base in _base_dirs():
        for cand in (base / "ffmpeg" / exe, base / exe, base / "bin" / exe):
            if cand.is_file():
                return str(cand)
    found = shutil.which(name)
    if found:
        return found
    raise FileNotFoundError(
        f"{exe} wurde nicht gefunden. Bitte ffmpeg neben die Programmdatei "
        f"legen (Ordner 'ffmpeg') oder in den PATH aufnehmen."
    )


def find_model(quality: str = "schnell") -> Path | None:
    name = MODELS.get(quality, MODELS["schnell"])[0]
    for base in _base_dirs() + [user_data_dir()]:
        cand = base / "models" / name
        if cand.is_file():
            return cand
    return None


def download_model(quality: str = "schnell", progress=None) -> Path:
    name, url = MODELS.get(quality, MODELS["schnell"])
    target = user_data_dir() / "models" / name
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(".part")
    with urllib.request.urlopen(url, timeout=60) as resp, \
            open(tmp, "wb") as fh:
        total = int(resp.headers.get("Content-Length") or 0)
        done = 0
        while chunk := resp.read(1 << 16):
            fh.write(chunk)
            done += len(chunk)
            if progress and total:
                progress(done / total)
    tmp.replace(target)
    return target


def _run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd, capture_output=True, text=True, encoding="utf-8",
        errors="replace", creationflags=_NO_WINDOW,
    )


# --------------------------------------------------------------------------
# Video-Infos
# --------------------------------------------------------------------------

@dataclass
class VideoInfo:
    path: str
    width: int
    height: int
    fps: Fraction
    duration: float
    frame_count: int
    has_audio: bool

    @property
    def fps_float(self) -> float:
        return float(self.fps)


def probe(path: str) -> VideoInfo:
    out = _run([
        find_tool("ffprobe"), "-v", "error", "-print_format", "json",
        "-show_streams", "-show_format", path,
    ])
    if out.returncode != 0:
        raise RuntimeError(f"Video kann nicht gelesen werden:\n{out.stderr}")
    data = json.loads(out.stdout)
    vstreams = [s for s in data["streams"] if s.get("codec_type") == "video"]
    if not vstreams:
        raise RuntimeError("Die Datei enthält keine Videospur.")
    vs = vstreams[0]
    fps = Fraction(30)
    for key in ("avg_frame_rate", "r_frame_rate"):
        try:
            f = Fraction(vs.get(key, "0/0"))
            if 0 < f < 1000:
                fps = f.limit_denominator(1001)
                break
        except (ZeroDivisionError, ValueError):
            pass
    duration = float(vs.get("duration") or data.get("format", {}).get("duration") or 0)

    # Abmessungen nach automatischer Drehung (Handyvideos) ueber OpenCV,
    # das wie ffmpeg die Rotations-Metadaten beruecksichtigt.
    width, height = int(vs["width"]), int(vs["height"])
    cap = cv2.VideoCapture(path)
    ok, frame = cap.read()
    if ok:
        height, width = frame.shape[:2]
    cap.release()

    return VideoInfo(
        path=path, width=width, height=height, fps=fps, duration=duration,
        frame_count=max(1, int(round(duration * float(fps)))),
        has_audio=any(s.get("codec_type") == "audio" for s in data["streams"]),
    )


class FrameReader:
    """Schneller Einzelbildzugriff fuer die Vorschau (OpenCV)."""

    def __init__(self, path: str):
        self.cap = cv2.VideoCapture(path)
        self.pos = -1

    def read(self, index: int) -> np.ndarray | None:
        if index != self.pos + 1:
            self.cap.set(cv2.CAP_PROP_POS_FRAMES, index)
        ok, frame = self.cap.read()
        if not ok:
            self.pos = -1
            return None
        self.pos = index
        return cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

    def close(self):
        self.cap.release()


# --------------------------------------------------------------------------
# Einstellungen
# --------------------------------------------------------------------------

@dataclass
class KeySettings:
    mode: str = "ai"                     # "none" | "chroma" | "ai"
    key_color: tuple = (0, 177, 64)      # Green-Screen-Gruen
    tolerance: float = 0.22              # 0..1, ab hier beginnt Deckung
    softness: float = 0.18               # Breite des Uebergangs (Graduierung)
    despill: float = 0.8                 # Farbsaum entfernen 0..1
    unmix: bool = True                   # Kantenfarben vom Hintergrund entmischen
    from_edge: bool = False              # nur vom Bildrand aus zusammenhaengende Flaechen
    ai_quality: str = "hoch"             # "birefnet" | "hoch" (RVM ResNet50) | "schnell" (RVM MobileNet)
    ai_detail: float = 1.0               # 0.5..2 – Aufloesung des KI-Netzes
    ai_edge_colors: bool = True          # Kantenfarben aus KI-Vordergrund
    use_gpu: bool = True
    choke: float = 0.0                   # px, + = Kante schrumpfen, - = erweitern
    feather: float = 0.0                 # px Weichzeichnung der Kante
    refine: bool = True                  # Kanten an Bilddetails anpassen
    dehalo: float = 0.4                  # Aura/Schleier um die Figur entfernen 0..1
    edge_mode: str = "sauber"            # "sauber" (keine Aura) | "fein" (weiche KI-Kante)
    edge_inset: float = 1.0              # px – Kante nach innen setzen (nur "sauber")
    edge_soft: float = 1.0               # px – Breite der Kantenglaettung (nur "sauber")
    alpha_low: float = 0.0               # Alpha-Schwarzpunkt 0..1
    alpha_high: float = 1.0              # Alpha-Weisspunkt 0..1

    def to_dict(self):
        return asdict(self)

    @classmethod
    def from_dict(cls, d):
        known = {k: v for k, v in d.items() if k in cls.__dataclass_fields__}
        if "key_color" in known:
            known["key_color"] = tuple(int(c) for c in known["key_color"])
        return cls(**known)


# --------------------------------------------------------------------------
# Freistellung
# --------------------------------------------------------------------------

def _smoothstep(x: np.ndarray) -> np.ndarray:
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3.0 - 2.0 * x)


def _rgb_to_ycbcr(rgb: np.ndarray):
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    cb = (b - y) / 1.8556
    cr = (r - y) / 1.5748
    return y, cb, cr


def _ycbcr_to_rgb(y, cb, cr):
    r = y + 1.5748 * cr
    b = y + 1.8556 * cb
    g = (y - 0.2126 * r - 0.0722 * b) / 0.7152
    return np.stack([r, g, b], axis=-1)


def _guided_filter(guide: np.ndarray, src: np.ndarray, radius: int, eps: float):
    """Kantenerhaltender Filter: Alpha folgt feinen Strukturen des Bildes."""
    k = (2 * radius + 1, 2 * radius + 1)
    mean_i = cv2.boxFilter(guide, -1, k)
    mean_p = cv2.boxFilter(src, -1, k)
    corr_ip = cv2.boxFilter(guide * src, -1, k)
    corr_ii = cv2.boxFilter(guide * guide, -1, k)
    var_i = corr_ii - mean_i * mean_i
    a = (corr_ip - mean_i * mean_p) / (var_i + eps)
    b = mean_p - a * mean_i
    return cv2.boxFilter(a, -1, k) * guide + cv2.boxFilter(b, -1, k)


class ChromaKeyer:
    """Farb-Keying fuer Green-/Blue-Screen und weisse/graue Hintergruende.

    Bunte Schluesselfarben werden ueber den Farbton (CbCr) getrennt, damit
    Schatten auf dem Screen mit verschwinden. Bei neutralen Farben (Weiss,
    Grau) zaehlt zusaetzlich die Helligkeit, sonst wuerde jedes Grau im
    Vordergrund mit herausgerechnet.
    """

    def __init__(self, s: KeySettings):
        self.s = s
        self.key_rgb = np.array(s.key_color, np.float32).reshape(1, 1, 3) / 255.0
        ky, kcb, kcr = _rgb_to_ycbcr(self.key_rgb)
        self.ky, self.kcb, self.kcr = float(ky[0, 0]), float(kcb[0, 0]), float(kcr[0, 0])
        n = float(np.hypot(self.kcb, self.kcr))
        self.neutral = n < 0.08
        self.kdir = (self.kcb / n, self.kcr / n) if not self.neutral else None
        # Gewicht der Helligkeit im Abstandsmass
        self.luma_w = 1.0 if self.neutral else 0.2

    def __call__(self, rgb_u8: np.ndarray):
        s = self.s
        rgb = rgb_u8.astype(np.float32) / 255.0
        y, cb, cr = _rgb_to_ycbcr(rgb)
        dy = (y - self.ky) * self.luma_w
        if not self.neutral:
            # Schatten (dunkler) auf dem Screen nicht bestrafen
            dy = np.minimum(dy, 0.0) * 0.5 + np.maximum(dy, 0.0)
        dist = np.sqrt((cb - self.kcb) ** 2 + (cr - self.kcr) ** 2 + dy * dy)
        dist /= 0.75 if not self.neutral else 0.6
        soft = max(s.softness, 1e-3)
        alpha = _smoothstep((dist - s.tolerance) / soft).astype(np.float32)
        if s.from_edge:
            alpha = self._connected_only(alpha, dist, y)

        if s.unmix:
            # Mischfarbe C = a*F + (1-a)*K  ->  F = (C - (1-a)*K) / a
            a = alpha[..., None]
            edge = (a > 0.04) & (a < 0.995)
            fg = (rgb - (1.0 - a) * self.key_rgb) / np.maximum(a, 0.04)
            rgb = np.where(edge, np.clip(fg, 0.0, 1.0), rgb)

        if s.despill > 0 and self.kdir is not None:
            y, cb, cr = _rgb_to_ycbcr(rgb)
            # Farbanteil in Richtung der Schluesselfarbe entfernen, Helligkeit bleibt.
            proj = np.maximum(cb * self.kdir[0] + cr * self.kdir[1], 0.0)
            amt = s.despill * proj
            cb = cb - amt * self.kdir[0]
            cr = cr - amt * self.kdir[1]
            rgb = np.clip(_ycbcr_to_rgb(y, cb, cr), 0.0, 1.0)
        return rgb, alpha

    def _connected_only(self, alpha, dist, luma):
        """Nur Hintergrund entfernen, der mit dem Bildrand verbunden ist.

        Wie im KI-Assistenten (cutout.js): ein weisses Hemd vor weisser Wand
        bleibt erhalten. Eingeschlossene Flaechen (zwischen Arm und Koerper)
        zaehlen nur als Hintergrund, wenn sie gross, sehr nah an der
        Hintergrundfarbe und gleichmaessig sind – Stoff hat Falten und Schatten.
        """
        h, w = alpha.shape
        cand = (alpha < 0.5).astype(np.uint8)
        n, labels, stats, _ = cv2.connectedComponentsWithStats(cand, connectivity=4)
        if n <= 1:
            return alpha
        border = np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))
        is_bg = np.zeros(n, bool)
        is_bg[border] = True
        is_bg[0] = False  # Label 0 = Vordergrund-Kandidaten
        inner = np.flatnonzero(~is_bg[1:]) + 1
        min_size = max(150, int(w * h * 0.0015))
        inner = inner[stats[inner, cv2.CC_STAT_AREA] >= min_size]
        if inner.size:
            idx = labels.ravel()
            cnt = np.bincount(idx, minlength=n).astype(np.float64)
            sum_d = np.bincount(idx, weights=dist.ravel(), minlength=n)
            l = luma.ravel().astype(np.float64)
            sum_l = np.bincount(idx, weights=l, minlength=n)
            sum_l2 = np.bincount(idx, weights=l * l, minlength=n)
            mean_d = sum_d[inner] / cnt[inner]
            std_l = np.sqrt(np.maximum(0, sum_l2[inner] / cnt[inner] - (sum_l[inner] / cnt[inner]) ** 2))
            ok = (mean_d <= self.s.tolerance * 0.6) & (std_l <= 14 / 255)
            is_bg[inner[ok]] = True
        bg = is_bg[labels]
        # weicher Saum nur direkt am entfernten Hintergrund
        r = max(2, int(round(max(h, w) / 400)))
        near = cv2.dilate(bg.astype(np.uint8), np.ones((2 * r + 1, 2 * r + 1), np.uint8)) > 0
        return np.where(bg | near, alpha, 1.0).astype(np.float32)


def border_color(rgb_u8: np.ndarray) -> tuple:
    """Haeufigste (grob quantisierte) Farbe am Bildrand = Hintergrundfarbe."""
    edge = np.concatenate([rgb_u8[0], rgb_u8[-1], rgb_u8[:, 0], rgb_u8[:, -1]]).astype(np.int32)
    keys = (edge[:, 0] >> 4) << 8 | (edge[:, 1] >> 4) << 4 | (edge[:, 2] >> 4)
    best = np.bincount(keys).argmax()
    return tuple(int(round(c)) for c in edge[keys == best].mean(axis=0))


class _OnnxModel:
    """Gemeinsame Sitzungslogik: Grafikkarte (CUDA/DirectML) wenn moeglich, sonst CPU."""

    def _open(self, model_path: Path, use_gpu: bool):
        import onnxruntime as ort

        self.model_path = model_path
        providers = ["CPUExecutionProvider"]
        if use_gpu:
            avail = ort.get_available_providers()
            for p in ("CUDAExecutionProvider", "DmlExecutionProvider"):
                if p in avail:
                    providers.insert(0, p)
                    break
        try:
            self.sess = self._session(providers)
        except Exception:
            self.sess = self._session(["CPUExecutionProvider"])
        self.provider = self.sess.get_providers()[0]

    def _session(self, providers):
        import onnxruntime as ort

        opts = ort.SessionOptions()
        opts.log_severity_level = 3
        if "DmlExecutionProvider" in providers:
            # Von DirectML vorausgesetzt
            opts.enable_mem_pattern = False
            opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        return ort.InferenceSession(str(self.model_path), opts, providers=providers)

    def _run(self, feed):
        try:
            return self.sess.run(None, feed)
        except Exception:
            if self.provider == "CPUExecutionProvider":
                raise
            # Grafikkarte macht Probleme -> dauerhaft auf CPU weiterrechnen
            self.sess = self._session(["CPUExecutionProvider"])
            self.provider = "CPUExecutionProvider"
            return self.sess.run(None, feed)


class AIMatter(_OnnxModel):
    """Robust Video Matting (rekurrent, daher zeitlich stabil)."""

    def __init__(self, s: KeySettings, model_path: Path):
        self.s = s
        self._open(model_path, s.use_gpu)
        self.reset()

    def reset(self):
        z = np.zeros((1, 1, 1, 1), np.float32)
        self.rec = [z, z, z, z]

    def _ratio(self, h, w):
        base = 512.0 * float(np.clip(self.s.ai_detail, 0.25, 4.0))
        return np.array([min(1.0, base / max(h, w))], np.float32)

    def __call__(self, rgb_u8: np.ndarray, warmup: int = 0):
        h, w = rgb_u8.shape[:2]
        src = (rgb_u8.astype(np.float32) / 255.0).transpose(2, 0, 1)[None]
        ratio = self._ratio(h, w)
        for _ in range(1 + warmup):
            feed = {"src": src, "r1i": self.rec[0], "r2i": self.rec[1],
                    "r3i": self.rec[2], "r4i": self.rec[3], "downsample_ratio": ratio}
            fgr, pha, *self.rec = self._run(feed)
        alpha = pha[0, 0]
        rgb = src[0].transpose(1, 2, 0)
        if self.s.ai_edge_colors:
            # In Kantenbereichen die vom Netz geschaetzte reine
            # Vordergrundfarbe verwenden (kein Hintergrund-Farbsaum).
            t = _smoothstep((alpha - 0.85) / 0.15)[..., None]
            rgb = rgb * t + fgr[0].transpose(1, 2, 0) * (1.0 - t)
        return np.clip(rgb, 0, 1), alpha.astype(np.float32)


class BiRefMatter(_OnnxModel):
    """BiRefNet lite – dasselbe Modell wie im KI-Assistenten.

    Erkennt die Hauptfigur sehr genau (Haende, Fuesse, Luecken zwischen Armen
    und Beinen). Arbeitet Bild fuer Bild mit 1024x1024 Pixeln; ohne
    Grafikkarte entsprechend langsam.

    Optional prueft das Personen-Modell (RVM) mit: Teile, die BiRefNet fuer
    wichtig haelt, die aber gar nicht zu einer Person gehoeren (z. B. eine
    Lampe im Hintergrund), werden entfernt.
    """

    SIZE = 1024
    MEAN = np.array([0.485, 0.456, 0.406], np.float32)
    STD = np.array([0.229, 0.224, 0.225], np.float32)

    def __init__(self, s: KeySettings, model_path: Path, person_model: Path | None = None):
        self.s = s
        self._open(model_path, s.use_gpu)
        self.person = AIMatter(s, person_model) if person_model else None
        self.reset()

    def reset(self):
        if self.person is not None:
            self.person.reset()

    def __call__(self, rgb_u8: np.ndarray, warmup: int = 0):
        h, w = rgb_u8.shape[:2]
        x = cv2.resize(rgb_u8, (self.SIZE, self.SIZE), interpolation=cv2.INTER_AREA)
        x = (x.astype(np.float32) / 255.0 - self.MEAN) / self.STD
        logits = self._run({"input_image": x.transpose(2, 0, 1)[None]})[0][0, 0]
        a = 1.0 / (1.0 + np.exp(-logits))
        alpha = cv2.resize(a.astype(np.float32), (w, h), interpolation=cv2.INTER_CUBIC)
        alpha = np.clip(alpha, 0.0, 1.0)
        if self.person is not None:
            self.person.s = self.s
            _, p = self.person(rgb_u8, warmup=warmup)
            alpha = _keep_person_parts(alpha, p)
        return rgb_u8.astype(np.float32) / 255.0, alpha.astype(np.float32)


def _keep_person_parts(alpha: np.ndarray, person: np.ndarray) -> np.ndarray:
    """Nur zusammenhaengende Teile behalten, die mit einer Person ueberlappen."""
    m = (alpha > 0.3).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    if n <= 1:
        return alpha
    h, w = alpha.shape
    r = max(3, int(round(max(h, w) / 100)))
    pm = cv2.dilate((person > 0.4).astype(np.uint8),
                    cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1)))
    overlap = np.bincount(labels.ravel(), weights=pm.ravel().astype(np.float64), minlength=n)
    area = stats[:, cv2.CC_STAT_AREA].astype(np.float64)
    keep = overlap / np.maximum(area, 1) >= 0.25
    # Bruchstuecke weiterer Personen am Bildrand (z. B. ein einzelnes Bein) weglassen
    keep &= area >= area[1:].max() * 0.06
    keep[0] = True
    if not keep[1:].any():
        return alpha  # Personen-Modell sieht niemanden -> BiRefNet vertrauen
    drop = ~keep[labels]
    # weiche Raender der entfernten Teile ebenfalls entfernen
    drop = cv2.dilate(drop.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    drop &= pm == 0
    return np.where(drop, 0.0, alpha).astype(np.float32)


def make_matter(s: KeySettings):
    """Passendes KI-Modell fuer die Einstellungen laden (oder None, falls nicht vorhanden)."""
    path = find_model(s.ai_quality)
    if path is None:
        return None
    if s.ai_quality == "birefnet":
        return BiRefMatter(s, path, person_model=find_model("hoch"))
    return AIMatter(s, path)


class Processor:
    """Wendet Freistellung + Kantennachbearbeitung an und liefert RGBA uint8."""

    def __init__(self, s: KeySettings, model_path: Path | None = None,
                 px_scale: float = 1.0, matter=None, raw_cache: dict | None = None):
        self.s = s
        self.px_scale = px_scale
        # Zwischenspeicher fuer KI-Ergebnisse (Vorschau): Kanten-Regler aendern
        # nur die Nachbearbeitung, das Modell muss nicht neu rechnen.
        self.raw_cache = raw_cache
        if s.mode == "chroma":
            self.keyer = ChromaKeyer(s)
        elif s.mode == "ai":
            if matter is not None:
                matter.s = s
                self.keyer = matter
            else:
                self.keyer = make_matter(s)
                if self.keyer is None:
                    raise RuntimeError("KI-Modell nicht gefunden.")
        else:
            self.keyer = None
        self.prev_alpha = None

    def reset(self):
        self.prev_alpha = None
        if isinstance(self.keyer, (AIMatter, BiRefMatter)):
            self.keyer.reset()

    def __call__(self, rgb_u8: np.ndarray, warmup: int = 0, key=None) -> np.ndarray:
        if self.keyer is None:
            a = np.full(rgb_u8.shape[:2] + (1,), 255, np.uint8)
            return np.concatenate([rgb_u8, a], axis=-1)
        if isinstance(self.keyer, (AIMatter, BiRefMatter)):
            if key is not None and self.raw_cache is not None and key in self.raw_cache:
                rgb, alpha = self.raw_cache[key]
            else:
                rgb, alpha = self.keyer(rgb_u8, warmup=warmup)
                if key is not None and self.raw_cache is not None:
                    while len(self.raw_cache) >= 40:
                        self.raw_cache.pop(next(iter(self.raw_cache)))
                    self.raw_cache[key] = (rgb, alpha)
        else:
            rgb, alpha = self.keyer(rgb_u8)
        if self.s.edge_mode == "sauber":
            # leichte zeitliche Glaettung gegen Kantenflimmern
            if self.prev_alpha is not None and self.prev_alpha.shape == alpha.shape:
                alpha = 0.7 * alpha + 0.3 * self.prev_alpha
            self.prev_alpha = alpha
            alpha = self._clean_alpha(alpha)
        else:
            alpha = self._post_alpha(alpha, rgb_u8)
        out = np.empty(rgb_u8.shape[:2] + (4,), np.uint8)
        out[..., :3] = np.round(rgb * 255.0)
        out[..., 3] = np.round(alpha * 255.0)
        return out

    WEAK = 0.3  # Hysterese-Untergrenze fuer die saubere Kante

    def _clean_alpha(self, alpha: np.ndarray) -> np.ndarray:
        """Saubere Kante ohne Aura.

        Die KI liefert am Rand einen breiten, halbdurchsichtigen Uebergang, in
        dem noch Farbe des alten Hintergrunds steckt – das ist die "Aura".
        Hier wird stattdessen eine klare Figur bestimmt (Deckung > 50 %),
        von Flecken und Loechern befreit, geglaettet und um einen Hauch nach
        innen gesetzt. Der weiche Uebergang liegt komplett INNERHALB dieser
        Kontur – ausserhalb ist alles 100 % Hintergrund.
        """
        s, sc = self.s, self.px_scale
        h, w = alpha.shape
        # Hysterese: sichere Teile (> 50 %) plus alles Schwaechere (> 30 %),
        # das daran haengt. Bewegte, unscharfe Haende/Fuesse liegen oft unter
        # 50 % und wuerden sonst abgeschnitten; lose Flecken bleiben draussen.
        strong = alpha > 0.5
        if not strong.any():
            return np.zeros_like(alpha)
        n, labels = cv2.connectedComponents((alpha > self.WEAK).astype(np.uint8), connectivity=8)
        keep = np.zeros(n, bool)
        keep[np.unique(labels[strong])] = True
        keep[0] = False
        m = keep[labels].astype(np.uint8)
        # Kleine Flecken im Hintergrund entfernen (Figur-Teile bleiben)
        n, labels, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
        if n > 2:
            areas = stats[1:, cv2.CC_STAT_AREA]
            min_area = max(30 * sc * sc, areas.max() * 0.01)
            keep = np.concatenate([[False], areas >= min_area])
            m = keep[labels].astype(np.uint8)
        # Kleine Loecher in der Figur schliessen (grosse Luecken, z. B. zwischen
        # Arm und Koerper, bleiben Hintergrund)
        inv = (1 - m).astype(np.uint8)
        n, labels, stats, _ = cv2.connectedComponentsWithStats(inv, connectivity=4)
        if n > 2:
            border = np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))
            small = stats[:, cv2.CC_STAT_AREA] < h * w * 0.0005
            small[border] = False
            small[0] = False
            m[small[labels]] = 1
        # Kontur glaetten (Treppen/Zacken weg)
        sig = max(0.6, 1.2 * sc)
        mf = cv2.GaussianBlur(m.astype(np.float32), (0, 0), sig)
        m = (mf > 0.5).astype(np.uint8)
        # nach innen setzen
        inset = s.edge_inset * sc
        if inset >= 0.5:
            k = int(round(inset)) * 2 + 1
            m = cv2.erode(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
        # weicher Uebergang nur nach innen: aussen bleibt 0
        soft = s.edge_soft * sc
        if soft >= 0.25:
            b = cv2.GaussianBlur(m.astype(np.float32), (0, 0), soft)
            a = np.clip(2.0 * b - 1.0, 0.0, 1.0)
        else:
            a = m.astype(np.float32)
        return a.astype(np.float32)

    @staticmethod
    def _dehalo(alpha: np.ndarray, strength: float, sc: float) -> np.ndarray:
        """Schwachen Schleier um die Figur entfernen.

        1. Sehr geringe Deckung (Rauschen/Schimmer) wird ausgeblendet.
        2. Einzelne schwache Flecken im Hintergrund, die nirgends deckend sind,
           werden entfernt. Alles, was mit der Figur zusammenhaengt (Haende,
           Fuesse), bleibt vollstaendig erhalten.
        """
        t = 0.25 * strength
        a = np.clip((alpha - t) / (1.0 - t), 0.0, 1.0)
        n, labels = cv2.connectedComponents((a > 0.0).astype(np.uint8), connectivity=8)
        if n > 2:
            keep = np.zeros(n, bool)
            keep[np.unique(labels[alpha > 0.6])] = True
            keep[0] = True
            a = np.where(keep[labels], a, 0.0)
        return a.astype(np.float32)

    def _post_alpha(self, alpha: np.ndarray, rgb_u8: np.ndarray) -> np.ndarray:
        s, sc = self.s, self.px_scale
        if s.refine:
            guide = cv2.cvtColor(rgb_u8, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255.0
            r = max(1, int(round(2 * sc)))
            refined = np.clip(_guided_filter(guide, alpha, r, 1e-4), 0, 1)
            # Nur schaerfen, nie nach aussen wachsen: aussen (alpha < 0.5) darf die
            # Deckung nur sinken, innen nur steigen – sonst entsteht ein Schleier
            # in der Farbe des alten Hintergrunds um die Figur.
            refined = np.where(alpha < 0.5, np.minimum(refined, alpha),
                               np.maximum(refined, alpha))
            edge = cv2.dilate(((alpha > 0.02) & (alpha < 0.98)).astype(np.uint8),
                              np.ones((2 * r + 1, 2 * r + 1), np.uint8))
            alpha = np.where(edge > 0, refined, alpha)
        if s.dehalo > 0:
            alpha = self._dehalo(alpha, s.dehalo, sc)
        choke = s.choke * sc
        if abs(choke) >= 0.5:
            k = int(round(abs(choke))) * 2 + 1
            kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
            alpha = cv2.erode(alpha, kernel) if choke > 0 else cv2.dilate(alpha, kernel)
        feather = s.feather * sc
        if feather >= 0.3:
            alpha = cv2.GaussianBlur(alpha, (0, 0), feather)
        lo, hi = s.alpha_low, max(s.alpha_high, s.alpha_low + 1e-3)
        if lo > 0 or hi < 1:
            alpha = (alpha - lo) / (hi - lo)
        return np.clip(alpha, 0.0, 1.0).astype(np.float32)


def bleed_colors(rgba: np.ndarray, matte=(0, 0, 0)) -> np.ndarray:
    """Farben in den durchsichtigen Pixeln fuer die Kodierung festlegen.

    Wie im KI-Assistenten (Aufnahme einer geleerten Zeichenflaeche): alles,
    was durchsichtig ist, wird SCHWARZ gespeichert. Player ohne Transparenz
    (Windows-Mediaplayer, VLC) zeigen die Figur dann auf sauberem Schwarz –
    nicht auf dem alten Hintergrund (das war die "Aura").

    Nur ein ganz schmaler Streifen direkt an der Figur bekommt die Farbe der
    Figur, damit VP9 (Farbe in halber Aufloesung) die Kantenpixel nicht
    entfaerbt. Fuer Browser ist das unsichtbar.
    """
    a = rgba[..., 3].astype(np.float32) / 255.0
    h, w = a.shape
    out = rgba.copy()
    clear_all = a < 0.02
    out[..., :3][clear_all] = matte
    band = max(2, int(round(max(h, w) / 600)))
    ker = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * band + 1, 2 * band + 1))
    clear = clear_all & (cv2.dilate((a >= 0.02).astype(np.uint8), ker) > 0)
    if not clear.any():
        return out
    # Push-Pull-Pyramide: vormultiplizierte Farbe + Alpha halbieren, bis alles
    # gedeckt ist, dann von grob nach fein die Luecken auffuellen. Laufzeit O(n).
    pm = rgba[..., :3].astype(np.float32) * a[..., None]
    levels = [(pm, a)]
    while min(levels[-1][1].shape) > 2:
        p, q = levels[-1]
        hh, ww = (q.shape[0] + 1) // 2, (q.shape[1] + 1) // 2
        levels.append((cv2.resize(p, (ww, hh), interpolation=cv2.INTER_AREA),
                       cv2.resize(q, (ww, hh), interpolation=cv2.INTER_AREA)))
    color = None
    for p, q in reversed(levels):
        c = p / np.maximum(q, 1e-6)[..., None]
        if color is not None:
            up = cv2.resize(color, (q.shape[1], q.shape[0]), interpolation=cv2.INTER_LINEAR)
            wgt = np.clip(q / 0.02, 0.0, 1.0)[..., None]
            c = c * wgt + up * (1.0 - wgt)
        color = c
    out[..., :3][clear] = np.clip(np.round(color[clear]), 0, 255).astype(np.uint8)
    return out


def composite(rgba: np.ndarray, bg) -> np.ndarray:
    """RGBA ueber Hintergrund legen. bg: (r,g,b) oder RGB-Array gleicher Groesse."""
    a = rgba[..., 3:4].astype(np.float32) / 255.0
    fg = rgba[..., :3].astype(np.float32)
    if isinstance(bg, np.ndarray):
        back = bg.astype(np.float32)
    else:
        back = np.array(bg, np.float32).reshape(1, 1, 3)
    return np.round(fg * a + back * (1.0 - a)).astype(np.uint8)


def checkerboard(h: int, w: int, size: int = 12) -> np.ndarray:
    yy, xx = np.mgrid[0:h, 0:w]
    c = ((yy // size + xx // size) % 2).astype(np.uint8)
    img = np.where(c[..., None] == 1, 200, 155).astype(np.uint8)
    return np.repeat(img, 3, axis=-1)


# --------------------------------------------------------------------------
# Export
# --------------------------------------------------------------------------

FORMATS = {
    "webm": "WebM (VP9, mit Transparenz)",
    "mov": "MOV ProRes 4444 (mit Transparenz, für Schnittprogramme)",
    "mp4": "MP4 (H.264, ohne Transparenz)",
}
QUALITY = {  # (VP9-CRF, x264-CRF)
    "hoch": (18, 17),
    "mittel": (28, 21),
    "klein": (36, 26),
}


@dataclass
class ExportJob:
    info: VideoInfo
    out_path: str
    segments: list = field(default_factory=list)  # [(start_s, end_s), ...]
    settings: KeySettings = field(default_factory=KeySettings)
    fmt: str = "webm"
    quality: str = "mittel"
    max_height: int = 0                 # 0 = Originalgroesse
    audio: bool = True
    bg_color: tuple = (255, 255, 255)   # Hintergrund, wenn nicht transparent
    transparent: bool = True            # Transparenz behalten (nur WebM/MOV)


class Cancelled(Exception):
    pass


def _even(x: float) -> int:
    return max(2, int(round(x / 2.0)) * 2)


def output_size(info: VideoInfo, max_height: int):
    w, h = info.width, info.height
    if max_height and h > max_height:
        w, h = w * max_height / h, max_height
    return _even(w), _even(h)


def _video_codec_args(job: ExportJob, alpha: bool) -> list[str]:
    vp9_crf, x264_crf = QUALITY.get(job.quality, QUALITY["mittel"])
    if job.fmt == "webm":
        return [
            "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p" if alpha else "yuv420p",
            "-crf", str(vp9_crf), "-b:v", "0", "-row-mt", "1",
            "-deadline", "good", "-cpu-used", "2", "-auto-alt-ref", "0",
        ]
    if job.fmt == "mov":
        return [
            "-c:v", "prores_ks", "-profile:v", "4444" if alpha else "3",
            "-pix_fmt", "yuva444p10le" if alpha else "yuv422p10le",
            "-vendor", "apl0",
        ]
    return [
        "-c:v", "libx264", "-preset", "medium", "-crf", str(x264_crf),
        "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    ]


def _audio_codec_args(fmt: str) -> list[str]:
    if fmt == "webm":
        return ["-c:a", "libopus", "-b:a", "160k"]
    if fmt == "mov":
        return ["-c:a", "pcm_s16le"]
    return ["-c:a", "aac", "-b:a", "192k"]


def _segments(job: ExportJob):
    segs = [(max(0.0, a), min(job.info.duration, b)) for a, b in job.segments]
    segs = [(a, b) for a, b in segs if b - a > 0.01]
    return segs or [(0.0, job.info.duration)]


def _audio_filter(segs, input_idx: int) -> str:
    parts = [
        f"[{input_idx}:a]atrim=start={a:.4f}:end={b:.4f},asetpts=PTS-STARTPTS[a{i}]"
        for i, (a, b) in enumerate(segs)
    ]
    labels = "".join(f"[a{i}]" for i in range(len(segs)))
    parts.append(f"{labels}concat=n={len(segs)}:v=0:a=1[aout]")
    return ";".join(parts)


def export(job: ExportJob, model_path: Path | None = None,
           progress=None, is_cancelled=lambda: False):
    """Fuehrt den Export aus. progress(anteil 0..1, text)."""
    ffmpeg = find_tool("ffmpeg")
    segs = _segments(job)
    total = sum(b - a for a, b in segs)
    w, h = output_size(job.info, job.max_height)
    fps = job.info.fps
    use_audio = job.audio and job.info.has_audio
    s = job.settings

    if s.mode == "none":
        _export_plain(ffmpeg, job, segs, total, w, h, use_audio, progress, is_cancelled)
        return

    alpha_out = job.transparent and job.fmt in ("webm", "mov")
    proc = Processor(s, model_path, px_scale=h / job.info.height * 1.0)

    enc = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
           "-f", "rawvideo", "-pix_fmt", "rgba" if alpha_out else "rgb24",
           "-s", f"{w}x{h}", "-framerate", f"{fps.numerator}/{fps.denominator}",
           "-i", "pipe:0"]
    if use_audio:
        enc += ["-i", job.info.path, "-filter_complex", _audio_filter(segs, 1),
                "-map", "0:v", "-map", "[aout]"] + _audio_codec_args(job.fmt)
    enc += _video_codec_args(job, alpha_out)
    if job.fmt == "webm" and alpha_out:
        enc += ["-metadata:s:v:0", "alpha_mode=1"]
    enc += ["-shortest", job.out_path] if use_audio else [job.out_path]

    encoder = subprocess.Popen(enc, stdin=subprocess.PIPE, stderr=subprocess.PIPE,
                               creationflags=_NO_WINDOW)
    frame_bytes = w * h * 3
    done_time = 0.0
    frames_total = max(1, int(total * float(fps)))
    frame_no = 0
    try:
        for a, b in segs:
            proc.reset()
            dec = subprocess.Popen(
                [ffmpeg, "-hide_banner", "-loglevel", "error",
                 "-ss", f"{a:.4f}", "-i", job.info.path, "-t", f"{b - a:.4f}",
                 "-an", "-vf", f"fps={fps.numerator}/{fps.denominator},"
                 f"scale={w}:{h}:flags=lanczos",
                 "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                creationflags=_NO_WINDOW,
            )
            first = True
            try:
                while True:
                    if is_cancelled():
                        raise Cancelled()
                    buf = dec.stdout.read(frame_bytes)
                    if len(buf) < frame_bytes:
                        break
                    rgb = np.frombuffer(buf, np.uint8).reshape(h, w, 3)
                    rgba = proc(rgb, warmup=3 if first else 0)
                    first = False
                    out = bleed_colors(rgba) if alpha_out else composite(rgba, job.bg_color)
                    encoder.stdin.write(out.tobytes())
                    frame_no += 1
                    if progress and frame_no % 5 == 0:
                        progress(min(0.999, frame_no / frames_total),
                                 f"Bild {frame_no} / ~{frames_total}")
            finally:
                dec.stdout.close()
                dec.kill()
                dec.wait()
            done_time += b - a
        encoder.stdin.close()
        err = encoder.stderr.read().decode("utf-8", "replace")
        if encoder.wait() != 0:
            raise RuntimeError(f"ffmpeg-Fehler beim Kodieren:\n{err}")
    except (Cancelled, BrokenPipeError, OSError) as exc:
        encoder.kill()
        encoder.wait()
        _remove(job.out_path)
        if isinstance(exc, (BrokenPipeError, OSError)) and not isinstance(exc, Cancelled):
            err = encoder.stderr.read().decode("utf-8", "replace")
            raise RuntimeError(f"ffmpeg-Fehler beim Kodieren:\n{err}") from exc
        raise
    if progress:
        progress(1.0, "Fertig")


def _export_plain(ffmpeg, job, segs, total, w, h, use_audio, progress, is_cancelled):
    """Nur schneiden/umwandeln, ohne Freistellung – direkt in ffmpeg."""
    fps = job.info.fps
    parts = []
    for i, (a, b) in enumerate(segs):
        parts.append(f"[0:v]trim=start={a:.4f}:end={b:.4f},setpts=PTS-STARTPTS,"
                     f"fps={fps.numerator}/{fps.denominator},"
                     f"scale={w}:{h}:flags=lanczos,setsar=1[v{i}]")
        if use_audio:
            parts.append(f"[0:a]atrim=start={a:.4f}:end={b:.4f},"
                         f"asetpts=PTS-STARTPTS[a{i}]")
    n = len(segs)
    if use_audio:
        labels = "".join(f"[v{i}][a{i}]" for i in range(n))
        parts.append(f"{labels}concat=n={n}:v=1:a=1[vout][aout]")
    else:
        labels = "".join(f"[v{i}]" for i in range(n))
        parts.append(f"{labels}concat=n={n}:v=1:a=0[vout]")
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-progress", "pipe:1",
           "-nostats", "-i", job.info.path, "-filter_complex", ";".join(parts),
           "-map", "[vout]"]
    if use_audio:
        cmd += ["-map", "[aout]"] + _audio_codec_args(job.fmt)
    cmd += _video_codec_args(job, alpha=False) + [job.out_path]

    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         text=True, encoding="utf-8", errors="replace",
                         creationflags=_NO_WINDOW)
    for line in p.stdout:
        if is_cancelled():
            p.kill()
            p.wait()
            _remove(job.out_path)
            raise Cancelled()
        if line.startswith("out_time_us=") and progress:
            try:
                t = int(line.split("=", 1)[1]) / 1e6
                progress(min(0.999, t / max(total, 1e-3)), f"{t:.1f} s / {total:.1f} s")
            except ValueError:
                pass
    err = p.stderr.read()
    if p.wait() != 0:
        raise RuntimeError(f"ffmpeg-Fehler:\n{err}")
    if progress:
        progress(1.0, "Fertig")


def _remove(path):
    try:
        os.remove(path)
    except OSError:
        pass
