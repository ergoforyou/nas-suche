"""Design: Freistellen, Anordnen, Briefpapier, Deckblatt, Inhaltsverzeichnis."""

from __future__ import annotations

import io

import numpy as np
import pymupdf
import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from agentur_pdf.api.app import erstelle_app
from agentur_pdf.benutzer.speicher import BenutzerSpeicher
from agentur_pdf.kern import design


def foto_mit_motiv() -> bytes:
    """Unruhiger, verlaufender Hintergrund mit rotem Kreis als Motiv."""
    rng = np.random.default_rng(1)
    h, b = 300, 400
    verlauf = np.linspace(80, 200, b)[None, :, None].repeat(h, 0).repeat(3, 2)
    hg = np.clip(verlauf + rng.normal(0, 12, (h, b, 3)), 0, 255).astype(np.uint8)
    hg[:, :, 2] = np.clip(hg[:, :, 2] * 0.6 + 60, 0, 255)  # bläulich-grauer Grund
    im = Image.fromarray(hg)
    ImageDraw.Draw(im).ellipse((140, 80, 260, 220), fill=(210, 30, 40))
    puffer = io.BytesIO()
    im.save(puffer, "PNG")
    return puffer.getvalue()


def test_motiv_freistellen():
    png, zuschnitt = design.freistellen_motiv(foto_mit_motiv())
    im = Image.open(io.BytesIO(png))
    assert im.mode == "RGBA"
    # Zuschnitt umfasst den Kreis (140..260 / 400, 80..220 / 300)
    assert abs(zuschnitt[0] - 140 / 400) < 0.04 and abs(zuschnitt[2] - 260 / 400) < 0.04
    assert abs(zuschnitt[1] - 80 / 300) < 0.05 and abs(zuschnitt[3] - 220 / 300) < 0.05
    a = np.asarray(im.getchannel("A"))
    assert a[a.shape[0] // 2, a.shape[1] // 2] > 240  # Mitte deckend
    assert a[2, 2] < 30  # Ecke (Hintergrund) durchsichtig


def test_logo_auf_weiss():
    im = Image.new("RGB", (300, 200), "white")
    ImageDraw.Draw(im).rectangle((100, 60, 200, 140), fill=(20, 60, 160))
    puffer = io.BytesIO()
    im.save(puffer, "PNG")
    png, zuschnitt = design.freistellen_weiss(puffer.getvalue())
    assert abs(zuschnitt[0] - 1 / 3) < 0.03 and abs(zuschnitt[2] - 2 / 3) < 0.03


@pytest.fixture
def c(tmp_path):
    c = TestClient(erstelle_app("t", benutzer=BenutzerSpeicher(tmp_path / "pc")))
    c.headers.update({"X-Agentur-Token": "t"})
    doc = pymupdf.open()
    s = doc.new_page()
    s.insert_text((72, 80), "Angebot Hausrat", fontsize=16)
    s.insert_image(pymupdf.Rect(150, 200, 450, 425), stream=foto_mit_motiv())
    doc.new_page().insert_text((72, 80), "Leistungen", fontsize=14)
    doc.set_toc([[1, "Angebot", 1], [1, "Leistungen", 2]])
    doc.save(tmp_path / "angebot.pdf")
    c.dok = c.post("/api/dokumente/oeffnen", json={"pfad": str(tmp_path / "angebot.pdf")}).json()["id"]
    return c


def test_freistellen_einsetzen_anordnen(c):
    d = c.dok
    b, h = 595, 842
    bereich = [150 / b, 200 / h, 450 / b, 425 / h]
    v = c.post(f"/api/dokumente/{d}/freistellen", json={"seite": 0, "rechteck": bereich, "modus": "motiv"}).json()
    assert v["bild"].startswith("data:image/png")
    r = v["rechteck"]
    # Kreis liegt mittig im Bild → eingesetztes Rechteck deutlich kleiner als der Bereich
    assert r[0] > bereich[0] + 0.05 and r[2] < bereich[2] - 0.05
    e = c.post(f"/api/dokumente/{d}/freistellen/einsetzen", json={"seite": 0, "bild_id": v["bild_id"], "rechteck": r, "abdecken": bereich}).json()
    bild = e["id"]
    assert e["dokumente"][0]["rueckgaengig"] == "Objekt freistellen"
    # zweites Element zum Sortieren
    c.post(f"/api/dokumente/{d}/anmerkungen", json={"seite": 0, "art": "rechteck", "rechteck": [0.1, 0.1, 0.3, 0.2]})

    def ids():
        return [a["id"] for a in c.get(f"/api/dokumente/{d}/anmerkungen").json()["0"]]

    assert ids()[0] == bild
    c.post(f"/api/dokumente/{d}/anmerkungen/{bild}/ebene", json={"seite": 0, "richtung": "ganz_vorne"})
    assert ids()[-1] == bild
    c.post(f"/api/dokumente/{d}/anmerkungen/{bild}/ebene", json={"seite": 0, "richtung": "hinten"})
    assert ids()[0] == bild

    vorher = next(a for a in c.get(f"/api/dokumente/{d}/anmerkungen").json()["0"] if a["id"] == bild)["rechteck"]
    gedreht = c.post(f"/api/dokumente/{d}/anmerkungen/{bild}/umformen", json={"seite": 0, "aktion": "rechts"}).json()["id"]
    neu = {a["id"]: a for a in c.get(f"/api/dokumente/{d}/anmerkungen").json()["0"]}
    assert bild not in neu and gedreht in neu
    rr = neu[gedreht]["rechteck"]
    # Breite/Höhe (in pt) getauscht, Reihenfolge erhalten (weiter hinten)
    assert abs((rr[2] - rr[0]) * b - (vorher[3] - vorher[1]) * h) < 2
    assert ids()[0] == gedreht
    dup = c.post(f"/api/dokumente/{d}/anmerkungen/{gedreht}/umformen", json={"seite": 0, "aktion": "duplizieren"}).json()["id"]
    assert len(ids()) == 3 and dup in ids()
    c.post(f"/api/dokumente/{d}/anmerkungen/{dup}/umformen", json={"seite": 0, "aktion": "waagerecht"})
    # Rechteck lässt sich nicht drehen
    rechteck_id = next(a["id"] for a in c.get(f"/api/dokumente/{d}/anmerkungen").json()["0"] if a["art"] == "rechteck")
    assert c.post(f"/api/dokumente/{d}/anmerkungen/{rechteck_id}/umformen", json={"seite": 0, "aktion": "rechts"}).status_code == 400


def test_briefpapier(c, tmp_path):
    vorlage = pymupdf.open()
    erste = vorlage.new_page()
    erste.draw_rect(pymupdf.Rect(0, 0, 595, 70), fill=(0.7, 0.05, 0.1), color=None)
    erste.insert_text((40, 45), "AGENTUR KOPF", fontsize=20, color=(1, 1, 1))
    folge = vorlage.new_page()
    folge.insert_text((40, 820), "Folgeseite Fuß", fontsize=8)
    r = c.post("/api/briefpapier?name=Agentur Briefbogen", content=vorlage.tobytes()).json()
    assert r == {"name": "Agentur Briefbogen.pdf", "seiten": 2}
    assert [x["name"] for x in c.get("/api/briefpapier").json()] == ["Agentur Briefbogen.pdf"]
    assert c.get("/api/briefpapier/Agentur Briefbogen.pdf/vorschau").headers["content-type"] == "image/png"
    a = c.post(f"/api/dokumente/{c.dok}/briefpapier", json={"name": "Agentur Briefbogen.pdf"}).json()
    assert a["anzahl"] == 2
    c.post(f"/api/dokumente/{c.dok}/speichern", json={"pfad": str(tmp_path / "mit.pdf")})
    doc = pymupdf.open(tmp_path / "mit.pdf")
    assert "AGENTUR KOPF" in doc[0].get_text() and "Folgeseite" not in doc[0].get_text()
    assert "Folgeseite Fuß" in doc[1].get_text() and "AGENTUR KOPF" not in doc[1].get_text()
    # liegt hinter dem Inhalt und auf eigener Ebene
    assert any(e["name"] == "Briefpapier" for e in doc.get_ocgs().values())
    assert c.post(f"/api/dokumente/{c.dok}/briefpapier", json={"name": "../x.pdf"}).status_code == 400
    c.delete("/api/briefpapier/Agentur Briefbogen.pdf")
    assert c.get("/api/briefpapier").json() == []


def test_briefpapier_gedrehte_seite():
    vorlage = pymupdf.open()
    vorlage.new_page().draw_rect(pymupdf.Rect(0, 0, 595, 60), fill=(0, 0, 1), color=None)
    doc = pymupdf.open()
    s = doc.new_page(width=842, height=595)
    s.set_rotation(90)  # wird hochkant angezeigt
    design.briefpapier(doc, vorlage.tobytes())
    pix = s.get_pixmap(dpi=20)
    a = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, 3)
    blau = np.argwhere((a[:, :, 2] > 200) & (a[:, :, 0] < 50))
    assert blau[:, 0].max() < pix.height * 0.1  # Band oben in der Anzeige
    assert blau[:, 1].max() - blau[:, 1].min() > pix.width * 0.9  # über die ganze Breite


