"""Texterkennung (OCR) – „durchsuchbares Bild“.

Grundsatz: Das Seitenbild wird NIE verändert. Der erkannte Text kommt als
unsichtbare Textebene (Ebene „OCR-Text“) auf die Seite. Erkennungsfehler
können so nur die Suche beeinträchtigen, nie das Aussehen des Dokuments.

Ablauf je Seite:
1. Seite in passender Auflösung rendern (MuPDF-Thread).
2. Bildtyp bestimmen (Scan, Foto, Screenshot) und für die Erkennung
   aufbereiten: Graustufen, Beleuchtung ausgleichen, Schräglage messen und
   gerade drehen, Screenshots vergrößern, Dunkelmodus invertieren.
3. Tesseract 5 (LSTM, Deutsch) liefert Wörter mit Position und Sicherheit.
4. Wörter werden – zurückgerechnet auf die Originalseite (inkl. Schräglage) –
   als unsichtbarer Text geschrieben.
"""

from __future__ import annotations

import csv
import io
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pymupdf

from .dokumente import DokumentFehler

OCR_EBENE = "OCR-Text"
UNSICHER_UNTER = 60  # Tesseract-Konfidenz (0–100), darunter gilt ein Wort als unsicher
VERWERFEN_UNTER = 20  # darunter fast immer Buchstabensalat (z. B. senkrechter Randtext, Muster)
ZIEL_DPI = 300
SCREENSHOT_DPI_GRENZE = 150  # Bilder darunter gelten als Bildschirmfoto
TESSERACT_ZEITLIMIT = 120


# --------------------------------------------------------------- Programme
def tesseract_finden() -> str | None:
    kandidaten = []
    if os.environ.get("AGENTUR_PDF_TESSERACT"):
        kandidaten.append(os.environ["AGENTUR_PDF_TESSERACT"])
    basis = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    kandidaten += [str(basis / "tesseract" / "tesseract.exe"), str(Path(sys.executable).parent / "tesseract" / "tesseract.exe")]
    for umgebung in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"):
        if os.environ.get(umgebung):
            kandidaten.append(str(Path(os.environ[umgebung]) / "Tesseract-OCR" / "tesseract.exe"))
    for k in kandidaten:
        if k and os.path.isfile(k):
            return k
    return shutil.which("tesseract")


def tessdata_finden() -> str | None:
    """Bevorzugt die mitgelieferten besten Modelle (tessdata_best)."""
    kandidaten = [os.environ.get("AGENTUR_PDF_TESSDATA", "")]
    basis = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    kandidaten += [str(basis / "tessdata"), str(Path(sys.executable).parent / "tessdata")]
    for k in kandidaten:
        if k and (Path(k) / "deu.traineddata").is_file():
            return k
    return None  # Tesseract nimmt dann seine eigenen Modelle


def sprachen_verfuegbar() -> list[str]:
    programm = tesseract_finden()
    if not programm:
        return []
    befehl = [programm, "--list-langs"]
    if tessdata_finden():
        befehl += ["--tessdata-dir", tessdata_finden()]
    try:
        ausgabe = subprocess.run(befehl, capture_output=True, timeout=20, **_ohne_fenster()).stdout.decode(errors="replace")
    except (OSError, subprocess.TimeoutExpired):
        return []
    return [z.strip() for z in ausgabe.splitlines()[1:] if z.strip() and z.strip() != "osd"]


def _ohne_fenster() -> dict:
    return {"creationflags": 0x08000000} if os.name == "nt" else {}


# ----------------------------------------------------------- Datentypen
@dataclass
class Wort:
    text: str
    rechteck: pymupdf.Rect  # Hülle in Koordinaten der angezeigten Seite (pt)
    sicherheit: float
    zeile: tuple[int, int, int]  # (Block, Absatz, Zeile) – für Bereichs-OCR
    box: tuple[float, float, float, float] = (0, 0, 0, 0)  # x, y, b, h im aufbereiteten Bild (px)


