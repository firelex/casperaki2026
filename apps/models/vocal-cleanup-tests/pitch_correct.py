"""Experiment (2026-11-26): pitch correction of a cleaned recording onto its transcribed notes.
correction_curve(): the sung pitch pulled towards each note's pitch by `strength`, the pull eased in with time
constant `ease_s` (no snapping at note changes); outside notes the pitch is left alone.
world(): the correction applied with the WORLD vocoder (timbre kept).
Usage: .venv/bin/python pitch_correct.py <cleaned.wav> <notes.json> <out_dir>"""
import json, sys
from pathlib import Path
import numpy as np, soundfile as sf

SETTINGS = {"natural": (0.7, 0.06), "medium": (0.9, 0.035), "tight": (1.0, 0.02)}


def correction_curve(f0_hz, frame_s, notes, strength, ease_s):
    """f0 (Hz per frame, 0 = unvoiced) -> corrected f0. notes: [{onsetSec, offsetSec, midi}]."""
    t = np.arange(len(f0_hz)) * frame_s
    voiced = f0_hz > 0
    m = np.where(voiced, 69 + 12 * np.log2(np.maximum(f0_hz, 1e-6) / 440.0), np.nan)
    target = np.full(len(m), np.nan)
    for n in notes:
        target[(t >= n["onsetSec"]) & (t < n["offsetSec"])] = n["midi"]
    want = np.where(voiced & np.isfinite(target), (target - m) * strength, 0.0)
    # ease the correction in and out (one-pole smoothing, forward and back: no lag)
    a = np.exp(-frame_s / ease_s)
    def smooth(x):
        y = np.empty_like(x); acc = 0.0
        for i, v in enumerate(x):
            acc = a * acc + (1 - a) * v; y[i] = acc
        return y
    corr = (smooth(want) + smooth(want[::-1])[::-1]) / 2
    out = np.where(voiced, 440.0 * 2 ** ((m + corr - 69) / 12), 0.0)
    return np.nan_to_num(out)


def world(y, sr, notes, strength, ease_s):
    import pyworld as pw
    x = y.astype(np.float64)
    f0, t = pw.harvest(x, sr, f0_floor=65, f0_ceil=1000, frame_period=5.0)
    sp = pw.cheaptrick(x, f0, t, sr)
    ap = pw.d4c(x, f0, t, sr)
    f1 = correction_curve(f0, 0.005, notes, strength, ease_s)
    return pw.synthesize(f1, sp, ap, sr, frame_period=5.0).astype(np.float32)[: len(y)]


if __name__ == "__main__":
    src, notes_path, out = sys.argv[1], sys.argv[2], Path(sys.argv[3]); out.mkdir(parents=True, exist_ok=True)
    y, sr = sf.read(src, always_2d=True); y = y.mean(1)
    notes = json.load(open(notes_path))
    for name, (s, e) in SETTINGS.items():
        sf.write(out / f"world_{name}.wav", world(y, sr, notes, s, e), sr); print("world", name, "done", flush=True)
