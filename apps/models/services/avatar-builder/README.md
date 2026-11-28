# avatar-builder

Model service (port 16517, harness adapter `avatar-builder`) that builds realistic avatars: MakeHuman people made in
Blender (MPFB 2.0.18) from a user's design, exported as VRM 1.0 files the video engine and the dressing room load.

`generate` with `{"stage": "build", "design": {...}}` → `person.vrm` and `build.json` (`bytes`, `images`, `probe`,
`credits`). About 7 s per person on datigator.

- `library.json`: the curated assets users may pick (skins, eyes, eyebrows, hair with colour variants, clothes with
  slot and the slots they also cover), each with licence (CC0 or CC-BY), author and credits. Made by
  `tools/make_library.py ~/apps/blender/downloads`, which leaves out assets known to be broken.
- `pipeline/design.py`: a design → MakeHuman's human description (body, ancestry, face sliders → targets, assets).
  Unknown ids and two garments for one slot are refused, naming them.
- `pipeline/blender_build.py` (runs inside Blender): the person, MPFB's export copy with Meta visemes and ARKit face
  units, the lip colour and hair tint baked into the textures, textures reduced (skin 2048, teeth/eyes/brows/lashes
  512, rest 1024), unused shape keys removed, VRM 1.0 humanoid bones and expressions, export.
- `pipeline/build.py`: runs Blender, then fixes the materials (hair, brows, lashes cut-outs; the rest solid) and stores
  solid textures as JPEG (`pipeline/gltf.py`).

Not in git: Blender (`~/apps/blender`, `BLENDER_BIN` names it, required), the add-ons and the packs
(`tools/setup_assets.sh` installs them from `~/apps/blender/downloads`).

Licences: MakeHuman's output is CC0; CC-BY assets must be credited (`build.json` `credits`).

Tests: `.venv/bin/python -m pytest tests -q -k "not blender"`; with real Blender:
`BLENDER_BIN=~/apps/blender/blender-4.5.17-linux-x64/blender .venv/bin/python -m pytest tests -q -k blender`.
