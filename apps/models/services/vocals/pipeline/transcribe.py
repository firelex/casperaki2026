"""A sung section transcribed by note count: the N strongest note starts of the take, one per position of our lane.

Ported from apps/models/ace-vocal-tests/other-models/syllable_notes.py (shared tree), the method behind both demos:
- onset envelope = onset strength (normalised) + 0.5 x the pitch change between voiced frames (|semitones| / 2,
  clipped to 1), so legato pitch changes count as starts too (the experiment also counted voicing on/off as a pitch
  change, which made every note's end a candidate start);
- a candidate start is a local maximum of the envelope (at least MIN_STRENGTH of its maximum: weaker ones are ripple
  inside a held note; the experiment had no floor) where the voice is singing and pitched singing follows within
  80 ms (breaths and lone consonants are not starts);
- the N strongest candidates, each on its own 16th of our grid (as rounded for the notes) and at least MIN_GAP_S
  apart (`pick_starts`); fewer than N -> TranscribeError("<section>: found K of N note starts");
- a note lasts until the next start or until singing stops; its pitch is the SwiftF0 median over it (the hum service's
  pitch front end), moved by octaves when it is more than 7 semitones from its neighbours' median
  (`fix_octave_slips`), snapped to the key's scale, returned in the Vocal lane's register (sung - octave).
The take is read unstretched through a Clock (music.py: take seconds <-> our beats). Starts must lie inside the
section's beats; the bars after it (the tail) may only hold the end of the last note, which is cut at the section end.

The stage `transcribe` (`run`, Transcribe melody in the app): the user's own recording of one section, sung or hummed
along from the section's first beat at the song's tempo (so the recording is on our grid: Clock.grid(bpm)).
params = {"section", "bpm", "key", "octave" (-12/0/12: notes come back as sung - octave; the brain sends 0 and moves them itself),
"section_beats", "count" (the section's Vocal-lane notes, held "-" positions included; null: only prepare the voice,
for the brain to send to the hum service when the section has no written lyrics), "has_backing" (the recording has
music behind the voice: BS-RoFormer separates the voice first; a clean recording is read as it is), "audio" (the
recording as base64 WAV: the brain decodes whatever the user brings with ffmpeg)}. Every key is required.
Steps: recording:<section> (seconds; file <section>_recording.wav), separate:<section> (only with has_backing; files
<section>_recording_vocals.wav, <section>_recording_backing.wav), transcribe:<section> (only with a count; notes;
file <section>_melody.json). Writes transcribe.json = {"section", "voice" (the file the notes were read from),
"notes": [{"start", "duration", "midi"}] or null}.
"""
from __future__ import annotations

import base64
import io
import json
from pathlib import Path

import numpy as np

from .music import Clock, check_octave, scale

SR16 = 16000
HOP = 160  # 10 ms frames
FRAME_S = HOP / SR16
PAD = 10  # frames of silence analysed in front of the audio
MIN_GAP_S = 0.09
MIN_STRENGTH = 0.05  # of the envelope's maximum: weaker local maxima are ripple, not starts
OCTAVE_SLIP = 7  # semitones from the neighbours' median beyond which a note is moved by octaves
PITCHED_WITHIN = 8  # frames (80 ms): a start must be followed by pitched singing this soon
SINGING = 0.02  # a frame is singing when its RMS is above this share of the take's loudest frame
FMIN_HZ, FMAX_HZ = 50.0, 1600.0  # the hum service's SwiftF0 range
CONFIDENCE = 0.1  # SwiftF0 is right on pitch well before it is confident (it ramps up over ~100 ms of a note);
# the singing gate already says where the voice is, so a low bar keeps short notes measurable


class TranscribeError(Exception):
    """A sung take could not be transcribed to our lane's notes (the message names the section)."""


def snap(midi: int, pcs) -> int:
    """The nearest note of the scale (a chromatic note goes to the closer neighbour, down on a tie)."""
    return min((midi + d for d in (0, -1, 1)), key=lambda m: (m % 12 not in pcs, abs(m - midi), m))


def to_mono16k(vocal, sr: int) -> np.ndarray:
    import torch
    import torchaudio

    y = np.asarray(vocal, dtype=np.float32)
    if y.ndim == 2:
        y = y.mean(axis=0)
    if y.ndim != 1:
        raise ValueError(f"vocal must be samples or channels x samples, got shape {np.shape(vocal)}")
    if sr != SR16:
        y = torchaudio.functional.resample(torch.from_numpy(y), sr, SR16).numpy()
    return y


class PitchTracker:
    """SwiftF0 on 16 kHz audio (CPU, ONNX)."""

    def __init__(self):
        from swift_f0 import SwiftF0

        self.swift = SwiftF0()

    def track(self, y16: np.ndarray):
        """(frame times in s, MIDI pitch per frame with NaN where unvoiced)."""
        import librosa

        r = self.swift.detect(y16, SR16, fmin=FMIN_HZ, fmax=FMAX_HZ)
        voiced = (r.confidence >= CONFIDENCE) & np.isfinite(r.pitch_hz) & (r.pitch_hz > 0)
        midi = np.full(len(r.pitch_hz), np.nan)
        midi[voiced] = librosa.hz_to_midi(r.pitch_hz[voiced])
        return np.asarray(r.timestamps, dtype=float), midi


