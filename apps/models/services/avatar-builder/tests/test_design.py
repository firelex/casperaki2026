import pytest

from pipeline.design import age_slider, to_human_info


def test_body_and_ancestry(design, library):
    info = to_human_info(design, library)
    ph = info["phenotype"]
    assert ph["gender"] == 0.0 and ph["weight"] == 0.45 and ph["muscle"] == 0.5 and ph["proportions"] == 0.75
    assert ph["race"] == {"african": 0.0, "asian": 0.0, "caucasian": 1.0}
    assert "height" not in design["body"]
    assert info["rig"] == "mixamo"
    assert info["skin_material_type"] == info["clothes_material_type"] == info["eyes_material_type"] == "GAMEENGINE"


def test_assets_are_library_paths(design, library):
    info = to_human_info(design, library)
    assert info["hair"] == "long01/long01.mhclo"
    assert info["skin_mhmat"] == "young_caucasian_female/young_caucasian_female.mhmat"
    assert info["clothes"] == ["punkduck_sleeveless_crop_top/punkduck_sleeveless_crop_top.mhclo", "elvs_jeans_bootcut/elvs_jeans_bootcut.mhclo", "shoes02/shoes02.mhclo"]


def test_age():
    assert age_slider(25) == 0.5
    assert age_slider(90) == 1.0
    assert age_slider(18) == pytest.approx(0.1875 + (0.5 - 0.1875) * 7 / 14)  # MakeHuman: 11 y = 0.1875, 25 y = 0.5
    with pytest.raises(ValueError, match="age"):
        age_slider(17)


def test_face_sliders(design, library):
    design["face"]["noseWidth"] = -0.4
    design["face"]["lips"] = 0.6
    targets = {t["target"]: t["value"] for t in to_human_info(design, library)["targets"]}
    assert targets["nose-scale-horiz-decr"] == pytest.approx(0.4)
    assert targets["mouth-lowerlip-volume-incr"] == pytest.approx(0.6)
    assert targets["mouth-upperlip-volume-incr"] == pytest.approx(0.6)
    assert "nose-scale-horiz-incr" not in targets


def test_feminine_adds_a_set(design, library):
    design["face"]["feminine"] = 0.5
    targets = {t["target"]: t["value"] for t in to_human_info(design, library)["targets"]}
    assert targets["chin-width-decr"] > 0 and targets["head-oval"] > 0
    design["face"]["feminine"] = -0.5
    targets = {t["target"]: t["value"] for t in to_human_info(design, library)["targets"]}
    assert targets["chin-width-incr"] > 0


def test_hair_colour_is_an_alternative_material(design, library):
    design["hair"] = "ponytail01"
    design["hairColour"] = "dariush086_ponytail01_black"
    info = to_human_info(design, library)
    uuid = next(h["uuid"] for h in library["hair"] if h["id"] == "ponytail01")
    assert info["alternative_materials"][uuid] == "dariush086_ponytail01_black/dariush086_ponytail01_black.mhmat"


def test_eye_colour_is_an_alternative_material(design, library):
    from pipeline.design import EYES_UUID
    assert to_human_info(design, library)["alternative_materials"][EYES_UUID] == "materials/green.mhmat"


@pytest.mark.parametrize("field,value,kind", [("hair", "nope", "hair"), ("skin", "nope", "skin"), ("eyes", "nope", "eyes"), ("eyebrows", "nope", "eyebrows")])
def test_unknown_asset_is_named(design, library, field, value, kind):
    design[field] = value
    with pytest.raises(ValueError, match=f'no {kind} "nope"'):
        to_human_info(design, library)


def test_unknown_garment_is_named(design, library):
    design["clothes"].append("nope")
    with pytest.raises(ValueError, match='no clothes "nope"'):
        to_human_info(design, library)


def test_two_garments_for_one_slot_are_refused(design, library):
    design["clothes"].append("male_casualsuit04")  # a suit covers top and bottoms
    with pytest.raises(ValueError, match="male_casualsuit04.*(punkduck_sleeveless_crop_top|elvs_jeans_bootcut)|(punkduck_sleeveless_crop_top|elvs_jeans_bootcut).*male_casualsuit04"):
        to_human_info(design, library)


def test_ancestry_must_sum_to_one(design, library):
    design["ancestry"] = {"african": 0.5, "asian": 0.0, "european": 0.2}
    with pytest.raises(ValueError, match="ancestry"):
        to_human_info(design, library)
