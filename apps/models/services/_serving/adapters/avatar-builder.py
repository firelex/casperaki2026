"""Adapter: avatar-builder (realistic avatars: MakeHuman people built in Blender as VRM 1.0 files).

One stage, params["stage"] == "build": params["design"] (a RealisticDesign, avatar-builder/pipeline/design.py) →
person.vrm and build.json (credits, sizes). Blender runs headless per job (BLENDER_BIN, required); MPFB, the VRM
add-on and the asset packs are installed into it by avatar-builder/tools/setup_assets.sh. See avatar-builder/README.md.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

SERVICE_DIR = Path(__file__).resolve().parents[2] / "avatar-builder"

MANIFEST = {
    "id": "avatar-builder",
    "label": "Avatar builder (MakeHuman in Blender)",
    "description": "Builds realistic avatars (MakeHuman people, CC0/CC-BY assets) as VRM 1.0 files with mouth shapes.",
    "kind": "json",
    "category": "app",
    "python": "3.12",
    "venv": ".venv",
    "setup": [
        ["$UV", "venv", "--python", "3.12", ".venv"],
        ["$UV", "pip", "install", "--python", ".venv/bin/python", "pillow", "pytest"],
    ],
    "setup_in_repo": False,
    "params": {},
}


def load(ctx):
    blender = os.environ.get("BLENDER_BIN")
    if not blender or not Path(blender).is_file():
        raise SystemExit(f"avatar-builder: BLENDER_BIN must name the Blender program (got {blender!r})")
    if str(SERVICE_DIR) not in sys.path:
        sys.path.insert(0, str(SERVICE_DIR))
    library = json.loads((SERVICE_DIR / "library.json").read_text())
    ctx.log(f"avatar-builder: ready (Blender {blender}; library of {sum(len(v) for v in library.values())} assets)")
    return {"blender": blender, "library": library}


def generate(handle, params, out_dir, job):
    if params.get("stage") != "build":
        raise ValueError(f"avatar-builder: unknown stage {params.get('stage')!r}; expected 'build'")
    design = params.get("design")
    if not isinstance(design, dict):
        raise ValueError("avatar-builder: params.design must be a design object")
    from pipeline.build import build

    step = job.step("build", "Building the person") if job else None
    try:
        result = build(design, handle["library"], Path(out_dir), handle["blender"])
    except Exception as err:
        if step:
            step.fail(str(err))
        raise
    if step:
        step.done(f"{result['bytes'] / 1e6:.1f} MB", {"bytes": result["bytes"]}, ["person.vrm", "build.json"])
    return {"file": str(Path(out_dir) / "build.json"), "kind": "json"}
