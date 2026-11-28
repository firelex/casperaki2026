"""Where the speech service's code and weights are (absolute paths; nothing of them is in this repo).

Breeze TTS 2 (BreezeBlue/Breeze-TTS-2) lives in ~/breeze-tts-2 on datigator, set up by that folder's setup.sh:
code/ (the upstream inference code at its pinned commit, untouched), weights/, .venv/ (Python 3.12; this service's
venv links to it). Licence: research and non-commercial use only, for the model and everything it makes.
The speaker model (microsoft/wavlm-base-plus-sv) is fetched by tools/fetch_wavlm.py.
"""
from pathlib import Path

BREEZE_ROOT = Path.home() / "breeze-tts-2"
BREEZE_CODE = BREEZE_ROOT / "code"
BREEZE_WEIGHTS = BREEZE_ROOT / "weights"
WAVLM_SV = Path("/mnt/d/casperaki-models/microsoft__wavlm-base-plus-sv")
