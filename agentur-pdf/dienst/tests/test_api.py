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


def test_t3_ueber_api(client, tmp_path):
    from test_bearbeitung import beschriftet

    a = client.post("/api/dokumente/oeffnen", json={"pfad": str(beschriftet(tmp_path / "a.pdf", "A", 5))}).json()
    b = client.post("/api/dokumente/oeffnen", json={"pfad": str(beschriftet(tmp_path / "b.pdf", "B", 3))}).json()
    r = client.post(
        "/api/seiten/uebertragen",
        json={"quelle": a["id"], "seiten": [1, 2, 3], "ziel": b["id"], "position": 1, "verschieben": False},
    ).json()
    ziel = r["dokumente"][0]
    assert ziel["seitenanzahl"] == 6 and ziel["geaendert"] and ziel["rueckgaengig"] == "Seiten kopieren"
    assert r["auswahl"] == [1, 2, 3]
    r = client.post(f"/api/dokumente/{b['id']}/rueckgaengig").json()
    assert r["dokumente"][0]["seitenanzahl"] == 3 and r["dokumente"][0]["wiederholen"] == "Seiten kopieren"


def test_einfuegen_hochgeladen_und_download(client, brief, tmp_path):
    info = client.post("/api/dokumente/oeffnen", json={"pfad": str(brief)}).json()
    r = client.post(
        f"/api/dokumente/{info['id']}/seiten/einfuegen_datei",
        params={"position": 0, "name": "zweit.pdf"},
        content=brief.read_bytes(),
    ).json()
    assert r["dokumente"][0]["seitenanzahl"] == 6 and r["auswahl"] == [0, 1, 2]
    pdf = client.get(f"/api/dokumente/{info['id']}/datei")
    assert pdf.headers["content-type"] == "application/pdf"
    assert pymupdf.open("pdf", pdf.content).page_count == 6


def test_speichern_ohne_dialog_im_browser(client):
    assert client.post("/api/dialog/speichern", json={"vorschlag": "x.pdf"}).json() == {"verfuegbar": False, "pfad": None}


def _warten(client, auftrag_id, zeit=30):
    import time as _t

    ende = _t.time() + zeit
    while _t.time() < ende:
        for a in client.get("/api/auftraege").json():
            if a["id"] == auftrag_id and a["status"] not in ("wartet", "laeuft"):
                return a
        _t.sleep(0.05)
    raise AssertionError("Auftrag nicht fertig")


def test_zusammenfuehren_ueber_api_mit_upload(client, brief, tmp_path):
    from PIL import Image

    png = tmp_path / "s.png"
    Image.new("RGB", (100, 100)).save(png)
    up = client.post("/api/uploads", params={"name": "s.png"}, content=png.read_bytes()).json()
    a = client.post(
        "/api/zusammenfuehren", json={"eintraege": [{"pfad": str(brief)}, {"upload": up["id"]}], "lesezeichen": True}
    ).json()
    fertig = _warten(client, a["id"])
    assert fertig["status"] == "fertig", fertig
    dok_id = fertig["ergebnis"]["dokumente"][0]
    info = client.get(f"/api/dokumente/{dok_id}").json()
    assert info["seitenanzahl"] == 4 and info["geaendert"] and info["ordner"] == str(tmp_path)
    # Fertiger Auftrag wird als Ereignis gemeldet (einmalig)
    ereignisse = client.get("/api/ereignisse").json()["ereignisse"]
    assert any(e["art"] == "auftrag" and e["auftrag"]["id"] == a["id"] for e in ereignisse)
    assert not client.get("/api/ereignisse").json()["ereignisse"]


def test_zusammenfuehren_fehler_wird_gemeldet(client, tmp_path):
    kaputt = tmp_path / "kaputt.pdf"
    kaputt.write_bytes(b"keine pdf")
    a = client.post("/api/zusammenfuehren", json={"eintraege": [{"pfad": str(kaputt)}]}).json()
    fertig = _warten(client, a["id"])
    assert fertig["status"] == "fehler" and "kaputt.pdf" in fertig["fehler"]


