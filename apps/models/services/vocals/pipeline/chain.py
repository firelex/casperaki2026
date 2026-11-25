"""The vocal chain for SoulX takes (ported from apps/models/ace-vocal-tests/other-models/vocal_chain.py, shared tree;
values from the owner's demo, global constraints "SoulX takes get a vocal chain"): high-pass 100 Hz, low-mid cut -3 dB
at 300 Hz, presence +3 dB at 3.5 kHz, air shelf +3 dB from 10 kHz, compressor (threshold -20 dB, ratio 3.5, attack
5 ms, release 80 ms), make-up gain back to the input's loudness (singing parts), then pedalboard's Limiter with
threshold -1 dB exactly as in the demo. Note: that Limiter (JUCE's) boosts the input by -threshold and holds peaks at
full scale (0 dBFS), so a take leaves the chain a little louder than it came in; the levels step after it sets the
final loudness. No reverb: the app adds it as a send.
"""
from __future__ import annotations

import numpy as np
from pedalboard import Compressor, HighShelfFilter, HighpassFilter, Limiter, PeakFilter, Pedalboard

from .levels import loud

CHAIN = Pedalboard([
    HighpassFilter(cutoff_frequency_hz=100),
    PeakFilter(cutoff_frequency_hz=300, gain_db=-3, q=1.0),
    PeakFilter(cutoff_frequency_hz=3500, gain_db=3, q=0.8),
    HighShelfFilter(cutoff_frequency_hz=10000, gain_db=3),
    Compressor(threshold_db=-20, ratio=3.5, attack_ms=5, release_ms=80),
])
LIMIT_DB = -1.0


def process(x: np.ndarray, sr: int) -> np.ndarray:
    """x: samples x channels. The chained take (see the module comment for the limiter)."""
    a = loud(x)
    if not np.isfinite(a):
        raise ValueError("vocal chain: the take is silent")
    y = CHAIN(np.ascontiguousarray(x.T, dtype=np.float32), sr).T
    y = y * (a / loud(y))
    return Limiter(threshold_db=LIMIT_DB)(np.ascontiguousarray(y.T, dtype=np.float32), sr).T
