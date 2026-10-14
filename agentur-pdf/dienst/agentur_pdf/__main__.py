"""Startpunkt: ``python -m agentur_pdf [Dateien …]``.

Startet den lokalen Dienst auf 127.0.0.1 und öffnet die Oberfläche
* unter Windows in einem eigenen App-Fenster (pywebview / WebView2),
* sonst bzw. mit ``--browser`` im Standardbrowser.
"""

from __future__ import annotations

import argparse
import socket
import sys
import threading
import time
import webbrowser
from pathlib import Path

import uvicorn

from .api.app import erstelle_app
from .api.sicherheit import neues_token
from .benutzer.speicher import BenutzerSpeicher
from .kern.dokumente import DokumentFehler, DokumentSpeicher
from .kern.mupdf_thread import im_mupdf_thread_sync

DATEITYPEN = ("PDF und Bilder (*.pdf;*.png;*.jpg;*.jpeg;*.tif;*.tiff;*.bmp)", "Alle Dateien (*.*)")


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


def freier_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="agentur-pdf", description="Agentur-PDF starten")
    parser.add_argument("dateien", nargs="*", help="Dateien, die sofort geöffnet werden")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--browser", action="store_true", help="Im Standardbrowser statt im App-Fenster öffnen")
    parser.add_argument("--nur-dienst", action="store_true", help="Nur den Dienst starten (Entwicklung)")
    parser.add_argument("--token", default=None, help="Festes Token (nur Entwicklung)")
    args = parser.parse_args(argv)

    token = args.token or neues_token()
    port = args.port or freier_port()
    dokumente = DokumentSpeicher()
    benutzer = BenutzerSpeicher()

    for datei in args.dateien:
        try:
            dok = im_mupdf_thread_sync(dokumente.oeffnen_pfad, datei)
            benutzer.zuletzt_hinzufuegen(dok.pfad or datei, dok.titel, dok.doc.page_count)
        except DokumentFehler as fehler:
            print(f"Hinweis: {datei}: {fehler}", file=sys.stderr)

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

    app = erstelle_app(
        token,
        dokumente=dokumente,
        benutzer=benutzer,
        oberflaeche_ordner=oberflaeche_ordner(),
        datei_dialog=datei_dialog if webview else None,
    )
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    url = f"http://127.0.0.1:{port}/#t={token}"

    if args.nur_dienst:
        print(f"Agentur-PDF-Dienst läuft: {url}", flush=True)
        server.run()
        return 0

    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    while not server.started:
        time.sleep(0.02)

    if webview is not None:
        fenster_ref["fenster"] = webview.create_window(
            "Agentur-PDF", url, width=1400, height=900, min_size=(900, 600), text_select=True
        )
        webview.start()
    else:
        print(f"Agentur-PDF läuft: {url}", flush=True)
        webbrowser.open(url)
        try:
            thread.join()
        except KeyboardInterrupt:
            pass
    server.should_exit = True
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
