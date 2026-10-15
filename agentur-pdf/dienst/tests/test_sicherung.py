"""Automatische Sicherung/Wiederherstellung und Sperrhinweis für NAS-Dateien."""

from __future__ import annotations

import json
import os
import time

import pymupdf
import pytest
from fastapi.testclient import TestClient

from agentur_pdf.api.app import erstelle_app
from agentur_pdf.benutzer.speicher import BenutzerSpeicher
from agentur_pdf.kern import sperren as sperren_modul
from agentur_pdf.kern.sperren import Sperren, sperr_pfad

H = {"X-Agentur-Token": "t"}


def pdf(pfad, text="Hallo"):
    doc = pymupdf.open()
    for i in range(2):
        doc.new_page().insert_text((72, 72), f"{text} {i + 1}")
    doc.save(pfad)
    return pfad


def client(tmp_path, name="a"):
    benutzer = BenutzerSpeicher(tmp_path / f"daten-{name}")
    c = TestClient(erstelle_app("t", benutzer=benutzer))
    c.headers.update(H)
    return c


def test_sicherung_und_wiederherstellung(tmp_path):
    datei = pdf(tmp_path / "brief.pdf")
    c = client(tmp_path)
    dok = c.post("/api/dokumente/oeffnen", json={"pfad": str(datei)}).json()
    # ungeändert → keine Sicherung
    import anyio

    anyio.run(c.app.state.wartung)
    assert not list((tmp_path / "daten-a" / "wiederherstellung").glob("*.pdf"))
    # ändern → Sicherung
    assert c.post(f"/api/dokumente/{dok['id']}/seiten/loeschen", json={"seiten": [0]}).status_code == 200
    anyio.run(c.app.state.wartung)
    gesichert = list((tmp_path / "daten-a" / "wiederherstellung").glob("*.pdf"))
    assert len(gesichert) == 1
    # im selben Lauf nicht als „Wiederherstellung“ angeboten
    assert c.get("/api/wiederherstellung").json() == []

    # „Absturz“: neuer Programmlauf (andere PID in der Sicherung)
    meta_datei = gesichert[0].with_suffix(".json")
    meta = json.loads(meta_datei.read_text(encoding="utf-8"))
    meta["pid"] = -1
    meta_datei.write_text(json.dumps(meta), encoding="utf-8")
    liste = c.get("/api/wiederherstellung").json()
    assert len(liste) == 1 and liste[0]["titel"] == "brief.pdf" and liste[0]["seiten"] == 1
    info = c.post(f"/api/wiederherstellung/{liste[0]['schluessel']}").json()
    assert info["seitenanzahl"] == 1 and info["geaendert"] and info["pfad"] == str(datei)
    assert c.get("/api/wiederherstellung").json() == []
    # speichern entfernt die Sicherung des wiederhergestellten Dokuments
    anyio.run(c.app.state.wartung)
    assert c.post(f"/api/dokumente/{info['id']}/speichern", json={}).status_code == 200
    assert pymupdf.open(datei).page_count == 1


def test_verwerfen_und_ungueltig(tmp_path):
    c = client(tmp_path)
    ordner = tmp_path / "daten-a" / "wiederherstellung"
    (ordner / "1-abc.pdf").write_bytes(b"%PDF-1.4")
    (ordner / "1-abc.json").write_text(json.dumps({"pid": 1, "titel": "x.pdf", "zeit": "2026-01-01T10:00:00"}))
    assert len(c.get("/api/wiederherstellung").json()) == 1
    assert c.delete("/api/wiederherstellung/1-abc").status_code == 200
    assert c.get("/api/wiederherstellung").json() == []
    assert c.delete("/api/wiederherstellung/..%2Fx").status_code in (400, 404)


def test_sperre_fremd_und_eigen(tmp_path, monkeypatch):
    datei = pdf(tmp_path / "gemeinsam.pdf")
    martina = Sperren("MW")
    martina.ich.update({"benutzer": "martina", "rechner": "PC-02"})
    assert martina.holen(str(datei)) is None
    assert sperr_pfad(datei).exists()

    c = client(tmp_path)
    info = c.post("/api/dokumente/oeffnen", json={"pfad": str(datei)}).json()
    assert info["gesperrt_von"]["benutzer"] == "martina" and info["gesperrt_von"]["rechner"] == "PC-02"
    c.post(f"/api/dokumente/{info['id']}/seiten/loeschen", json={"seiten": [0]})
    r = c.post(f"/api/dokumente/{info['id']}/speichern", json={})
    assert r.status_code == 400 and r.json()["fehler"].startswith("GESPERRT|martina|PC-02")
    assert pymupdf.open(datei).page_count == 2
    # „Speichern unter“ geht
    kopie = tmp_path / "kopie.pdf"
    assert c.post(f"/api/dokumente/{info['id']}/speichern", json={"pfad": str(kopie)}).status_code == 200
    assert sperr_pfad(kopie).exists()

    # Martina schließt → Datei wird frei, Wartung meldet es
    info2 = c.post("/api/dokumente/oeffnen", json={"pfad": str(datei)}).json()
    assert info2["gesperrt_von"]
    martina.freigeben(str(datei))
    assert not sperr_pfad(datei).exists()
    import anyio

    anyio.run(c.app.state.wartung)
    assert c.get(f"/api/dokumente/{info2['id']}").json()["gesperrt_von"] is None
    assert sperr_pfad(datei).exists()  # jetzt meine Sperre
    assert any(e["art"] == "sperre_frei" for e in c.get("/api/ereignisse").json()["ereignisse"])
    # Schließen gibt meine Sperre frei
    c.delete(f"/api/dokumente/{info2['id']}")
    assert not sperr_pfad(datei).exists()


def test_verwaiste_sperre_und_erzwingen(tmp_path, monkeypatch):
    datei = pdf(tmp_path / "alt.pdf")
    fremd = Sperren()
    fremd.ich.update({"benutzer": "peter", "rechner": "PC-05"})
    fremd.holen(str(datei))
    alt = time.time() - sperren_modul.VERALTET_S - 5
    os.utime(sperr_pfad(datei), (alt, alt))
    c = client(tmp_path)
    info = c.post("/api/dokumente/oeffnen", json={"pfad": str(datei)}).json()
    assert info["gesperrt_von"] is None  # verwaist → übernommen

    # Datei wird von außen überschrieben → Rückfrage
    c.post(f"/api/dokumente/{info['id']}/seiten/loeschen", json={"seiten": [0]})
    time.sleep(0.01)
    pdf(datei, text="Neu von außen")
    r = c.post(f"/api/dokumente/{info['id']}/speichern", json={})
    assert r.status_code == 400 and r.json()["fehler"] == "EXTERN_GEAENDERT"
    assert c.post(f"/api/dokumente/{info['id']}/speichern", json={"erzwingen": True}).status_code == 200
    assert pymupdf.open(datei).page_count == 1


def test_aufraeumen_gibt_sperren_frei(tmp_path):
    datei = pdf(tmp_path / "x.pdf")
    c = client(tmp_path)
    c.post("/api/dokumente/oeffnen", json={"pfad": str(datei)})
    assert sperr_pfad(datei).exists()
    c.app.state.aufraeumen()
    assert not sperr_pfad(datei).exists()
