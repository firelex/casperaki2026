"""Checks of the lead stage's unit params and the lyric-line windows (no models)."""
import pytest

from pipeline import lead
from pipeline.transcribe import TranscribeError


def unit(**over):
    u = {"id": "verse1", "lead_in_chords": ["C"] * 8, "tail_chords": ["C"] * 8, "chords": ["C"] * 32,
         "notes": [{"start": s, "duration": 0.5, "midi": 60} for s in (0, 1, 2, 15.5, 16, 17)],
         "lyrics": ["a b c", "d e f"], "words": [["a", "b", "c"], ["d", "e", "f"]],
         "phonemes": [[["a"], ["b"], ["c"]], [["d"], ["e"], ["f"]]]}
    u.update(over)
    return u


def test_line_windows_follow_the_lines_first_notes():
    # line 2's first note (a pickup) is at beat 15.5; windows reach a beat past it either way
    # the last line may run into the 2 tail bars
    assert lead.line_windows(unit()) == [(0.0, 16.5), (14.5, 40.0)]


def test_one_note_per_syllable_is_required():
    with pytest.raises(ValueError, match="verse1: 5 notes for 6 syllables"):
        lead.check_units([unit(notes=unit()["notes"][:5])])


def test_words_and_phonemes_must_match():
    with pytest.raises(ValueError, match="verse1: words and phonemes differ"):
        lead.check_units([unit(phonemes=[[["a"], ["b"]], [["d"], ["e"], ["f"]]])])


def test_missing_param_is_named():
    with pytest.raises(ValueError, match="lead: missing param 'octave'"):
        lead.run({"bpm": 128, "key": "C", "seeds": 1, "threshold": 0.7, "units": [unit()]}, "/tmp", None)


class FakeJob:
    def __init__(self):
        self.steps = []

    def check_cancelled(self):
        pass

    def step(self, id, label):
        job = self

        class S:
            def done(self, text="", numbers=None, files=None):
                job.steps.append((id, "done", text, numbers or {}))

            def fail(self, text):
                job.steps.append((id, "failed", text, {}))

        return S()


def fake_transcriber(fails):
    tried = []

    def transcribe(seed):
        tried.append(seed)
        if seed in fails:
            raise TranscribeError(f"verse1: could not find the word 'me' in the take (seed {seed})")
        return [{"start": 0, "duration": 1, "midi": 60, "word": "a"}]

    return transcribe, tried


SCORES = {1: 0.8, 2: 1.0, 3: 0.9, 4: 0.5}


def test_the_best_take_that_transcribes_is_chosen():
    fn, tried = fake_transcriber(fails={2})
    job = FakeJob()
    seed, melody = lead.choose_take("verse1", SCORES, 0.7, fn, job)
    assert seed == 3 and tried == [2, 3] and len(melody) == 1
    assert [(i, st) for i, st, _, _ in job.steps] == [("transcribe:verse1:s2", "failed"), ("transcribe:verse1:s3", "done"),
                                                       ("choose:verse1", "done")]
    assert job.steps[-1][3] == {"seed": 3, "chords_match": 0.9, "syllables": 1}


def test_no_take_both_matching_and_transcribing():
    fn, tried = fake_transcriber(fails={1, 2, 3})
    job = FakeJob()
    with pytest.raises(lead.ChooseError) as e:
        lead.choose_take("verse1", SCORES, 0.7, fn, job)
    assert tried == [2, 3, 1]
    assert str(e.value) == (
        "verse1: no take both matches our chords and transcribes fully:\n"
        "seed 1: chords 80%, verse1: could not find the word 'me' in the take (seed 1)\n"
        "seed 2: chords 100%, verse1: could not find the word 'me' in the take (seed 2)\n"
        "seed 3: chords 90%, verse1: could not find the word 'me' in the take (seed 3)\n"
        "seed 4: chords 50%, below the 70% threshold")
    assert job.steps[-1][:2] == ("choose:verse1", "failed")


def test_tail_chords_are_required():
    u = unit()
    del u["tail_chords"]
    with pytest.raises(ValueError, match="unit 'verse1' is missing 'tail_chords'"):
        lead.check_units([u])
