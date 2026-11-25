"""Levels of the repeats stage's takes (pipeline.levels): loudness of the singing parts only, matched to a reference
with an offset; each take cut to its section with a fade."""
import numpy as np
import pytest

from pipeline import levels

SR = 8000


def sung(gain, seconds=2.0):
    """A stereo take: half a second of silence, then a tone, then silence (the silence must not count)."""
    t = np.arange(int(seconds * SR)) / SR
    x = gain * np.sin(2 * np.pi * 220 * t)
    x[: SR // 2] = 0
    x[-SR // 2:] = 0
    return np.stack([x, x], axis=1)


def db(a, b):
    return 20 * np.log10(levels.loud(a) / levels.loud(b))


def test_loudness_counts_the_singing_parts_only():
    x = sung(0.5)
    padded = np.concatenate([x, np.zeros((5 * SR, 2))])
    assert levels.loud(padded) == pytest.approx(levels.loud(x))
    assert levels.loud(x) == pytest.approx(0.5 / np.sqrt(2), rel=1e-2)


def test_a_take_6_db_quieter_comes_out_level():
    ref, take = sung(0.5), sung(0.5 * 10 ** (-6 / 20))
    assert db(take, ref) == pytest.approx(-6, abs=1e-6)
    assert db(levels.match(take, ref, 0), ref) == pytest.approx(0, abs=1e-6)


def test_with_offset_minus_6_it_sits_6_db_under():
    ref, take = sung(0.5), sung(0.1)
    assert db(levels.match(take, ref, -6), ref) == pytest.approx(-6, abs=1e-6)


def test_a_silent_take_is_an_error():
    with pytest.raises(ValueError, match="verse2: the take is silent"):
        levels.match(np.zeros((SR, 2)), sung(0.5), 0, name="verse2")


def test_fit_cuts_to_the_section_plus_a_fade():
    x = np.ones((10 * SR, 2))
    y = levels.fit(x, SR, 2.0)
    assert len(y) == int(2.15 * SR)
    assert y[int(1.9 * SR), 0] == 1.0
    assert y[-1, 0] == pytest.approx(0, abs=1e-3)
    assert y[int(2.075 * SR), 0] == pytest.approx(0.5, abs=0.01)


def test_fit_pads_a_short_take_with_silence():
    y = levels.fit(np.ones((SR, 2)), SR, 2.0)
    assert len(y) == int(2.15 * SR)
    assert np.all(y[int(1.1 * SR):] == 0)
