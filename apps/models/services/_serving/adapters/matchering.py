"""Adapter: Matchering (sergree/matchering) — reference audio mastering.

Matchering is a pure-Python library (no GPU, no model weights): given a TARGET
track and a REFERENCE track, it masters the target to match the reference's
loudness, tonal balance and dynamics. It's an *app*, not a model — there's
nothing to download into a model folder — but it slots into the same serving
harness: load once, run a blocking `generate` per job.
"""
from __future__ import annotations

import base64
from pathlib import Path

CHECKPOINT_FOLDER = None  # no weights — pure DSP

MANIFEST = {
    "id": "matchering",
    "label": "Matchering",
    "description": "Master a track to match a reference's loudness, tone and dynamics.",
    "kind": "audio",
    # Not a model — surfaced under the Studio "Apps" section.
    "category": "app",
    "python": "3.12",
    # PyPI package, no repo to clone. Self-made venv + pip install.
    "venv": ".venv",
    "setup": [
        ["$UV", "venv", "--python", "3.12", ".venv"],
        ["$UV", "pip", "install", "--python", ".venv/bin/python", "matchering", "soundfile"],
    ],
    "params": {
        "target_audio": {"type": "string", "required": True, "description": "base64 track to master"},
        "target_filename": {"type": "string", "description": "original name (ext hint)"},
        "reference_audio": {"type": "string", "required": True, "description": "base64 reference master"},
        "reference_filename": {"type": "string", "description": "original name (ext hint)"},
        "bit_depth": {"type": "number", "default": 16, "enum": [16, 24]},
    },
}


def load(ctx):
    import matchering as mg

    # Route Matchering's verbose logging into the harness log. (matchering 2.x:
    # default_handler is the catch-all; there is no error_handler.)
    mg.log(default_handler=ctx.log, warning_handler=ctx.log, info_handler=ctx.log)
    return {"mg": mg}


def _write_input(out_dir: str, b64: str, filename: str | None, fallback: str) -> Path:
    suffix = Path(filename or fallback).suffix or ".wav"
    p = Path(out_dir) / f"{fallback}{suffix}"
    p.write_bytes(base64.b64decode(b64))
    return p


def generate(handle, params: dict, out_dir: str) -> dict:
    mg = handle["mg"]

    if not params.get("target_audio"):
        raise RuntimeError("Matchering needs a `target_audio` (base64)")
    if not params.get("reference_audio"):
        raise RuntimeError("Matchering needs a `reference_audio` (base64)")

    target = _write_input(out_dir, params["target_audio"], params.get("target_filename"), "target")
    reference = _write_input(out_dir, params["reference_audio"], params.get("reference_filename"), "reference")

    bit_depth = int(params.get("bit_depth", 16))
    out_path = Path(out_dir) / "mastered.wav"
    result = mg.pcm24(str(out_path)) if bit_depth == 24 else mg.pcm16(str(out_path))

    mg.process(target=str(target), reference=str(reference), results=[result])
    return {"file": str(out_path), "kind": "audio"}
