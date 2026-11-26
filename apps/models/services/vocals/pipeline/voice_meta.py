"""A new singer's voice description: SoulX-Singer's prompt metadata for its voice reference, built from a transcription.

Only numpy: imported by the vocals service (tests) and by tools/soulx_preprocess.py, which runs in
SoulX-Singer-Preprocess's own venv.

SoulX's prompt metadata (one object in a JSON list) holds, for the reference recording: "index", "language", "time"
([start, end] in ms), "duration" (seconds per item, space-separated), "text", "phoneme" (`<SP>` for a rest, or "en_"
followed by the ARPAbet phonemes joined with "-"), "note_pitch" (MIDI, 0 for a rest), "note_type" (1 rest, 2 note,
3 slur: the same word carried onto a new note) and "f0" (Hz per 20 ms frame, 0 when unvoiced).

Two kinds of recording:
- words: sung lyrics, transcribed by SoulX-Singer-Preprocess (lyrics, then notes);
- "la": a melody sung as "la la la" (no lyrics), told apart automatically (`is_la`) when most of the words the lyric
  recogniser hears are "la". Its notes start at every "l" (the letter recogniser's "L" peaks, the method that found
  27 of 27 note starts on the owner's recording, vocal-cleanup-tests/la_transcribe.py) and each note is an "la".
"""
from __future__ import annotations

import re

import numpy as np

LA_WORD = re.compile(r"^l+a+h?$", re.IGNORECASE)
LA_SHARE = 0.7  # of the heard words "la" or more: a "la la la" recording
LA_PHONEME = "en_L-AA1"
REST = "<SP>"
MIN_REST_S = 0.02  # a gap shorter than this between notes is joined to the note before it
# la notes (as in la_transcribe.py): the pitch is read over the vowel, from VOWEL_DELAY_S after the "l" through
# VOWEL_SHARE of the note; a note ends at the next "l" or where its sound stops, at least SOUND_AFTER_S after its start.
VOWEL_DELAY_S, VOWEL_SHARE, SOUND_AFTER_S, MIN_PITCH_FRAMES = 0.06, 0.75, 0.1, 3


def _clean(word: str) -> str:
    return word.strip(".,!?;:\"'").strip()


def is_la(words) -> bool:
    """Whether a recording is sung as "la la la": LA_SHARE or more of the heard words (rests left out) are "la".
    No words heard at all is an error (nothing to describe the voice with)."""
    heard = [_clean(w) for w in words if w != REST and _clean(w)]
    if not heard:
        raise ValueError("No words were heard in the voice reference: sing words (in English) or \"la la la\".")
    return sum(1 for w in heard if LA_WORD.match(w)) / len(heard) >= LA_SHARE


def la_notes(onsets, times, midi, sounding, clip_s: float) -> list[dict]:
    """The notes of an "la" recording: [{"start", "end" (s), "midi" (int)}].

    onsets: each "l" (s, ascending); times: the pitch frames' times (s); midi: the sung pitch per frame (float MIDI,
    NaN where unvoiced); sounding: per frame, whether the voice sounds. A note lasts to the next "l" (or the clip's
    end) unless its sound stops first; its pitch is the median over its vowel, less the recording's tuning offset
    (the median distance of all notes from the nearest semitone), rounded."""
    onsets = np.asarray(onsets, dtype=float)
    times, midi, sounding = np.asarray(times, float), np.asarray(midi, float), np.asarray(sounding, bool)
    if len(onsets) == 0:
        raise ValueError("No \"l\" was found in the \"la\" recording: no note starts.")
    if not (len(times) == len(midi) == len(sounding)):
        raise ValueError("la_notes: times, midi and sounding must have one value per frame")
    raw = []
    for i, a in enumerate(onsets):
        b = onsets[i + 1] if i + 1 < len(onsets) else clip_s
        quiet = np.flatnonzero((times > a + SOUND_AFTER_S) & (times < b) & ~sounding)
        end = float(times[quiet[0]]) if len(quiet) else float(b)
        lo = a + VOWEL_DELAY_S
        sel = (times >= lo) & (times <= lo + VOWEL_SHARE * (end - lo)) & np.isfinite(midi)
        if sel.sum() < MIN_PITCH_FRAMES:
            raise ValueError(f"No pitch was found in the note starting at {a:.2f} s of the voice reference.")
        raw.append((float(a), end, float(np.median(midi[sel]))))
    offset = float(np.median([m - round(m) for _, _, m in raw]))
    return [{"start": a, "end": e, "midi": int(round(m - offset))} for a, e, m in raw]


def _durations(bounds) -> list[float]:
    """Item durations from their boundaries, each boundary rounded to 10 ms so the durations add up to the clip."""
    r = [round(b, 2) for b in bounds]
    return [round(b - a, 2) for a, b in zip(r, r[1:])]


