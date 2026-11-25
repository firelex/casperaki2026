# svc-vocals

Model service (port 16514, harness adapter `vocals`) that sings a song's vocal arrangement in the background and
transcribes it back into the Vocal lane. `generate` dispatches on `params["stage"]`:

- `lead`: YuE2 sings each section, ChordNet checks it against the song's chords
- `repeats`: SoulX-Singer (+ voice conversion) for repeated sections and backing vocals
- `transcribe`: a recording the user brings of one section (Transcribe melody): BS-RoFormer separation only when `has_backing`; with a `count` (the section has written lyrics) the notes by count as the lead stage finds them, without one only the voice for the brain to send to the hum service (see pipeline/transcribe.py)

One venv (`.venv`, Python 3.10, torch 2.10.0+cu128 for the RTX PRO 6000 Blackwell, sm_120) on the Linux disk;
weights stay on /mnt/d. Models load per job and are released after each stage (one GPU).

## Environment

The harness builds the venv from the adapter's manifest on first start. By hand:

    cd apps/models/services/vocals
    uv venv --python 3.10 .venv
    uv pip install --python .venv/bin/python --index-strategy unsafe-best-match -r requirements.txt
    uv pip install --python .venv/bin/python --no-deps /mnt/d/casperaki-models/yue2/YuE2-3B/yue2_infer-0.1.5-py3-none-any.whl
    uv pip install --python .venv/bin/python --no-deps -e <MuLaCover path below>

Version notes: `yue2_infer` pins `numpy==2.2.6` and `accelerate==1.13.0`, while MuLaCover's metadata pins
`numpy==2.0.2` and `accelerate==1.12.0`; we install both with `--no-deps` and use the yue2 versions. SoulX-Singer's
own requirements ask for older pins (numpy<2, transformers 4.41.2, torch 2.2); the newer ones are used here.
SoulX's
decoder layer was written for transformers 4.41.2; `pipeline/soulx_compat.py` patches it for 4.57.6 (checked equal on
one layer, tests/test_soulx_compat.py). torchaudio 2.10 decodes files through TorchCodec (`torchcodec==0.10.0`, needs
the system FFmpeg 4-7 libraries).

## Code and weights (absolute paths, all in `pipeline/paths.py`)

Code (untracked folders in the shared tree `/home/roli79/apps/casperaki`, read-only here). They exist only on
datigator, so this is how to make them again: each is a plain `git clone` of its upstream, checked out at the commit
below, with no local changes (checked 2026-11-25 with `git status`; our fixes live in `pipeline/`, e.g.
`soulx_compat.py`, never in the clones):

| folder (under `apps/models/services/`) | upstream | commit | used as |
|---|---|---|---|
| `soulx-singer/repo` | https://github.com/Soul-AILab/SoulX-Singer.git | `81aeb3ae772c70093c3de74dc23c92d983801ae4` | on `sys.path` (`import soulxsinger`) |
| `bs-roformer` | https://github.com/ZFTurbo/Music-Source-Separation-Training.git | `1523206d12a521bdb20673726562524cf0f9635b` | on `sys.path` (`models.bs_roformer`, `utils`) |
| `heartmula/MuLaCover` | https://github.com/HeartMuLa/MuLaCover.git | `78f16a370beb6679c74d2a2b53f754f7b419e8a9` | editable install (`import mulacover`, ChordNet) |

To make one again: `git clone <upstream> <folder> && git -C <folder> checkout <commit>`. (`heartmula/heartlib`,
https://github.com/HeartMuLa/heartlib.git at `164788308875289016d2f7ab46dba7f77a649cf8`, sits next to MuLaCover but
this service does not use it.)

Weights (/mnt/d/casperaki-models):
- `yue2/YuE2-3B` (model and `yue2_infer` wheel), `yue2/YuE2-Vae`
- `Soul-AILab__SoulX-Singer/{model.pt,model-svc.pt}`, `Soul-AILab__SoulX-Singer-Preprocess/rmvpe/rmvpe.pt`
- `heartmula/mulacover_root/SymbolicTranscriptor/chord` (ChordNet checkpoints)
- `viperx__bs-roformer-ep317-sdr12.9755`

## Licences

- YuE2 (m-a-p/YuE2-3B): CC BY-NC 4.0. Credit (exact text), shown on the home page (ProjectsPage) and in exports'
  metadata, never on the song page:
  `Vocals sung with YuE2 (m-a-p/YuE2-3B, https://huggingface.co/m-a-p/YuE2-3B), CC BY-NC 4.0`
- MuLaCover (ChordNet): CC BY-NC 4.0 (code Apache-2.0; see its LICENSING.md and MODEL_LICENSE).
- SoulX-Singer: Apache-2.0.

## Run

    cd apps/models/services/_serving
    python3 harness.py --adapter vocals --port 16514 --models-dir /mnt/d/casperaki-models
    curl localhost:16514/health

## Deploy checklist (datigator)

Deploys are the owner's (`deploy/datigator/deploy.sh`); this is what Sing and Transcribe melody need on top:

1. **The clones above** exist in the shared tree at those commits (`pipeline/paths.py` points there).
2. **The vocals venv**, built once in the deployed tree before svc-vocals first starts:
   `apps/models/services/vocals/.venv`, by the harness on first start or by hand as in "Environment" above. Not in
   git; a fresh checkout has none.
3. **brain.env** (`~/.config/casperaki/brain.env`, outside the repo) has:
   - `VOCALS_SERVICE_URL=http://127.0.0.1:16514`
   - `BRAIN_TASK_FILES_DIR=<a folder for each task's step files>` (Sing and Transcribe melody)
   - `BRAIN_VOCAL_TAKES_DIR=<a folder for the stored takes, <sha256>.ogg>` (Sing, playback and renders)
   - `HUM_SERVICE_URL` (Transcribe melody of a section without written lyrics)

   Without the first three the brain refuses Sing ("Sing is not set up: …").
4. **svc-vocals runs** on port 16514 (see "Run"), and is **restarted after every change under `pipeline/`**: the
   harness imports the pipeline once at start, so a pull alone changes nothing.
5. **The packages are built** (`packages/song-schema`, `packages/arrangement`, `packages/engine-adapter`; the brain and
   the lowering read their `dist/`): `deploy.sh` does this (`pnpm -r --filter "./packages/*" build`); never by hand
   in the shared tree.
6. Restart the brain (deploy.sh does) so it reads brain.env.

