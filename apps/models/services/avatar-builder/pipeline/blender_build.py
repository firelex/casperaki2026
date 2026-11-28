# Runs inside Blender: blender -b --python blender_build.py -- <job.json> <out.vrm> <report.json>
# Builds the MakeHuman person the job describes (pipeline/design.py made its human description), bakes the lip colour
# and hair tint into the textures, reduces the textures, and exports a VRM 1.0 with mouth shapes. Fails loudly.
import json
import os
import sys

import bpy
import numpy as np
from bl_ext.user_default.mpfb.services import HumanService
from bl_ext.user_default.mpfb.ui.operations.exportops.exportopspanel import EXPORTOPS_PROPERTIES

job_path, out_vrm, report_path = sys.argv[sys.argv.index("--") + 1:]
job = json.load(open(job_path))

EXPRESSIONS = {
    "aa": ["viseme_aa"], "ih": ["viseme_I"], "ou": ["viseme_U"], "ee": ["viseme_E"], "oh": ["viseme_O"],
    "blink": ["eyeBlinkLeft", "eyeBlinkRight"], "happy": ["mouthSmileLeft", "mouthSmileRight", "cheekSquintLeft", "cheekSquintRight"],
    "relaxed": ["mouthSmileLeft", "mouthSmileRight"], "surprised": ["eyeWideLeft", "eyeWideRight", "browInnerUp", "jawOpen"],
}
LIPS_MASK = os.path.expanduser("~/.config/blender/4.5/extensions/user_default/mpfb/data/textures/mpfb_lips.jpg")
BODY_MAX, PART_MAX, SMALL_MAX = 2048, 1024, 512
SMALL_WORDS = ("teeth", "eye", "brow", "lash")


def fail(msg):
    raise SystemExit(f"avatar-builder (Blender): {msg}")


def srgb_to_linear(hex_rgb):
    c = np.array([int(hex_rgb[i:i + 2], 16) / 255 for i in (1, 3, 5)])
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def base_image(obj):
    """The image feeding the base colour of the object's (game engine) material."""
    for slot in obj.material_slots:
        m = slot.material
        if m and m.use_nodes:
            for n in m.node_tree.nodes:
                if n.type == "TEX_IMAGE" and n.image and any(l.to_socket.name in ("Base Color", "Color") for o in n.outputs for l in o.links):
                    return n.image
    fail(f"the object {obj.name} has no base colour image")


def pixels(img):
    a = np.empty(img.size[0] * img.size[1] * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(img.size[1], img.size[0], 4)


def put(img, arr):
    img.pixels.foreach_set(arr.astype(np.float32).ravel())
    img.update()
    img.pack()


def lum(rgb):
    return rgb @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)


def lips_mask(w, h):
    m = bpy.data.images.load(LIPS_MASK)
    m.colorspace_settings.name = "Non-Color"
    if tuple(m.size) != (w, h):
        m.scale(w, h)
    return np.clip(pixels(m)[..., 0] * 2.5, 0, 1)  # strengthened at the edges, as the judges' lips


# ---- the person
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)
info = HumanService._create_default_human_info_dict()
info.update(job["info"])
settings = HumanService.get_default_deserialization_settings()
settings["subdiv_levels"] = 0
basemesh = HumanService.deserialize_from_dict(info, settings)
if basemesh is None:
    fail("MakeHuman built no body")

# ---- the export copy: helpers removed, modelling shape keys baked, visemes and face units added
scene = bpy.context.scene
for k, v in {"visemes_meta": True, "visemes_microsoft": False, "faceunits_arkit": True, "interpolate": True, "delete_helpers": True,
             "bake_shapekeys": True, "mask_modifiers": "KEEP", "subdiv_modifiers": "REMOVE", "remove_basemesh": False}.items():
    EXPORTOPS_PROPERTIES.set_value(k, v, entity_reference=scene)
bpy.context.view_layer.objects.active = basemesh
basemesh.select_set(True)
if bpy.ops.mpfb.export_copy() != {"FINISHED"}:
    fail("the export copy failed")
copies = [o for o in bpy.data.objects if o.name.endswith("_export_copy")]
arm = next((o for o in copies if o.type == "ARMATURE"), None)
meshes = [o for o in copies if o.type == "MESH"]
if arm is None or not meshes:
    fail(f"the export copy has no armature or meshes: {[o.name for o in copies]}")
