"""Voice conversion with SoulX-Singer-SVC: a SoulX take re-sung in the voice of a YuE2 take (melody, timing and words
from the target recording, timbre from the prompt recording). Pitch curves from RMVPE (SoulX's own f0 extractor). No
pitch shift: the target's notes are kept.

Ported from apps/models/ace-vocal-tests/other-models/soulx_svc.py (shared tree). The SoulX repo
(pipeline.paths.SOULX_REPO) must be on sys.path (the adapter's load() puts it there).
"""
from __future__ import annotations

import gc
from pathlib import Path

import numpy as np
import torch

from . import paths


class Converter:
    def __init__(self, device: torch.device):
        from . import soulx_compat

        soulx_compat.install()
        from cli.inference_svc import build_model
        from preprocess.tools.f0_extraction import F0Extractor
        from soulxsinger.utils.file_utils import load_config

        for p in (paths.SOULX_SVC_MODEL, paths.SOULX_RMVPE):
            if not p.is_file():
                raise FileNotFoundError(f"SoulX-SVC weights missing: {p}")
        self.config = load_config(str(paths.SOULX_REPO / "soulxsinger" / "config" / "soulxsinger.yaml"))
        self.sr = int(self.config.audio.sample_rate)
        self.device = device
        self.f0x = F0Extractor(str(paths.SOULX_RMVPE), device=str(device), target_sr=self.sr,
                               hop_size=self.config.audio.hop_size, verbose=False)
        self.model = build_model(model_path=str(paths.SOULX_SVC_MODEL), config=self.config, device=str(device),
                                 use_fp16=False)

    def _f0(self, path: Path, f0_path: Path):
        f0 = self.f0x.process(str(path), f0_path=str(f0_path))
        return torch.from_numpy(np.asarray(f0, dtype=np.float32)).unsqueeze(0).to(self.device)

    def convert(self, prompt: Path, target: Path, work: Path) -> np.ndarray:
        """`target` re-sung in the voice of `prompt` (mono, self.sr). The pitch curves are saved in `work`."""
        from soulxsinger.utils.audio_utils import load_wav

        pt_wav = load_wav(str(prompt), self.sr).to(self.device)
        gt_wav = load_wav(str(target), self.sr).to(self.device)
        pt_f0 = self._f0(prompt, work / f"{Path(prompt).stem}_f0.npy")
        gt_f0 = self._f0(target, work / f"{Path(target).stem}_f0.npy")
        with torch.no_grad():
            audio, _ = self.model.infer(pt_wav=pt_wav, gt_wav=gt_wav, pt_f0=pt_f0, gt_f0=gt_f0, auto_shift=False,
                                        pitch_shift=0, n_steps=self.config.infer.n_steps, cfg=self.config.infer.cfg,
                                        use_fp16=False)
        out = audio.squeeze().float().cpu().numpy()
        if not np.any(np.abs(out) > 1e-3):
            raise RuntimeError(f"voice conversion of {Path(target).name} came out silent")
        return out

    def close(self):
        self.model = None
        self.f0x = None
        gc.collect()
        torch.cuda.empty_cache()
