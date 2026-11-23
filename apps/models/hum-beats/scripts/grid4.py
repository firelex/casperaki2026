"""Grid-correct with 4-beat bars (owner's decision: hum-to-song assumes 4 beats per bar).

  python scripts/grid4.py --models final0 <ckpt> --names final0 final --sets name=folder[@even|@odd] ... --out <dir>
  python scripts/grid4.py --from-activations <dir> --out <dir2> [--phase-rule ...]   (rescore saved activations)

Per clip and model: framewise beat / downbeat activations (saved to <out>/act/<model>/<set>/<clip>.npz), beats from the
minimal post-processing or the DBN. One steady grid (tempo, phase) is fitted to the beats; the tempo octave is resolved
(a) towards the label tempo ("meant"), (b) into 70-140 BPM ("no hint"); when the octave changes, the grid keeps the
phase with the highest downbeat activation. Bar phase: which of the 4 grid beats is beat 1, chosen by the mean downbeat
activation (sigmoid) at those grid beats over the clip.
Correct: tempo within 4% of the label and at least 80% of the labelled downbeats within the tolerance (70 ms, or a
quarter of the labelled beat) of a fitted bar line. Labels with 2 beats per bar (2/4): either alternating half of the
labelled downbeats may be met (a 4-beat bar fits two phases). Labels with 3 beats per bar, or compound metres, are left
out and counted. Failures: wrong tempo; right tempo but wrong phase; of those, phase off by exactly 2 beats.
"""
import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
import soundfile as sf

FPS = 50


def read_labels(path: Path):
    a = np.loadtxt(path, ndmin=2)
    if a.shape[1] == 1:
        return a[:, 0], None, None
    return a[:, 0], a[a[:, 1] == 1, 0], int(a[:, 1].max())


def select(wavs, which):
    if which is None:
        return wavs
    return [w for w in wavs if (int(w.stem.rsplit("_", 1)[-1]) % 2 == 0) == (which == "even")]


def fit_grid(beats):
    if len(beats) < 3:
        return None
    p0 = float(np.median(np.diff(beats)))
    idx = np.round((beats - beats[0]) / p0)
    (period, phase), *_ = np.linalg.lstsq(np.vstack([idx, np.ones_like(idx)]).T, beats, rcond=None)
    return (float(period), float(phase)) if period > 0 else None


def act_at(act: np.ndarray, t: np.ndarray) -> np.ndarray:
    """Downbeat activation at times t: the maximum within +-1 frame."""
    f = np.round(t * FPS).astype(int)
    out = np.zeros(len(t))
    for d in (-1, 0, 1):
        g = np.clip(f + d, 0, len(act) - 1)
        out = np.maximum(out, act[g])
    out[(f < 0) | (f >= len(act))] = 0
    return out


def phrase_cues(wav: Path) -> tuple[np.ndarray, np.ndarray]:
    """Onset times and how long the sound continues after each (to the next onset), from the audio alone: used by
    the bar-phase rule (phrase starts and long notes tend to fall on beat 1)."""
    import librosa
    y, sr = sf.read(wav, dtype="float32")
    if y.ndim == 2:
        y = y.mean(1)
    on = librosa.onset.onset_detect(y=y, sr=sr, hop_length=220, units="time", backtrack=False)
    rms = librosa.feature.rms(y=y, hop_length=220)[0]
    t = np.arange(len(rms)) * 220 / sr
    quiet = rms < 0.1 * (rms.max() + 1e-9)
    starts, longs = [], []
    nxt = np.append(on[1:], len(y) / sr)
    for i, o in enumerate(on):
        before = (t > o - 0.35) & (t < o - 0.05)
        if before.any() and quiet[before].mean() > 0.8:
            starts.append(o)
        longs.append(nxt[i] - o)
    return np.array(starts), np.c_[on, np.array(longs)] if len(on) else np.zeros((0, 2))


