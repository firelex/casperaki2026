"""A user's realistic avatar design → MakeHuman's (MPFB's) human description, checked against the curated library.

The design (the brain's RealisticDesign, same fields): body sliders, an ancestry mix, nine face sliders (-1..1), the
skin, eyes, eyebrows, hair (+ an optional colour variant), tints, and the clothes. Unknown ids and two garments
for one slot raise ValueError naming them: nothing is replaced by a default.
"""
from __future__ import annotations

# Face sliders: positive values use the first target list, negative the second (each value scaled by the slider).
FACE = {
    "jawWidth": (["chin-width-incr"], ["chin-width-decr"]),
    "chin": (["chin-prominent-incr"], ["chin-prominent-decr"]),
    "noseWidth": (["nose-scale-horiz-incr"], ["nose-scale-horiz-decr"]),
    "noseLength": (["nose-scale-vert-incr"], ["nose-scale-vert-decr"]),
    "eyeSize": (["l-eye-scale-incr", "r-eye-scale-incr"], ["l-eye-scale-decr", "r-eye-scale-decr"]),
    "lips": (["mouth-lowerlip-volume-incr", "mouth-upperlip-volume-incr"], ["mouth-lowerlip-volume-decr", "mouth-upperlip-volume-decr"]),
    "cheekbones": (["l-cheek-bones-incr", "r-cheek-bones-incr"], ["l-cheek-bones-decr", "r-cheek-bones-decr"]),
    "browAngle": (["eyebrows-angle-up"], ["eyebrows-angle-down"]),
}
# "Feminine ↔ masculine": at +1 the set that made Love's face strongly feminine (judges-final.json); at -1 the opposite.
FEMININE = {"chin-width-decr": 0.9, "chin-prominent-decr": 0.6, "chin-jaw-drop-decr": 0.5, "head-oval": 0.6, "head-scale-horiz-decr": 0.25,
            "nose-scale-horiz-decr": 0.6, "nose-scale-vert-decr": 0.4, "l-eye-scale-incr": 0.6, "r-eye-scale-incr": 0.6,
            "mouth-lowerlip-volume-incr": 0.6, "mouth-upperlip-volume-incr": 0.6, "l-cheek-bones-incr": 0.6, "r-cheek-bones-incr": 0.6}
MASCULINE = {"chin-width-incr": 0.9, "chin-prominent-incr": 0.6, "chin-jaw-drop-incr": 0.5, "head-square": 0.6, "head-scale-horiz-incr": 0.25,
             "nose-scale-horiz-incr": 0.6, "nose-scale-vert-incr": 0.4, "eyebrows-angle-down": 0.3}
# The low-poly eyes every avatar wears (light for real time); its colour is an alternative material keyed by its uuid.
EYES_UUID = "1cc97a30-85a1-42e6-a9f7-b3e753732baa"
SLOTS = ("top", "bottoms", "dress", "shoes", "glasses", "hat")


def age_slider(years: float) -> float:
    """MakeHuman's age slider: 11 years = 0.1875, 25 = 0.5, 90 = 1.0, linear in between. Users are 18 to 90."""
    if not 18 <= years <= 90:
        raise ValueError(f"avatar-builder: age must be 18 to 90 years, got {years}")
    if years <= 25:
        return 0.1875 + (years - 11) / 14 * 0.3125
    return 0.5 + (years - 25) / 65 * 0.5


def _find(library: dict, kind: str, ident: str) -> dict:
    for e in library[kind]:
        if e["id"] == ident:
            return e
    raise ValueError(f'avatar-builder: no {"skin" if kind == "skins" else kind} "{ident}" in the library')


def chosen_assets(design: dict, library: dict) -> list[dict]:
    """Every library entry the design uses (for credits)."""
    out = [_find(library, "skins", design["skin"]), _find(library, "eyes", design["eyes"]), _find(library, "eyebrows", design["eyebrows"]),
           _find(library, "hair", design["hair"])]
    if design.get("hairColour"):
        hair = out[-1]
        colour = next((c for c in hair["colours"] if c["id"] == design["hairColour"]), None)
        if colour is None:
            raise ValueError(f'avatar-builder: the hair "{hair["id"]}" has no colour "{design["hairColour"]}"')
        out.append(colour)
    out += [_find(library, "clothes", c) for c in design["clothes"]]
    return out


def _check_slots(garments: list[dict]) -> None:
    taken: dict[str, str] = {}
    for g in garments:
        for slot in [g["slot"], *g["covers"]]:
            if slot in taken:
                raise ValueError(f'avatar-builder: "{taken[slot]}" and "{g["id"]}" both cover the {slot}; choose one')
            taken[slot] = g["id"]


def _targets(face: dict) -> list[dict]:
    values: dict[str, float] = {}
    for key, (up, down) in FACE.items():
        v = float(face[key])
        if not -1 <= v <= 1:
            raise ValueError(f"avatar-builder: the face slider {key} must be -1 to 1, got {v}")
        for t in (up if v > 0 else down if v < 0 else []):
            values[t] = values.get(t, 0) + abs(v)
    f = float(face["feminine"])
    if not -1 <= f <= 1:
        raise ValueError(f"avatar-builder: the face slider feminine must be -1 to 1, got {f}")
    for t, w in (FEMININE if f > 0 else MASCULINE if f < 0 else {}).items():
        values[t] = values.get(t, 0) + abs(f) * w
    return [{"target": t, "value": min(1.0, v)} for t, v in sorted(values.items())]


def to_human_info(design: dict, library: dict) -> dict:
    body, anc = design["body"], design["ancestry"]
    for k in ("gender", "weight", "muscle", "proportions"):
        if not 0 <= body[k] <= 1:
            raise ValueError(f"avatar-builder: {k} must be 0 to 1, got {body[k]}")
    if any(v < 0 for v in anc.values()) or abs(sum(anc.values()) - 1) > 0.01:
        raise ValueError(f"avatar-builder: the ancestry mix must be three shares summing to 1, got {anc}")
    assets = chosen_assets(design, library)
    garments = assets[-len(design["clothes"]):] if design["clothes"] else []
    _check_slots(garments)
    skin, eyes, brows, hair = assets[:4]
    alt = {EYES_UUID: eyes["path"]}
    if design.get("hairColour"):
        alt[hair["uuid"]] = assets[4]["material"]
    return {
        "phenotype": {"gender": body["gender"], "age": age_slider(body["age"]), "muscle": body["muscle"], "weight": body["weight"],
                      "height": 0.5, "proportions": body["proportions"], "cupsize": 0.5, "firmness": 0.5,
                      "race": {"african": anc["african"], "asian": anc["asian"], "caucasian": anc["european"]}},
        "skin_mhmat": skin["path"], "skin_material_type": "GAMEENGINE",
        "eyes": "low-poly/low-poly.mhclo", "eyes_material_type": "GAMEENGINE",
        "eyebrows": brows["path"], "eyelashes": "eyelashes01/eyelashes01.mhclo", "teeth": "teeth_base/teeth_base.mhclo",
        "hair": hair["path"], "clothes": [g["path"] for g in garments], "clothes_material_type": "GAMEENGINE",
        "alternative_materials": alt, "targets": _targets(design["face"]), "rig": "mixamo",
    }
