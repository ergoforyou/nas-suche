"""Updates über den NAS-Ordner."""

from __future__ import annotations

from fastapi.testclient import TestClient

from agentur_pdf import __version__
from agentur_pdf.api.app import erstelle_app
from agentur_pdf.benutzer.speicher import BenutzerSpeicher
from agentur_pdf.kern import update


def test_version_vergleich():
    assert update.version_tupel("0.7.0-test") == (0, 7, 0)
    assert update.version_tupel("1.2") == (1, 2, 0)
    assert update.version_tupel("0.10.0") > update.version_tupel("0.9.9")


def test_neueste_setup_datei(tmp_path):
    ordner = tmp_path / "Updates"
    ordner.mkdir()
    for name in ("Agentur-PDF-Setup-0.5.0.exe", "Agentur-PDF-Setup-0.10.1-test.exe", "Agentur-PDF-Setup-0.9.0.exe", "Notizen.txt", "Agentur-PDF-Setup-x.exe"):
        (ordner / name).write_bytes(b"MZ")
    r = update.suchen(ordner, "0.6.2-test")
    assert r["verfuegbar"] and r["version"] == "0.10.1" and r["pfad"].endswith("Agentur-PDF-Setup-0.10.1-test.exe")
    assert update.suchen(ordner, "0.10.1")["verfuegbar"] is False
    assert update.suchen(tmp_path / "fehlt", "0.1")["grund"] == "nicht_erreichbar"
    assert update.suchen(None, "0.1")["grund"] == "kein_ordner"


def test_update_api(tmp_path):
    benutzer = BenutzerSpeicher(tmp_path / "pc")
    c = TestClient(erstelle_app("t", benutzer=benutzer))
    c.headers.update({"X-Agentur-Token": "t"})
    assert c.get("/api/update").json()["grund"] == "kein_ordner"
    nas = tmp_path / "nas"
    (nas / "Updates").mkdir(parents=True)
    (nas / "Updates" / "Agentur-PDF-Setup-99.0.0.exe").write_bytes(b"MZ")
    c.put("/api/einstellungen", json={"gemeinsamer_ordner": str(nas)})
    r = c.get("/api/update").json()
    assert r["verfuegbar"] and r["version"] == "99.0.0" and r["aktuelle_version"] == __version__
    assert r["installierbar"] is False  # nicht im gepackten Windows-Programm
    assert c.post("/api/update/installieren").status_code == 400
