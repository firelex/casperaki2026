"""Step 1 of the SwiftF0 front end, no training: better pitch-curve-to-notes.

The pipeline (all steps optional, see Config):
  1. tuning offset: the hummer's overall detune (or slowly drifting detune), estimated from the notes' distance to
     the semitone grid, is subtracted from the pitch curve before notes are made and rounded;
  2. key snapping: a key is estimated from the notes (Krumhansl-Schmuckler profiles, duration weighted) or given;
     notes whose pitch is close to the middle between two semitones go to the neighbour that is in the scale;
  3. note splitting: besides silences and pitch changes, notes split at energy onsets (log-mel spectral flux
     peaks), short pitch segments at the start of a note (scoops) merge into it, and the minimum note length is a
     fraction of the beat (tempo from librosa's estimate, or from the labelled beat grid when one is given; with
     the grid, onsets close to grid sixteenths count more).
"""
from dataclasses import dataclass, field

import numpy as np

from .core import hz_to_midi
from .models import _load

MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
MAJOR_SCALE = np.array([0, 2, 4, 5, 7, 9, 11])
MINOR_SCALE = np.array([0, 2, 3, 5, 7, 8, 10])


@dataclass
class Config:
    # 1. tuning offset
    tuning: str = "none"  # none | global | drift
    drift_sigma_s: float = 4.0  # Gaussian time window of the drift fit
    # 2. key snapping
    key: str = "none"  # none | estimated | true
    snap_margin: float = 0.2  # notes within this many semitones of the midpoint between two semitones are ambiguous
    # 3. splitting
    split: str = "basic"  # basic (hum_pitch.core.segment_notes rules) | improved
    grid: bool = False  # improved splitting with the labelled beat grid
    onset_delta: float = 0.5  # an onset-strength peak counts when it exceeds the local mean by this (in clip-normalised units)
    grid_weight: float = 1.0  # with the grid: onset strength x (1 + weight) on a sixteenth, falling off over 30 ms
    scoop_max_s: float = 0.12  # shorter pitch segments that glide into the next note (or away from the last) merge into it
    glide_min_st: float = 0.5  # ... gliding = the segment ends at least this many semitones closer to the note than it starts
    min_note_beats: float = 0.2  # minimum note length as a fraction of a beat ...
    min_note_s: float = 0.06  # ... and never shorter than this
    # shared with the basic segmentation
    silence_db: float = 40.0
    max_gap_s: float = 0.03
    split_semitones: float = 0.7
    hold_s: float = 0.05
    basic_min_note_s: float = 0.08
    extra: dict = field(default_factory=dict)


def _runs(mask):
    d = np.diff(np.concatenate([[0], mask.astype(np.int8), [0]]))
    return list(zip(np.flatnonzero(d == 1), np.flatnonzero(d == -1)))


def load_curve(clip_id: str):
    c = _load("swiftf0", clip_id)
    f0 = c["f0_hz"].astype(float)
    voiced = c["voiced"].astype(bool) & np.isfinite(f0) & (f0 > 0)
    midi = np.full_like(f0, np.nan)
    midi[voiced] = hz_to_midi(f0[voiced])
    return c["times"], midi, voiced, c["level_db"]


def sounding(times, midi, voiced, level_db, cfg: Config) -> np.ndarray:
    hop = float(np.median(np.diff(times)))
    on = voiced & np.isfinite(midi) & (level_db > level_db.max() - cfg.silence_db)
    gap_max = int(round(cfg.max_gap_s / hop))
    for a, b in _runs(~on):
        if a > 0 and b < len(on) and b - a <= gap_max:
            on[a:b] = True
    return on


