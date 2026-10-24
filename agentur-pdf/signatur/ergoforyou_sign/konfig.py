"""Einstellungen des NAS-Dienstes (``konfig.json`` im Datenordner).

Das Einrichtungskennwort wird nur als PBKDF2-Hash gespeichert. Der
Verbindungsschlüssel für Ergoforyou PDF und das Geheimnis für Sitzungen und
Zugangsnachweise werden beim ersten Start zufällig erzeugt.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import threading
from pathlib import Path
from typing import Any

ITERATIONEN = 200_000


def datenordner() -> Path:
    ordner = Path(os.environ.get("SIGN_DATEN", "/daten"))
    ordner.mkdir(parents=True, exist_ok=True)
    return ordner


def kennwort_hash(kennwort: str, salz: bytes | None = None) -> str:
    salz = salz or secrets.token_bytes(16)
    wert = hashlib.pbkdf2_hmac("sha256", kennwort.encode(), salz, ITERATIONEN)
    return f"pbkdf2${ITERATIONEN}${salz.hex()}${wert.hex()}"


def kennwort_pruefen(kennwort: str, gespeichert: str) -> bool:
    try:
        _, iterationen, salz, wert = gespeichert.split("$")
    except ValueError:
        return False
    neu = hashlib.pbkdf2_hmac("sha256", kennwort.encode(), bytes.fromhex(salz), int(iterationen))
    return hmac.compare_digest(neu.hex(), wert)


class Konfig:
    def __init__(self, ordner: Path) -> None:
        ordner.mkdir(parents=True, exist_ok=True)
        self.datei = ordner / "konfig.json"
        self._lock = threading.Lock()
        try:
            self._werte: dict[str, Any] = json.loads(self.datei.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self._werte = {}
        neu = {}
        if not self._werte.get("schluessel"):
            neu["schluessel"] = secrets.token_urlsafe(32)
        if not self._werte.get("geheimnis"):
            neu["geheimnis"] = secrets.token_hex(32)
        if neu:
            self.setzen(**neu)

    def get(self, schluessel: str, standard: Any = "") -> Any:
        return self._werte.get(schluessel, standard)

    def setzen(self, **werte: Any) -> None:
        with self._lock:
            self._werte.update(werte)
            temp = self.datei.with_suffix(".tmp")
            temp.write_text(json.dumps(self._werte, ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(temp, self.datei)
            try:
                os.chmod(self.datei, 0o600)
            except OSError:
                pass

    def signieren(self, text: str) -> str:
        return hmac.new(bytes.fromhex(self.get("geheimnis")), text.encode(), hashlib.sha256).hexdigest()

    @property
    def oeffentliche_adresse(self) -> str:
        return str(self.get("oeffentliche_adresse") or "").rstrip("/")
