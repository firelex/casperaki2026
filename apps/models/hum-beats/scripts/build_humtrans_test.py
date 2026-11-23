"""Build test-humtrans: real hums from HumTrans (official TEST split) with beat labels from their MIDI.

HumTrans (dadinghh2/HumTrans, CC BY-NC 4.0) is used for EVALUATION ONLY, never training.

What we found: each recording is exactly as long as its MIDI, and the MIDI is a quantised score at one constant
tempo with real time signatures (4/4, 2/4, 1/4 pickup + 4/4). The singers hummed along in time, with a
recording latency of about 0.2 s. So per recording we fit ONE constant time offset (the tempo is the MIDI's,
not fitted): the offset that puts the most MIDI note starts within 70 ms of an onset detected in the audio.
Recordings where fewer than --min-match of the notes line up after that are left out (counted in the report).

Beats and downbeats are the MIDI's own beat grid (pretty_midi, quarter-note beats; bar lines from the time
signatures), shifted by the offset, kept from the first note to the end of the last note.

  python -I scripts/build_humtrans_test.py --out /mnt/d/casperaki-data/hum-beats/test-humtrans --n 300
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

ROOT = Path("/mnt/d/casperaki-data/humtrans")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--n", type=int, default=300)
    ap.add_argument("--min-match", type=float, default=0.6)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--keys-file", type=Path, help="use exactly these recordings (one key per line) instead of sampling the TEST split")
    ap.add_argument("--wav-dir", type=Path, default=ROOT / "wav")
    ap.add_argument("--set-name", default="test-humtrans")
    args = ap.parse_args()
    import librosa
    import pretty_midi
    import soundfile as sf

    if args.keys_file:
        chosen = sorted(args.keys_file.read_text().split())
    else:
        keys = json.loads((ROOT / "download/train_valid_test_keys.json").read_text())["TEST"]
        rng = np.random.default_rng(args.seed)
        chosen = sorted(rng.choice(keys, size=args.n, replace=False).tolist())
    wav_dir = args.wav_dir
    missing = [k for k in chosen if not (wav_dir / f"{k}.wav").exists()]
    if missing:
        subprocess.run([sys.executable, "-I", str(Path(__file__).with_name("humtrans_fetch.py")), "--out", str(wav_dir), *missing], check=True)
    args.out.mkdir(parents=True, exist_ok=True)
    kept, dropped = [], []
    for k in chosen:
        pm = pretty_midi.PrettyMIDI(str(ROOT / "midi/midi_data" / f"{k}.mid"))
        notes = sorted(pm.instruments[0].notes, key=lambda n: n.start)
        starts = np.array([n.start for n in notes])
        y, sr = librosa.load(wav_dir / f"{k}.wav", sr=22050, mono=True)
        on = librosa.onset.onset_detect(y=y, sr=sr, hop_length=220, units="time", backtrack=True)
        if len(on) == 0:
            dropped.append({"key": k, "reason": "no onsets detected"})
            continue
        offsets = np.arange(-0.5, 1.5, 0.005)
        scores = [np.mean(np.abs((starts + o)[:, None] - on[None]).min(1) < 0.07) for o in offsets]
        best = int(np.argmax(scores))
        offset, match = float(offsets[best]), float(scores[best])
        if match < args.min_match:
            dropped.append({"key": k, "reason": f"only {match:.0%} of MIDI notes line up with audio onsets"})
            continue
        beats = pm.get_beats() + offset
        downbeats = pm.get_downbeats() + offset
        end = max(n.end for n in notes) + offset
        lo = starts[0] + offset - 0.035
        keep = (beats >= max(lo, 0)) & (beats <= min(end, len(y) / sr))
        beats = beats[keep]
        is_down = np.array([np.min(np.abs(downbeats - b)) < 1e-6 for b in beats])
        if len(beats) < 3:
            dropped.append({"key": k, "reason": "fewer than 3 beats"})
            continue
        # beat number within the bar (1 = downbeat), counting from each downbeat
        nums, c = [], 0
        for d in is_down:
            c = 1 if d else c + 1
            nums.append(c)
        if not is_down[0]:
            # beats before the first labelled downbeat: count back from the bar length
            first_d = int(np.argmax(is_down)) if is_down.any() else len(nums)
            bpb = pm.time_signature_changes[-1].numerator
            for i in range(first_d):
                nums[i] = bpb - (first_d - i) + 1
        sf.write(args.out / f"{k}.wav", y, sr, subtype="PCM_16")
        with open(args.out / f"{k}.beats", "w") as f:
            f.writelines(f"{b:.5f}\t{n}\n" for b, n in zip(beats, nums))
        tempo = float(pm.get_tempo_changes()[1][0])
        meta = {"clip_id": k, "split": args.set_name, "source": "HumTrans (CC BY-NC 4.0, evaluation only)", "offset_s": offset,
                "onset_match": match, "bpm": tempo, "time_signatures": [(t.numerator, t.denominator) for t in pm.time_signature_changes],
                "singer": k.split("_")[0], "piece": k.split("_")[1],
                "notes": [{"midi": n.pitch, "onset": n.start + offset, "offset": n.end + offset} for n in notes]}
        (args.out / f"{k}.json").write_text(json.dumps(meta))
        kept.append({"key": k, "offset": offset, "match": match})
    summary = {"chosen": len(chosen), "kept": len(kept), "dropped": dropped,
               "offset_s_percentiles_5_50_95": np.percentile([x["offset"] for x in kept], [5, 50, 95]).round(3).tolist(),
               "match_percentiles_5_50_95": np.percentile([x["match"] for x in kept], [5, 50, 95]).round(3).tolist()}
    (args.out / "summary.json").write_text(json.dumps(summary, indent=1))
    print(json.dumps({k: v for k, v in summary.items() if k != "dropped"}, indent=1), f"dropped {len(dropped)}")


if __name__ == "__main__":
    main()
