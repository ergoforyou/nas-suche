"""Screenshots verarbeiten: als PNG im zentralen Ordner ablegen, auf Wunsch
mit Texterkennung eine gleichnamige durchsuchbare PDF erzeugen.

Das Aufnehmen selbst (Tastenkürzel, Bereich wählen) ist Windows-spezifisch
und liegt in ``windows/screenshot.py``.
"""

from __future__ import annotations

import io
import os
from datetime import datetime
from pathlib import Path
from typing import Callable

import pymupdf
from PIL import Image

from .bearbeitung import _atomar_schreiben, _freier_name
from .konvertierung import Mupdf
from .ocr import tesseract_finden
from .ocr_auftrag import OcrOptionen, ergebnisse_schreiben, seiten_erkennen


def standardordner() -> Path:
    basis = Path(os.environ.get("USERPROFILE") or Path.home())
    return basis / "Pictures" / "Screenshots" / "Agentur-PDF"


def dateiname(kuerzel: str = "", jetzt: datetime | None = None) -> str:
    jetzt = jetzt or datetime.now()
    zusatz = "".join(c for c in kuerzel.strip() if c.isalnum() or c in "-_")
    return jetzt.strftime("%Y-%m-%d_%H-%M-%S") + (f"_{zusatz}" if zusatz else "") + ".png"


def verarbeiten(
    png: bytes,
    ordner: str,
    kuerzel: str,
    mit_ocr: bool,
    mupdf: Mupdf,
    sprachen: str = "deu+eng",
    melden: Callable[[float, str], None] = lambda *_: None,
) -> dict:
    """PNG speichern und optional PDF mit unsichtbarer Textebene erzeugen.

    Ergebnis: {"png": Pfad, "pdf": Pfad | None, "text": erkannter Text}
    """
    ziel = Path(ordner) if ordner.strip() else standardordner()
    ziel.mkdir(parents=True, exist_ok=True)
    pfad_png = _freier_name(ziel / dateiname(kuerzel))
    _atomar_schreiben(pfad_png, png)
    ergebnis: dict = {"png": str(pfad_png), "pdf": None, "text": ""}
    if not mit_ocr or tesseract_finden() is None:
        return ergebnis

    # Bildschirmauflösung: 96 dpi → Seite in Originalgröße (1 px = 0,75 pt)
    with Image.open(io.BytesIO(png)) as im:
        breite, hoehe = im.size

    def anlegen() -> pymupdf.Document:
        doc = pymupdf.open()
        seite = doc.new_page(width=breite * 0.75, height=hoehe * 0.75)
        seite.insert_image(seite.rect, stream=png)
        return doc

    doc = mupdf(anlegen)
    try:
        optionen = OcrOptionen(sprachen=sprachen, ausrichten=False, entzerren=False)
        ergebnisse, _ = seiten_erkennen(lambda: doc, [0], optionen, mupdf, melden)

        def fertig() -> tuple[bytes, str]:
            ergebnisse_schreiben(doc, ergebnisse, optionen)
            doc.set_metadata({"title": pfad_png.stem, "producer": "Ergoforyou PDF Screenshot"})
            return doc.tobytes(garbage=3, deflate=True), doc[0].get_text("text").strip()

        pdf, text = mupdf(fertig)
    finally:
        mupdf(doc.close)
    pfad_pdf = pfad_png.with_suffix(".pdf")
    _atomar_schreiben(pfad_pdf, pdf)
    ergebnis.update(pdf=str(pfad_pdf), text=text)
    return ergebnis
