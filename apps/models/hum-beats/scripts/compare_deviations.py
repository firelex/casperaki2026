"""Compare deviation statistics: real held-out hums vs synthetic performances of the same scores.

  python scripts/compare_deviations.py --real <prefix> --keys <held-out keys> --synthetic name=<prefix> [...]
Per note: onset jitter, onset deviation, duration ratio, pitch error, pitch at note start, loudness.
Per clip: timing spread, drift range, pitch spread, loudness spread. Percentiles and the two-sample
Kolmogorov-Smirnov statistic against the real values (0 = identical distributions).
"""
import argparse
import json
from pathlib import Path

import numpy as np
from scipy.stats import ks_2samp

NOTE_KEYS = {"jitter": ("onset jitter around the drift (ms)", 1000), "dev_on": ("onset deviation from the beat grid (ms)", 1000),
             "dur_ratio": ("duration ratio (sung / written)", 1), "pitch_err": ("pitch error mid-note (cents)", 1),
             "start_dev": ("pitch at note start vs target (cents)", 1), "loud_db": ("note loudness vs clip median (dB)", 1)}
CLIP_KEYS = {"jitter_sd": ("timing spread per clip (ms)", 1000), "drift_range": ("drift range per clip (ms)", 1000),
             "pitch_err_sd": ("pitch spread per clip (cents)", 1), "loud_sd": ("loudness spread per clip (dB)", 1)}


def load(prefix: Path, keys: set):
    clips = [c for c in json.loads(Path(str(prefix) + ".clips.json").read_text()) if c["key"] in keys]
    notes = [json.loads(line) for line in open(str(prefix) + ".notes.jsonl")]
    return clips, [n for n in notes if n["key"] in keys]


def vals(rows, k, scale):
    v = np.array([r[k] for r in rows if r.get(k) is not None], dtype=float) * scale
    return v[np.isfinite(v)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--real", type=Path, required=True)
    ap.add_argument("--keys", type=Path, required=True)
    ap.add_argument("--synthetic", nargs="+", required=True)
    args = ap.parse_args()
    keys = set(args.keys.read_text().split())
    real_c, real_n = load(args.real, keys)
    syn = {s.split("=")[0]: load(Path(s.split("=")[1]), keys) for s in args.synthetic}
    names = list(syn)
    print(f"real held-out: {len(real_c)} recordings, {len(real_n)} notes; " + "; ".join(f"{k}: {len(v[0])} recordings, {len(v[1])} notes" for k, v in syn.items()))
    print("\n| statistic | real 5/25/50/75/95 | " + " | ".join(f"{n} 5/25/50/75/95 | KS {n}" for n in names) + " |")
    print("|---|---|" + "---|---|" * len(names))
    for group, table, rows_real, idx in (("note", NOTE_KEYS, real_n, 1), ("clip", CLIP_KEYS, real_c, 0)):
        for k, (label, scale) in table.items():
            r = vals(rows_real, k, scale)
            cells = [" / ".join(f"{x:.0f}" if abs(x) >= 10 else f"{x:.2f}" for x in np.percentile(r, [5, 25, 50, 75, 95]))]
            for n in names:
                s = vals(syn[n][idx], k, scale)
                cells.append(" / ".join(f"{x:.0f}" if abs(x) >= 10 else f"{x:.2f}" for x in np.percentile(s, [5, 25, 50, 75, 95])))
                cells.append(f"{ks_2samp(r, s).statistic:.2f}")
            print(f"| {label} | " + " | ".join(cells) + " |")


if __name__ == "__main__":
    main()
