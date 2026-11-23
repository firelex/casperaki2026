"""Does the ranking stop picking copies of the hum? Runs the spike's 20 test melodies through the amt service.

  services/amt/.venv/bin/python services/amt/copy_check.py [--url http://127.0.0.1:16511] [--samples 8]

Per melody, keep the first 4 bars (the e2e case: a 4-bar hum made into 8) and, separately, the first 2, ask the
service for `samples` completions, and compare the completion the old ranking would pick (the three checks scaled
by bars written) with the one the service now ranks first. Reports: share of written bars that are near copies of a
kept bar, strong-beat chord tones, notes in key, rhythm match, ending on a chord tone; also over all samples (what
the model itself writes). Prints timings for the service calls.
"""
import argparse
import json
import statistics
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[0] / "_serving"))
sys.path.insert(0, str(HERE.parents[0] / "_serving" / "adapters"))
sys.path.insert(0, str(HERE.parents[1] / "amt-spike"))
import amt as adapter  # noqa: E402  (pure ranking helpers; the model is not loaded)
from music import block_chord_pitches, chord_spans, precedent_chords, precedent_notes  # noqa: E402


def old_rank(r, melody, score):
    todo = [b for b in range(r["total"]) if b not in r["keep"]]
    return len({int(x["beat"] // 4) for x in melody} & set(todo)) / len(todo) * sum(score.values()) / 3


def stats(r, c):
    todo = [b for b in range(r["total"]) if b not in r["keep"]]
    return {"copy": adapter.near_copies(r, c["notes"]) / len(todo), "chordToneStrong": c["score"]["chordToneStrong"],
            "inKey": c["score"]["inKey"], "rhythmMatch": c["score"]["rhythmMatch"], "endsStable": float(adapter.ends_stable(r, c["notes"]))}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:16511")
    ap.add_argument("--samples", type=int, default=8)
    args = ap.parse_args()
    melodies = json.loads((HERE.parents[1] / "amt-spike" / "test_melodies.json").read_text())
    for keep in ([0, 1, 2, 3], [0, 1]):
        picked = {"old ranking": [], "new ranking": [], "all samples": []}
        secs = []
        for m in melodies:
            notes = precedent_notes(m["precedent"], m["shift"])
            payload = {"bpm": m["tempo"], "totalBars": 8, "keepBars": keep, "samples": args.samples,
                       "prompt": [{"beat": n["beat"], "midi": n["midi"], "duration": n["dur"]} for n in notes],
                       "chords": [{"beat": a, "duration": b - a, "midi": block_chord_pitches(root, tones)}
                                  for a, b, root, tones in chord_spans(precedent_chords(m["precedent"], m["shift"], 8))]}
            req = urllib.request.Request(args.url + "/complete", data=json.dumps(payload).encode(),
                                         headers={"content-type": "application/json"})
            t0 = time.perf_counter()
            with urllib.request.urlopen(req, timeout=600) as resp:
                out = json.loads(resp.read())
            secs.append(time.perf_counter() - t0)
            r = adapter._parse(json.dumps(payload).encode())
            comps = out["completions"]
            picked["new ranking"].append(stats(r, comps[0]))
            picked["old ranking"].append(stats(r, max(comps, key=lambda c: old_rank(r, c["notes"], c["score"]))))
            picked["all samples"] += [stats(r, c) for c in comps]
        print(f"\nkeep bars {keep} ({len(melodies)} melodies, {args.samples} samples each; "
              f"service call mean {statistics.fmean(secs):.1f} s, max {max(secs):.1f} s)")
        print("| completion | near-copy bars | chord tones (strong beats) | in key | rhythm match | ends on chord tone |")
        print("|---|---|---|---|---|---|")
        for name, rows in picked.items():
            print(f"| {name} | " + " | ".join(f"{statistics.fmean(x[k] for x in rows):.2f}"
                                             for k in ("copy", "chordToneStrong", "inKey", "rhythmMatch", "endsStable")) + " |")


if __name__ == "__main__":
    main()
