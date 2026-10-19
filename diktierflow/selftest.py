"""Selbsttest: prüft Schritt für Schritt, ob auf diesem Rechner alles funktioniert.

Start: selbsttest.bat  bzw.  python -m diktierflow --selbsttest
"""

from __future__ import annotations

import importlib
import io
import os
import sys
import time

from .config import Config

OK, FAIL, SKIP = "OK  ", "FEHLER", "--  "


class Report:
    def __init__(self):
        self.failed = 0

    def line(self, status: str, title: str, detail: str = "") -> None:
        if status == FAIL:
            self.failed += 1
        print(f"[{status:^6}] {title}" + (f"\n          {detail}" if detail else ""))


NONINTERACTIVE = False


def _ask(prompt: str) -> bool:
    if NONINTERACTIVE:
        return False
    try:
        return input(f"\n{prompt} [J/n] ").strip().lower() in ("", "j", "ja", "y")
    except EOFError:
        return False


def check_packages(r: Report) -> None:
    print("\n1) Bibliotheken")
    needed = ["numpy", "sounddevice", "pynput", "pyperclip", "psutil", "PIL", "pystray",
              "anthropic", "openai"]
    if sys.platform == "win32":
        needed.append("uiautomation")
    for mod in needed:
        try:
            importlib.import_module(mod)
            r.line(OK, mod)
        except Exception as exc:  # noqa: BLE001
            r.line(FAIL, mod, f"{exc} – install.bat erneut ausführen")
    try:
        importlib.import_module("faster_whisper")
        r.line(OK, "faster_whisper (lokales Whisper)")
    except Exception:  # noqa: BLE001
        r.line(SKIP, "faster_whisper nicht installiert – nur Cloud-Erkennung möglich")


def check_keys(r: Report, cfg: Config) -> None:
    print("\n2) API-Schlüssel")
    if cfg.get_openai_key():
        try:
            from openai import OpenAI
            OpenAI(api_key=cfg.get_openai_key(), timeout=15).models.retrieve(cfg.cloud_stt_model)
            r.line(OK, f"OpenAI-Schlüssel gültig, Modell {cfg.cloud_stt_model} verfügbar")
        except Exception as exc:  # noqa: BLE001
            r.line(FAIL, "OpenAI-Schlüssel", str(exc)[:200])
    else:
        r.line(SKIP if cfg.stt_mode == "local" else FAIL, "Kein OpenAI-Schlüssel",
               "In den Einstellungen eintragen oder stt_mode auf 'local' stellen")
    if cfg.get_anthropic_key():
        from .postprocess import PostProcessError, PostProcessor
        pp = PostProcessor(cfg.get_anthropic_key(), cfg.llm_model, cfg.llm_effort,
                           timeout_s=30)
        try:
            t0 = time.monotonic()
            out = pp.clean("äh das ist ähm ein kleiner test", "clean")
            r.line(OK, f"Claude ({cfg.llm_model}) antwortet in {time.monotonic() - t0:.1f} s",
                   f"„äh das ist ähm ein kleiner test“ → „{out}“")
        except PostProcessError as exc:
            r.line(FAIL, "Claude", str(exc))
    else:
        r.line(FAIL, "Kein Anthropic-Schlüssel", "Ohne ihn gibt es nur einfache Bereinigung")


def check_microphone(r: Report, cfg: Config):
    print("\n3) Mikrofon")
    try:
        import numpy as np
        import sounddevice as sd
        dev = sd.query_devices(cfg.input_device or None, "input")
        r.line(OK, f"Eingabegerät: {dev['name']}")
    except Exception as exc:  # noqa: BLE001
        r.line(FAIL, "Kein Mikrofon gefunden", str(exc))
        return None
    if not _ask("Ich nehme jetzt 5 Sekunden auf. Sprich einen Satz, z. B. "
                "„Heute ist ein guter Tag zum Testen.“ Bereit?"):
        r.line(SKIP, "Aufnahme übersprungen")
        return None
    print("   Aufnahme läuft … ", end="", flush=True)
    audio = sd.rec(int(5 * cfg.sample_rate), samplerate=cfg.sample_rate, channels=1,
                   dtype="float32", device=cfg.input_device or None)
    sd.wait()
    print("fertig")
    samples = audio[:, 0]
    peak = float(np.max(np.abs(samples)))
    level = float(np.sqrt(np.mean(samples ** 2)))
    if peak < 0.02:
        r.line(FAIL, f"Sehr leise (Spitze {peak:.3f})",
               "Mikrofon stummgeschaltet? Windows: Einstellungen → Datenschutz → Mikrofon "
               "→ Desktop-Apps erlauben")
    else:
        r.line(OK, f"Pegel in Ordnung (Spitze {peak:.2f}, Mittel {level:.3f})")
    return samples


