"""Zur Unterschrift senden: Ergoforyou PDF ↔ Ergoforyou Sign (NAS-Dienst echt
gestartet, HubSpot nachgebaut)."""

from __future__ import annotations

import base64
import json
import socket
import sys
import threading
import time
from pathlib import Path

import httpx
import pymupdf
import pytest
import uvicorn
from fastapi.testclient import TestClient

from agentur_pdf.api.app import erstelle_app
from agentur_pdf.benutzer.speicher import BenutzerSpeicher
from agentur_pdf.kern import signatur
from agentur_pdf.kern.dokumente import DokumentFehler

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "signatur"))
from ergoforyou_sign.app import Dienst, intern_app, kunde_app  # noqa: E402


def _hubspot(request: httpx.Request) -> httpx.Response:
    if request.url.path == "/crm/v3/objects/contacts/search":
        return httpx.Response(200, json={"results": [{"id": "501", "properties": {"firstname": "Max", "lastname": "Muster", "email": "max@example.org"}}]})
    if request.url.path == "/crm/v3/objects/contacts/501":
        return httpx.Response(200, json={"id": "501", "properties": {"firstname": "Max", "lastname": "Muster", "email": "max@example.org"}})
    if request.url.path == "/crm/v4/objects/contacts/501/associations/deals":
        return httpx.Response(200, json={"results": []})
    return httpx.Response(201, json={"id": "1"})


@pytest.fixture
def nas(tmp_path):
    dienst = Dienst(tmp_path / "nas", httpx.MockTransport(_hubspot))
    dienst.konfig.setzen(oeffentliche_adresse="https://sign.example.org", hubspot_token="pat-eu1-test")
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(intern_app(dienst), host="127.0.0.1", port=port, log_level="error"))
    faden = threading.Thread(target=server.run, daemon=True)
    faden.start()
    while not server.started:
        time.sleep(0.02)
    code = "EFY-SIGN:" + base64.urlsafe_b64encode(f'{{"u": "http://127.0.0.1:{port}", "k": "{dienst.konfig.get("schluessel")}"}}'.encode()).decode().rstrip("=")
    yield dienst, code
    server.should_exit = True
    faden.join(5)


@pytest.fixture
def c(tmp_path):
    c = TestClient(erstelle_app("t", benutzer=BenutzerSpeicher(tmp_path / "pc")))
    c.headers.update({"X-Agentur-Token": "t"})
    doc = pymupdf.open()
    doc.new_page().insert_text((72, 90), "Maklervertrag Max Muster", fontsize=14)
    doc.new_page().insert_text((72, 90), "Seite 2", fontsize=14)
    doc.save(tmp_path / "vertrag.pdf")
    c.dok = c.post("/api/dokumente/oeffnen", json={"pfad": str(tmp_path / "vertrag.pdf")}).json()["id"]
    return c


def test_code_lesen():
    roh = base64.urlsafe_b64encode(b'{"u": "http://192.168.1.20:8481/", "k": "abcdefghijklmnopqrstuvwxyz"}').decode().rstrip("=")
    assert signatur.code_lesen(f"EFY-SIGN:{roh}\n") == {"url": "http://192.168.1.20:8481", "schluessel": "abcdefghijklmnopqrstuvwxyz", "urls": ["http://192.168.1.20:8481"]}
    mit = base64.urlsafe_b64encode(b'{"u": "http://192.168.1.20:8481", "k": "abcdefghijklmnopqrstuvwxyz", "a": ["https://ergoforyou-sign.tail1a2b.ts.net:8481/"]}').decode()
    assert signatur.code_lesen("EFY-SIGN:" + mit)["urls"] == ["http://192.168.1.20:8481", "https://ergoforyou-sign.tail1a2b.ts.net:8481"]
    for falsch in ("", "irgendwas", "EFY-SIGN:%%%", "EFY-SIGN:" + base64.urlsafe_b64encode(b'{"u": "ftp://x", "k": "kurz"}').decode()):
        with pytest.raises(DokumentFehler):
            signatur.code_lesen(falsch)


def test_unterschriftsfeld_anlegen_und_vorbereiten(c):
    d = c.dok
    r = c.post(f"/api/dokumente/{d}/formular", json={"seite": 1, "typ": "unterschrift", "rechteck": [0.1, 0.8, 0.45, 0.86]})
    assert r.status_code == 200, r.text
    feld = c.get(f"/api/dokumente/{d}/formular").json()["1"][0]
    assert feld["typ"] == "unterschrift" and feld["name"] == "Unterschrift Kunde"
    assert c.put(f"/api/dokumente/{d}/formular/{feld['id']}", json={"seite": 1, "wert": "x"}).status_code == 400
    c.post(f"/api/dokumente/{d}/formular", json={"seite": 0, "typ": "text", "rechteck": [0.1, 0.2, 0.5, 0.24], "name": "Tarif"})
    text_id = c.get(f"/api/dokumente/{d}/formular").json()["0"][0]["id"]
    c.put(f"/api/dokumente/{d}/formular/{text_id}", json={"seite": 0, "wert": "Hausrat Komfort"})
    assert c.get(f"/api/dokumente/{d}/signatur/felder").json() == {
        "felder": [{"seite": 1, "name": "Unterschrift Kunde", "rolle": "Kunde", "rechteck": [0.1, 0.8, 0.45, 0.86]}],
        "rollen": ["Kunde"],
    }



