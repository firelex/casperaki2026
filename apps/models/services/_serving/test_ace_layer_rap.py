"""Tests for the ace-layer adapter's rap-per-section params (pure parts; no model). Run with svc-vocals' venv python
(it has pytest; acestep.constants is plain Python): vocals/.venv/bin/python -m pytest _serving/test_ace_layer_rap.py"""
import importlib.util
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "ace-step"))
_spec = importlib.util.spec_from_file_location("ace_layer", HERE / "adapters" / "ace-layer.py")
ace = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ace)


@pytest.fixture
def wav(tmp_path):
    p = tmp_path / "song.wav"
    p.write_bytes(b"RIFF")
    return str(p)


def base(wav, **over):
    return {"src_wav": wav, "track": "vocals", "caption": "rap", "bpm": 120, "key_scale": "C major", "seed": 7, **over}


def test_sections_are_checked_and_kept(wav):
    p = ace.check_params(base(wav, takes=4, sections=[
        {"name": "verse1", "start": 8, "end": 24, "lyrics": " one\ntwo "},
        {"name": "verse2", "start": 24, "end": 40, "lyrics": "three"},
    ]))
    assert p["takes"] == 4
    assert p["sections"][0] == {"name": "verse1", "start": 8.0, "end": 24.0, "lyrics": "one\ntwo"}
    assert "lyrics" not in p


@pytest.mark.parametrize("over, match", [
    ({"track": "guitar"}, "sung parts"),
    ({"lyrics": "x"}, "not in lyrics"),
    ({"takes": 0}, "takes"),
    ({"takes": None}, "takes"),
    ({"sections": []}, "non-empty"),
    ({"sections": [{"name": "v", "start": 4, "end": 2, "lyrics": "x"}]}, "before it starts"),
    ({"sections": [{"name": "v", "start": 0, "end": 2, "lyrics": " "}]}, "no words"),
    ({"sections": [{"name": "a", "start": 0, "end": 10, "lyrics": "x"}, {"name": "b", "start": 5, "end": 12, "lyrics": "y"}]}, "overlap"),
])
def test_bad_sections_fail_loud(wav, over, match):
    params = base(wav, takes=4, sections=[{"name": "v", "start": 0, "end": 16, "lyrics": "x"}])
    params.update(over)
    if params.get("takes") is None:
        params.pop("takes")
    with pytest.raises(ValueError, match=match):
        ace.check_params(params)


def test_takes_only_with_sections(wav):
    with pytest.raises(ValueError, match="only for sections"):
        ace.check_params(base(wav, takes=4))


def test_section_window_is_the_section_or_ten_seconds_of_song_around_it():
    assert ace.section_window(24, 40, 120) == (24, 40)
    assert ace.section_window(24, 31.5, 120) == (24, 34)       # short: more of the song after it
    assert ace.section_window(115, 120, 120) == (110, 120)     # at the end: more before it
    with pytest.raises(ValueError, match="after the song's end"):
        ace.section_window(110, 121, 120)
    with pytest.raises(ValueError, match="a section needs"):
        ace.section_window(0, 5, 8)


def test_rap_lyrics_puts_the_lines_under_one_verse_tag():
    assert ace.rap_lyrics(" a\nb ") == "[Verse]\na\nb"
