"""De-reverb: anvuew's room-reverb model (BS-RoFormer, mono, 44.1 kHz; huggingface.co/anvuew/dereverb_room, GPL-3.0)
takes the room out of a singer's recording (pipeline/add_singer.py, every upload).

Owner 2026-11-28, by ear against the model SoulX-Singer-Preprocess ships (anvuew's dereverb Mel-Band RoFormer, which
left the test recordings almost unchanged) and anvuew's newer stereo BS-RoFormer: "The 3b / 8b model seems to be the
best" (the room model). The BS-RoFormer code folder (pipeline.paths.BS_ROFORMER_CODE) must be on sys.path (the
adapter's load() puts it there).
"""
from __future__ import annotations

import gc

import numpy as np

from . import paths

SR = 44100
CONFIG = "dereverb_room_anvuew.yaml"
CKPT = "dereverb_room_anvuew_sdr_13.7432.ckpt"


def load_config():
    import yaml
    from ml_collections import ConfigDict

    return ConfigDict(yaml.load((paths.DEREVERB_ROOM_WEIGHTS / CONFIG).read_text(), Loader=yaml.FullLoader))


def _load_model(cfg, device):
    import torch
    from models.bs_roformer import BSRoformer

    model = BSRoformer(**dict(cfg.model))
    state = torch.load(paths.DEREVERB_ROOM_WEIGHTS / CKPT, map_location="cpu", weights_only=False)
    model.load_state_dict(state, strict=True)
    return model.to(device).eval()


def _demix():
    from utils.model_utils import demix

    return demix


def dereverb(y: np.ndarray, sr: int, device) -> np.ndarray:
    """A mono recording (samples) at 44.1 kHz without its room: the model's dry stem, the same length. The model is
    loaded for the call and released after it (one model on the graphics card at a time)."""
    if sr != SR:
        raise ValueError(f"de-reverb needs 44100 Hz audio, got {sr}")
    if y.ndim != 1:
        raise ValueError(f"de-reverb needs mono audio, got shape {y.shape}")
    import torch

    cfg = load_config()
    model = _load_model(cfg, device)
    try:
        out = _demix()(cfg, model, np.asarray(y, np.float32)[None], torch.device(device), model_type="bs_roformer")
        target = cfg.training.target_instrument
        if target not in out:
            raise RuntimeError(f"the de-reverb model returned stems {list(out)}, expected {target}")
        dry = np.asarray(out[target], dtype=np.float32)
        dry = dry[0] if dry.ndim == 2 else dry
        if dry.shape != y.shape:
            raise RuntimeError(f"the de-reverb model returned {dry.shape[0]} samples for {y.shape[0]}")
        return dry
    finally:
        del model
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
