"""Find the octave each HumTrans person actually hummed in, relative to the score MIDI.

  python -I scripts/fit_octaves.py --sets humtrans-test humtrans-tune

HumTrans MIDI is written in the score's octave; most men hum an octave below it (some at it, one woman above).
"The notes the person meant" are the score's notes in the octave they hummed, so per recording we shift the
reference by a whole number of octaves. The shift is measured with two different pitch trackers (pYIN and
SwiftF0, cached by scripts/predict.py): for every reference note, the median tracked pitch over the note (30 ms
trimmed at each end) minus the score pitch; the recording's median of those, rounded to the nearest 12.
A recording is left out (listed with the reason) when the two trackers disagree on the shift, or when either
tracker's median sits more than 1.5 semitones from the shift (no clear octave).
Writes /mnt/d/casperaki-data/hum-pitch/sets/<set>.octaves.json: {"shift": {id: semitones}, "excluded": {id: reason}}.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hum_pitch.core import SETS_DIR, read_manifest  # noqa: E402
from hum_pitch.models import curve  # noqa: E402


def deviation(model: str, row: dict) -> float:
    t, m = curve(model, row["id"])
    d = []
    for on, off, p in row["notes"]:
        sel = (t > on + 0.03) & (t < off - 0.03) & np.isfinite(m)
        if sel.sum() >= 3:
            d.append(np.median(m[sel]) - p)
    if len(d) < 5:
        raise ValueError(f"{row['id']}: {model} found pitch in only {len(d)} reference notes")
    return float(np.median(d))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sets", nargs="+", required=True)
    args = ap.parse_args()
    for s in args.sets:
        shift, excluded, by_sex = {}, {}, {}
        for row in read_manifest(s):
            dev = {m: deviation(m, row) for m in ("pyin", "swiftf0")}
            k = {m: int(12 * round(v / 12)) for m, v in dev.items()}
            if k["pyin"] != k["swiftf0"]:
                excluded[row["id"]] = f"trackers disagree on the octave: {dev}"
            elif max(abs(dev[m] - k[m]) for m in dev) > 1.5:
                excluded[row["id"]] = f"no clear octave: median deviation {dev}"
            else:
                shift[row["id"]] = k["pyin"]
                by_sex.setdefault(row["sex"], []).append(k["pyin"])
        (SETS_DIR / f"{s}.octaves.json").write_text(json.dumps({"shift": shift, "excluded": excluded}, indent=1))
        print(s, f"{len(shift)} shifted, {len(excluded)} excluded")
        for sex, v in sorted(by_sex.items()):
            vals, counts = np.unique(v, return_counts=True)
            print(f"  {sex}: " + ", ".join(f"{int(a):+d} semitones x{c}" for a, c in zip(vals, counts)))
        for k_, why in excluded.items():
            print("  excluded", k_, why)


if __name__ == "__main__":
    main()
