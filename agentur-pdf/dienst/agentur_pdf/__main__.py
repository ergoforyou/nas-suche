"""Startpunkt: ``python -m agentur_pdf [Dateien …]``.

Startet den lokalen Dienst auf 127.0.0.1 und öffnet die Oberfläche
* unter Windows in einem eigenen App-Fenster (pywebview / WebView2),
* sonst bzw. mit ``--browser`` im Standardbrowser.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import signal
import socket
import sys
import threading
import time
import webbrowser
from pathlib import Path

import uvicorn

from . import PRODUKT, STAND
from .api.app import erstelle_app
from .api.sicherheit import neues_token
from .benutzer.speicher import BenutzerSpeicher
from .kern.dokumente import DokumentSpeicher
from .windows import instanz

DATEITYPEN = ("PDF und Bilder (*.pdf;*.png;*.jpg;*.jpeg;*.tif;*.tiff;*.bmp)", "Alle Dateien (*.*)")


SPEICHER_FILTER = {
    ".pdf": "PDF-Dokument (*.pdf)",
    ".png": "PNG-Bild (*.png)",
    ".jpg": "JPG-Bild (*.jpg)",
    ".zip": "ZIP-Archiv (*.zip)",
    ".txt": "Textdatei (*.txt)",
}


def oberflaeche_ordner() -> Path | None:
    """Fertig gebaute Oberfläche suchen (PyInstaller-Paket oder Quellbaum)."""
    kandidaten = []
    if getattr(sys, "_MEIPASS", None):
        kandidaten.append(Path(sys._MEIPASS) / "oberflaeche")
    kandidaten.append(Path(__file__).resolve().parents[2] / "oberflaeche" / "dist")
    for ordner in kandidaten:
        if (ordner / "index.html").is_file():
            return ordner
    return None


# Fester Port, damit die Chrome-Seitenleiste den Dienst findet (sonst zufällig)
BEVORZUGTER_PORT = 47811


def freier_port() -> int:
    for wunsch in (BEVORZUGTER_PORT, 0):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", wunsch))
            except OSError:
                continue
            return s.getsockname()[1]
    raise OSError("Kein freier Port")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="agentur-pdf", description="Ergo4You PDF starten")
    parser.add_argument("dateien", nargs="*", help="Dateien, die sofort geöffnet werden")
    aktionen = parser.add_mutually_exclusive_group()
    aktionen.add_argument("--zusammenfuehren", action="store_true", help="Dateien zu einer PDF zusammenführen (Dialog)")
    aktionen.add_argument("--umwandeln", action="store_true", help="Dateien in PDF umwandeln und daneben speichern")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--browser", action="store_true", help="Im Standardbrowser statt im App-Fenster öffnen")
    parser.add_argument("--nur-dienst", action="store_true", help="Nur den Dienst starten (Entwicklung)")
    parser.add_argument("--neue-instanz", action="store_true", help="Nicht an laufende Instanz weiterreichen")
    parser.add_argument("--token", default=None, help="Festes Token (nur Entwicklung)")
    parser.add_argument("--explorer-einrichten", action="store_true", help="Rechtsklick-Einträge im Explorer anlegen")
    parser.add_argument("--explorer-entfernen", action="store_true", help="Rechtsklick-Einträge entfernen")
    parser.add_argument("--explorer-reg", metavar="DATEI", help="Rechtsklick-Einträge als .reg-Datei exportieren")
    parser.add_argument("--nach-update", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--drucker-einrichten", action="store_true", help="PDF-Drucker „Ergo4You PDF“ einrichten (Adminrechte)")
    parser.add_argument("--drucker-entfernen", action="store_true", help="PDF-Drucker entfernen (Adminrechte)")
    parser.add_argument("--chrome-einrichten", action="store_true", help="Chrome-Seitenleiste einrichten (Anleitung + Chrome öffnen)")
    args = parser.parse_args(argv)
    # Start über den Link „agentur-pdf://start“ (Chrome-Seitenleiste): nur starten
    args.dateien = [d for d in args.dateien if not d.lower().startswith("agentur-pdf:")]

    if args.explorer_einrichten or args.explorer_entfernen or args.explorer_reg:
        from .windows import explorer

        if args.explorer_reg:
            Path(args.explorer_reg).write_text(explorer.als_reg_datei(explorer.eintraege(explorer.programm_aufruf())), encoding="utf-16")
            print(f"Gespeichert: {args.explorer_reg}")
        elif args.explorer_einrichten:
            print(f"{explorer.einrichten()} Registry-Einträge angelegt.")
        else:
            explorer.entfernen()
            print("Rechtsklick-Einträge entfernt.")
        return 0
    if args.chrome_einrichten:
        from .windows import chrome

        try:
            chrome.einrichten()
        except FileNotFoundError as fehler:
            print(fehler)
            return 1
        return 0
    if args.drucker_einrichten or args.drucker_entfernen:
        from .kern.druckordner import standard_ordner
        from .windows import drucker

        ordner = Path(BenutzerSpeicher().einstellungen().get("druck_ordner") or standard_ordner())
        ok = drucker.einrichten(ordner, erhoeht=False) if args.drucker_einrichten else drucker.entfernen(ordner, erhoeht=False)
        return 0 if ok else 1
    aktion = "zusammenfuehren" if args.zusammenfuehren else "umwandeln" if args.umwandeln else "oeffnen"

    einzelinstanz = not (args.nur_dienst or args.neue_instanz)
    if einzelinstanz:
        # Läuft Agentur-PDF schon? Dann Dateien übergeben und fertig.
        if instanz.senden(aktion, args.dateien):
            return 0
        if not instanz.sperre_holen(lambda: instanz.senden(aktion, args.dateien)):
            return 0

    token = args.token or neues_token()
    port = args.port or freier_port()
    dokumente = DokumentSpeicher()
    benutzer = BenutzerSpeicher()

    webview = None
    if not (args.browser or args.nur_dienst):
        try:
            import webview  # type: ignore[import-not-found]
        except ImportError:
            webview = None

    fenster_ref: dict = {}

    def datei_dialog() -> list[str]:
        fenster = fenster_ref.get("fenster")
        if fenster is None:
            return []
        ergebnis = fenster.create_file_dialog(webview.OPEN_DIALOG, allow_multiple=True, file_types=DATEITYPEN)
        return list(ergebnis or [])

    def speichern_dialog(vorschlag: str) -> str | None:
        fenster = fenster_ref.get("fenster")
        if fenster is None:
            return None
        verzeichnis = os.path.dirname(vorschlag) if os.path.isabs(vorschlag) else ""
        endung = os.path.splitext(vorschlag)[1].lower()
        filter_ = SPEICHER_FILTER.get(endung, SPEICHER_FILTER[".pdf"])
        ergebnis = fenster.create_file_dialog(
            webview.SAVE_DIALOG,
            directory=verzeichnis,
            save_filename=os.path.basename(vorschlag) or "Dokument.pdf",
            file_types=(filter_,),
        )
        if not ergebnis:
            return None
        return ergebnis if isinstance(ergebnis, str) else ergebnis[0]

    def ordner_dialog(start: str) -> str | None:
        fenster = fenster_ref.get("fenster")
        if fenster is None:
            return None
        ergebnis = fenster.create_file_dialog(webview.FOLDER_DIALOG, directory=start if os.path.isdir(start) else "")
        if not ergebnis:
            return None
        return ergebnis if isinstance(ergebnis, str) else ergebnis[0]

    def fenster_vorholen() -> None:
        """Fenster nach vorne holen, wenn Dateien von außen kommen."""
        fenster = fenster_ref.get("fenster")
        if fenster is None:
            return
        try:
            fenster.restore()
            fenster.show()
            fenster.on_top = True  # kurzer Trick: Windows lässt sonst nur blinken
            fenster.on_top = False
        except Exception:  # noqa: BLE001 – nur Komfort
            pass

    app = erstelle_app(
        token,
        dokumente=dokumente,
        benutzer=benutzer,
        oberflaeche_ordner=oberflaeche_ordner(),
        datei_dialog=datei_dialog if webview else None,
        speichern_dialog=speichern_dialog if webview else None,
        ordner_dialog=ordner_dialog if webview else None,
        fenster_vorholen=fenster_vorholen if webview else None,
    )
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    url = f"http://127.0.0.1:{port}/#t={token}"

    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    while not server.started:
        if not thread.is_alive():
            print("Dienst konnte nicht gestartet werden.", file=sys.stderr)
            return 1
        time.sleep(0.02)
    if einzelinstanz:
        instanz.anmelden(port, token)
        # Auch beim Beenden von außen (Abmelden, Taskmanager) sauber abmelden
        signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

    if args.nach_update:
        app.state.ereignisse.hinzufuegen(
            {"art": "info", "text": f"Ergo4You PDF wurde auf Version {__import__('agentur_pdf').__version__} aktualisiert."}
        )
    app.state.programm_beenden = lambda: os.kill(os.getpid(), signal.SIGTERM)
    try:
        # Dateien vom Aufruf wie eine Übergabe von außen behandeln
        if args.dateien:
            asyncio.run_coroutine_threadsafe(_extern(app, aktion, args.dateien), _server_loop(server)).result(30)

        if args.nur_dienst:
            print(f"Agentur-PDF-Dienst läuft: {url}", flush=True)
            thread.join()
        elif webview is not None:
            fenster_ref["fenster"] = webview.create_window(
                f"{PRODUKT} – {STAND}", url, width=1400, height=900, min_size=(900, 600), text_select=True
            )
            app.state.fenster_minimieren = lambda: fenster_ref["fenster"].minimize()
            app.state.programm_beenden = lambda: fenster_ref["fenster"].destroy()
            _screenshot_starten(app)
            webview.start()
        else:
            print(f"Ergo4You PDF läuft: {url}", flush=True)
            _screenshot_starten(app)
            webbrowser.open(url)
            thread.join()
    except (KeyboardInterrupt, SystemExit):
        pass
    finally:
        if einzelinstanz:
            instanz.abmelden()
        try:
            app.state.aufraeumen()  # letzte Sicherung, Sperrdateien freigeben
        except Exception:  # noqa: BLE001
            logging.getLogger(__name__).exception("Aufräumen beim Beenden")
        server.should_exit = True
    return 0


def _screenshot_starten(app) -> None:
    """Globales Screenshot-Tastenkürzel anmelden (nur Windows)."""
    if os.name != "nt":
        return
    try:
        app.state.screenshot_starten()
    except Exception:  # noqa: BLE001 – Programm muss auch ohne Screenshot-Werkzeug laufen
        logging.getLogger(__name__).exception("Screenshot-Werkzeug nicht gestartet")


async def _extern(app, aktion: str, dateien: list[str]) -> None:
    await app.state.extern_ausfuehren(aktion, dateien)


def _server_loop(server: uvicorn.Server) -> asyncio.AbstractEventLoop:
    """Event-Loop des Server-Threads (für Aufrufe aus dem Hauptthread)."""
    for _ in range(100):
        for s in server.servers:
            return s.get_loop() if hasattr(s, "get_loop") else s._loop  # type: ignore[attr-defined]
        time.sleep(0.02)
    raise RuntimeError("Server-Loop nicht gefunden")


def _protokoll_einrichten() -> Path:
    """Fehlerprotokoll unter %APPDATA%\\AgenturPDF\\protokoll.log (rotierend).
    Das Windows-Programm hat kein Konsolenfenster – ohne Protokoll wären
    Fehler unsichtbar."""
    import logging
    from logging.handlers import RotatingFileHandler

    from .benutzer.speicher import datenordner

    datei = datenordner() / "protokoll.log"
    handler = RotatingFileHandler(datei, maxBytes=2_000_000, backupCount=2, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    wurzel = logging.getLogger()
    wurzel.addHandler(handler)
    wurzel.setLevel(logging.INFO)
    for name in ("uvicorn.error", "uvicorn"):
        logging.getLogger(name).addHandler(handler)
    if getattr(sys, "frozen", False) and sys.stderr is None:
        # Fenster-Programm: print()/Tracebacks ins Protokoll umleiten
        sys.stdout = sys.stderr = open(datei.with_name("ausgabe.log"), "a", encoding="utf-8", buffering=1)
    return datei


def _fehlerfenster(text: str) -> None:
    """Fehler beim Start sichtbar machen (Windows-Meldungsfenster)."""
    if os.name == "nt":
        try:
            import ctypes

            ctypes.windll.user32.MessageBoxW(None, text, "Ergo4You PDF – Fehler", 0x10)
            return
        except Exception:  # noqa: BLE001
            pass
    print(text, file=sys.stderr)


def start() -> int:
    """Einstiegspunkt der .exe: Protokoll + verständliche Fehlermeldung."""
    import logging
    import traceback

    protokoll = _protokoll_einrichten()
    logging.info("Agentur-PDF %s startet: %s", __import__("agentur_pdf").__version__, sys.argv[1:])
    try:
        return main()
    except SystemExit:
        raise
    except Exception:  # noqa: BLE001
        logging.exception("Absturz beim Start")
        _fehlerfenster(
            "Ergo4You PDF konnte nicht gestartet werden.\n\n"
            f"{traceback.format_exc(limit=3)}\n"
            f"Details stehen im Protokoll:\n{protokoll}"
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(start())
