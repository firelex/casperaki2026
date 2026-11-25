"""The sing stage: every vocal of the song sung by SoulX-Singer, the recipe of the owner's approved demo
(apps/models/ace-vocal-tests/soulx_sing.py and other-models/harmony_from_lead.py, vocal_chain.py, shared tree):

- lead: SoulX-Singer sings each section straight from its Vocal lane's notes and phonemes (score control, the
  lane's own pitch), in the demo's voice (pipeline.soulx);
- backing vocals: the section's lead take re-pitched to each backing line's notes with SoulX-Singer-SVC, so timing,
  words and voice are the lead's and only the pitch changes (pipeline.svc);
- every take through the vocal chain (pipeline.chain: EQ, compressor, exciter at -6 dB, limiter);
- levels: a backing take is matched to `backing_db` under its section's lead (loudness of the singing parts,
  pipeline.levels); a lead take keeps the level the chain gives it. Every take is cut to its section plus a 0.15 s
  fade-out and written as 44.1 kHz stereo float WAV (the renderer needs 44.1 kHz).

params = {"bpm", "backing_db" (dB, negative: the backings under the lead),
"sections": [{"segment", "section_bars", "notes": [SungNote]}] (each section sung, notes in song order),
"backings": [{"track", "segment" (one of the sections), "notes": [{"start", "duration", "midi"}]}]}.
A SungNote is {"start", "duration" (beats from the section start), "midi" (sung pitch), "word", "phonemes"}.
Every key is required.

Writes sing.json = {"takes": [{"segment", "track", "kind": "soulx-vocal", "file" (a name in this job's folder, listed
by the levels step), "durationSeconds"}]}.

Steps, in model order (one model on the GPU at a time, released after its phase): soulx:<segment> (SoulX sings the
lead), harmony:<track>:<segment> (the lead re-pitched to the backing line), then on the CPU chain:<segment> /
chain:<track>:<segment>, and levels.
"""
from __future__ import annotations

import gc
import json
import re
from pathlib import Path

import numpy as np
import soundfile as sf

from . import chain, levels, tighten

OUT_SR = 44100
LEAD_TRACK = "Vocal"
KIND = "soulx-vocal"
REQUIRED = ("bpm", "backing_db", "sections", "backings")
SECTION_KEYS = ("segment", "section_bars", "notes")
BACKING_KEYS = ("track", "segment", "notes")
SUNG_NOTE_KEYS = ("start", "duration", "midi", "word", "phonemes")
PITCH_NOTE_KEYS = ("start", "duration", "midi")


def _required(d: dict, key: str, where: str):
    if key not in d:
        raise ValueError(f"{where}: missing {key!r}")
    return d[key]


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")


def _check_notes(notes, keys, what: str) -> None:
    if not isinstance(notes, list) or not notes:
        raise ValueError(f"{what}: no notes")
    for i, n in enumerate(notes, 1):
        for k in keys:
            if k not in n:
                raise ValueError(f"{what}: note {i} lacks {k!r}")
        if "phonemes" in keys and not n["phonemes"]:
            raise ValueError(f"{what}: note {i} ({n['word']!r}) has no phonemes")


