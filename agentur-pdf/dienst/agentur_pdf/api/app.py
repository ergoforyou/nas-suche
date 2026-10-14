"""HTTP-Schnittstelle zwischen Oberfläche und Dokument-Kern."""

from __future__ import annotations

import asyncio
import os
import threading
from pathlib import Path
from typing import Callable

from fastapi import Body, FastAPI, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response

from .. import __version__
from ..benutzer.speicher import BenutzerSpeicher
from ..kern.bearbeitung import Bearbeitung, quelle_oeffnen
from ..kern.auftraege import Auftrag, AuftragsVerwaltung
from ..kern.dokumente import DokumentFehler, DokumentSpeicher
from ..kern.konvertierung import braucht_umwandlung, unterstuetzt
from ..kern.mupdf_thread import im_mupdf_thread, im_mupdf_thread_sync
from ..kern import ocr
from ..kern.ocr_auftrag import OcrOptionen, bereich_erkennen, dokument_erkennen, unsichere_woerter
from ..kern.ueberwachung import Ueberwachung
from ..kern.woerterbuch import woerterbuch
from ..kern.zusammenfuehren import Eintrag, Uploads, umwandeln, zusammenfuehren
from .sicherheit import pruefe_anfrage

OEFFENBARE_ENDUNGEN = {".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".gif", ".xps", ".epub"}


def erstelle_app(
    token: str,
    dokumente: DokumentSpeicher | None = None,
    benutzer: BenutzerSpeicher | None = None,
    oberflaeche_ordner: Path | None = None,
    datei_dialog: Callable[[], list[str]] | None = None,
    speichern_dialog: Callable[[str], str | None] | None = None,
    fenster_vorholen: Callable[[], None] | None = None,
) -> FastAPI:
    app = FastAPI(title="Agentur-PDF", version=__version__, docs_url=None, redoc_url=None, openapi_url=None)
    dokumente = dokumente or DokumentSpeicher()
    benutzer = benutzer or BenutzerSpeicher()
    app.state.dokumente = dokumente
    app.state.benutzer = benutzer
    app.state.datei_dialog = datei_dialog
    app.state.speichern_dialog = speichern_dialog
    bearbeitung = Bearbeitung(dokumente)
    auftraege = AuftragsVerwaltung()
    uploads = Uploads()
    ereignisse = Ereignisse()
    app.state.auftraege = auftraege
    app.state.ereignisse = ereignisse
    app.state.fenster_vorholen = fenster_vorholen
    # Fertige Aufträge melden sich bei der Oberfläche (die sie dann öffnet)
    auftraege.bei_ende = lambda a: ereignisse.hinzufuegen({"art": "auftrag", "auftrag": a.als_dict()})

    @app.middleware("http")
    async def sicherheit(request: Request, call_next):
        abgelehnt = pruefe_anfrage(request, token)
        if abgelehnt is not None:
            return abgelehnt
        return await call_next(request)

    @app.exception_handler(DokumentFehler)
    async def dokument_fehler(_request: Request, fehler: DokumentFehler):
        return JSONResponse({"fehler": str(fehler)}, status_code=409 if str(fehler) == "VERALTET" else 400)

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

    def zusammenfuehren_starten(eintraege: list[Eintrag], lesezeichen: bool, anhaenge: bool) -> Auftrag:
        titel = f"{len(eintraege)} Dateien zusammenführen" if len(eintraege) > 1 else f"„{eintraege[0].name}“ umwandeln"
        return auftraege.starten(
            titel,
            lambda a: zusammenfuehren(eintraege, dokumente, a, im_mupdf_thread_sync, lesezeichen, anhaenge),
        )

    def umwandeln_starten(eintraege: list[Eintrag], speichern: bool) -> Auftrag:
        titel = f"{len(eintraege)} Dateien in PDF umwandeln" if len(eintraege) > 1 else f"„{eintraege[0].name}“ in PDF umwandeln"
        return auftraege.starten(titel, lambda a: umwandeln(eintraege, dokumente, a, im_mupdf_thread_sync, speichern))

    @app.post("/api/zusammenfuehren")
    async def zusammenfuehren_api(
        eintraege: list[dict] = Body(...), lesezeichen: bool = Body(True), anhaenge: bool = Body(True)
    ):
        return zusammenfuehren_starten(eintraege_aufloesen(eintraege), lesezeichen, anhaenge).als_dict()

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
            zusammenfuehren_sammeln(dateien)
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
