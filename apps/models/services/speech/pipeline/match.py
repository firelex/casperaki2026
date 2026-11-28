"""How alike two voices sound: WavLM speaker embeddings (microsoft/wavlm-base-plus-sv), compared by cosine."""
from __future__ import annotations

import gc
from pathlib import Path

import librosa
import numpy as np

from . import paths

SR = 16000


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
        parts = librosa.effects.split(audio, top_db=35)
        voiced = np.concatenate([audio[a:b] for a, b in parts]) if len(parts) else audio[:0]
        if len(voiced) < SR:
            raise ValueError(f"speech: {Path(wav).name} has {len(voiced) / SR:.1f} s of voice; matching needs at least 1 s of voice")
        inputs = self.features(voiced, sampling_rate=SR, return_tensors="pt").to(self.device)
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
