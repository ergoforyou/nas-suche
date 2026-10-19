"""Text in andere Programme einfügen, Markierung lesen, aktives Programm erkennen,
und das Textfeld später erneut lesen (für das Lernen aus Korrekturen).

Windows-spezifische Teile sind gekapselt; auf anderen Systemen gibt es
einfache Fallbacks, damit sich der Rest testen lässt.
"""

from __future__ import annotations

import logging
import queue
import sys
import threading
import time
from dataclasses import dataclass
from typing import Callable

log = logging.getLogger(__name__)
IS_WINDOWS = sys.platform == "win32"


# ---------------------------------------------------------------- aktives Fenster
def foreground_app() -> tuple[str | None, str | None]:
    """(Prozessname, Fenstertitel) des Vordergrundfensters."""
    if not IS_WINDOWS:
        return None, None
    try:
        import ctypes
        from ctypes import wintypes

        import psutil

        user32 = ctypes.windll.user32
        hwnd = user32.GetForegroundWindow()
        length = user32.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        name = psutil.Process(pid.value).name().lower() if pid.value else None
        return name, buf.value
    except Exception:  # noqa: BLE001 – darf das Diktat nie verhindern
        log.debug("foreground_app fehlgeschlagen", exc_info=True)
        return None, None


def foreground_hwnd() -> int | None:
    if not IS_WINDOWS:
        return None
    import ctypes
    return int(ctypes.windll.user32.GetForegroundWindow()) or None


def focus_window(hwnd: int | None) -> None:
    """Holt ein Fenster zurück in den Vordergrund (nach dem Auswahlfenster)."""
    if not IS_WINDOWS or not hwnd:
        return
    try:
        import ctypes
        user32 = ctypes.windll.user32
        # Windows erlaubt SetForegroundWindow nur nach einer "Eingabe": kurzes Alt
        user32.keybd_event(0x12, 0, 0, 0)
        user32.keybd_event(0x12, 0, 2, 0)
        user32.SetForegroundWindow(hwnd)
        time.sleep(0.12)
    except Exception:  # noqa: BLE001
        log.debug("focus_window fehlgeschlagen", exc_info=True)


def beep(kind: str) -> None:
    """Kurzer Signalton (nicht blockierend)."""
    if not IS_WINDOWS:
        return

    def _play():
        import winsound
        freq, ms = {"start": (880, 70), "stop": (620, 70), "error": (300, 200)}.get(
            kind, (700, 60))
        try:
            winsound.Beep(freq, ms)
        except RuntimeError:
            pass
    threading.Thread(target=_play, daemon=True).start()


# ----------------------------------------------------------------- Zwischenablage
def get_clipboard() -> str:
    import pyperclip
    try:
        return pyperclip.paste() or ""
    except Exception:  # noqa: BLE001
        return ""


def set_clipboard(text: str) -> None:
    import pyperclip
    pyperclip.copy(text)


def _send_combo(*keys) -> None:
    from pynput.keyboard import Controller

    kb = Controller()
    for k in keys:
        kb.press(k)
    for k in reversed(keys):
        kb.release(k)


def paste_text(text: str, *, shift_paste: bool = False, restore: bool = True) -> None:
    """Fügt Text über die Zwischenablage an der Cursorposition ein."""
    from pynput.keyboard import Key, KeyCode

    previous = get_clipboard() if restore else None
    set_clipboard(text)
    time.sleep(0.05)
    v = KeyCode.from_char("v")
    if shift_paste:
        _send_combo(Key.ctrl, Key.shift, v)
    else:
        _send_combo(Key.ctrl, v)
    if restore and previous is not None:
        # Ziel-App braucht einen Moment, um die Zwischenablage zu lesen
        def _restore():
            time.sleep(0.6)
            if get_clipboard() == text:
                set_clipboard(previous)
        threading.Thread(target=_restore, daemon=True).start()


