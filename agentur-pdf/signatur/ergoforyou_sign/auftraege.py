"""Unterschriftsaufträge – je Auftrag ein Ordner im Datenordner:

    auftraege/<id>/auftrag.json        Angaben, Personen, Felder, Verlauf
    auftraege/<id>/original.pdf        so wie verschickt
    auftraege/<id>/arbeitsstand.pdf    mit den bisher gesetzten Unterschriften
    auftraege/<id>/ergebnis.pdf        alle unterschrieben + Prüfprotokoll
    auftraege/<id>/unterschriften/     Unterschriftsbilder je Person (Protokoll)
    auftraege/<id>/seiten/             Seitenbilder für die Kundenseite

Jede unterzeichnende Person hat einen eigenen Link (und optional einen eigenen
Zugangscode). Fertig unterschriebene Dokumente liegen zusätzlich lesbar
benannt unter ``unterschrieben/``.
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

from zoneinfo import ZoneInfo

ZEITZONE = ZoneInfo("Europe/Berlin")
OFFEN = ("offen", "geoeffnet", "teilweise")
KOPIE_TAGE = 30
MAX_CODE_FEHLER = 5
MAX_PERSONEN = 8


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


def _code_hash(auftrag_id: str, nr: int, code: str) -> str:
    return hashlib.sha256(f"{auftrag_id}:{nr}:{code}".encode()).hexdigest() if code else ""


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
        self._tokens: dict[str, tuple[str, int]] = {}
        for datei in self.ordner.glob("*/auftrag.json"):
            try:
                a = _umstellen(json.loads(datei.read_text(encoding="utf-8")))
            except (OSError, ValueError, KeyError):
                continue
            for p in a["personen"]:
                self._tokens[p["token"]] = (a["id"], p["nr"])

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
        return status_aktualisieren(_umstellen(a))

    def speichern(self, a: dict) -> None:
        datei = self.pfad(a["id"]) / "auftrag.json"
        with self.sperre:
            temp = datei.with_name(f".auftrag.{threading.get_ident()}.tmp")
            temp.write_text(json.dumps(a, ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(temp, datei)

    def nach_token(self, token: str) -> tuple[dict, dict]:
        """Auftrag und Person zum Link."""
        treffer = self._tokens.get(token) if len(token) >= 20 else None
        if not treffer:
            raise AuftragFehler("Dieser Link ist ungültig.", 404)
        a = self.laden(treffer[0])
        p = person(a, treffer[1])
        if not secrets.compare_digest(p["token"], token):
            raise AuftragFehler("Dieser Link ist ungültig.", 404)
        return a, p

    def stand_pdf(self, a: dict) -> Path:
        """Aktuelle Fassung zum Ansehen/Unterschreiben (mit bisherigen Unterschriften)."""
        stand = self.pfad(a["id"], "arbeitsstand.pdf")
        return stand if stand.exists() else self.pfad(a["id"], "original.pdf")

    # ----------------------------------------------------------- Anlegen
    def anlegen(self, pdf: bytes, angaben: dict, seiten: list[dict], felder: list[dict], personen: list[dict]) -> dict:
        zeit = jetzt()
        auftrag_id = f"{zeit.astimezone(ZEITZONE):%Y%m%d}-{secrets.token_hex(4)}"
        tage = max(1, min(90, int(angaben.get("gueltig_tage") or 14)))
        a = {
            "id": auftrag_id,
            "version": 2,
            "titel": str(angaben.get("titel") or "Dokument").strip()[:200],
            "dateiname": dateiname(str(angaben.get("dateiname") or angaben.get("titel") or "Dokument")),
            "nachricht": str(angaben.get("nachricht") or "").strip()[:2000],
            "erstellt": iso(zeit),
            "erstellt_von": str(angaben.get("erstellt_von") or "").strip()[:100],
            "gueltig_bis": iso(zeit + timedelta(days=tage)),
            "reihenfolge": bool(angaben.get("reihenfolge")),
            "hubspot": {
                "kontakt_id": str(angaben.get("hubspot_kontakt_id") or "").strip(),
                "deal_id": str(angaben.get("hubspot_deal_id") or "").strip(),
                "kontakt_name": str(angaben.get("hubspot_kontakt_name") or "").strip()[:150],
            },
            "status": "offen",
            "seiten": seiten,
            "felder": felder,
            "personen": [
                {
                    "nr": i + 1,
                    "rolle": str(p.get("rolle") or "").strip()[:60] or ("Kunde" if i == 0 else f"Person {i + 1}"),
                    "name": str(p.get("name") or "").strip()[:150],
                    "email": str(p.get("email") or "").strip()[:200],
                    "telefon": str(p.get("telefon") or "").strip()[:60],
                    "hubspot_kontakt_id": str(p.get("hubspot_kontakt_id") or "").strip(),
                    "token": secrets.token_urlsafe(32),
                    "code_hash": _code_hash(auftrag_id, i + 1, str(p.get("code") or "").strip()),
                    "code_fehler": 0,
                    "status": "offen",
                    "unterschrift": None,
                }
                for i, p in enumerate(personen[:MAX_PERSONEN])
            ],
            "sha_original": sha256(pdf),
            "sha_stand": sha256(pdf),
            "sha_ergebnis": "",
            "fertig": "",
            "kopie_bis": "",
            "ablage": {"hubspot_gesendet": "", "hubspot_fertig": "", "hubspot_fehler": "", "datei": ""},
            "verlauf": [],
        }
        with self.sperre:
            ordner = self.pfad(auftrag_id)
            ordner.mkdir(parents=True)
            (ordner / "original.pdf").write_bytes(pdf)
            namen = ", ".join(p["name"] or p["rolle"] for p in a["personen"])
            self.ereignis(a, "erstellt", text=f"Erstellt von {a['erstellt_von'] or 'Büro'} für {namen}", speichern=False)
            self.speichern(a)
            for p in a["personen"]:
                self._tokens[p["token"]] = (auftrag_id, p["nr"])
        return a

    def ereignis(self, a: dict, art: str, ip: str = "", geraet: str = "", text: str = "", nr: int = 0, speichern: bool = True) -> None:
        a["verlauf"].append({"zeit": iso(jetzt()), "art": art, "ip": ip, "geraet": geraet[:300], "text": text, "nr": nr})
        if speichern:
            self.speichern(a)

    def liste(self) -> list[dict]:
        ergebnis = []
        for datei in self.ordner.glob("*/auftrag.json"):
            try:
                a = status_aktualisieren(_umstellen(json.loads(datei.read_text(encoding="utf-8"))))
            except (OSError, ValueError, KeyError):
                continue
            ergebnis.append(zusammenfassung(a))
        return sorted(ergebnis, key=lambda a: a["erstellt"], reverse=True)

    def code_pruefen(self, a: dict, p: dict, code: str) -> bool:
        if p.get("alt_code_hash"):  # Auftrag aus Version 0.1.0
            alt = hashlib.sha256(f"{a['id']}:{code.strip()}".encode()).hexdigest()
            return secrets.compare_digest(alt, p["alt_code_hash"])
        if not p["code_hash"]:
            return True
        return secrets.compare_digest(_code_hash(a["id"], p["nr"], code.strip()), p["code_hash"])

    def fertig_ablegen(self, a: dict, pdf: bytes) -> Path:
        namen = ", ".join(p["unterschrift"]["name"] for p in a["personen"] if p.get("unterschrift"))
        name = dateiname(f"{aus_iso(a['erstellt']).astimezone(ZEITZONE):%Y-%m-%d} {a['titel']} – {namen}")
        ziel = self.fertig_ordner / f"{name} ({a['id'][-8:]}).pdf"
        ziel.write_bytes(pdf)
        return ziel


# ---------------------------------------------------------------- Helfer
def person(a: dict, nr: int) -> dict:
    for p in a["personen"]:
        if p["nr"] == nr:
            return p
    raise AuftragFehler("Unbekannte Person.", 404)


def status_aktualisieren(a: dict) -> dict:
    """Gesamtstatus aus den Personen ableiten (Widerruf bleibt bestehen)."""
    if a["status"] == "widerrufen":
        return a
    personen = a["personen"]
    if all(p["status"] == "unterschrieben" for p in personen):
        a["status"] = "unterschrieben"
    elif jetzt() > aus_iso(a["gueltig_bis"]):
        a["status"] = "abgelaufen"
    elif any(p["status"] == "unterschrieben" for p in personen):
        a["status"] = "teilweise"
    elif any(p["status"] == "geoeffnet" for p in personen):
        a["status"] = "geoeffnet"
    else:
        a["status"] = "offen"
    return a


def braucht_code(p: dict) -> bool:
    return bool(p["code_hash"] or p.get("alt_code_hash"))


def ist_dran(a: dict, p: dict) -> bool:
    """Bei fester Reihenfolge: alle vorherigen Personen haben unterschrieben."""
    if not a.get("reihenfolge"):
        return True
    return all(q["status"] == "unterschrieben" for q in a["personen"] if q["nr"] < p["nr"])


def felder_von(a: dict, p: dict) -> list[dict]:
    return [f for f in a["felder"] if f.get("person", 1) == p["nr"]]


def _umstellen(a: dict) -> dict:
    """Aufträge aus Version 0.1.0 (eine Person, Token am Auftrag) übernehmen."""
    if a.get("version") == 2:
        return a
    u = a.get("unterzeichner") or None
    a["personen"] = [
        {
            "nr": 1,
            "rolle": "Kunde",
            "name": (a.get("empfaenger") or {}).get("name", ""),
            "email": (a.get("empfaenger") or {}).get("email", ""),
            "telefon": "",
            "hubspot_kontakt_id": (a.get("hubspot") or {}).get("kontakt_id", ""),
            "token": a.pop("token"),
            "code_hash": "",
            "alt_code_hash": a.pop("code_hash", ""),
            "code_fehler": a.pop("code_fehler", 0),
            "status": "unterschrieben" if a.get("status") == "unterschrieben" else ("geoeffnet" if a.get("status") == "geoeffnet" else "offen"),
            "unterschrift": {k: u[k] for k in ("name", "zeit", "ip", "geraet")} if u else None,
        }
    ]
    for f in a["felder"]:
        f.setdefault("person", 1)
    a["fertig"] = u["zeit"] if u else ""
    a["kopie_bis"] = (u or {}).get("kopie_bis", "")
    a["reihenfolge"] = False
    a["sha_stand"] = a.get("sha_original", "")
    a.pop("unterzeichner", None)
    a.pop("empfaenger", None)
    a["version"] = 2
    return a


def zusammenfassung(a: dict) -> dict:
    """Was Ergoforyou PDF in der Übersicht zeigt (ohne Tokens und Verlauf)."""
    letzte = next((e for e in reversed(a["verlauf"]) if e["art"] in ("geoeffnet", "unterschrieben", "kopie")), None)
    return {
        "id": a["id"],
        "titel": a["titel"],
        "status": a["status"],
        "erstellt": a["erstellt"],
        "erstellt_von": a["erstellt_von"],
        "gueltig_bis": a["gueltig_bis"],
        "reihenfolge": a.get("reihenfolge", False),
        "hubspot": a["hubspot"],
        "personen": [
            {
                "nr": p["nr"],
                "rolle": p["rolle"],
                "name": p["name"],
                "email": p["email"],
                "status": p["status"],
                "unterschrieben": (p.get("unterschrift") or {}).get("zeit", ""),
                "unterschrieben_als": (p.get("unterschrift") or {}).get("name", ""),
                "mit_code": braucht_code(p),
                "gesperrt": p["code_fehler"] >= MAX_CODE_FEHLER,
            }
            for p in a["personen"]
        ],
        "fertig": a.get("fertig", ""),
        "letzte_aktivitaet": letzte["zeit"] if letzte else "",
        "ablage": a["ablage"],
    }


def link(basis: str, p: dict) -> str:
    return f"{basis.rstrip('/')}/s/{p['token']}" if basis else f"/s/{p['token']}"