def pitch_segments(seg: np.ndarray, hold: int, split_st: float) -> list[int]:
    """Start indices (within one sounding run) where the pitch moved away from the current note's centre by more
    than split_st semitones and stayed away for at least hold frames."""
    starts, centre_frames = [0], [seg[0]]
    i, n = 1, len(seg)
    while i < n:
        centre = float(np.median(centre_frames))
        if abs(seg[i] - centre) > split_st:
            j = i
            while j < n and abs(seg[j] - centre) > split_st:
                j += 1
            if j - i >= hold:
                starts.append(i)
                centre_frames = [seg[i]]
                i += 1
                continue
            i = j
            continue
        centre_frames.append(seg[i])
        i += 1
    return starts


def _fill(seg):
    bad = ~np.isfinite(seg)
    if bad.any():
        good = np.flatnonzero(~bad)
        for i in np.flatnonzero(bad):
            prev = good[good < i]
            seg[i] = seg[prev[-1]] if len(prev) else seg[good[0]]
    return seg


def onset_frames(clip_id: str, times: np.ndarray, beats: np.ndarray | None, cfg: Config) -> tuple[np.ndarray, float]:
    """Frame indices (on the pitch curve's frames) of energy onsets, and the beat period in seconds."""
    o = _load("onsets", clip_id)
    env = o["env"].astype(float)
    t = o["times"]
    env = env / (np.percentile(env, 95) + 1e-9)
    if cfg.grid:
        if beats is None or len(beats) < 2:
            raise ValueError(f"{clip_id}: grid splitting needs at least 2 labelled beats")
        period = float(np.median(np.diff(beats)))
        # sixteenth grid from the labelled beats, extended half a beat beyond both ends
        grid = np.concatenate([np.linspace(b0, b1, 5)[:-1] for b0, b1 in zip(beats[:-1], beats[1:])] + [[beats[-1]]])
        grid = np.concatenate([[beats[0] - period / 4, beats[0] - period / 2], grid, [beats[-1] + period / 4, beats[-1] + period / 2]])
        d = np.abs(t[:, None] - grid[None]).min(1)
        env = env * (1.0 + cfg.grid_weight * np.exp(-0.5 * (d / 0.03) ** 2))
    else:
        tempo = float(o["tempo_bpm"])
        if not tempo > 0:
            raise ValueError(f"{clip_id}: no tempo estimate")
        period = 60.0 / tempo
    # peaks: local maximum over +-30 ms and above the mean of the preceding 100 ms plus delta
    w = 3
    peaks = []
    for i in range(1, len(env) - 1):
        lo, hi = max(0, i - w), min(len(env), i + w + 1)
        if env[i] == env[lo:hi].max() and env[i] >= env[max(0, i - 10):i + 1].mean() + cfg.onset_delta:
            if not peaks or t[i] - t[peaks[-1]] > 0.05:
                peaks.append(i)
    on_t = t[peaks] if peaks else np.zeros(0)
    return np.searchsorted(times, on_t), period


