"""Dokumentmodell: offene PDFs, Seitenrendering, Suche, Lesezeichen.

Alle Methoden hier sind synchron und dürfen nur im MuPDF-Thread laufen
(siehe ``mupdf_thread``). Koordinaten an die Oberfläche werden immer
normiert (0..1) relativ zur *angezeigten* Seite (inkl. Seitendrehung im PDF,
ohne Ansichtsdrehung) übergeben – so muss die Oberfläche nichts über
PDF-Koordinatensysteme wissen.
"""

from __future__ import annotations

import os
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import pymupdf

from .render_cache import RenderCache

# Feste Render-Stufen (Skalierungsfaktoren inkl. Bildschirm-DPI). Die Oberfläche
# fordert die nächsthöhere Stufe an; so treffen viele Zoomwerte denselben Cache.
RENDER_STUFEN = (0.125, 0.25, 0.375, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 8.0, 10.0, 12.0, 16.0)
MAX_KACHEL_PIXEL = 4096


class DokumentFehler(Exception):
    """Fehler, die dem Benutzer verständlich angezeigt werden können."""


def naechste_stufe(skala: float) -> float:
    for stufe in RENDER_STUFEN:
        if stufe >= skala - 1e-6:
            return stufe
    return RENDER_STUFEN[-1]


def neue_seiten_id() -> str:
    return uuid.uuid4().hex[:10]


@dataclass
class Schnappschuss:
    """Zustand eines Dokuments vor einer Änderung (für Rückgängig/Wiederholen)."""

    daten: bytes
    seiten_ids: list[str]
    seiten_versionen: dict[str, int]
    geaendert: bool
    titel: str  # Name der Aktion, z. B. „Seiten löschen“
    gruppe: str  # verbindet Schritte, die mehrere Dokumente betreffen

    @property
    def groesse(self) -> int:
        return len(self.daten)


@dataclass
class OffenesDokument:
    id: str
    doc: pymupdf.Document
    titel: str
    pfad: str | None
    passwort: str | None = None
    war_verschluesselt: bool = False
    version: int = 0
    geaendert: bool = False
    # Jede Seite hat eine stabile ID; ihr Inhalt eine Versionsnummer. Daraus
    # entsteht die „Kennung“ für Render-Cache und Bild-URLs – so bleibt der
    # Cache korrekt, auch wenn Seiten verschoben, gelöscht oder wiederhergestellt werden.
    seiten_ids: list[str] = field(default_factory=list)
    seiten_versionen: dict[str, int] = field(default_factory=dict)
    zurueck: list[Schnappschuss] = field(default_factory=list)
    vor: list[Schnappschuss] = field(default_factory=list)
    # Vorschlag für „Speichern unter“ bei neuen Dokumenten (z. B. Ordner der Quelldateien)
    ordner_vorschlag: str | None = None
    # Ergebnis der Texterkennung je Seiten-ID (Sicherheit, unsichere Wörter)
    ocr_info: dict[str, dict] = field(default_factory=dict)
    # Kennwortschutz beim nächsten Speichern: None = wie geöffnet,
    # {"aus": True} = Schutz entfernen, sonst Kennwörter + Rechte
    schutz: dict | None = None
    # zuletzt gespeicherter Schutz (gilt für weitere Speichervorgänge)
    schutz_gespeichert: dict | None = None

    def kennung(self, seite: int) -> str:
        sid = self.seiten_ids[seite]
        return f"{sid}.{self.seiten_versionen.get(sid, 0)}"

    def seite_geaendert(self, seite: int) -> None:
        sid = self.seiten_ids[seite]
        self.seiten_versionen[sid] = self.seiten_versionen.get(sid, 0) + 1


