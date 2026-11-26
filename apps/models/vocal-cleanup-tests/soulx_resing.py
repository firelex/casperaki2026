"""Experiment (2026-11-26): the owner's hum re-sung by SoulX-Singer in the owner's own voice: the voice reference is
~10 s of the cleaned hum, described from its transcription (each note an "la" at its pitch, gaps as rests, the RMVPE
pitch curve); SoulX then sings the transcribed notes (as "la", from beat 1 on the click grid).
Usage (vocals venv): python soulx_resing.py <cleaned.wav> <notes.json> <first_beat_s> <bpm> <out.wav>"""
import json, sys
from pathlib import Path
import numpy as np, soundfile as sf, librosa, torch
sys.path.insert(0, "/home/roli79/apps/casperaki/apps/models/services/vocals")
from pipeline import paths
sys.path.append(str(paths.SOULX_REPO))
from pipeline.soulx import Singer
from pipeline.svc import Converter

src, notes_path, first_beat, bpm, out = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4]), Path(sys.argv[5])
notes = json.load(open(notes_path))
beat = 60.0 / bpm
singer = Singer(torch.device("cuda"), paths.VOICE_AUDIO, paths.VOICE_META)  # its prompt is replaced below
sr = singer.sr
y, s0 = sf.read(src, always_2d=True); y = librosa.resample(y.mean(1).astype(np.float32), orig_sr=s0, target_sr=sr)

# The voice reference: from the first note to ~10 s on, cut at a note end.
a = notes[0]["onsetSec"]
ref_notes = [n for n in notes if n["offsetSec"] - a <= 10.5]
b = ref_notes[-1]["offsetSec"]
ref = y[int(a * sr): int(b * sr)]
ref_path = out.parent / "_voice_ref.wav"; sf.write(ref_path, ref, sr)
# Its pitch curve, by SoulX's own extractor (RMVPE) at the singer's hop.
conv = Converter(torch.device("cuda"))
f0 = np.asarray(conv.f0x.process(str(ref_path), f0_path=str(out.parent / "_voice_ref_f0.npy")), dtype=np.float32)
conv.close()
dur, ph, pitch, typ = [], [], [], []
t = a
for n in ref_notes:
    if n["onsetSec"] - t > 0.02:
        dur.append(n["onsetSec"] - t); ph.append("<SP>"); pitch.append(0); typ.append(1)
    dur.append(n["offsetSec"] - n["onsetSec"]); ph.append("en_L-AA1"); pitch.append(n["midi"]); typ.append(2)
    t = n["offsetSec"]
meta = {"index": "owner_hum", "language": "English", "time": [0, int((b - a) * 1000)],
        "duration": " ".join(f"{d:.2f}" for d in dur), "text": " ".join("la" if p != "<SP>" else "<SP>" for p in ph),
        "phoneme": " ".join(ph), "note_pitch": " ".join(map(str, pitch)), "note_type": " ".join(map(str, typ)),
        "f0": " ".join(f"{x:.1f}" for x in f0)}
singer.prompt = singer.dp.process(meta, str(ref_path))
print(f"voice reference: {b - a:.1f} s, {len(ref_notes)} notes", flush=True)

# The notes to sing, in beats from beat 1, as "la".
sung = [{"start": (n["onsetSec"] - first_beat) / beat, "duration": (n["offsetSec"] - n["onsetSec"]) / beat, "midi": n["midi"],
         "word": "la", "phonemes": ["l", "aa1"]} for n in notes]
# A note starting just before beat 1 (up to a quarter beat early) starts on it; anything earlier is the count-in.
sung = [dict(n, start=max(0.0, n["start"]), duration=n["duration"] + min(0.0, n["start"])) for n in sung if n["start"] >= -0.25]
bars = int(np.ceil((max(n["start"] + n["duration"] for n in sung) + 1) / 4))
audio = singer.sing(sung, bpm, bars, "hum")
full = np.zeros(int(first_beat * sr) + len(audio), dtype=np.float32); full[int(first_beat * sr):] = audio
sf.write(out, full, sr); print("re-sung", len(sung), "notes ->", out, flush=True)
