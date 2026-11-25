"""YuE2 sings a lead unit from its score (pipeline.score): one take per seed, lead-in bars first.

Ported from apps/models/ace-vocal-tests/other-models/yue2_sections.py (shared tree). Takes are 48 kHz.
"""
from __future__ import annotations

import gc

import numpy as np
import torch

from . import paths


class Singer:
    def __init__(self, device: torch.device):
        from yue2 import YuE2Pipeline

        for p in (paths.YUE2_MODEL, paths.YUE2_VAE):
            if not p.is_dir():
                raise FileNotFoundError(f"YuE2 weights missing: {p}")
        self.pipe = YuE2Pipeline.from_pretrained(str(paths.YUE2_MODEL), vae=str(paths.YUE2_VAE), local_files_only=True,
                                                 device=str(device), progress=False)

    def sing(self, abc: str, lyrics: str, style: str, seed: int, cancelled):
        """Returns (audio samples x channels, sample rate). `cancelled`: a no-argument callable, True to stop (YuE2
        then raises InterruptedError)."""
        result = self.pipe(style=style, lyrics=lyrics, abc=abc, cot="full", seed=int(seed), cancelled=cancelled)
        audio = np.asarray(result.audio, dtype=np.float32)
        if audio.ndim != 2 or audio.shape[0] == 0:
            raise RuntimeError(f"YuE2 returned audio of shape {audio.shape}")
        return audio, int(result.sample_rate)

    def close(self):
        self.pipe.close()
        self.pipe = None
        gc.collect()
        torch.cuda.empty_cache()