def evaluate(beats, db_act, truth_bpm, td, bpb_label, beat_act=None, phase_rule="downbeat", cues=None, weight=1.0):
    res = {}
    g = fit_grid(np.asarray(beats))
    dur = len(db_act) / FPS
    for mode in ("meant", "nohint"):
        res[f"{mode}_tempo"] = False
        for tol in ("70ms", "quarter"):
            res[f"{mode}_{tol}"] = False
            res[f"{mode}_{tol}_half_bar"] = False
        if g is None:
            continue
        period, phase = g
        bpm = 60 / period
        if mode == "meant":
            m = min((0.25, 0.5, 1, 2, 4), key=lambda f: abs(np.log(bpm * f / truth_bpm)))
        else:
            m = 1.0
            while bpm * m >= 140:
                m /= 2
            while bpm * m < 70:
                m *= 2
        per = period / m
        ok_tempo = abs(60 / per - truth_bpm) <= 0.04 * truth_bpm
        res[f"{mode}_tempo"] = bool(ok_tempo)
        # grid beats over the whole clip; when the grid got sparser, keep the phase with most downbeat activation
        k = int(round(per / period)) if per > period * 1.01 else 1
        cands = []
        for j in range(k):
            ph = phase + j * period
            n0, n1 = int(np.floor((0 - ph) / per)), int(np.ceil((dur - ph) / per))
            gb = ph + np.arange(n0, n1 + 1) * per
            gb = gb[(gb >= 0) & (gb < dur)]
            cands.append((act_at(db_act, gb).sum(), gb))
        gb = max(cands, key=lambda c: c[0])[1]
        if len(gb) < 4:
            continue
        a = act_at(db_act, gb)
        score = np.array([a[i::4].mean() for i in range(4)])
        if phase_rule == "downbeat+onset" and beat_act is not None:
            score = score + 0.5 * np.array([act_at(beat_act, gb)[i::4].mean() for i in range(4)])
        if phase_rule == "downbeat+phrase":
            # phrase starts (onset after near-silence) and long-note onsets (>= 1.5 beats to the next onset):
            # share of them landing within a quarter beat of each candidate bar line, added with a weight
            starts, ons = cues
            longs = ons[ons[:, 1] >= 1.5 * per, 0] if len(ons) else np.array([])
            ev = np.concatenate([starts, longs])
            if len(ev):
                extra = []
                for i in range(4):
                    bars = gb[i::4]
                    extra.append(np.mean(np.min(np.abs(ev[:, None] - bars[None, :]), axis=1) <= per / 4))
                score = score / (score.max() + 1e-9) + weight * np.array(extra)
        best = int(score.argmax())
        if not ok_tempo or td is None or len(td) == 0:
            continue
        truth_beat = 60 / truth_bpm
        label_sets = [td] if bpb_label == 4 else [td[0::2], td[1::2]]
        for tol, sec in (("70ms", 0.07), ("quarter", truth_beat / 4)):
            def hit(off):
                bars = gb[off::4]
                return any(len(ls) and np.mean(np.min(np.abs(ls[:, None] - bars[None, :]), axis=1) <= sec) >= 0.8 for ls in label_sets)
            res[f"{mode}_{tol}"] = bool(hit(best))
            res[f"{mode}_{tol}_half_bar"] = bool(not hit(best) and hit((best + 2) % 4))
    return res


def run_models(args):
    import torch
    from beat_this.inference import Audio2Frames
    from beat_this.model.postprocessor import Postprocessor
    pps = {"": Postprocessor("minimal", fps=FPS), "+dbn": Postprocessor("dbn", fps=FPS)}
    for ckpt, name in zip(args.models, args.names):
        fr = Audio2Frames(checkpoint_path=ckpt, device="cuda")
        for spec in args.sets:
            sname, folder = spec.split("=", 1)
            which = None
            if "@" in folder:
                folder, which = folder.rsplit("@", 1)
            d = args.out / "act" / name / sname
            d.mkdir(parents=True, exist_ok=True)
            for w in select(sorted(Path(folder).glob("*.wav")), which):
                y, sr = sf.read(w, dtype="float32")
                if y.ndim == 2:
                    y = y.mean(1)
                bl, dl = fr(y, sr)
                out = {"beat_act": torch.sigmoid(bl).float().cpu().numpy(), "db_act": torch.sigmoid(dl).float().cpu().numpy(),
                       "labels": str(w.with_suffix(".beats")), "meta": str(w.with_suffix(".json"))}
                for suf, pp in pps.items():
                    b, _ = pp(bl, dl)
                    out[f"beats{suf}"] = np.asarray(b)
                np.savez_compressed(d / f"{w.stem}.npz", **out)
            print(f"{name} {sname} done", flush=True)


