"""Score AMT completions (and the original precedents' same bars) with simple musical checks.

  python score.py <completions.jsonl> [--out-dir results]

Per completion, over the generated bars only (bars after the prompt):
  strong_chord   share of notes starting on beat 1 or 3 whose pitch is in that beat's chord
  all_chord      share of all notes whose pitch is in the chord sounding at their onset
  in_key         share of notes in the major scale of the key
  near_hum       share of notes inside the prompt's pitch range widened by 3 semitones
  span           highest minus lowest generated pitch (semitones)
  ends_tonic     the last note starting in bar 8 is the key note (False if bar 8 is empty)
  rhythm_sim     best Jaccard similarity of 16th-note onset grids between bars 1-2 and a later
                 two-bar window that lies fully in the generated bars
  density_ratio  notes per generated bar / notes per prompt bar
Onsets are snapped to the nearest 16th note before scoring.
"""

import argparse
import json
import statistics
from collections import defaultdict
from pathlib import Path

from music import BEATS_PER_BAR, bar_of, pitch_class, precedent_chords, precedent_notes

MAJOR = (0, 2, 4, 5, 7, 9, 11)
TOTAL_BARS = 8
METRICS = ["strong_chord", "all_chord", "in_key", "near_hum", "span", "ends_tonic", "rhythm_sim", "density_ratio"]


def snap(beat):
    return round(beat * 4) / 4


def onset_grid(notes, first_bar):
    return {round((snap(n["beat"]) - first_bar * BEATS_PER_BAR) * 4) for n in notes
            if first_bar <= bar_of(snap(n["beat"])) < first_bar + 2}


def jaccard(a, b):
    if not a and not b:
        return 1.0
    return len(a & b) / len(a | b)


def share(flags):
    if not flags:
        return None
    return sum(flags) / len(flags)


def score(prompt_notes, gen_notes, per_beat, key_pc, prompt_bars):
    gen = [dict(n, beat=snap(n["beat"])) for n in gen_notes]
    gen = [n for n in gen if prompt_bars * BEATS_PER_BAR <= n["beat"] < TOTAL_BARS * BEATS_PER_BAR]
    scale = {(key_pc + i) % 12 for i in MAJOR}

    def chord_at(beat):
        return per_beat[int(beat)][1]

    strong = [n["midi"] % 12 in chord_at(n["beat"]) for n in gen if n["beat"] % 2 == 0]
    lo = min(n["midi"] for n in prompt_notes) - 3
    hi = max(n["midi"] for n in prompt_notes) + 3
    bar8 = [n for n in gen if bar_of(n["beat"]) == TOTAL_BARS - 1]
    prompt_grid = onset_grid(prompt_notes, 0)
    windows = [b for b in range(prompt_bars, TOTAL_BARS - 1)]
    rhythm = max(jaccard(prompt_grid, onset_grid(gen, b)) for b in windows)
    gen_bars = TOTAL_BARS - prompt_bars
    return {
        "n_notes": len(gen),
        "strong_chord": share(strong),
        "all_chord": share([n["midi"] % 12 in chord_at(n["beat"]) for n in gen]),
        "in_key": share([n["midi"] % 12 in scale for n in gen]),
        "near_hum": share([lo <= n["midi"] <= hi for n in gen]),
        "span": (max(n["midi"] for n in gen) - min(n["midi"] for n in gen)) if gen else None,
        "ends_tonic": bool(bar8) and max(bar8, key=lambda n: n["beat"])["midi"] % 12 == key_pc,
        "rhythm_sim": rhythm,
        "density_ratio": (len(gen) / gen_bars) / (len(prompt_notes) / prompt_bars),
    }


def mean(xs):
    xs = [float(x) for x in xs if x is not None]
    return statistics.fmean(xs) if xs else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("completions")
    ap.add_argument("--melodies", default=str(Path(__file__).resolve().parent / "test_melodies.json"))
    ap.add_argument("--out-dir", default=str(Path(__file__).resolve().parent / "results"))
    args = ap.parse_args()

    melodies = {m["id"]: m for m in json.loads(Path(args.melodies).read_text())}
    records = [json.loads(l) for l in Path(args.completions).read_text().splitlines() if l.strip()]
    if not records:
        raise SystemExit(f"no completions in {args.completions}")

    rows = []
    groups = defaultdict(list)
    prompt_bar_set = sorted({r["prompt_bars"] for r in records})
    for r in records:
        m = melodies[r["id"]]
        notes = precedent_notes(m["precedent"], m["shift"])
        per_beat = precedent_chords(m["precedent"], m["shift"], TOTAL_BARS)
        prompt = [n for n in notes if n["beat"] < r["prompt_bars"] * BEATS_PER_BAR]
        s = score(prompt, r["notes"], per_beat, pitch_class(m["key"]), r["prompt_bars"])
        s.update({"id": r["id"], "prompt_bars": r["prompt_bars"], "top_p": r["top_p"], "sample": r["sample"],
                  "gen_seconds": r["gen_seconds"]})
        rows.append(s)
        groups[(r["prompt_bars"], f"AMT p={r['top_p']}")].append(s)
    for pb in prompt_bar_set:
        for mid, m in melodies.items():
            notes = precedent_notes(m["precedent"], m["shift"])
            per_beat = precedent_chords(m["precedent"], m["shift"], TOTAL_BARS)
            prompt = [n for n in notes if n["beat"] < pb * BEATS_PER_BAR]
            s = score(prompt, notes, per_beat, pitch_class(m["key"]), pb)
            s.update({"id": mid, "prompt_bars": pb, "top_p": None, "sample": None, "gen_seconds": None})
            groups[(pb, "original")].append(s)

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "scores.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))

    header = "| prompt bars | source | n | notes | " + " | ".join(METRICS) + " |"
    lines = [header, "|" + "---|" * (4 + len(METRICS))]
    for (pb, src) in sorted(groups):
        g = groups[(pb, src)]
        cells = []
        for k in METRICS:
            v = mean(g_[k] for g_ in g)
            cells.append("-" if v is None else f"{v:.2f}")
        lines.append(f"| {pb} | {src} | {len(g)} | {mean(x['n_notes'] for x in g):.1f} | " + " | ".join(cells) + " |")
    secs = sorted(r["gen_seconds"] for r in records)
    timing = (f"generation time per completion: mean {statistics.fmean(secs):.2f}s, "
              f"median {statistics.median(secs):.2f}s, p90 {secs[int(0.9 * (len(secs) - 1))]:.2f}s, "
              f"max {secs[-1]:.2f}s over {len(secs)} completions on {records[0]['gpu']}")
    empty8 = sum(1 for r in rows if not r["ends_tonic"] and r["n_notes"] == 0)
    table = "\n".join(lines) + "\n\n" + timing + "\n" + f"completions with no notes at all: {empty8}\n"
    (out_dir / "score_table.md").write_text(table)
    print(table)


if __name__ == "__main__":
    main()