def test_vorbereiten_direkt():
    doc = pymupdf.open()
    seite = doc.new_page()
    from agentur_pdf.kern import formulare

    formulare.feld_anlegen(doc, 0, {"typ": "unterschrift", "rechteck": [0.1, 0.8, 0.45, 0.86]})
    t = formulare.feld_anlegen(doc, 0, {"typ": "text", "rechteck": [0.1, 0.2, 0.5, 0.24], "name": "Tarif"})
    formulare.feld_setzen(doc, 0, t, "Hausrat Komfort")
    pdf, felder = signatur.vorbereiten(doc)
    assert [f["art"] for f in felder] == ["unterschrift"] and felder[0]["seite"] == 0
    assert abs(felder[0]["rechteck"][0] - 0.1) < 0.003 and abs(felder[0]["rechteck"][3] - 0.86) < 0.003
    fertig = pymupdf.open("pdf", pdf)
    assert not list(fertig[0].widgets()), "keine Formularfelder mehr – Inhalt eingebrannt"
    assert "Hausrat Komfort" in fertig[0].get_text()
    assert len(list(seite.widgets())) == 2, "Original bleibt unverändert"


def test_verbinden_senden_unterschreiben_oeffnen(c, nas):
    dienst, code = nas
    assert c.get("/api/signatur/status").json() == {"eingerichtet": False}
    assert c.post("/api/signatur/verbinden", json={"code": "Quatsch"}).status_code == 400
    s = c.post("/api/signatur/verbinden", json={"code": code}).json()
    assert s["eingerichtet"] and s["erreichbar"] and s["hubspot"] and s["bereit"]
    assert c.get("/api/einstellungen").json()["signatur_verbindung"]["url"].startswith("http://127.0.0.1:")

    k = c.get("/api/signatur/kontakte?q=Muster").json()["kontakte"]
    assert k[0]["name"] == "Max Muster"
    assert c.get("/api/signatur/kontakte/501/deals").json() == {"deals": []}

    d = c.dok
    c.post(f"/api/dokumente/{d}/formular", json={"seite": 1, "typ": "unterschrift", "rechteck": [0.1, 0.8, 0.45, 0.86]})
    r = c.post(f"/api/dokumente/{d}/signatur/senden", json={"kontakt": k[0], "code": "4711", "gueltig_tage": 7, "nachricht": "Bitte unterschreiben."})
    assert r.status_code == 200, r.text
    a = r.json()
    p1 = a["personen"][0]
    assert p1["link"].startswith("https://sign.example.org/s/") and a["titel"] == "vertrag"
    assert p1["mit_code"] and (p1["name"], p1["email"]) == ("Max Muster", "max@example.org")
    assert [f["art"] for f in a["felder"]] == ["unterschrift"] and a["felder"][0]["seite"] == 1
    assert c.get("/api/signatur/auftraege").json()["auftraege"][0]["id"] == a["id"]

    # Kunde unterschreibt (direkt am Kundenteil des NAS-Dienstes)
    kunde = TestClient(kunde_app(dienst))
    t = p1["link"].rsplit("/", 1)[1]
    zugang = kunde.post(f"/s/{t}/code", json={"code": "4711"}).json()["zugang"]
    assert kunde.post(f"/s/{t}/unterschreiben", json={"name": "Max Muster", "zustimmung": True, "unterschriften": {"f1": {"text": "Max Muster"}}, "zugang": zugang}).status_code == 200

    detail = c.get(f"/api/signatur/auftraege/{a['id']}").json()
    assert detail["status"] == "unterschrieben"
    info = c.post(f"/api/signatur/auftraege/{a['id']}/oeffnen").json()
    assert info["titel"] == "vertrag – unterschrieben.pdf" and len(info["seiten"]) == 3

    zweiter = c.post(f"/api/dokumente/{d}/signatur/senden", json={"titel": "Vollmacht Max Muster"}).json()
    assert c.post(f"/api/signatur/auftraege/{zweiter['id']}/widerrufen").json()["status"] == "widerrufen"
    assert c.post(f"/api/signatur/auftraege/{zweiter['id']}/loeschen").status_code == 400
    assert c.post("/api/signatur/trennen").json() == {"eingerichtet": False}
    assert c.get("/api/signatur/auftraege").status_code == 400


def test_nas_nicht_erreichbar(c):
    roh = base64.urlsafe_b64encode(b'{"u": "http://127.0.0.1:9", "k": "abcdefghijklmnopqrstuvwxyz"}').decode()
    r = c.post("/api/signatur/verbinden", json={"code": "EFY-SIGN:" + roh})
    assert r.status_code == 400 and "nicht erreichbar" in r.json()["fehler"]


