"""Add rap vocals (docs/superpowers/specs/2026-11-27-rap-vocals-design.md): of several ACE takes of one section, the one
that raps its words most clearly.

Each take is separated with BS-RoFormer (pipeline.separate: ACE's takes carry some of the song's backing), the vocal is
transcribed with Whisper large-v3, and the take is scored by how many of the section's words were heard, in order
(`word_recall`); ties go to the cleaner separation (vocal level over what was left of the backing). Run by the ace-layer
adapter as a process of its own in this service's venv (tools/pick_rap_take.py), which has both models' code.
"""
from __future__ import annotations

import difflib
import math
import re
from dataclasses import dataclass

import numpy as np

WHISPER = "/mnt/d/casperaki-models/openai__whisper-large-v3"
ASR_SR = 16000


def words_of(text: str) -> list[str]:
    """Lowercase words, apostrophes and punctuation dropped ("Chasin' the sun!" -> chasin, the, sun)."""
    return re.findall(r"[a-z0-9]+", text.lower().replace("'", "").replace("’", ""))


def word_recall(words: str, heard: str) -> float:
    """The share of `words` found, in order, in `heard` (0..1)."""
    want = words_of(words)
    if not want:
        raise ValueError("word_recall: the section has no words to listen for")
    got = words_of(heard)
    m = difflib.SequenceMatcher(None, want, got, autojunk=False)
    return sum(b.size for b in m.get_matching_blocks()) / len(want)


def level_db(x: np.ndarray) -> float:
    rms = float(np.sqrt(np.mean(np.square(x, dtype=np.float64))))
    return -math.inf if rms == 0.0 else 20 * math.log10(rms)


@dataclass(frozen=True)
class TakeScore:
    recall: float
    vocal_db: float
    backing_db: float
    heard: str

    @property
    def separation_db(self) -> float:
        if self.vocal_db == -math.inf:
            return -math.inf
        return self.vocal_db - self.backing_db

    def as_json(self) -> dict:
        def finite(x: float):
            return None if not math.isfinite(x) else round(x, 2)
        return {"recall": round(self.recall, 3), "vocal_db": finite(self.vocal_db), "backing_db": finite(self.backing_db),
                "heard": self.heard}


def best_take(scores: list[TakeScore]) -> int:
    """The index of the best take: the most words heard, then the cleanest separation."""
    if not scores:
        raise ValueError("best_take: no takes")
    return max(range(len(scores)), key=lambda i: (scores[i].recall, scores[i].separation_db))


class Picker:
    """BS-RoFormer and Whisper loaded once; `score` separates and transcribes one take."""

    def __init__(self, device):
        import torch
        from transformers import pipeline as hf_pipeline

        from .separate import Separator

        self.separator = Separator(device)
        self.asr = hf_pipeline("automatic-speech-recognition", model=WHISPER, device=device, dtype=torch.float16)

    def score(self, audio: np.ndarray, sr: int, words: str, span: tuple[float, float]):
        """audio: samples x channels. span: the section's stretch of the take, in seconds. Returns (score, the separated
        vocal of the span as channels x samples at 44.1 kHz)."""
        import torch
        import torchaudio

        from .separate import SR

        vocals, backing = self.separator.separate(audio, sr)
        a, b = int(round(span[0] * SR)), int(round(span[1] * SR))
        if not 0 <= a < b <= vocals.shape[1] + 1:
            raise ValueError(f"rap pick: the section's span {span} is outside the take ({vocals.shape[1] / SR:.2f} s)")
        v, k = vocals[:, a:b], backing[:, a:b]
        mono = torchaudio.functional.resample(torch.from_numpy(np.ascontiguousarray(v.mean(0))), SR, ASR_SR).numpy()
        heard = self.asr(mono, generate_kwargs={"language": "en", "task": "transcribe"}, return_timestamps=True,
                         chunk_length_s=30)["text"].strip()
        return TakeScore(word_recall(words, heard), level_db(v), level_db(k), heard), v
