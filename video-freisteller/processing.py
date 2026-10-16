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
# "schnell" ist in der EXE enthalten, "hoch" wird bei Bedarf einmalig geladen.
RVM_MODELS = {
    "schnell": "rvm_mobilenetv3_fp32.onnx",   # ~15 MB
    "hoch": "rvm_resnet50_fp32.onnx",         # ~100 MB, feinere Kanten
}

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
    name = RVM_MODELS.get(quality, RVM_MODELS["schnell"])
    for base in _base_dirs() + [user_data_dir()]:
        cand = base / "models" / name
        if cand.is_file():
            return cand
    return None


def download_model(quality: str = "schnell", progress=None) -> Path:
    name = RVM_MODELS.get(quality, RVM_MODELS["schnell"])
    target = user_data_dir() / "models" / name
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(".part")
    with urllib.request.urlopen(RVM_BASE + name, timeout=60) as resp, \
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
    ai_quality: str = "schnell"          # "schnell" | "hoch"
    ai_detail: float = 1.0               # 0.5..2 – Aufloesung des KI-Netzes
    ai_edge_colors: bool = True          # Kantenfarben aus KI-Vordergrund
    use_gpu: bool = True
    choke: float = 0.0                   # px, + = Kante schrumpfen, - = erweitern
    feather: float = 0.0                 # px Weichzeichnung der Kante
    refine: bool = True                  # Kanten an Bilddetails anpassen
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


class AIMatter:
    """Robust Video Matting (rekurrent, daher zeitlich stabil)."""

    def __init__(self, s: KeySettings, model_path: Path):
        import onnxruntime as ort

        self.s = s
        self.model_path = model_path
        providers = ["CPUExecutionProvider"]
        if s.use_gpu:
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
        self.reset()

    def _session(self, providers):
        import onnxruntime as ort

        opts = ort.SessionOptions()
        opts.log_severity_level = 3
        if "DmlExecutionProvider" in providers:
            # Von DirectML vorausgesetzt
            opts.enable_mem_pattern = False
            opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        return ort.InferenceSession(str(self.model_path), opts, providers=providers)

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
            try:
                fgr, pha, *self.rec = self.sess.run(None, feed)
            except Exception:
                if self.provider == "CPUExecutionProvider":
                    raise
                # Grafikkarte macht Probleme -> dauerhaft auf CPU weiterrechnen
                self.sess = self._session(["CPUExecutionProvider"])
                self.provider = "CPUExecutionProvider"
                fgr, pha, *self.rec = self.sess.run(None, feed)
        alpha = pha[0, 0]
        rgb = src[0].transpose(1, 2, 0)
        if self.s.ai_edge_colors:
            # In Kantenbereichen die vom Netz geschaetzte reine
            # Vordergrundfarbe verwenden (kein Hintergrund-Farbsaum).
            t = _smoothstep((alpha - 0.85) / 0.15)[..., None]
            rgb = rgb * t + fgr[0].transpose(1, 2, 0) * (1.0 - t)
        return np.clip(rgb, 0, 1), alpha.astype(np.float32)


class Processor:
    """Wendet Freistellung + Kantennachbearbeitung an und liefert RGBA uint8."""

    def __init__(self, s: KeySettings, model_path: Path | None = None,
                 px_scale: float = 1.0, matter: "AIMatter | None" = None):
        self.s = s
        self.px_scale = px_scale
        if s.mode == "chroma":
            self.keyer = ChromaKeyer(s)
        elif s.mode == "ai":
            if matter is not None:
                matter.s = s
                self.keyer = matter
            elif model_path is None:
                raise RuntimeError("KI-Modell nicht gefunden.")
            else:
                self.keyer = AIMatter(s, model_path)
        else:
            self.keyer = None

    def reset(self):
        if isinstance(self.keyer, AIMatter):
            self.keyer.reset()

    def __call__(self, rgb_u8: np.ndarray, warmup: int = 0) -> np.ndarray:
        if self.keyer is None:
            a = np.full(rgb_u8.shape[:2] + (1,), 255, np.uint8)
            return np.concatenate([rgb_u8, a], axis=-1)
        if isinstance(self.keyer, AIMatter):
            rgb, alpha = self.keyer(rgb_u8, warmup=warmup)
        else:
            rgb, alpha = self.keyer(rgb_u8)
        alpha = self._post_alpha(alpha, rgb_u8)
        out = np.empty(rgb_u8.shape[:2] + (4,), np.uint8)
        out[..., :3] = np.round(rgb * 255.0)
        out[..., 3] = np.round(alpha * 255.0)
        return out

    def _post_alpha(self, alpha: np.ndarray, rgb_u8: np.ndarray) -> np.ndarray:
        s, sc = self.s, self.px_scale
        if s.refine:
            guide = cv2.cvtColor(rgb_u8, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255.0
            r = max(1, int(round(2 * sc)))
            refined = _guided_filter(guide, alpha, r, 1e-4)
            # Nur im Uebergangsbereich wirken lassen, Kerne bleiben unveraendert.
            edge = cv2.dilate(((alpha > 0.02) & (alpha < 0.98)).astype(np.uint8),
                              np.ones((2 * r + 1, 2 * r + 1), np.uint8))
            alpha = np.where(edge > 0, np.clip(refined, 0, 1), alpha)
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
    bg_color: tuple = (255, 255, 255)   # fuer MP4 (keine Transparenz)


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

    alpha_out = job.fmt in ("webm", "mov")
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
                    out = rgba if alpha_out else composite(rgba, job.bg_color)
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
