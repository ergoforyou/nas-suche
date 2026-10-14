"""HTTP-Schnittstelle zwischen Oberfläche und Dokument-Kern."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Callable

from fastapi import Body, FastAPI, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response

from .. import __version__
from ..benutzer.speicher import BenutzerSpeicher
from ..kern.dokumente import DokumentFehler, DokumentSpeicher
from ..kern.mupdf_thread import im_mupdf_thread
from .sicherheit import pruefe_anfrage

OEFFENBARE_ENDUNGEN = {".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".gif", ".xps", ".epub"}


def erstelle_app(
    token: str,
    dokumente: DokumentSpeicher | None = None,
    benutzer: BenutzerSpeicher | None = None,
    oberflaeche_ordner: Path | None = None,
    datei_dialog: Callable[[], list[str]] | None = None,
) -> FastAPI:
    app = FastAPI(title="Agentur-PDF", version=__version__, docs_url=None, redoc_url=None, openapi_url=None)
    dokumente = dokumente or DokumentSpeicher()
    benutzer = benutzer or BenutzerSpeicher()
    app.state.dokumente = dokumente
    app.state.benutzer = benutzer
    app.state.datei_dialog = datei_dialog

    @app.middleware("http")
    async def sicherheit(request: Request, call_next):
        abgelehnt = pruefe_anfrage(request, token)
        if abgelehnt is not None:
            return abgelehnt
        return await call_next(request)

    @app.exception_handler(DokumentFehler)
    async def dokument_fehler(_request: Request, fehler: DokumentFehler):
        return JSONResponse({"fehler": str(fehler)}, status_code=400)

    # ------------------------------------------------------------- Allgemein
    @app.get("/api/status")
    async def status():
        return {
            "version": __version__,
            "desktop": app.state.datei_dialog is not None,
            "cache_bytes": dokumente.cache.groesse,
        }

    # ------------------------------------------------------------ Dokumente
    @app.get("/api/dokumente")
    async def dokumente_liste():
        return await im_mupdf_thread(lambda: [dokumente.info(d.id) for d in dokumente.alle()])

    @app.post("/api/dokumente/oeffnen")
    async def oeffnen(pfad: str = Body(..., embed=True), passwort: str | None = Body(None, embed=True)):
        dok = await im_mupdf_thread(dokumente.oeffnen_pfad, pfad, passwort)
        info = await im_mupdf_thread(dokumente.info, dok.id)
        if dok.pfad:
            benutzer.zuletzt_hinzufuegen(dok.pfad, dok.titel, info["seitenanzahl"])
        return info

    @app.post("/api/dokumente/hochladen")
    async def hochladen(request: Request, name: str = Query(...), passwort: str | None = Query(None)):
        daten = await request.body()
        if not daten:
            raise DokumentFehler("Leere Datei.")
        dok = await im_mupdf_thread(dokumente.oeffnen_bytes, daten, name, passwort)
        return await im_mupdf_thread(dokumente.info, dok.id)

    @app.get("/api/dokumente/{dok_id}")
    async def dokument_info(dok_id: str):
        return await im_mupdf_thread(dokumente.info, dok_id)

    @app.delete("/api/dokumente/{dok_id}")
    async def schliessen(dok_id: str):
        await im_mupdf_thread(dokumente.schliessen, dok_id)
        return {"ok": True}

    @app.get("/api/dokumente/{dok_id}/seiten/{seite}/bild")
    async def seitenbild(
        request: Request,
        dok_id: str,
        seite: int,
        skala: float = 1.0,
        drehung: int = 0,
        x: int | None = None,
        y: int | None = None,
        b: int | None = None,
        h: int | None = None,
    ):
        kachel = (x, y, b, h) if None not in (x, y, b, h) else None
        auftrag = asyncio.ensure_future(im_mupdf_thread(dokumente.render, dok_id, seite, skala, drehung, kachel))
        # Solange der Auftrag noch in der Warteschlange steht: Wurde die Seite
        # inzwischen weggescrollt (Anfrage abgebrochen), Auftrag verwerfen.
        while not auftrag.done():
            await asyncio.wait({auftrag}, timeout=0.05)
            if not auftrag.done() and await request.is_disconnected():
                auftrag.cancel()
                return Response(status_code=499)
        png = auftrag.result()
        # Die URL enthält die Seitenversion (Parameter v) → darf gecacht werden.
        return Response(png, media_type="image/png", headers={"Cache-Control": "private, max-age=3600"})

    @app.get("/api/dokumente/{dok_id}/suche")
    async def suche(dok_id: str, q: str = Query(..., min_length=1)):
        return await im_mupdf_thread(dokumente.suchen, dok_id, q)

    @app.get("/api/dokumente/{dok_id}/lesezeichen")
    async def lesezeichen(dok_id: str):
        return await im_mupdf_thread(dokumente.lesezeichen, dok_id)

    # -------------------------------------------------------------- Benutzer
    @app.get("/api/einstellungen")
    async def einstellungen():
        return benutzer.einstellungen()

    @app.put("/api/einstellungen")
    async def einstellungen_setzen(aenderungen: dict = Body(...)):
        return benutzer.einstellungen_setzen(aenderungen)

    @app.get("/api/zuletzt")
    async def zuletzt():
        return benutzer.zuletzt()

    @app.delete("/api/zuletzt")
    async def zuletzt_entfernen(pfad: str = Query(...)):
        benutzer.zuletzt_entfernen(pfad)
        return {"ok": True}

    @app.get("/api/favoriten")
    async def favoriten():
        return benutzer.favoriten()

    @app.put("/api/favoriten")
    async def favoriten_setzen(ordner: list[str] = Body(...)):
        return benutzer.favoriten_setzen(ordner)

    @app.get("/api/ordner")
    async def ordner_inhalt(pfad: str = Query(...)):
        """Listet Unterordner und öffenbare Dateien eines Ordners (für Favoriten)."""
        if not os.path.isdir(pfad):
            raise DokumentFehler("Ordner nicht gefunden.")
        ordner, dateien = [], []
        try:
            with os.scandir(pfad) as eintraege:
                for e in eintraege:
                    if e.name.startswith((".", "~$")):
                        continue
                    try:
                        if e.is_dir():
                            ordner.append({"name": e.name, "pfad": e.path})
                        elif Path(e.name).suffix.lower() in OEFFENBARE_ENDUNGEN:
                            st = e.stat()
                            dateien.append({"name": e.name, "pfad": e.path, "groesse": st.st_size, "geaendert": st.st_mtime})
                    except OSError:
                        continue
        except PermissionError:
            raise DokumentFehler("Kein Zugriff auf diesen Ordner.") from None
        ordner.sort(key=lambda o: o["name"].lower())
        dateien.sort(key=lambda d: -d["geaendert"])
        return {"pfad": os.path.abspath(pfad), "eltern": str(Path(pfad).resolve().parent), "ordner": ordner, "dateien": dateien}

    @app.get("/api/sitzung")
    async def sitzung():
        return benutzer.sitzung()

    @app.put("/api/sitzung")
    async def sitzung_setzen(sitzung: dict = Body(...)):
        benutzer.sitzung_setzen(sitzung)
        return {"ok": True}

    @app.post("/api/dialog/oeffnen")
    async def dialog_oeffnen():
        if app.state.datei_dialog is None:
            return {"verfuegbar": False, "pfade": []}
        pfade = await asyncio.get_running_loop().run_in_executor(None, app.state.datei_dialog)
        return {"verfuegbar": True, "pfade": pfade or []}

    # --------------------------------------------------------- Oberfläche
    if oberflaeche_ordner and (oberflaeche_ordner / "index.html").is_file():
        index = oberflaeche_ordner / "index.html"
        basis = oberflaeche_ordner.resolve()

        @app.get("/{rest:path}", include_in_schema=False)
        async def oberflaeche(rest: str):
            if rest.startswith("api/"):
                return JSONResponse({"fehler": "Unbekannter Endpunkt."}, status_code=404)
            ziel = (basis / rest).resolve()
            if rest and ziel.is_file() and basis in ziel.parents:
                return FileResponse(ziel)
            return FileResponse(index, headers={"Cache-Control": "no-cache"})

    return app
