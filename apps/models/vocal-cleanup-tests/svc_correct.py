"""Experiment (2026-11-26): pitch correction with SoulX-Singer-SVC: the cleaned take re-sung on the corrected pitch
curve (pitch_correct.correction_curve), with the take itself as the voice reference (timbre kept as far as SVC does).
Usage (the vocals service venv): python svc_correct.py <cleaned.wav> <notes.json> <out_dir>"""
import json, sys
from pathlib import Path
import numpy as np, soundfile as sf, librosa, torch
sys.path.insert(0, "/home/roli79/apps/casperaki/apps/models/services/vocals")
sys.path.insert(0, str(Path(__file__).resolve().parent))
from pipeline import paths
sys.path.append(str(paths.SOULX_REPO))
from pipeline.svc import Converter
from pitch_correct import SETTINGS, correction_curve
src, notes_path, out = sys.argv[1], sys.argv[2], Path(sys.argv[3]); out.mkdir(parents=True, exist_ok=True)
notes = json.load(open(notes_path))
conv = Converter(torch.device("cuda"))
y, sr = sf.read(src, always_2d=True); y = librosa.resample(y.mean(1).astype(np.float32), orig_sr=sr, target_sr=conv.sr)
ref = out / "_ref.wav"; sf.write(ref, y, conv.sr)
f0 = np.asarray(conv.f0x.process(str(ref), f0_path=str(out / "_f0.npy")), dtype=np.float32)
frame_s = conv.hop / conv.sr
wav = torch.from_numpy(y).unsqueeze(0).to("cuda")
for name, (s, e) in [(k, v) for k, v in SETTINGS.items() if k in sys.argv[4:] or not sys.argv[4:]]:
    tgt = correction_curve(f0.astype(np.float64), frame_s, notes, s, e).astype(np.float32)
    with torch.no_grad():
        a, _ = conv.model.infer(pt_wav=wav, gt_wav=wav, pt_f0=torch.from_numpy(f0).unsqueeze(0).to("cuda"),
                                gt_f0=torch.from_numpy(tgt).unsqueeze(0).to("cuda"), auto_shift=False, pitch_shift=0,
                                n_steps=conv.config.infer.n_steps, cfg=conv.config.infer.cfg, use_fp16=False)
    z = a.squeeze().float().cpu().numpy()[: len(y)]
    sf.write(out / f"soulx_{name}.wav", z, conv.sr); print("soulx", name, "done", flush=True)
conv.close()
