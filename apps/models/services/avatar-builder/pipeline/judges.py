"""The casting judges (judges.json: the owner's approved looks, 2026-11-28) as avatar-builder jobs.

A judge's spec is a MakeHuman description (phenotype, raw face targets, asset paths), not a user's design: built the
same real-time way (game-engine materials, Mixamo skeleton, low-poly eyes), with Love's lip colour and Ice's and
Bob's grey hair (hair_grey: the darkest and lightest grey, linear 0..1) baked into the textures.
"""
from __future__ import annotations

from .design import EYES_UUID
from .gltf import author_line


def _by_path(library: dict, kind: str, path: str) -> dict:
    for e in library[kind]:
        if e["path"] == path:
            return e
    raise ValueError(f'avatar-builder: the judge\'s {kind} "{path}" is not in the library')


def judge_job(judge_id: str, spec: dict, library: dict) -> tuple[dict, list[dict]]:
    """The Blender job for one judge, and the library assets it uses (for credits)."""
    assets = [_by_path(library, "skins", spec["skin"]), _by_path(library, "eyebrows", spec["eyebrows"]), _by_path(library, "hair", spec["hair"])]
    assets += [_by_path(library, "clothes", c) for c in spec["clothes"]]
    eye_materials = list(spec["materials"].values())
    if len(eye_materials) != 1:
        raise ValueError(f"avatar-builder: the judge {judge_id} must name exactly one eye material, got {eye_materials}")
    info = {
        "phenotype": spec["phenotype"],
        "skin_mhmat": spec["skin"], "skin_material_type": "GAMEENGINE",
        "eyes": "low-poly/low-poly.mhclo", "eyes_material_type": "GAMEENGINE",
        "eyebrows": spec["eyebrows"], "eyelashes": spec.get("eyelashes", "eyelashes01/eyelashes01.mhclo"), "teeth": "teeth_base/teeth_base.mhclo",
        "hair": spec["hair"], "clothes": spec["clothes"], "clothes_material_type": "GAMEENGINE",
        "alternative_materials": {EYES_UUID: eye_materials[0]}, "targets": spec.get("targets", []), "rig": "mixamo",
    }
    job = {"info": info, "name": judge_id.capitalize(), "author": author_line(assets), "hair": spec["hair"].split("/")[0],
           "lips": spec.get("lips"), "hairTint": None, "hairGrey": spec.get("hair_grey")}
    return job, assets
