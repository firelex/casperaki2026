"""Downloads the speaker model (microsoft/wavlm-base-plus-sv) to pipeline.paths.WAVLM_SV. Run once, with the
service's venv: ~/breeze-tts-2/.venv/bin/python tools/fetch_wavlm.py"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from huggingface_hub import snapshot_download  # noqa: E402

from pipeline import paths  # noqa: E402

snapshot_download("microsoft/wavlm-base-plus-sv", local_dir=str(paths.WAVLM_SV))
print(f"saved {paths.WAVLM_SV}")
