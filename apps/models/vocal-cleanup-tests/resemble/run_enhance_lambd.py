"""Experiment: Resemble Enhance's enhancer at several denoising strengths (lambd); the default here was 0.9.
Usage: .venv/bin/python run_enhance_lambd.py <in.wav> <out_dir> <lambd> [<lambd> ...]"""
import sys, types
def _stub(name, **attrs):
    m = types.ModuleType(name); m.__path__ = []
    for k, v in attrs.items(): setattr(m, k, v)
    sys.modules[name] = m
def _training_only(*a, **k): raise RuntimeError("deepspeed is not installed: training is not supported here")
class _TrainingOnly:
    def __init__(self, *a, **k): _training_only()
_stub("deepspeed", DeepSpeedConfig=_TrainingOnly, init_distributed=_training_only)
_stub("deepspeed.accelerator", get_accelerator=_training_only)
_stub("deepspeed.runtime"); _stub("deepspeed.runtime.engine", DeepSpeedEngine=_TrainingOnly); _stub("deepspeed.runtime.utils", clip_grad_norm_=_training_only)
from pathlib import Path
import torch, soundfile as sf
from resemble_enhance.enhancer.inference import enhance
src, out = sys.argv[1], Path(sys.argv[2]); out.mkdir(parents=True, exist_ok=True)
x, sr = sf.read(src, always_2d=True); wav = torch.from_numpy(x.mean(1)).float()
for l in sys.argv[3:]:
    e, sr_e = enhance(wav, sr, "cuda", nfe=64, solver="midpoint", lambd=float(l), tau=0.5)
    sf.write(out / f"enhanced_lambd{l}.wav", e.cpu().numpy(), sr_e); print("lambd", l, "done", flush=True)
