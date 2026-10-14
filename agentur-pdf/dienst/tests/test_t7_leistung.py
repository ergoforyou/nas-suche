"""Abnahmekriterium T7 (Dienst-Seite): 150-seitige PDF, Zoom 25–800 % ohne
spürbare Verzögerung.

Gemessen wird die Renderzeit des Dienstes. Die Oberfläche rendert nur sichtbare
Seiten (±2) und ab hoher Vergrößerung Kacheln; deshalb muss eine Seite bzw.
Kachel deutlich unter 150 ms liegen, damit Scrollen flüssig wirkt.
"""

from __future__ import annotations

import statistics
import time

import pymupdf
import pytest

import testdaten

GRENZE_MS = 150


@pytest.fixture(scope="module")
def grosses_dokument(tmp_path_factory):
    pfad = tmp_path_factory.mktemp("t7") / "150_seiten.pdf"
    testdaten.versicherungsbrief(pfad, seiten=150)
    # Zusätzlich gescannte Seiten simulieren: 300-dpi-Graustufenbild pro 10. Seite
    doc = pymupdf.open(pfad)
    scan = pymupdf.Pixmap(pymupdf.csGRAY, pymupdf.IRect(0, 0, 2480, 3508), 0)
    scan.clear_with(235)
    scan_png = scan.tobytes("png")
    for nr in range(0, 150, 10):
        doc[nr].insert_image(doc[nr].rect, stream=scan_png, overlay=False)
    doc.saveIncr() if doc.can_save_incrementally() else doc.save(pfad, incremental=True)
    doc.close()
    return pfad


@pytest.mark.leistung
@pytest.mark.parametrize("zoom", [0.25, 1.0, 2.0])
def test_t7_seiten_rendern_schnell(speicher, grosses_dokument, zoom):
    dok = speicher.oeffnen_pfad(str(grosses_dokument))
    assert dok.doc.page_count == 150
    zeiten = []
    for nr in range(0, 150, 7):
        start = time.perf_counter()
        speicher.render(dok.id, nr, zoom)
        zeiten.append((time.perf_counter() - start) * 1000)
    assert statistics.median(zeiten) < GRENZE_MS, zeiten


@pytest.mark.leistung
def test_t7_800_prozent_kacheln(speicher, grosses_dokument):
    """800 % auf einem HiDPI-Bildschirm = Skala 8; gerendert werden nur Kacheln."""
    dok = speicher.oeffnen_pfad(str(grosses_dokument))
    zeiten = []
    for nr in (0, 10, 75):
        for x, y in ((0, 0), (1024, 1024), (2048, 2048)):
            start = time.perf_counter()
            speicher.render(dok.id, nr, 8.0, 0, (x, y, 512, 512))
            zeiten.append((time.perf_counter() - start) * 1000)
    assert statistics.median(zeiten) < GRENZE_MS, zeiten


@pytest.mark.leistung
def test_t7_oeffnen_schnell(speicher, grosses_dokument):
    start = time.perf_counter()
    dok = speicher.oeffnen_pfad(str(grosses_dokument))
    speicher.info(dok.id)
    assert (time.perf_counter() - start) < 1.0
