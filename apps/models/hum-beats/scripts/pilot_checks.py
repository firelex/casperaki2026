"""Inspect a generated set: label alignment, MIDI, pitch curves, parameter distributions and shortcut tests.

  python scripts/pilot_checks.py --data <dir> [--plots <dir>]

Prints a plain report (also used for SPEC/REPORT). Every check reads the files as written.
"""
import argparse
import collections
import json
from pathlib import Path

import numpy as np
import soundfile as sf


def load(data: Path):
    metas = []
    for split_dir in sorted(p for p in data.iterdir() if p.is_dir() and p.name in ("train", "dev", "test", "test-unseen")):
        for j in sorted(split_dir.glob("*.json")):
            m = json.loads(j.read_text())
            m["_dir"] = split_dir
            metas.append(m)
    return metas


def pct(c: collections.Counter, total: int) -> str:
    return ", ".join(f"{k}: {v / total:.0%}" for k, v in sorted(c.items(), key=lambda kv: -kv[1]))


def distributions(metas):
    n = len(metas)
    print(f"\n== Parameter distributions ({n} clips)")
    for key, fn in [
        ("split", lambda m: m["split"]), ("meter", lambda m: m["meter"]), ("bars", lambda m: m["n_bars"]),
        ("style", lambda m: m["style"]), ("timing", lambda m: m["timing"]), ("start", lambda m: m["start_mode"]),
        ("lead kind", lambda m: m["lead"]["group"]), ("timbre", lambda m: m["lead"]["timbre"]),
        ("voice type", lambda m: m["lead"].get("voice_type", "-")), ("pollution", lambda m: m["pollution"]["level"]),
        ("source", lambda m: m["score"]["source"]), ("pause", lambda m: (m["score"].get("pause") or {}).get("kind", "none")),
    ]:
        c = collections.Counter(fn(m) for m in metas)
        if key == "timbre" and len(c) > 12:
            c = collections.Counter(dict(c.most_common(12)))
            print(f"  {key} (top 12 of {len(set(fn(m) for m in metas))}): {pct(c, n)}")
        else:
            print(f"  {key}: {pct(c, n)}")
    voice = sum(m["lead"]["group"] in ("voice", "vocal_sample") for m in metas) / n
    print(f"  hum-like voice lead (synth voice + vocal sample): {voice:.0%}")
    bpm = np.array([m["bpm"] for m in metas])
    hist, edges = np.histogram(bpm, bins=7, range=(60, 200))
    print("  tempo (nominal BPM) per 20-BPM band:", " ".join(f"{int(a)}-{int(b)}:{h}" for a, b, h in zip(edges[:-1], edges[1:], hist)))
    real = np.array([60 / np.median(np.diff([b["time"] for b in m["beats"]])) for m in metas])
    print(f"  tempo actually labelled (median beat interval): 5/50/95% = {np.percentile(real, [5, 50, 95]).round(1)}")
    dur = np.array([m["duration_s"] for m in metas])
    print(f"  clip length s: 5/50/95/max = {np.percentile(dur, [5, 50, 95]).round(1)} / {dur.max():.1f}")
    nb = np.array([len(m["beats"]) for m in metas])
    print(f"  labelled beats per clip: 5/50/95 = {np.percentile(nb, [5, 50, 95])}")


