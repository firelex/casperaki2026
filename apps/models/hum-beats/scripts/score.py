"""Score beat trackers on the same files: beat F, downbeat F (70 ms), tempo accuracy (4%), half/double.

  python scripts/score.py --models final0 <run>/final-weights.ckpt --names final0 finetuned \
      --sets dev=<dir> test=<dir> test-unseen=<dir> test-humtrans=<dir> --hum-lab ~/casperaki-data/hum-lab \
      --out <results dir>

A set is a folder of <clip>.wav + <clip>.beats (+ <clip>.json for the breakdowns). The hum-lab folder holds the
owner's recordings with only a meant tempo (scored on tempo alone). Nothing is trimmed from the clip starts
(Beat This!'s paper metrics skip the first 5 s of songs; our clips are 2-36 s).
Writes <out>/per_clip.csv and <out>/summary.md.
"""
import argparse
import json
import math
import subprocess
import tempfile
from pathlib import Path

import mir_eval
import numpy as np
import pandas as pd
import soundfile as sf
import torch

TEMPO_TOL = 0.04


def tempo_from_beats(beats: np.ndarray) -> float | None:
    if len(beats) < 3:
        return None
    return 60.0 / float(np.median(np.diff(beats)))


def tempo_class(pred: float | None, truth: float) -> str:
    if pred is None:
        return "none"
    for name, f in (("correct", 1.0), ("half", 0.5), ("double", 2.0), ("third", 1 / 3), ("triple", 3.0), ("two_thirds", 2 / 3), ("three_halves", 1.5)):
        if abs(pred - truth * f) <= TEMPO_TOL * truth * f:
            return name
    return "other"


def fit_grid(beats: np.ndarray) -> tuple[float, float] | None:
    """One constant-tempo grid through the predicted beats: (period s, phase s), least squares on the beat
    times against their grid index (index from the median interval, so a missed beat does not shift it)."""
    if len(beats) < 3:
        return None
    p0 = float(np.median(np.diff(beats)))
    idx = np.round((beats - beats[0]) / p0)
    a = np.vstack([idx, np.ones_like(idx)]).T
    (period, phase), *_ = np.linalg.lstsq(a, beats, rcond=None)
    if period <= 0:
        return None
    return float(period), float(phase)


def grid_correct(pb: np.ndarray, pdb: np.ndarray, truth_bpm: float, tb: np.ndarray, td: np.ndarray | None, bpb_label: int | None,
                 meant_bpm: float | None, meter_known: bool = False) -> dict:
    """The owner's "grid correct" (hum-to-song snaps notes to one steady grid, so single-beat wobble does not
    matter). Fit one steady grid to the predicted beats; resolve the tempo octave (a) towards the meant tempo,
    (b) into 70-140 BPM with no hint; bar lines on that grid from the predicted downbeats (beats per bar from
    their median spacing, bar phase from where they fall). Correct = tempo within 4% of the label, the same
    beats per bar as the label, and at least 80% of the labelled downbeats within the tolerance of a fitted
    bar line (70 ms, or a quarter of the labelled beat)."""
    out = {}
    g = fit_grid(np.asarray(pb))
    for mode in ("meant", "nohint"):
        for tol in ("70ms", "quarterbeat"):
            out[f"grid_{mode}_{tol}"] = False
        out[f"tempo_{mode}"] = False
    if g is None:
        return out
    period, phase = g
    bpm = 60.0 / period
    pdb = np.asarray(pdb)
    for mode in ("meant", "nohint"):
        if mode == "meant":
            ref = meant_bpm if meant_bpm is not None else truth_bpm
            m = min((0.25, 0.5, 1.0, 2.0, 4.0), key=lambda f: abs(np.log(bpm * f / ref)))
        else:
            m = 1.0
            while bpm * m >= 140:
                m /= 2
            while bpm * m < 70:
                m *= 2
        t_bpm = bpm * m
        tempo_ok = abs(t_bpm - truth_bpm) <= 0.04 * truth_bpm
        out[f"tempo_{mode}"] = bool(tempo_ok)
        out[f"bpm_{mode}"] = t_bpm
        if td is None or bpb_label is None or len(pdb) < 2 or not tempo_ok:
            continue
        per = 60.0 / t_bpm
        # the grid's phase at the new density: when halving (or quartering), keep the phase whose beats meet the
        # most predicted downbeats
        k = int(round(per / period)) if per > period else 1
        best = None
        for j in range(k):
            ph = phase + j * period
            hits = np.sum(np.abs(((pdb - ph) / per) - np.round((pdb - ph) / per)) * per < 0.07)
            if best is None or hits > best[0]:
                best = (hits, ph)
        ph = best[1]
        # meter_known: the app knows the metre (e.g. the user picked it), so beats per bar come from the label and
        # only the bar phase is judged
        bpb = bpb_label if meter_known else int(round(float(np.median(np.diff(pdb))) / per))
        if bpb < 1:
            continue
        # bar phase: the grid beat (mod bpb) that most predicted downbeats fall on
        idx = np.round((pdb - ph) / per).astype(int) % bpb
        off = int(np.bincount(idx, minlength=bpb).argmax())
        lo = min(tb[0], pdb[0]) - 2 * bpb * per
        hi = max(tb[-1], pdb[-1]) + 2 * bpb * per
        n0 = int(np.floor((lo - ph) / per))
        n1 = int(np.ceil((hi - ph) / per))
        grid_beats = ph + np.arange(n0, n1 + 1) * per
        bars = grid_beats[((np.arange(n0, n1 + 1) - off) % bpb) == 0]
        if len(bars) == 0 or len(td) == 0:
            continue
        dist = np.min(np.abs(td[:, None] - bars[None, :]), axis=1)
        truth_beat = 60.0 / truth_bpm
        for tol, sec in (("70ms", 0.07), ("quarterbeat", truth_beat / 4)):
            out[f"grid_{mode}_{tol}"] = bool(bpb == bpb_label and np.mean(dist <= sec) >= 0.8)
        out[f"bpb_{mode}"] = bpb
        out[f"bar_hits_{mode}_70ms"] = float(np.mean(dist <= 0.07))
    return out


