"""Hintergrund-Aufträge (Zusammenführen, Umwandeln, später OCR) mit
Fortschrittsanzeige und Abbrechen."""

from __future__ import annotations

import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable

from .dokumente import DokumentFehler


class Abgebrochen(Exception):
    pass


@dataclass
class Auftrag:
    id: str
    titel: str
    status: str = "wartet"  # wartet | laeuft | fertig | fehler | abgebrochen
    fortschritt: float = 0.0  # 0..1
    schritt: str = ""
    fehler: str = ""
    ergebnis: dict = field(default_factory=dict)
    gestartet: float = field(default_factory=time.time)
    beendet: float | None = None
    _abbrechen: threading.Event = field(default_factory=threading.Event, repr=False)

    def melden(self, fortschritt: float, schritt: str = "") -> None:
        if self._abbrechen.is_set():
            raise Abgebrochen()
        self.fortschritt = max(0.0, min(1.0, fortschritt))
        if schritt:
            self.schritt = schritt

    def abbrechen(self) -> None:
        self._abbrechen.set()

    def als_dict(self) -> dict:
        return {
            "id": self.id,
            "titel": self.titel,
            "status": self.status,
            "fortschritt": round(self.fortschritt, 3),
            "schritt": self.schritt,
            "fehler": self.fehler,
            "ergebnis": self.ergebnis,
        }


class AuftragsVerwaltung:
    def __init__(self, parallel: int = 2, aufbewahren_s: float = 60) -> None:
        self._executor = ThreadPoolExecutor(max_workers=parallel, thread_name_prefix="auftrag")
        self._auftraege: dict[str, Auftrag] = {}
        self._lock = threading.Lock()
        self.aufbewahren_s = aufbewahren_s
        self.bei_ende: Callable[[Auftrag], None] | None = None

    def starten(self, titel: str, arbeit: Callable[[Auftrag], dict | None]) -> Auftrag:
        auftrag = Auftrag(id=uuid.uuid4().hex[:10], titel=titel)
        with self._lock:
            self._aufraeumen()
            self._auftraege[auftrag.id] = auftrag

        def ausfuehren() -> None:
            auftrag.status = "laeuft"
            try:
                auftrag.ergebnis = arbeit(auftrag) or {}
                auftrag.fortschritt = 1.0
                auftrag.status = "fertig"
            except Abgebrochen:
                auftrag.status = "abgebrochen"
            except DokumentFehler as fehler:
                auftrag.status, auftrag.fehler = "fehler", str(fehler)
            except Exception as fehler:  # noqa: BLE001
                traceback.print_exc()
                auftrag.status, auftrag.fehler = "fehler", f"Unerwarteter Fehler: {fehler}"
            auftrag.beendet = time.time()
            if self.bei_ende:
                self.bei_ende(auftrag)

        self._executor.submit(ausfuehren)
        return auftrag

    def get(self, auftrag_id: str) -> Auftrag:
        try:
            return self._auftraege[auftrag_id]
        except KeyError:
            raise DokumentFehler("Auftrag nicht gefunden.") from None

    def liste(self) -> list[dict[str, Any]]:
        with self._lock:
            self._aufraeumen()
            return [a.als_dict() for a in self._auftraege.values()]

    def warten(self, auftrag_id: str, zeitlimit: float = 60) -> Auftrag:
        """Für Tests: blockiert, bis der Auftrag beendet ist."""
        ende = time.time() + zeitlimit
        auftrag = self.get(auftrag_id)
        while auftrag.status in ("wartet", "laeuft") and time.time() < ende:
            time.sleep(0.02)
        return auftrag

    def _aufraeumen(self) -> None:
        jetzt = time.time()
        for aid in [a.id for a in self._auftraege.values() if a.beendet and jetzt - a.beendet > self.aufbewahren_s]:
            del self._auftraege[aid]
