"""Anmerkungen: Kommentare, Eintragungen, Stempel, Schwärzungen.

Alles wird als echte PDF-Anmerkung gespeichert – so bleiben Eintragungen auch
in anderen Programmen (Acrobat, PDF-XChange, Browser) sichtbar und
bearbeitbar. Jede Anmerkung gehört zu einer *Gruppe*, die beim Anzeigen,
Drucken und Exportieren ein- oder ausgeblendet werden kann:

- ``kommentar``  – Hervorhebungen, Notizen, Formen, Textfelder
- ``eintragung`` – Schreibmaschinentext, Bilder, Unterschriften, Abdecken, Freihand
- ``stempel``    – Stempel („Eingegangen“ …)
- ``schwaerzung`` – vorgemerkte Schwärzungen (werden erst beim Anwenden endgültig)

Koordinaten an die Oberfläche: normiert (0..1) relativ zur *angezeigten*
Seite (inkl. Seitendrehung im PDF), wie überall im Dienst.

Nur im MuPDF-Thread aufrufen.
"""

from __future__ import annotations

import getpass
import hashlib
import os
import re
from datetime import datetime
from typing import Any

import pymupdf

from .dokumente import DokumentFehler

GRUPPEN = ("kommentar", "eintragung", "stempel", "schwaerzung")

# Schriftgröße → Zeilenhöhe der FreeText-Darstellung von MuPDF (gemessen: 1,2)
ZEILENHOEHE = 1.2
TEXT_RAND = 2.0  # pt Luft rechts/unten, damit MuPDF nicht umbricht

_ARTEN = {
    pymupdf.PDF_ANNOT_HIGHLIGHT: "hervorheben",
    pymupdf.PDF_ANNOT_UNDERLINE: "unterstreichen",
    pymupdf.PDF_ANNOT_STRIKE_OUT: "durchstreichen",
    pymupdf.PDF_ANNOT_SQUIGGLY: "wellenlinie",
    pymupdf.PDF_ANNOT_FREE_TEXT: "textfeld",
    pymupdf.PDF_ANNOT_TEXT: "notiz",
    pymupdf.PDF_ANNOT_SQUARE: "rechteck",
    pymupdf.PDF_ANNOT_CIRCLE: "ellipse",
    pymupdf.PDF_ANNOT_LINE: "linie",
    pymupdf.PDF_ANNOT_POLY_LINE: "polylinie",
    pymupdf.PDF_ANNOT_POLYGON: "polygon",
    pymupdf.PDF_ANNOT_INK: "freihand",
    pymupdf.PDF_ANNOT_STAMP: "bild",
    pymupdf.PDF_ANNOT_REDACT: "schwaerzung",
}
TEXTMARKIERUNG = {"hervorheben", "unterstreichen", "durchstreichen", "wellenlinie"}
PUNKT_ARTEN = {"linie", "pfeil", "polylinie", "polygon", "freihand"}

STANDARDFARBEN = {
    "hervorheben": "#FFE14D",
    "unterstreichen": "#1E6FD9",
    "durchstreichen": "#D92C2C",
    "wellenlinie": "#D92C2C",
    "schreibmaschine": "#1A1A1A",
    "textfeld": "#1A1A1A",
    "notiz": "#F5C400",
    "rechteck": "#D92C2C",
    "ellipse": "#D92C2C",
    "linie": "#D92C2C",
    "pfeil": "#D92C2C",
    "freihand": "#1E3A8A",
    "stempel": "#C0262D",
}


# ------------------------------------------------------------ Hilfsfunktionen
def autor_name(kuerzel: str = "") -> str:
    if kuerzel.strip():
        return kuerzel.strip()
    try:
        return os.environ.get("USERNAME") or getpass.getuser()
    except Exception:  # noqa: BLE001
        return ""


def hex_zu_rgb(farbe: str | None) -> tuple[float, float, float] | None:
    if not farbe:
        return None
    farbe = farbe.strip().lstrip("#")
    if len(farbe) == 3:
        farbe = "".join(c * 2 for c in farbe)
    if not re.fullmatch(r"[0-9a-fA-F]{6}", farbe):
        raise DokumentFehler("Ungültige Farbe.")
    return tuple(int(farbe[i : i + 2], 16) / 255 for i in (0, 2, 4))  # type: ignore[return-value]


def rgb_zu_hex(farbe: Any) -> str | None:
    if not farbe:
        return None
    werte = list(farbe)
    if len(werte) == 1:
        werte = werte * 3
    if len(werte) == 4:  # CMYK grob umrechnen
        c, m, y, k = werte
        werte = [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)]
    return "#" + "".join(f"{max(0, min(255, round(v * 255))):02X}" for v in werte[:3])


def _breite_hoehe(seite: pymupdf.Page) -> tuple[float, float]:
    return seite.rect.width, seite.rect.height


def norm_rechteck(seite: pymupdf.Page, r: pymupdf.Rect) -> list[float]:
    """PDF-Rechteck (ungedrehte Seite) → normiert auf angezeigte Seite."""
    b, h = _breite_hoehe(seite)
    a = (pymupdf.Rect(r) * seite.rotation_matrix).normalize()
    return [round(a.x0 / b, 5), round(a.y0 / h, 5), round(a.x1 / b, 5), round(a.y1 / h, 5)]


