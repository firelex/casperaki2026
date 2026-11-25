"""A sung section transcribed to one note per syllable of OUR words.

Starts: forced alignment of the unit's syllables (romanised lower-case text) to the vocal with torchaudio's MMS aligner
(MMS_FA, 16 kHz), one lyric line at a time inside that line's bars (so one badly sung line cannot drag the others): a
syllable starts where its first letter is aligned. Times in the take become our beats through a Clock (align.py): a take
is read unstretched through its bar map, since a phase-vocoder stretch smears consonants past what the aligner knows. A syllable ends at the next syllable's start, or
earlier where singing stops. Pitch: the median of SwiftF0 (the hum service's pitch front end) over the sung part of the
syllable, rounded to a semitone and snapped to the key's scale; returned in the Vocal lane's register (sung - octave).
Starts and durations are quantised to 16ths; two syllables never share a 16th (a collision moves the later syllable to
the next 16th when that is free and within a 16th of where it was sung, otherwise it is an error).

Ported in part from apps/models/ace-vocal-tests/other-models/syllable_notes.py (shared tree): the singing gate and the
scale snap; its onset heuristics are replaced by the forced alignment.
"""
from __future__ import annotations

import gc
import unicodedata

import numpy as np

from .align import Clock
from .score import check_octave, scale

SR16 = 16000
LINE_MARGIN_S = 0.25  # audio kept around a line's bars when aligning it (a syllable sung a hair early or late)
HOP = 160  # 10 ms frames for the singing gate
SINGING = 0.02  # a frame is singing when its RMS is above this share of the take's loudest frame
FMIN_HZ, FMAX_HZ = 50.0, 1600.0  # the hum service's SwiftF0 range
CONFIDENCE = 0.1  # SwiftF0 is right on pitch well before it is confident (it ramps up over ~100 ms of a note);
# the singing gate already says where the voice is, so a low bar keeps short syllables measurable


class TranscribeError(Exception):
    """A sung take could not be transcribed to our words (the message names the section and the word)."""


def romanise(text: str) -> str:
    """Lower-case letters and apostrophes only (accents dropped): what the MMS aligner's dictionary holds."""
    plain = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()
    out = "".join(c for c in plain if c.isalpha() or c == "'")
    if not any(c.isalpha() for c in out):
        raise ValueError(f"syllable {text!r} has no letters to align")
    return out


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


class MmsAligner:
    """torchaudio's MMS forced aligner: (16 kHz audio, syllable texts, window start_s, end_s) -> [(start_s, end_s)]
    per syllable, in seconds of the whole audio, aligned inside the window."""

    def __init__(self, device):
        import torchaudio

        bundle = torchaudio.pipelines.MMS_FA
        self.device = device
        self.model = bundle.get_model(with_star=False).to(device).eval()
        self.tokenizer = bundle.get_tokenizer()
        self.aligner = bundle.get_aligner()

    def __call__(self, y16: np.ndarray, texts: list[str], start_s: float, end_s: float):
        import torch

        a, b = int(start_s * SR16), int(end_s * SR16)
        wave = torch.from_numpy(np.ascontiguousarray(y16[a:b], dtype=np.float32))[None].to(self.device)
        with torch.inference_mode():
            emission, _ = self.model(wave)
        tokens = self.tokenizer(texts)
        n_tokens = sum(len(t) for t in tokens)
        if n_tokens > emission.shape[1]:
            raise TranscribeError(f"{n_tokens} letters to align but the take has only {emission.shape[1]} frames")
        spans = self.aligner(emission[0], tokens)
        frame_s = wave.shape[1] / emission.shape[1] / SR16
        return [(a / SR16 + s[0].start * frame_s, a / SR16 + s[-1].end * frame_s) for s in spans]

    def close(self):
        import torch

        self.model = None
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()


def _full_words(syllables: list[str]) -> list[str]:
    """The whole word each syllable belongs to ("Street-", "lights" -> "Streetlights" for both)."""
    out, cur = [], []
    for i, s in enumerate(syllables):
        cur.append(i)
        if not s.endswith("-") or i == len(syllables) - 1:
            word = "".join(syllables[k].rstrip("-") for k in cur)
            out += [word] * len(cur)
            cur = []
    return out


