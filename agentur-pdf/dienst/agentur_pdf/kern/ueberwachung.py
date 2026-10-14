"""Überwachungsordner: Neue Scans (z. B. vom ScanSnap) automatisch verarbeiten.

Je Ordner einstellbar:
* Texterkennung für Seiten ohne Text (Seiten mit ScanSnap-Text bleiben, wie sie sind)
* Leerseiten entfernen (Duplex-Rückseiten)
* Ergebnis an Ort und Stelle oder in einen Zielordner; Original optional in
  den Unterordner „_Original“

Bewusst mit regelmäßigem Nachsehen statt Datei-Benachrichtigungen: Auf
NAS-Freigaben kommen Benachrichtigungen oft nicht zuverlässig an.
Eine Datei wird erst angefasst, wenn sie zwei Durchgänge lang unverändert ist
(der Scanner schreibt nicht mehr).
"""

from __future__ import annotations

import json
import shutil
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import pymupdf

from ..benutzer.speicher import datenordner
from .bearbeitung import _atomar_schreiben, _freier_name, leerseiten_im_dokument
from .dokumente import DokumentFehler
from .konvertierung import Mupdf
from .ocr_auftrag import OcrOptionen, ergebnisse_schreiben, seiten_erkennen

INTERVALL_S = 5
MARKIERUNG = "AgenturPDF-OCR"  # im PDF-Erzeuger vermerkt → nie doppelt verarbeiten
ORIGINAL_ORDNER = "_Original"


@dataclass
class OrdnerRegel:
    ordner: str
    ziel: str = ""  # leer = an Ort und Stelle ersetzen
    original_sichern: bool = True
    leerseiten_entfernen: bool = True
    aktiv: bool = True

    @classmethod
    def aus_dict(cls, d: dict) -> "OrdnerRegel":
        return cls(**{k: d[k] for k in cls.__dataclass_fields__ if k in d})


def datei_verarbeiten(pfad: Path, regel: OrdnerRegel, mupdf: Mupdf, melden: Callable[[float, str], None] = lambda *_: None) -> dict:
    """Eine Scan-PDF verarbeiten. Liefert eine kurze Zusammenfassung."""
    daten = pfad.read_bytes()
    doc: pymupdf.Document = mupdf(lambda: pymupdf.open("pdf", daten))
    try:
        if mupdf(lambda: doc.needs_pass):
            raise DokumentFehler("passwortgeschützt – wird übersprungen")
        # Zuerst Leerseiten entfernen: spart Erkennungszeit, und Staub/Rauschen
        # auf leeren Rückseiten kann so nicht als „Text“ enden.
        def leere_entfernen() -> int:
            if not regel.leerseiten_entfernen:
                return 0
            leer = leerseiten_im_dokument(doc)
            if not leer or len(leer) >= doc.page_count:
                return 0
            doc.delete_pages(leer)
            return len(leer)

        entfernt = mupdf(leere_entfernen)
        seiten = list(range(mupdf(lambda: doc.page_count)))
        optionen = OcrOptionen()
        ergebnisse, _ = seiten_erkennen(lambda: doc, seiten, optionen, mupdf, melden)

        def fertigstellen() -> tuple[bytes, dict]:
            statistik, _ = ergebnisse_schreiben(doc, ergebnisse, optionen)
            meta = doc.metadata or {}
            erzeuger = meta.get("producer") or ""
            doc.set_metadata({**meta, "producer": f"{erzeuger} · {MARKIERUNG}".strip(" ·")})
            statistik["leerseiten_entfernt"] = entfernt
            statistik["seiten"] = doc.page_count
            return doc.tobytes(garbage=3, deflate=True), statistik

        neu, statistik = mupdf(fertigstellen)
    finally:
        mupdf(doc.close)

    if regel.original_sichern:
        sicherung = _freier_name(pfad.parent / ORIGINAL_ORDNER / pfad.name)
        sicherung.parent.mkdir(exist_ok=True)
        shutil.copy2(pfad, sicherung)
    if regel.ziel:
        ziel = _freier_name(Path(regel.ziel) / pfad.name)
        _atomar_schreiben(ziel, neu)
        pfad.unlink()
    else:
        ziel = pfad
        _atomar_schreiben(ziel, neu)
    return {**statistik, "datei": str(ziel)}


