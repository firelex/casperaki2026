"""Render SoulX-Singer jobs: one model in memory, jobs claimed from a folder one at a time.

  <soulx venv>/python soulx_worker.py --jobs <dir> [--worker-id N]
A job is <dir>/<clip>.job.json: {"prompt": name, "language": "English"|"Mandarin", "phoneme": [...],
"duration": [...], "note_pitch": [...], "note_type": [...], "f0": [... 50 frames per second, 0 = silent]}.
Output: <dir>/<clip>.soulx.wav (24 kHz mono). A job is claimed by renaming it to .job.json.<worker>.
Any failure raises and stops the worker with the job left claimed (so it is visible).
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

REPO = Path(os.environ["SOULX_REPO"])
CKPT = Path(os.environ["SOULX_CKPT"])
sys.path.insert(0, str(REPO))

import soundfile as sf  # noqa: E402
import torch  # noqa: E402

from soulxsinger.models.soulxsinger import SoulXSinger  # noqa: E402
from soulxsinger.utils.data_processor import DataProcessor  # noqa: E402
from soulxsinger.utils.file_utils import load_config  # noqa: E402

PROMPTS = {name: REPO / "example" / "audio" / name for name in ("en_prompt", "zh_prompt", "en_target", "zh_target", "yue_target")}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--jobs", type=Path, required=True)
    ap.add_argument("--worker-id", default="0")
    ap.add_argument("--n-steps", type=int, default=None)
    args = ap.parse_args()
    config = load_config(str(REPO / "soulxsinger" / "config" / "soulxsinger.yaml"))
    model = SoulXSinger(config).to("cuda")
    ck = torch.load(str(CKPT), weights_only=False, map_location="cpu")
    missing, unexpected = model.load_state_dict(ck["state_dict"], strict=False)
    if missing or unexpected:
        raise RuntimeError(f"checkpoint mismatch: missing {len(missing)}, unexpected {len(unexpected)}")
    model.eval()
    dp = DataProcessor(hop_size=config.audio.hop_size, sample_rate=config.audio.sample_rate,
                       phoneset_path=str(REPO / "soulxsinger" / "utils" / "phoneme" / "phone_set.json"), device="cuda")
    prompts = {}
    for name, base in PROMPTS.items():
        meta = json.loads(base.with_suffix(".json").read_text(encoding="utf-8"))[0]
        prompts[name] = dp.process(meta, str(base.with_suffix(".mp3")))
    n_steps = args.n_steps or config.infer.n_steps
    print(f"worker {args.worker_id} ready (n_steps {n_steps})", flush=True)
    done = 0
    t_start = time.time()
    idle = 0
    while True:
        jobs = sorted(args.jobs.glob("*.job.json"))
        if not jobs:
            if (args.jobs / "ALL_SUBMITTED").exists():
                break
            idle += 1
            time.sleep(2)
            continue
        job = jobs[0]
        claimed = job.with_name(job.name + f".{args.worker_id}")
        try:
            job.rename(claimed)
        except FileNotFoundError:
            continue  # another worker claimed it first
        j = json.loads(claimed.read_text())
        meta = {"duration": " ".join(f"{d:.4f}" for d in j["duration"]), "phoneme": " ".join(j["phoneme"]),
                "note_pitch": " ".join(str(p) for p in j["note_pitch"]), "note_type": " ".join(str(t) for t in j["note_type"]),
                "f0": " ".join(f"{f:.1f}" for f in j["f0"]), "language": j["language"]}
        target = dp.process(meta, None)
        with torch.no_grad():
            audio = model.infer({"prompt": prompts[j["prompt"]], "target": target}, auto_shift=False, pitch_shift=0,
                                n_steps=n_steps, cfg=config.infer.cfg, control="melody", use_fp16=False)
        out = claimed.with_name(claimed.name.split(".job.json")[0] + ".soulx.wav")
        sf.write(str(out), audio.squeeze().cpu().numpy(), config.audio.sample_rate)
        claimed.unlink()
        done += 1
        if done % 50 == 0:
            print(f"worker {args.worker_id}: {done} clips, {time.time() - t_start:.0f} s", flush=True)
    print(f"worker {args.worker_id} finished: {done} clips", flush=True)


if __name__ == "__main__":
    main()
