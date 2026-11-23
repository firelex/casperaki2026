"""Transcribe HumTrans recordings to notes with apps/models/hum-pitch's tuned SwiftF0 front end (tuning offset +
key snapping, settings "key" in hum-pitch/results/notes-steps-settings.json), for the harmonic bar-phase cue.
Run with the hum-pitch environment:

  ~/.local/share/casperaki/venvs/hum-pitch/bin/python -I scripts/transcribe_hum_pitch.py --sets humtrans-tune humtrans-test \
      --out /mnt/d/casperaki-data/hum-beats/grid4/notes-swiftf0
Writes <out>/<id>.json: [[onset_s, offset_s, midi], ...] on the recording's own time line.
"""
import argparse
import json
import sys
from pathlib import Path

HP = Path(__file__).resolve().parents[2] / "hum-pitch"
sys.path.insert(0, str(HP))
from hum_pitch.core import read_manifest  # noqa: E402
from hum_pitch.notes import Config, transcribe  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sets", nargs="+", required=True)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()
    cfg = Config(**{k: v for k, v in json.loads((HP / "results/notes-steps-settings.json").read_text())["key"].items() if k != "extra"})
    args.out.mkdir(parents=True, exist_ok=True)
    n = 0
    for s in args.sets:
        for row in read_manifest(s):
            notes = transcribe(row, cfg)
            (args.out / f"{row['id']}.json").write_text(json.dumps([[round(a, 4), round(b, 4), int(m)] for a, b, m in notes]))
            n += 1
    print(f"{n} recordings transcribed with settings 'key'")


if __name__ == "__main__":
    main()