def pdf_rechteck(seite: pymupdf.Page, n: list[float]) -> pymupdf.Rect:
    if len(n) != 4:
        raise DokumentFehler("Ungültiges Rechteck.")
    b, h = _breite_hoehe(seite)
    anzeige = pymupdf.Rect(n[0] * b, n[1] * h, n[2] * b, n[3] * h).normalize()
    return (anzeige * seite.derotation_matrix).normalize()


def norm_punkt(seite: pymupdf.Page, p: Any) -> list[float]:
    b, h = _breite_hoehe(seite)
    a = pymupdf.Point(p) * seite.rotation_matrix
    return [round(a.x / b, 5), round(a.y / h, 5)]


def pdf_punkt(seite: pymupdf.Page, n: list[float]) -> pymupdf.Point:
    b, h = _breite_hoehe(seite)
    return pymupdf.Point(n[0] * b, n[1] * h) * seite.derotation_matrix


def _datum(pdf_datum: str) -> str:
    m = re.match(r"D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?", pdf_datum or "")
    if not m:
        return ""
    jahr, monat, tag, std, minute, sek = (int(x) if x else 0 for x in m.groups())
    try:
        return datetime(jahr, monat, tag, std, minute, sek).isoformat()
    except ValueError:
        return ""


def _schluessel(doc: pymupdf.Document, xref: int, name: str) -> str | None:
    typ, wert = doc.xref_get_key(xref, name)
    if typ in ("null", ""):
        return None
    return wert.lstrip("/") if typ == "name" else wert


def _da_lesen(doc: pymupdf.Document, xref: int) -> tuple[float, str | None]:
    """Schriftgröße und -farbe aus dem /DA-Eintrag einer FreeText-Anmerkung."""
    da = _schluessel(doc, xref, "DA") or ""
    groesse = 11.0
    m = re.search(r"([\d.]+)\s+Tf", da)
    if m:
        groesse = float(m.group(1))
    farbe = None
    m = re.search(r"([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg", da)
    if m:
        farbe = rgb_zu_hex([float(x) for x in m.groups()])
    else:
        m = re.search(r"([\d.]+)\s+g\b", da)
        if m:
            farbe = rgb_zu_hex([float(m.group(1))])
    return groesse, farbe


def _gruppe_ermitteln(doc: pymupdf.Document, annot: pymupdf.Annot, art: str) -> str:
    eigene = _schluessel(doc, annot.xref, "AgenturGruppe")
    if eigene in GRUPPEN:
        return eigene
    if art == "schwaerzung":
        return "schwaerzung"
    if art in ("bild", "freihand"):
        return "eintragung"
    if art == "textfeld" and _schluessel(doc, annot.xref, "IT") == "FreeTextTypeWriter":
        return "eintragung"
    return "kommentar"


def _unterart(doc: pymupdf.Document, annot: pymupdf.Annot, art: str) -> str:
    eigene = _schluessel(doc, annot.xref, "AgenturArt")
    if eigene:
        return eigene
    if art == "textfeld" and _schluessel(doc, annot.xref, "IT") == "FreeTextTypeWriter":
        return "schreibmaschine"
    if art == "linie":
        enden = annot.line_ends or (0, 0)
        if enden and any(e in (pymupdf.PDF_ANNOT_LE_OPEN_ARROW, pymupdf.PDF_ANNOT_LE_CLOSED_ARROW) for e in enden):
            return "pfeil"
    return art


# -------------------------------------------------------------------- Lesen
def anmerkung_lesen(doc: pymupdf.Document, seite: pymupdf.Page, annot: pymupdf.Annot) -> dict | None:
    art = _ARTEN.get(annot.type[0])
    if art is None:
        return None  # Links, Formularfelder, Popups … nicht hier
    info = annot.info
    farben = annot.colors or {}
    eintrag: dict[str, Any] = {
        "id": annot.xref,
        "seite": seite.number,
        "art": _unterart(doc, annot, art),
        "pdf_art": art,
        "gruppe": _gruppe_ermitteln(doc, annot, art),
        "rechteck": norm_rechteck(seite, annot.rect),
        "farbe": rgb_zu_hex(farben.get("stroke")),
        "fuellung": rgb_zu_hex(farben.get("fill")),
        "breite": (annot.border or {}).get("width", 1) if annot.border else 1,
        "deckkraft": annot.opacity if annot.opacity is not None and annot.opacity >= 0 else 1,
        "inhalt": info.get("content", ""),
        "autor": info.get("title", ""),
        "datum": _datum(info.get("modDate") or info.get("creationDate", "")),
        "ausgeblendet": bool(annot.flags & pymupdf.PDF_ANNOT_IS_HIDDEN),
    }
    # Kennung der Darstellung: ändert sich bei jeder Änderung (für Bild-Cache)
    ap = doc.xref_get_key(annot.xref, "AP/N")[1]
    eintrag["v"] = hashlib.md5(
        f"{annot.rect}|{info.get('modDate')}|{ap}|{annot.flags}|{annot.opacity}|{annot.colors}".encode()
    ).hexdigest()[:10]
    if eintrag["breite"] is None or eintrag["breite"] < 0:
        eintrag["breite"] = 1
    if art == "textfeld":
        groesse, textfarbe = _da_lesen(doc, annot.xref)
        eintrag["schriftgroesse"] = groesse
        eintrag["textfarbe"] = textfarbe or "#000000"
        eintrag["text"] = info.get("content", "")
        if eintrag["art"] == "schreibmaschine":
            eintrag["farbe"] = textfarbe or "#000000"
    if art in ("linie", "polylinie", "polygon"):
        eintrag["punkte"] = [norm_punkt(seite, p) for p in (annot.vertices or [])]
    if art == "freihand":
        eintrag["striche"] = [[norm_punkt(seite, p) for p in strich] for strich in (annot.vertices or [])]
    if art in TEXTMARKIERUNG:
        punkte = annot.vertices or []
        quads = [pymupdf.Quad(*punkte[i : i + 4]) for i in range(0, len(punkte) - 3, 4)]
        eintrag["rechtecke"] = [norm_rechteck(seite, q.rect) for q in quads]
        eintrag["text_darunter"] = " ".join(seite.get_textbox(q.rect).strip() for q in quads).strip()
    return eintrag


