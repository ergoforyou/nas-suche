"""Chrome-Seitenleiste: Kopplung, Öffnen im Programm, stilles Zusammenführen."""

from __future__ import annotations

import time

import pymupdf
from fastapi.testclient import TestClient

import testdaten
from agentur_pdf.__main__ import BEVORZUGTER_PORT, freier_port
from agentur_pdf.api.app import erstelle_app
from agentur_pdf.api.sicherheit import CHROME_ERWEITERUNG
from agentur_pdf.benutzer.speicher import BenutzerSpeicher
from agentur_pdf.kern.dokumente import DokumentSpeicher

H = {"X-Agentur-Token": "geheim"}
ERWEITERUNG = f"chrome-extension://{CHROME_ERWEITERUNG}"


def client():
    return TestClient(erstelle_app("geheim", dokumente=DokumentSpeicher(), benutzer=BenutzerSpeicher()))


def test_nur_eigene_erweiterung_bekommt_token():
    c = client()
    assert c.post("/chrome/verbinden", headers={"Origin": ERWEITERUNG}).json()["token"] == "geheim"
    for fremd in ("https://boese.example", "chrome-extension://abcdefghijklmnopabcdefghijklmnop", ""):
        assert c.post("/chrome/verbinden", headers={"Origin": fremd}).status_code == 403
    # weitere Kennung (z. B. Web Store) per Einstellung
    c.put("/api/einstellungen", headers=H, json={"chrome_erweiterungen": ["abcdefghijklmnopabcdefghijklmnop"]})
    assert c.post("/chrome/verbinden", headers={"Origin": "chrome-extension://abcdefghijklmnopabcdefghijklmnop"}).status_code == 200


def test_oeffnen_im_programm_meldet_ereignis(tmp_path):
    c = client()
    testdaten.beschriftet(tmp_path / "a.pdf", "A", 2)
    pdf = (tmp_path / "a.pdf").read_bytes()
    r = c.post("/api/chrome/oeffnen?name=Rechnung.pdf", headers=H, content=pdf)
    assert r.status_code == 200
    ereignisse = c.get("/api/ereignisse", headers=H).json()["ereignisse"]
    (e,) = [x for x in ereignisse if x["art"] == "oeffnen"]
    info = c.get(f"/api/dokumente/{e['dokumente'][0]}", headers=H).json()
    assert info["seitenanzahl"] == 2
    assert c.post("/api/chrome/oeffnen?name=x.exe", headers=H, content=b"MZ").status_code == 400


def test_still_zusammenfuehren_oeffnet_nicht_im_fenster(tmp_path):
    c = client()
    ids = []
    for name, n in (("a.pdf", 2), ("b.pdf", 3)):
        testdaten.beschriftet(tmp_path / name, name[0].upper(), n)
        ids.append(c.post(f"/api/uploads?name={name}", headers=H, content=(tmp_path / name).read_bytes()).json()["id"])
    auftrag = c.post("/api/zusammenfuehren", headers=H, json={"eintraege": [{"upload": i} for i in ids], "still": True}).json()
    for _ in range(100):
        a = c.get(f"/api/auftraege/{auftrag['id']}", headers=H).json()
        if a["status"] in ("fertig", "fehler"):
            break
        time.sleep(0.1)
    assert a["status"] == "fertig" and a["ergebnis"]["oeffnen"] is False
    dok = a["ergebnis"]["dokumente"][0]
    assert pymupdf.open(stream=c.get(f"/api/dokumente/{dok}/datei", headers=H).content).page_count == 5


def test_fester_port():
    import socket

    with socket.socket() as s:
        try:
            s.bind(("127.0.0.1", BEVORZUGTER_PORT))
        except OSError:
            return  # Port auf dem Testrechner belegt – nichts zu prüfen
        assert freier_port() != BEVORZUGTER_PORT  # belegt → anderer Port
    assert freier_port() == BEVORZUGTER_PORT


def test_erweiterung_vorhanden_und_kennung_passt_zum_schluessel():
    import base64
    import hashlib
    import json

    from agentur_pdf.windows import chrome

    s = client().get("/api/system/chrome", headers=H).json()
    assert s["vorhanden"], s
    manifest = json.loads((chrome.ordner() / "manifest.json").read_text(encoding="utf-8"))
    roh = hashlib.sha256(base64.b64decode(manifest["key"])).hexdigest()[:32]
    assert "".join(chr(ord("a") + int(z, 16)) for z in roh) == CHROME_ERWEITERUNG
    # Version der Erweiterung = Programmversion (ohne „-test“)
    from agentur_pdf import __version__

    assert manifest["version"] == __version__.split("-")[0]
