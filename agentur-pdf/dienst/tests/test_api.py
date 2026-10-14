from __future__ import annotations

import pymupdf

from conftest import TOKEN


def test_ohne_token_abgelehnt(client):
    del client.headers["X-Agentur-Token"]
    assert client.get("/api/status").status_code == 401
    assert client.get(f"/api/status?t={TOKEN}").status_code == 200


def test_fremder_host_abgelehnt(client):
    assert client.get("/api/status", headers={"Host": "angreifer.example"}).status_code == 403


def test_oeffnen_rendern_suchen(client, brief):
    info = client.post("/api/dokumente/oeffnen", json={"pfad": str(brief)}).json()
    assert info["seitenanzahl"] == 3
    dok_id = info["id"]
    bild = client.get(f"/api/dokumente/{dok_id}/seiten/1/bild", params={"skala": 0.5})
    assert bild.status_code == 200 and bild.headers["content-type"] == "image/png"
    assert pymupdf.Pixmap(bild.content).width == 298
    kachel = client.get(f"/api/dokumente/{dok_id}/seiten/1/bild", params={"skala": 2, "x": 0, "y": 0, "b": 256, "h": 256})
    assert pymupdf.Pixmap(kachel.content).width == 256
    assert len(client.get(f"/api/dokumente/{dok_id}/suche", params={"q": "Prämie"}).json()) == 3
    assert client.get(f"/api/dokumente/{dok_id}/lesezeichen").json()[0]["titel"] == "Abschnitt 1"
    # zuletzt geöffnet wird gepflegt
    assert client.get("/api/zuletzt").json()[0]["pfad"] == str(brief)
    assert client.delete(f"/api/dokumente/{dok_id}").json() == {"ok": True}
    assert client.get(f"/api/dokumente/{dok_id}").status_code == 400


def test_hochladen(client, brief):
    info = client.post("/api/dokumente/hochladen", params={"name": "brief.pdf"}, content=brief.read_bytes()).json()
    assert info["seitenanzahl"] == 3 and info["pfad"] is None


def test_fehlermeldung_deutsch(client, tmp_path):
    antwort = client.post("/api/dokumente/oeffnen", json={"pfad": str(tmp_path / "x.pdf")})
    assert antwort.status_code == 400 and "nicht gefunden" in antwort.json()["fehler"]


def test_einstellungen_sitzung_favoriten(client, tmp_path):
    assert client.get("/api/einstellungen").json()["design"] == "hell"
    assert client.put("/api/einstellungen", json={"design": "dunkel", "boese": 1}).json()["design"] == "dunkel"
    assert "boese" not in client.get("/api/einstellungen").json()
    client.put("/api/sitzung", json={"dokumente": [{"pfad": "a.pdf", "seite": 2}], "aktiv": 0})
    assert client.get("/api/sitzung").json()["dokumente"][0]["seite"] == 2
    assert client.put("/api/favoriten", json=[str(tmp_path)]).json() == [str(tmp_path)]


def test_ordner_listet_pdfs(client, brief, tmp_path):
    (tmp_path / "notiz.txt").write_text("x")
    inhalt = client.get("/api/ordner", params={"pfad": str(tmp_path)}).json()
    assert [d["name"] for d in inhalt["dateien"]] == ["brief.pdf"]