def check_params(params: dict) -> dict:
    """The params checked (every missing or wrong value raises), as the stage uses them."""
    for k in REQUIRED:
        _required(params, k, "sing: params")
    bpm = float(params["bpm"])
    if bpm <= 0:
        raise ValueError(f"sing: bpm {bpm} must be positive")
    backing_db = float(params["backing_db"])
    if backing_db > 0:
        raise ValueError(f"sing: backing_db {backing_db} must not put the backings above the lead")
    if not isinstance(params["sections"], list) or not params["sections"]:
        raise ValueError("sing: no sections to sing")

    leads, by_segment = [], {}
    for s in params["sections"]:
        what = f"section {s.get('segment', '?')}"
        for k in SECTION_KEYS:
            _required(s, k, what)
        seg = s["segment"]
        if seg in by_segment:
            raise ValueError(f"sing: section {seg} appears twice")
        bars = int(s["section_bars"])
        if bars < 1:
            raise ValueError(f"{what}: section_bars {bars} must be at least 1")
        _check_notes(s["notes"], SUNG_NOTE_KEYS, what)
        item = {"segment": seg, "track": LEAD_TRACK, "what": f"the lead of {seg}", "bars": bars, "notes": s["notes"],
                "tag": seg, "take": f"take_{seg}_{_slug(LEAD_TRACK)}.wav"}
        leads.append(item)
        by_segment[seg] = item

    backings = []
    for b in params["backings"]:
        what = f"backing {b.get('track', '?')} in {b.get('segment', '?')}"
        for k in BACKING_KEYS:
            _required(b, k, what)
        seg, track = b["segment"], b["track"]
        if track == LEAD_TRACK:
            raise ValueError(f"{what}: a backing line cannot be the lead track")
        if seg not in by_segment:
            raise ValueError(f"{what}: the section is not among the sung sections (a backing is made from its lead)")
        _check_notes(b["notes"], PITCH_NOTE_KEYS, what)
        tag = f"{seg}_{_slug(track)}"
        backings.append({"segment": seg, "track": track, "what": f"{track} in {seg}", "bars": by_segment[seg]["bars"],
                         "notes": b["notes"], "lead": by_segment[seg], "tag": tag, "take": f"take_{tag}.wav"})
    if len({(b["track"], b["segment"]) for b in backings}) != len(backings):
        raise ValueError("sing: a backing line appears twice")
    return {"bpm": bpm, "backing_db": backing_db, "leads": leads, "backings": backings}


# Backing vocals sit apart from the centred lead (owner, 2026-11-25): Backing vocals 1 left, 2 right, at +-PAN.
PAN = 0.4
BACKING_PAN = {"Backing vocals 1": -PAN, "Backing vocals 2": PAN}


def panned(x: np.ndarray, pan: float) -> np.ndarray:
    """A dual-mono stereo take (samples x 2) panned by `pan` (-1 left .. 1 right), equal power: the same loudness as
    centred (each side's gain over the centre's 1/sqrt(2))."""
    if not -1.0 <= pan <= 1.0:
        raise ValueError(f"pan {pan} is outside -1..1")
    theta = (pan + 1.0) * np.pi / 4.0
    gains = np.array([np.cos(theta), np.sin(theta)], dtype=np.float32) / np.float32(np.cos(np.pi / 4.0))
    return x * gains[None, :]


def _stereo(x: np.ndarray, sr: int) -> np.ndarray:
    """samples (x channels) at sr -> OUT_SR stereo (samples x 2)."""
    import librosa

    x = np.asarray(x, dtype=np.float32)
    x = x[:, None] if x.ndim == 1 else x
    if sr != OUT_SR:
        x = librosa.resample(np.ascontiguousarray(x.T), orig_sr=sr, target_sr=OUT_SR).T
    return np.repeat(x[:, :1], 2, axis=1) if x.shape[1] == 1 else x[:, :2]


def _device():
    import torch

    if not torch.cuda.is_available():
        raise RuntimeError("sing: CUDA is not available")
    return torch.device("cuda")


def _release():
    import torch

    gc.collect()
    torch.cuda.empty_cache()


