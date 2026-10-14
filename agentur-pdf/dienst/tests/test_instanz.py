"""Einzelinstanz: Explorer startet bei Mehrfachauswahl je Datei einen Prozess –
alle Dateien müssen in der einen laufenden Instanz in EINEM Dialog landen."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import pytest

DIENST = Path(__file__).resolve().parents[1]


def _start(datenordner: Path, *args: str) -> subprocess.Popen:
    umgebung = {**os.environ, "AGENTUR_PDF_DATEN": str(datenordner), "BROWSER": "true", "PYTHONPATH": str(DIENST)}
    return subprocess.Popen([sys.executable, "-m", "agentur_pdf", "--browser", *args], env=umgebung,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)


def _ereignisse(datenordner: Path) -> list[dict]:
    daten = json.loads((datenordner / "instanz.json").read_text())
    anfrage = urllib.request.Request(f"http://127.0.0.1:{daten['port']}/api/ereignisse", headers={"X-Agentur-Token": daten["token"]})
    with urllib.request.urlopen(anfrage, timeout=5) as a:
        return json.loads(a.read())["ereignisse"]


@pytest.mark.skipif(sys.platform == "win32", reason="Prozesssteuerung im Test nur unter Linux geprüft")
def test_explorer_mehrfachauswahl_landet_in_einer_instanz(tmp_path, brief):
    daten = tmp_path / "benutzer"
    dateien = []
    for i in range(3):
        p = tmp_path / f"datei{i}.pdf"
        p.write_bytes(brief.read_bytes())
        dateien.append(str(p))
    # Alle drei Prozesse gleichzeitig – wie der Explorer
    prozesse = [_start(daten, "--zusammenfuehren", d) for d in dateien]
    try:
        ende = time.time() + 20
        while time.time() < ende and sum(p.poll() is None for p in prozesse) > 1:
            time.sleep(0.1)
        laufend = [p for p in prozesse if p.poll() is None]
        assert len(laufend) == 1, "genau eine Instanz darf weiterlaufen"
        assert all(p.returncode == 0 for p in prozesse if p not in laufend)
        time.sleep(1.2)  # Sammelzeit
        gesammelt = [e for e in _ereignisse(daten) if e["art"] == "zusammenfuehren"]
        assert len(gesammelt) == 1
        assert gesammelt[0]["dateien"] == sorted(dateien)
        # Späterer Doppelklick auf eine PDF öffnet sie in derselben Instanz
        nachzuegler = _start(daten, dateien[0])
        assert nachzuegler.wait(10) == 0
        assert any(e["art"] == "oeffnen" for e in _ereignisse(daten))
    finally:
        for p in prozesse:
            p.terminate()
            try:
                p.wait(5)
            except subprocess.TimeoutExpired:
                p.kill()
    assert not (daten / "instanz.json").exists(), "Instanz meldet sich beim Beenden ab"
