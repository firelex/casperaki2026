"""The repeats stage: everything sung after the lead stage, in the voices of its YuE2 takes.

- copies: a later section with other words (verses after the first), sung by SoulX-Singer from the notes the brain
  sends (the copy rule applied to the unit's sung melody, with the section's own words and phonemes), voice-converted
  (SoulX-SVC) to the unit's YuE2 take, through the vocal chain, levelled to the YuE2 chorus;
- backings: the generator's backing-vocal lines (Backing vocals 1/2), sung, converted and chained the same way, with
  the chorus take as the voice, `backing_db` under the chorus;
- extensions: the extra bars of a copy longer than its unit, sung by YuE2 in the lead stage (unit `<segment>_ext`):
  that take, padded with silence for the copied bars so it starts at the section start (dry, not levelled);
- ad-libs: YuE2 sings "oh yeah" in the gaps of the chorus lead over the chorus's chords (pipeline.adlibs), one take
  per seed, separated and checked against our chords like a lead unit; the best is cut to the chorus's bars, gated to
  the gap bars, `adlib_db` under the chorus, and placed in each of `segments`.

params = {"lead_job": the lead stage's job id (the harness keeps each job's files in <jobs dir>/<job id>, so the lead
job's folder is the sibling of this job's out_dir; voice and reference files are names in it), "bpm", "octave" (-12/0/12:
SoulX sings lane + octave), "style" (YuE2's style text, as the lead stage's),
"copies": [{"segment", "from" (unit id), "section_bars" (the section's whole bar count: the take's length; the
  notes cover only the bars sung, the plan's sungBars), "notes": [SungNote], "voice": "<unit>_section.wav"}],
"backings": [{"track", "segment", "section_bars", "notes": [SungNote], "voice": "<chorus unit>_section.wav"}],
"extensions": [{"segment", "unit" (lead unit id), "from_bar" (0-based), "section_bars"}],
"adlibs": null (no ad-libs) or {"chorus_unit", "lead_in_chords", "chords", "tail_chords" (as the chorus unit's),
  "melody": [SungNote] (the chorus's sung melody), "gaps_bars": [0-based bar], "segments": [chorus name], "seeds", "threshold"},
"levels": {"reference": "<chorus unit>_section.wav", "backing_db", "adlib_db"}}.
A SungNote is {"start", "duration" (beats from the section start), "midi" (lane register), "word", "phonemes"}.

Writes repeats.json = {"takes": [{"segment", "track", "kind" ("soulx-vocal" | "yue2-vocal"), "file" (a name in this
job's folder, listed by the levels or extension step), "durationSeconds"}]}. Takes are 44.1 kHz stereo float WAV, the
section's length plus a 0.15 s fade-out.

Steps, in model order (one model on the GPU at a time, released after its phase): soulx:<segment> (copies) and
backing:<track>:<segment> (SoulX sings), svc:<segment> / svc:<track>:<segment>, adlibs:yue2:s<n>,
adlibs:separate:s<n>, adlibs:chords:s<n>, adlibs:choose, then on the CPU chain:<segment> / chain:<track>:<segment>,
extension:<segment>, adlibs:gate, levels.
"""
from __future__ import annotations

import gc
import json
import re
from pathlib import Path

import numpy as np
import soundfile as sf

from . import adlibs as adlib_score
from . import chain, levels, score
from .score import LEAD_BARS

OUT_SR = 44100
LEAD_TRACK = "Vocal"
ADLIB_TRACK = "Ad-libs"
REQUIRED = ("lead_job", "bpm", "octave", "style", "copies", "backings", "extensions", "adlibs", "levels")
COPY_KEYS = ("segment", "from", "section_bars", "notes", "voice")
BACKING_KEYS = ("track", "segment", "section_bars", "notes", "voice")
EXTENSION_KEYS = ("segment", "unit", "from_bar", "section_bars")
ADLIB_KEYS = ("chorus_unit", "lead_in_chords", "chords", "tail_chords", "melody", "gaps_bars", "segments", "seeds",
              "threshold")
LEVEL_KEYS = ("reference", "backing_db", "adlib_db")
NOTE_KEYS = ("start", "duration", "midi", "word", "phonemes")


def _required(params: dict, key: str, where: str = "repeats: missing param"):
    if key not in params:
        raise ValueError(f"{where} {key!r}")
    return params[key]


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")


def _lead_file(lead_dir: Path, name: str, what: str) -> Path:
    p = lead_dir / name
    if not p.is_file():
        raise FileNotFoundError(f"{what}: voice file {p} is missing from the lead job")
    return p


