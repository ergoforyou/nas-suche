"""Schutz des lokalen Dienstes.

Der Dienst lauscht nur auf 127.0.0.1. Trotzdem könnte eine beliebige Webseite
im Browser des Benutzers Anfragen an ``http://127.0.0.1:<port>`` schicken.
Deshalb gilt:

* Jede API-Anfrage braucht das Zugangs-Token, das beim Start zufällig erzeugt
  und nur an das eigene App-Fenster übergeben wird (Header ``X-Agentur-Token``
  oder – für Bild-URLs – Parameter ``t``).
* Der Host-Header muss 127.0.0.1/localhost sein (Schutz gegen DNS-Rebinding).
"""

from __future__ import annotations

import secrets

from fastapi import Request
from fastapi.responses import JSONResponse

ERLAUBTE_HOSTS = {"127.0.0.1", "localhost", "testserver"}


def neues_token() -> str:
    return secrets.token_urlsafe(24)


def pruefe_anfrage(request: Request, token: str) -> JSONResponse | None:
    host = (request.headers.get("host") or "").rsplit(":", 1)[0].strip("[]")
    if host not in ERLAUBTE_HOSTS:
        return JSONResponse({"fehler": "Unzulässiger Host."}, status_code=403)
    if not request.url.path.startswith("/api/"):
        return None
    gesendet = request.headers.get("x-agentur-token") or request.query_params.get("t") or ""
    if not secrets.compare_digest(gesendet, token):
        return JSONResponse({"fehler": "Nicht autorisiert."}, status_code=401)
    return None
