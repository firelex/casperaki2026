"""Merge per-clip scores of several models (scored separately on the same files) into one summary.

  python scripts/merge_scores.py --out <dir> <per_clip.csv> [<per_clip.csv> ...]
Refuses to merge when the models were not scored on exactly the same clips of a set.
"""
import argparse
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from score import summarise  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("csvs", nargs="+", type=Path)
    args = ap.parse_args()
    df = pd.concat([pd.read_csv(c) for c in args.csvs], ignore_index=True)
    for s, g in df.groupby("set"):
        clips = {m: set(x["clip"]) for m, x in g.groupby("model")}
        first = next(iter(clips.values()))
        if any(v != first for v in clips.values()):
            raise SystemExit(f"set {s}: the models were scored on different clips")
    names = list(dict.fromkeys(df["model"]))
    args.out.mkdir(parents=True, exist_ok=True)
    df.to_csv(args.out / "per_clip.csv", index=False)
    (args.out / "summary.md").write_text(summarise(df, names))
    print((args.out / "summary.md").read_text()[:3000])


if __name__ == "__main__":
    main()
