"""Builds the casting judges (judges.json) as VRM files for the video engine.

Usage: BLENDER_BIN=... .venv/bin/python tools/build_judges.py <out dir>   → <out dir>/<judge>.vrm and <judge>.json (credits)
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from pipeline.build import run_job  # noqa: E402
from pipeline.judges import judge_job  # noqa: E402


def main(out: Path) -> None:
    blender = os.environ.get("BLENDER_BIN")
    if not blender:
        raise SystemExit("build_judges: BLENDER_BIN must name the Blender program")
    library = json.loads((ROOT / "library.json").read_text())
    judges = json.loads((ROOT / "judges.json").read_text())
    out.mkdir(parents=True, exist_ok=True)
    for judge_id, spec in judges.items():
        job, assets = judge_job(judge_id, spec, library)
        with tempfile.TemporaryDirectory() as work:
            result = run_job(job, assets, Path(work), blender)
            shutil.copyfile(result["vrm"], out / f"{judge_id}.vrm")
        (out / f"{judge_id}.json").write_text(json.dumps({"name": job["name"], "credits": result["credits"]}, indent=1))
        print(f"{judge_id}: {result['bytes'] / 1e6:.1f} MB")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
