"""Sound effects from text with Stable Audio Open 1.0 (diffusers), on the GPU.

Usage: .venv/bin/python generate.py <jobs.json>
jobs.json: [{"out": "<wav path>", "prompt": "...", "negative": "...", "seconds": 8, "seed": 1, "steps": 100}]
Writes each WAV (44.1 kHz stereo, 16-bit) and skips ones that exist. The weights: /mnt/d/casperaki-models/
stabilityai__stable-audio-open-1.0 (setup.sh). Licence: the Stability AI Community License (commercial use allowed
under its revenue threshold).
"""
import json
import sys
from pathlib import Path

import soundfile as sf
import torch
from diffusers import StableAudioPipeline

WEIGHTS = "/mnt/d/casperaki-models/stabilityai__stable-audio-open-1.0"


def main(jobs_path: str) -> None:
    jobs = json.loads(Path(jobs_path).read_text())
    pipe = StableAudioPipeline.from_pretrained(WEIGHTS, torch_dtype=torch.float16).to("cuda")
    rate = pipe.vae.sampling_rate
    for job in jobs:
        out = Path(job["out"])
        if out.exists():
            continue
        out.parent.mkdir(parents=True, exist_ok=True)
        audio = pipe(
            job["prompt"],
            negative_prompt=job.get("negative", "low quality, music, melody, speech, voice"),
            num_inference_steps=int(job.get("steps", 100)),
            audio_end_in_s=float(job["seconds"]),
            num_waveforms_per_prompt=1,
            generator=torch.Generator("cuda").manual_seed(int(job["seed"])),
        ).audios[0]
        sf.write(out, audio.T.float().cpu().numpy(), rate, subtype="PCM_16")
        print(f"[stable-audio] {out.name}", flush=True)


if __name__ == "__main__":
    main(sys.argv[1])
