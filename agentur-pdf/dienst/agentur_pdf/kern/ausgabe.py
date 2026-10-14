"""Ausgabe: Drucken/Exportieren mit wählbaren Ebenen, Komprimieren,
Metadaten entfernen, Ebenen (OCG) anzeigen/umschalten, Bilder exportieren.

Nur im MuPDF-Thread aufrufen.
"""

from __future__ import annotations

import io
import zipfile

import pymupdf

from . import anmerkungen
from .dokumente import DokumentFehler

# Komprimierungsstufen: (Bilder über … dpi, werden auf … dpi verkleinert, JPEG-Qualität)
KOMPRIMIERUNG = {
    "gering": (220, 200, 85),
    "mittel": (170, 150, 75),
    "stark": (120, 100, 60),
    "maximal": (90, 72, 45),
}


def _kopie(doc: pymupdf.Document) -> pymupdf.Document:
    return pymupdf.open("pdf", doc.tobytes())


# ---------------------------------------------------------------- Ebenen
def _ausgeschaltet(doc: pymupdf.Document) -> set[int]:
    """Ebenen, die in der Standard-Konfiguration aus sind (``get_ocgs`` kennt
    nur den Zustand beim Öffnen, ``get_layer`` den aktuellen)."""
    try:
        return set(doc.get_layer(-1).get("off") or [])
    except Exception:  # noqa: BLE001
        return {x for x, e in (doc.get_ocgs() or {}).items() if not e.get("on", True)}


def ebenen(doc: pymupdf.Document) -> list[dict]:
    """Optional-Content-Gruppen (Ebenen) des Dokuments."""
    ergebnis = []
    aus = _ausgeschaltet(doc)
    for xref, e in (doc.get_ocgs() or {}).items():
        ergebnis.append({"id": xref, "name": e.get("name", ""), "an": xref not in aus})
    ergebnis.sort(key=lambda e: e["name"].lower())
    return ergebnis


def ebene_schalten(doc: pymupdf.Document, xref: int, an: bool) -> None:
    ocgs = doc.get_ocgs() or {}
    if xref not in ocgs:
        raise DokumentFehler("Ebene nicht gefunden.")
    aus = _ausgeschaltet(doc)
    an_liste = [x for x in ocgs if (x not in aus if x != xref else an)]
    aus_liste = [x for x in ocgs if x not in an_liste]
    doc.set_layer(-1, on=an_liste, off=aus_liste)


# ------------------------------------------------------- Drucken/Exportieren
def ausgabe_pdf(
    doc: pymupdf.Document,
    seiten: list[int] | None = None,
    gruppen_weg: set[str] | None = None,
    ebenen_aus: list[int] | None = None,
    ebenen_an: list[int] | None = None,
) -> bytes:
    """Kopie für Druck/Export: ausgewählte Seiten, Anmerkungsgruppen entfernt,
    Ebenen wie gewünscht ein-/ausgeblendet. Vorgemerkte (nicht angewendete)
    Schwärzungen werden nie mitgedruckt."""
    kopie = _kopie(doc)
    try:
        weg = set(gruppen_weg or set()) | {"schwaerzung"}
        anmerkungen.gruppen_entfernen(kopie, weg)
        ocgs = kopie.get_ocgs() or {}
        if ocgs and (ebenen_aus or ebenen_an):
            aus = {x for x in (ebenen_aus or []) if x in ocgs}
            bisher_aus = _ausgeschaltet(kopie)
            an = [x for x in ocgs if x not in aus and (x not in bisher_aus or x in (ebenen_an or []))]
            kopie.set_layer(-1, on=an, off=[x for x in ocgs if x not in an])
        if seiten is not None:
            gueltig = [s for s in seiten if 0 <= s < kopie.page_count]
            if not gueltig:
                raise DokumentFehler("Keine gültigen Seiten ausgewählt.")
            if gueltig != list(range(kopie.page_count)):
                kopie.select(gueltig)
        return kopie.tobytes(garbage=3, deflate=True)
    finally:
        kopie.close()


def ebenen_namen(doc: pymupdf.Document, ebenen_ids: list[int]) -> set[str]:
    return {e["name"] for x, e in (doc.get_ocgs() or {}).items() if x in ebenen_ids}


def ebenen_entfernen(daten: bytes, namen: set[str]) -> bytes:
    """Inhalte ausgeblendeter Ebenen wirklich entfernen (für Export): Seiten
    werden so neu aufgebaut, dass Inhalte dieser Ebenen nicht mehr enthalten
    sind. Text der Ebenen wird über Schwärzungs-Technik entfernt."""
    doc = pymupdf.open("pdf", daten)
    try:
        if not namen:
            return daten
        for seite in doc:
            # Inhaltsblöcke mit /OC-Markierung der Ebene aus dem Seiteninhalt löschen
            seite.clean_contents()
            for xref in seite.get_contents():
                inhalt = doc.xref_stream(xref)
                neu = _oc_bloecke_entfernen(inhalt, seite, namen)
                if neu != inhalt:
                    doc.update_stream(xref, neu)
        return doc.tobytes(garbage=3, deflate=True)
    finally:
        doc.close()


