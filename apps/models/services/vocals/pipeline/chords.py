"""Chords of a take with ChordNet (the chord recogniser MuLaCover ships: five models averaged).

Ported from apps/models/ace-vocal-tests/other-models/chordnet.py (shared tree). Read from the separated backing.
Returns [[label, start_s, end_s], ...] with labels like "C:maj", "A:min", "N" (no chord).
"""
from __future__ import annotations

import gc

import numpy as np
import torch

from . import paths


class ChordReader:
    def __init__(self, device: torch.device):
        from mulacover._symbolic_transcription.harmony import ChordTranscriber

        self.t = ChordTranscriber(paths.CHORDNET_CHECKPOINTS, device, torch.float32)

    def read(self, audio: np.ndarray, sr: int):
        """audio: channels x samples (or samples) at sr."""
        import librosa

        t = self.t
        y = np.asarray(audio, dtype=np.float32)
        if y.ndim == 2:
            y = y.mean(axis=0)
        y = librosa.resample(y, orig_sr=sr, target_sr=t.sample_rate)
        cqt = librosa.hybrid_cqt(y, sr=t.sample_rate, bins_per_octave=36, fmin=librosa.note_to_hz("F#0"), n_bins=288,
                                 tuning=None, hop_length=t.hop_length).T
        feats = torch.from_numpy(np.abs(cqt).astype(np.float32)).to(device=t.device, dtype=t.dtype)
        with torch.inference_mode():
            preds = [m.inference(feats) for m in t.models]
        probs = [np.mean([p[h] for p in preds], axis=0) for h in range(6)]
        segs = t.decoder.decode_segments(probs, t.hop_length / t.sample_rate)
        if not segs:
            raise RuntimeError("ChordNet found no chord segments in the take")
        return [[str(label), float(a), float(b)] for label, a, b in segs]

    def close(self):
        self.t = None
        gc.collect()
        torch.cuda.empty_cache()
