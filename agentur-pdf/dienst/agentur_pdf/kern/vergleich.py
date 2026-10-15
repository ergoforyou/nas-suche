"""Zwei Dokumente vergleichen (z. B. alte und neue Fassung eines Vertrags).

1. Text: erst zeilenweise abgleichen (schnell, auch bei 150 Seiten), dann
   innerhalb geänderter Zeilen Wort für Wort – so wird aus „1.200 €“ →
   „1.250 €“ genau ein markiertes Wort statt einer ganzen Zeile.
2. Bild: Seiten ohne Text (Scans) werden zusätzlich Seite für Seite als Bild
   verglichen; abweichende Bereiche werden markiert.

Koordinaten wie überall normiert auf die angezeigte Seite. ``woerter_lesen``
und ``bildvergleich`` im MuPDF-Thread aufrufen, ``vergleichen`` darf in
einem beliebigen Thread laufen.
"""

from __future__ import annotations

import difflib
from dataclasses import dataclass

import numpy as np
import pymupdf

from .anmerkungen import norm_rechteck

MAX_AENDERUNGEN = 2000


@dataclass
class Wort:
    seite: int
    rechteck: list[float]  # normiert
    text: str


def woerter_lesen(doc: pymupdf.Document) -> list[list[list[Wort]]]:
    """Je Seite die Zeilen, je Zeile die Wörter (Lesereihenfolge)."""
    seiten = []
    for seite in doc:
        zeilen: dict[tuple[int, int], list[Wort]] = {}
        for x0, y0, x1, y1, text, block, zeile, _ in seite.get_text("words", sort=True):
            zeilen.setdefault((block, zeile), []).append(Wort(seite.number, norm_rechteck(seite, pymupdf.Rect(x0, y0, x1, y1)), text))
        seiten.append(list(zeilen.values()))
    return seiten


def _zusammenfassen(woerter: list[Wort]) -> list[dict]:
    """Wörter einer Änderung zu Rechtecken je Zeile zusammenfassen."""
    bereiche: list[dict] = []
    for w in woerter:
        letzter = bereiche[-1] if bereiche else None
        if letzter and letzter["seite"] == w.seite and abs(letzter["rechteck"][1] - w.rechteck[1]) < 0.004:
            r = letzter["rechteck"]
            letzter["rechteck"] = [min(r[0], w.rechteck[0]), min(r[1], w.rechteck[1]), max(r[2], w.rechteck[2]), max(r[3], w.rechteck[3])]
        else:
            bereiche.append({"seite": w.seite, "rechteck": list(w.rechteck)})
    return bereiche


def _einfuegestelle(woerter: list[Wort], index: int) -> list[dict]:
    """Wo in der anderen Fassung etwas fehlt: schmale Marke hinter dem Wort davor."""
    if not woerter:
        return []
    if index > 0:
        w = woerter[min(index, len(woerter)) - 1]
        x = w.rechteck[2]
    else:
        w = woerter[0]
        x = w.rechteck[0]
    return [{"seite": w.seite, "rechteck": [max(0.0, x - 0.002), w.rechteck[1], min(1.0, x + 0.004), w.rechteck[3]], "stelle": True}]


def _text(woerter: list[Wort], grenze: int = 160) -> str:
    t = " ".join(w.text for w in woerter)
    return t if len(t) <= grenze else t[: grenze - 1] + "…"


def vergleichen(a: list[list[list[Wort]]], b: list[list[list[Wort]]]) -> list[dict]:
    zeilen_a = [z for s in a for z in s]
    zeilen_b = [z for s in b for z in s]
    flach_a = [w for z in zeilen_a for w in z]
    flach_b = [w for z in zeilen_b for w in z]
    # Startindex jeder Zeile in der flachen Wortliste
    start_a = np.cumsum([0] + [len(z) for z in zeilen_a]).tolist()
    start_b = np.cumsum([0] + [len(z) for z in zeilen_b]).tolist()

    aenderungen: list[dict] = []

    def hinzufuegen(art: str, wa: list[Wort], wb: list[Wort], ia: int, ib: int) -> None:
        if len(aenderungen) >= MAX_AENDERUNGEN:
            return
        aenderungen.append(
            {
                "art": art,
                "alt": _text(wa),
                "neu": _text(wb),
                "a": _zusammenfassen(wa) if wa else _einfuegestelle(flach_a, ia),
                "b": _zusammenfassen(wb) if wb else _einfuegestelle(flach_b, ib),
            }
        )

    zeilen = difflib.SequenceMatcher(None, [" ".join(w.text for w in z) for z in zeilen_a], [" ".join(w.text for w in z) for z in zeilen_b], autojunk=False)
    for tag, i1, i2, j1, j2 in zeilen.get_opcodes():
        if tag == "equal":
            continue
        wa = flach_a[start_a[i1] : start_a[i2]]
        wb = flach_b[start_b[j1] : start_b[j2]]
        if tag == "delete":
            hinzufuegen("entfernt", wa, [], start_a[i1], start_b[j1])
            continue
        if tag == "insert":
            hinzufuegen("eingefuegt", [], wb, start_a[i1], start_b[j1])
            continue
        # Zeilen ersetzt → Wort für Wort genauer
        woerter = difflib.SequenceMatcher(None, [w.text for w in wa], [w.text for w in wb], autojunk=False)
        for t, k1, k2, l1, l2 in woerter.get_opcodes():
            if t == "equal":
                continue
            art = {"replace": "geaendert", "delete": "entfernt", "insert": "eingefuegt"}[t]
            hinzufuegen(art, wa[k1:k2], wb[l1:l2], start_a[i1] + k1, start_b[j1] + l1)
    for a_ in aenderungen:
        a_["seite_a"] = a_["a"][0]["seite"] if a_["a"] else None
        a_["seite_b"] = a_["b"][0]["seite"] if a_["b"] else None
    return aenderungen


def _graubild(seite: pymupdf.Page, breite: int = 300) -> np.ndarray:
    zoom = breite / max(1.0, seite.rect.width)
    pix = seite.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), colorspace=pymupdf.csGRAY, alpha=False)
    return np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.stride)[:, : pix.width].astype(np.int16)


def bildvergleich(doc_a: pymupdf.Document, doc_b: pymupdf.Document, seiten: list[int]) -> list[dict]:
    """Seitenpaare (gleiche Nummer) als Bild vergleichen – für Scans ohne Text."""
    ergebnis = []
    for nr in seiten:
        if nr >= doc_a.page_count or nr >= doc_b.page_count:
            continue
        ga, gb = _graubild(doc_a[nr]), _graubild(doc_b[nr])
        h, b = min(ga.shape[0], gb.shape[0]), min(ga.shape[1], gb.shape[1])
        if h < 10 or b < 10:
            continue
        unterschied = np.abs(ga[:h, :b] - gb[:h, :b]) > 60
        # Rauschen (Scanner) ausblenden: nur zusammenhängende Flächen zählen
        anteil = unterschied.mean()
        if anteil < 0.002:
            continue
        ys, xs = np.nonzero(unterschied)
        r = [float(xs.min()) / b, float(ys.min()) / h, float(xs.max() + 1) / b, float(ys.max() + 1) / h]
        bereich = {"seite": nr, "rechteck": [round(v, 4) for v in r]}
        ergebnis.append(
            {"art": "bild", "alt": f"Seite {nr + 1}: Bildinhalt unterscheidet sich", "neu": "", "a": [bereich], "b": [dict(bereich)], "seite_a": nr, "seite_b": nr}
        )
    return ergebnis
