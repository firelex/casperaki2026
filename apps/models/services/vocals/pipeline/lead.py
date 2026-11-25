"""The lead stage: YuE2 sings each unit (one take per seed), ChordNet checks every take against our chords, the best take
is cut to our bars (<unit>_section.wav, time-stretched bar by bar) and transcribed, unstretched through its bar map,
to one note per syllable of our words (each lyric line aligned inside its own bars: `line_windows`).

params = {"bpm", "key", "octave" (-12/0/12: sung = lane + octave), "seeds" (takes per unit), "threshold" (least share
of the section's half-beats on our chord), "units": [{"id", "lead_in_chords": [chord per beat] (LEAD_BARS bars),
"chords": [chord per beat], "notes": [{"start", "duration", "midi"}] (beats, lane register), "lyrics": [line],
"words": [[syllable] per line], "phonemes": [[[phoneme] per syllable] per line]}]}.
Writes lead.json = {"units": {id: {"take": "<id>_section.wav", "seed", "chords_match", "melody": [SungNote]}}}, where a
SungNote is {"start", "duration" (beats from the section start), "midi" (lane register), "word", "phonemes"}.

Steps, in the order the models are loaded (one model on the GPU at a time, released after its phase):
yue2:<unit>:s<seed>, separate:<unit>:s<seed>, chords:<unit>:s<seed>, choose:<unit>, transcribe:<unit>.
"""
from __future__ import annotations

import gc
import json
from pathlib import Path

import numpy as np
import soundfile as sf
import torch

from . import align, score
from .score import LEAD_BARS

UNIT_KEYS = ("id", "lead_in_chords", "chords", "notes", "lyrics", "words", "phonemes")


def _required(params: dict, key: str):
    if key not in params:
        raise ValueError(f"lead: missing param {key!r}")
    return params[key]


def check_units(units) -> None:
    if not isinstance(units, list) or not units:
        raise ValueError("lead: 'units' must be a non-empty list")
    seen = set()
    for i, u in enumerate(units):
        for k in UNIT_KEYS:
            if k not in u:
                raise ValueError(f"lead: unit {u.get('id', i)!r} is missing {k!r}")
        uid = u["id"]
        if uid in seen:
            raise ValueError(f"lead: unit {uid!r} appears twice")
        seen.add(uid)
        if [len(line) for line in u["words"]] != [len(line) for line in u["phonemes"]]:
            raise ValueError(f"{uid}: words and phonemes differ in shape "
                             f"({[len(x) for x in u['words']]} vs {[len(x) for x in u['phonemes']]} syllables per line)")
        if not any(u["words"]):
            raise ValueError(f"{uid}: no words")
        n_syl = sum(len(line) for line in u["words"])
        if len(u["notes"]) != n_syl:
            raise ValueError(f"{uid}: {len(u['notes'])} notes for {n_syl} syllables (want one note per syllable)")


LINE_SLACK_BEATS = 1.0  # a line's window reaches this far past its neighbours' first notes (the take's own timing)


def line_windows(unit) -> list[tuple[float, float]]:
    """Each lyric line's window, in beats from the section start: from a beat before its first note (the section start
    for the first line) to a beat after the next line's first note (the section end for the last line)."""
    notes = sorted(unit["notes"], key=lambda n: n["start"])
    firsts, k = [], 0
    for i, line in enumerate(unit["words"]):
        if not line:
            raise ValueError(f"{unit['id']}: line {i + 1} has no words")
        firsts.append(float(notes[k]["start"]))
        k += len(line)
    end = float(len(unit["chords"]))
    out = []
    for i, f in enumerate(firsts):
        a = 0.0 if i == 0 else max(0.0, f - LINE_SLACK_BEATS)
        b = end if i + 1 == len(firsts) else min(end, firsts[i + 1] + LINE_SLACK_BEATS)
        out.append((a, b))
    return out


def _device() -> torch.device:
    if not torch.cuda.is_available():
        raise RuntimeError("lead: CUDA is not available")
    return torch.device("cuda")


def _release():
    gc.collect()
    torch.cuda.empty_cache()


def _pct(x: float) -> str:
    return f"{x * 100:.0f}%"


def run(params: dict, out_dir, job):
    bpm = float(_required(params, "bpm"))
    key = _required(params, "key")
    octave = score.check_octave(_required(params, "octave"))
    seeds = int(_required(params, "seeds"))
    threshold = float(_required(params, "threshold"))
    units = _required(params, "units")
    if seeds < 1:
        raise ValueError(f"lead: seeds {seeds} must be at least 1")
    check_units(units)
    score.scale(key)
    out = Path(out_dir)
    device = _device()
    style = score.style(bpm, key)
    seed_list = list(range(1, seeds + 1))
    try:
        takes = _sing(units, bpm, octave, style, seed_list, out, device, job)
        _release()
        _separate(units, seed_list, takes, out, device, job)
        _release()
        scores = _chords(units, bpm, seed_list, takes, out, device, job)
        _release()
        chosen = _choose(units, bpm, seed_list, takes, scores, threshold, out, job)
        melodies = _transcribe(units, bpm, key, octave, chosen, out, device, job)
    finally:
        _release()
    result = {"units": {u["id"]: {"take": chosen[u["id"]]["file"], "seed": chosen[u["id"]]["seed"],
                                  "chords_match": chosen[u["id"]]["chords_match"], "melody": melodies[u["id"]]}
                        for u in units}}
    (out / "lead.json").write_text(json.dumps(result, indent=1))
    return {"file": str(out / "lead.json"), "kind": "json"}


