"""Benutzerdaten: Einstellungen, zuletzt geöffnet, Favoriten-Ordner, Sitzung.

Ablage pro Windows-Benutzer unter %APPDATA%\\AgenturPDF (sonst ~/.agentur-pdf).
Mit der Umgebungsvariablen AGENTUR_PDF_DATEN lässt sich der Ort überschreiben
(z. B. für Tests).

Gemeinsame Einstellungen: Ist ein „gemeinsamer Ordner“ (z. B. auf dem NAS)
eingetragen, liegen Stempel, Texterkennungssprachen, Favoriten-Ordner und
das eigene Wörterbuch dort – für alle Arbeitsplätze gleich. Persönliches
(Kürzel, Unterschriften, Ansicht, Screenshot-Ordner) bleibt am PC. Ist das NAS
nicht erreichbar, wird mit der zuletzt gelesenen Fassung weitergearbeitet.
"""

from __future__ import annotations

import json
import os
import threading
import time
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
    "screenshot_bild_kopieren": True,
    # zuletzt benutzte Stile je Werkzeug (Farbe, Linienbreite …)
    "werkzeug_stile": {},
    # Ordner für gemeinsame Einstellungen aller Arbeitsplätze (NAS), leer = aus
    "gemeinsamer_ordner": "",
}

