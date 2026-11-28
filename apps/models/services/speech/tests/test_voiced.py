"""How much voice a recording holds, against a fixed level (not its own loudest point): hiss or silence is no voice."""
import numpy as np
import soundfile as sf

from pipeline.match import voiced_seconds

SR = 16000


def write(tmp_path, name, audio):
    p = tmp_path / name
    sf.write(p, audio, SR)
    return p


def test_silence_and_hiss_hold_no_voice(tmp_path):
    assert voiced_seconds(write(tmp_path, "zeros.wav", np.zeros(5 * SR))) == 0
    rng = np.random.default_rng(1)
    assert voiced_seconds(write(tmp_path, "hiss.wav", 1e-4 * rng.standard_normal(5 * SR))) < 0.1


def test_a_short_burst_in_silence_is_short(tmp_path):
    t = np.arange(int(0.3 * SR)) / SR
    audio = np.concatenate([np.zeros(2 * SR), 0.3 * np.sin(2 * np.pi * 200 * t), np.zeros(2 * SR)])
    assert 0.2 < voiced_seconds(write(tmp_path, "burst.wav", audio)) < 0.5


def test_a_steady_voice_counts(tmp_path):
    t = np.arange(3 * SR) / SR
    assert voiced_seconds(write(tmp_path, "tone.wav", 0.2 * np.sin(2 * np.pi * 220 * t))) > 2.5
