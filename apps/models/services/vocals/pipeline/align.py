"""Put a YuE2 take on our bars by matching harmony (ChordNet chords), and cut the take's vocal to our bar grid.

Ported from apps/models/ace-vocal-tests/other-models/align_by_chords.py (shared tree):
1. Both the take and our unit as chord sequences on a half-beat grid at our tempo (root + major/minor).
2. Dynamic time warping (both may stretch, neither goes back): cost 0 same chord, 0.5 the take has no chord, 1 other.
   Step weights: a step along the take only (the take added something) pays half its cell's cost, so a stretch the
   take added is skipped rather than paired with our half-beats; a step along ours only (the take skipped something)
   pays its cell plus SKIP, so our bars are not piled onto one matching half-beat of the take; a tiny cost on
   non-diagonal steps keeps the path diagonal where a chord holds over several bars.
3. The path pairs each of our half-beats with a run of the take's half-beats; the cheapest of them count. A bar
   starts at the last stretch of cheapest half-beats of its first half-beat's run (nearest where the bar goes on) and
   ends after the first stretch of cheapest half-beats of its last half-beat's run (nearest where the bar came from),
   so stretches the take added before, inside a held chord or after a bar are left out. The last bar ends at most one
   bar after its start. A bar the take skipped (under half a bar) or dragged out (over MAX_STRETCH bars) maps to None,
   stays silent, and its half-beats count as not on our chord.
"""
from __future__ import annotations

import librosa
import numpy as np

STEP = 0.5  # beats per grid step
STEPS_PER_BAR = int(4 / STEP)
OFF_DIAGONAL = 0.01
ADDED_WEIGHT = 0.5
SKIP = 0.3
MAX_STRETCH = 2.2  # a bar longer than this many of our bars in the take is unusable
ROOTS = {"C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3, "E": 4, "F": 5, "F#": 6, "Gb": 6, "G": 7, "G#": 8,
         "Ab": 8, "A": 9, "A#": 10, "Bb": 10, "B": 11, "Cb": 11, "Fb": 4, "E#": 5, "B#": 0}


def our_key(chord: str) -> tuple[int, str]:
    """(root pitch class, "maj" | "min") of one of our chord names ("A#", "Am", "F9", "Cmaj7")."""
    root = chord[:2] if len(chord) > 1 and chord[1] in "#b" else chord[:1]
    if root not in ROOTS:
        raise ValueError(f"chord {chord!r}: unknown root")
    q = chord[len(root):]
    return ROOTS[root], "min" if q.startswith("m") and not q.startswith("maj") else "maj"


def chordnet_key(label: str):
    """(root, quality) of a ChordNet label ("C:maj", "A:min7", "G:maj/3"); None for N (no chord) or X (unknown)."""
    if ":" not in label:
        if label in ("N", "X"):
            return None
        raise ValueError(f"ChordNet label {label!r} is neither 'root:quality' nor N/X")
    root, q = label.split(":", 1)
    root = root.split("/")[0]
    if root not in ROOTS:
        raise ValueError(f"ChordNet label {label!r}: unknown root")
    return ROOTS[root], "min" if q.startswith("min") else "maj"


