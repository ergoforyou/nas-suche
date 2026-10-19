import json
from types import SimpleNamespace

import numpy as np
import pytest

from diktierflow import postprocess
from diktierflow.audio import ChunkSegmenter, load_wav, save_wav
from diktierflow.config import Config
from diktierflow.hotkey import PressLogic, parse_combo
from diktierflow.storage import Storage
from diktierflow.stt import clean_transcript


# ------------------------------------------------------------------ Storage
@pytest.fixture
def storage(tmp_path):
    s = Storage(tmp_path / "t.db")
    yield s
    s.close()


def test_dictation_roundtrip_and_search(storage):
    i = storage.add_dictation(raw_text="äh hallo", final_text="Hallo.", app="outlook.exe",
                              variants=[{"label": "A", "text": "Hallo!"}])
    storage.add_dictation(raw_text="x", final_text="Anderes")
    storage.update_dictation(i, edited_text="Hallo zusammen.")
    d = storage.get_dictation(i)
    assert d.best_text == "Hallo zusammen."
    assert d.variants[0]["text"] == "Hallo!"
    assert [x.id for x in storage.list_dictations("zusammen")] == [i]
    assert storage.last_dictation().final_text == "Anderes"


def test_corrections_threshold(storage):
    storage.record_correction("Maier", "Meyer")
    assert storage.active_corrections(2) == []
    c = storage.record_correction("Maier", "Meyer")
    assert c.count == 2
    assert [x.right for x in storage.active_corrections(2)] == ["Meyer"]
    storage.record_correction("ergo", "ErgoForYou", source="manual", confirm=True)
    assert len(storage.active_corrections(5)) == 1


def test_vocab_and_snippets(storage):
    storage.add_term("ErgoForYou")
    storage.add_term("ErgoForYou")
    assert storage.list_terms() == ["ErgoForYou"]
    storage.set_snippet("Signatur", "Viele Grüße\nJens")
    storage.set_snippet("Signatur", "Beste Grüße\nJens")
    assert storage.snippets() == {"Signatur": "Beste Grüße\nJens"}


# ------------------------------------------------------------------ Config
def test_config_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setenv("DIKTIERFLOW_HOME", str(tmp_path))
    cfg = Config.load()
    assert cfg.hotkey_dictate == "ctrl+win+space"
    cfg.learn_threshold = 3
    cfg.save()
    assert Config.load().learn_threshold == 3
    assert cfg.style_for_app("OUTLOOK.EXE") == "formal"
    assert cfg.style_for_app("unbekannt.exe") == cfg.default_style
    monkeypatch.setenv("ANTHROPIC_API_KEY", "env-key")
    assert cfg.get_anthropic_key() == "env-key"


# ------------------------------------------------------------------ Hotkeys
def test_parse_combo():
    c = parse_combo("Strg+Win+Leertaste")
    assert c.modifiers == frozenset({"ctrl", "win"}) and c.key == "space" and c.vk == 0x20
    with pytest.raises(ValueError):
        parse_combo("ctrl+win")


class FakeRec:
    def __init__(self):
        self.on = False
        self.events = []

    def start(self):
        self.on = True
        self.events.append("start")

    def stop(self):
        self.on = False
        self.events.append("stop")


def _logic(mode, rec, clock):
    return PressLogic(mode, 0.45, rec.start, rec.stop, lambda: rec.on, clock=lambda: clock[0])


def test_auto_mode_tap_is_handsfree_hold_is_ptt():
    rec, clock = FakeRec(), [0.0]
    logic = _logic("auto", rec, clock)
    logic.press(); clock[0] = 0.1; logic.release()          # tippen
    assert rec.on                                           # Freihand läuft
    clock[0] = 30; logic.press(); clock[0] = 30.1; logic.release()
    assert not rec.on and rec.events == ["start", "stop"]
    clock[0] = 40; logic.press(); clock[0] = 42; logic.release()   # halten
    assert not rec.on and rec.events[-2:] == ["start", "stop"]


