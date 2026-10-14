"""Nur eine Programminstanz je Benutzer.

Startet man Agentur-PDF, während es schon läuft (Doppelklick auf eine PDF,
Explorer-Rechtsklick), reicht der neue Prozess seine Dateien an die laufende
Instanz weiter und beendet sich sofort. Der Explorer startet bei
Mehrfachauswahl einen Prozess *je Datei* – eine Sperrdatei sorgt dafür, dass
dabei genau einer die Instanz wird und alle anderen warten und weiterreichen.

Die Verbindungsdaten (Port + Token) liegen in %APPDATA%\\AgenturPDF\\instanz.json
und sind damit nur für den angemeldeten Benutzer lesbar.
"""

from __future__ import annotations

import json
import os
import time
import urllib.request
from pathlib import Path

from ..benutzer.speicher import datenordner

SPERRE_VERALTET_S = 30


def _instanz_datei() -> Path:
    return datenordner() / "instanz.json"


def _sperr_datei() -> Path:
    return datenordner() / "instanz.lock"


def senden(aktion: str, dateien: list[str], zeitlimit: float = 3) -> bool:
    """Dateien an eine laufende Instanz übergeben. True = erledigt."""
    try:
        daten = json.loads(_instanz_datei().read_text(encoding="utf-8"))
        anfrage = urllib.request.Request(
            f"http://127.0.0.1:{int(daten['port'])}/api/extern",
            data=json.dumps({"aktion": aktion, "dateien": [os.path.abspath(d) for d in dateien]}).encode(),
            headers={"Content-Type": "application/json", "X-Agentur-Token": daten["token"]},
            method="POST",
        )
        with urllib.request.urlopen(anfrage, timeout=zeitlimit) as antwort:
            return antwort.status == 200
    except (OSError, ValueError, KeyError):
        return False


def sperre_holen(weiterreichen, zeitlimit: float = 15) -> bool:
    """Versucht, die Instanz-Sperre zu bekommen.

    True  → dieser Prozess wird die Instanz.
    False → eine andere Instanz ist (inzwischen) erreichbar und ``weiterreichen()``
            war erfolgreich – dieser Prozess kann sich beenden.
    """
    ende = time.time() + zeitlimit
    while True:
        try:
            fd = os.open(_sperr_datei(), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, str(os.getpid()).encode())
            os.close(fd)
            # Die Sperre wird frei, sobald eine Instanz läuft – also erst
            # prüfen, ob inzwischen jemand erreichbar ist.
            if weiterreichen():
                _sperr_datei().unlink(missing_ok=True)
                return False
            return True
        except FileExistsError:
            pass
        try:
            if time.time() - _sperr_datei().stat().st_mtime > SPERRE_VERALTET_S:
                _sperr_datei().unlink(missing_ok=True)  # Rest eines Absturzes
                continue
        except OSError:
            continue
        if weiterreichen():
            return False
        if time.time() > ende:
            return True  # Notfall: lieber zweite Instanz als gar nichts
        time.sleep(0.2)


def anmelden(port: int, token: str) -> None:
    datei = _instanz_datei()
    temp = datei.with_suffix(".tmp")
    temp.write_text(json.dumps({"port": port, "token": token, "pid": os.getpid()}), encoding="utf-8")
    os.replace(temp, datei)
    _sperr_datei().unlink(missing_ok=True)


def abmelden() -> None:
    try:
        daten = json.loads(_instanz_datei().read_text(encoding="utf-8"))
        if daten.get("pid") == os.getpid():
            _instanz_datei().unlink(missing_ok=True)
    except (OSError, ValueError):
        pass
    _sperr_datei().unlink(missing_ok=True)