class DokumentSpeicher:
    def __init__(self, cache: RenderCache | None = None) -> None:
        self.cache = cache or RenderCache()
        self._dokumente: dict[str, OffenesDokument] = {}

    # ------------------------------------------------------------------ Öffnen
    def oeffnen_pfad(self, pfad: str, passwort: str | None = None) -> OffenesDokument:
        pfad = os.path.abspath(pfad)
        if not os.path.isfile(pfad):
            raise DokumentFehler(f"Datei nicht gefunden: {pfad}")
        for vorhanden in self._dokumente.values():
            if vorhanden.pfad and os.path.normcase(vorhanden.pfad) == os.path.normcase(pfad):
                return vorhanden
        # Datei komplett einlesen statt offen zu halten: Unter Windows ließe
        # sich eine geöffnete Datei sonst nicht speichern/überschreiben
        # (im Windows-Testlauf festgestellt), und andere Programme blieben gesperrt.
        try:
            daten = Path(pfad).read_bytes()
        except OSError as fehler:
            raise DokumentFehler(f"Datei kann nicht gelesen werden: {fehler}") from fehler
        try:
            doc = pymupdf.open(stream=daten, filetype=Path(pfad).suffix.lstrip(".").lower() or "pdf")
        except Exception as fehler:  # noqa: BLE001 – MuPDF wirft diverse Typen
            raise DokumentFehler(f"Datei kann nicht geöffnet werden: {fehler}") from fehler
        return self._registrieren(doc, Path(pfad).name, pfad, passwort)

    def oeffnen_bytes(self, daten: bytes, dateiname: str, passwort: str | None = None) -> OffenesDokument:
        try:
            doc = pymupdf.open(stream=daten, filetype=Path(dateiname).suffix.lstrip(".") or "pdf")
        except Exception as fehler:  # noqa: BLE001
            raise DokumentFehler(f"Datei kann nicht geöffnet werden: {fehler}") from fehler
        return self._registrieren(doc, dateiname, None, passwort)

    def _registrieren(self, doc: pymupdf.Document, titel: str, pfad: str | None, passwort: str | None) -> OffenesDokument:
        verschluesselt = bool(doc.needs_pass)
        if doc.needs_pass:
            if not passwort or not doc.authenticate(passwort):
                doc.close()
                raise DokumentFehler("PASSWORT_ERFORDERLICH")
        if not doc.is_pdf:
            # Bilder, XPS, EPUB … werden sofort in ein PDF umgewandelt.
            pdf_daten = doc.convert_to_pdf()
            doc.close()
            doc = pymupdf.open("pdf", pdf_daten)
            pfad = None
        dok = OffenesDokument(
            id=uuid.uuid4().hex[:12],
            doc=doc,
            titel=titel,
            pfad=pfad,
            passwort=passwort if verschluesselt else None,
            war_verschluesselt=verschluesselt,
            seiten_ids=[neue_seiten_id() for _ in range(doc.page_count)],
        )
        self._dokumente[dok.id] = dok
        return dok

    def schliessen(self, dok_id: str) -> None:
        dok = self._dokumente.pop(dok_id, None)
        if dok:
            self.cache.entferne_dokument(dok_id)
            dok.doc.close()

    def get(self, dok_id: str) -> OffenesDokument:
        try:
            return self._dokumente[dok_id]
        except KeyError:
            raise DokumentFehler("Dokument ist nicht (mehr) geöffnet.") from None

    def alle(self) -> list[OffenesDokument]:
        return list(self._dokumente.values())

    # -------------------------------------------------------------- Auskunft
    def info(self, dok_id: str) -> dict:
        dok = self.get(dok_id)
        seiten = []
        for seite in dok.doc:
            r = seite.rect
            seiten.append({"breite": round(r.width, 2), "hoehe": round(r.height, 2), "drehung": seite.rotation})
        meta = dok.doc.metadata or {}
        return {
            "id": dok.id,
            "titel": dok.titel,
            "pfad": dok.pfad,
            "ordner": dok.ordner_vorschlag,
            "version": dok.version,
            "seitenanzahl": dok.doc.page_count,
            "seiten": seiten,
            "kennungen": [dok.kennung(i) for i in range(dok.doc.page_count)],
            "verschluesselt": dok.war_verschluesselt,
            "schutz": _schutz_info(dok),
            "geaendert": dok.geaendert,
            "rueckgaengig": dok.zurueck[-1].titel if dok.zurueck else None,
            "wiederholen": dok.vor[-1].titel if dok.vor else None,
            "meta": {"titel": meta.get("title", ""), "autor": meta.get("author", "")},
        }

    # ------------------------------------------------------------- Rendering
    def render(
        self,
        dok_id: str,
        seite_nr: int,
        skala: float,
        drehung: int = 0,
        kachel: tuple[int, int, int, int] | None = None,
        kennung: str | None = None,
        ausblenden: frozenset[str] = frozenset(),
        ohne: frozenset[int] = frozenset(),
    ) -> bytes:
        """Rendert eine Seite (oder eine Kachel daraus) als PNG.

        ``kachel`` = (x, y, breite, hoehe) in Gerätepixeln der angezeigten,
        um ``drehung`` gedrehten Seite bei Skala ``skala``.
        """
        dok = self.get(dok_id)
        if kennung:
            # Seite über ihre Kennung suchen: Wurde inzwischen umsortiert oder
            # geändert, darf kein falsches Bild unter der alten URL landen.
            sid, _, version = kennung.partition(".")
            try:
                seite_nr = dok.seiten_ids.index(sid)
            except ValueError:
                raise DokumentFehler("VERALTET") from None
            if dok.kennung(seite_nr) != kennung:
                raise DokumentFehler("VERALTET")
        if not 0 <= seite_nr < dok.doc.page_count:
            raise DokumentFehler("Seite existiert nicht.")
        skala = naechste_stufe(max(0.05, min(skala, RENDER_STUFEN[-1])))
        drehung = int(drehung) % 360
        if drehung % 90:
            raise DokumentFehler("Drehung muss ein Vielfaches von 90° sein.")

        schluessel = (dok_id, dok.kennung(seite_nr), skala, drehung, kachel, ausblenden, ohne)
        treffer = self.cache.get(schluessel)
        if treffer is not None:
            return treffer

        seite = dok.doc[seite_nr]
        matrix = pymupdf.Matrix(skala, skala).prerotate(drehung)
        clip = None
        if kachel is not None:
            x, y, b, h = kachel
            if b <= 0 or h <= 0 or b > MAX_KACHEL_PIXEL or h > MAX_KACHEL_PIXEL:
                raise DokumentFehler("Ungültige Kachelgröße.")
            gesamt = seite.rect * matrix
            anzeige = pymupdf.Rect(gesamt.x0 + x, gesamt.y0 + y, gesamt.x0 + x + b, gesamt.y0 + y + h)
            clip = (anzeige * ~matrix).normalize() & seite.rect
            if clip.is_empty:
                raise DokumentFehler("Kachel liegt außerhalb der Seite.")
        else:
            gesamt = seite.rect * matrix
            if gesamt.width * gesamt.height > MAX_KACHEL_PIXEL * MAX_KACHEL_PIXEL:
                raise DokumentFehler("Seite zu groß für ein Einzelbild – Kacheln verwenden.")

        if ausblenden or ohne:
            # ausgeblendete Anmerkungsgruppen (oder gerade bearbeitete
            # Anmerkungen) nur für dieses Bild verstecken
            from .anmerkungen import gruppen_ausblenden_seite, gruppen_wiederherstellen

            alt = gruppen_ausblenden_seite(dok.doc, seite, ausblenden, ohne)
            try:
                pix = seite.get_pixmap(matrix=matrix, clip=clip, alpha=False, annots=True)
            finally:
                gruppen_wiederherstellen(dok.doc, alt)
        else:
            pix = seite.get_pixmap(matrix=matrix, clip=clip, alpha=False, annots=True)
        daten = pix.tobytes("png")
        self.cache.put(schluessel, daten)
        return daten

    # ----------------------------------------------------------------- Suche
    def suchen(self, dok_id: str, begriff: str, max_treffer: int = 2000) -> list[dict]:
        """Volltextsuche (Groß-/Kleinschreibung egal). Liefert Treffer mit
        normierten Rechtecken und Textausschnitt."""
        dok = self.get(dok_id)
        begriff = begriff.strip()
        if not begriff:
            return []
        treffer: list[dict] = []
        for seite in dok.doc:
            rechtecke = seite.search_for(begriff, quads=False)
            if not rechtecke:
                continue
            breite, hoehe = seite.rect.width, seite.rect.height
            rot = seite.rotation_matrix
            woerter = seite.get_text("words") if rechtecke else []
            for r in rechtecke:
                anzeige = (r * rot).normalize()
                treffer.append(
                    {
                        "seite": seite.number,
                        "rechteck": [
                            round(anzeige.x0 / breite, 5),
                            round(anzeige.y0 / hoehe, 5),
                            round(anzeige.x1 / breite, 5),
                            round(anzeige.y1 / hoehe, 5),
                        ],
                        "ausschnitt": _ausschnitt(woerter, r),
                    }
                )
                if len(treffer) >= max_treffer:
                    return treffer
        return treffer

    # ----------------------------------------------------------- Lesezeichen
    def lesezeichen(self, dok_id: str) -> list[dict]:
        dok = self.get(dok_id)
        ergebnis = []
        for ebene, titel, seite, *_ in dok.doc.get_toc(simple=False):
            ergebnis.append({"ebene": ebene, "titel": titel, "seite": max(0, seite - 1)})
        return ergebnis


