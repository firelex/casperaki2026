"""Score-aligned tightening (pipeline/tighten.py): each phrase lands on the score on its own, at its pitch; a phrase's
soft first note (its start not found) moves with its phrase."""
import librosa
import numpy as np

from pipeline import tighten

SR = 24000
BPM = 120  # a beat = 0.5 s


def sung(starts_s, midis, length_s, *, consonant=True):
    """Synthetic singing: each note's vowel (a tone) from its start for 0.45 s (or to the next note), with a short noise burst
    just before it like a consonant (left out with consonant=False: a soft, voiced start)."""
    rng = np.random.default_rng(0)
    y = np.zeros(int(length_s * SR), dtype=np.float32)
    ends = [min(e, s + 0.45) for s, e in zip(starts_s, list(starts_s[1:]) + [length_s - 0.3])]
    for s, e, m in zip(starts_s, ends, midis):
        i0, i1 = int(s * SR), int(e * SR)
        t = np.arange(i1 - i0) / SR
        tone = 0.3 * np.sin(2 * np.pi * librosa.midi_to_hz(m) * t)
        tone[:240] *= np.linspace(0, 1, 240)
        y[i0:i1] += tone.astype(np.float32)
        if consonant:
            b = int(0.03 * SR)
            y[i0 - b:i0] += (0.15 * rng.standard_normal(b)).astype(np.float32)
    return y


def notes_of(beats, midis):
    return [{"start": b, "duration": 1.0, "midi": m} for b, m in zip(beats, midis)]


def vowels_near(y, times_s, midis, window=0.1):
    t, midi = tighten.analysis(y, SR)
    return np.array([tighten.vowel_start(t, midi, (t >= s - window) & (t <= s + window), m) for s, m in zip(times_s, midis)])


def test_notes_sung_off_the_score_land_on_it_at_their_pitch():
    beats = [1, 2, 3, 4, 5, 6, 7, 8]
    midis = [64, 67, 69, 67, 64, 62, 64, 67]
    score = np.array(beats) * 0.5
    offsets = [0.04, -0.03, 0.05, -0.04, 0.03, -0.05, 0.04, -0.035]
    y = sung(score + offsets, midis, 5.0)
    z, anc = tighten.tighten(y, SR, notes_of(beats, midis), BPM)
    assert len(z) == len(y)
    assert len(anc) - 2 >= 7
    assert np.max(np.abs(vowels_near(z, score, midis) - score)) < 0.015
    f0, voiced, _ = librosa.pyin(z, fmin=150, fmax=700, sr=SR, frame_length=2048, hop_length=256)
    tt = librosa.times_like(f0, sr=SR, hop_length=256)
    for s, m in zip(score, midis):
        sel = (tt > s + 0.15) & (tt < s + 0.35) & voiced
        assert abs(float(librosa.hz_to_midi(np.median(f0[sel]))) - m) < 0.3


def test_a_late_phrase_lands_on_the_score_even_when_its_first_note_is_not_found():
    """Two phrases (split by a rest of more than a beat). The second is sung 60 ms late as a whole; its first note has
    no attack and is on the pitch the phrase before ended on, so neither its vowel nor its attack can be found."""
    beats = [1, 2, 3, 6, 7, 8]
    midis = [64, 67, 69, 69, 67, 64]
    score = np.array(beats) * 0.5
    late = np.array([0, 0, 0, 0.06, 0.06, 0.06])
    y = sung(score + late, midis, 5.0)
    z, _ = tighten.tighten(y, SR, notes_of(beats, midis), BPM)
    # The phrase's second and third notes: on the score after.
    v = vowels_near(z, score[4:], midis[4:])
    assert np.max(np.abs(v - score[4:])) < 0.015
    # Its first note moved with them: its burst (the consonant before the vowel) is now ~60 ms earlier.
    env = np.convolve(np.abs(z), np.ones(120) / 120, "same")
    k0 = int((score[3] - 0.1) * SR)
    rise = k0 + int(np.argmax(env[k0:k0 + int(0.2 * SR)] > 0.05))
    assert abs(rise / SR - (score[3] - 0.03)) < 0.02


def test_a_take_already_on_the_score_is_left_as_it_is():
    beats = [1, 2, 3, 4, 5, 6]
    midis = [60, 62, 64, 65, 67, 69]
    y = sung(np.array(beats) * 0.5, midis, 4.0)
    z, anc = tighten.tighten(y, SR, notes_of(beats, midis), BPM)
    assert all(abs(a - s) < tighten.MIN_MOVE_S + 0.01 for a, s in anc[1:-1])
    assert np.max(np.abs(vowels_near(z, np.array(beats) * 0.5, midis) - np.array(beats) * 0.5)) < 0.015
