from pipeline.gltf import author_line, fix_alpha


def test_cutouts_and_solids():
    g = {"materials": [{"name": "Human.long01", "alphaMode": "BLEND"}, {"name": "Human.eyebrow003", "alphaMode": "BLEND"},
                       {"name": "Human.eyelashes01", "alphaMode": "BLEND"}, {"name": "Human.body", "alphaMode": "BLEND"},
                       {"name": "Human.elvs_jeans_bootcut", "alphaMode": "BLEND", "alphaCutoff": 0.3}]}
    fix_alpha(g, hair_names=["long01"])
    modes = {m["name"]: (m["alphaMode"], m.get("alphaCutoff")) for m in g["materials"]}
    assert modes["Human.long01"] == ("MASK", 0.5)
    assert modes["Human.eyebrow003"] == ("MASK", 0.5)
    assert modes["Human.eyelashes01"] == ("MASK", 0.5)
    assert modes["Human.body"] == ("OPAQUE", None)
    assert modes["Human.elvs_jeans_bootcut"] == ("OPAQUE", None)


def test_author_line_names_cc_by_authors_once():
    assets = [{"licence": "CC0", "author": "MakeHuman"}, {"licence": "CC-BY", "author": "elvs"}, {"licence": "CC-BY", "author": "punkduck"},
              {"licence": "CC-BY", "author": "elvs"}]
    assert author_line(assets) == "Casperaki with MakeHuman; CC-BY assets by elvs, punkduck"
    assert author_line([{"licence": "CC0", "author": "MakeHuman"}]) == "Casperaki with MakeHuman (CC0)"


def _glb(gltf, binary):
    import json, struct
    js = json.dumps(gltf).encode(); js += b" " * ((4 - len(js) % 4) % 4)
    binary += b"\0" * ((4 - len(binary) % 4) % 4)
    body = struct.pack("<I", len(js)) + b"JSON" + js + struct.pack("<I", len(binary)) + b"BIN\0" + binary
    return b"glTF" + struct.pack("<II", 2, 12 + len(body)) + body


def test_solid_textures_become_jpeg_and_other_data_is_kept(tmp_path):
    import io, json, struct
    from PIL import Image
    from pipeline.gltf import jpeg_solid_textures
    png = io.BytesIO(); Image.new("RGBA", (64, 64), (200, 30, 30, 255)).save(png, "PNG"); png = png.getvalue()
    cut = io.BytesIO(); Image.new("RGBA", (8, 8), (0, 0, 0, 0)).save(cut, "PNG"); cut = cut.getvalue()
    other = bytes(range(40))
    binary = png + b"\0" * ((4 - len(png) % 4) % 4)
    o1 = len(binary); binary += cut + b"\0" * ((4 - len(cut) % 4) % 4)
    o2 = len(binary); binary += other
    gltf = {"buffers": [{"byteLength": len(binary)}],
            "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": len(png)}, {"buffer": 0, "byteOffset": o1, "byteLength": len(cut)},
                            {"buffer": 0, "byteOffset": o2, "byteLength": len(other)}],
            "images": [{"bufferView": 0, "mimeType": "image/png"}, {"bufferView": 1, "mimeType": "image/png"}],
            "textures": [{"source": 0}, {"source": 1}],
            "materials": [{"name": "body", "alphaMode": "OPAQUE", "pbrMetallicRoughness": {"baseColorTexture": {"index": 0}}},
                          {"name": "hair", "alphaMode": "MASK", "pbrMetallicRoughness": {"baseColorTexture": {"index": 1}}}]}
    p = tmp_path / "x.glb"; p.write_bytes(_glb(gltf, binary))
    jpeg_solid_textures(str(p))
    d = p.read_bytes(); n = struct.unpack("<I", d[12:16])[0]; g = json.loads(d[20:20 + n]); b = d[20 + n + 8:]
    assert struct.unpack("<I", d[8:12])[0] == len(d)
    assert [i["mimeType"] for i in g["images"]] == ["image/jpeg", "image/png"]
    v = g["bufferViews"]
    assert b[v[0]["byteOffset"]:v[0]["byteOffset"] + 2] == b"\xff\xd8"
    assert b[v[1]["byteOffset"]:v[1]["byteOffset"] + v[1]["byteLength"]] == cut
    assert b[v[2]["byteOffset"]:v[2]["byteOffset"] + v[2]["byteLength"]] == other
    assert all(x["byteOffset"] % 4 == 0 for x in v)
    assert len(b) - 3 <= g["buffers"][0]["byteLength"] <= len(b)
