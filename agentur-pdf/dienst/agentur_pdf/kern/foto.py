"""Abfotografierte Dokumente aufbereiten: Kanten finden, perspektivisch
entzerren, Schatten entfernen, Filter „Dokument“/„Schwarz-Weiß“.
"""

from __future__ import annotations

import io

import numpy as np
import pymupdf
from PIL import Image

from .bilder import bild_laden

FILTER = ("auto", "original", "farbe", "grau", "dokument", "sw")


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

    inhalt = _inhalt_finden(klein)
    if not kandidaten:
        return {"ecken": [[0, 0], [1, 0], [1, 1], [0, 1]], "gefunden": False, "inhalt": inhalt}
    _, punkte = max(kandidaten, key=lambda k: k[0])
    ecken = _sortieren(np.asarray(punkte, np.float32))
    kh, kb = grau.shape
    return {"ecken": [[round(float(x) / kb, 4), round(float(y) / kh, 4)] for x, y in ecken], "gefunden": True, "inhalt": inhalt}


def _inhalt_finden(rgb: np.ndarray) -> list[float] | None:
    """Größter zusammenhängender Bereich, der sich vom Hintergrund abhebt –
    z. B. das Belegfoto in einem Screenshot des Mailprogramms.
    Ergebnis: [x0, y0, x1, y1] normiert oder None."""
    cv2 = _cv2()
    h, b = rgb.shape[:2]
    rand = np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]]).astype(np.int16)
    hintergrund = np.median(rand, axis=0)
    abstand = np.abs(rgb.astype(np.int16) - hintergrund).max(axis=2).astype(np.float32)
    # leicht geglättet: schon ein schwacher Farbstich (Papier im Foto vor
    # weißem Bildschirmhintergrund) zählt, Kompressionsrauschen nicht
    abstand = cv2.blur(abstand, (5, 5))
    maske = (abstand > 3.5).astype(np.uint8) * 255
    maske = cv2.morphologyEx(maske, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    # Fensterteile am Bildrand (Kopfzeilen, Leisten) gehören nicht dazu
    anzahl, beschriftung, werte, _ = cv2.connectedComponentsWithStats(maske)
    for i in range(1, anzahl):
        x, y, w, hh = (int(v) for v in werte[i, :4])
        if x <= 1 or y <= 1 or x + w >= b - 1 or y + hh >= h - 1:
            maske[beschriftung == i] = 0
    # Nahe beieinanderliegende Teile (Kopf, Textblöcke, Fuß eines Belegs)
    # zu einer Gruppe zusammenfassen und die größte Gruppe nehmen
    kern = max(5, int(0.06 * max(h, b)) | 1)
    gepolstert = cv2.copyMakeBorder(maske, kern, kern, kern, kern, cv2.BORDER_CONSTANT, value=0)
    gruppen = cv2.morphologyEx(gepolstert, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kern, kern)))
    gruppen = gruppen[kern:-kern, kern:-kern]
    anzahl, _, werte, _ = cv2.connectedComponentsWithStats(gruppen)
    if anzahl < 2:
        return None
    i = 1 + int(np.argmax(werte[1:, cv2.CC_STAT_WIDTH] * werte[1:, cv2.CC_STAT_HEIGHT]))
    x0, y0, w, hh = (int(v) for v in werte[i, :4])
    x1, y1 = x0 + w, y0 + hh
    # Teile in derselben Spalte (z. B. Fußzeile unter einer Leerfläche) dazunehmen
    geaendert = True
    while geaendert:
        geaendert = False
        for j in range(1, anzahl):
            jx, jy, jw, jh = (int(v) for v in werte[j, :4])
            if jx >= x0 and jx + jw <= x1 and jy >= y0 and jy + jh <= y1:
                continue
            ueberlappung = min(x1, jx + jw) - max(x0, jx)
            abstand = max(jy - y1, y0 - (jy + jh), 0)
            if ueberlappung >= 0.7 * jw and abstand <= 0.5 * h:
                x0, y0, x1, y1 = min(x0, jx), min(y0, jy), max(x1, jx + jw), max(y1, jy + jh)
                geaendert = True
    x, y, w, hh = x0, y0, x1 - x0, y1 - y0
    if w * hh < 0.03 * b * h or w * hh > 0.97 * b * h:
        return None
    return [round(float(x) / b, 4), round(float(y) / h, 4), round(float(x + w) / b, 4), round(float(y + hh) / h, 4)]


