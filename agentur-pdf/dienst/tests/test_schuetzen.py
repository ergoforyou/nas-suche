"""Schützen & Ausgabe: Schwärzen (T6), Kennwort, Drucken/Export mit Ebenen
(T8), Komprimieren, Metadaten, Formulare, Foto-Entzerrung."""

from __future__ import annotations

import io

import numpy as np
import pymupdf
import pytest
from PIL import Image, ImageDraw

from agentur_pdf.kern import foto

IBAN = "DE89 3704 0044 0532 0130 00"


def oeffnen(client, pfad) -> str:
    return client.post("/api/dokumente/oeffnen", json={"pfad": str(pfad)}).json()["id"]


def iban_dokument(pfad, mit_ocr_ebene: bool = False):
    doc = pymupdf.open()
    seite = doc.new_page()
    seite.insert_text((72, 100), "Bankverbindung des Versicherungsnehmers", fontsize=12)
    seite.insert_text((72, 130), f"IBAN: {IBAN}", fontsize=12)
    seite.insert_text((72, 160), "E-Mail: kunde@example.de, Telefon 0711 123456", fontsize=12)
    seite.insert_text((72, 190), "Geboren am 03.04.1975", fontsize=12)
    if mit_ocr_ebene:
        # unsichtbarer Text auf eigener Ebene (wie nach der Texterkennung)
        ebene = doc.add_ocg("OCR-Text", on=True)
        tw = pymupdf.TextWriter(seite.rect)
        tw.append((72, 250), f"Kontonummer {IBAN}", fontsize=12)
        tw.write_text(seite, render_mode=3, oc=ebene)
    doc.save(pfad)
    doc.close()
    return pfad


# ------------------------------------------------------------------- T6
@pytest.mark.parametrize("mit_ocr_ebene", [False, True])
def test_t6_geschwaerzte_iban_nicht_mehr_auslesbar(client, tmp_path, mit_ocr_ebene):
    dok_id = oeffnen(client, iban_dokument(tmp_path / "iban.pdf", mit_ocr_ebene))
    funde = client.post(f"/api/dokumente/{dok_id}/schwaerzen/suchen", json={"muster": "iban"}).json()
    assert len(funde) == (2 if mit_ocr_ebene else 1)
    assert all(f["text"] == IBAN for f in funde)
    client.post(f"/api/dokumente/{dok_id}/schwaerzen/vormerken", json={"eintraege": funde})
    # Vorgemerkt: noch lesbar, als Schwärzung markiert
    liste = client.get(f"/api/dokumente/{dok_id}/anmerkungen").json()["0"]
    assert {e["art"] for e in liste} == {"schwaerzung"}
    r = client.post(f"/api/dokumente/{dok_id}/schwaerzen/anwenden", json={"metadaten": True})
    assert r.status_code == 200 and r.json()["seiten"] == [0]
    ziel = tmp_path / "geschwaerzt.pdf"
    client.post(f"/api/dokumente/{dok_id}/speichern", json={"pfad": str(ziel)})
    doc = pymupdf.open(ziel)
    text = doc[0].get_text()
    assert "3704" not in text and "DE89" not in text
    assert "Bankverbindung" in text  # Rest bleibt erhalten
    # auch in den Rohdaten (unkomprimiert) nicht mehr enthalten
    roh = doc.tobytes(expand=255)
    assert b"3704" not in roh
    doc.close()


def test_schwaerzen_muster(client, tmp_path):
    dok_id = oeffnen(client, iban_dokument(tmp_path / "iban.pdf"))
    suche = lambda m, b="": client.post(f"/api/dokumente/{dok_id}/schwaerzen/suchen", json={"muster": m, "begriff": b}).json()  # noqa: E731
    assert [f["text"] for f in suche("email")] == ["kunde@example.de"]
    assert [f["text"] for f in suche("telefon")] == ["0711 123456"]
    assert [f["text"] for f in suche("datum")] == ["03.04.1975"]
    assert len(suche("begriff", "versicherungsnehmers")) == 1


def test_schwaerzen_ohne_vormerkung_meldet_fehler(client, brief):
    dok_id = oeffnen(client, brief)
    r = client.post(f"/api/dokumente/{dok_id}/schwaerzen/anwenden", json={})
    assert r.status_code == 400 and "keine Schwärzungen" in r.json()["fehler"]


