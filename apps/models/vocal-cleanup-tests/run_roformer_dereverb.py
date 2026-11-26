"""Experiment: the anvuew Mel-Band RoFormer de-reverb (from SoulX-Singer-Preprocess) alone, no vocal separation.
Usage (SoulX preprocess venv, cwd = the SoulX repo): python run_roformer_dereverb.py <in.wav> <out.wav>"""
import sys
import numpy as np, soundfile as sf, librosa, torch
sys.path.insert(0, ".")
from preprocess.tools.vocal_separation.model import build_model, process
from preprocess.tools.vocal_separation.utils.settings import parse_args_inference
D = "pretrained_models/SoulX-Singer-Preprocess/dereverb_mel_band_roformer/"
args = parse_args_inference({"model_type": "mel_band_roformer", "disable_detailed_pbar": True})
args.config_path = D + "dereverb_mel_band_roformer_anvuew.yaml"
args.start_check_point = D + "dereverb_mel_band_roformer_anvuew_sdr_19.1729.ckpt"
model, config = build_model(args)
model = model.half().to("cuda")
config.inference.chunk_size = int(5 * config.audio.sample_rate)
sr_m = getattr(config.audio, "sample_rate", 44100)
y, _ = librosa.load(sys.argv[1], sr=sr_m, mono=True)
with torch.no_grad():
    z = process(y, model, args, config, "cuda")
z = np.asarray(z).mean(0) if np.asarray(z).ndim == 2 else np.asarray(z)
sf.write(sys.argv[2], z.astype(np.float32), sr_m)
print("dereverb done", sr_m, len(z) / sr_m, flush=True)
