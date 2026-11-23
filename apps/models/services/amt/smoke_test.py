"""Smoke test for the amt service (POST /complete).

  services/amt/.venv/bin/python services/amt/smoke_test.py [--url http://127.0.0.1:16511]

Takes the first test melody of the AMT spike (apps/models/amt-spike/test_melodies.json) with its chords, keeps
(1) bars 0-1 and (2) bars 0-1 and 4-5 (a gap in the middle), asks for 4 completions each, and checks the contract:
kept bars come back unchanged, every other bar is written, notes are on 16ths, completions are ranked. Prints the
scores and the latency.
"""
import argparse
import json
import sys
import time
import urllib.request
from pathlib import Path

SPIKE = Path(__file__).resolve().parents[2] / "amt-spike"
sys.path.insert(0, str(SPIKE))
from music import block_chord_pitches, chord_spans, precedent_chords, precedent_notes  # noqa: E402


def call(url, payload):
    req = urllib.request.Request(url + "/complete", data=json.dumps(payload).encode(),
                                 headers={"content-type": "application/json"})
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            out = json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise SystemExit(f"HTTP {e.code}: {e.read().decode()}") from None
    return out, time.perf_counter() - t0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:16511")
    args = ap.parse_args()
    m = json.loads((SPIKE / "test_melodies.json").read_text())[0]
    notes = precedent_notes(m["precedent"], m["shift"])
    chords = [{"beat": a, "duration": b - a, "midi": block_chord_pitches(root, tones)}
              for a, b, root, tones in chord_spans(precedent_chords(m["precedent"], m["shift"], 8))]
    prompt = [{"beat": n["beat"], "midi": n["midi"], "duration": n["dur"]} for n in notes]
    for keep in ([0, 1], [0, 1, 4, 5]):
        out, sec = call(args.url, {"bpm": m["tempo"], "totalBars": 8, "prompt": prompt, "keepBars": keep,
                                   "chords": chords, "samples": 4})
        kept = sorted((n["beat"], n["midi"]) for n in prompt if int(n["beat"] // 4) in keep)
        for c in out["completions"]:
            got = sorted((n["beat"], n["midi"]) for n in c["notes"] if int(n["beat"] // 4) in keep)
            if got != kept:
                raise SystemExit(f"keep {keep}: kept bars changed")
            written = {int(n["beat"] // 4) for n in c["notes"]} - set(keep)
            if any(n["beat"] * 4 != round(n["beat"] * 4) for n in c["notes"] if int(n["beat"] // 4) not in keep):
                raise SystemExit("a written note is off the 16th grid")
            print(f"  keep {keep}: {len(c['notes'])} notes, bars written {sorted(written)}, score {c['score']}")
        print(f"keep {keep}: {len(out['completions'])} completions in {sec:.1f} s (service {out['tookMs']} ms)")


if __name__ == "__main__":
    main()