def check_transcription(r: Report, cfg: Config, samples) -> str:
    print("\n4) Spracherkennung")
    if samples is None:
        r.line(SKIP, "Keine Aufnahme vorhanden")
        return ""
    from .stt import CloudTranscriber, LocalTranscriber, TranscriptionError
    text = ""
    engines = []
    if cfg.get_openai_key():
        engines.append(CloudTranscriber(cfg.get_openai_key(), cfg.cloud_stt_model, cfg.language))
    local = LocalTranscriber(cfg.local_model, cfg.local_device, cfg.local_compute_type,
                             cfg.language)
    if local.available and _ask(f"Auch lokales Whisper ({cfg.local_model}) testen? Beim "
                                f"ersten Mal wird das Modell heruntergeladen (~1,6 GB)."):
        engines.append(local)
    for eng in engines:
        try:
            t0 = time.monotonic()
            out = eng.transcribe(samples, cfg.sample_rate)
            r.line(OK, f"{eng.name}: {time.monotonic() - t0:.1f} s", f"„{out.strip()}“")
            text = text or out
        except TranscriptionError as exc:
            r.line(FAIL, eng.name, str(exc)[:200])
    if not engines:
        r.line(SKIP, "Keine Erkennung konfiguriert")
    return text


def check_hotkey(r: Report, cfg: Config) -> None:
    print("\n5) Tastenkombination")
    from .hotkey import HotkeyManager
    hk = HotkeyManager()
    pressed = []
    hk.register("dictate", cfg.hotkey_dictate, lambda: pressed.append(time.monotonic()),
                lambda: None)
    hk.start()
    print(f"   Drücke jetzt {cfg.hotkey_dictate} (20 Sekunden Zeit) …")
    deadline = time.monotonic() + (2 if NONINTERACTIVE else 20)
    while not pressed and time.monotonic() < deadline:
        time.sleep(0.05)
    hk.stop()
    if pressed:
        r.line(OK, f"{cfg.hotkey_dictate} erkannt")
    else:
        r.line(FAIL, f"{cfg.hotkey_dictate} nicht erkannt",
               "Belegt ein anderes Programm (z. B. noch Wispr Flow) die Tasten? Dann beenden "
               "oder in den Einstellungen eine andere Kombination wählen.")


def check_paste(r: Report) -> None:
    print("\n6) Einfügen in andere Programme")
    if not _ask("Öffne gleich den Editor (Notepad) und klicke hinein. Ich warte 8 Sekunden "
                "und füge dann einen Testsatz ein. Starten?"):
        r.line(SKIP, "Einfügen übersprungen")
        return
    from . import textio
    for i in range(8, 0, -1):
        print(f"   {i} …", end="\r", flush=True)
        time.sleep(1)
    app, _title = textio.foreground_app()
    textio.paste_text("DiktierFlow-Test: Wenn du diesen Satz siehst, klappt das Einfügen. ")
    r.line(OK if _ask(f"Eingefügt in „{app or '?'}“. Ist der Satz dort erschienen?") else FAIL,
           "Einfügen per Zwischenablage")


def _setup_console() -> None:
    """Die EXE hat kein Konsolenfenster – für den Selbsttest eines öffnen.

    Mit DIKTIERFLOW_SELFTEST_OUT=<Datei> läuft der Test ohne Rückfragen und
    schreibt in die Datei (für den automatischen Build-Test).
    """
    global NONINTERACTIVE
    out = os.environ.get("DIKTIERFLOW_SELFTEST_OUT")
    if out:
        NONINTERACTIVE = True
        sys.stdout = open(out, "w", encoding="utf-8")  # noqa: SIM115
        sys.stdin = io.StringIO("")
        return
    if sys.stdout is None and sys.platform == "win32":
        import ctypes
        ctypes.windll.kernel32.AllocConsole()
        sys.stdout = open("CONOUT$", "w", encoding="utf-8")  # noqa: SIM115
        sys.stdin = open("CONIN$", encoding="utf-8")  # noqa: SIM115


def main() -> int:
    _setup_console()
    print("DiktierFlow – Selbsttest\n" + "=" * 40)
    cfg = Config.load()
    print(f"Einstellungen: {Config.path()}")
    r = Report()

    def run(check, *args):
        try:
            return check(r, *args)
        except Exception as exc:  # noqa: BLE001 – ein Fehler soll den Test nicht abbrechen
            r.line(FAIL, check.__name__.replace("check_", "Prüfung "), repr(exc)[:200])
            return None

    run(check_packages)
    run(check_keys, cfg)
    samples = run(check_microphone, cfg)
    run(check_transcription, cfg, samples)
    run(check_hotkey, cfg)
    run(check_paste)
    print("\n" + "=" * 40)
    if r.failed:
        print(f"{r.failed} Punkt(e) fehlgeschlagen – siehe oben.")
    else:
        print("Alles in Ordnung. Starte DiktierFlow und diktiere los.")
    sys.stdout.flush()
    if NONINTERACTIVE:
        return 1 if r.failed else 0
    try:
        input("\nEnter zum Beenden …")
    except EOFError:
        pass
    return 1 if r.failed else 0
