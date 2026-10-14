"""Größenbegrenzter LRU-Cache für gerenderte Seitenbilder."""

from __future__ import annotations

import threading
from collections import OrderedDict
from typing import Hashable


class RenderCache:
    """Hält fertig kodierte Bilder (PNG) im Speicher, begrenzt nach Bytes."""

    def __init__(self, max_bytes: int = 256 * 1024 * 1024) -> None:
        self.max_bytes = max_bytes
        self._eintraege: OrderedDict[Hashable, bytes] = OrderedDict()
        self._groesse = 0
        self._lock = threading.Lock()
        self.treffer = 0
        self.fehlschlaege = 0

    def get(self, schluessel: Hashable) -> bytes | None:
        with self._lock:
            daten = self._eintraege.get(schluessel)
            if daten is None:
                self.fehlschlaege += 1
                return None
            self._eintraege.move_to_end(schluessel)
            self.treffer += 1
            return daten

    def put(self, schluessel: Hashable, daten: bytes) -> None:
        if len(daten) > self.max_bytes:
            return
        with self._lock:
            alt = self._eintraege.pop(schluessel, None)
            if alt is not None:
                self._groesse -= len(alt)
            self._eintraege[schluessel] = daten
            self._groesse += len(daten)
            while self._groesse > self.max_bytes:
                _, entfernt = self._eintraege.popitem(last=False)
                self._groesse -= len(entfernt)

    def entferne_dokument(self, dok_id: str) -> None:
        """Entfernt alle Einträge eines Dokuments (Schlüssel beginnt mit dok_id)."""
        with self._lock:
            for schluessel in [s for s in self._eintraege if isinstance(s, tuple) and s[0] == dok_id]:
                self._groesse -= len(self._eintraege.pop(schluessel))

    @property
    def groesse(self) -> int:
        return self._groesse

    def __len__(self) -> int:
        return len(self._eintraege)