def _check_notes(notes, what: str) -> None:
    if not isinstance(notes, list) or not notes:
        raise ValueError(f"{what}: no notes")
    for i, n in enumerate(notes, 1):
        for k in NOTE_KEYS:
            if k not in n:
                raise ValueError(f"{what}: note {i} lacks {k!r}")
        if not n["phonemes"]:
            raise ValueError(f"{what}: note {i} ({n['word']!r}) has no phonemes")


def check_params(params: dict, out_dir) -> dict:
    """The params checked, with the lead job's files resolved to paths (every missing value or file raises)."""
    for k in REQUIRED:
        _required(params, k)
    out = Path(out_dir)
    lead_dir = out.parent / str(params["lead_job"])
    if not lead_dir.is_dir():
        raise FileNotFoundError(f"repeats: the lead job {params['lead_job']!r} has no folder at {lead_dir}")
    octave = score.check_octave(params["octave"])
    style = params["style"]
    if not isinstance(style, str) or not style.strip():
        raise ValueError(f"repeats: param 'style' must be a non-empty string, got {style!r}")
    bpm = float(params["bpm"])
    if bpm <= 0:
        raise ValueError(f"repeats: bpm {bpm} must be positive")

    sung = []
    for c in params["copies"]:
        what = f"copy {c.get('segment', '?')}"
        for k in COPY_KEYS:
            _required(c, k, f"{what}: missing")
        _check_notes(c["notes"], what)
        seg = c["segment"]
        sung.append({"kind": "copy", "what": what, "segment": seg, "track": LEAD_TRACK, "bars": int(c["section_bars"]),
                     "notes": c["notes"], "voice_path": _lead_file(lead_dir, c["voice"], what), "tag": seg,
                     "sing_step": f"soulx:{seg}", "svc_step": f"svc:{seg}", "chain_step": f"chain:{seg}",
                     "offset_key": None, "take": f"take_{seg}_{_slug(LEAD_TRACK)}.wav"})
    for b in params["backings"]:
        what = f"backing {b.get('track', '?')} {b.get('segment', '?')}"
        for k in BACKING_KEYS:
            _required(b, k, f"{what}: missing")
        _check_notes(b["notes"], what)
        seg, track = b["segment"], b["track"]
        tag = f"{seg}_{_slug(track)}"
        sung.append({"kind": "backing", "what": what, "segment": seg, "track": track, "bars": int(b["section_bars"]),
                     "notes": b["notes"], "voice_path": _lead_file(lead_dir, b["voice"], what), "tag": tag,
                     "sing_step": f"backing:{track}:{seg}", "svc_step": f"svc:{track}:{seg}",
                     "chain_step": f"chain:{track}:{seg}", "offset_key": "backing_db", "take": f"take_{tag}.wav"})
    for item in sung:
        if item["bars"] < 1:
            raise ValueError(f"{item['what']}: section_bars {item['bars']} must be at least 1")

    extensions = []
    for e in params["extensions"]:
        what = f"extension {e.get('segment', '?')}"
        for k in EXTENSION_KEYS:
            _required(e, k, f"{what}: missing")
        if not 0 < int(e["from_bar"]) < int(e["section_bars"]):
            raise ValueError(f"{what}: from_bar {e['from_bar']} must lie inside the section's {e['section_bars']} bars")
        extensions.append({**e, "what": what, "path": _lead_file(lead_dir, f"{e['unit']}_section.wav", what),
                           "take": f"take_{e['segment']}_ext.wav"})

    ad = params["adlibs"]
    if ad is not None:
        for k in ADLIB_KEYS:
            _required(ad, k, "repeats: adlibs is missing")
        if not ad["segments"]:
            raise ValueError("repeats: adlibs has no segments")
        if not ad["gaps_bars"]:
            raise ValueError("repeats: adlibs has no gap bars")
        if int(ad["seeds"]) < 1:
            raise ValueError(f"repeats: adlibs seeds {ad['seeds']} must be at least 1")
        _check_notes(ad["melody"], "adlibs melody")

    lv = params["levels"]
    for k in LEVEL_KEYS:
        _required(lv, k, "repeats: levels is missing")
    return {"lead_dir": lead_dir, "bpm": bpm, "octave": octave, "style": style, "sung": sung,
            "copies": [s for s in sung if s["kind"] == "copy"], "backings": [s for s in sung if s["kind"] == "backing"],
            "extensions": extensions, "adlibs": ad,
            "reference_path": _lead_file(lead_dir, lv["reference"], "levels reference"),
            "backing_db": float(lv["backing_db"]), "adlib_db": float(lv["adlib_db"])}