def read_beats(path: Path) -> tuple[np.ndarray, np.ndarray | None, int | None]:
    """Beat times, downbeat times and beats per bar; downbeats None when the file has no beat numbers (some
    GTZAN jazz annotations): such a clip is scored on beats and tempo, and left out of the downbeat score."""
    a = np.loadtxt(path, ndmin=2)
    if a.shape[1] == 1:
        return a[:, 0], None, None
    return a[:, 0], a[a[:, 1] == 1, 0], int(a[:, 1].max())


def band(bpm: float) -> str:
    for lo, hi in ((60, 90), (90, 120), (120, 150), (150, 201)):
        if lo <= bpm < hi:
            return f"{lo}-{min(hi, 200)}"
    return "outside 60-200"


def clip_info(meta: dict | None) -> dict:
    if meta is None:
        return {}
    if "genre" in meta:
        return {"genre": meta["genre"]}
    if "singer" in meta and "lead" not in meta:
        return {"singer": meta["singer"], "tempo_band": band(meta["bpm"])}
    if "lead" not in meta:
        return {}
    g = meta["lead"]["group"]
    return {
        "meter": meta["meter"], "timing": meta["timing"], "style": meta["style"], "start": meta["start_mode"],
        "bars": meta["n_bars"], "pollution": meta["pollution"]["level"], "lead_group": g,
        "lead": "voice" if g in ("voice", "vocal_sample", "soulx") else ("breathy" if g == "breathy" else "instrument"),
        "tempo_band": band(meta["bpm"]), "timbre": meta["lead"]["timbre"], "accompaniment": "melody alone",
    }


def load_model(name: str, dbn: bool):
    from beat_this.inference import Audio2Beats
    return Audio2Beats(checkpoint_path=name, device="cuda", float16=False, dbn=dbn)


def select(wavs, which: str | None):
    """'even' / 'odd': keep clips whose trailing number is even / odd (GTZAN dev / test halves)."""
    if which is None:
        return wavs
    if which not in ("even", "odd"):
        raise SystemExit(f"unknown selection @{which} (use @even or @odd)")
    return [w for w in wavs if (int(w.stem.rsplit("_", 1)[-1]) % 2 == 0) == (which == "even")]


