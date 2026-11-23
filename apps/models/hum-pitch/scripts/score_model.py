"""Score a trained hum-to-notes checkpoint against today's best (SwiftF0 + tuning offset + estimated-key snapping).

  python -I scripts/score_model.py --checkpoint <run>/final.pt --name <run name> [--workers 12]

The decoding thresholds (onset t_on, activity t_act) are chosen on humtrans-tune (HumTrans TRAIN) only, on F at
+-100 ms with the right pitch. Then humtrans-test (by gender) and synth-test (voice / breathy / instrument leads,
round one / round two) are scored: right note %, precision, F, octave and semitone errors (hum_pitch.core.clip_metrics),
and key accuracy:
  * HumTrans: the model's key signature (argmax of its 12-class key output) against the MIDI key signature, and whether
    it is one of the diatonic scales that best hold the reference notes; the same for Krumhansl-Schmuckler on the
    notes of today's best (its key mapped to its key signature).
  * synthetic: whether the key signature is one of the scales that best hold the intended notes.
CPU only. Writes results/model-<name>.md and results/model-<name>-settings.json.
"""
import argparse
import json
import os
import sys
from multiprocessing import Pool
from pathlib import Path

os.environ["CUDA_VISIBLE_DEVICES"] = ""
os.environ["OMP_NUM_THREADS"] = "1"

import numpy as np  # noqa: E402
import torch  # noqa: E402

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "scripts"))
from hum_pitch.core import DATA, clip_metrics  # noqa: E402
from hum_pitch.model import decode, load_checkpoint, model_inputs, reference_pitch  # noqa: E402
from hum_pitch.notes import Config, curve_from_features, estimate_key, transcribe  # noqa: E402

FEAT = DATA / "features"
T_ON = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]
T_ACT = [0.3, 0.4, 0.5, 0.6]


def sig_of(tonic: int, mode: str) -> int:
    return tonic if mode == "major" else (tonic + 3) % 12


def load_set(name):
    z = np.load(FEAT / f"{name}.npz")
    metas = [json.loads(l) for l in (FEAT / f"{name}.jsonl").read_text().splitlines()]
    fo, no = z["frame_offsets"], z["note_offsets"]
    return [m | {"feat": z["feat"][fo[i]:fo[i + 1]], "ref_notes": z["notes"][no[i]:no[i + 1]].tolist()} for i, m in enumerate(metas)]


@torch.no_grad()
def run_model(model, clips):
    out = []
    for c in clips:
        ref = reference_pitch(c["feat"])
        x = torch.from_numpy(model_inputs(c["feat"], ref))[None]
        mask = torch.ones(1, x.shape[1], dtype=torch.bool)
        lo, la, ld, lk, lk24 = model(x, mask)
        out.append({"onset": torch.sigmoid(lo[0]).numpy(), "active": torch.sigmoid(la[0]).numpy(),
                    "delta": torch.softmax(ld[0], -1).numpy(), "key": torch.softmax(lk[0], -1).numpy(), "ref": ref,
                    "key24": None if lk24 is None else torch.softmax(lk24[0], -1).numpy()})
    return out


def pooled(rs):
    n_ref = sum(r["n_ref"] for r in rs)
    n_est = sum(r["n_est"] for r in rs)
    good = sum(r["n_good"] for r in rs)
    p, rec = good / max(n_est, 1), good / n_ref
    s = {"clips": len(rs), "right": rec, "precision": p, "f100": 2 * p * rec / (p + rec) if p + rec else 0.0}
    for k in ("err_octave", "err_semitone", "err_other", "missed"):
        s[k] = sum(r[k] * r["n_ref"] for r in rs) / n_ref
    return s