def extension_take(section: np.ndarray, sr: int, from_bar: int, section_bars: int, bar_s: float) -> np.ndarray:
    """The extension's YuE2 section (bars from_bar..section_bars) placed at its bars of the whole section: silence before."""
    n = int(round(section_bars * bar_s * sr))
    i0 = int(round(from_bar * bar_s * sr))
    section = section if section.ndim == 2 else section[:, None]
    out = np.zeros((n, section.shape[1]), dtype=np.float32)
    k = min(len(section), n - i0)
    out[i0:i0 + k] = section[:k]
    return out


def _stereo(x: np.ndarray, sr: int) -> np.ndarray:
    """samples (x channels) at sr -> OUT_SR stereo (samples x 2)."""
    import librosa

    x = np.asarray(x, dtype=np.float32)
    x = x[:, None] if x.ndim == 1 else x
    if sr != OUT_SR:
        x = librosa.resample(np.ascontiguousarray(x.T), orig_sr=sr, target_sr=OUT_SR).T
    return np.repeat(x[:, :1], 2, axis=1) if x.shape[1] == 1 else x[:, :2]


def _read(path: Path) -> np.ndarray:
    x, sr = sf.read(path, always_2d=True, dtype="float32")
    return _stereo(x, sr)


def _device():
    import torch

    if not torch.cuda.is_available():
        raise RuntimeError("repeats: CUDA is not available")
    return torch.device("cuda")


def _release():
    import torch

    gc.collect()
    torch.cuda.empty_cache()


def run(params: dict, out_dir, job):
    p = check_params(params, out_dir)
    out = Path(out_dir)
    bar_s = 4 * 60.0 / p["bpm"]
    device = _device()
    adlib_section = None
    try:
        if p["sung"]:
            _sing(p, out, device, job)
            _release()
            _convert(p, out, device, job)
            _release()
        if p["adlibs"] is not None:
            adlib_section = _adlibs(p, out, device, job)
            _release()
    finally:
        _release()

    takes = []
    chained = {}
    for item in p["sung"]:
        job.check_cancelled()
        st = job.step(item["chain_step"], f"Vocal chain on {item['what']}")
        x = chain.process(_read(out / f"{item['tag']}_svc.wav"), OUT_SR)
        name = f"{item['tag']}_chain.wav"
        sf.write(out / name, x, OUT_SR)
        chained[item["tag"]] = x
        st.done("EQ and compression", {}, [name])

    for e in p["extensions"]:
        job.check_cancelled()
        st = job.step(f"extension:{e['segment']}", f"Join the extra bars of {e['segment']}")
        x = extension_take(_read(e["path"]), OUT_SR, int(e["from_bar"]), int(e["section_bars"]), bar_s)
        x = levels.fit(x, OUT_SR, int(e["section_bars"]) * bar_s)
        sf.write(out / e["take"], x, OUT_SR, subtype="FLOAT")
        takes.append({"segment": e["segment"], "track": LEAD_TRACK, "kind": "yue2-vocal", "file": e["take"],
                      "durationSeconds": round(len(x) / OUT_SR, 3)})
        st.done(f"bars {int(e['from_bar']) + 1}-{e['section_bars']} from {e['unit']}",
                {"from_bar": int(e["from_bar"])}, [e["take"]])

    gated = None
    if adlib_section is not None:
        job.check_cancelled()
        ad = p["adlibs"]
        st = job.step("adlibs:gate", "Keep the ad-libs in the gaps of the chorus")
        gated = adlib_score.gate(adlib_section, OUT_SR, [int(b) for b in ad["gaps_bars"]], bar_s)
        sf.write(out / "adlibs_gated.wav", gated, OUT_SR)
        st.done(f"bars {', '.join(str(int(b) + 1) for b in sorted(ad['gaps_bars']))} kept",
                {"bars": len(ad["gaps_bars"])}, ["adlibs_gated.wav"])

    job.check_cancelled()
    st = job.step("levels", "Set the levels")
    reference = _read(p["reference_path"])
    numbers, files = {}, []
    for item in p["sung"]:
        offset = 0.0 if item["offset_key"] is None else p[item["offset_key"]]
        x, info = levels.match_capped(chained[item["tag"]], reference, offset, name=item["what"])
        for k, v in info.items():
            numbers[f"{item['tag']}_{k}"] = round(v, 2) if k != "gain_capped" else v
        x = levels.fit(x, OUT_SR, item["bars"] * bar_s)
        sf.write(out / item["take"], x, OUT_SR, subtype="FLOAT")
        files.append(item["take"])
        takes.append({"segment": item["segment"], "track": item["track"], "kind": "soulx-vocal", "file": item["take"],
                      "durationSeconds": round(len(x) / OUT_SR, 3)})
    if gated is not None:
        ad = p["adlibs"]
        x, info = levels.match_capped(gated, reference, p["adlib_db"], name="adlibs")
        for k, v in info.items():
            numbers[f"adlibs_{k}"] = round(v, 2) if k != "gain_capped" else v
        x = levels.fit(x, OUT_SR, len(ad["chords"]) / 4 * bar_s)
        sf.write(out / "take_adlibs.wav", x, OUT_SR, subtype="FLOAT")
        files.append("take_adlibs.wav")
        for seg in ad["segments"]:
            takes.append({"segment": seg, "track": ADLIB_TRACK, "kind": "yue2-vocal", "file": "take_adlibs.wav",
                          "durationSeconds": round(len(x) / OUT_SR, 3)})
    st.done(f"{len(files)} takes levelled to {p['reference_path'].name}", numbers, files)

    (out / "repeats.json").write_text(json.dumps({"takes": takes}, indent=1))
    return {"file": str(out / "repeats.json"), "kind": "json"}


