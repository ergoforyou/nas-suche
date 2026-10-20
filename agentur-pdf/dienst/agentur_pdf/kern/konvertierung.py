"""Umwandlung beliebiger Büro-Dateien in PDF.

Unterstützt: PDF, Bilder (JPG, PNG, TIFF auch mehrseitig, BMP, GIF, HEIC),
Text, E-Mails (EML, Outlook-MSG – optional mit Anhängen) sowie über ein
mitgeliefertes LibreOffice: Word, Excel, PowerPoint, OpenDocument, RTF.

Ergebnis ist eine Liste von ``Teil``en (Titel + PDF-Bytes + Unterteile für
Anhänge), aus der der Zusammenführen-Dialog Lesezeichen baut.

Thread-Regel: Alles, was PyMuPDF benutzt, läuft über ``mupdf`` (eine Funktion,
die Aufrufe in den MuPDF-Thread schickt). LibreOffice läuft außerhalb, damit
die Oberfläche währenddessen flüssig bleibt.
"""

from __future__ import annotations

import email
import email.policy
import html
import io
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from datetime import datetime
from email.message import EmailMessage
from pathlib import Path
from typing import Any, Callable

import pymupdf

from .dokumente import DokumentFehler

PDF = {".pdf"}
BILDER = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp", ".gif", ".heic", ".heif", ".webp"}
TEXT = {".txt", ".csv", ".log"}
MAIL = {".eml", ".msg"}
OFFICE = {".doc", ".docx", ".xls", ".xlsx", ".odt", ".ods", ".odp", ".ppt", ".pptx", ".rtf"}
ALLE = PDF | BILDER | TEXT | MAIL | OFFICE

A4 = pymupdf.paper_rect("a4")
RAND = 50
LIBREOFFICE_ZEITLIMIT = 180  # Sekunden

Mupdf = Callable[..., Any]


def direkt(funktion, *args, **kwargs):
    """``mupdf``-Ersatz für Tests / wenn man bereits im MuPDF-Thread ist."""
    return funktion(*args, **kwargs)


@dataclass
class Teil:
    titel: str
    pdf: bytes
    unterteile: list["Teil"] = field(default_factory=list)


def unterstuetzt(name: str) -> bool:
    return Path(name).suffix.lower() in ALLE


def braucht_umwandlung(name: str) -> bool:
    """True für alles, was nicht direkt von MuPDF geöffnet werden kann."""
    return Path(name).suffix.lower() in TEXT | MAIL | OFFICE | {".heic", ".heif", ".webp"}


def konvertieren(
    name: str,
    daten: bytes | None = None,
    pfad: str | None = None,
    mupdf: Mupdf = direkt,
    anhaenge: bool = True,
    _tiefe: int = 0,
) -> Teil:
    endung = Path(name).suffix.lower()
    titel = Path(name).stem
    if daten is None:
        if pfad is None or not os.path.isfile(pfad):
            raise DokumentFehler(f"Datei nicht gefunden: {pfad or name}")
        if endung not in OFFICE:  # LibreOffice liest selbst vom Pfad
            daten = Path(pfad).read_bytes()
    if endung in PDF:
        return Teil(titel, mupdf(_pdf_pruefen, daten, name))
    if endung in BILDER:
        return Teil(titel, mupdf(_bilder_zu_pdf, _bild_vorbereiten(daten, endung, name), name))
    if endung in TEXT:
        return Teil(titel, mupdf(html_zu_pdf, _text_als_html(daten)))
    if endung in OFFICE:
        return Teil(titel, mupdf(_pdf_pruefen, office_zu_pdf(name, daten, pfad), name))
    if endung in MAIL:
        return _mail_zu_pdf(name, daten, mupdf, anhaenge and _tiefe == 0, _tiefe)
    raise DokumentFehler(f"„{Path(name).name}“: Dateityp {endung or '(ohne Endung)'} wird nicht unterstützt.")


# ------------------------------------------------------------------- PDF
def _pdf_pruefen(daten: bytes, name: str) -> bytes:
    try:
        doc = pymupdf.open("pdf", daten)
    except Exception as fehler:  # noqa: BLE001
        raise DokumentFehler(f"„{Path(name).name}“ ist keine gültige PDF: {fehler}") from fehler
    if doc.needs_pass:
        raise DokumentFehler(f"„{Path(name).name}“ ist passwortgeschützt – bitte zuerst öffnen und entsperren.")
    if doc.page_count == 0:
        raise DokumentFehler(f"„{Path(name).name}“ enthält keine Seiten.")
    doc.close()
    return daten


