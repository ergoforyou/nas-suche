"""Texterkennung für ganze Dokumente, Seitenauswahl und Bereiche.

Rendern und Schreiben laufen im MuPDF-Thread, die eigentliche Erkennung
(Bildverarbeitung + Tesseract) parallel in mehreren Threads – bei einem
20-seitigen Scan rechnen so alle Prozessorkerne mit.
"""

from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Callable

import pymupdf

from . import ocr
from .auftraege import Auftrag
from .bearbeitung import Bearbeitung
from .dokumente import DokumentFehler, DokumentSpeicher
from .konvertierung import Mupdf

PARALLEL = max(1, min(6, (os.cpu_count() or 2) - 1))


@dataclass
class OcrOptionen:
    sprachen: str = "deu+eng"
    erzwingen: bool = False  # vorhandene Textebene ersetzen
    ausrichten: bool = True  # auf dem Kopf / quer liegende Seiten drehen
    entzerren: bool = True  # Schräglage ausgleichen


def _vorbereiten(doc: pymupdf.Document, nr: int, optionen: OcrOptionen) -> ocr.OcrAuftrag | str:
    """Im MuPDF-Thread: Seite prüfen und rendern. Liefert Auftrag oder Grund fürs Überspringen."""
    seite = doc[nr]
    if ocr.hat_text(seite):
        if not optionen.erzwingen:
            return "hat_text"
        if not ocr.ist_bildseite(seite):
            return "digital"  # echte Textseite – Erkennung würde nichts verbessern
    dpi, bildtyp = ocr.render_dpi(seite)
    bild, _ = ocr.seite_rendern(seite, dpi)
    return ocr.OcrAuftrag(nr, bild, dpi, bildtyp, seite.rect)


def seiten_erkennen(
    doc_holen: Callable[[], pymupdf.Document],
    seiten: list[int],
    optionen: OcrOptionen,
    mupdf: Mupdf,
    melden: Callable[[float, str], None],
) -> tuple[list[ocr.SeitenErgebnis], int]:
    """Erkennt die Seiten parallel. Liefert (Ergebnisse, Anzahl übersprungener Seiten)."""
    if not ocr.tesseract_finden():
        raise DokumentFehler("Die Texterkennung (Tesseract) wurde nicht gefunden. Bitte Ergo4You PDF neu installieren.")
    ergebnisse: list[ocr.SeitenErgebnis] = []
    uebersprungen = 0
    melden(0.01, f"Bereite {len(seiten)} Seite(n) vor …")
    with ThreadPoolExecutor(max_workers=PARALLEL, thread_name_prefix="ocr") as pool:
        laufend = []
        for nr in seiten:
            vorbereitet = mupdf(lambda nr=nr: _vorbereiten(doc_holen(), nr, optionen))
            if isinstance(vorbereitet, str):
                uebersprungen += 1
                continue
            laufend.append(pool.submit(ocr.erkennen, vorbereitet, optionen.sprachen, optionen.ausrichten, optionen.entzerren))
            # Rendern nicht beliebig weit vorauslaufen lassen (Speicher)
            while sum(not f.done() for f in laufend) > PARALLEL * 2:
                next(f for f in laufend if not f.done()).result()
            fertig = sum(f.done() for f in laufend) + uebersprungen
            melden(0.05 + 0.85 * fertig / len(seiten), f"Erkenne Text … ({fertig}/{len(seiten)} Seiten)")
        for f in laufend:
            ergebnisse.append(f.result())
            fertig = len(ergebnisse) + uebersprungen
            melden(0.05 + 0.85 * fertig / len(seiten), f"Erkenne Text … ({fertig}/{len(seiten)} Seiten)")
    return ergebnisse, uebersprungen


