# svc-vocals

Model service (port 16514, harness adapter `vocals`) that sings a song's vocal arrangement in the background,
transcribes it back into the Vocal lane, and makes new singers from recordings. `generate` dispatches on
`params["stage"]`:

- `sing` (Sing, `pipeline/sing.py`): every vocal sung by SoulX-Singer, the recipe of the owner's approved demo
  (2026-11-25): the lead of each section straight from the Vocal lane's notes and phonemes at the lane's pitch, in the
  voice `voices/yue2_female_dry2`; each backing line the section's lead re-pitched with SoulX-Singer-SVC; every take
  through the vocal chain (`pipeline/chain.py`: EQ, compressor, exciter at -6 dB, limiter); backings 9 dB under their
  lead (the brain sends `backing_db`). No YuE2, no ad-libs.
- `transcribe`: a recording the user brings of one section (Transcribe melody): BS-RoFormer separation only when `has_backing`; with a `count` (the section has written lyrics) the notes by count, without one only the voice for the brain to send to the hum service (see pipeline/transcribe.py)
- `add_singer` (Add a singer, `pipeline/add_singer.py`): a recording the user uploads (up to 5 minutes) made into a
  singer: decoded; for a full song, the lead vocal separated and de-reverbed (SoulX-Singer-Preprocess); no
  compression or enhancement (the voice is taken as it is); the silences cut (`pipeline/voice_cut.py`); a voice reference of
  8-12 s chosen ("beginning" or "best" stretch), always ending at a pause; its pitch (RMVPE), words (Parakeet, on the
  CPU) and notes (ROSVOT; for "la la la", every "l" a note: wav2vec2 letters) written as SoulX's description
  (`pipeline/voice_meta.py`); a test line sung by SoulX in the new voice. The SoulX-Singer-Preprocess steps run as
  processes of their own in its venv (`tools/soulx_preprocess.py`). (`tools/enhance_voice.py`, Resemble Enhance in its
  venv, is kept for recordings sung into a song: not used by any stage yet.)

One venv (`.venv`, Python 3.10, torch 2.10.0+cu128 for the RTX PRO 6000 Blackwell, sm_120) on the Linux disk;
weights stay on /mnt/d. Models load per job and are released after each stage (one GPU).

## Environment

The harness builds the venv from the adapter's manifest on first start. By hand:

    cd apps/models/services/vocals
    uv venv --python 3.10 .venv
    uv pip install --python .venv/bin/python --index-strategy unsafe-best-match -r requirements.txt

Version notes: SoulX-Singer's own requirements ask for older pins (numpy<2, transformers 4.41.2, torch 2.2); the
newer ones are used here. SoulX's
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

To make one again: `git clone <upstream> <folder> && git -C <folder> checkout <commit>`.

Weights (/mnt/d/casperaki-models):
- `Soul-AILab__SoulX-Singer/{model.pt,model-svc.pt}`, `Soul-AILab__SoulX-Singer-Preprocess/rmvpe/rmvpe.pt`
- `viperx__bs-roformer-ep317-sdr12.9755`

The voice prompt (in git): `voices/yue2_female_dry2.mp3` and `.json` (the recording and its SoulX metadata: phonemes,
notes and timing), copied from the SoulX clone's `example/audio/` where the owner's demo made it. It is a dry female
voice cut from a YuE2 take (the demo's choice).

## Add a singer: the other venvs and models (absolute paths in `pipeline/paths.py`)

- SoulX-Singer-Preprocess's venv `apps/models/services/soulx-singer/.venv-preprocess` (its own requirements:
  `soulx-singer/repo/preprocess/requirements.txt`, with NeMo for the English lyric recogniser) and its weights,
  `soulx-singer/repo/pretrained_models/SoulX-Singer-Preprocess` -> `/mnt/d/casperaki-models/soulx-preprocess`
  (karaoke and de-reverb Mel-Band RoFormers, RMVPE, Parakeet-TDT 0.6B v2, ROSVOT). Run with cwd = `soulx-singer/repo`.
  NeMo's encoder fails on this card ("CUDA driver error: unknown error") and then leaves the process unable to use
  the card, so the words step runs on the CPU in a process of its own.
- Resemble Enhance's venv `apps/models/vocal-cleanup-tests/resemble/.venv` (torch 2.10 cu128, `resemble-enhance`;
  deepspeed is stood in by stubs in `tools/enhance_voice.py`); its weights in the package's `model_repo/`.
- `facebook/wav2vec2-base-960h` (letter recogniser for "la la la") in the Hugging Face cache (`~/.cache/huggingface`).

Smoke run (GPU, outside the service): `.venv/bin/python smoke_add_singer.py <recording> <beginning|best> <0|1> <out dir>`.

## Smoke run

    .venv/bin/python smoke_sing.py <brain song.json> <out dir>

runs the sing stage on a real song outside the service (loads the models on the GPU itself) and checks each lead
take's pitch against the lane notes and that every backing line has its take, 9 dB under its lead.

## Licences

- SoulX-Singer: Apache-2.0.
- Songs sung before 2026-11-25 may hold YuE2 takes (m-a-p/YuE2-3B, CC BY-NC 4.0); the credit for them stays in the
  brain (src/export/vocalsCredit.ts). Sing no longer makes any.

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
   - `BRAIN_SINGERS_DATA_DIR=<a folder for the singers users add>` (Add a singer; e.g. `~/casperaki-data/singers`)

   Without the first three the brain refuses Sing ("Sing is not set up: …").
4. **svc-vocals runs** on port 16514 (see "Run"), and is **restarted after every change under `pipeline/`**: the
   harness imports the pipeline once at start, so a pull alone changes nothing.
5. **The packages are built** (`packages/song-schema`, `packages/arrangement`, `packages/engine-adapter`; the brain and
   the lowering read their `dist/`): `deploy.sh` does this (`pnpm -r --filter "./packages/*" build`); never by hand
   in the shared tree.
6. Restart the brain (deploy.sh does) so it reads brain.env.

