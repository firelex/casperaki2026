"""Vocal separation with BS-RoFormer (viperx ep317, SDR 12.97): a take -> (vocals, instrumental = mix - vocals).

Ported from apps/models/ace-vocal-tests/separate.py (shared tree), RoFormer half only. The BS-RoFormer code folder
(pipeline.paths.BS_ROFORMER_CODE) must be on sys.path (the adapter's load() puts it there). Works at 44.1 kHz stereo.
"""
from __future__ import annotations

import gc

import numpy as np
import torch

from . import paths

SR = 44100
CONFIG = "model_bs_roformer_ep_317_sdr_12.9755.yaml"
CKPT = "bs_roformer.ckpt"


class Separator:
    def __init__(self, device: torch.device):
        import yaml
        from ml_collections import ConfigDict
        from models.bs_roformer import BSRoformer

        cfg_path = paths.BS_ROFORMER_WEIGHTS / CONFIG
        self.config = ConfigDict(yaml.load(cfg_path.read_text(), Loader=yaml.FullLoader))
        model = BSRoformer(**dict(self.config.model))
        state = torch.load(paths.BS_ROFORMER_WEIGHTS / CKPT, map_location="cpu", weights_only=True)
        model.load_state_dict(state, strict=True)
        self.model = model.to(device).eval()
        self.device = device

    def separate(self, audio: np.ndarray, sr: int):
        """audio: samples x channels (as soundfile reads it). Returns (vocals, instrumental), channels x samples at SR."""
        import torchaudio
        from utils.model_utils import demix

        x = torch.from_numpy(np.ascontiguousarray(np.asarray(audio, dtype=np.float32).T))
        if x.ndim == 1:
            x = x[None]
        if x.shape[0] == 1:
            x = x.repeat(2, 1)
        if x.shape[0] != 2:
            raise ValueError(f"separation needs mono or stereo audio, got {x.shape[0]} channels")
        if sr != SR:
            x = torchaudio.functional.resample(x, sr, SR)
        res = demix(self.config, self.model, x.numpy(), self.device, model_type="bs_roformer")
        if set(res) != {"vocals"}:
            raise RuntimeError(f"BS-RoFormer returned stems {list(res)}, expected only vocals")
        vocals = np.asarray(res["vocals"], dtype=np.float32)
        return vocals, x.numpy() - vocals

    def close(self):
        self.model = None
        gc.collect()
        torch.cuda.empty_cache()
