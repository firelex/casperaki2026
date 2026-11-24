# Model services — what's tracked vs. what to download

This repo tracks only the **Casperaki serving glue** — it does **not** track the
vendored upstream model repos, their weights/checkpoints, or the Python
virtualenvs (all multi-GB and re-fetchable). After cloning, reconstruct each
service from the sources below.

## Tracked here (hand-written)
- `_serving/` — the serving harness: `harness.py`, `adapter_common.py`,
  `adapters/{ace-step,sam-audio,matchering}.py`.
- each service's `smoke_test.py` and small configs.

## Ignored (re-fetch — see `.gitignore`)
Vendored upstream clones, `**/.checkpoints/`, `**/checkpoints/`, model weights
(`*.safetensors *.pth *.ckpt *.pt *.onnx *.gguf`), `**/.venv/`, `*/outputs/`,
`_serving/run/`, generated `*.wav`.

## Per-service setup

For each service: clone the upstream into the path shown, create the venv, then
download the weights. Keep **venvs on the Linux fs** and **weights on `/mnt/d`**
(symlink/point the checkpoint dirs there) — DrvFs breaks venv exec and weights are
huge (see project notes).

### ace-step  → `ace-step/`
```
git clone https://github.com/ace-step/ACE-Step-1.5.git ace-step
```
Weights go in `ace-step/checkpoints/` (per that repo's `checkpoints/README.md`):
`acestep-v15-turbo/`, `acestep-5Hz-lm-1.7B/`, `Qwen3-Embedding-0.6B/`, `vae/`
(HuggingFace — the ACE-Step model card). sm_120 (Blackwell) needs cu128+ torch and
an explicit `HF_TOKEN` export.

### demucs  → `demucs/`
```
git clone https://github.com/adefossez/demucs.git demucs
```
Weights are pulled automatically by demucs (torch hub) on first run.

### sam-audio  → `sam-audio/repo/`  (+ `sam-audio/.checkpoints/`)
```
git clone https://github.com/facebookresearch/sam-audio.git sam-audio/repo
mkdir -p sam-audio/.checkpoints
curl -L -o sam-audio/.checkpoints/imagebind_huge.pth \
  https://dl.fbaipublicfiles.com/imagebind/imagebind_huge.pth
```
(`.checkpoints/imagebind_huge.pth` at the `services/` root is the same file — symlink it.)

### liveact  → `liveact/`
```
git clone https://github.com/Soul-AILab/SoulX-LiveAct.git liveact
```
Weights per the SoulX-LiveAct README (HuggingFace).

### matchering
Pip-installed (no upstream clone); the adapter is `_serving/adapters/matchering.py`.
Only its venv/outputs live under `matchering/`.
