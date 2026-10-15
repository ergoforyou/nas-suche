"""Updates über den gemeinsamen NAS-Ordner.

Eine neue Version wird verteilt, indem man die Setup-Datei
(``Agentur-PDF-Setup-0.7.0.exe``) in den Ordner ``Updates`` im gemeinsamen
Ordner legt. Jeder Arbeitsplatz prüft beim Start und danach regelmäßig, ob dort
eine neuere Version liegt, und bietet die Aktualisierung an. Das Setup läuft
dann ohne Rückfragen (pro Benutzer, keine Administratorrechte nötig) und
startet Agentur-PDF anschließend neu.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path

MUSTER = re.compile(r"^Agentur-PDF-Setup-(\d+(?:\.\d+){1,3})(?:-[\w.]+)?\.exe$", re.IGNORECASE)
UPDATE_UNTERORDNER = "Updates"


def version_tupel(version: str) -> tuple[int, ...]:
    """„0.7.0-test“ → (0, 7, 0); Zusätze hinter „-“ zählen nicht."""
    kern = version.split("-")[0]
    teile = [int(x) for x in re.findall(r"\d+", kern)]
    while len(teile) < 3:
        teile.append(0)
    return tuple(teile)


def update_ordner(gemeinsamer_ordner: Path | None) -> Path | None:
    if os.environ.get("AGENTUR_PDF_UPDATES"):
        return Path(os.environ["AGENTUR_PDF_UPDATES"])
    return gemeinsamer_ordner / UPDATE_UNTERORDNER if gemeinsamer_ordner else None


def suchen(ordner: Path | None, aktuell: str) -> dict:
    """Neueste Setup-Datei im Ordner, falls neuer als ``aktuell``."""
    if ordner is None:
        return {"verfuegbar": False, "grund": "kein_ordner"}
    try:
        dateien = list(ordner.iterdir())
    except OSError:
        return {"verfuegbar": False, "grund": "nicht_erreichbar", "ordner": str(ordner)}
    beste: tuple[tuple[int, ...], Path, str] | None = None
    for datei in dateien:
        treffer = MUSTER.match(datei.name)
        if not treffer or not datei.is_file():
            continue
        v = version_tupel(treffer.group(1))
        if beste is None or v > beste[0]:
            beste = (v, datei, treffer.group(1))
    if beste is None or beste[0] <= version_tupel(aktuell):
        return {"verfuegbar": False, "grund": "aktuell", "ordner": str(ordner)}
    st = beste[1].stat()
    return {
        "verfuegbar": True,
        "version": beste[2],
        "pfad": str(beste[1]),
        "groesse": st.st_size,
        "datum": datetime.fromtimestamp(st.st_mtime).isoformat(timespec="minutes"),
        "ordner": str(ordner),
    }


def installieren(setup: str) -> None:
    """Setup lokal zwischenlagern (das NAS kann während der Installation
    wegbrechen) und ohne Rückfragen starten. Das Setup schließt Agentur-PDF
    und startet es danach mit ``--nach-update`` neu."""
    ziel = Path(tempfile.gettempdir()) / Path(setup).name
    shutil.copy2(setup, ziel)
    argumente = [str(ziel), "/SILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CLOSEAPPLICATIONS", "/NEUSTART=1"]
    flags = 0
    if os.name == "nt":
        flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]
    subprocess.Popen(argumente, creationflags=flags, close_fds=True)  # noqa: S603 – Setup aus dem eigenen Update-Ordner
