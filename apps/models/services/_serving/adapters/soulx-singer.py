"""Adapter: SoulX-Singer — zero-shot singing voice synthesis.

Given a short reference voice clip and a *score* (lyrics + per-note pitch/timing
metadata), SoulX-Singer renders the reference singer performing that score. The
repo ships a CLI (`python -m cli.inference`), not a server, so this adapter loads
the model **in-process**: weights load once in `load()`, and `generate()` mirrors
the repo's `cli/inference.py` `process()` loop for each job.

Inputs match the CLI exactly:
  * `prompt_audio`        — base64 reference voice clip
  * `prompt_metadata`     — JSON (the preprocessed prompt segment list)
  * `target_metadata`     — JSON (the preprocessed target score: lyrics, phonemes,
                            note_pitch, note_type, f0, per-segment time spans)
  * `control`             — "melody" (F0 contour) or "score" (MIDI notes)
  * `auto_shift` / `pitch_shift`

Producing the metadata JSONs is a *preprocessing* step (SoulX-Singer-Preprocess:
RMVPE pitch extraction, phonemisation, alignment) that runs upstream of this
model. This adapter takes already-preprocessed metadata as input — the same
contract the CLI expects.
"""
from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

CHECKPOINT_FOLDER = "Soul-AILab__SoulX-Singer"

MANIFEST = {
    "id": "soulx-singer",
    "label": "SoulX-Singer",
    "description": "Zero-shot singing voice synthesis (reference voice + score → singing).",
    "kind": "audio",
    "python": "3.10",
    "repo": {"url": "https://github.com/Soul-AILab/SoulX-Singer.git", "dir": "repo"},
    "venv": ".venv",
    # NOT `requirements.txt`: that pins torch==2.2.0 (no sm_120 kernels — fails on
    # Blackwell with "no kernel image available") and drags in nemo/funasr/
    # sageattention, none of which the *inference* path imports. We install a
    # Blackwell-capable torch (2.8/cu128) plus only the deps the model-load +
    # `model.infer` path actually needs. Verified end-to-end on an RTX PRO 6000
    # (sm_120): exact state_dict match, ~2.4s/segment.
    "setup_in_repo": False,
    "setup": [
        ["$UV", "venv", "--python", "3.10", ".venv"],
        ["$UV", "pip", "install", "--python", ".venv/bin/python",
         "torch==2.8.0", "torchaudio==2.8.0", "--index-url", "https://download.pytorch.org/whl/cu128"],
        ["$UV", "pip", "install", "--python", ".venv/bin/python",
         "numpy<2.0.0", "scipy", "librosa", "accelerate", "transformers==4.41.2",
         "omegaconf", "tqdm", "soundfile"],
    ],
    "params": {
        "prompt_audio": {"type": "string", "required": True, "description": "base64 reference voice clip"},
        "prompt_filename": {"type": "string", "description": "original name (ext hint)"},
        "prompt_metadata": {"type": "string", "required": True, "description": "preprocessed prompt JSON"},
        "target_metadata": {"type": "string", "required": True, "description": "preprocessed target score JSON"},
        "control": {"type": "string", "default": "melody", "enum": ["melody", "score"]},
        "auto_shift": {"type": "boolean", "default": False},
        "pitch_shift": {"type": "number", "default": 0},
    },
}

# Default 16-bit PCM output rate (matches cli/inference.py's hard-coded write).
OUTPUT_SAMPLE_RATE = 24000


def _coerce_json(value, what: str):
    """Accept metadata as a parsed object or a raw/base64 JSON string."""
    if isinstance(value, (list, dict)):
        return value
    if not isinstance(value, str) or not value.strip():
        raise RuntimeError(f"SoulX-Singer needs `{what}` (JSON)")
    text = value.strip()
    if not text.startswith(("[", "{")):
        # Likely base64-encoded file contents from a metadata upload.
        text = base64.b64decode(value).decode("utf-8")
    return json.loads(text)