def syllable_notes(vocal, sr: int, words_per_line, bpm, *, key: str, octave: int, section: str, aligner, tracker,
                   line_beats, clock: Clock | None = None):
    """One note per syllable of `words_per_line` ([[syllable text] per line]; "Un-" continues its word).
    vocal: samples, or channels x samples, at `sr`. line_beats: (start, end) of each line in our beats (the window its
    words are aligned in). clock: the vocal's seconds <-> our beats (align.take_clock for a take); None means the vocal
    is on our grid (Clock.grid(bpm)).
    Returns [{"start": beats, "duration": beats, "midi": lane-register note, "word": syllable text}] in order."""
    octave = check_octave(octave)
    pcs = scale(key)
    clock = Clock.grid(bpm) if clock is None else clock
    if len(line_beats) != len(words_per_line):
        raise ValueError(f"{section}: {len(line_beats)} line windows for {len(words_per_line)} lines")
    syllables = [s for line in words_per_line for s in line]
    if not syllables:
        raise TranscribeError(f"{section}: no words to transcribe")
    words = _full_words(syllables)
    y = to_mono16k(vocal, sr)
    dur = len(y) / SR16
    spans = []
    for li, (line, (b0, b1)) in enumerate(zip(words_per_line, line_beats)):
        if not line:
            continue
        w0 = max(0.0, float(clock.seconds(b0)) - LINE_MARGIN_S)
        w1 = min(dur, float(clock.seconds(b1)) + LINE_MARGIN_S)
        if w1 - w0 < 0.1:
            raise TranscribeError(f"{section}: line {li + 1} (beats {b0:g}-{b1:g}) is not in the take")
        got = aligner(y, [romanise(s) for s in line], w0, w1)
        if len(got) != len(line):
            raise TranscribeError(f"{section}: the aligner placed {len(got)} of {len(line)} syllables of line {li + 1}")
        spans += got
    last_end = min(dur, float(clock.seconds(line_beats[-1][1])) + LINE_MARGIN_S)
    times, f0 = tracker.track(y)
    rms = np.sqrt(np.mean(np.lib.stride_tricks.sliding_window_view(np.pad(y, (0, HOP)), HOP)[::HOP] ** 2, axis=1))
    singing = rms > SINGING * rms.max()

    raw = []  # (start_s, stop_s, midi)
    for k, (t0, _) in enumerate(spans):
        t_next = spans[k + 1][0] if k + 1 < len(spans) else last_end
        f_a, f_b = int(t0 / (HOP / SR16)), min(int(np.ceil(t_next / (HOP / SR16))), len(singing))
        on = next((f for f in range(f_a, f_b) if singing[f]), None)
        if on is None:
            raise TranscribeError(f"{section}: could not find the word '{words[k]}' in the take")
        stop = next((f for f in range(on, f_b) if not singing[f]), f_b)
        stop_s = min(stop * HOP / SR16, t_next)
        sel = (times >= on * HOP / SR16) & (times < stop_s) & np.isfinite(f0)
        if not sel.any():
            raise TranscribeError(f"{section}: could not find the word '{words[k]}' in the take (no sung pitch)")
        raw.append((t0, stop_s, snap(int(round(float(np.median(f0[sel])))), pcs) - octave))

    starts = []
    at = [float(clock.beats(t0)) * 4 for t0, _, _ in raw]  # starts in 16ths of our section
    for k, x in enumerate(at):
        q = int(round(x))
        if starts and q <= starts[-1]:
            q2 = starts[-1] + 1
            nxt = int(round(at[k + 1])) if k + 1 < len(at) else None
            if abs(x - q2) > 1 or (nxt is not None and nxt <= q2):
                raise TranscribeError(f"{section}: the word '{words[k]}' (syllable '{syllables[k]}') falls on the "
                                      f"same 16th as the syllable before it, at beat {starts[-1] / 4:g}")
            q = q2
        starts.append(q)
    out = []
    for k, (q, (_, stop_s, midi)) in enumerate(zip(starts, raw)):
        end = max(q + 1, int(round(float(clock.beats(stop_s)) * 4)))
        if k + 1 < len(starts):
            end = min(end, starts[k + 1])
        out.append({"start": q / 4, "duration": (end - q) / 4, "midi": int(midi), "word": syllables[k]})
    return out