def test_rollen_aus_feldnamen():
    assert signatur.rolle("Unterschrift Kunde") == "Kunde"
    assert signatur.rolle("Unterschrift Kunde 2") == "Kunde"
    assert signatur.rolle("Unterschrift Ehepartner") == "Ehepartner"
    assert signatur.rolle("Unterschrift") == "Kunde"
    assert signatur.rolle("Signature1") == "Signature1"
    assert signatur.rollen([{"rolle": "Makler"}, {"rolle": "Kunde"}, {"rolle": "Makler"}]) == ["Kunde", "Makler"]


def test_zwei_personen_senden(c, nas):
    dienst, code = nas
    c.post("/api/signatur/verbinden", json={"code": code})
    d = c.dok
    r1 = c.post(f"/api/dokumente/{d}/formular", json={"seite": 1, "typ": "unterschrift", "rechteck": [0.1, 0.8, 0.45, 0.86]}).json()["id"]
    r2 = c.post(f"/api/dokumente/{d}/formular", json={"seite": 1, "typ": "unterschrift", "rechteck": [0.55, 0.8, 0.9, 0.86]}).json()["id"]
    c.post(f"/api/dokumente/{d}/formular", json={"seite": 0, "typ": "unterschrift", "rechteck": [0.55, 0.3, 0.9, 0.36]})
    # Rolle über die Eigenschaften setzen → Feld heißt „Unterschrift Ehepartner“
    assert c.patch(f"/api/dokumente/{d}/formular/{r2}", json={"seite": 1, "rolle": "Ehepartner"}).status_code == 200
    f = c.get(f"/api/dokumente/{d}/signatur/felder").json()
    assert f["rollen"] == ["Kunde", "Ehepartner"]
    assert sorted(x["name"] for x in f["felder"]) == ["Unterschrift Ehepartner", "Unterschrift Kunde", "Unterschrift Kunde 3"]
    assert all(len(x["rechteck"]) == 4 for x in f["felder"])
    assert r1

    ohne = c.post(f"/api/dokumente/{d}/signatur/senden", json={"personen": [{"rolle": "Kunde", "name": "Max Muster"}, {"rolle": "Makler", "name": "Büro"}]})
    assert ohne.status_code == 400 and "Ehepartner" in ohne.json()["fehler"]
    a = c.post(
        f"/api/dokumente/{d}/signatur/senden",
        json={"personen": [{"rolle": "Kunde", "name": "Max Muster"}, {"rolle": "Ehepartner", "name": "Erika Muster", "code": "4711"}], "reihenfolge": True},
    ).json()
    assert [p["rolle"] for p in a["personen"]] == ["Kunde", "Ehepartner"] and a["reihenfolge"] is True
    assert sorted((x["person"], x["seite"]) for x in a["felder"]) == [(1, 0), (1, 1), (2, 1)]
    assert [p["mit_code"] for p in a["personen"]] == [False, True]
    assert c.post(f"/api/signatur/auftraege/{a['id']}/oeffnen").status_code == 400


def test_feld_mit_rolle_anlegen():
    from agentur_pdf.kern import formulare

    doc = pymupdf.open()
    doc.new_page()
    for rolle in ("Ehepartner", "Ehepartner", "Kunde"):
        formulare.feld_anlegen(doc, 0, {"typ": "unterschrift", "rechteck": [0.1, 0.8, 0.4, 0.86], "rolle": rolle})
    namen = sorted(w.field_name for w in doc[0].widgets())
    assert namen == ["Unterschrift Ehepartner", "Unterschrift Ehepartner 2", "Unterschrift Kunde"]
    assert signatur.rollen(signatur.felder_zaehlen(doc)) == ["Kunde", "Ehepartner"]


def test_unterwegs_zweite_adresse(c, nas):
    """Büro-Adresse nicht erreichbar (z. B. zu Hause) → automatisch die zweite."""
    dienst, code = nas
    roh = code.split(":", 1)[1]
    inhalt = json.loads(base64.urlsafe_b64decode(roh + "=" * (-len(roh) % 4)))
    umgedreht = {"u": "http://127.0.0.1:9", "k": inhalt["k"], "a": [inhalt["u"]]}
    neu = "EFY-SIGN:" + base64.urlsafe_b64encode(json.dumps(umgedreht).encode()).decode()
    s = c.post("/api/signatur/verbinden", json={"code": neu}).json()
    assert s["erreichbar"] and s["url"] == inhalt["u"]
    assert c.get("/api/signatur/kontakte?q=Muster").json()["kontakte"][0]["name"] == "Max Muster"
    signatur._ERREICHBAR.clear()


def test_hubspot_start(c, nas):
    _, code = nas
    c.post("/api/signatur/verbinden", json={"code": code})
    assert c.get("/api/signatur/hubspot/kontakt/501").json()["kontakte"][0]["name"] == "Max Muster"
    assert c.get("/api/signatur/hubspot/firma/1").status_code == 400
