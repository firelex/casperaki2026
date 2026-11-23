"""Step 1 of the SwiftF0 front end: score each improvement of the curve-to-notes step (hum_pitch/notes.py).

  python -I scripts/notes_steps.py tune  --workers 12   # choose settings on humtrans-tune (HumTrans TRAIN) only
  python -I scripts/notes_steps.py score --workers 12   # score every step on humtrans-test and synth-test

Steps, each added to the previous one:
  0 baseline       plain SwiftF0 + segmentation (same as the baseline table)
  1 +tuning        per-recording detune subtracted (global, or drifting over time: chosen on tune)
  2 +key (est.)    ambiguous notes snapped to the scale of the key estimated from the notes
  2' +key (true)   the same with the key of the reference notes (an upper bound)
  3 +splitting     energy onsets, scoop merging, tempo-relative minimum note length (librosa tempo)
  3' +grid         the same with the labelled beat grid (tempo from it, onsets near grid sixteenths weighted up)

Tuning is greedy, one step at a time, on the objective "note F at +-100 ms with the right MIDI pitch" (pooled
over notes: precision and recall of reference notes matched by an estimated note of the same pitch starting within
+-100 ms), so that extra notes cost something. Chosen settings: results/notes-steps-settings.json.
Tables: results/notes-steps.md.
"""
import argparse
import itertools
import json
import sys
from dataclasses import asdict, replace
from multiprocessing import Pool
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
from hum_pitch.core import clip_metrics  # noqa: E402
from hum_pitch.notes import Config, transcribe  # noqa: E402
from hum_pitch.sets import references  # noqa: E402

SETTINGS = HERE / "results/notes-steps-settings.json"
_ROWS = None


def _init(rows):
    global _ROWS
    _ROWS = rows


def _eval(args):
    i, cfg = args
    r = _ROWS[i]
    m = clip_metrics(r["notes"], transcribe(r, cfg))
    return {k: m[k] for k in ("n_ref", "n_est", "n_good", "f_onset", "err_octave", "err_semitone", "err_other", "missed")} | {
        "group": r["group"], "lead": r["lead"], "round": r.get("round", ""), "sex": r.get("sex", "")}


def run(pool, n, cfgs: list[Config]) -> list[list[dict]]:
    jobs = [(i, c) for c in cfgs for i in range(n)]
    res = pool.map(_eval, jobs, chunksize=8)
    return [res[k * n:(k + 1) * n] for k in range(len(cfgs))]


def pooled(rs: list[dict]) -> dict:
    n_ref = sum(r["n_ref"] for r in rs)
    n_est = sum(r["n_est"] for r in rs)
    good = sum(r["n_good"] for r in rs)
    p, rec = good / max(n_est, 1), good / n_ref
    s = {"clips": len(rs), "right": rec, "precision": p, "f100": 2 * p * rec / (p + rec) if p + rec else 0.0,
         "f_onset": float(np.mean([r["f_onset"] for r in rs]))}
    for k in ("err_octave", "err_semitone", "err_other", "missed"):
        s[k] = sum(r[k] * r["n_ref"] for r in rs) / n_ref
    return s


def tune(workers: int):
    rows, _ = references("humtrans-tune")
    n = len(rows)
    chosen = {}
    with Pool(workers, initializer=_init, initargs=(rows,)) as pool:
        def pick(name, base, variants):
            res = run(pool, n, variants)
            scored = sorted(((pooled(r)["f100"], pooled(r)["right"], k) for k, r in enumerate(res)), reverse=True)
            for f, rr, k in scored[:5]:
                print(f"  {name}: f100 {f:.4f} right {rr:.4f}  {describe(variants[k], base)}")
            best = variants[scored[0][2]]
            chosen[name] = asdict(best)
            return best

        base = Config()
        print("baseline", pooled(run(pool, n, [base])[0]))
        c1 = pick("tuning", base, [replace(base, tuning="global")] + [replace(base, tuning="drift", drift_sigma_s=s) for s in (2.0, 4.0, 8.0, 16.0)])
        c2 = pick("key", c1, [replace(c1, key="estimated", snap_margin=m) for m in (0.1, 0.2, 0.3, 0.4, 0.45)])
        grid3 = [replace(c2, split="improved", onset_delta=d, scoop_max_s=sc, glide_min_st=g, min_note_beats=mb)
                 for d, sc, g, mb in itertools.product((0.5, 0.8, 1.2, 1.6, 2.0), (0.06, 0.12, 0.2), (0.3, 0.5, 1.0), (0.1, 0.2, 0.3))]
        c3 = pick("split", c2, grid3)
        grid4 = [replace(c3, grid=True, grid_weight=w, onset_delta=d, min_note_beats=mb)
                 for w, d, mb in itertools.product((0.0, 0.5, 1.0, 2.0), (0.5, 0.8, 1.2, 1.6, 2.0), (0.1, 0.2, 0.3))]
        pick("grid", c3, grid4)
    SETTINGS.write_text(json.dumps({"tuned_on": f"humtrans-tune ({n} HumTrans TRAIN recordings), greedy, objective f100"} | chosen, indent=1))
    print("wrote", SETTINGS)


