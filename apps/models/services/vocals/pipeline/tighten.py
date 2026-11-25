"""Score-aligned tightening of a sung take (owner-approved 2026-11-25 on Tangerine Sidewalk: "much better"): every
phrase is put on the score on its own, note by note, by time-stretching the audio between the notes' found starts
(Signalsmith Stretch, MIT, through python-stretch). Pitch is kept; only timing changes.

SoulX sings each phrase separately (pipeline.soulx.phrase_groups), so each phrase has its own timing error (the owner
heard "Morning bakes the brick walls" start late). A note's start is where its vowel arrives: the first frames at the
note's pitch (pyin), where the beat sits in singing, consonants and breaths before it. A note whose vowel is not
found clearly (e.g. tied on from the same pitch) moves by its own phrase's median offset, so a phrase's soft first note never leaves the phrase late; a phrase with no note
found is left as it is. Every stretch factor stays within [MIN_FACTOR, MAX_FACTOR]; a note too far off for that (or
on the take's very first instant, with no audio before it) moves only as far as the limits allow.
"""
from __future__ import annotations

import librosa
import numpy as np
import python_stretch as ps

ANALYSIS_SR, HOP = 22050, 64
WINDOW_S = 0.12
MIN_FACTOR, MAX_FACTOR = 0.6, 1.6
MIN_MOVE_S = 0.008  # anchors closer than this to their score time are left where they are
FADE_S = 0.005
# A vowel: the sung pitch within PITCH_TOL semitones of the note for VOWEL_HOLD frames; pyin's centred frames see it
# VOWEL_LAG_S late on average (synthetic notes after silence and legato: -5.7..+6.7 ms, median about +1 ms).
PITCH_TOL, VOWEL_HOLD = 0.5, 3
# A short pitch window (23 ms at 22.05 kHz): a centred window hears a vowel half its length before it starts.
PITCH_FRAME = 512
VOWEL_LAG_S = 0.001


def analysis(y: np.ndarray, sr: int) -> tuple[np.ndarray, np.ndarray]:
    """(frame times, sung pitch in MIDI per frame, NaN where unvoiced)."""
    x = librosa.resample(y, orig_sr=sr, target_sr=ANALYSIS_SR) if sr != ANALYSIS_SR else y
    if not np.any(np.abs(x) > 1e-4):
        raise ValueError("tighten: the take is silent")
    f0, voiced, _ = librosa.pyin(x, fmin=librosa.note_to_hz("C3"), fmax=librosa.note_to_hz("C6"), sr=ANALYSIS_SR,
                                 frame_length=PITCH_FRAME, hop_length=HOP)
    midi = np.where(voiced & np.isfinite(f0), librosa.hz_to_midi(np.nan_to_num(f0, nan=1.0)), np.nan)
    return librosa.frames_to_time(np.arange(len(midi)), sr=ANALYSIS_SR, hop_length=HOP), midi


def vowel_start(t: np.ndarray, midi: np.ndarray, m: np.ndarray, target: float, prev: float | None = None) -> float | None:
    """The first frame in the window `m` where the sung pitch arrives at `target` (within PITCH_TOL semitones, and
    nearer to it than to the previous note's pitch `prev`, for VOWEL_HOLD frames, coming from another pitch or
    silence), less the analysis lag; None when it does not."""
    idx = np.flatnonzero(m)
    sung = np.nan_to_num(midi, nan=-99.0)
    near = np.abs(sung - target) <= PITCH_TOL
    if prev is not None and prev != target:
        near &= np.abs(sung - target) < np.abs(sung - prev)
    for k in idx:
        if k + VOWEL_HOLD > len(near) or not near[k:k + VOWEL_HOLD].all():
            continue
        if k > 0 and near[k - 1]:
            continue
        return float(t[k]) - VOWEL_LAG_S
    return None


