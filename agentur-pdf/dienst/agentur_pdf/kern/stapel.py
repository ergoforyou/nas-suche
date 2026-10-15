"""Stapelverarbeitung: viele Dateien oder ganze Ordner auf einmal.

Je Datei (in dieser Reihenfolge, alles abwählbar):
1. in PDF umwandeln (Bilder, Word, Excel, Mails …)
2. Leerseiten entfernen
3. Texterkennung für Seiten ohne Text (inkl. Ausrichten)
4. Metadaten entfernen
5. Verkleinern (gering … maximal)

Ausgabe: in einen Zielordner, neben das Original (mit Namensmuster) oder
das Original ersetzen (Sicherung im Unterordner „_Original“). Eine Datei,
die gerade bei jemand anderem geöffnet ist, wird nie ersetzt.
"""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass, fields
from datetime import datetime
from pathlib import Path
from typing import Callable

import pymupdf

from . import ausgabe
from .auftraege import Auftrag
from .bearbeitung import _atomar_schreiben, _freier_name, leerseiten_im_dokument
from .dokumente import DokumentFehler
from .konvertierung import Mupdf, konvertieren, unterstuetzt
from .ocr_auftrag import OcrOptionen, ergebnisse_schreiben, seiten_erkennen
from .sperren import Sperren
from .ueberwachung import ORIGINAL_ORDNER
from .zusammenfuehren import _teile_einfuegen

MAX_DATEIEN = 5000
AUSGABEN = ("ordner", "daneben", "ersetzen")


@dataclass
class StapelOptionen:
    texterkennung: bool = True
    sprachen: str = "deu+eng"
    leerseiten_entfernen: bool = False
    metadaten_entfernen: bool = False
    komprimieren: str = ""  # "" | gering | mittel | stark | maximal
    ausgabe: str = "daneben"  # ordner | daneben | ersetzen
    zielordner: str = ""
    namensmuster: str = "{name}_bearbeitet"  # {name} {datum} {zeit} {nr}

    @classmethod
    def aus_dict(cls, d: dict) -> "StapelOptionen":
        o = cls(**{f.name: d[f.name] for f in fields(cls) if f.name in d})
        if o.ausgabe not in AUSGABEN:
            raise DokumentFehler("Unbekannte Ausgabeart.")
        if o.komprimieren and o.komprimieren not in ausgabe.KOMPRIMIERUNG:
            raise DokumentFehler("Unbekannte Komprimierungsstufe.")
        if o.ausgabe == "ordner" and not o.zielordner.strip():
            raise DokumentFehler("Bitte einen Zielordner angeben.")
        if o.ausgabe != "ersetzen" and "{name}" not in o.namensmuster and "{nr}" not in o.namensmuster:
            raise DokumentFehler("Das Namensmuster braucht {name} oder {nr} – sonst hätten alle Dateien denselben Namen.")
        return o


def dateien_sammeln(pfade: list[str], unterordner: bool = False) -> list[Path]:
    """Dateien und Ordner zu einer Liste unterstützter Dateien auflösen
    (Reihenfolge wie angegeben, Ordnerinhalt alphabetisch, ohne Doppelte)."""
    gefunden: dict[str, Path] = {}
    for eingabe in pfade:
        p = Path(eingabe)
        if p.is_dir():
            kandidaten = sorted(p.rglob("*") if unterordner else p.iterdir(), key=lambda x: str(x).lower())
        else:
            kandidaten = [p]
        for k in kandidaten:
            if ORIGINAL_ORDNER in k.parts or k.name.startswith(("~$", ".")):
                continue
            if k.is_file() and unterstuetzt(k.name):
                gefunden.setdefault(os.path.normcase(str(k.resolve())), k)
            if len(gefunden) >= MAX_DATEIEN:
                break
    return list(gefunden.values())


def _zielname(quelle: Path, optionen: StapelOptionen, nr: int) -> str:
    jetzt = datetime.now()
    if optionen.ausgabe == "ersetzen":
        return f"{quelle.stem}.pdf"
    name = optionen.namensmuster.format(
        name=quelle.stem, datum=jetzt.strftime("%Y-%m-%d"), zeit=jetzt.strftime("%H%M"), nr=f"{nr:03d}"
    )
    name = "".join("_" if z in '<>:"/\\|?*' else z for z in name).strip(" .") or quelle.stem
    return f"{name}.pdf"


def _ziel(quelle: Path, optionen: StapelOptionen, nr: int) -> Path:
    name = _zielname(quelle, optionen, nr)
    if optionen.ausgabe == "ordner":
        return _freier_name(Path(optionen.zielordner) / name)
    if optionen.ausgabe == "ersetzen":
        ziel = quelle.with_name(name)
        # Nicht-PDF-Quelle: PDF daneben anlegen, ohne eine fremde PDF zu überschreiben
        return ziel if quelle.suffix.lower() == ".pdf" else _freier_name(ziel)
    return _freier_name(quelle.with_name(name))


