"""Vorhandenen Text im PDF ändern (zeilenweise, wie in PDF-XChange).

Ablauf beim Ändern einer Zeile:
1. Die Zeichen der Zeile werden wirklich aus dem Seiteninhalt entfernt
   (MuPDF-Schwärzung ohne Füllung – Bilder, Linien und Hintergründe bleiben).
2. Der neue Text wird an derselben Grundlinie in derselben Größe und Farbe
   gesetzt – in der eingebetteten Originalschrift, wenn sie alle Zeichen
   enthält, sonst in einer passenden Schrift (Arial/Times/Courier bzw. deren
   freie Entsprechungen), die eingebettet wird.

Nur waagerechte Zeilen lassen sich ändern. Gemischte Formatierungen
innerhalb einer Zeile übernehmen die Formatierung des ersten Wortes.
Nur im MuPDF-Thread aufrufen.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

import pymupdf

from .anmerkungen import hex_zu_rgb, norm_rechteck
from .dokumente import DokumentFehler

FETT, KURSIV, SERIF, MONO = 16, 2, 4, 8

# (fett, kursiv) → Dateinamen; zuerst Windows, dann freie Linux-Entsprechungen
_SYSTEM = {
    "sans": {
        (False, False): ["arial.ttf", "LiberationSans-Regular.ttf", "DejaVuSans.ttf"],
        (True, False): ["arialbd.ttf", "LiberationSans-Bold.ttf", "DejaVuSans-Bold.ttf"],
        (False, True): ["ariali.ttf", "LiberationSans-Italic.ttf", "DejaVuSans-Oblique.ttf"],
        (True, True): ["arialbi.ttf", "LiberationSans-BoldItalic.ttf", "DejaVuSans-BoldOblique.ttf"],
    },
    "serif": {
        (False, False): ["times.ttf", "LiberationSerif-Regular.ttf", "DejaVuSerif.ttf"],
        (True, False): ["timesbd.ttf", "LiberationSerif-Bold.ttf", "DejaVuSerif-Bold.ttf"],
        (False, True): ["timesi.ttf", "LiberationSerif-Italic.ttf", "DejaVuSerif-Italic.ttf"],
        (True, True): ["timesbi.ttf", "LiberationSerif-BoldItalic.ttf", "DejaVuSerif-BoldItalic.ttf"],
    },
    "mono": {
        (False, False): ["cour.ttf", "LiberationMono-Regular.ttf", "DejaVuSansMono.ttf"],
        (True, False): ["courbd.ttf", "LiberationMono-Bold.ttf", "DejaVuSansMono-Bold.ttf"],
        (False, True): ["couri.ttf", "LiberationMono-Italic.ttf", "DejaVuSansMono-Oblique.ttf"],
        (True, True): ["courbi.ttf", "LiberationMono-BoldItalic.ttf", "DejaVuSansMono-BoldOblique.ttf"],
    },
}
_BASIS14 = {
    ("sans", False, False): "helv", ("sans", True, False): "hebo", ("sans", False, True): "heit", ("sans", True, True): "hebi",
    ("serif", False, False): "tiro", ("serif", True, False): "tibo", ("serif", False, True): "tiit", ("serif", True, True): "tibi",
    ("mono", False, False): "cour", ("mono", True, False): "cobo", ("mono", False, True): "coit", ("mono", True, True): "cobi",
}
_SCHRIFTORDNER = [
    Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts",
    Path("/usr/share/fonts/truetype/liberation"),
    Path("/usr/share/fonts/truetype/liberation2"),
    Path("/usr/share/fonts/truetype/dejavu"),
    Path("/usr/share/fonts/TTF"),
]


def _art(schrift: str, flags: int) -> tuple[str, bool, bool]:
    name = schrift.lower()
    if flags & MONO or any(x in name for x in ("courier", "mono", "consolas")):
        familie = "mono"
    elif flags & SERIF or any(x in name for x in ("times", "serif", "georgia", "garamond", "roman")) and "sans" not in name:
        familie = "serif"
    else:
        familie = "sans"
    fett = bool(flags & FETT) or any(x in name for x in ("bold", "black", "heavy", "semibold"))
    kursiv = bool(flags & KURSIV) or any(x in name for x in ("italic", "oblique"))
    return familie, fett, kursiv


def _css_schrift(familie: str) -> str:
    return {"serif": '"Times New Roman", Times, serif', "mono": '"Courier New", Courier, monospace'}.get(familie, "Arial, Helvetica, sans-serif")


def zeilen(doc: pymupdf.Document, seite_nr: int) -> list[dict]:
    """Textzeilen der Seite mit Lage (normiert) und Formatierung."""
    if not 0 <= seite_nr < doc.page_count:
        raise DokumentFehler("Seite existiert nicht.")
    seite = doc[seite_nr]
    ergebnis = []
    for block in seite.get_text("dict")["blocks"]:
        for zeile in block.get("lines", []):
            spans = [s for s in zeile["spans"] if s["text"]]
            text = "".join(s["text"] for s in spans)
            if not text.strip():
                continue
            erster = next(s for s in spans if s["text"].strip())
            familie, fett, kursiv = _art(erster["font"], erster["flags"])
            dx, dy = zeile["dir"]
            ergebnis.append(
                {
                    "bbox": [round(v, 2) for v in zeile["bbox"]],
                    "rechteck": norm_rechteck(seite, pymupdf.Rect(zeile["bbox"])),
                    "text": text,
                    "schrift": re.sub(r"^[A-Z]{6}\+", "", erster["font"]),
                    "css_schrift": _css_schrift(familie),
                    "groesse": round(erster["size"], 2),
                    "farbe": f"#{erster['color']:06X}",
                    "fett": fett,
                    "kursiv": kursiv,
                    "bearbeitbar": abs(dy) < 0.01 and dx > 0,
                }
            )
    return ergebnis


def _zeile_finden(seite: pymupdf.Page, bbox: list[float]) -> dict | None:
    ziel = pymupdf.Rect(bbox)
    beste, abstand = None, 1e9
    for block in seite.get_text("dict")["blocks"]:
        for zeile in block.get("lines", []):
            r = pymupdf.Rect(zeile["bbox"])
            d = abs(r.x0 - ziel.x0) + abs(r.y0 - ziel.y0) + abs(r.x1 - ziel.x1) + abs(r.y1 - ziel.y1)
            if d < abstand:
                beste, abstand = zeile, d
    return beste if abstand < 3 else None


def _hat_alle_zeichen(font: pymupdf.Font, text: str) -> bool:
    return all(font.has_glyph(ord(z)) for z in text if not z.isspace())


def _schrift(doc: pymupdf.Document, seite: pymupdf.Page, span: dict, text: str) -> tuple[pymupdf.Font, str]:
    """Schrift für den neuen Text: Original (eingebettet), sonst Systemschrift."""
    gesucht = re.sub(r"^[A-Z]{6}\+", "", span["font"])
    for xref, _ext, _typ, basis, *_ in seite.get_fonts(full=True):
        if re.sub(r"^[A-Z]{6}\+", "", basis) != gesucht:
            continue
        try:
            inhalt = doc.extract_font(xref)[3]
            if inhalt:
                font = pymupdf.Font(fontbuffer=inhalt)
                if _hat_alle_zeichen(font, text):
                    return font, gesucht
        except Exception:  # noqa: BLE001 – kaputte/ungewöhnliche Schrift: Ersatz nehmen
            pass
        break
    familie, fett, kursiv = _art(span["font"], span["flags"])
    for dateiname in _SYSTEM[familie][(fett, kursiv)]:
        for ordner in _SCHRIFTORDNER:
            pfad = ordner / dateiname
            if pfad.is_file():
                font = pymupdf.Font(fontfile=str(pfad))
                if _hat_alle_zeichen(font, text):
                    return font, pfad.stem
    font = pymupdf.Font(_BASIS14[(familie, fett, kursiv)])
    return font, font.name


def text_ersetzen(
    doc: pymupdf.Document,
    seite_nr: int,
    bbox: list[float],
    neu: str,
    groesse: float | None = None,
    farbe: str | None = None,
) -> dict:
    """Zeile ``bbox`` (ungedrehte PDF-Koordinaten) durch ``neu`` ersetzen.
    Liefert die neue Zeile (wie ``zeilen``) bzw. {} wenn sie geleert wurde."""
    if not 0 <= seite_nr < doc.page_count:
        raise DokumentFehler("Seite existiert nicht.")
    seite = doc[seite_nr]
    zeile = _zeile_finden(seite, bbox)
    if zeile is None:
        raise DokumentFehler("Diese Textzeile wurde nicht mehr gefunden – bitte noch einmal anklicken.")
    dx, dy = zeile["dir"]
    if abs(dy) > 0.01 or dx <= 0:
        raise DokumentFehler("Schräg oder senkrecht laufender Text lässt sich nicht bearbeiten.")
    spans = [s for s in zeile["spans"] if s["text"].strip()]
    if not spans:
        raise DokumentFehler("Diese Zeile enthält keinen Text.")
    erster = spans[0]
    neu = neu.replace("\n", " ").rstrip()
    groesse = float(groesse) if groesse else erster["size"]
    if not 2 <= groesse <= 200:
        raise DokumentFehler("Ungültige Schriftgröße.")
    rgb = hex_zu_rgb(farbe) if farbe else pymupdf.sRGB_to_pdf(erster["color"])
    font, schriftname = _schrift(doc, seite, erster, neu) if neu.strip() else (None, "")

    # 1. alten Text entfernen – nur Zeichen, keine Bilder/Linien, ohne Füllung;
    #    schmaler als die Zeile, damit Ober-/Unterlängen der Nachbarzeilen bleiben
    r = pymupdf.Rect(zeile["bbox"])
    h = r.height
    seite.add_redact_annot(pymupdf.Rect(r.x0 - 0.5, r.y0 + h * 0.25, r.x1 + 0.5, r.y1 - h * 0.25), fill=False)
    seite.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE, graphics=pymupdf.PDF_REDACT_LINE_ART_NONE)

    # 2. neuen Text an derselben Grundlinie setzen
    if not neu.strip():
        return {}
    ursprung = pymupdf.Point(erster["origin"])
    schreiber = pymupdf.TextWriter(seite.rect)
    # Wort für Wort setzen, Leerzeichen nur als Abstand: Manche Schriften
    # (z. B. Arial) führen „ “ und das geschützte Leerzeichen als dieselbe
    # Glyphe – sonst landete beim Kopieren/Suchen U+00A0 statt Leerzeichen.
    leer = font.text_length(" ", fontsize=groesse)
    x = ursprung.x
    for teil in re.split(r"( +)", neu):
        if not teil:
            continue
        if teil.startswith(" "):
            x += leer * len(teil)
            continue
        _, ende = schreiber.append(pymupdf.Point(x, ursprung.y), teil, font=font, fontsize=groesse)
        x = ende.x
    schreiber.write_text(seite, color=rgb)

    for z in zeilen(doc, seite_nr):
        b = z["bbox"]
        if abs(b[0] - ursprung.x) < 2 and b[1] - 2 <= ursprung.y <= b[3] + 2:
            return {**z, "verwendete_schrift": schriftname}
    return {"verwendete_schrift": schriftname}