def liste(doc: pymupdf.Document) -> dict[str, list[dict]]:
    ergebnis: dict[str, list[dict]] = {}
    for seite in doc:
        eintraege = [e for a in seite.annots() if (e := anmerkung_lesen(doc, seite, a))]
        if eintraege:
            ergebnis[str(seite.number)] = eintraege
    return ergebnis


def finden(seite: pymupdf.Page, xref: int) -> pymupdf.Annot:
    for a in seite.annots():
        if a.xref == xref:
            return a
    raise DokumentFehler("Anmerkung nicht gefunden – wurde sie inzwischen gelöscht?")


# ---------------------------------------------------------------- Erstellen
def textmasse(text: str, schriftgroesse: float) -> tuple[float, float]:
    """Breite/Höhe (pt), die ein Schreibmaschinentext ohne Umbruch braucht."""
    zeilen = (text or " ").split("\n")
    breite = max(pymupdf.get_text_length(z, "helv", schriftgroesse) for z in zeilen)
    return breite + TEXT_RAND + schriftgroesse * 0.3, len(zeilen) * schriftgroesse * ZEILENHOEHE + schriftgroesse * 0.3


def _markieren(doc, xref: int, gruppe: str, unterart: str | None = None) -> None:
    doc.xref_set_key(xref, "AgenturGruppe", f"/{gruppe}")
    if unterart:
        doc.xref_set_key(xref, "AgenturArt", f"/{unterart}")


def _info_setzen(annot: pymupdf.Annot, autor: str, inhalt: str | None = None, erstellt: str | None = None) -> None:
    jetzt = pymupdf.get_pdf_now()
    daten = {"title": autor, "modDate": jetzt, "creationDate": erstellt or jetzt}
    if inhalt is not None:
        daten["content"] = inhalt
    annot.set_info(**daten)


def _stil(annot: pymupdf.Annot, d: dict, fuellung_erlaubt: bool = True) -> None:
    stroke = hex_zu_rgb(d.get("farbe"))
    fill = hex_zu_rgb(d.get("fuellung")) if fuellung_erlaubt else None
    farben: dict = {}
    if stroke is not None:
        farben["stroke"] = stroke
    if fuellung_erlaubt:
        farben["fill"] = fill if fill is not None else []
    if farben:
        annot.set_colors(**farben)
    if d.get("breite") is not None:
        annot.set_border(width=max(0.0, float(d["breite"])))
    if d.get("deckkraft") is not None:
        annot.set_opacity(max(0.05, min(1.0, float(d["deckkraft"]))))


