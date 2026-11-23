"""Build two evaluation sets from GTZAN (Beat This!'s held-out test set; evaluation only, never training):

  test-gtzan-mix     the full 30 s mixes with the published beat labels (CPJKU/beat_this_annotations),
                     to check the fine-tuned model keeps its skill on real music;
  test-gtzan-vocals  the vocal stem of each mix (Demucs htdemucs, two stems), kept only where real singing is
                     present: stem level within 20 dB of the mix and pYIN finds pitched voice in >= 35% of the
                     stem. Real singing with real beat labels.

  python -I scripts/build_gtzan_sets.py --gtzan /mnt/d/casperaki-data/gtzan --out /mnt/d/casperaki-data/hum-beats
"""
import argparse
import json
import shutil
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

SR = 22050


def _one(args):
    stem, gtzan, out = args
    import librosa
    import soundfile as sf
    gtzan, out = Path(gtzan), Path(out)
    genre, num = stem.split(".")
    name = f"gtzan_{genre}_{num}"
    beats = gtzan / "beat_this_annotations/gtzan/annotations/beats" / f"{name}.beats"
    if not beats.exists():
        return {"name": name, "skipped": "no beat annotation"}
    mix, _ = librosa.load(gtzan / "audio/genres" / genre / f"{stem}.wav", sr=SR, mono=True)
    voc, _ = librosa.load(gtzan / "demucs/htdemucs" / stem / "vocals.wav", sr=SR, mono=True)
    sf.write(out / "test-gtzan-mix" / f"{name}.wav", mix, SR, subtype="PCM_16")
    shutil.copyfile(beats, out / "test-gtzan-mix" / f"{name}.beats")
    level = 20 * np.log10((np.sqrt(np.mean(voc ** 2)) + 1e-9) / (np.sqrt(np.mean(mix ** 2)) + 1e-9))
    f0, v, _ = librosa.pyin(voc, fmin=70, fmax=1000, sr=SR, hop_length=441)
    voiced = float(np.mean(v))
    keep = level > -20 and voiced >= 0.35
    meta = {"clip_id": name, "genre": genre, "vocal_level_db": round(float(level), 1), "voiced_share": round(voiced, 3), "kept_as_vocals": bool(keep)}
    if keep:
        sf.write(out / "test-gtzan-vocals" / f"{name}.wav", voc, SR, subtype="PCM_16")
        shutil.copyfile(beats, out / "test-gtzan-vocals" / f"{name}.beats")
        (out / "test-gtzan-vocals" / f"{name}.json").write_text(json.dumps(meta))
    (out / "test-gtzan-mix" / f"{name}.json").write_text(json.dumps(meta))
    return meta


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gtzan", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--workers", type=int, default=16)
    args = ap.parse_args()
    for d in ("test-gtzan-mix", "test-gtzan-vocals"):
        (args.out / d).mkdir(parents=True, exist_ok=True)
    stems = sorted(p.name for p in (args.gtzan / "demucs/htdemucs").iterdir() if (p / "vocals.wav").exists())
    with ProcessPoolExecutor(args.workers) as pool:
        res = list(pool.map(_one, [(s, str(args.gtzan), str(args.out)) for s in stems], chunksize=4))
    kept = [r for r in res if r.get("kept_as_vocals")]
    by_genre = {}
    for r in res:
        if "genre" in r:
            g = by_genre.setdefault(r["genre"], [0, 0])
            g[0] += 1
            g[1] += int(r["kept_as_vocals"])
    summary = {"mixes": sum(1 for r in res if "genre" in r), "vocal_stems_kept": len(kept), "per_genre_mixes_and_vocals": by_genre,
               "skipped": [r for r in res if "skipped" in r]}
    (args.out / "test-gtzan-vocals" / "summary.json").write_text(json.dumps(summary, indent=1))
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main()
