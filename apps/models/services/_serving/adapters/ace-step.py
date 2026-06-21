"""Adapter: ACE-Step 1.5 — text-to-music.

ACE-Step ships its own (async, job-based) FastAPI server. The cleanest reliable
integration is to run that server as a child process and translate its API into
the harness's uniform blocking `generate`. All ACE-Step-specific logic lives
here; the harness, the shared adapter helpers, and Casperaki's TypeScript stay
model-agnostic.
"""
from __future__ import annotations

import base64
import json
import mimetypes
import os
import sys
import time
from pathlib import Path

import adapter_common as common

CHECKPOINT_FOLDER = "ACE-Step__Ace-Step1.5"

MANIFEST = {
    "id": "ace-step",
    "label": "ACE-Step 1.5",
    "description": "Text-to-music generation (prompt + optional lyrics → audio).",
    "kind": "audio",
    "python": "3.12",
    # Already cloned into services/ace-step; "." means "the service dir itself".
    # Pinned to a known-good tag so a fresh clone on another machine reproduces
    # this exact runtime API (server CLI, env vars, HTTP contract, checkpoint
    # layout). Bump deliberately after testing — never track upstream HEAD.
    "repo": {"url": "https://github.com/ace-step/ACE-Step-1.5.git", "dir": ".", "branch": "v0.1.8"},
    "venv": ".venv",
    "setup": [
        ["$UV", "sync"],
        # The ACE vocal pipeline separates the generated full mix into vocal /
        # accompaniment stems after generation. Keep Demucs in the ACE venv so
        # the pipeline can run it without introducing a second service.
        ["$UV", "pip", "install", "--python", ".venv/bin/python", "demucs"],
    ],
    "missing_files": [
        {
            "dest": f"{CHECKPOINT_FOLDER}/acestep-v15-turbo/silence_latent.pt",
            "url": "https://huggingface.co/ACE-Step/Ace-Step1.5/resolve/main/"
                   "acestep-v15-turbo/silence_latent.pt",
        },
    ],
    # Generation params the UI / API may send (for documentation).
    "params": {
        "prompt": {"type": "string", "required": True},
        "lyrics": {"type": "string"},
        "audio_duration": {"type": "number", "default": 30},
        "inference_steps": {"type": "number", "default": 8},
        "audio_format": {"type": "string", "default": "mp3"},
        "seed": {"type": "number"},
        "vocal_language": {"type": "string", "default": "en"},
        # Optional reference track (base64-encoded audio bytes). When present the
        # job becomes a `cover` task conditioned on the uploaded audio.
        "reference_audio": {"type": "string", "description": "base64-encoded audio"},
        "reference_filename": {"type": "string", "description": "original name (for the mime/ext hint)"},
        # "style": new music in the reference's style (ref_audio, duration free).
        # "remix": re-render the uploaded track itself (src_audio, duration locked).
        "reference_mode": {"type": "string", "default": "style", "enum": ["style", "remix"]},
        # Style-transfer strength for reference_mode="style" (0..1; ~0.2 = light).
        "style_strength": {"type": "number", "default": 0.5},
    },
}


def load(ctx):
    ckpt = ctx.model_dir / CHECKPOINT_FOLDER
    if not (ckpt / "config.json").exists():
        raise RuntimeError(f"ACE-Step checkpoint not found at {ckpt}")

    internal_port = ctx.port + 1
    env = {
        **os.environ,
        # The server reads ACESTEP_CHECKPOINT_PATH (singular). Point it at our
        # local download so it doesn't fall back to ./checkpoints and re-download
        # everything from HuggingFace.
        "ACESTEP_CHECKPOINT_PATH": str(ckpt),
        # Use the LM planner we actually downloaded (1.7B). The server defaults
        # to acestep-5Hz-lm-4B, which we don't have → it would try to fetch GBs
        # and time out. The name is resolved relative to the checkpoint dir.
        "ACESTEP_LM_MODEL_PATH": os.environ.get("ACESTEP_LM_MODEL_PATH", "acestep-5Hz-lm-1.7B"),
        "ACESTEP_API_HOST": "127.0.0.1",
        "ACESTEP_API_PORT": str(internal_port),
        "ACESTEP_DEVICE": "cuda",
        # vLLM's CUDA-graph capture can hang/crawl on the brand-new Blackwell
        # (sm_120) GPU; the PyTorch LM backend loads fast and avoids it.
        # Override via the CASPERAKI env if a future vLLM supports Blackwell.
        "ACESTEP_LM_BACKEND": os.environ.get("ACESTEP_LM_BACKEND", "pt"),
    }
    acestep_api = Path(sys.executable).parent / "acestep-api"
    base = f"http://127.0.0.1:{internal_port}"
    proc = common.launch_server(
        [acestep_api], ctx.repo_dir or ctx.service_dir, env, ctx.log,
        label=f"acestep-api on :{internal_port}",
    )
    common.wait_until_healthy(
        proc,
        lambda: common.http_json(f"{base}/health", timeout=3)["data"]["status"] == "ok",
        timeout=240, log=ctx.log, label="acestep-api",
    )
    return {"base": base, "proc": proc}


