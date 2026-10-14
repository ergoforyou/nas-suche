from __future__ import annotations

import os
import time

import pymupdf
import pytest

import scan_hilfen
import testdaten
from agentur_pdf.kern import ocr
from agentur_pdf.kern.ueberwachung import MARKIERUNG, Ueberwachung

pytestmark = pytest.mark.skipif(ocr.tesseract_finden() is None, reason="Tesseract nicht installiert")
direkt = lambda f, *a, **k: f(*a, **k)  # noqa: E731


def scan_mit_rueckseiten(pfad):
    quelle = pymupdf.open()
    brief = pymupdf.open(testdaten.versicherungsbrief(pfad.with_suffix(".quelle.pdf"), seiten=2))
    for s in range(2):
        quelle.insert_pdf(brief, from_page=s, to_page=s)
        quelle.new_page()  # leere Rückseite (Duplex)
    brief.close()  # Windows: offene Dateien lassen sich nicht löschen
    scan_hilfen.als_scan(quelle).save(pfad)
    pfad.with_suffix(".quelle.pdf").unlink()
    return pfad


def test_neuer_scan_wird_verarbeitet(tmp_path):
    eingang = tmp_path / "ScanSnap"
    eingang.mkdir()
    ereignisse = []
    regeln = [{"ordner": str(eingang), "original_sichern": True, "leerseiten_entfernen": True}]
    u = Ueberwachung(lambda: regeln, direkt, ereignisse.append)
    pfad = scan_mit_rueckseiten(eingang / "Scan_001.pdf")

    assert u.durchgang() == []  # 1. Blick: Datei könnte noch geschrieben werden
    (eintrag,) = u.durchgang()  # 2. Blick: unverändert → verarbeiten
    assert eintrag["ok"] and eintrag["erkannt"] == 2 and eintrag["leerseiten_entfernt"] == 2

    doc = pymupdf.open(pfad)
    assert doc.page_count == 2 and doc[0].search_for("Prämie")
    assert MARKIERUNG in doc.metadata["producer"]
    assert (eingang / "_Original" / "Scan_001.pdf").is_file()
    assert pymupdf.open(eingang / "_Original" / "Scan_001.pdf").page_count == 4
    assert "Scan verarbeitet: Scan_001.pdf" in ereignisse[0]["text"]
    # wird nicht erneut verarbeitet – auch nicht nach Neustart der Überwachung
    assert u.durchgang() == [] and u.durchgang() == []
    assert Ueberwachung(lambda: regeln, direkt, ereignisse.append).durchgang() == []


def test_zielordner_und_ohne_sicherung(tmp_path):
    eingang, ziel = tmp_path / "ein", tmp_path / "aus"
    eingang.mkdir()
    ziel.mkdir()
    regeln = [{"ordner": str(eingang), "ziel": str(ziel), "original_sichern": False, "leerseiten_entfernen": False}]
    u = Ueberwachung(lambda: regeln, direkt, lambda e: None)
    scan_mit_rueckseiten(eingang / "a.pdf")
    u.durchgang()
    (eintrag,) = u.durchgang()
    assert not (eingang / "a.pdf").exists() and (ziel / "a.pdf").is_file()
    assert pymupdf.open(ziel / "a.pdf").page_count == 4  # Leerseiten bleiben
    assert not (eingang / "_Original").exists()


def test_datei_im_schreiben_wird_abgewartet(tmp_path):
    eingang = tmp_path / "ein"
    eingang.mkdir()
    u = Ueberwachung(lambda: [{"ordner": str(eingang)}], direkt, lambda e: None)
    pfad = scan_mit_rueckseiten(eingang / "b.pdf")
    u.durchgang()
    # Scanner schreibt noch: Größe/Zeit ändern sich
    with open(pfad, "ab") as f:
        f.write(b"\n")
    os.utime(pfad, (time.time() + 5, time.time() + 5))
    assert u.durchgang() == []
    assert len(u.durchgang()) == 1


def test_kaputte_datei_meldet_fehler_einmal(tmp_path):
    eingang = tmp_path / "ein"
    eingang.mkdir()
    (eingang / "kaputt.pdf").write_bytes(b"keine pdf")
    ereignisse = []
    u = Ueberwachung(lambda: [{"ordner": str(eingang)}], direkt, ereignisse.append)
    u.durchgang()
    (eintrag,) = u.durchgang()
    assert not eintrag["ok"] and ereignisse[0]["art"] == "meldung"
    assert u.durchgang() == [] and u.durchgang() == []  # kein endloses Wiederholen


def test_inaktive_und_fehlende_ordner_werden_ignoriert(tmp_path):
    u = Ueberwachung(lambda: [{"ordner": str(tmp_path / "gibtsnicht")}, {"ordner": str(tmp_path), "aktiv": False}], direkt, lambda e: None)
    assert u.durchgang() == []


def test_jede_datei_genau_einmal_auch_bei_grossbuchstaben(tmp_path):
    """Grossgeschriebene Endung (SCAN.PDF) wird gefunden, aber nicht doppelt –
    und erst im zweiten Durchgang (Scanner könnte noch schreiben)."""
    eingang = tmp_path / "ein"
    eingang.mkdir()
    u = Ueberwachung(lambda: [{"ordner": str(eingang), "leerseiten_entfernen": False}], direkt, lambda e: None)
    scan_mit_rueckseiten(eingang / "x.pdf").rename(eingang / "SCAN.PDF")
    assert u.durchgang() == []
    assert [e["datei"] for e in u.durchgang()] == ["SCAN.PDF"]
