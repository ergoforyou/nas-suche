from __future__ import annotations

from pathlib import Path

import pymupdf
import pytest

from agentur_pdf.kern.bearbeitung import Bearbeitung, quelle_oeffnen
from agentur_pdf.kern.dokumente import DokumentFehler


def beschriftet(pfad: Path, praefix: str, anzahl: int) -> Path:
    doc = pymupdf.open()
    for i in range(anzahl):
        doc.new_page().insert_text((72, 72), f"{praefix}{i + 1}", fontsize=20)
    doc.save(pfad)
    return pfad


def texte(dok) -> list[str]:
    return [s.get_text().strip() for s in dok.doc]


@pytest.fixture()
def bearbeitung(speicher):
    return Bearbeitung(speicher)


@pytest.fixture()
def a(speicher, tmp_path):
    return speicher.oeffnen_pfad(str(beschriftet(tmp_path / "a.pdf", "A", 5)))


@pytest.fixture()
def b(speicher, tmp_path):
    return speicher.oeffnen_pfad(str(beschriftet(tmp_path / "b.pdf", "B", 3)))


def test_t3_seiten_zwischen_dokumenten_und_rueckgaengig(bearbeitung, a, b):
    """T3: Seiten 2–4 aus A in B zwischen Seite 1 und 2 ziehen; Rückgängig."""
    positionen = bearbeitung.uebertragen(a.id, [1, 2, 3], b.id, 1, verschieben=False)
    assert texte(b) == ["B1", "A2", "A3", "A4", "B2", "B3"]
    assert positionen == [1, 2, 3]
    assert texte(a) == ["A1", "A2", "A3", "A4", "A5"]  # Kopieren lässt A unverändert
    bearbeitung.rueckgaengig(b.id)
    assert texte(b) == ["B1", "B2", "B3"]
    bearbeitung.wiederholen(b.id)
    assert texte(b) == ["B1", "A2", "A3", "A4", "B2", "B3"]


def test_verschieben_zwischen_dokumenten_ein_schritt(bearbeitung, a, b):
    bearbeitung.uebertragen(a.id, [1, 2, 3], b.id, 1, verschieben=True)
    assert texte(a) == ["A1", "A5"]
    assert texte(b) == ["B1", "A2", "A3", "A4", "B2", "B3"]
    # Rückgängig in B stellt beide Dokumente wieder her (gemeinsamer Schritt)
    betroffen = bearbeitung.rueckgaengig(b.id)
    assert set(betroffen) == {a.id, b.id}
    assert texte(a) == ["A1", "A2", "A3", "A4", "A5"]
    assert texte(b) == ["B1", "B2", "B3"]


def test_nicht_alle_seiten_verschiebbar(bearbeitung, a, b):
    with pytest.raises(DokumentFehler, match="mindestens eine"):
        bearbeitung.uebertragen(b.id, [0, 1, 2], a.id, 0, verschieben=True)


def test_verschieben_innerhalb(bearbeitung, a):
    assert bearbeitung.verschieben(a.id, [0, 1], 4) == [2, 3]
    assert texte(a) == ["A3", "A4", "A1", "A2", "A5"]
    assert bearbeitung.verschieben(a.id, [4], 0) == [0]
    assert texte(a) == ["A5", "A3", "A4", "A1", "A2"]
    bearbeitung.rueckgaengig(a.id)
    bearbeitung.rueckgaengig(a.id)
    assert texte(a) == ["A1", "A2", "A3", "A4", "A5"]


def test_ans_ende_verschieben(bearbeitung, a):
    bearbeitung.verschieben(a.id, [0], 5)
    assert texte(a) == ["A2", "A3", "A4", "A5", "A1"]


def test_drehen_loeschen_duplizieren(bearbeitung, a):
    kennung_vorher = a.kennung(0)
    bearbeitung.drehen(a.id, [0, 2], 90)
    assert [s.rotation for s in a.doc] == [90, 0, 90, 0, 0]
    assert a.kennung(0) != kennung_vorher  # Render-Cache wird ungültig
    bearbeitung.loeschen(a.id, [1, 3])
    assert texte(a) == ["A1", "A3", "A5"]
    bearbeitung.duplizieren(a.id, [0])
    assert texte(a) == ["A1", "A1", "A3", "A5"]
    a.doc[1].set_rotation(0)  # Kopie ist eigenständig, Original bleibt gedreht
    assert a.doc[0].rotation == 90
    assert len(set(a.seiten_ids)) == 4


def test_loeschen_aller_seiten_verboten(bearbeitung, a):
    with pytest.raises(DokumentFehler):
        bearbeitung.loeschen(a.id, [0, 1, 2, 3, 4])
    assert a.doc.page_count == 5 and not a.zurueck


def test_leere_seite_und_datei_einfuegen(bearbeitung, a, tmp_path):
    bearbeitung.leere_seite(a.id, 1)
    assert texte(a)[:3] == ["A1", "", "A2"]
    bild = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 100, 50), 0)
    bild.clear_with(200)
    quelle = quelle_oeffnen(daten=bild.tobytes("png"), name="foto.png")
    assert bearbeitung.datei_einfuegen(a.id, 7, quelle) == 1  # ans Ende
    assert a.doc.page_count == 7


