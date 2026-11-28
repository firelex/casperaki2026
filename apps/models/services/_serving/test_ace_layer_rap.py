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
    return base(wav, takes=4, **over)


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


def test_takes_only_with_sections(wav):
    with pytest.raises(ValueError, match="only for sections"):
        ace.check_params(base(wav, takes=4))


def test_short_sections_are_repainted_on_eight_bars_with_their_lines_repeated():
    # 120 bpm: a bar is 2 s; 8 bars 16 s. A 4-bar section is made on 8 (owner 2026-11-28: the older lego way "was much
    # slower"), its lines repeated to fill them, turned so the section starts on its first line.
    assert ace.is_short(0, 8, 120) and not ace.is_short(0, 16, 120)
    assert ace.window_seconds(128) == pytest.approx(15.0)
    assert ace.section_window(69.375, 76.875, 180, ace.window_seconds(128)) == (69.375, 84.375)
    T = ace.RAP_TAGS + "\n"
    assert ace.rap_lyrics("a\nb\nc\nd", 8, 16, 0) == T + "\n".join("abcdabcd")
    assert ace.rap_lyrics("a\nb\nc\nd", 8, 16, 4) == T + "\n".join("cdabcdab")
    assert ace.rap_lyrics("a\nb", 16, 16, 0) == T + "a\nb"


def test_a_rap_running_past_its_section_is_cut_at_its_quietest_moment():
    import numpy as np
    sr = 1000
    t = np.arange(3 * sr) / sr
    v = np.stack([np.sin(2 * np.pi * 50 * t)] * 2).astype(np.float32)
    v[:, int(2.4 * sr):int(2.6 * sr)] = 0          # a pause 0.4-0.6 s before the end, then a word running out
    cut = ace.cut_at_quiet(v, sr)
    assert np.all(cut[:, int(2.45 * sr):] == 0)     # silent from the pause on
    assert np.allclose(cut[:, :int(2.3 * sr)], v[:, :int(2.3 * sr)])
    ended = v.copy()
    ended[:, int(2.9 * sr):] = 0                    # already quiet at its end: kept as it is
    assert np.array_equal(ace.cut_at_quiet(ended, sr), ended)


def test_the_rappers_voice_is_in_the_repo():
    assert ace.RAP_VOICE.is_file()


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
    # ACE's rap tags (docs/en/Tutorial.md: [spoken word] "Rap/recitation"), owner 2026-11-28 "It's not a rap. It's sung."
    assert ace.rap_lyrics(" a\n\nb ", 16, 16, 0) == "[Verse - rap]\n[spoken word]\n[high energy]\na\nb"
    with pytest.raises(ValueError, match="no lines"):
        ace.rap_lyrics(" \n ", 16, 16, 0)


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