# ---------------------------------------------------------------- Kennwort
def test_kennwortschutz_setzen_und_entfernen(client, brief, tmp_path):
    dok_id = oeffnen(client, brief)
    client.put(f"/api/dokumente/{dok_id}/schutz", json={"benutzer": "geheim1", "drucken": True, "kopieren": False})
    assert client.get(f"/api/dokumente/{dok_id}").json()["schutz"] == "kennwort"
    ziel = tmp_path / "geschuetzt.pdf"
    client.post(f"/api/dokumente/{dok_id}/speichern", json={"pfad": str(ziel)})
    doc = pymupdf.open(ziel)
    assert doc.needs_pass and doc.authenticate("geheim1")
    doc.close()
    # erneut speichern behält den Schutz
    client.post(f"/api/dokumente/{dok_id}/seiten/drehen", json={"seiten": [0], "grad": 90})
    client.post(f"/api/dokumente/{dok_id}/speichern", json={})
    assert pymupdf.open(ziel).needs_pass
    # Schutz entfernen
    client.put(f"/api/dokumente/{dok_id}/schutz", json={"aus": True})
    client.post(f"/api/dokumente/{dok_id}/speichern", json={})
    doc = pymupdf.open(ziel)
    assert not doc.needs_pass and doc.page_count == 3
    doc.close()


def test_nur_rechte_kennwort(client, brief, tmp_path):
    dok_id = oeffnen(client, brief)
    client.put(f"/api/dokumente/{dok_id}/schutz", json={"besitzer": "chef123", "drucken": False})
    ziel = tmp_path / "rechte.pdf"
    client.post(f"/api/dokumente/{dok_id}/speichern", json={"pfad": str(ziel)})
    doc = pymupdf.open(ziel)
    assert not doc.needs_pass  # öffnen ohne Kennwort
    assert not doc.permissions & pymupdf.PDF_PERM_PRINT
    doc.close()


def test_geschuetzte_datei_wieder_oeffnen(client, brief, tmp_path):
    dok_id = oeffnen(client, brief)
    client.put(f"/api/dokumente/{dok_id}/schutz", json={"benutzer": "abcd"})
    ziel = tmp_path / "zu.pdf"
    client.post(f"/api/dokumente/{dok_id}/speichern", json={"pfad": str(ziel)})
    client.delete(f"/api/dokumente/{dok_id}")
    r = client.post("/api/dokumente/oeffnen", json={"pfad": str(ziel)})
    assert r.json()["fehler"] == "PASSWORT_ERFORDERLICH"
    assert client.post("/api/dokumente/oeffnen", json={"pfad": str(ziel), "passwort": "abcd"}).json()["seitenanzahl"] == 3


# ------------------------------------------------------------------- T8
def test_t8_drucken_ohne_kommentare(client, brief):
    dok_id = oeffnen(client, brief)
    for art, daten in (
        ("notiz", {"punkt": [0.8, 0.1], "inhalt": "intern"}),
        ("schreibmaschine", {"punkt": [0.1, 0.9], "text": "Eintrag"}),
        ("stempel", {"punkt": [0.5, 0.5], "text": "ERLEDIGT"}),
    ):
        client.post(f"/api/dokumente/{dok_id}/anmerkungen", json={"seite": 0, "art": art, **daten})
    r = client.post(f"/api/dokumente/{dok_id}/ausgabe", json={"gruppen_weg": ["kommentar"]}).json()
    pdf = client.get(r["url"])
    assert pdf.headers["content-type"] == "application/pdf"
    doc = pymupdf.open("pdf", pdf.content)
    arten = sorted(a.type[1] for a in doc[0].annots())
    assert arten == ["FreeText", "FreeText"]  # Eintragung + Stempel, keine Notiz
    doc.close()
    # nur bestimmte Seiten, ohne alles
    r = client.post(f"/api/dokumente/{dok_id}/ausgabe", json={"seiten": [0, 2], "gruppen_weg": ["kommentar", "eintragung", "stempel"]}).json()
    doc = pymupdf.open("pdf", client.get(r["url"]).content)
    assert doc.page_count == 2 and doc[0].first_annot is None
    doc.close()
    # Original bleibt unverändert
    assert len(client.get(f"/api/dokumente/{dok_id}/anmerkungen").json()["0"]) == 3


