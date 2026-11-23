"""Run one model over the clips of some sets and cache its raw output (CPU only).

  python -I scripts/predict.py --model basic-pitch|pyin|swiftf0 --sets humtrans-test humtrans-tune synth-test --workers 8

Cache: /mnt/d/casperaki-data/hum-pitch/cache/<model>/<clip id>.npz (clips already cached are skipped).
  basic-pitch  the network's three outputs (note, onset, contour posteriorgrams), default ICASSP 2022 model;
               notes are made from them later with any thresholds (scripts/score.py, scripts/tune_basic_pitch.py).
  pyin         librosa pYIN at 16 kHz, 10 ms hop, 50-1600 Hz: times, f0_hz, voiced, level_db.
  swiftf0      SwiftF0 at 16 kHz (its native rate, 16 ms hop), 50-1600 Hz, voiced = confidence >= 0.5 (the
               model's calibrated threshold): times, f0_hz, voiced, confidence, level_db.
"""
import argparse
import os
import sys
import time
from multiprocessing import Pool
from pathlib import Path

os.environ["CUDA_VISIBLE_DEVICES"] = ""  # CPU only: the GPU belongs to another job
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")

import numpy as np  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hum_pitch.core import CACHE_DIR, FMAX_HZ, FMIN_HZ, frame_rms_db, read_manifest  # noqa: E402

_MODEL = None
_NAME = None


def _init(name: str, threads: int):
    global _MODEL, _NAME
    _NAME = name
    os.environ["OMP_NUM_THREADS"] = str(threads)
    if name == "basic-pitch":
        import tensorflow as tf
        tf.config.threading.set_intra_op_parallelism_threads(threads)
        tf.config.threading.set_inter_op_parallelism_threads(1)
        from basic_pitch import ICASSP_2022_MODEL_PATH
        from basic_pitch.inference import Model
        _MODEL = Model(ICASSP_2022_MODEL_PATH)
    elif name == "swiftf0":
        from swift_f0 import SwiftF0
        _MODEL = SwiftF0(threads=threads)
    elif name == "pyin":
        _MODEL = None
    else:
        raise ValueError(f"unknown model {name}")


def _run(row: dict) -> tuple[str, float]:
    out = CACHE_DIR / _NAME / f"{row['id']}.npz"
    if out.exists():
        return row["id"], 0.0
    t0 = time.time()
    if _NAME == "basic-pitch":
        from basic_pitch.inference import run_inference
        o = run_inference(row["wav"], _MODEL)
        arrays = {k: o[k].astype(np.float32) for k in ("note", "onset", "contour")}
    else:
        import librosa
        y, sr = librosa.load(row["wav"], sr=16000, mono=True)
        if _NAME == "pyin":
            f0, voiced, _ = librosa.pyin(y, fmin=FMIN_HZ, fmax=FMAX_HZ, sr=sr, frame_length=1024, hop_length=160)
            times = librosa.times_like(f0, sr=sr, hop_length=160)
            arrays = {"times": times, "f0_hz": f0, "voiced": voiced}
        else:
            r = _MODEL.detect(y, sr, fmin=FMIN_HZ, fmax=FMAX_HZ)
            arrays = {"times": r.timestamps, "f0_hz": r.pitch_hz, "voiced": r.confidence >= 0.5, "confidence": r.confidence}
        arrays["level_db"] = frame_rms_db(y, sr, arrays["times"])
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.stem + ".tmp.npz")
    np.savez_compressed(tmp, **arrays)
    tmp.rename(out)
    return row["id"], time.time() - t0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, choices=["basic-pitch", "pyin", "swiftf0"])
    ap.add_argument("--sets", nargs="+", required=True)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--threads", type=int, default=2, help="CPU threads per worker")
    args = ap.parse_args()
    rows = [r for s in args.sets for r in read_manifest(s)]
    t0, done, secs = time.time(), 0, []
    with Pool(args.workers, initializer=_init, initargs=(args.model, args.threads)) as pool:
        for cid, s in pool.imap_unordered(_run, rows, chunksize=1):
            done += 1
            if s:
                secs.append(s)
            if done % 50 == 0 or done == len(rows):
                print(f"{args.model}: {done}/{len(rows)} clips, {time.time() - t0:.0f} s", flush=True)
    if secs:
        print(f"{args.model}: {len(secs)} new, median {np.median(secs):.2f} s per clip per worker")


if __name__ == "__main__":
    main()
