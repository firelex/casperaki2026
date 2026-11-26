"""Experiment: speech enhancers on a sung recording. Usage: .venv/bin/python run_speech_tools.py <in.wav> <out_dir>
Writes dfn.wav (DeepFilterNet 3, 48 kHz) and mossformer2.wav (ClearerVoice MossFormer2_SE_48K)."""
import sys, types, os
from pathlib import Path
import numpy as np, soundfile as sf, librosa, torch
# DeepFilterNet imports torchaudio.backend.common.AudioMetaData, gone from torchaudio 2.9+: a stand-in for the import.
mod = types.ModuleType("torchaudio.backend"); com = types.ModuleType("torchaudio.backend.common")
class AudioMetaData:  # only named in type hints there
    pass
com.AudioMetaData = AudioMetaData; mod.common = com
sys.modules["torchaudio.backend"] = mod; sys.modules["torchaudio.backend.common"] = com
src, out = sys.argv[1], Path(sys.argv[2]); out.mkdir(parents=True, exist_ok=True)
y, sr = sf.read(src, always_2d=True); y = y.mean(1).astype(np.float32)
if sr != 48000: y = librosa.resample(y, orig_sr=sr, target_sr=48000); sr = 48000
from df.enhance import enhance, init_df
model, state, _ = init_df()
z = enhance(model, state, torch.from_numpy(y)[None]).squeeze(0).numpy()
sf.write(out / "dfn.wav", z, sr); print("dfn done", flush=True)
sf.write(out / "_in48.wav", y, sr)
from clearvoice import ClearVoice
cv = ClearVoice(task="speech_enhancement", model_names=["MossFormer2_SE_48K"])
r = cv(input_path=str(out / "_in48.wav"), online_write=False)
r = np.asarray(r).squeeze()
sf.write(out / "mossformer2.wav", r.astype(np.float32), 48000); print("mossformer2 done", flush=True)
os.remove(out / "_in48.wav")
