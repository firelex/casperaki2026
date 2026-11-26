"""Resemble Enhance's enhancer on a recording, as the vocals service's add-singer stage runs it (pipeline/add_singer.py).

Runs in Resemble Enhance's own venv (pipeline.paths.RESEMBLE_PYTHON), as a process of its own so its model is the
only one on the graphics card while it runs.
Usage: <resemble venv python> enhance_voice.py <in.wav> <out.wav>
(Not named resemble_enhance.py: as the script it would hide the package of that name.)
Settings: the enhancer at strength (lambd) 0.9, tau 0.5, 64 steps of the midpoint solver: what made the voice the
owner called "really good" (apps/models/vocal-cleanup-tests/resemble/run_resemble.py, 2026-11-26). The input should
be compressed first: the enhancer otherwise drops soft notes by 20-35 dB.
Writes the enhanced voice (mono, 44.1 kHz) and prints one JSON line: {"sample_rate", "seconds"}.
"""
import json
import sys
import types


def _stub(name, **attrs):
    m = types.ModuleType(name)
    m.__path__ = []  # a package, so submodules import
    for k, v in attrs.items():
        setattr(m, k, v)
    sys.modules[name] = m


def _training_only(*a, **k):
    raise RuntimeError("deepspeed is not installed: Resemble Enhance training is not supported here")


class _TrainingOnly:
    def __init__(self, *a, **k):
        _training_only()


# deepspeed is imported only for training (resemble_enhance/enhancer/train.py): stand-ins for that import.
_stub("deepspeed", DeepSpeedConfig=_TrainingOnly, init_distributed=_training_only)
_stub("deepspeed.accelerator", get_accelerator=_training_only)
_stub("deepspeed.runtime")
_stub("deepspeed.runtime.engine", DeepSpeedEngine=_TrainingOnly)
_stub("deepspeed.runtime.utils", clip_grad_norm_=_training_only)

LAMBD, TAU, NFE, SOLVER = 0.9, 0.5, 64, "midpoint"


def main(src: str, dest: str) -> None:
    import soundfile as sf
    import torch
    from resemble_enhance.enhancer.inference import enhance

    if not torch.cuda.is_available():
        raise SystemExit("enhance_voice: CUDA is not available")
    x, sr = sf.read(src, always_2d=True)
    wav = torch.from_numpy(x.mean(1)).float()
    y, sr_out = enhance(wav, sr, "cuda", nfe=NFE, solver=SOLVER, lambd=LAMBD, tau=TAU)
    y = y.cpu().numpy()
    sf.write(dest, y, sr_out, subtype="FLOAT")
    print(json.dumps({"sample_rate": int(sr_out), "seconds": round(len(y) / sr_out, 3)}), flush=True)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    main(*sys.argv[1:])
