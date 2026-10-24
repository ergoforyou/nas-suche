"""PDF-Formulare ausfüllen und gestalten (AcroForm-Felder).

Nur im MuPDF-Thread aufrufen.
"""

from __future__ import annotations

import pymupdf

from .anmerkungen import norm_rechteck, pdf_rechteck
from .dokumente import DokumentFehler

_TYPEN = {
    pymupdf.PDF_WIDGET_TYPE_TEXT: "text",
    pymupdf.PDF_WIDGET_TYPE_CHECKBOX: "ankreuzen",
    pymupdf.PDF_WIDGET_TYPE_RADIOBUTTON: "auswahlknopf",
    pymupdf.PDF_WIDGET_TYPE_COMBOBOX: "auswahlliste",
    pymupdf.PDF_WIDGET_TYPE_LISTBOX: "liste",
    pymupdf.PDF_WIDGET_TYPE_SIGNATURE: "unterschrift",
    pymupdf.PDF_WIDGET_TYPE_BUTTON: "knopf",
}


def felder(doc: pymupdf.Document) -> dict[str, list[dict]]:
    ergebnis: dict[str, list[dict]] = {}
    if not doc.is_form_pdf:
        return ergebnis
    for seite in doc:
        liste = []
        for w in seite.widgets():
            typ = _TYPEN.get(w.field_type)
            if typ in (None, "knopf"):
                continue
            eintrag = {
                "id": w.xref,
                "name": w.field_name or "",
                "typ": typ,
                "rechteck": norm_rechteck(seite, w.rect),
                "wert": w.field_value if w.field_value is not None else "",
                "nur_lesen": bool(w.field_flags & pymupdf.PDF_FIELD_IS_READ_ONLY),
                "mehrzeilig": bool(w.field_flags & pymupdf.PDF_TX_FIELD_IS_MULTILINE) if typ == "text" else False,
                "schriftgroesse": w.text_fontsize or 0,
                "max_laenge": w.text_maxlen or 0,
                "pflicht": bool(w.field_flags & pymupdf.PDF_FIELD_IS_REQUIRED),
                "hinweis": w.field_label or "",
            }
            if typ in ("auswahlliste", "liste"):
                eintrag["optionen"] = [o if isinstance(o, str) else o[1] for o in (w.choice_values or [])]
            if typ in ("ankreuzen", "auswahlknopf"):
                eintrag["an_wert"] = w.on_state() or "Yes"
                eintrag["wert"] = w.field_value not in (False, "Off", "", None)
            liste.append(eintrag)
        if liste:
            ergebnis[str(seite.number)] = liste
    return ergebnis


def feld_setzen(doc: pymupdf.Document, seite_nr: int, xref: int, wert) -> None:
    seite = doc[seite_nr]
    for w in seite.widgets():
        if w.xref != xref:
            continue
        if w.field_flags & pymupdf.PDF_FIELD_IS_READ_ONLY:
            raise DokumentFehler("Dieses Feld ist schreibgeschützt.")
        typ = _TYPEN.get(w.field_type)
        if typ == "unterschrift":
            raise DokumentFehler("Unterschriftsfelder füllt der Kunde online aus („Zur Unterschrift senden“).")
        if typ in ("ankreuzen", "auswahlknopf"):
            w.field_value = w.on_state() if wert else "Off"
        else:
            w.field_value = "" if wert is None else str(wert)
        w.update()
        return
    raise DokumentFehler("Formularfeld nicht gefunden.")


# ------------------------------------------------------ Felder gestalten
ANLEGBAR = {
    "text": pymupdf.PDF_WIDGET_TYPE_TEXT,
    "ankreuzen": pymupdf.PDF_WIDGET_TYPE_CHECKBOX,
    "auswahlliste": pymupdf.PDF_WIDGET_TYPE_COMBOBOX,
    "liste": pymupdf.PDF_WIDGET_TYPE_LISTBOX,
    # Platzhalter für die Online-Unterschrift (Ergoforyou Sign)
    "unterschrift": pymupdf.PDF_WIDGET_TYPE_SIGNATURE,
}
_NAMEN = {"text": "Textfeld", "ankreuzen": "Kontrollkästchen", "auswahlliste": "Auswahl", "liste": "Liste", "unterschrift": "Unterschrift Kunde"}
UNTERSCHRIFT_HINTERGRUND = (1.0, 0.97, 0.8)
RAHMEN = (0.45, 0.52, 0.62)
HINTERGRUND = (0.93, 0.96, 1.0)


def _alle_namen(doc: pymupdf.Document) -> set[str]:
    return {w.field_name for s in doc for w in s.widgets() if w.field_name}


def _freier_name(doc: pymupdf.Document, basis: str, ausser: int | None = None) -> str:
    belegt = {w.field_name for s in doc for w in s.widgets() if w.field_name and w.xref != ausser}
    if basis not in belegt:
        return basis
    i = 2
    while f"{basis} {i}" in belegt:
        i += 1
    return f"{basis} {i}"


