"""A new singer's recording made into a voice reference: its silences cut, then about 10 s of it chosen.

Loudness per 20 ms frame (RMS), in dB against the recording's loud level (the 95th percentile of the frames' RMS):
- silence: a frame more than SILENT_DB under it; a sound shorter than MIN_SOUND_S between silences (a click, a breath
  noise) counts as silence;
- a pause (between phrases): at least MIN_PAUSE_S of frames more than PAUSE_DB under it. Sung "la la la" runs on
  legato (its notes rarely fall 40 dB between them), but between phrases the voice falls 25-60 dB for 0.2-0.4 s
  (the owner's recording, 2026-11-26).

1. `cut_silence` (always, the owner's rule): the silence before the first singing and after the last is cut to
   EDGE_S, and every silence inside longer than MAX_PAUSE_S is shortened to MAX_PAUSE_S (half of it kept after the
   singing before, half before the singing after, so breaths and note endings stay), joined with short crossfades.
2. `phrases`: the cut voice's stretches of singing, separated by pauses (natural pauses).
3. `choose_reference`: the voice reference, REF_MIN_S to REF_MAX_S long (about REF_TARGET_S), from a phrase start to
   a phrase end, so it always ends at a pause (SoulX-Singer copies how its reference ends, quiet tail included):
   - "beginning": from the first phrase, ending at the phrase end nearest REF_TARGET_S;
   - "best": the stretch of the most continuous singing anywhere (the largest share of singing frames), ties to the
     one nearer REF_TARGET_S, then the earlier one.
   The clip (`clip`) reaches from its first phrase back, and from its last phrase on, to where the voice falls into
   silence (but never past the middle of the pause, and at most PAD_S outside the recording's edges), with FADE_S
   fades: so the reference ends on the sound dying away, then nothing.
"""
from __future__ import annotations

import numpy as np

HOP_S = 0.02
SILENT_DB = -40.0
PAUSE_DB = -20.0
LOUD_PERCENTILE = 95
MIN_SOUND_S = 0.1
EDGE_S = 0.1
MAX_PAUSE_S = 0.4
JOIN_FADE_S = 0.01
MIN_PAUSE_S = 0.15
REF_MIN_S, REF_TARGET_S, REF_MAX_S = 8.0, 10.0, 12.0
PAD_S, FADE_S = 0.05, 0.03
CHOICES = ("beginning", "best")
CHOICE_LABELS = {"beginning": "the beginning", "best": "the best stretch"}


def _mono(x: np.ndarray) -> np.ndarray:
    x = np.asarray(x, dtype=np.float32)
    return x if x.ndim == 1 else x.mean(axis=1)


def frame_db(x: np.ndarray, sr: int) -> np.ndarray:
    """Per HOP_S frame, its loudness in dB against the recording's loud level."""
    x = _mono(x)
    hop = int(round(HOP_S * sr))
    n = len(x) // hop
    if n == 0:
        raise ValueError("The recording is too short to hold any singing.")
    rms = np.sqrt(np.mean(np.square(x[: n * hop].reshape(n, hop), dtype=np.float64), axis=1))
    loud = float(np.percentile(rms, LOUD_PERCENTILE))
    if loud <= 1e-6:
        raise ValueError("The recording is silent.")
    return 20 * np.log10(np.maximum(rms, 1e-12) / loud)


def singing_mask(x: np.ndarray, sr: int, under_db: float = SILENT_DB) -> np.ndarray:
    """Per HOP_S frame, whether the voice sounds: louder than `under_db` against the loud level (SILENT_DB: not
    silence; PAUSE_DB: not a pause), sounds shorter than MIN_SOUND_S left out."""
    mask = frame_db(x, sr) > under_db
    min_sound = int(round(MIN_SOUND_S / HOP_S))
    for a, b in runs(mask):
        if b - a < min_sound:
            mask[a:b] = False
    if not mask.any():
        raise ValueError("No singing was found in the recording.")
    return mask


def runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """The [start, end) frame ranges where `mask` is True."""
    m = np.concatenate([[False], np.asarray(mask, bool), [False]])
    d = np.diff(m.astype(np.int8))
    return list(zip(np.flatnonzero(d == 1).tolist(), np.flatnonzero(d == -1).tolist()))


def cut_silence(x: np.ndarray, sr: int):
    """The recording (mono) with its silences cut, and the kept pieces as [(start, end)] in seconds of the recording
    (to tell where a time of the cut voice was in the recording: `recording_time`)."""
    x = _mono(x)
    mask = singing_mask(x, sr)
    hop = int(round(HOP_S * sr))
    sung = runs(mask)
    half = int(round(MAX_PAUSE_S / 2 / HOP_S))
    edge = int(round(EDGE_S / HOP_S))
    pieces = []  # frame ranges kept
    start = max(0, sung[0][0] - edge)
    for (a0, b0), (a1, b1) in zip(sung, sung[1:]):
        if a1 - b0 > 2 * half:
            pieces.append((start, b0 + half))
            start = a1 - half
    pieces.append((start, min(len(mask), sung[-1][1] + edge)))
    fade = int(round(JOIN_FADE_S * sr))
    out = []
    for i, (a, b) in enumerate(pieces):
        seg = x[a * hop: b * hop].copy()
        if i > 0:
            seg[:fade] *= np.linspace(0, 1, fade, dtype=np.float32)
        if i + 1 < len(pieces):
            seg[-fade:] *= np.linspace(1, 0, fade, dtype=np.float32)
        out.append(seg)
    return np.concatenate(out), [(a * HOP_S, b * HOP_S) for a, b in pieces]