# ----------------------------------------------------------------- Bilder
def _bild_vorbereiten(daten: bytes, endung: str, name: str) -> tuple[bytes, str]:
    """HEIC/WebP → JPEG; Handyfotos nach EXIF-Ausrichtung drehen."""
    from PIL import Image, ImageOps

    if endung in {".heic", ".heif"}:
        try:
            import pillow_heif

            pillow_heif.register_heif_opener()
        except ImportError as fehler:
            raise DokumentFehler("HEIC-Unterstützung (pillow-heif) ist nicht installiert.") from fehler
    if endung in {".jpg", ".jpeg", ".heic", ".heif", ".webp"}:
        try:
            bild = Image.open(io.BytesIO(daten))
            ausrichtung = bild.getexif().get(0x0112, 1)
            if ausrichtung != 1 or endung not in {".jpg", ".jpeg"}:
                bild = ImageOps.exif_transpose(bild).convert("RGB")
                puffer = io.BytesIO()
                bild.save(puffer, "JPEG", quality=92, dpi=bild.info.get("dpi", (72, 72)))
                return puffer.getvalue(), "jpg"
        except Exception as fehler:  # noqa: BLE001
            raise DokumentFehler(f"Bild „{Path(name).name}“ kann nicht gelesen werden: {fehler}") from fehler
    return daten, endung.lstrip(".")


def _bilder_zu_pdf(vorbereitet: tuple[bytes, str], name: str) -> bytes:
    """Jedes Bild (auch jede TIFF-Seite) wird eine Seite. Seiten aus Fotos
    ohne sinnvolle Auflösung werden auf A4-Größe gebracht."""
    daten, typ = vorbereitet
    try:
        bilder = pymupdf.open(stream=daten, filetype=typ)
    except Exception as fehler:  # noqa: BLE001
        raise DokumentFehler(f"Bild „{Path(name).name}“ kann nicht gelesen werden: {fehler}") from fehler
    # Ganzes Bild-Dokument auf einmal umwandeln (Seitenbereiche sind bei
    # Bildern in MuPDF unzuverlässig), danach Seite für Seite übernehmen.
    alle = pymupdf.open("pdf", bilder.convert_to_pdf())
    ziel = pymupdf.open()
    for seite in alle:
        r = seite.rect
        # Riesige Seiten (Handyfoto mit 72 dpi = 1,4 m breit) auf A4 skalieren
        if r.width > A4.width * 1.25 or r.height > A4.height * 1.25:
            hoch = r.height >= r.width
            rahmen = A4 if hoch else pymupdf.Rect(0, 0, A4.height, A4.width)
            f = min(rahmen.width / r.width, rahmen.height / r.height)
            neu = ziel.new_page(width=r.width * f, height=r.height * f)
            neu.show_pdf_page(neu.rect, alle, seite.number)
        else:
            ziel.insert_pdf(alle, from_page=seite.number, to_page=seite.number)
    if ziel.page_count == 0:
        raise DokumentFehler(f"„{Path(name).name}“ enthält kein Bild.")
    return ziel.tobytes(garbage=3, deflate=True)


# ------------------------------------------------------------------ Text
def _dekodieren(daten: bytes) -> str:
    for kodierung in ("utf-8-sig", "cp1252"):
        try:
            return daten.decode(kodierung)
        except UnicodeDecodeError:
            continue
    return daten.decode("latin-1")


def _text_als_html(daten: bytes) -> str:
    return f"<pre>{html.escape(_dekodieren(daten))}</pre>"


CSS = """
body { font-family: sans-serif; font-size: 10pt; line-height: 1.35; }
pre { font-family: sans-serif; white-space: pre-wrap; }
table.kopf { border-collapse: collapse; margin-bottom: 10pt; width: 100%; }
table.kopf td { padding: 2pt 6pt 2pt 0; vertical-align: top; }
table.kopf td.feld { font-weight: bold; color: #555; width: 70pt; }
h1 { font-size: 14pt; margin: 0 0 8pt 0; }
hr { border: none; border-top: 1px solid #999; margin: 8pt 0; }
"""


