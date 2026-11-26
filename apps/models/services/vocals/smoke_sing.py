"""GPU smoke run of the sing stage on a real song, outside the running service (models load here, on this GPU).

Usage (the service's venv): .venv/bin/python smoke_sing.py <brain song.json> <out_dir>
Builds the stage's params as the brain does (every section with Vocal notes sung from the lane's notes; each backing
lane's notes moved by the whole octaves that put their median nearest the lead's, inside F3..A5, a tie to the lower;
backings 9 dB under), runs pipeline.sing, then checks:
- each lead take's pitch per lane note (librosa.pyin median over the note's middle) against the lane note: the share
  within 0.5 semitone (an octave off counts as off);
- a backing take exists for every section where a backing lane has notes, and its loudness is 9 dB under its lead.
"""
from __future__ import annotations

import json
import statistics
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf

SERVICE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SERVICE_DIR))
from pipeline import levels, paths, sing  # noqa: E402

sys.path.append(str(paths.SOULX_REPO))

BACKINGS = ("Backing vocals 1", "Backing vocals 2")
LO, HI = 53, 81


class PrintingJob:
    def check_cancelled(self):
        pass

    def step(self, step_id, label):
        t0 = time.time()
        print(f"[step] {step_id}: {label}", flush=True)

        class Step:
            def done(self, text="", numbers=None, files=None):
                print(f"[done] {step_id} ({time.time() - t0:.1f} s): {text} {numbers or ''}", flush=True)

            def fail(self, text):
                print(f"[fail] {step_id}: {text}", flush=True)

        return Step()


def lane(song, segment, track, sung: bool):
    out = []
    for bi, bar in enumerate(song["arrangement"][segment]["overrides"].get(track, {}).get("bars", [])):
        for pos, evs in bar.get("notes", {}).items():
            for e in evs:
                if e.get("type") != "vocalNote":
                    continue
                n = {"start": bi * 4 + float(pos), "duration": e["duration"], "midi": e["note"]}
                if sung:
                    n.update(word=e["fullWord"], phonemes=list(e["vocaloidPhonemes"]))
                out.append(n)
    return sorted(out, key=lambda n: n["start"])


def backing_shift(line, lead):
    lo, hi = min(line), max(line)
    best = None
    for d in (-24, -12, 0, 12, 24):
        if lo + d < LO or hi + d > HI:
            continue
        if best is None or abs(statistics.median(line) + d - statistics.median(lead)) < abs(
                statistics.median(line) + best - statistics.median(lead)):
            best = d
    if best is None:
        raise ValueError(f"no octave puts {lo}..{hi} inside {LO}..{HI}")
    return best


def params_of(song):
    sections, backings = [], []
    for s in song["songStructure"]:
        notes = lane(song, s["name"], "Vocal", sung=True)
        if not notes:
            continue
        sections.append({"segment": s["name"], "section_bars": len(s["bars"]), "notes": notes})
        for track in BACKINGS:
            line = lane(song, s["name"], track, sung=False)
            if not line:
                continue
            d = backing_shift([n["midi"] for n in line], [n["midi"] for n in notes])
            backings.append({"track": track, "segment": s["name"], "notes": [{**n, "midi": n["midi"] + d} for n in line]})
    return {"stage": "sing", "bpm": song["bpm"], "backing_db": -9, "sections": sections, "backings": backings,
            "voice": {"audio": str(paths.VOICE_AUDIO), "meta": str(paths.VOICE_META)}}  # Singer 1


def pitch_check(take: Path, notes, bpm):
    import librosa

    y, sr = sf.read(take, always_2d=True)
    y = librosa.resample(np.ascontiguousarray(y[:, 0]), orig_sr=sr, target_sr=22050)
    f0, voiced, _ = librosa.pyin(y, fmin=librosa.note_to_hz("C3"), fmax=librosa.note_to_hz("C6"), sr=22050,
                                 frame_length=2048, hop_length=256)
    t = librosa.times_like(f0, sr=22050, hop_length=256)
    beat_s = 60.0 / bpm
    errs = []
    for n in notes:
        a, b = n["start"] * beat_s, (n["start"] + n["duration"]) * beat_s
        a, b = a + 0.25 * (b - a), b - 0.25 * (b - a)  # the middle half: no glides in or out
        m = (t >= a) & (t < b) & voiced & np.isfinite(f0)
        if not m.any():
            errs.append(None)
            continue
        errs.append(float(librosa.hz_to_midi(np.median(f0[m])) - n["midi"]))
    return errs


def main(song_path, out_dir):
    song = json.loads(Path(song_path).read_text())
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    params = params_of(song)
    (out / "params.json").write_text(json.dumps(params, indent=1))
    t0 = time.time()
    sing.run(params, out, PrintingJob())
    print(f"[smoke] stage ran in {time.time() - t0:.0f} s", flush=True)
    takes = json.loads((out / "sing.json").read_text())["takes"]
    by = {(t["segment"], t["track"]): t for t in takes}

    total = within = unvoiced = 0
    for s in params["sections"]:
        errs = pitch_check(out / by[(s["segment"], "Vocal")]["file"], s["notes"], params["bpm"])
        ok = sum(1 for e in errs if e is not None and abs(e) <= 0.5)
        nv = sum(1 for e in errs if e is None)
        total += len(errs)
        within += ok
        unvoiced += nv
        med = statistics.median(abs(e) for e in errs if e is not None)
        print(f"[pitch] {s['segment']}: {ok}/{len(errs)} notes within 0.5 st ({nv} unvoiced), median |error| {med:.2f} st")
    print(f"[pitch] all leads: {within}/{total} = {100 * within / total:.1f}% within 0.5 semitone ({unvoiced} unvoiced)")

    for b in params["backings"]:
        t = by.get((b["segment"], b["track"]))
        if t is None:
            raise SystemExit(f"[backing] MISSING {b['track']} in {b['segment']}")
        x, _ = sf.read(out / t["file"], always_2d=True)
        lead, _ = sf.read(out / by[(b["segment"], "Vocal")]["file"], always_2d=True)
        print(f"[backing] {b['track']} in {b['segment']}: {t['durationSeconds']} s, "
              f"{20 * np.log10(levels.loud(x) / levels.loud(lead)):.2f} dB to the lead")
    print(f"[smoke] {len(takes)} takes; {len(params['backings'])} backing lines expected, all present")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    main(*sys.argv[1:])
