"""HubSpot-Karte: Signaturprüfung, Studio (Entwurf → Senden), Zuordnung zum Datensatz."""

from __future__ import annotations

import time

import httpx
import pymupdf
import pytest
from fastapi.testclient import TestClient

from ergoforyou_sign.app import Dienst, intern_app, kunde_app
from ergoforyou_sign.karte import adressen_kandidaten, entwuerfe_aufraeumen, signatur_pruefen, signatur_v3
from test_sign import FakeHubSpot, beispiel_pdf

GEHEIM = "geheim-123"


def test_signatur_wie_hubspot():
    # Vergleichswert erzeugt mit @hubspot/api-client (Signature.getSignature v3)
    adresse = "https://sign.example.org/hs/karte?objekt=0-1&id=501&von=Max%20Muster&userId=1&portalId=146305116&userEmail=max@example.org&appId=9"
    assert signatur_v3(GEHEIM, "GET", adresse, "", "1700000000000") == "PQd6Cr8wucFL6fGHtFHk0+5Xsbg81m0p77SBYbiZp6I="
    kandidaten = adressen_kandidaten(["https://sign.example.org"], "/hs/karte?objekt=0-1&id=501&von=Max%20Muster&userId=1&portalId=146305116&userEmail=max%40example.org&appId=9")
    assert adresse in kandidaten  # %40 → @ wie bei HubSpot
    assert "https://sign.example.org/hs/karte?objekt=0-1&id=501&von=Max%20Muster" in kandidaten
    sig = signatur_v3(GEHEIM, "GET", adresse, "", "1700000000000")
    assert signatur_pruefen(GEHEIM, "GET", kandidaten, "", "1700000000000", sig, jetzt_ms=1700000060000) == ""
    assert "Zeitstempel" in signatur_pruefen(GEHEIM, "GET", kandidaten, "", "1700000000000", sig, jetzt_ms=1700000000000 + 10 * 60000)
    assert "passt nicht" in signatur_pruefen("falsch", "GET", kandidaten, "", "1700000000000", sig, jetzt_ms=1700000000000)
    assert "Client-Secret" in signatur_pruefen("", "GET", kandidaten, "", "1700000000000", sig)


class FakeHubSpotMitAnhang(FakeHubSpot):
    def __call__(self, request: httpx.Request) -> httpx.Response:
        pfad = request.url.path
        if request.url.host == "cdn.example.org":
            self.anfragen.append((request.method, pfad, b""))
            assert "authorization" not in request.headers  # Schlüssel nie an den Datei-Server
            return httpx.Response(200, content=pdf_mit_feld())
        if pfad.endswith("/associations/notes"):
            self.anfragen.append((request.method, pfad, b""))
            return httpx.Response(200, json={"results": [{"toObjectId": 61}, {"toObjectId": 62}]})
        if pfad == "/crm/v3/objects/notes/batch/read":
            self.anfragen.append((request.method, pfad, b""))
            return httpx.Response(200, json={"results": [
                {"id": "61", "properties": {"hs_attachment_ids": "3001;3002", "hs_timestamp": "2026-10-20T10:00:00Z"}},
                {"id": "62", "properties": {"hs_attachment_ids": "", "hs_timestamp": "2026-10-21T10:00:00Z"}},
            ]})
        if pfad == "/files/v3/files/3001":
            return httpx.Response(200, json={"id": "3001", "name": "Maklervertrag Muster", "extension": "pdf", "size": 12345})
        if pfad == "/files/v3/files/3002":
            return httpx.Response(200, json={"id": "3002", "name": "Foto", "extension": "jpg", "size": 999})
        if pfad == "/files/v3/files/3001/signed-url":
            return httpx.Response(200, json={"url": "https://cdn.example.org/datei/3001.pdf?sig=x"})
        return super().__call__(request)


def pdf_mit_feld() -> bytes:
    doc = pymupdf.open("pdf", beispiel_pdf(2))
    w = pymupdf.Widget()
    w.field_type = pymupdf.PDF_WIDGET_TYPE_SIGNATURE
    w.field_name = "Unterschrift Ehepartner"
    w.rect = pymupdf.Rect(300, 700, 500, 750)
    doc[1].add_widget(w)
    return doc.tobytes()


@pytest.fixture()
def karte(tmp_path):
    hs = FakeHubSpotMitAnhang()
    dienst = Dienst(tmp_path, httpx.MockTransport(hs))
    dienst.konfig.setzen(oeffentliche_adresse="https://sign.example.org", hubspot_token="pat-eu1-test", hubspot_portal=146305116, hubspot_app_geheimnis=GEHEIM)
    kunde = TestClient(kunde_app(dienst), base_url="https://sign.example.org")
    return dienst, kunde, hs


