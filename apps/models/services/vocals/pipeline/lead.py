"""The lead stage: YuE2 sings each unit (one take per seed), ChordNet checks every take against our chords, and the
best take that both matches our chords and transcribes fully is chosen (`choose_take`): transcribed, unstretched
through its bar map, to one note per syllable of our words (each lyric line aligned inside its own window:
`line_windows`), and cut to our bars (<unit>_section.wav, time-stretched bar by bar).

params = {"bpm", "key", "octave" (-12/0/12: sung = lane + octave), "seeds" (takes per unit), "threshold" (least share
of the section's half-beats on our chord), "units": [{"id", "lead_in_chords": [chord per beat] (LEAD_BARS bars),
"chords": [chord per beat], "tail_chords": [chord per beat] (TAIL_BARS bars after the section, no singing), "notes": [{"start", "duration", "midi"}] (beats, lane register), "lyrics": [line],
"words": [[syllable] per line], "phonemes": [[[phoneme] per syllable] per line]}]}.
Writes lead.json = {"units": {id: {"take": "<id>_section.wav", "seed", "chords_match", "melody": [SungNote]}}}, where a
SungNote is {"start", "duration" (beats from the section start), "midi" (lane register), "word", "phonemes"}.

Steps, in the order the models are loaded (one model on the GPU at a time, released after its phase):
yue2:<unit>:s<seed>, separate:<unit>:s<seed>, chords:<unit>:s<seed>, then per unit transcribe:<unit>:s<seed> for each
take tried (best chord match first, among those at or above the threshold) and choose:<unit>.
"""
from __future__ import annotations

import gc
import json
from pathlib import Path

import soundfile as sf
import torch

from . import align, score
from .score import LEAD_BARS

