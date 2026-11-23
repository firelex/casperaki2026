"""One clip from a plan row: melody -> tempo map -> performance -> audio -> labels. And the plan itself.

A plan row fixes the clip id, split, family (the source melody: a library precedent or a procedural seed)
and a seed; everything else is drawn from the seed here, so a clip can be regenerated exactly.
"""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path

import mido
import numpy as np
import soundfile as sf

from . import music
from .music import METERS, Note, Score
from .render import (BREATHY_MEDIAN, CTRL, POLLUTION_LEVELS, POLLUTION_P, TRAIN_VOWELS, UNSEEN_VOWELS, VOICE_TYPES,
                     loudness_curve, pitch_amounts, pitch_curve, pollute, render_breathy, render_sampler, render_voice,
                     to_audio_rate)
from .sounds import SR, SoundBank

SPLIT_CLIPS = {"train": 27500, "dev": 1000, "test": 1000, "test-unseen": 500}
MAX_ATTACK_MS = 250  # library sounds with slower attacks blur onsets too much to serve as a melody line
PITCH_HOP_S = 0.01


def seed_of(*parts) -> int:
    return int.from_bytes(hashlib.sha256("|".join(map(str, parts)).encode()).digest()[:8], "little")


# --------------------------------------------------------------------------------------------------------
# Plan
# --------------------------------------------------------------------------------------------------------

def make_plan(scale: float = 1.0, plan_seed: int = 2026) -> list[dict]:
    """Rows for every clip. Families never cross splits. scale < 1 makes a proportional pilot."""
    rng = np.random.default_rng(plan_seed)
    fams = music.load_precedent_families()
    order = rng.permutation(len(fams))
    shares = {"dev": 0.04, "test": 0.04, "test-unseen": 0.025}
    by_split: dict[str, list[dict]] = {k: [] for k in SPLIT_CLIPS}
    pos = 0
    for split, share in shares.items():
        k = int(round(share * len(fams)))
        by_split[split] = [fams[i] for i in order[pos:pos + k]]
        pos += k
    by_split["train"] = [fams[i] for i in order[pos:]]
    rows = []
    for split, total in SPLIT_CLIPS.items():
        n = int(round(total * scale))
        n_prec = n // 2
        pf = by_split[split]
        for i in range(n):
            clip_id = f"{split}-{i:05d}"
            if i < n_prec:
                fam = pf[i % len(pf)]
                rows.append({"clip_id": clip_id, "split": split, "family": fam["family"], "source": "precedent", "seed": seed_of(plan_seed, clip_id)})
            else:
                rows.append({"clip_id": clip_id, "split": split, "family": f"proc-{split}-{i:05d}", "source": "procedural", "seed": seed_of(plan_seed, clip_id)})
    return rows


# --------------------------------------------------------------------------------------------------------
# Melody for a clip
# --------------------------------------------------------------------------------------------------------

_FAMILIES: dict[str, dict] | None = None


def precedent(family: str) -> dict:
    global _FAMILIES
    if _FAMILIES is None:
        _FAMILIES = {f["family"]: f for f in music.load_precedent_families()}
    return _FAMILIES[family]


def _repitch(rng, notes, info: dict | None = None):
    """Give a rhythm-only precedent (one repeated pitch) a scale-based melody (tonic C before transposition; the
    scale name goes into info["repitch_scale"] when info is given)."""
    name = rng.choice(list(music.SCALES))
    scale = music.SCALES[name]
    if info is not None:
        info["repitch_scale"] = str(name)
    deg, out = len(scale), []
    for a, b, _ in notes:
        r = rng.random()
        deg += 0 if r < 0.2 else (rng.choice([-1, 1]) if r < 0.8 else int(rng.integers(-3, 4)))
        deg = int(np.clip(deg, 2, 2 * len(scale) + 2))
        o, k = divmod(deg, len(scale))
        out.append((a, b, 48 + 12 * o + scale[k]))
    return out