@dataclass
class SeitenErgebnis:
    seite: int
    woerter: list[Wort] = field(default_factory=list)
    schraeglage: float = 0.0  # Grad
    drehung: int = 0  # erkannte Ausrichtung (0/90/180/270, im Uhrzeigersinn zu korrigieren)
    bildtyp: str = "scan"
    uebersprungen: bool = False
    # Abbildung aufbereitetes Bild (px) → angezeigte Seite (pt)
    abbildung: pymupdf.Matrix = field(default_factory=pymupdf.Matrix)

    @property
    def sicherheit(self) -> float:
        return float(np.mean([w.sicherheit for w in self.woerter])) if self.woerter else 0.0

    @property
    def unsicher(self) -> list[Wort]:
        return [w for w in self.woerter if w.sicherheit < UNSICHER_UNTER]

    @property
    def text(self) -> str:
        """Erkannter Text zeilenweise (für Bereichs-OCR / Zwischenablage)."""
        zeilen: list[str] = []
        letzte = None
        for w in self.woerter:
            if w.zeile != letzte:
                if letzte is not None and w.zeile[:2] != letzte[:2]:
                    zeilen.append("")  # neuer Absatz
                zeilen.append(w.text)
                letzte = w.zeile
            else:
                zeilen[-1] += " " + w.text
        return "\n".join(zeilen).strip()


# ----------------------------------------------------- Seite analysieren
def hat_text(seite: pymupdf.Page) -> bool:
    return len(seite.get_text("text").strip()) >= 3


def ist_bildseite(seite: pymupdf.Page) -> bool:
    """Seite besteht im Wesentlichen aus einem Bild (Scan/Foto)."""
    flaeche = abs(seite.rect)
    for info in seite.get_image_info():
        r = pymupdf.Rect(info["bbox"]) & seite.rect
        if abs(r) > 0.5 * flaeche:
            return True
    return False


def bild_dpi(seite: pymupdf.Page) -> float | None:
    """Auflösung des größten Bildes auf der Seite (Pixel pro Zoll, wie angezeigt)."""
    beste, dpi = 0.0, None
    for info in seite.get_image_info():
        r = pymupdf.Rect(info["bbox"])
        if abs(r) > beste and r.width > 0 and r.height > 0:
            beste = abs(r)
            # Bild kann im PDF gedreht liegen → längere Seite mit längerer Seite vergleichen
            px = max(info["width"], info["height"])
            pt = max(r.width, r.height)
            dpi = px / (pt / 72)
    return dpi


def render_dpi(seite: pymupdf.Page) -> tuple[int, str]:
    """Render-Auflösung und Bildtyp für die Erkennung."""
    dpi = bild_dpi(seite) if ist_bildseite(seite) else None
    if dpi is None:
        return ZIEL_DPI, "digital"
    if dpi < SCREENSHOT_DPI_GRENZE:
        # Bildschirmfoto: auf ~3-fach vergrößern – Tesseract braucht ca. 30 px Zeilenhöhe
        return int(min(450, max(ZIEL_DPI, dpi * 3))), "screenshot"
    return int(min(400, max(ZIEL_DPI, dpi))) if dpi < 400 else ZIEL_DPI, "scan"


def seite_rendern(seite: pymupdf.Page, dpi: int, clip: pymupdf.Rect | None = None) -> tuple[np.ndarray, float]:
    """Graustufenbild der angezeigten Seite. Liefert (Bild, Skalierung pt→px)."""
    skala = dpi / 72
    pix = seite.get_pixmap(matrix=pymupdf.Matrix(skala, skala), colorspace=pymupdf.csGRAY, alpha=False, clip=clip, annots=False)
    bild = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.stride)[:, : pix.width].copy()
    return bild, skala


# ------------------------------------------------------- Vorverarbeitung
def ist_foto(bild: np.ndarray) -> bool:
    """Ungleichmäßige Ausleuchtung (Handyfoto) statt gleichmäßig weißem Scan."""
    import cv2

    klein = cv2.resize(bild, (64, 64), interpolation=cv2.INTER_AREA)
    hintergrund = cv2.dilate(klein, np.ones((7, 7), np.uint8))
    return float(np.percentile(hintergrund, 95) - np.percentile(hintergrund, 10)) > 45


