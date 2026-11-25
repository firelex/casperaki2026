"""The vocal chain on every sung take (pipeline.chain): the owner's demo values, the exciter at -6 dB, 48 kHz out,
peaks held at full scale."""
import numpy as np
import pytest
from pedalboard import Compressor, HighShelfFilter, PeakFilter

from pipeline import chain


def tone(sr, seconds=2.0, hz=440):
    t = np.arange(int(sr * seconds)) / sr
    x = 0.6 * np.sin(2 * np.pi * hz * t) * (1 + np.sin(2 * np.pi * 3 * t)) / 2
    return np.stack([x, x], axis=1).astype(np.float32)


def test_the_chain_has_the_demo_values():
    low_mid, presence, air, comp = list(chain.CHAIN)
    assert chain.HIGH_PASS_HZ == 100
    assert isinstance(low_mid, PeakFilter) and (low_mid.cutoff_frequency_hz, low_mid.gain_db) == (300, -3)
    assert isinstance(presence, PeakFilter) and (presence.cutoff_frequency_hz, presence.gain_db) == (3500, 3)
    assert isinstance(air, HighShelfFilter) and (air.cutoff_frequency_hz, air.gain_db) == (10000, 3)
    assert isinstance(comp, Compressor)
    assert (comp.threshold_db, comp.ratio, comp.attack_ms, comp.release_ms) == (-20, 3.5, 5, 80)
    assert (chain.EXCITER_HZ, chain.EXCITER_DRIVE, chain.EXCITER_SR, chain.EXCITER_DB) == (3000, 4.0, 48000, -6.0)
    assert chain.LIMIT_DB == -1.0


def test_a_24_khz_take_comes_out_at_48_khz_with_peaks_at_full_scale():
    x = tone(24000)
    y = chain.process(x, 24000)
    assert chain.OUT_SR == 48000
    assert y.shape == (2 * len(x), 2)
    assert 0.5 < np.abs(y).max() <= 1.0 + 1e-6


def test_the_exciter_adds_brightness_above_3_khz_only():
    sr = 48000
    x = tone(sr, hz=2000)  # a 2 kHz tone: saturating its high-passed part adds harmonics at 6, 10, ... kHz
    y = chain.excite(x.astype(np.float64), sr)
    spec = lambda z: np.abs(np.fft.rfft(z[:, 0]))  # noqa: E731
    f = np.fft.rfftfreq(len(x), 1 / sr)
    added = spec(y) - spec(x)
    assert added[(f > 5500) & (f < 6500)].max() > 0
    assert np.abs(added[f < 1000]).max() < 1e-3 * spec(x).max()


def test_the_exciter_is_mixed_6_db_under():
    sr = 48000
    x = tone(sr, hz=5000).astype(np.float64)
    quiet = chain.excite(x, sr, mix_db=-6) - x
    loud = chain.excite(x, sr, mix_db=0) - x
    assert np.sqrt(np.mean(quiet ** 2)) / np.sqrt(np.mean(loud ** 2)) == pytest.approx(10 ** (-6 / 20), rel=1e-6)


def test_a_silent_take_is_an_error():
    with pytest.raises(ValueError, match="silent"):
        chain.process(np.zeros((100, 2), dtype=np.float32), 24000)
