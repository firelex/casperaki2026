"""Render full Casperaki songs (drums, bass, chords, leads: real mixes made by the app itself) with exact beat
labels, to keep the fine-tuned model's skill on full music. Every song is 4/4 at one constant tempo, the beat grid
starts at time 0 (checked: final0 finds beats at F 0.99 on that grid), so beats are k x 60/bpm and every fourth
beat is a downbeat.

  python scripts/render_songs.py --out /mnt/d/casperaki-data/hum-beats/songs --n 400 --workers 8
Per song: orchestrate offline (@casperaki/arrangement, scripts/make_song.mjs) -> lower with the brain's own emit
script -> render with the engine's casperaki_render (the same steps as the brain's per-song render). Then three
25 s excerpts at random places, mono 22,050 Hz, with .beats and .json, into <out>/train/.
"""
import argparse
import json
import os
import subprocess
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

CA = Path(__file__).resolve().parents[4]
LIB = "/mnt/d/Scissero Dropbox/Mathias Strasser/datigator-instruments/instruments"
GENRE_BPM = {"brightPop": 120, "edm": 128, "ballad": 75, "latin": 100, "organicVibes": 90, "rock": 120, "schlager": 120, "urban": 90}
KEYS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
SR = 22050


def render(args):
    i, work, out = args
    import soundfile as sf
    import soxr
    rng = np.random.default_rng(1000 + i)
    genre = str(rng.choice(list(GENRE_BPM)))
    bpm = int(round(GENRE_BPM[genre] * rng.uniform(0.85, 1.15)))
    key = str(rng.choice(KEYS))
    seed = f"hum-beats-song-{i}"
    d = Path(work) / f"song{i:04d}"
    d.mkdir(parents=True, exist_ok=True)
    if all((Path(out) / "train" / f"song{i:04d}-{k}.beats").exists() for k in range(3)):
        return {"song": i, "genre": genre, "bpm": bpm, "key": key, "clips": [f"song{i:04d}-{k}" for k in range(3)], "reused": True}
    env = {**os.environ, "CASPERAKI_SAMPLE_LIBRARY_ROOT": LIB}
    subprocess.run(["node", str(Path(__file__).with_name("make_song.mjs")), str(d), genre, key, str(bpm), seed], check=True, cwd=CA / "apps/engine-spike",
                   capture_output=True)
    with open(d / "lower.log", "w") as log:
        subprocess.run(["node", "../engine-spike/scripts/emit-brain-roundtrip.mjs"], check=True, cwd=CA / "apps/brain", stdout=log, stderr=log,
                       env={**env, "BRAIN_SONG_FILE": str(d / "song-in.json"), "OUT_DIR": str(d)})
    with open(d / "render.log", "w") as log:
        r = subprocess.run([str(CA / "apps/web/wasm/engine/build/casperaki_render"), str(d), str(d / "out.wav"), str(CA / "apps/engine-spike/samples"), LIB],
                           cwd=CA / "apps/brain", stdout=log, stderr=log, env={**env, "CASPERAKI_BITS": "16", "CASPERAKI_MIX": "1"})
    if r.returncode != 0:
        # the renderer refused this song (e.g. "loop ... is 2.580635 s, shorter than one bar (2.580645 s)": an
        # engine rounding bug at some tempos); recorded in songs.jsonl and reported, never silently replaced
        err = (d / "render.log").read_text().strip().splitlines()[-1:]
        return {"song": i, "genre": genre, "bpm": bpm, "key": key, "failed": err}
    y, sr = sf.read(d / "out.wav", dtype="float32")
    if y.ndim == 2:
        y = y.mean(1)
    y = soxr.resample(y, sr, SR)
    period = 60.0 / bpm
    total = len(y) / SR
    made = []
    for k in range(3):
        start = float(rng.uniform(0, max(0.0, total - 25.0)))
        seg = y[int(start * SR): int((start + 25.0) * SR)]
        beats = np.arange(np.ceil(start / period - 1e-9), np.floor((start + len(seg) / SR) / period) + 1) * period
        num = (np.round(beats / period).astype(int) % 4) + 1
        t = beats - start
        keep = (t >= 0) & (t < len(seg) / SR)
        cid = f"song{i:04d}-{k}"
        sf.write(Path(out) / "train" / f"{cid}.wav", seg, SR, subtype="PCM_16")
        with open(Path(out) / "train" / f"{cid}.beats", "w") as f:
            f.writelines(f"{a:.5f}\t{b}\n" for a, b in zip(t[keep], num[keep]))
        (Path(out) / "train" / f"{cid}.json").write_text(json.dumps({"clip_id": cid, "genre": genre, "bpm": bpm, "key": key, "seed": seed,
                                                                       "excerpt_start_s": start, "source": "casperaki render"}))
        made.append(cid)
    (d / "out.wav").unlink()  # the excerpts are kept; the full render is regenerable
    return {"song": i, "genre": genre, "bpm": bpm, "key": key, "clips": made}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--work", type=Path, required=True, help="scratch folder for the song files")
    ap.add_argument("--n", type=int, required=True)
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()
    (args.out / "train").mkdir(parents=True, exist_ok=True)
    with ProcessPoolExecutor(args.workers) as pool, open(args.out / "songs.jsonl", "w") as idx:
        for r in pool.map(render, [(i, str(args.work), str(args.out)) for i in range(args.n)]):
            idx.write(json.dumps(r) + "\n")
            idx.flush()
    print(f"done: {args.n} songs attempted (failures are listed in songs.jsonl)")


if __name__ == "__main__":
    main()
