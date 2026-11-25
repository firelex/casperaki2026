"""SoulX-Singer sings a section from its notes and phonemes (score control), in the voice of the owner's approved demo
(`yue2_female_dry2`, a dry female voice prompt kept in this service's voices/ folder: paths.VOICE_AUDIO / VOICE_META).

Ported from apps/models/ace-vocal-tests/soulx_sing.py (shared tree): the phrasing of the removed brain score builder
(a phrase per 4-bar lyric line, split at a rest of a beat or more, a short breath rest before each phrase). The service
does no g2p: every note carries the lane's Vocaloid phonemes (lowercase, stress digits), written for SoulX as
"en_" + the phonemes upper-cased and joined with "-". SoulX sings the lane's notes at their own pitch.
The SoulX repo (pipeline.paths.SOULX_REPO) must be on sys.path (the adapter's load() puts it there).
"""
from __future__ import annotations

import gc
import json

import numpy as np
import torch

from . import paths

LINE_BARS, SPLIT_REST_BEATS, LEAD_REST_SEC, MIN_REST_SEC = 4, 1.0, 0.25, 0.02
TAIL_S = 2.0  # room after the section for a last phrase's release
# A phrase's last note is sung up to CODA_BEATS longer, into the rest after it (keeping BREATH_BEATS before the next
# phrase or the section's end): given only the written length, SoulX swallowed final consonants ("walls", "stones":
# 27-28 dB under the vowel; extended, 13 and 22 dB; owner's idea, 2026-11-25). Only what SoulX is given changes.
CODA_BEATS, BREATH_BEATS = 1.0, 0.5


