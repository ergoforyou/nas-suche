"""Erzeugt realistische Scan-Nachbildungen aus Text-PDFs (für OCR-Tests)."""

from __future__ import annotations

import io

import numpy as np
import pymupdf
from PIL import Image


def als_scan(quelle: pymupdf.Document, dpi: int = 300, schraeg: float = 0.0, rauschen: float = 8.0,
             jpeg: int | None = 75, drehung: int = 0, dunkel: bool = False, seed: int = 1,
             schwarzweiss: bool = False) -> pymupdf.Document:
    """Jede Seite → Graustufenbild (Rauschen, Schräglage, JPEG) → neue Bild-PDF ohne Text."""
    rng = np.random.default_rng(seed)
    ziel = pymupdf.open()
    for seite in quelle:
        pix = seite.get_pixmap(dpi=dpi, colorspace=pymupdf.csGRAY)
        bild = Image.frombytes("L", (pix.width, pix.height), pix.samples)
        if schraeg:
            bild = bild.rotate(schraeg, resample=Image.BICUBIC, fillcolor=255, expand=False)
        arr = np.asarray(bild, dtype=np.float32)
        if rauschen:
            arr = arr + rng.normal(0, rauschen, arr.shape)
        if dunkel:
            arr = 255 - arr
        bild = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
        if schwarzweiss:  # 1-Bit wie ein typischer Büro-Scanner im S/W-Modus
            bild = bild.point(lambda v: 255 if v > 150 else 0).convert("1")
            jpeg = None
        if drehung:
            bild = bild.rotate(drehung, expand=True)  # gegen den Uhrzeigersinn
        puffer = io.BytesIO()
        if jpeg:
            bild.save(puffer, "JPEG", quality=jpeg, dpi=(dpi, dpi))
        else:
            bild.save(puffer, "PNG", dpi=(dpi, dpi))
        b, h = bild.size
        neu = ziel.new_page(width=b * 72 / dpi, height=h * 72 / dpi)
        neu.insert_image(neu.rect, stream=puffer.getvalue())
    return ziel
