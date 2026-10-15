"""Gemeinsame Einstellungen aller Arbeitsplätze im NAS-Ordner."""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from agentur_pdf.api.app import erstelle_app
from agentur_pdf.benutzer.speicher import BenutzerSpeicher


def arbeitsplatz(tmp_path, name):
    c = TestClient(erstelle_app("t", benutzer=BenutzerSpeicher(tmp_path / name)))
    c.headers.update({"X-Agentur-Token": "t"})
    return c


def test_stempel_und_favoriten_fuer_alle(tmp_path):
    nas = tmp_path / "nas" / "Agentur-PDF"
    pc1, pc2 = arbeitsplatz(tmp_path, "pc1"), arbeitsplatz(tmp_path, "pc2")
    # PC 1 hat eigene Stempel und Favoriten, richtet den NAS-Ordner ein → werden übernommen
    pc1.put("/api/einstellungen", json={"stempel": [{"text": "GEPRÜFT {kuerzel}", "farbe": "#123456"}], "kuerzel": "JB"})
    pc1.put("/api/favoriten", json=[str(tmp_path / "Kunden")])
    e = pc1.put("/api/einstellungen", json={"gemeinsamer_ordner": str(nas)}).json()
    assert e["gemeinsamer_ordner"] == str(nas)
    assert json.loads((nas / "einstellungen.json").read_text(encoding="utf-8"))["stempel"][0]["text"] == "GEPRÜFT {kuerzel}"

    # PC 2 trägt denselben Ordner ein → bekommt die Stempel von PC 1, behält sein Kürzel
    pc2.put("/api/einstellungen", json={"kuerzel": "MW"})
    e2 = pc2.put("/api/einstellungen", json={"gemeinsamer_ordner": str(nas)}).json()
    assert e2["stempel"][0]["text"] == "GEPRÜFT {kuerzel}" and e2["kuerzel"] == "MW"
    assert pc2.get("/api/favoriten").json() == [str(tmp_path / "Kunden")]

    # Änderung an einem PC gilt für alle (ohne Neustart)
    pc2.put("/api/einstellungen", json={"stempel": [{"text": "ERLEDIGT", "farbe": "#00AA00"}], "ocr_sprachen": "deu"})
    import agentur_pdf.benutzer.speicher as sp

    sp.GEMEINSAM_NEU_LESEN_S = 0
    try:
        e1 = pc1.get("/api/einstellungen").json()
    finally:
        sp.GEMEINSAM_NEU_LESEN_S = 20
    assert e1["stempel"][0]["text"] == "ERLEDIGT" and e1["ocr_sprachen"] == "deu" and e1["kuerzel"] == "JB"

    status = pc1.get("/api/gemeinsam").json()
    assert status["aktiv"] and status["erreichbar"] and "stempel" in status["schluessel"]


def test_nas_nicht_erreichbar_letzte_fassung(tmp_path):
    nas = tmp_path / "nas"
    pc = arbeitsplatz(tmp_path, "pc")
    pc.put("/api/einstellungen", json={"stempel": [{"text": "A", "farbe": "#000000"}]})
    pc.put("/api/einstellungen", json={"gemeinsamer_ordner": str(nas)})
    (nas / "einstellungen.json").write_text("{kaputt", encoding="utf-8")  # z. B. halb gelesen/NAS-Fehler
    import agentur_pdf.benutzer.speicher as sp

    sp.GEMEINSAM_NEU_LESEN_S = 0
    try:
        e = pc.get("/api/einstellungen").json()
        status = pc.get("/api/gemeinsam").json()
    finally:
        sp.GEMEINSAM_NEU_LESEN_S = 20
    assert e["stempel"][0]["text"] == "A"
    assert not status["erreichbar"] and "letzte bekannte Fassung" in status["fehler"]


def test_woerterbuch_gemeinsam(tmp_path):
    from agentur_pdf.kern.woerterbuch import Woerterbuch

    nas = tmp_path / "nas"
    nas.mkdir()
    a, b = Woerterbuch(), Woerterbuch()
    a.gemeinsam_setzen(nas)
    a.hinzufuegen("Kfz-Haftpflichtschadenmeldung")
    b.gemeinsam_setzen(nas)
    assert b.bekannt("Kfz-Haftpflichtschadenmeldung")
