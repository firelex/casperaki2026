"""End-to-end note positions for hum-to-song (no single steady grid): notes snapped to bar / beat / 16th (or 8th) on
the predicted beats, compared with the labelled notes on the labelled beats. HumTrans test, 4-beat bars.

  python scripts/note_grid.py --act /mnt/d/casperaki-data/hum-beats/grid4/act --set humtrans-test \
      --notes-dir /mnt/d/casperaki-data/hum-beats/grid4/notes-swiftf0 --out <dir>

Beats: the model's DBN beats (they follow drift). Bars of 4 beats, phase two ways:
  (a) "activation": of the 4 possible phases on the predicted beats, the one with the highest mean downbeat activation;
  (b) "dbn4": madmom's DBN rerun from the saved activations with 4 beats per bar only (beats and downbeats from it).
Note onset -> beat-relative position by interpolating between beats -> snapped to the nearest 16th (or 8th) ->
(bar, slot). Reference: labelled notes on labelled beats and downbeats; for 2/4 pieces both ways of pairing two 2/4 bars
into one 4-beat bar are tried and the better one counts. A whole-bar shift between estimate and reference is allowed
(the best one per clip). Pitch: the labelled notes moved to the octave the person hummed (hum-pitch's per-recording
octave fit, results in /mnt/d/casperaki-data/hum-pitch/sets/humtrans-test.octaves.json).
Scores: share of reference notes whose snapped position is matched by an estimated note (one-to-one), with and
without the right pitch; share of clips with >= 90% of notes in place; share of clips with every bar-1 note in place.
Conditions: transcribed notes on predicted beats (the pipeline), transcribed notes on labelled beats (pitch and onset
errors only), labelled notes on predicted beats (beat tracking errors only).
"""
import argparse
import json
from collections import Counter
from pathlib import Path

import numpy as np


def beat_pos(t: np.ndarray, beats: np.ndarray) -> np.ndarray:
    """Fractional beat index of times t on a beat list (linear between beats, extrapolated at the ends)."""
    idx = np.arange(len(beats), dtype=float)
    p = np.interp(t, beats, idx)
    first, last = beats[1] - beats[0], beats[-1] - beats[-2]
    p = np.where(t < beats[0], (t - beats[0]) / first, p)
    p = np.where(t > beats[-1], len(beats) - 1 + (t - beats[-1]) / last, p)
    return p


def positions(notes, beats, first_downbeat_idx: int, per_beat: int):
    """[(bar, slot, midi)] with slot in 0..4*per_beat-1."""
    if len(notes) == 0 or len(beats) < 2:
        return []
    on = np.array([n[0] for n in notes])
    p = np.round(beat_pos(on, beats) * per_beat) / per_beat - first_downbeat_idx
    bar = np.floor(p / 4 + 1e-9).astype(int)
    slot = np.round((p - 4 * bar) * per_beat).astype(int) % (4 * per_beat)
    return [(int(b), int(s), int(n[2])) for b, s, n in zip(bar, slot, notes)]


def score(ref, est, per_beat):
    """Best whole-bar shift: matched positions, matched positions with pitch, bar-1 notes all right."""
    best = None
    if not ref:
        return None
    for shift in range(-6, 7):
        e_pos = Counter((b + shift, s) for b, s, _ in est)
        e_pp = Counter((b + shift, s, m) for b, s, m in est)
        r_pos = Counter((b, s) for b, s, _ in ref)
        r_pp = Counter((b, s, m) for b, s, m in ref)
        pos = sum((r_pos & e_pos).values())
        pp = sum((r_pp & e_pp).values())
        bar1 = [(b, s) for b, s, _ in ref if s == 0]
        bar1_ok = all(e_pos[(b, s)] > 0 for b, s in bar1)
        cand = (pos, pp, bar1_ok)
        if best is None or cand[:2] > best[:2]:
            best = cand
    n = len(ref)
    return {"pos": best[0] / n, "pos_pitch": best[1] / n, "bar1_all": best[2], "n": n}


