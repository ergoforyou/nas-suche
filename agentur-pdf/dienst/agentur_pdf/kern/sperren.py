"""Sperrhinweis für gemeinsam genutzte Dateien (NAS).

Wer eine Datei öffnet, legt daneben eine kleine, versteckte Sperrdatei an
(``~$Name.pdf.sperre``, wie Word es mit ``~$`` macht). Öffnet ein Kollege
dieselbe Datei, sieht er „ist bei Martina (PC-02) geöffnet“ und speichert
nicht versehentlich darüber.

* Die Sperre wird regelmäßig „aufgefrischt“ (Änderungszeit). Stürzt ein PC
  ab, gilt seine Sperre nach ``VERALTET_S`` als verwaist.
* Die eigene Sperre (gleicher Benutzer am gleichen PC) wird einfach übernommen.
* Lässt sich keine Sperrdatei anlegen (schreibgeschützter Ordner), wird ohne
  Sperre weitergearbeitet – das Programm darf daran nie scheitern.
"""

from __future__ import annotations

import getpass
import json
import os
import socket
import time
from datetime import datetime
from pathlib import Path

VERALTET_S = 10 * 60
ENDUNG = ".sperre"


def ich(kuerzel: str = "") -> dict:
    try:
        benutzer = getpass.getuser()
    except Exception:  # noqa: BLE001
        benutzer = os.environ.get("USERNAME", "unbekannt")
    return {
        "benutzer": benutzer,
        "rechner": os.environ.get("COMPUTERNAME") or socket.gethostname(),
        "kuerzel": kuerzel,
    }


def sperr_pfad(pfad: str | os.PathLike) -> Path:
    p = Path(pfad)
    return p.with_name(f"~${p.name}{ENDUNG}")


def _verstecken(datei: Path) -> None:
    if os.name != "nt":
        return
    try:
        import ctypes

        ctypes.windll.kernel32.SetFileAttributesW(str(datei), 0x02)  # FILE_ATTRIBUTE_HIDDEN
    except Exception:  # noqa: BLE001
        pass


class Sperren:
    def __init__(self, kuerzel: str = "") -> None:
        self.ich = ich(kuerzel)
        self._eigene: dict[str, Path] = {}  # normierter Dateipfad → Sperrdatei

    @staticmethod
    def _schluessel(pfad: str) -> str:
        return os.path.normcase(os.path.abspath(pfad))

    def _ist_ich(self, info: dict) -> bool:
        return info.get("benutzer") == self.ich["benutzer"] and info.get("rechner") == self.ich["rechner"]

    def fremd(self, pfad: str) -> dict | None:
        """Gültige Sperre eines anderen Benutzers/PCs – sonst None."""
        datei = sperr_pfad(pfad)
        try:
            alter = time.time() - datei.stat().st_mtime
            info = json.loads(datei.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if alter > VERALTET_S or self._ist_ich(info):
            return None
        return info

    def holen(self, pfad: str) -> dict | None:
        """Sperre setzen. Ergebnis: Angaben zum fremden Inhaber, falls die
        Datei schon bei jemand anderem geöffnet ist (dann keine eigene Sperre)."""
        andere = self.fremd(pfad)
        if andere:
            return andere
        datei = sperr_pfad(pfad)
        info = {**self.ich, "seit": datetime.now().isoformat(timespec="minutes"), "pid": os.getpid()}
        try:
            if datei.exists():
                # verwaiste oder eigene Sperre: versteckte Dateien lassen sich
                # unter Windows nicht direkt überschreiben → erst löschen
                datei.unlink()
            datei.write_text(json.dumps(info, ensure_ascii=False), encoding="utf-8")
            _verstecken(datei)
            self._eigene[self._schluessel(pfad)] = datei
        except OSError:
            pass  # z. B. schreibgeschützter Ordner – dann eben ohne Sperre
        return None

    def freigeben(self, pfad: str | None) -> None:
        if not pfad:
            return
        datei = self._eigene.pop(self._schluessel(pfad), None)
        if datei is None:
            return
        try:
            info = json.loads(datei.read_text(encoding="utf-8"))
            if self._ist_ich(info):
                datei.unlink()
        except (OSError, ValueError):
            pass

    def besitze(self, pfad: str) -> bool:
        return self._schluessel(pfad) in self._eigene

    def auffrischen(self) -> None:
        """Änderungszeit der eigenen Sperren erneuern (Lebenszeichen)."""
        jetzt = time.time()
        for datei in list(self._eigene.values()):
            try:
                os.utime(datei, (jetzt, jetzt))
            except OSError:
                pass

    def alle_freigeben(self) -> None:
        for schluessel in list(self._eigene):
            datei = self._eigene.pop(schluessel)
            try:
                datei.unlink()
            except OSError:
                pass