def _widget(doc: pymupdf.Document, seite_nr: int, xref: int) -> tuple[pymupdf.Page, pymupdf.Widget]:
    seite = doc[seite_nr]
    for w in seite.widgets():
        if w.xref == xref:
            return seite, w
    raise DokumentFehler("Formularfeld nicht gefunden.")


def _eigenschaften(w: pymupdf.Widget, typ: str, d: dict) -> None:
    if "optionen" in d and typ in ("auswahlliste", "liste"):
        optionen = [str(o).strip() for o in d["optionen"] or [] if str(o).strip()]
        w.choice_values = optionen or ["Bitte wählen"]
    if "schriftgroesse" in d:
        w.text_fontsize = max(0.0, min(72.0, float(d["schriftgroesse"] or 0)))
    flags = w.field_flags or 0
    for schluessel, bit in (("pflicht", pymupdf.PDF_FIELD_IS_REQUIRED), ("nur_lesen", pymupdf.PDF_FIELD_IS_READ_ONLY)):
        if schluessel in d:
            flags = flags | bit if d[schluessel] else flags & ~bit
    if "mehrzeilig" in d and typ == "text":
        flags = flags | pymupdf.PDF_TX_FIELD_IS_MULTILINE if d["mehrzeilig"] else flags & ~pymupdf.PDF_TX_FIELD_IS_MULTILINE
    w.field_flags = flags
    if "hinweis" in d:
        w.field_label = str(d["hinweis"] or "")
    if "max_laenge" in d and typ == "text":
        w.text_maxlen = max(0, int(d["max_laenge"] or 0))


def feld_anlegen(doc: pymupdf.Document, seite_nr: int, d: dict) -> int:
    """Neues Feld aus ``d`` = {typ, rechteck (normiert), name?, optionen?,
    mehrzeilig?, schriftgroesse?, pflicht?, hinweis?, wert?}. Liefert die xref."""
    typ = d.get("typ", "text")
    if typ not in ANLEGBAR:
        raise DokumentFehler("Diesen Feldtyp gibt es nicht.")
    if not 0 <= seite_nr < doc.page_count:
        raise DokumentFehler("Seite existiert nicht.")
    seite = doc[seite_nr]
    rechteck = pdf_rechteck(seite, d.get("rechteck") or [])
    if rechteck.width < 4 or rechteck.height < 4:
        raise DokumentFehler("Das Feld ist zu klein.")
    w = pymupdf.Widget()
    w.field_type = ANLEGBAR[typ]
    w.rect = rechteck
    w.field_name = _freier_name(doc, (d.get("name") or "").strip() or _NAMEN[typ])
    w.border_color = RAHMEN
    w.border_width = 0.8
    w.fill_color = UNTERSCHRIFT_HINTERGRUND if typ == "unterschrift" else HINTERGRUND
    w.text_font = "Helv"
    w.text_fontsize = 0  # automatisch passend
    if typ == "ankreuzen":
        w.field_value = bool(d.get("wert"))
    elif typ in ("auswahlliste", "liste"):
        w.choice_values = ["Bitte wählen"]
    _eigenschaften(w, typ, {k: v for k, v in d.items() if k in ("optionen", "schriftgroesse", "pflicht", "mehrzeilig", "hinweis", "max_laenge")})
    if typ == "text" and d.get("wert"):
        w.field_value = str(d["wert"])
    elif typ in ("auswahlliste", "liste"):
        w.field_value = d.get("wert") or (w.choice_values[0] if typ == "auswahlliste" else "")
    neu = seite.add_widget(w)
    return neu.xref


def feld_aendern(doc: pymupdf.Document, seite_nr: int, xref: int, d: dict) -> None:
    """Lage (rechteck) und Eigenschaften ändern – die xref bleibt gleich."""
    seite, w = _widget(doc, seite_nr, xref)
    typ = _TYPEN.get(w.field_type, "text")
    if "rechteck" in d:
        r = pdf_rechteck(seite, d["rechteck"])
        if r.width < 4 or r.height < 4:
            raise DokumentFehler("Das Feld ist zu klein.")
        w.rect = r
    if "rolle" in d and typ == "unterschrift":
        # Rolle = wer hier unterschreibt; gleiche Rolle → dieselbe Person
        rolle = " ".join(str(d["rolle"] or "").split())[:40] or "Kunde"
        w.field_name = _freier_name(doc, f"Unterschrift {rolle}", ausser=xref)
    if "name" in d:
        name = str(d["name"] or "").strip()
        if not name:
            raise DokumentFehler("Das Feld braucht einen Namen.")
        if name != w.field_name and name in _alle_namen(doc):
            raise DokumentFehler(f"Ein Feld „{name}“ gibt es schon.")
        w.field_name = name
    _eigenschaften(w, typ, d)
    w.update()


def feld_loeschen(doc: pymupdf.Document, seite_nr: int, xref: int) -> None:
    seite, w = _widget(doc, seite_nr, xref)
    seite.delete_widget(w)
