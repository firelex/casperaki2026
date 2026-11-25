"""GPU smoke for the ace-layer adapter: runs its generate() directly (no HTTP) on a rendered song for one track.

Usage (ACE-Step's venv):
  ../ace-step/.venv/bin/python smoke.py [--src WAV] [--track guitar] [--excerpt SECONDS] [--out DIR]
Defaults: the a31c5ba0 mix (exp01 backing.wav, 3:02, 128 bpm, C major), guitar, the whole song, outputs/smoke.
Checks first that bad params fail with ValueError, then that the part has the source's length, is not silent, and is
the part alone (zero-lag waveform correlation with the source near 0). Prints each step and the checks.
"""
import argparse
import importlib.util
import json
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf

HERE = Path(__file__).resolve().parent
SERVING = HERE.parent / "_serving"
sys.path.insert(0, str(SERVING))
import harness  # noqa: E402

SRC = "/mnt/d/casperaki-models/ace-vocal-tests/exp01_a31c5ba0_lego/backing.wav"
MODELS = "/mnt/d/casperaki-models"
CAPTIONS = {"guitar": "acoustic guitar strumming, pop, 128 bpm, C major",
            "strings": "string ensemble, legato, pop, 128 bpm, C major"}


def load_adapter():
    spec = importlib.util.spec_from_file_location("adapter_ace_layer", SERVING / "adapters" / "ace-layer.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def expect_value_error(adapter, params, what):
    try:
        adapter.check_params(params)
    except ValueError as e:
        print(f"  ok   {what}: {e}")
        return
    raise AssertionError(f"{what}: no ValueError")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=SRC)
    ap.add_argument("--track", default="guitar")
    ap.add_argument("--excerpt", type=float, default=0, help="seconds from the start (0 = the whole song)")
    ap.add_argument("--out", default=str(HERE / "outputs" / "smoke"))
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    src = args.src
    if args.excerpt:
        x, sr = sf.read(src, dtype="float32", always_2d=True)
        src = str(out / f"src_{int(args.excerpt)}s.wav")
        sf.write(src, x[: int(args.excerpt * sr)], sr, subtype="PCM_24")

    adapter = load_adapter()
    sys.path.insert(0, str(adapter.ACE_ROOT))
    good = {"src_wav": src, "track": args.track, "caption": CAPTIONS[args.track], "bpm": 128,
            "key_scale": "C major", "seed": 1234}
    print("param checks:")
    assert adapter.lego_instruction("backing_vocals") == \
        "Generate the BACKING_VOCALS track based on the audio context:"
    expect_value_error(adapter, {k: v for k, v in good.items() if k != "bpm"}, "missing bpm")
    expect_value_error(adapter, {**good, "extra": 1}, "unknown param")
    expect_value_error(adapter, {**good, "src_wav": "rel.wav"}, "relative src_wav")
    expect_value_error(adapter, {**good, "src_wav": "/nonexistent.wav"}, "missing src_wav")
    expect_value_error(adapter, {**good, "track": "bass"}, "track bass")
    expect_value_error(adapter, {**good, "track": "backing vocals"}, "track with a space")
    expect_value_error(adapter, {**good, "caption": " "}, "empty caption")
    expect_value_error(adapter, {**good, "bpm": "128"}, "bpm as text")
    expect_value_error(adapter, {**good, "bpm": 10}, "bpm too low")
    expect_value_error(adapter, {**good, "key_scale": "C"}, "key without mode")
    expect_value_error(adapter, {**good, "seed": 1.5}, "fractional seed")
    adapter.check_params(good)

    ctx = harness.Ctx(adapter.MANIFEST, HERE, None, None, MODELS, 0)
    t = time.time()
    handle = adapter.load(ctx)
    print(f"model loaded in {time.time() - t:.1f}s")
    job = harness.Job()
    t = time.time()
    res = adapter.generate(handle, good, str(out), job)
    total = time.time() - t
    for s in job.steps():
        print(f"step {s['id']:6s} {s['state']:6s} {s['label']!r}: {s['text']}  {json.dumps(s['numbers'])} {s['files']}")
    assert [s["id"] for s in job.steps()] == ["read", "lego", "write"]
    assert all(s["state"] == "done" for s in job.steps())

    x, sr_in = sf.read(src, dtype="float32", always_2d=True)
    y, sr_out = sf.read(res["file"], dtype="float32", always_2d=True)
    xm, ym = x.mean(1), y.mean(1)
    corr = float(np.dot(xm, ym) / np.sqrt(np.dot(xm, xm) * np.dot(ym, ym)))
    rms = 20 * np.log10(np.sqrt(np.mean(ym.astype(np.float64) ** 2)))
    print(f"source {x.shape[0]} samples @ {sr_in} Hz; part {y.shape[0]} samples @ {sr_out} Hz, {y.shape[1]} ch; "
          f"part {rms:.1f} dB RMS; waveform correlation with source {corr:.3f}; generate() took {total:.1f}s")
    assert sr_out == sr_in, "sample rate differs"
    assert y.shape[0] == x.shape[0], "length differs"
    assert y.shape[1] == 2, "not stereo"
    assert rms > -50, "part is silent"
    assert abs(corr) < 0.1, "part correlates with the source (not the part alone)"
    print("SMOKE OK")


if __name__ == "__main__":
    main()
