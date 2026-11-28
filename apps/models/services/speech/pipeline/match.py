"""How alike two voices sound: WavLM speaker embeddings (microsoft/wavlm-base-plus-sv), compared by cosine."""
from __future__ import annotations

import gc
from pathlib import Path

import librosa
import numpy as np

from . import paths

SR = 16000
# Quieter than this (dB below full scale) is no voice: a fixed level, so a recording of only hiss or silence holds none
# (a level relative to the recording's own loudest point would count its hiss as voice).
SILENCE_DB = 50


def voiced(audio: np.ndarray) -> np.ndarray:
    """The parts of 16 kHz mono `audio` louder than SILENCE_DB below full scale, joined."""
    parts = librosa.effects.split(audio, top_db=SILENCE_DB, ref=1.0)
    return np.concatenate([audio[a:b] for a, b in parts]) if len(parts) else audio[:0]


def voiced_seconds(wav: Path) -> float:
    """How many seconds of voice the recording holds."""
    audio, _ = librosa.load(str(wav), sr=SR, mono=True)
    return len(voiced(audio)) / SR


class SpeakerMatcher:
    def __init__(self) -> None:
        import torch
        from transformers import AutoFeatureExtractor, WavLMForXVector

        if not paths.WAVLM_SV.is_dir():
            raise RuntimeError(f"speech: no speaker model at {paths.WAVLM_SV} (run tools/fetch_wavlm.py)")
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.features = AutoFeatureExtractor.from_pretrained(str(paths.WAVLM_SV))
        self.model = WavLMForXVector.from_pretrained(str(paths.WAVLM_SV)).to(self.device).eval()

    def embed(self, wav: Path) -> np.ndarray:
        """The voice's embedding (unit length), from its sounding parts. Raises ValueError under 1 s of voice."""
        import torch

        audio, _ = librosa.load(str(wav), sr=SR, mono=True)
        sounding = voiced(audio)
        if len(sounding) < SR:
            raise ValueError(f"speech: {Path(wav).name} has {len(sounding) / SR:.1f} s of voice; matching needs at least 1 s of voice")
        inputs = self.features(sounding, sampling_rate=SR, return_tensors="pt").to(self.device)
        with torch.no_grad():
            e = self.model(**inputs).embeddings[0].float().cpu().numpy()
        return e / np.linalg.norm(e)

    @staticmethod
    def similarity(a: np.ndarray, b: np.ndarray) -> float:
        return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))

    def close(self) -> None:
        import torch

        del self.model, self.features
        gc.collect()
        torch.cuda.empty_cache()
