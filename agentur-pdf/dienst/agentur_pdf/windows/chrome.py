"""Chrome-Seitenleiste einrichten (Windows).

Chrome erlaubt außerhalb des Web Stores keine stille Installation von
Erweiterungen. Daher: Ordner der Erweiterung im Explorer zeigen, Pfad in die
Zwischenablage legen und Chrome mit der Erweiterungsseite öffnen – dort
„Entwicklermodus“ → „Entpackte Erweiterung laden“ → Ordner wählen (einmalig).
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


def ordner() -> Path:
    """Ordner der Erweiterung (neben der .exe bzw. im Quellbaum)."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).parent / "Chrome-Erweiterung"
    return Path(__file__).resolve().parents[3] / "chrome"


def chrome_finden() -> str | None:
    if os.name != "nt":
        return None
    import winreg

    for wurzel in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        try:
            with winreg.OpenKey(wurzel, r"Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe") as k:
                pfad = winreg.QueryValue(k, None)
                if pfad and Path(pfad).is_file():
                    return pfad
        except OSError:
            continue
    for basis in (os.environ.get("PROGRAMFILES"), os.environ.get("PROGRAMFILES(X86)"), os.environ.get("LOCALAPPDATA")):
        if basis and (Path(basis) / "Google/Chrome/Application/chrome.exe").is_file():
            return str(Path(basis) / "Google/Chrome/Application/chrome.exe")
    return None


def status() -> dict:
    o = ordner()
    return {"windows": os.name == "nt", "ordner": str(o), "vorhanden": (o / "manifest.json").is_file(), "chrome": chrome_finden()}


def einrichten() -> dict:
    """Ordner zeigen, Pfad kopieren, Chrome-Erweiterungsseite öffnen."""
    s = status()
    if not s["vorhanden"]:
        raise FileNotFoundError(f"Erweiterung nicht gefunden: {s['ordner']}")
    if os.name == "nt":
        try:
            subprocess.run(["clip"], input=s["ordner"].encode("utf-16-le"), check=False, creationflags=0x08000000)
        except OSError:
            pass
        os.startfile(s["ordner"])  # type: ignore[attr-defined]  # noqa: S606
        if s["chrome"]:
            subprocess.Popen([s["chrome"], "chrome://extensions/"], creationflags=0x08000000)  # noqa: S603
    return s