def erstellen(doc: pymupdf.Document, seite_nr: int, d: dict, autor: str, bild: bytes | None = None) -> int:
    """Legt eine Anmerkung an und gibt ihre ID (xref) zurück."""
    if not 0 <= seite_nr < doc.page_count:
        raise DokumentFehler("Seite existiert nicht.")
    seite = doc[seite_nr]
    art = d.get("art", "")
    farbe = d.get("farbe") or STANDARDFARBEN.get(art)
    d = {**d, "farbe": farbe}
    erstellt = d.get("erstellt")

    if art in TEXTMARKIERUNG:
        rechtecke = d.get("rechtecke") or []
        if not rechtecke:
            raise DokumentFehler("Kein Text markiert.")
        quads = [pdf_rechteck(seite, r).quad if seite.rotation == 0 else _quad(seite, r) for r in rechtecke]
        methode = {
            "hervorheben": seite.add_highlight_annot,
            "unterstreichen": seite.add_underline_annot,
            "durchstreichen": seite.add_strikeout_annot,
            "wellenlinie": seite.add_squiggly_annot,
        }[art]
        annot = methode(quads=quads)
        annot.set_colors(stroke=hex_zu_rgb(farbe))
        if d.get("deckkraft") is not None:
            annot.set_opacity(float(d["deckkraft"]))
        _info_setzen(annot, autor, d.get("inhalt", ""), erstellt)
        annot.update()
        _markieren(doc, annot.xref, "kommentar")
        return annot.xref

    if art in ("schreibmaschine", "textfeld", "stempel"):
        return _freitext(doc, seite, d, autor)

    if art == "notiz":
        p = pdf_punkt(seite, d.get("punkt") or d["rechteck"][:2])
        annot = seite.add_text_annot(p, d.get("inhalt", ""), icon=d.get("symbol", "Comment"))
        annot.set_colors(stroke=hex_zu_rgb(farbe))
        _info_setzen(annot, autor, d.get("inhalt", ""), erstellt)
        annot.update()
        _markieren(doc, annot.xref, "kommentar")
        return annot.xref

    if art in ("rechteck", "ellipse", "abdecken"):
        r = pdf_rechteck(seite, d["rechteck"])
        if r.is_empty or r.width < 1 or r.height < 1:
            raise DokumentFehler("Bereich ist zu klein.")
        if art == "abdecken":
            annot = seite.add_rect_annot(r)
            annot.set_colors(stroke=hex_zu_rgb(d.get("fuellung") or "#FFFFFF"), fill=hex_zu_rgb(d.get("fuellung") or "#FFFFFF"))
            annot.set_border(width=0)
            gruppe = "eintragung"
        else:
            annot = seite.add_rect_annot(r) if art == "rechteck" else seite.add_circle_annot(r)
            _stil(annot, {"breite": 2, **d})
            gruppe = d.get("gruppe") if d.get("gruppe") in GRUPPEN else "kommentar"
        _info_setzen(annot, autor, d.get("inhalt", ""), erstellt)
        annot.update()
        _markieren(doc, annot.xref, gruppe, art)
        return annot.xref

    if art in ("linie", "pfeil"):
        punkte = d.get("punkte") or []
        if len(punkte) != 2:
            raise DokumentFehler("Eine Linie braucht Anfang und Ende.")
        p1, p2 = (pdf_punkt(seite, p) for p in punkte)
        annot = seite.add_line_annot(p1, p2)
        _stil(annot, {"breite": 2, **d}, fuellung_erlaubt=art == "pfeil")
        if art == "pfeil":
            annot.set_colors(stroke=hex_zu_rgb(farbe), fill=hex_zu_rgb(farbe))
            annot.set_line_ends(pymupdf.PDF_ANNOT_LE_NONE, pymupdf.PDF_ANNOT_LE_CLOSED_ARROW)
        _info_setzen(annot, autor, d.get("inhalt", ""), erstellt)
        annot.update()
        _markieren(doc, annot.xref, "kommentar", art)
        return annot.xref

    if art == "freihand":
        striche = [[tuple(pdf_punkt(seite, p)) for p in s] for s in (d.get("striche") or []) if len(s) >= 2]
        if not striche:
            raise DokumentFehler("Keine Linie gezeichnet.")
        annot = seite.add_ink_annot(striche)
        _stil(annot, {"breite": 1.5, **d}, fuellung_erlaubt=False)
        _info_setzen(annot, autor, d.get("inhalt", ""), erstellt)
        annot.update()
        _markieren(doc, annot.xref, d.get("gruppe") if d.get("gruppe") in GRUPPEN else "eintragung", "freihand")
        return annot.xref

    if art in ("bild", "unterschrift"):
        if not bild:
            raise DokumentFehler("Kein Bild angegeben.")
        r = pdf_rechteck(seite, d["rechteck"])
        if seite.rotation:
            bild = _bild_drehen(bild, seite.rotation)
        annot = seite.add_stamp_annot(r, stamp=bild)
        _info_setzen(annot, autor, d.get("inhalt", "Unterschrift" if art == "unterschrift" else "Bild"), erstellt)
        if d.get("deckkraft") is not None:
            annot.set_opacity(float(d["deckkraft"]))
        annot.update()
        _markieren(doc, annot.xref, "eintragung", art)
        return annot.xref

    if art == "schwaerzung":
        return schwaerzung_vormerken(doc, seite, [d["rechteck"]], autor)[0]

    raise DokumentFehler(f"Unbekannte Anmerkungsart: {art}")


def _quad(seite: pymupdf.Page, n: list[float]) -> pymupdf.Quad:
    """Normiertes Anzeige-Rechteck → Quad im ungedrehten Seitensystem (gedrehte Seiten)."""
    b, h = _breite_hoehe(seite)
    anzeige = pymupdf.Rect(n[0] * b, n[1] * h, n[2] * b, n[3] * h).normalize()
    return anzeige.quad * seite.derotation_matrix


def _bild_drehen(bild: bytes, drehung: int) -> bytes:
    """Bild so drehen, dass es auf einer gedrehten Seite aufrecht erscheint."""
    import io

    from PIL import Image

    with Image.open(io.BytesIO(bild)) as im:
        gedreht = im.rotate(drehung, expand=True)  # PIL dreht gegen den Uhrzeigersinn
        puffer = io.BytesIO()
        gedreht.save(puffer, "PNG")
        return puffer.getvalue()


