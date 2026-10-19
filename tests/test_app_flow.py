"""Ende-zu-Ende-Ablauf ohne Mikrofon, Tastatur und Netz (alles simuliert)."""

from concurrent.futures import Future

import numpy as np
import pytest

from diktierflow import app as app_mod
from diktierflow.config import Config
from diktierflow.postprocess import PostProcessError


class FakeUI:
    def __init__(self, choice=None):
        self.calls, self.choice = [], choice

    def __getattr__(self, name):
        def record(*args):
            self.calls.append((name, args))
            if name == "choose_variant":
                pending = args[1]
                pending.result(timeout=5)
                return self.choice
            return None
        return record


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setenv("DIKTIERFLOW_HOME", str(tmp_path))
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    pasted = []
    monkeypatch.setattr(app_mod.textio, "paste_text",
                        lambda text, **kw: pasted.append(text))
    monkeypatch.setattr(app_mod.textio, "focus_window", lambda hwnd: None)
    cfg = Config.load()
    cfg.anthropic_api_key = "test"
    cfg.save_audio = False
    ui = FakeUI()
    a = app_mod.DiktierApp(cfg, ui)
    a.refresh_learning()
    yield a, ui, pasted
    a.shutdown()


def _done(value):
    f = Future()
    f.set_result(value)
    return f


def _session(mode="dictate", app="outlook.exe", chunks=("ergo vor ju hat angerufen",)):
    s = app_mod.Session(mode=mode, app=app, window_title="Mail", hwnd=None)
    for i, text in enumerate(chunks):
        s.chunks[i] = _done((text, "cloud"))
    return s


AUDIO = np.full(16000, 0.1, np.float32)


def test_dictation_applies_learned_corrections_and_style(setup, monkeypatch):
    a, ui, pasted = setup
    a.storage.record_correction("ergo vor ju", "ErgoForYou", source="manual", confirm=True)
    a.refresh_learning()
    seen = {}

    def fake_clean(text, style, glossary, snippets):
        seen.update(text=text, style=style, glossary=glossary)
        return "ErgoForYou hat angerufen."
    monkeypatch.setattr(a.post, "clean", fake_clean)

    a._finish_inner(_session(), AUDIO)

    assert seen["text"] == "ErgoForYou hat angerufen"          # vor Claude korrigiert
    assert seen["style"] == "formal"                           # Outlook-Profil
    assert "ErgoForYou" in seen["glossary"]
    assert pasted == ["ErgoForYou hat angerufen. "]
    d = a.storage.last_dictation()
    assert d.raw_text == "ergo vor ju hat angerufen" and d.app == "outlook.exe"


def test_long_dictation_chunks_joined_in_order(setup, monkeypatch):
    a, _, pasted = setup
    monkeypatch.setattr(a.post, "clean", lambda t, *_: t)
    a._finish_inner(_session(chunks=("teil eins", "teil zwei", "teil drei")), AUDIO)
    assert pasted == ["teil eins teil zwei teil drei "]


def test_offline_fallback_when_claude_fails(setup, monkeypatch):
    a, ui, pasted = setup

    def boom(*_a, **_k):
        raise PostProcessError("Claude nicht erreichbar (offline?)")
    monkeypatch.setattr(a.post, "clean", boom)
    a._finish_inner(_session(chunks=("äh das ist ein test",)), AUDIO)
    assert pasted == ["Das ist ein test. "]
    assert any(n == "toast" for n, _ in ui.calls)


def test_variants_choice_is_inserted(setup, monkeypatch):
    a, ui, pasted = setup
    ui.choice = "Professionelle Fassung."
    monkeypatch.setattr(a.post, "variants", lambda t, labels, g: ["A", "B", "C"])
    a._finish_inner(_session(mode="variants"), AUDIO)
    assert pasted == ["Professionelle Fassung. "]
    d = a.storage.last_dictation()
    assert [v["text"] for v in d.variants] == ["A", "B", "C"]


def test_variants_cancel_keeps_history(setup, monkeypatch):
    a, ui, pasted = setup
    ui.choice = None
    monkeypatch.setattr(a.post, "variants", lambda t, labels, g: ["A", "B", "C"])
    a._finish_inner(_session(mode="variants"), AUDIO)
    assert pasted == []
    assert a.storage.last_dictation() is not None


def test_learning_from_field_edit(setup):
    a, ui, _ = setup
    a.cfg.learn_threshold = 2
    did = a.storage.add_dictation(raw_text="x", final_text="Gespräch mit Herrn Maier.")
    field = "Hallo,\nGespräch mit Herrn Meyer.\nGruß"
    a._on_field_text(did, "Gespräch mit Herrn Maier.", field)
    assert a._corrections == []                                  # einmal gesehen
    assert a.storage.get_dictation(did).edited_text == "Gespräch mit Herrn Meyer."
    a._on_field_text(did, "Gespräch mit Herrn Maier.", field)
    assert a._corrections == [("Maier", "Meyer")]                # jetzt aktiv
    assert any(n == "toast" and "Meyer" in args[0] for n, args in ui.calls)


def test_privacy_mode_skips_claude(setup, monkeypatch):
    a, _, pasted = setup
    a.cfg.privacy_mode = True
    monkeypatch.setattr(a.post, "clean", lambda *_: pytest.fail("Claude darf nicht laufen"))
    a._finish_inner(_session(chunks=("ähm hallo welt",)), AUDIO)
    assert pasted == ["Hallo welt. "]
