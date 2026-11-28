# stable-audio

Stable Audio Open 1.0 (Stability AI) on the RTX: sound effects from text, used for the casting videos' applause
(`~/casperaki-data/casting-music/applause/`). `setup.sh` makes the venv (here, `.venv`, not in git) and downloads the
diffusers weights to `/mnt/d/casperaki-models/stabilityai__stable-audio-open-1.0` (gated: the Hugging Face account must
have accepted the licence). `generate.py <jobs.json>` renders a list of prompts to WAVs.

Licence: the Stability AI Community License: commercial use is allowed below its annual revenue threshold; above it an
enterprise licence is needed. Generated files are not kept in git.
