"""Bilder für Eintragungen: Freistellen (weißer Hintergrund → transparent),
Unterschriften-Bibliothek, vorläufige Bildablage.

Freistellen arbeitet in drei Schritten:

1. **Beleuchtung ausgleichen** – bei abfotografierten Unterschriften ist das
   Papier selten gleichmäßig weiß. Der Hintergrund wird mit einem großen
   Maximumfilter geschätzt und herausgerechnet.
2. **Weiche Maske** – helle Pixel werden durchsichtig, dunkle bleiben deckend,
   dazwischen gibt es einen weichen Übergang (Kantenglättung statt
   Treppenstufen).
3. **Farbe entsättigen vom Weiß** – halbtransparente Randpixel bekommen die
   Farbe der Tinte statt eines grauen Saums („Un-Premultiply“ gegen Weiß).
"""

from __future__ import annotations

import base64
import io
import json
import threading
import time
import uuid
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

from ..benutzer.speicher import datenordner
from .dokumente import DokumentFehler

MAX_KANTE = 2400  # größere Bilder werden verkleinert (reicht für 300 dpi auf A5)


def bild_laden(daten: bytes) -> Image.Image:
    try:
        from pillow_heif import register_heif_opener

        register_heif_opener()
    except Exception:  # noqa: BLE001 – HEIC optional
        pass
    try:
        im = Image.open(io.BytesIO(daten))
        im = ImageOps.exif_transpose(im)
        im.load()
    except Exception as fehler:  # noqa: BLE001
        raise DokumentFehler(f"Bild kann nicht gelesen werden: {fehler}") from fehler
    if max(im.size) > MAX_KANTE:
        im.thumbnail((MAX_KANTE, MAX_KANTE), Image.LANCZOS)
    return im


def als_png(im: Image.Image) -> bytes:
    puffer = io.BytesIO()
    im.save(puffer, "PNG", optimize=True)
    return puffer.getvalue()


def freistellen(daten: bytes, staerke: int = 50, zuschneiden: bool = True) -> bytes:
    """Weißen/hellen Hintergrund entfernen. ``staerke`` 0..100: wie hell ein
    Pixel sein muss, um durchsichtig zu werden (höher = mehr wird entfernt)."""
    import cv2

    im = bild_laden(daten)
    if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
        rgba = np.asarray(im.convert("RGBA")).astype(np.float32)
        vorhandenes_alpha = rgba[:, :, 3] / 255.0
        rgb = rgba[:, :, :3]
        # transparente Bereiche wie Weiß behandeln
        rgb = rgb * vorhandenes_alpha[..., None] + 255 * (1 - vorhandenes_alpha[..., None])
    else:
        rgb = np.asarray(im.convert("RGB")).astype(np.float32)
        vorhandenes_alpha = np.ones(rgb.shape[:2], np.float32)

    # 1. Beleuchtung ausgleichen: Hintergrund = großflächiges Maximum (Papier)
    grau = cv2.cvtColor(rgb.astype(np.uint8), cv2.COLOR_RGB2GRAY)
    kern = max(15, (min(grau.shape) // 12) | 1)
    hintergrund = cv2.dilate(grau, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kern, kern)))
    hintergrund = cv2.GaussianBlur(hintergrund, (0, 0), kern / 3).astype(np.float32)
    hintergrund = np.maximum(hintergrund, 60)  # sehr dunkle Bilder nicht explodieren lassen
    ausgeglichen = np.clip(rgb * (255.0 / hintergrund[..., None]), 0, 255)

    # 2. weiche Maske nach Helligkeit
    hell = ausgeglichen.min(axis=2)  # farbige Tinte (blau) zählt nach dunkelstem Kanal
    oben = 250 - (staerke - 50) * 0.6  # ab hier durchsichtig
    unten = oben - 70  # ab hier voll deckend
    alpha = np.clip((oben - hell) / (oben - unten), 0, 1)

    # 3. Farbe ohne Weißanteil: c = (c' - (1-a)*255) / a
    sicher = np.maximum(alpha, 1e-3)[..., None]
    farbe = np.clip((ausgeglichen - (1 - alpha[..., None]) * 255) / sicher, 0, 255)
    alpha = alpha * vorhandenes_alpha

    ergebnis = np.dstack([farbe, alpha * 255]).astype(np.uint8)
    bild = Image.fromarray(ergebnis, "RGBA")
    if zuschneiden:
        box = bild.getchannel("A").point(lambda v: 255 if v > 20 else 0).getbbox()
        if box:
            rand = max(4, round(max(bild.size) * 0.01))
            box = (max(0, box[0] - rand), max(0, box[1] - rand), min(bild.width, box[2] + rand), min(bild.height, box[3] + rand))
            bild = bild.crop(box)
    return als_png(bild)