def _freitext(doc: pymupdf.Document, seite: pymupdf.Page, d: dict, autor: str) -> int:
    art = d["art"]
    text = (d.get("text") if d.get("text") is not None else d.get("inhalt")) or ""
    text = text.replace("\r\n", "\n")
    groesse = float(d.get("schriftgroesse") or (11 if art != "stempel" else 16))
    groesse = max(4.0, min(144.0, groesse))
    textfarbe = hex_zu_rgb(d.get("textfarbe") or d.get("farbe") or STANDARDFARBEN.get(art)) or (0, 0, 0)
    b, h = _breite_hoehe(seite)

    if art in ("schreibmaschine", "stempel"):
        # Größe ergibt sich aus dem Text; Ankerpunkt = linke obere Ecke (Anzeige)
        breite, hoehe = textmasse(text, groesse)
        if art == "stempel":
            breite += groesse * 1.2
            hoehe += groesse * 0.6
        x0, y0 = (d.get("punkt") or d.get("rechteck", [0, 0])[:2])[:2]
        anzeige = pymupdf.Rect(x0 * b, y0 * h, x0 * b + breite, y0 * h + hoehe)
    else:
        n = d["rechteck"]
        anzeige = pymupdf.Rect(n[0] * b, n[1] * h, n[2] * b, n[3] * h).normalize()
        breite_noetig, hoehe_noetig = textmasse(text, groesse)
        if anzeige.width < 20:
            anzeige.x1 = anzeige.x0 + max(120, breite_noetig + 6)
        if anzeige.height < hoehe_noetig + 4:
            anzeige.y1 = anzeige.y0 + hoehe_noetig + 4
    r = (anzeige * seite.derotation_matrix).normalize()

    optionen: dict[str, Any] = {
        "fontsize": groesse,
        "fontname": "Helv",
        "text_color": textfarbe,
        "rotate": seite.rotation,
        "align": int(d.get("ausrichtung", 0) if art != "stempel" else 1),
    }
    # Rahmenfarbe = Textfarbe (MuPDF erlaubt eigene Rahmenfarben nur bei Rich-Text)
    if art == "textfeld":
        optionen["border_width"] = float(d.get("breite", 1))
        fuellung = hex_zu_rgb(d.get("fuellung"))
        if fuellung:
            optionen["fill_color"] = fuellung
    elif art == "stempel":
        optionen["border_width"] = float(d.get("breite", 2))
        fuellung = hex_zu_rgb(d.get("fuellung"))
        if fuellung:
            optionen["fill_color"] = fuellung
    else:
        optionen["border_width"] = 0
    if d.get("deckkraft") is not None:
        optionen["opacity"] = max(0.05, min(1.0, float(d["deckkraft"])))

    annot = seite.add_freetext_annot(r, text, **optionen)
    _info_setzen(annot, autor, text, d.get("erstellt"))
    annot.update()
    # MuPDF schreibt eine Standard-Hinweislinie (/CL) – andere Programme
    # würden sonst eine Linie zur Seitenecke zeichnen.
    doc.xref_set_key(annot.xref, "CL", "null")
    if art == "schreibmaschine":
        doc.xref_set_key(annot.xref, "IT", "/FreeTextTypeWriter")
    gruppe = {"schreibmaschine": "eintragung", "stempel": "stempel"}.get(art, "kommentar")
    _markieren(doc, annot.xref, gruppe, art)
    return annot.xref


# ------------------------------------------------------------------ Ändern
def _verschiebung_pdf(seite: pymupdf.Page, dx: float, dy: float) -> pymupdf.Point:
    """Normierte Verschiebung (Anzeige) → Verschiebung im ungedrehten PDF-System."""
    b, h = _breite_hoehe(seite)
    m = seite.derotation_matrix
    return pymupdf.Point(dx * b, dy * h) * m - pymupdf.Point(0, 0) * m


def _zahlen(text: str) -> list[float]:
    return [float(z) for z in re.findall(r"-?\d+(?:\.\d+)?", text or "")]


def _pdf_zahl(z: float) -> str:
    return f"{z:.3f}".rstrip("0").rstrip(".")


