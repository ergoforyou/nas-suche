"""PDF-Formulare ausfüllen (AcroForm-Felder).

Nur im MuPDF-Thread aufrufen.
"""

from __future__ import annotations

import pymupdf

from .anmerkungen import norm_rechteck
from .dokumente import DokumentFehler

_TYPEN = {
    pymupdf.PDF_WIDGET_TYPE_TEXT: "text",
    pymupdf.PDF_WIDGET_TYPE_CHECKBOX: "ankreuzen",
    pymupdf.PDF_WIDGET_TYPE_RADIOBUTTON: "auswahlknopf",
    pymupdf.PDF_WIDGET_TYPE_COMBOBOX: "auswahlliste",
    pymupdf.PDF_WIDGET_TYPE_LISTBOX: "liste",
    pymupdf.PDF_WIDGET_TYPE_SIGNATURE: "signatur",
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
            if typ in (None, "knopf", "signatur"):
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
        if typ in ("ankreuzen", "auswahlknopf"):
            w.field_value = w.on_state() if wert else "Off"
        else:
            w.field_value = "" if wert is None else str(wert)
        w.update()
        return
    raise DokumentFehler("Formularfeld nicht gefunden.")
