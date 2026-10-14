"""Kommentieren & Bearbeiten: Anmerkungen anlegen/ändern/löschen, Bilder mit
Freistellung (T4), Rechtschreibprüfung (T5), Textauswahl."""

from __future__ import annotations

import io

import numpy as np
import pymupdf
import pytest
from PIL import Image, ImageDraw

from agentur_pdf.api.erweiterungen import rechtschreibung_pruefen
from agentur_pdf.kern import anmerkungen, bilder
from agentur_pdf.kern.woerterbuch import woerterbuch


def oeffnen(client, pfad) -> str:
    return client.post("/api/dokumente/oeffnen", json={"pfad": str(pfad)}).json()["id"]


def liste(client, dok_id) -> dict:
    return client.get(f"/api/dokumente/{dok_id}/anmerkungen").json()


def anlegen(client, dok_id, **daten) -> int:
    r = client.post(f"/api/dokumente/{dok_id}/anmerkungen", json=daten)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_alle_arten_anlegen_und_lesen(client, brief):
    dok_id = oeffnen(client, brief)
    kennung_vorher = client.get(f"/api/dokumente/{dok_id}").json()["kennungen"][0]
    anlegen(client, dok_id, seite=0, art="rechteck", rechteck=[0.1, 0.1, 0.3, 0.2], farbe="#ff0000")
    anlegen(client, dok_id, seite=0, art="ellipse", rechteck=[0.4, 0.1, 0.6, 0.2])
    anlegen(client, dok_id, seite=0, art="pfeil", punkte=[[0.1, 0.5], [0.4, 0.6]])
    anlegen(client, dok_id, seite=0, art="freihand", striche=[[[0.1, 0.7], [0.2, 0.72], [0.3, 0.7]]])
    anlegen(client, dok_id, seite=0, art="notiz", punkt=[0.8, 0.1], inhalt="Bitte Kunden anrufen")
    anlegen(client, dok_id, seite=0, art="schreibmaschine", punkt=[0.1, 0.8], text="Eingetragen am Montag")
    anlegen(client, dok_id, seite=0, art="stempel", punkt=[0.6, 0.8], vorlage="EINGEGANGEN\n{datum} · {kuerzel}")
    anlegen(client, dok_id, seite=0, art="abdecken", rechteck=[0.7, 0.4, 0.9, 0.45])
    eintraege = liste(client, dok_id)["0"]
    arten = sorted(e["art"] for e in eintraege)
    assert arten == sorted(["rechteck", "ellipse", "pfeil", "freihand", "notiz", "schreibmaschine", "stempel", "abdecken"])
    gruppen = {e["art"]: e["gruppe"] for e in eintraege}
    assert gruppen["schreibmaschine"] == "eintragung" and gruppen["stempel"] == "stempel" and gruppen["notiz"] == "kommentar"
    rechteck = next(e for e in eintraege if e["art"] == "rechteck")
    assert rechteck["farbe"] == "#FF0000"
    assert rechteck["rechteck"] == pytest.approx([0.1, 0.1, 0.3, 0.2], abs=0.01)
    stempel = next(e for e in eintraege if e["art"] == "stempel")
    assert stempel["text"].startswith("EINGEGANGEN\n")
    # Seite wurde neu versioniert → Bild wird neu geladen
    assert client.get(f"/api/dokumente/{dok_id}").json()["kennungen"][0] != kennung_vorher
    # alles mit einem Schritt rückgängig je Anmerkung
    assert client.get(f"/api/dokumente/{dok_id}").json()["rueckgaengig"] == "Kommentar hinzufügen"


def test_hervorheben_ueber_woerter(client, brief):
    dok_id = oeffnen(client, brief)
    woerter = client.get(f"/api/dokumente/{dok_id}/seiten/0/woerter").json()
    praemie = next(w for w in woerter if w[4].startswith("Prämie"))
    anlegen(client, dok_id, seite=0, art="hervorheben", rechtecke=[praemie[:4]])
    (e,) = liste(client, dok_id)["0"]
    assert e["art"] == "hervorheben" and "Prämie" in e["text_darunter"]


