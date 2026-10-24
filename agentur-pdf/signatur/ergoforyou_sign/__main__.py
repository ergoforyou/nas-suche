"""Start im Container: Kundenseite (8480) und interner Teil (8481) gemeinsam."""

from __future__ import annotations

import asyncio
import os

import uvicorn

from . import PRODUKT, __version__
from .app import Dienst, intern_app, kunde_app
from .konfig import datenordner


async def _laufen() -> None:
    dienst = Dienst(datenordner())
    kunde_port = int(os.environ.get("SIGN_PORT_KUNDE", "8480"))
    intern_port = int(os.environ.get("SIGN_PORT_INTERN", "8481"))
    server = [
        uvicorn.Server(uvicorn.Config(kunde_app(dienst), host="0.0.0.0", port=kunde_port, proxy_headers=False, server_header=False, log_level="warning")),
        uvicorn.Server(uvicorn.Config(intern_app(dienst), host="0.0.0.0", port=intern_port, server_header=False, log_level="warning")),
    ]
    print(f"{PRODUKT} {__version__}: Kundenseite auf Port {kunde_port}, Einrichtung auf Port {intern_port}", flush=True)
    if not dienst.konfig.get("kennwort"):
        print(f"Einrichtung: im Büro-Browser http://<NAS-Adresse>:{intern_port} öffnen und ein Kennwort vergeben.", flush=True)
    await asyncio.gather(*(s.serve() for s in server))


def main() -> None:
    asyncio.run(_laufen())


if __name__ == "__main__":
    main()