def load(ctx):
    ckpt = ctx.model_dir / CHECKPOINT_FOLDER
    model_path = ckpt / "model.pt"
    if not model_path.exists():
        raise RuntimeError(f"SoulX-Singer checkpoint not found at {model_path}")

    repo = ctx.repo_dir or ctx.service_dir
    # The `soulxsinger` package lives at the repo root (run as a module by the
    # upstream CLI); make it importable in-process.
    sys.path.insert(0, str(repo))

    import torch
    from soulxsinger.utils.file_utils import load_config
    from soulxsinger.models.soulxsinger import SoulXSinger
    from soulxsinger.utils.data_processor import DataProcessor

    import os
    device = os.environ.get("SOULX_DEVICE", "cuda" if torch.cuda.is_available() else "cpu")
    use_fp16 = os.environ.get("SOULX_FP16", "0") == "1" and device.startswith("cuda")

    config_path = repo / "soulxsinger" / "config" / "soulxsinger.yaml"
    phoneset_path = repo / "soulxsinger" / "utils" / "phoneme" / "phone_set.json"
    config = load_config(str(config_path))

    ctx.log(f"loading SoulX-Singer from {model_path} on {device} (fp16={use_fp16})")
    model = SoulXSinger(config).to(device)
    checkpoint = torch.load(str(model_path), weights_only=False, map_location="cpu")
    if "state_dict" not in checkpoint:
        raise RuntimeError(f"{model_path} has no 'state_dict' key")
    model.load_state_dict(checkpoint["state_dict"], strict=True)
    if use_fp16:
        model.half()
        model.mel.float()  # keep the mel front-end in fp32 (as the CLI does)
    model.eval().to(device)

    data_processor = DataProcessor(
        hop_size=config.audio.hop_size,
        sample_rate=config.audio.sample_rate,
        phoneset_path=str(phoneset_path),
        device=device,
    )
    return {
        "torch": torch, "model": model, "config": config,
        "data_processor": data_processor, "device": device, "use_fp16": use_fp16,
    }


def generate(handle, params: dict, out_dir: str) -> dict:
    import numpy as np
    import soundfile as sf

    torch = handle["torch"]
    model, config, dp = handle["model"], handle["config"], handle["data_processor"]
    sr = config.audio.sample_rate

    control = params.get("control", "melody")
    if control not in ("melody", "score"):
        raise RuntimeError(f"`control` must be 'melody' or 'score', got {control!r}")
    auto_shift = bool(params.get("auto_shift", False))
    pitch_shift = int(params.get("pitch_shift", 0))

    # Reference voice → temp file (DataProcessor reads it from a path).
    if not params.get("prompt_audio"):
        raise RuntimeError("SoulX-Singer needs a `prompt_audio` (base64 reference clip)")
    suffix = Path(params.get("prompt_filename") or "prompt.wav").suffix or ".wav"
    prompt_wav = Path(out_dir) / f"prompt{suffix}"
    prompt_wav.write_bytes(base64.b64decode(params["prompt_audio"]))

    prompt_meta_list = _coerce_json(params.get("prompt_metadata"), "prompt_metadata")
    target_meta_list = _coerce_json(params.get("target_metadata"), "target_metadata")
    if not prompt_meta_list:
        raise RuntimeError("prompt_metadata is empty — preprocess the reference clip first")
    if not target_meta_list:
        raise RuntimeError("target_metadata has no segments")

    prompt_meta = prompt_meta_list[0]
    infer_prompt_data = dp.process(prompt_meta, str(prompt_wav))

    generated_len = int(target_meta_list[-1]["time"][1] / 1000 * sr)
    merged = np.zeros(generated_len, dtype=np.float32)

    for target_meta in target_meta_list:
        start = int(target_meta["time"][0] / 1000 * sr)
        infer_target_data = dp.process(target_meta, None)
        infer_data = {"prompt": infer_prompt_data, "target": infer_target_data}
        with torch.no_grad():
            audio = model.infer(
                infer_data,
                auto_shift=auto_shift,
                pitch_shift=pitch_shift,
                n_steps=config.infer.n_steps,
                cfg=config.infer.cfg,
                control=control,
                use_fp16=handle["use_fp16"],
            )
        audio = audio.squeeze().cpu().numpy()
        n = min(audio.shape[0], merged.shape[0] - start)
        merged[start:start + n] = audio[:n]

    out_path = Path(out_dir) / "generated.wav"
    sf.write(str(out_path), merged, OUTPUT_SAMPLE_RATE)
    return {"file": str(out_path), "kind": "audio"}
