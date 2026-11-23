"""A deviation model fitted on real hums: how people actually perform a melody against its score.

Built from the HumTrans TRAIN measurements of scripts/humtrans_deviations.py (CC BY-NC 4.0 data: only the
measured deviation statistics drive the generator; no HumTrans audio goes into training data).

Sampling, per synthetic clip:
  * a donor recording (one real hummer performing one piece) from the fit portion: its slow timing drift
    curve, tuning offset and pitch drift, so a careless hummer stays careless through the clip;
  * per note, a real note performance from the SAME singer, matched on context (note length in beats, the
    interval leap into it, its place in the phrase), half the time from the donor recording itself: its
    onset jitter, duration ratio, loudness and whole pitch-deviation contour (scoops, overshoots, vibrato,
    falls), time-warped to the new note's length;
  * some extra randomness: per-clip scales of 0.85-1.15 on timing, pitch and loudness deviations and small
    Gaussian noise.
Where no real note shares a note's full context, the match is relaxed step by step (phrase place, then leap
direction and size, then length), always within the singer; the clip JSON records how often.
"""
from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

import numpy as np


def len_bin(beats: float) -> int:
    return 0 if beats < 0.75 else 1 if beats < 1.5 else 2 if beats < 3.0 else 3


def leap_bin(leap: int) -> int:
    a = abs(leap)
    size = 0 if a == 0 else 1 if a <= 2 else 2 if a <= 5 else 3
    return size if leap >= 0 else -size


def _median3(c: np.ndarray) -> np.ndarray:
    """3-frame median over the voiced frames (removes single-frame tracker noise, keeps scoops and vibrato)."""
    out = c.copy()
    for i in range(1, len(c) - 1):
        w = c[i - 1:i + 2]
        if np.isfinite(w).all():
            out[i] = np.median(w)
    return out


class DeviationModel:
    def __init__(self, prefix: Path, fit_pieces: set[str]):
        clips = json.loads(prefix.with_suffix(".clips.json").read_text())
        self.clips = [c for c in clips if c["piece"] in fit_pieces]
        if not self.clips:
            raise ValueError(f"no fit recordings in {prefix}")
        keys = {c["key"] for c in self.clips}
        self.index: dict[tuple, list] = defaultdict(list)
        self.by_clip: dict[str, list] = defaultdict(list)
        n = 0
        with open(prefix.with_suffix(".notes.jsonl")) as f:
            for line in f:
                r = json.loads(line)
                if r["key"] not in keys or not np.isfinite(r["pitch_err"] if r["pitch_err"] is not None else np.nan):
                    continue
                if abs(r["pitch_err"]) > 200:
                    continue  # a pitch-tracker failure or a wrong note, not a deviation to imitate
                c = np.array([np.nan if v is None else v for v in r["contour"]], dtype=np.float32)
                c[np.abs(c) > 300] = np.nan  # tracker octave jumps
                if np.isfinite(c).sum() < 2:
                    continue
                c = _median3(c)
                rec = (r["jitter"], r["dur_ratio"], r["loud_db"], c, r["key"])
                lb, pb, pos = len_bin(r["len_beats"]), leap_bin(r["leap"]), r["phrase_pos"]
                s = r["singer"]
                for level, k in enumerate([(lb, pb, pos), (lb, pb), (lb, abs(pb)), (lb,), ()]):
                    self.index[(s, level) + k].append(rec)
                self.by_clip[r["key"]].append((lb, pb, pos, rec))
                n += 1
        self.n_notes = n
        self.singers = sorted({c["singer"] for c in self.clips})

    def donor(self, rng) -> dict:
        return self.clips[int(rng.integers(len(self.clips)))]

    def _note(self, rng, singer: str, key: str, lb: int, pb: int, pos: str):
        if rng.random() < 0.5:
            own = [x[3] for x in self.by_clip[key] if x[0] == lb and x[1] == pb]
            if own:
                return own[int(rng.integers(len(own)))], 0
        for level, k in enumerate([(lb, pb, pos), (lb, pb), (lb, abs(pb)), (lb,), ()]):
            cands = self.index.get((singer, level) + k)
            if cands:
                return cands[int(rng.integers(len(cands)))], level
        raise KeyError(f"singer {singer} has no measured notes")


def warp_contour(c: np.ndarray, n_out: int, head: int = 10, tail: int = 8) -> np.ndarray:
    """Time-warp a 10 ms contour to n_out frames: the first 100 ms and last 80 ms keep their speed (scoops,
    falls), the middle stretches; unvoiced gaps inside are interpolated, ends filled from the nearest value."""
    c = c.astype(np.float64)
    ok = np.isfinite(c)
    idx = np.arange(len(c))
    c = np.interp(idx, idx[ok], c[ok])
    if n_out <= 0:
        return np.zeros(0)
    if len(c) <= head + tail or n_out <= head + tail:
        return np.interp(np.linspace(0, len(c) - 1, n_out), idx, c)
    mid = c[head:len(c) - tail]
    mid_out = np.interp(np.linspace(0, len(mid) - 1, n_out - head - tail), np.arange(len(mid)), mid)
    return np.concatenate([c[:head], mid_out, c[len(c) - tail:]])


