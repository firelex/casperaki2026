"""SoulX-Singer's score input built from a section's sung notes (pipeline.soulx.phrases): a phrase per 4-bar lyric
line, split at a rest of a beat or more, a short breath rest before each phrase, phonemes as SoulX writes them."""
import pytest

from pipeline import soulx

BPM = 120  # half a second a beat


def n(start, duration, midi, word="la", phonemes=("l", "aa1")):
    return {"start": start, "duration": duration, "midi": midi, "word": word, "phonemes": list(phonemes)}


def test_phrases_split_at_rests_and_lines():
    notes = [n(0, 1, 60), n(1, 1, 62), n(3, 1, 64),   # a rest of a beat: a new phrase at beat 3
             n(16, 2, 65)]                            # bar 5: a new 4-bar line
    ph = soulx.phrases(notes, BPM, 32, octave=12)
    assert len(ph) == 3
    a, b, c = ph
    assert a["phoneme"] == ["en_L-AA1", "en_L-AA1"] and a["pitch"] == [72, 74] and a["type"] == [2, 2]
    assert a["start"] == 0 and a["duration"] == [0.5, 0.5]
    assert b["phoneme"] == ["<SP>", "en_L-AA1"] and b["duration"] == pytest.approx([0.25, 0.5])
    assert b["start"] == pytest.approx(1.25)
    assert c["pitch"] == [0, 77] and c["start"] == pytest.approx(7.75)


def test_a_note_without_phonemes_is_an_error():
    with pytest.raises(ValueError, match="verse2: the note at beat 1 has no phonemes"):
        soulx.phrases([n(0, 1, 60), n(1, 1, 60, phonemes=())], BPM, 16, octave=0, section="verse2")


def test_a_note_ends_at_the_next_note_and_at_the_section_end():
    ph = soulx.phrases([n(0, 2, 60), n(1, 1, 60), n(15, 4, 60)], BPM, 16, octave=0)
    assert ph[0]["duration"] == pytest.approx([0.5, 0.5])
    assert ph[1]["duration"][-1] == pytest.approx(0.5)
