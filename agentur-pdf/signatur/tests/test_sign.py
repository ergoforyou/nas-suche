"""Ergoforyou Sign: Ablauf vom Anlegen bis zur Kopie – mit nachgebautem HubSpot."""

from __future__ import annotations

import base64
import json
import time

import httpx
import pymupdf
import pytest
from fastapi.testclient import TestClient

from ergoforyou_sign.app import Dienst, intern_app, kunde_app


class FakeHubSpot:
    def __init__(self) -> None:
        self.anfragen: list[tuple[str, str, bytes]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.anfragen.append((request.method, request.url.path, request.content))
        pfad = request.url.path
        if request.headers.get("authorization") != "Bearer pat-eu1-test":
            return httpx.Response(401, json={"message": "bad token"})
        if pfad == "/crm/v3/objects/contacts" and request.method == "GET":
            return httpx.Response(200, json={"results": []})
        if pfad == "/account-info/v3/details":
            return httpx.Response(200, json={"portalId": 146305116, "uiDomain": "app-eu1.hubspot.com"})
        if pfad == "/crm/v3/objects/contacts/search":
            return httpx.Response(200, json={"results": [{"id": "501", "properties": {"firstname": "Max", "lastname": "Muster", "email": "max@example.org"}}]})
        if pfad == "/crm/v4/objects/contacts/501/associations/deals":
            return httpx.Response(200, json={"results": [{"toObjectId": 77}]})
        if pfad == "/crm/v3/objects/deals/batch/read":
            return httpx.Response(200, json={"results": [{"id": "77", "properties": {"dealname": "Hausrat Muster", "dealstage": "x"}}]})
        if pfad == "/files/v3/files":
            return httpx.Response(201, json={"id": "9001"})
        if pfad == "/crm/v3/objects/notes":
            return httpx.Response(201, json={"id": str(8000 + len(self.anfragen))})
        return httpx.Response(404, json={"message": "unbekannt"})

    def pfade(self) -> list[str]:
        return [p for _, p, _ in self.anfragen]


def beispiel_pdf(seiten: int = 2, drehung: int = 0) -> bytes:
    doc = pymupdf.open()
    for i in range(seiten):
        s = doc.new_page(width=595, height=842)
        s.insert_text((72, 100), f"Maklervertrag Max Muster – Seite {i + 1}", fontsize=14)
        if drehung:
            s.set_rotation(drehung)
    return doc.tobytes()


PNG = "data:image/png;base64," + base64.b64encode(
    pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 120, 40), 1).tobytes("png")
).decode()


@pytest.fixture()
def umgebung(tmp_path):
    hs = FakeHubSpot()
    dienst = Dienst(tmp_path, httpx.MockTransport(hs))
    dienst.konfig.setzen(oeffentliche_adresse="https://sign.example.org", hubspot_token="pat-eu1-test", hubspot_portal=146305116)
    intern = TestClient(intern_app(dienst))
    intern.headers["X-Sign-Schluessel"] = dienst.konfig.get("schluessel")
    kunde = TestClient(kunde_app(dienst), client=("192.168.1.10", 50000))  # wie hinter dem DSM-Reverse-Proxy
    return dienst, intern, kunde, hs


def anlegen(intern, **extra) -> dict:
    daten = {
        "titel": "Maklervertrag Max Muster",
        "pdf": base64.b64encode(extra.pop("pdf", beispiel_pdf())).decode(),
        "felder": [
            {"seite": 1, "rechteck": [0.1, 0.8, 0.45, 0.86], "art": "unterschrift", "beschriftung": "Unterschrift Kunde"},
            {"seite": 1, "rechteck": [0.55, 0.8, 0.8, 0.83], "art": "datum"},
            {"seite": 1, "rechteck": [0.1, 0.87, 0.45, 0.9], "art": "name"},
        ],
        "empfaenger_name": "Max Muster",
        "hubspot_kontakt_id": "501",
        "hubspot_deal_id": "77",
        "hubspot_kontakt_name": "Max Muster",
        "erstellt_von": "JB",
        **extra,
    }
    r = intern.post("/api/auftraege", json=daten)
    assert r.status_code == 200, r.text
    return r.json()


def warten(bedingung, sekunden: float = 5.0) -> None:
    ende = time.time() + sekunden
    while time.time() < ende:
        if bedingung():
            return
        time.sleep(0.05)
    raise AssertionError("Zeitüberschreitung")