def test_verschieben_und_text_aendern(client, brief):
    dok_id = oeffnen(client, brief)
    xref = anlegen(client, dok_id, seite=0, art="schreibmaschine", punkt=[0.1, 0.1], text="Versicherungsnehmer")
    alt = liste(client, dok_id)["0"][0]
    r = client.patch(f"/api/dokumente/{dok_id}/anmerkungen/{xref}", json={"seite": 0, "verschieben": [0.2, 0.3]})
    neu_id = r.json()["id"]
    neu = liste(client, dok_id)["0"][0]
    assert neu["id"] == neu_id and neu["text"] == "Versicherungsnehmer"
    assert neu["rechteck"][0] == pytest.approx(alt["rechteck"][0] + 0.2, abs=0.005)
    assert neu["rechteck"][1] == pytest.approx(alt["rechteck"][1] + 0.3, abs=0.005)
    r = client.patch(f"/api/dokumente/{dok_id}/anmerkungen/{neu_id}", json={"seite": 0, "text": "Neuer Text\nZweite Zeile", "farbe": "#0000ff"})
    geaendert = liste(client, dok_id)["0"][0]
    assert geaendert["text"] == "Neuer Text\nZweite Zeile" and geaendert["textfarbe"] == "#0000FF"
    # Höhe wächst mit der zweiten Zeile
    assert geaendert["rechteck"][3] - geaendert["rechteck"][1] > (neu["rechteck"][3] - neu["rechteck"][1]) * 1.6
    # Text steht wirklich im PDF (durchsuchbar über die Anmerkung)
    client.post(f"/api/dokumente/{dok_id}/anmerkungen/loeschen", json={"eintraege": [{"seite": 0, "id": geaendert["id"]}]})
    assert "0" not in liste(client, dok_id)
    client.post(f"/api/dokumente/{dok_id}/rueckgaengig")
    assert liste(client, dok_id)["0"][0]["text"] == "Neuer Text\nZweite Zeile"


def test_gedrehte_seite_koordinaten(client, tmp_path):
    import testdaten

    pfad = testdaten.gedrehtes_dokument(tmp_path / "gedreht.pdf")
    dok_id = oeffnen(client, pfad)
    info = client.get(f"/api/dokumente/{dok_id}").json()
    seite = next(i for i, s in enumerate(info["seiten"]) if s["drehung"])
    anlegen(client, dok_id, seite=seite, art="rechteck", rechteck=[0.1, 0.2, 0.3, 0.25], farbe="#ff0000")
    e = liste(client, dok_id)[str(seite)][0]
    assert e["rechteck"] == pytest.approx([0.1, 0.2, 0.3, 0.25], abs=0.01)
    # Und das Bild zeigt das Rechteck an der angezeigten Stelle
    png = client.get(f"/api/dokumente/{dok_id}/seiten/{seite}/bild", params={"skala": 1}).content
    pix = pymupdf.Pixmap(png)
    x = int(0.2 * pix.width)
    y = int(0.2 * pix.height)
    assert pix.pixel(x, y)[0] > 200 and pix.pixel(x, y)[1] < 80  # rote Kante oben


def test_gruppen_ausblenden_beim_rendern(client, brief):
    dok_id = oeffnen(client, brief)
    original = pymupdf.Pixmap(client.get(f"/api/dokumente/{dok_id}/seiten/0/bild", params={"skala": 0.5}).content)
    anlegen(client, dok_id, seite=0, art="rechteck", rechteck=[0.1, 0.1, 0.5, 0.3], farbe="#ff0000", fuellung="#ff0000")
    info = client.get(f"/api/dokumente/{dok_id}").json()
    params = {"skala": 0.5, "v": info["kennungen"][0]}
    mit = pymupdf.Pixmap(client.get(f"/api/dokumente/{dok_id}/seiten/0/bild", params=params).content)
    ohne = pymupdf.Pixmap(client.get(f"/api/dokumente/{dok_id}/seiten/0/bild", params={**params, "a": "kommentar"}).content)
    x, y = int(0.3 * mit.width), int(0.2 * mit.height)
    assert mit.pixel(x, y)[1] < 50 and ohne.pixel(x, y) == original.pixel(x, y)
    assert ohne.samples == original.samples
    # das Flag bleibt im Dokument unverändert
    assert liste(client, dok_id)["0"][0]["ausgeblendet"] is False


# ------------------------------------------------------------------ T4
def unterschrift_png(hintergrund=(255, 255, 255), verlauf: bool = False) -> bytes:
    im = Image.new("RGB", (600, 200), hintergrund)
    if verlauf:  # ungleichmäßig beleuchtetes Papier (Handyfoto)
        arr = np.asarray(im).astype(np.float32)
        arr *= np.linspace(0.75, 1.0, 600)[None, :, None]
        im = Image.fromarray(arr.astype(np.uint8))
    d = ImageDraw.Draw(im)
    for i in range(5):
        d.line([(50 + i * 100, 150), (100 + i * 100, 40), (150 + i * 100, 150)], fill=(20, 30, 120), width=6)
    puffer = io.BytesIO()
    im.save(puffer, "PNG")
    return puffer.getvalue()


@pytest.mark.parametrize("verlauf", [False, True])
def test_t4_freistellen_macht_hintergrund_durchsichtig(verlauf):
    ergebnis = Image.open(io.BytesIO(bilder.freistellen(unterschrift_png(verlauf=verlauf))))
    assert ergebnis.mode == "RGBA"
    alpha = np.asarray(ergebnis.getchannel("A"))
    rgb = np.asarray(ergebnis.convert("RGB")).astype(int)
    # Hintergrund (Ecken) durchsichtig, Strich deckend und blau (kein Grausaum)
    assert alpha[2, 2] == 0 and alpha[-3, -3] == 0
    deckend = alpha > 200
    assert deckend.mean() > 0.02
    assert (rgb[deckend][:, 2] > rgb[deckend][:, 0] + 40).mean() > 0.9
    # fast nichts halbtransparentes Graues im Hintergrund
    assert (alpha[(alpha > 0)] < 30).mean() < 0.3


