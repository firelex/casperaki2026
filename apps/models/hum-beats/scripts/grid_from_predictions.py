"""Recompute the grid-correct metric from saved predictions (per_clip.csv), optionally with the metre known.

  python scripts/grid_from_predictions.py <per_clip.csv> --set-dirs name=<folder> [...] [--meter-known]
"""
import argparse
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from score import grid_correct, read_beats  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv", type=Path)
    ap.add_argument("--set-dirs", nargs="+", required=True)
    ap.add_argument("--meter-known", action="store_true")
    args = ap.parse_args()
    df = pd.read_csv(args.csv, low_memory=False)
    dirs = {}
    for x in args.set_dirs:
        n, f = x.split("=", 1)
        dirs[n] = Path(f.split("@")[0])
    rows = []
    for _, r in df[df["set"].isin(dirs)].iterrows():
        tb, td, bpb = read_beats(dirs[r["set"]] / f"{r['clip']}.beats")
        pb = np.array([float(v) for v in str(r["pred_beats"]).split()]) if isinstance(r["pred_beats"], str) else np.array([])
        pd_ = np.array([float(v) for v in str(r["pred_downbeats"]).split()]) if isinstance(r["pred_downbeats"], str) else np.array([])
        g = grid_correct(pb, pd_, r["truth_bpm"], tb, td, bpb, None, meter_known=args.meter_known)
        rows.append({"set": r["set"], "model": r["model"], **g})
    out = pd.DataFrame(rows)
    cols = ["grid_meant_70ms", "grid_meant_quarterbeat", "grid_nohint_70ms", "grid_nohint_quarterbeat"]
    print(f"metre known: {args.meter_known}")
    print(out.groupby(["set", "model"])[cols].mean().round(3).to_string())


if __name__ == "__main__":
    main()