for o in list(bpy.data.objects):
    if o not in copies:
        bpy.data.objects.remove(o)
body = max(meshes, key=lambda o: len(o.data.vertices))
hair = next((o for o in meshes if job["hair"].lower() in o.name.lower()), None)
if hair is None:
    fail(f"no hair mesh for {job['hair']} among {[o.name for o in meshes]}")

# ---- tints baked into the textures
skin_img, hair_img = base_image(body), base_image(hair)
probe = {}
sk = pixels(skin_img)
mask = lips_mask(skin_img.size[0], skin_img.size[1])
if job.get("lips"):
    shade = lum(sk[..., :3]) / max(1e-4, float(lum(sk[..., :3])[mask > 0.5].mean()))
    lip = np.clip(srgb_to_linear(job["lips"])[None, None, :] * shade[..., None], 0, 1)
    a = (mask * 0.85)[..., None]
    sk[..., :3] = sk[..., :3] * (1 - a) + lip * a
    put(skin_img, sk)
probe["lips"] = sk[..., :3][mask > 0.5].mean(axis=0).tolist()
hp = pixels(hair_img)
if job.get("hairTint"):
    l = lum(hp[..., :3])
    solid = hp[..., 3] > 0.5
    shade = l / max(1e-4, float(l[solid].mean()))
    hp[..., :3] = np.clip(srgb_to_linear(job["hairTint"])[None, None, :] * shade[..., None], 0, 1)
    put(hair_img, hp)
probe["hair"] = hp[..., :3][hp[..., 3] > 0.5].mean(axis=0).tolist()

# ---- textures reduced (the body's skin to 2048; teeth, eyes, brows and lashes to 512; the rest to 1024)
images = []
for img in bpy.data.images:
    if img.size[0] == 0 or img.source not in ("FILE", "GENERATED") or img.users == 0:
        continue
    limit = BODY_MAX if img == skin_img else SMALL_MAX if any(w in img.name.lower() for w in SMALL_WORDS) else PART_MAX
    w, h = img.size
    if max(w, h) > limit:
        f = limit / max(w, h)
        img.scale(max(1, round(w * f)), max(1, round(h * f)))
        img.pack()
    images.append({"name": img.name, "width": img.size[0], "height": img.size[1]})

# ---- VRM 1.0: humanoid bones and expressions
ext = arm.data.vrm_addon_extension
ext.spec_version = "1.0"
vrm1 = ext.vrm1
vrm1.meta.vrm_name = job["name"]
if len(vrm1.meta.authors) == 0:
    vrm1.meta.authors.add()
vrm1.meta.authors[0].value = job["author"]
bpy.context.view_layer.objects.active = arm
if bpy.ops.vrm.assign_vrm1_humanoid_human_bones_automatically(armature_object_name=arm.name) != {"FINISHED"}:
    fail("automatic bone assignment failed")
hb = vrm1.humanoid.human_bones
for b in ("hips", "spine", "chest", "neck", "head", "left_upper_arm", "right_upper_arm", "left_upper_leg", "right_upper_leg", "left_hand", "right_hand"):
    if not getattr(hb, b).node.bone_name:
        fail(f"the humanoid bone {b} was not assigned")
for exp, names in EXPRESSIONS.items():
    e = getattr(vrm1.expressions.preset, exp)
    for n in names:
        holders = [m for m in meshes if m.data.shape_keys and n in m.data.shape_keys.key_blocks]
        if not holders:
            fail(f"no mesh has the shape key {n} for the expression {exp}")
        for m in holders:
            bind = e.morph_target_binds.add()
            bind.node.mesh_object_name = m.name
            bind.index = n
            bind.weight = 1.0
# Only the shapes the expressions use are kept (MakeHuman's full face-unit set is most of the file's size).
used = {n for names in EXPRESSIONS.values() for n in names}
for m in meshes:
    keys = m.data.shape_keys
    if not keys:
        continue
    for kb in list(keys.key_blocks)[1:]:
        if kb.name not in used:
            m.shape_key_remove(kb)
for o in bpy.data.objects:
    o.select_set(True)
if bpy.ops.export_scene.vrm(filepath=out_vrm, export_invisibles=False, export_only_selections=False) != {"FINISHED"}:
    fail("the VRM export failed")
json.dump({"images": images, "probe": probe}, open(report_path, "w"))
print("avatar-builder: wrote", out_vrm, os.path.getsize(out_vrm) // 1024, "KB")