def shortcut_tests(metas):
    n = len(metas)
    print("\n== Shortcut tests")
    first_db = sum(m["beats"][0]["beat_in_bar"] == 1 for m in metas) / n
    print(f"  first labelled beat is a downbeat: {first_db:.0%}")
    first_note_b1 = 0
    first_note_on_beat = 0
    for m in metas:
        nt = m["notes"][0]
        bib = nt["beat_in_bar"]
        first_note_b1 += abs(bib - 1) < 1e-3
        first_note_on_beat += abs(bib - round(bib)) < 1e-3
    print(f"  first note exactly on beat 1 of a bar: {first_note_b1 / n:.0%} (on any beat: {first_note_on_beat / n:.0%})")
    lead = np.array([m["beats"][0]["time"] for m in metas])
    print(f"  time from clip start to first labelled beat s: 5/50/95 = {np.percentile(lead, [5, 50, 95]).round(2)}")
    print("  drums present: 0% (every clip is one melody line, no drums, no accompaniment)")
    # loudness accents: performed velocity of notes on downbeats vs other on-beat notes vs off-beat notes
    vd, vb, vo = [], [], []
    for m in metas:
        for nt in m["notes"]:
            if nt["swallowed"] == "missing":
                continue
            bib = nt["beat_in_bar"]
            (vd if abs(bib - 1) < 1e-3 else vb if abs(bib - round(bib)) < 1e-3 else vo).append(nt["velocity"])
    print(f"  mean note velocity: on downbeats {np.mean(vd):.3f}, on other beats {np.mean(vb):.3f}, off the beat {np.mean(vo):.3f}")
    # the audio itself: onset strength at downbeats vs other beats, and silence before downbeats
    import librosa
    ratios, sil_db, sil_b = [], [], []
    for m in metas[: min(400, n)]:
        y, sr = sf.read(m["_dir"] / f"{m['clip_id']}.wav")
        env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=220)
        fr = lambda t: min(len(env) - 1, int(round(t * sr / 220)))  # noqa: E731
        d = [env[max(0, fr(b["time"]) - 2): fr(b["time"]) + 3].max() for b in m["beats"] if b["beat_in_bar"] == 1]
        o = [env[max(0, fr(b["time"]) - 2): fr(b["time"]) + 3].max() for b in m["beats"] if b["beat_in_bar"] != 1]
        if d and o:
            ratios.append(np.mean(d) / (np.mean(o) + 1e-9))
        rms = librosa.feature.rms(y=y, hop_length=220)[0]
        for b in m["beats"]:
            f = fr(b["time"])
            pre = rms[max(0, f - 20): max(1, f - 2)].mean()  # ~0.2 s before the beat
            (sil_db if b["beat_in_bar"] == 1 else sil_b).append(pre < 0.1 * rms.max())
    print(f"  audio onset strength at downbeats / at other beats (mean over clips): {np.mean(ratios):.2f} (median {np.median(ratios):.2f})")
    print(f"  beats preceded by near-silence: downbeats {np.mean(sil_db):.0%}, other beats {np.mean(sil_b):.0%}")
    bpm = np.array([m["bpm"] for m in metas])
    from scipy.stats import kstest
    print(f"  tempo vs uniform(60,200): KS statistic {kstest((bpm - 60) / 140, 'uniform').statistic:.3f}")


def label_alignment(metas, k=50):
    print("\n== Label alignment (perfect-timing clips)")
    import librosa
    perf = [m for m in metas if m["timing"] == "perfect"][:k]
    worst_label = 0.0
    audio_err = []
    group_err = collections.defaultdict(list)
    for m in perf:
        beats = {round(b["q"], 6): b["time"] for b in m["beats"]}
        for nt in m["notes"]:
            if round(nt["q_on"], 6) in beats:
                worst_label = max(worst_label, abs(nt["onset"] - beats[round(nt["q_on"], 6)]))
                if nt["performed_onset"] is not None:
                    worst_label = max(worst_label, abs(nt["performed_onset"] - beats[round(nt["q_on"], 6)]))
        if m["pollution"]["level"] in ("none", "light"):
            y, sr = sf.read(m["_dir"] / f"{m['clip_id']}.wav")
            on = librosa.onset.onset_detect(y=y, sr=sr, hop_length=110, units="time", backtrack=False)
            prev_t = -1.0
            for nt in m["notes"]:
                gap_ok = nt["onset"] - prev_t >= 0.2  # the onset detector merges notes closer than ~0.2 s
                prev_t = nt["onset"]
                if not gap_ok or nt["swallowed"] or nt["performed_onset"] is None or round(nt["q_on"], 6) not in beats:
                    continue
                t = beats[round(nt["q_on"], 6)]
                if len(on):
                    audio_err.append(on[np.argmin(np.abs(on - t))] - t)
                    group_err[m["lead"]["group"]].append(audio_err[-1])
    audio_err = np.array(audio_err)
    print(f"  {len(perf)} clips: largest gap between an on-beat note onset (nominal and performed) and its beat label: {worst_label * 1000:.2f} ms")
    if len(audio_err):
        within = np.mean(np.abs(audio_err) < 0.03)
        print(f"  audio onset detector vs beat label for on-beat notes at least 0.2 s after the previous note (clean/light clips, {len(audio_err)} notes): "
              f"median {np.median(audio_err) * 1000:.1f} ms, |err|<30 ms for {within:.0%}, <70 ms for {np.mean(np.abs(audio_err) < 0.07):.0%}")
        for g, e in sorted(group_err.items()):
            e = np.array(e)
            print(f"    {g}: {len(e)} notes, median {np.median(e) * 1000:.1f} ms, |err|<70 ms {np.mean(np.abs(e) < 0.07):.0%}")