def recording_time(t: float, pieces) -> float:
    """Where the time `t` (s) of the cut voice was in the recording."""
    at = 0.0
    for a, b in pieces:
        if t <= at + (b - a) + 1e-9:
            return a + (t - at)
        at += b - a
    raise ValueError(f"{t:.2f} s is past the end of the cut voice ({at:.2f} s)")


def phrases(x: np.ndarray, sr: int) -> list[tuple[float, float]]:
    """The stretches of singing (seconds), separated by pauses: MIN_PAUSE_S or more under PAUSE_DB."""
    mask = singing_mask(x, sr, PAUSE_DB)
    min_pause = int(round(MIN_PAUSE_S / HOP_S))
    out = []
    for a, b in runs(mask):
        if out and a - out[-1][1] < min_pause:
            out[-1] = (out[-1][0], b)
        else:
            out.append((a, b))
    return [(a * HOP_S, b * HOP_S) for a, b in out]


def choose_reference(phr, choice: str, sung=None) -> tuple[float, float]:
    """The voice reference's (start, end) in seconds of the cut voice, from phrase starts to phrase ends (see the
    module's description). `sung`: seconds of singing inside a range (default: the phrases' own lengths)."""
    if choice not in CHOICES:
        raise ValueError(f"The voice reference choice must be one of {list(CHOICES)}, not {choice!r}.")
    if not phr:
        raise ValueError("No singing was found in the recording.")
    total = sum(b - a for a, b in phr)
    if phr[-1][1] - phr[0][0] < REF_MIN_S:
        raise ValueError(f"The recording holds only {phr[-1][1] - phr[0][0]:.1f} s of singing once its silences are cut: "
                         f"a singer needs at least {REF_MIN_S:g} s.")
    if sung is None:
        def sung(a, b):
            return sum(max(0.0, min(b, y) - max(a, x)) for x, y in phr)
    starts = [0] if choice == "beginning" else range(len(phr))
    best = None
    for i in starts:
        for j in range(i, len(phr)):
            length = phr[j][1] - phr[i][0]
            if length > REF_MAX_S:
                break
            if length < REF_MIN_S:
                continue
            a, b = phr[i][0], phr[j][1]
            share = sung(a, b) / length if choice == "best" else 0.0
            key = (-share, abs(length - REF_TARGET_S), a)
            if best is None or key < best[0]:
                best = (key, a, b)
    if best is None:
        where = "from the start of the singing" if choice == "beginning" else "anywhere in the recording"
        raise ValueError(f"No stretch of {REF_MIN_S:g} to {REF_MAX_S:g} s that ends at a pause was found {where} "
                         f"({total:.1f} s of singing in {len(phr)} phrases): sing with a short pause now and then.")
    return best[1], best[2]


def clip(x: np.ndarray, sr: int, phr, start: float, end: float) -> tuple[np.ndarray, float, float]:
    """The voice reference cut from the cut voice for the phrases from `start` to `end`: reaching out from them to
    where the voice falls into silence (SILENT_DB), never past the middle of the pause beside them nor more than
    PAD_S past the recording's edges; faded in and out. Returns (the clip, its start, its end) in seconds."""
    x = _mono(x)
    db = frame_db(x, sr)
    total = len(x) / sr
    i = next(k for k, p in enumerate(phr) if abs(p[0] - start) < 1e-9)
    j = next(k for k, p in enumerate(phr) if abs(p[1] - end) < 1e-9)
    lo = (phr[i - 1][1] + start) / 2 if i > 0 else max(0.0, start - PAD_S)
    hi = (end + phr[j + 1][0]) / 2 if j + 1 < len(phr) else min(total, end + PAD_S)
    f = int(round(start / HOP_S))
    while f > 0 and (f - 1) * HOP_S >= lo and db[f - 1] > SILENT_DB:
        f -= 1
    a = max(lo, f * HOP_S)
    f = int(round(end / HOP_S))
    while f < len(db) and (f + 1) * HOP_S <= hi and db[f] > SILENT_DB:
        f += 1
    b = min(hi, f * HOP_S)
    y = x[int(round(a * sr)): int(round(b * sr))].copy()
    n = int(round(FADE_S * sr))
    y[:n] *= np.linspace(0, 1, n, dtype=np.float32)
    y[-n:] *= np.linspace(1, 0, n, dtype=np.float32)
    return y, a, b