def _sing(p, out, device, job):
    from .soulx import Singer

    job.check_cancelled()
    singer = Singer(device)
    try:
        for item in p["sung"]:
            job.check_cancelled()
            st = job.step(item["sing_step"], f"SoulX sings {item['what']}")
            audio = singer.sing(item["notes"], p["bpm"], item["bars"], p["octave"], item["what"])
            name = f"{item['tag']}_soulx.wav"
            sf.write(out / name, audio, singer.sr)
            st.done(f"{len(item['notes'])} notes, {len(audio) / singer.sr:.1f} s",
                    {"notes": len(item["notes"]), "seconds": round(len(audio) / singer.sr, 2)}, [name])
    finally:
        singer.close()


def _convert(p, out, device, job):
    from .svc import Converter

    job.check_cancelled()
    conv = Converter(device)
    try:
        for item in p["sung"]:
            job.check_cancelled()
            st = job.step(item["svc_step"], f"Convert {item['what']} to the voice of {item['voice_path'].name}")
            audio = conv.convert(item["voice_path"], out / f"{item['tag']}_soulx.wav", out)
            name = f"{item['tag']}_svc.wav"
            sf.write(out / name, audio, conv.sr)
            st.done(f"in the voice of {item['voice_path'].name}", {"seconds": round(len(audio) / conv.sr, 2)}, [name])
    finally:
        conv.close()


def _adlibs(p, out, device, job):
    """The best ad-lib take (by chord match, at least the threshold), cut to the chorus's bars, at OUT_SR stereo."""
    from . import align, lead

    ad = p["adlibs"]
    u = adlib_score.unit(ad)
    uid = u["id"]
    seeds = list(range(1, int(ad["seeds"]) + 1))
    step_id = lambda phase, _uid, seed: f"adlibs:{phase}:s{seed}"  # noqa: E731
    takes = lead._sing([u], p["bpm"], p["octave"], p["style"] + ", ad-libs, backing vocal", seeds, out, device, job,
                       step_id=step_id)
    lead._release()
    lead._separate([u], seeds, takes, out, device, job, step_id=step_id)
    lead._release()
    scores = lead._chords([u], p["bpm"], seeds, takes, out, device, job, step_id=step_id)
    job.check_cancelled()
    st = job.step("adlibs:choose", "Choose the ad-lib take")
    threshold = float(ad["threshold"])
    best = max(seeds, key=lambda s: (scores[(uid, s)], -s))
    if scores[(uid, best)] < threshold:
        msg = (f"ad-libs: best take matches our chords {scores[(uid, best)] * 100:.0f}% (" +
               ", ".join(f"seed {s}: {scores[(uid, s)] * 100:.0f}%" for s in seeds) + f"), below {threshold * 100:.0f}%")
        st.fail(msg)
        raise RuntimeError(msg)
    t = takes[(uid, best)]
    n_bars = len(u["chords"]) // 4
    section = align.cut_bars(t["vocals"], t["sr"], t["bar_map"], p["bpm"], from_bar=LEAD_BARS, to_bar=LEAD_BARS + n_bars)
    sf.write(out / "adlibs_section.wav", section.T, t["sr"])
    st.done(f"take {best}: {scores[(uid, best)] * 100:.0f}% on our chords",
            {"seed": best, "chords_match": round(scores[(uid, best)], 4)}, ["adlibs_section.wav"])
    return _stereo(section.T, t["sr"])