def _sortieren(p: np.ndarray) -> np.ndarray:
    """Ecken in Reihenfolge oben links, oben rechts, unten rechts, unten links."""
    s = p.sum(axis=1)
    d = np.diff(p, axis=1).ravel()
    return np.array([p[np.argmin(s)], p[np.argmin(d)], p[np.argmax(s)], p[np.argmax(d)]], np.float32)


def entzerren(
    daten: bytes,
    ecken: list[list[float]] | None,
    filter_: str = "auto",
    drehung: int = 0,
    helligkeit: int = 0,
    kontrast: int = 0,
) -> tuple[bytes, str]:
    """Schneidet das Dokument aus, entzerrt es und wendet den Filter an.

    ``helligkeit``/``kontrast``: Feinkorrektur −50 … +50 nach dem Filter.
    Ergebnis: (Bilddaten, "png" | "jpeg")."""
    cv2 = _cv2()
    if filter_ not in FILTER:
        filter_ = "auto"
    helligkeit = max(-50, min(50, int(helligkeit)))
    kontrast = max(-50, min(50, int(kontrast)))
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

    if filter_ == "auto":
        filter_ = "farbe" if farbig(rgb) else "dokument"
    if filter_ == "original":
        return _speichern(Image.fromarray(_korrigieren(rgb, helligkeit, kontrast)), "jpeg")
    if filter_ == "farbe":
        return _speichern(Image.fromarray(_korrigieren(_farbe_aufhellen(rgb), helligkeit, kontrast)), "jpeg")
    grau = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    if filter_ == "grau":
        return _speichern(Image.fromarray(_korrigieren(grau, helligkeit, kontrast)), "jpeg")
    if filter_ == "dokument":
        flach = cv2.cvtColor(_farbe_aufhellen(rgb), cv2.COLOR_RGB2GRAY)
        return _speichern(Image.fromarray(_korrigieren(flach, helligkeit, kontrast)), "jpeg")
    flach = _schatten_entfernen(grau)
    if filter_ == "sw":
        # Helligkeit verschiebt die Schwelle: heller = mehr Papier, dunkler = kräftigere Schrift
        c = 12 + helligkeit / 5
        sw = cv2.adaptiveThreshold(_korrigieren(flach, 0, kontrast), 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, c)
        return _speichern(Image.fromarray(sw).convert("1"), "png")
    return _speichern(Image.fromarray(_korrigieren(flach, helligkeit, kontrast)), "jpeg")


def farbig(rgb: np.ndarray) -> bool:
    """Hat das Bild nennenswerte Farbflächen (Logo, Stempel, Markierung)?
    Maß nach Hasler/Süsstrunk auf verkleinertem Bild."""
    cv2 = _cv2()
    h, b = rgb.shape[:2]
    faktor = min(1.0, 400 / max(h, b))
    klein = cv2.resize(rgb, (max(1, int(b * faktor)), max(1, int(h * faktor))), interpolation=cv2.INTER_AREA).astype(np.float32)
    r, g, bl = klein[:, :, 0], klein[:, :, 1], klein[:, :, 2]
    rg = r - g
    yb = 0.5 * (r + g) - bl
    wert = np.sqrt(rg.std() ** 2 + yb.std() ** 2) + 0.3 * np.sqrt(rg.mean() ** 2 + yb.mean() ** 2)
    # deutlich gesättigte Pixel zählen – ein farbiges Logo reicht
    hsv = cv2.cvtColor(klein.astype(np.uint8), cv2.COLOR_RGB2HSV)
    bunt = float(((hsv[:, :, 1] > 90) & (hsv[:, :, 2] > 60)).mean())
    return wert > 22 or bunt > 0.02