def perform(model: DeviationModel, rng, score, tmap, perfect_timing: bool, release_comp: float = 0.045) -> tuple[list[dict], dict]:
    """Nominal + performed note times, loudness and real pitch-deviation contours for every score note.

    perfect_timing=True keeps every onset on the score (pitch and loudness deviations still apply)."""
    donor = model.donor(rng)
    singer, key = donor["singer"], donor["key"]
    s_t, s_p, s_l = (float(rng.uniform(0.85, 1.15)) for _ in range(3))
    drift_curve = np.array(donor["drift_curve"]) * float(rng.uniform(0.8, 1.2))
    notes = score.notes
    q0, q1 = notes[0].q_on, max(n.q_off for n in notes)
    t_first, t_last = float(tmap.time(q0)), float(tmap.time(q1))
    out, levels = [], defaultdict(int)
    prev_onset = -np.inf
    for i, nt in enumerate(notes):
        nom_on, nom_off = float(tmap.time(nt.q_on)), float(tmap.time(nt.q_off))
        gap_before = (nt.q_on - notes[i - 1].q_off) if i > 0 else 9.0
        gap_after = (notes[i + 1].q_on - nt.q_off) if i + 1 < len(notes) else 9.0
        pos = "start" if gap_before >= 0.75 * score.beat_q else ("end" if gap_after >= 0.75 * score.beat_q else "mid")
        lb = len_bin((nt.q_off - nt.q_on) / score.beat_q)
        pb = leap_bin(nt.midi - notes[i - 1].midi if i > 0 else 0)
        (jit, ratio, loud, contour, src_key), level = model._note(rng, singer, key, lb, pb, pos)
        levels[level] += 1
        if perfect_timing:
            onset = nom_on
        else:
            rel = (nom_on - t_first) / max(t_last - t_first, 1e-6)
            onset = nom_on + float(np.interp(rel, np.linspace(0, 1, len(drift_curve)), drift_curve)) + jit * s_t + float(rng.normal(0, 0.002))
        onset = max(onset, prev_onset + 0.04)
        # the measured ratio ends where the sound has faded; our renderers fade over the release after the
        # note-off, which a measurement sees ending about release_comp seconds later
        dur = max(0.05, ratio * (nom_off - nom_on) * float(rng.uniform(0.95, 1.05)) - release_comp)
        offset = onset + dur
        if i + 1 < len(notes):
            offset = min(offset, float(tmap.time(notes[i + 1].q_on)) + 0.03)
        offset = max(offset, onset + 0.05)
        # the renderers scale amplitude by velocity ** 1.3, so this makes the amplitude follow the measured dB
        vel = float(np.clip(0.7 * 10 ** (loud * s_l / 20 / 1.3), 0.08, 1.0))
        out.append({
            "q_on": nt.q_on, "q_off": nt.q_off, "midi": nt.midi, "phrase_end": nt.phrase_end,
            "nominal_onset": nom_on, "nominal_offset": nom_off, "onset": onset, "offset": offset,
            "velocity": vel, "articulation": "legato" if gap_after < 1e-6 and offset >= float(tmap.time(nt.q_off)) - 0.03 else "detached",
            "swallowed": None, "contour_src": src_key, "contour": contour, "pitch_scale": s_p,
        })
        prev_onset = onset
    params = {"model": "humtrans-train deviation model", "donor": key, "singer": singer, "timing_scale": s_t, "pitch_scale": s_p,
              "loudness_scale": s_l, "drift_curve_s": [round(float(x), 4) for x in drift_curve],
              "tuning_cents": float(donor["tuning_cents"]) * float(rng.uniform(0.8, 1.2)),
              "pitch_drift_cents_per_s": float(donor["pitch_drift_cents_per_s"]) * float(rng.uniform(0.8, 1.2)),
              "context_match_levels": {str(k): v for k, v in sorted(levels.items())}, "perfect_timing": perfect_timing}
    return out, params


def pitch_curve_from_contours(perf: list[dict], dur: float, params: dict, expressive: bool, ctrl: int = 1000) -> np.ndarray:
    """Performed pitch (cents, 100 x MIDI) on the ctrl grid; NaN between notes.

    expressive: the note follows its real contour; otherwise (keys, plucks) one steady pitch per note at the
    contour's median deviation x 0.3."""
    n = int(np.ceil(dur * ctrl)) + 1
    cents = np.full(n, np.nan)
    for p in perf:
        if p["velocity"] <= 0:
            continue
        if p["onset"] < 0:
            raise ValueError(f"note performed before the clip start ({p['onset']:.3f} s)")
        a, b = int(p["onset"] * ctrl), min(n, int(p["offset"] * ctrl))
        if b - a < 2:
            continue
        frames10 = max(2, int(round((b - a) / (ctrl / 100))))
        c = warp_contour(p["contour"], frames10) * p["pitch_scale"]
        c = np.interp(np.arange(b - a) / (ctrl / 100), np.arange(frames10), c)
        if not expressive:
            c = np.full(b - a, 0.3 * float(np.median(c)))
        t = np.arange(a, b) / ctrl
        cents[a:b] = 100.0 * p["midi"] + c + params["tuning_cents"] + params["pitch_drift_cents_per_s"] * t
    return cents