def token(a: dict, nr: int = 1) -> str:
    return a["personen"][nr - 1]["link"].rsplit("/", 1)[1]


def test_ganzer_ablauf(umgebung):
    dienst, intern, kunde, hs = umgebung
    a = anlegen(intern)
    assert a["personen"][0]["link"].startswith("https://sign.example.org/s/")
    assert a["status"] == "offen" and len(a["felder"]) == 3
    warten(lambda: dienst.auftraege.laden(a["id"])["ablage"]["hubspot_gesendet"])
    notiz = json.loads(next(c for m, p, c in hs.anfragen if p == "/crm/v3/objects/notes"))
    assert "Zur Unterschrift gesendet" in notiz["properties"]["hs_note_body"]
    assert {v["to"]["id"] for v in notiz["associations"]} == {"501", "77"}

    t = token(a)
    seite = kunde.get(f"/s/{t}")
    assert seite.status_code == 200 and "unterschreiben" in seite.text
    assert "frame-ancestors 'none'" in seite.headers["content-security-policy"]
    d = kunde.get(f"/s/{t}/daten", headers={"user-agent": "Mozilla/5.0 (iPhone) Safari", "x-forwarded-for": "203.0.113.7"}).json()
    assert d["name"] == "Max Muster" and len(d["seiten"]) == 2 and "token" not in json.dumps(d)
    assert kunde.get(f"/s/{t}/seite/0?breite=800").headers["content-type"] == "image/png"

    fehlt = kunde.post(f"/s/{t}/unterschreiben", json={"name": "Max Muster", "zustimmung": True, "unterschriften": {}})
    assert fehlt.status_code == 400
    r = kunde.post(
        f"/s/{t}/unterschreiben",
        json={"name": "Max Muster", "zustimmung": True, "unterschriften": {"f1": {"png": PNG}}},
        headers={"user-agent": "Mozilla/5.0 (iPhone) Safari", "x-forwarded-for": "203.0.113.7"},
    )
    assert r.status_code == 200, r.text
    assert len(r.json()["sha"]) == 64
    assert kunde.post(f"/s/{t}/unterschreiben", json={"name": "Max Muster", "zustimmung": True, "unterschriften": {"f1": {"png": PNG}}}).status_code == 410

    kopie = kunde.get(f"/s/{t}/kopie")
    assert kopie.status_code == 200 and kopie.content.startswith(b"%PDF")
    assert "attachment" in kopie.headers["content-disposition"]
    doc = pymupdf.open("pdf", kopie.content)
    assert doc.page_count == 3
    assert doc[1].get_images(), "Unterschrift steht auf Seite 2"
    text2 = doc[1].get_text()
    assert "Max Muster" in text2 and "Elektronisch unterschrieben" in text2
    protokoll = doc[2].get_text()
    for erwartet in ("Prüfprotokoll", "Max Muster", "203.0.113.7", "Safari auf iPhone", a["id"], "Unterschrieben"):
        assert erwartet in protokoll
    eingebettet = json.loads(doc.embfile_get("pruefprotokoll.json"))
    assert eingebettet["personen"][0]["unterschrift"]["name"] == "Max Muster"

    warten(lambda: dienst.auftraege.laden(a["id"])["ablage"]["hubspot_fertig"])
    assert "/files/v3/files" in hs.pfade()
    fertig = intern.get(f"/api/auftraege/{a['id']}").json()
    assert fertig["status"] == "unterschrieben" and fertig["personen"][0]["unterschrieben_als"] == "Max Muster"
    assert fertig["hubspot_url"].endswith("/contacts/146305116/record/0-1/501")
    assert intern.get(f"/api/auftraege/{a['id']}/pdf").content == kopie.content
    assert list((dienst.ordner / "unterschrieben").glob("*Maklervertrag Max Muster*.pdf"))
    arten = [e["art"] for e in fertig["verlauf"]]
    assert arten[:2] == ["erstellt", "geoeffnet"] and "unterschrieben" in arten and arten[-1] == "kopie"


