"""HubSpot-Anbindung über den Zugriffsschlüssel einer „Private App“.

Funktioniert mit einem Service-Schlüssel (empfohlen) oder dem Token einer
alten „Private App“. Benötigte Bereiche: crm.objects.contacts.read/.write,
crm.objects.deals.read/.write, files.read, files.write (bei alten Apps:
„files“) und für die eigenen Felder crm.schemas.contacts.write,
crm.schemas.deals.write. Der Schlüssel liegt nur auf dem NAS.
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

# Eigene Felder an Kontakt und Deal (Gruppe „Ergoforyou Sign“) – legt der
# Dienst beim ersten Gebrauch selbst an.
GRUPPE = {"name": "ergoforyou_sign", "label": "Ergoforyou Sign", "displayOrder": -1}
STATUS_WERTE = [
    ("versendet", "Versendet"),
    ("geoeffnet", "Geöffnet"),
    ("teilweise", "Teilweise unterschrieben"),
    ("unterschrieben", "Unterschrieben"),
    ("abgelaufen", "Abgelaufen"),
    ("zurueckgezogen", "Zurückgezogen"),
]
FELDER = [
    {
        "name": "ergoforyou_signatur_status",
        "label": "Unterschrift Status",
        "type": "enumeration",
        "fieldType": "select",
        "options": [{"label": l, "value": v, "displayOrder": i} for i, (v, l) in enumerate(STATUS_WERTE)],
    },
    {"name": "ergoforyou_signatur_dokument", "label": "Unterschrift Dokument", "type": "string", "fieldType": "text"},
    {"name": "ergoforyou_signatur_gesendet", "label": "Unterschrift gesendet am", "type": "datetime", "fieldType": "date"},
    {"name": "ergoforyou_signatur_unterschrieben", "label": "Unterschrieben am", "type": "datetime", "fieldType": "date"},
    {"name": "ergoforyou_signatur_auftrag", "label": "Unterschrift Auftragsnummer", "type": "string", "fieldType": "text"},
]


class HubSpotFehler(Exception):
    pass


class HubSpot:
    def __init__(self, token: str, transport: httpx.BaseTransport | None = None) -> None:
        if not token:
            raise HubSpotFehler("HubSpot ist noch nicht verbunden (Einrichtung auf dem NAS).")
        self._transport = transport
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

    def _anfrage(self, methode: str, pfad: str, erlaubt: tuple[int, ...] = (), **kw) -> dict:
        try:
            antwort = self._client.request(methode, pfad, **kw)
        except httpx.HTTPError as fehler:
            raise HubSpotFehler(f"HubSpot nicht erreichbar ({fehler.__class__.__name__}).") from None
        if antwort.status_code in erlaubt:
            return {}
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

    def deal(self, deal_id: str) -> dict:
        d = self._anfrage("GET", f"/crm/v3/objects/deals/{deal_id}", params={"properties": "dealname,dealstage"})
        return {"id": str(d["id"]), "name": d.get("properties", {}).get("dealname") or f"Deal {d['id']}", "phase": d.get("properties", {}).get("dealstage") or ""}

    def deal_kontakte(self, deal_id: str) -> list[dict]:
        verkn = self._anfrage("GET", f"/crm/v4/objects/deals/{deal_id}/associations/contacts", params={"limit": 20})
        ids = [str(v["toObjectId"]) for v in verkn.get("results", [])]
        if not ids:
            return []
        daten = self._anfrage(
            "POST",
            "/crm/v3/objects/contacts/batch/read",
            json={"inputs": [{"id": i} for i in ids], "properties": ["firstname", "lastname", "email", "company", "mobilephone", "phone"]},
        )
        nach_id = {str(k["id"]): _kontakt(k) for k in daten.get("results", [])}
        return [nach_id[i] for i in ids if i in nach_id]

    def anhaenge(self, objekt: str, objekt_id: str, grenze: int = 20) -> list[dict]:
        """PDF-Anhänge am Kontakt/Deal (aus den Notizen, neueste zuerst)."""
        verkn = self._anfrage("GET", f"/crm/v4/objects/{objekt}/{objekt_id}/associations/notes", params={"limit": 100})
        ids = [str(v["toObjectId"]) for v in verkn.get("results", [])][:100]
        if not ids:
            return []
        notizen = self._anfrage(
            "POST",
            "/crm/v3/objects/notes/batch/read",
            json={"inputs": [{"id": i} for i in ids], "properties": ["hs_attachment_ids", "hs_timestamp"]},
        ).get("results", [])
        notizen.sort(key=lambda n: n.get("properties", {}).get("hs_timestamp") or "", reverse=True)
        ergebnis: list[dict] = []
        gesehen: set[str] = set()
        for n in notizen:
            zeit = n.get("properties", {}).get("hs_timestamp") or ""
            for datei_id in str(n.get("properties", {}).get("hs_attachment_ids") or "").split(";"):
                datei_id = datei_id.strip()
                if not datei_id.isdigit() or datei_id in gesehen:
                    continue
                gesehen.add(datei_id)
                try:
                    d = self._anfrage("GET", f"/files/v3/files/{datei_id}")
                except HubSpotFehler:
                    continue
                name = str(d.get("name") or f"Datei {datei_id}")
                endung = str(d.get("extension") or "").lower()
                if endung != "pdf" and not name.lower().endswith(".pdf"):
                    continue
                ergebnis.append({"id": datei_id, "name": name if name.lower().endswith(".pdf") else f"{name}.pdf", "groesse": d.get("size") or 0, "zeit": zeit})
                if len(ergebnis) >= grenze:
                    return ergebnis
        return ergebnis

    def datei_laden(self, datei_id: str, max_bytes: int = 40_000_000) -> tuple[str, bytes]:
        """Datei aus HubSpot herunterladen (über eine kurzlebige, signierte Adresse)."""
        d = self._anfrage("GET", f"/files/v3/files/{datei_id}")
        signiert = self._anfrage("GET", f"/files/v3/files/{datei_id}/signed-url")
        adresse = str(signiert.get("url") or "")
        if not adresse.startswith("https://"):
            raise HubSpotFehler("HubSpot liefert keine Download-Adresse für die Datei.")
        try:
            # eigener Client: der Zugriffsschlüssel geht nicht an den Datei-Server
            with httpx.Client(timeout=httpx.Timeout(60.0, connect=10.0), transport=self._transport, follow_redirects=True) as c:
                antwort = c.get(adresse)
        except httpx.HTTPError as fehler:
            raise HubSpotFehler(f"Datei nicht ladbar ({fehler.__class__.__name__}).") from None
        if antwort.status_code != 200:
            raise HubSpotFehler(f"Datei nicht ladbar (Fehler {antwort.status_code}).")
        if len(antwort.content) > max_bytes:
            raise HubSpotFehler("Die Datei ist zu groß (max. 40 MB).")
        name = str(d.get("name") or "Dokument")
        return (name if name.lower().endswith(".pdf") else f"{name}.pdf"), antwort.content

    # ------------------------------------------------------- Eigene Felder
    def felder_einrichten(self, objekt: str) -> None:
        """Gruppe und Felder an ``contacts`` bzw. ``deals`` anlegen (vorhandene bleiben)."""
        self._anfrage("POST", f"/crm/v3/properties/{objekt}/groups", erlaubt=(409,), json=GRUPPE)
        for feld in FELDER:
            self._anfrage("POST", f"/crm/v3/properties/{objekt}", erlaubt=(409,), json={**feld, "groupName": GRUPPE["name"]})

    def felder_setzen(self, objekt: str, objekt_id: str, werte: dict) -> None:
        self._anfrage("PATCH", f"/crm/v3/objects/{objekt}/{objekt_id}", json={"properties": werte})

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
