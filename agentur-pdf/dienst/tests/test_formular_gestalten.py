"""Formularfelder anlegen, ändern, löschen (auch auf gedrehten Seiten)."""

from __future__ import annotations

import pymupdf
import pytest
from fastapi.testclient import TestClient

from agentur_pdf.api.app import erstelle_app
from agentur_pdf.benutzer.speicher import BenutzerSpeicher
from agentur_pdf.kern import formulare
from agentur_pdf.kern.dokumente import DokumentFehler


@pytest.fixture
def c(tmp_path):
    c = TestClient(erstelle_app("t", benutzer=BenutzerSpeicher(tmp_path / "pc")))
    c.headers.update({"X-Agentur-Token": "t"})
    doc = pymupdf.open()
    doc.new_page().insert_text((72, 90), "Antrag", fontsize=14)
    gedreht = doc.new_page()
    gedreht.set_rotation(90)
    doc.save(tmp_path / "leer.pdf")
    c.dok = c.post("/api/dokumente/oeffnen", json={"pfad": str(tmp_path / "leer.pdf")}).json()["id"]
    return c


def test_anlegen_ausfuellen_aendern_loeschen(c, tmp_path):
    d = c.dok
    r = c.post(f"/api/dokumente/{d}/formular", json={"seite": 0, "typ": "text", "rechteck": [0.2, 0.2, 0.6, 0.24], "name": "Name", "pflicht": True})
    assert r.status_code == 200, r.text
    name_id = r.json()["id"]
    k = c.post(f"/api/dokumente/{d}/formular", json={"seite": 0, "typ": "ankreuzen", "rechteck": [0.2, 0.3, 0.23, 0.32]}).json()["id"]
    a = c.post(
        f"/api/dokumente/{d}/formular",
        json={"seite": 0, "typ": "auswahlliste", "rechteck": [0.2, 0.4, 0.5, 0.43], "optionen": ["Kfz", "Hausrat", "Haftpflicht"]},
    ).json()["id"]
    felder = c.get(f"/api/dokumente/{d}/formular").json()["0"]
    nach_id = {f["id"]: f for f in felder}
    assert nach_id[name_id]["name"] == "Name" and nach_id[name_id]["pflicht"] and nach_id[name_id]["typ"] == "text"
    assert nach_id[k]["typ"] == "ankreuzen" and nach_id[k]["name"] == "Kontrollkästchen"
    assert nach_id[a]["optionen"] == ["Kfz", "Hausrat", "Haftpflicht"] and nach_id[a]["wert"] == "Kfz"
    assert abs(nach_id[name_id]["rechteck"][0] - 0.2) < 0.002

    # ausfüllen wie bisher
    c.put(f"/api/dokumente/{d}/formular/{name_id}", json={"seite": 0, "wert": "Erika Musterfrau"})
    # verschieben, umbenennen, mehrzeilig – xref bleibt
    r = c.patch(f"/api/dokumente/{d}/formular/{name_id}", json={"seite": 0, "rechteck": [0.3, 0.5, 0.8, 0.6], "name": "Vollständiger Name", "mehrzeilig": True})
    assert r.status_code == 200 and r.json()["id"] == name_id
    f = {x["id"]: x for x in c.get(f"/api/dokumente/{d}/formular").json()["0"]}[name_id]
    assert f["name"] == "Vollständiger Name" and f["mehrzeilig"] and f["wert"] == "Erika Musterfrau"
    assert abs(f["rechteck"][1] - 0.5) < 0.002
    # doppelter Name abgelehnt
    assert c.patch(f"/api/dokumente/{d}/formular/{k}", json={"seite": 0, "name": "Vollständiger Name"}).status_code == 400
    # löschen + rückgängig
    assert c.delete(f"/api/dokumente/{d}/formular/{k}?seite=0").status_code == 200
    assert k not in {x["id"] for x in c.get(f"/api/dokumente/{d}/formular").json()["0"]}
    c.post(f"/api/dokumente/{d}/rueckgaengig")
    assert k in {x["id"] for x in c.get(f"/api/dokumente/{d}/formular").json()["0"]}

    # gespeicherte Datei ist ein echtes Formular
    c.post(f"/api/dokumente/{d}/speichern", json={"pfad": str(tmp_path / "antrag.pdf")})
    fertig = pymupdf.open(tmp_path / "antrag.pdf")
    assert fertig.is_form_pdf
    assert {w.field_name for w in fertig[0].widgets()} == {"Vollständiger Name", "Kontrollkästchen", "Auswahl"}


def test_gedrehte_seite_und_fehler(c):
    d = c.dok
    r = c.post(f"/api/dokumente/{d}/formular", json={"seite": 1, "typ": "text", "rechteck": [0.1, 0.1, 0.5, 0.15]}).json()
    f = c.get(f"/api/dokumente/{d}/formular").json()["1"][0]
    assert f["id"] == r["id"]
    for soll, ist in zip([0.1, 0.1, 0.5, 0.15], f["rechteck"]):
        assert abs(soll - ist) < 0.003
    assert c.post(f"/api/dokumente/{d}/formular", json={"seite": 0, "typ": "zauber", "rechteck": [0, 0, 0.1, 0.1]}).status_code == 400
    assert c.post(f"/api/dokumente/{d}/formular", json={"seite": 0, "typ": "text", "rechteck": [0.1, 0.1, 0.1005, 0.1005]}).status_code == 400


def test_freie_namen():
    doc = pymupdf.open()
    doc.new_page()
    for _ in range(3):
        formulare.feld_anlegen(doc, 0, {"typ": "text", "rechteck": [0.1, 0.1, 0.3, 0.13]})
    assert sorted(w.field_name for w in doc[0].widgets()) == ["Textfeld", "Textfeld 2", "Textfeld 3"]
    with pytest.raises(DokumentFehler):
        formulare.feld_loeschen(doc, 0, 99999)
