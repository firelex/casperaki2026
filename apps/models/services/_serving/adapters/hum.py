"""Adapter: hum transcription for hum-to-song (beats, key and notes from a hummed or sung recording).

Synchronous route (see harness ROUTES):

  POST /transcribe   multipart/form-data
      audio          the recording (any format ffmpeg reads: webm/opus from the browser, wav, mp3, ...)
      mode           "click" (hummed along to a click) or "free"
      bpm            click mode: the click's tempo
      firstBeatSec   click mode: time in the recording of beat 1 of the first bar after the count-in
  -> {"bpm", "beats": [s], "downbeats": [s], "key": {"tonic": 0-11, "scale": "major"|"minor"},
      "notes": [{"onsetSec", "offsetSec", "midi"}], "tookMs"}

How (the best measured pipeline, apps/models/hum-beats and apps/models/hum-pitch; then syllables, below):
  * beats, free mode: Beat This! fine-tuned on hums (beatthis-hum-20261123-1045) -> frame activations -> madmom's
    DBN with 4-beat bars (the owner's decision), as in hum-beats/scripts/note_grid.py dbn4. Click mode: the grid
    from the click (no beat tracking).
  * notes: SwiftF0 pitch (16 kHz) -> the hum-notes model (bigru128-humnotes-r123-20261123-2136) for note
    boundaries -> each note pitched as the median SwiftF0 pitch, minus the recording's tuning offset, snapped to
    the model's key signature (hum-pitch/scripts/combine.py, "model notes + tuning + key snap (model's key head)",
    79.8% right notes on HumTrans test).
  * key: the model's key signature (a major scale); major vs its relative minor by Krumhansl-Schmuckler over the
    notes found.
  * syllables (hum_pitch/syllables.py, 2026-11-26): the model's notes split at spectral-flux onsets (repeated
    syllables on one pitch), each piece re-pitched (pYIN, tuning offset, key snap), and in click mode one note per
    eighth. The owner's la-la "Alle meine Entchen": 12 -> 22 of 27 notes right; HumTrans test 47.2% -> 47.9%.
Weights stay where training wrote them on /mnt/d; nothing is downloaded.
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from adapter_common import RequestError, parse_multipart

MODELS_ROOT = Path(__file__).resolve().parents[3]  # apps/models
HUM_PITCH = MODELS_ROOT / "hum-pitch"
BEAT_CKPT = Path("/mnt/d/casperaki-data/hum-beats/runs/beatthis-hum-20261123-1045/final-weights.ckpt")
NOTES_RUN = "bigru128-humnotes-r123-20261123-2136"
NOTES_CKPT = Path(f"/mnt/d/casperaki-data/hum-pitch/runs/{NOTES_RUN}/final.pt")
MAX_SECONDS = 120.0
FPS = 50  # Beat This! frame rate

MANIFEST = {
    "id": "hum",
    "label": "Hum transcription",
    "description": "Beats, key and notes from a hummed or sung recording (hum to song).",
    "kind": "audio",
    "category": "app",
    "python": "3.12",
    "venv": ".venv",
    "setup": [
        ["$UV", "venv", "--python", "3.12", ".venv"],
        ["$UV", "pip", "install", "--python", ".venv/bin/python", "torch==2.7.1", "torchaudio==2.7.1",
         "--index-url", "https://download.pytorch.org/whl/cu128"],
        ["$UV", "pip", "install", "--python", ".venv/bin/python", "cython", "numpy"],
        ["$UV", "pip", "install", "--python", ".venv/bin/python", "git+https://github.com/CPJKU/beat_this",
         "git+https://github.com/CPJKU/madmom.git@27f032e8947204902c675e5e341a3faf5dc86dae", "swift-f0==0.3.0",
         "librosa", "soundfile", "mir_eval"],
    ],
    "params": {},
}


def load(ctx):
    import torch
    from beat_this.inference import Audio2Frames
    from swift_f0 import SwiftF0

    for p in (BEAT_CKPT, NOTES_CKPT):
        if not p.exists():
            raise SystemExit(f"hum: missing weights {p}")
    sys.path.insert(0, str(HUM_PITCH))
    from hum_pitch.model import load_checkpoint
    from hum_pitch.notes import Config

    torch.set_num_threads(2)  # datigator serves the live site: keep CPU use low
    settings = json.loads((HUM_PITCH / f"results/model-{NOTES_RUN}-settings.json").read_text())
    margin = Config(**json.loads((HUM_PITCH / "results/notes-steps-settings.json").read_text())["key"]).snap_margin
    ctx.log(f"hum: loading Beat This! {BEAT_CKPT.name}, notes model {NOTES_RUN} "
            f"(onset {settings['t_on']}, activity {settings['t_act']}, snap margin {margin})")
    return {
        "beats": Audio2Frames(checkpoint_path=str(BEAT_CKPT), device="cuda"),
        "swift": SwiftF0(threads=2),
        "notes": load_checkpoint(NOTES_CKPT),
        "t_on": float(settings["t_on"]),
        "t_act": float(settings["t_act"]),
        "margin": float(margin),
    }


def generate(handle, params, out_dir):
    raise RuntimeError("the hum service has no /generate jobs: POST /transcribe instead")


# --------------------------------------------------------------------------- #

def _decode(audio: bytes, sr: int, workdir: Path):
    import soundfile as sf

    src = workdir / "input"
    src.write_bytes(audio)
    dst = workdir / f"a{sr}.wav"
    r = subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", str(src), "-ac", "1", "-ar", str(sr),
                        "-f", "wav", str(dst)], capture_output=True, text=True)
    if r.returncode != 0:
        raise RequestError(400, f"The recording could not be read as audio: {r.stderr.strip()[:300]}")
    y, got = sf.read(dst, dtype="float32")
    if got != sr:
        raise RuntimeError(f"ffmpeg wrote {got} Hz, expected {sr} Hz")
    return y


def _number(fields: dict, name: str) -> float:
    if name not in fields:
        raise RequestError(400, f"Click mode needs the field '{name}'.")
    try:
        return float(fields[name].decode())
    except ValueError:
        raise RequestError(400, f"The field '{name}' must be a number.") from None


def _free_beats(handle, y22):
    import numpy as np
    import torch
    from madmom.features.downbeats import DBNDownBeatTrackingProcessor

    bl, dl = handle["beats"](y22, 22050)
    beat_act = torch.sigmoid(bl).float().cpu().numpy()
    db_act = torch.sigmoid(dl).float().cpu().numpy()
    eps = 1e-5
    b = beat_act * (1 - eps) + eps / 2
    d = db_act * (1 - eps) + eps / 2
    proc = DBNDownBeatTrackingProcessor(beats_per_bar=[4], min_bpm=55.0, max_bpm=215.0, fps=FPS, transition_lambda=100)
    out = proc(np.vstack((np.maximum(b - d, eps / 2), d)).T)
    if len(out) < 4:
        raise RequestError(422, "No steady beat was found in the recording. Try again a little longer, or hum along to the click.")
    beats = out[:, 0]
    downbeats = out[out[:, 1] == 1][:, 0]
    return float(60.0 / np.median(np.diff(beats))), beats, downbeats


def _click_beats(bpm: float, first: float, duration: float):
    import numpy as np

    if not 30.0 <= bpm <= 300.0:
        raise RequestError(400, "The click tempo must be between 30 and 300 BPM.")
    if not 0.0 <= first < duration:
        raise RequestError(400, "firstBeatSec must lie inside the recording.")
    period = 60.0 / bpm
    beats = first + period * np.arange(int((duration - first) / period) + 1)
    return bpm, beats, beats[::4]


def _features(handle, y16):
    """The notes model's frame inputs, as hum-pitch/scripts/features.py builds them."""
    import librosa
    import numpy as np
    from hum_pitch.core import FMAX_HZ, FMIN_HZ, frame_rms_db, hz_to_midi

    r = handle["swift"].detect(y16, 16000, fmin=FMIN_HZ, fmax=FMAX_HZ)
    voiced = (r.confidence >= 0.5) & np.isfinite(r.pitch_hz) & (r.pitch_hz > 0)
    midi = np.zeros(len(r.pitch_hz))
    midi[voiced] = hz_to_midi(r.pitch_hz[voiced])
    level = frame_rms_db(y16, 16000, r.timestamps)
    env = librosa.onset.onset_strength(y=y16, sr=16000, hop_length=256)
    n = len(midi)
    if len(env) < n:
        env = np.pad(env, (0, n - len(env)))
    env = env[:n] / (np.percentile(env[:n], 95) + 1e-6)
    loud = np.clip((level - level.max()) / 40.0, -2.5, 0.0)
    return np.stack([midi, voiced.astype(float), r.confidence, loud, env], 1).astype(np.float32)


