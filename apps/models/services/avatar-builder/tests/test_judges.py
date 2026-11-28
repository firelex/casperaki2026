import json
from pathlib import Path

import pytest

from pipeline.design import EYES_UUID
from pipeline.judges import judge_job

JUDGES = json.loads((Path(__file__).resolve().parents[1] / "judges.json").read_text())


def test_the_four_approved_judges():
    assert sorted(JUDGES) == ["bob", "ice", "love", "nicky"]


def test_a_judge_becomes_a_real_time_person(library):
    job, assets = judge_job("love", JUDGES["love"], library)
    info = job["info"]
    assert info["rig"] == "mixamo"
    assert info["skin_material_type"] == info["clothes_material_type"] == info["eyes_material_type"] == "GAMEENGINE"
    assert info["eyes"] == "low-poly/low-poly.mhclo"
    assert info["alternative_materials"] == {EYES_UUID: "materials/blue.mhmat"}
    assert info["phenotype"]["weight"] == 0.32 and info["targets"] == JUDGES["love"]["targets"]
    assert job["lips"] == "#9E0F1A" and job["hairGrey"] is None and job["hair"] == "toigo_inverted_bob"
    assert {a["id"] for a in assets} >= {"punkduck_black_cocktail_dress", "toigo_inverted_bob"}


def test_grey_hair_is_baked(library):
    job, _ = judge_job("bob", JUDGES["bob"], library)
    assert job["hairGrey"] == [0.45, 0.92]


def test_an_asset_missing_from_the_library_is_named(library):
    spec = {**JUDGES["ice"], "hair": "nope/nope.mhclo"}
    with pytest.raises(ValueError, match='nope'):
        judge_job("ice", spec, library)
