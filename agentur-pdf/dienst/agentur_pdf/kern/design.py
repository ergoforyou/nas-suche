"""Design: Kundenschreiben aufwerten, Angebote und Präsentationen gestalten.

* Objekt freistellen: Ausschnitt einer Seite rendern und das Motiv vom
  Hintergrund trennen – Fotos mit GrabCut (OpenCV, lokal), Logos und
  Unterschriften über den weißen Hintergrund.
* Anordnen: Ebenenreihenfolge, Drehen/Spiegeln, Duplizieren von Bildern.
* Briefpapier: Briefbogen-PDF unter Seiten legen (Seite 1 der Vorlage für
  die erste, Seite 2 – falls vorhanden – für die Folgeseiten).
* Deckblatt und Inhaltsverzeichnis für Angebotsmappen.

Alles läuft lokal, nichts verlässt den PC. Nur im MuPDF-Thread aufrufen
(``freistellen_motiv`` darf in einem beliebigen Thread laufen).
"""

from __future__ import annotations

import io
import re
from datetime import date

import numpy as np
import pymupdf
from PIL import Image

from .anmerkungen import _info_setzen, _markieren, finden, hex_zu_rgb, norm_rechteck, pdf_rechteck
from .dokumente import DokumentFehler

EBENE_BRIEFPAPIER = "Briefpapier"


# ------------------------------------------------------------- Freistellen
def ausschnitt(doc: pymupdf.Document, seite_nr: int, rechteck: list[float], dpi: int = 200) -> bytes:
    """Bereich der angezeigten Seite (normiert) als PNG – inkl. Anmerkungen."""
    if not 0 <= seite_nr < doc.page_count:
        raise DokumentFehler("Seite existiert nicht.")
    seite = doc[seite_nr]
    b, h = seite.rect.width, seite.rect.height
    clip = pymupdf.Rect(rechteck[0] * b, rechteck[1] * h, rechteck[2] * b, rechteck[3] * h).normalize() & seite.rect
    if clip.width < 4 or clip.height < 4:
        raise DokumentFehler("Der Bereich ist zu klein.")
    # große Bereiche nicht unnötig hoch auflösen
    dpi = int(min(dpi, 2400 * 72 / max(clip.width, clip.height)))
    return seite.get_pixmap(clip=clip, dpi=dpi, alpha=False).tobytes("png")