def hum_lab_items(folder: Path, ffmpeg: str = "ffmpeg"):
    """(id, mono 22,050 Hz audio, meant BPM) for every kept hum-lab recording."""
    for j in sorted(folder.glob("*.json")):
        meta = json.loads(j.read_text())
        if "meantBpm" not in meta or "audio" not in meta:
            raise ValueError(f"{j}: not a hum-lab record (needs meantBpm and audio)")
        src = folder / meta["audio"]
        with tempfile.TemporaryDirectory() as d:
            wav = Path(d) / "a.wav"
            subprocess.run([ffmpeg, "-loglevel", "error", "-y", "-i", str(src), "-ac", "1", "-ar", "22050", str(wav)], check=True)
            y, sr = sf.read(wav, dtype="float32")
        yield j.stem, y, sr, float(meta["meantBpm"]), meta


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", nargs="+", required=True)
    ap.add_argument("--names", nargs="+", required=True)
    ap.add_argument("--sets", nargs="*", default=[], help="name=folder")
    ap.add_argument("--hum-lab", type=Path)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--dbn", action="store_true", help="also score every model with Beat This!'s DBN post-processing (name+dbn)")
    args = ap.parse_args()
    if len(args.models) != len(args.names):
        raise SystemExit("--models and --names must pair up")
    args.out.mkdir(parents=True, exist_ok=True)
    rows = []
    runs = [(p, n, False) for p, n in zip(args.models, args.names)]
    if args.dbn:
        runs += [(p, n + "+dbn", True) for p, n in zip(args.models, args.names)]
    names = [n for _, n, _ in runs]
    for model_path, model_name, dbn in runs:
        model = load_model(model_path, dbn)
        for spec in args.sets:
            set_name, folder = spec.split("=", 1)
            which = None
            if "@" in folder:
                folder, which = folder.rsplit("@", 1)
            folder = Path(folder)
            wavs = select(sorted(folder.glob("*.wav")), which)
            if not wavs:
                raise SystemExit(f"{folder}: no .wav files")
            for w in wavs:
                y, sr = sf.read(w, dtype="float32")
                with torch.inference_mode():
                    pb, pd_ = model(y, sr)
                tb, td, bpb_label = read_beats(w.with_suffix(".beats"))
                jp = w.with_suffix(".json")
                meta = json.loads(jp.read_text()) if jp.exists() else None
                truth_tempo = tempo_from_beats(tb)
                pred_tempo = tempo_from_beats(np.asarray(pb))
                rows.append({
                    "model": model_name, "set": set_name, "clip": w.stem,
                    "beat_f": mir_eval.beat.f_measure(tb, np.asarray(pb)),
                    "downbeat_f": mir_eval.beat.f_measure(td, np.asarray(pd_)) if td is not None and len(td) else math.nan,
                    "truth_bpm": truth_tempo, "pred_bpm": pred_tempo, "tempo": tempo_class(pred_tempo, truth_tempo),
                    "n_truth_beats": len(tb), "n_pred_beats": len(pb), **clip_info(meta),
                    **grid_correct(np.asarray(pb), np.asarray(pd_), truth_tempo, tb, td, bpb_label, None),
                    "pred_beats": " ".join(f"{x:.3f}" for x in pb), "pred_downbeats": " ".join(f"{x:.3f}" for x in pd_),
                })
            print(f"{model_name} {set_name}: {len(wavs)} clips scored", flush=True)
        if args.hum_lab:
            n = 0
            for cid, y, sr, meant, meta in hum_lab_items(args.hum_lab):
                with torch.inference_mode():
                    pb, pd_ = model(y, sr)
                pred_tempo = tempo_from_beats(np.asarray(pb))
                g = grid_correct(np.asarray(pb), np.asarray(pd_), meant, np.array([]), None, None, meant)
                rows.append({"model": model_name, "set": "hum-lab", "clip": cid, "beat_f": math.nan, "downbeat_f": math.nan,
                             "truth_bpm": meant, "pred_bpm": pred_tempo, "tempo": tempo_class(pred_tempo, meant),
                             "n_truth_beats": 0, "n_pred_beats": len(pb), "tempo_meant": g["tempo_meant"], "tempo_nohint": g["tempo_nohint"],
                             "pred_beats": " ".join(f"{x:.3f}" for x in pb), "pred_downbeats": " ".join(f"{x:.3f}" for x in pd_)})
                n += 1
            print(f"{model_name} hum-lab: {n} recordings scored", flush=True)
        del model
        torch.cuda.empty_cache()
    df = pd.DataFrame(rows)
    df.to_csv(args.out / "per_clip.csv", index=False)
    (args.out / "summary.md").write_text(summarise(df, names))
    print((args.out / "summary.md").read_text())


