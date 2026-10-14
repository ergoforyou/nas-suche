"""Probelauf der gepackten Agentur-PDF.exe (im Build-Workflow).

Startet die .exe als Dienst, prüft, dass die MITGELIEFERTEN Bausteine
gefunden werden, und führt echte Abläufe aus: Texterkennung eines Scans,
Zusammenführen mit Word-Datei. Bricht mit Fehlercode ab, wenn etwas fehlt.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

HIER = Path(__file__).resolve().parent
sys.path[:0] = [str(HIER.parent / "dienst"), str(HIER.parent / "dienst" / "tests")]

import pymupdf  # noqa: E402

import scan_hilfen  # noqa: E402
import testdaten  # noqa: E402

EXE = Path(sys.argv[1]).resolve()
PORT = 8790
TOKEN = "probelauf"
BASIS = f"http://127.0.0.1:{PORT}"


def anfrage(methode: str, pfad: str, daten: dict | None = None):
    req = urllib.request.Request(
        BASIS + pfad,
        data=json.dumps(daten).encode() if daten is not None else None,
        headers={"X-Agentur-Token": TOKEN, "Content-Type": "application/json"},
        method=methode,
    )
    with urllib.request.urlopen(req, timeout=60) as a:
        return json.loads(a.read())


def warten_auf(auftrag_id: str, zeit: float = 300) -> dict:
    ende = time.time() + zeit
    while time.time() < ende:
        for a in anfrage("GET", "/api/auftraege"):
            if a["id"] == auftrag_id and a["status"] not in ("wartet", "laeuft"):
                return a
        time.sleep(0.5)
    raise SystemExit(f"Auftrag {auftrag_id} wurde nicht fertig")


def pruefen(bedingung: bool, text: str) -> None:
    print(("OK    " if bedingung else "FEHLER") + "  " + text, flush=True)
    if not bedingung:
        raise SystemExit(1)


def main() -> None:
    arbeit = Path(tempfile.mkdtemp(prefix="probelauf-"))
    umgebung = {k: v for k, v in os.environ.items() if not k.startswith(("AGENTUR_PDF_", "PROBELAUF_"))}
    umgebung["AGENTUR_PDF_DATEN"] = str(arbeit / "benutzer")
    prozess = subprocess.Popen([str(EXE), "--nur-dienst", "--port", str(PORT), "--token", TOKEN], env=umgebung)
    try:
        for _ in range(120):
            try:
                system = anfrage("GET", "/api/system")
                break
            except OSError:
                time.sleep(0.5)
        else:
            raise SystemExit("Dienst startet nicht – siehe protokoll.log")
        print(json.dumps(system, indent=2, ensure_ascii=False))
        with urllib.request.urlopen(BASIS + "/", timeout=30) as a:
            pruefen('id="root"' in a.read().decode(), "Oberfläche wird ausgeliefert")
        ordner = str(EXE.parent).lower()
        if os.environ.get("PROBELAUF_LOKAL"):  # Entwicklung: Systemprogramme statt mitgelieferter
            ordner = ""
        pruefen(bool(system["tesseract"]) and system["tesseract"].lower().startswith(ordner), "mitgelieferte Texterkennung gefunden")
        pruefen(system["beste_modelle"] or bool(os.environ.get("PROBELAUF_LOKAL")), "beste Erkennungsmodelle (tessdata_best) gefunden")
        pruefen(bool(system["libreoffice"]) and system["libreoffice"].lower().startswith(ordner), "mitgeliefertes LibreOffice gefunden")
        pruefen(system["woerterbuch"], "deutsches Wörterbuch gefunden")

        # Texterkennung eines Scans
        quelle = pymupdf.open(testdaten.versicherungsbrief(arbeit / "brief.pdf", seiten=2))
        scan_hilfen.als_scan(quelle, schraeg=1.5).save(arbeit / "scan.pdf")
        dok = anfrage("POST", "/api/dokumente/oeffnen", {"pfad": str(arbeit / "scan.pdf")})
        start = time.time()
        a = warten_auf(anfrage("POST", f"/api/dokumente/{dok['id']}/ocr", {})["id"])
        pruefen(a["status"] == "fertig", f"Texterkennung in {time.time() - start:.1f} s: {a.get('ergebnis', {}).get('ocr') or a.get('fehler')}")
        treffer = anfrage("GET", f"/api/dokumente/{dok['id']}/suche?q=Pr%C3%A4mie")
        pruefen(len(treffer) == 2, "Suche nach „Prämie“ findet beide Seiten")

        # Zusammenführen mit Word (LibreOffice)
        testdaten.word(arbeit / "anschreiben.docx", "Anschreiben an Familie Weiß")
        start = time.time()
        a = warten_auf(
            anfrage("POST", "/api/zusammenfuehren", {"eintraege": [{"pfad": str(arbeit / "brief.pdf")}, {"pfad": str(arbeit / "anschreiben.docx")}]})["id"]
        )
        pruefen(a["status"] == "fertig", f"PDF + Word zusammengeführt in {time.time() - start:.1f} s ({a.get('fehler', '')})")
        neu = a["ergebnis"]["dokumente"][0]
        pruefen(len(anfrage("GET", f"/api/dokumente/{neu}/suche?q=Wei%C3%9F")) == 1, "Word-Inhalt (mit ß) im Ergebnis gefunden")
        print("\nProbelauf erfolgreich.")
    finally:
        prozess.terminate()
        protokoll = arbeit / "benutzer" / "protokoll.log"
        if protokoll.exists():
            print("\n--- protokoll.log ---\n" + protokoll.read_text(encoding="utf-8", errors="replace")[-4000:])


if __name__ == "__main__":
    main()
