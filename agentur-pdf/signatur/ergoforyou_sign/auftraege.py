"""Unterschriftsaufträge – je Auftrag ein Ordner im Datenordner:

    auftraege/<id>/auftrag.json     Angaben, Felder, Verlauf (Prüfprotokoll)
    auftraege/<id>/original.pdf     so wie verschickt
    auftraege/<id>/ergebnis.pdf     unterschrieben (mit Protokollseite)
    auftraege/<id>/seiten/<n>.png   Seitenbilder für die Kundenseite

Fertig unterschriebene Dokumente liegen zusätzlich lesbar benannt unter
``unterschrieben/``.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from zoneinfo import ZoneInfo

ZEITZONE = ZoneInfo("Europe/Berlin")
OFFEN = ("offen", "geoeffnet")
KOPIE_TAGE = 30
MAX_CODE_FEHLER = 5


def jetzt() -> datetime:
    return datetime.now(timezone.utc)


def iso(zeit: datetime) -> str:
    return zeit.astimezone(timezone.utc).isoformat(timespec="seconds")


def aus_iso(text: str) -> datetime:
    return datetime.fromisoformat(text)


def ortszeit(text: str, mit_sekunden: bool = True) -> str:
    zeit = aus_iso(text).astimezone(ZEITZONE)
    return zeit.strftime("%d.%m.%Y %H:%M:%S" if mit_sekunden else "%d.%m.%Y %H:%M")


def sha256(daten: bytes) -> str:
    return hashlib.sha256(daten).hexdigest()


def dateiname(text: str) -> str:
    text = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', " ", text).strip(" .")
    return re.sub(r"\s+", " ", text)[:120] or "Dokument"


class AuftragFehler(Exception):
    def __init__(self, text: str, status: int = 400) -> None:
        super().__init__(text)
        self.status = status


class Auftraege:
    def __init__(self, ordner: Path) -> None:
        self.ordner = ordner / "auftraege"
        self.fertig_ordner = ordner / "unterschrieben"
        self.ordner.mkdir(parents=True, exist_ok=True)
        self.fertig_ordner.mkdir(parents=True, exist_ok=True)
        # Alle Änderungen an einem Auftrag laufen unter dieser Sperre:
        # laden → ändern → speichern (Kundenseite, Büro und HubSpot-Ablage).
        self.sperre = threading.RLock()
        self._tokens: dict[str, str] = {}
        for datei in self.ordner.glob("*/auftrag.json"):
            try:
                a = json.loads(datei.read_text(encoding="utf-8"))
                self._tokens[a["token"]] = a["id"]
            except (OSError, ValueError, KeyError):
                continue

    # ------------------------------------------------------------ Ablage
    def pfad(self, auftrag_id: str, name: str = "") -> Path:
        if not re.fullmatch(r"[0-9a-z-]{8,40}", auftrag_id):
            raise AuftragFehler("Unbekannter Auftrag.", 404)
        return self.ordner / auftrag_id / name if name else self.ordner / auftrag_id

    def laden(self, auftrag_id: str) -> dict:
        try:
            a = json.loads((self.pfad(auftrag_id) / "auftrag.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raise AuftragFehler("Unbekannter Auftrag.", 404) from None
        return self._status_aktualisieren(a)

    def speichern(self, a: dict) -> None:
        datei = self.pfad(a["id"]) / "auftrag.json"
        with self.sperre:
            temp = datei.with_name(f".auftrag.{threading.get_ident()}.tmp")
            temp.write_text(json.dumps(a, ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(temp, datei)

    def nach_token(self, token: str) -> dict:
        auftrag_id = self._tokens.get(token) if len(token) >= 20 else None
        if not auftrag_id:
            raise AuftragFehler("Dieser Link ist ungültig.", 404)
        a = self.laden(auftrag_id)
        if not secrets.compare_digest(a["token"], token):
            raise AuftragFehler("Dieser Link ist ungültig.", 404)
        return a

    def _status_aktualisieren(self, a: dict) -> dict:
        if a["status"] in OFFEN and jetzt() > aus_iso(a["gueltig_bis"]):
            a["status"] = "abgelaufen"
        return a

    # ----------------------------------------------------------- Anlegen
    def anlegen(self, pdf: bytes, angaben: dict, seiten: list[dict], felder: list[dict]) -> dict:
        zeit = jetzt()
        auftrag_id = f"{zeit.astimezone(ZEITZONE):%Y%m%d}-{secrets.token_hex(4)}"
        token = secrets.token_urlsafe(32)
        tage = max(1, min(90, int(angaben.get("gueltig_tage") or 14)))
        code = str(angaben.get("code") or "").strip()
        a = {
            "id": auftrag_id,
            "token": token,
            "titel": str(angaben.get("titel") or "Dokument").strip()[:200],
            "dateiname": dateiname(str(angaben.get("dateiname") or angaben.get("titel") or "Dokument")),
            "nachricht": str(angaben.get("nachricht") or "").strip()[:2000],
            "erstellt": iso(zeit),
            "erstellt_von": str(angaben.get("erstellt_von") or "").strip()[:100],
            "gueltig_bis": iso(zeit + timedelta(days=tage)),
            "empfaenger": {
                "name": str(angaben.get("empfaenger_name") or "").strip()[:150],
                "email": str(angaben.get("empfaenger_email") or "").strip()[:200],
            },
            "hubspot": {
                "kontakt_id": str(angaben.get("hubspot_kontakt_id") or "").strip(),
                "deal_id": str(angaben.get("hubspot_deal_id") or "").strip(),
                "kontakt_name": str(angaben.get("hubspot_kontakt_name") or "").strip()[:150],
            },
            "code_hash": hashlib.sha256(f"{auftrag_id}:{code}".encode()).hexdigest() if code else "",
            "code_fehler": 0,
            "status": "offen",
            "seiten": seiten,
            "felder": felder,
            "sha_original": sha256(pdf),
            "sha_ergebnis": "",
            "unterzeichner": None,
            "ablage": {"hubspot_gesendet": "", "hubspot_fertig": "", "hubspot_fehler": "", "datei": ""},
            "verlauf": [],
        }
        with self.sperre:
            ordner = self.pfad(auftrag_id)
            ordner.mkdir(parents=True)
            (ordner / "original.pdf").write_bytes(pdf)
            self.ereignis(a, "erstellt", text=f"Erstellt von {a['erstellt_von'] or 'Büro'}", speichern=False)
            self.speichern(a)
            self._tokens[token] = auftrag_id
        return a

    def ereignis(self, a: dict, art: str, ip: str = "", geraet: str = "", text: str = "", speichern: bool = True) -> None:
        a["verlauf"].append({"zeit": iso(jetzt()), "art": art, "ip": ip, "geraet": geraet[:300], "text": text})
        if speichern:
            self.speichern(a)

    def liste(self) -> list[dict]:
        ergebnis = []
        for datei in self.ordner.glob("*/auftrag.json"):
            try:
                a = self._status_aktualisieren(json.loads(datei.read_text(encoding="utf-8")))
            except (OSError, ValueError):
                continue
            ergebnis.append(zusammenfassung(a))
        return sorted(ergebnis, key=lambda a: a["erstellt"], reverse=True)

    def code_pruefen(self, a: dict, code: str) -> bool:
        if not a["code_hash"]:
            return True
        neu = hashlib.sha256(f"{a['id']}:{code.strip()}".encode()).hexdigest()
        return secrets.compare_digest(neu, a["code_hash"])

    def fertig_ablegen(self, a: dict, pdf: bytes) -> Path:
        name = dateiname(f"{aus_iso(a['erstellt']).astimezone(ZEITZONE):%Y-%m-%d} {a['titel']} – {(a.get('unterzeichner') or {}).get('name', '')}")
        ziel = self.fertig_ordner / f"{name} ({a['id'][-8:]}).pdf"
        ziel.write_bytes(pdf)
        return ziel


def zusammenfassung(a: dict) -> dict:
    """Was Ergoforyou PDF in der Übersicht zeigt (ohne Token und Verlauf)."""
    letzte = next((e for e in reversed(a["verlauf"]) if e["art"] in ("geoeffnet", "unterschrieben", "kopie")), None)
    return {
        "id": a["id"],
        "titel": a["titel"],
        "status": a["status"],
        "erstellt": a["erstellt"],
        "erstellt_von": a["erstellt_von"],
        "gueltig_bis": a["gueltig_bis"],
        "empfaenger": a["empfaenger"],
        "hubspot": a["hubspot"],
        "unterzeichnet": (a.get("unterzeichner") or {}).get("zeit", ""),
        "unterzeichner": (a.get("unterzeichner") or {}).get("name", ""),
        "letzte_aktivitaet": letzte["zeit"] if letzte else "",
        "mit_code": bool(a["code_hash"]),
        "ablage": a["ablage"],
    }


def link(basis: str, a: dict) -> str:
    return f"{basis.rstrip('/')}/s/{a['token']}" if basis else f"/s/{a['token']}"