def la_meta(notes, clip_s: float, f0, index: str) -> dict:
    """SoulX prompt metadata for an "la" voice reference: every note an "la" at its pitch, the gaps rests (a leading
    and a trailing rest when the clip starts or ends with silence), the durations covering the whole clip."""
    if not notes:
        raise ValueError("la_meta: no notes")
    items = []  # [phoneme, pitch, type, start, end], end to end from 0 to clip_s
    t = 0.0
    for n in notes:
        start, end = max(float(n["start"]), t), min(float(n["end"]), clip_s)
        if end <= start:
            raise ValueError(f"la_meta: the note at {n['start']:.2f} s has no length inside the clip")
        if start - t >= MIN_REST_S:
            items.append([REST, 0, 1, t, start])
        elif items:
            items[-1][4] = start  # a tiny gap: the note before runs on to this one
        else:
            start = 0.0  # the clip starts on the note
        items.append([LA_PHONEME, int(n["midi"]), 2, start, end])
        t = end
    if clip_s - t >= MIN_REST_S:
        items.append([REST, 0, 1, t, clip_s])
    else:
        items[-1][4] = clip_s
    bounds = [items[0][3]] + [it[4] for it in items]
    ph, pitch, kind = [it[0] for it in items], [it[1] for it in items], [it[2] for it in items]
    return {"index": index, "language": "English", "time": [0, int(round(clip_s * 1000))],
            "duration": " ".join(f"{d:.2f}" for d in _durations(bounds)),
            "text": " ".join("la" if p == LA_PHONEME else REST for p in ph), "phoneme": " ".join(ph),
            "note_pitch": " ".join(map(str, pitch)), "note_type": " ".join(map(str, kind)),
            "f0": " ".join(f"{x:.1f}" for x in f0)}


# The transcribed notes' durations may differ from the clip's length by rounding: up to DURATION_SLACK_S is given to
# (or taken from) the last item; more is an error.
DURATION_SLACK_S = 0.1


def words_meta(notes: dict, clip_s: float, f0, index: str) -> dict:
    """SoulX prompt metadata for a voice reference with words, from SoulX-Singer-Preprocess's notes
    (tools/soulx_preprocess.py notes: {"text", "durations", "pitches", "types", "phonemes"}, one item per note or
    rest)."""
    text, dur = list(notes["text"]), [float(d) for d in notes["durations"]]
    pitch, kind, ph = [int(x) for x in notes["pitches"]], [int(x) for x in notes["types"]], list(notes["phonemes"])
    if not (len(text) == len(dur) == len(pitch) == len(kind) == len(ph)) or not text:
        raise ValueError(f"the note transcription disagrees with itself: {len(text)} words, {len(dur)} durations, "
                         f"{len(pitch)} pitches, {len(kind)} note types, {len(ph)} phonemes")
    gap = clip_s - sum(dur)
    if abs(gap) > DURATION_SLACK_S:
        raise ValueError(f"the transcribed notes last {sum(dur):.2f} s, the voice reference {clip_s:.2f} s")
    if dur[-1] + gap <= 0:
        raise ValueError("the last transcribed note has no length left once the notes are fitted to the clip")
    dur[-1] += gap
    bounds = np.concatenate([[0.0], np.cumsum(dur)])
    return {"index": index, "language": "English", "time": [0, int(round(clip_s * 1000))],
            "duration": " ".join(f"{d:.2f}" for d in _durations(bounds)), "text": " ".join(text),
            "phoneme": " ".join(ph), "note_pitch": " ".join(map(str, pitch)), "note_type": " ".join(map(str, kind)),
            "f0": " ".join(f"{x:.1f}" for x in f0)}


def check_meta(meta: dict, clip_s: float) -> None:
    """A voice description fit for SoulX: one item per duration, at least one sung note with a pitch, durations
    adding up to the clip (within 50 ms) and a pitch curve covering it (within 3 frames)."""
    for k in ("index", "language", "time", "duration", "text", "phoneme", "note_pitch", "note_type", "f0"):
        if k not in meta:
            raise ValueError(f"the voice description lacks {k!r}")
    dur = [float(x) for x in meta["duration"].split()]
    ph, pitch, kind = meta["phoneme"].split(), meta["note_pitch"].split(), meta["note_type"].split()
    if not (len(dur) == len(ph) == len(pitch) == len(kind)):
        raise ValueError(f"the voice description's items disagree: {len(dur)} durations, {len(ph)} phonemes, "
                         f"{len(pitch)} pitches, {len(kind)} note types")
    # A rest may carry a pitch and a note pitch 0 (SoulX-Singer's own examples have both): only a sung, pitched note
    # is required (the test line is placed by the notes' pitches).
    if not any(p != REST and int(m) > 0 for p, m in zip(ph, pitch)):
        raise ValueError("the voice description has no sung note with a pitch")
    if abs(sum(dur) - clip_s) > 0.05:
        raise ValueError(f"the voice description's durations add up to {sum(dur):.2f} s, the clip is {clip_s:.2f} s")
    frames = len(meta["f0"].split())
    if abs(frames - clip_s / 0.02) > 3:
        raise ValueError(f"the voice description's pitch curve has {frames} frames for a {clip_s:.2f} s clip")
