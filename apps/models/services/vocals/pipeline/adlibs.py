"""YuE2 ad-libs for the later choruses (ported from apps/models/ace-vocal-tests/other-models/yue2_adlibs.py and
build_plan2_tracks.py, shared tree).

The ad-lib score is the chorus's chords with notes only in the gaps of the sung chorus lead (the bars the brain names,
`gaps_bars`: two beats or more with no syllable starting): per gap bar "oh yeah", the two notes ending the bar's
longest stretch without a syllable. YuE2 sings it as a lead unit (`unit`: lead-in, chords and tail as the chorus
unit's); it tends to sing all through the take, so `gate` keeps only the gap bars.
"""
from __future__ import annotations

import re
from statistics import median

import numpy as np

from .score import ROOTS

FADE_S = 0.15
BEATS_PER_BAR = 4
EPS = 1e-6
WORDS = ("oh", "yeah")
# Chord qualities (after the root) and their triads in semitones above the root.
TRIADS = {"": (0, 4, 7), "maj7": (0, 4, 7), "maj9": (0, 4, 7), "7": (0, 4, 7), "9": (0, 4, 7), "6": (0, 4, 7),
          "add9": (0, 4, 7), "m": (0, 3, 7), "m7": (0, 3, 7), "m9": (0, 3, 7), "m6": (0, 3, 7), "sus2": (0, 2, 7),
          "sus4": (0, 5, 7), "dim": (0, 3, 6), "aug": (0, 4, 8), "5": (0, 7)}


def chord_tones(chord: str) -> set[int]:
    """Pitch classes of the chord's triad."""
    m = re.fullmatch(r"([A-G][#b]?)(.*)", chord)
    if m is None or m.group(1) not in ROOTS or m.group(2) not in TRIADS:
        raise ValueError(f"ad-libs: chord {chord!r} is not a chord name the ad-lib score knows")
    return {(ROOTS[m.group(1)] + i) % 12 for i in TRIADS[m.group(2)]}


def _longest_gap(onsets: list[float], bar: int) -> tuple[float, float]:
    a, z = bar * BEATS_PER_BAR, (bar + 1) * BEATS_PER_BAR
    points = [a] + sorted(t for t in onsets if a - EPS <= t < z - EPS) + [z]
    return max(zip(points, points[1:]), key=lambda p: (p[1] - p[0], p[0]))


def score_notes(gaps_bars, chords, melody):
    """(notes, lyric lines): per gap bar "oh" and "yeah", a beat each, ending the bar's longest stretch with no
    syllable starting; "oh" is the chord tone nearest the lead's median note, "yeah" the next chord tone below it.
    Notes are in the lane's register, beats from the chorus start. A bar without two free beats is an error."""
    if not melody:
        raise ValueError("ad-libs: the chorus melody is empty")
    center = median(int(n["midi"]) for n in melody)
    onsets = [float(n["start"]) for n in melody]
    notes, lyrics = [], []
    for bar in sorted(gaps_bars):
        if bar < 0 or (bar + 1) * BEATS_PER_BAR > len(chords):
            raise ValueError(f"ad-libs: gap bar {bar + 1} is outside the chorus's {len(chords) // BEATS_PER_BAR} bars")
        a, z = _longest_gap(onsets, bar)
        if z - a < 2 - EPS:
            raise ValueError(f"ad-libs: bar {bar + 1} has no gap of two beats (longest {z - a:g} beats)")
        oh_tones = chord_tones(chords[int(z - 2)])
        oh = min((m for m in range(int(center) - 12, int(center) + 13) if m % 12 in oh_tones),
                 key=lambda m: (abs(m - center), -m))
        yeah_tones = chord_tones(chords[int(z - 1)])
        yeah = next(m for m in range(oh - 1, oh - 13, -1) if m % 12 in yeah_tones)
        notes += [{"start": z - 2, "duration": 1, "midi": oh}, {"start": z - 1, "duration": 1, "midi": yeah}]
        lyrics.append(" ".join(WORDS))
    if not notes:
        raise ValueError("ad-libs: no gap bars")
    return notes, lyrics


def unit(p: dict) -> dict:
    """The ad-lib score as a lead-stage unit (pipeline.score.abc / lyrics_text): id "<chorus unit>_adlibs"."""
    notes, lyrics = score_notes(p["gaps_bars"], p["chords"], p["melody"])
    return {"id": f"{p['chorus_unit']}_adlibs", "lead_in_chords": list(p["lead_in_chords"]), "chords": list(p["chords"]),
            "tail_chords": list(p["tail_chords"]), "notes": notes, "lyrics": lyrics,
            "words": [list(WORDS) for _ in lyrics], "phonemes": [[["ow1"], ["y", "ae1"]] for _ in lyrics]}


def gate(take: np.ndarray, sr: int, bars, bar_s: float) -> np.ndarray:
    """Only the given bars (0-based) of the take, neighbouring bars kept as one stretch; each stretch fades in over
    the FADE_S before its first bar line (so a sung attack on the bar line stays whole) and fades out over the last
    FADE_S of its last bar."""
    take = np.asarray(take)
    out = np.zeros_like(take, dtype=np.float64 if take.dtype.kind != "f" else take.dtype)
    n_bars = len(take) / (bar_s * sr)
    runs = []
    for b in sorted(set(bars)):
        if b < 0 or b + 1 > n_bars + EPS:
            raise ValueError(f"ad-libs: bar {b + 1} is outside the take's {n_bars:.2f} bars")
        if runs and runs[-1][1] == b:
            runs[-1][1] = b + 1
        else:
            runs.append([b, b + 1])
    f = int(FADE_S * sr)
    for a, z in runs:
        i0, i1 = int(round(a * bar_s * sr)), min(len(take), int(round(z * bar_s * sr)))
        s0 = max(0, i0 - f)
        seg = take[s0:i1].astype(out.dtype, copy=True)
        fin = i0 - s0
        if fin:
            seg[:fin] *= np.linspace(0, 1, fin, endpoint=False)[:, None] if seg.ndim == 2 else np.linspace(0, 1, fin, endpoint=False)
        ramp = np.linspace(1, 0, f)
        seg[-f:] *= ramp[:, None] if seg.ndim == 2 else ramp
        out[s0:i1] = seg
    return out
