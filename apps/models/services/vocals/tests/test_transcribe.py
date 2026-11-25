"""Transcribing a sung take to one note per syllable of our words (forced alignment for starts, SwiftF0 for pitch).

The aligner is a stub here (the MMS aligner needs speech; the GPU smoke runs it on real takes): it reports each
syllable's start a few ms after the synthetic note's onset, as a forced aligner reports a sung syllable's first sound.
"""
import numpy as np
import pytest

from pipeline import align, transcribe

SR = 44100
BPM = 120  # a 16th is 0.125 s
S16 = 0.125
# (start_16th, length_16ths, sung midi) for the syllables of WORDS
NOTES = [(0, 2, 69), (2, 2, 72), (6, 4, 74), (12, 1, 76), (13, 3, 71), (20, 6, 67)]
WORDS = [["Hel-", "lo"], ["sun-", "shine"], ["to-", "day"]]


def synth(notes, total_16ths=32, s16=S16):
    t = np.arange(int(total_16ths * s16 * SR)) / SR
    y = np.zeros_like(t)
    for s, n, m in notes:
        a, b = int(s * s16 * SR), int((s + n) * s16 * SR) - int(0.02 * SR)  # a short gap before the next note
        f = 440 * 2 ** ((m - 69) / 12)
        y[a:b] = 0.3 * np.sin(2 * np.pi * f * t[a:b])
        ramp = int(0.005 * SR)
        y[a:a + ramp] *= np.linspace(0, 1, ramp)
        y[b - ramp:b] *= np.linspace(1, 0, ramp)
    return np.stack([y, y])


class StubAligner:
    """Returns (start_s, end_s) per syllable, line by line: the given onsets plus 15 ms (each inside its window)."""

    def __init__(self, starts_s):
        self.starts_s = list(starts_s)
        self.calls = []

    def __call__(self, wave16k, texts, start_s, end_s):
        self.calls.append((list(texts), round(start_s, 3), round(end_s, 3)))
        got, self.starts_s = self.starts_s[:len(texts)], self.starts_s[len(texts):]
        if len(got) != len(texts):
            raise AssertionError(f"{len(texts)} syllables, stub has {len(got)} left")
        for t in got:
            assert start_s <= t + 0.015 < end_s, (t, start_s, end_s)
        return [(t + 0.015, t + 0.1) for t in got]


@pytest.fixture(scope="module")
def tracker():
    return transcribe.PitchTracker()


LINES = [(0, 1.5), (1.5, 3.25), (3.25, 8)]  # beats of each line of WORDS


def run(notes, words, starts_s, tracker, octave=12, bpm=BPM, lines=LINES):
    aligner = StubAligner(starts_s)
    out = transcribe.syllable_notes(synth(notes, s16=15 / bpm), SR, words, bpm, key="C", octave=octave, section="verse1",
                                    aligner=aligner, tracker=tracker, line_beats=lines)
    return out, aligner


def test_one_note_per_syllable(tracker):
    out, aligner = run(NOTES, WORDS, [s * S16 for s, _, _ in NOTES], tracker)
    assert aligner.calls == [(["hel", "lo"], 0.0, 1.0), (["sun", "shine"], 0.5, 1.875), (["to", "day"], 1.375, 4.0)]
    assert [n["word"] for n in out] == ["Hel-", "lo", "sun-", "shine", "to-", "day"]
    assert [n["start"] for n in out] == [s / 4 for s, _, _ in NOTES]
    assert [n["duration"] for n in out] == [n / 4 for _, n, _ in NOTES]
    assert [n["midi"] for n in out] == [m - 12 for _, _, m in NOTES]


def test_returned_pitch_is_sung_minus_octave(tracker):
    starts = [s * S16 for s, _, _ in NOTES]
    out0, _ = run(NOTES, WORDS, starts, tracker, octave=0)
    out_down, _ = run(NOTES, WORDS, starts, tracker, octave=-12)
    assert [n["midi"] for n in out0] == [m for _, _, m in NOTES]
    assert [n["midi"] for n in out_down] == [m + 12 for _, _, m in NOTES]


