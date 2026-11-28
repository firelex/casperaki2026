#!/bin/sh
# Sets up Stable Audio Open 1.0 (sound effects from text) on the RTX: a Python 3.12 venv here (.venv, not in git; on the
# Linux disk, as venvs on /mnt/d do not run), PyTorch for Blackwell (cu128), diffusers; the weights (the diffusers
# folders only) in /mnt/d/casperaki-models/stabilityai__stable-audio-open-1.0. The model is gated: the Hugging Face
# token (~/.cache/huggingface/token) must belong to an account that accepted its licence.
set -eu
cd "$(dirname "$0")"
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python torch torchaudio --index-url https://download.pytorch.org/whl/cu128
uv pip install --python .venv/bin/python diffusers transformers accelerate soundfile sentencepiece
HF_TOKEN="$(cat "$HOME/.cache/huggingface/token")" .venv/bin/python - <<'PY'
import os
from huggingface_hub import snapshot_download
snapshot_download("stabilityai/stable-audio-open-1.0", local_dir="/mnt/d/casperaki-models/stabilityai__stable-audio-open-1.0",
                  token=os.environ["HF_TOKEN"], ignore_patterns=["model.ckpt", "model.safetensors", "*.csv"])
PY
echo "stable-audio: ready"
