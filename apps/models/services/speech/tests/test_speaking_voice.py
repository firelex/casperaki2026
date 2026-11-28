"""The speaking_voice stage checks its params before any model loads."""
import pytest

from pipeline import speaking_voice


@pytest.fixture
def ref(tmp_path):
    p = tmp_path / "voice.wav"
    p.write_bytes(b"RIFF")
    return str(p)


def params(ref, **kw):
    return {"stage": "speaking_voice", "reference": ref, "description": "A woman in her twenties.",
            "test_line": "Hi, I'm Karla.", "seeds": [7, 11], **kw}


@pytest.mark.parametrize("change, message", [
    ({"reference": "voice.wav"}, "absolute"),
    ({"reference": "/nowhere/voice.wav"}, "no reference"),
    ({"description": " "}, "description"),
    ({"test_line": ""}, "test line"),
    ({"seeds": []}, "seeds"),
    ({"seeds": [7, 7]}, "seeds"),
    ({"seeds": [7, "11"]}, "seeds"),
])
def test_refuses_bad_params(tmp_path, ref, change, message):
    with pytest.raises(ValueError, match=message):
        speaking_voice.run(params(ref, **change), str(tmp_path), None)