def _oc_bloecke_entfernen(inhalt: bytes, seite: pymupdf.Page, ebenen_namen: set[str]) -> bytes:
    """Entfernt ``/OC /Name BDC … EMC``-Blöcke, deren Property auf eine der
    Ebenen verweist."""
    import re

    doc = seite.parent
    # Ressourcennamen (z. B. /MC0) der zu entfernenden Ebenen ermitteln
    props = set()
    for name, ref in re.findall(r"/(\S+)\s+(\d+)\s+0\s+R", _eigenschaften(doc, seite.xref)):
        ocg = doc.xref_get_key(int(ref), "Name")
        if ocg[0] == "string" and ocg[1] in ebenen_namen:
            props.add(name)
    if not props:
        return inhalt
    ausgabe = bytearray()
    i = 0
    muster = re.compile(rb"/OC\s*/(\S+)\s*BDC")
    while True:
        m = muster.search(inhalt, i)
        if not m:
            ausgabe += inhalt[i:]
            break
        name = m.group(1).decode("latin-1")
        if name not in props:
            ausgabe += inhalt[i : m.end()]
            i = m.end()
            continue
        ausgabe += inhalt[i : m.start()]
        # passendes EMC finden (verschachtelte BDC/BMC beachten)
        tiefe, j = 1, m.end()
        token = re.compile(rb"\b(BDC|BMC|EMC)\b")
        while tiefe and (t := token.search(inhalt, j)):
            tiefe += 1 if t.group(1) in (b"BDC", b"BMC") else -1
            j = t.end()
        i = j
    return bytes(ausgabe)


def _eigenschaften(doc: pymupdf.Document, seiten_xref: int) -> str:
    """/Resources/Properties einer Seite als Text – auch wenn Resources oder
    Properties indirekte Objekte sind."""
    typ, wert = doc.xref_get_key(seiten_xref, "Resources")
    if typ == "xref":
        quelle = int(wert.split()[0])
        typ, wert = doc.xref_get_key(quelle, "Properties")
    elif typ == "dict":
        typ, wert = doc.xref_get_key(seiten_xref, "Resources/Properties")
    else:
        return ""
    if typ == "xref":
        return doc.xref_object(int(wert.split()[0]))
    return wert if typ == "dict" else ""


# ---------------------------------------------------------------- Komprimieren
def komprimieren(doc: pymupdf.Document, stufe: str) -> bytes:
    if stufe not in KOMPRIMIERUNG:
        raise DokumentFehler("Unbekannte Komprimierungsstufe.")
    schwelle, ziel, qualitaet = KOMPRIMIERUNG[stufe]
    kopie = _kopie(doc)
    try:
        kopie.rewrite_images(
            dpi_threshold=schwelle,
            dpi_target=ziel,
            quality=qualitaet,
            lossy=True,
            lossless=True,
            bitonal=True,
            color=True,
            gray=True,
            set_to_gray=False,
        )
        try:
            kopie.subset_fonts()
        except Exception:  # noqa: BLE001 – Schriften verkleinern ist optional
            pass
        return kopie.tobytes(garbage=4, deflate=True, deflate_images=True, deflate_fonts=True, clean=True)
    finally:
        kopie.close()


def groesse_schaetzen(doc: pymupdf.Document) -> int:
    return len(doc.tobytes(garbage=3, deflate=True))


# ------------------------------------------------------------- Metadaten
def metadaten_entfernen(doc: pymupdf.Document, autoren: bool = True) -> None:
    doc.set_metadata({})
    try:
        doc.del_xml_metadata()
    except Exception:  # noqa: BLE001
        pass
    if autoren:
        for seite in doc:
            for a in seite.annots():
                if a.info.get("title"):
                    a.set_info(title="")
                    a.update()


def metadaten(doc: pymupdf.Document) -> dict:
    m = doc.metadata or {}
    return {
        "titel": m.get("title", ""),
        "autor": m.get("author", ""),
        "betreff": m.get("subject", ""),
        "stichwoerter": m.get("keywords", ""),
        "ersteller": m.get("creator", ""),
        "produzent": m.get("producer", ""),
        "erstellt": m.get("creationDate", ""),
        "geaendert": m.get("modDate", ""),
    }


def metadaten_setzen(doc: pymupdf.Document, werte: dict) -> None:
    m = dict(doc.metadata or {})
    for schluessel, pdf in (("titel", "title"), ("autor", "author"), ("betreff", "subject"), ("stichwoerter", "keywords")):
        if schluessel in werte:
            m[pdf] = str(werte[schluessel])
    doc.set_metadata(m)


# ------------------------------------------------------------ Bilder-Export
def seiten_als_bilder(doc: pymupdf.Document, seiten: list[int], dpi: int, format_: str, titel: str) -> tuple[bytes, str]:
    """Einzelseite → PNG/JPG, mehrere → ZIP."""
    if format_ not in ("png", "jpg"):
        raise DokumentFehler("Format muss PNG oder JPG sein.")
    dpi = max(50, min(600, int(dpi)))
    stamm = titel.rsplit(".", 1)[0] or "Seite"

    def bild(nr: int) -> bytes:
        pix = doc[nr].get_pixmap(dpi=dpi, alpha=False)
        return pix.tobytes("jpeg", jpg_quality=90) if format_ == "jpg" else pix.tobytes("png")

    if len(seiten) == 1:
        return bild(seiten[0]), f"{stamm}_Seite{seiten[0] + 1}.{format_}"
    puffer = io.BytesIO()
    with zipfile.ZipFile(puffer, "w", zipfile.ZIP_STORED) as z:
        for nr in seiten:
            z.writestr(f"{stamm}_Seite{nr + 1:03d}.{format_}", bild(nr))
    return puffer.getvalue(), f"{stamm}_Seiten.zip"


def text_export(doc: pymupdf.Document) -> str:
    teile = []
    for seite in doc:
        teile.append(f"--- Seite {seite.number + 1} ---\n{seite.get_text('text').strip()}\n")
    return "\n".join(teile)
