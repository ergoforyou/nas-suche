"""Abfotografierte Dokumente aufbereiten: Kanten finden, perspektivisch
entzerren, Schatten entfernen, Filter „Dokument“/„Schwarz-Weiß“.
"""

from __future__ import annotations

import io

import numpy as np
from PIL import Image

from .bilder import bild_laden

FILTER = ("original", "dokument", "farbe", "sw")


def _cv2():
    import cv2

    return cv2


def ecken_finden(daten: bytes) -> dict:
    """Sucht die vier Ecken des Dokuments im Foto.

    Ergebnis: {"ecken": [[x, y] × 4] normiert (oben links, oben rechts,
    unten rechts, unten links), "gefunden": bool}. Ohne Fund: ganzes Bild.
    """
    cv2 = _cv2()
    im = bild_laden(daten).convert("RGB")
    rgb = np.asarray(im)
    hoehe, breite = rgb.shape[:2]
    faktor = 900 / max(hoehe, breite)
    klein = cv2.resize(rgb, (max(1, int(breite * faktor)), max(1, int(hoehe * faktor))), interpolation=cv2.INTER_AREA)
    grau = cv2.cvtColor(klein, cv2.COLOR_RGB2GRAY)
    grau = cv2.GaussianBlur(grau, (5, 5), 0)
    flaeche_bild = grau.shape[0] * grau.shape[1]

    kandidaten = []
    for unten, oben in ((30, 100), (50, 150), (75, 200)):
        kanten = cv2.Canny(grau, unten, oben)
        kanten = cv2.dilate(kanten, np.ones((3, 3), np.uint8), iterations=2)
        konturen, _ = cv2.findContours(kanten, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        for k in sorted(konturen, key=cv2.contourArea, reverse=True)[:8]:
            umfang = cv2.arcLength(k, True)
            for genauigkeit in (0.02, 0.04):
                naeherung = cv2.approxPolyDP(k, genauigkeit * umfang, True)
                if len(naeherung) == 4 and cv2.isContourConvex(naeherung):
                    flaeche = cv2.contourArea(naeherung)
                    if 0.2 * flaeche_bild < flaeche < 0.995 * flaeche_bild:
                        kandidaten.append((flaeche, naeherung.reshape(4, 2)))
                    break
    # Alternative für helle Dokumente auf dunklem Grund: Schwellwert
    _, maske = cv2.threshold(grau, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    konturen, _ = cv2.findContours(maske, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if konturen:
        k = max(konturen, key=cv2.contourArea)
        flaeche = cv2.contourArea(k)
        if 0.2 * flaeche_bild < flaeche < 0.98 * flaeche_bild:
            naeherung = cv2.approxPolyDP(k, 0.02 * cv2.arcLength(k, True), True)
            if len(naeherung) == 4:
                kandidaten.append((flaeche * 0.98, naeherung.reshape(4, 2)))
            else:
                kandidaten.append((flaeche * 0.9, cv2.boxPoints(cv2.minAreaRect(k))))

    if not kandidaten:
        return {"ecken": [[0, 0], [1, 0], [1, 1], [0, 1]], "gefunden": False}
    _, punkte = max(kandidaten, key=lambda k: k[0])
    ecken = _sortieren(np.asarray(punkte, np.float32))
    kh, kb = grau.shape
    return {"ecken": [[round(float(x) / kb, 4), round(float(y) / kh, 4)] for x, y in ecken], "gefunden": True}


def _sortieren(p: np.ndarray) -> np.ndarray:
    """Ecken in Reihenfolge oben links, oben rechts, unten rechts, unten links."""
    s = p.sum(axis=1)
    d = np.diff(p, axis=1).ravel()
    return np.array([p[np.argmin(s)], p[np.argmin(d)], p[np.argmax(s)], p[np.argmax(d)]], np.float32)


def entzerren(daten: bytes, ecken: list[list[float]] | None, filter_: str = "dokument", drehung: int = 0) -> tuple[bytes, str]:
    """Schneidet das Dokument aus, entzerrt es und wendet den Filter an.
    Ergebnis: (Bilddaten, "png" | "jpeg")."""
    cv2 = _cv2()
    if filter_ not in FILTER:
        filter_ = "dokument"
    im = bild_laden(daten).convert("RGB")
    rgb = np.asarray(im)
    hoehe, breite = rgb.shape[:2]
    if ecken and len(ecken) == 4:
        quelle = _sortieren(np.array([[x * breite, y * hoehe] for x, y in ecken], np.float32))
        tl, tr, br, bl = quelle
        b = int(max(np.linalg.norm(tr - tl), np.linalg.norm(br - bl)))
        h = int(max(np.linalg.norm(bl - tl), np.linalg.norm(br - tr)))
        if b > 20 and h > 20:
            ziel = np.array([[0, 0], [b - 1, 0], [b - 1, h - 1], [0, h - 1]], np.float32)
            matrix = cv2.getPerspectiveTransform(quelle, ziel)
            rgb = cv2.warpPerspective(rgb, matrix, (b, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    if drehung % 360:
        rgb = np.rot90(rgb, k=-(drehung // 90) % 4).copy()

    if filter_ == "original":
        return _speichern(Image.fromarray(rgb), "jpeg")
    if filter_ == "farbe":
        kanaele = [_schatten_entfernen(rgb[:, :, i]) for i in range(3)]
        return _speichern(Image.fromarray(np.dstack(kanaele)), "jpeg")
    grau = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    flach = _schatten_entfernen(grau)
    if filter_ == "sw":
        sw = cv2.adaptiveThreshold(flach, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 12)
        return _speichern(Image.fromarray(sw).convert("1"), "png")
    return _speichern(Image.fromarray(flach), "jpeg")


def _schatten_entfernen(kanal: np.ndarray) -> np.ndarray:
    """Beleuchtung ausgleichen: Kanal durch geschätzten Papierhintergrund teilen,
    danach Kontrast strecken – Papier wird weiß, Schrift bleibt dunkel."""
    cv2 = _cv2()
    groesse = max(15, (min(kanal.shape) // 20) | 1)
    hintergrund = cv2.dilate(kanal, cv2.getStructuringElement(cv2.MORPH_RECT, (groesse, groesse)))
    hintergrund = cv2.medianBlur(hintergrund, 21)
    normiert = cv2.divide(kanal, np.maximum(hintergrund, 1), scale=255)
    tief, hoch = np.percentile(normiert, (1, 99.5))
    if hoch - tief < 10:
        return normiert
    gestreckt = np.clip((normiert.astype(np.float32) - tief) * 255.0 / (hoch - tief), 0, 255)
    return gestreckt.astype(np.uint8)


def _speichern(im: Image.Image, format_: str) -> tuple[bytes, str]:
    puffer = io.BytesIO()
    if format_ == "jpeg":
        im.convert("RGB").save(puffer, "JPEG", quality=88, dpi=(200, 200))
    else:
        im.save(puffer, "PNG", optimize=True, dpi=(200, 200))
    return puffer.getvalue(), format_


def seite_als_bild(seite, dpi: int = 200) -> bytes:
    """Seite rendern (für „Seite als Foto aufbereiten“)."""
    pix = seite.get_pixmap(dpi=dpi, alpha=False)
    return pix.tobytes("png")
