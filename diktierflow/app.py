"""Zentrale Steuerung: Taste -> Aufnahme -> Erkennung -> Nachbearbeitung -> Einfügen."""

from __future__ import annotations

import logging
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np

from . import learning, textio
from .audio import Recorder, load_wav, save_wav
from .config import Config, data_dir
from .hotkey import HotkeyManager, PressLogic
from .postprocess import PostProcessError, PostProcessor, basic_cleanup
from .storage import Storage
from .stt import CloudTranscriber, HybridTranscriber, LocalTranscriber, TranscriptionError

log = logging.getLogger(__name__)


@dataclass
class Session:
    """Eine laufende Aufnahme."""
    mode: str                          # "dictate" | "variants" | "command"
    app: str | None
    window_title: str | None
    hwnd: int | None
    started: float = field(default_factory=time.monotonic)
    chunks: dict[int, Future] = field(default_factory=dict)
    cancelled: bool = False


class DiktierApp:
    def __init__(self, cfg: Config, ui=None):
        self.cfg = cfg
        self.ui = ui
        self.storage = Storage(data_dir() / "diktierflow.db")
        self.audio_dir = data_dir() / "audio"
        self.pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="stt")
        self.transcriber = HybridTranscriber(
            CloudTranscriber(cfg.get_openai_key(), cfg.cloud_stt_model, cfg.language),
            LocalTranscriber(cfg.local_model, cfg.local_device, cfg.local_compute_type,
                             cfg.language),
            cfg.stt_mode,
        )
        self.transcriber.privacy_mode = cfg.privacy_mode
        self.post = PostProcessor(cfg.get_anthropic_key(), cfg.llm_model, cfg.llm_effort,
                                  cfg.llm_effort_variants, cfg.llm_timeout_s)
        self.recorder = Recorder(
            cfg.sample_rate, cfg.input_device or None, cfg.chunk_min_s, cfg.chunk_max_s,
            cfg.silence_threshold, on_level=self._on_level, on_chunk=self._on_chunk,
        )
        self.hotkeys = HotkeyManager()
        self.watcher = textio.EditWatcher(self._on_field_text)
        self.session: Session | None = None
        # Diktate werden nacheinander verarbeitet/eingefügt; währenddessen kann
        # schon das nächste aufgenommen werden.
        self.finisher = ThreadPoolExecutor(max_workers=1, thread_name_prefix="finish")
        self._stt_prompt = ""

    # ---------------------------------------------------------------- Lebenszyklus
    def start(self) -> None:
        cfg = self.cfg
        for name, combo in (("dictate", cfg.hotkey_dictate),
                            ("variants", cfg.hotkey_variants),
                            ("command", cfg.hotkey_command)):
            if not combo:
                continue
            logic = PressLogic(cfg.hotkey_mode, cfg.hold_threshold_s,
                               start=lambda m=name: self.start_recording(m),
                               stop=self.stop_recording,
                               is_recording=lambda: self.session is not None)
            self.hotkeys.register(name, combo, logic.press, logic.release)
        self.hotkeys.on_escape = self.cancel_recording
        self.hotkeys.start()
        self.watcher.start()
        self.refresh_learning()
        threading.Thread(target=self._housekeeping, daemon=True).start()
        if cfg.preload_local_model and (cfg.stt_mode != "cloud" or cfg.privacy_mode):
            self.pool.submit(self.transcriber.local.load)
        self._state("idle", self._status_line())

    def shutdown(self) -> None:
        self.hotkeys.stop()
        self.watcher.stop()
        self.pool.shutdown(wait=False, cancel_futures=True)
        self.finisher.shutdown(wait=False, cancel_futures=True)
        self.storage.close()

    def set_privacy_mode(self, on: bool) -> None:
        self.cfg.privacy_mode = on
        self.cfg.save()
        self.transcriber.privacy_mode = on
        self._ui("toast", "Datenschutz-Modus " + ("an – alles bleibt lokal" if on else "aus"))

    def _status_line(self) -> str:
        if self.cfg.privacy_mode:
            return "Datenschutz-Modus (lokal)"
        return f"Bereit – {self.cfg.hotkey_dictate}"

    def _state(self, state: str, text: str) -> None:
        # Läuft schon die nächste Aufnahme, soll deren Anzeige nicht verschwinden
        if self.session is not None and state != "recording":
            if state == "error":
                self._ui("toast", text)
            return
        self._ui("set_state", state, text)

    def _ui(self, method: str, *args):
        if self.ui is not None:
            return getattr(self.ui, method)(*args)
        return None

    # ---------------------------------------------------------------- Lernen
    def refresh_learning(self) -> None:
        active = self.storage.active_corrections(self.cfg.learn_threshold)
        self._corrections = [(c.wrong, c.right) for c in active]
        self._terms = self.storage.list_terms()
        self._stt_prompt = learning.build_stt_prompt(self._terms, self._corrections)

    def glossary(self) -> list[str]:
        return list(dict.fromkeys([*self._terms, *(r for _, r in self._corrections)]))

    def _on_field_text(self, dictation_id: int, inserted: str, field_text: str) -> None:
        """Vom EditWatcher: Feldinhalt einige Sekunden nach dem Einfügen."""
        if not self.cfg.learn_from_edits:
            return
        region = learning.locate_inserted(field_text, inserted)
        if not region or region == inserted.strip():
            return
        self.storage.update_dictation(dictation_id, edited_text=region)
        self.learn_from_edit(inserted, region, manual=False)

    def learn_from_edit(self, before: str, after: str, manual: bool) -> list[tuple[str, str]]:
        learned = []
        for wrong, right in learning.extract_corrections(before, after):
            corr = self.storage.record_correction(
                wrong, right, source="manual" if manual else "auto", confirm=manual)
            if corr.confirmed or corr.count >= self.cfg.learn_threshold:
                learned.append((wrong, right))
                for term in learning.vocabulary_candidates(right):
                    self.storage.add_term(term, source="learned")
        if learned:
            self.refresh_learning()
            self._ui("toast", "Gelernt: " + ", ".join(f"„{w}“ → „{r}“" for w, r in learned))
        return learned

    # ---------------------------------------------------------------- Aufnahme
    def start_recording(self, mode: str) -> None:
        if self.session is not None:
            return
        app, title = textio.foreground_app()
        self.session = Session(mode=mode, app=app, window_title=title,
                               hwnd=textio.foreground_hwnd())
        try:
            self.recorder.start()
        except Exception as exc:  # noqa: BLE001 – Mikrofon fehlt/belegt
            self.session = None
            log.exception("Aufnahme konnte nicht starten")
            self._error(f"Mikrofon-Fehler: {exc}")
            return
        if self.cfg.sounds:
            textio.beep("start")
        label = {"dictate": "Diktat", "variants": "Diktat + Varianten",
                 "command": "Befehl"}[mode]
        self._ui("set_state", "recording", label)
        if self.cfg.auto_stop_silence_s > 0:
            threading.Thread(target=self._auto_stop_watch, args=(self.session,),
                             daemon=True).start()

    def _auto_stop_watch(self, session: Session) -> None:
        while self.session is session:
            time.sleep(0.25)
            if self.recorder.seconds_since_voice() > self.cfg.auto_stop_silence_s:
                self.stop_recording()
                return

    def _on_level(self, level: float) -> None:
        if self.session is not None:
            self._ui("set_level", level, time.monotonic() - self.session.started)

    def _on_chunk(self, index: int, samples: np.ndarray) -> None:
        session = self.session
        if session is not None:
            session.chunks[index] = self.pool.submit(self._transcribe, samples)

    def _transcribe(self, samples: np.ndarray) -> tuple[str, str]:
        return self.transcriber.transcribe(samples, self.cfg.sample_rate, self._stt_prompt)

    def cancel_recording(self) -> None:
        session = self.session
        if session is None:
            return
        session.cancelled = True
        self.session = None
        self.recorder.stop()
        for f in session.chunks.values():
            f.cancel()
        self._state("idle", "Abgebrochen")

    def stop_recording(self) -> None:
        session = self.session
        if session is None:
            return
        self.session = None
        audio, last = self.recorder.stop()
        if self.cfg.sounds:
            textio.beep("stop")
        if last is not None:
            session.chunks[last[0]] = self.pool.submit(self._transcribe, last[1])
        self.finisher.submit(self._finish, session, audio)

    # ---------------------------------------------------------------- Verarbeitung
    def _finish(self, session: Session, audio: np.ndarray) -> None:
        try:
            self._finish_inner(session, audio)
        except Exception as exc:  # noqa: BLE001
            log.exception("Verarbeitung fehlgeschlagen")
            self._error(str(exc))

    def _finish_inner(self, session: Session, audio: np.ndarray) -> None:
        duration = len(audio) / self.cfg.sample_rate
        if duration < 0.3:
            self._state("idle", "Zu kurz")
            return
        self._state("processing", "Erkenne Sprache …")
        audio_path = self._save_audio(audio)
        parts, engines = [], set()
        try:
            for idx in sorted(session.chunks):
                text, engine = session.chunks[idx].result()
                engines.add(engine)
                if text:
                    parts.append(text)
        except TranscriptionError as exc:
            self.storage.add_dictation(raw_text="", final_text="", mode=session.mode,
                                       app=session.app, window_title=session.window_title,
                                       duration_s=duration, audio_path=audio_path)
            self._error(f"{exc} – Audio ist im Verlauf gespeichert.")
            return
        raw = " ".join(parts).strip()
        engine = "+".join(sorted(engines - {"none"})) or "none"
        if not raw:
            self._state("idle", "Nichts verstanden")
            return

        if session.mode == "command":
            self._run_command(session, raw, duration, engine, audio_path)
            return

        corrected = learning.apply_corrections(raw, self._corrections)
        style = self.cfg.style_for_app(session.app)
        want_variants = session.mode == "variants" or self.cfg.always_show_variants

        if want_variants and self._llm_allowed():
            final, variants = self._choose_variant(session, corrected)
            if final is None:
                self.storage.add_dictation(
                    raw_text=raw, final_text=corrected, mode="variants", app=session.app,
                    window_title=session.window_title, style=style, stt_engine=engine,
                    duration_s=duration, variants=variants, audio_path=audio_path)
                self._state("idle", "Nicht eingefügt – im Verlauf")
                return
        else:
            self._state("processing", "Formuliere …")
            final, variants = self.polish(corrected, style), None

        dictation_id = self.storage.add_dictation(
            raw_text=raw, final_text=final, mode=session.mode, app=session.app,
            window_title=session.window_title, style=style, stt_engine=engine,
            duration_s=duration, variants=variants, audio_path=audio_path)
        self.insert(final, session)
        self.watcher.watch(textio.EditWatchJob(dictation_id, final,
                                               list(self.cfg.edit_check_delays_s)))
        self._state("idle", f"Eingefügt ({len(final.split())} Wörter)")

    def _llm_allowed(self) -> bool:
        return self.cfg.llm_enabled and not self.cfg.privacy_mode and self.post.available

    def polish(self, text: str, style: str) -> str:
        """Rohtext -> fertiger Text (Claude, sonst Offline-Bereinigung)."""
        if style == "raw":
            return text
        if self._llm_allowed():
            try:
                return self.post.clean(text, style, self.glossary(), self.storage.snippets())
            except PostProcessError as exc:
                log.warning("%s – verwende Offline-Bereinigung", exc)
                self._ui("toast", f"{exc} – einfache Bereinigung verwendet")
        return basic_cleanup(text)

    def _choose_variant(self, session: Session, text: str
                        ) -> tuple[str | None, list[dict] | None]:
        labels = list(self.cfg.variant_labels)
        pending: Future = self.pool.submit(self.post.variants, text, labels, self.glossary())
        self._state("processing", "Erzeuge Varianten …")
        choice = self._ui("choose_variant", labels, pending, text)
        variants = None
        if pending.done() and not pending.exception():
            variants = [{"label": lbl, "text": t} for lbl, t in zip(labels, pending.result())]
        if choice is None:
            return None, variants
        textio.focus_window(session.hwnd)
        return choice, variants

    def _run_command(self, session: Session, instruction: str, duration: float,
                     engine: str, audio_path: str | None) -> None:
        if not self._llm_allowed():
            self._error("Befehls-Modus braucht Claude (nicht im Datenschutz-Modus)")
            return
        self.hotkeys.wait_modifiers_released()
        textio.focus_window(session.hwnd)
        selected = textio.copy_selection()
        self._state("processing", "Führe Befehl aus …")
        try:
            result = self.post.command(instruction, selected, self.glossary())
        except PostProcessError as exc:
            self._error(str(exc))
            return
        self.storage.add_dictation(
            raw_text=instruction, final_text=result, mode="command", app=session.app,
            window_title=session.window_title, stt_engine=engine, duration_s=duration,
            variants=[{"label": "markiert", "text": selected}] if selected else None,
            audio_path=audio_path)
        self.insert(result, session, trailing_space=False)
        self._state("idle", "Befehl ausgeführt")

    # ---------------------------------------------------------------- Einfügen
    def insert(self, text: str, session: Session | None = None,
               trailing_space: bool | None = None) -> None:
        if trailing_space is None:
            trailing_space = self.cfg.add_trailing_space
        if trailing_space and text and not text.endswith(("\n", " ")):
            text += " "
        self.hotkeys.wait_modifiers_released()
        app = session.app if session else textio.foreground_app()[0]
        textio.paste_text(text, shift_paste=(app or "") in self.cfg.shift_paste_apps,
                          restore=self.cfg.restore_clipboard)

    def paste_dictation(self, dictation_id: int) -> None:
        """Verlauf: Eintrag erneut an der aktuellen Cursorposition einfügen."""
        d = self.storage.get_dictation(dictation_id)
        if d:
            self.insert(d.best_text)

    def paste_last(self) -> None:
        d = self.storage.last_dictation()
        if d:
            self.insert(d.best_text)

    def retranscribe(self, dictation_id: int) -> str | None:
        """Gespeichertes Audio erneut erkennen und bereinigen (z. B. nach Fehler)."""
        d = self.storage.get_dictation(dictation_id)
        if not d or not d.audio_path or not Path(d.audio_path).exists():
            return None
        samples, rate = load_wav(Path(d.audio_path))
        raw, engine = self.transcriber.transcribe(samples, rate, self._stt_prompt)
        final = self.polish(learning.apply_corrections(raw, self._corrections),
                            d.style or self.cfg.default_style)
        self.storage.update_dictation(dictation_id, raw_text=raw, final_text=final,
                                      stt_engine=engine)
        return final

    # ---------------------------------------------------------------- Hilfen
    def _save_audio(self, audio: np.ndarray) -> str | None:
        if not self.cfg.save_audio:
            return None
        path = self.audio_dir / f"{datetime.now():%Y%m%d-%H%M%S}.wav"
        try:
            save_wav(path, audio, self.cfg.sample_rate)
        except OSError:
            log.warning("Audio konnte nicht gespeichert werden", exc_info=True)
            return None
        return str(path)

    def _housekeeping(self) -> None:
        """Alte Audiodateien löschen (Texte bleiben im Verlauf)."""
        if not self.audio_dir.exists() or self.cfg.keep_audio_days <= 0:
            return
        cutoff = (datetime.now() - timedelta(days=self.cfg.keep_audio_days)).timestamp()
        for f in self.audio_dir.glob("*.wav"):
            try:
                if f.stat().st_mtime < cutoff:
                    f.unlink()
            except OSError:
                pass

    def _error(self, message: str) -> None:
        if self.cfg.sounds:
            textio.beep("error")
        self._state("error", message)