def clip_melody(rng, row: dict, meter: str, n_bars: int, style: str, bpm: float, start_mode: str) -> tuple[list[tuple[float, float, int]], dict]:
    bar_q, beat_q = METERS[meter]
    info: dict = {}
    if row["source"] == "precedent":
        fam = precedent(row["family"])
        base = fam["notes"]
        if len({m for _, _, m in base}) <= 2:
            base = _repitch(rng, base, info)
            info["repitched"] = True
        notes, bars_avail = music.retime_precedent(base, meter)
        starts = list(range(0, bars_avail - n_bars + 1))
        even = [s for s in starts if s % 2 == 0]
        s = int(rng.choice(even if even and rng.random() < 0.8 else starts))
        q0 = s * bar_q
        notes = [(a - q0, min(b - q0, n_bars * bar_q), m) for a, b, m in notes if q0 - 2 * beat_q <= a < q0 + n_bars * bar_q]
        info.update(precedent_bank=fam["bank"], precedent_name=fam["name"], window_start_bar=s)
    else:
        notes, pinfo = music.procedural_score(rng, meter, style, bpm, n_bars)
        info.update(pinfo)
    # how the clip starts
    beats_per_bar = int(round(bar_q / beat_q))
    pickup_beats = int(rng.integers(1, beats_per_bar))  # a pickup is shorter than a bar
    pick = [x for x in notes if -pickup_beats * beat_q - 1e-6 <= x[0] < 0]
    body = [x for x in notes if x[0] >= 0]
    if start_mode == "downbeat":
        notes = body
    elif start_mode == "pickup":
        if not body:
            notes = []  # an empty window: the caller draws another one
        elif pick and rng.random() < 0.8:
            notes = pick + body
        else:
            # write a pickup: 1-3 notes stepping into the first note, in the last beat(s) before bar 0
            first = body[0][2]
            k = int(rng.integers(1, 4))
            unit = beat_q / 2 if (rng.random() < 0.6 or meter == "6/8") else beat_q
            if meter == "6/8":
                unit = 0.5
            k = min(k, int(round((beats_per_bar - 1) * beat_q / unit)))  # shorter than a bar
            steps = rng.choice([-2, -1, 1, 2], size=k)
            pitches = list(first - np.cumsum(steps[::-1])[::-1])
            notes = [(-(k - j) * unit, -(k - j - 1) * unit, int(p)) for j, p in enumerate(pitches)] + body
            info["written_pickup"] = k
    elif start_mode == "midbar":
        cut_choices = [c * 0.5 for c in range(1, int(bar_q / 0.5)) if c * 0.5 >= beat_q - 1e-6]
        if n_bars == 2:  # a 2-bar clip has as few as 4 beats (6/8): cut in the first half of the bar only
            cut_choices = [c for c in cut_choices if c <= bar_q / 2 + 1e-6]
        cut = float(rng.choice(cut_choices))
        notes = [x for x in body if x[0] >= cut - 1e-6]
        info["cut_at_q"] = cut
    else:
        raise ValueError(start_mode)
    return notes, info


def finish_notes(rng, notes, meter: str, style: str, n_bars: int, bpm: float, pause: str | None) -> tuple[list[Note], dict]:
    bar_q, beat_q = METERS[meter]
    info: dict = {}
    if pause and len(notes) > 8:
        if pause == "bar" and n_bars >= 4:
            b = int(rng.integers(1, n_bars - 1))
            lo, hi = b * bar_q, (b + 1) * bar_q
        else:
            k = int(rng.integers(int(bar_q / beat_q), int(n_bars * bar_q / beat_q) - 1))
            lo, hi = k * beat_q, (k + 1) * beat_q
        kept = [x for x in notes if not (lo - 1e-6 <= x[0] < hi)]
        kept = [(a, min(b, lo) if a < lo else b, m) for a, b, m in kept]
        if len(kept) >= 6:
            notes = kept
            info["pause"] = {"kind": pause, "from_q": lo, "to_q": hi}
    if style == "swung" and meter != "6/8":
        amt = float(rng.uniform(0.06, 0.17))
        notes = [(music.swing_position(a, amt), music.swing_position(b, amt), m) for a, b, m in notes]
        info["swing_q"] = amt
    if style == "syncopated":
        prob = float(rng.uniform(0.2, 0.5))
        notes = music.apply_syncopation(rng, notes, beat_q, prob)
        info["anticipation_probability"] = prob
    notes = sorted(notes)
    out: list[Note] = []
    min_q = 0.07 / (60.0 / bpm / beat_q)
    for i, (a, b, m) in enumerate(notes):
        nxt = notes[i + 1][0] if i + 1 < len(notes) else math.inf
        b = min(b, nxt, n_bars * bar_q)
        if b - a < min_q:
            continue
        out.append(Note(a, b, int(m)))
    music.mark_phrase_ends(out, beat_q)
    return out, info


