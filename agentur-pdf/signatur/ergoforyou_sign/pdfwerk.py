"""PDF-Arbeit für Ergoforyou Sign: prüfen, Seitenbilder, Unterschriften
einsetzen und das Prüfprotokoll als letzte Seite anhängen."""

from __future__ import annotations

import base64
import json
import re
from pathlib import Path

import pymupdf

from .auftraege import AuftragFehler, ortszeit

ARTEN = ("unterschrift", "datum", "name")
TINTE = (0.10, 0.17, 0.43)
GRAU = (0.42, 0.45, 0.5)
MARKE = (0.71, 0.07, 0.11)  # #B5121B
MAX_SEITEN = 200
MAX_FELDER = 60

EREIGNISSE = {
    "erstellt": "Zur Unterschrift bereitgestellt",
    "geoeffnet": "Link geöffnet",
    "code_ok": "Zugangscode bestätigt",
    "code_falsch": "Falscher Zugangscode",
    "gesperrt": "Gesperrt (zu viele Fehlversuche)",
    "entsperrt": "Wieder freigegeben",
    "unterschrieben": "Unterschrieben",
    "kopie": "Kopie heruntergeladen",
    "widerrufen": "Vom Büro zurückgezogen",
}


_ERSATZ = str.maketrans({"„": '"', "“": '"', "”": '"', "‚": "'", "‘": "'", "’": "'", "–": "-", "—": "-", "…": "...", "\u00a0": " "})


def latin(text: str) -> str:
    """Die eingebauten PDF-Schriften kennen nur Latin-1 – Rest ersetzen."""
    return "".join(z if ord(z) < 256 else "?" for z in str(text).translate(_ERSATZ))


# ---------------------------------------------------------------- Prüfen
def pruefen(pdf: bytes) -> list[dict]:
    """Seitenmaße (angezeigte Lage) – wirft AuftragFehler bei kaputter PDF."""
    try:
        doc = pymupdf.open("pdf", pdf)
    except Exception:
        raise AuftragFehler("Die Datei ist keine lesbare PDF.") from None
    with doc:
        if doc.needs_pass:
            raise AuftragFehler("Die PDF ist mit einem Kennwort geschützt.")
        if not 0 < doc.page_count <= MAX_SEITEN:
            raise AuftragFehler(f"Die PDF muss 1 bis {MAX_SEITEN} Seiten haben.")
        return [{"b": round(s.rect.width, 2), "h": round(s.rect.height, 2)} for s in doc]


def felder_pruefen(felder: list, seiten: list[dict]) -> list[dict]:
    """Felder vom PC übernehmen. Ohne Unterschriftsfeld unterschreibt der
    Kunde nur auf dem Prüfprotokoll („ende“)."""
    ergebnis = []
    for i, f in enumerate((felder or [])[:MAX_FELDER]):
        art = f.get("art")
        seite = f.get("seite")
        r = f.get("rechteck") or []
        if art not in ARTEN or not isinstance(seite, int) or not 0 <= seite < len(seiten):
            continue
        if len(r) != 4 or not all(isinstance(x, (int, float)) for x in r):
            continue
        r = [max(0.0, min(1.0, float(x))) for x in r]
        if r[2] - r[0] < 0.01 or r[3] - r[1] < 0.005:
            continue
        ergebnis.append(
            {
                "id": f"f{i + 1}",
                "seite": seite,
                "rechteck": [round(x, 5) for x in r],
                "art": art,
                "beschriftung": str(f.get("beschriftung") or "").strip()[:80],
                "pflicht": art == "unterschrift" and f.get("pflicht", True) is not False,
            }
        )
    if not any(f["art"] == "unterschrift" for f in ergebnis):
        ergebnis.append({"id": "ende", "seite": None, "rechteck": None, "art": "unterschrift", "beschriftung": "Unterschrift", "pflicht": True})
    return ergebnis


