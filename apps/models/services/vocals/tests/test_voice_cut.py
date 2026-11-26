"""A new singer's recording: silences cut (pipeline.voice_cut.cut_silence) and the voice reference chosen
(choose_reference, "beginning" and "best"), always from a phrase start to a phrase end."""
import numpy as np
import pytest

from pipeline import voice_cut

SR = 16000


def voice(parts):
    """A test recording: [(seconds, sung?)] -> a 220 Hz tone where sung, silence otherwise."""
    out = []
    for s, on in parts:
        n = int(s * SR)
        t = np.arange(n) / SR
        out.append((0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32) if on else np.zeros(n, np.float32))
    return np.concatenate(out)


def test_silences_are_cut_at_the_edges_and_shortened_inside():
    x = voice([(2.0, False), (3.0, True), (2.0, False), (1.0, True), (0.3, False), (1.0, True), (3.0, False)])
    y, pieces = voice_cut.cut_silence(x, SR)
    # 0.1 s before and after, the 2 s pause down to 0.4 s, the 0.3 s pause kept
    assert len(y) / SR == pytest.approx(0.1 + 3.0 + 0.4 + 1.0 + 0.3 + 1.0 + 0.1, abs=0.05)
    assert pieces[0][0] == pytest.approx(1.9, abs=0.03)
    assert len(pieces) == 2
    # a time of the cut voice found in the recording: the start of the second phrase
    assert voice_cut.recording_time(0.1 + 3.0 + 0.4, pieces) == pytest.approx(7.0, abs=0.05)


def test_a_silent_recording_is_an_error():
    with pytest.raises(ValueError, match="silent"):
        voice_cut.cut_silence(np.zeros(SR * 3, np.float32), SR)


def test_phrases_are_split_at_pauses_of_at_least_0_15_s():
    x = voice([(0.1, False), (2.0, True), (0.1, False), (2.0, True), (0.3, False), (1.0, True), (0.1, False)])
    phr = voice_cut.phrases(x, SR)
    assert len(phr) == 2  # the 0.1 s gap is no pause
    assert phr[0][1] - phr[0][0] == pytest.approx(4.1, abs=0.05)


def ph(*lengths, pause=0.3):
    """Phrases of the given lengths, `pause` s apart, from 0."""
    out, t = [], 0.0
    for n in lengths:
        out.append((t, t + n))
        t += n + pause
    return out


def test_the_beginning_ends_at_the_phrase_end_nearest_10_s():
    phr = ph(3, 3, 3, 3, 3)  # ends at 3, 6.3, 9.6, 12.9, ...
    a, b = voice_cut.choose_reference(phr, "beginning")
    assert (a, b) == (0.0, pytest.approx(9.6))


def test_the_best_stretch_is_the_most_continuous_singing():
    # the start is choppy (short phrases with 1 s pauses), later one long run of singing with short breaths
    phr = ph(1, 1, 1, pause=1.0) + [(p0 + 6.0, p1 + 6.0) for p0, p1 in ph(4, 5, 4, 3, pause=0.2)]
    a, b = voice_cut.choose_reference(phr, "best")
    assert a == pytest.approx(6.0)
    assert 8.0 <= b - a <= 12.0
    assert b in [p[1] for p in phr]  # it ends where a phrase ends: at a pause
    begin = voice_cut.choose_reference(phr, "beginning")
    assert begin[0] == 0.0 and begin != (a, b)


def test_no_pause_in_reach_is_an_error_saying_so():
    with pytest.raises(ValueError, match="ends at a pause"):
        voice_cut.choose_reference([(0.0, 20.0)], "best")
    with pytest.raises(ValueError, match="at least 8 s"):
        voice_cut.choose_reference(ph(2, 2), "beginning")
    with pytest.raises(ValueError, match="must be one of"):
        voice_cut.choose_reference(ph(5, 5), "middle")


def test_the_clip_reaches_to_the_silence_around_its_phrases_and_is_faded():
    x = voice([(1.0, True), (0.3, False), (9.0, True), (0.2, False)])
    phr = voice_cut.phrases(x, SR)
    assert len(phr) == 2
    y, a, b = voice_cut.clip(x, SR, phr, phr[1][0], phr[1][1])
    assert a == pytest.approx(1.3, abs=0.021) and b == pytest.approx(10.3, abs=0.021)  # where the tone stops
    assert len(y) / SR == pytest.approx(b - a, abs=1e-3)
    assert abs(y[0]) < 1e-6 and abs(y[-1]) < 1e-6


def test_a_quiet_ending_counts_as_a_pause():
    # a phrase falling 26 dB under its loud level for 0.3 s: a pause (the owner's "la la la" ran on legato)
    x = np.concatenate([voice([(3.0, True)]), 0.015 * voice([(0.3, True)]), voice([(3.0, True)])])
    phr = voice_cut.phrases(x, SR)
    assert len(phr) == 2
    _, pieces = voice_cut.cut_silence(x, SR)
    assert len(pieces) == 1  # not silence: nothing cut
