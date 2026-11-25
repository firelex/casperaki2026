"""Where the service finds its code and weights: the one place for absolute paths.

The code repos are untracked folders in the shared tree (/home/roli79/apps/casperaki); weights stay on /mnt/d.
"""
from pathlib import Path

SHARED_SERVICES = Path("/home/roli79/apps/casperaki/apps/models/services")
SOULX_REPO = SHARED_SERVICES / "soulx-singer" / "repo"        # put on sys.path: `import soulxsinger`
BS_ROFORMER_CODE = SHARED_SERVICES / "bs-roformer"            # put on sys.path: `models.bs_roformer`, `utils`
MULACOVER_ROOT = SHARED_SERVICES / "heartmula" / "MuLaCover"  # pip-installed editable (`import mulacover`)

MODELS = Path("/mnt/d/casperaki-models")
YUE2_MODEL = MODELS / "yue2" / "YuE2-3B"
YUE2_VAE = MODELS / "yue2" / "YuE2-Vae"
SOULX_SINGER_MODEL = MODELS / "Soul-AILab__SoulX-Singer" / "model.pt"
SOULX_SVC_MODEL = MODELS / "Soul-AILab__SoulX-Singer" / "model-svc.pt"
SOULX_RMVPE = MODELS / "Soul-AILab__SoulX-Singer-Preprocess" / "rmvpe" / "rmvpe.pt"
CHORDNET_CHECKPOINTS = MODELS / "heartmula" / "mulacover_root" / "SymbolicTranscriptor" / "chord"
BS_ROFORMER_WEIGHTS = MODELS / "viperx__bs-roformer-ep317-sdr12.9755"
