"""Levels of the repeats stage's takes (ported from apps/models/ace-vocal-tests/other-models/build_plan2_tracks.py,
shared tree): loudness is the RMS of the singing parts only (samples above -60 dBFS), a take is matched to a
reference's loudness plus an offset (SoulX verses 0 dB to the YuE2 chorus, backing vocals -6 dB, ad-libs -4 dB), and
cut to its section with a short fade-out.
"""
from __future__ import annotations

import numpy as np

FADE_S = 0.15
SINGING = 1e-3  # a sample louder than this (any channel) counts as singing


def _2d(x: np.ndarray) -> np.ndarray:
    return x if x.ndim == 2 else x[:, None]


def loud(x: np.ndarray) -> float:
    """RMS over the samples (samples x channels) where any channel is above SINGING; NaN when there are none."""
    x = _2d(np.asarray(x, dtype=np.float64))
    m = np.abs(x).max(axis=1) > SINGING
    if not m.any():
        return float("nan")
    return float(np.sqrt(np.mean(np.square(x[m]))))


def match(take: np.ndarray, reference: np.ndarray, offset_db: float, name: str = "take") -> np.ndarray:
    """The take scaled so its singing is `offset_db` from the reference's."""
    a, b = loud(take), loud(reference)
    if not np.isfinite(a):
        raise ValueError(f"{name}: the take is silent")
    if not np.isfinite(b):
        raise ValueError(f"{name}: the level reference is silent")
    return np.asarray(take) * (b / a * 10 ** (offset_db / 20))


def gain_db(take: np.ndarray, reference: np.ndarray, offset_db: float) -> float:
    """The gain `match` applies, in dB."""
    return float(20 * np.log10(loud(reference) / loud(take)) + offset_db)


def fit(take: np.ndarray, sr: int, seconds: float) -> np.ndarray:
    """The take cut (or padded with silence) to `seconds` + FADE_S, faded out over the last FADE_S."""
    take = _2d(np.asarray(take))
    n = int((seconds + FADE_S) * sr)
    out = np.zeros((n, take.shape[1]), dtype=take.dtype if take.dtype.kind == "f" else np.float64)
    k = min(n, len(take))
    out[:k] = take[:k]
    f = int(FADE_S * sr)
    out[-f:] *= np.linspace(1, 0, f)[:, None]
    return out
