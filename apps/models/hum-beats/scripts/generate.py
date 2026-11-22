"""Generate the hum-beats data set (or a pilot) in parallel.

  python scripts/generate.py --out /mnt/d/casperaki-data/hum-beats --scale 1.0 --workers 32
  python scripts/generate.py --out <pilot dir> --scale 0.025          # ~500-clip pilot

Writes <out>/<split>/<clip>.{wav,beats,json,mid,pitch.npz}, <out>/plan.jsonl and <out>/index.jsonl
(one summary line per clip). Any failing clip stops the run with its error.
"""
import argparse
import json
import os
import sys
import time
from multiprocessing import Pool
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hum_beats.generate import make_clip, make_plan  # noqa: E402
from hum_beats.sounds import SoundBank  # noqa: E402

_BANK = None
_OUT = None


def _init(cache_dir: str, out: str):
    global _BANK, _OUT
    os.environ["OMP_NUM_THREADS"] = "1"
    _BANK = SoundBank(Path(cache_dir))
    _OUT = Path(out)


def _one(row):
    meta = make_clip(row, _BANK, _OUT / row["split"])
    return {k: meta[k] for k in ("clip_id", "split", "family", "meter", "n_bars", "bpm", "style", "timing", "start_mode", "duration_s")} | {
        "lead_group": meta["lead"]["group"], "timbre": meta["lead"]["timbre"], "pollution": meta["pollution"]["level"]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--cache-dir", type=Path, default=Path.home() / ".cache/casperaki/hum-beats-sounds")
    ap.add_argument("--scale", type=float, required=True)
    ap.add_argument("--workers", type=int, default=32)
    ap.add_argument("--limit", type=int, default=None, help="only the first N plan rows (debugging)")
    args = ap.parse_args()
    rows = make_plan(args.scale)
    if args.limit:
        rows = rows[: args.limit]
    args.out.mkdir(parents=True, exist_ok=True)
    with open(args.out / "plan.jsonl", "w") as f:
        f.writelines(json.dumps(r) + "\n" for r in rows)
    t = time.time()
    with Pool(args.workers, initializer=_init, initargs=(str(args.cache_dir), str(args.out))) as pool, open(args.out / "index.jsonl", "w") as idx:
        for i, summary in enumerate(pool.imap_unordered(_one, rows, chunksize=4)):
            idx.write(json.dumps(summary) + "\n")
            if (i + 1) % 500 == 0:
                print(f"{i + 1}/{len(rows)} clips, {time.time() - t:.0f} s", flush=True)
    print(f"done: {len(rows)} clips in {time.time() - t:.0f} s")


if __name__ == "__main__":
    main()
