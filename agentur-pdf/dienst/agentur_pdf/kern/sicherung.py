"""Automatische Sicherung ungespeicherter Änderungen.

Geänderte Dokumente werden regelmäßig (Standard: jede Minute, nur wenn sich
seit der letzten Sicherung etwas getan hat) als PDF in
%APPDATA%\\AgenturPDF\\wiederherstellung abgelegt. Beim Speichern oder
Schließen verschwindet die Sicherung wieder. Stürzt das Programm ab (oder
geht der PC aus), bietet die Oberfläche beim nächsten Start an, die
Dokumente wiederherzustellen.

Kennwortgeschützte Dokumente werden nicht gesichert – ihr Inhalt soll nie
ungeschützt auf der Festplatte landen.

``sichern`` nur im MuPDF-Thread aufrufen.
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime
from pathlib import Path

from .dokumente import OffenesDokument


class Sicherung:
    def __init__(self, ordner: Path) -> None:
        self.ordner = ordner
        self.ordner.mkdir(parents=True, exist_ok=True)
        self._stand: dict[str, int] = {}  # dok_id → gesicherte Version
        self._pid = os.getpid()

    def _name(self, dok_id: str) -> str:
        return f"{self._pid}-{dok_id}"

    def sichern(self, dok: OffenesDokument) -> bool:
        """Sichert ``dok``, falls ungespeicherte Änderungen seit der letzten
        Sicherung dazugekommen sind. True = geschrieben."""
        if not dok.geaendert:
            self.entfernen(dok.id)
            return False
        if dok.war_verschluesselt or (dok.schutz and not dok.schutz.get("aus")) or dok.schutz_gespeichert:
            return False
        if self._stand.get(dok.id) == dok.version:
            return False
        # schnell statt klein: kein Aufräumen, keine Kompression
        daten = dok.doc.tobytes(garbage=0, deflate=False)
        name = self._name(dok.id)
        meta = {
            "pid": self._pid,
            "titel": dok.titel,
            "pfad": dok.pfad,
            "ordner": dok.ordner_vorschlag,
            "seiten": dok.doc.page_count,
            "zeit": datetime.now().isoformat(timespec="seconds"),
        }
        self._atomar(self.ordner / f"{name}.pdf", daten)
        self._atomar(self.ordner / f"{name}.json", json.dumps(meta, ensure_ascii=False).encode("utf-8"))
        self._stand[dok.id] = dok.version
        return True

    def entfernen(self, dok_id: str) -> None:
        self._stand.pop(dok_id, None)
        for endung in (".pdf", ".json"):
            try:
                (self.ordner / f"{self._name(dok_id)}{endung}").unlink()
            except OSError:
                pass

    def alle_entfernen(self) -> None:
        for dok_id in list(self._stand):
            self.entfernen(dok_id)

    # --------------------------------------------- Sicherungen früherer Läufe
    def liste(self) -> list[dict]:
        """Sicherungen aus früheren (abgestürzten) Programmläufen."""
        eintraege = []
        for meta_datei in sorted(self.ordner.glob("*.json")):
            try:
                meta = json.loads(meta_datei.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if meta.get("pid") == self._pid:
                continue
            pdf = meta_datei.with_suffix(".pdf")
            if not pdf.is_file():
                continue
            eintraege.append(
                {
                    "schluessel": meta_datei.stem,
                    "titel": meta.get("titel", pdf.name),
                    "pfad": meta.get("pfad"),
                    "ordner": meta.get("ordner"),
                    "seiten": meta.get("seiten", 0),
                    "zeit": meta.get("zeit", ""),
                    "groesse": pdf.stat().st_size,
                }
            )
        eintraege.sort(key=lambda e: e["zeit"], reverse=True)
        return eintraege

    def lesen(self, schluessel: str) -> tuple[bytes, dict]:
        meta_datei = self._datei(schluessel, ".json")
        meta = json.loads(meta_datei.read_text(encoding="utf-8"))
        return self._datei(schluessel, ".pdf").read_bytes(), meta

    def verwerfen(self, schluessel: str) -> None:
        for endung in (".pdf", ".json"):
            try:
                self._datei(schluessel, endung).unlink()
            except OSError:
                pass

    def aufraeumen(self, tage: int = 30) -> None:
        """Uralte Sicherungen löschen (niemand hat sie wiederhergestellt)."""
        grenze = time.time() - tage * 86400
        for datei in self.ordner.iterdir():
            try:
                if datei.stat().st_mtime < grenze:
                    datei.unlink()
            except OSError:
                pass

    def _datei(self, schluessel: str, endung: str) -> Path:
        if not schluessel or any(z in schluessel for z in "/\\.:"):
            raise ValueError("Ungültiger Schlüssel")
        return self.ordner / f"{schluessel}{endung}"

    @staticmethod
    def _atomar(ziel: Path, daten: bytes) -> None:
        temp = ziel.with_suffix(ziel.suffix + ".tmp")
        temp.write_bytes(daten)
        os.replace(temp, ziel)
