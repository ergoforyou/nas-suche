"""Zugang von außen über den Tunnel-Container (Tailscale Funnel).

Der Container ``ergoforyou-sign-tunnel`` baut eine ausgehende, verschlüsselte
Verbindung auf – kein Port am Router, klappt auch ohne eigene IPv4 (DS-Lite).
Dieser Dienst liest über den gemeinsamen Socket nur den Zustand aus
(Anmeldelink, öffentliche Adresse, ob Funnel freigeschaltet ist) und zeigt ihn
auf der Einrichtungsseite an. Die Weiterleitung selbst steht fest in
``tunnel/funnel.json`` (öffentlich → Port 8480, nur die Kundenseite).
"""

from __future__ import annotations

import os
from pathlib import Path

import httpx

SOCKET = os.environ.get("SIGN_TAILSCALE_SOCKET", "/var/run/tailscale/tailscaled.sock")


def _funnel_erlaubt(selbst: dict) -> bool:
    namen = list((selbst.get("CapMap") or {}).keys()) + list(selbst.get("Capabilities") or [])
    return any("funnel" in str(n).lower() for n in namen)


class Tunnel:
    def __init__(self, socket: str = SOCKET, transport: httpx.BaseTransport | None = None) -> None:
        self.socket = socket
        self._transport = transport

    def vorhanden(self) -> bool:
        return self._transport is not None or Path(self.socket).exists()

    def _get(self, pfad: str) -> dict:
        transport = self._transport or httpx.HTTPTransport(uds=self.socket)
        with httpx.Client(transport=transport, base_url="http://local-tailscaled.sock", timeout=5) as c:
            antwort = c.get(pfad, headers={"Sec-Tailscale": "localapi"})
            antwort.raise_for_status()
            return antwort.json()

    def status(self) -> dict:
        """{zustand, text, login_url?, adresse?, funnel_url?}

        zustand: fehlt | startet | anmelden | freigeben | bereit | fehler
        """
        if not self.vorhanden():
            return {"zustand": "fehlt", "text": "Der Tunnel-Container läuft nicht (Projekt im Container Manager neu erstellen)."}
        try:
            s = self._get("/localapi/v0/status")
        except (httpx.HTTPError, OSError, ValueError) as fehler:
            return {"zustand": "fehler", "text": f"Tunnel nicht ansprechbar ({fehler.__class__.__name__})."}
        stand = s.get("BackendState", "")
        if stand in ("NeedsLogin", "NoState") or (stand != "Running" and s.get("AuthURL")):
            if s.get("AuthURL"):
                return {"zustand": "anmelden", "text": "Einmal bei Tailscale anmelden (kostenloses Konto, z. B. mit Google oder Microsoft).", "login_url": s["AuthURL"]}
            return {"zustand": "startet", "text": "Tunnel startet – Anmeldelink kommt gleich."}
        if stand == "NeedsMachineAuth":
            return {"zustand": "freigeben", "text": "Gerät in der Tailscale-Verwaltung freigeben (Machines → ergoforyou-sign → Approve).", "login_url": "https://login.tailscale.com/admin/machines"}
        if stand != "Running":
            return {"zustand": "startet", "text": f"Tunnel startet ({stand or 'unbekannt'}) …"}
        selbst = s.get("Self") or {}
        dns = str(selbst.get("DNSName") or "").rstrip(".")
        if not dns:
            return {"zustand": "startet", "text": "Tunnel verbunden, Adresse wird vergeben …"}
        adresse = f"https://{dns}"
        if not _funnel_erlaubt(selbst):
            knoten = selbst.get("ID", "")
            return {
                "zustand": "freigeben",
                "text": "Fast fertig: Öffentlichen Zugang (Funnel) einmal in Tailscale freischalten.",
                "login_url": f"https://login.tailscale.com/f/funnel?node={knoten}" if knoten else "https://login.tailscale.com/admin/acls",
                "adresse": adresse,
            }
        return {"zustand": "bereit", "text": "Von außen erreichbar.", "adresse": adresse}