def anchors(y: np.ndarray, sr: int, notes: list[dict], bpm: float) -> list[tuple[float, float]]:
    """[(time in the take, score time)] for the notes, phrase by phrase, plus the take's two ends.
    notes: [{"start", "duration" (beats from the take's start), "midi"}]."""
    from .soulx import phrase_groups

    t, midi = analysis(y, sr)
    beat = 60.0 / float(bpm)
    end = len(y) / sr
    ns = sorted(notes, key=lambda n: float(n["start"]))
    times = [float(n["start"]) * beat for n in ns]
    found: list[float | None] = []
    for i, n in enumerate(ns):
        s = times[i]
        before = s - times[i - 1] if i else WINDOW_S * 2
        after = times[i + 1] - s if i + 1 < len(times) else WINDOW_S * 2
        w = min(WINDOW_S, 0.45 * before, 0.45 * after)
        m = (t >= s - w) & (t <= s + w)
        if not m.any():
            found.append(None)
            continue
        found.append(vowel_start(t, midi, m, float(n["midi"]), float(ns[i - 1]["midi"]) if i else None))
    # A note not found moves with its own phrase.
    position = {id(n): i for i, n in enumerate(ns)}
    source: list[float | None] = list(found)
    for group in phrase_groups(ns):
        ix = [position[id(n)] for n in group]
        offs = [found[i] - times[i] for i in ix if found[i] is not None]
        if not offs:
            continue
        shift = float(np.median(offs))
        for i in ix:
            if source[i] is None:
                source[i] = times[i] + shift
    out = [(0.0, 0.0)]
    for i, f in enumerate(source):
        if f is None:
            continue
        s = times[i]
        if abs(f - s) < MIN_MOVE_S:
            f = s
        a0, s0 = out[-1]
        if f <= a0:
            continue
        # A note too far off for the stretch limits (or at the take's very start, with no audio before it to pull in)
        # moves as far as the limits allow towards the score.
        target = min(max(s, s0 + (f - a0) / MAX_FACTOR), s0 + (f - a0) / MIN_FACTOR)
        if target <= s0:
            continue
        out.append((f, target))
    a0, s0 = out[-1]
    if end - a0 > 0 and end - s0 > 0 and MIN_FACTOR <= (end - a0) / (end - s0) <= MAX_FACTOR:
        out.append((end, end))
    else:
        out.append((end, s0 + (end - a0)))
    return out


def apply(y: np.ndarray, sr: int, anc: list[tuple[float, float]]) -> np.ndarray:
    """The take re-timed: each stretch between anchors stretched to its target length (with FADE_S of context on each
    side, crossfaded at the joins)."""
    total = int(round(anc[-1][1] * sr))
    out = np.zeros(total + int(FADE_S * sr) * 4, dtype=np.float32)
    pad = int(0.05 * sr)
    fade = int(FADE_S * sr)
    for (a0, s0), (a1, s1) in zip(anc, anc[1:]):
        i0, i1 = int(round(a0 * sr)), int(round(a1 * sr))
        o0, o1 = int(round(s0 * sr)), int(round(s1 * sr))
        if i1 <= i0 or o1 <= o0:
            continue
        lo, hi = max(0, i0 - pad), min(len(y), i1 + pad)
        seg = y[lo:hi].astype(np.float32)
        factor = (i1 - i0) / (o1 - o0)
        if abs(factor - 1) < 1e-4:
            st_out = seg
        else:
            st = ps.Signalsmith.Stretch()
            st.preset(1, sr)
            st.setTimeFactor(factor)
            st_out = st.process(seg[None, :])[0]
        # The part of the stretched segment that is [i0, i1] of the source, with `fade` extra on each side.
        k0 = int(round((i0 - lo) / factor))
        piece = st_out[max(0, k0 - fade): k0 + (o1 - o0) + fade]
        start = o0 - min(fade, k0)
        ramp = np.ones(len(piece), dtype=np.float32)
        n_in = min(fade, k0) * 2
        if n_in:
            ramp[:n_in] = np.linspace(0, 1, n_in, dtype=np.float32)
        n_out = min(fade * 2, len(piece))
        ramp[-n_out:] *= np.linspace(1, 0, n_out, dtype=np.float32)
        if start < 0:
            piece, ramp, start = piece[-start:], ramp[-start:], 0
        out[start:start + len(piece)] += piece * ramp
    return out[:total]


def tighten(y: np.ndarray, sr: int, notes: list[dict], bpm: float) -> tuple[np.ndarray, list[tuple[float, float]]]:
    anc = anchors(y, sr, notes, bpm)
    return apply(y, sr, anc), anc
