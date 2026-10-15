"""Drucker „Agentur-PDF“ einrichten (einmalig, mit Administratorrechten).

Nutzt den in Windows 10/11 eingebauten Treiber „Microsoft Print To PDF“,
aber mit einem Datei-Anschluss statt „Speichern unter“-Dialog: Jeder
Ausdruck landet ohne Rückfrage als ``Ausdruck.pdf`` im Druckordner, von wo
Agentur-PDF ihn sofort als neues Dokument öffnet (``kern/druckordner.py``).
"""

from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path

DRUCKER = "Agentur-PDF"
TREIBER = "Microsoft Print To PDF"

SKRIPT = r"""
param([string]$Ordner, [string]$Name = "Agentur-PDF", [switch]$Entfernen)
$ErrorActionPreference = "Stop"
$port = Join-Path $Ordner "Ausdruck.pdf"
if ($Entfernen) {
  if (Get-Printer -Name $Name -ErrorAction SilentlyContinue) { Remove-Printer -Name $Name }
  if (Get-PrinterPort -Name $port -ErrorAction SilentlyContinue) { Remove-PrinterPort -Name $port }
  exit 0
}
if (-not (Get-PrinterDriver -Name "Microsoft Print To PDF" -ErrorAction SilentlyContinue)) {
  Enable-WindowsOptionalFeature -Online -FeatureName "Printing-PrintToPDFServices-Features" -NoRestart | Out-Null
}
New-Item -ItemType Directory -Force -Path $Ordner | Out-Null
# alle Benutzer dürfen Ausdrucke lesen und löschen (der Druckdienst schreibt sie)
icacls $Ordner /grant "*S-1-5-32-545:(OI)(CI)M" /T /Q | Out-Null
if (-not (Get-PrinterPort -Name $port -ErrorAction SilentlyContinue)) { Add-PrinterPort -Name $port }
if (Get-Printer -Name $Name -ErrorAction SilentlyContinue) { Remove-Printer -Name $Name }
Add-Printer -Name $Name -DriverName "Microsoft Print To PDF" -PortName $port
"OK"
"""


def _skript_datei() -> Path:
    datei = Path(tempfile.gettempdir()) / "agentur-pdf-drucker.ps1"
    datei.write_text(SKRIPT, encoding="utf-8-sig")
    return datei


def _ausfuehren(argumente: list[str], erhoeht: bool) -> int:
    skript = _skript_datei()
    parameter = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(skript), *argumente]
    ohne_fenster = 0x08000000 if os.name == "nt" else 0  # CREATE_NO_WINDOW
    if not erhoeht:
        return subprocess.run(["powershell", *parameter], creationflags=ohne_fenster, check=False).returncode  # noqa: S603, S607
    # Rückfrage der Benutzerkontensteuerung („Darf diese App Änderungen …“)
    # Start-Process setzt die Liste ohne Anführungszeichen zusammen → Pfade mit
    # Leerzeichen (C:\Users\Max Muster\…) selbst in "…" einschließen
    liste = ",".join("'" + (f'"{p}"' if " " in p else p).replace("'", "''") + "'" for p in parameter)
    befehl = f"$p = Start-Process powershell -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList {liste}; exit $p.ExitCode"
    return subprocess.run(["powershell", "-NoProfile", "-Command", befehl], creationflags=ohne_fenster, check=False).returncode  # noqa: S603, S607


def einrichten(ordner: Path, erhoeht: bool = True) -> bool:
    return _ausfuehren(["-Ordner", str(ordner), "-Name", DRUCKER], erhoeht) == 0


def entfernen(ordner: Path, erhoeht: bool = True) -> bool:
    return _ausfuehren(["-Ordner", str(ordner), "-Name", DRUCKER, "-Entfernen"], erhoeht) == 0


def eingerichtet() -> bool:
    if os.name != "nt":
        return False
    try:
        import winreg  # type: ignore[import-not-found]

        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, rf"SYSTEM\CurrentControlSet\Control\Print\Printers\{DRUCKER}"):
            return True
    except OSError:
        return False
