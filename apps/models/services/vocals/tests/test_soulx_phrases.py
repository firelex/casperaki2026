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
    ph = soulx.phrases(notes, BPM, 32)
    assert len(ph) == 3
    a, b, c = ph
    assert a["phoneme"] == ["en_L-AA1", "en_L-AA1"] and a["pitch"] == [60, 62] and a["type"] == [2, 2]
    # Each phrase's last note runs into the rest after it (CODA_BEATS), keeping BREATH_BEATS before the next phrase.
    assert a["start"] == 0 and a["duration"] == pytest.approx([0.5, 0.75])
    assert b["phoneme"] == ["<SP>", "en_L-AA1"] and b["duration"] == pytest.approx([0.25, 1.0])
    assert b["start"] == pytest.approx(1.25)
    assert c["pitch"] == [0, 65] and c["start"] == pytest.approx(7.75)


def test_a_note_without_phonemes_is_an_error():
    with pytest.raises(ValueError, match="verse2: the note at beat 1 has no phonemes"):
        soulx.phrases([n(0, 1, 60), n(1, 1, 60, phonemes=())], BPM, 16, section="verse2")


def test_a_note_ends_at_the_next_note_and_at_the_section_end():
    ph = soulx.phrases([n(0, 2, 60), n(1, 1, 60), n(15, 4, 60)], BPM, 16)
    assert ph[0]["duration"] == pytest.approx([0.5, 1.0])  # the phrase's last note: one beat into the rest
    assert ph[1]["duration"][-1] == pytest.approx(0.5)  # no room before the section's end: cut there


def test_a_phrase_last_note_is_sung_into_the_rest_after_it():
    """Up to CODA_BEATS longer, keeping BREATH_BEATS before the next phrase (final consonants need the room)."""
    # The next phrase 1.25 beats after the note's end: 0.75 beat of it is used.
    ph = soulx.phrases([n(0, 1, 60), n(2.25, 1, 62)], BPM, 16)
    assert ph[0]["duration"] == pytest.approx([(1 + 0.75) * 0.5])
    # A long rest: one beat more, no more.
    ph = soulx.phrases([n(0, 1, 60), n(8, 1, 62)], BPM, 16)
    assert ph[0]["duration"] == pytest.approx([2 * 0.5])
    # A rest that short does not split phrases: the note is simply sung up to the next one (legato).
    ph = soulx.phrases([n(0, 1, 60), n(1.4, 1, 62)], BPM, 16)
    assert ph[0]["duration"][0] == pytest.approx(1.4 * 0.5) and "<SP>" not in ph[0]["phoneme"]


def test_a_phrase_final_s_or_z_is_sung_as_its_own_short_s():
    """ "walls" (w ao1 l z) ending a phrase: the word without its "z", then SIBILANT_S of "s" at the same pitch, at the
    end of the (extended) note. Inside a phrase, a word keeps its final consonant."""
    notes = [n(0, 1, 60, "walls", ("w", "ao1", "l", "z")), n(1, 1, 62, "is", ("ih1", "z")), n(2, 1, 64, "walls", ("w", "ao1", "l", "z"))]
    ph = soulx.phrases(notes, BPM, 16)
    assert len(ph) == 1
    p = ph[0]
    assert p["phoneme"] == ["en_W-AO1-L-Z", "en_IH1-Z", "en_W-AO1-L", "en_S"]
    assert p["pitch"] == [60, 62, 64, 64]
    # The last note: one beat into the rest (CODA_BEATS), its last SIBILANT_S the "s".
    assert p["duration"][2] == pytest.approx(2 * 0.5 - soulx.SIBILANT_S)
    assert p["duration"][3] == pytest.approx(soulx.SIBILANT_S)


def test_inside_a_phrase_every_note_is_sung_up_to_the_next():
    """Marigold Static's chorus rhythm: "Ma-" (1 beat), half a beat of rest, "ri-" (half), "gold" (1): no gap inside."""
    notes = [n(0, 1, 60, "ma", ("m", "aa1")), n(1.5, 0.5, 62, "ri", ("r", "ih0")), n(2, 1, 64, "gold", ("g", "ow1", "l", "d"))]
    p = soulx.phrases(notes, BPM, 16)[0]
    assert "<SP>" not in p["phoneme"]
    assert p["duration"][:2] == pytest.approx([1.5 * 0.5, 0.5 * 0.5])
