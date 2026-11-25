"""Small music helpers of the transcribe stage: the octave a recording is read at, a key's scale, and a clock from a
recording's seconds to our beats."""
from __future__ import annotations

import re

import numpy as np

OCTAVES = (-12, 0, 12)
ROOTS = {"C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3, "E": 4, "F": 5, "F#": 6, "Gb": 6, "G": 7, "G#": 8,
         "Ab": 8, "A": 9, "A#": 10, "Bb": 10, "B": 11}
MAJOR = (0, 2, 4, 5, 7, 9, 11)
MINOR = (0, 2, 3, 5, 7, 8, 10)


def check_octave(octave) -> int:
    if octave not in OCTAVES:
        raise ValueError(f"octave {octave!r} is not one of {list(OCTAVES)}")
    return int(octave)


def parse_key(key: str) -> tuple[str, str]:
    """(root, "major" | "minor") of a key like "C", "Bb", "F#m", "A minor"."""
    m = re.fullmatch(r"([A-G][#b]?)\s*(m|min|minor|maj|major)?", key.strip()) if isinstance(key, str) else None
    if m is None or m.group(1) not in ROOTS:
        raise ValueError(f"key {key!r} is not a key like 'C', 'Bb', 'F#m' or 'A minor'")
    return m.group(1), "minor" if m.group(2) in ("m", "min", "minor") else "major"


def scale(key: str) -> tuple[int, ...]:
    """Pitch classes of the key's scale (natural minor for a minor key), starting at the root."""
    root, mode = parse_key(key)
    return tuple((ROOTS[root] + step) % 12 for step in (MINOR if mode == "minor" else MAJOR))


class Clock:
    """A recording's time (seconds) <-> our section's beats, piecewise linear through anchor points."""

    def __init__(self, seconds, beats):
        if len(seconds) < 2 or len(seconds) != len(beats):
            raise ValueError(f"a clock needs at least two anchors, got {len(seconds)} seconds / {len(beats)} beats")
        if any(y <= x for x, y in zip(seconds, seconds[1:])) or any(y <= x for x, y in zip(beats, beats[1:])):
            raise ValueError(f"clock anchors must increase: seconds {seconds}, beats {beats}")
        self.xs, self.ys = np.asarray(seconds, dtype=float), np.asarray(beats, dtype=float)

    @classmethod
    def grid(cls, bpm, hours: float = 1.0):
        """Our grid itself: beat 0 at 0 s, at `bpm`."""
        return cls([0.0, hours * 3600.0], [0.0, hours * 3600.0 * bpm / 60.0])

    def beats(self, t):
        return np.interp(t, self.xs, self.ys)

    def seconds(self, b):
        return np.interp(b, self.ys, self.xs)