def test_zugangscode_und_sperre(umgebung):
    _, intern, kunde, _ = umgebung
    a = anlegen(intern, code="4711")
    t = token(a)
    d = kunde.get(f"/s/{t}/daten").json()
    assert d["code_noetig"] and "seiten" not in d
    assert kunde.get(f"/s/{t}/seite/0").status_code == 403
    assert kunde.post(f"/s/{t}/code", json={"code": "0000"}).status_code == 403
    zugang = kunde.post(f"/s/{t}/code", json={"code": "4711"}).json()["zugang"]
    assert "seiten" in kunde.get(f"/s/{t}/daten?z={zugang}").json()
    assert kunde.get(f"/s/{t}/seite/0?z={zugang}").status_code == 200
    ohne = kunde.post(f"/s/{t}/unterschreiben", json={"name": "Max Muster", "zustimmung": True, "unterschriften": {"f1": {"text": "Max Muster"}}})
    assert ohne.status_code == 403
    ok = kunde.post(f"/s/{t}/unterschreiben", json={"name": "Max Muster", "zustimmung": True, "unterschriften": {"f1": {"text": "Max Muster"}}, "zugang": zugang})
    assert ok.status_code == 200
    assert kunde.get(f"/s/{t}/kopie").status_code == 403
    assert kunde.get(f"/s/{t}/kopie?z={zugang}").status_code == 200

    b = anlegen(intern, code="4711")
    t2 = token(b)
    for _ in range(4):
        assert kunde.post(f"/s/{t2}/code", json={"code": "falsch"}).status_code == 403
    assert kunde.post(f"/s/{t2}/code", json={"code": "falsch"}).status_code == 423
    assert kunde.post(f"/s/{t2}/code", json={"code": "4711"}).status_code == 423
    assert kunde.get(f"/s/{t2}/daten").json()["status"] == "gesperrt"
    intern.post(f"/api/auftraege/{b['id']}/entsperren", json={"von": "JB"})
    assert kunde.post(f"/s/{t2}/code", json={"code": "4711"}).status_code == 200


def test_ungueltig_abgelaufen_widerrufen(umgebung):
    dienst, intern, kunde, _ = umgebung
    assert kunde.get("/s/ganz-falscher-link-1234567890").status_code == 404
    assert kunde.get("/s/ganz-falscher-link-1234567890/daten").status_code == 404
    a = anlegen(intern)
    roh = dienst.auftraege.laden(a["id"])
    roh["gueltig_bis"] = "2020-01-01T00:00:00+00:00"
    dienst.auftraege.speichern(roh)
    assert kunde.get(f"/s/{token(a)}/daten").json()["status"] == "abgelaufen"
    assert kunde.get(f"/s/{token(a)}/seite/0").status_code == 410
    b = anlegen(intern)
    assert intern.post(f"/api/auftraege/{b['id']}/widerrufen", json={"von": "JB"}).json()["status"] == "widerrufen"
    assert kunde.post(f"/s/{token(b)}/unterschreiben", json={"name": "Max Muster", "zustimmung": True, "unterschriften": {"f1": {"text": "M"}}}).status_code == 410


def test_ohne_felder_unterschrift_nur_im_protokoll(umgebung):
    _, intern, kunde, _ = umgebung
    a = anlegen(intern, felder=[])
    assert a["felder"] == [{"id": "ende1", "seite": None, "rechteck": None, "art": "unterschrift", "person": 1, "beschriftung": "Unterschrift", "pflicht": True}]
    t = token(a)
    r = kunde.post(f"/s/{t}/unterschreiben", json={"name": "Max Muster", "zustimmung": True, "unterschriften": {"ende1": {"png": PNG}}})
    assert r.status_code == 200
    doc = pymupdf.open("pdf", kunde.get(f"/s/{t}/kopie").content)
    assert doc.page_count == 3 and not doc[1].get_images() and doc[2].get_images()


