"""Checks of the lead stage's unit params and the lyric-line windows (no models)."""
import pytest

from pipeline import lead


def unit(**over):
    u = {"id": "verse1", "lead_in_chords": ["C"] * 8, "chords": ["C"] * 32,
         "notes": [{"start": s, "duration": 0.5, "midi": 60} for s in (0, 1, 2, 15.5, 16, 17)],
         "lyrics": ["a b c", "d e f"], "words": [["a", "b", "c"], ["d", "e", "f"]],
         "phonemes": [[["a"], ["b"], ["c"]], [["d"], ["e"], ["f"]]]}
    u.update(over)
    return u


def test_line_windows_follow_the_lines_first_notes():
    # line 2's first note (a pickup) is at beat 15.5; windows reach a beat past it either way
    assert lead.line_windows(unit()) == [(0.0, 16.5), (14.5, 32.0)]


def test_one_note_per_syllable_is_required():
    with pytest.raises(ValueError, match="verse1: 5 notes for 6 syllables"):
        lead.check_units([unit(notes=unit()["notes"][:5])])


def test_words_and_phonemes_must_match():
    with pytest.raises(ValueError, match="verse1: words and phonemes differ"):
        lead.check_units([unit(phonemes=[[["a"], ["b"]], [["d"], ["e"], ["f"]]])])


def test_missing_param_is_named():
    with pytest.raises(ValueError, match="lead: missing param 'octave'"):
        lead.run({"bpm": 128, "key": "C", "seeds": 1, "threshold": 0.7, "units": [unit()]}, "/tmp", None)
