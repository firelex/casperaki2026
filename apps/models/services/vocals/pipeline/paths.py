"""Where the service finds its code, weights and voice: the one place for absolute paths.

The code repos are untracked folders in the shared tree (/home/roli79/apps/casperaki); weights stay on /mnt/d. The
voice prompt SoulX sings with is in git, in this service's voices/ folder.
"""
from pathlib import Path

SERVICE_DIR = Path(__file__).resolve().parents[1]
SHARED_SERVICES = Path("/home/roli79/apps/casperaki/apps/models/services")
SOULX_REPO = SHARED_SERVICES / "soulx-singer" / "repo"        # put on sys.path: `import soulxsinger`
BS_ROFORMER_CODE = SHARED_SERVICES / "bs-roformer"            # put on sys.path: `models.bs_roformer`, `utils`

MODELS = Path("/mnt/d/casperaki-models")
SOULX_SINGER_MODEL = MODELS / "Soul-AILab__SoulX-Singer" / "model.pt"
SOULX_SVC_MODEL = MODELS / "Soul-AILab__SoulX-Singer" / "model-svc.pt"
SOULX_RMVPE = MODELS / "Soul-AILab__SoulX-Singer-Preprocess" / "rmvpe" / "rmvpe.pt"
BS_ROFORMER_WEIGHTS = MODELS / "viperx__bs-roformer-ep317-sdr12.9755"

# The voice of the owner's approved demo (2026-11-25): a dry female voice prompt with its SoulX metadata (the sung
# phonemes, notes and timing of the recording). Copied from the SoulX repo's example/audio/yue2_female_dry2.*.
# Singer 1 (voices/singers.json): what the smoke run sings with; Sing names its singer in every job (`voice`).
VOICE = "yue2_female_dry2"
VOICE_AUDIO = SERVICE_DIR / "voices" / f"{VOICE}.mp3"
VOICE_META = SERVICE_DIR / "voices" / f"{VOICE}.json"

# Add a singer (pipeline/add_singer.py): two steps run as their own processes, each in the venv its models need, by
# explicit python path. Our scripts for them are in this service's tools/ folder.
TOOLS_DIR = SERVICE_DIR / "tools"
# SoulX-Singer-Preprocess (vocal separation and de-reverb, lyric and note transcription): run with cwd = SOULX_REPO
# (its model paths are relative to it: pretrained_models/SoulX-Singer-Preprocess -> /mnt/d/casperaki-models/soulx-preprocess).
SOULX_PREPROCESS_PYTHON = SHARED_SERVICES / "soulx-singer" / ".venv-preprocess" / "bin" / "python"
# Resemble Enhance (the enhancer): its venv was built for the vocal cleanup experiments (torch 2.10 cu128).
RESEMBLE_PYTHON = SHARED_SERVICES.parent / "vocal-cleanup-tests" / "resemble" / ".venv" / "bin" / "python"
