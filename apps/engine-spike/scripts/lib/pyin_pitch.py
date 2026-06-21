#!/usr/bin/env python
# docs/58b — pYIN fundamental-frequency tracker.
#
# The legacy octaveAdjustment classifier
# (casperaki1/calculateOctaveAdjustmentsAndSaveToDatabase.js) ran
#   sonic-annotator -d vamp:pyin:yin:f0 -w default <wav>
# on each instrument's C3 slot to detect the true fundamental.
# `librosa.pyin` is the same algorithm (Mauch & Dixon 2014) — wrapping
# it here so the classifier's mjs side stays small and ships its own
# stable JSON contract.
#
# Reads one or more audio file paths from argv. For each, emits one
# JSON line on stdout:
#
#   {"path": "...", "f0Hz": 130.81, "voicedFrames": 87, "voicedFraction": 0.91}
#
# When all frames are unvoiced (no pitch found) f0Hz is null. Errors
# (decode failure, file missing) emit {"path": "...", "error": "..."}.
#
# fmin/fmax cover -3 to +4 octaves of C3 (130.8 Hz) — wide enough to
# catch the most-detuned legacy samples without admitting subharmonic
# noise as a candidate fundamental.

import json
import sys
import warnings

import librosa
import numpy as np

FMIN = 24.0   # safe at sr=48000, frame_length=4096 (floor is ~12 Hz)
FMAX = 4200.0 # ~ C8
# pYIN frame length. 4096 was picked over 2048 because some catalog
# samples are 48 kHz and pYIN's fmin floor is `sr/frame_length`; with
# 2048 @ 48000 the floor is 23.45 Hz, which crashes for FMIN=22. 4096
# halves the floor (~11.7 Hz) at modest extra compute (~0 in practice
# because most of the wall-time is mp3 decode + librosa.effects.trim).
FRAME_LENGTH = 4096
# Hard cap on audio duration sent to pYIN. The legacy script trimmed
# every sample to a 1-second window after silence-trim
# (calculateOctaveAdjustmentsAndSaveToDatabase.js:80 -
# `sox … silence 1 0.1 1% trim 00:00 00:01`). Preset MP3s in the
# new catalog are several minutes long; letting pYIN walk the
# whole file is ~15-30 s/file and we have 286 files to process.
# 5 s covers the attack + sustain portion that the legacy trimmed
# from, with margin for slow attacks.
MAX_DURATION_SEC = 5.0


def analyse(path: str) -> dict:
    try:
        y, sr = librosa.load(path, sr=None, mono=True, duration=MAX_DURATION_SEC)
    except Exception as exc:
        return {"path": path, "error": f"load: {exc}"}
    if y.size == 0:
        return {"path": path, "error": "empty"}

    # Trim leading near-silence; some slots have ~0.3 s of pre-attack
    # noise that fools the tracker.
    y, _ = librosa.effects.trim(y, top_db=40.0)
    if y.size < 2048:
        return {"path": path, "error": "too-short-after-trim"}

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        f0, voiced_flag, voiced_prob = librosa.pyin(
            y,
            fmin=FMIN,
            fmax=FMAX,
            sr=sr,
            frame_length=FRAME_LENGTH,
            hop_length=512,
        )

    voiced = f0[~np.isnan(f0)]
    total = int(f0.shape[0])
    if voiced.size == 0:
        return {
            "path": path,
            "f0Hz": None,
            "voicedFrames": 0,
            "voicedFraction": 0.0,
            "totalFrames": total,
        }
    return {
        "path": path,
        "f0Hz": float(np.median(voiced)),
        "voicedFrames": int(voiced.size),
        "voicedFraction": float(voiced.size / total),
        "totalFrames": total,
    }


def main() -> int:
    if len(sys.argv) < 2:
        sys.stderr.write("usage: pyin_pitch.py <audio> [<audio> ...]\n")
        return 2
    for path in sys.argv[1:]:
        result = analyse(path)
        sys.stdout.write(json.dumps(result) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
