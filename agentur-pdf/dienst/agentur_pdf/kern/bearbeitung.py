"""Seiten organisieren, Rückgängig/Wiederholen, Speichern.

Jede Änderung läuft über ``Bearbeitung.aendern``: Vorher wird von jedem
betroffenen Dokument ein Schnappschuss gezogen. Betrifft ein Schritt mehrere
Dokumente (Seiten von A nach B verschieben), erhalten alle Schnappschüsse
dieselbe Gruppe – „Rückgängig“ in einem der Dokumente stellt dann beide wieder
her.

Wie ``dokumente.py``: nur im MuPDF-Thread aufrufen.
"""

from __future__ import annotations

import os
import tempfile
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Sequence

import pymupdf

from .dokumente import DokumentFehler, DokumentSpeicher, OffenesDokument, Schnappschuss, neue_seiten_id

MAX_VERLAUF_BYTES = 600 * 1024 * 1024  # Gesamtspeicher für Rückgängig (alle Dokumente)
MAX_VERLAUF_SCHRITTE = 50  # je Dokument
BILD_ENDUNGEN = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".gif", ".jxr", ".pnm", ".pgm", ".ppm"}

# Leerseiten-Erkennung: Anteil „dunkler“ Pixel, unter dem eine Seite als leer gilt
LEER_SCHWELLE = 0.002
LEER_RAND = 0.04  # Ränder ignorieren (Scannerkanten, Lochungen)


def _seitenliste(dok: OffenesDokument, seiten: Sequence[int]) -> list[int]:
    n = dok.doc.page_count
    ergebnis = sorted(set(int(s) for s in seiten))
    if not ergebnis:
        raise DokumentFehler("Keine Seiten ausgewählt.")
    if ergebnis[0] < 0 or ergebnis[-1] >= n:
        raise DokumentFehler("Ungültige Seitennummer.")
    return ergebnis


def quelle_oeffnen(daten: bytes | None = None, pfad: str | None = None, name: str = "") -> pymupdf.Document:
    """Öffnet PDF oder Bild (auch mehrseitiges TIFF) als PDF-Dokument."""
    try:
        if pfad is not None:
            if not os.path.isfile(pfad):
                raise DokumentFehler(f"Datei nicht gefunden: {pfad}")
            daten = Path(pfad).read_bytes()  # Datei nicht offen halten (Windows-Sperren)
            quelle = pymupdf.open(stream=daten, filetype=Path(pfad).suffix.lstrip(".").lower() or "pdf")
            name = name or pfad
        else:
            quelle = pymupdf.open(stream=daten, filetype=Path(name).suffix.lstrip(".").lower() or "pdf")
    except DokumentFehler:
        raise
    except Exception as fehler:  # noqa: BLE001
        raise DokumentFehler(f"„{Path(name).name}“ kann nicht gelesen werden: {fehler}") from fehler
    if quelle.needs_pass:
        quelle.close()
        raise DokumentFehler(f"„{Path(name).name}“ ist passwortgeschützt – bitte zuerst öffnen und entsperren.")
    if not quelle.is_pdf:
        pdf = quelle.convert_to_pdf()
        quelle.close()
        quelle = pymupdf.open("pdf", pdf)
    if quelle.page_count == 0:
        raise DokumentFehler(f"„{Path(name).name}“ enthält keine Seiten.")
    return quelle


