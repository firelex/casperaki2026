"""Precompute the note model's inputs and labels once per set (CPU).

  python -I scripts/features.py --set r1-train --dirs /mnt/d/casperaki-data/hum-beats/full/train --workers 16
  python -I scripts/features.py --set r1-dev   --dirs /mnt/d/casperaki-data/hum-beats/full/dev
  python -I scripts/features.py --set humtrans-tune --manifest humtrans-tune     (likewise humtrans-test, synth-test)

Round two can be added later by passing more --dirs (e.g. .../r2b/train) under a new set name; the family splits of
hum-beats are kept because a set is a split folder.

Inputs, one row per SwiftF0 frame (16 ms, 16 kHz audio), from the clip AUDIO only (never pitch.npz):
  0 SwiftF0 pitch in MIDI (0 where SwiftF0 says unvoiced, confidence < 0.5)
  1 voiced (0/1)    2 SwiftF0 confidence    3 loudness: frame level in dB minus the clip's loudest frame, / 40
  4 onset strength (librosa log-mel spectral flux, same 256-sample hop), / its 95th percentile in the clip
Labels: the reference notes [onset_s, offset_s, midi] (synthetic: INTENDED pitch at PERFORMED times; HumTrans: the
octave-corrected score) and a key. The generator stored no key, so every clip gets (a) "sig_soft", a key-signature target: the
diatonic scale(s) holding most of its reference notes (12 classes, the relative-major tonic; uniform over ties), and
(b) "key", the Krumhansl-Schmuckler key of its reference notes (24 classes, for information), and (c) "key_label",
the key the generator stored (0-23: tonic + 12 for minor-like scales), null when it stored none (round one), with
"key_source": "exact" (the generator chose it) or "estimated" (estimated from the melody afterwards). HumTrans recordings
also get the key signature of their MIDI ("key_signature", relative-major tonic 0-11), which scores the key output.
Writes /mnt/d/casperaki-data/hum-pitch/features/<set>.npz (all clips concatenated) and <set>.jsonl (per clip).
"""
import argparse
import json
import os
import sys
from multiprocessing import Pool
from pathlib import Path

os.environ["OMP_NUM_THREADS"] = "1"

import numpy as np  # noqa: E402

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "scripts"))
from hum_pitch.core import DATA, FMAX_HZ, FMIN_HZ, frame_rms_db, hz_to_midi  # noqa: E402
from hum_pitch.keys import key_source, stored_key  # noqa: E402
from hum_pitch.notes import estimate_key  # noqa: E402
from hum_pitch.sets import references  # noqa: E402

FEAT_DIR = DATA / "features"
HUMTRANS_MIDI = Path("/mnt/d/casperaki-data/humtrans/midi/midi_data")
_DET = None


def _init():
    global _DET
    from swift_f0 import SwiftF0
    _DET = SwiftF0(threads=1)


def key_label(notes) -> int:
    a = np.asarray(notes, dtype=float)
    tonic, mode = estimate_key(a[:, 2].astype(int), a[:, 1] - a[:, 0])
    return tonic + (12 if mode == "minor" else 0)


DIATONIC = np.array([0, 2, 4, 5, 7, 9, 11])


def signature_soft(notes) -> list[float]:
    """Key-signature target (12 classes: the relative-major tonic of a diatonic scale): uniform over the diatonic
    scales that hold the largest duration-weighted share of the notes (within 0.5%). A pentatonic melody fits two or
    three scales equally and gets all of them."""
    a = np.asarray(notes, dtype=float)
    pc, w = a[:, 2].astype(int) % 12, a[:, 1] - a[:, 0]
    cov = np.array([(w * np.isin(pc, (DIATONIC + t) % 12)).sum() / w.sum() for t in range(12)])
    best = cov >= cov.max() - 0.005
    return (best / best.sum()).round(4).tolist()


def features(wav: str) -> np.ndarray:
    import librosa
    y, sr = librosa.load(wav, sr=16000, mono=True)
    r = _DET.detect(y, sr, fmin=FMIN_HZ, fmax=FMAX_HZ)
    voiced = (r.confidence >= 0.5) & np.isfinite(r.pitch_hz) & (r.pitch_hz > 0)
    midi = np.zeros(len(r.pitch_hz))
    midi[voiced] = hz_to_midi(r.pitch_hz[voiced])
    level = frame_rms_db(y, sr, r.timestamps)
    env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=256)
    n = len(midi)
    if len(env) < n:
        env = np.pad(env, (0, n - len(env)))
    env = env[:n] / (np.percentile(env[:n], 95) + 1e-6)
    loud = np.clip((level - level.max()) / 40.0, -2.5, 0.0)
    return np.stack([midi, voiced.astype(float), r.confidence, loud, env], 1).astype(np.float32)


