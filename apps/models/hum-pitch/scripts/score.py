"""Score every model on the test sets and write the tables.

  python -I scripts/score.py --workers 8

Models: Basic Pitch with its defaults, Basic Pitch with the settings from scripts/tune_basic_pitch.py, pYIN +
note segmentation, SwiftF0 + note segmentation (hum_pitch.core.segment_notes, same settings for both).
Sets: humtrans-test (real hums, octave-corrected references) and synth-test (intended pitch at performed times).

Per clip: mir_eval note F with onset only and with onset + offset (mean over clips). Pitch identity (note
counts pooled over clips): share of reference notes with an estimated note of the same MIDI pitch starting within
+-100 ms, and the share with an octave error, a one-semitone error, another wrong pitch, or nothing near.
Writes results/tables.md (in the repo) and /mnt/d/casperaki-data/hum-pitch/results/per_clip.csv.
"""
import argparse
import csv
import json
import os
import sys
from multiprocessing import Pool
from pathlib import Path

os.environ["CUDA_VISIBLE_DEVICES"] = ""
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")

import numpy as np  # noqa: E402

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
from hum_pitch.core import DATA, clip_metrics  # noqa: E402
from hum_pitch.models import BP_DEFAULT, basic_pitch_notes, curve_notes  # noqa: E402
from hum_pitch.sets import references  # noqa: E402

SETS = ["humtrans-test", "synth-test"]
METRIC_KEYS = ["f_onset", "f_onset_offset", "pitch_ok", "err_octave", "err_semitone", "err_other", "missed"]


def model_list() -> dict:
    tuned_path = HERE / "results/basic-pitch-tuned.json"
    if not tuned_path.exists():
        raise FileNotFoundError(f"{tuned_path} missing: run scripts/tune_basic_pitch.py first")
    t = json.loads(tuned_path.read_text())
    tuned = {"onset": t["onset"], "frame": t["frame"], "min_note_ms": t["min_note_ms"]}
    return {
        "Basic Pitch, defaults": ("bp", BP_DEFAULT),
        f"Basic Pitch, tuned (onset {tuned['onset']}, frame {tuned['frame']}, min {tuned['min_note_ms']:g} ms)": ("bp", tuned),
        "pYIN + segmentation": ("pyin", None),
        "SwiftF0 + segmentation": ("swiftf0", None),
    }


MODELS = None


def _init():
    global MODELS
    MODELS = model_list()


def _clip(row: dict) -> list[dict]:
    out = []
    for name, (kind, p) in MODELS.items():
        est = basic_pitch_notes(row["id"], p["onset"], p["frame"], p["min_note_ms"]) if kind == "bp" else curve_notes(kind, row["id"])
        m = clip_metrics(row["notes"], est)
        out.append({"model": name, "set": row["set"], "id": row["id"], "group": row["group"], "lead": row["lead"],
                    "round": row.get("round", ""), "pollution": row.get("pollution", ""), "sex": row.get("sex", "")} | m)
    return out


def summarise(rs: list[dict]) -> dict:
    n = sum(r["n_ref"] for r in rs)
    s = {"clips": len(rs), "notes": n, "f_onset": np.mean([r["f_onset"] for r in rs]), "f_onset_offset": np.mean([r["f_onset_offset"] for r in rs])}
    for k in METRIC_KEYS[2:]:
        s[k] = sum(r[k] * r["n_ref"] for r in rs) / n
    wrong = s["err_octave"] + s["err_semitone"] + s["err_other"]
    s["octave_of_wrong"] = s["err_octave"] / wrong if wrong else 0.0
    s["semitone_of_wrong"] = s["err_semitone"] / wrong if wrong else 0.0
    return s


def table(title: str, groups: list[tuple[str, list[dict]]], models: list[str]) -> str:
    lines = [f"### {title}", "",
             "| slice | model | clips | F onset | F onset+offset | right pitch (+-100 ms) | octave err | semitone err | other pitch err | missed | octave / semitone share of wrong pitches |",
             "|---|---|---|---|---|---|---|---|---|---|---|"]
    for gname, rs in groups:
        for m in models:
            sel = [r for r in rs if r["model"] == m]
            if not sel:
                continue
            s = summarise(sel)
            lines.append(f"| {gname} | {m} | {s['clips']} | {s['f_onset']:.3f} | {s['f_onset_offset']:.3f} | {s['pitch_ok']:.1%} | {s['err_octave']:.1%} | "
                         f"{s['err_semitone']:.1%} | {s['err_other']:.1%} | {s['missed']:.1%} | {s['octave_of_wrong']:.0%} / {s['semitone_of_wrong']:.0%} |")
    return "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()
    models = list(model_list())
    rows, notes_md = [], []
    for s in SETS:
        r, excluded = references(s)
        rows += r
        if excluded:
            notes_md.append(f"- {s}: {len(excluded)} recordings left out (no clear hummed octave): " + ", ".join(sorted(excluded)))
    with Pool(args.workers, initializer=_init) as pool:
        res = [x for c in pool.map(_clip, rows, chunksize=4) for x in c]
    out = DATA / "results"
    out.mkdir(parents=True, exist_ok=True)
    with open(out / "per_clip.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(res[0]))
        w.writeheader()
        w.writerows(res)
    ht = [r for r in res if r["set"] == "humtrans-test"]
    sy = [r for r in res if r["set"] == "synth-test"]
    md = ["# hum-pitch baseline tables (generated by scripts/score.py)", ""] + notes_md + [""]
    md.append(table("Real hums: HumTrans test", [("all", ht), ("women", [r for r in ht if r["sex"] == "F"]), ("men", [r for r in ht if r["sex"] == "M"])], models))
    md.append(table("Synthetic hums: test (rounds one and two)", [
        ("all", sy),
        ("voice leads", [r for r in sy if r["group"] == "voice"]),
        ("breathy leads", [r for r in sy if r["group"] == "breathy"]),
        ("instrument leads", [r for r in sy if r["group"] == "instrument"]),
        ("voice: SoulX singer (round two)", [r for r in sy if r["lead"] == "soulx"]),
        ("voice: hum-like synthetic voice", [r for r in sy if r["lead"] == "voice"]),
        ("round one", [r for r in sy if r["round"] == "r1"]),
        ("round two", [r for r in sy if r["round"] == "r2b"]),
        ("pollution none/light", [r for r in sy if r["pollution"] in ("none", "light")]),
        ("pollution medium/heavy", [r for r in sy if r["pollution"] in ("medium", "heavy")]),
    ], models))
    (HERE / "results/tables.md").write_text("\n".join(md))
    print("\n".join(md))


if __name__ == "__main__":
    main()