def _notes_and_key(handle, feat):
    """Model boundaries, pitched by tuning offset + key snapping with the model's key head (combine.py)."""
    import numpy as np
    import torch
    from hum_pitch.model import FRAME_S, decode, model_inputs, reference_pitch
    from hum_pitch.notes import MAJOR, MINOR, Config, scale_set, tuning_offset

    ref = reference_pitch(feat)
    if not np.isfinite(ref).any():
        raise RequestError(422, "No sung or hummed pitch was found in the recording.")
    x = torch.from_numpy(model_inputs(feat, ref))[None]
    with torch.no_grad():
        lo, la, ld, lk, _ = handle["notes"](x, torch.ones(1, x.shape[1], dtype=torch.bool))
    notes = decode(torch.sigmoid(lo[0]).numpy(), torch.sigmoid(la[0]).numpy(), torch.softmax(ld[0], -1).numpy(), ref,
                   handle["t_on"], handle["t_act"])
    if not notes:
        raise RequestError(422, "No notes were found in the recording.")
    raw = []
    for on, off, _ in notes:
        a, b = int(round(on / FRAME_S)), int(round(off / FRAME_S))
        v = feat[a:b, 1] > 0.5
        raw.append([on, off, float(np.median(feat[a:b, 0][v])) if v.any() else float(np.median(ref[a:b]))])
    off_fn = tuning_offset(raw, Config(tuning="global"))
    tuned = [[a, b, m - float(off_fn(np.array([(a + b) / 2]))[0])] for a, b, m in raw]
    sig = int(np.argmax(torch.softmax(lk[0], -1).numpy()))  # relative-major tonic of the key signature
    sc = scale_set(sig, "major")
    out = []
    for a, b, m in tuned:
        lo_, p = int(np.floor(m)), int(round(m))
        if abs(m - lo_ - 0.5) <= handle["margin"]:
            cand = [c for c in (lo_, lo_ + 1) if c % 12 in sc]
            if len(cand) == 1:
                p = cand[0]
        out.append({"onsetSec": round(a, 4), "offsetSec": round(b, 4), "midi": p})
    # major (the signature's tonic) or its relative minor, by Krumhansl-Schmuckler over the notes
    h = np.bincount([n["midi"] % 12 for n in out], weights=[n["offsetSec"] - n["onsetSec"] for n in out], minlength=12)
    r_major = np.corrcoef(h, np.roll(MAJOR, sig))[0, 1]
    r_minor = np.corrcoef(h, np.roll(MINOR, (sig + 9) % 12))[0, 1]
    key = {"tonic": sig, "scale": "major"} if not r_minor > r_major else {"tonic": (sig + 9) % 12, "scale": "minor"}
    return out, key


