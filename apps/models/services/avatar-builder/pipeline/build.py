"""Builds one realistic avatar: runs Blender headless on pipeline/blender_build.py, then fixes the VRM's materials.

build(design, library, out_dir, blender) → {"vrm", "images", "probe", "credits"}; writes out_dir/person.vrm and
out_dir/build.json. Raises naming what failed (a bad design, Blender's own error, a missing output).
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from .design import chosen_assets, to_human_info
from .gltf import author_line, fix_alpha, jpeg_solid_textures, rewrite_glb_json

HERE = Path(__file__).resolve().parent
BLENDER_TIMEOUT_S = 600


def build(design: dict, library: dict, out_dir: Path, blender: str, log=print) -> dict:
    """A user's design (pipeline/design.py) as a person."""
    info = to_human_info(design, library)
    assets = chosen_assets(design, library)
    job = {"info": info, "name": "Casperaki avatar", "author": author_line(assets), "hair": design["hair"],
           "lips": design.get("lips"), "hairTint": design.get("hairTint"), "hairGrey": None}
    return run_job(job, assets, out_dir, blender, log)


def run_job(job: dict, assets: list[dict], out_dir: Path, blender: str, log=print) -> dict:
    """Runs Blender on a job (blender_build.py) and fixes the VRM it writes; `assets` are the library entries used."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    hair_id = job["hair"]
    job_path, vrm, report = out_dir / "job.json", out_dir / "person.vrm", out_dir / "blender-report.json"
    job_path.write_text(json.dumps(job))
    for p in (vrm, report):
        p.unlink(missing_ok=True)
    log(f"avatar-builder: Blender is building {job['name']}")
    r = subprocess.run([blender, "-b", "--python-exit-code", "1", "--python", str(HERE / "blender_build.py"), "--", str(job_path), str(vrm), str(report)],
                       capture_output=True, text=True, timeout=BLENDER_TIMEOUT_S)
    (out_dir / "blender.log").write_text(r.stdout + r.stderr)
    if r.returncode != 0 or not vrm.is_file() or not report.is_file():
        tail = "\n".join((r.stdout + r.stderr).strip().splitlines()[-8:])
        raise RuntimeError(f"avatar-builder: Blender failed (exit {r.returncode}):\n{tail}")
    garments = [a for a in assets if "slot" in a]
    see_through = [g["id"] for g in garments if g.get("transparent") and g["slot"] == "glasses"]
    cutouts = [hair_id] + [g["id"] for g in garments if g.get("transparent") and g["slot"] != "glasses"]
    rewrite_glb_json(str(vrm), lambda g: fix_alpha(g, cutouts=cutouts, see_through=see_through))
    jpeg_solid_textures(str(vrm))
    rep = json.loads(report.read_text())
    credits = [{"name": a.get("name", a["id"]), "author": a["author"], "licence": a["licence"], **({"credit": a["credit"]} if a.get("credit") else {})} for a in assets]
    result = {"vrm": str(vrm), "bytes": vrm.stat().st_size, "images": rep["images"], "probe": rep["probe"], "credits": credits}
    (out_dir / "build.json").write_text(json.dumps(result, indent=1))
    return result
