"""Slow: builds a real person with Blender (BLENDER_BIN). Run with -k blender."""
import json
import os
import struct

import pytest

from pipeline.build import build

BLENDER = os.environ.get("BLENDER_BIN")
pytestmark = pytest.mark.skipif(not BLENDER, reason="BLENDER_BIN is not set (slow test with real Blender)")


def _gltf(path):
    d = open(path, "rb").read()
    n = struct.unpack("<I", d[12:16])[0]
    return json.loads(d[20:20 + n])


def test_blender_builds_a_vrm_with_tints(design, library, tmp_path):
    plain = build(design, library, tmp_path / "plain", BLENDER)
    tinted_design = {**design, "lips": "#9E0F1A", "hairTint": "#2A6BD8"}
    tinted = build(tinted_design, library, tmp_path / "tinted", BLENDER)
    for out in (plain, tinted):
        vrm = out["vrm"]
        assert os.path.getsize(vrm) < 15 * 1024 * 1024
        g = _gltf(vrm)
        presets = g["extensions"]["VRMC_vrm"]["expressions"]["preset"]
        for e in ("aa", "ih", "ou", "ee", "oh", "blink"):
            assert presets[e]["morphTargetBinds"], e
        modes = {m["name"]: m["alphaMode"] for m in g["materials"]}
        assert any("long01" in k and v == "MASK" for k, v in modes.items())
        assert max(max(i.get("width", 0), i.get("height", 0)) for i in out["images"]) <= 2048
    # The tints are in the textures: the lips' and hair's average colours moved toward red and blue.
    share = lambda rgb, i: rgb[i] / sum(rgb)
    assert share(tinted["probe"]["lips"], 0) > share(plain["probe"]["lips"], 0) + 0.1
    assert share(tinted["probe"]["hair"], 2) > share(plain["probe"]["hair"], 2) + 0.1
    assert tinted["credits"] and all({"name", "author", "licence"} <= set(c) for c in tinted["credits"])
