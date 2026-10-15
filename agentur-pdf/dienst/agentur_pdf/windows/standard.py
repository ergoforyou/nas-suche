"""Ist Agentur-PDF das Standard-PDF-Programm? – und die Windows-Einstellung
dafür öffnen. Windows 10/11 erlauben Programmen nicht, sich selbst zum
Standard zu machen; der Benutzer wählt es einmal in „Standard-Apps“ aus.
"""

from __future__ import annotations

import os

from .explorer import BASIS, PROGID


def status() -> dict:
    if os.name != "nt":
        return {"windows": False, "registriert": False, "standard": False}
    import winreg  # type: ignore[import-not-found]

    def lesen(pfad: str, name: str = "") -> str | None:
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, pfad) as k:
                return str(winreg.QueryValueEx(k, name)[0])
        except OSError:
            return None

    registriert = lesen(rf"{BASIS}\{PROGID}\shell\open\command") is not None
    wahl = lesen(r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.pdf\UserChoice", "ProgId")
    return {"windows": True, "registriert": registriert, "standard": wahl == PROGID, "aktuell": wahl}


def einstellungen_oeffnen() -> None:
    """Windows-Einstellungen „Standard-Apps“ (wenn möglich direkt bei Agentur-PDF)."""
    for ziel in ("ms-settings:defaultapps?registeredAppUser=Agentur-PDF", "ms-settings:defaultapps"):
        try:
            os.startfile(ziel)  # type: ignore[attr-defined]  # noqa: S606
            return
        except OSError:
            continue
