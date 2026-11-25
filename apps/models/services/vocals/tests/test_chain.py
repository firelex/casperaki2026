"""The vocal chain for SoulX takes (pipeline.chain): the owner's demo values; peaks held at full scale."""
import numpy as np
import pytest
from pedalboard import Compressor, HighShelfFilter, HighpassFilter, PeakFilter

from pipeline import chain


def test_the_chain_has_the_demo_values():
    hp, low_mid, presence, air, comp = list(chain.CHAIN)
    assert isinstance(hp, HighpassFilter) and hp.cutoff_frequency_hz == 100
    assert isinstance(low_mid, PeakFilter) and (low_mid.cutoff_frequency_hz, low_mid.gain_db) == (300, -3)
    assert isinstance(presence, PeakFilter) and (presence.cutoff_frequency_hz, presence.gain_db) == (3500, 3)
    assert isinstance(air, HighShelfFilter) and (air.cutoff_frequency_hz, air.gain_db) == (10000, 3)
    assert isinstance(comp, Compressor)
    assert (comp.threshold_db, comp.ratio, comp.attack_ms, comp.release_ms) == (-20, 3.5, 5, 80)


def test_the_chain_holds_peaks_at_full_scale():
    sr = 24000
    t = np.arange(sr * 2) / sr
    x = 0.6 * np.sin(2 * np.pi * 440 * t) * (1 + np.sin(2 * np.pi * 3 * t)) / 2
    x = np.stack([x, x], axis=1).astype(np.float32)
    y = chain.process(x, sr)
    assert y.shape == x.shape
    assert 0.5 < np.abs(y).max() <= 1.0 + 1e-6
    assert chain.LIMIT_DB == -1.0


def test_a_silent_take_is_an_error():
    with pytest.raises(ValueError, match="silent"):
        chain.process(np.zeros((100, 2), dtype=np.float32), 24000)