def beleuchtung_ausgleichen(bild: np.ndarray) -> np.ndarray:
    """Schatten und Farbverläufe entfernen (Hintergrund schätzen und herausteilen)."""
    import cv2

    k = max(15, (min(bild.shape) // 30) | 1)
    hintergrund = cv2.morphologyEx(bild, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (k, k)))
    hintergrund = cv2.medianBlur(hintergrund, 21)
    norm = cv2.divide(bild, np.maximum(hintergrund, 1), scale=255)
    return cv2.normalize(norm, None, 0, 255, cv2.NORM_MINMAX)


def schraeglage_messen(bild: np.ndarray, max_winkel: float = 7.0) -> float:
    """Winkel (Grad), um den das Bild gegen den Uhrzeigersinn gedreht werden
    muss, damit Textzeilen waagerecht liegen. Projektionsprofil-Verfahren:
    Bei waagerechten Zeilen schwanken die Zeilensummen am stärksten."""
    import cv2

    h, b = bild.shape
    f = 1000 / max(h, b)
    klein = cv2.resize(bild, (int(b * f), int(h * f)), interpolation=cv2.INTER_AREA) if f < 1 else bild
    _, schwarz = cv2.threshold(klein, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    if schwarz.mean() < 1:  # leere Seite
        return 0.0
    mitte = (schwarz.shape[1] / 2, schwarz.shape[0] / 2)

    def guete(winkel: float) -> float:
        m = cv2.getRotationMatrix2D(mitte, winkel, 1.0)
        gedreht = cv2.warpAffine(schwarz, m, (schwarz.shape[1], schwarz.shape[0]), flags=cv2.INTER_NEAREST)
        return float(np.var(gedreht.sum(axis=1, dtype=np.float64)))

    bester = max(np.arange(-max_winkel, max_winkel + 0.01, 0.5), key=guete)
    bester = max(np.arange(bester - 0.5, bester + 0.51, 0.05), key=guete)
    return 0.0 if abs(bester) < 0.2 else round(float(bester), 2)


def drehen(bild: np.ndarray, winkel: float) -> np.ndarray:
    import cv2

    if not winkel:
        return bild
    h, b = bild.shape
    m = cv2.getRotationMatrix2D((b / 2, h / 2), winkel, 1.0)
    return cv2.warpAffine(bild, m, (b, h), flags=cv2.INTER_CUBIC, borderValue=255)


def vorbereiten(bild: np.ndarray, bildtyp: str, entzerren: bool = True) -> tuple[np.ndarray, float, str]:
    """Bild für Tesseract aufbereiten. Liefert (Bild, Schräglage in Grad, Bildtyp)."""
    import cv2

    if bildtyp != "digital" and np.mean(bild) < 110:
        bild = 255 - bild  # Dunkelmodus (WhatsApp, Apps) → schwarz auf weiß
    if bildtyp == "scan" and ist_foto(bild):
        bildtyp = "foto"
    if bildtyp == "foto":
        bild = beleuchtung_ausgleichen(bild)
    # Bewusst KEIN Rauschfilter: Ein Median-Filter entfernt bei 300 dpi die
    # Umlaut-Punkte (gemessen: „Gebäude“ → „Gebaude“). Tesseract kommt mit
    # Scanrauschen selbst gut zurecht.
    winkel = schraeglage_messen(bild) if entzerren and bildtyp in ("scan", "foto") else 0.0
    return drehen(bild, winkel), winkel, bildtyp


# --------------------------------------------------------------- Tesseract
def _png(bild: np.ndarray, dpi: int) -> bytes:
    from PIL import Image

    puffer = io.BytesIO()
    Image.fromarray(bild).save(puffer, "PNG", dpi=(dpi, dpi))
    return puffer.getvalue()


def _tesseract(bild_png: bytes, argumente: list[str], ausgabe: str) -> str:
    programm = tesseract_finden()
    if not programm:
        raise DokumentFehler("Die Texterkennung (Tesseract) wurde nicht gefunden. Bitte Agentur-PDF neu installieren.")
    befehl = [programm, "stdin", "stdout"]
    if tessdata_finden():
        befehl += ["--tessdata-dir", tessdata_finden()]
    befehl += argumente + [ausgabe]
    umgebung = {**os.environ, "OMP_THREAD_LIMIT": "1"}  # wir parallelisieren über Seiten
    try:
        ergebnis = subprocess.run(
            befehl, input=bild_png, capture_output=True, timeout=TESSERACT_ZEITLIMIT, env=umgebung, **_ohne_fenster()
        )
    except subprocess.TimeoutExpired:
        raise DokumentFehler("Texterkennung dauerte zu lange und wurde abgebrochen.") from None
    if ergebnis.returncode != 0:
        meldung = ergebnis.stderr.decode(errors="replace").strip().splitlines()
        raise DokumentFehler(f"Texterkennung fehlgeschlagen: {meldung[-1] if meldung else 'unbekannter Fehler'}")
    return ergebnis.stdout.decode("utf-8", errors="replace")


def ausrichtung_erkennen(bild: np.ndarray, dpi: int) -> int:
    """0/90/180/270: Um so viel Grad im Uhrzeigersinn muss die Seite gedreht
    werden, damit der Text aufrecht steht. Im Zweifel 0.

    Tesseracts Ausrichtungserkennung (OSD) irrt sich bei textarmen Seiten
    (gemessen: Seite mit wenig Text als „kopfstehend“ erkannt). Deshalb wird
    ein Vorschlag nur übernommen, wenn eine Probe-Erkennung der gedrehten
    Seite deutlich mehr sichere Wörter liefert als die der ungedrehten.
    """
    import cv2

    f = min(1.0, 1500 / max(bild.shape))
    klein = cv2.resize(bild, None, fx=f, fy=f, interpolation=cv2.INTER_AREA) if f < 1 else bild
    klein_dpi = max(70, int(dpi * f))
    try:
        ausgabe = _tesseract(_png(klein, klein_dpi), ["--psm", "0"], "osd")
    except DokumentFehler:
        return 0  # zu wenig Text für eine Aussage
    werte = dict(z.split(":", 1) for z in ausgabe.splitlines() if ":" in z)
    try:
        drehung = int(werte.get("Rotate", "0").strip())
        sicherheit = float(werte.get("Orientation confidence", "0").strip())
    except ValueError:
        return 0
    if drehung not in (90, 180, 270) or sicherheit < 1.5:
        return 0
    gedreht = np.ascontiguousarray(np.rot90(klein, k=-drehung // 90))
    vorher, nachher = _probe(klein, klein_dpi), _probe(gedreht, klein_dpi)
    return drehung if nachher > max(8, vorher * 1.5) else 0


def _probe(bild: np.ndarray, dpi: int) -> int:
    """Anzahl sicher erkannter Wörter (≥ 4 Buchstaben, Sicherheit ≥ 70)."""
    try:
        # psm 6 = ein einheitlicher Block: liest nur aufrechten Text (psm 3
        # erkennt gedrehte Blöcke selbst und taugt daher nicht als Probe)
        woerter = woerter_erkennen(bild, dpi, "deu", psm=6)
    except DokumentFehler:
        return 0
    return sum(1 for w in woerter if w["konf"] >= 70 and sum(c.isalpha() for c in w["text"]) >= 4)


def woerter_erkennen(bild: np.ndarray, dpi: int, sprachen: str = "deu+eng", psm: int = 3) -> list[dict]:
    """Tesseract-TSV → Wörter in Bildpixeln."""
    tsv = _tesseract(_png(bild, dpi), ["-l", sprachen, "--psm", str(psm), "-c", "preserve_interword_spaces=1"], "tsv")
    woerter = []
    for z in csv.DictReader(io.StringIO(tsv), delimiter="\t", quoting=csv.QUOTE_NONE):
        text = (z.get("text") or "").strip()
        if z.get("level") != "5" or not text:
            continue
        try:
            konf = float(z["conf"])
        except (TypeError, ValueError):
            continue
        if konf < VERWERFEN_UNTER:
            continue
        woerter.append(
            {
                "text": text,
                "x": int(z["left"]),
                "y": int(z["top"]),
                "b": int(z["width"]),
                "h": int(z["height"]),
                "konf": konf,
                "zeile": (int(z["block_num"]), int(z["par_num"]), int(z["line_num"])),
            }
        )
    return woerter


# ------------------------------------------------- Seite erkennen (komplett)
@dataclass
class OcrAuftrag:
    """Alles, was der MuPDF-Thread für eine Seite vorbereitet hat."""

    seite: int
    bild: np.ndarray
    dpi: int
    bildtyp: str
    seiten_rect: pymupdf.Rect
    clip: pymupdf.Rect | None = None


_UMLAUTE = {"a": "ä", "o": "ö", "u": "ü", "A": "Ä", "O": "Ö", "U": "Ü"}


def umlaute_retten(woerter: list[dict]) -> list[dict]:
    """Verlorene Umlaut-Punkte ergänzen („Anderung“ → „Änderung“).

    Nur wenn das erkannte Wort unbekannt ist und GENAU EINE Variante mit
    Umlaut(en) im Wörterbuch steht – so wird nie ein richtiges Wort verändert.
    """
    import itertools
    import re

    from .woerterbuch import woerterbuch

    wb = woerterbuch()
    if not wb.verfuegbar:
        return woerter
    for w in woerter:
        m = re.fullmatch(r"([^\wÄÖÜäöüß]*)([A-Za-zÄÖÜäöüß-]{4,})([^\wÄÖÜäöüß]*)", w["text"])
        if not m or not re.search("[AOUaou]", m.group(2)):
            continue
        kern = m.group(2)
        if wb.bekannt(kern):
            continue
        stellen = [i for i, c in enumerate(kern) if c in _UMLAUTE]
        if len(stellen) > 6:
            continue
        treffer = set()
        for anzahl in (1, 2):
            for auswahl in itertools.combinations(stellen, anzahl):
                v = "".join(_UMLAUTE[c] if i in auswahl else c for i, c in enumerate(kern))
                if wb.bekannt(v):
                    treffer.add(v)
            if treffer:
                break
        if len(treffer) == 1:
            w["text"] = m.group(1) + treffer.pop() + m.group(3)
            w["korrigiert"] = True
    return woerter


def _affin(m: np.ndarray) -> np.ndarray:
    """2×3 → 3×3"""
    return np.vstack([m, [0.0, 0.0, 1.0]])


def _ausrichtung_matrix(drehung: int, gedreht_form: tuple[int, int]) -> np.ndarray:
    """Abbildung gedrehtes Bild → Originalbild (Spaltenvektoren, 3×3).
    ``drehung``: um so viel wurde das Original im Uhrzeigersinn gedreht."""
    hg, bg = gedreht_form
    if drehung == 90:
        return np.array([[0, 1, 0], [-1, 0, bg], [0, 0, 1]], dtype=float)
    if drehung == 180:
        return np.array([[-1, 0, bg], [0, -1, hg], [0, 0, 1]], dtype=float)
    if drehung == 270:
        return np.array([[0, -1, hg], [1, 0, 0], [0, 0, 1]], dtype=float)
    return np.eye(3)


def erkennen(a: OcrAuftrag, sprachen: str = "deu+eng", ausrichten: bool = True, entzerren: bool = True) -> SeitenErgebnis:
    """Reine Bildverarbeitung + Tesseract – läuft außerhalb des MuPDF-Threads."""
    import cv2

    ergebnis = SeitenErgebnis(seite=a.seite, bildtyp=a.bildtyp)
    bild = a.bild
    if ausrichten and a.bildtyp != "digital" and a.clip is None:
        ergebnis.drehung = ausrichtung_erkennen(bild, a.dpi)
        if ergebnis.drehung:
            bild = np.ascontiguousarray(np.rot90(bild, k=-ergebnis.drehung // 90))
    vorbereitet, winkel, bildtyp = vorbereiten(bild, a.bildtyp, entzerren=entzerren)
    ergebnis.schraeglage, ergebnis.bildtyp = winkel, bildtyp
    h, b = vorbereitet.shape

    # Abbildung: aufbereitetes Bild → gedrehtes Bild → Original → Seitenpunkte
    m = np.eye(3)
    if winkel:
        m = _affin(cv2.invertAffineTransform(cv2.getRotationMatrix2D((b / 2, h / 2), winkel, 1.0))) @ m
    m = _ausrichtung_matrix(ergebnis.drehung, bild.shape) @ m
    ox, oy = (a.clip.x0, a.clip.y0) if a.clip is not None else (0.0, 0.0)
    m = np.array([[72 / a.dpi, 0, ox], [0, 72 / a.dpi, oy], [0, 0, 1]]) @ m
    ergebnis.abbildung = pymupdf.Matrix(m[0, 0], m[1, 0], m[0, 1], m[1, 1], m[0, 2], m[1, 2])

    for w in umlaute_retten(woerter_erkennen(vorbereitet, a.dpi, sprachen, psm=6 if a.clip is not None else 3)):
        r = pymupdf.Rect(w["x"], w["y"], w["x"] + w["b"], w["y"] + w["h"])
        quad = r.quad * ergebnis.abbildung
        ergebnis.woerter.append(Wort(w["text"], quad.rect, w["konf"], w["zeile"], (w["x"], w["y"], w["b"], w["h"])))
    return ergebnis


# ------------------------------------------------------ Textebene schreiben
_SCHRIFT: pymupdf.Font | None = None


def _schrift() -> pymupdf.Font:
    global _SCHRIFT
    if _SCHRIFT is None:
        _SCHRIFT = pymupdf.Font("helv")
    return _SCHRIFT


def ocr_ebene(doc: pymupdf.Document) -> int:
    """xref der Ebene „OCR-Text“ (wird bei Bedarf angelegt)."""
    for xref, info in (doc.get_ocgs() or {}).items():
        if info.get("name") == OCR_EBENE:
            return xref
    return doc.add_ocg(OCR_EBENE, on=True, intent="View", usage="Artwork")


def vorhandenen_text_entfernen(seite: pymupdf.Page) -> None:
    """Bisherige (unsichtbare) Textebene einer Bildseite entfernen – für
    „OCR-Ebene ersetzen“. Bilder und Grafiken bleiben unangetastet."""
    seite.add_redact_annot(seite.rect, fill=False)
    seite.apply_redactions(
        images=pymupdf.PDF_REDACT_IMAGE_NONE,
        graphics=pymupdf.PDF_REDACT_LINE_ART_NONE,
        text=pymupdf.PDF_REDACT_TEXT_REMOVE,
    )


def textebene_schreiben(seite: pymupdf.Page, ergebnis: SeitenErgebnis, oc: int) -> int:
    """Unsichtbaren Text so setzen, dass jedes Wort genau über seinem Bild liegt
    (Markieren, Kopieren und Suchen treffen die richtige Stelle).

    Alle Wörter einer Seite teilen dieselbe Drehung (Schräglage, Ausrichtung,
    Seitendrehung). Sie werden waagerecht in einem Hilfskoordinatensystem
    gesetzt und dann gemeinsam mit einer Drehung an ihren Platz gebracht.
    """
    if not ergebnis.woerter:
        return 0
    schrift = _schrift()
    # aufbereitetes Bild (px) → ungedrehte PDF-Koordinaten
    gesamt = ergebnis.abbildung * seite.derotation_matrix
    skala = float(np.hypot(gesamt.a, gesamt.b))
    winkel = float(np.degrees(np.arctan2(gesamt.b, gesamt.a)))
    zurueck = pymupdf.Matrix(-winkel)  # ins waagerechte Hilfssystem
    schreiber = pymupdf.TextWriter(seite.rect)
    anzahl = 0
    for w in ergebnis.woerter:
        x, y, b, h = w.box
        einheit = schrift.text_length(w.text, fontsize=1)
        if einheit <= 0 or b <= 0:
            continue
        groesse = min(b * skala / einheit, h * skala * 1.6)
        grundlinie = pymupdf.Point(x, y + h * 0.8) * gesamt * zurueck
        schreiber.append(grundlinie, w.text, font=schrift, fontsize=max(groesse, 1.0))
        anzahl += 1
    if anzahl:
        # Achtung: morph dreht im PDF-Koordinatensystem (y nach oben) – daher -winkel
        morph = (pymupdf.Point(0, 0), pymupdf.Matrix(-winkel)) if abs(winkel) > 0.01 else None
        schreiber.write_text(seite, render_mode=3, oc=oc, morph=morph, overlay=True)
    return anzahl
