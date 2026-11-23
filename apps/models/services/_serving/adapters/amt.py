"""Adapter: melody completion with the Anticipatory Music Transformer (hum to song).

Synchronous route (see harness ROUTES):

  POST /complete   JSON
      {"bpm", "totalBars": 8,
       "prompt":  [{"beat", "midi", "duration"}],          beats from bar 1 beat 0, 4 beats per bar
       "keepBars": [0, 1],                                  bars (0-based) whose prompt notes are kept
       "chords":  [{"beat", "duration", "midi": [..]}],     all bars, voiced as played notes
       "samples": 8}
  -> {"completions": [{"notes": [{"beat", "midi", "duration"}],
                       "score": {"chordToneStrong", "inKey", "rhythmMatch"}}],   best first
      "tookMs"}

Every bar not in keepBars is written by the model, one gap of consecutive bars at a time and in order: the melody
before the gap (kept and already written) is the prompt, and the chords plus the kept melody after the gap are
anticipated controls (AMT's infilling), so a two-bar hum can be extended and a gap in the middle filled. The decode
loop is the spike's (apps/models/amt-spike/amt_complete.py): eager attention (the default SDPA attention breaks this
model), no clipping of controls in the first 50 ms, and only melody notes (program 53) or rests may be written.
Notes come back snapped to 16ths; kept bars come back unchanged. Completions are ranked by the spike's checks
(apps/models/amt-spike/score.py): strong-beat chord tones, notes in key, and rhythm likeness to the kept bars.
Weights: stanford-crfm/music-medium-800k (Apache-2.0) in /mnt/d/casperaki-models/stanford-crfm__music-medium-800k.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

from adapter_common import RequestError

SPIKE = Path(__file__).resolve().parents[3] / "amt-spike"
WEIGHTS = Path("/mnt/d/casperaki-models/stanford-crfm__music-medium-800k")
TOP_P = 0.95
BEATS_PER_BAR = 4
MAX_BARS = 16
MAX_SAMPLES = 16
GAP_TRIES = 4
COPY_SHARE = 0.8   # a written bar sharing more than this share of notes with a kept bar is a near copy
COPY_PENALTY = 1.0
END_BONUS = 0.15

MANIFEST = {
    "id": "amt",
    "label": "Melody completion (AMT)",
    "description": "Fill the missing bars of a hummed melody over given chords (Anticipatory Music Transformer).",
    "kind": "audio",
    "category": "model",
    "python": "3.11",
    "venv": ".venv",
    "setup": [
        ["$UV", "venv", "--python", "3.11", ".venv"],
        ["$UV", "pip", "install", "--python", ".venv/bin/python", "torch==2.7.1", "--index-url",
         "https://download.pytorch.org/whl/cu128"],
        ["$UV", "pip", "install", "--python", ".venv/bin/python", "transformers==4.44.2", "huggingface_hub",
         "git+https://github.com/jthickstun/anticipation"],
    ],
    "params": {},
}

MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]


def load(ctx):
    import torch
    from transformers import AutoModelForCausalLM

    if not (WEIGHTS / "config.json").exists():
        raise SystemExit(f"amt: weights missing in {WEIGHTS}")
    sys.path.insert(0, str(SPIKE))
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "amt"))
    import amt_complete  # noqa: F401  (checked at start, used per request)
    import amt_fast  # noqa: F401

    torch.set_num_threads(2)
    model = AutoModelForCausalLM.from_pretrained(str(WEIGHTS), attn_implementation="eager").cuda().eval()
    ctx.log(f"amt: loaded {WEIGHTS.name} on {torch.cuda.get_device_name(0)}")
    return {"model": model}


def generate(handle, params, out_dir):
    raise RuntimeError("the amt service has no /generate jobs: POST /complete instead")


# --------------------------------------------------------------------------- #

def _req(obj: dict, key: str, kind):
    if key not in obj:
        raise RequestError(400, f"Missing field '{key}'.")
    v = obj[key]
    if kind is float and isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v)
    if kind is int and isinstance(v, int) and not isinstance(v, bool):
        return v
    if kind is list and isinstance(v, list):
        return v
    raise RequestError(400, f"Field '{key}' has the wrong type.")


def _parse(body: bytes) -> dict:
    try:
        req = json.loads(body or b"{}")
    except json.JSONDecodeError:
        raise RequestError(400, "The body must be JSON.") from None
    bpm = _req(req, "bpm", float)
    total = _req(req, "totalBars", int)
    samples = _req(req, "samples", int)
    if not 30 <= bpm <= 300:
        raise RequestError(400, "bpm must be between 30 and 300.")
    if not 1 <= total <= MAX_BARS:
        raise RequestError(400, f"totalBars must be between 1 and {MAX_BARS}.")
    if not 1 <= samples <= MAX_SAMPLES:
        raise RequestError(400, f"samples must be between 1 and {MAX_SAMPLES}.")
    keep = sorted(set(_req(req, "keepBars", list)))
    if any(not isinstance(b, int) or not 0 <= b < total for b in keep):
        raise RequestError(400, "keepBars must be bar numbers from 0 to totalBars - 1.")
    if len(keep) == total:
        raise RequestError(400, "Every bar is kept: there is nothing to complete.")
    end = total * BEATS_PER_BAR
    prompt = []
    for n in _req(req, "prompt", list):
        try:
            beat, midi, dur = float(n["beat"]), int(n["midi"]), float(n["duration"])
        except (KeyError, TypeError, ValueError):
            raise RequestError(400, "Each prompt note needs a numeric beat, midi and duration.") from None
        if not (0 <= beat < end and 0 <= midi <= 127 and dur > 0):
            raise RequestError(400, f"Prompt note out of range: {n}.")
        if int(beat // BEATS_PER_BAR) in keep:
            prompt.append({"beat": beat, "midi": midi, "duration": dur})
    if not prompt:
        raise RequestError(400, "No prompt notes fall in the kept bars.")
    chords = []
    for c in _req(req, "chords", list):
        try:
            beat, dur, pitches = float(c["beat"]), float(c["duration"]), [int(p) for p in c["midi"]]
        except (KeyError, TypeError, ValueError):
            raise RequestError(400, "Each chord needs a numeric beat, duration and a list of midi notes.") from None
        if not (0 <= beat < end and dur > 0 and pitches and all(0 <= p <= 127 for p in pitches)):
            raise RequestError(400, f"Chord out of range: {c}.")
        chords.append({"beat": beat, "duration": dur, "midi": pitches})
    if not chords:
        raise RequestError(400, "Chords for the bars are required.")
    return {"bpm": bpm, "total": total, "samples": samples, "keep": keep, "prompt": sorted(prompt, key=lambda n: n["beat"]),
            "chords": sorted(chords, key=lambda c: c["beat"])}


def _events(notes, program, bpm):
    from amt_complete import note_token, ticks
    from anticipation import ops
    from anticipation.config import MAX_DUR
    from anticipation.vocab import DUR_OFFSET, TIME_OFFSET

    ev = []
    for n in notes:
        d = min(max(ticks(n["duration"], bpm), 1), MAX_DUR - 1)
        ev.extend([TIME_OFFSET + ticks(n["beat"], bpm), DUR_OFFSET + d, note_token(program, n["midi"])])
    return ops.sort(ev)


def _chord_notes(chords):
    """Chords as notes, re-struck at every bar line (as the spike fed them)."""
    out = []
    for c in chords:
        a, b = c["beat"], c["beat"] + c["duration"]
        cuts = sorted({a, b} | {float(x) for x in range(int(a) + 1, int(b) + 1) if x % BEATS_PER_BAR == 0 and a < x < b})
        for s, e in zip(cuts[:-1], cuts[1:]):
            out.extend({"beat": s, "duration": e - s, "midi": p} for p in c["midi"])
    return out


def _gaps(keep, total):
    gaps, start = [], None
    for b in range(total):
        if b not in keep and start is None:
            start = b
        if b in keep and start is not None:
            gaps.append((start, b))
            start = None
    if start is not None:
        gaps.append((start, total))
    return gaps


def _complete_all(model, r):
    """r["samples"] melodies, decoded together (amt_fast.generate_batch: one forward pass per step for all samples).
    Gaps are written in order; a sample whose gap came back with silent bars is sampled again (with the others that
    need it) up to GAP_TRIES times, keeping its try with the most bars written."""
    import amt_fast
    from amt_complete import CHORD_PROGRAM, MELODY_PROGRAM, decode_melody, ticks
    from anticipation import ops
    from anticipation.vocab import CONTROL_OFFSET

    bpm, n = r["bpm"], r["samples"]
    melodies = [[dict(x) for x in r["prompt"]] for _ in range(n)]
    chord_ctrl = _events(_chord_notes(r["chords"]), CHORD_PROGRAM, bpm)
    for g0, g1 in _gaps(r["keep"], r["total"]):
        a, b = g0 * BEATS_PER_BAR, g1 * BEATS_PER_BAR
        rows, splits = [], []
        for mel in melodies:
            before = [x for x in mel if x["beat"] < a]
            after = [x for x in mel if x["beat"] >= b]
            controls = [CONTROL_OFFSET + t for t in ops.sort(chord_ctrl + _events(after, MELODY_PROGRAM, bpm))]
            rows.append((ticks(a, bpm), ticks(b, bpm), _events(before, MELODY_PROGRAM, bpm), controls, TOP_P))
            splits.append((before, after))
        best = [None] * n
        todo = list(range(n))
        for _ in range(GAP_TRIES):
            for i, events in zip(todo, amt_fast.generate_batch(model, [rows[i] for i in todo])):
                new = []
                for x in decode_melody(events, bpm, ticks(a, bpm)):
                    beat = round(x["beat"] * 4) / 4
                    if a <= beat < b:
                        new.append({"beat": beat, "midi": int(x["midi"]),
                                    "duration": min(max(round(x["dur"] * 4) / 4, 0.25), b - beat)})
                filled = len({int(x["beat"] // BEATS_PER_BAR) for x in new})
                if best[i] is None or filled > best[i][0]:
                    best[i] = (filled, new)
            todo = [i for i in range(n) if best[i][0] < g1 - g0]
            if not todo:
                break
        melodies = [sorted(splits[i][0] + best[i][1] + splits[i][1], key=lambda x: x["beat"]) for i in range(n)]
    return melodies


def _key_scale(r):
    """Major or minor scale of the key, by Krumhansl-Schmuckler over the kept notes and the chord tones."""
    import numpy as np

    h = np.zeros(12)
    for n in r["prompt"]:
        h[n["midi"] % 12] += n["duration"]
    for c in r["chords"]:
        for p in c["midi"]:
            h[p % 12] += c["duration"] / len(c["midi"])
    best, scale = -2.0, None
    for prof, steps in ((MAJOR_PROFILE, (0, 2, 4, 5, 7, 9, 11)), (MINOR_PROFILE, (0, 2, 3, 5, 7, 8, 10))):
        for t in range(12):
            rr = np.corrcoef(h, np.roll(prof, t))[0, 1]
            if rr > best:
                best, scale = rr, {(t + s) % 12 for s in steps}
    return scale


def _score(r, melody, scale):
    keep = set(r["keep"])
    gen = [n for n in melody if int(n["beat"] // BEATS_PER_BAR) not in keep]

    def chord_pcs(beat):
        return {p % 12 for c in r["chords"] if c["beat"] <= beat < c["beat"] + c["duration"] for p in c["midi"]}

    def share(flags):
        return round(sum(flags) / len(flags), 3) if flags else 0.0

    def grid(notes, bar, width):
        lo, hi = bar * BEATS_PER_BAR, (bar + width) * BEATS_PER_BAR
        return {round((n["beat"] - lo) * 4) for n in notes if lo <= n["beat"] < hi}

    def jac(x, y):
        return 1.0 if not x and not y else len(x & y) / len(x | y)

    width = 2 if any(b + 1 in keep for b in keep) else 1
    kept_w = [b for b in sorted(keep) if all(b + i in keep for i in range(width))]
    gen_w = [b for b in range(r["total"] - width + 1) if all(b + i not in keep for i in range(width))]
    if not gen_w:
        width = 1
        kept_w = sorted(keep)
        gen_w = [b for b in range(r["total"]) if b not in keep]
    ref = grid(r["prompt"], kept_w[0], width)
    rhythm = max(jac(ref, grid(gen, b, width)) for b in gen_w)
    return {
        "chordToneStrong": share([n["midi"] % 12 in chord_pcs(n["beat"]) for n in gen if n["beat"] % 2 == 0]),
        "inKey": share([n["midi"] % 12 in scale for n in gen]),
        "rhythmMatch": round(rhythm, 3),
    }


def _bar_notes(notes, bar):
    lo = bar * BEATS_PER_BAR
    return {(round((x["beat"] - lo) * 4), x["midi"]) for x in notes if lo <= x["beat"] < lo + BEATS_PER_BAR}


def near_copies(r, melody) -> int:
    """How many written bars are near copies of a kept bar: more than COPY_SHARE of their notes (16th position and
    pitch) match one kept bar. A written bar echoing the bar four bars earlier (bar 5 answering bar 1) is allowed once."""
    keep = set(r["keep"])
    kept = {k: _bar_notes(r["prompt"], k) for k in keep}
    count, echo_used = 0, False
    for g in range(r["total"]):
        if g in keep:
            continue
        got = _bar_notes(melody, g)
        if not got:
            continue
        copied = [k for k, ref in kept.items() if ref and len(got & ref) / max(len(got), len(ref)) > COPY_SHARE]
        if not copied:
            continue
        if not echo_used and (g - BEATS_PER_BAR) in copied:
            echo_used = True
            continue
        count += 1
    return count


def ends_stable(r, melody) -> bool:
    """The last note of the last bar is a tone of the chord sounding under it (only when the last bar is written)."""
    last = r["total"] - 1
    if last in r["keep"]:
        return False
    notes = [x for x in melody if int(x["beat"] // BEATS_PER_BAR) == last]
    if not notes:
        return False
    x = max(notes, key=lambda y: y["beat"])
    return x["midi"] % 12 in {p % 12 for c in r["chords"] if c["beat"] <= x["beat"] < c["beat"] + c["duration"] for p in c["midi"]}


def rank_value(r, melody, score) -> float:
    """Best first: the three checks, scaled by the share of written bars that got notes; minus COPY_PENALTY per
    near-copy bar (share of the written bars), plus END_BONUS for ending on a chord tone. An answering phrase (same
    feel, new pitches) beats a copy of the hum."""
    todo = [b for b in range(r["total"]) if b not in r["keep"]]
    filled = len({int(x["beat"] // BEATS_PER_BAR) for x in melody} & set(todo)) / len(todo)
    return (filled * sum(score.values()) / 3 - COPY_PENALTY * near_copies(r, melody) / len(todo)
            + (END_BONUS if ends_stable(r, melody) else 0.0))


def complete(handle, headers, body):
    import torch

    t0 = time.perf_counter()
    r = _parse(body)
    scale = _key_scale(r)
    out = []
    for melody in _complete_all(handle["model"], r):
        score = _score(r, melody, scale)
        out.append({"notes": melody, "score": score, "_rank": rank_value(r, melody, score)})
    torch.cuda.empty_cache()
    out.sort(key=lambda c: c["_rank"], reverse=True)
    for c in out:
        del c["_rank"]
    return 200, {"completions": out, "tookMs": int((time.perf_counter() - t0) * 1000)}


ROUTES = {"/complete": complete}
