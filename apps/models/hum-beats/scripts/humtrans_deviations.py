"""Measure how real hums deviate from their score (HumTrans TRAIN split only; evaluation data is never used).

For every recording: fit the recording latency, track pitch (pYIN) and onsets, match each score note to its
real onset, and record per note the onset deviation (split into a slow per-clip drift and the remaining
jitter), the duration ratio, the pitch-deviation contour in cents (10 ms frames, relative to the score pitch
after removing the singer's octave), the loudness relative to the clip, and the note's context. Per clip:
latency, drift curve, tuning offset, pitch drift, spreads. HumTrans is CC BY-NC 4.0: these measurements
drive the generator's random deviations; no HumTrans audio or labels go into training data.

  python -I scripts/humtrans_deviations.py --wav-dir <dir> --keys <file> --out <deviations.npz-prefix>
"""
import argparse
import json
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

MIDI_DIR = Path("/mnt/d/casperaki-data/humtrans/midi/midi_data")
HOP = 220
SR = 22050


def analyse(args):
    key, wav_dir = args
    import librosa
    import pretty_midi

    pm = pretty_midi.PrettyMIDI(str(MIDI_DIR / f"{key}.mid"))
    notes = sorted(pm.instruments[0].notes, key=lambda n: n.start)
    tempo = float(pm.get_tempo_changes()[1][0])
    beat_s = 60.0 / tempo
    ts = pm.time_signature_changes[-1]
    y, _ = librosa.load(Path(wav_dir) / f"{key}.wav", sr=SR, mono=True)
    starts = np.array([n.start for n in notes])
    ends = np.array([n.end for n in notes])
    pitch = np.array([n.pitch for n in notes])
    on_e = librosa.onset.onset_detect(y=y, sr=SR, hop_length=HOP, units="time", backtrack=True)
    if len(on_e) == 0:
        return {"key": key, "rejected": "no onsets"}
    offs = np.arange(-0.5, 1.5, 0.005)
    sc = [np.mean(np.abs((starts + o)[:, None] - on_e[None]).min(1) < 0.07) for o in offs]
    lat0 = float(offs[int(np.argmax(sc))])
    if max(sc) < 0.6:
        return {"key": key, "rejected": f"only {max(sc):.0%} of notes line up"}
    f0, vflag, _ = librosa.pyin(y, fmin=60, fmax=1000, sr=SR, frame_length=2048, hop_length=HOP)
    t = librosa.times_like(f0, sr=SR, hop_length=HOP)
    cents = np.where(vflag & np.isfinite(f0), 1200 * np.log2(np.where(np.isfinite(f0), f0, 1) / 440) + 6900, np.nan)
    rms = librosa.feature.rms(y=y, frame_length=1024, hop_length=HOP)[0][: len(t)]
    # the singer's octave / key offset: median deviation over frames inside score notes
    devs = []
    for s, e, p in zip(starts + lat0, ends + lat0, pitch):
        m = (t >= s + 0.05) & (t < e - 0.03)
        devs.extend((cents[m] - 100 * p)[np.isfinite(cents[m])])
    if len(devs) < 50:
        return {"key": key, "rejected": "too little voiced pitch"}
    raw = float(np.median(devs))
    octave = round(raw / 1200) * 1200
    tuning = raw - octave
    # pitch-crossing onset candidates: frames where the smoothed pitch crosses the midpoint between notes
    sm = np.copy(cents)
    rows = []
    n = len(notes)
    for i in range(n):
        exp = starts[i] + lat0
        cands = list(on_e[np.abs(on_e - exp) < 0.2])
        if i > 0 and pitch[i] != pitch[i - 1]:
            mid = 50 * (pitch[i] + pitch[i - 1]) + octave + tuning
            w = np.flatnonzero((t > exp - 0.2) & (t < exp + 0.2))
            seg = sm[w]
            for k in range(1, len(w)):
                a, b = seg[k - 1], seg[k]
                if np.isfinite(a) and np.isfinite(b) and (a - mid) * (b - mid) <= 0:
                    cands.append(float(t[w[k]]))
        onset = float(min(cands, key=lambda c: abs(c - exp))) if cands else None
        rows.append({"i": i, "onset": onset})
    matched = [r for r in rows if r["onset"] is not None]
    if len(matched) < max(4, 0.5 * n):
        return {"key": key, "rejected": "too few matched notes"}
    dev_on = np.array([r["onset"] - (starts[r["i"]] + lat0) if r["onset"] is not None else np.nan for r in rows])
    lat = lat0 + float(np.nanmedian(dev_on))
    dev_on = dev_on - np.nanmedian(dev_on)
    # slow drift: running median of the deviation over the clip (window 5 matched notes)
    idx = np.flatnonzero(np.isfinite(dev_on))
    drift = np.full(n, np.nan)
    for j, ii in enumerate(idx):
        lo, hi = max(0, j - 2), min(len(idx), j + 3)
        drift[ii] = np.median(dev_on[idx[lo:hi]])
    drift = np.interp(np.arange(n), idx, drift[idx])
    rel_pos = (starts - starts[0]) / max(ends[-1] - starts[0], 1e-6)
    note_rows = []
    note_db = []
    for i in range(n):
        if not np.isfinite(dev_on[i]):
            note_rows.append(None)
            note_db.append(np.nan)
            continue
        on = starts[i] + lat + dev_on[i]
        nxt = (starts[i + 1] + lat + (dev_on[i + 1] if np.isfinite(dev_on[i + 1]) else 0)) if i + 1 < n else len(y) / SR
        fr = np.flatnonzero((t >= on) & (t < nxt))
        if len(fr) < 3:
            note_rows.append(None)
            note_db.append(np.nan)
            continue
        r = rms[fr]
        peak = r.max()
        quiet = np.flatnonzero((r < 0.25 * peak) | ~np.isfinite(cents[fr]))
        # end: first stretch of >= 5 quiet/unvoiced frames after the first 50 ms
        off = t[fr[-1]] + HOP / SR
        for k in quiet:
            if k > 5 and np.all(np.isin(np.arange(k, min(k + 5, len(fr))), quiet)):
                off = t[fr[k]]
                break
        ratio = (off - on) / max(ends[i] - starts[i], 1e-3)
        cfr = np.flatnonzero((t >= on) & (t < off))
        contour = cents[cfr] - (100 * pitch[i] + octave + tuning)
        mid = contour[len(contour) // 4: max(len(contour) // 4 + 1, 3 * len(contour) // 4)]
        err = float(np.nanmedian(mid)) if np.isfinite(mid).any() else np.nan
        db = 20 * np.log10(np.mean(r) + 1e-9)
        note_db.append(db)
        gap_before = starts[i] - ends[i - 1] if i > 0 else 9.0
        gap_after = starts[i + 1] - ends[i] if i + 1 < n else 9.0
        note_rows.append({
            "key": key, "singer": key.split("_")[0], "piece": key.split("_")[1], "i": i,
            "tempo": tempo, "beat_s": beat_s, "len_beats": (ends[i] - starts[i]) / beat_s, "len_s": ends[i] - starts[i],
            "leap": int(pitch[i] - pitch[i - 1]) if i > 0 else 0, "midi": int(pitch[i]),
            "phrase_pos": "start" if gap_before >= 0.75 * beat_s else ("end" if gap_after >= 0.75 * beat_s else "mid"),
            "beat_pos": float(((starts[i] - starts[0]) / beat_s) % 1.0),
            "rel_pos": float(rel_pos[i]),
            "dev_on": float(dev_on[i]), "drift": float(drift[i]), "jitter": float(dev_on[i] - drift[i]),
            "dur_ratio": float(ratio), "pitch_err": err,
            "start_dev": float(np.nanmean(contour[:3])) if np.isfinite(contour[:3]).any() else np.nan,
            "contour": [None if not np.isfinite(c) else round(float(c), 1) for c in contour],
        })
    med_db = np.nanmedian(note_db)
    for r, db in zip(note_rows, note_db):
        if r is not None:
            r["loud_db"] = float(db - med_db)
    kept = [r for r in note_rows if r is not None]
    errs = np.array([r["pitch_err"] for r in kept])
    times = np.array([starts[r["i"]] for r in kept])
    ok = np.isfinite(errs)
    pitch_slope = float(np.polyfit(times[ok], errs[ok], 1)[0]) if ok.sum() > 4 else 0.0
    clip = {
        "key": key, "singer": key.split("_")[0], "piece": key.split("_")[1], "tempo": tempo,
        "time_signature": [ts.numerator, ts.denominator], "n_notes": n, "matched": len(kept),
        "latency": lat, "tuning_cents": tuning, "pitch_drift_cents_per_s": pitch_slope,
        "jitter_sd": float(np.std([r["jitter"] for r in kept])), "drift_range": float(np.ptp(drift)),
        "drift_curve": [round(float(x), 4) for x in np.interp(np.linspace(0, 1, 21), rel_pos, drift)],
        "pitch_err_sd": float(np.nanstd(errs)), "loud_sd": float(np.nanstd([r["loud_db"] for r in kept])),
        "dur_ratio_median": float(np.median([r["dur_ratio"] for r in kept])),
    }
    return {"key": key, "clip": clip, "notes": kept}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wav-dir", type=Path, required=True)
    ap.add_argument("--keys", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--workers", type=int, default=16)
    args = ap.parse_args()
    keys = [k for k in args.keys.read_text().split() if (args.wav_dir / f"{k}.wav").exists()]
    clips, notes, rejected = [], [], []
    with ProcessPoolExecutor(args.workers) as pool:
        for res in pool.map(analyse, [(k, str(args.wav_dir)) for k in keys], chunksize=4):
            if "rejected" in res:
                rejected.append(res)
                continue
            clips.append(res["clip"])
            notes.extend(res["notes"])
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.with_suffix(".clips.json").write_text(json.dumps(clips))
    with open(args.out.with_suffix(".notes.jsonl"), "w") as f:
        f.writelines(json.dumps(r) + "\n" for r in notes)
    args.out.with_suffix(".rejected.json").write_text(json.dumps(rejected))
    print(f"{len(clips)} recordings, {len(notes)} notes, {len(rejected)} rejected")


if __name__ == "__main__":
    main()
