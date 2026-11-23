"""Compare the rhythm of melodies by source (precedent vs procedural): where onsets fall in the bar, how long
notes and phrase ends land on strong beats, how often bar rhythms repeat, rests and phrase lengths.

  python scripts/rhythm_stats.py --data /mnt/d/casperaki-data/hum-beats/full/train [--limit 6000]
Reads the clip JSONs (score positions of the intended notes). Swung clips are left out (swing moves off-beats).
"""
import argparse
import collections
import json
from pathlib import Path

import numpy as np

METERS = {"2/4": (2.0, 1.0), "3/4": (3.0, 1.0), "4/4": (4.0, 1.0), "6/8": (3.0, 1.5)}


def pos_class(q: float, bar_q: float, beat_q: float, meter: str) -> str:
    p = q % bar_q
    if abs(p) < 1e-3 or abs(p - bar_q) < 1e-3:
        return "beat 1"
    b = p / beat_q
    if abs(b - round(b)) < 1e-3:
        return "other beats"
    sub = 0.5 if meter == "6/8" else 0.5  # eighth notes in quarters
    if abs(p / sub - round(p / sub)) < 1e-3:
        return "eighths off the beat"
    if abs(p / 0.25 - round(p / 0.25)) < 1e-3:
        return "sixteenths"
    return "other (triplets etc.)"


def strong(q: float, bar_q: float, beat_q: float, meter: str) -> bool:
    p = q % bar_q
    if abs(p) < 1e-3 or abs(p - bar_q) < 1e-3:
        return True
    return meter == "4/4" and abs(p - 2.0) < 1e-3


def stats(metas):
    pos = collections.Counter()
    n_on = 0
    long_strong = long_beat = n_long = 0
    end_strong = end_beat = n_end = 0
    rep_bars = n_bars = 0
    rest_frac, phrase_beats, phrase_notes = [], [], []
    for m in metas:
        meter = m["meter"]
        bar_q, beat_q = METERS[meter]
        notes = m["notes"]
        for i, nt in enumerate(notes):
            q = nt["q_on"]
            c = pos_class(q, bar_q, beat_q, meter)
            pos[c] += 1
            n_on += 1
            on_beat = c in ("beat 1", "other beats")
            if nt["q_off"] - nt["q_on"] >= beat_q - 1e-6:
                n_long += 1
                long_strong += strong(q, bar_q, beat_q, meter)
                long_beat += on_beat
            if nt["phrase_end"]:
                n_end += 1
                end_strong += strong(q, bar_q, beat_q, meter)
                end_beat += on_beat
        # bar rhythm patterns (onset positions within each full bar)
        bars = collections.defaultdict(list)
        for nt in notes:
            b = int(np.floor(nt["q_on"] / bar_q + 1e-9))
            if 0 <= b < m["n_bars"]:
                bars[b].append(round(nt["q_on"] - b * bar_q, 3))
        seen = []
        for b in range(m["n_bars"]):
            pat = tuple(bars.get(b, []))
            if not pat:
                continue
            n_bars += 1
            rep_bars += pat in seen
            seen.append(pat)
        # rests and phrases
        span = max(n["q_off"] for n in notes) - min(n["q_on"] for n in notes)
        sounding = sum(n["q_off"] - n["q_on"] for n in notes)
        rest_frac.append(1 - sounding / span)
        start, cnt = notes[0]["q_on"], 0
        for i, nt in enumerate(notes):
            cnt += 1
            gap = (notes[i + 1]["q_on"] - nt["q_off"]) if i + 1 < len(notes) else 1e9
            if gap >= beat_q - 1e-6:
                phrase_beats.append((nt["q_off"] - start) / beat_q)
                phrase_notes.append(cnt)
                if i + 1 < len(notes):
                    start, cnt = notes[i + 1]["q_on"], 0
    return {
        "clips": len(metas),
        "onsets": n_on,
        "onset position": {k: round(v / n_on, 3) for k, v in sorted(pos.items())},
        "long notes on a strong beat": round(long_strong / max(n_long, 1), 3),
        "long notes on any beat": round(long_beat / max(n_long, 1), 3),
        "phrase-end notes on a strong beat": round(end_strong / max(n_end, 1), 3),
        "phrase-end notes on any beat": round(end_beat / max(n_end, 1), 3),
        "bars repeating an earlier bar's rhythm": round(rep_bars / max(n_bars, 1), 3),
        "silent share of the melody span": round(float(np.mean(rest_frac)), 3),
        "phrase length in beats (median, 90th pct)": [float(np.median(phrase_beats)), float(np.percentile(phrase_beats, 90))],
        "notes per phrase (median)": float(np.median(phrase_notes)),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument("--limit", type=int, default=6000)
    args = ap.parse_args()
    groups = collections.defaultdict(list)
    files = sorted(args.data.glob("*.json"))
    for j in files[:: max(1, len(files) // args.limit)]:
        m = json.loads(j.read_text())
        if m["style"] == "swung":
            continue
        groups[(m["score"]["source"], m["meter"])].append(m)
        groups[(m["score"]["source"], "all")].append(m)
    out = {f"{s} {mt}": stats(v) for (s, mt), v in sorted(groups.items()) if mt == "all" or True}
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
