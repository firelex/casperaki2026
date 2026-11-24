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
    # The voice catalogue (voices.json next to the repo): every prompt processed once.
    catalogue_path = ctx.service_dir / "voices.json"
    catalogue = json.loads(catalogue_path.read_text(encoding="utf-8"))["voices"]
    voices = {}
    for v in catalogue:
        meta_path = Path(v["prompt"]["json"]) if Path(v["prompt"]["json"]).is_absolute() else repo / v["prompt"]["json"]
        audio_path = Path(v["prompt"]["audio"]) if Path(v["prompt"]["audio"]).is_absolute() else repo / v["prompt"]["audio"]
        for p in (meta_path, audio_path):
            if not p.exists():
                raise RuntimeError(f"voice {v['id']}: {p} not found ({catalogue_path})")
        meta = json.loads(meta_path.read_text(encoding="utf-8"))[0]
        voices[v["id"]] = {**v, "processed": data_processor.process(meta, str(audio_path))}
    phones = set(json.loads(phoneset_path.read_text(encoding="utf-8")))
    ctx.log(f"SoulX-Singer voices: {', '.join(voices)}")
    return {
        "torch": torch, "model": model, "config": config,
        "data_processor": data_processor, "device": device, "use_fp16": use_fp16,
        "voices": voices, "phones": phones,
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


# --------------------------------------------------------------------------- #
# Synchronous routes for the brain's sung vocals (docs/superpowers/specs/2026-11-24-sung-vocals-design.md).
#
#   POST /voices  {}  -> {"voices": [{"id", "label", "octave", "low", "high", "median"}]}
#   POST /sing    {"voice", "steps", "phrases": [{"phoneme": [..], "duration": [..s], "notePitch": [..MIDI, 0 = rest],
#                                                  "noteType": [..1 rest | 2 note | 3 slur]}]}
#              -> {"sampleRate": 24000, "phrases": [{"wav": base64 16-bit mono WAV}], "tookMs"}
# Pitches are the written notes; the voice's octave is applied here. Score control (MIDI notes, no pitch curve),
# no automatic shift. A phone SoulX does not know, an unknown voice or a malformed phrase is a 422 naming it.

from adapter_common import RequestError  # noqa: E402

MIN_STEPS, MAX_STEPS = 16, 64


def _body(body: bytes) -> dict:
    try:
        data = json.loads(body.decode("utf-8") or "{}")
    except ValueError:
        raise RequestError(400, "The body must be JSON.") from None
    if not isinstance(data, dict):
        raise RequestError(400, "The body must be a JSON object.")
    return data


def voices(handle, headers, body: bytes):
    _body(body)
    return 200, {"voices": [{k: v[k] for k in ("id", "label", "octave", "low", "high", "median")} for v in handle["voices"].values()]}


def sing(handle, headers, body: bytes):
    import io
    import time
    import soundfile as sf

    data = _body(body)
    voice = handle["voices"].get(data.get("voice"))
    if voice is None:
        raise RequestError(422, f"Unknown voice {data.get('voice')!r}; known: {', '.join(handle['voices'])}.")
    steps = data.get("steps")
    if not isinstance(steps, int) or not MIN_STEPS <= steps <= MAX_STEPS:
        raise RequestError(422, f"steps must be a whole number from {MIN_STEPS} to {MAX_STEPS}, got {steps!r}.")
    phrases = data.get("phrases")
    if not isinstance(phrases, list) or not phrases:
        raise RequestError(422, "phrases must be a non-empty list.")
    torch, model, config, dp = handle["torch"], handle["model"], handle["config"], handle["data_processor"]
    t0 = time.time()
    out = []
    for i, ph in enumerate(phrases):
        try:
            phoneme, duration, pitch, ntype = ph["phoneme"], ph["duration"], ph["notePitch"], ph["noteType"]
        except (KeyError, TypeError):
            raise RequestError(422, f"phrase {i}: needs phoneme, duration, notePitch and noteType.") from None
        n = len(phoneme)
        if n == 0 or not (len(duration) == len(pitch) == len(ntype) == n):
            raise RequestError(422, f"phrase {i}: phoneme, duration, notePitch and noteType must be the same non-zero length.")
        for p in phoneme:
            if p != "<SP>" and any(part not in handle["phones"] for part in _phone_parts(p)):
                raise RequestError(422, f"phrase {i}: SoulX does not know the phone {p!r}.")
        if any((not isinstance(d, (int, float))) or d <= 0 for d in duration):
            raise RequestError(422, f"phrase {i}: every duration must be a positive number of seconds.")
        sung = [int(p) + voice["octave"] if int(p) > 0 else 0 for p in pitch]
        meta = {"duration": " ".join(f"{float(d):.4f}" for d in duration), "phoneme": " ".join(phoneme),
                "note_pitch": " ".join(str(p) for p in sung), "note_type": " ".join(str(int(t)) for t in ntype),
                "language": "English"}
        target = dp.process(meta, None)
        with torch.no_grad():
            audio = model.infer({"prompt": voice["processed"], "target": target}, auto_shift=False, pitch_shift=0,
                                n_steps=steps, cfg=config.infer.cfg, control="score", use_fp16=handle["use_fp16"])
        buf = io.BytesIO()
        sf.write(buf, audio.squeeze().float().cpu().numpy(), config.audio.sample_rate, format="WAV", subtype="PCM_16")
        out.append({"wav": base64.b64encode(buf.getvalue()).decode("ascii")})
    return 200, {"sampleRate": config.audio.sample_rate, "phrases": out, "tookMs": round((time.time() - t0) * 1000)}


def _phone_parts(p: str) -> list[str]:
    """'en_K-IH0-NG' -> ['en_K', 'en_IH0', 'en_NG'] (the SoulX phone set lists single English phones)."""
    if not p.startswith("en_") or len(p) <= 3:
        return [p]
    return ["en_" + part for part in p[3:].split("-")]


ROUTES = {"/voices": voices, "/sing": sing}