def _frames(y: np.ndarray, tracker):
    """Per 10 ms frame: SwiftF0 MIDI pitch (NaN unvoiced), onset envelope, singing gate. The audio is analysed with
    PAD frames of silence in front (dropped again), so a note at the very start still has an onset before it."""
    import librosa

    y = np.concatenate([np.zeros(PAD * HOP, dtype=np.float32), y])
    n = len(y) // HOP + 1
    times, f0 = tracker.track(y)
    idx = np.clip(np.searchsorted(times, np.arange(n) * FRAME_S), 0, len(times) - 1)
    midi = f0[idx]
    onset = librosa.onset.onset_strength(y=y, sr=SR16, hop_length=HOP)
    onset = np.pad(onset, (0, max(0, n - len(onset))))[:n]
    # pitch changes between voiced frames only: voicing on/off is not a pitch change (an onset shows in the onset
    # strength; counting voicing-off made every note's end a candidate start)
    dpitch = np.nan_to_num(np.abs(np.diff(midi, prepend=np.nan)), nan=0.0)
    env = onset / (onset.max() + 1e-9) + 0.5 * np.clip(dpitch / 2, 0, 1)
    rms = librosa.feature.rms(y=y, hop_length=HOP)[0]  # centred frames, aligned with the onset envelope (as ported)
    rms = np.pad(rms, (0, max(0, n - len(rms))))[:n]
    return midi[PAD:], env[PAD:], (rms > SINGING * rms.max())[PAD:]


def segment(vocal, sr: int, n: int, bpm, *, key: str, octave: int, section: str, tracker, section_beats,
            clock: Clock | None = None):
    """The `n` notes of a sung section. vocal: samples, or channels x samples, at `sr`. clock: the vocal's seconds <->
    our beats; None means the vocal is on our grid (Clock.grid(bpm)).
    Returns [{"start", "duration" (beats from the section start, on 16ths), "midi" (lane register), "start_s",
    "stop_s" (seconds in the vocal)}] in order."""
    octave = check_octave(octave)
    pcs = scale(key)
    clock = Clock.grid(bpm) if clock is None else clock
    if n < 1:
        raise ValueError(f"{section}: {n} notes to find")
    y = to_mono16k(vocal, sr)
    midi, env, singing = _frames(y, tracker)
    nf = len(env)
    beats = clock.beats(np.arange(nf) * FRAME_S)
    a = max(1, int(np.floor(float(clock.seconds(0.0)) / FRAME_S)))
    b = min(nf - 1, int(np.ceil(float(clock.seconds(section_beats)) / FRAME_S)))

    def pitched(k):
        return not np.isnan(midi[k:k + PITCHED_WITHIN]).all()

    floor = MIN_STRENGTH * env.max()
    peaks = [k for k in range(a, b) if env[k] >= env[k - 1] and env[k] > env[k + 1] and env[k] >= floor and singing[k]
             and round(beats[k] * 4) < round(section_beats * 4) and pitched(k)]
    peaks.sort(key=lambda k: -env[k])
    chosen = pick_starts(peaks, beats, n)
    if len(chosen) < n:
        raise TranscribeError(f"{section}: found {len(chosen)} of {n} note starts")
    chosen.sort()

    sec_end = int(round(section_beats * 4))
    qs = [int(round(beats[k] * 4)) for k in chosen]
    assert all(x < y for x, y in zip(qs, qs[1:])), f"{section}: two starts share a 16th: {qs}"
    found = []  # (stop frame, sung pitch)
    for i, k in enumerate(chosen):
        end = chosen[i + 1] if i + 1 < n else nf
        stop = next((f for f in range(k, end) if not singing[f]), end)
        seg = midi[k:max(stop, min(k + PITCHED_WITHIN, end))]
        seg = seg[~np.isnan(seg)]
        if len(seg) == 0:
            raise TranscribeError(f"{section}: note {i + 1} at {k * FRAME_S:.2f} s has no pitch")
        found.append((stop, int(round(float(np.median(seg))))))
    pitches = fix_octave_slips([p for _, p in found])
    out = []
    for i, (k, (stop, _), sung) in enumerate(zip(chosen, found, pitches)):
        q = qs[i]
        e = max(q + 1, int(round(float(clock.beats(stop * FRAME_S)) * 4)))
        if i + 1 < n:
            e = min(e, qs[i + 1])
        e = min(e, sec_end)
        out.append({"start": q / 4, "duration": (e - q) / 4, "midi": int(snap(sung, pcs) - octave),
                    "start_s": round(k * FRAME_S, 3), "stop_s": round(stop * FRAME_S, 3)})
    return out


