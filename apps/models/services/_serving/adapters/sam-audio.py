"""Adapter: SAM-Audio (facebook/sam-audio-large) — sound separation.

SAM-Audio isolates "anything" in an audio mixture from a natural-language
prompt (e.g. "a dog barking"), returning the isolated *target* sound plus the
*residual* (everything else). Unlike ACE-Step it ships no server — it's a plain
PyTorch package (`sam_audio`) — so this adapter loads the model **in-process**:
weights are loaded once in `load()`, and each job runs a blocking `separate()`
in `generate()`.

The model "crucially relies" on the Perception-Encoder Audio-Visual (PE-AV)
checkpoint and, for re-ranking, on a Judge/CLAP/ImageBind ensemble. Those
companion checkpoints are pulled from the Hugging Face hub by `from_pretrained`
on first load, so the host must be `huggingface-cli login`'d with access to the
gated `facebook/sam-audio-*` and `facebook/pe-av-large` repos. We default to the
cheap path (no span prediction, single candidate) so a first run needs only
PE-AV; re-ranking models load lazily when the user opts into them.
"""
from __future__ import annotations

import base64
import mimetypes
import os
from pathlib import Path

import adapter_common as common  # noqa: F401  (kept for parity / future use)

CHECKPOINT_FOLDER = "facebook__sam-audio-large"

MANIFEST = {
    "id": "sam-audio",
    "label": "SAM-Audio",
    "description": "Sound separation — isolate any sound from a mix by text prompt.",
    "kind": "audio",
    "python": "3.11",
    # Cloned into services/sam-audio/repo, then pip-installed into the venv.
    # Pin to a known-good tag once upstream cuts releases; HEAD for now.
    "repo": {"url": "https://github.com/facebookresearch/sam-audio.git", "dir": "repo"},
    "venv": ".venv",
    # The repo uses a plain pyproject (pip), not a uv project, so we create the
    # venv ourselves and install the package (which pulls torch + the GitHub
    # deps: dacvae, perception-models, imagebind, laion-clap, …).
    "setup_in_repo": False,
    "setup": [
        ["$UV", "venv", "--python", "3.11", ".venv"],
        ["$UV", "pip", "install", "--python", ".venv/bin/python", "./repo"],
    ],
    "params": {
        "audio": {"type": "string", "required": True, "description": "base64-encoded input audio"},
        "audio_filename": {"type": "string", "description": "original name (mime/ext hint)"},
        "description": {
            "type": "string",
            "required": True,
            "description": "what to isolate; lowercase noun/verb phrase, e.g. \"man speaking\"",
        },
        # Auto-predict the time spans of the target before separating — better
        # for discrete events, slower. Needs the span predictor checkpoint.
        "predict_spans": {"type": "boolean", "default": False},
        # Generate k candidates and keep the best per the re-ranking ensemble
        # (Judge/CLAP). >1 pulls in the re-ranking checkpoints. 1 = off.
        "reranking_candidates": {"type": "number", "default": 1},
        # Which stem to return: the isolated sound or everything else.
        "output": {"type": "string", "default": "target", "enum": ["target", "residual"]},
    },
}


def _ensure_hf_token(ctx) -> None:
    """The gated companions (sam-audio-judge, PE) need an authenticated HF
    request. Recent huggingface_hub does NOT auto-read the `huggingface-cli
    login` token file here, so export it explicitly (env wins if already set)."""
    if os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN"):
        return
    for p in (os.environ.get("HF_TOKEN_PATH"), str(Path.home() / ".cache" / "huggingface" / "token")):
        if not p:
            continue
        try:
            tok = Path(p).read_text().strip()
        except OSError:
            continue
        if tok:
            os.environ["HF_TOKEN"] = os.environ["HUGGING_FACE_HUB_TOKEN"] = tok
            ctx.log(f"using HF token from {p}")
            return
    ctx.log("WARNING: no HF token found — gated companion downloads (judge/PE) may 401")


