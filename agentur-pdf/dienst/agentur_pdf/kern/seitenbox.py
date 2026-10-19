"""Hilfe für Seiten mit Zuschnitt (CropBox ≠ MediaBox).

PyMuPDFs ``TextWriter`` setzt Text auf zugeschnittenen Seiten senkrecht
versetzt (um den Unterschied zwischen CropBox- und MediaBox-Unterkante).
Solche Seiten sind häufig: Scanner-Apps, „Zuschneiden & aufhellen“,
importierte PDFs. Abhilfe: während des Schreibens die CropBox kurz auf die
MediaBox setzen und die Punkte um den Zuschnitt verschieben.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

import pymupdf


@contextmanager
def ohne_zuschnitt(seite: pymupdf.Page) -> Iterator[pymupdf.Point]:
    """Liefert den Versatz, um den Punkte (ungedreht, bezogen auf die
    angezeigte Seite) für ``TextWriter`` verschoben werden müssen."""
    if seite.cropbox == seite.mediabox:
        yield pymupdf.Point(0, 0)
        return
    doc = seite.parent
    typ, alt = doc.xref_get_key(seite.xref, "CropBox")
    vorher = seite.cropbox_position
    m = seite.mediabox
    # Rohwert setzen (auch eine von /Pages geerbte CropBox wird so überdeckt)
    doc.xref_set_key(seite.xref, "CropBox", f"[{m.x0:g} {m.y0:g} {m.x1:g} {m.y1:g}]")
    try:
        yield vorher - seite.cropbox_position
    finally:
        doc.xref_set_key(seite.xref, "CropBox", alt if typ != "null" else "null")
