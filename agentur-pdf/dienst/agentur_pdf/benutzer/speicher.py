"""Benutzerdaten: Einstellungen, zuletzt geöffnet, Favoriten-Ordner, Sitzung.

Ablage pro Windows-Benutzer unter %APPDATA%\\AgenturPDF (sonst ~/.agentur-pdf).
Mit der Umgebungsvariablen AGENTUR_PDF_DATEN lässt sich der Ort überschreiben
(z. B. für Tests).
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any

MAX_ZULETZT = 20

STANDARD_EINSTELLUNGEN: dict[str, Any] = {
    "design": "hell",  # hell | dunkel | system
    "akzentfarbe": "#B5121B",
    "kuerzel": "",
    "standard_ansicht": "fortlaufend",
    "standard_zoom": "seitenbreite",
    "miniatur_groesse": 120,
    "seitenleiste_breite": 220,
    "ocr_sprachen": "deu+eng",
    # Überwachungsordner: [{ordner, ziel, original_sichern, leerseiten_entfernen, aktiv}]
    "ueberwachung": [],
    # Stempelvorlagen: {datum}, {zeit}, {kuerzel} werden beim Setzen ersetzt
    "stempel": [
        {"text": "EINGEGANGEN\n{datum} · {kuerzel}", "farbe": "#C0262D"},
        {"text": "ERLEDIGT\n{datum} · {kuerzel}", "farbe": "#1F7A3A"},
        {"text": "GEBUCHT\n{datum} · {kuerzel}", "farbe": "#1E4FA8"},
        {"text": "ZUR AKTE\n{datum}", "farbe": "#555555"},
        {"text": "KOPIE", "farbe": "#C0262D"},
        {"text": "VERTRAULICH", "farbe": "#C0262D"},
    ],
    # Screenshot-Werkzeug
    "screenshot_aktiv": True,
    "screenshot_taste": "Strg+Umschalt+Druck",
    "screenshot_ordner": "",
    "screenshot_ocr": True,
    "screenshot_text_kopieren": False,
    # zuletzt benutzte Stile je Werkzeug (Farbe, Linienbreite …)
    "werkzeug_stile": {},
}


def datenordner() -> Path:
    if os.environ.get("AGENTUR_PDF_DATEN"):
        basis = Path(os.environ["AGENTUR_PDF_DATEN"])
    elif os.environ.get("APPDATA"):
        basis = Path(os.environ["APPDATA"]) / "AgenturPDF"
    else:
        basis = Path.home() / ".agentur-pdf"
    basis.mkdir(parents=True, exist_ok=True)
    return basis


class BenutzerSpeicher:
    def __init__(self, ordner: Path | None = None) -> None:
        self.ordner = ordner or datenordner()
        self.ordner.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def _lesen(self, name: str, standard: Any) -> Any:
        datei = self.ordner / f"{name}.json"
        try:
            return json.loads(datei.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return standard

    def _schreiben(self, name: str, wert: Any) -> None:
        datei = self.ordner / f"{name}.json"
        temp = datei.with_suffix(".tmp")
        temp.write_text(json.dumps(wert, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temp, datei)  # atomar – kein halbes JSON nach Absturz

    # ---------------------------------------------------------- Einstellungen
    def einstellungen(self) -> dict:
        with self._lock:
            return {**STANDARD_EINSTELLUNGEN, **self._lesen("einstellungen", {})}

    def einstellungen_setzen(self, aenderungen: dict) -> dict:
        with self._lock:
            aktuell = {**STANDARD_EINSTELLUNGEN, **self._lesen("einstellungen", {})}
            aktuell.update({k: v for k, v in aenderungen.items() if k in STANDARD_EINSTELLUNGEN})
            self._schreiben("einstellungen", aktuell)
            return aktuell

    # --------------------------------------------------------- Zuletzt offen
    def zuletzt(self) -> list[dict]:
        with self._lock:
            eintraege = self._lesen("zuletzt", [])
        return [{**e, "vorhanden": os.path.isfile(e["pfad"])} for e in eintraege]

    def zuletzt_hinzufuegen(self, pfad: str, titel: str, seitenanzahl: int) -> None:
        from datetime import datetime

        with self._lock:
            eintraege = [e for e in self._lesen("zuletzt", []) if os.path.normcase(e["pfad"]) != os.path.normcase(pfad)]
            eintraege.insert(0, {"pfad": pfad, "titel": titel, "seiten": seitenanzahl, "zeit": datetime.now().isoformat(timespec="seconds")})
            self._schreiben("zuletzt", eintraege[:MAX_ZULETZT])

    def zuletzt_entfernen(self, pfad: str) -> None:
        with self._lock:
            eintraege = [e for e in self._lesen("zuletzt", []) if os.path.normcase(e["pfad"]) != os.path.normcase(pfad)]
            self._schreiben("zuletzt", eintraege)

    # -------------------------------------------------------------- Favoriten
    def favoriten(self) -> list[str]:
        with self._lock:
            return self._lesen("favoriten", [])

    def favoriten_setzen(self, ordner: list[str]) -> list[str]:
        bereinigt = list(dict.fromkeys(os.path.abspath(o) for o in ordner if o))
        with self._lock:
            self._schreiben("favoriten", bereinigt)
        return bereinigt

    # ---------------------------------------------------------------- Sitzung
    def sitzung(self) -> dict:
        with self._lock:
            return self._lesen("sitzung", {"dokumente": [], "aktiv": None})

    def sitzung_setzen(self, sitzung: dict) -> None:
        with self._lock:
            self._schreiben("sitzung", sitzung)