def copy_selection(timeout: float = 0.5) -> str:
    """Liest den aktuell markierten Text (per Strg+C), Zwischenablage bleibt erhalten."""
    from pynput.keyboard import Key, KeyCode

    previous = get_clipboard()
    sentinel = f"__diktierflow_{time.time_ns()}__"
    set_clipboard(sentinel)
    _send_combo(Key.ctrl, KeyCode.from_char("c"))
    deadline = time.monotonic() + timeout
    selected = ""
    while time.monotonic() < deadline:
        time.sleep(0.03)
        current = get_clipboard()
        if current != sentinel:
            selected = current
            break
    set_clipboard(previous)
    return selected


# ------------------------------------------------- Textfeld später erneut lesen
@dataclass
class EditWatchJob:
    dictation_id: int
    inserted_text: str
    delays: list[float]


class EditWatcher:
    """Liest nach dem Einfügen das fokussierte Textfeld mehrfach erneut.

    Läuft in einem eigenen Thread, weil UI Automation (COM) threadgebunden ist.
    Ruft `on_text(dictation_id, inserted_text, field_text)` mit dem jeweils
    aktuellen Feldinhalt auf. Erkennt das Programm, dass der Fokus inzwischen
    woanders ist, wird der zuletzt gelesene Stand verwendet.
    """

    def __init__(self, on_text: Callable[[int, str, str], None]):
        self.on_text = on_text
        self._jobs: queue.Queue[EditWatchJob | None] = queue.Queue()
        self._thread = threading.Thread(target=self._run, name="EditWatcher", daemon=True)
        self._cancel = threading.Event()

    @property
    def supported(self) -> bool:
        if not IS_WINDOWS:
            return False
        try:
            import uiautomation  # noqa: F401
        except ImportError:
            return False
        return True

    def start(self) -> None:
        if self.supported:
            self._thread.start()

    def watch(self, job: EditWatchJob) -> None:
        if self.supported:
            # ein neues Diktat beendet die Beobachtung des alten (mit letztem Stand)
            self._cancel.set()
            self._jobs.put(job)

    def stop(self) -> None:
        self._cancel.set()
        self._jobs.put(None)

    # --------------------------------------------------------------
    def _run(self) -> None:
        import uiautomation as auto

        with auto.UIAutomationInitializerInThread():
            while True:
                job = self._jobs.get()
                if job is None:
                    return
                self._cancel.clear()
                try:
                    self._process(auto, job)
                except Exception:  # noqa: BLE001
                    log.debug("EditWatcher-Fehler", exc_info=True)

    def _process(self, auto, job: EditWatchJob) -> None:
        time.sleep(0.4)  # Einfügen abschließen lassen
        control = auto.GetFocusedControl()
        if control is None:
            return
        runtime_id = tuple(control.GetRuntimeId() or ())
        last_text = self._read(control)
        if last_text is None:
            return  # Feld nicht auslesbar (z. B. manche Electron-Apps)
        started = time.monotonic()
        for delay in job.delays:
            remaining = delay - (time.monotonic() - started)
            if remaining > 0 and self._cancel.wait(remaining):
                break
            text = self._read(control)
            if text is not None:
                last_text = text
            focused = auto.GetFocusedControl()
            if focused is None or tuple(focused.GetRuntimeId() or ()) != runtime_id:
                # Nutzer hat das Feld verlassen -> Bearbeitung vermutlich fertig
                break
        self.on_text(job.dictation_id, job.inserted_text, last_text)

    @staticmethod
    def _read(control) -> str | None:
        try:
            vp = control.GetValuePattern()
            if vp:
                value = vp.Value
                if value:
                    return value
        except Exception:  # noqa: BLE001
            pass
        try:
            tp = control.GetTextPattern()
            if tp:
                return tp.DocumentRange.GetText(200_000)
        except Exception:  # noqa: BLE001
            pass
        return None
