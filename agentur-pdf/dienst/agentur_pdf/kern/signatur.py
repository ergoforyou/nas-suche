"""Online-Unterschrift über „Ergoforyou Sign“ auf dem NAS.

Ergoforyou PDF bereitet das Dokument vor (Unterschriftsfelder herauslösen,
Formular einbrennen) und spricht mit dem NAS-Dienst über dessen interne
Schnittstelle. Verbindung (Adresse + Schlüssel) steht in der Einstellung
„signatur_verbindung“ – bei gemeinsamem Ordner für alle PCs gleich.
"""

from __future__ import annotations

import base64
import json
import re
import threading
import time
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
        weitere = [str(a).rstrip("/") for a in daten.get("a") or []]
    except (ValueError, KeyError, TypeError, AttributeError):
        raise DokumentFehler("Der Verbindungscode ist unvollständig – bitte erneut kopieren.") from None
    urls = list(dict.fromkeys([url, *weitere]))
    if not all(u.startswith(("http://", "https://")) for u in urls) or len(schluessel) < 20:
        raise DokumentFehler("Der Verbindungscode ist ungültig.")
    return {"url": url, "schluessel": schluessel, "urls": urls}


# Zuletzt erreichbare Adresse je Verbindung (Büro direkt oder unterwegs über
# Tailscale) – wird für eine Minute gemerkt, dann neu geprüft.
_ERREICHBAR: dict[str, tuple[str, float]] = {}
_ERREICHBAR_LOCK = threading.Lock()
MERKEN_S = 60
PRUEF_ZEIT_S = 3


def rolle(feldname: str) -> str:
    """Rolle aus dem Feldnamen: „Unterschrift Ehepartner 2“ → „Ehepartner“.
    Felder derselben Rolle unterschreibt dieselbe Person."""
    name = re.sub(r"\s+\d+$", "", (feldname or "").strip())
    name = re.sub(r"^unterschrift\b[\s:–-]*", "", name, flags=re.I).strip()
    return name or "Kunde"


def vorbereiten(doc: pymupdf.Document) -> tuple[bytes, list[dict]]:
    """Kopie des (auch ungespeicherten) Dokuments: Unterschriftsfelder werden
    zu Feldern für die Kundenseite (mit Rolle), ausgefüllte Formularfelder
    fest eingebrannt. Nur im MuPDF-Thread aufrufen."""
    kopie = pymupdf.open("pdf", doc.tobytes())
    felder = []
    for seite in kopie:
        for w in [w for w in seite.widgets() if w.field_type == pymupdf.PDF_WIDGET_TYPE_SIGNATURE]:
            felder.append(
                {"seite": seite.number, "rechteck": norm_rechteck(seite, w.rect), "art": "unterschrift", "beschriftung": w.field_name or "", "rolle": rolle(w.field_name)}
            )
            seite.delete_widget(w)
    if hasattr(kopie, "bake"):
        kopie.bake()
    daten = kopie.tobytes(garbage=3, deflate=True)
    kopie.close()
    return daten, felder


def felder_zaehlen(doc: pymupdf.Document) -> list[dict]:
    """Unterschriftsfelder für die Vorschau im Senden-Dialog."""
    return [
        {"seite": s.number, "name": w.field_name or "", "rolle": rolle(w.field_name), "rechteck": norm_rechteck(s, w.rect)}
        for s in doc
        for w in s.widgets()
        if w.field_type == pymupdf.PDF_WIDGET_TYPE_SIGNATURE
    ]


def rollen(felder: list[dict]) -> list[str]:
    """Rollen in Reihenfolge des ersten Auftretens; „Kunde“ zuerst."""
    liste = list(dict.fromkeys(f["rolle"] for f in felder))
    return sorted(liste, key=lambda r: (r != "Kunde",)) or ["Kunde"]


class NasSign:
    def __init__(self, verbindung: dict | None) -> None:
        verbindung = verbindung or {}
        self.urls = [str(u).rstrip("/") for u in verbindung.get("urls") or [verbindung.get("url") or ""] if u]
        self.schluessel = str(verbindung.get("schluessel") or "")
        if not self.urls or not self.schluessel:
            raise DokumentFehler("Online-Unterschrift ist noch nicht eingerichtet – oben rechts „Beta MK I“ → Online-Unterschrift → Verbindungscode einfügen.")
        self.url = self._erreichbare_adresse() if len(self.urls) > 1 else self.urls[0]

    def _erreichbare_adresse(self) -> str:
        """Erste erreichbare Adresse (Büronetz zuerst, dann Tailscale)."""
        merk = self.schluessel[:16]
        with _ERREICHBAR_LOCK:
            gemerkt = _ERREICHBAR.get(merk)
        if gemerkt and gemerkt[0] in self.urls and time.time() - gemerkt[1] < MERKEN_S:
            return gemerkt[0]
        for url in self.urls:
            try:
                anfrage = urllib.request.Request(url + "/api/status", headers={"X-Sign-Schluessel": self.schluessel})
                with urllib.request.urlopen(anfrage, timeout=PRUEF_ZEIT_S):  # noqa: S310
                    pass
            except (urllib.error.URLError, TimeoutError, OSError):
                continue
            with _ERREICHBAR_LOCK:
                _ERREICHBAR[merk] = (url, time.time())
            return url
        raise DokumentFehler(
            "Ergoforyou Sign auf dem NAS ist nicht erreichbar"
            + (" – im Büronetz oder (unterwegs) mit eingeschalteter Tailscale-App versuchen." if len(self.urls) > 1 else f" ({self.urls[0]}).")
        )

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