def _clip(row: dict) -> tuple[dict, np.ndarray, np.ndarray]:
    f = features(row["wav"])
    notes = np.asarray(row["notes"], dtype=np.float32).reshape(-1, 3)
    meta = {"key_label": None, "key_source": None} | {k: v for k, v in row.items() if k not in ("notes",)} | {"key": key_label(row["notes"]), "sig_soft": signature_soft(row["notes"]), "n_frames": len(f), "n_notes": len(notes)}
    if row["set"].startswith("humtrans"):
        import pretty_midi
        pm = pretty_midi.PrettyMIDI(str(HUMTRANS_MIDI / f"{row['id']}.mid"))
        ks = [k.key_number for k in pm.key_signature_changes]
        if len(ks) != 1:
            raise ValueError(f"{row['id']}: {len(ks)} key signatures")
        k = ks[0]
        meta["key_signature"] = k % 12 if k < 12 else (k % 12 + 3) % 12  # relative-major tonic of the signature
    return meta, f, notes


def synth_rows(dirs: list[str], set_name: str) -> list[dict]:
    sys.path.insert(0, str(HERE / "scripts"))
    from build_sets import lead_group
    rows = []
    for d in dirs:
        for js in sorted(Path(d).glob("*.json")):
            m = json.loads(js.read_text())
            notes = []
            for n in m["notes"]:
                if n["performed_onset"] is None:
                    continue
                if n["performed_offset"] is None:
                    raise ValueError(f"{m['clip_id']}: performed onset without offset")
                notes.append([n["performed_onset"], n["performed_offset"], int(n["midi"])])
            if not notes:
                raise ValueError(f"{m['clip_id']}: no performed notes")
            rows.append({"id": f"{Path(d).parent.name}/{m['clip_id']}", "set": set_name, "wav": str(js.with_suffix(".wav")),
                         "round": Path(d).parent.name, "timbre": m["lead"]["timbre"], "key_label": stored_key(m), "key_source": key_source(m),
                         "family": m["family"], "group": lead_group(m["lead"]), "lead": m["lead"]["kind"], "notes": notes})
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", required=True)
    ap.add_argument("--dirs", nargs="*", default=[])
    ap.add_argument("--manifest", help="use a set manifest from build_sets.py instead of --dirs")
    ap.add_argument("--workers", type=int, default=16)
    ap.add_argument("--limit", type=int, default=0, help="first N clips only (pilots)")
    args = ap.parse_args()
    if bool(args.dirs) == bool(args.manifest):
        raise SystemExit("give either --dirs or --manifest")
    rows = references(args.manifest)[0] if args.manifest else synth_rows(args.dirs, args.set)
    if args.limit:
        rows = rows[:args.limit]
    with Pool(args.workers, initializer=_init) as pool:
        res = pool.map(_clip, rows, chunksize=8)
    FEAT_DIR.mkdir(parents=True, exist_ok=True)
    metas = [m for m, _, _ in res]
    feat = np.concatenate([f for _, f, _ in res])
    notes = np.concatenate([n for _, _, n in res])
    np.savez(FEAT_DIR / f"{args.set}.npz", feat=feat.astype(np.float32), notes=notes,
             frame_offsets=np.cumsum([0] + [m["n_frames"] for m in metas]), note_offsets=np.cumsum([0] + [m["n_notes"] for m in metas]))
    with open(FEAT_DIR / f"{args.set}.jsonl", "w") as f:
        f.writelines(json.dumps(m) + "\n" for m in metas)
    keys = np.bincount([m["key"] % 12 for m in metas], minlength=12)
    print(f"{args.set}: {len(metas)} clips, {len(feat)} frames, {len(notes)} notes; key tonic counts (C..B) {keys.tolist()}, "
          f"minor {np.mean([m['key'] >= 12 for m in metas]):.0%}")
    if "key_signature" in metas[0]:
        agree = np.mean([((m['key'] % 12) if m['key'] < 12 else (m['key'] % 12 + 3) % 12) == m["key_signature"] for m in metas])
        print(f"  Krumhansl-Schmuckler key of the reference notes matches the MIDI key signature on {agree:.1%}")


if __name__ == "__main__":
    main()
