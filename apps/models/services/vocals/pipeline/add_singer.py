"""The add-singer stage: a recording the user uploads made into a new singer for Sing (a voice reference of about 10 s,
its description in SoulX-Singer's prompt format, and a short test line sung in the new voice).

params = {"upload" (absolute path of the uploaded file, any format ffmpeg reads, at most MAX_SECONDS long),
"separate" (true: the file is a full song, so its lead vocal is separated first; false: it is a voice alone),
"reference" ("beginning" or "best": how the voice reference is chosen, see pipeline/voice_cut.py)}. Every key is
required.

Steps, in order (one model on the graphics card at a time: each model step loads its model and releases it, the
SoulX-Singer-Preprocess steps in processes of their own, in their own venvs, by explicit python
path: pipeline.paths):
- decode: the upload read with ffmpeg (44.1 kHz; stereo when it is to be separated, mono otherwise);
- separate (only with "separate"): SoulX-Singer-Preprocess's karaoke separation and de-reverb (tools/soulx_preprocess.py);
  (no compression or Resemble Enhance: the owner, 2026-11-26: those are for recordings sung into a song, not for a
  singer's voice, which is taken as it is);
- silence: the silences cut, always (pipeline/voice_cut.py);
- reference: about 10 s chosen ("beginning" or "best"), ending at a pause;
- pitch: the reference's pitch curve (RMVPE, SoulX's pitch extractor, 20 ms frames);
- words: the words heard in it (tools/soulx_preprocess.py words);
- notes: a recording with words: its notes (tools/soulx_preprocess.py notes); "la la la" (told apart by the words
  heard, pipeline/voice_meta.is_la): every "l" a note start (wav2vec2 letter recogniser, on the cut voice around the
  reference for context) with its pitch from pYIN;
- test-line: SoulX-Singer sings TEST_LINE in the new voice, at the reference's register, through the vocal chain;
  its pitch checked against the line's notes (pYIN).

Writes add_singer.json = {"audio": "voice.wav", "meta": "voice.json", "testLine": "test_line.wav",
"reference": {"choice", "startSeconds", "endSeconds" (in the cut voice), "recordingStartSeconds",
"recordingEndSeconds" (in the recording as uploaded, or its separated vocal), "seconds"}, "transcription":
"words" | "la", "heard" (the words heard), "testLinePitch": {"notes", "within", "medianErrorSemitones"}}.
"""
from __future__ import annotations

import gc
import json
import os
import shutil
import subprocess
import time
from pathlib import Path

import numpy as np
import soundfile as sf

from . import levels, paths, voice_cut, voice_meta

STAGE = "add_singer"
REQUIRED = ("upload", "separate", "reference")
MAX_SECONDS = 300
SR = 44100
POLL_S = 0.5
LETTERS = "facebook/wav2vec2-base-960h"
L_HEIGHT, L_GAP_S, SOUNDING_DB, LA_CONTEXT_S = 0.2, 0.15, -35.0, 10.0

# The test line: "Here I am, I sing for you, can you hear my voice", one word per note, at TEST_BPM. Each note:
# (word, phonemes (ARPAbet, lowercase as the Vocal lane has them), start and length in beats, semitones above the
# line's lowest note). The line is moved so its middle note lies on the middle of the reference's notes.
TEST_BPM = 100
TEST_LINE = [
    ("here", ["hh", "iy1", "r"], 0, 1, 0), ("I", ["ay1"], 1, 1, 2), ("am", ["ae1", "m"], 2, 2, 4),
    ("I", ["ay1"], 4, 1, 4), ("sing", ["s", "ih1", "ng"], 5, 1, 5), ("for", ["f", "ao1", "r"], 6, 1, 4),
    ("you", ["y", "uw1"], 7, 2, 2),
    ("can", ["k", "ae1", "n"], 10, 1, 0), ("you", ["y", "uw1"], 11, 1, 2), ("hear", ["hh", "iy1", "r"], 12, 1, 4),
    ("my", ["m", "ay1"], 13, 1, 7), ("voice", ["v", "oy1", "s"], 14, 3, 4),
]
TEST_BARS = 5


def check_params(params: dict) -> dict:
    for k in REQUIRED:
        if k not in params:
            raise ValueError(f"add_singer: params lack {k!r}")
    upload = params["upload"]
    if not isinstance(upload, str) or not os.path.isabs(upload) or not os.path.isfile(upload):
        raise ValueError(f"add_singer: upload {upload!r} is not an existing absolute file path")
    if not isinstance(params["separate"], bool):
        raise ValueError(f"add_singer: separate must be true or false, got {params['separate']!r}")
    if params["reference"] not in voice_cut.CHOICES:
        raise ValueError(f"add_singer: reference must be one of {list(voice_cut.CHOICES)}, got {params['reference']!r}")
    return {"upload": upload, "separate": params["separate"], "reference": params["reference"]}