def test_gedrehte_seite(umgebung):
    _, intern, kunde, _ = umgebung
    a = anlegen(intern, pdf=beispiel_pdf(2, 90), felder=[{"seite": 0, "rechteck": [0.6, 0.7, 0.9, 0.8], "art": "datum"}, {"seite": 0, "rechteck": [0.1, 0.7, 0.4, 0.8], "art": "unterschrift"}])
    t = token(a)
    assert kunde.post(f"/s/{t}/unterschreiben", json={"name": "Max Muster", "zustimmung": True, "unterschriften": {"f2": {"png": PNG}}}).status_code == 200
    doc = pymupdf.open("pdf", kunde.get(f"/s/{t}/kopie").content)
    seite = doc[0]
    b, h = seite.rect.width, seite.rect.height  # angezeigte Maße (gedreht)
    datum = [w for w in seite.get_text("words") if w[4].count(".") == 2][0]
    mitte = (pymupdf.Rect(datum[:4]) * seite.rotation_matrix).normalize()
    assert 0.6 * b <= mitte.x0 <= 0.9 * b and 0.7 * h <= (mitte.y0 + mitte.y1) / 2 <= 0.8 * h
    # Text läuft in Leserichtung (waagerecht in der Anzeige)
    assert mitte.width > mitte.height
    bild = seite.get_image_info()[0]
    r = (pymupdf.Rect(bild["bbox"]) * seite.rotation_matrix).normalize()
    assert 0.1 * b - 1 <= r.x0 and r.x1 <= 0.4 * b + 1 and 0.7 * h - 1 <= r.y0 and r.y1 <= 0.8 * h + 1


def test_intern_schutz_und_einrichtung(umgebung, tmp_path):
    dienst, intern, kunde, _ = umgebung
    roh = TestClient(intern_app(dienst))
    assert roh.get("/api/auftraege").status_code == 401
    assert roh.get("/api/auftraege", headers={"X-Sign-Schluessel": "falsch"}).status_code == 401
    assert roh.get("/einrichtung/werte").status_code == 401
    assert roh.get("/einrichtung/zustand").json() == {"kennwort_gesetzt": False, "angemeldet": False, "version": "0.2.0"}
    assert roh.post("/einrichtung/kennwort", json={"kennwort": "kurz"}).status_code == 400
    assert roh.post("/einrichtung/kennwort", json={"kennwort": "geheim123"}).status_code == 200
    assert roh.post("/einrichtung/kennwort", json={"kennwort": "anders123"}).status_code == 409
    werte = roh.get("/einrichtung/werte").json()
    code = werte["verbindungscode"].split(":", 1)[1]
    inhalt = json.loads(base64.urlsafe_b64decode(code + "=" * (-len(code) % 4)))
    assert inhalt["k"] == dienst.konfig.get("schluessel") and inhalt["u"] == "http://testserver"

    neu = TestClient(intern_app(dienst))
    assert neu.post("/einrichtung/anmelden", json={"kennwort": "falsch"}).status_code == 403
    assert neu.post("/einrichtung/anmelden", json={"kennwort": "geheim123"}).status_code == 200
    assert neu.post("/einrichtung/werte", json={"hubspot_token": "pat-eu1-falsch"}).status_code == 502
    assert neu.post("/einrichtung/werte", json={"hubspot_token": "pat-eu1-test", "oeffentliche_adresse": "sign.example.org/"}).status_code == 200
    assert dienst.konfig.get("hubspot_portal") == 146305116
    assert dienst.konfig.oeffentliche_adresse == "https://sign.example.org"
    # Kundenseite kennt keine internen Pfade
    assert kunde.get("/api/auftraege").status_code == 404
    assert kunde.get("/einrichtung/werte").status_code == 404


def test_hubspot_suche(umgebung):
    _, intern, _, _ = umgebung
    k = intern.get("/api/hubspot/kontakte?q=Muster").json()["kontakte"]
    assert k == [{"id": "501", "name": "Max Muster", "email": "max@example.org", "firma": "", "telefon": ""}]
    assert intern.get("/api/hubspot/kontakte/501/deals").json()["deals"] == [{"id": "77", "name": "Hausrat Muster", "phase": "x"}]


def test_kaputte_pdf_und_unterschrift(umgebung):
    _, intern, kunde, _ = umgebung
    r = intern.post("/api/auftraege", json={"titel": "x", "pdf": base64.b64encode(b"keine pdf").decode()})
    assert r.status_code == 400
    a = anlegen(intern)
    t = token(a)
    schlecht = kunde.post(f"/s/{t}/unterschreiben", json={"name": "Max Muster", "zustimmung": True, "unterschriften": {"f1": {"png": "data:image/png;base64,AAAA"}}})
    assert schlecht.status_code == 400
    ohne_haken = kunde.post(f"/s/{t}/unterschreiben", json={"name": "Max Muster", "zustimmung": False, "unterschriften": {"f1": {"png": PNG}}})
    assert ohne_haken.status_code == 400


