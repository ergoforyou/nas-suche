"""PDF-Drucker: Ausdrucke im Druckordner werden als Dokument geöffnet."""

from __future__ import annotations

import pymupdf
from fastapi.testclient import TestClient

from agentur_pdf.api.app import erstelle_app
from agentur_pdf.benutzer.speicher import BenutzerSpeicher
from agentur_pdf.kern.druckordner import Druckordner


def pdf_bytes(text="Ausdruck aus Word"):
    doc = pymupdf.open()
    doc.new_page().insert_text((72, 72), text)
    return doc.tobytes()


def test_erst_wenn_fertig_geschrieben(tmp_path):
    erhalten = []
    w = Druckordner(lambda: tmp_path, lambda d, t: erhalten.append((d, t)))
    datei = tmp_path / "Ausdruck.pdf"
    datei.write_bytes(pdf_bytes()[:50])  # Druck läuft noch
    assert w.durchgang() == 0
    datei.write_bytes(pdf_bytes())  # weiter geschrieben → Größe ändert sich
    assert w.durchgang() == 0
    assert w.durchgang() == 1  # unverändert → übernehmen
    assert not datei.exists()
    daten, titel = erhalten[0]
    assert daten.startswith(b"%PDF") and titel.startswith("Ausdruck ")
    assert w.durchgang() == 0


def test_fehlender_ordner_und_keine_pdf(tmp_path):
    w = Druckordner(lambda: tmp_path / "fehlt", lambda *_: None)
    assert w.durchgang() == 0
    (tmp_path / "x.pdf").write_bytes(b"kein pdf")
    w2 = Druckordner(lambda: tmp_path, lambda *_: (_ for _ in ()).throw(AssertionError("nicht übergeben")))
    w2.durchgang()
    w2.durchgang()


def test_ausdruck_oeffnet_dokument(tmp_path):
    druck = tmp_path / "Druck"
    druck.mkdir()
    benutzer = BenutzerSpeicher(tmp_path / "pc")
    benutzer.einstellungen_setzen({"druck_ordner": str(druck)})
    c = TestClient(erstelle_app("t", benutzer=benutzer))
    c.headers.update({"X-Agentur-Token": "t"})
    (druck / "Ausdruck.pdf").write_bytes(pdf_bytes())
    w = c.app.state.druckordner
    w.durchgang()
    assert w.durchgang() == 1
    ereignisse = c.get("/api/ereignisse").json()["ereignisse"]
    neu = [e for e in ereignisse if e["art"] == "oeffnen"]
    assert neu
    info = c.get(f"/api/dokumente/{neu[0]['dokumente'][0]}").json()
    assert info["titel"].startswith("Ausdruck") and info["geaendert"] and info["seitenanzahl"] == 1
    status = c.get("/api/system/drucker").json()
    assert status["ordner"] == str(druck) and status["eingerichtet"] is False