def _punkte_abbilden(doc: pymupdf.Document, annot: pymupdf.Annot, seite: pymupdf.Page, abb) -> None:
    """Geometrie (Linie, Freihand, Linienzug) über ``abb(Point) -> Point`` im
    PDF-Seitensystem neu setzen. Die Schlüssel stehen im PDF mit
    Ursprung unten links – daher Umrechnung über die Seitenhöhe (MediaBox)."""
    hoehe = seite.mediabox.height
    zu_pdf = lambda p: (p.x, hoehe - p.y)  # noqa: E731
    von_pdf = lambda x, y: pymupdf.Point(x, hoehe - y)  # noqa: E731
    xref = annot.xref
    typ = annot.type[0]
    if typ == pymupdf.PDF_ANNOT_LINE:
        z = _zahlen(doc.xref_get_key(xref, "L")[1])
        punkte = [abb(von_pdf(z[i], z[i + 1])) for i in range(0, 4, 2)]
        doc.xref_set_key(xref, "L", "[" + " ".join(_pdf_zahl(v) for p in punkte for v in zu_pdf(p)) + "]")
    elif typ == pymupdf.PDF_ANNOT_INK:
        striche = annot.vertices or []
        teile = []
        for strich in striche:
            pts = [abb(pymupdf.Point(p)) for p in strich]
            teile.append("[" + " ".join(_pdf_zahl(v) for p in pts for v in zu_pdf(p)) + "]")
        doc.xref_set_key(xref, "InkList", "[" + " ".join(teile) + "]")
    elif typ in (pymupdf.PDF_ANNOT_POLY_LINE, pymupdf.PDF_ANNOT_POLYGON):
        pts = [abb(pymupdf.Point(p)) for p in (annot.vertices or [])]
        doc.xref_set_key(xref, "Vertices", "[" + " ".join(_pdf_zahl(v) for p in pts for v in zu_pdf(p)) + "]")


def aendern(doc: pymupdf.Document, seite_nr: int, xref: int, aenderung: dict, autor: str) -> int:
    """Ändert eine Anmerkung an Ort und Stelle (die ID bleibt gleich).

    ``aenderung`` kann enthalten: verschieben [dx, dy] (normiert), rechteck
    (neue Lage/Größe), text, inhalt, farbe, fuellung, breite, deckkraft,
    schriftgroesse.
    """
    seite = doc[seite_nr]
    annot = finden(seite, xref)
    alt = anmerkung_lesen(doc, seite, annot)
    if alt is None:
        raise DokumentFehler("Diese Anmerkung kann hier nicht bearbeitet werden.")
    art, pdf_art = alt["art"], alt["pdf_art"]
    typ = annot.type[0]
    punkt_art = typ in (pymupdf.PDF_ANNOT_LINE, pymupdf.PDF_ANNOT_INK, pymupdf.PDF_ANNOT_POLY_LINE, pymupdf.PDF_ANNOT_POLYGON)

    # ------------------------------------------------------------ Geometrie
    if "verschieben" in aenderung and pdf_art not in TEXTMARKIERUNG:
        d = _verschiebung_pdf(seite, *aenderung["verschieben"])
        if punkt_art:
            _punkte_abbilden(doc, annot, seite, lambda p: p + d)
        annot.set_rect(annot.rect + (d.x, d.y, d.x, d.y))
    elif "rechteck" in aenderung and pdf_art not in TEXTMARKIERUNG:
        ziel = pdf_rechteck(seite, aenderung["rechteck"])
        if ziel.width < 1 or ziel.height < 1:
            raise DokumentFehler("Bereich ist zu klein.")
        if punkt_art:
            # Punkte vom alten in den neuen Rahmen abbilden; der Abstand
            # zwischen Punkten und Rahmen (Linienbreite, Pfeilspitzen) bleibt
            v = annot.vertices or []
            pts = [pymupdf.Point(q) for q in (v if typ != pymupdf.PDF_ANNOT_INK else [q for strich in v for q in strich])]
            if pts:
                innen = pymupdf.Rect(min(q.x for q in pts), min(q.y for q in pts), max(q.x for q in pts), max(q.y for q in pts))
                r = annot.rect
                ziel_innen = pymupdf.Rect(
                    ziel.x0 + (innen.x0 - r.x0), ziel.y0 + (innen.y0 - r.y0), ziel.x1 - (r.x1 - innen.x1), ziel.y1 - (r.y1 - innen.y1)
                )
                sx = ziel_innen.width / innen.width if innen.width > 1e-6 else 1.0
                sy = ziel_innen.height / innen.height if innen.height > 1e-6 else 1.0
                _punkte_abbilden(
                    doc, annot, seite,
                    lambda q: pymupdf.Point(ziel_innen.x0 + (q.x - innen.x0) * sx, ziel_innen.y0 + (q.y - innen.y0) * sy),
                )
            annot.set_rect(ziel)
        elif pdf_art == "notiz":
            # Notizsymbole behalten ihre Größe, nur die Lage ändert sich
            annot.set_rect(pymupdf.Rect(ziel.x0, ziel.y0, ziel.x0 + annot.rect.width, ziel.y0 + annot.rect.height))
        elif art not in ("schreibmaschine", "stempel"):
            annot.set_rect(ziel)
        else:
            # Größe ergibt sich aus dem Text – nur die Lage übernehmen
            annot.set_rect(pymupdf.Rect(ziel.x0, ziel.y0, ziel.x0 + annot.rect.width, ziel.y0 + annot.rect.height))

    # ------------------------------------------------------------ Darstellung
    farben: dict = {}
    if pdf_art == "textfeld":
        groesse, textfarbe = _da_lesen(doc, xref)
        groesse = float(aenderung.get("schriftgroesse") or groesse)
        if art in ("schreibmaschine", "stempel"):
            textfarbe = aenderung.get("farbe") or aenderung.get("textfarbe") or textfarbe
        else:
            textfarbe = aenderung.get("textfarbe") or (aenderung.get("farbe") if art == "textfeld" else None) or textfarbe
        text = aenderung.get("text", aenderung.get("inhalt", annot.info.get("content", "")))
        text = (text or "").replace("\r\n", "\n")
        if "text" in aenderung or "inhalt" in aenderung or "schriftgroesse" in aenderung:
            r = annot.rect
            breite, hoehe = textmasse(text, groesse)
            if art == "stempel":
                breite, hoehe = breite + groesse * 1.2, hoehe + groesse * 0.6
            # Maße gelten in Anzeige-Ausrichtung (Text steht aufrecht)
            anzeige = (r * seite.rotation_matrix).normalize()
            if art in ("schreibmaschine", "stempel"):
                # linke obere Ecke bleibt fest, Größe folgt dem Text
                anzeige = pymupdf.Rect(anzeige.x0, anzeige.y0, anzeige.x0 + breite, anzeige.y0 + hoehe)
            elif anzeige.height < hoehe + 4:
                anzeige = pymupdf.Rect(anzeige.x0, anzeige.y0, anzeige.x1, anzeige.y0 + hoehe + 4)
            annot.set_rect((anzeige * seite.derotation_matrix).normalize())
        annot.set_info(content=text)
        optionen: dict = {"fontsize": groesse, "text_color": hex_zu_rgb(textfarbe) or (0, 0, 0)}
        if "fuellung" in aenderung and art == "textfeld":
            optionen["fill_color"] = hex_zu_rgb(aenderung["fuellung"])
        if aenderung.get("breite") is not None and art == "textfeld":
            annot.set_border(width=max(0.0, float(aenderung["breite"])))
        if aenderung.get("deckkraft") is not None:
            optionen["opacity"] = max(0.05, min(1.0, float(aenderung["deckkraft"])))
        annot.set_info(title=annot.info.get("title") or autor, modDate=pymupdf.get_pdf_now())
        annot.update(**optionen)
        doc.xref_set_key(xref, "CL", "null")
        return xref

    if aenderung.get("farbe") and pdf_art != "bild":
        farben["stroke"] = hex_zu_rgb(aenderung["farbe"])
        if art == "pfeil":
            farben["fill"] = farben["stroke"]
    if "fuellung" in aenderung and pdf_art in ("rechteck", "ellipse", "polygon"):
        farben["fill"] = hex_zu_rgb(aenderung["fuellung"]) if aenderung["fuellung"] else []
    if farben:
        annot.set_colors(**farben)
    if aenderung.get("breite") is not None and pdf_art not in TEXTMARKIERUNG and pdf_art not in ("bild", "notiz"):
        annot.set_border(width=max(0.0, float(aenderung["breite"])))
    if aenderung.get("deckkraft") is not None:
        annot.set_opacity(max(0.05, min(1.0, float(aenderung["deckkraft"]))))
    info = annot.info
    annot.set_info(
        content=aenderung.get("inhalt", info.get("content", "")),
        title=info.get("title") or autor,
        modDate=pymupdf.get_pdf_now(),
    )
    annot.update()
    return xref