def test_zwei_personen_mit_reihenfolge(umgebung):
    dienst, intern, kunde, hs = umgebung
    r = intern.post(
        "/api/auftraege",
        json={
            "titel": "Maklervertrag Max und Erika Muster",
            "pdf": base64.b64encode(beispiel_pdf()).decode(),
            "felder": [
                {"seite": 1, "rechteck": [0.1, 0.7, 0.45, 0.76], "art": "unterschrift", "person": 1},
                {"seite": 1, "rechteck": [0.55, 0.7, 0.9, 0.76], "art": "unterschrift", "person": 2},
                {"seite": 0, "rechteck": [0.55, 0.2, 0.9, 0.26], "art": "unterschrift", "person": 2},
                {"seite": 1, "rechteck": [0.1, 0.8, 0.4, 0.83], "art": "datum", "person": 2},
            ],
            "personen": [
                {"rolle": "Kunde", "name": "Max Muster", "hubspot_kontakt_id": "501"},
                {"rolle": "Ehepartner", "name": "Erika Muster", "code": "1234", "hubspot_kontakt_id": "502"},
            ],
            "reihenfolge": True,
            "hubspot_deal_id": "77",
            "erstellt_von": "JB",
        },
    )
    assert r.status_code == 200, r.text
    a = r.json()
    assert [p["rolle"] for p in a["personen"]] == ["Kunde", "Ehepartner"]
    assert a["personen"][0]["link"] != a["personen"][1]["link"]
    assert [p["mit_code"] for p in a["personen"]] == [False, True]
    warten(lambda: dienst.auftraege.laden(a["id"])["ablage"]["hubspot_gesendet"])
    notiz = json.loads(next(c for m, p, c in hs.anfragen if p == "/crm/v3/objects/notes"))
    assert {v["to"]["id"] for v in notiz["associations"]} == {"501", "502", "77"}
    t1, t2 = token(a, 1), token(a, 2)

    # Erika ist erst nach Max dran
    z2 = kunde.post(f"/s/{t2}/code", json={"code": "1234"}).json()["zugang"]
    assert kunde.get(f"/s/{t2}/daten?z={z2}").json()["status"] == "noch_nicht"
    assert kunde.post(f"/s/{t2}/unterschreiben", json={"name": "Erika Muster", "zustimmung": True, "unterschriften": {"f2": {"png": PNG}, "f3": {"png": PNG}}, "zugang": z2}).status_code == 409

    d1 = kunde.get(f"/s/{t1}/daten").json()
    assert [f["id"] for f in d1["felder"]] == ["f1"], "jeder sieht nur seine Felder"
    r1 = kunde.post(f"/s/{t1}/unterschreiben", json={"name": "Max Muster", "zustimmung": True, "unterschriften": {"f1": {"png": PNG}}})
    assert r1.json()["fertig"] is False and r1.json()["fortschritt"] == {"anzahl": 2, "fertig": 1, "offen": ["Erika Muster"]}
    assert kunde.get(f"/s/{t1}/daten").json()["status"] == "wartet"
    assert kunde.get(f"/s/{t1}/kopie").status_code == 404
    assert intern.get(f"/api/auftraege/{a['id']}").json()["status"] == "teilweise"

    # Erika sieht Max' Unterschrift schon im Seitenbild und hat zwei Felder
    d2 = kunde.get(f"/s/{t2}/daten?z={z2}").json()
    assert [f["id"] for f in d2["felder"]] == ["f2", "f3", "f4"] and d2["rolle"] == "Ehepartner"
    stand = pymupdf.open("pdf", intern.get(f"/api/auftraege/{a['id']}/pdf?art=stand").content)
    assert len(stand[1].get_images()) == 1
    assert kunde.post(f"/s/{t2}/unterschreiben", json={"name": "Erika Muster", "zustimmung": True, "unterschriften": {"f2": {"png": PNG}}, "zugang": z2}).status_code == 400
    r2 = kunde.post(f"/s/{t2}/unterschreiben", json={"name": "Erika Muster", "zustimmung": True, "unterschriften": {"f2": {"png": PNG}, "f3": {"text": "Erika Muster"}}, "zugang": z2})
    assert r2.json()["fertig"] is True

    for t, z in ((t1, ""), (t2, z2)):
        assert kunde.get(f"/s/{t}/kopie?z={z}").status_code == 200
    doc = pymupdf.open("pdf", kunde.get(f"/s/{t1}/kopie").content)
    assert len(doc[1].get_images()) == 2 and "Erika Muster" in doc[0].get_text()
    protokoll = "".join(doc[i].get_text() for i in range(2, doc.page_count))
    for erwartet in ("Kunde", "Ehepartner", "Max Muster", "Erika Muster", "fester Reihenfolge", "Alle Unterschriften vollst"):
        assert erwartet in protokoll
    warten(lambda: dienst.auftraege.laden(a["id"])["ablage"]["hubspot_fertig"])
    fertig = intern.get(f"/api/auftraege/{a['id']}").json()
    assert fertig["status"] == "unterschrieben" and [p["status"] for p in fertig["personen"]] == ["unterschrieben", "unterschrieben"]