def test_rueckgaengig_stellt_kennungen_wieder_her(bearbeitung, a):
    vorher = [a.kennung(i) for i in range(5)]
    bearbeitung.loeschen(a.id, [2])
    bearbeitung.rueckgaengig(a.id)
    assert [a.kennung(i) for i in range(5)] == vorher
    assert not a.geaendert


def test_fehler_rollt_zurueck(bearbeitung, a):
    with pytest.raises(ZeroDivisionError):
        with bearbeitung.aendern("kaputt", a):
            a.doc.delete_page(0)
            1 / 0
    assert texte(a) == ["A1", "A2", "A3", "A4", "A5"] and not a.zurueck


def test_extrahieren(bearbeitung, a, speicher):
    neu = bearbeitung.extrahieren(a.id, [1, 2, 4])
    assert texte(neu) == ["A2", "A3", "A5"]
    assert neu.titel == "a – Seiten 2-3, 5.pdf" and neu.geaendert and neu.pfad is None


def test_teilen_nach_seitenanzahl(bearbeitung, a, tmp_path):
    ergebnis = bearbeitung.teilen(a.id, "seitenanzahl", 2)
    assert ergebnis["teile"] == 3
    namen = sorted(Path(d).name for d in ergebnis["dateien"])
    assert namen == ["a_Teil_01.pdf", "a_Teil_02.pdf", "a_Teil_03.pdf"]
    assert pymupdf.open(tmp_path / "a_Teil_03.pdf")[0].get_text().strip() == "A5"


def test_teilen_nach_lesezeichen(bearbeitung, a):
    a.doc.set_toc([[1, "Teil eins", 1], [1, "Teil zwei", 3], [2, "Unterpunkt", 4]])
    assert bearbeitung.teile_berechnen(a.id, "lesezeichen") == [[0, 1], [2, 3, 4]]


def test_leerseiten_finden_und_teilen(bearbeitung, a):
    bearbeitung.leere_seite(a.id, 2)
    # Leere Seite mit leichtem Scanrauschen in den Ecken ist trotzdem leer
    a.doc[2].draw_rect(pymupdf.Rect(2, 2, 10, 10), fill=(0, 0, 0))
    bearbeitung.leere_seite(a.id, 5)
    assert bearbeitung.leerseiten_finden(a.id) == [2, 5]
    assert bearbeitung.teile_berechnen(a.id, "leerseiten") == [[0, 1], [3, 4], [6]]


def test_speichern_und_speichern_unter(bearbeitung, a, tmp_path):
    bearbeitung.loeschen(a.id, [0])
    assert a.geaendert
    bearbeitung.speichern(a.id)
    assert not a.geaendert
    assert texte_datei(tmp_path / "a.pdf") == ["A2", "A3", "A4", "A5"]
    ziel = bearbeitung.speichern(a.id, str(tmp_path / "unter" / "neu"))
    assert ziel.endswith("neu.pdf") and a.titel == "neu.pdf"
    # Rückgängig nach dem Speichern markiert das Dokument wieder als geändert
    bearbeitung.rueckgaengig(a.id)
    assert a.geaendert


def test_ohne_pfad_speichern_braucht_ort(bearbeitung, speicher, a):
    neu = bearbeitung.extrahieren(a.id, [0])
    with pytest.raises(DokumentFehler, match="SPEICHERORT_FEHLT"):
        bearbeitung.speichern(neu.id)


def test_passwortschutz_bleibt_beim_speichern(bearbeitung, speicher, tmp_path):
    pfad = tmp_path / "geheim.pdf"
    doc = pymupdf.open()
    for i in range(2):
        doc.new_page().insert_text((72, 72), f"G{i}")
    doc.save(pfad, encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw="pw", owner_pw="pw")
    dok = speicher.oeffnen_pfad(str(pfad), "pw")
    bearbeitung.loeschen(dok.id, [0])
    bearbeitung.rueckgaengig(dok.id)
    bearbeitung.wiederholen(dok.id)
    bearbeitung.speichern(dok.id)
    wieder = pymupdf.open(pfad)
    assert wieder.needs_pass and wieder.authenticate("pw") and wieder.page_count == 1


def test_render_nach_verschieben_nicht_veraltet(bearbeitung, speicher, a):
    """Cache darf nach Umsortieren nicht das alte Bild für Position 0 liefern."""
    alt = speicher.render(a.id, 0, 0.5)
    bearbeitung.verschieben(a.id, [4], 0)
    assert speicher.render(a.id, 0, 0.5) != alt


def texte_datei(pfad: Path) -> list[str]:
    return [s.get_text().strip() for s in pymupdf.open(pfad)]


def test_render_mit_veralteter_kennung_abgelehnt(bearbeitung, speicher, a):
    alte = a.kennung(0)
    bearbeitung.verschieben(a.id, [0], 5)
    # gleiche Seite, jetzt an Position 4 – wird über die Kennung gefunden
    assert speicher.render(a.id, 0, 0.5, kennung=alte) == speicher.render(a.id, 4, 0.5)
    bearbeitung.drehen(a.id, [4], 90)
    with pytest.raises(DokumentFehler, match="VERALTET"):
        speicher.render(a.id, 4, 0.5, kennung=alte)
