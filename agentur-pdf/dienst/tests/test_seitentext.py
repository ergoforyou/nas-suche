"""Wasserzeichen und Kopf-/Fußzeilen (eigene Ebenen, auch auf gedrehten Seiten)."""

from __future__ import annotations

import pymupdf
import testdaten


def oeffnen(client, pfad) -> str:
    return client.post("/api/dokumente/oeffnen", json={"pfad": str(pfad)}).json()["id"]


def test_wasserzeichen_auf_eigener_ebene(client, brief, tmp_path):
    dok_id = oeffnen(client, brief)
    r = client.post(f"/api/dokumente/{dok_id}/wasserzeichen", json={"text": "KOPIE", "deckkraft": 0.3})
    assert r.status_code == 200 and r.json()["anzahl"] == 3
    ebenen = client.get(f"/api/dokumente/{dok_id}/ebenen").json()
    assert [e["name"] for e in ebenen] == ["Wasserzeichen"]
    ziel = tmp_path / "wz.pdf"
    client.post(f"/api/dokumente/{dok_id}/speichern", json={"pfad": str(ziel)})
    doc = pymupdf.open(ziel)
    assert all("KOPIE" in s.get_text() for s in doc)
    doc.close()
    # Rückgängig entfernt es wieder
    client.post(f"/api/dokumente/{dok_id}/rueckgaengig")
    assert client.get(f"/api/dokumente/{dok_id}/ebenen").json() == []


def test_kopf_fuss_mit_seitenzahlen(client, brief, tmp_path):
    dok_id = oeffnen(client, brief)
    r = client.post(
        f"/api/dokumente/{dok_id}/kopf_fuss",
        json={"felder": {"unten_mitte": "Seite {seite} von {seiten}", "oben_rechts": "{datei}"}, "schriftgroesse": 9},
    )
    assert r.json()["anzahl"] == 3
    ziel = tmp_path / "kf.pdf"
    client.post(f"/api/dokumente/{dok_id}/speichern", json={"pfad": str(ziel)})
    doc = pymupdf.open(ziel)
    for i, s in enumerate(doc):
        text = s.get_text()
        assert f"Seite {i + 1} von 3" in text and "brief" in text
        # Seitenzahl unten, Dateiname oben
        unten = s.search_for(f"Seite {i + 1} von 3")[0]
        assert unten.y0 > s.rect.height * 0.9
        oben = s.search_for("brief")[0]
        assert oben.y1 < s.rect.height * 0.1 and oben.x0 > s.rect.width * 0.7
    doc.close()


def test_kopf_fuss_auf_gedrehter_seite(client, tmp_path):
    pfad = testdaten.gedrehtes_dokument(tmp_path / "gedreht.pdf")
    dok_id = oeffnen(client, pfad)
    client.post(f"/api/dokumente/{dok_id}/kopf_fuss", json={"felder": {"unten_rechts": "S. {seite}"}})
    client.post(f"/api/dokumente/{dok_id}/wasserzeichen", json={"text": "ENTWURF"})
    ziel = tmp_path / "g.pdf"
    client.post(f"/api/dokumente/{dok_id}/speichern", json={"pfad": str(ziel)})
    doc = pymupdf.open(ziel)
    for s in doc:
        treffer = s.search_for(f"S. {s.number + 1}")
        assert treffer
        anzeige = treffer[0] * s.rotation_matrix
        b, h = s.rect.width, s.rect.height
        # unten rechts auf der angezeigten Seite, Text waagerecht lesbar
        assert anzeige.x0 > b * 0.75 and anzeige.y0 > h * 0.85, (s.rotation, anzeige)
        zeilen = [l for blk in s.get_text("dict")["blocks"] for l in blk.get("lines", []) if "S." in "".join(sp["text"] for sp in l["spans"])]
        richtung = pymupdf.Point(zeilen[0]["dir"]) * pymupdf.Matrix(s.rotation)
        assert abs(richtung.x - 1) < 0.01, (s.rotation, zeilen[0]["dir"])
    doc.close()


def test_ohne_text_fehler(client, brief):
    dok_id = oeffnen(client, brief)
    assert client.post(f"/api/dokumente/{dok_id}/wasserzeichen", json={"text": " "}).status_code == 400
    assert client.post(f"/api/dokumente/{dok_id}/kopf_fuss", json={"felder": {}}).status_code == 400
