"""HubSpot-Anbindung über den Zugriffsschlüssel einer „Private App“.

Benötigte Berechtigungen (Scopes): crm.objects.contacts.read,
crm.objects.contacts.write, crm.objects.deals.read, crm.objects.deals.write,
files. Der Schlüssel liegt nur auf dem NAS.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone

import httpx

BASIS = os.environ.get("SIGN_HUBSPOT_BASIS", "https://api.hubapi.com")
ORDNER = "/Ergoforyou Sign"
NOTIZ_KONTAKT = 202  # HubSpot-Standardverknüpfung Notiz → Kontakt
NOTIZ_DEAL = 214  # Notiz → Deal


class HubSpotFehler(Exception):
    pass


class HubSpot:
    def __init__(self, token: str, transport: httpx.BaseTransport | None = None) -> None:
        if not token:
            raise HubSpotFehler("HubSpot ist noch nicht verbunden (Einrichtung auf dem NAS).")
        self._client = httpx.Client(
            base_url=BASIS,
            headers={"Authorization": f"Bearer {token}"},
            timeout=httpx.Timeout(30.0, connect=10.0),
            transport=transport,
        )

    def __enter__(self) -> "HubSpot":
        return self

    def __exit__(self, *_: object) -> None:
        self._client.close()

    def _anfrage(self, methode: str, pfad: str, **kw) -> dict:
        try:
            antwort = self._client.request(methode, pfad, **kw)
        except httpx.HTTPError as fehler:
            raise HubSpotFehler(f"HubSpot nicht erreichbar ({fehler.__class__.__name__}).") from None
        if antwort.status_code == 401:
            raise HubSpotFehler("HubSpot lehnt den Zugriffsschlüssel ab (abgelaufen oder falsch).")
        if antwort.status_code == 403:
            raise HubSpotFehler("Dem HubSpot-Schlüssel fehlt eine Berechtigung: " + _meldung(antwort))
        if antwort.status_code >= 400:
            raise HubSpotFehler(f"HubSpot meldet Fehler {antwort.status_code}: {_meldung(antwort)}")
        return antwort.json() if antwort.content else {}

    # ------------------------------------------------------------ Lesen
    def pruefen(self) -> dict:
        self._anfrage("GET", "/crm/v3/objects/contacts", params={"limit": 1})
        try:
            konto = self._anfrage("GET", "/account-info/v3/details")
        except HubSpotFehler:
            konto = {}
        return {"portal": konto.get("portalId"), "domain": konto.get("uiDomain", "")}

    def kontakte_suchen(self, suche: str) -> list[dict]:
        daten = self._anfrage(
            "POST",
            "/crm/v3/objects/contacts/search",
            json={
                "query": suche,
                "limit": 12,
                "properties": ["firstname", "lastname", "email", "company", "mobilephone", "phone"],
            },
        )
        return [_kontakt(k) for k in daten.get("results", [])]

    def kontakt(self, kontakt_id: str) -> dict:
        daten = self._anfrage(
            "GET",
            f"/crm/v3/objects/contacts/{kontakt_id}",
            params={"properties": "firstname,lastname,email,company,mobilephone,phone"},
        )
        return _kontakt(daten)

    def deals(self, kontakt_id: str) -> list[dict]:
        verkn = self._anfrage("GET", f"/crm/v4/objects/contacts/{kontakt_id}/associations/deals", params={"limit": 50})
        ids = [str(v["toObjectId"]) for v in verkn.get("results", [])]
        if not ids:
            return []
        daten = self._anfrage(
            "POST",
            "/crm/v3/objects/deals/batch/read",
            json={"inputs": [{"id": i} for i in ids], "properties": ["dealname", "dealstage", "amount"]},
        )
        return sorted(
            ({"id": d["id"], "name": d["properties"].get("dealname") or f"Deal {d['id']}", "phase": d["properties"].get("dealstage") or ""} for d in daten.get("results", [])),
            key=lambda d: d["name"].lower(),
        )

    # ----------------------------------------------------------- Ablegen
    def datei_hochladen(self, name: str, daten: bytes) -> str:
        ergebnis = self._anfrage(
            "POST",
            "/files/v3/files",
            files={"file": (name, daten, "application/pdf")},
            data={"folderPath": ORDNER, "options": json.dumps({"access": "PRIVATE", "overwrite": False, "duplicateValidationStrategy": "NONE"})},
        )
        return str(ergebnis["id"])

    def notiz(self, text_html: str, kontakte: list[str] | str = (), deal_id: str = "", anhang: list[str] | None = None) -> str:
        """Notiz an einen oder mehrere Kontakte und optional einen Deal hängen."""
        if isinstance(kontakte, str):
            kontakte = [kontakte] if kontakte else []
        ziele = [(k, NOTIZ_KONTAKT) for k in kontakte if k] + ([(deal_id, NOTIZ_DEAL)] if deal_id else [])
        verknuepfungen = [{"to": {"id": ziel}, "types": [{"associationCategory": "HUBSPOT_DEFINED", "associationTypeId": typ}]} for ziel, typ in ziele]
        eigenschaften = {"hs_timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"), "hs_note_body": text_html}
        if anhang:
            eigenschaften["hs_attachment_ids"] = ";".join(anhang)
        ergebnis = self._anfrage("POST", "/crm/v3/objects/notes", json={"properties": eigenschaften, "associations": verknuepfungen})
        return str(ergebnis["id"])


def _kontakt(k: dict) -> dict:
    p = k.get("properties", {})
    name = " ".join(x for x in (p.get("firstname"), p.get("lastname")) if x).strip()
    return {
        "id": str(k["id"]),
        "name": name or p.get("email") or f"Kontakt {k['id']}",
        "email": p.get("email") or "",
        "firma": p.get("company") or "",
        "telefon": p.get("mobilephone") or p.get("phone") or "",
    }


def _meldung(antwort: httpx.Response) -> str:
    try:
        return str(antwort.json().get("message", ""))[:300]
    except ValueError:
        return antwort.text[:300]