class Bearbeitung:
    def __init__(self, speicher: DokumentSpeicher) -> None:
        self.speicher = speicher

    # ------------------------------------------------------------ Verlauf
    def _schnappschuss(self, dok: OffenesDokument, titel: str, gruppe: str) -> Schnappschuss:
        return Schnappschuss(
            daten=dok.doc.tobytes(),
            seiten_ids=list(dok.seiten_ids),
            seiten_versionen=dict(dok.seiten_versionen),
            geaendert=dok.geaendert,
            titel=titel,
            gruppe=gruppe,
        )

    def _wiederherstellen(self, dok: OffenesDokument, s: Schnappschuss) -> None:
        neu = pymupdf.open("pdf", s.daten)
        if neu.needs_pass and dok.passwort:
            neu.authenticate(dok.passwort)
        dok.doc.close()
        dok.doc = neu
        dok.seiten_ids = list(s.seiten_ids)
        dok.seiten_versionen = dict(s.seiten_versionen)
        dok.geaendert = s.geaendert
        dok.version += 1

    def _verlauf_begrenzen(self) -> None:
        alle = self.speicher.alle()
        for dok in alle:
            del dok.zurueck[:-MAX_VERLAUF_SCHRITTE]
        gesamt = sum(s.groesse for d in alle for s in d.zurueck + d.vor)
        while gesamt > MAX_VERLAUF_BYTES:
            # ältesten Schritt des Dokuments mit dem größten Verlauf verwerfen
            kandidat = max(alle, key=lambda d: sum(s.groesse for s in d.zurueck))
            if len(kandidat.zurueck) <= 1:
                break
            gesamt -= kandidat.zurueck.pop(0).groesse

    @contextmanager
    def aendern(self, titel: str, *dokumente: OffenesDokument) -> Iterator[None]:
        gruppe = uuid.uuid4().hex
        vorher = {d.id: self._schnappschuss(d, titel, gruppe) for d in dokumente}
        try:
            yield
        except Exception:
            for d in dokumente:
                self._wiederherstellen(d, vorher[d.id])
            raise
        for d in dokumente:
            d.zurueck.append(vorher[d.id])
            d.vor.clear()
            d.geaendert = True
            d.version += 1
        self._verlauf_begrenzen()

    def _schritt(self, dok_id: str, von: str, nach: str) -> list[str]:
        """Gemeinsame Logik für Rückgängig (zurueck→vor) und Wiederholen (vor→zurueck)."""
        dok = self.speicher.get(dok_id)
        stapel = getattr(dok, von)
        if not stapel:
            raise DokumentFehler("Nichts zum Rückgängigmachen." if von == "zurueck" else "Nichts zum Wiederholen.")
        gruppe = stapel[-1].gruppe
        betroffen = [dok] + [
            d for d in self.speicher.alle() if d is not dok and getattr(d, von) and getattr(d, von)[-1].gruppe == gruppe
        ]
        for d in betroffen:
            s = getattr(d, von).pop()
            getattr(d, nach).append(self._schnappschuss(d, s.titel, s.gruppe))
            self._wiederherstellen(d, s)
        return [d.id for d in betroffen]

    def rueckgaengig(self, dok_id: str) -> list[str]:
        return self._schritt(dok_id, "zurueck", "vor")

    def wiederholen(self, dok_id: str) -> list[str]:
        return self._schritt(dok_id, "vor", "zurueck")

    # ------------------------------------------------------- Seitenoperationen
    def drehen(self, dok_id: str, seiten: Sequence[int], grad: int) -> None:
        dok = self.speicher.get(dok_id)
        seiten = _seitenliste(dok, seiten)
        if grad % 90:
            raise DokumentFehler("Drehung muss ein Vielfaches von 90° sein.")
        with self.aendern("Seiten drehen", dok):
            for s in seiten:
                seite = dok.doc[s]
                seite.set_rotation((seite.rotation + grad) % 360)
                dok.seite_geaendert(s)

    def loeschen(self, dok_id: str, seiten: Sequence[int]) -> None:
        dok = self.speicher.get(dok_id)
        seiten = _seitenliste(dok, seiten)
        if len(seiten) >= dok.doc.page_count:
            raise DokumentFehler("Mindestens eine Seite muss im Dokument bleiben.")
        with self.aendern("Seiten löschen" if len(seiten) > 1 else "Seite löschen", dok):
            dok.doc.delete_pages(seiten)
            for s in reversed(seiten):
                del dok.seiten_ids[s]

    def verschieben(self, dok_id: str, seiten: Sequence[int], ziel: int) -> list[int]:
        """Verschiebt ``seiten`` vor die Seite, die *jetzt* an Position ``ziel``
        steht (``ziel`` = Seitenanzahl → ans Ende). Liefert die neuen Positionen."""
        dok = self.speicher.get(dok_id)
        seiten = _seitenliste(dok, seiten)
        n = dok.doc.page_count
        ziel = max(0, min(int(ziel), n))
        rest = [i for i in range(n) if i not in seiten]
        pos = sum(1 for i in rest if i < ziel)
        reihenfolge = rest[:pos] + seiten + rest[pos:]
        neue_positionen = list(range(pos, pos + len(seiten)))
        if reihenfolge == list(range(n)):
            return neue_positionen
        with self.aendern("Seiten verschieben", dok):
            dok.doc.select(reihenfolge)
            dok.seiten_ids = [dok.seiten_ids[i] for i in reihenfolge]
        return neue_positionen

    def duplizieren(self, dok_id: str, seiten: Sequence[int]) -> None:
        dok = self.speicher.get(dok_id)
        seiten = _seitenliste(dok, seiten)
        with self.aendern("Seiten duplizieren", dok):
            for s in reversed(seiten):
                dok.doc.fullcopy_page(s, s + 1)
                dok.seiten_ids.insert(s + 1, neue_seiten_id())

    def leere_seite(self, dok_id: str, position: int, breite: float | None = None, hoehe: float | None = None) -> None:
        dok = self.speicher.get(dok_id)
        n = dok.doc.page_count
        position = max(0, min(int(position), n))
        if breite is None or hoehe is None:
            # Größe der Nachbarseite übernehmen (sonst A4)
            nachbar = dok.doc[min(position, n - 1)] if n else None
            breite, hoehe = (nachbar.rect.width, nachbar.rect.height) if nachbar else (595.0, 842.0)
        with self.aendern("Leere Seite einfügen", dok):
            dok.doc.new_page(pno=position if position < n else -1, width=breite, height=hoehe)
            dok.seiten_ids.insert(position, neue_seiten_id())

    def datei_einfuegen(self, dok_id: str, position: int, quelle: pymupdf.Document, titel: str = "Datei einfügen") -> int:
        """Fügt alle Seiten von ``quelle`` an ``position`` ein. Liefert die Anzahl."""
        dok = self.speicher.get(dok_id)
        position = max(0, min(int(position), dok.doc.page_count))
        anzahl = quelle.page_count
        with self.aendern(titel, dok):
            dok.doc.insert_pdf(quelle, start_at=position if position < dok.doc.page_count else -1)
            dok.seiten_ids[position:position] = [neue_seiten_id() for _ in range(anzahl)]
        return anzahl

    def uebertragen(self, quelle_id: str, seiten: Sequence[int], ziel_id: str, position: int, verschieben: bool) -> list[int]:
        """Kopiert/verschiebt Seiten in ein anderes Dokument. Liefert die neuen
        Positionen im Ziel."""
        if quelle_id == ziel_id:
            if verschieben:
                return self.verschieben(quelle_id, seiten, position)
            raise DokumentFehler("Kopieren innerhalb eines Dokuments: bitte „Duplizieren“ verwenden.")
        quelle = self.speicher.get(quelle_id)
        ziel = self.speicher.get(ziel_id)
        seiten = _seitenliste(quelle, seiten)
        if verschieben and len(seiten) >= quelle.doc.page_count:
            raise DokumentFehler(
                "Es können nicht alle Seiten verschoben werden – mindestens eine muss bleiben. "
                "Zum Kopieren beim Ziehen Strg gedrückt halten."
            )
        position = max(0, min(int(position), ziel.doc.page_count))
        titel = "Seiten verschieben" if verschieben else "Seiten kopieren"
        beteiligt = (quelle, ziel) if verschieben else (ziel,)
        with self.aendern(titel, *beteiligt):
            for k, s in enumerate(seiten):
                ende = position + k >= ziel.doc.page_count
                ziel.doc.insert_pdf(quelle.doc, from_page=s, to_page=s, start_at=-1 if ende else position + k)
                ziel.seiten_ids.insert(position + k, neue_seiten_id())
            if verschieben:
                quelle.doc.delete_pages(seiten)
                for s in reversed(seiten):
                    del quelle.seiten_ids[s]
        return list(range(position, position + len(seiten)))

    def extrahieren(self, dok_id: str, seiten: Sequence[int], loeschen: bool = False) -> OffenesDokument:
        dok = self.speicher.get(dok_id)
        seiten = _seitenliste(dok, seiten)
        neu = pymupdf.open()
        for s in seiten:
            neu.insert_pdf(dok.doc, from_page=s, to_page=s)
        stamm = Path(dok.titel).stem
        neu_dok = self.speicher._registrieren(neu, f"{stamm} – {_bereich_text(seiten)}.pdf", None, None)
        neu_dok.geaendert = True
        if loeschen:
            self.loeschen(dok_id, seiten)
        return neu_dok

    # ----------------------------------------------------------- Teilen
    def teile_berechnen(self, dok_id: str, modus: str, wert: float = 0) -> list[list[int]]:
        dok = self.speicher.get(dok_id)
        n = dok.doc.page_count
        if modus == "seitenanzahl":
            k = int(wert)
            if k < 1:
                raise DokumentFehler("Seitenanzahl pro Teil muss mindestens 1 sein.")
            return [list(range(i, min(i + k, n))) for i in range(0, n, k)]
        if modus == "lesezeichen":
            starts = sorted({max(0, s - 1) for ebene, _t, s, *_ in dok.doc.get_toc() if ebene == 1 and s > 0} | {0})
            if len(starts) <= 1:
                raise DokumentFehler("Das Dokument hat keine Lesezeichen der obersten Ebene zum Teilen.")
            starts.append(n)
            return [list(range(a, b)) for a, b in zip(starts, starts[1:]) if b > a]
        if modus == "leerseiten":
            leer = set(self.leerseiten_finden(dok_id))
            if not leer:
                raise DokumentFehler("Keine Leerseiten gefunden.")
            teile, aktuell = [], []
            for i in range(n):
                if i in leer:
                    if aktuell:
                        teile.append(aktuell)
                    aktuell = []
                else:
                    aktuell.append(i)
            if aktuell:
                teile.append(aktuell)
            return teile
        if modus == "dateigroesse":
            grenze = float(wert) * 1024 * 1024
            if grenze <= 0:
                raise DokumentFehler("Bitte eine Zielgröße in MB angeben.")
            teile, aktuell, summe = [], [], 0.0
            for i in range(n):
                einzel = pymupdf.open()
                einzel.insert_pdf(dok.doc, from_page=i, to_page=i)
                groesse = len(einzel.tobytes(garbage=3, deflate=True))
                einzel.close()
                if aktuell and summe + groesse > grenze:
                    teile.append(aktuell)
                    aktuell, summe = [], 0.0
                aktuell.append(i)
                summe += groesse
            if aktuell:
                teile.append(aktuell)
            return teile
        raise DokumentFehler(f"Unbekannte Teilungsart: {modus}")

    def teilen(self, dok_id: str, modus: str, wert: float = 0) -> dict:
        """Teilt das Dokument. Liegt es als Datei vor, werden die Teile daneben
        gespeichert (Name_Teil_01.pdf …); sonst als neue Tabs geöffnet."""
        dok = self.speicher.get(dok_id)
        teile = self.teile_berechnen(dok_id, modus, wert)
        if len(teile) <= 1:
            raise DokumentFehler("Bei diesen Einstellungen entsteht nur ein Teil – nichts zu teilen.")
        stamm = Path(dok.titel).stem
        dateien, neue = [], []
        for nr, seiten in enumerate(teile, 1):
            teil = pymupdf.open()
            for s in seiten:
                teil.insert_pdf(dok.doc, from_page=s, to_page=s)
            name = f"{stamm}_Teil_{nr:02d}.pdf"
            if dok.pfad:
                ziel = _freier_name(Path(dok.pfad).with_name(name))
                _atomar_schreiben(ziel, teil.tobytes(garbage=3, deflate=True))
                teil.close()
                dateien.append(str(ziel))
            else:
                neu_dok = self.speicher._registrieren(teil, name, None, None)
                neu_dok.geaendert = True
                neue.append(neu_dok.id)
        return {"dateien": dateien, "neu": neue, "teile": len(teile)}

    # ----------------------------------------------------------- Leerseiten
    def leerseiten_finden(self, dok_id: str) -> list[int]:
        return leerseiten_im_dokument(self.speicher.get(dok_id).doc)

    # -------------------------------------------------------------- Speichern
    def speichern(self, dok_id: str, pfad: str | None = None) -> str:
        dok = self.speicher.get(dok_id)
        ziel = pfad or dok.pfad
        if not ziel:
            raise DokumentFehler("SPEICHERORT_FEHLT")
        ziel = os.path.abspath(ziel)
        if not ziel.lower().endswith(".pdf"):
            ziel += ".pdf"
        daten = dok.doc.tobytes(**speicher_optionen(dok))
        _atomar_schreiben(Path(ziel), daten)
        if dok.schutz is not None:
            # Ab jetzt gilt der neue Schutz als „wie geöffnet“
            dok.war_verschluesselt = bool(not dok.schutz.get("aus") and (dok.schutz.get("benutzer") or dok.schutz.get("besitzer")))
            dok.passwort = (dok.schutz.get("benutzer") or dok.schutz.get("besitzer")) if dok.war_verschluesselt else None
            dok.schutz_gespeichert = dict(dok.schutz)
            dok.schutz = None
        dok.pfad = ziel
        dok.titel = Path(ziel).name
        dok.geaendert = False
        # Schnappschüsse im Verlauf gelten jetzt als „ungespeichert“
        for s in dok.zurueck + dok.vor:
            s.geaendert = True
        return ziel

    def datei_bytes(self, dok_id: str) -> bytes:
        dok = self.speicher.get(dok_id)
        return dok.doc.tobytes(garbage=3, deflate=True)


