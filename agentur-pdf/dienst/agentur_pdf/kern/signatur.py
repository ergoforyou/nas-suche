"""Online-Unterschrift über „Ergoforyou Sign“ auf dem NAS.

Ergoforyou PDF bereitet das Dokument vor (Unterschriftsfelder herauslösen,
Formular einbrennen) und spricht mit dem NAS-Dienst über dessen interne
Schnittstelle. Verbindung (Adresse + Schlüssel) steht in der Einstellung
„signatur_verbindung“ – bei gemeinsamem Ordner für alle PCs gleich.
"""

from __future__ import annotations

import base64
import json
import urllib.error
import urllib.parse
import urllib.request

import pymupdf

from .anmerkungen import norm_rechteck
from .dokumente import DokumentFehler

PRAEFIX = "EFY-SIGN:"


def code_lesen(code: str) -> dict:
    """Verbindungscode von der Einrichtungsseite → {url, schluessel}."""
    code = "".join(str(code or "").split())
    if not code.startswith(PRAEFIX):
        raise DokumentFehler("Das ist kein Verbindungscode von Ergoforyou Sign (beginnt mit „EFY-SIGN:“).")
    roh = code[len(PRAEFIX):]
    try:
        daten = json.loads(base64.urlsafe_b64decode(roh + "=" * (-len(roh) % 4)))
        url, schluessel = str(daten["u"]).rstrip("/"), str(daten["k"])
    except (ValueError, KeyError, TypeError):
        raise DokumentFehler("Der Verbindungscode ist unvollständig – bitte erneut kopieren.") from None
    if not url.startswith(("http://", "https://")) or len(schluessel) < 20:
        raise DokumentFehler("Der Verbindungscode ist ungültig.")
    return {"url": url, "schluessel": schluessel}


def vorbereiten(doc: pymupdf.Document) -> tuple[bytes, list[dict]]:
    """Kopie des (auch ungespeicherten) Dokuments: Unterschriftsfelder werden
    zu Feldern für die Kundenseite, ausgefüllte Formularfelder fest eingebrannt.
    Nur im MuPDF-Thread aufrufen."""
    kopie = pymupdf.open("pdf", doc.tobytes())
    felder = []
    for seite in kopie:
        for w in [w for w in seite.widgets() if w.field_type == pymupdf.PDF_WIDGET_TYPE_SIGNATURE]:
            felder.append({"seite": seite.number, "rechteck": norm_rechteck(seite, w.rect), "art": "unterschrift", "beschriftung": w.field_name or ""})
            seite.delete_widget(w)
    if hasattr(kopie, "bake"):
        kopie.bake()
    daten = kopie.tobytes(garbage=3, deflate=True)
    kopie.close()
    return daten, felder


def felder_zaehlen(doc: pymupdf.Document) -> list[dict]:
    return [
        {"seite": s.number, "name": w.field_name or ""}
        for s in doc
        for w in s.widgets()
        if w.field_type == pymupdf.PDF_WIDGET_TYPE_SIGNATURE
    ]


class NasSign:
    def __init__(self, verbindung: dict | None) -> None:
        verbindung = verbindung or {}
        self.url = str(verbindung.get("url") or "").rstrip("/")
        self.schluessel = str(verbindung.get("schluessel") or "")
        if not self.url or not self.schluessel:
            raise DokumentFehler("Online-Unterschrift ist noch nicht eingerichtet (Einstellungen → Unterschriften).")

    def anfrage(self, methode: str, pfad: str, daten: dict | None = None, roh: bool = False, zeit: float = 30):
        kopf = {"X-Sign-Schluessel": self.schluessel, "Accept": "application/json"}
        inhalt = None
        if daten is not None:
            inhalt = json.dumps(daten).encode()
            kopf["Content-Type"] = "application/json"
        anfrage = urllib.request.Request(self.url + pfad, data=inhalt, headers=kopf, method=methode)
        try:
            with urllib.request.urlopen(anfrage, timeout=zeit) as antwort:  # noqa: S310 – Adresse aus eigener Einrichtung
                daten_roh = antwort.read()
        except urllib.error.HTTPError as fehler:
            try:
                text = json.loads(fehler.read()).get("fehler") or ""
            except (ValueError, OSError):
                text = ""
            raise DokumentFehler(text or f"Ergoforyou Sign meldet Fehler {fehler.code}.") from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise DokumentFehler(f"Ergoforyou Sign auf dem NAS ist nicht erreichbar ({self.url}).") from None
        return daten_roh if roh else json.loads(daten_roh or b"{}")

    def get(self, pfad: str, **parameter):
        if parameter:
            pfad += "?" + urllib.parse.urlencode(parameter)
        return self.anfrage("GET", pfad)

    def post(self, pfad: str, daten: dict | None = None, zeit: float = 30):
        return self.anfrage("POST", pfad, daten or {}, zeit=zeit)
