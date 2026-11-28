"""Adapter: speech (spoken lines in described voices, Breeze TTS 2; the singers' speaking voices).

Two stages chosen by params["stage"]:
  lines           a list of lines, each spoken in a described voice with a fixed seed, sped up and compressed
                  (speech/pipeline/lines.py)
  speaking_voice  a singer's speaking voice: candidates from a description, the one closest to the singer's
                  reference kept (speech/pipeline/speaking_voice.py)
Breeze loads per job and is released after it (one shared GPU); `load` loads nothing heavy. Breeze's code, weights
and venv live in ~/breeze-tts-2 (speech/pipeline/paths.py, speech/README.md).
"""
from __future__ import annotations

import sys
from pathlib import Path

SERVICE_DIR = Path(__file__).resolve().parents[2] / "speech"
STAGES = ("lines", "speaking_voice")

MANIFEST = {
    "id": "speech",
    "label": "Speech (Breeze TTS 2)",
    "description": "Speaks lines in voices made from written descriptions (Breeze TTS 2) and matches speaking voices to singers.",
    "kind": "json",
    "category": "model",
    "python": "3.12",
    "venv": ".venv",
    # Breeze's own venv (its setup.sh), shared rather than rebuilt.
    "setup": [["ln", "-s", str(Path.home() / "breeze-tts-2" / ".venv"), ".venv"]],
    "setup_in_repo": False,
    "params": {},
}


def load(ctx):
    if str(SERVICE_DIR) not in sys.path:
        sys.path.insert(0, str(SERVICE_DIR))
    from pipeline import paths

    for p in (paths.BREEZE_CODE, paths.BREEZE_WEIGHTS):
        if not p.is_dir():
            raise SystemExit(f"speech: missing {p} (set up ~/breeze-tts-2 with its setup.sh)")
    if str(paths.BREEZE_CODE) not in sys.path:
        sys.path.append(str(paths.BREEZE_CODE))
    ctx.log("speech: ready (Breeze loads per job)")
    return {"service_dir": SERVICE_DIR}


def generate(handle, params, out_dir, job):
    stage = params.get("stage")
    if stage not in STAGES:
        raise ValueError(f"speech: unknown stage {stage!r}; expected one of {list(STAGES)}")
    if stage == "lines":
        from pipeline import lines as module
    else:
        from pipeline import speaking_voice as module
    return module.run(params, out_dir, job)
