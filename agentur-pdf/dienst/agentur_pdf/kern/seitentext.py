"""Seitengestaltung: Wasserzeichen sowie Kopf- und Fußzeilen mit
Seitenzahlen. Beides wird auf eigene Ebenen geschrieben – so lässt es sich
im Ebenen-Bereich ausblenden oder beim Export weglassen.

Nur im MuPDF-Thread aufrufen.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

import pymupdf

from .anmerkungen import hex_zu_rgb
from .dokumente import DokumentFehler

EBENE_WASSERZEICHEN = "Wasserzeichen"
EBENE_KOPF_FUSS = "Kopf- und Fußzeilen"
SCHRIFTEN = {"helvetica": "helv", "helvetica-fett": "hebo", "times": "tiro", "courier": "cour"}


def _ebene(doc: pymupdf.Document, name: str) -> int:
    for xref, e in (doc.get_ocgs() or {}).items():
        if e.get("name") == name:
            return xref
    return doc.add_ocg(name, on=True)


def _seiten(doc: pymupdf.Document, seiten: list[int] | None) -> list[int]:
    if seiten is None:
        return list(range(doc.page_count))
    gueltig = sorted({s for s in seiten if 0 <= s < doc.page_count})
    if not gueltig:
        raise DokumentFehler("Keine gültigen Seiten ausgewählt.")
    return gueltig


def _text_ersetzen(vorlage: str, nr: int, anzahl: int, titel: str) -> str:
    jetzt = datetime.now()
    return (
        vorlage.replace("{seite}", str(nr))
        .replace("{seiten}", str(anzahl))
        .replace("{datum}", jetzt.strftime("%d.%m.%Y"))
        .replace("{zeit}", jetzt.strftime("%H:%M"))
        .replace("{datei}", Path(titel).stem)
    )


def wasserzeichen(
    doc: pymupdf.Document,
    text: str,
    seiten: list[int] | None = None,
    farbe: str = "#C0262D",
    deckkraft: float = 0.2,
    schriftgroesse: float = 0,
    winkel: float = 45,
    schrift: str = "helvetica-fett",
) -> list[int]:
    """Großer, halbtransparenter Text quer über die Seite (Ebene „Wasserzeichen“)."""
    text = text.strip()
    if not text:
        raise DokumentFehler("Bitte einen Text für das Wasserzeichen eingeben.")
    font = SCHRIFTEN.get(schrift, "hebo")
    oc = _ebene(doc, EBENE_WASSERZEICHEN)
    rgb = hex_zu_rgb(farbe) or (0.75, 0.15, 0.15)
    ziel = _seiten(doc, seiten)
    for nr in ziel:
        seite = doc[nr]
        r = seite.rect  # angezeigte Seite
        mitte_anzeige = pymupdf.Point((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2)
        groesse = schriftgroesse or _passende_groesse(text, font, r, winkel)
        breite = pymupdf.get_text_length(text, font, groesse)
        # in ungedrehte Seitenkoordinaten umrechnen; Drehung der Seite ausgleichen
        mitte = mitte_anzeige * seite.derotation_matrix
        start = pymupdf.Point(mitte.x - breite / 2, mitte.y + groesse * 0.35)
        seite.insert_text(
            start,
            text,
            fontsize=groesse,
            fontname=font,
            color=rgb,
            fill_opacity=max(0.05, min(1.0, deckkraft)),
            morph=(mitte, pymupdf.Matrix(winkel + seite.rotation)),
            oc=oc,
        )
    return ziel


def _passende_groesse(text: str, font: str, r: pymupdf.Rect, winkel: float) -> float:
    """Schriftgröße, bei der der Text die Seitendiagonale zu ~70 % füllt."""
    import math

    laenge = math.hypot(r.width, r.height) if winkel % 90 else (r.width if winkel % 180 == 0 else r.height)
    breite_1pt = max(1e-3, pymupdf.get_text_length(text, font, 1))
    return max(12.0, min(220.0, laenge * 0.7 / breite_1pt))


def kopf_fuss(
    doc: pymupdf.Document,
    felder: dict[str, str],
    titel: str,
    seiten: list[int] | None = None,
    schriftgroesse: float = 9,
    farbe: str = "#333333",
    rand_mm: float = 10,
    schrift: str = "helvetica",
    erste_nummer: int = 1,
) -> list[int]:
    """Text in bis zu sechs Positionen (oben/unten × links/mitte/rechts).

    ``felder``: z. B. {"unten_mitte": "Seite {seite} von {seiten}"}.
    Platzhalter: {seite}, {seiten}, {datum}, {zeit}, {datei}.
    """
    positionen = {k: v for k, v in felder.items() if v and v.strip()}
    if not positionen:
        raise DokumentFehler("Bitte mindestens ein Feld ausfüllen.")
    erlaubt = {f"{v}_{h}" for v in ("oben", "unten") for h in ("links", "mitte", "rechts")}
    if not set(positionen) <= erlaubt:
        raise DokumentFehler("Unbekannte Position.")
    font = SCHRIFTEN.get(schrift, "helv")
    oc = _ebene(doc, EBENE_KOPF_FUSS)
    rgb = hex_zu_rgb(farbe) or (0.2, 0.2, 0.2)
    rand = rand_mm / 25.4 * 72
    ziel = _seiten(doc, seiten)
    anzahl = doc.page_count
    for nr in ziel:
        seite = doc[nr]
        r = seite.rect
        for position, vorlage in positionen.items():
            vertikal, horizontal = position.split("_")
            text = _text_ersetzen(vorlage, nr + erste_nummer, anzahl + erste_nummer - 1, titel)
            breite = pymupdf.get_text_length(text, font, schriftgroesse)
            x = {"links": r.x0 + rand, "mitte": (r.x0 + r.x1 - breite) / 2, "rechts": r.x1 - rand - breite}[horizontal]
            y = r.y0 + rand + schriftgroesse * 0.8 if vertikal == "oben" else r.y1 - rand
            punkt = pymupdf.Point(x, y) * seite.derotation_matrix
            seite.insert_text(
                punkt,
                text,
                fontsize=schriftgroesse,
                fontname=font,
                color=rgb,
                rotate=seite.rotation,
                oc=oc,
            )
    return ziel