def agg(g: pd.DataFrame) -> dict:
    return {"clips": len(g), "beat F": g["beat_f"].mean(), "downbeat F": g["downbeat_f"].mean(),
            "tempo ok": (g["tempo"] == "correct").mean(), "half": (g["tempo"] == "half").mean(),
            "double": (g["tempo"] == "double").mean(), "other": (~g["tempo"].isin(["correct", "half", "double"])).mean()}


def table(df: pd.DataFrame, names, by: str | None) -> str:
    keys = [None] if by is None else sorted(df[by].dropna().unique(), key=str)
    head = "| " + (by or "set") + " | clips | " + " | ".join(f"beat F {n} | downbeat F {n} | tempo ok {n} | half/double {n}" for n in names) + " |"
    sep = "|" + "---|" * (2 + 4 * len(names))
    lines = [head, sep]
    for k in keys:
        cells = []
        n_clips = None
        for n in names:
            g = df[df["model"] == n] if by is None else df[(df["model"] == n) & (df[by] == k)]
            a = agg(g)
            n_clips = a["clips"]
            f = lambda x: "-" if (x is None or (isinstance(x, float) and math.isnan(x))) else f"{x:.3f}"  # noqa: E731
            cells.append(f"{f(a['beat F'])} | {f(a['downbeat F'])} | {a['tempo ok']:.0%} | {a['half']:.0%}/{a['double']:.0%}")
        lines.append(f"| {'all' if k is None else k} | {n_clips} | " + " | ".join(cells) + " |")
    return "\n".join(lines)


def grid_table(df: pd.DataFrame, names) -> str:
    cols = [("grid_meant_70ms", "grid (meant tempo, 70 ms)"), ("grid_meant_quarterbeat", "grid (meant tempo, 1/4 beat)"),
            ("grid_nohint_70ms", "grid (no hint, 70 ms)"), ("grid_nohint_quarterbeat", "grid (no hint, 1/4 beat)")]
    lines = ["| model | clips | " + " | ".join(c for _, c in cols) + " | tempo right, bars wrong (meant, 70 ms) | tempo right, bars wrong (no hint, 70 ms) |",
             "|" + "---|" * (len(cols) + 4)]
    for n in names:
        g = df[df["model"] == n]
        if "grid_meant_70ms" not in g or g["grid_meant_70ms"].isna().all():
            continue
        cells = [f"{g[c].astype(bool).mean():.0%}" for c, _ in cols]
        tw_m = (g["tempo_meant"].astype(bool) & ~g["grid_meant_70ms"].astype(bool)).mean()
        tw_n = (g["tempo_nohint"].astype(bool) & ~g["grid_nohint_70ms"].astype(bool)).mean()
        lines.append(f"| {n} | {len(g)} | " + " | ".join(cells) + f" | {tw_m:.0%} | {tw_n:.0%} |")
    return "\n".join(lines)


def summarise(df: pd.DataFrame, names) -> str:
    out = ["# Scores (same files for every model)\n", "Beat and downbeat F-measure: mir_eval, 70 ms window, mean over clips, nothing trimmed. "
           "Tempo ok: the median predicted beat interval is within 4% of the labelled one (hum-lab: of the meant tempo); "
           "half/double: within 4% of half or double.\n"]
    for s in df["set"].unique():
        d = df[df["set"] == s]
        out.append(f"\n## {s}\n\n" + table(d, names, None))
        if s == "hum-lab":
            out.append("\nTempo with the meant tempo as hint / with no hint (70-140 BPM): " + ", ".join(
                f"{n}: {d[d['model'] == n]['tempo_meant'].astype(bool).mean():.0%} / {d[d['model'] == n]['tempo_nohint'].astype(bool).mean():.0%}" for n in names))
        elif "grid_meant_70ms" in d:
            out.append(f"\n### {s}: grid correct (one steady grid with bar lines; see scripts/score.py grid_correct)\n\n" + grid_table(d, names))
        for by in ("lead", "lead_group", "timing", "meter", "tempo_band", "pollution", "style", "start", "bars", "genre", "singer"):
            if by in d and d[by].notna().any():
                out.append(f"\n### {s} by {by}\n\n" + table(d, names, by))
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    main()
