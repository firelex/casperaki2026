"""Experiment (2026-11-26): transcription of a melody sung as "la la la": note starts = the "l"s (la_onsets.py, P(L)
peaks over 0.2); each note to the next "l" or to the end of its sound; pitch = pYIN median over the vowel, less the
recording's tuning offset, snapped to the key (major key by Krumhansl over the notes).
Usage: .venv/bin/python la_transcribe.py <wav> <first_beat_s> <bpm> <notes_out.json>"""
import json, sys
import numpy as np, soundfile as sf, librosa
sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
from la_onsets import l_onsets
MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MAJOR = (0, 2, 4, 5, 7, 9, 11)

def transcribe(y16, first_beat):
    on, _, _, _ = l_onsets(y16, height=0.2)
    on = on[on >= first_beat - 0.15]
    f0, v, _ = librosa.pyin(y16, fmin=65, fmax=1000, sr=16000, frame_length=1024, hop_length=160)
    t = librosa.times_like(f0, sr=16000, hop_length=160)
    rms = librosa.feature.rms(y=y16, frame_length=1024, hop_length=160)[0]
    sounding = 20 * np.log10(rms / rms.max() + 1e-9) > -35
    notes = []
    for i, a in enumerate(on):
        b = on[i + 1] if i + 1 < len(on) else a + 1.5
        # the end of its sound, if the sound stops before the next "l"
        k = np.flatnonzero((t > a + 0.1) & (t < b) & ~sounding[: len(t)])
        end = float(t[k[0]]) if len(k) else float(b)
        sel = (t >= a + 0.06) & (t <= a + 0.06 + 0.75 * (end - a - 0.06)) & v & np.isfinite(f0)
        if sel.sum() < 3:
            raise ValueError(f"no pitch in the note starting at {a:.2f} s")
        notes.append([float(a), end, float(np.median(librosa.hz_to_midi(f0[sel])))])
    off = float(np.median([m - round(m) for _, _, m in notes]))
    h = np.zeros(12)
    for a, b, m in notes: h[int(round(m - off)) % 12] += b - a
    tonic = int(np.argmax([np.corrcoef(h, np.roll(MAJOR_PROFILE, k))[0, 1] for k in range(12)]))
    allowed = {(tonic + d) % 12 for d in MAJOR}
    out = []
    for a, b, m in notes:
        c = m - off
        q = min((round(c) + d for d in (-1, 0, 1)), key=lambda q: (q % 12 not in allowed, abs(q - c)))
        out.append({"onsetSec": round(a, 4), "offsetSec": round(b, 4), "midi": int(q)})
    return out, tonic

if __name__ == "__main__":
    wav, fb, bpm, out = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), sys.argv[4]
    y, sr = sf.read(wav, always_2d=True); y16 = librosa.resample(y.mean(1).astype(np.float32), orig_sr=sr, target_sr=16000)
    notes, tonic = transcribe(y16, fb)
    json.dump(notes, open(out, "w"))
    names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
    print(f"{len(notes)} notes, key {names[tonic]} major:", " ".join(names[n["midi"] % 12] for n in notes))
