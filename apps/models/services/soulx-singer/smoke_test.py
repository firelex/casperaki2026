"""Standalone smoke test for the SoulX-Singer in-process path.

Mirrors what adapters/soulx-singer.py does (build model from model.pt, run the
DataProcessor + model.infer loop) using the repo's own example inputs. Runs only
the first target segment by default to keep it quick. Not part of the service.
"""
import json
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent / "repo"
CKPT = Path("/mnt/d/casperaki-models/Soul-AILab__SoulX-Singer/model.pt")
sys.path.insert(0, str(REPO))

import numpy as np
import soundfile as sf
import torch

from soulxsinger.utils.file_utils import load_config
from soulxsinger.models.soulxsinger import SoulXSinger
from soulxsinger.utils.data_processor import DataProcessor

DEVICE = "cuda"
EX = REPO / "example" / "audio"
LANG = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--lang=")), "zh")
PROMPT_WAV = EX / f"{LANG}_prompt.mp3"
PROMPT_META = EX / f"{LANG}_prompt.json"
TARGET_META = EX / f"{LANG}_target.json"
ALL_SEGMENTS = "--all" in sys.argv
print(f"lang={LANG} prompt={PROMPT_WAV.name} target={TARGET_META.name}")

cfg_path = REPO / "soulxsinger" / "config" / "soulxsinger.yaml"
phoneset = REPO / "soulxsinger" / "utils" / "phoneme" / "phone_set.json"
config = load_config(str(cfg_path))
print(f"config: sr={config.audio.sample_rate} hop={config.audio.hop_size} "
      f"n_steps={config.infer.n_steps} cfg={config.infer.cfg}")

t0 = time.time()
model = SoulXSinger(config).to(DEVICE)
ckpt = torch.load(str(CKPT), weights_only=False, map_location="cpu")
assert "state_dict" in ckpt, "no state_dict in checkpoint"
missing, unexpected = model.load_state_dict(ckpt["state_dict"], strict=False)
print(f"loaded model in {time.time()-t0:.1f}s | missing={len(missing)} unexpected={len(unexpected)}")
if missing:
    print("  missing[:5]:", missing[:5])
if unexpected:
    print("  unexpected[:5]:", unexpected[:5])
model.eval()

dp = DataProcessor(hop_size=config.audio.hop_size, sample_rate=config.audio.sample_rate,
                   phoneset_path=str(phoneset), device=DEVICE)

prompt_meta = json.loads(PROMPT_META.read_text(encoding="utf-8"))[0]
target_list = json.loads(TARGET_META.read_text(encoding="utf-8"))
infer_prompt = dp.process(prompt_meta, str(PROMPT_WAV))
print(f"target segments: {len(target_list)} (running {'all' if ALL_SEGMENTS else '1'})")

sr = config.audio.sample_rate
segs = target_list if ALL_SEGMENTS else target_list[:1]
out_len = int(segs[-1]["time"][1] / 1000 * sr)
merged = np.zeros(out_len, dtype=np.float32)

for i, tgt in enumerate(segs):
    start = int(tgt["time"][0] / 1000 * sr)
    infer_target = dp.process(tgt, None)
    ti = time.time()
    with torch.no_grad():
        audio = model.infer({"prompt": infer_prompt, "target": infer_target},
                            auto_shift=False, pitch_shift=0,
                            n_steps=config.infer.n_steps, cfg=config.infer.cfg,
                            control="melody", use_fp16=False)
    audio = audio.squeeze().cpu().numpy()
    n = min(audio.shape[0], merged.shape[0] - start)
    merged[start:start + n] = audio[:n]
    print(f"  segment {i}: {audio.shape[0]} samples in {time.time()-ti:.1f}s")

out = Path(__file__).resolve().parent / f"smoke_out_{LANG}.wav"
sf.write(str(out), merged, 24000)
print(f"OK wrote {out} ({merged.shape[0]/24000:.1f}s of audio)")