def test_extern_sammelt_explorer_aufrufe(client, brief, tmp_path):
    """Explorer startet je markierter Datei einen Aufruf – alle landen in EINEM Dialog."""
    import time as _t

    zweite = tmp_path / "zweite.pdf"
    zweite.write_bytes(brief.read_bytes())
    client.post("/api/extern", json={"aktion": "zusammenfuehren", "dateien": [str(zweite)]})
    client.post("/api/extern", json={"aktion": "zusammenfuehren", "dateien": [str(brief)]})
    _t.sleep(1.2)
    ereignisse = [e for e in client.get("/api/ereignisse").json()["ereignisse"] if e["art"] == "zusammenfuehren"]
    assert len(ereignisse) == 1
    assert ereignisse[0]["dateien"] == [str(brief), str(zweite)]


def test_extern_oeffnen(client, brief):
    client.post("/api/extern", json={"aktion": "oeffnen", "dateien": [str(brief)]})
    ereignisse = client.get("/api/ereignisse").json()["ereignisse"]
    assert ereignisse[0]["art"] == "oeffnen" and len(ereignisse[0]["dokumente"]) == 1


def test_docx_direkt_oeffnen_verweist_auf_umwandeln(client, tmp_path):
    p = tmp_path / "x.docx"
    p.write_bytes(b"x")
    assert "umgewandelt" in client.post("/api/dokumente/oeffnen", json={"pfad": str(p)}).json()["fehler"]


def test_ocr_ueber_api(client, tmp_path):
    import scan_hilfen
    import testdaten
    from agentur_pdf.kern import ocr as _ocr

    if _ocr.tesseract_finden() is None:
        import pytest

        pytest.skip("Tesseract fehlt")
    status = client.get("/api/ocr/status").json()
    assert status["verfuegbar"] and "deu" in status["sprachen"]
    quelle = pymupdf.open(testdaten.versicherungsbrief(tmp_path / "b.pdf", seiten=2))
    scan_hilfen.als_scan(quelle).save(tmp_path / "s.pdf")
    info = client.post("/api/dokumente/oeffnen", json={"pfad": str(tmp_path / "s.pdf")}).json()
    assert client.get(f"/api/dokumente/{info['id']}/textstatus").json() == {"seiten": 2, "ohne_text": 2, "erste_ohne_text": [0]}
    a = client.post(f"/api/dokumente/{info['id']}/ocr", json={}).json()
    fertig = _warten(client, a["id"], 120)
    assert fertig["status"] == "fertig", fertig
    assert fertig["ergebnis"]["ocr"]["erkannt"] == 2 and fertig["ergebnis"]["aktualisieren"]
    assert client.get(f"/api/dokumente/{info['id']}/textstatus").json()["ohne_text"] == 0
    assert len(client.get(f"/api/dokumente/{info['id']}/suche", params={"q": "Prämie"}).json()) == 2
    # Bereichs-OCR: oberer Teil der ersten Seite
    text = client.post(f"/api/dokumente/{info['id']}/ocr/bereich", json={"seite": 0, "rechteck": [0.05, 0.05, 0.8, 0.13]}).json()["text"]
    assert "Versicherungsschein" in text


def test_ueberwachung_einstellen(client, tmp_path):
    assert client.put("/api/ueberwachung", json=[{"ordner": str(tmp_path / "fehlt")}]).status_code == 400
    r = client.put("/api/ueberwachung", json=[{"ordner": str(tmp_path), "original_sichern": False}]).json()
    assert r["regeln"][0]["ordner"] == str(tmp_path) and r["regeln"][0]["original_sichern"] is False
    assert client.get("/api/einstellungen").json()["ueberwachung"][0]["leerseiten_entfernen"] is True
    client.put("/api/ueberwachung", json=[])
