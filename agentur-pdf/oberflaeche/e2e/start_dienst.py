"""Startet den Dienst für die Oberflächentests mit frischen Testdaten."""

import os
import sys
import tempfile
from pathlib import Path

DIENST = Path(__file__).resolve().parents[2] / "dienst"
sys.path[:0] = [str(DIENST), str(DIENST / "tests")]

import testdaten  # noqa: E402
from agentur_pdf.__main__ import main  # noqa: E402

ordner = Path(tempfile.mkdtemp(prefix="agentur-pdf-e2e-"))
os.environ["AGENTUR_PDF_DATEN"] = str(ordner / "benutzer")
gross = testdaten.versicherungsbrief(ordner / "150_seiten.pdf", seiten=150)
testdaten.versicherungsbrief(ordner / "brief.pdf", seiten=3)
print(f"Testdaten: {ordner}", flush=True)
raise SystemExit(main(["--nur-dienst", "--port", "8766", "--token", "e2e", str(gross)]))