def dbn4(beat_act, db_act):
    from madmom.features.downbeats import DBNDownBeatTrackingProcessor
    eps = 1e-5
    b = beat_act * (1 - eps) + eps / 2
    d = db_act * (1 - eps) + eps / 2
    proc = DBNDownBeatTrackingProcessor(beats_per_bar=[4], min_bpm=55.0, max_bpm=215.0, fps=50, transition_lambda=100)
    out = proc(np.vstack((np.maximum(b - d, eps / 2), d)).T)
    return out[:, 0], out[out[:, 1] == 1][:, 0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--act", type=Path, required=True)
    ap.add_argument("--set", default="humtrans-test")
    ap.add_argument("--models", nargs="+", default=["final", "final0"])
    ap.add_argument("--notes-dir", type=Path, required=True)
    ap.add_argument("--octaves", type=Path, default=Path("/mnt/d/casperaki-data/hum-pitch/sets/humtrans-test.octaves.json"))
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()
    octs = json.loads(args.octaves.read_text())["shift"]
    rows = []
    for model in args.models:
        for f in sorted((args.act / model / args.set).glob("*.npz")):
            z = np.load(f, allow_pickle=True)
            lab = np.loadtxt(str(z["labels"]), ndmin=2)
            tb, nums = lab[:, 0], lab[:, 1].astype(int)
            bpb = int(nums.max())
            if bpb not in (2, 4):
                continue
            meta = json.loads(Path(str(z["meta"])).read_text())
            k = octs[f.stem]
            ref_notes = [[n["onset"], n["offset"], n["midi"] + k] for n in meta["notes"]]
            trans = json.loads((args.notes_dir / f"{f.stem}.json").read_text())
            # reference bars: 4/4 from the labelled downbeats; 2/4 both pairings
            d_idx = np.flatnonzero(nums == 1)
            ref_phases = [int(d_idx[0])] if bpb == 4 else [int(d_idx[0]), int(d_idx[1]) if len(d_idx) > 1 else int(d_idx[0])]
            # predicted grids
            pb = np.asarray(z["beats+dbn"])
            grids = {}
            if len(pb) >= 4:
                a = np.zeros(len(pb))
                f_idx = np.clip(np.round(pb * 50).astype(int), 0, len(z["db_act"]) - 1)
                a = z["db_act"][f_idx]
                kbest = int(np.argmax([a[i::4].mean() for i in range(4)]))
                grids["activation"] = (pb, kbest)
            b4, d4 = dbn4(z["beat_act"], z["db_act"])
            if len(b4) >= 4 and len(d4):
                grids["dbn4"] = (b4, int(np.argmin(np.abs(b4 - d4[0]))))
            for per_beat, res_name in ((4, "16th"), (2, "8th")):
                def best_ref(est_fn):
                    out = None
                    for ph in ref_phases:
                        r = positions(ref_notes, tb, ph, per_beat)
                        s = score(r, est_fn(), per_beat)
                        if s and (out is None or (s["pos"], s["pos_pitch"]) > (out["pos"], out["pos_pitch"])):
                            out = s
                    return out
                conds = {}
                for gname, (gb, kk) in grids.items():
                    conds[f"transcribed on predicted beats [{gname}]"] = lambda gb=gb, kk=kk: positions(trans, gb, kk, per_beat)
                    conds[f"labelled notes on predicted beats [{gname}]"] = lambda gb=gb, kk=kk: positions(ref_notes, gb, kk, per_beat)
                for cname, fn in conds.items():
                    s = best_ref(fn)
                    if s:
                        rows.append({"model": model, "clip": f.stem, "bpb": bpb, "res": res_name, "cond": cname, **s})
                if model == args.models[0]:
                    # transcribed notes on labelled beats (independent of the model): both reference pairings tried
                    out = None
                    for ph in ref_phases:
                        s = score(positions(ref_notes, tb, ph, per_beat), positions(trans, tb, ph, per_beat), per_beat)
                        if s and (out is None or s["pos"] > out["pos"]):
                            out = s
                    rows.append({"model": "-", "clip": f.stem, "bpb": bpb, "res": res_name, "cond": "transcribed on labelled beats", **out})
    import pandas as pd
    df = pd.DataFrame(rows)
    args.out.mkdir(parents=True, exist_ok=True)
    df.to_csv(args.out / "note_grid_per_clip.csv", index=False)
    lines = ["# End-to-end note positions, HumTrans test, 4-beat bars (whole-bar shift allowed)\n"]
    for res_name in ("16th", "8th"):
        for bpb in (4, 2):
            d = df[(df.res == res_name) & (df.bpb == bpb)]
            lines.append(f"\n## snapped to {res_name}s, labelled {bpb} beats per bar ({d['clip'].nunique()} clips)\n")
            lines.append("| model | condition | note position | position + pitch | clips >= 90% positions | clips with every bar-1 note right |")
            lines.append("|---|---|---|---|---|---|")
            for (m, c), x in d.groupby(["model", "cond"]):
                w = x["n"]
                lines.append(f"| {m} | {c} | {np.average(x['pos'], weights=w):.0%} | {np.average(x['pos_pitch'], weights=w):.0%} | "
                             f"{(x['pos'] >= 0.9).mean():.0%} | {x['bar1_all'].mean():.0%} |")
    (args.out / "note_grid.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
