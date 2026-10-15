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
# Bearbeiten & Schützen
from test_anmerkungen import unterschrift_png  # noqa: E402
from test_schuetzen import handyfoto, iban_dokument  # noqa: E402

(ordner / "unterschrift.png").write_bytes(unterschrift_png(verlauf=True))
iban_dokument(ordner / "iban.pdf")
(ordner / "handyfoto.jpg").write_bytes(handyfoto()[0])
_form = pymupdf.open()
_seite = _form.new_page()
_seite.insert_text((72, 90), "Antrag auf Vertragsänderung", fontsize=14)
_seite.insert_text((72, 128), "Name:", fontsize=11)
_seite.insert_text((72, 168), "Einverstanden:", fontsize=11)
for _typ, _name, _r in (
    (pymupdf.PDF_WIDGET_TYPE_TEXT, "Name", (160, 114, 420, 134)),
    (pymupdf.PDF_WIDGET_TYPE_CHECKBOX, "Einverstanden", (160, 156, 174, 170)),
):
    _w = pymupdf.Widget()
    _w.field_type, _w.field_name, _w.rect = _typ, _name, pymupdf.Rect(_r)
    if _typ == pymupdf.PDF_WIDGET_TYPE_TEXT:
        _w.field_value = ""
    _seite.add_widget(_w)
_form.save(ordner / "formular.pdf")
from test_vergleich import vertrag  # noqa: E402

vertrag(ordner / "vertrag_alt.pdf")
vertrag(ordner / "vertrag_neu.pdf", praemie="1.250,00 €", entfernt=True)
print(f"Testdaten: {ordner}", flush=True)
raise SystemExit(main(["--nur-dienst", "--port", "8766", "--token", "e2e", str(gross)]))