def seite_png(pdf_pfad: Path, cache: Path, nummer: int, breite: int) -> bytes:
    breite = max(400, min(2000, breite // 100 * 100))
    datei = cache / f"{nummer}-{breite}.png"
    if datei.exists():
        return datei.read_bytes()
    with pymupdf.open(pdf_pfad) as doc:
        if not 0 <= nummer < doc.page_count:
            raise AuftragFehler("Seite nicht vorhanden.", 404)
        seite = doc[nummer]
        zoom = breite / seite.rect.width
        png = seite.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False).tobytes("png")
    cache.mkdir(exist_ok=True)
    datei.write_bytes(png)
    return png


# --------------------------------------------------------- Unterschriften
def png_aus_dataurl(text: str) -> bytes:
    m = re.fullmatch(r"data:image/png;base64,([A-Za-z0-9+/=]+)", text or "")
    if not m:
        raise AuftragFehler("Die Unterschrift konnte nicht gelesen werden.")
    daten = base64.b64decode(m.group(1))
    if len(daten) > 1_500_000 or not daten.startswith(b"\x89PNG"):
        raise AuftragFehler("Die Unterschrift ist zu groß oder ungültig.")
    try:
        pix = pymupdf.Pixmap(daten)
    except Exception:
        raise AuftragFehler("Die Unterschrift konnte nicht gelesen werden.") from None
    if pix.width < 20 or pix.height < 10 or pix.width > 4000 or pix.height > 4000:
        raise AuftragFehler("Die Unterschrift ist zu klein oder zu groß.")
    return daten


def _pdf_rechteck(seite: pymupdf.Page, n: list[float]) -> pymupdf.Rect:
    b, h = seite.rect.width, seite.rect.height
    anzeige = pymupdf.Rect(n[0] * b, n[1] * h, n[2] * b, n[3] * h).normalize()
    return (anzeige * seite.derotation_matrix).normalize()


def _text(seite: pymupdf.Page, r: pymupdf.Rect, text: str, schrift: str = "helv", farbe=TINTE, max_groesse: float = 14) -> None:
    """Text einzeilig, passend in das (angezeigte) Rechteck ``r``."""
    text = latin(text)
    if not text:
        return
    # Maße in Leserichtung: bei 90/270° sind Breite und Höhe vertauscht
    quer = seite.rotation in (90, 270)
    breite, hoehe = (r.height, r.width) if quer else (r.width, r.height)
    groesse = min(max_groesse, hoehe * 0.72, (breite - 4) / max(1.0, pymupdf.get_text_length(text, schrift, 1)))
    groesse = max(4.0, groesse)
    # Grundlinienpunkt in Anzeige-Koordinaten bestimmen, dann zurückdrehen
    anzeige = r * seite.rotation_matrix
    anzeige.normalize()
    punkt = pymupdf.Point(anzeige.x0 + 2, anzeige.y0 + (anzeige.height + groesse * 0.7) / 2) * seite.derotation_matrix
    seite.insert_text(punkt, text, fontname=schrift, fontsize=groesse, color=farbe, rotate=seite.rotation)


def _unterschrift(seite: pymupdf.Page, r: pymupdf.Rect, eingabe: dict) -> None:
    if eingabe.get("png"):
        seite.insert_image(r, stream=eingabe["png"], keep_proportion=True, overlay=True, rotate=seite.rotation)
    else:
        _text(seite, r, eingabe.get("text", ""), schrift="tiit", max_groesse=28)


def ergebnis_erzeugen(original: bytes, a: dict, eingaben: dict) -> bytes:
    """``eingaben`` = {name, zeit, ip, geraet, unterschriften: {feld_id: {png|text}}}."""
    doc = pymupdf.open("pdf", original)
    zeit = ortszeit(eingaben["zeit"])
    for f in a["felder"]:
        if f["seite"] is None:
            continue
        seite = doc[f["seite"]]
        r = _pdf_rechteck(seite, f["rechteck"])
        if f["art"] == "unterschrift":
            u = eingaben["unterschriften"].get(f["id"])
            if not u:
                continue
            _unterschrift(seite, r, u)
            vermerk = f"Elektronisch unterschrieben · {zeit} · Nr. {a['id']}"
            anzeige = (r * seite.rotation_matrix).normalize()
            unter = pymupdf.Rect(anzeige.x0, anzeige.y1 + 1, anzeige.x1 + 120, anzeige.y1 + 7)
            if unter.y1 > seite.rect.height:
                unter = pymupdf.Rect(anzeige.x0, anzeige.y0 - 7, anzeige.x1 + 120, anzeige.y0 - 1)
            _text(seite, unter * seite.derotation_matrix, vermerk, farbe=GRAU, max_groesse=4.5)
        elif f["art"] == "datum":
            _text(seite, r, zeit[:10])
        elif f["art"] == "name":
            _text(seite, r, eingaben["name"])
    protokollseite(doc, a, eingaben)
    protokoll = {k: a[k] for k in ("id", "titel", "erstellt", "erstellt_von", "gueltig_bis", "sha_original", "verlauf")}
    protokoll["zugangscode"] = bool(a["code_hash"])
    protokoll["unterzeichner"] = {k: eingaben[k] for k in ("name", "zeit", "ip", "geraet")}
    doc.embfile_add("pruefprotokoll.json", json.dumps(protokoll, ensure_ascii=False, indent=2).encode(), desc="Prüfprotokoll Ergoforyou Sign")
    doc.set_metadata(
        {
            **(doc.metadata or {}),
            "title": a["titel"],
            "subject": f"Elektronisch unterschrieben von {eingaben['name']} am {zeit}",
            "keywords": f"Ergoforyou Sign; Auftrag {a['id']}",
            "producer": "Ergoforyou Sign",
        }
    )
    daten = doc.tobytes(garbage=3, deflate=True)
    doc.close()
    return daten


# ------------------------------------------------------------ Protokoll
def geraet_kurz(ua: str) -> str:
    ua = ua or ""
    system = next((n for m, n in (("iPhone", "iPhone"), ("iPad", "iPad"), ("Android", "Android"), ("Windows", "Windows"), ("Mac OS", "Mac"), ("Linux", "Linux")) if m in ua), "")
    browser = next((n for m, n in (("Edg/", "Edge"), ("SamsungBrowser", "Samsung Internet"), ("Firefox", "Firefox"), ("Chrome", "Chrome"), ("Safari", "Safari")) if m in ua), "")
    if not system and not browser:
        return ua[:40]
    return " auf ".join(x for x in (browser, system) if x)


def protokollseite(doc: pymupdf.Document, a: dict, eingaben: dict) -> None:
    seite = doc.new_page(width=595, height=842)
    links, rechts = 50, 545
    y = 60

    def zeile(text: str, groesse: float = 9.5, schrift: str = "helv", farbe=(0.1, 0.1, 0.12), x: float = links, abstand: float = 1.45) -> None:
        nonlocal y
        seite.insert_text((x, y), latin(text), fontname=schrift, fontsize=groesse, color=farbe)
        y += groesse * abstand

    def wert(titel: str, text: str, schrift: str = "helv", groesse: float = 9.5) -> None:
        nonlocal y
        seite.insert_text((links, y), titel, fontname="helv", fontsize=8.5, color=GRAU)
        breite = rechts - 160
        rest = latin(text)
        while rest:
            teil = rest
            while pymupdf.get_text_length(teil, schrift, groesse) > breite and len(teil) > 10:
                teil = teil[: int(len(teil) * 0.9)]
            seite.insert_text((160, y), teil, fontname=schrift, fontsize=groesse, color=(0.1, 0.1, 0.12))
            rest = rest[len(teil):]
            y += groesse * 1.45

    def ueberschrift(text: str) -> None:
        nonlocal y
        y += 8
        zeile(text, 11, "hebo", MARKE)
        seite.draw_line((links, y - 9), (rechts, y - 9), color=(0.85, 0.86, 0.88), width=0.6)
        y += 2

    seite.draw_rect(pymupdf.Rect(0, 0, 595, 8), color=None, fill=MARKE)
    zeile("Prüfprotokoll", 20, "hebo")
    zeile("Ergoforyou Sign · elektronische Unterschrift", 10, "helv", GRAU)
    y += 4

    ueberschrift("Dokument")
    wert("Titel", a["titel"])
    wert("Auftragsnummer", a["id"])
    wert("Seiten", f"{len(a['seiten'])} (zzgl. dieser Protokollseite)")
    wert("Bereitgestellt", f"{ortszeit(a['erstellt'])} von {a['erstellt_von'] or 'Ergoforyou'}")
    wert("Prüfsumme (SHA-256)", a["sha_original"], "cour", 8)
    wert("", "des unveränderten Originals vor der Unterschrift", groesse=7.5)

    ueberschrift("Unterschrieben von")
    wert("Name", eingaben["name"])
    if a["hubspot"].get("kontakt_name") or a["empfaenger"].get("email"):
        wert("Empfänger laut Büro", " · ".join(x for x in (a["hubspot"].get("kontakt_name"), a["empfaenger"].get("email")) if x))
    wert("Zeitpunkt", f"{ortszeit(eingaben['zeit'])} (Europe/Berlin)")
    wert("IP-Adresse", eingaben["ip"] or "–")
    wert("Gerät", geraet_kurz(eingaben["geraet"]))
    wert("Zugang", "Persönlicher, nicht erratbarer Link" + (" und Zugangscode" if a["code_hash"] else ""))
    wert("Bestätigung", "„Ich habe das Dokument gelesen und unterschreibe es elektronisch.“")

    erste = next((eingaben["unterschriften"][f["id"]] for f in a["felder"] if f["art"] == "unterschrift" and f["id"] in eingaben["unterschriften"]), None)
    if erste:
        y += 4
        kasten = pymupdf.Rect(160, y, 400, y + 70)
        seite.draw_rect(kasten, color=(0.8, 0.82, 0.85), width=0.6)
        seite.insert_text((links, y + 12), "Unterschrift", fontname="helv", fontsize=8.5, color=GRAU)
        _unterschrift(seite, kasten + (6, 6, -6, -6), erste)
        y += 84

    ueberschrift("Verlauf")
    eintraege = a["verlauf"][-22:]
    seite.insert_text((links, y), "Zeit", fontname="hebo", fontsize=8, color=GRAU)
    seite.insert_text((150, y), "Ereignis", fontname="hebo", fontsize=8, color=GRAU)
    seite.insert_text((330, y), "IP-Adresse", fontname="hebo", fontsize=8, color=GRAU)
    seite.insert_text((420, y), "Gerät", fontname="hebo", fontsize=8, color=GRAU)
    y += 13
    for e in eintraege:
        seite.insert_text((links, y), ortszeit(e["zeit"]), fontname="helv", fontsize=8)
        seite.insert_text((150, y), latin(EREIGNISSE.get(e["art"], e["art"]))[:38], fontname="helv", fontsize=8)
        seite.insert_text((330, y), e.get("ip", "")[:18], fontname="helv", fontsize=8)
        seite.insert_text((420, y), latin(geraet_kurz(e.get("geraet", "")))[:28], fontname="helv", fontsize=8)
        y += 12

    y = max(y + 10, 760)
    for text in (
        "Die Prüfsumme belegt, dass das Original zwischen Bereitstellung und Unterschrift nicht verändert wurde.",
        "Das vollständige Protokoll ist zusätzlich als Datei „pruefprotokoll.json“ in diese PDF eingebettet.",
        f"Erstellt durch Ergoforyou Sign · Auftrag {a['id']}",
    ):
        zeile(text, 7.5, "helv", GRAU)