def phrase_groups(notes) -> list[list[dict]]:
    """The notes (sorted by "start", each with "start" and "duration" in beats) split into the phrases SoulX sings one
    at a time: a phrase per LINE_BARS-bar lyric line, split again at a rest of SPLIT_REST_BEATS or more."""
    groups = []
    for i, n in enumerate(notes):
        start = float(n["start"])
        prev = notes[i - 1] if i else None
        if prev is not None:
            prev_end = float(prev["start"]) + float(prev["duration"]) if "duration" in prev else float(prev["end"])
        if (prev is None or int(start // 4) // LINE_BARS != int(float(prev["start"]) // 4) // LINE_BARS
                or start - min(prev_end, start) >= SPLIT_REST_BEATS):
            groups.append([])
        groups[-1].append(n)
    return groups


def phrases(notes, bpm, section_beats, *, section: str = "section"):
    """SoulX score phrases: [{"start" (seconds from the section start), "phoneme", "duration" (s), "pitch" (MIDI,
    0 for a rest), "type" (1 rest, 2 note)}]. notes: [{"start", "duration" (beats), "midi", "phonemes"}]."""
    beat_s = 60.0 / float(bpm)
    ns = []
    for n in sorted(notes, key=lambda n: n["start"]):
        if not n.get("phonemes"):
            raise ValueError(f"{section}: the note at beat {n['start']:g} has no phonemes")
        start = float(n["start"])
        ns.append({"bar": int(start // 4), "start": start, "end": start + float(n["duration"]),
                   "midi": int(n["midi"]), "phones": "en_" + "-".join(p.upper() for p in n["phonemes"])})
    groups = phrase_groups(ns)
    for gi, g in enumerate(groups):
        nxt = groups[gi + 1][0]["start"] if gi + 1 < len(groups) else float(section_beats)
        room = nxt - g[-1]["end"] - BREATH_BEATS
        if room > 0:
            g[-1]["end"] += min(CODA_BEATS, room)
    out, prev_end = [], 0.0
    for gi, g in enumerate(groups):
        first = g[0]["start"] * beat_s
        lead = min(LEAD_REST_SEC, first - prev_end)
        ph, du, pi, ty = [], [], [], []
        if lead >= MIN_REST_SEC:
            ph.append("<SP>"); du.append(lead); pi.append(0); ty.append(1)
        end = first
        for i, n in enumerate(g):
            s = n["start"] * beat_s
            gap = s - end
            if gap >= MIN_REST_SEC:
                ph.append("<SP>"); du.append(gap); pi.append(0); ty.append(1)
            elif gap > 0 and du:
                du[-1] += gap
            nxt = g[i + 1]["start"] if i + 1 < len(g) else float("inf")
            nxt_group = groups[gi + 1][0]["start"] if gi + 1 < len(groups) else float("inf")
            e = min(n["end"], nxt, section_beats, nxt_group)
            if e <= n["start"]:
                raise ValueError(f"{section}: the note at beat {n['start']:g} has no length inside the section")
            ph.append(n["phones"]); du.append((e - n["start"]) * beat_s); pi.append(n["midi"]); ty.append(2)
            end = e * beat_s
        out.append({"start": first - (lead if lead >= MIN_REST_SEC else 0), "phoneme": ph, "duration": du,
                    "pitch": pi, "type": ty})
        prev_end = end
    return out


class Singer:
    def __init__(self, device: torch.device):
        from . import soulx_compat

        soulx_compat.install()
        from soulxsinger.models.soulxsinger import SoulXSinger
        from soulxsinger.utils.data_processor import DataProcessor
        from soulxsinger.utils.file_utils import load_config

        repo = paths.SOULX_REPO
        if not paths.SOULX_SINGER_MODEL.is_file():
            raise FileNotFoundError(f"SoulX-Singer weights missing: {paths.SOULX_SINGER_MODEL}")
        self.config = load_config(str(repo / "soulxsinger" / "config" / "soulxsinger.yaml"))
        self.sr = int(self.config.audio.sample_rate)
        model = SoulXSinger(self.config).to(device)
        ckpt = torch.load(str(paths.SOULX_SINGER_MODEL), weights_only=False, map_location="cpu")
        model.load_state_dict(ckpt["state_dict"], strict=True)
        self.model = model.eval()
        self.dp = DataProcessor(hop_size=self.config.audio.hop_size, sample_rate=self.sr,
                                phoneset_path=str(repo / "soulxsinger" / "utils" / "phoneme" / "phone_set.json"),
                                device=str(device))
        for p in (paths.VOICE_AUDIO, paths.VOICE_META):
            if not p.is_file():
                raise FileNotFoundError(f"SoulX voice prompt missing: {p}")
        meta = json.loads(paths.VOICE_META.read_text())[0]
        self.prompt = self.dp.process(meta, str(paths.VOICE_AUDIO))

    def sing(self, notes, bpm, bars: int, section: str) -> np.ndarray:
        """The section sung (mono, self.sr), every phrase placed at its time; bars * 4 beats + TAIL_S long."""
        beat_s = 60.0 / float(bpm)
        out = np.zeros(int((bars * 4 * beat_s + TAIL_S) * self.sr), dtype=np.float32)
        for p in phrases(notes, bpm, bars * 4, section=section):
            meta = {"duration": " ".join(f"{d:.4f}" for d in p["duration"]), "phoneme": " ".join(p["phoneme"]),
                    "note_pitch": " ".join(str(x) for x in p["pitch"]),
                    "note_type": " ".join(str(x) for x in p["type"]), "language": "English"}
            with torch.no_grad():
                audio = self.model.infer({"prompt": self.prompt, "target": self.dp.process(meta, None)}, auto_shift=False,
                                         pitch_shift=0, n_steps=self.config.infer.n_steps, cfg=self.config.infer.cfg,
                                         control="score", use_fp16=False)
            a = audio.squeeze().float().cpu().numpy()
            i0 = int(p["start"] * self.sr)
            if i0 >= len(out):
                raise ValueError(f"{section}: a phrase starts after the section ends")
            out[i0:i0 + len(a)] += a[: len(out) - i0]
        if not np.any(np.abs(out) > 1e-3):
            raise RuntimeError(f"{section}: SoulX sang nothing")
        return out

    def close(self):
        self.model = None
        self.prompt = None
        gc.collect()
        torch.cuda.empty_cache()