def speicher_optionen(dok: OffenesDokument) -> dict:
    """Optionen für ``tobytes``/``save``: Aufräumen + Kennwortschutz (AES-256)."""
    optionen: dict = {"garbage": 3, "deflate": True}
    schutz = dok.schutz
    if schutz is None:
        if getattr(dok, "schutz_gespeichert", None):
            schutz = dok.schutz_gespeichert
        elif dok.war_verschluesselt and dok.passwort:
            # Schutz beim Speichern erhalten
            return {**optionen, "encryption": pymupdf.PDF_ENCRYPT_AES_256, "user_pw": dok.passwort, "owner_pw": dok.passwort}
        else:
            return optionen
    if schutz.get("aus") or not (schutz.get("benutzer") or schutz.get("besitzer")):
        return optionen
    rechte = pymupdf.PDF_PERM_ACCESSIBILITY
    for schluessel, bit in (
        ("drucken", pymupdf.PDF_PERM_PRINT | pymupdf.PDF_PERM_PRINT_HQ),
        ("kopieren", pymupdf.PDF_PERM_COPY),
        ("aendern", pymupdf.PDF_PERM_MODIFY | pymupdf.PDF_PERM_ASSEMBLE),
        ("kommentieren", pymupdf.PDF_PERM_ANNOTATE | pymupdf.PDF_PERM_FORM),
    ):
        if schutz.get(schluessel, True):
            rechte |= bit
    besitzer = schutz.get("besitzer") or schutz.get("benutzer")
    return {
        **optionen,
        "encryption": pymupdf.PDF_ENCRYPT_AES_256,
        "user_pw": schutz.get("benutzer") or "",
        "owner_pw": besitzer,
        "permissions": rechte,
    }


