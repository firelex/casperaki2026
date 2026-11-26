"""Experiment (2026-11-26, the owner's idea): melodies sung as "la la la"; every "l" is a note start. A letter CTC
speech recogniser (facebook/wav2vec2-base-960h) gives P("L") per 20 ms frame; its peaks are the onsets.
Usage: .venv/bin/python la_onsets.py <wav> <first_beat_s> <bpm>"""
import sys
import numpy as np, soundfile as sf, librosa, torch
from scipy.signal import find_peaks
from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor
MODEL = "facebook/wav2vec2-base-960h"
TRUE_SLOTS = [0, 1, 2, 3, 4, 6, 8, 9, 10, 11, 12, 16, 17, 18, 19, 20, 24, 25, 26, 27, 28, 30, 32, 33, 34, 35, 36]

def l_onsets(y16, min_gap_s=0.15, height=0.3):
    proc = Wav2Vec2Processor.from_pretrained(MODEL); model = Wav2Vec2ForCTC.from_pretrained(MODEL).eval()
    with torch.no_grad():
        logits = model(proc(y16, sampling_rate=16000, return_tensors="pt").input_values).logits[0]
    p = torch.softmax(logits, -1).numpy()
    l = proc.tokenizer.convert_tokens_to_ids("L")
    pl = p[:, l]
    frame = len(y16) / 16000 / len(pl)
    peaks, _ = find_peaks(pl, height=height, distance=max(1, int(min_gap_s / frame)))
    text = proc.batch_decode(torch.argmax(logits, -1)[None])[0]
    return peaks * frame, pl, frame, text

if __name__ == "__main__":
    wav, fb, bpm = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
    y, sr = sf.read(wav, always_2d=True); y16 = librosa.resample(y.mean(1).astype(np.float32), orig_sr=sr, target_sr=16000)
    step = 60 / bpm / 2
    for h in (0.2, 0.3, 0.5):
        on, pl, frame, text = l_onsets(y16, height=h)
        on = on[on >= fb - 0.15]
        slots = [round((t - fb) / step) for t in on]
        hit = len(set(slots) & set(TRUE_SLOTS)); extra = len([s for s in slots if s not in TRUE_SLOTS]); dup = len(slots) - len(set(slots))
        print(f"P(L) peaks over {h}: {len(on)} onsets; true note starts found {hit} of 27, extra {extra}, doubled {dup}")
    print("recogniser heard:", text[:200])