def _syllables(notes, key, y22, y16, mode, fields):
    """The model's notes split into syllables (hum_pitch/syllables.py): repeated syllables on one pitch ("la la la")
    are notes of their own; each piece pitched from its own pitch track; in click mode, one note per eighth."""
    from hum_pitch.syllables import merge_on_grid, repitch, split_at_onsets

    pieces = split_at_onsets([[n["onsetSec"], n["offsetSec"], n["midi"]] for n in notes], y22, 22050)
    pieces = repitch(pieces, y16, 16000, key)
    if mode == "click":
        pieces = merge_on_grid(pieces, _number(fields, "firstBeatSec"), _number(fields, "bpm"))
    return [{"onsetSec": round(a, 4), "offsetSec": round(b, 4), "midi": int(m)} for a, b, m in pieces]


def transcribe(handle, headers, body):
    t0 = time.perf_counter()
    fields = parse_multipart(headers, body)
    if not fields.get("audio"):
        raise RequestError(400, "No audio was sent (field 'audio').")
    mode = fields.get("mode", b"").decode()
    if mode not in ("click", "free"):
        raise RequestError(400, "The field 'mode' must be 'click' or 'free'.")
    with tempfile.TemporaryDirectory(prefix="hum-") as tmp:
        y22 = _decode(fields["audio"], 22050, Path(tmp))
        y16 = _decode(fields["audio"], 16000, Path(tmp))
    duration = len(y22) / 22050
    if duration < 1.0:
        raise RequestError(422, "The recording is shorter than a second.")
    if duration > MAX_SECONDS:
        raise RequestError(413, f"The recording is {duration:.0f} s long; at most {MAX_SECONDS:.0f} s are accepted.")
    if mode == "click":
        bpm, beats, downbeats = _click_beats(_number(fields, "bpm"), _number(fields, "firstBeatSec"), duration)
    else:
        bpm, beats, downbeats = _free_beats(handle, y22)
    notes, key = _notes_and_key(handle, _features(handle, y16))
    notes = _syllables(notes, key, y22, y16, mode, fields)
    return 200, {
        "bpm": round(float(bpm), 3),
        "beats": [round(float(t), 4) for t in beats],
        "downbeats": [round(float(t), 4) for t in downbeats],
        "key": key,
        "notes": notes,
        "tookMs": int((time.perf_counter() - t0) * 1000),
    }


ROUTES = {"/transcribe": transcribe}