def minutes(seconds: float) -> str:
    m, s = divmod(int(round(seconds)), 60)
    return f"{m} min {s} s" if m and s else f"{m} min" if m else f"{s} s"


def decode(path: str, channels: int) -> np.ndarray:
    """The file decoded by ffmpeg at SR (samples x channels, float32)."""
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise RuntimeError("add_singer: ffmpeg is not on the PATH")
    r = subprocess.run([ffmpeg, "-v", "error", "-i", path, "-vn", "-ac", str(channels), "-ar", str(SR), "-f", "f32le", "-"],
                       capture_output=True)
    if r.returncode != 0:
        raise ValueError(f"The file could not be read as audio: {r.stderr.decode(errors='replace').strip()[-400:]}")
    x = np.frombuffer(r.stdout, dtype=np.float32).reshape(-1, channels)
    if len(x) == 0:
        raise ValueError("The file holds no audio.")
    return x


def run_tool(cmd: list[str], cwd: Path, job, what: str, log: Path) -> str:
    """Runs one of the tools/ scripts as its own process (polling for a cancel, which kills it): its last stdout line.
    Its output goes to `log`; a failure raises with the end of it."""
    with open(log, "w") as out:
        proc = subprocess.Popen(cmd, cwd=str(cwd), stdout=subprocess.PIPE, stderr=out, text=True)
        try:
            while proc.poll() is None:
                job.check_cancelled()  # raises on a cancel; the process is killed below
                time.sleep(POLL_S)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()
        stdout = proc.stdout.read()
    if proc.returncode != 0:
        tail = log.read_text(errors="replace").strip().splitlines()[-6:]
        raise RuntimeError(f"{what} failed (exit {proc.returncode}): " + " | ".join(tail))
    lines = [ln for ln in stdout.strip().splitlines() if ln.strip()]
    if not lines:
        raise RuntimeError(f"{what} printed no result")
    return lines[-1]


def _device():
    import torch

    if not torch.cuda.is_available():
        raise RuntimeError("add_singer: CUDA is not available")
    return torch.device("cuda")


def _release():
    import torch

    gc.collect()
    torch.cuda.empty_cache()


def pitch_curve(ref: Path, device) -> np.ndarray:
    """The reference's pitch curve (Hz per 20 ms frame at SoulX's 24 kHz / 480 hop), saved as <ref>_f0.npy."""
    from preprocess.tools.f0_extraction import F0Extractor

    if not paths.SOULX_RMVPE.is_file():
        raise FileNotFoundError(f"RMVPE weights missing: {paths.SOULX_RMVPE}")
    f0x = F0Extractor(str(paths.SOULX_RMVPE), device=str(device), target_sr=24000, hop_size=480, verbose=False)
    try:
        return np.asarray(f0x.process(str(ref), f0_path=str(ref.with_name(ref.stem + "_f0.npy"))), dtype=np.float32)
    finally:
        del f0x
        _release()


def l_onsets(y: np.ndarray, sr: int) -> np.ndarray:
    """Every "l" of an "la" recording (seconds): the peaks of the letter recogniser's P("L") over L_HEIGHT."""
    import librosa
    import torch
    from scipy.signal import find_peaks
    from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor

    y16 = librosa.resample(np.asarray(y, dtype=np.float32), orig_sr=sr, target_sr=16000)
    proc = Wav2Vec2Processor.from_pretrained(LETTERS)
    model = Wav2Vec2ForCTC.from_pretrained(LETTERS).eval()
    with torch.no_grad():
        logits = model(proc(y16, sampling_rate=16000, return_tensors="pt").input_values).logits[0]
    p_l = torch.softmax(logits, -1)[:, proc.tokenizer.convert_tokens_to_ids("L")].numpy()
    frame = len(y16) / 16000 / len(p_l)
    peaks, _ = find_peaks(p_l, height=L_HEIGHT, distance=max(1, int(L_GAP_S / frame)))
    return peaks * frame