def midi_check(metas, k=50):
    import pretty_midi
    worst = 0.0
    worst_beat = 0.0
    for m in metas[:k]:
        pm = pretty_midi.PrettyMIDI(str(m["_dir"] / f"{m['clip_id']}.mid"))
        starts = sorted(n.start for n in pm.instruments[0].notes)
        nom = sorted(nt["onset"] for nt in m["notes"])
        if len(starts) != len(nom):
            raise ValueError(f"{m['clip_id']}: MIDI has {len(starts)} notes, JSON {len(nom)}")
        worst = max(worst, max(abs(a - b) for a, b in zip(starts, nom)))
        bt = pm.get_downbeats()
        lab = np.array([b["time"] for b in m["beats"] if b["beat_in_bar"] == 1])
        for t in lab:
            worst_beat = max(worst_beat, np.min(np.abs(bt - t)))
    print(f"\n== MIDI: {min(k, len(metas))} files read back; largest note-start difference to the JSON nominal onset: {worst * 1000:.2f} ms; "
          f"largest distance of a labelled downbeat to a MIDI bar line: {worst_beat * 1000:.2f} ms")


def pitch_check(metas, k=24):
    """pYIN on the audio vs the stored performed pitch curve, where both are voiced."""
    import librosa
    print("\n== Performed pitch curve vs the audio (pYIN), clean clips")
    by = collections.defaultdict(list)
    chosen = [m for m in metas if m["pollution"]["level"] in ("none", "light")]
    seen = collections.Counter()
    for m in chosen:
        g = m["lead"]["group"]
        if seen[g] >= max(3, k // 6):
            continue
        seen[g] += 1
        y, sr = sf.read(m["_dir"] / f"{m['clip_id']}.wav")
        f0, vflag, _ = librosa.pyin(y, fmin=30, fmax=2000, sr=sr, frame_length=2048, hop_length=220)
        t = librosa.times_like(f0, sr=sr, hop_length=220)
        p = np.load(m["_dir"] / f"{m['clip_id']}.pitch.npz")
        stored = np.interp(t, p["time_s"], p["cents"], left=np.nan, right=np.nan)
        ok = vflag & np.isfinite(stored) & np.isfinite(f0)
        if ok.sum() < 20:
            continue
        measured = 1200 * np.log2(f0[ok] / 440) + 6900
        d = measured - stored[ok]
        octave = np.mean(np.abs(d) > 600)
        d = d[np.abs(d) <= 600]
        by[g].append((np.median(np.abs(d)), np.mean(np.abs(d) < 50), octave, m["clip_id"]))
    for g, rows in sorted(by.items()):
        med = np.median([r[0] for r in rows])
        w50 = np.mean([r[1] for r in rows])
        octv = np.mean([r[2] for r in rows])
        print(f"  {g}: {len(rows)} clips, median |pYIN - stored| {med:.1f} cents, frames within 50 cents {w50:.0%}, octave-off frames {octv:.0%}")


def plots(metas, out: Path, k=8):
    import librosa
    import librosa.display  # noqa: F401
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    out.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(0)
    for m in [metas[i] for i in rng.choice(len(metas), size=min(k, len(metas)), replace=False)]:
        y, sr = sf.read(m["_dir"] / f"{m['clip_id']}.wav")
        S = librosa.amplitude_to_db(np.abs(librosa.stft(y, n_fft=1024, hop_length=220)), ref=np.max)
        p = np.load(m["_dir"] / f"{m['clip_id']}.pitch.npz")
        fig, ax = plt.subplots(2, 1, figsize=(14, 6), sharex=True)
        ax[0].imshow(S, origin="lower", aspect="auto", extent=[0, len(y) / sr, 0, sr / 2], vmin=-80, cmap="magma")
        ax[0].set_ylim(0, 4000)
        f = 440 * 2 ** ((p["cents"] - 6900) / 1200)
        ax[0].plot(p["time_s"], f, color="cyan", lw=0.8)
        for b in m["beats"]:
            for a in ax:
                a.axvline(b["time"], color="lime" if b["beat_in_bar"] == 1 else "white", lw=1.5 if b["beat_in_bar"] == 1 else 0.6, alpha=0.8)
        ax[1].plot(np.arange(len(y)) / sr, y, lw=0.3)
        for nt in m["notes"]:
            if nt["performed_onset"] is not None:
                ax[1].axvline(nt["performed_onset"], color="red", lw=0.5, ymax=0.3)
        ax[1].set_facecolor("black")
        ax[0].set_title(f"{m['clip_id']} {m['meter']} {m['n_bars']} bars {m['bpm']:.0f} BPM {m['style']} {m['timing']} {m['start_mode']} "
                        f"{m['lead']['timbre']} {m['lead'].get('voice_type', '')} pollution={m['pollution']['level']}")
        fig.tight_layout()
        fig.savefig(out / f"{m['clip_id']}.png", dpi=80)
        plt.close(fig)
    print(f"\nplots in {out}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument("--plots", type=Path)
    ap.add_argument("--skip-audio", action="store_true", help="only the label-based checks (fast, for the full set)")
    args = ap.parse_args()
    metas = load(args.data)
    distributions(metas)
    # families never cross splits
    fam = collections.defaultdict(set)
    for m in metas:
        fam[m["family"]].add(m["split"])
    crossing = [f for f, s in fam.items() if len(s) > 1]
    print(f"\n== Splits: {len(fam)} families, {len(crossing)} appear in more than one split")
    unseen_t = {m["lead"]["timbre"] for m in metas if m["split"] == "test-unseen"}
    train_t = {m["lead"]["timbre"] for m in metas if m["split"] != "test-unseen"}
    print(f"   test-unseen lead timbres also used outside test-unseen: {sorted(unseen_t & train_t) or 'none'}")
    if args.skip_audio:
        shortcut_tests_labels_only(metas)
        return
    shortcut_tests(metas)
    label_alignment(metas)
    midi_check(metas)
    pitch_check(metas)
    if args.plots:
        plots(metas, args.plots)


def shortcut_tests_labels_only(metas):
    n = len(metas)
    print("\n== Shortcut tests (labels only)")
    print(f"  first labelled beat is a downbeat: {sum(m['beats'][0]['beat_in_bar'] == 1 for m in metas) / n:.0%}")
    print(f"  first note exactly on beat 1: {sum(abs(m['notes'][0]['beat_in_bar'] - 1) < 1e-3 for m in metas) / n:.0%}")
    vd = [nt["velocity"] for m in metas for nt in m["notes"] if abs(nt["beat_in_bar"] - 1) < 1e-3 and nt["swallowed"] != "missing"]
    vo = [nt["velocity"] for m in metas for nt in m["notes"] if abs(nt["beat_in_bar"] - 1) >= 1e-3 and nt["swallowed"] != "missing"]
    print(f"  mean velocity on downbeats {np.mean(vd):.3f} vs elsewhere {np.mean(vo):.3f}")
    from scipy.stats import kstest
    bpm = np.array([m["bpm"] for m in metas])
    print(f"  tempo vs uniform(60,200): KS statistic {kstest((bpm - 60) / 140, 'uniform').statistic:.3f}")


if __name__ == "__main__":
    main()
