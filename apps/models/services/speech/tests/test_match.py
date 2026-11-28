"""SpeakerMatcher: WavLM speaker embeddings; the same voice scores higher than another voice."""
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from pipeline import paths

# Two different voices: the built-in singer (in this repo) and a Breeze line kept on datigator only (Breeze's output
# may not be passed on, so it is not in git).
VOICE_A = Path(__file__).resolve().parents[2] / "vocals" / "voices" / "yue2_female_dry2.mp3"
VOICE_B = Path.home() / "casperaki-data" / "voicetest" / "ice.wav"
pytestmark = [
    pytest.mark.skipif(not paths.WAVLM_SV.is_dir(), reason=f"no speaker model at {paths.WAVLM_SV}: run tools/fetch_wavlm.py"),
    pytest.mark.skipif(not VOICE_B.is_file(), reason=f"no second voice at {VOICE_B} (datigator only)"),
]


def halves(src: Path, tmp: Path, name: str) -> tuple[Path, Path]:
    audio, sr = sf.read(src, always_2d=True)
    mono = audio.mean(axis=1)
    mid = len(mono) // 2
    a, b = tmp / f"{name}-a.wav", tmp / f"{name}-b.wav"
    sf.write(a, mono[:mid], sr)
    sf.write(b, mono[mid:], sr)
    return a, b


@pytest.fixture(scope="module")
def matcher():
    from pipeline.match import SpeakerMatcher

    m = SpeakerMatcher()
    yield m
    m.close()


def test_same_voice_scores_higher(matcher, tmp_path):
    a1, a2 = halves(VOICE_A, tmp_path, "a")
    b1, _ = halves(VOICE_B, tmp_path, "b")
    ea1, ea2, eb1 = matcher.embed(a1), matcher.embed(a2), matcher.embed(b1)
    assert abs(float(np.linalg.norm(ea1)) - 1) < 1e-5
    assert matcher.similarity(ea1, ea2) > matcher.similarity(ea1, eb1)


def test_too_short_fails(matcher, tmp_path):
    short = tmp_path / "short.wav"
    sf.write(short, 0.3 * np.sin(np.arange(4800) / 16000 * 2 * np.pi * 200), 16000)
    with pytest.raises(ValueError, match="at least 1 s of voice"):
        matcher.embed(short)