def loeschen(doc: pymupdf.Document, seite_nr: int, xref: int) -> None:
    seite = doc[seite_nr]
    seite.delete_annot(finden(seite, xref))


# --------------------------------------------------------------- Schwärzen
def schwaerzung_vormerken(doc: pymupdf.Document, seite: pymupdf.Page, rechtecke: list[list[float]], autor: str) -> list[int]:
    ids = []
    for n in rechtecke:
        r = pdf_rechteck(seite, n)
        if r.is_empty:
            continue
        annot = seite.add_redact_annot(r, fill=(0, 0, 0), cross_out=False)
        annot.set_colors(stroke=(0.85, 0.1, 0.1))
        _info_setzen(annot, autor, "Schwärzung (noch nicht angewendet)")
        annot.update()
        _markieren(doc, annot.xref, "schwaerzung")
        ids.append(annot.xref)
    return ids


def schwaerzungen_anwenden(doc: pymupdf.Document) -> list[int]:
    """Wendet alle vorgemerkten Schwärzungen endgültig an: Text, Bildpunkte
    und Zeichnungen unter den Flächen werden entfernt (nicht nur überdeckt)."""
    seiten = []
    for seite in doc:
        if any(a.type[0] == pymupdf.PDF_ANNOT_REDACT for a in seite.annots()):
            seite.apply_redactions(
                images=pymupdf.PDF_REDACT_IMAGE_PIXELS,
                graphics=pymupdf.PDF_REDACT_LINE_ART_REMOVE_IF_TOUCHED,
                text=pymupdf.PDF_REDACT_TEXT_REMOVE,
            )
            seiten.append(seite.number)
    return seiten


# Suchmuster für „Schwärzen nach Muster“
MUSTER = {
    "iban": r"\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,3})?\b",
    "email": r"\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b",
    "telefon": r"(?<![\w/])(?<!\d )(?:\+49|0049|0)[ ]?(?:\(0\)[ ]?)?\d{2,5}(?:[ /-]?\d{2,}){1,4}\b",
    "datum": r"\b(?:0?[1-9]|[12]\d|3[01])\.(?:0?[1-9]|1[0-2])\.(?:19|20)?\d{2}\b",
    "versicherungsnummer": r"\b[A-Z]{0,3}\d{2,4}[ -]?\d{3,}(?:[ -]?\d{1,})*\b",
}


