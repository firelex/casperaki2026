"""The vocal chain for every sung take, as in the owner's approved demo (apps/models/ace-vocal-tests/other-models/
vocal_chain.py, shared tree, run with the exciter at -6 dB):

0. a level rider (`ride`) and a slow compressor (owner-approved 2026-11-26, apps/models/vocal-cleanup-tests/pro_chain.py):
   the rider measures the loudness over RIDER_WINDOW_S and, on singing (within RIDER_GATE_DB of the loudest), moves
   it towards the take's median singing level, at most +-RIDER_MAX_DB, eased over RIDER_EASE_S (pauses untouched);
   then a 2:1 compressor 3 dB under that median, attack 30 ms, release 300 ms (the LA-2A role); level matched.
   Each take keeps its own median level, so sections keep their levels to each other;
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
RIDER_WINDOW_S, RIDER_MAX_DB, RIDER_EASE_S, RIDER_GATE_DB = 0.4, 6.0, 0.2, 30.0
SLOW_RATIO, SLOW_UNDER_DB, SLOW_ATTACK_MS, SLOW_RELEASE_MS = 2.0, 3.0, 30, 300
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


def ride(x: np.ndarray, sr: int) -> tuple[np.ndarray, float]:
    """x: samples x channels. The take with the rider's gain (one gain for all channels, from their mean), and the
    take's median singing level (dB) it rides towards."""
    mono = np.asarray(x, dtype=np.float64).mean(1)
    hop, win = int(0.01 * sr), int(RIDER_WINDOW_S * sr)
    c = np.concatenate([[0.0], np.cumsum(np.pad(mono, (win // 2, win // 2)) ** 2)])
    idx = np.arange(0, len(mono), hop)
    lvl = 10 * np.log10((c[idx + win] - c[idx]) / win + 1e-12)
    singing = lvl > lvl.max() - RIDER_GATE_DB
    target = float(np.median(lvl[singing]))
    g = np.where(singing, np.clip(target - lvl, -RIDER_MAX_DB, RIDER_MAX_DB), 0.0)
    a = np.exp(-0.01 / RIDER_EASE_S)

    def ease(v):
        out, acc = np.empty_like(v), 0.0
        for i, w in enumerate(v):
            acc = a * acc + (1 - a) * w
            out[i] = acc
        return out

    g = (ease(g) + ease(g[::-1])[::-1]) / 2  # forward and back: no lag
    gain = np.interp(np.arange(len(mono)), idx, 10 ** (g / 20))
    return np.asarray(x, dtype=np.float32) * gain[:, None].astype(np.float32), target


def process(x: np.ndarray, sr: int) -> np.ndarray:
    """x: samples x channels at sr. The chained take at OUT_SR (48 kHz), samples x channels."""
    a = loud(x)
    if not np.isfinite(a):
        raise ValueError("vocal chain: the take is silent")
    r, median_db = ride(x, sr)
    slow = Pedalboard([Compressor(threshold_db=median_db - SLOW_UNDER_DB, ratio=SLOW_RATIO, attack_ms=SLOW_ATTACK_MS,
                                  release_ms=SLOW_RELEASE_MS)])
    r = slow(np.ascontiguousarray(r.T, dtype=np.float32), sr).T
    r = r * (a / loud(r))
    lo = _high_pass(np.asarray(r, dtype=np.float64), HIGH_PASS_HZ, sr)
    y = CHAIN(np.ascontiguousarray(lo.T, dtype=np.float32), sr).T
    y = excite(y, sr)
    y = y * (a / loud(y))
    return Limiter(threshold_db=LIMIT_DB)(np.ascontiguousarray(y.T, dtype=np.float32), OUT_SR).T