def _farbe_aufhellen(rgb: np.ndarray) -> np.ndarray:
    """Licht/Schatten ausgleichen, Farben erhalten.

    Die Beleuchtung wird als glatte Fläche (Polynom 3. Grades) nur aus
    Papierpixeln geschätzt – hell, ungesättigt, lokal am hellsten. Farbige
    oder dunkle Flächen (Logos, Fotos, Balken) zählen nicht mit und werden
    deshalb auch nicht „aufgehellt“. Alle Kanäle werden durch dieselbe Fläche
    geteilt: Papier wird gleichmäßig weiß, Farbtöne bleiben."""
    cv2 = _cv2()
    h, b = rgb.shape[:2]
    faktor = min(1.0, 420 / max(h, b))
    kb, kh = max(8, int(b * faktor)), max(8, int(h * faktor))
    klein = cv2.resize(rgb, (kb, kh), interpolation=cv2.INTER_AREA)
    hsv = cv2.cvtColor(klein, cv2.COLOR_RGB2HSV)
    grau = cv2.cvtColor(klein, cv2.COLOR_RGB2GRAY).astype(np.float32)
    lokal_max = cv2.dilate(grau, np.ones((9, 9), np.uint8))
    hell = float(np.percentile(grau, 98))
    papier = (hsv[:, :, 1] < 45) & (grau >= 0.88 * lokal_max) & (grau > 0.42 * hell)
    if papier.sum() < 50:
        return _korrigieren_weiss(rgb, hell)
    # Beleuchtung aus den Papierpixeln interpolieren (normierte Faltung):
    # folgt Licht und Schatten auch dort, wo Screenshot-Rand und Foto
    # aneinanderstoßen; Lücken (Logos, Text) werden aus der Umgebung gefüllt.
    m = papier.astype(np.float32)
    g = grau * m

    def glatt(bild: np.ndarray, sigma: float) -> np.ndarray:
        return cv2.GaussianBlur(bild, (0, 0), sigma, borderType=cv2.BORDER_REFLECT)

    sigma = max(2.0, max(kb, kh) / 40)
    gewicht = glatt(m, sigma)
    fein = glatt(g, sigma) / np.maximum(gewicht, 1e-4)
    grob = glatt(g, sigma * 5) / np.maximum(glatt(m, sigma * 5), 1e-4)
    mischen = np.clip(gewicht / 0.25, 0, 1)
    gefuellt = np.where(glatt(m, sigma * 5) > 1e-3, mischen * fein + (1 - mischen) * grob, hell)
    # Papier behält seine Werte, der Rest wird aufgefüllt; dann kantenerhaltend
    # glätten (Guided Filter): der Übergang Screenshot-Rand → Foto bleibt scharf,
    # Text und Rauschen verschwinden.
    roh = np.where(papier, cv2.medianBlur(grau.astype(np.uint8), 3).astype(np.float32), gefuellt.astype(np.float32))
    feld_klein = _guided(grau / 255.0, roh / 255.0, max(2, int(sigma * 1.5)), 4e-3) * 255.0
    feld_klein = np.clip(feld_klein, 0.35 * hell, 255).astype(np.float32)
    feld = cv2.resize(feld_klein, (b, h), interpolation=cv2.INTER_CUBIC)
    gain = 248.0 / np.maximum(feld, 1)
    flach = np.clip(rgb.astype(np.float32) * gain[:, :, None], 0, 255)
    # leicht nachkontrastieren: dunkelste Stellen etwas tiefer, Papier bleibt
    tief = float(np.percentile(cv2.cvtColor(flach.astype(np.uint8), cv2.COLOR_RGB2GRAY), 0.5))
    if tief > 25:
        flach = np.clip((flach - tief * 0.6) * 255.0 / (255 - tief * 0.6), 0, 255)
    return flach.astype(np.uint8)


