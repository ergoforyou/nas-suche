"""Vorhandenen Text im PDF ändern."""

from __future__ import annotations

import pymupdf
import pytest
from fastapi.testclient import TestClient

from agentur_pdf.api.app import erstelle_app
from agentur_pdf.benutzer.speicher import BenutzerSpeicher
from agentur_pdf.kern import textbearbeitung as tb
from agentur_pdf.kern.dokumente import DokumentFehler


def brief(drehung=0):
    doc = pymupdf.open()
    s = doc.new_page()
    s.draw_rect(pymupdf.Rect(60, 80, 420, 145), fill=(0.9, 0.95, 1), color=None)  # farbiger Kasten
    s.insert_text((72, 100), "Die Jahresprämie beträgt 1.200,00 EUR.", fontsize=11, fontname="helv")
    s.insert_text((72, 130), "Zweite Zeile bleibt", fontsize=14, fontname="hebo", color=(0.8, 0, 0))
    s.insert_text((72, 300), "Senkrecht", fontsize=11, rotate=90)
    s.set_rotation(drehung)
    return doc


def zeile_mit(doc, text, seite=0):
    return next(z for z in tb.zeilen(doc, seite) if text in z["text"])


def test_zeilen_lesen():
    doc = brief()
    z = zeile_mit(doc, "Jahresprämie")
    assert z["groesse"] == 11 and z["farbe"] == "#000000" and not z["fett"] and z["bearbeitbar"]
    f = zeile_mit(doc, "Zweite")
    assert f["fett"] and f["farbe"] == "#CC0000" and f["groesse"] == 14
    assert not zeile_mit(doc, "Senkrecht")["bearbeitbar"]
    assert 0.1 < z["rechteck"][0] < 0.2


@pytest.mark.parametrize("drehung", [0, 90])
def test_betrag_aendern_mit_euro(drehung):
    doc = brief(drehung)
    z = zeile_mit(doc, "Jahresprämie")
    neu = tb.text_ersetzen(doc, 0, z["bbox"], "Die Jahresprämie beträgt 1.250,00 €.")
    text = doc[0].get_text()
    assert "1.250,00 €" in text and "1.200,00" not in text
    assert "Zweite Zeile bleibt" in text  # Nachbarzeile unberührt
    assert abs(neu["bbox"][0] - z["bbox"][0]) < 1 and abs(neu["bbox"][1] - z["bbox"][1]) < 2  # gleiche Stelle
    assert neu["groesse"] == 11
    # Hintergrund (Grafik) ist noch da
    assert any(p.get("fill") for p in doc[0].get_drawings())


def test_fett_bleibt_fett_farbe_groesse_aenderbar():
    doc = brief()
    z = zeile_mit(doc, "Zweite")
    neu = tb.text_ersetzen(doc, 0, z["bbox"], "Zweite Zeile geändert", groesse=12, farbe="#1F5BAA")
    assert neu["fett"] and neu["groesse"] == 12 and neu["farbe"] == "#1F5BAA"


def test_leeren_und_fehler():
    doc = brief()
    z = zeile_mit(doc, "Zweite")
    assert tb.text_ersetzen(doc, 0, z["bbox"], "") == {}
    assert "Zweite" not in doc[0].get_text()
    with pytest.raises(DokumentFehler):
        tb.text_ersetzen(doc, 0, z["bbox"], "x")  # Zeile gibt es nicht mehr
    with pytest.raises(DokumentFehler):
        tb.text_ersetzen(doc, 0, zeile_mit(doc, "Senkrecht")["bbox"], "x")


def test_api_mit_rueckgaengig(tmp_path):
    brief().save(tmp_path / "b.pdf")
    c = TestClient(erstelle_app("t", benutzer=BenutzerSpeicher(tmp_path / "pc")))
    c.headers.update({"X-Agentur-Token": "t"})
    d = c.post("/api/dokumente/oeffnen", json={"pfad": str(tmp_path / "b.pdf")}).json()["id"]
    z = next(x for x in c.get(f"/api/dokumente/{d}/seiten/0/textzeilen").json() if "Jahresprämie" in x["text"])
    r = c.post(f"/api/dokumente/{d}/seiten/0/text_ersetzen", json={"bbox": z["bbox"], "neu": "Beitrag: 99,00 €"})
    assert r.status_code == 200 and r.json()["zeile"]["text"] == "Beitrag: 99,00 €"
    assert r.json()["dokumente"][0]["rueckgaengig"] == "Text bearbeiten"
    c.post(f"/api/dokumente/{d}/rueckgaengig")
    texte = [x["text"] for x in c.get(f"/api/dokumente/{d}/seiten/0/textzeilen").json()]
    assert any("1.200,00" in t for t in texte)
