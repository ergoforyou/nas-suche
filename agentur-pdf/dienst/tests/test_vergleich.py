"""Dokumente vergleichen."""

from __future__ import annotations

import pymupdf
from fastapi.testclient import TestClient

from agentur_pdf.api.app import erstelle_app
from agentur_pdf.benutzer.speicher import BenutzerSpeicher
from agentur_pdf.kern import vergleich as v


def vertrag(pfad, praemie="1.200,00 €", zusatz=True, entfernt=False, gedreht=False):
    doc = pymupdf.open()
    s = doc.new_page()
    zeilen = [
        "Versicherungsvertrag Nr. 4711",
        f"Die Jahresprämie beträgt {praemie} und ist jährlich fällig.",
        "Der Vertrag beginnt am 01.01.2027.",
    ]
    if not entfernt:
        zeilen.append("Selbstbeteiligung: 150 € je Schadenfall.")
    if zusatz:
        zeilen.append("Glasbruch ist mitversichert.")
    for i, z in enumerate(zeilen):
        s.insert_text((72, 100 + i * 24), z, fontsize=11)
    if gedreht:
        s.set_rotation(90)
    # zweite Seite: Scan ohne Text (Bild)
    s2 = doc.new_page()
    s2.draw_rect(pymupdf.Rect(100, 100, 300, 200), color=(0, 0, 0), fill=(0, 0, 0) if praemie == "1.200,00 €" else (0.6, 0.6, 0.6))
    doc.save(pfad)
    return pfad


def test_wortgenauer_vergleich(tmp_path):
    alt = pymupdf.open(vertrag(tmp_path / "alt.pdf"))
    neu = pymupdf.open(vertrag(tmp_path / "neu.pdf", praemie="1.250,00 €", zusatz=False, entfernt=True))
    aenderungen = v.vergleichen(v.woerter_lesen(alt), v.woerter_lesen(neu))
    arten = [(a["art"], a["alt"], a["neu"]) for a in aenderungen]
    assert ("geaendert", "1.200,00", "1.250,00") in arten
    assert any(art == "entfernt" and "Selbstbeteiligung" in t for art, t, _ in arten)
    assert any(art == "entfernt" and "Glasbruch" in t for art, t, _ in arten)
    preis = next(a for a in aenderungen if a["alt"] == "1.200,00")
    assert preis["seite_a"] == 0 and preis["seite_b"] == 0
    r = preis["a"][0]["rechteck"]
    assert 0.2 < r[0] < 0.7 and r[2] - r[0] < 0.2  # nur das Wort, nicht die ganze Zeile
    # entfernte Zeile: in B nur eine schmale Einfügestelle
    weg = next(a for a in aenderungen if "Selbstbeteiligung" in a["alt"])
    assert weg["b"] and weg["b"][0].get("stelle")


def test_gleiche_dokumente():
    a = pymupdf.open()
    a.new_page().insert_text((72, 72), "Gleich")
    assert v.vergleichen(v.woerter_lesen(a), v.woerter_lesen(a)) == []


def test_vergleich_api_mit_bildseite(tmp_path):
    c = TestClient(erstelle_app("t", benutzer=BenutzerSpeicher(tmp_path / "pc")))
    c.headers.update({"X-Agentur-Token": "t"})
    a = c.post("/api/dokumente/oeffnen", json={"pfad": str(vertrag(tmp_path / "alt.pdf"))}).json()["id"]
    b = c.post("/api/dokumente/oeffnen", json={"pfad": str(vertrag(tmp_path / "neu.pdf", praemie="1.250,00 €"))}).json()["id"]
    r = c.post("/api/vergleich", json={"a": a, "b": b}).json()
    arten = [x["art"] for x in r["aenderungen"]]
    assert arten == ["geaendert", "bild"]
    bild = r["aenderungen"][1]
    assert bild["seite_a"] == 1
    x0, y0, x1, y1 = bild["a"][0]["rechteck"]
    assert abs(x0 - 100 / 595) < 0.02 and abs(x1 - 300 / 595) < 0.02
    assert c.post("/api/vergleich", json={"a": a, "b": a}).status_code == 400


def test_gedrehte_seite(tmp_path):
    alt = pymupdf.open(vertrag(tmp_path / "alt.pdf", gedreht=True))
    neu = pymupdf.open(vertrag(tmp_path / "neu.pdf", praemie="1.250,00 €", gedreht=True))
    preis = next(a for a in v.vergleichen(v.woerter_lesen(alt), v.woerter_lesen(neu)) if a["art"] == "geaendert")
    x0, y0, x1, y1 = preis["a"][0]["rechteck"]
    # Seite um 90° gedreht: Zeile läuft jetzt senkrecht → Rechteck schmal und hoch
    assert (x1 - x0) < (y1 - y0)