def _schutz_info(dok: OffenesDokument) -> str:
    """Kurzbeschreibung des Kennwortschutzes, der beim Speichern gilt."""
    schutz = dok.schutz if dok.schutz is not None else dok.schutz_gespeichert
    if schutz is None:
        return "kennwort" if dok.war_verschluesselt else "keiner"
    if schutz.get("aus") or not (schutz.get("benutzer") or schutz.get("besitzer")):
        return "keiner"
    return "kennwort" if schutz.get("benutzer") else "rechte"


def _ausschnitt(woerter: list, rechteck: pymupdf.Rect, umfeld: int = 6) -> str:
    """Baut einen kurzen Kontext-Text rund um einen Treffer (für die Trefferliste)."""
    if not woerter:
        return ""
    mitte = pymupdf.Point((rechteck.x0 + rechteck.x1) / 2, (rechteck.y0 + rechteck.y1) / 2)
    bester = min(
        range(len(woerter)),
        key=lambda i: abs((woerter[i][0] + woerter[i][2]) / 2 - mitte.x) + 3 * abs((woerter[i][1] + woerter[i][3]) / 2 - mitte.y),
    )
    start, ende = max(0, bester - umfeld), min(len(woerter), bester + umfeld + 1)
    text = " ".join(w[4] for w in woerter[start:ende])
    return ("… " if start > 0 else "") + text + (" …" if ende < len(woerter) else "")