def aufruf(kunde: TestClient, abfrage: str, geheim: str = GEHEIM, zeit: int | None = None) -> httpx.Response:
    zeit = int(time.time() * 1000) if zeit is None else zeit
    adresse = f"https://sign.example.org/hs/karte?{abfrage}"
    kopf = {"X-HubSpot-Signature-v3": signatur_v3(geheim, "GET", adresse, "", str(zeit)), "X-HubSpot-Request-Timestamp": str(zeit)}
    return kunde.get(f"/hs/karte?{abfrage}", headers=kopf)


def test_karte_nur_mit_hubspot_unterschrift(karte):
    dienst, kunde, _ = karte
    assert kunde.get("/hs/karte?objekt=0-1&id=501").status_code == 401
    r = aufruf(kunde, "objekt=0-1&id=501", geheim="falsch")
    assert r.status_code == 401 and "Client-Secret" in r.json()["fehler"]
    assert "Client-Secret" in dienst.konfig.get("karte_fehler")
    r = aufruf(kunde, "objekt=0-1&id=501&portalId=999")
    assert r.status_code == 401 and "anderen HubSpot-Konto" in r.json()["fehler"]
    r = aufruf(kunde, "objekt=0-1&id=501&von=Jens%20B%C3%BCro&portalId=146305116&userId=7&userEmail=jens%40example.org&appId=5")
    assert r.status_code == 200, r.text
    assert r.json()["auftraege"] == [] and r.json()["studio"].startswith("https://sign.example.org/hs/studio?t=")
    assert dienst.konfig.get("karte_fehler") == "" and dienst.konfig.get("karte_kontakt")
    assert aufruf(kunde, "objekt=0-2&id=1").status_code == 400  # Firmen gibt es (noch) nicht
    # Studio darf in HubSpot eingebettet werden, die Kundenseite nicht
    t = r.json()["studio"].split("t=", 1)[1]
    studio = kunde.get(f"/hs/studio?t={t}")
    assert studio.status_code == 200 and "X-Frame-Options" not in studio.headers
    assert "frame-ancestors https://app.hubspot.com" in studio.headers["content-security-policy"]
    assert kunde.get("/hs/studio?t=kaputt").status_code == 401
    assert kunde.get("/robots.txt").headers["X-Frame-Options"] == "DENY"


def test_studio_ablauf_kontakt(karte):
    dienst, kunde, hs = karte
    t = aufruf(kunde, "objekt=0-1&id=501&von=Jens%20B%C3%BCro").json()["studio"].split("t=", 1)[1]
    kopf = {"X-Karte": t}
    k = kunde.get("/hs/api/kontext", headers=kopf).json()
    assert k["kontakte"][0]["name"] == "Max Muster" and k["deals"][0]["id"] == "77"
    assert [a["id"] for a in k["anhaenge"]] == ["3001"]  # nur PDFs

    # PDF aus HubSpot übernehmen – vorhandenes Unterschriftsfeld wird Vorschlag
    e = kunde.post("/hs/api/entwurf/hubspot", json={"datei_id": "3001"}, headers=kopf).json()
    assert e["name"] == "Maklervertrag Muster" and len(e["seiten"]) == 2
    assert e["vorschlaege"][0]["rolle"] == "Ehepartner" and e["vorschlaege"][0]["seite"] == 1
    assert kunde.get(f"/hs/api/entwurf/{e['entwurf']}/seite/0?t={t}").headers["content-type"] == "image/png"
    assert kunde.post("/hs/api/entwurf/hubspot", json={"datei_id": "4444"}, headers=kopf).status_code == 404

    # Hochladen vom Computer
    e2 = kunde.post("/hs/api/entwurf", content=beispiel_pdf(1), headers={**kopf, "X-Dateiname": "Beratungsprotokoll%20Muster.pdf"}).json()
    assert e2["name"] == "Beratungsprotokoll Muster" and e2["vorschlaege"] == []
    assert kunde.post("/hs/api/entwurf", content=b"kein pdf", headers=kopf).status_code == 400

    # Senden ohne Namen geht nicht
    r = kunde.post("/hs/api/senden", headers=kopf, json={"entwurf": e["entwurf"], "personen": [{"rolle": "Kunde", "name": " "}]})
    assert r.status_code == 400
    a = kunde.post(
        "/hs/api/senden",
        headers=kopf,
        json={
            "entwurf": e["entwurf"],
            "titel": "Maklervertrag",
            "deal_id": "77",
            "personen": [
                {"rolle": "Kunde", "name": "Max Muster", "hubspot_kontakt_id": "501"},
                {"rolle": "Ehepartner", "name": "Erika Muster", "code": "0101"},
            ],
            "felder": [
                {"seite": 0, "rechteck": [0.1, 0.8, 0.4, 0.86], "art": "unterschrift", "person": 1},
                {"seite": 1, "rechteck": [0.5, 0.05, 0.84, 0.11], "art": "unterschrift", "person": 2},
            ],
        },
    ).json()
    assert a["erstellt_von"] == "Jens Büro" and a["hubspot"] == {"kontakt_id": "501", "deal_id": "77", "kontakt_name": ""}
    assert a["personen"][1]["mit_code"] and a["personen"][0]["link"].startswith("https://sign.example.org/s/")
    # Entwurf ist verbraucht
    assert kunde.post("/hs/api/senden", headers=kopf, json={"entwurf": e["entwurf"], "personen": [{"name": "Max Muster"}]}).status_code == 404

    # Karte zeigt den Auftrag – am Kontakt und am Deal
    liste = aufruf(kunde, "objekt=0-1&id=501").json()["auftraege"]
    assert liste[0]["titel"] == "Maklervertrag" and liste[0]["status_text"] == "Versendet" and liste[0]["anzahl"] == 2
    assert liste[0]["personen"][0]["link"]
    assert aufruf(kunde, "objekt=0-3&id=77").json()["auftraege"][0]["id"] == a["id"]
    assert aufruf(kunde, "objekt=0-1&id=999").json()["auftraege"] == []

    # Detail + Zurückziehen nur für den eigenen Datensatz
    d = kunde.get(f"/hs/api/auftraege/{a['id']}", headers=kopf).json()
    assert d["status_text"] == "Versendet" and d["verlauf"][0]["art"] == "erstellt" and "felder" not in d
    fremd = aufruf(kunde, "objekt=0-1&id=999").json()["studio"].split("t=", 1)[1]
    assert kunde.get(f"/hs/api/auftraege/{a['id']}", headers={"X-Karte": fremd}).status_code == 404
    assert kunde.get(f"/hs/pdf/{a['id']}?t={t}").status_code == 404  # noch nicht unterschrieben
    assert kunde.get(f"/hs/pdf/{a['id']}?art=original&t={t}").headers["content-type"] == "application/pdf"
    w = kunde.post(f"/hs/api/auftraege/{a['id']}/widerrufen", headers=kopf).json()
    assert w["status"] == "widerrufen" and "Jens Büro" in w["verlauf"][-1]["text"]