# Diese Einstellungen gelten – bei eingetragenem gemeinsamem Ordner – für alle
GEMEINSAME_SCHLUESSEL = ("stempel", "ocr_sprachen")
GEMEINSAM_DATEI = "einstellungen.json"
GEMEINSAM_NEU_LESEN_S = 20


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
        # gemeinsame Einstellungen: zuletzt gelesene Fassung + Zeitpunkt
        self._gemeinsam: dict | None = None
        self._gemeinsam_gelesen = 0.0
        self.gemeinsam_fehler: str | None = None

    # ------------------------------------------------- gemeinsamer Ordner
    def gemeinsamer_ordner(self) -> Path | None:
        ordner = str(self._lesen("einstellungen", {}).get("gemeinsamer_ordner") or "").strip()
        return Path(ordner) if ordner else None

    def _gemeinsam_holen(self, neu: bool = False) -> dict | None:
        """Gemeinsame Einstellungen (zwischengespeichert, Rückfall: lokale Kopie)."""
        ordner = self.gemeinsamer_ordner()
        if ordner is None:
            self.gemeinsam_fehler = None
            return None
        if not neu and self._gemeinsam is not None and time.time() - self._gemeinsam_gelesen < GEMEINSAM_NEU_LESEN_S:
            return self._gemeinsam
        try:
            daten = json.loads((ordner / GEMEINSAM_DATEI).read_text(encoding="utf-8"))
            self.gemeinsam_fehler = None
            self._schreiben("gemeinsam_kopie", daten)
        except FileNotFoundError:
            daten = {}
            self.gemeinsam_fehler = None if ordner.is_dir() else "Ordner nicht erreichbar"
        except (OSError, ValueError) as fehler:
            daten = self._lesen("gemeinsam_kopie", {})
            self.gemeinsam_fehler = f"Nicht erreichbar – letzte bekannte Fassung wird benutzt ({fehler.__class__.__name__})"
        self._gemeinsam = daten
        self._gemeinsam_gelesen = time.time()
        return daten

    def _gemeinsam_schreiben(self, aenderungen: dict) -> None:
        ordner = self.gemeinsamer_ordner()
        if ordner is None:
            return
        datei = ordner / GEMEINSAM_DATEI
        try:
            aktuell = json.loads(datei.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            aktuell = {}
        aktuell.update(aenderungen)
        ordner.mkdir(parents=True, exist_ok=True)
        temp = datei.with_name(f".{datei.name}.{os.getpid()}.tmp")
        temp.write_text(json.dumps(aktuell, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temp, datei)
        self._gemeinsam = aktuell
        self._gemeinsam_gelesen = time.time()
        self._schreiben("gemeinsam_kopie", aktuell)

    def gemeinsam_status(self) -> dict:
        ordner = self.gemeinsamer_ordner()
        with self._lock:
            self._gemeinsam_holen(neu=True)
        return {
            "aktiv": ordner is not None,
            "ordner": str(ordner) if ordner else "",
            "erreichbar": ordner is not None and self.gemeinsam_fehler is None,
            "fehler": self.gemeinsam_fehler,
            "schluessel": list(GEMEINSAME_SCHLUESSEL) + ["favoriten", "woerterbuch"],
        }

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
            werte = {**STANDARD_EINSTELLUNGEN, **self._lesen("einstellungen", {})}
            gemeinsam = self._gemeinsam_holen()
            if gemeinsam:
                werte.update({k: gemeinsam[k] for k in GEMEINSAME_SCHLUESSEL if k in gemeinsam})
            return werte

    def einstellungen_setzen(self, aenderungen: dict) -> dict:
        aenderungen = {k: v for k, v in aenderungen.items() if k in STANDARD_EINSTELLUNGEN}
        with self._lock:
            lokal = {**STANDARD_EINSTELLUNGEN, **self._lesen("einstellungen", {})}
            alter_ordner = lokal.get("gemeinsamer_ordner") or ""
            if "gemeinsamer_ordner" in aenderungen:
                aenderungen["gemeinsamer_ordner"] = str(aenderungen["gemeinsamer_ordner"] or "").strip()
            gemeinsam_aktiv = bool(aenderungen.get("gemeinsamer_ordner", alter_ordner))
            fuer_alle = {k: v for k, v in aenderungen.items() if k in GEMEINSAME_SCHLUESSEL} if gemeinsam_aktiv else {}
            lokal.update({k: v for k, v in aenderungen.items() if k not in fuer_alle})
            self._schreiben("einstellungen", lokal)
            if aenderungen.get("gemeinsamer_ordner") and aenderungen["gemeinsamer_ordner"] != alter_ordner:
                # Neu eingerichtet: fehlt dort noch etwas, gilt erst einmal das von diesem PC
                vorhanden = self._gemeinsam_holen(neu=True) or {}
                fehlend = {k: lokal[k] for k in GEMEINSAME_SCHLUESSEL if k not in vorhanden}
                if fehlend:
                    self._gemeinsam_schreiben(fehlend)
                favoriten = self._lesen("favoriten", [])
                if favoriten and not (self.gemeinsamer_ordner() / "favoriten.json").exists():
                    self._favoriten_gemeinsam_schreiben(favoriten)
            if fuer_alle:
                self._gemeinsam_schreiben(fuer_alle)
            werte = dict(lokal)
            gemeinsam = self._gemeinsam_holen()
            if gemeinsam:
                werte.update({k: gemeinsam[k] for k in GEMEINSAME_SCHLUESSEL if k in gemeinsam})
            return werte

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
            gemeinsam = self.gemeinsamer_ordner()
            if gemeinsam is not None:
                try:
                    return json.loads((gemeinsam / "favoriten.json").read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    pass
            return self._lesen("favoriten", [])

    def favoriten_setzen(self, ordner: list[str]) -> list[str]:
        bereinigt = list(dict.fromkeys(os.path.abspath(o) for o in ordner if o))
        with self._lock:
            self._schreiben("favoriten", bereinigt)
            if self.gemeinsamer_ordner() is not None:
                try:
                    self._favoriten_gemeinsam_schreiben(bereinigt)
                except OSError:
                    pass
        return bereinigt

    def _favoriten_gemeinsam_schreiben(self, liste: list[str]) -> None:
        ordner = self.gemeinsamer_ordner()
        datei = ordner / "favoriten.json"
        temp = datei.with_name(f".favoriten.{os.getpid()}.tmp")
        temp.write_text(json.dumps(liste, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temp, datei)

    # ---------------------------------------------------------------- Sitzung
    def sitzung(self) -> dict:
        with self._lock:
            return self._lesen("sitzung", {"dokumente": [], "aktiv": None})

    def sitzung_setzen(self, sitzung: dict) -> None:
        with self._lock:
            self._schreiben("sitzung", sitzung)
