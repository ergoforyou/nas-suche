"""Endpunkte für Kommentieren, Bearbeiten, Schützen und Ausgabe.

Getrennt von ``app.py``, damit die Grundfunktionen übersichtlich bleiben.
Alle Änderungen am Dokument laufen über ``Bearbeitung.aendern`` – damit sind
sie mit Strg+Z rückgängig zu machen.
"""

from __future__ import annotations

import asyncio
import os
import re
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable

import pymupdf
from fastapi import Body, FastAPI, Query, Request
from fastapi.responses import Response

from ..benutzer.speicher import BenutzerSpeicher
from ..kern import anmerkungen, ausgabe, bilder, formulare, foto
from ..kern.bearbeitung import Bearbeitung, _atomar_schreiben
from ..kern.dokumente import DokumentFehler, DokumentSpeicher
from ..kern.mupdf_thread import im_mupdf_thread
from ..kern.woerterbuch import woerterbuch

WORT = re.compile(r"[A-Za-zÄÖÜäöüß]+(?:-[A-Za-zÄÖÜäöüß]+)*")


def rechtschreibung_pruefen(text: str, mit_vorschlaegen: bool = False) -> list[dict]:
    """Findet unbekannte Wörter im Text (Position; Vorschläge auf Wunsch –
    sonst holt die Oberfläche sie erst beim Rechtsklick)."""
    wb = woerterbuch()
    if not wb.verfuegbar:
        return []
    fehler = []
    for m in WORT.finditer(text):
        wort = m.group(0)
        if len(wort) < 3 or wort.isupper():
            continue  # Abkürzungen (KFZ, SEPA) nicht anmeckern
        if wb.bekannt(wort) or all(wb.bekannt(teil) for teil in wort.split("-") if teil):
            continue
        eintrag = {"start": m.start(), "ende": m.end(), "wort": wort}
        if mit_vorschlaegen:
            eintrag["vorschlaege"] = wb.vorschlaege(wort)
        fehler.append(eintrag)
    return fehler