def normalisieren(daten: bytes) -> bytes:
    """Bild drehen (EXIF), verkleinern und als PNG ablegen (unverändert sonst)."""
    im = bild_laden(daten)
    if im.mode not in ("RGB", "RGBA", "L", "LA"):
        im = im.convert("RGBA" if "transparency" in im.info else "RGB")
    return als_png(im)


def groesse(daten: bytes) -> tuple[int, int]:
    with Image.open(io.BytesIO(daten)) as im:
        return im.size


def daten_url(daten: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(daten).decode()


class BildAblage:
    """Vorläufig hochgeladene Bilder (gelten bis zum Programmende)."""

    MAX = 40

    def __init__(self) -> None:
        self._bilder: dict[str, bytes] = {}
        self._lock = threading.Lock()

    def ablegen(self, daten: bytes) -> str:
        with self._lock:
            schluessel = uuid.uuid4().hex[:12]
            self._bilder[schluessel] = daten
            while len(self._bilder) > self.MAX:
                self._bilder.pop(next(iter(self._bilder)))
            return schluessel

    def holen(self, schluessel: str) -> bytes:
        with self._lock:
            try:
                return self._bilder[schluessel]
            except KeyError:
                raise DokumentFehler("Bild nicht mehr vorhanden – bitte erneut auswählen.") from None


class Unterschriften:
    """Gespeicherte Unterschriften/Bilder pro Benutzer (%APPDATA%\\AgenturPDF\\unterschriften)."""

    def __init__(self, ordner: Path | None = None) -> None:
        self.ordner = ordner or (datenordner() / "unterschriften")
        self.ordner.mkdir(parents=True, exist_ok=True)
        self._index = self.ordner / "index.json"

    def _lesen(self) -> list[dict]:
        try:
            eintraege = json.loads(self._index.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            eintraege = []
        return [e for e in eintraege if (self.ordner / f"{e['id']}.png").is_file()]

    def _schreiben(self, eintraege: list[dict]) -> None:
        temp = self._index.with_suffix(".tmp")
        temp.write_text(json.dumps(eintraege, ensure_ascii=False, indent=2), encoding="utf-8")
        temp.replace(self._index)

    def liste(self) -> list[dict]:
        ergebnis = []
        for e in self._lesen():
            daten = (self.ordner / f"{e['id']}.png").read_bytes()
            b, h = groesse(daten)
            ergebnis.append({**e, "breite": b, "hoehe": h, "bild": daten_url(daten)})
        return ergebnis

    def hinzufuegen(self, daten: bytes, name: str) -> dict:
        eintraege = self._lesen()
        eintrag = {"id": uuid.uuid4().hex[:10], "name": name.strip() or "Unterschrift", "zeit": time.time()}
        (self.ordner / f"{eintrag['id']}.png").write_bytes(daten)
        self._schreiben(eintraege + [eintrag])
        return eintrag

    def holen(self, schluessel: str) -> bytes:
        datei = self.ordner / f"{Path(schluessel).name}.png"
        if not datei.is_file():
            raise DokumentFehler("Unterschrift nicht gefunden.")
        return datei.read_bytes()

    def entfernen(self, schluessel: str) -> None:
        eintraege = [e for e in self._lesen() if e["id"] != schluessel]
        (self.ordner / f"{Path(schluessel).name}.png").unlink(missing_ok=True)
        self._schreiben(eintraege)
