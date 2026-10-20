"""Explorer-Rechtsklick-Einträge und „Öffnen mit“ für Agentur-PDF.

Alles wird pro Benutzer unter HKEY_CURRENT_USER angelegt – es sind keine
Administratorrechte nötig, und jeder der 6 Arbeitsplätze kann es selbst
einrichten (oder der Installer erledigt es).

Einträge je unterstütztem Dateityp (SystemFileAssociations):
* „Mit Agentur-PDF öffnen“
* „Zu einer PDF zusammenführen“ – auch bei Mehrfachauswahl (MultiSelectModel)
* „In PDF umwandeln“ – für alles außer PDF
Zusätzlich auf Ordnern: „Inhalt zu einer PDF zusammenführen“.

Hinweis Windows 11: Dort erscheinen klassische Einträge unter „Weitere
Optionen anzeigen“ (Umschalt+F10). Ein Eintrag direkt im neuen Menü erfordert
ein signiertes App-Paket – vorgemerkt für die Auslieferung (Schritt M8).
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

from ..kern.konvertierung import ALLE, PDF

PROGID = "AgenturPDF.Dokument"
ORDNER_VERB = "AgenturPDF.Zusammenfuehren"
BASIS = r"Software\Classes"


@dataclass(frozen=True)
class Schluessel:
    pfad: str  # relativ zu HKEY_CURRENT_USER
    werte: tuple[tuple[str, str], ...]  # (Name, Wert); "" = Standardwert


def programm_aufruf() -> str:
    """Befehl, mit dem Agentur-PDF gestartet wird (gepackte .exe oder Python)."""
    if getattr(sys, "frozen", False):
        return f'"{sys.executable}"'
    pythonw = Path(sys.executable).with_name("pythonw.exe")
    interpreter = pythonw if pythonw.exists() else Path(sys.executable)
    return f'"{interpreter}" -m agentur_pdf'


def eintraege(aufruf: str, symbol: str | None = None) -> list[Schluessel]:
    symbol = symbol or aufruf.split('" ')[0].strip('"')
    liste: list[Schluessel] = []
    verben = [
        ("AgenturPDF.1Oeffnen", "Mit Ergoforyou PDF öffnen", "", ALLE),
        ("AgenturPDF.2Zusammenfuehren", "Zu einer PDF zusammenführen", "--zusammenfuehren ", ALLE),
        ("AgenturPDF.3Umwandeln", "In PDF umwandeln", "--umwandeln ", ALLE - PDF),
    ]
    for endung in sorted(ALLE):
        for verb, titel, schalter, typen in verben:
            if endung not in typen:
                continue
            basis = rf"{BASIS}\SystemFileAssociations\{endung}\shell\{verb}"
            liste.append(
                Schluessel(basis, (("MUIVerb", titel), ("Icon", f"{symbol},0"), ("MultiSelectModel", "Player")))
            )
            liste.append(Schluessel(rf"{basis}\command", (("", f'{aufruf} {schalter}"%1"'),)))
    # Rechtsklick auf einen Ordner: alle unterstützten Dateien darin (alphabetisch)
    ordner = rf"{BASIS}\Directory\shell\{ORDNER_VERB}"
    liste.append(Schluessel(ordner, (("MUIVerb", "Inhalt zu einer PDF zusammenführen"), ("Icon", f"{symbol},0"))))
    liste.append(Schluessel(rf"{ordner}\command", (("", f'{aufruf} --zusammenfuehren "%1"'),)))
    # „Öffnen mit“ + Kandidat für das Standard-PDF-Programm (Auswahl trifft der
    # Benutzer in den Windows-Einstellungen – Windows erlaubt das nicht per Programm)
    liste += [
        Schluessel(rf"{BASIS}\{PROGID}", (("", "PDF-Dokument (Ergoforyou PDF)"),)),
        Schluessel(rf"{BASIS}\{PROGID}\DefaultIcon", (("", f"{symbol},0"),)),
        Schluessel(rf"{BASIS}\{PROGID}\shell\open\command", (("", f'{aufruf} "%1"'),)),
        Schluessel(rf"{BASIS}\.pdf\OpenWithProgids", ((PROGID, ""),)),
        Schluessel(
            r"Software\AgenturPDF\Capabilities",
            (("ApplicationName", "Ergoforyou PDF"), ("ApplicationDescription", "PDF-Programm von Ergoforyou")),
        ),
        Schluessel(r"Software\AgenturPDF\Capabilities\FileAssociations", ((".pdf", PROGID),)),
        Schluessel(r"Software\RegisteredApplications", (("Agentur-PDF", r"Software\AgenturPDF\Capabilities"),)),
    ]
    return liste


def als_reg_datei(liste: list[Schluessel]) -> str:
    """Export als .reg-Datei (zum Prüfen oder Verteilen per Gruppenrichtlinie)."""
    zeilen = ["Windows Registry Editor Version 5.00", ""]
    for s in liste:
        zeilen.append(f"[HKEY_CURRENT_USER\\{s.pfad}]")
        for name, wert in s.werte:
            schluessel = "@" if name == "" else f'"{name}"'
            zeilen.append(f'{schluessel}="{wert.replace(chr(92), chr(92) * 2).replace(chr(34), chr(92) + chr(34))}"')
        zeilen.append("")
    return "\r\n".join(zeilen)


def einrichten() -> int:
    import winreg  # type: ignore[import-not-found]

    liste = eintraege(programm_aufruf())
    for s in liste:
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, s.pfad) as k:
            for name, wert in s.werte:
                winreg.SetValueEx(k, name, 0, winreg.REG_SZ, wert)
    _explorer_benachrichtigen()
    return len(liste)


def entfernen() -> None:
    import winreg  # type: ignore[import-not-found]

    def loeschen(pfad: str) -> None:
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, pfad, 0, winreg.KEY_ALL_ACCESS) as k:
                while True:
                    try:
                        loeschen(pfad + "\\" + winreg.EnumKey(k, 0))
                    except OSError:
                        break
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, pfad)
        except FileNotFoundError:
            pass

    for endung in ALLE:
        for verb in ("AgenturPDF.1Oeffnen", "AgenturPDF.2Zusammenfuehren", "AgenturPDF.3Umwandeln"):
            loeschen(rf"{BASIS}\SystemFileAssociations\{endung}\shell\{verb}")
    loeschen(rf"{BASIS}\Directory\shell\{ORDNER_VERB}")
    loeschen(rf"{BASIS}\{PROGID}")
    loeschen(r"Software\AgenturPDF")
    for pfad, name in ((rf"{BASIS}\.pdf\OpenWithProgids", PROGID), (r"Software\RegisteredApplications", "Agentur-PDF")):
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, pfad, 0, winreg.KEY_SET_VALUE) as k:
                winreg.DeleteValue(k, name)
        except FileNotFoundError:
            pass
    _explorer_benachrichtigen()


def _explorer_benachrichtigen() -> None:
    """Explorer über geänderte Zuordnungen informieren (SHChangeNotify)."""
    try:
        import ctypes

        ctypes.windll.shell32.SHChangeNotify(0x08000000, 0, None, None)  # SHCNE_ASSOCCHANGED
    except Exception:  # noqa: BLE001
        pass