def einrichten(
    app: FastAPI,
    dokumente: DokumentSpeicher,
    bearbeitung: Bearbeitung,
    benutzer: BenutzerSpeicher,
    antwort: Callable[..., Awaitable[dict]],
) -> None:
    ablage = bilder.BildAblage()
    unterschriften = bilder.Unterschriften(benutzer.ordner / "unterschriften")
    ausgaben: dict[str, tuple[bytes, str, str]] = {}  # Druck-/Download-Dateien
    app.state.bildablage = ablage

    def autor() -> str:
        return anmerkungen.autor_name(benutzer.einstellungen().get("kuerzel", ""))

    def ausgabe_ablegen(daten: bytes, name: str, typ: str) -> str:
        schluessel = uuid.uuid4().hex[:16]
        ausgaben[schluessel] = (daten, name, typ)
        while len(ausgaben) > 10:
            ausgaben.pop(next(iter(ausgaben)))
        return f"/api/ausgabe/{schluessel}"

    # ============================================================ Anmerkungen
    @app.get("/api/dokumente/{dok_id}/anmerkungen")
    async def anmerkungen_liste(dok_id: str):
        return await im_mupdf_thread(lambda: anmerkungen.liste(dokumente.get(dok_id).doc))

    def _bild_fuer(d: dict) -> bytes | None:
        if d.get("bild_id"):
            return ablage.holen(d["bild_id"])
        if d.get("unterschrift_id"):
            return unterschriften.holen(d["unterschrift_id"])
        return None

    @app.post("/api/dokumente/{dok_id}/anmerkungen")
    async def anmerkung_neu(dok_id: str, daten: dict = Body(...)):
        bild = _bild_fuer(daten)
        seite = int(daten.get("seite", 0))
        name = autor()
        if daten.get("art") == "stempel" and daten.get("vorlage"):
            daten = {**daten, "text": anmerkungen.stempel_text(daten["vorlage"], benutzer.einstellungen().get("kuerzel", ""))}

        def anlegen():
            dok = dokumente.get(dok_id)
            titel = {"schwaerzung": "Schwärzung vormerken", "bild": "Bild einfügen", "unterschrift": "Unterschrift einfügen",
                     "stempel": "Stempel setzen", "schreibmaschine": "Text eintragen"}.get(daten.get("art", ""), "Kommentar hinzufügen")
            with bearbeitung.aendern(titel, dok):
                neue_id = anmerkungen.erstellen(dok.doc, seite, daten, name, bild)
                dok.seite_geaendert(seite)
            return neue_id

        neue_id = await im_mupdf_thread(anlegen)
        return await antwort([dok_id], id=neue_id)

    @app.patch("/api/dokumente/{dok_id}/anmerkungen/{xref}")
    async def anmerkung_aendern(dok_id: str, xref: int, daten: dict = Body(...)):
        seite = int(daten.pop("seite"))
        name = autor()

        def aendern():
            dok = dokumente.get(dok_id)
            with bearbeitung.aendern("Kommentar ändern", dok):
                neue_id = anmerkungen.aendern(dok.doc, seite, xref, daten, name)
                dok.seite_geaendert(seite)
            return neue_id

        neue_id = await im_mupdf_thread(aendern)
        return await antwort([dok_id], id=neue_id)

    @app.post("/api/dokumente/{dok_id}/anmerkungen/loeschen")
    async def anmerkungen_loeschen(dok_id: str, eintraege: list[dict] = Body(..., embed=True)):
        def loeschen():
            dok = dokumente.get(dok_id)
            with bearbeitung.aendern("Kommentar löschen" if len(eintraege) == 1 else "Kommentare löschen", dok):
                for e in eintraege:
                    anmerkungen.loeschen(dok.doc, int(e["seite"]), int(e["id"]))
                    dok.seite_geaendert(int(e["seite"]))

        await im_mupdf_thread(loeschen)
        return await antwort([dok_id])

    @app.get("/api/dokumente/{dok_id}/seiten/{seite}/woerter")
    async def woerter(dok_id: str, seite: int):
        def lesen():
            doc = dokumente.get(dok_id).doc
            if not 0 <= seite < doc.page_count:
                raise DokumentFehler("Seite existiert nicht.")
            return anmerkungen.woerter(doc[seite])

        return await im_mupdf_thread(lesen)

    # ------------------------------------------------------ Rechtschreibung
    @app.post("/api/rechtschreibung")
    async def rechtschreibung(text: str = Body(..., embed=True)):
        return await asyncio.get_running_loop().run_in_executor(None, rechtschreibung_pruefen, text[:20000])

    @app.post("/api/rechtschreibung/vorschlaege")
    async def rechtschreibung_vorschlaege(wort: str = Body(..., embed=True)):
        return await asyncio.get_running_loop().run_in_executor(None, woerterbuch().vorschlaege, wort[:80])

    @app.post("/api/woerterbuch")
    async def woerterbuch_hinzufuegen(wort: str = Body(..., embed=True)):
        woerterbuch().hinzufuegen(wort)
        return {"ok": True}

    # =============================================================== Bilder
    @app.post("/api/bilder")
    async def bild_hochladen(request: Request, freistellen: bool = Query(False), staerke: int = Query(50)):
        daten = await request.body()
        if not daten:
            raise DokumentFehler("Leere Datei.")
        loop = asyncio.get_running_loop()
        original = await loop.run_in_executor(None, bilder.normalisieren, daten)
        original_id = ablage.ablegen(original)
        ergebnis = await loop.run_in_executor(None, bilder.freistellen, original, staerke) if freistellen else original
        bild_id = ablage.ablegen(ergebnis) if freistellen else original_id
        b, h = bilder.groesse(ergebnis)
        return {"id": bild_id, "original_id": original_id, "breite": b, "hoehe": h, "bild": bilder.daten_url(ergebnis)}

    @app.post("/api/bilder/{bild_id}/freistellen")
    async def bild_freistellen(bild_id: str, staerke: int = Body(50, embed=True)):
        original = ablage.holen(bild_id)
        ergebnis = await asyncio.get_running_loop().run_in_executor(None, bilder.freistellen, original, staerke)
        neu = ablage.ablegen(ergebnis)
        b, h = bilder.groesse(ergebnis)
        return {"id": neu, "original_id": bild_id, "breite": b, "hoehe": h, "bild": bilder.daten_url(ergebnis)}

    @app.get("/api/unterschriften")
    async def unterschriften_liste():
        return unterschriften.liste()

    @app.post("/api/unterschriften")
    async def unterschrift_speichern(bild_id: str = Body(...), name: str = Body("Unterschrift")):
        return unterschriften.hinzufuegen(ablage.holen(bild_id), name)

    @app.delete("/api/unterschriften/{schluessel}")
    async def unterschrift_entfernen(schluessel: str):
        unterschriften.entfernen(schluessel)
        return {"ok": True}

    # ================================================================ Fotos
    @app.post("/api/foto/ecken")
    async def foto_ecken(bild_id: str = Body(..., embed=True)):
        daten = ablage.holen(bild_id)
        return await asyncio.get_running_loop().run_in_executor(None, foto.ecken_finden, daten)

    @app.post("/api/foto/entzerren")
    async def foto_entzerren(
        bild_id: str = Body(...),
        ecken: list[list[float]] | None = Body(None),
        filter: str = Body("dokument"),  # noqa: A002 – Feldname der Oberfläche
        drehung: int = Body(0),
    ):
        daten = ablage.holen(bild_id)
        ergebnis, format_ = await asyncio.get_running_loop().run_in_executor(None, foto.entzerren, daten, ecken, filter, drehung)
        neu = ablage.ablegen(ergebnis)
        b, h = bilder.groesse(ergebnis)
        mime = "image/jpeg" if format_ == "jpeg" else "image/png"
        import base64

        return {"id": neu, "format": format_, "breite": b, "hoehe": h, "bild": f"data:{mime};base64,{base64.b64encode(ergebnis).decode()}"}

    @app.post("/api/dokumente/{dok_id}/seiten/{seite}/als_bild")
    async def seite_als_bild(dok_id: str, seite: int):
        def rendern():
            doc = dokumente.get(dok_id).doc
            if not 0 <= seite < doc.page_count:
                raise DokumentFehler("Seite existiert nicht.")
            return foto.seite_als_bild(doc[seite])

        daten = await im_mupdf_thread(rendern)
        bild_id = ablage.ablegen(daten)
        b, h = bilder.groesse(daten)
        return {"id": bild_id, "breite": b, "hoehe": h, "bild": bilder.daten_url(daten)}

    @app.post("/api/dokumente/{dok_id}/seiten/bild_einsetzen")
    async def bild_einsetzen(dok_id: str, bild_id: str = Body(...), position: int = Body(...), ersetzen: bool = Body(False)):
        """Bild als Seite einfügen (A4-Breite bei 200 dpi) – auf Wunsch statt der Seite ``position``."""
        daten = ablage.holen(bild_id)

        def einsetzen():
            dok = dokumente.get(dok_id)
            quelle = pymupdf.open(stream=daten, filetype="jpg" if daten[:2] == b"\xff\xd8" else "png")
            pdf = pymupdf.open("pdf", quelle.convert_to_pdf())
            quelle.close()
            titel = "Seite durch Foto ersetzen" if ersetzen else "Foto als Seite einfügen"
            with bearbeitung.aendern(titel, dok):
                from ..kern.dokumente import neue_seiten_id

                dok.doc.insert_pdf(pdf, start_at=position)
                dok.seiten_ids.insert(position, neue_seiten_id())
                if ersetzen:
                    dok.doc.delete_page(position + 1)
                    del dok.seiten_ids[position + 1]
            pdf.close()

        await im_mupdf_thread(einsetzen)
        return await antwort([dok_id], auswahl=[position])

    @app.post("/api/bilder/{bild_id}/als_dokument")
    async def bild_als_dokument(bild_id: str, name: str = Body("Foto", embed=True)):
        daten = ablage.holen(bild_id)
        endung = "jpg" if daten[:2] == b"\xff\xd8" else "png"

        def oeffnen():
            dok = dokumente.oeffnen_bytes(daten, f"{name}.{endung}")
            dok.titel = f"{name}.pdf"
            dok.geaendert = True
            return dok.id

        neu = await im_mupdf_thread(oeffnen)
        return await antwort([], [neu])

    # ============================================================ Schwärzen
    @app.post("/api/dokumente/{dok_id}/schwaerzen/suchen")
    async def schwaerzen_suchen(dok_id: str, muster: str = Body(...), begriff: str = Body("")):
        return await im_mupdf_thread(lambda: anmerkungen.muster_suchen(dokumente.get(dok_id).doc, muster, begriff))

    @app.post("/api/dokumente/{dok_id}/schwaerzen/vormerken")
    async def schwaerzen_vormerken(dok_id: str, eintraege: list[dict] = Body(..., embed=True)):
        name = autor()

        def vormerken():
            dok = dokumente.get(dok_id)
            with bearbeitung.aendern("Schwärzungen vormerken", dok):
                je_seite: dict[int, list] = {}
                for e in eintraege:
                    je_seite.setdefault(int(e["seite"]), []).append(e["rechteck"])
                for seite, rechtecke in je_seite.items():
                    anmerkungen.schwaerzung_vormerken(dok.doc, dok.doc[seite], rechtecke, name)
                    dok.seite_geaendert(seite)
            return len(eintraege)

        anzahl = await im_mupdf_thread(vormerken)
        return await antwort([dok_id], anzahl=anzahl)

    @app.post("/api/dokumente/{dok_id}/schwaerzen/anwenden")
    async def schwaerzen_anwenden(dok_id: str, metadaten: bool = Body(True, embed=True)):
        def anwenden():
            dok = dokumente.get(dok_id)
            with bearbeitung.aendern("Schwärzungen anwenden", dok):
                seiten = anmerkungen.schwaerzungen_anwenden(dok.doc)
                if not seiten:
                    raise DokumentFehler("Es sind keine Schwärzungen vorgemerkt.")
                if metadaten:
                    ausgabe.metadaten_entfernen(dok.doc)
                for s in seiten:
                    dok.seite_geaendert(s)
            return seiten

        seiten = await im_mupdf_thread(anwenden)
        return await antwort([dok_id], seiten=seiten)

    # ======================================================= Schutz & Info
    @app.get("/api/dokumente/{dok_id}/schutz")
    async def schutz_holen(dok_id: str):
        def holen():
            dok = dokumente.get(dok_id)
            s = dok.schutz if dok.schutz is not None else dok.schutz_gespeichert
            rechte = {k: (s or {}).get(k, True) for k in ("drucken", "kopieren", "aendern", "kommentieren")}
            return {
                "verschluesselt": dok.war_verschluesselt,
                "kennwort_oeffnen": bool((s or {}).get("benutzer")) or (s is None and dok.war_verschluesselt),
                "rechte_kennwort": bool((s or {}).get("besitzer")),
                "rechte": rechte,
                "ausstehend": dok.schutz is not None,
            }

        return await im_mupdf_thread(holen)

    @app.put("/api/dokumente/{dok_id}/schutz")
    async def schutz_setzen(dok_id: str, daten: dict = Body(...)):
        def setzen():
            dok = dokumente.get(dok_id)
            if daten.get("aus"):
                dok.schutz = {"aus": True}
            else:
                benutzer_pw = str(daten.get("benutzer") or "")
                besitzer_pw = str(daten.get("besitzer") or "")
                if not benutzer_pw and not besitzer_pw:
                    raise DokumentFehler("Bitte mindestens ein Kennwort eingeben.")
                if benutzer_pw and len(benutzer_pw) < 4:
                    raise DokumentFehler("Das Kennwort sollte mindestens 4 Zeichen haben.")
                dok.schutz = {
                    "benutzer": benutzer_pw,
                    "besitzer": besitzer_pw,
                    **{k: bool(daten.get(k, True)) for k in ("drucken", "kopieren", "aendern", "kommentieren")},
                }
            dok.geaendert = True
            dok.version += 1

        await im_mupdf_thread(setzen)
        return await antwort([dok_id])

    @app.get("/api/dokumente/{dok_id}/eigenschaften")
    async def eigenschaften(dok_id: str):
        def holen():
            dok = dokumente.get(dok_id)
            groesse = os.path.getsize(dok.pfad) if dok.pfad and os.path.isfile(dok.pfad) else None
            return {**ausgabe.metadaten(dok.doc), "dateigroesse": groesse, "pdf_version": dok.doc.metadata.get("format", ""),
                    "seiten": dok.doc.page_count, "pfad": dok.pfad}

        return await im_mupdf_thread(holen)

    @app.put("/api/dokumente/{dok_id}/eigenschaften")
    async def eigenschaften_setzen(dok_id: str, werte: dict = Body(...)):
        def setzen():
            dok = dokumente.get(dok_id)
            with bearbeitung.aendern("Dokumenteigenschaften ändern", dok):
                ausgabe.metadaten_setzen(dok.doc, werte)

        await im_mupdf_thread(setzen)
        return await antwort([dok_id])

    @app.post("/api/dokumente/{dok_id}/metadaten_entfernen")
    async def metadaten_entfernen(dok_id: str):
        def entfernen():
            dok = dokumente.get(dok_id)
            with bearbeitung.aendern("Metadaten entfernen", dok):
                ausgabe.metadaten_entfernen(dok.doc)

        await im_mupdf_thread(entfernen)
        return await antwort([dok_id])

    # ========================================================= Komprimieren
    @app.post("/api/dokumente/{dok_id}/komprimieren")
    async def komprimieren(dok_id: str, stufe: str = Body("mittel", embed=True)):
        def ausfuehren():
            dok = dokumente.get(dok_id)
            vorher = ausgabe.groesse_schaetzen(dok.doc)
            daten = ausgabe.komprimieren(dok.doc, stufe)
            if len(daten) >= vorher * 0.98:
                return vorher, vorher, False
            with bearbeitung.aendern("Komprimieren", dok):
                neu = pymupdf.open("pdf", daten)
                dok.doc.close()
                dok.doc = neu
                for i in range(neu.page_count):
                    dok.seite_geaendert(i)
            return vorher, len(daten), True

        vorher, nachher, geaendert = await im_mupdf_thread(ausfuehren)
        return await antwort([dok_id], vorher=vorher, nachher=nachher, geaendert=geaendert)

    # ================================================================ Ebenen
    @app.get("/api/dokumente/{dok_id}/ebenen")
    async def ebenen(dok_id: str):
        return await im_mupdf_thread(lambda: ausgabe.ebenen(dokumente.get(dok_id).doc))

    @app.put("/api/dokumente/{dok_id}/ebenen/{xref}")
    async def ebene_schalten(dok_id: str, xref: int, an: bool = Body(..., embed=True)):
        def schalten():
            dok = dokumente.get(dok_id)
            ausgabe.ebene_schalten(dok.doc, xref, an)
            for i in range(dok.doc.page_count):
                dok.seite_geaendert(i)
            dok.version += 1

        await im_mupdf_thread(schalten)
        return await antwort([dok_id])

    # =============================================================== Ausgabe
    @app.post("/api/dokumente/{dok_id}/ausgabe")
    async def ausgabe_erzeugen(
        dok_id: str,
        seiten: list[int] | None = Body(None),
        gruppen_weg: list[str] = Body([]),
        ebenen_aus: list[int] = Body([]),
        ebenen_entfernen: bool = Body(False),
        pfad: str | None = Body(None),
    ):
        """Druck- oder Export-PDF. Ohne ``pfad``: Datei zum Drucken/Herunterladen
        bereitstellen (URL), mit ``pfad``: dort speichern."""

        def erzeugen():
            dok = dokumente.get(dok_id)
            daten = ausgabe.ausgabe_pdf(dok.doc, seiten, set(gruppen_weg), ebenen_aus)
            if ebenen_entfernen and ebenen_aus:
                # Namen statt Nummern: beim Aufräumen ändern sich die Objektnummern
                daten = ausgabe.ebenen_entfernen(daten, ausgabe.ebenen_namen(dok.doc, ebenen_aus))
            return daten, dok.titel

        daten, titel = await im_mupdf_thread(erzeugen)
        if pfad:
            ziel = Path(os.path.abspath(pfad))
            if ziel.suffix.lower() != ".pdf":
                ziel = ziel.with_name(ziel.name + ".pdf")
            await asyncio.get_running_loop().run_in_executor(None, _atomar_schreiben, ziel, daten)
            return {"pfad": str(ziel), "groesse": len(daten)}
        return {"url": ausgabe_ablegen(daten, titel, "application/pdf"), "groesse": len(daten)}

    @app.get("/api/ausgabe/{schluessel}")
    async def ausgabe_holen(schluessel: str, herunterladen: bool = False):
        if schluessel not in ausgaben:
            raise DokumentFehler("Datei nicht mehr vorhanden.")
        daten, name, typ = ausgaben[schluessel]
        art = "attachment" if herunterladen else "inline"
        from urllib.parse import quote

        return Response(daten, media_type=typ, headers={"Content-Disposition": f"{art}; filename*=UTF-8''{quote(name)}"})

    @app.post("/api/dokumente/{dok_id}/bilder_export")
    async def bilder_export(
        dok_id: str,
        seiten: list[int] = Body(...),
        dpi: int = Body(200),
        format: str = Body("png"),  # noqa: A002
        ordner: str | None = Body(None),
    ):
        def erzeugen():
            dok = dokumente.get(dok_id)
            return ausgabe.seiten_als_bilder(dok.doc, seiten, dpi, format, dok.titel)

        daten, name = await im_mupdf_thread(erzeugen)
        if ordner:
            ziel = Path(ordner) / name
            await asyncio.get_running_loop().run_in_executor(None, _atomar_schreiben, ziel, daten)
            return {"pfad": str(ziel)}
        typ = "application/zip" if name.endswith(".zip") else ("image/jpeg" if format == "jpg" else "image/png")
        return {"url": ausgabe_ablegen(daten, name, typ) + "?herunterladen=true", "name": name}

    @app.get("/api/dokumente/{dok_id}/text")
    async def text_export(dok_id: str):
        text = await im_mupdf_thread(lambda: ausgabe.text_export(dokumente.get(dok_id).doc))
        return Response(text, media_type="text/plain; charset=utf-8")

    # ============================================================= Formulare
    @app.get("/api/dokumente/{dok_id}/formular")
    async def formular(dok_id: str):
        return await im_mupdf_thread(lambda: formulare.felder(dokumente.get(dok_id).doc))

    @app.put("/api/dokumente/{dok_id}/formular/{xref}")
    async def formular_setzen(dok_id: str, xref: int, seite: int = Body(...), wert: Any = Body(None)):
        def setzen():
            dok = dokumente.get(dok_id)
            with bearbeitung.aendern("Formular ausfüllen", dok):
                formulare.feld_setzen(dok.doc, seite, xref, wert)
                dok.seite_geaendert(seite)

        await im_mupdf_thread(setzen)
        return await antwort([dok_id])