def html_zu_pdf(inhalt: str) -> bytes:
    puffer = io.BytesIO()
    schreiber = pymupdf.DocumentWriter(puffer)
    story = pymupdf.Story(html=inhalt, user_css=CSS)
    innen = A4 + (RAND, RAND, -RAND, -RAND)
    weiter = True
    while weiter:
        geraet = schreiber.begin_page(A4)
        weiter, _ = story.place(innen)
        story.draw(geraet)
        schreiber.end_page()
    schreiber.close()
    return puffer.getvalue()


# ---------------------------------------------------------------- E-Mail
@dataclass
class _Mail:
    betreff: str
    absender: str
    an: str
    cc: str
    datum: datetime | None
    text: str
    html: str
    anhaenge: list[tuple[str, bytes]]


def _eml_lesen(daten: bytes) -> _Mail:
    nachricht: EmailMessage = email.message_from_bytes(daten, policy=email.policy.default)  # type: ignore[assignment]
    text_teil = nachricht.get_body(preferencelist=("plain",))
    html_teil = nachricht.get_body(preferencelist=("html",))
    anhaenge = []
    for teil in nachricht.iter_attachments():
        name = teil.get_filename()
        inhalt = teil.get_payload(decode=True)
        if name and inhalt:
            anhaenge.append((name, inhalt))
    try:
        datum = email.utils.parsedate_to_datetime(nachricht["date"]) if nachricht["date"] else None
    except (TypeError, ValueError):
        datum = None
    return _Mail(
        betreff=str(nachricht["subject"] or ""),
        absender=str(nachricht["from"] or ""),
        an=str(nachricht["to"] or ""),
        cc=str(nachricht["cc"] or ""),
        datum=datum,
        text=text_teil.get_content() if text_teil else "",
        html=html_teil.get_content() if html_teil else "",
        anhaenge=anhaenge,
    )


def _msg_lesen(daten: bytes) -> _Mail:
    from .outlook_msg import msg_lesen

    try:
        n = msg_lesen(daten)
    except Exception as fehler:  # noqa: BLE001
        raise DokumentFehler(f"Outlook-Nachricht kann nicht gelesen werden: {fehler}") from fehler
    return _Mail(n.betreff, n.absender, n.an, n.cc, n.datum, n.text, n.html, [(a.name, a.daten) for a in n.anhaenge])


def adressen_lesbar(kopf: str) -> str:
    """„"'max@x.de'" <max@x.de>“ → „max@x.de“; „"Müller, Anna" <a@x.de>“ → „Müller, Anna <a@x.de>“."""
    from email.utils import getaddresses

    teile = []
    for name, adresse in getaddresses([kopf]):
        name = name.strip().strip("'\"").strip()
        if not adresse:
            if name:
                teile.append(name)
            continue
        teile.append(adresse if not name or name.lower() == adresse.lower() else f"{name} <{adresse}>")
    return ", ".join(teile) if teile else kopf


def html_bereinigen(inhalt: str) -> str:
    """Nur den <body> verwenden, Skripte/Stile/externe Bilder entfernen."""
    treffer = re.search(r"<body[^>]*>(.*)</body>", inhalt, re.I | re.S)
    if treffer:
        inhalt = treffer.group(1)
    inhalt = re.sub(r"<(script|style|head)[^>]*>.*?</\1>", "", inhalt, flags=re.I | re.S)
    inhalt = re.sub(r"<img[^>]*>", "", inhalt, flags=re.I)
    inhalt = re.sub(r"<!--.*?-->", "", inhalt, flags=re.S)
    return inhalt


def _mail_zu_pdf(name: str, daten: bytes, mupdf: Mupdf, mit_anhaengen: bool, tiefe: int) -> Teil:
    mail = _msg_lesen(daten) if name.lower().endswith(".msg") else _eml_lesen(daten)
    zeilen = [("Von", adressen_lesbar(mail.absender)), ("An", adressen_lesbar(mail.an)), ("Cc", adressen_lesbar(mail.cc))]
    if mail.datum:
        lokal = mail.datum.astimezone() if mail.datum.tzinfo else mail.datum
        zeilen.append(("Datum", lokal.strftime("%d.%m.%Y %H:%M")))
    if mail.anhaenge:
        zeilen.append(("Anhänge", ", ".join(n for n, _ in mail.anhaenge)))
    kopf = "".join(
        f'<tr><td class="feld">{html.escape(f)}:</td><td>{html.escape(w)}</td></tr>' for f, w in zeilen if w
    )
    if mail.html:
        koerper = html_bereinigen(mail.html)
    else:
        koerper = f"<pre>{html.escape(mail.text)}</pre>"
    inhalt = f'<h1>{html.escape(mail.betreff or "(ohne Betreff)")}</h1><table class="kopf">{kopf}</table><hr/>{koerper}'
    try:
        pdf = mupdf(html_zu_pdf, inhalt)
    except Exception:  # noqa: BLE001 – kaputtes HTML: auf Text zurückfallen
        pdf = mupdf(html_zu_pdf, inhalt.split("<hr/>")[0] + f"<hr/><pre>{html.escape(mail.text)}</pre>")
    teil = Teil(mail.betreff or Path(name).stem, pdf)
    if mit_anhaengen:
        for anhang_name, anhang_daten in mail.anhaenge:
            if not unterstuetzt(anhang_name):
                continue  # z. B. ZIP – steht im Kopf der Mail
            try:
                teil.unterteile.append(konvertieren(anhang_name, anhang_daten, mupdf=mupdf, _tiefe=tiefe + 1))
            except DokumentFehler:
                continue  # defekter Anhang soll die Mail nicht verhindern
    return teil