def la_description(voice: np.ndarray, ref: np.ndarray, sr: int, ref_from: float, clip_s: float, f0, index: str) -> dict:
    """The SoulX description of an "la" reference: its "l"s found on the cut voice around it (LA_CONTEXT_S each
    side), its pitch per note from pYIN on the reference itself."""
    import librosa

    a = max(0.0, ref_from - LA_CONTEXT_S)
    b = min(len(voice) / sr, ref_from + clip_s + LA_CONTEXT_S)
    onsets = l_onsets(voice[int(a * sr): int(b * sr)], sr) + a - ref_from
    onsets = onsets[(onsets >= -0.05) & (onsets < clip_s - 0.1)]
    onsets = np.maximum(onsets, 0.0)
    y16 = librosa.resample(np.asarray(ref, dtype=np.float32), orig_sr=sr, target_sr=16000)
    f0_16, voiced, _ = librosa.pyin(y16, fmin=65, fmax=1000, sr=16000, frame_length=1024, hop_length=160)
    times = librosa.times_like(f0_16, sr=16000, hop_length=160)
    midi = np.where(voiced & np.isfinite(f0_16), librosa.hz_to_midi(np.nan_to_num(f0_16, nan=1.0)), np.nan)
    rms = librosa.feature.rms(y=y16, frame_length=1024, hop_length=160)[0][: len(times)]
    sounding = 20 * np.log10(rms / rms.max() + 1e-9) > SOUNDING_DB
    notes = voice_meta.la_notes(onsets, times, midi, sounding, clip_s)
    return voice_meta.la_meta(notes, clip_s, f0, index)


def test_notes(meta: dict) -> list[dict]:
    """TEST_LINE as Sing's notes, moved so its middle note is the middle of the reference's sung notes."""
    sung = sorted(int(p) for p in meta["note_pitch"].split() if int(p) > 0)
    if not sung:
        raise ValueError("the voice description has no sung note")
    centre = int(np.median(sung))
    line_mid = int(np.median([n[4] for n in TEST_LINE]))
    base = centre - line_mid
    return [{"start": s, "duration": d, "midi": base + st, "word": w, "phonemes": list(ph)} for w, ph, s, d, st in TEST_LINE]


def pitch_check(y: np.ndarray, sr: int, notes) -> dict:
    """The sung test line's pitch against its notes: per note the pYIN median over its middle half."""
    import librosa

    y = librosa.resample(np.asarray(y, dtype=np.float32), orig_sr=sr, target_sr=22050)
    f0, voiced, _ = librosa.pyin(y, fmin=65, fmax=1000, sr=22050, frame_length=2048, hop_length=256)
    t = librosa.times_like(f0, sr=22050, hop_length=256)
    beat = 60.0 / TEST_BPM
    errs = []
    for n in notes:
        a, b = n["start"] * beat, (n["start"] + n["duration"]) * beat
        a, b = a + 0.25 * (b - a), b - 0.25 * (b - a)
        m = (t >= a) & (t < b) & voiced & np.isfinite(f0)
        if m.any():
            errs.append(abs(float(librosa.hz_to_midi(np.median(f0[m]))) - n["midi"]))
    return {"notes": len(notes), "within": sum(1 for e in errs if e <= 0.5),
            "medianErrorSemitones": round(float(np.median(errs)), 2) if errs else -1.0}