def test_bad_octave_is_an_error(tracker):
    with pytest.raises(ValueError, match="octave 24"):
        run(NOTES, WORDS, [s * S16 for s, _, _ in NOTES], tracker, octave=24)


def test_off_key_pitch_snaps_to_the_scale(tracker):
    notes = [(0, 4, 70), (4, 4, 73)]  # A#4, C#5 in C major -> A4 (down on a tie), C5
    out, _ = run(notes, [["la", "la"]], [0.0, 0.5], tracker, octave=0, lines=[(0, 8)])
    assert [n["midi"] for n in out] == [69, 72]


def test_a_word_more_than_the_take_holds(tracker):
    words = [["Hel-", "lo"], ["sun-", "shine"], ["to-", "day"], ["for-", "ev-", "er"]]
    starts = [s * S16 for s, _, _ in NOTES] + [3.4, 3.6, 3.8]  # the aligner squeezes the extra word into the silence
    with pytest.raises(transcribe.TranscribeError, match="verse1: could not find the word 'forever' in the take"):
        run(NOTES, words, starts, tracker, lines=LINES + [(6, 8)])


def test_two_syllables_forced_into_one_16th(tracker):
    # at 60 bpm a 16th is 0.25 s: syllables sung at 0 s and 0.1 s both round to 16th 0; 16th 1 is the third's
    notes = [(0, 0.4, 69), (0.4, 0.6, 72), (1, 2, 74)]
    starts = [0.0, 0.1, 0.25]
    with pytest.raises(transcribe.TranscribeError, match=r"verse1: the word 'Hello' \(syllable 'lo'\) .* same 16th"):
        run(notes, [["Hel-", "lo", "you"]], starts, tracker, bpm=60, lines=[(0, 8)])


def test_a_collision_moves_to_a_free_next_16th(tracker):
    notes = [(0, 0.4, 69), (0.4, 2.6, 72)]  # at 60 bpm: sung at 0 s and 0.1 s, both round to 16th 0
    starts = [0.0, 0.1]  # 16th 1 is free and within a 16th of 0.1 s
    out, _ = run(notes, [["Hel-", "lo"]], starts, tracker, octave=0, bpm=60, lines=[(0, 8)])
    assert [n["start"] for n in out] == [0.0, 0.25]


def test_romanise():
    assert transcribe.romanise("Street-") == "street"
    assert transcribe.romanise("I've") == "i've"
    assert transcribe.romanise("Café,") == "cafe"
    with pytest.raises(ValueError, match="'--'"):
        transcribe.romanise("--")


def test_a_take_off_our_grid_is_read_through_its_clock(tracker):
    # the take sings NOTES 1 s late and at half speed: take second t is our beat (t - 1) * 1 (60 bpm in the take)
    slow = [(8 + 2 * s, 2 * n, m) for s, n, m in NOTES]  # in 16ths of 120 bpm: 1 s offset, twice as long
    aligner = StubAligner([(s * S16) for s, _, _ in slow])
    out = transcribe.syllable_notes(synth(slow, total_16ths=80), SR, WORDS, BPM, key="C", octave=12,
                                    section="verse1", aligner=aligner, tracker=tracker, line_beats=LINES,
                                    clock=align.Clock([1.0, 11.0], [0.0, 10.0]))
    assert [n["start"] for n in out] == [s / 4 for s, _, _ in NOTES]
    assert [n["duration"] for n in out] == [n / 4 for _, n, _ in NOTES]
    assert [n["midi"] for n in out] == [m - 12 for _, _, m in NOTES]


def test_a_line_outside_the_take(tracker):
    with pytest.raises(transcribe.TranscribeError, match="verse1: line 2 \\(beats 9-10\\) is not in the take"):
        run(NOTES, [["Hel-", "lo"], ["sun-"]], [0.0, 0.25, 0.75], tracker, lines=[(0, 8), (9, 10)])