def _sing(units, bpm, octave, style, seed_list, out, device, job):
    from .yue2_takes import Singer

    takes = {}
    job.check_cancelled()
    singer = Singer(device)
    try:
        for u in units:
            uid = u["id"]
            abc, lyrics = score.abc(u, bpm, octave), score.lyrics_text(u)
            (out / f"{uid}.abc").write_text(abc)
            (out / f"{uid}_lyrics.txt").write_text(lyrics)
            for seed in seed_list:
                job.check_cancelled()
                st = job.step(f"yue2:{uid}:s{seed}", f"Sing {uid} (take {seed})")
                try:
                    audio, sr = singer.sing(abc, lyrics, style, seed, job.cancelled)
                except InterruptedError:
                    job.check_cancelled()
                    raise
                name = f"{uid}_s{seed}.wav"
                sf.write(out / name, audio, sr)
                takes[(uid, seed)] = {"audio": audio, "sr": sr}
                st.done(f"{len(audio) / sr:.1f} s take", {"seconds": round(len(audio) / sr, 2)},
                        [name, f"{uid}.abc", f"{uid}_lyrics.txt"])
    finally:
        singer.close()
    return takes


def _separate(units, seed_list, takes, out, device, job):
    from .separate import SR, Separator

    job.check_cancelled()
    sep = Separator(device)
    try:
        for u in units:
            for seed in seed_list:
                job.check_cancelled()
                uid = u["id"]
                st = job.step(f"separate:{uid}:s{seed}", f"Separate the voice of {uid} (take {seed})")
                t = takes[(uid, seed)]
                vocals, backing = sep.separate(t.pop("audio"), t["sr"])
                t.update(vocals=vocals, backing=backing, sr=SR)
                names = [f"{uid}_s{seed}_vocals.wav", f"{uid}_s{seed}_backing.wav"]
                sf.write(out / names[0], vocals.T, SR)
                sf.write(out / names[1], backing.T, SR)
                st.done("vocal and backing separated", {}, names)
    finally:
        sep.close()


def _chords(units, bpm, seed_list, takes, out, device, job):
    from .chords import ChordReader

    job.check_cancelled()
    reader = ChordReader(device)
    scores = {}
    try:
        for u in units:
            uid = u["id"]
            expected = list(u["lead_in_chords"]) + list(u["chords"])
            for seed in seed_list:
                job.check_cancelled()
                st = job.step(f"chords:{uid}:s{seed}", f"Check the chords of {uid} (take {seed})")
                t = takes[(uid, seed)]
                segs = reader.read(t.pop("backing"), t["sr"])
                name = f"{uid}_s{seed}_chords.json"
                (out / name).write_text(json.dumps(segs))
                bar_map, match = align.align(segs, expected, bpm)
                m = align.section_match(match, LEAD_BARS)
                t.update(bar_map=bar_map, match=m)
                scores[(uid, seed)] = m
                numbers = {"chords_match": round(m, 4)}
                sung = next((b for b in bar_map[LEAD_BARS:] if b is not None), None)
                if sung is not None:
                    numbers["starts_at_s"] = round(sung[0], 3)
                text = f"{_pct(m)} of the section on our chords" + ("" if sung else "; no bar of the section found")
                st.done(text, numbers, [name])
    finally:
        reader.close()
    return scores


def _choose(units, bpm, seed_list, takes, scores, threshold, out, job):
    chosen = {}
    for u in units:
        job.check_cancelled()
        uid = u["id"]
        st = job.step(f"choose:{uid}", f"Choose the best take of {uid}")
        best = max(seed_list, key=lambda s: (scores[(uid, s)], -s))
        m = scores[(uid, best)]
        if m < threshold:
            per = ", ".join(f"{s}: {_pct(scores[(uid, s)])}" for s in seed_list)
            msg = (f"{uid}: best take matches our chords {_pct(m)} (seeds {per}), below {_pct(threshold)}")
            st.fail(msg)
            raise RuntimeError(msg)
        t = takes[(uid, best)]
        section = align.cut_bars(t["vocals"], t["sr"], t["bar_map"], bpm, from_bar=LEAD_BARS)
        name = f"{uid}_section.wav"
        sf.write(out / name, section.T, t["sr"])
        chosen[uid] = {"file": name, "seed": best, "chords_match": round(m, 4), "vocals": t["vocals"],
                       "bar_map": t["bar_map"], "sr": t["sr"]}
        st.done(f"take {best}: {_pct(m)} on our chords", {"seed": best, "chords_match": round(m, 4)}, [name])
    return chosen


def _transcribe(units, bpm, key, octave, chosen, out, device, job):
    from .transcribe import MmsAligner, PitchTracker, syllable_notes

    job.check_cancelled()
    aligner, tracker = MmsAligner(device), PitchTracker()
    melodies = {}
    try:
        for u in units:
            job.check_cancelled()
            uid = u["id"]
            st = job.step(f"transcribe:{uid}", f"Write down the sung melody of {uid}")
            c = chosen[uid]
            # the unstretched take, read through its bar map (a stretched take smears the words for the aligner)
            notes = syllable_notes(c.pop("vocals"), c["sr"], u["words"], bpm, key=key, octave=octave, section=uid,
                                   aligner=aligner, tracker=tracker, line_beats=line_windows(u),
                                   clock=align.take_clock(c["bar_map"], LEAD_BARS))
            phonemes = [p for line in u["phonemes"] for p in line]
            melody = [{**n, "phonemes": list(p)} for n, p in zip(notes, phonemes, strict=True)]
            melodies[uid] = melody
            name = f"{uid}_melody.json"
            (out / name).write_text(json.dumps(melody, indent=0))
            st.done(f"{len(melody)} syllables", {"syllables": len(melody)}, [c["file"], name])
    finally:
        aligner.close()
    return melodies
