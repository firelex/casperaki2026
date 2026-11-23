"""Check the deviation model: perform the held-out HumTrans train scores synthetically and measure them with
the same extractor as the real hums (scripts/humtrans_deviations.py), then compare the distributions.

  python -I scripts/validate_deviation.py --out <dir>
For every held-out recording, its own MIDI score is performed (a) with the deviation model fitted on the other
pieces, and (b) with round one's hand-set humanisation, rendered with the synthetic hum voice (clean, the
score's own octave, 0.4 s lead-in), and written next to a copy of the real measurements.
"""
import argparse
import json
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hum_beats import music  # noqa: E402
from hum_beats.deviation import DeviationModel, perform, pitch_curve_from_contours  # noqa: E402
from hum_beats.music import Note, Score, TempoMap  # noqa: E402
from hum_beats.render import loudness_curve, pitch_amounts, pitch_curve, render_voice, to_audio_rate  # noqa: E402
from hum_beats.sounds import SR  # noqa: E402

DEV = Path("/mnt/d/casperaki-data/hum-beats/deviation-model")
MIDI_DIR = Path("/mnt/d/casperaki-data/humtrans/midi/midi_data")
_MODEL = None


def _score(key):
    import pretty_midi
    pm = pretty_midi.PrettyMIDI(str(MIDI_DIR / f"{key}.mid"))
    tempo = float(pm.get_tempo_changes()[1][0])
    ts = pm.time_signature_changes[-1]
    meter = f"{ts.numerator}/{ts.denominator}"
    if meter not in music.METERS:
        meter = "4/4"
    qps = tempo / 60.0
    notes = [Note(n.start * qps, n.end * qps, int(n.pitch)) for n in sorted(pm.instruments[0].notes, key=lambda n: n.start)]
    music.mark_phrase_ends(notes, music.METERS[meter][1])
    end = max(n.end for n in pm.instruments[0].notes)
    return Score(meter, int(np.ceil(end * qps / music.METERS[meter][0])), notes, {}), tempo, end


def _render(key, mode, seed):
    rng = np.random.default_rng(seed)
    score, tempo, end = _score(key)
    q0 = -16.0
    n = int(np.ceil((score.notes[-1].q_off + 16 - q0) / TempoMap.RES))
    tmap = TempoMap(q0, 0, np.full(n, 60.0 / tempo))
    shift = float(tmap.time(0.0)) - 0.4  # clip time = score time + 0.4 s
    if mode == "model":
        perf, params = perform(_MODEL, rng, score, tmap, perfect_timing=False)
    else:
        timing = "humanised" if rng.random() < 0.6 else "irregular"
        amounts = {"tempo": float(rng.uniform(0, 1)), "precision": float(rng.uniform(0, 1)), "pitch": float(rng.uniform(0, 1))}
        tmap2, _ = music.build_tempo_map(rng, score, tempo, timing, q0, score.notes[-1].q_off + 16, amounts)
        tmap = tmap2
        shift = float(tmap.time(0.0)) - 0.4
        perf, _ = music.perform(rng, score, tmap, timing, amounts, False, True)
    for p in perf:
        for k in ("nominal_onset", "nominal_offset", "onset", "offset"):
            p[k] -= shift
    dur = max(end, max(p["offset"] for p in perf)) + 1.5
    if mode == "model":
        cents = pitch_curve_from_contours(perf, dur, params, True)
    else:
        cents, _, _ = pitch_curve(rng, perf, dur, pitch_amounts(rng, float(rng.uniform(0, 1))), True)
    ns = int(dur * SR)
    env = to_audio_rate(loudness_curve(perf, dur, float(rng.uniform(0.015, 0.08)), 0.05, 0.3), ns)
    held = cents.copy()
    ok = np.isfinite(held)
    held = np.interp(np.arange(len(held)), np.flatnonzero(ok), held[ok])
    audio, _ = render_voice(rng, to_audio_rate(held, ns), env > 1e-4, env, str(rng.choice(["mm", "oo", "ah"])), 1.0 if score.notes[0].midi < 60 else 1.16, perf, dur, False, normalize_notes=(mode == "model"))
    return audio / (np.max(np.abs(audio)) + 1e-9) * 0.5


def _job(args):
    key, mode, out = args
    import soundfile as sf
    audio = _render(key, mode, hash((key, mode)) % 2**32)
    sf.write(Path(out) / mode / f"{key}.wav", audio.astype(np.float32), SR)
    return key


def _init():
    global _MODEL
    split = json.loads((DEV / "split.json").read_text())
    _MODEL = DeviationModel(DEV / "humtrans-train", set(split["fit_pieces"]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--workers", type=int, default=20)
    args = ap.parse_args()
    split = json.loads((DEV / "split.json").read_text())
    held = set(split["heldout_pieces"])
    clips = [c for c in json.loads((DEV / "humtrans-train.clips.json").read_text()) if c["piece"] in held]
    keys = [c["key"] for c in clips]
    for mode in ("model", "round1"):
        (args.out / mode).mkdir(parents=True, exist_ok=True)
    with ProcessPoolExecutor(args.workers, initializer=_init) as pool:
        list(pool.map(_job, [(k, m, str(args.out)) for k in keys for m in ("model", "round1")], chunksize=2))
    (args.out / "keys.txt").write_text("\n".join(keys))
    print(f"rendered {len(keys)} held-out scores twice")


if __name__ == "__main__":
    main()