def leerseiten_im_dokument(doc: pymupdf.Document) -> list[int]:
    """Seiten ohne Text, Anmerkungen und nennenswerte Druckerschwärze."""
    leer = []
    for seite in doc:
        if seite.get_text("text").strip():
            continue
        if seite.first_annot is not None:
            continue
        pix = seite.get_pixmap(matrix=pymupdf.Matrix(0.5, 0.5), colorspace=pymupdf.csGRAY, alpha=False)
        b, h = pix.width, pix.height
        rx, ry = int(b * LEER_RAND), int(h * LEER_RAND)
        daten = pix.samples
        dunkel = gesamt = 0
        for y in range(ry, h - ry, 2):
            zeile = daten[y * pix.stride + rx : y * pix.stride + b - rx : 2]
            gesamt += len(zeile)
            dunkel += sum(1 for v in zeile if v < 160)
        if gesamt and dunkel / gesamt < LEER_SCHWELLE:
            leer.append(seite.number)
    return leer


def _bereich_text(seiten: list[int]) -> str:
    """[0,1,2,5] → 'Seiten 1-3, 6'"""
    teile, start = [], seiten[0]
    for a, b in zip(seiten, seiten[1:] + [None]):
        if b != a + 1:
            teile.append(f"{start + 1}" if start == a else f"{start + 1}-{a + 1}")
            start = b
    return ("Seite " if len(seiten) == 1 else "Seiten ") + ", ".join(teile)


def _freier_name(pfad: Path) -> Path:
    if not pfad.exists():
        return pfad
    for i in range(2, 1000):
        kandidat = pfad.with_name(f"{pfad.stem} ({i}){pfad.suffix}")
        if not kandidat.exists():
            return kandidat
    raise DokumentFehler("Kein freier Dateiname gefunden.")


def _atomar_schreiben(ziel: Path, daten: bytes) -> None:
    """Erst in eine temporäre Datei im Zielordner schreiben, dann ersetzen –
    so bleibt bei Abbruch nie eine halbe PDF zurück."""
    ziel.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix=".agentur-pdf-", suffix=".tmp", dir=ziel.parent)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(daten)
        os.replace(temp, ziel)
    except PermissionError:
        _entfernen(temp)
        raise DokumentFehler(
            f"„{ziel.name}“ kann nicht gespeichert werden – ist die Datei in einem anderen Programm geöffnet?"
        ) from None
    except OSError as fehler:
        _entfernen(temp)
        raise DokumentFehler(f"Speichern fehlgeschlagen: {fehler}") from fehler


def _entfernen(pfad: str) -> None:
    try:
        os.remove(pfad)
    except OSError:
        pass
