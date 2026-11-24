"""Adapter: Segmind small-sd — song artwork (text to image).

small-sd (https://huggingface.co/segmind/small-sd) is a distilled Stable Diffusion 1.5: the same text encoder and
VAE, a U-Net with fewer blocks. It draws the artwork on a song's card from a picture description the brain writes
from the song's title.

Memory: the pipeline lives in CPU memory in half precision, and each part of it (text encoder, U-Net, VAE) is moved
to the GPU only while it runs (model CPU offload), with attention computed in slices and the VAE decoding one image
at a time. So the service holds no GPU memory between images and little while drawing one (measured in
docs/superpowers/specs/2026-11-24-song-artwork-design.md).
"""
from __future__ import annotations

from pathlib import Path

CHECKPOINT_FOLDER = "segmind__small-sd"
_REPO = "https://huggingface.co/segmind/small-sd/resolve/main/"
_FILES = [
    "model_index.json",
    "scheduler/scheduler_config.json",
    "text_encoder/config.json",
    "text_encoder/pytorch_model.bin",
    "tokenizer/merges.txt",
    "tokenizer/special_tokens_map.json",
    "tokenizer/tokenizer_config.json",
    "tokenizer/vocab.json",
    "unet/config.json",
    "unet/diffusion_pytorch_model.bin",
    "vae/config.json",
    "vae/diffusion_pytorch_model.bin",
]

MANIFEST = {
    "id": "small-sd",
    "label": "Segmind small-sd",
    "description": "Song artwork: a small distilled Stable Diffusion 1.5 (text to image).",
    "kind": "image",
    "python": "3.12",
    "venv": ".venv",
    "setup": [
        ["$UV", "venv", "--python", "3.12", ".venv"],
        # Blackwell (sm_120) needs a cu128 torch.
        ["$UV", "pip", "install", "--python", ".venv/bin/python",
         "torch==2.7.1", "--index-url", "https://download.pytorch.org/whl/cu128"],
        ["$UV", "pip", "install", "--python", ".venv/bin/python",
         "diffusers", "transformers", "accelerate", "pillow"],
    ],
    "missing_files": [{"dest": f"{CHECKPOINT_FOLDER}/{f}", "url": _REPO + f} for f in _FILES],
    "params": {
        "prompt": {"type": "string", "required": True, "description": "what the picture shows"},
        "negative_prompt": {"type": "string", "description": "what it must not show"},
        "seed": {"type": "number", "description": "random seed (the same seed and prompt draw the same picture)"},
        "steps": {"type": "number", "default": 25},
        "size": {"type": "number", "default": 512, "description": "square image side in pixels"},
    },
}

NEGATIVE = "text, letters, words, watermark, signature, logo, frame, border, blurry, low quality, deformed"


def load(ctx):
    import torch
    from diffusers import DPMSolverMultistepScheduler, StableDiffusionPipeline

    model = ctx.model_dir / CHECKPOINT_FOLDER
    if not (model / "model_index.json").exists():
        raise RuntimeError(f"small-sd weights are missing in {model}")
    pipe = StableDiffusionPipeline.from_pretrained(
        str(model), torch_dtype=torch.float16, safety_checker=None, requires_safety_checker=False
    )
    pipe.scheduler = DPMSolverMultistepScheduler.from_config(pipe.scheduler.config)
    pipe.enable_attention_slicing()
    pipe.vae.enable_slicing()
    pipe.enable_model_cpu_offload()
    pipe.set_progress_bar_config(disable=True)
    ctx.log("small-sd loaded (fp16, model CPU offload, attention slicing)")
    return {"pipe": pipe, "torch": torch}


def generate(handle, params: dict, out_dir: str) -> dict:
    pipe, torch = handle["pipe"], handle["torch"]
    prompt = params.get("prompt")
    if not prompt:
        raise RuntimeError("small-sd needs a `prompt`")
    size = int(params.get("size", 512))
    if size % 64 != 0 or not 256 <= size <= 768:
        raise RuntimeError(f"size must be a multiple of 64 between 256 and 768, got {size}")
    generator = torch.Generator("cpu").manual_seed(int(params["seed"])) if "seed" in params else None
    image = pipe(
        prompt,
        negative_prompt=params.get("negative_prompt", NEGATIVE),
        num_inference_steps=int(params.get("steps", 25)),
        guidance_scale=7.5,
        width=size,
        height=size,
        generator=generator,
    ).images[0]
    torch.cuda.empty_cache()
    out = Path(out_dir) / "artwork.png"
    image.save(out)
    return {"file": str(out), "kind": "image"}