def run(params: dict, out_dir, job):
    p = check_params(params)
    out = Path(out_dir)

    job.check_cancelled()
    st = job.step("decode", "Read the recording")
    x = decode(p["upload"], 2 if p["separate"] else 1)
    seconds = len(x) / SR
    if seconds > MAX_SECONDS:
        raise ValueError(f"The recording is {minutes(seconds)} long: a singer's recording can be at most "
                         f"{minutes(MAX_SECONDS)}.")
    sf.write(out / "recording.wav", x, SR, subtype="FLOAT")
    st.done(f"{minutes(seconds)}", {"seconds": round(seconds, 2)}, ["recording.wav"])

    voice_path = out / "recording.wav"
    if p["separate"]:
        job.check_cancelled()
        st = job.step("separate", "Separate the vocals from the music")
        res = json.loads(run_tool([str(paths.SOULX_PREPROCESS_PYTHON), str(paths.TOOLS_DIR / "soulx_preprocess.py"),
                                   "separate", str(voice_path), str(out / "vocals.wav")], paths.SOULX_REPO, job,
                                  "Vocal separation", out / "separate.log"))
        voice_path = out / "vocals.wav"
        st.done("the lead vocal, without its reverb", {"seconds": res["seconds"]}, ["vocals.wav"])

    job.check_cancelled()
    st = job.step("silence", "Cut the silences")
    e, esr = sf.read(voice_path, always_2d=True)
    e = e.mean(axis=1).astype(np.float32)
    cut, pieces = voice_cut.cut_silence(e, esr)
    sf.write(out / "voice_cut.wav", cut, esr, subtype="FLOAT")
    st.done(f"{len(e) / esr:.1f} s -> {len(cut) / esr:.1f} s", {"before": round(len(e) / esr, 2),
                                                                "after": round(len(cut) / esr, 2), "pieces": len(pieces)},
            ["voice_cut.wav"])

    job.check_cancelled()
    st = job.step("reference", f"Choose the voice reference ({voice_cut.CHOICE_LABELS[p['reference']]})")
    mask = voice_cut.singing_mask(cut, esr, voice_cut.PAUSE_DB)
    phr = voice_cut.phrases(cut, esr)

    def sung(a, b):
        return float(mask[int(round(a / voice_cut.HOP_S)): int(round(b / voice_cut.HOP_S))].sum()) * voice_cut.HOP_S

    a, b = voice_cut.choose_reference(phr, p["reference"], sung)
    ref, ref_from, _ = voice_cut.clip(cut, esr, phr, a, b)
    clip_s = len(ref) / esr
    ref_path = out / "voice.wav"
    sf.write(ref_path, ref, esr, subtype="PCM_16")
    reference = {"choice": p["reference"], "startSeconds": round(a, 2), "endSeconds": round(b, 2),
                 "recordingStartSeconds": round(voice_cut.recording_time(a, pieces), 2),
                 "recordingEndSeconds": round(voice_cut.recording_time(b, pieces), 2), "seconds": round(clip_s, 2)}
    st.done(f"{clip_s:.1f} s, from {reference['recordingStartSeconds']:.2f} s to {reference['recordingEndSeconds']:.2f} s "
            f"of the recording (ends at a pause)", {k: v for k, v in reference.items() if k != "choice"}, ["voice.wav"])

    device = _device()
    job.check_cancelled()
    st = job.step("pitch", "Read the voice reference's pitch")
    f0 = pitch_curve(ref_path, device)
    st.done(f"{len(f0)} frames, {int((f0 > 0).sum())} voiced", {"frames": len(f0)}, [])

    job.check_cancelled()
    st = job.step("words", "Hear the words")
    run_tool([str(paths.SOULX_PREPROCESS_PYTHON), str(paths.TOOLS_DIR / "soulx_preprocess.py"), "words",
              str(ref_path), str(out / "words.json")], paths.SOULX_REPO, job, "Lyric transcription", out / "words.log")
    w = json.loads((out / "words.json").read_text())
    heard = " ".join(x for x in w["words"] if x != voice_meta.REST)
    la = voice_meta.is_la(w["words"])
    st.done(f"\"{heard}\" ({'sung as la la la' if la else 'words'})", {"words": len(heard.split())}, ["words.json"])

    job.check_cancelled()
    st = job.step("notes", "Transcribe the notes")
    if la:
        meta = la_description(cut, ref, esr, ref_from, clip_s, f0, ref_path.stem)
    else:
        run_tool([str(paths.SOULX_PREPROCESS_PYTHON), str(paths.TOOLS_DIR / "soulx_preprocess.py"), "notes",
                  str(ref_path), str(out / "words.json"), str(out / "notes.json")], paths.SOULX_REPO, job,
                 "Note transcription", out / "notes.log")
        meta = voice_meta.words_meta(json.loads((out / "notes.json").read_text()), clip_s, f0, ref_path.stem)
    voice_meta.check_meta(meta, clip_s)
    (out / "voice.json").write_text(json.dumps([meta], ensure_ascii=False, indent=1))
    n_notes = sum(1 for t in meta["note_type"].split() if t != "1")
    how = 'every note an "la"' if la else "on the words heard"
    st.done(f"{n_notes} notes ({how})", {"notes": n_notes}, ["voice.json"])

    job.check_cancelled()
    st = job.step("test-line", "Sing a test line in the new voice")
    from . import chain
    from .soulx import Singer

    notes = test_notes(meta)
    singer = Singer(device, ref_path, out / "voice.json")
    try:
        raw = singer.sing(notes, TEST_BPM, TEST_BARS, "the test line")
        raw_sr = singer.sr
    finally:
        singer.close()
        _release()
    check = pitch_check(raw, raw_sr, notes)
    y = chain.process(raw[:, None], raw_sr)
    y = y[:, 0] if y.ndim == 2 else y
    sf.write(out / "test_line.wav", y, chain.OUT_SR, subtype="PCM_16")
    st.done(f"\"{' '.join(n['word'] for n in notes)}\": {check['within']} of {check['notes']} notes within half a "
            f"semitone", check, ["test_line.wav"])

    result = {"audio": "voice.wav", "meta": "voice.json", "testLine": "test_line.wav", "reference": reference,
              "transcription": "la" if la else "words", "heard": heard, "testLinePitch": check}
    (out / "add_singer.json").write_text(json.dumps(result, indent=1))
    return {"file": str(out / "add_singer.json"), "kind": "json"}
