"""Adapter: vocals (sing a song's vocal arrangement in the background, then transcribe it back into the Vocal lane).

One service, three stages chosen by params["stage"]:
  lead        YuE2 sings each section's lead (checked by ChordNet against the song's chords)
  repeats     SoulX-Singer + voice conversion for repeated sections and backing vocals
  transcribe  a recording the user brings of one section transcribed into notes for its Vocal lane (Transcribe melody)
Models load per job inside the stage and are released after it (one GPU); `load` loads nothing heavy.
Code and weights are referenced by absolute path in vocals/pipeline/paths.py (see vocals/README.md).
"""
from __future__ import annotations

import sys
from pathlib import Path

SERVICE_DIR = Path(__file__).resolve().parents[2] / "vocals"
STAGES = ("lead", "repeats", "transcribe")

MANIFEST = {
    "id": "vocals",
    "label": "Vocals (sing and transcribe)",
    "description": "Sings a song's vocal arrangement (YuE2, SoulX-Singer, ChordNet, vocal separation) and transcribes it back.",
    "kind": "json",
    "category": "model",
    "python": "3.10",
    "venv": ".venv",
    "setup": [
        ["$UV", "venv", "--python", "3.10", ".venv"],
        ["$UV", "pip", "install", "--python", ".venv/bin/python", "--index-strategy", "unsafe-best-match",
         "-r", "requirements.txt"],
        ["$UV", "pip", "install", "--python", ".venv/bin/python", "--no-deps",
         "/mnt/d/casperaki-models/yue2/YuE2-3B/yue2_infer-0.1.5-py3-none-any.whl"],
        ["$UV", "pip", "install", "--python", ".venv/bin/python", "--no-deps", "-e",
         "/home/roli79/apps/casperaki/apps/models/services/heartmula/MuLaCover"],
    ],
    "setup_in_repo": False,
    "params": {},
}


def load(ctx):
    if str(SERVICE_DIR) not in sys.path:
        sys.path.insert(0, str(SERVICE_DIR))
    from pipeline import paths

    # SoulX-Singer (`import soulxsinger`) and BS-RoFormer (`models.bs_roformer`, `utils`) are code folders, not packages.
    for code in (paths.SOULX_REPO, paths.BS_ROFORMER_CODE):
        if not code.is_dir():
            raise SystemExit(f"vocals: missing code folder {code}")
        if str(code) not in sys.path:
            sys.path.append(str(code))
    ctx.log("vocals: ready (models load per job)")
    return {"service_dir": SERVICE_DIR}


def generate(handle, params, out_dir, job):
    stage = params.get("stage")
    if stage not in STAGES:
        raise ValueError(f"vocals: unknown stage {stage!r}; expected one of {list(STAGES)}")
    # Imported per stage so each stage's heavy imports load only when it runs.
    if stage == "lead":
        from pipeline import lead as module
    elif stage == "repeats":
        from pipeline import repeats as module
    else:
        from pipeline import transcribe as module
    return module.run(params, out_dir, job)