def test_hold_and_toggle_modes():
    rec, clock = FakeRec(), [0.0]
    logic = _logic("hold", rec, clock)
    logic.press(); clock[0] = 0.1; logic.release()
    assert not rec.on
    rec2 = FakeRec()
    logic2 = _logic("toggle", rec2, clock)
    logic2.press(); clock[0] = 5; logic2.release()
    assert rec2.on


# ------------------------------------------------------------------ Audio
def test_segmenter_cuts_at_pause():
    sr = 1000
    seg = ChunkSegmenter(sr, min_s=1.0, max_s=5.0, silence_threshold=0.01, pause_s=0.2)
    loud, quiet = np.full(100, 0.1, np.float32), np.zeros(100, np.float32)
    out = [seg.feed(loud) for _ in range(12)]
    assert all(o is None for o in out)
    assert seg.feed(quiet) is None
    chunk = seg.feed(quiet)
    assert chunk is not None and len(chunk) == 1400


def test_segmenter_max_length():
    seg = ChunkSegmenter(1000, min_s=1.0, max_s=2.0, silence_threshold=0.01)
    chunks = [seg.feed(np.full(100, 0.1, np.float32)) for _ in range(20)]
    assert sum(c is not None for c in chunks) == 1


def test_wav_roundtrip(tmp_path):
    x = np.sin(np.linspace(0, 100, 16000)).astype(np.float32) * 0.5
    save_wav(tmp_path / "a.wav", x, 16000)
    y, rate = load_wav(tmp_path / "a.wav")
    assert rate == 16000 and np.allclose(x, y, atol=1e-3)


# ------------------------------------------------------------------ Texte
def test_hallucination_filter():
    assert clean_transcript("Untertitel im Auftrag des ZDF, 2021") == ""
    assert clean_transcript("  Hallo   Welt ") == "Hallo Welt"


def test_basic_cleanup():
    out = postprocess.basic_cleanup("äh ich ich wollte ähm sagen neuer absatz das passt")
    assert out == "Ich wollte sagen\n\nDas passt."


def test_expand_snippets():
    out = postprocess.expand_snippets("Danke!\n{{baustein:signatur}}", {"Signatur": "Jens"})
    assert out == "Danke!\nJens"


# ----------------------------------------------- Claude-Anbindung (simuliert)
class FakeMessages:
    def __init__(self, text, stop_reason="end_turn"):
        self.text, self.stop_reason, self.calls = text, stop_reason, []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(stop_reason=self.stop_reason,
                               content=[SimpleNamespace(type="text", text=self.text)])


def _pp(text, stop_reason="end_turn"):
    pp = postprocess.PostProcessor("key", "claude-opus-5-5")
    fake = FakeMessages(text, stop_reason)
    pp._client = SimpleNamespace(beta=SimpleNamespace(messages=fake))
    return pp, fake


def test_clean_request_shape():
    pp, fake = _pp("Hallo Welt. {{baustein:Signatur}}")
    out = pp.clean("hallo welt", "formal", ["ErgoForYou"], {"Signatur": "Gruß Jens"})
    assert out == "Hallo Welt. Gruß Jens"
    call = fake.calls[0]
    assert call["model"] == "claude-opus-5-5"
    assert call["fallbacks"] == "default"
    assert call["betas"] == ["server-side-fallback-2026-07-01"]
    assert call["output_config"] == {"effort": "low"}
    assert "<diktat>\nhallo welt\n</diktat>" in call["messages"][0]["content"]
    assert "ErgoForYou" in call["messages"][0]["content"]


def test_variants_parse():
    pp, fake = _pp(json.dumps({"variants": ["a", "b", "c"]}))
    assert pp.variants("x", ["A", "B", "C"]) == ["a", "b", "c"]
    assert fake.calls[0]["output_config"]["format"]["type"] == "json_schema"


def test_refusal_raises():
    pp, _ = _pp("", stop_reason="refusal")
    with pytest.raises(postprocess.PostProcessError):
        pp.clean("x", "clean")


def test_haiku_has_no_fallback():
    pp = postprocess.PostProcessor("key", "claude-haiku-5-5")
    fake = FakeMessages("ok")
    pp._client = SimpleNamespace(beta=SimpleNamespace(messages=fake))
    pp.clean("x", "clean")
    assert "fallbacks" not in fake.calls[0]
