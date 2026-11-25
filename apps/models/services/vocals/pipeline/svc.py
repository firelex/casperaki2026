"""Backing vocals made from the sung lead with SoulX-Singer-SVC: the lead's take re-pitched to a backing line's notes,
so timing, words and voice are the lead's and only the pitch changes (the backing lines up with the lead exactly).

Ported from apps/models/ace-vocal-tests/other-models/harmony_from_lead.py (shared tree), one section at a time: the
lead's pitch curve comes from RMVPE (SoulX's own pitch extractor); the target pitch of each 20 ms frame is the lead's
pitch x 2^((backing note - lead note)/12), with the notes the two lines hold at that moment; a frame where either line
holds no note (or the lead is unvoiced) is unvoiced. The lead take is both the prompt (the voice) and the content.
The SoulX repo (pipeline.paths.SOULX_REPO) must be on sys.path (the adapter's load() puts it there).
"""
from __future__ import annotations

import gc
from pathlib import Path

import numpy as np
import torch

from . import paths

FADE_S = 0.02


def note_at(notes, beat: float):
    """The MIDI note held at `beat` (notes: [{"start", "duration", "midi"}], beats), or None."""
    for n in notes:
        if n["start"] <= beat < n["start"] + n["duration"]:
            return int(n["midi"])
    return None


def target_f0(lead_f0: np.ndarray, frame_s: float, bpm: float, lead_notes, backing_notes) -> np.ndarray:
    """The backing line's pitch per frame (Hz, 0 = unvoiced): the lead's pitch moved by the interval between the
    backing note and the lead note held at that frame (frame j is at j * frame_s seconds from the section start)."""
    beat_s = 60.0 / float(bpm)
    out = np.zeros_like(lead_f0, dtype=np.float32)
    for j, f in enumerate(lead_f0):
        if f <= 0:
            continue
        beat = j * frame_s / beat_s
        b, l = note_at(backing_notes, beat), note_at(lead_notes, beat)
        if b is not None and l is not None:
            out[j] = f * 2 ** ((b - l) / 12)
    return out


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
        self.hop = int(self.config.audio.hop_size)
        self.device = device
        self.f0x = F0Extractor(str(paths.SOULX_RMVPE), device=str(device), target_sr=self.sr, hop_size=self.hop,
                               verbose=False)
        self.model = build_model(model_path=str(paths.SOULX_SVC_MODEL), config=self.config, device=str(device),
                                 use_fp16=False)

    def repitch(self, lead: np.ndarray, lead_path: Path, bpm, lead_notes, backing_notes, work: Path,
                what: str) -> np.ndarray:
        """The lead take (mono, self.sr; also saved at lead_path for the pitch extractor) re-pitched to the backing
        notes (mono, self.sr, as long as the lead). The lead's pitch curve is saved in `work`."""
        f0 = np.asarray(self.f0x.process(str(lead_path), f0_path=str(work / f"{Path(lead_path).stem}_f0.npy")),
                        dtype=np.float32)
        tgt = target_f0(f0, self.hop / self.sr, bpm, lead_notes, backing_notes)
        if not np.any(tgt > 0):
            raise RuntimeError(f"{what}: no frame where the lead sings and the backing line holds a note")
        wav = torch.from_numpy(np.ascontiguousarray(lead, dtype=np.float32)).unsqueeze(0).to(self.device)
        with torch.no_grad():
            audio, _ = self.model.infer(pt_wav=wav, gt_wav=wav, pt_f0=torch.from_numpy(f0).unsqueeze(0).to(self.device),
                                        gt_f0=torch.from_numpy(tgt).unsqueeze(0).to(self.device), auto_shift=False,
                                        pitch_shift=0, n_steps=self.config.infer.n_steps, cfg=self.config.infer.cfg,
                                        use_fp16=False)
        a = audio.squeeze().float().cpu().numpy()[: len(lead)]
        out = np.zeros(len(lead), dtype=np.float32)
        out[: len(a)] = a
        fade = min(int(FADE_S * self.sr), len(a) // 2)
        out[:fade] *= np.linspace(0, 1, fade)
        out[len(a) - fade: len(a)] *= np.linspace(1, 0, fade)
        if not np.any(np.abs(out) > 1e-3):
            raise RuntimeError(f"{what}: the re-pitched lead came out silent")
        return out

    def close(self):
        self.model = None
        self.f0x = None
        gc.collect()
        torch.cuda.empty_cache()