def run(params: dict, out_dir, job):
    p = check_params(params)
    out = Path(out_dir)
    bar_s = 4 * 60.0 / p["bpm"]
    device = _device()
    try:
        sung = _sing(p, out, device, job)
        _release()
        if p["backings"]:
            sung.update(_harmonies(p, out, device, job, sung))
    finally:
        _release()

    chained = {}
    for item in p["leads"] + p["backings"]:
        job.check_cancelled()
        step_id = f"chain:{item['segment']}" if item["track"] == LEAD_TRACK else f"chain:{item['track']}:{item['segment']}"
        st = job.step(step_id, f"Vocal chain on {item['what']}")
        audio, sr = sung[item["tag"]]
        x = chain.process(audio[:, None], sr)
        name = f"{item['tag']}_chain.wav"
        sf.write(out / name, x, chain.OUT_SR)
        chained[item["tag"]] = x
        st.done("EQ, compression, exciter and limiter", {}, [name])

    job.check_cancelled()
    st = job.step("levels", "Set the levels")
    numbers, files, takes = {}, [], []
    for item in p["leads"] + p["backings"]:
        x = chained[item["tag"]]
        if item["track"] != LEAD_TRACK:
            x = levels.match(x, chained[item["lead"]["tag"]], p["backing_db"], name=item["what"])
            numbers[f"{item['tag']}_gain_db"] = round(levels.gain_db(chained[item["tag"]], chained[item["lead"]["tag"]],
                                                                     p["backing_db"]), 2)
        x = _stereo(x, chain.OUT_SR)
        if item["track"] in BACKING_PAN:
            x = panned(x, BACKING_PAN[item["track"]])
        x = levels.fit(x, OUT_SR, item["bars"] * bar_s)
        sf.write(out / item["take"], x, OUT_SR, subtype="FLOAT")
        files.append(item["take"])
        takes.append({"segment": item["segment"], "track": item["track"], "kind": KIND, "file": item["take"],
                      "durationSeconds": round(len(x) / OUT_SR, 3)})
    st.done(f"{len(p['backings'])} backing takes {abs(p['backing_db']):g} dB under their lead", numbers, files)

    (out / "sing.json").write_text(json.dumps({"takes": takes}, indent=1))
    return {"file": str(out / "sing.json"), "kind": "json"}


def _sing(p, out, device, job) -> dict:
    """tag -> (the lead take, mono at SoulX's rate, its rate) for every section."""
    from .soulx import Singer

    job.check_cancelled()
    singer = Singer(device)
    sung = {}
    try:
        for item in p["leads"]:
            job.check_cancelled()
            st = job.step(f"soulx:{item['segment']}", f"SoulX sings {item['what']}")
            raw = singer.sing(item["notes"], p["bpm"], item["bars"], item["segment"])
            raw_name = f"{item['tag']}_soulx_untightened.wav"
            sf.write(out / raw_name, raw, singer.sr)
            # Tightened onto the score (pipeline.tighten); the backing vocals are re-pitched from this take, so they
            # come out tight too.
            audio, anc = tighten.tighten(raw, singer.sr, item["notes"], p["bpm"])
            name = f"{item['tag']}_soulx.wav"
            sf.write(out / name, audio, singer.sr)
            sung[item["tag"]] = (audio, singer.sr)
            moved = [abs(a - s) * 1000 for a, s in anc[1:-1]]
            st.done(f"{len(item['notes'])} notes, {len(audio) / singer.sr:.1f} s; {len(moved)} notes put on the beat "
                    f"(median move {float(np.median(moved)) if moved else 0:.0f} ms)",
                    {"notes": len(item["notes"]), "seconds": round(len(audio) / singer.sr, 2), "anchored": len(moved)},
                    [name, raw_name])
    finally:
        singer.close()
    return sung


def _harmonies(p, out, device, job, sung) -> dict:
    """tag -> (the backing take, mono at SoulX's rate, its rate) for every backing line."""
    from .svc import Converter

    job.check_cancelled()
    conv = Converter(device)
    made = {}
    try:
        for item in p["backings"]:
            job.check_cancelled()
            lead = item["lead"]
            st = job.step(f"harmony:{item['track']}:{item['segment']}", f"Re-pitch the lead of {item['segment']} to {item['track']}")
            audio, sr = sung[lead["tag"]]
            if sr != conv.sr:
                raise RuntimeError(f"{item['what']}: the lead take is {sr} Hz, SoulX-SVC works at {conv.sr} Hz")
            y = conv.repitch(audio, out / f"{lead['tag']}_soulx.wav", p["bpm"], lead["notes"], item["notes"], out,
                             item["what"])
            name = f"{item['tag']}_svc.wav"
            sf.write(out / name, y, conv.sr)
            made[item["tag"]] = (y, conv.sr)
            st.done(f"{len(item['notes'])} notes on the lead of {item['segment']}",
                    {"notes": len(item["notes"]), "seconds": round(len(y) / conv.sr, 2)}, [name])
    finally:
        conv.close()
    return made
