"""PDF-Drucker: Ausdrucke aus anderen Programmen als Dokument öffnen.

Der Drucker „Agentur-PDF“ (Windows-Treiber „Microsoft Print To PDF“ mit
einem Datei-Anschluss, siehe ``windows/drucker.py``) schreibt jeden
Ausdruck ohne Rückfrage in eine feste Datei im Druckordner. Dieser Wächter
sieht dort regelmäßig nach, wartet, bis der Druck fertig geschrieben ist,
liest die PDF ein, löscht sie und übergibt sie an die Oberfläche.
"""

from __future__ import annotations

import os
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Callable

INTERVALL_S = 1.0


def standard_ordner() -> Path:
    oeffentlich = os.environ.get("PUBLIC")
    if oeffentlich:
        return Path(oeffentlich) / "Agentur-PDF-Druck"
    return Path.home() / "Agentur-PDF-Druck"


def titel_fuer_ausdruck(zeit: datetime | None = None) -> str:
    zeit = zeit or datetime.now()
    return f"Ausdruck {zeit.strftime('%d.%m.%Y %H.%M.%S')}.pdf"


class Druckordner:
    def __init__(self, ordner_holen: Callable[[], Path], uebergeben: Callable[[bytes, str], None]) -> None:
        self._ordner_holen = ordner_holen
        self._uebergeben = uebergeben
        self._stand: dict[str, tuple[int, float]] = {}  # Datei → (Größe, Änderungszeit) beim letzten Blick
        self._stopp = threading.Event()
        self._thread: threading.Thread | None = None

    def starten(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stopp.clear()
        self._thread = threading.Thread(target=self._schleife, name="druckordner", daemon=True)
        self._thread.start()

    def stoppen(self) -> None:
        self._stopp.set()

    def _schleife(self) -> None:
        while not self._stopp.wait(INTERVALL_S):
            try:
                self.durchgang()
            except Exception:  # noqa: BLE001 – Wächter darf nie sterben
                import logging

                logging.getLogger(__name__).exception("Druckordner")

    def durchgang(self) -> int:
        """Einmal nachsehen. Liefert die Zahl übergebener Ausdrucke."""
        ordner = self._ordner_holen()
        if not ordner.is_dir():
            return 0
        anzahl = 0
        gesehen = set()
        for datei in ordner.glob("*.pdf"):
            schluessel = str(datei)
            gesehen.add(schluessel)
            try:
                st = datei.stat()
            except OSError:
                continue
            jetzt = (st.st_size, st.st_mtime)
            vorher = self._stand.get(schluessel)
            self._stand[schluessel] = jetzt
            # erst übernehmen, wenn sich die Datei einen Durchgang lang nicht
            # verändert hat (der Druckauftrag schreibt nicht mehr)
            if vorher != jetzt or st.st_size == 0:
                continue
            try:
                daten = datei.read_bytes()
                datei.unlink()
            except OSError:
                continue  # noch in Benutzung – beim nächsten Mal
            self._stand.pop(schluessel, None)
            if not daten.startswith(b"%PDF"):
                continue
            self._uebergeben(daten, titel_fuer_ausdruck())
            anzahl += 1
        for alt in set(self._stand) - gesehen:
            self._stand.pop(alt, None)
        return anzahl
