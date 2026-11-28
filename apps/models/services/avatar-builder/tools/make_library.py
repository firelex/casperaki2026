"""Writes library.json, the curated list of MakeHuman assets users may pick, from the asset packs (zip files).

Usage: python3 tools/make_library.py <downloads dir> > library.json

Each asset: its id (folder name), a readable name, its MPFB asset path, its licence (from the pack: CC0 or CC-BY),
its author (the community prefix of the folder name; "MakeHuman" for the system assets) and, for clothes, its slot
and the slots it also covers. Hair styles list their colour variants (alternative materials). Assets known to be
broken or unsuitable are left out (EXCLUDE), with the reason.
"""
from __future__ import annotations

import json
import re
import sys
import zipfile
from pathlib import Path

EXCLUDE = {
    "toigo_stiletto_booties": "broken texture, renders as stumps",
    "dressupdoc_domsjeans1": "named jeans but is footwear",
}
SKIN_EXCLUDE = re.compile(r"genitals|toon|special_suit|hairless")
# Community clothes packs: the pack decides the slot.
PACK_SLOT = {"dress": ("dress", ["top", "bottoms"]), "pants": ("bottoms", []), "skirts": ("bottoms", []), "shirts": ("top", []),
             "shoes": ("shoes", []), "glasses": ("glasses", []), "suits": ("top", ["bottoms"])}


def system_slot(name: str) -> tuple[str, list[str]]:
    if name.startswith("shoes"):
        return "shoes", []
    if name.startswith("fedora"):
        return "hat", []
    if "suit" in name:
        return "top", ["bottoms"]
    raise SystemExit(f"make_library: no slot rule for the system garment {name!r}")


def readable(folder: str) -> str:
    parts = folder.split("_")
    if len(parts) > 1 and parts[0] not in {"male", "female", "young", "old", "middleage", "shoes", "long", "short"}:
        parts = parts[1:]  # the author prefix
    return " ".join(parts).replace("-", " ").capitalize()


def licence_of(zip_name: str) -> str:
    if "cc0" in zip_name:
        return "CC0"
    if re.search(r"cc-?by", zip_name):
        return "CC-BY"
    raise SystemExit(f"make_library: cannot tell the licence of {zip_name}")


def author_of(folder: str, system: bool) -> str:
    return "MakeHuman" if system else folder.split("_")[0]


def header_of(z: zipfile.ZipFile, member: str) -> dict:
    """The uuid (or None) and the credits a .mhclo/.mhmat names in its header: '# author x', and comment lines about
    an original model (CC-BY credits that must travel with the asset)."""
    out = {"uuid": None, "author": None, "credit": []}
    for line in z.read(member).decode("utf-8", "replace").splitlines():
        if line.startswith("uuid "):
            out["uuid"] = line.split()[1]
        elif line.startswith("# author "):
            out["author"] = line[9:].strip()
        elif line.startswith("#") and "original" in line.lower():
            out["credit"].append(line.lstrip("# ").strip())
    return out


def see_through(z: zipfile.ZipFile, folder: str) -> bool:
    """Whether an asset's material (the .mhmat files in its folder) is transparent: glasses' lenses, lace, fringes."""
    for m in z.namelist():
        if m.startswith(folder) and m.endswith(".mhmat"):
            for line in z.read(m).decode("utf-8", "replace").splitlines():
                if line.strip().lower() == "transparent true":
                    return True
    return False


def main(downloads: Path) -> dict:
    lib: dict[str, list] = {"skins": [], "hair": [], "eyebrows": [], "eyes": [], "clothes": []}
    zips = sorted(downloads.glob("*.zip")) + sorted((downloads / "community").glob("*.zip"))
    hair_colours: list[tuple[str, dict]] = []
    for zp in zips:
        if zp.name.startswith(("mpfb", "vrm", "visemes", "faceunits", "bodyparts", "eyelashes", "system_clothes_materials")):
            continue
        system = zp.name.startswith(("makehuman_system", "skins0", "system_hair"))
        lic = licence_of(zp.name)
        pack = re.sub(r"\d+_.*$", "", zp.name)
        with zipfile.ZipFile(zp) as z:
            for m in sorted(z.namelist()):
                p = m.split("/")
                if m.startswith("skins/") and m.endswith(".mhmat") and len(p) == 3:
                    if SKIN_EXCLUDE.search(p[1]):
                        continue
                    lib["skins"].append({"id": p[1], "name": readable(p[1]), "path": f"{p[1]}/{p[2]}", "licence": lic, "author": author_of(p[1], system)})
                elif m.startswith("eyes/materials/") and m.endswith(".mhmat"):
                    n = p[2][:-6]
                    lib["eyes"].append({"id": n, "name": n.capitalize(), "path": f"materials/{p[2]}", "licence": lic, "author": "MakeHuman"})
                elif m.startswith("eyebrows/") and m.endswith(".mhclo") and len(p) == 3:
                    lib["eyebrows"].append({"id": p[1], "name": readable(p[1]), "path": f"{p[1]}/{p[2]}", "licence": lic, "author": author_of(p[1], system)})
                elif m.startswith("hair/") and m.endswith(".mhclo") and len(p) == 3:
                    h = header_of(z, m)
                    lib["hair"].append({"id": p[1], "name": readable(p[1]), "path": f"{p[1]}/{p[2]}", "uuid": h["uuid"], "licence": lic,
                                        "author": h["author"] or author_of(p[1], system), "credit": h["credit"], "colours": []})
                elif m.startswith("hair/") and m.endswith(".mhmat") and len(p) == 4:
                    hair_colours.append((p[1], {"id": p[2], "name": p[2].split("_")[-1].replace("-", " ").capitalize(), "material": f"{p[2]}/{p[3]}", "licence": lic, "author": p[2].split("_")[0]}))
                elif m.startswith("clothes/") and m.endswith(".mhclo") and len(p) == 3:
                    if p[1] in EXCLUDE:
                        continue
                    slot, covers = system_slot(p[1]) if system else PACK_SLOT[pack]
                    h = header_of(z, m)
                    lib["clothes"].append({"id": p[1], "name": readable(p[1]), "path": f"{p[1]}/{p[2]}", "slot": slot, "covers": covers, "licence": lic,
                                           "author": h["author"] or author_of(p[1], system), "credit": h["credit"], "transparent": see_through(z, f"clothes/{p[1]}/")})
    styles = {h["id"]: h for h in lib["hair"]}
    for style, colour in hair_colours:
        if style not in styles:
            raise SystemExit(f"make_library: a colour {colour['id']} for the unknown hair style {style}")
        if styles[style]["uuid"] is None:
            raise SystemExit(f"make_library: the hair style {style} has colours but no uuid to give them by")
        styles[style]["colours"].append(colour)
    for k in lib:
        ids = [e["id"] for e in lib[k]]
        dup = {i for i in ids if ids.count(i) > 1}
        if dup:
            raise SystemExit(f"make_library: {k} ids twice: {sorted(dup)}")
        lib[k].sort(key=lambda e: e["id"])
    return lib


if __name__ == "__main__":
    json.dump(main(Path(sys.argv[1])), sys.stdout, indent=1)
    sys.stdout.write("\n")