def test_t8_export_mit_ausgeblendeter_ebene(client, tmp_path):
    dok_id = oeffnen(client, iban_dokument(tmp_path / "ebene.pdf", mit_ocr_ebene=True))
    (ebene,) = client.get(f"/api/dokumente/{dok_id}/ebenen").json()
    assert ebene["name"] == "OCR-Text" and ebene["an"]
    # ausgeblendet exportieren: Ebene bleibt drin, ist aber aus
    ziel = tmp_path / "export.pdf"
    client.post(f"/api/dokumente/{dok_id}/ausgabe", json={"ebenen_aus": [ebene["id"]], "pfad": str(ziel)})
    doc = pymupdf.open(ziel)
    ((_, e),) = doc.get_ocgs().items()
    assert e["on"] is False
    doc.close()
    # ausgeblendete Ebene beim Export entfernen: Text der Ebene ist weg
    ziel2 = tmp_path / "export2.pdf"
    client.post(f"/api/dokumente/{dok_id}/ausgabe", json={"ebenen_aus": [ebene["id"]], "ebenen_entfernen": True, "pfad": str(ziel2)})
    doc = pymupdf.open(ziel2)
    text = doc[0].get_text()
    assert "Kontonummer" not in text and "Bankverbindung" in text
    doc.close()


def test_ebene_in_der_ansicht_umschalten(client, tmp_path):
    dok_id = oeffnen(client, iban_dokument(tmp_path / "ebene.pdf", mit_ocr_ebene=True))
    (ebene,) = client.get(f"/api/dokumente/{dok_id}/ebenen").json()
    vorher = client.get(f"/api/dokumente/{dok_id}").json()["kennungen"][0]
    info = client.put(f"/api/dokumente/{dok_id}/ebenen/{ebene['id']}", json={"an": False}).json()["dokumente"][0]
    assert info["kennungen"][0] != vorher
    assert client.get(f"/api/dokumente/{dok_id}/ebenen").json()[0]["an"] is False


# -------------------------------------------------------------- Komprimieren
def test_komprimieren_verkleinert_grosse_bilder(client, tmp_path):
    rauschen = (np.random.default_rng(1).random((2400, 1800, 3)) * 255).astype(np.uint8)
    puffer = io.BytesIO()
    Image.fromarray(rauschen).save(puffer, "PNG")
    doc = pymupdf.open()
    seite = doc.new_page()
    seite.insert_image(seite.rect, stream=puffer.getvalue())
    pfad = tmp_path / "gross.pdf"
    doc.save(pfad)
    doc.close()
    dok_id = oeffnen(client, pfad)
    r = client.post(f"/api/dokumente/{dok_id}/komprimieren", json={"stufe": "stark"}).json()
    assert r["geaendert"] and r["nachher"] < r["vorher"] / 3
    assert client.get(f"/api/dokumente/{dok_id}").json()["rueckgaengig"] == "Komprimieren"


# ---------------------------------------------------------------- Metadaten
def test_eigenschaften_und_metadaten_entfernen(client, brief):
    dok_id = oeffnen(client, brief)
    client.put(f"/api/dokumente/{dok_id}/eigenschaften", json={"titel": "Angebot", "autor": "Agentur"})
    e = client.get(f"/api/dokumente/{dok_id}/eigenschaften").json()
    assert e["titel"] == "Angebot" and e["autor"] == "Agentur" and e["seiten"] == 3
    client.post(f"/api/dokumente/{dok_id}/metadaten_entfernen")
    e = client.get(f"/api/dokumente/{dok_id}/eigenschaften").json()
    assert e["titel"] == "" and e["autor"] == ""


# ---------------------------------------------------------------- Formulare
def test_formular_ausfuellen(client, tmp_path):
    doc = pymupdf.open()
    seite = doc.new_page()
    for typ, name, rechteck in (
        (pymupdf.PDF_WIDGET_TYPE_TEXT, "Name", (72, 72, 300, 92)),
        (pymupdf.PDF_WIDGET_TYPE_CHECKBOX, "Einverstanden", (72, 110, 86, 124)),
    ):
        w = pymupdf.Widget()
        w.field_type = typ
        w.field_name = name
        w.rect = pymupdf.Rect(rechteck)
        if typ == pymupdf.PDF_WIDGET_TYPE_TEXT:
            w.field_value = ""
        seite.add_widget(w)
    pfad = tmp_path / "formular.pdf"
    doc.save(pfad)
    doc.close()
    dok_id = oeffnen(client, pfad)
    felder = client.get(f"/api/dokumente/{dok_id}/formular").json()["0"]
    name = next(f for f in felder if f["name"] == "Name")
    haken = next(f for f in felder if f["name"] == "Einverstanden")
    assert name["typ"] == "text" and haken["typ"] == "ankreuzen" and haken["wert"] is False
    client.put(f"/api/dokumente/{dok_id}/formular/{name['id']}", json={"seite": 0, "wert": "Müller"})
    client.put(f"/api/dokumente/{dok_id}/formular/{haken['id']}", json={"seite": 0, "wert": True})
    felder = {f["name"]: f for f in client.get(f"/api/dokumente/{dok_id}/formular").json()["0"]}
    assert felder["Name"]["wert"] == "Müller" and felder["Einverstanden"]["wert"] is True
    ziel = tmp_path / "ausgefuellt.pdf"
    client.post(f"/api/dokumente/{dok_id}/speichern", json={"pfad": str(ziel)})
    doc = pymupdf.open(ziel)
    werte = {w.field_name: w.field_value for w in doc[0].widgets()}
    assert werte["Name"] == "Müller" and werte["Einverstanden"] not in (False, "Off")
    doc.close()


