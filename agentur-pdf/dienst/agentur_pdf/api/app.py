"""HTTP-Schnittstelle zwischen Oberfläche und Dokument-Kern."""

from __future__ import annotations

import asyncio
import os
import threading
import time
from pathlib import Path
from typing import Callable

from fastapi import Body, FastAPI, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response

from .. import PRODUKT, STAND, __version__
from ..benutzer.speicher import BenutzerSpeicher
from ..kern.bearbeitung import Bearbeitung, quelle_oeffnen
from ..kern.auftraege import LEISE, Auftrag, AuftragsVerwaltung
from ..kern.dokumente import DokumentFehler, DokumentSpeicher
from ..kern.konvertierung import braucht_umwandlung, unterstuetzt
from ..kern.mupdf_thread import im_mupdf_thread, im_mupdf_thread_sync
from ..kern import ocr
from ..kern.ocr_auftrag import OcrOptionen, bereich_erkennen, dokument_erkennen, unsichere_woerter
from ..kern.sicherung import Sicherung
from ..kern.sperren import Sperren
from ..kern.ueberwachung import Ueberwachung
from ..kern.woerterbuch import woerterbuch
from ..kern.zusammenfuehren import Eintrag, Uploads, umwandeln, zusammenfuehren
from .sicherheit import chrome_erlaubt, pruefe_anfrage