def test_deckblatt_und_verzeichnis(c, tmp_path):
    d = c.dok
    logo = c.post("/api/bilder", content=foto_mit_motiv()).json()["id"]
    for layout in ("band", "seitenleiste", "zentriert"):
        r = c.post(f"/api/dokumente/{d}/deckblatt", json={"titel": "Ihr Versicherungsangebot", "untertitel": "Hausrat & Haftpflicht", "kunde": "Familie Muster", "layout": layout, "logo_id": logo}).json()
        assert r["dokumente"][0]["seitenanzahl"] >= 3
        c.post(f"/api/dokumente/{d}/rueckgaengig")
    c.post(f"/api/dokumente/{d}/deckblatt", json={"titel": "Ihr Versicherungsangebot", "kunde": "Familie Muster"})
    v = c.post(f"/api/dokumente/{d}/inhaltsverzeichnis", json={"position": 1}).json()
    assert v["anzahl"] == 3 and v["dokumente"][0]["seitenanzahl"] == 4
    c.post(f"/api/dokumente/{d}/speichern", json={"pfad": str(tmp_path / "mappe.pdf")})
    doc = pymupdf.open(tmp_path / "mappe.pdf")
    assert "Ihr Versicherungsangebot" in doc[0].get_text() and "Familie Muster" in doc[0].get_text()
    inhalt = doc[1].get_text()
    assert "Inhalt" in inhalt and "Leistungen" in inhalt
    # Link „Leistungen“ führt auf die richtige Seite (Deckblatt + Verzeichnis davor → Seite 4)
    ziele = sorted(l["page"] for l in doc[1].get_links())
    assert ziele == [0, 2, 3]
    assert "Leistungen" in doc[3].get_text()
    assert [t[1:] for t in doc.get_toc()] == [["Ihr Versicherungsangebot", 1], ["Angebot", 3], ["Leistungen", 4]]
    assert c.post(f"/api/dokumente/{d}/deckblatt", json={"titel": ""}).status_code == 400