class Ueberwachung:
    def __init__(self, regeln_holen: Callable[[], list[dict]], mupdf: Mupdf, ereignis: Callable[[dict], None]) -> None:
        self._regeln_holen = regeln_holen
        self._mupdf = mupdf
        self._ereignis = ereignis
        self._stopp = threading.Event()
        self._thread: threading.Thread | None = None
        self._gesehen: dict[str, tuple[int, float]] = {}  # Pfad → (Größe, Änderungszeit) beim letzten Blick
        self._erledigt_datei = datenordner() / "ueberwachung_erledigt.json"
        self._erledigt: dict[str, float] = self._erledigt_laden()
        self.protokoll: list[dict] = []  # letzte Verarbeitungen (für die Oberfläche)

    def _erledigt_laden(self) -> dict[str, float]:
        try:
            return json.loads(self._erledigt_datei.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def _erledigt_merken(self, pfad: Path) -> None:
        try:
            self._erledigt[str(pfad)] = pfad.stat().st_mtime
        except OSError:
            return
        # nur die letzten 2000 Einträge behalten
        if len(self._erledigt) > 2000:
            self._erledigt = dict(list(self._erledigt.items())[-2000:])
        try:
            self._erledigt_datei.write_text(json.dumps(self._erledigt), encoding="utf-8")
        except OSError:
            pass

    def starten(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stopp.clear()
        self._thread = threading.Thread(target=self._schleife, name="ueberwachung", daemon=True)
        self._thread.start()

    def stoppen(self) -> None:
        self._stopp.set()

    def _schleife(self) -> None:
        while not self._stopp.wait(INTERVALL_S):
            self.durchgang()

    def durchgang(self) -> list[dict]:
        """Ein Prüfdurchgang über alle aktiven Ordner (auch für Tests)."""
        ergebnisse = []
        for roh in self._regeln_holen():
            regel = OrdnerRegel.aus_dict(roh)
            if not regel.aktiv or not Path(regel.ordner).is_dir():
                continue
            # Endung ohne Rücksicht auf Groß-/Kleinschreibung prüfen – NICHT „*.pdf“ und
            # „*.PDF“ getrennt suchen: Unter Windows liefern beide dieselben Dateien.
            for pfad in sorted(Path(regel.ordner).iterdir()):
                if pfad.suffix.lower() != ".pdf" or pfad.name.startswith((".", "~")) or not pfad.is_file():
                    continue
                ergebnis = self._pruefen(pfad, regel)
                if ergebnis:
                    ergebnisse.append(ergebnis)
        return ergebnisse

    def _pruefen(self, pfad: Path, regel: OrdnerRegel) -> dict | None:
        try:
            st = pfad.stat()
        except OSError:
            return None
        schluessel = str(pfad)
        if self._erledigt.get(schluessel) == st.st_mtime:
            return None
        zustand = (st.st_size, st.st_mtime)
        if self._gesehen.get(schluessel) != zustand:
            self._gesehen[schluessel] = zustand  # erst beim nächsten Durchgang, wenn unverändert
            return None
        self._gesehen.pop(schluessel, None)
        if self._schon_verarbeitet(pfad):
            self._erledigt_merken(pfad)
            return None
        eintrag = {"datei": pfad.name, "ordner": regel.ordner, "zeit": time.time()}
        try:
            ergebnis = datei_verarbeiten(pfad, regel, self._mupdf)
            ergebnis_pfad = ergebnis.pop("datei")
            eintrag.update(ok=True, ergebnis_datei=ergebnis_pfad, **ergebnis)
            self._erledigt_merken(Path(ergebnis_pfad))
            text = f"Scan verarbeitet: {pfad.name} ({ergebnis['erkannt']} Seite(n) erkannt"
            if ergebnis.get("leerseiten_entfernt"):
                text += f", {ergebnis['leerseiten_entfernt']} Leerseite(n) entfernt"
            self._ereignis({"art": "info", "text": text + ")"})
        except (DokumentFehler, OSError, RuntimeError) as fehler:
            eintrag.update(ok=False, fehler=str(fehler))
            self._erledigt_merken(pfad)  # nicht endlos erneut versuchen
            self._ereignis({"art": "meldung", "text": f"Überwachungsordner: {pfad.name}: {fehler}"})
        self.protokoll = ([eintrag] + self.protokoll)[:50]
        return eintrag

    def _schon_verarbeitet(self, pfad: Path) -> bool:
        def pruefen() -> bool:
            try:
                with pymupdf.open(pfad) as doc:
                    return MARKIERUNG in ((doc.metadata or {}).get("producer") or "")
            except Exception:  # noqa: BLE001 – unlesbar: Verarbeitung meldet den Fehler
                return False

        return self._mupdf(pruefen)
