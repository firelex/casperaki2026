"""Add rap vocals: the best of several ACE takes of one section (pipeline/rap_pick.py), as the ace-layer adapter runs it.

Runs in the vocals service's venv, as a process of its own (BS-RoFormer and Whisper are not in ACE-Step's venv).
Usage: <vocals venv python> pick_rap_take.py   (reads one JSON object on stdin)
  {"takes": [absolute WAV paths], "words": "the section's lines", "start": s, "end": s, "out": absolute WAV path}
  start/end: the section's stretch of every take, in seconds.
Writes the best take's separated vocal over that stretch to "out" (stereo, 44.1 kHz, 32-bit float) and prints one JSON
line: {"best": index, "takes": [{"recall", "vocal_db", "backing_db", "heard"}]}.
"""
import json
import sys
from pathlib import Path

SERVICE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_DIR))

from pipeline import paths  # noqa: E402

sys.path.insert(0, str(paths.BS_ROFORMER_CODE))


def main():
    req = json.loads(sys.stdin.read())
    for k in ("takes", "words", "start", "end", "out"):
        if k not in req:
            raise SystemExit(f"pick_rap_take: missing {k!r}")
    if not req["takes"]:
        raise SystemExit("pick_rap_take: no takes")

    import soundfile as sf
    import torch

    from pipeline.rap_pick import Picker, best_take
    from pipeline.separate import SR

    picker = Picker(torch.device("cuda"))
    scores, vocals = [], []
    for path in req["takes"]:
        audio, sr = sf.read(path, dtype="float32", always_2d=True)
        s, v = picker.score(audio, sr, req["words"], (float(req["start"]), float(req["end"])))
        scores.append(s)
        vocals.append(v)
    best = best_take(scores)
    sf.write(req["out"], vocals[best].T, SR, subtype="FLOAT")
    print(json.dumps({"best": best, "takes": [s.as_json() for s in scores]}))


if __name__ == "__main__":
    main()