def datei_verarbeiten(
    quelle: Path,
    optionen: StapelOptionen,
    mupdf: Mupdf,
    nr: int,
    melden: Callable[[float, str], None] = lambda *_: None,
    sperren: Sperren | None = None,
) -> dict:
    ziel = _ziel(quelle, optionen, nr)
    groesse_vorher = quelle.stat().st_size
    if sperren is not None and optionen.ausgabe == "ersetzen":
        andere = sperren.fremd(str(ziel))
        if andere:
            raise DokumentFehler(f"gerade bei {andere.get('benutzer', '?')} geöffnet – übersprungen")

    teil = konvertieren(quelle.name, pfad=str(quelle), mupdf=mupdf)

    def oeffnen() -> pymupdf.Document:
        doc = pymupdf.open()
        _teile_einfuegen(doc, [teil], mit_lesezeichen=bool(teil.unterteile))
        return doc

    doc: pymupdf.Document = mupdf(oeffnen)
    statistik: dict = {"seiten_vorher": mupdf(lambda: doc.page_count)}
    try:
        if optionen.leerseiten_entfernen:

            def leere_entfernen() -> int:
                leer = leerseiten_im_dokument(doc)
                if not leer or len(leer) >= doc.page_count:
                    return 0
                doc.delete_pages(leer)
                return len(leer)

            statistik["leerseiten"] = mupdf(leere_entfernen)
        if optionen.texterkennung:
            ocr_optionen = OcrOptionen(sprachen=optionen.sprachen)
            seiten = list(range(mupdf(lambda: doc.page_count)))
            ergebnisse, _ = seiten_erkennen(lambda: doc, seiten, ocr_optionen, mupdf, melden)
            if ergebnisse:
                statistik["ocr"] = mupdf(lambda: ergebnisse_schreiben(doc, ergebnisse, ocr_optionen)[0])
        if optionen.metadaten_entfernen:
            mupdf(ausgabe.metadaten_entfernen, doc)

        def daten() -> bytes:
            if optionen.komprimieren:
                return ausgabe.komprimieren(doc, optionen.komprimieren)
            return doc.tobytes(garbage=3, deflate=True)

        neu: bytes = mupdf(daten)
        statistik["seiten"] = mupdf(lambda: doc.page_count)
    finally:
        mupdf(doc.close)

    if optionen.ausgabe == "ersetzen" and ziel.exists():
        sicherung = _freier_name(ziel.parent / ORIGINAL_ORDNER / ziel.name)
        sicherung.parent.mkdir(exist_ok=True)
        shutil.copy2(ziel, sicherung)
    _atomar_schreiben(ziel, neu)
    statistik.update({"quelle": str(quelle), "datei": str(ziel), "groesse_vorher": groesse_vorher, "groesse": len(neu)})
    return statistik


def stapel_ausfuehren(
    dateien: list[Path],
    optionen: StapelOptionen,
    mupdf: Mupdf,
    auftrag: Auftrag,
    sperren: Sperren | None = None,
) -> dict:
    if not dateien:
        raise DokumentFehler("Keine passenden Dateien gefunden.")
    if optionen.ausgabe == "ordner":
        Path(optionen.zielordner).mkdir(parents=True, exist_ok=True)
    fertig: list[str] = []
    fehler: list[dict] = []
    vorher = nachher = 0
    n = len(dateien)
    for i, quelle in enumerate(dateien):
        auftrag.melden(i / n, f"{i + 1}/{n}: {quelle.name}")

        def melden(anteil: float, schritt: str, i: int = i, name: str = quelle.name) -> None:
            auftrag.melden((i + anteil) / n, f"{i + 1}/{n}: {name} – {schritt}")

        try:
            ergebnis = datei_verarbeiten(quelle, optionen, mupdf, i + 1, melden, sperren)
            fertig.append(ergebnis["datei"])
            vorher += ergebnis["groesse_vorher"]
            nachher += ergebnis["groesse"]
        except DokumentFehler as f:
            fehler.append({"datei": str(quelle), "fehler": str(f)})
        except Exception as f:  # noqa: BLE001 – eine kaputte Datei darf den Stapel nicht stoppen
            fehler.append({"datei": str(quelle), "fehler": f"Unerwarteter Fehler: {f}"})
    auftrag.melden(1.0, "Fertig")
    return {"dateien": fertig, "fehler": fehler, "anzahl": n, "groesse_vorher": vorher, "groesse": nachher, "stapel": True}
