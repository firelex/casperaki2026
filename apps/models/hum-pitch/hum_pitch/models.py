"""Turn each model's cached raw output (scripts/predict.py) into notes [[onset_s, offset_s, midi_int], ...]."""
from pathlib import Path

import numpy as np

from .core import CACHE_DIR, hz_to_midi, segment_notes

BP_DEFAULT = {"onset": 0.5, "frame": 0.3, "min_note_ms": 127.70}  # basic_pitch.inference.predict defaults


def _load(model: str, clip_id: str) -> dict:
    path = CACHE_DIR / model / f"{clip_id}.npz"
    if not path.exists():
        raise FileNotFoundError(f"no cached {model} output for {clip_id} ({path}): run scripts/predict.py --model {model}")
    with np.load(path) as z:
        return {k: z[k] for k in z.files}


def basic_pitch_notes(clip_id: str, onset: float, frame: float, min_note_ms: float, out: dict | None = None) -> list[list]:
    """Basic Pitch's own note creation (as in basic_pitch.inference.predict: melodia trick on, onsets inferred,
    no frequency limits), from the cached network output."""
    from basic_pitch.constants import AUDIO_SAMPLE_RATE, FFT_HOP
    from basic_pitch.note_creation import model_frames_to_time, output_to_notes_polyphonic

    o = out if out is not None else _load("basic-pitch", clip_id)
    min_len = int(np.round(min_note_ms / 1000 * (AUDIO_SAMPLE_RATE / FFT_HOP)))
    notes = output_to_notes_polyphonic(o["note"], o["onset"], onset_thresh=onset, frame_thresh=frame, infer_onsets=True,
                                       min_note_len=min_len, min_freq=None, max_freq=None, melodia_trick=True)
    t = model_frames_to_time(o["contour"].shape[0])
    return sorted([[float(t[s]), float(t[e]), int(p)] for s, e, p, _amp in notes])


def curve_notes(model: str, clip_id: str, seg: dict | None = None) -> list[list]:
    """A pitch tracker's curve (pyin or swiftf0) split into notes by hum_pitch.core.segment_notes."""
    c = _load(model, clip_id)
    f0 = c["f0_hz"].astype(float)
    voiced = c["voiced"].astype(bool) & np.isfinite(f0) & (f0 > 0)
    midi = np.full_like(f0, np.nan)
    midi[voiced] = hz_to_midi(f0[voiced])
    return segment_notes(c["times"], midi, voiced, c["level_db"], seg)


def curve(model: str, clip_id: str) -> tuple[np.ndarray, np.ndarray]:
    """(times, fractional MIDI with NaN where unvoiced) of a pitch tracker's cached curve."""
    c = _load(model, clip_id)
    f0 = c["f0_hz"].astype(float)
    voiced = c["voiced"].astype(bool) & np.isfinite(f0) & (f0 > 0)
    midi = np.full_like(f0, np.nan)
    midi[voiced] = hz_to_midi(f0[voiced])
    return c["times"], midi