def muster_suchen(doc: pymupdf.Document, muster: str, eigener_begriff: str = "") -> list[dict]:
    """Findet Fundstellen (IBAN, E-Mail, Telefon, Datum oder eigener Begriff)
    und liefert normierte Rechtecke je Fundstelle."""
    if muster == "begriff":
        if not eigener_begriff.strip():
            raise DokumentFehler("Bitte einen Suchbegriff eingeben.")
        regex = re.compile(re.escape(eigener_begriff.strip()), re.IGNORECASE)
    elif muster in MUSTER:
        regex = re.compile(MUSTER[muster])
    else:
        raise DokumentFehler("Unbekanntes Suchmuster.")
    fundstellen = []
    for seite in doc:
        text = seite.get_text("text")
        gesehen: set[str] = set()
        for treffer in regex.finditer(text):
            wert = treffer.group(0).strip()
            if not wert or wert in gesehen:
                continue
            gesehen.add(wert)
            # Zeilenumbrüche im Treffer → als Leerzeichen suchen
            for r in seite.search_for(re.sub(r"\s+", " ", wert)):
                fundstellen.append({"seite": seite.number, "text": wert, "rechteck": norm_rechteck(seite, r)})
    return fundstellen


# --------------------------------------------------------------- Sichtbarkeit
def gruppen_ausblenden_seite(
    doc: pymupdf.Document, seite: pymupdf.Page, gruppen: frozenset[str] | set[str], ohne: frozenset[int] = frozenset()
) -> list[tuple[int, int, int]]:
    """Setzt vorübergehend das Hidden-Flag für Anmerkungen der Gruppen auf
    einer Seite. Gibt die alten Flags zurück (für ``gruppen_wiederherstellen``)."""
    alt = []
    for a in seite.annots():
        art = _ARTEN.get(a.type[0])
        if art and (a.xref in ohne or _gruppe_ermitteln(doc, a, art) in gruppen):
            alt.append((seite.number, a.xref, a.flags))
            a.set_flags(a.flags | pymupdf.PDF_ANNOT_IS_HIDDEN)
    return alt


def gruppen_wiederherstellen(doc: pymupdf.Document, alt: list[tuple[int, int, int]]) -> None:
    for seite_nr, xref, flags in alt:
        try:
            finden(doc[seite_nr], xref).set_flags(flags)
        except DokumentFehler:
            pass


def gruppen_entfernen(doc: pymupdf.Document, gruppen: set[str]) -> int:
    """Löscht Anmerkungen der Gruppen endgültig (für Druck/Export-Kopien)."""
    anzahl = 0
    for seite in doc:
        weg = []
        for a in seite.annots():
            art = _ARTEN.get(a.type[0])
            if art and _gruppe_ermitteln(doc, a, art) in gruppen:
                weg.append(a.xref)
        for xref in weg:
            seite.delete_annot(finden(seite, xref))
            anzahl += 1
    return anzahl


# --------------------------------------------------------------- Textauswahl
def woerter(seite: pymupdf.Page) -> list[list]:
    """Wörter einer Seite in Lesereihenfolge: [x0, y0, x1, y1, text, block, zeile]
    normiert auf die angezeigte Seite (auch unsichtbarer OCR-Text)."""
    ergebnis = []
    for w in seite.get_text("words", sort=False):
        r = norm_rechteck(seite, pymupdf.Rect(w[:4]))
        ergebnis.append([*r, w[4], w[5], w[6]])
    return ergebnis


def stempel_text(vorlage: str, kuerzel: str) -> str:
    jetzt = datetime.now()
    return (
        vorlage.replace("{datum}", jetzt.strftime("%d.%m.%Y"))
        .replace("{zeit}", jetzt.strftime("%H:%M"))
        .replace("{kuerzel}", kuerzel or autor_name())
    )


def einzelbild(doc: pymupdf.Document, seite_nr: int, xref: int, skala: float) -> bytes:
    """Eine Anmerkung allein als PNG mit Transparenz – so groß wie ihr
    Rechteck, in der Ausrichtung der angezeigten Seite."""
    seite = doc[seite_nr]
    annot = finden(seite, xref)
    skala = max(0.1, min(float(skala), 8.0))
    flags = annot.flags
    if flags & pymupdf.PDF_ANNOT_IS_HIDDEN:
        annot.set_flags(flags & ~pymupdf.PDF_ANNOT_IS_HIDDEN)
    try:
        pix = annot.get_pixmap(matrix=pymupdf.Matrix(skala, skala), alpha=True)
    finally:
        if flags & pymupdf.PDF_ANNOT_IS_HIDDEN:
            annot.set_flags(flags)
    # MuPDF liefert das Bild bereits in Anzeige-Ausrichtung (Seitendrehung)
    return pix.tobytes("png")
