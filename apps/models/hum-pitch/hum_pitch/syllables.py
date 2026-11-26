"""Syllables in a hummed or sung melody (2026-11-26): the hum-notes model merges repeated syllables on one pitch
("la la la la" on an A is one long A), so its notes are split at spectral-flux onsets (a new syllable), each piece is
pitched from its own pitch track, and in click mode pieces on one grid slot become one note again.

Measured (scripts/syllable_split.py): the owner's la-la "Alle meine Entchen" (27 notes), hum service 12 right ->
22 right; HumTrans test (296 hums, the guard) right pitch 47.2% -> 47.9%, onset F unchanged.
"""
from __future__ import annotations

import numpy as np

ONSET_DELTA = 0.1      # librosa onset_detect delta (lower: more splits); 0.1 measured best
EDGE_S = 0.1           # no split this close to a note's start or end
MIN_GAP_S = 0.15       # nor this close to the split before
MAJOR = (0, 2, 4, 5, 7, 9, 11)
MINOR = (0, 2, 3, 5, 7, 8, 10)


def split_at_onsets(notes: list[list], y: np.ndarray, sr: int) -> list[list]:
    """[[on, off, midi]] split at spectral-flux onsets (backtracked to their start) inside each note."""
    import librosa

    x = librosa.resample(np.asarray(y, dtype=np.float32), orig_sr=sr, target_sr=22050) if sr != 22050 else np.asarray(y, dtype=np.float32)
    onsets = librosa.onset.onset_detect(y=x, sr=22050, hop_length=128, units="time", backtrack=True, delta=ONSET_DELTA)
    out = []
    for a, b, m in notes:
        cuts: list[float] = []
        for t in onsets:
            if a + EDGE_S < t < b - EDGE_S and (not cuts or t - cuts[-1] >= MIN_GAP_S):
                cuts.append(float(t))
        bounds = [a, *cuts, b]
        out += [[p, q, m] for p, q in zip(bounds, bounds[1:])]
    return out


def repitch(pieces: list[list], y: np.ndarray, sr: int, key: dict) -> list[list]:
    """Every piece's pitch from its own pitch track (pYIN median over its middle half), less the recording's tuning
    offset (the median distance of all pieces from a whole semitone), snapped to `key` ({"tonic", "scale"}): of the
    whole semitones around it, one in the key's scale wins, the nearest of those. A piece without pitch keeps its own."""
    import librosa

    x = librosa.resample(np.asarray(y, dtype=np.float32), orig_sr=sr, target_sr=16000) if sr != 16000 else np.asarray(y, dtype=np.float32)
    f0, voiced, _ = librosa.pyin(x, fmin=65, fmax=1000, sr=16000, frame_length=1024, hop_length=160)
    t = librosa.times_like(f0, sr=16000, hop_length=160)
    raw: list[float | None] = []
    for a, b, _ in pieces:
        lo, hi = a + 0.25 * (b - a), b - 0.25 * (b - a)
        sel = (t >= lo) & (t <= hi) & voiced & np.isfinite(f0)
        raw.append(float(np.median(librosa.hz_to_midi(f0[sel]))) if sel.sum() >= 3 else None)
    known = [r for r in raw if r is not None]
    if not known:
        return [list(p) for p in pieces]
    off = float(np.median([r - round(r) for r in known]))
    if key["scale"] not in ("major", "minor"):
        raise ValueError(f"repitch: unknown scale {key['scale']!r}")
    allowed = {(key["tonic"] + d) % 12 for d in (MAJOR if key["scale"] == "major" else MINOR)}
    out = []
    for (a, b, m), r in zip(pieces, raw):
        if r is None:
            out.append([a, b, m])
            continue
        c = r - off
        q = min((round(c) + d for d in (-1, 0, 1)), key=lambda q: (q % 12 not in allowed, abs(q - c)))
        out.append([a, b, int(q)])
    return out


def merge_on_grid(pieces: list[list], first_beat: float, bpm: float, per_beat: int = 2) -> list[list]:
    """Click mode: pieces starting on the same grid slot (an eighth at per_beat=2) are one note: the first one's
    start, the last one's end, the longest one's pitch."""
    step = 60.0 / bpm / per_beat
    out: list[list] = []
    group: list[list] = []

    def flush():
        if group:
            longest = max(group, key=lambda p: p[1] - p[0])
            out.append([group[0][0], group[-1][1], longest[2]])

    for p in pieces:
        if group and round((group[0][0] - first_beat) / step) == round((p[0] - first_beat) / step):
            group.append(p)
        else:
            flush()
            group = [p]
    flush()
    return out
