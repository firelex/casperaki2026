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


def rap(wav, **over):
    return base(wav, takes=4, lego_caption="rap, a cappella", **over)


def test_sections_are_checked_and_kept(wav):
    p = ace.check_params(rap(wav, sections=[
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
    ({"lego_caption": " "}, "lego_caption"),
    ({"sections": [{"name": "v", "start": 4, "end": 2, "lyrics": "x"}]}, "before it starts"),
    ({"sections": [{"name": "v", "start": 0, "end": 2, "lyrics": " "}]}, "no words"),
    ({"sections": [{"name": "a", "start": 0, "end": 10, "lyrics": "x"}, {"name": "b", "start": 5, "end": 12, "lyrics": "y"}]}, "overlap"),
])
def test_bad_sections_fail_loud(wav, over, match):
    params = rap(wav, sections=[{"name": "v", "start": 0, "end": 16, "lyrics": "x"}])
    params.update(over)
    if params.get("takes") is None:
        params.pop("takes")
    with pytest.raises(ValueError, match=match):
        ace.check_params(params)


def test_takes_and_lego_caption_only_with_sections(wav):
    with pytest.raises(ValueError, match="only for sections"):
        ace.check_params(base(wav, takes=4))
    with pytest.raises(ValueError, match="only for sections"):
        ace.check_params(base(wav, lego_caption="x"))


def test_short_sections_are_made_by_lego_on_eight_bars_with_their_lines_repeated():
    # 120 bpm: a bar is 2 s, a line 4 s; 8 bars 16 s.
    assert ace.is_short(0, 8, 120) and not ace.is_short(0, 16, 120)
    assert ace.window_seconds(128) == pytest.approx(15.0)
    assert ace.section_window(69.375, 76.875, 180, ace.window_seconds(128)) == (69.375, 84.375)
    assert ace.lego_rap_lyrics("a\n\nb", 16, 120) == "[Verse]\na\nb\na\nb"
    assert ace.lego_rap_lyrics("a\nb\nc", 16, 120, lead=4) == "[Verse]\nc\na\nb\nc"


def test_section_window_is_the_section_or_ten_seconds_of_song_around_it():
    assert ace.section_window(24, 40, 120) == (24, 40)
    assert ace.section_window(24, 31.5, 120) == (24, 34)       # short: more of the song after it
    assert ace.section_window(115, 120, 120) == (110, 120)     # at the end: more before it
    with pytest.raises(ValueError, match="after the song's end"):
        ace.section_window(110, 121, 120)
    with pytest.raises(ValueError, match="a section needs"):
        ace.section_window(0, 5, 8)


def test_a_section_is_repainted_with_four_bars_of_song_either_side():
    # 120 bpm: a bar is 2 s.
    assert ace.rap_window(24, 40, 120, 120) == (16, 48)
    assert ace.rap_window(4, 20, 120, 120) == (0, 28)          # the song's start
    assert ace.rap_window(104, 120, 120, 120) == (96, 120)     # the song's end
    with pytest.raises(ValueError, match="after the song's end"):
        ace.rap_window(110, 121, 120, 120)


def test_rap_lyrics_are_the_sections_lines_once():
    assert ace.rap_lyrics(" a\n\nb ") == "[Verse]\na\nb"
    with pytest.raises(ValueError, match="no lines"):
        ace.rap_lyrics(" \n ")


def test_rank_is_words_then_separation():
    a = {"recall": 0.8, "vocal_db": -20.0, "backing_db": -30.0}
    b = {"recall": 0.8, "vocal_db": -22.0, "backing_db": -50.0}
    assert ace.rank(b) > ace.rank(a)
    assert ace.rank({"recall": 0.9, "vocal_db": None, "backing_db": -20.0}) > ace.rank(a)


def test_sections_are_timed_at_the_songs_exact_tempo(wav):
    # 128.4 bpm: 8 bars are 14.95 s; ACE takes a whole bpm (128), the section timing keeps the exact one.
    p = ace.check_params(rap(wav, bpm=128.4, sections=[{"name": "v", "start": 0, "end": 8 * 240 / 128.4, "lyrics": "x"}]))
    assert p["bpm"] == 128 and p["tempo"] == 128.4
    assert not ace.is_short(0, 8 * 240 / 128.4, p["tempo"])