# --------------------------------------------------------------------------------------------------------
# Lead sound
# --------------------------------------------------------------------------------------------------------

def choose_lead(rng, split: str, bank: SoundBank) -> dict:
    unseen = split == "test-unseen"
    lib = [s for s in bank.sounds.values() if s["held_out"] == unseen and s["median_attack_ms"] <= MAX_ATTACK_MS and s["group"] != "vocal_sample"]
    r = rng.random()
    if unseen:
        kinds = [("voice", 0.40), ("breathy", 0.15), ("library", 0.45)]
    else:
        kinds = [("voice", 0.45), ("vocal_sample", 0.05), ("breathy", 0.12), ("library", 0.38)]
    acc = 0.0
    for kind, p in kinds:
        acc += p
        if r < acc:
            break
    if kind == "voice":
        vt = str(rng.choice(list(VOICE_TYPES)))
        vowel = str(rng.choice(UNSEEN_VOWELS if unseen else TRAIN_VOWELS))
        return {"kind": "voice", "voice_type": vt, "vowel": vowel, "timbre": f"voice-{vowel}", "group": "voice", "median_midi": VOICE_TYPES[vt][0]}
    if kind == "vocal_sample":
        s = next(x for x in bank.sounds.values() if x["group"] == "vocal_sample")
        lo, hi = bank.sounding_range(s["sound_id"])
        return {"kind": "sampler", "sound_id": s["sound_id"], "timbre": f"lib-{s['low_level']}", "group": "vocal_sample", "range": [lo, hi]}
    if kind == "breathy":
        b = "ocarina" if unseen else str(rng.choice(["flute", "whistle"]))
        return {"kind": "breathy", "instrument": b, "timbre": f"breathy-{b}", "group": "breathy", "median_midi": BREATHY_MEDIAN[b]}
    groups = sorted({s["group"] for s in lib})
    g = str(rng.choice(groups))
    cands = [s for s in lib if s["group"] == g]
    s = cands[int(rng.integers(len(cands)))]
    lo, hi = bank.sounding_range(s["sound_id"])
    return {"kind": "sampler", "sound_id": s["sound_id"], "timbre": f"lib-{s['low_level']}", "group": g, "low_level": s["low_level"], "preset": s["preset"], "range": [lo, hi]}


def transpose_for(rng, notes: list[Note], lead: dict) -> int:
    mids = np.array([n.midi for n in notes])
    med = float(np.median(mids))
    if "median_midi" in lead:
        target = lead["median_midi"] + rng.uniform(-3, 3)
        shift = int(round(target - med))
    else:
        lo, hi = lead["range"]
        span_lo, span_hi = lo - mids.min(), hi - mids.max()
        if span_lo > span_hi:
            # melody wider than the instrument: fold the outliers by octaves after centring
            shift = int(round((lo + hi) / 2 - med))
        else:
            centre = {"bass": 0.6}.get(lead["group"], 0.5)
            shift = int(round(span_lo + centre * (span_hi - span_lo) + rng.uniform(-2, 2)))
            shift = int(np.clip(shift, span_lo, span_hi))
    for n in notes:
        n.midi += shift
        if "range" in lead:
            lo, hi = lead["range"]
            while n.midi < lo:
                n.midi += 12
            while n.midi > hi:
                n.midi -= 12
    return shift


# --------------------------------------------------------------------------------------------------------
# Clip
# --------------------------------------------------------------------------------------------------------

def pick(rng, options, p=None):
    return options[int(rng.choice(len(options), p=p))]


