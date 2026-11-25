"""The vocal chain for every sung take, as in the owner's approved demo (apps/models/ace-vocal-tests/other-models/
vocal_chain.py, shared tree, run with the exciter at -6 dB):

1. high-pass at 100 Hz (2nd-order Butterworth run forward and back: zero-phase, 24 dB/octave);
2. low-mid cut -3 dB at 300 Hz, presence +3 dB at 3.5 kHz, air shelf +3 dB from 10 kHz;
3. compressor (threshold -20 dB, ratio 3.5, attack 5 ms, release 80 ms);
4. harmonic exciter at 48 kHz (`excite`): the part above 3 kHz, saturated (tanh, drive 4, 2x oversampled so its new
   harmonics do not alias), high-passed again so only the added brightness is kept, mixed 6 dB under the signal;
5. make-up gain back to the input's loudness (singing parts only, levels.loud);
6. pedalboard's Limiter with threshold -1 dB (JUCE's: it boosts the input by -threshold and holds peaks at full
   scale, so a take leaves the chain a little louder than it came in; the levels step after it sets the final level).

No reverb: the app adds it as a send. The take comes out at 48 kHz (the exciter's rate).
"""
from __future__ import annotations

import numpy as np
from pedalboard import Compressor, HighShelfFilter, Limiter, PeakFilter, Pedalboard
from scipy.signal import butter, sosfiltfilt

from .levels import loud

HIGH_PASS_HZ = 100
CHAIN = Pedalboard([
    PeakFilter(cutoff_frequency_hz=300, gain_db=-3, q=1.0),
    PeakFilter(cutoff_frequency_hz=3500, gain_db=3, q=0.8),
    HighShelfFilter(cutoff_frequency_hz=10000, gain_db=3),
    Compressor(threshold_db=-20, ratio=3.5, attack_ms=5, release_ms=80),
])
EXCITER_HZ, EXCITER_DRIVE, EXCITER_SR, EXCITER_DB = 3000, 4.0, 48000, -6.0
LIMIT_DB = -1.0
OUT_SR = EXCITER_SR


def _high_pass(x: np.ndarray, hz: float, sr: int) -> np.ndarray:
    return sosfiltfilt(butter(2, hz, btype="highpass", fs=sr, output="sos"), x, axis=0)


def excite(y: np.ndarray, sr: int, mix_db: float = EXCITER_DB) -> np.ndarray:
    """y: samples x channels at sr. The excited signal at EXCITER_SR (see the module comment, step 4)."""
    import librosa

    if sr != EXCITER_SR:
        y = librosa.resample(np.ascontiguousarray(y.T), orig_sr=sr, target_sr=EXCITER_SR).T
    up = librosa.resample(np.ascontiguousarray(_high_pass(y, EXCITER_HZ, EXCITER_SR).T), orig_sr=EXCITER_SR,
                          target_sr=2 * EXCITER_SR).T
    sat = np.tanh(EXCITER_DRIVE * up) / EXCITER_DRIVE
    down = librosa.resample(np.ascontiguousarray(sat.T), orig_sr=2 * EXCITER_SR, target_sr=EXCITER_SR).T
    return y + _high_pass(down, EXCITER_HZ, EXCITER_SR) * 10 ** (mix_db / 20)


def process(x: np.ndarray, sr: int) -> np.ndarray:
    """x: samples x channels at sr. The chained take at OUT_SR (48 kHz), samples x channels."""
    a = loud(x)
    if not np.isfinite(a):
        raise ValueError("vocal chain: the take is silent")
    lo = _high_pass(np.asarray(x, dtype=np.float64), HIGH_PASS_HZ, sr)
    y = CHAIN(np.ascontiguousarray(lo.T, dtype=np.float32), sr).T
    y = excite(y, sr)
    y = y * (a / loud(y))
    return Limiter(threshold_db=LIMIT_DB)(np.ascontiguousarray(y.T, dtype=np.float32), OUT_SR).T
