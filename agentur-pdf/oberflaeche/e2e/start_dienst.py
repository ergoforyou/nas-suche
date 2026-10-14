"""Startet den Dienst für die Oberflächentests mit frischen Testdaten."""

import os
import shutil
import sys
import tempfile
from pathlib import Path

DIENST = Path(__file__).resolve().parents[2] / "dienst"
sys.path[:0] = [str(DIENST), str(DIENST / "tests")]

import testdaten  # noqa: E402
from agentur_pdf.__main__ import main  # noqa: E402

# Fester Ordner, damit die Tests die Dateien zum Öffnen finden
ordner = Path(tempfile.gettempdir()) / "agentur-pdf-e2e"
shutil.rmtree(ordner, ignore_errors=True)
ordner.mkdir(parents=True)
os.environ["AGENTUR_PDF_DATEN"] = str(ordner / "benutzer")
gross = testdaten.versicherungsbrief(ordner / "150_seiten.pdf", seiten=150)
testdaten.versicherungsbrief(ordner / "brief.pdf", seiten=3)
testdaten.beschriftet(ordner / "a.pdf", "A", 5)
testdaten.beschriftet(ordner / "b.pdf", "B", 3)
testdaten.mit_leerseiten(ordner / "duplex.pdf")
testdaten.foto(ordner / "foto.jpg")
testdaten.word(ordner / "anschreiben.docx", "Anschreiben an Familie Weiß")
(ordner / "kaputt.pdf").write_bytes(b"keine pdf")
import pymupdf  # noqa: E402
import scan_hilfen  # noqa: E402

_brief = pymupdf.open(testdaten.versicherungsbrief(ordner / "_quelle.pdf", seiten=2))
scan_hilfen.als_scan(_brief).save(ordner / "scan.pdf")
scan_hilfen.als_scan(_brief, dpi=100, rauschen=40, jpeg=15).save(ordner / "schlecht.pdf")
(ordner / "eingang").mkdir()
print(f"Testdaten: {ordner}", flush=True)
raise SystemExit(main(["--nur-dienst", "--port", "8766", "--token", "e2e", str(gross)]))