def score(args):
    rows, excluded = [], {}
    cue_cache = {}
    for f in sorted((args.out_act).glob("*/*/*.npz")):
        name, sname = f.parent.parent.name, f.parent.name
        if args.only_sets and sname not in args.only_sets.split(","):
            continue
        z = np.load(f, allow_pickle=True)
        tb, td, bpb = read_labels(Path(str(z["labels"])))
        meta_p = Path(str(z["meta"]))
        meta = json.loads(meta_p.read_text()) if meta_p.exists() else {}
        compound = meta.get("meter") == "6/8"
        if bpb not in (2, 4) or compound:
            excluded.setdefault(sname, set()).add(f.stem)
            continue
        truth_bpm = 60 / float(np.median(np.diff(tb)))
        cues = None
        if args.phase_rule == "downbeat+phrase":
            wav = Path(str(z["labels"])).with_suffix(".wav")
            if wav not in cue_cache:
                cue_cache[wav] = phrase_cues(wav)
            cues = cue_cache[wav]
        for suf in ("", "+dbn"):
            r = evaluate(z[f"beats{suf}"], z["db_act"], truth_bpm, td, bpb, z["beat_act"], args.phase_rule, cues, args.weight)
            rows.append({"model": name + suf, "set": sname, "clip": f.stem, "label_beats_per_bar": bpb, **r})
    df = pd.DataFrame(rows)
    args.report.mkdir(parents=True, exist_ok=True)
    df.to_csv(args.report / "grid4_per_clip.csv", index=False)
    lines = [f"# Grid correct with 4-beat bars (bar phase rule: {args.phase_rule}, weight {args.weight})\n"]
    for s, ex in excluded.items():
        lines.append(f"- {s}: {len(ex)} clips left out (3 beats per bar, compound metre or no beat numbers)")
    for s in sorted(df["set"].unique()):
        d = df[df["set"] == s]
        for bpb in sorted(d["label_beats_per_bar"].unique()):
            e = d[d["label_beats_per_bar"] == bpb]
            lines.append(f"\n## {s}, labelled {bpb} beats per bar ({e['clip'].nunique()} clips)\n")
            lines.append("| model | correct, meant tempo, 70 ms | meant, 1/4 beat | no hint, 70 ms | no hint, 1/4 beat | wrong tempo (meant) | right tempo, wrong phase (meant, 70 ms) | of which off by 2 beats |")
            lines.append("|---|---|---|---|---|---|---|---|")
            for m in sorted(e["model"].unique()):
                x = e[e["model"] == m]
                wrong_tempo = 1 - x.meant_tempo.mean()
                wrong_phase = (x.meant_tempo & ~x.meant_70ms).mean()
                half = x.meant_70ms_half_bar.mean()
                lines.append(f"| {m} | {x.meant_70ms.mean():.0%} | {x.meant_quarter.mean():.0%} | {x.nohint_70ms.mean():.0%} | {x.nohint_quarter.mean():.0%} | "
                             f"{wrong_tempo:.0%} | {wrong_phase:.0%} | {half:.0%} |")
    (args.report / "grid4.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", nargs="*", default=[])
    ap.add_argument("--names", nargs="*", default=[])
    ap.add_argument("--sets", nargs="*", default=[])
    ap.add_argument("--out", type=Path, required=True, help="folder for activations (and the report unless --report)")
    ap.add_argument("--report", type=Path)
    ap.add_argument("--phase-rule", choices=["downbeat", "downbeat+onset", "downbeat+phrase"], default="downbeat")
    ap.add_argument("--weight", type=float, default=1.0, help="weight of the phrase cues in downbeat+phrase")
    ap.add_argument("--only-sets", default=None, help="comma list of sets to score")
    ap.add_argument("--score-only", action="store_true")
    args = ap.parse_args()
    args.out_act = args.out / "act"
    args.report = args.report or args.out
    if not args.score_only:
        run_models(args)
    score(args)


if __name__ == "__main__":
    main()
