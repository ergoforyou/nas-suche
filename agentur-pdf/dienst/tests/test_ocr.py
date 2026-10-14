"""Texterkennung – nur mit künstlich erzeugten Scans (keine Kundendaten)."""

from __future__ import annotations

import math
import time

import numpy as np
import pymupdf
import pytest

import scan_hilfen
import testdaten
from agentur_pdf.kern import ocr
from agentur_pdf.kern.auftraege import Auftrag
from agentur_pdf.kern.bearbeitung import Bearbeitung
from agentur_pdf.kern.ocr_auftrag import OcrOptionen, bereich_erkennen, dokument_erkennen, unsichere_woerter

pytestmark = pytest.mark.skipif(ocr.tesseract_finden() is None, reason="Tesseract nicht installiert")
direkt = lambda f, *a, **k: f(*a, **k)  # noqa: E731


def erkennen(speicher, pfad, **optionen):
    dok = speicher.oeffnen_pfad(str(pfad))
    ergebnis = dokument_erkennen(dok.id, None, OcrOptionen(**optionen), speicher, Bearbeitung(speicher), Auftrag("t", "t"), direkt)
    return dok, ergebnis["ocr"]


@pytest.fixture()
def brief_scan(tmp_path):
    quelle = pymupdf.open(testdaten.versicherungsbrief(tmp_path / "brief.pdf", seiten=1))
    def machen(**kw):
        pfad = tmp_path / "scan.pdf"
        scan_hilfen.als_scan(quelle, **kw).save(pfad)
        return pfad, quelle
    return machen


@pytest.mark.leistung
def test_t2_zwanzig_seiten_sw_scan(speicher, tmp_path):
    """T2: 20-seitiger S/W-Scan (300 dpi) → OCR → Suche findet alle Stellen, Umlaute korrekt."""
    quelle = pymupdf.open(testdaten.versicherungsbrief(tmp_path / "brief.pdf", seiten=20))
    pfad = tmp_path / "scan.pdf"
    scan_hilfen.als_scan(quelle, dpi=300, schwarzweiss=True, rauschen=6).save(pfad)
    assert not pymupdf.open(pfad)[0].get_text().strip()  # vorher: kein Text
    start = time.perf_counter()
    dok, statistik = erkennen(speicher, pfad)
    dauer = time.perf_counter() - start
    print(f"T2: 20 Seiten in {dauer:.1f} s, Sicherheit {statistik['sicherheit']}")
    for begriff in ("Versicherungsschein", "Prämie", "Grüßen", "Gebäude", "jährliche"):
        seiten = [s.number for s in dok.doc if s.search_for(begriff)]
        assert seiten == list(range(20)), (begriff, seiten)
    assert statistik["erkannt"] == 20 and statistik["sicherheit"] > 85
    # Bild unverändert, Text unsichtbar auf eigener Ebene
    assert ocr.OCR_EBENE in [i["name"] for i in dok.doc.get_ocgs().values()]
    assert len(dok.doc[0].get_images()) == 1


def test_text_liegt_genau_ueber_dem_wort(speicher, brief_scan):
    pfad, quelle = brief_scan()
    dok, _ = erkennen(speicher, pfad)
    soll = quelle[0].search_for("Prämie")[0]
    (ist,) = dok.doc[0].search_for("Prämie")
    assert abs(ist.x0 - soll.x0) < 3 and abs(ist.y0 - soll.y0) < 3 and abs(ist.x1 - soll.x1) < 4


@pytest.mark.parametrize("winkel", [2.5, -4.0])
def test_schraege_scans(speicher, brief_scan, winkel):
    pfad, quelle = brief_scan(schraeg=winkel)
    dok, _ = erkennen(speicher, pfad)
    soll = quelle[0].search_for("Prämie")[0]
    (ist,) = dok.doc[0].search_for("Prämie")
    # erwartete Lage: Original um die Seitenmitte gedreht (PIL dreht gegen den Uhrzeigersinn)
    c = quelle[0].rect
    t = math.radians(winkel)
    dx, dy = (soll.x0 + soll.x1) / 2 - c.width / 2, (soll.y0 + soll.y1) / 2 - c.height / 2
    ex, ey = c.width / 2 + dx * math.cos(t) + dy * math.sin(t), c.height / 2 - dx * math.sin(t) + dy * math.cos(t)
    assert abs((ist.x0 + ist.x1) / 2 - ex) < 3 and abs((ist.y0 + ist.y1) / 2 - ey) < 3
    assert dok.doc[0].rotation == 0  # Schräglage ändert das Seitenbild nicht


@pytest.mark.parametrize("drehung,erwartet", [(90, 90), (180, 180), (-90, 270)])
def test_quer_und_kopfstehend_wird_gedreht(speicher, brief_scan, drehung, erwartet):
    pfad, quelle = brief_scan(drehung=drehung)
    dok, statistik = erkennen(speicher, pfad)
    seite = dok.doc[0]
    assert seite.rotation == erwartet and statistik["gedreht"] == 1
    # Treffer liegt (angezeigt) wieder dort, wo er im Original steht
    r = (seite.search_for("Prämie")[0] * seite.rotation_matrix).normalize()
    soll = quelle[0].search_for("Prämie")[0]
    assert abs(r.x0 - soll.x0) < 4 and abs(r.y0 - soll.y0) < 4


