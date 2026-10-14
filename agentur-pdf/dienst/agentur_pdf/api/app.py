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
from ..kern.bearbeitung import Bearbeitung, quelle_oeffnen
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
    speichern_dialog: Callable[[str], str | None] | None = None,
) -> FastAPI:
    app = FastAPI(title="Agentur-PDF", version=__version__, docs_url=None, redoc_url=None, openapi_url=None)
    dokumente = dokumente or DokumentSpeicher()
    benutzer = benutzer or BenutzerSpeicher()
    app.state.dokumente = dokumente
    app.state.benutzer = benutzer
    app.state.datei_dialog = datei_dialog
    app.state.speichern_dialog = speichern_dialog
    bearbeitung = Bearbeitung(dokumente)

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

    # ------------------------------------------------------ Seiten organisieren
    async def antwort(ids: list[str], neu: list[str] | None = None, **extra):
        def sammeln():
            return {
                "dokumente": [dokumente.info(i) for i in dict.fromkeys(ids)],
                "neu": [dokumente.info(i) for i in (neu or [])],
            }

        return {**(await im_mupdf_thread(sammeln)), **extra}

    @app.post("/api/dokumente/{dok_id}/seiten/drehen")
    async def seiten_drehen(dok_id: str, seiten: list[int] = Body(...), grad: int = Body(90)):
        await im_mupdf_thread(bearbeitung.drehen, dok_id, seiten, grad)
        return await antwort([dok_id])

    @app.post("/api/dokumente/{dok_id}/seiten/loeschen")
    async def seiten_loeschen(dok_id: str, seiten: list[int] = Body(..., embed=True)):
        await im_mupdf_thread(bearbeitung.loeschen, dok_id, seiten)
        return await antwort([dok_id])

    @app.post("/api/dokumente/{dok_id}/seiten/verschieben")
    async def seiten_verschieben(dok_id: str, seiten: list[int] = Body(...), ziel: int = Body(...)):
        positionen = await im_mupdf_thread(bearbeitung.verschieben, dok_id, seiten, ziel)
        return await antwort([dok_id], auswahl=positionen)

    @app.post("/api/dokumente/{dok_id}/seiten/duplizieren")
    async def seiten_duplizieren(dok_id: str, seiten: list[int] = Body(..., embed=True)):
        await im_mupdf_thread(bearbeitung.duplizieren, dok_id, seiten)
        return await antwort([dok_id])

    @app.post("/api/dokumente/{dok_id}/seiten/leer")
    async def seite_leer(dok_id: str, position: int = Body(..., embed=True)):
        await im_mupdf_thread(bearbeitung.leere_seite, dok_id, position)
        return await antwort([dok_id], auswahl=[position])

    @app.post("/api/dokumente/{dok_id}/seiten/einfuegen_pfad")
    async def seiten_einfuegen_pfad(dok_id: str, position: int = Body(...), pfade: list[str] = Body(...)):
        def einfuegen():
            pos = position
            for pfad in pfade:
                quelle = quelle_oeffnen(pfad=pfad)
                try:
                    pos += bearbeitung.datei_einfuegen(dok_id, pos, quelle, f"„{os.path.basename(pfad)}“ einfügen")
                finally:
                    quelle.close()
            return list(range(position, pos))

        auswahl = await im_mupdf_thread(einfuegen)
        return await antwort([dok_id], auswahl=auswahl)

    @app.post("/api/dokumente/{dok_id}/seiten/einfuegen_datei")
    async def seiten_einfuegen_datei(request: Request, dok_id: str, position: int = Query(...), name: str = Query(...)):
        daten = await request.body()

        def einfuegen():
            quelle = quelle_oeffnen(daten=daten, name=name)
            try:
                return bearbeitung.datei_einfuegen(dok_id, position, quelle, f"„{name}“ einfügen")
            finally:
                quelle.close()

        anzahl = await im_mupdf_thread(einfuegen)
        return await antwort([dok_id], auswahl=list(range(position, position + anzahl)))

    @app.post("/api/seiten/uebertragen")
    async def seiten_uebertragen(
        quelle: str = Body(...),
        seiten: list[int] = Body(...),
        ziel: str = Body(...),
        position: int = Body(...),
        verschieben: bool = Body(False),
    ):
        positionen = await im_mupdf_thread(bearbeitung.uebertragen, quelle, seiten, ziel, position, verschieben)
        return await antwort([ziel, quelle], auswahl=positionen)

    @app.post("/api/dokumente/{dok_id}/extrahieren")
    async def extrahieren(dok_id: str, seiten: list[int] = Body(...), loeschen: bool = Body(False)):
        neu = await im_mupdf_thread(bearbeitung.extrahieren, dok_id, seiten, loeschen)
        return await antwort([dok_id], [neu.id])

    @app.post("/api/dokumente/{dok_id}/teilen")
    async def teilen(dok_id: str, modus: str = Body(...), wert: float = Body(0)):
        ergebnis = await im_mupdf_thread(bearbeitung.teilen, dok_id, modus, wert)
        return await antwort([dok_id], ergebnis["neu"], dateien=ergebnis["dateien"], teile=ergebnis["teile"])

    @app.get("/api/dokumente/{dok_id}/leerseiten")
    async def leerseiten(dok_id: str):
        return await im_mupdf_thread(bearbeitung.leerseiten_finden, dok_id)

    @app.post("/api/dokumente/{dok_id}/rueckgaengig")
    async def rueckgaengig(dok_id: str):
        return await antwort(await im_mupdf_thread(bearbeitung.rueckgaengig, dok_id))

    @app.post("/api/dokumente/{dok_id}/wiederholen")
    async def wiederholen(dok_id: str):
        return await antwort(await im_mupdf_thread(bearbeitung.wiederholen, dok_id))

    @app.post("/api/dokumente/{dok_id}/speichern")
    async def speichern(dok_id: str, pfad: str | None = Body(None, embed=True)):
        gespeichert = await im_mupdf_thread(bearbeitung.speichern, dok_id, pfad)
        info = await im_mupdf_thread(dokumente.info, dok_id)
        benutzer.zuletzt_hinzufuegen(gespeichert, info["titel"], info["seitenanzahl"])
        return await antwort([dok_id], pfad=gespeichert)

    @app.get("/api/dokumente/{dok_id}/datei")
    async def datei(dok_id: str):
        daten = await im_mupdf_thread(bearbeitung.datei_bytes, dok_id)
        return Response(daten, media_type="application/pdf")

    @app.post("/api/dialog/speichern")
    async def dialog_speichern(vorschlag: str = Body("", embed=True)):
        if app.state.speichern_dialog is None:
            return {"verfuegbar": False, "pfad": None}
        pfad = await asyncio.get_running_loop().run_in_executor(None, app.state.speichern_dialog, vorschlag)
        return {"verfuegbar": True, "pfad": pfad}

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