def generate(handle, params: dict, out_dir: str) -> dict:
    base = handle["base"]
    body = {
        "prompt": params.get("prompt", ""),
        "lyrics": params.get("lyrics", ""),
        "inference_steps": int(params.get("inference_steps", 8)),
        "audio_format": params.get("audio_format", "mp3"),
    }
    if params.get("audio_duration") is not None:
        body["audio_duration"] = float(params["audio_duration"])
    if params.get("vocal_language"):
        body["vocal_language"] = params["vocal_language"]
    if params.get("seed") is not None:
        body["seed"] = int(params["seed"])
    # Optional musical constraints + sampler CFG — forwarded only when provided.
    # bpm/key_scale/time_signature pin tempo & key; guidance_scale is the text
    # CFG (raise it, ~20-25, to make the model honor lyric placement on
    # audio-to-audio tasks); track_name selects the stem for `lego` layering.
    if params.get("guidance_scale") is not None:
        body["guidance_scale"] = float(params["guidance_scale"])
    if params.get("bpm") is not None:
        body["bpm"] = int(params["bpm"])
    if params.get("key_scale"):
        body["key_scale"] = params["key_scale"]
    if params.get("time_signature"):
        body["time_signature"] = params["time_signature"]
    if params.get("track_name"):
        body["track_name"] = params["track_name"]

    # Optional reference track. ACE-Step takes the audio as an inline multipart
    # upload on /release_task (no separate upload endpoint, no JSON path for
    # arbitrary locations), so when a reference is present we switch from JSON to
    # multipart and set the task to `cover`.
    ref_b64 = params.get("reference_audio")
    if ref_b64:
        mode = params.get("reference_mode", "style")
        filename = params.get("reference_filename") or "reference.mp3"
        ctype = mimetypes.guess_type(filename)[0] or "audio/mpeg"
        content = base64.b64decode(ref_b64)
        fields = {k: str(v) for k, v in body.items()}
        if mode == "remix":
            # Cover/remix: the SOURCE track drives the output; its length is
            # locked, so don't fight it with an explicit duration. ACE's `cover`
            # task takes the track as `src_audio`.
            fields["task_type"] = "cover"
            fields.pop("audio_duration", None)
            file_field = "src_audio"
        elif mode == "layer":
            # Add a single LAYER bar-locked to the backing track via ACE's `lego`
            # task ("generate the <track_name> track based on the audio context").
            # The source drives tempo/structure; a low cover-strength keeps the
            # groove while leaving room for the new part, and a high CFG makes the
            # model honor the lyric placement. Source goes in as `src_audio`.
            fields["task_type"] = "lego"
            fields.setdefault("track_name", "vocals")
            fields["audio_cover_strength"] = str(float(params.get("style_strength", 0.3)))
            fields.setdefault("guidance_scale", str(float(params.get("guidance_scale", 24.0))))
            fields.pop("audio_duration", None)
            file_field = "src_audio"
        else:
            # Style transfer: a fresh `text2music` generation *conditioned* on the
            # reference (ACE's reference-audio path), with the prompt/lyrics
            # steering the new piece. The reference goes in as `ref_audio` and
            # style_strength → cover strength. NB: `cover` is wrong here — it's a
            # source-audio task and would reject a ref-only request.
            fields["task_type"] = "text2music"
            fields["audio_cover_strength"] = str(float(params.get("style_strength", 0.5)))
            file_field = "ref_audio"
        resp = common.post_multipart(
            f"{base}/release_task",
            fields=fields,
            files={file_field: (filename, content, ctype)},
        )
        task_id = resp["data"]["task_id"]
    else:
        task_id = common.http_json(f"{base}/release_task", body)["data"]["task_id"]

    inner = None
    while True:
        res = common.http_json(f"{base}/query_result", {"task_id_list": [task_id]})
        entry = res["data"][0]
        status = entry["status"]  # 0=running, 1=succeeded, 2=failed
        # The per-task detail is a JSON STRING under "result": a list of dicts
        # with file/wave/status/error fields.
        try:
            inner = json.loads(entry.get("result", "[]"))
            inner = inner[0] if isinstance(inner, list) and inner else inner
        except Exception:  # noqa: BLE001
            inner = None
        if status == 1:
            break
        if status == 2:
            detail = (inner or {}).get("error", "") if isinstance(inner, dict) else ""
            raise RuntimeError(f"ACE-Step generation failed: {detail or 'unknown error'}")
        time.sleep(2)

    # Locate the produced audio. ACE-Step serves files via /v1/audio?path=<abs>.
    src = None
    if isinstance(inner, dict):
        src = inner.get("file") or inner.get("wave") or inner.get("audio_path")
    if not src:
        raise RuntimeError(f"ACE-Step succeeded but returned no audio path (entry={entry})")

    if src.startswith("http://") or src.startswith("https://"):
        url = src
    elif src.startswith("/v1/"):
        url = f"{base}{src}"
    else:
        # Absolute/relative filesystem path on the model server → audio route.
        url = f"{base}/v1/audio?path={common.quote_path(src)}"

    fmt = body["audio_format"]
    out_path = Path(out_dir) / f"output.{fmt}"
    common.download_file(url, out_path)
    return {"file": str(out_path), "kind": "audio"}