def make_clip(row: dict, bank: SoundBank, out_dir: Path, melody_only: bool = False) -> dict:
    rng = np.random.default_rng(row["seed"])
    meter = pick(rng, ["3/4", "4/4", "6/8"])
    bar_q, beat_q = METERS[meter]
    n_bars = pick(rng, [2, 4, 8])
    bpm = float(rng.uniform(60, 200))
    style = pick(rng, ["straight", "syncopated"] if meter == "6/8" else ["straight", "swung", "syncopated"])
    timing = pick(rng, ["perfect", "humanised", "irregular"], [0.25, 0.45, 0.30])
    if meter == "6/8" and n_bars == 2:  # only 4 beats long: a mid-bar start would leave too little to label
        start_mode = pick(rng, ["downbeat", "pickup"], [0.43, 0.57])
    else:
        start_mode = pick(rng, ["downbeat", "pickup", "midbar"], [0.3, 0.4, 0.3])
    pause = pick(rng, [None, "beat", "bar"], [0.65, 0.2, 0.15])
    amounts = {"tempo": float(rng.uniform(0, 1)), "precision": float(rng.uniform(0, 1)), "pitch": float(rng.uniform(0, 1))}
    pollution = pick(rng, POLLUTION_LEVELS, POLLUTION_P)
    lead = choose_lead(rng, row["split"], bank)

    drawn_bars = n_bars
    found = False
    while not found:
        for attempt in range(20):
            raw, minfo = clip_melody(rng, row, meter, n_bars, style, bpm, start_mode)
            notes, finfo = finish_notes(rng, raw, meter, style, n_bars, bpm, pause)
            if len(notes) >= 4:
                span_beats = math.floor((min(max(n.q_off for n in notes), n_bars * bar_q) - 1e-6) / beat_q) - math.ceil((min(n.q_on for n in notes) - 1e-6) / beat_q) + 1
                if span_beats >= 3:
                    found = True
                    break
        if not found:
            if n_bars == 8:
                raise ValueError(f"{row['clip_id']}: no melody with at least 4 notes over at least 3 beats, even at 8 bars")
            # a sparse melody (often a precedent re-timed to 3/4): no window this short has enough notes
            n_bars = {2: 4, 4: 8}[n_bars]
    if n_bars != drawn_bars:
        minfo["n_bars_raised_from"] = drawn_bars
    if melody_only:  # dry run of the melody stage (used to check a whole plan quickly)
        return {"clip_id": row["clip_id"], "n_notes": len(notes), "n_bars": n_bars, "drawn_bars": drawn_bars}
    shift = transpose_for(rng, notes, lead)
    score = Score(meter, n_bars, notes, {"source": row["source"], "family": row["family"], **minfo, **finfo})

    q_lo = math.floor((min(n.q_on for n in notes) - 3 * bar_q) * 48) / 48  # grid on 1/48 q: exact MIDI ticks
    q_hi = n_bars * bar_q + 3 * bar_q
    tmap, tparams = music.build_tempo_map(rng, score, bpm, timing, q_lo, q_hi, amounts)
    voice_like = lead["kind"] in ("voice", "breathy") or lead["group"] in ("vocal_sample", "strings_brass")
    last_held = timing != "perfect" and rng.random() < 0.35
    perf, pparams = music.perform(rng, score, tmap, timing, amounts, last_held, voice_like)

    # clip time base: silence (and later noise) before the first and after the last sound
    lead_in = float(rng.uniform(0.1, 1.5))
    tail = float(rng.uniform(0.3, 1.5))
    sounding = [p for p in perf if p["velocity"] > 0]
    # snap the clip start to the 1/8-quarter grid so the MIDI file can open with an exact partial measure
    anchor = min(sounding[0]["onset"], min(p["nominal_onset"] for p in perf))
    q_start = math.floor(float(tmap.position(anchor - lead_in)) * 8) / 8
    t0 = float(tmap.time(q_start))
    lead_in = sounding[0]["onset"] - t0
    for p in perf:
        for k in ("nominal_onset", "nominal_offset", "onset", "offset"):
            p[k] -= t0
    dur = max(p["offset"] for p in sounding) + 0.3 + tail
    n_samples = int(dur * SR)

    pa = pitch_amounts(rng, amounts["pitch"])
    expressive = lead["kind"] in ("voice", "breathy") or lead["group"] == "vocal_sample"
    cents, voiced, pfacts = pitch_curve(rng, perf, dur, pa, expressive)
    if lead["kind"] == "sampler":
        audio, sinfo, stored = render_sampler(rng, bank, lead["sound_id"], perf, cents, n_samples)
    else:
        attack = float(rng.uniform(0.015, 0.12))
        release = float(rng.uniform(0.03, 0.12))
        env = loudness_curve(perf, dur, attack, release, legato_dip=float(rng.uniform(0, 0.5)))
        env_s = to_audio_rate(env, n_samples)
        # keep the oscillator pitch defined through releases: hold the last pitch after each note
        # keep the oscillator pitch defined between notes (silent there): the first half of a gap holds the
        # previous note's pitch, the second half already the next note's, so soft attacks start on pitch
        held = cents.copy()
        idx = np.flatnonzero(~np.isnan(held))
        if len(idx) == 0:
            raise ValueError(f"{row['clip_id']}: empty pitch curve")
        prev_i = np.maximum.accumulate(np.where(~np.isnan(held), np.arange(len(held)), -1))
        nxt = np.where(~np.isnan(held), np.arange(len(held)), len(held))
        next_i = np.minimum.accumulate(nxt[::-1])[::-1]
        gap = np.isnan(held)
        use_next = gap & ((prev_i < 0) | ((next_i < len(held)) & (np.arange(len(held)) - prev_i > next_i - np.arange(len(held)))))
        use_prev = gap & ~use_next
        held[use_next] = held[next_i[use_next]]
        held[use_prev] = held[prev_i[use_prev]]
        cents_s = to_audio_rate(held, n_samples)
        voiced_s = env_s > 1e-4
        if lead["kind"] == "voice":
            audio, sinfo = render_voice(rng, cents_s, voiced_s, env_s, lead["vowel"], VOICE_TYPES[lead["voice_type"]][1], perf, dur, row["split"] == "test-unseen")
        else:
            audio, sinfo = render_breathy(rng, lead["instrument"], cents_s, voiced_s, env_s)
        sinfo.update(attack_s=attack, release_s=release)
        stored = cents
    audio = np.asarray(audio, dtype=np.float64)
    if not np.all(np.isfinite(audio)) or np.max(np.abs(audio)) < 1e-6:
        raise ValueError(f"{row['clip_id']}: rendered audio is silent or not finite")
    audio, fx = pollute(rng, audio, pollution)

    # ---- labels
    first_q = min(n.q_on for n in notes)
    last_q = max(n.q_off for n in notes)
    k0 = math.ceil((first_q - 1e-6) / beat_q)
    k1 = math.floor((min(last_q, n_bars * bar_q) - 1e-6) / beat_q)
    beat_q_pos = np.arange(k0, k1 + 1) * beat_q
    beat_t = tmap.time(beat_q_pos) - t0
    beat_num = (np.round((beat_q_pos % bar_q) / beat_q).astype(int) % int(round(bar_q / beat_q))) + 1
    keep = (beat_t >= 0) & (beat_t <= dur)
    beat_q_pos, beat_t, beat_num = beat_q_pos[keep], beat_t[keep], beat_num[keep]
    if len(beat_t) < 3:
        raise ValueError(f"{row['clip_id']}: fewer than 3 labelled beats")

    cid = row["clip_id"]
    out_dir.mkdir(parents=True, exist_ok=True)
    sf.write(out_dir / f"{cid}.wav", audio.astype(np.float32), SR, subtype="PCM_16")
    with open(out_dir / f"{cid}.beats", "w") as f:
        f.writelines(f"{t:.5f}\t{n}\n" for t, n in zip(beat_t, beat_num))
    hop = int(round(PITCH_HOP_S * CTRL))
    np.savez_compressed(out_dir / f"{cid}.pitch.npz", time_s=(np.arange(0, len(stored), hop) / CTRL).astype(np.float32),
                        cents=stored[::hop].astype(np.float32))
    write_midi(out_dir / f"{cid}.mid", perf, tmap, t0, meter, dur)

    note_rows = []
    for p, pf in zip(perf, pfacts):
        note_rows.append({
            "part": "lead",
            "midi": p["midi"], "q_on": round(p["q_on"], 5), "q_off": round(p["q_off"], 5),
            "bar": int(math.floor(p["q_on"] / bar_q)), "beat_in_bar": round((p["q_on"] % bar_q) / beat_q + 1, 4),
            "onset": round(p["nominal_onset"], 5), "offset": round(p["nominal_offset"], 5),
            "performed_onset": None if p["swallowed"] == "missing" else round(p["onset"], 5),
            "performed_offset": None if p["swallowed"] == "missing" else round(p["offset"], 5),
            "velocity": round(p["velocity"], 4), "articulation": p["articulation"], "swallowed": p["swallowed"],
            "phrase_end": p["phrase_end"], "pitch": pf,
        })
    beat_tempo = (60.0 / np.diff(beat_t)).round(3).tolist()
    meta = {
        "clip_id": cid, "split": row["split"], "family": row["family"], "seed": row["seed"],
        "sample_rate": SR, "duration_s": round(dur, 4),
        "meter": meter, "beats_per_bar": int(round(bar_q / beat_q)), "beat_unit": "dotted quarter" if meter == "6/8" else "quarter",
        "n_bars": n_bars, "bpm": bpm, "style": style, "timing": timing, "start_mode": start_mode,
        "amounts": amounts, "pollution": fx, "lead": lead, "transpose": shift,
        "lead_in_s": lead_in, "tail_s": tail, "last_note_held": last_held,
        "score": score.source, "tempo_params": tparams, "performance": pparams, "pitch_params": pa, "render": sinfo,
        "beats": [{"time": round(float(t), 5), "beat_in_bar": int(n), "q": float(q)} for t, n, q in zip(beat_t, beat_num, beat_q_pos)],
        "beat_tempo_bpm": beat_tempo,
        "tempo_map": {"q": tmap.q[::12].round(4).tolist(), "time_s": (tmap.t[::12] - t0).round(5).tolist(), "note": "score position (quarter notes from the first downbeat) -> clip time, every 1/4 quarter"},
        "notes": note_rows,
        "files": {"audio": f"{cid}.wav", "beats": f"{cid}.beats", "midi": f"{cid}.mid", "pitch": f"{cid}.pitch.npz"},
    }
    (out_dir / f"{cid}.json").write_text(json.dumps(meta, default=_json_default))
    return meta


