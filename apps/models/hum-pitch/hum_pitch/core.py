"""Shared pieces of the hum-pitch baseline: test sets, reference notes, note segmentation of a pitch curve, metrics.

A "set manifest" is a JSON Lines file, one clip per line:
  {"id", "set", "wav", "group", "lead", "notes": [[onset_s, offset_s, midi], ...], ...}
written by scripts/build_sets.py. Every model's notes are lists of [onset_s, offset_s, midi] with integer MIDI
(the app snaps to a key, so everything is scored in whole semitones).
"""
import json
from pathlib import Path

import mir_eval
import numpy as np

DATA = Path("/mnt/d/casperaki-data/hum-pitch")
SETS_DIR = DATA / "sets"
CACHE_DIR = DATA / "cache"

FMIN_HZ = 50.0  # about MIDI 31: below the lowest library bass note (MIDI 35)
FMAX_HZ = 1600.0  # about MIDI 91: above the highest child voice notes


def read_manifest(name: str) -> list[dict]:
    path = SETS_DIR / f"{name}.jsonl"
    if not path.exists():
        raise FileNotFoundError(f"set manifest {path} missing: run scripts/build_sets.py first")
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def hz_to_midi(hz: np.ndarray) -> np.ndarray:
    return 69.0 + 12.0 * np.log2(hz / 440.0)


def midi_to_hz(m: np.ndarray) -> np.ndarray:
    return 440.0 * 2.0 ** ((np.asarray(m, dtype=float) - 69.0) / 12.0)


def frame_rms_db(y: np.ndarray, sr: int, times: np.ndarray, win_s: float = 0.032) -> np.ndarray:
    """Level in dB of the win_s of audio centred on each time."""
    half = int(round(win_s * sr / 2))
    c = np.cumsum(np.concatenate([[0.0], y.astype(np.float64) ** 2]))
    idx = np.round(times * sr).astype(int)
    lo = np.clip(idx - half, 0, len(y))
    hi = np.clip(idx + half, 0, len(y))
    n = np.maximum(hi - lo, 1)
    return 10.0 * np.log10((c[hi] - c[lo]) / n + 1e-12)


# --------------------------------------------------------------------------------------------------------------
# Note segmentation of a frame-wise pitch curve (used for pYIN and SwiftF0 alike)
# --------------------------------------------------------------------------------------------------------------

SEG_DEFAULTS = {
    "silence_db": 40.0,  # frames quieter than the clip's loudest frame minus this count as silent
    "max_gap_s": 0.03,  # unvoiced gaps up to this long inside a note are bridged (tracker glitches)
    "split_semitones": 0.7,  # a new note starts when the pitch leaves the current note's centre by this much ...
    "hold_s": 0.05,  # ... for at least this long
    "min_note_s": 0.08,  # shorter notes are dropped
}


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """(start, end) index pairs (end exclusive) of the True runs."""
    d = np.diff(np.concatenate([[0], mask.astype(np.int8), [0]]))
    return list(zip(np.flatnonzero(d == 1), np.flatnonzero(d == -1)))


def segment_notes(times: np.ndarray, midi: np.ndarray, voiced: np.ndarray, level_db: np.ndarray, params: dict | None = None) -> list[list]:
    """Split a pitch curve into notes at silences and at pitch changes.

    times: frame times (s, evenly spaced); midi: pitch per frame (fractional MIDI, any value where unvoiced);
    voiced: the tracker's voicing decision; level_db: frame level (frame_rms_db).
    Returns [[onset_s, offset_s, midi_int], ...].
    """
    p = SEG_DEFAULTS | (params or {})
    unknown = set(p) - set(SEG_DEFAULTS)
    if unknown:
        raise ValueError(f"unknown segmentation parameters {sorted(unknown)}")
    if len(times) < 2:
        raise ValueError("pitch curve has fewer than 2 frames")
    hop = float(np.median(np.diff(times)))
    on = voiced & np.isfinite(midi) & (level_db > level_db.max() - p["silence_db"])
    # bridge short unvoiced gaps between voiced frames
    gap_max = int(round(p["max_gap_s"] / hop))
    for a, b in _runs(~on):
        if a > 0 and b < len(on) and b - a <= gap_max:
            on[a:b] = True
    hold = max(1, int(round(p["hold_s"] / hop)))
    notes = []
    for a, b in _runs(on):
        seg = midi[a:b].copy()
        bad = ~np.isfinite(seg)  # bridged frames: carry the last known pitch forward
        if bad.any():
            for i in np.flatnonzero(bad):
                seg[i] = seg[i - 1] if i > 0 else seg[np.flatnonzero(~bad)[0]]
        start, centre_frames = 0, [seg[0]]
        i, n = 1, len(seg)
        while i < n:
            centre = float(np.median(centre_frames))
            if abs(seg[i] - centre) > p["split_semitones"]:
                j = i
                while j < n and abs(seg[j] - centre) > p["split_semitones"]:
                    j += 1
                if j - i >= hold:  # the pitch moved away and stayed away: new note at i
                    notes.append((a + start, a + i, float(np.median(seg[start:i]))))
                    start, centre_frames = i, [seg[i]]
                    i += 1
                    continue
                i = j  # a short excursion (scoop, vibrato peak): stays in the note
                continue
            centre_frames.append(seg[i])
            i += 1
        notes.append((a + start, a + n, float(np.median(seg[start:n]))))
    out = []
    for s, e, m in notes:
        on_s, off_s = float(times[s]), float(times[e - 1] + hop)
        if off_s - on_s < p["min_note_s"]:
            continue
        mi = int(round(m))
        if out and out[-1][2] == mi and abs(out[-1][1] - on_s) < 1e-9:
            out[-1][1] = off_s  # contiguous notes that round to the same semitone are one note
        else:
            out.append([on_s, off_s, mi])
    return out