def ergebnisse_schreiben(doc: pymupdf.Document, ergebnisse: list[ocr.SeitenErgebnis], optionen: OcrOptionen) -> tuple[dict, dict[int, dict]]:
    """Im MuPDF-Thread: Textebenen schreiben, erkannte Drehungen anwenden.
    Liefert (Statistik, Infos je Seitennummer)."""
    woerter = unsicher = gedreht = 0
    infos: dict[int, dict] = {}
    ebene = ocr.ocr_ebene(doc) if ergebnisse else 0
    for e in ergebnisse:
        seite = doc[e.seite]
        if optionen.erzwingen and ocr.hat_text(seite):
            ocr.vorhandenen_text_entfernen(seite)
        woerter += ocr.textebene_schreiben(seite, e, ebene)
        # Unsichere Wörter in ungedrehten PDF-Koordinaten merken – noch VOR
        # einer Seitendrehung, solange e.abbildung zur Anzeige passt.
        nach_pdf = e.abbildung * seite.derotation_matrix
        rects = [(pymupdf.Rect(x, y, x + b, y + h).quad * nach_pdf).rect for x, y, b, h in (w.box for w in e.unsicher)]
        infos[e.seite] = {
            "sicherheit": round(e.sicherheit, 1),
            "unsicher": [tuple(round(v, 2) for v in r) for r in rects],
            "schraeglage": e.schraeglage,
            "bildtyp": e.bildtyp,
        }
        unsicher += len(e.unsicher)
        if e.drehung:
            seite.set_rotation((seite.rotation + e.drehung) % 360)
            gedreht += 1
    anzahl_woerter = sum(len(e.woerter) for e in ergebnisse)
    sicherheit = sum(e.sicherheit * len(e.woerter) for e in ergebnisse) / max(1, anzahl_woerter)
    statistik = {"erkannt": len(ergebnisse), "woerter": woerter, "unsicher": unsicher, "gedreht": gedreht, "sicherheit": round(sicherheit, 1)}
    return statistik, infos


def dokument_erkennen(
    dok_id: str,
    seiten: list[int] | None,
    optionen: OcrOptionen,
    speicher: DokumentSpeicher,
    bearbeitung: Bearbeitung,
    auftrag: Auftrag,
    mupdf: Mupdf,
) -> dict:
    """Texterkennung für ein geöffnetes Dokument – ein Rückgängig-Schritt."""
    anzahl = mupdf(lambda: speicher.get(dok_id).doc.page_count)
    seiten = sorted(set(seiten)) if seiten else list(range(anzahl))
    if any(s < 0 or s >= anzahl for s in seiten):
        raise DokumentFehler("Ungültige Seitennummer.")
    ergebnisse, uebersprungen = seiten_erkennen(lambda: speicher.get(dok_id).doc, seiten, optionen, mupdf, auftrag.melden)
    auftrag.melden(0.95, "Schreibe Textebene …")

    def schreiben() -> dict:
        dok = speicher.get(dok_id)
        if not ergebnisse:
            return {"erkannt": 0, "woerter": 0, "unsicher": 0, "gedreht": 0, "sicherheit": 0}
        with bearbeitung.aendern("Texterkennung", dok):
            statistik, infos = ergebnisse_schreiben(dok.doc, ergebnisse, optionen)
            for nr, info in infos.items():
                dok.ocr_info[dok.seiten_ids[nr]] = info
                dok.seite_geaendert(nr)
        return statistik

    statistik = mupdf(schreiben)
    statistik.update(uebersprungen=uebersprungen, seiten=len(seiten))
    return {"dokumente": [dok_id], "aktualisieren": True, "ocr": statistik}


def unsichere_woerter(speicher: DokumentSpeicher, dok_id: str) -> dict[int, list[list[float]]]:
    """Unsichere Wörter je Seite als normierte Rechtecke der angezeigten Seite."""
    dok = speicher.get(dok_id)
    ergebnis: dict[int, list[list[float]]] = {}
    for nr, sid in enumerate(dok.seiten_ids):
        info = dok.ocr_info.get(sid)
        if not info or not info["unsicher"]:
            continue
        seite = dok.doc[nr]
        b, h = seite.rect.width, seite.rect.height
        ergebnis[nr] = [
            [round(v, 5) for v in ((r.x0 / b), (r.y0 / h), (r.x1 / b), (r.y1 / h))]
            for r in ((pymupdf.Rect(x) * seite.rotation_matrix).normalize() for x in info["unsicher"])
        ]
    return ergebnis


def bereich_erkennen(speicher: DokumentSpeicher, dok_id: str, seite_nr: int, rechteck: list[float], sprachen: str) -> ocr.OcrAuftrag:
    """Im MuPDF-Thread: Ausschnitt (normiert, angezeigte Seite) rendern."""
    dok = speicher.get(dok_id)
    if not 0 <= seite_nr < dok.doc.page_count:
        raise DokumentFehler("Seite existiert nicht.")
    seite = dok.doc[seite_nr]
    x0, y0, x1, y1 = rechteck
    clip = pymupdf.Rect(x0 * seite.rect.width, y0 * seite.rect.height, x1 * seite.rect.width, y1 * seite.rect.height)
    if clip.width < 4 or clip.height < 4:
        raise DokumentFehler("Bereich ist zu klein.")
    dpi, bildtyp = ocr.render_dpi(seite)
    dpi = max(dpi, 300)
    bild, _ = ocr.seite_rendern(seite, dpi, clip=clip)
    return ocr.OcrAuftrag(seite_nr, bild, dpi, bildtyp if bildtyp != "digital" else "scan", seite.rect, clip=clip)
