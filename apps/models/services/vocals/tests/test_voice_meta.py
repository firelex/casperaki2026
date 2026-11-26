"""A new singer's voice description in SoulX-Singer's prompt format (pipeline.voice_meta): "la" or words, la notes,
the metadata built and checked."""
import numpy as np
import pytest

from pipeline import voice_meta


@pytest.mark.parametrize("words, la", [
    (["<SP>", "La", "la", "<SP>", "la", "la"], True),
    (["la", "la", "la", "love", "la"], True),  # 4 of 5
    (["Who", "says", "you're", "not", "pretty"], False),
    (["la", "la", "my", "heart"], False),  # 2 of 4
])
def test_la_or_words(words, la):
    assert voice_meta.is_la(words) is la


def test_no_words_heard_is_an_error():
    with pytest.raises(ValueError, match="No words were heard"):
        voice_meta.is_la(["<SP>"])


def test_la_notes_start_at_each_l_and_take_the_tuned_pitch():
    times = np.arange(0, 3, 0.01)
    midi = np.full(len(times), np.nan)
    midi[(times >= 0.5) & (times < 1.4)] = 60.3  # 30 cents sharp
    midi[(times >= 1.5) & (times < 2.5)] = 62.3
    sounding = ((times >= 0.45) & (times < 1.4)) | ((times >= 1.45) & (times < 2.5))
    notes = voice_meta.la_notes([0.45, 1.45], times, midi, sounding, 3.0)
    assert [n["midi"] for n in notes] == [60, 62]
    assert notes[0]["start"] == 0.45 and notes[0]["end"] == pytest.approx(1.4, abs=0.011)  # its sound stops before the next l
    assert notes[1]["end"] == pytest.approx(2.5, abs=0.011)


def test_a_note_without_pitch_is_an_error():
    times = np.arange(0, 2, 0.01)
    with pytest.raises(ValueError, match="No pitch"):
        voice_meta.la_notes([0.5], times, np.full(len(times), np.nan), np.ones(len(times), bool), 2.0)


def test_la_meta_covers_the_clip_with_rests_and_notes():
    clip = 3.0
    f0 = np.zeros(150)
    meta = voice_meta.la_meta([{"start": 0.3, "end": 1.2, "midi": 60}, {"start": 1.21, "end": 2.0, "midi": 62}], clip, f0, "x")
    assert meta["phoneme"].split() == ["<SP>", "en_L-AA1", "en_L-AA1", "<SP>"]
    assert meta["note_pitch"].split() == ["0", "60", "62", "0"]
    assert meta["note_type"].split() == ["1", "2", "2", "1"]
    assert [float(d) for d in meta["duration"].split()] == [0.3, 0.91, 0.79, 1.0]  # the 10 ms gap joined to the first note
    voice_meta.check_meta(meta, clip)


def test_words_meta_fits_the_notes_to_the_clip():
    notes = {"text": ["<SP>", "who", "says", "says", "<SP>"], "durations": [0.2, 0.5, 0.3, 0.4, 0.57],
             "pitches": [0, 64, 62, 60, 0], "types": [1, 2, 2, 3, 1],
             "phonemes": ["<SP>", "en_HH-UW1", "en_S-EH1-Z", "en_S-EH1-Z", "<SP>"]}
    meta = voice_meta.words_meta(notes, 2.0, np.zeros(100), "y")
    assert sum(float(d) for d in meta["duration"].split()) == pytest.approx(2.0)
    assert meta["text"] == "<SP> who says says <SP>"
    voice_meta.check_meta(meta, 2.0)
    with pytest.raises(ValueError, match="last"):
        voice_meta.words_meta({**notes, "durations": [0.2, 0.5, 0.3, 0.4, 1.0]}, 2.0, np.zeros(100), "y")


@pytest.mark.parametrize("change, message", [
    ({"note_pitch": "0 60 0"}, "items disagree"),
    ({"phoneme": "<SP> <SP>", "note_pitch": "0 0"}, "no sung note"),
    ({"note_pitch": "0 0"}, "no sung note with a pitch"),
    ({"duration": "0.5 0.5"}, "add up"),
    ({"f0": "0.0 0.0"}, "pitch curve"),
])
def test_bad_descriptions_are_errors(change, message):
    meta = {"index": "z", "language": "English", "time": [0, 2000], "duration": "1.00 1.00", "text": "<SP> la",
            "phoneme": "<SP> en_L-AA1", "note_pitch": "0 60", "note_type": "1 2", "f0": " ".join(["0.0"] * 100)}
    voice_meta.check_meta(meta, 2.0)
    with pytest.raises(ValueError, match=message):
        voice_meta.check_meta({**meta, **change}, 2.0)
