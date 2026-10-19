"""Spracherkennung: Cloud (OpenAI gpt-4o-transcribe), lokal (faster-whisper) oder hybrid."""

from __future__ import annotations

import logging
import re
import threading

import numpy as np

from .audio import rms, to_wav_bytes

log = logging.getLogger(__name__)

# Typische Whisper-Halluzinationen bei Stille (deutsch trainiert auf Untertiteln)
HALLUCINATIONS = [
    r"untertitel(ung)? (im auftrag )?(des|der|von) .*",
    r"untertitel der amara\.org.?community",
    r"vielen dank (fürs|für's) zuschauen\.?",
    r"(bis zum nächsten mal|tschüss)\.?",
    r"copyright .*",
    r"swr \d+",
]
_HALLU_RE = re.compile(r"^\s*(" + "|".join(HALLUCINATIONS) + r")\s*$", re.IGNORECASE)


def clean_transcript(text: str) -> str:
    text = (text or "").strip()
    if _HALLU_RE.match(text):
        return ""
    return re.sub(r"\s+", " ", text)


class TranscriptionError(RuntimeError):
    pass


class CloudTranscriber:
    name = "cloud"

    def __init__(self, api_key: str, model: str, language: str):
        self.api_key = api_key
        self.model = model
        self.language = language
        self._client = None

    @property
    def available(self) -> bool:
        return bool(self.api_key)

    def _get_client(self):
        if self._client is None:
            from openai import OpenAI
            self._client = OpenAI(api_key=self.api_key, timeout=60.0, max_retries=1)
        return self._client

    def transcribe(self, samples: np.ndarray, sample_rate: int, prompt: str = "") -> str:
        if not self.available:
            raise TranscriptionError("Kein OpenAI-API-Schlüssel hinterlegt")
        try:
            resp = self._get_client().audio.transcriptions.create(
                model=self.model,
                file=("diktat.wav", to_wav_bytes(samples, sample_rate), "audio/wav"),
                language=self.language or None,
                prompt=prompt or None,
            )
        except Exception as exc:  # Netzwerk, Quote, Schlüssel …
            raise TranscriptionError(f"Cloud-Erkennung fehlgeschlagen: {exc}") from exc
        return resp.text


class LocalTranscriber:
    name = "local"

    def __init__(self, model: str, device: str, compute_type: str, language: str):
        self.model_name = model
        self.device = device
        self.compute_type = compute_type
        self.language = language
        self._model = None
        self._load_lock = threading.Lock()

    @property
    def available(self) -> bool:
        try:
            import faster_whisper  # noqa: F401
        except ImportError:
            return False
        return True

    def load(self):
        with self._load_lock:
            if self._model is None:
                from faster_whisper import WhisperModel
                log.info("Lade lokales Whisper-Modell %s …", self.model_name)
                self._model = WhisperModel(self.model_name, device=self.device,
                                           compute_type=self.compute_type)
        return self._model

    def transcribe(self, samples: np.ndarray, sample_rate: int, prompt: str = "") -> str:
        if not self.available:
            raise TranscriptionError("faster-whisper ist nicht installiert")
        if sample_rate != 16000:
            raise TranscriptionError("Lokales Whisper erwartet 16 kHz")
        model = self.load()
        segments, _info = model.transcribe(
            samples.astype(np.float32),
            language=self.language or None,
            initial_prompt=prompt or None,
            hotwords=prompt or None,
            vad_filter=True,
            beam_size=5,
            condition_on_previous_text=False,
        )
        return " ".join(s.text.strip() for s in segments)


class HybridTranscriber:
    """Wählt die Engine je nach Modus; fällt bei Cloud-Fehlern auf lokal zurück."""

    def __init__(self, cloud: CloudTranscriber, local: LocalTranscriber, mode: str,
                 silence_threshold: float = 0.008):
        self.cloud = cloud
        self.local = local
        self.mode = mode
        self.privacy_mode = False
        self.silence_threshold = silence_threshold

    def engines(self) -> list:
        if self.privacy_mode or self.mode == "local":
            return [self.local]
        if self.mode == "cloud":
            return [self.cloud]
        order = [self.cloud, self.local]
        return [e for e in order if e.available] or order

    def transcribe(self, samples: np.ndarray, sample_rate: int,
                   prompt: str = "") -> tuple[str, str]:
        """Liefert (Text, verwendete Engine)."""
        if samples.size < sample_rate * 0.3 or rms(samples) < self.silence_threshold:
            return "", "none"
        errors = []
        for engine in self.engines():
            try:
                return clean_transcript(engine.transcribe(samples, sample_rate, prompt)), \
                    engine.name
            except TranscriptionError as exc:
                log.warning("%s", exc)
                errors.append(str(exc))
        raise TranscriptionError("; ".join(errors) or "Keine Spracherkennung verfügbar")