def pick_starts(order, beats, n: int) -> list[int]:
    """Up to `n` start frames from `order` (candidates, strongest first): each on its own 16th of our grid (rounded
    as the notes will be) and at least MIN_GAP_S from every one already taken. Returned in time order."""
    chosen, taken = [], set()
    for k in order:
        q = int(round(float(beats[k]) * 4))
        if q in taken or any(abs(k - c) * FRAME_S < MIN_GAP_S for c in chosen):
            continue
        chosen.append(k)
        taken.add(q)
        if len(chosen) == n:
            break
    return sorted(chosen)


def fix_octave_slips(pitches: list[int]) -> list[int]:
    """A note more than OCTAVE_SLIP semitones from the median of its neighbours (up to 2 on each side; those before it
    as already corrected, so one slipped note does not drag the next one)
    moves by whole octaves toward that median until within OCTAVE_SLIP: a pitch tracker's octave error, or a slip in
    the take. A genuine leap of OCTAVE_SLIP or fewer semitones is kept."""
    out = []
    for i, p in enumerate(pitches):
        nb = out[max(0, i - 2):i] + list(pitches[i + 1:i + 3])  # the notes before as corrected
        if nb:
            m = float(np.median(nb))
            while p - m > OCTAVE_SLIP:
                p -= 12
            while m - p > OCTAVE_SLIP:
                p += 12
        out.append(p)
    return out


PARAMS = ("section", "bpm", "key", "octave", "section_beats", "count", "has_backing", "audio")


def separate_voice(audio, sr: int, out: Path, section: str, job):
    """BS-RoFormer on the recording (channels x samples): (voice as channels x samples, its rate, its file name)."""
    import gc

    import soundfile as sf
    import torch

    from .separate import SR, Separator

    if not torch.cuda.is_available():
        raise RuntimeError("transcribe: separating the voice needs CUDA, which is not available")
    st = job.step(f"separate:{section}", f"Separate the voice of the recording of {section}")
    sep = Separator(torch.device("cuda"))
    try:
        vocals, backing = sep.separate(np.asarray(audio).T, sr)
    finally:
        sep.close()
        gc.collect()
    names = [f"{section}_recording_vocals.wav", f"{section}_recording_backing.wav"]
    sf.write(out / names[0], vocals.T, SR)
    sf.write(out / names[1], backing.T, SR)
    st.done("voice and backing separated", {}, names)
    return vocals, SR, names[0]


def run(params: dict, out_dir, job):
    import soundfile as sf

    for k in PARAMS:
        if k not in params:
            raise ValueError(f"transcribe: missing param {k!r}")
    section = params["section"]
    if not isinstance(section, str) or not section:
        raise ValueError(f"transcribe: param 'section' must be a section name, got {section!r}")
    bpm = float(params["bpm"])
    key = params["key"]
    octave = check_octave(params["octave"])
    section_beats = float(params["section_beats"])
    count = params["count"]
    if count is not None and (not isinstance(count, int) or count < 1):
        raise ValueError(f"transcribe: param 'count' must be a whole number of notes (1 or more) or null, got {count!r}")
    if not isinstance(params["has_backing"], bool):
        raise ValueError(f"transcribe: param 'has_backing' must be true or false, got {params['has_backing']!r}")
    scale(key)
    out = Path(out_dir)

    job.check_cancelled()
    st = job.step(f"recording:{section}", f"Read the recording of {section}")
    try:
        audio, sr = sf.read(io.BytesIO(base64.b64decode(params["audio"], validate=True)), dtype="float32", always_2d=True)
    except Exception as e:
        raise ValueError(f"transcribe: the recording of {section} is not a readable WAV file: {e}") from e
    if len(audio) == 0:
        raise ValueError(f"transcribe: the recording of {section} is empty")
    voice_name = f"{section}_recording.wav"
    sf.write(out / voice_name, audio, sr)
    st.done(f"{len(audio) / sr:.1f} s", {"seconds": round(len(audio) / sr, 2)}, [voice_name])
    voice = audio.T  # channels x samples

    if params["has_backing"]:
        job.check_cancelled()
        voice, sr, voice_name = separate_voice(voice, sr, out, section, job)

    notes = None
    if count is not None:
        job.check_cancelled()
        ts = job.step(f"transcribe:{section}", f"Write down the sung melody of {section}")
        try:
            found = segment(voice, sr, count, bpm, key=key, octave=octave, section=section, tracker=PitchTracker(),
                            section_beats=section_beats)
        except TranscribeError as e:
            ts.fail(str(e))
            raise
        notes = [{"start": n["start"], "duration": n["duration"], "midi": n["midi"]} for n in found]
        (out / f"{section}_melody.json").write_text(json.dumps(notes, indent=0))
        ts.done(f"{len(notes)} notes", {"notes": len(notes)}, [f"{section}_melody.json"])

    (out / "transcribe.json").write_text(json.dumps({"section": section, "voice": voice_name, "notes": notes}, indent=1))
    return {"file": str(out / "transcribe.json"), "kind": "json"}
