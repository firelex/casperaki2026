"""Choose Basic Pitch's onset threshold, frame threshold and minimum note length on HumTrans TRAIN recordings.

  python -I scripts/tune_basic_pitch.py --set humtrans-tune --workers 8

The tuning set (humtrans-tune) shares no recording and no piece with humtrans-test. A small grid around the
defaults (onset 0.5, frame 0.3, 127.7 ms) is scored by mean note F-measure with onset only (+-50 ms, +-50 cents)
against the octave-corrected references (scripts/fit_octaves.py); the best setting goes to
results/basic-pitch-tuned.json, the whole grid to results/basic-pitch-tuning.csv.
"""
import argparse
import csv
import itertools
import json
import os
import sys
from multiprocessing import Pool
from pathlib import Path

os.environ["CUDA_VISIBLE_DEVICES"] = ""

import numpy as np  # noqa: E402

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
from hum_pitch.core import clip_metrics  # noqa: E402
from hum_pitch.models import _load, basic_pitch_notes  # noqa: E402
from hum_pitch.sets import references  # noqa: E402

ONSET = [0.3, 0.4, 0.5, 0.6, 0.7]
FRAME = [0.2, 0.3, 0.4, 0.5]
MIN_NOTE_MS = [58.0, 90.0, 127.7, 180.0]
GRID = list(itertools.product(ONSET, FRAME, MIN_NOTE_MS))


def _clip(row: dict) -> list[dict]:
    out = _load("basic-pitch", row["id"])
    res = []
    for on, fr, ml in GRID:
        m = clip_metrics(row["notes"], basic_pitch_notes(row["id"], on, fr, ml, out))
        res.append({"onset": on, "frame": fr, "min_note_ms": ml, "f_onset": m["f_onset"], "f_onset_offset": m["f_onset_offset"],
                    "pitch_ok_notes": m["pitch_ok"] * m["n_ref"], "n_ref": m["n_ref"]})
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", default="humtrans-tune")
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()
    rows, excluded = references(args.set)
    print(f"{args.set}: {len(rows)} recordings ({len(excluded)} without a clear octave left out), {len(GRID)} settings")
    with Pool(args.workers) as pool:
        per_clip = pool.map(_clip, rows, chunksize=2)
    table = []
    for g, setting in enumerate(GRID):
        rs = [c[g] for c in per_clip]
        table.append({"onset": setting[0], "frame": setting[1], "min_note_ms": setting[2],
                      "f_onset": float(np.mean([r["f_onset"] for r in rs])), "f_onset_offset": float(np.mean([r["f_onset_offset"] for r in rs])),
                      "pitch_ok": sum(r["pitch_ok_notes"] for r in rs) / sum(r["n_ref"] for r in rs)})
    table.sort(key=lambda r: -r["f_onset"])
    res = HERE / "results"
    res.mkdir(exist_ok=True)
    with open(res / "basic-pitch-tuning.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(table[0]))
        w.writeheader()
        w.writerows({k: (round(v, 4) if isinstance(v, float) else v) for k, v in r.items()} for r in table)
    best = table[0]
    default = next(r for r in table if (r["onset"], r["frame"], r["min_note_ms"]) == (0.5, 0.3, 127.7))
    (res / "basic-pitch-tuned.json").write_text(json.dumps({"chosen_on": f"{args.set} ({len(rows)} HumTrans TRAIN recordings), mean onset-only note F",
                                                            "onset": best["onset"], "frame": best["frame"], "min_note_ms": best["min_note_ms"],
                                                            "tune_scores": best, "default_scores": default}, indent=1))
    for r in table[:8]:
        print(r)
    print("default", default)


if __name__ == "__main__":
    main()
