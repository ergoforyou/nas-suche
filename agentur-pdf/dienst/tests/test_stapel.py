"""Stapelverarbeitung: Ordner mit Dateien auf einmal bearbeiten."""

from __future__ import annotations

import pymupdf
import pytest
from fastapi.testclient import TestClient

from agentur_pdf.api.app import erstelle_app
from agentur_pdf.benutzer.speicher import BenutzerSpeicher
from agentur_pdf.kern import ocr
from agentur_pdf.kern.auftraege import Auftrag
from agentur_pdf.kern.konvertierung import direkt
from agentur_pdf.kern.sperren import Sperren
from agentur_pdf.kern.stapel import StapelOptionen, dateien_sammeln, stapel_ausfuehren
from agentur_pdf.kern.dokumente import DokumentFehler

import testdaten


@pytest.fixture
def eingang(tmp_path):
    ordner = tmp_path / "Eingang"
    (ordner / "Unter").mkdir(parents=True)
    testdaten.versicherungsbrief(ordner / "brief.pdf", seiten=2)
    testdaten.mit_leerseiten(ordner / "duplex.pdf")
    testdaten.foto(ordner / "foto.jpg")
    testdaten.beschriftet(ordner / "Unter" / "tief.pdf", "T", 2)
    (ordner / "notizen.xyz").write_text("x")
    (ordner / "~$brief.pdf.sperre").write_text("{}")
    return ordner


def test_dateien_sammeln(eingang):
    namen = [p.name for p in dateien_sammeln([str(eingang)])]
    assert namen == ["brief.pdf", "duplex.pdf", "foto.jpg"]
    mit = [p.name for p in dateien_sammeln([str(eingang), str(eingang / "brief.pdf")], unterordner=True)]
    assert sorted(mit) == ["brief.pdf", "duplex.pdf", "foto.jpg", "tief.pdf"]


def test_optionen_pruefen():
    with pytest.raises(DokumentFehler):
        StapelOptionen.aus_dict({"ausgabe": "ordner", "zielordner": ""})
    with pytest.raises(DokumentFehler):
        StapelOptionen.aus_dict({"namensmuster": "fest"})
    with pytest.raises(DokumentFehler):
        StapelOptionen.aus_dict({"komprimieren": "riesig"})


def test_in_zielordner_verkleinern_leerseiten_metadaten(eingang, tmp_path):
    ziel = tmp_path / "Fertig"
    o = StapelOptionen(
        texterkennung=False, leerseiten_entfernen=True, metadaten_entfernen=True, komprimieren="stark",
        ausgabe="ordner", zielordner=str(ziel), namensmuster="{nr}_{name}",
    )
    ergebnis = stapel_ausfuehren(dateien_sammeln([str(eingang)]), o, direkt, Auftrag("x", "t"))
    assert not ergebnis["fehler"]
    namen = sorted(p.name for p in ziel.iterdir())
    assert namen == ["001_brief.pdf", "002_duplex.pdf", "003_foto.pdf"]
    duplex_vorher = pymupdf.open(eingang / "duplex.pdf").page_count
    assert pymupdf.open(ziel / "002_duplex.pdf").page_count < duplex_vorher
    assert pymupdf.open(ziel / "003_foto.pdf").page_count == 1
    assert not (pymupdf.open(ziel / "001_brief.pdf").metadata or {}).get("producer")


def test_ersetzen_mit_sicherung_und_sperre(eingang):
    brief = eingang / "brief.pdf"
    fremd = Sperren()
    fremd.ich.update({"benutzer": "martina", "rechner": "PC-02"})
    testdaten.beschriftet(eingang / "gesperrt.pdf", "G", 1)
    fremd.holen(str(eingang / "gesperrt.pdf"))
    o = StapelOptionen(texterkennung=False, leerseiten_entfernen=True, ausgabe="ersetzen")
    ergebnis = stapel_ausfuehren([brief, eingang / "gesperrt.pdf", eingang / "foto.jpg"], o, direkt, Auftrag("x", "t"), Sperren())
    assert (eingang / "_Original" / "brief.pdf").exists()
    assert (eingang / "foto.pdf").exists() and (eingang / "foto.jpg").exists()
    assert len(ergebnis["fehler"]) == 1 and "martina" in ergebnis["fehler"][0]["fehler"]
    assert not (eingang / "_Original" / "gesperrt.pdf").exists()


@pytest.mark.skipif(ocr.tesseract_finden() is None, reason="Tesseract fehlt")
def test_texterkennung_im_stapel(tmp_path):
    import scan_hilfen

    ordner = tmp_path / "scans"
    ordner.mkdir()
    quelle = pymupdf.open(testdaten.versicherungsbrief(tmp_path / "q.pdf", seiten=1))
    scan_hilfen.als_scan(quelle).save(ordner / "scan.pdf")
    o = StapelOptionen(texterkennung=True, ausgabe="daneben")
    ergebnis = stapel_ausfuehren(dateien_sammeln([str(ordner)]), o, direkt, Auftrag("x", "t"))
    assert not ergebnis["fehler"]
    neu = pymupdf.open(ordner / "scan_bearbeitet.pdf")
    assert "Versicherung" in neu[0].get_text()


def test_stapel_api(eingang, tmp_path):
    c = TestClient(erstelle_app("t", benutzer=BenutzerSpeicher(tmp_path / "pc")))
    c.headers.update({"X-Agentur-Token": "t"})
    v = c.post("/api/stapel/vorschau", json={"pfade": [str(eingang)], "unterordner": True}).json()
    assert v["anzahl"] == 4
    a = c.post(
        "/api/stapel",
        json={"pfade": [str(eingang)], "optionen": {"texterkennung": False, "ausgabe": "ordner", "zielordner": str(tmp_path / "out")}},
    ).json()
    fertig = c.app.state.auftraege.warten(a["id"])
    assert fertig.status == "fertig" and len(fertig.ergebnis["dateien"]) == 3
    assert c.post("/api/stapel", json={"pfade": [str(tmp_path / "leer")], "optionen": {}}).status_code == 400
