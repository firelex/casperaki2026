"""Bar phase with 4-beat bars: (1) top-k phase accuracy of the downbeat activations, (2) a harmonic phase cue.

  python scripts/phase_harmony.py --act /mnt/d/casperaki-data/hum-beats/grid4/act --model final --dbn \
      --notes-dir /mnt/d/casperaki-data/hum-beats/grid4/notes-swiftf0 --out <dir>

Uses the activations and beats saved by scripts/grid4.py (same grid, tempo octave towards the label tempo).
(1) On clips with the right tempo: rank of the correct bar phase among the 4 phases ordered by mean downbeat activation
    (2/4 labels: either of the two fitting phases counts; correct = 80% of labelled downbeats within 70 ms).
(2) Harmonic cue: key from the notes (Krumhansl-Schmuckler, duration weighted); for each candidate phase, each bar
    (or half bar) gets the diatonic triad that covers most of its note weight (overlap duration, doubled for a note
    starting on the segment's first beat); the phase's fit = covered weight / all weight. Phase score = downbeat score
    (normalised to its maximum) + weight x fit. Unit and weight chosen on humtrans-dev only, then test once.
    Notes: TRANSCRIBED (hum-pitch SwiftF0 + tuning + key snapping) or LABELLED (HumTrans notes; an upper bound).
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from grid4 import act_at, fit_grid, read_labels  # noqa: E402

MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def key_triads(notes):
    pcs = np.zeros(12)
    for a, b, m in notes:
        pcs[int(m) % 12] += b - a
    best = None
    for tonic in range(12):
        for prof, mode in ((MAJOR, "major"), (MINOR, "minor")):
            r = np.corrcoef(np.roll(prof, tonic), pcs)[0, 1] if pcs.sum() > 0 else 0
            if best is None or r > best[0]:
                best = (r, tonic, mode)
    _, tonic, mode = best
    scale = [0, 2, 4, 5, 7, 9, 11] if mode == "major" else [0, 2, 3, 5, 7, 8, 10]
    triads = [{(tonic + scale[i]) % 12, (tonic + scale[(i + 2) % 7]) % 12, (tonic + scale[(i + 4) % 7]) % 12} for i in range(7)]
    if mode == "minor":
        triads.append({(tonic + 7) % 12, (tonic + 11) % 12, (tonic + 2) % 12})  # the major V of the harmonic minor
    return triads


def harmonic_fit(notes, starts, seg_len, per, triads):
    tot = cov = 0.0
    for s in starts:
        e = s + seg_len
        w = np.zeros(12)
        for a, b, m in notes:
            ov = min(b, e) - max(a, s)
            if ov <= 0:
                continue
            w[int(m) % 12] += ov * (2.0 if abs(a - s) <= per / 4 else 1.0)
        if w.sum() == 0:
            continue
        tot += w.sum()
        cov += max(sum(w[p] for p in t) for t in triads)
    return cov / tot if tot > 0 else 0.0


def clip_eval(z, beats, notes, weights, units):
    tb, td, bpb = read_labels(Path(str(z["labels"])))
    if bpb not in (2, 4) or td is None:
        return None
    truth = 60 / float(np.median(np.diff(tb)))
    g = fit_grid(np.asarray(beats))
    if g is None:
        return {"tempo": False, "bpb": bpb}
    period, phase = g
    m = min((0.25, 0.5, 1, 2, 4), key=lambda f: abs(np.log(60 / period * f / truth)))
    per = period / m
    if abs(60 / per - truth) > 0.04 * truth:
        return {"tempo": False, "bpb": bpb}
    act = z["db_act"]
    dur = len(act) / 50
    k = int(round(per / period)) if per > period * 1.01 else 1
    cands = []
    for j in range(k):
        ph = phase + j * period
        n0, n1 = int(np.floor(-ph / per)), int(np.ceil((dur - ph) / per))
        gb = ph + np.arange(n0, n1 + 1) * per
        gb = gb[(gb >= 0) & (gb < dur)]
        cands.append((act_at(act, gb).sum(), gb))
    gb = max(cands, key=lambda c: c[0])[1]
    if len(gb) < 4:
        return {"tempo": True, "bpb": bpb, "rank": None}
    a = act_at(act, gb)
    db = np.array([a[i::4].mean() for i in range(4)])
    labels = [td] if bpb == 4 else [td[0::2], td[1::2]]
    correct = [any(len(ls) and np.mean(np.min(np.abs(ls[:, None] - gb[i::4][None, :]), axis=1) <= 0.07) >= 0.8 for ls in labels) for i in range(4)]
    order = list(np.argsort(-db))
    rank = min((order.index(i) + 1 for i in range(4) if correct[i]), default=None)
    out = {"tempo": True, "bpb": bpb, "rank": rank, "base": bool(correct[int(np.argmax(db))])}
    if notes is not None and len(notes):
        triads = key_triads(notes)
        for unit in units:
            seg = 4 * per if unit == "bar" else 2 * per
            fits = []
            for i in range(4):
                starts = gb[i::4] if unit == "bar" else np.sort(np.concatenate([gb[i::4], gb[(i + 2) % 4::4]]))
                fits.append(harmonic_fit(notes, starts, seg, per, triads))
            fits = np.array(fits)
            for w in weights:
                sc = db / (db.max() + 1e-9) + w * fits
                out[f"h_{unit}_{w}"] = bool(correct[int(np.argmax(sc))])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--act", type=Path, required=True)
    ap.add_argument("--model", default="final")
    ap.add_argument("--dbn", action="store_true")
    ap.add_argument("--notes-dir", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()
    weights = [0.25, 0.5, 1.0, 2.0, 4.0]
    units = ["bar", "half"]
    key = "beats+dbn" if args.dbn else "beats"
    res = {}
    for sname in ("humtrans-dev", "humtrans-test", "gtzan-vocals"):
        for src in ("transcribed", "labelled", None):
            if sname == "gtzan-vocals" and src is not None:
                continue
            rows = []
            for f in sorted((args.act / args.model / sname).glob("*.npz")):
                z = np.load(f, allow_pickle=True)
                notes = None
                if src == "transcribed":
                    p = args.notes_dir / f"{f.stem}.json"
                    if not p.exists():
                        raise FileNotFoundError(f"no transcription for {f.stem}")
                    notes = json.loads(p.read_text())
                elif src == "labelled":
                    meta = json.loads(Path(str(z["meta"])).read_text())
                    notes = [[n["onset"], n["offset"], n["midi"]] for n in meta["notes"]]
                r = clip_eval(z, z[key], notes, weights, units)
                if r is not None:
                    rows.append(r)
            res[(sname, src)] = rows
    lines = [f"# Bar phase with 4-beat bars: {args.model}{' + DBN' if args.dbn else ''}\n", "## Top-k phase accuracy (clips with the right tempo)\n",
             "| set | labelled beats per bar | clips with right tempo | correct phase ranked 1st | in top 2 | in top 3 | no phase correct |", "|---|---|---|---|---|---|---|"]
    for sname in ("humtrans-test", "humtrans-dev", "gtzan-vocals"):
        rows = [r for r in res[(sname, None)] if r["tempo"]]
        for bpb in (4, 2):
            x = [r for r in rows if r["bpb"] == bpb]
            if not x:
                continue
            rk = [r.get("rank") for r in x]
            f = lambda k: np.mean([v is not None and v <= k for v in rk])  # noqa: E731
            lines.append(f"| {sname} | {bpb} | {len(x)} | {f(1):.0%} | {f(2):.0%} | {f(3):.0%} | {np.mean([v is None for v in rk]):.0%} |")
    lines += ["\n## Harmonic phase cue (share of right-tempo clips whose chosen phase is correct)\n"]
    for src in ("transcribed", "labelled"):
        dev = [r for r in res[("humtrans-dev", src)] if r["tempo"] and r.get("rank") is not None]
        grid = {(u, w): np.mean([r[f"h_{u}_{w}"] for r in dev]) for u in units for w in weights}
        base_dev = np.mean([r["base"] for r in dev])
        (bu, bw), bv = max(grid.items(), key=lambda kv: kv[1])
        lines.append(f"**{src} notes** - dev (humtrans-dev, right-tempo clips, n={len(dev)}): downbeat only {base_dev:.0%}; " +
                     ", ".join(f"{u}/w{w} {v:.0%}" for (u, w), v in grid.items()) + f". Chosen: {bu}, weight {bw}.\n")
        for sname in ("humtrans-test",):
            for bpb in (4, 2):
                t = [r for r in res[(sname, src)] if r["tempo"] and r["bpb"] == bpb and r.get("rank") is not None]
                all_t = [r for r in res[(sname, src)] if r["bpb"] == bpb]
                lines.append(f"- test {sname} {bpb} beats per bar: right-tempo clips {len(t)}; phase correct: downbeat only "
                             f"{np.mean([r['base'] for r in t]):.0%} -> with harmonic cue {np.mean([r[f'h_{bu}_{bw}'] for r in t]):.0%}; "
                             f"grid correct over all {len(all_t)} clips: {np.mean([r.get('base', False) for r in all_t]):.0%} -> "
                             f"{np.mean([r.get(f'h_{bu}_{bw}', False) for r in all_t]):.0%}")
        lines.append("")
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "phase.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
