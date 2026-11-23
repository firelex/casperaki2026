"""Lay the generated train/dev clips out the way Beat This!'s training data module expects them.

  <bt-data>/annotations/humbeats/info.json                  {"has_downbeats": true}
  <bt-data>/annotations/humbeats/single.split               "<clip>\\ttrain" / "<clip>\\tval"
  <bt-data>/annotations/humbeats/annotations/beats/<clip>.beats
  <bt-data>/audio/spectrograms/humbeats/<clip>/track.npy    log-mel spectrogram, float16, exactly as Beat This!
                                                            computes it at inference (LogMelSpect, 22,050 Hz)
Only train (as "train") and dev (as "val") go in; the test sets are scored from their audio files.
"""
import argparse
import json
import os
import shutil
from multiprocessing import Pool
from pathlib import Path

import numpy as np
import soundfile as sf



def _spect(args):
    wav, out = args
    if out.exists():
        return len(np.load(out, mmap_mode="r"))  # already computed (the set is being filled in)
    import torch
    torch.set_num_threads(1)
    from beat_this.preprocessing import LogMelSpect
    y, sr = sf.read(wav, dtype="float32")
    if sr != 22050 or y.ndim != 1:
        raise ValueError(f"{wav}: expected mono 22,050 Hz, got {sr} Hz with shape {y.shape}")
    spec = LogMelSpect()(torch.from_numpy(y)).numpy().astype(np.float16)
    out.parent.mkdir(parents=True, exist_ok=True)
    np.save(out, spec)
    return len(spec)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, required=True, help="generated set (with train/ and dev/)")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--workers", type=int, default=24)
    ap.add_argument("--dataset", default="humbeats", help="dataset name inside the Beat This! layout (round two: humbeats2)")
    args = ap.parse_args()
    ann = args.out / "annotations" / args.dataset
    (ann / "annotations" / "beats").mkdir(parents=True, exist_ok=True)
    (ann / "info.json").write_text(json.dumps({"has_downbeats": True}))
    jobs, split_lines = [], []
    for split, part in (("train", "train"), ("dev", "val")):
        if not (args.data / split).exists():
            raise SystemExit(f"{args.data / split} does not exist")
        for b in sorted((args.data / split).glob("*.beats")):
            cid = b.stem
            shutil.copyfile(b, ann / "annotations" / "beats" / f"{cid}.beats")
            split_lines.append(f"{cid}\t{part}\n")
            jobs.append((args.data / split / f"{cid}.wav", args.out / "audio" / "spectrograms" / args.dataset / cid / "track.npy"))
    (ann / "single.split").write_text("".join(split_lines))
    os.environ["OMP_NUM_THREADS"] = "1"
    with Pool(args.workers) as pool:
        frames = pool.map(_spect, jobs, chunksize=16)
    print(f"{len(jobs)} spectrograms, {sum(frames)} frames ({sum(frames) / 50 / 3600:.1f} h)")


if __name__ == "__main__":
    main()