def align(chord_segments, expected_chords_per_beat, bpm):
    """chord_segments: [[label, start_s, end_s]] of the take (ChordNet); expected_chords_per_beat: our chord names,
    lead-in first. Returns (bar_map, match): bar_map[b] = (start_s, end_s) of our bar b in the take, or None when the
    take skipped it; match[i] = whether our half-beat i found its chord in the take."""
    if len(expected_chords_per_beat) % 4:
        raise ValueError(f"{len(expected_chords_per_beat)} beats of expected chords: want whole bars of 4")
    if not chord_segments:
        raise ValueError("the take has no chord segments")
    beat = 60.0 / bpm
    step_s = beat * STEP
    ours = [k for c in expected_chords_per_beat for k in [our_key(c)] * int(1 / STEP)]
    n_gen = int(chord_segments[-1][2] / step_s)
    if n_gen < 1:
        raise ValueError(f"the take is {chord_segments[-1][2]:.2f} s long: shorter than a half beat")
    gen = []
    for k in range(n_gen):
        t = (k + 0.5) * step_s
        seg = next((x for x in chord_segments if x[1] <= t < x[2]), None)
        gen.append(chordnet_key(seg[0]) if seg else None)
    cost = np.array([[0.0 if g == o else (0.5 if g is None else 1.0) for g in gen] for o in ours])
    # librosa's default steps: (1, 1) both, (0, 1) the take only, (1, 0) ours only.
    _, path = librosa.sequence.dtw(C=cost, backtrack=True, weights_mul=np.array([1.0, ADDED_WEIGHT, 1.0]),
                                   weights_add=np.array([0.0, OFF_DIAGONAL, OFF_DIAGONAL + SKIP]))
    path = path[::-1]
    runs: dict[int, list[int]] = {}
    for i, j in path:
        runs.setdefault(int(i), []).append(int(j))
    first, last, match = {}, {}, []
    for i in range(len(ours)):
        js = runs[i]
        best = min(cost[i, j] for j in js)
        blocks = []  # contiguous stretches of the cheapest half-beats, in path order
        for j in js:
            if cost[i, j] != best:
                continue
            if blocks and blocks[-1][-1] == j - 1:
                blocks[-1].append(j)
            else:
                blocks.append([j])
        first[i], last[i] = blocks[-1][0], blocks[0][-1]
        match.append(bool(best == 0))
    bar_s = 4 * beat
    n_bars = len(ours) // STEPS_PER_BAR
    bar_map = []
    for b in range(n_bars):
        s = first[b * STEPS_PER_BAR] * step_s
        e = (last[(b + 1) * STEPS_PER_BAR - 1] + 1) * step_s
        if b == n_bars - 1:
            e = min(e, s + bar_s)  # what the take plays after our last bar is not ours
        if e - s < bar_s / 2 or e - s > MAX_STRETCH * bar_s:
            bar_map.append(None)  # skipped, or sung at a pace no stretch makes usable: not on our chords
            match[b * STEPS_PER_BAR:(b + 1) * STEPS_PER_BAR] = [False] * STEPS_PER_BAR
        else:
            bar_map.append((s, e))
    return bar_map, match


def section_match(match, lead_bars: int, section_bars: int) -> float:
    """Share of the section's half-beats (after the lead-in, before the tail) on our chord."""
    sec = match[lead_bars * STEPS_PER_BAR:(lead_bars + section_bars) * STEPS_PER_BAR]
    if not sec:
        raise ValueError("no section half-beats after the lead-in")
    return float(np.mean(sec))


class Clock:
    """A take's time (seconds) <-> our section's beats, piecewise linear through anchor points."""

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


def take_clock(bar_map, from_bar: int) -> Clock:
    """The take's time as beats from our bar `from_bar`, anchored at every sung bar's start (and the last one's end).
    A stretch the take added after a bar counts as part of that bar: the take sings our words to its own rhythm, and
    words sung there belong between this bar line and the next (collapsing the stretch onto the bar line would pile
    them onto one 16th). A bar mapped to None is interpolated over."""
    sung = [(b, span) for b, span in enumerate(bar_map[from_bar:]) if span is not None]
    if not sung:
        raise ValueError("no bar of the section was found in the take")
    xs = [span[0] for _, span in sung] + [sung[-1][1][1]]
    ys = [4.0 * b for b, _ in sung] + [4.0 * (sung[-1][0] + 1)]
    return Clock(xs, ys)


def cut_bars(voc, sr: int, bar_map, bpm, from_bar: int, to_bar: int):
    """Our bars from `from_bar` up to `to_bar`, each the take's audio for that bar time-stretched to our bar length.
    voc: channels x samples. A bar mapped to None stays silent. Returns channels x samples."""
    beat = 60.0 / bpm
    bar_len = int(round(4 * beat * sr))
    bars = bar_map[from_bar:to_bar]
    out = np.zeros((voc.shape[0], bar_len * len(bars)), dtype=np.float32)
    fade = int(0.01 * sr)
    for b, span in enumerate(bars):
        if span is None:
            continue
        seg = voc[:, int(round(span[0] * sr)): int(round(span[1] * sr))]
        if seg.shape[1] < 2 * fade:
            raise ValueError(f"bar {from_bar + b}: the take ends before it ({span[0]:.2f}-{span[1]:.2f} s, "
                             f"take {voc.shape[1] / sr:.2f} s)")
        rate = seg.shape[1] / bar_len
        if abs(rate - 1) > 0.01:
            seg = np.stack([librosa.effects.time_stretch(np.ascontiguousarray(ch), rate=rate) for ch in seg])
        seg = seg[:, :bar_len].astype(np.float32, copy=True)
        seg[:, :fade] *= np.linspace(0, 1, fade, dtype=np.float32)
        seg[:, -fade:] *= np.linspace(1, 0, fade, dtype=np.float32)
        out[:, b * bar_len: b * bar_len + seg.shape[1]] = seg
    return out