def _json_default(o):
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return float(o)
    if isinstance(o, np.ndarray):
        return o.tolist()
    if isinstance(o, np.bool_):
        return bool(o)
    raise TypeError(f"not JSON serialisable: {type(o)}")


def write_midi(path: Path, perf: list[dict], tmap, t0: float, meter: str, dur: float) -> None:
    """The intended lead melody at its nominal score positions, with the clip's exact tempo map, so that MIDI
    time equals clip time. The clip starts on the 1/8-quarter grid, usually inside a bar: the file opens with a
    partial measure (k/32) and switches to the real meter at the first bar line."""
    ppq = 960
    bar_q = METERS[meter][0]
    q_ref = round(float(tmap.position(t0)) * 8) / 8  # score position at clip time 0 (on the 1/8 grid)
    q_end = float(tmap.position(t0 + dur))
    tick = lambda q: int(round((q - q_ref) * ppq))  # noqa: E731
    num, den = {"2/4": (2, 4), "3/4": (3, 4), "4/4": (4, 4), "6/8": (6, 8)}[meter]
    events = []
    first_bar = math.ceil(q_ref / bar_q - 1e-9) * bar_q
    partial = first_bar - q_ref
    if partial > 1e-9:
        events.append((0, 0, mido.MetaMessage("time_signature", numerator=int(round(partial * 8)), denominator=32, time=0)))
        events.append((tick(first_bar), 0, mido.MetaMessage("time_signature", numerator=num, denominator=den, time=0)))
    else:
        events.append((0, 0, mido.MetaMessage("time_signature", numerator=num, denominator=den, time=0)))
    i0 = int(np.searchsorted(tmap.q, q_ref - 1e-9))
    i1 = int(np.searchsorted(tmap.q, q_end))
    last_tempo = None
    for i in range(i0, min(i1, len(tmap.q) - 1)):
        us = int(round((tmap.t[i + 1] - tmap.t[i]) / (tmap.q[i + 1] - tmap.q[i]) * 1e6))
        if us != last_tempo:
            events.append((tick(tmap.q[i]), 1, mido.MetaMessage("set_tempo", tempo=us, time=0)))
            last_tempo = us
    for p in perf:
        vel = max(1, int(round(p["velocity"] * 127))) if p["swallowed"] != "missing" else 1
        events.append((tick(p["q_on"]), 3, mido.Message("note_on", note=int(p["midi"]), velocity=vel, time=0)))
        events.append((tick(p["q_off"]), 2, mido.Message("note_off", note=int(p["midi"]), velocity=0, time=0)))
    if min(e[0] for e in events) < 0:
        raise ValueError(f"{path.name}: a note starts before the clip (tick {min(e[0] for e in events)})")
    events.sort(key=lambda e: (e[0], e[1]))
    track = mido.MidiTrack()
    last = 0
    for t, _, msg in events:
        msg.time = t - last
        last = t
        track.append(msg)
    mf = mido.MidiFile(ticks_per_beat=ppq)
    mf.tracks.append(track)
    mf.save(path)