def _baseline(args):
    """Today's best on one clip: notes and its Krumhansl-Schmuckler key signature. The SwiftF0 curve comes from the
    predict.py cache for the standing sets, from the stored features for --extra-sets (no cache exists for them)."""
    c, from_features = args
    row = {"id": c["id"], "wav": c["wav"], "notes": c["ref_notes"]}
    cfg = Config(**json.loads((HERE / "results/notes-steps-settings.json").read_text())["key"])
    notes = transcribe(row, cfg, curve_from_features(c["feat"]) if from_features else None)
    if notes:
        a = np.asarray(notes, dtype=float)
        sig = sig_of(*estimate_key(a[:, 2].astype(int), a[:, 1] - a[:, 0]))
    else:
        sig = -1
    return notes, sig


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", type=Path, required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--extra-sets", nargs="*", default=[], help="more feature sets from scripts/features.py --dirs (e.g. r3-test, r3-test-unseen), broken down by lead group")
    args = ap.parse_args()
    torch.set_num_threads(8)
    model = load_checkpoint(args.checkpoint)
    # thresholds on humtrans-tune
    tune = load_set("humtrans-tune")
    outs = run_model(model, tune)
    grid = []
    for t_on in T_ON:
        for t_act in T_ACT:
            rs = [clip_metrics(c["ref_notes"], decode(o["onset"], o["active"], o["delta"], o["ref"], t_on, t_act)) for c, o in zip(tune, outs)]
            grid.append((pooled(rs)["f100"], t_on, t_act, pooled(rs)["right"]))
    grid.sort(reverse=True)
    f_best, t_on, t_act, _ = grid[0]
    print("thresholds on humtrans-tune:", [tuple(round(v, 4) for v in g) for g in grid[:5]])
    md = [f"# Hum-to-notes model `{args.name}` vs today's best (generated by scripts/score_model.py)", "",
          f"Checkpoint `{args.checkpoint}`; decoding thresholds from humtrans-tune: onset {t_on}, activity {t_act} (F100 there {f_best:.3f}).",
          "Today's best = SwiftF0 + tuning offset + key snapping with the estimated key (results/step1.md).", ""]
    settings = {"checkpoint": str(args.checkpoint), "t_on": t_on, "t_act": t_act, "tune_grid": grid}
    for set_name, groups in (
        ("humtrans-test", [("all", lambda c: True), ("women", lambda c: c.get("sex") == "F"), ("men", lambda c: c.get("sex") == "M")]),
        ("synth-test", [("all", lambda c: True), ("voice", lambda c: c["group"] == "voice"), ("breathy", lambda c: c["group"] == "breathy"),
                        ("instrument", lambda c: c["group"] == "instrument"), ("round one", lambda c: c.get("round") == "r1"),
                        ("round two", lambda c: c.get("round") == "r2b")]),
    ) + tuple((x, [("all", lambda c: True), ("voice", lambda c: c["group"] == "voice"), ("breathy", lambda c: c["group"] == "breathy"),
                    ("instrument", lambda c: c["group"] == "instrument")]) for x in args.extra_sets):
        clips = load_set(set_name)
        outs = run_model(model, clips)
        with Pool(args.workers) as pool:
            base = pool.map(_baseline, [(c, set_name in args.extra_sets) for c in clips], chunksize=4)
        rows = []
        for c, o, (bn, bsig) in zip(clips, outs, base):
            mn = decode(o["onset"], o["active"], o["delta"], o["ref"], t_on, t_act)
            ksig = int(np.argmax(o["key"]))
            best_sets = np.asarray(c["sig_soft"]) > 0
            r = {"c": c, "model": clip_metrics(c["ref_notes"], mn), "base": clip_metrics(c["ref_notes"], bn),
                 "key_model_best": bool(best_sets[ksig]), "key_base_best": bool(bsig >= 0 and best_sets[bsig])}
            if c.get("key_label") is not None:
                if o["key24"] is None:
                    raise ValueError(f"{c['id']} has a stored key but the model has no 24-class key head")
                r["key24_ok"] = int(np.argmax(o["key24"])) == c["key_label"]
            if "key_signature" in c:
                r["key_model_sig"] = ksig == c["key_signature"]
                r["key_base_sig"] = bsig == c["key_signature"]
            rows.append(r)
        md += [f"### {set_name}", "",
               "| slice | system | clips | right note | precision | F (+-100 ms) | octave err | semitone err | other pitch err | missed | key = MIDI signature | key fits the notes best |",
               "|---|---|---|---|---|---|---|---|---|---|---|---|"]
        for gname, sel in groups:
            sub = [r for r in rows if sel(r["c"])]
            if not sub:
                continue
            for sysname, mk, kk in (("today's best", "base", "base"), (f"model {args.name}", "model", "model")):
                s = pooled([r[mk] for r in sub])
                ks = f"{np.mean([r[f'key_{kk}_sig'] for r in sub]):.1%}" if "key_model_sig" in sub[0] else "n/a"
                kb = f"{np.mean([r[f'key_{kk}_best'] for r in sub]):.1%}"
                k24 = [r["key24_ok"] for r in sub if "key24_ok" in r]
                k24s = f" (24-class key right: {np.mean(k24):.1%} of {len(k24)})" if k24 and mk == "model" else ""
                md.append(f"| {gname} | {sysname}{k24s} | {s['clips']} | {s['right']:.1%} | {s['precision']:.1%} | {s['f100']:.3f} | {s['err_octave']:.1%} | "
                          f"{s['err_semitone']:.1%} | {s['err_other']:.1%} | {s['missed']:.1%} | {ks} | {kb} |")
        md.append("")
    (HERE / f"results/model-{args.name}.md").write_text("\n".join(md))
    (HERE / f"results/model-{args.name}-settings.json").write_text(json.dumps(settings, indent=1))
    print("\n".join(md))


if __name__ == "__main__":
    main()
