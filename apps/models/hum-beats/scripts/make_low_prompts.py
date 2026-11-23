"""Lower SoulX-Singer's high prompt voices into the male range: pitch AND formants down by n semitones (resample to a
lower speed, then time-stretch back to the original length, so the prompt's note durations stay valid), with the
prompt's note pitches and f0 shifted to match.

  python scripts/make_low_prompts.py --out /mnt/d/casperaki-data/hum-beats/soulx-prompts-low
Writes <out>/<name>_m<n>.wav and .json (same format as the repo's example prompts).
"""
import argparse
import json
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf

EX = Path(__file__).resolve().parents[2] / "services/soulx-singer/repo/example/audio"
SHIFTS = {"en_prompt": 9, "zh_prompt": 10, "en_target": 9}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    for name, n in SHIFTS.items():
        y, sr = librosa.load(EX / f"{name}.mp3", sr=24000, mono=True)
        k = 2 ** (n / 12)
        slow = librosa.resample(y, orig_sr=sr, target_sr=int(round(sr * k)))  # played at sr: n semitones lower, longer
        low = librosa.effects.time_stretch(slow, rate=len(slow) / len(y))  # back to the original length
        low = low[: len(y)] if len(low) >= len(y) else np.pad(low, (0, len(y) - len(low)))
        meta = json.loads((EX / f"{name}.json").read_text(encoding="utf-8"))
        for seg in meta:
            seg["note_pitch"] = " ".join(str(int(p) - n if int(p) > 0 else 0) for p in seg["note_pitch"].split())
            seg["f0"] = " ".join(f"{float(f) / k:.1f}" if float(f) > 0 else "0.0" for f in seg["f0"].split())
        out = f"{name}_m{n}"
        sf.write(args.out / f"{out}.wav", low / (np.max(np.abs(low)) + 1e-9) * 0.9, sr)
        (args.out / f"{out}.json").write_text(json.dumps(meta, ensure_ascii=False))
        print(out)


if __name__ == "__main__":
    main()
