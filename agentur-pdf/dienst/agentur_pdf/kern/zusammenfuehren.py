"""Zusammenführen mehrerer Dateien zu einer PDF und „In PDF umwandeln“."""

from __future__ import annotations

import os
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path

import pymupdf

from .auftraege import Auftrag
from .bearbeitung import _atomar_schreiben, _freier_name
from .dokumente import DokumentFehler, DokumentSpeicher, OffenesDokument
from .konvertierung import Mupdf, Teil, konvertieren


@dataclass
class Eintrag:
    name: str
    pfad: str


def _teile_einfuegen(ziel: pymupdf.Document, teile: list[Teil], mit_lesezeichen: bool) -> None:
    toc: list[list] = []

    def hinzufuegen(teil: Teil, ebene: int) -> None:
        quelle = pymupdf.open("pdf", teil.pdf)
        start = ziel.page_count
        quell_toc = quelle.get_toc() if mit_lesezeichen else []
        ziel.insert_pdf(quelle)
        quelle.close()
        if mit_lesezeichen:
            toc.append([ebene, teil.titel, start + 1])
            # vorhandene Lesezeichen der Quelle eine Ebene tiefer übernehmen
            toc.extend([ebene + lvl, titel, start + seite] for lvl, titel, seite, *_ in quell_toc if seite > 0)
        for unterteil in teil.unterteile:
            hinzufuegen(unterteil, ebene + 1)

    for teil in teile:
        hinzufuegen(teil, 1)
    if toc:
        ziel.set_toc(toc)


def _registrieren(speicher: DokumentSpeicher, doc: pymupdf.Document, titel: str, ordner: str | None) -> OffenesDokument:
    dok = speicher._registrieren(doc, titel, None, None)
    dok.geaendert = True
    dok.ordner_vorschlag = ordner
    return dok


def zusammenfuehren(
    eintraege: list[Eintrag],
    speicher: DokumentSpeicher,
    auftrag: Auftrag,
    mupdf: Mupdf,
    lesezeichen: bool = True,
    anhaenge: bool = True,
) -> dict:
    if not eintraege:
        raise DokumentFehler("Keine Dateien zum Zusammenführen.")
    teile: list[Teil] = []
    for i, e in enumerate(eintraege):
        auftrag.melden(i / (len(eintraege) + 1), f"Wandle „{e.name}“ um ({i + 1}/{len(eintraege)}) …")
        teile.append(konvertieren(e.name, pfad=e.pfad, mupdf=mupdf, anhaenge=anhaenge))
    auftrag.melden(len(eintraege) / (len(eintraege) + 1), "Füge zusammen …")

    erster = Path(eintraege[0].name).stem
    titel = f"{erster}.pdf" if len(eintraege) == 1 else f"{erster} (zusammengeführt).pdf"
    ordner = _ordner_von(eintraege[0])

    def aufbauen() -> str:
        ziel = pymupdf.open()
        _teile_einfuegen(ziel, teile, lesezeichen)
        return _registrieren(speicher, ziel, titel, ordner).id

    dok_id = mupdf(aufbauen)
    return {"dokumente": [dok_id], "oeffnen": True}


def umwandeln(
    eintraege: list[Eintrag],
    speicher: DokumentSpeicher,
    auftrag: Auftrag,
    mupdf: Mupdf,
    speichern: bool,
    anhaenge: bool = True,
) -> dict:
    """Jede Datei einzeln in PDF umwandeln und öffnen. Mit ``speichern`` wird
    die PDF direkt neben die Quelldatei gelegt (Name.pdf, bei Konflikt Name (2).pdf)."""
    dok_ids, dateien = [], []
    for i, e in enumerate(eintraege):
        auftrag.melden(i / len(eintraege), f"Wandle „{e.name}“ um ({i + 1}/{len(eintraege)}) …")
        teil = konvertieren(e.name, pfad=e.pfad, mupdf=mupdf, anhaenge=anhaenge)
        ordner = _ordner_von(e)

        def aufbauen(teil: Teil = teil, e: Eintrag = e, ordner: str | None = ordner) -> tuple[str, str | None]:
            ziel = pymupdf.open()
            _teile_einfuegen(ziel, [teil], mit_lesezeichen=bool(teil.unterteile))
            dok = _registrieren(speicher, ziel, f"{Path(e.name).stem}.pdf", ordner)
            if speichern and ordner:
                pfad = _freier_name(Path(ordner) / f"{Path(e.name).stem}.pdf")
                _atomar_schreiben(pfad, ziel.tobytes(garbage=3, deflate=True))
                dok.pfad, dok.titel, dok.geaendert = str(pfad), pfad.name, False
                return dok.id, str(pfad)
            return dok.id, None

        dok_id, datei = mupdf(aufbauen)
        dok_ids.append(dok_id)
        if datei:
            dateien.append(datei)
    return {"dokumente": dok_ids, "dateien": dateien, "oeffnen": True}


def _ordner_von(e: Eintrag) -> str | None:
    """Ordner der Quelldatei – nicht bei hochgeladenen (temporären) Dateien."""
    if Uploads.ist_upload(e.pfad):
        return None
    return str(Path(e.pfad).parent)


class Uploads:
    """Zwischenablage für hochgeladene Dateien (Browser-Modus, Drag aus Outlook)."""

    _ordner = Path(tempfile.gettempdir()) / f"agentur-pdf-uploads-{os.getpid()}"

    def __init__(self) -> None:
        self._dateien: dict[str, tuple[str, Path]] = {}
        self._ordner.mkdir(parents=True, exist_ok=True)

    @classmethod
    def ist_upload(cls, pfad: str) -> bool:
        try:
            return Path(pfad).resolve().is_relative_to(cls._ordner.resolve())
        except OSError:
            return False

    def speichern(self, name: str, daten: bytes) -> str:
        uid = uuid.uuid4().hex[:12]
        sicher = Path(name).name or "datei"
        pfad = self._ordner / uid
        pfad.mkdir()
        (pfad / sicher).write_bytes(daten)
        self._dateien[uid] = (sicher, pfad / sicher)
        return uid

    def get(self, uid: str) -> Eintrag:
        try:
            name, pfad = self._dateien[uid]
        except KeyError:
            raise DokumentFehler("Hochgeladene Datei nicht mehr vorhanden – bitte erneut hinzufügen.") from None
        return Eintrag(name, str(pfad))

    def aufraeumen(self) -> None:
        import shutil

        shutil.rmtree(self._ordner, ignore_errors=True)