# ------------------------------------------------------------- LibreOffice
def libreoffice_finden() -> str | None:
    """Mitgeliefertes LibreOffice (neben der .exe) bevorzugen, sonst
    installiertes. Mit AGENTUR_PDF_LIBREOFFICE lässt sich der Pfad festlegen."""
    kandidaten = []
    if os.environ.get("AGENTUR_PDF_LIBREOFFICE"):
        kandidaten.append(os.environ["AGENTUR_PDF_LIBREOFFICE"])
    basis = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    kandidaten += [
        str(basis / "libreoffice" / "program" / "soffice.exe"),
        str(Path(sys.executable).parent / "libreoffice" / "program" / "soffice.exe"),
    ]
    for umgebung in ("PROGRAMFILES", "PROGRAMFILES(X86)"):
        if os.environ.get(umgebung):
            kandidaten.append(str(Path(os.environ[umgebung]) / "LibreOffice" / "program" / "soffice.exe"))
    for k in kandidaten:
        if k and os.path.isfile(k):
            return k
    return shutil.which("soffice") or shutil.which("libreoffice")


def office_zu_pdf(name: str, daten: bytes | None, pfad: str | None) -> bytes:
    programm = libreoffice_finden()
    if not programm:
        raise DokumentFehler(
            f"„{Path(name).name}“: Für Word-/Excel-Dateien wird das mitgelieferte LibreOffice benötigt – "
            "es wurde nicht gefunden. Bitte Ergo4You PDF neu installieren."
        )
    with tempfile.TemporaryDirectory(prefix="agentur-pdf-office-") as arbeit:
        arbeit_pfad = Path(arbeit)
        # Eigene Kopie mit einfachem Namen: vermeidet Probleme mit Sonderzeichen
        # und mit Dateien, die gerade in Word geöffnet (gesperrt) sind.
        eingabe = arbeit_pfad / f"eingabe{Path(name).suffix.lower()}"
        try:
            eingabe.write_bytes(daten if daten is not None else Path(pfad).read_bytes())  # type: ignore[arg-type]
        except OSError as fehler:
            raise DokumentFehler(f"„{Path(name).name}“ kann nicht gelesen werden: {fehler}") from fehler
        profil = (arbeit_pfad / "profil").as_uri()
        befehl = [
            programm,
            f"-env:UserInstallation={profil}",  # eigenes Profil: stört kein geöffnetes LibreOffice
            "--headless",
            "--norestore",
            "--nolockcheck",
            "--convert-to",
            "pdf",
            "--outdir",
            str(arbeit_pfad),
            str(eingabe),
        ]
        optionen: dict = {"capture_output": True, "timeout": LIBREOFFICE_ZEITLIMIT}
        if os.name == "nt":
            optionen["creationflags"] = 0x08000000  # CREATE_NO_WINDOW
        try:
            ergebnis = subprocess.run(befehl, **optionen)
        except subprocess.TimeoutExpired:
            raise DokumentFehler(f"„{Path(name).name}“: Umwandlung dauerte zu lange und wurde abgebrochen.") from None
        ausgabe = arbeit_pfad / "eingabe.pdf"
        if not ausgabe.is_file():
            meldung = (ergebnis.stderr or ergebnis.stdout or b"").decode(errors="replace").strip()[:300]
            raise DokumentFehler(f"„{Path(name).name}“ konnte nicht umgewandelt werden. {meldung}".strip())
        return ausgabe.read_bytes()
