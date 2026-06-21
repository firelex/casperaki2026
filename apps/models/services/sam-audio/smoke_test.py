"""Standalone smoke test for the SAM-Audio in-process path.

Mirrors adapters/sam-audio.py: load the local checkpoint, run a text-prompt
`separate()` and save the isolated target. Uses the repo's own office.mp4 with
the notebook's "man speaking" prompt. Not part of the service.
"""
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent / "repo"
CKPT = "/mnt/d/casperaki-models/facebook__sam-audio-large"
INPUT = str(REPO / "examples" / "assets" / "office.mp4")
DESCRIPTION = "man speaking"

import torch
import torchaudio
from sam_audio import SAMAudio, SAMAudioProcessor

device = "cuda" if torch.cuda.is_available() else "cpu"
predict_spans = "--spans" in sys.argv
rerank = 8 if "--rerank" in sys.argv else 1

t0 = time.time()
model = SAMAudio.from_pretrained(CKPT).to(device).eval()
processor = SAMAudioProcessor.from_pretrained(CKPT)
print(f"loaded model+processor in {time.time()-t0:.1f}s | sr={processor.audio_sampling_rate}")

batch = processor(audios=[INPUT], descriptions=[DESCRIPTION]).to(device)
print(f"running separate(predict_spans={predict_spans}, reranking_candidates={rerank}) on '{DESCRIPTION}'")
ti = time.time()
with torch.inference_mode():
    result = model.separate(batch, predict_spans=predict_spans, reranking_candidates=rerank)
print(f"separate done in {time.time()-ti:.1f}s")

out_dir = Path(__file__).resolve().parent
for name, stem in (("target", result.target), ("residual", result.residual)):
    if isinstance(stem, (list, tuple)):
        stem = stem[0]
    wav = stem.detach().cpu().float()
    if wav.dim() == 1:
        wav = wav.unsqueeze(0)
    p = out_dir / f"sam_{name}.wav"
    torchaudio.save(str(p), wav, processor.audio_sampling_rate)
    print(f"  wrote {p.name}: shape={tuple(wav.shape)} dur={wav.shape[-1]/processor.audio_sampling_rate:.2f}s "
          f"peak={wav.abs().max().item():.4f}")
print("OK separation complete")
