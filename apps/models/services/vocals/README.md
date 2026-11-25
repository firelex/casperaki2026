# svc-vocals

Model service (port 16514, harness adapter `vocals`) that sings a song's vocal arrangement in the background and
transcribes it back into the Vocal lane. `generate` dispatches on `params["stage"]`:

- `lead`: YuE2 sings each section, ChordNet checks it against the song's chords
- `repeats`: SoulX-Singer (+ voice conversion) for repeated sections and backing vocals
- `transcribe`: the sung result transcribed back into notes

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

## Code and weights (absolute paths, all in `pipeline/paths.py`)

Code (untracked folders in the shared tree `/home/roli79/apps/casperaki`, read-only here):
- SoulX-Singer repo: `apps/models/services/soulx-singer/repo` (on `sys.path`)
- BS-RoFormer code: `apps/models/services/bs-roformer` (on `sys.path`)
- MuLaCover (ChordNet): `apps/models/services/heartmula/MuLaCover` (editable install)

Weights (/mnt/d/casperaki-models):
- `yue2/YuE2-3B` (model and `yue2_infer` wheel), `yue2/YuE2-Vae`
- `Soul-AILab__SoulX-Singer/{model.pt,model-svc.pt}`, `Soul-AILab__SoulX-Singer-Preprocess/rmvpe/rmvpe.pt`
- `heartmula/mulacover_root/SymbolicTranscriptor/chord` (ChordNet checkpoints)
- `viperx__bs-roformer-ep317-sdr12.9755`
- torchaudio's MMS forced aligner (`MMS_FA`) downloads its weights on first use.

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