OEFFENBARE_ENDUNGEN = {".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".gif", ".xps", ".epub"}


def erstelle_app(
    token: str,
    dokumente: DokumentSpeicher | None = None,
    benutzer: BenutzerSpeicher | None = None,
    oberflaeche_ordner: Path | None = None,
    datei_dialog: Callable[[], list[str]] | None = None,
    speichern_dialog: Callable[[str], str | None] | None = None,
    fenster_vorholen: Callable[[], None] | None = None,
    ordner_dialog: Callable[[str], str | None] | None = None,
) -> FastAPI:
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def lebensdauer(_app: FastAPI):
        # Hintergrund: Sicherung ungespeicherter Änderungen, Sperren auffrischen
        aufgabe = asyncio.create_task(_wartungsschleife(_app))
        _app.state.druckordner.starten()
        try:
            yield
        finally:
            aufgabe.cancel()
            _app.state.druckordner.stoppen()
            _app.state.aufraeumen()

    app = FastAPI(
        title=PRODUKT, version=__version__, docs_url=None, redoc_url=None, openapi_url=None, lifespan=lebensdauer
    )
    dokumente = dokumente or DokumentSpeicher()
    benutzer = benutzer or BenutzerSpeicher()
    if dokumente.sperren is None:
        dokumente.sperren = Sperren(benutzer.einstellungen().get("kuerzel", ""))
    sicherung = Sicherung(benutzer.ordner / "wiederherstellung")
    if benutzer.gemeinsamer_ordner() is not None:
        woerterbuch().gemeinsam_setzen(benutzer.gemeinsamer_ordner())
    app.state.sicherung = sicherung
    app.state.dokumente = dokumente
    app.state.benutzer = benutzer
    app.state.datei_dialog = datei_dialog
    app.state.speichern_dialog = speichern_dialog
    app.state.ordner_dialog = ordner_dialog
    bearbeitung = Bearbeitung(dokumente)
    auftraege = AuftragsVerwaltung()
    uploads = Uploads()
    ereignisse = Ereignisse()
    app.state.auftraege = auftraege
    app.state.ereignisse = ereignisse
    app.state.fenster_vorholen = fenster_vorholen
    # Fertige Aufträge melden sich bei der Oberfläche (die sie dann öffnet)
    # (außer bei Aufträgen aus einem Chrome-Tab – der verfolgt sie selbst)
    auftraege.bei_ende = lambda a: None if a.leise else ereignisse.hinzufuegen({"art": "auftrag", "auftrag": a.als_dict()})

    @app.middleware("http")
    async def sicherheit(request: Request, call_next):
        abgelehnt = pruefe_anfrage(request, token)
        if abgelehnt is not None:
            return abgelehnt
        marke = LEISE.set(request.headers.get("x-agentur-client") == "chrome")
        try:
            return await call_next(request)
        finally:
            LEISE.reset(marke)

    @app.exception_handler(DokumentFehler)
    async def dokument_fehler(_request: Request, fehler: DokumentFehler):
        return JSONResponse({"fehler": str(fehler)}, status_code=409 if str(fehler) == "VERALTET" else 400)

    # ------------------------------------------------------------- Allgemein
    @app.get("/api/status")
    async def status():
        return {
            "version": __version__,
            "produkt": PRODUKT,
            "stand": STAND,
            "desktop": app.state.datei_dialog is not None,
            "cache_bytes": dokumente.cache.groesse,
        }

    # ------------------------------------------------------------ Dokumente
    @app.get("/api/dokumente")
    async def dokumente_liste():
        return await im_mupdf_thread(lambda: [dokumente.info(d.id) for d in dokumente.alle()])

    @app.post("/api/dokumente/oeffnen")
    async def oeffnen(pfad: str = Body(..., embed=True), passwort: str | None = Body(None, embed=True)):
        if braucht_umwandlung(pfad):
            raise DokumentFehler("Diese Datei muss erst umgewandelt werden (Konvertieren → In PDF umwandeln).")
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
        sicherung.entfernen(dok_id)
        return {"ok": True}

    # ------------------------------------- Sicherung, Sperren (Wartung)
    async def wartung() -> None:
        """Einmal „Hausmeister“: geänderte Dokumente sichern, eigene Sperren
        auffrischen, frei gewordene Dateien übernehmen."""
        await im_mupdf_thread(lambda: [sicherung.sichern(d) for d in dokumente.alle()])
        # Chrome-Tabs schließen ohne Rückmeldung: unveränderte, länger ruhende Dokumente freigeben
        jetzt = time.time()
        for d in dokumente.alle():
            if d.chrome and not d.geaendert and jetzt - d.benutzt > CHROME_RUHE_S:
                await im_mupdf_thread(dokumente.schliessen, d.id)
        sperren = dokumente.sperren
        if sperren is None:
            return
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, sperren.auffrischen)
        for d in dokumente.alle():
            if d.gesperrt_von and d.pfad:
                andere = await loop.run_in_executor(None, sperren.holen, d.pfad)
                if andere is None:
                    d.gesperrt_von = None
                    ereignisse.hinzufuegen({"art": "sperre_frei", "dokId": d.id, "titel": d.titel})
                else:
                    d.gesperrt_von = andere

    def aufraeumen() -> None:
        """Beim Beenden: letzte Sicherung schreiben, Sperren freigeben."""
        try:
            im_mupdf_thread_sync(lambda: [sicherung.sichern(d) for d in dokumente.alle()])
        except Exception:  # noqa: BLE001 – Beenden darf nicht scheitern
            pass
        if dokumente.sperren is not None:
            dokumente.sperren.alle_freigeben()

    app.state.wartung = wartung
    app.state.aufraeumen = aufraeumen

    # --------------------------------------------- PDF-Drucker „Agentur-PDF“
    from ..kern.druckordner import Druckordner, standard_ordner

    def druck_ordner() -> Path:
        eigener = str(benutzer.einstellungen().get("druck_ordner") or "").strip()
        return Path(eigener) if eigener else standard_ordner()

    def ausdruck_oeffnen(daten: bytes, titel: str) -> None:
        def oeffnen():
            dok = dokumente.oeffnen_bytes(daten, titel)
            dok.geaendert = True
            return dok.id

        dok_id = im_mupdf_thread_sync(oeffnen)
        ereignisse.hinzufuegen({"art": "oeffnen", "dokumente": [dok_id]})
        if app.state.fenster_vorholen:
            app.state.fenster_vorholen()

    app.state.druckordner = Druckordner(druck_ordner, ausdruck_oeffnen)

    @app.get("/api/system/drucker")
    async def drucker_status():
        from ..windows import drucker

        return {
            "windows": os.name == "nt",
            "eingerichtet": await asyncio.get_running_loop().run_in_executor(None, drucker.eingerichtet),
            "ordner": str(druck_ordner()),
            "name": drucker.DRUCKER,
        }

    @app.post("/api/system/drucker")
    async def drucker_einrichten(einrichten: bool = Body(True, embed=True)):
        from ..windows import drucker

        if os.name != "nt":
            raise DokumentFehler("Den PDF-Drucker gibt es nur unter Windows.")
        funktion = drucker.einrichten if einrichten else drucker.entfernen
        ok = await asyncio.get_running_loop().run_in_executor(None, funktion, druck_ordner())
        if not ok:
            raise DokumentFehler("Der Drucker konnte nicht eingerichtet werden (Administratorrechte abgelehnt?).")
        return await drucker_status()

    @app.get("/api/wiederherstellung")
    async def wiederherstellung_liste():
        return await asyncio.get_running_loop().run_in_executor(None, sicherung.liste)

    @app.post("/api/wiederherstellung/{schluessel}")
    async def wiederherstellen(schluessel: str):
        try:
            daten, meta = sicherung.lesen(schluessel)
        except (OSError, ValueError):
            raise DokumentFehler("Diese Sicherung gibt es nicht mehr.") from None

        def oeffnen():
            dok = dokumente.oeffnen_bytes(daten, meta.get("titel") or "Wiederhergestellt.pdf")
            pfad = meta.get("pfad")
            if pfad:
                dok.pfad = pfad
                dok.datei_stand = None  # bewusst überschreiben dürfen
                if dokumente.sperren is not None and os.path.exists(pfad):
                    dok.gesperrt_von = dokumente.sperren.holen(pfad)
            dok.ordner_vorschlag = meta.get("ordner")
            dok.geaendert = True
            dok.version += 1
            return dok

        dok = await im_mupdf_thread(oeffnen)
        sicherung.verwerfen(schluessel)
        return await im_mupdf_thread(dokumente.info, dok.id)

    @app.delete("/api/wiederherstellung/{schluessel}")
    async def wiederherstellung_verwerfen(schluessel: str):
        try:
            sicherung.verwerfen(schluessel)
        except ValueError:
            raise DokumentFehler("Ungültige Sicherung.") from None
        return {"ok": True}

    @app.post("/api/dokumente/{dok_id}/sperre_pruefen")
    async def sperre_pruefen(dok_id: str):
        await wartung()
        return await im_mupdf_thread(dokumente.info, dok_id)

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
        v: str | None = None,
        a: str | None = None,
        o: str | None = None,
    ):
        kachel = (x, y, b, h) if None not in (x, y, b, h) else None
        # a = ausgeblendete Anmerkungsgruppen, z. B. "kommentar,stempel"
        ausblenden = frozenset(g for g in (a or "").split(",") if g)
        # o = einzelne Anmerkungen ausblenden (werden gerade bearbeitet)
        ohne = frozenset(int(x) for x in (o or "").split(",") if x.isdigit())
        auftrag = asyncio.ensure_future(
            im_mupdf_thread(dokumente.render, dok_id, seite, skala, drehung, kachel, v, ausblenden, ohne)
        )
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
    async def speichern(dok_id: str, pfad: str | None = Body(None), erzwingen: bool = Body(False)):
        gespeichert = await im_mupdf_thread(bearbeitung.speichern, dok_id, pfad, erzwingen)
        sicherung.entfernen(dok_id)
        info = await im_mupdf_thread(dokumente.info, dok_id)
        benutzer.zuletzt_hinzufuegen(gespeichert, info["titel"], info["seitenanzahl"])
        return await antwort([dok_id], pfad=gespeichert)

    @app.post("/api/dokumente/{dok_id}/heruntergeladen")
    async def heruntergeladen(dok_id: str):
        """Im Browser/Chrome-Tab als Download gespeichert → gilt als gesichert."""

        def markieren():
            dokumente.get(dok_id).geaendert = False

        await im_mupdf_thread(markieren)
        sicherung.entfernen(dok_id)
        return await antwort([dok_id])

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

    # --------------------------------------------------- Texterkennung (OCR)
    @app.get("/api/ocr/status")
    async def ocr_status():
        return {
            "verfuegbar": ocr.tesseract_finden() is not None,
            "sprachen": ocr.sprachen_verfuegbar(),
            "beste_modelle": ocr.tessdata_finden() is not None,
            "woerterbuch": woerterbuch().verfuegbar,
        }

    @app.post("/api/dokumente/{dok_id}/ocr")
    async def ocr_starten(
        dok_id: str,
        seiten: list[int] | None = Body(None),
        sprachen: str | None = Body(None),
        erzwingen: bool = Body(False),
        ausrichten: bool = Body(True),
        entzerren: bool = Body(True),
    ):
        await im_mupdf_thread(dokumente.get, dok_id)  # existiert?
        optionen = OcrOptionen(sprachen or benutzer.einstellungen()["ocr_sprachen"], erzwingen, ausrichten, entzerren)
        titel = await im_mupdf_thread(lambda: f"Texterkennung „{dokumente.get(dok_id).titel}“")
        a = auftraege.starten(
            titel, lambda auf: dokument_erkennen(dok_id, seiten, optionen, dokumente, bearbeitung, auf, im_mupdf_thread_sync)
        )
        return a.als_dict()

    @app.post("/api/dokumente/{dok_id}/ocr/bereich")
    async def ocr_bereich(dok_id: str, seite: int = Body(...), rechteck: list[float] = Body(...), sprachen: str | None = Body(None)):
        sprachen = sprachen or benutzer.einstellungen()["ocr_sprachen"]
        vorbereitet = await im_mupdf_thread(bereich_erkennen, dokumente, dok_id, seite, rechteck, sprachen)
        ergebnis = await asyncio.get_running_loop().run_in_executor(None, lambda: ocr.erkennen(vorbereitet, sprachen, False, True))
        return {"text": ergebnis.text, "sicherheit": round(ergebnis.sicherheit, 1)}

    @app.get("/api/dokumente/{dok_id}/ocr/unsicher")
    async def ocr_unsicher(dok_id: str):
        return await im_mupdf_thread(unsichere_woerter, dokumente, dok_id)

    @app.get("/api/dokumente/{dok_id}/textstatus")
    async def textstatus(dok_id: str):
        """Wie viele Seiten haben keinen Text (→ Hinweis „Texterkennung starten“)?"""

        def zaehlen():
            doc = dokumente.get(dok_id).doc
            ohne = [s.number for s in doc if not ocr.hat_text(s)]
            return {"seiten": doc.page_count, "ohne_text": len(ohne), "erste_ohne_text": ohne[:1]}

        return await im_mupdf_thread(zaehlen)

    # ---------------------------------------------------- Überwachungsordner
    ueberwachung = Ueberwachung(lambda: benutzer.einstellungen()["ueberwachung"], im_mupdf_thread_sync, ereignisse.hinzufuegen)
    app.state.ueberwachung = ueberwachung
    if benutzer.einstellungen()["ueberwachung"]:
        ueberwachung.starten()

    @app.get("/api/ueberwachung")
    async def ueberwachung_holen():
        return {"regeln": benutzer.einstellungen()["ueberwachung"], "protokoll": ueberwachung.protokoll}

    @app.put("/api/ueberwachung")
    async def ueberwachung_setzen(regeln: list[dict] = Body(...)):
        bereinigt = []
        for r in regeln:
            ordner = (r.get("ordner") or "").strip().strip('"')
            if not ordner:
                continue
            if not os.path.isdir(ordner):
                raise DokumentFehler(f"Ordner nicht gefunden: {ordner}")
            ziel = (r.get("ziel") or "").strip().strip('"')
            if ziel and not os.path.isdir(ziel):
                raise DokumentFehler(f"Zielordner nicht gefunden: {ziel}")
            bereinigt.append(
                {
                    "ordner": os.path.abspath(ordner),
                    "ziel": os.path.abspath(ziel) if ziel else "",
                    "original_sichern": bool(r.get("original_sichern", True)),
                    "leerseiten_entfernen": bool(r.get("leerseiten_entfernen", True)),
                    "aktiv": bool(r.get("aktiv", True)),
                }
            )
        benutzer.einstellungen_setzen({"ueberwachung": bereinigt})
        if bereinigt:
            ueberwachung.starten()
        return {"regeln": bereinigt, "protokoll": ueberwachung.protokoll}

    # ------------------------------------------- Zusammenführen & Umwandeln
    def eintraege_aufloesen(roh: list[dict]) -> list[Eintrag]:
        ergebnis = []
        for e in roh:
            if e.get("upload"):
                ergebnis.append(uploads.get(e["upload"]))
            elif e.get("pfad"):
                pfad = os.path.abspath(e["pfad"])
                if not os.path.isfile(pfad):
                    raise DokumentFehler(f"Datei nicht gefunden: {pfad}")
                ergebnis.append(Eintrag(os.path.basename(pfad), pfad))
        for e in ergebnis:
            if not unterstuetzt(e.name):
                raise DokumentFehler(f"„{e.name}“: Dateityp wird nicht unterstützt.")
        return ergebnis

    @app.post("/api/uploads")
    async def hochladen_temp(request: Request, name: str = Query(...)):
        daten = await request.body()
        if not daten:
            raise DokumentFehler("Leere Datei.")
        return {"id": uploads.speichern(name, daten), "name": os.path.basename(name)}

    def zusammenfuehren_starten(eintraege: list[Eintrag], lesezeichen: bool, anhaenge: bool, still: bool = False) -> Auftrag:
        """``still``: Ergebnis nicht im Programmfenster öffnen (Chrome-Seitenleiste)."""
        titel = f"{len(eintraege)} Dateien zusammenführen" if len(eintraege) > 1 else f"„{eintraege[0].name}“ umwandeln"

        def arbeit(a: Auftrag) -> dict:
            ergebnis = zusammenfuehren(eintraege, dokumente, a, im_mupdf_thread_sync, lesezeichen, anhaenge)
            return {**ergebnis, "oeffnen": False} if still else ergebnis

        return auftraege.starten(titel, arbeit)

    def umwandeln_starten(eintraege: list[Eintrag], speichern: bool) -> Auftrag:
        titel = f"{len(eintraege)} Dateien in PDF umwandeln" if len(eintraege) > 1 else f"„{eintraege[0].name}“ in PDF umwandeln"
        return auftraege.starten(titel, lambda a: umwandeln(eintraege, dokumente, a, im_mupdf_thread_sync, speichern))

    @app.post("/api/zusammenfuehren")
    async def zusammenfuehren_api(
        eintraege: list[dict] = Body(...), lesezeichen: bool = Body(True), anhaenge: bool = Body(True), still: bool = Body(False)
    ):
        return zusammenfuehren_starten(eintraege_aufloesen(eintraege), lesezeichen, anhaenge, still).als_dict()

    @app.get("/api/auftraege/{auftrag_id}")
    async def auftrag_status(auftrag_id: str):
        return auftraege.get(auftrag_id).als_dict()

    # ------------------------------------------------ Chrome-Seitenleiste
    @app.post("/chrome/verbinden", include_in_schema=False)
    async def chrome_verbinden(request: Request):
        """Kopplung: die Erweiterung holt sich das Token (nur ihr Origin)."""
        if not chrome_erlaubt(request.headers.get("origin") or "", benutzer.einstellungen().get("chrome_erweiterungen") or []):
            return JSONResponse({"fehler": "Nicht erlaubt."}, status_code=403)
        return {"token": token, "version": __version__}

    @app.post("/api/chrome/oeffnen")
    async def chrome_oeffnen(request: Request, name: str = Query(...)):
        """Datei aus Chrome (Download, Link, Bild) im Programmfenster öffnen."""
        daten = await request.body()
        if not daten:
            raise DokumentFehler("Leere Datei.")
        if not unterstuetzt(name):
            raise DokumentFehler(f"„{os.path.basename(name)}“: Dateityp wird nicht unterstützt.")
        if braucht_umwandlung(name):
            uid = uploads.speichern(name, daten)
            umwandeln_starten([uploads.get(uid)], speichern=False)
        else:
            dok = await im_mupdf_thread(dokumente.oeffnen_bytes, daten, os.path.basename(name))
            ereignisse.hinzufuegen({"art": "oeffnen", "dokumente": [dok.id]})
        if app.state.fenster_vorholen:
            app.state.fenster_vorholen()
        return {"ok": True}

    @app.post("/api/chrome/tab")
    async def chrome_tab(request: Request, name: str = Query(...)):
        """PDF (oder Bild, Mail, Office) aus Chrome für den Editor im Chrome-Tab öffnen."""
        daten = await request.body()
        if not daten:
            raise DokumentFehler("Leere Datei.")
        name = os.path.basename(name) or "Dokument.pdf"
        if not unterstuetzt(name):
            raise DokumentFehler(f"„{name}“: Dateityp wird nicht unterstützt.")
        if name.lower().endswith(".pdf"):
            dok = await im_mupdf_thread(dokumente.oeffnen_bytes, daten, name)
        else:
            uid = uploads.speichern(name, daten)
            ergebnis = await asyncio.get_running_loop().run_in_executor(
                None, lambda: zusammenfuehren([uploads.get(uid)], dokumente, Auftrag("chrome", name), im_mupdf_thread_sync, False, True)
            )
            dok = dokumente.get(ergebnis["dokumente"][0])
        dok.chrome = True
        return await im_mupdf_thread(dokumente.info, dok.id)

    @app.post("/api/chrome/zeigen")
    async def chrome_zeigen(dok_id: str = Body(..., embed=True)):
        """Ein in der Seitenleiste erstelltes Dokument im Programmfenster zeigen."""
        await im_mupdf_thread(dokumente.info, dok_id)  # prüft, ob es existiert
        ereignisse.hinzufuegen({"art": "oeffnen", "dokumente": [dok_id]})
        if app.state.fenster_vorholen:
            app.state.fenster_vorholen()
        return {"ok": True}

    @app.post("/api/umwandeln")
    async def umwandeln_api(eintraege: list[dict] = Body(...), speichern: bool = Body(False)):
        return umwandeln_starten(eintraege_aufloesen(eintraege), speichern).als_dict()

    @app.get("/api/auftraege")
    async def auftraege_liste():
        return auftraege.liste()

    @app.delete("/api/auftraege/{auftrag_id}")
    async def auftrag_abbrechen(auftrag_id: str):
        auftraege.get(auftrag_id).abbrechen()
        return {"ok": True}

    @app.get("/api/ereignisse")
    async def ereignisse_abholen():
        """Wird von der Oberfläche regelmäßig abgefragt: Aufträge + Ereignisse
        (z. B. Dateien, die per Explorer-Rechtsklick übergeben wurden)."""
        return {"ereignisse": ereignisse.abholen(), "auftraege": auftraege.liste()}

    # --------------------------------------------- Übergabe von außen
    sammler: dict = {"dateien": [], "timer": None, "lock": threading.Lock()}

    def zusammenfuehren_sammeln(dateien: list[str]) -> None:
        """Der Explorer startet bei Mehrfachauswahl ein Programm *je Datei*.
        Alle Dateien, die kurz nacheinander eintreffen, landen in einem Dialog."""

        def ausloesen() -> None:
            with sammler["lock"]:
                liste, sammler["dateien"], sammler["timer"] = sammler["dateien"], [], None
            ereignisse.hinzufuegen({"art": "zusammenfuehren", "dateien": sorted(dict.fromkeys(liste), key=str.lower)})

        with sammler["lock"]:
            sammler["dateien"].extend(dateien)
            if sammler["timer"]:
                sammler["timer"].cancel()
            sammler["timer"] = threading.Timer(0.8, ausloesen)
            sammler["timer"].daemon = True
            sammler["timer"].start()

    async def extern_ausfuehren(aktion: str, dateien: list[str]) -> None:
        dateien = [os.path.abspath(d) for d in dateien]
        if aktion == "zusammenfuehren":
            from ..kern.stapel import dateien_sammeln

            # Ordner (Rechtsklick auf Ordner) → unterstützte Dateien darin, alphabetisch
            zusammenfuehren_sammeln([str(p) for p in dateien_sammeln(dateien)] if any(os.path.isdir(d) for d in dateien) else dateien)
        elif aktion == "umwandeln":
            umwandeln_starten(eintraege_aufloesen([{"pfad": d} for d in dateien]), speichern=True)
        else:  # öffnen
            direkt = [d for d in dateien if not braucht_umwandlung(d)]
            umzuwandeln = [d for d in dateien if braucht_umwandlung(d)]
            geoeffnet = []
            for d in direkt:
                try:
                    dok = await im_mupdf_thread(dokumente.oeffnen_pfad, d)
                    geoeffnet.append(dok.id)
                    benutzer.zuletzt_hinzufuegen(dok.pfad or d, dok.titel, dok.doc.page_count)
                except DokumentFehler as fehler:
                    ereignisse.hinzufuegen({"art": "meldung", "text": f"{os.path.basename(d)}: {fehler}"})
            if geoeffnet:
                ereignisse.hinzufuegen({"art": "oeffnen", "dokumente": geoeffnet})
            if umzuwandeln:
                umwandeln_starten(eintraege_aufloesen([{"pfad": d} for d in umzuwandeln]), speichern=False)
        if app.state.fenster_vorholen:
            app.state.fenster_vorholen()

    app.state.extern_ausfuehren = extern_ausfuehren

    # ------------------------------------------------- Stapelverarbeitung
    @app.post("/api/stapel/vorschau")
    async def stapel_vorschau(pfade: list[str] = Body(...), unterordner: bool = Body(False)):
        from ..kern.stapel import dateien_sammeln

        dateien = await asyncio.get_running_loop().run_in_executor(None, dateien_sammeln, pfade, unterordner)
        liste = []
        for d in dateien[:500]:
            try:
                liste.append({"pfad": str(d), "name": d.name, "ordner": str(d.parent), "groesse": d.stat().st_size})
            except OSError:
                continue
        return {"anzahl": len(dateien), "dateien": liste}

    @app.post("/api/stapel")
    async def stapel_starten(pfade: list[str] = Body(...), unterordner: bool = Body(False), optionen: dict = Body(...)):
        from ..kern.stapel import StapelOptionen, dateien_sammeln, stapel_ausfuehren

        o = StapelOptionen.aus_dict(optionen)
        dateien = await asyncio.get_running_loop().run_in_executor(None, dateien_sammeln, pfade, unterordner)
        if not dateien:
            raise DokumentFehler("Keine passenden Dateien gefunden.")
        titel = f"Stapelverarbeitung ({len(dateien)} Datei{'en' if len(dateien) != 1 else ''})"
        auftrag = auftraege.starten(titel, lambda a: stapel_ausfuehren(dateien, o, im_mupdf_thread_sync, a, dokumente.sperren))
        return auftrag.als_dict()

    @app.post("/api/extern")
    async def extern(aktion: str = Body("oeffnen"), dateien: list[str] = Body(...)):
        """Übergabe von einer zweiten Programminstanz (Explorer-Rechtsklick,
        Doppelklick auf PDF, während Agentur-PDF schon läuft)."""
        await extern_ausfuehren(aktion, dateien)
        return {"ok": True}

    # ---------------------------------------------------------------- System
    @app.get("/api/system")
    async def system():
        from ..benutzer.speicher import datenordner
        from ..kern.konvertierung import libreoffice_finden

        return {
            "version": __version__,
            "windows": os.name == "nt",
            "datenordner": str(datenordner()),
            "tesseract": ocr.tesseract_finden(),
            "beste_modelle": ocr.tessdata_finden() is not None,
            "libreoffice": libreoffice_finden(),
            "woerterbuch": woerterbuch().verfuegbar,
            "screenshot_bereit": _screenshot_bereit(),
        }

    @app.post("/api/system/explorer")
    async def explorer_menue(einrichten: bool = Body(True, embed=True)):
        """Rechtsklick-Einträge im Explorer anlegen/entfernen (nur Windows, pro Benutzer)."""
        if os.name != "nt":
            raise DokumentFehler("Die Explorer-Einträge gibt es nur unter Windows.")
        from ..windows import explorer

        if einrichten:
            return {"ok": True, "anzahl": explorer.einrichten()}
        explorer.entfernen()
        return {"ok": True, "anzahl": 0}

    @app.get("/api/system/chrome")
    async def chrome_status():
        from ..windows import chrome

        return chrome.status()

    @app.post("/api/system/chrome")
    async def chrome_einrichten():
        """Chrome-Seitenleiste: Ordner zeigen, Pfad kopieren, Erweiterungsseite öffnen."""
        from ..windows import chrome

        try:
            return chrome.einrichten()
        except FileNotFoundError as fehler:
            raise DokumentFehler(str(fehler)) from None

    # -------------------------------------------------------------- Benutzer
    @app.get("/api/einstellungen")
    async def einstellungen():
        return benutzer.einstellungen()

    @app.put("/api/einstellungen")
    async def einstellungen_setzen(aenderungen: dict = Body(...)):
        if "screenshot_taste" in aenderungen:
            from ..windows.screenshot import TastenFehler, taste_parsen

            try:
                taste_parsen(str(aenderungen["screenshot_taste"]))
            except TastenFehler as fehler:
                raise DokumentFehler(str(fehler)) from None
        try:
            ergebnis = benutzer.einstellungen_setzen(aenderungen)
        except OSError as fehler:
            raise DokumentFehler(f"Gemeinsamer Ordner nicht erreichbar: {fehler}") from None
        if "gemeinsamer_ordner" in aenderungen:
            woerterbuch().gemeinsam_setzen(benutzer.gemeinsamer_ordner())
        if "kuerzel" in aenderungen and dokumente.sperren is not None:
            dokumente.sperren.ich["kuerzel"] = ergebnis.get("kuerzel", "")
        if any(k.startswith("screenshot_") for k in aenderungen) and getattr(app.state, "screenshot", None):
            await asyncio.get_running_loop().run_in_executor(None, app.state.screenshot.neu_starten)
        return ergebnis

    # ------------------------------------------- Updates, Windows-Einbindung
    @app.get("/api/update")
    async def update_pruefen():
        from ..kern import update

        ordner = update.update_ordner(benutzer.gemeinsamer_ordner())
        ergebnis = await asyncio.get_running_loop().run_in_executor(None, update.suchen, ordner, __version__)
        import sys as _sys

        return {**ergebnis, "aktuelle_version": __version__, "installierbar": os.name == "nt" and bool(getattr(_sys, "frozen", False))}

    @app.post("/api/update/installieren")
    async def update_installieren():
        import sys as _sys

        from ..kern import update

        if not (os.name == "nt" and getattr(_sys, "frozen", False)):
            raise DokumentFehler("Updates lassen sich nur im installierten Windows-Programm einspielen.")
        ordner = update.update_ordner(benutzer.gemeinsamer_ordner())
        gefunden = await asyncio.get_running_loop().run_in_executor(None, update.suchen, ordner, __version__)
        if not gefunden.get("verfuegbar"):
            raise DokumentFehler("Keine neuere Version gefunden.")
        try:
            await asyncio.get_running_loop().run_in_executor(None, update.installieren, gefunden["pfad"])
        except OSError as fehler:
            raise DokumentFehler(f"Update konnte nicht gestartet werden: {fehler}") from None
        beenden = getattr(app.state, "programm_beenden", None)
        if beenden:
            # kurz warten, damit die Antwort noch ankommt; das Setup wartet auf uns
            threading.Timer(1.5, beenden).start()
        return {"ok": True, "version": gefunden["version"]}

    @app.get("/api/system/windows")
    async def windows_status():
        from ..windows import standard

        return standard.status()

    @app.post("/api/system/standardprogramm")
    async def standardprogramm():
        from ..windows import explorer, standard

        if os.name != "nt":
            raise DokumentFehler("Nur unter Windows.")
        if not standard.status()["registriert"]:
            await asyncio.get_running_loop().run_in_executor(None, explorer.einrichten)
        standard.einstellungen_oeffnen()
        return {"ok": True}

    @app.get("/api/gemeinsam")
    async def gemeinsam_status():
        return await asyncio.get_running_loop().run_in_executor(None, benutzer.gemeinsam_status)

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

    @app.post("/api/dialog/ordner")
    async def dialog_ordner(start: str = Body("", embed=True)):
        if app.state.ordner_dialog is None:
            return {"verfuegbar": False, "pfad": None}
        pfad = await asyncio.get_running_loop().run_in_executor(None, app.state.ordner_dialog, start)
        return {"verfuegbar": True, "pfad": pfad}

    @app.post("/api/dialog/oeffnen")
    async def dialog_oeffnen():
        if app.state.datei_dialog is None:
            return {"verfuegbar": False, "pfade": []}
        pfade = await asyncio.get_running_loop().run_in_executor(None, app.state.datei_dialog)
        return {"verfuegbar": True, "pfade": pfade or []}

    # ------------------------- Kommentieren, Bearbeiten, Schützen, Ausgabe
    from . import erweiterungen

    erweiterungen.einrichten(app, dokumente, bearbeitung, benutzer, antwort)

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


WARTUNG_S = 60
CHROME_RUHE_S = 30 * 60


async def _wartungsschleife(app: FastAPI) -> None:
    import logging

    while True:
        await asyncio.sleep(WARTUNG_S)
        try:
            await app.state.wartung()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 – nie die Schleife verlieren
            logging.getLogger(__name__).exception("Wartung fehlgeschlagen")


def _screenshot_bereit() -> bool:
    """Sind die Bausteine für die Bereichsauswahl da (Tk mit Tcl-Bibliothek)?"""
    try:
        import tkinter

        from PIL import ImageGrab, ImageTk  # noqa: F401

        tkinter.Tcl().eval("info patchlevel")
        return True
    except Exception:  # noqa: BLE001
        return False


class Ereignisse:
    """Warteschlange für Ereignisse an die Oberfläche (werden einmal abgeholt)."""

    def __init__(self) -> None:
        import threading

        self._liste: list[dict] = []
        self._lock = threading.Lock()

    def hinzufuegen(self, ereignis: dict) -> None:
        with self._lock:
            self._liste.append(ereignis)

    def abholen(self) -> list[dict]:
        with self._lock:
            liste, self._liste = self._liste, []
            return liste
