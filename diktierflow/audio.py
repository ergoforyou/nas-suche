"""Mikrofonaufnahme mit Pegelanzeige und Aufteilung langer Diktate in Stücke.

Lange Diktate werden an Sprechpausen in Stücke geschnitten, die schon während
der Aufnahme transkribiert werden. So muss am Ende nur noch das letzte Stück
verarbeitet werden – auch nach 10 Minuten Diktat kommt der Text sofort.
"""

from __future__ import annotations

import io
import threading
import time
import wave
from pathlib import Path
from typing import Callable

import numpy as np


def to_wav_bytes(samples: np.ndarray, sample_rate: int) -> bytes:
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def save_wav(path: Path, samples: np.ndarray, sample_rate: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(to_wav_bytes(samples, sample_rate))


def load_wav(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as w:
        rate = w.getframerate()
        data = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2")
    return data.astype(np.float32) / 32767.0, rate


def rms(block: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(block)))) if block.size else 0.0


class ChunkSegmenter:
    """Entscheidet, wann ein Stück abgeschnitten wird (reine Logik, testbar).

    Schnitt, sobald das Stück >= min_s lang ist und eine Pause von pause_s
    erkannt wird, spätestens aber bei max_s.
    """

    def __init__(self, sample_rate: int, min_s: float, max_s: float,
                 silence_threshold: float, pause_s: float = 0.6):
        self.sr = sample_rate
        self.min_samples = int(min_s * sample_rate)
        self.max_samples = int(max_s * sample_rate)
        self.pause_samples = int(pause_s * sample_rate)
        self.threshold = silence_threshold
        self.blocks: list[np.ndarray] = []
        self.size = 0
        self.silent_run = 0

    def feed(self, block: np.ndarray) -> np.ndarray | None:
        self.blocks.append(block)
        self.size += len(block)
        if rms(block) < self.threshold:
            self.silent_run += len(block)
        else:
            self.silent_run = 0
        cut = (self.size >= self.min_samples and self.silent_run >= self.pause_samples) \
            or self.size >= self.max_samples
        return self.flush() if cut else None

    def flush(self) -> np.ndarray | None:
        if not self.blocks:
            return None
        chunk = np.concatenate(self.blocks)
        self.blocks, self.size, self.silent_run = [], 0, 0
        return chunk


class Recorder:
    """Nimmt vom Mikrofon auf. Callbacks laufen im Audio-Thread – kurz halten."""

    def __init__(self, sample_rate: int = 16000, device: str | None = None,
                 chunk_min_s: float = 25.0, chunk_max_s: float = 90.0,
                 silence_threshold: float = 0.012,
                 on_level: Callable[[float], None] | None = None,
                 on_chunk: Callable[[int, np.ndarray], None] | None = None):
        self.sample_rate = sample_rate
        self.device = device or None
        self.on_level = on_level
        self.on_chunk = on_chunk
        self.silence_threshold = silence_threshold
        self._chunk_cfg = (chunk_min_s, chunk_max_s)
        self._stream = None
        self._lock = threading.Lock()
        self._all: list[np.ndarray] = []
        self._segmenter: ChunkSegmenter | None = None
        self._chunk_index = 0
        self.started_at = 0.0
        self.last_voice_at = 0.0

    @property
    def recording(self) -> bool:
        return self._stream is not None

    def start(self) -> None:
        import sounddevice as sd  # erst hier importieren (Tests ohne Audiogerät)

        with self._lock:
            self._all = []
            self._chunk_index = 0
            self._segmenter = ChunkSegmenter(self.sample_rate, *self._chunk_cfg,
                                             silence_threshold=self.silence_threshold)
        self.started_at = self.last_voice_at = time.monotonic()
        self._stream = sd.InputStream(
            samplerate=self.sample_rate, channels=1, dtype="float32",
            blocksize=int(self.sample_rate * 0.05), device=self.device,
            callback=self._callback,
        )
        self._stream.start()

    def _callback(self, indata, frames, time_info, status) -> None:  # noqa: ARG002
        block = indata[:, 0].copy()
        level = rms(block)
        if level >= self.silence_threshold:
            self.last_voice_at = time.monotonic()
        if self.on_level:
            self.on_level(level)
        with self._lock:
            self._all.append(block)
            chunk = self._segmenter.feed(block) if self._segmenter else None
            idx = self._chunk_index
            if chunk is not None:
                self._chunk_index += 1
        if chunk is not None and self.on_chunk:
            self.on_chunk(idx, chunk)

    def stop(self) -> tuple[np.ndarray, tuple[int, np.ndarray] | None]:
        """Stoppt. Liefert (gesamte Aufnahme, letztes noch offenes Stück)."""
        if self._stream is not None:
            try:
                self._stream.stop()
                self._stream.close()
            finally:
                self._stream = None
        with self._lock:
            audio = np.concatenate(self._all) if self._all else np.zeros(0, np.float32)
            rest = self._segmenter.flush() if self._segmenter else None
            last = (self._chunk_index, rest) if rest is not None else None
            self._all = []
        return audio, last

    def seconds_since_voice(self) -> float:
        return time.monotonic() - self.last_voice_at

    def duration(self) -> float:
        return time.monotonic() - self.started_at if self.recording else 0.0