def _patch_hub_mixin() -> None:
    """sam_audio's `BaseModel._from_pretrained` declares `proxies`/`resume_download`
    as REQUIRED kwargs, but current huggingface_hub no longer passes them — so a
    bare `from_pretrained` raises TypeError. Both SAMAudio and the judge model go
    through this, so patch the base class to default the dropped kwargs."""
    from sam_audio.model import base

    if getattr(base.BaseModel, "_casperaki_patched", False):
        return
    orig = base.BaseModel._from_pretrained.__func__

    def _from_pretrained(cls, **kwargs):
        kwargs.setdefault("force_download", False)
        kwargs.setdefault("proxies", None)
        kwargs.setdefault("resume_download", None)
        kwargs.setdefault("local_files_only", False)
        return orig(cls, **kwargs)

    base.BaseModel._from_pretrained = classmethod(_from_pretrained)
    base.BaseModel._casperaki_patched = True


def load(ctx):
    ckpt = ctx.model_dir / CHECKPOINT_FOLDER
    if not (ckpt / "config.json").exists():
        raise RuntimeError(f"SAM-Audio checkpoint not found at {ckpt}")

    _ensure_hf_token(ctx)
    _patch_hub_mixin()

    import torch
    from sam_audio import SAMAudio, SAMAudioProcessor

    device = os.environ.get("SAM_AUDIO_DEVICE", "cuda" if torch.cuda.is_available() else "cpu")
    ctx.log(f"loading SAM-Audio from {ckpt} on {device} — first run also fetches the "
            "ranker ensemble (ImageBind ~4.8GB + gated judge/PE), ~15min one-time")
    # from_pretrained accepts a local directory (HF convention) for the main
    # checkpoint; companion checkpoints referenced by id resolve via the HF cache.
    model = SAMAudio.from_pretrained(str(ckpt)).eval().to(device)
    processor = SAMAudioProcessor.from_pretrained(str(ckpt))
    return {"model": model, "processor": processor, "device": device, "torch": torch}


def generate(handle, params: dict, out_dir: str) -> dict:
    import torchaudio

    torch = handle["torch"]
    model, processor, device = handle["model"], handle["processor"], handle["device"]

    description = (params.get("description") or "").strip()
    if not description:
        raise RuntimeError("SAM-Audio needs a `description` of the sound to isolate")

    audio_b64 = params.get("audio")
    if not audio_b64:
        raise RuntimeError("SAM-Audio needs an input `audio` (base64)")
    filename = params.get("audio_filename") or "input.wav"
    suffix = Path(filename).suffix or mimetypes.guess_extension(
        mimetypes.guess_type(filename)[0] or "audio/wav"
    ) or ".wav"
    in_path = Path(out_dir) / f"input{suffix}"
    in_path.write_bytes(base64.b64decode(audio_b64))

    predict_spans = bool(params.get("predict_spans", False))
    candidates = max(1, int(params.get("reranking_candidates", 1)))
    which = params.get("output", "target")
    if which not in ("target", "residual"):
        raise RuntimeError(f"`output` must be 'target' or 'residual', got {which!r}")

    batch = processor(audios=[str(in_path)], descriptions=[description]).to(device)
    with torch.inference_mode():
        result = model.separate(batch, predict_spans=predict_spans, reranking_candidates=candidates)

    stem = result.target if which == "target" else result.residual
    # separate() may return a [frames] / [1, frames] tensor or a list (batched);
    # normalise to the 2D [channels, frames] torchaudio.save expects.
    if isinstance(stem, (list, tuple)):
        stem = stem[0]
    wav = stem.detach().cpu().float()
    if wav.dim() == 1:
        wav = wav.unsqueeze(0)

    out_path = Path(out_dir) / f"{which}.wav"
    torchaudio.save(str(out_path), wav, processor.audio_sampling_rate)
    return {"file": str(out_path), "kind": "audio"}