def segment_improved(clip_id, times, midi, voiced, level_db, cfg: Config, beats=None) -> list[list]:
    """[[onset_s, offset_s, fractional_midi], ...] with the improved splitting rules."""
    hop = float(np.median(np.diff(times)))
    on = sounding(times, midi, voiced, level_db, cfg)
    hold = max(1, int(round(cfg.hold_s / hop)))
    onsets, period = onset_frames(clip_id, times, beats, cfg)
    min_len = max(cfg.min_note_s, cfg.min_note_beats * period)
    min_gap = max(1, int(round(0.06 / hop)))
    notes = []
    for a, b in _runs(on):
        seg = _fill(midi[a:b].copy())
        # boundaries: (index within run, kind) kind = "pitch" or "onset"
        bounds = {s: "pitch" for s in pitch_segments(seg, hold, cfg.split_semitones)[1:]}
        for f in onsets:
            k = int(f) - a
            if min_gap <= k <= len(seg) - min_gap and all(abs(k - x) >= min_gap for x in bounds):
                bounds[k] = "onset"
        cuts = sorted(bounds)
        edges = [0] + cuts + [len(seg)]
        kinds = ["start"] + [bounds[c] for c in cuts]  # how each segment begins
        segs = [[edges[i], edges[i + 1], kinds[i]] for i in range(len(edges) - 1)]
        def ends(s, e):
            n = max(1, min(3, (e - s) // 3))
            return float(np.median(seg[s:s + n])), float(np.median(seg[e - n:e]))

        def centre(s, e):
            body = seg[s:e]
            return float(np.median(body[int(0.2 * len(body)):] if len(body) >= 5 else body))

        # scoops: a short segment that glides into the next one across a pitch boundary merges into it (keeps its start)
        merged = []
        i = 0
        while i < len(segs):
            s, e, k = segs[i]
            if (e - s) * hop < cfg.scoop_max_s and i + 1 < len(segs) and segs[i + 1][2] == "pitch":
                first, last = ends(s, e)
                p_next = centre(segs[i + 1][0], segs[i + 1][1])
                if abs(last - p_next) <= abs(first - p_next) - cfg.glide_min_st:
                    segs[i + 1] = [s, segs[i + 1][1], k]
                    i += 1
                    continue
            merged.append([s, e, k])
            i += 1
        # falls: a short segment gliding away from the previous note (after a pitch boundary, before a silence or an
        # onset) merges into the previous one
        out = []
        for idx, (s, e, k) in enumerate(merged):
            nxt_kind = merged[idx + 1][2] if idx + 1 < len(merged) else "end"
            if out and k == "pitch" and (e - s) * hop < cfg.scoop_max_s and nxt_kind != "pitch":
                first, last = ends(s, e)
                p_prev = centre(out[-1][0], out[-1][1])
                if abs(last - p_prev) >= abs(first - p_prev) + cfg.glide_min_st:
                    out[-1][1] = e
                    continue
            out.append([s, e, k])
        for s, e, k in out:
            body = seg[s:e]
            # pitch: median of the middle of the note (skip the first 20% for any remaining scoop)
            core = body[int(0.2 * len(body)):] if len(body) >= 5 else body
            notes.append([float(times[a + s]), float(times[a + e - 1] + hop), float(np.median(core)), k])
    res = []
    for on_s, off_s, m, k in notes:
        if off_s - on_s < min_len:
            continue
        if res and k == "pitch" and int(round(res[-1][2])) == int(round(m)) and abs(res[-1][1] - on_s) < 1e-9:
            res[-1][1] = off_s
            continue
        res.append([on_s, off_s, m])
    return res


def segment_basic(times, midi, voiced, level_db, cfg: Config) -> list[list]:
    """hum_pitch.core.segment_notes, but keeping the fractional pitch (median) of each note."""
    hop = float(np.median(np.diff(times)))
    on = sounding(times, midi, voiced, level_db, cfg)
    hold = max(1, int(round(cfg.hold_s / hop)))
    notes = []
    for a, b in _runs(on):
        seg = _fill(midi[a:b].copy())
        st = pitch_segments(seg, hold, cfg.split_semitones) + [len(seg)]
        for s, e in zip(st[:-1], st[1:]):
            notes.append([float(times[a + s]), float(times[a + e - 1] + hop), float(np.median(seg[s:e]))])
    out = []
    for on_s, off_s, m in notes:
        if off_s - on_s < cfg.basic_min_note_s:
            continue
        if out and int(round(out[-1][2])) == int(round(m)) and abs(out[-1][1] - on_s) < 1e-9:
            out[-1][1] = off_s
        else:
            out.append([on_s, off_s, m])
    return out


def tuning_offset(notes: list[list], cfg: Config) -> callable:
    """Function time -> detune in semitones (the hummer's distance from the semitone grid)."""
    if not notes:
        return lambda t: np.zeros_like(np.asarray(t, dtype=float))
    a = np.asarray(notes, dtype=float)
    mid_t = (a[:, 0] + a[:, 1]) / 2
    w = a[:, 1] - a[:, 0]
    z = np.exp(2j * np.pi * a[:, 2])  # phase on the semitone circle
    if cfg.tuning == "global":
        off = np.angle(np.sum(w * z)) / (2 * np.pi)
        return lambda t: np.full_like(np.asarray(t, dtype=float), off)
    if cfg.tuning == "drift":
        kern = np.exp(-0.5 * ((mid_t[:, None] - mid_t[None]) / cfg.drift_sigma_s) ** 2) * w[None]
        ph = np.unwrap(np.angle(kern @ z))
        ph = ph - 2 * np.pi * np.round(ph[0] / (2 * np.pi))  # start inside +-half a semitone
        off = ph / (2 * np.pi)
        return lambda t: np.interp(t, mid_t, off)
    raise ValueError(f"unknown tuning mode {cfg.tuning}")


def estimate_key(pcs: np.ndarray, weights: np.ndarray) -> tuple[int, str]:
    """(tonic pitch class, 'major'|'minor') by Krumhansl-Schmuckler correlation of the duration-weighted pitch-class histogram."""
    h = np.bincount(pcs % 12, weights=weights, minlength=12)
    if h.sum() == 0:
        raise ValueError("no notes to estimate a key from")
    best, arg = -np.inf, None
    for mode, prof in (("major", MAJOR), ("minor", MINOR)):
        for tonic in range(12):
            r = np.corrcoef(h, np.roll(prof, tonic))[0, 1]
            if r > best:
                best, arg = r, (tonic, mode)
    return arg


def scale_set(tonic: int, mode: str) -> set:
    return set(((MAJOR_SCALE if mode == "major" else MINOR_SCALE) + tonic) % 12)


def curve_from_features(feat: np.ndarray):
    """The SwiftF0 curve as load_curve returns it, rebuilt from a scripts/features.py row block (16 ms frames; level
    relative to the clip's loudest frame, which is all the silence gate uses)."""
    times = np.arange(len(feat)) * 0.016
    voiced = feat[:, 1] > 0.5
    midi = np.where(voiced, feat[:, 0], np.nan)
    return times, midi, voiced, feat[:, 3].astype(float) * 40.0


def transcribe(row: dict, cfg: Config, curve=None) -> list[list]:
    """Notes [[onset_s, offset_s, midi_int], ...] for one clip under cfg; the SwiftF0 curve comes from the predict.py
    cache unless given (curve_from_features)."""
    times, midi, voiced, level_db = load_curve(row["id"]) if curve is None else curve
    beats = None
    if cfg.grid:
        beats = np.loadtxt(row["wav"][:-4] + ".beats", ndmin=2)[:, 0]
    seg = (lambda m: segment_improved(row["id"], times, m, voiced, level_db, cfg, beats)) if cfg.split == "improved" else \
          (lambda m: segment_basic(times, m, voiced, level_db, cfg))
    notes = seg(midi)
    if cfg.tuning != "none":
        off = tuning_offset(notes, cfg)
        notes = seg(midi - off(times))
    if cfg.key == "none" or not notes:
        return [[a, b, int(round(m))] for a, b, m in notes]
    if cfg.key == "estimated":
        a = np.asarray(notes, dtype=float)
        tonic, mode = estimate_key(np.round(a[:, 2]).astype(int), a[:, 1] - a[:, 0])
    elif cfg.key == "true":
        r = np.asarray(row["notes"], dtype=float)
        tonic, mode = estimate_key(r[:, 2].astype(int), r[:, 1] - r[:, 0])
    else:
        raise ValueError(f"unknown key mode {cfg.key}")
    sc = scale_set(tonic, mode)
    out = []
    for a, b, m in notes:
        lo = int(np.floor(m))
        frac = m - lo
        p = int(round(m))
        if abs(frac - 0.5) <= cfg.snap_margin:
            cand = [x for x in (lo, lo + 1) if x % 12 in sc]
            if len(cand) == 1:
                p = cand[0]
        out.append([a, b, p])
    return out
