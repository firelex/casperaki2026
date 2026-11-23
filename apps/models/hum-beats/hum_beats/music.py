"""Melodies (scores), the tempo map, and the human performance of a melody.

Units: score positions are in quarter notes ("q") from the first downbeat of the clip (bar 0 starts at q=0;
pickup notes sit at negative q). A bar is 4q (4/4), 3q (3/4) or 3q (6/8); a beat is 1q, 1q or 1.5q (6/8 is
counted in two dotted-quarter beats per bar, the usual annotation convention). Tempo is in beats per minute.

The tempo map turns q into seconds. Everything that bends time (drift, rubato, rushing into phrase ends,
hesitations, held notes) is built INTO the map, so the beat labels (the map evaluated at every beat) follow
the warped timeline exactly. Onset jitter, cut or held note lengths, swallowed notes and the pitch
imperfections are a performance on top of the map: the labels keep the intended (nominal) note, and the
performed times and pitch curve are stored next to it.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass, field

import numpy as np

from .sounds import REPO

PRECEDENT_DIR = REPO / "packages/arrangement/data/vocals/precedents"
METERS = {"4/4": (4.0, 1.0), "3/4": (3.0, 1.0), "6/8": (3.0, 1.5), "2/4": (2.0, 1.0)}  # bar length q, beat length q


@dataclass
class Note:
    q_on: float
    q_off: float
    midi: int
    phrase_end: bool = False


@dataclass
class Score:
    meter: str
    n_bars: int
    notes: list[Note]
    source: dict
    params: dict = field(default_factory=dict)

    @property
    def bar_q(self) -> float:
        return METERS[self.meter][0]

    @property
    def beat_q(self) -> float:
        return METERS[self.meter][1]


# --------------------------------------------------------------------------------------------------------
# Library precedents (sung melodies from the app's vocal banks, 8 bars of 4/4 in quarter-note beats)
# --------------------------------------------------------------------------------------------------------

def load_precedent_families() -> list[dict]:
    """Every distinct precedent melody, once: [{family, bank, name, notes: [(q_on, q_off, midi)]}]."""
    seen, out = set(), []
    for f in sorted(PRECEDENT_DIR.glob("mlDataRaw-*.json")):
        bank = f.stem.removeprefix("mlDataRaw-")
        for p in json.loads(f.read_text()):
            props = p["properties"]
            if props["start"] != 0:
                continue  # the few lead-in variants re-use a melody that is also in the bank from bar 0
            notes = []
            for beat, evs in p["melody"].items():
                top = max(evs, key=lambda e: e["midi"])  # monophonic: keep the top note of a chord
                notes.append((float(beat), float(beat) + float(top["duration"]), int(top["midi"])))
            notes.sort()
            mono = []
            for i, (a, b, m) in enumerate(notes):
                nxt = notes[i + 1][0] if i + 1 < len(notes) else math.inf
                b = min(b, nxt)
                if b - a >= 0.125:
                    mono.append((a, b, m))
            if len(mono) < 6:
                continue
            key = json.dumps(mono)
            if key in seen:
                continue
            seen.add(key)
            out.append({"family": f"prec-{bank}-{len(out):04d}", "bank": bank, "name": props["name"], "bars": int(props["end"]), "notes": mono})
    return out


def _compound_map(f: float) -> float:
    """Within one 4/4 quarter beat, map a straight position (0..1) to the 6/8 dotted-quarter beat (0..1):
    the off-beat eighth lands on the third eighth (long-short), sixteenths follow piecewise linearly."""
    return f * 4 / 3 if f <= 0.5 else 2 / 3 + (f - 0.5) * 2 / 3


def retime_precedent(notes: list[tuple[float, float, int]], meter: str) -> tuple[list[tuple[float, float, int]], int]:
    """Re-time a 4/4 precedent for the meter. Returns notes in q and the number of bars available."""
    if meter == "4/4":
        return list(notes), 8
    if meter == "2/4":
        return list(notes), 16  # the same melody, a bar line every two beats
    if meter == "3/4":
        # per bar, drop the one beat (never the downbeat) with the fewest note starts; later positions in the
        # bar move one beat earlier, notes held through the dropped beat get one beat shorter
        n_bars = 8
        drop = []
        for bar in range(n_bars + 1):
            counts = [sum(1 for a, _, _ in notes if bar * 4 + k <= a < bar * 4 + k + 1) for k in (1, 2, 3)]
            drop.append(1 + max(range(3), key=lambda i: (-counts[i], i)))

        def conv(x: float) -> float | None:
            bar, pos = divmod(x, 4.0)
            bar = int(bar)
            d = drop[min(bar, n_bars)]
            if pos < d:
                return bar * 3.0 + pos
            if pos < d + 1:
                return None
            return bar * 3.0 + pos - 1.0

        out = []
        for a, b, m in notes:
            na = conv(a)
            if na is None:
                continue
            bar_b, pos_b = divmod(b, 4.0)
            d_b = drop[min(int(bar_b), n_bars)]
            nb = conv(b) if conv(b) is not None else int(bar_b) * 3.0 + d_b  # ends inside a dropped beat: end there
            out.append((na, max(nb, na + 0.125), m))
        return out, 8
    if meter == "6/8":
        def conv(x: float) -> float:
            beat, frac = divmod(x, 1.0)
            return (beat + _compound_map(frac)) * 1.5
        return [(conv(a), conv(b), m) for a, b, m in notes], 16
    raise ValueError(f"unknown meter {meter}")


# --------------------------------------------------------------------------------------------------------
# Procedural melodies
# --------------------------------------------------------------------------------------------------------

SCALES = {
    "major": [0, 2, 4, 5, 7, 9, 11],
    "minor": [0, 2, 3, 5, 7, 8, 10],
    "harmonic_minor": [0, 2, 3, 5, 7, 8, 11],
    "dorian": [0, 2, 3, 5, 7, 9, 10],
    "mixolydian": [0, 2, 4, 5, 7, 9, 10],
    "phrygian": [0, 1, 3, 5, 7, 8, 10],
    "lydian": [0, 2, 4, 6, 7, 9, 11],
    "major_pentatonic": [0, 2, 4, 7, 9],
    "minor_pentatonic": [0, 3, 5, 7, 10],
}

# Rhythm cells: durations in q; None marks a rest of that length. (weight, cell, syncopated?)
SIMPLE_CELLS = [
    (6, [1.0], False), (8, [0.5, 0.5], False), (3, [0.5, 0.25, 0.25], False), (3, [0.25, 0.25, 0.5], False),
    (3, [0.75, 0.25], False), (1.5, [0.25, 0.25, 0.25, 0.25], False), (0.7, [1 / 3, 1 / 3, 1 / 3], False),
    (4, [2.0], False), (3, [1.5, 0.5], False), (1.5, [-1.0], False), (1, [-0.5, 0.5], False),
    (3, [0.5, 1.0, 0.5], True), (2, [0.5, 1.5], True), (2, [0.75, 0.75, 0.5], True), (1.5, [-0.5, 1.0, 0.5], True),
    (1.5, [0.25, 0.5, 0.25], True),
]
COMPOUND_CELLS = [
    (6, [1.5], False), (6, [1.0, 0.5], False), (5, [0.5, 0.5, 0.5], False), (2, [0.75, 0.25, 0.5], False),
    (2, [0.5, 0.25, 0.25, 0.5], False), (4, [3.0], False), (2, [-1.5], False), (2, [-0.5, 0.5, 0.5], False),
    (2, [0.5, 1.0], True), (2, [1.0, 1.0, 1.0], True), (1.5, [0.5, 1.5, 1.0], True), (1, [-1.0, 0.5], False),
]


def _cells_for(meter: str, style: str, bpm: float) -> tuple[list, list]:
    cells = COMPOUND_CELLS if meter == "6/8" else SIMPLE_CELLS
    sec_per_q = 60.0 / bpm / METERS[meter][1]
    w_out, c_out = [], []
    for w, cell, sync in cells:
        shortest = min(abs(d) for d in cell) * sec_per_q
        if shortest < 0.09:
            continue  # too fast to hum
        if sync:
            w = w * (3.0 if style == "syncopated" else 0.25)
        if any(abs(d) < 0.3 for d in cell) and style == "swung":
            w *= 0.4  # swing reads best on eighths
        w_out.append(w)
        c_out.append(cell)
    return w_out, c_out


def _fill_rhythm(rng, total_q: float, beat_q: float, weights, cells) -> list[float]:
    """Durations (negative = rest) filling total_q, each cell starting on a beat."""
    out, pos = [], 0.0
    p = np.asarray(weights) / np.sum(weights)
    while pos < total_q - 1e-6:
        for _ in range(30):
            cell = cells[rng.choice(len(cells), p=p)]
            length = sum(abs(d) for d in cell)
            if pos + length <= total_q + 1e-6 and abs((length / beat_q) - round(length / beat_q)) < 1e-6:
                break
        else:
            cell = [total_q - pos]
            length = total_q - pos
        out.extend(cell)
        pos += length
    return out


def procedural_score(rng: np.random.Generator, meter: str, style: str, bpm: float, n_bars: int) -> tuple[list[tuple[float, float, int]], dict]:
    """A scale-based melody of n_bars: phrases of 1-4 bars, stepwise with leaps, long phrase ends."""
    bar_q, beat_q = METERS[meter]
    scale_name = rng.choice(list(SCALES))
    scale = SCALES[scale_name]
    tonic = int(rng.integers(0, 12))
    weights, cells = _cells_for(meter, style, bpm)
    phrase_bars = {2: [1, 2], 4: [2, 4], 8: [2, 4]}[n_bars]
    phrases, left = [], n_bars
    while left > 0:
        pb = int(rng.choice([b for b in phrase_bars if b <= left]))
        phrases.append(pb)
        left -= pb
    # pitch in scale-degree space, centred on degree 7 (an octave above the tonic)
    n_deg = len(scale)
    def deg_to_midi(d: int) -> int:
        o, k = divmod(d, n_deg)
        return 48 + tonic + 12 * o + scale[k]
    deg = n_deg + int(rng.integers(-2, 3))
    lo, hi = n_deg - int(rng.integers(2, 4)), 2 * n_deg + int(rng.integers(0, 3))
    contour = rng.choice(["arch", "rise", "fall", "wave", "flat"])
    notes, q = [], 0.0
    motif = None
    for pi, pb in enumerate(phrases):
        length = pb * bar_q
        if motif is not None and rng.random() < 0.45 and abs(sum(abs(d) for d in motif) - length) < 1e-6:
            rhythm = list(motif)  # repeat the first phrase's rhythm
        else:
            rhythm = _fill_rhythm(rng, length, beat_q, weights, cells)
        # phrase end: make the last sounding note long and maybe leave a breath
        if motif is None:
            motif = list(rhythm)
        k = len(rhythm) - 1
        while k > 0 and rhythm[k] < 0:
            k -= 1
        merged = rhythm[:k]
        tail = sum(abs(d) for d in rhythm[k:])
        if pi < len(phrases) - 1 and tail >= 2 * beat_q and rng.random() < 0.6:
            merged += [tail - beat_q, -beat_q]
        else:
            merged += [tail]
        pos = q
        sounding = [d for d in merged if d > 0]
        for j, d in enumerate(merged):
            if d < 0:
                pos += -d
                continue
            frac = j / max(1, len(merged) - 1)
            target = {"arch": math.sin(math.pi * frac), "rise": frac, "fall": 1 - frac, "wave": 0.5 + 0.5 * math.sin(2 * math.pi * frac), "flat": 0.5}[contour]
            target_deg = lo + target * (hi - lo)
            r = rng.random()
            if r < 0.15:
                step = 0
            elif r < 0.75:
                step = 1 if rng.random() < 0.5 + 0.08 * (target_deg - deg) else -1
            elif r < 0.97:
                step = int(rng.integers(2, 5)) * (1 if rng.random() < 0.5 + 0.08 * (target_deg - deg) else -1)
            else:
                step = n_deg * (1 if deg < (lo + hi) / 2 else -1)
            deg = int(np.clip(deg + step, lo, hi))
            is_end = d is sounding[-1] and j == max(i for i, x in enumerate(merged) if x > 0)
            if is_end:
                # land on a stable degree (tonic / third / fifth), the very last phrase on the tonic
                stable = [x for x in range(lo, hi + 1) if x % n_deg in ((0,) if pi == len(phrases) - 1 else (0, 2, 4)) and (n_deg == 7 or x % n_deg in (0, 2, 3))]
                deg = min(stable, key=lambda x: abs(x - deg)) if stable else deg
            notes.append((pos, pos + d, deg_to_midi(deg)))
            pos += d
        q += length
    return notes, {"scale": str(scale_name), "tonic": tonic, "contour": str(contour), "phrases": phrases}


# --------------------------------------------------------------------------------------------------------
# Shared rhythm transforms
# --------------------------------------------------------------------------------------------------------

def swing_position(x: float, amount: float) -> float:
    """Delay each off-beat eighth by `amount` q (0.08 = 58% swing, 0.17 = triplet swing)."""
    beat, f = divmod(x, 1.0)
    if f <= 0.5:
        g = f * (0.5 + amount) / 0.5
    else:
        g = 0.5 + amount + (f - 0.5) * (0.5 - amount) / 0.5
    return beat + g


def apply_syncopation(rng, notes, beat_q: float, prob: float):
    """Anticipate some on-beat notes by an eighth (or sixteenth) when there is room before them."""
    out = list(notes)
    for i in range(1, len(out)):
        a, b, m = out[i]
        if abs(a / beat_q - round(a / beat_q)) > 1e-6 or rng.random() >= prob:
            continue
        shift = 0.5 if rng.random() < 0.75 else 0.25
        prev_a, prev_b, prev_m = out[i - 1]
        if a - shift - prev_a < 0.25:
            continue
        out[i - 1] = (prev_a, min(prev_b, a - shift), prev_m)
        out[i] = (a - shift, b, m)
    return out


def mark_phrase_ends(notes: list[Note], beat_q: float) -> None:
    for i, n in enumerate(notes):
        gap = (notes[i + 1].q_on - n.q_off) if i + 1 < len(notes) else math.inf
        n.phrase_end = gap >= beat_q - 1e-6 or (n.q_off - n.q_on) >= 2 * beat_q - 1e-6


# --------------------------------------------------------------------------------------------------------
# Tempo map
# --------------------------------------------------------------------------------------------------------

class TempoMap:
    """Piecewise-linear q -> seconds, from a local seconds-per-quarter curve on a fine q grid."""

    RES = 1 / 48

    def __init__(self, q0: float, q1: float, sec_per_q: np.ndarray):
        self.q = q0 + np.arange(len(sec_per_q) + 1) * self.RES
        self.t = np.concatenate([[0.0], np.cumsum(sec_per_q * self.RES)])
        if not np.all(np.diff(self.t) > 0):
            raise ValueError("tempo map is not strictly increasing")

    def time(self, q):
        q = np.asarray(q, dtype=float)
        if np.any(q < self.q[0] - 1e-9) or np.any(q > self.q[-1] + 1e-9):
            raise ValueError(f"score position outside the tempo map ({q.min()}..{q.max()} vs {self.q[0]}..{self.q[-1]})")
        return np.interp(q, self.q, self.t)

    def position(self, t):
        return np.interp(np.asarray(t, dtype=float), self.t, self.q)


def smooth_noise(rng, n: int, n_waves: int, min_period: float, max_period: float, grid_step: float) -> np.ndarray:
    """Sum of a few slow sinusoids, normalised to peak 1 (periods in q)."""
    x = np.arange(n) * grid_step
    y = np.zeros(n)
    for _ in range(n_waves):
        period = rng.uniform(min_period, max_period)
        y += rng.uniform(0.3, 1.0) * np.sin(2 * np.pi * x / period + rng.uniform(0, 2 * np.pi))
    peak = np.abs(y).max()
    return y / peak if peak > 0 else y


def build_tempo_map(rng, score: Score, bpm: float, timing: str, q0: float, q1: float, amounts: dict) -> tuple[TempoMap, dict]:
    """Local tempo curve with drift, rubato, rushing into phrase ends, hesitations and held notes.

    `amounts` holds 0..1 strengths drawn per clip; `timing` is perfect / humanised / irregular.
    Returns the map and the exact parameters used (stored in the clip JSON)."""
    beat_q = score.beat_q
    n = int(math.ceil((q1 - q0) / TempoMap.RES))
    grid = q0 + np.arange(n) * TempoMap.RES
    base = 60.0 / bpm / beat_q  # seconds per quarter
    factor = np.ones(n)  # >1 = slower
    p: dict = {"timing": timing}
    if timing != "perfect":
        span = max(q1 - q0, 1e-6)
        drift = rng.uniform(-1, 1) * (0.05 if timing == "humanised" else 0.08) * amounts["tempo"]
        factor *= 1.0 - drift * (grid - q0) / span  # drift>0 speeds up over the clip
        wander_amp = (0.025 if timing == "humanised" else 0.15) * amounts["tempo"]
        wander = smooth_noise(rng, n, 3, 2 * score.bar_q, 6 * score.bar_q, TempoMap.RES)
        factor *= 1.0 + wander_amp * wander
        p.update(drift_fraction=drift, wander_amplitude=wander_amp)
        rush = rng.uniform(0, 0.12 if timing == "irregular" else 0.06) * amounts["tempo"]
        hesitate = rng.uniform(0, 0.45 if timing == "irregular" else 0.15) * amounts["tempo"]
        hold = 0.0
        if timing == "irregular":
            hold = rng.uniform(0.2, 1.0) * amounts["tempo"]
        events = []
        mids = sorted(x.midi for x in score.notes)
        high = mids[int(0.8 * (len(mids) - 1))]
        for i, nt in enumerate(score.notes):
            dur = nt.q_off - nt.q_on
            if nt.phrase_end and rush > 0:
                # speed up over the 1.5 beats before the phrase-end note
                m = (grid >= nt.q_on - 1.5 * beat_q) & (grid < nt.q_on)
                factor[m] *= 1.0 - rush
                events.append(("rush", nt.q_on, rush))
            if hesitate > 0 and i > 0 and (nt.midi >= high or dur >= 1.5 * beat_q) and rng.random() < 0.5:
                # stretch the half beat before a high or long note (a breath, a hesitation)
                h = hesitate * rng.uniform(0.5, 1.0)
                m = (grid >= nt.q_on - 0.5 * beat_q) & (grid < nt.q_on)
                factor[m] *= 1.0 + 2 * h
                events.append(("hesitate", nt.q_on, h))
            if hold > 0 and dur >= beat_q and rng.random() < 0.25:
                # a held note (fermata-like): time slows down over the note
                f = 1.0 + hold * rng.uniform(0.3, 1.0)
                m = (grid >= nt.q_on) & (grid < nt.q_off)
                factor[m] *= f
                events.append(("hold", nt.q_on, f))
        p.update(rush=rush, hesitate=hesitate, hold=hold, events=[(k, round(q, 4), round(v, 4)) for k, q, v in events])
    factor = np.clip(factor, 0.6, 2.5)
    return TempoMap(q0, q1, base * factor), p


# --------------------------------------------------------------------------------------------------------
# Performance: what the singer or player actually does with each note
# --------------------------------------------------------------------------------------------------------

def perform(rng, score: Score, tmap: TempoMap, timing: str, amounts: dict, is_last_held: bool, is_voice_like: bool) -> tuple[list[dict], dict]:
    """Nominal + performed times, loudness and articulation per note (pitch curve is made by the renderer).

    Returns note dicts with: q_on, q_off, midi, nominal_onset, nominal_offset, onset, offset, velocity,
    articulation, swallowed (None | 'soft' | 'missing'), phrase_end."""
    a_prec = amounts["precision"]
    if timing == "perfect":
        jitter_ms = 0.0
    elif timing == "humanised":
        jitter_ms = rng.uniform(10, 40)
    else:
        jitter_ms = rng.uniform(15, 60)
    jitter_ms *= max(a_prec, 0.25) if timing != "perfect" else 0.0
    legato_share = rng.uniform(0.2, 1.0) if is_voice_like else rng.uniform(0.0, 0.8)
    swallow_p = rng.uniform(0, 0.08) * a_prec if timing != "perfect" else 0.0
    loud_spread = rng.uniform(0.03, 0.25)
    walk = 0.0
    out = []
    prev_onset = -math.inf
    for i, nt in enumerate(score.notes):
        nom_on = float(tmap.time(nt.q_on))
        nom_off = float(tmap.time(nt.q_off))
        dur = nom_off - nom_on
        j = 0.0
        if jitter_ms > 0:
            j = rng.normal(0, jitter_ms / 2) / 1000
            if rng.random() < 0.05:
                j *= 2.5  # an occasional bigger slip
            j = float(np.clip(j, -2.5 * jitter_ms / 1000, 2.5 * jitter_ms / 1000))
        onset = max(nom_on + j, prev_onset + 0.04)
        nxt_on = float(tmap.time(score.notes[i + 1].q_on)) if i + 1 < len(score.notes) else math.inf
        gap_to_next = nxt_on - nom_off
        if gap_to_next < 0.02 and rng.random() < legato_share:
            art = "legato"
            offset = nom_off + (rng.uniform(-0.01, 0.03) if timing != "perfect" else 0.0)
        else:
            art = "detached"
            keep = rng.uniform(0.55, 0.92) if timing != "perfect" else 0.85
            offset = onset + max(0.06, dur * keep)
        if timing != "perfect" and rng.random() < 0.3 * a_prec:
            offset += dur * rng.uniform(-0.25, 0.2)  # cut short or held over
        if i == len(score.notes) - 1 and is_last_held:
            offset = nom_off + rng.uniform(0.2, 1.2) * (nom_off - nom_on + 0.3)
        offset = max(offset, onset + 0.05)
        if i + 1 < len(score.notes):
            offset = min(offset, nxt_on + 0.03)  # a monophonic line: at most a tiny overlap (glide)
        walk = float(np.clip(walk + rng.normal(0, 0.06), -0.25, 0.25))
        vel = float(np.clip(0.72 + walk + rng.normal(0, loud_spread), 0.2, 1.0))
        swallowed = None
        if swallow_p > 0 and (nt.q_off - nt.q_on) <= 0.5 * score.beat_q + 1e-6 and not nt.phrase_end and rng.random() < swallow_p:
            swallowed = "missing" if rng.random() < 0.4 else "soft"
            vel = vel * 0.15 if swallowed == "soft" else 0.0
        out.append({
            "q_on": nt.q_on, "q_off": nt.q_off, "midi": nt.midi, "phrase_end": nt.phrase_end,
            "nominal_onset": nom_on, "nominal_offset": nom_off, "onset": onset, "offset": offset,
            "velocity": vel, "articulation": art, "swallowed": swallowed,
        })
        prev_onset = onset
    return out, {"jitter_ms": jitter_ms, "legato_share": legato_share, "swallow_probability": swallow_p, "loudness_spread": loud_spread}


# --------------------------------------------------------------------------------------------------------
# Procedural melodies, round two: real rhythms, new pitches
# --------------------------------------------------------------------------------------------------------

def mutate_rhythm(rng, notes, beat_q: float, bar_q: float, p_merge: float = 0.08, p_split: float = 0.08):
    """Small metrical edits: merge a short note into the next one, or split a long note at a beat. The edit is
    decided once per bar rhythm, so bars that repeat a rhythm keep repeating it (as in real melodies)."""
    bars: dict[int, list] = {}
    for n in notes:
        bars.setdefault(int(np.floor(n[0] / bar_q + 1e-9)), []).append(n)
    decisions: dict[tuple, int] = {}
    out = []
    for b in sorted(bars):
        bn = bars[b]
        key = tuple(round(x[0] - b * bar_q, 3) for x in bn) + tuple(round(x[1] - x[0], 3) for x in bn)
        if key not in decisions:
            decisions[key] = int(rng.integers(1 << 30))
        brng = np.random.default_rng(decisions[key])
        i = 0
        while i < len(bn):
            a, e, m = bn[i]
            if i + 1 < len(bn) and abs(bn[i + 1][0] - e) < 1e-6 and (e - a) < beat_q and brng.random() < p_merge:
                out.append((a, bn[i + 1][1], m))
                i += 2
                continue
            if (e - a) >= 2 * beat_q - 1e-6 and brng.random() < p_split:
                half = a + round(((e - a) / 2) / beat_q) * beat_q
                out.extend([(a, half, m), (half, e, m)])
            else:
                out.append((a, e, m))
            i += 1
    return out


def melodize(rng, rhythm, beat_q: float) -> tuple[list[tuple[float, float, int]], dict]:
    """New pitches over a given rhythm: a scale, phrase contours, steps and leaps, phrase ends (a rest of a
    beat or more after the note) on stable degrees, the last note on the tonic."""
    scale_name = rng.choice(list(SCALES))
    scale = SCALES[scale_name]
    tonic = int(rng.integers(0, 12))
    n_deg = len(scale)
    lo, hi = n_deg - int(rng.integers(2, 4)), 2 * n_deg + int(rng.integers(0, 3))

    def deg_to_midi(d: int) -> int:
        o, k = divmod(d, n_deg)
        return 48 + tonic + 12 * o + scale[k]

    stable_set = (0, 2, 4) if n_deg == 7 else (0, 2, 3)
    deg = n_deg + int(rng.integers(-2, 3))
    out = []
    # phrase boundaries from the rhythm itself
    ends = [i for i in range(len(rhythm)) if i == len(rhythm) - 1 or rhythm[i + 1][0] - rhythm[i][1] >= beat_q - 1e-6]
    start = 0
    for e in ends:
        contour = rng.choice(["arch", "rise", "fall", "wave"])
        n = e - start + 1
        for j in range(n):
            a, b, _ = rhythm[start + j]
            frac = j / max(1, n - 1)
            target = {"arch": np.sin(np.pi * frac), "rise": frac, "fall": 1 - frac, "wave": 0.5 + 0.5 * np.sin(2 * np.pi * frac)}[contour]
            target_deg = lo + target * (hi - lo)
            r = rng.random()
            up = rng.random() < 0.5 + 0.08 * (target_deg - deg)
            step = 0 if r < 0.18 else (1 if up else -1) if r < 0.78 else int(rng.integers(2, 5)) * (1 if up else -1)
            deg = int(np.clip(deg + step, lo, hi))
            if j == n - 1:
                last = start + j == len(rhythm) - 1
                cands = [x for x in range(lo, hi + 1) if x % n_deg in ((0,) if last else stable_set)]
                deg = min(cands, key=lambda x: abs(x - deg))
            out.append((a, b, deg_to_midi(deg)))
        start = e + 1
    return out, {"scale": str(scale_name), "tonic": tonic}
