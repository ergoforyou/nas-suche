"""Texterkennung an eigenen Dokumenten messen – Daten bleiben auf dem PC.

Aufruf:  python werkzeuge/ocr_messung.py <Ordner mit PDFs>

1. PDFs MIT echtem Text (z. B. Word-Export): werden zu künstlichen Scans
   gemacht (300 dpi, schräg + JPEG, Bildschirmfoto, Dunkelmodus) und erkannt.
   Gemessen wird, wie viele der echten Wörter die Erkennung wiederfindet.
2. Gescannte PDFs (Bild + fremde OCR, z. B. Adobe Scan, ScanSnap): fremde
   Textebene wird ersetzt. Gemessen wird der Anteil echter deutscher Wörter
   (Wörterbuch) – vorher (fremde OCR) und nachher (Agentur-PDF).
"""

from __future__ import annotations

import re
import sys
import time
from pathlib import Path

DIENST = Path(__file__).resolve().parents[1] / "dienst"
sys.path[:0] = [str(DIENST), str(DIENST / "tests")]

import pymupdf  # noqa: E402

import scan_hilfen  # noqa: E402
from agentur_pdf.kern import ocr  # noqa: E402
from agentur_pdf.kern.woerterbuch import woerterbuch  # noqa: E402

WORT = re.compile(r"[A-Za-zÄÖÜäöüß]{4,}")


def erkennen(doc: pymupdf.Document) -> list[str]:
    texte = []
    for s in doc:
        dpi, typ = ocr.render_dpi(s)
        bild, _ = ocr.seite_rendern(s, dpi)
        texte.append(" ".join(w.text for w in ocr.erkennen(ocr.OcrAuftrag(s.number, bild, dpi, typ, s.rect)).woerter))
    return texte


def echte_woerter(text: str) -> tuple[int, int]:
    w = [x for x in WORT.findall(text)]
    return sum(1 for x in w if woerterbuch().bekannt(x)), len(w)


def main(ordner: Path) -> None:
    if not ocr.tesseract_finden():
        sys.exit("Tesseract nicht gefunden.")
    print(f"Tesseract-Modelle: {'tessdata_best' if ocr.tessdata_finden() else 'Standard'} | Wörterbuch: {woerterbuch().verfuegbar}\n")
    for pdf in sorted(ordner.glob("*.pdf")):
        doc = pymupdf.open(pdf)
        if all(not ocr.ist_bildseite(s) for s in doc) and any(ocr.hat_text(s) for s in doc):
            soll = set(WORT.findall(" ".join(s.get_text() for s in doc)))
            for name, kw in [("Scan 300 dpi", {}), ("Scan 200 dpi schräg JPEG", {"dpi": 200, "schraeg": 1.5, "jpeg": 50, "rauschen": 12}),
                             ("Bildschirmfoto 96 dpi", {"dpi": 96, "rauschen": 0, "jpeg": None}),
                             ("Dunkelmodus", {"dpi": 120, "rauschen": 0, "jpeg": None, "dunkel": True})]:
                t = time.time()
                ist = set(WORT.findall(" ".join(erkennen(scan_hilfen.als_scan(doc, **kw)))))
                print(f"{pdf.name[:40]:40} | {name:26} | Wörter wiedergefunden {len(soll & ist) / max(1, len(soll)) * 100:5.1f} % | {time.time() - t:5.1f} s")
        else:
            vorher = [echte_woerter(s.get_text()) for s in doc]
            t = time.time()
            nachher = [echte_woerter(x) for x in erkennen(doc)]
            v = sum(a for a, _ in vorher) / max(1, sum(b for _, b in vorher)) * 100
            n = sum(a for a, _ in nachher) / max(1, sum(b for _, b in nachher)) * 100
            print(f"{pdf.name[:40]:40} | Scan, {doc.page_count} S.            | echte Wörter: vorhandene OCR {v:5.1f} % → Agentur-PDF {n:5.1f} % | {time.time() - t:5.1f} s")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(Path(sys.argv[1]))