def freistellen_motiv(png: bytes, staerke: int = 50) -> tuple[bytes, list[float]]:
    """Motiv vom Hintergrund trennen (GrabCut). Der Benutzer hat das Motiv
    umrahmt – der Rand gilt als Hintergrund. Liefert (PNG mit Transparenz,
    Zuschnitt [x0,y0,x1,y1] als Anteil des Ausschnitts)."""
    import cv2

    im = Image.open(io.BytesIO(png)).convert("RGB")
    rgb = np.asarray(im)
    h, b = rgb.shape[:2]
    faktor = min(1.0, 700 / max(h, b))
    klein = cv2.resize(rgb, (max(8, int(b * faktor)), max(8, int(h * faktor))), interpolation=cv2.INTER_AREA)
    kh, kb = klein.shape[:2]
    rand = max(2, int(min(kh, kb) * 0.03))
    maske = np.zeros((kh, kb), np.uint8)
    hg_modell = np.zeros((1, 65), np.float64)
    vg_modell = np.zeros((1, 65), np.float64)
    bgr = cv2.cvtColor(klein, cv2.COLOR_RGB2BGR)
    cv2.grabCut(bgr, maske, (rand, rand, kb - 2 * rand, kh - 2 * rand), hg_modell, vg_modell, 5, cv2.GC_INIT_WITH_RECT)
    vorne = np.where((maske == cv2.GC_FGD) | (maske == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)
    # Löcher schließen, Krümel entfernen
    kern = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    vorne = cv2.morphologyEx(vorne, cv2.MORPH_CLOSE, kern)
    anzahl, beschriftung, werte, _ = cv2.connectedComponentsWithStats(vorne)
    if anzahl > 1:
        groesste = 1 + int(np.argmax(werte[1:, cv2.CC_STAT_AREA]))
        mindest = werte[groesste, cv2.CC_STAT_AREA] * 0.05
        for i in range(1, anzahl):
            if werte[i, cv2.CC_STAT_AREA] < mindest:
                vorne[beschriftung == i] = 0
    if not vorne.any():
        raise DokumentFehler("Kein Motiv gefunden – Rahmen bitte enger um das Motiv ziehen.")
    # in voller Größe, Kante weich (Stärke = Weichheit)
    alpha = cv2.resize(vorne, (b, h), interpolation=cv2.INTER_LINEAR).astype(np.float32)
    weich = 0.6 + staerke / 40
    alpha = cv2.GaussianBlur(alpha, (0, 0), weich)
    ergebnis = Image.fromarray(np.dstack([rgb, np.clip(alpha, 0, 255).astype(np.uint8)]), "RGBA")
    box = ergebnis.getchannel("A").point(lambda v: 255 if v > 20 else 0).getbbox() or (0, 0, b, h)
    ergebnis = ergebnis.crop(box)
    puffer = io.BytesIO()
    ergebnis.save(puffer, "PNG", optimize=True)
    return puffer.getvalue(), [box[0] / b, box[1] / h, box[2] / b, box[3] / h]


def freistellen_weiss(png: bytes, staerke: int = 50) -> tuple[bytes, list[float]]:
    """Logo/Unterschrift auf weißem Grund: Weiß wird durchsichtig."""
    from .bilder import freistellen

    ergebnis = freistellen(png, staerke, zuschneiden=False)
    im = Image.open(io.BytesIO(ergebnis))
    box = im.getchannel("A").point(lambda v: 255 if v > 20 else 0).getbbox()
    if not box:
        raise DokumentFehler("Im Bereich ist nichts außer Weiß.")
    b, h = im.size
    puffer = io.BytesIO()
    im.crop(box).save(puffer, "PNG", optimize=True)
    return puffer.getvalue(), [box[0] / b, box[1] / h, box[2] / b, box[3] / h]


def bereich_abdecken(doc: pymupdf.Document, seite_nr: int, rechteck: list[float], farbe: str = "#FFFFFF") -> None:
    """Ursprünglichen Bereich deckend übermalen (Seiteninhalt, keine Anmerkung)."""
    seite = doc[seite_nr]
    seite.draw_rect(pdf_rechteck(seite, rechteck), color=None, fill=hex_zu_rgb(farbe) or (1, 1, 1), overlay=True)


# ----------------------------------------------------------------- Anordnen
def _annots_liste(doc: pymupdf.Document, seite: pymupdf.Page) -> tuple[list[str], str | None]:
    typ, wert = doc.xref_get_key(seite.xref, "Annots")
    if typ == "xref":
        ziel = int(wert.split()[0])
        return re.findall(r"\d+ 0 R", doc.xref_object(ziel)), str(ziel)
    if typ == "array":
        return re.findall(r"\d+ 0 R", wert), None
    return [], None


def ebene(doc: pymupdf.Document, seite_nr: int, xref: int, richtung: str) -> None:
    """Zeichenreihenfolge ändern: vorne | hinten | ganz_vorne | ganz_hinten."""
    seite = doc[seite_nr]
    finden(seite, xref)
    liste, eigenes_objekt = _annots_liste(doc, seite)
    eintrag = f"{xref} 0 R"
    if eintrag not in liste:
        raise DokumentFehler("Element nicht gefunden.")
    i = liste.index(eintrag)
    liste.pop(i)
    ziel = {"vorne": i + 1, "hinten": max(0, i - 1), "ganz_vorne": len(liste), "ganz_hinten": 0}.get(richtung)
    if ziel is None:
        raise DokumentFehler("Unbekannte Richtung.")
    liste.insert(min(ziel, len(liste)), eintrag)
    neu = "[" + " ".join(liste) + "]"
    if eigenes_objekt:
        doc.update_object(int(eigenes_objekt), neu)
    else:
        doc.xref_set_key(seite.xref, "Annots", neu)


def _bild_aus_stempel(doc: pymupdf.Document, annot: pymupdf.Annot) -> bytes:
    """Ursprüngliches Bild (mit Transparenz) aus einer Bild-Anmerkung holen."""

    def bilder_in(xref: int, tiefe: int = 0) -> list[int]:
        if tiefe > 4:
            return []
        gefunden = []
        typ, xobj = doc.xref_get_key(xref, "Resources/XObject")
        if typ == "xref":
            xobj = doc.xref_object(int(xobj.split()[0]))
        for ref in re.findall(r"(\d+) 0 R", xobj if typ in ("dict", "xref") else ""):
            unter = int(ref)
            if doc.xref_get_key(unter, "Subtype")[1] == "/Image":
                gefunden.append(unter)
            else:
                gefunden += bilder_in(unter, tiefe + 1)
        return gefunden

    typ, ap = doc.xref_get_key(annot.xref, "AP/N")
    if typ != "xref":
        raise DokumentFehler("Bild nicht lesbar.")
    kandidaten = bilder_in(int(ap.split()[0]))
    if not kandidaten:
        raise DokumentFehler("Bild nicht lesbar.")
    xref = max(kandidaten, key=lambda x: doc.xref_get_key(x, "Width")[1] and int(doc.xref_get_key(x, "Width")[1]) or 0)
    pix = pymupdf.Pixmap(doc, xref)
    _, maske = doc.xref_get_key(xref, "SMask")
    if maske and maske != "null":
        try:
            pix = pymupdf.Pixmap(pymupdf.Pixmap(pix, 0) if pix.alpha else pix, pymupdf.Pixmap(doc, int(maske.split()[0])))
        except Exception:  # noqa: BLE001 – ohne Maske weiter
            pass
    if pix.n - pix.alpha > 3:
        pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
    return pix.tobytes("png")


def bild_umformen(doc: pymupdf.Document, seite_nr: int, xref: int, aktion: str) -> int:
    """Bild-Anmerkung drehen (rechts/links), spiegeln (waagerecht/senkrecht)
    oder duplizieren. Liefert die xref des neuen bzw. ersetzten Bildes."""
    seite = doc[seite_nr]
    annot = finden(seite, xref)
    if annot.type[0] != pymupdf.PDF_ANNOT_STAMP:
        raise DokumentFehler("Das geht nur mit Bildern (z. B. freigestellten Objekten, Logos).")
    info = dict(annot.info)
    deckkraft = annot.opacity
    rechteck = pymupdf.Rect(annot.rect)
    png = _bild_aus_stempel(doc, annot)
    im = Image.open(io.BytesIO(png))
    if aktion == "rechts":
        im = im.transpose(Image.Transpose.ROTATE_270)
    elif aktion == "links":
        im = im.transpose(Image.Transpose.ROTATE_90)
    elif aktion == "waagerecht":
        im = im.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    elif aktion == "senkrecht":
        im = im.transpose(Image.Transpose.FLIP_TOP_BOTTOM)
    elif aktion != "duplizieren":
        raise DokumentFehler("Unbekannte Aktion.")
    puffer = io.BytesIO()
    im.save(puffer, "PNG")
    if aktion in ("rechts", "links"):
        # gleiche Mitte, Breite und Höhe getauscht
        m = (rechteck.tl + rechteck.br) / 2
        rechteck = pymupdf.Rect(m.x - rechteck.height / 2, m.y - rechteck.width / 2, m.x + rechteck.height / 2, m.y + rechteck.width / 2)
    if aktion == "duplizieren":
        versatz = min(seite.rect.width, seite.rect.height) * 0.03
        rechteck = rechteck + (versatz, versatz, versatz, versatz)
    neu = seite.add_stamp_annot(rechteck, stamp=puffer.getvalue())
    _info_setzen(neu, info.get("title", ""), info.get("content", "Bild"), None)
    if deckkraft is not None and 0 <= deckkraft < 1:
        neu.set_opacity(deckkraft)
    neu.update()
    _, art = doc.xref_get_key(xref, "AgenturArt")
    _markieren(doc, neu.xref, "eintragung", (art or "/bild").lstrip("/") or "bild")
    if aktion != "duplizieren":
        # an die Stelle des alten in der Zeichenreihenfolge setzen
        liste, _ = _annots_liste(doc, seite)
        alt_pos = liste.index(f"{xref} 0 R")
        seite.delete_annot(finden(seite, xref))
        liste, eigenes = _annots_liste(doc, seite)
        eintrag = f"{neu.xref} 0 R"
        liste.remove(eintrag)
        liste.insert(min(alt_pos, len(liste)), eintrag)
        if eigenes:
            doc.update_object(int(eigenes), "[" + " ".join(liste) + "]")
        else:
            doc.xref_set_key(seite.xref, "Annots", "[" + " ".join(liste) + "]")
    return neu.xref


# --------------------------------------------------------------- Briefpapier
def _ebene(doc: pymupdf.Document, name: str) -> int:
    for xref, e in (doc.get_ocgs() or {}).items():
        if e.get("name") == name:
            return xref
    return doc.add_ocg(name, on=True)


def briefpapier(doc: pymupdf.Document, vorlage: bytes, seiten: list[int] | None = None) -> list[int]:
    """Briefbogen unter die Seiten legen. Hat die Vorlage zwei Seiten, gilt
    Seite 1 für die erste Zielseite und Seite 2 für alle weiteren."""
    try:
        quelle = pymupdf.open("pdf", vorlage)
    except Exception as fehler:  # noqa: BLE001
        raise DokumentFehler(f"Briefpapier ist keine lesbare PDF: {fehler}") from None
    if not quelle.page_count:
        raise DokumentFehler("Das Briefpapier hat keine Seiten.")
    ziel = sorted({s for s in (seiten if seiten is not None else range(doc.page_count)) if 0 <= s < doc.page_count})
    if not ziel:
        raise DokumentFehler("Keine gültigen Seiten ausgewählt.")
    oc = _ebene(doc, EBENE_BRIEFPAPIER)
    for i, nr in enumerate(ziel):
        seite = doc[nr]
        vorlage_seite = 0 if i == 0 or quelle.page_count == 1 else 1
        # ganze Seite in ungedrehten Koordinaten; Vorlage aufrecht zur Anzeige
        rahmen = (seite.rect * seite.derotation_matrix).normalize()
        seite.show_pdf_page(rahmen, quelle, vorlage_seite, overlay=False, keep_proportion=False, rotate=seite.rotation, oc=oc)
    quelle.close()
    return ziel


# --------------------------------------------------- Deckblatt, Verzeichnis
LAYOUTS = ("band", "seitenleiste", "zentriert")


def _text(seite: pymupdf.Page, rect: pymupdf.Rect, text: str, groesse: float, farbe, fett=False, ausrichtung=0) -> None:
    if not text:
        return
    seite.insert_textbox(rect, text, fontsize=groesse, fontname="hebo" if fett else "helv", color=farbe, align=ausrichtung)


def deckblatt(doc: pymupdf.Document, d: dict, logo: bytes | None = None) -> None:
    """Deckblatt als neue erste Seite (A4 hoch, oder Format der ersten Seite)."""
    layout = d.get("layout", "band")
    if layout not in LAYOUTS:
        raise DokumentFehler("Unbekanntes Layout.")
    titel = (d.get("titel") or "").strip()
    if not titel:
        raise DokumentFehler("Bitte einen Titel eingeben.")
    farbe = hex_zu_rgb(d.get("farbe") or "#B5121B") or (0.71, 0.07, 0.11)
    dunkel = (0.13, 0.13, 0.15)
    grau = (0.42, 0.42, 0.46)
    if doc.page_count:
        r0 = doc[0].rect
        b, h = (r0.width, r0.height) if r0.height >= r0.width else (595.3, 841.9)
    else:
        b, h = 595.3, 841.9
    seite = doc.new_page(0, width=b, height=h)
    rand = b * 0.1
    unter = (d.get("untertitel") or "").strip()
    kunde = (d.get("kunde") or "").strip()
    datum = (d.get("datum") or date.today().strftime("%d.%m.%Y")).strip()
    verfasser = (d.get("verfasser") or "").strip()

    if layout == "band":
        seite.draw_rect(pymupdf.Rect(0, 0, b, h * 0.36), color=None, fill=farbe)
        _text(seite, pymupdf.Rect(rand, h * 0.16, b - rand, h * 0.30), titel, 30, (1, 1, 1), fett=True)
        _text(seite, pymupdf.Rect(rand, h * 0.40, b - rand, h * 0.48), unter, 16, dunkel)
        logo_rect = pymupdf.Rect(b - rand - 120, h * 0.04, b - rand, h * 0.04 + 60)
        info_y = h * 0.74
    elif layout == "seitenleiste":
        seite.draw_rect(pymupdf.Rect(0, 0, b * 0.07, h), color=None, fill=farbe)
        seite.draw_rect(pymupdf.Rect(b * 0.07 + 18, h * 0.30, b * 0.07 + 22, h * 0.46), color=None, fill=farbe)
        _text(seite, pymupdf.Rect(b * 0.07 + 36, h * 0.30, b - rand, h * 0.40), titel, 28, dunkel, fett=True)
        _text(seite, pymupdf.Rect(b * 0.07 + 36, h * 0.40, b - rand, h * 0.47), unter, 15, grau)
        logo_rect = pymupdf.Rect(b - rand - 120, h * 0.06, b - rand, h * 0.06 + 60)
        info_y = h * 0.78
    else:  # zentriert
        seite.draw_line(pymupdf.Point(rand, h * 0.30), pymupdf.Point(b - rand, h * 0.30), color=farbe, width=2)
        seite.draw_line(pymupdf.Point(rand, h * 0.52), pymupdf.Point(b - rand, h * 0.52), color=farbe, width=2)
        _text(seite, pymupdf.Rect(rand, h * 0.33, b - rand, h * 0.44), titel, 28, dunkel, fett=True, ausrichtung=1)
        _text(seite, pymupdf.Rect(rand, h * 0.44, b - rand, h * 0.51), unter, 15, grau, ausrichtung=1)
        logo_rect = pymupdf.Rect(b / 2 - 70, h * 0.10, b / 2 + 70, h * 0.10 + 70)
        info_y = h * 0.72

    if logo:
        try:
            seite.insert_image(logo_rect, stream=logo, keep_proportion=True)
        except Exception as fehler:  # noqa: BLE001
            raise DokumentFehler(f"Logo kann nicht eingefügt werden: {fehler}") from None
    zeilen = []
    if kunde:
        zeilen.append(("Für", kunde))
    if datum:
        zeilen.append(("Datum", datum))
    if verfasser:
        zeilen.append(("Ihr Ansprechpartner", verfasser))
    links = rand if layout != "seitenleiste" else b * 0.07 + 36
    for i, (bez, wert) in enumerate(zeilen):
        y = info_y + i * 34
        seite.insert_text((links, y), bez.upper(), fontsize=8, fontname="hebo", color=farbe)
        seite.insert_text((links, y + 15), wert, fontsize=12, fontname="helv", color=dunkel)
    # Lesezeichen zeigen auf Seitenobjekte und rücken von selbst mit – nur
    # das Deckblatt vorne ergänzen
    try:
        doc.set_toc([[1, titel, 1]] + [[lvl, t, p] for lvl, t, p, *_ in doc.get_toc()])
    except Exception:  # noqa: BLE001 – Lesezeichen sind Komfort
        pass


def inhaltsverzeichnis(doc: pymupdf.Document, position: int = 1, titel: str = "Inhalt", farbe: str = "#B5121B") -> int:
    """Verzeichnis aus den Lesezeichen als Seite an ``position`` (mit Links).
    Liefert die Zahl der Einträge."""
    toc = [e for e in doc.get_toc() if e[2] > 0]
    if not toc:
        raise DokumentFehler("Das Dokument hat keine Lesezeichen – zuerst Lesezeichen anlegen (z. B. beim Zusammenführen).")
    position = max(0, min(position, doc.page_count))
    akzent = hex_zu_rgb(farbe) or (0.71, 0.07, 0.11)
    r0 = doc[0].rect
    b, h = (r0.width, r0.height) if r0.height >= r0.width else (595.3, 841.9)
    seite = doc.new_page(position, width=b, height=h)
    rand = b * 0.11
    seite.insert_text((rand, h * 0.12), titel, fontsize=24, fontname="hebo", color=(0.13, 0.13, 0.15))
    seite.draw_line(pymupdf.Point(rand, h * 0.12 + 10), pymupdf.Point(rand + 60, h * 0.12 + 10), color=akzent, width=2.5)
    y = h * 0.12 + 46
    eintraege = 0
    for ebene_, text, seite_nr in toc:
        if y > h - 60:
            break
        ziel = seite_nr if seite_nr - 1 < position else seite_nr + 1  # Seiten dahinter rücken eins weiter
        einzug = rand + (ebene_ - 1) * 16
        groesse = 12 if ebene_ == 1 else 10.5
        schrift = "hebo" if ebene_ == 1 else "helv"
        seite.insert_text((einzug, y), text[:90], fontsize=groesse, fontname=schrift, color=(0.13, 0.13, 0.15))
        nummer = str(ziel)
        nb = pymupdf.get_text_length(nummer, "helv", groesse)
        seite.insert_text((b - rand - nb, y), nummer, fontsize=groesse, fontname="helv", color=akzent)
        textende = einzug + pymupdf.get_text_length(text[:90], schrift, groesse) + 6
        if textende < b - rand - nb - 10:
            seite.draw_line(pymupdf.Point(textende, y), pymupdf.Point(b - rand - nb - 6, y), color=(0.75, 0.75, 0.78), width=0.6, dashes="[1 3] 0")
        seite.insert_link({"kind": pymupdf.LINK_GOTO, "from": pymupdf.Rect(einzug, y - groesse, b - rand, y + 3), "page": ziel - 1})
        y += 24 if ebene_ == 1 else 19
        eintraege += 1
    return eintraege


def neue_rechteck_nach_zuschnitt(rechteck: list[float], zuschnitt: list[float]) -> list[float]:
    """Lage des zugeschnittenen Motivs auf der Seite (normiert)."""
    x0, y0, x1, y1 = rechteck
    b, h = x1 - x0, y1 - y0
    return [x0 + zuschnitt[0] * b, y0 + zuschnitt[1] * h, x0 + zuschnitt[2] * b, y0 + zuschnitt[3] * h]


__all__ = ["ausschnitt", "freistellen_motiv", "freistellen_weiss", "bereich_abdecken", "ebene", "bild_umformen", "briefpapier", "deckblatt", "inhaltsverzeichnis", "norm_rechteck"]