def test_t4_unterschrift_auf_farbiger_seite(client, tmp_path):
    # Seite mit hellblauer Fläche: Hintergrund der Unterschrift darf sie nicht überdecken
    doc = pymupdf.open()
    seite = doc.new_page()
    seite.draw_rect(seite.rect, color=None, fill=(0.6, 0.8, 1.0))
    pfad = tmp_path / "blau.pdf"
    doc.save(pfad)
    doc.close()
    dok_id = oeffnen(client, pfad)
    hoch = client.post("/api/bilder", params={"freistellen": True}, content=unterschrift_png()).json()
    assert hoch["bild"].startswith("data:image/png;base64,")
    anlegen(client, dok_id, seite=0, art="unterschrift", bild_id=hoch["id"], rechteck=[0.1, 0.1, 0.7, 0.3])
    e = liste(client, dok_id)["0"][0]
    assert e["art"] == "unterschrift" and e["gruppe"] == "eintragung"
    info = client.get(f"/api/dokumente/{dok_id}").json()
    pix = pymupdf.Pixmap(client.get(f"/api/dokumente/{dok_id}/seiten/0/bild", params={"skala": 1, "v": info["kennungen"][0]}).content)
    # Ecke des Bildrechtecks: Seite bleibt blau (nicht weiß)
    r, g, b = pix.pixel(int(0.105 * pix.width), int(0.105 * pix.height))
    assert b > 200 and r < 200
    # In der Mitte ist die Unterschrift (dunkelblau) zu sehen
    ausschnitt = [pix.pixel(int(x * pix.width), int(y * pix.height)) for x in np.linspace(0.15, 0.65, 60) for y in np.linspace(0.12, 0.28, 30)]
    assert any(p[0] < 80 and p[2] > 100 for p in ausschnitt)
    # Unterschrift verschieben: Bild bleibt erhalten (in-place)
    client.patch(f"/api/dokumente/{dok_id}/anmerkungen/{e['id']}", json={"seite": 0, "rechteck": [0.2, 0.5, 0.8, 0.7]})
    e2 = liste(client, dok_id)["0"][0]
    assert e2["id"] == e["id"] and e2["rechteck"] == pytest.approx([0.2, 0.5, 0.8, 0.7], abs=0.01)


def test_unterschriften_bibliothek(client):
    hoch = client.post("/api/bilder", params={"freistellen": True}, content=unterschrift_png()).json()
    eintrag = client.post("/api/unterschriften", json={"bild_id": hoch["id"], "name": "Jens"}).json()
    (u,) = client.get("/api/unterschriften").json()
    assert u["id"] == eintrag["id"] and u["name"] == "Jens" and u["bild"].startswith("data:image/png")
    client.delete(f"/api/unterschriften/{u['id']}")
    assert client.get("/api/unterschriften").json() == []


# ------------------------------------------------------------------ T5
@pytest.mark.skipif(not woerterbuch().verfuegbar, reason="kein deutsches Wörterbuch installiert")
def test_t5_rechtschreibung_mit_vorschlag():
    import time

    start = time.monotonic()
    fehler = rechtschreibung_pruefen("Der Versicherugsnehmer hat die Prämie überwiesen.", mit_vorschlaegen=True)
    assert time.monotonic() - start < 5
    assert [f["wort"] for f in fehler] == ["Versicherugsnehmer"]
    assert fehler[0]["start"] == 4 and fehler[0]["ende"] == 22
    assert "Versicherungsnehmer" in fehler[0]["vorschlaege"]
    # Abkürzungen und korrekte Wörter werden nicht angemeckert
    assert rechtschreibung_pruefen("SEPA-Lastschriftmandat für die Kfz-Haftpflicht") == []


@pytest.mark.skipif(not woerterbuch().verfuegbar, reason="kein deutsches Wörterbuch installiert")
def test_rechtschreibung_ueber_api_und_woerterbuch(client, tmp_path, monkeypatch):
    r = client.post("/api/rechtschreibung", json={"text": "Bitte Agenturpostfachx prüfen"}).json()
    assert r == [{"start": 6, "ende": 22, "wort": "Agenturpostfachx"}]
    vorschlaege = client.post("/api/rechtschreibung/vorschlaege", json={"wort": "Agenturpostfachx"}).json()
    assert "Agenturpostfach" in vorschlaege
    client.post("/api/woerterbuch", json={"wort": "Agenturpostfachx"})
    assert client.post("/api/rechtschreibung", json={"text": "Agenturpostfachx"}).json() == []


def test_stempeltext_platzhalter():
    text = anmerkungen.stempel_text("EINGEGANGEN\n{datum} · {kuerzel}", "JK")
    assert text.startswith("EINGEGANGEN\n") and text.endswith("· JK") and text.count(".") == 2
