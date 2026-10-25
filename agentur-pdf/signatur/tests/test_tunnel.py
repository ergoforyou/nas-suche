"""Tunnel-Zustand (Tailscale LocalAPI nachgebaut) und automatische Adresse."""

from __future__ import annotations

import httpx
from fastapi.testclient import TestClient

from ergoforyou_sign.app import Dienst, intern_app
from ergoforyou_sign.tunnel import Tunnel


def lokal(status: dict) -> httpx.MockTransport:
    def antwort(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/localapi/v0/status"
        return httpx.Response(200, json=status)

    return httpx.MockTransport(antwort)


BEREIT = {"BackendState": "Running", "Self": {"ID": "n123", "DNSName": "ergoforyou-sign.tail1a2b.ts.net.", "CapMap": {"https://tailscale.com/cap/funnel": None}}}


def test_zustaende():
    assert Tunnel(socket="/gibt/es/nicht").status()["zustand"] == "fehlt"
    anmelden = Tunnel(transport=lokal({"BackendState": "NeedsLogin", "AuthURL": "https://login.tailscale.com/a/abc"})).status()
    assert anmelden["zustand"] == "anmelden" and anmelden["login_url"] == "https://login.tailscale.com/a/abc"
    assert Tunnel(transport=lokal({"BackendState": "Starting"})).status()["zustand"] == "startet"
    ohne_funnel = Tunnel(transport=lokal({"BackendState": "Running", "Self": {"ID": "n123", "DNSName": "ergoforyou-sign.tail1a2b.ts.net."}})).status()
    assert ohne_funnel["zustand"] == "freigeben" and ohne_funnel["login_url"].endswith("node=n123")
    bereit = Tunnel(transport=lokal(BEREIT)).status()
    assert bereit == {"zustand": "bereit", "text": "Von außen erreichbar.", "adresse": "https://ergoforyou-sign.tail1a2b.ts.net"}

    def kaputt(request):
        raise httpx.ConnectError("weg")

    assert Tunnel(transport=httpx.MockTransport(kaputt)).status()["zustand"] == "fehler"


def test_adresse_wird_uebernommen(tmp_path):
    dienst = Dienst(tmp_path, tunnel_transport=lokal(BEREIT))
    dienst.konfig.setzen(oeffentliche_adresse="http://10.10.2.29:8480", adresse_quelle="manuell")
    dienst.wartung()
    assert dienst.konfig.oeffentliche_adresse == "https://ergoforyou-sign.tail1a2b.ts.net"
    # eigene Domain wird nie überschrieben
    dienst.konfig.setzen(oeffentliche_adresse="https://sign.ergoforyou.de", adresse_quelle="manuell")
    dienst.wartung()
    assert dienst.konfig.oeffentliche_adresse == "https://sign.ergoforyou.de"
    # Einrichtungsseite: Knopf „Tunnel-Adresse verwenden“
    c = TestClient(intern_app(dienst))
    c.post("/einrichtung/kennwort", json={"kennwort": "geheim123"})
    werte = c.get("/einrichtung/werte").json()
    assert werte["tunnel"]["zustand"] == "bereit" and werte["adresse_quelle"] == "manuell"
    assert c.post("/einrichtung/tunnel").json()["zustand"] == "bereit"
    assert dienst.konfig.oeffentliche_adresse == "https://ergoforyou-sign.tail1a2b.ts.net"


def test_hubspot_wird_nachgeholt(tmp_path):
    import base64
    import json

    import pymupdf

    from ergoforyou_sign.app import kunde_app

    erreichbar = {"an": False}
    notizen = []

    def hubspot(request: httpx.Request) -> httpx.Response:
        if not erreichbar["an"]:
            raise httpx.ConnectError("offline")
        if request.url.path == "/crm/v3/objects/notes":
            notizen.append(json.loads(request.content))
        return httpx.Response(201, json={"id": "1"})

    dienst = Dienst(tmp_path, httpx.MockTransport(hubspot), tunnel_transport=lokal(BEREIT))
    dienst.konfig.setzen(hubspot_token="pat-eu1-test")
    i = TestClient(intern_app(dienst))
    i.headers["X-Sign-Schluessel"] = dienst.konfig.get("schluessel")
    doc = pymupdf.open()
    doc.new_page()
    a = i.post("/api/auftraege", json={"titel": "Vollmacht Max Muster", "pdf": base64.b64encode(doc.tobytes()).decode(), "hubspot_kontakt_id": "501", "empfaenger_name": "Max Muster"}).json()
    dienst.hubspot_ablegen(a["id"], "gesendet")
    assert "nicht erreichbar" in dienst.auftraege.laden(a["id"])["ablage"]["hubspot_fehler"]
    k = TestClient(kunde_app(dienst))
    k.post(f"/s/{a['personen'][0]['link'].rsplit('/', 1)[1]}/unterschreiben", json={"name": "Max Muster", "zustimmung": True, "unterschriften": {"ende1": {"text": "Max Muster"}}})
    import threading
    import time

    # Hintergrund-Abgleich nach der Unterschrift (noch offline) abwarten
    ende = time.time() + 5
    while time.time() < ende and threading.active_count() > 1 and any(t.daemon for t in threading.enumerate() if t is not threading.main_thread()):
        time.sleep(0.05)
    erreichbar["an"] = True
    assert dienst.wartung()["nachgeholt"] >= 2  # Notizen „gesendet“ + „fertig“ (+ Felder)
    ablage = dienst.auftraege.laden(a["id"])["ablage"]
    assert ablage["hubspot_gesendet"] and ablage["hubspot_fertig"]
    assert ablage["hubspot_status"] == "unterschrieben"
    assert dienst.wartung()["nachgeholt"] == 0
