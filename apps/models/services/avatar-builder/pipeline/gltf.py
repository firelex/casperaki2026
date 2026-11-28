"""Fixes to the glTF JSON inside an exported VRM, and the VRM's author line."""
from __future__ import annotations

import json
import struct

# Drawn or not per pixel (cut-outs); everything else is solid. The VRM exporter makes every MakeHuman material
# alpha-blended, which a real-time renderer cannot sort: hair vanishes, lashes turn into dark patches.
CUTOUT_WORDS = ("hair", "eyebrow", "eyelash")


def fix_alpha(gltf: dict, hair_names: list[str]) -> None:
    for m in gltf.get("materials", []):
        name = m["name"].lower()
        if any(w in name for w in CUTOUT_WORDS) or any(h.lower() in name for h in hair_names):
            m["alphaMode"] = "MASK"
            m["alphaCutoff"] = 0.5
        else:
            m["alphaMode"] = "OPAQUE"
            m.pop("alphaCutoff", None)


def author_line(assets: list[dict]) -> str:
    by = []
    for a in assets:
        if a["licence"] == "CC-BY" and a["author"] not in by:
            by.append(a["author"])
    return f"Casperaki with MakeHuman; CC-BY assets by {', '.join(by)}" if by else "Casperaki with MakeHuman (CC0)"


def rewrite_glb_json(path: str, change) -> None:
    """Reads a .glb/.vrm file, lets `change(gltf_json)` edit its JSON chunk, and writes it back (binary chunk kept)."""
    data = bytearray(open(path, "rb").read())
    if data[:4] != b"glTF":
        raise ValueError(f"avatar-builder: {path} is not a binary glTF file")
    n = struct.unpack("<I", data[12:16])[0]
    gltf = json.loads(data[20:20 + n])
    change(gltf)
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * ((4 - len(js) % 4) % 4)
    out = data[:12] + struct.pack("<I", len(js)) + data[16:20] + js + data[20 + n:]
    out[8:12] = struct.pack("<I", len(out))
    open(path, "wb").write(out)


def jpeg_solid_textures(path: str, quality: int = 88) -> None:
    """Re-encodes, as JPEG, every PNG image used only by solid (OPAQUE) materials; images a cut-out material uses keep
    their transparency (PNG). Rebuilds the binary chunk with every buffer view kept, 4-byte aligned."""
    import io

    from PIL import Image

    data = open(path, "rb").read()
    n = struct.unpack("<I", data[12:16])[0]
    gltf = json.loads(data[20:20 + n])
    bin_start = 20 + n
    bin_len = struct.unpack("<I", data[bin_start:bin_start + 4])[0]
    binary = data[bin_start + 8:bin_start + 8 + bin_len]
    if len(gltf.get("buffers", [])) != 1:
        raise ValueError(f"avatar-builder: {path} has {len(gltf.get('buffers', []))} buffers; expected one")
    tex_source = [t["source"] for t in gltf.get("textures", [])]
    cutout_images: set[int] = set()
    for m in gltf.get("materials", []):
        if m.get("alphaMode", "OPAQUE") != "OPAQUE":
            for ref in _texture_refs(m):
                cutout_images.add(tex_source[ref])
    views = gltf["bufferViews"]
    chunks = [binary[v.get("byteOffset", 0):v.get("byteOffset", 0) + v["byteLength"]] for v in views]
    for i, img in enumerate(gltf.get("images", [])):
        if img.get("mimeType") != "image/png" or i in cutout_images:
            continue
        pic = Image.open(io.BytesIO(chunks[img["bufferView"]])).convert("RGB")
        out = io.BytesIO()
        pic.save(out, "JPEG", quality=quality)
        chunks[img["bufferView"]] = out.getvalue()
        img["mimeType"] = "image/jpeg"
    new = bytearray()
    for v, c in zip(views, chunks):
        new += b"\0" * ((4 - len(new) % 4) % 4)
        v["byteOffset"] = len(new)
        v["byteLength"] = len(c)
        new += c
    gltf["buffers"][0]["byteLength"] = len(new)
    new += b"\0" * ((4 - len(new) % 4) % 4)
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * ((4 - len(js) % 4) % 4)
    body = struct.pack("<I", len(js)) + b"JSON" + js + struct.pack("<I", len(new)) + b"BIN\0" + bytes(new)
    open(path, "wb").write(b"glTF" + struct.pack("<II", 2, 12 + len(body)) + body)


def _texture_refs(material: dict) -> list[int]:
    """Every texture index a material refers to (any '...Texture': {'index'} anywhere in it, extensions included)."""
    out: list[int] = []

    def walk(x):
        if isinstance(x, dict):
            if "index" in x and isinstance(x["index"], int) and ("texCoord" in x or len(x) <= 3):
                out.append(x["index"])
            for k, v in x.items():
                if k.endswith("Texture") or isinstance(v, (dict, list)):
                    walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)

    walk(material)
    return out
