from __future__ import annotations

import pymupdf
import pytest

import testdaten
from agentur_pdf.kern.dokumente import DokumentFehler, naechste_stufe
from agentur_pdf.kern.render_cache import RenderCache


def test_oeffnen_info_und_doppelt_oeffnen(speicher, brief):
    dok = speicher.oeffnen_pfad(str(brief))
    info = speicher.info(dok.id)
    assert info["seitenanzahl"] == 3
    assert info["seiten"][0] == {"breite": 595, "hoehe": 842, "drehung": 0}
    # Dieselbe Datei erneut öffnen liefert denselben Tab statt einer Kopie.
    assert speicher.oeffnen_pfad(str(brief)).id == dok.id


def test_fehlende_datei(speicher, tmp_path):
    with pytest.raises(DokumentFehler):
        speicher.oeffnen_pfad(str(tmp_path / "gibtsnicht.pdf"))


def test_bild_wird_zu_pdf(speicher, tmp_path):
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 200, 100), 0)
    pix.clear_with(255)
    dok = speicher.oeffnen_bytes(pix.tobytes("png"), "foto.png")
    assert dok.doc.is_pdf and dok.doc.page_count == 1


def test_passwortgeschuetzt(speicher, tmp_path):
    pfad = tmp_path / "geheim.pdf"
    doc = pymupdf.open()
    doc.new_page()
    doc.save(pfad, encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw="geheim", owner_pw="geheim")
    with pytest.raises(DokumentFehler, match="PASSWORT_ERFORDERLICH"):
        speicher.oeffnen_pfad(str(pfad))
    assert speicher.oeffnen_pfad(str(pfad), "geheim").doc.page_count == 1


def test_render_und_cache(speicher, brief):
    dok = speicher.oeffnen_pfad(str(brief))
    png = speicher.render(dok.id, 0, 1.0)
    pix = pymupdf.Pixmap(png)
    assert (pix.width, pix.height) == (595, 842)
    treffer_vorher = speicher.cache.treffer
    assert speicher.render(dok.id, 0, 0.9) == png  # 0.9 → Stufe 1.0 → Cache
    assert speicher.cache.treffer == treffer_vorher + 1


def test_render_ansichtsdrehung(speicher, brief):
    dok = speicher.oeffnen_pfad(str(brief))
    pix = pymupdf.Pixmap(speicher.render(dok.id, 0, 0.5, drehung=90))
    assert (pix.width, pix.height) == (421, 298)


def test_kacheln_ergeben_gesamtbild(speicher, brief):
    """Vier Kacheln müssen pixelgenau das Gesamtbild ergeben – auch gedreht."""
    dok = speicher.oeffnen_pfad(str(brief))
    for drehung in (0, 90, 180, 270):
        gesamt = pymupdf.Pixmap(speicher.render(dok.id, 0, 1.0, drehung))
        b, h = gesamt.width // 2, gesamt.height // 2
        for x, y in ((0, 0), (b, 0), (0, h), (b, h)):
            kachel = pymupdf.Pixmap(speicher.render(dok.id, 0, 1.0, drehung, (x, y, b, h)))
            assert abs(kachel.width - b) <= 1 and abs(kachel.height - h) <= 1
            # Stichprobe: Pixel in der Kachelmitte stimmt mit Gesamtbild überein.
            px, py = b // 2, h // 2
            assert kachel.pixel(px, py) == gesamt.pixel(x + px, y + py), (drehung, x, y)


def test_ungueltige_seite(speicher, brief):
    dok = speicher.oeffnen_pfad(str(brief))
    with pytest.raises(DokumentFehler):
        speicher.render(dok.id, 99, 1.0)


def test_suche_mit_umlauten(speicher, brief):
    dok = speicher.oeffnen_pfad(str(brief))
    treffer = speicher.suchen(dok.id, "prämie")
    assert [t["seite"] for t in treffer] == [0, 1, 2]
    x0, y0, x1, y1 = treffer[0]["rechteck"]
    assert 0 < x0 < x1 < 1 and 0 < y0 < y1 < 1
    assert "Prämie" in treffer[0]["ausschnitt"]
    assert speicher.suchen(dok.id, "Versicherungsschein")


def test_suche_auf_gedrehter_seite(speicher, tmp_path):
    dok = speicher.oeffnen_pfad(str(testdaten.gedrehtes_dokument(tmp_path / "quer.pdf")))
    (treffer,) = speicher.suchen(dok.id, "Prämie")
    x0, y0, x1, y1 = treffer["rechteck"]
    # Text lief vor der 90°-Drehung waagerecht → jetzt senkrecht (höher als breit)
    assert (y1 - y0) > (x1 - x0)
    assert all(0 <= v <= 1 for v in treffer["rechteck"])


def test_lesezeichen(speicher, brief):
    dok = speicher.oeffnen_pfad(str(brief))
    assert speicher.lesezeichen(dok.id)[1] == {"ebene": 1, "titel": "Abschnitt 2", "seite": 1}


def test_schliessen_leert_cache(speicher, brief):
    dok = speicher.oeffnen_pfad(str(brief))
    speicher.render(dok.id, 0, 1.0)
    assert len(speicher.cache) == 1
    speicher.schliessen(dok.id)
    assert len(speicher.cache) == 0


def test_render_stufen():
    assert naechste_stufe(0.9) == 1.0
    assert naechste_stufe(1.0) == 1.0
    assert naechste_stufe(1.1) == 1.25
    assert naechste_stufe(99) == 16.0


def test_cache_begrenzung():
    c = RenderCache(max_bytes=10)
    c.put(("a", 1), b"12345")
    c.put(("a", 2), b"12345")
    c.put(("b", 1), b"12345")
    assert c.get(("a", 1)) is None and c.groesse == 10
