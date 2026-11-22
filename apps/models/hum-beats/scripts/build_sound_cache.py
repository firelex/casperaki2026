"""Decode, measure and cache the library sounds used as melody instruments (see hum_beats/sounds.py)."""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hum_beats.sounds import build_cache  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--cache-dir", type=Path, required=True)
ap.add_argument("--workers", type=int, default=24)
args = ap.parse_args()
cat = build_cache(args.cache_dir, args.workers)
print(f"kept {len(cat['sounds'])} sounds, rejected {len(cat['rejected'])}")
for r in cat["rejected"]:
    print("REJECTED", r["sound_id"], r["path"], "-", r["reason"])