def test_textarme_seite_wird_nicht_faelschlich_gedreht(speicher, tmp_path):
    doc = pymupdf.open()
    seite = doc.new_page()
    seite.insert_text((72, 100), "Anlage 3", fontsize=14)
    seite.insert_text((72, 760), "Seite 5 von 5", fontsize=9)
    quelle = tmp_path / "q.pdf"
    doc.save(quelle)
    pfad = tmp_path / "s.pdf"
    scan_hilfen.als_scan(pymupdf.open(quelle)).save(pfad)
    dok, statistik = erkennen(speicher, pfad)
    assert dok.doc[0].rotation == 0 and statistik["gedreht"] == 0


def test_bildschirmfoto_und_dunkelmodus(speicher, brief_scan):
    for kw in ({"dpi": 96, "rauschen": 0, "jpeg": None}, {"dpi": 110, "rauschen": 0, "jpeg": None, "dunkel": True}):
        pfad, _ = brief_scan(**kw)
        dok, statistik = erkennen(speicher, pfad)
        text = dok.doc[0].get_text()
        assert "Prämie" in text and "Versicherungsschein" in text, kw
        speicher.schliessen(dok.id)


def test_vorhandener_text_wird_nicht_doppelt_erkannt(speicher, brief):
    dok, statistik = erkennen(speicher, brief)
    assert statistik["erkannt"] == 0 and statistik["uebersprungen"] == 3
    assert not dok.zurueck  # nichts geändert


def test_erzwingen_ersetzt_alte_textebene(speicher, brief_scan, tmp_path):
    pfad, _ = brief_scan()
    doc = pymupdf.open(pfad)
    doc[0].insert_text((50, 50), "Kaputte Altocr Xyzzy", render_mode=3)  # „schlechte“ OCR-Ebene
    doc.save(tmp_path / "alt.pdf")
    dok, statistik = erkennen(speicher, tmp_path / "alt.pdf", erzwingen=True)
    text = dok.doc[0].get_text()
    assert "Xyzzy" not in text and "Prämie" in text
    assert len(dok.doc[0].get_images()) == 1  # Bild bleibt


def test_digitale_seite_wird_auch_erzwungen_nicht_angefasst(speicher, brief):
    dok, statistik = erkennen(speicher, brief, erzwingen=True)
    assert statistik["erkannt"] == 0


def test_rueckgaengig_entfernt_textebene(speicher, brief_scan):
    pfad, _ = brief_scan()
    dok, _ = erkennen(speicher, pfad)
    assert dok.doc[0].search_for("Prämie")
    Bearbeitung(speicher).rueckgaengig(dok.id)
    assert not dok.doc[0].get_text().strip()


def test_bereichs_ocr(speicher, brief_scan):
    pfad, quelle = brief_scan()
    dok = speicher.oeffnen_pfad(str(pfad))
    r = quelle[0].search_for("Versicherungsschein Nr.")[0]
    w, h = quelle[0].rect.width, quelle[0].rect.height
    auftrag = bereich_erkennen(speicher, dok.id, 0, [(r.x0 - 4) / w, (r.y0 - 4) / h, (r.x1 + 90) / w, (r.y1 + 4) / h], "deu")
    text = ocr.erkennen(auftrag, "deu", ausrichten=False).text
    assert "Versicherungsschein Nr. VS-1000" in text


def test_umlaute_retten():
    woerter = [{"text": t} for t in ("Anderung", "Okoschutzversicherung:", "Versicherungsfalle", "Haus")]
    ocr.umlaute_retten(woerter)
    # „Versicherungsfalle“ ist ein echtes Wort → bleibt
    assert [w["text"] for w in woerter] == ["Änderung", "Ökoschutzversicherung:", "Versicherungsfalle", "Haus"]


def test_unsichere_woerter_werden_gemeldet(speicher, tmp_path):
    quelle = pymupdf.open(testdaten.versicherungsbrief(tmp_path / "b.pdf", seiten=1))
    pfad = tmp_path / "s.pdf"
    scan_hilfen.als_scan(quelle, dpi=100, rauschen=40, jpeg=15).save(pfad)  # sehr schlechter Scan
    dok, statistik = erkennen(speicher, pfad)
    unsicher = unsichere_woerter(speicher, dok.id)
    assert statistik["unsicher"] > 0 and unsicher[0]
    assert all(0 <= v <= 1 for r in unsicher[0] for v in r)


def test_schraeglage_messen():
    bild = np.full((800, 600), 255, np.uint8)
    for y in range(100, 700, 40):
        bild[y : y + 8, 80:520] = 0  # „Textzeilen“
    import cv2

    m = cv2.getRotationMatrix2D((300, 400), 3.0, 1.0)
    gedreht = cv2.warpAffine(bild, m, (600, 800), borderValue=255)
    assert abs(ocr.schraeglage_messen(gedreht) + 3.0) < 0.2
    assert ocr.schraeglage_messen(bild) == 0.0