# --------------------------------------------------------------------------------------------------------------
# Metrics
# --------------------------------------------------------------------------------------------------------------

def _arrays(notes: list[list]) -> tuple[np.ndarray, np.ndarray]:
    if not notes:
        return np.zeros((0, 2)), np.zeros(0)
    a = np.asarray(notes, dtype=float)
    return a[:, :2], midi_to_hz(a[:, 2])


def clip_metrics(ref: list[list], est: list[list]) -> dict:
    """mir_eval note metrics plus pitch-identity shares for one clip.

    f_onset: note F with onset +-50 ms and pitch +-50 cents; f_onset_offset: also offset (mir_eval default:
    within 20% of the note's length or 50 ms). pitch_ok: share of reference notes that have an estimated note
    starting within +-100 ms with the same MIDI pitch (pitch class and octave). Reference notes left over are
    then paired with left-over estimated notes (onset +-100 ms, any pitch) to classify the error: octave
    (same pitch class, other octave), semitone (one semitone off), other pitch; reference notes with no
    estimated note near them are "missed".
    """
    if not ref:
        raise ValueError("clip has no reference notes")
    ri, rp = _arrays(ref)
    ei, ep = _arrays(est)
    n_ref = len(ref)
    out = {"n_ref": n_ref, "n_est": len(est)}
    if len(est) == 0:
        return out | {"f_onset": 0.0, "p_onset": 0.0, "r_onset": 0.0, "f_onset_offset": 0.0, "pitch_ok": 0.0,
                      "err_octave": 0.0, "err_semitone": 0.0, "err_other": 0.0, "missed": 1.0}
    p1, r1, f1, _ = mir_eval.transcription.precision_recall_f1_overlap(ri, rp, ei, ep, onset_tolerance=0.05, pitch_tolerance=50.0, offset_ratio=None)
    _, _, f2, _ = mir_eval.transcription.precision_recall_f1_overlap(ri, rp, ei, ep, onset_tolerance=0.05, pitch_tolerance=50.0, offset_ratio=0.2, offset_min_tolerance=0.05)
    good = mir_eval.transcription.match_notes(ri, rp, ei, ep, onset_tolerance=0.1, pitch_tolerance=50.0, offset_ratio=None)
    used_r = {i for i, _ in good}
    used_e = {j for _, j in good}
    rr = [i for i in range(n_ref) if i not in used_r]
    ee = [j for j in range(len(est)) if j not in used_e]
    octave = semitone = other = 0
    if rr and ee:
        pairs = mir_eval.transcription.match_notes(ri[rr], rp[rr], ei[ee], ep[ee], onset_tolerance=0.1, pitch_tolerance=np.inf, offset_ratio=None)
        for i, j in pairs:
            d = int(est[ee[j]][2]) - int(ref[rr[i]][2])
            if d % 12 == 0:
                octave += 1
            elif abs(d) == 1:
                semitone += 1
            else:
                other += 1
        matched_wrong = len(pairs)
    else:
        matched_wrong = 0
    return out | {"f_onset": f1, "p_onset": p1, "r_onset": r1, "f_onset_offset": f2, "pitch_ok": len(good) / n_ref,
                  "err_octave": octave / n_ref, "err_semitone": semitone / n_ref, "err_other": other / n_ref,
                  "missed": (len(rr) - matched_wrong) / n_ref}