UNIT_KEYS = ("id", "lead_in_chords", "chords", "tail_chords", "notes", "lyrics", "words", "phonemes")


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
    for the first line) to a beat after the next line's first note (for the last line, the end of the tail bars after
    the section: a take that sings slower than the score finishes its last phrase there)."""
    notes = sorted(unit["notes"], key=lambda n: n["start"])
    firsts, k = [], 0
    for i, line in enumerate(unit["words"]):
        if not line:
            raise ValueError(f"{unit['id']}: line {i + 1} has no words")
        firsts.append(float(notes[k]["start"]))
        k += len(line)
    end = float(len(unit["chords"]) + len(unit["tail_chords"]))
    out = []
    for i, f in enumerate(firsts):
        a = 0.0 if i == 0 else max(0.0, f - LINE_SLACK_BEATS)
        b = end if i + 1 == len(firsts) else firsts[i + 1] + LINE_SLACK_BEATS
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
        chosen = _choose_and_transcribe(units, bpm, key, octave, seed_list, takes, scores, threshold, out, device, job)
    finally:
        _release()
    result = {"units": {u["id"]: {"take": chosen[u["id"]]["file"], "seed": chosen[u["id"]]["seed"],
                                  "chords_match": chosen[u["id"]]["chords_match"], "melody": chosen[u["id"]]["melody"]}
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
            expected = list(u["lead_in_chords"]) + list(u["chords"]) + list(u["tail_chords"])
            for seed in seed_list:
                job.check_cancelled()
                st = job.step(f"chords:{uid}:s{seed}", f"Check the chords of {uid} (take {seed})")
                t = takes[(uid, seed)]
                segs = reader.read(t.pop("backing"), t["sr"])
                name = f"{uid}_s{seed}_chords.json"
                (out / name).write_text(json.dumps(segs))
                bar_map, match = align.align(segs, expected, bpm)
                m = align.section_match(match, LEAD_BARS, len(u["chords"]) // 4)
                t.update(bar_map=bar_map, match=m)
                scores[(uid, seed)] = m
                numbers = {"chords_match": round(m, 4)}
                sung = next((b for b in bar_map[LEAD_BARS:LEAD_BARS + len(u["chords"]) // 4] if b is not None), None)
                if sung is not None:
                    numbers["starts_at_s"] = round(sung[0], 3)
                text = f"{_pct(m)} of the section on our chords" + ("" if sung else "; no bar of the section found")
                st.done(text, numbers, [name])
    finally:
        reader.close()
    return scores


class ChooseError(RuntimeError):
    """No take of a unit both matches our chords and transcribes fully (one line per seed)."""


def choose_take(uid: str, scores: dict, threshold: float, transcribe, job, on_chosen=None):
    """The best take that both matches our chords (at least `threshold`) and transcribes fully. Takes at or above the
    threshold are transcribed in order of their chord match (ties: lower seed) until one succeeds.
    scores: {seed: chord match}; transcribe(seed) -> notes, raising TranscribeError when the take lacks a word;
    on_chosen(seed, notes) -> files for the choose step. Returns (seed, notes)."""
    from .transcribe import TranscribeError

    errors = {}
    passing = sorted((s for s in scores if scores[s] >= threshold), key=lambda s: (-scores[s], s))
    for seed in passing:
        job.check_cancelled()
        st = job.step(f"transcribe:{uid}:s{seed}", f"Write down the sung melody of {uid} (take {seed})")
        try:
            notes = transcribe(seed)
        except TranscribeError as e:  # this take lacks a word: try the next one
            errors[seed] = str(e)
            st.fail(str(e))
            continue
        st.done(f"{len(notes)} syllables", {"syllables": len(notes)})
        ch = job.step(f"choose:{uid}", f"Choose the take of {uid}")
        files = on_chosen(seed, notes) if on_chosen is not None else []
        ch.done(f"take {seed}: {_pct(scores[seed])} on our chords, {len(notes)} syllables",
                {"seed": seed, "chords_match": round(scores[seed], 4), "syllables": len(notes)}, files)
        return seed, notes
    lines = [f"seed {s}: chords {_pct(scores[s])}, " + (errors[s] if s in errors else f"below the {_pct(threshold)} threshold")
             for s in sorted(scores)]
    msg = f"{uid}: no take both matches our chords and transcribes fully:\n" + "\n".join(lines)
    job.step(f"choose:{uid}", f"Choose the take of {uid}").fail(msg)
    raise ChooseError(msg)


def _choose_and_transcribe(units, bpm, key, octave, seed_list, takes, scores, threshold, out, device, job):
    from .transcribe import MmsAligner, PitchTracker, syllable_notes

    job.check_cancelled()
    aligner, tracker = MmsAligner(device), PitchTracker()
    chosen = {}
    try:
        for u in units:
            uid = u["id"]
            n_bars = len(u["chords"]) // 4
            phonemes = [p for line in u["phonemes"] for p in line]

            def transcribe(seed, u=u, uid=uid):
                t = takes[(uid, seed)]
                # the unstretched take, read through its bar map (a stretched take smears the words for the aligner)
                return syllable_notes(t["vocals"], t["sr"], u["words"], bpm, key=key, octave=octave, section=uid,
                                      aligner=aligner, tracker=tracker, line_beats=line_windows(u),
                                      section_beats=float(len(u["chords"])),
                                      clock=align.take_clock(t["bar_map"], LEAD_BARS))

            def on_chosen(seed, notes, u=u, uid=uid, n_bars=n_bars, phonemes=phonemes):
                t = takes[(uid, seed)]
                section = align.cut_bars(t["vocals"], t["sr"], t["bar_map"], bpm, from_bar=LEAD_BARS,
                                         to_bar=LEAD_BARS + n_bars)
                sf.write(out / f"{uid}_section.wav", section.T, t["sr"])
                melody = [{**n, "phonemes": list(p)} for n, p in zip(notes, phonemes, strict=True)]
                (out / f"{uid}_melody.json").write_text(json.dumps(melody, indent=0))
                chosen[uid] = {"file": f"{uid}_section.wav", "seed": seed,
                               "chords_match": round(scores[(uid, seed)], 4), "melody": melody}
                return [f"{uid}_section.wav", f"{uid}_melody.json"]

            choose_take(uid, {s: scores[(uid, s)] for s in seed_list}, threshold, transcribe, job, on_chosen)
            for s in seed_list:
                takes[(uid, s)].pop("vocals")
    finally:
        aligner.close()
    return chosen