def _guided(fuehrung: np.ndarray, quelle: np.ndarray, radius: int, eps: float) -> np.ndarray:
    """Guided Filter (He et al.): glättet ``quelle``, erhält aber Kanten der ``fuehrung``."""
    cv2 = _cv2()

    def mittel(x: np.ndarray) -> np.ndarray:
        return cv2.boxFilter(x.astype(np.float32), -1, (2 * radius + 1, 2 * radius + 1), borderType=cv2.BORDER_REFLECT)

    m_i, m_p = mittel(fuehrung), mittel(quelle)
    kov = mittel(fuehrung * quelle) - m_i * m_p
    var = mittel(fuehrung * fuehrung) - m_i * m_i
    a = kov / (var + eps)
    b = m_p - a * m_i
    return mittel(a) * fuehrung + mittel(b)


def _korrigieren_weiss(rgb: np.ndarray, hell: float) -> np.ndarray:
    """Ohne erkennbares Papier: nur den Weißpunkt anheben."""
    if hell < 30:
        return rgb
    return np.clip(rgb.astype(np.float32) * (248.0 / hell), 0, 255).astype(np.uint8)


def _korrigieren(bild: np.ndarray, helligkeit: int, kontrast: int) -> np.ndarray:
    if not helligkeit and not kontrast:
        return bild
    k = 1 + kontrast / 50 if kontrast >= 0 else 1 + kontrast / 100
    wert = (bild.astype(np.float32) - 128) * k + 128 + helligkeit * 1.8
    return np.clip(wert, 0, 255).astype(np.uint8)


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


MAX_KANTE = 3500  # Pixel – reicht für Texterkennung, bleibt flott


def seite_als_bild(seite, dpi: int = 0) -> bytes:
    """Seite rendern (für „Seite aufbereiten“).

    Ohne ``dpi``: Auflösung der größten eingebetteten Grafik (Scan, Foto,
    Screenshot) übernehmen, mindestens 150, höchstens 400 dpi und nie mehr
    als ``MAX_KANTE`` Pixel an der langen Seite.
    """
    if not dpi:
        dpi = 200
        try:
            infos = seite.get_image_info()
        except Exception:  # noqa: BLE001 – kaputte Bildobjekte: Standard nehmen
            infos = []
        if infos:
            gross = max(infos, key=lambda i: abs(pymupdf.Rect(i["bbox"])))
            breite_zoll = max(1e-3, pymupdf.Rect(gross["bbox"]).width / 72)
            hoehe_zoll = max(1e-3, pymupdf.Rect(gross["bbox"]).height / 72)
            eigen = max(gross.get("width", 0) / breite_zoll, gross.get("height", 0) / hoehe_zoll)
            if gross.get("transform") and abs(gross["transform"][1]) > abs(gross["transform"][0]):
                eigen = max(gross.get("height", 0) / breite_zoll, gross.get("width", 0) / hoehe_zoll)
            dpi = max(150, min(400, round(eigen)))
    lang = max(seite.rect.width, seite.rect.height) / 72
    dpi = max(36, min(dpi, int(MAX_KANTE / max(lang, 1e-3))))
    pix = seite.get_pixmap(dpi=dpi, alpha=False)
    return pix.tobytes("png")


def bild_als_pdf(daten: bytes) -> pymupdf.Document:
    """Bild als einseitige PDF in Papiergröße: Breite wie A4 (hoch) bzw. A4
    quer, Höhe passend zum Seitenverhältnis – so werden kleine Screenshots
    nicht briefmarkengroß und große Fotos keine Plakate."""
    with Image.open(io.BytesIO(daten)) as im:
        breite, hoehe = im.size
    a4_breite, a4_hoehe = pymupdf.paper_size("a4")
    seiten_breite = a4_breite if hoehe >= breite else a4_hoehe
    seiten_hoehe = seiten_breite * hoehe / max(1, breite)
    pdf = pymupdf.open()
    seite = pdf.new_page(width=seiten_breite, height=seiten_hoehe)
    seite.insert_image(seite.rect, stream=daten)
    return pdf
