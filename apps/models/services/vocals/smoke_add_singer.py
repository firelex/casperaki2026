"""GPU smoke run of the add-singer stage on a real recording, outside the running service (models load here).

Usage (the service's venv): .venv/bin/python smoke_add_singer.py <recording> <beginning|best> <separate: 0|1> <out_dir>
Runs pipeline.add_singer as the service would and prints every step, then the voice reference's place (in the cut
voice and in the recording), how it ends (the level of its last 100 ms against its singing), and the test line's
pitch against its notes and loudness.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf

SERVICE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SERVICE_DIR))
from pipeline import add_singer, levels, paths  # noqa: E402

sys.path.append(str(paths.SOULX_REPO))


class PrintingJob:
    def check_cancelled(self):
        pass

    def step(self, step_id, label):
        t0 = time.time()
        print(f"[step] {step_id}: {label}", flush=True)

        class Step:
            def done(self, text="", numbers=None, files=None):
                print(f"[done] {step_id} ({time.time() - t0:.1f} s): {text} {numbers or ''}", flush=True)

            def fail(self, text):
                print(f"[fail] {step_id}: {text}", flush=True)

        return Step()


def main(recording, choice, separate, out_dir):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    add_singer.run({"stage": "add_singer", "upload": str(Path(recording).resolve()), "separate": separate == "1",
                    "reference": choice}, out, PrintingJob())
    print(f"[smoke] stage ran in {time.time() - t0:.0f} s", flush=True)
    r = json.loads((out / "add_singer.json").read_text())
    print(f"[smoke] {json.dumps(r)}")
    ref, sr = sf.read(out / r["audio"])
    tail = ref[-int(0.1 * sr):]
    print(f"[reference] {len(ref) / sr:.2f} s; its last 100 ms {20 * np.log10(np.sqrt(np.mean(tail ** 2)) / levels.loud(ref) + 1e-12):.1f} dB "
          f"under its singing")
    meta = json.loads((out / r["meta"]).read_text())[0]
    print(f"[reference] text: {meta['text']}")
    t, tsr = sf.read(out / r["testLine"])
    print(f"[test line] {len(t) / tsr:.2f} s, singing at {20 * np.log10(levels.loud(t)):.1f} dBFS; pitch {r['testLinePitch']}")


if __name__ == "__main__":
    if len(sys.argv) != 5:
        raise SystemExit(__doc__)
    main(*sys.argv[1:])