def test_studio_am_deal_und_ohne_schluessel(karte):
    _, kunde, _ = karte
    assert kunde.get("/hs/api/kontext").status_code == 401
    t = aufruf(kunde, "objekt=0-3&id=77").json()["studio"].split("t=", 1)[1]
    k = kunde.get("/hs/api/kontext", headers={"X-Karte": t}).json()
    assert k["deal"]["name"] == "Hausrat Muster" and k["kontakte"][0]["id"] == "501"
    e = kunde.post("/hs/api/entwurf", content=beispiel_pdf(1), headers={"X-Karte": t}).json()
    a = kunde.post("/hs/api/senden", headers={"X-Karte": t}, json={"entwurf": e["entwurf"], "personen": [{"name": "Max Muster", "hubspot_kontakt_id": "501"}]}).json()
    assert a["hubspot"]["deal_id"] == "77" and a["hubspot"]["kontakt_id"] == "501"
    assert any(f["id"] == "ende1" for f in a["felder"])  # ohne Feld: Unterschrift auf der Abschlussseite


def test_entwuerfe_werden_aufgeraeumt(karte):
    dienst, kunde, _ = karte
    t = aufruf(kunde, "objekt=0-1&id=501").json()["studio"].split("t=", 1)[1]
    e = kunde.post("/hs/api/entwurf", content=beispiel_pdf(1), headers={"X-Karte": t}).json()
    assert entwuerfe_aufraeumen(dienst.ordner) == 0
    info = dienst.ordner / "entwuerfe" / e["entwurf"] / "entwurf.json"
    info.write_text(info.read_text().replace('"zeit": ', '"zeit": 1, "alt": '))
    assert entwuerfe_aufraeumen(dienst.ordner) == 1


def test_einrichtung_zeigt_karte(karte, tmp_path):
    dienst, _, _ = karte
    intern = TestClient(intern_app(dienst))
    intern.post("/einrichtung/kennwort", json={"kennwort": "sehrgeheim1"})
    w = intern.get("/einrichtung/werte").json()
    assert w["karte_geheimnis_gesetzt"] and w["karte_kontakt_vor_s"] is None
    intern.post("/einrichtung/werte", json={"hubspot_app_geheimnis": " neu-geheim "})
    assert dienst.konfig.get("hubspot_app_geheimnis") == "neu-geheim"
