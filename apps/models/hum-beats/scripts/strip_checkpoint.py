"""Write the weights-only form of a Lightning checkpoint (state_dict + hyper_parameters), the format of Beat
This!'s published checkpoints, loadable by beat_this.inference (File2Beats(checkpoint_path=<file>)).

  python scripts/strip_checkpoint.py <run>/final.ckpt <run>/final-weights.ckpt
"""
import sys

import torch

src, dst = sys.argv[1], sys.argv[2]
ck = torch.load(src, map_location="cpu", weights_only=False)
out = {"state_dict": ck["state_dict"], "hyper_parameters": dict(ck["hyper_parameters"]), "pytorch-lightning_version": ck["pytorch-lightning_version"],
       "global_step": ck["global_step"]}
torch.save(out, dst)
torch.load(dst, map_location="cpu", weights_only=True)  # must load the way beat_this.inference loads it
print(f"wrote {dst} (global step {ck['global_step']})")