def test_ohne_reihenfolge_und_sperre_je_person(umgebung):
    _, intern, kunde, _ = umgebung
    a = anlegen(
        intern,
        felder=[],
        personen=[{"name": "Max Muster", "code": "1111"}, {"name": "Erika Muster", "code": "2222"}],
    )
    assert [f["id"] for f in a["felder"]] == ["ende1", "ende2"]
    t1, t2 = token(a, 1), token(a, 2)
    for _ in range(5):
        kunde.post(f"/s/{t1}/code", json={"code": "2222"})  # fremder Code zählt nicht
    assert kunde.post(f"/s/{t1}/code", json={"code": "1111"}).status_code == 423
    z2 = kunde.post(f"/s/{t2}/code", json={"code": "2222"}).json()["zugang"]
    assert kunde.post(f"/s/{t2}/unterschreiben", json={"name": "Erika Muster", "zustimmung": True, "unterschriften": {"ende2": {"png": PNG}}, "zugang": z2}).json()["fertig"] is False
    detail = intern.post(f"/api/auftraege/{a['id']}/entsperren", json={"nr": 1}).json()
    assert [p["gesperrt"] for p in detail["personen"]] == [False, False]
    z1 = kunde.post(f"/s/{t1}/code", json={"code": "1111"}).json()["zugang"]
    assert kunde.post(f"/s/{t1}/unterschreiben", json={"name": "Max Muster", "zustimmung": True, "unterschriften": {"ende1": {"text": "Max Muster"}}, "zugang": z1}).json()["fertig"] is True


def test_alter_auftrag_wird_uebernommen(tmp_path):
    """Aufträge aus 0.1.0 (Feldtest) laufen nach dem Update weiter."""
    ordner = tmp_path / "auftraege" / "20261024-abcdef12"
    ordner.mkdir(parents=True)
    pdf = beispiel_pdf()
    (ordner / "original.pdf").write_bytes(pdf)
    import hashlib

    alt = {
        "id": "20261024-abcdef12", "token": "t" * 43, "titel": "Alt", "dateiname": "Alt", "nachricht": "",
        "erstellt": "2026-10-24T10:00:00+00:00", "erstellt_von": "JB", "gueltig_bis": "2099-01-01T00:00:00+00:00",
        "empfaenger": {"name": "Max Muster", "email": ""}, "hubspot": {"kontakt_id": "", "deal_id": "", "kontakt_name": ""},
        "code_hash": hashlib.sha256(b"20261024-abcdef12:4711").hexdigest(), "code_fehler": 0, "status": "offen",
        "seiten": [{"b": 595, "h": 842}, {"b": 595, "h": 842}],
        "felder": [{"id": "f1", "seite": 1, "rechteck": [0.1, 0.8, 0.4, 0.86], "art": "unterschrift", "beschriftung": "", "pflicht": True}],
        "sha_original": hashlib.sha256(pdf).hexdigest(), "sha_ergebnis": "", "unterzeichner": None,
        "ablage": {"hubspot_gesendet": "", "hubspot_fertig": "", "hubspot_fehler": "", "datei": ""}, "verlauf": [],
    }
    (ordner / "auftrag.json").write_text(json.dumps(alt))
    dienst = Dienst(tmp_path)
    kunde = TestClient(kunde_app(dienst))
    assert kunde.get("/s/" + "t" * 43 + "/daten").json()["code_noetig"] is True
    z = kunde.post("/s/" + "t" * 43 + "/code", json={"code": "4711"}).json()["zugang"]
    r = kunde.post("/s/" + "t" * 43 + "/unterschreiben", json={"name": "Max Muster", "zustimmung": True, "unterschriften": {"f1": {"png": PNG}}, "zugang": z})
    assert r.json()["fertig"] is True
