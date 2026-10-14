"""Screenshot-Werkzeug: Ablage mit Texterkennung, Tastenkürzel-Erkennung."""

from __future__ import annotations

import io
import re
from pathlib import Path

import pymupdf
import pytest
from PIL import Image, ImageDraw, ImageFont

from agentur_pdf.kern import ocr, screenshot
from agentur_pdf.kern.konvertierung import direkt
from agentur_pdf.windows.screenshot import TastenFehler, taste_parsen


def bildschirmfoto() -> bytes:
    """Kleines „WhatsApp“-artiges Bildschirmfoto mit Text (96 dpi)."""
    im = Image.new("RGB", (640, 200), (236, 229, 221))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([20, 30, 600, 170], radius=12, fill=(220, 248, 198))
    schrift = None
    for kandidat in ("DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "arial.ttf"):
        try:
            schrift = ImageFont.truetype(kandidat, 22)
            break
        except OSError:
            continue
    d.text((40, 50), "Hallo, anbei die Prämie für 2027.", fill=(20, 20, 20), font=schrift)
    d.text((40, 100), "Versicherungsschein folgt per Post.", fill=(20, 20, 20), font=schrift)
    puffer = io.BytesIO()
    im.save(puffer, "PNG")
    return puffer.getvalue()


def test_dateiname():
    from datetime import datetime

    assert screenshot.dateiname("JK", datetime(2026, 10, 14, 9, 5, 3)) == "2026-10-14_09-05-03_JK.png"
    assert screenshot.dateiname("", datetime(2026, 1, 2, 3, 4, 5)) == "2026-01-02_03-04-05.png"
    assert screenshot.dateiname("J/K") .endswith("_JK.png")


@pytest.mark.skipif(ocr.tesseract_finden() is None, reason="Tesseract fehlt")
def test_screenshot_ablage_mit_ocr(tmp_path):
    ergebnis = screenshot.verarbeiten(bildschirmfoto(), str(tmp_path), "JK", True, direkt)
    png, pdf = Path(ergebnis["png"]), Path(ergebnis["pdf"])
    assert png.is_file() and pdf.is_file() and pdf.stem == png.stem
    assert re.fullmatch(r"\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d_JK", png.stem)
    assert "Prämie" in ergebnis["text"] and "Versicherungsschein" in ergebnis["text"]
    doc = pymupdf.open(pdf)
    assert "Prämie" in doc[0].get_text()
    doc.close()
    # zweiter Screenshot in derselben Sekunde bekommt eigenen Namen
    zweiter = screenshot.verarbeiten(bildschirmfoto(), str(tmp_path), "JK", False, direkt)
    assert zweiter["png"] != ergebnis["png"] and zweiter["pdf"] is None


def test_screenshot_ueber_api(client, tmp_path):
    client.put("/api/einstellungen", json={"screenshot_ordner": str(tmp_path / "shots"), "screenshot_ocr": False})
    r = client.post("/api/screenshot/verarbeiten", content=bildschirmfoto()).json()
    assert Path(r["png"]).parent == tmp_path / "shots"
    ereignisse = client.get("/api/ereignisse").json()["ereignisse"]
    assert any(e["art"] == "screenshot" and e["png"] == r["png"] for e in ereignisse)
    status = client.get("/api/screenshot/status").json()
    assert status["ordner"] == str(tmp_path / "shots") and status["taste"] == "Strg+Umschalt+Druck"


def test_tastenkuerzel():
    assert taste_parsen("Strg+Umschalt+Druck") == (0x2 | 0x4, 0x2C)
    assert taste_parsen("Strg + Alt + S") == (0x2 | 0x1, ord("S"))
    assert taste_parsen("Druck") == (0, 0x2C)
    assert taste_parsen("Umschalt+F9") == (0x4, 0x78)
    for falsch in ("", "Strg+Blub", "X", "Hyper+S"):
        with pytest.raises(TastenFehler):
            taste_parsen(falsch)


def test_ungueltiges_tastenkuerzel_wird_abgelehnt(client):
    r = client.put("/api/einstellungen", json={"screenshot_taste": "Strg+Quatsch"})
    assert r.status_code == 400 and "Unbekannte Taste" in r.json()["fehler"]
