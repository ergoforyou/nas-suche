from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastapi.testclient import TestClient  # noqa: E402

from agentur_pdf.api.app import erstelle_app  # noqa: E402
from agentur_pdf.benutzer.speicher import BenutzerSpeicher  # noqa: E402
from agentur_pdf.kern.dokumente import DokumentSpeicher  # noqa: E402
import testdaten  # noqa: E402

TOKEN = "test-token"


@pytest.fixture()
def brief(tmp_path: Path) -> Path:
    return testdaten.versicherungsbrief(tmp_path / "brief.pdf")


@pytest.fixture()
def speicher() -> DokumentSpeicher:
    s = DokumentSpeicher()
    yield s
    for d in s.alle():
        s.schliessen(d.id)


@pytest.fixture()
def client(tmp_path: Path) -> TestClient:
    app = erstelle_app(TOKEN, DokumentSpeicher(), BenutzerSpeicher(tmp_path / "benutzer"))
    c = TestClient(app)
    c.headers["X-Agentur-Token"] = TOKEN
    return c