# ----------------------------------------------------------------- Fotos
def handyfoto() -> tuple[bytes, list[list[float]]]:
    """Weißes Blatt mit Text, schräg fotografiert auf dunklem Tisch."""
    import cv2

    blatt = Image.new("RGB", (840, 1188), "white")
    d = ImageDraw.Draw(blatt)
    for i in range(20):
        d.rectangle([80, 100 + i * 50, 700, 120 + i * 50], fill=(40, 40, 40))
    quelle = np.float32([[0, 0], [840, 0], [840, 1188], [0, 1188]])
    ecken = np.float32([[260, 180], [1180, 260], [1120, 1500], [180, 1420]])
    m = cv2.getPerspectiveTransform(quelle, ecken)
    tisch = np.full((1700, 1400, 3), (70, 55, 45), np.uint8)
    warp = cv2.warpPerspective(np.asarray(blatt), m, (1400, 1700), borderMode=cv2.BORDER_TRANSPARENT, dst=tisch.copy())
    # Schatten von links
    warp = (warp.astype(np.float32) * np.linspace(0.7, 1.0, 1400)[None, :, None]).astype(np.uint8)
    puffer = io.BytesIO()
    Image.fromarray(warp).save(puffer, "JPEG", quality=90)
    return puffer.getvalue(), [[x / 1400, y / 1700] for x, y in ecken]


def test_foto_ecken_finden_und_entzerren():
    daten, wahr = handyfoto()
    gefunden = foto.ecken_finden(daten)
    assert gefunden["gefunden"]
    for (x, y), (wx, wy) in zip(gefunden["ecken"], wahr):
        assert abs(x - wx) < 0.03 and abs(y - wy) < 0.03
    bild, format_ = foto.entzerren(daten, gefunden["ecken"], "dokument")
    im = Image.open(io.BytesIO(bild))
    assert format_ == "jpeg"
    assert 1.3 < im.height / im.width < 1.5  # A4-Seitenverhältnis 1,41
    grau = np.asarray(im.convert("L"))
    # Schatten entfernt: Papier links wie rechts fast weiß
    assert grau[:, : im.width // 10].mean() > 200 and grau[:, -im.width // 10 :].mean() > 200
    sw, format_ = foto.entzerren(daten, gefunden["ecken"], "sw")
    assert format_ == "png" and Image.open(io.BytesIO(sw)).mode == "1"


def test_foto_ueber_api_als_seite(client, brief):
    daten, _ = handyfoto()
    dok_id = oeffnen(client, brief)
    hoch = client.post("/api/bilder", content=daten).json()
    ecken = client.post("/api/foto/ecken", json={"bild_id": hoch["id"]}).json()
    fertig = client.post("/api/foto/entzerren", json={"bild_id": hoch["id"], "ecken": ecken["ecken"], "filter": "dokument"}).json()
    assert fertig["bild"].startswith("data:image/jpeg")
    r = client.post(f"/api/dokumente/{dok_id}/seiten/bild_einsetzen", json={"bild_id": fertig["id"], "position": 1}).json()
    assert r["dokumente"][0]["seitenanzahl"] == 4
    neu = client.post(f"/api/bilder/{fertig['id']}/als_dokument", json={"name": "Foto"}).json()["neu"][0]
    assert neu["seitenanzahl"] == 1 and neu["titel"] == "Foto.pdf"


def test_bilder_export(client, brief):
    dok_id = oeffnen(client, brief)
    r = client.post(f"/api/dokumente/{dok_id}/bilder_export", json={"seiten": [0], "dpi": 100, "format": "jpg"}).json()
    antwort = client.get(r["url"])
    assert antwort.headers["content-type"] == "image/jpeg" and "attachment" in antwort.headers["content-disposition"]
    r = client.post(f"/api/dokumente/{dok_id}/bilder_export", json={"seiten": [0, 1], "dpi": 72, "format": "png"}).json()
    assert r["name"].endswith(".zip")
