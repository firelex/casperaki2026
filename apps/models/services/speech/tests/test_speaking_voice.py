"""The speaking_voice stage checks its params before any model loads."""
import pytest

from pipeline import speaking_voice


@pytest.fixture
def ref(tmp_path):
    p = tmp_path / "voice.wav"
    p.write_bytes(b"RIFF")
    return str(p)


def params(ref, **kw):
    return {"stage": "speaking_voice", "singer": "Karla", "reference": ref, "description": "A woman in her twenties.",
            "test_line": "Hi, I'm Karla.", "seeds": [7, 11], "match": True, **kw}


@pytest.mark.parametrize("change, message", [
    ({"reference": "voice.wav"}, "absolute"),
    ({"reference": "/nowhere/voice.wav"}, "no reference"),
    ({"description": " "}, "description"),
    ({"test_line": ""}, "test line"),
    ({"seeds": []}, "seeds"),
    ({"seeds": [7, 7]}, "seeds"),
    ({"seeds": [7, "11"]}, "seeds"),
    ({"singer": ""}, "singer"),
    ({"match": "yes"}, "match"),
    ({"match": False}, "one seed"),
])
def test_refuses_bad_params(tmp_path, ref, change, message):
    with pytest.raises(ValueError, match=message):
        speaking_voice.run(params(ref, **change), str(tmp_path), None)


def _no_model(*_a, **_k):
    raise AssertionError("no model may load")


def test_a_silent_reference_fails_naming_the_singer_before_any_model_loads(tmp_path, monkeypatch):
    import numpy as np
    import soundfile as sf

    from pipeline import breeze, match

    monkeypatch.setattr(breeze, "Breeze", _no_model)
    monkeypatch.setattr(match, "SpeakerMatcher", _no_model)
    silent = tmp_path / "voice.wav"
    sf.write(silent, np.zeros(16000 * 5), 16000)
    with pytest.raises(ValueError, match="Karla's voice reference has 0.0 s of voice"):
        speaking_voice.run(params(str(silent)), str(tmp_path / "out"), None)


def test_a_described_voice_is_spoken_but_not_matched(tmp_path, monkeypatch):
    import numpy as np
    import soundfile as sf

    from pipeline import breeze, match

    class FakeBreeze:
        def speak(self, text, instruction, seed, out):
            out.parent.mkdir(parents=True, exist_ok=True)
            sf.write(out, 0.2 * np.sin(np.arange(24000 * 2) / 24000 * 2 * np.pi * 200), 24000)
            return out

        def close(self):
            pass

    monkeypatch.setattr(breeze, "Breeze", FakeBreeze)
    monkeypatch.setattr(match, "SpeakerMatcher", _no_model)
    out = tmp_path / "out"
    speaking_voice.run(params(_voice(tmp_path), seeds=[7], match=False), str(out), None)
    import json

    assert json.loads((out / "speaking_voice.json").read_text()) == {"best_seed": 7, "scores": {}, "sample": "candidate-7.wav"}


def _voice(tmp_path):
    import numpy as np
    import soundfile as sf

    p = tmp_path / "sung.wav"
    sf.write(p, 0.2 * np.sin(np.arange(16000 * 3) / 16000 * 2 * np.pi * 220), 16000)
    return str(p)