def describe(c: Config, base: Config) -> str:
    a, b = asdict(c), asdict(base)
    return ", ".join(f"{k}={v}" for k, v in a.items() if v != b[k]) or "(same)"


def steps() -> list[tuple[str, Config]]:
    if not SETTINGS.exists():
        raise FileNotFoundError(f"{SETTINGS} missing: run 'notes_steps.py tune' first")
    s = json.loads(SETTINGS.read_text())
    c = {k: Config(**s[k]) for k in ("tuning", "key", "split", "grid")}
    return [
        ("0 baseline: SwiftF0 + segmentation", Config()),
        ("1 + tuning offset", c["tuning"]),
        ("2 + key snapping, key estimated", c["key"]),
        ("2' + key snapping, true key (upper bound)", replace(c["key"], key="true")),
        ("3 + better splitting (no grid)", c["split"]),
        ("3' + better splitting, labelled beat grid", c["grid"]),
        ("3' with the true key (upper bound)", replace(c["grid"], key="true")),
    ]


def table(title, groups, names, res_by_set) -> str:
    lines = [f"### {title}", "", "| slice | step | clips | right note | precision | F (+-100 ms, right pitch) | octave err | semitone err | other pitch err | missed | F onset (50 ms) |",
             "|---|---|---|---|---|---|---|---|---|---|---|"]
    for gname, sel in groups:
        for k, name in enumerate(names):
            rs = [r for r in res_by_set[k] if sel(r)]
            if not rs:
                continue
            s = pooled(rs)
            lines.append(f"| {gname} | {name} | {s['clips']} | {s['right']:.1%} | {s['precision']:.1%} | {s['f100']:.3f} | {s['err_octave']:.1%} | "
                         f"{s['err_semitone']:.1%} | {s['err_other']:.1%} | {s['missed']:.1%} | {s['f_onset']:.3f} |")
    return "\n".join(lines) + "\n"


def score(workers: int):
    st = steps()
    names = [n for n, _ in st]
    md = ["# SwiftF0 front end, step 1: curve-to-notes improvements (generated by scripts/notes_steps.py)", "",
          "Settings chosen on humtrans-tune only: " + ", ".join(f"step {k}: {describe(c, Config())}" for k, (_, c) in enumerate(st) if k), ""]
    for set_name, groups in (
        ("humtrans-test", [("all", lambda r: True), ("women", lambda r: r["sex"] == "F"), ("men", lambda r: r["sex"] == "M")]),
        ("synth-test", [("all", lambda r: True), ("voice", lambda r: r["group"] == "voice"), ("breathy", lambda r: r["group"] == "breathy"),
                        ("instrument", lambda r: r["group"] == "instrument"), ("round one", lambda r: r["round"] == "r1"),
                        ("round two", lambda r: r["round"] == "r2b")]),
    ):
        rows, _ = references(set_name)
        with Pool(workers, initializer=_init, initargs=(rows,)) as pool:
            res = run(pool, len(rows), [c for _, c in st])
        md.append(table(set_name, groups, names, res))
    (HERE / "results/notes-steps.md").write_text("\n".join(md))
    print("\n".join(md))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["tune", "score"])
    ap.add_argument("--workers", type=int, default=12)
    a = ap.parse_args()
    tune(a.workers) if a.mode == "tune" else score(a.workers)


if __name__ == "__main__":
    main()
