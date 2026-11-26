"""Experiment (2026-11-26): Resemble Enhance (denoise, then enhance) on a recording.
Usage: .venv/bin/python run_resemble.py <in.wav> <out_dir>   -> denoised.wav, enhanced.wav (44.1 kHz)"""
import sys, types
# deepspeed is imported only for training (resemble_enhance/enhancer/train.py): a stand-in for that import.
def _stub(name, **attrs):
    m = types.ModuleType(name); m.__path__ = []  # a package, so submodules import
    for k, v in attrs.items(): setattr(m, k, v)
    sys.modules[name] = m
    return m
def _training_only(*a, **k):
    raise RuntimeError("deepspeed is not installed: training is not supported here")
class _TrainingOnly:
    def __init__(self, *a, **k): _training_only()
_stub("deepspeed", DeepSpeedConfig=_TrainingOnly, init_distributed=_training_only)
_stub("deepspeed.accelerator", get_accelerator=_training_only)
_stub("deepspeed.runtime")
_stub("deepspeed.runtime.engine", DeepSpeedEngine=_TrainingOnly)
_stub("deepspeed.runtime.utils", clip_grad_norm_=_training_only)
from pathlib import Path
import torch, torchaudio, soundfile as sf
from resemble_enhance.enhancer.inference import denoise, enhance
src, out = sys.argv[1], Path(sys.argv[2]); out.mkdir(parents=True, exist_ok=True)
x, sr = sf.read(src, always_2d=True); wav = torch.from_numpy(x.mean(1)).float()
d, sr_d = denoise(wav, sr, "cuda")
sf.write(out / "denoised.wav", d.cpu().numpy(), sr_d); print("denoised", sr_d, flush=True)
e, sr_e = enhance(wav, sr, "cuda", nfe=64, solver="midpoint", lambd=0.9, tau=0.5)
sf.write(out / "enhanced.wav", e.cpu().numpy(), sr_e); print("enhanced", sr_e, flush=True)
