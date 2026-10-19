"""Start: python -m diktierflow"""

from __future__ import annotations

import logging
import os
import sys
from logging.handlers import RotatingFileHandler

from .config import Config, data_dir


def _setup_logging() -> None:
    handler = RotatingFileHandler(data_dir() / "diktierflow.log", maxBytes=2_000_000,
                                  backupCount=2, encoding="utf-8")
    handlers: list[logging.Handler] = [handler]
    if sys.stderr is not None:  # pythonw hat keine Konsole
        handlers.append(logging.StreamHandler())
    logging.basicConfig(level=logging.INFO, handlers=handlers,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")


def _single_instance() -> object | None:
    """Verhindert, dass das Programm zweimal läuft (Windows-Mutex)."""
    if sys.platform != "win32":
        return True
    import ctypes
    handle = ctypes.windll.kernel32.CreateMutexW(None, False, "DiktierFlowSingleInstance")
    if ctypes.windll.kernel32.GetLastError() == 183:  # ERROR_ALREADY_EXISTS
        return None
    return handle


def main() -> None:
    _setup_logging()
    log = logging.getLogger("diktierflow")
    if _single_instance() is None:
        log.info("DiktierFlow läuft bereits.")
        return

    if sys.platform == "win32":
        try:  # scharfe Darstellung auf HiDPI-Bildschirmen
            import ctypes
            ctypes.windll.shcore.SetProcessDpiAwareness(1)
        except Exception:  # noqa: BLE001
            pass

    from .app import DiktierApp
    from .tray import Tray
    from .ui.main import UI

    cfg = Config.load()
    ui = UI()
    app = DiktierApp(cfg, ui)
    ui.app = app
    restart = {"flag": False}

    def quit_():
        tray.stop()
        ui.quit()

    def restart_():
        restart["flag"] = True
        quit_()

    tray = Tray(app, ui, on_quit=quit_, on_restart=restart_)
    app.start()
    tray.start()
    if not cfg.get_openai_key() and not cfg.get_anthropic_key() and not cfg.privacy_mode:
        ui.toast("Willkommen! Bitte API-Schlüssel in den Einstellungen hinterlegen "
                 "(Tray-Symbol → Einstellungen) oder den Datenschutz-Modus nutzen.")
        ui.open_settings()
    else:
        ui.toast(f"DiktierFlow läuft – {cfg.hotkey_dictate} zum Diktieren")
    log.info("DiktierFlow gestartet")
    try:
        ui.run()
    finally:
        app.shutdown()
    if restart["flag"]:
        os.execv(sys.executable, [sys.executable, *sys.argv]) if getattr(sys, "frozen", False) \
            else os.execv(sys.executable, [sys.executable, "-m", "diktierflow"])


if __name__ == "__main__":
    main()
