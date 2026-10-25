"""Endpunkte „Zur Unterschrift senden“ – Brücke zu Ergoforyou Sign auf dem NAS."""

from __future__ import annotations

import asyncio
import base64
import getpass
import os
import re
from typing import Any

from fastapi import Body, FastAPI, Query

from ..benutzer.speicher import BenutzerSpeicher
from ..kern import signatur
from ..kern.dokumente import DokumentFehler, DokumentSpeicher
from ..kern.mupdf_thread import im_mupdf_thread


def einrichten(app: FastAPI, dokumente: DokumentSpeicher, benutzer: BenutzerSpeicher) -> None:
    def nas() -> signatur.NasSign:  # wählt die erreichbare Adresse (kurz gemerkt)
        return signatur.NasSign(benutzer.einstellungen().get("signatur_verbindung"))

    async def im_hintergrund(fn, *args: Any):
        return await asyncio.get_running_loop().run_in_executor(None, fn, *args)

    def absender() -> str:
        kuerzel = str(benutzer.einstellungen().get("kuerzel") or "").strip()
        try:
            name = getpass.getuser()
        except Exception:  # noqa: BLE001
            name = os.environ.get("USERNAME", "")
        return " · ".join(x for x in (kuerzel, name) if x)

    @app.get("/api/signatur/status")
    async def status():
        verbindung = benutzer.einstellungen().get("signatur_verbindung") or {}
        if not verbindung.get("url"):
            return {"eingerichtet": False}
        try:
            nas_sign = await im_hintergrund(lambda: signatur.NasSign(verbindung))
            info = await im_hintergrund(lambda: nas_sign.anfrage("GET", "/api/status", zeit=5))
        except DokumentFehler as fehler:
            return {"eingerichtet": True, "erreichbar": False, "url": verbindung["url"], "fehler": str(fehler)}
        return {"eingerichtet": True, "erreichbar": True, "url": nas_sign.url, **info}

    @app.post("/api/signatur/verbinden")
    async def verbinden(code: str = Body(..., embed=True)):
        verbindung = signatur.code_lesen(code)
        await im_hintergrund(lambda: signatur.NasSign(verbindung).anfrage("GET", "/api/status", zeit=8))
        benutzer.einstellungen_setzen({"signatur_verbindung": verbindung})
        return await status()

    @app.post("/api/signatur/trennen")
    async def trennen():
        benutzer.einstellungen_setzen({"signatur_verbindung": {}})
        return {"eingerichtet": False}

    @app.get("/api/signatur/kontakte")
    async def kontakte(q: str = Query("")):
        return await im_hintergrund(lambda: nas().get("/api/hubspot/kontakte", q=q))

    @app.get("/api/signatur/hubspot/{objekt}/{objekt_id}")
    async def hubspot_start(objekt: str, objekt_id: str):
        """Start aus HubSpot (Chrome-Knopf): Kontakt bzw. Deal mit Kontakten."""
        if objekt not in ("kontakt", "deal") or not objekt_id.isdigit():
            raise DokumentFehler("Unbekannter HubSpot-Eintrag.")
        pfad = f"/api/hubspot/kontakte/{objekt_id}" if objekt == "kontakt" else f"/api/hubspot/deals/{objekt_id}"
        return await im_hintergrund(lambda: nas().get(pfad))

    @app.get("/api/signatur/kontakte/{kontakt_id}/deals")
    async def deals(kontakt_id: str):
        if not kontakt_id.isdigit():
            raise DokumentFehler("Unbekannter Kontakt.")
        return await im_hintergrund(lambda: nas().get(f"/api/hubspot/kontakte/{kontakt_id}/deals"))

    @app.get("/api/dokumente/{dok_id}/signatur/felder")
    async def felder(dok_id: str):
        liste = await im_mupdf_thread(lambda: signatur.felder_zaehlen(dokumente.get(dok_id).doc))
        return {"felder": liste, "rollen": signatur.rollen(liste)}

    @app.post("/api/dokumente/{dok_id}/signatur/senden")
    async def senden(dok_id: str, daten: dict = Body(...)):
        verbindung = await im_hintergrund(nas)  # früh prüfen, bevor die PDF aufbereitet wird
        dok = dokumente.get(dok_id)
        pdf, felder_liste = await im_mupdf_thread(signatur.vorbereiten, dok.doc)
        kontakt = daten.get("kontakt") or {}
        personen = daten.get("personen") or [
            {  # eine Person (Dialog bis 0.13.0)
                "rolle": "Kunde",
                "name": str(daten.get("empfaenger_name") or kontakt.get("name") or ""),
                "email": kontakt.get("email", ""),
                "code": daten.get("code", ""),
                "hubspot_kontakt_id": kontakt.get("id", ""),
            }
        ]
        rollen = [str(p.get("rolle") or "").strip() or "Kunde" for p in personen]
        if len(personen) == 1:
            for f in felder_liste:
                f["person"] = 1
        else:
            for f in felder_liste:
                if f["rolle"] not in rollen:
                    raise DokumentFehler(f"Für das Feld „{f['beschriftung']}“ (Rolle {f['rolle']}) ist keine Person angegeben.")
                f["person"] = rollen.index(f["rolle"]) + 1
        titel = str(daten.get("titel") or "").strip() or re.sub(r"\.pdf$", "", dok.titel, flags=re.I)
        nutzlast = {
            "titel": titel,
            "dateiname": titel,
            "pdf": base64.b64encode(pdf).decode(),
            "felder": felder_liste,
            "personen": [
                {
                    "rolle": rollen[i],
                    "name": str(p.get("name") or "").strip(),
                    "email": str(p.get("email") or "").strip(),
                    "telefon": str(p.get("telefon") or "").strip(),
                    "code": str(p.get("code") or "").strip(),
                    "hubspot_kontakt_id": str(p.get("hubspot_kontakt_id") or ""),
                }
                for i, p in enumerate(personen)
            ],
            "reihenfolge": bool(daten.get("reihenfolge")),
            "hubspot_kontakt_id": str(kontakt.get("id") or personen[0].get("hubspot_kontakt_id") or ""),
            "hubspot_kontakt_name": str(kontakt.get("name") or ""),
            "hubspot_deal_id": str(daten.get("deal_id") or ""),
            "gueltig_tage": int(daten.get("gueltig_tage") or 14),
            "nachricht": str(daten.get("nachricht") or ""),
            "erstellt_von": absender(),
        }
        return await im_hintergrund(lambda: verbindung.post("/api/auftraege", nutzlast, zeit=120))

    @app.post("/api/signatur/link-oeffnen")
    async def link_oeffnen(url: str = Body(..., embed=True)):
        """Link (HubSpot, WhatsApp, Kundenseite, E-Mail) im Standardprogramm öffnen."""
        if not re.match(r"^(https://|mailto:)[^\s]+$", url):
            raise DokumentFehler("Nur https- und mailto-Adressen.")
        import webbrowser

        return {"ok": bool(await im_hintergrund(webbrowser.open, url))}

    @app.get("/api/signatur/auftraege")
    async def auftraege():
        return await im_hintergrund(lambda: nas().get("/api/auftraege"))

    @app.get("/api/signatur/auftraege/{auftrag_id}")
    async def auftrag(auftrag_id: str):
        return await im_hintergrund(lambda: nas().get(f"/api/auftraege/{_id(auftrag_id)}"))

    @app.post("/api/signatur/auftraege/{auftrag_id}/{aktion}")
    async def auftrag_aktion(auftrag_id: str, aktion: str, nr: int = Query(0)):
        if aktion == "oeffnen":
            daten = await im_hintergrund(lambda: nas().anfrage("GET", f"/api/auftraege/{_id(auftrag_id)}/pdf", roh=True, zeit=60))
            info = await im_hintergrund(lambda: nas().get(f"/api/auftraege/{_id(auftrag_id)}"))
            name = f"{info['titel']} – unterschrieben.pdf"
            if info["status"] != "unterschrieben":
                raise DokumentFehler("Noch nicht von allen unterschrieben.")
            dok = await im_mupdf_thread(dokumente.oeffnen_bytes, daten, name)
            return await im_mupdf_thread(dokumente.info, dok.id)
        if aktion not in ("widerrufen", "entsperren", "hubspot"):
            raise DokumentFehler("Unbekannte Aktion.")
        nutzlast = {"von": absender()} if aktion != "hubspot" else {}
        if aktion == "entsperren":
            nutzlast["nr"] = int(nr or 0)
        return await im_hintergrund(lambda: nas().post(f"/api/auftraege/{_id(auftrag_id)}/{aktion}", nutzlast))


def _id(auftrag_id: str) -> str:
    if not re.fullmatch(r"[0-9a-z-]{8,40}", auftrag_id):
        raise DokumentFehler("Unbekannter Auftrag.")
    return auftrag_id
